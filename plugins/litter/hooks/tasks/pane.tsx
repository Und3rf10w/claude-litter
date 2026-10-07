// `/litter tasks` and the tasks pane, the `litter` pane's Tasks section
// (phase 5; COMMON step 5, decisions 4, 15, 16; phase 5b, WP-DA): a task
// list's tasks with filters, a sort, owners and blocked state, and an inline
// editor, rebuilt on the ui tick while Tasks is shown. Keys
// are `tasks:<action>[:<arg>]`, a row's and the editor's
// `tasks:<action>:<list folder>/<id>`, so a press drawn for another list is
// caught. Reads and writes go through hooks/team/store.ts. Owner: WP-CE.
//
// The render is a pure function of the view in $.state (view.ts builds it).
// The editor holds what you type in the navigation until [Save]: a change
// is kept without a redraw (a redraw hands the field its text again, and a
// keystroke in flight would be lost), Enter or a pick redraws. [Save] sends
// only the fields that differ from the file as the edit began, and refuses
// when the file's mtime moved since: [Reload] takes the file's version.
// After a save the notice says how it was written (COMMON decision 4).

import type { RenderElement } from 'claude-code'
import type { Ports } from '../ports'
import type { CommandRunHook, PaneElements, PaneUiHandlers, PortHook } from '../hooktypes'
import type { TaskPatch } from '../uitypes'
import type { SwarmNotice, TasksBody, TasksEditor, TasksFilter, TasksPaneView, TasksRow, TasksSort } from '../../types/index'
import type { BodyContext, SectionMeta } from '../ui/chrome'
import type { Loaded } from '../ui/hub'
import { button, buttons, header, input, section, select, tableFor } from '../swarm/builder'
import { oneLine } from '../swarm/view'
import { STYLE } from '../ui/style'
import { openSection } from '../ui/hub'
import {
  FILTERS,
  FILTER_LABEL,
  LINE_MARK,
  SORTS,
  blankTasksNav,
  buildTasks,
  decodeField,
  deps,
  dirtyOf,
  editFrom,
  editKey,
  listNamed,
  resetTasksViewForTests,
  restoreTasksNav,
  saveTasksNav,
  setTasksNav,
  shownKey,
  shownOf,
  tasksNavOf,
  tasksNavRev,
  type TasksNav,
} from './view'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const SORT_LABEL: Record<TasksSort, string> = { id: 'id', status: 'status', owner: 'owner', subject: 'subject' }

// ---------------------------------------------------------------------------
// Drawing

/** What the last write was built under: the tick rebuilds only when either moved (decision 16). */
let lastKey: string | null = null
let lastRev = -1
let savedRev = -1

/** Builds the view for the navigation and writes it; saves the navigation when it moved. */
async function drawTasks(p: Ports): Promise<TasksPaneView | null> {
  if (!tasksNavOf()) return null
  const { view, key } = await buildTasks(p)
  await p.setView('tasks', view)
  lastKey = key
  lastRev = tasksNavRev()
  if (savedRev !== tasksNavRev()) {
    savedRev = tasksNavRev()
    await saveTasksNav(p)
  }
  return view
}

/** `/litter tasks [list]` (ui/hub.ts's litterCommand): shows Tasks on that list in the `litter` pane. */
export const tasksCommand: PortHook<CommandRunHook> = async (p, e, next) => ({ text: (await openSection(p, 'tasks', (e.args ?? '').trim(), { focus: true })).text })

/**
 * Tasks' load (openSection): the list named (its name, its folder's name or
 * its team's), else this session's own, else the first; answers the reply's
 * line. The filter, the sort and the edits begun stay from the last time.
 */
export async function loadTasks(p: Ports, args: string): Promise<Loaded> {
  await restoreTasksNav(p)
  const arg = args.trim()
  const prior = tasksNavOf()
  const n: TasksNav = { ...blankTasksNav(null), filter: prior?.filter ?? 'all', sort: prior?.sort ?? 'id', edits: prior?.edits ?? {} }
  if (arg !== '') {
    const lists = await deps.taskLists(p).catch(() => [])
    const found = listNamed(lists, arg)
    if (found) n.list = found.mine ? null : found.name
    else n.notice = { level: 'warning', text: `there's no task list named ${oneLine(arg, 80)}, so this session's is shown` }
  }
  setTasksNav(n)
  const view = await drawTasks(p)
  const b = view?.body
  const what =
    b?.list && b.listName !== null
      ? `shows ${oneLine(b.listName, 80)} (${b.counts.all} task${b.counts.all === 1 ? '' : 's'})`
      : `has nothing to show: ${b?.notice?.text ?? b?.empty ?? 'no task list'}`
  return { text: `Tasks ${what}` }
}

