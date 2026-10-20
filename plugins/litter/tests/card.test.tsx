// Tier 1: the finished-run card as the engine draws it (WP-CC; COMMON
// decision 8). A task-notification row whose task has a card in the `cards`
// atom draws the card alone on every surface; expanded (ctrl+o, or verbose,
// where every row is: WP-CK), the card above the engine's own row, both
// whole; and the engine's row alone otherwise: a typed prompt, a task with no
// card, a card the render can't draw (its catch passes on). Then, end to
// end: a recorded run in a checkout at /repo, session.start's restore, the
// row drawn as its card, compact and expanded, and [Board] opening the board
// (Runs, in the one `litter` pane: WP-DA), the press answered `{ element }`.
// WP-DB: the card as card/view.ts builds it now (the title the run's line as
// the band and Home draw it; the recorded outcome, then the evidence), drawn
// at 100 and 60 columns with each row's colors beside it.

import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { CardsView } from '../types/index'
import { drawWithColors } from './drawing'

const SESSION = 'tier1-session'
const LITTER = '/repo/.claude/litter'
const RUN = '20261005-retry'
const NOW = 1_800_000_000_000
const ROW_SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const row = (over: Record<string, unknown> = {}) => ({ text: 'fix the parser', origin: { kind: 'composer' }, isExpanded: false, ...over }) as never
const NOTIFICATION = { text: 'Workflow "litter:execute-run" completed', origin: { kind: 'task-notification' }, task: { id: 'task-1', status: 'completed', durationMs: 840_000 } }

const NAME = 'cyan_FOR_SUBAGENTS_ONLY'
const SEP = { text: ' · ' }
const dimension = (word: string, pass: boolean) => ({ text: `${word} ${pass ? '✓' : '✕'}`, color: pass ? 'success' : 'error' })
const CARDS: CardsView = {
  view: 'cards',
  v: 1,
  byTask: {
    'task-1': {
      taskId: 'task-1',
      run: RUN,
      title: [{ text: '⚑ halted', color: 'warning', bold: true }, SEP, { text: 'litter', color: 'inactive' }, SEP, { text: 'execute ' }, { text: RUN, color: NAME }, SEP, { text: '14m 2s', color: 'inactive' }],
      lines: [
        [{ text: 'G2: out of attempts', color: 'warning' }],
        [{ text: 'G2, attempt 2: ' }, dimension('plan', true), { text: ' ' }, dimension('tests', false), { text: ' ' }, dimension('regressions', true), { text: ' ' }, dimension('rules', true)],
        [{ text: '1/3 gates landed · last land ' }, { text: '1111111', color: 'warning' }],
      ],
      buttons: [{ key: `card:board:${RUN}`, label: 'Board' }],
    },
  },
}
const CARD_LINES = [`⚑ halted · litter · execute ${RUN} · 14m 2s`, 'G2: out of attempts', 'G2, attempt 2: plan ✓ tests ✕ regressions ✓ rules ✓', '1/3 gates landed · last land 1111111']

/** The engine's own drawing of a row, beneath litter: its text, and a button of another plugin's. */
function rowBeneath(on: On, reached: string[]): void {
  on('ui.render', { component: 'UserMessage' }, async (hooks, e): Promise<RenderElement> => {
    const { Box, Text, Button } = hooks.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      children: [Text({ children: `engine: ${e.props.text}` }), Button({ key: 'other', label: 'Other', onPress: () => void reached.push('other') })],
    })
  })
}

/** The cards atom holds `view`. */
const cardsHeld = (on: On, view: unknown) => on('state.get', async (_$, e, next) => (e.key === 'cards' ? { value: { value: view, version: 1 } } : next(e)))

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
/** A drawn element's text, its children's joined. */
const shownText = (n: unknown): string =>
  typeof n === 'string' ? n : n !== null && typeof n === 'object' ? ((n as Node).children ?? []).map(shownText).join('') : ''

