// WP-O: /clear, for runs and swarms alike (15.4, "After /clear" and "Litter
// holds /clear while anything is running"): the hold with its ask, the
// rebind flag at session.end, the rebind on the first hook after it (roles,
// tools, types, commands, policy.json's session, the ownership swap,
// session.rebind, the panes, the cleared mark), and the swarm timers.
//
// A /clear isn't a restart: no session.start fires, the module and its
// memory live on, the session id changes, and every background agent keeps
// running, but their foreground commands are killed and $.state is wiped.
// So the hold asks before a clear that would kill something, and the rebind
// moves what names the session to the new id. Nothing is resumed or
// re-spawned (15.4, step 3).

import type { ListedAgent, Ports } from './ports'
import type { CommandRunHook, PortHook, SessionEndHook } from './hooktypes'
import type { Policy } from './hookfiles'
import type { ClearKill, ClearReason, InflightCall, LiveSwarm, NodeBinding } from './swarm/types'
import { session, updateSession } from './session'
import { agentInfo, readPolicy, roleOf, updatePolicy } from './policy'
import { registerRecordTool } from './ledger'
import { registerRoles } from './roles'
import { rebindRun } from './lifecycle'
import { appendLaunchRecord } from './records/swarm'
import { registerSwarmTools } from './swarm/tools'
import { nodeTypeSpec } from './swarm/launch'
import { briefTextFor } from './swarm/store'
import { registerSwarmCommands, refreshPanes } from './swarm/panes'
import { refreshBoard, registerPhase3Commands } from './board/pane'
import { patchSwarmPolicy } from './swarm/guard'
import { ownedSwarm, rebindOwnership, startOwnerBeat, stopOwnerBeat } from './swarm/owner'
import { refreshReadOnly, typesAccepted } from './swarm/recover'
import { summaryTick } from './swarm/summary'
import { DETAIL_MAX_BYTES, spoolLine, TOOL_MAX_BYTES } from './swarm/observe'
import {
  attach,
  binding,
  closeGate,
  clearRebind,
  inflight,
  liveSwarm,
  liveSwarms,
  markCleared,
  noteClearKills,
  openGate,
  patchLiveSwarm,
  ready,
  rebindPending,
  recordedSession,
  setRebindPending,
  setRecordedSession,
  swarmOfType,
} from './swarm/state'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Cancel's answer, and the hold's where nobody can answer the ask (15.4). */
export const CLEAR_HELD = "litter: /clear held; the swarm browser shows when they're idle"
export const CLEAR_OPTIONS = ['Cancel', 'Clear anyway'] as const
/** The swarm timers' tick: a changed session id starts the rebind, and the summary runs from it. */
export const TICK_MS = 2000

/**
 * What the rebind and the hold call in other packages (K, N, M, J), through
 * one table so tier 2 can check what they're called with while their bodies
 * are stubs. Each entry reads its import when called, never at import time
 * (the modules import each other in a cycle).
 */
export const others = {
  nodeTypeSpec: (...a: Parameters<typeof nodeTypeSpec>) => nodeTypeSpec(...a),
  briefTextFor: (...a: Parameters<typeof briefTextFor>) => briefTextFor(...a),
  registerSwarmCommands: (p: Ports) => registerSwarmCommands(p),
  refreshPanes: (p: Ports) => refreshPanes(p),
  patchSwarmPolicy: (...a: Parameters<typeof patchSwarmPolicy>) => patchSwarmPolicy(...a),
  rebindOwnership: (...a: Parameters<typeof rebindOwnership>) => rebindOwnership(...a),
  startOwnerBeat: (...a: Parameters<typeof startOwnerBeat>) => startOwnerBeat(...a),
  stopOwnerBeat: (name?: string) => stopOwnerBeat(name),
  ownedSwarm: (...a: Parameters<typeof ownedSwarm>) => ownedSwarm(...a),
  typesAccepted: (...a: Parameters<typeof typesAccepted>) => typesAccepted(...a),
  refreshReadOnly: (...a: Parameters<typeof refreshReadOnly>) => refreshReadOnly(...a),
  // Phase 3 (AF): /litter-board and /litter-rules, and the board's view.
  registerPhase3Commands: (p: Ports) => registerPhase3Commands(p),
  refreshBoard: (p: Ports) => refreshBoard(p),
}
const defaults = { ...others }

// ---------------------------------------------------------------------------
// The hold (15.4, "Litter holds /clear while anything is running")

/** One agent of a live swarm or the active run that a clear would cut short. */
type Running = { agentId: string; who: string; swarm: string | null; node: string | null; calls: InflightCall[] }

