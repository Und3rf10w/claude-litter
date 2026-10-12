// The permission ask line (phase 5; COMMON step 3, decision 1): ask.sh's
// `ask` spool lines, each paired with guard.sh's `call` start for the same
// agent, tool and detail (which gives the tool_use_id), and kept open until
// that call's `call` end or `deny`, the agent's stop, or a later call start
// from the same agent. When the ui tick first sees an ask it writes one
// transcript row for it (p.note; COMMON decision 1, revised by WP-CK); each
// ask also gets p.notice twice at most, for a later engine that draws it
// under permission prompts. Owner: WP-CF.
//
// Why the transcript, not the band: on 2.1.290 the band is mounted in the
// prompt area (cli_formatted_2.1.290.js:1436199), which isn't drawn while a
// dialog hides the prompt (`visible` is `!vP() && …`, :1477851; vP :1454610),
// so a band row showed an ask only after it was answered. The transcript
// stays drawn above the dialog. The row is written once per ask, paired or
// not: never for an ask a drain opened and closed before the tick saw it, nor
// for one session.start brings back (the mirror's, or its drain's: a reload
// or a resume replays them, and their rows, if any, were written already).
//
// What 2.1.289 gives (cli_formatted_2.1.289.js):
//  - PreToolUse runs before the permission check (:454056), so a call's start
//    is spooled before its ask, in the same session's spool.
//  - A dialog you reject raises no hook at all: no PostToolUseFailure, and
//    PermissionDenied only for auto mode's classifier (:456298-456390). So a
//    rejected call never gets its `call` end, and what closes its ask is the
//    agent's next call, its stop, or the 15 minutes.
//  - Calls the engine counts as concurrency-safe run side by side (:735690),
//    so a sibling of the asking call can start just after the ask. Only a
//    call starting SIBLING_S or more after the ask closes it: one that waited
//    on you and on a model turn.
//  - An allowed call runs before its end is spooled, so its ask stays open
//    until the call ends.
//  - $.ui.notice is drawn only under AskUserQuestion (:1403425), and a refused
//    one is a debug-log line (ports.ts), so the notice is sent once when the
//    tool_use_id is known and once on the next tick, never more.
//
// Module memory, mirrored to $.store under ASKS_STORE_KEY with the session id
// (read back only by that session) so a reload finds the open asks and the
// calls they pair with.

import type { Ports } from './ports'
import type { AgentPolicy, NodePolicy, SpoolConsumer, SpoolCtx, SpoolLine } from './hookfiles'
import type { RunJson } from './records/run'
import type { AskEntry } from './uitypes'
import { agentInfo, readPolicy, roleOf } from './policy'
import { agentPolicyPath, runDir, RUN_ID } from './layout'
import { readJson } from './fsx'
import { checkedRunJson } from './runjson'
import { ROLE_POLICIES, isRoleName } from './roles'
import { shellQuote } from './quote'
import { oneLine } from './swarm/view'
import { binding } from './swarm/state'

/** An ask open this long is stale: closed, and logged (WP-CF). An ask line this old when drained isn't opened. */
export const ASK_STALE_MS = 15 * 60_000
/** Open calls kept per agent, the oldest dropped first. */
export const CALLS_PER_AGENT = 20
/** A later call of the asking agent closes its ask only when it starts this many seconds after the ask (see above). */
export const SIBLING_S = 2
/** $.store: the open asks and the per-agent calls, with the session they're this module's for. */
export const ASKS_STORE_KEY = 'litter.asks'
/**
 * A mirror older than this holds the asks of a process that's gone (a quit,
 * then a resume): its dialogs went with it, so its asks aren't restored. The
 * tick refreshes the mirror every HEARTBEAT_MS while an ask is open, so a
 * reload in a running session restores them.
 */
export const MIRROR_FRESH_MS = 30_000
const HEARTBEAT_MS = 10_000
const DETAIL_MAX = 120
const AUTHORIZED_MAX = 200
const NAME_MAX = 60
/** The tools whose call start carries a `detail` (lib.sh's calldetail); any other pairs by tool alone. */
const DETAILED = new Set(['Bash', 'Monitor'])
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/
/** A workflow agent's label, as the list shows it (execute.js: `write:G2#1`, `critic:G2#1`, `adversary:G2#1`). */
const GATE_LABEL = /^(?:write|critic|adversary):(G[0-9]+)#/

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const ms = (ts: number): number => Math.round(ts * 1000)

