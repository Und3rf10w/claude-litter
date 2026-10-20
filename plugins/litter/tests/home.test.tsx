// Tier 1 (phase 5b, WP-DB): Home, the `litter` pane's first section, as the
// engine draws it. With nothing running and nothing waiting it says so in
// one line and gives the next step as a command; with a run, a swarm, a
// waiting question and a lead proposal (each its own row, saying which thing
// waits) it draws what needs you first, then what runs, then what
// ended and the other sections, each row its mark, its words and [Open], the
// first needs-you row's the primary; with more rows than fit it keeps what
// needs you and what runs whole and folds the rest into "N more" lines,
// docked and inline, at 100 and 60 columns; and each [Open] lands on its
// section and item: a halted run recorded on disk, through the ui tick's band
// build into Home, onto its board; a swarm onto its builder; a proposal or a
// run that's gone onto its section, saying so. The views Home is drawn from here are held in the
// `hub` atom, as tier 2 (hub.spec.ts, homeview.spec.ts) builds them; the last
// block holds the drawings, each row's colors beside it.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { BoardView, HomeView, HubView } from '../types/index'
import { drawWithColors } from './drawing'

const SESSION = 'tier1-home'
const LITTER = '/repo/.claude/litter'
const NOW = 1_800_000_000_000
const RUN = '20261005-retry'
const SLOW = { timeoutMs: 30_000 }

type Placement = 'dock' | 'inline'
type Over = { isFocused?: boolean; bodyColumns?: number; bodyRows?: number; placement?: Placement }
const pane = (o: Over = {}) =>
  ({ title: 'litter', isFocused: o.isFocused ?? true, bodyColumns: o.bodyColumns ?? 100, placement: o.placement ?? 'dock', scroll: { offset: 0, bodyRows: o.bodyRows ?? 40 }, view: {} }) as const
