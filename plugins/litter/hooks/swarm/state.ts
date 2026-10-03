// The swarm's live state (plan 15.4; COMMON, step 0): module memory with named
// getters and changers, mirrored to $.store per owned swarm. A data layer: it
// makes no decisions, which are the owners' (L admits, P stops and ends, K
// recovers, O rebinds).
//
//  - Changers are synchronous and never await, so a caller can check and
//    reserve in one step (15.4, "It reserves the place before it awaits
//    anything"). Each bumps `version()`.
//  - Every change to an owned swarm (not read-only, not lost) schedules a write
//    of that swarm's part to `$.store` under `litter.swarm.state.<litterDir>.<swarm>`.
//    Writes are serialised and coalesced: a burst of changes in one turn of
//    the event loop is one write, and changes made while a write runs are one
//    more. Read-only and lost swarms are another session's to write.
//  - Not mirrored, since they're this process's: reservations (a reload ends
//    the hook that held one), the lead's turn state, the gate, the rebind and
//    cleared flags, the clear's kills, the noted proposals, and run agents'
//    calls (they belong to no swarm).
//  - The objects the getters return are the state's own: read them, and
//    change them only through the changers.
//
// Contract owner: phase 2b-1, package C (built and tested here; tests/unit/state.spec.ts).

import type { Ports } from '../ports'
import type {
  ActiveScope,
  AdmissionStatus,
  ClearKill,
  LiveSwarm,
  NodeBinding,
  NodeReport,
  QueuedMessage,
  Question,
  Reservation,
  InflightCall,
  Shell,
  TokenCount,
  TurnUsage,
  WriteScope,
} from './types'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A report kept per agent, and a queued message's text: cut to these many UTF-8 bytes. */
export const REPORT_MAX_BYTES = 4 * 1024
export const QUEUED_MAX_BYTES = 16 * 1024
/** How long `ready` waits for the gate before it rejects. */
export const READY_MS = 15_000
/** `ready`'s poll step. */
export const READY_POLL_MS = 25
const QUESTIONS_KEPT = 100
const DIRECT_KEPT = 20
const REFUSED_KEPT = 16

/** Cut to at most `max` UTF-8 bytes, on a character boundary. */
function cutBytes(text: string, max: number): string {
  if (text.length * 3 <= max) return text
  let bytes = 0
  let end = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (bytes + n > max) break
    bytes += n
    end += ch.length
  }
  return text.slice(0, end)
}

/** One running or settling agent's place. */
type AdmissionEntry = { agentId: string; status: 'running' | 'settling'; scope: WriteScope | null }
/** A stopped node or child, by agentId. */
export type StoppedEntry = { agentId: string; swarm: string; reason: string }

/** One swarm's part in $.store. */
export type SwarmPart = {
  v: 1
  swarm: LiveSwarm
  bindings: NodeBinding[]
  admission: AdmissionEntry[]
  stopped: StoppedEntry[]
  queue: QueuedMessage[]
  /** Node id → the last instance number taken. */
  instances: Record<string, number>
  calls: InflightCall[]
  shells: Shell[]
  agentStopped: string[]
  reports: Record<string, NodeReport>
  tokens: Record<string, TokenCount>
  questions: Question[]
  direct: string[]
  refused: Record<string, string[]>
}

/** The $.store key of one swarm's part. */
export const swarmStateKey = (litterDir: string, swarm: string) => `litter.swarm.state.${litterDir}.${swarm}`

// ---------------------------------------------------------------------------
// The tables

const swarms = new Map<string, LiveSwarm>()
const bindingsById = new Map<string, NodeBinding>()
const reserved = new Map<string, Reservation>()
const admission = new Map<string, AdmissionEntry>()
const stoppedById = new Map<string, StoppedEntry>()
const queue = new Map<string, QueuedMessage>()
const instances = new Map<string, Map<string, number>>()
const calls = new Map<string, InflightCall>()
const shellsById = new Map<string, Shell>()
const stoppedAgents = new Set<string>()
const reports = new Map<string, NodeReport>()
const tokenCounts = new Map<string, TokenCount>()
let questionList: Question[] = []
const directBySwarm = new Map<string, string[]>()
const refused = new Map<string, string[]>()
let lead = false
let rebind: string | null = null
let cleared = false
let clearKills: ClearKill[] = []
let recorded: string | null = null
let gate = 0
let proposals: { name: string; n: number }[] = []
let ver = 0

