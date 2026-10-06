// Tier 1: phase 5's wiring in register.tsx and clear.ts (WP-CA), with the
// engine loading the mod and every phase 5 module still CA's stub. Each new
// hook is reached under its matcher and keeps today's drawing and answers:
// the band draws what the plugins beneath draw, every transcript row is the
// engine's, the two panes draw their "nothing yet" trees, every press passes
// on; /litter-tasks and /litter-agents are registered at session.start and
// after a /clear and answer their stub lines; and each new catch answers in
// its event's shape. A hook is made to throw as phase3wiring.test.ts does: a
// render through an atom it can't read or draw, every other hook through
// `rebound` after a /clear whose new session id can't be read.

import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const SESSION = 'tier1-session'
const NO_SESSION = 'the session id is unavailable'
/** Where the band and a Client are drawn; a transcript row is drawn everywhere. */
const BAND_SURFACES = ['terminal', 'desktop'] as const
const ROW_SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 95, scroll: { offset: 0, bodyRows: 9 }, view: {} } as const

const pane = (title: string) =>
  ({ title, isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }) as const

/** A user-role row: the person's prompt unless `over` says otherwise. */
const row = (over: Record<string, unknown> = {}) =>
  ({ text: 'fix the parser', origin: { kind: 'composer' }, isExpanded: false, ...over }) as never

/** A litter run's finished notification row, as the engine draws it for task-1. */
const NOTIFICATION = { text: 'Workflow "execute" completed', origin: { kind: 'task-notification' }, task: { id: 'task-1', status: 'completed', durationMs: 840_000 } }

const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

/**
 * $.fs and $.process.run for a plain checkout at /repo (phase3wiring.test.ts's
 * world), so session.start resolves the litter directory; the commands
 * registered, in order, and the debug lines.
 */
function world(on: On): { commands: { name: string; argumentHint?: string; immediate?: boolean }[]; logs: string[] } {
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
    if (argv[0] === 'mv') {
      const [from, to] = argv.slice(-2) as [string, string]
      files.set(to, files.get(from) ?? '')
      files.delete(from)
      return ran(0)
    }
    if (argv[0] === 'rm') {
      const path = argv[argv.length - 1]!
      for (const k of [...files.keys()]) if (k === path || k.startsWith(`${path}/`)) files.delete(k)
      return ran(0)
    }
    if (argv[0] === 'git' && argv.includes('rev-parse')) {
      if (argv.includes('--show-toplevel') && !argv.includes('--git-dir')) return ran(0, '/repo\n')
      if (argv.includes('--git-dir') && argv.includes('--git-common-dir')) return ran(0, '/repo/.git\n/repo/.git\n')
    }
    return ran(1)
  })
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('agent.list', async () => ({ value: [] }))
  const commands: { name: string; argumentHint?: string; immediate?: boolean }[] = []
  on('command.register', async (_$, e) => {
    commands.push({ name: e.name, ...(e.argumentHint ? { argumentHint: e.argumentHint } : {}), ...(e.immediate ? { immediate: true } : {}) })
    return { value: { command: e.name } }
  })
  const logs: string[] = []
  on('ui.log', async (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('session.cwd', async () => ({ value: '/repo' }))
  mock.env(on, {})
  return { commands, logs }
}

/** The mod's $.state reads and writes, by key, as they happen. */
function stateSeen(on: On): { reads: string[]; writes: string[] } {
  const seen = { reads: [] as string[], writes: [] as string[] }
  on('state.get', async (_$, e, next) => {
    seen.reads.push(e.key)
    return next(e)
  })
  on('state.set', async (_$, e, next) => {
    seen.writes.push(e.key)
    return next(e)
  })
  return seen
}

/** session.id answers `sid.value`, or throws once `sid.value` is null. */
function sessionId(on: On, sid: { value: string | null }): { calls: number } {
  const seen = { calls: 0 }
  on('session.id', async () => {
    seen.calls++
    if (sid.value === null) throw new Error(NO_SESSION)
    return { value: sid.value }
  })
  return seen
}

/** The engine's clear as the mod sees it: session.end `clear` for the session that ends. */
const clearEnds = ($: Engine, from: string) => $.session.end({ reason: 'clear', sessionId: from, resume: { id: from } })

/** A /clear whose new session id can't be read: every hook's `rebound` throws from here on. */
async function breakRebound($: Engine, sid: { value: string | null }): Promise<void> {
  await clearEnds($, SESSION)
  sid.value = null
}

const PHASE5 = [
  { name: 'litter-tasks', argumentHint: '[list]', immediate: true },
  { name: 'litter-agents', argumentHint: '[team]', immediate: true },
]

describe('/litter-tasks and /litter-agents', () => {
  test('are registered at session.start, after the board and rules commands, and again after a /clear', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1_800_000_000_000 })
    const { commands } = world(on)
    const sid = { value: SESSION as string | null }
    sessionId(on, sid)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    expect(commands.map(c => c.name)).toEqual(['litter-swarm', 'litter-doctor', 'litter-board', 'litter-rules', 'litter-tasks', 'litter-agents'])
    expect(commands.slice(4)).toEqual(PHASE5)

    // The engine's clear, then a new id; the first hook after it rebinds, which registers every command again.
    await clearEnds($, SESSION)
    sid.value = 'tier1-after-clear'
    const before = commands.length
    await run($, 'litter-agents')
    expect(commands.slice(before).filter(c => c.name === 'litter-tasks' || c.name === 'litter-agents')).toEqual(PHASE5)
  })

  // Both commands are built: tests/tasks.test.tsx (WP-CE) and tests/agents.test.tsx (WP-CG) run them.

  test('their catches answer a line naming the command', async ($, on) => {
    mock.store(on)
    on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
    on('ui.log', async () => ({ value: undefined }))
    const sid = { value: SESSION as string | null }
    const ids = sessionId(on, sid)
    await breakRebound($, sid)
    expect(await run($, 'litter-tasks')).toEqual(expect.objectContaining({ text: expect.stringMatching(/^litter: \/litter-tasks failed \(.*session\.id.*\)$/) }))
    expect(await run($, 'litter-agents')).toEqual(expect.objectContaining({ text: expect.stringMatching(/^litter: \/litter-agents failed \(.*session\.id.*\)$/) }))
    expect(ids.calls).toBeGreaterThanOrEqual(2)
  })
})

