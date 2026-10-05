// The finished-run card (phase 5; COMMON step 2, decision 8): a litter run's
// task-notification row redrawn as a short verdict card, from the `cards`
// atom, built when a notification settles and rebuilt at session.start and
// after a /clear. Keys are `card:<action>[:<arg>]`. Owner: WP-CC.
//
// CA's stub: no card. cardRow answers false, so every row passes to next(e);
// the builders write nothing; a press passes on.

import type { Ports } from '../ports'
import type { CardPressHook, CardRender, PortHook, PromptSubmitHook } from '../hooktypes'

/**
 * Whether this row may be a card: a task notification's
 * (`origin.kind === 'task-notification'`, with a `task.id`) and not expanded.
 * Runs for every message row before anything else, so it's synchronous and
 * cheap; false passes the render on.
 */
export function cardRow(e: CardRender): boolean {
  return false
}

/** prompt.submit, right after settleNotices: the cards of the runs the notification settled. */
export async function noteCards(p: Ports, e: Parameters<PromptSubmitHook>[1]): Promise<void> {}

/** session.start: the cards of the 20 newest runs, so a resumed session's rows get theirs. */
export async function restoreCards(p: Ports): Promise<void> {}

/** After a /clear wiped $.state (clear.ts): the cards again. */
export async function refreshCards(p: Ports): Promise<void> {}

/** The card's presses ([Board]); a key not `card:` passes on. */
export const onCardUi: { press: PortHook<CardPressHook> } = {
  press: async (p, e, next) => next(e),
}
