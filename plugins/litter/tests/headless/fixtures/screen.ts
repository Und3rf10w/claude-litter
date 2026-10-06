// Tier 4: the terminal's screen as it stood, rebuilt from drive.exp's
// transcript (tty.txt), for the phase 5 cases (ui-*.sh). The engine draws on
// the alternate screen with cursor moves and rewrites only the cells that
// changed, so a grep of the raw transcript finds a row's words cut up, and
// can't tell a row still drawn from one that's gone. This replays the bytes
// on a small terminal model of drive.exp's size (50 rows by 200 columns, or
// H_ROWS and H_COLS) and prints the screen, one line per row, trailing
// blanks trimmed. Run with bun:
//
//   bun tests/headless/fixtures/screen.ts <tty.txt> [<bytes>]
//       the screen after the transcript's first <bytes> bytes (default: all of it)
//   bun tests/headless/fixtures/screen.ts <tty.txt> <bytes|all> --at <text>
//       prints the 1-based column and row of the first cell of <text> on that
//       screen (the last row holding it), for an SGR mouse report; exits 1
//       when no row holds it
//   ... --at <text> --in <anchor>
//       the same, only right of the column where <anchor> first shows (the
//       topmost row holding it): a docked pane's header, so a click finds
//       the pane's element and not the same words in the transcript
//   ... --raw   cut exactly at <bytes>, not at the last whole frame before it
//
// What it models: printing with autowrap, wide characters as two cells,
// combining marks, C0 controls, cursor moves (CUP, CUU/CUD/CUF/CUB, CHA,
// VPA, CNL/CPL, HPA/HPR/VPR), erases (ED, EL, ECH), inserts and deletes
// (ICH, DCH, IL, DL), scrolling (DECSTBM, SU, SD, IND, RI, NEL), REP, the
// saved cursor and the alternate screen (1049, 1047, 47). Colors, modes and
// strings (OSC, DCS, APC) change no cell and are skipped. Reads nothing but
// the file it's given.

import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const [file, bytesArg] = args
if (!file) {
  console.error('usage: screen.ts <tty.txt> [<bytes>|all] [--at <text> [--in <anchor>]] [--raw]')
  process.exit(2)
}
const atIx = args.indexOf('--at')
const find = atIx >= 0 ? args[atIx + 1] : undefined
if (atIx >= 0 && !find) {
  console.error('screen.ts: --at needs a text')
  process.exit(2)
}
const inIx = args.indexOf('--in')
const anchor = inIx >= 0 ? args[inIx + 1] : undefined
if (inIx >= 0 && !anchor) {
  console.error('screen.ts: --in needs a text')
  process.exit(2)
}

const ROWS = Number(process.env.H_ROWS ?? 50)
const COLS = Number(process.env.H_COLS ?? 200)

let raw: Buffer
try {
  raw = readFileSync(file)
} catch {
  console.error(`screen.ts: ${file} can't be read`)
  process.exit(2)
}
const cut = bytesArg && !bytesArg.startsWith('--') && bytesArg !== 'all' ? Number(bytesArg) : raw.length
if (!Number.isSafeInteger(cut) || cut < 0) {
  console.error(`screen.ts: ${bytesArg} isn't a byte count`)
  process.exit(2)
}
// A cut inside a character drops that character's start: the decoder replaces it, a cell at most.
const decoded = new TextDecoder('utf-8').decode(raw.subarray(0, Math.min(cut, raw.length)))
// The cut moves back to the last frame's end, unless --raw: a frame half written
// shows rows half drawn. The engine (2.1.289) starts each frame at the home
// position (CSI H) and ends it by parking the cursor on the last row (CSI
// <rows>;1H), then on the prompt (CSI <r>;<c>H).
function frameEnd(s: string): number {
  if (args.includes('--raw')) return s.length
  const start = s.lastIndexOf('\x1b[H')
  let end = -1
  const re = new RegExp(`\\x1b\\[${ROWS};1H(?:\\x1b\\[[0-9]+;[0-9]+H)?`, 'g')
  for (let m = re.exec(s); m !== null; m = re.exec(s)) end = m.index + m[0].length
  const at = Math.max(start, end)
  return at < 0 ? s.length : at
}
const text = decoded.slice(0, frameEnd(decoded))

// ---------------------------------------------------------------------------
// The model

type Grid = string[][]
const blankRow = (): string[] => Array.from({ length: COLS }, () => ' ')
const blankGrid = (): Grid => Array.from({ length: ROWS }, blankRow)

let main = blankGrid()
let alt = blankGrid()
let onAlt = false
let g = main
let r = 0
let c = 0
let top = 0
let bottom = ROWS - 1
let wrapNext = false
let autowrap = true
let saved = { r: 0, c: 0 }
let altSaved = { r: 0, c: 0 }
let last = ' '

const clampR = (n: number) => Math.max(0, Math.min(ROWS - 1, n))
const clampC = (n: number) => Math.max(0, Math.min(COLS - 1, n))
const moveTo = (row: number, col: number) => {
  r = clampR(row)
  c = clampC(col)
  wrapNext = false
}

