// A plain-text drawing of a tree a tier-1 mount drew (WP-DA2): what a test
// reads as rows and cells, and the colors each row paints. It lays the tree
// out the way the terminal's flexbox does for what litter draws (a column of
// rows; a row's items side by side with their gap, growing into free cells by
// flexGrow and shrinking by their width when over; a border and padding
// around; a fixed height clipped), and draws each leaf as the terminal does:
// a Button `[ label ]` (a plain one its label alone, or `1: label` with its
// hotkey in `suggestion`, as 2.1.299's terminal Button draws it), an Input
// `label: ` and its value or placeholder, a Select `label: ` and its option,
// a Client its key. An approximation, not the engine's paint: it reads the
// tree as the mount returns it, so a test can find a row by its text and
// count cells.

type Node = { type: string; key?: string; props?: Record<string, unknown>; children?: unknown[]; hover?: Record<string, unknown> }

/** One run of cells in one style. */
export type Seg = { text: string; color?: string; bold?: boolean; dim?: boolean; inverse?: boolean }
type Line = Seg[]

const isNode = (n: unknown): n is Node => typeof n === 'object' && n !== null && !Array.isArray(n) && typeof (n as Node).type === 'string'
const kids = (n: Node): unknown[] => {
  const c = n.children ?? (n.props?.children as unknown[] | undefined) ?? []
  return (Array.isArray(c) ? c : [c]).flat(Infinity as 1).filter(x => x !== null && x !== undefined && x !== false && x !== true && x !== '')
}
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const widthOf = (l: Line): number => l.reduce((n, s) => n + [...s.text].length, 0)
const pad = (l: Line, w: number): Line => (widthOf(l) >= w ? cut(l, w) : [...l, { text: ' '.repeat(w - widthOf(l)) }])

function cut(l: Line, w: number): Line {
  const out: Line = []
  let left = w
  for (const s of l) {
    if (left <= 0) break
    const cs = [...s.text]
    out.push({ ...s, text: cs.slice(0, left).join('') })
    left -= Math.min(left, cs.length)
  }
  return out
}

/** A Text's runs: its string children in its style, nested Texts in theirs. */
function textSegs(n: Node, inherit: Omit<Seg, 'text'> = {}): Seg[] {
  const p = n.props ?? {}
  const style: Omit<Seg, 'text'> = {
    ...inherit,
    ...(typeof p.color === 'string' ? { color: p.color } : {}),
    ...(p.bold === true ? { bold: true } : {}),
    ...(p.dimColor === true ? { dim: true } : {}),
    ...(p.inverse === true ? { inverse: true } : {}),
  }
  const out: Seg[] = []
  for (const c of kids(n)) {
    if (typeof c === 'string' || typeof c === 'number') out.push({ ...style, text: String(c) })
    else if (isNode(c) && c.type === 'Text') out.push(...textSegs(c, style))
  }
  return out
}

/** A leaf's runs on one row: a Button, an Input, a Select, a Client. */
function leafSegs(n: Node): Seg[] | null {
  const p = n.props ?? {}
  const label = typeof p.label === 'string' ? p.label : ''
  switch (n.type) {
    case 'Button': {
      const style: Omit<Seg, 'text'> = p.variant === 'primary' && p.plain !== true ? { color: 'claude' } : p.dimColor === true ? { dim: true } : {}
      if (p.plain !== true) return [{ ...style, text: `[ ${label} ]` }]
      // Plain: the hotkey in the accent, a colon, the label; without one, the label alone.
      const hotkey = typeof p.hotkey === 'string' ? p.hotkey : ''
      return hotkey === '' ? [{ ...style, text: label }] : [{ ...style, color: 'suggestion', text: hotkey }, { ...style, text: `: ${label}` }]
    }
    case 'Input': {
      const value = typeof p.value === 'string' ? p.value : ''
      const head: Seg[] = typeof p.label === 'string' ? [{ text: `${label}: ` }] : []
      return [...head, value !== '' ? { text: value } : { dim: true, text: typeof p.placeholder === 'string' ? p.placeholder : '' }]
    }
    case 'Select': {
      const options = Array.isArray(p.options) ? (p.options as { value: string; label: string }[]) : []
      const picked = options.find(o => o.value === p.value)
      return [{ text: `${label ? `${label}: ` : ''}${picked?.label ?? ''} ▾` }]
    }
    case 'Client':
      return [{ dim: true, text: `‹Client ${n.key ?? String(p.key ?? '')}›` }]
    default:
      return null
  }
}