/** A call guard.sh spooled a start for and nothing closed yet. `at` in ms. */
type OpenCall = { toolUseId: string; tool: string; detail: string; at: number }
/**
 * An open ask, with what this module keeps beside it: the line's ts (seconds),
 * its detail as spooled, the notices sent, and whether its transcript row is
 * written (or never will be: one session.start brought back).
 */
type Held = AskEntry & { askTs: number; rawDetail: string; noticed: number; noted: boolean }
type Mirror = { v: 1; session: string; at: number; asks: Held[]; calls: Record<string, OpenCall[]> }

const callsByAgent = new Map<string, OpenCall[]>()
/** By key, in the order they opened. */
const held = new Map<string, Held>()
/** The keys the mirror brought back. */
const restored = new Set<string>()
let restoring: Promise<void> | null = null
let saving: Promise<void> | null = null
let again = false
/** A call changed since the last save: the tick writes the mirror. */
let dirty = false
let lastSave = 0

// ---------------------------------------------------------------------------
// The words

/** Who asks: `G2 executor`, `node fixer of swarm review`, `a child of node fixer of swarm review`. */
export function askWho(e: AskEntry): string {
  if (e.node !== null) {
    const child = e.agentType !== null && !e.agentType.startsWith('litter:sw-')
    return `${child ? 'a child of node' : 'node'} ${e.node}${e.swarm !== null ? ` of swarm ${e.swarm}` : ''}`
  }
  const role = e.role ?? e.agentType ?? 'an agent'
  return e.gate !== null ? `${e.gate} ${role}` : role
}

/** One ask in words: who, the tool and its detail, and what the launch authorized; what follows `⚑ asking · `. */
export function askText(e: AskEntry): string {
  const what = e.detail !== '' ? `${e.tool}: ${e.detail}` : e.tool
  return `${askWho(e)} wants ${what}${e.authorized !== '' ? ` · authorized: ${e.authorized}` : ''}`
}

/**
 * The ask's line, in the words the band's ask row had: its transcript row's
 * text and its notice's. No `litter: `: the engine puts the plugin's name first.
 */
export const askLine = (e: AskEntry): string => `⚑ asking · ${askText(e)}`

// ---------------------------------------------------------------------------
// What the launch authorized

const words = (xs: unknown): string[] => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === 'string' && x !== '') : [])

/** A node's write scope, its paths shown under its directory (NodePolicy: null is anywhere, [] none). */
function scopeOf(node: NodePolicy): string {
  if (node.paths === null) return 'write scope anywhere'
  const paths = words(node.paths)
  if (paths.length === 0) return 'writes no files'
  const dir = typeof node.dir === 'string' ? node.dir.replace(/\/+$/, '') : ''
  return `write scope ${paths.map(x => (dir !== '' && x.startsWith(`${dir}/`) ? x.slice(dir.length + 1) : x)).join(' ')}`
}

/** run.json's verify command, as an agent's prompt shows it. */
function verifyOf(json: RunJson | null): string | null {
  const argv = words(json?.verify)
  if (argv.length > 0) return shellQuote(argv)
  const cmd = json?.args?.verifyCommand
  return typeof cmd === 'string' && cmd !== '' ? cmd : null
}

/** A gate's Files as the launch passed them (run.json's args.gates). */
function gateFiles(json: RunJson | null, gate: string): string[] {
  const gates = json?.args?.gates
  if (!Array.isArray(gates)) return []
  const g = gates.find((x: unknown) => x !== null && typeof x === 'object' && (x as { id?: unknown }).id === gate) as { files?: unknown } | undefined
  return words(g?.files)
}

/**
 * One line, at most AUTHORIZED_MAX: a node's write scope; a fanout writer's
 * task files; an execute executor's verify command and its gate's Files;
 * else what the role may write (roles.ts).
 */
