// Tier 2 (phase 5b, WP-DA): the `litter` pane's hub (hooks/ui/hub.ts) and
// the chrome's pure layout (hooks/ui/chrome.tsx). The sections are stood in
// for through `sections` and the reads through `deps`, so each check sees
// only the hub: the one opener, `/litter`'s parse, the key rule and the
// router, the tick's gate, the strip's counts, and the row budget at a wide
// and a narrow size.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Ports } from '../../hooks/ports'
import type { PaneUiHandlers } from '../../hooks/hooktypes'
import type { HubSection, HubView } from '../../types/index'
import {
  LABEL,
  SECTIONS,
  USAGE,
  deps,
  focusedElement,
  listOffset,
  litterCommand,
  litterShows,
  litterTick,
  liveOf,
  moveList,
  onLitterUi,
  openSection,
  ownerOf,
  refreshHub,
  resetHubForTests,
  sections,
  shownSection,
  tabsOf,
  type HubCounts,
  type Section,
  type SectionArg,
} from '../../hooks/ui/hub'
import { packItems, packWidths, plan, planColumns, stripKey, stripWidths, WIDE_COLUMNS } from '../../hooks/ui/chrome'
import { registerLitterCommand } from '../../hooks/uicommands'
import { nodePorts, type TestPorts } from './support/node-ports'

let p: TestPorts
/** What the stand-in sections were asked to do, in order. */
let calls: string[]

const passed = {}

/** A stand-in section: it records each call, answers a load with its label, and passes on a key it doesn't own. */
function standIn(id: HubSection, owns: (key: string) => boolean): Section {
  const ui: PaneUiHandlers = {
    message: async (q, e, next) => {
      calls.push(`${id}.message ${e.element}`)
      return owns(e.element) ? {} : next(e)
    },
    press: async (q, e, next) => {
      calls.push(`${id}.press ${e.element}`)
      return owns(e.element) ? { element: e.element } : next(e)
    },
    input: async (q, e, next) => {
      calls.push(`${id}.input ${e.element}`)
      return owns(e.element) ? { element: e.element, value: e.value } : next(e)
    },
    select: async (q, e, next) => {
      calls.push(`${id}.select ${e.element}`)
      return owns(e.element) ? { element: e.element, value: e.value } : next(e)
    },
    // WP-DA2: a focus always lands (passed on); Swarms takes every wheel tick (its list), the others pass them on.
    focus: async (q, e, next) => {
      calls.push(`${id}.focus ${e.element ?? '(engine)'}`)
      return next(e)
    },
    scroll: async (q, e, next) => {
      calls.push(`${id}.scroll ${e.by}`)
      return id === 'swarms' ? {} : next(e)
    },
  }
  return {
    owns,
    load: async (q: Ports, arg: SectionArg) => {
      calls.push(`${id}.load ${JSON.stringify(arg)}`)
      return typeof arg === 'string' && arg === 'bad' ? { text: `${id} refused bad`, refused: true } : { text: `${LABEL[id]} shows ${JSON.stringify(arg)}` }
    },
    resume: async () => void calls.push(`${id}.resume`),
    ui,
    tick: async () => void calls.push(`${id}.tick`),
  }
}

const press = (element: string) => onLitterUi.press(p, { plugin: 'litter', element, component: 'Pane', requestId: 'litter', surface: 'terminal' } as never, (async (e: { element: string }) => ({ element: `next ${e.element}` })) as never)
const input = (element: string, value: string) =>
  onLitterUi.input(p, { plugin: 'litter', element, value, kind: 'submit', component: 'Pane', requestId: 'litter', surface: 'terminal' } as never, (async (e: { element: string; value: string }) => ({ element: `next ${e.element}`, value: e.value })) as never)
const select = (element: string, value: string) =>
  onLitterUi.select(p, { plugin: 'litter', element, value, component: 'Pane', requestId: 'litter', surface: 'terminal' } as never, (async (e: { element: string; value: string }) => ({ element: `next ${e.element}`, value: e.value })) as never)
const message = (element: string) =>
  onLitterUi.message(p, { plugin: 'litter', element, data: {}, component: 'Pane', requestId: 'litter', surface: 'terminal' } as never, (async () => passed) as never)
