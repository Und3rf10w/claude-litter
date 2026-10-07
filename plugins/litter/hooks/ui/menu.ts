// A right-click menu a Client draws over its rows (phase 5b, WP-DA2): the
// gate table's (board/gates.tsx; COMMON decision 9) as plain arithmetic, for
// the list's Client (listmenu.tsx). Where the menu opens, kept inside the
// region (near the bottom it opens upwards); what the pointer is over; what a
// key does while it's open: ↑↓ move, Enter picks, ← or Backspace closes
// (Escape never reaches a Client: it returns the focus).
//
// No color and no element: a Client module links its own files (a module
// may import its own files by relative path), and draws the box itself.

/** The menu's width in cells, its frame's included. */
export const MENU_W = 30
/** Its frame: the top and bottom borders, and its title. */
export const MENU_CHROME = 3

/** An open menu: the row it's for, where it's drawn, and the item highlighted. */
export type Menu = { row: number; top: number; left: number; sel: number }

/**
 * The menu for `row`, of `items` items, opened at the pointer's cell (x, y)
 * and kept inside a region of `columns` by `rows` cells; null for no item.
 */
export function placeMenu(row: number, items: number, x: number, y: number, region: { columns: number; rows: number }): Menu | null {
  if (items <= 0) return null
  return {
    row,
    top: Math.max(0, Math.min(y, region.rows - (MENU_CHROME + items))),
    left: Math.max(0, Math.min(x + 1, Math.max(0, region.columns - MENU_W))),
    sel: 0,
  }
}

/** The rows a menu of `items` items takes. */
export const menuHeight = (items: number): number => MENU_CHROME + items

/** Null outside the menu; -1 on its frame or title; else the index of the item under the cell. */
export function menuHit(m: Menu, items: number, x: number, y: number): number | null {
  const height = menuHeight(items)
  if (x < m.left || x >= m.left + MENU_W || y < m.top || y >= m.top + height) return null
  const item = y - m.top - 2
  return item >= 0 && item < items ? item : -1
}

/** What a key does with the menu open: a new highlight, a pick, or the menu closed; null for a key it ignores. */
export type MenuMove = { menu: Menu } | { pick: number } | { close: true } | null

export function menuKey(m: Menu, items: number, key: string): MenuMove {
  if (items <= 0) return { close: true }
  if (key === 'down') return { menu: { ...m, sel: (m.sel + 1) % items } }
  if (key === 'up') return { menu: { ...m, sel: (m.sel + items - 1) % items } }
  if (key === 'return') return { pick: m.sel }
  if (key === 'left' || key === 'backspace') return { close: true }
  return null
}

/** One line of the menu's box: a space, the text cut to fit, padded to the box's inside. */
export const menuLine = (text: string): string => ` ${text}`.slice(0, MENU_W - 2).padEnd(MENU_W - 2)
