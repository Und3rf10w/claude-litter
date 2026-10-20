// A rule's `applies.paths` patterns (16.2, 16.7): gitignore-style, relative
// to the repository root, matched as Claude Code matches a rule file's
// `paths:`, so selection and an exported rule file agree. Owner: phase 3,
// package AE.
//
// The engine (cli 2.1.287): `dht` (:188439) splits each entry at its
// top-level commas and expands `{a,b}` brace sets, trimming each part; `y0n`
// (:407640-407648) drops a trailing `/**`, and reads a list of nothing but
// `**` as no paths at all; `vJ` (:408654-408676) then asks the bundled
// `ignore` package (node-ignore 7, :199203, case-insensitive by default)
// whether the path relative to the repository is ignored. That package
// matches a path when a pattern matches it or any folder above it.
//
// One difference, on purpose: `dht` doesn't nest (`{a,{b,c}}` comes out as
// `a}`, `b`, `c}`), and this file expands nested sets as written. An export
// (16.7, phase 6) that writes `expandPattern`'s list as `paths:` agrees with
// both.

/** `dht`'s cap: past this many patterns the engine stops expanding; litter refuses the pattern instead. */
export const MAX_EXPANSION = 1000

const GLOB = /[*?[]/
const ABSOLUTE = /^(~|[A-Za-z]:|\/\/)/

/** Splits at commas outside braces, as `dht` does, trimming each part and dropping empty ones. */
function splitTop(pattern: string): string[] {
  const out: string[] = []
  let depth = 0
  let part = ''
  for (const ch of pattern) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
    if (ch === ',' && depth === 0) {
      out.push(part)
      part = ''
    } else part += ch
  }
  out.push(part)
  return out.map(s => s.trim()).filter(s => s !== '')
}

/** One part's brace sets, nested ones included, each alternative trimmed as `dht` trims them. Throws past MAX_EXPANSION. */
function expandBraces(part: string, out: string[]): void {
  const open = part.indexOf('{')
  if (open < 0) {
    if (out.length >= MAX_EXPANSION) throw new RangeError(`expands to more than ${MAX_EXPANSION} patterns`)
    out.push(part)
    return
  }
  let depth = 0
  let close = -1
  const cuts: number[] = []
  for (let i = open; i < part.length; i++) {
    const ch = part[i]
    if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) {
      close = i
      break
    } else if (ch === ',' && depth === 1) cuts.push(i)
  }
  if (close < 0) {
    out.push(part) // unbalanced: validPattern refuses it before anything matches with it
    return
  }
  const pre = part.slice(0, open)
  const post = part.slice(close + 1)
  let from = open + 1
  for (const cut of [...cuts, close]) {
    expandBraces(pre + part.slice(from, cut).trim() + post, out)
    from = cut + 1
  }
}

/**
 * The plain patterns one entry stands for, as the engine reads them: split
 * at top-level commas, brace sets expanded, a trailing `/**` dropped as `y0n`
 * drops it (so `src/**` reads as `src`, which, with no other slash, is a
 * name at any depth), empty ones gone. NFC-normalised. Throws on a pattern
 * that expands past MAX_EXPANSION.
 */
export function expandPattern(pattern: string): string[] {
  return expandBraceSets(pattern).map(stripAll).filter(g => g !== '')
}

/** `text` split at top-level commas and its brace sets expanded, NFC-normalised, nothing else changed. Throws past MAX_EXPANSION. */
export function expandBraceSets(text: string): string[] {
  const out: string[] = []
  for (const part of splitTop(text.normalize('NFC'))) expandBraces(part, out)
  return out
}

const stripAll = (g: string): string => (g.endsWith('/**') ? g.slice(0, -3) : g)

/** A rule's paths as the engine reads them: none, or only `**`, is everywhere (`y0n`), so the rule has no paths. */
export function isPathless(paths: readonly string[]): boolean {
  try {
    return paths.flatMap(expandPattern).every(g => g === '**')
  } catch {
    return false
  }
}

