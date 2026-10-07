// The chrome's list (phase 5b, WP-DA2): a list a section draws in the pane
// itself, in place of an engine Select, which draws its own 7 rows and "… N
// more", takes no wheel and reports no highlighted option. Pure helpers, as
// the rest of the chrome.
//
//  - Rows: one per item, each a keyed Box with the item's plain Button and its
//    columns (planColumns). Only the rows of the list's window are drawn: at
//    most `rows`, then a footer of [↑ n above] [↓ n more] Buttons.
//  - Its own window: an offset the hub keeps by the list's id (ctx.lists),
//    which ui.scroll over the list's rows moves (the section's ui.scroll
//    handler tells a tick over the list from one over the body, listHit). At
//    the window's edge the tick passes on, so the pane scrolls as before.
//  - The focused item's description: the hub keeps the element the pane's
//    ring is on (ctx.focused, from ui.focus: Tab, the arrows, a click). Its
//    row's description is muted, in a column to its right when the body has
//    room (DESCRIPTION_MIN), else on the line under it. Beside, every other
//    row's is faint, and the pointer over a row lifts it to muted (a `hover`
//    style: no hook runs).
//  - A right-click menu where the caller gives an item `actions`: on the
//    terminal and the desktop the rows are a Client (listmenu.tsx, with the
//    gate table's menu as ui/menu.ts has it), whose clicks and menu picks post
//    `{ list, press: <key> }`, which the hub presses on the list's section as
//    a Button's press. Elsewhere the actions are Buttons on the focused row.
//  - Its state (the offset, the ring) is the hub's atom's; the render reads it
//    from ctx (COMMON decision 11).
//
// `h` and `Fragment` are the environment's JSX factory, so no name here takes them.

import type { RenderElement } from 'claude-code'
import type { PaneElements } from '../hooktypes'
import type { ListClientProps, ListClientRow } from '../../types/index'
import { fitCell, planColumns, textRows, type BodyContext, type Cell, type Column } from './chrome'
import { SELECTED_MARK, STYLE } from './style'

const noop = (): void => {}

/** One of an item's actions: a Button keyed `key` on the focused row, or a right-click menu item that presses `key`. */
export type ListAction = { key: string; label: string; color?: string }

/** One row of a list. Text is the caller's, already cleaned and cut. */
export type ListItem = {
  /** The row's Button key: the item's address at ui.press and ui.focus, under its section's prefix. */
  key: string
  label: string
  /** Columns after the label, aligned across the rows. */
  cells?: readonly Cell[]
  /** Shown for the focused row: beside it with room, else under it. */
  description?: string
  /** The item picked or current: `›` beside it. */
  selected?: boolean
  /** Its right-click menu (or, with no Client, Buttons on the focused row). */
  actions?: readonly ListAction[]
}

/** A list as a section draws it. */
export type ListSpec = {
  /** The list's address, under its section's prefix: the hub keeps its window by it, and its footer's keys are `<id>:up` and `<id>:down`. */
  id: string
  items: readonly ListItem[]
  /** Rows the window has for items (the row budget); the footer and the line under a focused row come on top. */
  rows: number
  /** How the item's `cells` drop on a narrow body (planColumns); every cell kept when absent. */
  columns?: readonly Column[]
  /** What stands in for no items. */
  empty?: string | null
}

/** The fewest cells a description column gets beside the rows; with less, it goes under the focused row. */
export const DESCRIPTION_MIN = 24
/** The lines a description under its row takes at most. */
export const DESCRIPTION_LINES = 2

// ---------------------------------------------------------------------------
// The window: pure arithmetic

/** Which items a window of `budget` rows shows from `offset`: [start, end), how many are above and below, and the offset clamped. */
export type ListWindow = { start: number; end: number; above: number; below: number; offset: number; max: number }

export function listWindow(count: number, offset: number, budget: number): ListWindow {
  const n = Math.max(0, Math.floor(count))
  const b = Math.max(1, Math.floor(Number.isFinite(budget) ? budget : n || 1))
  const max = Math.max(0, n - b)
  const start = Math.min(max, Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0)))
  const end = Math.min(n, start + b)
  return { start, end, above: start, below: n - end, offset: start, max }
}

/** The offset after a move of `by` rows (a wheel tick's sign and size), clamped; equal to the window's offset when it can't move that way. */
export function scrolled(count: number, offset: number, budget: number, by: number): number {
  const w = listWindow(count, offset, budget)
  return listWindow(count, w.offset + Math.trunc(by), budget).offset
}

