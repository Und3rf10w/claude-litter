// WP-L: admission for sends and wakes (session.send, turn.step), settling,
// the reply route, the message queue, mcp__litter__swarm_send, the browser's
// sends, the lead's <swarm> block, and swarm.bind with adoption after a reload
// (plan 15.4, "A send that resumes a node is admitted like a spawn" through
// "Wakes the engine starts on its own are admitted too", "Messages" and
// "Messages from you").
//
// One judgment covers every way a node hears something. `judge` reads the
// live state and, for a resume, reserves the place in the same synchronous
// step (15.4, "It reserves the place before it awaits anything"). The
// session.send hook, mcp__litter__swarm_send and the browser all go through
// `routeSend`; turn.step through `admitWake`. The mod's own sends are judged
// here before `p.send`, and the session.send hook then lets them through
// without judging them twice (`sendOwn`). The mod sends to nodes only from
// the swarm_send and ui.message dispatches, and submits to the lead only from
// its own timers (decision 2; 15.9, item 19).

import type { Ports, SessionSendResult } from '../ports'
import type { PortHook, PortStreamHook, SessionSendHook, SwarmSendHook, TurnCompleteHook, TurnStartHook, TurnStepHook } from '../hooktypes'
import type { RecordHandler } from '../records/core'
import type { SwarmEventBody, SwarmInstanceBody, SwarmNodeBody, SwarmSendReply } from '../records/swarm'
import type { BrowserSend, LiveSwarm, NodeBinding, QueuedMessage, SendOutcome, SwarmNode, WriteScope } from './types'
import { fail } from '../records/core'
import { appendLaunchRecord, readLaunchLedger } from '../records/swarm'
import { session } from '../session'
import { renderSlots } from '../prompts/slots'
import {
  SWARM_CONTEXT_CLEAR_KILLED,
  SWARM_CONTEXT_CLEARED,
  SWARM_CONTEXT_CLOSE,
  SWARM_CONTEXT_DIRECT,
  SWARM_CONTEXT_HINT,
  SWARM_CONTEXT_OPEN,
} from '../prompts/swarm-context'
import { decodeSwarmInput, SWARM_SEND } from './tools'
import { nodePolicyFor, patchNodePolicy, writeNodePolicy } from './guard'
import { noteSummaryTrigger } from './summary'
import * as state from './state'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A settling node's send waits up to this long, checking every step (15.4, "settling"). */
export const SETTLE_WAIT_MS = 2_000
export const SETTLE_STEP_MS = 250
/** The settle poll: from a node's turn.complete until the list stops showing it running. */
export const SETTLE_POLL_MS = 500
/** The lead's `<swarm>` block, every live swarm's together, in UTF-8 bytes (litter-prompts.md). */
export const CONTEXT_MAX_BYTES = 1024
/** A message's text in its `swarm.event`. */
const EVENT_TEXT_MAX = 2_000
/** A report's or question's line in the `<swarm>` block. */
const CONTEXT_LINE_MAX = 160

const utf8 = (text: string): number => new TextEncoder().encode(text).length
const isMain = (to: string): boolean => to.trim().toLowerCase() === 'main'
const cut = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

// ---------------------------------------------------------------------------
// What the spawn check and admission share (spawn.ts imports these)

export const nodeOf = (s: LiveSwarm, id: string): SwarmNode | null => s.spec.nodes.find(n => n.id === id) ?? null

/** How an instance is named to the lead and in swarm_send: `part-a`, `fixer#2`. */
export const instanceName = (b: NodeBinding): string => (b.kind === 'orchestrator' ? b.node : `${b.node}#${b.n}`)

/** How a binding reads in a message or a refusal: `fixer #2 (<agentId>)`. */
export function labelOf(b: NodeBinding): string {
  if (b.kind === 'child') return `an agent ${b.node} started (${b.agentId})`
  return b.kind === 'orchestrator' ? `${b.node} (${b.agentId})` : `${b.node} #${b.n} (${b.agentId})`
}

/** A writing node may write files (WP-J's definition): no `tools.deny` covering Edit, Write and NotebookEdit together, or `commit` set. */
export function writesFiles(node: SwarmNode): boolean {
  if (node.authority?.commit === true) return true
  const deny = node.tools?.deny ?? []
  return !['Edit', 'Write', 'NotebookEdit'].every(t => deny.includes(t))
}

/**
 * A writing instance's scope (15.4, tenth review): its directory and `paths`
 * (relative to it, a trailing `/` a folder), or the whole directory when it
 * may commit, since committers share an index and a branch. Null: it writes nothing.
 */
export function scopeOf(node: SwarmNode, dir: string): WriteScope | null {
  if (!writesFiles(node)) return null
  const commit = node.authority?.commit === true
  const paths = commit || !node.paths || node.paths.length === 0 ? null : node.paths.map(x => `${dir}/${x.replace(/^(\.\/)+/, '')}`)
  return { dir, paths, commit }
}

const meets = (x: string, y: string): boolean => {
  const a = x.replace(/\/+$/, '')
  const b = y.replace(/\/+$/, '')
  return a === b || (x.endsWith('/') && y.startsWith(x)) || (y.endsWith('/') && x.startsWith(y))
}

/** Two scopes in one directory meet unless both set `paths` and none of them meet. */
export function scopesOverlap(a: WriteScope, b: WriteScope): boolean {
  if (a.dir !== b.dir) return false
  if (a.commit || b.commit || a.paths === null || b.paths === null) return true
  return a.paths.some(x => b.paths!.some(y => meets(x, y)))
}

/** An agent and every binding above it, by `parent`: the instances a spawn or resume delegates from. */
export function lineageOf(agentId: string | null): Set<string> {
  const out = new Set<string>()
  let id = agentId
  while (id !== null && !out.has(id)) {
    out.add(id)
    id = state.binding(id)?.parent ?? null
  }
  return out
}

/**
 * The agents a spawn or resume from `agentId` delegates from: its lineage,
 * and the non-swarm children of each of them, which act for their node.
 */
export function delegatorsOf(agentId: string | null): Set<string> {
  const out = lineageOf(agentId)
  for (const b of state.bindings()) if (b.kind === 'child' && b.of !== null && out.has(b.of)) out.add(b.agentId)
  return out
}

/**
 * The running or reserved writer whose scope meets `scope`, leaving out the
 * instances it delegates from (`above`, from delegatorsOf), and a child
 * reservation one of them is making: a parent hands work to a worker in its
 * own directory, and holds its own scope while it waits; a node's children
 * work in its scope (WP-L's reading of 15.4). Sibling instances still meet,
 * which is what enforces `serial`.
 */
export function scopeConflict(swarm: string, scope: WriteScope, above: ReadonlySet<string>): { node: string; dir: string } | null {
  const held = new Map(state.reservations(swarm).map(r => [r.key, r]))
  const mine = (x: { agentId: string | null; key: string | null }): boolean => {
    if (x.agentId !== null) return above.has(x.agentId)
    const r = x.key === null ? undefined : held.get(x.key)
    if (!r) return false
    if (r.agentId !== undefined && above.has(r.agentId)) return true
    return r.kind === 'child' && r.parent !== null && above.has(r.parent)
  }
  const hit = state.activeScopes(swarm).find(x => !mine(x) && scopesOverlap(x, scope))
  return hit ? { node: hit.node, dir: hit.dir } : null
}

/** Why nothing of swarm `name` may start or hear anything from this session; null when it may. */
export function swarmRefusal(s: LiveSwarm | null, name: string, starting: boolean): string | null {
  if (!s) return `swarm ${name} isn't live`
  if (s.readOnly) return `swarm ${name} is another session's; this session only shows it`
  if (s.lost) return `swarm ${name} was handed to another session; this session no longer runs it`
  if (s.state !== 'live') return `swarm ${name} is ending`
  if (starting && !s.typesReady) return `swarm ${name}'s node types aren't registered in this session yet; try again in a moment`
  return null
}

