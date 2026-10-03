// Tier 2: a rule file, 16.2's format, read and written (WP-AD): parse and
// render round trips, 16.2's example included; unknown keys through a parse,
// an edit and a render (12:1572); and each refusal, naming its line. AE's
// validPattern is a stub before the merge, so a fake stands in for it.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { RuleDoc } from '../../hooks/records/rules'
import { foldText, parseRule, renderRule, RULE_ID } from '../../hooks/rules/format'
import { EXAMPLE, fakePatterns } from './rules-harness'

let restore: () => void
beforeEach(() => {
  restore = fakePatterns()
})
afterEach(() => restore())

const parsed = (text: string): RuleDoc => {
  const r = parseRule(text)
  if (!r.ok) throw new Error(r.error)
  return r.doc
}
const refusal = (text: string): string => {
  const r = parseRule(text)
  if (r.ok) throw new Error('parsed, and should have been refused')
  return r.error
}

/** A small valid file with `lines` in its frontmatter after type. */
const withFrontmatter = (...lines: string[]) => ['---', 'id: L-small', 'version: 1', 'status: accepted', 'type: ban', ...lines, '---', '', '## Rule', 'Never.', ''].join('\n')

describe('parseRule and renderRule', () => {
  test("16.2's example parses to its fields and renders back to the same bytes", () => {
    const doc = parsed(EXAMPLE)
    expect(doc).toEqual({
      id: 'P-worktree-cleanup',
      version: 2,
      status: 'accepted',
      type: 'rule',
      applies: {
        paths: ['plugins/litter/hooks/worktrees.ts', 'plugins/litter/hooks/swarm/end.ts'],
        workflows: ['execute', 'fanout', 'swarm'],
        when: 'removing a worktree or deleting a branch',
      },
      accepted: { at: '2026-10-01', commit: '3f2c1a9', via: 'ui' },
      export: true,
      extra: [],
      body: {
        rule: expect.stringMatching(/^Remove a worktree only if .*never force it\.$/),
        why: expect.stringContaining('`git worktree remove`'),
        exceptions: ["A prober's disposable worktree is force-removed after its branch is checked for commits (section 9)."],
        howToCheck: [
          'A swarm node on an `existing` worktree ends: the worktree is still there, and listed.',
          'A recorded worktree holding a new ignored `.env` is kept, and the listing names the file.',
        ],
      },
    })
    expect(renderRule(doc)).toBe(EXAMPLE)
  })

  test('a rendered file parses back to the same doc, whatever its values need quoting', () => {
    const doc: RuleDoc = {
      id: 'U-quote-everything',
      version: 7,
      status: 'accepted',
      type: 'ban',
      applies: { paths: ['**/*.ts', 'src/{a,b}/x.js', 'docs/[ab].md', 'plain/path.md'], roles: ['gate-critic'], when: 'when: it says so # not a comment' },
      overrides: 'U-other',
      accepted: { at: '2026-10-03', via: 'ui' },
      export: false,
      extra: [],
      body: { rule: 'Line one.\n\nLine two, with `code`.', why: '', exceptions: ['multi\nline item', 'one'], howToCheck: [] },
    }
    const text = renderRule(doc)
    expect(text).toContain("  paths: [\"**/*.ts\", \"src/{a,b}/x.js\", \"docs/[ab].md\", plain/path.md]")
    expect(text).toContain('  when: "when: it says so # not a comment"')
    expect(text).not.toContain('## Why')
    expect(parsed(text)).toEqual(doc)
    expect(renderRule(parsed(text))).toBe(text)
    // Values YAML would read as something else are quoted, and read back as text.
    for (const when of ['true', 'null', '12', '0x1f', '', ' padded ', 'yes']) {
      const d = { ...doc, applies: { ...doc.applies, when } }
      expect(parsed(renderRule(d)).applies.when).toBe(when)
    }
  })

  test('block lists, quoted scalars and an empty map read the same as their inline spelling', () => {
    const text = [
      '---',
      "id: 'P-block'",
      'version: 3',
      'status: "accepted"',
      'type: rule',
      'applies:',
      '    paths:',
      '    - src/a.ts',
      "    - 'src/b c.ts'",
      '    workflows:',
      '      - execute',
      '    when: "a \\"quoted\\" situation"',
      'accepted: {}',
      'export: true',
      '---',
      '## Rule',
      'Keep it.',
      '## Exceptions',
      '* starred item',
      '  continued',
    ].join('\n')
    const doc = parsed(text)
    expect(doc.id).toBe('P-block')
    expect(doc.status).toBe('accepted')
    expect(doc.applies).toEqual({ paths: ['src/a.ts', 'src/b c.ts'], workflows: ['execute'], when: 'a "quoted" situation' })
    expect(doc.accepted).toEqual({})
    expect(doc.body.exceptions).toEqual(['starred item\ncontinued'])
    // The canonical form renders, and is stable from there.
    const once = renderRule(doc)
    expect(once).toContain('  paths: [src/a.ts, src/b c.ts]')
    expect(once).toContain('accepted: {}')
    expect(renderRule(parsed(once))).toBe(once)
  })

  test("a draft without id, version or status reads as the proposal it is, and renders without them", () => {
    const draft = ['---', 'type: ban', 'applies:', '  paths: []', '  when: editing migrations', '---', '', '## Rule', 'Never edit a migration that has shipped.', ''].join('\n')
    const doc = parsed(draft)
    expect({ id: doc.id, version: doc.version, status: doc.status, type: doc.type, export: doc.export }).toEqual({ id: '', version: 0, status: 'proposed', type: 'ban', export: true })
    const text = renderRule(doc)
    expect(text.startsWith('---\nstatus: proposed\ntype: ban\n')).toBe(true)
    expect(parsed(text)).toEqual(doc)
  })

  test('CRLF line ends read as LF', () => {
    expect(parsed(EXAMPLE.replace(/\n/g, '\r\n'))).toEqual(parsed(EXAMPLE))
  })
})

