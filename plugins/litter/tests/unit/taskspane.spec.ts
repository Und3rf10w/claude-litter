// Tier 2: the tasks pane's view and events (WP-CE; COMMON decisions 4, 15,
// 16), over a temporary config dir and the real store: the filters' counts,
// the sort, blocked state, the editor's values surviving a rebuild, [Save]'s
// three notices, the refusal when the file changed under an edit, stale
// presses, a list that went empty, the tick's change check, and the
// navigation restored after a module reset. Phase 5b (WP-DF): the first
// line, the picker's rows (open counts, kinds, teams, folders; [Show all],
// [Change]), the tasks' rows (descriptions, links, the menu's offers), the
// menu's actions through the editor's save, the layout at 100 and 60
// columns (the owner dropped first, the subject cut), the wheel's hit test
// and the footers' pages.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TasksBody, TasksPaneView } from '../../types/index'
import type { TaskFile, TaskListRef } from '../../hooks/uitypes'
import type { BodyContext } from '../../hooks/ui/chrome'
import {
  LISTS_LIST,
  ROWS_INLINE,
  ROWS_LIST,
  SUBJECT_MIN,
  onTasksScroll,
  onTasksUi,
  pickerSpec,
  refreshTasks,
  resetTasksPaneForTests,
  rowsSpec,
  tasksCommand,
  tasksHit,
  tasksPlan,
  tasksTick,
  tasksTops,
} from '../../hooks/tasks/pane'
import { LITTER_PANE as TASKS_PANE, listOffset, moveList, resetHubForTests } from '../../hooks/ui/hub'
import { noteDrawn, resetDrawnForTests } from '../../hooks/ui/drawn'
import { EMPTIED_DONE, EMPTIED_GONE, LINE_MARK, OPEN_READS, TASKS_STORE_KEY, deps, hiddenList, hiddenNote, listDescription, tasksNavOf } from '../../hooks/tasks/view'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

// teamfile.sh runs for real on a direct save; a loaded machine is slow.
setDefaultTimeout(60_000)

const SESSION = 'sess-pane'
const cleanups: (() => void)[] = []
beforeEach(() => {
  resetTasksPaneForTests()
  resetHubForTests()
  resetDrawnForTests()
})
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  resetTasksPaneForTests()
  resetHubForTests()
  resetDrawnForTests()
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
  test("the command opens the pane on the list named, its first line naming it; the picker offers this session's list first", async () => {
    const { p, config } = await opened()
    expect(p.panes.opened).toEqual([{ id: TASKS_PANE, title: 'litter', focus: true }])
    const b = body(p)
    expect(b.head).toEqual({ label: 'team ', name: 'team-a', note: '5 tasks · 3 open' })
    expect(b.list).toBe('team-a')
    expect(b.lists).toEqual([
      { value: SESSION, label: SESSION, kind: 'this session', mine: true, open: 0, total: 0, description: `no tasks · ${config}/tasks/${SESSION}` },
      { value: 'team-a', label: 'team-a', kind: 'team', mine: false, open: 3, total: 5, description: `5 tasks, 3 open · members researcher, executor · ${config}/tasks/team-a` },
    ])
    expect([b.hidden, b.hiddenCount, b.showEmpty, b.picking]).toEqual([null, 0, false, false])
  })

  test("with no argument it opens this session's list; a name that isn't a list says so", async () => {
    const { p } = world()
    expect(await tasksCommand(p, cmd(), never)).toEqual({ text: `Tasks shows ${SESSION} (0 tasks)` })
    expect(body(p).empty).toBe("no tasks in this session's list yet")
    expect(body(p).head).toEqual({ label: 'this session', name: null, note: 'no tasks' })
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

  test("picking another list (its row's press) shows it; a list no longer offered is a stale pick", async () => {
    const { p, config } = await opened()
    write(config, SESSION, [{ id: '1', subject: 'mine' }])
    await press(p, `tasks:pick:${SESSION}`)
    expect(body(p).list).toBe(SESSION)
    expect(body(p).rows.map(r => r.subject)).toEqual(['mine'])
    // Its own list is kept as "this session's", so it follows a new session id.
    expect(tasksNavOf()?.list).toBeNull()
    await press(p, 'tasks:pick:gone-team')
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
    expect(body(p).lists[0]).toMatchObject({ value: 'session-mine0000', label: 'session-mine0000', kind: 'this session · team', mine: true, open: 0, total: 0 })
    expect(body(p).hidden).toBe('3 empty session teams hidden')
    expect(body(p).hiddenCount).toBe(3)
  })

  test('[Show all] lists the empty ones too, and [Hide empty] leaves them out again; it stays across a module reset', async () => {
    const { p, config } = await opened()
    for (const s of ['session-1a2b3c4d', 'session-5e6f7a8b']) team(config, s, [])
    await tasksCommand(p, cmd('team-a'), never)
    expect(body(p).lists.map(o => o.value)).toEqual([SESSION, 'team-a'])
    await press(p, 'tasks:empty:show')
    expect(body(p).showEmpty).toBe(true)
    expect(body(p).lists.map(o => o.value).sort()).toEqual([SESSION, 'session-1a2b3c4d', 'session-5e6f7a8b', 'team-a'].sort())
    expect([body(p).hidden, body(p).hiddenCount]).toEqual([null, 0])
    // Kept in $.store, so a reload lists them still; and the command keeps it.
    resetTasksPaneForTests()
    p.views = {}
    await tasksTick(p)
    expect(body(p).showEmpty).toBe(true)
    await tasksCommand(p, cmd('team-a'), never)
    expect(body(p).showEmpty).toBe(true)
    await press(p, 'tasks:empty:hide')
    expect(body(p).lists.map(o => o.value)).toEqual([SESSION, 'team-a'])
    expect(body(p).hidden).toBe('2 empty session teams hidden')
  })
})

