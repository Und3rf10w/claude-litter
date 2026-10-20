// Tier 2: the mod acts only on the ledgers its store owns (ledgercore's
// `owned`, Claude Code's answer in ledgerowner.ts). A second store stands in
// for a Codex home's litterd: its run.start, its run.launch (with a driver and
// a codex- task id) and its other records go through that store, so the
// Claude store reads them headless, or with a legacy head left from before
// heads had a version. And the shared ledgers (rules, swarm specs) have one
// writer, Claude Code: refused on Codex, adopted on Claude Code after a lost
// store.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordCtx, RecordInput, RecordReply, StoredRecord } from '../../hooks/records/core'
import type { RunDriver, RunJson, RunStartReply } from '../../hooks/records/run'
import type { RunRef } from '../../hooks/lifecycle'
import type { SwarmSpec } from '../../hooks/swarm/types'
import { endRun, getPending, openGeneration, reconcileRuns, recordRunEnd, recordRunStart, runState, taskKey, takeLock } from '../../hooks/lifecycle'
import { readLock, removeLease, stopLease } from '../../hooks/lock'
import { appendRecord, headKey, owned, readLedger } from '../../hooks/ledgercore'
import { dispatchRecord, type DispatchEnv } from '../../hooks/ledger'
import { leasePath, modePath, repoRulesLedgerDir, swarmDir } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { readPolicy } from '../../hooks/policy'
import { updateSession } from '../../hooks/session'
import { atomicWriteJson } from '../../hooks/fsx'
import { cleanupLeftovers } from '../../hooks/worktrees'
import { recordRepairStart } from '../../hooks/repair'
import { executeSummary } from '../../hooks/execsummary'
import { proposeFromCritic, acceptRule } from '../../hooks/rules/store'
import { appendRuleRecord, readRuleLedger } from '../../hooks/rules/ledger'
import { saveRevision, stageProposal } from '../../hooks/swarm/store'
import { readSpecLedger } from '../../hooks/records/swarm'
import { fakePatterns, propose, rulesWorld, type RulesWorld } from './rules-harness'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// Each world runs run.start against real git; a loaded machine takes seconds.
setDefaultTimeout(120_000)

const MOD = { source: 'mod' } as const
const DRIVER: RunDriver = { pid: 4242, socket: '/tmp/litterd.sock', startedAt: 1_760_000_000_000, procStart: null }
const ELSEWHERE = 'is driven by another host or Codex home, or this store lost its head'

type World = {
  /** Claude Code's ports: this session, its store, its answer to `owned`. */
  p: TestPorts
  /** litterd's: the same files and repository, its own store, no answer of Claude Code's. */
  codex: TestPorts
  dir: string
  litterDir: string
  marker: string
}

const cleanups: (() => void)[] = []

afterEach(() => {
  stopLease()
  updateSession({ litterDir: null, host: 'claude-code' })
  for (const c of cleanups.splice(0)) c()
})

async function world(): Promise<World> {
  const s = scratch()
  cleanups.push(s.cleanup)
  const dir = realpathSync(s.dir)
  const base = nodePorts()
  const p: TestPorts = {
    ...base,
    sessionId: async () => 'session-b',
    cwd: async () => dir,
    run: (argv, init) =>
      argv[0] === 'jq'
        ? Promise.resolve({ code: 0, stdout: 'jq-1.7.1\n', stderr: '', truncated: false })
        : base.run(argv, init?.cwd ? init : { ...init, cwd: dir }),
  }
  const other = nodePorts()
  const codex: TestPorts = {
    ...p,
    store: other.store,
    storeMap: other.storeMap,
    log: other.log,
    logs: other.logs,
    ask: other.ask,
    answers: other.answers,
    asked: other.asked,
    sessionId: async () => 'codex-lead',
  }
  delete codex.ledgerOwner
  const { git } = await scratchRepo(p, dir)
  await p.fs.write(join(dir, 'plan.md'), '### G1: One\nFiles: a.txt\nChecks: true\nDone when: a.txt\n')
  await git('add', 'plan.md')
  await git('commit', '-q', '-m', 'plan')
  const litterDir = join(dir, '.claude', 'litter')
  await p.fs.write(modePath(litterDir), 'default\n')
  updateSession({ litterDir })
  return { p, codex, dir, litterDir, marker: join(dir, 'verify-ran') }
}

