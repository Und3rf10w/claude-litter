// The swarm's own worktrees (plan 15.3's `new` and `own`, 15.4 Launch step 3
// and "The spawn check"): made intent-first like the run worktrees (section 9,
// "An unfinished request"), recorded in the launch ledger, and the facts P's
// cleanup decides on. Built on worktrees.ts's helpers, which do the git steps
// and the replay checks exactly as for a run.
//
// Contract owner: phase 2b-1, package C. K calls addSwarmWorktree for each
// `new` worktree at Launch, L for each `own` instance at spawn, and P calls
// inspectWorktree before removing one.

import type { Ports } from '../ports'
import type { LitterOptions } from '../options'
import type { StoredRecord } from '../records/core'
import type { ModWorktreeSpec } from '../worktrees'
import type { SwarmWorktreeBody, SwarmWorktreeFailedBody, SwarmWorktreeIntentBody } from '../records/swarm'
import {
  BRANCH,
  cleanAbsolute,
  commitsPast,
  errText,
  firstLine,
  git,
  isAncestor,
  linkDirs,
  listedAt,
  listWorktrees,
  newIgnored,
  OID,
  place,
  realOf,
  replayCheck,
  revParse,
  runSetup,
  setupEnded,
  statusOf,
} from '../worktrees'
import { appendLaunchRecord, readLaunchLedger } from '../records/swarm'
import {
  launchDir,
  launchRun,
  LAUNCH_ID,
  NODE_ID,
  setupLogPart,
  SWARM_NAME,
  swarmNewWorktreeName,
  swarmOwnWorktreeName,
  verifyLogDir,
} from '../layout'
import { serial } from '../fsx'
import { shellQuote } from '../quote'

/** What addSwarmWorktree makes: a `new` node's worktree (no `n`), or an `own` worker instance's. */
export type SwarmWorktreeSpec = {
  swarm: string
  launch: string
  node: string
  /** An `own` instance's number; absent for a `new` worktree. */
  n?: number
  /**
   * Absolute, and exactly `<worktreeRoot>/<name>` with layout.ts's name:
   * `swarmNewWorktreeName(swarm, node)`, or `swarmOwnWorktreeName(swarm, node, n)`.
   */
  path: string
  /**
   * The swarm's worktree root (`LiveSwarm.worktreeRoot`, as `swarm.start` records it).
   * C's choice: the brief's spec has no root, and "refuse any other path" needs one.
   */
  worktreeRoot: string
  /** Short name: the spec's `new.branch`, or `swarmOwnBranch(swarm, node, n)`. Checked with `git check-ref-format --branch`. */
  branch: string
  /** A commit id, or a ref resolved here with `rev-parse --verify --end-of-options <from>^{commit}`. */
  from: string
  /** The checkout to add it from, and linkDirs' source. */
  repo: string
  /** The approved setup argv, run in the new worktree; null for none. */
  setup: string[] | null
  linkDirs: string[]
}

export type SwarmWorktreeMade =
  | { ok: true; path: string; branch: string; from: string; ignored: string[] }
  | { ok: false; reason: string }

const WORKTREE_KINDS: readonly string[] = ['swarm.worktree.intent', 'swarm.worktree', 'swarm.worktree.failed']

type StepRecord = StoredRecord<SwarmWorktreeIntentBody & Record<string, unknown>>

/** The mod's intent, made and failed records for one path in this launch, in order. */
function stepsFor(records: readonly StoredRecord[], path: string): StepRecord[] {
  return records.filter(r => WORKTREE_KINDS.includes(r.kind) && r.by.source === 'mod' && r.body.path === path) as StepRecord[]
}

const ignoredOf = (body: Record<string, unknown>): string[] =>
  Array.isArray(body.ignored) ? body.ignored.filter((x): x is string => typeof x === 'string') : []

/** The spec's names and paths, before anything else; null when they're fine. */
function shapeProblem(spec: SwarmWorktreeSpec): string | null {
  if (typeof spec.swarm !== 'string' || !SWARM_NAME.test(spec.swarm)) return `'swarm' isn't a swarm name`
  if (typeof spec.launch !== 'string' || !LAUNCH_ID.test(spec.launch)) return `'launch' isn't a launch id`
  if (typeof spec.node !== 'string' || !NODE_ID.test(spec.node)) return `'node' isn't a node id`
  if (spec.n !== undefined && (!Number.isInteger(spec.n) || spec.n < 1)) return `'n' isn't an instance number`
  return null
}

