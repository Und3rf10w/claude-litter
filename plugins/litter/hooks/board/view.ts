// The board's view (decision 21), built from a run's ledger and run.json
// only: the header, the execute gate table and its detail, a record list
// for the other workflows, the rule versions used and the proposals made.
// Owner: phase 3, package AF.
//
// AA's stub: it throws.

import type { Ports } from '../ports'
import type { BoardView } from '../../types/index'

/**
 * The view of `run` as /litter-board's argument gives it: a run id; `execute`
 * or `design`, the newest run of that workflow; or null, the active run, else
 * the newest. `v` increases on every rebuild; `body.stamp` is the ledger head
 * it read.
 */
export async function buildBoard(p: Ports, litterDir: string, run: string | null): Promise<BoardView> {
  throw new Error(`board/view: buildBoard isn't built yet (phase 3, package AF), for ${run ?? 'the newest run'}`)
}