const run = (args: string) => litterCommand(p, { command: 'litter', args } as never, (async () => ({ text: 'next' })) as never)
/** A Client's post with its data. */
const post = (element: string, data: unknown) =>
  onLitterUi.message(p, { plugin: 'litter', element, data, component: 'Pane', requestId: 'litter', surface: 'terminal' } as never, (async () => passed) as never)
/** The ring moving onto `element` (none: an engine stop); beneath, the core lands it, or answers `deny`. */
const focusOn = (element: string | undefined, deny?: string) =>
  onLitterUi.focus(
    p,
    { component: 'Pane', requestId: 'litter', ...(element !== undefined ? { plugin: 'litter', element } : {}), origin: { kind: 'person' } } as never,
    (async () => (deny ? { deny } : {})) as never,
  )
/** A wheel tick; beneath, the engine's window, which this test's answers so it's told apart. */
const wheel = (by: number) =>
  onLitterUi.scroll(p, { component: 'Pane', requestId: 'litter', offset: 0, by, bodyRows: 20, contentRows: 40, origin: { kind: 'person' }, pointer: { column: 3, row: 5 } } as never, (async () => ({ deny: 'the pane scrolled' })) as never)

const hubView = (): HubView => p.views.hub as HubView

beforeEach(() => {
  resetHubForTests()
  p = nodePorts()
  calls = []
  // The real key rule's prefixes, with stand-in handlers.
  sections.home = { ...standIn('home', k => k.startsWith('home:')), ui: sections.home.ui }
  sections.runs = standIn('runs', k => k.startsWith('board:') || k === 'board-gates')
  sections.swarms = standIn('swarms', k => (k.startsWith('swarm:') && !k.startsWith('swarm:doctor:')) || k === 'swarm-tree')
  sections.rules = standIn('rules', k => k.startsWith('rules:'))
  sections.tasks = standIn('tasks', k => k.startsWith('tasks:'))
  sections.agents = standIn('agents', k => k.startsWith('agents:'))
  sections.doctor = standIn('doctor', k => k.startsWith('swarm:doctor:'))
  deps.bandCounts = () => ({ runs: 0, ended: 0 })
  deps.liveSwarms = () => []
  deps.rulesCounts = () => null
  deps.tasksShown = () => null
})

afterEach(() => resetHubForTests())

