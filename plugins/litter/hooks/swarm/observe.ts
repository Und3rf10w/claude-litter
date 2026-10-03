// WP-P: what the mod learns from the hooks about running nodes: the spool
// consumer (in-flight calls, shells, reports, holds, denials), a node's
// turn.complete (tokens, reports, the branch checks), and [That was me].
//
// Stub (phase 2b-1, package C), not built yet: the signatures are the
// contract; the bodies are P's. Until then the swarm's spool lines change nothing.

import type { Ports } from '../ports'
import type { SpoolConsumer } from '../hookfiles'
import type { TurnCompleteHook } from '../hooktypes'

/** In registry.ts's SPOOL_CONSUMERS, right after consumeAgents. */
export const consumeSwarm: SpoolConsumer = async () => {}

/** turn.complete for a bound node, after L's settleNode: tokens, the report outside auto mode, an aborted turn's calls, the branch checks. */
export async function observeNodeTurn(p: Ports, e: Parameters<TurnCompleteHook>[1]): Promise<void> {}

/** [That was me] on a branch-moved event: records `branch-moved-ack` for its `seq`. */
export async function ackBranchMoved(p: Ports, swarm: string, seq: number): Promise<void> {
  throw new Error('litter: ackBranchMoved is not built yet (WP-P)')
}
