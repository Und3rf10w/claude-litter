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

/** `mcp__litter__record({ kind: 'verify', run, gate, attempt })`. */
export type VerifyInput = { kind: 'verify'; run: string; gate: GateRef; attempt: number }

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
  log_parts: number
  log_bytes: number
  /** The last 200 lines across both streams, cut to the last 64 KiB. */
  output_tail: string
}

/** exit 0, not timed out, the tree unchanged, no dirty submodules. */
export type VerifyReply = {
  ok: true
  verify_id: string
  exit_code: number | null
  signal: string | null
  timed_out: boolean
  green: boolean
  /** The log part folder, absolute, under litterDir. */
  log: string
  output_tail: string
}

/** `mcp__litter__record({ kind: 'land', run, gate, verify_id })`. */
export type LandInput = { kind: 'land'; run: string; gate: GateRef; verify_id: string }

export type LandReply =
  | { ok: true; landed: true; commit: string; reason: null; retry: false }
  | { ok: true; landed: false; commit: null; reason: string; retry: boolean }

export type LandIntentBody = { gate: GateRef; verify_id: string; tree: string; parent: string; ref: string }
export type LandBody = { gate: GateRef; verify_id: string; commit: string; tree: string; parent: string; ref: string }
export type LandAbandonedBody = { gate: GateRef; verify_id: string; reason: string }
export type LandBlockedBody = { gate: GateRef; verify_id: string; reason: string; paths?: string[] }
