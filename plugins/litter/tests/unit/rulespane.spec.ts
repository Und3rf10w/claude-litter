// Tier 2 (phase 5b, WP-DE): the Rules body's pure parts in hooks/rules/pane.tsx.
// wrapSpans and codeLines (a line is one row, so the budget is exact);
// rulesLayout, the row budget the render follows, so the body keeps to
// ctx.rows (`fits`): side by side from 100 columns, stacked below, each list
// a row at least, the description cut with [More] when the rows run out, a
// preview, every problem or one row's whole description taking the body,
// windowed; and rulesSection, what Rules tells the hub. The render itself is
// JSX, which tier 1 (tests/rulespane.test.tsx) draws through the engine.

import { describe, expect, test } from 'bun:test'
import type { BodyContext } from '../../hooks/ui/chrome'
import type { RulesPaneView, RulesRow } from '../../types/index'
import { INLINE_ROWS, MAIN_LIST, PREVIEW_WINDOW, codeLines, instanceList, rowKey, rulesLayout, rulesSection, wrapSpans } from '../../hooks/rules/pane'
import { STATUS } from '../../hooks/rules/paneview'

const ctx = (o: Partial<BodyContext> = {}): BodyContext => ({
  surface: 'terminal',
  bodyColumns: 100,
  isFocused: false,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 },
  rows: 34,
  focused: null,
  lists: {},
  ...o,
})

const row = (key: string, over: Partial<RulesRow> = {}): RulesRow => ({
  key,
  kind: 'proposal',
  id: null,
  version: null,
  scope: 'user',
  type: 'rule',
  status: STATUS.proposed,
  when: 'touching the parser',
  rule: `rule ${key}: run the parser tests before you change the grammar`,
  paths: ['src/parser/**'],
  origin: 'drafted from your words (/litter:rules add)',
  notes: ['its id is assigned when you accept it'],
  diff: null,
  source: 'user',
  actions: ['accept', 'edit', 'dismiss'],
  consequence: [{ text: 'Accept', bold: true }, { text: ' writes ' }, { text: '/cfg/litter/rules/U-….md', color: 'suggestion' }, { text: '; every later run in user scope gets it' }],
  ...over,
})

const view = (rows: RulesRow[], over: Partial<NonNullable<RulesPaneView['body']>> = {}, tab: RulesPaneView['tab'] = 'proposed'): RulesPaneView => ({
  view: 'rules',
  v: 1,
  tab,
  body: { notice: null, counts: { proposed: rows.length, inForce: 0 }, rows, batch: null, focus: rows[0]?.key ?? null, more: null, problems: [], pending: null, editing: null, ...over },
})

const SIX = ['repo:1', 'repo:2', 'repo:3', 'repo:4', 'repo:5', 'repo:6'].map(k => row(k))
const LONG = row('repo:9', { rule: Array.from({ length: 30 }, (_, i) => `step ${i + 1} of the rule`).join('\n') })

describe('wrapSpans: spans as lines of at most `width` cells', () => {
  test('breaks at spaces, each line its runs merged by style; a word wider than a line is hard-broken', () => {
    expect(wrapSpans([{ text: 'Accept', bold: true }, { text: ' writes ' }, { text: 'a/b.md', color: 'suggestion' }, { text: ' for you' }], 14)).toEqual([
      [{ text: 'Accept', bold: true }, { text: ' writes' }],
      [{ text: 'a/b.md', color: 'suggestion' }, { text: ' for you' }],
    ])
    expect(wrapSpans([{ text: 'abcdefghij' }], 4)).toEqual([[{ text: 'abcd' }], [{ text: 'efgh' }], [{ text: 'ij' }]])
    expect(wrapSpans([{ text: 'one two three' }], 80)).toEqual([[{ text: 'one two three' }]])
  })

  test("keeps the first span's leading spaces as an indent, and with no width keeps one line", () => {
    expect(wrapSpans([{ text: '  type: rule', color: 'inactive' }], 40)).toEqual([[{ text: '  type: rule', color: 'inactive' }]])
    expect(wrapSpans([{ text: 'a b' }, { text: ' c' }], Number.POSITIVE_INFINITY)).toEqual([[{ text: 'a b' }, { text: ' c' }]])
    expect(wrapSpans([], 10)).toEqual([[]])
  })
})

