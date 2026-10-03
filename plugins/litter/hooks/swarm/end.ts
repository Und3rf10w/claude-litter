// WP-P: how a node or a whole swarm stops (15.4, "Ending"): Stop and Hard
// stop, End swarm with its stopping state and settle wait, swarm.end,
// summary.md, a restart while stopping, and the cleanup of a launch's worktrees.
//
// End swarm is two steps with `stopping` between them, as a run's stop is
// (section 9, "Run lifecycle"): the stopping first (swarm.stopping, the state
// and the policy entry, a TaskStop for each recorded shell), then a settle
// wait on this module's own 2 s timer until no node runs, nothing is
// reserved, no call is in flight and no shell is unconfirmed. Only then is
// anything removed. Nothing here sends to a node (COMMON, decision 2): the
// guard's stopping and stopped denials tell the nodes to report and end.
//
// The order once settled, which the brief gives with the cleanup last: the
// cleanup first, so that swarm.end's `worktrees` (records/swarm.ts) and
// summary.md say what was removed and what's left, then swarm.end, the
// summary, the ownership ref, the policy entry, the node policies, the live
// state, and the lead's hand-off from a timer.

import type { AgentPolicy, NodePolicy } from '../hookfiles'
import type { ListedAgent, Ports, ToolCallResult } from '../ports'
import type { RecordHandler, StoredRecord } from '../records/core'
import type {
  SwarmEndBody,
  SwarmStartBody,
  SwarmSummaryBody,
  SwarmWorktreeBody,
  SwarmWorktreeLeft,
  SwarmWorktreeRemovedBody,
} from '../records/swarm'
import type { LiveSwarm, NodeBinding, SettleProgress, SwarmSpec, TokenCount } from './types'
import { LedgerTampered } from '../ledgercore'
import { fail } from '../records/core'
import { appendLaunchRecord, readLaunchLedger } from '../records/swarm'
import {
  agentPolicyPath,
  hooksDir,
  launchSummaryPath,
  policyPath,
  revisionPath,
  spoolDir,
  SWARM_NAME,
  swarmNewWorktreeName,
  swarmOwnBranch,
  swarmOwnWorktreeName,
} from '../layout'
import { atomicWrite, readJson, serial } from '../fsx'
import { session } from '../session'
import { readPolicy } from '../policy'
import { repoOf, UNSETTLED_MS } from '../lifecycle'
import { BRANCH, cleanAbsolute, errText, firstLine, git, litterWorktreeRoot, OID, realOf, revParse } from '../worktrees'
import { inspectWorktree } from './worktrees'
import * as state from './state'
import { patchNodePolicies, patchSwarmPolicy, removeNodePolicy, writeSwarmPolicy } from './guard'
import * as guardModule from './guard'
import { releaseOwnership, stopOwnerBeat } from './owner'
import { noteSummaryTrigger, noteSwarmEnding, plainText } from './summary'

/**
 * The other packages' functions this module and observe.ts call (M's policy
 * writers, K's ownership, O's summary trigger), through one object, so a
 * tier-2 spec can stand in for bodies that are built in parallel (COMMON,
 * "Another package's module"). Each looks its function up when called, so an
 * import cycle can never catch one half-made. Nothing else replaces them.
 */
export const others = {
  patchNodePolicies: (...a: Parameters<typeof patchNodePolicies>) => patchNodePolicies(...a),
  patchSwarmPolicy: (...a: Parameters<typeof patchSwarmPolicy>) => patchSwarmPolicy(...a),
  writeSwarmPolicy: (...a: Parameters<typeof writeSwarmPolicy>) => writeSwarmPolicy(...a),
  removeNodePolicy: (...a: Parameters<typeof removeNodePolicy>) => removeNodePolicy(...a),
  releaseOwnership: (...a: Parameters<typeof releaseOwnership>) => releaseOwnership(...a),
  stopOwnerBeat: (...a: Parameters<typeof stopOwnerBeat>) => stopOwnerBeat(...a),
  noteSummaryTrigger: (...a: Parameters<typeof noteSummaryTrigger>) => noteSummaryTrigger(...a),
  /**
   * FIX-Q's releaseActive (Q10): removes `active` once policy.json holds no
   * swarm and no run and agents/ holds no binding file; a no-op otherwise.
   * Looked up by name, so this module builds before that package lands.
   */
  releaseActive: async (p: Ports, litterDir: string): Promise<void> => {
    const release = (guardModule as { releaseActive?: (p: Ports, litterDir: string) => Promise<void> }).releaseActive
    if (release) await release(p, litterDir)
  },
}

/** What a stopped node's policy carries, and the guard's denial names (15.4, "Ending"). */
export const STOPPED_REASON = 'stopped from the swarm browser'
/** The settle wait's poll (15.4, "Settling"). */
export const SETTLE_EVERY_MS = 2_000
/** A shell whose TaskStop failed is tried again at most this often. */
const SHELL_RETRY_MS = 10_000
/** A worktree removal can take a while on a large tree: up to the engine's 10 minutes. */
const SLOW_GIT_MS = 600_000
/** TaskStop's own answer for a task that's already over (2.1.288 `:748399`, `:749622`). */
const TASK_GONE = /is not running|No task found/i

const KEPT_UNSETTLED =
  "the swarm was ended without settling ([End, keep everything]), so nothing was removed; /litter-swarm offers the cleanup once nothing uses it"

const zero = (): TokenCount => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, turns: 0 })
const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`)
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const shown = (paths: readonly string[]): string => paths.slice(0, 10).join(', ') + (paths.length > 10 ? `, and ${paths.length - 10} more` : '')
const iso = (ms: number | null | undefined): string => (typeof ms === 'number' ? new Date(ms).toISOString() : 'unknown')
const short = (ref: string): string => ref.replace(/^refs\/heads\//, '')

function needLitterDir(): string {
  const litterDir = session().litterDir
  if (!litterDir) throw new Error('litter: this session has no litter directory')
  return litterDir
}

/** A live swarm this session owns and acts on; throws, naming why, for any other. */
function owned(name: string): LiveSwarm {
  const s = state.liveSwarm(name)
  if (!s) throw new Error(`litter: there's no live swarm named ${name}`)
  if (s.readOnly) throw new Error(`litter: another session owns the swarm ${name}; end or stop it there`)
  if (s.lost) throw new Error(`litter: this session no longer owns the swarm ${name}: it was handed to another session`)
  return s
}

/** The live swarms this session owns, for a refusal's `allowed`. */
const ownedNames = (): string[] => state.liveSwarms().filter(s => !s.readOnly && !s.lost).map(s => s.name).sort()

/**
 * TaskStop through `$.tool.call` (spike 7): `stopped`, `gone` (TaskStop says
 * the task is over, or there's none), or why it failed.
 */
async function taskStop(p: Ports, taskId: string): Promise<'stopped' | 'gone' | { failed: string }> {
  let r: ToolCallResult
  try {
    r = await p.callTool('TaskStop', { task_id: taskId })
  } catch (err) {
    return { failed: `TaskStop failed: ${errText(err)}` }
  }
  const deny = (r as { deny?: unknown }).deny
  if (typeof deny === 'string') return TASK_GONE.test(deny) ? 'gone' : { failed: `TaskStop was refused: ${deny}` }
  if (r.isError === true) {
    const text = typeof r.text === 'string' ? r.text : String(r.result ?? '')
    return TASK_GONE.test(text) ? 'gone' : { failed: `TaskStop failed: ${text}` }
  }
  return 'stopped'
}

