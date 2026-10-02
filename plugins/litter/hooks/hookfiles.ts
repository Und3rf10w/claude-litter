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
   * `worktrees` and `integration` fill in from phase 2.
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
  /** Phase 2: the approved setup argv and link dirs, for worktree.sh. */
  setup: string[] | null
  linkDirs: string[]
}

/** worktree.json: your merged worktree settings, kept whether or not anything is active. Phase 2. */
export type WorktreePolicy = {
  v: 1
  baseRef: 'fresh' | 'head'
  symlinkDirectories: string[]
}

/**
 * agents/<agent_id>.json: the mod's half of a binding. Phase 2 (fanout writers)
 * and 2b (swarm nodes). Absent for most run agents.
 */
export type AgentPolicy = {
  v: 1
  run?: string
  task?: { id: string; owned: string[] }
  node?: Record<string, unknown>
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
  for: { verify_id?: string; version?: string; land_of?: string }
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
