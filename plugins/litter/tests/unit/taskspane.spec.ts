// Tier 2: the tasks pane's view and events (WP-CE; COMMON decisions 4, 15,
// 16), over a temporary config dir and the real store: the filters' counts,
// the sort, blocked state, the editor's values surviving a rebuild, [Save]'s
// three notices, the refusal when the file changed under an edit, stale
// presses, a list that went empty, the tick's change check, and the
// navigation restored after a module reset.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TasksBody, TasksPaneView } from '../../types/index'
import type { TaskListRef } from '../../hooks/uitypes'
import { onTasksUi, refreshTasks, resetTasksPaneForTests, tasksCommand, tasksTick } from '../../hooks/tasks/pane'
import { LITTER_PANE as TASKS_PANE, resetHubForTests } from '../../hooks/ui/hub'
import { EMPTIED_DONE, EMPTIED_GONE, LINE_MARK, TASKS_STORE_KEY, deps, hiddenList, hiddenNote, tasksNavOf } from '../../hooks/tasks/view'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

// teamfile.sh runs for real on a direct save; a loaded machine is slow.
setDefaultTimeout(60_000)

const SESSION = 'sess-pane'
const cleanups: (() => void)[] = []
beforeEach(() => {
  resetTasksPaneForTests()
  resetHubForTests()
})
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  resetTasksPaneForTests()
  resetHubForTests()
})

type Task = { id: string; subject?: string; description?: string; status?: string; owner?: string; blocks?: string[]; blockedBy?: string[] }

function world(): { p: TestPorts; config: string } {
  const s = scratch('litter-taskspane-')
  cleanups.push(s.cleanup)
  const config = join(s.dir, 'config')
  mkdirSync(config)
  const p = nodePorts({ sessionId: SESSION })
  p.configDirValue = config
  return { p, config }
}

let mtime = 1_800_000_000
/** Writes task files into a list's folder, each with an mtime of its own, so a change always moves it. */
function write(config: string, list: string, tasks: Task[]): void {
  const dir = join(config, 'tasks', list)
  mkdirSync(dir, { recursive: true })
  for (const t of tasks) {
    const path = join(dir, `${t.id}.json`)
    writeFileSync(path, JSON.stringify({ subject: `task ${t.id}`, description: '', status: 'pending', blocks: [], blockedBy: [], ...t }, null, 2))
    mtime += 10
    utimesSync(path, mtime, mtime)
  }
}

const team = (config: string, name: string, members: string[], lead: string | null = null) => {
  mkdirSync(join(config, 'teams', name), { recursive: true })
  writeFileSync(
    join(config, 'teams', name, 'config.json'),
    JSON.stringify({ name, leadSessionId: lead ?? 'someone-else', members: members.map(m => ({ name: m, agentId: `${m}@${name}`, agentType: 'general-purpose' })) }),
  )
}

