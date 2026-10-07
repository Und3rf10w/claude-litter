// Tier 2: the band's view (hooks/band/view.ts; WP-CB, COMMON decision 7) from
// ledgers the real ledgercore writes under a scratch litter directory, and a
// policy.json written beside them. Each workflow's row (execute on its first
// gate, on a retry, critiquing, landing; design before and after a verdict;
// fanout integrating; plan; a repair generation), an ended run's row inside
// and past 10 minutes, and past the bandEndedMinutes option's 1 and 0
// (WP-CH), a live swarm's counts, no row for an open ask (WP-CK: the ask
// line is a transcript row now), [Hide] and its $.store mirror, the write
// check, the failure paths (a missing litter directory, an unreadable
// policy.json or ledger), the presses, and the fitting the render draws from
// (fitRows, fitSpans). WP-DB: each row reads `<glyph> <word> · litter · …`,
// in the style table's roles, and bandLines() hands Home every line of the
// last build (every run ended inside the window, every hidden row), which
// the hub's writeHub words into Home's part of its view.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BandPressHook } from '../../hooks/hooktypes'
import type { SpoolLine } from '../../hooks/hookfiles'
import type { LiveSwarm, NodeBinding } from '../../hooks/swarm/types'
import type { BandRow, BandView, HubView, SwarmSpan } from '../../types/index'
import { appendRecord } from '../../hooks/ledgercore'
import { ledgerDir, policyPath, runDir, runJsonPath } from '../../hooks/layout'
import { setOptions, updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import { MOD } from '../../hooks/verify'
import { asksTick, consumeAsks, openAsks, resetAsksForTests } from '../../hooks/asks'
import {
  BAND_STORE_KEY,
  ENDED_MS,
  bandCounts,
  bandLines,
  bandShows,
  bandTick,
  deps,
  elapsed,
  fitRows,
  fitSpans,
  hiddenKeys,
  onBandUi,
  refreshBand,
  resetBandForTests,
  roomFor,
} from '../../hooks/band/view'
import { resetPanesForTests } from '../../hooks/swarm/panes'
import { noteProposal, resetViewForTests } from '../../hooks/swarm/view'
import { deps as hubDeps, resetHubForTests, shownSection, writeHub } from '../../hooks/ui/hub'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

/** The real call into the hub's opener, kept before any test stands in for it. */
const defaultOpenSection = deps.openSection

const NOW = 1_800_000_000_000
const MIN = 60_000
const EXEC = '20261005-retry'
const DESIGN = '20261005-currency'
const FAN = '20261005-split'
const PLAN = '20261005-plan'

let p: TestPorts
let dir: string
let litterDir: string
let cleanup: () => void
let boards: string[]
let browsers: string[]
/** What the stand-in opener answers for Runs and for Swarms; a function that throws, throws. */
let boardOpen: () => Promise<boolean>
let browserOpen: (name: string) => Promise<{ placed: boolean; text: string }>

beforeEach(() => {
  resetBandForTests()
  resetAsksForTests()
  resetHubForTests()
  state.resetForTests()
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ sessionId: 's1', cwd: dir })
  p.clock.now = NOW
  litterDir = join(dir, '.claude', 'litter')
  mkdirSync(join(litterDir, 'hooks'), { recursive: true })
  updateSession({ litterDir })
  boards = []
  browsers = []
  boardOpen = async () => true
  browserOpen = async name => ({ placed: true, text: `Swarms shows ${name}, live` })
  // The band's presses are the person's: each asks for the keyboard.
  deps.openSection = async (_p, id, arg, opts) => {
    expect(opts).toEqual({ focus: true })
    if (id === 'runs') {
      boards.push(arg as string)
      return { placed: await boardOpen(), text: '' }
    }
    expect(id).toBe('swarms')
    browsers.push(arg as string)
    return browserOpen(arg as string)
  }
})

afterEach(() => {
  resetBandForTests()
  resetAsksForTests()
  resetPanesForTests()
  resetHubForTests()
  state.resetForTests()
  updateSession({ litterDir: null })
  setOptions(undefined)
  cleanup()
})

// ---------------------------------------------------------------------------
// Fixtures

type Rec = { kind: string; body: Record<string, unknown> }

/** Each record through ledgercore, at the clock's time; the clock doesn't move. */
async function record(run: string, recs: readonly Rec[]): Promise<void> {
  for (const r of recs) await appendRecord(p, runDir(litterDir, run), { run, kind: r.kind, by: MOD, body: r.body })
}

function writeRunJson(run: string, workflow: string, args: Record<string, unknown>): void {
  mkdirSync(runDir(litterDir, run), { recursive: true })
  const json = { v: 1, run, workflow, args, authorized: [], mode: 'default', verify: ['bun', 'test'], base: 'a'.repeat(40), ref: `refs/heads/litter/${run}`, checkout: dir, session: 's1', created: NOW }
  writeFileSync(runJsonPath(runDir(litterDir, run)), `${JSON.stringify(json)}\n`)
}

/** policy.json naming `run` as active (or none), with its in-flight flag. */
function writePolicy(run: string | null, inflight: 'critique' | 'land' | null = null): void {
  const policy = { v: 1, session: 's1', litterDir, run: run ? { run, workflow: 'execute', inflight, stopping: false } : null, roles: {}, swarm: null }
  writeFileSync(policyPath(litterDir), `${JSON.stringify(policy)}\n`)
}

