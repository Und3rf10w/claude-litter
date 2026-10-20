// Tier 2: a rule's path patterns (hooks/rules/match.ts; plan 16.2, 16.7;
// WP-AE). Every match case below was run through the engine's own matcher
// (cli 2.1.287: dht's expansion, y0n's trailing-`/**` rule, and the bundled
// node-ignore that vJ calls) and agrees with it, so selection and an
// exported rule file deliver alike. Nested brace sets are where litter
// differs on purpose: the engine's expander doesn't nest.

import { describe, expect, test } from 'bun:test'
import { couldMatchUnder, expandBraceSets, expandPattern, isPathless, matches, MAX_EXPANSION, specificity, validPattern } from '../../hooks/rules/match'

/** [pattern, repository-relative path, whether the engine loads a rule with that `paths:` for a Read of the path]. */
const ENGINE_CASES: [string, string, boolean][] = [
  // No slash, or only a trailing one: a name at any depth.
  ['*.ts', 'a.ts', true],
  ['*.ts', 'src/deep/a.ts', true],
  ['*.ts', 'src/a.tsx', false],
  ['worktrees.ts', 'plugins/litter/hooks/worktrees.ts', true],
  ['hooks', 'plugins/litter/hooks/land.ts', true],
  ['build/', 'build/out.js', true],
  ['build/', 'pkg/build/out.js', true],
  ['build/', 'build', false],
  ['build/', 'build/', true],
  // A leading or inner slash anchors it at the root.
  ['/*.ts', 'a.ts', true],
  ['/*.ts', 'src/a.ts', false],
  ['/hooks', 'hooks/land.ts', true],
  ['/hooks', 'plugins/hooks/land.ts', false],
  ['hooks/land.ts', 'hooks/land.ts', true],
  ['hooks/land.ts', 'plugins/hooks/land.ts', false],
  ['plugins/litter', 'plugins/litter/hooks/land.ts', true],
  // A pattern that matches a folder matches everything under it.
  ['plugins/litter/hooks', 'plugins/litter/hooks/swarm/end.ts', true],
  ['src/*', 'src/a/b/c.ts', true],
  ['src/*', 'src', false],
  // `*` and `?` stay within a segment.
  ['src/*.ts', 'src/a.ts', true],
  ['src/*.ts', 'src/x/a.ts', false],
  ['a/*/c', 'a/b/c', true],
  ['a/*/c', 'a/c', false],
  ['a?c', 'abc', true],
  ['a?c', 'a/c', false],
  ['a?c', 'ac', false],
  // `**` spans segments.
  ['a/**/b', 'a/b', true],
  ['a/**/b', 'a/x/y/b', true],
  ['a/**/b', 'a/x/y/b/c.ts', true],
  ['a/**/b', 'x/a/b', false],
  ['**/b.ts', 'b.ts', true],
  ['**/b.ts', 'x/y/b.ts', true],
  ['src/**/*.test.ts', 'src/a/b/c.test.ts', true],
  ['src/**/*.test.ts', 'lib/c.test.ts', false],
  // `[...]` is a class.
  ['[a-c]x', 'bx', true],
  ['[a-c]x', 'dx', false],
  ['G[0-9].md', 'docs/G7.md', true],
  // A trailing `/**` goes, as y0n drops it: the folder, everything under it, and, with no other slash, at any depth.
  ['src/**', 'src', true],
  ['src/**', 'src/a.ts', true],
  ['src/**', 'lib/src/a.ts', true],
  ['a/b/**', 'a/b', true],
  ['/src/**', 'lib/src/a.ts', false],
  ['**', 'any/path/at/all', true],
  // Case-insensitive, as the engine's ignore() is by default.
  ['Src/A.ts', 'src/a.TS', true],
  // Brace sets, and top-level commas, as dht reads an entry.
  ['src/{a,b}.ts', 'src/b.ts', true],
  ['src/{a,b}.ts', 'src/c.ts', false],
  ['{a, b}/x', 'b/x', true],
  ['*.{ts,sh}', 'bin/run.sh', true],
  ['a,b', 'b/x', true],
  // A path that isn't repository-relative matches nothing.
  ['*', './a', false],
  ['*', '/a', false],
  ['*', '../a', false],
  ['*', '', false],
]

describe('matches, as the engine matches a rule file\'s paths:', () => {
  for (const [pattern, path, want] of ENGINE_CASES) {
    test(`${JSON.stringify(pattern)} ${want ? 'matches' : "doesn't match"} ${JSON.stringify(path)}`, () => {
      expect(matches(pattern, path)).toBe(want)
    })
  }

  test('paths and patterns are compared NFC-normalised', () => {
    const nfc = 'caf\u00e9'
    const nfd = 'cafe\u0301'
    expect(matches(`docs/${nfc}.md`, `docs/${nfd}.md`)).toBe(true)
    expect(matches(`docs/${nfd}.md`, `docs/${nfc}.md`)).toBe(true)
    expect(matches('docs/caf?.md', `docs/${nfd}.md`)).toBe(true)
  })

  test('a pattern validPattern refuses matches nothing', () => {
    expect(matches('!src', 'lib/a.ts')).toBe(false)
    expect(matches('a/../b', 'b')).toBe(false)
    expect(matches('{a,b', 'a')).toBe(false)
  })
})