// ---------------------------------------------------------------------------
// Stop and Hard stop

/**
 * [Stop node] (`soft`) and [Hard stop] (`hard`, TaskStop first): the node
 * and its descendants (by binding parent, children included) go on the
 * stopped list, their policies say why, and `swarm.stop` records it. The
 * guard's denial tells each to report and end; no message is sent. TaskStop
 * leaves a node `killed`, which a message would resume, so a hard stop goes
 * on the list too (spike 7). A hard stop whose TaskStop failed still stops
 * them on the list, then throws with why.
 */
export async function stopNode(p: Ports, swarm: string, agentId: string, how: 'soft' | 'hard'): Promise<void> {
  const litterDir = needLitterDir()
  const s = owned(swarm)
  const b = state.binding(agentId)
  if (!b || b.swarm !== swarm) throw new Error(`litter: ${agentId} isn't a node of the swarm ${swarm}`)
  let failed: string | null = null
  if (how === 'hard') {
    const r = await taskStop(p, agentId)
    if (typeof r === 'object') failed = r.failed
  }
  const ids = [agentId, ...state.descendantsOf(agentId).map(d => d.agentId)]
  state.stop(swarm, ids, STOPPED_REASON)
  await others.patchNodePolicies(p, litterDir, ids, { stopped: STOPPED_REASON })
  await appendLaunchRecord(p, litterDir, swarm, s.launch, 'swarm.stop', { nodes: ids, how })
  if (failed !== null) throw new Error(`litter: ${b.node} (${agentId}) is on the stopped list, but it may still be running: ${failed}`)
}

// ---------------------------------------------------------------------------
// End swarm: the stopping step and the settle wait

/** One stopping swarm's wait, in module memory. A restart rebuilds it from the ledger (resumeStopping). */
type Wait = {
  litterDir: string
  /** When the stopping began, or [Wait longer] restarted the clock: the 2 minutes count from here. */
  since: number
  timer: { cancel(): void } | null
  ticking: boolean
  /** The list the last tick read, for settleProgress, which can't await one. */
  list: ListedAgent[] | null
  /** The policy entry says `stopping`. */
  policyStopping: boolean
  /** Past 2 minutes, said once (a toast and the log); [Wait longer] says it again later. */
  reported: boolean
  shellTried: Map<string, number>
  shellFailed: Set<string>
  lastError: string | null
  /** Each spool file still pending, with when a tick, nothing else open, first saw it (U7). */
  spool: Map<string, number>
}

const waits = new Map<string, Wait>()
const endKey = (litterDir: string, name: string) => `swarm-end:${litterDir}:${name}`

/** Starts (or keeps) the swarm's settle wait on its own timer. */
function waitFor(p: Ports, litterDir: string, name: string, since: number): Wait {
  let w = waits.get(name)
  if (!w) {
    w = {
      litterDir,
      since,
      timer: null,
      ticking: false,
      list: null,
      policyStopping: false,
      reported: false,
      shellTried: new Map(),
      shellFailed: new Set(),
      lastError: null,
      spool: new Map(),
    }
    waits.set(name, w)
  }
  if (!w.timer) {
    const wait = w
    // The engine doesn't await a timer's callback; the promise is handed back for a test's fireEvery.
    w.timer = p.every(SETTLE_EVERY_MS, () => settleTick(p, name, wait).catch(err => p.log(`swarm ${name}: the settle wait failed: ${errText(err)}`)))
  }
  return w
}

function stopWait(name: string): void {
  const w = waits.get(name)
  w?.timer?.cancel()
  if (w) w.timer = null
}

async function markPolicyStopping(p: Ports, name: string, w: Wait): Promise<void> {
  try {
    await others.patchSwarmPolicy(p, w.litterDir, name, e => (e.state === 'stopping' ? null : { ...e, state: 'stopping' }))
    w.policyStopping = true
  } catch (err) {
    // The settle wait tries again: until it takes, the guard doesn't know the swarm is ending.
    p.log(`swarm ${name}: policy.json wasn't set to stopping: ${errText(err)}`)
  }
}

/** A TaskStop for each recorded shell not confirmed stopped, each at most every 10 s. */
async function stopShells(p: Ports, name: string, w: Wait): Promise<void> {
  const now = await p.now()
  for (const sh of state.shells(name)) {
    if (now - (w.shellTried.get(sh.shellId) ?? -Infinity) < SHELL_RETRY_MS) continue
    w.shellTried.set(sh.shellId, now)
    const r = await taskStop(p, sh.shellId)
    if (typeof r !== 'object') {
      state.shellStopped(sh.shellId)
      continue
    }
    if (!w.shellFailed.has(sh.shellId)) {
      w.shellFailed.add(sh.shellId)
      p.log(`swarm ${name}: background shell ${sh.shellId} isn't confirmed stopped (${r.failed}); its worktree stays until it is`)
    }
  }
}

/**
 * Step 1, stopping (15.4): `swarm.stopping`, the live swarm's and the policy
 * entry's state, then a TaskStop for each recorded shell, and the settle wait.
 * From then on L refuses spawns, resumes and wakes, and the guard denies all
 * but SendMessage and SubagentHandback. Again while stopping, it only makes
 * sure the wait runs.
 */
async function beginStopping(p: Ports, litterDir: string, name: string, by: 'browser' | 'lead'): Promise<void> {
  await serial(endKey(litterDir, name), async () => {
    const s = owned(name)
    let since = waits.get(name)?.since ?? null
    if (s.state !== 'stopping') {
      since = (await appendLaunchRecord(p, litterDir, name, s.launch, 'swarm.stopping', { by })).at
      state.patchLiveSwarm(name, { state: 'stopping' })
    }
    const w = waitFor(p, litterDir, name, since ?? (await p.now()))
    if (!w.policyStopping) await markPolicyStopping(p, name, w)
    await stopShells(p, name, w)
  })
}

/**
 * Whether the node's last turn has ended (15.4, "Settling"): a turn.complete
 * (L's settling), a SubagentStop, or the list not showing it running. The
 * list's `running` wins over an idle place, since a wake can run a node
 * past litter's hooks (spike 17). With no list read yet, the places alone.
 * The cleanup asks the same of each agent that worked in a worktree, so a
 * swarm.end that says `settled: true` never keeps a worktree as in use.
 */
function turnEnded(agentId: string, listed: Map<string, ListedAgent> | null): boolean {
  const place = state.status(agentId)
  if (place === 'settling' || state.agentStopped(agentId)) return true
  if (listed === null) return place !== 'running'
  return listed.get(agentId)?.status !== 'running'
}

/** What the settle wait still waits on, from the state and the last list read. Changes nothing. */
function openParts(s: LiveSwarm, list: ListedAgent[] | null): Omit<SettleProgress, 'swarm' | 'since'> {
  const listed = list ? new Map(list.map(a => [a.id, a])) : null
  const nodes: SettleProgress['nodes'] = []
  for (const b of state.bindings(s.name)) {
    if (turnEnded(b.agentId, listed)) continue
    nodes.push({ agentId: b.agentId, node: b.node, n: b.n, status: listed?.get(b.agentId)?.status ?? state.status(b.agentId) })
  }
  // An agent of one of the swarm's types that no binding knows is a node too (an adoption still to come).
  const types = new Map(Object.entries(s.types).map(([node, t]) => [t, node]))
  for (const a of list ?? []) {
    const node = types.get(a.type)
    if (node !== undefined && a.status === 'running' && state.binding(a.id) === null) nodes.push({ agentId: a.id, node, n: 0, status: 'running, not bound' })
  }
  const nodeOf = (id: string) => state.binding(id)?.node ?? 'unknown'
  return {
    nodes,
    calls: state
      .inflight()
      .filter(c => c.swarm === s.name)
      .map(c => ({ agentId: c.agentId, node: nodeOf(c.agentId), tool: c.tool, toolUseId: c.toolUseId, at: c.at })),
    shells: state.shells(s.name).map(sh => ({ shellId: sh.shellId, agentId: sh.agentId, node: nodeOf(sh.agentId), at: sh.at })),
    reservations: state.reservations(s.name).length,
  }
}

