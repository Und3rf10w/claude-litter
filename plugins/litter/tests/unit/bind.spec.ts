// Tier 2: the writer binding (plan section 7, fanout.js step 2; section 12's
// "task binding" and "a failed bind"), through the record tool as a fanout
// writer calls it: the caller's cwd against the run's recorded worktrees, the
// body and the agent file, one task per worktree and one worktree per task,
// the restarted writer, rebinding after a stopped writer (COMMON.md), and the
// refusal's out file.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Policy } from '../../hooks/hookfiles'
import type { Author, RecordError, RecordOk, RecordReply } from '../../hooks/records/core'
import type { RunJson } from '../../hooks/records/run'
import { dispatchRecord, type DispatchEnv } from '../../hooks/ledger'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { agentPolicyPath, integrationBranch, integrationName, outPath, runDir as runDirOf, runJsonPath, writerBranch } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { consumeAgents, writePolicy } from '../../hooks/policy'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const RUN = '20261002-fanout-b1nd00'
const WF = 'wf_1a2b3c4d-567'
const BASE = 'a'.repeat(40)
const MOD: Author = { source: 'mod' }

let p: TestPorts
let dir: string
let litterDir: string
let runDir: string
let root: string
let cleanup: () => void
let env: DispatchEnv

type Wt = { name: string; path: string; branch: string }
let wt1: Wt
let wt2: Wt
let wt3: Wt
let integ: Wt

beforeEach(async () => {
  p = nodePorts()
  const s = scratch()
  cleanup = s.cleanup
  dir = realpathSync(s.dir)
  litterDir = join(dir, '.claude', 'litter')
  runDir = runDirOf(litterDir, RUN)
  root = join(dir, '.claude', 'worktrees')
  env = { litterDir, litterDirError: null, ready: true, options: normalizeOptions(undefined) }
  const json: Partial<RunJson> = {
    v: 1,
    run: RUN,
    workflow: 'fanout',
    args: {
      tasks: [
        { id: 'T1', title: 'one', text: 'do one', writes: true, files: ['a/'], bind: 'tok-1' },
        { id: 'T2', title: 'two', text: 'do two', writes: true, files: ['b.ts'], bind: 'tok-2' },
        { id: 'R1', title: 'read', text: 'look', writes: false, files: [] },
      ],
    },
    base: BASE,
    ref: `refs/heads/litter/${RUN}`,
    checkout: dir,
  }
  await p.fs.write(runJsonPath(runDir), JSON.stringify(json))
  await appendRecord(p, runDir, { run: RUN, kind: 'run.start', by: { source: 'launcher' }, body: { workflow: 'fanout', base: BASE } })
  await appendRecord(p, runDir, { run: RUN, kind: 'run.launch', by: MOD, body: { taskId: 't', runId: WF, generation: 1 } })
  await writePolicy(p, litterDir, policy())
  wt1 = await created(`${WF}-1`, writerBranch(RUN, 1))
  wt2 = await created(`${WF}-2`, writerBranch(RUN, 2))
  wt3 = await created(`${WF}-3`, writerBranch(RUN, 3))
  integ = await created(integrationName(RUN), integrationBranch(RUN))
})
afterEach(() => cleanup())

function policy(): Policy {
  return {
    v: 1,
    session: 'test-session',
    litterDir,
    run: {
      run: RUN,
      workflow: 'fanout',
      runDir,
      checkout: dir,
      base: BASE,
      runIds: [WF],
      launching: false,
      stopping: false,
      inflight: null,
      isolationLost: false,
      roots: { checkout: dir, litterDir, litterCopies: [litterDir], ruleDirs: [], worktrees: [], integration: null },
      setup: null,
      linkDirs: [],
      worktreeRoot: root,
    },
    roles: {},
    swarm: null,
  }
}

/** A worktree on disk with its worktree.create, as the drained spool leaves it. */
async function created(name: string, branch: string): Promise<Wt> {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  await appendRecord(p, runDir, { run: RUN, kind: 'worktree.intent', by: MOD, body: { run: RUN, name, path, branch, base: BASE, disposable: false } })
  await appendRecord(p, runDir, { run: RUN, kind: 'worktree.create', by: MOD, body: { run: RUN, name, path, branch, base: BASE, disposable: false, ignored: [] } })
  return { name, path, branch }
}

const ctx = () => ({ p, litterDir, sessionId: 'test-session' })

