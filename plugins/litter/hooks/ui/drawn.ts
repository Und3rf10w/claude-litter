// What the terminal last drew of the `litter` pane (phase 5b, WP-DA2), for a
// section's hit test over its in-pane list (ui/list.tsx, listHit). ui.scroll
// carries the pointer's body row but no width, and the d.ts maps that row to
// the tree with "the scroll.offset last read", which only a render reads; so
// the pane's render (ui/pane.tsx) notes the section, its view, the body's
// context, the body's first row in the tree and that offset here. The note
// changes nothing drawn: a drawing stays a function of the atoms and the
// props. A leaf, imported by the render and by the sections' handlers alike.

import type { HubSection } from '../../types/index'
import type { BodyContext } from './chrome'

/** The shown section's view as it was drawn: register.tsx read it from that section's atom. */
export type Drawn = {
  shown: HubSection
  view: unknown
  ctx: BodyContext
  /** The body's first row in the pane's tree: the header's rows, the strip's, the gap. */
  bodyTop: number
  /** The engine's window offset over the tree, as the render last read it. */
  scrollOffset: number
}

let drawn: Drawn | null = null

/** The terminal's last drawing, or null before one. */
export const lastDrawn = (): Drawn | null => drawn

export function noteDrawn(d: Drawn): void {
  drawn = d
}

export function resetDrawnForTests(): void {
  drawn = null
}