/**
 * Calls of agents the list doesn't show running can't be in flight: an
 * interrupted call gets no end, and a non-litter child has no SubagentStop
 * spooled to close it (15.9, item 13). They're closed here.
 */
function closeStaleCalls(name: string, list: ListedAgent[]): void {
  const running = new Set(list.filter(a => a.status === 'running').map(a => a.id))
  const stale = new Set(state.inflight().filter(c => c.swarm === name && !running.has(c.agentId)).map(c => c.agentId))
  for (const id of stale) state.closeCalls(id)
}

/**
 * Lines the hooks spooled that the drain hasn't handed on yet (a call's end
 * naming a background shell, say), for this session and the swarm's owner
 * session: the wait doesn't settle on a table the spool is about to change.
 * Answers the files' names (an aside's as policy.ts's drain names it).
 */
async function spoolPending(p: Ports, litterDir: string, s: LiveSwarm): Promise<string[]> {
  const dir = spoolDir(litterDir)
  if (!(await p.fs.exists(dir))) return []
  const sessions = [...new Set([await p.sessionId(), s.owner.session])]
  const out: string[] = []
  for (const e of await p.fs.list(dir)) {
    if (e.kind !== 'file') continue
    for (const sid of sessions) {
      if (e.name.startsWith(`${sid}.jsonl.draining-`) && ASIDE_ID.test(e.name.slice(`${sid}.jsonl.draining-`.length))) out.push(e.name)
      else if (e.name === `${sid}.jsonl` && ((await p.fs.stat(`${dir}/${e.name}`).catch(() => null))?.size ?? 0) > 0) out.push(e.name)
    }
  }
  return out
}

/** policy.ts's aside suffix: `<session>.jsonl.draining-<id>`. A name it wouldn't drain isn't waited on. */
const ASIDE_ID = /^[A-Za-z0-9-]+$/

/**
 * How long the settle waits on a spool file that stays (FIX-U, U7): the drain
 * skips a malformed line or one whose blob is missing, but an aside it can't
 * read or remove, or a live file it can't rename, stays, and only a
 * session.start drains asides. Past this, with nothing else open, the settle
 * counts their lines as drained, and swarm.end's reason names the files.
 */
export const SPOOL_STUCK_MS = 30_000

/** One tick of the settle wait (15.4, "Settling"), from its own timer: settled, it ends the swarm. */
async function settleTick(p: Ports, name: string, w: Wait): Promise<void> {
  if (w.ticking) return
  w.ticking = true
  try {
    const s = state.liveSwarm(name)
    if (!s || s.readOnly || s.lost || s.state !== 'stopping') {
      stopWait(name)
      waits.delete(name)
      return
    }
    if (!w.policyStopping) await markPolicyStopping(p, name, w)
    await stopShells(p, name, w)
    w.list = await p.listAgents()
    closeStaleCalls(name, w.list)
    const open = openParts(s, w.list)
    const settled = open.nodes.length === 0 && open.calls.length === 0 && open.shells.length === 0 && open.reservations === 0
    if (!settled) w.spool.clear()
    else {
      const pending = await spoolPending(p, w.litterDir, s)
      const now = await p.now()
      for (const f of [...w.spool.keys()]) if (!pending.includes(f)) w.spool.delete(f)
      for (const f of pending) if (!w.spool.has(f)) w.spool.set(f, now)
      const stuck = pending.filter(f => now - w.spool.get(f)! >= SPOOL_STUCK_MS)
      if (stuck.length === pending.length) {
        if (stuck.length > 0) p.log(`swarm ${name}: settled but for ${stuck.join(', ')}, which didn't drain within 30 s; its lines are counted as drained`)
        await finish(p, w.litterDir, name, true, stuck)
        return
      }
    }
    if (!w.reported && (await p.now()) - w.since >= UNSETTLED_MS) {
      w.reported = true
      p.log(
        `swarm ${name}: not settled after 2 minutes: ${plural(open.nodes.length, 'node')} running, ${plural(open.calls.length, 'call')} in flight, ` +
          `${plural(open.shells.length, 'shell')}, ${plural(open.reservations, 'reservation')}`,
      )
      p.toast(`litter: swarm ${name} hasn't settled after 2 minutes; /litter-swarm ${name} shows what's still open`)
    }
  } catch (err) {
    const text = errText(err)
    if (text !== w.lastError) p.log(`swarm ${name}: the settle wait failed (it tries again): ${text}`)
    w.lastError = text
  } finally {
    w.ticking = false
  }
}

/** Every worktree this launch made, by path, with the latest cleanup outcome after its making. */
type Made = SwarmWorktreeBody & { outcome: 'removed' | 'kept' | null; keptReason: string | null; branchDeleted: boolean }

function madeWorktrees(records: readonly StoredRecord[], launch: string): Made[] {
  const byPath = new Map<string, Made>()
  for (const r of records) {
    if (r.by.source !== 'mod' || typeof r.body.path !== 'string') continue
    const path = r.body.path
    if (r.kind === 'swarm.worktree' && r.body.created_by === launch) {
      const b = r.body as unknown as SwarmWorktreeBody
      byPath.set(path, { ...b, ignored: Array.isArray(b.ignored) ? b.ignored : [], outcome: null, keptReason: null, branchDeleted: false })
      continue
    }
    const t = byPath.get(path)
    if (!t) continue
    if (r.kind === 'swarm.worktree.removed') {
      t.outcome = 'removed'
      t.branchDeleted = r.body.branchDeleted === true
    } else if (r.kind === 'swarm.worktree.kept') {
      t.outcome = 'kept'
      t.keptReason = typeof r.body.reason === 'string' ? r.body.reason : ''
    }
  }
  return [...byPath.values()]
}

/** Records a kept outcome, unless the last one for that path said the same. */
async function recordKept(p: Ports, litterDir: string, swarm: string, launch: string, t: Made, reason: string): Promise<boolean> {
  if (t.outcome === 'kept' && t.keptReason === reason) return false
  await appendLaunchRecord(p, litterDir, swarm, launch, 'swarm.worktree.kept', { path: t.path, branch: t.branch, reason })
  return true
}

/**
 * Ended (15.4, step 3): the cleanup (settled) or every made worktree kept
 * (not settled), then `swarm.end`, `summary.md`, the ownership ref, the
 * policy entry, the node policies of the agents that aren't running (a
 * running one's stays until the sweep sees it go), the live state (after
 * which agent.offer hides its types), and the lead's hand-off from a timer.
 * Each step after swarm.end is logged when it fails, and the rest go on. A
 * launch ledger that's broken (its chain or head check fails) ends the swarm
 * too, with no cleanup and no swarm.end, said in a toast and in summary.md.
 * `stuckSpool` names the spool files the settle stopped waiting on (U7).
 */