/** The swarm's own cap (15.3, `limits.maxAgentsAtOnce`), as a refusal; null with room. */
export function capRefusal(s: LiveSwarm): string | null {
  const cap = s.spec.limits?.maxAgentsAtOnce
  if (cap === undefined) return null
  const k = state.countSwarm(s.name)
  return k >= cap ? `swarm ${s.name} is at its limit of ${cap} agents at once (limits.maxAgentsAtOnce); wait for one to finish` : null
}

/** What `parentNode` may spawn, in words, for a refusal. */
export function spawnsText(parentNode: SwarmNode): string {
  const list = Object.entries(parentNode.spawns ?? {})
  return list.length === 0 ? 'no swarm agents' : list.map(([w, k]) => `${w} (${k} at once)`).join(', ')
}

/** Records one swarm.event in the launch ledger; a failure is logged, never thrown (the event log is a record, not a gate). */
export async function swarmEvent(p: Ports, s: LiveSwarm | null, body: SwarmEventBody): Promise<void> {
  const dir = session().litterDir
  if (!dir || !s) return
  try {
    await appendLaunchRecord(p, dir, s.name, s.launch, 'swarm.event', body)
  } catch (err) {
    p.log(`swarm ${s.name}: its ${body.kind} event wasn't recorded: ${errText(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Module memory: the settle poll, the queue's hand-offs, the mod's own sends
// in flight, and what the last <swarm> block showed. Not mirrored: a reload
// starts the poll again (`kick`), and hands every queued message to the lead.

let poll: { cancel(): void } | null = null
let ticking = false
/** Queued ids handed to the lead and not yet delivered or cancelled. */
const handed = new Set<string>()
/** Queued ids refused for room at delivery: handed again once a place in their swarm frees. */
const waitingRoom = new Set<string>()
/** The mod's own sends in flight (`to` and text): the session.send hook passes them, judged already. */
const ownSends = new Map<string, number>()
/** Tokens a swarm.bind is binding now, so two calls can't take one instance. */
const claiming = new Set<string>()
/** agentId → the row the last `<swarm>` block showed for it. */
const shown = new Map<string, string>()
let lastBlockAt = 0

/** A fresh module's memory, for tests (with state.ts's resetForTests). */
export function resetForTests(): void {
  poll?.cancel()
  poll = null
  ticking = false
  handed.clear()
  waitingRoom.clear()
  ownSends.clear()
  claiming.clear()
  shown.clear()
  lastBlockAt = 0
}

// ---------------------------------------------------------------------------
// The judgment

type Verdict =
  | { kind: 'deliver' }
  | { kind: 'settling' }
  | { kind: 'resume'; key: string }
  /** The reply route: to the parent (null: the lead). */
  | { kind: 'reply'; parent: NodeBinding | null }
  | { kind: 'refuse'; reason: string; canQueue: boolean }

const refuse = (reason: string, canQueue = false): Verdict => ({ kind: 'refuse', reason, canQueue })
const resumeKey = (agentId: string): string => `resume:${agentId}`
/** A resume of this agent holds a place now (a send in flight). */
const resuming = (agentId: string): boolean => state.reservations().some(r => r.agentId === agentId)

/** The node a binding counts under: its own spec node, or a child's node's. */
const specOf = (s: LiveSwarm, b: NodeBinding): SwarmNode | null => nodeOf(s, b.node)

/** The checks a resume needs besides room (15.4, "A node that isn't running would be resumed"). */
function resumeRefusal(s: LiveSwarm, b: NodeBinding): { reason: string; canQueue: boolean } | null {
  if (!s.typesReady) return { reason: `swarm ${s.name}'s node types aren't registered in this session yet; try again in a moment`, canQueue: true }
  if (!specOf(s, b)) return { reason: `${b.node} isn't in swarm ${s.name}'s revision ${s.revision}`, canQueue: false }
  const stop = state.stopped(s.name).find(x => x.agentId === b.agentId)
  if (stop) return { reason: `${labelOf(b)} was stopped (${stop.reason})`, canQueue: false }
  if (b.kind === 'worker') {
    const parent = b.parent === null ? null : state.binding(b.parent)
    const pn = parent ? nodeOf(s, parent.node) : null
    if (!pn?.spawns?.[b.node]) return { reason: `${b.node} isn't in ${parent?.node ?? 'its parent'}'s spawns in revision ${s.revision}`, canQueue: false }
  }
  return null
}

/** The room a resume takes: its parent's count, the swarm's cap, and its write scope. Null with room. */
function placeRefusal(s: LiveSwarm, b: NodeBinding, scope: WriteScope | null): string | null {
  if (b.kind === 'orchestrator' && state.countFor(s.name, null, b.node) > 0) {
    return `another instance of ${b.node} is running; send to it instead`
  }
  if (b.kind === 'worker' && b.parent !== null) {
    const parent = state.binding(b.parent)
    const max = parent ? (nodeOf(s, parent.node)?.spawns?.[b.node] ?? 0) : 0
    const k = state.countFor(s.name, b.parent, b.node)
    if (k >= max) return `${parent ? labelOf(parent) : b.parent} already runs ${k} of its max ${max} ${b.node} at once; wait for one to finish`
  }
  const cap = capRefusal(s)
  if (cap) return cap
  if (scope) {
    const hit = scopeConflict(s.name, scope, delegatorsOf(b.parent))
    if (hit) return `another ${hit.node} is writing in ${hit.dir}; wait for it, or use own worktrees`
  }
  return null
}

/** The write scope a bound instance holds when it runs. */
const instanceScope = (s: LiveSwarm, b: NodeBinding): WriteScope | null => {
  const node = specOf(s, b)
  return node ? scopeOf(node, b.cwd) : null
}

/**
 * Judges a send to bound agent `b` from `sender` (the sending loop; null for
 * the main loop: the lead, the browser, a plugin), and reserves a resume's
 * place in the same step. A running node is delivered to; a settling one
 * waits; any other is a resume, readdressed to its parent when the sender
 * isn't it (15.4, "A resumed worker keeps reporting to its parent"; for an
 * orchestrator, whose parent is the lead, any main-loop sender is the lead).
 */
function judge(b: NodeBinding, sender: string | null, at: number): Verdict {
  const s = state.liveSwarm(b.swarm)
  const st = state.status(b.agentId)
  const off = swarmRefusal(s, b.swarm, false)
  // While the swarm ends, a node's report still reaches its parent, if that parent runs (never a resume).
  const reportUp = sender !== null && state.binding(sender)?.parent === b.agentId
  const ending = s !== null && s.state === 'stopping' && !s.readOnly && !s.lost
  if (off && !(ending && reportUp && st !== 'idle')) return refuse(off)
  if (!s) return refuse(`swarm ${b.swarm} isn't live`)
  if (st === 'running' || resuming(b.agentId)) return { kind: 'deliver' }
  if (st === 'settling') return { kind: 'settling' }
  const why = resumeRefusal(s, b)
  if (why) return refuse(why.reason, why.canQueue)
  if (sender !== b.parent) {
    if (b.parent === null) return { kind: 'reply', parent: null }
    const parent = state.binding(b.parent)
    if (!parent) return refuse(`${labelOf(b)} was started by ${b.parent}, which isn't bound any more; send to its orchestrator`)
    return { kind: 'reply', parent }
  }
  const scope = instanceScope(s, b)
  const room = placeRefusal(s, b, scope)
  if (room) return refuse(room, true)
  const key = resumeKey(b.agentId)
  state.reserve({ key, swarm: s.name, node: b.node, parent: b.parent, kind: b.kind, n: b.kind === 'child' ? null : b.n, scope, at, agentId: b.agentId })
  return { kind: 'resume', key }
}

/** A wake's admission (turn.step): what to do, decided and applied in one synchronous step. */
type Wake = { ok: true; patch: boolean } | { ok: false; reason: string }

function admitWake(b: NodeBinding): Wake {
  const s = state.liveSwarm(b.swarm)
  const off = swarmRefusal(s, b.swarm, true)
  if (off || !s) return { ok: false, reason: off ?? `swarm ${b.swarm} isn't live` }
  const why = resumeRefusal(s, b)
  if (why) return { ok: false, reason: why.reason }
  // A send resuming it holds its place already.
  const held = state.reservations().find(r => r.agentId === b.agentId)
  if (held) {
    state.promote(held.key, b.agentId)
    return { ok: true, patch: false }
  }
  // Woken while settling (parked, or the engine's stranded-message resume): it keeps its place.
  if (state.status(b.agentId) === 'settling') {
    state.markRunning(b.agentId)
    return { ok: true, patch: false }
  }
  const scope = instanceScope(s, b)
  const room = placeRefusal(s, b, scope)
  if (room) return { ok: false, reason: room }
  state.markRunning(b.agentId, scope)
  return { ok: true, patch: true }
}

// ---------------------------------------------------------------------------
// Routing a send

type Route = 'direct' | 'lead' | 'parent' | 'reply'

type SendReq = {
  to: NodeBinding
  /** What reaches the node when it's delivered now. */
  text: string
  /** The message as its sender wrote it: what the queue keeps, and a readdress wraps. */
  raw: string
  /** The sending loop: an agentId, or null for the main loop. */
  sender: string | null
  /** `user`, `lead`, an agentId, or `plugin:<name>`, as swarm.event takes it. */
  from: string
  /** The sender in words, for the wrapper: `the user`, `the lead`, `fixer #2 (<agentId>)`. */
  label: string
  route: Route
  delivery: 'interject' | 'queue'
}

type Deliver = (to: string, text: string) => Promise<SessionSendResult>
type Routed = { result: SessionSendResult; outcome: SendOutcome }

const refused = (reason: string, canQueue: boolean): Routed => ({
  result: { isDelivered: false, reason: `litter: ${reason}` },
  outcome: { kind: 'refused', reason, canQueue },
})

/** 15.4's wrapper for a message readdressed to the parent; to the lead for an orchestrator a node sent to. */
function wrapFor(b: NodeBinding, label: string, raw: string): string {
  const whose = b.kind === 'orchestrator' ? 'orchestrator' : b.kind === 'worker' ? 'worker' : 'agent'
  const how = b.parent === null ? 'Pass it on with mcp__litter__swarm_send, or answer it yourself.' : 'Pass it on with SendMessage, or answer it yourself.'
  return `For your ${whose} ${b.node} (${b.agentId}), from ${label}:\n\n${raw}\n\n${how}`
}

/** The text a node gets from the mod: yours as written; anyone else's with who it's from. */
const frame = (from: string, label: string, raw: string): string => (from === 'user' ? raw : `From ${label}:\n\n${raw}`)

function labelFrom(from: string): string {
  if (from === 'user') return 'the user'
  if (from === 'lead') return 'the lead'
  if (from.startsWith('plugin:')) return `the ${from.slice('plugin:'.length)} plugin`
  const b = state.binding(from)
  return b ? labelOf(b) : `agent ${from}`
}

/** One `message` event for a delivered send. */
function messageEvent(req: SendReq, to: NodeBinding, route: Route, text: string): SwarmEventBody {
  return { kind: 'message', node: to.node, agentId: to.agentId, from: req.from, to: to.agentId, route, delivery: req.delivery, text: cut(text, EVENT_TEXT_MAX) }
}

/** The node is done when the list no longer shows it running: settle it now (the hook's own check). */
async function settleIfDone(p: Ports, b: NodeBinding): Promise<void> {
  const row = (await p.listAgents()).find(a => a.id === b.agentId)
  if (row?.status !== 'running' && state.status(b.agentId) === 'settling') await finishSettle(p, b)
}

async function queueFor(p: Ports, s: LiveSwarm, req: SendReq, at: number): Promise<Routed> {
  const b = req.to
  let m: QueuedMessage
  try {
    m = state.enqueue({ swarm: s.name, agentId: b.agentId, node: b.node, text: req.raw, from: req.from, at })
  } catch (err) {
    return refused(errText(err).replace(/^litter: /, ''), false)
  }
  await swarmEvent(p, s, { kind: 'queued', node: b.node, agentId: b.agentId, id: m.id, from: req.from })
  kick(p)
  return { result: { isDelivered: true }, outcome: { kind: 'queued', id: m.id } }
}

/**
 * Judges a send and carries it out with `deliver` (the hook's `next`, or the
 * mod's own `p.send`): delivered, resumed with a place, readdressed to the
 * parent, queued, or refused. Each ends in at most one `deliver`.
 */
async function routeSend(p: Ports, req: SendReq, deliver: Deliver, depth = 0): Promise<Routed> {
  const b = req.to
  const s = state.liveSwarm(b.swarm)
  const at = await p.now()
  // Queue: held while the node runs or settles; sent at once when it's idle.
  if (req.delivery === 'queue' && s && swarmRefusal(s, b.swarm, false) === null && state.status(b.agentId) !== 'idle') return queueFor(p, s, req, at)
  let v = judge(b, req.sender, at)
  // Settling: wait for the list to let it go, then judge again (a $.clock wait spends the hook's budget: keep it to 2 s).
  for (let waited = 0; v.kind === 'settling' && waited < SETTLE_WAIT_MS; waited += SETTLE_STEP_MS) {
    await p.sleep(SETTLE_STEP_MS)
    await settleIfDone(p, b)
    v = judge(b, req.sender, await p.now())
  }
  if (v.kind === 'settling') return s ? queueFor(p, s, req, at) : refused(`swarm ${b.swarm} isn't live`, false)
  if (v.kind === 'refuse') {
    if (req.delivery === 'queue' && v.canQueue && s) return queueFor(p, s, req, at)
    await swarmEvent(p, s, { kind: 'send-refused', node: b.node, agentId: b.agentId, from: req.from, to: b.agentId, reason: v.reason })
    return refused(v.reason, v.canQueue)
  }
  if (v.kind === 'reply') return replyRoute(p, s!, req, v.parent, deliver, depth)
  if (v.kind === 'deliver') {
    const r = await deliver(b.agentId, req.text)
    if (!r.isDelivered) return { result: r, outcome: { kind: 'refused', reason: r.reason, canQueue: false } }
    state.closeQuestion(b.agentId, at)
    await swarmEvent(p, s, messageEvent(req, b, req.route, req.text))
    return { result: r, outcome: { kind: 'delivered' } }
  }
  return resumeNow(p, s!, req, v.key, deliver, at)
}

/** A resume: the policy marked admitted before the send, the place kept once it's delivered, released if not. */
async function resumeNow(p: Ports, s: LiveSwarm, req: SendReq, key: string, deliver: Deliver, at: number): Promise<Routed> {
  const b = req.to
  const dir = session().litterDir
  const undo = async (): Promise<void> => {
    // A step that already took the place (the agent runs) keeps it.
    if (!state.release(key) || !dir) return
    await patchNodePolicy(p, dir, b.agentId, { admitted: false }).catch(err => p.log(`${labelOf(b)}: its policy kept admitted: ${errText(err)}`))
  }
  try {
    if (!dir) throw new Error('this session has no litter directory')
    await patchNodePolicy(p, dir, b.agentId, { admitted: true })
  } catch (err) {
    await undo()
    return refused(`${labelOf(b)} couldn't be admitted: ${errText(err)}`, false)
  }
  let r: SessionSendResult
  try {
    r = await deliver(b.agentId, req.text)
  } catch (err) {
    await undo()
    return refused(`the send to ${labelOf(b)} failed: ${errText(err)}`, false)
  }
  if (!r.isDelivered) {
    await undo()
    await swarmEvent(p, s, { kind: 'resume-refused', node: b.node, agentId: b.agentId, from: req.from, reason: r.reason })
    return { result: r, outcome: { kind: 'refused', reason: r.reason, canQueue: false } }
  }
  state.promote(key, b.agentId)
  state.closeQuestion(b.agentId, at)
  await swarmEvent(p, s, messageEvent(req, b, req.route, req.text))
  return { result: r, outcome: { kind: 'delivered' } }
}

const REPLY_WHY = "it has finished its turn, so its parent passes the message on and keeps its report"

/** The reply route (15.4): the message goes to the parent, wrapped, and through admission there in turn. */
async function replyRoute(p: Ports, s: LiveSwarm, req: SendReq, parent: NodeBinding | null, deliver: Deliver, depth: number): Promise<Routed> {
  const b = req.to
  const wrapped = wrapFor(b, req.label, req.raw)
  await swarmEvent(p, s, { kind: 'readdressed', node: b.node, agentId: b.agentId, from: req.from, to: b.agentId, parent: parent?.agentId ?? 'lead', why: REPLY_WHY })
  if (parent === null) {
    // A node's send to an orchestrator that finished: the lead passes it on, so the orchestrator stays the lead's.
    const r = await deliver('main', wrapped)
    return r.isDelivered
      ? { result: r, outcome: { kind: 'readdressed', to: 'main', parentNode: 'the lead', why: REPLY_WHY } }
      : { result: r, outcome: { kind: 'refused', reason: r.reason, canQueue: false } }
  }
  if (depth >= 8) return refused(`${labelOf(b)}'s parents form a loop`, false)
  const up = await routeSend(p, { ...req, to: parent, text: wrapped, raw: wrapped, route: 'reply' }, deliver, depth + 1)
  if (up.outcome.kind === 'delivered') return { result: up.result, outcome: { kind: 'readdressed', to: parent.agentId, parentNode: parent.node, why: REPLY_WHY } }
  return up
}

/** The mod's own send: judged already, so the session.send hook lets it through (`ownKey`). */
async function sendOwn(p: Ports, to: string, text: string): Promise<SessionSendResult> {
  const k = ownKey(to, text)
  ownSends.set(k, (ownSends.get(k) ?? 0) + 1)
  try {
    return await p.send(to, text)
  } finally {
    const n = (ownSends.get(k) ?? 1) - 1
    if (n > 0) ownSends.set(k, n)
    else ownSends.delete(k)
  }
}

const ownKey = (to: string, text: string): string => `${to}\u0000${text}`

// ---------------------------------------------------------------------------
// session.send

/** An address in SendMessage's `from` form: `<name> [<ref>]`. */
const FROM_ADDRESS = /^(.*\S)\s*\[([0-9a-f]{6,12})\]$/

/**
 * The bound agent `to` names: an agentId, a received `from` address, or a
 * name `$.agent.list()` gives it. Null when it names no bound agent; `ambiguous`
 * when it could name more than one, or a node and another agent.
 */
async function resolveTo(p: Ports, to: string): Promise<NodeBinding | 'ambiguous' | null> {
  const direct = state.binding(to)
  if (direct) return direct
  if (isMain(to) || state.bindings().length === 0) return null
  const addr = FROM_ADDRESS.exec(to.trim())
  if (addr) {
    const ref = addr[2]!
    const hits = state.bindings().filter(b => b.agentId.includes(ref))
    if (hits.length === 1) return hits[0]!
    if (hits.length > 1) return 'ambiguous'
  }
  const name = addr ? addr[1]! : to.trim()
  const named = (await p.listAgents()).filter(a => a.name === name)
  const bound = named.flatMap(a => {
    const b = state.binding(a.id)
    return b ? [b] : []
  })
  if (bound.length === 0) return null
  return bound.length === 1 && named.length === 1 ? bound[0]! : 'ambiguous'
}

/** Who sent, for the event and the wrapper. */
function senderOf(e: Parameters<PortHook<SessionSendHook>>[1], fromB: NodeBinding | null): { from: string; label: string } {
  if (e.agentId !== undefined) return { from: e.agentId, label: fromB ? labelOf(fromB) : `agent ${e.agentId}` }
  if (e.origin.kind === 'model') return { from: 'lead', label: 'the lead' }
  return { from: `plugin:${e.origin.name}`, label: `the ${e.origin.name} plugin` }
}

/** The first line of a message that asks something: the node's question (WP-L's reading of "open questions"). */
function questionIn(text: string): string | null {
  const line = text.split('\n').map(l => l.trim()).find(l => l.endsWith('?') || /\?\s/.test(l))
  return line ? cut(line, 400) : null
}

/** A node's message to its parent or the lead: its last report, a question if it asks one, and O's summary trigger. */
async function noteFromNode(p: Ports, b: NodeBinding, toLead: boolean, toParent: boolean, text: string): Promise<void> {
  const s = state.liveSwarm(b.swarm)
  const at = await p.now()
  if (toLead) {
    await swarmEvent(p, s, { kind: 'message', node: b.node, agentId: b.agentId, from: b.agentId, to: 'lead', route: 'direct', delivery: 'interject', text: cut(text, EVENT_TEXT_MAX) })
    noteSummaryTrigger(b.swarm, 'to-lead')
  }
  if (!toLead && !toParent) return
  state.noteReport(b.agentId, text, 'message', at)
  const q = questionIn(text)
  if (q && state.noteQuestion(b.agentId, q, at)) await swarmEvent(p, s, { kind: 'question', node: b.node, agentId: b.agentId, text: q })
}

/**
 * session.send: every SendMessage and every plugin's send. A send to no node
 * from no node passes unchanged; a node's send while its swarm is ending
 * passes only to its parent; a send to a node goes through routeSend.
 */
export const admitSend: PortHook<SessionSendHook> = async (p, e, next) => {
  if (e.origin.kind === 'plugin' && ownSends.has(ownKey(e.to, e.text))) return next(e)
  await state.ready(p)
  if (state.liveSwarms().length === 0) return next(e)
  const sender = e.agentId ?? null
  const fromB = sender !== null ? state.binding(sender) : null
  const toB = await resolveTo(p, e.to)
  if (toB === 'ambiguous') {
    return { isDelivered: false, reason: `litter: '${e.to}' could name more than one agent, a swarm node among them; address it by its agent id` }
  }
  if (!toB && !fromB) return next(e)
  kick(p)
  const toParent = fromB !== null && (fromB.parent === null ? isMain(e.to) : toB?.agentId === fromB.parent)
  const toLead = fromB !== null && !toB && isMain(e.to)
  if (fromB) {
    const s = state.liveSwarm(fromB.swarm)
    const off = s?.lost ? 'this swarm was handed to another session; end your turn' : s?.state === 'stopping' && !toParent ? 'the swarm is ending; report and end your turn' : null
    if (off) {
      await swarmEvent(p, s, { kind: 'send-refused', node: fromB.node, agentId: fromB.agentId, from: fromB.agentId, to: toB ? toB.agentId : e.to, reason: off })
      return { isDelivered: false, reason: `litter: ${off}` }
    }
  }
  if (!toB) {
    const r = await next(e)
    if (fromB && r.isDelivered) await noteFromNode(p, fromB, toLead, false, e.text)
    return r
  }
  const who = senderOf(e, fromB)
  const routed = await routeSend(
    p,
    { to: toB, text: e.text, raw: e.text, sender, from: who.from, label: who.label, route: 'direct', delivery: 'interject' },
    (to, text) => next({ ...e, to, text }),
  )
  if (fromB && routed.result.isDelivered) await noteFromNode(p, fromB, false, toParent, e.text)
  return routed.result
}

// ---------------------------------------------------------------------------
// turn.step

const NOT_ADMITTED_LATER = 'this turn was refused at its first step'

/**
 * turn.step: a node's step the table doesn't show running runs admission
 * (15.4, "Every node turn is admitted at its first model request"). Refused,
 * it answers with one text chunk and a stop, and returns the whole
 * TurnStepResult, without which the engine sends the request anyway; every
 * later step of that turn is refused too (15.9, item 15). Anyone else's
 * step passes straight through.
 */
export const admitStep: PortStreamHook<TurnStepHook> = async function* (p, e, next) {
  const id = e.agentId
  if (id === undefined) return yield* next(e)
  await state.ready(p)
  const b = state.binding(id)
  if (!b) return yield* next(e)
  const refusal = async function* (reason: string) {
    const answer = `litter: not admitted: ${reason}; ending this turn`
    yield { kind: 'text' as const, index: 0, text: answer }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn' as const, usage: null }
  }
  if (state.isRefusedTurn(id, e.turnId)) return yield* refusal(NOT_ADMITTED_LATER)
  if (state.status(id) === 'running') return yield* next(e)
  const wake = admitWake(b)
  if (!wake.ok) {
    state.refuseTurn(id, e.turnId)
    await swarmEvent(p, state.liveSwarm(b.swarm), { kind: 'wake-refused', node: b.node, agentId: id, turnId: e.turnId, reason: wake.reason })
    return yield* refusal(wake.reason)
  }
  if (wake.patch) {
    const dir = session().litterDir
    try {
      if (!dir) throw new Error('this session has no litter directory')
      await patchNodePolicy(p, dir, id, { admitted: true })
    } catch (err) {
      // The guard would deny its every call: end the turn cleanly instead.
      state.markSettled(id)
      const reason = `its policy couldn't be updated (${errText(err)})`
      state.refuseTurn(id, e.turnId)
      await swarmEvent(p, state.liveSwarm(b.swarm), { kind: 'wake-refused', node: b.node, agentId: id, turnId: e.turnId, reason })
      return yield* refusal(reason)
    }
  }
  return yield* next(e)
}

// ---------------------------------------------------------------------------
// turn.start, turn.complete, and the settle poll

/** turn.start (the main loop only, d.ts): the lead is busy until its turn.complete. */
export async function leadTurnStart(p: Ports, e: Parameters<TurnStartHook>[1]): Promise<void> {
  state.setLeadBusy(true)
}

/**
 * turn.complete. The lead's (no agentId): no longer busy, and O's summary is
 * due. A bound node's, aborted or not: settling, until the poll sees the list
 * let it go. Anything else returns at once.
 */
export async function settleNode(p: Ports, e: Parameters<TurnCompleteHook>[1]): Promise<void> {
  if (e.agentId === undefined) {
    state.setLeadBusy(false)
    for (const s of state.liveSwarms()) if (!s.readOnly && !s.lost) noteSummaryTrigger(s.name, 'lead-turn')
    return
  }
  if (!state.binding(e.agentId)) return
  state.markSettling(e.agentId)
  kick(p)
}

/** Settled: its place is free, its policy no longer admitted, and its swarm's waiting messages may be handed on. */
async function finishSettle(p: Ports, b: NodeBinding): Promise<void> {
  state.markSettled(b.agentId)
  for (const q of state.queued(b.swarm)) waitingRoom.delete(q.id)
  const dir = session().litterDir
  if (dir) await patchNodePolicy(p, dir, b.agentId, { admitted: false }).catch(err => p.log(`${labelOf(b)}: its policy kept admitted after it settled: ${errText(err)}`))
}

/** A queued message the lead can deliver now: its node idle, not handed already, not waiting for room. */
const deliverable = (q: QueuedMessage): boolean => !handed.has(q.id) && !waitingRoom.has(q.id) && state.status(q.agentId) === 'idle'

function hasWork(): boolean {
  return state.bindings().some(b => state.status(b.agentId) === 'settling') || state.queued().some(deliverable)
}

/** Starts the settle poll when something settles or waits to be handed to the lead. */
function kick(p: Ports): void {
  if (poll || !hasWork()) return
  poll = p.every(SETTLE_POLL_MS, () => settleTick(p))
}

async function settleTick(p: Ports): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const settling = state.bindings().filter(b => state.status(b.agentId) === 'settling')
    if (settling.length > 0) {
      const listed = await p.listAgents()
      for (const b of settling) {
        const row = listed.find(a => a.id === b.agentId)
        if (row?.status !== 'running' && state.status(b.agentId) === 'settling') await finishSettle(p, b)
      }
    }
    handOff(p)
    if (!hasWork() && poll) {
      poll.cancel()
      poll = null
    }
  } catch (err) {
    p.log(`the swarm settle poll failed: ${errText(err)}`)
  } finally {
    ticking = false
  }
}

