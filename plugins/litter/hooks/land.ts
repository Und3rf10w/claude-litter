// The `land` record: commit exactly the verified tree with commit-tree, move
// the run's branch with a compare-and-swap, keep your index with the two-tree
// merge, idempotent per verify_id, with crash recovery by trailer (plan
// sections 7 and 9). Owner: phase 1b, work package C.

import type { Ports } from './ports'
import type { RecordHandler } from './records/core'
import { notYet } from './records/core'

export const recordLand: RecordHandler = async () => notYet('land', '1b')

/** At session.start and before a land: finds lands the ledger missed by their trailers, abandons stale intents. */
export async function reconcileLands(_p: Ports, _runDir: string, _run: string): Promise<void> {}