async function finish(p: Ports, litterDir: string, name: string, settled: boolean, stuckSpool: readonly string[] = []): Promise<void> {
  await serial(endKey(litterDir, name), async () => {
    const s = state.liveSwarm(name)
    if (!s || s.readOnly || s.lost || s.state !== 'stopping') return
    stopWait(name)
    // A broken chain takes no more records, so it can't take swarm.end: the end goes on
    // without one, and the toast and summary.md say so (FIX-U, U6).
    let broken: { seq: number; reason: string } | null = null
    try {
      broken = (await readLaunchLedger(p, litterDir, name, s.launch)).tampered
      if (broken === null) {
        if (settled) await cleanupLaunch(p, name, s.launch)
        else {
          const { records } = await readLaunchLedger(p, litterDir, name, s.launch)
          for (const t of madeWorktrees(records, s.launch)) if (t.outcome !== 'removed') await recordKept(p, litterDir, name, s.launch, t, KEPT_UNSETTLED)
        }
        const { records, tampered } = await readLaunchLedger(p, litterDir, name, s.launch)
        broken = tampered
        if (broken === null) {
          const worktrees = await worktreesLeft(p, records, s.launch, s)
          const body: SwarmEndBody = {
            status: 'ended',
            settled,
            ...(!settled
              ? { reason: 'ended with [End, keep everything] before it settled' }
              : stuckSpool.length > 0
                ? { reason: `${stuckSpool.join(', ')} didn't drain within 30 s, so the settle counted its lines as drained` }
                : {}),
            nodes: nodesOf(s.spec, records, s.name),
            worktrees,
            branches: await branchesLeft(p, s, records, worktrees),
          }
          // In the same step as the append, so a summary call that answers late lands before it or not at all (U4).
          noteSwarmEnding(name, s.launch)
          await appendLaunchRecord(p, litterDir, name, s.launch, 'swarm.end', body)
        }
      }
    } catch (err) {
      if (err instanceof LedgerTampered) broken = { seq: err.seq, reason: err.reason }
      else {
        // Nothing was ended: the wait goes on, and tries again at its next tick.
        waitFor(p, litterDir, name, waits.get(name)?.since ?? s.startedAt)
        throw err
      }
    }
    if (broken !== null) {
      noteSwarmEnding(name, s.launch)
      const why = `its launch ledger is broken at record ${broken.seq} (${broken.reason}), so it holds no swarm.end, and no worktree was removed`
      p.log(`swarm ${name}: ended, but ${why}`)
      p.toast(`litter: swarm ${name} has ended, but ${why}; summary.md lists what's left`)
    }
    const step = async (what: string, work: () => Promise<void> | void) => {
      try {
        await work()
      } catch (err) {
        p.log(`swarm ${name}: at its end, ${what} failed: ${errText(err)}`)
      }
    }
    let summary: string | null = null
    await step('summary.md', async () => {
      summary = await writeSwarmSummary(p, name, s.launch, { unrecordedEnd: broken !== null })
    })
    await step('releasing the ownership ref', () => others.releaseOwnership(p, litterDir, name))
    await step('stopping the ownership beat', () => others.stopOwnerBeat(name))
    await step("removing policy.json's entry", () => others.writeSwarmPolicy(p, litterDir, name, null))
    await step('removing the node policies', () => removeEndedPolicies(p, litterDir, name, s.launch))
    state.dropLiveSwarm(name)
    waits.delete(name)
    if (summary !== null) handOff(p, name, summary)
  })
}

/** The lead's hand-off (the skill's section 6): the summary's path and its opening lines, the mod's own facts. */
function handOff(p: Ports, name: string, path: string): void {
  // Submitted from a timer, never from a hook, and never awaited (15.9, item 19).
  p.after(0, () =>
    (async () => {
      const text = await p.fs.read(path)
      const head = headOf(text)
      await p.submitPrompt(
        `litter: the swarm ${name} has ended. Its summary is ${path}, which opens:\n\n${head}\n\n` +
          'Read it, and report it to the user as the litter swarm skill says for the end of a swarm (its section 6).',
      )
    })().catch(err => p.log(`swarm ${name}: the lead wasn't handed the summary: ${errText(err)}`)),
  )
}

/** summary.md's opening: its title and status lines, all of them the mod's own, never a node's text. */
export function headOf(summary: string): string {
  const lines = summary.split('\n')
  const cut = lines.findIndex((l, i) => i > 0 && l.startsWith('## '))
  return (cut < 0 ? lines : lines.slice(0, cut)).join('\n').trim()
}

// ---------------------------------------------------------------------------
// The node policies End keeps (End never leaves a running agent unguarded)
//
// [End, keep everything] ends a swarm while its nodes still run. Were their
// policy files removed with the entry, a node's non-swarm child would be an
// agent no swarm knows, which the guard passes, and its node's paths, commit
// and push limits and bash.deny would no longer apply. So End removes only
// the files of agents the list doesn't show running; a running one's file
// stays, and with its swarm's entry gone the guard denies its every call
// ("the swarm is not live", guard.sh). The sweep removes a kept file once its
// agent leaves the list, and asks for `active` to go once none is left
// (FIX-Q's releaseActive keeps `active` while any binding file remains).
// A former node resumed after its file went is still denied, by its
// `litter:sw-*` type with no binding; a former child resumed then is a plain
// subagent.

/** A kept file: `own`, its agent is this session's, watched in the list; else another session's, watched by its age. */
type Kept = { swarm: string; launch: string; own: boolean }
const kept = new Map<string, Kept>()
let sweepTimer: { cancel(): void } | null = null
let sweeping = false
let lastBeat = 0
/** A kept file of this session's is touched this often while its agent runs, so another session's start sees it's held. */
const KEPT_BEAT_MS = 20_000
/** Another session's kept file that nobody touched for this long is a leftover (owner.ts's OWNER_STALE_MS). */
const KEPT_STALE_MS = 60_000
/** An id the hooks name a file by (lib.sh's lt_id_ok). */
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Every swarm node's or child's policy file under agents/, with its node part and age; a file that doesn't read is left out. */
async function nodePolicyFiles(p: Ports, litterDir: string): Promise<{ agentId: string; node: NodePolicy }[]> {
  const dir = `${hooksDir(litterDir)}/agents`
  if (!(await p.fs.exists(dir))) return []
  const out: { agentId: string; node: NodePolicy }[] = []
  for (const e of await p.fs.list(dir)) {
    const agentId = e.kind === 'file' && e.name.endsWith('.json') ? e.name.slice(0, -'.json'.length) : ''
    if (!AGENT_ID.test(agentId)) continue
    try {
      const file = await readJson<AgentPolicy>(p, `${dir}/${e.name}`)
      const node = file?.v === 1 ? file.node : undefined
      if (node && typeof node === 'object' && typeof node.swarm === 'string' && typeof node.launch === 'string') out.push({ agentId, node })
    } catch (err) {
      p.log(`agents/${e.name} isn't readable, so the sweep leaves it: ${errText(err)}`)
    }
  }
  return out
}

/** The ids the list shows running; null when it can't be read, which keeps every file. */
async function runningIds(p: Ports): Promise<Set<string> | null> {
  const list = await p.listAgents().catch(() => null)
  return list ? new Set(list.filter(a => a.status === 'running').map(a => a.id)) : null
}

/**
 * At the end of a launch: every binding's policy file and every other file
 * naming the launch (holdToBind's, which no binding knows) is removed when
 * its agent isn't running, and kept, for the sweep, when it is.
 */