const callKey = (agentId: string, toolUseId: string) => `${agentId}\u0000${toolUseId}`
const swarmOfAgent = (agentId: string): string | null => bindingsById.get(agentId)?.swarm ?? null

// ---------------------------------------------------------------------------
// The mirror

let ports: Ports | null = null
let mirrorDir: string | null = null
const dirty = new Set<string>()
/** Swarms dropped while owned: their key is deleted by the writer. */
const dropped = new Set<string>()
let scheduled = false
let writing: Promise<void> | null = null

/** A change: bumps the version, and schedules a write of `swarm`'s part when it's mirrored. */
function changed(swarm: string | null): void {
  ver++
  if (swarm === null) return
  dirty.add(swarm)
  schedule()
}

function schedule(): void {
  if (scheduled || !ports || !mirrorDir) return
  scheduled = true
  // After the current synchronous burst: one write for all of it. (A promise
  // job, since a hooks module has no queueMicrotask.)
  void Promise.resolve().then(() => {
    scheduled = false
    kick()
  })
}

function kick(): void {
  if (writing || !ports || !mirrorDir) return
  const p = ports
  const dir = mirrorDir
  writing = (async () => {
    while (dirty.size > 0) {
      const names = [...dirty]
      dirty.clear()
      for (const name of names) await writePart(p, dir, name)
    }
  })().finally(() => {
    writing = null
    if (dirty.size > 0) kick()
  })
}

const mirrored = (s: LiveSwarm | undefined): s is LiveSwarm => s !== undefined && !s.readOnly && !s.lost

async function writePart(p: Ports, dir: string, name: string): Promise<void> {
  try {
    const s = swarms.get(name)
    if (!s) {
      if (dropped.delete(name)) await p.store.delete(swarmStateKey(dir, name))
      return
    }
    if (!mirrored(s)) return
    await p.store.set(swarmStateKey(dir, name), partOf(name, s))
  } catch (err) {
    p.log(`swarm ${name}: its state wasn't saved: ${errText(err)}`)
  }
}

function partOf(name: string, s: LiveSwarm): SwarmPart {
  const bs = [...bindingsById.values()].filter(b => b.swarm === name)
  const ids = new Set(bs.map(b => b.agentId))
  const byAgent = <V>(m: Map<string, V>): Record<string, V> => Object.fromEntries([...m].filter(([id]) => ids.has(id)))
  return {
    v: 1,
    swarm: s,
    bindings: bs,
    admission: [...admission.values()].filter(a => ids.has(a.agentId)),
    stopped: [...stoppedById.values()].filter(x => x.swarm === name),
    queue: [...queue.values()].filter(q => q.swarm === name),
    instances: Object.fromEntries(instances.get(name) ?? []),
    calls: [...calls.values()].filter(c => c.swarm === name),
    shells: [...shellsById.values()].filter(x => x.swarm === name),
    agentStopped: [...stoppedAgents].filter(id => ids.has(id)),
    reports: byAgent(reports),
    tokens: byAgent(tokenCounts),
    questions: questionList.filter(q => q.swarm === name),
    direct: [...(directBySwarm.get(name) ?? [])],
    refused: byAgent(refused),
  }
}

/**
 * Gives the state the ports it mirrors through, and the litter directory its
 * keys carry: at session.start, and again at a rebind. Changes made before it
 * are written now.
 */
export function attach(p: Ports, litterDir: string): void {
  ports = p
  mirrorDir = litterDir
  for (const [name, s] of swarms) if (mirrored(s)) dirty.add(name)
  if (dirty.size > 0) schedule()
}

