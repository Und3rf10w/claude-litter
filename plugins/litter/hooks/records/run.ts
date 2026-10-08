// Record bodies for a run's lifecycle and the run lock (plan section 9,
// "Launch preconditions", "Run lifecycle", "Continuations"). Owner: phase 1b,
// work package D. Refine freely inside this file; other packages import only
// the names below.

import type { RepairBudget } from '../swarm/types'
import type { WidenMode } from '../options'
import type { RuleRef } from './rules'
import type { DesignCriterion } from './design'

export type Workflow = 'execute' | 'fanout' | 'design' | 'plan'
export const WORKFLOWS: readonly Workflow[] = ['execute', 'fanout', 'design', 'plan']

/**
 * A workflow's name as the Workflow tool takes it, its script's `meta.name`
 * with the plugin's prefix. Not `litter:execute`: the engine lists workflows
 * ahead of plugin skills and dispatches a name to the first it finds, so a
 * workflow named like a skill takes that skill's slash command.
 */
export const workflowName = (w: Workflow): string => `litter:${w}-run`

/** The workflow a Workflow tool name launches: `litter:execute-run` is execute; null for any other name. */
export function workflowOfName(name: string): Workflow | null {
  const m = /^litter:(.+)-run$/.exec(name)
  return m && (WORKFLOWS as readonly string[]).includes(m[1]!) ? (m[1] as Workflow) : null
}

export type RunStatus = 'launch_failed' | 'done' | 'needs_user' | 'halted' | 'failed' | 'stopped' | 'interrupted'
export const RUN_STATUSES: readonly RunStatus[] = ['launch_failed', 'done', 'needs_user', 'halted', 'failed', 'stopped', 'interrupted']

/** What a manual resume may pick up in the same session (plan section 9, "Resuming"). */
export const RESUMABLE: readonly RunStatus[] = ['failed', 'stopped', 'interrupted']

export type Deliverable = 'plan' | 'research' | 'audit' | 'review'
export const DELIVERABLES: readonly Deliverable[] = ['plan', 'research', 'audit', 'review']

/**
 * A design bar entry: `C<n>` criteria and `B<n>` bans (plan section 7,
 * design.js "Args"). An item run.start added from the accepted rules in
 * scope (16.5; decision 4) names them: a ban its `rule`, the one criterion
 * for the rest its `rules`. Your own items name neither.
 */
export type BarItem = { id: string; text: string; evidence: string; reason?: string; rule?: RuleRef; rules?: RuleRef[] }

export type LensRole = 'falsifier' | 'coverage' | 'mechanism'
export type Lens = { role: LensRole; name: string; focus: string; anchors: string[] }

/**
 * An empirical unknown (decision 3): `U1` and `U2` from the interview, in the
 * order given; design.js numbers a mechanism's on from there (decision 10).
 */
export type EmpiricalUnknown = { id: string; question: string; smallest_test: string; kill_result: string }

/**
 * A follow-up run's prior (decision 12, WP-BD's): the prior design run, its
 * latest proposal's version and text (cut at 64 KiB, with a note), its
 * latest verdict on that version, and the feedback, its `design.feedback`
 * records' then this run's. `version` and `proposal` are null when the prior
 * recorded none.
 */
export type DesignPrior = {
  run: string
  version: string | null
  proposal: string | null
  verdict: { criteria: DesignCriterion[]; overall: string } | null
  feedback: string[]
}

/**
 * A design run's args, the contract between run.start (design/launch.ts's
 * designArgs) and workflows/design.js (plan section 7, design.js "Args").
 */