/** The plugins beneath litter draw this in the band: a line and two buttons, one keyed as litter's would be. */
function bandBeneath(on: On, reached: string[]): void {
  on('ui.render', { component: 'AbovePrompt' }, async (hooks, e): Promise<RenderElement> => {
    const { Box, Text, Button } = hooks.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      children: [
        Text({ children: 'drawn beneath litter' }),
        Button({ key: 'band:board:20261005-retry', label: 'Board', onPress: () => void reached.push('band:board') }),
        Button({ key: 'other', label: 'Other', onPress: () => void reached.push('other') }),
      ],
    })
  })
}

describe('the band, with the stub', () => {
  test('its render reads the band atom and draws what the plugins beneath draw, on the terminal and the desktop', async ($, on) => {
    mock.store(on)
    const seen = stateSeen(on)
    bandBeneath(on, [])
    for (const surface of BAND_SURFACES) {
      const ui = await $.ui.mount({ plugin: 'litter', surface, component: 'AbovePrompt', props: BAND })
      expect((await ui.find({ type: 'Text', text: 'drawn beneath litter' }))?.text).toBe('drawn beneath litter')
      expect(await ui.findAll({ type: 'Button' })).toHaveLength(2)
      await ui.unmount()
    }
    expect(seen.reads).toContain('band')
    expect(seen.writes).toEqual([])
  })

  // WP-CB dropped "a view with rows in the atom still draws only what's beneath: the stub shows no band":
  // the band now draws that view's rows over what's beneath (tests/band.test.tsx).

  // Whether the read rejects (the catch passes on) or the engine skips the throwing hook (no view,
  // the render passes on), what's beneath is drawn. With the stub nothing else can throw, so the
  // catch's own case is CB's to add, through a view its render can't draw.
  test("a band atom that can't be read still draws what the plugins beneath draw", async ($, on) => {
    mock.store(on)
    let refused = 0
    on('state.get', async (_$, e, next) => {
      if (e.key !== 'band') return next(e)
      refused++
      throw new Error('the band atom is unreadable')
    })
    bandBeneath(on, [])
    for (const surface of BAND_SURFACES) {
      const ui = await $.ui.mount({ plugin: 'litter', surface, component: 'AbovePrompt', props: BAND })
      expect((await ui.find({ type: 'Text', text: 'drawn beneath litter' }))?.text).toBe('drawn beneath litter')
    }
    expect(refused).toBeGreaterThanOrEqual(2)
  })

  test("a press in the band, litter's key or another's, passes on; after a broken rebind its catch passes on too", async ($, on) => {
    mock.store(on)
    on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
    const reached: string[] = []
    bandBeneath(on, reached)
    const sid = { value: SESSION as string | null }
    const ids = sessionId(on, sid)
    const ui = await $.ui.mount({ plugin: 'litter', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    expect(await ui.press({ key: 'band:board:20261005-retry', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'band:board:20261005-retry' }))
    expect(await ui.press({ key: 'other', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'other' }))
    expect(reached).toEqual(['band:board', 'other'])

    await breakRebound($, sid)
    const before = ids.calls
    expect(await ui.press({ key: 'band:board:20261005-retry', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'band:board:20261005-retry' }))
    expect(reached).toEqual(['band:board', 'other', 'band:board'])
    // The mod's press hook reached `rebound`, which threw.
    expect(ids.calls - before).toBeGreaterThanOrEqual(1)
  })
})

/** The engine's own drawing of a row, as the plugins beneath would leave it: its text, a button keyed as litter's would be, and another's. */
function rowBeneath(on: On, reached: string[]): void {
  on('ui.render', { component: 'UserMessage' }, async (hooks, e): Promise<RenderElement> => {
    const { Box, Text, Button } = hooks.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      children: [
        Text({ children: `engine: ${e.props.text}${e.props.isExpanded ? ' (expanded)' : ''}` }),
        Button({ key: 'card:board:20261005-retry', label: 'Board', onPress: () => void reached.push('card:board') }),
        Button({ key: 'other', label: 'Other', onPress: () => void reached.push('other') }),
      ],
    })
  })
}

