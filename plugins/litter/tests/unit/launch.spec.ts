// Tier 2: the launch check on Workflow, TaskStop and the agent.spawn block
// (plan sections 6 and 9), against real git and files: the args swap,
// run.launch and run.resume, and each refusal.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RecordCtx, RecordInput } from '../../hooks/records/core'
import type { RunEndBody, RunJson, RunStartReply, Workflow } from '../../hooks/records/run'
import { workflowName, workflowOfName } from '../../hooks/records/run'
import type { RunRef } from '../../hooks/lifecycle'
import { endRun, getPending, recordRunStart, runState, taskKey, wfKey } from '../../hooks/lifecycle'
import {
  spawnBlock,
  spawnBlockFailed,
  taskStop,
  taskStopFailed,
  workflowCheck,
  workflowCheckFailed,
} from '../../hooks/launch'
import { acquireLock, readLock, releaseLock, stopLease } from '../../hooks/lock'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { leasePath, modePath, runJsonPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { readPolicy } from '../../hooks/policy'
import { updateSession } from '../../hooks/session'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// Each world runs run.start against real git; a loaded machine takes seconds.
setDefaultTimeout(120_000)

// One plugin root for the file: the shipped scripts are read once per module instance.
const PLUGIN_ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'litter-root-')))
const EXECUTE_JS = 'export const meta = { name: "execute-run" }\n// litter execute\n'
mkdirSync(join(PLUGIN_ROOT, 'workflows'), { recursive: true })
writeFileSync(join(PLUGIN_ROOT, 'workflows', 'execute.js'), EXECUTE_JS)

type World = { p: TestPorts; dir: string; litterDir: string; ctx: RecordCtx; sid: { value: string } }
const cleanups: (() => void)[] = []

afterEach(() => {
  stopLease()
  updateSession({ litterDir: null, toolsRefused: null })
  for (const c of cleanups.splice(0)) c()
})
process.on('exit', () => rmSync(PLUGIN_ROOT, { recursive: true, force: true }))

async function world(): Promise<World> {
  const s = scratch()
  cleanups.push(s.cleanup)
  const dir = realpathSync(s.dir)
  const base = nodePorts({ pluginRoot: PLUGIN_ROOT })
  const sid = { value: 'session-a' }
  const p: TestPorts = {
    ...base,
    sessionId: async () => sid.value,
    cwd: async () => dir,
    run: (argv, init) =>
      argv[0] === 'jq'
        ? Promise.resolve({ code: 0, stdout: 'jq-1.7.1\n', stderr: '', truncated: false })
        : base.run(argv, init?.cwd ? init : { ...init, cwd: dir }),
  }
  const { git } = await scratchRepo(p, dir)
  await p.fs.write(join(dir, 'plan.md'), '### G1: One\nFiles: a.txt\nChecks: true\nDone when: a.txt\n')
  await git('add', 'plan.md')
  await git('commit', '-q', '-m', 'plan')
  const litterDir = join(dir, '.claude', 'litter')
  await p.fs.write(modePath(litterDir), 'default\n')
  updateSession({ litterDir, toolsRefused: null })
  return { p, dir, litterDir, sid, ctx: { p, caller: { agentId: null, agentType: null }, litterDir, options: normalizeOptions({ verify: ['true'] }) } }
}

async function started(w: World): Promise<RunStartReply & { ref: RunRef }> {
  const r = (await recordRunStart(w.ctx, { kind: 'run.start', workflow: 'execute', authorized: ['test'], planPath: 'plan.md' } as RecordInput)) as RunStartReply
  if (!r.ok) throw new Error(JSON.stringify(r))
  return { ...r, ref: { run: r.run, runDir: r.runDir, litterDir: w.litterDir } }
}

type Call = Record<string, unknown>
/** next(e) as the engine answers a local launch, recording what it got. */
function engine(result: unknown = { status: 'async_launched', taskId: 'task-1', runId: 'wf_abc123', scriptPath: '/s/execute.js' }) {
  const calls: Call[] = []
  const next = (async (e: Call) => {
    calls.push(e)
    return typeof result === 'function' ? (result as (e: Call) => unknown)(e) : { result }
  }) as never
  return { calls, next }
}

