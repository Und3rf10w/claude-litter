// Tier 2: the swarm browser's roster past a screenful (the user's live look,
// 2026-11-05: a swarm of a worker per task had about 180 agents, every row
// with its menu, so the roster's Client props ran past the engine's 100,000
// characters and the `litter` pane drew nothing). The roster draws a window
// of ROSTER_ROWS rows; past it the finished fold into one row after the
// rest; liveRows' cap (LIVE_ROWS) drops the earliest-bound finished first;
// and a Client's props keep under CLIENT_PROPS_MAX whatever a list gives.

import { describe, expect, test } from 'bun:test'
import { ROSTER_ROWS, browserRosterTop, browserWheel, finishedKey, rosterId, rosterList, rosterReveal, rosterRows } from '../../hooks/swarm/browser'
import { LIVE_ROWS, capRows, finishedRow } from '../../hooks/swarm/view'
import type { BodyContext } from '../../hooks/ui/chrome'
import { CLIENT_PROPS_MAX, clientProps, listPlace, type ListSpec } from '../../hooks/ui/list'
import type { SwarmBrowserView, SwarmNodeRow } from '../../types/index'

/** The engine's bound on a Client's props, serialized. */
const ENGINE_MAX = 100_000

/** A worker row as liveRows writes one: a done builder with a full last report, its model and effort known. */
const row = (agentId: string, over: Partial<SwarmNodeRow> = {}): SwarmNodeRow => ({
  key: agentId,
  agentId,
  depth: 2,
  name: `builder #${agentId}`,
  role: 'worker',
  color: 'cyan_FOR_SUBAGENTS_ONLY',
  dim: true,
  status: 'done',
  statusGlyph: '✓',
  statusColor: 'success',
  running: false,
  tool: '',
  turns: 1,
  steps: null,
  tokens: '1.2M',
  report: 'r'.repeat(120),
  question: null,
  questionTo: null,
  flagged: false,
  model: 'claude-opus-5-5[1m]',
  effort: 'xhigh',
  tuned: false,
  ...over,
})

const LEAD: SwarmNodeRow = row('lead', { agentId: null, depth: 0, name: 'lead', role: 'lead', color: null, status: 'idle', statusGlyph: '', running: false, turns: null, tokens: '', report: '', model: null, effort: null })
const running = (over: Partial<SwarmNodeRow> = {}): Partial<SwarmNodeRow> => ({ status: 'running', statusGlyph: '▸', statusColor: 'background', running: true, tool: 'Bash', ...over })

/**
 * The lead, the orchestrator o1, then `workers` builders under it (w0 the
 * earliest): the last three running, w5 asking, and p1, a done builder with
 * a running child c1 under it.
 */
function big(workers: number): SwarmNodeRow[] {
  const ws = Array.from({ length: workers }, (_, i) => row(`w${i}`, i >= workers - 3 ? running() : i === 5 ? { question: 'which branch?', status: 'waiting' } : {}))
  return [
    LEAD,
    row('o1', { depth: 1, name: 'part-a', role: 'orchestrator', dim: false, ...running() }),
    row('p1'),
    row('c1', { depth: 3, role: 'child', name: 'explore (child)', ...running() }),
    ...ws,
  ]
}

const view = (rows: SwarmNodeRow[], over: Partial<SwarmBrowserView> = {}): SwarmBrowserView => ({
  view: 'browser',
  v: 1,
  title: [],
  notice: null,
  swarm: 'demo',
  launch: '20270115-093000',
  state: 'live',
  readOnly: false,
  lost: false,
  owner: null,
  budget: null,
  summary: null,
  rows,
  flags: [],
  events: [],
  composer: null,
  transcript: null,
  tune: null,
  selected: null,
  proposals: [],
  confirmEnd: false,
  ...over,
})

const ctx = (bodyColumns: number, lists: Record<string, number> = {}): BodyContext => ({
  surface: 'terminal',
  bodyColumns,
  isFocused: false,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 60 },
  rows: 40,
  focused: null,
  lists,
})

const labels = (spec: ListSpec): string[] => spec.items.map(i => i.label.trim())

