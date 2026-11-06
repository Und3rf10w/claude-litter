// Ended workers' `own` worktrees, removed while their swarm runs. A long
// swarm starts a worker per task, each in a worktree of its own, and a
// worktree of a large repository with its dependencies installed takes
// gigabytes: the cleanup at the swarm's end (end.ts, cleanupLaunch) comes too
// late for the disk. So once a worker's instance has ended and nothing of its
// work lives only in its worktree, the worktree goes:
//  - ended: it holds no place (not running, settling or parked, no resume
//    reserved), the agent list shows it ended or doesn't show it, it has been
//    so for RECLAIM_GRACE_MS (its parent may still send it more), and nothing
//    else works there (end.ts's usersOf: a child, a shell, a reserved spawn;
//    and neither the session's directory nor the lead's is in it);
//  - nothing only there: `git status` shows nothing uncommitted or
//    untracked, no ignored path looks like a secret (keptIgnored: an `.env`,
//    a key), and its branch has no commits past `from`, or its tip is in its
//    parent's branch (the parent merged it).
// Ignored dependencies and build output go with it. The branch stays, so a
// parent's `git merge <branch>` still works and nothing committed is lost;
// `git worktree remove` runs without --force, so git checks once more itself.
// `swarm.worktree.removed` records it with its reason (`ended-unchanged`,
// `ended-merged`). From the moment it's chosen, a send, a wake or a resume of
// the instance (or of a child that worked there) is refused (admit.ts, through
// state.retiredDir), telling the parent to spawn a new one. An ended worker
// whose worktree is already gone (removed outside litter) is refused the same
// way, with nothing recorded.
//
// Never inside a hook: the pass runs from a timer, a few seconds after the
// settle poll frees an instance (admit.ts), and about once a minute while a
// swarm with `own` workers runs (clear.ts's tick). One pass at a time, sharing
// the launch's cleanup key with cleanupLaunch, and at most RECLAIM_MAX
// worktrees looked at per pass; one kept is looked at again once its branch or
// its parent's moves, or after RECHECK_MS.

import type { ListedAgent, Ports } from '../ports'
import type { StoredRecord } from '../records/core'
import type { SwarmWorktreeRemovedBody } from '../records/swarm'
import type { LiveSwarm, NodeBinding } from './types'
import { agentLive } from '../ports'
import { appendLaunchRecord, readLaunchLedger } from '../records/swarm'
import { swarmOwnWorktreeName } from '../layout'
import { serial } from '../fsx'
import { session } from '../session'
import { repoOf } from '../lifecycle'
import { cleanAbsolute, errText, firstLine, git, isAncestor, litterWorktreeRoot, OID, realOf, revParse } from '../worktrees'
import { inspectWorktree, keptIgnored, parentBranchOf, removedForms } from './worktrees'
import { cleanupKey, madeWorktrees, usersOf, type Made } from './end'
import * as state from './state'

/** A pass this long after the settle poll freed an instance. */
export const RECLAIM_DELAY_MS = 5_000
/** And one at least this often while a swarm with `own` workers runs. */
export const RECLAIM_EVERY_MS = 60_000
/** An instance ended this long before its worktree goes: its parent may still send it more. */
export const RECLAIM_GRACE_MS = 2 * 60_000
/** At most this many worktrees looked at with git per pass. */
export const RECLAIM_MAX = 8
/** A worktree kept is looked at again after this, even when no branch moved (a change may have gone). */
export const RECHECK_MS = 10 * 60_000
/** Removing a worktree full of dependencies takes a while: up to the engine's 10 minutes. */
const SLOW_GIT_MS = 600_000

type Choice =
  | { keep: string }
  /** Removed outside litter: nothing to remove or record, but its instance can't run there again either. */
  | { gone: true }
  | { remove: { reason: 'ended-unchanged' | 'ended-merged'; mergedInto: string | null; real: string } }

