// Tier 2: the board's render arithmetic (hooks/board/pane.tsx; phase 5b,
// WP-DC), pure: the gate table's columns at a width (the commit drops first,
// then the try, then the failing words; the title takes what's left), the
// rows as gates.tsx draws them, the detail beside the table from
// WIDE_COLUMNS and under it below, the short form, [More], and what Runs
// tells the hub (fits, its keys).

import { describe, expect, test } from 'bun:test'
import type { BoardGateDetail, BoardGateRow, BoardView } from '../../types/index'
import { BOARD_KEYS, GATES_HINT, SPLIT_GAP, detailCut, gateCells, gateLayout, isShort, planGates, runsSection, splitOf, statusText } from '../../hooks/board/pane'
import { WIDE_COLUMNS } from '../../hooks/ui/chrome'
import { STYLE } from '../../hooks/ui/style'

const row = (over: Partial<BoardGateRow>): BoardGateRow => ({
  id: 'G1',
  title: 'Parse the header',
  state: 'landed',
  color: 'success',
  glyph: '✓',
  attempt: 1,
  attemptNow: 1,
  maxAttempts: 3,
  failing: [],
  verdictFile: null,
  commit: 'abc1234',
  oid: 'a'.repeat(40),
  earlier: null,
  actions: ['replay', 'copy'],
  ...over,
})

const LANDED = row({})
const HALTED = row({
  id: 'G2',
  title: 'Retry the refresh once',
  state: 'halted',
  color: 'warning',
  glyph: '⚑',
  attempt: 2,
  attemptNow: 2,
  failing: ['plan_adherence', 'tests_green'],
  commit: null,
  oid: null,
  actions: ['replay', 'note'],
})
const WAITING = row({ id: 'G3', title: 'Log the retry', state: 'waiting', color: 'inactive', glyph: '·', attempt: 0, attemptNow: 0, commit: null, oid: null, actions: [] })
const ROWS = [LANDED, HALTED, WAITING]

const ID = 0
const STATE = 1
const TRY = 2
const COMMIT = 3
const FAILING = 4
const TITLE = 5

describe("a gate's cells", () => {
  test('the state in its color, the try muted, the commit a SHA, the failing dimensions in words, a waiting title muted', () => {
    expect(gateCells(HALTED)).toEqual([
      { text: 'G2' },
      { text: '⚑ halted', color: 'warning' },
      { text: 'try 2/3', color: STYLE.muted },
      { text: '', color: STYLE.sha },
      { text: 'plan ✕ tests ✕', color: STYLE.failed },
      { text: 'Retry the refresh once' },
    ])
    expect(gateCells(WAITING)[TRY]!.text).toBe('')
    // A gate sent back is on its next try, which the row shows.
    expect(gateCells(row({ state: 'in progress', attempt: 1, attemptNow: 2 }))[TRY]!.text).toBe('try 2/3')
    expect(gateCells(WAITING)[TITLE]).toEqual({ text: 'Log the retry', color: STYLE.muted })
    expect(gateCells(row({ earlier: '20261001-api' }))[TITLE]!.text).toBe('Parse the header (landed in 20261001-api)')
  })
})

describe('the gate table at a width', () => {
  test('wide enough for every column: none drops, and the title takes the rest', () => {
    // 2 for the mark; 2 + 9 ("· waiting") + 7 + 7 + 14 + 16, and 5 gaps, is 60.
    const { shown, widths } = planGates(ROWS, 80)
    expect(shown).toEqual([ID, STATE, TRY, COMMIT, FAILING, TITLE])
    expect(widths[TITLE]).toBe(80 - 2 - (2 + 9 + 7 + 7 + 14) - 5)
  })

  test('the commit drops first, then the try, then the failing words; the id, state and title stay', () => {
    expect(planGates(ROWS, 60).shown).toEqual([ID, STATE, TRY, FAILING, TITLE])
    expect(planGates(ROWS, 52).shown).toEqual([ID, STATE, FAILING, TITLE])
    expect(planGates(ROWS, 40).shown).toEqual([ID, STATE, TITLE])
    expect(planGates(ROWS, 12).shown).toEqual([ID, STATE, TITLE])
  })

  test('a column no row fills takes no cells: a run with nothing failing and nothing landed', () => {
    const going = [row({ state: 'in progress', color: 'background', glyph: '▸', commit: null, oid: null, actions: [] }), WAITING]
    expect(planGates(going, 60).shown).toEqual([ID, STATE, TRY, TITLE])
  })

  test("gates.tsx's rows: each kept cell padded to its column with its gap, the last trimmed, and the hint", () => {
    const layout = gateLayout(ROWS, 60)
    expect(layout.hint).toBe(GATES_HINT)
    expect(layout.cells[1]).toEqual([
      { text: 'G2 ' },
      { text: '⚑ halted  ', color: 'warning' },
      { text: 'try 2/3 ', color: STYLE.muted },
      { text: 'plan ✕ tests ✕ ', color: STYLE.failed },
      { text: 'Retry the refresh once' },
    ])
    expect(layout.cells[0]!.map(c => c.text).join('')).toBe(`G1 ✓ landed  try 1/3 ${' '.repeat(15)}Parse the header`)
    // Every row is the same width up to its title.
    const lead = (cells: readonly { text: string }[]) => cells.slice(0, -1).reduce((n, c) => n + c.text.length, 0)
    expect(new Set(layout.cells.map(lead)).size).toBe(1)
  })

  test("the title is cut with … to what's left", () => {
    const title = gateLayout(ROWS, 48).cells[1]!.at(-1)!.text
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThan('Retry the refresh once'.length)
  })
})

