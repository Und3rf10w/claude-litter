// Tier 2: hooks/inflight.ts, an execute run's in-flight flag (COMMON
// decision 24): `critique` from a gate-critic's start line or its first
// verify (markCritique) to its stop line, `land` around a land
// (withInflight), never for another workflow, and a stopping run that waits
// for it. The policy.json files the guard's tier-3 cases read
// (tests/hooks/fixtures/inflight-*.policy.json) are checked here against what
// this module writes.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordInput } from '../../hooks/records/core'
import type { RunEndBody, RunJson, RunStartReply, Workflow } from '../../hooks/records/run'
import type { RunRef } from '../../hooks/lifecycle'
import { activate, getPending, observeStop, openGeneration, patchRunPolicy, recordRunStart, trySettle } from '../../hooks/lifecycle'
import { consumeInflight, markCritique, withInflight } from '../../hooks/inflight'
import { consumeAgents, readPolicy } from '../../hooks/policy'
import { readLock, stopLease } from '../../hooks/lock'
import { readLedger } from '../../hooks/ledgercore'
import { modePath, policyPath, runDir } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { setOptions, updateSession } from '../../hooks/session'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const RUN = '20261003-execute-ab12cd'
const OTHER = '20261003-execute-ffffff'
const FIXTURES = join(import.meta.dir, '..', 'hooks', 'fixtures')

let p: TestPorts
let dir: string
let litterDir: string
let cleanup: () => void

beforeEach(() => {
  setOptions(undefined)
  p = nodePorts({ sessionId: 's1' })
  const s = scratch()
  cleanup = s.cleanup
  dir = realpathSync(s.dir)
  litterDir = join(dir, '.claude', 'litter')
})
afterEach(() => cleanup())

/** The run.json fields policy.json is built from (lifecycle.ts, policyFor). */
const runJson = (run: string, workflow: Workflow): RunJson =>
  ({ v: 1, run, workflow, checkout: dir, base: '0'.repeat(40), setup: null, linkDirs: [], args: {}, authorized: [] }) as unknown as RunJson

const activeRun = (workflow: Workflow = 'execute', run = RUN) => activate(p, litterDir, runJson(run, workflow), 's1', { runIds: ['wf_abc123-456'], launching: false })

const line = (ev: 'start' | 'stop', agent: string, type = 'litter:gate-critic') =>
  ({
    v: 1,
    ev,
    ts: 1_700_000_000,
    session_id: 's1',
    agent_id: agent,
    agent_type: type,
    cwd: dir,
    transcript_path: '/t',
    stop_hook_active: false,
    background_tasks: 0,
  }) as never

/** A spool line through the consumers in registry.ts's order: consumeAgents, then consumeInflight. */
async function consume(l: never) {
  const ctx = { p, litterDir, sessionId: 's1' }
  await consumeAgents(ctx, l)
  await consumeInflight(ctx, l)
}

const flag = async () => (await readPolicy(p, litterDir))?.run?.inflight ?? null