/** Resolves once every scheduled write is done (tests, and session.end). */
export async function flushed(): Promise<void> {
  while (ports && mirrorDir && (scheduled || writing || dirty.size > 0)) {
    if (writing) await writing.catch(() => undefined)
    else if (scheduled) await Promise.resolve()
    else kick()
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Reads one swarm's part back from $.store into memory, over anything held
 * for it, and answers its LiveSwarm (null when there's none, or it isn't
 * readable). K's recovery calls it, then rebuilds over it from the ledger.
 * It writes nothing.
 */
export async function loadSwarm(p: Ports, litterDir: string, name: string): Promise<LiveSwarm | null> {
  const raw = await p.store.get(swarmStateKey(litterDir, name))
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.swarm) || raw.swarm.name !== name) return null
  const part = raw as unknown as SwarmPart
  forget(name)
  swarms.set(name, part.swarm)
  for (const b of part.bindings ?? []) bindingsById.set(b.agentId, b)
  for (const a of part.admission ?? []) admission.set(a.agentId, a)
  for (const x of part.stopped ?? []) stoppedById.set(x.agentId, x)
  for (const q of part.queue ?? []) queue.set(q.id, q)
  instances.set(name, new Map(Object.entries(part.instances ?? {})))
  for (const c of part.calls ?? []) calls.set(callKey(c.agentId, c.toolUseId), c)
  for (const sh of part.shells ?? []) shellsById.set(sh.shellId, sh)
  for (const id of part.agentStopped ?? []) stoppedAgents.add(id)
  for (const [id, r] of Object.entries(part.reports ?? {})) reports.set(id, r)
  for (const [id, t] of Object.entries(part.tokens ?? {})) tokenCounts.set(id, t)
  questionList = [...questionList, ...(part.questions ?? [])]
  directBySwarm.set(name, [...(part.direct ?? [])])
  for (const [id, turns] of Object.entries(part.refused ?? {})) refused.set(id, [...turns])
  ver++
  return part.swarm
}

/** Drops everything held for one swarm, in memory only. */
function forget(name: string): void {
  const ids = new Set([...bindingsById.values()].filter(b => b.swarm === name).map(b => b.agentId))
  swarms.delete(name)
  for (const id of ids) {
    bindingsById.delete(id)
    admission.delete(id)
    stoppedAgents.delete(id)
    reports.delete(id)
    tokenCounts.delete(id)
    refused.delete(id)
  }
  for (const [k, r] of reserved) if (r.swarm === name) reserved.delete(k)
  for (const [k, x] of stoppedById) if (x.swarm === name) stoppedById.delete(k)
  for (const [k, q] of queue) if (q.swarm === name) queue.delete(k)
  for (const [k, c] of calls) if (c.swarm === name || ids.has(c.agentId)) calls.delete(k)
  for (const [k, sh] of shellsById) if (sh.swarm === name || ids.has(sh.agentId)) shellsById.delete(k)
  instances.delete(name)
  questionList = questionList.filter(q => q.swarm !== name)
  directBySwarm.delete(name)
}

// ---------------------------------------------------------------------------
// Live swarms

export const liveSwarms = (): LiveSwarm[] => [...swarms.values()]
export const liveSwarm = (name: string): LiveSwarm | null => swarms.get(name) ?? null

/** Puts a swarm (Launch, recovery, a read-only one another session owns). */
export function putLiveSwarm(s: LiveSwarm): void {
  swarms.set(s.name, { ...s })
  dropped.delete(s.name)
  changed(s.name)
}

/** Changes some of a live swarm's fields (not its name). Null when it isn't live. */
export function patchLiveSwarm(name: string, patch: Partial<LiveSwarm>): LiveSwarm | null {
  const cur = swarms.get(name)
  if (!cur) return null
  const next: LiveSwarm = { ...cur, ...patch, name }
  swarms.set(name, next)
  changed(name)
  return next
}

/** The swarm ended: everything held for it goes, and so does its key in $.store when this session owned it. */
export function dropLiveSwarm(name: string): void {
  const s = swarms.get(name)
  if (!s) return
  if (mirrored(s)) dropped.add(name)
  forget(name)
  changed(name)
}

/**
 * The live swarm and node a type belongs to, with or without its `litter:`
 * prefix, from the swarms' type tables, read-only and lost ones included
 * (callers check). Never by splitting the name: `sw-a-b-c` is ambiguous.
 */
export function swarmOfType(type: string): { swarm: string; node: string } | null {
  const served = type.startsWith('litter:') ? type : `litter:${type}`
  for (const s of swarms.values()) {
    for (const [node, t] of Object.entries(s.types)) if (t === served) return { swarm: s.name, node }
  }
  return null
}

// ---------------------------------------------------------------------------
// Bindings

export const binding = (agentId: string): NodeBinding | null => bindingsById.get(agentId) ?? null
export const bindings = (swarm?: string): NodeBinding[] =>
  [...bindingsById.values()].filter(b => swarm === undefined || b.swarm === swarm)