async function removeEndedPolicies(p: Ports, litterDir: string, name: string, launch: string): Promise<void> {
  const running = await runningIds(p)
  const ids = new Set(state.bindings(name).map(b => b.agentId))
  for (const f of await nodePolicyFiles(p, litterDir)) if (f.node.swarm === name && f.node.launch === launch) ids.add(f.agentId)
  for (const id of ids) {
    if (running === null || running.has(id)) {
      kept.set(id, { swarm: name, launch, own: true })
      continue
    }
    await others.removeNodePolicy(p, litterDir, id).catch(err => p.log(`swarm ${name}: ${id}'s policy wasn't removed: ${errText(err)}`))
  }
  await others.releaseActive(p, litterDir)
  if (kept.size > 0) startSweep(p, litterDir)
}

function startSweep(p: Ports, litterDir: string): void {
  if (sweepTimer) return
  // The engine doesn't await a timer's callback; the promise is handed back for a test's fireEvery.
  sweepTimer = p.every(SETTLE_EVERY_MS, () => sweepKept(p, litterDir).catch(err => p.log(`the node policy sweep failed: ${errText(err)}`)))
}

/** One sweep: a kept file goes once its agent isn't running here, or (another session's) once nobody touches it. */
async function sweepKept(p: Ports, litterDir: string): Promise<void> {
  if (sweeping) return
  sweeping = true
  try {
    const running = await runningIds(p)
    if (running === null) return
    const now = await p.now()
    const beat = now - lastBeat >= KEPT_BEAT_MS
    let removed = false
    for (const [id, k] of [...kept]) {
      const path = agentPolicyPath(litterDir, id)
      if (k.own && running.has(id)) {
        if (beat) await p.run(['touch', '-c', '--', path]).catch(() => undefined)
        continue
      }
      if (!k.own) {
        const stat = await p.fs.stat(path).catch(() => null)
        if (stat && now - stat.mtimeMs < KEPT_STALE_MS) continue
      }
      try {
        await others.removeNodePolicy(p, litterDir, id)
        kept.delete(id)
        removed = true
      } catch (err) {
        p.log(`swarm ${k.swarm}: ${id}'s policy wasn't removed (the sweep tries again): ${errText(err)}`)
      }
    }
    if (beat) lastBeat = now
    if (removed) await others.releaseActive(p, litterDir)
    if (kept.size === 0) {
      sweepTimer?.cancel()
      sweepTimer = null
    }
  } finally {
    sweeping = false
  }
}

/**
 * At session.start, after recovery: a node policy file whose swarm has no
 * live entry in policy.json (or whose entry names another launch) is a
 * leftover of an ended launch. It's removed unless its agent runs in this
 * session, or another session touched it within the last minute (that
 * session's End kept it for an agent still running there); both are swept
 * later. A policy.json that doesn't read removes nothing.
 */
export async function sweepNodePolicies(p: Ports, litterDir: string): Promise<void> {
  let swarms: Record<string, { launch?: unknown }> = {}
  if (await p.fs.exists(policyPath(litterDir))) {
    const policy = await readPolicy(p, litterDir).catch(() => undefined)
    if (!policy) {
      p.log("policy.json doesn't read, so no node policy was swept")
      return
    }
    swarms = policy.swarm?.swarms ?? {}
  }
  const running = await runningIds(p)
  for (const f of await nodePolicyFiles(p, litterDir)) {
    const e = Object.hasOwn(swarms, f.node.swarm) ? swarms[f.node.swarm] : undefined
    if ((e && e.launch === f.node.launch) || kept.has(f.agentId)) continue
    kept.set(f.agentId, { swarm: f.node.swarm, launch: f.node.launch, own: running === null || running.has(f.agentId) })
  }
  if (kept.size === 0) return
  startSweep(p, litterDir)
  await sweepKept(p, litterDir)
}

/**
 * End swarm from the browser (`request`), and the unsettled report's
 * [Wait longer] (the 2 minutes count again) and [End, keep everything]
 * (`swarm.end` now with `settled: false`, and no worktree removed). Throws,
 * naming why, for a swarm this session doesn't own, and [Wait longer] for one
 * that isn't stopping.
 */
export async function endSwarm(p: Ports, swarm: string, how: 'request' | 'wait-longer' | 'keep-everything'): Promise<void> {
  const litterDir = needLitterDir()
  const s = owned(swarm)
  if (how === 'request') return beginStopping(p, litterDir, swarm, 'browser')
  if (how === 'wait-longer') {
    if (s.state !== 'stopping') throw new Error(`litter: the swarm ${swarm} isn't ending`)
    const w = waitFor(p, litterDir, swarm, await p.now())
    w.since = await p.now()
    w.reported = false
    return
  }
  if (s.state !== 'stopping') await beginStopping(p, litterDir, swarm, 'browser')
  await finish(p, litterDir, swarm, false)
}

/**
 * The lead's `swarm.end { swarm }` through the record tool (the skill's
 * section 6): the stopping step, then `{ ok: true, status: 'stopping' }` at
 * once; the settle wait ends it later and hands the lead the summary.
 */
export const recordSwarmEnd: RecordHandler = async (ctx, input) => {
  if (ctx.caller.agentId !== null) return fail("litter: 'swarm.end' is the lead's; a node reports and ends its turn instead", 'kind')
  if (!ctx.litterDir) return fail('litter: this session has no litter directory, so it has no swarm to end')
  const live = ownedNames()
  const name = input.swarm
  if (typeof name !== 'string' || !SWARM_NAME.test(name)) return fail("litter: 'swarm' is required: the name of the live swarm to end", 'swarm', live)
  const s = state.liveSwarm(name)
  if (!s) return fail(`litter: there's no live swarm named ${name}`, 'swarm', live)
  if (s.readOnly) return fail(`litter: another session owns the swarm ${name}; it can only be ended there`, 'swarm', live)
  if (s.lost) return fail(`litter: this session no longer owns the swarm ${name}: it was handed to another session`, 'swarm', live)
  await beginStopping(ctx.p, ctx.litterDir, name, 'lead')
  return { ok: true, status: 'stopping' }
}

/**
 * What the settle wait still waits on, for N's unsettled report: the nodes,
 * each open call with its tool and start, the shells, the reservations.
 * `since` is when the stopping began, or [Wait longer] last restarted the
 * 2 minutes (lifecycle.ts's UNSETTLED_MS). Null when the swarm isn't stopping.
 */
export function settleProgress(swarm: string): SettleProgress | null {
  const s = state.liveSwarm(swarm)
  if (!s || s.state !== 'stopping') return null
  const w = waits.get(swarm)
  return { swarm, since: w?.since ?? s.startedAt, ...openParts(s, w?.list ?? null) }
}

/**
 * K's recovery for a swarm that was stopping (a `swarm.stopping` with no
 * `swarm.end`): no node is resumed, the state and the policy entry stay
 * `stopping`, and the settle wait resumes, counting from the ledger's
 * stopping. A launch that has ended, or never began stopping, is left alone.
 */
export async function resumeStopping(p: Ports, swarm: string): Promise<void> {
  const litterDir = needLitterDir()
  const s = owned(swarm)
  const { records, tampered } = await readLaunchLedger(p, litterDir, swarm, s.launch)
  if (tampered) throw new Error(`litter: launch ${s.launch} of ${swarm} has a tampered ledger at record ${tampered.seq}`)
  if (records.some(r => r.kind === 'swarm.end')) return
  const stopping = records.find(r => r.kind === 'swarm.stopping')
  if (!stopping) return
  if (s.state !== 'stopping') state.patchLiveSwarm(swarm, { state: 'stopping' })
  const w = waitFor(p, litterDir, swarm, stopping.at)
  if (!w.policyStopping) await markPolicyStopping(p, swarm, w)
}

