// The files the mod and the command hooks share under `<litterDir>/hooks/`
// (plan section 9, "Mod-to-hook state"; paths in layout.ts). This file is the
// contract for both sides: the TS types for the mod, and the comments for the
// sh scripts, which read and write the same JSON with jq.
//
// Contract owner: phase 1a. Every file carries `v: 1`; a reader that meets
// another version treats the file as unreadable (and so, for a litter agent,
// denies). A field added later is optional, so old readers keep working.
//
// Who writes what:
//   mod   -> active, policy.json, worktree.json, agents/<id>.json, out/<id>.json, pointer
//   hooks -> bind/<id>, mode, wt/<name>, spool/<session>.jsonl, spool/blobs/*
// worktree.sh also writes setup logs under the run's verify/setup-<name>/.
// The mod replaces its files atomically (temp file + mv, fsx.atomicWrite).
// The hooks write bind/ and mode through a temp file + mv too, and append
// spool lines with one `>>` each.

import type { Ports } from './ports'

/** litter's role names, without the `litter:` prefix (plan section 6). */
export type RoleName =
  | 'falsifier' | 'coverage' | 'mechanism' | 'reframer' | 'prober' | 'author' | 'design-critic'
  | 'gate-critic' | 'executor' | 'adversary' | 'relay' | 'integrator' | 'planner' | 'verifier' | 'researcher'

/**
 * What the guard allows a role, written into policy.json by the mod from roles.ts,
 * so the role table has one source.
 *  - `write`: where Write/Edit/NotebookEdit may land. `checkout` is the run's
 *    checkout root, `own-worktree` the agent's own bound worktree (its bind cwd),
 *    `integration` the run's integration worktree. `none` denies every write.
 *  - `bash`: `rw` gets the full Bash rules; `ro` also loses redirections and
 *    write-ish commands (the deepwork state-bash-gate port).
 *  - `isolated`: the role runs with `isolation: 'worktree'`, so its call's cwd must be
 *    its bound worktree (plan section 9, "Its working directory").
 */
export type RolePolicy = {
  write: 'none' | 'checkout' | 'own-worktree' | 'integration'
  bash: 'rw' | 'ro'
  isolated: boolean
}

/** policy.json: the mod's view of what's active, for the scripts. Replaced whole. */
export type Policy = {
  v: 1
  /** The session that owns the active run or swarm. Rewritten after /clear and backgrounding. */
  session: string
  litterDir: string
  /** Null while no run is active (a swarm alone may be live: see `swarm`). */
  run: RunPolicy | null
  /** Per role. Every litter role is listed while a run is active. */
  roles: Partial<Record<RoleName, RolePolicy>>
  /** Phase 2b. Null until swarms land. */
  swarm: null | Record<string, unknown>
}

export type RunPolicy = {
  run: string
  workflow: 'execute' | 'fanout' | 'design' | 'plan'
  runDir: string
  /** Absolute; the project root, or the run worktree under `isolate: true`. */
  checkout: string
  /** The launch commit. */
  base: string
  /** The workflow run ids (`wf_…`) this run has launched; worktree.sh matches names against them. */
  runIds: string[]
  /** Set by the Workflow hook before `next(e)`, cleared by run.launch. */
  launching: boolean
  /** Set by the TaskStop hook: the guard denies every call from the run's agents. */
  stopping: boolean
  /** A critique or land in flight for this checkout: writes are denied meanwhile. */
  inflight: null | 'critique' | 'land'
  /** Set by the mod once a lost isolation context was spooled: every later call of the run is denied. */
  isolationLost: boolean
  /**
   * Resolved real paths (the mod's $.fs.stat resolve), compared exactly by the guard.
   * `worktrees` gains each `worktree.create` path as the mod records it;
   * `integration` is set when the mod makes the integration worktree.
   */
  roots: {
    checkout: string
    litterDir: string
    /** Every `.claude/litter/` copy the mod knows of, the canonical one included. */
    litterCopies: string[]
    /** The rule folders and their exports (plan section 16.1). */
    ruleDirs: string[]
    worktrees: string[]
    integration: string | null
  }
  /** The approved setup argv and link dirs, for worktree.sh. */
  setup: string[] | null
  linkDirs: string[]
  /**
   * Phase 2. Absolute and resolved: where worktree.sh makes this run's
   * worktrees, `<worktreeRoot>/<name>`. The primary checkout's
   * `.claude/worktrees`, or `<common dir>/litter-worktrees` for a bare
   * repository. worktree.sh never derives it, and refuses a litter name
   * without it.
   */
  worktreeRoot?: string
  /** Phase 2. worktree.sh's own limit for one setup run, under the hook's 600 s. */
  setupTimeoutSec?: number
}

/**
 * worktree.json: your merged worktree settings, kept whether or not anything
 * is active (plan section 9, "Run worktrees"). The mod writes it from
 * `$.settings.read()` at session.start and whenever a 30 s check finds the
 * values changed; worktree.sh makes your own worktrees with it.
 */