describe('critique', () => {
  test("a gate-critic's start line sets it, and its stop line clears it", async () => {
    await activeRun()
    await consume(line('start', 'gc1'))
    expect(await flag()).toBe('critique')
    expect(p.storeMap.get(`litter.inflight.${litterDir}`)).toEqual({ run: RUN, agents: ['gc1'] })
    await consume(line('stop', 'gc1'))
    expect(await flag()).toBeNull()
    expect(p.storeMap.has(`litter.inflight.${litterDir}`)).toBe(false)
  })

  test('markCritique sets it before any start line is seen, and that agent\'s stop clears it', async () => {
    await activeRun()
    await markCritique(p, litterDir, RUN, 'gc2')
    expect(await flag()).toBe('critique')
    // The start line arriving after it changes nothing.
    await consume(line('start', 'gc2'))
    expect(p.storeMap.get(`litter.inflight.${litterDir}`)).toEqual({ run: RUN, agents: ['gc2'] })
    await consume(line('stop', 'gc2'))
    expect(await flag()).toBeNull()
  })

  test('the stop of a critic remembered only through markCritique clears it, with no start line at all', async () => {
    await activeRun()
    await markCritique(p, litterDir, RUN, 'gc3')
    await consume(line('stop', 'gc3'))
    expect(await flag()).toBeNull()
  })

  test('two critics: the flag stays until the last one stops', async () => {
    await activeRun()
    await consume(line('start', 'gc1'))
    await consume(line('start', 'gc2'))
    await consume(line('stop', 'gc1'))
    expect(await flag()).toBe('critique')
    await consume(line('stop', 'gc2'))
    expect(await flag()).toBeNull()
  })

  test("another role's lines, another run's critic, and markCritique for another run change nothing", async () => {
    await activeRun()
    await consume(line('start', 'ex1', 'litter:executor'))
    expect(await flag()).toBeNull()
    await markCritique(p, litterDir, OTHER, 'gc9')
    expect(await flag()).toBeNull()
    // A critic that started under another run isn't this run's, and neither is its stop.
    await activeRun('execute', OTHER)
    await consume(line('start', 'gc8'))
    await activeRun()
    await consume(line('start', 'gc8'))
    expect(await flag()).toBeNull()
    await patchRunPolicy(p, litterDir, RUN, r => ({ ...r, inflight: 'critique' }))
    await consume(line('stop', 'gc8'))
    expect(await flag()).toBe('critique')
  })
})

describe('land', () => {
  test('withInflight holds land while its function runs, then puts back null', async () => {
    await activeRun()
    const seen = await withInflight(p, litterDir, RUN, 'land', async () => flag())
    expect(seen).toBe('land')
    expect(await flag()).toBeNull()
  })

  test("it puts back critique while a remembered critic still runs, and the critic's stop clears it after", async () => {
    await activeRun()
    await consume(line('start', 'gc1'))
    expect(await withInflight(p, litterDir, RUN, 'land', async () => flag())).toBe('land')
    expect(await flag()).toBe('critique')
    await consume(line('stop', 'gc1'))
    expect(await flag()).toBeNull()
  })

  test("a critic's stop during the land leaves land; a critic's start during it comes back as critique", async () => {
    await activeRun()
    await consume(line('start', 'gc1'))
    await withInflight(p, litterDir, RUN, 'land', async () => {
      await consume(line('stop', 'gc1'))
      expect(await flag()).toBe('land')
    })
    expect(await flag()).toBeNull()
    await withInflight(p, litterDir, RUN, 'land', async () => {
      await consume(line('start', 'gc2'))
      expect(await flag()).toBe('land')
    })
    expect(await flag()).toBe('critique')
  })

  test('a function that throws still puts the flag back, and the throw reaches the caller', async () => {
    await activeRun()
    await expect(
      withInflight(p, litterDir, RUN, 'land', async () => {
        throw new Error('index.lock: File exists')
      }),
    ).rejects.toThrow('index.lock: File exists')
    expect(await flag()).toBeNull()
  })

  test('two overlapping lands put it back once, after the second', async () => {
    await activeRun()
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const slow = withInflight(p, litterDir, RUN, 'land', () => gate)
    await withInflight(p, litterDir, RUN, 'land', async () => undefined)
    expect(await flag()).toBe('land')
    release()
    await slow
    expect(await flag()).toBeNull()
  })

  test("a policy it can't read refuses the land before the function runs", async () => {
    await activeRun()
    mkdirSync(join(litterDir, 'hooks'), { recursive: true })
    await p.fs.write(policyPath(litterDir), '{ not json')
    let ran = false
    await expect(
      withInflight(p, litterDir, RUN, 'land', async () => {
        ran = true
      }),
    ).rejects.toThrow()
    expect(ran).toBe(false)
  })
})

