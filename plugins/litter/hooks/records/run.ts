// Record bodies for a run's lifecycle and the run lock (plan section 9,
// "Launch preconditions", "Run lifecycle", "Continuations"). Owner: phase 1b,
// work package D. Refine freely inside this file; other packages import only
// the names below.

import type { RepairBudget } from '../swarm/types'

export type Workflow = 'execute' | 'fanout' | 'design' | 'plan'
export const WORKFLOWS: readonly Workflow[] = ['execute', 'fanout', 'design', 'plan']

export type RunStatus = 'launch_failed' | 'done' | 'needs_user' | 'halted' | 'failed' | 'stopped' | 'interrupted'
export const RUN_STATUSES: readonly RunStatus[] = ['launch_failed', 'done', 'needs_user', 'halted', 'failed', 'stopped', 'interrupted']

/** What a manual resume may pick up in the same session (plan section 9, "Resuming"). */
export const RESUMABLE: readonly RunStatus[] = ['failed', 'stopped', 'interrupted']

export type Deliverable = 'plan' | 'research' | 'audit' | 'review'
export const DELIVERABLES: readonly Deliverable[] = ['plan', 'research', 'audit', 'review']

/** A design bar entry: `C<n>` criteria and `B<n>` bans (plan section 7, design.js "Args"). */
export type BarItem = { id: string; text: string; evidence: string; reason?: string }

export type LensRole = 'falsifier' | 'coverage' | 'mechanism'
export type Lens = { role: LensRole; name: string; focus: string; anchors: string[] }

/** A fanout task as the launcher passes it; `files` are owned paths, a trailing `/` owns a folder. */
export type FanoutTaskInput = { id: string; title: string; text: string; writes?: boolean; files?: string[] }

/**
 * What a run does when its path ends without the result (plan 15.11, the
 * `repair` option, phase 2b-2): the options' values, or the launch's override
 * for this run, as the launch confirmation stated them. The bridge reads them
 * only from the sha-checked run.json, never from the model or `args`.
 */
export type RepairSettings = { mode: 'auto' | 'off'; rounds: number; agents: number }

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
  linkDirs?: string[]
  mergeOrder?: string[]
  // design
  deliverable?: Deliverable
  bar?: BarItem[]
  lenses?: Lens[]
  empiricalUnknowns?: string[]
  anchors?: string[]
  maxRounds?: number
  priorRun?: string
  feedback?: string
  // The repair setting for this run (2b-2): unset, the options' values apply.
  repair?: 'auto' | 'off'
  repairRounds?: number
  repairAgents?: number
}

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
  rules: { id: string; version: number }[]
  /** The plan file as given, and the sha256 of the text step 2 parsed. */
  planPath: string | null
  planSha256: string | null
  session: string
  created: number
  /**
   * The attribution lines the session requires on commits, one `Key: value`
   * each, added to every land's message (section 9, "Commit message"). Not
   * filled yet: it needs a settings port.
   */
  trailers?: string[]
  /**
   * The run's repair setting (2b-2), covered by `runJsonSha256` like the
   * rest. Optional because a run.json written before 2b-2 has none: such a
   * run never repairs, since its launch confirmation never stated a repair.
   */
  repair?: RepairSettings
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

export type RunLaunchBody = { taskId: string; runId: string; scriptPath: string | null; generation: number; session: string; oid: string }
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
