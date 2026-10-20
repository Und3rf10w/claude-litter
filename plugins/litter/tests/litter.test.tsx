// Tier 1 (phase 5b, WP-DA): the one `litter` pane as the engine runs and
// draws it. session.start registers `/litter` alone and the six old commands
// reach the engine unanswered; `/litter [section] [arg]` answers a line,
// opens `litter` asking for the keyboard and shows that section, and anything
// else is the usage line; the strip draws the shown section as text and the
// others as plain Buttons, with hotkeys 1–8 only while the pane is focused; a
// strip press, Home's [Open] and the builder's [Doctor] show their section in
// the same pane; a key of a section that isn't shown is ignored with a toast;
// and the pane draws in the dock and inline, wide and narrow, Home keeping to
// its rows. The router's and the tick's cases are tier 2's (hub.spec.ts).
// Home's own cases (WP-DB: what it says, its folds, its [Open] on an item)
// are tests/home.test.tsx's.

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const SESSION = 'tier1-litter'
const NOW = 1_800_000_000_000
/** The machine is busy: a test that runs several commands gets room. */
const SLOW = { timeoutMs: 30_000 }
const USAGE = 'usage: /litter [home | runs [run | execute | design] | swarms [name [node]] | rules | tasks [list] | agents [team] | stats | doctor [swarm]]'
const HINT = '[home | runs | swarms | rules | tasks | agents | stats | doctor] [arg]'
const OLD = ['litter-board', 'litter-rules', 'litter-swarm', 'litter-doctor', 'litter-tasks', 'litter-agents']
const STRIP = ['home', 'runs', 'swarms', 'rules', 'tasks', 'agents', 'stats', 'doctor'] as const

type Placement = 'dock' | 'inline'
const pane = (over: { isFocused?: boolean; bodyColumns?: number; bodyRows?: number; placement?: Placement } = {}) =>
  ({
    title: 'litter',
    isFocused: over.isFocused ?? false,
    bodyColumns: over.bodyColumns ?? 120,
    placement: over.placement ?? 'dock',
    scroll: { offset: 0, bodyRows: over.bodyRows ?? 60 },
    view: {},
  }) as const

const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const mount = <S extends 'terminal' | 'desktop' | 'vscode' | 'mobile'>($: Engine, surface: S, over: Parameters<typeof pane>[0] = {}) =>
  $.ui.mount({ plugin: 'litter', surface, component: 'Pane', requestId: 'litter', props: pane(over) })

type World = {
  commands: { name: string; argumentHint?: string; immediate?: boolean }[]
  opened: { id: string; focus: boolean }[]
  toasts: string[]
  /** While set, the `hub` atom reads as this view: a drawing made before the section moved. */
  held: { value: unknown }
}

