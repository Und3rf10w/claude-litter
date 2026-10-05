// Tier 2: the board's menu (phase 5, WP-CD; COMMON decision 9). Each action
// through the gate table's post (onBoardUi.message) and through the static
// table's buttons (onBoardUi.press): replay fills `/litter:amend <gate> `
// and never submits, the critic note opens the verdict file as a section,
// copy copies the land's full commit id; and each refusal: a run still going,
// a row without the action, a short or malformed commit id, a post drawn for
// another run, a fill or a copy the surface refused. Then the Client module
// itself (hooks/board/gates.tsx), called with a fake surface: the right-click
// menu with only the row's items, ↑↓ Enter and a click on an item posting
// the pick, a click outside and a second right-click closing it.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClientKeyEvent, ClientPointerEvent } from 'claude-code'
import type { BoardGateRow, BoardGatesProps, BoardView } from '../../types/index'
import { appendRecord } from '../../hooks/ledgercore'
import { planPath, runDir, runJsonPath, verdictFile } from '../../hooks/layout'
import { updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import { MOD } from '../../hooks/verify'
import { deps, navOf, resetBoardForTests, restoreBoardNav } from '../../hooks/board/view'
import { boardCommand, handleBoard, onBoardUi, resetBoardPaneForTests } from '../../hooks/board/pane'
import { resetRulesPaneForTests } from '../../hooks/rules/pane'
import { resetRulesViewForTests } from '../../hooks/rules/paneview'
import Gates from '../../hooks/board/gates'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const NOW = 1_800_000_000_000
const MIN = 60_000
const EXEC = '20261003-api'

let p: TestPorts
let dir: string
let litterDir: string
let cleanup: () => void
let git: (...argv: string[]) => Promise<string>
let base: string
let landed: string
const saved = { ...deps }

const next = (async () => ({ text: 'engine' })) as never
const command = (args = '') => ({ command: 'litter-board', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as never

beforeEach(async () => {
  state.resetForTests()
  resetBoardForTests()
  resetBoardPaneForTests()
  resetRulesViewForTests()
  resetRulesPaneForTests()
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ sessionId: 's1', cwd: dir })
  p.clock.now = NOW
  ;({ git } = await scratchRepo(p, dir))
  base = (await git('rev-parse', 'HEAD')).trim()
  await p.fs.write(join(dir, 'src', 'header.ts'), 'export const header = 1\n')
  await git('add', 'src/header.ts')
  await git('commit', '-q', '-m', 'G1: parse the header')
  landed = (await git('rev-parse', 'HEAD')).trim()
  litterDir = join(dir, '.claude', 'litter')
  updateSession({ litterDir, toolsRefused: null })
  deps.loadRules = async () => ({ rules: [], problems: [] })
  deps.proposalsOf = async () => []
})

afterEach(() => {
  Object.assign(deps, saved)
  updateSession({ litterDir: null, toolsRefused: null })
  resetBoardPaneForTests()
  state.resetForTests()
  cleanup()
})

// ---------------------------------------------------------------------------
// Fixtures

type Rec = { kind: string; body: Record<string, unknown> }

async function record(run: string, recs: readonly Rec[]): Promise<void> {
  for (const r of recs) {
    p.clock.now = (p.clock.now ?? NOW) + MIN
    await appendRecord(p, runDir(litterDir, run), { run, kind: r.kind, by: MOD, body: r.body })
  }
}

function writeRunJson(run: string, args: Record<string, unknown>, over: Record<string, unknown> = {}): void {
  const json = {
    v: 1,
    run,
    workflow: 'execute',
    args,
    authorized: [],
    mode: 'default',
    verify: ['bun', 'test'],
    goalCheck: null,
    setup: null,
    linkDirs: [],
    base,
    // One branch for every run, so a continuation's chain resolves (lifecycle.ts, resolveChain).
    ref: `refs/heads/litter/${EXEC}`,
    checkout: dir,
    isolate: false,
    previousBranch: 'main',
    continueOf: null,
    amendOf: null,
    rules: [],
    planPath: null,
    planSha256: null,
    session: 's1',
    created: NOW,
    ...over,
  }
  writeFileSync(runJsonPath(runDir(litterDir, run)), `${JSON.stringify(json)}\n`)
}

const start = (run: string): Rec => ({ kind: 'run.start', body: { workflow: 'execute', base, ref: `refs/heads/litter/${run}`, checkout: dir, oid: 'd'.repeat(40), session: 's1' } })
const launch: Rec = { kind: 'run.launch', body: { taskId: 't1', runId: 'wf_1', scriptPath: null, generation: 1, session: 's1', oid: 'd'.repeat(40) } }
const end = (status: string): Rec => ({ kind: 'run.end', body: { taskId: 't1', generation: 1, status, reason: 'G2: a plan gap', source: 'notification' } })
const verify = (id: string, gate: string, attempt: number, green: boolean): Rec => ({
  kind: 'verify',
  body: {
    verify_id: id,
    gate,
    attempt,
    argv: ['bun', 'test'],
    tree_before: 'c'.repeat(40),
    tree_after: 'c'.repeat(40),
    dirty_submodules: [],
    exit_code: green ? 0 : 1,
    signal: null,
    timed_out: false,
    spawn_error: null,
    green,
    log_parts: 1,
    log_bytes: 10,
    output_tail: '',
  },
})
const dim = (pass: boolean, evidence: string) => ({ pass, evidence, gaps: [] })
const verdict = (verifyId: string, pass = true): Rec => ({
  kind: 'verdict',
  body: {
    verify_id: verifyId,
    plan_adherence: dim(pass, pass ? 'as planned' : 'the retry has no backoff'),
    tests_green: dim(true, `verify ${verifyId} exit 0`),
    no_regressions: dim(true, 'none'),
    rules: dim(true, 'none apply'),
    plan_gap: '',
    proposed_rules: [],
  },
})
const land = (gate: string, verifyId: string, commit: string): Rec => ({
  kind: 'land',
  body: { gate, verify_id: verifyId, commit, tree: 'c'.repeat(40), old: base, ref: `refs/heads/litter/${EXEC}` },
})

const GATES = [
  { id: 'G1', title: 'Parse the header' },
  { id: 'G2', title: 'Retry the refresh once' },
]

/** G1 landed (with `commit`); G2 judged at its second attempt, its verdict file written; the run ended halted, or still going. */
async function run(o: { commit?: string; ended?: boolean } = {}): Promise<string> {
  await record(EXEC, [start(EXEC), launch])
  writeRunJson(EXEC, { gates: GATES, maxAttempts: 3 })
  await record(EXEC, [verify('v-g1', 'G1', 1, true), verdict('v-g1'), land('G1', 'v-g1', o.commit ?? landed), verify('v-g2a', 'G2', 1, false), verify('v-g2b', 'G2', 2, false), verdict('v-g2b', false)])
  if (o.ended !== false) await record(EXEC, [end('halted')])
  const file = verdictFile(runDir(litterDir, EXEC), 'G2', 2)
  await p.fs.write(file, '# G2, attempt 2\n\nplan_adherence: \u001b[31mFAIL\u001b[0m, the retry has no backoff\n')
  await boardCommand(p, command(EXEC), next)
  return file
}

const shown = () => p.views.board as BoardView
const rowOf = (id: string): BoardGateRow => shown().body!.gates!.rows.find(r => r.id === id)!
const post = (data: Record<string, unknown>) => onBoardUi.message(p, { element: 'board-gates', data } as never, next)
const press = (key: string) => onBoardUi.press(p, { element: key } as never, next)

// ---------------------------------------------------------------------------

describe("each row's actions", () => {
  test('an ended run: replay on every row, the note where a verdict file is, copy where a full commit id landed', async () => {
    const file = await run()
    expect(rowOf('G1')).toEqual(expect.objectContaining({ state: 'landed', oid: landed, verdictFile: null, actions: ['replay', 'copy'] }))
    expect(rowOf('G2')).toEqual(expect.objectContaining({ state: 'halted', oid: null, verdictFile: file, actions: ['replay', 'note'] }))
  })

  test('a run still going has no replay', async () => {
    await run({ ended: false })
    expect(rowOf('G1').actions).toEqual(['copy'])
    expect(rowOf('G2').actions).toEqual(['note'])
  })

  test('a land whose commit is short or malformed has no full id, so no copy', async () => {
    await run({ commit: landed.slice(0, 12) })
    expect(rowOf('G1')).toEqual(expect.objectContaining({ state: 'landed', commit: landed.slice(0, 7), oid: null, actions: ['replay'] }))
  })
})

describe('replay', () => {
  test("the table's post and the static button fill /litter:amend <gate> and never submit", async () => {
    await run()
    expect(await post({ run: EXEC, action: 'replay', gate: 'G2' })).toEqual({})
    expect(p.filled).toEqual(['/litter:amend G2 '])
    expect(p.toasts.at(-1)).toBe('litter: /litter:amend G2 is in the prompt box: add the change and press Enter')
    expect(await press('board:replay:G1')).toEqual({ element: 'board:replay:G1' })
    expect(p.filled).toEqual(['/litter:amend G2 ', '/litter:amend G1 '])
    expect(p.submitted).toEqual([])
  })

  test('a fill the prompt box refuses, or that throws, toasts the command to type instead', async () => {
    await run()
    p.fillAnswer = () => false
    await post({ run: EXEC, action: 'replay', gate: 'G2' })
    expect(p.toasts.at(-1)).toBe("litter: the prompt box didn't take it: type /litter:amend G2 <change>")
    p.fillPrompt = async () => {
      throw new Error('no composer')
    }
    await press('board:replay:G2')
    expect(p.toasts.at(-1)).toBe("litter: the prompt box didn't take it: type /litter:amend G2 <change>")
    expect(p.logs.some(l => l.includes('no composer'))).toBe(true)
  })

  test('refused while the run is going, and nothing is filled', async () => {
    await run({ ended: false })
    await post({ run: EXEC, action: 'replay', gate: 'G2' })
    await press('board:replay:G1')
    expect(p.filled).toEqual([])
    expect(p.toasts.at(-1)).toBe(`litter: run ${EXEC} is running, so it can't be replayed yet: wait for it to end, then use /litter:amend G1`)
  })
})

describe('the critic note', () => {
  test("opens the row's verdict file as a verdict section, cleaned, its path beside it; another gate's pick closes it", async () => {
    const file = await run()
    await post({ run: EXEC, action: 'note', gate: 'G2' })
    expect(navOf()?.section).toEqual({ kind: 'verdict', gate: 'G2' })
    const s = shown().body!.section!
    expect(s).toEqual({ kind: 'verdict', title: 'critic note on G2', path: file, text: '# G2, attempt 2\n\nplan_adherence: FAIL, the retry has no backoff\n' })
    expect(shown().body!.gates!.selected).toBe('G2')
    expect(shown().body!.buttons.at(-1)).toEqual({ key: 'board:close', label: 'Close' })

    // Mirrored in $.store: a hot reload keeps it open.
    resetBoardForTests()
    await restoreBoardNav(p)
    expect(navOf()?.section).toEqual({ kind: 'verdict', gate: 'G2' })

    await handleBoard(p, 'board:select:G1')
    expect(shown().body!.section).toBeNull()
  })

  test('the static button opens it too; once the file is gone the row has no note', async () => {
    const file = await run()
    await press('board:note:G2')
    expect(shown().body!.section!.kind).toBe('verdict')
    rmSync(file)
    await handleBoard(p, 'board:select:G2')
    await press('board:note:G2')
    // The row has no note now (verdictPath checks the file), so the press is refused.
    expect(p.toasts.at(-1)).toBe("litter: G2 has no critic note yet, so there's nothing to open")
  })

  test('refused on a row with no verdict file', async () => {
    await run()
    await post({ run: EXEC, action: 'note', gate: 'G1' })
    expect(navOf()?.section).toBeNull()
    expect(p.toasts.at(-1)).toBe("litter: G1 has no critic note yet, so there's nothing to open")
  })
})

describe('copy', () => {
  test("copies the land's full commit id, and toasts the short one", async () => {
    await run()
    await post({ run: EXEC, action: 'copy', gate: 'G1' })
    expect(p.copied).toEqual([landed])
    expect(p.toasts.at(-1)).toBe(`litter: copied ${landed.slice(0, 7)} (G1)`)
    await press('board:copy:G1')
    expect(p.copied).toEqual([landed, landed])
  })

  test("a continuation copies the chain's earlier land, from args.landed", async () => {
    const first = '20261001-api'
    await record(first, [start(first), launch, verify('v-g1', 'G1', 1, true), verdict('v-g1'), land('G1', 'v-g1', landed), end('halted')])
    writeRunJson(first, { gates: GATES, maxAttempts: 3 })
    const cont = '20261003-api2'
    await record(cont, [start(cont), launch])
    writeRunJson(cont, { gates: [GATES[1]], maxAttempts: 3, landed: [{ id: 'G1', commit: landed }] }, { continueOf: first })
    await boardCommand(p, command(cont), next)
    expect(rowOf('G1')).toEqual(expect.objectContaining({ earlier: first, oid: landed, actions: ['copy'] }))
    await post({ run: cont, action: 'copy', gate: 'G1' })
    expect(p.copied).toEqual([landed])
    expect(p.toasts.at(-1)).toBe(`litter: copied ${landed.slice(0, 7)} (G1)`)
  })

  test('a short or malformed commit id is refused, never copied', async () => {
    await run({ commit: landed.slice(0, 12) })
    await post({ run: EXEC, action: 'copy', gate: 'G1' })
    expect(p.toasts.at(-1)).toBe("litter: G1's land doesn't record a full commit id, so nothing was copied")

    const cont = '20261003-bad'
    await record(cont, [start(cont), launch])
    writeRunJson(cont, { gates: [GATES[1]], maxAttempts: 3, landed: [{ id: 'G1', commit: `${landed} --output=/tmp/x` }] })
    await boardCommand(p, command(cont), next)
    expect(rowOf('G1')).toEqual(expect.objectContaining({ oid: null, commit: null }))
    await press('board:copy:G1')
    expect(p.copied).toEqual([])
  })

  test("a copy the clipboard refused, or that threw, toasts that it wasn't copied", async () => {
    await run()
    p.copy = async text => {
      p.copied.push(text)
      return false
    }
    await post({ run: EXEC, action: 'copy', gate: 'G1' })
    expect(p.toasts.at(-1)).toBe(`litter: ${landed.slice(0, 7)} (G1) wasn't copied: this screen's clipboard refused it`)
    p.copy = async () => {
      throw new Error('no surface')
    }
    await press('board:copy:G1')
    expect(p.toasts.at(-1)).toBe(`litter: ${landed.slice(0, 7)} (G1) wasn't copied: this screen's clipboard refused it`)
  })
})

describe('refusals', () => {
  test('a post drawn for another run is ignored with a toast', async () => {
    await run()
    expect(await post({ run: '20261001-old', action: 'copy', gate: 'G1' })).toEqual({})
    await post({ run: '20261001-old', action: 'replay', gate: 'G1' })
    expect(p.copied).toEqual([])
    expect(p.filled).toEqual([])
    expect(p.toasts.at(-1)).toContain('that was for run 20261001-old')
  })

  test("an action the row hasn't got is refused with a toast, never acted on", async () => {
    await run()
    await post({ run: EXEC, action: 'copy', gate: 'G2' })
    expect(p.toasts.at(-1)).toBe("litter: G2 hasn't landed, so there's no commit to copy")
    await press('board:copy:G9')
    expect(p.toasts.at(-1)).toBe("litter: G9 isn't a gate of the run the board shows, so that was ignored")
    expect(p.copied).toEqual([])
  })

  test('a post with an action handleBoard does not know, a gate that is not an id, or no run, does nothing', async () => {
    await run()
    const toasts = p.toasts.length
    expect(await post({ run: EXEC, action: 'delete', gate: 'G1' })).toEqual({})
    expect(await post({ run: EXEC, action: 'copy', gate: 'G1 --output=/tmp/x' })).toEqual({})
    expect(await post({ action: 'copy', gate: 'G1' })).toEqual({})
    expect(await post({ run: EXEC, action: 'copy', gate: 7 })).toEqual({})
    expect(p.copied).toEqual([])
    expect(p.toasts.length).toBe(toasts)
  })

  test('the posts take every action handleBoard knows: a diff and [Plan] from the table', async () => {
    await run()
    writeFileSync(planPath(runDir(litterDir, EXEC)), '# Plan\n\n### G1: Parse the header\nFiles: src/header.ts\n')
    await post({ run: EXEC, action: 'diff', gate: 'G1' })
    expect(shown().body!.section!.kind).toBe('diff')
    await post({ run: EXEC, action: 'plan' })
    expect(shown().body!.section!.kind).toBe('plan')
    await post({ run: EXEC, action: 'close' })
    expect(shown().body!.section).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The Client module, with a fake surface

type El = { type: unknown; props: Record<string, unknown>; children: unknown[] }

// The environment's JSX factory, which tier 2 doesn't have: elements as plain data.
Object.assign(globalThis, {
  h: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El => ({ type, props: props ?? {}, children }),
  Fragment: 'Fragment',
})

const isEl = (v: unknown): v is El => typeof v === 'object' && v !== null && 'type' in v && 'children' in v
const textOf = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : Array.isArray(v) ? v.map(textOf).join('') : isEl(v) ? v.children.map(textOf).join('') : '')
/** Each Text's shown text, in document order, under `node`. */
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

const gateRow = (id: string, actions: BoardGateRow['actions']): BoardGateRow => ({
  id,
  title: `gate ${id}`,
  state: 'landed',
  color: 'success',
  glyph: '✓',
  attempt: 1,
  maxAttempts: 3,
  failing: [],
  verdictFile: null,
  commit: null,
  oid: null,
  earlier: null,
  actions,
})

/** gates.tsx drawn on a fake surface: its posts, its listeners, its tree after each setState, and the open menu's texts. */
function mount(props: BoardGatesProps, size = { columns: 100, rows: 12 }) {
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
    tree = Gates(props, surface as never)
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
    menuAt: () => {
      const m = menuBox()
      return m ? { top: m.props.top as number, left: m.props.left as number } : null
    },
    texts: () => texts(tree),
  }
}

const PROPS: BoardGatesProps = { run: EXEC, rows: [gateRow('G1', ['replay', 'copy']), gateRow('G2', ['replay', 'note']), gateRow('G3', [])], selected: 'G2' }

describe('the gate table Client (gates.tsx)', () => {
  test("a right-click on a row opens its menu, with only that row's items", () => {
    const ui = mount(PROPS)
    expect(ui.menu()).toBeNull()
    // The header is the first row; G1 is the next.
    ui.pointer({ type: 'down', x: 4, y: 1, button: 'right' })
    expect(ui.menu()).toEqual(['G1', 'replay with /litter:amend', 'copy commit', 'close'])
    expect(ui.posts).toEqual([])
    // A right-click on G2's row, the second one: the menu closes, and the next opens G2's.
    ui.pointer({ type: 'down', x: 4, y: 2, button: 'right' })
    expect(ui.menu()).toBeNull()
    ui.pointer({ type: 'down', x: 4, y: 2, button: 'right' })
    expect(ui.menu()).toEqual(['G2', 'replay with /litter:amend', 'open critic note', 'close'])
  })

  test('a row with no action opens no menu', () => {
    const ui = mount(PROPS)
    ui.pointer({ type: 'down', x: 4, y: 3, button: 'right' })
    expect(ui.menu()).toBeNull()
    expect(ui.posts).toEqual([])
  })

  test('↑↓ and Enter pick an item, which posts { run, action, gate } and closes the menu', () => {
    const ui = mount(PROPS)
    ui.pointer({ type: 'down', x: 4, y: 1, button: 'right' })
    ui.key('down')
    ui.key('return')
    expect(ui.posts).toEqual([{ run: EXEC, action: 'copy', gate: 'G1' }])
    expect(ui.menu()).toBeNull()
    // Up wraps to the last item, close, which posts nothing.
    ui.pointer({ type: 'down', x: 4, y: 1, button: 'right' })
    ui.key('up')
    ui.key('return')
    expect(ui.posts).toHaveLength(1)
    expect(ui.menu()).toBeNull()
  })

  test('a click on an item picks it; a click outside closes the menu and picks nothing', () => {
    const ui = mount(PROPS)
    ui.pointer({ type: 'down', x: 4, y: 2, button: 'right' })
    const at = ui.menuAt()!
    // The frame's top border and the title, then the items: the note is the second.
    ui.pointer({ type: 'down', x: at.left + 3, y: at.top + 3, button: 'left' })
    expect(ui.posts).toEqual([{ run: EXEC, action: 'note', gate: 'G2' }])
    expect(ui.menu()).toBeNull()

    ui.pointer({ type: 'down', x: 4, y: 2, button: 'right' })
    ui.pointer({ type: 'down', x: 99, y: 0, button: 'left' })
    expect(ui.menu()).toBeNull()
    expect(ui.posts).toHaveLength(1)
    // Left closes it from the keyboard too.
    ui.pointer({ type: 'down', x: 4, y: 2, button: 'right' })
    ui.key('left')
    expect(ui.menu()).toBeNull()
  })

  test('→ opens the hovered row\'s menu from the keyboard; a click on a row still posts select', () => {
    const ui = mount(PROPS)
    ui.pointer({ type: 'down', x: 4, y: 1, button: 'left' })
    expect(ui.posts).toEqual([{ run: EXEC, action: 'select', gate: 'G1' }])
    ui.key('right')
    expect(ui.menu()).toEqual(['G1', 'replay with /litter:amend', 'copy commit', 'close'])
    ui.key('return')
    expect(ui.posts.at(-1)).toEqual({ run: EXEC, action: 'replay', gate: 'G1' })
  })

  test('near the bottom row, the menu opens upwards so it stays inside the region', () => {
    const ui = mount(PROPS, { columns: 40, rows: 6 })
    // G2, the second gate, is at y 2 of 6, and its menu is 3 + 3 rows: it opens from the top.
    ui.pointer({ type: 'down', x: 30, y: 2, button: 'right' })
    expect(ui.menuAt()).toEqual({ top: 0, left: 10 })
    // With room below, it opens at the row: 40 columns wide, 30 for the menu, so it shifts left.
    const tall = mount(PROPS, { columns: 40, rows: 12 })
    tall.pointer({ type: 'down', x: 30, y: 2, button: 'right' })
    expect(tall.menuAt()).toEqual({ top: 2, left: 10 })
  })

  test('the table draws the rows and the hint, with or without a menu', () => {
    const ui = mount(PROPS)
    expect(ui.texts().join('\n')).toContain('right-click or → for its actions')
    expect(ui.texts().filter(t => t.startsWith('G'))).toEqual(['G1    ', 'G2    ', 'G3    '])
  })
})