describe('codeLines: a file hard-broken so each line is one row', () => {
  test('a line wider than the width breaks at the width; the rest stay whole', () => {
    expect(codeLines('---\nabcdefgh\n', 3)).toEqual(['---', 'abc', 'def', 'gh', ''])
    expect(codeLines('abc', Number.POSITIVE_INFINITY)).toEqual(['abc'])
  })
})

describe('rulesLayout: the body keeps to its rows', () => {
  test('from 100 columns the detail is beside the lists, every row and its whole description drawn', () => {
    const l = rulesLayout(view(SIX), ctx())
    expect(l).toEqual(expect.objectContaining({ mode: 'lists', wide: true, listColumns: 53, detailColumns: 45, budget: 34 }))
    expect(l.lists.map(x => [x.spec.id, x.spec.rows, x.place.client])).toEqual([[MAIN_LIST, 6, true]])
    expect(l.detail?.row.key).toBe('repo:1')
    expect(l.shown).toBe(l.detail!.lines.length)
    expect(l.height).toBeLessThanOrEqual(34)
    // The row's actions are the detail's; on the terminal the rows also carry them as their menu.
    expect(l.detail!.actions.map(a => [a.key, a.primary ?? false])).toEqual([
      ['rules:accept:repo:1', true],
      ['rules:edit:repo:1', false],
      ['rules:dismiss:repo:1', false],
    ])
    expect(l.lists[0]!.spec.items[0]).toEqual(expect.objectContaining({ key: rowKey('repo:1'), selected: true, actions: expect.arrayContaining([{ key: 'rules:accept:repo:1', label: 'Accept' }]) }))
  })

  test('below 100 columns the detail is under the lists; a short pane cuts the description, never a list under one row', () => {
    for (const rows of [34, 20, 12, 8]) {
      const l = rulesLayout(view([LONG, ...SIX], { focus: 'repo:9' }), ctx({ bodyColumns: 60, rows }))
      expect(l.wide).toBe(false)
      expect(l.lists[0]!.spec.rows).toBeGreaterThanOrEqual(1)
      expect(l.shown).toBeLessThan(l.detail!.lines.length)
      // From a pane with room for the least of it, the body keeps to its rows.
      if (rows >= 12) expect(l.height).toBeLessThanOrEqual(rows)
    }
  })

  test('inline, the compact form: at most INLINE_ROWS, whatever the rows', () => {
    const l = rulesLayout(view([LONG, ...SIX]), ctx({ bodyColumns: 60, placement: 'inline', rows: 60 }))
    expect(l.budget).toBe(INLINE_ROWS)
    expect(l.height).toBeLessThanOrEqual(INLINE_ROWS)
  })

  test('where no Client is drawn the rows have no menu, and a windowed list has its footer', () => {
    const l = rulesLayout(view([LONG, ...SIX]), ctx({ surface: 'vscode', bodyColumns: 60, rows: 14 }))
    expect(l.lists[0]!.place.client).toBe(false)
    expect(l.lists[0]!.spec.items.every(i => i.actions === undefined)).toBe(true)
    expect(l.lists[0]!.place.window.below).toBeGreaterThan(0)
    expect(l.height).toBeLessThanOrEqual(14)
  })

  test('an import batch: a list per instance, their rows aligned, the batch line wrapped at the lists\' width', () => {
    const imported = (key: string, instance: string, checked: boolean) => row(key, { scope: 'project', type: 'ban', source: 'import', checked, instance, rule: `never ${key}` })
    const v = view([imported('repo:10', 'a', true), imported('repo:11', 'a', false), imported('repo:12', 'b', true), row('repo:3')], {
      batch: {
        seq: 9,
        instances: [
          { id: 'a', goal: 'the goal', date: '2026-09-30', archived: false },
          { id: 'b', goal: '', date: null, archived: true },
        ],
        preselected: ['repo:10'],
        consequence: [{ text: 'Accept selected', bold: true }, { text: ' writes 2 new files in .litter/rules/, for you to commit; every later run in project scope gets them' }],
      },
    })
    const l = rulesLayout(v, ctx())
    expect(l.lists.map(x => x.spec.id)).toEqual([instanceList(0), instanceList(1), MAIN_LIST])
    const labels = l.lists.flatMap(x => x.spec.items.map(i => i.label))
    expect(new Set(labels.map(s => s.length)).size).toBe(1)
    expect(labels[0]).toMatch(/^\[x\] never repo:10 *$/)
    expect(labels[1]).toMatch(/^\[ \] never repo:11 *$/)
    expect(l.batchLines.length).toBeGreaterThan(1)
    // The batch's [Accept selected] is the primary: the row's own [Accept] isn't.
    expect(l.detail!.actions.find(a => a.key === 'rules:accept:repo:10')?.primary).toBeUndefined()
    expect(l.detail!.actions.map(a => a.label)).toEqual(['Accept', 'Edit…', 'Dismiss', 'Uncheck'])
  })

  test('problems: up to three lines above the lists, the rest under [More]; all of them taking the body, windowed', () => {
    const problems = ['one', 'two', 'three', 'four', 'five']
    const l = rulesLayout(view(SIX, { problems }, 'in-force'), ctx())
    expect(l.problems).toEqual({ shown: ['one', 'two'], more: 3 })
    expect(rulesLayout(view(SIX, { problems: problems.slice(0, 3) }), ctx()).problems).toEqual({ shown: ['one', 'two', 'three'], more: 0 })
    const all = rulesLayout(view(SIX, { problems, more: 'problems' }), ctx({ rows: 6 }))
    expect(all.mode).toBe('problems')
    expect(all.window!.window.below).toBeGreaterThan(0)
    expect(all.height).toBeLessThanOrEqual(6)
  })

  test("one row's whole description under [More], windowed, its actions kept", () => {
    const l = rulesLayout(view([LONG, ...SIX], { focus: 'repo:9', more: 'repo:9' }), ctx({ bodyColumns: 60, rows: 24 }))
    expect(l.mode).toBe('more')
    expect(l.lists).toEqual([])
    expect(l.window!.count).toBe(l.detail!.lines.length)
    expect(l.window!.window.below).toBeGreaterThan(0)
    expect(l.detail!.actions.length).toBe(3)
    expect(l.height).toBeLessThanOrEqual(24)
    // The window's offset is the hub's.
    const moved = rulesLayout(view([LONG, ...SIX], { focus: 'repo:9', more: 'repo:9' }), ctx({ bodyColumns: 60, rows: 24, lists: { 'rules:window:detail': 5 } }))
    expect(moved.window!.window.start).toBe(5)
  })

  test('a preview takes the body: the file windowed under [Confirm accept] and [Cancel]', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
    const v = view(SIX, { focus: 'repo:2', pending: { kind: 'preview', key: 'repo:2', path: '.litter/rules/P-x.md', text } })
    const l = rulesLayout(v, ctx({ rows: 24 }))
    expect(l.mode).toBe('preview')
    expect(l.window!.id).toBe(PREVIEW_WINDOW)
    expect(l.window!.count).toBe(40)
    expect(l.height).toBeLessThanOrEqual(24)
    expect(l.lists).toEqual([])
  })

  test('the empty states', () => {
    expect(rulesLayout(view([]), ctx()).mode).toBe('empty')
    expect(rulesLayout(view([], {}, 'in-force'), ctx()).mode).toBe('empty')
  })

  test('the retire confirm replaces the actions; the editor adds its rows', () => {
    const inForce = row('P-x', { kind: 'accepted', id: 'P-x', version: 2, status: STATUS.accepted, actions: ['edit', 'retire'] })
    delete inForce.consequence
    const retiring = rulesLayout(view([inForce], { pending: { kind: 'retire', key: 'P-x' } }, 'in-force'), ctx())
    expect(retiring.detail!.retire).toBe('retire P-x@2? Its file moves to .history, and no later run gets it')
    expect(retiring.detail!.actions).toEqual([])
    const plain = rulesLayout(view(SIX), ctx())
    const editing = rulesLayout(view(SIX, { editing: { key: 'repo:1', paths: 'src/**', type: 'rule', error: null } }), ctx())
    expect(editing.detail!.editorRows).toBeGreaterThan(0)
    expect(editing.detail!.fixed).toBeGreaterThan(plain.detail!.fixed)
  })
})

describe('rulesSection: what Rules tells the hub', () => {
  test('its body fits; its keys are the lists\' (j/k from two rules, the menu from one)', () => {
    expect(rulesSection.fits).toBe(true)
    expect(rulesSection.keys?.(view(SIX))).toEqual([
      { key: 'j/k', word: 'next/previous rule' },
      { key: 'right-click', word: "a rule's actions" },
    ])
    expect(rulesSection.keys?.(view([row('repo:1')]))).toEqual([{ key: 'right-click', word: "a rule's actions" }])
    expect(rulesSection.keys?.(view([]))).toEqual([])
    expect(rulesSection.keys?.(null)).toEqual([])
  })
})