/**
 * $.fs from a map and git as a plain checkout at /repo, so session.start
 * resolves the litter directory (phase5wiring.test.ts's world); what was
 * registered, opened and toasted; a command beneath the plugins that answers
 * `engine`; and `held`, which pins the `hub` atom's read.
 */
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
  const commands: World['commands'] = []
  on('command.register', async (_$, e) => {
    commands.push({ name: e.name, ...(e.argumentHint ? { argumentHint: e.argumentHint } : {}), ...(e.immediate ? { immediate: true } : {}) })
    return { value: { command: e.name } }
  })
  // Beneath the plugins: a command litter doesn't answer reaches this.
  on('command.run', async () => ({ text: 'engine' }))
  const opened: World['opened'] = []
  const open = new Set<string>()
  on('ui.open', async (_$, e) => {
    opened.push({ id: e.id, focus: e.focus === true })
    open.add(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', async () => ({ value: [...open].map(id => ({ id, title: id, isShown: true, isFocused: false, isPlaced: true })) }))
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', async () => ({ value: undefined }))
  const held: World['held'] = { value: null }
  on('state.get', async (_$, e, next) => (e.key === 'hub' && held.value !== null ? { value: { value: held.value, version: 1 } } : next(e)))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.cwd', async () => ({ value: '/repo' }))
  mock.store(on)
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/tier1' })
  return { commands, opened, toasts, held }
}

async function start($: Engine, on: On): Promise<World> {
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  return w
}

const LABEL: Record<(typeof STRIP)[number], string> = { home: 'Home', runs: 'Runs', swarms: 'Swarms', rules: 'Rules', tasks: 'Tasks', agents: 'Agents', stats: 'Stats', doctor: 'Doctor' }

describe('/litter, the one command', () => {
  test('session.start registers /litter alone, its sections as the hint', async ($, on) => {
    const w = await start($, on)
    expect(w.commands).toEqual([{ name: 'litter', argumentHint: HINT, immediate: true }])
  })

  test('the six old commands are gone: each reaches the engine beneath, and nothing opens', async ($, on) => {
    const w = await start($, on)
    for (const name of OLD) expect((await run($, name)).text).toBe('engine')
    expect(w.opened).toEqual([])
  })

  test('bare and with each section: a reply line, `litter` opened with the keyboard, and that section drawn', SLOW, async ($, on) => {
    const w = await start($, on)
    for (const [args, id] of [['', 'home'], ['runs', 'runs'], ['swarms', 'swarms'], ['rules', 'rules'], ['tasks', 'tasks'], ['agents', 'agents'], ['stats', 'stats'], ['doctor', 'doctor'], ['home', 'home']] as const) {
      const r = await run($, 'litter', args)
      expect({ args, line: r.text?.startsWith(`${LABEL[id]} `) }).toEqual({ args, line: true })
      expect(r.text?.startsWith('litter: ')).toBe(false)
      expect(w.opened.at(-1)).toEqual({ id: 'litter', focus: true })
      const ui = await mount($, 'terminal')
      expect(await ui.find({ type: 'Text', text: ` · ${LABEL[id]}` })).toBeDefined()
      await ui.unmount()
    }
    expect(new Set(w.opened.map(o => o.id))).toEqual(new Set(['litter']))
  })

  test('anything else is the one-line usage, and opens nothing', SLOW, async ($, on) => {
    const w = await start($, on)
    for (const args of ['board', 'nonsense', 'runs a b', 'rules extra', 'stats extra', 'home now']) expect((await run($, 'litter', args)).text).toBe(USAGE)
    expect(w.opened).toEqual([])
  })
})

describe('the strip and the keys line', () => {
  test('the shown section is text, the others plain Buttons keyed litter:section:<id>; no hotkeys while unfocused, and the keys line says how to give it the keys', async ($, on) => {
    await start($, on)
    await run($, 'litter', '')
    const ui = await mount($, 'terminal')
    const strip = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('litter:section:'))
    expect(strip.map(b => b.key)).toEqual(STRIP.filter(s => s !== 'home').map(s => `litter:section:${s}`))
    for (const b of strip) {
      expect(b.props.plain).toBe(true)
      expect(b.props.hotkey).toBeUndefined()
    }
    expect(await ui.find({ type: 'Text', text: '› Home' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ctrl+x tab' })).toBeDefined()
  })

  test('focused, each tab has its digit as a hotkey, the shown one says its digit, and the keys line lists the keys', async ($, on) => {
    await start($, on)
    await run($, 'litter', 'tasks')
    const ui = await mount($, 'terminal', { isFocused: true })
    const strip = (await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('litter:section:'))
    expect(strip.map(b => [b.key, b.props.hotkey])).toEqual(
      STRIP.map((s, i) => [`litter:section:${s}`, String(i + 1)] as const).filter(([k]) => k !== 'litter:section:tasks'),
    )
    expect(await ui.find({ type: 'Text', text: '› 5: Tasks' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1–8' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ctrl+x tab' })).toBeUndefined()
  })

  test('a strip press shows that section in the same pane, without opening it again', async ($, on) => {
    const w = await start($, on)
    await run($, 'litter', '')
    const opens = w.opened.length
    const ui = await mount($, 'terminal')
    expect(await ui.press({ key: 'litter:section:agents' })).toEqual({ element: 'litter:section:agents' })
    expect(await ui.find({ type: 'Text', text: ' · Agents' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'litter:section:home' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'litter:section:agents' })).toBeUndefined()
    expect(w.opened).toHaveLength(opens)
  })

  test('the keys line is the terminal\'s: the desktop draws none', async ($, on) => {
    await start($, on)
    await run($, 'litter', '')
    const ui = await mount($, 'desktop')
    expect(await ui.find({ type: 'Text', text: ' · Home' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'ctrl+x tab' })).toBeUndefined()
  })
})

describe('the openers in the pane', () => {
  test("Home's [Open] shows that section", async ($, on) => {
    await start($, on)
    await run($, 'litter', '')
    const ui = await mount($, 'terminal')
    // Nothing runs here, so Home's lines are Swarms' and Doctor's (WP-DB).
    expect(await ui.find({ type: 'Button', key: 'home:open:swarms' })).toBeDefined()
    expect(await ui.press({ key: 'home:open:swarms' })).toEqual({ element: 'home:open:swarms' })
    expect(await ui.find({ type: 'Text', text: ' · Swarms' })).toBeDefined()
  })

  test("the builder's [Doctor] shows Doctor on its swarm, asking for the keyboard", SLOW, async ($, on) => {
    const w = await start($, on)
    expect((await run($, 'litter', 'swarms trio')).text).toBe('Swarms shows the builder for trio')
    const ui = await mount($, 'terminal')
    expect((await ui.findAll({ type: 'Button' })).map(b => b.key)).toContain('swarm:builder:doctor:trio')
    expect(await ui.press({ key: 'swarm:builder:doctor:trio' })).toEqual({ element: 'swarm:builder:doctor:trio' })
    expect(w.opened.at(-1)).toEqual({ id: 'litter', focus: true })
    expect(await ui.find({ type: 'Text', text: ' · Doctor' })).toBeDefined()
  })
})

describe("a key of a section that isn't shown", () => {
  test('is ignored with a toast, answered in its shape, and acts on nothing', async ($, on) => {
    const w = await start($, on)
    await run($, 'litter', 'runs')
    // A drawing made while Home was shown (with an Agents line, WP-DB), pressed after the section moved to Runs.
    const home = { needsYou: [], running: [], ended: [], endedMinutes: 10, others: [{ open: 'home:open:agents', label: 'Agents', text: '1 running in this session' }] }
    w.held.value = { view: 'hub', v: 999, section: 'home', live: [], tabs: [], home }
    const ui = await mount($, 'terminal')
    expect(await ui.press({ key: 'home:open:agents' })).toEqual({ element: 'home:open:agents' })
    expect(w.toasts).toContain('that was on Home, and litter shows Runs now, so it was ignored')
    w.held.value = null
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: ' · Runs' })).toBeDefined()
  })
})

describe('inline and narrow', () => {
  for (const placement of ['dock', 'inline'] as const) {
    test(`at 40 columns and 12 rows, ${placement}: the header, the strip wrapped, and Home keeping to its rows`, async ($, on) => {
      await start($, on)
      await run($, 'litter', '')
      const ui = await mount($, 'terminal', { placement, bodyColumns: 40, bodyRows: 12 })
      expect(await ui.find({ type: 'Text', text: 'litter' })).toBeDefined()
      expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('litter:section:'))).toHaveLength(7)
      // 2 header rows, 2 strip rows, a gap and 2 keys rows leave 5 (WP-DB): the quiet line, the next step on two,
      // and the other sections folded into one line of their names (each line would take two rows, with its [Open]).
      expect(await ui.find({ type: 'Text', text: 'Nothing needs you, and nothing runs.' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Swarms, Doctor' })).toBeDefined()
      expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('home:open:'))).toHaveLength(0)
    })
  }

  test('wide, every line of Home is drawn, none folded', async ($, on) => {
    await start($, on)
    await run($, 'litter', '')
    const ui = await mount($, 'terminal', { bodyColumns: 140, bodyRows: 40 })
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.key?.startsWith('home:open:')).map(b => b.key)).toEqual(['home:open:swarms', 'home:open:doctor'])
    expect(await ui.find({ type: 'Text', text: 'Swarms, Doctor' })).toBeUndefined()
  })
})
