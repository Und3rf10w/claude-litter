// summary.md's design part (plan section 9, "Run lifecycle"; COMMON decision
// 14): the stop, the delivery, the verdict card and the rest the skill reads
// by heading. Owner: phase 4, WP-BE.

import type { Ports } from '../ports'
import type { RunRef } from '../lifecycle'
import type { RunJson } from '../records/run'
import type { StoredRecord } from '../records/core'

/**
 * A design run's lines of summary.md, after the header and the Result block,
 * from its run.json and ledger records (the run's, in seq order). Called by
 * lifecycle.ts's writeSummary, inside the run's serial key when endRun writes
 * it; a throw is logged there and the rest of the summary stands.
 *
 * Stub (WP-BA): returns no lines, so summary.md is today's.
 */
export async function designSummary(_p: Ports, _ref: RunRef, _json: RunJson | null, _records: readonly StoredRecord[]): Promise<string[]> {
  return []
}