export function putBinding(b: NodeBinding): void {
  bindingsById.set(b.agentId, { ...b })
  changed(b.swarm)
}

export function dropBinding(agentId: string): void {
  const b = bindingsById.get(agentId)
  if (!b) return
  bindingsById.delete(agentId)
  changed(b.swarm)
}

/** The bindings whose `parent` is this agent: its workers and children. */
export const childrenOf = (agentId: string): NodeBinding[] => [...bindingsById.values()].filter(b => b.parent === agentId)

/** Every binding below this agent, by `parent`, children of children included; not the agent itself. */
export function descendantsOf(agentId: string): NodeBinding[] {
  const out: NodeBinding[] = []
  const seen = new Set([agentId])
  const todo = [agentId]
  while (todo.length > 0) {
    const id = todo.shift()!
    for (const b of childrenOf(id)) {
      if (seen.has(b.agentId)) continue
      seen.add(b.agentId)
      out.push(b)
      todo.push(b.agentId)
    }
  }
  return out
}

export const bindingByToken = (swarm: string, token: string): NodeBinding | null =>
  [...bindingsById.values()].find(b => b.swarm === swarm && b.token !== null && b.token === token) ?? null

// ---------------------------------------------------------------------------
// Admission: running, settling and reserved places

/** Takes a place. A key already held is a bug in the caller, so it throws. */
export function reserve(r: Reservation): void {
  if (reserved.has(r.key)) throw new Error(`litter: the reservation ${r.key} is already held`)
  reserved.set(r.key, { ...r })
  ver++
}

/** The reserved place becomes `agentId`'s running place, with the reservation's scope. False when nothing was reserved under `key`. */
export function promote(key: string, agentId: string): boolean {
  const r = reserved.get(key)
  if (!r) return false
  reserved.delete(key)
  admission.set(agentId, { agentId, status: 'running', scope: r.scope })
  changed(swarmOfAgent(agentId) ?? r.swarm)
  return true
}

/** Frees a reserved place (a denial, a throw, a failure after it). False when nothing was reserved. */
export function release(key: string): boolean {
  if (!reserved.delete(key)) return false
  ver++
  return true
}

export const reservations = (swarm?: string): Reservation[] =>
  [...reserved.values()].filter(r => swarm === undefined || r.swarm === swarm)

export const status = (agentId: string): AdmissionStatus => admission.get(agentId)?.status ?? 'idle'

/** Running (a spawn bound, a resume admitted). Clears a stop noted earlier: the agent runs again. The scope stays unless given. */
export function markRunning(agentId: string, scope?: WriteScope | null): void {
  const cur = admission.get(agentId)
  admission.set(agentId, { agentId, status: 'running', scope: scope !== undefined ? scope : (cur?.scope ?? null) })
  stoppedAgents.delete(agentId)
  changed(swarmOfAgent(agentId))
}

/** Settling: from its turn.complete until the list stops showing it running. It keeps its place. */
export function markSettling(agentId: string): void {
  const cur = admission.get(agentId)
  admission.set(agentId, { agentId, status: 'settling', scope: cur?.scope ?? null })
  changed(swarmOfAgent(agentId))
}

/** Settled: its place is free. */
export function markSettled(agentId: string): void {
  if (!admission.delete(agentId)) return
  changed(swarmOfAgent(agentId))
}

/** The places an agent and its swarm's reservations hold, each agent once. */
function places(swarm: string): { node: string; parent: string | null; kind: NodeBinding['kind']; scope: WriteScope | null; agentId: string | null; key: string | null }[] {
  const out: ReturnType<typeof places> = []
  const counted = new Set<string>()
  for (const a of admission.values()) {
    const b = bindingsById.get(a.agentId)
    if (!b || b.swarm !== swarm) continue
    counted.add(a.agentId)
    out.push({ node: b.node, parent: b.parent, kind: b.kind, scope: a.scope, agentId: a.agentId, key: null })
  }
  for (const r of reserved.values()) {
    if (r.swarm !== swarm || (r.agentId !== undefined && counted.has(r.agentId))) continue
    out.push({ node: r.node, parent: r.parent, kind: r.kind, scope: r.scope, agentId: null, key: r.key })
  }
  return out
}

