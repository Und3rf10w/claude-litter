// What the session has spent, read for the swarms (phase 5b, WP-DH). The
// engine prices no agent alone: `$.session.usage().cost` is the process's
// cost ledger, every response of the lead's and of every agent's summed. So a
// swarm's spend is how far that total grew while it was live here
// (swarm/state.ts's noteSpend), read at its launch, at a recovery, at each
// session.measure (the engine raises one as a turn ends, the lead's or any
// agent's), and at Stats' tick.
//
// Its own module, importing the state alone, so the launch and the hooks
// reach it with no cycle.

import type { Ports, SessionUsage } from '../ports'
import { noteSpend } from '../swarm/state'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The session's cost total, as `usage` read it, for the swarms; nothing where the host keeps no ledger. */
export async function noteUsage(p: Ports, usage: Pick<SessionUsage, 'cost'>): Promise<void> {
  if (usage.cost === undefined) return
  noteSpend(await p.sessionId(), usage.cost.usd, await p.now())
}

/** Reads the usage and notes its total; null (logged) when it can't be read. Never throws. */
export async function measureSpend(p: Ports): Promise<SessionUsage | null> {
  try {
    const usage = await p.usage()
    await noteUsage(p, usage)
    return usage
  } catch (err) {
    p.log(`the session's usage couldn't be read: ${errText(err)}`)
    return null
  }
}
