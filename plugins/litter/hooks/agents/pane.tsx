// /litter-agents and the agents pane (phase 5; COMMON step 6, decisions 5, 6,
// 16): this session's agents and the picked team's members, with status and
// unread counts; the selected agent's pending inbox and transcript tail; a
// composer, a broadcast to the team, and [Stop] with a confirm. Rebuilt on
// the ui tick while the pane is open. Keys are `agents:<action>[:<arg>]`.
// Inboxes go through hooks/team/store.ts. Owner: WP-CG.
//
// CA's stub: the command answers that the pane isn't built yet, the render
// draws the "nothing yet" tree, the handlers pass on, the tick and the
// refresh write nothing.

import type { RenderElement } from 'claude-code'
import type { Ports } from '../ports'
import type { CommandRunHook, PaneElements, PaneRender, PaneUiHandlers, PortHook } from '../hooktypes'
import type { AgentsPaneView } from '../../types/index'
import { header, tableFor } from '../swarm/builder'

export const AGENTS_PANE = 'litter-agents'

/** command.run on `litter-agents`: opens the pane on the team named, else this session's agents; answers a one-line `text`. */
export const agentsCommand: PortHook<CommandRunHook> = async (p, e, next) => ({ text: "litter: the agents pane isn't built yet (WP-CG)" })

/** register.tsx's ui.render hook for `{ component: 'Pane', requestId: 'litter-agents' }` calls it with the agentsPane atom. A pure renderer. */
export function renderAgentsPane(view: AgentsPaneView | null, resolved: PaneElements, e: PaneRender): RenderElement {
  const el = tableFor(resolved, e.surface)
  const { Box, Text } = el
  const body = view?.body
  if (!body) {
    return (
      <Box flexDirection="column">
        <Text bold>litter · agents</Text>
        <Text dimColor>nothing to show yet: /litter-agents opens this session's agents</Text>
      </Box>
    )
  }
  return <Box flexDirection="column">{header(el, body.title, body.notice ?? null)}</Box>
}

/** The pane's ui.message, ui.press, ui.input and ui.select; anything not keyed `agents:` passes on. */
export const onAgentsUi: PaneUiHandlers = {
  message: async (p, e, next) => next(e),
  press: async (p, e, next) => next(e),
  input: async (p, e, next) => next(e),
  select: async (p, e, next) => next(e),
}

/** The ui tick's fourth step (uitick.ts): the pane's view again while it's open, written only when its stamp moved. */
export async function agentsTick(p: Ports): Promise<void> {}

/** After a /clear wiped $.state (clear.ts): the pane's view again, if it's open. */
export async function refreshAgents(p: Ports): Promise<void> {}
