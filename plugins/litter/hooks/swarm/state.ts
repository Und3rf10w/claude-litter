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
//    cleared flags, the clear's kills, the noted proposals, run agents'
//    calls (they belong to no swarm), and whether the session is interactive.
//  - The objects the getters return are the state's own: read them, and
//    change them only through the changers.
//  - Bounded, since $.store is 4 MiB for the whole plugin and a full store
//    breaks every ledger append (ledgercore's head write): texts are cut, the
//    queue is capped, an agent's entries go with its binding, and a part over
//    256 KiB sheds old reports and closed questions before it's written.
//
// Contract owner: phase 2b-1, package C (built and tested here; tests/unit/state.spec.ts);
// the repair budget's counters and the interactive flag are 2b-2's (package V).

import type { Ports } from '../ports'
import type {
  ActiveScope,
  AdmissionStatus,
  BindingKind,
  ClearKill,
  ClearReason,
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
/** A question's text, and a direct message's: cut to these many UTF-8 bytes. */
export const NOTE_MAX_BYTES = 4 * 1024
/** Queued messages held per swarm: `enqueue` throws past it. */
export const QUEUE_MAX = 50
/** A swarm's part in $.store, as JSON: over it, old reports and closed questions are dropped before the write. */
export const PART_MAX_BYTES = 256 * 1024
/**
 * How long `ready` waits for the gate before it rejects: under the hook's
 * 10 s budget, which a `$.clock` wait spends, so the hook ends with ready's
 * own error rather than the budget's.
 */
export const READY_MS = 8_000
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

/** UTF-8 bytes of a JSON-serialisable value. */
function jsonBytes(v: unknown): number {
  const text = JSON.stringify(v) ?? ''
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** Where a place counts: its swarm, node, parent (null: the lead) and kind. */
export type AdmissionPlace = { swarm: string; node: string; parent: string | null; kind: BindingKind }

/**
 * One running, settling or parked agent's place. It carries what it counts
 * under, copied from its reservation by `promote` (or from the binding, or
 * given, by `markRunning`), so it counts before its binding is put. `parked`
 * (WP-AJ): its turn ended while the list shows it `waiting` on its own agents
 * or background work. It's alive, so it keeps its place, but `status` reads
 * it `idle`: a message or a wake resumes it, through admission.
 */
type AdmissionEntry = AdmissionPlace & { agentId: string; status: 'running' | 'settling' | 'parked'; scope: WriteScope | null }

const placeOf = (x: AdmissionPlace): AdmissionPlace => ({ swarm: x.swarm, node: x.node, parent: x.parent, kind: x.kind })
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
  /** 2b-2: the spawns counted against a repair swarm's agents, by reservation key. Absent in an older part. */
  spawned?: string[]
  /** 2b-2: the verify ids its verdicts cited, in round order (round n is entry n - 1). Absent in an older part. */
  rounds?: string[]
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
let cleared: ClearReason | null = null
let clearKills: ClearKill[] = []
let recorded: string | null = null
let gate = 0
let proposals: { name: string; n: number }[] = []
const spawnedBy = new Map<string, Set<string>>()
const roundsBy = new Map<string, string[]>()
let interactiveFlag: boolean | null = null
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
    await p.store.set(swarmStateKey(dir, name), fitPart(p, name, s))
  } catch (err) {
    p.log(`swarm ${name}: its state wasn't saved: ${errText(err)}`)
  }
}

/**
 * The part to write, within PART_MAX_BYTES: over it, the reports and closed
 * questions of the swarm's agents that aren't running go, oldest first, from
 * memory too (so the state and its mirror agree), until it fits; what went is
 * logged. Still over with nothing left to drop, it's written as it is.
 */
