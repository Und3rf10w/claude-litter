// Tier 2: the band's view (hooks/band/view.ts; WP-CB, COMMON decision 7) from
// ledgers the real ledgercore writes under a scratch litter directory, and a
// policy.json written beside them. Each workflow's row (execute on its first
// gate, on a retry, critiquing, landing; design before and after a verdict;
// fanout integrating; plan; a repair generation), an ended run's row inside
// and past 10 minutes, a live swarm's counts, the open asks (CF's, through
// `deps`), [Hide] and its $.store mirror, the write check, the failure paths
// (a missing litter directory, an unreadable policy.json or ledger), the
// presses, and the fitting the render draws from (fitRows, fitSpans).

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BandPressHook } from '../../hooks/hooktypes'
import type { LiveSwarm, NodeBinding } from '../../hooks/swarm/types'
import type { AskEntry } from '../../hooks/uitypes'
import type { BandRow, BandView, SwarmSpan } from '../../types/index'
import { appendRecord } from '../../hooks/ledgercore'
import { ledgerDir, policyPath, runDir, runJsonPath } from '../../hooks/layout'
import { updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import { MOD } from '../../hooks/verify'
import {
  ASK_ROWS,
  BAND_STORE_KEY,
  ENDED_MS,
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
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

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
let asks: AskEntry[]
let boards: string[]
let browsers: string[]

beforeEach(() => {
  resetBandForTests()
  state.resetForTests()
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ sessionId: 's1', cwd: dir })
  p.clock.now = NOW
  litterDir = join(dir, '.claude', 'litter')
  mkdirSync(join(litterDir, 'hooks'), { recursive: true })
  updateSession({ litterDir })
  asks = []
  boards = []
  browsers = []
  deps.openAsks = () => asks
  deps.openBoard = async (_p, run) => (boards.push(run), true)
  deps.openSwarmPane = async (_p, name) => (browsers.push(name), `litter: the swarm pane shows swarm ${name}`)
})