describe('the key rule', () => {
  test('every key has at most one owner, by prefix, and the doctor\'s are not the swarm\'s', () => {
    resetHubForTests()
    expect(ownerOf('board:select:G1')).toBe('runs')
    expect(ownerOf('board-gates')).toBe('runs')
    expect(ownerOf('swarm:builder:save:alpha')).toBe('swarms')
    expect(ownerOf('swarm:start:name')).toBe('swarms')
    expect(ownerOf('swarm-tree')).toBe('swarms')
    expect(ownerOf('swarm:doctor:recheck')).toBe('doctor')
    expect(ownerOf('rules:accept:x')).toBe('rules')
    expect(ownerOf('tasks:filter:all')).toBe('tasks')
    expect(ownerOf('agents:select:x')).toBe('agents')
    expect(ownerOf('home:open:runs')).toBe('home')
    expect(ownerOf('band:board:x')).toBeNull()
    expect(ownerOf('someone-else')).toBeNull()
    // Disjoint: no key two sections own.
    const keys = ['board:x', 'board-gates', 'swarm:browser:x', 'swarm-tree', 'swarm:doctor:x', 'rules:x', 'tasks:x', 'agents:x', 'home:open:x']
    for (const k of keys) expect(SECTIONS.filter(id => sections[id].owns(k))).toHaveLength(1)
  })

  test('a key of the shown section reaches only its handler, in its event\'s shape', async () => {
    await openSection(p, 'tasks', '')
    calls = []
    expect(await press('tasks:filter:all')).toEqual({ element: 'tasks:filter:all' })
    expect(await input('tasks:subject:a/1', 'x')).toEqual({ element: 'tasks:subject:a/1', value: 'x' })
    expect(await select('tasks:sort', 'id')).toEqual({ element: 'tasks:sort', value: 'id' })
    expect(calls).toEqual(['tasks.press tasks:filter:all', 'tasks.input tasks:subject:a/1', 'tasks.select tasks:sort'])
  })

  test("another section's key is stale: no handler runs, a toast says so, and the answer is the event's shape", async () => {
    await openSection(p, 'runs', '')
    calls = []
    expect(await press('rules:accept:x')).toEqual({ element: 'rules:accept:x' })
    expect(await input('agents:text:1', 'hi')).toEqual({ element: 'agents:text:1', value: 'hi' })
    expect(await select('swarm:doctor:x', 'v')).toEqual({ element: 'swarm:doctor:x', value: 'v' })
    expect(await message('swarm-tree')).toEqual({})
    expect(calls).toEqual([])
    expect(p.toasts).toEqual([
      'that was on Rules, and litter shows Runs now, so it was ignored',
      'that was on Agents, and litter shows Runs now, so it was ignored',
      'that was on Doctor, and litter shows Runs now, so it was ignored',
      'that was on Swarms, and litter shows Runs now, so it was ignored',
    ])
  })

  test("a Client's post reaches its section while it's shown: the gate table on Runs, the tree on Swarms", async () => {
    await openSection(p, 'runs', '')
    expect(await message('board-gates')).toEqual({})
    await openSection(p, 'swarms', '')
    expect(await message('swarm-tree')).toEqual({})
    expect(calls.filter(c => c.includes('.message'))).toEqual(['runs.message board-gates', 'swarms.message swarm-tree'])
  })

  test("a key no section owns goes to the shown section's handler, which passes it on", async () => {
    await openSection(p, 'agents', '')
    calls = []
    expect(await press('someone-else')).toEqual({ element: 'next someone-else' })
    expect(await message('elsewhere')).toBe(passed)
    expect(calls).toEqual(['agents.press someone-else', 'agents.message elsewhere'])
  })
})

describe('the ring and the lists (WP-DA2)', () => {
  test("ui.focus reaches the shown section by its element's key, and the hub keeps where the ring landed", async () => {
    await openSection(p, 'tasks', '')
    calls = []
    expect(await focusOn('tasks:filter:all')).toEqual({})
    expect(calls).toEqual(['tasks.focus tasks:filter:all'])
    expect(focusedElement()).toBe('tasks:filter:all')
    expect(hubView().focus).toBe('tasks:filter:all')
    // A key no section owns is the shown section's to pass on, as the other events are.
    expect(await focusOn('someone-else')).toEqual({})
    expect(calls).toEqual(['tasks.focus tasks:filter:all', 'tasks.focus someone-else'])
  })

  test("the strip's, an engine stop's and another section's move the ring and reach no section: a focus is no action, so no toast", async () => {
    await openSection(p, 'tasks', '')
    calls = []
    expect(await focusOn(stripKey('runs'))).toEqual({})
    expect(hubView().focus).toBe(stripKey('runs'))
    expect(await focusOn(undefined)).toEqual({})
    expect(hubView().focus).toBeNull()
    expect(await focusOn('rules:accept:x')).toEqual({})
    expect(hubView().focus).toBe('rules:accept:x')
    expect(calls).toEqual([])
    expect(p.toasts).toEqual([])
  })

  test('a focus the core denies leaves the kept element where it was', async () => {
    await openSection(p, 'tasks', '')
    await focusOn('tasks:sort')
    expect(await focusOn('tasks:filter:all', 'another move landed first')).toEqual({ deny: 'another move landed first' })
    expect(focusedElement()).toBe('tasks:sort')
  })

  test('ui.scroll reaches the shown section, which takes a tick over its list or passes it on; with no handler it passes on', async () => {
    await openSection(p, 'swarms', '')
    calls = []
    expect(await wheel(1)).toEqual({})
    await openSection(p, 'tasks', '')
    expect(await wheel(-1)).toEqual({ deny: 'the pane scrolled' })
    expect(calls.filter(c => c.includes('.scroll'))).toEqual(['swarms.scroll 1', 'tasks.scroll -1'])
    const { scroll: _gone, ...rest } = sections.agents.ui
    sections.agents = { ...sections.agents, ui: rest }
    await openSection(p, 'agents', '')
    expect(await wheel(1)).toEqual({ deny: 'the pane scrolled' })
    expect(calls.filter(c => c.includes('.scroll'))).toEqual(['swarms.scroll 1', 'tasks.scroll -1'])
  })

  test("a list's Client posts: a row's press reaches its section as its Button's would; an offset moves the window, clamped, kept in the hub", async () => {
    await openSection(p, 'swarms', '')
    calls = []
    const list = 'swarm:start:templates'
    expect(await post(list, { list, press: 'swarm:start:template:builtin:pipeline' })).toEqual({})
    expect(calls).toEqual(['swarms.press swarm:start:template:builtin:pipeline'])
    expect(await post(list, { list, offset: 3, max: 5 })).toEqual({})
    expect(listOffset(list)).toBe(3)
    expect(hubView().lists).toEqual({ [list]: 3 })
    await post(list, { list, offset: 9, max: 5 })
    expect(hubView().lists).toEqual({ [list]: 5 })
    // At the edge already: nothing moves.
    expect(await moveList(p, list, 7, 5)).toBe(false)
    // Another section's key, another list's post, a shape it isn't: the section's own message handler, as before.
    calls = []
    await post(list, { list, press: 'tasks:filter:all' })
    await post(list, { list: 'elsewhere', offset: 1, max: 2 })
    await post(list, { list, offset: -1, max: 2 })
    expect(calls).toEqual([`swarms.message ${list}`, `swarms.message ${list}`, `swarms.message ${list}`])
    expect(listOffset(list)).toBe(5)
  })
})

