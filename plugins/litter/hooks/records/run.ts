// Record bodies for a run's lifecycle and the run lock (plan section 9,
// "Launch preconditions", "Run lifecycle", "Continuations"). Owner: phase 1b,
// work package D. Refine freely inside this file; other packages import only
// the names below.

export type Workflow = 'execute' | 'fanout' | 'design' | 'plan'

export type RunStatus = 'launch_failed' | 'done' | 'needs_user' | 'halted' | 'failed' | 'stopped' | 'interrupted'

/** `mcp__litter__record({ kind: 'run.start', … })`, from a launcher skill. */
export type RunStartInput = {
  kind: 'run.start'
  workflow: Workflow
  /** The plan file, absolute or relative to the checkout (execute, amend). */
  plan?: string
  /** Goal mode (execute without a plan, design). */
  goal?: string
  /** The authorized actions, in your words, as the launch confirmation showed them. */
  authorized: string[]
  /** An argv other than the configured one: asked through $.ui.ask before it's used. */
  verify?: string[]
  goalCheck?: string[]
  setup?: string[]
  isolate?: boolean
  continueOf?: string
  amendOf?: string
  gate?: string
  runRules?: string[]
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
  base: string
  ref: string
  checkout: string
  /** The branch the checkout was on before step 3 switched it. */
  previousBranch: string | null
  continueOf: string | null
  amendOf: string | null
  rules: { id: string; version: number }[]
  planSha256: string | null
}

export type RunLaunchBody = { taskId: string; runId: string; scriptPath: string | null; generation: number }
export type RunResumeBody = RunLaunchBody
export type RunStoppingBody = { taskId: string }
export type RunEndBody = {
  taskId: string | null
  generation: number
  status: RunStatus
  reason: string | null
  /** Design's early returns and outcomes. */
  payload?: Record<string, unknown>
  source: 'notification' | 'taskstop' | 'reconcile' | 'launcher' | 'mod'
  settled?: boolean
}

export type LockBlob = { run: string; session: string; acquiredAt: number }
export type LockRecoveredBody = { oid: string; run: string; session: string }
export type LockForcedBody = { oid: string; run: string; session: string }
