// Tier 2: the failed-fanout bridge (hooks/repair.ts; WP-X, COMMON 2b-2 steps
// 3, 4 and 6), against real git: the eligibility checks in their order, each
// failing alone, and each of 15.11's three failures starting a repair; the
// auto path with no ask and no fill, its start submitted only from a timer;
// every refusal writing nothing past repair.declined; repair.start's own ask,
// Cancel and Launch; repair.budget granted, cancelled and refused; recovery
// of a repair swarm and of its pending start; the generated spec passing J's
// real validateSpec; and the builder's Launch refusing verify and land. W's
// reopen and generation end, and main's runVerify, are stood in for (deps).

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordCtx, RecordReply, StoredRecord } from '../../hooks/records/core'
import type { RunEndBody, RunJson } from '../../hooks/records/run'
import type { VerifyBody } from '../../hooks/records/execute'
import type { SwarmStartBody } from '../../hooks/records/swarm'
import type { RepairOpen, RepairOutcome } from '../../hooks/lifecycle'
import type { RunFacts, VerifyRun } from '../../hooks/verify'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { integrationBranch, integrationName, ledgerDir, ledgerFileName, runDir as runDirOf, runJsonPath, summaryPath, swarmDir } from '../../hooks/layout'
import { sha256 } from '../../hooks/fsx'
import { normalizeOptions } from '../../hooks/options'
import { MOD } from '../../hooks/verify'
import { runState } from '../../hooks/lifecycle'
import { appendLaunchRecord, readLaunchLedger } from '../../hooks/records/swarm'
import { interactive, liveSwarm, patchLiveSwarm, putBinding, resetForTests, setInteractive } from '../../hooks/swarm/state'
import { validateCtxFor, validateSpec } from '../../hooks/swarm/spec'
import { launchSwarm, nodeTypeSpec } from '../../hooks/swarm/launch'
import { recoverSwarms } from '../../hooks/swarm/recover'
import * as repairPrompts from '../../hooks/prompts/swarm-repair'
import { REPAIR_NOTE, REPAIR_START } from '../../hooks/prompts/swarm-repair'
import {
  AUTHORITY_COMMIT_NO,
  AUTHORITY_COMMIT_YES,
  AUTHORITY_LAND_YES,
  AUTHORITY_PUSH_NONE,
  AUTHORITY_VERDICTS_YES,
  AUTHORITY_VERIFY_YES,
} from '../../hooks/prompts/swarm-node'
import { renderSlots } from '../../hooks/prompts/slots'
import {
  continueAsRepair,
  deps as repairDeps,
  recordRepairBudget,
  recordRepairStart,
  repairNote,
  repairSpec,
  repairSummary,
  repairTurnComplete,
  resetRepairForTests,
} from '../../hooks/repair'
import { aSpec, refOf, saveSwarm, settle, world, type World } from './swarmlaunch-harness'
import { runAfters, SUBMIT_REFUSED, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const RUN = '20261003-fan'
const originals = { ...repairDeps }

type Failure = 'verify' | 'verdict' | 'conflict' | 'skip' | 'blocked' | 'approved'
type Opts = { failure?: Failure; mode?: 'auto' | 'off'; repair?: boolean; source?: RunEndBody['source'] }

let w: World
let runDir: string
let name: string
let base: string
let wt: string
/** What the stand-ins were asked, and how they answer. */
let calls: { reopened: RepairOpen[]; ended: RepairOutcome[]; verifies: VerifyRun[]; summaries: number }
let baselineGreen: boolean
let reopenRefusal: string | null

beforeEach(async () => {
  w = await world('sess-a')
  resetRepairForTests()
  setInteractive(true)
  runDir = runDirOf(w.litterDir, RUN)
  name = `repair-${(await sha256(runDir)).slice(0, 6)}`
  calls = { reopened: [], ended: [], verifies: [], summaries: 0 }
  baselineGreen = true
  reopenRefusal = null
  Object.assign(repairDeps, {
    // W's reopen: run.repair for the next generation (it counts run.repair as one), and the link.
    reopenForRepair: async (p: TestPorts, dir: string, open: RepairOpen) => {
      calls.reopened.push(open)
      if (reopenRefusal) return { ok: false, reason: reopenRefusal }
      const st = runState((await readLedger(p, dir, RUN)).records)
      const generation = st.generations.length + 1
      await appendRecord(p, dir, { run: RUN, kind: 'run.repair', by: MOD, body: { generation, ...open } })
      return { ok: true, link: { runDir: dir, run: RUN, generation } }
    },
    endRepairGeneration: async (_p: TestPorts, _dir: string, outcome: RepairOutcome) => {
      calls.ended.push(outcome)
      return { recorded: true, end: { taskId: null, generation: 2, status: outcome.status, reason: outcome.reason, source: 'mod' } }
    },
    writeSummary: async (...a: Parameters<typeof originals.writeSummary>) => {
      calls.summaries++
      await originals.writeSummary(...a)
    },
    // main's runVerify: a verify record in the run's ledger, green or red as the spec says.
    runVerify: async (p: TestPorts, f: RunFacts, o: VerifyRun) => {
      calls.verifies.push(o)
      const verifyId = `v${calls.verifies.length + 10}`
      const body = verifyBodyOf(verifyId, o.gate, baselineGreen)
      const rec = await appendRecord(p, f.runDir, { run: f.run, kind: 'verify', by: o.by, body })
      return { ok: true, body, seq: rec.seq, log: join(f.runDir, 'verify', verifyId) }
    },
  } as Partial<typeof repairDeps>)
})
afterEach(async () => {
  Object.assign(repairDeps, originals)
  resetRepairForTests()
  await w.done()
})

function verifyBodyOf(verifyId: string, gate: string, green: boolean): VerifyBody {
  return {
    verify_id: verifyId,
    gate,
    attempt: 1,
    argv: ['true'],
    tree_before: 't',
    tree_after: 't',
    dirty_submodules: [],
    exit_code: green ? 0 : 1,
    signal: null,
    timed_out: false,
    spawn_error: null,
    green,
    log_parts: 1,
    log_bytes: 10,
    output_tail: green ? 'ok' : 'FAIL client reads the wrong field',
  }
}

/**
 * A halted fanout of two writers, server/ and client/, built as the mod
 * leaves it: the checkout on litter/<run> at base, the integration worktree
 * kept, run.json and its run.start (sha-checked), then the integration's
 * records for the failure asked for, and run.end halted.
 */
async function fanout(o: Opts = {}): Promise<RunJson> {
  const failure = o.failure ?? 'verify'
  base = (await w.git('rev-parse', 'HEAD')).trim()
  await w.git('switch', '-q', '-c', `litter/${RUN}`)
  wt = join(w.dir, '.claude', 'worktrees', integrationName(RUN))
  await w.git('worktree', 'add', '-q', '-b', integrationBranch(RUN), wt, base)
  const json = {
    v: 1,
    run: RUN,
    workflow: 'fanout',
    args: {
      tasks: [
        { id: 'server', title: 'Serve the API', text: 'Add the /items endpoint in server/.', writes: true, files: ['server/'] },
        { id: 'client', title: 'Call the API', text: 'Call /items from client/.', writes: true, files: ['client/'] },
      ],
      contract: 'GET /items answers { items: [] }',
    },
    authorized: ['commit on litter branches'],
    mode: 'default',
    verify: ['true'],
    goalCheck: null,
    setup: null,
    linkDirs: [],
    base,
    ref: `refs/heads/litter/${RUN}`,
    checkout: w.dir,
    isolate: false,
    previousBranch: 'main',
    continueOf: null,
    amendOf: null,
    rules: [],
    planPath: null,
    planSha256: null,
    session: 'sess-a',
    created: 1,
    ...(o.repair === false ? {} : { repair: { mode: o.mode ?? 'auto', rounds: 3, agents: 6 } }),
  } as RunJson
  const text = `${JSON.stringify(json, null, 2)}\n`
  await w.p.fs.write(runJsonPath(runDir), text)
  const add = (kind: string, body: Record<string, unknown>) => appendRecord(w.p, runDir, { run: RUN, kind, by: MOD, body })
  await add('run.start', {
    workflow: 'fanout',
    base,
    ref: json.ref,
    checkout: w.dir,
    isolate: false,
    previousBranch: 'main',
    verify: ['true'],
    goalCheck: null,
    setup: null,
    authorized: json.authorized,
    mode: 'default',
    continueOf: null,
    amendOf: null,
    planSha256: null,
    argsSha256: 'a'.repeat(64),
    runJsonSha256: await sha256(text),
    oid: '1'.repeat(40),
    session: 'sess-a',
  })
  await add('run.launch', { taskId: 'task-1', runId: 'wf_1', scriptPath: null, generation: 1, session: 'sess-a', oid: '1'.repeat(40) })
  await add('worktree.create', { run: RUN, name: integrationName(RUN), path: wt, branch: integrationBranch(RUN), base, disposable: false, ignored: [] })
  const tree = (await w.git('rev-parse', `${base}^{tree}`)).trim()
  const merge = (task: string, n: number) => add('integrate.merge', { task, branch: `litter/${RUN}-w${n}`, commit: base, paths: [] })
  const done = (blocked: string[] = []) => add('integrate.done', { tip: base, tree, changed: [], blocked })
  if (failure === 'conflict') {
    await merge('server', 1)
    await add('integrate.conflict', { task: 'client', branch: `litter/${RUN}-w2`, files: ['client/api.ts'] })
  } else if (failure === 'skip') {
    await merge('server', 1)
    await add('integrate.skip', { task: 'client', reason: 'it returned blocked' })
    await done()
  } else {
    await merge('server', 1)
    await merge('client', 2)
    await done(failure === 'blocked' ? ['server/x.ts is owned by no task'] : [])
  }
  if (failure === 'verify' || failure === 'verdict' || failure === 'approved') {
    await add('verify', { ...verifyBodyOf('v1', 'integration', failure !== 'verify') })
  }
  if (failure === 'verdict' || failure === 'approved') {
    await add('verdict', {
      verify_id: 'v1',
      tasks: [
        { id: 'server', pass: true, evidence: 'server/items.ts:4', gaps: [] },
        { id: 'client', pass: failure === 'approved', evidence: 'client/api.ts:9 reads data, not items', gaps: failure === 'approved' ? [] : ['the field name'] },
      ],
      combined: 'the two read the contract differently',
    })
  }
  if (failure === 'approved') await add('land.blocked', { gate: 'fanout', reason: 'the checkout changed after the launch' })
  await add('run.end', { taskId: 'task-1', generation: 1, status: 'halted', reason: 'not verified', source: o.source ?? 'notification' })
  return json
}

const records = async (): Promise<StoredRecord[]> => (await readLedger(w.p, runDir, RUN)).records
/** The run ledger's kinds after its run.end. */
async function afterEnd(): Promise<string[]> {
  const rs = await records()
  return rs.slice(rs.findIndex(r => r.kind === 'run.end') + 1).map(r => r.kind)
}
const declinedReason = async (): Promise<string | null> => {
  const r = (await records()).filter(x => x.kind === 'repair.declined').at(-1)
  return r ? String(r.body.reason) : null
}
const pendingKey = () => `litter.repair.start.${w.litterDir}`
const leadTurn = { turnId: 'turn-1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as unknown as Parameters<typeof repairTurnComplete>[1]
const ctxOf = (p: TestPorts = w.p): RecordCtx => ({ p, caller: { agentId: null, agentType: null }, litterDir: w.litterDir, options: normalizeOptions(undefined) })

/** Nothing of a repair was written past repair.declined (and the baseline's own verify): no reopen, swarm, ref, start or ask. */
async function nothingStarted(): Promise<void> {
  expect(calls.reopened).toEqual([])
  expect(existsSync(swarmDir(w.litterDir, name))).toBe(false)
  expect(await refOf(w, name)).toBeNull()
  expect(liveSwarm(name)).toBeNull()
  expect(w.p.storeMap.has(pendingKey())).toBe(false)
  expect(w.p.asked).toEqual([])
  expect(w.p.filled).toEqual([])
  expect(w.p.submitted).toEqual([])
  expect(w.p.afters).toEqual([])
}

async function startOf(launch: string): Promise<SwarmStartBody> {
  const { records: rs } = await readLaunchLedger(w.p, w.litterDir, name, launch)
  return rs.find(r => r.kind === 'swarm.start')!.body as unknown as SwarmStartBody
}

// ---------------------------------------------------------------------------

describe('the bridge under repair: auto', () => {
  test('a red integration verify starts the repair swarm: no ask, no fill, the start submitted only from a timer after the turn', async () => {
    await fanout({ failure: 'verify' })
    await continueAsRepair(w.p, runDir)

    // The baseline in the checkout, as gate baseline, then W's reopen with the swarm, its launch and the run's budget.
    expect(calls.verifies).toEqual([{ gate: 'baseline', attempt: 1, where: w.dir, by: MOD, timeoutMs: normalizeOptions(undefined).verifyTimeoutMs }])
    expect(calls.reopened).toEqual([{ swarm: name, launch: expect.any(String), budget: { rounds: 3, agents: 6 } }])
    expect(await afterEnd()).toEqual(['verify', 'run.repair'])
    const launch = calls.reopened[0]!.launch
    const s = liveSwarm(name)!
    expect(s).toEqual(expect.objectContaining({ launch, run: { runDir, run: RUN, generation: 2 }, budget: { rounds: 3, agents: 6 }, readOnly: false, state: 'live' }))
    const start = await startOf(launch)
    expect(start.confirmedBy).toEqual({ run: RUN })
    expect(start.run).toEqual({ runDir, run: RUN, generation: 2 })
    expect(start.budget).toEqual({ rounds: 3, agents: 6 })
    expect(Object.keys(start.authority)).toEqual(['repair', 'fixer', 'critic'])
    expect(await refOf(w, name)).not.toBeNull()
    // The spec saved as a revision from the repair.
    const { records: spec } = await readLedger(w.p, swarmDir(w.litterDir, name), `swarm:${name}`)
    expect(spec.find(r => r.kind === 'swarm.revision')?.body).toEqual(expect.objectContaining({ n: 1, from: 'repair' }))
    expect(calls.summaries).toBe(1)

    // No ask, no prompt fill: the fanout's own confirmation covers it.
    expect(w.p.asked).toEqual([])
    expect(w.p.filled).toEqual([])
    // The notification turn's context line, while it waits.
    const note = renderSlots(REPAIR_NOTE, { swarm: name, run: RUN })
    expect(repairNote(w.p)).toBe(note)
    expect(note).toContain(`repair swarm ${name} is live for run ${RUN}; litter starts it after this turn`)

    // A subagent's turn and an interrupted lead turn schedule nothing.
    await repairTurnComplete(w.p, { ...leadTurn, agentId: 'agent-7' } as never)
    await repairTurnComplete(w.p, { ...leadTurn, isAborted: true, reason: 'aborted' } as never)
    expect(w.p.afters).toEqual([])
    // The lead's turn.complete schedules the submit, and submits nothing itself.
    await repairTurnComplete(w.p, leadTurn)
    expect(w.p.afters.map(a => a.ms)).toEqual([0])
    expect(w.p.submitted).toEqual([])
    expect(w.p.logs.some(l => l.includes(SUBMIT_REFUSED))).toBe(false)
    // Handed to a timer, it's no longer waiting: the start's own turn carries no note, and a second turn.complete adds nothing.
    expect(repairNote(w.p)).toBeNull()
    await repairTurnComplete(w.p, leadTurn)
    expect(w.p.afters).toHaveLength(1)
    expect(await runAfters(w.p)).toBe(1)
    const text = renderSlots(REPAIR_START, { swarm: name, run: RUN })
    expect(w.p.submitted).toEqual([text])
    expect(text.startsWith('/')).toBe(false)
    expect(text).toContain(`run the litter swarm skill with start ${name}`)
    // Submitted once: kept in the store as submitted, until the orchestrator is spawned.
    expect(w.p.storeMap.get(pendingKey())).toEqual([expect.objectContaining({ swarm: name, launch, run: RUN, submitted: true })])
    // The start's own turn ends with no orchestrator: the timer after it fills the start line, and submits nothing more (WP-AS, repairfill.spec.ts).
    await repairTurnComplete(w.p, leadTurn)
    expect(w.p.afters).toHaveLength(2)
    expect(await runAfters(w.p)).toBe(1)
    expect(w.p.submitted).toEqual([text])
    expect(w.p.filled.map(f => f.split('\n')[0])).toEqual([`/litter:swarm start ${name}`])
  })

  for (const failure of ['verdict', 'conflict'] as const) {
    test(`${failure === 'verdict' ? 'a verifier rejecting a task' : 'a merge that stopped at a conflict'} starts it too`, async () => {
      await fanout({ failure })
      await continueAsRepair(w.p, runDir)
      expect(await afterEnd()).toEqual(['verify', 'run.repair'])
      expect(liveSwarm(name)?.run).toEqual({ runDir, run: RUN, generation: 2 })
      expect(w.p.asked).toEqual([])
      expect(w.p.filled).toEqual([])
      expect(repairNote(w.p)).toContain(`repair swarm ${name}`)
    })
  }

  test('a run.json from before 2b-2 (no repair setting) is a no-op: nothing recorded', async () => {
    await fanout({ repair: false })
    await continueAsRepair(w.p, runDir)
    expect(await afterEnd()).toEqual([])
    await nothingStarted()
  })

  test('a second call after a decline adds nothing', async () => {
    await fanout({ mode: 'off' })
    await continueAsRepair(w.p, runDir)
    await continueAsRepair(w.p, runDir)
    expect(await afterEnd()).toEqual(['repair.declined'])
  })
})

describe('the eligibility checks, each failing alone', () => {
  type Case = { what: string; set: () => Promise<void> | void; opts?: Opts; reason: string; verified?: boolean }
  const cases: Case[] = [
    { what: 'repair: off', set: () => {}, opts: { mode: 'off' }, reason: 'repair is off for this run' },
    { what: 'an end found at reconcile', set: () => {}, opts: { source: 'reconcile' }, reason: 'found at session start' },
    { what: 'a skipped task', set: () => {}, opts: { failure: 'skip' }, reason: "task client wasn't merged (it returned blocked), and a repair swarm takes on only" },
    { what: 'an ownership refusal', set: () => {}, opts: { failure: 'blocked' }, reason: 'the combined change failed the ownership check (server/x.ts is owned by no task)' },
    { what: 'a land refused after an approval', set: () => {}, opts: { failure: 'approved' }, reason: 'its land was refused (the checkout changed after the launch)' },
    { what: 'a non-interactive session', set: () => setInteractive(false), reason: "no one to watch it: this session isn't interactive" },
    { what: 'a spec that fails validation', set: () => void (w.check = { ok: false, errors: [{ field: 'nodes.repair.paths', node: 'repair', error: 'a bad path' }], warnings: [] }), reason: 'nodes.repair.paths: a bad path' },
    { what: 'a health check error', set: () => void (w.health = { rows: [{ id: 'depth', severity: 'error', title: 'Spawn depth', detail: 'too shallow' }], errors: 1, warnings: 0, snippet: null }), reason: 'Spawn depth: too shallow' },
    {
      what: 'the integration worktree gone',
      set: async () => void (await w.git('worktree', 'remove', '--force', wt)),
      reason: `run ${RUN}'s integration worktree ${'{wt}'} is gone`,
    },
    {
      what: 'the run lock held',
      set: async () => {
        const blob = JSON.stringify({ run: '20261003-other', session: 'sess-b', acquiredAt: 1 })
        const r = await w.p.run(['git', '-C', w.dir, 'hash-object', '-w', '--stdin'], { stdin: blob })
        await w.git('update-ref', 'refs/litter-active', r.stdout.trim())
      },
      reason: 'the run lock is held by run 20261003-other (session sess-b)',
    },
    { what: 'the checkout on another branch', set: async () => void (await w.git('switch', '-q', 'main')), reason: `the checkout changed: ${'{dir}'} is on main, not the run's branch litter/${RUN}` },
    { what: 'the checkout with a change', set: async () => void (await w.p.fs.write(join(w.dir, 'notes.txt'), 'mine\n')), reason: 'no longer matches the run\'s base' },
    { what: 'a red baseline', set: () => void (baselineGreen = false), reason: "the baseline verify v11 wasn't green on the run's base (exit 1)", verified: true },
    {
      what: "a baseline that can't run",
      set: () => void (repairDeps.runVerify = async () => ({ ok: false, error: 'litter: the snapshot before the verify failed: boom' })),
      reason: "the baseline verify couldn't run: the snapshot before the verify failed: boom",
    },
  ]
  for (const c of cases) {
    test(`${c.what}: repair.declined with the reason, and nothing else`, async () => {
      await fanout(c.opts)
      await c.set()
      await continueAsRepair(w.p, runDir)
      const reason = c.reason.replace('{wt}', wt).replace('{dir}', w.dir)
      expect(await declinedReason()).toContain(reason)
      expect(await afterEnd()).toEqual(c.verified ? ['verify', 'repair.declined'] : ['repair.declined'])
      await nothingStarted()
      expect(calls.summaries).toBe(1)
      expect(existsSync(summaryPath(runDir))).toBe(true)
    })
  }

  test('the checks run in COMMON\'s order: off wins over a non-interactive session and a held lock', async () => {
    await fanout({ mode: 'off', failure: 'skip' })
    setInteractive(false)
    await continueAsRepair(w.p, runDir)
    expect(await declinedReason()).toBe('repair is off for this run')
  })

  test('an unknown session (no answer yet) declines as non-interactive', async () => {
    await fanout()
    // A fresh state module: interactive() is null until session.start or a prompt answers it.
    resetForTests()
    expect(interactive()).toBeNull()
    await continueAsRepair(w.p, runDir)
    expect(await declinedReason()).toContain('no one to watch it')
    await nothingStarted()
  })

  test('a refused reopen declines and leaves no swarm folder; a failure after it ends the generation halted', async () => {
    await fanout()
    reopenRefusal = 'the run lock is held'
    await continueAsRepair(w.p, runDir)
    expect(await declinedReason()).toBe('the run lock is held')
    expect(existsSync(swarmDir(w.litterDir, name))).toBe(false)
    expect(calls.ended).toEqual([])
  })

  test('a launch failure after the reopen ends the repair generation halted, with no decline', async () => {
    await fanout()
    w.p.registerAgentAnswer = () => {
      throw new Error('the engine refused it')
    }
    await continueAsRepair(w.p, runDir)
    expect(await afterEnd()).toEqual(['verify', 'run.repair'])
    expect(calls.ended).toEqual([{ status: 'halted', reason: expect.stringContaining('the engine refused the types') }])
    expect(liveSwarm(name)).toBeNull()
    expect(w.p.storeMap.has(pendingKey())).toBe(false)
  })
})

describe('repair.start, under repair: off', () => {
  test('Cancel writes nothing but the baseline; the ask shows the authority and the budget', async () => {
    await fanout({ mode: 'off' })
    w.p.answers.push('Cancel')
    const r = (await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as RecordReply & { error?: string }
    expect(r).toEqual({ ok: false, error: `litter: the repair of run ${RUN} wasn't confirmed; nothing was started` })
    expect(w.p.asked).toHaveLength(1)
    const q = w.p.asked[0]!
    expect(q.options).toEqual(['Launch', 'Cancel'])
    expect(q.question).toContain(`Start repair swarm ${name} for fanout run ${RUN}?`)
    expect(q.question).toContain('Budget: up to 3 rounds and 6 agents')
    expect(q.question).toContain("verify yes (the mod runs the run's verify)")
    expect(q.question).toContain('land yes (the mod lands only a verified, approved tree)')
    expect(q.question).toContain('verdicts yes (the veto a land needs)')
    expect(q.question).toContain('Baseline: verify v11 is green')
    expect(await afterEnd()).toEqual(['verify'])
    expect(calls.reopened).toEqual([])
    expect(existsSync(swarmDir(w.litterDir, name))).toBe(false)
    expect(await refOf(w, name)).toBeNull()
    expect(w.p.filled).toEqual([])
  })

  test('Launch goes live with confirmedBy ask, and fills the start line for your Enter', async () => {
    await fanout({ mode: 'off' })
    w.p.answers.push('Launch')
    const r = (await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as Record<string, unknown>
    expect(r).toEqual(expect.objectContaining({ ok: true, run: RUN, swarm: name, generation: 2, budget: { rounds: 3, agents: 6 } }))
    expect(String(r.next)).toContain("Don't start it yourself")
    const launch = String(r.launch)
    expect((await startOf(launch)).confirmedBy).toEqual({ ask: true })
    expect(w.p.filled).toHaveLength(1)
    expect(w.p.filled[0]!.split('\n')[0]).toBe(`/litter:swarm start ${name}`)
    expect(w.p.filled[0]).toContain('repair: commit unchecked; push: the lead pushes nothing for it')
    // No timer start: the fill is the start.
    expect(repairNote(w.p)).toBeNull()
    expect(w.p.afters).toEqual([])
  })

  test('with no one to ask (-p), and for a run that has a repair or a failure no repair takes, it refuses', async () => {
    await fanout({ mode: 'off' })
    const asked = (await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as { ok: boolean; error?: string }
    expect(asked.error).toContain('needs your confirmation')
    expect(calls.reopened).toEqual([])
    w.p.answers.push('Launch')
    expect(((await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as { ok: boolean }).ok).toBe(true)
    const again = (await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as { ok: boolean; error?: string }
    expect(again.error).toContain(`run ${RUN} has a repair already: swarm ${name}`)
  })

  test('a skipped task is refused, with the advice', async () => {
    await fanout({ mode: 'off', failure: 'skip' })
    const r = (await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as { ok: boolean; error?: string; field?: string }
    expect(r).toEqual({ ok: false, field: 'run', error: expect.stringContaining("rerun the tasks that weren't merged") })
    expect(await afterEnd()).toEqual([])
    expect(w.p.asked).toEqual([])
  })

  test('after an auto decline (a non-interactive session), repair.start can still start it', async () => {
    await fanout()
    setInteractive(false)
    await continueAsRepair(w.p, runDir)
    expect(await declinedReason()).toContain('no one to watch it')
    w.p.answers.push('Launch')
    expect(((await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as { ok: boolean }).ok).toBe(true)
    expect(await afterEnd()).toEqual(['repair.declined', 'verify', 'run.repair'])
  })
})

describe('repair.budget', () => {
  async function started(): Promise<string> {
    await fanout()
    await continueAsRepair(w.p, runDir)
    return calls.reopened[0]!.launch
  }
  const budgetEvents = async (launch: string) =>
    (await readLaunchLedger(w.p, w.litterDir, name, launch)).records.filter(r => r.kind === 'swarm.event' && r.body.kind === 'budget').map(r => r.body)

  test('granted: the mod asks, raises the budget, and records the event', async () => {
    const launch = await started()
    w.p.answers.push('Grant')
    const r = (await recordRepairBudget(ctxOf(), { kind: 'repair.budget', swarm: name, rounds: 2 })) as Record<string, unknown>
    expect(r).toEqual(expect.objectContaining({ ok: true, swarm: name, granted: true, budget: { rounds: 5, agents: 6 } }))
    expect(w.p.asked[0]!.question).toContain(`Give repair swarm ${name} 2 more rounds?`)
    expect(w.p.asked[0]!.options).toEqual(['Grant', 'Cancel'])
    expect(liveSwarm(name)?.budget).toEqual({ rounds: 5, agents: 6 })
    expect(await budgetEvents(launch)).toEqual([{ kind: 'budget', requested: { rounds: 2 }, granted: true, budget: { rounds: 5, agents: 6 } }])
  })

  test('cancelled, or no one to ask: nothing changes, and the event says not granted', async () => {
    const launch = await started()
    w.p.answers.push('Cancel')
    const r = (await recordRepairBudget(ctxOf(), { kind: 'repair.budget', swarm: name, agents: 4 })) as Record<string, unknown>
    expect(r).toEqual(expect.objectContaining({ ok: true, granted: false, budget: { rounds: 3, agents: 6 } }))
    const headless = (await recordRepairBudget(ctxOf(), { kind: 'repair.budget', swarm: name, rounds: 1, agents: 1 })) as Record<string, unknown>
    expect(headless).toEqual(expect.objectContaining({ ok: true, granted: false }))
    expect(liveSwarm(name)?.budget).toEqual({ rounds: 3, agents: 6 })
    expect((await budgetEvents(launch)).map(e => e.granted)).toEqual([false, false])
  })

  test("refused, asking nothing: a swarm that isn't live, isn't a repair swarm, or isn't this session's, and a bad request", async () => {
    const asError = async (input: Record<string, unknown>) => (await recordRepairBudget(ctxOf(), { kind: 'repair.budget', ...input })) as { ok: boolean; error?: string; field?: string }
    expect((await asError({ swarm: 'nope', rounds: 1 })).error).toBe("litter: swarm nope isn't live")
    await saveSwarm(w, aSpec())
    w.p.answers.push('Launch')
    expect((await launchSwarm(w.p, 'alpha')).ok).toBe(true)
    expect(w.p.asked).toHaveLength(1)
    expect((await asError({ swarm: 'alpha', rounds: 1 })).error).toContain("isn't a repair swarm")
    await started()
    patchLiveSwarm(name, { readOnly: true })
    expect((await asError({ swarm: name, rounds: 1 })).error).toContain('is owned by session')
    patchLiveSwarm(name, { readOnly: false })
    expect((await asError({ swarm: name, rounds: 0 })).field).toBe('rounds')
    expect((await asError({ swarm: name, agents: 51 })).field).toBe('agents')
    expect((await asError({ swarm: name })).error).toContain('how many more')
    expect(w.p.asked).toHaveLength(1)
  })
})

describe('recovery', () => {
  test("a repair swarm's run and raised budget come back from swarm.start and its budget event", async () => {
    await fanout()
    await continueAsRepair(w.p, runDir)
    w.p.answers.push('Grant')
    await recordRepairBudget(ctxOf(), { kind: 'repair.budget', swarm: name, agents: 3 })
    const q = await w.restart('sess-a')
    resetRepairForTests()
    setInteractive(true)
    await recoverSwarms(q, w.litterDir)
    const s = liveSwarm(name)!
    expect(s.readOnly).toBe(false)
    expect(s.run).toEqual({ runDir, run: RUN, generation: 2 })
    expect(s.budget).toEqual({ rounds: 3, agents: 9 })
  })

  test('a start that never ran survives the reload: the next prompt carries the note, and its turn.complete submits it', async () => {
    await fanout()
    await continueAsRepair(w.p, runDir)
    const q = await w.restart('sess-a')
    resetRepairForTests()
    setInteractive(true)
    expect(repairNote(q)).toBeNull()
    await recoverSwarms(q, w.litterDir)
    // Nothing is submitted at session.start itself.
    expect(q.afters).toEqual([])
    expect(repairNote(q)).toBe(renderSlots(REPAIR_NOTE, { swarm: name, run: RUN }))
    await repairTurnComplete(q, leadTurn)
    await runAfters(q)
    expect(q.submitted).toEqual([renderSlots(REPAIR_START, { swarm: name, run: RUN })])
  })

  test('a pending start is dropped once its orchestrator spawned, or its launch ended', async () => {
    await fanout()
    await continueAsRepair(w.p, runDir)
    const launch = calls.reopened[0]!.launch
    const s = liveSwarm(name)!
    putBinding({
      agentId: 'ag-1',
      swarm: name,
      launch,
      node: 'repair',
      n: 1,
      kind: 'orchestrator',
      of: null,
      parent: null,
      type: s.types.repair!,
      cwd: wt,
      branch: `refs/heads/${integrationBranch(RUN)}`,
      token: 'tok',
      revision: 1,
      generation: 1,
      boundAt: 1,
      adopted: false,
    })
    expect(repairNote(w.p)).toBeNull()
    await repairTurnComplete(w.p, leadTurn)
    expect(w.p.afters).toEqual([])
    expect(w.p.storeMap.has(pendingKey())).toBe(false)
  })

  test('a pending start whose launch ended is dropped at recovery', async () => {
    await fanout()
    await continueAsRepair(w.p, runDir)
    const launch = calls.reopened[0]!.launch
    await settle(w.p)
    await appendLaunchRecord(w.p, w.litterDir, name, launch, 'swarm.end', { status: 'ended', settled: true, nodes: {}, worktrees: [], branches: [] })
    const q = await w.restart('sess-a')
    resetRepairForTests()
    await recoverSwarms(q, w.litterDir)
    expect(q.storeMap.has(pendingKey())).toBe(false)
    expect(repairNote(q)).toBeNull()
  })

  test("a submit the host refuses is logged with a toast, and the next lead turn tries again", async () => {
    await fanout()
    await continueAsRepair(w.p, runDir)
    w.p.submitAnswer = () => {
      throw new Error('the session is busy')
    }
    await repairTurnComplete(w.p, leadTurn)
    await runAfters(w.p)
    expect(w.p.logs.some(l => l.includes(`repair swarm ${name}: its start wasn't submitted: the session is busy`))).toBe(true)
    expect(w.p.toasts).toContain(`repair swarm ${name} is live; send /litter:swarm start ${name} to start it`)
    w.p.submitAnswer = undefined
    await repairTurnComplete(w.p, leadTurn)
    await runAfters(w.p)
    expect(w.p.submitted).toHaveLength(2)
  })
})

describe('the generated spec', () => {
  test('it validates with J\'s real validateSpec for a run with two tasks, from run facts only', async () => {
    await fanout({ failure: 'verdict' })
    const r = await repairSpec(w.p, runDir)
    if (!r.ok) throw new Error(r.reason)
    const ctx = await validateCtxFor(w.p, w.litterDir, async node => r.briefs[node] ?? null)
    const check = await validateSpec(w.p, r.spec, ctx)
    expect(check.errors).toEqual([])
    expect(check.ok).toBe(true)

    const [orch, fixer, critic] = r.spec.nodes
    expect(r.spec.name).toBe(name)
    expect(r.spec.limits).toEqual({ maxAgentsAtOnce: 4 })
    expect(orch).toEqual(
      expect.objectContaining({
        id: 'repair',
        kind: 'orchestrator',
        worktree: { existing: wt },
        tools: { deny: ['Edit', 'Write', 'NotebookEdit'] },
        spawns: { fixer: 2, critic: 1 },
        paths: ['client/', 'server/'],
      }),
    )
    // Commit unset: false would rank under the fixer's commit (15.3), true would make it a writer beside the fixer.
    expect(orch!.authority).toEqual({ push: 'none', rewriteHistory: false, worktreeOps: false, verify: true, land: true })
    expect(fixer).toEqual(expect.objectContaining({ id: 'fixer', kind: 'worker', worktree: 'inherit', serial: true, paths: ['client/', 'server/'] }))
    expect(fixer!.authority).toEqual(expect.objectContaining({ commit: true, push: 'none', verify: true }))
    expect(critic).toEqual(expect.objectContaining({ id: 'critic', verdicts: true, spawnOther: false, tools: { deny: ['Edit', 'Write', 'NotebookEdit'] } }))
    expect(critic!.authority).toEqual(expect.objectContaining({ commit: false, push: 'none', verify: true }))
    expect(Object.keys(r.briefs).sort()).toEqual(['critic', 'fixer', 'repair'])
    expect(r.briefs.repair).toContain('You never commit; your fixers do.')

    // The task holds mod facts and evidence paths, never task or verifier text.
    const task = orch!.task!
    const verdictSeq = (await records()).find(x => x.kind === 'verdict')!.seq
    expect(task).toContain(`Repair fanout run ${RUN}.`)
    expect(task).toContain('Failure: the verifier rejected task client')
    expect(task).toContain('Tasks: server and client')
    expect(task).toContain(summaryPath(runDir))
    expect(task).toContain(runJsonPath(runDir))
    expect(task).toContain(join(runDir, 'verify', 'v1'))
    expect(task).toContain(`${ledgerDir(runDir)}/${ledgerFileName(verdictSeq, 'verdict')}`)
    expect(task).toContain('Budget: 3 rounds and 6 agents')
    for (const text of ['Serve the API', 'Add the /items endpoint', 'reads data, not items', 'the field name', 'read the contract differently', 'GET /items']) {
      expect(task).not.toContain(text)
      expect(JSON.stringify(r.spec)).not.toContain(text)
    }
    expect(readFileSync(runJsonPath(runDir), 'utf8')).toContain('Serve the API')
  })

  test('its node types carry the verify, verdicts and land lines in order, and no repair text has a backtick or a dollar-brace', async () => {
    await fanout()
    const r = await repairSpec(w.p, runDir)
    if (!r.ok) throw new Error(r.reason)
    const orch = nodeTypeSpec(r.spec, 'repair', { brief: r.briefs.repair! }).prompt
    for (const line of [AUTHORITY_PUSH_NONE, AUTHORITY_VERIFY_YES, AUTHORITY_LAND_YES]) expect(orch).toContain(line)
    expect(orch.indexOf(AUTHORITY_PUSH_NONE)).toBeLessThan(orch.indexOf(AUTHORITY_VERIFY_YES))
    expect(orch.indexOf(AUTHORITY_VERIFY_YES)).toBeLessThan(orch.indexOf(AUTHORITY_LAND_YES))
    expect(orch).not.toContain(AUTHORITY_VERDICTS_YES)
    const critic = nodeTypeSpec(r.spec, 'critic', { brief: r.briefs.critic! })
    for (const line of [AUTHORITY_COMMIT_NO, AUTHORITY_VERIFY_YES, AUTHORITY_VERDICTS_YES]) expect(critic.prompt).toContain(line)
    expect(critic.prompt).not.toContain(AUTHORITY_LAND_YES)
    expect(critic.disallowedTools).toEqual(expect.arrayContaining(['Edit', 'Write', 'NotebookEdit', 'Agent']))
    const fixer = nodeTypeSpec(r.spec, 'fixer', { brief: r.briefs.fixer! }).prompt
    for (const line of [AUTHORITY_COMMIT_YES, AUTHORITY_VERIFY_YES]) expect(fixer).toContain(line)
    for (const [key, text] of Object.entries(repairPrompts)) {
      expect({ key, backtick: text.includes('`'), dollar: text.includes('${') }).toEqual({ key, backtick: false, dollar: false })
    }
    for (const text of [AUTHORITY_VERIFY_YES, AUTHORITY_VERDICTS_YES, AUTHORITY_LAND_YES]) expect(text.includes('`') || text.includes('${')).toBe(false)
  })

  test("a conflict's task names the conflicted files and what's merged", async () => {
    await fanout({ failure: 'conflict' })
    const r = await repairSpec(w.p, runDir)
    if (!r.ok) throw new Error(r.reason)
    const task = r.spec.nodes[0]!.task!
    expect(task).toContain(`the merge of task client (branch litter/${RUN}-w2) stopped at a conflict`)
    expect(task).toContain('merged before the conflict: server; stopped at: client')
    expect(task).toContain('the conflicted files, in your directory: client/api.ts')
    expect(task).not.toContain('verify/')
  })

  test("a failure no repair takes has no spec", async () => {
    await fanout({ failure: 'blocked' })
    const r = await repairSpec(w.p, runDir)
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('the ownership check') })
  })
})

describe("summary.md's Repair section", () => {
  test('declined: the reason and the recommendation, with the command', async () => {
    await fanout()
    setInteractive(false)
    await continueAsRepair(w.p, runDir)
    const text = await repairSummary(w.p, runDir)
    expect(text).toContain('## Repair')
    expect(text).toContain("No repair swarm started: no one to watch it: this session isn't interactive.")
    expect(text).toContain('Recommended: repair it as a swarm.')
    expect(text).toContain(`/litter:swarm repair ${RUN}`)
    expect(text).toContain('up to 3 rounds and 6 agents; nothing is pushed')
  })

  test('off: the recommendation; a red baseline: fix the base; another ending: the advice, not the swarm', async () => {
    await fanout({ mode: 'off' })
    await continueAsRepair(w.p, runDir)
    const off = await repairSummary(w.p, runDir)
    expect(off).toContain('No repair swarm started: repair is off for this run.')
    expect(off).toContain(`/litter:swarm repair ${RUN}`)
    // A red baseline from repair.start: no swarm recommended.
    baselineGreen = false
    expect(((await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as { ok: boolean }).ok).toBe(false)
    const red = await repairSummary(w.p, runDir)
    expect(red).toContain("The suite was red on the run's base")
    expect(red).not.toContain('/litter:swarm repair')
  })

  test('a skipped task gets its own advice', async () => {
    await fanout({ failure: 'skip' })
    await continueAsRepair(w.p, runDir)
    const text = await repairSummary(w.p, runDir)
    expect(text).toContain("A repair swarm can't take this on: task client wasn't merged")
    expect(text).not.toContain('/litter:swarm repair')
  })

  test('started: the swarm, its budget, and how to watch it; empty for a run with nothing to say', async () => {
    await fanout()
    await continueAsRepair(w.p, runDir)
    const text = await repairSummary(w.p, runDir)
    expect(text).toContain(`Repair swarm ${name} (launch ${calls.reopened[0]!.launch}) took over in generation 2, with a budget of 3 rounds and 6 agents.`)
    expect(text).toContain(`Watch it with /litter swarms ${name}`)
    expect(await repairSummary(w.p, join(w.litterDir, '20261003-none'))).toBe('')
  })
})

describe('the swarm skill', () => {
  test('starts a repair with repair.start, raises a budget with repair.budget, and ends a landed repair on its done report', () => {
    const skill = readFileSync(join(import.meta.dir, '..', '..', 'skills', 'swarm', 'SKILL.md'), 'utf8')
    expect(skill).toContain('| repair <run>"')
    expect(skill).toContain("Record `{ kind: 'repair.start', run }` with `mcp__litter__record`.")
    expect(skill).toContain("record `{ kind: 'repair.budget', swarm, rounds, agents }`")
    expect(skill).toContain('End a repair swarm once its orchestrator reports done after its land')
    expect(skill).toContain("report the Repair section of the run's summary.md")
  })
})

describe("the builder's Launch", () => {
  test('refuses verify and land authority, which only a repair swarm a run starts may have', async () => {
    const spec = aSpec()
    spec.nodes[0]!.authority = { ...spec.nodes[0]!.authority, verify: true, land: true }
    await saveSwarm(w, spec)
    w.p.answers.push('Launch')
    const r = await launchSwarm(w.p, 'alpha')
    expect(r.ok).toBe(false)
    const reason = (r as { reason: string }).reason
    expect(reason).toContain('nodes.lead-a.authority.verify: only a repair swarm a run starts may verify or land, in this version; unset it')
    expect(reason).toContain('nodes.lead-a.authority.land: only a repair swarm a run starts may verify or land, in this version; unset it')
    expect(w.p.asked).toEqual([])
    expect(await refOf(w, 'alpha')).toBeNull()
  })
})