/** An agent's SubagentStart, as identity.sh spools it: its cwd is the worktree the engine ran it in. */
async function start(id: string, cwd: string, type = 'litter:executor') {
  await consumeAgents(ctx(), { v: 1, ev: 'start', ts: 1_700_000_000, session_id: 'test-session', agent_id: id, agent_type: type, cwd, transcript_path: '/t' })
}

async function stop(id: string, type = 'litter:executor') {
  await consumeAgents(ctx(), { v: 1, ev: 'stop', ts: 1_700_000_100, session_id: 'test-session', agent_id: id, agent_type: type, transcript_path: '/t', stop_hook_active: false, background_tasks: 0 })
}

const bind = (agentId: string, token?: string) => dispatchRecord(p, agentId, { kind: 'task.bind', ...(token === undefined ? {} : { token }) }, env)

const asError = (r: RecordReply) => {
  expect(r.ok).toBe(false)
  return r as RecordError
}
const asOk = (r: RecordReply) => {
  expect(r.ok).toBe(true)
  return r as RecordOk
}

const binds = async () => (await readLedger(p, runDir, RUN)).records.filter(r => r.kind === 'task.bind')
const outFile = (id: string) => JSON.parse(readFileSync(outPath(litterDir, id), 'utf8'))
const agentFile = (id: string) => JSON.parse(readFileSync(agentPolicyPath(litterDir, id), 'utf8'))
const shape = (w: Wt) => ({ name: w.name, path: w.path, branch: w.branch })

describe('task.bind: the worktree', () => {
  test("a cwd that isn't one of the run's recorded worktrees is refused, and the refusal goes to the out file", async () => {
    await start('w1', join(dir, 'elsewhere'))
    const e = asError(await bind('w1', 'tok-1'))
    expect(e.error).toBe(`litter: your working directory ${join(dir, 'elsewhere')} isn't one of this run's worktrees, so task.bind can't bind you`)
    expect(outFile('w1')).toEqual({ v: 1, agent_id: 'w1', for: {}, fields: { bind_refusal: e.error } })
    expect(existsSync(agentPolicyPath(litterDir, 'w1'))).toBe(false)
    expect(await binds()).toEqual([])
  })

  test("the mod's own worktrees bind no one", async () => {
    await start('w1', integ.path)
    expect(asError(await bind('w1', 'tok-1')).error).toContain("isn't one of this run's worktrees")
  })

  test('the cwd is compared resolved: a path through a link to the worktree binds', async () => {
    symlinkSync(wt1.path, join(dir, 'via-link'))
    await start('w1', join(dir, 'via-link'))
    expect(asOk(await bind('w1', 'tok-1')).worktree).toEqual(shape(wt1))
  })

  test('the body and the agent file carry the worktree; the token is never stored; a success removes an earlier refusal', async () => {
    await start('w1', wt1.path)
    expect(asError(await bind('w1')).field).toBe('token')
    expect(asError(await bind('w1', 'tok-9')).field).toBe('token')
    expect(outFile('w1').fields.bind_refusal).toContain('no task of this run has that bind value')
    const r = asOk(await bind('w1', 'tok-1'))
    expect(r).toEqual(expect.objectContaining({ ok: true, kind: 'task.bind', run: RUN, task: 'T1', worktree: shape(wt1) }))
    expect(existsSync(outPath(litterDir, 'w1'))).toBe(false)
    expect(agentFile('w1')).toEqual({ v: 1, run: RUN, task: { id: 'T1', owned: ['a/'] }, worktree: shape(wt1) })
    const [rec] = await binds()
    expect(rec!.body).toEqual({ task: 'T1', worktree: shape(wt1) })
    expect(rec!.by).toEqual({ source: 'agent', agentId: 'w1', agentType: 'litter:executor' })
    expect(JSON.stringify(await readLedger(p, runDir, RUN))).not.toContain('tok-1')
  })

  test('only a writer binds', async () => {
    await start('rl', wt1.path, 'litter:relay')
    expect(asError(await bind('rl', 'tok-1')).error).toContain("task.bind is for a fanout's writers")
    expect(existsSync(outPath(litterDir, 'rl'))).toBe(false)
  })
})

