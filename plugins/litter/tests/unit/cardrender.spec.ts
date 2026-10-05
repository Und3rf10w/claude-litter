// Tier 2: the card's render (hooks/card/render.tsx; WP-CC, COMMON decisions
// 8, 11, 12) with a table of plain constructors in place of the engine's:
// the title, the lines and [Board] in order, at most 6 rows, every Text set
// to truncate, the spans' colors carried as given; and null, so the engine
// draws its own row, with no card, no view, an expanded row, or a task id
// that's only a key of Object's prototype. The render calls the table's
// constructors rather than JSX, which is what lets tier 2 draw it; tier 1
// (tests/card.test.tsx) draws it through the engine.

import { describe, expect, test } from 'bun:test'
import type { CardElements, CardRender } from '../../hooks/hooktypes'
import type { CardView, CardsView } from '../../types/index'
import { CARD_ROWS, renderCard } from '../../hooks/card/render'

type Node = { type: string; props: Record<string, unknown> }

/** A table whose every constructor returns its name and props, as the engine's frozen elements are plain data. */
const table = new Proxy({}, { get: (_t, name) => (props: Record<string, unknown>) => ({ type: String(name), props }) }) as unknown as CardElements

const rowE = (props: Record<string, unknown>) => ({ surface: 'terminal', component: 'UserMessage', requestId: 'msg-1', props }) as unknown as CardRender
const NOTIFICATION = { text: 'Workflow "execute" completed', origin: { kind: 'task-notification' }, isExpanded: false, task: { id: 't-exec', status: 'completed' } }

const card = (over: Partial<CardView> = {}): CardView => ({
  taskId: 't-exec',
  run: '20261005-exec',
  title: [
    { text: '⚑ halted', color: 'warning', bold: true },
    { text: ' · litter · execute ' },
    { text: '20261005-exec', color: 'cyan' },
    { text: ' · 14m 2s', dim: true },
  ],
  lines: [
    [{ text: '1/3 gates landed · last land ' }, { text: '1111111', color: 'yellow' }],
    [{ text: 'G2, attempt 2: ' }, { text: 'failed tests_green', color: 'warning' }],
    [{ text: 'plan gap: the plan never says how long to wait', color: 'warning' }],
    [{ text: 'halted: G2: out of attempts', color: 'warning' }],
  ],
  buttons: [{ key: 'card:board:20261005-exec', label: 'Board' }],
  ...over,
})
const view = (c: CardView = card()): CardsView => ({ view: 'cards', v: 1, byTask: { [c.taskId]: c } })

/** Every node of a tree, depth first. */
function nodes(n: unknown): Node[] {
  if (n === null || typeof n !== 'object' || !('type' in n)) return []
  const node = n as Node
  const kids = node.props.children
  return [node, ...(Array.isArray(kids) ? kids : [kids]).flatMap(nodes)]
}
const textOf = (n: Node): string => nodes(n).flatMap(x => (typeof x.props.children === 'string' ? [x.props.children] : [])).join('')

describe('renderCard', () => {
  test('draws the title, the lines and [Board] in a column, each text row one Text of its spans', () => {
    const tree = renderCard(view(), table, rowE(NOTIFICATION)) as unknown as Node
    expect(tree.type).toBe('Box')
    expect(tree.props.flexDirection).toBe('column')
    const rows = tree.props.children as Node[]
    expect(rows.map(r => r.type)).toEqual(['Text', 'Text', 'Text', 'Text', 'Text', 'Box'])
    expect(rows.slice(0, 5).map(textOf)).toEqual([
      '⚑ halted · litter · execute 20261005-exec · 14m 2s',
      '1/3 gates landed · last land 1111111',
      'G2, attempt 2: failed tests_green',
      'plan gap: the plan never says how long to wait',
      'halted: G2: out of attempts',
    ])
    const title = (rows[0]!.props.children as Node[]).map(s => s.props)
    expect(title[0]).toEqual(expect.objectContaining({ color: 'warning', bold: true, children: '⚑ halted' }))
    expect(title[2]).toEqual(expect.objectContaining({ color: 'cyan', children: '20261005-exec' }))
    expect(title[3]).toEqual(expect.objectContaining({ dimColor: true }))
    const sha = (rows[1]!.props.children as Node[])[1]!.props
    expect(sha).toEqual(expect.objectContaining({ color: 'yellow', children: '1111111' }))
    const button = (rows[5]!.props.children as Node[])[0]!
    expect(button.type).toBe('Button')
    expect(button.props).toEqual(expect.objectContaining({ key: 'card:board:20261005-exec', label: 'Board' }))
    expect(typeof button.props.onPress).toBe('function')
  })

  test('every Text is set to truncate, so no row wraps', () => {
    const texts = nodes(renderCard(view(), table, rowE(NOTIFICATION))).filter(n => n.type === 'Text')
    expect(texts.length).toBeGreaterThan(5)
    for (const t of texts) expect(t.props.wrap).toBe('truncate')
  })

  test('at most 6 rows: lines past four are left out with [Board], past five without it', () => {
    const many = Array.from({ length: 9 }, (_, i) => [{ text: `line ${i}` }])
    const withButton = (renderCard(view(card({ lines: many })), table, rowE(NOTIFICATION)) as unknown as Node).props.children as Node[]
    expect(withButton).toHaveLength(CARD_ROWS)
    expect(withButton.slice(1, 5).map(textOf)).toEqual(['line 0', 'line 1', 'line 2', 'line 3'])
    expect(withButton[5]!.type).toBe('Box')
    const noButton = (renderCard(view(card({ lines: many, buttons: [] })), table, rowE(NOTIFICATION)) as unknown as Node).props.children as Node[]
    expect(noButton).toHaveLength(CARD_ROWS)
    expect(noButton.every(r => r.type === 'Text')).toBe(true)
  })

  test("a card with no lines is its title and [Board]", () => {
    const rows = (renderCard(view(card({ lines: [] })), table, rowE(NOTIFICATION)) as unknown as Node).props.children as Node[]
    expect(rows.map(r => r.type)).toEqual(['Text', 'Box'])
  })

  test("null, so the engine draws its own row: no view, no card for the task, an expanded row, no task id, a prototype key", () => {
    expect(renderCard(null, table, rowE(NOTIFICATION))).toBeNull()
    expect(renderCard(view(), table, rowE({ ...NOTIFICATION, task: { id: 't-other' } }))).toBeNull()
    expect(renderCard(view(), table, rowE({ ...NOTIFICATION, isExpanded: true }))).toBeNull()
    expect(renderCard(view(), table, rowE({ ...NOTIFICATION, task: { status: 'completed' } }))).toBeNull()
    expect(renderCard(view(), table, rowE({ ...NOTIFICATION, task: { id: 'constructor' } }))).toBeNull()
    expect(renderCard(view(), table, rowE({ ...NOTIFICATION, task: { id: 'toString' } }))).toBeNull()
  })
})