const start = (workflow: string): Rec => ({ kind: 'run.start', body: { workflow, base: 'a'.repeat(40), ref: 'refs/heads/x', checkout: '/x', oid: 'd'.repeat(40), session: 's1' } })
const launch = (generation = 1): Rec => ({ kind: generation === 1 ? 'run.launch' : 'run.resume', body: { taskId: `t${generation}`, runId: `wf_${generation}`, scriptPath: null, generation, session: 's1', oid: 'd'.repeat(40) } })
const end = (generation: number, status: string): Rec => ({ kind: 'run.end', body: { taskId: `t${generation}`, generation, status, reason: null, source: 'notification' } })
const verify = (id: string, gate: string, attempt: number): Rec => ({ kind: 'verify', body: { verify_id: id, gate, attempt, tree_after: 'c'.repeat(40), green: true } })
const dim = (pass: boolean) => ({ pass, evidence: 'e', gaps: [] })
const verdict = (verifyId: string, pass: boolean): Rec => ({
  kind: 'verdict',
  body: { verify_id: verifyId, plan_adherence: dim(pass), tests_green: dim(true), no_regressions: dim(true), rules: dim(true), plan_gap: '' },
})
const land = (gate: string, verifyId: string): Rec => ({ kind: 'land', body: { gate, verify_id: verifyId, commit: 'b'.repeat(40), tree: 'c'.repeat(40), old: 'a'.repeat(40), ref: 'refs/heads/x' } })
const GATES = [{ id: 'G1' }, { id: 'G2' }, { id: 'G3' }]

const text = (r: BandRow | undefined): string => (r ? r.spans.map(s => s.text).join('') : '')
const band = (): BandView | null => (p.views.band ?? null) as BandView | null
const texts = (): string[] => (band()?.rows ?? []).map(text)

/** An execute run on its first gate, active in policy.json. */
async function executeRun(run = EXEC): Promise<void> {
  writeRunJson(run, 'execute', { gates: GATES })
  await record(run, [start('execute'), launch()])
  writePolicy(run)
}

const press = (element: string, plugin = 'litter') =>
  onBandUi.press(p, { plugin, element, component: 'AbovePrompt', requestId: 'above-prompt', surface: 'terminal' } as Parameters<BandPressHook>[1], (async (e: { element: string }) => ({ element: `passed ${e.element}` })) as never)

// ---------------------------------------------------------------------------

describe("an execute run's row", () => {
  test('on its first gate: the gate count, the elapsed time, [Board] and [Hide], no hotkeys', async () => {
    await executeRun()
    p.clock.now = NOW + 14 * MIN + 5_000
    await bandTick(p)
    const rows = band()!.rows
    expect(rows).toHaveLength(1)
    expect(text(rows[0])).toBe(`▸ running · litter · execute ${EXEC} · gate 1/3 · 14m`)
    expect(rows[0]!.kind).toBe('run')
    expect(rows[0]!.key).toBe(`run:${EXEC}:1:open`)
    expect(rows[0]!.buttons).toEqual([
      { key: `band:board:${EXEC}`, label: 'Board' },
      { key: `band:hide:run:${EXEC}:1:open`, label: 'Hide' },
    ])
    // The colors (WP-DB, the style table's roles): the mark its RUN_STATUS color, litter's name and the elapsed time muted, the run id the name color.
    const spans = rows[0]!.spans
    expect(spans[0]).toEqual({ text: '▸ running', color: 'background' })
    expect(spans[2]).toEqual({ text: 'litter', color: 'inactive' })
    expect(spans.find(s => s.text === EXEC)?.color).toBe('cyan_FOR_SUBAGENTS_ONLY')
    expect(spans.at(-1)).toEqual({ text: '14m', color: 'inactive' })
    expect(spans.some(s => s.dim)).toBe(false)
  })

  test('on a retry: the gate and its retry count, in warning', async () => {
    await executeRun()
    await record(EXEC, [verify('v1', 'G1', 1), verdict('v1', false)])
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · execute ${EXEC} · gate 1/3 · G1 retry 1 · <1m`])
    expect(band()!.rows[0]!.spans.find(s => s.text === 'retry 1')?.color).toBe('warning')
    // G1 lands on its second attempt; G2 is on its third.
    await record(EXEC, [verify('v2', 'G1', 2), verdict('v2', true), land('G1', 'v2'), verify('v3', 'G2', 1), verdict('v3', false), verify('v4', 'G2', 2), verdict('v4', false)])
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · execute ${EXEC} · gate 2/3 · G2 retry 2 · <1m`])
    // The critic's verify of the third attempt is in: still the third.
    await record(EXEC, [verify('v5', 'G2', 3)])
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · execute ${EXEC} · gate 2/3 · G2 retry 2 · <1m`])
  })

  test('critiquing and landing, from the in-flight flag', async () => {
    await executeRun()
    writePolicy(EXEC, 'critique')
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · execute ${EXEC} · gate 1/3 · G1 critic · <1m`])
    await record(EXEC, [verify('v1', 'G1', 1), verdict('v1', false), verify('v2', 'G1', 2)])
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · execute ${EXEC} · gate 1/3 · G1 retry 1 critic · <1m`])
    writePolicy(EXEC, 'land')
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · execute ${EXEC} · gate 1/3 · landing G1 · <1m`])
    writePolicy(EXEC, null)
    await record(EXEC, [verdict('v2', true), land('G1', 'v2')])
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · execute ${EXEC} · gate 2/3 · <1m`])
  })

  test('a resumed generation numbers its attempts afresh', async () => {
    await executeRun()
    await record(EXEC, [verify('v1', 'G1', 1), verdict('v1', false), verify('v2', 'G1', 2), verdict('v2', false), end(1, 'halted'), launch(2)])
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · execute ${EXEC} · gate 1/3 · <1m`])
    expect(band()!.rows[0]!.key).toBe(`run:${EXEC}:2:open`)
  })

  test('a repair generation: its swarm in place of the progress', async () => {
    await executeRun()
    await record(EXEC, [end(1, 'halted')])
    p.clock.now = NOW + 3 * MIN
    await record(EXEC, [{ kind: 'run.repair', body: { generation: 2, swarm: 'fix-g1', launch: '20261005-120000', budget: { rounds: 2, agents: 4 } } }])
    p.clock.now = NOW + 9 * MIN
    await bandTick(p)
    // The mark says repairing; the swarm is in the running color.
    expect(texts()).toEqual([`↻ repairing · litter · execute ${EXEC} · repair swarm fix-g1 · 6m`])
    expect(band()!.rows[0]!.spans.find(s => s.text === 'repair swarm fix-g1')?.color).toBe('background')
  })

  test('a stopping run says so', async () => {
    await executeRun()
    await record(EXEC, [{ kind: 'run.stopping', body: { taskId: 't1', generation: 1 } }])
    await bandTick(p)
    expect(texts()).toEqual([`! stopping · litter · execute ${EXEC} · gate 1/3 · <1m`])
    expect(band()!.rows[0]!.spans[0]).toEqual({ text: '! stopping', color: 'warning' })
  })
})