/** A page for the footer's Buttons: the window less one row, so a row stays in sight. */
export const pageOf = (budget: number): number => Math.max(1, Math.floor(budget) - 1)

// ---------------------------------------------------------------------------
// The layout: what a drawing takes, for the render and the hit test alike

/** How a list is drawn at `ctx`: its window, which item is focused, where the description goes, and the rows it all takes. */
export type ListPlace = {
  id: string
  count: number
  budget: number
  window: ListWindow
  /** The focused item's index in `items`, or -1. */
  focused: number
  /** The description sits in a column beside the rows. */
  beside: boolean
  /** Columns kept and their widths, the label first. */
  planned: { shown: number[]; widths: number[] }
  /** The rows the drawing takes: the window's, the lines under a focused row, the footer (or the empty line). */
  height: number
  /** The rows are a Client (the terminal and the desktop, with actions to offer). */
  client: boolean
}

/** The label and its cells, as planColumns plans them. */
const rowCells = (item: ListItem): Cell[] => [{ text: item.label }, ...(item.cells ?? [])]

/** Whether the rows are the Client: a surface that draws one, with a menu to offer. */
export const listClient = (spec: ListSpec, surface: string): boolean => (surface === 'terminal' || surface === 'desktop') && spec.items.some(i => (i.actions?.length ?? 0) > 0)

/** The cells across the mark, the planned columns and their gaps. */
const usedBy = (planned: { shown: number[]; widths: number[] }): number => 1 + planned.shown.reduce((n, i) => n + 1 + planned.widths[i]!, 0)

export function listPlace(spec: ListSpec, ctx: Pick<BodyContext, 'bodyColumns' | 'surface' | 'focused' | 'lists'>): ListPlace {
  const count = spec.items.length
  const budget = Math.max(1, Math.floor(spec.rows))
  const window = listWindow(count, ctx.lists?.[spec.id] ?? 0, budget)
  const columns: Column[] = [{ drop: 0, fill: true }, ...(spec.columns ?? (spec.items[0]?.cells ?? []).map((_, i) => ({ drop: i + 1 })))]
  const shownItems = spec.items.slice(window.start, window.end)
  // The mark's cell and its gap come off the width first.
  const planned = planColumns(columns, shownItems.map(rowCells), Number.isFinite(ctx.bodyColumns) ? ctx.bodyColumns - 2 : ctx.bodyColumns)
  const room = Number.isFinite(ctx.bodyColumns) ? ctx.bodyColumns - usedBy(planned) - 1 : Number.POSITIVE_INFINITY
  const beside = room >= DESCRIPTION_MIN
  const focused = ctx.focused ? spec.items.findIndex(i => i.key === ctx.focused) : -1
  const client = listClient(spec, ctx.surface)
  const inWindow = focused >= window.start && focused < window.end
  const under = !client && !beside && inWindow ? underRows(spec.items[focused]!, ctx.bodyColumns) : 0
  // The Client keeps a status line under its rows (the counts, the hint, a narrow row's description).
  const footer = client || window.above > 0 || window.below > 0 ? 1 : 0
  const height = count === 0 ? 1 : window.end - window.start + under + footer
  return { id: spec.id, count, budget, window, focused, beside, planned, height, client }
}

/** The lines a focused row's description takes under it, indented past the mark: none for none. */
function underRows(item: ListItem, columns: number): number {
  if (!item.description) return 0
  return Math.min(DESCRIPTION_LINES, textRows(item.description, Number.isFinite(columns) ? columns - 2 : columns))
}

/**
 * Whether a pointer is over the list's rows: `top` is the list's first row in
 * the pane's tree, `row` the pointer's tree row (the window's offset, as the
 * render last read it, plus `pointer.row`), `column` its column. Pure.
 */
export function listHit(place: ListPlace, top: number, row: number, column: number, bodyColumns: number): boolean {
  if (place.count === 0) return false
  if (column < 0 || (Number.isFinite(bodyColumns) && column >= bodyColumns)) return false
  return row >= top && row < top + place.height
}

// ---------------------------------------------------------------------------
// The drawing

/** The list: its window of rows and its footer (or the Client, listClient). Pure. */
export function list(el: PaneElements, spec: ListSpec, ctx: BodyContext): RenderElement {
  const { Box, Text } = el
  const place = listPlace(spec, ctx)
  if (place.count === 0) {
    return (
      <Text color={STYLE.muted} wrap="truncate-end">
        {spec.empty ?? 'nothing to list'}
      </Text>
    )
  }
  if (place.client && 'Client' in el) return clientList(el, spec, place, ctx)
  const shown = spec.items.slice(place.window.start, place.window.end)
  return (
    <Box flexDirection="column">
      {shown.map((item, i) => itemRow(el, spec, place, item, place.window.start + i, ctx))}
      {footer(el, spec, place)}
    </Box>
  )
}