describe('never for another workflow', () => {
  test('a fanout gets no flag from a start line, markCritique or a land', async () => {
    await activeRun('fanout')
    await consume(line('start', 'gc1'))
    await markCritique(p, litterDir, RUN, 'gc1')
    expect(await withInflight(p, litterDir, RUN, 'land', async () => flag())).toBeNull()
    expect(await flag()).toBeNull()
    expect(p.storeMap.has(`litter.inflight.${litterDir}`)).toBe(false)
  })

  test('with no active run, nothing is written', async () => {
    await consume(line('start', 'gc1'))
    await markCritique(p, litterDir, RUN, 'gc1')
    expect(await withInflight(p, litterDir, RUN, 'land', async () => 'ran')).toBe('ran')
    expect(await readPolicy(p, litterDir)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The files tier 3 reads: the guard sees what this module writes.

const normalized = () => readFileSync(policyPath(litterDir), 'utf8').split(dir).join('@PROJECT@')
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')

describe('the policy.json the guard reads', () => {
  test('critique, land and put back are the tier-3 fixtures, path for path', async () => {
    await activeRun()
    await markCritique(p, litterDir, RUN, 'gc1')
    expect(normalized()).toBe(fixture('inflight-critique.policy.json'))
    await consume(line('stop', 'gc1'))
    let during = ''
    await withInflight(p, litterDir, RUN, 'land', async () => {
      during = normalized()
    })
    expect(during).toBe(fixture('inflight-land.policy.json'))
    expect(normalized()).toBe(fixture('inflight-cleared.policy.json'))
  })
})

// ---------------------------------------------------------------------------
// The stop path: a stopping run doesn't settle while the flag is set (lifecycle.ts, unsettled).

describe('a stopping run', () => {
  afterEach(() => {
    stopLease()
    updateSession({ litterDir: null })
  })

  test("waits for the critique's end, then settles", async () => {
    const base = nodePorts({ sessionId: 'session-a' })
    const w: TestPorts = {
      ...base,
      sessionId: async () => 'session-a',
      cwd: async () => dir,
      run: (argv, init) =>
        argv[0] === 'jq' ? Promise.resolve({ code: 0, stdout: 'jq-1.7.1\n', stderr: '', truncated: false }) : base.run(argv, init?.cwd ? init : { ...init, cwd: dir }),
    }
    const { git } = await scratchRepo(w, dir)
    await w.fs.write(join(dir, 'plan.md'), '### G1: One\nFiles: a.txt\nChecks: true\nDone when: a.txt\n')
    await git('add', 'plan.md')
    await git('commit', '-q', '-m', 'plan')
    await w.fs.write(modePath(litterDir), 'default\n')
    updateSession({ litterDir })
    const ctx = { p: w, caller: { agentId: null, agentType: null }, litterDir, options: normalizeOptions({ verify: ['true'] }) }
    const r = (await recordRunStart(ctx, { kind: 'run.start', workflow: 'execute', authorized: ['test'], planPath: 'plan.md' } as RecordInput)) as RunStartReply
    if (!r.ok) throw new Error(JSON.stringify(r))
    const ref: RunRef = { run: r.run, runDir: r.runDir, litterDir }
    const pending = (await getPending(w, litterDir))!
    stopLease(pending.oid)
    await w.store.delete(`litter.pending.${litterDir}`)
    await openGeneration(w, ref, 'run.launch', { taskId: 'task-1', runId: 'wf_abc123', scriptPath: null }, 'session-a', pending.oid)

    await markCritique(w, litterDir, r.run, 'gc1')
    expect(await observeStop(w, 'task-1')).toBe(true)
    const ends = async () => (await readLedger(w, ref.runDir, ref.run)).records.filter(x => x.kind === 'run.end')
    expect(await ends()).toEqual([])
    expect(await readLock(w, dir)).not.toBeNull()

    await consumeInflight({ p: w, litterDir, sessionId: 'session-a' }, line('stop', 'gc1'))
    expect((await readPolicy(w, litterDir))?.run?.inflight).toBeNull()
    expect(await trySettle(w, ref)).toBe(true)
    expect((await ends()).at(-1)!.body as unknown as RunEndBody).toEqual(expect.objectContaining({ status: 'stopped', settled: true }))
    expect(runDir(litterDir, r.run)).toBe(ref.runDir)
  })
})