describe('the other workflows', () => {
  test('design: the latest version, awaiting the critic, then its pass count', async () => {
    writeRunJson(DESIGN, 'design', {})
    await record(DESIGN, [start('design'), launch()])
    writePolicy(DESIGN)
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · design ${DESIGN} · no proposal yet · <1m`])
    await record(DESIGN, [{ kind: 'proposal', body: { text: 'x', version: 'v1', sha256: 'f'.repeat(64) } }])
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · design ${DESIGN} · v1 · awaiting the critic · <1m`])
    // A dim span is the muted role when drawn (render.tsx); the view keeps the flag.
    expect(band()!.rows[0]!.spans.find(s => s.text === 'awaiting the critic')).toEqual({ text: 'awaiting the critic', dim: true })
    const crit = (id: string, verdict: string) => ({ id, verdict, evidence: 'e', ...(verdict === 'PASS' ? {} : { gap_kind: 'design' }) })
    await record(DESIGN, [{ kind: 'verdict', body: { version: 'v1', criteria: [crit('C1', 'PASS'), crit('C2', 'FAIL'), crit('B1', 'PASS')], overall: 'HOLDING', sha256: null } }])
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · design ${DESIGN} · v1 · 2/3 pass · <1m`])
    // A design verdict isn't an execute one: it never reads as a gate retry.
    await record(DESIGN, [{ kind: 'proposal', body: { text: 'y', version: 'v2', sha256: 'e'.repeat(64) } }])
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · design ${DESIGN} · v2 · awaiting the critic · <1m`])
  })

  test('fanout: the tasks with a result, then integrating, verifying and landing', async () => {
    writeRunJson(FAN, 'fanout', { tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
    await record(FAN, [start('fanout'), launch()])
    writePolicy(FAN)
    const result = (task: string): Rec => ({ kind: 'task.result', body: { task, role: 'executor', tool_use_id: `tu-${task}`, result: {} } })
    await record(FAN, [result('a'), result('b')])
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · fanout ${FAN} · 2/3 tasks · <1m`])
    await record(FAN, [result('c'), { kind: 'integrate.merge', body: { task: 'a', branch: 'litter/x-w1', commit: 'b'.repeat(40), paths: [] } }])
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · fanout ${FAN} · 3/3 tasks · integrating · <1m`])
    await record(FAN, [{ kind: 'integrate.done', body: { tip: 'b'.repeat(40), tree: 'c'.repeat(40), changed: [], blocked: [] } }])
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · fanout ${FAN} · 3/3 tasks · verifying · <1m`])
    await record(FAN, [{ kind: 'land.intent', body: { gate: 'fanout', verify_id: 'v9', commit: 'b'.repeat(40) } }])
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · fanout ${FAN} · 3/3 tasks · landing · <1m`])
  })

  test('plan: the record count', async () => {
    writeRunJson(PLAN, 'plan', {})
    await record(PLAN, [start('plan'), launch(), { kind: 'finding', body: { text: 'x' } }])
    writePolicy(PLAN)
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · plan ${PLAN} · 3 records · <1m`])
  })
})

describe('a run that ended', () => {
  test('keeps one row with its outcome for 10 minutes, then has none', async () => {
    await executeRun()
    await bandTick(p)
    expect(texts()).toHaveLength(1)
    p.clock.now = NOW + 30 * MIN
    await record(EXEC, [verify('v1', 'G1', 1), verdict('v1', true), land('G1', 'v1'), verify('v2', 'G2', 1), verdict('v2', true), land('G2', 'v2')])
    await record(EXEC, [verify('v3', 'G3', 1), verdict('v3', true), land('G3', 'v3'), end(1, 'done')])
    writePolicy(null)
    p.clock.now = NOW + 31 * MIN
    await bandTick(p)
    const row = band()!.rows[0]!
    expect(text(row)).toBe(`✓ done · litter · execute ${EXEC} · 3/3 landed · 30m`)
    expect(row.kind).toBe('ended')
    expect(row.spans[0]).toEqual({ text: '✓ done', color: 'success' })
    expect(row.buttons.map(b => b.key)).toEqual([`band:board:${EXEC}`, `band:hide:run:${EXEC}:1:done`])
    p.clock.now = NOW + 30 * MIN + ENDED_MS - 1
    await bandTick(p)
    expect(texts()).toHaveLength(1)
    p.clock.now = NOW + 30 * MIN + ENDED_MS
    await bandTick(p)
    expect(band()!.rows).toEqual([])
  })

  test('a halted run names its gate; only the newest end has a row', async () => {
    await executeRun()
    await bandTick(p)
    await record(EXEC, [verify('v1', 'G1', 1), verdict('v1', true), land('G1', 'v1'), end(1, 'halted')])
    writeRunJson(FAN, 'fanout', { tasks: [{ id: 'a' }] })
    p.clock.now = NOW + MIN
    await record(FAN, [start('fanout'), launch()])
    writePolicy(FAN)
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · fanout ${FAN} · 0/1 tasks · <1m`, `⚑ halted · litter · execute ${EXEC} · at G2 · <1m`])
    expect(band()!.rows[1]!.spans[0]).toEqual({ text: '⚑ halted', color: 'warning' })
    p.clock.now = NOW + 2 * MIN
    await record(FAN, [end(1, 'failed')])
    writePolicy(null)
    await bandTick(p)
    expect(texts()).toEqual([`✕ failed · litter · fanout ${FAN} · 0/1 tasks · 1m`])
  })

  test('a 1-minute bandEndedMinutes keeps the row at 30 s and drops it at 61 s, by the fake clock', async () => {
    setOptions({ bandEndedMinutes: 1 })
    await executeRun()
    await bandTick(p)
    await record(EXEC, [end(1, 'failed')])
    writePolicy(null)
    p.clock.now = NOW + 30_000
    await bandTick(p)
    expect(texts()).toEqual([`✕ failed · litter · execute ${EXEC} · <1m`])
    p.clock.now = NOW + 61_000
    await bandTick(p)
    expect(band()!.rows).toEqual([])
  })

  test('a bandEndedMinutes of 0 keeps no ended row: the open run has its row, and nothing once it ends', async () => {
    setOptions({ bandEndedMinutes: 0 })
    await executeRun()
    await bandTick(p)
    expect(texts()).toEqual([`▸ running · litter · execute ${EXEC} · gate 1/3 · <1m`])
    await record(EXEC, [end(1, 'done')])
    writePolicy(null)
    await bandTick(p)
    expect(band()!.rows).toEqual([])
    // A module's first build (a reload) seeds the run from its ledger, and still draws no ended row.
    resetBandForTests()
    p.views = {}
    await bandTick(p)
    expect(p.views).toEqual({})
  })

  test("a new module finds a run that just ended from the ledgers that moved last", async () => {
    await executeRun()
    await record(EXEC, [end(1, 'failed')])
    writePolicy(null)
    await bandTick(p)
    expect(texts()).toEqual([`✕ failed · litter · execute ${EXEC} · <1m`])
  })

  test("a launch that never opened a generation ends as launch failed", async () => {
    writeRunJson(EXEC, 'execute', { gates: GATES })
    await record(EXEC, [start('execute')])
    writePolicy(EXEC)
    await bandTick(p)
    // Pending: no generation is open, so no row yet.
    expect(band()).toBeNull()
    await record(EXEC, [end(0, 'launch_failed')])
    writePolicy(null)
    await bandTick(p)
    expect(texts()).toEqual([`✕ launch failed · litter · execute ${EXEC} · <1m`])
  })
})

