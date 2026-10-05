// Tier 1: /litter-tasks and the tasks pane as the engine runs and draws them
// (WP-CE; COMMON decisions 4, 15, 16). The config dir is /cfg, its files a
// map behind $.fs, and teamfile.sh a process.run hook that records its argv
// and stdin: the command opens the pane on a team's list and writes its view;
// the render draws the rows, the filters, the editor's fields and buttons on
// the terminal and the desktop, and buttons in place of Selects on mobile;
// a row's press, a pick and [Save] answer in their events' shapes, and the
// save runs teamfile.sh with the patch.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { TasksPaneView } from '../types/index'

const SESSION = 'tier1-session'
const SURFACES = ['terminal', 'desktop'] as const

const pane = (title: string) =>
  ({ title, isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }) as const

const task = (id: string, over: Record<string, unknown> = {}) =>
  JSON.stringify({ id, subject: `task ${id}`, description: '', status: 'pending', blocks: [], blockedBy: [], ...over }, null, 2)

/** $.fs over a map under /cfg, teamfile.sh as a hook that answers ok, and the rest a session needs. */
function world(on: On): { files: Map<string, string>; ran: { argv: readonly string[]; stdin: string | undefined }[]; opened: string[] } {
  const files = new Map<string, string>([
    ['/cfg/teams/team-a/config.json', JSON.stringify({ name: 'team-a', leadSessionId: 'someone-else', members: [{ name: 'researcher', agentId: 'r@team-a' }] })],
    ['/cfg/tasks/team-a/1.json', task('1', { status: 'completed', subject: 'Plan it', owner: 'researcher' })],
    ['/cfg/tasks/team-a/3.json', task('3', { status: 'in_progress', subject: 'Check it', blockedBy: ['1', '2'] })],
  ])
  const ran: { argv: readonly string[]; stdin: string | undefined }[] = []
  const opened: string[] = []
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.list', async (_$, e) => {
    if (!isDir(e.path)) throw new Error(`ENOENT: ${e.path}`)
    const names = new Set([...files.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => k.slice(e.path.length + 1).split('/')[0]!))
    return { value: [...names].map(name => ({ name, kind: files.has(`${e.path}/${name}`) ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', async (_$, e) => {
    if (!files.has(e.path) && !isDir(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: files.has(e.path) ? 'file' : 'dir', size: files.get(e.path)?.length ?? 0, mtimeMs: 1_800_000_000_000, isLink: false } }
  })
  on('process.run', async (_$, e) => {
    ran.push({ argv: e.argv, stdin: e.init?.stdin })
    return { value: { exitCode: 0, stdout: '{"ok":true}\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.list', async () => ({ value: [] }))
  on('ui.open', async (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  on('session.id', async () => ({ value: SESSION }))
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg' })
  return { files, ran, opened }
}

const run = ($: Engine, args = '') => $.command.run({ command: 'litter-tasks', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

const mountTasks = <S extends 'terminal' | 'desktop' | 'vscode' | 'mobile'>($: Engine, surface: S) =>
  $.ui.mount({ plugin: 'litter', surface, component: 'Pane', requestId: 'litter-tasks', props: pane('litter tasks') })

/** A built view, as view.ts writes it: team-a's two tasks, #3 selected and edited. */
const VIEW: TasksPaneView = {
  view: 'tasks',
  v: 4,
  body: {
    title: [{ text: 'litter · tasks', bold: true }, { text: ' · team-a' }],
    notice: { level: 'ok', text: '#3 written directly: no hooks ran' },
    list: 'team-a',
    lists: [
      { value: SESSION, label: `${SESSION} · this session's · 0 tasks` },
      { value: 'team-a', label: 'team-a · team · 2 tasks' },
    ],
    listName: 'team-a',
    filter: 'all',
    counts: { all: 2, pending: 0, in_progress: 1, completed: 1 },
    sort: 'id',
    rows: [
      { id: '1', status: { text: 'completed', color: 'success', glyph: '✓' }, owner: 'researcher', blockedBy: [], subject: 'Plan it', selected: false },
      { id: '3', status: { text: 'in progress', color: 'background', glyph: '▸' }, owner: null, blockedBy: ['2'], subject: 'Check it', selected: true },
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

describe('/litter-tasks', () => {
  test("opens the pane on the list named and writes its view: the team's tasks, read through $.fs", async ($, on) => {
    mock.store(on)
    const w = world(on)
    expect(await run($, 'team-a')).toEqual(expect.objectContaining({ text: 'litter: the tasks pane shows team-a (2 tasks)' }))
    expect(w.opened).toEqual(['litter-tasks'])
    const ui = await mountTasks($, 'terminal')
    expect((await ui.find({ type: 'Button', key: 'tasks:select:team-a/3' }))?.text).toBe('#3')
    expect(await ui.find({ type: 'Text', text: /⊘ blocked by #2/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'tasks:filter:all' })).toBeDefined()
  })
})

describe('the render', () => {
  for (const surface of SURFACES) {
    test(`draws the rows, the filters and the editor for a view, on the ${surface}`, async ($, on) => {
      mock.store(on)
      on('state.get', async (_$, e, next) => (e.key === 'tasksPane' ? { value: { value: VIEW, version: 1 } } : next(e)))
      const ui = await mountTasks($, surface)
      expect(await ui.find({ type: 'Text', text: 'litter · tasks' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /written directly: no hooks ran/ })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'tasks:filter:all' }))?.text).toBe('› All 2')
      expect((await ui.find({ type: 'Button', key: 'tasks:filter:in_progress' }))?.text).toBe('In progress 1')
      expect(await ui.find({ type: 'Select', key: 'tasks:list' })).toBeDefined()
      expect(await ui.find({ type: 'Select', key: 'tasks:sort' })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'tasks:select:team-a/1' }))?.text).toBe('#1')
      expect(await ui.find({ type: 'Text', text: /✓ completed/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'researcher' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'unowned' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '⊘ blocked by #2' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '! #5: not JSON' })).toBeDefined()
      expect(await ui.find({ type: 'Input', key: 'tasks:subject:team-a/3' })).toBeDefined()
      expect(await ui.find({ type: 'Input', key: 'tasks:description:team-a/3' })).toBeDefined()
      expect(await ui.find({ type: 'Select', key: 'tasks:status:team-a/3' })).toBeDefined()
      expect(await ui.find({ type: 'Select', key: 'tasks:owner:team-a/3' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /changed on disk since you began editing/ })).toBeDefined()
      for (const key of ['tasks:save:team-a/3', 'tasks:revert:team-a/3', 'tasks:reload:team-a/3']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
    })
  }

  test('on mobile, with no Select, the lists and the sort are buttons', async ($, on) => {
    mock.store(on)
    on('state.get', async (_$, e, next) => (e.key === 'tasksPane' ? { value: { value: VIEW, version: 1 } } : next(e)))
    const ui = await mountTasks($, 'mobile')
    expect(await ui.find({ type: 'Button', key: 'tasks:pick:team-a' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'tasks:sort:subject' })).toBeDefined()
    expect(await ui.find({ type: 'Select', key: 'tasks:list' })).toBeUndefined()
  })
})

describe('the events', () => {
  test("a row's press, a pick and [Save] answer in their shapes, and the save runs teamfile.sh with the patch", async ($, on) => {
    mock.store(on)
    // The stale cutoff is the mod's now less 10 s.
    mock.clock(on, { now: Date.UTC(2026, 9, 5, 12, 0, 10) })
    const w = world(on)
    await run($, 'team-a')
    const ui = await mountTasks($, 'desktop')
    expect(await ui.press({ key: 'tasks:select:team-a/3' })).toEqual(expect.objectContaining({ element: 'tasks:select:team-a/3' }))
    expect(await ui.find({ type: 'Input', key: 'tasks:subject:team-a/3' })).toBeDefined()
    expect(await ui.select({ key: 'tasks:owner:team-a/3', value: 'researcher' })).toEqual(expect.objectContaining({ element: 'tasks:owner:team-a/3', value: 'researcher' }))
    expect(await ui.press({ key: 'tasks:save:team-a/3' })).toEqual(expect.objectContaining({ element: 'tasks:save:team-a/3' }))
    const said = await ui.findAll({ type: 'Text', text: /#3/ })
    expect({ ran: w.ran.length, said: said.map(t => t.text) }).toEqual({ ran: 1, said: expect.anything() })
    const [sh, script, mode, file, flag, cutoff] = w.ran[0]!.argv
    expect([sh, script?.endsWith('/hooks/teamfile.sh'), mode, file, flag, cutoff]).toEqual(['sh', true, 'task-update', '/cfg/tasks/team-a/3.json', '--stale-before', '202610051200.00'])
    expect(JSON.parse(w.ran[0]!.stdin ?? '')).toEqual({ owner: 'researcher' })
    expect(await ui.find({ type: 'Text', text: /#3 written directly: no hooks ran, and no assignment message was sent/ })).toBeDefined()
  })
})