// ---------------------------------------------------------------------------
// Cleanup (15.4, "Cleanup removes only worktrees this launch created")

type Outcome = { keep: string } | { removed: SwarmWorktreeRemovedBody }

/** What's still using a worktree: a node or child running there, a shell one of them started, a spawn reserved there. */
function usersOf(records: readonly StoredRecord[], name: string, list: ListedAgent[], path: string, real: string): string[] {
  const at = (cwd: string) => inside(cwd, path) || inside(cwd, real)
  const cwdOf = new Map<string, string>()
  for (const r of records) {
    if (r.kind === 'swarm.node' && r.by.source === 'mod' && typeof r.body.agentId === 'string' && typeof r.body.cwd === 'string') cwdOf.set(r.body.agentId, r.body.cwd)
  }
  for (const b of state.bindings(name)) cwdOf.set(b.agentId, b.cwd)
  const listed = new Map(list.map(a => [a.id, a]))
  const out: string[] = []
  for (const [id, cwd] of cwdOf) {
    if (!at(cwd)) continue
    // Ended as the settle wait counts it: a turn.complete or a SubagentStop wins over a list that lags.
    if (!turnEnded(id, listed)) out.push(`${id} is still running there`)
    if (state.shells().some(sh => sh.agentId === id)) out.push(`a background shell ${id} started isn't confirmed stopped`)
  }
  for (const r of state.reservations(name)) if (r.scope && at(r.scope.dir)) out.push(`a spawn of ${r.node} is reserved there`)
  return out
}

/** An `own` worker's branch, which the spawn check made for it, is deleted when that loses no commit. A `new` one you named is kept. */
async function dropBranch(p: Ports, repo: string, swarm: string, t: Made): Promise<boolean> {
  if (t.n === undefined || t.branch !== swarmOwnBranch(swarm, t.node, t.n) || !BRANCH.test(t.branch)) return false
  if ((await git(p, repo, ['branch', '-d', '--', t.branch])).code === 0) return true
  // -d wants it merged into the checkout's HEAD. It has no commits past `from`, so it's
  // safe to delete too when another local branch holds its tip.
  const tip = await revParse(p, repo, `refs/heads/${t.branch}`)
  if (!tip) return false
  const r = await git(p, repo, ['for-each-ref', '--contains', tip, '--format=%(refname)', 'refs/heads'])
  if (r.code !== 0 || !r.stdout.split('\n').some(ref => ref !== '' && ref !== `refs/heads/${t.branch}`)) return false
  return (await git(p, repo, ['branch', '-D', '--', t.branch])).code === 0
}

/** One made worktree's outcome, every check made again just before the removal. */
async function decide(
  p: Ports,
  ctx: { repo: string; root: string; cwd: string; records: readonly StoredRecord[]; list: ListedAgent[] | null; existing: Set<string>; swarm: string },
  t: Made,
): Promise<Outcome> {
  const name = t.n === undefined ? swarmNewWorktreeName(ctx.swarm, t.node) : swarmOwnWorktreeName(ctx.swarm, t.node, t.n)
  if (!cleanAbsolute(t.path) || t.path !== `${ctx.root}/${name}`) return { keep: `it isn't at ${ctx.root}/${name}, where litter makes this node's worktree` }
  const real = await realOf(p, t.path)
  if (ctx.existing.has(t.path) || ctx.existing.has(real)) return { keep: "it's a node's existing worktree, which litter never removes" }
  if (inside(ctx.cwd, real) || inside(ctx.cwd, t.path)) return { keep: "the session's working directory is inside it" }
  if (!ctx.list) return { keep: "litter couldn't list the session's agents, so it can't tell whether anything still uses it" }
  const users = usersOf(ctx.records, ctx.swarm, ctx.list, t.path, real)
  if (users.length > 0) return { keep: `it's still in use: ${users.join('; ')}` }
  if (!OID.test(t.from)) return { keep: `its record names no commit it was made from ('${t.from}')` }
  const f = await inspectWorktree(p, ctx.repo, t.path, t.branch, t.from, t.ignored)
  if (f.listed === null) return { keep: `git worktree list failed in ${ctx.repo}` }
  if (!f.listed) return { keep: "git doesn't list it as one of this repository's worktrees, so litter leaves it alone" }
  if (f.checkedOut !== `refs/heads/${t.branch}`) return { keep: `it's checked out on ${f.checkedOut ? short(f.checkedOut) : 'a detached HEAD'}, not ${t.branch}` }
  if (f.commitsPast === null) return { keep: `git can't compare ${t.branch} with ${t.from}` }
  if (f.commitsPast > 0) return { keep: `${t.branch} has ${plural(f.commitsPast, 'commit')} past ${t.from.slice(0, 12)}` }
  if (f.changes === null || f.newIgnored === null) return { keep: 'git status failed in it' }
  if (f.changes.length > 0) return { keep: `it holds uncommitted changes (${shown(f.changes)})` }
  // An unforced remove still deletes ignored files (tenth review).
  if (f.newIgnored.length > 0) return { keep: `it holds ignored paths its setup didn't leave (${shown(f.newIgnored)}), which removing it would delete` }
  const rm = await git(p, ctx.repo, ['worktree', 'remove', '--', t.path], SLOW_GIT_MS)
  if (rm.code !== 0) return { keep: `git refused to remove it: ${firstLine(rm.stderr)}` }
  return { removed: { path: t.path, branch: t.branch, branchDeleted: await dropBranch(p, ctx.repo, ctx.swarm, t) } }
}

/**
 * Removes the `new` and `own` worktrees this launch made (a `swarm.worktree`
 * with `created_by: <launch>`) that are unchanged, without `--force`, and an
 * `own` worker's branch with them when that's safe; records each kept one
 * with why (15.4, "Cleanup"). A worktree is removed only when, checked again
 * just before: its branch has no commits past `from`, `git status
 * --porcelain --ignored` shows nothing but the ignored paths its setup left,
 * and nothing uses it (no node or child running there, no shell unconfirmed,
 * no spawn reserved there). An `existing` worktree is never removed. K calls
 * this for a failed launch too; /litter-swarm offers it again later. When the
 * launch has ended and an outcome changed, summary.md is written again.
 */