function fitPart(p: Ports, name: string, s: LiveSwarm): SwarmPart {
  let part = partOf(name, s)
  let size = jsonBytes(part)
  if (size <= PART_MAX_BYTES) return part
  const running = (id: string) => admission.get(id)?.status === 'running'
  /** `report` names the agent whose report it is; null for a question. */
  type Drop = { at: number; bytes: number; drop: () => void; report: string | null }
  const drops: Drop[] = []
  for (const b of part.bindings) {
    const r = reports.get(b.agentId)
    if (!r || running(b.agentId)) continue
    drops.push({ at: r.at, bytes: jsonBytes(r) + b.agentId.length + 4, drop: () => reports.delete(b.agentId), report: `${b.node} (${b.agentId})` })
  }
  for (const q of part.questions) {
    if (q.closedAt === null || running(q.agentId)) continue
    drops.push({ at: q.at, bytes: jsonBytes(q) + 1, drop: () => (questionList = questionList.filter(x => x !== q)), report: null })
  }
  drops.sort((a, b) => a.at - b.at)
  let next = 0
  while (size > PART_MAX_BYTES && next < drops.length) {
    // Drop by estimate, then measure again.
    let over = size - PART_MAX_BYTES
    while (over > 0 && next < drops.length) {
      const d = drops[next++]!
      d.drop()
      over -= d.bytes
    }
    part = partOf(name, s)
    size = jsonBytes(part)
  }
  if (next > 0) ver++
  const gone = drops.slice(0, next)
  const ofAgents = gone.flatMap(d => (d.report === null ? [] : [d.report]))
  const questionsGone = gone.length - ofAgents.length
  const still = size > PART_MAX_BYTES ? `; still ${size} bytes, written as it is` : ''
  p.log(
    `swarm ${name}: its state was over ${PART_MAX_BYTES} bytes: dropped the last report of ` +
      `${ofAgents.length === 0 ? 'no agent' : ofAgents.join(', ')} and ${questionsGone} closed questions, of agents not running${still}`,
  )
  return part
}

