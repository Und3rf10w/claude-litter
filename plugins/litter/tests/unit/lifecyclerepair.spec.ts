// Tier 2: the run side of a repair (hooks/lifecycle.ts; WP-W, COMMON 2b-2
// steps 1, 2 and 7), against real git in scratch repos: run.start's repair
// setting and its sha, the generations runState knows, reopenForRepair and
// its refusals, endRepairGeneration with and without a land and its cleanup,
// reconcile of a repair generation, the lock's holder during one, the
// launcher's fallback, runClosed across generations, and summary.md's parts.
// X's Repair section (repair.ts) is stood in for, as repaircallout.spec.ts does.

import { afterAll, afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordCtx, RecordInput, StoredRecord } from '../../hooks/records/core'
import type { RunEndBody, RunJson, RunRepairBody, RunStartReply } from '../../hooks/records/run'
import type { RepairOpen, RunRef } from '../../hooks/lifecycle'
import * as realRepair from '../../hooks/repair'
import {
  endRepairGeneration,
  endRun,
  getPending,
  loadLaunchable,
  openGeneration,
  pendingKey,
  reconcileRuns,
  recordRunEnd,
  recordRunStart,
  reopenForRepair,
  runState,
  writeSummary,
  REPAIR_LAUNCH_GRACE_MS,
} from '../../hooks/lifecycle'
import { acquireLock, readLock, releaseLock, removeLease, stopLease } from '../../hooks/lock'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { activePath, integrationBranch, integrationName, launchDir, launchRun, modePath, runDir as runDirOf, runJsonPath, summaryPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { readPolicy } from '../../hooks/policy'
import { sha256 } from '../../hooks/fsx'
import { updateSession } from '../../hooks/session'
import { runClosed } from '../../hooks/verify'
import { addModWorktree, worktreeRootFor } from '../../hooks/worktrees'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// Each world runs run.start and worktrees against real git; a loaded machine takes seconds.
setDefaultTimeout(120_000)

// ---------------------------------------------------------------------------
// X's Repair section, stood in for (restored after this file)

const REPAIR = '../../hooks/repair'
const realRepairCopy = { ...realRepair }
let section: ((runDir: string) => Promise<string>) | null = null
mock.module(REPAIR, () => ({
  ...realRepairCopy,
  repairSummary: async (p: never, runDir: string) => (section ? section(runDir) : realRepairCopy.repairSummary(p, runDir)),
}))
afterAll(() => {
  mock.module(REPAIR, () => realRepairCopy)
})

// ---------------------------------------------------------------------------
// A world: a scratch repo with server/ and client/, run.start for real

const T0 = 1_800_000_000_000
const MOD = { source: 'mod' } as const
const SWARM = 'repair-abc123'
const LAUNCH = '20270115-080000'
const OPEN: RepairOpen = { swarm: SWARM, launch: LAUNCH, budget: { rounds: 3, agents: 6 } }
const TASKS = [
  { id: 'server', title: 'Server', text: 'change the API response', writes: true, files: ['server/'] },
  { id: 'client', title: 'Client', text: 'read the API response', writes: true, files: ['client/'] },
]

type World = {
  p: TestPorts
  dir: string
  litterDir: string
  git: (...argv: string[]) => Promise<string>
  ctx: (options?: Record<string, unknown>) => RecordCtx
}

const cleanups: (() => void)[] = []

beforeEach(() => {
  section = null
})
afterEach(() => {
  stopLease()
  updateSession({ litterDir: null })
  for (const c of cleanups.splice(0)) c()
})

async function world(): Promise<World> {
  const s = scratch()
  cleanups.push(s.cleanup)
  const dir = realpathSync(s.dir)
  const base = nodePorts({ sessionId: 'session-a' })
  const p: TestPorts = {
    ...base,
    cwd: async () => dir,
    run: (argv, init) =>
      argv[0] === 'jq'
        ? Promise.resolve({ code: 0, stdout: 'jq-1.7.1\n', stderr: '', truncated: false })
        : base.run(argv, init?.cwd ? init : { ...init, cwd: dir }),
  }
  p.clock.now = T0
  const { git } = await scratchRepo(p, dir)
  for (const f of ['server/api.ts', 'client/use.ts']) {
    mkdirSync(join(dir, f, '..'), { recursive: true })
    writeFileSync(join(dir, f), `// ${f}\n`)
  }
  await git('add', '-A')
  await git('commit', '-q', '-m', 'server and client')
  const litterDir = join(dir, '.claude', 'litter')
  await p.fs.write(modePath(litterDir), 'default\n')
  updateSession({ litterDir })
  const ctx = (options: Record<string, unknown> = {}): RecordCtx => ({
    p,
    caller: { agentId: null, agentType: null },
    litterDir,
    options: normalizeOptions({ verify: ['true'], ...options }),
  })
  return { p, dir, litterDir, git, ctx }
}

const fanoutStart = (w: World, extra: Record<string, unknown> = {}, options: Record<string, unknown> = {}) =>
  recordRunStart(w.ctx(options), { kind: 'run.start', workflow: 'fanout', authorized: ['the defaults'], tasks: TASKS, ...extra } as RecordInput)

function okReply(r: unknown): RunStartReply {
  if (!(r as { ok: boolean }).ok) throw new Error(`run.start refused: ${JSON.stringify(r)}`)
  return r as RunStartReply
}

const records = async (w: World, ref: RunRef): Promise<StoredRecord[]> => (await readLedger(w.p, ref.runDir, ref.run)).records
const kinds = async (w: World, ref: RunRef) => (await records(w, ref)).map(r => r.kind)
const runJson = async (w: World, ref: RunRef) => JSON.parse(await w.p.fs.read(runJsonPath(ref.runDir))) as RunJson

type Halted = { ref: RunRef; base: string; integ: { path: string; branch: string } }

/**
 * A fanout as it stands once its generation 1 halted: run.start, the launch
 * (as the Workflow hook records it), the integration worktree with the
 * server task's commit merged in, then run.end halted, whose cleanup keeps
 * that worktree.
 */
async function halted(w: World, extra: Record<string, unknown> = {}): Promise<Halted> {
  const r = okReply(await fanoutStart(w, extra))
  const ref: RunRef = { run: r.run, runDir: r.runDir, litterDir: w.litterDir }
  const pending = (await getPending(w.p, w.litterDir))!
  stopLease(pending.oid)
  await w.p.store.delete(pendingKey(w.litterDir))
  await openGeneration(w.p, ref, 'run.launch', { taskId: 'task-1', runId: 'wf_abc123', scriptPath: null }, 'session-a', pending.oid)
  await removeLease(w.p, w.litterDir, pending.oid)
  const json = await runJson(w, ref)
  const name = integrationName(ref.run)
  const root = await worktreeRootFor(w.p, w.litterDir, ref.run)
  const spec = { run: ref.run, name, path: join(root, name), branch: integrationBranch(ref.run), base: json.base, disposable: false, runDir: ref.runDir, checkout: w.dir, setup: null, linkDirs: [] }
  const made = await addModWorktree(w.p, normalizeOptions({}), spec)
  if (!made.ok) throw new Error(made.reason)
  await commitIn(w, spec.path, 'server/api.ts', '// the server, changed\n')
  await endRun(w.p, ref, { taskId: 'task-1', generation: 1, status: 'halted', reason: 'not verified: the verifier failed task client', source: 'notification' })
  return { ref, base: json.base, integ: { path: spec.path, branch: spec.branch } }
}

async function commitIn(w: World, path: string, file: string, text: string): Promise<string> {
  mkdirSync(join(path, file, '..'), { recursive: true })
  writeFileSync(join(path, file), text)
  const g = async (...argv: string[]) => {
    const r = await w.p.run(['git', '-C', path, ...argv])
    if (r.code !== 0) throw new Error(`git ${argv.join(' ')}: ${r.stderr}`)
    return r.stdout
  }
  await g('add', '--', file)
  await g('commit', '-q', '-m', `change ${file}`)
  return (await g('rev-parse', 'HEAD')).trim()
}

async function reopened(w: World, h: Halted, open: RepairOpen = OPEN) {
  const r = await reopenForRepair(w.p, h.ref.runDir, open)
  if (!r.ok) throw new Error(r.reason)
  return r.link
}

/** What landRepaired leaves (Y): a fixer's commit on the integration branch, the checkout moved to it, the ref swapped, and land.intent then land. */
async function landRepair(w: World, h: Halted, verifyId = 'v-2'): Promise<string> {
  const tip = await commitIn(w, h.integ.path, 'client/use.ts', '// the client, fixed\n')
  const ref = `refs/heads/litter/${h.ref.run}`
  const tree = (await w.git('rev-parse', `${tip}^{tree}`)).trim()
  await appendRecord(w.p, h.ref.runDir, { run: h.ref.run, kind: 'land.intent', by: MOD, body: { gate: 'fanout', verify_id: verifyId, tree, old: h.base, ref, mode: 'checkout', commit: tip } })
  await w.git('read-tree', '-m', '-u', h.base, tip)
  await w.git('update-ref', ref, tip, h.base)
  await appendRecord(w.p, h.ref.runDir, { run: h.ref.run, kind: 'land', by: MOD, body: { gate: 'fanout', verify_id: verifyId, commit: tip, tree, old: h.base, ref } })
  return tip
}

/** The repair swarm's launch ledger: swarm.start, then swarm.end when `ended`. */
async function launchLedger(w: World, steps: ('start' | 'end')[], swarm = SWARM, launch = LAUNCH): Promise<void> {
  const dir = launchDir(w.litterDir, swarm, launch)
  for (const s of steps) {
    await appendRecord(w.p, dir, {
      run: launchRun(swarm, launch),
      kind: s === 'start' ? 'swarm.start' : 'swarm.end',
      by: MOD,
      body: s === 'start' ? { swarm, launch, revision: 1 } : { status: 'ended', settled: true, nodes: {}, worktrees: [], branches: [] },
    })
  }
}

const branchExists = async (w: World, branch: string) => (await w.p.run(['git', '-C', w.dir, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`])).code === 0
const ends = async (w: World, ref: RunRef) => (await records(w, ref)).filter(r => r.kind === 'run.end').map(r => r.body as unknown as RunEndBody)

// ---------------------------------------------------------------------------

describe('run.start: the repair setting (COMMON 2b-2, step 1)', () => {
  test("unset, the options' values: auto, 3 rounds and 6 agents by default, in run.json and the run.start body", async () => {
    const w = await world()
    const r = okReply(await fanoutStart(w))
    const ref: RunRef = { run: r.run, runDir: r.runDir, litterDir: w.litterDir }
    expect((await runJson(w, ref)).repair).toEqual({ mode: 'auto', rounds: 3, agents: 6 })
    expect(runState(await records(w, ref)).start?.repair).toEqual({ mode: 'auto', rounds: 3, agents: 6 })
  })

  test('the options set the defaults; the launch overrides each one for its run', async () => {
    const w = await world()
    const a = okReply(await fanoutStart(w, {}, { repair: 'off', repairRounds: 2, repairAgents: 9 }))
    expect((await runJson(w, { run: a.run, runDir: a.runDir, litterDir: w.litterDir })).repair).toEqual({ mode: 'off', rounds: 2, agents: 9 })
    stopLease()
    await releaseLock(w.p, w.dir, (await readLock(w.p, w.dir))!.oid)
    await w.git('switch', '-q', 'main')
    const b = okReply(await fanoutStart(w, { repair: 'auto', repairRounds: 10, repairAgents: 50 }, { repair: 'off', repairRounds: 2, repairAgents: 9 }))
    expect((await runJson(w, { run: b.run, runDir: b.runDir, litterDir: w.litterDir })).repair).toEqual({ mode: 'auto', rounds: 10, agents: 50 })
    stopLease()
    await releaseLock(w.p, w.dir, (await readLock(w.p, w.dir))!.oid)
    await w.git('switch', '-q', 'main')
    const c = okReply(await fanoutStart(w, { repair: 'off' }))
    expect((await runJson(w, { run: c.run, runDir: c.runDir, litterDir: w.litterDir })).repair).toEqual({ mode: 'off', rounds: 3, agents: 6 })
  })

  test('the sha covers it: runJsonSha256 is run.json\'s, and a changed repair makes run.json unlaunchable', async () => {
    const w = await world()
    const r = okReply(await fanoutStart(w, { repair: 'off', repairRounds: 1 }))
    const ref: RunRef = { run: r.run, runDir: r.runDir, litterDir: w.litterDir }
    const text = await w.p.fs.read(runJsonPath(ref.runDir))
    expect(text).toContain('"repair": {')
    expect(runState(await records(w, ref)).start?.runJsonSha256).toBe(await sha256(text))
    expect((await loadLaunchable(w.p, ref)).ok).toBe(true)
    await w.p.fs.write(runJsonPath(ref.runDir), text.replace('"mode": "off"', '"mode": "auto"'))
    expect(await loadLaunchable(w.p, ref)).toEqual({ ok: false, reason: `run ${ref.run}'s run.json changed since run.start` })
  })

  test.each([
    ['repair', { repair: 'maybe' }],
    ['repair', { repair: 'AUTO' }],
    ['repair', { repair: '' }],
    ['repairRounds', { repairRounds: 0 }],
    ['repairRounds', { repairRounds: 11 }],
    ['repairRounds', { repairRounds: 2.5 }],
    ['repairRounds', { repairRounds: '3' }],
    ['repairAgents', { repairAgents: 0 }],
    ['repairAgents', { repairAgents: 51 }],
  ] as const)('a bad %s (%j) is refused with its field, and nothing is written', async (field, extra) => {
    const w = await world()
    const r = (await fanoutStart(w, extra)) as { ok: false; field?: string; error: string }
    expect(r.ok).toBe(false)
    expect(r.field).toBe(field)
    expect(r.error).toContain(`'${field}'`)
    expect(await readLock(w.p, w.dir)).toBeNull()
    expect(existsSync(w.litterDir) ? (await w.p.fs.list(w.litterDir)).filter(e => /^[0-9]{8}-/.test(e.name)) : []).toEqual([])
  })

  // Phase 3 (AC): an execute run takes the fields as a fanout does; a design or plan run still refuses them.
  test('an execute run stores the setting as a fanout does, and a plan run refuses the fields', async () => {
    const w = await world()
    await w.p.fs.write(join(w.dir, 'plan.md'), '### G1: One\nFiles: a.txt\nChecks: true\nDone when: a.txt\n')
    await w.git('add', 'plan.md')
    await w.git('commit', '-q', '-m', 'plan')
    const r = (await recordRunStart(w.ctx(), { kind: 'run.start', workflow: 'plan', authorized: ['x'], goal: 'add a retry', repairRounds: 2 } as RecordInput)) as {
      ok: false
      field?: string
      error: string
    }
    expect(r).toEqual(expect.objectContaining({ ok: false, field: 'repairRounds' }))
    expect(r.error).toContain("'repairRounds' is for fanout and execute runs, not plan")
    const ok = okReply(await recordRunStart(w.ctx(), { kind: 'run.start', workflow: 'execute', planPath: 'plan.md', authorized: ['x'], repairRounds: 2 } as RecordInput))
    expect((await runJson(w, { run: ok.run, runDir: ok.runDir, litterDir: w.litterDir })).repair).toEqual({ mode: 'auto', rounds: 2, agents: 6 })
  })
})

