// Tier 2: a run from its launch to its run.end (plan section 9, "Run
// lifecycle"): the decoder table, the notification, the launcher's fallback,
// the pending launch at turn.complete and session.end, TaskStop settling, and
// reconcile of each stale state. Real git and files in scratch repos.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordCtx, RecordInput } from '../../hooks/records/core'
import type { RunEndBody, RunStartReply, Workflow } from '../../hooks/records/run'
import type { EngineEnd, RunRef } from '../../hooks/lifecycle'
import {
  consumeLifecycle,
  decodeReturn,
  getPending,
  observeStop,
  onPromptSubmit,
  onSessionEnd,
  onTurnComplete,
  openGeneration,
  parseNotifications,
  patchRunPolicy,
  reconcileRuns,
  recordRunEnd,
  recordRunStart,
  runState,
  taskKey,
  trySettle,
} from '../../hooks/lifecycle'
import { readLock, stopLease } from '../../hooks/lock'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { activePath, leasePath, ledgerDir, modePath, runDir, summaryPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { readPolicy } from '../../hooks/policy'
import { updateSession } from '../../hooks/session'
import { atomicWriteJson } from '../../hooks/fsx'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// Each world runs run.start against real git; a loaded machine takes seconds.
setDefaultTimeout(30_000)

// ---------------------------------------------------------------------------
// The decoder, one row each

const ROLE_MISSING = "agent type 'litter:executor' not found"
const DECODER: [string, Workflow, EngineEnd, { status: string; reason: string | null }][] = [
  ['killed is stopped', 'execute', { status: 'killed' }, { status: 'stopped', reason: 'stopped' }],
  ['a missing litter role is interrupted', 'execute', { status: 'failed', error: `${ROLE_MISSING}` }, { status: 'interrupted', reason: ROLE_MISSING }],
  ['any other failure is failed', 'design', { status: 'failed', error: 'boom' }, { status: 'failed', reason: 'boom' }],
  ['a failure with no error', 'plan', { status: 'failed' }, { status: 'failed', reason: 'the workflow failed' }],
  ['execute halted null is done', 'execute', { status: 'completed', result: { halted: null } }, { status: 'done', reason: null }],
  ['execute halted is halted', 'execute', { status: 'completed', result: { halted: 'G2 failed verify' } }, { status: 'halted', reason: 'G2 failed verify' }],
  ['execute halted + interrupted is interrupted', 'execute', { status: 'completed', result: { halted: 'G1', interrupted: true } }, { status: 'interrupted', reason: 'G1' }],
  ['execute without halted is unrecognized', 'execute', { status: 'completed', result: { gates: [] } }, { status: 'failed', reason: 'unrecognized result' }],
  ['execute halted of another type is unrecognized', 'execute', { status: 'completed', result: { halted: 3 } }, { status: 'failed', reason: 'unrecognized result' }],
  ['fanout halted null is done', 'fanout', { status: 'completed', result: { halted: null, merged: [] } }, { status: 'done', reason: null }],
  ['fanout halted is halted', 'fanout', { status: 'completed', result: { halted: 'merge conflict' } }, { status: 'halted', reason: 'merge conflict' }],
  ['plan gates is done', 'plan', { status: 'completed', result: { gates: [] } }, { status: 'done', reason: null }],
  ['plan questions is done', 'plan', { status: 'completed', result: { questions: ['which?'] } }, { status: 'done', reason: null }],
  ['plan halted is halted', 'plan', { status: 'completed', result: { halted: 'no plan' } }, { status: 'halted', reason: 'no plan' }],
  ['plan halted + interrupted is interrupted', 'plan', { status: 'completed', result: { halted: 'x', interrupted: true } }, { status: 'interrupted', reason: 'x' }],
  ['plan with neither is unrecognized', 'plan', { status: 'completed', result: {} }, { status: 'failed', reason: 'unrecognized result' }],
  ['design approved is done', 'design', { status: 'completed', result: { stopped: null, outcome: 'approved', by: 'approved', version: 'v2' } }, { status: 'done', reason: null }],
  ['design holding by max-rounds is done', 'design', { status: 'completed', result: { stopped: null, outcome: 'holding', by: 'max-rounds' } }, { status: 'done', reason: null }],
  ['design with an unknown outcome is unrecognized', 'design', { status: 'completed', result: { stopped: null, outcome: 'great', by: 'approved' } }, { status: 'failed', reason: 'unrecognized result' }],
  ['design goal-change needs you', 'design', { status: 'completed', result: { stopped: 'goal-change' } }, { status: 'needs_user', reason: 'goal-change' }],
  ['design blocking-decision needs you', 'design', { status: 'completed', result: { stopped: 'blocking-decision' } }, { status: 'needs_user', reason: 'blocking-decision' }],
  ['design user-gap needs you', 'design', { status: 'completed', result: { stopped: 'user-gap' } }, { status: 'needs_user', reason: 'user-gap' }],
  ['design source-changed is halted', 'design', { status: 'completed', result: { stopped: 'source-changed', version: 'v1' } }, { status: 'halted', reason: 'source-changed' }],
  ['design interrupted is interrupted', 'design', { status: 'completed', result: { stopped: 'interrupted', reason: 'role missing' } }, { status: 'interrupted', reason: 'role missing' }],
  ['design with another stop is unrecognized', 'design', { status: 'completed', result: { stopped: 'bored' } }, { status: 'failed', reason: 'unrecognized result' }],
  ['design without stopped is unrecognized', 'design', { status: 'completed', result: { outcome: 'approved' } }, { status: 'failed', reason: 'unrecognized result' }],
  ['a result that is not an object is unrecognized', 'execute', { status: 'completed', result: 'done!' }, { status: 'failed', reason: 'unrecognized result' }],
  ['no result at all is unrecognized', 'design', { status: 'completed' }, { status: 'failed', reason: 'unrecognized result' }],
]

describe('decodeReturn', () => {
  test.each(DECODER)('%s', (_name, workflow, end, expected) => {
    expect(decodeReturn(workflow, end)).toEqual(expect.objectContaining(expected))
  })

  test("design's payload carries its outcome, and needs_user carries the stop", () => {
    expect(decodeReturn('design', { status: 'completed', result: { stopped: null, outcome: 'approved', by: 'approved', version: 'v3' } }).payload).toEqual({
      outcome: 'approved',
      by: 'approved',
      version: 'v3',
    })
    expect(decodeReturn('design', { status: 'completed', result: { stopped: 'user-gap', question: 'which?' } }).payload).toEqual({
      stopped: 'user-gap',
      question: 'which?',
    })
  })
})

describe('parseNotifications', () => {
  test('reads each notification, unescaping its text and noting a cut result', () => {
    const text =
      'before\n<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<output-file>/tmp/out.json</output-file>\n' +
      '<summary>Dynamic workflow "litter:execute" completed</summary>\n<result>{"halted":"a &lt;b&gt; &amp; c"}</result>\n</task-notification>\n' +
      '<task-notification><task-id>t2</task-id><status>failed</status><summary>Dynamic workflow "litter:design" failed: x &amp; y</summary></task-notification>\n' +
      '<task-notification><task-id>t3</task-id><status>completed</status><result>{"halted":\n... (truncated 9000 chars, full result in /tmp/o.json)</result></task-notification>' +
      '<task-notification><status>completed</status></task-notification>'
    const ns = parseNotifications(text)
    expect(ns.map(n => n.taskId)).toEqual(['t1', 't2', 't3'])
    expect(ns[0]).toEqual({
      taskId: 't1',
      status: 'completed',
      outputFile: '/tmp/out.json',
      summary: 'Dynamic workflow "litter:execute" completed',
      result: '{"halted":"a <b> & c"}',
      truncated: false,
    })
    expect(ns[1]).toEqual(expect.objectContaining({ status: 'failed', summary: 'Dynamic workflow "litter:design" failed: x & y', result: null }))
    expect(ns[2]).toEqual(expect.objectContaining({ truncated: true, result: '{"halted":' }))
  })
})

// ---------------------------------------------------------------------------
// A world: a scratch repo, run.start for real, the launch opened by hand

type World = {
  p: TestPorts
  dir: string
  litterDir: string
  projectDir: string
  ctx: RecordCtx
  sid: { value: string }
}

const cleanups: (() => void)[] = []

afterEach(() => {
  stopLease()
  updateSession({ litterDir: null })
  for (const c of cleanups.splice(0)) c()
})

async function world(): Promise<World> {
  const s = scratch()
  cleanups.push(s.cleanup)
  const dir = realpathSync(s.dir)
  const base = nodePorts()
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
  updateSession({ litterDir })
  const projectDir = join(dir, 'project')
  mkdirSync(projectDir, { recursive: true })
  return { p, dir, litterDir, projectDir, sid, ctx: { p, caller: { agentId: null, agentType: null }, litterDir, options: normalizeOptions({ verify: ['true'] }) } }
}

async function started(w: World, workflow: Workflow = 'execute'): Promise<RunStartReply & { ref: RunRef }> {
  const input: Record<string, unknown> =
    workflow === 'design'
      ? { goal: 'g', deliverable: 'research', bar: [{ id: 'C1', text: 't', evidence: 'e' }] }
      : { planPath: 'plan.md' }
  const r = (await recordRunStart(w.ctx, { kind: 'run.start', workflow, authorized: ['test'], ...input } as RecordInput)) as RunStartReply
  if (!r.ok) throw new Error(JSON.stringify(r))
  return { ...r, ref: { run: r.run, runDir: r.runDir, litterDir: w.litterDir } }
}

/** What the Workflow hook does once next(e) returned the task (launch.ts). */
async function launched(w: World, workflow: Workflow = 'execute', taskId = 'task-1', runId = 'wf_abc123') {
  const r = await started(w, workflow)
  const pending = (await getPending(w.p, w.litterDir))!
  stopLease(pending.oid)
  await w.p.store.delete(`litter.pending.${w.litterDir}`)
  await openGeneration(w.p, r.ref, 'run.launch', { taskId, runId, scriptPath: null }, 'session-a', pending.oid)
  await patchRunPolicy(w.p, w.litterDir, r.run, x => ({ ...x, runIds: [runId] }))
  return { ...r, oid: pending.oid, taskId, runId }
}

const ledgerOf = async (w: World, ref: RunRef) => (await readLedger(w.p, ref.runDir, ref.run)).records
const lastEnd = async (w: World, ref: RunRef) => (await ledgerOf(w, ref)).filter(r => r.kind === 'run.end').at(-1)?.body as RunEndBody | undefined

const notification = (taskId: string, status: string, result?: string, extra = '') =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n${extra}` +
  `<summary>Dynamic workflow "litter:x" ${status}${status === 'failed' ? `: ${result ?? ''}` : ''}</summary>\n` +
  (result !== undefined && status === 'completed' ? `<result>${result}</result>\n` : '') +
  '</task-notification>'

async function submit(w: World, text: string) {
  let passed = false
  await onPromptSubmit(w.p, { text, origin: { kind: 'task-notification' } } as never, (async (e: unknown) => {
    passed = true
    return e
  }) as never)
  return passed
}

/** The run holds nothing once it ended: lock, policy run, `active`, task index. */
async function released(w: World, r: { ref: RunRef; taskId?: string }) {
  expect(await readLock(w.p, w.dir)).toBeNull()
  expect((await readPolicy(w.p, w.litterDir))?.run ?? null).toBeNull()
  expect(existsSync(activePath(w.litterDir))).toBe(false)
  if (r.taskId) expect(await w.p.store.get(taskKey(r.taskId))).toBeUndefined()
  expect(existsSync(summaryPath(r.ref.runDir))).toBe(true)
}

describe('run.end from the notification', () => {
  test.each([
    ['completed, done', 'execute', 'completed', '{"halted":null}', 'done', null],
    ['completed, halted', 'execute', 'completed', '{"halted":"G1 failed"}', 'halted', 'G1 failed'],
    ['completed, a design that needs you', 'design', 'completed', '{"stopped":"user-gap"}', 'needs_user', 'user-gap'],
    ['completed with no result', 'execute', 'completed', 'not json', 'failed', 'unrecognized result'],
    ['failed', 'execute', 'failed', 'kaput', 'failed', 'kaput'],
    ['failed on a missing role', 'execute', 'failed', ROLE_MISSING, 'interrupted', ROLE_MISSING],
  ] as const)('%s', async (_name, workflow, status, result, expected, reason) => {
    const w = await world()
    const r = await launched(w, workflow)
    expect(await submit(w, `queued\n${notification(r.taskId, status, result)}`)).toBe(true)
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ generation: 1, taskId: r.taskId, status: expected, reason, source: 'notification' }))
    await released(w, r)
    expect(await w.p.fs.read(summaryPath(r.ref.runDir))).toContain(`- Status: ${expected}`)
    // Once: a second notification changes nothing.
    await submit(w, notification(r.taskId, 'completed', '{"halted":null}'))
    expect((await ledgerOf(w, r.ref)).filter(x => x.kind === 'run.end')).toHaveLength(1)
  })

  test('a cut result is read whole from the output file', async () => {
    const w = await world()
    const r = await launched(w)
    const out = join(w.dir, 'out.json')
    writeFileSync(out, JSON.stringify({ result: { halted: 'G9 from the file' } }))
    const cut = '{"halted":\n... (truncated 9000 chars, full result in somewhere)'
    await submit(w, notification(r.taskId, 'completed', cut, `<output-file>${out}</output-file>\n`))
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ status: 'halted', reason: 'G9 from the file' }))
  })

  test("killed: run.stopping, then stopped once nothing of it is live", async () => {
    const w = await world()
    const r = await launched(w)
    await submit(w, notification(r.taskId, 'killed'))
    const kinds = (await ledgerOf(w, r.ref)).map(x => x.kind)
    expect(kinds.slice(-2)).toEqual(['run.stopping', 'run.end'])
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ status: 'stopped', source: 'taskstop', settled: true }))
    await released(w, r)
  })

  test('a run that lost an isolation context ends halted, naming the likely cause, whatever its script returned', async () => {
    const w = await world()
    const r = await launched(w)
    const lost = { v: 1, ev: 'isolation-lost', ts: 1, session_id: 'session-a', agent_id: 'ag1', agent_type: 'litter:prober',
      tool: 'Read', cwd: w.dir, expected: join(w.dir, '.claude', 'worktrees', 'x'), source: 'guard' }
    await consumeLifecycle({ p: w.p, litterDir: w.litterDir, sessionId: 'session-a' }, lost as never)
    expect((await readPolicy(w.p, w.litterDir))?.run?.isolationLost).toBe(true)
    await submit(w, notification(r.taskId, 'completed', '{"halted":null}'))
    const end = await lastEnd(w, r.ref)
    expect(end?.status).toBe('halted')
    expect(end?.reason).toContain(`agent ag1 lost its isolation context on Read (cwd ${w.dir})`)
    expect(end?.reason).toContain("likely another plugin's tool.call hook")
    await released(w, r)
  })

  test("a notification for a task that isn't a run's, or not from a notification, is passed on untouched", async () => {
    const w = await world()
    const r = await launched(w)
    expect(await submit(w, notification('someone-else', 'completed', '{"halted":null}'))).toBe(true)
    let passed = false
    await onPromptSubmit(w.p, { text: notification(r.taskId, 'completed', '{"halted":null}') } as never, (async () => {
      passed = true
    }) as never)
    expect(passed).toBe(true)
    expect(await lastEnd(w, r.ref)).toBeUndefined()
    expect(await readLock(w.p, w.dir)).not.toBeNull()
  })
})

describe("the launcher's run.end fallback", () => {
  test('accepted for the open generation, once; the result decoded', async () => {
    const w = await world()
    const r = await launched(w)
    const reply = await recordRunEnd(w.ctx, { kind: 'run.end', run: r.run, taskId: r.taskId, status: 'completed', result: '{"halted":"G1"}' })
    expect(reply).toEqual(expect.objectContaining({ ok: true, recorded: true, summary: summaryPath(r.ref.runDir) }))
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ status: 'halted', reason: 'G1', source: 'launcher' }))
    expect((await ledgerOf(w, r.ref)).at(-1)!.by).toEqual({ source: 'launcher' })
    await released(w, r)
    const again = await recordRunEnd(w.ctx, { kind: 'run.end', run: r.run, taskId: r.taskId, status: 'killed' })
    expect(again).toEqual(expect.objectContaining({ ok: true, recorded: false }))
  })

  test("killed from the launcher is stopped; a status that isn't one is refused", async () => {
    const w = await world()
    const r = await launched(w)
    expect(await recordRunEnd(w.ctx, { kind: 'run.end', run: r.run, taskId: r.taskId, status: 'great' })).toEqual(
      expect.objectContaining({ ok: false, field: 'status' }),
    )
    expect(await recordRunEnd(w.ctx, { kind: 'run.end', run: r.run, taskId: r.taskId, status: 'launch_failed' })).toEqual(
      expect.objectContaining({ ok: false, field: 'status' }),
    )
    await recordRunEnd(w.ctx, { kind: 'run.end', run: r.run, taskId: r.taskId, status: 'killed', reason: 'you stopped it' })
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ status: 'stopped', reason: 'you stopped it' }))
  })

  test("refused from an agent, for another task, for an older generation, or a run that doesn't exist", async () => {
    const w = await world()
    const r = await launched(w)
    w.ctx.caller = { agentId: 'a1', agentType: 'litter:executor' }
    expect(await recordRunEnd(w.ctx, { kind: 'run.end', run: r.run, taskId: r.taskId, status: 'completed' })).toEqual(
      expect.objectContaining({ ok: false, field: 'kind' }),
    )
    w.ctx.caller = { agentId: null, agentType: null }
    expect(await recordRunEnd(w.ctx, { kind: 'run.end', run: r.run, taskId: 'other', status: 'completed' })).toEqual(
      expect.objectContaining({ ok: false, field: 'taskId' }),
    )
    expect(await recordRunEnd(w.ctx, { kind: 'run.end', run: '20261002-execute-nosuch', taskId: r.taskId, status: 'completed' } as RecordInput)).toEqual(
      expect.objectContaining({ ok: false, field: 'taskId' }),
    )
    // A second generation opens without the first ending (a crash-respawn): the first is history.
    await openGeneration(w.p, r.ref, 'run.resume', { taskId: 'task-2', runId: 'wf_def456', scriptPath: null }, 'session-a', r.oid)
    expect(await recordRunEnd(w.ctx, { kind: 'run.end', run: r.run, taskId: r.taskId, status: 'completed' })).toEqual(
      expect.objectContaining({ ok: false, field: 'taskId' }),
    )
    expect(await lastEnd(w, r.ref)).toBeUndefined()
  })
})

describe('a pending launch', () => {
  const turn = (agentId?: string) => ({ ...(agentId ? { agentId } : {}), reason: 'answer' }) as never
  const pass = (async (e: unknown) => e) as never

  test("a main turn that ends with no Workflow call releases the lock and records launch_failed 'not launched'", async () => {
    const w = await world()
    const r = await started(w)
    const oid = (await getPending(w.p, w.litterDir))!.oid

    // A subagent's turn, or another session's, leaves it.
    await onTurnComplete(w.p, turn('agent-1'), pass)
    w.sid.value = 'session-other'
    await onTurnComplete(w.p, turn(), pass)
    w.sid.value = 'session-a'
    expect((await readLock(w.p, w.dir))?.oid).toBe(oid)

    await onTurnComplete(w.p, turn(), pass)
    expect(await readLock(w.p, w.dir)).toBeNull()
    expect(await getPending(w.p, w.litterDir)).toBeNull()
    expect(existsSync(leasePath(w.litterDir, oid))).toBe(false)
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ generation: 0, status: 'launch_failed', reason: 'not launched' }))
    expect(existsSync(activePath(w.litterDir))).toBe(false)
  })

  test('session.end releases it too, for the ending session only', async () => {
    const w = await world()
    const r = await started(w)
    await onSessionEnd(w.p, { sessionId: 'session-other', reason: 'other' } as never, pass)
    expect(await readLock(w.p, w.dir)).not.toBeNull()
    await onSessionEnd(w.p, { sessionId: 'session-a', reason: 'prompt_input_exit' } as never, pass)
    expect(await readLock(w.p, w.dir)).toBeNull()
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ generation: 0, status: 'launch_failed' }))
  })
})

describe('TaskStop settling', () => {
  const line = (ev: 'start' | 'stop', agent: string, w: World) =>
    ({
      v: 1,
      ev,
      ts: 1,
      session_id: 'session-a',
      agent_id: agent,
      agent_type: 'litter:executor',
      cwd: w.dir,
      transcript_path: join(w.projectDir, 'session-a', 'subagents', `agent-${agent}.jsonl`),
      stop_hook_active: false,
      background_tasks: 0,
    }) as never

  test('a stop settles to stopped at once when nothing of the run is live', async () => {
    const w = await world()
    const r = await launched(w)
    expect(await observeStop(w.p, r.taskId)).toBe(true)
    expect((await ledgerOf(w, r.ref)).map(x => x.kind).slice(-2)).toEqual(['run.stopping', 'run.end'])
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ status: 'stopped', settled: true, source: 'taskstop' }))
    await released(w, r)
  })

  test('a live agent and a missing engine snapshot hold it in stopping; their end settles it', async () => {
    const w = await world()
    const r = await launched(w)
    const sctx = { p: w.p, litterDir: w.litterDir, sessionId: 'session-a' }
    await consumeLifecycle(sctx, line('start', 'ag1', w))
    // sw- agents aren't the run's.
    await consumeLifecycle(sctx, { ...(line('start', 'sw1', w) as object), agent_type: 'litter:sw-worker' } as never)
    mkdirSync(join(w.projectDir, 'session-a', 'workflows'), { recursive: true })

    expect(await observeStop(w.p, r.taskId)).toBe(true)
    expect(await lastEnd(w, r.ref)).toBeUndefined()
    expect((await readPolicy(w.p, w.litterDir))?.run?.stopping).toBe(true)
    expect(await readLock(w.p, w.dir)).not.toBeNull()

    await consumeLifecycle(sctx, line('stop', 'ag1', w))
    expect(await lastEnd(w, r.ref)).toBeUndefined()

    await atomicWriteJson(w.p, join(w.projectDir, 'session-a', 'workflows', `${r.runId}.json`), { status: 'killed' })
    expect(await trySettle(w.p, r.ref)).toBe(true)
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ status: 'stopped', settled: true }))
    await released(w, r)
  })

  test("a stop of a task that isn't a run's is only passed on", async () => {
    const w = await world()
    await launched(w)
    expect(await observeStop(w.p, 'not-ours')).toBe(false)
  })
})

describe('reconcile at session.start', () => {
  test('a run.start whose launch nobody holds any more is launch_failed', async () => {
    const w = await world()
    const r = await started(w)
    const oid = (await getPending(w.p, w.litterDir))!.oid
    // The session died: the lock went (a crash after a manual cleanup), the store kept nothing.
    stopLease()
    await w.p.run(['git', '-C', w.dir, 'update-ref', '-d', 'refs/litter-active', oid])
    w.p.storeMap.clear()
    w.sid.value = 'session-b'
    await reconcileRuns(w.p, w.litterDir)
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ generation: 0, status: 'launch_failed', source: 'reconcile' }))
    expect(existsSync(leasePath(w.litterDir, oid))).toBe(false)
  })

  test("this session's own pending launch after a reload keeps its lock, and its lease beats again", async () => {
    const w = await world()
    const r = await started(w)
    const oid = (await getPending(w.p, w.litterDir))!.oid
    stopLease()
    await reconcileRuns(w.p, w.litterDir)
    expect(await lastEnd(w, r.ref)).toBeUndefined()
    expect((await readLock(w.p, w.dir))?.oid).toBe(oid)
    expect(w.p.timers.size).toBeGreaterThan(0)
  })

  test("an orphaned launch (another session's, its lease stale) is recovered", async () => {
    const w = await world()
    const r = await started(w)
    const oid = (await getPending(w.p, w.litterDir))!.oid
    stopLease()
    await atomicWriteJson(w.p, leasePath(w.litterDir, oid), { oid, run: r.run, session: 'session-a', beatAt: 0 })
    w.sid.value = 'session-b'
    await reconcileRuns(w.p, w.litterDir)
    expect(await readLock(w.p, w.dir)).toBeNull()
    const kinds = (await ledgerOf(w, r.ref)).map(x => x.kind)
    expect(kinds).toEqual(['run.start', 'lock.recovered', 'run.end'])
    expect((await ledgerOf(w, r.ref))[1]!.body).toEqual(expect.objectContaining({ branch: `litter/${r.run}`, previousBranch: 'refs/heads/main' }))
  })

  test("an open generation the engine's snapshot says completed is ended from it", async () => {
    const w = await world()
    const r = await launched(w)
    await consumeLifecycle({ p: w.p, litterDir: w.litterDir, sessionId: 'session-a' }, {
      v: 1,
      ev: 'start',
      ts: 1,
      session_id: 'session-a',
      agent_id: 'x',
      agent_type: 'general-purpose',
      cwd: w.dir,
      transcript_path: join(w.projectDir, 'session-a.jsonl'),
    })
    await atomicWriteJson(w.p, join(w.projectDir, 'session-a', 'workflows', `${r.runId}.json`), { status: 'completed', result: { halted: null } })
    w.sid.value = 'session-b'
    await reconcileRuns(w.p, w.litterDir)
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ status: 'done', source: 'reconcile' }))
    await released(w, r)
  })

  test('an open generation with no snapshot is still running: the index is back, the policy names the new session', async () => {
    const w = await world()
    const r = await launched(w)
    await w.p.store.delete(taskKey(r.taskId))
    w.sid.value = 'session-b'
    await reconcileRuns(w.p, w.litterDir)
    expect(await lastEnd(w, r.ref)).toBeUndefined()
    expect(await w.p.store.get(taskKey(r.taskId))).toEqual(r.ref)
    expect((await readPolicy(w.p, w.litterDir))?.session).toBe('session-b')
    expect((await readLock(w.p, w.dir))?.blob?.run).toBe(r.run)
    expect(w.p.logs.some(l => l.includes(`run ${r.run} is active`))).toBe(true)
  })

  test('a stopping run with nothing live settles', async () => {
    const w = await world()
    const r = await launched(w)
    await appendRecord(w.p, r.ref.runDir, { run: r.run, kind: 'run.stopping', by: { source: 'mod' }, body: { taskId: r.taskId, generation: 1 } })
    await reconcileRuns(w.p, w.litterDir)
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ status: 'stopped', settled: true }))
  })

  test("a lease of an oid that doesn't hold the lock is removed", async () => {
    const w = await world()
    const stray = 'a'.repeat(40)
    await atomicWriteJson(w.p, leasePath(w.litterDir, stray), { oid: stray, run: 'x', session: 'y', beatAt: 0 })
    await reconcileRuns(w.p, w.litterDir)
    expect(existsSync(leasePath(w.litterDir, stray))).toBe(false)
  })

  test("a tampered ledger isn't acted on", async () => {
    const w = await world()
    const r = await launched(w)
    const first = join(ledgerDir(r.ref.runDir), '000001-run.start.json')
    const rec = JSON.parse(await w.p.fs.read(first))
    writeFileSync(first, `${JSON.stringify({ ...rec, body: { ...rec.body, base: 'f'.repeat(40) } })}\n`)
    await atomicWriteJson(w.p, join(w.projectDir, 'session-a', 'workflows', `${r.runId}.json`), { status: 'completed', result: { halted: null } })
    await reconcileRuns(w.p, w.litterDir)
    expect(w.p.logs.some(l => l.includes('tampered'))).toBe(true)
    expect(runState((await readLedger(w.p, r.ref.runDir, r.run)).records).ended).toBe(false)
    expect((await readLock(w.p, w.dir))?.blob?.run).toBe(r.run)
  })
})
