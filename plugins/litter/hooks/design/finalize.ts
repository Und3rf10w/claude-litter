// The end of a design run (COMMON step 6; decision 16): a plan's approved
// version delivered as plan.md, its bytes unchanged. Owner: phase 4, WP-BE.

import type { Ports } from '../ports'
import type { RunRef } from '../lifecycle'
import type { RunEndBody } from '../records/run'

/**
 * Called by lifecycle.ts's recordEnd for a design run's current end, after
 * the worktree cleanup and before summary.md, with the run's serial key held
 * (so it must not take it). `end` is the run.end just recorded, a launch
 * that never opened a generation (generation 0) included. It reads run.json
 * and the ledger itself and, for a plan deliverable, records one
 * `design.deliver` (DesignDeliverBody): delivered, `proposals/vN.md` copied
 * to plan.md once its sha256 equals the proposal record's and the
 * approving verdict's, or refused with why. A throw is logged by the caller,
 * and the summary still follows.
 *
 * Stub (WP-BA): does nothing.
 */
export async function finalizeDesign(_p: Ports, _ref: RunRef, _end: RunEndBody): Promise<void> {}