describe('the strip and Home', () => {
  test("a strip press shows its section from what it kept, without opening the pane again; the shown one's press does nothing", async () => {
    await openSection(p, 'home', '', { focus: true })
    calls = []
    expect(await press(stripKey('rules'))).toEqual({ element: 'litter:section:rules' })
    expect(shownSection()).toBe('rules')
    expect(calls).toEqual(['rules.resume'])
    expect(hubView().section).toBe('rules')
    expect(p.panes.opened).toHaveLength(1)
    calls = []
    await press(stripKey('rules'))
    expect(calls).toEqual([])
    // An unknown section is answered and ignored.
    expect(await press('litter:section:nowhere')).toEqual({ element: 'litter:section:nowhere' })
    expect(shownSection()).toBe('rules')
  })

  test("Home's [Open] shows that section; on another section it's stale", async () => {
    resetHubForTests()
    sections.runs = standIn('runs', k => k.startsWith('board:'))
    sections.tasks = standIn('tasks', k => k.startsWith('tasks:'))
    deps.bandCounts = () => ({ runs: 0, ended: 0 })
    deps.liveSwarms = () => []
    deps.rulesCounts = () => null
    deps.tasksShown = () => null
    await openSection(p, 'home', '')
    expect(await press('home:open:tasks')).toEqual({ element: 'home:open:tasks' })
    expect(shownSection()).toBe('tasks')
    expect(calls).toContain('tasks.resume')
    expect(await press('home:open:runs')).toEqual({ element: 'home:open:runs' })
    expect(shownSection()).toBe('tasks')
    expect(p.toasts).toEqual(['that was on Home, and litter shows Tasks now, so it was ignored'])
  })

  test('the section shown comes back after a reload, for this session only', async () => {
    await openSection(p, 'agents', '')
    resetHubForTests()
    await litterShows(p, 'agents')
    expect(shownSection()).toBe('agents')
    resetHubForTests()
    const other = nodePorts({ sessionId: 'another-session' })
    await other.store.set('litter.hub', await p.store.get('litter.hub'))
    await litterShows(other, 'home')
    expect(shownSection()).toBe('home')
  })
})