describe('brace sets', () => {
  test('expand in order, each alternative trimmed, top-level commas splitting the entry', () => {
    expect(expandPattern('src/{a,b}/{c,d}.ts')).toEqual(['src/a/c.ts', 'src/a/d.ts', 'src/b/c.ts', 'src/b/d.ts'])
    expect(expandPattern('{x, y}z')).toEqual(['xz', 'yz'])
    expect(expandPattern('a, b')).toEqual(['a', 'b'])
    expect(expandPattern('{a,}b')).toEqual(['ab', 'b'])
    expect(expandPattern('{a}')).toEqual(['a'])
  })

  test('nest, unlike the engine\'s dht (which gives a}, b, c} for {a,{b,c}})', () => {
    expect(expandPattern('{a,{b,c}}')).toEqual(['a', 'b', 'c'])
    expect(expandPattern('src/{a,b{c,d}}/x')).toEqual(['src/a/x', 'src/bc/x', 'src/bd/x'])
    expect(matches('{lib,src/{auth,api}}/**', 'src/api/x.ts')).toBe(true)
    expect(matches('{lib,src/{auth,api}}/**', 'src/db/x.ts')).toBe(false)
  })

  test('a trailing /** is dropped after expansion, and the raw expansion keeps it', () => {
    expect(expandPattern('{src,lib}/**')).toEqual(['src', 'lib'])
    expect(expandBraceSets('{src,lib}/**')).toEqual(['src/**', 'lib/**'])
  })

  test('a rule with no paths, or only **, has no paths, as the engine reads it', () => {
    expect(isPathless([])).toBe(true)
    expect(isPathless(['**'])).toBe(true)
    expect(isPathless(['**', '{**}'])).toBe(true)
    expect(isPathless(['**', 'src/'])).toBe(false)
    expect(isPathless(['src/**'])).toBe(false)
  })
})

describe('validPattern', () => {
  test('takes the patterns the matcher reads', () => {
    for (const ok of ['src/**', '/hooks/*.ts', '*.sh', 'build/', '{a,{b,c}}/x', '[a-c]?.md', 'my dir/*.txt', '**', 'a,b']) {
      expect({ ok, why: validPattern(ok) }).toEqual({ ok, why: null })
    }
  })

  const REFUSED: [string, string][] = [
    ['!src/**', "'!' negation isn't supported"],
    ['{!a,b}', "'!' negation isn't supported"],
    ['~/notes', 'it is an absolute path'],
    ['C:/repo/x', 'it is an absolute path'],
    ['//server/share', 'it is an absolute path'],
    ['a/../b', "a '..' segment points outside the repository"],
    ['../x', "a '..' segment points outside the repository"],
    ['./a', "a '.' segment matches nothing"],
    ['a//b', "an empty segment ('//') matches nothing"],
    ['src\\a.ts', "a backslash isn't taken"],
    ['', 'it is empty'],
    ['   ', 'it is empty'],
    ['{a,b', "a '{' isn't closed: an unbalanced brace"],
    ['a}', "a '}' without its '{' is an unbalanced brace"],
    ['{}', "an empty brace set '{}' matches nothing"],
    ['[ab', "a '[' class isn't closed within its segment"],
    ['[a/b]', "a '[' class isn't closed within its segment"],
    ['a]', "a ']' without its '[' is an unbalanced class"],
    ['[]x', "an empty class '[]' matches nothing"],
    ['[!a]', "class negation ('[!…]', '[^…]') isn't supported"],
    ['[^a]', "class negation ('[!…]', '[^…]') isn't supported"],
    ['[z-a]', "the class range 'z-a' is out of order"],
    ['#notes', "a leading '#' makes it a comment"],
    ['/**', "'/**' reads as no pattern"],
    ['a\nb', 'it holds a control character'],
  ]
  for (const [pattern, why] of REFUSED) {
    test(`refuses ${JSON.stringify(pattern)}: ${why}`, () => {
      const r = validPattern(pattern)
      expect(r).toStartWith(`the path pattern ${JSON.stringify(pattern)} can't be used: `)
      expect(r).toContain(why)
    })
  }

  test(`refuses a pattern that expands past ${MAX_EXPANSION}`, () => {
    const big = '{a,b}'.repeat(11)
    expect(validPattern(big)).toContain(`expands to more than ${MAX_EXPANSION} patterns`)
    expect(matches(big, 'a'.repeat(11))).toBe(false)
  })

  test('names the expanded pattern a refusal comes from', () => {
    expect(validPattern('{src,../x}')).toContain('(in "../x")')
  })
})

describe('specificity', () => {
  test('is the literal segments before the first with a glob; an unanchored pattern counts as 1', () => {
    const cases: [string, number][] = [
      ['src/auth/refresh.py', 3],
      ['src/auth/*.py', 2],
      ['src/*.ts', 1],
      ['/src', 1],
      ['/src/lib/', 2],
      ['*.ts', 1],
      ['build/', 1],
      ['**/x.ts', 1],
      ['src/**', 1],
      ['*/x', 0],
      ['**', 0],
      // The most specific of the alternatives.
      ['a/b/{c,d/e}/f', 5],
      ['!x', 0],
    ]
    expect(cases.map(([p]) => [p, specificity(p)])).toEqual(cases)
  })
})

describe('couldMatchUnder (decision 25)', () => {
  test('a folder or glob entry gets a pattern whose literal prefix overlaps it by segments, or any unanchored one', () => {
    const cases: [string, string, boolean][] = [
      ['src/auth/*.py', 'src/', true],
      ['src/*.py', 'src/auth/**', true],
      ['src', 'src/auth/', true],
      ['lib/x', 'src/', false],
      ['src/authz/x', 'src/auth/', false],
      ['*.py', 'src/', true],
      ['build/', 'src/', true],
      ['**/x.ts', 'deep/dir/', true],
      ['SRC/x', 'src/', true],
      ['{lib,src}/x', 'src/', true],
      ['/docs/*.md', 'src/**/*.ts', false],
      ['src/a.ts', '*.py', true],
    ]
    expect(cases.map(([p, e]) => [p, e, couldMatchUnder(p, e)])).toEqual(cases)
  })
})