/** A live swarm with bindings: `running` running, one settling, one asking a question, one idle. */
function liveSwarm(name: string, over: Partial<LiveSwarm> = {}): void {
  const s: LiveSwarm = {
    name,
    launch: '20261005-093000',
    revision: 1,
    spec: { name, goal: 'review', nodes: [{ id: 'lead-a', kind: 'orchestrator' }, { id: 'fixer', kind: 'worker' }] },
    nonce: 'n0nce',
    types: {},
    typesReady: true,
    dirs: {},
    sessionCwd: dir,
    worktreeRoot: dir,
    commonDir: dir,
    roots: { litterDir, litterCopies: [litterDir], ruleDirs: [] },
    tips: {},
    owner: { ref: `refs/litter-swarm/${name}`, oid: 'a'.repeat(40), generation: 1, session: 's1' },
    state: 'live',
    readOnly: false,
    lost: false,
    flags: { isolationLost: false },
    startedAt: NOW - 22 * MIN,
    ...over,
  } as LiveSwarm
  state.putLiveSwarm(s)
}

function bindNode(swarm: string, agentId: string): void {
  const b = { agentId, swarm, launch: '20261005-093000', node: 'fixer', n: 1, kind: 'worker', of: null, parent: null, type: 'litter:sw-x-fixer', cwd: dir, branch: null, token: null, revision: 1, generation: 1, boundAt: NOW, adopted: false } as unknown as NodeBinding
  state.putBinding(b)
}

