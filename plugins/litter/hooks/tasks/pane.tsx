// `/litter tasks` and the tasks pane, the `litter` pane's Tasks section
// (phase 5; COMMON step 5, decisions 4, 15, 16; phase 5b, WP-DA, WP-DF): a
// task list's tasks with filters, a sort, owners and blocked state, and an
// inline editor, rebuilt on the ui tick while Tasks is shown. Keys are
// `tasks:<action>[:<arg>]`, a row's and the editor's
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
//
// Phase 5b (WP-DF): no title line of its own, the first line names the list
// shown and its counts; the picker is the chrome's list (folded to one line
// with [Change] inline or in a short dock), the empty team lists counted
// under it with [Show all]; the filters a strip, the shown one primary; the
// tasks the chrome's list, each row's right-click menu (Edit, Mark in
// progress, Mark completed, Assign to…) acting through the editor's own
// save; the editor's Subject and Description framed fields captioned with
// how they save, the changed-on-disk line a banner with [Reload]; the files
// that couldn't be read notices above the lists. The body keeps to the rows
// the hub gives it (tasksPlan), and the wheel moves the list it's over
// (tasksTops, kept in step with the render).

import type { RenderElement } from 'claude-code'
import type { Ports } from '../ports'
import type { CommandRunHook, PaneElements, PaneUiHandlers, PortHook, UiScrollHook } from '../hooktypes'
import type { TaskPatch } from '../uitypes'
import type { SwarmNotice, SwarmOption, TasksBody, TasksEditor, TasksFilter, TasksPaneView, TasksRow, TasksSort } from '../../types/index'
import type { Loaded } from '../ui/hub'
import { cells } from '../band/view'
import { tableFor } from '../swarm/builder'
import { clean, oneLine } from '../swarm/view'
import { NOTICE_STYLE, STYLE, type NoticeLevel } from '../ui/style'
import { action, actions, empty, field, fieldOverflows, fieldRows, fitCell, framesFields, heading, notice, packItems, textRows, type BodyContext, type SectionMeta } from '../ui/chrome'
import { DESCRIPTION_MIN, list, listPlace, pageOf, scrolled, type ListAction, type ListSpec } from '../ui/list'
import { lastDrawn } from '../ui/drawn'
import { listOffset, moveList, openSection } from '../ui/hub'
import { namedHeading } from '../agents/pane'
import {
  FILTERS,
  FILTER_LABEL,
  LINE_MARK,
  SORTS,
  STATUS,
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
  type TasksEdit,
  type TasksNav,
  type TasksShown,
} from './view'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const noop = (): void => {}
const SORT_LABEL: Record<TasksSort, string> = { id: 'id', status: 'status', owner: 'owner', subject: 'subject' }

// ---------------------------------------------------------------------------
// Drawing

/** What the last write was built under: the tick rebuilds only when either moved (decision 16). */
let lastKey: string | null = null
let lastRev = -1
let savedRev = -1
/** The last view this module wrote: a footer's page on a surface the hub notes no drawing for (ui/drawn.ts notes the terminal's only). */
let lastView: TasksPaneView | null = null

