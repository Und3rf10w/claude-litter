// The card's render (phase 5; plan 11, "Finished-run card"; COMMON decisions
// 8, 11, 12): the row's card from the `cards` atom by `e.props.task.id`
// (cardOf: null for a row with no card, which register.tsx passes to
// next(e)), at most 6 rows (the title, up to four lines, [Board]). Owner: WP-CC.
//
// Expanded (ctrl+o's transcript, or `verbose`, where every row is:
// cli_formatted_2.1.290.js:1200609) the card is drawn above the engine's own
// row, `below`, which register.tsx awaits from next(e), so both show; else
// the card alone (WP-CK: a verbose user never saw a card when an expanded row
// was the engine's alone).
//
// A pure function of its arguments: view.ts cleaned and cut every text, and its
// colors are theme keys beside a word or glyph. Every Text truncates, so a
// row never wraps past its six. The elements are called as constructors, not
// written as JSX, so tier 2 can draw a card with a table of its own.
//
// The colors are the `litter` pane's (phase 5b, WP-DB: ui/style.ts): a dim
// span with no color of its own is drawn `muted`, as the pane's `themed`
// table draws it, not in the terminal's faint attribute.

import type { RenderElement } from 'claude-code'
import type { CardElements, CardRender } from '../hooktypes'
import type { CardView, CardsView, SwarmSpan } from '../../types/index'
import { STYLE } from '../ui/style'

/** The rows a card takes at most. */
export const CARD_ROWS = 6

// The ui.press hook (view.ts, onCardUi) answers litter's keys without passing them on.
const noop = (): void => {}

/** One row: its spans in one Text, cut at the row's end. */
function row(el: CardElements, spans: readonly SwarmSpan[]): RenderElement {
  const { Text } = el
  return Text({
    wrap: 'truncate',
    children: spans.map(s => {
      const color = s.color ?? (s.dim ? STYLE.muted : undefined)
      return Text({ wrap: 'truncate', ...(color ? { color } : {}), ...(s.bold ? { bold: true } : {}), children: s.text })
    }),
  })
}

/** The row's card by its task id, expanded or not; null when the view has none for it (an own key only, never Object's). */
export function cardOf(view: CardsView | null, e: CardRender): CardView | null {
  const id = e.props.task?.id
  if (typeof id !== 'string' || !view || !Object.hasOwn(view.byTask, id)) return null
  return view.byTask[id]!
}

/** The card; with `below` (an expanded row's engine drawing), the card above it in one column. */
export function renderCard(card: CardView, resolved: CardElements, below: RenderElement | null): RenderElement {
  const { Box, Button } = resolved
  const buttons = card.buttons.map(b => Button({ key: b.key, label: b.label, onPress: noop }))
  const lines = card.lines.slice(0, CARD_ROWS - 1 - (buttons.length > 0 ? 1 : 0))
  const rows = [row(resolved, card.title), ...lines.map(l => row(resolved, l))]
  if (buttons.length > 0) rows.push(Box({ flexDirection: 'row', columnGap: 1, children: buttons }))
  const drawn = Box({ flexDirection: 'column', children: rows })
  return below === null ? drawn : Box({ flexDirection: 'column', children: [drawn, below] })
}
