// Record bodies for verify and land (plan section 9, "verify and land records";
// section 7, execute.js "Crash recovery"). Owner: phase 1b, work package C.
// Refine freely inside this file; other packages import only the names below.

/** `baseline`, `integration`, `goal`, or a gate id like `G2`. */
export type GateRef = string

/** What the snapshot found besides the tree (plan section 9, "Snapshot"). */
export type Snapshot = {
  tree: string
  /** Paths of submodules with tracked changes (M) or untracked files (U) inside. Never clean when non-empty. */
  dirty_submodules: string[]
  sparse: boolean
}

/**
 * `mcp__litter__record({ kind: 'verify', run, gate, attempt })`. `attempt` may
 * be left out for `baseline` and `goal`, whose relay instruction names none; it's 1 then.
 */
export type VerifyInput = { kind: 'verify'; run: string; gate: GateRef; attempt?: number }

/** The ledger body of a verify record. */
export type VerifyBody = {
  verify_id: string
  gate: GateRef
  attempt: number
  argv: string[]
  tree_before: string
  tree_after: string
  dirty_submodules: string[]
  exit_code: number | null
  signal: string | null
  timed_out: boolean
  /** Why the spawn failed (the argv couldn't start, or its stream broke); null when it ran to its end. */
  spawn_error: string | null
  /** exit 0, not timed out, the tree unchanged, no dirty submodules, no spawn error. */
  green: boolean
  log_parts: number
  log_bytes: number
  /** The last 200 lines across both streams, cut to the last 64 KiB. */
  output_tail: string
}

/** The record tool's answer to a verify. Green: exit 0, not timed out, the tree unchanged, no dirty submodules. */
export type VerifyReply = {
  ok: true
  verify_id: string
  exit_code: number | null
  signal: string | null
  timed_out: boolean
  green: boolean
  /** The tree the verify ran on (tree_before): what a land would commit. */
  tree: string
  /** The tree changed while the verify ran, so it isn't green. */
  tree_changed: boolean
  dirty_submodules: string[]
  spawn_error: string | null
  /** The log part folder, absolute, under litterDir. */
  log: string
  output_tail: string
}

/** `mcp__litter__record({ kind: 'land', run, gate, verify_id })`. */
export type LandInput = { kind: 'land'; run: string; gate: GateRef; verify_id: string }

/**
 * The record tool's answer to a land, in LANDED's shape (plan section 7): a
 * field that would be null is left out, since LANDED types `commit` and
 * `reason` as strings. A landed reply carries `reason` only as a note (the
 * checkout moved, or the re-sync left paths alone).
 */
export type LandReply =
  | { ok: true; landed: true; commit: string; retry: false; reason?: string }
  | { ok: true; landed: false; reason: string; retry: boolean }

/** How a land moves the checkout: execute's index only, or fanout's index and files (`read-tree -m -u`). */
export type LandMode = 'index' | 'checkout'

/**
 * Recorded before any git write (step 1). `old` is the ref's checked tip, `tree` the verified tree T.
 * A fanout's (`gate: 'fanout'`, mode `checkout`) adds `commit`, the integration tip the ref moves to.
 */
export type LandIntentBody = { gate: GateRef; verify_id: string; tree: string; old: string; ref: string; mode: LandMode; commit?: string }

/** Step 6, or reconcile's `recovered: true` for a commit found by its trailer. */
export type LandBody = {
  gate: GateRef
  verify_id: string
  commit: string
  tree: string
  old: string
  ref: string
  recovered?: true
  /** The checkout moved, or the re-sync left paths alone. */
  note?: string
}

export type LandAbandonedBody = { gate: GateRef; verify_id: string; reason: string }
export type LandBlockedBody = { gate: GateRef; verify_id: string; reason: string; paths?: string[] }

// ---------------------------------------------------------------------------
// Goal mode and amend (phase 3, AB's plan.ts; COMMON steps 2 and 3)

/**
 * One gate as the planner returns it (prompts, the planner's GATES schema):
 * what plan.write takes and plan.ts's renderGateSection renders into section
 * 10's format. `lines` cites the plan's lines it covers, '' for none.
 */