describe('runState: generations across a repair', () => {
  const rec = (seq: number, kind: string, body: Record<string, unknown>): StoredRecord => ({ v: 1, seq, kind, run: 'r', at: seq * 1000, by: MOD, prev: null, body })
  const repairBody: RunRepairBody = { generation: 2, swarm: SWARM, launch: LAUNCH, budget: { rounds: 3, agents: 6 } }

  test('generation 1 is the launch, each run.repair opens the next, and each run.end closes the one it names', () => {
    const list = [
      rec(1, 'run.start', { workflow: 'fanout' }),
      rec(2, 'run.launch', { taskId: 't1', runId: 'wf_1', generation: 1, session: 's', oid: 'o' }),
      rec(3, 'run.end', { taskId: 't1', generation: 1, status: 'halted', reason: 'red', source: 'notification' }),
    ]
    let st = runState(list)
    expect({ ended: st.ended, open: st.open, n: st.generations.length }).toEqual({ ended: true, open: null, n: 1 })
    list.push(rec(4, 'run.repair', repairBody as unknown as Record<string, unknown>))
    st = runState(list)
    expect(st.ended).toBe(false)
    expect(st.open).toEqual(expect.objectContaining({ n: 2, taskId: '', runId: '', repair: repairBody, seq: 4, endSeq: null, land: null }))
    expect(st.latest).toBe(st.open)
    list.push(rec(5, 'land.intent', { verify_id: 'v-2', commit: 'c2' }), rec(6, 'land', { verify_id: 'v-2', commit: 'c2' }))
    list.push(rec(7, 'run.end', { taskId: null, generation: 2, status: 'done', reason: null, source: 'mod' }))
    st = runState(list)
    expect(st.ended).toBe(true)
    expect(st.generations.map(g => [g.n, g.repair !== null, g.land, g.end?.status, g.endSeq])).toEqual([
      [1, false, null, 'halted', 3],
      [2, true, 'c2', 'done', 7],
    ])
  })

  test("a land belongs to its intent's generation, even when reconcile records it after that generation's run.end", () => {
    const st = runState([
      rec(1, 'run.start', {}),
      rec(2, 'run.repair', { ...repairBody, generation: 1 }),
      rec(3, 'land.intent', { verify_id: 'v-1', commit: 'c1' }),
      rec(4, 'run.end', { taskId: null, generation: 1, status: 'halted', reason: 'crashed', source: 'mod' }),
      rec(5, 'run.repair', { ...repairBody, generation: 2 }),
      rec(6, 'land', { verify_id: 'v-1', commit: 'c1', recovered: true }),
    ])
    expect(st.generations.map(g => g.land)).toEqual(['c1', null])
  })
})