describe('the roster past a screenful', () => {
  test('within ROSTER_ROWS every row is listed, the finished too, with no fold row', () => {
    const v = view(big(ROSTER_ROWS - 3))
    expect(rosterRows(v)).toEqual({ rows: v.rows.slice(1), finished: 0, folded: false })
    const spec = rosterList(v, true)
    expect(spec.items).toHaveLength(ROSTER_ROWS)
    expect(spec.rows).toBe(ROSTER_ROWS)
    expect(spec.items.some(i => i.key === finishedKey('demo'))).toBe(false)
  })

  test('past it the finished fold into one row after the rest; one asking, selected, with its transcript open, or with a running row under it stays', () => {
    const v = view(big(180), { selected: 'w10', transcript: { agentId: 'w11', name: 'builder #w11', readable: true, lines: [] } })
    const spec = rosterList(v, true)
    expect(labels(spec)).toEqual([
      'part-a',
      'builder #p1',
      'explore (child)',
      'builder #w5',
      'builder #w10',
      'builder #w11',
      'builder #w177',
      'builder #w178',
      'builder #w179',
      // w0 to w176, but w5, w10 and w11.
      '174 finished',
    ])
    const fold = spec.items.at(-1)!
    expect(fold).toEqual({ key: finishedKey('demo'), label: '174 finished', cells: [{ text: '+ show', color: expect.any(String) }], description: 'click to list them' })
    // Every row in the window, the fold row among them.
    expect(spec.rows).toBe(spec.items.length)
  })

  test('opened, every row is listed and the fold row last says so; the window keeps to ROSTER_ROWS', () => {
    const v = view(big(180), { showFinished: true, unlisted: 12 })
    const spec = rosterList(v, true)
    expect(spec.items).toHaveLength(183 + 1)
    expect(spec.rows).toBe(ROSTER_ROWS)
    // w0 to w176, but w5.
    expect(spec.items.at(-1)).toEqual(expect.objectContaining({ label: '176 finished', cells: [{ text: '− hide', color: expect.any(String) }], description: 'click to fold them · 12 older not listed at all' }))
    expect(listPlace(spec, ctx(120)).window).toEqual(expect.objectContaining({ start: 0, end: ROSTER_ROWS, below: 184 - ROSTER_ROWS }))
  })

  test("its Client's props stay under the engine's 100,000 characters at 500 agents, folded or opened, wide or narrow, with nothing cut", () => {
    for (const over of [{}, { showFinished: true }]) {
      const v = view(big(500), over)
      const spec = rosterList(v, true)
      // Scrolled to the end too.
      for (const at of [ctx(60), ctx(120), ctx(400), ctx(120, { [spec.id]: spec.items.length })]) {
        const props = clientProps(spec, listPlace(spec, at), at)
        expect(JSON.stringify(props).length).toBeLessThan(CLIENT_PROPS_MAX)
        expect(props.rows).toHaveLength(Math.min(ROSTER_ROWS, spec.items.length))
        expect(props.rows.map(r => r.description)).toEqual(spec.items.slice(props.offset, props.offset + props.rows.length).map(i => i.description ?? ''))
      }
    }
  })

  test("drawn whole (the window as it was before), those rows ran past the bound; clientProps cuts them to fit and counts the rest below", () => {
    const v = view(big(180), { showFinished: true })
    const whole = { ...rosterList(v, true), rows: 184 }
    const at = ctx(120)
    const place = listPlace(whole, at)
    const props = clientProps(whole, place, at)
    expect(CLIENT_PROPS_MAX).toBeLessThan(ENGINE_MAX)
    expect(JSON.stringify(props).length).toBeLessThanOrEqual(CLIENT_PROPS_MAX)
    expect(props.rows.length).toBeLessThan(184)
    expect(props.rows.length + props.below).toBe(184)
    expect(props.rows.every(r => r.description === '')).toBe(true)
  })

  test('an [Answer] selecting a row out of the window moves the window to it; one in sight moves nothing', () => {
    const v = view(big(180), { showFinished: true })
    const id = rosterId('demo')
    // w150 is item 153: the lead isn't listed, o1, p1 and c1 come first.
    expect(rosterReveal(v, 'w150', 0)).toEqual({ to: 153 - ROSTER_ROWS + 1, max: 184 - ROSTER_ROWS })
    expect(rosterReveal(v, 'w150', 150)).toBeNull()
    expect(rosterReveal(v, 'o1', 150)).toEqual({ to: 0, max: 184 - ROSTER_ROWS })
    expect(rosterReveal(v, 'nobody', 0)).toBeNull()
    expect(id).toBe('swarm:browser:roster:demo/list')
  })

  test("the wheel over the roster's rows moves its window; at its edge, or over the rows above it, the tick passes on", () => {
    const v = view(big(180), { showFinished: true })
    const id = rosterId('demo')
    const at = ctx(120)
    const top = browserRosterTop(v, at)
    expect(browserWheel(v, at, top, 1)).toEqual({ id, to: 1, max: 184 - ROSTER_ROWS })
    expect(browserWheel(v, at, top + ROSTER_ROWS - 1, 3)).toEqual({ id, to: 3, max: 184 - ROSTER_ROWS })
    expect(browserWheel(v, at, top, -1)).toBeNull()
    expect(browserWheel(v, at, top - 1, 1)).toBeNull()
    expect(browserWheel(v, ctx(120, { [id]: 184 - ROSTER_ROWS }), top, 1)).toBeNull()
  })
})