describe('unknown keys (12:1572)', () => {
  const OWNED = EXAMPLE.replace(
    'export: true\n',
    'export: true\nowner: jane   # the reviewer\nticket:\n  - ABC-1\n  - ABC-2\nnotes: |\n  first line\n\n  after a blank line\n',
  )

  test('are kept as their raw text, in order', () => {
    expect(parsed(OWNED).extra).toEqual([
      ['owner', ' jane   # the reviewer'],
      ['ticket', '\n  - ABC-1\n  - ABC-2'],
      ['notes', ' |\n  first line\n\n  after a blank line'],
    ])
    expect(renderRule(parsed(OWNED))).toBe(OWNED)
  })

  test('survive an edit of the known fields and the body, byte for byte', () => {
    const doc = parsed(OWNED)
    const edited: RuleDoc = { ...doc, version: 3, type: 'ban', applies: { ...doc.applies, paths: ['plugins/litter/hooks/**'] }, body: { ...doc.body, rule: 'Never force-remove a worktree.' } }
    const text = renderRule(edited)
    expect(text).toContain('owner: jane   # the reviewer\nticket:\n  - ABC-1\n  - ABC-2\nnotes: |\n  first line\n\n  after a blank line\n---\n')
    const back = parsed(text)
    expect(back.extra).toEqual(doc.extra)
    expect(back.version).toBe(3)
    expect(back.body.rule).toBe('Never force-remove a worktree.')
  })

  test('come after the known fields, wherever they were written', () => {
    const text = EXAMPLE.replace('type: rule\n', 'type: rule\nowner: jane\n')
    const out = renderRule(parsed(text))
    expect(out.indexOf('owner: jane')).toBeGreaterThan(out.indexOf('export: true'))
  })
})