describe("the first line, the picker's rows and the tasks' rows (WP-DF)", () => {
  test("each row: its description on one line, its links, and what its menu offers", async () => {
    const { p, config } = await opened()
    write(config, 'team-a', [{ id: '5', subject: 'odd', description: 'line one\nline two', blocks: ['3'], owner: 'visitor' }])
    await tasksTick(p)
    const row = (id: string) => body(p).rows.find(r => r.id === id)!
    expect([row('5').description, row('5').links]).toEqual(['line one line two', 'blocks #3'])
    expect([row('3').description, row('3').links]).toEqual(['', 'blocked by #2 #9'])
    // A mark where the status isn't that already; Assign to… with members to pick.
    expect(row('3').can).toEqual({ start: true, complete: true, assign: true })
    expect(row('2').can).toEqual({ start: false, complete: true, assign: true })
    expect(row('1').can).toEqual({ start: true, complete: false, assign: true })
  })

  test("Assign to… isn't offered on a list with no team to pick from, unless the task has an owner to clear", async () => {
    const { p, config } = world()
    write(config, SESSION, [{ id: '1' }, { id: '2', owner: 'someone' }])
    await tasksCommand(p, cmd(), never)
    expect(body(p).rows.map(r => r.can.assign)).toEqual([false, true])
  })

  test("the picker's rows: each list's open tasks, read for the first OPEN_READS others; past them only counted", async () => {
    const { p } = world()
    const refs: TaskListRef[] = Array.from({ length: OPEN_READS + 3 }, (_, i) => ({ name: `t${i}`, dir: `/cfg/tasks/t${i}`, kind: 'team', team: `t${i}`, mine: i === 0 }))
    const file = (id: string, status: string): TaskFile => ({ id, subject: id, description: '', activeForm: null, owner: null, status, blocks: [], blockedBy: [], path: `/x/${id}.json`, mtimeMs: 1 })
    let read = 0
    deps.taskLists = async () => refs
    deps.countTasks = async () => 2
    deps.tasksStamp = async () => 'stamp'
    deps.teams = async () => []
    deps.readTasks = async () => {
      read++
      return { tasks: [file('1', 'pending'), file('2', 'completed')], problems: [], stamp: 'stamp' }
    }
    await tasksCommand(p, cmd(), never)
    const lists = body(p).lists
    // The shown one's read for its rows, then OPEN_READS others for their counts.
    expect(read).toBe(1 + OPEN_READS)
    expect(lists[0]).toMatchObject({ value: 't0', kind: 'this session · team', open: 1, total: 2 })
    expect(lists[OPEN_READS]).toMatchObject({ value: `t${OPEN_READS}`, open: 1 })
    expect(lists[OPEN_READS + 1]).toMatchObject({ value: `t${OPEN_READS + 1}`, open: null, total: 2, description: `2 tasks · /cfg/tasks/t${OPEN_READS + 1}` })
    expect(pickerSpec(body(p), 5).items[OPEN_READS + 1]!.cells![0]).toEqual({ text: '2 tasks' })
    expect(pickerSpec(body(p), 5).items[1]!.cells).toEqual([{ text: '1 open' }, { text: 'team', color: 'inactive' }])
  })

  test("a list's description names its team's lead and members (six, then how many more) and its folder", () => {
    const l: TaskListRef = { name: 'crew', dir: '/cfg/tasks/crew', kind: 'team', team: 'crew', mine: false }
    const member = (name: string) => ({ name, agentId: `${name}@crew`, agentType: null, color: null })
    const crew = { name: 'crew', dir: 'crew', leadSessionId: 's', mtimeMs: 0, leadName: 'team-lead', members: ['team-lead', 'a', 'b', 'c', 'd', 'e', 'f', 'g'].map(member) }
    expect(listDescription(l, 3, 2, crew)).toBe('3 tasks, 2 open · lead team-lead · members a, b, c, d, e, f +1 · /cfg/tasks/crew')
    expect(listDescription(l, 0, 0, { ...crew, leadName: undefined, members: [] })).toBe('no tasks · no members · /cfg/tasks/crew')
    expect(listDescription(l, 1, 1, { ...crew, members: [member('team-lead'), member('solo')] })).toBe('1 task, 1 open · lead team-lead · member solo · /cfg/tasks/crew')
  })

  test('[Change] opens the folded picker; a pick, of another list or the one shown, folds it again; another list starts at its top', async () => {
    const { p, config } = await opened()
    write(config, SESSION, [{ id: '1', subject: 'mine' }])
    await press(p, 'tasks:picker:open')
    expect(body(p).picking).toBe(true)
    await press(p, 'tasks:pick:team-a')
    expect(body(p).picking).toBe(false)
    await press(p, 'tasks:picker:open')
    await moveList(p, ROWS_LIST, 2, 4)
    await press(p, `tasks:pick:${SESSION}`)
    expect([body(p).picking, body(p).list, listOffset(ROWS_LIST)]).toEqual([false, SESSION, 0])
  })
})