const wf = (fields: Call): never => ({ tool: 'Workflow', tool_use_id: 'tu', ...fields }) as never
const denied = (r: unknown): string => {
  const d = (r as { deny?: string }).deny
  if (typeof d !== 'string') throw new Error(`not denied: ${JSON.stringify(r)}`)
  return d
}
const ledgerOf = async (w: World, ref: RunRef) => (await readLedger(w.p, ref.runDir, ref.run)).records
const lastEnd = async (w: World, ref: RunRef) => (await ledgerOf(w, ref)).filter(r => r.kind === 'run.end').at(-1)?.body as RunEndBody | undefined

describe('the launch: the args swap and run.launch', () => {
  test("the engine gets the stored args, whatever the call's args held; run.launch opens generation 1", async () => {
    const w = await world()
    const r = await started(w)
    const oid = (await getPending(w.p, w.litterDir))!.oid
    const { calls, next } = engine()
    const out = await workflowCheck(w.p, wf({ name: 'litter:execute-run', args: { run: r.run, gates: [], authorized: 'everything' } }), next)
    expect((out as { result: unknown }).result).toEqual(expect.objectContaining({ taskId: 'task-1' }))
    const stored = (JSON.parse(await w.p.fs.read(runJsonPath(r.runDir))) as RunJson).args
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual(stored)
    expect(calls[0]!.name).toBe('litter:execute-run')

    const ledger = await ledgerOf(w, r.ref)
    expect(ledger.map(x => x.kind)).toEqual(['run.start', 'run.launch'])
    expect(ledger[1]!.body).toEqual({ taskId: 'task-1', runId: 'wf_abc123', scriptPath: '/s/execute.js', generation: 1, session: 'session-a', oid })
    expect(await getPending(w.p, w.litterDir)).toBeNull()
    expect((await readLock(w.p, w.dir))?.oid).toBe(oid)
    expect(await w.p.fs.exists(leasePath(w.litterDir, oid))).toBe(false)
    expect(await w.p.store.get(taskKey('task-1'))).toEqual(r.ref)
    expect(await w.p.store.get(wfKey('wf_abc123'))).toEqual(r.ref)
    expect((await readPolicy(w.p, w.litterDir))?.run).toEqual(expect.objectContaining({ launching: false, runIds: ['wf_abc123'] }))
  })

  test('args sent as a JSON string are read as what they encode', async () => {
    const w = await world()
    const r = await started(w)
    const { calls, next } = engine()
    await workflowCheck(w.p, wf({ name: 'litter:execute-run', args: JSON.stringify({ run: r.run }) }), next)
    expect(calls).toHaveLength(1)
  })

  test("a launch the engine refuses is launch_failed, with the engine's reason, and the lock goes", async () => {
    const w = await world()
    const r = await started(w)
    const { next } = engine(() => ({ isError: true, text: 'Workflow tool is disabled' }))
    await workflowCheck(w.p, wf({ name: 'litter:execute-run', args: { run: r.run } }), next)
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ generation: 0, status: 'launch_failed', reason: 'Workflow tool is disabled' }))
    expect(await readLock(w.p, w.dir)).toBeNull()
  })

  test("a remote launch (no local run id) is launch_failed: litter can't track it", async () => {
    const w = await world()
    const r = await started(w)
    const { next } = engine({ status: 'remote_launched', taskId: 't9' })
    await workflowCheck(w.p, wf({ name: 'litter:execute-run', args: { run: r.run } }), next)
    expect((await lastEnd(w, r.ref))?.reason).toContain("can't track")
  })
})