function scrollUp(n: number, from = top, to = bottom): void {
  for (let i = 0; i < n; i++) {
    g.splice(from, 1)
    g.splice(to, 0, blankRow())
  }
}
function scrollDown(n: number, from = top, to = bottom): void {
  for (let i = 0; i < n; i++) {
    g.splice(to, 1)
    g.splice(from, 0, blankRow())
  }
}
function index(): void {
  if (r === bottom) scrollUp(1)
  else if (r < ROWS - 1) r++
}
function reverseIndex(): void {
  if (r === top) scrollDown(1)
  else if (r > 0) r--
}

/** Terminal cells of one code point: 0 for combining marks and joiners, 2 for wide ones. */
function widthOf(cp: number): number {
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff) return 0
  if ((cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x1ab0 && cp <= 0x1aff) || (cp >= 0x1dc0 && cp <= 0x1dff)) return 0
  if ((cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xfe20 && cp <= 0xfe2f)) return 0
  if (cp >= 0xe0100 && cp <= 0xe01ef) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2
  return 1
}

function put(ch: string): void {
  const w = widthOf(ch.codePointAt(0)!)
  if (w === 0) {
    // A mark joins the cell before it.
    const pc = wrapNext ? c : c - 1
    if (pc >= 0) g[r]![pc] += ch
    return
  }
  if (wrapNext && autowrap) {
    c = 0
    index()
  }
  wrapNext = false
  if (c + w > COLS) {
    if (!autowrap) c = COLS - w
    else {
      c = 0
      index()
    }
  }
  const row = g[r]!
  // Overwriting half of a wide character blanks its other half.
  if (row[c] === '') row[c - 1] = ' '
  if (w === 1 && c + 1 < COLS && row[c + 1] === '') row[c + 1] = ' '
  row[c] = ch
  if (w === 2) row[c + 1] = ''
  last = ch
  c += w
  if (c >= COLS) {
    c = COLS - 1
    wrapNext = true
  }
}

const erase = (row: number, from: number, to: number) => {
  const line = g[row]!
  for (let i = Math.max(0, from); i <= Math.min(COLS - 1, to); i++) line[i] = ' '
}

function setAlt(on: boolean, saveCursor: boolean): void {
  if (on === onAlt) return
  if (on) {
    if (saveCursor) altSaved = { r, c }
    alt = blankGrid()
    g = alt
  } else {
    g = main
    if (saveCursor) moveTo(altSaved.r, altSaved.c)
  }
  onAlt = on
}

function csi(params: string, inter: string, final: string): void {
  const priv = params.startsWith('?')
  const other = /^[<=>]/.test(params)
  const nums = params
    .replace(/^[?<=>]/, '')
    .split(/[;:]/)
    .map(s => (s === '' ? NaN : Number(s)))
  const n = (i: number, d: number) => (Number.isFinite(nums[i]) && nums[i]! > 0 ? nums[i]! : d)
  const z = (i: number) => (Number.isFinite(nums[i]) ? nums[i]! : 0)
  if (other || inter !== '') return
  if (priv) {
    if (final !== 'h' && final !== 'l') return
    const on = final === 'h'
    for (const m of nums) {
      if (m === 1049) setAlt(on, true)
      else if (m === 47 || m === 1047) setAlt(on, false)
      else if (m === 7) autowrap = on
    }
    return
  }
  switch (final) {
    case 'H':
    case 'f':
      moveTo(n(0, 1) - 1, n(1, 1) - 1)
      break
    case 'A':
      moveTo(r - n(0, 1), c)
      break
    case 'B':
    case 'e':
      moveTo(r + n(0, 1), c)
      break
    case 'C':
    case 'a':
      moveTo(r, c + n(0, 1))
      break
    case 'D':
      moveTo(r, c - n(0, 1))
      break
    case 'E':
      moveTo(r + n(0, 1), 0)
      break
    case 'F':
      moveTo(r - n(0, 1), 0)
      break
    case 'G':
    case '`':
      moveTo(r, n(0, 1) - 1)
      break
    case 'd':
      moveTo(n(0, 1) - 1, c)
      break
    case 'J': {
      const m = z(0)
      if (m === 0) {
        erase(r, c, COLS - 1)
        for (let i = r + 1; i < ROWS; i++) erase(i, 0, COLS - 1)
      } else if (m === 1) {
        erase(r, 0, c)
        for (let i = 0; i < r; i++) erase(i, 0, COLS - 1)
      } else for (let i = 0; i < ROWS; i++) erase(i, 0, COLS - 1)
      break
    }
    case 'K': {
      const m = z(0)
      if (m === 0) erase(r, c, COLS - 1)
      else if (m === 1) erase(r, 0, c)
      else erase(r, 0, COLS - 1)
      break
    }
    case 'X':
      erase(r, c, c + n(0, 1) - 1)
      break
    case 'P': {
      const line = g[r]!
      line.splice(c, n(0, 1))
      while (line.length < COLS) line.push(' ')
      break
    }
    case '@': {
      const line = g[r]!
      line.splice(c, 0, ...Array.from({ length: n(0, 1) }, () => ' '))
      line.length = COLS
      break
    }
    case 'L':
      if (r >= top && r <= bottom) scrollDown(n(0, 1), r, bottom)
      break
    case 'M':
      if (r >= top && r <= bottom) scrollUp(n(0, 1), r, bottom)
      break
    case 'S':
      scrollUp(n(0, 1))
      break
    case 'T':
      scrollDown(n(0, 1))
      break
    case 'r': {
      const t = n(0, 1) - 1
      const b = n(1, ROWS) - 1
      if (t < b && b < ROWS) {
        top = t
        bottom = b
      } else {
        top = 0
        bottom = ROWS - 1
      }
      moveTo(0, 0)
      break
    }
    case 's':
      saved = { r, c }
      break
    case 'u':
      moveTo(saved.r, saved.c)
      break
    case 'b':
      for (let i = 0; i < n(0, 1); i++) put(last)
      break
    default:
      break
  }
}