const ctxOf = (w: World, q: TestPorts): RecordCtx => ({
  p: q,
  caller: { agentId: null, agentType: null },
  litterDir: w.litterDir,
  // A verify of any run leaves a marker, so a test can tell one ran.
  options: normalizeOptions({ verify: [`touch ${w.marker}`] }),
})
const envOf = (w: World): DispatchEnv => ({ litterDir: w.litterDir, litterDirError: null, ready: true, options: normalizeOptions(undefined) })

/** A run litterd started, launched with its driver and a codex- task id unless `launch` is false, as its host does (launch.ts). */
async function codexRun(w: World, o: { launch?: boolean; workflow?: 'execute' | 'plan' } = {}): Promise<{ ref: RunRef; oid: string }> {
  const workflow = o.workflow ?? 'execute'
  const input = workflow === 'plan' ? { goal: 'add a retry' } : { planPath: 'plan.md' }
  const r = (await recordRunStart(ctxOf(w, w.codex), { kind: 'run.start', workflow, authorized: ['test'], ...input } as RecordInput)) as RunStartReply
  if (!r.ok) throw new Error(JSON.stringify(r))
  const ref: RunRef = { run: r.run, runDir: r.runDir, litterDir: w.litterDir }
  const oid = (await getPending(w.codex, w.litterDir))!.oid
  if (o.launch !== false) {
    stopLease(oid)
    await w.codex.store.delete(`litter.pending.${w.litterDir}`)
    await openGeneration(w.codex, ref, 'run.launch', { taskId: 'codex-1', runId: 'wf_codex-1', scriptPath: null, driver: DRIVER }, 'codex-lead', oid)
    await removeLease(w.codex, w.litterDir, oid)
  }
  return { ref, oid }
}

const recordsOf = async (w: World, ref: RunRef): Promise<StoredRecord[]> => (await readLedger(w.p, ref.runDir, ref.run)).records
const kindsOf = async (w: World, ref: RunRef): Promise<string[]> => (await recordsOf(w, ref)).map(r => r.kind)
/** The head litterd's store holds, without its version: as a read before heads had one left it in this store. */
const legacyHead = (w: World, ref: RunRef) => {
  const { seq, sha } = w.codex.storeMap.get(headKey(ref.runDir)) as { seq: number; sha: string }
  return { seq, sha }
}

