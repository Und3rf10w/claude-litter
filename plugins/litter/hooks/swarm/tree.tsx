// WP-N: the swarm tree as a Client surface module (15.5): click to select,
// right-click for add child, add worker, duplicate, delete and move, keys
// ↑↓ ⏎ a d x, each pick posted to ui.message (surface.post). builder.tsx
// draws it with `module="./tree.tsx"` (the path is relative to the file the
// <Client> tag is in); it runs on the drawing thread and imports types only.
//
// Each post is `{ swarm, action, row, worker? }`, the action one of panes.ts's
// TREE_ACTIONS; the hooks module edits the draft and draws the tree again.
//
// Contract owner: phase 2b-1, package N.
//
// Phase 5b (WP-DD): its rows read as the chrome's list rows (ui/list.tsx,
// ui/listmenu.tsx): `›` in the accent beside the selected row, which is bold
// in the label color on the one background (SELECTED_BG); the row under the
// pointer (or the keys) inverse; the detail muted. It links ui/style.ts, as
// listmenu.tsx does (that file imports nothing).

import type { ClientModule, ClientPointerEvent } from 'claude-code'
import type { SwarmTreeProps, SwarmTreeRow } from '../../types/index'
import { SELECTED_BG, SELECTED_MARK, STYLE } from '../ui/style'

/** hooks/ui/style.ts's roles this module paints. */
const COLORS = { accent: STYLE.accent, failed: STYLE.failed, muted: STYLE.muted, label: STYLE.label } as const

type Action = 'select' | 'add' | 'attach' | 'duplicate' | 'delete' | 'up' | 'down'
type Item = { label: string; action: Action | 'workers' | 'back' | 'close'; worker?: string; color?: string }
type Menu = { row: number; top: number; left: number; sel: number; workers: boolean }
type State = { hover: number | null; menu: Menu | null }

const MENU_W = 28
/** The menu's frame: its top and bottom borders and its title. */
const MENU_CHROME = 3
const IDLE: State = { hover: null, menu: null }

function itemsFor(r: SwarmTreeRow, workers: readonly string[], sub: boolean): Item[] {
  if (sub) {
    const others = workers.filter(w => w !== r.node)
    return [...others.slice(0, 12).map(w => ({ label: w, action: 'attach' as const, worker: w })), { label: '‹ back', action: 'back' }]
  }
  if (r.kind === 'lead') return [{ label: 'add orchestrator', action: 'add' }, { label: 'close', action: 'close' }]
  const items: Item[] = [{ label: 'add a new worker', action: 'add' }]
  if (workers.some(w => w !== r.node)) items.push({ label: 'add worker ▸', action: 'workers' })
  items.push(
    { label: 'duplicate', action: 'duplicate' },
    { label: 'delete', action: 'delete', color: COLORS.failed },
    { label: 'move up', action: 'up' },
    { label: 'move down', action: 'down' },
    { label: 'close', action: 'close' },
  )
  return items
}