describe('a live swarm', () => {
  test("its row counts the nodes as the browser does: running or settling, and ⚑ waiting on a question", async () => {
    liveSwarm('review')
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) bindNode('review', id)
    state.markRunning('a1')
    state.markRunning('a2')
    state.markRunning('a3')
    state.markSettling('a3')
    state.markRunning('a4')
    state.noteQuestion('a4', 'which file?', NOW)
    await bandTick(p)
    const row = band()!.rows[0]!
    expect(text(row)).toBe('▸ live · litter · swarm review · 3 running · ⚑ 1 waiting · 22m')
    expect(row.kind).toBe('swarm')
    expect(row.buttons).toEqual([
      { key: 'band:browser:review', label: 'Browser' },
      { key: 'band:hide:swarm:review:20261005-093000', label: 'Hide' },
    ])
    // WP-DB: the running count in the running color, the waiting one the needs-you mark and color.
    expect(row.spans.find(s => s.text === '3 running')?.color).toBe('background')
    expect(row.spans.find(s => s.text === '⚑ 1 waiting')?.color).toBe('permission')
    expect(row.spans.find(s => s.text === 'review')?.color).toBe('cyan_FOR_SUBAGENTS_ONLY')
    expect(row.spans[0]).toEqual({ text: '▸ live', color: 'background' })
  })

  test("a run's repair swarm is shown in the run's row only; a read-only swarm says so, and a count of none isn't said", async () => {
    liveSwarm('fix-g1', { run: { runDir: runDir(litterDir, EXEC), run: EXEC, generation: 2 } } as Partial<LiveSwarm>)
    liveSwarm('other', { readOnly: true })
    await bandTick(p)
    expect(texts()).toEqual(['▸ live · litter · swarm other · 0 running · read-only · 22m'])
  })

  test("the lead's proposals waiting for your review are on the row, and a stopping swarm says so", async () => {
    liveSwarm('review', { state: 'stopping' } as Partial<LiveSwarm>)
    noteProposal('review', 3)
    noteProposal('review', 4)
    try {
      await bandTick(p)
      expect(texts()).toEqual(['! stopping · litter · swarm review · 0 running · ⚑ 2 proposals · 22m'])
      expect(band()!.rows[0]!.spans.find(s => s.text === '⚑ 2 proposals')?.color).toBe('permission')
      expect(bandLines()[0]!.needsYou).toBe(true)
    } finally {
      resetViewForTests()
    }
  })
})

describe('the lines Home reads (WP-DB)', () => {
  /** Two runs end inside the window, a minute apart: an execute run halted at G2, then a fanout run failed. */
  async function twoEnded(): Promise<void> {
    await executeRun()
    await bandTick(p)
    await record(EXEC, [verify('v1', 'G1', 1), verdict('v1', true), land('G1', 'v1'), end(1, 'halted')])
    writeRunJson(FAN, 'fanout', { tasks: [{ id: 'a' }] })
    p.clock.now = NOW + MIN
    await record(FAN, [start('fanout'), launch()])
    writePolicy(FAN)
    await bandTick(p)
    p.clock.now = NOW + 2 * MIN
    await record(FAN, [end(1, 'failed')])
    writePolicy(null)
    await bandTick(p)
  }

  test('bandLines holds every run that ended inside the window, newest first, and the rows [Hide] hid; the band draws the newest end alone', async () => {
    await twoEnded()
    expect(texts()).toEqual([`✕ failed · litter · fanout ${FAN} · 0/1 tasks · 1m`])
    expect(bandLines().map(l => [l.kind, l.name, `${l.mark.glyph} ${l.mark.word}`, l.needsYou])).toEqual([
      ['ended', FAN, '✕ failed', false],
      ['ended', EXEC, '⚑ halted', true],
    ])
    await press(`band:hide:run:${FAN}:1:failed`)
    expect(band()!.rows).toEqual([])
    expect(bandLines()).toHaveLength(2)
    // The strip counts what the build holds, [Hide] or not.
    expect(bandCounts()).toEqual({ runs: 0, ended: 2 })
  })

  test("writeHub words the built lines into Home: the halted run under needs you, the failed one under ended, the swarm's question and its row", async () => {
    await twoEnded()
    liveSwarm('review')
    bindNode('review', 'a4')
    state.markRunning('a4')
    state.noteQuestion('a4', 'which file?', NOW)
    await bandTick(p)
    // Nothing built by the other sections in this spec.
    hubDeps.rulesCounts = () => null
    hubDeps.tasksShown = () => null
    await writeHub(p)
    const hub = p.views.hub as HubView
    const words = (rows: { spans: SwarmSpan[] }[]) => rows.map(r => r.spans.map(s => s.text).join(''))
    // The question's [Open] lands on the node that asks.
    expect(hub.home!.needsYou.map(r => r.open)).toEqual(['home:open:swarms:review a4', `home:open:runs:${EXEC}`])
    expect(words(hub.home!.needsYou)).toEqual(['fixer asks: which file?', `execute ${EXEC} · halted at G2 · <1m`])
    expect(words(hub.home!.running)).toEqual(['swarm review · 0 running · ⚑ 1 waiting · 24m'])
    expect(hub.home!.running[0]!.mark).toEqual({ glyph: '▸', word: 'live', color: 'background' })
    expect(words(hub.home!.ended)).toEqual([`fanout ${FAN} · 0/1 tasks · 1m`])
    expect(hub.home!.ended[0]!.mark).toEqual({ glyph: '✕', word: 'failed', color: 'error' })
    expect(hub.home!.endedMinutes).toBe(10)
    expect(hub.live.map(s => s.text).join('')).toBe('▸ running: 1 swarm · ⚑ needs you: 1 question, 1 run')
  })
})