describe('reopenForRepair', () => {
  test('takes the lock, records run.repair for generation 2, and activates policy.run as run.start does', async () => {
    const w = await world()
    const h = await halted(w)
    expect(await readLock(w.p, w.dir)).toBeNull()
    expect((await readPolicy(w.p, w.litterDir))?.run ?? null).toBeNull()
    const link = await reopened(w, h)
    expect(link).toEqual({ runDir: h.ref.runDir, run: h.ref.run, generation: 2 })
    const recs = await records(w, h.ref)
    expect(recs.at(-1)).toEqual(expect.objectContaining({ kind: 'run.repair', by: MOD, body: { generation: 2, swarm: SWARM, launch: LAUNCH, budget: { rounds: 3, agents: 6 } } }))
    expect((await readLock(w.p, w.dir))?.blob).toEqual(expect.objectContaining({ run: h.ref.run, session: 'session-a' }))
    const policy = await readPolicy(w.p, w.litterDir)
    expect(policy?.run).toEqual(expect.objectContaining({ run: h.ref.run, workflow: 'fanout', runDir: h.ref.runDir, launching: false, runIds: [], stopping: false }))
    expect(policy?.session).toBe('session-a')
    expect(existsSync(activePath(w.litterDir))).toBe(true)
    // The run takes records again (verify.ts), until the generation's own run.end.
    expect(runClosed(recs)).toBeNull()
    expect(runState(recs).open?.repair?.swarm).toBe(SWARM)
  })

  test('refuses with the lock held by another run, and writes nothing', async () => {
    const w = await world()
    const h = await halted(w)
    const other = await acquireLock(w.p, w.dir, { run: '20270115-fanout-other1', session: 'session-b', acquiredAt: T0 })
    expect(other.ok).toBe(true)
    const before = await kinds(w, h.ref)
    const r = await reopenForRepair(w.p, h.ref.runDir, OPEN)
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('another litter run holds the project\'s run lock: run 20270115-fanout-other1 (session session-b)')
    expect(await kinds(w, h.ref)).toEqual(before)
    expect((await readLock(w.p, w.dir))?.blob?.run).toBe('20270115-fanout-other1')
    expect((await readPolicy(w.p, w.litterDir))?.run ?? null).toBeNull()
  })

  test('refuses with a generation still open, and writes nothing', async () => {
    const w = await world()
    const r0 = okReply(await fanoutStart(w))
    const ref: RunRef = { run: r0.run, runDir: r0.runDir, litterDir: w.litterDir }
    const pending = (await getPending(w.p, w.litterDir))!
    stopLease(pending.oid)
    await openGeneration(w.p, ref, 'run.launch', { taskId: 'task-1', runId: 'wf_abc123', scriptPath: null }, 'session-a', pending.oid)
    const before = await kinds(w, ref)
    const lock = await readLock(w.p, w.dir)
    const r = await reopenForRepair(w.p, ref.runDir, OPEN)
    expect(r).toEqual({ ok: false, reason: `litter: run ${ref.run} can't be reopened for a repair: its generation 1 is still open` })
    expect(await kinds(w, ref)).toEqual(before)
    expect((await readLock(w.p, w.dir))?.oid).toBe(lock!.oid)
    // An open repair generation refuses a second reopen the same way.
    await endRun(w.p, ref, { taskId: 'task-1', generation: 1, status: 'halted', reason: 'red', source: 'notification' })
    expect((await reopenForRepair(w.p, ref.runDir, OPEN)).ok).toBe(true)
    expect(await reopenForRepair(w.p, ref.runDir, { ...OPEN, launch: '20270115-080001' })).toEqual({
      ok: false,
      reason: `litter: run ${ref.run} can't be reopened for a repair: its generation 2 is still open`,
    })
  })

  test("a stale lock of an ended run is released first, as reconcile would", async () => {
    const w = await world()
    const h = await halted(w)
    // A crash between that run's run.end and its release: the lock names the ended run.
    const stale = await acquireLock(w.p, w.dir, { run: h.ref.run, session: 'session-old', acquiredAt: T0 })
    expect(stale.ok).toBe(true)
    await reopened(w, h)
    expect((await readLock(w.p, w.dir))?.blob?.session).toBe('session-a')
    expect(w.p.logs.some(l => l.includes(`released a stale lock of ended run ${h.ref.run}`))).toBe(true)
  })

  test('refuses what no launch confirmation covered: a budget over the approved one, a run with no repair setting, a changed run.json', async () => {
    const w = await world()
    const h = await halted(w, { repairRounds: 2, repairAgents: 4 })
    const why = async (open: RepairOpen) => ((await reopenForRepair(w.p, h.ref.runDir, open)) as { reason: string }).reason
    expect(await why({ ...OPEN, budget: { rounds: 3, agents: 4 } })).toContain('the budget (3 rounds, 4 agents) is more than its launch approved (2 rounds, 4 agents)')
    expect(await why({ ...OPEN, budget: { rounds: 2, agents: 0 } })).toContain('the budget must be 1 to 10 rounds and 1 to 50 agents')
    expect(await why({ ...OPEN, swarm: 'Repair_Bad' })).toContain("'Repair_Bad' isn't a swarm name")
    expect(await why({ ...OPEN, launch: 'later' })).toContain("'later' isn't a launch id")
    const text = await w.p.fs.read(runJsonPath(h.ref.runDir))
    await w.p.fs.write(runJsonPath(h.ref.runDir), text.replace('"rounds": 2', '"rounds": 9'))
    expect(await why({ ...OPEN, budget: { rounds: 2, agents: 4 } })).toContain('changed since run.start')
    expect((await records(w, h.ref)).some(r => r.kind === 'run.repair')).toBe(false)
    expect(await readLock(w.p, w.dir)).toBeNull()
  })

  test("refuses a run launched before repairs (no repair in run.json), a run that isn't a fanout or an execute run, one that never launched or ended done, and a folder that is no run", async () => {
    const w = await world()
    // Run folders as their run.start left them: run.json, and a ledger whose run.start holds its sha.
    const folder = async (run: string, json: Record<string, unknown>, ends: ('launch' | 'halted' | 'done')[]): Promise<string> => {
      const dir = runDirOf(w.litterDir, run)
      const text = `${JSON.stringify({ v: 1, run, workflow: 'fanout', ...json }, null, 2)}\n`
      await w.p.fs.write(runJsonPath(dir), text)
      await appendRecord(w.p, dir, { run, kind: 'run.start', by: MOD, body: { workflow: json.workflow ?? 'fanout', runJsonSha256: await sha256(text) } })
      for (const e of ends) {
        if (e === 'launch') await appendRecord(w.p, dir, { run, kind: 'run.launch', by: MOD, body: { taskId: 't1', runId: 'wf_1', generation: 1, session: 'session-a', oid: 'o' } })
        else await appendRecord(w.p, dir, { run, kind: 'run.end', by: MOD, body: { taskId: 't1', generation: 1, status: e, reason: e === 'done' ? null : 'red', source: 'notification' } })
      }
      return dir
    }
    const why = async (dir: string) => ((await reopenForRepair(w.p, dir, OPEN)) as { ok: boolean; reason: string }).reason
    const repair = { mode: 'auto', rounds: 3, agents: 6 }
    expect(await why(await folder('20270115-fanout-before', {}, ['launch', 'halted']))).toContain(
      'its run.json has no repair setting (it was launched before repairs), so its launch confirmation never stated one',
    )
    // Phase 3 (AC): an execute run reopens as a fanout does; a design run doesn't.
    expect(await why(await folder('20270115-execute-plan01', { workflow: 'design', repair }, ['launch', 'halted']))).toContain(
      'its workflow is design, and only a fanout or an execute run continues as a repair swarm',
    )
    expect(await why(await folder('20270115-fanout-never1', { repair }, []))).toContain('it never launched')
    expect(await why(await folder('20270115-fanout-landed', { repair }, ['launch', 'done']))).toContain('it ended done, so there is nothing to repair')
    expect(await why('/not/a/run')).toBe("litter: /not/a/run isn't a litter run's folder")
    expect(await readLock(w.p, w.dir)).toBeNull()
    for (const run of ['20270115-fanout-before', '20270115-execute-plan01', '20270115-fanout-never1', '20270115-fanout-landed']) {
      expect((await readLedger(w.p, runDirOf(w.litterDir, run), run)).records.some(r => r.kind === 'run.repair')).toBe(false)
    }
  })
})