/** Swarms whose agents run in this process: owned ones, lost ones too (their nodes may still run here). */
const ownSwarms = (): LiveSwarm[] => liveSwarms().filter(s => !s.readOnly)

/** A node's name and instance, `fixer #2 under part-b`; a child is named by its node. */
function nodeName(b: NodeBinding, depth = 0): string {
  if (b.kind === 'child') {
    const of = b.of === null ? null : binding(b.of)
    return of && depth < 8 ? `a child of ${nodeName(of, depth + 1)}` : `a child of ${b.node}`
  }
  if (b.kind === 'orchestrator') return b.n > 1 ? `${b.node} #${b.n}` : b.node
  const parent = b.parent === null ? null : binding(b.parent)
  return `${b.node} #${b.n} under ${parent ? nodeName(parent, depth + 1) : 'the lead'}`
}

/** A run agent's role and run, from the agent map (policy.ts), or the listed type's role. */
async function runAgentName(p: Ports, agentId: string, type: string | null, run: string | null): Promise<string> {
  const info = await agentInfo(p, agentId).catch(() => undefined)
  const role = info?.role ?? (type !== null ? roleOf(type) : null)
  if (role === null) return `agent ${agentId}`
  const of = info?.run ?? run
  return of ? `${role} in run ${of}` : role
}

/**
 * Every open call of a node, a node's child or a run agent (the in-flight
 * table, filled from guard.sh's `call` lines), and every such agent the
 * list shows running, each agent once with its calls. A call of an agent the
 * list shows finished is left out: the clear has nothing of it to kill. A
 * workflow's agents aren't in the list (d.ts, AgentLoop), so a run's are
 * known by their calls.
 */
async function whatRuns(p: Ports, run: string | null): Promise<Running[]> {
  const owned = new Set(ownSwarms().map(s => s.name))
  const listed = new Map((await p.listAgents()).map((a: ListedAgent) => [a.id, a]))
  const out = new Map<string, Running>()
  /** `swarm` is the call's swarm, or null; `a` the listed agent, when it's one. */
  const entry = async (agentId: string, swarm: string | null, a: ListedAgent | null): Promise<Running | null> => {
    const known = out.get(agentId)
    if (known) return known
    const b = binding(agentId)
    const typed = a ? swarmOfType(a.type) : null
    const parent = a?.parentId !== undefined ? binding(a.parentId) : null
    let r: Running | null = null
    if (b) {
      if (owned.has(b.swarm)) r = { agentId, who: nodeName(b), swarm: b.swarm, node: b.node, calls: [] }
    } else if (swarm !== null) {
      r = { agentId, who: `agent ${agentId} of swarm ${swarm}`, swarm, node: null, calls: [] }
    } else if (typed && owned.has(typed.swarm)) {
      // A node not bound yet (its spawn still in flight, or waiting to bind after a reload).
      r = { agentId, who: `${typed.node} (not bound yet)`, swarm: typed.swarm, node: typed.node, calls: [] }
    } else if (parent && owned.has(parent.swarm)) {
      r = { agentId, who: `a child of ${nodeName(parent)} (not bound yet)`, swarm: parent.swarm, node: parent.node, calls: [] }
    } else if (run !== null && (a === null || roleOf(a.type) !== null)) {
      r = { agentId, who: await runAgentName(p, agentId, a?.type ?? null, run), swarm: null, node: null, calls: [] }
    }
    if (r) out.set(agentId, r)
    return r
  }
  for (const c of inflight()) {
    // A call with no swarm is a run agent's: guard.sh spools calls only for nodes, their children and run agents.
    if (c.swarm !== null ? !owned.has(c.swarm) : run === null) continue
    const a = listed.get(c.agentId) ?? null
    if (a && a.status !== 'running') continue
    const r = await entry(c.agentId, c.swarm, a)
    r?.calls.push(c)
  }
  for (const a of listed.values()) if (a.status === 'running') await entry(a.id, null, a)
  return [...out.values()]
}