/** Tasks from the strip or Home: the list it showed, drawn again, else this session's. */
export async function resumeTasks(p: Ports): Promise<void> {
  await restoreTasksNav(p)
  if (tasksNavOf()) await drawTasks(p)
  else await loadTasks(p, '')
}

// ---------------------------------------------------------------------------
// The render

/** Tasks to the hub (chrome.tsx's SectionMeta): drawn whole for now, no keys of its own. */
export const tasksSection: SectionMeta<TasksPaneView> = { fits: false, keys: () => [] }

/** Tasks' body renderer (ui/pane.tsx calls it with the tasksPane atom under the hub's chrome). Pure. */
export function renderTasksPane(view: TasksPaneView | null, resolved: PaneElements, ctx: BodyContext): RenderElement {
  const el = tableFor(resolved, ctx.surface)
  const { Box, Text } = el
  const body = view?.body
  if (!body) {
    return (
      <Box flexDirection="column">
        <Text bold>litter · tasks</Text>
        <Text dimColor>nothing to show yet: /litter tasks opens a task list</Text>
      </Box>
    )
  }
  const problems = body.problems ?? []
  return (
    <Box flexDirection="column">
      {header(el, body.title, body.notice ?? null)}
      {body.list ? controlsPart(el, body) : null}
      {body.list ? rowsPart(el, body.list, body.rows ?? [], body.empty ?? null) : null}
      {!body.list && body.empty ? <Text dimColor>{body.empty}</Text> : null}
      {problems.length > 0 && (
        <Box flexDirection="column">
          {section(el, 'Not read', { text: 'files the engine would skip too', dim: true })}
          {problems.map(x => (
            <Text color={STYLE.warning} wrap="wrap">{`! ${x}`}</Text>
          ))}
        </Box>
      )}
      {body.list && body.editor ? editorPart(el, body.list, body.editor) : null}
    </Box>
  )
}

// `h` and `Fragment` are the environment's JSX factory, so no name here takes them.
function controlsPart(el: PaneElements, body: TasksBody): RenderElement {
  const { Box, Text } = el
  const counts = body.counts ?? { all: 0, pending: 0, in_progress: 0, completed: 0 }
  const fields = 'Select' in el
  return (
    <Box flexDirection="column" marginTop={1}>
      {fields ? (
        select(el, { key: 'tasks:list', label: 'List', value: body.listName ?? '', options: body.lists ?? [] })
      ) : (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text>List</Text>
          {(body.lists ?? []).map(o => button(el, { key: `tasks:pick:${o.value}`, label: o.label, ...(o.value === body.listName ? { primary: true } : {}) }))}
        </Box>
      )}
      {body.hidden ? (
        <Text color={STYLE.muted} wrap="truncate-end">
          {body.hidden}
        </Text>
      ) : null}
      {buttons(
        el,
        FILTERS.map(f => ({ key: `tasks:filter:${f}`, label: `${body.filter === f ? '› ' : ''}${FILTER_LABEL[f]} ${counts[f] ?? 0}`, primary: body.filter === f })),
      )}
      {fields ? (
        select(el, { key: 'tasks:sort', label: 'Sort by', value: body.sort, options: SORTS.map(s => ({ value: s, label: SORT_LABEL[s] })) })
      ) : (
        <Box flexDirection="row" columnGap={1}>
          <Text>Sort by</Text>
          {SORTS.map(s => button(el, { key: `tasks:sort:${s}`, label: SORT_LABEL[s], ...(s === body.sort ? { primary: true } : {}) }))}
        </Box>
      )}
    </Box>
  )
}

