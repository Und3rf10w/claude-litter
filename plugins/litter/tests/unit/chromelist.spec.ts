// Tier 2 (phase 5b, WP-DA2): the chrome's pure parts. The heading's plan (the
// rule to the body's edge, a short one when narrow, the note dropped first);
// the rows a wrapped text and a wrapping row take; the list's window
// arithmetic, its layout (beside or under, the footer, the Client form) and
// its hit test; the menu's arithmetic, and the list's Client module on a fake
// surface; and the section meta's seam: a section declaring `fits` is clipped
// to `ctx.rows` in the dock, and its keys come before the hub's.

import { describe, expect, test } from 'bun:test'
import type { ClientKeyEvent, ClientPointerEvent } from 'claude-code'
import type { ListClientProps } from '../../types/index'
import { MIN_RULE, headingPlan, spanRows, textRows, type BodyContext, type SectionMeta } from '../../hooks/ui/chrome'
import { DESCRIPTION_MIN, clientProps, listHit, listPlace, listWindow, pageOf, scrolled, type ListItem, type ListSpec } from '../../hooks/ui/list'
import { MENU_CHROME, MENU_W, menuHit, menuKey, menuLine, placeMenu } from '../../hooks/ui/menu'
import { HUB_KEYS, bodyBox, fitsOf, keysLineOf, keysOf, type MetaTable } from '../../hooks/ui/pane'
import ListMenu from '../../hooks/ui/listmenu'

describe('the heading', () => {
  test('wide: the title, a gap and the rule fill the columns; a note sits before the rule\'s last two', () => {
    expect(headingPlan('Sections', 100)).toEqual({ title: 'Sections', rule: 91, note: null })
    // title ␣ rule ␣ note ␣ ──
    expect(headingPlan('Sections', 100, '4 more below the fold')).toEqual({ title: 'Sections', rule: 100 - 8 - 1 - (1 + 21 + 1 + 2), note: '4 more below the fold' })
  })

  test('narrow: the note goes first, then the title is cut, and the rule never goes under its least', () => {
    expect(headingPlan('Sections', 30, '4 more below the fold')).toEqual({ title: 'Sections', rule: 21, note: null })
    expect(headingPlan('Sections', 12)).toEqual({ title: 'Sections', rule: MIN_RULE, note: null })
    expect(headingPlan('Sections', 10)).toEqual({ title: 'Secti…', rule: MIN_RULE, note: null })
    expect(headingPlan('Sections', 1).rule).toBe(MIN_RULE)
  })

  test('with no columns the rule fills by flex', () => {
    expect(headingPlan('Ask the lead', Number.POSITIVE_INFINITY, 'aside')).toEqual({ title: 'Ask the lead', rule: Number.POSITIVE_INFINITY, note: 'aside' })
  })
})

describe('the rows a text takes', () => {
  test('textRows wraps at spaces and breaks a word wider than the row', () => {
    expect(textRows('a b c', 3)).toBe(2)
    expect(textRows('abcdefgh', 3)).toBe(3)
    expect(textRows('one two\nthree', 80)).toBe(2)
    expect(textRows('', 10)).toBe(1)
    expect(textRows('one two', Number.POSITIVE_INFINITY)).toBe(1)
  })

  test('spanRows puts each span whole on a row while it fits', () => {
    expect(spanRows([{ text: 'litter · ' }, { text: 'new swarm' }], 100)).toBe(1)
    expect(spanRows([{ text: 'litter · ' }, { text: 'new swarm' }], 12)).toBe(2)
    expect(spanRows([], 10)).toBe(1)
  })
})

describe("the list's window", () => {
  test('a window of `budget` rows from the offset, clamped to [0, count - budget]', () => {
    expect(listWindow(10, 0, 6)).toEqual({ start: 0, end: 6, above: 0, below: 4, offset: 0, max: 4 })
    expect(listWindow(10, 3, 6)).toEqual({ start: 3, end: 9, above: 3, below: 1, offset: 3, max: 4 })
    expect(listWindow(10, 9, 6)).toEqual({ start: 4, end: 10, above: 4, below: 0, offset: 4, max: 4 })
    expect(listWindow(10, -2, 6).offset).toBe(0)
    expect(listWindow(4, 2, 6)).toEqual({ start: 0, end: 4, above: 0, below: 0, offset: 0, max: 0 })
    expect(listWindow(0, 0, 6)).toEqual({ start: 0, end: 0, above: 0, below: 0, offset: 0, max: 0 })
  })

  test('a move by a tick, clamped; at an edge it stays (so the caller passes the tick on)', () => {
    expect(scrolled(10, 0, 6, 1)).toBe(1)
    expect(scrolled(10, 0, 6, 3)).toBe(3)
    expect(scrolled(10, 3, 6, 5)).toBe(4)
    expect(scrolled(10, 4, 6, 1)).toBe(4)
    expect(scrolled(10, 0, 6, -1)).toBe(0)
    expect(scrolled(10, 2, 6, -1.6)).toBe(1)
  })

  test("the footer's page is the window less one row", () => {
    expect(pageOf(6)).toBe(5)
    expect(pageOf(1)).toBe(1)
  })
})