describe('the card in a row', () => {
  test('a notification row with a card draws the card in place of the engine’s, on every surface', async ($, on) => {
    mock.store(on)
    cardsHeld(on, CARDS)
    rowBeneath(on, [])
    for (const surface of ROW_SURFACES) {
      const ui = await $.ui.mount({ plugin: 'litter', surface, component: 'UserMessage', props: row(NOTIFICATION) })
      expect(await ui.find({ type: 'Text', text: /^⚑ halted · litter · execute 20261005-retry · 14m 2s$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^G2: out of attempts$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^G2, attempt 2: plan ✓ tests ✕ regressions ✓ rules ✓$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1\/3 gates landed · last land 1111111/ })).toBeDefined()
      expect((await ui.findAll({ type: 'Button' })).length).toBe(1)
      expect(await ui.find({ type: 'Text', text: /^engine:/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test("the same row expanded (ctrl+o, or verbose) draws the card above the engine's own row, both whole, on every surface", async ($, on) => {
    mock.store(on)
    cardsHeld(on, CARDS)
    const reached: string[] = []
    rowBeneath(on, reached)
    for (const surface of ROW_SURFACES) {
      const ui = await $.ui.mount({ plugin: 'litter', surface, component: 'UserMessage', props: row({ ...NOTIFICATION, isExpanded: true }) })
      const root = (await ui.drawn()) as unknown as Node
      expect(root.type).toBe('Box')
      expect(root.props?.flexDirection).toBe('column')
      expect(root.children).toHaveLength(2)
      const [card, engine] = root.children as Node[]
      // The card first: its title, its three lines and [Board]; then the engine's row with its own button.
      expect((card!.children as Node[]).slice(0, 4).map(shownText)).toEqual(CARD_LINES)
      expect(card!.children).toHaveLength(5)
      expect(shownText(engine)).toBe(`engine: ${NOTIFICATION.text}`)
      expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['Board', 'Other'])
      expect(await ui.press({ key: 'other', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'other' }))
      await ui.unmount()
    }
    expect(reached).toEqual(ROW_SURFACES.map(() => 'other'))
  })

  test("a typed prompt, and a task with no card, compact or expanded, are the engine's", async ($, on) => {
    mock.store(on)
    cardsHeld(on, CARDS)
    rowBeneath(on, [])
    const rows = [
      [row(), 'engine: fix the parser'],
      [row({ isExpanded: true }), 'engine: fix the parser'],
      [row({ ...NOTIFICATION, task: { id: 'b-shell-7', status: 'completed' } }), `engine: ${NOTIFICATION.text}`],
      [row({ ...NOTIFICATION, isExpanded: true, task: { id: 'b-shell-7', status: 'completed' } }), `engine: ${NOTIFICATION.text}`],
    ] as const
    for (const surface of ROW_SURFACES) {
      for (const [props, text] of rows) {
        const ui = await $.ui.mount({ plugin: 'litter', surface, component: 'UserMessage', props })
        expect((await ui.find({ type: 'Text', text }))?.text).toBe(text)
        expect(await ui.find({ type: 'Text', text: /litter · execute/ })).toBeUndefined()
        await ui.unmount()
      }
    }
  })

  test("a card the render can't draw is the engine's row: its catch passes on", async ($, on) => {
    mock.store(on)
    cardsHeld(on, { view: 'cards', v: 1, byTask: { 'task-1': { taskId: 'task-1', run: RUN, title: 'not spans', lines: [], buttons: [] } } })
    rowBeneath(on, [])
    const ui = await $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'UserMessage', props: row(NOTIFICATION) })
    expect((await ui.find({ type: 'Text', text: `engine: ${NOTIFICATION.text}` }))?.text).toBe(`engine: ${NOTIFICATION.text}`)
  })

  test("[Board] for a run that isn't there is answered { element } with a toast; another plugin's key passes on", async ($, on) => {
    mock.store(on)
    on('session.id', async () => ({ value: SESSION }))
    const toasts: string[] = []
    on('ui.toast', async (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    const opened: string[] = []
    on('ui.open', async (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    const reached: string[] = []
    // The card drawn by a plugin beneath, so the row holds both buttons whatever litter draws.
    on('ui.render', { component: 'UserMessage' }, async (hooks, e): Promise<RenderElement> => {
      const { Box, Button } = hooks.ui.resolve(e)
      return Box({
        children: [
          Button({ key: `card:board:${RUN}`, label: 'Board', onPress: () => void reached.push('card') }),
          Button({ key: 'other', label: 'Other', onPress: () => void reached.push('other') }),
        ],
      })
    })
    const ui = await $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'UserMessage', props: row(NOTIFICATION) })
    expect(await ui.press({ key: `card:board:${RUN}`, plugin: 'test' })).toEqual(expect.objectContaining({ element: `card:board:${RUN}` }))
    // No session.start resolved a litter directory: the run is gone as far as this session can tell.
    expect(toasts).toEqual([`run ${RUN} is gone (its run.json isn't there), so there's no board to open`])
    expect(opened).toEqual([])
    expect(await ui.press({ key: 'other', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'other' }))
    expect(reached).toEqual(['other'])
  })
})

// ---------------------------------------------------------------------------
// End to end

const hex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/** A run's ledger, as ledgercore writes it: one file per record, each chained to the sha256 of the one before. Its head, as appendRecord leaves it. */
async function ledger(files: Map<string, string>, run: string, records: { kind: string; body: Record<string, unknown> }[]): Promise<{ seq: number; sha: string }> {
  let prev: string | null = null
  for (const [i, r] of records.entries()) {
    const seq = i + 1
    const text = `${JSON.stringify({ v: 1, seq, kind: r.kind, run, at: NOW + seq * 60_000, by: { source: 'mod' }, prev, body: r.body })}\n`
    files.set(`${LITTER}/${run}/ledger/${String(seq).padStart(6, '0')}-${r.kind}.json`, text)
    prev = await sha256(text)
  }
  return { seq: records.length, sha: prev ?? '' }
}

/** $.fs from a map and git as a plain checkout at /repo answers it (phase3wiring.test.ts's world); what opened and what was written. */
function world(on: On): { files: Map<string, string>; opened: string[]; cardsWritten: unknown[] } {
  const files = new Map<string, string>()
  const opened: string[] = []
  const cardsWritten: unknown[] = []
  on('state.set', async (_$, e, next) => {
    if (e.key === 'cards') cardsWritten.push(e.value)
    return next(e)
  })
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
    const a = [...e.argv]
    if (a[0] === 'mv') {
      const [from, to] = a.slice(-2) as [string, string]
      files.set(to, files.get(from) ?? '')
      files.delete(from)
      return ran(0)
    }
    if (a[0] === 'rm') {
      const path = a[a.length - 1]!
      for (const k of [...files.keys()]) if (k === path || k.startsWith(`${path}/`)) files.delete(k)
      return ran(0)
    }
    if (a[0] === 'git' && a.includes('rev-parse')) {
      if (a.includes('--show-toplevel') && !a.includes('--git-dir')) return ran(0, '/repo\n')
      if (a.includes('--git-dir') && a.includes('--git-common-dir')) return ran(0, '/repo/.git\n/repo/.git\n')
    }
    return ran(1)
  })
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('agent.list', async () => ({ value: [] }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.open', async (_$, e) => {
    // The pane's id, and whether the open asked for the keyboard.
    opened.push(e.focus ? `${e.id} (focus)` : e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.cwd', async () => ({ value: '/repo' }))
  mock.env(on, { HOME: '/home/tier1' })
  return { files, opened, cardsWritten }
}

async function recordRun(files: Map<string, string>, ended = true): Promise<{ seq: number; sha: string }> {
  const base = 'a'.repeat(40)
  files.set(
    `${LITTER}/${RUN}/run.json`,
    `${JSON.stringify({
      v: 1,
      run: RUN,
      workflow: 'execute',
      args: { gates: [{ id: 'G1', title: 'Parse the header' }, { id: 'G2', title: 'Retry the refresh once' }] },
      authorized: [],
      mode: 'default',
      verify: ['bun', 'test'],
      goalCheck: null,
      setup: null,
      linkDirs: [],
      base,
      ref: `refs/heads/litter/${RUN}`,
      checkout: '/repo',
      isolate: false,
      previousBranch: 'main',
      continueOf: null,
      amendOf: null,
      rules: [],
      planPath: null,
      planSha256: null,
      session: SESSION,
      created: NOW,
    })}\n`,
  )
  return ledger(files, RUN, [
    { kind: 'run.start', body: { workflow: 'execute', base, ref: `refs/heads/litter/${RUN}`, checkout: '/repo', oid: 'd'.repeat(40), session: SESSION } },
    { kind: 'run.launch', body: { taskId: 'task-1', runId: 'wf_task1', scriptPath: null, generation: 1, session: SESSION, oid: 'd'.repeat(40) } },
    { kind: 'land', body: { gate: 'G1', verify_id: 'v1', commit: '1'.repeat(40), tree: 'c'.repeat(40), old: base, ref: `refs/heads/litter/${RUN}` } },
    { kind: 'land', body: { gate: 'G2', verify_id: 'v2', commit: '2'.repeat(40), tree: 'c'.repeat(40), old: base, ref: `refs/heads/litter/${RUN}` } },
    ...(ended ? [{ kind: 'run.end', body: { taskId: 'task-1', generation: 1, status: 'done', reason: null, source: 'notification' } }] : []),
  ])
}

describe('a recorded run, end to end', () => {
  test("session.start restores its card, the row draws it, and [Board] opens the board on the run, answered { element }", async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: NOW + 10 * 60_000 })
    const { files, opened, cardsWritten } = world(on)
    // The engine's row beneath, which only the expanded row below draws.
    rowBeneath(on, [])
    await recordRun(files)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    expect(cardsWritten).toHaveLength(1)
    expect(Object.keys((cardsWritten[0] as CardsView).byTask)).toEqual(['task-1'])

    const ui = await $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'UserMessage', props: row(NOTIFICATION) })
    expect(await ui.find({ type: 'Text', text: `✓ done · litter · execute ${RUN} · 3m 0s` })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '2/2 gates landed · last land 2222222' })).toBeDefined()
    expect(await ui.press({ key: `card:board:${RUN}`, plugin: 'litter' })).toEqual(expect.objectContaining({ element: `card:board:${RUN}` }))
    // [Board] opens the one `litter` pane on Runs, with the keyboard: the person pressed it.
    expect(opened).toEqual(['litter (focus)'])
    await ui.unmount()

    // Under verbose every row is expanded: the card is still drawn, above the engine's own row.
    const verbose = await $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'UserMessage', props: row({ ...NOTIFICATION, isExpanded: true }) })
    expect(await verbose.find({ type: 'Text', text: `✓ done · litter · execute ${RUN} · 3m 0s` })).toBeDefined()
    expect(await verbose.find({ type: 'Text', text: `engine: ${NOTIFICATION.text}` })).toBeDefined()
  })

  test("a run still open at session.start gets its card at its notification's prompt.submit, and the row draws it", async ($, on) => {
    // The store in memory, as mock.store keeps it, so the test can move the ledger's head as the mod's append would.
    const store = new Map<string, unknown>()
    on('store.get', async (_$, e) => ({ value: store.get(e.key) }))
    on('store.set', async (_$, e) => {
      store.set(e.key, e.value === undefined ? undefined : JSON.parse(JSON.stringify(e.value)))
      return { value: undefined }
    })
    on('store.delete', async (_$, e) => {
      store.delete(e.key)
      return { value: undefined }
    })
    on('store.keys', async () => ({ value: [...store.keys()] }))
    mock.clock(on, { now: NOW + 10 * 60_000 })
    const { files, cardsWritten } = world(on)
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    rowBeneath(on, [])
    await recordRun(files, false)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    expect(cardsWritten).toEqual([])
    const before = await $.ui.mount({ plugin: 'litter', surface: 'desktop', component: 'UserMessage', props: row(NOTIFICATION) })
    expect(await before.find({ type: 'Text', text: /litter · execute/ })).toBeUndefined()
    expect(await before.find({ type: 'Text', text: `engine: ${NOTIFICATION.text}` })).toBeDefined()
    await before.unmount()

    // The end lands (here written as the notification's settle would have written it, the head moved with it), then the notification is submitted.
    store.set(`litter.head.${LITTER}/${RUN}`, await recordRun(files, true))
    const text = '<task-notification>\n<task-id>task-1</task-id>\n<status>completed</status>\n<summary>Dynamic workflow "litter:execute-run" completed</summary>\n</task-notification>'
    await $.prompt.submit({ text, origin: { kind: 'task-notification' }, wait: false })
    expect(cardsWritten).toHaveLength(1)
    const ui = await $.ui.mount({ plugin: 'litter', surface: 'desktop', component: 'UserMessage', props: row(NOTIFICATION) })
    expect(await ui.find({ type: 'Text', text: `✓ done · litter · execute ${RUN} · 3m 0s` })).toBeDefined()
  })
})