const QUEUED_HEAD =
  "litter: queued swarm messages can go now: these nodes have finished their turns. Deliver each with mcp__litter__swarm_send, passing only 'queued' with the id shown; litter sends a node's queued messages as one, oldest first."

/**
 * Hands every deliverable queued message to the lead, one prompt for all,
 * from the poll's timer callback: the host takes $.prompt.submit only there
 * or from a turn.complete (15.9, item 19), and it isn't awaited, since it
 * resolves only once the lead's next turn starts.
 */
function handOff(p: Ports): void {
  const lines: string[] = []
  const ids: string[] = []
  for (const s of state.liveSwarms()) {
    if (swarmRefusal(s, s.name, false)) continue
    const byAgent = new Map<string, QueuedMessage[]>()
    for (const q of state.queued(s.name)) {
      if (!deliverable(q)) continue
      byAgent.set(q.agentId, [...(byAgent.get(q.agentId) ?? []), q])
    }
    for (const [agentId, list] of byAgent) {
      const b = state.binding(agentId)
      if (!b) continue
      const k = list.length
      lines.push(`- ${instanceName(b)} in swarm ${s.name}: ${k} message${k === 1 ? '' : 's'}, queued: "${list[0]!.id}"`)
      for (const q of list) ids.push(q.id)
    }
  }
  if (lines.length === 0) return
  for (const id of ids) handed.add(id)
  void p.submitPrompt([QUEUED_HEAD, ...lines].join('\n')).catch((err: unknown) => {
    p.log(`queued swarm messages weren't handed to the lead: ${errText(err)}`)
    for (const id of ids) handed.delete(id)
  })
}