const item = (n: number, over: Partial<ListItem> = {}): ListItem => ({
  key: `t:row:${n}`,
  label: `template-${n}`,
  cells: [{ text: n % 2 ? 'built-in' : 'this project' }],
  description: `what template ${n} is for, in a sentence of its own`,
  ...over,
})
const SPEC: ListSpec = { id: 't:list', items: Array.from({ length: 8 }, (_, i) => item(i)), rows: 6, columns: [{ drop: 1 }] }
type At = Pick<BodyContext, 'bodyColumns' | 'surface' | 'focused' | 'lists'>
const ctx = (over: Partial<At> = {}): At => ({ bodyColumns: 100, surface: 'terminal', focused: null, lists: {}, ...over })

describe("the list's layout", () => {
  test('wide: the window, the focused row, the description beside, and the footer under the rows', () => {
    const place = listPlace(SPEC, ctx({ focused: 't:row:3', lists: { 't:list': 2 } }))
    expect(place.window).toEqual(listWindow(8, 2, 6))
    expect(place.focused).toBe(3)
    expect(place.beside).toBe(true)
    expect(place.client).toBe(false)
    // Six rows and the footer.
    expect(place.height).toBe(7)
  })

  test('narrow: the description under the focused row, two lines at most, only while it is in the window', () => {
    const narrow = listPlace(SPEC, ctx({ bodyColumns: 40, focused: 't:row:3' }))
    expect(narrow.beside).toBe(false)
    expect(narrow.height).toBe(6 + 2 + 1)
    const out = listPlace(SPEC, ctx({ bodyColumns: 40, focused: 't:row:7' }))
    expect(out.height).toBe(6 + 1)
    // The room beside the rows is what decides it.
    const used = 1 + (1 + 'template-0'.length) + (1 + 'this project'.length)
    expect(listPlace(SPEC, ctx({ bodyColumns: used + 1 + DESCRIPTION_MIN })).beside).toBe(true)
    expect(listPlace(SPEC, ctx({ bodyColumns: used + DESCRIPTION_MIN })).beside).toBe(false)
  })

  test('every item in the window: no footer; none at all: one row for the empty line', () => {
    expect(listPlace({ ...SPEC, items: SPEC.items.slice(0, 4) }, ctx()).height).toBe(4)
    expect(listPlace({ ...SPEC, items: [] }, ctx()).height).toBe(1)
  })

  test('items with actions are the Client on the terminal and the desktop, with its status line; elsewhere the rows', () => {
    const acting = { ...SPEC, items: SPEC.items.map(i => ({ ...i, actions: [{ key: `${i.key}:use`, label: 'use' }] })) }
    expect(listPlace(acting, ctx()).client).toBe(true)
    expect(listPlace(acting, ctx({ surface: 'desktop' })).client).toBe(true)
    expect(listPlace(acting, ctx({ surface: 'vscode' })).client).toBe(false)
    expect(listPlace({ ...acting, items: acting.items.slice(0, 3) }, ctx()).height).toBe(3 + 1)
  })

  test("the hit test: a tree row among the list's rows and a column inside the body", () => {
    const place = listPlace(SPEC, ctx())
    expect(listHit(place, 10, 9, 4, 100)).toBe(false)
    expect(listHit(place, 10, 10, 4, 100)).toBe(true)
    expect(listHit(place, 10, 16, 4, 100)).toBe(true)
    expect(listHit(place, 10, 17, 4, 100)).toBe(false)
    expect(listHit(place, 10, 12, -1, 100)).toBe(false)
    expect(listHit(place, 10, 12, 100, 100)).toBe(false)
    expect(listHit(listPlace({ ...SPEC, items: [] }, ctx()), 10, 10, 4, 100)).toBe(false)
  })
})

