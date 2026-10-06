// Tier 2: the board's design view (phase 5, WP-CD; COMMON decision 10), from
// ledgers the real ledgercore writes: the bar × version matrix's cells (PASS,
// CONDITIONAL with each gap kind, FAIL, not judged), the latest verdict on a
// version winning, an id outside the bar, the version lines with `source
// changed`, ten versions showing the last eight; the record lines of every
// design kind, and the fix for a design verdict that read "✓ passes" whatever
// its overall; and [Plan] before and after delivery.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import type { Author, StoredRecord } from '../../hooks/records/core'
import type { BoardView } from '../../types/index'
import { appendRecord } from '../../hooks/ledgercore'
import { planPath, proposalPath, runDir, runJsonPath } from '../../hooks/layout'
import { updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import { MATRIX_LEGEND, buildBoard, deps, recordLine, resetBoardForTests, type RecordContext } from '../../hooks/board/view'
import { boardCommand, handleBoard, resetBoardPaneForTests } from '../../hooks/board/pane'
import { resetRulesPaneForTests } from '../../hooks/rules/pane'
import { resetRulesViewForTests } from '../../hooks/rules/paneview'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const NOW = 1_800_000_000_000
const RUN = '20261005-design-cd34ef'
const MOD: Author = { source: 'mod' }
const AUTHOR: Author = { source: 'agent', agentId: 'au', agentType: 'litter:author' }
const CRITIC: Author = { source: 'agent', agentId: 'dc', agentType: 'litter:design-critic' }

/** Your items, a ban and the rules' criterion (design/bar.ts's rulesIntoBar), in the bar's order. */
const BAR = [
  { id: 'C1', text: 'retries once on a 401', evidence: 'a test' },
  { id: 'C2', text: 'keeps the timeout', evidence: 'the config' },
  { id: 'C3', text: 'logs each retry', evidence: 'a log line' },
  { id: 'C4', text: 'needs no new dependency', evidence: 'package.json' },
  { id: 'C5', text: 'documents the retry', evidence: 'the README' },
  { id: 'B1', text: 'no sleep in tests', evidence: 'grep', reason: 'flaky' },
  { id: 'B2', text: 'Never force-push', evidence: 'git log', reason: 'history is shared', rule: { id: 'no-force-push', version: 2 } },
  { id: 'C6', text: 'Consistent with rules header-parser@3, or asks before changing one', evidence: 'the rules', rules: [{ id: 'header-parser', version: 3 }] },
]
const BAR_IDS = BAR.map(b => b.id)

let p: TestPorts
let dir: string
let litterDir: string
let cleanup: () => void
let at: number
const saved = { ...deps }

beforeEach(() => {
  state.resetForTests()
  resetBoardForTests()
  resetBoardPaneForTests()
  resetRulesViewForTests()
  resetRulesPaneForTests()
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ sessionId: 's1', cwd: dir })
  at = NOW
  p.clock.now = at
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

const rd = () => runDir(litterDir, RUN)
const add = async (kind: string, body: Record<string, unknown>, by: Author = MOD): Promise<StoredRecord> => {
  p.clock.now = at += 60_000
  return appendRecord(p, rd(), { run: RUN, kind, by, body })
}

function writeRunJson(args: Record<string, unknown> = {}): void {
  const json = {
    v: 1,
    run: RUN,
    workflow: 'design',
    args: { deliverable: 'plan', bar: BAR, empiricalUnknowns: [{ id: 'U1', question: 'does the API send 401 on expiry?' }, 'is the token cached?'], ...args },
    authorized: [],
    mode: 'default',
    verify: null,
    goalCheck: null,
    setup: null,
    linkDirs: [],
    base: 'a'.repeat(40),
    ref: `refs/heads/litter/${RUN}`,
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
  }
  writeFileSync(runJsonPath(rd()), `${JSON.stringify(json)}\n`)
}

const SHA = (n: number) => `${String(n).repeat(7).slice(0, 7)}${'e'.repeat(57)}`

async function launched(args: Record<string, unknown> = {}): Promise<void> {
  await add('run.start', { workflow: 'design', base: 'a'.repeat(40), ref: `refs/heads/litter/${RUN}`, checkout: dir, oid: 'd'.repeat(40), session: 's1' }, { source: 'launcher' })
  await add('run.launch', { taskId: 't1', runId: 'wf_1', scriptPath: null, generation: 1, session: 's1', oid: 'd'.repeat(40) })
  writeRunJson(args)
}

/** proposals/vN.md and its record; for a plan, `gates` gates. */
async function propose(n: number, gates: number | null = 2): Promise<void> {
  const version = `v${n}`
  await p.fs.write(proposalPath(rd(), version), `# Proposal ${version}\n\nRetry once.\n`)
  const body: Record<string, unknown> = { text: `Proposal ${version}`, version, sha256: SHA(n) }
  if (gates !== null) body.gates = Array.from({ length: gates }, (_, i) => ({ id: `G${i + 1}`, title: `gate ${i + 1}` }))
  await add('proposal', body, AUTHOR)
}

const c = (id: string, verdict: string, gap_kind?: string) => ({ id, verdict, evidence: `${id} evidence`, ...(gap_kind ? { gap_kind } : {}) })
const allPass = () => BAR_IDS.map(id => c(id, 'PASS'))
const judge = (version: string, criteria: unknown[], overall: string, more: Record<string, unknown> = {}) =>
  add('verdict', { version, criteria, overall, sha256: null, ...more }, CRITIC)

/** Three versions: v1 judged with every kind of cell and an id outside the bar, v2 judged twice (the later wins), v3 not judged. */
async function threeVersions(): Promise<void> {
  await launched()
  await propose(1)
  await judge(
    'v1',
    [
      c('C1', 'PASS'),
      c('C2', 'CONDITIONAL', 'investigation'),
      c('C3', 'CONDITIONAL', 'design'),
      c('C4', 'CONDITIONAL', 'wording'),
      c('C5', 'CONDITIONAL', 'user'),
      c('B1', 'FAIL', 'design'),
      // A gap kind the record left out: the glyph alone.
      c('B2', 'FAIL'),
      // C6 isn't judged; C9 isn't in the bar.
      c('C9', 'PASS'),
    ],
    'HOLDING',
    { source_changed: true },
  )
  await propose(2)
  await judge('v2', BAR_IDS.map(id => c(id, 'FAIL', 'wording')), 'HOLDING')
  await judge('v2', [...allPass().filter(x => x.id !== 'C3'), c('C3', 'FAIL', 'investigation')], 'HOLDING', { source_changed: false })
  await propose(3)
}

const design = async () => (await buildBoard(p, litterDir, RUN)).body!.design!
const cellsOf = (d: Awaited<ReturnType<typeof design>>) => Object.fromEntries(d.rows.map(r => [r.id, r.cells.map(x => x.text).join(' ')]))

describe('the bar × version matrix', () => {
  test("a row per bar item in the bar's order, a column per version, each cell from the latest verdict on it", async () => {
    await threeVersions()
    const view = await buildBoard(p, litterDir, RUN)
    expect(view.body!.gates).toBeNull()
    const d = view.body!.design!
    expect(d.versions).toEqual(['v1', 'v2', 'v3'])
    expect(d.hidden).toBe(0)
    expect(d.rows.map(r => [r.id, r.outside])).toEqual([...BAR_IDS.map(id => [id, false]), ['C9', true]])
    expect(d.rows[0]!.text).toBe('retries once on a 401')
    expect(d.rows.at(-1)!.text).toBe('not in the bar')
    expect(cellsOf(d)).toEqual({
      C1: '✓ ✓ ·',
      C2: '~i ✓ ·',
      C3: '~d ✕i ·',
      C4: '~w ✓ ·',
      C5: '~u ✓ ·',
      B1: '✕d ✓ ·',
      B2: '✕ ✓ ·',
      C6: '· ✓ ·',
      C9: '✓ · ·',
    })
    // Each glyph with its theme key.
    const colors = Object.fromEntries(d.rows.map(r => [r.id, r.cells.map(x => x.color)]))
    expect(colors.C1).toEqual(['success', 'success', 'inactive'])
    expect(colors.C2).toEqual(['warning', 'success', 'inactive'])
    expect(colors.B1).toEqual(['error', 'success', 'inactive'])
    expect(colors.C6).toEqual(['inactive', 'success', 'inactive'])
  })

  test("the legend spells out the glyphs and the gap kinds' letters", async () => {
    await threeVersions()
    const d = await design()
    expect(d.legend).toBe(MATRIX_LEGEND)
    for (const word of ['✓ PASS', '~ CONDITIONAL', '✕ FAIL', '· not judged', 'i investigation', 'd design', 'w wording', 'u user']) expect(d.legend).toContain(word)
  })

  test('a line per version: its overall, its sha256 abbreviated, and source changed where true', async () => {
    await threeVersions()
    expect((await design()).lines).toEqual([
      { version: 'v1', overall: 'HOLDING', color: 'warning', sha: SHA(1).slice(0, 7), sourceChanged: true },
      // The later verdict on v2 says false.
      { version: 'v2', overall: 'HOLDING', color: 'warning', sha: SHA(2).slice(0, 7), sourceChanged: false },
      { version: 'v3', overall: 'not judged', color: 'inactive', sha: SHA(3).slice(0, 7), sourceChanged: false },
    ])
  })

  test('ten versions: the last eight, oldest first, and how many are hidden', async () => {
    await launched()
    for (let n = 1; n <= 10; n++) {
      await propose(n)
      await judge(`v${n}`, n === 10 ? allPass() : [c('C1', 'FAIL', 'design')], n === 10 ? 'APPROVED' : 'HOLDING')
    }
    const d = await design()
    expect(d.versions).toEqual(['v3', 'v4', 'v5', 'v6', 'v7', 'v8', 'v9', 'v10'])
    expect(d.hidden).toBe(2)
    expect(d.lines.map(l => l.version)).toEqual(d.versions)
    expect(d.lines.at(-1)).toEqual(expect.objectContaining({ overall: 'APPROVED', color: 'success' }))
    expect(d.rows[0]!.cells.map(x => x.text)).toEqual(['✕d', '✕d', '✕d', '✕d', '✕d', '✕d', '✕d', '✓'])
  })

  test('a run with no version yet: the bar, with no column', async () => {
    await launched()
    const d = await design()
    expect(d.versions).toEqual([])
    expect(d.rows.map(r => r.id)).toEqual(BAR_IDS)
    expect(d.rows.every(r => r.cells.length === 0)).toBe(true)
  })

  test('text from the records is cleaned: an id and an item cut, escapes dropped', async () => {
    await launched({ bar: [{ id: 'C1', text: 'retries\u001b[2J once\non a 401', evidence: 'x' }] })
    await propose(1)
    await judge('v1', [c('C1', 'PASS'), c(`C${'9'.repeat(40)}`, 'PASS')], 'HOLDING')
    const d = await design()
    expect(d.rows[0]!.text).toBe('retries once on a 401')
    expect(d.rows[1]!.id.length).toBeLessThanOrEqual(16)
    expect(d.rows[1]!.outside).toBe(true)
  })
})

describe('the record lines', () => {
  const rec = (kind: string, body: Record<string, unknown>) => ({ v: 1, seq: 1, kind, run: RUN, at: NOW, by: MOD, prev: null, body }) as StoredRecord
  const ctx: RecordContext = { bar: BAR_IDS, unknowns: new Map([['U1', 'does the API send 401 on expiry?']]) }

  test('proposal: its version, and a plan\'s gates', () => {
    expect(recordLine(rec('proposal', { text: 'x', version: 'v3', sha256: SHA(3), gates: [{}, {}, {}, {}] }), ctx)).toBe('v3 · 4 gates')
    expect(recordLine(rec('proposal', { text: 'x', version: 'v1', sha256: SHA(1), gates: [{}] }), ctx)).toBe('v1 · 1 gate')
    expect(recordLine(rec('proposal', { text: 'x', version: 'v2', sha256: SHA(2) }), ctx)).toBe('v2')
  })

  test('a design verdict: its version and overall, how many pass over the bar, and which are open', () => {
    expect(recordLine(rec('verdict', { version: 'v4', criteria: allPass(), overall: 'APPROVED', sha256: null }), ctx)).toBe('v4 APPROVED · 8/8 pass')
    const holding = rec('verdict', { version: 'v3', criteria: [...allPass().filter(x => x.id !== 'C3' && x.id !== 'C5'), c('C3', 'FAIL', 'design')], overall: 'HOLDING', sha256: null })
    // C5 has no verdict: open, as the approval reads it.
    expect(recordLine(holding, ctx)).toBe('v3 HOLDING · 6/8 pass, open C3 C5')
    // An id outside the bar counts too; with no bar known, the criteria alone.
    const outside = rec('verdict', { version: 'v1', criteria: [c('C1', 'PASS'), c('C9', 'FAIL', 'user')], overall: 'HOLDING', sha256: null })
    expect(recordLine(outside, { bar: ['C1'], unknowns: new Map() })).toBe('v1 HOLDING · 1/2 pass, open C9')
    expect(recordLine(outside)).toBe('v1 HOLDING · 1/2 pass, open C9')
  })

  test('the bug: a HOLDING verdict never reads "✓ passes"; each verdict shape is told apart first', () => {
    const failing = rec('verdict', { version: 'v2', criteria: BAR_IDS.map(id => c(id, 'FAIL', 'design')), overall: 'HOLDING', sha256: null })
    const line = recordLine(failing, ctx)
    expect(line).toBe(`v2 HOLDING · 0/8 pass, open ${BAR_IDS.join(' ')}`)
    expect(line).not.toContain('passes')
    // Execute's four dimensions and a fanout's tasks read as before.
    const dim = (pass: boolean) => ({ pass, evidence: '', gaps: [] })
    expect(recordLine(rec('verdict', { verify_id: 'v-1', plan_adherence: dim(true), tests_green: dim(true), no_regressions: dim(true), rules: dim(true) }))).toBe('on v-1: ✓ passes')
    expect(recordLine(rec('verdict', { verify_id: 'v-1', plan_adherence: dim(false), tests_green: dim(true), no_regressions: dim(true), rules: dim(true) }))).toBe('on v-1: ✕ plan_adherence')
    expect(recordLine(rec('verdict', { tasks: [{ pass: true }, { pass: false }] }))).toBe('1 of 2 tasks pass')
    // None of the three: unrecognized, never a pass.
    expect(recordLine(rec('verdict', { verify_id: 'v-1', plan_adherence: dim(true) }))).toBe('verdict (unrecognized)')
    expect(recordLine(rec('verdict', { criteria: [], version: 'v1' }))).toBe('verdict (unrecognized)')
  })

  test('probe: the unknown, its verdict and its question, from the probe or the run\'s args', () => {
    expect(recordLine(rec('probe', { unknown_id: 'U1', verdict: 'confirmed', report: 'yes' }), ctx)).toBe('U1 confirmed: does the API send 401 on expiry?')
    expect(recordLine(rec('probe', { unknown_id: 'U3', question: 'is the cache shared?', verdict: 'refuted', report: 'no' }), ctx)).toBe('U3 refuted: is the cache shared?')
    expect(recordLine(rec('probe', { unknown_id: 'U4', report: 'tried' }), ctx)).toBe('U4 no verdict recorded')
    expect(recordLine(rec('probe', { report: 'an old probe\nwith two lines' }), ctx)).toBe('no unknown named: an old probe with two lines')
  })

  test("design.result: the role, the author's version, the reframer's recommendation", () => {
    expect(recordLine(rec('design.result', { role: 'author', tool_use_id: 't', result: { version: 'v2', delta: [] } }))).toBe('author, v2')
    expect(recordLine(rec('design.result', { role: 'author', tool_use_id: 't', result: { version: '../v2' } }))).toBe('author')
    expect(recordLine(rec('design.result', { role: 'reframer', tool_use_id: 't', result: { recommendation: 'R2', candidates: [] } }))).toBe('reframer, recommends R2')
    expect(recordLine(rec('design.result', { role: 'reframer', tool_use_id: 't', result: { recommendation: 'none' } }))).toBe('reframer, no reframe')
  })

  test('design.deliver: delivered with the path, or refused with the reason', () => {
    expect(recordLine(rec('design.deliver', { version: 'v3', sha256: SHA(3), path: '/repo/.litter/run/plan.md' }))).toBe('delivered v3 as /repo/.litter/run/plan.md')
    expect(recordLine(rec('design.deliver', { version: 'v3', refused: "proposals/v3.md changed after it was recorded: it's gone" }))).toBe(
      "refused v3: proposals/v3.md changed after it was recorded: it's gone",
    )
    expect(recordLine(rec('design.deliver', { version: null, refused: 'no version was recorded' }))).toBe('refused: no version was recorded')
  })

  test("the board's record list words a design run's records with its bar and unknowns", async () => {
    await threeVersions()
    await add('probe', { unknown_id: 'U2', verdict: 'untested', report: 'not run' }, { source: 'agent', agentId: 'pr', agentType: 'litter:prober' })
    const rows = (await buildBoard(p, litterDir, RUN)).body!.records
    expect(rows.map(r => [r.kind, r.text])).toEqual([
      ['run.start', expect.stringContaining('design run from')],
      ['run.launch', 'generation 1, task t1'],
      ['proposal', 'v1 · 2 gates'],
      ['verdict', 'v1 HOLDING · 2/9 pass, open C2 C3 C4 C5 B1 B2 C6'],
      ['proposal', 'v2 · 2 gates'],
      ['verdict', `v2 HOLDING · 0/8 pass, open ${BAR_IDS.join(' ')}`],
      ['verdict', 'v2 HOLDING · 7/8 pass, open C3'],
      ['proposal', 'v3 · 2 gates'],
      // A bare-string unknown is U2's question.
      ['probe', 'U2 untested: is the token cached?'],
    ])
  })
})

describe('[Plan] for a design run', () => {
  const command = { command: 'litter', args: RUN, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never
  const next = (async () => ({ text: 'engine' })) as never
  const shown = () => p.views.board as BoardView

  test('before delivery, the latest proposal, titled with its version; after, plan.md', async () => {
    await threeVersions()
    await boardCommand(p, command, next)
    expect(shown().body!.buttons.map(b => [b.key, b.label])).toEqual([
      ['board:plan', 'Plan'],
      ['board:rules', 'Rules'],
    ])
    await handleBoard(p, 'board:plan')
    expect(shown().body!.section).toEqual({ kind: 'plan', title: 'proposal v3', path: proposalPath(rd(), 'v3'), text: '# Proposal v3\n\nRetry once.\n' })

    // A refused delivery leaves it on the proposal.
    await add('design.deliver', { version: 'v3', refused: 'v3 has no approving verdict' })
    await handleBoard(p, 'board:plan')
    expect(shown().body!.section!.title).toBe('proposal v3')

    await judge('v3', allPass(), 'APPROVED')
    await p.fs.write(planPath(rd()), '# Proposal v3\n\nRetry once.\n')
    await add('design.deliver', { version: 'v3', sha256: SHA(3), path: planPath(rd()) })
    await handleBoard(p, 'board:plan')
    expect(shown().body!.section).toEqual({ kind: 'plan', title: 'plan.md (v3, delivered)', path: planPath(rd()), text: '# Proposal v3\n\nRetry once.\n' })
  })

  test("a proposal file that's gone says so; a deliverable that isn't a plan is a Proposal; no version, no button", async () => {
    await launched({ deliverable: 'research' })
    await boardCommand(p, command, next)
    expect(shown().body!.buttons.map(b => b.key)).toEqual(['board:rules'])
    await propose(1, null)
    rmSync(proposalPath(rd(), 'v1'))
    await handleBoard(p, 'board:close')
    expect(shown().body!.buttons[0]).toEqual({ key: 'board:plan', label: 'Proposal' })
    await handleBoard(p, 'board:plan')
    expect(shown().body!.section).toEqual({ kind: 'plan', title: "proposal v1 isn't there", path: proposalPath(rd(), 'v1'), text: '' })
  })
})
