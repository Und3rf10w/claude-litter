// WP-L: admission for sends and wakes (session.send, turn.step), settling,
// the reply route, mcp__litter__swarm_send, the browser's sends, the lead's
// <swarm> block, and swarm.bind with adoption after a reload (plan 15.4, "A
// send that resumes a node is admitted like a spawn" through "Wakes the
// engine starts on its own are admitted too", "Messages" and "Messages from
// you").
//
// Every send goes now (the user, 2026-10-07: "get rid of the ability to queue
// messages and interject only"): a running node reads it at its next step,
// an idle one is resumed with it, and one still finishing its turn gets it
// after the settle wait, which the engine resumes it with (its stranded
// messages, 2.1.293 `agentStrandedMessages`) and turn.step admits. Nothing is
// held to send later.
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

import type { AgentPolicy } from '../hookfiles'
import type { AgentStatus, Ports, SessionSendResult } from '../ports'
import type { PortHook, PortStreamHook, SessionSendHook, SwarmSendHook, TurnCompleteHook, TurnStartHook, TurnStepHook } from '../hooktypes'
import type { RecordHandler } from '../records/core'
import type { SwarmEventBody, SwarmInstanceBody, SwarmNodeBody, SwarmSendReply } from '../records/swarm'
import type { BrowserSend, ClearKill, ClearReason, Effort, LiveSwarm, NodeBinding, SendOutcome, SwarmNode, WriteScope } from './types'
import { fail } from '../records/core'
import { appendLaunchRecord, readLaunchLedger } from '../records/swarm'
import { agentLive } from '../ports'
import { agentPolicyPath, hooksDir } from '../layout'
import { readJson } from '../fsx'
import { session } from '../session'
import { renderSlots } from '../prompts/slots'
import {
  SWARM_CONTEXT_CLEAR_KILLED,
  SWARM_CONTEXT_CLEARED,
  SWARM_CONTEXT_CLOSE,
  SWARM_CONTEXT_DIRECT,
  SWARM_CONTEXT_HINT,
  SWARM_CONTEXT_MOVED,
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
/** The settle poll: from a node's turn.complete until the list stops showing it running, and while a node is parked. */
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
// The hook's budget (FIX-U, U5)

/** A hook's own time per dispatch (the d.ts's HookBudget): a `$.clock` wait spends it, no other `$` call does. */
export const HOOK_BUDGET_MS = 10_000
/** Kept back from every wait, for the hook's code after it. */
export const BUDGET_MARGIN_MS = 500

/** What a wait may still spend of this dispatch's budget, read fresh each time. */
export type WaitBudget = { left(): Promise<number> }

/**
 * One budget per hook dispatch: from the engine's `next.budget`, which counts
 * the hook's own time from its start (rebound's wait included) and stands
 * still through every `$` call but a `$.clock` wait. Where nothing meters it
 * (Infinity, or a test's bare next), the hook's 10 s from now. Each wait takes
 * the smaller of its own cap and what's left, less the margin; past it, the
 * wait ends.
 */
export async function waitBudget(p: Ports, next?: object): Promise<WaitBudget> {
  // `budget` is a getter on the engine's next: each read is the meter now.
  const metered = (): number | undefined => (next as { readonly budget?: { readonly remainingMs: number } } | undefined)?.budget?.remainingMs
  const first = metered()
  if (first !== undefined && Number.isFinite(first)) return { left: async () => Math.max(0, (metered() ?? 0) - BUDGET_MARGIN_MS) }
  const start = await p.now()
  return { left: async () => Math.max(0, HOOK_BUDGET_MS - ((await p.now()) - start) - BUDGET_MARGIN_MS) }
}

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
 * The running, parked or reserved writer whose scope meets `scope`, leaving
 * out the instances it delegates from (`above`, from delegatorsOf), and a child
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

/** A refusal names at most this many parked agents. */
const PARKED_NAMED = 5

/**
 * The parked among the agents a refusal counts, in words, or null when none
 * is (WP-AJ). A parked agent ended its turn with its own agents or
 * background work still running, and keeps its place until it ends, so the
 * one refused knows to wait for it, or to go on without the agent it asked for.
 */
function parkedClause(ids: readonly string[]): string | null {
  if (ids.length === 0) return null
  const names = ids.slice(0, PARKED_NAMED).map(id => {
    const b = state.binding(id)
    return b ? labelOf(b) : id
  })
  const more = ids.length > PARKED_NAMED ? ` and ${ids.length - PARKED_NAMED} more` : ''
  return ids.length === 1
    ? `1 of them is parked: ${names[0]}, which ended its turn with its own agents or background work still running, and keeps its place until it ends`
    : `${ids.length} of them are parked: ${names.join(', ')}${more}, which ended their turns with their own agents or background work still running, and keep their places until they end`
}

/** A count's refusal: `at`, then the parked it counts when there are any. */
const countRefusal = (at: string, parked: string | null): string =>
  parked ? `${at}, and ${parked}; wait for one to finish, or go on without this agent` : `${at}; wait for one to finish`

/** The swarm's own cap (15.3, `limits.maxAgentsAtOnce`), as a refusal naming its parked agents; null with room. */
export function capRefusal(s: LiveSwarm): string | null {
  const cap = s.spec.limits?.maxAgentsAtOnce
  if (cap === undefined) return null
  const k = state.countSwarm(s.name)
  if (k < cap) return null
  const parked = parkedClause(state.parkedIn(s.name).map(x => x.agentId))
  return countRefusal(`swarm ${s.name} is at its limit of ${cap} agents at once (limits.maxAgentsAtOnce)`, parked)
}

/**
 * A parent at its max of `node` at once (its `spawns`), as a refusal naming
 * the parked instances it counts; null with room. `parentId` is the parent's
 * agentId. The spawn check's count can word itself the same way.
 */
export function parentCountRefusal(s: LiveSwarm, parentId: string, node: string, max: number): string | null {
  const k = state.countFor(s.name, parentId, node)
  if (k < max) return null
  const parent = state.binding(parentId)
  const parked = parkedClause(
    state
      .parkedIn(s.name)
      .filter(x => x.kind !== 'child' && x.parent === parentId && x.node === node)
      .map(x => x.agentId),
  )
  return countRefusal(`${parent ? labelOf(parent) : parentId} already runs ${k} of its max ${max} ${node} at once`, parked)
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
// Module memory: the settle poll, the mod's own sends in flight, and what the
// last <swarm> block showed. Not mirrored: a reload starts the poll again
// (`kick`).

let poll: { cancel(): void } | null = null
let ticking = false
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
  | { kind: 'refuse'; reason: string }

const refuse = (reason: string): Verdict => ({ kind: 'refuse', reason })
const resumeKey = (agentId: string): string => `resume:${agentId}`
/** A resume of this agent holds a place now (a send in flight). */
const resuming = (agentId: string): boolean => state.reservations().some(r => r.agentId === agentId)

/** The node a binding counts under: its own spec node, or a child's node's. */
const specOf = (s: LiveSwarm, b: NodeBinding): SwarmNode | null => nodeOf(s, b.node)

/** The checks a resume needs besides room (15.4, "A node that isn't running would be resumed"). */
function resumeRefusal(s: LiveSwarm, b: NodeBinding): string | null {
  if (!s.typesReady) return `swarm ${s.name}'s node types aren't registered in this session yet; try again in a moment`
  if (!specOf(s, b)) return `${b.node} isn't in swarm ${s.name}'s revision ${s.revision}`
  const stop = state.stopped(s.name).find(x => x.agentId === b.agentId)
  if (stop) return `${labelOf(b)} was stopped (${stop.reason})`
  if (b.kind === 'worker') {
    const parent = b.parent === null ? null : state.binding(b.parent)
    const pn = parent ? nodeOf(s, parent.node) : null
    if (!pn?.spawns?.[b.node]) return `${b.node} isn't in ${parent?.node ?? 'its parent'}'s spawns in revision ${s.revision}`
  }
  return null
}

/**
 * The room a resume takes: its parent's count, the swarm's cap, and its write
 * scope. Null with room. A parked node holds its place already, counted in
 * both, so only its scope is judged (WP-AJ), leaving out its own place and
 * those of the agents under it, which work in its scope as its delegates.
 */
function placeRefusal(s: LiveSwarm, b: NodeBinding, scope: WriteScope | null): string | null {
  const parked = state.isParked(b.agentId)
  if (!parked) {
    if (b.kind === 'orchestrator' && state.countFor(s.name, null, b.node) > 0) {
      return `another instance of ${b.node} is running; send to it instead`
    }
    if (b.kind === 'worker' && b.parent !== null) {
      const parent = state.binding(b.parent)
      const full = parentCountRefusal(s, b.parent, b.node, parent ? (nodeOf(s, parent.node)?.spawns?.[b.node] ?? 0) : 0)
      if (full) return full
    }
    const cap = capRefusal(s)
    if (cap) return cap
  }
  if (scope) {
    const above = parked ? delegatorsOf(b.agentId) : delegatorsOf(b.parent)
    if (parked) for (const d of state.descendantsOf(b.agentId)) above.add(d.agentId)
    const hit = scopeConflict(s.name, scope, above)
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
  if (why) return refuse(why)
  if (sender !== b.parent) {
    if (b.parent === null) return { kind: 'reply', parent: null }
    const parent = state.binding(b.parent)
    if (!parent) return refuse(`${labelOf(b)} was started by ${b.parent}, which isn't bound any more; send to its orchestrator`)
    return { kind: 'reply', parent }
  }
  const scope = instanceScope(s, b)
  const room = placeRefusal(s, b, scope)
  if (room) return refuse(room)
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
  if (why) return { ok: false, reason: why }
  // A send resuming it holds its place already.
  const held = state.reservations().find(r => r.agentId === b.agentId)
  if (held) {
    state.promote(held.key, b.agentId)
    return { ok: true, patch: false }
  }
  // Woken while settling (the engine's stranded-message resume, or a wake before the list shows it parked): it
  // keeps its place. Its policy is still admitted, but the patch removes the done/ its stop may have written: it
  // runs again (R2).
  if (state.status(b.agentId) === 'settling') {
    state.markRunning(b.agentId)
    return { ok: true, patch: true }
  }
  // Parked (WP-AJ): its children's results or its background work woke it. It's counted already, so no count
  // or cap can refuse it, nor take its place meanwhile; placeRefusal judges its scope alone, and markRunning
  // clears the mark.
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
  /** The message as its sender wrote it: what a readdress wraps. */
  raw: string
  /** The sending loop: an agentId, or null for the main loop. */
  sender: string | null
  /** `user`, `lead`, an agentId, or `plugin:<name>`, as swarm.event takes it. */
  from: string
  /** The sender in words, for the wrapper: `the user`, `the lead`, `fixer #2 (<agentId>)`. */
  label: string
  route: Route
}

type Deliver = (to: string, text: string) => Promise<SessionSendResult>
type Routed = { result: SessionSendResult; outcome: SendOutcome }

const refused = (reason: string): Routed => ({
  result: { isDelivered: false, reason: `litter: ${reason}` },
  outcome: { kind: 'refused', reason },
})

/** 15.4's wrapper for a message readdressed to the parent; to the lead for an orchestrator a node sent to. */
function wrapFor(b: NodeBinding, label: string, raw: string): string {
  const whose = b.kind === 'orchestrator' ? 'orchestrator' : b.kind === 'worker' ? 'worker' : 'agent'
  const how = b.parent === null ? 'Pass it on with mcp__litter__swarm_send, or answer it yourself.' : 'Pass it on with SendMessage, or answer it yourself.'
  return `For your ${whose} ${b.node} (${b.agentId}), from ${label}:\n\n${raw}\n\n${how}`
}

/** The text a node gets from the mod: yours as written; anyone else's with who it's from. */
const frame = (from: string, label: string, raw: string): string => (from === 'user' ? raw : `From ${label}:\n\n${raw}`)

/** One `message` event for a delivered send. */
function messageEvent(req: SendReq, to: NodeBinding, route: Route, text: string): SwarmEventBody {
  return { kind: 'message', node: to.node, agentId: to.agentId, from: req.from, to: to.agentId, route, delivery: 'interject', text: cut(text, EVENT_TEXT_MAX) }
}

/**
 * The node's turn is over when the list no longer shows it running: settle
 * or park it now (the hook's own check). Only `running`, not agentLive:
 * settling covers the engine still finalizing the task after turn.complete
 * (2.1.289's `running`), when a message would be resumed with no admission
 * (15.4, "A node that's settling is neither"). A `waiting` node is parked on
 * children or background work, completed to the engine, so a message resumes
 * it through admission, as in 2.1.288; holding it settling would make every
 * message to it wait out the settle. Parked, it keeps its place until it ends
 * (WP-AJ).
 */
async function settleIfDone(p: Ports, b: NodeBinding): Promise<void> {
  const row = (await p.listAgents()).find(a => a.id === b.agentId)
  await letGo(p, b, row?.status)
}

/** A settling node, by its row's status: running, it stays settling; `waiting`, it's parked; anything else, settled. */
async function letGo(p: Ports, b: NodeBinding, listed: AgentStatus | undefined): Promise<void> {
  if (listed === 'running' || state.status(b.agentId) !== 'settling') return
  if (listed === 'waiting') await park(p, b)
  else await finishSettle(p, b)
}

/**
 * Judges a send and carries it out with `deliver` (the hook's `next`, or the
 * mod's own `p.send`): delivered, resumed with a place, readdressed to the
 * parent, or refused. Each ends in at most one `deliver`. Its settle wait
 * spends `budget`, the dispatch's.
 */
async function routeSend(p: Ports, req: SendReq, deliver: Deliver, budget: WaitBudget, depth = 0): Promise<Routed> {
  const b = req.to
  const s = state.liveSwarm(b.swarm)
  const at = await p.now()
  let v = judge(b, req.sender, at)
  // Settling: wait for the list to let it go, then judge again (a $.clock wait spends the hook's budget:
  // 2 s at most, and never more than the dispatch has left).
  for (let waited = 0; v.kind === 'settling' && waited < SETTLE_WAIT_MS; waited += SETTLE_STEP_MS) {
    if ((await budget.left()) < SETTLE_STEP_MS) break
    await p.sleep(SETTLE_STEP_MS)
    await settleIfDone(p, b)
    v = judge(b, req.sender, await p.now())
  }
  if (v.kind === 'refuse') {
    await swarmEvent(p, s, { kind: 'send-refused', node: b.node, agentId: b.agentId, from: req.from, to: b.agentId, reason: v.reason })
    return refused(v.reason)
  }
  if (v.kind === 'reply') return replyRoute(p, s!, req, v.parent, deliver, budget, depth)
  if (v.kind === 'resume') return resumeNow(p, s!, req, v.key, deliver, at)
  // Running, or still finishing its turn after the wait: it goes now all the same. A finishing node's task finds
  // the message waiting as it ends and the engine resumes the node with it (2.1.293's stranded messages); that wake
  // is admitted at its first step (admitWake), keeping its place.
  const r = await deliver(b.agentId, req.text)
  if (!r.isDelivered) return { result: r, outcome: { kind: 'refused', reason: r.reason } }
  state.closeQuestion(b.agentId, at)
  await swarmEvent(p, s, messageEvent(req, b, req.route, req.text))
  return { result: r, outcome: { kind: 'delivered' } }
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
    return refused(`${labelOf(b)} couldn't be admitted: ${errText(err)}`)
  }
  let r: SessionSendResult
  try {
    r = await deliver(b.agentId, req.text)
  } catch (err) {
    await undo()
    return refused(`the send to ${labelOf(b)} failed: ${errText(err)}`)
  }
  if (!r.isDelivered) {
    await undo()
    await swarmEvent(p, s, { kind: 'resume-refused', node: b.node, agentId: b.agentId, from: req.from, reason: r.reason })
    return { result: r, outcome: { kind: 'refused', reason: r.reason } }
  }
  state.promote(key, b.agentId)
  state.closeQuestion(b.agentId, at)
  await swarmEvent(p, s, messageEvent(req, b, req.route, req.text))
  return { result: r, outcome: { kind: 'delivered' } }
}

const REPLY_WHY = "it has finished its turn, so its parent passes the message on and keeps its report"

/** The reply route (15.4): the message goes to the parent, wrapped, and through admission there in turn. */
async function replyRoute(p: Ports, s: LiveSwarm, req: SendReq, parent: NodeBinding | null, deliver: Deliver, budget: WaitBudget, depth: number): Promise<Routed> {
  const b = req.to
  const wrapped = wrapFor(b, req.label, req.raw)
  await swarmEvent(p, s, { kind: 'readdressed', node: b.node, agentId: b.agentId, from: req.from, to: b.agentId, parent: parent?.agentId ?? 'lead', why: REPLY_WHY })
  if (parent === null) {
    // A node's send to an orchestrator that finished: the lead passes it on, so the orchestrator stays the lead's.
    const r = await deliver('main', wrapped)
    return r.isDelivered
      ? { result: r, outcome: { kind: 'readdressed', to: 'main', parentNode: 'the lead', why: REPLY_WHY } }
      : { result: r, outcome: { kind: 'refused', reason: r.reason } }
  }
  if (depth >= 8) return refused(`${labelOf(b)}'s parents form a loop`)
  const up = await routeSend(p, { ...req, to: parent, text: wrapped, raw: wrapped, route: 'reply' }, deliver, budget, depth + 1)
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

/** An id the hooks name a file by (lib.sh's lt_id_ok). */
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/

/**
 * The swarm of an agent the mod no longer binds whose policy file is still
 * there, when that swarm isn't live: End keeps a running agent's file, so
 * the guard denies it, and admission refuses it too, or a later send or a
 * late child's wake would resume an old node with nothing admitting it.
 * Null for an agent with no such file, the mod never knew, or of a launch
 * still live. A file that doesn't read is refused as the guard denies it.
 * A former node resumed after the sweep removed its file is still denied by
 * the guard (a `litter:sw-*` type with no binding); a former child resumed
 * then is a plain subagent.
 */
async function endedSwarmOf(p: Ports, agentId: string): Promise<string | null> {
  const dir = session().litterDir
  if (!dir || !AGENT_ID.test(agentId)) return null
  const path = agentPolicyPath(dir, agentId)
  if (!(await p.fs.exists(path))) return null
  let node: AgentPolicy['node']
  try {
    node = (await readJson<AgentPolicy>(p, path))?.node
  } catch {
    return 'an unknown swarm (its policy file is unreadable)'
  }
  if (!node || typeof node.swarm !== 'string') return null
  return state.liveSwarm(node.swarm)?.launch === node.launch ? null : node.swarm
}

/** A send to an agent of an ended swarm: refused, naming it; null for any other recipient. */
async function endedRefusal(p: Ports, to: string): Promise<SessionSendResult | null> {
  const dir = session().litterDir
  if (isMain(to) || !dir || !(await p.fs.exists(`${hooksDir(dir)}/agents`))) return null
  const refusal = (swarm: string, id: string): SessionSendResult => ({
    isDelivered: false,
    reason: `litter: swarm ${swarm} has ended: ${id} was one of its agents, and takes no more messages`,
  })
  const id = to.trim()
  const direct = await endedSwarmOf(p, id)
  if (direct !== null) return refusal(direct, id)
  // By name, or a received `from` address, as resolveTo takes them.
  const addr = FROM_ADDRESS.exec(id)
  const name = addr ? addr[1]! : id
  for (const a of await p.listAgents()) {
    if (a.id === id || !(a.name === name || (addr !== null && a.id.includes(addr[2]!)))) continue
    const swarm = await endedSwarmOf(p, a.id)
    if (swarm !== null) return refusal(swarm, a.id)
  }
  return null
}

/** Who sent, for the event and the wrapper. */
function senderOf(e: Parameters<PortHook<SessionSendHook>>[1], fromB: NodeBinding | null): { from: string; label: string } {
  if (e.agentId !== undefined) return { from: e.agentId, label: fromB ? labelOf(fromB) : `agent ${e.agentId}` }
  if (e.origin.kind === 'model') return { from: 'lead', label: 'the lead' }
  return { from: `plugin:${e.origin.name}`, label: `the ${e.origin.name} plugin` }
}

/** A line that ends asking: its last `?` closes it, closing quotes, brackets and emphasis aside. */
const ASKS = /\?[\s"'`*_)\]]*$/

/**
 * The first line of a message that asks something: the node's question
 * (WP-L's reading of "open questions"). A line asks when it ends with its
 * `?`: one with words after it ("does the child start it? No. The role
 * override…") answered itself (the user's live look, 2026-10-07).
 */
export function questionIn(text: string): string | null {
  const line = text.split('\n').map(l => l.trim()).find(l => ASKS.test(l))
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
  // Its newer message stands for it: a question it asked before is closed, and this one's, if it asks, opens.
  state.closeQuestion(b.agentId, at)
  const q = questionIn(text)
  // Where it went (WP-DG: "How do I know who I need to reply to?"): the lead, or the parent node, which the browser names.
  const to = toLead || b.parent === null ? 'lead' : (state.binding(b.parent)?.node ?? b.parent)
  if (q && state.noteQuestion(b.agentId, q, at, to)) await swarmEvent(p, s, { kind: 'question', node: b.node, agentId: b.agentId, text: q, to })
}

/**
 * session.send: every SendMessage and every plugin's send. A send to no node
 * from no node passes unchanged; a node's send while its swarm is ending
 * passes only to its parent; a send to a node goes through routeSend.
 */
export const admitSend: PortHook<SessionSendHook> = async (p, e, next) => {
  if (e.origin.kind === 'plugin' && ownSends.has(ownKey(e.to, e.text))) return next(e)
  const budget = await waitBudget(p, next)
  await state.ready(p, await budget.left())
  // A send to no node passes, but not to an agent of a swarm that has ended (its file is still there).
  if (state.liveSwarms().length === 0) return (await endedRefusal(p, e.to)) ?? next(e)
  const sender = e.agentId ?? null
  const fromB = sender !== null ? state.binding(sender) : null
  const toB = await resolveTo(p, e.to)
  if (toB === 'ambiguous') {
    return { isDelivered: false, reason: `litter: '${e.to}' could name more than one agent, a swarm node among them; address it by its agent id` }
  }
  if (!toB && !fromB) return (await endedRefusal(p, e.to)) ?? next(e)
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
    // A node's SendMessage to `main` (and its hand-back, which never comes through here) is the
    // engine's own message, shown to the lead as the agent's: litter passes its text as it is,
    // and neutralises only the texts it writes itself (`unblock`).
    const ended = await endedRefusal(p, e.to)
    if (ended) return ended
    const r = await next(e)
    if (fromB && r.isDelivered) await noteFromNode(p, fromB, toLead, false, e.text)
    return r
  }
  const who = senderOf(e, fromB)
  const routed = await routeSend(
    p,
    { to: toB, text: e.text, raw: e.text, sender, from: who.from, label: who.label, route: 'direct' },
    (to, text) => next({ ...e, to, text }),
    budget,
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
  await state.ready(p, await (await waitBudget(p, next)).left())
  const refusal = async function* (reason: string) {
    const answer = `litter: not admitted: ${reason}; ending this turn`
    yield { kind: 'text' as const, index: 0, text: answer }
    yield { kind: 'stop' as const, stopReason: 'end_turn' as const, usage: null }
    return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn' as const, usage: null }
  }
  const b = state.binding(id)
  if (!b) {
    // An agent of a swarm that has ended (End kept its file): a later send or a late child's wake resumes nothing.
    const ended = await endedSwarmOf(p, id)
    return ended === null ? yield* next(e) : yield* refusal(`swarm ${ended} has ended`)
  }
  if (state.isRefusedTurn(id, e.turnId)) return yield* refusal(NOT_ADMITTED_LATER)
  // An admitted step's usage counts at once, so the browser's tokens move mid-turn (turn.complete settles them).
  // It goes with the model and effort you set for the node (WP-DI), and the browser shows what it named.
  const counted = async function* () {
    const s = tunedStep(b, e)
    state.noteStepModel(id, s.model, s.effort ?? null, await p.now())
    const r = yield* next(s)
    state.addStep(id, e.turnId, r?.usage)
    return r
  }
  if (state.status(id) === 'running') return yield* counted()
  const wake = admitWake(b)
  if (!wake.ok) {
    state.refuseTurn(id, e.turnId)
    // A parked node recovery or adoption admitted keeps no mark through a refused turn. Queued before any
    // await, so a resume that admits it later is written later.
    const cleared = ownSwarm(b.swarm) ? unadmit(p, b, 'after its wake was refused') : null
    await swarmEvent(p, state.liveSwarm(b.swarm), { kind: 'wake-refused', node: b.node, agentId: id, turnId: e.turnId, reason: wake.reason })
    await cleared
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
  return yield* counted()
}

// ---------------------------------------------------------------------------
// A node's model and effort (WP-DI)

/**
 * A node's step as it goes: the model and effort you set for it, and
 * otherwise its spec's effort, which then holds against an Agent call's own
 * (2.1.292 gave the Agent tool an effort). A child keeps whatever it runs
 * with, unless you set it. The engine drops an effort for a model that takes
 * none, and holds `max` and `xhigh` to `high` where the model has no such level.
 */
export function tunedStep(b: NodeBinding, e: Parameters<TurnStepHook>[1]): Parameters<TurnStepHook>[1] {
  const set = state.tunedModel(b.agentId)
  const specEffort = b.kind === 'child' ? undefined : state.liveSwarm(b.swarm)?.spec.nodes.find(n => n.id === b.node)?.effort
  const model = set?.model
  const effort = set?.effort ?? specEffort
  const newModel = model !== undefined && model !== e.model
  const newEffort = effort !== undefined && effort !== e.effort
  if (!newModel && !newEffort) return e
  return { ...e, ...(newModel ? { model } : {}), ...(newEffort ? { effort } : {}) }
}

/** The models the browser offers beside the ones nodes ran with: full ids, since turn.step resolves no alias (`haiku`). */
export const MODEL_CHOICES: readonly string[] = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001']

/** How long the check of a model nothing here has run with may take. */
export const MODEL_CHECK_MS = 15_000

/** What a tune answers: what changed, from when, or why nothing did. */
export type TuneOutcome = { ok: true; text: string } | { ok: false; reason: string }

/**
 * The browser's Model and Effort for a node (N, from ui.message): `model` or
 * `effort` set, or null for what it runs with. A model no request here has
 * named yet is checked first with a short completion, so a node isn't moved
 * to one the provider doesn't serve. It applies from the node's next request;
 * a new model reads the conversation again, without the cache. Picking what
 * it has already changes and records nothing.
 */
export async function tuneNode(
  p: Ports,
  input: { swarm: string; agentId: string; model?: string | null; effort?: Effort | null },
): Promise<TuneOutcome> {
  const s = state.liveSwarm(input.swarm)
  const off = swarmRefusal(s, input.swarm, false)
  if (off) return { ok: false, reason: off }
  const b = state.binding(input.agentId)
  if (!b || b.swarm !== input.swarm) return { ok: false, reason: `${input.agentId} isn't a node of swarm ${input.swarm}` }
  const who = b.kind === 'child' ? `the agent ${b.node} started` : instanceName(b)
  const was = state.tunedModel(b.agentId)
  if (input.model !== undefined && (input.model?.trim() ?? null) === (was?.model ?? null)) return { ok: true, text: `${who} has that model already` }
  if (input.model === undefined && input.effort !== undefined && input.effort === (was?.effort ?? null)) return { ok: true, text: `${who} has that effort already` }
  if (input.model !== undefined && input.model !== null) {
    const model = input.model.trim()
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*(\[[0-9a-z]+\])?$/.test(model) || !model.includes('-'))
      return { ok: false, reason: `${cut(oneLine(model), 80)} isn't a model id (a full one, such as claude-sonnet-5-5)` }
    if (!state.modelsSeen().includes(model)) {
      const bad = await modelCheck(p, model)
      if (bad) return { ok: false, reason: `${model} wasn't set: ${bad}` }
    }
    state.tuneModel(b.agentId, { model })
    await swarmEvent(p, s, { kind: 'tuned', node: b.node, agentId: b.agentId, model })
    return { ok: true, text: `${who} uses ${model} from its next request; it reads its conversation again, without the cache` }
  }
  if (input.model === null) {
    state.tuneModel(b.agentId, { model: null })
    await swarmEvent(p, s, { kind: 'tuned', node: b.node, agentId: b.agentId, model: null })
    return { ok: true, text: `${who} goes back to the model it was launched with, from its next request` }
  }
  if (input.effort !== undefined) {
    state.tuneModel(b.agentId, { effort: input.effort })
    await swarmEvent(p, s, { kind: 'tuned', node: b.node, agentId: b.agentId, effort: input.effort })
    return {
      ok: true,
      text: input.effort === null ? `${who} goes back to the effort it was launched with, from its next request` : `${who} thinks at ${input.effort} from its next request`,
    }
  }
  return { ok: false, reason: 'nothing to change' }
}

/** Why a model can't be used, from a one-token completion; null when it answered. */
async function modelCheck(p: Ports, model: string): Promise<string | null> {
  try {
    const r = await p.complete({ model, prompt: 'Reply with the word OK.', maxTokens: 8, timeoutMs: MODEL_CHECK_MS })
    if (r.isAnswered || r.reason === 'empty-reply') return null
    if (r.reason === 'aborted') return `the check didn't finish in ${MODEL_CHECK_MS / 1000} s; try again`
    return `the provider refused it (${r.error}${r.status === null ? '' : `, status ${r.status}`})`
  } catch (err) {
    return cut(oneLine(errText(err)), 200)
  }
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

/**
 * Clears a node's admitted mark. The patch is queued in the caller's
 * synchronous step, and each policy file's writes run in the order they're
 * queued (guard.ts), so an admission that comes later is written later.
 * Never rejects.
 */
function unadmit(p: Ports, b: NodeBinding, when: string): Promise<void> {
  const dir = session().litterDir
  if (!dir) return Promise.resolve()
  return patchNodePolicy(p, dir, b.agentId, { admitted: false }).catch(err => p.log(`${labelOf(b)}: its policy kept admitted ${when}: ${errText(err)}`))
}

/** Settled: its place is free and its policy no longer admitted. */
async function finishSettle(p: Ports, b: NodeBinding): Promise<void> {
  state.markSettled(b.agentId)
  await unadmit(p, b, 'after it settled')
}

/**
 * Parked (WP-AJ): its turn is over, as a settle's, so its policy is no
 * longer admitted, but it keeps its place until the list shows it ended, and
 * its wake is admitted on that place.
 */
async function park(p: Ports, b: NodeBinding): Promise<void> {
  state.markParked(b.agentId)
  await unadmit(p, b, 'after it parked')
}

/**
 * A parked node the list shows ended: its place frees, as a settle's does,
 * in one synchronous step. Its admitted mark goes too, since recovery and
 * adoption may have admitted it while it was parked; the patch is queued in
 * that step, so a resume or a wake that admits it later is written later.
 */
function unpark(p: Ports, b: NodeBinding): Promise<void> {
  state.markSettled(b.agentId)
  return unadmit(p, b, 'after it ended')
}

/**
 * A swarm this session runs. A read-only swarm's table is its owner's copy,
 * and a lost one's another session's now: the poll settles, parks and frees
 * none of their nodes, and nothing here writes their policies.
 */
function ownSwarm(name: string): boolean {
  const s = state.liveSwarm(name)
  return s !== null && !s.readOnly && !s.lost
}

/** The bindings of swarms this session runs. */
function ownBindings(): NodeBinding[] {
  return state.bindings().filter(b => ownSwarm(b.swarm))
}

function hasWork(): boolean {
  return ownBindings().some(b => state.status(b.agentId) === 'settling' || state.isParked(b.agentId))
}

/** Starts the settle poll when something settles or is parked. */
function kick(p: Ports): void {
  if (poll || !hasWork()) return
  poll = p.every(SETTLE_POLL_MS, () => settleTick(p))
}

async function settleTick(p: Ports): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const own = ownBindings()
    const settling = own.filter(b => state.status(b.agentId) === 'settling')
    const parked = own.filter(b => state.isParked(b.agentId))
    if (settling.length > 0 || parked.length > 0) {
      const listed = await p.listAgents()
      // A parked node goes once the list shows it ended (completed, failed or killed) or gone; alive, it stays.
      // Checked again after the list's await, a resume or a wake may have taken it meanwhile, and before the
      // settles' awaits, so the row is no older than that. A resume in flight holds it, and the admitted mark
      // its send wrote stays.
      const freed: Promise<void>[] = []
      for (const b of parked) {
        const row = listed.find(a => a.id === b.agentId)
        if ((row === undefined || !agentLive(row.status)) && state.isParked(b.agentId) && !resuming(b.agentId)) freed.push(unpark(p, b))
      }
      // Only `running` holds a settle, not `waiting`, which parks it (settleIfDone says why).
      for (const b of settling) await letGo(p, b, listed.find(a => a.id === b.agentId)?.status)
      await Promise.all(freed)
    }
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

// ---------------------------------------------------------------------------
// mcp__litter__swarm_send and the browser

const NODE_REF = /^([a-z0-9][a-z0-9-]{0,31})(?:#([1-9][0-9]{0,5}))?$/

const latest = (list: readonly NodeBinding[]): NodeBinding | null =>
  list.reduce<NodeBinding | null>((a, b) => (a === null || b.boundAt >= a.boundAt ? b : a), null)

const statusWord = (b: NodeBinding): string => (state.isStopped(b.agentId) ? 'stopped' : state.isParked(b.agentId) ? 'parked' : state.status(b.agentId))

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
  // A parked instance is mid-task, waiting on its own agents: active, though between turns.
  const active = open.filter(b => state.status(b.agentId) !== 'idle' || state.isParked(b.agentId))
  const pick = active.length > 0 ? active : open
  if (pick.length === 1) return { b: pick[0]!, s }
  return { error: `${id} has ${all.length} instances: ${list(all)}; name one as ${id}#<n>`, field: 'node' }
}

/** tool.call on `mcp__litter__swarm_send`, after register.tsx's drain: answered here, never passed on. */
export const swarmSendTool: PortHook<SwarmSendHook> = async (p, e, next) => {
  const reply = await swarmSend(p, e.agentId, decodeSwarmInput(SWARM_SEND, e as unknown as Record<string, unknown>), await waitBudget(p, next))
  return { result: JSON.stringify(reply) }
}

async function swarmSend(p: Ports, agentId: string | undefined, input: Record<string, unknown>, budget: WaitBudget): Promise<SwarmSendReply> {
  if (agentId !== undefined) return { ok: false, error: "litter: mcp__litter__swarm_send is the lead's alone; a node sends with SendMessage" }
  await state.ready(p, await budget.left())
  if (!session().litterDir) return { ok: false, error: 'litter: this session has no litter directory, so no swarm is live in it' }
  kick(p)
  // An older litter asked the lead to deliver held messages by id; it holds none now.
  if (input.queued !== undefined) return { ok: false, error: "litter: litter no longer holds messages to send later, so there's nothing queued to deliver; send the text with 'node' and it goes now" }
  const found = findInstance(input.swarm, input.node)
  if ('error' in found) return { ok: false, error: `litter: ${found.error}` }
  const text = input.text
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, error: "litter: 'text' is required: the message for the node" }
  const { b } = found
  const routed = await routeSend(
    p,
    { to: b, text: frame('lead', 'the lead', text), raw: text, sender: null, from: 'lead', label: 'the lead', route: 'direct' },
    (to, t) => sendOwn(p, to, t),
    budget,
  )
  const o = routed.outcome
  if (o.kind === 'refused') return { ok: false, error: `litter: ${o.reason}`, outcome: o }
  return { ok: true, node: instanceName(b), agentId: b.agentId, outcome: o }
}

/**
 * What the lead gets for a message you route through it (15.4, "Via lead").
 * Your text is neutralised, so it can't close the `<message>` block and go on
 * as litter's own words.
 */
function viaLeadText(s: LiveSwarm, b: NodeBinding, text: string): string {
  return [
    `litter: the user sent this from the swarm browser for ${instanceName(b)} in swarm ${s.name}, through you, to deliver now (a running node reads it at its next step).`,
    `Check it against what you know, add any context the node needs, then send it with mcp__litter__swarm_send (swarm "${s.name}", node "${instanceName(b)}"), and tell the user in a line what you added. If it shouldn't go as written, don't send it: tell the user why, and ask.`,
    '',
    '<message>',
    unblock(text),
    '</message>',
  ].join('\n')
}

/** A direct message from you, for the lead's next `<swarm>` block (15.4, "Direct skips the lead"). */
function noteDirectSend(b: NodeBinding, text: string, o: SendOutcome): void {
  if (o.kind === 'refused') return
  state.noteDirect(b.swarm, renderSlots(SWARM_CONTEXT_DIRECT, { node: instanceName(b), text: unblock(oneLine(text)) }))
}

/**
 * The browser's composer (N, from ui.message): direct, via the lead, or via
 * the parent (15.4's table). Direct and via-parent sends go now, from this
 * dispatch; a send to an idle worker takes the reply route. Via the lead, the
 * text is a row the busy lead reads now, or a prompt of its own, submitted
 * from a timer callback. `budget` is the ui.message dispatch's (waitBudget
 * over its next); without one, the hook's 10 s from this call.
 */
export async function sendFromBrowser(p: Ports, input: BrowserSend, budget?: WaitBudget): Promise<SendOutcome> {
  const wait = budget ?? (await waitBudget(p))
  await state.ready(p, await wait.left())
  const s0 = state.liveSwarm(input.swarm)
  const off = swarmRefusal(s0, input.swarm, false)
  if (off) return { kind: 'refused', reason: off }
  const found = findInstance(input.swarm, input.node)
  if ('error' in found) return { kind: 'refused', reason: found.error }
  const { b, s } = found
  if (typeof input.text !== 'string' || input.text.trim() === '') return { kind: 'refused', reason: 'the message is empty' }
  kick(p)
  const text = input.text
  if (input.route === 'lead') {
    const row = viaLeadText(s, b, text)
    if (state.leadBusy()) {
      try {
        await p.appendUserRow(row)
      } catch (err) {
        return { kind: 'refused', reason: `the lead's conversation didn't take it: ${errText(err)}` }
      }
    } else {
      // From a timer callback, outside this dispatch, and never awaited here (15.9, item 19).
      p.after(0, () => p.submitPrompt(row).catch((err: unknown) => p.log(`a message for ${instanceName(b)} via the lead wasn't submitted: ${errText(err)}`)))
    }
    await swarmEvent(p, s, { kind: 'message', node: b.node, agentId: b.agentId, from: 'user', to: 'lead', route: 'lead', delivery: 'interject', text: cut(text, EVENT_TEXT_MAX) })
    return { kind: 'delivered' }
  }
  let to = b
  let raw = text
  let route: Route = 'direct'
  if (input.route === 'parent') {
    const parent = b.parent === null ? null : state.binding(b.parent)
    if (!parent) return { kind: 'refused', reason: `${instanceName(b)} has no parent node to route through; send it directly or via the lead` }
    to = parent
    raw = wrapFor(b, 'the user', text)
    route = 'parent'
  }
  const routed = await routeSend(p, { to, text: raw, raw, sender: null, from: 'user', label: 'the user', route }, (t, x) => sendOwn(p, t, x), wait)
  const o = routed.outcome
  noteDirectSend(b, text, o)
  if (o.kind === 'readdressed' && input.route === 'direct') return { ...o, why: "via parent (it's idle)" }
  return o
}

/** [Dismiss] on a node's open question: closed, for one it answered itself or no longer waits on. How many closed. */
export async function dismissQuestion(p: Ports, swarm: string, agentId: string): Promise<number> {
  if (!state.openQuestions(swarm).some(q => q.agentId === agentId)) return 0
  return state.closeQuestion(agentId, await p.now())
}

// ---------------------------------------------------------------------------
// The lead's <swarm> block

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** Spacing a model may read past inside a tag: whitespace, zero-widths and the word joiners. */
const TAG_GAP = '[\\s\\u200b-\\u200f\\u2060-\\u2064\\ufeff]*'
const TAG_LIKE = new RegExp(`<${TAG_GAP}(/?)${TAG_GAP}(swarm|message)`, 'gi')

/**
 * The one neutraliser for node, user and spool text in a lead-facing text
 * (the `<swarm>` block, its direct-message and kill lines, the via-lead
 * hand-off): every `<swarm`, `</swarm`, `<message` and `</message`, in any
 * case and spacing, becomes `[swarm`, `[/swarm`, `[message` or `[/message`,
 * so the text can't open or close a block litter wraps around it.
 */
export function unblock(text: string): string {
  return text.replace(TAG_LIKE, (_m, slash: string, word: string) => `[${slash}${word.toLowerCase()}`)
}

/** A line of node text for the block: its first line, cut, unable to open or close a block. */
function firstLine(text: string): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l !== '') ?? ''
  return cut(unblock(oneLine(line)), CONTEXT_LINE_MAX)
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

function blockLines(s: LiveSwarm, why: ClearReason | null, kills: readonly ClearKill[], first: boolean): Line[] {
  const cleared = why !== null
  const out: Line[] = [{ text: renderSlots(SWARM_CONTEXT_OPEN, { swarm: s.name, status: s.state }), keep: KEEP, at: 0 }]
  if (cleared) out.push({ text: renderSlots(why === 'clear' ? SWARM_CONTEXT_CLEARED : SWARM_CONTEXT_MOVED, { swarm: s.name }), keep: KEEP, at: 0 })
  for (const k of kills) {
    const mine = state.binding(k.agentId)?.swarm
    if (mine === s.name || (mine === undefined && first)) {
      // `who` and `tool` come from the clear's table, filled from the spool: one line each, neutralised.
      const tool = firstLine(k.tool)
      out.push({ text: renderSlots(SWARM_CONTEXT_CLEAR_KILLED, { who: firstLine(k.who), call: k.detail ? `${tool} (${firstLine(k.detail)})` : tool }), keep: P_KILL, at: 0 })
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
  for (const d of state.takeDirect(s.name)) out.push({ text: cut(unblock(oneLine(d)), 300), keep: P_DIRECT, at: 0 })
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
  const why = state.takeCleared()
  const kills = why !== null ? state.takeClearKills() : []
  const lines = fit(live.flatMap((s, i) => blockLines(s, why, kills, i === 0)))
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

/**
 * Binds an agent to its recorded instance: `swarm.node { adopted: true }`,
 * the binding, its place (`as`: running, parked or none), and the policy,
 * admitted when it holds a place. A parked one's is admitted too: adoption
 * has no copy to tell a `waiting` agent mid-turn on a foreground child,
 * whose response may still have a call to run with no step between, from one
 * whose turn is over, which makes no call before its next step, and that
 * step runs admission.
 */
async function adopt(p: Ports, dir: string, s: LiveSwarm, inst: SwarmInstanceBody, agentId: string, as: 'running' | 'parked' | 'idle'): Promise<NodeBinding> {
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
  const scope = node ? scopeOf(node, inst.cwd) : null
  if (as === 'running') state.markRunning(agentId, scope)
  else if (as === 'parked') state.markParked(agentId, scope)
  await writeNodePolicy(p, dir, agentId, nodePolicyFor(b, s, { admitted: as !== 'idle', stopped: null, bind: false }))
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
        // Alive holds a place. `waiting` is parked (WP-AJ), as recovery marks one with no copy to say it was
        // mid-turn: its next step is admitted on that place, whether it's a wake or, mid-turn on a foreground
        // child, the step after the child returns.
        const as = a.status === 'waiting' ? 'parked' : agentLive(a.status) ? 'running' : 'idle'
        if (fits.length === 1 && rivals.length === 1) await adopt(p, dir, s, fits[0]!, a.id, as)
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
    await adopt(p, dir, s, inst, agentId, 'running')
    return { ok: true, node: inst.node, n: inst.n, cwd: inst.cwd, branch: inst.branch }
  } finally {
    claiming.delete(token)
  }
}