describe('an open ask (WP-CK)', () => {
  /** guard.sh's call start, then ask.sh's line for it, as the drain hands them over. */
  const askLines = (agent: string, detail: string, toolUseId: string): SpoolLine[] => [
    { v: 1, ev: 'call', ts: NOW / 1000, session_id: 's1', agent_id: agent, agent_type: 'litter:executor', tool: 'Bash', tool_use_id: toolUseId, phase: 'start', detail } as SpoolLine,
    { v: 1, ev: 'ask', ts: NOW / 1000, session_id: 's1', agent_id: agent, agent_type: 'litter:executor', tool: 'Bash', detail, mode: 'default' } as SpoolLine,
  ]

  test('has no row in the band, alone or beside a run and a swarm: its line is the transcript row asks.ts writes', async () => {
    for (const line of [...askLines('a1', 'pwd', 'toolu_1'), ...askLines('a2', 'npm install', 'toolu_2')]) await consumeAsks({ p, litterDir, sessionId: 's1' }, line)
    expect(openAsks()).toHaveLength(2)
    await bandTick(p)
    // Nothing but the asks: no band at all.
    expect(band()).toBeNull()
    await executeRun()
    liveSwarm('review')
    await bandTick(p)
    await asksTick(p)
    await bandTick(p)
    expect(band()!.rows.map(r => r.kind)).toEqual(['run', 'swarm'])
    expect(texts().some(t => t.includes('asking'))).toBe(false)
    expect(p.notes).toEqual([
      '⚑ asking · executor wants Bash: pwd · authorized: writes in the checkout',
      '⚑ asking · executor wants Bash: npm install · authorized: writes in the checkout',
    ])
  })
})

describe('[Hide]', () => {
  test("hides its row until the run's state changes, mirrored in $.store for this session", async () => {
    await executeRun()
    await bandTick(p)
    expect(await press(`band:hide:run:${EXEC}:1:open`)).toEqual({ element: `band:hide:run:${EXEC}:1:open` })
    expect(band()!.rows).toEqual([])
    expect(p.storeMap.get(BAND_STORE_KEY)).toEqual({ v: 1, session: 's1', hidden: [`run:${EXEC}:1:open`] })
    // A module reset (a hot reload) reads it back for the same session.
    resetBandForTests()
    await refreshBand(p)
    expect(band()!.rows).toEqual([])
    expect(hiddenKeys()).toEqual([`run:${EXEC}:1:open`])
    // The run ends: a new state, so its row is back.
    await record(EXEC, [end(1, 'failed')])
    writePolicy(null)
    await bandTick(p)
    expect(texts()).toEqual([`✕ failed · litter · execute ${EXEC} · <1m`])
  })

  test("another session's hidden keys are ignored", async () => {
    p.storeMap.set(BAND_STORE_KEY, { v: 1, session: 'someone-else', hidden: [`run:${EXEC}:1:open`] })
    await executeRun()
    await bandTick(p)
    expect(texts()).toHaveLength(1)
    expect(hiddenKeys()).toEqual([])
  })

  test("a swarm's row stays hidden until the swarm ends", async () => {
    liveSwarm('review')
    await bandTick(p)
    await press('band:hide:swarm:review:20261005-093000')
    expect(band()!.rows).toEqual([])
    state.dropLiveSwarm('review')
    liveSwarm('review', { launch: '20261005-140000' })
    await bandTick(p)
    expect(band()!.rows.map(r => r.key)).toEqual(['swarm:review:20261005-140000'])
  })
})