describe('reconcile at session.start, on a run another store drives', () => {
  test('a launched run: nothing appended, its policy, its task index and its lock left alone, with no head here or a legacy one', async () => {
    const w = await world()
    const { ref, oid } = await codexRun(w)
    const kinds = await kindsOf(w, ref)
    const policy = await readPolicy(w.p, w.litterDir)
    expect(policy?.session).toBe('codex-lead')
    for (const head of ['none', 'legacy'] as const) {
      if (head === 'legacy') w.p.storeMap.set(headKey(ref.runDir), legacyHead(w, ref))
      await reconcileRuns(w.p, w.litterDir)
      expect(await kindsOf(w, ref)).toEqual(kinds)
      expect(await readPolicy(w.p, w.litterDir)).toEqual(policy)
      expect(w.p.storeMap.has(taskKey('codex-1'))).toBe(false)
      expect((await readLock(w.p, w.dir))?.oid).toBe(oid)
      // The read wrote no head, and left the legacy one as it was.
      expect(w.p.storeMap.get(headKey(ref.runDir))).toEqual(head === 'none' ? undefined : legacyHead(w, ref))
    }
    // Said once, not at every session.start.
    expect(w.p.logs.filter(l => l === `run ${ref.run} ${ELSEWHERE}; not reconciled here`)).toHaveLength(1)
    // The lock's holder is named, and kept: a launched run's lease isn't beaten, so it says nothing of its host.
    expect(w.p.logs.some(l => l.startsWith(`lock: litter: run ${ref.run} (session codex-lead) holds the project's run lock, and run ${ref.run} ${ELSEWHERE}`))).toBe(true)
  })

  test('an ended run: its recorded worktrees are left to its owner', async () => {
    const w = await world()
    const { ref } = await codexRun(w)
    const path = join(w.dir, '.claude', 'worktrees', 'wf_codex-1-1')
    mkdirSync(path, { recursive: true })
    const body = { run: ref.run, name: 'wf_codex-1-1', path, branch: `litter/${ref.run}-w1`, base: 'b'.repeat(40), disposable: false, ignored: [] }
    await appendRecord(w.codex, ref.runDir, { run: ref.run, kind: 'worktree.create', by: MOD, body })
    await appendRecord(w.codex, ref.runDir, {
      run: ref.run,
      kind: 'run.end',
      by: MOD,
      body: { taskId: 'codex-1', generation: 1, status: 'failed', reason: 'x', source: 'notification' },
    })
    const kinds = await kindsOf(w, ref)
    await cleanupLeftovers(w.p, w.litterDir)
    expect(await kindsOf(w, ref)).toEqual(kinds)
    expect(existsSync(path)).toBe(true)
    // Its own store's cleanup does take it on.
    await cleanupLeftovers(w.codex, w.litterDir)
    expect((await kindsOf(w, ref)).at(-1)).toBe('worktree.kept')
  })

  test("before its launch, with litterd's lock and a legacy head here (so `owned` says mine): left to the lock's holder", async () => {
    const w = await world()
    const { ref, oid } = await codexRun(w, { launch: false })
    w.p.storeMap.set(headKey(ref.runDir), legacyHead(w, ref))
    expect(await owned(w.p, ref.runDir, await readLedger(w.p, ref.runDir, ref.run))).toBe('mine')
    await reconcileRuns(w.p, w.litterDir)
    expect(await kindsOf(w, ref)).toEqual(['run.start'])
    expect((await readLock(w.p, w.dir))?.oid).toBe(oid)
  })

  test('before its launch, with no head here and no lock: skipped, while its own store ends it', async () => {
    const w = await world()
    const { ref, oid } = await codexRun(w, { launch: false })
    stopLease()
    await w.p.run(['git', '-C', w.dir, 'update-ref', '-d', 'refs/litter-active', oid])
    await reconcileRuns(w.p, w.litterDir)
    expect(await kindsOf(w, ref)).toEqual(['run.start'])
    await reconcileRuns(w.codex, w.litterDir)
    expect(runState(await recordsOf(w, ref)).launchEnd).toEqual(expect.objectContaining({ status: 'launch_failed', source: 'reconcile' }))
  })
})

