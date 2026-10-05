// A design run's verdict and probe files, each rendered from its ledger
// record (plan section 10, "On disk"; COMMON decisions 17 and 18). Owner:
// phase 4, WP-BC. WP-BA's stubs write nothing.

import type { Ports } from '../ports'
import type { StoredRecord } from '../records/core'

/**
 * `verdicts/<version>.md` (layout.ts, designVerdictPath) from a stored
 * `verdict` record (DesignVerdictBody): the version, its sha256,
 * `source_changed`, the criteria as a table and the overall result. The
 * latest record for a version wins. A version that isn't PROPOSAL_VERSION
 * writes nothing and is logged.
 *
 * Stub (WP-BA): writes nothing.
 */
export async function writeDesignVerdictFile(_p: Ports, _runDir: string, _rec: StoredRecord): Promise<void> {}

/**
 * `probes/<unknown_id>.md` (layout.ts, probePath) from a stored `probe`
 * record (ProbeBody): the unknown's id, the verdict and the report. The
 * latest record for an id wins. An id that isn't UNKNOWN_ID writes nothing
 * and is logged.
 *
 * Stub (WP-BA): writes nothing.
 */
export async function writeProbeFile(_p: Ports, _runDir: string, _rec: StoredRecord): Promise<void> {}
