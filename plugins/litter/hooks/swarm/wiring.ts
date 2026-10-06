// The swarm hooks' catches, and the agent.offer handler (plan section 9,
// "The refusal has each event's own shape"; 15.4). register.tsx wires each
// hook as an inline literal and names its catch from here.
//
// A catch never uses `$`. It may read state.ts synchronously, to tell a
// node's event from anyone else's: a node's is refused (fail closed), anyone
// else's passes on, so a failing swarm hook never touches a session with no
// swarm live. Where the state can't tell (a send's `to` by name), a session
// with a swarm live refuses. A former node whose policy file End kept, its
// swarm ended, counts as a node (end.ts's kept files, also read synchronously),
// as admission refuses it (admit.ts, endedSwarmOf).
//
// None refuses once its hook had called `next` (`next.called`, the 2.1.290
// d.ts's Caught; WP-CH): what runs beneath (the spawn, the delivery, the model
// request) has run, so a refusal would undo nothing and only misreport it.
// Each then answers `next(e)`, what that call settled to, or for turn.step
// lets it stand.
//
// Contract owner: phase 2b-1, package C.

import type {
  AgentOfferCatch,
  AgentOfferHook,
  CommandRunCatch,
  PortHook,
  SessionSendCatch,
  SpawnCatch,
  SwarmProposeCatch,
  SwarmReadCatch,
  SwarmSendCatch,
  TurnStartCatch,
  TurnStepCatch,
  UiInputCatch,
  UiMessageCatch,
  UiPressCatch,
  UiRenderCatch,
  UiSelectCatch,
} from '../hooktypes'
import { SWARM_TYPE_PREFIX } from '../layout'
import { roleSpawnFailed } from '../launch'
import { binding, liveSwarm, liveSwarms, swarmOfType } from './state'
import { keepsOwn, keptSwarmOf } from './end'
import { unprefixed } from './view'

/** Why the hook failed, on one line, for a refusal's text. */
function why(next: { readonly error?: { readonly kind: string; readonly message?: string } }): string {
  const m = next.error?.message
  return typeof m === 'string' && m !== '' ? m.replace(/\s+/g, ' ').slice(0, 300) : (next.error?.kind ?? 'unknown')
}

const isBound = (agentId: string | undefined): boolean => agentId !== undefined && binding(agentId) !== null

/** An agent of a swarm that has ended, whose policy file End kept while it ran (FIX-U, U2). */
const isFormer = (agentId: string | undefined): boolean => agentId !== undefined && keptSwarmOf(agentId.trim()) !== null

/**
 * agent.spawn's catch: a spawn of a swarm type, or by a bound node or child,
 * is denied; everything else gets the role block's catch's answer
 * (launch.ts's spawnBlockFailed, through its `$`-free half), which refuses a
 * main-thread spawn of a litter type and passes the rest on. After the hook's
 * `next`, the subagent has started (the d.ts, AgentSpawnResult): its result.
 */
export const agentSpawnFailed: SpawnCatch = async ($, e, next) => {
  if (next.called) return next(e)
  if (e.subagentType.startsWith(SWARM_TYPE_PREFIX) || isBound(e.parentAgentId)) {
    return { deny: `litter guard failed: agent.spawn (${why(next)}); refusing` }
  }
  return roleSpawnFailed(e, next)
}

/**
 * A `to` the state alone can tell isn't a node: `main`, the lead's address.
 * A name or a received `from` address could still be a node's, and the state
 * can't resolve those without the hook that failed.
 */
const knownNonNode = (to: string): boolean => to === 'main'

/**
 * session.send's catch, failing closed: a send from a bound node isn't
 * delivered, nor one to a bound node or to a former node of an ended swarm;
 * while a swarm this session owns (not read-only) is live, or a former node
 * of this session's still runs, neither is one whose `to` isn't a known
 * non-node (a name, or a `from` address, could be one of theirs). It passes
 * on only with none of those, or to a known non-node from an unbound sender.
 * After the hook's `next` the message was sent: that send's answer.
 */
