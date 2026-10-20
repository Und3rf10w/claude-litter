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
//   mod   -> active, policy.json, worktree.json, agents/<id>.json, out/<id>.json, pointer,
//            pending/<tool_use_id> (phase 2b: written and removed by the spawn check, L)
//   hooks -> bind/<id>, mode, wt/<name>, spool/<session>.jsonl, spool/blobs/*,
//            done/<agent_id> (phase 2b: watch.sh at a hand-back, hold.sh at a stop it lets go),
//            hold/<agent_id> (phase 2b: hold.sh), shells/<agent_id> (phase 2b: watch.sh),
//            told/<agent_id> (WP-EB: guard.sh)
// worktree.sh also writes setup logs under the run's verify/setup-<name>/.
// The mod replaces its files atomically (temp file + mv, fsx.atomicWrite).
// The hooks write bind/ and mode through a temp file + mv too, and append
// spool lines and shells/ ids with one `>>` each. The mod removes an agent's
// done/, hold/ and shells/ files with its policy (swarm/guard.ts,
// removeNodePolicy), and its done/ whenever it admits the agent again.

import type { Ports } from './ports'
import type { Authority } from './swarm/types'

/** litter's role names, without the `litter:` prefix (plan section 6). */
export type RoleName =
  | 'falsifier' | 'coverage' | 'mechanism' | 'reframer' | 'prober' | 'author' | 'design-critic'
  | 'gate-critic' | 'executor' | 'adversary' | 'relay' | 'planner' | 'verifier' | 'researcher'

/**
 * What the guard allows a role, written into policy.json by the mod from roles.ts,
 * so the role table has one source.
 *  - `write`: where Write/Edit/NotebookEdit may land. `checkout` is the run's
 *    checkout root, `own-worktree` the agent's own bound worktree (its bind cwd).
 *    `none` denies every write.
 *  - `bash`: `rw` gets the full Bash rules; `ro` also loses redirections and
 *    write-ish commands (the deepwork state-bash-gate port).
 *  - `isolated`: the role runs with `isolation: 'worktree'`, so its call's cwd must be
 *    its bound worktree (plan section 9, "Its working directory").
 */
export type RolePolicy = {
  write: 'none' | 'checkout' | 'own-worktree'
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
  /**
   * Phase 2b: every live swarm in this repository, whichever session owns it.
   * Null whenever none is, never an empty `swarms`: lifecycle.ts's `deactivate`
   * keeps `active` while it isn't null.
   */
  swarm: SwarmPolicy | null
}

/** policy.json's swarm part: written by swarm/guard.ts (M) for K's Launch, beat and handover, and P's End. */
export type SwarmPolicy = { swarms: Record<string, SwarmEntry> }

export type SwarmEntry = {
  launch: string
  state: 'live' | 'stopping'
  /** Resolved. The guard runs `git --git-dir=<commonDir> rev-parse -q --verify <owner.ref>` when the check is stale. */
  commonDir: string
  /**
   * The ownership ref and the last beat's check (15.4, "One session owns a live swarm").
   * `checkedAt` is in seconds, as `date +%s` reads. Only the owner's beat writes it.
   */
  owner: { ref: string; oid: string; generation: number; session: string; checkedAt: number }
  /** Every node's type, `litter:sw-<swarm>-<node>`, for the guard's unknown-agent wait and the Agent rules. */
  nodeTypes: string[]
}

/**
 * A swarm node's, or a node's child's, half of its binding: `agents/<agent_id>.json`
 * as `{ v: 1, node }`, with no `run`. Rendered by swarm/guard.ts's nodePolicyFor (M)
 * and written by L at binding, P at Stop and End, K at recovery.
 */
export type NodePolicy = {
  swarm: string
  launch: string
  node: string
  /** The instance number, from 1 over the swarm's life; 0 for a child. */
  n: number
  kind: 'orchestrator' | 'worker' | 'child'
  /** A child's node: that node's agentId. */
  of: string | null
  /** litter:sw-<swarm>-<node>. A child's is its node's; the guard checks `agent_type` against it only for a node. */
  type: string
  /** The spawning loop's agentId; null for an orchestrator, whose parent is the lead. */
  parent: string | null
  /**
   * The owner's generation when this binding was written. The guard denies everything when it isn't
   * the entry's `owner.generation`: the swarm was handed to another session (15.4, "A stale owner stands down").
   */
  generation: number
  /** Resolved. Relative paths in a call are taken against it. */
  dir: string
  /** Resolved, under `dir`; a trailing `/` is a folder. Null: anywhere. */
  paths: string[] | null
  /** Resolved paths no write may land in: every `.claude/litter/` copy, and the rule folders under the primary checkout and under `dir`. */
  protect: string[]
  /** `refs/heads/<branch>`, for a node with `authority.commit` set; null otherwise. */
  branch: string | null
  authority: Authority
  toolsDeny: string[]
  bashDeny: string[]
  /** The types it may spawn, `litter:sw-…`; a child's are its node's. */
  spawns: string[]
  spawnOther: boolean
  admitted: boolean
  /** Why it was stopped, or null. */
  stopped: string | null
  /** True until the node presents its token (15.4, adoption). */
  bind: boolean
}