export type WorktreePolicy = {
  v: 1
  baseRef: 'fresh' | 'head'
  symlinkDirectories: string[]
}

/**
 * agents/<agent_id>.json: the mod's half of a binding, written by task.bind
 * before it answers (fanout writers; 2b adds swarm nodes). Absent for most
 * run agents, and for a fanout writer that hasn't bound yet: the guard then
 * denies it every tool but StructuredOutput, which output.sh accepts only as
 * a blocked result (plan section 7, fanout.js step 2).
 *  - `task.owned`: the task's `files` as run.start validated them,
 *    repo-relative, a trailing `/` owning a folder. The guard scopes the
 *    writer's Write/Edit to `<its bind cwd>/<owned>`.
 *  - `worktree`: the recorded worktree it's bound to (its bind cwd, resolved).
 */
export type AgentPolicy = {
  v: 1
  run?: string
  task?: { id: string; owned: string[] }
  worktree?: { name: string; path: string; branch: string }
  node?: Record<string, unknown>
}

/**
 * wt/<name>: worktree.sh's step marker for one worktree name, replaced through
 * a temp file and mv at each step, so a later request knows how far an
 * earlier one got before the mod has drained anything. One JSON object.
 */
export type WtMarker = {
  v: 1
  step: 'intent' | 'create' | 'setup_failed'
  run: string
  name: string
  path: string
  branch: string
  base: string
  disposable: boolean
}

/**
 * out/<agent_id>.json: the observed fields output.sh puts into that agent's
 * StructuredOutput through updatedInput (plan section 9, "Observed facts beat
 * claimed ones"). `for` says which record produced them: output.sh denies the
 * call when the input's own `verify_id` (or `version`) doesn't match, so the
 * agent records first and returns again.
 */
export type OutFile = {
  v: 1
  agent_id: string
  /**
   * `integrate_id`: an integrate relay's answer, matched against the input's
   * own `integrate_id` like `verify_id`. A fanout writer's file has an empty
   * `for` and carries `unbound` (and `bind_refusal`) from its task.bind.
   */
  for: { verify_id?: string; version?: string; land_of?: string; integrate_id?: string }
  /** Merged over the input's top-level fields, already shaped to the role's schema. */
  fields: Record<string, unknown>
}

/**
 * bind/<agent_id>: written by identity.sh at SubagentStart, as one JSON object.
 * `cwd` is the agent's worktree when it runs isolated.
 */
export type BindFile = {
  v: 1
  agent_id: string
  agent_type: string
  cwd: string
  session_id: string
  transcript_path: string
}

/** mode: one line, the main thread's latest permission_mode, written by watch.sh. */
export type ModeFile = string

/**
 * spool/<session_id>.jsonl: one JSON object per line, appended by the hooks
 * with one `>>`. A line stays under 4 KiB; anything bigger goes to
 * spool/blobs/<name>.json, and the line names it in `file`, with `ev` and the
 * ids still on the line. `ts` is seconds since the epoch (`date +%s`).
 */
export type SpoolLine =
  | SpoolBase<'start', { agent_id: string; agent_type: string; cwd: string; transcript_path: string }>
  | SpoolBase<'stop', { agent_id: string; agent_type: string; transcript_path: string; stop_hook_active: boolean; background_tasks: number }>
  | SpoolBase<'output', { agent_id: string; agent_type: string; tool_use_id: string; input?: Record<string, unknown>; file?: string }>
  | SpoolBase<'mode', { agent_id: string | null; mode: string }>
  | SpoolBase<'isolation-lost', { agent_id: string; agent_type: string; tool: string; cwd: string; expected: string | null; source: 'guard' | 'watch' }>
  | SpoolBase<'deny', { agent_id: string | null; agent_type: string | null; tool: string; tool_use_id: string; reason: string }>
  /**
   * worktree.sh, for a litter name: each step as it happens, the intent before
   * any git command. The mod records them as `worktree.intent`,
   * `worktree.create` and `worktree.setup_failed` (records/fanout.ts).
   */
  | SpoolBase<'worktree', {
      step: 'intent' | 'create' | 'setup_failed'
      run: string
      name: string
      path: string
      branch: string
      base: string
      disposable: boolean
      /** create: the top-level ignored paths the setup left. */
      ignored?: string[]
      /** setup_failed. */
      exit_code?: number | null
      timed_out?: boolean
      log?: string
    }>

type SpoolBase<E extends string, P> = { v: 1; ev: E; ts: number; session_id: string } & P

export type SpoolEvent = SpoolLine['ev']

/** The deny reason prefix every script uses, so the board can tell litter's denials apart. */
export const GUARD_PREFIX = 'litter guard:'

/**
 * The mod's side of the spool: policy.ts drains each line once, in order, and
 * hands it to every consumer in registry.ts. A consumer that throws is logged
 * and the drain goes on: one bad line never stops the others.
 */
export type SpoolCtx = { p: Ports; litterDir: string; sessionId: string }
export type SpoolConsumer = (ctx: SpoolCtx, line: SpoolLine) => Promise<void>