// ---------------------------------------------------------------------------
// mcp__litter__swarm_send and the browser

const NODE_REF = /^([a-z0-9][a-z0-9-]{0,31})(?:#([1-9][0-9]{0,5}))?$/

const latest = (list: readonly NodeBinding[]): NodeBinding | null =>
  list.reduce<NodeBinding | null>((a, b) => (a === null || b.boundAt >= a.boundAt ? b : a), null)

const statusWord = (b: NodeBinding): string => (state.isStopped(b.agentId) ? 'stopped' : state.status(b.agentId))

/**
 * The instance `ref` names (`node`, or `node#n` for one instance) in the
 * live swarm `swarmName` names, or the only live swarm with that node. A bare
 * worker name with more than one instance live is refused, listing them.
 */
function findInstance(swarmName: unknown, ref: unknown): { b: NodeBinding; s: LiveSwarm } | { error: string; field: string } {
  if (typeof ref !== 'string' || !NODE_REF.test(ref.trim())) return { error: "'node' is required: a node id, or <node>#<n> for one instance", field: 'node' }
  const [, id, num] = NODE_REF.exec(ref.trim())!
  const owned = state.liveSwarms().filter(s => !s.readOnly)
  let swarms = owned
  if (swarmName !== undefined && swarmName !== '') {
    if (typeof swarmName !== 'string') return { error: "'swarm' is a swarm name", field: 'swarm' }
    swarms = owned.filter(s => s.name === swarmName)
    if (swarms.length === 0) {
      return { error: `no swarm '${swarmName}' is live in this session${owned.length ? `; live: ${owned.map(s => s.name).join(', ')}` : ''}`, field: 'swarm' }
    }
  }
  const having = swarms.filter(s => nodeOf(s, id!) || state.bindings(s.name).some(b => b.node === id && b.kind !== 'child'))
  if (having.length === 0) return { error: `no live swarm has a node '${id}'`, field: 'node' }
  if (having.length > 1) return { error: `swarms ${having.map(s => s.name).join(' and ')} both have a node '${id}'; name one in 'swarm'`, field: 'swarm' }
  const s = having[0]!
  const all = state.bindings(s.name).filter(b => b.node === id && b.kind !== 'child')
  const list = (bs: readonly NodeBinding[]) => bs.map(b => `${instanceName(b)} (${statusWord(b)})`).join(', ')
  if (num !== undefined) {
    const hit = latest(all.filter(b => b.n === Number(num)))
    return hit ? { b: hit, s } : { error: `${id}#${num} isn't an instance of swarm ${s.name}${all.length ? `; there are ${list(all)}` : ''}`, field: 'node' }
  }
  if (all.length === 0) {
    const node = nodeOf(s, id!)
    return {
      error:
        node?.kind === 'orchestrator'
          ? `${id} hasn't been spawned yet; /litter:swarm start ${s.name} spawns it`
          : `no ${id} has started yet; its parent spawns it, so send to the parent`,
      field: 'node',
    }
  }
  if (all[0]!.kind === 'orchestrator') return { b: latest(all)!, s }
  const open = all.filter(b => !state.isStopped(b.agentId))
  const active = open.filter(b => state.status(b.agentId) !== 'idle')
  const pick = active.length > 0 ? active : open
  if (pick.length === 1) return { b: pick[0]!, s }
  return { error: `${id} has ${all.length} instances: ${list(all)}; name one as ${id}#<n>`, field: 'node' }
}

/** Several queued messages for one node go as one, oldest first, each with who it's from. */
function joinQueued(list: readonly QueuedMessage[]): { text: string; raw: string; from: string; label: string } {
  const froms = [...new Set(list.map(q => q.from))]
  const label = froms.map(labelFrom).join(' and ')
  const from = froms.length === 1 ? froms[0]! : froms.join(',')
  if (list.length === 1) {
    const q = list[0]!
    return { text: frame(q.from, label, q.text), raw: q.text, from, label }
  }
  const raw = [`${list.length} messages queued while you were busy, oldest first.`, ...list.map(q => `From ${labelFrom(q.from)}:\n\n${q.text}`)].join('\n\n')
  return { text: raw, raw, from, label }
}

/** swarm_send `{ queued }`: the stored messages for that node, sent through admission, then dropped from the queue. */
async function deliverQueued(p: Ports, id: unknown): Promise<SwarmSendReply> {
  if (typeof id !== 'string' || id.trim() === '') return { ok: false, error: "litter: 'queued' is a queued message id, as litter's request named it" }
  const m = state.queued().find(q => q.id === id.trim())
  if (!m) return { ok: false, error: `litter: no message is queued as '${id}': it was delivered or cancelled` }
  const s = state.liveSwarm(m.swarm)
  const all = state.queued(m.swarm, m.agentId)
  const b = state.binding(m.agentId)
  if (!s || !b) {
    for (const q of all) state.dequeue(q.id)
    return { ok: false, error: `litter: ${m.node} (${m.agentId}) is no longer in a live swarm; its queued messages were dropped` }
  }
  if (state.status(b.agentId) !== 'idle') {
    for (const q of all) handed.delete(q.id)
    return { ok: true, node: instanceName(b), agentId: b.agentId, outcome: { kind: 'queued', id: m.id } }
  }
  const j = joinQueued(all)
  const routed = await routeSend(
    p,
    { to: b, text: j.text, raw: j.raw, sender: null, from: j.from, label: j.label, route: 'direct', delivery: 'interject' },
    (to, text) => sendOwn(p, to, text),
  )
  const o = routed.outcome
  if (o.kind === 'refused' && o.canQueue) {
    // Kept: handed to you again once a place frees.
    for (const q of all) {
      handed.delete(q.id)
      waitingRoom.add(q.id)
    }
    return { ok: false, error: `litter: ${o.reason}; litter keeps the message queued and asks again once there's room`, outcome: o }
  }
  for (const q of all) {
    state.dequeue(q.id)
    handed.delete(q.id)
    waitingRoom.delete(q.id)
    if (o.kind !== 'refused') await swarmEvent(p, s, { kind: 'queue-sent', node: b.node, agentId: b.agentId, id: q.id })
  }
  if (o.kind === 'refused') return { ok: false, error: `litter: ${o.reason}; the queued message was dropped`, outcome: o }
  return { ok: true, node: instanceName(b), agentId: b.agentId, outcome: o }
}

/** tool.call on `mcp__litter__swarm_send`, after register.tsx's drain: answered here, never passed on. */
export const swarmSendTool: PortHook<SwarmSendHook> = async (p, e) => {
  const reply = await swarmSend(p, e.agentId, decodeSwarmInput(SWARM_SEND, e as unknown as Record<string, unknown>))
  return { result: JSON.stringify(reply) }
}

async function swarmSend(p: Ports, agentId: string | undefined, input: Record<string, unknown>): Promise<SwarmSendReply> {
  if (agentId !== undefined) return { ok: false, error: "litter: mcp__litter__swarm_send is the lead's alone; a node sends with SendMessage" }
  await state.ready(p)
  if (!session().litterDir) return { ok: false, error: 'litter: this session has no litter directory, so no swarm is live in it' }
  kick(p)
  if (input.queued !== undefined) return deliverQueued(p, input.queued)
  const found = findInstance(input.swarm, input.node)
  if ('error' in found) return { ok: false, error: `litter: ${found.error}` }
  const text = input.text
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: "litter: 'text' is required: the message for the node" }
  const deliver = input.deliver ?? 'interject'
  if (deliver !== 'interject' && deliver !== 'queue') return { ok: false, error: "litter: 'deliver' is interject or queue" }
  const { b } = found
  const routed = await routeSend(
    p,
    { to: b, text: frame('lead', 'the lead', text), raw: text, sender: null, from: 'lead', label: 'the lead', route: 'direct', delivery: deliver },
    (to, t) => sendOwn(p, to, t),
  )
  const o = routed.outcome
  if (o.kind === 'refused') return { ok: false, error: `litter: ${o.reason}`, outcome: o }
  return { ok: true, node: instanceName(b), agentId: b.agentId, outcome: o }
}

