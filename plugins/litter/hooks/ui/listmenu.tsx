// An in-pane list's rows as a Client surface module (phase 5b, WP-DA2), on
// the terminal and the desktop, for a list whose items have a right-click
// menu (ui/list.tsx draws it with `module="./listmenu.tsx"`). The pointer
// lights a row and lifts its description from faint to muted; a click
// presses the row; a right-click (or →, once a click gave it the keyboard)
// opens the row's menu over the rows, the gate table's (board/gates.tsx,
// through ui/menu.ts): ↑↓ and Enter pick, a click outside or a second
// right-click closes it. ↑↓ past the window's edge move the list's window.
//
// Each post goes to the hooks module's ui.message, `e.element` the list's id
// (the Client's key), which the hub (ui/hub.ts, listPost) checks:
// `{ list, press }` presses the row's key or the action's on the list's
// section, as its Button would; `{ list, offset, max }` moves the window.
//
// It runs on the drawing thread and keeps local state only: the lit row and
// the open menu. It links its own files (ui/menu.ts, ui/style.ts), which
// import nothing.

import type { ClientModule, ClientPointerEvent } from 'claude-code'
import type { ListClientProps, ListClientRow } from '../../types/index'
import { MENU_W, menuHeight, menuHit, menuKey, menuLine, placeMenu, type Menu } from './menu'
import { SELECTED_MARK, STYLE } from './style'

type Item = { key: string | null; label: string; color?: string }
/** The lit row (the pointer's, or the keys' once a click gave the Client the keyboard) and the open menu. */
type State = { lit: number | null; menu: Menu | null }

const IDLE: State = { lit: null, menu: null }

/** The row's menu: its actions, then close; none for a row with no action. */
function itemsFor(r: ListClientRow | undefined): Item[] {
  const actions = Array.isArray(r?.actions) ? r.actions : []
  if (actions.length === 0) return []
  return [...actions.map(a => ({ key: a.key, label: a.label, ...(a.color ? { color: a.color } : {}) })), { key: null, label: 'close' }]
}

const ListMenu: ClientModule<ListClientProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const rows: ListClientRow[] = Array.isArray(props?.rows) ? props.rows : []
  const list = typeof props?.list === 'string' ? props.list : ''

  const current = () => surface.state ?? IDLE
  const put = (next: State) => {
    if (JSON.stringify(next) !== JSON.stringify(current())) surface.setState(next)
  }
  const rowAt = (y: number) => (y >= 0 && y < rows.length ? y : null)
  const press = (key: string) => surface.post({ list, press: key })
  const move = (offset: number) => surface.post({ list, offset, max: props.max })
  /** The region the menu stays inside: the rows and the status line, at least. */
  const region = () => ({ columns: surface.columns, rows: Math.max(surface.rows, rows.length + 1) })
  const choose = (m: Menu, index: number) => {
    const item = itemsFor(rows[m.row])[index]
    if (item === undefined) return
    put({ lit: m.row, menu: null })
    if (item.key !== null) press(item.key)
  }

  surface.onPointer((e: ClientPointerEvent) => {
    const cur = current()
    const m = cur.menu
    const hit = m === null ? null : menuHit(m, itemsFor(rows[m.row]).length, e.x, e.y)
    if (e.type === 'leave') return put({ ...cur, lit: m === null ? null : cur.lit })
    if (e.type === 'move' && e.button === undefined) {
      if (m === null) return put({ ...cur, lit: rowAt(e.y) })
      if (hit !== null && hit >= 0) put({ ...cur, menu: { ...m, sel: hit } })
      return
    }
    if (e.type !== 'down') return
    // A second right-click closes the menu, wherever it lands.
    if (e.button === 'right' && m !== null) return put({ ...cur, menu: null })
    const i = rowAt(e.y)
    if (e.button === 'right') return i === null ? undefined : put({ lit: i, menu: placeMenu(i, itemsFor(rows[i]).length, e.x, e.y, region()) })
    if (e.button !== 'left') return
    if (m !== null) {
      // A click outside closes it without picking anything.
      if (hit === null) return put({ ...cur, menu: null })
      if (hit >= 0) choose(m, hit)
      return
    }
    if (i === null) return
    put({ lit: i, menu: null })
    press(rows[i]!.key)
  })

  // Reached once a click has focused the rows; Escape returns the focus.
  surface.onKey(k => {
    const cur = current()
    const m = cur.menu
    if (m !== null) {
      const r = menuKey(m, itemsFor(rows[m.row]).length, k.key)
      if (r === null) return
      if ('menu' in r) return put({ ...cur, menu: r.menu })
      if ('pick' in r) return choose(m, r.pick)
      return put({ ...cur, menu: null })
    }
    if (rows.length === 0) return
    const at = cur.lit ?? Math.max(0, rows.findIndex(r => r.selected))
    if (k.key === 'down') {
      if (at < rows.length - 1) return put({ ...cur, lit: at + 1 })
      if (props.below > 0) move(props.offset + 1)
      return
    }
    if (k.key === 'up') {
      if (at > 0) return put({ ...cur, lit: at - 1 })
      if (props.above > 0) move(props.offset - 1)
      return
    }
    const r = rows[at]
    if (r === undefined) return
    if (k.key === 'return') return press(r.key)
    if (k.key === 'right' || k.key === 'm') return put({ ...cur, lit: at, menu: placeMenu(at, itemsFor(r).length, 2, at, region()) })
  })

  const { lit, menu } = current()
  const shown = menu === null ? lit : menu.row
  const target = menu === null ? undefined : rows[menu.row]
  const items = menu === null ? [] : itemsFor(target)
  const litRow = shown === null ? undefined : rows[shown]
  const counts = [props.above > 0 ? `↑ ${props.above} above` : '', props.below > 0 ? `↓ ${props.below} more` : ''].filter(s => s !== '')
  // The status line: a narrow body's lit description, else the counts and the hint.
  const status = !props.beside && litRow && litRow.description !== '' ? litRow.description : [...counts, 'right-click a row for its actions'].join(' · ')
  return (
    <Box flexDirection="column" minHeight={Math.max(rows.length + 1, menu === null ? 0 : menu.top + menuHeight(items.length))}>
      {rows.map((r, i) => (
        <Box flexDirection="row" columnGap={1}>
          <Text color={STYLE.accent}>{r.selected ? SELECTED_MARK : ' '}</Text>
          <Text bold={r.selected} inverse={i === shown && !r.selected}>
            {r.text}
          </Text>
          {props.beside && r.description !== '' ? (
            <Text color={i === shown || r.key === props.focused ? STYLE.muted : STYLE.faint} wrap="truncate-end">
              {r.description}
            </Text>
          ) : null}
        </Box>
      ))}
      <Box paddingLeft={2}>
        <Text color={STYLE.muted} wrap="truncate-end">
          {status}
        </Text>
      </Box>
      {menu !== null && target !== undefined && (
        <Box position="absolute" top={menu.top} left={menu.left} width={MENU_W} flexDirection="column" borderStyle="round" borderColor={STYLE.accent}>
          <Text color={STYLE.muted}>{menuLine(target.text.trim())}</Text>
          {items.map((it, i) => (
            <Text color={it.color} inverse={i === menu.sel}>
              {menuLine(it.label)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

export default ListMenu