function authorizedFor(role: string | null, json: RunJson | null, gate: string | null, policy: AgentPolicy | null): string {
  const parts: string[] = []
  if (policy?.node) parts.push(scopeOf(policy.node))
  else if (policy?.task && Array.isArray(policy.task.owned)) parts.push(`task ${policy.task.id}'s files: ${words(policy.task.owned).join(' ')}`)
  else if (role !== null && isRoleName(role)) {
    if (role === 'executor' && json?.workflow === 'execute') {
      const cmd = verifyOf(json)
      if (cmd !== null) parts.push(`verify ${cmd}`)
      const files = gate !== null ? gateFiles(json, gate) : []
      parts.push(files.length > 0 ? `Files ${files.join(' ')}` : 'writes in the checkout')
    } else if (role === 'executor' && json?.workflow === 'fanout') {
      parts.push('not bound to its task yet')
    } else {
      const w = ROLE_POLICIES[role].write
      parts.push(w === 'none' ? 'read only' : w === 'own-worktree' ? 'writes in its own worktree' : 'writes in the checkout')
    }
  }
  return oneLine(parts.join(' · '), AUTHORIZED_MAX)
}

async function readAgentPolicy(p: Ports, litterDir: string, agentId: string): Promise<AgentPolicy | null> {
  try {
    const a = await readJson<AgentPolicy>(p, agentPolicyPath(litterDir, agentId))
    return a?.v === 1 ? a : null
  } catch (err) {
    p.log(`ask of agent ${agentId}: agents/${agentId}.json is unreadable (${errText(err)})`)
    return null
  }
}

/**
 * run.json as run.start wrote it (runjson.ts): you approve what it shows, so
 * a changed one, or one under a tampered ledger, shows only why it isn't read.
 */
async function readRunJson(p: Ports, litterDir: string, run: string): Promise<{ json: RunJson | null; refused: string | null }> {
  const c = await checkedRunJson(p, { run, runDir: runDir(litterDir, run) }).catch(() => null)
  if (c?.ok) return { json: c.json.v === 1 ? c.json : null, refused: null }
  return { json: null, refused: c && (c.why === 'changed' || c.why === 'tampered') ? c.reason : null }
}

/** An execute agent's gate, from its label in the agent list; null when it isn't listed or has none. */
async function gateOf(p: Ports, agentId: string): Promise<string | null> {
  const listed = (await p.listAgents().catch(() => [])).find(a => a.id === agentId)
  return GATE_LABEL.exec(listed?.description ?? '')?.[1] ?? null
}

/** The asking agent's run, role, gate, swarm, node and what it was authorized, from its binding and policy. */
async function describe(ctx: SpoolCtx, agentId: string, agentType: string | null): Promise<Pick<AskEntry, 'run' | 'role' | 'gate' | 'swarm' | 'node' | 'authorized'>> {
  const { p, litterDir } = ctx
  const info = await agentInfo(p, agentId).catch(() => undefined)
  const policy = await readAgentPolicy(p, litterDir, agentId)
  // The binding the mod wrote, else the swarm state's, when the file's gone.
  const bound = policy?.node ?? null
  const b = bound === null ? binding(agentId) : null
  const swarm = bound?.swarm ?? b?.swarm ?? null
  const node = bound?.node ?? b?.node ?? null
  const role = info?.role ?? roleOf(agentType ?? '')
  let run = info?.run ?? policy?.run ?? null
  if (run === null && role !== null) run = (await readPolicy(p, litterDir).catch(() => undefined))?.run?.run ?? null
  const { json, refused } = run !== null && RUN_ID.test(run) ? await readRunJson(p, litterDir, run) : { json: null, refused: null }
  const gate = role !== null && json?.workflow === 'execute' ? await gateOf(p, agentId) : null
  const name = (x: string | null) => (x === null ? null : oneLine(x, NAME_MAX))
  // A node's scope and a task's files are its policy's; only a role's line comes from run.json.
  const authorized = refused !== null && !policy?.node && !policy?.task ? oneLine(refused, AUTHORIZED_MAX) : authorizedFor(role, json, gate, policy)
  return { run: name(run), role: name(role), gate, swarm: name(swarm), node: name(node), authorized }
}

// ---------------------------------------------------------------------------
// The tables

/** Closes the entries `pred` picks; answers how many. */
function closeWhere(pred: (e: Held) => boolean): number {
  let n = 0
  for (const [key, e] of [...held]) {
    if (!pred(e)) continue
    held.delete(key)
    restored.delete(key)
    n++
  }
  return n
}

function addCall(agentId: string, call: OpenCall): void {
  const list = (callsByAgent.get(agentId) ?? []).filter(c => c.toolUseId !== call.toolUseId)
  list.push(call)
  callsByAgent.set(agentId, list.slice(-CALLS_PER_AGENT))
  dirty = true
}

