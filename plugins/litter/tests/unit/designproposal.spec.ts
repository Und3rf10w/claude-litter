// Tier 2: hooks/design/proposal.ts's renderProposal (COMMON decision 6) and
// renderGateSection's Rollback line (plan.ts): a plan's prose with the
// author's gates reads back through parseGates as exactly those gates, with
// their Rollback and Implements lines; a planner's gate renders as before;
// each refusal names its gate and field; the other deliverables refuse gates.

import { describe, expect, test } from 'bun:test'
import type { AuthorGate } from '../../hooks/records/design'
import type { PlannedGate } from '../../hooks/records/execute'
import { parseGates } from '../../hooks/gates'
import { renderGateSection } from '../../hooks/plan'
import { renderProposal, type RenderedProposal } from '../../hooks/design/proposal'

const PROSE = [
  '# Retry the token refresh',
  '',
  '## Context',
  '',
  'The refresh fails once a day; see [refresh.py](src/auth/refresh.py).',
  '',
  '## The retry',
  '',
  'Retry once on a 401.',
  '',
  '### Logging ###',
  '',
  'Log each retry.',
  '',
  '##### Deep note',
  '',
  '```md',
  '### G9: not a gate, fenced',
  '## Fenced heading',
  '```',
].join('\n')

const gate = (id: string, extra: Partial<Record<keyof AuthorGate, unknown>> = {}): AuthorGate =>
  ({
    id,
    title: `Retry ${id}`,
    plan_section: 'The retry',
    scope: `Change ${id}.\n\nKeep the old path.`,
    files: [`src/${id.toLowerCase()}.py`],
    checks: [`pytest tests/test_${id.toLowerCase()}.py`],
    done_when: `test_${id.toLowerCase()} passes`,
    rollback: 'revert the commit;\nno data migration',
    ...extra,
  }) as AuthorGate

const rendered = (r: RenderedProposal): string => {
  if (!r.ok) throw new Error(`${r.field}: ${r.error}`)
  return r.text
}

const refused = (r: RenderedProposal): { error: string; field: string } => {
  expect(r.ok).toBe(false)
  return r as { ok: false; error: string; field: string }
}

describe('a plan', () => {
  test("reads back through parseGates as the author's gates, with Rollback and Implements lines", () => {
    const gates = [gate('G1', { adversary: true }), gate('G2', { plan_section: '  logging\n', checks: ['pytest a', 'pytest b'], adversary: false })]
    const text = rendered(renderProposal(`${PROSE}\n\n  \n`, gates, 'plan'))
    expect(text).toBe(
      [
        PROSE,
        '',
        '## Gates',
        '',
        '### G1: Retry G1',
        'Files: src/g1.py',
        'Checks: pytest tests/test_g1.py',
        'Done when: test_g1 passes',
        'Adversary: yes',
        'Rollback: revert the commit; no data migration',
        '',
        'Change G1.',
        '',
        'Keep the old path.',
        '',
        'Implements: The retry',
        '',
        '### G2: Retry G2',
        'Files: src/g2.py',
        'Checks:',
        '- pytest a',
        '- pytest b',
        'Done when: test_g2 passes',
        'Rollback: revert the commit; no data migration',
        '',
        'Change G2.',
        '',
        'Keep the old path.',
        '',
        'Implements: logging',
        '',
      ].join('\n'),
    )
    const back = parseGates(text)
    if (!back.ok) throw new Error(back.error)
    expect(back.gates.map(g => ({ id: g.id, title: g.title, files: g.files, checks: g.checks, doneWhen: g.doneWhen, adversary: g.adversary, rollback: g.rollback }))).toEqual([
      { id: 'G1', title: 'Retry G1', files: ['src/g1.py'], checks: 'pytest tests/test_g1.py', doneWhen: 'test_g1 passes', adversary: true, rollback: 'revert the commit; no data migration' },
      { id: 'G2', title: 'Retry G2', files: ['src/g2.py'], checks: 'pytest a\npytest b', doneWhen: 'test_g2 passes', adversary: false, rollback: 'revert the commit; no data migration' },
    ])
    // The section the execute run gives the implementer ends with the line naming what it implements.
    expect(back.gates[1]!.excerpt.trimEnd().split('\n').at(-1)).toBe('Implements: logging')
  })

  test('plan_section matches a heading trimmed, with case and whitespace folded, levels 1 to 4', () => {
    for (const section of ['retry the token REFRESH', 'Context', ' the   retry ', 'LOGGING']) {
      expect(renderProposal(PROSE, [gate('G1', { plan_section: section })], 'plan').ok).toBe(true)
    }
  })

  // The author's template asks for the heading's text; a plan_section with the # marks is taken too.
  const implementsOf = (section: string): string | undefined => {
    const back = parseGates(rendered(renderProposal(PROSE, [gate('G1', { plan_section: section })], 'plan')))
    return back.ok ? back.gates[0]!.excerpt.trimEnd().split('\n').at(-1) : back.error
  }

  test("plan_section as the heading's text", () => {
    expect(implementsOf('The retry')).toBe('Implements: The retry')
    expect(implementsOf('Logging')).toBe('Implements: Logging')
  })

  test('plan_section as the heading with its # marks: they are dropped, and the Implements line names the text', () => {
    expect(implementsOf('## The retry')).toBe('Implements: The retry')
    expect(implementsOf('  ### Logging ')).toBe('Implements: Logging')
    expect(implementsOf('#Context')).toBe('Implements: Context')
    // A heading whose own text starts with #, named either way.
    const prose = `${PROSE}\n\n## #42 fix\n\nThe issue.\n`
    for (const section of ['#42 fix', '## #42 fix']) expect(renderProposal(prose, [gate('G1', { plan_section: section })], 'plan').ok).toBe(true)
    // Marks alone name nothing.
    expect(refused(renderProposal(PROSE, [gate('G1', { plan_section: ' ## ' })], 'plan')).field).toBe('gates[0].plan_section')
    expect(refused(renderProposal(PROSE, [gate('G1', { plan_section: '## Nowhere' })], 'plan')).error).toContain('is "Nowhere"')
  })

  test('is refused without gates', () => {
    for (const gates of [undefined, []]) {
      const e = refused(renderProposal(PROSE, gates, 'plan'))
      expect(e.field).toBe('gates')
      expect(e.error).toContain('at least one')
    }
  })
})