describe('refusals', () => {
  test('a rule over 8 KiB', () => {
    expect(refusal(EXAMPLE.replace('Keep and list anything else', 'x'.repeat(8 * 1024)))).toMatch(/over the 8192-byte limit/)
  })

  test('a type other than rule or ban', () => {
    expect(refusal(EXAMPLE.replace('type: rule', 'type: guideline'))).toBe('line 5: type is rule or ban, not "guideline"')
  })

  test('an applies.paths pattern validPattern rejects, on its own line', () => {
    expect(refusal(EXAMPLE.replace('[plugins/litter/hooks/worktrees.ts,', '[../outside.ts,'))).toBe(
      'line 7: applies.paths has "../outside.ts", which isn\'t a path pattern litter takes: a .. segment',
    )
    const block = withFrontmatter('applies:', '  paths:', '    - ok.ts', "    - '!negated'", '  when: x')
    expect(refusal(block)).toBe('line 9: applies.paths has "!negated", which isn\'t a path pattern litter takes: a negation')
  })

  test('a missing or empty ## Rule', () => {
    const noRule = ['---', 'type: rule', '---', '', '## Why', 'Because.', ''].join('\n')
    expect(refusal(noRule)).toBe('line 4: a rule file needs a ## Rule section that says the rule')
    expect(refusal(['---', 'type: rule', '---', '## Rule', '', '## Why', 'x'].join('\n'))).toBe('line 4: a rule file needs a ## Rule section that says the rule')
  })

  test('YAML outside the subset, naming the line', () => {
    const cases: [string, string][] = [
      [withFrontmatter('# a comment'), 'line 6: a comment'],
      [withFrontmatter('accepted:', '  at: 2026-10-01'), 'line 6: accepted is an inline map'],
      [withFrontmatter('accepted: { at: 2026-10-01, by: me }'), 'line 6: accepted takes at, commit and via, not by'],
      [withFrontmatter('applies: { paths: [] }'), 'line 6: applies holds its keys on the lines below it'],
      [withFrontmatter('applies:', '  paths: []', '  owner: jane'), 'line 8: applies takes paths, workflows, roles and when, not owner'],
      [withFrontmatter('applies:', '  paths: []', '    when: x'), "line 8: applies' keys are indented 2 spaces, and this line 4"],
      [withFrontmatter('applies:', '  paths: [*.ts]'), 'line 7: "*.ts" must be quoted'],
      [withFrontmatter('applies:', '  paths: [src/{a,b}.ts]'), 'line 7: "src/{a" must be quoted inside [ ] or { }'],
      [withFrontmatter('applies:', '  when: &anchor x'), 'line 7: "&anchor x" must be quoted'],
      [withFrontmatter('applies:', '  when: a: b'), 'line 7: "a: b" must be quoted'],
      [withFrontmatter('applies:', '  when: "open'), 'line 7: a double-quoted value with no closing quote'],
      [withFrontmatter('applies:', "  when: 'it's'"), "line 7: a single-quoted value must end with ' and write a quote inside it as ''"],
      [withFrontmatter('version: 2'), 'line 6: version is given twice'],
      [withFrontmatter('export: yes'), 'line 6: export is true or false'],
      [withFrontmatter('overrides: someone'), 'line 6: overrides names a rule id'],
      [withFrontmatter('  stray: indented'), 'line 6: an indented line outside applies'],
      [withFrontmatter('not a key'), 'line 6: expected a key'],
      [withFrontmatter('status: approved'), 'line 6: status is given twice'],
      [EXAMPLE.replace('status: accepted', 'status: approved'), 'line 4: status is one of proposed, accepted, dismissed, retired, not "approved"'],
      [EXAMPLE.replace('version: 2', 'version: two'), 'line 3: version is a whole number from 1'],
      [EXAMPLE.replace('id: P-worktree-cleanup', 'id: worktree cleanup'), 'line 2: id "worktree cleanup" isn\'t a rule id'],
      [EXAMPLE.replace('---\n\n## Rule', '---\n\nPreamble.\n\n## Rule'), 'line 14: text before ## Rule'],
      [EXAMPLE.replace('## How to check', '## Notes'), "line 23: ## Notes isn't one of a rule's sections"],
      [EXAMPLE.replace('## How to check', '## Why'), 'line 23: ## Why is given twice'],
      [EXAMPLE.replace(/\n---\n\n## Rule/, '\n\n## Rule'), 'line 1: the frontmatter has no closing --- line'],
      ['## Rule\nNo frontmatter.\n', 'line 1: a rule file starts with a --- line'],
    ]
    for (const [text, error] of cases) expect({ text, error: refusal(text).slice(0, error.length) }).toEqual({ text, error })
  })
})

describe('helpers', () => {
  test('foldText folds whitespace and case', () => {
    expect(foldText('  Never   edit\n a MIGRATION.\t')).toBe('never edit a migration.')
  })

  test('RULE_ID takes a scope letter and a slug', () => {
    for (const id of ['P-x', 'U-keep-tests-near', 'L-a1-2', `P-${'a'.repeat(40)}-12`]) expect(RULE_ID.test(id)).toBe(true)
    for (const id of ['X-a', 'P-', 'P-A', 'P--a', 'P-a-', 'P-a/b', 'p-a', `P-${'a'.repeat(51)}`]) expect(RULE_ID.test(id)).toBe(false)
  })
})
