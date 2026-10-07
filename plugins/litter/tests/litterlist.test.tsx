// Tier 1 (phase 5b, WP-DA2): the chrome's heading, field and list as the
// engine draws them in the one `litter` pane. Home's heading has its faint
// rule to the body's edge, wide and narrow; the start screen's Name is a
// field with its caption under its frame and Ask one too (WP-DD), the frame the
// accent while the ring is on it; its template list draws six rows of eight
// and a footer, a wheel tick over the list moves its window (one elsewhere
// passes on), the focused template's description sits beside its row wide
// and under it narrow, and a press on a row picks the template as the Select
// did; and the Tasks picker leaves out the empty session teams, saying how
// many. tests/drawing.ts lays each tree out as rows of text, so a row is
// found by what it says and its cells counted; the last block holds both
// pickers drawn at 100 and 60 columns, the colors named beside each row.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import { drawText, drawWithColors, findNode, keyOf, pathTo, type DrawnNode } from './drawing'

const SESSION = 'tier1-list'
const LITTER = '/repo/.claude/litter'
const NOW = 1_800_000_000_000

type Over = { isFocused?: boolean; bodyColumns?: number; bodyRows?: number }
const pane = (o: Over = {}) =>
  ({ title: 'litter', isFocused: o.isFocused ?? false, bodyColumns: o.bodyColumns ?? 100, placement: 'dock', scroll: { offset: 0, bodyRows: o.bodyRows ?? 60 }, view: {} }) as const

const mount = ($: Engine, o: Over = {}, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'litter', surface, component: 'Pane', requestId: 'litter', props: pane(o) })