describe('the launch: refusals', () => {
  test('a refused mode', async () => {
    const w = await world()
    const r = await started(w)
    await w.p.fs.write(modePath(w.litterDir), 'bypassPermissions\n')
    const { calls, next } = engine()
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:execute-run', args: { run: r.run } }), next))).toContain('bypassPermissions mode')
    expect(calls).toHaveLength(0)
  })

  test('no pending run.start, one for another run, one from another session, one for another workflow', async () => {
    const w = await world()
    const { calls, next } = engine()
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:execute-run', args: { run: '20261002-execute-nosuch' } }), next))).toContain(
      'no pending run.start',
    )
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:execute-run' }), next))).toContain("pass the 'args'")
    const r = await started(w)
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:execute-run', args: { run: '20261002-execute-other' } }), next))).toContain(
      'no pending run.start',
    )
    w.sid.value = 'session-b'
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:execute-run', args: { run: r.run } }), next))).toContain('no pending run.start')
    w.sid.value = 'session-a'
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:design-run', args: { run: r.run } }), next))).toContain('started for litter:execute-run, not litter:design-run')
    expect(calls).toHaveLength(0)
    expect(await getPending(w.p, w.litterDir)).not.toBeNull()
  })

  test('a lock lost since run.start: refused, and the launch recorded as launch_failed', async () => {
    const w = await world()
    const r = await started(w)
    const oid = (await getPending(w.p, w.litterDir))!.oid
    await releaseLock(w.p, w.dir, oid)
    await acquireLock(w.p, w.dir, { run: '20261002-execute-thief0', session: 'other', acquiredAt: 1 })
    const { calls, next } = engine()
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:execute-run', args: { run: r.run } }), next))).toContain('lock was lost')
    expect(calls).toHaveLength(0)
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ status: 'launch_failed', reason: 'lock lost' }))
    expect((await readLock(w.p, w.dir))?.blob?.run).toBe('20261002-execute-thief0')
  })

  test('a run.json edited since run.start is refused', async () => {
    const w = await world()
    const r = await started(w)
    const path = runJsonPath(r.runDir)
    await w.p.fs.write(path, (await w.p.fs.read(path)).replace('"verify"', '"verify" ').replace('"true"', '"rm"'))
    const { calls, next } = engine()
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:execute-run', args: { run: r.run } }), next))).toContain('changed since run.start')
    expect(calls).toHaveLength(0)
  })

  test("refused for every caller: 'script' with 'name' or 'scriptPath'", async () => {
    const w = await world()
    const { calls, next } = engine()
    expect(denied(await workflowCheck(w.p, wf({ script: 'x', name: 'mine' }), next))).toContain("can't set 'script'")
    expect(denied(await workflowCheck(w.p, wf({ script: 'x', scriptPath: '/tmp/y.js' }), next))).toContain("can't set 'script'")
    expect(calls).toHaveLength(0)
  })

  test("an unknown litter name, and a litter name with another script's path", async () => {
    const w = await world()
    const other = join(w.dir, 'other.js')
    writeFileSync(other, 'export const meta = {}\n')
    const { calls, next } = engine()
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:nope' }), next))).toContain("no litter workflow 'litter:nope'")
    // A skill's name isn't its workflow's: the engine would take /litter:execute for a workflow so named.
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:execute', args: { run: 'x' } }), next))).toContain(
      "no litter workflow 'litter:execute'; litter's are litter:execute-run, litter:fanout-run, litter:design-run, litter:plan-run",
    )
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:execute-run', scriptPath: other }), next))).toContain('runs that file instead')
    expect(calls).toHaveLength(0)
  })

  test("a copy of litter's script, by any path, is litter's: it needs its run.start", async () => {
    const w = await world()
    const copy = join(w.dir, 'copy.js')
    writeFileSync(copy, EXECUTE_JS)
    const { calls, next } = engine()
    expect(denied(await workflowCheck(w.p, wf({ scriptPath: copy, args: { run: '20261002-execute-x' } }), next))).toContain('no pending run.start')
    // Relative to the session's directory.
    expect(denied(await workflowCheck(w.p, wf({ scriptPath: 'copy.js', args: {} }), next))).toContain("pass the 'args'")
    expect(denied(await workflowCheck(w.p, wf({ scriptPath: copy, name: 'litter:design-run' }), next))).toContain('holds litter:execute-run, not litter:design-run')
    expect(calls).toHaveLength(0)
    // Anything else by path is someone else's.
    const mine = join(w.dir, 'mine.js')
    writeFileSync(mine, 'export const meta = { name: "mine" }\n')
    await workflowCheck(w.p, wf({ scriptPath: mine }), next)
    await workflowCheck(w.p, wf({ script: 'export const meta = {}' }), next)
    await workflowCheck(w.p, wf({ name: 'deepwork:run' }), next)
    expect(calls).toHaveLength(3)
  })

  test("refused tools and no litter directory refuse litter's launches only", async () => {
    const w = await world()
    const { calls, next } = engine()
    updateSession({ toolsRefused: 'blocked by policy' })
    const d = denied(await workflowCheck(w.p, wf({ name: 'litter:execute-run', args: { run: 'x' } }), next))
    expect(d).toContain('blocked by policy')
    expect(d).toContain('allowedMcpServers')
    updateSession({ toolsRefused: null, litterDir: null })
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:execute-run', args: { run: 'x' } }), next))).toContain('no litter directory')
    await workflowCheck(w.p, wf({ name: 'deepwork:run' }), next)
    expect(calls).toHaveLength(1)
  })
})