/** The rest of the spec; null when it's fine. */
function specProblem(spec: SwarmWorktreeSpec): string | null {
  if (typeof spec.worktreeRoot !== 'string' || !cleanAbsolute(spec.worktreeRoot)) return `the worktree root ${String(spec.worktreeRoot)} isn't a clean absolute path`
  const name = spec.n === undefined ? swarmNewWorktreeName(spec.swarm, spec.node) : swarmOwnWorktreeName(spec.swarm, spec.node, spec.n)
  if (spec.path !== `${spec.worktreeRoot}/${name}`) return `the path ${String(spec.path)} isn't ${spec.worktreeRoot}/${name}`
  if (typeof spec.branch !== 'string' || !BRANCH.test(spec.branch)) return `the branch '${String(spec.branch)}' isn't one the mod makes`
  if (typeof spec.from !== 'string' || spec.from === '' || /[\0-\x1f]/.test(spec.from) || spec.from.startsWith('-')) return `'from' isn't a commit or a ref`
  if (typeof spec.repo !== 'string' || !cleanAbsolute(spec.repo)) return `the repository ${String(spec.repo)} isn't a clean absolute path`
  if (spec.setup !== null && (!Array.isArray(spec.setup) || spec.setup.length === 0 || spec.setup.some(a => typeof a !== 'string'))) {
    return "'setup' isn't an argv"
  }
  if (!Array.isArray(spec.linkDirs) || spec.linkDirs.some(d => typeof d !== 'string')) return "'linkDirs' isn't a list of folders"
  return null
}

/**
 * Makes a `new` or `own` worktree, recorded in the launch ledger (15.4):
 *  1. `swarm.worktree.intent` before `git worktree add`;
 *  2. linkDirs, or the setup argv under `options.verifyTimeoutMs` (its log in
 *     the launch folder's `verify/setup-<name>/`);
 *  3. `swarm.worktree { …, created_by: <launch>, ignored }`, with the ignored
 *     paths the setup left.
 * A failure after the checks records `swarm.worktree.failed` with the step and
 * the reason, and answers `{ ok: false, reason }`. A replay of the same path
 * finishes an intent without an outcome, reuses a made one that passes
 * worktrees.ts's replay checks, and blocks with the facts otherwise, under the
 * rules addModWorktree follows; it never fails on a branch it made itself.
 * Resolves the worktree's resolved path and the commit it was made from.
 */
export async function addSwarmWorktree(
  p: Ports,
  litterDir: string,
  options: LitterOptions,
  spec: SwarmWorktreeSpec,
): Promise<SwarmWorktreeMade> {
  const shape = shapeProblem(spec)
  if (shape) return { ok: false, reason: `litter: can't make a swarm worktree: ${shape}` }
  const where = launchDir(litterDir, spec.swarm, spec.launch)
  if (!(await p.fs.exists(where))) return { ok: false, reason: `litter: can't make a swarm worktree: launch ${spec.launch} of ${spec.swarm} doesn't exist` }
  return serial(`swarm-worktree:${where}:${String(spec.path)}`, () => makeSwarmWorktree(p, litterDir, options, spec))
}