const age = (ms: number): string => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`)

/**
 * The ask's text: each agent with its open calls and how long each has run
 * (15.4). `$.ui.ask` wants a question mark at the end. A call's tool and
 * detail come from the spool, which any writer to hooks/spool/ can append
 * to: they're cleaned again here, one line each, whatever the table holds.
 */
function holdQuestion(running: readonly Running[], now: number): string {
  const call = (c: InflightCall): string => {
    const tool = spoolLine(c.tool, TOOL_MAX_BYTES)
    const detail = spoolLine(c.detail ?? '', DETAIL_MAX_BYTES)
    return detail ? `${tool} (${detail})` : tool
  }
  const rows = running.map(r =>
    r.calls.length === 0
      ? `- ${spoolLine(r.who, DETAIL_MAX_BYTES)}: running, between commands`
      : `- ${spoolLine(r.who, DETAIL_MAX_BYTES)}: ${r.calls.map(c => `${call(c)}, running for ${age(now - c.at)}`).join('; ')}`,
  )
  return `/clear stops these commands halfway (their shells are killed):\n${rows.join('\n')}\nClear anyway?`
}

/** command.run on `clear`, after register.tsx's drain: holds it while anything runs, or passes it on. */
export const holdClear: PortHook<CommandRunHook> = async (p, e, next) => {
  const litterDir = session().litterDir
  const swarms = ownSwarms()
  const run = litterDir ? ((await readPolicy(p, litterDir))?.run?.run ?? null) : null
  if (swarms.length === 0 && run === null) return passClear(e, next)
  const running = await whatRuns(p, run)
  if (running.length === 0) return passClear(e, next)
  let answer: string | null = null
  try {
    answer = await p.ask(holdQuestion(running, await p.now()), { options: CLEAR_OPTIONS, header: 'litter' })
  } catch (err) {
    // Nobody can answer (-p, an SDK host) or the ask was dismissed: the clear stays held.
    p.log(`/clear held: the ask got no answer (${errText(err)})`)
  }
  if (answer !== 'Clear anyway') return { text: CLEAR_HELD }
  const kills: (ClearKill & { swarm: string | null; node: string | null })[] = running.flatMap(r =>
    r.calls.map(c => ({ agentId: r.agentId, who: r.who, tool: c.tool, detail: c.detail ?? '', swarm: r.swarm, node: r.node })),
  )
  // For the next <swarm> block's "Cut short by the clear" lines, which only a live swarm's block shows.
  if (kills.length > 0 && swarms.some(s => !s.lost)) noteClearKills(kills.map(({ swarm: _s, node: _n, ...k }) => k))
  if (litterDir) {
    for (const k of kills) {
      const s = k.swarm === null ? null : liveSwarm(k.swarm)
      if (!s || s.readOnly || s.lost) continue
      await appendLaunchRecord(p, litterDir, s.name, s.launch, 'swarm.event', {
        kind: 'clear-killed',
        ...(k.node !== null ? { node: k.node } : {}),
        agentId: k.agentId,
        tool: k.tool,
        detail: k.detail,
      }).catch(err => p.log(`swarm ${s.name}: clear-killed not recorded: ${errText(err)}`))
    }
  }
  return passClear(e, next)
}

/**
 * Why the next rebind runs: a clear this hook passed on, or one whose
 * session.end came, is `clear`; an id the tick saw move with neither is
 * `session-moved` (backgrounding, where the lead still remembers).
 */
let clearSeen = false

function passClear(e: Parameters<PortHook<CommandRunHook>>[1], next: Parameters<PortHook<CommandRunHook>>[2]) {
  clearSeen = true
  return next(e)
}

// ---------------------------------------------------------------------------
// The rebind (15.4, "After /clear", steps 1-4)

/** session.end, within its 1.5 s bound, before lifecycle.ts's onSessionEnd: reason `clear` sets the rebind flag; any other stops the owner beats. */
export async function noteSessionEnd(p: Ports, e: Parameters<SessionEndHook>[1]): Promise<void> {
  if (e.reason === 'clear') {
    clearSeen = true
    setRebindPending(e.sessionId)
    return
  }
  others.stopOwnerBeat()
}

/** The rebind in flight: it resolves once the gate is open again. */
let rebinding: Promise<void> | null = null
/** What follows it, the panes' redraw, for tests to wait on. */
let after: Promise<void> = Promise.resolve()
/** Every session id this process ran under before the current one. */
const pastSessions = new Set<string>()
let timer: { cancel(): void } | null = null
let ticking = false

/**
 * Awaited at the top of every hook but session.start and session.end. With
 * nothing pending it costs one check; with a rebind pending, the first caller
 * runs it and the rest wait (p.sleep polls).
 */
export async function rebound(p: Ports): Promise<void> {
  if (rebindPending() === null) return
  if (rebinding) return ready(p)
  const now = await p.sessionId()
  if (rebinding) return ready(p)
  const from = rebindPending()
  // A hook between session.end and the switch to the new id: nothing has moved yet.
  if (from === null || now === from) return
  await startRebind(p, from, now)
}

/** Starts the rebind (one at a time); resolves once its gate is open again. */
function startRebind(p: Ports, from: string, to: string): Promise<void> {
  // rebind closes the gate before its first await, so a hook that sees `rebinding` waits on a closed gate.
  const r = rebind(p, from, to)
  rebinding = r
  after = r.then(() => redraw(p))
  return r.finally(() => {
    if (rebinding === r) rebinding = null
  })
}

/** One rebind step: a failure is logged, and the next step still runs. */
async function step(p: Ports, name: string, work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work()
    return true
  } catch (err) {
    p.log(`/clear rebind: ${name} failed: ${errText(err)}`)
    return false
  }
}

/** Is `id` this process's session, the current one or one before it? */
const mine = (id: string, to: string): boolean => id === to || pastSessions.has(id)

/**
 * Registers a swarm's types again (Q7): only one whose spec recovery took (a
 * specHash mismatch leaves its types unregistered on purpose), and once every
 * one is in, the swarm is ready for a resume, as recovery would have left it.
 */
async function registerTypes(p: Ports, litterDir: string, s: LiveSwarm): Promise<void> {
  if (!others.typesAccepted(s)) {
    p.log(`/clear rebind: swarm ${s.name}'s types aren't registered: recovery didn't take its spec`)
    return
  }
  let all = true
  for (const node of s.spec.nodes) {
    const ok = await step(p, `swarm ${s.name} type ${node.id}`, async () => {
      const brief = await others.briefTextFor(p, litterDir, s.name, s.revision, node.id)
      await p.registerAgent(others.nodeTypeSpec(s.spec, node.id, { brief }))
    })
    all &&= ok
  }
  if (all && stillLive(s) && !liveSwarm(s.name)!.typesReady) patchLiveSwarm(s.name, { typesReady: true })
}