describe('the lock, held by a run another store drives', () => {
  test('a launch whose lease is stale: the ref and lease are released, and nothing is recorded in its ledger', async () => {
    const w = await world()
    const { ref, oid } = await codexRun(w, { launch: false })
    stopLease()
    await atomicWriteJson(w.p, leasePath(w.litterDir, oid), { oid, run: ref.run, session: 'codex-lead', beatAt: 0 })
    await reconcileRuns(w.p, w.litterDir)
    expect(await readLock(w.p, w.dir)).toBeNull()
    expect(existsSync(leasePath(w.litterDir, oid))).toBe(false)
    expect(await kindsOf(w, ref)).toEqual(['run.start'])
    expect(w.p.logs).toContain(
      `released the lock of run ${ref.run} (session codex-lead), as its lease was stale; run ${ref.run} ${ELSEWHERE}, so nothing was recorded in its ledger`,
    )
  })

  test('a launched one is kept unless you release it, and then nothing is recorded in its ledger either', async () => {
    const w = await world()
    const { ref, oid } = await codexRun(w)
    await atomicWriteJson(w.p, leasePath(w.litterDir, oid), { oid, run: ref.run, session: 'codex-lead', beatAt: 0 })
    const blob = { run: '20261009-claude', session: 'session-b', acquiredAt: await w.p.now() }
    const kept = await takeLock(w.p, w.litterDir, blob)
    expect(kept).toEqual(expect.objectContaining({ ok: false }))
    expect(w.p.asked).toHaveLength(1)
    expect(w.p.asked[0]!.question).toContain(`Run ${ref.run} (session codex-lead) holds this project's litter run lock`)
    expect(w.p.asked[0]!.question).toContain(`run ${ref.run} ${ELSEWHERE}`)
    expect((await readLock(w.p, w.dir))?.oid).toBe(oid)
    w.p.answers.push('Release it')
    expect(await takeLock(w.p, w.litterDir, blob)).toEqual(expect.objectContaining({ ok: true }))
    expect((await readLock(w.p, w.dir))?.blob?.run).toBe('20261009-claude')
    expect(await kindsOf(w, ref)).toEqual(['run.start', 'run.launch'])
  })
})

describe('the launcher, a plan and a repair on a run another store drives', () => {
  const runEnd = (ref: RunRef) => ({ kind: 'run.end', run: ref.run, taskId: 'codex-1', status: 'failed', reason: 'it broke' }) as RecordInput

  test('run.end is refused; with no head here, only after asking, and your yes adopts the ledger', async () => {
    const w = await world()
    const { ref } = await codexRun(w)
    const refused = { ok: false, error: `litter: run ${ref.run} is driven by another host or Codex home; end it there` }
    // No head here: asked, and with no one to answer (as under -p) refused.
    expect(await recordRunEnd(ctxOf(w, w.p), runEnd(ref))).toEqual(expect.objectContaining(refused))
    expect(w.p.asked).toHaveLength(1)
    expect(w.p.asked[0]!.question).toContain(`Run ${ref.run} (session codex-lead) has no head in this store`)
    expect(w.p.asked[0]!.question).toContain('Its last record is 2, run.launch')
    // A legacy head with litterd's launch in the ledger: refused without asking.
    w.p.storeMap.set(headKey(ref.runDir), legacyHead(w, ref))
    expect(await recordRunEnd(ctxOf(w, w.p), runEnd(ref))).toEqual(expect.objectContaining(refused))
    expect(w.p.asked).toHaveLength(1)
    expect(await kindsOf(w, ref)).toEqual(['run.start', 'run.launch'])
    // A store that lost its head, and you say so: the run.end is this store's, and so is the ledger from here.
    w.p.storeMap.delete(headKey(ref.runDir))
    w.p.answers.push('End it here')
    expect(await recordRunEnd(ctxOf(w, w.p), runEnd(ref))).toEqual(expect.objectContaining({ ok: true, recorded: true }))
    expect(runState(await recordsOf(w, ref)).latest?.end).toEqual(expect.objectContaining({ status: 'failed', source: 'launcher' }))
    expect(w.p.storeMap.get(headKey(ref.runDir))).toEqual(expect.objectContaining({ v: 2 }))
  })

  test("plan.write is refused before it writes the plan's file", async () => {
    const w = await world()
    const { ref } = await codexRun(w, { workflow: 'plan' })
    const files = readdirSync(ref.runDir).sort()
    const r = await dispatchRecord(w.p, undefined, { kind: 'plan.write', run: ref.run, gates: [{ id: 'G1', title: 'Parse' }] }, envOf(w))
    expect(r).toEqual(expect.objectContaining({ ok: false, error: `litter: run ${ref.run} ${ELSEWHERE}; nothing is recorded for it here`, field: 'run' }))
    expect(readdirSync(ref.runDir).sort()).toEqual(files)
  })

  test("repair.start is refused before the baseline's verify and the ask", async () => {
    const w = await world()
    const { ref } = await codexRun(w)
    await endRun(w.codex, ref, { taskId: 'codex-1', generation: 1, status: 'halted', reason: 'G1 has a plan gap', source: 'notification' })
    const kinds = await kindsOf(w, ref)
    const r = (await recordRepairStart(ctxOf(w, w.p), { kind: 'repair.start', run: ref.run } as RecordInput)) as RecordReply & { error?: string }
    expect(r).toEqual(expect.objectContaining({ ok: false, error: `litter: run ${ref.run} ${ELSEWHERE}; litter won't act on it here` }))
    expect(existsSync(w.marker)).toBe(false)
    expect(w.p.asked).toEqual([])
    expect(await kindsOf(w, ref)).toEqual(kinds)
    // The record tool refuses it before its handler.
    const d = await dispatchRecord(w.p, undefined, { kind: 'repair.start', run: ref.run }, envOf(w))
    expect(d).toEqual(expect.objectContaining({ ok: false, error: `litter: run ${ref.run} ${ELSEWHERE}; nothing is recorded for it here` }))
  })
})