function itemRow(el: PaneElements, spec: ListSpec, place: ListPlace, item: ListItem, index: number, ctx: BodyContext): RenderElement {
  const { Box, Button, Text } = el
  const focused = index === place.focused
  const { shown, widths } = place.planned
  const last = shown[shown.length - 1]
  const all = rowCells(item)
  const cellText = (i: number) => (i === last && !(place.beside && item.description) ? fitCell(all[i]?.text ?? '', widths[i]!).trimEnd() : fitCell(all[i]?.text ?? '', widths[i]!))
  const actions = focused && !place.client ? (item.actions ?? []) : []
  const row = (
    <Box key={`${spec.id}#${item.key}`} flexDirection="row" columnGap={1}>
      <Text color={STYLE.accent}>{item.selected ? SELECTED_MARK : ' '}</Text>
      <Button key={item.key} label={cellText(0)} plain onPress={noop} />
      {shown
        .filter(i => i > 0)
        .map(i => {
          const c = all[i] ?? { text: '' }
          return (
            <Text color={c.color ?? (c.dim ? STYLE.muted : undefined)} bold={c.bold} wrap="truncate-end">
              {cellText(i)}
            </Text>
          )
        })}
      {actions.map(a => (
        <Button key={a.key} label={a.label} dimColor onPress={noop} />
      ))}
      {place.beside && item.description ? (
        // No width of its own, so only the description is cut when the row runs over: the mark, the label and the cells keep theirs.
        <Box flexGrow={1} width={0} height={1} overflow="hidden">
          <Text color={focused ? STYLE.muted : STYLE.faint} hover={{ color: STYLE.muted }} wrap="truncate-end">
            {item.description}
          </Text>
        </Box>
      ) : null}
    </Box>
  )
  if (!focused || place.beside || !item.description) return row
  return (
    <Box flexDirection="column">
      {row}
      <Box paddingLeft={2} height={underRows(item, ctx.bodyColumns)} overflow="hidden">
        <Text color={STYLE.muted} wrap="wrap">
          {item.description}
        </Text>
      </Box>
    </Box>
  )
}

/** [↑ n above] [↓ n more]: plain Buttons that move the window a page; none when every item shows. */
function footer(el: PaneElements, spec: ListSpec, place: ListPlace): RenderElement | null {
  const { Box, Button } = el
  const w = place.window
  if (w.above === 0 && w.below === 0) return null
  return (
    <Box flexDirection="row" columnGap={2} paddingLeft={2}>
      {w.above > 0 ? <Button key={`${spec.id}:up`} label={`↑ ${w.above} above`} plain dimColor onPress={noop} /> : null}
      {w.below > 0 ? <Button key={`${spec.id}:down`} label={`↓ ${w.below} more`} plain dimColor onPress={noop} /> : null}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// The Client form (the terminal and the desktop, with a menu)

/** The Client's props: the window's rows as plain data, laid out here, so the module only draws and posts. */
export function clientProps(spec: ListSpec, place: ListPlace, ctx: BodyContext): ListClientProps {
  const { shown, widths } = place.planned
  const rows: ListClientRow[] = spec.items.slice(place.window.start, place.window.end).map(item => {
    const all = rowCells(item)
    return {
      key: item.key,
      text: shown.map(i => fitCell(all[i]?.text ?? '', widths[i]!)).join(' '),
      description: item.description ?? '',
      selected: item.selected === true,
      actions: (item.actions ?? []).map(a => ({ key: a.key, label: a.label, ...(a.color ? { color: a.color } : {}) })),
    }
  })
  return {
    list: spec.id,
    rows,
    above: place.window.above,
    below: place.window.below,
    offset: place.window.offset,
    max: place.window.max,
    beside: place.beside,
    focused: ctx.focused ?? null,
    width: Number.isFinite(ctx.bodyColumns) ? Math.floor(ctx.bodyColumns) : 0,
  }
}

function clientList(el: PaneElements, spec: ListSpec, place: ListPlace, ctx: BodyContext): RenderElement {
  const { Text } = el
  if (!('Client' in el)) return <Text color={STYLE.muted}>{spec.empty ?? 'nothing to list'}</Text>
  const { Client } = el
  // No height: the region is as tall as the module draws, so an open menu has room below the last row (as the gate table's).
  return <Client key={spec.id} module="./listmenu.tsx" props={clientProps(spec, place, ctx)} width="100%" />
}