let pending: { cancel(): void } | null = null
let passing: Promise<void> | null = null
let lastPass: number | null = null
/** agentId → when a pass first saw its instance ended (RECLAIM_GRACE_MS counts from it). */
const endedSince = new Map<string, number>()
/** A worktree's path → the branch tips its last check kept it at, and when. */
const kept = new Map<string, { sig: string; at: number }>()

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`)
const short = (ref: string): string => ref.replace(/^refs\/heads\//, '')
const label = (b: NodeBinding): string => `${b.node} #${b.n} (${b.agentId})`

/** A swarm the pass looks at: this session's, running (at its end the cleanup takes over), with `own` workers. */
const reclaims = (s: LiveSwarm): boolean => !s.readOnly && !s.lost && s.state === 'live' && s.spec.nodes.some(n => n.worktree === 'own')

/** A pass in RECLAIM_DELAY_MS, unless one is due already or no swarm has `own` workers. */
export function scheduleReclaim(p: Ports, delayMs = RECLAIM_DELAY_MS): void {
  if (pending || !state.liveSwarms().some(reclaims)) return
  pending = p.after(delayMs, () => {
    pending = null
    void reclaimNow(p)
  })
}

/** clear.ts's 2 s tick: a pass once RECLAIM_EVERY_MS has gone by since the last one began. */
export async function reclaimTick(p: Ports): Promise<void> {
  if (passing || !state.liveSwarms().some(reclaims)) return
  const now = await p.now()
  if (lastPass !== null && now - lastPass < RECLAIM_EVERY_MS) return
  await reclaimNow(p)
}

/** One pass now, or the one under way. Never rejects. */
export function reclaimNow(p: Ports): Promise<void> {
  if (passing) return passing
  const run = (async () => {
    try {
      lastPass = await p.now()
      await pass(p)
    } catch (err) {
      p.log(`swarm worktree reclaim failed: ${errText(err)}`)
    } finally {
      passing = null
    }
  })()
  passing = run
  return run
}

async function pass(p: Ports): Promise<void> {
  const litterDir = session().litterDir
  if (!litterDir) return
  // Recovery or a rebind holds the gate: the tables aren't whole yet.
  if (!(await state.ready(p, 0).then(() => true, () => false))) return
  const budget = { left: RECLAIM_MAX }
  for (const s of state.liveSwarms().filter(reclaims)) {
    if (budget.left <= 0) return
    await serial(cleanupKey(litterDir, s.name, s.launch), () => swarmPass(p, litterDir, s.name, budget))
  }
}

/** The worker instance an `own` worktree was made for. */
const instanceOf = (swarm: string, t: Made): NodeBinding | null =>
  state.bindings(swarm).find(b => b.kind === 'worker' && b.node === t.node && b.n === t.n) ?? null

/** It holds no place, and the list shows it ended or doesn't show it. */
function ended(b: NodeBinding, listed: Map<string, ListedAgent>): boolean {
  if (state.status(b.agentId) !== 'idle' || state.isParked(b.agentId)) return false
  if (state.reservations().some(r => r.agentId === b.agentId)) return false
  const row = listed.get(b.agentId)
  return row === undefined || !agentLive(row.status)
}

/** The parent's bound branch, a full ref: from its binding, else the records. */
function parentRefOf(b: NodeBinding, records: readonly StoredRecord[], t: Made): string | null {
  const id = state.parentOf(b)
  const parent = id === null ? null : state.binding(id)
  return parent?.branch ?? parentBranchOf(records, t.node, t.n)
}

