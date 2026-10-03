// A rule's `applies.paths` patterns (16.2, 16.7): gitignore-style, relative
// to the repository root, matched as Claude Code matches a rule file's
// `paths:`. Owner: phase 3, package AE.
//
// AA's stub: every pattern is refused, and nothing matches.

/**
 * Null when `pattern` is one litter takes; else why not (`!` negation, an
 * absolute path, a `..` segment, a backslash, an empty pattern, an
 * unbalanced brace or class).
 */
export function validPattern(pattern: string): string | null {
  return `path patterns aren't checked yet (phase 3, package AE): ${JSON.stringify(pattern)}`
}

/** Whether `pattern` matches the repository-relative `path` (both NFC-normalised). */
export function matches(pattern: string, path: string): boolean {
  throw new Error(`rules/match: matches isn't built yet (phase 3, package AE), for ${pattern} and ${path}`)
}

/** The literal segments before the first with a glob character; an unanchored pattern counts as 1. Fills the 8 KiB cap in this order (16.5). */
export function specificity(pattern: string): number {
  throw new Error(`rules/match: specificity isn't built yet (phase 3, package AE), for ${pattern}`)
}