export type DesignArgs = {
  /** The run id. */
  run: string
  /** The run's tag nonce (plan 7a), drawn once by run.start. */
  nonce: string
  /** Your authorized actions, one per line, as the launch confirmation stated them. */
  authorized: string
  /** Your words, verbatim. */
  goal: string
  deliverable: Deliverable
  /** Frozen at run.start: your items, then the ones the accepted rules in scope add (decision 4). */
  bar: BarItem[]
  /** Each call's `<rules>`: your run rules first, then the accepted rules in 16.5's compact form, under the 8 KiB cap. */
  rules: string[]
  anchors: string[]
  lenses: Lens[]
  /** At most two, `U1` and `U2` (decision 3). */
  empiricalUnknowns: EmpiricalUnknown[]
  maxRounds: number
  /** The base snapshot's commit, `refs/litter/<run>/base`: the probers' worktrees start there (plan section 9, "Run worktrees"). */
  base: string
  /** The author's section template for the deliverable (decision 13); '' leaves the author's `<template>` out. */
  template: string
  /** A follow-up run's prior (decision 12), or null. */
  prior: DesignPrior | null
  /** The run this one follows, as run.start was given it. */
  priorRun?: string
  /** Your feedback on that run's result, in your words. */
  feedback?: string
}

/** design.js's `{ stopped: null }` outcomes and stops (plan section 7; decisions 1 and 2), which the decoder accepts. */
export const DESIGN_OUTCOMES = ['approved', 'holding'] as const
export const DESIGN_BYS = ['approved', 'no-new-material', 'max-rounds', 'budget'] as const

/**
 * What workflows/design.js returns (plan section 7, "What design.js
 * returns"; COMMON decisions 1 and 2), one shape per stop, so the decoder
 * maps each to a run.end. `version` is null when no version was recorded.
 * `halted` is a call that returned nothing after its retry, or a refused
 * prober worktree; `interrupted` is call()'s rejection handling, as in execute.
 */
export type DesignReturn =
  | { stopped: null; outcome: (typeof DESIGN_OUTCOMES)[number]; by: (typeof DESIGN_BYS)[number]; version: string | null }
  /** The reframer's result whose recommendation changes the goal. */
  | { stopped: 'goal-change'; reframe: Record<string, unknown> }
  /** The author's blocking entry in `user_decisions`. */
  | { stopped: 'blocking-decision'; decision: Record<string, unknown> }
  /** The criteria whose `gap_kind` is `user`. */
  | { stopped: 'user-gap'; criteria: DesignCriterion[] }
  /** The verdict's version, whose `source_changed` was true. */
  | { stopped: 'source-changed'; version: string }
  | { stopped: 'halted'; reason: string }
  | { stopped: 'interrupted'; reason: string }

/** A fanout task as the launcher passes it; `files` are owned paths, a trailing `/` owns a folder. */
export type FanoutTaskInput = { id: string; title: string; text: string; writes?: boolean; files?: string[] }

/**
 * What a run does when its path ends without the result (plan 15.11, the
 * `repair` option, phase 2b-2): the options' values, or the launch's override
 * for this run, as the launch confirmation stated them. The bridge reads them
 * only from the sha-checked run.json, never from the model or `args`.
 */
export type RepairSettings = { mode: 'auto' | 'off'; rounds: number; agents: number }
/** The `repair` values run.start takes (W): anything else is refused with the field named. */
export const REPAIR_MODES: readonly RepairSettings['mode'][] = ['auto', 'off']

/**
 * `mcp__litter__record({ kind: 'run.start', … })`, from a launcher skill. The
 * fields each launcher sends are in litter-prompts.md ("Launch").
 */