function dropCall(agentId: string | null, toolUseId: string): void {
  for (const [id, list] of [...callsByAgent]) {
    if (agentId !== null && id !== agentId) continue
    const left = list.filter(c => c.toolUseId !== toolUseId)
    if (left.length === list.length) continue
    if (left.length === 0) callsByAgent.delete(id)
    else callsByAgent.set(id, left)
    dirty = true
  }
}

/** The newest open call of that agent and tool whose detail matches (by tool alone where the start has none), not already paired. */
function pairFor(agentId: string, tool: string, detail: string): OpenCall | null {
  const taken = new Set([...held.values()].flatMap(e => (e.toolUseId === null ? [] : [e.toolUseId])))
  const list = callsByAgent.get(agentId) ?? []
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i]!
    if (c.tool !== tool || taken.has(c.toolUseId)) continue
    if (DETAILED.has(tool) && c.detail !== detail) continue
    return c
  }
  return null
}

function sendNotice(p: Ports, e: Held): void {
  if (e.toolUseId === null || e.noticed >= 2) return
  e.noticed++
  if (!p.notice(e.toolUseId, askLine(e))) p.log(`ask of agent ${e.agentId}: $.ui.notice threw for ${e.toolUseId}`)
}

/** The ask's one transcript row, the first time the tick sees it; a throw is logged, and the row isn't tried again. */
function sendNote(p: Ports, e: Held): void {
  if (e.noted) return
  e.noted = true
  try {
    p.note(askLine(e))
  } catch (err) {
    p.log(`ask of agent ${e.agentId}: its transcript row wasn't written: ${errText(err)}`)
  }
}

/** Opens an entry for an `ask` line; false when it's stale, a repeat, or not an agent id. */
async function openAsk(ctx: SpoolCtx, line: Extract<SpoolLine, { ev: 'ask' }>): Promise<boolean> {
  const { p } = ctx
  const since = ms(line.ts)
  const detail = typeof line.detail === 'string' ? line.detail : ''
  const agentType = typeof line.agent_type === 'string' && line.agent_type !== '' ? line.agent_type : null
  if (!AGENT_ID.test(line.agent_id)) {
    p.log(`an ask line names no usable agent id: ${JSON.stringify(line.agent_id).slice(0, 140)}`)
    return false
  }
  if ((await p.now()) - since > ASK_STALE_MS) {
    p.log(`the ask of agent ${line.agent_id} for ${oneLine(line.tool, NAME_MAX)} is over 15 minutes old; not shown (stale)`)
    return false
  }
  // A line delivered again after a crash (policy.ts, drainAside) is an ask the mirror brought back. In
  // one module instance a line comes once, and two alike in one second are a batch's two calls.
  for (const e of held.values()) {
    if (restored.has(e.key) && e.agentId === line.agent_id && e.askTs === line.ts && e.tool === line.tool && e.rawDetail === detail) return false
  }
  const about = await describe(ctx, line.agent_id, agentType)
  // Paired after the awaits, against the calls as they are now.
  const call = pairFor(line.agent_id, line.tool, detail)
  let key = `${line.agent_id}@${line.ts}`
  for (let n = 2; held.has(key); n++) key = `${line.agent_id}@${line.ts}#${n}`
  const entry: Held = {
    key,
    agentId: line.agent_id,
    agentType: agentType === null ? null : oneLine(agentType, NAME_MAX),
    tool: oneLine(line.tool, NAME_MAX),
    detail: oneLine(detail, DETAIL_MAX),
    toolUseId: call?.toolUseId ?? null,
    ...about,
    since,
    askTs: line.ts,
    rawDetail: detail,
    noticed: 0,
    noted: false,
  }
  held.set(key, entry)
  sendNotice(p, entry)
  return true
}

// ---------------------------------------------------------------------------
// The mirror

function asCall(x: unknown): OpenCall | null {
  if (x === null || typeof x !== 'object') return null
  const c = x as Record<string, unknown>
  if (typeof c.toolUseId !== 'string' || c.toolUseId === '' || typeof c.tool !== 'string' || typeof c.detail !== 'string' || typeof c.at !== 'number') return null
  return { toolUseId: c.toolUseId, tool: c.tool, detail: c.detail, at: c.at }
}