const run = ($: Engine, args: string) => $.command.run({ command: 'litter', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

/** A project template: no parameters, an empty tree; `goal` its spec's. */
const projectTemplate = (name: string, description: string, goal: string) => JSON.stringify({ name, description, params: [], spec: { name: 'x', goal, nodes: [] }, briefs: {} })

/** The project's four templates, after the four built-ins: eight rows for a window of six. */
const TEMPLATES: Record<string, string> = {
  [`${LITTER}/swarm-templates/audit.json`]: projectTemplate('audit', 'Read the logs for what went wrong', 'Audit the logs'),
  [`${LITTER}/swarm-templates/docs.json`]: projectTemplate('docs', '', 'Write the user guide\nthen the reference'),
  [`${LITTER}/swarm-templates/release.json`]: projectTemplate('release', 'Cut a release: notes, tag, push', 'Ship it'),
  [`${LITTER}/swarm-templates/triage.json`]: projectTemplate('triage', 'Sort the new issues by area', 'Triage'),
}

/** Thirteen of the engine's implicit `session-<sid8>` teams, none with a task, and team-a with two. */
const TEAMS: Record<string, string> = {
  '/cfg/teams/team-a/config.json': JSON.stringify({ name: 'team-a', leadSessionId: 'someone-else', members: [] }),
  '/cfg/tasks/team-a/1.json': JSON.stringify({ id: '1', subject: 'Plan it', description: '', status: 'completed', blocks: [], blockedBy: [] }),
  '/cfg/tasks/team-a/2.json': JSON.stringify({ id: '2', subject: 'Do it', description: '', status: 'pending', blocks: [], blockedBy: [] }),
  ...Object.fromEntries(
    Array.from({ length: 13 }, (_, i) => {
      const name = `session-${(0xa1b2c300 + i).toString(16)}`
      return [`/cfg/teams/${name}/config.json`, JSON.stringify({ name, leadSessionId: `s-${i}`, members: [] })]
    }),
  ),
}

/** What reached the engine beneath the plugins: the ring's moves (by element) and the window's (by `by`). */
type Beneath = { focus: string[]; scroll: number[] }

/** $.fs over a map, git as a plain checkout at /repo (so the litter directory resolves), and what a session needs. */
function world(on: On, seed: Record<string, string> = {}): { toasts: string[]; beneath: Beneath } {
  const files = new Map<string, string>(Object.entries(seed))
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
    return { value: { kind: files.has(e.path) ? 'file' : 'dir', size: files.get(e.path)?.length ?? 0, mtimeMs: NOW, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
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
  on('tool.list', async () => ({ value: [] }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('ui.panes', async () => ({ value: [{ id: 'litter', title: 'litter', isShown: true, isFocused: true, isPlaced: true }] }))
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', async () => ({ value: undefined }))
  // The engine's ring and window, beneath the plugins: each lands.
  const beneath: Beneath = { focus: [], scroll: [] }
  on('ui.focus', async (_$, e) => {
    beneath.focus.push(e.element ?? '')
    return {}
  })
  on('ui.scroll', async (_$, e) => {
    beneath.scroll.push(e.by)
    return {}
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.cwd', async () => ({ value: '/repo' }))
  mock.store(on)
  mock.clock(on, { now: NOW })
  mock.env(on, { HOME: '/home/tier1', CLAUDE_CONFIG_DIR: '/cfg' })
  return { toasts, beneath }
}

/** A session in /repo with the project's templates, Swarms shown on its start screen. */
async function startScreen($: Engine, on: On): Promise<{ toasts: string[]; beneath: Beneath }> {
  const w = world(on, TEMPLATES)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  expect((await run($, 'swarms')).text).toBe('Swarms shows the start screen')
  return w
}

const TEMPLATE_KEY = (id: string) => `swarm:start:template:${id}`
const ORDER = ['builtin:branch-per-orchestrator', 'builtin:research-fan-out', 'builtin:review-panel', 'builtin:pipeline', 'project:audit', 'project:docs', 'project:release', 'project:triage']

/** The template rows drawn, by their keys. */
const rowsDrawn = async (ui: { findAll: (q: { type: string }) => Promise<{ key: string | undefined }[]> }) =>
  (await ui.findAll({ type: 'Button' })).map(b => b.key ?? '').filter(k => k.startsWith('swarm:start:template:'))

/** The row of the drawing whose text holds `part`, or -1. */
const rowOf = (rows: readonly string[], part: string) => rows.findIndex(r => r.includes(part))

/** A wheel tick of `by` rows with the pointer at a body cell: the event the engine raises. */
const tick = ($: Engine, row: number, by: number, column = 4) =>
  $.ui.scroll({ component: 'Pane', requestId: 'litter', offset: Math.max(0, by), by, bodyRows: 60, contentRows: 120, origin: { kind: 'person' }, pointer: { column, row } })

/** The ring moving onto `element`, as the person's Tab or click does. */
const focus = ($: Engine, element: string) => $.ui.focus({ component: 'Pane', requestId: 'litter', plugin: 'litter', element, origin: { kind: 'person' } })

/**
 * Home's view in the `hub` atom (WP-DB: Home draws its groups under headings
 * once the hub has written its part): a question under Needs you, a run under
 * Recently ended with its window as the heading's note, and Doctor. Registered
 * before world()'s store, so it wraps it; the store's version is kept.
 */
function holdHome(on: On): void {
  const mark = (glyph: string, word: string, color: string) => ({ glyph, word, color })
  const home = {
    needsYou: [{ open: 'home:open:swarms:review', mark: mark('⚑', 'needs you', 'permission'), spans: [{ text: 'swarm ' }, { text: 'review', color: 'cyan_FOR_SUBAGENTS_ONLY' }, { text: ' · reviewer asks: tabs?' }] }],
    running: [],
    ended: [{ open: 'home:open:runs:20261005-x', mark: mark('✓', 'done', 'success'), spans: [{ text: 'execute ' }, { text: '20261005-x', color: 'cyan_FOR_SUBAGENTS_ONLY' }] }],
    endedMinutes: 10,
    others: [{ open: 'home:open:doctor', label: 'Doctor', text: 'checks' }],
  }
  const view = { view: 'hub', v: 1, section: 'home', live: [], tabs: [], focus: null, lists: {}, home }
  on('state.get', async (_$, e, next) => {
    const real = await next(e)
    return e.key === 'hub' ? { value: { value: view, version: (real as { value?: { version?: number } }).value?.version ?? 0 } } : real
  })
}

describe('the heading', () => {
  test('Home at 100 columns: the title, then a faint rule to the body\'s edge, on one row', async ($, on) => {
    holdHome(on)
    world(on)
    const ui = await mount($, { bodyColumns: 100 })
    const title = await ui.find({ type: 'Text', text: 'Needs you' })
    expect(title?.props).toEqual(expect.objectContaining({ bold: true, color: 'suggestion' }))
    const rule = (await ui.findAll({ type: 'Text', text: /^─+$/ }))[0]
    expect(rule?.props.color).toBe('subtle')
    // `Needs you`, a gap, the rule: 100 cells.
    expect(rule?.text.length).toBe(100 - 'Needs you'.length - 1)
    const rows = drawText(await ui.drawn(), 100)
    expect(rows[rowOf(rows, 'Needs you')]).toBe(`Needs you ${'─'.repeat(90)}`)
  })

  test('Home narrow: a short rule still, the title cut first; and the note before the rule\'s end when it fits', async ($, on) => {
    holdHome(on)
    world(on)
    const tiny = await mount($, { bodyColumns: 10 })
    const rows = drawText(await tiny.drawn(), 10)
    expect(rows).toContain('Needs… ───')
    await tiny.unmount()
    // 50 columns: Recently ended's note, the window it covers; at 40 the rule would be too short for it, so no note.
    const narrow = await mount($, { bodyColumns: 50 })
    const at50 = drawText(await narrow.drawn(), 50)
    expect(at50).toContain(`Recently ended ${'─'.repeat(12)} the last 10 minutes ──`)
    expect((await narrow.find({ type: 'Text', text: 'the last 10 minutes' }))?.props.color).toBe('inactive')
    await narrow.unmount()
    const at40 = drawText(await (await mount($, { bodyColumns: 40 })).drawn(), 40)
    expect(at40).toContain(`Recently ended ${'─'.repeat(25)}`)
  })

  test("the start screen's template heading is the chrome's heading, its rule to [Blank] beside it (WP-DD)", async ($, on) => {
    await startScreen($, on)
    const ui = await mount($, { bodyColumns: 100 })
    const tree = await ui.drawn()
    const title = findNode(tree, n => n.type === 'Text' && JSON.stringify(n).includes('From a template'))!
    expect(title.props).toEqual(expect.objectContaining({ bold: true, color: 'suggestion' }))
    const rowBox = pathTo(tree, title)!.at(-1)!
    // The heading's own row: the title, then its faint rule, a fixed length now (the row has [Blank] to leave room for).
    const rule = (rowBox.children ?? []).find((c): c is DrawnNode => typeof c === 'object' && c !== null && (c as DrawnNode).type === 'Text' && (c as DrawnNode).props?.color === 'subtle')
    expect(JSON.stringify(rule?.children ?? rule?.props?.children)).toContain('─'.repeat(71))
    const rows = drawText(tree, 100)
    // `or [ Blank ]` takes its 12 cells (and a gap) off the heading's.
    expect(rows[rowOf(rows, 'From a template')]).toBe(`From a template ${'─'.repeat(100 - 16 - 13)} or [ Blank ]`)
  })
})

describe('the field', () => {
  test('Name: the Input labelled in a round frame, its caption one muted line under the frame; Ask: framed, what it does its caption (WP-DD)', async ($, on) => {
    await startScreen($, on)
    const ui = await mount($, { bodyColumns: 100 })
    const tree = await ui.drawn()
    const name = findNode(tree, n => n.type === 'Input' && keyOf(n) === 'swarm:start:name')!
    expect(name.props).toEqual(expect.objectContaining({ label: 'Name' }))
    const [field, frame] = pathTo(tree, name)!.slice(-2)
    expect(frame!.props).toEqual(expect.objectContaining({ borderStyle: 'round', borderColor: 'promptBorder' }))
    // The field's column: the frame, then the caption, never above it.
    const parts = (field!.children ?? []) as DrawnNode[]
    expect(parts.map(p => p.type)).toEqual(['Box', 'Text'])
    expect(parts[1]!.props).toEqual(expect.objectContaining({ color: 'inactive', wrap: 'truncate-end' }))
    expect(JSON.stringify(parts[1])).toContain('a-z, 0-9 and -, up to 24, not starting with -')

    const ask = findNode(tree, n => n.type === 'Input' && keyOf(n) === 'swarm:start:ask')!
    expect(ask.props?.label).toBeUndefined()
    expect(ask.props?.placeholder).toBe('what the swarm is for')
    const [askField, askFrame] = pathTo(tree, ask)!.slice(-2)
    expect(askFrame!.props).toEqual(expect.objectContaining({ borderStyle: 'round' }))
    const askParts = (askField!.children ?? []) as DrawnNode[]
    expect(askParts.map(p => p.type)).toEqual(['Box', 'Text'])
    expect(JSON.stringify(askParts[1])).toContain('the lead proposes one; you review it here')

    const rows = drawText(tree, 100)
    const at = rowOf(rows, 'Name: ')
    expect(rows[at - 1]).toMatch(/^╭─+╮$/)
    expect(rows[at + 1]).toMatch(/^╰─+╯$/)
    expect(rows[at + 2]).toBe('a-z, 0-9 and -, up to 24, not starting with -')
  })

  test('the frame is the accent while the ring is on its Input and the pane has the keys', async ($, on) => {
    await startScreen($, on)
    const ui = await mount($, { bodyColumns: 100, isFocused: true })
    expect((await focus($, 'swarm:start:name')).deny).toBeUndefined()
    const tree = await ui.drawn()
    const name = findNode(tree, n => n.type === 'Input' && keyOf(n) === 'swarm:start:name')!
    expect(pathTo(tree, name)!.at(-1)!.props?.borderColor).toBe('claude')
    const ask = findNode(tree, n => n.type === 'Input' && keyOf(n) === 'swarm:start:ask')!
    expect(pathTo(tree, ask)!.at(-1)!.props?.borderColor).toBe('promptBorder')
  })

  test('on the desktop, which draws its own field, the Input alone with its caption', async ($, on) => {
    await startScreen($, on)
    const ui = await mount($, { bodyColumns: 100 }, 'desktop')
    const tree = await ui.drawn()
    const name = findNode(tree, n => n.type === 'Input' && keyOf(n) === 'swarm:start:name')!
    const field = pathTo(tree, name)!.at(-1)!
    expect(field.props?.borderStyle).toBeUndefined()
    expect(((field.children ?? []) as DrawnNode[]).map(p => p.type)).toEqual(['Input', 'Text'])
  })
})

describe('the list: the template picker', () => {
  test('six rows of eight are drawn, then the footer; a wheel tick over the list moves its window, one over the body passes on', async ($, on) => {
    const { beneath } = await startScreen($, on)
    const ui = await mount($, { bodyColumns: 100 })
    expect(await rowsDrawn(ui)).toEqual(ORDER.slice(0, 6).map(TEMPLATE_KEY))
    expect((await ui.find({ type: 'Button', key: 'swarm:start:templates:down' }))?.text).toBe('↓ 2 more')
    expect(await ui.find({ type: 'Button', key: 'swarm:start:templates:up' })).toBeUndefined()

    // The pointer over the list's first row (the window's offset is 0, so the tree's row is the body's).
    const rows = drawText(await ui.drawn(), 100)
    const first = rowOf(rows, 'branch-per-orchestrator')
    expect(first).toBeGreaterThan(0)
    expect(await tick($, first + 2, 1)).toEqual({})
    expect(beneath.scroll).toEqual([])
    expect(await rowsDrawn(ui)).toEqual(ORDER.slice(1, 7).map(TEMPLATE_KEY))
    expect((await ui.find({ type: 'Button', key: 'swarm:start:templates:up' }))?.text).toBe('↑ 1 above')
    expect((await ui.find({ type: 'Button', key: 'swarm:start:templates:down' }))?.text).toBe('↓ 1 more')

    // Over the header, and the row just above the list: not the list's, so they pass on and the window stays.
    await tick($, 0, 1)
    await tick($, first - 1, 1)
    expect(beneath.scroll).toEqual([1, 1])
    expect(await rowsDrawn(ui)).toEqual(ORDER.slice(1, 7).map(TEMPLATE_KEY))
    // Five more go as far as the list goes; then it can't move, so the next passes on.
    expect(await tick($, first, 5)).toEqual({})
    expect(await rowsDrawn(ui)).toEqual(ORDER.slice(2, 8).map(TEMPLATE_KEY))
    await tick($, first, 1)
    expect(beneath.scroll).toEqual([1, 1, 1])
    expect(await rowsDrawn(ui)).toEqual(ORDER.slice(2, 8).map(TEMPLATE_KEY))
    // The footer's [↑ 2 above] moves it back a page (the window less a row).
    await ui.press({ key: 'swarm:start:templates:up' })
    expect(await rowsDrawn(ui)).toEqual(ORDER.slice(0, 6).map(TEMPLATE_KEY))
  })

  test('wide: the focused template\'s description beside its row, muted; every other row\'s faint, lifted by the pointer', async ($, on) => {
    await startScreen($, on)
    const ui = await mount($, { bodyColumns: 100, isFocused: true })
    expect((await focus($, TEMPLATE_KEY('project:audit'))).deny).toBeUndefined()
    const tree = await ui.drawn()
    const row = (id: string) => findNode(tree, n => n.type === 'Box' && keyOf(n) === `swarm:start:templates#${TEMPLATE_KEY(id)}`)!
    // The description: the row's one Text with a hover style, in a Box that takes what the row has left.
    const description = (id: string) => findNode(row(id), n => n.type === 'Text' && n.hover !== undefined)!
    expect(description('project:audit').props).toEqual(expect.objectContaining({ color: 'inactive' }))
    expect(JSON.stringify(description('project:audit'))).toContain('Read the logs for what went wrong')
    expect(description('builtin:pipeline').props).toEqual(expect.objectContaining({ color: 'subtle' }))
    expect(description('builtin:pipeline').hover).toEqual({ color: 'inactive' })
    // A template with no description shows its goal's first line.
    expect(JSON.stringify(description('project:docs'))).toContain('Write the user guide')
    expect(JSON.stringify(description('project:docs'))).not.toContain('reference')
    const rows = drawText(tree, 100)
    expect(rows[rowOf(rows, 'audit')]).toMatch(/^ {2}audit +this project +Read the logs for what went wrong$/)
  })

  test('narrow: the focused template\'s description on the line under its row, and none beside any', async ($, on) => {
    await startScreen($, on)
    const ui = await mount($, { bodyColumns: 60, isFocused: true })
    await focus($, TEMPLATE_KEY('project:audit'))
    const rows = drawText(await ui.drawn(), 60)
    const at = rowOf(rows, 'audit ')
    expect(rows[at]).toMatch(/^ {2}audit +this project$/)
    expect(rows[at + 1]).toBe('  Read the logs for what went wrong')
    expect(rows.some(r => r.includes('Cut a release'))).toBe(false)
  })

  test('a press on a row picks its template, as the Select did: its form opens and the row is marked', async ($, on) => {
    await startScreen($, on)
    const ui = await mount($, { bodyColumns: 100 })
    expect(await ui.find({ type: 'Button', key: 'swarm:start:use-template' })).toBeUndefined()
    expect(await ui.press({ key: TEMPLATE_KEY('builtin:review-panel') })).toEqual(expect.objectContaining({ element: TEMPLATE_KEY('builtin:review-panel') }))
    expect(await ui.find({ type: 'Button', key: 'swarm:start:use-template' })).toBeDefined()
    const rows = drawText(await ui.drawn(), 100)
    // Its form's box sits beside the list (WP-DD), its title the template's name, so the row is found by its mark.
    expect(rows.some(r => /^› review-panel/.test(r))).toBe(true)
    expect(rows.filter(r => r.startsWith('›'))).toHaveLength(1)
  })
})

describe('the Tasks picker', () => {
  test('leaves out the empty session teams, but for the one named, and says how many', async ($, on) => {
    world(on, TEAMS)
    expect((await run($, 'tasks team-a')).text).toBe('Tasks shows team-a (2 tasks)')
    const ui = await mount($, { bodyColumns: 100 })
    const picker = await ui.find({ type: 'Select', key: 'tasks:list' })
    const options = (picker?.props.options ?? []) as { value: string }[]
    expect(options.map(o => o.value)).toEqual([SESSION, 'team-a'])
    expect((await ui.find({ type: 'Text', text: '13 empty session teams hidden' }))?.props.color).toBe('inactive')
    // One named is kept, empty or not.
    expect((await run($, 'tasks session-a1b2c304')).text).toMatch(/^Tasks shows session-a1b2c304/)
    await ui.redraw()
    const after = ((await ui.find({ type: 'Select', key: 'tasks:list' }))?.props.options ?? []) as { value: string }[]
    // The teams in their store's order, by name.
    expect(after.map(o => o.value)).toEqual([SESSION, 'session-a1b2c304', 'team-a'])
    expect(await ui.find({ type: 'Text', text: '12 empty session teams hidden' })).toBeDefined()
  })
})

/** Rows of a drawing with the colors beside each, as drawWithColors writes them. */
const golden = (columns: number, rows: readonly [string, string][]): string[] => rows.map(([text, colors]) => (colors === '' ? text : `${text.padEnd(columns)}  | ${colors}`))

/**
 * The drawings in WP-DA2's report: the template picker (review-panel
 * focused) and the Tasks picker, at 100 and 60 columns, each row's colors
 * beside it. A Select is drawn as `label: option ▾` (tests/drawing.ts), not
 * as the engine paints it.
 */
const PICKER: Record<number, [string, string][]> = {
  100: [
    [`From a template ${'─'.repeat(71)} or [ Blank ]`, 'suggestion bold, subtle, inactive, default dim'],
    ['  branch-per-orchestrator built-in     One orchestrator per branch, each with reviewers, fixers in …', 'default, inactive, subtle'],
    ['  research-fan-out        built-in     One orchestrator that splits a question across read-only res…', 'default, inactive, subtle'],
    ['  review-panel            built-in     Read-only reviewers, one per lens, each reporting to the lea…', 'default, inactive'],
    ['  pipeline                built-in     One orchestrator taking the goal through a planner, an imple…', 'default, inactive, subtle'],
    ['  audit                   this project Read the logs for what went wrong', 'default, inactive, subtle'],
    ['  docs                    this project Write the user guide', 'default, inactive, subtle'],
    ['  ↓ 2 more', 'default dim'],
  ],
  60: [
    [`From a template ${'─'.repeat(31)} or [ Blank ]`, 'suggestion bold, subtle, inactive, default dim'],
    ['  branch-per-orchestrator built-in', 'default, inactive'],
    ['  research-fan-out        built-in', 'default, inactive'],
    ['  review-panel            built-in', 'default, inactive'],
    ['  Read-only reviewers, one per lens, each reporting to the', 'inactive'],
    ['  lead.', 'inactive'],
    ['  pipeline                built-in', 'default, inactive'],
    ['  audit                   this project', 'default, inactive'],
    ['  docs                    this project', 'default, inactive'],
    ['  ↓ 2 more', 'default dim'],
  ],
}
const TASKS_PICKER: [string, string][] = [
  ['List: team-a · team · 2 tasks ▾', 'default'],
  ['13 empty session teams hidden', 'inactive'],
  ['[ › All 2 ] [ Pending 1 ] [ In progress 0 ] [ Completed 1 ]', 'claude, default'],
  ['Sort by: id ▾', 'default'],
]

describe('the drawings', () => {
  for (const columns of [100, 60]) {
    test(`the template picker at ${columns} columns, review-panel focused`, async ($, on) => {
      await startScreen($, on)
      const ui = await mount($, { bodyColumns: columns, isFocused: true })
      await focus($, TEMPLATE_KEY('builtin:review-panel'))
      const rows = drawWithColors(await ui.drawn(), columns)
      const from = rowOf(rows, 'From a template')
      expect(rows.slice(from, from + PICKER[columns]!.length)).toEqual(golden(columns, PICKER[columns]!))
    })

    test(`the Tasks picker at ${columns} columns`, async ($, on) => {
      world(on, TEAMS)
      await run($, 'tasks team-a')
      const ui = await mount($, { bodyColumns: columns })
      const rows = drawWithColors(await ui.drawn(), columns)
      const from = rowOf(rows, 'List: ')
      expect(rows.slice(from, from + TASKS_PICKER.length)).toEqual(golden(columns, TASKS_PICKER))
    })
  }
})
