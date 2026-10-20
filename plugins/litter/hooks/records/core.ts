// The ledger's envelope and the record tool's calling convention. The kinds'
// own bodies live beside this file, one file per owner (execute.ts, run.ts,
// design.ts), so parallel work never edits the same file.
//
// Contract owner: phase 1a.

import type { Ports } from '../ports'
import type { LitterOptions } from '../options'

/** Who made a record. `launcher` is the main thread (a skill); `mod` is litter itself. */
export type Author =
  | { source: 'agent'; agentId: string; agentType: string | null }
  | { source: 'launcher' }
  | { source: 'mod' }

/** One file under `<runDir>/ledger/`, `<seq>-<kind>.json` (layout.ledgerFileName). Never rewritten. */
export type StoredRecord<B = Record<string, unknown>> = {
  v: 1
  /** From 1, assigned by the mod, one per record, no gaps. */
  seq: number
  kind: string
  run: string
  /** Milliseconds since the epoch, from the mod's clock. */
  at: number
  by: Author
  /** sha256 of the previous record file's exact text; null for seq 1 (plan section 9, "Chained"). */
  prev: string | null
  body: B
}

/** A record's JSON may not pass this, before anything is written (plan section 9, "Every record is bounded"). */
export const RECORD_MAX_BYTES = 1024 * 1024

/** Who's calling the record tool. `agentId` null is the main thread. */
export type Caller = { agentId: string | null; agentType: string | null }

/** What a kind's handler gets besides the call's input. Tier-2 tests build one with node ports. */
export type RecordCtx = {
  p: Ports
  caller: Caller
  /** Resolved at session.start (litterdir.ts). Null when it couldn't be (the handler refuses). */
  litterDir: string | null
  options: LitterOptions
}

/**
 * The record tool's answer. The model reads it as JSON. An error names the
 * exact field and, where there's a fixed set, the allowed values, so the next
 * call can fix it (plan section 9, "Errors are recoverable").
 */
export type RecordReply = RecordOk | RecordError
export type RecordOk = { ok: true } & Record<string, unknown>
export type RecordError = { ok: false; error: string; field?: string; allowed?: readonly string[] }

/** The record tool's input is flat: `{ kind, run?, ...fields }`. */
export type RecordInput = Record<string, unknown> & { kind: string }

export type RecordHandler = (ctx: RecordCtx, input: RecordInput) => Promise<RecordReply>

export const fail = (error: string, field?: string, allowed?: readonly string[]): RecordError => {
  const out: RecordError = { ok: false, error }
  if (field !== undefined) out.field = field
  if (allowed !== undefined) out.allowed = allowed
  return out
}

export const notYet = (kind: string, phase: string): RecordError =>
  fail(`litter: the '${kind}' record isn't built yet (phase ${phase})`, 'kind')
