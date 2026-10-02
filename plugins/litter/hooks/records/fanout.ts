// Record bodies for a fanout's worktrees, its integration and its writers'
// results (plan section 7, fanout.js; section 9, "Run worktrees"). Owner:
// phase 2a; work packages F (worktrees, binding) and G (integrate, land)
// refine their own types here. Other packages import only the names below.

/** The run's worktree records, the same body for each step (section 9, "Run worktrees"). */
export type WorktreeBody = {
  run: string
  /** The engine's name for it (`<workflowRunId>-<n>`), or the mod's own (`litter-<run>`, `litter-<run>-integration`). */
  name: string
  /** Absolute and resolved (`pwd -P`): exactly the path worktree.sh printed. */
  path: string
  /** Without `refs/heads/`. */
  branch: string
  base: string
  /** A design run's prober worktrees: discarded after run.end (section 9, "Disposable worktrees"). */
  disposable: boolean
  /**
   * On a record made from worktree.sh's spool line: the line's session and
   * time, so the same line drained twice is recognised and changes nothing.
   * The mod's own worktrees have none.
   */
  spooled?: { session_id: string; ts: number }
}

/** `worktree.create`: the top-level ignored paths the setup left, which cleanup may delete later. */
export type WorktreeCreateBody = WorktreeBody & { ignored: string[] }

/** `worktree.setup_failed`: the setup's log (absolute, under the run's `verify/setup-<name>/`). */
export type WorktreeSetupFailedBody = WorktreeBody & { exit_code: number | null; timed_out: boolean; log: string }

/**
 * `worktree.removed` and `worktree.kept`, by cleanup after run.end (section 9, "Cleanup is the mod's").
 * `branch_kept` says why the branch stayed after its worktree went: the run's own `litter/<run>`, or git refusing.
 */
export type WorktreeRemovedBody = { name: string; path: string; branch: string; forced: boolean; branch_kept?: string }
export type WorktreeKeptBody = { name: string; path: string; branch: string; reason: string }

/** A bound writer's worktree, as `task.bind` and `agents/<agent_id>.json` carry it. */
export type BoundWorktree = { name: string; path: string; branch: string }

/**
 * `task.bind`: a fanout writer bound to its task and to its recorded worktree
 * (section 7, fanout.js step 2). The token itself is never stored. A binding
 * from a second worktree names the agent it replaces in `supersedes`: that
 * agent stopped without a `task.result` (COMMON.md, "Rebinding"). Integration
 * takes a task's latest binding.
 */
export type TaskBindBody = { task: string; worktree: BoundWorktree; supersedes?: string }

/**
 * `task.result`: a fanout writer's or researcher's StructuredOutput, recorded
 * by the mod from the spool (output.ts), as the agent returned it plus what
 * the mod observed. `task` is null for an unbound writer.
 */
export type TaskResultBody = {
  task: string | null
  role: 'executor' | 'researcher'
  tool_use_id: string
  /** The TASK or RESEARCHED result, field for field. */
  result: Record<string, unknown>
  unbound?: true
  bind_refusal?: string
}

/** `mcp__litter__record({ kind: 'integrate', run })`, from the relay. The mod decides what to merge. */
export type IntegrateInput = { kind: 'integrate'; run: string }

/** One path of the combined change (`<changed>`, section 7 fanout.js step 4). */
export type ChangedPath = {
  path: string
  /** The task that owns it, or null when none does (which blocks the land). */
  task: string | null
  /** Changed by the integrator beyond the conflicted files: the verifier reads it in full. */
  integrator_extra: boolean
}

/** A task the mod didn't merge, and why. `unowned` lists the paths outside the task's ownership. */
export type SkippedTask = { task: string; reason: string; unowned?: string[] }

/**
 * The record tool's answer to an integrate, in INTEGRATED_BY_MOD's shape (the
 * relay's schema in fanout.js). The relay's StructuredOutput gets every field
 * but `ok` from output.sh, keyed by `integrate_id`.
 *  - `merged`: every task branch that should be merged is merged, and the
 *    whole-result path check holds. `changed` is the complete path list.
 *  - `conflict`: the merge of `conflict.task` stopped with conflicted files,
 *    left in `where` for the integrator. The next integrate call finishes it.
 *  - `refused`: nothing more can be merged (`reason`); the run halts.
 */
export type IntegrateReply = {
  ok: true
  /** `i<seq>` of the record the answer came from; output.sh matches it. */
  integrate_id: string
  status: 'merged' | 'conflict' | 'refused'
  /** The integration worktree, absolute. */
  where: string
  base: string
  /** Task ids merged so far, in merge order. */
  merged: string[]
  skipped: SkippedTask[]
  conflict?: { task: string; branch: string; files: string[] }
  /** On `merged`: the integration branch's tip and its tree, what the verify must find. */
  tip?: string
  tree?: string
  changed?: ChangedPath[]
  reason?: string
}

/** `integrate.merge`: one task branch merged onto the integration branch, cleanly or after the integrator. */
export type IntegrateMergeBody = {
  task: string
  branch: string
  /** The merge commit the mod made (always `--no-ff`, so task commits never sit on the first-parent chain). */
  commit: string
  /** `git diff --name-only -z --no-renames <base> <branch>`, all owned by `task`. */
  paths: string[]
  /** Set when the integrator resolved this merge. */
  resolved?: { files: string[]; integrator_extra: string[] }
}

/** `integrate.conflict`: the merge of `task` stopped; `files` are `--diff-filter=U`, recorded before the integrator runs. */
export type IntegrateConflictBody = { task: string; branch: string; files: string[] }

/** `integrate.skip`: a task not merged (blocked, no result, no branch, unowned paths, a fork point that isn't base). */
export type IntegrateSkipBody = SkippedTask

/** `integrate.done`: every merge finished; the whole-result check's outcome. `blocked` non-empty means no land. */
export type IntegrateDoneBody = { tip: string; tree: string; changed: ChangedPath[]; blocked: string[] }

/**
 * The fanout land: `mcp__litter__record({ kind: 'land', run, gate: 'fanout', verify_id })`
 * from the relay, citing the verifier's verify for gate `integration`. The
 * reply is execute's LandReply. Its `land.intent` adds `commit`, the
 * integration tip the ref moves to: the tip is made before the verify, so it
 * can't carry the verify_id in a trailer, and reconcile matches the ref
 * against the intent's commit instead (plan section 7, fanout.js step 5).
 */
export const FANOUT_GATE = 'fanout'