describe("the menu's actions, through the editor's save", () => {
  const file = (config: string, id: string) => JSON.parse(readFileSync(join(config, 'tasks', 'team-a', `${id}.json`), 'utf8'))

  test('Mark in progress and Mark completed write the status alone, as [Save] does, and say how', async () => {
    const { p, config } = await opened()
    await press(p, 'tasks:start:team-a/3')
    expect(body(p).notice).toEqual({ level: 'ok', text: '#3 marked in progress, written directly: no hooks ran' })
    expect(file(config, '3')).toMatchObject({ subject: 'Check it', status: 'in_progress', blockedBy: ['2', '9'] })
    expect(p.logs).toContain('tasks pane: updateTask team-a #3 (status)')
    await press(p, 'tasks:complete:team-a/2')
    expect(body(p).notice).toEqual({ level: 'ok', text: '#2 marked completed, written directly: no hooks ran' })
    expect(file(config, '2').status).toBe('completed')
    expect(body(p).rows.find(r => r.id === '2')?.can).toMatchObject({ start: true, complete: false })
    // Already so: nothing written.
    await press(p, 'tasks:complete:team-a/1')
    expect(body(p).notice).toEqual({ level: 'info', text: '#1 is completed already' })
  })

  test("a mark refuses while an edit of the task waits, and when the file moved since it was drawn", async () => {
    const { p, config } = await opened()
    await press(p, 'tasks:select:team-a/3')
    await type(p, 'tasks:subject:team-a/3', 'mine')
    await press(p, 'tasks:start:team-a/3')
    expect(body(p).notice).toEqual({ level: 'warning', text: "#3 has an edit you haven't saved, so it wasn't marked: [Save] or [Revert] it first" })
    expect(file(config, '3').status).toBe('pending')
    write(config, 'team-a', [{ id: '10', subject: 'theirs' }])
    await press(p, 'tasks:complete:team-a/10')
    expect(body(p).notice).toEqual({ level: 'warning', text: "#10 changed on disk since it was drawn, so it wasn't marked: it's shown as it is now" })
    expect(file(config, '10').status).toBe('pending')
    expect(body(p).rows.find(r => r.id === '10')?.subject).toBe('theirs')
  })

  test("on this session's list with TaskUpdate there, a mark goes through TaskUpdate", async () => {
    const { p, config } = world()
    write(config, SESSION, [{ id: '1', subject: 'mine' }])
    p.toolNamesValue = ['TaskUpdate']
    p.toolAnswer = async (_t, input) => ({ result: { success: true, taskId: input.taskId, updatedFields: ['status'] } }) as never
    await tasksCommand(p, cmd(), never)
    await press(p, `tasks:start:${SESSION}/1`)
    expect(body(p).notice).toEqual({ level: 'ok', text: '#1 marked in progress through TaskUpdate' })
    expect(p.toolCalls).toEqual([{ tool: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' } }])
  })

  test('Edit selects the task, so its editor opens; Assign to… too, and says where the owner is picked', async () => {
    const { p } = await opened()
    await press(p, 'tasks:edit:team-a/2')
    expect(body(p).editor?.id).toBe('2')
    await press(p, 'tasks:assign:team-a/3')
    expect(body(p).editor?.id).toBe('3')
    expect(body(p).notice).toEqual({ level: 'info', text: "pick #3's owner under Owner, then [Save]" })
    // One drawn for another list is stale.
    await press(p, 'tasks:start:other/3')
    expect(p.toasts).toEqual(["that was drawn for another list, or for a task that's gone, so it was ignored"])
  })
})

/** The terminal's body context, docked, as the hub hands it. */
const dock = (rows: number, columns = 100, over: Partial<BodyContext> = {}): BodyContext => ({
  surface: 'terminal',
  bodyColumns: columns,
  isFocused: true,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: rows },
  rows,
  focused: null,
  lists: {},
  ...over,
})

/** A long subject, for the cut. */
const LONG = 'Write the migration guide for the parser rewrite, with every breaking change listed'

/** team-a's five tasks and a sixth with a long subject, and `more` teams with a task each: lists to scroll. */
async function crowded(more: number, tasks = 0): Promise<{ p: TestPorts; config: string }> {
  const w = await opened()
  write(w.config, 'team-a', [{ id: '6', subject: LONG, owner: 'researcher' }, ...Array.from({ length: tasks }, (_, i) => ({ id: String(20 + i) }))])
  for (let i = 0; i < more; i++) {
    team(w.config, `crew-${i}`, ['lead'])
    write(w.config, `crew-${i}`, [{ id: '1' }])
  }
  await tasksCommand(w.p, cmd('team-a'), never)
  return w
}

describe('the layout: the rows at 100 and 60 columns, the plan, the hit test (WP-DF)', () => {
  test("a row's cells: the status, the owner (name color, or unowned muted), the blocked line, the subject cut to what's left; at 60 the owner goes first", async () => {
    const { p } = await crowded(0)
    const b = body(p)
    const wide = rowsSpec(b, 10, dock(40, 100))
    const row3 = wide.items.find(i => i.key === 'tasks:select:team-a/3')!
    // Each cell is padded to its column's width over every row (`#10`'s three, the status's 13, …), so any window lines up the same.
    const trimmed = <C extends { text: string }>(cells: readonly C[]): C[] => cells.map(c => ({ ...c, text: c.text.trimEnd() }))
    expect(row3.label).toBe('#3 ')
    expect(row3.cells!.map(c => c.text.length)).toEqual([13, 10, 18, 50])
    expect(trimmed(row3.cells!)).toEqual([
      { text: '· pending', color: 'inactive' },
      { text: 'unowned', color: 'inactive' },
      { text: '⊘ blocked by #2 #9', color: 'warning' },
      { text: 'Check it' },
    ])
    expect(trimmed([wide.items.find(i => i.key === 'tasks:select:team-a/2')!.cells![1]!])).toEqual([{ text: 'executor', color: 'cyan_FOR_SUBAGENTS_ONLY' }])
    // The subject takes what the rest leaves, cut: the mark, `#10`, the status, the owner and the blocked line come off 100.
    const long100 = wide.items.find(i => i.key === 'tasks:select:team-a/6')!.cells!.at(-1)!.text
    expect(long100.endsWith('…')).toBe(true)
    expect(long100.length).toBe(100 - (2 + 3 + 1 + 13 + 1 + 10 + 1 + 18 + 1))
    const narrow = rowsSpec(b, 10, dock(40, 60))
    const at60 = narrow.items.find(i => i.key === 'tasks:select:team-a/6')!.cells!
    // No room for SUBJECT_MIN beside the owner: its column goes.
    expect(trimmed(at60).map(c => c.text).slice(0, 2)).toEqual(['· pending', ''])
    expect(at60.at(-1)!.text.length).toBe(60 - (2 + 3 + 1 + 13 + 1 + 18 + 1))
    expect(at60.at(-1)!.text.length).toBeGreaterThanOrEqual(SUBJECT_MIN)
    expect(narrow.columns).toHaveLength(3)
  })

  test("a description beside its row is cut to the cells left there; with too few, it's left whole (it goes under the row, or in the Client's line)", async () => {
    const { p, config } = await opened()
    write(config, 'team-a', [{ id: '5', subject: 'odd', description: 'a long description of what the task needs done, with every step spelled out' }])
    await tasksTick(p)
    const of = (columns: number) => rowsSpec(body(p), 10, dock(40, columns)).items.find(i => i.key === 'tasks:select:team-a/5')!.description!
    // At 100: the mark, `#10`, the status, the owner, the blocked line and `Check it`'s eight leave 100 - 50 - 8 - 1.
    expect(of(100)).toHaveLength(100 - (2 + 3 + 1 + 13 + 1 + 10 + 1 + 18 + 1) - 8 - 1)
    expect(of(100).endsWith('…')).toBe(true)
    expect(of(60)).toBe('a long description of what the task needs done, with every step spelled out')
  })

  test("the focused row's description is the task's with its links; its menu: Edit, the marks that apply, Assign to… where Owner is a Select", async () => {
    const { p } = await crowded(0)
    const items = rowsSpec(body(p), 10, dock(40)).items
    const of = (id: string) => items.find(i => i.key === `tasks:select:team-a/${id}`)!
    expect(of('3').description).toBe('blocked by #2 #9')
    expect(of('4').description).toBeUndefined()
    expect(of('3').actions!.map(a => a.label)).toEqual(['Edit', 'Mark in progress', 'Mark completed', 'Assign to…'])
    expect(of('2').actions!.map(a => a.key)).toEqual(['tasks:edit:team-a/2', 'tasks:complete:team-a/2', 'tasks:assign:team-a/2'])
    expect(of('1').actions!.map(a => a.label)).toEqual(['Edit', 'Mark in progress', 'Assign to…'])
    const mobile = rowsSpec(body(p), 10, { bodyColumns: 60, surface: 'mobile' }).items
    expect(mobile.find(i => i.key === 'tasks:select:team-a/3')!.actions!.map(a => a.label)).toEqual(['Edit', 'Mark in progress', 'Mark completed'])
  })

  test('the plan: the picker a list of five in a tall dock, fewer as the dock shrinks, folded under 24 rows and inline unless [Change] opened it', async () => {
    const { p } = await crowded(8)
    const b = body(p)
    expect(b.lists).toHaveLength(10)
    expect(tasksPlan(b, dock(60))).toMatchObject({ picker: 'list', pickerRows: 5 })
    expect(tasksPlan(b, dock(23)).picker).toBe('folded')
    expect(tasksPlan(b, dock(40, 100, { placement: 'inline', rows: Number.POSITIVE_INFINITY }))).toEqual({ picker: 'folded', pickerRows: 5, rows: 6 })
    await press(p, 'tasks:picker:open')
    expect(tasksPlan(body(p), dock(20)).picker).toBe('list')
    await press(p, 'tasks:pick:team-a')
    expect(tasksPlan(body(p), dock(60)).rows).toBe(6)
    // With the editor open, the tasks keep ROWS_MIN before the picker goes under five: a dock just short of it gives the picker fewer.
    await press(p, 'tasks:select:team-a/1')
    const tight = tasksPlan(body(p), dock(26))
    expect(tight).toEqual({ picker: 'list', pickerRows: 4, rows: 3 })
    // Shorter, down to two rows; under SHORT_ROWS, folded.
    expect(tasksPlan(body(p), dock(24))).toEqual({ picker: 'list', pickerRows: 2, rows: 3 })
    expect(tasksPlan(body(p), dock(23)).picker).toBe('folded')
  })

  test('inline the tasks window is ROWS_INLINE; in a dock it takes what the rest leaves, to the body\'s last row', async () => {
    const { p } = await crowded(0, 30)
    const b = body(p)
    expect(tasksPlan(b, dock(40, 100, { placement: 'inline', rows: Number.POSITIVE_INFINITY })).rows).toBe(ROWS_INLINE)
    const plan = tasksPlan(b, dock(40))
    // The first line, the picker (this session's and team-a's) under its two headings, the filters, the sort; then the rows and the Client's line.
    const tops = tasksTops(b, dock(40))
    expect(tops.picker).toEqual({ top: 2, height: 2 })
    expect(tops.rows!.top).toBe(7)
    expect(tops.rows!.top + tops.rows!.height).toBe(40)
    expect(tops.rows!.height).toBe(plan.rows + 1)
  })

  test('tasksTops at 100 and 60 columns: the picker under `Lists`, the tasks under `Tasks`, the filters and the sort; tasksHit names them, and neither between', async () => {
    const { p } = await crowded(8)
    for (const columns of [100, 60]) {
      const tops = tasksTops(body(p), dock(60, columns))
      // The first line, the `Lists` heading, then five rows and the footer.
      expect(tops.picker).toEqual({ top: 2, height: 6 })
      // The `Tasks` heading, the filters, the sort; then six rows and the Client's line.
      expect(tops.rows).toEqual({ top: 11, height: 7 })
      expect(tasksHit(tops, 2)).toBe('picker')
      expect(tasksHit(tops, 7)).toBe('picker')
      expect(tasksHit(tops, 8)).toBeNull()
      expect(tasksHit(tops, 11)).toBe('rows')
      expect(tasksHit(tops, 17)).toBe('rows')
      expect(tasksHit(tops, 18)).toBeNull()
      expect(tasksHit(tops, 0)).toBeNull()
      // Short, the picker folds to a line, and the tasks move up.
      const short = tasksTops(body(p), dock(20, columns))
      expect(short.picker).toBeNull()
      expect(short.rows!.top).toBe(4)
    }
  })
})

const BODY_TOP = 4
const tick = (by: number, row?: number, column = 5) => ({ component: 'Pane', requestId: TASKS_PANE, offset: 0, by, bodyRows: 60, contentRows: 60, origin: { kind: 'person' }, ...(row !== undefined ? { pointer: { row, column } } : {}) }) as never
const passOn = (async (e: unknown) => ({ passed: e })) as never

describe('the wheel and the footers', () => {
  test('a tick over the tasks moves their window, over the picker the picker; over the rest, past the edge or at an end, it passes on', async () => {
    const { p } = await crowded(8, 30)
    // Thirty rows: the picker's five, and 18 of the 36 tasks.
    const ctx = dock(30)
    expect(tasksPlan(body(p), ctx)).toEqual({ picker: 'list', pickerRows: 5, rows: 18 })
    noteDrawn({ shown: 'tasks', view: viewOf(p), ctx, bodyTop: BODY_TOP, scrollOffset: 0 })
    const tops = tasksTops(body(p), ctx)
    const overRows = BODY_TOP + tops.rows!.top
    const overPicker = BODY_TOP + tops.picker!.top
    expect(await onTasksScroll(p, tick(1, overRows), passOn)).toEqual({})
    expect(listOffset(ROWS_LIST)).toBe(1)
    expect(await onTasksScroll(p, tick(-1, overRows), passOn)).toEqual({})
    expect(listOffset(ROWS_LIST)).toBe(0)
    expect(await onTasksScroll(p, tick(-1, overRows), passOn)).toEqual({ passed: tick(-1, overRows) } as never)
    expect(await onTasksScroll(p, tick(2, overPicker), passOn)).toEqual({})
    expect(listOffset(LISTS_LIST)).toBe(2)
    expect(await onTasksScroll(p, tick(1, BODY_TOP), passOn)).toEqual({ passed: tick(1, BODY_TOP) } as never)
    expect(await onTasksScroll(p, tick(1, overRows, 100), passOn)).toEqual({ passed: tick(1, overRows, 100) } as never)
    noteDrawn({ shown: 'agents', view: null, ctx, bodyTop: BODY_TOP, scrollOffset: 0 })
    expect(await onTasksScroll(p, tick(1, overRows), passOn)).toEqual({ passed: tick(1, overRows) } as never)
    // The pane's handler forwards it (reached once the hub routes ui.scroll to Tasks).
    expect(await onTasksUi.scroll!(p, tick(1, overRows), passOn)).toEqual({ passed: tick(1, overRows) } as never)
  })

  test('the scroll keys carry no pointer: the picker while the ring is in it, else the tasks, a page at most', async () => {
    const { p } = await crowded(8, 30)
    noteDrawn({ shown: 'tasks', view: viewOf(p), ctx: dock(30), bodyTop: BODY_TOP, scrollOffset: 0 })
    const page = tasksPlan(body(p), dock(30)).rows - 1
    expect(await onTasksScroll(p, tick(60), passOn)).toEqual({})
    expect(listOffset(ROWS_LIST)).toBe(page)
    noteDrawn({ shown: 'tasks', view: viewOf(p), ctx: dock(30, 100, { focused: 'tasks:pick:team-a' }), bodyTop: BODY_TOP, scrollOffset: 0 })
    expect(await onTasksScroll(p, tick(1), passOn)).toEqual({})
    expect(listOffset(LISTS_LIST)).toBe(1)
  })

  test("a footer's [↓ n more] pages its list as its surface drew it; with no drawing, at the inline windows", async () => {
    const { p } = await crowded(8, 30)
    // No drawing: the last view at its inline windows (the tasks' ROWS_INLINE, the picker's five).
    expect(await press(p, `${ROWS_LIST}:down`)).toEqual({ element: `${ROWS_LIST}:down` })
    expect(listOffset(ROWS_LIST)).toBe(ROWS_INLINE - 1)
    await press(p, `${ROWS_LIST}:up`)
    expect(listOffset(ROWS_LIST)).toBe(0)
    await press(p, `${LISTS_LIST}:down`)
    expect(listOffset(LISTS_LIST)).toBe(4)
    // As a surface drew it (its render's note) is tier 1's: tests/tasks.test.tsx pages the mobile app's.
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