describe('openSection, the one opener', () => {
  test('with an argument it loads the section, shows it, writes the hub and opens `litter`, asking for the keys when told to', async () => {
    const r = await openSection(p, 'runs', '20261006-exec', { focus: true })
    expect(r).toEqual({ placed: true, text: 'Runs shows "20261006-exec"' })
    expect(calls).toEqual(['runs.load "20261006-exec"'])
    expect(shownSection()).toBe('runs')
    expect(hubView()).toMatchObject({ view: 'hub', section: 'runs' })
    expect(p.panes.opened).toEqual([{ id: 'litter', title: 'litter', focus: true }])
    // Without focus (the model asked, not the person): no focus asked.
    await openSection(p, 'rules', { id: 'U-x' })
    expect(calls).toContain('rules.load {"id":"U-x"}')
    expect(p.panes.opened[1]).toEqual({ id: 'litter', title: 'litter' })
  })

  test('without one it resumes what the section kept', async () => {
    const r = await openSection(p, 'swarms')
    expect(r.text).toBe('Swarms is shown')
    expect(calls).toEqual(['swarms.resume'])
  })

  test('a refused argument switches and opens nothing', async () => {
    await openSection(p, 'tasks', '')
    const r = await openSection(p, 'doctor', 'bad')
    expect(r).toEqual({ placed: false, text: 'doctor refused bad' })
    expect(shownSection()).toBe('tasks')
    expect(p.panes.opened).toHaveLength(1)
  })

  test("a pane that isn't placed says so in the reply", async () => {
    p.openPane = async () => false
    expect((await openSection(p, 'agents', 'team-a')).text).toBe(`Agents shows "team-a" (open, but this screen can't draw it now)`)
  })

  test('the band, the card, the board, the builder and the rules records reach it through their deps', async () => {
    const band = await import('../../hooks/band/view')
    const card = await import('../../hooks/card/view')
    const records = await import('../../hooks/rules/records')
    // Other specs stand in for these deps, so only that each has the opener is checked here.
    for (const d of [band.deps, card.deps, records.deps]) expect(typeof d.openSection).toBe('function')
  })
})

describe('/litter [section] [arg]', () => {
  test('registers one command, with the sections as its hint', async () => {
    await registerLitterCommand(p)
    expect(p.commands).toEqual([expect.objectContaining({ name: 'litter', argumentHint: '[home | runs | swarms | rules | tasks | agents | doctor] [arg]', immediate: true })])
  })

  test("bare, it opens Home; a section's word hands that section the rest, as its command", async () => {
    const seen: string[] = []
    for (const id of SECTIONS) deps.command[id] = (async (q: Ports, e: { args: string }) => ({ text: `${id}(${e.args})` })) as never
    deps.command.home = (async (q: Ports, e: { args: string }) => {
      seen.push(`home(${e.args})`)
      return { text: 'home' }
    }) as never
    expect(await run('')).toEqual({ text: 'home' })
    expect(await run('   ')).toEqual({ text: 'home' })
    expect(await run('runs 20261006-exec')).toEqual({ text: 'runs(20261006-exec)' })
    expect(await run('RUNS execute')).toEqual({ text: 'runs(execute)' })
    expect(await run('swarms alpha')).toEqual({ text: 'swarms(alpha)' })
    expect(await run('rules')).toEqual({ text: 'rules()' })
    expect(await run('tasks team a')).toEqual({ text: 'tasks(team a)' })
    expect(await run('agents team-a')).toEqual({ text: 'agents(team-a)' })
    expect(await run('doctor alpha')).toEqual({ text: 'doctor(alpha)' })
    expect(await run('home')).toEqual({ text: 'home' })
    expect(seen).toEqual(['home()', 'home()', 'home()'])
  })

  test('anything else is the one-line usage, with no prefix of litter\'s own', async () => {
    for (const args of ['board', 'litter-board', 'runs a b', 'rules extra', 'home now', 'doctor a b', 'help']) expect(await run(args)).toEqual({ text: USAGE })
    expect(USAGE.startsWith('litter: ')).toBe(false)
    expect(USAGE.includes('\n')).toBe(false)
  })

  test("bare /litter through the real Home answers Home's line and opens with focus", async () => {
    resetHubForTests()
    deps.bandCounts = () => ({ runs: 2, ended: 0 })
    deps.liveSwarms = () => []
    deps.rulesCounts = () => null
    deps.tasksShown = () => null
    expect(await run('')).toEqual({ text: 'Home shows 2 active runs' })
    expect(p.panes.opened).toEqual([{ id: 'litter', title: 'litter', focus: true }])
    expect(hubView().section).toBe('home')
  })
})