describe('the menu', () => {
  test('it opens at the pointer, kept inside the region; near the bottom it opens upwards', () => {
    expect(placeMenu(1, 3, 4, 2, { columns: 100, rows: 12 })).toEqual({ row: 1, top: 2, left: 5, sel: 0 })
    expect(placeMenu(5, 3, 90, 10, { columns: 100, rows: 12 })).toEqual({ row: 5, top: 12 - (MENU_CHROME + 3), left: 100 - MENU_W, sel: 0 })
    expect(placeMenu(0, 0, 4, 2, { columns: 100, rows: 12 })).toBeNull()
  })

  test('a hit: null outside, -1 on the frame or title, else the item', () => {
    const m = { row: 0, top: 2, left: 5, sel: 0 }
    expect(menuHit(m, 2, 4, 3)).toBeNull()
    expect(menuHit(m, 2, 6, 2)).toBe(-1)
    expect(menuHit(m, 2, 6, 3)).toBe(-1)
    expect(menuHit(m, 2, 6, 4)).toBe(0)
    expect(menuHit(m, 2, 6, 5)).toBe(1)
    expect(menuHit(m, 2, 6, 6)).toBe(-1)
    expect(menuHit(m, 2, 6, 7)).toBeNull()
  })

  test('the keys: ↑↓ wrap, Enter picks, ← and Backspace close, the rest are ignored', () => {
    const m = { row: 0, top: 0, left: 0, sel: 0 }
    expect(menuKey(m, 3, 'down')).toEqual({ menu: { ...m, sel: 1 } })
    expect(menuKey(m, 3, 'up')).toEqual({ menu: { ...m, sel: 2 } })
    expect(menuKey({ ...m, sel: 2 }, 3, 'return')).toEqual({ pick: 2 })
    expect(menuKey(m, 3, 'left')).toEqual({ close: true })
    expect(menuKey(m, 3, 'backspace')).toEqual({ close: true })
    expect(menuKey(m, 3, 'x')).toBeNull()
    expect(menuLine('use')).toBe(` use${' '.repeat(MENU_W - 2 - 4)}`)
  })
})

// ---------------------------------------------------------------------------
// The list's Client module (hooks/ui/listmenu.tsx), with a fake surface

type El = { type: unknown; props: Record<string, unknown>; children: unknown[] }

// The environment's JSX factory, which tier 2 doesn't have: elements as plain data.
Object.assign(globalThis, {
  h: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => ({ type, props: props ?? {}, children }),
  Fragment: 'Fragment',
})

const isEl = (v: unknown): v is El => typeof v === 'object' && v !== null && 'type' in v && 'children' in v
const textOf = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : Array.isArray(v) ? v.map(textOf).join('') : isEl(v) ? v.children.map(textOf).join('') : '')
function texts(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(texts)
  if (!isEl(node)) return []
  return node.type === 'Text' ? [textOf(node)] : node.children.flatMap(texts)
}
function find(node: unknown, pred: (e: El) => boolean): El | null {
  if (Array.isArray(node)) {
    for (const c of node) {
      const f = find(c, pred)
      if (f) return f
    }
    return null
  }
  if (!isEl(node)) return null
  return pred(node) ? node : find(node.children, pred)
}

const PROPS: ListClientProps = {
  list: 't:list',
  rows: [
    {
      key: 't:row:0',
      text: 'alpha  built-in',
      spans: [{ text: 'alpha ' }, { text: ' ' }, { text: 'built-in', color: 'inactive' }],
      description: 'the first',
      selected: false,
      actions: [{ key: 't:row:0:use', label: 'use' }, { key: 't:row:0:copy', label: 'copy' }],
    },
    { key: 't:row:1', text: 'beta   yours', spans: [{ text: 'beta  ' }, { text: ' ' }, { text: 'yours', color: 'success', bold: true }], description: 'the second', selected: true, actions: [] },
    // No spans (props from an older draw): its text alone.
    { key: 't:row:2', text: 'gamma  yours', spans: [], description: '', selected: false, actions: [{ key: 't:row:2:use', label: 'use' }] },
  ],
  above: 0,
  below: 2,
  offset: 0,
  max: 2,
  beside: true,
  focused: null,
  width: 80,
}

