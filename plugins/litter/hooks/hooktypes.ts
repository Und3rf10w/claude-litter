// The hook types for each registration in register.tsx. register.tsx holds
// every hook as an inline literal that builds the ports and calls the module's
// handler, typed here as a PortHook: the engine hook's input, `next` and result,
// with the ports in place of `$` (ports.ts says why). A catch never uses `$`,
// so a module exports it with the engine's own catch type.
//
// Contract owner: phase 1a; the swarm hooks below are phase 2b-1's (package C),
// the band's and the card's phase 5's (WP-CA).

import type { CatchHandler, Elements, Hook, MatchedHook, RenderSurface } from 'claude-code'
import type { Ports } from './ports'

type AnyHook = (...args: any[]) => any

/** An engine hook with the ports in place of `$`. */
export type PortHook<H extends AnyHook> = (p: Ports, e: Parameters<H>[1], next: Parameters<H>[2]) => ReturnType<H>

/**
 * The same for a streaming hook (`turn.step`): the handler is an
 * `async function* (p, e, next)` yielding the event's chunks and returning its
 * result (or nothing), which register.tsx runs with `return yield* handler(p, e, next)`.
 */
export type PortStreamHook<H extends AnyHook> = (p: Ports, e: Parameters<H>[1], next: Parameters<H>[2]) => ReturnType<H>

export type RecordHook = MatchedHook<'tool.call', { readonly tool: 'mcp__litter__record' }>
export type RecordCatch = CatchHandler<RecordHook>
export type WorkflowHook = MatchedHook<'tool.call', { readonly tool: 'Workflow' }>
export type WorkflowCatch = CatchHandler<WorkflowHook>
export type TaskStopHook = MatchedHook<'tool.call', { readonly tool: 'TaskStop' }>
export type TaskStopCatch = CatchHandler<TaskStopHook>
export type SpawnHook = Hook<'agent.spawn'>
export type SpawnCatch = CatchHandler<SpawnHook>
export type PromptSubmitHook = Hook<'prompt.submit'>
export type PromptSubmitCatch = CatchHandler<PromptSubmitHook>
export type TurnCompleteHook = Hook<'turn.complete'>
export type TurnCompleteCatch = CatchHandler<TurnCompleteHook>
export type SessionEndHook = Hook<'session.end'>
export type SessionEndCatch = CatchHandler<SessionEndHook>