/** hooks/pending/<tool_use_id>: a reserved spawn not yet bound (L). `at` in seconds. */
export type PendingMarker = { v: 1; swarm: string; node: string; parent: string | null; at: number }

/**
 * hooks/done/<agent_id>: the agent handed back (watch.sh) or stopped with none of its own background
 * tasks running (hold.sh). `at` in seconds. Removed whenever the mod admits the agent again.
 */
export type DoneMarker = { v: 1; at: number; via: 'handback' | 'stop' }

/** hooks/hold/<agent_id>: the children hold.sh already waited for, so a worker is held once per child. */
export type HoldMarker = { v: 1; children: string[] }

/**
 * hooks/shells/<agent_id>: the background tasks a bound agent started, one id per line, appended by
 * watch.sh with one `>>` at each call end that names one (a Bash result's `backgroundTaskId`, a
 * Monitor's `taskId`: the `id` SubagentStop's `background_tasks` lists, 2.1.288). SubagentStop's
 * list is the whole session's, with no owner, so hold.sh counts only the entries named here. No `v`:
 * plain lines, like `mode`; a line that isn't an id is skipped.
 */
export type ShellsFile = string

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
   * `worktrees` gains each `worktree.create` path as the mod records it.
   */
  roots: {
    checkout: string
    litterDir: string
    /** Every `.claude/litter/` copy the mod knows of, the canonical one included. */
    litterCopies: string[]
    /** The rule folders and their exports (plan section 16.1). */
    ruleDirs: string[]
    worktrees: string[]
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
  /**
   * WP-EB (A8), an execute run's: your widenings during the run (gate.widen
   * at 'run'), in the order recorded, each with its record's seq. The guard
   * tells each to the gate's executors at their next tool call, once
   * (told/<agent_id>).
   */
  widened?: { seq: number; gate: string; files: string[]; why: string }[]
  /** WP-EB (A8), an execute run's: each executor's gate, by agent_id, from its start line (widen.ts). */
  executors?: Record<string, string>
}

/**
 * told/<agent_id>: written by guard.sh once it told an execute executor of
 * your widenings (RunPolicy.widened): `seq` is the last of the run's it was
 * told of, so each is told once. Never read by the mod.
 */
export type ToldMarker = { v: 1; run: string; seq: number }

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
 * before it answers (fanout writers), or at a swarm node's binding. Absent for
 * most run agents, and for a fanout writer that hasn't bound yet: the guard
 * then denies it every tool but StructuredOutput, which output.sh accepts only
 * as a blocked result (plan section 7, fanout.js step 2).
 *  - `task.owned`: the task's `files` as run.start validated them,
 *    repo-relative, a trailing `/` owning a folder. The guard scopes the
 *    writer's Write/Edit to `<its bind cwd>/<owned>`.
 *  - `worktree`: the recorded worktree it's bound to (its bind cwd, resolved).
 *  - `node`: a swarm node's or child's file is `{ v: 1, node }`, with no `run`.
 */
export type AgentPolicy = {
  v: 1
  run?: string
  task?: { id: string; owned: string[] }
  worktree?: { name: string; path: string; branch: string }
  node?: NodePolicy
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
  /**
   * Phase 2b. A tool call of a node, a node's child or a run agent (`litter:*`):
   * `start` from guard.sh for every call it passes, `end` from watch.sh
   * (PostToolUse and PostToolUseFailure, `failed` on the latter), with `shell`
   * when a Bash ran in the background. A call guard.sh denies gets a `deny`
   * line instead, which closes it.
   */
  | SpoolBase<'call', {
      agent_id: string
      agent_type: string
      tool: string
      tool_use_id: string
      phase: 'start' | 'end'
      failed?: boolean
      shell?: string
      /** On a start, a Bash or Monitor call's command: its first 80 characters, controls as spaces. */
      detail?: string
    }>
  /** Phase 2b. watch.sh, for a node's SubagentHandback: its message (a blob when long), before `done/<agent_id>`. */
  | SpoolBase<'handback', { agent_id: string; agent_type: string; tool_use_id: string; message?: string; file?: string }>
  /**
   * Phase 2b. hold.sh: a worker held for `children`, released once they're done, or let go at its
   * cap (`timeout`). A `timeout` names no children when the bindings couldn't be listed until the cap.
   */
  | SpoolBase<'hold', { agent_id: string; phase: 'held' | 'released' | 'timeout'; children: string[] }>
  /**
   * Phase 5 (COMMON decision 1). ask.sh, on PermissionRequest: a litter
   * agent's or node's call about to ask you, with the command or path as
   * `detail` and the agent's permission mode. The input has no tool_use_id,
   * so the mod pairs the line with guard.sh's `call` start for the same
   * agent, tool and detail (asks.ts, CF).
   */
  | SpoolBase<'ask', { agent_id: string; agent_type: string | null; tool: string; detail: string; mode: string | null }>

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