export async function cleanupLaunch(p: Ports, swarm: string, launch: string): Promise<void> {
  const litterDir = needLitterDir()
  await serial(`swarm-cleanup:${litterDir}:${swarm}:${launch}`, async () => {
    const { records, tampered } = await readLaunchLedger(p, litterDir, swarm, launch)
    if (tampered) {
      p.log(`swarm ${swarm}: launch ${launch}'s ledger is tampered at record ${tampered.seq}; no worktree removed`)
      return
    }
    const targets = madeWorktrees(records, launch).filter(t => t.outcome !== 'removed')
    if (targets.length === 0) return
    const start = records.find(r => r.kind === 'swarm.start')?.body as SwarmStartBody | undefined
    const existing = new Set<string>()
    for (const d of Object.values(start?.nodes ?? {})) if (d && !d.created && typeof d.dir === 'string') existing.add(d.dir)
    const live = state.liveSwarm(swarm)
    for (const d of Object.values(live?.launch === launch ? live.dirs : {})) if (!d.created) existing.add(d.dir)
    const ctx = {
      repo: repoOf(litterDir),
      root: await litterWorktreeRoot(p, litterDir),
      cwd: await realOf(p, await p.cwd()),
      records,
      list: await p.listAgents().catch(() => null),
      existing,
      swarm,
    }
    let changed = false
    for (const t of targets) {
      if (!(await p.fs.exists(t.path))) continue
      let outcome: Outcome
      try {
        outcome = await decide(p, ctx, t)
      } catch (err) {
        outcome = { keep: `cleanup couldn't check it (${errText(err)})` }
      }
      if ('keep' in outcome) changed = (await recordKept(p, litterDir, swarm, launch, t, outcome.keep)) || changed
      else {
        await appendLaunchRecord(p, litterDir, swarm, launch, 'swarm.worktree.removed', outcome.removed)
        changed = true
      }
    }
    if (changed && records.some(r => r.kind === 'swarm.end')) {
      await writeSwarmSummary(p, swarm, launch).catch(err => p.log(`swarm ${swarm}: summary.md wasn't written again: ${errText(err)}`))
    }
  })
}

// ---------------------------------------------------------------------------
// What's left: swarm.end's body and summary.md

/**
 * Every worktree of the launch as swarm.end and summary.md list it: each one
 * made, removed or kept with why (one never checked is gone, or not cleaned
 * up yet); one whose making failed after git added it, kept; and each node's
 * `existing` worktree, which is never removed.
 */
async function worktreesLeft(p: Ports, records: readonly StoredRecord[], launch: string, s: LiveSwarm | null): Promise<SwarmWorktreeLeft[]> {
  const out: SwarmWorktreeLeft[] = []
  const seen = new Set<string>()
  for (const t of madeWorktrees(records, launch)) {
    seen.add(t.path)
    if (t.outcome === 'removed') out.push({ path: t.path, branch: t.branch, node: t.node, removed: true })
    else if (t.outcome === 'kept') out.push({ path: t.path, branch: t.branch, node: t.node, removed: false, reason: t.keptReason ?? '' })
    else if (await p.fs.exists(t.path)) out.push({ path: t.path, branch: t.branch, node: t.node, removed: false, reason: 'the cleanup hasn\'t checked it yet' })
    else out.push({ path: t.path, branch: t.branch, node: t.node, removed: true, reason: 'it was gone before the cleanup' })
  }
  // An intent whose worktree git made but whose making then failed (links, setup), or never finished.
  const last = new Map<string, StoredRecord>()
  for (const r of records) {
    if (r.by.source === 'mod' && typeof r.body.path === 'string' && ['swarm.worktree.intent', 'swarm.worktree.failed'].includes(r.kind)) last.set(r.body.path, r)
    if (r.kind === 'swarm.worktree' && typeof r.body.path === 'string') last.delete(r.body.path)
  }
  const intents = new Map(records.filter(r => r.kind === 'swarm.worktree.intent' && typeof r.body.path === 'string').map(r => [r.body.path as string, r]))
  for (const [path, r] of last) {
    if (seen.has(path) || !(await p.fs.exists(path))) continue
    const intent = intents.get(path)
    const why = r.kind === 'swarm.worktree.failed' ? `its making failed at ${String(r.body.step)}: ${String(r.body.reason)}` : "litter's record of making it never finished"
    out.push({ path, branch: String(intent?.body.branch ?? ''), node: String(r.body.node ?? ''), removed: false, reason: why })
    seen.add(path)
  }
  for (const n of s?.spec.nodes ?? []) {
    const d = s?.dirs[n.id]
    if (!d || typeof n.worktree !== 'object' || !('existing' in n.worktree) || seen.has(d.dir)) continue
    seen.add(d.dir)
    out.push({ path: d.dir, branch: d.branch ? short(d.branch) : '', node: n.id, removed: false, reason: 'an existing worktree you named; litter never removes those' })
  }
  return out
}

/** The branches left: every worktree's that wasn't deleted with it, and each instance's bound branch, as they still exist. */
async function branchesLeft(p: Ports, s: LiveSwarm, records: readonly StoredRecord[], left: readonly SwarmWorktreeLeft[]): Promise<string[]> {
  const deleted = new Set(madeWorktrees(records, s.launch).filter(t => t.branchDeleted).map(t => t.branch))
  const names = new Set<string>()
  for (const w of left) if (w.branch !== '' && !deleted.has(w.branch)) names.add(w.branch)
  for (const r of records) if (r.kind === 'swarm.node' && typeof r.body.branch === 'string') names.add(short(r.body.branch))
  for (const d of Object.values(s.dirs)) if (d.branch) names.add(short(d.branch))
  const out: string[] = []
  for (const b of [...names].sort()) if (!deleted.has(b) && BRANCH.test(b) && (await revParse(p, s.commonDir, `refs/heads/${b}`))) out.push(b)
  return out
}

function addTokens(into: TokenCount, t: TokenCount): void {
  into.input += t.input
  into.output += t.output
  into.cacheRead += t.cacheRead
  into.cacheCreation += t.cacheCreation
  into.turns += t.turns
}

/**
 * Each node's instances, last report and tokens (swarm.end's `nodes`): the
 * instances from the `swarm.node` records and the bindings, the last report
 * from the ledger's `report` events, the tokens from the state (a child's
 * count toward its node).
 */
function nodesOf(spec: SwarmSpec | null, records: readonly StoredRecord[], name: string): SwarmEndBody['nodes'] {
  const out: SwarmEndBody['nodes'] = {}
  for (const n of spec?.nodes ?? []) out[n.id] = { agentIds: [], lastReport: null, tokens: zero() }
  const agents = new Map<string, { node: string; kind: string }>()
  for (const r of records) {
    if (r.kind === 'swarm.node' && r.by.source === 'mod' && typeof r.body.agentId === 'string') agents.set(r.body.agentId, { node: String(r.body.node), kind: String(r.body.kind) })
  }
  for (const b of state.bindings(name)) agents.set(b.agentId, { node: b.node, kind: b.kind })
  for (const [id, a] of agents) {
    const row = (out[a.node] ??= { agentIds: [], lastReport: null, tokens: zero() })
    if (a.kind !== 'child' && !row.agentIds.includes(id)) row.agentIds.push(id)
    if (state.binding(id) !== null) addTokens(row.tokens, state.tokens(id))
  }
  for (const r of records) {
    if (r.kind !== 'swarm.event' || r.body.kind !== 'report' || typeof r.body.agentId !== 'string' || typeof r.body.text !== 'string') continue
    const a = agents.get(r.body.agentId)
    if (a && a.kind !== 'child' && out[a.node]) out[a.node]!.lastReport = r.body.text
  }
  return out
}

const quoted = (text: string): string[] => text.split(/\r\n?|\n/).map(l => (l === '' ? '>' : `> ${l}`))
/** A value from git or a record, kept on one line of summary.md: no controls, no line breaks. */
const flat = (v: unknown): string => plainText(String(v)).replace(/\s+/g, ' ').trim()
const count = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

/**
 * Writes `summary.md` in the launch folder (15.8), from the launch ledger and,
 * while the swarm is live, its state: the status, each node with its
 * instances, tokens and last report, the goal history from `swarm.summary`,
 * the worktrees and branches left, and the flags. Its opening lines, up to
 * the first section, are the mod's own facts, never a node's text: that part
 * is what the lead is handed. Answers the file's path. `unrecordedEnd` is
 * End's, for a launch it ended whose broken ledger couldn't take swarm.end.
 */