/** Running, settling and reserved instances of `node` under `parent` (null: the lead). Children don't count. */
export const countFor = (swarm: string, parent: string | null, node: string): number =>
  places(swarm).filter(x => x.kind !== 'child' && x.node === node && x.parent === parent).length

/** Running, settling and reserved agents of the swarm, children included (`maxAgentsAtOnce`). */
export const countSwarm = (swarm: string): number => places(swarm).length

/** Each running, settling or reserved writing instance's scope. */
export const activeScopes = (swarm: string): ActiveScope[] =>
  places(swarm)
    .filter((x): x is typeof x & { scope: WriteScope } => x.scope !== null)
    .map(x => ({ ...x.scope, swarm, node: x.node, agentId: x.agentId, key: x.key }))

/** The next instance number of `node`, from 1 over the swarm's life, taken now. */
export function nextInstance(swarm: string, node: string): number {
  const m = instances.get(swarm) ?? new Map<string, number>()
  instances.set(swarm, m)
  const n = (m.get(node) ?? 0) + 1
  m.set(node, n)
  changed(swarm)
  return n
}

/** Raises the counter to at least `n` (recovery, from the ledger's swarm.instance records). */
export function noteInstance(swarm: string, node: string, n: number): void {
  const m = instances.get(swarm) ?? new Map<string, number>()
  instances.set(swarm, m)
  if ((m.get(node) ?? 0) >= n) return
  m.set(node, n)
  changed(swarm)
}

// ---------------------------------------------------------------------------
// The stopped list (15.4: TaskStop leaves an agent resumable, so the status can't tell)

export function stop(swarm: string, agentIds: readonly string[], reason: string): void {
  for (const agentId of agentIds) stoppedById.set(agentId, { agentId, swarm, reason })
  changed(swarm)
}

export const isStopped = (agentId: string): boolean => stoppedById.has(agentId)
export const stopped = (swarm: string): StoppedEntry[] => [...stoppedById.values()].filter(x => x.swarm === swarm)

// ---------------------------------------------------------------------------
// The queue (15.4, "Messages from you")

/** Queues a message, assigning its id; its text is cut to 16 KiB. */
export function enqueue(msg: Omit<QueuedMessage, 'id'>): QueuedMessage {
  let id = ''
  do id = `q${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`
  while (queue.has(id))
  const m: QueuedMessage = { ...msg, id, text: cutBytes(msg.text, QUEUED_MAX_BYTES) }
  queue.set(id, m)
  changed(m.swarm)
  return m
}

/** Queued messages, oldest first, of a swarm, and of one agent. */
export const queued = (swarm?: string, agentId?: string): QueuedMessage[] =>
  [...queue.values()].filter(q => (swarm === undefined || q.swarm === swarm) && (agentId === undefined || q.agentId === agentId))

/** Takes a message off the queue to send it. Null when it isn't queued. */
export function dequeue(id: string): QueuedMessage | null {
  const m = queue.get(id)
  if (!m) return null
  queue.delete(id)
  changed(m.swarm)
  return m
}

/** Cancels a queued message ([Cancel]). Null when it isn't queued. */
export function cancelQueued(id: string): QueuedMessage | null {
  return dequeue(id)
}

// ---------------------------------------------------------------------------
// In flight: tool calls and background shells (nodes, their children, run agents)

export function callStart(agentId: string, toolUseId: string, tool: string, at: number): void {
  const swarm = swarmOfAgent(agentId)
  calls.set(callKey(agentId, toolUseId), { agentId, toolUseId, tool, at, swarm })
  changed(swarm)
}

/** Closes one call. False when it wasn't open. */
export function callEnd(agentId: string, toolUseId: string): boolean {
  const c = calls.get(callKey(agentId, toolUseId))
  if (!c) return false
  calls.delete(callKey(agentId, toolUseId))
  changed(c.swarm)
  return true
}

/** Closes every call the agent left open (its SubagentStop, an aborted turn); answers them. */
export function closeCalls(agentId: string): InflightCall[] {
  const closed = [...calls.values()].filter(c => c.agentId === agentId)
  for (const c of closed) calls.delete(callKey(c.agentId, c.toolUseId))
  if (closed.length > 0) changed(closed[0]!.swarm)
  return closed
}

export const inflight = (): InflightCall[] => [...calls.values()]

export function shellStarted(agentId: string, shellId: string, at: number): void {
  const swarm = swarmOfAgent(agentId)
  shellsById.set(shellId, { shellId, agentId, swarm, at })
  changed(swarm)
}