/**
 * The rebind's swarm is still live here, this launch, owned and held (Q8):
 * after each await, a swarm End finished (or another session took) meanwhile
 * gets no more of the rebind, so nothing is recorded after its swarm.end.
 */
function stillLive(s: LiveSwarm): boolean {
  const cur = liveSwarm(s.name)
  return cur !== null && cur.launch === s.launch && !cur.readOnly && !cur.lost && others.ownedSwarm(s.name) !== null
}

/**
 * The rebind itself, with the state.ts gate closed so no hook answers from a
 * half-rebuilt state. It re-registers and rewrites; the panes' redraw runs
 * after the gate opens (startRebind). Every step's failure is logged, the
 * rest still run, and the gate always reopens. Nothing is resumed or re-spawned.
 */
async function rebind(p: Ports, from: string, to: string): Promise<void> {
  closeGate()
  const why: ClearReason = clearSeen ? 'clear' : 'session-moved'
  clearSeen = false
  try {
    pastSessions.add(from)
    setRecordedSession(to)
    const litterDir = session().litterDir
    if (litterDir) attach(p, litterDir)
    const owned = liveSwarms().filter(s => !s.readOnly && !s.lost)

    // Registering again is harmless: types, commands and tools survive a clear.
    await step(p, 'roles', async () => {
      const { failed } = await registerRoles(p)
      for (const f of failed) p.log(`/clear rebind: role ${f.role} not registered: ${f.reason}`)
    })
    await step(p, 'the record tool', async () => updateSession({ toolsRefused: await registerRecordTool(p) }))
    await step(p, 'the swarm tools', async () => updateSession({ swarmToolsRefused: await registerSwarmTools(p) }))
    if (litterDir) for (const s of owned) if (stillLive(s)) await registerTypes(p, litterDir, s)
    await step(p, 'the swarm commands', () => others.registerSwarmCommands(p))
    await step(p, 'the board and rules commands', () => others.registerPhase3Commands(p))
    if (!litterDir) return

    // policy.json's session, and each owned swarm's entry (never one End removed: patchSwarmPolicy leaves a missing entry alone).
    await step(p, "policy.json's session", () =>
      updatePolicy(p, litterDir, (policy: Policy) => (policy.session !== to && mine(policy.session, to) ? { ...policy, session: to } : null)),
    )
    for (const s of owned) {
      if (!stillLive(s)) continue
      await step(p, `swarm ${s.name}'s policy entry`, () =>
        others.patchSwarmPolicy(p, litterDir, s.name, entry =>
          entry.owner.generation === s.owner.generation && entry.owner.session !== to && mine(entry.owner.session, to)
            ? { ...entry, owner: { ...entry.owner, session: to } }
            : null,
        ),
      )
    }

    // The ownership refs to the new session, keeping the generation (K). The
    // beats stop first, so none sees its ref move and stands down mid-swap.
    for (const s of owned) await step(p, `swarm ${s.name}'s beat`, async () => others.stopOwnerBeat(s.name))
    const swapped = await step(p, 'the ownership swap', () => others.rebindOwnership(p, litterDir, to))
    for (const s of owned) {
      // Each step after an await checks again (Q8): End may have finished a swarm meanwhile.
      if (!stillLive(s)) continue
      const cur = liveSwarm(s.name)!
      if (swapped && cur.owner.session !== to) patchLiveSwarm(s.name, { owner: { ...cur.owner, session: to } })
      await step(p, `swarm ${s.name}'s beat`, async () => others.startOwnerBeat(p, litterDir, s.name))
    }

    // session.rebind in the open run's ledger (lifecycle.ts) and in each live launch's.
    await step(p, 'the run', () => rebindRun(p, litterDir, from, to, [...pastSessions]))
    for (const s of owned) {
      if (!stillLive(s)) continue
      await step(p, `swarm ${s.name}'s session.rebind`, () => appendLaunchRecord(p, litterDir, s.name, s.launch, 'session.rebind', { from, to }))
    }

    // Only a live swarm's <swarm> block reads the mark; with none, a later swarm's first block would say it wrongly.
    if (owned.some(stillLive)) markCleared(why)
  } catch (err) {
    p.log(`/clear rebind failed: ${errText(err)}`)
  } finally {
    if (rebindPending() === from) clearRebind()
    openGate()
  }
}