describe('the other deliverables', () => {
  for (const deliverable of ['research', 'audit', 'review'] as const) {
    test(`${deliverable} refuses gates, and is its text unchanged without them`, () => {
      const e = refused(renderProposal(PROSE, [gate('G1')], deliverable))
      expect(e.field).toBe('gates')
      expect(e.error).toContain(`a ${deliverable} proposal has no gates`)
      const text = `${PROSE}\n\n  \n`
      expect(renderProposal(text, undefined, deliverable)).toEqual({ ok: true, text })
      expect(renderProposal(text, [], deliverable)).toEqual({ ok: true, text })
    })
  }
})

describe('refusals, each naming the gate and the field', () => {
  const cases: [string, AuthorGate[], string, string][] = [
    ['a gate that is not an object', ['G1' as unknown as AuthorGate], 'gates[0]', "'gates[0]' must be a gate"],
    ['two gates with one id', [gate('G1'), gate('G2'), gate('G1')], 'gates[2].id', 'gate G1 appears twice'],
    ['no plan_section', [gate('G1', { plan_section: ' ' })], 'gates[0].plan_section', "'gates[0].plan_section' (gate G1) is required"],
    ['no scope', [gate('G1', { scope: undefined })], 'gates[0].scope', "'gates[0].scope' (gate G1) is required"],
    ['no rollback', [gate('G1', { rollback: undefined })], 'gates[0].rollback', "'gates[0].rollback' (gate G1) is required"],
    ['an adversary that is not a boolean', [gate('G1', { adversary: 'yes' })], 'gates[0].adversary', 'must be true or false'],
    ['a plan_section that names no heading', [gate('G1'), gate('G2', { plan_section: 'Nowhere' })], 'gates[1].plan_section', `(gate G2) is "Nowhere", which isn't a heading`],
    ['a plan_section naming a fenced heading', [gate('G1', { plan_section: 'Fenced heading' })], 'gates[0].plan_section', "isn't a heading"],
    ['a plan_section naming a level-5 heading', [gate('G1', { plan_section: 'Deep note' })], 'gates[0].plan_section', "isn't a heading"],
    ['an id that is not G<n>', [gate('gate1')], 'gates[0].id', "gate gate1: 'id' must be a gate id like G1"],
    ['no title', [gate('G1', { title: '' })], 'gates[0].title', "gate G1: 'title' is required"],
    ['no files', [gate('G1'), gate('G2', { files: [] })], 'gates[1].files', "gate G2: 'files' needs at least one path"],
    ['a file with a line break', [gate('G1', { files: ['a.py\n### G5: x'] })], 'gates[0].files[0]', 'holds a line break'],
    ['no done_when', [gate('G1', { done_when: '' })], 'gates[0].done_when', "gate G1: 'done_when' is required"],
    ['a scope heading that ends the section', [gate('G1', { scope: 'First.\n## Next part\nMore.' })], 'gates[0].scope', 'ends the section early'],
    ["a scope with another gate's heading", [gate('G1', { scope: 'First.\n### G2: smuggled\nFiles: x\nChecks: y\nDone when: z' })], 'gates[0].scope', "another gate's heading"],
  ]
  for (const [what, gates, field, error] of cases) {
    test(`refuses ${what}`, () => {
      const e = refused(renderProposal(PROSE, gates, 'plan'))
      expect(e.field).toBe(field)
      expect(e.error).toContain(error)
    })
  }

  test('refuses a prose that parseGates reads a gate from, or that leaves a fence open', () => {
    const smuggled = refused(renderProposal(`${PROSE}\n\n### G7: smuggled\nFiles: x\nChecks: y\nDone when: z\n`, [gate('G1')], 'plan'))
    expect(smuggled.field).toBe('text')
    expect(smuggled.error).toContain('gate heading (G7)')
    const untitled = refused(renderProposal(`${PROSE}\n\n### G7:\n`, [gate('G1')], 'plan'))
    expect(untitled.field).toBe('text')
    const open = refused(renderProposal(`${PROSE}\n\n~~~\nunclosed\n`, [gate('G1')], 'plan'))
    expect(open.field).toBe('text')
    expect(open.error).toContain('code fence it never closes')
  })
})

