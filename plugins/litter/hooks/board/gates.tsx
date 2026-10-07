// The board's gate table as a Client surface module (plan section 11): ↑↓
// select a row and Enter shows its detail, posted to the hooks module
// (surface.post, a ui.message there); a click on a row does the same. A
// right-click on a row (or → once the table has the keyboard) opens its menu
// over the table, as the swarm tree's does (COMMON decision 9): ↑↓ and Enter
// pick, and a click outside it or a second right-click closes it (Escape
// never reaches a Client: it returns the focus). It runs on the drawing
// thread and keeps local state only. pane.tsx draws it with
// `module="./gates.tsx"` (relative to that file). Owner: phase 3, package
// AF; the menu, phase 5, package CD.
//
// Phase 5b (WP-DC): its rows read as the chrome's list does (ui/listmenu.tsx):
// `›` in the accent beside the selected gate, which is bold, the lit row
// inverse, a muted line under the rows, and the same menu (ui/menu.ts). The
// hooks lay the rows out at the width they're drawn at (pane.tsx,
// gateLayout: `props.layout`), so this module only draws and posts. It
// links ui/menu.ts and ui/style.ts, which import nothing, as listmenu.tsx does.
//
// Each post is `{ run, action, gate }`, the action `select` or one of the
// row's `actions` (`replay`, `note`, `copy`): pane.tsx ignores one whose run
// isn't the one the board shows, and refuses an action the row hasn't got.

import type { ClientModule, ClientPointerEvent } from 'claude-code'
import type { BoardGateAction, BoardGateCell, BoardGateRow, BoardGatesProps } from '../../types/index'
import { MENU_W, menuHeight, menuHit, menuKey, menuLine, placeMenu, type Menu } from '../ui/menu'
import { SELECTED_MARK, STYLE } from '../ui/style'

type Item = { label: string; action: BoardGateAction | 'close' }
/** The highlighted row, moved by ↑↓ and the pointer, and the open menu; the selection itself is the hooks module's (`props.selected`). */
type State = { hover: number | null; menu: Menu | null }

const IDLE: State = { hover: null, menu: null }

const ITEM_LABEL: Record<BoardGateAction, string> = { replay: 'replay with /litter:amend', note: 'open critic note', copy: 'copy commit' }
const ITEM_ORDER: readonly BoardGateAction[] = ['replay', 'note', 'copy']

/** A row's cells as laid out, else its id, state and title (props from before the layout, or a row it doesn't name). */
function cellsOf(props: BoardGatesProps, r: BoardGateRow, i: number): BoardGateCell[] {
  const all: unknown = props.layout?.cells
  const laid: unknown = Array.isArray(all) ? all[i] : undefined
  if (Array.isArray(laid)) return laid.filter((c): c is BoardGateCell => c !== null && typeof c === 'object' && typeof (c as BoardGateCell).text === 'string')
  return [{ text: `${r.id} ` }, { text: `${r.glyph} ${r.state} `, color: r.color }, { text: r.title }]
}

/** The row's items, each only where it applies (its `actions`), then close; none for a row with no action. */
function itemsFor(r: BoardGateRow): Item[] {
  const actions = Array.isArray(r.actions) ? r.actions : []
  const items: Item[] = ITEM_ORDER.filter(a => actions.includes(a)).map(a => ({ label: ITEM_LABEL[a], action: a }))
  return items.length === 0 ? [] : [...items, { label: 'close', action: 'close' }]
}