describe('the finished-run card, with no card built', () => {
  test("a prompt row, a task notification row and an expanded one are each the engine's, on every surface", async ($, on) => {
    mock.store(on)
    const seen = stateSeen(on)
    rowBeneath(on, [])
    const rows = [
      [row(), 'engine: fix the parser'],
      [row(NOTIFICATION), 'engine: Workflow "execute" completed'],
      [row({ ...NOTIFICATION, isExpanded: true }), 'engine: Workflow "execute" completed (expanded)'],
    ] as const
    for (const surface of ROW_SURFACES) {
      for (const [props, text] of rows) {
        const ui = await $.ui.mount({ plugin: 'litter', surface, component: 'UserMessage', props })
        expect((await ui.find({ type: 'Text', text }))?.text).toBe(text)
        await ui.unmount()
      }
    }
    // With no card in the atom, the notification row reads it and draws the engine's; nothing is written.
    expect(seen.writes).toEqual([])
  })

  test('a press in a row passes on; after a broken rebind its catch passes on too', async ($, on) => {
    mock.store(on)
    on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
    const reached: string[] = []
    rowBeneath(on, reached)
    const sid = { value: SESSION as string | null }
    const ids = sessionId(on, sid)
    const ui = await $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'UserMessage', props: row(NOTIFICATION) })
    expect(await ui.press({ key: 'other', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'other' }))
    expect(reached).toEqual(['other'])

    await breakRebound($, sid)
    const before = ids.calls
    expect(await ui.press({ key: 'card:board:20261005-retry', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'card:board:20261005-retry' }))
    expect(reached).toEqual(['other', 'card:board'])
    expect(ids.calls - before).toBeGreaterThanOrEqual(1)
  })

  test("prompt.submit settles a notification, then the cards' step, and passes the prompt on", async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1_800_000_000_000 })
    world(on)
    sessionId(on, { value: SESSION })
    const seen: string[] = []
    on('prompt.submit', async (_$, e) => {
      seen.push(e.text)
      return { text: e.text }
    })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const text = '<task-notification>\n<task-id>task-9</task-id>\n<status>completed</status>\n</task-notification>'
    await $.prompt.submit({ text, origin: { kind: 'task-notification' }, wait: false })
    expect(seen).toEqual([text])
  })
})