/** What the lead gets for a message you route through it (15.4, "Via lead"), with the delivery you chose spelled out. */
function viaLeadText(s: LiveSwarm, b: NodeBinding, text: string, when: 'interject' | 'queue'): string {
  const how = when === 'interject' ? 'now, as an interject (it reads it at its next tool call)' : 'as a queued message (it starts the node\'s next turn)'
  return [
    `litter: the user sent this from the swarm browser for ${instanceName(b)} in swarm ${s.name}, through you, to deliver ${how}.`,
    `Check it against what you know, add any context the node needs, then send it with mcp__litter__swarm_send (swarm "${s.name}", node "${instanceName(b)}", deliver "${when}"), and tell the user in a line what you added. If it shouldn't go as written, don't send it: tell the user why, and ask.`,
    '',
    '<message>',
    text,
    '</message>',
  ].join('\n')
}

/** A direct message from you, for the lead's next `<swarm>` block (15.4, "Direct skips the lead"). */
function noteDirectSend(b: NodeBinding, text: string, o: SendOutcome): void {
  if (o.kind === 'refused') return
  state.noteDirect(b.swarm, renderSlots(SWARM_CONTEXT_DIRECT, { node: instanceName(b), delivery: o.kind === 'queued' ? 'queued' : 'interjected', text: oneLine(text) }))
}