describe('task.bind: one task per worktree, one worktree per task', () => {
  test("a token presented from another task's worktree is refused", async () => {
    await start('w2', wt2.path)
    await start('w2b', wt2.path)
    asOk(await bind('w2', 'tok-2'))
    const e = asError(await bind('w2b', 'tok-1'))
    expect(e.error).toContain('this worktree is already bound to task T2')
    expect(outFile('w2b').fields.bind_refusal).toBe(e.error)
  })

  test('a bound writer stays bound to its task: the same call again stands, another token is refused without an out file', async () => {
    await start('w1', wt1.path)
    const first = asOk(await bind('w1', 'tok-1'))
    const again = asOk(await bind('w1', 'tok-1'))
    expect(again.seq).toBe(first.seq)
    expect(asError(await bind('w1', 'tok-2')).error).toContain("you're already bound to task T1")
    expect(existsSync(outPath(litterDir, 'w1'))).toBe(false)
    expect(await binds()).toHaveLength(1)
  })

  test('a restarted writer presenting its token from the same worktree is accepted', async () => {
    await start('w1', wt1.path)
    await start('w1b', wt1.path)
    asOk(await bind('w1', 'tok-1'))
    const r = asOk(await bind('w1b', 'tok-1'))
    expect(r.supersedes).toBeUndefined()
    expect(agentFile('w1b')).toEqual({ v: 1, run: RUN, task: { id: 'T1', owned: ['a/'] }, worktree: shape(wt1) })
    expect((await binds()).map(b => b.body)).toEqual([
      { task: 'T1', worktree: shape(wt1) },
      { task: 'T1', worktree: shape(wt1) },
    ])
  })
})

describe('task.bind: rebinding from a second worktree', () => {
  test('refused while the first writer runs', async () => {
    await start('w1', wt1.path)
    await start('w3', wt3.path)
    asOk(await bind('w1', 'tok-1'))
    const e = asError(await bind('w3', 'tok-1'))
    expect(e.error).toBe(`litter: task T1 is bound to agent w1 in ${wt1.path}, which is still running; only that worktree can bind it`)
    expect(outFile('w3').fields.bind_refusal).toBe(e.error)
  })

  test('accepted once the first writer stopped with no result, and recorded as superseding it', async () => {
    await start('w1', wt1.path)
    await start('w3', wt3.path)
    asOk(await bind('w1', 'tok-1'))
    await stop('w1')
    const r = asOk(await bind('w3', 'tok-1'))
    expect(r).toEqual(expect.objectContaining({ task: 'T1', worktree: shape(wt3), supersedes: 'w1' }))
    expect((await binds()).at(-1)!.body).toEqual({ task: 'T1', worktree: shape(wt3), supersedes: 'w1' })
    // The first worktree stays T1's: it can't take another task.
    await start('w1c', wt1.path)
    expect(asError(await bind('w1c', 'tok-2')).error).toContain('this worktree is already bound to task T1')
  })

  test('refused once the first writer returned a result, whoever recorded it', async () => {
    for (const by of [{ source: 'agent', agentId: 'w1', agentType: 'litter:executor' }, { source: 'mod' }] as Author[]) {
      const run2 = by.source === 'agent' ? 'w1' : 'm1'
      await start(run2, wt1.path)
      await start(`${run2}-next`, wt3.path)
      await appendRecord(p, runDir, { run: RUN, kind: 'task.bind', by: { source: 'agent', agentId: run2, agentType: 'litter:executor' }, body: { task: 'T1', worktree: shape(wt1) } })
      await appendRecord(p, runDir, {
        run: RUN,
        kind: 'task.result',
        by,
        body: { task: 'T1', role: 'executor', tool_use_id: `tu-${run2}`, result: { status: 'done' }, ...(by.source === 'mod' ? { agent_id: run2 } : {}) },
      })
      await stop(run2)
      expect(asError(await bind(`${run2}-next`, 'tok-1')).error).toContain('that writer already returned its result')
    }
  })
})

describe('the unbound writer, through the record tool', () => {
  test('may record only task.bind until it binds', async () => {
    await start('w1', wt1.path)
    const propose = () => dispatchRecord(p, 'w1', { kind: 'rule.propose', rule: 'When a task owns a folder, keep its tests inside it.' }, env)
    const e = asError(await propose())
    expect(e.error).toBe('litter: bind first: record kind task.bind with the bind value from your <task>')
    expect(e.allowed).toEqual(['task.bind'])
    asOk(await bind('w1', 'tok-1'))
    asOk(await propose())
  })
})
