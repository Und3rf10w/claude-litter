// The card's render (phase 5; COMMON decisions 8, 11): the row's card from the
// `cards` atom by `e.props.task.id`, at most 6 rows, or null for a row with
// no card, which register.tsx passes to next(e). A pure function of the view.
// Owner: WP-CC.
//
// CA's stub: null, so every row is the engine's.

import type { RenderElement } from 'claude-code'
import type { CardElements, CardRender } from '../hooktypes'
import type { CardsView } from '../../types/index'

export function renderCard(view: CardsView | null, resolved: CardElements, e: CardRender): RenderElement | null {
  return null
}
