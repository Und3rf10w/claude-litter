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

/** Recorded before any git write (step 1). `old` is the ref's checked tip, `tree` the verified tree T. */
export type LandIntentBody = { gate: GateRef; verify_id: string; tree: string; old: string; ref: string; mode: LandMode }

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