/**
 * The browser's composer (N, from ui.message): direct, via the lead, or via
 * the parent (15.4's table). Direct and via-parent sends go now, from this
 * dispatch; a queue is held until the node settles, or sent at once when it's
 * idle; a send to an idle worker takes the reply route. Via the lead, the
 * text is a row the busy lead reads now, or a prompt of its own, submitted
 * from a timer callback.
 */
export async function sendFromBrowser(p: Ports, input: BrowserSend): Promise<SendOutcome> {
  await state.ready(p)
  const s0 = state.liveSwarm(input.swarm)
  const off = swarmRefusal(s0, input.swarm, false)
  if (off) return { kind: 'refused', reason: off, canQueue: false }
  const found = findInstance(input.swarm, input.node)
  if ('error' in found) return { kind: 'refused', reason: found.error, canQueue: false }
  const { b, s } = found
  if (typeof input.text !== 'string' || input.text.trim() === '') return { kind: 'refused', reason: 'the message is empty', canQueue: false }
  kick(p)
  const text = input.text
  if (input.route === 'lead') {
    const row = viaLeadText(s, b, text, input.when)
    if (input.when === 'interject' && state.leadBusy()) {
      try {
        await p.appendUserRow(row)
      } catch (err) {
        return { kind: 'refused', reason: `the lead's conversation didn't take it: ${errText(err)}`, canQueue: false }
      }
    } else {
      // From a timer callback, outside this dispatch, and never awaited here (15.9, item 19).
      p.after(0, () => p.submitPrompt(row).catch((err: unknown) => p.log(`a message for ${instanceName(b)} via the lead wasn't submitted: ${errText(err)}`)))
    }
    await swarmEvent(p, s, { kind: 'message', node: b.node, agentId: b.agentId, from: 'user', to: 'lead', route: 'lead', delivery: input.when, text: cut(text, EVENT_TEXT_MAX) })
    return { kind: 'delivered' }
  }
  let to = b
  let raw = text
  let route: Route = 'direct'
  if (input.route === 'parent') {
    const parent = b.parent === null ? null : state.binding(b.parent)
    if (!parent) return { kind: 'refused', reason: `${instanceName(b)} has no parent node to route through; send it directly or via the lead`, canQueue: false }
    to = parent
    raw = wrapFor(b, 'the user', text)
    route = 'parent'
  }
  const routed = await routeSend(
    p,
    { to, text: raw, raw, sender: null, from: 'user', label: 'the user', route, delivery: input.when },
    (t, x) => sendOwn(p, t, x),
  )
  const o = routed.outcome
  noteDirectSend(b, text, o)
  if (o.kind === 'readdressed' && input.route === 'direct') return { ...o, why: "via parent (it's idle)" }
  return o
}

