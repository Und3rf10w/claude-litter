// The rules pane, `litter-rules` (plan 16.3, 16.8): the only place a rule is
// accepted, dismissed or retired. Its buttons are the only path to store.ts's
// acceptRule, dismissRule and retireRule (COMMON, "Only you accept"). Keys
// are `rules:<action>[:<arg>]`. Owner: phase 3, package AF.
//
// AA's stub: /litter-rules writes an empty view (so the pane's atom is wired
// end to end) and answers that the pane isn't built yet; the render draws a
// placeholder; every ui.* event passes on; nothing opens the pane.

import type { RenderElement } from 'claude-code'
import type { Ports } from '../ports'
import type { CommandRunHook, PaneElements, PaneRender, PaneUiHandlers, PortHook } from '../hooktypes'
import type { ProposalRef } from '../records/rules'
import type { RulesPaneView } from '../../types/index'

export const RULES_PANE = 'litter-rules'

/** command.run on `litter-rules`: opens the `litter-rules` pane on the Proposed tab, answering a one-line `text`. */
export const rulesCommand: PortHook<CommandRunHook> = async (p, e, next) => {
  await p.setView('rules', { view: 'rules', v: 0, tab: 'proposed' })
  return { text: "litter: the rules pane isn't built yet (phase 3, package AF)" }
}

/** register.tsx's ui.render hook for `{ component: 'Pane', requestId: 'litter-rules' }` calls it with the rulesPane atom. A pure renderer. */
export function renderRulesPane(view: RulesPaneView | null, el: PaneElements, e: PaneRender): RenderElement {
  const { Box, Text } = el
  const title = view?.body ? view.body.title.map(s => s.text).join('') : 'litter · rules'
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dimColor>nothing to show yet: /litter-rules opens the rules pane</Text>
    </Box>
  )
}

/** The rules pane's ui.message, ui.press, ui.input and ui.select; anything not keyed `rules:` passes on. Each action refreshes the view. */
export const onRulesUi: PaneUiHandlers = {
  message: async (p, e, next) => next(e),
  press: async (p, e, next) => next(e),
  input: async (p, e, next) => next(e),
  select: async (p, e, next) => next(e),
}

/**
 * Opens the rules pane focused on a rule id or a proposal (null: the Proposed
 * tab), from the board's [Rules] and AD's rule.open and rule.import. Answers
 * whether the pane was placed; a caller whose open was refused says "run
 * /litter-rules".
 */
export async function openRulesPane(p: Ports, focus: { id?: string; proposal?: ProposalRef } | null): Promise<boolean> {
  return false
}
