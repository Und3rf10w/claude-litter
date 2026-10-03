// WP-N: the doctor pane's draw (15.7): J's rows with their severity glyphs,
// each value's process and sources, the snippet, and [Copy], [Ask lead to add
// it], [Recheck] and [Test]. A pure render function.
//
// Stub (phase 2b-1, package C): the signature is the contract; the body is N's.

import type { RenderElement } from 'claude-code'
import type { PaneElements, PaneRender } from '../hooktypes'
import type { DoctorPaneView } from '../ports'

/** register.tsx's ui.render hook for `{ component: 'Pane', requestId: 'litter-doctor' }` calls it with the doctorPane atom. */
export function renderDoctorPane(view: DoctorPaneView | null, el: PaneElements, e: PaneRender): RenderElement {
  const { Text } = el
  return <Text>litter: not built yet</Text>
}
