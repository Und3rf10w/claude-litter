// An execute verdict's file, `verdicts/<gate>-<attempt>.md` (plan section
// 10, "On disk"), rendered from its ledger record. Owner: phase 3, package AB.
//
// AA's stub: it writes nothing.

import type { Ports } from './ports'
import type { StoredRecord } from './records/core'

/**
 * Writes layout.ts's `verdictFile(runDir, gate, attempt)` from a `verdict`
 * record (a GateVerdictBody, or a SwarmGateVerdictBody from AC), taking the
 * gate and attempt from the verify it cites: the verify id and how it ended,
 * each dimension's pass, evidence and gaps, `plan_gap`, the proposals marked
 * "proposed, not accepted", the agent and the ledger seq. The latest verdict
 * for a gate and attempt wins; one whose verify can't be found is logged and
 * skipped. Called by output.ts after a gate-critic's verdict is recorded; a
 * throw is logged there.
 */
export async function writeVerdictFile(p: Ports, runDir: string, rec: StoredRecord): Promise<void> {}
