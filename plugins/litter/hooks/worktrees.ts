// The mod's side of the run worktrees (plan section 9, "Run worktrees"):
// worktree.sh's spooled steps into the ledger, the worktrees the mod makes
// itself, worktree.json for your own worktrees, and cleanup after run.end.
// Owner: phase 2b, work package F. The signatures are the contract; the
// bodies are F's.

import type { Ports } from './ports'
import type { LitterOptions } from './options'
import type { SpoolConsumer } from './hookfiles'
import type { StoredRecord } from './records/core'
import type { RunStatus } from './records/run'
import type { WorktreeBody, WorktreeCreateBody } from './records/fanout'

/** A run's handle, as lifecycle.ts passes it. */
export type WorktreeRun = { run: string; runDir: string; litterDir: string }

/**
 * Spool consumer: worktree.sh's `worktree` lines become `worktree.intent`,
 * `worktree.create` and `worktree.setup_failed` records in the named run's
 * ledger (by the mod, once per step and name), and each created path joins
 * policy.json's `roots.worktrees`. A line for a run that isn't this
 * litterDir's, or whose path isn't `<worktreeRoot>/<name>`, is logged and
 * skipped.
 */
export const consumeWorktrees: SpoolConsumer = async (_ctx, line) => {
  if (line.ev !== 'worktree') return
  throw new Error('worktrees.consumeWorktrees: not built yet (phase 2b, package F)')
}

/** The run's worktrees with a `worktree.create` (the latest per name), from its records. */
export function recordedWorktrees(_records: readonly StoredRecord[]): WorktreeCreateBody[] {
  throw new Error('worktrees.recordedWorktrees: not built yet (phase 2b, package F)')
}

/** What the mod needs to make one worktree itself: the integration worktree, or the run worktree. */
export type ModWorktreeSpec = WorktreeBody & {
  runDir: string
  /** The run's checkout: the repository to add the worktree from, and linkDirs' source. */
  checkout: string
  setup: string[] | null
  linkDirs: string[]
}

/**
 * Makes a worktree the way worktree.sh makes a litter one, recorded straight
 * into the ledger: a first request (intent, `git worktree add -b`, HEAD at
 * base, setup or linkDirs, create), an unfinished one (intent without create:
 * finished without `-b`), or a replay (create recorded: reused after the
 * ancestry checks). Anything else is refused with the facts. Resolves the
 * created path, resolved, and the ignored paths the setup left.
 */
export async function addModWorktree(
  _p: Ports,
  _options: LitterOptions,
  _spec: ModWorktreeSpec,
): Promise<{ ok: true; path: string; ignored: string[] } | { ok: false; reason: string }> {
  throw new Error('worktrees.addModWorktree: not built yet (phase 2b, package F)')
}

/**
 * Writes worktree.json from the merged settings (`worktree.baseRef`,
 * `worktree.symlinkDirectories`) now, and again whenever a 30 s check finds
 * them changed. Called once per session.start; a later call replaces the timer.
 */
export async function startWorktreePolicy(_p: Ports, _litterDir: string): Promise<void> {
  // Not built yet (phase 2b, package F). A no-op, since session.start calls it.
}

/**
 * Cleanup after a generation's run.end (plan section 9, "Cleanup is the
 * mod's"), before summary.md is written. A resumable end (RESUMABLE) keeps
 * everything. Otherwise: disposable worktrees are discarded, merged writers'
 * of a landed fanout and unchanged ones are removed without --force, and the
 * rest are kept; each outcome is recorded as `worktree.removed` or
 * `worktree.kept`.
 */
export async function cleanupRun(_p: Ports, _run: WorktreeRun, _status: RunStatus): Promise<void> {
  // Not built yet (phase 2b, package F). A no-op, since endRun calls it.
}

/** At session.start: recorded worktrees of ended runs still on disk get the same cleanup. */
export async function cleanupLeftovers(_p: Ports, _litterDir: string): Promise<void> {
  // Not built yet (phase 2b, package F). A no-op, since session.start calls it.
}

/** summary.md's worktree lines: what was kept and why, with paths. Empty when nothing was. */
export function worktreeSummary(_records: readonly StoredRecord[]): string[] {
  return []
}