/** The shell is confirmed stopped. False when it wasn't recorded. */
export function shellStopped(shellId: string): boolean {
  const sh = shellsById.get(shellId)
  if (!sh) return false
  shellsById.delete(shellId)
  changed(sh.swarm)
  return true
}

export const shells = (swarm?: string): Shell[] => [...shellsById.values()].filter(s => swarm === undefined || s.swarm === swarm)

/** Its SubagentStop came (the settle wait counts it); cleared when it runs again. */
export function noteAgentStopped(agentId: string): void {
  stoppedAgents.add(agentId)
  changed(swarmOfAgent(agentId))
}

export const agentStopped = (agentId: string): boolean => stoppedAgents.has(agentId)

// ---------------------------------------------------------------------------
// Reports and the lead's view

/** A node's last report, cut to 4 KiB. */
export function noteReport(agentId: string, text: string, via: NodeReport['via'], at: number): void {
  reports.set(agentId, { text: cutBytes(text, REPORT_MAX_BYTES), via, at })
  changed(swarmOfAgent(agentId))
}

export const lastReport = (agentId: string): NodeReport | null => reports.get(agentId) ?? null

const ZERO: TokenCount = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, turns: 0 }

/** One turn's usage (turn.complete's `e.usage`; none for an interrupted turn, which still counts as a turn). */
export function addTokens(agentId: string, usage: TurnUsage | null | undefined): void {
  const t = tokenCounts.get(agentId) ?? { ...ZERO }
  tokenCounts.set(agentId, {
    input: t.input + (usage?.input_tokens ?? 0),
    output: t.output + (usage?.output_tokens ?? 0),
    cacheRead: t.cacheRead + (usage?.cache_read_input_tokens ?? 0),
    cacheCreation: t.cacheCreation + (usage?.cache_creation_input_tokens ?? 0),
    turns: t.turns + 1,
  })
  changed(swarmOfAgent(agentId))
}

/** One agent's tokens, or a live swarm's summed over its bindings (a live swarm's name is tried first). */
export function tokens(agentIdOrSwarm: string): TokenCount {
  if (!swarms.has(agentIdOrSwarm)) return { ...(tokenCounts.get(agentIdOrSwarm) ?? ZERO) }
  const sum = { ...ZERO }
  for (const b of bindings(agentIdOrSwarm)) {
    const t = tokenCounts.get(b.agentId)
    if (!t) continue
    sum.input += t.input
    sum.output += t.output
    sum.cacheRead += t.cacheRead
    sum.cacheCreation += t.cacheCreation
    sum.turns += t.turns
  }
  return sum
}

/** A bound agent's question, open until closeQuestion. Null for an agent no binding knows. */
export function noteQuestion(agentId: string, text: string, at: number): Question | null {
  const b = bindingsById.get(agentId)
  if (!b) return null
  const q: Question = { swarm: b.swarm, agentId, node: b.node, text, at, closedAt: null }
  questionList.push(q)
  // Bounded per swarm: the oldest closed ones go first, then the oldest.
  const mine = questionList.filter(x => x.swarm === b.swarm)
  if (mine.length > QUESTIONS_KEPT) {
    const drop = mine.find(x => x.closedAt !== null) ?? mine[0]!
    questionList = questionList.filter(x => x !== drop)
  }
  changed(b.swarm)
  return q
}

/** Closes the agent's open questions; answers how many. */
export function closeQuestion(agentId: string, at: number): number {
  let n = 0
  questionList = questionList.map(q => (q.agentId === agentId && q.closedAt === null ? (n++, { ...q, closedAt: at }) : q))
  if (n > 0) changed(swarmOfAgent(agentId))
  return n
}

export const openQuestions = (swarm: string): Question[] => questionList.filter(q => q.swarm === swarm && q.closedAt === null)
/** Every question kept for the swarm, open and closed, oldest first. */
export const questions = (swarm: string): Question[] => questionList.filter(q => q.swarm === swarm)

/** Something you sent a node directly, for the lead's next `<swarm>` block. */
export function noteDirect(swarm: string, text: string): void {
  const list = [...(directBySwarm.get(swarm) ?? []), text].slice(-DIRECT_KEPT)
  directBySwarm.set(swarm, list)
  changed(swarm)
}