/** After the gate opens: the panes' views, since $.state was wiped (N; the board, AF, from its ledger). */
async function redraw(p: Ports): Promise<void> {
  await step(p, 'the panes', () => others.refreshPanes(p))
  await step(p, 'the board', () => others.refreshBoard(p))
}

/** Resolves once the rebind in flight, and the redraw after it, are done (tests). */
export async function rebindSettled(): Promise<void> {
  while (rebinding) await rebinding.catch(() => undefined)
  await after
}

// ---------------------------------------------------------------------------
// The timers

/** At session.start, with the timers: the 2 s tick (a changed session id starts the rebind; the summary runs from it). */
export function startSwarmTimers(p: Ports): void {
  timer?.cancel()
  timer = p.every(TICK_MS, () => {
    // The summary keeps its own one-at-a-time guard; a call can take 20 s, so the rebind check doesn't wait on it.
    void summaryTick(p).catch(err => p.log(`summary tick: ${errText(err)}`))
    void refreshTick(p).catch(err => p.log(`read-only refresh: ${errText(err)}`))
    if (ticking) return
    ticking = true
    void tick(p)
      .catch(err => p.log(`swarm tick: ${errText(err)}`))
      .finally(() => {
        ticking = false
      })
  })
}

/**
 * A session id that moved with no session.end the mod saw (a clear whose
 * end never reached it, or backgrounding) starts the rebind too.
 */
async function tick(p: Ports): Promise<void> {
  const now = await p.sessionId()
  const seen = recordedSession()
  if (rebindPending() === null && seen !== null && now !== seen) setRebindPending(seen)
  const from = rebindPending()
  if (from !== null && rebinding === null && now !== from) await startRebind(p, from, now)
}

/** How often the tick reads another session's swarms again (Q5). */
export const READ_ONLY_REFRESH_MS = 10_000
let refreshedAt: number | null = null
let refreshing = false

/**
 * About every 10 s, another session's swarms read again (recover.ts,
 * refreshReadOnly), so one its owner ended stops showing live here (Q5). Its
 * own one-at-a-time guard: its git reads never hold up the rebind check.
 */
async function refreshTick(p: Ports): Promise<void> {
  const litterDir = session().litterDir
  if (refreshing || !litterDir || !liveSwarms().some(s => s.readOnly)) return
  refreshing = true
  try {
    const at = await p.now()
    if (refreshedAt !== null && at - refreshedAt < READ_ONLY_REFRESH_MS) return
    refreshedAt = at
    await others.refreshReadOnly(p, litterDir)
  } finally {
    refreshing = false
  }
}

/** A fresh module's memory, for tests: no rebind, no timer, the real calls back in `others`. */
export function resetClearForTests(): void {
  rebinding = null
  after = Promise.resolve()
  pastSessions.clear()
  clearSeen = false
  timer?.cancel()
  timer = null
  ticking = false
  refreshedAt = null
  refreshing = false
  Object.assign(others, defaults)
}