export type RunStartInput = {
  kind: 'run.start'
  workflow: Workflow
  /** The authorized actions, in your words, as the launch confirmation showed them. */
  authorized: string[]
  /** The plan file, absolute or relative to the checkout (execute; a prose plan for `plan`). */
  planPath?: string
  /** Goal mode (`plan`, `design`). */
  goal?: string
  /** An argv other than the configured one: asked through $.ui.ask before it's used. */
  verify?: string[]
  goalCheck?: string[]
  /** A new worktree's dependency setup: a fanout's writers, an isolated execute run, and a design's probers (decision 11). */
  setup?: string[]
  maxAttempts?: number
  adversary?: boolean
  isolate?: boolean
  continueOf?: string
  amendOf?: { run: string; gate: string }
  /** Amend only: keep the halted attempt in the tree. */
  carryOver?: boolean
  /** Your constraints for this run only, in your words (plan section 16.5). */
  runRules?: string[]
  // fanout
  tasks?: FanoutTaskInput[]
  contract?: string
  /** Ignored folders each new worktree links from the checkout: a fanout's writers, and a design's probers (decision 11). */
  linkDirs?: string[]
  mergeOrder?: string[]
  // design
  deliverable?: Deliverable
  bar?: BarItem[]
  lenses?: Lens[]
  /** At most two (decision 3): each `{ question, smallest_test, kill_result }`, or a bare string as its question. run.start assigns the ids. */
  empiricalUnknowns?: (string | Partial<EmpiricalUnknown>)[]
  anchors?: string[]
  maxRounds?: number
  priorRun?: string
  feedback?: string
  // The repair setting for this run (2b-2), as the launch confirmation stated
  // it: unset, the options' values apply. Fanout and, from phase 3 (AC's
  // parseRepair), execute runs; run.start refuses them for the other
  // workflows, and a bad value names its field.
  repair?: 'auto' | 'off'
  /** 1 to 10. */
  repairRounds?: number
  /** 1 to 50. */
  repairAgents?: number
  /**
   * Execute only (WP-AO): who may add files to a gate's Files in this run,
   * as the launch confirmation stated it; unset, the `widen` option applies.
   */
  widen?: WidenMode
  /**
   * Execute only (WP-AO): files you asked to add to a gate before Launch. The
   * mod asks you to confirm each gate's in its own dialog before the run is
   * made; one you don't confirm refuses the launch.
   */
  widenings?: WideningInput[]
}

/** One gate's files to add, and why, in your words (WP-AO). Paths are repository-relative; a trailing `/` is a folder. */
export type WideningInput = { gate: string; files: string[]; why: string }

export type RunStartReply = {
  ok: true
  run: string
  /** Absolute. */
  runDir: string
  /** Absolute. */
  checkout: string
  /** The workflow args the Workflow hook swaps in (plan section 9, step 5). */
  args: Record<string, unknown>
  foreignCommits?: string[]
  /** What the launch card should say (an old git's unfenced switch, for one). */
  warnings?: string[]
}

/** run.json, written by run.start (plan section 10, "On disk"). */
export type RunJson = {
  v: 1
  run: string
  workflow: Workflow
  args: Record<string, unknown>
  authorized: string[]
  mode: string
  verify: string[] | null
  goalCheck: string[] | null
  setup: string[] | null
  linkDirs: string[]
  /** The launch commit: HEAD after the clean check, or a design's snapshot commit. */
  base: string
  /** `refs/heads/litter/<run>`; a design or plan run's `refs/litter/<run>/base`. */
  ref: string
  /** Absolute: the checkout the run lands in (the run worktree under `isolate`). */
  checkout: string
  isolate: boolean
  /** The branch the checkout was on before step 3 switched it. */
  previousBranch: string | null
  continueOf: string | null
  amendOf: { run: string; gate: string } | null
  /** The accepted rule versions selection delivered anywhere in the run (section 16.1; decision 19), shown as `id@version`. */
  rules: RuleRef[]
  /** The plan file as given, and the sha256 of the text step 2 parsed. */
  planPath: string | null
  planSha256: string | null
  session: string
  created: number
  /**
   * The `trailers` plugin option's lines at launch, one `Key: value` each
   * (decision 4), under `runJsonSha256` with the rest: land.ts adds them to
   * every land's message (section 9, "Commit message"). Absent when the
   * option is empty.
   */
  trailers?: string[]
  /**
   * The run's repair setting (2b-2), covered by `runJsonSha256` like the
   * rest. Optional because a run.json written before 2b-2 has none: such a
   * run never repairs, since its launch confirmation never stated a repair.
   * Written for fanout and execute runs (phase 3), an amend's included,
   * though an amend's halt never bridges (decision 13).
   */
  repair?: RepairSettings
  /**
   * Who may add files to a gate's Files (WP-AO), covered by `runJsonSha256`.
   * Written for execute runs; absent, as in a run.json written before it,
   * it's `ask`: only you.
   */
  widen?: WidenMode
}

