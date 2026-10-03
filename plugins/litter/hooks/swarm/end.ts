// WP-P: how a node or a whole swarm stops (15.4, "Ending"): Stop and Hard
// stop, End swarm with its stopping state and settle wait, swarm.end,
// summary.md, a restart while stopping, and the cleanup of a launch's worktrees.
//
// Stub (phase 2b-1, package C): the signatures are the contract; the bodies are P's.
// Where the brief left a parameter open, the doc comment says what C picked.

import type { Ports } from '../ports'
import type { RecordHandler } from '../records/core'
import type { SettleProgress } from './types'
import { fail } from '../records/core'

const notBuilt = (name: string): Error => new Error(`litter: ${name} is not built yet (WP-P)`)

/** [Stop node] (`soft`) and [Hard stop] (`hard`, TaskStop first): the node and its descendants go on the stopped list. */
export async function stopNode(p: Ports, swarm: string, agentId: string, how: 'soft' | 'hard'): Promise<void> {
  throw notBuilt('stopNode')
}

/** End swarm from the browser (`request`), and the unsettled report's [Wait longer] and [End, keep everything]. */
export async function endSwarm(p: Ports, swarm: string, how: 'request' | 'wait-longer' | 'keep-everything'): Promise<void> {
  throw notBuilt('endSwarm')
}

/** The lead's `swarm.end { swarm }` through the record tool: answers `{ ok: true, status: 'stopping' }` at once. */
export const recordSwarmEnd: RecordHandler = async () => fail("litter: 'swarm.end' isn't built yet (phase 2b)", 'kind')

/** What the settle wait still waits on, for N's unsettled report; null when the swarm isn't stopping. */
export function settleProgress(swarm: string): SettleProgress | null {
  throw notBuilt('settleProgress')
}

/** K's recovery for a swarm that was stopping: no node is resumed, and the settle wait resumes from the ledger. */
export async function resumeStopping(p: Ports, swarm: string): Promise<void> {
  throw notBuilt('resumeStopping')
}

/** Removes the `new` and `own` worktrees this launch created that are unchanged; records each kept one with why (K for a failed launch too). */
export async function cleanupLaunch(p: Ports, swarm: string, launch: string): Promise<void> {
  throw notBuilt('cleanupLaunch')
}

/** Writes `summary.md` in the launch folder. C's choice: it answers the file's path. */
export async function writeSwarmSummary(p: Ports, swarm: string, launch: string): Promise<string> {
  throw notBuilt('writeSwarmSummary')
}