/** A Text's rows at `width`: one cut with `…` (the truncate modes), else wrapped at spaces, a word wider than the row broken. */
function textLines(n: Node, width: number): Line[] {
  const segs = textSegs(n)
  const wrap = typeof n.props?.wrap === 'string' ? n.props.wrap : 'wrap'
  const whole = segs.map(s => s.text).join('')
  if (wrap.startsWith('truncate')) {
    if ([...whole].length <= width) return [segs]
    const kept = cut(segs, Math.max(0, width - 1))
    return [[...kept, { ...(segs[segs.length - 1] ?? {}), text: '…' }]]
  }
  // Wrapped: by characters within the runs, breaking at the last space that fits. No room: one empty row.
  if (width <= 0) return [[]]
  const chars: { ch: string; s: Seg }[] = []
  for (const s of segs) for (const ch of s.text) chars.push({ ch, s })
  const rows: { ch: string; s: Seg }[][] = []
  for (const para of split(chars)) {
    let rest = para
    while (rest.length > width && rows.length < 1000) {
      let at = -1
      for (let i = Math.min(width, rest.length - 1); i > 0; i--) if (rest[i]!.ch === ' ') {
        at = i
        break
      }
      if (at <= 0) {
        rows.push(rest.slice(0, width))
        rest = rest.slice(width)
      } else {
        rows.push(rest.slice(0, at))
        rest = rest.slice(at + 1)
      }
    }
    rows.push(rest)
  }
  return rows.map(r => {
    const line: Line = []
    for (const { ch, s } of r) {
      const last = line[line.length - 1]
      if (last && last.color === s.color && last.bold === s.bold && last.dim === s.dim && last.inverse === s.inverse) last.text += ch
      else line.push({ ...s, text: ch })
    }
    return line
  })
}

function split<T extends { ch: string }>(chars: T[]): T[][] {
  const out: T[][] = [[]]
  for (const c of chars) {
    if (c.ch === '\n') out.push([])
    else out[out.length - 1]!.push(c)
  }
  return out
}

/** How wide a node is drawn when nothing presses on it: its longest row. */
function natural(n: unknown): number {
  if (typeof n === 'string' || typeof n === 'number') return [...String(n)].length
  if (!isNode(n) || skipped(n)) return 0
  const p = n.props ?? {}
  if (typeof p.width === 'number') return p.width
  if (n.type === 'Text') return Math.max(0, ...textSegs(n).map(s => s.text).join('').split('\n').map(l => [...l].length))
  const leaf = leafSegs(n)
  if (leaf) return widthOf(leaf)
  const frame = frameOf(p)
  const children = kids(n).filter(c => !isNode(c) || !skipped(c))
  const inner = (p.flexDirection ?? 'row') === 'column' ? Math.max(0, ...children.map(natural)) : children.reduce((w: number, c) => w + natural(c), 0) + num(p.columnGap ?? p.gap) * Math.max(0, children.length - 1)
  return Math.max(num(p.minWidth), inner + frame.x)
}

const skipped = (n: Node): boolean => n.props?.display === 'none' || n.props?.position === 'absolute'

