// The board's gate table as a Client surface module (plan section 11): ↑↓
// select a row and Enter shows its detail, posted to the hooks module
// (surface.post, a ui.message there); a click on a row does the same. A
// right-click on a row (or → once the table has the keyboard) opens its menu
// over the table, as the swarm tree's does (COMMON decision 9): ↑↓ and Enter
// pick, and a click outside it or a second right-click closes it (Escape
// never reaches a Client: it returns the focus). It runs on the drawing
// thread, imports types only, and keeps local state only. pane.tsx draws it
// with `module="./gates.tsx"` (relative to that file). Owner: phase 3,
// package AF; the menu, phase 5, package CD.
//
// Each post is `{ run, action, gate }`, the action `select` or one of the
// row's `actions` (`replay`, `note`, `copy`): pane.tsx ignores one whose run
// isn't the one the board shows, and refuses an action the row hasn't got.

import type { ClientModule, ClientPointerEvent } from 'claude-code'
import type { BoardGateAction, BoardGateRow, BoardGatesProps } from '../../types/index'

/**
 * hooks/ui/style.ts's keys this module paints, written out: a Client module
 * imports types only. tests/unit/colorguard.spec.ts checks each against STYLE.
 */
const COLORS = { accent: 'claude', sha: 'warning', failed: 'error' } as const

type Item = { label: string; action: BoardGateAction | 'close' }
type Menu = { row: number; top: number; left: number; sel: number }
/** The highlighted row, moved by ↑↓ and the pointer, and the open menu; the selection itself is the hooks module's (`props.selected`). */
type State = { hover: number | null; menu: Menu | null }

/** The column header's rows above the first gate. */
const HEADER_ROWS = 1
const IDLE: State = { hover: null, menu: null }
const MENU_W = 30
/** The menu's frame: its top and bottom borders and its title. */
const MENU_CHROME = 3

const DIM_SHORT: Record<string, string> = { plan_adherence: 'PA', tests_green: 'TG', no_regressions: 'NR', rules: 'RU' }
const ITEM_LABEL: Record<BoardGateAction, string> = { replay: 'replay with /litter:amend', note: 'open critic note', copy: 'copy commit' }
const ITEM_ORDER: readonly BoardGateAction[] = ['replay', 'note', 'copy']

const pad = (s: string, n: number) => (s.length >= n ? `${s.slice(0, n - 1)} ` : s.padEnd(n))

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
  const rowAt = (y: number) => {
    const i = y - HEADER_ROWS
    return i >= 0 && i < rows.length ? i : null
  }
  const post = (action: 'select' | BoardGateAction, r: BoardGateRow) => surface.post({ run: props.run, action, gate: r.id })
  const menuItems = (m: Menu) => {
    const r = rows[m.row]
    return r === undefined ? [] : itemsFor(r)
  }
  /** The table's own rows: the header, the gates (or "no gates"), the hint. */
  const tableRows = HEADER_ROWS + Math.max(rows.length, 1) + 1
  /** The menu for a row, kept inside the region: near the bottom row it opens upwards. Null for a row with no item. */
  const place = (row: number, x: number, y: number): Menu | null => {
    const r = rows[row]
    const n = r === undefined ? 0 : itemsFor(r).length
    if (n === 0) return null
    return {
      row,
      top: Math.max(0, Math.min(y, Math.max(surface.rows, tableRows) - (MENU_CHROME + n))),
      left: Math.max(0, Math.min(x + 1, Math.max(0, surface.columns - MENU_W))),
      sel: 0,
    }
  }
  /** Null outside the menu; -1 on its frame or title; else the item under the pointer. */
  const menuHit = (m: Menu, e: ClientPointerEvent) => {
    const height = MENU_CHROME + menuItems(m).length
    if (e.x < m.left || e.x >= m.left + MENU_W || e.y < m.top || e.y >= m.top + height) return null
    const item = e.y - m.top - 2
    return item >= 0 && item < height - MENU_CHROME ? item : -1
  }
  const choose = (m: Menu, index: number) => {
    const r = rows[m.row]
    const item = menuItems(m)[index]
    if (r === undefined || item === undefined) return
    put({ hover: m.row, menu: null })
    if (item.action !== 'close') post(item.action, r)
  }

  surface.onPointer(e => {
    const cur = current()
    const m = cur.menu
    const hit = m === null ? null : menuHit(m, e)
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
      if (k.key === 'right' || k.key === 'm') return put({ ...cur, hover: at, menu: place(at, 8, at + HEADER_ROWS) })
      return
    }
    const n = menuItems(m).length
    if (n === 0) return put({ ...cur, menu: null })
    if (k.key === 'down') return put({ ...cur, menu: { ...m, sel: (m.sel + 1) % n } })
    if (k.key === 'up') return put({ ...cur, menu: { ...m, sel: (m.sel + n - 1) % n } })
    if (k.key === 'return') return choose(m, m.sel)
    if (k.key === 'left' || k.key === 'backspace') return put({ ...cur, menu: null })
  })

  const { hover, menu } = current()
  const lit = menu === null ? hover : menu.row
  const target = menu === null ? undefined : rows[menu.row]
  const items = menu === null ? [] : menuItems(menu)
  const menuBottom = menu === null ? 0 : menu.top + MENU_CHROME + items.length
  return (
    <Box flexDirection="column" minHeight={Math.max(tableRows, menuBottom)}>
      <Text bold>{'  gate  state         try   commit   failing      title'}</Text>
      {rows.length === 0 && <Text dimColor>no gates</Text>}
      {rows.map((r, i) => {
        const isSelected = r.id === props.selected
        const isLit = i === lit
        const tries = r.attempt === 0 ? '·' : `${r.attempt}/${r.maxAttempts}`
        const failing = r.failing.length > 0 ? `✕ ${r.failing.map(d => DIM_SHORT[d] ?? d).join(' ')}` : ''
        return (
          <Box flexDirection="row">
            <Text color={COLORS.accent}>{isSelected ? '› ' : isLit ? '· ' : '  '}</Text>
            <Text bold={isSelected} inverse={isLit && !isSelected}>
              {pad(r.id, 6)}
            </Text>
            <Text color={r.color}>{pad(`${r.glyph} ${r.state}`, 14)}</Text>
            <Text dimColor={r.attempt === 0}>{pad(tries, 6)}</Text>
            <Text color={r.commit ? COLORS.sha : undefined} dimColor={!r.commit}>
              {pad(r.commit ?? '·', 9)}
            </Text>
            <Text color={failing ? COLORS.failed : undefined}>{pad(failing, 13)}</Text>
            <Text dimColor={r.state === 'waiting'} wrap="truncate-end">
              {r.earlier ? `${r.title} (landed in ${r.earlier})` : r.title}
            </Text>
          </Box>
        )
      })}
      <Text dimColor>{'  click a gate, then ↑↓ ⏎ for its detail, right-click or → for its actions · PA plan adherence · TG tests green · NR no regressions · RU rules'}</Text>
      {menu !== null && target !== undefined && (
        <Box position="absolute" top={menu.top} left={menu.left} width={MENU_W} flexDirection="column" borderStyle="round" borderColor="claude">
          <Text dimColor>{` ${target.id}`.slice(0, MENU_W - 2).padEnd(MENU_W - 2)}</Text>
          {items.map((it, i) => (
            <Text inverse={i === menu.sel}>{` ${it.label}`.slice(0, MENU_W - 2).padEnd(MENU_W - 2)}</Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

export default Gates
