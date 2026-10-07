// Tier 1: the Stats section of the one `litter` pane (phase 5b, WP-DH) as the
// engine runs and draws it. `/litter stats` answers what it shows and draws
// the session's figures from $.session.usage (a session.usage hook beneath);
// with no swarm live it says so and names the next step. A view with a swarm
// (fed to the pane through a state.get hook beneath, as swarm-panes.test.tsx
// feeds its own) draws at 100 and 60 columns: "This session" with its spend,
// context and limits, then the swarm's heading with its state on the rule,
// its spend and its tokens, the note, the table with its numbers aligned
// right (the least needed columns dropped when narrow), and [Open in
// Swarms], whose press opens Swarms on it.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { StatsPaneView } from '../types/index'
import { drawText, drawWithColors } from './drawing'

const NOW = Date.parse('2026-10-07T13:00:00Z')

const pane = (bodyColumns: number) =>
  ({ title: 'litter', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }) as const

const mount = ($: Engine, bodyColumns = 100) => $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'Pane', requestId: 'litter', props: pane(bodyColumns) })

/** Enough of a session for /litter: the clock, the store, no swarm, no agent, and the usage given. */
function world(on: On, usage: object): { opened: string[] } {
  const opened: string[] = []
  mock.store(on)
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/tier1' })
  on('session.id', async () => ({ value: 'tier1-stats' }))
  on('session.usage', async () => ({ value: structuredClone(usage) as never }))
  on('agent.list', async () => ({ value: [] }))
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', async () => ({ value: [{ id: 'litter', title: 'litter', isShown: true, isFocused: false, isPlaced: true }] }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  return { opened }
}

