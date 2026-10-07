// Tier 1: /litter tasks and the Tasks section of the `litter` pane as the
// engine runs and draws them (WP-CE, phase 5b's WP-DA, WP-DF; COMMON
// decisions 4, 15, 16). The config dir is /cfg, its files a map behind $.fs,
// and teamfile.sh a process.run hook that records its argv and stdin and
// applies the patch to the map. The command opens `litter` on a team's list,
// asking for the keyboard, and writes its view; the body's first line names
// the list; the picker is the chrome's list (its rows Buttons), the empty
// session teams counted under it with [Show all], twenty lists scrolling in
// its window; the filters a strip, the shown one primary; the tasks the
// chrome's list (on the terminal and the desktop a Client with a right-click
// menu, elsewhere Buttons, the focused row's actions beside it), a task
// blocked; the editor's fields captioned with how they save; a view as a
// reload left it (the changed-on-disk banner with [Reload], the files not
// read); every action by press and by the menu; and the drawings at 100 and
// 60 columns, docked and inline, nothing past the rows the hub gives the
// body. No real ~/.claude/ is read.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { HubView, TasksPaneView } from '../types/index'
import { drawText, drawWithColors } from './drawing'

const SESSION = 'tier1-session'
const NOW = Date.parse('2027-01-15T13:00:00Z')
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
type Surface = (typeof SURFACES)[number]

type Over = { bodyColumns?: number; bodyRows?: number; placement?: 'dock' | 'inline'; isFocused?: boolean }
const pane = (o: Over = {}) =>
  ({ title: 'litter', isFocused: o.isFocused ?? false, bodyColumns: o.bodyColumns ?? 120, placement: o.placement ?? 'dock', scroll: { offset: 0, bodyRows: o.bodyRows ?? 80 }, view: {} }) as const

const task = (id: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, subject: `task ${id}`, description: '', status: 'pending', blocks: [], blockedBy: [], ...over }, null, 2)
const member = (team: string, name: string) => ({ name, agentId: `${name}@${team}`, agentType: 'general-purpose' })

/** team-a: its lead and two members; #1 done, #2 waiting, #3 under way and blocked by #2 (#1 is done, so it blocks no more). */
const TEAM_A: Record<string, string> = {
  '/cfg/teams/team-a/config.json': JSON.stringify({
    name: 'team-a',
    leadAgentId: 'team-lead@team-a',
    leadSessionId: 'someone-else',
    members: ['team-lead', 'researcher', 'writer'].map(n => member('team-a', n)),
  }),
  '/cfg/tasks/team-a/1.json': task('1', { status: 'completed', subject: 'Plan it', owner: 'researcher' }),
  '/cfg/tasks/team-a/2.json': task('2', { subject: 'Draft the user guide', description: 'the install page first\nthen the reference' }),
  '/cfg/tasks/team-a/3.json': task('3', { status: 'in_progress', subject: 'Check the parser', owner: 'writer', blockedBy: ['1', '2'], blocks: ['4'] }),
}

const sessionTeam = (i: number) => `session-${(0xa1b2c300 + i).toString(16)}`

/** Twenty lists: this session's (one task), team-a's, team-b's (all done), and seventeen of the engine's empty session teams. */
const TWENTY: Record<string, string> = {
  ...TEAM_A,
  [`/cfg/tasks/${SESSION}/1.json`]: task('1', { subject: 'Read the brief' }),
  '/cfg/teams/team-b/config.json': JSON.stringify({ name: 'team-b', leadSessionId: 'sid-b', members: [member('team-b', 'team-lead')] }),
  '/cfg/tasks/team-b/1.json': task('1', { status: 'completed', subject: 'Ship it' }),
  ...Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`/cfg/teams/${sessionTeam(i)}/config.json`, JSON.stringify({ name: sessionTeam(i), leadSessionId: `s-${i}`, members: [] })])),
}

/** team-a with thirty more tasks: a window to move. */
const LONG: Record<string, string> = {
  ...TEAM_A,
  ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`/cfg/tasks/team-a/${10 + i}.json`, task(String(10 + i), { subject: `step ${10 + i}` })])),
}

type World = {
  files: Map<string, string>
  ran: { argv: readonly string[]; stdin: string | undefined }[]
  opened: { id: string; focus: boolean }[]
  views: TasksPaneView[]
  /** The next tasks view litter writes: a Client's post is handled after the act that made it resolves. */
  nextView: () => Promise<TasksPaneView>
  /** The next hub view: a list's window moved. */
  nextHub: () => Promise<void>
}

