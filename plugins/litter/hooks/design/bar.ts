// A design's bar: the accepted rules in scope joining it before it's frozen
// (plan 16.5; COMMON decision 4), and bar.md. Owner: phase 4, WP-BD.

import type { BarItem } from '../records/run'
import type { LoadedRule } from '../records/rules'

/**
 * The frozen bar: your items unchanged and first, then each accepted ban in
 * scope as `B<next>` with its `rule`, then the rest as one `C<next>` with
 * their `rules` (decision 4). `rules` are the selected rules' loaded docs, in
 * selection order.
 *
 * Stub (WP-BA): returns `bar` unchanged.
 */
export function rulesIntoBar(bar: BarItem[], _rules: LoadedRule[]): BarItem[] {
  return bar
}

/** bar.md, the bar as run.start froze it (moved from lifecycle.ts unchanged). */
export const renderBar = (bar: readonly BarItem[]): string =>
  ['# Bar', '', ...bar.map(b => `- **${b.id}** ${b.text}\n  Evidence: ${b.evidence}${b.reason ? `\n  Reason: ${b.reason}` : ''}`), ''].join('\n')
