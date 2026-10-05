// A design's bar: the accepted rules in scope joining it before it's frozen
// (plan 16.5; COMMON decision 4), and bar.md. Owner: phase 4, WP-BD.

import type { BarItem } from '../records/run'
import type { LoadedRule, RuleDoc, RuleRef } from '../records/rules'

/** A ban's evidence when its rule has no How to check lines (decision 4). */
export const BAN_EVIDENCE = "the proposal's file list and design, checked against the ban"
/** The evidence of the one criterion for the rules that aren't bans. */
export const RULES_EVIDENCE = 'each rule checked against the proposal, by id'

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const at = (r: RuleRef): string => `${r.id}@${r.version}`

/** The highest n among your `C<n>` or `B<n>` ids; 0 when there's none. */
function highest(bar: readonly BarItem[], letter: 'B' | 'C'): number {
  let n = 0
  for (const b of bar) {
    const m = /^([BC])([0-9]+)$/.exec(b.id)
    if (m && m[1] === letter) n = Math.max(n, Number(m[2]))
  }
  return n
}

/**
 * The frozen bar: your items unchanged and first, then each accepted ban in
 * scope as `B<next>` with its `rule`, then the rest as one `C<next>` with
 * their `rules` (decision 4). `rules` are the selected rules' loaded docs, in
 * selection order; each is read in the version in force (`delivered`).
 *
 * A ban is the categorical ban 16.5 makes of it: its Rule section, its How to
 * check lines as the evidence, and its Why as the reason. The rest can be
 * changed only by asking you (16.5), so they're one criterion, left out when
 * there are none.
 */
export function rulesIntoBar(bar: BarItem[], rules: LoadedRule[]): BarItem[] {
  const docs = rules.map(r => r.delivered).filter((d): d is RuleDoc => d !== null)
  let b = highest(bar, 'B')
  const bans: BarItem[] = docs
    .filter(d => d.type === 'ban')
    .map(d => {
      const checks = d.body.howToCheck.map(oneLine).filter(x => x !== '')
      const rule = { id: d.id, version: d.version }
      return {
        id: `B${++b}`,
        text: oneLine(d.body.rule),
        evidence: checks.length > 0 ? checks.join('; ') : BAN_EVIDENCE,
        // A ban needs a reason (decision 5); a rule file's Why is optional.
        reason: oneLine(d.body.why) || `the accepted ban ${at(rule)}`,
        rule,
      }
    })
  const rest = docs.filter(d => d.type !== 'ban').map(d => ({ id: d.id, version: d.version }))
  const consistent: BarItem[] =
    rest.length === 0
      ? []
      : [
          {
            id: `C${highest(bar, 'C') + 1}`,
            text: `Consistent with rules ${rest.map(at).join(', ')}, or asks before changing one, as a blocking user decision.`,
            evidence: RULES_EVIDENCE,
            rules: rest,
          },
        ]
  return [...bar, ...bans, ...consistent]
}

/**
 * The loaded files of the rules a selection delivered, in its order
 * (`versions`, the selection's): each by its id and the version in force.
 * `changed`: one whose id is in force at another version now (an edit
 * accepted since the selection read the store). `gone`: those no file in
 * force holds any more (retired or deleted since), which no item can name.
 */
export function selectedRules(
  loaded: readonly LoadedRule[],
  versions: readonly RuleRef[],
): { rules: LoadedRule[]; gone: RuleRef[] } | { changed: RuleRef } {
  const rules: LoadedRule[] = []
  const gone: RuleRef[] = []
  for (const v of versions) {
    const same = loaded.filter(x => x.delivered !== null && x.delivered.id === v.id)
    const r = same.find(x => x.delivered!.version === v.version)
    if (r) rules.push(r)
    else if (same.length > 0) return { changed: v }
    else gone.push(v)
  }
  return { rules, gone }
}

/** bar.md, the bar as run.start froze it, an accepted ban naming its rule. */
export const renderBar = (bar: readonly BarItem[]): string =>
  [
    '# Bar',
    '',
    ...bar.map(
      b =>
        `- **${b.id}** ${b.text}\n  Evidence: ${b.evidence}${b.reason ? `\n  Reason: ${b.reason}` : ''}${b.rule ? `\n  Rule: ${at(b.rule)}` : ''}`,
    ),
    '',
  ].join('\n')
