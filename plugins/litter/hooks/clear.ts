// WP-O: /clear, for runs and swarms alike (15.4, "After /clear" and "Litter
// holds /clear while anything is running"): the hold with its ask, the
// rebind flag at session.end, the rebind on the first hook after it (roles,
// tools, types, commands, policy.json's session, the ownership swap,
// session.rebind, the panes, the cleared mark), and the swarm timers.
//
// Stub (phase 2b-1, package C), not built yet: the signatures are the
// contract; the bodies are O's. Until then a clear passes, and nothing rebinds.

import type { Ports } from './ports'
import type { CommandRunHook, PortHook, SessionEndHook } from './hooktypes'

/** command.run on `clear`, after register.tsx's drain: holds it while anything runs, or passes it on. */
export const holdClear: PortHook<CommandRunHook> = async (p, e, next) => next(e)

/** session.end, within its 1.5 s bound, before lifecycle.ts's onSessionEnd: reason `clear` sets the rebind flag; any other stops the owner beats. */
export async function noteSessionEnd(p: Ports, e: Parameters<SessionEndHook>[1]): Promise<void> {}

/**
 * Awaited at the top of every hook but session.start and session.end. With
 * nothing pending it costs one check; with a rebind pending, the first caller
 * runs it and the rest wait (p.sleep polls).
 */
export async function rebound(p: Ports): Promise<void> {}

/** At session.start, with the timers: the 2 s tick (a changed session id starts the rebind; the summary runs from it). */
export function startSwarmTimers(p: Ports): void {}