describe("renderGateSection's Rollback", () => {
  const planner = (extra: Partial<PlannedGate> = {}): PlannedGate => ({
    id: 'G1',
    title: 'Add g1.txt',
    scope: 'Create g1.txt.',
    lines: '2-3',
    files: ['g1.txt'],
    done_when: 'g1.txt exists',
    checks: ['test -f g1.txt'],
    adversary: true,
    ...extra,
  })

  test("a planner's gate without rollback renders as before", () => {
    expect(renderGateSection(planner())).toBe('### G1: Add g1.txt\nFiles: g1.txt\nChecks: test -f g1.txt\nDone when: g1.txt exists\nAdversary: yes\n\nCreate g1.txt.\n\nPlan lines: 2-3\n')
  })

  test('is written after Done when and Adversary on one line, and read back', () => {
    const text = renderGateSection(planner({ rollback: '  revert\n the commit  ' }))
    expect(text).toBe('### G1: Add g1.txt\nFiles: g1.txt\nChecks: test -f g1.txt\nDone when: g1.txt exists\nAdversary: yes\nRollback: revert the commit\n\nCreate g1.txt.\n\nPlan lines: 2-3\n')
    const back = parseGates(text)
    expect(back.ok && back.gates[0]!.rollback).toBe('revert the commit')
    expect(renderGateSection(planner({ adversary: false, rollback: 'r' })).split('\n').slice(3, 5)).toEqual(['Done when: g1.txt exists', 'Rollback: r'])
  })

  test('an empty or non-text rollback is refused, naming the gate and the field', () => {
    expect(() => renderGateSection(planner({ rollback: ' \n ' }))).toThrow("gate G1: 'rollback' is empty")
    expect(() => renderGateSection(planner({ rollback: 5 as unknown as string }))).toThrow("gate G1: 'rollback' must be text")
  })

  // design.sh basic, 2026-10-04: collapsing the blanks in a quoted literal
  // made the critic hold the same done_when three rounds.
  test("the title, Done when and Rollback keep the blanks inside a line, and each line break with the blanks around it is one space", () => {
    const text = renderGateSection(planner({
      title: 'Pad  the amount',
      done_when: "a negative row prints '      -¤7.50'  \n\t under\r\ndash and  BusyBox",
      rollback: 'revert the\tcommit',
    }))
    expect(text.split('\n').slice(0, 1)).toEqual(['### G1: Pad  the amount'])
    expect(text.split('\n').slice(3, 6)).toEqual([
      "Done when: a negative row prints '      -¤7.50' under dash and  BusyBox",
      'Adversary: yes',
      'Rollback: revert the\tcommit',
    ])
    const back = parseGates(text)
    expect(back.ok && back.gates[0]!.title).toBe('Pad  the amount')
    expect(back.ok && back.gates[0]!.doneWhen).toBe("a negative row prints '      -¤7.50' under dash and  BusyBox")
    expect(back.ok && back.gates[0]!.rollback).toBe('revert the\tcommit')
  })
})
