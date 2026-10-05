// The card's render (phase 5; plan 11, "Finished-run card"; COMMON decisions
// 8, 11, 12): the row's card from the `cards` atom by `e.props.task.id`, at
// most 6 rows (the title, up to four lines, [Board]), or null for a row with
// no card, which register.tsx passes to next(e). An expanded row (ctrl+o) is
// the engine's too. Owner: WP-CC.
//
// A pure function of the view: view.ts cleaned and cut every text, and its
// colors are theme keys beside a word or glyph. Every Text truncates, so a
// row never wraps past its six. The elements are called as constructors, not
// written as JSX, so tier 2 can draw a card with a table of its own.

import type { RenderElement } from 'claude-code'
import type { CardElements, CardRender } from '../hooktypes'
import type { CardsView, SwarmSpan } from '../../types/index'

/** The rows a card takes at most. */
export const CARD_ROWS = 6

// The ui.press hook (view.ts, onCardUi) answers litter's keys without passing them on.
const noop = (): void => {}

/** One row: its spans in one Text, cut at the row's end. */
function row(el: CardElements, spans: readonly SwarmSpan[]): RenderElement {
  const { Text } = el
  return Text({
    wrap: 'truncate',
    children: spans.map(s =>
      Text({ wrap: 'truncate', ...(s.color ? { color: s.color } : {}), ...(s.dim ? { dimColor: true } : {}), ...(s.bold ? { bold: true } : {}), children: s.text }),
    ),
  })
}

export function renderCard(view: CardsView | null, resolved: CardElements, e: CardRender): RenderElement | null {
  const id = e.props.task?.id
  if (e.props.isExpanded || typeof id !== 'string' || !view || !Object.hasOwn(view.byTask, id)) return null
  const card = view.byTask[id]!
  const { Box, Button } = resolved
  const buttons = card.buttons.map(b => Button({ key: b.key, label: b.label, onPress: noop }))
  const lines = card.lines.slice(0, CARD_ROWS - 1 - (buttons.length > 0 ? 1 : 0))
  const rows = [row(resolved, card.title), ...lines.map(l => row(resolved, l))]
  if (buttons.length > 0) rows.push(Box({ flexDirection: 'row', columnGap: 1, children: buttons }))
  return Box({ flexDirection: 'column', children: rows })
}