export async function writeSwarmSummary(p: Ports, swarm: string, launch: string, opts: { unrecordedEnd?: boolean } = {}): Promise<string> {
  const litterDir = needLitterDir()
  const { records, tampered } = await readLaunchLedger(p, litterDir, swarm, launch)
  const start = records.find(r => r.kind === 'swarm.start')?.body as SwarmStartBody | undefined
  const endRec = records.filter(r => r.kind === 'swarm.end').at(-1)
  const end = endRec?.body as SwarmEndBody | undefined
  const stopping = records.find(r => r.kind === 'swarm.stopping')
  const liveNow = state.liveSwarm(swarm)
  const s = liveNow && liveNow.launch === launch ? liveNow : null
  const spec =
    s?.spec ??
    (start ? ((await readJson<SwarmSpec>(p, revisionPath(litterDir, swarm, start.revision)).catch(() => undefined)) ?? null) : null)
  const nodes = end?.nodes ?? nodesOf(spec, records, swarm)
  const made = await worktreesLeft(p, records, launch, s)
  // An existing worktree is listed from the spec while live, and from swarm.end's list after.
  const worktrees = [...made, ...(end?.worktrees ?? []).filter(w => !made.some(m => m.path === w.path))]
  const status = end
    ? end.status === 'launch_failed'
      ? `launch failed${end.reason ? ` (${end.reason})` : ''}`
      : end.settled
        ? `ended, settled${end.reason ? ` (${flat(end.reason)})` : ''}`
        : 'ended without settling: [End, keep everything] ended it while something still ran, so no worktree was removed'
    : opts.unrecordedEnd
      ? 'ended, but its launch ledger is broken, so it holds no swarm.end, and no worktree was removed'
      : stopping
        ? 'stopping'
        : s
          ? 'live'
          : 'not live in this session'
  const total = zero()
  let agents = 0
  for (const n of Object.values(nodes)) {
    addTokens(total, n.tokens)
    agents += n.agentIds.length
  }
  const removed = worktrees.filter(w => w.removed && !w.reason).length
  const kept = worktrees.filter(w => !w.removed).length
  const branches = end?.branches ?? []

  const lines = [`# litter swarm ${swarm}, launch ${launch}`, '']
  lines.push(`- Status: ${status}`)
  if (tampered) lines.push(`- Ledger: tampered at record ${tampered.seq} (${tampered.reason}); nothing from there on is shown`)
  if (start) lines.push(`- Revision: ${start.revision}`)
  lines.push(`- Started: ${iso(records.find(r => r.kind === 'swarm.start')?.at ?? s?.startedAt)}`)
  if (stopping) lines.push(`- Stopping since: ${iso(stopping.at)}, asked by ${String(stopping.body.by)}`)
  if (endRec) lines.push(`- Ended: ${iso(endRec.at)}`)
  lines.push(`- Agents: ${agents} across ${plural(Object.keys(nodes).length, 'node')}; ${count(total.input + total.output)} tokens in and out over ${plural(total.turns, 'turn')}`)
  lines.push(`- Worktrees: ${worktrees.length === 0 ? 'none made' : `${removed} removed, ${kept} kept`}`)
  if (end) lines.push(`- Branches left: ${branches.length > 0 ? branches.join(', ') : 'none'}`)

  if (spec?.goal) lines.push('', '## Goal', '', spec.goal)

  lines.push('', '## Nodes')
  const instance = new Map<string, number>()
  for (const r of records) if (r.kind === 'swarm.node' && typeof r.body.agentId === 'string' && typeof r.body.n === 'number') instance.set(r.body.agentId, r.body.n)
  for (const [id, n] of Object.entries(nodes)) {
    const kind = spec?.nodes.find(x => x.id === id)?.kind
    lines.push('', `### ${id}${kind ? ` (${kind})` : ''}`, '')
    lines.push(
      `- Instances: ${n.agentIds.length === 0 ? 'none ran' : n.agentIds.map(a => (instance.has(a) ? `#${instance.get(a)} ${a}` : a)).join(', ')}`,
      `- Tokens: ${count(n.tokens.input)} in, ${count(n.tokens.output)} out, ${count(n.tokens.cacheRead)} cache read, over ${plural(n.tokens.turns, 'turn')}`,
    )
    if (n.lastReport) lines.push('- Last report:', '', ...quoted(n.lastReport))
    else lines.push('- Last report: none')
  }

  const goals = records.filter(r => r.kind === 'swarm.summary' && typeof r.body.goal === 'string')
  if (goals.length > 0) {
    // The summary model wrote these from the nodes' reports, and the end's hand-off tells the lead
    // to read this file, so they're quoted as the reports are: material, never litter's own lines
    // (15.6: the generated summary is display-only; its goal history goes into this file).
    lines.push('', '## Goal history', '', "The summary model's goal line as it changed, quoted:", '')
    for (const g of goals) lines.push(...quoted(`${iso(g.at)}: ${(g.body as SwarmSummaryBody).goal}`), '')
    lines.pop()
  }

  if (worktrees.length > 0) {
    lines.push('', '## Worktrees', '')
    for (const w of worktrees) {
      const at = `${flat(w.path)}${w.branch ? ` (branch ${flat(w.branch)})` : ''}, ${flat(w.node)}`
      lines.push(w.removed ? `- Removed: ${at}${w.reason ? `: ${flat(w.reason)}` : ''}` : `- Kept: ${at}: ${w.reason ? flat(w.reason) : 'kept'}`)
    }
  }
  if (end) lines.push('', '## Branches left', '', ...(branches.length > 0 ? branches.map(b => `- ${b}`) : ['- none']))

  const events = records.filter(r => r.kind === 'swarm.event')
  const acked = new Set(events.filter(r => r.body.kind === 'branch-moved-ack').map(r => r.body.seq))
  const flags = events.filter(r => ['branch-moved', 'rule-commit', 'head-moved', 'worker-ended-early', 'isolation-lost', 'report-to-lead'].includes(String(r.body.kind)))
  if (flags.length > 0) {
    lines.push('', '## Flags', '')
    for (const r of flags) {
      const b = r.body
      const who = typeof b.node === 'string' ? ` (${b.node})` : ''
      // Refs and file names are the repository's: each stays on its line.
      if (b.kind === 'branch-moved') {
        lines.push(`- ${iso(r.at)} branch-moved: ${flat(short(String(b.ref)))} ${flat(b.from ?? 'new')} -> ${flat(b.to ?? 'deleted')}${acked.has(r.seq) ? ', acknowledged' : ''}`)
      } else if (b.kind === 'rule-commit') {
        lines.push(`- ${iso(r.at)} rule-commit${who}: ${(Array.isArray(b.files) ? b.files : []).slice(0, 10).map(flat).join(', ')}; not your acceptance`)
      } else lines.push(`- ${iso(r.at)} ${flat(b.kind)}${who}`)
    }
    const denials = events.filter(r => r.body.kind === 'denied').length
    if (denials > 0) lines.push(`- ${plural(denials, 'guard denial')} in all`)
  }
  lines.push('')
  const path = launchSummaryPath(litterDir, swarm, launch)
  await atomicWrite(p, path, lines.join('\n'))
  return path
}

/** For tests: cancels every settle wait and the sweep, and forgets them. */
export function resetEndForTests(): void {
  for (const w of waits.values()) w.timer?.cancel()
  waits.clear()
  sweepTimer?.cancel()
  sweepTimer = null
  sweeping = false
  lastBeat = 0
  kept.clear()
}