describe('endRepairGeneration', () => {
  test('with a land in the generation: done, the integration worktree removed once the land took its tip, the lock and policy released', async () => {
    const w = await world()
    const h = await halted(w)
    // Generation 1's cleanup kept the integration worktree: the run ended halted without landing.
    expect(existsSync(h.integ.path)).toBe(true)
    await reopened(w, h)
    const tip = await landRepair(w, h)
    const out = await endRepairGeneration(w.p, h.ref.runDir, { status: 'done', reason: null })
    expect(out).toEqual({ recorded: true, end: { taskId: null, generation: 2, status: 'done', reason: null, source: 'mod' } })
    expect(existsSync(h.integ.path)).toBe(false)
    expect(await branchExists(w, h.integ.branch)).toBe(false)
    expect((await w.git('rev-parse', `refs/heads/litter/${h.ref.run}`)).trim()).toBe(tip)
    expect(await readLock(w.p, w.dir)).toBeNull()
    expect((await readPolicy(w.p, w.litterDir))?.run ?? null).toBeNull()
    expect(existsSync(activePath(w.litterDir))).toBe(false)
    const st = runState(await records(w, h.ref))
    expect({ ended: st.ended, n: st.generations.length, land: st.latest?.land }).toEqual({ ended: true, n: 2, land: tip })
    expect(runClosed(await records(w, h.ref))).toBe('has ended')
    const summary = await w.p.fs.read(summaryPath(h.ref.runDir))
    expect(summary).toContain('- Status: done')
    expect(summary).toContain(`- Landed: ${h.base}..${tip} on litter/${h.ref.run}, verify v-2`)
  })

  test("without one: halted with the reason, everything kept with why, the lock released; the ledger decides, not the outcome", async () => {
    const w = await world()
    const h = await halted(w)
    await reopened(w, h)
    const fix = await commitIn(w, h.integ.path, 'client/use.ts', '// a fix that never landed\n')
    const out = await endRepairGeneration(w.p, h.ref.runDir, { status: 'done', reason: null })
    expect(out.end).toEqual({ taskId: null, generation: 2, status: 'halted', reason: `repair swarm ${SWARM} ended without a land`, source: 'mod' })
    expect(w.p.logs.some(l => l.includes('ended done, but generation 2 has no land, so it ends halted'))).toBe(true)
    expect(existsSync(h.integ.path)).toBe(true)
    expect((await w.git('rev-parse', `refs/heads/${h.integ.branch}`)).trim()).toBe(fix)
    const kept = (await records(w, h.ref)).filter(r => r.kind === 'worktree.kept' && r.body.name === integrationName(h.ref.run)).at(-1)
    expect(String(kept?.body.reason)).toContain('the run ended halted without landing, and it holds 2 commits past base')
    expect(await readLock(w.p, w.dir)).toBeNull()
    expect((await readPolicy(w.p, w.litterDir))?.run ?? null).toBeNull()
  })

  test("a halted outcome's reason is the run.end's", async () => {
    const w = await world()
    const h = await halted(w)
    await reopened(w, h)
    const out = await endRepairGeneration(w.p, h.ref.runDir, { status: 'halted', reason: 'the swarm could not be launched: types refused' })
    expect(out.end.reason).toBe('the swarm could not be launched: types refused')
  })

  test('is idempotent: a second call answers the first run.end, recorded false, and writes nothing', async () => {
    const w = await world()
    const h = await halted(w)
    await reopened(w, h)
    const first = await endRepairGeneration(w.p, h.ref.runDir, { status: 'halted', reason: 'stopped by you' })
    const before = await kinds(w, h.ref)
    const again = await endRepairGeneration(w.p, h.ref.runDir, { status: 'done', reason: null })
    expect(again).toEqual({ recorded: false, end: first.end })
    expect(await kinds(w, h.ref)).toEqual(before)
  })

  test('a run with no repair generation throws, and so does a folder that is no run', async () => {
    const w = await world()
    const h = await halted(w)
    await expect(endRepairGeneration(w.p, h.ref.runDir, { status: 'halted', reason: null })).rejects.toThrow(`run ${h.ref.run} has no repair generation to end`)
    await expect(endRepairGeneration(w.p, '/nowhere', { status: 'halted', reason: null })).rejects.toThrow("isn't a litter run's folder")
  })

  test("a land a crash left between its intent and its record still counts: lands are reconciled first", async () => {
    const w = await world()
    const h = await halted(w)
    await reopened(w, h)
    const tip = await commitIn(w, h.integ.path, 'client/use.ts', '// fixed\n')
    const ref = `refs/heads/litter/${h.ref.run}`
    const tree = (await w.git('rev-parse', `${tip}^{tree}`)).trim()
    await appendRecord(w.p, h.ref.runDir, { run: h.ref.run, kind: 'land.intent', by: MOD, body: { gate: 'fanout', verify_id: 'v-9', tree, old: h.base, ref, mode: 'checkout', commit: tip } })
    await w.git('read-tree', '-m', '-u', h.base, tip)
    await w.git('update-ref', ref, tip, h.base)
    // The crash: no land record.
    const out = await endRepairGeneration(w.p, h.ref.runDir, { status: 'halted', reason: 'the session ended' })
    expect(out.end.status).toBe('done')
    expect((await records(w, h.ref)).some(r => r.kind === 'land' && r.body.recovered === true && r.body.commit === tip)).toBe(true)
  })
})

