// The tasks pane's view (phase 5; COMMON decisions 4, 15, 16), built from
// hooks/team/store.ts: the list picker, the filters with their counts, the
// sort, the rows with their owners and blocked state, and the selected
// task's editor. Owner: WP-CE.
//
// The navigation (the list picked, the filter, the sort, the selected task,
// and each edit begun) lives in module memory and is mirrored in $.store
// (TASKS_STORE_KEY), as the board's is, so a hot reload keeps it. An edit is
// held there until [Save] or [Revert], so a rebuild never drops what you
// typed. What the last build drew (the list, its tasks as read) stays in
// module memory too: a press acts only on that, and one drawn for another
// list is stale.
//
// Every text from a task file is cleaned and cut (swarm/view.ts, clean): a
// subject, a description and an owner are model text.

import type { Ports } from '../ports'
import type { TaskFile, TaskListRef, TeamInfo } from '../uitypes'
import type {
  BoardStatus,
  SwarmNotice,
  SwarmOption,
  SwarmSpan,
  TasksBody,
  TasksEditor,
  TasksFilter,
  TasksPaneView,
  TasksRow,
  TasksSort,
} from '../../types/index'
import { clean, oneLine } from '../swarm/view'
import { countTasks, readTasks, sanitize, taskLists, tasksStamp, teams, updateTask } from '../team/store'
import { STYLE } from '../ui/style'

// The store, through one table so tier 2 can stand in for it. The mod never changes it.
export const deps = {
  taskLists: (...a: Parameters<typeof taskLists>) => taskLists(...a),
  readTasks: (...a: Parameters<typeof readTasks>) => readTasks(...a),
  tasksStamp: (...a: Parameters<typeof tasksStamp>) => tasksStamp(...a),
  countTasks: (...a: Parameters<typeof countTasks>) => countTasks(...a),
  teams: (...a: Parameters<typeof teams>) => teams(...a),
  updateTask: (...a: Parameters<typeof updateTask>) => updateTask(...a),
}
const defaults = { ...deps }

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export const FILTERS: readonly TasksFilter[] = ['all', 'pending', 'in_progress', 'completed']
export const SORTS: readonly TasksSort[] = ['id', 'status', 'owner', 'subject']
export const FILTER_LABEL: Record<TasksFilter, string> = { all: 'All', pending: 'Pending', in_progress: 'In progress', completed: 'Completed' }
/** A line break in a one-line field: the d.ts's Input holds one line only. */
export const LINE_MARK = '⏎'
/** Longer than these, a field isn't offered: a save from a cut copy would cut the file. */
const SUBJECT_MAX = 2000
const DESCRIPTION_MAX = 8000
const ROW_SUBJECT = 160

/** 15.6: a glyph and a word beside each theme key. */
export const STATUS: Record<string, BoardStatus> = {
  pending: { text: 'pending', color: STYLE.idle, glyph: '·' },
  in_progress: { text: 'in progress', color: STYLE.running, glyph: '▸' },
  completed: { text: 'completed', color: STYLE.done, glyph: '✓' },
}
const UNKNOWN_STATUS: BoardStatus = { text: 'unknown', color: STYLE.warning, glyph: '!' }
/** The status sort: the work under way first, then what's waiting, then what's done. */
const STATUS_ORDER: Record<string, number> = { in_progress: 0, pending: 1, completed: 2 }

/** What the engine's own panel does to a list whose tasks are all completed (`AWo`'s reset, 5 s on). */
export const EMPTIED_DONE = "every task in this list was completed, and the engine's task panel cleared it (it does 5 s after the last one)"
export const EMPTIED_GONE = 'this list went empty: its tasks were deleted'

export const encodeField = (text: string): string => text.split('\n').join(LINE_MARK)
export const decodeField = (value: string): string => value.split(LINE_MARK).join('\n')

// ---------------------------------------------------------------------------
// The navigation

