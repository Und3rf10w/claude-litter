// Tier 2: the call-out to the repair bridge (hooks/lifecycle.ts; WP-V): after
// a halted fanout's endRun returned (outside the run's serial key), from the
// task notification and from the launcher's fallback; nothing for any other
// ending; a rejection logged with the end standing; and the order
// prompt.submit relies on: the settle, the bridge with it, then a <swarm>
// block that shows the swarm the bridge started.

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordCtx } from '../../hooks/records/core'
import type { RunEndBody } from '../../hooks/records/run'
import type { LiveSwarm } from '../../hooks/swarm/types'
import type { RunRef } from '../../hooks/lifecycle'
import * as realRepair from '../../hooks/repair'
import { onPromptSubmit, recordRunEnd, settleNotices, taskKey } from '../../hooks/lifecycle'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { runDir as runDirOf, runJsonPath, summaryPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { serial } from '../../hooks/fsx'
import { updateSession } from '../../hooks/session'
import { swarmContext } from '../../hooks/swarm/admit'
import * as state from '../../hooks/swarm/state'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// ---------------------------------------------------------------------------
// X's bridge, stood in for (restored after this file)

const REPAIR = '../../hooks/repair'
const realRepairCopy = { ...realRepair }
type Seen = { runDir: string; ended: boolean; summary: boolean }
const bridged: Seen[] = []
let bridge: ((p: TestPorts, runDir: string) => Promise<void>) | null = null
let ports: TestPorts
mock.module(REPAIR, () => ({
  ...realRepairCopy,
  continueAsRepair: async (_p: unknown, runDir: string) => {
    const run = runDir.slice(runDir.lastIndexOf('/') + 1)
    const { records } = await readLedger(ports, runDir, run)
    bridged.push({ runDir, ended: records.some(r => r.kind === 'run.end'), summary: existsSync(summaryPath(runDir)) })
    if (bridge) await bridge(ports, runDir)
  },
}))
afterAll(() => {
  mock.module(REPAIR, () => realRepairCopy)
})

// ---------------------------------------------------------------------------
// A run with one generation open, built by hand: run.json, run.launch, the task's index

const RUN = '20261003-fan'
const TASK = 'task-1'
let dir: string
let litterDir: string
let cleanup: () => void

beforeEach(async () => {
  state.resetForTests()
  bridged.length = 0
  bridge = null
  const s = scratch()
  cleanup = s.cleanup
  dir = realpathSync(s.dir)
  ports = nodePorts()
  ports.clock.now = 1_800_000_000_000
  await scratchRepo(ports, dir)
  litterDir = join(dir, '.claude', 'litter')
  updateSession({ litterDir })
})
afterEach(() => {
  state.resetForTests()
  updateSession({ litterDir: null })
  cleanup()
})

async function openRun(workflow: 'fanout' | 'execute', run = RUN, taskId = TASK): Promise<RunRef> {
  const ref: RunRef = { run, runDir: runDirOf(litterDir, run), litterDir }
  const json = { v: 1, run, workflow, args: {}, ref: `refs/heads/litter/${run}`, base: '0'.repeat(40), checkout: dir, isolate: false, linkDirs: [] }
  await ports.fs.write(runJsonPath(ref.runDir), `${JSON.stringify(json)}\n`)
  await appendRecord(ports, ref.runDir, {
    run,
    kind: 'run.launch',
    by: { source: 'mod' },
    body: { taskId, runId: 'wf_abc123', scriptPath: null, generation: 1, session: 'session-a', oid: '1'.repeat(40) },
  })
  await ports.store.set(taskKey(taskId), ref)
  return ref
}

const notice = (status: string, result?: string, taskId = TASK) =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n` +
  `<summary>Dynamic workflow "litter:fanout" ${status}</summary>\n` +
  (result !== undefined ? `<result>${result}</result>\n` : '') +
  '</task-notification>'

const submitted = (text: string) => ({ text, origin: { kind: 'task-notification' }, wait: false }) as never

const ends = async (ref: RunRef): Promise<RunEndBody[]> =>
  (await readLedger(ports, ref.runDir, ref.run)).records.filter(r => r.kind === 'run.end').map(r => r.body as unknown as RunEndBody)

const HALTED = '{"halted":"not verified: client failed the verifier"}'

describe('from the task notification', () => {
  test('a halted fanout goes to the bridge once its run.end and summary.md are written', async () => {
    const ref = await openRun('fanout')
    await settleNotices(ports, submitted(notice('completed', HALTED)))
    expect(bridged).toEqual([{ runDir: ref.runDir, ended: true, summary: true }])
    expect((await ends(ref))[0]).toEqual(expect.objectContaining({ status: 'halted', source: 'notification' }))
  })

  test("it runs outside the run's serial key: the bridge can take it, append and rewrite", async () => {
    const ref = await openRun('fanout')
    let inside = 'not called'
    bridge = async (p, runDir) => {
      // Inside endRun's key this would wait on itself; the race fails the test instead of hanging it.
      inside = await Promise.race([
        serial(`run:${runDir}`, async () => {
          await appendRecord(p, runDir, { run: RUN, kind: 'repair.declined', by: { source: 'mod' }, body: { reason: 'the baseline is red' } })
          return 'took the key'
        }),
        new Promise<string>(resolve => setTimeout(() => resolve('waited on the key'), 2_000)),
      ])
    }
    await settleNotices(ports, submitted(notice('completed', HALTED)))
    expect(inside).toBe('took the key')
    expect((await readLedger(ports, ref.runDir, RUN)).records.map(r => r.kind)).toEqual(['run.launch', 'run.end', 'repair.declined'])
  })

  test('nothing else goes to it: a done fanout, a stopped one, a failed one, a halted execute', async () => {
    const cases: [string, 'fanout' | 'execute', string, string | undefined][] = [
      ['20261003-done', 'fanout', 'completed', '{"halted":null}'],
      ['20261003-stop', 'fanout', 'killed', undefined],
      ['20261003-fail', 'fanout', 'failed', undefined],
      ['20261003-exec', 'execute', 'completed', HALTED],
    ]
    for (const [run, workflow, status, result] of cases) {
      const taskId = `task-${run}`
      const ref = await openRun(workflow, run, taskId)
      await settleNotices(ports, submitted(notice(status, result, taskId)))
      expect({ run, ended: (await ends(ref)).length }).toEqual({ run, ended: 1 })
    }
    expect(bridged).toEqual([])
  })

  test('a second notice for an ended generation records nothing, so nothing goes to the bridge again', async () => {
    await openRun('fanout')
    await settleNotices(ports, submitted(notice('completed', HALTED)))
    await settleNotices(ports, submitted(notice('completed', HALTED)))
    expect(bridged).toHaveLength(1)
  })

  test("a bridge that rejects is logged; the run's end stands and the prompt goes on", async () => {
    const ref = await openRun('fanout')
    bridge = async () => {
      throw new Error('no baseline')
    }
    let passed = false
    await onPromptSubmit(ports, submitted(notice('completed', HALTED)), (async () => {
      passed = true
    }) as never)
    expect(passed).toBe(true)
    expect(ports.logs.some(l => l.includes(`run ${RUN}: the repair bridge failed: no baseline`))).toBe(true)
    expect((await ends(ref))[0]?.status).toBe('halted')
  })

  test("a prompt that isn't a task notification settles nothing", async () => {
    await openRun('fanout')
    await settleNotices(ports, { text: notice('completed', HALTED), origin: { kind: 'composer' }, wait: false } as never)
    await settleNotices(ports, { text: notice('completed', HALTED), wait: false } as never)
    expect(bridged).toEqual([])
  })

  test("X's bridge itself rejects a folder that isn't a run's, which the call-out logs", async () => {
    await expect(realRepairCopy.continueAsRepair(ports, '/x')).rejects.toThrow("/x isn't a run's folder")
  })
})

describe("prompt.submit's order", () => {
  function repairSwarm(name: string): LiveSwarm {
    return {
      name,
      launch: '20261003-120000',
      revision: 1,
      spec: { name, goal: 'repair the run', nodes: [{ id: 'repair', kind: 'orchestrator' }] },
      nonce: 'n0nce',
      types: { repair: `litter:sw-${name}-repair` },
      typesReady: true,
      dirs: {},
      sessionCwd: dir,
      worktreeRoot: join(dir, '.claude', 'worktrees'),
      commonDir: join(dir, '.git'),
      roots: { litterDir, litterCopies: [litterDir], ruleDirs: [] },
      tips: {},
      owner: { ref: `refs/litter-swarm/${name}`, oid: 'a'.repeat(40), generation: 1, session: 'session-a' },
      state: 'live',
      readOnly: false,
      lost: false,
      flags: { isolationLost: false },
      startedAt: 1_800_000_000_000,
      run: { runDir: runDirOf(litterDir, RUN), run: RUN, generation: 2 },
      budget: { rounds: 3, agents: 6 },
    }
  }

  test('a block built after the settle shows the swarm the bridge started; one built before would not', async () => {
    await openRun('fanout')
    bridge = async () => {
      state.putLiveSwarm(repairSwarm('repair-abc123'))
    }
    expect(await swarmContext(ports)).toBeNull()
    await settleNotices(ports, submitted(notice('completed', HALTED)))
    const block = await swarmContext(ports)
    expect(block).toContain('repair-abc123')
  })
})

describe("from the launcher's fallback", () => {
  const ctx = (): RecordCtx => ({ p: ports, caller: { agentId: null, agentType: null }, litterDir, options: normalizeOptions(undefined) })

  test('a halted fanout it records goes to the bridge, after its run.end', async () => {
    const ref = await openRun('fanout')
    const r = await recordRunEnd(ctx(), { kind: 'run.end', run: RUN, taskId: TASK, status: 'completed', result: HALTED })
    expect(r).toEqual(expect.objectContaining({ ok: true, recorded: true }))
    expect(bridged).toEqual([{ runDir: ref.runDir, ended: true, summary: true }])
  })

  test('nothing when the notification ended it first, or the end is not halted', async () => {
    await openRun('fanout')
    await settleNotices(ports, submitted(notice('completed', HALTED)))
    bridged.length = 0
    expect(await recordRunEnd(ctx(), { kind: 'run.end', run: RUN, taskId: TASK, status: 'completed', result: HALTED })).toEqual(
      expect.objectContaining({ ok: true, recorded: false }),
    )
    await openRun('fanout', '20261003-done', 'task-done')
    await recordRunEnd(ctx(), { kind: 'run.end', run: '20261003-done', taskId: 'task-done', status: 'completed', result: '{"halted":null}' })
    await openRun('fanout', '20261003-intr', 'task-intr')
    await recordRunEnd(ctx(), { kind: 'run.end', run: '20261003-intr', taskId: 'task-intr', status: 'interrupted', reason: 'role missing' })
    expect(bridged).toEqual([])
  })
})