describe('reconcile of a repair generation', () => {
  test('one whose swarm has swarm.end but no run.end is ended (done with its land); a later session start changes nothing', async () => {
    const w = await world()
    const h = await halted(w)
    await reopened(w, h)
    await launchLedger(w, ['start'])
    const tip = await landRepair(w, h)
    await launchLedger(w, ['end'])
    await reconcileRuns(w.p, w.litterDir)
    expect((await ends(w, h.ref)).at(-1)).toEqual({ taskId: null, generation: 2, status: 'done', reason: null, source: 'mod' })
    expect((await w.git('rev-parse', `refs/heads/litter/${h.ref.run}`)).trim()).toBe(tip)
    expect(await readLock(w.p, w.dir)).toBeNull()
    const before = await kinds(w, h.ref)
    await reconcileRuns(w.p, w.litterDir)
    expect(await kinds(w, h.ref)).toEqual(before)
  })

  test('one whose swarm ended without a land ends halted, saying so', async () => {
    const w = await world()
    const h = await halted(w)
    await reopened(w, h)
    await launchLedger(w, ['start', 'end'])
    await reconcileRuns(w.p, w.litterDir)
    expect((await ends(w, h.ref)).at(-1)).toEqual(expect.objectContaining({ generation: 2, status: 'halted', reason: `repair swarm ${SWARM} ended without a land` }))
  })

  test("one whose swarm is live is left alone: the swarm owns it, and the engine's snapshot isn't asked", async () => {
    const w = await world()
    const h = await halted(w)
    await reopened(w, h)
    await launchLedger(w, ['start'])
    const before = await kinds(w, h.ref)
    w.p.clock.now = T0 + 24 * 3600 * 1000
    await reconcileRuns(w.p, w.litterDir)
    expect(await kinds(w, h.ref)).toEqual(before)
    expect((await readLock(w.p, w.dir))?.blob?.run).toBe(h.ref.run)
    expect(runState(await records(w, h.ref)).open?.n).toBe(2)
  })

  test('one whose swarm never went live is left within the grace, and ended after it', async () => {
    const w = await world()
    const h = await halted(w)
    await reopened(w, h)
    w.p.clock.now = T0 + REPAIR_LAUNCH_GRACE_MS - 1_000
    await reconcileRuns(w.p, w.litterDir)
    expect(runState(await records(w, h.ref)).open?.n).toBe(2)
    w.p.clock.now = T0 + REPAIR_LAUNCH_GRACE_MS + 1_000
    await reconcileRuns(w.p, w.litterDir)
    expect((await ends(w, h.ref)).at(-1)).toEqual(expect.objectContaining({ generation: 2, status: 'halted', reason: `repair swarm ${SWARM} never went live` }))
    expect(await readLock(w.p, w.dir)).toBeNull()
  })
})