/** The file's values as an edit began: what [Save] compares with, and the mtime it checks. */
export type TasksBase = { subject: string; description: string; status: string; owner: string | null; mtimeMs: number }
/** What you typed or picked for one task, held until [Save] or [Revert]. Text fields hold real line breaks. */
export type TasksEdit = { subject: string; description: string; status: string; owner: string | null; base: TasksBase }

export type TasksNav = {
  /** A list picked by name; null shows this session's own (decision 15), which follows a /clear's new id. */
  list: string | null
  filter: TasksFilter
  sort: TasksSort
  /** The selected task's id. */
  selected: string | null
  /** Each edit begun, by `<list folder>/<id>`. */
  edits: Record<string, TasksEdit>
  notice: SwarmNotice | null
}

/** The $.store key the navigation is mirrored under, read back only by the session that wrote it. */
export const TASKS_STORE_KEY = 'litter.tasks.pane'

type TasksStore = { v: 1; session: string; nav: TasksNav | null }

let tasksNav: TasksNav | null = null
let restored = false
let rev = 0

export const blankTasksNav = (list: string | null = null): TasksNav => ({ list, filter: 'all', sort: 'id', selected: null, edits: {}, notice: null })

/** The pane's navigation, or null while it was never opened in this session. */
export const tasksNavOf = (): TasksNav | null => tasksNav
/** Bumped by every change of the navigation but typing: part of the rebuild check. */
export const tasksNavRev = (): number => rev

export function setTasksNav(next: TasksNav | null): void {
  tasksNav = next
  restored = true
  rev++
}

/** An edit's key: the list's folder name and the task's id. */
export const editKey = (list: string, id: string): string => `${list}/${id}`

const TASK_ID = /^[0-9]+$/
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function editOf(raw: unknown): TasksEdit | null {
  if (!isObject(raw) || !isObject(raw.base)) return null
  const b = raw.base
  const str = (v: unknown) => typeof v === 'string'
  const owner = (v: unknown) => v === null || (typeof v === 'string' && v !== '')
  if (!str(raw.subject) || !str(raw.description) || !str(raw.status) || !owner(raw.owner)) return null
  if (!str(b.subject) || !str(b.description) || !str(b.status) || !owner(b.owner) || typeof b.mtimeMs !== 'number') return null
  return {
    subject: raw.subject as string,
    description: raw.description as string,
    status: raw.status as string,
    owner: raw.owner as string | null,
    base: { subject: b.subject as string, description: b.description as string, status: b.status as string, owner: b.owner as string | null, mtimeMs: b.mtimeMs },
  }
}

/** After a hot reload module memory is empty: the navigation comes back from $.store, when this session wrote it. */
export async function restoreTasksNav(p: Ports): Promise<void> {
  if (restored) return
  restored = true
  try {
    const raw = (await p.store.get(TASKS_STORE_KEY)) as Partial<TasksStore> | undefined
    if (!raw || raw.v !== 1 || raw.session !== (await p.sessionId()) || !isObject(raw.nav) || tasksNav !== null) return
    const n = raw.nav as Partial<TasksNav>
    const edits: Record<string, TasksEdit> = {}
    for (const [k, v] of Object.entries(isObject(n.edits) ? n.edits : {})) {
      const e = editOf(v)
      if (e && /^[A-Za-z0-9_-]+\/[0-9]+$/.test(k)) edits[k] = e
    }
    tasksNav = {
      list: typeof n.list === 'string' ? n.list : null,
      filter: FILTERS.includes(n.filter as TasksFilter) ? (n.filter as TasksFilter) : 'all',
      sort: SORTS.includes(n.sort as TasksSort) ? (n.sort as TasksSort) : 'id',
      selected: typeof n.selected === 'string' && TASK_ID.test(n.selected) ? n.selected : null,
      edits,
      notice: null,
    }
    rev++
  } catch (err) {
    p.log(`tasks pane: the navigation wasn't read back: ${errText(err)}`)
  }
}