const PANES = [
  ['litter-tasks', 'tasksPane', 'tasks', 'litter · tasks', 'nothing to show yet: /litter-tasks opens a task list'],
  ['litter-agents', 'agentsPane', 'agents', 'litter · agents', "nothing to show yet: /litter-agents opens this session's agents"],
] as const

describe('the tasks and agents panes, with the stubs', () => {
  for (const [requestId, atom, view, title, empty] of PANES) {
    test(`${requestId}: draws its "nothing yet" tree with no view, and a body's header with one, on the terminal and the desktop`, async ($, on) => {
      mock.store(on)
      let held: unknown = null
      on('state.get', async (_$, e, next) => (e.key === atom && held !== null ? { value: { value: held, version: 1 } } : next(e)))
      for (const surface of ['terminal', 'desktop'] as const) {
        held = null
        const blank = await $.ui.mount({ plugin: 'litter', surface, component: 'Pane', requestId, props: pane(requestId) })
        expect((await blank.find({ type: 'Text', text: title }))?.text).toBe(title)
        expect((await blank.find({ type: 'Text', text: empty }))?.text).toBe(empty)
        await blank.unmount()
        held = { view, v: 1, body: { title: [{ text: `${title} · built`, bold: true }], notice: { level: 'info', text: 'a notice' } } }
        const built = await $.ui.mount({ plugin: 'litter', surface, component: 'Pane', requestId, props: pane(requestId) })
        expect((await built.find({ type: 'Text', text: `${title} · built` }))?.text).toBe(`${title} · built`)
        expect(await built.find({ type: 'Text', text: /a notice/ })).toBeDefined()
        await built.unmount()
      }
    })

    test(`${requestId}: ui.render's catch passes on, then ui.press, ui.input and ui.select pass on`, async ($, on) => {
      mock.store(on)
      // The pane's atom holds a body whose title isn't spans: the stub's render throws on it, and its catch passes the render on.
      on('state.get', async (_$, e, next) => (e.key === atom ? { value: { value: { view, v: 1, body: { title: 'not spans' } }, version: 1 } } : next(e)))
      on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
      const reached: string[] = []
      on('ui.render', { component: 'Pane', requestId }, async (hooks, e): Promise<RenderElement> => {
        const el = hooks.ui.resolve(e)
        const { Box, Text, Button } = el
        const children: RenderElement[] = [
          Text({ children: 'drawn below the mod' }),
          Button({ key: 'probe', label: 'Probe', onPress: () => void reached.push('press') }),
        ]
        if ('Input' in el && 'Select' in el) {
          children.push(el.Input({ key: 'probe-in', label: 'In', onSubmit: v => void reached.push(`input ${v}`) }))
          children.push(
            el.Select({
              key: 'probe-sel',
              label: 'Pick',
              options: [
                { value: 'a', label: 'A' },
                { value: 'b', label: 'B' },
              ],
              value: 'a',
              onSelect: v => void reached.push(`select ${v}`),
            }),
          )
        }
        return Box({ flexDirection: 'column', children })
      })
      const sid = { value: SESSION as string | null }
      const ids = sessionId(on, sid)

      const ui = await $.ui.mount({ plugin: 'litter', surface: 'desktop', component: 'Pane', requestId, props: pane(requestId) })
      expect((await ui.find({ type: 'Text', text: 'drawn below the mod' }))?.text).toBe('drawn below the mod')
      // With the rebind sound, each event's stub passes on.
      expect(await ui.press({ key: 'probe', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'probe' }))

      await breakRebound($, sid)
      const before = ids.calls
      expect(await ui.press({ key: 'probe', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'probe' }))
      expect(await ui.input({ key: 'probe-in', text: 'typed', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'probe-in', value: 'typed' }))
      expect(await ui.select({ key: 'probe-sel', value: 'b', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'probe-sel', value: 'b' }))
      expect(reached).toEqual(['press', 'press', 'input typed', 'select b'])
      // Each of the three hooks reached `rebound`, which threw.
      expect(ids.calls - before).toBeGreaterThanOrEqual(3)
    })
  }
})