/** [Cancel] on a queued message: removes it and records `queue-cancelled`. True when it was there. */
export async function cancelQueued(p: Ports, id: string): Promise<boolean> {
  const m = state.cancelQueued(id)
  if (!m) return false
  handed.delete(id)
  waitingRoom.delete(id)
  await swarmEvent(p, state.liveSwarm(m.swarm), { kind: 'queue-cancelled', node: m.node, agentId: m.agentId, id })
  return true
}

// ---------------------------------------------------------------------------
// The lead's <swarm> block

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** A line of node text for the block: its first line, cut, unable to close the block. */
function firstLine(text: string): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
  return cut(oneLine(line), CONTEXT_LINE_MAX).replace(/<\/?swarm\b/gi, '[swarm')
}

/** One line of the block, and how readily it goes when the block is over 1 KiB (lower first, then oldest). */
type Line = { text: string; keep: number; at: number; agentId?: string; shownKey?: string }

const KEEP = Number.POSITIVE_INFINITY
const P_CLOSED = 1
const P_STOPPED_WORKER = 2
const P_IDLE_WORKER = 3
const P_WORKER = 4
const P_KILL = 5
const P_ORCHESTRATOR = 6
const P_DIRECT = 7

function rowOf(s: LiveSwarm, b: NodeBinding): string {
  const open = state.openQuestions(s.name).filter(q => q.agentId === b.agentId)
  const st = state.status(b.agentId)
  const status = state.isStopped(b.agentId) ? 'stopped' : st === 'running' ? 'running' : st === 'settling' ? 'finishing' : open.length > 0 ? 'blocked' : 'waiting'
  const report = state.lastReport(b.agentId)
  const detail =
    open.length > 0
      ? `open question: ${firstLine(open.at(-1)!.text)}${open.length > 1 ? ` (and ${open.length - 1} more)` : ''}`
      : report
        ? `last report: ${firstLine(report.text)}`
        : 'open question: none'
  return `${instanceName(b)}  ${b.kind}  ${status}  ${detail}`
}

/** The instances worth a row: each orchestrator's latest, and each worker instance's latest binding. */
function instancesOfSwarm(s: LiveSwarm): NodeBinding[] {
  const byKey = new Map<string, NodeBinding>()
  for (const b of state.bindings(s.name)) {
    if (b.kind === 'child') continue
    const key = b.kind === 'orchestrator' ? b.node : `${b.node}#${b.n}`
    const cur = byKey.get(key)
    if (!cur || b.boundAt >= cur.boundAt) byKey.set(key, b)
  }
  return [...byKey.values()].sort((a, b) => a.boundAt - b.boundAt)
}

function blockLines(s: LiveSwarm, cleared: boolean, kills: readonly { agentId: string; who: string; tool: string; detail: string }[], first: boolean): Line[] {
  const out: Line[] = [{ text: renderSlots(SWARM_CONTEXT_OPEN, { swarm: s.name, status: s.state }), keep: KEEP, at: 0 }]
  if (cleared) out.push({ text: renderSlots(SWARM_CONTEXT_CLEARED, { swarm: s.name }), keep: KEEP, at: 0 })
  for (const k of kills) {
    const mine = state.binding(k.agentId)?.swarm
    if (mine === s.name || (mine === undefined && first)) {
      out.push({ text: renderSlots(SWARM_CONTEXT_CLEAR_KILLED, { who: k.who, call: k.detail ? `${k.tool} (${k.detail})` : k.tool }), keep: P_KILL, at: 0 })
    }
  }
  for (const b of instancesOfSwarm(s)) {
    const row = rowOf(s, b)
    const busy = state.status(b.agentId) !== 'idle'
    const asks = state.openQuestions(s.name).some(q => q.agentId === b.agentId)
    const orchestrator = b.kind === 'orchestrator'
    if (!(cleared || orchestrator || busy || asks || shown.get(b.agentId) !== row)) continue
    const keep = orchestrator ? P_ORCHESTRATOR : busy || asks ? P_WORKER : P_IDLE_WORKER
    out.push({ text: row, keep, at: b.boundAt, agentId: b.agentId, shownKey: b.agentId })
  }
  // A stopped orchestrator's workers report to no one now: their last reports go to the lead (15.4).
  for (const o of state.bindings(s.name)) {
    if (o.kind !== 'orchestrator' || !state.isStopped(o.agentId)) continue
    for (const w of state.descendantsOf(o.agentId)) {
      const r = w.kind === 'worker' ? state.lastReport(w.agentId) : null
      if (!r) continue
      const text = `${instanceName(w)} (under ${o.node}, stopped)  last report: ${firstLine(r.text)}`
      const key = `stopped:${w.agentId}`
      if (cleared || shown.get(key) !== text) out.push({ text, keep: P_STOPPED_WORKER, at: r.at, shownKey: key })
    }
  }
  for (const q of state.questions(s.name)) {
    if (q.closedAt === null || q.closedAt <= lastBlockAt) continue
    const b = state.binding(q.agentId)
    out.push({ text: `${b ? instanceName(b) : q.node}  answered: ${firstLine(q.text)}`, keep: P_CLOSED, at: q.at })
  }
  for (const d of state.takeDirect(s.name)) out.push({ text: cut(d, 300), keep: P_DIRECT, at: 0 })
  out.push({ text: SWARM_CONTEXT_HINT, keep: KEEP, at: 0 }, { text: SWARM_CONTEXT_CLOSE, keep: KEEP, at: 0 })
  return out
}

/** Drops lines until the block fits: the oldest closed questions first, then by `keep`, oldest first. */
function fit(lines: Line[]): Line[] {
  const size = (ls: readonly Line[]) => utf8(ls.map(l => l.text).join('\n'))
  let kept = [...lines]
  const order = lines.filter(l => l.keep !== KEEP).sort((a, b) => a.keep - b.keep || a.at - b.at)
  for (const l of order) {
    if (size(kept) <= CONTEXT_MAX_BYTES) break
    kept = kept.filter(x => x !== l)
  }
  // Still over with only the fixed lines: drop whole swarms from the end, keeping the first.
  while (size(kept) > CONTEXT_MAX_BYTES) {
    const lastOpen = kept.map(l => l.text.startsWith('<swarm ')).lastIndexOf(true)
    if (lastOpen <= 0) break
    kept = kept.slice(0, lastOpen)
  }
  return kept
}

/**
 * The lead's `<swarm>` block for prompt.submit's `context` (litter-prompts.md,
 * "The lead's swarm context"), at most 1 KiB for every live swarm this
 * session owns. Each orchestrator, every worker that runs, asks or changed
 * since the last block, a stopped orchestrator's workers' last reports, the
 * questions answered since, and your direct messages, each listed once. After
 * a /clear it opens with the cleared lines and lists every node. Null with
 * nothing live.
 */
export async function swarmContext(p: Ports): Promise<string | null> {
  const live = state.liveSwarms().filter(s => !s.readOnly && !s.lost)
  if (live.length === 0) return null
  kick(p)
  const now = await p.now()
  const cleared = state.takeCleared()
  const kills = cleared ? state.takeClearKills() : []
  const lines = fit(live.flatMap((s, i) => blockLines(s, cleared, kills, i === 0)))
  for (const l of lines) if (l.shownKey !== undefined) shown.set(l.shownKey, l.text)
  lastBlockAt = now
  let text = lines.map(l => l.text).join('\n')
  // The fixed lines alone can't pass 1 KiB but for a swarm name or a kill's text; cut at a character, never mid-way through one.
  while (utf8(text) > CONTEXT_MAX_BYTES) text = text.slice(0, -1)
  return text
}

