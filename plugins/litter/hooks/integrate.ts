// A fanout's integration (plan section 7, fanout.js steps 3 and 4): the
// `integrate` record kind, which merges the task branches onto the
// integration branch in the confirmed order, checks ownership per branch and
// for the whole result, stops at a conflict for the integrator, and finishes
// that merge on the next call. Owner: phase 2b, work package G. The
// signatures are the contract; the bodies are G's.

import type { RecordHandler, StoredRecord } from './records/core'
import type { RunJson } from './records/run'
import { notYet } from './records/core'

/**
 * `mcp__litter__record({ kind: 'integrate', run })`, from the run's relay
 * only. Answers an IntegrateReply (records/fanout.ts) and writes the relay's
 * out file keyed by `integrate_id`, so output.sh fills its StructuredOutput.
 */
export const recordIntegrate: RecordHandler = async () => notYet('integrate', '2b')

/**
 * summary.md's fanout lines: each task's result, merge and verdict, the
 * conflicts the integrator resolved, and what blocked the land. Empty for a
 * run that isn't a fanout.
 */
export function fanoutSummary(_json: RunJson | null, _records: readonly StoredRecord[]): string[] {
  return []
}