// ---------------------------------------------------------------------------
// The shared ledgers

const SWARM = 'alpha'
const W = ['Edit', 'Write', 'NotebookEdit']
const RO = { commit: false, push: 'none', forcePush: false, rewriteHistory: false, worktreeOps: false } as const
const spec = (goal: string): SwarmSpec => ({
  name: SWARM,
  goal,
  nodes: [{ id: 'port', kind: 'orchestrator', worktree: 'none', tools: { deny: W }, authority: RO, brief: 'briefs/port.md', task: 'Port it' }],
})
const stage = (litterDir: string, p: TestPorts, goal: string) =>
  stageProposal(p, litterDir, SWARM, { baseRevision: 1, spec: spec(goal), briefs: {}, changes: [{ path: 'goal', reason: 'the target' }] })

describe('the shared ledgers on Codex', () => {
  test("rule.propose and a swarm's proposal are refused, and a critic's proposals stay in its verdict", async () => {
    const w = await world()
    await saveRevision(w.p, w.litterDir, SWARM, { spec: spec('Base'), briefs: { port: 'Port it.\n' } }, { from: 'save', changes: [] })
    updateSession({ host: 'codex' })
    const r = await dispatchRecord(w.codex, undefined, { kind: 'rule.propose', rule: 'Freeze the clock in tests.' }, envOf(w))
    expect(r).toEqual(expect.objectContaining({ ok: false, error: "litter: the rules ledger isn't written on Codex yet; do it from Claude Code" }))
    await expect(stage(w.litterDir, w.codex, 'Port it to arm64')).rejects.toThrow("a swarm's spec ledger isn't written on Codex yet; do it from Claude Code")
    await proposeFromCritic(w.codex, w.litterDir, { run: '20261009-x', rule: 'Keep fixtures small.', source: 'critic', by: MOD, index: 0, tool_use_id: 'tu1' })
    expect((await readRuleLedger(w.codex, w.litterDir, 'repo')).records).toEqual([])
    expect((await readSpecLedger(w.codex, w.litterDir, SWARM)).records.map(x => x.kind)).not.toContain('swarm.proposal')
  })

  test("summary.md lists the critic's proposals the rules ledger hasn't, with the way to keep one", async () => {
    const w = await world()
    const { ref } = await codexRun(w)
    const critic = { source: 'agent', agentId: 'gc-1', agentType: 'litter:gate-critic' } as const
    await appendRecord(w.codex, ref.runDir, { run: ref.run, kind: 'verify', by: critic, body: { verify_id: 'v1', gate: 'G1', attempt: 1, green: true } })
    await appendRecord(w.codex, ref.runDir, {
      run: ref.run,
      kind: 'verdict',
      by: critic,
      body: { verify_id: 'v1', tool_use_id: 'tu1', proposed_rules: ['Freeze the clock in tests.', '', 'Keep fixtures small.'] },
    })
    const json = JSON.parse(await w.p.fs.read(join(ref.runDir, 'run.json'))) as RunJson
    const summary = async (q: TestPorts) => (await executeSummary(q, ref, json, (await readLedger(q, ref.runDir, ref.run)).records)).join('\n')
    updateSession({ host: 'codex' })
    let text = await summary(w.codex)
    expect(text).toContain(
      [
        '## Rules the critic proposed',
        '',
        "Codex doesn't write the rules ledger yet, so /litter rules doesn't list these. To keep one, add it from Claude Code with /litter:rules add.",
        '',
        '- Freeze the clock in tests. (gate G1)',
        '- Keep fixtures small. (gate G1)',
      ].join('\n'),
    )
    // On Claude Code, a proposal the rules ledger has is listed as proposed instead; the one it hasn't is still listed here.
    updateSession({ host: 'claude-code' })
    await proposeFromCritic(w.p, w.litterDir, { run: ref.run, rule: 'Freeze the clock in tests.', source: 'critic', by: critic, index: 0, tool_use_id: 'tu1', gate: 'G1' })
    text = await summary(w.p)
    expect(text).toContain('## Rules proposed in this run')
    expect(text).toContain("These didn't reach the rules ledger (the log says why), so /litter rules doesn't list them. To keep one, add it with /litter:rules add.\n\n- Keep fixtures small. (gate G1)")
    expect(text.split('\n').filter(l => l.startsWith('- Freeze the clock in tests.'))).toHaveLength(1)
  })
})