async function makeSwarmWorktree(p: Ports, litterDir: string, options: LitterOptions, spec: SwarmWorktreeSpec): Promise<SwarmWorktreeMade> {
  const at = spec.n === undefined ? {} : { n: spec.n }
  const refuse = (reason: string): SwarmWorktreeMade => ({ ok: false, reason: `litter: the worktree for ${spec.node} at ${String(spec.path)}: ${reason}` })
  const failed = async (step: SwarmWorktreeFailedBody['step'], reason: string, log?: string): Promise<SwarmWorktreeMade> => {
    const body: SwarmWorktreeFailedBody = { node: spec.node, ...at, path: String(spec.path), step, reason, ...(log ? { log } : {}) }
    await appendLaunchRecord(p, litterDir, spec.swarm, spec.launch, 'swarm.worktree.failed', body)
    return refuse(reason)
  }

  const { records, tampered } = await readLaunchLedger(p, litterDir, spec.swarm, spec.launch)
  if (tampered) return refuse(`launch ${spec.launch}'s ledger is tampered at record ${tampered.seq}`)

  // The checks, before git touches anything.
  const bad = specProblem(spec)
  if (bad) return failed('check', bad)
  const format = await git(p, spec.repo, ['check-ref-format', '--branch', spec.branch])
  if (format.code !== 0 || format.stdout.trim() !== spec.branch) return failed('check', `git won't take '${spec.branch}' as a branch name`)
  const resolved = await git(p, spec.repo, ['rev-parse', '--verify', '--end-of-options', `${spec.from}^{commit}`])
  const from = resolved.code === 0 ? resolved.stdout.trim() : ''
  if (!OID.test(from)) return failed('check', `'${spec.from}' doesn't name a commit in ${spec.repo}: ${firstLine(resolved.stderr)}`)

  // A replay names the same node, branch and commit as the records; a ref that moved since is refused with the facts.
  const steps = stepsFor(records, spec.path)
  const differs = steps.find(s => s.kind !== 'swarm.worktree.failed' && (s.body.node !== spec.node || s.body.n !== spec.n || s.body.branch !== spec.branch || s.body.from !== from))
  if (differs) return refuse(`the launch ledger records it for ${String(differs.body.node)} on ${String(differs.body.branch)} from ${String(differs.body.from)}`)
  const last = steps.at(-1)
  const created = steps.some(s => s.kind === 'swarm.worktree')
  // worktrees.ts's helpers take a run worktree's spec: the launch stands in for the run.
  const name = spec.path.slice(spec.worktreeRoot.length + 1)
  const mws: ModWorktreeSpec = {
    run: launchRun(spec.swarm, spec.launch),
    name,
    path: spec.path,
    branch: spec.branch,
    base: from,
    disposable: false,
    runDir: launchDir(litterDir, spec.swarm, spec.launch),
    checkout: spec.repo,
    setup: spec.setup,
    linkDirs: spec.linkDirs,
  }
  if (last?.kind === 'swarm.worktree') {
    const again = await replayCheck(p, mws)
    if (again === 'reuse') return { ok: true, path: await realOf(p, spec.path), branch: spec.branch, from, ignored: ignoredOf(last.body) }
    if (again !== 'gone') return refuse(again)
  }

  // The intent before git touches anything: a first request, or a made worktree that's gone and is added again.
  const intent: SwarmWorktreeIntentBody = { node: spec.node, ...at, path: spec.path, branch: spec.branch, from }
  if (!last || last.kind === 'swarm.worktree') await appendLaunchRecord(p, litterDir, spec.swarm, spec.launch, 'swarm.worktree.intent', intent)
  try {
    const blocked = await place(p, mws, created)
    if (blocked) return failed('add', blocked)
    const head = await revParse(p, spec.path, 'HEAD')
    if (!head) return failed('add', "its HEAD doesn't resolve")
    if (!created && head !== from) return failed('add', `its HEAD is ${head}, not ${from}`)
    if (created && (await isAncestor(p, spec.repo, from, head)) !== true) return failed('add', `${from} isn't an ancestor of its HEAD ${head}`)

    const links = await linkDirs(p, mws)
    if (links) return failed('links', links)
    if (spec.setup) {
      const end = await runSetup(p, spec.setup, mws, options.verifyTimeoutMs)
      if (end.spawn_error !== null || end.timed_out || end.exit_code !== 0) {
        const log = setupLogPart(mws.runDir, name)
        const shown = end.parts > 1 ? `the parts in ${verifyLogDir(mws.runDir, `setup-${name}`)}` : log
        return failed('setup', `the setup command ${shellQuote(spec.setup)} ${setupEnded(end)}; its output is in ${shown}`, log)
      }
    }
    const st = await statusOf(p, spec.path)
    if (!st) return failed('setup', 'git status failed in it after the setup')
    const made: SwarmWorktreeBody = { ...intent, created_by: spec.launch, ignored: st.ignored }
    await appendLaunchRecord(p, litterDir, spec.swarm, spec.launch, 'swarm.worktree', made)
    return { ok: true, path: await realOf(p, spec.path), branch: spec.branch, from, ignored: st.ignored }
  } catch (err) {
    // A git call that couldn't run or ran out of time: the intent still gets its outcome.
    return failed('add', `making it failed: ${errText(err)}`)
  }
}

/** The facts P's cleanup decides on (15.4, "Cleanup removes only worktrees this launch created"). Null: git couldn't tell. */
export type WorktreeFacts = {
  /** `git worktree list` shows it (matched resolved); null when the list failed. */
  listed: boolean | null
  /** The full ref it's checked out on, or null (detached, or not listed). */
  checkedOut: string | null
  /** Commits on `branch` past `from`. */
  commitsPast: number | null
  /** Uncommitted changes, `git status --porcelain` paths. */
  changes: string[] | null
  /** Ignored paths beyond those its setup left (`ignoredAtSetup`, from `swarm.worktree`). */
  newIgnored: string[] | null
}

/**
 * The facts about one swarm worktree, from worktrees.ts's helpers: whether
 * it's listed, its commits past `from` (on `branch`, a short name), its
 * changes, and its ignored paths beyond `ignoredAtSetup`. It changes nothing.
 */
export async function inspectWorktree(
  p: Ports,
  repo: string,
  path: string,
  branch: string,
  from: string,
  ignoredAtSetup: readonly string[],
): Promise<WorktreeFacts> {
  const list = await listWorktrees(p, repo)
  const at = list ? await listedAt(p, list, path) : undefined
  const there = at !== undefined && (await p.fs.exists(path))
  const past = BRANCH.test(branch) && OID.test(from) ? await commitsPast(p, repo, from, branch) : null
  const st = there ? await statusOf(p, path) : null
  return {
    listed: list ? there : null,
    checkedOut: at?.branch ?? null,
    commitsPast: past,
    changes: st ? st.changes : null,
    newIgnored: st ? newIgnored(st.ignored, ignoredAtSetup) : null,
  }
}