/** `refs/heads/<name>` → oid for every local branch, in one git call; empty when git can't list them. */
async function tipsOf(p: Ports, commonDir: string): Promise<Map<string, string>> {
  const r = await git(p, commonDir, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads'])
  const out = new Map<string, string>()
  if (r.code !== 0) return out
  for (const row of r.stdout.split('\n')) {
    const [ref, oid] = row.split('\0')
    if (ref && oid && OID.test(oid)) out.set(ref, oid)
  }
  return out
}

type Ctx = { repo: string; root: string; cwd: string; records: readonly StoredRecord[]; list: ListedAgent[] }

async function swarmPass(p: Ports, litterDir: string, name: string, budget: { left: number }): Promise<void> {
  const s = state.liveSwarm(name)
  if (!s || !reclaims(s)) return
  const { records, tampered } = await readLaunchLedger(p, litterDir, s.name, s.launch)
  if (tampered) return
  const own = madeWorktrees(records, s.launch).filter(t => t.n !== undefined && t.outcome !== 'removed')
  if (own.length === 0) return
  const list = await p.listAgents().catch(() => null)
  if (!list) return
  const listed = new Map(list.map(a => [a.id, a]))
  const now = await p.now()
  let tips: Map<string, string> | null = null
  let ctx: Ctx | null = null
  for (const t of own) {
    if (budget.left <= 0) return
    const b = instanceOf(s.name, t)
    if (!b) continue
    if (!ended(b, listed)) {
      endedSince.delete(b.agentId)
      continue
    }
    const since = endedSince.get(b.agentId)
    if (since === undefined) {
      endedSince.set(b.agentId, now)
      continue
    }
    if (now - since < RECLAIM_GRACE_MS) continue
    tips ??= await tipsOf(p, s.commonDir)
    const parentRef = parentRefOf(b, records, t)
    const sig = `${tips.get(`refs/heads/${t.branch}`) ?? ''} ${parentRef === null ? '' : (tips.get(parentRef) ?? '')}`
    const last = kept.get(t.path)
    if (last && last.sig === sig && now - last.at < RECHECK_MS) continue
    budget.left--
    ctx ??= { repo: repoOf(litterDir), root: await litterWorktreeRoot(p, litterDir), cwd: await realOf(p, await p.cwd()), records, list }
    let choice: Choice
    try {
      choice = await choose(p, ctx, s, t, parentRef)
    } catch (err) {
      choice = { keep: `the check failed: ${errText(err)}` }
    }
    if ('keep' in choice) {
      kept.set(t.path, { sig, at: now })
      continue
    }
    if ('gone' in choice) {
      const paths = await removedForms(p, t.path)
      if (stillEnded(s, b, paths) && state.retiredDir(s.name, t.path) === null) {
        state.retire(s.name, ...paths)
        p.log(`swarm ${s.name}: ${label(b)}'s worktree ${t.path} is gone (removed outside litter); it can't run again`)
      }
      kept.set(t.path, { sig, at: now })
      continue
    }
    if (!(await removeOne(p, litterDir, ctx.repo, s, t, b, choice.remove))) kept.set(t.path, { sig, at: now })
  }
}

/** Whether the worktree can go now, from git and the state; it changes nothing. */
async function choose(p: Ports, ctx: Ctx, s: LiveSwarm, t: Made, parentRef: string | null): Promise<Choice> {
  const name = swarmOwnWorktreeName(s.name, t.node, t.n!)
  if (!cleanAbsolute(t.path) || t.path !== `${ctx.root}/${name}`) return { keep: `it isn't at ${ctx.root}/${name}` }
  if (!(await p.fs.exists(t.path))) return { gone: true }
  const real = await realOf(p, t.path)
  const lead = state.leadCwd()
  for (const dir of [ctx.cwd, ...(lead === null ? [] : [lead])]) {
    if (inside(dir, real) || inside(dir, t.path)) return { keep: "the session's or the lead's directory is inside it" }
  }
  const users = usersOf(ctx.records, s.name, ctx.list, t.path, real)
  if (users.length > 0) return { keep: `it's still in use: ${users.join('; ')}` }
  if (!OID.test(t.from)) return { keep: 'its record names no commit it was made from' }
  const f = await inspectWorktree(p, ctx.repo, t.path, t.branch, t.from, t.ignored)
  if (f.listed !== true) return { keep: "git doesn't list it" }
  if (f.checkedOut !== `refs/heads/${t.branch}`) return { keep: `it isn't on ${t.branch}` }
  if (f.changes === null || f.newIgnored === null) return { keep: 'git status failed in it' }
  if (f.changes.length > 0) return { keep: 'it holds uncommitted changes' }
  if (keptIgnored(f.newIgnored).length > 0) return { keep: 'it holds ignored files that look like secrets' }
  if (f.commitsPast === null) return { keep: `git can't compare ${t.branch} with ${t.from}` }
  if (f.commitsPast === 0) return { remove: { reason: 'ended-unchanged', mergedInto: null, real } }
  if (parentRef === null) return { keep: 'its parent has no branch to hold its commits' }
  const tip = await revParse(p, ctx.repo, `refs/heads/${t.branch}`)
  if (tip === null) return { keep: `${t.branch} doesn't resolve` }
  if ((await isAncestor(p, ctx.repo, tip, parentRef)) !== true) return { keep: `its commits aren't in ${short(parentRef)}` }
  return { remove: { reason: 'ended-merged', mergedInto: short(parentRef), real } }
}

/**
 * Nothing has taken the instance or its worktree since the checks: read in
 * the same synchronous step as the mark that refuses its sends and wakes.
 */
function stillEnded(s: LiveSwarm, b: NodeBinding, paths: readonly string[]): boolean {
  const cur = state.liveSwarm(s.name)
  if (!cur || !reclaims(cur) || cur.launch !== s.launch || state.binding(b.agentId) === null) return false
  if (state.status(b.agentId) !== 'idle' || state.isParked(b.agentId)) return false
  const there = (dir: string) => paths.some(path => inside(dir, path))
  if (state.reservations().some(r => r.agentId === b.agentId || (r.scope !== null && r.scope !== undefined && there(r.scope.dir)))) return false
  return !state.bindings(s.name).some(x => there(x.cwd) && (state.status(x.agentId) !== 'idle' || state.isParked(x.agentId)))
}

/** Marks it retired, removes it, and records it; false (and the mark undone) when git refused. */
async function removeOne(p: Ports, litterDir: string, repo: string, s: LiveSwarm, t: Made, b: NodeBinding, r: Extract<Choice, { remove: unknown }>['remove']): Promise<boolean> {
  const paths = [...new Set([t.path, r.real])]
  if (!stillEnded(s, b, paths)) return false
  state.retire(s.name, ...paths)
  let why: string | null = null
  try {
    const rm = await git(p, repo, ['worktree', 'remove', '--', t.path], SLOW_GIT_MS)
    if (rm.code !== 0) why = firstLine(rm.stderr)
  } catch (err) {
    why = errText(err)
  }
  if (why !== null) {
    // Something git saw that the checks didn't (a file written meanwhile, a lock): it stays, and may run again.
    state.unretire(s.name, ...paths)
    p.log(`swarm ${s.name}: ${label(b)}'s worktree ${t.path} wasn't removed: ${why}`)
    return false
  }
  endedSince.delete(b.agentId)
  const body: SwarmWorktreeRemovedBody = { path: t.path, branch: t.branch, branchDeleted: false, reason: r.reason, ...(r.mergedInto !== null ? { mergedInto: r.mergedInto } : {}) }
  try {
    await appendLaunchRecord(p, litterDir, s.name, s.launch, 'swarm.worktree.removed', body)
  } catch (err) {
    p.log(`swarm ${s.name}: ${label(b)}'s worktree ${t.path} was removed, but not recorded: ${errText(err)}`)
  }
  p.log(`swarm ${s.name}: removed ${label(b)}'s worktree ${t.path} (${r.reason}); its branch ${t.branch} stays`)
  return true
}

export function resetReclaimForTests(): void {
  pending?.cancel()
  pending = null
  passing = null
  lastPass = null
  endedSince.clear()
  kept.clear()
}