/** listmenu.tsx drawn on a fake surface: its posts, its listeners, and its tree after each setState. */
function mount(props: ListClientProps, size = { columns: 80, rows: 4 }) {
  let local: unknown
  let pointer: ((e: ClientPointerEvent) => void) | null = null
  let key: ((e: ClientKeyEvent) => void) | null = null
  let tree: unknown = null
  const posts: unknown[] = []
  const surface = {
    elements: { Box: 'Box', Text: 'Text' },
    get state() {
      return local
    },
    setState(next: unknown) {
      local = next
      draw()
    },
    columns: size.columns,
    rows: size.rows,
    every: () => () => {},
    onPointer: (fn: (e: ClientPointerEvent) => void) => {
      pointer = fn
      return () => {}
    },
    onKey: (fn: (e: ClientKeyEvent) => void) => {
      key = fn
      return () => {}
    },
    post: (data: unknown) => void posts.push(data),
  }
  const draw = () => {
    tree = ListMenu(props, surface as never)
  }
  draw()
  const menuBox = () => find(tree, e => e.type === 'Box' && e.props.position === 'absolute')
  return {
    posts,
    pointer: (e: ClientPointerEvent) => pointer!(e),
    key: (k: string) => key!({ key: k }),
    menu: () => {
      const m = menuBox()
      return m ? texts(m).map(t => t.trim()) : null
    },
    texts: () => texts(tree),
    tree: () => tree,
  }
}

describe("the list's Client (listmenu.tsx)", () => {
  test("a click on a row presses it; a right-click opens its menu, with only that row's actions, and a pick presses the action", () => {
    const ui = mount(PROPS)
    ui.pointer({ type: 'down', x: 3, y: 1, button: 'left' })
    expect(ui.posts).toEqual([{ list: 't:list', press: 't:row:1' }])
    ui.pointer({ type: 'down', x: 3, y: 0, button: 'right' })
    expect(ui.menu()).toEqual(['alpha  built-in', 'use', 'copy', 'close'])
    // The second item, a row under the first.
    ui.pointer({ type: 'down', x: 6, y: 0 + 2 + 1, button: 'left' })
    expect(ui.posts.at(-1)).toEqual({ list: 't:list', press: 't:row:0:copy' })
    expect(ui.menu()).toBeNull()
  })

  test('a row with no action opens no menu; a click outside or a second right-click closes one', () => {
    const ui = mount(PROPS)
    ui.pointer({ type: 'down', x: 3, y: 1, button: 'right' })
    expect(ui.menu()).toBeNull()
    ui.pointer({ type: 'down', x: 3, y: 2, button: 'right' })
    expect(ui.menu()).toEqual(['gamma  yours', 'use', 'close'])
    ui.pointer({ type: 'down', x: 3, y: 2, button: 'right' })
    expect(ui.menu()).toBeNull()
    ui.pointer({ type: 'down', x: 3, y: 0, button: 'right' })
    ui.pointer({ type: 'down', x: 79, y: 0, button: 'left' })
    expect(ui.menu()).toBeNull()
    expect(ui.posts).toEqual([])
  })

  test('the keys, once a click gave it them: ↓ lights the next row, past the last moves the window, Enter presses, → opens the menu', () => {
    const ui = mount(PROPS)
    ui.pointer({ type: 'down', x: 3, y: 0, button: 'left' })
    ui.key('down')
    ui.key('down')
    ui.key('down')
    expect(ui.posts).toEqual([{ list: 't:list', press: 't:row:0' }, { list: 't:list', offset: 1, max: 2 }])
    ui.key('return')
    expect(ui.posts.at(-1)).toEqual({ list: 't:list', press: 't:row:2' })
    ui.key('right')
    expect(ui.menu()).toEqual(['gamma  yours', 'use', 'close'])
    ui.key('return')
    expect(ui.posts.at(-1)).toEqual({ list: 't:list', press: 't:row:2:use' })
    ui.key('up')
    ui.key('up')
    ui.key('up')
    // At the window's top with nothing above: no move.
    expect(ui.posts.filter(p => (p as { offset?: number }).offset !== undefined)).toHaveLength(1)
  })

  test("the lit row's description is muted, the others faint; narrow, the lit one's is the status line", () => {
    const ui = mount(PROPS)
    ui.pointer({ type: 'move', x: 3, y: 1 })
    const colorOf = (text: string) => find(ui.tree(), e => e.type === 'Text' && textOf(e) === text)?.props.color
    expect(colorOf('the second')).toBe('inactive')
    expect(colorOf('the first')).toBe('subtle')
    expect(ui.texts().at(-1)).toBe('↓ 2 more · right-click a row for its actions')
    const narrow = mount({ ...PROPS, beside: false })
    narrow.pointer({ type: 'move', x: 3, y: 0 })
    expect(narrow.texts()).not.toContain('the second')
    expect(narrow.texts().at(-1)).toBe('the first')
  })

  // The user's live look (2026-10-07): a swarm's roster drew every cell, its status and role, in one color.
  test('each cell in its own color, the selected row bold; the lit row one inverse bar in the text color; a row with no spans its text', () => {
    const ui = mount(PROPS)
    const cell = (text: string) => find(ui.tree(), e => e.type === 'Text' && textOf(e) === text)?.props
    expect(cell('alpha ')).toEqual(expect.objectContaining({ color: undefined, bold: false, inverse: false }))
    expect(cell('built-in')).toEqual(expect.objectContaining({ color: 'inactive', bold: false, inverse: false }))
    expect(cell('yours')).toEqual(expect.objectContaining({ color: 'success', bold: true, inverse: false }))
    expect(cell('beta  ')).toEqual(expect.objectContaining({ bold: true }))
    expect(cell('gamma  yours')).toEqual(expect.objectContaining({ color: undefined, inverse: false }))
    ui.pointer({ type: 'move', x: 3, y: 0 })
    expect(cell('alpha ')).toEqual(expect.objectContaining({ color: undefined, inverse: true }))
    expect(cell('built-in')).toEqual(expect.objectContaining({ color: undefined, inverse: true }))
    // The selected row isn't inverted when lit: its mark says it.
    ui.pointer({ type: 'move', x: 3, y: 1 })
    expect(cell('yours')).toEqual(expect.objectContaining({ color: 'success', inverse: false }))
  })
})