/** $.fs over a map under /cfg, teamfile.sh as a hook that applies the patch and answers ok, and the rest a session needs. */
function world(on: On, files: Record<string, string> = TEAM_A): World {
  const map = new Map(Object.entries(files))
  const ran: World['ran'] = []
  const opened: World['opened'] = []
  const views: TasksPaneView[] = []
  const waiting: ((v: TasksPaneView) => void)[] = []
  const hubs: (() => void)[] = []
  const isDir = (path: string) => [...map.keys()].some(k => k.startsWith(`${path}/`))
  on('fs.exists', async (_$, e) => ({ value: map.has(e.path) || isDir(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = map.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.list', async (_$, e) => {
    if (!isDir(e.path)) throw new Error(`ENOENT: ${e.path}`)
    const names = new Set([...map.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => k.slice(e.path.length + 1).split('/')[0]!))
    return { value: [...names].map(name => ({ name, kind: map.has(`${e.path}/${name}`) ? ('file' as const) : ('dir' as const), size: map.get(`${e.path}/${name}`)?.length ?? 0, mtimeMs: NOW, isLink: false })) }
  })
  on('fs.stat', async (_$, e) => {
    if (!map.has(e.path) && !isDir(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: map.has(e.path) ? 'file' : 'dir', size: map.get(e.path)?.length ?? 0, mtimeMs: NOW, isLink: false } }
  })
  on('fs.write', async (_$, e) => {
    throw new Error(`a task is written by teamfile.sh in this test: ${e.path}`)
  })
  // teamfile.sh: its argv and stdin kept, the patch applied (a null removes the key).
  on('process.run', async (_$, e) => {
    ran.push({ argv: e.argv, stdin: e.init?.stdin })
    const [, , mode, file] = e.argv
    if (mode === 'task-update' && file !== undefined && map.has(file)) {
      const patch = JSON.parse(e.init?.stdin ?? '{}') as Record<string, unknown>
      const next = { ...(JSON.parse(map.get(file)!) as Record<string, unknown>), ...patch }
      for (const [k, v] of Object.entries(patch)) if (v === null) delete next[k]
      map.set(file, JSON.stringify(next, null, 2))
    }
    return { value: { exitCode: 0, stdout: '{"ok":true}\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.list', async () => ({ value: [] }))
  on('agent.list', async () => ({ value: [] }))
  on('ui.open', async (_$, e) => {
    opened.push({ id: e.id, focus: e.focus === true })
    return { value: { isPlaced: true } }
  })
  on('ui.panes', async () => ({ value: [{ id: 'litter', title: 'litter', isShown: true, isFocused: true, isPlaced: true }] }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  // The engine's ring and window, beneath the plugins: each lands.
  on('ui.focus', async () => ({}))
  on('ui.scroll', async () => ({}))
  on('session.id', async () => ({ value: SESSION }))
  on('state.set', async (_$, e, next) => {
    if (e.key === 'tasksPane') {
      views.push(e.value as TasksPaneView)
      for (const w of waiting.splice(0)) w(e.value as TasksPaneView)
    }
    if (e.key === 'hub') for (const h of hubs.splice(0)) h()
    return next(e)
  })
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', HOME: '/home/tier1' })
  mock.store(on)
  mock.clock(on, { now: NOW })
  return {
    files: map,
    ran,
    opened,
    views,
    nextView: () => new Promise<TasksPaneView>(resolve => waiting.push(resolve)),
    nextHub: () => new Promise<void>(resolve => hubs.push(resolve)),
  }
}

/** `/litter tasks [list]`. */
const run = ($: Engine, args = '') => $.command.run({ command: 'litter', args: `tasks ${args}`.trim(), origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const mountTasks = <S extends Surface>($: Engine, surface: S, o: Over = {}) => $.ui.mount({ plugin: 'litter', surface, component: 'Pane', requestId: 'litter', props: pane(o) })
/** A terminal's drawing: a Client's pointer and keys. */
type Ui = Awaited<ReturnType<typeof mountTasks<'terminal'>>>
/** Any surface's: what every one has. */
type AnyUi = { press: Ui['press']; find: Ui['find'] }

/** Where the tasks are a Client (they have a menu to offer). */
const clientRows = (surface: Surface): boolean => surface === 'terminal' || surface === 'desktop'

/** A row's press: a click on its row in the tasks' Client (its post handled after the act, so the view it writes is awaited), else its Button. */
async function pressRow(ui: AnyUi, w: World, surface: Surface, index: number, key: string): Promise<void> {
  if (!clientRows(surface)) {
    await ui.press({ key })
    return
  }
  const next = w.nextView()
  await (ui as Ui).pointer({ type: 'down', x: 4, y: index, button: 'left', in: 'tasks:rows' })
  await next
}

/** The tasks' menu on row `index`: a right-click, ↓ `down` times, Enter; the view the pick writes awaited. */
async function menuPick(ui: Ui, w: World, index: number, down: number): Promise<void> {
  await ui.pointer({ type: 'down', x: 4, y: index, button: 'right', in: 'tasks:rows' })
  for (let i = 0; i < down; i++) await ui.key({ key: 'down', in: 'tasks:rows' })
  const next = w.nextView()
  await ui.key({ key: 'return', in: 'tasks:rows' })
  await next
}

/** The tasks' Client drawn as lines, each trimmed: a row reads as one line, though each of its cells is a Text in its color. */
const clientLines = async (ui: { drawn: Ui['drawn'] }, columns = 120): Promise<string[]> => drawText(await ui.drawn({ in: 'tasks:rows' }), columns).map(r => r.trim())

/** The pane drawn as rows, the tasks' Client in place with its own drawing (tests/drawing.ts draws a Client as its key). */
async function drawn(ui: Ui, columns: number, colors = false): Promise<string[]> {
  const draw = colors ? drawWithColors : drawText
  const rows = draw(await ui.drawn(), columns)
  const at = rows.findIndex(r => r.includes('‹Client tasks:rows›'))
  if (at < 0) return rows
  return [...rows.slice(0, at), ...draw(await ui.drawn({ in: 'tasks:rows' }), columns), ...rows.slice(at + 1)]
}

const last = (w: World) => w.views.at(-1)!.body!

describe('/litter tasks', () => {
  test("opens `litter` on the list named, with the keyboard, and writes its view: the team's tasks, read through $.fs", async ($, on) => {
    const w = world(on)
    expect(await run($, 'team-a')).toEqual(expect.objectContaining({ text: 'Tasks shows team-a (3 tasks)' }))
    expect(w.opened).toEqual([{ id: 'litter', focus: true }])
    expect(last(w).head).toEqual({ label: 'team ', name: 'team-a', note: '3 tasks · 2 open' })
    expect(last(w).rows.map(r => [r.id, r.status.text, r.blockedBy])).toEqual([
      ['1', 'completed', []],
      ['2', 'pending', []],
      ['3', 'in progress', ['2']],
    ])
  })
})

describe('the render', () => {
  for (const surface of SURFACES) {
    test(`draws the first line, the picker, the filters and the sort, the tasks, then the selected one's editor, on the ${surface}`, async ($, on) => {
      const w = world(on)
      await run($, 'team-a')
      const ui = await mountTasks($, surface)
      // The hub's header names the section; the body's first line names the list, the name in its color, and its counts.
      // (A string `text` matches by inclusion: an anchored RegExp matches a cell alone.)
      expect(await ui.find({ type: 'Text', text: ' · Tasks' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /^team $/ }))?.props).toEqual(expect.objectContaining({ bold: true, color: 'suggestion' }))
      expect((await ui.find({ type: 'Text', text: /^team-a$/ }))?.props).toEqual(expect.objectContaining({ bold: true, color: 'cyan_FOR_SUBAGENTS_ONLY' }))
      expect((await ui.find({ type: 'Text', text: '3 tasks · 2 open' }))?.props.color).toBe('inactive')
      // The picker: the chrome's list under its heading, a row per list; no Select.
      expect(await ui.find({ type: 'Text', text: /^Lists$/ })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: `tasks:pick:${SESSION}` }))?.text.trimEnd()).toBe(SESSION)
      expect((await ui.find({ type: 'Button', key: 'tasks:pick:team-a' }))?.text.trimEnd()).toBe('team-a')
      expect(await ui.find({ type: 'Select', key: 'tasks:list' })).toBeUndefined()
      // The filters: a strip, the shown one primary, each with its count.
      expect((await ui.find({ type: 'Button', key: 'tasks:filter:all' }))?.props).toEqual(expect.objectContaining({ label: 'All 3', variant: 'primary' }))
      expect((await ui.find({ type: 'Button', key: 'tasks:filter:in_progress' }))?.props).toEqual(expect.objectContaining({ label: 'In progress 1', dimColor: true }))
      if (surface === 'mobile') {
        expect(await ui.find({ type: 'Button', key: 'tasks:sort:subject' })).toBeDefined()
        expect((await ui.find({ type: 'Button', key: 'tasks:sort:id' }))?.props.label).toBe('› id')
      } else expect((await ui.find({ type: 'Select', key: 'tasks:sort' }))?.props).toEqual(expect.objectContaining({ label: 'Sort by', value: 'id' }))
      // The rows: the list's Client, with its right-click menu, where one is drawn, else Buttons; either way each cell in its own color.
      const at: { in?: string } = clientRows(surface) ? { in: 'tasks:rows' } : {}
      if (clientRows(surface)) {
        expect(await clientLines(ui)).toContainEqual(expect.stringMatching(/^#1 +✓ completed +researcher +Plan it$/))
        expect(await clientLines(ui)).toContainEqual(expect.stringMatching(/^#3 +▸ in progress +writer +⊘ blocked by #2 +Check the parser/))
      } else expect((await ui.find({ type: 'Button', key: 'tasks:select:team-a/1' }))?.text).toBe('#1')
      expect((await ui.find({ type: 'Text', text: /^▸ in progress *$/, ...at }))?.props.color).toBe('background')
      expect((await ui.find({ type: 'Text', text: /^writer *$/, ...at }))?.props.color).toBe('cyan_FOR_SUBAGENTS_ONLY')
      expect((await ui.find({ type: 'Text', text: /^unowned *$/, ...at }))?.props.color).toBe('inactive')
      expect((await ui.find({ type: 'Text', text: /^⊘ blocked by #2 *$/, ...at }))?.props.color).toBe('warning')
      // Nothing selected: no editor.
      expect(await ui.find({ type: 'Button', key: 'tasks:save:team-a/3' })).toBeUndefined()

      await pressRow(ui, w, surface, 2, 'tasks:select:team-a/3')
      expect((await ui.find({ type: 'Text', text: /^Task #3$/ }))?.props).toEqual(expect.objectContaining({ bold: true, color: 'suggestion' }))
      expect(await ui.find({ type: 'Text', text: 'blocks #4 · blocked by #1 #2' })).toBeDefined()
      const how = 'saves by a direct write: no hooks run, no assignment message'
      if (surface === 'mobile') {
        expect(await ui.find({ type: 'Text', text: 'Subject: Check the parser' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'Status: ▸ in progress' })).toBeDefined()
        expect(await ui.find({ type: 'Text', text: 'Owner: writer' })).toBeDefined()
      } else {
        expect((await ui.find({ type: 'Input', key: 'tasks:subject:team-a/3' }))?.props).toEqual(expect.objectContaining({ label: 'Subject', value: 'Check the parser' }))
        expect((await ui.find({ type: 'Input', key: 'tasks:description:team-a/3' }))?.props).toEqual(expect.objectContaining({ label: 'Description', placeholder: 'none' }))
        expect((await ui.find({ type: 'Select', key: 'tasks:status:team-a/3' }))?.props.value).toBe('in_progress')
        expect((await ui.find({ type: 'Select', key: 'tasks:owner:team-a/3' }))?.props.options).toEqual([
          { value: '', label: 'none' },
          { value: 'team-lead', label: 'team-lead' },
          { value: 'researcher', label: 'researcher' },
          { value: 'writer', label: 'writer' },
        ])
      }
      // Each field's caption says how it saves, one muted line under it; the Description's what ⏎ marks too.
      expect((await ui.find({ type: 'Text', text: how }))?.props.color).toBe('inactive')
      expect(await ui.find({ type: 'Text', text: `⏎ marks a line break · ${how}` })).toBeDefined()
      // Nothing typed: [Save] isn't primary.
      expect((await ui.find({ type: 'Button', key: 'tasks:save:team-a/3' }))?.props.variant).toBeUndefined()
      expect(await ui.find({ type: 'Button', key: 'tasks:revert:team-a/3' })).toBeDefined()
    })
  }
})

/** A view as a reload left it in $.state: team-a's, #3 selected with an edit, its file changed on disk since, and a file that couldn't be read. */
const VIEW: TasksPaneView = {
  view: 'tasks',
  v: 4,
  body: {
    head: { label: 'team ', name: 'team-a', note: '2 tasks · 1 open' },
    notice: { level: 'ok', text: '#1 written directly: no hooks ran' },
    list: 'team-a',
    lists: [
      { value: SESSION, label: SESSION, kind: 'this session', mine: true, open: 0, total: 0, description: `no tasks · /cfg/tasks/${SESSION}` },
      { value: 'team-a', label: 'team-a', kind: 'team', mine: false, open: 1, total: 2, description: '2 tasks, 1 open · member researcher · /cfg/tasks/team-a' },
    ],
    hidden: '13 empty session teams hidden',
    hiddenCount: 13,
    showEmpty: false,
    picking: false,
    listName: 'team-a',
    filter: 'all',
    counts: { all: 2, pending: 0, in_progress: 1, completed: 1 },
    sort: 'id',
    rows: [
      { id: '1', status: { text: 'completed', color: 'success', glyph: '✓' }, owner: 'researcher', blockedBy: [], subject: 'Plan it', selected: false, description: '', links: '', can: { start: true, complete: false, assign: true } },
      {
        id: '3',
        status: { text: 'in progress', color: 'background', glyph: '▸' },
        owner: null,
        blockedBy: ['2'],
        subject: 'Check it',
        selected: true,
        description: 'one two',
        links: 'blocked by #1 #2',
        can: { start: false, complete: true, assign: true },
      },
    ],
    empty: null,
    problems: ['#5: not JSON'],
    editor: {
      id: '3',
      subject: 'Check it twice',
      description: 'one⏎two',
      descriptionText: 'one\ntwo',
      status: 'in_progress',
      statuses: [
        { value: 'pending', label: '· pending' },
        { value: 'in_progress', label: '▸ in progress' },
        { value: 'completed', label: '✓ completed' },
      ],
      owner: '',
      owners: [
        { value: '', label: 'none' },
        { value: 'researcher', label: 'researcher' },
      ],
      links: 'blocked by #1 #2',
      dirty: true,
      changed: true,
      via: 'direct',
    },
  },
}

/** The hub's view with Tasks shown: the strip's tabs drawn from nothing counted. */
const HUB: HubView = { view: 'hub', v: 1, section: 'tasks', live: [], tabs: [] }

/** $.state as a reload left it: the hub on Tasks, and Tasks' view. */
const seeded = (on: On) =>
  on('state.get', async (_$, e, next) => (e.key === 'tasksPane' ? { value: { value: VIEW, version: 1 } } : e.key === 'hub' ? { value: { value: HUB, version: 1 } } : next(e)))

describe('a view as a reload left it, the editor open', () => {
  for (const surface of ['terminal', 'desktop'] as const) {
    test(`draws its notices, the picker's hidden lists, the editor's banner with [Reload], [Save] not primary while the file moved, on the ${surface}`, async ($, on) => {
      mock.store(on)
      seeded(on)
      const ui = await mountTasks($, surface)
      expect(await ui.find({ type: 'Text', text: '✓ #1 written directly: no hooks ran' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: '! not read: #5: not JSON' }))?.props.color).toBe('warning')
      expect((await ui.find({ type: 'Text', text: '13 empty session teams hidden' }))?.props.color).toBe('inactive')
      expect((await ui.find({ type: 'Button', key: 'tasks:empty:show' }))?.props.label).toBe('Show all')
      expect(await clientLines(ui)).toContainEqual(expect.stringMatching(/^(› )?#3 +▸ in progress +unowned +⊘ blocked by #2 +Check it( |$)/))
      expect((await ui.find({ type: 'Input', key: 'tasks:subject:team-a/3' }))?.props.value).toBe('Check it twice')
      expect((await ui.find({ type: 'Input', key: 'tasks:description:team-a/3' }))?.props.value).toBe('one⏎two')
      expect((await ui.find({ type: 'Text', text: 'one\ntwo' }))?.props.color).toBe('inactive')
      expect((await ui.find({ type: 'Text', text: "! #3 changed on disk since your edit began: [Reload] takes the file's version and drops yours" }))?.props.color).toBe('warning')
      expect((await ui.find({ type: 'Button', key: 'tasks:reload:team-a/3' }))?.props.label).toBe('Reload')
      expect((await ui.find({ type: 'Button', key: 'tasks:save:team-a/3' }))?.props.variant).toBeUndefined()
      expect((await ui.find({ type: 'Button', key: 'tasks:revert:team-a/3' }))?.props.dimColor).toBe(true)
    })
  }

  test('with no Client (the mobile app), the rows are Buttons and the sort Buttons; the fields are text', async ($, on) => {
    mock.store(on)
    seeded(on)
    const ui = await mountTasks($, 'mobile')
    expect(await ui.find({ type: 'Button', key: 'tasks:pick:team-a' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'tasks:select:team-a/3' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'tasks:sort:subject' })).toBeDefined()
    expect(await ui.find({ type: 'Select' })).toBeUndefined()
    expect(await ui.find({ type: 'Input' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Subject: Check it twice' })).toBeDefined()
  })
})

describe('every action, by press', () => {
  test('a filter, the sort, a row, the editor: Status and Owner picked, [Save] runs teamfile.sh with the patch; [Revert]', async ($, on) => {
    const w = world(on)
    await run($, 'team-a')
    const ui = await mountTasks($, 'vscode')
    expect(await ui.press({ key: 'tasks:filter:pending' })).toEqual(expect.objectContaining({ element: 'tasks:filter:pending' }))
    expect(last(w).rows.map(r => r.id)).toEqual(['2'])
    expect((await ui.find({ type: 'Button', key: 'tasks:filter:pending' }))?.props.variant).toBe('primary')
    await ui.press({ key: 'tasks:filter:all' })
    expect(await ui.select({ key: 'tasks:sort', value: 'subject' })).toEqual(expect.objectContaining({ element: 'tasks:sort', value: 'subject' }))
    expect(last(w).rows.map(r => r.id)).toEqual(['3', '2', '1'])
    await ui.press({ key: 'tasks:select:team-a/2' })
    expect(await ui.select({ key: 'tasks:owner:team-a/2', value: 'researcher' })).toEqual(expect.objectContaining({ element: 'tasks:owner:team-a/2', value: 'researcher' }))
    await ui.select({ key: 'tasks:status:team-a/2', value: 'in_progress' })
    expect((await ui.find({ type: 'Button', key: 'tasks:save:team-a/2' }))?.props.variant).toBe('primary')
    expect(await ui.press({ key: 'tasks:save:team-a/2' })).toEqual(expect.objectContaining({ element: 'tasks:save:team-a/2' }))
    const [sh, script, mode, file, flag, cutoff] = w.ran[0]!.argv
    expect([sh, script?.endsWith('/hooks/teamfile.sh'), mode, file, flag, cutoff]).toEqual(['sh', true, 'task-update', '/cfg/tasks/team-a/2.json', '--stale-before', '202701151259.50'])
    expect(JSON.parse(w.ran[0]!.stdin ?? '')).toEqual({ status: 'in_progress', owner: 'researcher' })
    expect(await ui.find({ type: 'Text', text: '✓ #2 written directly: no hooks ran, and no assignment message was sent' })).toBeDefined()
    expect(last(w).rows.find(r => r.id === '2')).toMatchObject({ owner: 'researcher', status: { text: 'in progress' } })
    await ui.input({ key: 'tasks:subject:team-a/2', text: 'Draft it', kind: 'submit' })
    expect(last(w).editor).toMatchObject({ subject: 'Draft it', dirty: true })
    await ui.press({ key: 'tasks:revert:team-a/2' })
    expect(await ui.find({ type: 'Text', text: '· your edit of #2 was dropped' })).toBeDefined()
  })

  test("where no Client is drawn, the focused row carries its menu's actions as Buttons: Edit, the marks, Assign to…, each acting", async ($, on) => {
    const w = world(on)
    await run($, 'team-a')
    const ui = await mountTasks($, 'vscode')
    await $.ui.focus({ component: 'Pane', requestId: 'litter', plugin: 'litter', element: 'tasks:select:team-a/2', origin: { kind: 'person' } })
    for (const key of ['tasks:edit:team-a/2', 'tasks:start:team-a/2', 'tasks:complete:team-a/2', 'tasks:assign:team-a/2']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
    // The focused row's description beside it: the task's, on one line.
    expect(await ui.find({ type: 'Text', text: 'the install page first then the reference' })).toBeDefined()
    await ui.press({ key: 'tasks:assign:team-a/2' })
    expect(last(w).editor?.id).toBe('2')
    expect(await ui.find({ type: 'Text', text: "· pick #2's owner under Owner, then [Save]" })).toBeDefined()
    await ui.press({ key: 'tasks:start:team-a/2' })
    expect(JSON.parse(w.ran.at(-1)!.stdin ?? '')).toEqual({ status: 'in_progress' })
    expect(await ui.find({ type: 'Text', text: '✓ #2 marked in progress, written directly: no hooks ran' })).toBeDefined()
    await ui.press({ key: 'tasks:complete:team-a/2' })
    expect(JSON.parse(w.files.get('/cfg/tasks/team-a/2.json')!).status).toBe('completed')
    // The ring on #1: its Edit opens the editor on it.
    await $.ui.focus({ component: 'Pane', requestId: 'litter', plugin: 'litter', element: 'tasks:select:team-a/1', origin: { kind: 'person' } })
    expect(await ui.find({ type: 'Button', key: 'tasks:edit:team-a/2' })).toBeUndefined()
    await ui.press({ key: 'tasks:edit:team-a/1' })
    expect(last(w).editor?.id).toBe('1')
  })

  test('[Change] opens the folded picker inline; a pick shows that list and folds it; [Show all] and [Hide empty]', async ($, on) => {
    const w = world(on, TWENTY)
    await run($, 'team-a')
    const ui = await mountTasks($, 'terminal', { placement: 'inline', bodyColumns: 100 })
    // Inline the picker is one line naming the list shown, with [Change].
    expect(await ui.find({ type: 'Text', text: '· 2 others, 17 empty hidden' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'tasks:pick:team-a' })).toBeUndefined()
    await ui.press({ key: 'tasks:picker:open' })
    expect(await ui.find({ type: 'Button', key: 'tasks:pick:team-b' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '17 empty session teams hidden' })).toBeDefined()
    await ui.press({ key: 'tasks:pick:team-b' })
    expect(last(w)).toMatchObject({ listName: 'team-b', picking: false })
    expect(await ui.find({ type: 'Button', key: 'tasks:pick:team-a' })).toBeUndefined()
    await ui.press({ key: 'tasks:picker:open' })
    await ui.press({ key: 'tasks:empty:show' })
    expect(last(w).lists).toHaveLength(20)
    expect(await ui.find({ type: 'Text', text: 'every list shown, the empty ones too' })).toBeDefined()
    await ui.press({ key: 'tasks:empty:hide' })
    expect(last(w).lists).toHaveLength(3)
  })
})

describe("the tasks' menu", () => {
  test('a right-click on a row offers Edit, the marks that apply and Assign to…; a pick acts as the editor does', async ($, on) => {
    const w = world(on)
    await run($, 'team-a')
    const ui = await mountTasks($, 'terminal')
    // #2 waits: Edit, Mark in progress, Mark completed, Assign to….
    await ui.pointer({ type: 'down', x: 4, y: 1, button: 'right', in: 'tasks:rows' })
    for (const item of ['Edit', 'Mark in progress', 'Mark completed', 'Assign to…']) expect(await ui.find({ type: 'Text', text: new RegExp(` ${item} *$`), in: 'tasks:rows' })).toBeDefined()
    await ui.pointer({ type: 'down', x: 4, y: 1, button: 'right', in: 'tasks:rows' })
    await menuPick(ui, w, 1, 1)
    expect(JSON.parse(w.ran.at(-1)!.stdin ?? '')).toEqual({ status: 'in_progress' })
    expect(await ui.find({ type: 'Text', text: '✓ #2 marked in progress, written directly: no hooks ran' })).toBeDefined()
    // #3 is under way now and was: Edit, Mark completed, Assign to….
    await ui.pointer({ type: 'down', x: 4, y: 2, button: 'right', in: 'tasks:rows' })
    expect(await ui.find({ type: 'Text', text: / Mark in progress *$/, in: 'tasks:rows' })).toBeUndefined()
    await ui.pointer({ type: 'down', x: 4, y: 2, button: 'right', in: 'tasks:rows' })
    await menuPick(ui, w, 2, 1)
    expect(JSON.parse(w.files.get('/cfg/tasks/team-a/3.json')!).status).toBe('completed')
    // Edit: the editor opens on it; Assign to… on #1 too, saying where the owner is picked.
    await menuPick(ui, w, 0, 0)
    expect(last(w).editor?.id).toBe('1')
    await menuPick(ui, w, 1, 2)
    expect(last(w).editor?.id).toBe('2')
    expect(last(w).notice).toEqual({ level: 'info', text: "pick #2's owner under Owner, then [Save]" })
  })
})

describe('the windows', () => {
  test("twenty lists, most of them empty session teams: [Show all] lists them in the picker's window of five, and its footer moves it", async ($, on) => {
    const w = world(on, TWENTY)
    await run($, 'team-a')
    const ui = await mountTasks($, 'terminal', { bodyColumns: 100, bodyRows: 40 })
    expect(last(w).lists.map(l => l.value)).toEqual([SESSION, 'team-a', 'team-b'])
    expect(last(w).lists.map(l => [l.open, l.total])).toEqual([
      [1, 1],
      [2, 3],
      [0, 1],
    ])
    await ui.press({ key: 'tasks:empty:show' })
    // This session's first, then the teams in the store's order (newest, then by name): the session teams before team-a.
    expect(last(w).lists.map(l => l.value).slice(0, 3)).toEqual([SESSION, sessionTeam(0), sessionTeam(1)])
    expect((await ui.find({ type: 'Button', key: 'tasks:lists:down' }))?.text).toBe('↓ 15 more')
    expect(await ui.find({ type: 'Button', key: `tasks:pick:${sessionTeam(3)}` })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: `tasks:pick:${sessionTeam(4)}` })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'tasks:pick:team-a' })).toBeUndefined()
    await ui.press({ key: 'tasks:lists:down' })
    // A page: the window less a row.
    expect((await ui.find({ type: 'Button', key: 'tasks:lists:up' }))?.text).toBe('↑ 4 above')
    expect(await ui.find({ type: 'Button', key: `tasks:pick:${sessionTeam(7)}` })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: `tasks:pick:${sessionTeam(8)}` })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: `tasks:pick:${SESSION}` })).toBeUndefined()
    await ui.press({ key: 'tasks:lists:up' })
    expect(await ui.find({ type: 'Button', key: `tasks:pick:${SESSION}` })).toBeDefined()
  })

  test("the tasks' window: the Client's ↓ past its last row moves it; on the mobile app its footer pages it as that dock drew it", async ($, on) => {
    const w = world(on, LONG)
    await run($, 'team-a')
    const ui = await mountTasks($, 'terminal', { bodyColumns: 100, bodyRows: 30 })
    const rows = drawText(await ui.drawn({ in: 'tasks:rows' }), 100)
    const shown = rows.filter(r => /^ *#\d+/.test(r)).length
    expect(shown).toBeGreaterThan(10)
    expect(rows.at(-1)).toMatch(new RegExp(`^ +↓ ${33 - shown} more · right-click a row for its actions$`))
    // ↓ lights the rows down to the last; once more, and the window moves (the Client posts its offset to the hub).
    for (let i = 0; i < shown - 1; i++) await ui.key({ key: 'down', in: 'tasks:rows' })
    const moved = w.nextHub()
    await ui.key({ key: 'down', in: 'tasks:rows' })
    await moved
    expect(drawText(await ui.drawn({ in: 'tasks:rows' }), 100).at(-1)).toMatch(new RegExp(`^ +↑ 1 above · ↓ ${33 - shown - 1} more · right-click a row for its actions$`))

    // The mobile app: Buttons, and the footer pages the window as that dock drew it.
    const phone = await mountTasks($, 'mobile', { bodyColumns: 60, bodyRows: 30 })
    await phone.press({ key: 'tasks:rows:up' }).catch(() => undefined)
    const drawnRows = () => phone.drawn().then(t => drawText(t, 60).filter(r => /^[ ›] #\d+ /.test(r)).length)
    const onPhone = await drawnRows()
    // Its window is taller than the terminal's (no keys line): a page there is its window less a row, to the end at most.
    expect(onPhone).toBeGreaterThan(shown)
    expect((await phone.find({ type: 'Button', key: 'tasks:rows:down' }))?.text).toBe(`↓ ${33 - onPhone} more`)
    await phone.press({ key: 'tasks:rows:down' })
    expect((await phone.find({ type: 'Button', key: 'tasks:rows:up' }))?.text).toBe(`↑ ${Math.min(onPhone - 1, 33 - onPhone)} above`)
    expect(await phone.find({ type: 'Button', key: 'tasks:rows:down' })).toBeUndefined()
  })
})

/** The body as drawn: its first line to its last, the hub's chrome left out. */
function bodyOf(rows: readonly string[], first: string, lastLine: string): string[] {
  const from = rows.findIndex(r => r.startsWith(first))
  const to = rows.findIndex((r, i) => i >= from && r.includes(lastLine))
  return rows.slice(from, to + 1)
}

/** Rows with the colors beside each, as drawWithColors writes them. */
const golden = (columns: number, rows: readonly [string, string][]): string[] => rows.map(([text, colors]) => (colors === '' ? text : `${text.padEnd(columns)}  | ${colors}`))

/** A heading: its title, the faint rule, its note and the rule's tail (chrome.tsx's heading). */
const ruled = (title: string, columns: number, note?: string): string =>
  note === undefined ? `${title} ${'─'.repeat(columns - title.length - 1)}` : `${title} ${'─'.repeat(columns - title.length - note.length - 5)} ${note} ──`
const HEADING = 'suggestion bold, subtle, inactive, subtle'
const NAMED = 'suggestion bold, cyan_FOR_SUBAGENTS_ONLY bold, subtle, inactive, subtle'
/** A field in its frame (the terminal's), its middle row's colors. */
const framed = (text: string, columns: number, colors: string): [string, string][] => [
  [`╭${'─'.repeat(columns - 2)}╮`, 'promptBorder'],
  [`│ ${text.padEnd(columns - 4)} │`, colors],
  [`╰${'─'.repeat(columns - 2)}╯`, 'promptBorder'],
]
const HOW = 'saves by a direct write: no hooks run, no assignment message'

/**
 * The drawings in WP-DF's report, each row's colors beside it. The picker
 * is the chrome's list (Buttons: it has no menu), each row's description
 * beside it, faint but for the focused one's; the tasks are its Client,
 * drawn by its module (ui/listmenu.tsx), each cell in its color (the
 * status's, the owner's, the blocked line's).
 */
const TEAM_ROWS = (columns: number): [string, string][] => [
  [ruled('team team-a', columns, '3 tasks · 2 open'), NAMED],
  [ruled('Lists', columns, '3 lists'), HEADING],
  ...(columns >= 100
    ? ([
        ['  tier1-session 1 open this session 1 task, 1 open · /cfg/tasks/tier1-session', 'default, inactive, subtle'],
        ['› team-a        2 open team         3 tasks, 2 open · lead team-lead · members researcher, writer ·…', 'claude, default, inactive, subtle'],
        ['  team-b        0 open team         1 task, 0 open · lead team-lead · /cfg/tasks/team-b', 'default, inactive, subtle'],
      ] as [string, string][])
    : ([
        ['  tier1-session 1 open this session 1 task, 1 open · /cfg/t…', 'default, inactive, subtle'],
        ['› team-a        2 open team         3 tasks, 2 open · lead …', 'claude, default, inactive, subtle'],
        ['  team-b        0 open team         1 task, 0 open · lead t…', 'default, inactive, subtle'],
      ] as [string, string][])),
  ['17 empty session teams hidden [ Show all ]', 'inactive, default dim'],
  [ruled('Tasks', columns), 'suggestion bold, subtle'],
  ['[ All 3 ] [ Pending 1 ] [ In progress 1 ] [ Completed 1 ]', 'claude, default dim'],
  ['Sort by: id ▾', 'default'],
  ...(columns >= 100
    ? ([
        ['  #1 ✓ completed   researcher                 Plan it', 'default, success, cyan_FOR_SUBAGENTS_ONLY, default'],
        ['  #2 · pending     unowned                    Draft the user guide the install page first then the …', 'default, inactive, default, subtle'],
        [
          '› #3 ▸ in progress writer     ⊘ blocked by #2 Check the parser     blocks #4 · blocked by #1 #2',
          'claude, default bold, background bold, cyan_FOR_SUBAGENTS_ONLY bold, warning bold, default bold, inactive',
        ],
        ['  right-click a row for its actions', 'inactive'],
      ] as [string, string][])
    : ([
        // Under SUBJECT_MIN beside the owner: its column goes; the lit row's description is the Client's line.
        ['  #1 ✓ completed                   Plan it', 'default, success, default'],
        ['  #2 · pending                     Draft the user guide', 'default, inactive, default'],
        ['› #3 ▸ in progress ⊘ blocked by #2 Check the parser', 'claude, default bold, background bold, warning bold, default bold'],
        ['  blocks #4 · blocked by #1 #2', 'inactive'],
      ] as [string, string][])),
  [ruled('Task #3', columns, 'blocks #4 · blocked by #1 #2'), HEADING],
  ...framed('Subject: Check the parser', columns, 'promptBorder, default, promptBorder'),
  [HOW, 'inactive'],
  ...framed('Description: none', columns, 'promptBorder, default, default dim, promptBorder'),
  [columns >= 100 ? `⏎ marks a line break · ${HOW}` : '⏎ marks a line break · saves by a direct write: no hooks ru…', 'inactive'],
  ['Status: ▸ in progress ▾', 'default'],
  ['Owner: writer ▾', 'default'],
  ['[ Save ] [ Revert ]', 'default dim'],
]

const INLINE_ROWS = (columns: number): [string, string][] => [
  [ruled('team team-a', columns, '3 tasks · 2 open'), NAMED],
  ['List team-a · 2 others, 17 empty hidden [ Change ]', 'inactive, cyan_FOR_SUBAGENTS_ONLY, inactive, default dim'],
  ['[ All 3 ] [ Pending 1 ] [ In progress 1 ] [ Completed 1 ]', 'claude, default dim'],
  ['Sort by: id ▾', 'default'],
  ...(columns >= 100
    ? ([
        ['  #1 ✓ completed   researcher                 Plan it', 'default, success, cyan_FOR_SUBAGENTS_ONLY, default'],
        ['  #2 · pending     unowned                    Draft the user guide the install page first then the …', 'default, inactive, default, subtle'],
        ['  #3 ▸ in progress writer     ⊘ blocked by #2 Check the parser     blocks #4 · blocked by #1 #2', 'default, background, cyan_FOR_SUBAGENTS_ONLY, warning, default, subtle'],
      ] as [string, string][])
    : ([
        ['  #1 ✓ completed                   Plan it', 'default, success, default'],
        ['  #2 · pending                     Draft the user guide', 'default, inactive, default'],
        ['  #3 ▸ in progress ⊘ blocked by #2 Check the parser', 'default, background, warning, default'],
      ] as [string, string][])),
  ['  right-click a row for its actions', 'inactive'],
]

describe('the drawings', () => {
  for (const columns of [100, 60]) {
    test(`team-a at ${columns} columns, docked in 40 rows, #3 selected: the body keeps to its rows, the keys line under it`, async ($, on) => {
      const w = world(on, TWENTY)
      await run($, 'team-a')
      const ui = await mountTasks($, 'terminal', { bodyColumns: columns, bodyRows: 40 })
      await pressRow(ui, w, 'terminal', 2, 'tasks:select:team-a/3')
      const rows = await drawn(ui, columns, true)
      expect(bodyOf(rows, 'team team-a', '[ Revert ]')).toEqual(golden(columns, TEAM_ROWS(columns)))
      expect(rows.at(-1)).toMatch(/^ctrl\+x tab gives the pane the keys/)
    })

    test(`team-a at ${columns} columns, inline: the picker folded to its line`, async ($, on) => {
      world(on, TWENTY)
      await run($, 'team-a')
      const ui = await mountTasks($, 'terminal', { bodyColumns: columns, placement: 'inline' })
      expect(bodyOf(await drawn(ui, columns, true), 'team team-a', 'right-click a row')).toEqual(golden(columns, INLINE_ROWS(columns)))
    })
  }

  // The user's live look (2026-10-07): a description wider than its field drew `Descriptioncodex-prober: …` with its
  // `:` on a second row, the engine's Input squeezing its own label. The field keeps its one row and the label whole.
  test('a one-line description wider than its field: the label whole on the one row, the value cut, the whole of it under the field; holding the ring, the label is the Input’s again', async ($, on) => {
    const long = 'codex-prober: P1 install from a local marketplace, P2 the hooks it runs, P3 the app server'
    const w = world(on, { ...TEAM_A, '/cfg/tasks/team-a/3.json': task('3', { status: 'in_progress', subject: 'Check the parser', owner: 'writer', description: long }) })
    await run($, 'team-a')
    const ui = await mountTasks($, 'terminal', { bodyColumns: 60, bodyRows: 40, isFocused: true })
    await pressRow(ui, w, 'terminal', 2, 'tasks:select:team-a/3')
    expect(bodyOf(await drawn(ui, 60, true), 'Task #3', 'Status:')).toEqual(
      golden(60, [
        [ruled('Task #3', 60), 'suggestion bold, subtle'],
        ...framed('Subject: Check the parser', 60, 'promptBorder, default, promptBorder'),
        [HOW, 'inactive'],
        ...framed('Description: codex-prober: P1 install from a local marke', 60, 'promptBorder, default, promptBorder'),
        ['⏎ marks a line break · saves by a direct write: no hooks ru…', 'inactive'],
        ['codex-prober: P1 install from a local marketplace, P2 the', 'inactive'],
        ['hooks it runs, P3 the app server', 'inactive'],
        ['Status: ▸ in progress ▾', 'default'],
      ]),
    )
    const key = 'tasks:description:team-a/3'
    expect((await ui.find({ type: 'Input', key }))?.props).toEqual(expect.objectContaining({ value: long }))
    expect((await ui.find({ type: 'Input', key }))?.props.label).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Description:' })).toBeDefined()
    // A subject that fits keeps the engine's label.
    expect((await ui.find({ type: 'Input', key: 'tasks:subject:team-a/3' }))?.props.label).toBe('Subject')
    await $.ui.focus({ component: 'Pane', requestId: 'litter', plugin: 'litter', element: key, origin: { kind: 'person' } })
    expect((await ui.find({ type: 'Input', key }))?.props.label).toBe('Description')
    expect(await ui.find({ type: 'Text', text: 'Description:' })).toBeUndefined()
  })
})
