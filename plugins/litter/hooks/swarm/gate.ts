// A repair swarm's mod-held gates (plan 15.10, 15.11; COMMON 2b-2, step 5): a
// bound node's verify, the critic's verdict and the land of the repaired
// tree, all recorded in the swarm's run's ledger and mirrored as `gate`
// events; and the repair budget at spawn.
//
// Owner: phase 2b-2, package Y. Package V's stubs: the two exports below are
// the contract (the dispatcher in ledger.ts calls swarmGateRecord; Y adds
// the call to budgetRefusal in spawn.ts's spawn check).

import type { Ports } from '../ports'
import type { LitterOptions } from '../options'
import type { RecordInput, RecordReply } from '../records/core'
import type { BindingKind, NodeBinding } from './types'
import { fail } from '../records/core'

/** The record kinds a bound swarm node's call routes here instead of to the run's handlers. */
export type SwarmGateKind = 'verify' | 'verdict' | 'land'
export const SWARM_GATE_KINDS: readonly SwarmGateKind[] = ['verify', 'verdict', 'land']

export const isSwarmGateKind = (kind: string): kind is SwarmGateKind => (SWARM_GATE_KINDS as readonly string[]).includes(kind)

/**
 * A bound node's gate call, as the record tool's dispatcher hands it over
 * (ledger.ts, dispatchRecord): the kind matched, the spool drained, the
 * caller's binding found after the state's gate opened, the input decoded and
 * within the record bound. The caller is never a run agent (one whose agent
 * map entry has a role and a run): those are routed as before.
 *
 * `input.run` is whatever the node sent, if anything. The run is its swarm's
 * (`LiveSwarm.run`), never the input's, so the gate refuses or ignores it.
 */
export type SwarmGateCall = {
  kind: SwarmGateKind
  input: RecordInput
  /** The calling agent, with its type from the agent map (null when the map has none). */
  caller: { agentId: string; agentType: string | null }
  binding: NodeBinding
  litterDir: string
  options: LitterOptions
}

/**
 * Answers a bound node's `verify`, `verdict` or `land` in the dispatcher's
 * result shape: a refusal names the field and the fix ("Errors are
 * recoverable"); a failure that isn't the node's throws, so the record tool's
 * catch denies the call. The stub refuses every call.
 */
export async function swarmGateRecord(_p: Ports, call: SwarmGateCall): Promise<RecordReply> {
  return fail(`litter: a swarm node's '${call.kind}' record isn't built yet (phase 2b-2)`, 'kind')
}

/**
 * The spawn check's budget refusal for a repair swarm (15.11): the text the
 * spawning node reads, telling it to report blocked to its parent with what
 * it needs; null when the spawn is within the budget, or the swarm has none
 * (no `LiveSwarm.budget`), or `kind` is an orchestrator's (decision 7). It
 * reads the state only, never awaits, so the spawn check can call it in the
 * step that reserves. The stub refuses nothing.
 */
export function budgetRefusal(_swarm: string, _kind: BindingKind): string | null {
  return null
}