describe('resume', () => {
  async function stoppedRun(w: World) {
    const r = await started(w)
    const { next } = engine()
    await workflowCheck(w.p, wf({ name: 'litter:execute-run', args: { run: r.run } }), next)
    await endRun(w.p, r.ref, { taskId: 'task-1', generation: 1, status: 'stopped', reason: 'stopped', source: 'taskstop', settled: true })
    expect(await readLock(w.p, w.dir)).toBeNull()
    return r
  }

  test("a resume of a stopped run takes the lock again, swaps in the run's args, and opens generation 2", async () => {
    const w = await world()
    const r = await stoppedRun(w)
    const { calls, next } = engine({ status: 'async_launched', taskId: 'task-2', runId: 'wf_def456' })
    await workflowCheck(w.p, wf({ name: 'litter:execute-run', resumeFromRunId: 'wf_abc123', args: { run: r.run, extra: 1 } }), next)
    const stored = (JSON.parse(await w.p.fs.read(runJsonPath(r.runDir))) as RunJson).args
    expect(calls[0]!.args).toEqual(stored)
    const st = runState(await ledgerOf(w, r.ref))
    expect(st.generations.map(g => [g.n, g.taskId, g.runId])).toEqual([
      [1, 'task-1', 'wf_abc123'],
      [2, 'task-2', 'wf_def456'],
    ])
    expect((await ledgerOf(w, r.ref)).at(-1)!.kind).toBe('run.resume')
    expect((await readLock(w.p, w.dir))?.blob?.run).toBe(r.run)
    expect((await readPolicy(w.p, w.litterDir))?.run).toEqual(expect.objectContaining({ runIds: ['wf_abc123', 'wf_def456'], launching: false }))
  })

  test("a wf_ resume that isn't the run's own is refused", async () => {
    const w = await world()
    const r = await stoppedRun(w)
    const { calls, next } = engine()
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:execute-run', resumeFromRunId: 'wf_abc123', args: { run: '20261002-execute-other' } }), next))).toContain(
      `belongs to run ${r.run}`,
    )
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:design-run', resumeFromRunId: 'wf_abc123' }), next))).toContain('is a litter:execute-run run, not litter:design-run')
    expect(denied(await workflowCheck(w.p, wf({ resumeFromRunId: 'wf_abc123', script: 'x' }), next))).toContain("only with litter's own script")
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:execute-run', resumeFromRunId: 'wf_unknown1' }), next))).toContain(
      "isn't a run litter launched",
    )
    // The store is global: another repository's run is litter's, and not this session's to resume.
    const far = '/elsewhere/.claude/litter'
    await w.p.store.set(wfKey('wf_far0001'), { run: '20261002-execute-far', runDir: `${far}/20261002-execute-far`, litterDir: far })
    expect(denied(await workflowCheck(w.p, wf({ resumeFromRunId: 'wf_far0001' }), next))).toContain('of another repository')
    expect(calls).toHaveLength(0)
    expect(await readLock(w.p, w.dir)).toBeNull()
  })

  test("a run that ended done, or that's still stopping, doesn't resume", async () => {
    const w = await world()
    const r = await started(w)
    const { next } = engine()
    await workflowCheck(w.p, wf({ name: 'litter:execute-run', args: { run: r.run } }), next)
    // Stopped, with an agent of it still live: stopping, not settled.
    await w.p.store.set(`litter.agents.${r.runDir}`, { started: ['agent-1'], stopped: [] })
    await taskStop(w.p, { tool: 'TaskStop', tool_use_id: 'ts', task_id: 'task-1' } as never, (async () => ({ result: 'ok' })) as never)
    expect(runState(await ledgerOf(w, r.ref)).open?.stopping).not.toBeNull()
    const again = engine()
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:execute-run', resumeFromRunId: 'wf_abc123' }), again.next))).toContain('still stopping')
    await endRun(w.p, r.ref, { taskId: 'task-1', generation: 1, status: 'done', reason: null, source: 'notification' })
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:execute-run', resumeFromRunId: 'wf_abc123' }), again.next))).toContain('ended done')
    expect(again.calls).toHaveLength(0)
  })

  test('a run with an open repair generation does not resume; its swarm ends that generation', async () => {
    const w = await world()
    const r = await stoppedRun(w)
    const body = { generation: 2, swarm: 'repair-abc123', launch: '20261003-120000-abcd', budget: { rounds: 3, agents: 6 } }
    await appendRecord(w.p, r.runDir, { run: r.run, kind: 'run.repair', by: { source: 'mod' }, body })
    const { calls, next } = engine()
    expect(denied(await workflowCheck(w.p, wf({ name: 'litter:execute-run', resumeFromRunId: 'wf_abc123' }), next))).toContain('being repaired by swarm repair-abc123')
    expect(calls).toHaveLength(0)
    expect(runState(await ledgerOf(w, r.ref)).open?.repair?.swarm).toBe('repair-abc123')
  })

  test('a resume the engine refuses gives the lock back', async () => {
    const w = await world()
    const r = await stoppedRun(w)
    const { next } = engine(() => ({ isError: true, text: 'no such run' }))
    await workflowCheck(w.p, wf({ name: 'litter:execute-run', resumeFromRunId: 'wf_abc123' }), next)
    expect(await readLock(w.p, w.dir)).toBeNull()
    expect(runState(await ledgerOf(w, r.ref)).generations).toHaveLength(1)
    expect((await readPolicy(w.p, w.litterDir))?.run ?? null).toBeNull()
  })

  test("a resume of another plugin's workflow run passes on", async () => {
    const w = await world()
    const { calls, next } = engine()
    await workflowCheck(w.p, wf({ name: 'deepwork:run', resumeFromRunId: 'wf_theirs01' }), next)
    expect(calls).toHaveLength(1)
  })
})