const STR_OR_NULL = ['agentType', 'toolUseId', 'run', 'role', 'gate', 'swarm', 'node'] as const

function asHeld(x: unknown): Held | null {
  if (x === null || typeof x !== 'object') return null
  const e = x as Record<string, unknown>
  for (const k of ['key', 'agentId', 'tool', 'detail', 'authorized'] as const) if (typeof e[k] !== 'string') return null
  for (const k of STR_OR_NULL) if (e[k] !== null && typeof e[k] !== 'string') return null
  if (typeof e.since !== 'number' || typeof e.askTs !== 'number' || typeof e.noticed !== 'number') return null
  if (!AGENT_ID.test(e.agentId as string)) return null
  const pick = (k: (typeof STR_OR_NULL)[number]) => (e[k] as string | null)
  return {
    key: e.key as string,
    agentId: e.agentId as string,
    agentType: pick('agentType'),
    tool: e.tool as string,
    detail: e.detail as string,
    toolUseId: pick('toolUseId'),
    run: pick('run'),
    role: pick('role'),
    gate: pick('gate'),
    swarm: pick('swarm'),
    node: pick('node'),
    authorized: e.authorized as string,
    since: e.since,
    askTs: e.askTs,
    rawDetail: typeof e.rawDetail === 'string' ? e.rawDetail : (e.detail as string),
    noticed: Math.min(2, Math.max(0, e.noticed)),
    // Brought back by a reload or a resume: its row, if any, is the earlier module's.
    noted: true,
  }
}

async function writeMirror(p: Ports): Promise<void> {
  dirty = false
  const session = await p.sessionId()
  const at = await p.now()
  if (held.size === 0 && callsByAgent.size === 0) await p.store.delete(ASKS_STORE_KEY)
  else {
    const value: Mirror = { v: 1, session, at, asks: [...held.values()], calls: Object.fromEntries(callsByAgent) }
    await p.store.set(ASKS_STORE_KEY, value)
  }
  lastSave = at
}

/** Writes the mirror; a save asked for while one runs is one more write after it. */
function save(p: Ports): Promise<void> {
  if (saving) {
    again = true
    return saving
  }
  again = false
  saving = writeMirror(p)
    .catch(err => {
      // The tick tries again.
      dirty = true
      p.log(`the open asks weren't saved: ${errText(err)}`)
    })
    .then(() => {
      saving = null
      if (again) return save(p)
    })
  return saving
}

/** This session's mirror back into module memory, once per module instance, before any line is applied. */
async function restore(p: Ports): Promise<void> {
  const v = (await p.store.get(ASKS_STORE_KEY)) as Partial<Mirror> | undefined
  if (!v || typeof v !== 'object' || v.v !== 1) return
  const sid = await p.sessionId()
  if (v.session !== sid) return
  const now = await p.now()
  for (const [agentId, list] of Object.entries(v.calls ?? {})) {
    if (!AGENT_ID.test(agentId) || !Array.isArray(list)) continue
    const calls = list.map(asCall).filter((c): c is OpenCall => c !== null && now - c.at <= ASK_STALE_MS)
    for (const c of calls) addCall(agentId, c)
  }
  const asks = (Array.isArray(v.asks) ? v.asks : []).map(asHeld).filter((e): e is Held => e !== null && now - e.since <= ASK_STALE_MS)
  if (asks.length > 0 && !(typeof v.at === 'number' && now - v.at <= MIRROR_FRESH_MS)) {
    p.log(`${asks.length} open ${asks.length === 1 ? 'ask was' : 'asks were'} saved by a process that's gone; not restored`)
    return
  }
  for (const e of asks) {
    if (held.has(e.key)) continue
    held.set(e.key, e)
    restored.add(e.key)
  }
}

function ensureRestored(p: Ports): Promise<void> {
  restoring ??= restore(p).catch(err => p.log(`the open asks weren't restored: ${errText(err)}`))
  return restoring
}

// ---------------------------------------------------------------------------
// The hooks' side

/**
 * In SPOOL_CONSUMERS after consumeInflight (registry.ts): `call` starts and
 * ends, `deny`, `stop` and `ask` lines. An ask pairs with the newest open
 * call of its agent and tool whose detail matches; it closes at its call's
 * end or deny, its agent's stop, or a call of that agent starting SIBLING_S
 * or more after it. The mirror is saved after every open or close; the
 * transcript row waits for the tick, so an ask one drain opens and closes
 * gets none.
 */