/** Why one plain pattern (after expansion) can't be used, or null. */
function plainError(g: string): string | null {
  if (g.startsWith('!')) return "'!' negation isn't supported: a rule's paths say where it applies, not where it doesn't"
  if (g.startsWith('#')) return "a leading '#' makes it a comment to Claude Code's matcher, so it matches nothing"
  if (ABSOLUTE.test(g)) return 'it is an absolute path; write it relative to the repository root (a leading / anchors it there)'
  const segs = g.replace(/^\//, '').replace(/\/$/, '').split('/')
  if (segs.some(s => s === '..')) return "a '..' segment points outside the repository"
  if (segs.some(s => s === '.')) return "a '.' segment matches nothing; drop it"
  if (segs.some(s => s === '')) return "an empty segment ('//') matches nothing"
  for (let i = 0; i < g.length; i++) {
    if (g[i] === ']') return "a ']' without its '[' is an unbalanced class"
    if (g[i] !== '[') continue
    const close = g.indexOf(']', i + 1)
    const body = close < 0 ? null : g.slice(i + 1, close)
    if (body === null || body.includes('/')) return "a '[' class isn't closed within its segment"
    if (body === '') return "an empty class '[]' matches nothing"
    if (body.startsWith('!') || body.startsWith('^')) return "class negation ('[!…]', '[^…]') isn't supported by Claude Code's matcher"
    for (const m of body.matchAll(/(.)-(.)/g)) {
      if (m[1]!.charCodeAt(0) > m[2]!.charCodeAt(0)) return `the class range '${m[0]}' is out of order`
    }
    i = close
  }
  return null
}

/**
 * Null when `pattern` is one litter takes; else why not (`!` negation, an
 * absolute path, a `..` segment, a backslash, an empty pattern, an
 * unbalanced brace or class).
 */
export function validPattern(pattern: string): string | null {
  const why = patternError(pattern)
  return why === null ? null : `the path pattern ${JSON.stringify(pattern)} can't be used: ${why}`
}

function patternError(pattern: unknown): string | null {
  if (typeof pattern !== 'string') return 'a pattern is text, like src/auth/** or *.sh'
  if (pattern.trim() === '') return 'it is empty; leave paths out for a rule that applies everywhere'
  if (pattern.includes('\\')) return "a backslash isn't taken: paths use '/', and litter takes no escapes"
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(pattern)) return 'it holds a control character'
  let depth = 0
  for (const ch of pattern) {
    if (ch === '{') depth++
    else if (ch === '}' && --depth < 0) return "a '}' without its '{' is an unbalanced brace"
  }
  if (depth !== 0) return "a '{' isn't closed: an unbalanced brace"
  if (pattern.includes('{}')) return "an empty brace set '{}' matches nothing"
  let raw: string[]
  try {
    raw = expandBraceSets(pattern)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  // `y0n` drops what's left of `/**` once its `/**` goes: alone that's every path, beside others it's nothing.
  if (raw.some(g => stripAll(g) === '')) return "'/**' reads as no pattern to Claude Code's matcher; write ** for every path, or leave paths out"
  const plain = raw.map(stripAll)
  if (plain.length === 0) return 'it stands for no pattern at all'
  for (const g of plain) {
    const why = plainError(g)
    if (why) return plain.length > 1 ? `${why} (in ${JSON.stringify(g)})` : why
  }
  return null
}

// ---------------------------------------------------------------------------
// node-ignore 7's pattern-to-regex steps (cli 2.1.287 :199234-199284), less
// those for escapes and surrounding whitespace, which validPattern and the
// expansion rule out. `this` in the anchor step is the pattern itself.

type Step = [RegExp, (this: string, match: string, ...rest: unknown[]) => string]

const STEPS: Step[] = [
  // Regex metacharacters, except the glob's own `*`, `?` and `[...]`.
  [/[\\$.|*+(){^]/g, m => `\\${m}`],
  [/\?/g, () => '[^/]'],
  // A leading slash anchors at the root.
  [/^\//, () => '^'],
  [/\//g, () => '\\/'],
  // A leading `**/` matches at any depth, the root included.
  [/^\^*\\\*\\\*\\\//, () => '^(?:.*\\/)?'],
  // No slash but a trailing one: a name at any depth. Else anchored at the root.
  [
    /^(?=[^^])/,
    function () {
      return !/\/(?!$)/.test(this) ? '(?:^|\\/)' : '^'
    },
  ],
  // An inner `/**/` is zero or more folders; a trailing `/**` everything under.
  [/\\\/\\\*\\\*(?=\\\/|$)/g, (_m, index, whole) => ((index as number) + 6 < (whole as string).length ? '(?:\\/[^\\/]+)*' : '\\/.+')],
  // A `*` with something after it stays within its segment.
  [/(^|[^\\]+)(\\\*)+(?=.+)/g, (_m, before, star) => (before as string) + (star as string).replace(/\\\*/g, '[^\\/]*')],
  // A class `[...]`; a range out of order drops out, as node-ignore's does.
  [
    /(\\)?\[([^\]/]*?)(\\*)($|\])/g,
    (_m, lead, range, slashes, close) =>
      lead === '\\'
        ? `\\[${range}${(slashes as string).slice(0, (slashes as string).length - ((slashes as string).length % 2))}${close}`
        : close === ']'
          ? (slashes as string).length % 2 === 0
            ? `[${(range as string).replace(/([0-z])-([0-z])/g, (r, a: string, b: string) => (a.charCodeAt(0) <= b.charCodeAt(0) ? r : ''))}${slashes}]`
            : '[]'
          : '[]',
  ],
  // The end: a trailing slash matches a folder only; else the name, or the name as a folder.
  [/(?:[^*])$/, m => (/\/$/.test(m) ? `${m}$` : `${m}(?=$|\\/$)`)],
]

const compiled = new Map<string, RegExp>()

function regexOf(g: string): RegExp {
  let re = compiled.get(g)
  if (re) return re
  const source = STEPS.reduce((s, [find, replace]) => s.replace(find, replace.bind(g) as (substring: string, ...args: unknown[]) => string), g)
    // A trailing `*`: within its segment, and at least one character after a `/` (node-ignore's `regex`).
    .replace(/(^|\\\/)?\\\*$/, (_m, slash: string | undefined) => `${slash ? `${slash}[^/]+` : '[^/]*'}(?=$|\\/$)`)
  re = new RegExp(source, 'i')
  if (compiled.size > 5000) compiled.clear()
  compiled.set(g, re)
  return re
}

/** A path node-ignore takes: relative, not `.` or `..`, not starting `./` or `../`. */
const RELATIVE = (path: string): boolean => path !== '' && !/^\.{0,2}\/|^\.{1,2}$/.test(path)

/** One plain pattern against `path`, or any folder above it (`a/`, `a/b/`), as node-ignore's `ignores` reads it. */
function matchesPlain(g: string, path: string): boolean {
  if (g === '**') return true
  const re = regexOf(g)
  const segs = path.split('/').filter(s => s !== '')
  for (let i = 1; i < segs.length; i++) if (re.test(`${segs.slice(0, i).join('/')}/`)) return true
  return re.test(path)
}

/**
 * Whether `pattern` matches the repository-relative `path` (both
 * NFC-normalised): the path itself, or a folder it's under. A path ending
 * in `/` is a folder. A pattern validPattern refuses matches nothing.
 */
export function matches(pattern: string, path: string): boolean {
  if (patternError(pattern) !== null) return false
  const rel = path.normalize('NFC')
  if (!RELATIVE(rel)) return false
  return expandPattern(pattern).some(g => matchesPlain(g, rel))
}

/** A plain pattern that matches at any depth: no slash but a trailing one, or a leading `**` segment. */
const unanchored = (g: string): boolean => !/\/(?!$)/.test(g) || g.startsWith('**/')

/** The literal segments before the first with a glob character, lower-cased (the engine's matching is case-insensitive). */
const literalPrefix = (g: string): string[] => {
  const out: string[] = []
  for (const s of g.replace(/^\//, '').split('/')) {
    if (s === '' || GLOB.test(s)) break
    out.push(s.toLowerCase())
  }
  return out
}

/** The literal segments before the first with a glob character; an unanchored pattern counts as 1. Fills the 8 KiB cap in this order (16.5). */
export function specificity(pattern: string): number {
  if (patternError(pattern) !== null) return 0
  let best = 0
  for (const g of expandPattern(pattern)) {
    if (g === '**') continue
    best = Math.max(best, unanchored(g) ? 1 : literalPrefix(g).length)
  }
  return best
}

/**
 * Whether `pattern` could match something under `entry`, a folder or a glob
 * (COMMON decision 25: a Files entry or a node's directory that isn't one
 * file gets every rule that could apply under it). True when the pattern is
 * unanchored, or its literal prefix and the entry's overlap by segments.
 */
export function couldMatchUnder(pattern: string, entry: string): boolean {
  if (patternError(pattern) !== null) return false
  const e = literalPrefix(entry.normalize('NFC').replace(/^(\.\/)+/, ''))
  return expandPattern(pattern).some(g => {
    if (g === '**' || unanchored(g)) return true
    const q = literalPrefix(g)
    const n = Math.min(q.length, e.length)
    for (let i = 0; i < n; i++) if (q[i] !== e[i]) return false
    return true
  })
}