describe('the tick', () => {
  test("while `litter` is closed it does nothing; while it's open, the shown section's tick alone, then the strip", async () => {
    p.paneOpenValue = false
    await litterTick(p)
    expect(calls).toEqual([])
    expect(p.views.hub).toBeUndefined()
    p.paneOpenValue = true
    await openSection(p, 'tasks', '')
    calls = []
    await litterTick(p)
    expect(calls).toEqual(['tasks.tick'])
    expect(await litterShows(p, 'tasks')).toBe(true)
    expect(await litterShows(p, 'swarms')).toBe(false)
  })

  test('a $.ui.panes() that fails counts as open, logged once', async () => {
    await openSection(p, 'agents', '')
    calls = []
    p.paneOpenThrows = true
    await litterTick(p)
    await litterTick(p)
    expect(calls).toEqual(['agents.tick', 'agents.tick'])
    expect(p.logs.filter(l => l.includes('$.ui.panes() failed'))).toHaveLength(1)
  })

  test('a section tick that throws is logged and the strip is still written', async () => {
    await openSection(p, 'runs', '')
    sections.runs = { ...sections.runs, tick: async () => Promise.reject(new Error('ledger gone')) }
    deps.bandCounts = () => ({ runs: 3, ended: 0 })
    await litterTick(p)
    expect(p.logs).toContain('litter pane: the Runs tick failed: ledger gone')
    expect(hubView().tabs.find(t => t.section === 'runs')?.count).toBe(3)
  })

  test('the hub writes only a view that changed, and always after a /clear', async () => {
    await openSection(p, 'home', '')
    const v = hubView().v
    await litterTick(p)
    expect(hubView().v).toBe(v)
    await refreshHub(p)
    expect(hubView().v).toBe(v + 1)
  })
})

describe('the counts', () => {
  const counts = (over: Partial<HubCounts> = {}): HubCounts => ({ runs: 0, swarms: 0, swarmsNeedYou: false, rules: null, tasks: null, agents: null, ...over })

  test('seven tabs in the strip order, a count where there is one, a needs-you mark where something waits', () => {
    const tabs = tabsOf(counts({ runs: 2, swarms: 1, swarmsNeedYou: true, rules: { proposed: 3, inForce: 4 }, tasks: 5, agents: 1 }))
    expect(tabs.map(t => t.section)).toEqual([...SECTIONS])
    expect(tabs.map(t => t.count)).toEqual([null, 2, 1, 3, 5, 1, null])
    expect(tabs.map(t => t.needsYou)).toEqual([false, false, true, true, false, false, false])
    expect(tabs.find(t => t.section === 'tasks')?.summary).toBe('5 open tasks')
    expect(tabs.find(t => t.section === 'runs')?.summary).toBe('2 active runs')
  })

  test('the live line: what runs, then what needs you, each with its glyph and word', () => {
    expect(liveOf(counts(), tabsOf(counts()))).toEqual([{ text: 'nothing running', color: 'inactive' }])
    const busy = counts({ runs: 1, swarms: 2, swarmsNeedYou: true })
    expect(liveOf(busy, tabsOf(busy)).map(s => s.text).join('')).toBe('▸ 1 run · 2 swarms live · ⚑ needs you: Swarms')
  })

  test('each count comes from module memory and the agent list: a read that throws counts nothing, logged', async () => {
    deps.bandCounts = () => {
      throw new Error('band broke')
    }
    deps.liveSwarms = () => [{ name: 'alpha' }, { name: 'beta' }] as never
    deps.openQuestions = name => (name === 'beta' ? [{}] : []) as never
    deps.pendingProposals = () => []
    deps.tasksShown = () => ({ tasks: [{ status: 'pending' }, { status: 'completed' }, { status: 'in_progress' }] }) as never
    p.agents = [{ status: 'running' }, { status: 'completed' }, { status: 'waiting' }] as never
    await openSection(p, 'home', '')
    const tabs = hubView().tabs
    expect(tabs.map(t => t.count)).toEqual([null, 0, 2, null, 2, 2, null])
    expect(tabs.find(t => t.section === 'swarms')?.needsYou).toBe(true)
    expect(p.logs).toContain("litter pane: the runs couldn't be counted: band broke")
  })
})