describe("the list's Client props (list.tsx)", () => {
  test("each row's spans are its shown cells padded to the widths, a plain space between, in each cell's color (muted when dim)", () => {
    const spec: ListSpec = {
      id: 't:list',
      rows: 3,
      items: [
        { key: 'a', label: 'alpha', cells: [{ text: '▸ running', color: 'background' }, { text: 'worker', dim: true }, { text: 'x', bold: true }] },
        { key: 'b', label: 'be', cells: [{ text: '− gone', color: 'inactive' }, { text: 'child', color: 'text' }, { text: '' }] },
      ],
      columns: [{ drop: 0 }, { drop: 1 }, { drop: 2 }],
    }
    const ctx = { bodyColumns: 80, bodyRows: 10, rows: 10, surface: 'terminal', isFocused: false, focused: null, lists: {}, placement: 'dock' } as unknown as BodyContext
    const props = clientProps(spec, listPlace(spec, ctx), ctx)
    const [a, b] = props.rows
    expect(a!.spans.map(s => s.text).join('')).toBe(a!.text)
    expect(b!.spans.map(s => s.text).join('')).toBe(b!.text)
    expect(a!.spans.filter(s => s.text !== ' ')).toEqual([
      { text: 'alpha' },
      { text: '▸ running', color: 'background' },
      { text: 'worker', color: 'inactive' },
      { text: 'x', bold: true },
    ])
    expect(b!.spans.filter(s => s.text.trim() !== '').map(s => [s.text.trim(), s.color])).toEqual([
      ['be', undefined],
      ['− gone', 'inactive'],
      ['child', 'text'],
    ])
  })
})

// ---------------------------------------------------------------------------
// The section meta (WP-DA2, 1): a section that declares it fits

const none: SectionMeta<never> = { fits: false, keys: () => [] }
const TABLE: MetaTable = { runs: { fits: true, keys: () => [{ key: 'g', word: 'gates' }] }, swarms: none, rules: none, tasks: none, agents: none, doctor: none }

describe('the section meta', () => {
  test('a section that fits is clipped to its rows in the dock; inline, or with no row count, it is drawn whole', () => {
    expect(fitsOf('runs', TABLE)).toBe(true)
    expect(fitsOf('rules', TABLE)).toBe(false)
    expect(fitsOf('home', TABLE)).toBe(true)
    expect(bodyBox('runs', 'dock', 14, TABLE)).toEqual({ height: 14, overflow: 'hidden' })
    expect(bodyBox('runs', 'inline', 14, TABLE)).toEqual({})
    expect(bodyBox('runs', 'dock', Number.POSITIVE_INFINITY, TABLE)).toEqual({})
    expect(bodyBox('rules', 'dock', 14, TABLE)).toEqual({})
  })

  test("its keys come first on the keys line, then the hub's", () => {
    expect(keysOf('runs', null, TABLE)).toEqual([{ key: 'g', word: 'gates' }])
    expect(keysLineOf('runs', null, TABLE)).toEqual([{ key: 'g', word: 'gates' }, ...HUB_KEYS])
    expect(keysLineOf('home', null, TABLE)).toEqual([...HUB_KEYS])
  })
})