function frameOf(p: Record<string, unknown>): { x: number; left: number; border: boolean } {
  const border = typeof p.borderStyle === 'string'
  const padL = num(p.paddingLeft ?? p.paddingX ?? p.padding)
  const padR = num(p.paddingRight ?? p.paddingX ?? p.padding)
  return { x: padL + padR + (border ? 2 : 0), left: padL, border }
}

/** A node's rows, each `width` cells. */
function lines(n: unknown, width: number): Line[] {
  if (typeof n === 'string' || typeof n === 'number') return [pad([{ text: String(n) }], width)]
  if (!isNode(n) || skipped(n)) return []
  if (n.type === 'Text') return textLines(n, width).map(l => pad(l, width))
  const leaf = leafSegs(n)
  if (leaf) return [pad(leaf, width)]
  return boxLines(n, width)
}

function boxLines(n: Node, width: number): Line[] {
  const p = n.props ?? {}
  const frame = frameOf(p)
  const inner = Math.max(0, width - frame.x)
  const children = kids(n).filter(c => !isNode(c) || !skipped(c))
  let body: Line[]
  if ((p.flexDirection ?? 'row') === 'column') body = children.flatMap(c => [...margin(c, inner), ...lines(c, inner)])
  else if (p.flexWrap === 'wrap') body = wrapRow(children, inner, num(p.columnGap ?? p.gap))
  else body = row(children, inner, num(p.columnGap ?? p.gap), p.justifyContent === 'space-between')
  // Inside the border: the left padding, the content, the right padding.
  const within = Math.max(0, width - (frame.border ? 2 : 0))
  body = body.map(l => pad([{ text: ' '.repeat(frame.left) }, ...pad(l, inner)], within))
  const height = typeof p.height === 'number' ? p.height - (frame.border ? 2 : 0) : null
  if (height !== null) body = body.slice(0, Math.max(0, height))
  while (height !== null && body.length < height) body.push(pad([], within))
  const minHeight = num(p.minHeight)
  while (body.length < minHeight) body.push(pad([], within))
  if (!frame.border) return body
  const color = typeof p.borderColor === 'string' ? p.borderColor : undefined
  const side = (ch: string): Seg => ({ ...(color ? { color } : {}), text: ch })
  return [[side(`╭${'─'.repeat(within)}╮`)], ...body.map(l => [side('│'), ...l, side('│')]), [side(`╰${'─'.repeat(within)}╯`)]]
}

const margin = (c: unknown, width: number): Line[] => (isNode(c) ? Array.from({ length: num(c.props?.marginTop) }, () => pad([], width)) : [])

/** A row's items side by side: each its own width, the free cells to the growers, an overflow taken from each by its width. */
function row(children: unknown[], width: number, gap: number, between: boolean): Line[] {
  if (children.length === 0) return []
  const basis = children.map(c => {
    if (isNode(c) && typeof c.props?.width === 'number') return c.props.width
    return natural(c)
  })
  const grow = children.map(c => (isNode(c) ? num(c.props?.flexGrow) : 0))
  const minW = children.map(c => (isNode(c) ? num(c.props?.minWidth) : 0))
  const gaps = gap * (children.length - 1)
  const free = width - gaps - basis.reduce((a, b) => a + b, 0)
  const w = [...basis]
  if (free > 0 && grow.some(g => g > 0)) {
    const total = grow.reduce((a, b) => a + b, 0)
    let given = 0
    grow.forEach((g, i) => {
      const share = i === grow.lastIndexOf(Math.max(...grow)) ? free - given : Math.floor((free * g) / total)
      if (g > 0) {
        w[i]! += share
        given += share
      }
    })
  }
  // Each item at least its minWidth; then an overflow comes off the Texts and Boxes, by their widths, none under its minWidth.
  for (let i = 0; i < w.length; i++) w[i] = Math.max(minW[i]!, w[i]!)
  const shrinkable = children.map(c => isNode(c) && (c.type === 'Text' || c.type === 'Box'))
  let over = gaps + w.reduce((a, b) => a + b, 0) - width
  while (over > 0) {
    const can = w.map((x, i) => (shrinkable[i] && x > minW[i]! ? i : -1)).filter(i => i >= 0)
    if (can.length === 0) break
    const total = can.reduce((a, i) => a + w[i]!, 0)
    let took = 0
    for (const i of can) {
      const take = Math.min(w[i]! - minW[i]!, over - took, Math.max(1, Math.floor((over * w[i]!) / total)))
      w[i]! -= take
      took += take
      if (took >= over) break
    }
    over -= took
  }
  const drawn = children.map((c, i) => lines(c, w[i]!))
  const height = Math.max(1, ...drawn.map(d => d.length))
  const spare = between && children.length > 1 ? Math.max(0, width - gaps - w.reduce((a, b) => a + b, 0)) : 0
  const out: Line[] = []
  for (let r = 0; r < height; r++) {
    const line: Line = []
    drawn.forEach((d, i) => {
      if (i > 0) line.push({ text: ' '.repeat(gap + (i === drawn.length - 1 ? spare : 0)) })
      line.push(...(d[r] ?? [{ text: ' '.repeat(w[i]!) }]))
    })
    out.push(pad(line, width))
  }
  return out
}