export const sessionSendFailed: SessionSendCatch = async ($, e, next) => {
  if (next.called) return next(e)
  const ownedLive = liveSwarms().some(s => !s.readOnly) || keepsOwn()
  if (isBound(e.agentId) || isBound(e.to) || isFormer(e.to) || (ownedLive && !knownNonNode(e.to))) {
    return { isDelivered: false, reason: `litter guard failed: session.send (${why(next)})` }
  }
  return next(e)
}

/**
 * turn.step's catch, a generator like the hook: a bound node's step, or a
 * former node's, gets the refusal stream and the whole TurnStepResult
 * (without it the engine sends the request anyway, 15.9 item 15); any other
 * loop's passes on. After the hook's `next` (admitStep calls it only for a
 * step it admitted) the request was sent and its chunks shown: it returns
 * nothing, so that call's stream and result stand (the d.ts, StreamHookBody),
 * and a request that failed beneath fails as the engine's, not as litter's.
 */
export const turnStepFailed: TurnStepCatch = async function* ($, e, next) {
  if (next.called) return
  if (!isBound(e.agentId) && !isFormer(e.agentId)) return yield* next(e)
  const answer = `litter guard failed: turn.step (${why(next)}); ending this turn`
  yield { kind: 'text', index: 0, text: answer }
  yield { kind: 'stop', stopReason: 'end_turn', usage: null }
  return { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null }
}

/** turn.start's catch: passes on (it only marks the lead busy). */
export const turnStartFailed: TurnStartCatch = async ($, e, next) => next(e)

/** agent.offer's catch: passes on; the spawn check refuses a type that shouldn't run. */
export const agentOfferFailed: AgentOfferCatch = async ($, e, next) => next(e)

/** command.run `clear`'s catch: the clear goes ahead. */
export const clearHoldFailed: CommandRunCatch = async ($, e, next) => next(e)

/** command.run `litter-swarm`'s catch: a line the person reads, so no `litter: ` (the engine names the plugin first). */
export const swarmCommandFailed: CommandRunCatch = async ($, e, next) => ({ text: `/litter-swarm failed (${unprefixed(why(next))})` })

/** command.run `litter-doctor`'s catch, the same. */
export const doctorCommandFailed: CommandRunCatch = async ($, e, next) => ({ text: `/litter-doctor failed (${unprefixed(why(next))})` })

/** ui.render's catch for both panes: the engine draws its own. */
export const paneRenderFailed: UiRenderCatch = async ($, e, next) => next(e)

/** The panes' ui.message, ui.press, ui.input and ui.select catches: pass on. */
export const uiMessageFailed: UiMessageCatch = async ($, e, next) => next(e)
export const uiPressFailed: UiPressCatch = async ($, e, next) => next(e)
export const uiInputFailed: UiInputCatch = async ($, e, next) => next(e)
export const uiSelectFailed: UiSelectCatch = async ($, e, next) => next(e)

/** The swarm tools' catches: an error result naming the hook, never passed on (like recordFailed). */
export const swarmProposeFailed: SwarmProposeCatch = async ($, e, next) => ({
  deny: `litter guard failed: mcp__litter__swarm_propose (${why(next)}); refusing`,
})
export const swarmReadFailed: SwarmReadCatch = async ($, e, next) => ({
  deny: `litter guard failed: mcp__litter__swarm_read (${why(next)}); refusing`,
})
export const swarmSendFailed: SwarmSendCatch = async ($, e, next) => ({
  deny: `litter guard failed: mcp__litter__swarm_send (${why(next)}); refusing`,
})

/**
 * agent.offer: a swarm type (`litter:sw-…`, as the engine serves it in
 * `e.agent`) is offered only while a live swarm this session owns has it
 * (state.ts's type tables, never the name split); an ended swarm's, a lost
 * one's and another session's aren't. Anything else passes on. It runs at
 * every listing, so it's a lookup and nothing more.
 */
export const offerSwarmType: PortHook<AgentOfferHook> = async (_p, e, next) => {
  if (!e.agent.startsWith(SWARM_TYPE_PREFIX)) return next(e)
  const hit = swarmOfType(e.agent)
  const s = hit ? liveSwarm(hit.swarm) : null
  if (!s || s.readOnly || s.lost) return { isOffered: false }
  return next(e)
}