// ---------------------------------------------------------------------------
// The replay

const chars = Array.from(text)
let i = 0
const ST_END = (k: number): number => {
  // A string runs to BEL or ESC \.
  for (let j = k; j < chars.length; j++) {
    if (chars[j] === '\x07') return j + 1
    if (chars[j] === '\x1b' && chars[j + 1] === '\\') return j + 2
  }
  return chars.length
}
while (i < chars.length) {
  const ch = chars[i]!
  if (ch === '\x1b') {
    const nx = chars[i + 1]
    if (nx === undefined) break
    if (nx === '[') {
      let j = i + 2
      let params = ''
      let inter = ''
      while (j < chars.length && /[0-9:;<=>?]/.test(chars[j]!)) params += chars[j++]
      while (j < chars.length && /[ -/]/.test(chars[j]!)) inter += chars[j++]
      const fin = chars[j]
      if (fin === undefined) break
      csi(params, inter, fin)
      i = j + 1
    } else if (nx === ']' || nx === 'P' || nx === '_' || nx === '^' || nx === 'X') {
      i = ST_END(i + 2)
    } else if (nx === '(' || nx === ')' || nx === '*' || nx === '+' || nx === '#' || nx === '%') {
      i += 3
    } else {
      if (nx === '7') saved = { r, c }
      else if (nx === '8') moveTo(saved.r, saved.c)
      else if (nx === 'M') {
        wrapNext = false
        reverseIndex()
      } else if (nx === 'D') {
        wrapNext = false
        index()
      } else if (nx === 'E') {
        moveTo(r, 0)
        index()
      } else if (nx === 'c') {
        main = blankGrid()
        alt = blankGrid()
        g = main
        onAlt = false
        top = 0
        bottom = ROWS - 1
        autowrap = true
        moveTo(0, 0)
      }
      i += 2
    }
    continue
  }
  const cp = ch.codePointAt(0)!
  if (cp < 0x20 || cp === 0x7f) {
    if (ch === '\r') moveTo(r, 0)
    else if (ch === '\n' || ch === '\v' || ch === '\f') {
      wrapNext = false
      index()
    } else if (ch === '\b') moveTo(r, c - 1)
    else if (ch === '\t') moveTo(r, Math.min(COLS - 1, (Math.floor(c / 8) + 1) * 8))
    i++
    continue
  }
  // C1 controls as single code points (rare): skipped.
  if (cp >= 0x80 && cp < 0xa0) {
    i++
    continue
  }
  put(ch)
  i++
}

const lines = g.map(row => row.join('').replace(/\s+$/, ''))
if (find === undefined) {
  process.stdout.write(lines.join('\n') + '\n')
  process.exit(0)
}
/** A row's text, and the cell each of its UTF-16 units is in, so a wide character before a match counts twice. */
function cellsOf(y: number): { s: string; colOf: number[] } {
  const row = g[y]!
  let s = ''
  const colOf: number[] = []
  for (let x = 0; x < COLS; x++) {
    if (row[x] === '') continue
    for (let k = 0; k < row[x]!.length; k++) colOf.push(x)
    s += row[x]
  }
  return { s, colOf }
}
// The anchor's column: the topmost row holding it.
let minCol = 0
if (anchor !== undefined) {
  let found = false
  for (let y = 0; y < ROWS && !found; y++) {
    const { s, colOf } = cellsOf(y)
    const at = s.indexOf(anchor)
    if (at >= 0) {
      minCol = colOf[at]!
      found = true
    }
  }
  if (!found) process.exit(1)
}
// The last row holding the text: a row drawn lower is the newer one (the band sits above the prompt).
for (let y = ROWS - 1; y >= 0; y--) {
  const { s, colOf } = cellsOf(y)
  for (let at = s.indexOf(find); at >= 0; at = s.indexOf(find, at + 1)) {
    if (colOf[at]! < minCol) continue
    console.log(`${colOf[at]! + 1} ${y + 1}`)
    process.exit(0)
  }
}
process.exit(1)