describe('the detail beside the table, or under it', () => {
  test('from WIDE_COLUMNS: the detail takes 36% within 36 and 60 cells, the table the rest after the gap', () => {
    expect(WIDE_COLUMNS).toBe(100)
    expect(splitOf(99)).toBeNull()
    expect(splitOf(100)).toEqual({ table: 100 - SPLIT_GAP - 36, detail: 36 })
    expect(splitOf(120)).toEqual({ table: 120 - SPLIT_GAP - 43, detail: 43 })
    expect(splitOf(200)).toEqual({ table: 200 - SPLIT_GAP - 60, detail: 60 })
    // At 100 the table's 62 cells keep every column of a halted run's rows; the title is cut.
    expect(planGates(ROWS, 62).shown).toEqual([ID, STATE, TRY, COMMIT, FAILING, TITLE])
    expect(splitOf(60)).toBeNull()
    expect(splitOf(Number.POSITIVE_INFINITY)).toBeNull()
  })

  test('the short form: inline, or a dock with fewer than 16 rows', () => {
    expect(isShort({ placement: 'inline', rows: 40 })).toBe(true)
    expect(isShort({ placement: 'dock', rows: 15 })).toBe(true)
    expect(isShort({ placement: 'dock', rows: 16 })).toBe(false)
    expect(isShort({ placement: 'dock', rows: Number.POSITIVE_INFINITY })).toBe(false)
  })

  test('[More] shows once an evidence runs past its line or a dimension has more than two gaps', () => {
    const d = (evidence: string, gaps: string[] = []): BoardGateDetail => ({
      gate: 'G2',
      dimensions: [{ name: 'plan_adherence', word: 'plan adherence', pass: false, evidence, gaps }],
      verdictAttempt: 2,
      verify: null,
      planGap: '',
      gapBy: null,
      ruleClash: '',
      reason: 'halted',
      actions: [],
      more: false,
    })
    expect(detailCut(d('short'), 40)).toBe(false)
    expect(detailCut(d('x'.repeat(39)), 40)).toBe(true)
    expect(detailCut(d('short', ['a', 'b']), 40)).toBe(false)
    expect(detailCut(d('short', ['a', 'b', 'c']), 40)).toBe(true)
    expect(detailCut(d('x'.repeat(500)), Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('what Runs tells the hub', () => {
  test("fits is false (its long parts aren't windowed); its keys only while a gate table shows", () => {
    expect(runsSection.fits).toBe(false)
    expect(runsSection.keys(null)).toEqual([])
    const view = (gates: boolean) => ({ view: 'board', v: 1, run: 'r', body: { gates: gates ? { run: 'r', rows: [], selected: null } : null } }) as unknown as BoardView
    expect(runsSection.keys(view(false))).toEqual([])
    expect(runsSection.keys(view(true))).toBe(BOARD_KEYS)
    expect(BOARD_KEYS.map(k => `${k.key} ${k.word}`)).toEqual(['↑↓ gates', 'enter select', '→ actions'])
  })

  test('a status in words', () => {
    expect(['needs_user', 'ledger_tampered', 'launch_failed', 'halted', 'some_new_word'].map(statusText)).toEqual(['needs you', 'ledger tampered', 'launch failed', 'halted', 'some new word'])
  })
})