const run = ($: Engine, args: string) => $.command.run({ command: 'litter', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

/** The views beneath the plugins: the hub naming Stats, and Stats' own. */
function seeded(on: On, view: StatsPaneView): void {
  on('state.get', async (_$, e, next) => {
    if (e.key === 'hub') return { value: { value: { view: 'hub', v: 1, section: 'stats', live: [], tabs: [] }, version: 0 } }
    if (e.key === 'statsPane') return { value: { value: view, version: 0 } }
    return next(e)
  })
}

const tokens = (input: string, cacheRead: string, cacheWrite: string, output: string, turns: number) => ({ input, cacheRead, cacheWrite, output, turns })

const VIEW: StatsPaneView = {
  view: 'stats',
  v: 1,
  body: {
    session: {
      spend: '$12.34',
      context: '45k of 200k tokens · 22%',
      limits: [
        { label: '5-hour', used: '23%', resets: '14:00', color: 'text' },
        { label: '7-day', used: '75%', resets: null, color: 'warning' },
      ],
    },
    swarms: [
      {
        name: 'codex',
        state: { text: '▸ live 2h 14m', color: 'background' },
        spend: '$8.10 since launch',
        spendNote: "the session's whole spend since launch, the lead's and every agent's",
        tokens: tokens('303k', '13.3M', '632k', '125k', 212),
        rows: [
          { key: 'lead', name: 'lead', color: null, mark: { glyph: '·', color: 'inactive' }, tokens: tokens('1k', '50k', '2k', '500', 12) },
          { key: 'a-boss', name: 'boss', color: 'magenta_FOR_SUBAGENTS_ONLY', mark: { glyph: '▸', color: 'background' }, tokens: tokens('2k', '1.2M', '30k', '4k', 40) },
          { key: 'a-port', name: '  implementer', color: null, mark: { glyph: '✓', color: 'success' }, tokens: tokens('300k', '12.0M', '600k', '120k', 160) },
        ],
        hiddenRows: 0,
      },
    ],
    problems: [],
  },
}

/** The body as drawn: "This session" to [Open in Swarms]. */
function bodyOf(rows: readonly string[]): string[] {
  const from = rows.findIndex(r => r.startsWith('This session'))
  const to = rows.findIndex((r, i) => i > from && r.startsWith('[ Open in Swarms ]'))
  return rows.slice(from, to + 1)
}

describe('/litter stats', () => {
  test("answers what it shows, opens `litter` on Stats, and with no swarm live says so and names the next step", async ($, on) => {
    const w = world(on, { startedAt: NOW, context: { tokens: 45_000, window: 200_000, percent: 22 }, rateLimits: [], cost: { usd: 3.5 } })
    expect((await run($, 'stats')).text).toBe("Stats shows this session's $3.50")
    expect(w.opened.at(-1)).toBe('litter')
    const ui = await mount($)
    expect(await ui.find({ type: 'Text', text: ' · Stats' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$3.50' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '/litter swarms' })).toBeDefined()
    expect(drawText(await ui.drawn(), 100)).toContainEqual(expect.stringMatching(/^context +45k of 200k tokens · 22%$/))
  })
})

/** Rows with the colors beside each, as drawWithColors writes them; a blank row (a margin) has none. */
const golden = (columns: number, rows: readonly [string, string][]): string[] => rows.map(([text, colors]) => (colors === '' ? text : `${text.padEnd(columns)}  | ${colors}`))
const BLANK: [string, string] = ['', '']
const ruled = (title: string, columns: number, note?: string): string =>
  note === undefined ? `${title} ${'─'.repeat(columns - title.length - 1)}` : `${title} ${'─'.repeat(columns - title.length - note.length - 5)} ${note} ──`
/** A table row: the mark, the name in its column (13 cells: `  implementer`), each count right-aligned in its own. */
const WIDTHS = [5, 5, 10, 11, 6]
const tr = (mark: string, name: string, ...counts: string[]): string => [mark, name.padEnd(13), ...counts.map((c, i) => c.padStart(WIDTHS[i]!))].join(' ')

const ROWS = (columns: number): [string, string][] => [
  [ruled('This session', columns), 'suggestion bold, subtle'],
  ['spend   $12.34 so far', 'inactive, text, inactive'],
  ['context 45k of 200k tokens · 22%', 'inactive, text'],
  ['5-hour  23% used · resets 14:00', 'inactive, text, inactive'],
  ['7-day   75% used', 'inactive, warning, inactive'],
  BLANK,
  [ruled('Swarm codex', columns, '▸ live 2h 14m'), 'suggestion bold, subtle, background, subtle'],
  ['spend   $8.10 since launch', 'inactive, text'],
  ...(columns >= 100
    ? ([["the session's whole spend since launch, the lead's and every agent's", 'inactive']] as [string, string][])
    : ([
        ["the session's whole spend since launch, the lead's and every", 'inactive'],
        ["agent's", 'inactive'],
      ] as [string, string][])),
  BLANK,
  [tr(' ', '', 'turns', 'input', 'cache read', 'cache write', 'output'), 'inactive'],
  [tr('·', 'lead', '12', '1k', '50k', '2k', '500'), 'inactive, cyan_FOR_SUBAGENTS_ONLY, inactive, default'],
  [tr('▸', 'boss', '40', '2k', '1.2M', '30k', '4k'), 'background, magenta_FOR_SUBAGENTS_ONLY, inactive, default'],
  [tr('✓', '  implementer', '160', '300k', '12.0M', '600k', '120k'), 'success, cyan_FOR_SUBAGENTS_ONLY, inactive, default'],
  [tr(' ', 'total', '212', '303k', '13.3M', '632k', '125k'), 'text bold, default bold'],
  ['[ Open in Swarms ]', 'default dim'],
]

describe('the drawings', () => {
  for (const columns of [100, 60]) {
    test(`a swarm at ${columns} columns: the session's figures, the swarm's spend and its note, the table with its total, and [Open in Swarms]`, async ($, on) => {
      mock.store(on)
      seeded(on, VIEW)
      const ui = await mount($, columns)
      expect(bodyOf(drawWithColors(await ui.drawn(), columns))).toEqual(golden(columns, ROWS(columns)))
    })
  }

  test('at 40 columns the table drops the turns, the input and the cache writes, in that order, and keeps the cache reads and the output', async ($, on) => {
    mock.store(on)
    seeded(on, VIEW)
    const ui = await mount($, 40)
    const rows = bodyOf(drawText(await ui.drawn(), 40))
    expect(rows).toContain(`${' '.repeat(16)}cache read output`)
    expect(rows).toContain(`✓   implementer      12.0M   120k`)
    for (const r of rows) expect(r.length).toBeLessThanOrEqual(40)
  })

  // Its press (Swarms loaded on the swarm) is tier 2's (stats.spec.ts): a press here would write the hub's atom, which this test pins.
  test("[Open in Swarms] is keyed by its swarm's name", async ($, on) => {
    mock.store(on)
    seeded(on, { ...VIEW, body: { ...VIEW.body!, swarms: [{ ...VIEW.body!.swarms[0]!, name: 'a b' }] } })
    const ui = await mount($)
    expect(await ui.find({ type: 'Button', key: 'stats:open-swarm:a%20b' })).toBeDefined()
  })
})