describe('TaskStop', () => {
  test('a stop that went through records run.stopping and settles; a refused one records nothing', async () => {
    const w = await world()
    const r = await started(w)
    await workflowCheck(w.p, wf({ name: 'litter:execute-run', args: { run: r.run } }), engine().next)
    const refusedNext = (async () => ({ deny: 'no' })) as never
    await taskStop(w.p, { tool: 'TaskStop', tool_use_id: 'ts', task_id: 'task-1' } as never, refusedNext)
    expect((await ledgerOf(w, r.ref)).map(x => x.kind)).toEqual(['run.start', 'run.launch'])
    const okNext = (async () => ({ result: 'stopped' })) as never
    const out = await taskStop(w.p, { tool: 'TaskStop', tool_use_id: 'ts', task_id: 'task-1' } as never, okNext)
    expect(out).toEqual({ result: 'stopped' })
    expect((await ledgerOf(w, r.ref)).map(x => x.kind)).toEqual(['run.start', 'run.launch', 'run.stopping', 'run.end'])
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ status: 'stopped', settled: true }))
  })

  test('its catch only passes the call on', async () => {
    let passed = false
    await taskStopFailed({} as never, { tool: 'TaskStop', tool_use_id: 'ts', task_id: 'x' } as never, (async () => {
      passed = true
      return { result: 'ok' }
    }) as never)
    expect(passed).toBe(true)
  })
})

describe('the agent.spawn block', () => {
  const spawn = (subagentType: string, parentAgentId?: string): never =>
    ({ tool_use_id: 'tu', prompt: 'p', description: 'd', subagentType, ...(parentAgentId ? { parentAgentId } : {}) }) as never
  const STARTED = { model: 'm', agentId: 'agent-new' }
  const pass = (async () => STARTED) as never

  test('the main thread is refused a litter role; a subagent spawning one is not', async () => {
    const p = nodePorts()
    expect(denied(await spawnBlock(p, spawn('litter:executor'), pass))).toContain('run inside litter workflows only')
    expect(await spawnBlock(p, spawn('litter:executor', 'agent-parent'), pass)).toEqual(STARTED)
    expect(await spawnBlock(p, spawn('litter:sw-worker'), pass)).toEqual(STARTED)
    expect(await spawnBlock(p, spawn('general-purpose'), pass)).toEqual(STARTED)
  })

  test('its catch refuses every main-thread litter type, swarm types too, by parentAgentId', async () => {
    expect(denied(await spawnBlockFailed({} as never, spawn('litter:executor'), pass))).toContain('litter guard failed')
    expect(denied(await spawnBlockFailed({} as never, spawn('litter:sw-worker'), pass))).toContain('litter guard failed')
    expect(await spawnBlockFailed({} as never, spawn('litter:executor', 'agent-parent'), pass)).toEqual(STARTED)
    expect(await spawnBlockFailed({} as never, spawn('general-purpose'), pass)).toEqual(STARTED)
  })
})

