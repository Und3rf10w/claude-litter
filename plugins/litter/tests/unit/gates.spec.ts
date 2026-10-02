// Tier 2: the gate sections of plan.md (plan section 10, "Gate sections in
// plan.md are a contract"). Pure: no files.

import { describe, expect, test } from 'bun:test'
import { parseGates } from '../../hooks/gates'

const PLAN = `# Retry the refresh

Some prose first.

## Gates

### G1: Add the retry
Files: src/auth/refresh.py, tests/test_refresh.py
Checks: uv run pytest tests/test_refresh.py -q
Done when: test_refresh_retries_once passes inside the verify suite
Adversary: yes
Rollback: revert the commit; no data migration

Change refresh() to retry once.

\`\`\`md
### G9: not a gate, inside a fence
\`\`\`

#### Notes under G1
Still G1.

### G2: Document it
Files:
- docs/auth.md
- \`README.md\`
Checks:
- grep -q retry docs/auth.md
- grep -q retry README.md
done when: both mention the retry

Prose.

## Afterwards
Not a gate.
`

describe('parseGates', () => {
  test('reads each gate, its fields, its lines and its excerpt', () => {
    const r = parseGates(PLAN)
    if (!r.ok) throw new Error(r.error)
    expect(r.gates.map(g => g.id)).toEqual(['G1', 'G2'])
    const [g1, g2] = r.gates
    expect(g1).toEqual(
      expect.objectContaining({
        title: 'Add the retry',
        files: ['src/auth/refresh.py', 'tests/test_refresh.py'],
        checks: 'uv run pytest tests/test_refresh.py -q',
        doneWhen: 'test_refresh_retries_once passes inside the verify suite',
        adversary: true,
        rollback: 'revert the commit; no data migration',
      }),
    )
    const lines = PLAN.split('\n')
    expect(lines[g1!.lines.start - 1]).toBe('### G1: Add the retry')
    // Through the line before the next heading at its level or higher.
    expect(lines[g1!.lines.end - 2]).toBe('Still G1.')
    expect(lines[g1!.lines.end]).toBe('### G2: Document it')
    expect(g1!.excerpt).toContain('### G9: not a gate, inside a fence')
    expect(g1!.excerpt).toContain('#### Notes under G1')
    expect(g1!.excerpt.startsWith('### G1: Add the retry\n')).toBe(true)

    expect(g2).toEqual(
      expect.objectContaining({
        title: 'Document it',
        files: ['docs/auth.md', 'README.md'],
        checks: 'grep -q retry docs/auth.md\ngrep -q retry README.md',
        doneWhen: 'both mention the retry',
        adversary: false,
        rollback: null,
      }),
    )
    expect(lines[g2!.lines.end - 1]).toBe('')
    expect(g2!.excerpt).not.toContain('## Afterwards')
  })

  test('a plan with no gate headings has no gates', () => {
    expect(parseGates('# Plan\n\nJust prose.\n')).toEqual({ ok: true, gates: [] })
  })

  test('CRLF line ends parse the same', () => {
    const r = parseGates(PLAN.replaceAll('\n', '\r\n'))
    expect(r.ok && r.gates.map(g => [g.id, g.files.length, g.doneWhen])).toEqual([
      ['G1', 2, 'test_refresh_retries_once passes inside the verify suite'],
      ['G2', 2, 'both mention the retry'],
    ])
  })

  const gate = (fields: string) => `### G1: Title\n${fields}\n\nProse.\n`

  test.each([
    ['Files', 'Checks: make test\nDone when: green'],
    ['Files', 'Files:\nChecks: make test\nDone when: green'],
    ['Checks', 'Files: a.txt\nDone when: green'],
    ['Checks', 'Files: a.txt\nChecks:\nDone when: green'],
    ['Done when', 'Files: a.txt\nChecks: make test'],
    ['Done when', 'Files: a.txt\nChecks: make test\nDone when:'],
  ])('a gate without %s is refused, naming the field', (field, fields) => {
    const r = parseGates(gate(fields))
    expect(r).toEqual(expect.objectContaining({ ok: false, gate: 'G1', field }))
    expect(!r.ok && r.error).toContain(`'${field}'`)
  })

  test('a field after a blank line is prose, so the gate lacks it', () => {
    const r = parseGates('### G1: Title\nFiles: a.txt\nChecks: make\n\nDone when: green\n')
    expect(r).toEqual(expect.objectContaining({ ok: false, field: 'Done when' }))
  })

  test('a gate with no title is refused', () => {
    expect(parseGates('### G1:\nFiles: a\nChecks: b\nDone when: c\n')).toEqual(
      expect.objectContaining({ ok: false, gate: 'G1', field: 'title' }),
    )
  })

  test('two gates with one id are refused', () => {
    const one = 'Files: a\nChecks: b\nDone when: c\n'
    expect(parseGates(`### G1: A\n${one}\n### G1: B\n${one}`)).toEqual(
      expect.objectContaining({ ok: false, gate: 'G1', field: 'id' }),
    )
  })

  test('a field given twice is refused', () => {
    expect(parseGates('### G1: A\nFiles: a\nFiles: b\nChecks: c\nDone when: d\n')).toEqual(
      expect.objectContaining({ ok: false, field: 'Files' }),
    )
  })

  test('field names are matched in any case; a heading at another level is not a gate', () => {
    const r = parseGates('## G1: not a gate\n\n### G2: A\nFILES: a\nchecks: b\nDone When: c\n')
    expect(r.ok && r.gates.map(g => g.id)).toEqual(['G2'])
  })
})
