// WP-L: admission for sends and wakes (session.send, turn.step), settling,
// the reply route, the message queue, mcp__litter__swarm_send, the browser's
// sends, the lead's <swarm> block, and swarm.bind with adoption after a reload.
//
// Stub (phase 2b-1, package C), not built yet: the signatures are the
// contract; the bodies are L's. Until then every hook passes on unchanged.
// Where the brief left a parameter open, the doc comment says what C picked.

import type { Ports } from '../ports'
import type { PortHook, PortStreamHook, SessionSendHook, SwarmSendHook, TurnCompleteHook, TurnStartHook, TurnStepHook } from '../hooktypes'
import type { RecordHandler } from '../records/core'
import type { BrowserSend, SendOutcome } from './types'
import { fail } from '../records/core'

/** session.send: resolve the recipient, admit or queue, take the reply route. */
export const admitSend: PortHook<SessionSendHook> = async (p, e, next) => next(e)

/** turn.step: a node turn's first step runs admission; a refused turn gets the refusal stream and the whole TurnStepResult. */
export const admitStep: PortStreamHook<TurnStepHook> = async function* (p, e, next) {
  return yield* next(e)
}

/** turn.start (the main loop only, d.ts): the lead is busy until its turn.complete. */
export async function leadTurnStart(p: Ports, e: Parameters<TurnStartHook>[1]): Promise<void> {}

/** turn.complete: a bound node settles; the lead's turn ends (and O's summary trigger). Returns early for anything else. */
export async function settleNode(p: Ports, e: Parameters<TurnCompleteHook>[1]): Promise<void> {}

/** tool.call on `mcp__litter__swarm_send`, after register.tsx's drain: answered here, never passed on. */
export const swarmSendTool: PortHook<SwarmSendHook> = async (p, e) => {
  return { result: JSON.stringify({ ok: false, error: "litter: mcp__litter__swarm_send isn't built yet" }) }
}

/** The browser's composer (N, from ui.message): direct, via the lead, or via the parent. */
export async function sendFromBrowser(p: Ports, input: BrowserSend): Promise<SendOutcome> {
  throw new Error('litter: sendFromBrowser is not built yet (WP-L)')
}

/** [Cancel] on a queued message: removes it and records `queue-cancelled`. C's choice: true when it was there. */
export async function cancelQueued(p: Ports, id: string): Promise<boolean> {
  throw new Error('litter: cancelQueued is not built yet (WP-L)')
}

/** The lead's `<swarm>` block for prompt.submit's `context`, at most 1 KiB; null with nothing live. */
export async function swarmContext(p: Ports): Promise<string | null> {
  return null
}

/** `swarm.bind { token }` through the record tool: an unbound node of a swarm type presents its `<instance>` token. */
export const recordSwarmBind: RecordHandler = async () => fail("litter: 'swarm.bind' isn't built yet (phase 2b)", 'kind')

/** After a reload (K's recoverSwarms): adopt an unbound agent when exactly one instance matches its type and parent; else hold it to swarm.bind. */
export async function adoptUnbound(p: Ports): Promise<void> {}