// ---------------------------------------------------------------------------
// swarm.bind, and adoption after a reload (15.4, "It records the instance before it dispatches it")

/** The launch's recorded instances, and the ones bound already (by a swarm.node record or a binding), as `<node>#<n>`. */
async function ledgerInstances(p: Ports, dir: string, s: LiveSwarm): Promise<{ instances: SwarmInstanceBody[]; bound: Set<string> }> {
  const { records, tampered } = await readLaunchLedger(p, dir, s.name, s.launch)
  if (tampered) throw new Error(`launch ${s.launch}'s ledger is tampered at record ${tampered.seq}`)
  const mod = records.filter(r => r.by.source === 'mod')
  const instances = mod.filter(r => r.kind === 'swarm.instance').map(r => r.body as unknown as SwarmInstanceBody)
  const bound = new Set(
    mod.filter(r => r.kind === 'swarm.node').map(r => {
      const b = r.body as unknown as SwarmNodeBody
      return `${b.node}#${b.n}`
    }),
  )
  for (const b of state.bindings(s.name)) if (b.kind !== 'child') bound.add(`${b.node}#${b.n}`)
  return { instances, bound }
}

/** Binds an agent to its recorded instance: `swarm.node { adopted: true }`, the binding, the policy. */
async function adopt(p: Ports, dir: string, s: LiveSwarm, inst: SwarmInstanceBody, agentId: string, running: boolean): Promise<NodeBinding> {
  const node = nodeOf(s, inst.node)
  const kind = node?.kind ?? 'worker'
  const b: NodeBinding = {
    agentId,
    swarm: s.name,
    launch: s.launch,
    node: inst.node,
    n: inst.n,
    kind,
    of: null,
    parent: inst.parentAgentId,
    type: s.types[inst.node] ?? '',
    cwd: inst.cwd,
    branch: inst.branch,
    token: inst.token,
    revision: s.revision,
    generation: s.owner.generation,
    boundAt: await p.now(),
    adopted: true,
  }
  const body: SwarmNodeBody = {
    node: inst.node,
    n: inst.n,
    agentId,
    parentAgentId: inst.parentAgentId,
    kind,
    cwd: inst.cwd,
    branch: inst.branch,
    model: node?.model ?? null,
    adopted: true,
    revision: s.revision,
    generation: s.owner.generation,
  }
  await appendLaunchRecord(p, dir, s.name, s.launch, 'swarm.node', body)
  state.putBinding(b)
  if (running) state.markRunning(agentId, node ? scopeOf(node, inst.cwd) : null)
  await writeNodePolicy(p, dir, agentId, nodePolicyFor(b, s, { admitted: running, stopped: null, bind: false }))
  return b
}

/**
 * Holds an agent nothing binds to `swarm.bind`: its policy says `bind`, so
 * the guard lets it call only mcp__litter__record until it presents its
 * token. Admitted, so the guard reaches the bind rule; nothing is bound.
 */
async function holdToBind(p: Ports, dir: string, s: LiveSwarm, agentId: string, node: string, parent: string | null): Promise<void> {
  const kind = nodeOf(s, node)?.kind ?? 'worker'
  const held: NodeBinding = {
    agentId,
    swarm: s.name,
    launch: s.launch,
    node,
    n: 0,
    kind,
    of: null,
    parent,
    type: s.types[node] ?? '',
    cwd: s.sessionCwd,
    branch: null,
    token: null,
    revision: s.revision,
    generation: s.owner.generation,
    boundAt: await p.now(),
    adopted: false,
  }
  await writeNodePolicy(p, dir, agentId, nodePolicyFor(held, s, { admitted: true, stopped: null, bind: true }))
}

/**
 * After a reload (K's recoverSwarms): an agent of a swarm type that no
 * binding knows is adopted without a token only when exactly one unbound
 * instance matches its type and parent, and no other unbound agent could be
 * it. Otherwise its policy holds it to swarm.bind.
 */
export async function adoptUnbound(p: Ports): Promise<void> {
  const dir = session().litterDir
  if (!dir) return
  const owned = state.liveSwarms().filter(s => !s.readOnly && !s.lost)
  if (owned.length === 0) return
  const listed = await p.listAgents()
  for (const s of owned) {
    const unbound = listed.filter(a => !state.binding(a.id) && state.swarmOfType(a.type)?.swarm === s.name)
    if (unbound.length === 0) continue
    const { instances, bound } = await ledgerInstances(p, dir, s)
    const open = instances.filter(i => !bound.has(`${i.node}#${i.n}`))
    for (const a of unbound) {
      const node = state.swarmOfType(a.type)!.node
      const parent = a.parentId ?? null
      const fits = open.filter(i => i.node === node && i.parentAgentId === parent)
      const rivals = unbound.filter(x => x.type === a.type && (x.parentId ?? null) === parent)
      try {
        if (fits.length === 1 && rivals.length === 1) await adopt(p, dir, s, fits[0]!, a.id, a.status === 'running')
        else await holdToBind(p, dir, s, a.id, node, parent)
      } catch (err) {
        p.log(`swarm ${s.name}: agent ${a.id} of ${a.type} wasn't adopted: ${errText(err)}`)
      }
    }
  }
  kick(p)
}

const TOKEN = /^[0-9a-f]{32}$/

/**
 * `swarm.bind { token }` through the record tool (15.4): accepted only from
 * an agent with no binding, of the instance's type, whose `parentId` is the
 * instance's parent, for an instance nothing is bound to yet. Then
 * `swarm.bind`, `swarm.node { adopted: true }` with the instance's directory
 * and branch, the binding, and the policy (no longer `bind`).
 */
export const recordSwarmBind: RecordHandler = async (ctx, input) => {
  const { p } = ctx
  const agentId = ctx.caller.agentId
  if (agentId === null) return fail("litter: 'swarm.bind' is a swarm node's call, not the main thread's", 'kind')
  const dir = ctx.litterDir
  if (!dir) return fail('litter: this session has no litter directory, so no swarm is live in it')
  const token = typeof input.token === 'string' ? input.token.trim() : ''
  if (!TOKEN.test(token)) return fail("litter: 'token' is required: the Bind token line of your <instance> block", 'token')
  await state.ready(p)
  const have = state.binding(agentId)
  if (have) return fail(`litter: you're bound already, as ${instanceName(have)} of swarm ${have.swarm}; carry on`, 'kind')
  const row = (await p.listAgents()).find(a => a.id === agentId)
  const hit = row ? state.swarmOfType(row.type) : null
  if (!row || !hit) return fail(`litter: 'swarm.bind' is for a swarm node with no binding, and this agent (${row?.type ?? 'not in the agent list'}) isn't one`, 'kind')
  const s = state.liveSwarm(hit.swarm)
  const off = swarmRefusal(s, hit.swarm, false)
  if (off || !s) return fail(`litter: ${off ?? `swarm ${hit.swarm} isn't live`}`)
  const notYours = fail("litter: that token isn't yours: use the Bind token line from your own <instance> block", 'token')
  if (claiming.has(token)) return notYours
  claiming.add(token)
  try {
    const { instances, bound } = await ledgerInstances(p, dir, s)
    const inst = instances.find(i => i.token === token)
    if (!inst || inst.node !== hit.node || inst.parentAgentId !== (row.parentId ?? null)) return notYours
    if (bound.has(`${inst.node}#${inst.n}`) || state.bindingByToken(s.name, token)) return notYours
    await appendLaunchRecord(p, dir, s.name, s.launch, 'swarm.bind', { token, agentId, node: inst.node, n: inst.n }, { source: 'agent', agentId, agentType: row.type })
    // It's calling a tool, so it runs: it holds a place from now.
    await adopt(p, dir, s, inst, agentId, true)
    return { ok: true, node: inst.node, n: inst.n, cwd: inst.cwd, branch: inst.branch }
  } finally {
    claiming.delete(token)
  }
}