describe('the chrome layout', () => {
  test('packWidths packs items into rows of the width, one cell between, never an empty row', () => {
    expect(packWidths([5, 5, 5], 11)).toEqual([[0, 1], [2]])
    expect(packWidths([5, 5, 5], 17)).toEqual([[0, 1, 2]])
    expect(packWidths([20, 3], 10)).toEqual([[0], [1]])
    expect(packWidths([], 10)).toEqual([])
    expect(packWidths([4, 4], Number.POSITIVE_INFINITY)).toEqual([[0, 1]])
  })

  test('the row budget at a wide and a narrow size keeps the keys line inside the pane', () => {
    const tabs = tabsOf({ runs: 2, swarms: 1, swarmsNeedYou: false, rules: { proposed: 3, inForce: 0 }, tasks: 4, agents: 1 })
    const wide = plan({ bodyColumns: 140, bodyRows: 40, context: false, strip: stripWidths(tabs, 'home', true), keys: true })
    expect(wide).toEqual({ wide: true, headerRows: 2, stripRows: 1, keysRows: 2, bodyRows: 40 - 2 - 1 - 1 - 2 })
    const narrow = plan({ bodyColumns: 36, bodyRows: 20, context: true, strip: stripWidths(tabs, 'home', true), keys: true })
    expect(narrow.wide).toBe(false)
    expect(narrow.stripRows).toBeGreaterThan(1)
    expect(narrow.headerRows + narrow.stripRows + 1 + narrow.bodyRows + narrow.keysRows).toBe(20)
    // Too short for any body: none, never negative.
    expect(plan({ bodyColumns: 36, bodyRows: 3, context: false, strip: stripWidths(tabs, 'home', false), keys: true }).bodyRows).toBe(0)
    // No bound (a surface that gives none): an unbounded body.
    expect(plan({ bodyColumns: 80, bodyRows: Number.POSITIVE_INFINITY, context: false, strip: [], keys: false }).bodyRows).toBe(Number.POSITIVE_INFINITY)
    expect(WIDE_COLUMNS).toBe(100)
  })

  test("the strip's widths: `1: label` focused, the label alone unfocused, `› ` before the shown one", () => {
    const tabs = tabsOf({ runs: 2, swarms: 0, swarmsNeedYou: false, rules: null, tasks: null, agents: null })
    expect(stripWidths(tabs, 'home', false).slice(0, 2)).toEqual(['Home'.length + 2, 'Runs 2'.length])
    expect(stripWidths(tabs, 'home', true).slice(0, 2)).toEqual(['Home'.length + 5, 'Runs 2'.length + 3])
  })

  test('planColumns drops the least important column first, then cuts the fill column', () => {
    const cols = [{ drop: 0 }, { drop: 2 }, { drop: 1 }, { drop: 0, fill: true }]
    const rows = [[{ text: '#12' }, { text: 'researcher' }, { text: '▸ in progress' }, { text: 'Read the plan and say what it misses' }]]
    expect(planColumns(cols, rows, 200)).toEqual({ shown: [0, 1, 2, 3], widths: [3, 10, 13, 36] })
    // 3 + 13 + 36 + 2 gaps = 54: the owner (drop 2) goes first.
    expect(planColumns(cols, rows, 54).shown).toEqual([0, 2, 3])
    // Then the status (drop 1); then the subject is cut to what's left.
    expect(planColumns(cols, rows, 30)).toEqual({ shown: [0, 3], widths: [3, 10, 13, 26] })
  })

  test('packItems packs toolbar items by their drawn width', () => {
    const items = [
      { kind: 'button' as const, key: 'a', label: 'Accept' },
      { kind: 'plain' as const, key: 'b', label: 'Next', hotkey: 'n' },
      { kind: 'text' as const, label: '3 left' },
    ]
    // [ Accept ] 10, n: Next 7, 3 left 6
    expect(packItems(items, 30).map(r => r.length)).toEqual([3])
    expect(packItems(items, 18).map(r => r.map(i => i.label))).toEqual([['Accept', 'Next'], ['3 left']])
  })
})