function partOf(name: string, s: LiveSwarm): SwarmPart {
  const bs = [...bindingsById.values()].filter(b => b.swarm === name)
  const ids = new Set(bs.map(b => b.agentId))
  const byAgent = <V>(m: Map<string, V>): Record<string, V> => Object.fromEntries([...m].filter(([id]) => ids.has(id)))
  return {
    v: 1,
    swarm: s,
    bindings: bs,
    admission: [...admission.values()].filter(a => a.swarm === name),
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
    spawned: [...(spawnedBy.get(name) ?? [])],
    rounds: [...(roundsBy.get(name) ?? [])],
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
 * It writes nothing. `typesReady` comes back false: it says the types are
 * registered in this process, and a part is from an earlier one.
 */
export async function loadSwarm(p: Ports, litterDir: string, name: string): Promise<LiveSwarm | null> {
  const raw = await p.store.get(swarmStateKey(litterDir, name))
  if (!isRecord(raw) || raw.v !== 1 || !isRecord(raw.swarm) || raw.swarm.name !== name) return null
  const part = raw as unknown as SwarmPart
  forget(name)
  const s: LiveSwarm = { ...part.swarm, typesReady: false }
  swarms.set(name, s)
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
  spawnedBy.set(name, new Set(Array.isArray(part.spawned) ? part.spawned.filter(k => typeof k === 'string') : []))
  roundsBy.set(name, Array.isArray(part.rounds) ? part.rounds.filter(v => typeof v === 'string') : [])
  ver++
  return s
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
  for (const [k, a] of admission) if (a.swarm === name) admission.delete(k)
  for (const [k, r] of reserved) if (r.swarm === name) reserved.delete(k)
  for (const [k, x] of stoppedById) if (x.swarm === name) stoppedById.delete(k)
  for (const [k, q] of queue) if (q.swarm === name) queue.delete(k)
  for (const [k, c] of calls) if (c.swarm === name || ids.has(c.agentId)) calls.delete(k)
  for (const [k, sh] of shellsById) if (sh.swarm === name || ids.has(sh.agentId)) shellsById.delete(k)
  instances.delete(name)
  questionList = questionList.filter(q => q.swarm !== name)
  directBySwarm.delete(name)
  spawnedBy.delete(name)
  roundsBy.delete(name)
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

/**
 * Drops an agent's binding, the place it holds, and its per-agent entries
 * (report, tokens, refused turns, its SubagentStop mark, its questions), so
 * nothing of a dropped agent stays in memory or in the mirror.
 */
export function dropBinding(agentId: string): void {
  const swarm = bindingsById.get(agentId)?.swarm ?? admission.get(agentId)?.swarm
  if (swarm === undefined) return
  bindingsById.delete(agentId)
  admission.delete(agentId)
  reports.delete(agentId)
  tokenCounts.delete(agentId)
  refused.delete(agentId)
  stoppedAgents.delete(agentId)
  questionList = questionList.filter(q => q.agentId !== agentId)
  changed(swarm)
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
// Admission: running, settling, parked and reserved places

/** Takes a place. A key already held is a bug in the caller, so it throws. */
export function reserve(r: Reservation): void {
  if (reserved.has(r.key)) throw new Error(`litter: the reservation ${r.key} is already held`)
  reserved.set(r.key, { ...r })
  ver++
}

/**
 * The reserved place becomes `agentId`'s running place, with the
 * reservation's swarm, node, parent, kind and scope, so it keeps counting
 * (countFor, countSwarm, activeScopes) before the binding is put. False when
 * nothing was reserved under `key`.
 */
export function promote(key: string, agentId: string): boolean {
  const r = reserved.get(key)
  if (!r) return false
  reserved.delete(key)
  admission.set(agentId, { agentId, status: 'running', scope: r.scope, ...placeOf(r) })
  changed(r.swarm)
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

/** Running, settling, or idle; a parked agent is idle here, between turns, though it holds its place (`isParked`). */
export function status(agentId: string): AdmissionStatus {
  const st = admission.get(agentId)?.status
  return st === undefined || st === 'parked' ? 'idle' : st
}

/** Parked (WP-AJ): its turn over, its place still held while the list shows it `waiting`. */
export const isParked = (agentId: string): boolean => admission.get(agentId)?.status === 'parked'

/** The parked agents of a swarm, each with the place it counts under. */
export const parkedIn = (swarm: string): (AdmissionPlace & { agentId: string })[] =>
  [...admission.values()].filter(a => a.swarm === swarm && a.status === 'parked').map(a => ({ ...placeOf(a), agentId: a.agentId }))

/**
 * Running (a spawn bound, a resume admitted). Clears a stop noted earlier: the
 * agent runs again. The scope stays unless given. The place it counts under
 * is `place` when given, else the one it holds, else its binding's; with none
 * of them it throws, as a caller's bug (a resume of an agent nothing knows).
 */
export function markRunning(agentId: string, scope?: WriteScope | null, place?: AdmissionPlace): void {
  const cur = admission.get(agentId)
  const b = bindingsById.get(agentId)
  const at = place ? placeOf(place) : cur ? placeOf(cur) : b ? placeOf(b) : null
  if (!at) throw new Error(`litter: ${agentId} has no place to run in: it holds none, has no binding, and none was given`)
  admission.set(agentId, { agentId, status: 'running', scope: scope !== undefined ? scope : (cur?.scope ?? null), ...at })
  stoppedAgents.delete(agentId)
  changed(at.swarm)
}

/**
 * Settling: from its turn.complete until the list stops showing it running.
 * It keeps its place; one that holds none takes its binding's, and an agent
 * with neither (no swarm's) is left as it is.
 */
export function markSettling(agentId: string): void {
  const cur = admission.get(agentId)
  const b = bindingsById.get(agentId)
  const at = cur ? placeOf(cur) : b ? placeOf(b) : null
  if (!at) return
  admission.set(agentId, { agentId, status: 'settling', scope: cur?.scope ?? null, ...at })
  changed(at.swarm)
}

/**
 * Parked (WP-AJ): its turn ended, and the list shows it `waiting` on its own
 * agents or background work, which will wake it. It keeps its place, in the
 * swarm's count and its parent's, and its scope unless given; one that holds
 * none takes its binding's, and an agent with neither is left as it is.
 * `markRunning`, `promote`, `markSettling` and `markSettled` clear it.
 */
export function markParked(agentId: string, scope?: WriteScope | null): void {
  const cur = admission.get(agentId)
  const b = bindingsById.get(agentId)
  const at = cur ? placeOf(cur) : b ? placeOf(b) : null
  if (!at) return
  admission.set(agentId, { agentId, status: 'parked', scope: scope !== undefined ? scope : (cur?.scope ?? null), ...at })
  changed(at.swarm)
}

/** Settled: its place is free. */
export function markSettled(agentId: string): void {
  const cur = admission.get(agentId)
  if (!cur) return
  admission.delete(agentId)
  changed(cur.swarm)
}

/** The places an agent and its swarm's reservations hold, each agent once, as the entries and reservations carry them. */
function places(swarm: string): (AdmissionPlace & { scope: WriteScope | null; agentId: string | null; key: string | null })[] {
  const out: ReturnType<typeof places> = []
  const counted = new Set<string>()
  for (const a of admission.values()) {
    if (a.swarm !== swarm) continue
    counted.add(a.agentId)
    out.push({ ...placeOf(a), scope: a.scope, agentId: a.agentId, key: null })
  }
  for (const r of reserved.values()) {
    if (r.swarm !== swarm || (r.agentId !== undefined && counted.has(r.agentId))) continue
    out.push({ ...placeOf(r), scope: r.scope, agentId: null, key: r.key })
  }
  return out
}

/** Running, settling, parked and reserved instances of `node` under `parent` (null: the lead). Children don't count. */
export const countFor = (swarm: string, parent: string | null, node: string): number =>
  places(swarm).filter(x => x.kind !== 'child' && x.node === node && x.parent === parent).length

/** Running, settling, parked and reserved agents of the swarm, children included (`maxAgentsAtOnce`). */
export const countSwarm = (swarm: string): number => places(swarm).length

/** Each running, settling, parked or reserved writing instance's scope. */
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

/**
 * Queues a message, assigning its id; its text is cut to 16 KiB. A swarm
 * holds at most QUEUE_MAX queued messages: past it, this throws "the queue
 * for <node> is full" and queues nothing.
 */
export function enqueue(msg: Omit<QueuedMessage, 'id'>): QueuedMessage {
  if (queued(msg.swarm).length >= QUEUE_MAX) throw new Error(`litter: the queue for ${msg.node} is full`)
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

export function callStart(agentId: string, toolUseId: string, tool: string, at: number, detail = ''): void {
  const swarm = swarmOfAgent(agentId)
  calls.set(callKey(agentId, toolUseId), { agentId, toolUseId, tool, detail, at, swarm })
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

/**
 * A node's last report, cut to 4 KiB. `at` is when it came (the caller's
 * `p.now()`): C added it, since WP-P's brief omits it, and the mirror's
 * trimming drops the oldest first.
 */
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

/**
 * A bound agent's question, open until closeQuestion, its text cut to 4 KiB.
 * Null for an agent no binding knows. `at` is when it was asked (the caller's
 * `p.now()`): C added it, since WP-P's brief omits it.
 */
export function noteQuestion(agentId: string, text: string, at: number): Question | null {
  const b = bindingsById.get(agentId)
  if (!b) return null
  const q: Question = { swarm: b.swarm, agentId, node: b.node, text: cutBytes(text, NOTE_MAX_BYTES), at, closedAt: null }
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

/**
 * Closes the agent's open questions; answers how many. `at` is when (the
 * caller's `p.now()`), kept as `closedAt`: C added it, since WP-P's brief omits it.
 */
export function closeQuestion(agentId: string, at: number): number {
  let n = 0
  questionList = questionList.map(q => (q.agentId === agentId && q.closedAt === null ? (n++, { ...q, closedAt: at }) : q))
  if (n > 0) changed(swarmOfAgent(agentId))
  return n
}

export const openQuestions = (swarm: string): Question[] => questionList.filter(q => q.swarm === swarm && q.closedAt === null)
/** Every question kept for the swarm, open and closed, oldest first. */
export const questions = (swarm: string): Question[] => questionList.filter(q => q.swarm === swarm)

/** Something you sent a node directly, for the lead's next `<swarm>` block; cut to 4 KiB. */
export function noteDirect(swarm: string, text: string): void {
  const list = [...(directBySwarm.get(swarm) ?? []), cutBytes(text, NOTE_MAX_BYTES)].slice(-DIRECT_KEPT)
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

/** The next `<swarm>` block opens with the cleared lines, worded for `why`. A clear wins over a move. */
export function markCleared(why: ClearReason = 'clear'): void {
  cleared = cleared === 'clear' ? 'clear' : why
  ver++
}

/** Why the next block opens with the cleared lines, once; null when it doesn't. */
export function takeCleared(): ClearReason | null {
  const was = cleared
  cleared = null
  if (was !== null) ver++
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
 * Runs `work` with the gate closed and opens it once: when `work` calls the
 * `open` it's handed (session.start, right after recovery), or when `work`
 * ends, a throw included. The gate is a counter, so a second open would open
 * it under someone else who holds it closed: `open` after the first does nothing.
 */
export async function withGateClosed<T>(work: (open: () => void) => Promise<T>): Promise<T> {
  closeGate()
  let opened = false
  const open = () => {
    if (opened) return
    opened = true
    openGate()
  }
  try {
    return await work(open)
  } finally {
    open()
  }
}

/**
 * Resolves at once while the gate is open; otherwise polls with
 * `p.sleep(25)`, and rejects after READY_MS (8 s), so a hook that waits fails
 * closed through its catch. A `$.clock` wait spends the waiting hook's 10 s
 * budget (ports.ts), so ready gives up with its own error before the budget
 * runs out. The gate starts open: a fresh module has nothing live, and tier 1
 * fires hooks without session.start. `maxMs`, when smaller, is what the
 * hook's budget has left for this wait (admit.ts's waitBudget, FIX-U U5).
 */
export async function ready(p: Ports, maxMs: number = READY_MS): Promise<void> {
  if (gate === 0) return
  const wait = Math.min(READY_MS, maxMs)
  if (!(wait > 0)) throw new Error("litter: the swarm state isn't ready")
  const deadline = (await p.now()) + wait
  for (;;) {
    await p.sleep(READY_POLL_MS)
    if (gate === 0) return
    if ((await p.now()) >= deadline) throw new Error("litter: the swarm state isn't ready")
  }
}

// ---------------------------------------------------------------------------
// The repair budget (2b-2; plan 15.11): what a repair swarm used of it.
// Mirrored with the swarm's part, and gone with the swarm.

/**
 * A spawn counted against the swarm's `budget.agents`, under its
 * reservation's key (decision 7: workers and children, not the orchestrator,
 * not resumes). Y notes it in the same synchronous step as the reservation,
 * and gives it back with `unnoteSpawned` on undo. A key noted twice counts once.
 */
export function noteSpawned(swarm: string, key: string): void {
  const keys = spawnedBy.get(swarm) ?? new Set<string>()
  spawnedBy.set(swarm, keys)
  if (keys.has(key)) return
  keys.add(key)
  changed(swarm)
}

/** Gives a counted spawn back (its reservation was undone). False when it wasn't counted. */
export function unnoteSpawned(swarm: string, key: string): boolean {
  if (!spawnedBy.get(swarm)?.delete(key)) return false
  changed(swarm)
  return true
}

export const spawnsUsed = (swarm: string): number => spawnedBy.get(swarm)?.size ?? 0

/**
 * The round of a verdict citing `verifyId` (decision 6: one verdict on a
 * distinct verify is a round), numbered from 1 over the swarm's life: a verify
 * noted already keeps its round. Y checks the budget before it notes one (see
 * `roundOf` and `roundsUsed`); whether a second verdict on the same verify is
 * taken is Y's to decide.
 */
export function noteRound(swarm: string, verifyId: string): number {
  const list = roundsBy.get(swarm) ?? []
  roundsBy.set(swarm, list)
  const at = list.indexOf(verifyId)
  if (at >= 0) return at + 1
  list.push(verifyId)
  changed(swarm)
  return list.length
}

/** The round `verifyId` was noted as; null when no verdict has cited it. */
export function roundOf(swarm: string, verifyId: string): number | null {
  const at = roundsBy.get(swarm)?.indexOf(verifyId) ?? -1
  return at >= 0 ? at + 1 : null
}

export const roundsUsed = (swarm: string): number => roundsBy.get(swarm)?.length ?? 0

// ---------------------------------------------------------------------------
// The session (2b-2, decision 15): whether anyone is at the prompt to watch a
// repair. This process's, so not mirrored: session.start answers it again
// after a reload (session.ts, "register() runs again on every reload").

/** True, false, or null while unknown, which the bridge treats as false ("no one to watch it"). */
export const interactive = (): boolean | null => interactiveFlag

/**
 * session.start's `isInteractive`: the engine's own answer, true under the
 * REPL and false for `-p` or the SDK (d.ts, SessionStartInput). It wins over
 * a prompt's origin.
 */
export function setInteractive(value: boolean): void {
  if (interactiveFlag === value) return
  interactiveFlag = value
  ver++
}

/**
 * A prompt.submit's origin, taken only while nothing has set the flag (a
 * session.start that never reached this module): `sdk` (`claude -p`, the
 * Agent SDK) is non-interactive, any other origin interactive. A prompt with
 * no origin leaves it unknown, for the next one to set.
 */
export function notePromptOrigin(origin: { readonly kind?: unknown } | null | undefined): void {
  if (interactiveFlag !== null || typeof origin?.kind !== 'string' || origin.kind === '') return
  interactiveFlag = origin.kind !== 'sdk'
  ver++
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
  cleared = null
  clearKills = []
  recorded = null
  gate = 0
  proposals = []
  spawnedBy.clear()
  roundsBy.clear()
  interactiveFlag = null
  ver = 0
  ports = null
  mirrorDir = null
  dirty.clear()
  dropped.clear()
  scheduled = false
  writing = null
}