/** Builds the view for the navigation and writes it; saves the navigation when it moved. */
async function drawTasks(p: Ports): Promise<TasksPaneView | null> {
  if (!tasksNavOf()) return null
  const { view, key } = await buildTasks(p)
  await p.setView('tasks', view)
  lastView = view
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
 * line. The filter, the sort, [Show all] and the edits begun stay from the
 * last time.
 */
export async function loadTasks(p: Ports, args: string): Promise<Loaded> {
  await restoreTasksNav(p)
  const arg = args.trim()
  const prior = tasksNavOf()
  const n: TasksNav = { ...blankTasksNav(null), filter: prior?.filter ?? 'all', sort: prior?.sort ?? 'id', edits: prior?.edits ?? {}, showEmpty: prior?.showEmpty ?? false }
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
// The render (phase 5b, WP-DF)
//
// The first line (the list shown, its counts), the last action's outcome,
// the files that couldn't be read, the picker, the filters and the sort, the
// tasks, and the selected task's editor. tasksPlan shares the body's rows
// (ctx.rows) among them: the picker's window, then the tasks' window, which
// takes what the rest leaves.

/** The picker's window at most. */
export const PICKER_ROWS = 5
/** Under this many body rows, or inline, the picker folds to one line with [Change]. */
export const SHORT_ROWS = 24
/** The fewest task rows the dock keeps before the picker gives up its rows. */
export const ROWS_MIN = 3
/** The tasks' window inline. */
export const ROWS_INLINE = 10
/** The files not read that are drawn; the rest are counted. */
const PROBLEMS_SHOWN = 3
/** The fewest cells a subject keeps before the owner's column goes. */
export const SUBJECT_MIN = 20
/** An owner's cells at most. */
const OWNER_CELLS = 16
/** The rows a description's own lines take under its field at most. */
const DESCRIPTION_TEXT_ROWS = 3

/**
 * The description's own lines under its field: its lines when it has
 * several; its one line, cleaned, when the framed field cuts it, so the
 * whole of it reads (the user's live look, 2026-10-07). Pure.
 */
function descriptionLines(ed: TasksEditor, ctx: Pick<BodyContext, 'surface' | 'bodyColumns'>): string | null {
  if (ed.descriptionText !== null) return ed.descriptionText
  if (ed.description === null || !framesFields(ctx.surface)) return null
  return fieldOverflows({ label: 'Description', value: ed.description }, ctx.bodyColumns) ? clean(ed.description, 2000) : null
}
/** `[ Reload ]` and its gap, beside the changed-on-disk line. */
const RELOAD_CELLS = 11
/** The lists' ids: the hub keeps each window by it, and its footer's keys are `<id>:up` and `<id>:down`. */
export const LISTS_LIST = 'tasks:lists'
export const ROWS_LIST = 'tasks:rows'

/** Tasks to the hub (chrome.tsx's SectionMeta): its body keeps to ctx.rows; its keys. */
export const tasksSection: SectionMeta<TasksPaneView> = {
  fits: true,
  keys: view =>
    (view?.body?.rows.length ?? 0) > 0
      ? [
          { key: 'right-click', word: "a task's actions" },
          { key: 'wheel', word: 'scrolls the list under it' },
        ]
      : [],
}

/** What the planner reads of the context. */
export type TasksCtx = Pick<BodyContext, 'surface' | 'bodyColumns' | 'rows' | 'placement' | 'focused' | 'lists'>

/** How the body shares its rows: the picker's form and window, and the tasks' window. */
export type TasksPlan = { picker: 'none' | 'list' | 'folded'; pickerRows: number; rows: number }

/** Where Select and Input are drawn (swarm/builder.tsx's tableFor): everywhere but the mobile app. */
const fieldsOn = (surface: string): boolean => surface !== 'mobile'
const noticeText = (level: NoticeLevel, text: string): string => `${NOTICE_STYLE[level].glyph} ${text}`
const buttonRows = (labels: readonly string[], columns: number): number =>
  labels.length === 0 ? 0 : packItems(labels.map(label => ({ kind: 'button' as const, label })), Number.isFinite(columns) ? columns : Number.POSITIVE_INFINITY).length
const problemText = (x: string): string => `not read: ${x}`
const filterLabel = (body: TasksBody, f: TasksFilter): string => `${FILTER_LABEL[f]} ${body.counts[f] ?? 0}`
const changedText = (ed: TasksEditor): string => `#${ed.id} changed on disk since your edit began: [Reload] takes the file's version and drops yours`
/** A text cut to `n` cells (`…`), else as it is. */
const cut = (text: string, n: number): string => (cells(text) > n ? fitCell(text, n).trimEnd() : text)

/** The picker as the chrome's list: each list with its open tasks and its kind, the focused one's tasks, team and folder beside or under it. */
export function pickerSpec(body: TasksBody, rows: number): ListSpec {
  return {
    id: LISTS_LIST,
    rows,
    items: body.lists.map(o => {
      const some = (o.open ?? o.total) > 0
      return {
        key: `tasks:pick:${o.value}`,
        label: o.label,
        cells: [
          { text: o.open === null ? plural(o.total, 'task') : `${o.open} open`, ...(some ? {} : { color: STYLE.muted }) },
          { text: o.kind, color: STYLE.muted },
        ],
        description: o.description,
        selected: o.value === body.listName,
      }
    }),
    columns: [{ drop: 0 }, { drop: 1 }],
  }
}

/**
 * The tasks as the chrome's list: each row `#id`, its status (glyph, word,
 * color), its owner in the name color (or "unowned" muted), `⊘ blocked by
 * #n` in the warning color, and its subject, which takes the width the rest
 * leaves (cut to it); the owner's column goes first when that's under
 * SUBJECT_MIN. The focused row's description is the task's, with its links.
 * Its menu: Edit, Mark in progress, Mark completed, Assign to… (each where
 * it applies; Assign to… only where Owner is a Select). Pure.
 */
export function rowsSpec(body: TasksBody, rows: number, ctx: Pick<BodyContext, 'bodyColumns' | 'surface'>): ListSpec {
  const listKey = body.list ?? ''
  const all = body.rows
  const statusText = (r: TasksRow): string => `${r.status.glyph} ${r.status.text}`
  const ownerText = (r: TasksRow): string => cut(r.owner ?? 'unowned', OWNER_CELLS)
  const blockedText = (r: TasksRow): string => (r.blockedBy.length > 0 ? `⊘ blocked by ${r.blockedBy.map(b => `#${b}`).join(' ')}` : '')
  const widest = (f: (r: TasksRow) => string): number => Math.max(0, ...all.map(r => cells(f(r))))
  const wId = widest(r => `#${r.id}`)
  const wStatus = widest(statusText)
  const wOwner = widest(ownerText)
  const wBlocked = widest(blockedText)
  const blocked = wBlocked > 0
  const cols = ctx.bodyColumns
  const finite = Number.isFinite(cols)
  // The mark and its gap, the id, then each column and its gap: the subject has the rest.
  const used = (owner: boolean): number => 2 + wId + 1 + wStatus + 1 + (owner ? wOwner + 1 : 0) + (blocked ? wBlocked + 1 : 0)
  const withOwner = !finite || Math.floor(cols) - used(true) >= SUBJECT_MIN
  const room = finite ? Math.max(1, Math.floor(cols) - used(withOwner)) : Number.POSITIVE_INFINITY
  const subject = (r: TasksRow): string => (finite ? cut(r.subject, room) : r.subject)
  // Every cell padded to its column's width over all the rows, so any window plans the same widths, and what's
  // left beside them is known here: a description that sits there is cut to it (the Client's row would wrap
  // under one that runs over).
  const wSubject = widest(subject)
  const beside = finite ? Math.floor(cols) - used(withOwner) - wSubject - 1 : Number.POSITIVE_INFINITY
  const pad = (text: string, w: number): string => (finite ? fitCell(text, w) : text)
  const assign = fieldsOn(ctx.surface)
  return {
    id: ROWS_LIST,
    rows,
    items: all.map(r => {
      const arg = `${listKey}/${r.id}`
      const menu: ListAction[] = [{ key: `tasks:edit:${arg}`, label: 'Edit' }]
      if (r.can.start) menu.push({ key: `tasks:start:${arg}`, label: 'Mark in progress' })
      if (r.can.complete) menu.push({ key: `tasks:complete:${arg}`, label: 'Mark completed' })
      if (r.can.assign && assign) menu.push({ key: `tasks:assign:${arg}`, label: 'Assign to…' })
      const words = [r.description, r.links].filter(x => x !== '').join(' · ')
      const description = beside >= DESCRIPTION_MIN && Number.isFinite(beside) ? cut(words, beside) : words
      return {
        key: `tasks:select:${arg}`,
        label: pad(`#${r.id}`, wId),
        cells: [
          { text: pad(statusText(r), wStatus), color: r.status.color },
          ...(withOwner ? [r.owner !== null ? { text: pad(ownerText(r), wOwner), color: STYLE.name } : { text: pad('unowned', wOwner), color: STYLE.muted }] : []),
          ...(blocked ? [{ text: pad(blockedText(r), wBlocked), color: STYLE.warning }] : []),
          { text: pad(subject(r), wSubject) },
        ],
        ...(description !== '' ? { description } : {}),
        selected: r.selected,
        actions: menu,
      }
    }),
    // Every column kept: the subject was cut to fit, so nothing runs over.
    columns: [{ drop: 0 }, ...(withOwner ? [{ drop: 0 }] : []), ...(blocked ? [{ drop: 0 }] : []), { drop: 0 }],
    empty: body.empty ?? 'no tasks',
  }
}

/** No picker at all: one list, and none left out. */
const noChoice = (body: TasksBody): boolean => body.lists.length <= 1 && body.hiddenCount === 0 && !body.showEmpty

/** The line under the picker's list: drawn while some are hidden, or [Show all] is on. */
const hiddenLineRows = (body: TasksBody): number => (body.hiddenCount > 0 || body.showEmpty ? 1 : 0)

/** The picker's rows in a form: none; one folded; the `Lists` heading, the list, the hidden line and the `Tasks` heading. */
function pickerHeight(body: TasksBody, ctx: TasksCtx, form: TasksPlan['picker'], rows: number): number {
  if (form === 'none') return 0
  if (form === 'folded') return 1
  return 1 + listPlace(pickerSpec(body, rows), ctx).height + hiddenLineRows(body) + 1
}

/** The rows above the picker: the first line, the notice, the files not read. */
function topRows(body: TasksBody, cols: number): number {
  let n = 1
  if (body.notice) n += textRows(noticeText(body.notice.level, body.notice.text), cols)
  for (const x of body.problems.slice(0, PROBLEMS_SHOWN)) n += textRows(noticeText('warning', problemText(x)), cols)
  if (body.problems.length > PROBLEMS_SHOWN) n += 1
  return n
}

/** The filters' strip, wrapping, and the sort: a Select's row, or `Sort by` and its Buttons. */
function controlsRows(body: TasksBody, ctx: TasksCtx): number {
  const cols = ctx.bodyColumns
  const sort = fieldsOn(ctx.surface) ? 1 : buttonRows(SORTS.map(s => SORT_LABEL[s]), Number.isFinite(cols) ? cols - 8 : cols)
  return buttonRows(FILTERS.map(f => filterLabel(body, f)), cols) + sort
}

/** The editor's rows: its heading, the two fields (or the line in place of one), the description's lines, Status and Owner, the banner, [Save] [Revert]. */
function editorRows(body: TasksBody, ctx: TasksCtx): number {
  const ed = body.editor
  if (!ed || body.list === null) return 0
  const cols = ctx.bodyColumns
  // A field with its caption; on the mobile app its value as text, then the caption.
  const fieldH = (has: boolean): number => (!has ? 1 : fieldsOn(ctx.surface) ? fieldRows(ctx.surface, true) : 2)
  let n = 1 + fieldH(ed.subject !== null) + fieldH(ed.description !== null) + 2 + 1
  const lines = descriptionLines(ed, ctx)
  if (lines !== null) n += Math.min(DESCRIPTION_TEXT_ROWS, textRows(lines, cols))
  if (ed.changed) n += textRows(noticeText('warning', changedText(ed)), Number.isFinite(cols) ? cols - RELOAD_CELLS : cols)
  return n
}

/** The tasks' rows at a window of `rows`: the list's, or its one line for none. */
const rowsHeight = (body: TasksBody, ctx: TasksCtx, rows: number): number => listPlace(rowsSpec(body, rows, ctx), ctx).height

/**
 * The plan: what every layout draws in full (the first line, the notices,
 * the filters and the sort, the editor), then the picker (folded on a short
 * or inline body, unless [Change] opened it; its window up to PICKER_ROWS,
 * given up a row at a time, then folded, before the tasks go under
 * ROWS_MIN), then the tasks' window all the rest. Inline, nothing bounds
 * it: the tasks' window is ROWS_INLINE. Pure.
 */
export function tasksPlan(body: TasksBody, ctx: TasksCtx): TasksPlan {
  const count = body.rows.length
  const none = noChoice(body)
  let pickerRows = Math.max(1, Math.min(PICKER_ROWS, body.lists.length))
  const bounded = ctx.placement === 'dock' && Number.isFinite(ctx.rows)
  if (!bounded) return { picker: none ? 'none' : body.picking ? 'list' : 'folded', pickerRows, rows: Math.max(1, Math.min(count, ROWS_INLINE)) }
  const fixed = topRows(body, ctx.bodyColumns) + controlsRows(body, ctx) + editorRows(body, ctx)
  const rowsMin = Math.max(1, Math.min(count, ROWS_MIN))
  const need = rowsHeight(body, ctx, rowsMin)
  let picker: TasksPlan['picker'] = none ? 'none' : ctx.rows < SHORT_ROWS && !body.picking ? 'folded' : 'list'
  while (picker === 'list' && pickerRows > 2 && ctx.rows - fixed - pickerHeight(body, ctx, picker, pickerRows) < need) pickerRows--
  if (picker === 'list' && !body.picking && ctx.rows - fixed - pickerHeight(body, ctx, picker, pickerRows) < need) picker = 'folded'
  let left = ctx.rows - fixed - pickerHeight(body, ctx, picker, pickerRows) - need
  let rows = rowsMin
  while (rows < count) {
    const more = rowsHeight(body, ctx, rows + 1) - rowsHeight(body, ctx, rows)
    if (more > left) break
    left -= more
    rows++
  }
  return { picker, pickerRows, rows }
}

/** A scrolled part's first row in the body, and its rows. */
export type TasksPart = { top: number; height: number }

/**
 * Where the two lists start, in rows from the body's first, and the rows
 * each takes: the picker's (null unless it's drawn as a list) and the tasks'
 * (null with none). Kept in step with renderTasksPane, part by part: the
 * wheel's hit test (onTasksScroll) reads it. Pure.
 */
export type TasksTops = { plan: TasksPlan; picker: TasksPart | null; rows: TasksPart | null }

export function tasksTops(body: TasksBody, ctx: TasksCtx): TasksTops {
  const plan = tasksPlan(body, ctx)
  let at = topRows(body, ctx.bodyColumns)
  if (body.list === null) return { plan, picker: null, rows: null }
  // The picker's list sits under its `Lists` heading.
  const picker = plan.picker === 'list' ? { top: at + 1, height: listPlace(pickerSpec(body, plan.pickerRows), ctx).height } : null
  at += pickerHeight(body, ctx, plan.picker, plan.pickerRows) + controlsRows(body, ctx)
  const rows = body.rows.length > 0 ? { top: at, height: rowsHeight(body, ctx, plan.rows) } : null
  return { plan, picker, rows }
}

/**
 * What each surface last drew of the body: a footer's page reads it, since a
 * press carries its surface but not the rows the body had there. The render
 * notes it (as ui/pane.tsx notes the terminal's drawing in ui/drawn.ts); the
 * note changes nothing drawn.
 */
const rendered = new Map<string, { body: TasksBody; ctx: TasksCtx }>()

/** Tasks' body renderer (ui/pane.tsx calls it with the tasksPane atom under the hub's chrome). Pure but for its note of what it drew. */
export function renderTasksPane(view: TasksPaneView | null, resolved: PaneElements, ctx: BodyContext): RenderElement {
  const el = tableFor(resolved, ctx.surface)
  const { Box } = el
  const body = view?.body
  if (!body) return empty(el, 'nothing to show yet', { command: '/litter tasks', does: 'opens a task list' })
  rendered.set(ctx.surface, { body, ctx })
  const cols = ctx.bodyColumns
  const head = body.head
  const plan = tasksPlan(body, ctx)
  const shown = body.list
  return (
    <Box flexDirection="column">
      {head.name === null ? heading(el, head.label, cols, head.note) : namedHeading(el, head.label, head.name, cols, head.note)}
      {body.notice ? notice(el, body.notice.level, body.notice.text) : null}
      {problemsPart(el, body)}
      {shown !== null ? pickerPart(el, body, plan, ctx) : null}
      {shown !== null ? controlsPart(el, body) : null}
      {shown !== null ? list(el, rowsSpec(body, plan.rows, ctx), ctx) : null}
      {shown !== null && body.editor ? editorPart(el, shown, body.editor, ctx) : null}
    </Box>
  )
}

// `h` and `Fragment` are the environment's JSX factory, so no name here takes them.

/** The files that couldn't be read: a notice each, the first few, then how many more. */
function problemsPart(el: PaneElements, body: TasksBody): RenderElement | null {
  const { Box, Text } = el
  if (body.problems.length === 0) return null
  const more = body.problems.length - PROBLEMS_SHOWN
  return (
    <Box flexDirection="column">
      {body.problems.slice(0, PROBLEMS_SHOWN).map(x => notice(el, 'warning', problemText(x)))}
      {more > 0 ? <Text color={STYLE.muted}>{`${more} more not read`}</Text> : null}
    </Box>
  )
}

/** The picker: one line with [Change] when folded, else the chrome's list under `Lists`, the empty lists it left out with [Show all], and the `Tasks` heading. */
function pickerPart(el: PaneElements, body: TasksBody, plan: TasksPlan, ctx: BodyContext): RenderElement | null {
  const { Box, Text } = el
  if (plan.picker === 'none') return null
  if (plan.picker === 'folded') {
    const others = body.lists.length - 1
    const note = [others > 0 ? plural(others, 'other') : '', body.hiddenCount > 0 ? `${body.hiddenCount} empty hidden` : ''].filter(x => x !== '').join(', ')
    return (
      <Box flexDirection="row" columnGap={1}>
        <Text color={STYLE.muted}>List</Text>
        <Text color={body.head.name === null ? STYLE.label : STYLE.name} wrap="truncate-end">
          {body.head.name ?? body.head.label}
        </Text>
        {note !== '' ? <Text color={STYLE.muted} wrap="truncate-end">{`· ${note}`}</Text> : null}
        {actions(el, [{ key: 'tasks:picker:open', label: 'Change' }])}
      </Box>
    )
  }
  const hidden =
    body.hiddenCount > 0 || body.showEmpty ? (
      <Box flexDirection="row" columnGap={1}>
        <Text color={STYLE.muted} wrap="truncate-end">
          {body.showEmpty ? 'every list shown, the empty ones too' : (body.hidden ?? `${plural(body.hiddenCount, 'empty list')} hidden`)}
        </Text>
        {actions(el, [body.showEmpty ? { key: 'tasks:empty:hide', label: 'Hide empty' } : { key: 'tasks:empty:show', label: 'Show all' }])}
      </Box>
    ) : null
  return (
    <Box flexDirection="column">
      {heading(el, 'Lists', ctx.bodyColumns, plural(body.lists.length, 'list'))}
      {list(el, pickerSpec(body, plan.pickerRows), ctx)}
      {hidden}
      {heading(el, 'Tasks', ctx.bodyColumns)}
    </Box>
  )
}

/** The filters, a strip with the shown one primary, and the sort: a short Select, or `Sort by` and Buttons where no Select is drawn. */
function controlsPart(el: PaneElements, body: TasksBody): RenderElement {
  const { Box, Text } = el
  const sort =
    'Select' in el ? (
      choice(el, 'tasks:sort', 'Sort by', body.sort, SORTS.map(s => ({ value: s, label: SORT_LABEL[s] })))
    ) : (
      <Box flexDirection="row" columnGap={1}>
        <Text color={STYLE.muted}>Sort by</Text>
        {/* The filter's is the view's primary: the shown sort is marked, not primary. */}
        {actions(el, SORTS.map(s => ({ key: `tasks:sort:${s}`, label: `${s === body.sort ? '› ' : ''}${SORT_LABEL[s]}` })))}
      </Box>
    )
  return (
    <Box flexDirection="column">
      {actions(el, FILTERS.map(f => ({ key: `tasks:filter:${f}`, label: filterLabel(body, f), primary: body.filter === f })))}
      {sort}
    </Box>
  )
}

/** A short Select where the surface draws one (its value among its options), else `Label: value` as text. */
function choice(el: PaneElements, key: string, label: string, value: string, options: readonly SwarmOption[]): RenderElement {
  const { Text } = el
  const all = options.some(o => o.value === value) ? options : [{ value, label: value }, ...options]
  if ('Select' in el) {
    const { Select } = el
    return <Select key={key} label={label} options={all} value={value} onSelect={noop} />
  }
  return <Text wrap="truncate-end">{`${label}: ${all.find(o => o.value === value)?.label ?? value}`}</Text>
}

/** The changed-on-disk line, with [Reload] beside it (the chrome's banner has a fixed [Dismiss]). */
function reloadBanner(el: PaneElements, text: string, key: string): RenderElement {
  const { Box } = el
  return (
    <Box flexDirection="row" columnGap={1}>
      {notice(el, 'warning', text)}
      {action(el, { key, label: 'Reload' })}
    </Box>
  )
}

/**
 * The selected task's editor under its heading (its links the note):
 * Subject and Description as framed fields, each captioned with how it
 * saves (the Description's with what ⏎ marks too); the description's own
 * lines when it has several or its field cuts it; Status and Owner short Selects; the
 * changed-on-disk banner with [Reload]; [Save], primary while there's an
 * edit to save, and [Revert].
 */
function editorPart(el: PaneElements, listKey: string, ed: TasksEditor, ctx: BodyContext): RenderElement {
  const { Box, Text } = el
  const k = (a: string): string => `tasks:${a}:${listKey}/${ed.id}`
  const how = ed.via === 'tool' ? 'saves through TaskUpdate' : 'saves by a direct write: no hooks run, no assignment message'
  const cols = ctx.bodyColumns
  const at = { surface: ctx.surface, isFocused: ctx.isFocused, focused: ctx.focused, columns: cols }
  const lines = descriptionLines(ed, ctx)
  const tooLong = (what: string): RenderElement => (
    <Text color={STYLE.warning} wrap="truncate-end">
      {`${NOTICE_STYLE.warning.glyph} the ${what} is too long to edit here`}
    </Text>
  )
  return (
    <Box flexDirection="column">
      {heading(el, `Task #${ed.id}`, cols, ed.links !== '' ? ed.links : null)}
      {ed.subject !== null ? field(el, { key: k('subject'), label: 'Subject', value: ed.subject, submitLabel: 'keep' }, how, at) : tooLong('subject')}
      {ed.description !== null
        ? field(el, { key: k('description'), label: 'Description', value: ed.description, placeholder: 'none', submitLabel: 'keep' }, `${LINE_MARK} marks a line break · ${how}`, at)
        : tooLong('description')}
      {lines !== null ? (
        <Box height={Math.min(DESCRIPTION_TEXT_ROWS, textRows(lines, cols))} overflow="hidden">
          <Text color={STYLE.muted} wrap="wrap">
            {lines}
          </Text>
        </Box>
      ) : null}
      {choice(el, k('status'), 'Status', ed.status, ed.statuses)}
      {choice(el, k('owner'), 'Owner', ed.owner, ed.owners)}
      {ed.changed ? reloadBanner(el, changedText(ed), k('reload')) : null}
      {actions(el, [
        { key: k('save'), label: 'Save', primary: ed.dirty && !ed.changed },
        { key: k('revert'), label: 'Revert' },
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

type Target = { listKey: string; id: string; task: TasksShown['tasks'][number] }

/** A row's or the editor's `<list folder>/<id>`, checked against what the last build drew; null (said, unless quiet) when it's stale. */
function target(p: Ports, arg: string, quiet = false): Target | null {
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

/**
 * An edit written: only the fields that differ from the file as it began,
 * and only if the file hasn't moved since. [Save] (`mark` null) and the
 * menu's marks (`mark`: the words for the notice) both come here, so a
 * mark is written as the editor would write it.
 */
async function writeEdit(p: Ports, t: Target, s: TasksShown, held: TasksEdit, mark: string | null): Promise<void> {
  const now = await p.fs.stat(t.task.path).catch(() => null)
  if (!now) return say('error', `#${t.id} isn't there any more, so nothing was saved`)
  if (now.mtimeMs !== held.base.mtimeMs) {
    return say(
      'warning',
      mark === null
        ? `#${t.id} changed on disk since you began editing, so nothing was saved: [Reload] takes the file's version (and drops yours)`
        : `#${t.id} changed on disk since it was drawn, so it wasn't marked: it's shown as it is now`,
    )
  }
  const patch: TaskPatch = {}
  if (held.subject !== held.base.subject) patch.subject = held.subject
  if (held.description !== held.base.description) patch.description = held.description
  if (held.status !== held.base.status) patch.status = held.status as TaskPatch['status']
  if (held.owner !== held.base.owner) patch.owner = held.owner
  p.log(`tasks pane: updateTask ${s.list.name} #${t.id} (${Object.keys(patch).join(', ')})`)
  const r = await deps.updateTask(p, s.list, t.id, patch)
  if (!r.ok) return say('error', `#${t.id} wasn't ${mark === null ? 'saved' : 'marked'}: ${r.error}`)
  const n = tasksNavOf()!
  const edits = { ...n.edits }
  delete edits[editKey(t.listKey, t.id)]
  const how =
    mark === null
      ? r.via === 'tool'
        ? `#${t.id} saved through TaskUpdate`
        : `#${t.id} written directly: no hooks ran${'owner' in patch ? ', and no assignment message was sent' : ''}`
      : r.via === 'tool'
        ? `${mark} through TaskUpdate`
        : `${mark}, written directly: no hooks ran`
  setTasksNav({ ...n, edits, notice: { level: 'ok', text: how } })
}

/** [Save]: the edit held for the task, if it differs from the file. */
async function save(p: Ports, arg: string): Promise<void> {
  const t = target(p, arg)
  const s = shownOf()
  if (!t || !s) return
  const held = tasksNavOf()!.edits[editKey(t.listKey, t.id)]
  if (!held || !dirtyOf(held)) return say('info', `nothing to save: #${t.id} is as its file has it`)
  await writeEdit(p, t, s, held, null)
}

/** The menu's Mark in progress and Mark completed: the status alone, written as [Save] writes it; refused while an edit of it waits. */
async function mark(p: Ports, arg: string, status: 'in_progress' | 'completed'): Promise<void> {
  const t = target(p, arg)
  const s = shownOf()
  if (!t || !s) return
  const held = tasksNavOf()!.edits[editKey(t.listKey, t.id)]
  if (held && dirtyOf(held)) return say('warning', `#${t.id} has an edit you haven't saved, so it wasn't marked: [Save] or [Revert] it first`)
  const word = STATUS[status]!.text
  if (t.task.status === status) return say('info', `#${t.id} is ${word} already`)
  await writeEdit(p, t, s, { ...editFrom(t.task), status }, `#${t.id} marked ${word}`)
}

/** One press (on `surface`, which a footer's page reads): the stale check, the action, then the redraw. */
export async function pressTasks(p: Ports, key: string, surface?: string): Promise<void> {
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
        if ((FILTERS as readonly string[]).includes(k.arg) && k.arg !== n.filter) {
          setTasksNav({ ...n, filter: k.arg as TasksFilter })
          // Another filter's rows start at the top.
          await moveList(p, ROWS_LIST, 0, 0)
        }
        break
      case 'sort':
        if ((SORTS as readonly string[]).includes(k.arg)) setTasksNav({ ...n, sort: k.arg as TasksSort })
        break
      case 'pick':
        await pickList(p, k.arg)
        break
      case 'picker':
        if (k.arg === 'open') setTasksNav({ ...n, picking: true })
        break
      case 'empty':
        if (k.arg === 'show' || k.arg === 'hide') setTasksNav({ ...n, showEmpty: k.arg === 'show' })
        break
      case 'lists':
        await pageList(p, 'picker', k.arg, surface)
        break
      case 'rows':
        await pageList(p, 'rows', k.arg, surface)
        break
      case 'select':
      case 'edit': {
        // A row's press, or its menu's Edit: selected, so the editor opens on it.
        const t = target(p, k.arg)
        if (t) setTasksNav({ ...n, selected: t.id })
        break
      }
      case 'assign': {
        // Assign to…: the editor opens on it, and says where the owner is picked (no port moves the ring onto Owner).
        const t = target(p, k.arg)
        if (t) setTasksNav({ ...n, selected: t.id, notice: { level: 'info', text: `pick #${t.id}'s owner under Owner, then [Save]` } })
        break
      }
      case 'start':
        await mark(p, k.arg, 'in_progress')
        break
      case 'complete':
        await mark(p, k.arg, 'completed')
        break
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

/** A list picked by name: one the last build offered, else the press is stale. A pick folds a picker [Change] opened; another list's rows start at the top. */
async function pickList(p: Ports, name: string): Promise<void> {
  const s = shownOf()
  const l = s?.lists.find(x => x.name === name)
  const n = tasksNavOf()!
  if (!l) {
    p.toast("that list isn't offered any more, so it was ignored")
    return say('warning', "that list isn't offered any more, so the pick was ignored")
  }
  if (s && l.dir === s.list.dir) {
    if (n.picking) setTasksNav({ ...n, picking: false })
    return
  }
  setTasksNav({ ...n, list: l.mine ? null : l.name, selected: null, picking: false })
  await moveList(p, ROWS_LIST, 0, 0)
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

/** A pick: the sort, or an edit's status or owner. */
async function selectTasks(p: Ports, key: string, value: string): Promise<void> {
  const k = parseKey(key)
  if (!k) return
  await restoreTasksNav(p)
  if (!tasksNavOf()) return
  if (!shownOf()) await drawTasks(p)
  const n = tasksNavOf()!
  switch (k.action) {
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

// ---------------------------------------------------------------------------
// The wheel and the footers

/** A context for a list's page where nothing was noted: unbounded, so the plan's windows are the inline ones. */
const NOMINAL: TasksCtx = { surface: 'desktop', bodyColumns: 100, rows: Number.POSITIVE_INFINITY, placement: 'dock', focused: null, lists: {} }

/** The body and the context the lists were last drawn at on `surface`, else the last view written at NOMINAL. */
function drawnBody(surface: string | undefined): { body: TasksBody; ctx: TasksCtx } | null {
  const noted = surface !== undefined ? rendered.get(surface) : undefined
  if (noted) return noted
  return lastView?.body ? { body: lastView.body, ctx: NOMINAL } : null
}

/** What the wheel or a footer moves: the picker's list or the tasks'. */
export type TasksScrolled = 'picker' | 'rows'

/**
 * The list `which` at `ctx`'s windows, or null with nothing to list. The
 * picker's whatever its form: what reaches here (a tick over it, the ring
 * on it, its footer) was drawn as a list, though NOMINAL's plan folds it.
 */
function specOf(body: TasksBody, ctx: TasksCtx, which: TasksScrolled, plan = tasksPlan(body, ctx)): ListSpec | null {
  if (body.list === null) return null
  if (which === 'picker') return body.lists.length > 0 ? pickerSpec(body, plan.pickerRows) : null
  return body.rows.length > 0 ? rowsSpec(body, plan.rows, ctx) : null
}

/** Moves one list by `by` rows (toward the top when negative) and answers whether it moved; at its edge, or with no list there, it didn't. */
async function moveBy(p: Ports, body: TasksBody, ctx: TasksCtx, which: TasksScrolled, by: number): Promise<boolean> {
  const spec = specOf(body, ctx, which)
  if (!spec) return false
  const place = listPlace(spec, ctx)
  return moveList(p, spec.id, scrolled(place.count, listOffset(spec.id), place.budget, by), place.window.max)
}

/** The rows a page moves: the window less one, so a row stays in sight. */
function pageRows(body: TasksBody, ctx: TasksCtx, which: TasksScrolled): number {
  const plan = tasksPlan(body, ctx)
  return pageOf(which === 'picker' ? plan.pickerRows : plan.rows)
}

/** A footer's [↑ n above] or [↓ n more] on `surface`: its list's window a page that way, as that surface drew it. */
async function pageList(p: Ports, which: TasksScrolled, dir: string, surface: string | undefined): Promise<void> {
  const drawn = drawnBody(surface)
  if (!drawn || (dir !== 'up' && dir !== 'down')) return
  await moveBy(p, drawn.body, drawn.ctx, which, (dir === 'up' ? -1 : 1) * pageRows(drawn.body, drawn.ctx, which))
}

/** Which list a body row is in (tasksTops), or none. Pure. */
export function tasksHit(tops: TasksTops, row: number): TasksScrolled | null {
  const inside = (part: TasksPart | null): boolean => part !== null && row >= part.top && row < part.top + part.height
  if (inside(tops.picker)) return 'picker'
  if (inside(tops.rows)) return 'rows'
  return null
}

/**
 * The wheel (ui.scroll, routed by the hub). A tick over the picker's list or
 * the tasks moves that one, the row it's over told by what the terminal
 * last drew (ui/drawn.ts) and tasksTops; over the rest of the body it passes
 * on. The scroll keys carry no pointer: they move the list the ring is in,
 * else the tasks, a page at most. At an edge the tick passes on.
 */
export const onTasksScroll: PortHook<UiScrollHook> = async (p, e, next) => {
  const d = lastDrawn()
  if (!d || d.shown !== 'tasks' || e.by === 0) return next(e)
  const body = (d.view as TasksPaneView | null)?.body
  if (!body) return next(e)
  let which: TasksScrolled | null
  let by = e.by
  if (e.pointer) {
    const cols = d.ctx.bodyColumns
    if (e.pointer.column < 0 || (Number.isFinite(cols) && e.pointer.column >= cols)) return next(e)
    which = tasksHit(tasksTops(body, d.ctx), d.scrollOffset + e.pointer.row - d.bodyTop)
  } else {
    const ring = d.ctx.focused ?? ''
    which = ring.startsWith('tasks:pick:') || ring.startsWith(`${LISTS_LIST}:`) ? 'picker' : 'rows'
    const page = pageRows(body, d.ctx, which)
    by = Math.sign(e.by) * Math.min(Math.abs(e.by), page)
  }
  if (which === null) return next(e)
  return (await moveBy(p, body, d.ctx, which, by)) ? {} : next(e)
}

/** The pane's ui.message, ui.press, ui.input, ui.select and ui.scroll; anything not keyed `tasks:` passes on. */
export const onTasksUi: PaneUiHandlers = {
  // The tasks list's Client posts to the hub, which presses its keys here (ui/hub.ts, listPost); nothing else posts.
  message: async (p, e, next) => next(e),
  press: async (p, e, next) => {
    if (!parseKey(e.element)) return next(e)
    await pressTasks(p, e.element, e.surface)
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
  // Reached once the hub's tasks section forwards ui.scroll (a hub.ts line, WP-DB's; the report has it).
  scroll: async (p, e, next) => onTasksScroll(p, e, next),
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
  lastView = null
  rendered.clear()
  resetTasksViewForTests()
}