const mount = ($: Engine, o: Over = {}) => $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'Pane', requestId: 'litter', props: pane(o) })
const run = ($: Engine, args = '') => $.command.run({ command: 'litter', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

type World = {
  files: Map<string, string>
  opened: { id: string; focus: boolean }[]
  toasts: string[]
  /** While set, the `hub` atom reads as this view. */
  held: { value: unknown }
  /** Each hub view litter wrote, in order, and each board view. */
  hubs: HubView[]
  boards: BoardView[]
  /** Resolves with the first hub view litter writes that `pred` holds of (the last one written, when it does already). */
  hubWritten: (pred: (h: HubView) => boolean) => Promise<HubView>
  clock: ReturnType<typeof mock.clock>
}

/** $.fs over a map, git as a plain checkout at /repo, what was opened and toasted, the `hub` atom's writes, and `held`, which pins its read. */
function world(on: On): World {
  const files = new Map<string, string>()
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  const ran = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => {
    if (!isDir(e.path)) throw new Error(`ENOENT: ${e.path}`)
    const names = new Set([...files.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => k.slice(e.path.length + 1).split('/')[0]!))
    return { value: [...names].map(name => ({ name, kind: files.has(`${e.path}/${name}`) ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', async (_$, e) => {
    const known = files.has(e.path) || isDir(e.path) || e.path === '/repo' || e.path === '/repo/.git'
    if (!known) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: files.has(e.path) ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
  })
  on('process.run', async (_$, e) => {
    const argv = e.argv
    if (argv[0] === 'git' && argv.includes('rev-parse')) {
      if (argv.includes('--show-toplevel') && !argv.includes('--git-dir')) return ran(0, '/repo\n')
      if (argv.includes('--git-dir') && argv.includes('--git-common-dir')) return ran(0, '/repo/.git\n/repo/.git\n')
    }
    return ran(1)
  })
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('agent.list', async () => ({ value: [] }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  const opened: World['opened'] = []
  const open = new Set<string>()
  on('ui.open', async (_$, e) => {
    opened.push({ id: e.id, focus: e.focus === true })
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', async () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: true, isPlaced: true })) }))
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', async () => ({ value: undefined }))
  const held: World['held'] = { value: null }
  // The held value with the store's own version, so the hub's write after a press (a compare-and-swap) still lands.
  on('state.get', async (_$, e, next) => {
    const real = await next(e)
    if (e.key !== 'hub' || held.value === null) return real
    return { value: { value: held.value, version: (real as { value?: { version?: number } }).value?.version ?? 0 } }
  })
  const hubs: HubView[] = []
  const boards: BoardView[] = []
  let waiting: { pred: (h: HubView) => boolean; resolve: (h: HubView) => void }[] = []
  on('state.set', async (_$, e, next) => {
    const set = await next(e)
    if (e.key === 'hub') {
      const hub = e.value as HubView
      hubs.push(hub)
      const met = waiting.filter(x => x.pred(hub))
      waiting = waiting.filter(x => !met.includes(x))
      for (const x of met) x.resolve(hub)
    }
    if (e.key === 'board') boards.push(e.value as BoardView)
    return set
  })
  const hubWritten = (pred: (h: HubView) => boolean): Promise<HubView> => {
    const last = hubs.at(-1)
    // One that's never written fails the test at its own timeout.
    return last && pred(last) ? Promise.resolve(last) : new Promise(resolve => waiting.push({ pred, resolve }))
  }
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.cwd', async () => ({ value: '/repo' }))
  mock.store(on)
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/tier1' })
  return { files, opened, toasts, held, hubs, boards, hubWritten, clock }
}

async function start($: Engine, on: On): Promise<World> {
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  return w
}

// ---------------------------------------------------------------------------
// The views Home is drawn from, as writeHub builds them (tier 2 checks the building)

const NAME = 'cyan_FOR_SUBAGENTS_ONLY'
const SEP = { text: ' · ' }
const NEEDS = { glyph: '⚑', word: 'needs you', color: 'permission' }
const RUNNING = { glyph: '▸', word: 'running', color: 'background' }
const LIVE_MARK = { glyph: '▸', word: 'live', color: 'background' }
const DONE = { glyph: '✓', word: 'done', color: 'success' }
const FAILED = { glyph: '✕', word: 'failed', color: 'error' }

const question = { open: 'home:open:swarms:review', mark: NEEDS, spans: [{ text: 'reviewer', color: NAME }, { text: ' asks: should the parser accept tabs as well as spaces?' }] }
const proposal = { open: 'home:open:swarms:review/6', mark: NEEDS, spans: [{ text: "the lead's proposal 6 for " }, { text: 'review', color: NAME }] }
const rules = { open: 'home:open:rules', mark: NEEDS, spans: [{ text: '2 rules proposed or unverified, for you to accept or dismiss' }] }
const execRow = {
  open: `home:open:runs:${RUN}`,
  mark: RUNNING,
  spans: [{ text: 'execute ' }, { text: RUN, color: NAME }, SEP, { text: 'gate 3/7' }, SEP, { text: 'G2' }, { text: ' ' }, { text: 'retry 2', color: 'warning' }, SEP, { text: '14m', color: 'inactive' }],
}
const swarmRow = {
  open: 'home:open:swarms:review#2',
  mark: LIVE_MARK,
  spans: [{ text: 'swarm ' }, { text: 'review', color: NAME }, SEP, { text: '3 running', color: 'background' }, SEP, { text: '⚑ 1 waiting', color: 'permission' }, SEP, { text: '22m', color: 'inactive' }],
}
const fanRow = { open: 'home:open:runs:20261005-split', mark: RUNNING, spans: [{ text: 'fanout ' }, { text: '20261005-split', color: NAME }, SEP, { text: '2/3 tasks' }, SEP, { text: 'integrating' }, SEP, { text: '6m', color: 'inactive' }] }
const endedRow = (run: string, mark: typeof DONE, detail: string, time: string) => ({ open: `home:open:runs:${run}`, mark, spans: [{ text: 'design ' }, { text: run, color: NAME }, SEP, { text: detail }, SEP, { text: time, color: 'inactive' }] })
const OTHERS = [
  { open: 'home:open:tasks', label: 'Tasks', text: "3 open tasks in this session's list" },
  { open: 'home:open:agents', label: 'Agents', text: '2 running in this session' },
  { open: 'home:open:doctor', label: 'Doctor', text: "what a swarm needs of this session's settings and limits" },
]

/** A run, a swarm with a waiting question and a lead proposal, rules proposed, a design that ended, and the other sections. */
const BUSY: HomeView = { needsYou: [question, proposal, rules], running: [execRow, swarmRow], ended: [endedRow('20261005-currency', DONE, 'v3 APPROVED', '31m')], endedMinutes: 10, others: OTHERS }
/** More than fits at 14 rows: a third run, three ended. */
const MANY: HomeView = {
  ...BUSY,
  running: [execRow, swarmRow, fanRow],
  ended: [endedRow('20261005-currency', DONE, 'v3 APPROVED', '31m'), endedRow('20261005-auth', FAILED, 'v1', '4m'), endedRow('20261005-cache', DONE, 'v2 APPROVED', '12m')],
}

const TABS = [
  { section: 'home', label: 'Home', count: null, needsYou: false },
  { section: 'runs', label: 'Runs', count: 1, needsYou: false },
  { section: 'swarms', label: 'Swarms', count: 1, needsYou: true },
  { section: 'rules', label: 'Rules', count: 2, needsYou: true },
  { section: 'tasks', label: 'Tasks', count: 3, needsYou: false },
  { section: 'agents', label: 'Agents', count: 2, needsYou: false },
  { section: 'stats', label: 'Stats', count: null, needsYou: false },
  { section: 'doctor', label: 'Doctor', count: null, needsYou: false },
]
const LIVE = [
  { text: '▸ running: ', color: 'background' },
  { text: '1 run, 1 swarm' },
  { text: ' · ', color: 'subtle' },
  { text: '⚑ needs you: 1 question, 1 proposal, 2 rules', color: 'permission' },
]
const hubOf = (home: HomeView): HubView => ({ view: 'hub', v: 1, section: 'home', live: LIVE, tabs: TABS, focus: null, lists: {}, home }) as HubView

/** A session with Home shown, the hub atom held at `home`'s view. */
async function holding($: Engine, on: On, home: HomeView): Promise<World> {
  const w = await start($, on)
  await run($, '')
  w.held.value = hubOf(home)
  return w
}

// ---------------------------------------------------------------------------
// A run recorded on disk, for the [Open] that lands on its board

const hex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/**
 * An execute run of two gates that halted at G2 four minutes ago: run.json
 * and a ledger as ledgercore writes it (one file per record, each chained to
 * the sha256 of the one before), its launch eight minutes ago.
 */
async function haltedRun(files: Map<string, string>): Promise<void> {
  const BASE = 'a'.repeat(40)
  files.set(
    `${LITTER}/${RUN}/run.json`,
    `${JSON.stringify({ v: 1, run: RUN, workflow: 'execute', args: { gates: [{ id: 'G1', title: 'Parse the header' }, { id: 'G2', title: 'Retry the refresh once' }], maxAttempts: 3 }, authorized: [], mode: 'default', verify: ['bun', 'test'], goalCheck: null, setup: null, linkDirs: [], base: BASE, ref: `refs/heads/litter/${RUN}`, checkout: '/repo', isolate: false, previousBranch: 'main', continueOf: null, amendOf: null, rules: [], planPath: null, planSha256: null, session: SESSION, created: NOW - 600_000 })}\n`,
  )
  const dim = { pass: true, evidence: 'fine', gaps: [] }
  const verify = { verify_id: 'v1', gate: 'G1', attempt: 1, argv: ['bun', 'test'], tree_before: 'c'.repeat(40), tree_after: 'c'.repeat(40), dirty_submodules: [], exit_code: 0, signal: null, timed_out: false, spawn_error: null, green: true, log_parts: 1, log_bytes: 10, output_tail: '' }
  const records = [
    { kind: 'run.start', body: { workflow: 'execute', base: BASE, ref: `refs/heads/litter/${RUN}`, checkout: '/repo', oid: 'd'.repeat(40), session: SESSION } },
    { kind: 'run.launch', body: { taskId: 't1', runId: 'wf_1', scriptPath: null, generation: 1, session: SESSION, oid: 'd'.repeat(40) } },
    { kind: 'verify', body: verify },
    { kind: 'verdict', body: { verify_id: 'v1', plan_adherence: dim, tests_green: dim, no_regressions: dim, rules: dim, plan_gap: '', proposed_rules: [] } },
    { kind: 'land', body: { gate: 'G1', verify_id: 'v1', commit: 'b'.repeat(40), tree: 'c'.repeat(40), old: BASE, ref: `refs/heads/litter/${RUN}` } },
    { kind: 'run.end', body: { taskId: 't1', generation: 1, status: 'halted', reason: 'G2: out of attempts', source: 'notification' } },
  ]
  let prev: string | null = null
  for (const [i, r] of records.entries()) {
    const seq = i + 1
    const text = `${JSON.stringify({ v: 1, seq, kind: r.kind, run: RUN, at: NOW - 600_000 + seq * 60_000, by: { source: 'mod' }, prev, body: r.body })}\n`
    files.set(`${LITTER}/${RUN}/ledger/${String(seq).padStart(6, '0')}-${r.kind}.json`, text)
    prev = await sha256(text)
  }
}

// ---------------------------------------------------------------------------
// The drawings, each row's colors beside it (drawWithColors); blank rows left out but where the rows are counted

const golden = (columns: number, rows: readonly (readonly [string, string])[]): string[] => rows.map(([text, colors]) => (colors === '' ? text : `${text.padEnd(columns)}  | ${colors}`))
const filled = (rows: readonly string[]): string[] => rows.filter(r => r.trim() !== '')

// Focused, each tab but the shown one is its hotkey in `suggestion`, a colon and its label (A19: tests/drawing.ts draws
// the digits, as the engine does); the shown one says its digit in its bold text; a faint │ after every tab but the last.
const SHOWN = 'text bold, subtle'
const TAB = 'suggestion, default, subtle'
const LAST_TAB = 'suggestion, default'
// Eight tabs (WP-DH): at 60 columns Agents goes to the strip's second row.
const HEAD_QUIET = (c: number): [string, string][] => [
  ['litter · Home', 'claude bold, inactive'],
  ['nothing running', 'inactive'],
  ...(c >= 100
    ? ([['› 1: Home │ 2: Runs │ 3: Swarms │ 4: Rules │ 5: Tasks │ 6: Agents │ 7: Stats │ 8: Doctor', [SHOWN, ...Array(6).fill(TAB), LAST_TAB].join(', ')]] as [string, string][])
    : ([
        ['› 1: Home │ 2: Runs │ 3: Swarms │ 4: Rules │ 5: Tasks │', [SHOWN, ...Array(4).fill(TAB)].join(', ')],
        ['6: Agents │ 7: Stats │ 8: Doctor', [TAB, TAB, LAST_TAB].join(', ')],
      ] as [string, string][])),
]
// Each tab's count muted after its label, its ⚑ in the needs-you color.
const COUNTED = 'suggestion, default, inactive, subtle'
const FLAGGED = 'suggestion, default, inactive, permission, subtle'
const HEAD_BUSY = (c: number): [string, string][] => [
  ['litter · Home', 'claude bold, inactive'],
  // One line, cut to the pane (chrome's spansLine).
  [cut('▸ running: 1 run, 1 swarm · ⚑ needs you: 1 question, 1 proposal, 2 rules', c), 'background, default, subtle, permission'],
  // With their digits the eight tabs are 102 cells, so at 100 Doctor goes to a second row.
  ...(c >= 100
    ? ([
        ['› 1: Home │ 2: Runs 1 │ 3: Swarms 1 ⚑ │ 4: Rules 2 ⚑ │ 5: Tasks 3 │ 6: Agents 2 │ 7: Stats │', [SHOWN, COUNTED, FLAGGED, FLAGGED, COUNTED, COUNTED, TAB].join(', ')],
        ['8: Doctor', LAST_TAB],
      ] as [string, string][])
    : ([
        ['› 1: Home │ 2: Runs 1 │ 3: Swarms 1 ⚑ │ 4: Rules 2 ⚑ │', [SHOWN, COUNTED, FLAGGED, FLAGGED].join(', ')],
        ['5: Tasks 3 │ 6: Agents 2 │ 7: Stats │ 8: Doctor', [COUNTED, COUNTED, TAB, LAST_TAB].join(', ')],
      ] as [string, string][])),
]
const KEYS = (c: number): [string, string][] =>
  c >= 100
    ? [['1–8 section · tab next · enter press · esc back to the prompt', 'suggestion bold, inactive, subtle, suggestion bold, inactive, subtle, suggestion bold, inactive, subtle, suggestion bold, inactive']]
    : [
        ['1–8 section · tab next · enter press', 'suggestion bold, inactive, subtle, suggestion bold, inactive, subtle, suggestion bold, inactive'],
        [' · esc back to the prompt', 'subtle, suggestion bold, inactive'],
      ]
const rule = (title: string, c: number, note?: string): string => (note ? `${title} ${'─'.repeat(c - title.length - note.length - 5)} ${note} ──` : `${title} ${'─'.repeat(c - title.length - 1)}`)
const HEADING = 'suggestion bold, subtle'
const OPEN_DIM = 'default dim'

/** Words in `room` cells, cut with `…` as fitSpans cuts them (every text here is one cell a character). */
const cut = (text: string, room: number): string => (text.length > room ? `${text.slice(0, room - 1)}…` : text)
/** A marked row: the mark in its column (as wide as `⚑ needs you`), a cell, the words in the room left, a cell, [Open]. */
const marked = (mark: string, words: string, c: number): string => `${mark.padEnd(11)} ${cut(words, c - 21).padEnd(c - 21)} [ Open ]`
/** Another section's line: the label in its column (six cells), a cell, the words muted, a cell, [Open]. */
const other = (label: string, text: string, c: number): [string, string] => [`${label.padEnd(6)} ${cut(text, c - 16).padEnd(c - 16)} [ Open ]`, `text bold, inactive, ${OPEN_DIM}`]

const QUIET_BODY = (c: number): [string, string][] => [
  ['· Nothing needs you, and nothing runs.', 'inactive'],
  ['Next: /litter:execute <plan.md | goal> starts a run', 'inactive, suggestion, inactive'],
  [rule('Elsewhere', c), HEADING],
  other('Swarms', 'none live: build one from a template, or ask the lead', c),
  other('Doctor', "what a swarm needs of this session's settings and limits", c),
]

/** Each row of the held views at `c` columns, its colors as drawn (a span cut away takes its color with it). */
const ROW = {
  question: (c: number): [string, string] => [marked('⚑ needs you', 'reviewer asks: should the parser accept tabs as well as spaces?', c), `permission, ${NAME}, default, claude`],
  proposal: (c: number): [string, string] => [marked('⚑ needs you', "the lead's proposal 6 for review", c), `permission, default, ${NAME}, ${OPEN_DIM}`],
  rules: (c: number): [string, string] => [marked('⚑ needs you', '2 rules proposed or unverified, for you to accept or dismiss', c), `permission, default, ${OPEN_DIM}`],
  exec: (c: number): [string, string] => [
    marked('▸ running', `execute ${RUN} · gate 3/7 · G2 retry 2 · 14m`, c),
    c >= 100 ? `background, default, ${NAME}, default, warning, default, inactive, ${OPEN_DIM}` : `background, default, ${NAME}, default, ${OPEN_DIM}`,
  ],
  swarm: (c: number): [string, string] => [
    marked('▸ live', 'swarm review · 3 running · ⚑ 1 waiting · 22m', c),
    `background, default, ${NAME}, default, background, default, permission, default, ${c >= 100 ? 'inactive, ' : ''}${OPEN_DIM}`,
  ],
  fan: (c: number): [string, string] => [marked('▸ running', 'fanout 20261005-split · 2/3 tasks · integrating · 6m', c), `background, default, ${NAME}, default, ${c >= 100 ? 'inactive, ' : ''}${OPEN_DIM}`],
  currency: (c: number): [string, string] => [marked('✓ done', 'design 20261005-currency · v3 APPROVED · 31m', c), `success, default, ${NAME}, default, ${c >= 100 ? 'inactive, ' : ''}${OPEN_DIM}`],
}

/** BUSY at 40 rows: every group under its heading, nothing folded. */
const BUSY_BODY = (c: number): [string, string][] => [
  [rule('Needs you', c), HEADING],
  ROW.question(c),
  ROW.proposal(c),
  ROW.rules(c),
  [rule('Running', c), HEADING],
  ROW.exec(c),
  ROW.swarm(c),
  [rule('Recently ended', c, 'the last 10 minutes'), 'suggestion bold, subtle, inactive, subtle'],
  ROW.currency(c),
  [rule('Elsewhere', c), HEADING],
  other('Tasks', "3 open tasks in this session's list", c),
  other('Agents', '2 running in this session', c),
  other('Doctor', "what a swarm needs of this session's settings and limits", c),
]

/**
 * MANY at 14 rows: no headings, needs you and running whole; at 100 the
 * ended runs counted (the others' line goes: focused, eight tabs with their
 * digits are 102 cells, so the strip takes two rows); at 60 (the strip and
 * the keys line take two rows each) the ended line goes too, left to the strip.
 */
const MANY_14: Record<number, [string, string][]> = {
  100: [...HEAD_BUSY(100), ROW.question(100), ROW.proposal(100), ROW.rules(100), ROW.exec(100), ROW.swarm(100), ROW.fan(100), ['3 ended in the last 10 minutes', 'inactive'], ...KEYS(100)],
  60: [...HEAD_BUSY(60), ROW.question(60), ROW.proposal(60), ROW.rules(60), ROW.exec(60), ROW.swarm(60), ROW.fan(60), ...KEYS(60)],
}

describe('Home with nothing running and nothing waiting', () => {
  for (const c of [100, 60]) {
    test(`at ${c} columns: one line says so, the next step is a command, and Swarms and Doctor each have [Open]`, async ($, on) => {
      await start($, on)
      expect((await run($, '')).text).toBe('Home shows nothing running')
      const ui = await mount($, { bodyColumns: c })
      expect(filled(drawWithColors(await ui.drawn(), c))).toEqual(golden(c, [...HEAD_QUIET(c), ...QUIET_BODY(c), ...KEYS(c)]))
      // No section with nothing to say: no Tasks, Agents or Runs line, and no 0.
      expect((await ui.findAll({ type: 'Button' })).map(b => b.key).filter(k => k?.startsWith('home:'))).toEqual(['home:open:swarms', 'home:open:doctor'])
      // Nothing needs you and nothing runs: no primary.
      expect((await ui.findAll({ type: 'Button' })).filter(b => b.props.variant === 'primary')).toEqual([])
    })
  }
})

describe('Home with a run, a swarm and a waiting question', () => {
  for (const c of [100, 60]) {
    test(`at ${c} columns, docked and inline: needs you first, then running, ended and the rest, each row its mark, words and [Open]`, async ($, on) => {
      await holding($, on, BUSY)
      const dock = await mount($, { bodyColumns: c })
      const drawn = drawWithColors(await dock.drawn(), c)
      expect(filled(drawn)).toEqual(golden(c, [...HEAD_BUSY(c), ...BUSY_BODY(c), ...KEYS(c)]))
      // Docked, the keys line is at the pane's foot, the drawing the pane's 40 rows (at 100 the strip's digits take it to two).
      expect(drawn).toHaveLength(40)
      await dock.unmount()
      const inline = await mount($, { bodyColumns: c, placement: 'inline' })
      expect(filled(drawWithColors(await inline.drawn(), c))).toEqual(filled(drawn))
    })
  }

  test("the first needs-you row's [Open] is the one primary; with nothing needing you, the first running row's", async ($, on) => {
    const w = await holding($, on, BUSY)
    const ui = await mount($)
    const opens = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('home:open:'))
    expect(opens.filter(b => b.props.variant === 'primary').map(b => b.key)).toEqual(['home:open:swarms:review'])
    expect(opens.filter(b => b.props.variant !== 'primary').every(b => b.props.dimColor === true)).toBe(true)
    await ui.unmount()
    w.held.value = hubOf({ ...BUSY, needsYou: [] })
    const running = await mount($)
    expect((await running.findAll({ type: 'Button' })).filter(b => b.props.variant === 'primary').map(b => b.key)).toEqual([`home:open:runs:${RUN}`])
  })
})

describe('Home with more rows than fit', () => {
  for (const c of [100, 60]) {
    test(`at ${c} columns and 14 rows, docked and inline: needs you and running whole, the rest folded, the keys line at the foot`, async ($, on) => {
      await holding($, on, MANY)
      for (const placement of ['dock', 'inline'] as const) {
        const ui = await mount($, { bodyColumns: c, bodyRows: 14, placement })
        const rows = drawWithColors(await ui.drawn(), c)
        expect({ placement, rows: filled(rows) }).toEqual({ placement, rows: golden(c, MANY_14[c]!) })
        // The 14 rows whole: the gap under the strip and the one above the keys line are the blank ones.
        expect({ placement, height: rows.length }).toEqual({ placement, height: 14 })
        await ui.unmount()
      }
    })
  }
})

describe("Home's [Open]", () => {
  test('on a halted run: the ui tick builds the band, Home has it under needs you, and its [Open] lands on its board in the same pane', SLOW, async ($, on) => {
    const w = await start($, on)
    await haltedRun(w.files)
    await run($, '')
    // Before the band's first build, Home has nothing of the run (it reads no file).
    expect(w.hubs.at(-1)!.home!.needsYou).toEqual([])
    // The ui tick's first run, 2 s after session.start: the band's build, then the hub's write. The build checks
    // each ledger record's sha256, which resolves outside what the mock clock's advance waits for, so advance can
    // return mid-tick (and the ticks later advances fire are skipped, as a tick never overlaps one running). So
    // the test waits for the hub's write itself, never on more advances.
    await w.clock.advance(2_000)
    const hub = await w.hubWritten(h => (h.home?.needsYou.length ?? 0) > 0)
    expect(hub.home!.needsYou.map(r => [r.open, `${r.mark.glyph} ${r.mark.word}`, r.spans.map(s => s.text).join('')])).toEqual([[`home:open:runs:${RUN}`, '⚑ needs you', `execute ${RUN} · halted at G2 · 4m`]])
    expect(hub.live.map(s => s.text).join('')).toBe('nothing running · ⚑ needs you: 1 run')
    const ui = await mount($)
    const open = await ui.find({ type: 'Button', key: `home:open:runs:${RUN}` })
    expect(open?.props.variant).toBe('primary')
    const opens = w.opened.length
    expect(await ui.press({ key: `home:open:runs:${RUN}` })).toEqual({ element: `home:open:runs:${RUN}` })
    expect(await ui.find({ type: 'Text', text: ' · Runs' })).toBeDefined()
    // The board loaded on the run (the board's own drawing is WP-DC's to check).
    expect(w.boards.at(-1)?.run).toBe(RUN)
    expect(w.hubs.at(-1)!.section).toBe('runs')
    expect(w.opened).toHaveLength(opens)
    expect(w.toasts).toEqual([])
  })

  test("on a swarm: its builder, in the same pane; with no item, the section's own screen", async ($, on) => {
    const w = await holding($, on, BUSY)
    const ui = await mount($)
    expect(await ui.press({ key: 'home:open:swarms:review#2' })).toEqual({ element: 'home:open:swarms:review#2' })
    w.held.value = null
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: ' · Swarms' })).toBeDefined()
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toContain('swarm:builder:doctor:review')
    expect(w.hubs.at(-1)!.section).toBe('swarms')
    // Back to Home, then a section's [Open] with no item.
    await ui.press({ key: 'litter:section:home' })
    await ui.press({ key: 'home:open:doctor' })
    expect(await ui.find({ type: 'Text', text: ' · Doctor' })).toBeDefined()
    expect(w.toasts).toEqual([])
  })

  test("on a lead proposal its swarm no longer has (decided since Home was drawn): Swarms on the swarm, and a toast says so", async ($, on) => {
    // The landing on the proposal view itself, through a live swarm and J's ledger, is tier 2's (home.spec.ts).
    const w = await holding($, on, BUSY)
    const ui = await mount($)
    expect(await ui.find({ type: 'Button', key: 'home:open:swarms:review/6' })).toBeDefined()
    expect(await ui.press({ key: 'home:open:swarms:review/6' })).toEqual({ element: 'home:open:swarms:review/6' })
    expect(w.hubs.at(-1)!.section).toBe('swarms')
    expect(w.toasts).toEqual(["the lead's proposal 6 for review was decided already"])
  })

  test("on a run that's gone since Home was drawn: Runs, saying so, as `/litter runs <run>` does", async ($, on) => {
    const w = await holding($, on, { ...BUSY, ended: [endedRow('20261001-gone', DONE, 'v1 APPROVED', '2m')] })
    const ui = await mount($)
    expect(await ui.press({ key: 'home:open:runs:20261001-gone' })).toEqual({ element: 'home:open:runs:20261001-gone' })
    expect(w.hubs.at(-1)!.section).toBe('runs')
    // The board's own notice names the run (board/view.ts words it).
    expect(JSON.stringify(w.boards.at(-1))).toContain('20261001-gone')
    expect(w.toasts).toEqual([])
  })
})