// Phase 2b: the swarm's hooks (plan 15.4; COMMON, "Wiring").
export type SessionStartHook = Hook<'session.start'>
export type SessionStartCatch = CatchHandler<SessionStartHook>
/** Every SendMessage and every plugin's `$.session.send`; `e.agentId` is the sending loop, absent for the lead. */
export type SessionSendHook = Hook<'session.send'>
export type SessionSendCatch = CatchHandler<SessionSendHook>
/** The main loop only: a subagent's run raises no turn.start (d.ts, TurnCompleteInput.turnId), and its input has no agentId. */
export type TurnStartHook = Hook<'turn.start'>
export type TurnStartCatch = CatchHandler<TurnStartHook>
/** Every model request of every loop; `e.agentId` names a subagent's. A stream: its catch is a generator too. */
export type TurnStepHook = Hook<'turn.step'>
export type TurnStepCatch = CatchHandler<TurnStepHook>
/** Matched on `command` in register.tsx (`clear`, `litter-swarm`, `litter-doctor`). */
export type CommandRunHook = Hook<'command.run'>
export type CommandRunCatch = CatchHandler<CommandRunHook>
/** `e.agent` is the type as the engine serves it, `litter:sw-<swarm>-<node>` for a node's. */
export type AgentOfferHook = Hook<'agent.offer'>
export type AgentOfferCatch = CatchHandler<AgentOfferHook>
/** A pane's draw, matched on `{ component: 'Pane', requestId }` in register.tsx. */
export type UiRenderHook = MatchedHook<'ui.render', { readonly component: 'Pane' }>
export type UiRenderCatch = CatchHandler<UiRenderHook>
/** A `Client`'s `surface.post` (the tree, swarm/tree.tsx); matched on the pane's `requestId`. */
export type UiMessageHook = Hook<'ui.message'>
export type UiMessageCatch = CatchHandler<UiMessageHook>
/** A `Button` press in a pane; matched on the pane's `requestId`, `e.element` the button's key. */
export type UiPressHook = Hook<'ui.press'>
export type UiPressCatch = CatchHandler<UiPressHook>
export type UiInputHook = Hook<'ui.input'>
export type UiInputCatch = CatchHandler<UiInputHook>
export type UiSelectHook = Hook<'ui.select'>
export type UiSelectCatch = CatchHandler<UiSelectHook>
/** One pane's `ui.*` handlers, as the board and the rules pane export them (phase 3, AF); register.tsx matches each on the pane's `requestId`. */
export type PaneUiHandlers = {
  message: PortHook<UiMessageHook>
  press: PortHook<UiPressHook>
  input: PortHook<UiInputHook>
  select: PortHook<UiSelectHook>
}
/** The three swarm tools, answered in their hooks, never passed on. */
export type SwarmProposeHook = MatchedHook<'tool.call', { readonly tool: 'mcp__litter__swarm_propose' }>
export type SwarmProposeCatch = CatchHandler<SwarmProposeHook>
export type SwarmReadHook = MatchedHook<'tool.call', { readonly tool: 'mcp__litter__swarm_read' }>
export type SwarmReadCatch = CatchHandler<SwarmReadHook>
export type SwarmSendHook = MatchedHook<'tool.call', { readonly tool: 'mcp__litter__swarm_send' }>
export type SwarmSendCatch = CatchHandler<SwarmSendHook>

/** A pane's `ui.render` input, as N's renderers take it (`e.surface`, `e.viewport`, `e.requestId`). */
export type PaneRender = Parameters<UiRenderHook>[1]
/** What `$.ui.resolve(e)` answers for a pane's render: the surface's element table (`Box`, `Text`, `Button`, …). */
export type PaneElements = Elements[RenderSurface]

// Phase 5 (WP-CA): the band above the prompt, the finished-run card, and their presses.

/**
 * The band's draw, matched on `{ component: 'AbovePrompt' }`: one instance
 * (the engine's `requestId` is `above-prompt`), raised on the terminal and
 * desktop only. `e.props`: hasSurvey, isWorking, maxRows, bodyColumns, scroll, view.
 */
export type BandRenderHook = MatchedHook<'ui.render', { readonly component: 'AbovePrompt' }>
export type BandRenderCatch = CatchHandler<BandRenderHook>
export type BandRender = Parameters<BandRenderHook>[1]
/** What `$.ui.resolve(e)` answers for the band's render. */
export type BandElements = Elements[BandRender['surface']]
/**
 * A transcript row's draw, matched on `{ component: 'UserMessage' }`: every
 * user-role row, on every surface. `e.props`: text, origin, isExpanded, task
 * (a notification's), from, onScreen; all but `text` read-only.
 */
export type CardRenderHook = MatchedHook<'ui.render', { readonly component: 'UserMessage' }>
export type CardRenderCatch = CatchHandler<CardRenderHook>
export type CardRender = Parameters<CardRenderHook>[1]
/** What `$.ui.resolve(e)` answers for a row's render. */
export type CardElements = Elements[CardRender['surface']]
/** A press on a Button in the band, any plugin's: matched on `{ component: 'AbovePrompt' }`; litter's keys start `band:`. */
export type BandPressHook = MatchedHook<'ui.press', { readonly component: 'AbovePrompt' }>
export type BandPressCatch = CatchHandler<BandPressHook>
/** A press on a Button in a transcript row, any plugin's: matched on `{ component: 'UserMessage' }`; litter's keys start `card:`. */
export type CardPressHook = MatchedHook<'ui.press', { readonly component: 'UserMessage' }>
export type CardPressCatch = CatchHandler<CardPressHook>
