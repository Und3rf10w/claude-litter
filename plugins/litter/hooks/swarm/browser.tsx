// WP-N: the swarm pane's draw, every view (start, builder, proposal, browser,
// goal history, recovery card, unsettled report, read-only): a pure render
// function of the view in $.state, the surface's resolved elements, and the
// ui.render input. It never sees `$` or the ports.
//
// Stub (phase 2b-1, package C): the signature is the contract; the body is N's.

import type { RenderElement } from 'claude-code'
import type { PaneElements, PaneRender } from '../hooktypes'
import type { SwarmPaneView } from '../ports'

/** register.tsx's ui.render hook for `{ component: 'Pane', requestId: 'litter-swarm' }` calls it with the swarmPane atom. */
export function renderSwarmPane(view: SwarmPaneView | null, el: PaneElements, e: PaneRender): RenderElement {
  const { Text } = el
  return <Text>litter: not built yet</Text>
}