export async function saveTasksNav(p: Ports): Promise<void> {
  try {
    const value: TasksStore = { v: 1, session: await p.sessionId(), nav: tasksNav }
    await p.store.set(TASKS_STORE_KEY, value)
  } catch (err) {
    p.log(`tasks pane: the navigation wasn't saved: ${errText(err)}`)
  }
}

// ---------------------------------------------------------------------------
// What the last build drew (module memory; none is a fact anyone else reads)

/** The list the last build showed (`key`, its folder name), its tasks as read, and the lists it offered: what a press acts on. */
export type TasksShown = { list: TaskListRef; key: string; tasks: TaskFile[]; team: TeamInfo | null; via: 'tool' | 'direct'; lists: TaskListRef[] }

let shown: TasksShown | null = null
let viewSeq = 0
/** Per list folder: how many tasks the last build saw, whether all were completed, and why it's empty when it went empty. */
const seen = new Map<string, { count: number; allDone: boolean; emptied: string | null }>()

export const shownOf = (): TasksShown | null => shown

export function resetTasksViewForTests(): void {
  tasksNav = null
  restored = false
  rev = 0
  shown = null
  viewSeq = 0
  seen.clear()
  Object.assign(deps, defaults)
}

// ---------------------------------------------------------------------------
// The change check

/**
 * What a rebuild reads, without reading a task file (decision 16): the shown
 * list's stamp (its listing, each file's size and mtime), the teams' folder
 * listing (a new team, a new list), the session id and the list variable
 * (which list is this session's). The pane checks the navigation's revision
 * beside it.
 */
export async function keyOf(p: Ports, list: TaskListRef): Promise<string> {
  const stamp = await deps.tasksStamp(p, list)
  const teamNames = await p
    .configDir()
    .then(dir => p.fs.list(`${dir}/teams`))
    .then(
      entries => entries.map(e => e.name).join(','),
      () => '-',
    )
  const env = (await p.envVar('CLAUDE_CODE_TASK_LIST_ID').catch(() => undefined)) ?? ''
  return [list.dir, stamp, teamNames, await p.sessionId(), env].join('\u0000')
}

/** The key for the list the last build showed; null when there's none, so a build is due. */
export async function shownKey(p: Ports): Promise<string | null> {
  return shown ? keyOf(p, shown.list) : null
}

// ---------------------------------------------------------------------------
// The build

const nextV = (): number => ++viewSeq

