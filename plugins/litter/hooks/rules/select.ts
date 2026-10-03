// Selection and delivery (16.5; COMMON decisions 25 and 26): which accepted
// rules reach each call, in compact form under the 8 KiB cap, and which
// versions a run used. Owner: phase 3, package AE.
//
// AA's stub: nothing is selected (COMMON step 0), and rule.find's
// `applicable` refuses.

import type { Ports } from '../ports'
import type { RecordReply } from '../records/core'
import type { SelectInput, Selection } from '../records/rules'
import type { LiveSwarm, SwarmNode } from '../swarm/types'
import { notYet } from '../records/core'
import { emptySelection } from '../records/rules'

/**
 * The rules for a launch, from run.start's prepare (lifecycle.ts) before it
 * writes anything: each entry rendered, per unit, with every version
 * delivered. A throw refuses the launch.
 */
export async function selectForRun(p: Ports, input: SelectInput): Promise<Selection> {
  return emptySelection()
}

/**
 * A swarm spawn's `<rules>` entries (swarm/spawn.ts, before the spawn's
 * reservation): the rules for the node's `paths` (or a plan-template node's
 * run's unlanded gates, or every rule) in `dir`, the node's working
 * directory, absolute.
 */
export async function selectForSpawn(p: Ports, litterDir: string, input: { swarm: LiveSwarm; node: SwarmNode; dir: string }): Promise<string[]> {
  return []
}

/**
 * `rule.find { applicable: { workflow, planPath | tasks | anchors, goal } }`
 * (records.ts, AD's, through its deps): exactly what selectForRun would give
 * for that launch, as `{ ok: true, run, gates | tasks, versions, problems }`.
 * Writes nothing. `applicable` is the call's field as given, unchecked.
 */
export async function findApplicable(p: Ports, litterDir: string, applicable: Record<string, unknown>): Promise<RecordReply> {
  return notYet('rule.find', '3')
}