describe('the write check', () => {
  test('no write when nothing moved; a write when the minute changed; v rises with each', async () => {
    await executeRun()
    await bandTick(p)
    const first = band()!
    p.views = {}
    await bandTick(p)
    p.clock.now = NOW + 30_000
    await bandTick(p)
    expect(p.views).toEqual({})
    p.clock.now = NOW + MIN
    await bandTick(p)
    expect(band()!.v).toBe(first.v + 1)
    expect(texts()).toEqual([`▸ running · litter · execute ${EXEC} · gate 1/3 · 1m`])
  })

  test('nothing to show writes nothing; refreshBand writes even an unchanged view', async () => {
    await bandTick(p)
    expect(p.views).toEqual({})
    await executeRun()
    await bandTick(p)
    const v = band()!.v
    p.views = {}
    await refreshBand(p)
    expect(band()!.v).toBe(v)
    expect(texts()).toHaveLength(1)
  })

  test('a quiet tick reads no ledger: the head in $.store and the minute stand', async () => {
    await executeRun()
    await bandTick(p)
    const reads: string[] = []
    const read = p.fs.read
    p.fs.read = async path => (reads.push(path), read(path))
    await bandTick(p)
    expect(reads.filter(r => r.includes('/ledger/'))).toEqual([])
    await record(EXEC, [verify('v1', 'G1', 1)])
    reads.length = 0
    await bandTick(p)
    expect(reads.some(r => r.includes('/ledger/'))).toBe(true)
  })
})

describe('the failure paths', () => {
  test("a missing litter directory gives no row and one log line, never a throw", async () => {
    rmSync(litterDir, { recursive: true, force: true })
    await bandTick(p)
    await bandTick(p)
    expect(p.views).toEqual({})
    expect(p.logs).toEqual([`band: ${litterDir} isn't there, so no run has a row`])
  })

  test("a policy.json that isn't JSON gives the active run no row, said once", async () => {
    await executeRun()
    writeFileSync(policyPath(litterDir), '{ not json')
    resetBandForTests()
    p.clock.now = NOW + 20 * MIN
    await bandTick(p)
    await bandTick(p)
    expect(p.logs.filter(l => l.startsWith('band: policy.json'))).toHaveLength(1)
    // The ledgers that moved last are still read: the run is open, so it has its row.
    expect(texts()).toEqual([`▸ running · litter · execute ${EXEC} · gate 1/3 · 20m`])
  })

  test("an unreadable ledger gives no row and one log line, never a throw", async () => {
    await executeRun()
    rmSync(ledgerDir(runDir(litterDir, EXEC)), { recursive: true, force: true })
    writeFileSync(ledgerDir(runDir(litterDir, EXEC)), 'not a folder')
    await bandTick(p)
    p.clock.now = NOW + 2 * MIN
    await bandTick(p)
    expect(p.views).toEqual({})
    expect(p.logs.filter(l => l.includes("ledger can't be read"))).toHaveLength(1)
    expect(p.logs[0]).toStartWith(`band: run ${EXEC}'s ledger can't be read, so it has no row: `)
  })

  test('no litter directory resolved: the swarms still draw', async () => {
    updateSession({ litterDir: null })
    liveSwarm('review')
    await bandTick(p)
    expect(texts()).toEqual(['▸ live · litter · swarm review · 0 running · 22m'])
  })
})

describe('the presses', () => {
  test('[Board] opens the board on its run; [Browser] the swarm pane on its swarm', async () => {
    await executeRun()
    liveSwarm('review')
    await bandTick(p)
    expect(await press(`band:board:${EXEC}`)).toEqual({ element: `band:board:${EXEC}` })
    expect(await press('band:browser:review')).toEqual({ element: 'band:browser:review' })
    expect(boards).toEqual([EXEC])
    expect(browsers).toEqual(['review'])
    expect(p.toasts).toEqual([])
  })

  test("a board that can't be drawn, or a pane that refuses, says so in a toast", async () => {
    await executeRun()
    liveSwarm('review')
    await bandTick(p)
    boardOpen = async () => false
    browserOpen = async () => ({ placed: false, text: "Swarms shows review, live (open, but this screen can't draw it now)" })
    await press(`band:board:${EXEC}`)
    await press('band:browser:review')
    expect(p.toasts).toEqual([`the board can't be drawn here now: run /litter runs ${EXEC}`, "Swarms shows review, live (open, but this screen can't draw it now)"])
    // An open that throws on Runs is the same toast, its reason logged.
    boardOpen = async () => {
      throw new Error('ui.open refused')
    }
    await press(`band:board:${EXEC}`)
    expect(p.toasts.at(-1)).toBe(`the board can't be drawn here now: run /litter runs ${EXEC}`)
    expect(p.logs).toContain(`band: Runs didn't open on run ${EXEC}: ui.open refused`)
  })

  test('a press for a row the band no longer shows is ignored with a toast', async () => {
    await executeRun()
    await bandTick(p)
    expect(await press('band:board:20261001-gone')).toEqual({ element: 'band:board:20261001-gone' })
    expect(await press('band:browser:gone')).toEqual({ element: 'band:browser:gone' })
    expect(await press('band:hide:run:20261001-gone:1:open')).toEqual({ element: 'band:hide:run:20261001-gone:1:open' })
    expect(boards).toEqual([])
    expect(browsers).toEqual([])
    expect(hiddenKeys()).toEqual([])
    expect(p.toasts).toEqual([
      "the band doesn't show run 20261001-gone now, so that was ignored",
      "the band doesn't show swarm gone now, so that was ignored",
      "the band doesn't show run 20261001-gone now, so that was ignored",
    ])
  })

  test("another plugin's button, and a key that isn't the band's, pass on", async () => {
    await executeRun()
    await bandTick(p)
    expect(await press(`band:board:${EXEC}`, 'other-plugin')).toEqual({ element: `passed band:board:${EXEC}` })
    expect(await press('board:plan')).toEqual({ element: 'passed board:plan' })
    expect(boards).toEqual([])
  })

  test('a press that throws answers its element, logs and toasts', async () => {
    liveSwarm('review')
    await bandTick(p)
    browserOpen = async () => {
      throw new Error('pane refused')
    }
    expect(await press('band:browser:review')).toEqual({ element: 'band:browser:review' })
    expect(p.logs).toContain('band: band:browser:review failed: pane refused')
    expect(p.toasts).toEqual(["that didn't work (pane refused); claude --debug has the details"])
    // An error worded for the model, as litter's and the engine's are, loses its prefix in the toast; the log keeps it whole.
    browserOpen = async () => {
      throw new Error('litter: $.ui.open refused')
    }
    await press('band:browser:review')
    expect(p.toasts.at(-1)).toBe("that didn't work ($.ui.open refused); claude --debug has the details")
    expect(p.logs).toContain('band: band:browser:review failed: litter: $.ui.open refused')
  })

  test("[Browser]'s check of the opener's reply holds for the real one: `litter` opens on Swarms with the keyboard, and no toast", async () => {
    liveSwarm('review')
    await bandTick(p)
    deps.openSection = defaultOpenSection
    expect(await press('band:browser:review')).toEqual({ element: 'band:browser:review' })
    expect(p.panes.opened).toEqual([{ id: 'litter', title: 'litter', focus: true }])
    expect(shownSection()).toBe('swarms')
    expect(p.toasts).toEqual([])
  })
})