/** Rows of a drawing with the colors beside each, as drawWithColors writes them. */
const golden = (columns: number, rows: readonly (readonly [string, string])[]): string[] => rows.map(([text, colors]) => `${text.padEnd(columns)}  | ${colors}`)

/**
 * The cards in WP-DB's report, the same at 100 and 60 columns: the title is
 * the run's line (the mark and its word bold in the state's color, `litter`
 * and the time muted, the run in the name color), then the recorded
 * outcome, then the evidence (the gate's dimensions, ✓ done's color and ✕
 * failed's; the last land's commit in the sha color), then [Board].
 */
const HALTED_DRAWN: [string, string][] = [
  [`⚑ halted · litter · execute ${RUN} · 14m 2s`, `warning bold, default, inactive, default, ${NAME}, default, inactive`],
  ['G2: out of attempts', 'warning'],
  ['G2, attempt 2: plan ✓ tests ✕ regressions ✓ rules ✓', 'default, success, error, success'],
  ['1/3 gates landed · last land 1111111', 'default, warning'],
  ['[ Board ]', 'default'],
]
const DONE_DRAWN: [string, string][] = [
  [`✓ done · litter · execute ${RUN} · 3m 0s`, `success bold, default, inactive, default, ${NAME}, default, inactive`],
  ['2/2 gates landed · last land 2222222', 'default, warning'],
  ['[ Board ]', 'default'],
]

describe('the drawings', () => {
  for (const columns of [100, 60]) {
    test(`a halted run's card, at ${columns} columns`, async ($, on) => {
      mock.store(on)
      cardsHeld(on, CARDS)
      rowBeneath(on, [])
      const ui = await $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'UserMessage', props: row(NOTIFICATION) })
      expect(drawWithColors(await ui.drawn(), columns)).toEqual(golden(columns, HALTED_DRAWN))
    })

    test(`a done run's card from its ledger, at ${columns} columns`, async ($, on) => {
      mock.store(on)
      mock.clock(on, { now: NOW + 10 * 60_000 })
      const { files } = world(on)
      rowBeneath(on, [])
      await recordRun(files)
      await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
      const done = await $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'UserMessage', props: row(NOTIFICATION) })
      expect(drawWithColors(await done.drawn(), columns)).toEqual(golden(columns, DONE_DRAWN))
    })
  }
})