describe("liveRows' cap", () => {
  test('past LIVE_ROWS the earliest-bound finished rows with nothing under them go first; running, asking and parent rows stay', () => {
    const rows = big(LIVE_ROWS + 50)
    // Bound in order, but w3 the latest of all: it goes last.
    const boundAt = new Map(rows.map((r, i) => [r.key, r.key === 'w3' ? 1e9 : i]))
    const capped = capRows(rows, LIVE_ROWS, boundAt)
    expect(capped).toHaveLength(LIVE_ROWS)
    const keys = capped.map(r => r.key)
    for (const k of ['lead', 'o1', 'p1', 'c1', 'w3', 'w5', `w${LIVE_ROWS + 47}`, `w${LIVE_ROWS + 49}`]) expect(keys).toContain(k)
    // p1 was bound before every worker, but c1 runs under it; 54 went: w0 to w55, but w3 and w5.
    for (const k of ['w0', 'w4', 'w6', 'w55']) expect(keys).not.toContain(k)
    expect(keys).toContain('w56')
    expect(capRows(rows.slice(0, 10), LIVE_ROWS, boundAt)).toHaveLength(10)
  })

  test('a finished row is a worker or child that ended, with no question and no flag', () => {
    expect(finishedRow(row('w'))).toBe(true)
    expect(finishedRow(row('c', { role: 'child' }))).toBe(true)
    expect(finishedRow(row('o', { role: 'orchestrator' }))).toBe(false)
    expect(finishedRow(row('w', running()))).toBe(false)
    expect(finishedRow(row('w', { question: 'why?' }))).toBe(false)
    expect(finishedRow(row('w', { flagged: true }))).toBe(false)
  })
})

describe("a Client's props", () => {
  const spec = (n: number, description: string, label = 'row'): ListSpec => ({
    id: 'tasks:list',
    rows: n,
    items: Array.from({ length: n }, (_, i) => ({ key: `tasks:row:${i}`, label: `${label} ${i}`, description, actions: [{ key: `tasks:open:${i}`, label: 'Open' }] })),
  })

  test('within CLIENT_PROPS_MAX they are as laid out', () => {
    const s = spec(5, 'a short description')
    const at = ctx(120)
    expect(clientProps(s, listPlace(s, at), at).rows.map(r => r.description)).toEqual(Array(5).fill('a short description'))
  })

  test('past it the descriptions are cut first, then dropped, then the last rows go and count as below', () => {
    const at = ctx(120)
    const long = spec(50, 'd'.repeat(3_000))
    const cut = clientProps(long, listPlace(long, at), at)
    expect(JSON.stringify(cut).length).toBeLessThanOrEqual(CLIENT_PROPS_MAX)
    expect(cut.rows).toHaveLength(50)
    expect(cut.rows[0]!.description).toBe(`${'d'.repeat(159)}…`)
    const many = spec(3_000, '')
    const fewer = clientProps(many, listPlace(many, at), at)
    expect(JSON.stringify(fewer).length).toBeLessThanOrEqual(CLIENT_PROPS_MAX)
    expect(fewer.rows.length).toBeGreaterThan(100)
    expect(fewer.rows.length + fewer.below).toBe(3_000)
  })
})