/** A wrapping row: items whole on a row while they fit, the next row after. */
function wrapRow(children: unknown[], width: number, gap: number): Line[] {
  const groups: unknown[][] = [[]]
  let used = 0
  for (const c of children) {
    const w = natural(c)
    const g = groups[groups.length - 1]!
    if (g.length > 0 && used + gap + w > width) {
      groups.push([c])
      used = w
    } else {
      used += (g.length > 0 ? gap : 0) + w
      g.push(c)
    }
  }
  return groups.flatMap(g => row(g, width, gap, false))
}

/** What a run paints, in words: its color (the terminal's own when none), bold, dim, inverse. */
const styleName = (s: Seg): string => [s.color ?? 'default', s.bold ? 'bold' : '', s.dim ? 'dim' : '', s.inverse ? 'inverse' : ''].filter(Boolean).join(' ')

/** The drawing at `width`: each row's text, trailing spaces cut. */
export function drawText(tree: unknown, width: number): string[] {
  return lines(tree, width).map(l => l.map(s => s.text).join('').replace(/\s+$/, ''))
}

/** The drawing with the colors each row paints beside it, in order, a run of spaces skipped. */
export function drawWithColors(tree: unknown, width: number): string[] {
  return lines(tree, width).map(l => {
    const text = l.map(s => s.text).join('').replace(/\s+$/, '')
    const named: string[] = []
    for (const s of l) {
      if (s.text.trim() === '') continue
      const n = styleName(s)
      if (named[named.length - 1] !== n) named.push(n)
    }
    return named.length === 0 ? text : `${text.padEnd(width)}  | ${named.join(', ')}`
  })
}

/** The first node the test picks, outermost first, and the path to it. */
export function findNode(tree: unknown, pick: (n: Node) => boolean): Node | null {
  if (Array.isArray(tree)) {
    for (const c of tree) {
      const f = findNode(c, pick)
      if (f) return f
    }
    return null
  }
  if (!isNode(tree)) return null
  if (pick(tree)) return tree
  return findNode(kids(tree), pick)
}

/** The node's ancestors, nearest last; null when it isn't in the tree. */
export function pathTo(tree: unknown, target: Node, above: Node[] = []): Node[] | null {
  if (Array.isArray(tree)) {
    for (const c of tree) {
      const f = pathTo(c, target, above)
      if (f) return f
    }
    return null
  }
  if (!isNode(tree)) return null
  if (tree === target) return above
  return pathTo(kids(tree), target, [...above, tree])
}

/** The node's key, from its props or its own field. */
export const keyOf = (n: Node): string | undefined => (typeof n.props?.key === 'string' ? n.props.key : n.key)

export type { Node as DrawnNode }
