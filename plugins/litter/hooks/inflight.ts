// An execute run's in-flight flag (COMMON decision 24): `critique` while a
// gate-critic runs, `land` while a land does, in the run's policy.json through
// lifecycle.ts's patchRunPolicy. Execute runs only; plan-template swarms
// don't set it. Owner: phase 3, package AB.
//
// AA's stub: nothing is set, and withInflight just runs its function.

import type { Ports } from './ports'
import type { SpoolConsumer } from './hookfiles'

/**
 * A spool consumer (registry.ts, after consumeAgents): a `start` line for a
 * `litter:gate-critic` of the active execute run sets `critique`, as
 * markCritique does; that agent's `stop` line clears it, unless a land holds it.
 */
export const consumeInflight: SpoolConsumer = async () => {}

/**
 * Sets `critique` for the run and remembers the critic's agent id, from
 * verify.ts's recordVerify when a `litter:gate-critic` of an execute run
 * records its verify (whichever the mod sees first of that and its start
 * line). A throw fails the verify closed.
 */
export async function markCritique(p: Ports, litterDir: string, run: string, agentId: string): Promise<void> {}

/**
 * Runs `fn` with the run's flag at `what`, then puts back what was there
 * (`critique` while a remembered gate-critic still runs, else null) in a
 * `finally`. From land.ts's recordLand, around an execute land.
 */
export async function withInflight<T>(p: Ports, litterDir: string, run: string, what: 'land', fn: () => Promise<T>): Promise<T> {
  return fn()
}