export type PlannedGate = {
  id: string
  title: string
  /** The gate's scope, as prose. */
  scope: string
  lines: string
  files: string[]
  done_when: string
  checks: string[]
  adversary: boolean
}

/** `mcp__litter__record({ kind: 'plan.write', run, gates, continueOf? })`: a re-split names the execute run it continues. */
export type PlanWriteInput = { kind: 'plan.write'; run: string; gates: PlannedGate[]; continueOf?: string }

/** `mcp__litter__record({ kind: 'gate.amend', run, gate, before?, after, reason })`. */
export type GateAmendInput = { kind: 'gate.amend'; run: string; gate: string; before?: string; after: string; reason: string }

// ---------------------------------------------------------------------------
// The gate critic's verdict (plan section 7, execute.js's VERDICT; phase 3)

/** One dimension of a verdict (execute.js's DIM). */
export type VerdictDimension = { pass: boolean; evidence: string; gaps: string[] }

/** The four dimensions, in the order the verdict and its feedback list them. */
export const VERDICT_DIMENSIONS = ['plan_adherence', 'tests_green', 'no_regressions', 'rules'] as const
export type VerdictDimensionName = (typeof VERDICT_DIMENSIONS)[number]

/**
 * A gate critic's `verdict` record body: execute's VERDICT (plan 7:377-385)
 * as the critic returned it, `tests_green` as output.sh overwrote it from the
 * cited verify, and the StructuredOutput call it came from (output.ts).
 */
export type GateVerdictBody = {
  /** The critic's own verify of the tree it judged. */
  verify_id: string
  plan_adherence: VerdictDimension
  tests_green: VerdictDimension
  no_regressions: VerdictDimension
  /** The accepted rules in the gate's `<rules>` (section 16.5); "none apply" passes. */
  rules: VerdictDimension
  /** '' unless the gate can't pass without an amendment. */
  plan_gap: string
  /** Proposals only (section 16.4): each becomes a `rule.propose` in the rules ledger. */
  proposed_rules: string[]
  /** Absent for a swarm node's, which records its verdict through the tool. */
  tool_use_id?: string
}

/**
 * A plan-template swarm's verdict (AC's swarm/gate.ts; decisions 1, 14 and
 * 15), in the run's ledger: execute's VERDICT plus the gate it judges, the
 * attempt of the verify it cites, and what the mod derives. `approved`: all
 * four dimensions pass and `plan_gap` is empty. `round` is set only on a
 * rejection (decision 1); an approval's is null, so the rounds count skips it.
 */
export type SwarmGateVerdictBody = GateVerdictBody & { gate: string; attempt: number; approved: boolean; round: number | null }

// ---------------------------------------------------------------------------
// A repair swarm's verdict (plan 15.10, 15.11; phase 2b-2, Y's swarm/gate.ts)

/** One task of the run, judged once: as fanout.js's FANOUT_CHECK has it. */
export type SwarmVerdictTask = { id: string; pass: boolean; evidence: string; gaps: string[] }

/**
 * `mcp__litter__record({ kind: 'verdict', verify_id, tasks, combined, proposed_rules })`
 * from a repair swarm's `verdicts: true` node. It cites a verify its own agent
 * recorded in this generation, and judges every task of the run once.
 */
export type SwarmVerdictInput = {
  kind: 'verdict'
  verify_id: string
  tasks: SwarmVerdictTask[]
  /** The combined result against the run's contract, as FANOUT_CHECK's `combined`. */
  combined: string
  /** Proposals only: each is recorded as a `rule.propose` with the run (decision 14). */
  proposed_rules?: string[]
}

/**
 * The verdict's run-ledger body. The shape of the fanout verifier's (a
 * `verdict` with `tasks`), so the run's summary reads both, plus what the mod
 * adds: `round`, numbered by the mod (one per distinct verify cited,
 * decision 6), and `approved`, which it derives (every task passes) rather
 * than taking from the node.
 */
export type SwarmVerdictBody = {
  verify_id: string
  tasks: SwarmVerdictTask[]
  combined: string
  proposed_rules: string[]
  round: number
  approved: boolean
}