const cmd = (args = '') => ({ command: 'litter', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as never
const never = (async () => {
  throw new Error('a tasks key never passes on')
}) as never

const viewOf = (p: TestPorts): TasksPaneView => p.views.tasks as TasksPaneView
const body = (p: TestPorts): TasksBody => viewOf(p).body!
const press = (p: TestPorts, element: string) => onTasksUi.press(p, { element, requestId: TASKS_PANE } as never, never)
const pick = (p: TestPorts, element: string, value: string) => onTasksUi.select(p, { element, value, requestId: TASKS_PANE } as never, never)
const type = (p: TestPorts, element: string, value: string, kind: 'change' | 'submit' = 'change') =>
  onTasksUi.input(p, { element, value, kind, requestId: TASKS_PANE } as never, never)

/** A team list `team-a` of five tasks, opened in the pane. */
async function opened(): Promise<{ p: TestPorts; config: string }> {
  const w = world()
  team(w.config, 'team-a', ['researcher', 'executor'])
  write(w.config, 'team-a', [
    { id: '1', subject: 'Plan it', status: 'completed', owner: 'researcher' },
    { id: '2', subject: 'build it', status: 'in_progress', owner: 'executor', blockedBy: ['1'] },
    { id: '3', subject: 'Check it', blockedBy: ['2', '9'] },
    { id: '10', subject: 'announce', status: 'pending' },
    { id: '4', subject: 'Archive', status: 'completed', owner: 'executor' },
  ])
  const answer = await tasksCommand(w.p, cmd('team-a'), never)
  expect(answer).toEqual({ text: 'Tasks shows team-a (5 tasks)' })
  return w
}

// ---------------------------------------------------------------------------

describe('the list, the filters and the sort', () => {
  test("the command opens the pane on the list named, and the picker offers this session's list first", async () => {
    const { p } = await opened()
    expect(p.panes.opened).toEqual([{ id: TASKS_PANE, title: 'litter', focus: true }])
    const b = body(p)
    expect(b.title.map(s => s.text).join('')).toBe('litter · tasks · team-a')
    expect(b.list).toBe('team-a')
    expect(b.lists).toEqual([
      { value: SESSION, label: `${SESSION} · this session's · 0 tasks` },
      { value: 'team-a', label: 'team-a · team · 5 tasks' },
    ])
  })

  test("with no argument it opens this session's list; a name that isn't a list says so", async () => {
    const { p } = world()
    expect(await tasksCommand(p, cmd(), never)).toEqual({ text: `Tasks shows ${SESSION} (0 tasks)` })
    expect(body(p).empty).toBe("no tasks in this session's list yet")
    await tasksCommand(p, cmd('nope'), never)
    expect(body(p).notice).toEqual({ level: 'warning', text: "there's no task list named nope, so this session's is shown" })
  })

  test("each filter's count, and the rows each shows", async () => {
    const { p } = await opened()
    expect(body(p).counts).toEqual({ all: 5, pending: 2, in_progress: 1, completed: 2 })
    expect(body(p).rows.map(r => r.id)).toEqual(['1', '2', '3', '4', '10'])
    await press(p, 'tasks:filter:pending')
    expect(body(p).filter).toBe('pending')
    expect(body(p).rows.map(r => r.id)).toEqual(['3', '10'])
    await press(p, 'tasks:filter:in_progress')
    expect(body(p).rows.map(r => r.id)).toEqual(['2'])
    await press(p, 'tasks:filter:completed')
    expect(body(p).rows.map(r => r.id)).toEqual(['1', '4'])
    // The counts don't move with the filter.
    expect(body(p).counts).toEqual({ all: 5, pending: 2, in_progress: 1, completed: 2 })
    await press(p, 'tasks:filter:nonsense')
    expect(body(p).filter).toBe('completed')
  })

  test('the sort: by id, by status (under way, waiting, done), by owner (unowned last), by subject', async () => {
    const { p } = await opened()
    const ids = () => body(p).rows.map(r => r.id)
    await pick(p, 'tasks:sort', 'status')
    expect(ids()).toEqual(['2', '3', '10', '1', '4'])
    await pick(p, 'tasks:sort', 'owner')
    expect(ids()).toEqual(['2', '4', '1', '3', '10'])
    await pick(p, 'tasks:sort', 'subject')
    expect(ids()).toEqual(['10', '4', '2', '3', '1'])
    await press(p, 'tasks:sort:id')
    expect(ids()).toEqual(['1', '2', '3', '4', '10'])
    await pick(p, 'tasks:sort', 'nonsense')
    expect(body(p).sort).toBe('id')
  })

  test("blocked state: the blockers that aren't completed, a missing one included; owners and statuses with their glyphs", async () => {
    const { p } = await opened()
    const row = (id: string) => body(p).rows.find(r => r.id === id)!
    expect(row('2').blockedBy).toEqual([])
    expect(row('3').blockedBy).toEqual(['2', '9'])
    expect(row('2').status).toEqual({ text: 'in progress', color: 'background', glyph: '▸' })
    expect(row('3').status).toEqual({ text: 'pending', color: 'inactive', glyph: '·' })
    expect(row('1').status).toEqual({ text: 'completed', color: 'success', glyph: '✓' })
    expect(row('2').owner).toBe('executor')
    expect(row('3').owner).toBeNull()
  })

  test('picking another list shows it; a list no longer offered is a stale pick', async () => {
    const { p, config } = await opened()
    write(config, SESSION, [{ id: '1', subject: 'mine' }])
    await pick(p, 'tasks:list', SESSION)
    expect(body(p).list).toBe(SESSION)
    expect(body(p).rows.map(r => r.subject)).toEqual(['mine'])
    // Its own list is kept as "this session's", so it follows a new session id.
    expect(tasksNavOf()?.list).toBeNull()
    await pick(p, 'tasks:list', 'gone-team')
    expect(p.toasts).toEqual(["that list isn't offered any more, so it was ignored"])
    expect(body(p).list).toBe(SESSION)
  })
})

describe('the picker leaves out empty team lists (WP-DA2)', () => {
  const ref = (name: string, over: Partial<TaskListRef> = {}): TaskListRef => ({ name, dir: `/cfg/tasks/${name}`, kind: 'team', team: name, mine: false, ...over })

  test('a team list with no tasks is left out, unless it is this session\'s, the one shown or the one named', () => {
    expect(hiddenList(ref('session-1a2b3c4d'), 0, 'team-a', null)).toBe(true)
    expect(hiddenList(ref('session-1a2b3c4d'), 1, 'team-a', null)).toBe(false)
    expect(hiddenList(ref('session-1a2b3c4d', { mine: true }), 0, 'team-a', null)).toBe(false)
    expect(hiddenList(ref('session-1a2b3c4d'), 0, 'session-1a2b3c4d', null)).toBe(false)
    expect(hiddenList(ref('session-1a2b3c4d'), 0, 'team-a', 'session-1a2b3c4d')).toBe(false)
    // This session's own list, with no team, is never a team list.
    expect(hiddenList(ref(SESSION, { kind: 'session', team: null }), 0, 'team-a', null)).toBe(false)
  })

  test('the note says how many, as session teams when every one is the engine\'s, else as team lists', () => {
    expect(hiddenNote([])).toBeNull()
    expect(hiddenNote([ref('session-1a2b3c4d')])).toBe('1 empty session team hidden')
    expect(hiddenNote([ref('session-1a2b3c4d'), ref('session-5e6f7a8b')])).toBe('2 empty session teams hidden')
    expect(hiddenNote([ref('session-1a2b3c4d'), ref('quiet-team')])).toBe('2 empty team lists hidden')
  })

  test('the view: the empty session teams are out of the picker, counted in its note; one named comes back', async () => {
    const { p, config } = await opened()
    for (const s of ['session-1a2b3c4d', 'session-5e6f7a8b', 'session-9c0d1e2f']) team(config, s, [])
    team(config, 'busy-session', [])
    write(config, 'busy-session', [{ id: '1' }])
    await tasksCommand(p, cmd('team-a'), never)
    expect(body(p).lists.map(o => o.value)).toEqual([SESSION, 'busy-session', 'team-a'])
    expect(body(p).hidden).toBe('3 empty session teams hidden')
    await tasksCommand(p, cmd('session-5e6f7a8b'), never)
    expect(body(p).lists.map(o => o.value)).toEqual([SESSION, 'busy-session', 'session-5e6f7a8b', 'team-a'])
    expect(body(p).hidden).toBe('2 empty session teams hidden')
    // A team that's yours, led by this session, is your list: kept, empty or not.
    team(config, 'session-mine0000', [], SESSION)
    await tasksCommand(p, cmd('team-a'), never)
    expect(body(p).lists[0]).toEqual({ value: 'session-mine0000', label: "session-mine0000 · team session-mine0000, this session's · 0 tasks" })
    expect(body(p).hidden).toBe('3 empty session teams hidden')
  })
})

describe('the editor', () => {
  test("a row's press selects it, and the editor holds its values, the team's members as owners", async () => {
    const { p } = await opened()
    await press(p, 'tasks:select:team-a/3')
    const ed = body(p).editor!
    expect(body(p).rows.find(r => r.id === '3')?.selected).toBe(true)
    expect(ed).toMatchObject({ id: '3', subject: 'Check it', description: '', status: 'pending', owner: '', dirty: false, changed: false, via: 'direct', links: 'blocked by #2 #9' })
    expect(ed.owners).toEqual([
      { value: '', label: 'none' },
      { value: 'researcher', label: 'researcher' },
      { value: 'executor', label: 'executor' },
    ])
    expect(ed.statuses.map(s => s.label)).toEqual(['· pending', '▸ in progress', '✓ completed'])
  })

  test("an owner that isn't a member is offered as it is; a description's line breaks are ⏎ in its field", async () => {
    const { p, config } = await opened()
    write(config, 'team-a', [{ id: '5', subject: 'odd', owner: 'visitor', description: 'one\ntwo' }])
    await tasksTick(p)
    await press(p, 'tasks:select:team-a/5')
    const ed = body(p).editor!
    expect(ed.owners.at(-1)).toEqual({ value: 'visitor', label: 'visitor (not a member)' })
    expect(ed.description).toBe(`one${LINE_MARK}two`)
    expect(ed.descriptionText).toBe('one\ntwo')
  })

  test("what you type survives the tick's rebuilds, a task added under it included, until [Revert]", async () => {
    const { p, config } = await opened()
    await press(p, 'tasks:select:team-a/3')
    await type(p, 'tasks:subject:team-a/3', 'Check it twice')
    await type(p, 'tasks:description:team-a/3', `first${LINE_MARK}second`)
    await pick(p, 'tasks:owner:team-a/3', 'researcher')
    expect(body(p).editor).toMatchObject({ subject: 'Check it twice', description: `first${LINE_MARK}second`, owner: 'researcher', dirty: true })
    write(config, 'team-a', [{ id: '11', subject: 'new' }])
    const v = viewOf(p).v
    await tasksTick(p)
    expect(viewOf(p).v).toBeGreaterThan(v)
    expect(body(p).rows.map(r => r.id)).toContain('11')
    expect(body(p).editor).toMatchObject({ subject: 'Check it twice', description: `first${LINE_MARK}second`, owner: 'researcher', dirty: true, changed: false })
    await press(p, 'tasks:revert:team-a/3')
    expect(body(p).notice).toEqual({ level: 'info', text: 'your edit of #3 was dropped' })
    expect(body(p).editor).toMatchObject({ subject: 'Check it', owner: '', dirty: false })
  })

  test('[Save], written directly: only the changed fields, and the notice says no hooks ran', async () => {
    const { p, config } = await opened()
    await press(p, 'tasks:select:team-a/3')
    await type(p, 'tasks:description:team-a/3', `first${LINE_MARK}second`, 'submit')
    await pick(p, 'tasks:status:team-a/3', 'in_progress')
    await press(p, 'tasks:save:team-a/3')
    expect(body(p).notice).toEqual({ level: 'ok', text: '#3 written directly: no hooks ran' })
    const file = JSON.parse(readFileSync(join(config, 'tasks', 'team-a', '3.json'), 'utf8'))
    expect(file).toEqual({ subject: 'Check it', description: 'first\nsecond', status: 'in_progress', blocks: [], blockedBy: ['2', '9'], id: '3' })
    expect(body(p).editor).toMatchObject({ status: 'in_progress', dirty: false })
    expect(p.logs).toContain('tasks pane: updateTask team-a #3 (description, status)')
  })

  test('[Save], written directly with an owner change: and no assignment message was sent', async () => {
    const { p, config } = await opened()
    await press(p, 'tasks:select:team-a/10')
    await pick(p, 'tasks:owner:team-a/10', 'executor')
    await press(p, 'tasks:save:team-a/10')
    expect(body(p).notice).toEqual({ level: 'ok', text: '#10 written directly: no hooks ran, and no assignment message was sent' })
    expect(JSON.parse(readFileSync(join(config, 'tasks', 'team-a', '10.json'), 'utf8')).owner).toBe('executor')
    // Clearing it back removes the key.
    await pick(p, 'tasks:owner:team-a/10', '')
    await press(p, 'tasks:save:team-a/10')
    expect('owner' in JSON.parse(readFileSync(join(config, 'tasks', 'team-a', '10.json'), 'utf8'))).toBe(false)
  })

  test("[Save] on this session's list with TaskUpdate there: saved through TaskUpdate", async () => {
    const { p, config } = world()
    write(config, SESSION, [{ id: '1', subject: 'mine' }])
    p.toolNamesValue = ['TaskUpdate']
    p.toolAnswer = async (_t, input) => ({ result: { success: true, taskId: input.taskId, updatedFields: ['subject'] } }) as never
    await tasksCommand(p, cmd(), never)
    await press(p, `tasks:select:${SESSION}/1`)
    expect(body(p).editor?.via).toBe('tool')
    await type(p, `tasks:subject:${SESSION}/1`, 'mine, renamed')
    await press(p, `tasks:save:${SESSION}/1`)
    expect(body(p).notice).toEqual({ level: 'ok', text: '#1 saved through TaskUpdate' })
    expect(p.toolCalls).toEqual([{ tool: 'TaskUpdate', input: { taskId: '1', subject: 'mine, renamed' } }])
  })

  test("[Save] refuses when the file's mtime moved since the edit began, and [Reload] takes the file's version", async () => {
    const { p, config } = await opened()
    await press(p, 'tasks:select:team-a/3')
    await type(p, 'tasks:subject:team-a/3', 'mine')
    // Someone else writes it before the tick has seen it.
    write(config, 'team-a', [{ id: '3', subject: 'theirs', blockedBy: ['2', '9'] }])
    await press(p, 'tasks:save:team-a/3')
    expect(body(p).notice).toEqual({
      level: 'warning',
      text: "#3 changed on disk since you began editing, so nothing was saved: [Reload] takes the file's version (and drops yours)",
    })
    expect(JSON.parse(readFileSync(join(config, 'tasks', 'team-a', '3.json'), 'utf8')).subject).toBe('theirs')
    expect(body(p).editor).toMatchObject({ subject: 'mine', changed: true })
    await press(p, 'tasks:reload:team-a/3')
    expect(body(p).notice).toEqual({ level: 'info', text: '#3 reloaded from its file; your edit was dropped' })
    expect(body(p).editor).toMatchObject({ subject: 'theirs', changed: false, dirty: false })
  })

  test("[Save] with nothing changed, or a store that refuses, says so; the edit is kept", async () => {
    const { p } = await opened()
    await press(p, 'tasks:select:team-a/3')
    await press(p, 'tasks:save:team-a/3')
    expect(body(p).notice).toEqual({ level: 'info', text: 'nothing to save: #3 is as its file has it' })
    deps.updateTask = async () => ({ ok: false, error: 'the lock is held' })
    await type(p, 'tasks:subject:team-a/3', 'x')
    await press(p, 'tasks:save:team-a/3')
    expect(body(p).notice).toEqual({ level: 'error', text: "#3 wasn't saved: the lock is held" })
    expect(body(p).editor).toMatchObject({ subject: 'x', dirty: true })
  })
})

describe('stale presses and a key not the pane\'s', () => {
  test("a press drawn for another list, or for a task that's gone, is ignored with a toast", async () => {
    const { p, config } = await opened()
    await press(p, 'tasks:select:other-list/3')
    expect(p.toasts).toEqual(["that was drawn for another list, or for a task that's gone, so it was ignored"])
    expect(body(p).editor).toBeNull()
    await press(p, 'tasks:select:team-a/3')
    await type(p, 'tasks:subject:team-a/3', 'edited')
    rmSync(join(config, 'tasks', 'team-a', '3.json'))
    await tasksTick(p)
    // The task went: its edit with it, said once.
    expect(body(p).notice).toEqual({ level: 'warning', text: "task #3 isn't in the list any more, so your edit of it was dropped" })
    expect(body(p).editor).toBeNull()
    await press(p, 'tasks:save:team-a/3')
    expect(p.toasts).toHaveLength(2)
    // A field for a task that's gone is dropped quietly.
    await type(p, 'tasks:subject:team-a/3', 'late')
    expect(p.toasts).toHaveLength(2)
  })

  test("a key that isn't `tasks:` passes on; with the pane never opened a press is ignored", async () => {
    const { p } = world()
    const passed: unknown[] = []
    const next = (async (e: unknown) => {
      passed.push(e)
      return { passed: true }
    }) as never
    expect(await onTasksUi.press(p, { element: 'board:plan' } as never, next)).toEqual({ passed: true } as never)
    expect(await onTasksUi.select(p, { element: 'x', value: 'y' } as never, next)).toEqual({ passed: true } as never)
    expect(await onTasksUi.message(p, { element: 'tasks:select:a/1' } as never, next)).toEqual({ passed: true } as never)
    expect(passed).toHaveLength(3)
    expect(await press(p, 'tasks:filter:all')).toEqual({ element: 'tasks:filter:all' })
    expect(p.toasts).toEqual(['the tasks pane was closed, so that was ignored'])
    expect(p.views).toEqual({})
  })
})

describe('a list that went empty', () => {
  test("every task completed, then cleared by the engine's panel: the pane says so", async () => {
    const { p, config } = world()
    team(config, 'team-a', [])
    write(config, 'team-a', [
      { id: '1', status: 'completed' },
      { id: '2', status: 'completed' },
    ])
    await tasksCommand(p, cmd('team-a'), never)
    rmSync(join(config, 'tasks', 'team-a', '1.json'))
    rmSync(join(config, 'tasks', 'team-a', '2.json'))
    await tasksTick(p)
    expect(body(p).empty).toBe(EMPTIED_DONE)
    // Still said on the next rebuild.
    await refreshTasks(p)
    expect(body(p).empty).toBe(EMPTIED_DONE)
  })

  test('tasks deleted while one was open: the list went empty', async () => {
    const { p, config } = world()
    team(config, 'team-a', [])
    write(config, 'team-a', [{ id: '1' }])
    await tasksCommand(p, cmd('team-a'), never)
    rmSync(join(config, 'tasks', 'team-a', '1.json'))
    await tasksTick(p)
    expect(body(p).empty).toBe(EMPTIED_GONE)
  })
})

describe('the tick and the navigation', () => {
  test('the tick writes nothing when nothing moved, and a view when a file did; refreshTasks writes regardless', async () => {
    const { p, config } = await opened()
    const v = viewOf(p).v
    await tasksTick(p)
    await tasksTick(p)
    expect(viewOf(p).v).toBe(v)
    write(config, 'team-a', [{ id: '3', subject: 'Check it again' }])
    await tasksTick(p)
    expect(viewOf(p).v).toBe(v + 1)
    expect(body(p).rows.find(r => r.id === '3')?.subject).toBe('Check it again')
    await refreshTasks(p)
    expect(viewOf(p).v).toBe(v + 2)
  })

  test('the navigation comes back after a module reset, from $.store, for this session only', async () => {
    const { p } = await opened()
    await press(p, 'tasks:filter:pending')
    await pick(p, 'tasks:sort', 'subject')
    await press(p, 'tasks:select:team-a/3')
    await type(p, 'tasks:subject:team-a/3', 'kept across a reload', 'submit')
    const stored = p.storeMap.get(TASKS_STORE_KEY) as { v: number; session: string }
    expect(stored).toMatchObject({ v: 1, session: SESSION })
    resetTasksPaneForTests()
    p.views = {}
    await tasksTick(p)
    const b = body(p)
    expect([b.list, b.filter, b.sort]).toEqual(['team-a', 'pending', 'subject'])
    expect(b.editor).toMatchObject({ id: '3', subject: 'kept across a reload', dirty: true })
    // Another session's mirror is never read.
    resetTasksPaneForTests()
    p.views = {}
    const other = nodePorts({ sessionId: 'another-session' })
    other.configDirValue = p.configDirValue
    other.storeMap.set(TASKS_STORE_KEY, p.storeMap.get(TASKS_STORE_KEY))
    await tasksTick(other)
    expect(other.views).toEqual({})
  })

  test("the config dir can't be known: the pane says why, and nothing throws", async () => {
    const { p } = world()
    p.configDirValue = null
    expect(await tasksCommand(p, cmd(), never)).toEqual({ text: "Tasks has nothing to show: the task lists can't be read: no config dir in tier 2 (set configDirValue)" })
    expect(body(p).notice?.level).toBe('error')
  })
})