const Gates: ClientModule<BoardGatesProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const rows: BoardGateRow[] = Array.isArray(props?.rows) ? props.rows : []

  const current = () => surface.state ?? IDLE
  const put = (next: State) => {
    if (JSON.stringify(next) !== JSON.stringify(current())) surface.setState(next)
  }
  const selectedAt = () => Math.max(0, rows.findIndex(r => r.id === props.selected))
  const rowAt = (y: number) => (y >= 0 && y < rows.length ? y : null)
  const post = (action: 'select' | BoardGateAction, r: BoardGateRow) => surface.post({ run: props.run, action, gate: r.id })
  const menuItems = (m: Menu) => {
    const r = rows[m.row]
    return r === undefined ? [] : itemsFor(r)
  }
  /** The table's own rows: the gates (or "no gates"), then the line under them. */
  const tableRows = Math.max(rows.length, 1) + 1
  /** The menu for a row, kept inside the region (near the bottom row it opens upwards); null for a row with no item. */
  const place = (row: number, x: number, y: number): Menu | null => {
    const r = rows[row]
    return placeMenu(row, r === undefined ? 0 : itemsFor(r).length, x, y, { columns: surface.columns, rows: Math.max(surface.rows, tableRows) })
  }
  const choose = (m: Menu, index: number) => {
    const r = rows[m.row]
    const item = menuItems(m)[index]
    if (r === undefined || item === undefined) return
    put({ hover: m.row, menu: null })
    if (item.action !== 'close') post(item.action, r)
  }

  surface.onPointer((e: ClientPointerEvent) => {
    const cur = current()
    const m = cur.menu
    const hit = m === null ? null : menuHit(m, menuItems(m).length, e.x, e.y)
    if (e.type === 'leave') return put({ ...cur, hover: m === null ? null : cur.hover })
    if (e.type === 'move' && e.button === undefined) {
      if (m === null) return put({ ...cur, hover: rowAt(e.y) })
      if (hit !== null && hit >= 0) put({ ...cur, menu: { ...m, sel: hit } })
      return
    }
    if (e.type !== 'down') return
    // A second right-click closes the menu, wherever it lands.
    if (e.button === 'right' && m !== null) return put({ ...cur, menu: null })
    const i = rowAt(e.y)
    if (e.button === 'right') return i === null ? undefined : put({ hover: i, menu: place(i, e.x, e.y) })
    if (e.button !== 'left') return
    if (m !== null) {
      // A click outside closes it without picking anything.
      if (hit === null) return put({ ...cur, menu: null })
      if (hit >= 0) choose(m, hit)
      return
    }
    if (i === null) return
    put({ hover: i, menu: null })
    const r = rows[i]
    if (r) post('select', r)
  })

  // Reached once a click has focused the table; Escape returns the focus.
  surface.onKey(k => {
    const cur = current()
    const m = cur.menu
    if (m === null) {
      const at = cur.hover ?? selectedAt()
      if (k.key === 'down') return put({ ...cur, hover: Math.min(at + 1, rows.length - 1) })
      if (k.key === 'up') return put({ ...cur, hover: Math.max(at - 1, 0) })
      const r = rows[at]
      if (r === undefined) return
      if (k.key === 'return') return post('select', r)
      if (k.key === 'right' || k.key === 'm') return put({ ...cur, hover: at, menu: place(at, 2, at) })
      return
    }
    const r = menuKey(m, menuItems(m).length, k.key)
    if (r === null) return
    if ('menu' in r) return put({ ...cur, menu: r.menu })
    if ('pick' in r) return choose(m, r.pick)
    return put({ ...cur, menu: null })
  })

  const { hover, menu } = current()
  const lit = menu === null ? hover : menu.row
  const target = menu === null ? undefined : rows[menu.row]
  const items = menu === null ? [] : menuItems(menu)
  const menuBottom = menu === null ? 0 : menu.top + menuHeight(items.length)
  const hint = typeof props.layout?.hint === 'string' ? props.layout.hint : 'right-click a gate for actions'
  return (
    <Box flexDirection="column" minHeight={Math.max(tableRows, menuBottom)}>
      {rows.length === 0 && <Text color={STYLE.muted}>no gates</Text>}
      {rows.map((r, i) => {
        const isSelected = r.id === props.selected
        // The lit row inverse in the text's own color, as the list's is; the selected one bold beside its mark.
        const isLit = i === lit && !isSelected
        return (
          <Box flexDirection="row" columnGap={1}>
            <Text color={STYLE.accent}>{isSelected ? SELECTED_MARK : ' '}</Text>
            <Box flexDirection="row">
              {cellsOf(props, r, i).map(c => (
                <Text color={isLit ? undefined : c.color} bold={isSelected} inverse={isLit} wrap="truncate-end">
                  {c.text}
                </Text>
              ))}
            </Box>
          </Box>
        )
      })}
      <Box paddingLeft={2}>
        <Text color={STYLE.muted} wrap="truncate-end">
          {hint}
        </Text>
      </Box>
      {menu !== null && target !== undefined && (
        <Box position="absolute" top={menu.top} left={menu.left} width={MENU_W} flexDirection="column" borderStyle="round" borderColor={STYLE.accent}>
          <Text color={STYLE.muted}>{menuLine(target.id)}</Text>
          {items.map((it, i) => (
            <Text inverse={i === menu.sel}>{menuLine(it.label)}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

export default Gates