describe('the shared ledgers on Claude Code, after a lost store', () => {
  let rw: RulesWorld
  let restore: () => void
  afterEach(() => {
    restore()
    rw.cleanup()
  })

  test('accepting a rule still records it, and the chain has a v2 head again', async () => {
    rw = await rulesWorld()
    restore = fakePatterns()
    const ref = await propose(rw, { rule: 'Pin every action to a commit.', type: 'ban', paths: ['.github/**'], when: 'editing a workflow' })
    rw.p.storeMap.clear()
    expect((await readRuleLedger(rw.p, rw.litterDir, 'repo')).anchor).toBe('none')
    expect(await acceptRule(rw.p, rw.litterDir, { proposal: ref }, { scope: 'project' })).toEqual(expect.objectContaining({ ok: true }))
    expect((await readRuleLedger(rw.p, rw.litterDir, 'repo')).records.map(r => r.kind)).toEqual(['rule.propose', 'rule.accept'])
    expect(rw.p.storeMap.get(headKey(repoRulesLedgerDir(rw.litterDir)))).toEqual(expect.objectContaining({ v: 2, seq: 2 }))
    // And a rule.propose through the tool appends after it.
    expect((await appendRuleRecord(rw.p, rw.litterDir, 'repo', 'rule.propose', { source: 'launcher' }, { rule: 'r', source: 'user' })).seq).toBe(3)
  })

  test("a swarm's proposal is still staged, and its spec ledger has a v2 head again", async () => {
    rw = await rulesWorld()
    restore = () => {}
    await saveRevision(rw.p, rw.litterDir, SWARM, { spec: spec('Base'), briefs: { port: 'Port it.\n' } }, { from: 'save', changes: [] })
    rw.p.storeMap.clear()
    expect((await readSpecLedger(rw.p, rw.litterDir, SWARM)).anchor).toBe('none')
    expect((await stage(rw.litterDir, rw.p, 'Port it to arm64')).n).toBe(1)
    expect(rw.p.storeMap.get(headKey(swarmDir(rw.litterDir, SWARM)))).toEqual(expect.objectContaining({ v: 2 }))
  })
})
