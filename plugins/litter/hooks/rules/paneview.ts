// The rules pane's view (16.3, 16.8): the Proposed tab (pending proposals,
// unverified rule files, an import batch) and the In force tab (accepted
// rules, overrides, rules that match no file, the load's problems), from
// AD's store. Owner: phase 3, package AF.
//
// AA's stub: it throws.

import type { Ports } from '../ports'
import type { ProposalRef } from '../records/rules'
import type { RulesPaneView, RulesTab } from '../../types/index'

/** The view of `tab`, focused on a rule id, a proposal or an import batch's proposals, or on nothing. */
export async function buildRulesPane(
  p: Ports,
  litterDir: string,
  tab: RulesTab,
  focus: { id?: string; proposal?: ProposalRef } | null,
): Promise<RulesPaneView> {
  throw new Error(`rules/paneview: buildRulesPane isn't built yet (phase 3, package AF), for the ${tab} tab`)
}