const Tree: ClientModule<SwarmTreeProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const rows = Array.isArray(props?.rows) ? props.rows : []
  const workers = Array.isArray(props?.workers) ? props.workers : []
  const editable = props?.editable === true

  const current = () => surface.state ?? IDLE
  const put = (next: State) => {
    if (JSON.stringify(next) !== JSON.stringify(current())) surface.setState(next)
  }
  const post = (action: Action, row: SwarmTreeRow, worker?: string) =>
    surface.post({ swarm: props.swarm, action, row: row.id, ...(worker === undefined ? {} : { worker }) })
  const rowAt = (y: number) => (y >= 0 && y < rows.length ? y : null)
  const menuItems = (m: Menu) => {
    const r = rows[m.row]
    return r === undefined ? [] : itemsFor(r, workers, m.workers)
  }
  const place = (row: number, x: number, y: number, sub = false): Menu => {
    const r = rows[row]
    const height = MENU_CHROME + (r === undefined ? 0 : itemsFor(r, workers, sub).length)
    return {
      row,
      top: Math.max(0, Math.min(y, Math.max(surface.rows, rows.length) - height)),
      left: Math.max(0, Math.min(x + 1, Math.max(0, surface.columns - MENU_W))),
      sel: 0,
      workers: sub,
    }
  }
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
    if (item.action === 'workers') return put({ hover: m.row, menu: { ...m, workers: true, sel: 0 } })
    if (item.action === 'back') return put({ hover: m.row, menu: { ...m, workers: false, sel: 0 } })
    put({ hover: m.row, menu: null })
    if (item.action !== 'close') post(item.action, r, item.worker)
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
    const row = rowAt(e.y)
    if (e.button === 'right' && hit === null && row !== null && editable) return put({ hover: row, menu: place(row, e.x, e.y) })
    if (e.button !== 'left') return
    if (m !== null) {
      if (hit === null) return put({ ...cur, menu: null })
      if (hit >= 0) choose(m, hit)
      return
    }
    if (row === null) return
    put({ hover: row, menu: null })
    const r = rows[row]
    if (r !== undefined) post('select', r)
  })

  // Reached once a click has focused the tree; Escape returns the focus.
  surface.onKey(k => {
    const cur = current()
    const m = cur.menu
    if (m === null) {
      const at = cur.hover ?? Math.max(0, rows.findIndex(r => r.id === props.selected))
      const r = rows[at]
      if (k.key === 'down') return put({ ...cur, hover: Math.min(at + 1, rows.length - 1) })
      if (k.key === 'up') return put({ ...cur, hover: Math.max(at - 1, 0) })
      if (r === undefined) return
      if (k.key === 'return') return post('select', r)
      if (!editable) return
      if (k.key === 'a') return post('add', r)
      if (k.key === 'd' && r.kind !== 'lead') return post('duplicate', r)
      if (k.key === 'x' && r.kind !== 'lead') return post('delete', r)
      if (k.key === 'right' || k.key === 'm') return put({ ...cur, hover: at, menu: place(at, 8, at) })
      return
    }
    const n = menuItems(m).length
    if (n === 0) return put({ ...cur, menu: null })
    if (k.key === 'down') return put({ ...cur, menu: { ...m, sel: (m.sel + 1) % n } })
    if (k.key === 'up') return put({ ...cur, menu: { ...m, sel: (m.sel + n - 1) % n } })
    if (k.key === 'return') return choose(m, m.sel)
    if (k.key === 'left' || k.key === 'backspace') return put({ ...cur, menu: m.workers ? { ...m, workers: false, sel: 0 } : null })
  })

  const { hover, menu } = current()
  const lit = menu === null ? hover : menu.row
  const target = menu === null ? undefined : rows[menu.row]
  const items = menu === null ? [] : menuItems(menu)
  const menuBottom = menu === null ? 0 : menu.top + MENU_CHROME + items.length

  return (
    <Box flexDirection="column" minHeight={Math.max(rows.length, menuBottom)}>
      {rows.length === 0 && <Text color={COLORS.muted}>no nodes</Text>}
      {rows.map((r, i) => {
        const isSelected = r.id === props.selected
        const isLit = i === lit
        return (
          <Box flexDirection="row">
            <Text color={r.markColor ?? undefined}>{r.mark ? r.mark : ' '}</Text>
            <Text color={COLORS.accent}>{isSelected ? ` ${SELECTED_MARK} ` : '   '}</Text>
            <Text>{'  '.repeat(Math.max(0, r.depth))}</Text>
            {isSelected ? (
              <Text color={COLORS.label} backgroundColor={SELECTED_BG} bold>
                {r.label}
              </Text>
            ) : (
              <Text color={r.color ?? undefined} dimColor={r.dim && !isLit} inverse={isLit}>
                {r.label}
              </Text>
            )}
            {r.detail !== '' && <Text color={COLORS.muted} wrap="truncate-end">{`  ${r.detail}`}</Text>}
          </Box>
        )
      })}
      {menu !== null && target !== undefined && (
        <Box position="absolute" top={menu.top} left={menu.left} width={MENU_W} flexDirection="column" borderStyle="round" borderColor={COLORS.accent}>
          <Text color={COLORS.muted}>{` ${menu.workers ? 'add worker' : target.label}`.slice(0, MENU_W - 2).padEnd(MENU_W - 2)}</Text>
          {items.map((it, i) => (
            <Text color={it.color} inverse={i === menu.sel}>
              {` ${it.label}`.slice(0, MENU_W - 2).padEnd(MENU_W - 2)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

export default Tree
