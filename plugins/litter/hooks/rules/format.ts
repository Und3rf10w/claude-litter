// A rule file, 16.2's format, read and written: a small YAML subset of
// frontmatter between `---` lines, then the body's `## Rule`, `## Why`,
// `## Exceptions` and `## How to check`. Owner: phase 3, package AD.
//
// AA's stub: nothing parses, and nothing renders.

import type { RuleDoc } from '../records/rules'

/**
 * Reads one rule file. Unknown frontmatter keys go to `extra` as their raw
 * text, in order. Refused, naming the line or field: over 8 KiB, a `type`
 * other than rule or ban, an `applies.paths` pattern match.ts's validPattern
 * rejects, a missing `## Rule`, or YAML outside the subset.
 */
export function parseRule(text: string): { ok: true; doc: RuleDoc } | { ok: false; error: string } {
  return { ok: false, error: `rule files aren't read yet (phase 3, package AD); ${text.length} bytes not parsed` }
}

/**
 * Writes a rule file: the known fields in 16.2's order, then `extra`, then
 * the body. A parsed file renders back to the same bytes when nothing changed.
 */
export function renderRule(doc: RuleDoc): string {
  throw new Error(`rules/format: renderRule isn't built yet (phase 3, package AD), for ${doc.id}`)
}