describe("the Workflow hook's catch", () => {
  test("refuses a litter name, any scriptPath, script with name, and a wf_ resume; passes the rest", async () => {
    const pass = (async () => ({ result: 'engine' })) as never
    const c = (fields: Call) => workflowCheckFailed({} as never, wf(fields), pass)
    for (const f of [{ name: 'litter:execute-run' }, { scriptPath: '/x.js' }, { script: 's', name: 'n' }, { resumeFromRunId: 'wf_abc123' }]) {
      expect(denied(await c(f))).toContain('litter guard failed: Workflow')
    }
    expect(await c({ script: 's' })).toEqual({ result: 'engine' })
    expect(await c({ name: 'deepwork:run' })).toEqual({ result: 'engine' })
    expect(await c({ resumeFromRunId: 'r-123' })).toEqual({ result: 'engine' })
  })

  // WP-CH: a deny then would undo nothing, and tell the model a running workflow was refused.
  test('once the hook had called next the launch has run: every call gets what that launch settled to, never a deny', async () => {
    for (const f of [{ name: 'litter:execute-run' }, { scriptPath: '/x.js' }, { resumeFromRunId: 'wf_abc123' }, { name: 'deepwork:run' }]) {
      const calls: unknown[] = []
      const next = Object.assign(async (e: unknown) => (calls.push(e), { result: { taskId: 't1', runId: 'wf_1' } }), {
        error: { kind: 'timeout', message: 'ran past its budget', budget: 1000 },
        called: true,
      })
      expect(await workflowCheckFailed({} as never, wf(f), next as never)).toEqual({ result: { taskId: 't1', runId: 'wf_1' } })
      expect(calls).toEqual([wf(f)])
    }
  })

  test('a launch whose next rejected: the catch passes the rejection on, as the engine replays it', async () => {
    const next = Object.assign(async () => Promise.reject(new Error('the Workflow tool threw')), { error: { kind: 'throw', message: 'x', budget: 1000 }, called: true })
    await expect(workflowCheckFailed({} as never, wf({ name: 'litter:execute-run' }), next as never)).rejects.toThrow('the Workflow tool threw')
  })
})

describe("the workflows' names", () => {
  const PLUGIN = join(import.meta.dir, '..', '..')
  const skills = readdirSync(join(PLUGIN, 'skills'))

  test('a Workflow name is litter:<workflow>-run, and nothing else names one', () => {
    expect(workflowOfName('litter:execute-run')).toBe('execute')
    expect(workflowOfName('litter:plan-run')).toBe('plan')
    for (const n of ['litter:execute', 'litter:nope-run', 'litter:-run', 'execute-run', 'deepwork:execute-run']) expect(workflowOfName(n)).toBeNull()
  })

  // The engine lists workflows ahead of plugin skills and dispatches a name to
  // the first it finds, so a workflow named like a skill takes its slash command.
  for (const dir of ['workflows', 'tests/headless/fixtures']) {
    test(`each script in ${dir} is named workflowName(<its file>), which no skill is`, () => {
      const files = readdirSync(join(PLUGIN, dir)).filter(f => f.endsWith('.js'))
      expect(files.length).toBeGreaterThan(0)
      for (const f of files) {
        const name = /^ {2}name: '([^']+)',$/m.exec(readFileSync(join(PLUGIN, dir, f), 'utf8'))?.[1]
        expect(`litter:${name}`).toBe(workflowName(f.slice(0, -'.js'.length) as Workflow))
        expect(skills).not.toContain(name)
      }
    })
  }
})
