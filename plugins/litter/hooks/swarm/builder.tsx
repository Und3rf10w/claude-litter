// WP-N: the builder view's draw (15.5's mockup): the tree as the Client
// module, the inspector's fields with their enforcement badges, the briefs,
// the status strip and the buttons. A pure render function; browser.tsx's
// renderSwarmPane calls it for the builder view.
//
// Stub (phase 2b-1, package C): the signature is the contract; the body is N's.

import type { RenderElement } from 'claude-code'
import type { PaneElements, PaneRender } from '../hooktypes'
import type { SwarmPaneView } from '../ports'

export function renderBuilder(view: SwarmPaneView, el: PaneElements, e: PaneRender): RenderElement {
  const { Text } = el
  return <Text>litter: not built yet</Text>
}