/** The `run.start` ledger body: run.json's facts, chained, with run.json's and the args' sha256. */
export type RunStartBody = {
  workflow: Workflow
  base: string
  ref: string
  checkout: string
  isolate: boolean
  previousBranch: string | null
  verify: string[] | null
  goalCheck: string[] | null
  setup: string[] | null
  authorized: string[]
  mode: string
  continueOf: string | null
  amendOf: { run: string; gate: string } | null
  planSha256: string | null
  argsSha256: string
  runJsonSha256: string
  /** The run lock's oid at launch. */
  oid: string
  session: string
  /** run.json's `repair` (2b-2); absent in a ledger from before it. */
  repair?: RepairSettings
}

/**
 * On Codex, the litterd that drives a generation (host/runs.ts,
 * reconcileGone): its pid, its socket, when it began serving, and its
 * process's start time as the OS tells it (null when it can't). One litter
 * directory can have a litterd per data folder, so a generation another
 * litterd isn't driving is ended only once this one is gone.
 */
export type RunDriver = { pid: number; socket: string; startedAt: number; procStart: string | null }

export type RunLaunchBody = {
  taskId: string
  runId: string
  scriptPath: string | null
  generation: number
  session: string
  oid: string
  /** Codex's litterd only; absent on Claude Code. */
  driver?: RunDriver
}
export type RunResumeBody = RunLaunchBody
export type RunStoppingBody = { taskId: string; generation: number }
export type RunEndBody = {
  taskId: string | null
  /** 0 for a launch that never opened a generation. */
  generation: number
  status: RunStatus
  reason: string | null
  /** Design's early returns and outcomes. */
  payload?: Record<string, unknown>
  source: 'notification' | 'taskstop' | 'reconcile' | 'launcher' | 'mod'
  settled?: boolean
  /**
   * What the user should know about the run's end beyond its status: on
   * Codex, a file the run left in its checkout that holds one of the lead's
   * forwarded credentials (host/leaks.ts), never the value. summary.md lists
   * them. Absent when there's none.
   */
  warnings?: string[]
}

/**
 * `run.repair` (W's reopenForRepair, the mod's only; 2b-2): after the run's
 * run.end, it reopens the run for `generation`, which the repair swarm
 * `swarm`'s launch `launch` works in, within `budget`. That generation's own
 * run.end closes it (W's endRepairGeneration).
 */
export type RunRepairBody = { generation: number; swarm: string; launch: string; budget: RepairBudget }

/**
 * `repair.declined` (X's bridge, the mod's only; 2b-2): a halted run that
 * started no repair, and why, in words for the summary's Repair section.
 */
export type RepairDeclinedBody = { reason: string }

export type LockBlob = { run: string; session: string; acquiredAt: number }
export type LockRecoveredBody = { oid: string; run: string; session: string; branch: string | null; previousBranch: string | null }
export type LockForcedBody = { oid: string; run: string; session: string }

/** `<litterDir>/lock-lease-<oid>.json`, beaten every 10 s while a launch is pending. */
export type Lease = { oid: string; run: string; session: string; beatAt: number }

/** The launcher's fallback `run.end` (plan section 9, "One fallback in the skills"). */
export type RunEndInput = { kind: 'run.end'; run: string; taskId: string; status: string; reason?: string; result?: unknown }