afterEach(() => {
  resetBandForTests()
  state.resetForTests()
  updateSession({ litterDir: null })
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
    expect(text(rows[0])).toBe(`▸ litter · execute ${EXEC} · gate 1/3 · 14m`)
    expect(rows[0]!.kind).toBe('run')
    expect(rows[0]!.key).toBe(`run:${EXEC}:1:open`)
    expect(rows[0]!.buttons).toEqual([
      { key: `band:board:${EXEC}`, label: 'Board' },
      { key: `band:hide:run:${EXEC}:1:open`, label: 'Hide' },
    ])
    // The colors: the glyph its RUN_STATUS color, the run id cyan, the elapsed time dim.
    const spans = rows[0]!.spans
    expect(spans[0]).toEqual({ text: '▸', color: 'background' })
    expect(spans.find(s => s.text === EXEC)?.color).toBe('cyan')
    expect(spans.at(-1)).toEqual({ text: '14m', dim: true })
  })

  test('on a retry: the gate and its retry count, in warning', async () => {
    await executeRun()
    await record(EXEC, [verify('v1', 'G1', 1), verdict('v1', false)])
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · execute ${EXEC} · gate 1/3 · G1 retry 1 · <1m`])
    expect(band()!.rows[0]!.spans.find(s => s.text === 'retry 1')?.color).toBe('warning')
    // G1 lands on its second attempt; G2 is on its third.
    await record(EXEC, [verify('v2', 'G1', 2), verdict('v2', true), land('G1', 'v2'), verify('v3', 'G2', 1), verdict('v3', false), verify('v4', 'G2', 2), verdict('v4', false)])
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · execute ${EXEC} · gate 2/3 · G2 retry 2 · <1m`])
    // The critic's verify of the third attempt is in: still the third.
    await record(EXEC, [verify('v5', 'G2', 3)])
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · execute ${EXEC} · gate 2/3 · G2 retry 2 · <1m`])
  })

  test('critiquing and landing, from the in-flight flag', async () => {
    await executeRun()
    writePolicy(EXEC, 'critique')
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · execute ${EXEC} · gate 1/3 · G1 critic · <1m`])
    await record(EXEC, [verify('v1', 'G1', 1), verdict('v1', false), verify('v2', 'G1', 2)])
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · execute ${EXEC} · gate 1/3 · G1 retry 1 critic · <1m`])
    writePolicy(EXEC, 'land')
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · execute ${EXEC} · gate 1/3 · landing G1 · <1m`])
    writePolicy(EXEC, null)
    await record(EXEC, [verdict('v2', true), land('G1', 'v2')])
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · execute ${EXEC} · gate 2/3 · <1m`])
  })

  test('a resumed generation numbers its attempts afresh', async () => {
    await executeRun()
    await record(EXEC, [verify('v1', 'G1', 1), verdict('v1', false), verify('v2', 'G1', 2), verdict('v2', false), end(1, 'halted'), launch(2)])
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · execute ${EXEC} · gate 1/3 · <1m`])
    expect(band()!.rows[0]!.key).toBe(`run:${EXEC}:2:open`)
  })

  test('a repair generation: its swarm in place of the progress', async () => {
    await executeRun()
    await record(EXEC, [end(1, 'halted')])
    p.clock.now = NOW + 3 * MIN
    await record(EXEC, [{ kind: 'run.repair', body: { generation: 2, swarm: 'fix-g1', launch: '20261005-120000', budget: { rounds: 2, agents: 4 } } }])
    p.clock.now = NOW + 9 * MIN
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · execute ${EXEC} · ↻ repair swarm fix-g1 · 6m`])
  })

  test('a stopping run says so', async () => {
    await executeRun()
    await record(EXEC, [{ kind: 'run.stopping', body: { taskId: 't1', generation: 1 } }])
    await bandTick(p)
    expect(texts()).toEqual([`! litter · execute ${EXEC} · gate 1/3 · stopping · <1m`])
    expect(band()!.rows[0]!.spans[0]).toEqual({ text: '!', color: 'warning' })
  })
})

describe('the other workflows', () => {
  test('design: the latest version, awaiting the critic, then its pass count', async () => {
    writeRunJson(DESIGN, 'design', {})
    await record(DESIGN, [start('design'), launch()])
    writePolicy(DESIGN)
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · design ${DESIGN} · no proposal yet · <1m`])
    await record(DESIGN, [{ kind: 'proposal', body: { text: 'x', version: 'v1', sha256: 'f'.repeat(64) } }])
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · design ${DESIGN} · v1 · awaiting the critic · <1m`])
    const crit = (id: string, verdict: string) => ({ id, verdict, evidence: 'e', ...(verdict === 'PASS' ? {} : { gap_kind: 'design' }) })
    await record(DESIGN, [{ kind: 'verdict', body: { version: 'v1', criteria: [crit('C1', 'PASS'), crit('C2', 'FAIL'), crit('B1', 'PASS')], overall: 'HOLDING', sha256: null } }])
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · design ${DESIGN} · v1 · 2/3 pass · <1m`])
    // A design verdict isn't an execute one: it never reads as a gate retry.
    await record(DESIGN, [{ kind: 'proposal', body: { text: 'y', version: 'v2', sha256: 'e'.repeat(64) } }])
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · design ${DESIGN} · v2 · awaiting the critic · <1m`])
  })

  test('fanout: the tasks with a result, then integrating, verifying and landing', async () => {
    writeRunJson(FAN, 'fanout', { tasks: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
    await record(FAN, [start('fanout'), launch()])
    writePolicy(FAN)
    const result = (task: string): Rec => ({ kind: 'task.result', body: { task, role: 'executor', tool_use_id: `tu-${task}`, result: {} } })
    await record(FAN, [result('a'), result('b')])
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · fanout ${FAN} · 2/3 tasks · <1m`])
    await record(FAN, [result('c'), { kind: 'integrate.merge', body: { task: 'a', branch: 'litter/x-w1', commit: 'b'.repeat(40), paths: [] } }])
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · fanout ${FAN} · 3/3 tasks · integrating · <1m`])
    await record(FAN, [{ kind: 'integrate.done', body: { tip: 'b'.repeat(40), tree: 'c'.repeat(40), changed: [], blocked: [] } }])
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · fanout ${FAN} · 3/3 tasks · verifying · <1m`])
    await record(FAN, [{ kind: 'land.intent', body: { gate: 'fanout', verify_id: 'v9', commit: 'b'.repeat(40) } }])
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · fanout ${FAN} · 3/3 tasks · landing · <1m`])
  })

  test('plan: the record count', async () => {
    writeRunJson(PLAN, 'plan', {})
    await record(PLAN, [start('plan'), launch(), { kind: 'finding', body: { text: 'x' } }])
    writePolicy(PLAN)
    await bandTick(p)
    expect(texts()).toEqual([`▸ litter · plan ${PLAN} · 3 records · <1m`])
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
    expect(text(row)).toBe(`✓ litter · execute ${EXEC} · done · 3/3 landed · 30m`)
    expect(row.kind).toBe('ended')
    expect(row.spans[0]).toEqual({ text: '✓', color: 'success' })
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
    expect(texts()).toEqual([`▸ litter · fanout ${FAN} · 0/1 tasks · <1m`, `⚑ litter · execute ${EXEC} · halted at G2 · <1m`])
    p.clock.now = NOW + 2 * MIN
    await record(FAN, [end(1, 'failed')])
    writePolicy(null)
    await bandTick(p)
    expect(texts()).toEqual([`✕ litter · fanout ${FAN} · failed · 0/1 tasks · 1m`])
  })

  test("a new module finds a run that just ended from the ledgers that moved last", async () => {
    await executeRun()
    await record(EXEC, [end(1, 'failed')])
    writePolicy(null)
    await bandTick(p)
    expect(texts()).toEqual([`✕ litter · execute ${EXEC} · failed · <1m`])
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
    expect(texts()).toEqual([`✕ litter · execute ${EXEC} · launch failed · <1m`])
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
    expect(text(row)).toBe('▸ litter · swarm review · 3 running · 1 waiting · 22m')
    expect(row.kind).toBe('swarm')
    expect(row.buttons).toEqual([
      { key: 'band:browser:review', label: 'Browser' },
      { key: 'band:hide:swarm:review:20261005-093000', label: 'Hide' },
    ])
    expect(row.spans.find(s => s.text === '1 waiting')?.color).toBe('warning')
    expect(row.spans.find(s => s.text === 'review')?.color).toBe('cyan')
  })

  test("a run's repair swarm is shown in the run's row only; a read-only swarm says so", async () => {
    liveSwarm('fix-g1', { run: { runDir: runDir(litterDir, EXEC), run: EXEC, generation: 2 } } as Partial<LiveSwarm>)
    liveSwarm('other', { readOnly: true })
    await bandTick(p)
    expect(texts()).toEqual(['▸ litter · swarm other · 0 running · 0 waiting · read-only · 22m'])
  })
})

describe('the open asks', () => {
  const ask = (n: number, over: Partial<AskEntry> = {}): AskEntry => ({
    key: `a${n}`,
    agentId: `agent-${n}`,
    agentType: 'litter:executor',
    tool: 'Bash',
    detail: `npm install pkg-${n}`,
    toolUseId: null,
    run: EXEC,
    role: 'executor',
    gate: 'G2',
    swarm: null,
    node: null,
    authorized: 'verify npm test, Files lib/** tests/**',
    since: NOW + n,
    ...over,
  })

  test('newest first, at most three, then a `+k more asking` row; who is asking, by kind', async () => {
    asks = [
      ask(1),
      ask(2, { run: null, role: null, gate: null, swarm: 'review', node: 'fixer', agentType: 'litter:sw-review-fixer' }),
      ask(3, { run: null, role: null, gate: null, agentType: 'general-purpose', authorized: '' }),
      ask(4, { detail: '' }),
      ask(5, { detail: 'rm -rf \u001b[31mbuild\u001b[0m\nand more' }),
    ]
    await bandTick(p)
    const rows = band()!.rows
    expect(rows.map(text)).toEqual([
      '⚑ asking · G2 executor wants Bash: rm -rf build and more · authorized: verify npm test, Files lib/** tests/**',
      '⚑ asking · G2 executor wants Bash · authorized: verify npm test, Files lib/** tests/**',
      '⚑ asking · general-purpose wants Bash: npm install pkg-3',
      '+2 more asking',
    ])
    expect(rows.slice(0, ASK_ROWS).every(r => r.kind === 'ask' && r.buttons.length === 0)).toBe(true)
    expect(rows[0]!.spans[0]).toEqual({ text: '⚑ asking', color: 'permission' })
    expect(rows[3]!.kind).toBe('more')
    expect(band()!.asking).toBe(5)
    // The node's ask, once the newer ones close.
    asks = [ask(1), ask(2, { run: null, role: null, gate: null, swarm: 'review', node: 'fixer' })]
    await bandTick(p)
    expect(texts()[0]).toBe('⚑ asking · fixer in swarm review wants Bash: npm install pkg-2 · authorized: verify npm test, Files lib/** tests/**')
  })

  test('come after the runs and the swarms; an openAsks that throws gives none and one log line', async () => {
    await executeRun()
    liveSwarm('review')
    asks = [ask(1)]
    await bandTick(p)
    expect(band()!.rows.map(r => r.kind)).toEqual(['run', 'swarm', 'ask'])
    deps.openAsks = () => {
      throw new Error('not ready')
    }
    await bandTick(p)
    await bandTick(p)
    expect(band()!.rows.map(r => r.kind)).toEqual(['run', 'swarm'])
    expect(p.logs.filter(l => l.includes('open asks'))).toEqual(["band: the open asks can't be read: not ready"])
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
    deps.openAsks = () => asks
    await refreshBand(p)
    expect(band()!.rows).toEqual([])
    expect(hiddenKeys()).toEqual([`run:${EXEC}:1:open`])
    // The run ends: a new state, so its row is back.
    await record(EXEC, [end(1, 'failed')])
    writePolicy(null)
    await bandTick(p)
    expect(texts()).toEqual([`✕ litter · execute ${EXEC} · failed · <1m`])
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
    expect(texts()).toEqual([`▸ litter · execute ${EXEC} · gate 1/3 · 1m`])
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
    deps.openAsks = () => asks
    p.clock.now = NOW + 20 * MIN
    await bandTick(p)
    await bandTick(p)
    expect(p.logs.filter(l => l.startsWith('band: policy.json'))).toHaveLength(1)
    // The ledgers that moved last are still read: the run is open, so it has its row.
    expect(texts()).toEqual([`▸ litter · execute ${EXEC} · gate 1/3 · 20m`])
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

  test('no litter directory resolved: the swarms and the asks still draw', async () => {
    updateSession({ litterDir: null })
    liveSwarm('review')
    await bandTick(p)
    expect(texts()).toEqual(['▸ litter · swarm review · 0 running · 0 waiting · 22m'])
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
    deps.openBoard = async () => false
    deps.openSwarmPane = async () => "litter: the swarm pane shows swarm review (open, but this screen can't draw it now)"
    await press(`band:board:${EXEC}`)
    await press('band:browser:review')
    expect(p.toasts).toEqual([`litter: the board can't be drawn here now: run /litter-board ${EXEC}`, "litter: the swarm pane shows swarm review (open, but this screen can't draw it now)"])
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
      "litter: the band doesn't show run 20261001-gone now, so that was ignored",
      "litter: the band doesn't show swarm gone now, so that was ignored",
      "litter: the band doesn't show run 20261001-gone now, so that was ignored",
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
    await executeRun()
    await bandTick(p)
    deps.openBoard = async () => {
      throw new Error('pane refused')
    }
    expect(await press(`band:board:${EXEC}`)).toEqual({ element: `band:board:${EXEC}` })
    expect(p.logs).toContain(`band: band:board:${EXEC} failed: pane refused`)
    expect(p.toasts).toEqual(["litter: that didn't work (pane refused); claude --debug has the details"])
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

  test('fitRows: the asks fold first, then the swarms; the runs are kept', () => {
    const rows = [row('run:a', 'run'), row('run:b', 'ended'), row('swarm:x', 'swarm'), row('swarm:y', 'swarm'), row('ask:1', 'ask'), row('ask:2', 'ask'), row('ask:3', 'ask'), { ...row('more', 'more'), spans: [{ text: '+2 more asking' }] }]
    const view: BandView = { view: 'band', v: 1, rows, asking: 5 }
    expect(fitRows(view, 10)).toBe(rows)
    expect(fitRows(view, 6).map(r => r.key)).toEqual(['run:a', 'run:b', 'swarm:x', 'swarm:y', 'ask:1', 'more'])
    expect(text(fitRows(view, 6).at(-1))).toBe('+4 more asking')
    expect(fitRows(view, 4).map(text)).toEqual(['run:a', 'run:b', 'swarm:x', '+1 more swarm · +5 more asking'])
    expect(fitRows(view, 3).map(text)).toEqual(['run:a', 'run:b', '+2 more swarms · +5 more asking'])
    expect(fitRows(view, 2).map(text)).toEqual(['run:a', 'run:b'])
    expect(fitRows(view, 1).map(text)).toEqual(['run:a'])
    // A kindless row is kept whole, as a run's.
    expect(fitRows({ view: 'band', v: 1, rows: [row('k', undefined), row('ask:1', 'ask'), row('ask:2', 'ask')], asking: 2 }, 2).map(text)).toEqual(['k', '+2 more asking'])
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