export const consumeAsks: SpoolConsumer = async (ctx, line) => {
  if (line.ev !== 'ask' && line.ev !== 'call' && line.ev !== 'deny' && line.ev !== 'stop') return
  const { p } = ctx
  await ensureRestored(p)
  let changed = false
  if (line.ev === 'call') {
    if (line.tool_use_id === '') return
    if (line.phase === 'start') {
      changed = closeWhere(e => e.agentId === line.agent_id && e.toolUseId !== line.tool_use_id && line.ts - e.askTs >= SIBLING_S) > 0
      addCall(line.agent_id, { toolUseId: line.tool_use_id, tool: line.tool, detail: typeof line.detail === 'string' ? line.detail : '', at: ms(line.ts) })
    } else {
      dropCall(line.agent_id, line.tool_use_id)
      changed = closeWhere(e => e.agentId === line.agent_id && e.toolUseId === line.tool_use_id) > 0
    }
  } else if (line.ev === 'deny') {
    if (typeof line.tool_use_id !== 'string' || line.tool_use_id === '') return
    const agentId = typeof line.agent_id === 'string' && line.agent_id !== '' ? line.agent_id : null
    dropCall(agentId, line.tool_use_id)
    changed = closeWhere(e => e.toolUseId === line.tool_use_id && (agentId === null || e.agentId === agentId)) > 0
  } else if (line.ev === 'stop') {
    if (callsByAgent.delete(line.agent_id)) dirty = true
    changed = closeWhere(e => e.agentId === line.agent_id) > 0
  } else {
    changed = await openAsk(ctx, line)
  }
  if (changed) await save(p)
}

/** The asks open now, newest first (module memory; restoreAsks fills it after a reload). */
export function openAsks(): AskEntry[] {
  return [...held.values()]
    .reverse()
    .sort((a, b) => b.since - a.since)
    .map(e => ({
      key: e.key,
      agentId: e.agentId,
      agentType: e.agentType,
      tool: e.tool,
      detail: e.detail,
      toolUseId: e.toolUseId,
      run: e.run,
      role: e.role,
      gate: e.gate,
      swarm: e.swarm,
      node: e.node,
      authorized: e.authorized,
      since: e.since,
    }))
}

/**
 * session.start, after its drain: this session's open asks and calls back
 * after a reload (the drain restores them first, when it has lines). Every
 * ask held now is a replay, the mirror's or one the drain opened from lines
 * an earlier module or process spooled, so none gets a transcript row.
 */
export async function restoreAsks(p: Ports): Promise<void> {
  await ensureRestored(p)
  for (const e of held.values()) e.noted = true
}

/**
 * The ui tick's step after the cards' (uitick.ts): an ask open over 15
 * minutes is closed and logged as stale, calls that old are forgotten, an ask
 * the tick sees for the first time gets its transcript row, one noticed once
 * gets its second notice, and the mirror is written when a call changed or,
 * while an ask is open, every HEARTBEAT_MS.
 */
export async function asksTick(p: Ports): Promise<void> {
  await ensureRestored(p)
  const now = await p.now()
  let closed = 0
  for (const e of [...held.values()]) {
    if (now - e.since <= ASK_STALE_MS) continue
    held.delete(e.key)
    restored.delete(e.key)
    closed++
    p.log(`the ask of ${askWho(e)} (${e.agentId}) for ${e.tool} was open over 15 minutes; closed as stale`)
  }
  for (const [id, list] of [...callsByAgent]) {
    const left = list.filter(c => now - c.at <= ASK_STALE_MS)
    if (left.length === list.length) continue
    if (left.length === 0) callsByAgent.delete(id)
    else callsByAgent.set(id, left)
    dirty = true
  }
  // In the order they opened, so the rows read as the asks came.
  for (const e of held.values()) sendNote(p, e)
  for (const e of held.values()) if (e.noticed === 1) sendNotice(p, e)
  if (closed > 0 || dirty || (held.size > 0 && now - lastSave >= HEARTBEAT_MS)) await save(p)
}

/** A fresh module's memory, for tests: nothing open, nothing restored. */
export function resetAsksForTests(): void {
  callsByAgent.clear()
  held.clear()
  restored.clear()
  restoring = null
  saving = null
  again = false
  dirty = false
  lastSave = 0
}