describe('bandShows, and the fitting the render draws', () => {
  const props = (over: Record<string, unknown> = {}) => ({ props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 95, ...over } }) as never
  const row = (key: string, kind: BandRow['kind'], buttons = 0): BandRow => ({
    key,
    kind,
    spans: [{ text: key }],
    buttons: Array.from({ length: buttons }, (_, i) => ({ key: `band:b${i}:${key}`, label: i === 0 ? 'Board' : 'Hide' })),
  })

  test('bandShows: false under a survey, for no view and for a view with no rows', () => {
    const view: BandView = { view: 'band', v: 1, rows: [row('run:r', 'run', 2)] }
    expect(bandShows(view, props())).toBe(true)
    expect(bandShows(view, props({ hasSurvey: true }))).toBe(false)
    expect(bandShows(null, props())).toBe(false)
    expect(bandShows({ view: 'band', v: 2, rows: [] }, props())).toBe(false)
  })

  test('fitRows: the swarms fold into one `+k more` row; the runs are kept', () => {
    const rows = [row('run:a', 'run'), row('run:b', 'ended'), row('swarm:x', 'swarm'), row('swarm:y', 'swarm'), row('swarm:z', 'swarm')]
    const view: BandView = { view: 'band', v: 1, rows }
    expect(fitRows(view, 10)).toBe(rows)
    expect(fitRows(view, 5)).toBe(rows)
    expect(fitRows(view, 4).map(text)).toEqual(['run:a', 'run:b', 'swarm:x', '+2 more swarms'])
    expect(fitRows(view, 4).at(-1)).toEqual({ key: 'more', kind: 'more', spans: [{ text: '+2 more swarms', dim: true }], buttons: [] })
    expect(fitRows(view, 3).map(text)).toEqual(['run:a', 'run:b', '+3 more swarms'])
    expect(fitRows(view, 2).map(text)).toEqual(['run:a', 'run:b'])
    expect(fitRows(view, 1).map(text)).toEqual(['run:a'])
    // A kindless row is kept whole, as a run's.
    expect(fitRows({ view: 'band', v: 1, rows: [row('k', undefined), row('swarm:x', 'swarm'), row('swarm:y', 'swarm')] }, 2).map(text)).toEqual(['k', '+2 more swarms'])
  })

  test('fitSpans: the text cut to the room the buttons leave, never the buttons', () => {
    const spans: SwarmSpan[] = [{ text: '▸', color: 'background' }, { text: ' litter · execute ' }, { text: EXEC, color: 'cyan' }, { text: ' · gate 3/7' }]
    const buttons = [
      { key: 'band:board:r', label: 'Board' },
      { key: 'band:hide:r', label: 'Hide' },
    ]
    // `[ Board ]` and `[ Hide ]`, each with the cell before it.
    expect(roomFor(buttons, 60)).toBe(60 - 10 - 9)
    expect(fitSpans(spans, 100)).toEqual(spans)
    expect(fitSpans(spans, 20)).toEqual([{ text: '▸', color: 'background' }, { text: ' litter · execute ' }, { text: '…', color: 'cyan' }])
    expect(fitSpans(spans, 25).map(s => s.text).join('')).toBe('▸ litter · execute 20261…')
    expect(fitSpans(spans, 0)).toEqual([])
    expect(roomFor(buttons, 12)).toBe(0)
    // Wide characters take two cells.
    expect(fitSpans([{ text: '漢字漢字' }], 5)).toEqual([{ text: '漢字…' }])
  })

  test('elapsed is in whole minutes', () => {
    expect([0, 59_999, MIN, 14 * MIN + 59_000, 125 * MIN].map(elapsed)).toEqual(['<1m', '<1m', '1m', '14m', '2h 05m'])
  })
})
