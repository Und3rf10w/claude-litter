// Tier 2: the board's view (hooks/board/view.ts; WP-AF, decision 21) from
// ledgers the real ledgercore writes in a scratch repository, and the pane's
// handlers (hooks/board/pane.tsx) that move its navigation. Each gate state
// (landed, halted on a plan gap, out of attempts, repairing, in progress,
// waiting), a continuation's earlier lands, the record list of the other
// workflows, a tampered ledger, the rule versions and proposals, the [Diff]
// and [Plan] sections with real git, and the rebuild check. AD's store is a
// stub before the merge: its two reads are stood in for through `deps`.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StoredRecord } from '../../hooks/records/core'
import type { LoadedRule, ProposalRef, RuleDoc, RuleProposeBody, RuleStatus } from '../../hooks/records/rules'
import type { BoardGateRow, BoardView } from '../../types/index'
import { appendRecord } from '../../hooks/ledgercore'
import { ledgerDir, planPath, runDir, runJsonPath, verdictFile, verifyLogDir } from '../../hooks/layout'
import { updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import { MOD } from '../../hooks/verify'
import { blankBoardNav, boardStamp, buildBoard, deps, navOf, recordLine, resetBoardForTests, resolveRun, runStatusOf, setBoardNav, statusWord, utcAt } from '../../hooks/board/view'
import { boardCommand, boardTick, handleBoard, onBoardUi, refreshBoard, resetBoardPaneForTests } from '../../hooks/board/pane'
import { resetRulesPaneForTests } from '../../hooks/rules/pane'
import { resetRulesViewForTests } from '../../hooks/rules/paneview'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const NOW = 1_800_000_000_000
const MIN = 60_000
const EXEC = '20261003-api'
const FAN = '20261002-fan'

let p: TestPorts
let dir: string
let litterDir: string
let cleanup: () => void
let git: (...argv: string[]) => Promise<string>
let base: string
let landed: string
let rulesLoaded: LoadedRule[]
let proposals: { ref: ProposalRef; body: RuleProposeBody; status: RuleStatus }[]
let proposalsAsked: unknown[]
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
  rulesLoaded = []
  proposals = []
  proposalsAsked = []
  deps.loadRules = async () => ({ rules: rulesLoaded, problems: [] })
  deps.proposalsOf = async (_p, _dir, filter) => {
    proposalsAsked.push(filter)
    return proposals
  }
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

/** Each record through ledgercore, one minute apart. */
async function record(run: string, recs: readonly Rec[]): Promise<StoredRecord[]> {
  const out: StoredRecord[] = []
  for (const r of recs) {
    p.clock.now = (p.clock.now ?? NOW) + MIN
    out.push(await appendRecord(p, runDir(litterDir, run), { run, kind: r.kind, by: MOD, body: r.body }))
  }
  return out
}

function writeRunJson(run: string, workflow: string, args: Record<string, unknown>, over: Record<string, unknown> = {}): void {
  const json = {
    v: 1,
    run,
    workflow,
    args,
    authorized: [],
    mode: 'default',
    verify: ['bun', 'test'],
    goalCheck: null,
    setup: null,
    linkDirs: [],
    base,
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

const start = (workflow: string, run: string): Rec => ({
  kind: 'run.start',
  body: { workflow, base, ref: `refs/heads/litter/${run}`, checkout: dir, oid: 'd'.repeat(40), session: 's1' },
})
const launch = (generation = 1): Rec => ({ kind: 'run.launch', body: { taskId: `t${generation}`, runId: `wf_${generation}`, scriptPath: null, generation, session: 's1', oid: 'd'.repeat(40) } })
const end = (generation: number, status: string, reason: string | null = null): Rec => ({ kind: 'run.end', body: { taskId: `t${generation}`, generation, status, reason, source: 'notification' } })
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
const dim = (pass: boolean, evidence: string, gaps: string[] = []) => ({ pass, evidence, gaps })
const verdict = (verifyId: string, over: Record<string, unknown> = {}): Rec => ({
  kind: 'verdict',
  body: {
    verify_id: verifyId,
    plan_adherence: dim(true, 'as planned'),
    tests_green: dim(true, `verify ${verifyId} exit 0`),
    no_regressions: dim(true, 'none'),
    rules: dim(true, 'none apply'),
    plan_gap: '',
    proposed_rules: [],
    ...over,
  },
})
const land = (gate: string, verifyId: string, commit: string, old: string): Rec => ({
  kind: 'land',
  body: { gate, verify_id: verifyId, commit, tree: 'c'.repeat(40), old, ref: `refs/heads/litter/${EXEC}` },
})

const PLAN = [
  '# Plan',
  '',
  '### G1: Parse the header',
  'Files: src/header.ts',
  'Checks: bun test',
  'Done when: the header parses',
  '',
  'Parse it.',
  '',
  '### G2: Retry the refresh once',
  'Files: src/refresh.ts',
  'Checks: bun test',
  'Done when: one retry',
  '',
  'Retry it.',
  '',
  '### G3: Log the retry',
  'Files: src/log.ts',
  'Checks: bun test',
  'Done when: logged',
  '',
  'Log it.',
  '',
].join('\n')

const GATES = [
  { id: 'G1', title: 'Parse the header' },
  { id: 'G2', title: 'Retry the refresh once' },
]

/** G1 landed; G2 halted on a plan gap at its second attempt of three; one critic proposal in the run's own ledger. */
async function haltedRun(): Promise<void> {
  await record(EXEC, [start('execute', EXEC), launch()])
  writeRunJson(EXEC, 'execute', { gates: GATES, maxAttempts: 3 }, { rules: [{ id: 'P-tests-first', version: 2 }, { id: 'P-gone', version: 1 }, { id: 'P-moved', version: 1 }] })
  writeFileSync(planPath(runDir(litterDir, EXEC)), PLAN)
  await record(EXEC, [
    verify('v-g1', 'G1', 1, true),
    verdict('v-g1'),
    land('G1', 'v-g1', landed, base),
    verify('v-g2a', 'G2', 1, false),
    verify('v-g2b', 'G2', 2, false),
    verdict('v-g2b', {
      plan_adherence: dim(false, 'the retry has no backoff', ['backoff missing']),
      tests_green: dim(false, 'verify v-g2b exit 1'),
      plan_gap: 'the plan never says how long to wait between tries',
    }),
    { kind: 'rule.propose', body: { rule: 'Every retry waits with backoff', source: 'critic', gate: 'G2', tool_use_id: 'tu1', index: 0 } },
    { kind: 'rule.propose', body: { rule: 'Name each retry', source: 'agent' } },
    end(1, 'halted', 'G2: a plan gap'),
  ])
}

function doc(id: string, version: number): RuleDoc {
  return {
    id,
    version,
    status: 'accepted',
    type: 'rule',
    applies: { paths: [], when: 'always' },
    export: true,
    extra: [],
    body: { rule: `rule ${id}`, why: '', exceptions: [], howToCheck: [] },
  }
}
const loadedRule = (id: string, version: number, over: Partial<LoadedRule> = {}): LoadedRule => ({
  doc: doc(id, version),
  scope: 'project',
  path: join(dir, '.litter', 'rules', `${id}.md`),
  sha256: 'e'.repeat(64),
  standing: 'accepted',
  delivered: doc(id, version),
  ...over,
})

const rowOf = (view: BoardView, id: string): BoardGateRow => {
  const row = view.body?.gates?.rows.find(r => r.id === id)
  if (!row) throw new Error(`no row ${id}`)
  return row
}
const stateOf = (view: BoardView) => Object.fromEntries((view.body?.gates?.rows ?? []).map(r => [r.id, r.state]))

// ---------------------------------------------------------------------------

describe('the execute gate table', () => {
  test('a landed gate and one halted on a plan gap: states, attempts, failing dimensions, the detail', async () => {
    await haltedRun()
    const view = await buildBoard(p, litterDir, EXEC)
    expect(view.run).toBe(EXEC)
    expect(view.body?.title).toEqual([{ text: 'litter · board', bold: true }, { text: ` · ${EXEC}` }])

    const head = view.body!.header!
    expect(head.workflow).toBe('execute')
    expect(head.status).toEqual({ text: 'halted', color: 'warning', glyph: '⚑' })
    expect(head.generation).toBe(1)
    expect(head.branch).toBe(`litter/${EXEC}`)
    expect(head.base).toBe(base.slice(0, 7))
    expect(head.started).toBe(utcAt(NOW + MIN))
    expect(head.ended).toMatch(/ UTC$/)
    expect(head.tampered).toBeNull()

    const g1 = rowOf(view, 'G1')
    expect(g1).toEqual({
      id: 'G1',
      title: 'Parse the header',
      state: 'landed',
      color: 'success',
      glyph: '✓',
      attempt: 1,
      maxAttempts: 3,
      failing: [],
      verdictFile: null,
      commit: landed.slice(0, 7),
      earlier: null,
    })
    const g2 = rowOf(view, 'G2')
    expect(g2.state).toBe('halted')
    expect([g2.color, g2.glyph]).toEqual(['warning', '⚑'])
    expect([g2.attempt, g2.maxAttempts]).toEqual([2, 3])
    expect(g2.failing).toEqual(['plan_adherence', 'tests_green'])
    expect(g2.commit).toBeNull()

    // The gate being worked is selected first, and its detail shown.
    expect(view.body!.gates!.selected).toBe('G2')
    const d = view.body!.detail!
    expect(d.gate).toBe('G2')
    expect(d.dimensions.map(x => [x.name, x.pass])).toEqual([
      ['plan_adherence', false],
      ['tests_green', false],
      ['no_regressions', true],
      ['rules', true],
    ])
    expect(d.dimensions[0]!.gaps).toEqual(['backoff missing'])
    expect(d.verify).toEqual({ id: 'v-g2b', ended: 'exit 1', log: verifyLogDir(runDir(litterDir, EXEC), 'v-g2b') })
    expect(d.planGap).toBe('the plan never says how long to wait between tries')
    // An execute run lists no records: the table is its view.
    expect(view.body!.records).toEqual([])
    expect(view.body!.buttons.map(b => b.key)).toEqual(['board:plan', 'board:rules'])
  })

  test('a verdict file is named once it is there', async () => {
    await haltedRun()
    const file = verdictFile(runDir(litterDir, EXEC), 'G2', 2)
    await p.fs.write(file, '# G2, attempt 2\n')
    expect(rowOf(await buildBoard(p, litterDir, EXEC), 'G2').verdictFile).toBe(file)
  })

  test('out of attempts: the last attempt counted, the run failed', async () => {
    const run = '20261003-out'
    await record(run, [start('execute', run), launch()])
    writeRunJson(run, 'execute', { gates: [{ id: 'G1', title: 'Parse the header' }], maxAttempts: 3 })
    await record(run, [
      verify('v1', 'G1', 1, false),
      verify('v2', 'G1', 2, false),
      verify('v3', 'G1', 3, false),
      verdict('v3', { tests_green: dim(false, 'exit 1') }),
      end(1, 'failed', 'G1: out of attempts'),
    ])
    const view = await buildBoard(p, litterDir, run)
    expect(view.body!.header!.status).toEqual({ text: 'failed', color: 'error', glyph: '✕' })
    expect(rowOf(view, 'G1')).toEqual(expect.objectContaining({ state: 'halted', attempt: 3, maxAttempts: 3, failing: ['tests_green'] }))
  })

  test('a repair generation open: the run and its unlanded gates are repairing, with the swarm named', async () => {
    const run = '20261003-fix'
    await record(run, [start('execute', run), launch()])
    writeRunJson(run, 'execute', { gates: GATES, maxAttempts: 3 })
    await record(run, [
      verify('v-g1', 'G1', 1, true),
      verdict('v-g1'),
      land('G1', 'v-g1', landed, base),
      verify('v-g2', 'G2', 1, false),
      end(1, 'halted', 'G2: a plan gap'),
      { kind: 'run.repair', body: { generation: 2, swarm: 'repair-0a1b2c', launch: '20261003-120000', budget: { rounds: 3 } } },
    ])
    const view = await buildBoard(p, litterDir, run)
    const head = view.body!.header!
    expect(head.status).toEqual({ text: 'repairing', color: 'background', glyph: '↻' })
    expect(head.repairSwarm).toBe('repair-0a1b2c')
    expect(head.generation).toBe(2)
    expect(head.ended).toBeNull()
    expect(stateOf(view)).toEqual({ G1: 'landed', G2: 'repairing' })
  })

  test('a run going: the first unlanded gate in progress, the rest waiting, in the plan order', async () => {
    const run = '20261003-go'
    await record(run, [start('execute', run), launch()])
    writeRunJson(run, 'execute', { gates: [{ id: 'G3', title: '' }, ...GATES], maxAttempts: 3 })
    writeFileSync(planPath(runDir(litterDir, run)), PLAN)
    await record(run, [verify('v-g1', 'G1', 1, true), verdict('v-g1'), land('G1', 'v-g1', landed, base)])
    const view = await buildBoard(p, litterDir, run)
    expect(view.body!.header!.status).toEqual({ text: 'running', color: 'background', glyph: '▸' })
    // args.gates lists G3 first; the table keeps plan.md's order, and takes G3's title from it.
    expect(view.body!.gates!.rows.map(r => [r.id, r.state, r.title])).toEqual([
      ['G1', 'landed', 'Parse the header'],
      ['G2', 'waiting', 'Retry the refresh once'],
      ['G3', 'in progress', 'Log the retry'],
    ])
  })

  test("a continuation: the chain's earlier lands, named by the run that landed them", async () => {
    const first = '20261001-api'
    await record(first, [start('execute', first), launch()])
    writeRunJson(first, 'execute', { gates: GATES, maxAttempts: 2 })
    await record(first, [verify('v-g1', 'G1', 1, false), verify('v-g1b', 'G1', 2, true), verdict('v-g1b'), land('G1', 'v-g1b', landed, base), end(1, 'halted', 'G2')])

    const cont = '20261003-api2'
    await record(cont, [start('execute', cont), launch()])
    writeRunJson(cont, 'execute', { gates: [GATES[1]], maxAttempts: 3, landed: [{ id: 'G1', commit: landed }] }, { continueOf: first })
    writeFileSync(planPath(runDir(litterDir, cont)), PLAN)

    const view = await buildBoard(p, litterDir, cont)
    expect(rowOf(view, 'G1')).toEqual(expect.objectContaining({ state: 'landed', earlier: first, attempt: 2, maxAttempts: 2, commit: landed.slice(0, 7), title: 'Parse the header' }))
    expect(rowOf(view, 'G2')).toEqual(expect.objectContaining({ state: 'in progress', earlier: null, attempt: 0 }))

    // [Diff G1] of an earlier land: its commit against its parent.
    setBoardNav({ ...blankBoardNav(cont), run: cont, selected: 'G1', section: { kind: 'diff', gate: 'G1' } })
    const diff = (await buildBoard(p, litterDir, cont)).body!.section!
    expect(diff.title).toBe(`G1: git diff --stat ${landed.slice(0, 7)}^ ${landed.slice(0, 7)}`)
    expect(diff.text).toContain('src/header.ts')
  })
})

describe('the other workflows: a record list', () => {
  test('a fanout run: its last 30 records, each in a line', async () => {
    await record(FAN, [start('fanout', FAN), launch()])
    writeRunJson(FAN, 'fanout', { tasks: [{ id: 'a', title: 'A', text: 'do a', writes: true, files: ['a/'] }] })
    const many: Rec[] = []
    for (let i = 1; i <= 30; i++) many.push(verify(`v${i}`, 'integration', i, i % 2 === 0))
    await record(FAN, [...many, { kind: 'verdict', body: { verify_id: 'v30', tasks: [{ id: 'a', pass: true, evidence: 'done', gaps: [] }], combined: 'ok', approved: true } }, end(1, 'done')])
    const view = await buildBoard(p, litterDir, FAN)
    const head = view.body!.header!
    expect([head.workflow, head.status.text, head.status.glyph]).toEqual(['fanout', 'done', '✓'])
    expect(view.body!.gates).toBeNull()
    const rows = view.body!.records
    expect(rows.length).toBe(30)
    // 34 records: the first four aren't listed.
    expect(rows[0]!.seq).toBe(5)
    expect(rows.at(-2)).toEqual({ seq: 33, kind: 'verdict', text: '1 of 1 tasks pass, approved' })
    expect(rows.at(-1)).toEqual({ seq: 34, kind: 'run.end', text: 'generation 1: done' })
    expect(rows.find(r => r.seq === 6)?.text).toBe('integration attempt 4: ✓ green')
    expect(rows.find(r => r.seq === 5)?.text).toBe('integration attempt 3: ✕ exit 1')
  })

  test('a plan run: the header, and records from run.start on', async () => {
    const run = '20261003-plan'
    await record(run, [start('plan', run), launch(), end(1, 'needs_user', 'a question')])
    writeRunJson(run, 'plan', {})
    const view = await buildBoard(p, litterDir, run)
    expect(view.body!.header!.status).toEqual({ text: 'needs_user', color: 'permission', glyph: '⚑' })
    expect(view.body!.records.map(r => r.text)).toEqual([`plan run from ${base.slice(0, 7)} on litter/${run}`, 'generation 1, task t1', 'generation 1: needs_user (a question)'])
  })

  test('recordLine summarizes a land and an unknown kind by its first plain fields', () => {
    const rec = (kind: string, body: Record<string, unknown>) => ({ v: 1, seq: 1, kind, run: EXEC, at: NOW, by: MOD, prev: null, body }) as StoredRecord
    expect(recordLine(rec('land', { gate: 'G1', commit: landed }))).toBe(`G1 landed ${landed.slice(0, 7)}`)
    expect(recordLine(rec('task.note', { task: 'a', count: 2, nested: { x: 1 }, done: true, more: 'x' }))).toBe('task a, count 2, done true')
  })
})

describe("the run's facts beside the table", () => {
  test("rule versions with their standing now, and the run's proposals, each marked", async () => {
    await haltedRun()
    rulesLoaded = [loadedRule('P-tests-first', 2), loadedRule('P-moved', 2)]
    proposals = [
      {
        ref: { store: 'repo', seq: 1 },
        body: { rule: 'Every retry waits with backoff', source: 'critic', gate: 'G2', tool_use_id: 'tu1', index: 0, run: EXEC },
        status: 'proposed',
      },
    ]
    const view = await buildBoard(p, litterDir, EXEC)
    expect(view.body!.rules).toEqual([
      { ref: 'P-tests-first@2', standing: 'accepted', color: 'success' },
      { ref: 'P-gone@1', standing: 'no longer in force', color: 'inactive' },
      { ref: 'P-moved@1', standing: 'in force now as P-moved@2', color: 'warning' },
    ])
    expect(proposalsAsked).toEqual([{ run: EXEC }])
    // The store's proposal, then the run ledger's older one; the critic's own line is the store's, not twice.
    expect(view.body!.proposals).toEqual([
      { text: 'Every retry waits with backoff', source: 'critic', gate: 'G2', label: 'proposed, not accepted' },
      { text: 'Name each retry', source: 'agent', gate: null, label: 'proposed, not accepted' },
    ])
  })

  test("a store that can't be read leaves the rows standing unknown, and the ledger's proposals listed", async () => {
    await haltedRun()
    deps.loadRules = async () => {
      throw new Error('no store yet')
    }
    deps.proposalsOf = async () => {
      throw new Error('no store yet')
    }
    const view = await buildBoard(p, litterDir, EXEC)
    expect(view.body!.rules.map(r => r.standing)).toEqual(Array(3).fill("standing unknown: the rules couldn't be read"))
    expect(view.body!.proposals.map(r => r.text)).toEqual(['Every retry waits with backoff', 'Name each retry'])
  })

  test('a tampered ledger: the status says so, and the header names the record', async () => {
    await haltedRun()
    const ledger = ledgerDir(runDir(litterDir, EXEC))
    // The third record, G1's green verify, made red after the fact.
    const name = readdirSync(ledger).sort()[2]!
    expect(name).toBe('000003-verify.json')
    const path = join(ledger, name)
    writeFileSync(path, readFileSync(path, 'utf8').replace('"green":true', '"green":false'))
    const view = await buildBoard(p, litterDir, EXEC)
    expect(view.body!.header!.status).toEqual({ text: 'ledger_tampered', color: 'error', glyph: '✕' })
    expect(view.body!.header!.tampered).toBe('ledger tampered at 4')
  })

  test('a refused record tool is the notice', async () => {
    await haltedRun()
    updateSession({ toolsRefused: 'managed policy refuses the litter MCP server' })
    expect((await buildBoard(p, litterDir, EXEC)).body!.notice).toEqual({ level: 'error', text: 'managed policy refuses the litter MCP server' })
  })
})

describe('which run, and when to rebuild', () => {
  test('a run id, a workflow, nothing, and an argument that is neither', async () => {
    await haltedRun()
    p.clock.now = NOW + 100 * MIN
    await record(FAN, [start('fanout', FAN), launch()])
    writeRunJson(FAN, 'fanout', {})
    expect(await resolveRun(p, litterDir, EXEC)).toEqual({ run: EXEC, why: null })
    expect(await resolveRun(p, litterDir, 'execute')).toEqual({ run: EXEC, why: null })
    expect(await resolveRun(p, litterDir, 'fanout')).toEqual({ run: FAN, why: null })
    // Nothing: the active run, else the newest.
    expect(await resolveRun(p, litterDir, null)).toEqual({ run: FAN, why: null })
    expect(await resolveRun(p, litterDir, 'design')).toEqual({ run: null, why: 'no design run yet' })
    expect(await resolveRun(p, litterDir, '20990101-none')).toEqual({ run: null, why: `there's no run 20990101-none in ${litterDir}` })
    expect(await resolveRun(p, litterDir, 'G1; rm -rf')).toEqual({ run: null, why: '"G1; rm -rf" isn\'t a run id (<yyyymmdd>-<slug>) or a workflow (execute, design)' })
  })

  test('the same heads and navigation answer the same view; a record or a navigation change, a new one', async () => {
    await haltedRun()
    const first = await buildBoard(p, litterDir, EXEC)
    const again = await buildBoard(p, litterDir, EXEC)
    expect(again).toBe(first)
    expect(first.body!.stamp).toBe(await boardStamp(p, litterDir, EXEC))
    await record(EXEC, [{ kind: 'rule.propose', body: { rule: 'One more', source: 'agent' } }])
    const moved = await buildBoard(p, litterDir, EXEC)
    expect(moved.v).toBeGreaterThan(first.v)
    setBoardNav({ ...blankBoardNav(EXEC), run: EXEC, selected: 'G1' })
    const picked = await buildBoard(p, litterDir, EXEC)
    expect(picked.v).toBeGreaterThan(moved.v)
    expect(picked.body!.gates!.selected).toBe('G1')
  })

  test('statusWord and runStatusOf: a word with every color', () => {
    expect(statusWord('stopped')).toEqual({ text: 'stopped', color: 'inactive', glyph: '−' })
    expect(statusWord('something new')).toEqual({ text: 'something new', color: 'inactive', glyph: '·' })
    expect(runStatusOf({ open: null, latest: null, launchEnd: null } as never, true)).toBe('ledger_tampered')
    expect(runStatusOf({ open: null, latest: null, launchEnd: null } as never, false)).toBe('pending')
    expect(utcAt(Date.UTC(2026, 9, 3, 7, 5))).toBe('2026-10-03 07:05 UTC')
  })
})

describe("the pane's handlers", () => {
  test('/litter-board opens the pane on the run; a pick, [Diff], [Plan] and [Close] move the navigation', async () => {
    await haltedRun()
    expect(await boardCommand(p, command(EXEC), next)).toEqual({ text: `litter: the board shows run ${EXEC} (execute, halted)` })
    expect(p.panes.opened.map(o => o.id)).toEqual(['litter-board'])
    expect((p.views.board as BoardView).run).toBe(EXEC)

    // The gate table's post, then the row's [Diff G1] with real git.
    await onBoardUi.message(p, { element: 'board-gates', data: { action: 'select', gate: 'G1', run: EXEC } } as never, next)
    expect(navOf()?.selected).toBe('G1')
    let view = p.views.board as BoardView
    expect(view.body!.buttons.map(b => b.key)).toEqual(['board:plan', 'board:diff:G1', 'board:rules'])
    await onBoardUi.press(p, { element: 'board:diff:G1' } as never, next)
    view = p.views.board as BoardView
    expect(view.body!.section!.kind).toBe('diff')
    expect(view.body!.section!.title).toBe(`G1: git diff --stat ${base.slice(0, 7)} ${landed.slice(0, 7)}`)
    expect(view.body!.section!.text).toContain('src/header.ts')
    expect(view.body!.buttons.at(-1)).toEqual({ key: 'board:close', label: 'Close' })

    // [Plan] from G2's heading on; a pick of another gate scrolls it there.
    await handleBoard(p, 'board:select:G2')
    expect((p.views.board as BoardView).body!.section).toBeNull()
    await handleBoard(p, 'board:plan')
    view = p.views.board as BoardView
    expect(view.body!.section).toEqual(expect.objectContaining({ kind: 'plan', title: 'plan.md from G2 (line 10)', path: planPath(runDir(litterDir, EXEC)) }))
    expect(view.body!.section!.text.startsWith('### G2: Retry the refresh once')).toBe(true)
    await handleBoard(p, 'board:close')
    expect((p.views.board as BoardView).body!.section).toBeNull()
  })

  test("a pick drawn for another run is ignored with a toast; the board's own key never passes on", async () => {
    await haltedRun()
    await boardCommand(p, command(EXEC), next)
    const before = navOf()?.selected ?? null
    expect(await onBoardUi.message(p, { element: 'board-gates', data: { action: 'select', gate: 'G1', run: '20261001-old' } } as never, next)).toEqual({})
    expect(navOf()?.selected ?? null).toBe(before)
    expect(p.toasts.at(-1)).toContain('that was for run 20261001-old')
    // Another element's message, press, field and pick pass on.
    expect(await onBoardUi.message(p, { element: 'swarm-tree', data: {} } as never, (async () => 'beneath') as never)).toBe('beneath' as never)
    expect(await onBoardUi.press(p, { element: 'swarm:x' } as never, (async () => 'beneath') as never)).toBe('beneath' as never)
    // A git argv is never built from a pick: an id that isn't a gate is dropped.
    await handleBoard(p, 'board:diff:G1 --output=/tmp/x')
    expect(navOf()?.section).toBeNull()
  })

  test('[Rules] opens the rules pane', async () => {
    await haltedRun()
    await boardCommand(p, command(EXEC), next)
    await handleBoard(p, 'board:rules')
    expect(p.panes.opened.map(o => o.id)).toEqual(['litter-board', 'litter-rules'])
    expect(p.views.rules).toBeDefined()
  })

  test('the tick writes only a view that changed; after a /clear, refreshBoard writes it again', async () => {
    await haltedRun()
    await boardCommand(p, command(''), next)
    // A call each time: a read after `delete` isn't narrowed to undefined.
    const shown = () => p.views.board as BoardView | undefined
    const v = shown()!.v
    delete p.views.board
    await boardTick(p)
    expect(shown()).toBeUndefined()
    await record(EXEC, [{ kind: 'rule.propose', body: { rule: 'From a tick', source: 'agent' } }])
    await boardTick(p)
    expect(shown()!.v).toBeGreaterThan(v)
    expect(shown()!.body!.proposals.map(r => r.text)).toContain('From a tick')
    // $.state wiped: the same view is written again.
    delete p.views.board
    await refreshBoard(p)
    expect(shown()!.run).toBe(EXEC)
  })

  test('with no litter directory, /litter-board says so and opens the pane on it', async () => {
    updateSession({ litterDir: null, litterDirError: 'not a git repository' })
    expect(await boardCommand(p, command(''), next)).toEqual({ text: 'litter: the board has no litter directory to read' })
    expect((p.views.board as BoardView).body!.notice).toEqual({ level: 'error', text: 'this session has no litter directory: not a git repository' })
    updateSession({ litterDirError: null })
  })
})
