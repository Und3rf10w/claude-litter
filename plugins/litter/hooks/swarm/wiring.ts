// The swarm hooks' catches, and the agent.offer handler (plan section 9,
// "The refusal has each event's own shape"; 15.4). register.tsx wires each
// hook as an inline literal and names its catch from here.
//
// A catch never uses `$`. It may read state.ts synchronously, to tell a
// node's event from anyone else's: a node's is refused (fail closed), anyone
// else's passes on, so a failing swarm hook never touches a session with no
// swarm live.
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
import { binding, liveSwarm, swarmOfType } from './state'

/** Why the hook failed, on one line, for a refusal's text. */
function why(next: { readonly error?: { readonly kind: string; readonly message?: string } }): string {
  const m = next.error?.message
  return typeof m === 'string' && m !== '' ? m.replace(/\s+/g, ' ').slice(0, 300) : (next.error?.kind ?? 'unknown')
}

const isBound = (agentId: string | undefined): boolean => agentId !== undefined && binding(agentId) !== null

/**
 * agent.spawn's catch: a spawn of a swarm type, or by a bound node or child,
 * is denied; everything else gets the role block's catch's answer
 * (launch.ts's spawnBlockFailed, through its `$`-free half), which refuses a
 * main-thread spawn of a litter type and passes the rest on.
 */
export const agentSpawnFailed: SpawnCatch = async ($, e, next) => {
  if (e.subagentType.startsWith(SWARM_TYPE_PREFIX) || isBound(e.parentAgentId)) {
    return { deny: `litter guard failed: agent.spawn (${why(next)}); refusing` }
  }
  return roleSpawnFailed(e, next)
}

/** session.send's catch: a send from or to a bound node isn't delivered; anyone else's passes on. */
export const sessionSendFailed: SessionSendCatch = async ($, e, next) => {
  if (isBound(e.agentId) || isBound(e.to)) {
    return { isDelivered: false, reason: `litter guard failed: session.send (${why(next)})` }
  }
  return next(e)
}

/**
 * turn.step's catch, a generator like the hook: a bound node's step gets the
 * refusal stream and the whole TurnStepResult (without it the engine sends the
 * request anyway, 15.9 item 15); any other loop's passes on.
 */
export const turnStepFailed: TurnStepCatch = async function* ($, e, next) {
  if (!isBound(e.agentId)) return yield* next(e)
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

/** command.run `litter-swarm`'s catch. */
export const swarmCommandFailed: CommandRunCatch = async ($, e, next) => ({ text: `litter: /litter-swarm failed (${why(next)})` })

/** command.run `litter-doctor`'s catch. */
export const doctorCommandFailed: CommandRunCatch = async ($, e, next) => ({ text: `litter: /litter-doctor failed (${why(next)})` })

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