describe("the run lock's holder in a repair generation (reconcile before an acquisition)", () => {
  test('a new run.start is refused while the repair swarm is live, naming it, and never asks to mark it interrupted', async () => {
    const w = await world()
    const h = await halted(w)
    await reopened(w, h)
    await launchLedger(w, ['start'])
    const asked: string[] = []
    w.p.ask = async (q: string) => {
      asked.push(q)
      return 'Mark it interrupted'
    }
    const r = (await fanoutStart(w)) as { ok: false; error: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain(`run ${h.ref.run} holds the project's run lock while its repair swarm ${SWARM} is live (generation 2)`)
    expect(r.error).toContain(`/litter swarms ${SWARM}`)
    expect(asked).toEqual([])
    expect(runState(await records(w, h.ref)).open?.n).toBe(2)
  })

  test('once the swarm has ended, the generation is ended and the new run.start goes ahead', async () => {
    const w = await world()
    const h = await halted(w)
    await reopened(w, h)
    await launchLedger(w, ['start', 'end'])
    okReply(await fanoutStart(w))
    expect((await ends(w, h.ref)).at(-1)).toEqual(expect.objectContaining({ generation: 2, status: 'halted' }))
  })
})

describe("the launcher's run.end fallback", () => {
  test('never ends a repair generation: the old task answers its own end, any other is refused naming the swarm', async () => {
    const w = await world()
    const h = await halted(w)
    await reopened(w, h)
    const ctx = w.ctx()
    const old = await recordRunEnd(ctx, { kind: 'run.end', run: h.ref.run, taskId: 'task-1', status: 'completed', result: '{"halted":null}' })
    expect(old).toEqual(expect.objectContaining({ ok: true, recorded: false, end: expect.objectContaining({ generation: 1, status: 'halted' }) }))
    const other = (await recordRunEnd(ctx, { kind: 'run.end', run: h.ref.run, taskId: 'task-9', status: 'killed' })) as { ok: false; error: string; field?: string }
    expect(other).toEqual(expect.objectContaining({ ok: false, field: 'taskId' }))
    expect(other.error).toContain(`its open generation 2 is repair swarm ${SWARM}'s`)
    const none = (await recordRunEnd(ctx, { kind: 'run.end', run: h.ref.run, taskId: '', status: 'killed' })) as { ok: boolean }
    expect(none.ok).toBe(false)
    expect(runState(await records(w, h.ref)).open?.n).toBe(2)
  })
})

describe('runClosed across generations (verify.ts)', () => {
  test('closed after generation 1, open again in the repair generation, closed after its run.end', async () => {
    const w = await world()
    const h = await halted(w)
    expect(runClosed(await records(w, h.ref))).toBe('has ended')
    await reopened(w, h)
    expect(runClosed(await records(w, h.ref))).toBeNull()
    await endRepairGeneration(w.p, h.ref.runDir, { status: 'halted', reason: 'stopped' })
    expect(runClosed(await records(w, h.ref))).toBe('has ended')
  })
})

describe('summary.md', () => {
  test("X's Repair section, the repair generation's part, and the fanout's own part from generation 1's records", async () => {
    const w = await world()
    const h = await halted(w)
    // The fanout verifier's verdict, in generation 1: client fails.
    await appendRecord(w.p, h.ref.runDir, {
      run: h.ref.run,
      kind: 'verdict',
      by: { source: 'agent', agentId: 'verifier-1', agentType: 'litter:verifier' },
      body: { verify_id: 'v-1', tasks: [{ id: 'server', pass: true, evidence: 'ok', gaps: [] }, { id: 'client', pass: false, evidence: 'reads the old shape', gaps: ['reads data.items'] }] },
    })
    section = async runDir => (runDir === h.ref.runDir ? `## Repair\n\nRepair swarm ${SWARM} started for this run.\n` : '')
    await reopened(w, h)
    await launchLedger(w, ['start'])
    // A raise you granted (X's repair.budget): the summary shows the budget as it stands.
    await appendRecord(w.p, launchDir(w.litterDir, SWARM, LAUNCH), {
      run: launchRun(SWARM, LAUNCH),
      kind: 'swarm.event',
      by: MOD,
      body: { kind: 'budget', requested: { rounds: 2 }, granted: true, budget: { rounds: 5, agents: 6 } },
    })
    const critic = { source: 'agent', agentId: 'critic-1', agentType: `litter:sw-${SWARM}-critic` } as const
    const verify = (id: string, green: boolean) =>
      appendRecord(w.p, h.ref.runDir, { run: h.ref.run, kind: 'verify', by: critic, body: { verify_id: id, gate: 'repair', green, exit_code: green ? 0 : 1 } })
    await verify('v-2', false)
    await appendRecord(w.p, h.ref.runDir, {
      run: h.ref.run,
      kind: 'verdict',
      by: critic,
      body: { verify_id: 'v-2', tasks: [{ id: 'server', pass: true }, { id: 'client', pass: false }], combined: 'no', proposed_rules: [], round: 1, approved: false },
    })
    await verify('v-3', true)
    await appendRecord(w.p, h.ref.runDir, {
      run: h.ref.run,
      kind: 'verdict',
      by: critic,
      body: { verify_id: 'v-3', tasks: [{ id: 'server', pass: true }, { id: 'client', pass: true }], combined: 'yes', proposed_rules: [], round: 2, approved: true },
    })
    await writeSummary(w.p, h.ref)
    let s = await w.p.fs.read(summaryPath(h.ref.runDir))
    expect(s).toContain(`- Status: repairing (generation 2, repair swarm ${SWARM})`)
    expect(s).toContain(`## Repair\n\nRepair swarm ${SWARM} started for this run.`)
    for (const line of [
      '## Repair generation 2',
      `- Swarm: ${SWARM}, launch ${LAUNCH}`,
      '- Budget: 5 rounds and 6 agents (raised from 3 and 6)',
      '- Verifies: 2 (1 green)',
      '- Rounds: 2 of 5',
      '  1. verify v-2: rejected, failing client',
      '  2. verify v-3: approved',
      '- Landed: no',
      '- Ended: not yet: the swarm is working in it',
      `2. repair swarm ${SWARM} (launch ${LAUNCH}): open`,
    ]) {
      expect(s).toContain(line)
    }
    // The fanout's Tasks table is generation 1's verdict, not the critic's approval.
    expect(s).toContain('| client | writer | none | not merged | fail: reads data.items |')
    expect(s.indexOf('## Repair\n')).toBeLessThan(s.indexOf('## Repair generation 2'))

    const tip = await landRepair(w, h, 'v-3')
    await endRepairGeneration(w.p, h.ref.runDir, { status: 'done', reason: null })
    s = await w.p.fs.read(summaryPath(h.ref.runDir))
    expect(s).toContain('- Status: done')
    expect(s).toContain(`- Landed: ${h.base}..${tip} on litter/${h.ref.run}, verify v-3`)
    expect(s).toContain('- Ended: done')
    expect(s).toContain(`2. repair swarm ${SWARM} (launch ${LAUNCH}): done, from mod`)
  })

  test("a Repair section that rejects is logged, and the rest of the summary is written", async () => {
    const w = await world()
    const h = await halted(w)
    section = async () => {
      throw new Error('no section today')
    }
    await reopened(w, h)
    await writeSummary(w.p, h.ref)
    const s = await w.p.fs.read(summaryPath(h.ref.runDir))
    expect(s).toContain('## Repair generation 2')
    expect(s).not.toContain('## Repair\n')
    expect(w.p.logs.some(l => l.includes(`run ${h.ref.run}: the summary's Repair section failed: no section today`))).toBe(true)
  })
})