/** The direct messages since the last block, taken: each is listed once. */
export function takeDirect(swarm: string): string[] {
  const list = directBySwarm.get(swarm) ?? []
  if (list.length === 0) return []
  directBySwarm.set(swarm, [])
  changed(swarm)
  return list
}

// ---------------------------------------------------------------------------
// Turns

/** A node turn admission refused: every later step of it is refused too (15.9, item 15). */
export function refuseTurn(agentId: string, turnId: string): void {
  const list = refused.get(agentId) ?? []
  if (!list.includes(turnId)) refused.set(agentId, [...list, turnId].slice(-REFUSED_KEPT))
  changed(swarmOfAgent(agentId))
}

export const isRefusedTurn = (agentId: string, turnId: string): boolean => refused.get(agentId)?.includes(turnId) ?? false

/** The lead's turn: busy from a main-loop turn.start to its turn.complete (L). */
export function setLeadBusy(busy: boolean): void {
  if (lead === busy) return
  lead = busy
  ver++
}

export const leadBusy = (): boolean => lead

// ---------------------------------------------------------------------------
// The clear (O; 15.4, "After /clear")

export function setRebindPending(oldSession: string): void {
  rebind = oldSession
  ver++
}

/** The session id the clear left, while a rebind is pending. */
export const rebindPending = (): string | null => rebind

export function clearRebind(): void {
  rebind = null
  ver++
}

/** The next `<swarm>` block opens with the cleared lines. */
export function markCleared(): void {
  cleared = true
  ver++
}

export function takeCleared(): boolean {
  const was = cleared
  cleared = false
  if (was) ver++
  return was
}

export function noteClearKills(list: readonly ClearKill[]): void {
  clearKills = [...clearKills, ...list]
  ver++
}

export function takeClearKills(): ClearKill[] {
  const list = clearKills
  clearKills = []
  if (list.length > 0) ver++
  return list
}

/** The session id the state last saw, for O's tick (a clear whose session.end never reached the mod). */
export const recordedSession = (): string | null => recorded

export function setRecordedSession(id: string): void {
  recorded = id
  ver++
}

// ---------------------------------------------------------------------------
// The gate (15.4, "Recreating a swarm"): closed while recovery or a rebind
// re-registers types, so sends and node turns wait.

export function closeGate(): void {
  gate++
  ver++
}

export function openGate(): void {
  gate = Math.max(0, gate - 1)
  ver++
}

/**
 * Resolves at once while the gate is open; otherwise polls with
 * `p.sleep(25)`, and rejects after 15 s, so a hook that waits fails closed
 * through its catch. The gate starts open: a fresh module has nothing live,
 * and tier 1 fires hooks without session.start. Note that `$.clock.sleep`
 * spends the waiting hook's 10 s budget (ports.ts): a hook overruns before
 * the 15 s, and its catch refuses, which is the same answer.
 */
export async function ready(p: Ports): Promise<void> {
  if (gate === 0) return
  const deadline = (await p.now()) + READY_MS
  for (;;) {
    await p.sleep(READY_POLL_MS)
    if (gate === 0) return
    if ((await p.now()) >= deadline) throw new Error("litter: the swarm state isn't ready")
  }
}

// ---------------------------------------------------------------------------
// The rest

/** J staged a proposal: N's pane timer picks it up. */
export function noteProposal(name: string, n: number): void {
  proposals.push({ name, n })
  ver++
}

export function takeProposals(): { name: string; n: number }[] {
  const list = proposals
  proposals = []
  if (list.length > 0) ver++
  return list
}

/** Bumped by every change: N redraws when it moved. */
export const version = (): number => ver

/** A fresh module's state, for tests: nothing live, the gate open, nothing attached. */
export function resetForTests(): void {
  swarms.clear()
  bindingsById.clear()
  reserved.clear()
  admission.clear()
  stoppedById.clear()
  queue.clear()
  instances.clear()
  calls.clear()
  shellsById.clear()
  stoppedAgents.clear()
  reports.clear()
  tokenCounts.clear()
  questionList = []
  directBySwarm.clear()
  refused.clear()
  lead = false
  rebind = null
  cleared = false
  clearKills = []
  recorded = null
  gate = 0
  proposals = []
  ver = 0
  ports = null
  mirrorDir = null
  dirty.clear()
  dropped.clear()
  scheduled = false
  writing = null
}