function rowsPart(el: PaneElements, list: string, rows: readonly TasksRow[], empty: string | null): RenderElement {
  const { Box, Button, Text } = el
  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.length === 0 && <Text dimColor wrap="wrap">{empty ?? 'no tasks'}</Text>}
      {rows.map(r => (
        <Box flexDirection="row" columnGap={1}>
          <Text color={STYLE.accent}>{r.selected ? '›' : ' '}</Text>
          <Button key={`tasks:select:${list}/${r.id}`} label={`#${r.id}`} plain onPress={() => {}} />
          <Text color={r.status.color}>{`${r.status.glyph} ${r.status.text}`.padEnd(13)}</Text>
          {r.owner !== null ? <Text color={STYLE.name}>{r.owner}</Text> : <Text dimColor>unowned</Text>}
          {r.blockedBy.length > 0 && <Text color={STYLE.warning}>{`⊘ blocked by ${r.blockedBy.map(b => `#${b}`).join(' ')}`}</Text>}
          <Text wrap="truncate-end">{r.subject}</Text>
        </Box>
      ))}
    </Box>
  )
}

function editorPart(el: PaneElements, list: string, ed: TasksEditor): RenderElement {
  const { Box, Text } = el
  const k = (action: string) => `tasks:${action}:${list}/${ed.id}`
  const how = ed.via === 'tool' ? 'saves through TaskUpdate' : 'saves by a direct write: no hooks run, and an owner change sends no message'
  return (
    <Box flexDirection="column">
      {section(el, `Task #${ed.id}`, { text: how, dim: true })}
      {ed.subject !== null ? (
        input(el, { key: k('subject'), label: 'Subject', value: ed.subject, submitLabel: 'keep' })
      ) : (
        <Text color={STYLE.warning}>! the subject is too long to edit here</Text>
      )}
      {ed.description !== null ? (
        input(el, { key: k('description'), label: 'Description', value: ed.description, placeholder: `one line; ${LINE_MARK} marks a line break`, submitLabel: 'keep' })
      ) : (
        <Text color={STYLE.warning}>! the description is too long to edit here</Text>
      )}
      {ed.descriptionText !== null && <Text dimColor wrap="wrap">{ed.descriptionText}</Text>}
      {select(el, { key: k('status'), label: 'Status', value: ed.status, options: ed.statuses })}
      {select(el, { key: k('owner'), label: 'Owner', value: ed.owner, options: ed.owners })}
      {ed.links !== '' && <Text dimColor>{ed.links}</Text>}
      {ed.changed && <Text color={STYLE.warning} wrap="wrap">{`! #${ed.id} changed on disk since you began editing: [Reload] takes the file's version and drops yours`}</Text>}
      {buttons(el, [
        { key: k('save'), label: 'Save', ...(ed.dirty && !ed.changed ? { primary: true } : { dim: true }) },
        { key: k('revert'), label: 'Revert', ...(ed.dirty ? {} : { dim: true }) },
        ed.changed && { key: k('reload'), label: 'Reload' },
      ])}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// The events

type TasksKey = { action: string; arg: string }

const parseKey = (key: string): TasksKey | null => {
  if (!key.startsWith('tasks:')) return null
  const [, action, ...rest] = key.split(':')
  return action ? { action, arg: rest.join(':') } : null
}

const say = (level: SwarmNotice['level'], text: string): void => {
  const n = tasksNavOf()
  if (n) setTasksNav({ ...n, notice: { level, text: oneLine(text, 400) } })
}

/** A row's or the editor's `<list folder>/<id>`, checked against what the last build drew; null (said, unless quiet) when it's stale. */
function target(p: Ports, arg: string, quiet = false): { listKey: string; id: string; task: NonNullable<ReturnType<typeof shownOf>>['tasks'][number] } | null {
  const m = /^([A-Za-z0-9_-]+)\/([0-9]+)$/.exec(arg)
  const s = shownOf()
  const task = m && s && s.key === m[1] ? s.tasks.find(t => t.id === m[2]) : undefined
  if (m && task) return { listKey: m[1]!, id: m[2]!, task }
  if (!quiet) {
    p.toast("that was drawn for another list, or for a task that's gone, so it was ignored")
    say('warning', "that was drawn for another list, or for a task that's gone, so the press was ignored")
  }
  return null
}

/** [Save]: only the fields that differ from the file as the edit began, and only if the file hasn't moved since. */
async function save(p: Ports, arg: string): Promise<void> {
  const t = target(p, arg)
  const s = shownOf()
  if (!t || !s) return
  const n = tasksNavOf()!
  const k = editKey(t.listKey, t.id)
  const held = n.edits[k]
  if (!held || !dirtyOf(held)) return say('info', `nothing to save: #${t.id} is as its file has it`)
  const now = await p.fs.stat(t.task.path).catch(() => null)
  if (!now) return say('error', `#${t.id} isn't there any more, so nothing was saved`)
  if (now.mtimeMs !== held.base.mtimeMs) {
    return say('warning', `#${t.id} changed on disk since you began editing, so nothing was saved: [Reload] takes the file's version (and drops yours)`)
  }
  const patch: TaskPatch = {}
  if (held.subject !== held.base.subject) patch.subject = held.subject
  if (held.description !== held.base.description) patch.description = held.description
  if (held.status !== held.base.status) patch.status = held.status as TaskPatch['status']
  if (held.owner !== held.base.owner) patch.owner = held.owner
  p.log(`tasks pane: updateTask ${s.list.name} #${t.id} (${Object.keys(patch).join(', ')})`)
  const r = await deps.updateTask(p, s.list, t.id, patch)
  if (!r.ok) return say('error', `#${t.id} wasn't saved: ${r.error}`)
  const edits = { ...n.edits }
  delete edits[k]
  const how = r.via === 'tool' ? `#${t.id} saved through TaskUpdate` : `#${t.id} written directly: no hooks ran${'owner' in patch ? ', and no assignment message was sent' : ''}`
  setTasksNav({ ...n, edits, notice: { level: 'ok', text: how } })
}

/** One press: the stale check, the action, then the redraw. */
export async function pressTasks(p: Ports, key: string): Promise<void> {
  const k = parseKey(key)
  if (!k) return
  await restoreTasksNav(p)
  const cur = tasksNavOf()
  if (!cur) {
    p.toast('the tasks pane was closed, so that was ignored')
    return
  }
  // After a hot reload nothing was drawn by this module yet: build first, so the press is checked against what's there.
  if (!shownOf()) await drawTasks(p)
  // A new action's outcome replaces the last one's.
  setTasksNav({ ...tasksNavOf()!, notice: null })
  const n = tasksNavOf()!
  try {
    switch (k.action) {
      case 'filter':
        if ((FILTERS as readonly string[]).includes(k.arg)) setTasksNav({ ...n, filter: k.arg as TasksFilter })
        break
      case 'sort':
        if ((SORTS as readonly string[]).includes(k.arg)) setTasksNav({ ...n, sort: k.arg as TasksSort })
        break
      case 'pick':
        pickList(p, k.arg)
        break
      case 'select': {
        const t = target(p, k.arg)
        if (t) setTasksNav({ ...n, selected: t.id })
        break
      }
      case 'save':
        await save(p, k.arg)
        break
      case 'revert':
      case 'reload': {
        const t = target(p, k.arg)
        if (!t) break
        const edits = { ...n.edits }
        const had = edits[editKey(t.listKey, t.id)] !== undefined
        delete edits[editKey(t.listKey, t.id)]
        const text = k.action === 'reload' ? `#${t.id} reloaded from its file${had ? '; your edit was dropped' : ''}` : had ? `your edit of #${t.id} was dropped` : `#${t.id} had no edit to revert`
        setTasksNav({ ...n, edits, notice: { level: 'info', text } })
        break
      }
      default:
        return
    }
  } catch (err) {
    p.log(`tasks pane: ${key} failed: ${errText(err)}`)
    say('error', `that failed: ${errText(err)}`)
  }
  await drawTasks(p)
}

/** A list picked by name: one the last build offered, else the press is stale. */
function pickList(p: Ports, name: string): void {
  const s = shownOf()
  const l = s?.lists.find(x => x.name === name)
  const n = tasksNavOf()!
  if (!l) {
    p.toast("that list isn't offered any more, so it was ignored")
    return say('warning', "that list isn't offered any more, so the pick was ignored")
  }
  if (s && l.dir === s.list.dir) return
  setTasksNav({ ...n, list: l.mine ? null : l.name, selected: null })
}

/** A field: the subject or the description an edit holds. A change is kept without a redraw; Enter redraws. */
async function inputTasks(p: Ports, key: string, value: string, kind: 'change' | 'submit' | undefined): Promise<void> {
  const k = parseKey(key)
  if (!k || (k.action !== 'subject' && k.action !== 'description')) return
  await restoreTasksNav(p)
  const n = tasksNavOf()
  const t = n ? target(p, k.arg, true) : null
  if (!n || !t) return
  const ek = editKey(t.listKey, t.id)
  const next = { ...(n.edits[ek] ?? editFrom(t.task)), [k.action]: decodeField(value) }
  if (kind === 'change') {
    // Not a navigation change: the tick's rebuild draws it as typed, and a reload keeps it once something else saves.
    n.edits[ek] = next
    return
  }
  setTasksNav({ ...n, edits: { ...n.edits, [ek]: next }, notice: null })
  await drawTasks(p)
}

/** A pick: the list, the sort, or an edit's status or owner. */
async function selectTasks(p: Ports, key: string, value: string): Promise<void> {
  const k = parseKey(key)
  if (!k) return
  await restoreTasksNav(p)
  if (!tasksNavOf()) return
  if (!shownOf()) await drawTasks(p)
  const n = tasksNavOf()!
  switch (k.action) {
    case 'list':
      setTasksNav({ ...tasksNavOf()!, notice: null })
      pickList(p, value)
      break
    case 'sort':
      if (!(SORTS as readonly string[]).includes(value)) return
      setTasksNav({ ...n, sort: value as TasksSort })
      break
    case 'status':
    case 'owner': {
      const t = target(p, k.arg)
      if (!t) break
      const ek = editKey(t.listKey, t.id)
      const held = n.edits[ek] ?? editFrom(t.task)
      if (k.action === 'status') {
        if (!['pending', 'in_progress', 'completed'].includes(value)) return
        setTasksNav({ ...n, edits: { ...n.edits, [ek]: { ...held, status: value } }, notice: null })
      } else {
        // An owner the editor offered: none, a member, or the owner it has.
        const members = shownOf()?.team?.members.map(m => m.name) ?? []
        if (value !== '' && !members.includes(value) && value !== t.task.owner && value !== held.owner) return
        setTasksNav({ ...n, edits: { ...n.edits, [ek]: { ...held, owner: value === '' ? null : value } }, notice: null })
      }
      break
    }
    default:
      return
  }
  await drawTasks(p)
}

/** The pane's ui.message, ui.press, ui.input and ui.select; anything not keyed `tasks:` passes on. */
export const onTasksUi: PaneUiHandlers = {
  // The pane draws no Client, so nothing of its own posts.
  message: async (p, e, next) => next(e),
  press: async (p, e, next) => {
    if (!parseKey(e.element)) return next(e)
    await pressTasks(p, e.element)
    return { element: e.element }
  },
  input: async (p, e, next) => {
    if (!parseKey(e.element)) return next(e)
    await inputTasks(p, e.element, e.value, e.kind)
    return { element: e.element, value: e.value }
  },
  select: async (p, e, next) => {
    if (!parseKey(e.element)) return next(e)
    await selectTasks(p, e.element, e.value)
    return { element: e.element, value: e.value }
  },
}

// ---------------------------------------------------------------------------
// The tick

/** Tasks' tick (ui/hub.ts's litterTick, while Tasks is shown): the view again while it has a navigation, only when its stamp or the navigation moved (decision 16). */
export async function tasksTick(p: Ports): Promise<void> {
  await restoreTasksNav(p)
  if (!tasksNavOf()) return
  const key = await shownKey(p)
  if (key !== null && key === lastKey && tasksNavRev() === lastRev) return
  await drawTasks(p)
}

/** After a /clear wiped $.state (clear.ts): the pane's view again, if it's open, written even when nothing changed. */
export async function refreshTasks(p: Ports): Promise<void> {
  await restoreTasksNav(p)
  if (tasksNavOf()) await drawTasks(p)
}

/** A fresh module's memory, for tests: the view's too. */
export function resetTasksPaneForTests(): void {
  lastKey = null
  lastRev = -1
  savedRev = -1
  resetTasksViewForTests()
}