function sortTasks(tasks: readonly TaskFile[], sort: TasksSort): TaskFile[] {
  const byId = (a: TaskFile, b: TaskFile) => Number(a.id) - Number(b.id)
  const cmp: Record<TasksSort, (a: TaskFile, b: TaskFile) => number> = {
    id: byId,
    status: (a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || byId(a, b),
    // Unowned last.
    owner: (a, b) => (a.owner === null ? 1 : 0) - (b.owner === null ? 1 : 0) || (a.owner ?? '').localeCompare(b.owner ?? '', undefined, { sensitivity: 'base' }) || byId(a, b),
    subject: (a, b) => a.subject.localeCompare(b.subject, undefined, { sensitivity: 'base' }) || byId(a, b),
  }
  return [...tasks].sort(cmp[sort])
}

/** The file's values, cleaned, as an edit's base. */
export function baseOf(task: TaskFile): TasksBase {
  return { subject: clean(task.subject, SUBJECT_MAX + 1), description: clean(task.description, DESCRIPTION_MAX + 1), status: task.status, owner: task.owner, mtimeMs: task.mtimeMs }
}

/** A fresh edit of a task: its fields as the file holds them. */
export function editFrom(task: TaskFile): TasksEdit {
  const base = baseOf(task)
  return { subject: base.subject, description: base.description, status: base.status, owner: base.owner, base }
}

export const dirtyOf = (e: TasksEdit): boolean =>
  e.subject !== e.base.subject || e.description !== e.base.description || e.status !== e.base.status || e.owner !== e.base.owner

function editorOf(task: TaskFile, held: TasksEdit | null, team: TeamInfo | null, via: 'tool' | 'direct'): TasksEditor {
  const e = held ?? editFrom(task)
  const owners: SwarmOption[] = [{ value: '', label: 'none' }]
  for (const m of team?.members ?? []) owners.push({ value: m.name, label: oneLine(m.name, 60) })
  for (const o of [task.owner, e.owner]) {
    if (o !== null && !owners.some(x => x.value === o)) owners.push({ value: o, label: `${oneLine(o, 60)} (not a member)` })
  }
  const links = [
    task.blocks.length > 0 ? `blocks ${task.blocks.map(b => `#${oneLine(b, 12)}`).join(' ')}` : '',
    task.blockedBy.length > 0 ? `blocked by ${task.blockedBy.map(b => `#${oneLine(b, 12)}`).join(' ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return {
    id: task.id,
    subject: task.subject.length > SUBJECT_MAX ? null : encodeField(e.subject),
    description: task.description.length > DESCRIPTION_MAX ? null : encodeField(e.description),
    descriptionText: e.description.includes('\n') ? clean(e.description, 2000) : null,
    status: e.status,
    statuses: (['pending', 'in_progress', 'completed'] as const).map(s => ({ value: s, label: `${STATUS[s]!.glyph} ${STATUS[s]!.text}` })),
    owner: e.owner ?? '',
    owners,
    links,
    dirty: dirtyOf(e),
    changed: held !== null && task.mtimeMs !== held.base.mtimeMs,
    via,
  }
}

const emptyBody = (title: SwarmSpan[], notice: SwarmNotice | null, n: TasksNav, empty: string): TasksBody => ({
  title,
  notice,
  list: null,
  lists: [],
  listName: null,
  filter: n.filter,
  counts: { all: 0, pending: 0, in_progress: 0, completed: 0 },
  sort: n.sort,
  rows: [],
  empty,
  problems: [],
  editor: null,
})

/** The list a navigation shows: the one picked, else this session's own, else the first. */
function listFor(lists: readonly TaskListRef[], n: TasksNav): TaskListRef | null {
  if (n.list !== null) {
    const picked = lists.find(l => l.name === n.list)
    if (picked) return picked
  }
  return lists.find(l => l.mine) ?? lists[0] ?? null
}

/** A `/litter tasks <list>` argument: a list's name, its folder name, or its team's; null for none that matches. */
export function listNamed(lists: readonly TaskListRef[], arg: string): TaskListRef | null {
  return lists.find(l => l.name === arg) ?? lists.find(l => sanitize(l.name) === sanitize(arg)) ?? lists.find(l => l.team === arg) ?? null
}

/**
 * Builds the view for the navigation (which must be set), keeping what it
 * drew in `shown`, and answers it with the change key it was read under.
 * The key is taken before the files are read, so a write in between moves
 * it again and the next tick rebuilds. Navigation the build settles (a list
 * that's gone, a selected task that's gone) is written back.
 */
export async function buildTasks(p: Ports): Promise<{ view: TasksPaneView; key: string | null }> {
  const n = tasksNavOf()!
  const title: SwarmSpan[] = [{ text: 'litter · tasks', bold: true }]
  let notice = n.notice
  let lists: TaskListRef[]
  try {
    lists = await deps.taskLists(p)
  } catch (err) {
    shown = null
    const why = { level: 'error' as const, text: `the task lists can't be read: ${oneLine(errText(err), 240)}` }
    return { view: { view: 'tasks', v: nextV(), body: emptyBody(title, why, n, 'no task list to show') }, key: null }
  }
  let list = listFor(lists, n)
  if (n.list !== null && list?.name !== n.list) {
    notice = { level: 'warning', text: `the list ${oneLine(n.list, 80)} isn't there any more, so ${list ? `${oneLine(list.name, 60)} is shown` : 'none is'}` }
    setTasksNav({ ...n, list: null, selected: null, notice })
  }
  const nav = tasksNavOf()!
  if (!list) {
    shown = null
    return { view: { view: 'tasks', v: nextV(), body: emptyBody(title, notice, nav, 'no task list to show') }, key: null }
  }
  const listKey = sanitize(list.name)
  title.push({ text: ` · ${oneLine(list.name, 80)}` })
  const key = await keyOf(p, list)
  const read = await deps.readTasks(p, list)
  const tasks = read.tasks
  const team = list.team !== null ? ((await deps.teams(p)).find(t => t.name === list.team) ?? null) : null
  const via: 'tool' | 'direct' = list.mine && (await p.toolNames().catch(() => [] as string[])).includes('TaskUpdate') ? 'tool' : 'direct'
  shown = { list, key: listKey, tasks, team, via, lists }

  const statusOf = new Map(tasks.map(t => [t.id, t.status]))
  let selected = nav.selected
  if (selected !== null && !statusOf.has(selected)) {
    const k = editKey(listKey, selected)
    const edits = { ...nav.edits }
    if (edits[k]) {
      delete edits[k]
      notice = { level: 'warning', text: `task #${selected} isn't in the list any more, so your edit of it was dropped` }
    }
    setTasksNav({ ...nav, selected: null, edits, notice })
    selected = null
  }

  const counts: Record<TasksFilter, number> = { all: tasks.length, pending: 0, in_progress: 0, completed: 0 }
  for (const t of tasks) if (t.status in counts) counts[t.status as TasksFilter]++
  const filter = tasksNavOf()!.filter
  const rows: TasksRow[] = sortTasks(filter === 'all' ? tasks : tasks.filter(t => t.status === filter), tasksNavOf()!.sort).map(t => ({
    id: t.id,
    status: STATUS[t.status] ?? UNKNOWN_STATUS,
    owner: t.owner === null ? null : oneLine(t.owner, 60),
    // A blocker that isn't completed blocks, a missing one included, as TaskList counts them.
    blockedBy: t.blockedBy.filter(b => statusOf.get(b) !== 'completed').map(b => oneLine(b, 12)),
    subject: oneLine(t.subject, ROW_SUBJECT),
    selected: t.id === selected,
  }))

  const before = seen.get(list.dir)
  const emptied = tasks.length > 0 ? null : before && before.count > 0 ? (before.allDone ? EMPTIED_DONE : EMPTIED_GONE) : (before?.emptied ?? null)
  seen.set(list.dir, { count: tasks.length, allDone: tasks.length > 0 && tasks.every(t => t.status === 'completed'), emptied })
  const empty =
    tasks.length === 0
      ? (emptied ?? `no tasks in ${list.mine ? "this session's list" : 'this list'} yet`)
      : rows.length === 0
        ? `no ${FILTER_LABEL[filter].toLowerCase()} tasks`
        : null

  const options: SwarmOption[] = []
  for (const l of lists) {
    const count = l === list ? tasks.length : await deps.countTasks(p, l)
    const kind = l.mine ? (l.kind === 'team' ? `team ${l.team}, this session's` : "this session's") : 'team'
    options.push({ value: l.name, label: oneLine(`${l.name} · ${kind} · ${count} task${count === 1 ? '' : 's'}`, 120) })
  }

  const task = selected === null ? null : (tasks.find(t => t.id === selected) ?? null)
  const editor = task ? editorOf(task, tasksNavOf()!.edits[editKey(listKey, task.id)] ?? null, team, via) : null
  const body: TasksBody = {
    title,
    notice,
    list: listKey,
    lists: options,
    listName: list.name,
    filter,
    counts,
    sort: tasksNavOf()!.sort,
    rows,
    empty,
    problems: read.problems.map(x => oneLine(x, 300)),
    editor,
  }
  return { view: { view: 'tasks', v: nextV(), body }, key }
}
