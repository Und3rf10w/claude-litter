// Tier 2: the observed fields (plan section 9, "Observed facts beat claimed
// ones"): out/<agent_id>.json, and the spooled StructuredOutput results the
// mod records.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OutFile, Policy, SpoolLine } from '../../hooks/hookfiles'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { hooksDir, ledgerDir, outPath, runDir } from '../../hooks/layout'
import { consumeOutput, safeFileName, writeOut } from '../../hooks/output'
import { consumeAgents, writePolicy } from '../../hooks/policy'
import { readRuleLedger } from '../../hooks/rules/ledger'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const RUN = '20261002-output'

let p: TestPorts
let dir: string
let cleanup: () => void

beforeEach(async () => {
  p = nodePorts()
  ;({ dir, cleanup } = scratch())
  await writePolicy(p, dir, policyFor(RUN))
})
afterEach(() => cleanup())

function policyFor(run: string | null): Policy {
  return {
    v: 1,
    session: 'test-session',
    litterDir: dir,
    run: run
      ? {
          run,
          workflow: 'execute',
          runDir: runDir(dir, run),
          checkout: dir,
          base: '0'.repeat(40),
          runIds: [],
          launching: false,
          stopping: false,
          inflight: null,
          isolationLost: false,
          roots: { checkout: dir, litterDir: dir, litterCopies: [dir], ruleDirs: [], worktrees: [] },
          setup: null,
          linkDirs: [],
        }
      : null,
    roles: {},
    swarm: null,
  }
}

const ctx = () => ({ p, litterDir: dir, sessionId: 'test-session' })

async function startAgent(id: string, type: string) {
  await consumeAgents(ctx(), {
    v: 1,
    ev: 'start',
    ts: 1_700_000_000,
    session_id: 'test-session',
    agent_id: id,
    agent_type: type,
    cwd: '/w',
    transcript_path: '/t',
  })
}

const output = (id: string, type: string, input: Record<string, unknown> | undefined, toolUseId = 'tu1'): SpoolLine => ({
  v: 1,
  ev: 'output',
  ts: 1_700_000_001,
  session_id: 'test-session',
  agent_id: id,
  agent_type: type,
  tool_use_id: toolUseId,
  ...(input ? { input } : {}),
})

const records = async () => (await readLedger(p, runDir(dir, RUN), RUN)).records
const ruleRecords = async () => (await readRuleLedger(p, dir, 'repo')).records
/** run.json as much as consumeOutput reads of it: the workflow. */
const runJson = (workflow: string) => p.fs.write(join(runDir(dir, RUN), 'run.json'), JSON.stringify({ v: 1, run: RUN, workflow }))

const VERDICT = {
  verify_id: 'vf1',
  plan_adherence: { pass: true, evidence: 'a.ts:3', gaps: [] },
  tests_green: { pass: true, evidence: 'exit 0', gaps: [] },
  no_regressions: { pass: true, evidence: 'ok', gaps: [] },
  rules: { pass: true, evidence: 'none apply', gaps: [] },
  plan_gap: '',
  proposed_rules: ['When a test touches the clock, freeze it.', '', 'Keep fixtures small.'],
}

describe('writeOut', () => {
  test('writes out/<agent_id>.json through a temp file and a rename', async () => {
    const writes: string[] = []
    const write = p.fs.write
    p.fs.write = async (path, t) => {
      writes.push(path)
      return write(path, t)
    }
    const out: OutFile = { v: 1, agent_id: 'a1', for: { verify_id: 'vf1' }, fields: { exit_code: 0, green: true } }
    await writeOut(p, dir, out)
    expect(JSON.parse(readFileSync(outPath(dir, 'a1'), 'utf8'))).toEqual(out)
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatch(/\/out\/a1\.json\.tmp-/)
    expect(readdirSync(join(hooksDir(dir), 'out'))).toEqual(['a1.json'])
  })

  test('refuses what output.sh could not use, and an id that could leave out/', async () => {
    const ok: OutFile = { v: 1, agent_id: 'a1', for: {}, fields: {} }
    for (const agent_id of ['', '.', '..', '../x', 'a/b', 'a\0b']) {
      await expect(writeOut(p, dir, { ...ok, agent_id })).rejects.toThrow("can't name a file")
    }
    await expect(writeOut(p, dir, { ...ok, v: 2 } as unknown as OutFile)).rejects.toThrow('not 1')
    await expect(writeOut(p, dir, { ...ok, for: { verifyId: 'x' } } as unknown as OutFile)).rejects.toThrow('for.verifyId')
    await expect(writeOut(p, dir, { ...ok, fields: [] } as unknown as OutFile)).rejects.toThrow('fields')
    expect(safeFileName('agent-1234')).toBe(true)
  })
})

describe('consumeOutput', () => {
  test("a gate critic's result becomes its verdict, and each proposed rule a rule.propose in the rules ledger", async () => {
    await startAgent('gc', 'litter:gate-critic')
    await consumeOutput(ctx(), output('gc', 'litter:gate-critic', VERDICT))
    const recs = await records()
    expect(recs.map(r => r.kind)).toEqual(['verdict'])
    expect(recs[0]!.body).toEqual({ ...VERDICT, tool_use_id: 'tu1' })
    expect(recs[0]!.by).toEqual({ source: 'agent', agentId: 'gc', agentType: 'litter:gate-critic' })
    // AD's store: the repository's rules ledger, with the run id (decision 17).
    const rules = await ruleRecords()
    expect(rules.map(r => r.kind)).toEqual(['rule.propose', 'rule.propose'])
    expect(rules[0]!.by).toEqual({ source: 'agent', agentId: 'gc', agentType: 'litter:gate-critic' })
    expect(rules[0]!.body).toEqual({ rule: VERDICT.proposed_rules[0], source: 'critic', run: RUN, tool_use_id: 'tu1', index: 0 })
    expect(rules[1]!.body).toEqual(expect.objectContaining({ rule: VERDICT.proposed_rules[2], index: 2 }))
  })

  test('a line drained twice records nothing new', async () => {
    await startAgent('gc', 'litter:gate-critic')
    await consumeOutput(ctx(), output('gc', 'litter:gate-critic', VERDICT))
    await consumeOutput(ctx(), output('gc', 'litter:gate-critic', VERDICT))
    expect([(await records()).length, (await ruleRecords()).length]).toEqual([1, 2])
    await consumeOutput(ctx(), output('gc', 'litter:gate-critic', VERDICT, 'tu2'))
    expect([(await records()).length, (await ruleRecords()).length]).toEqual([2, 4])
  })

  test("a verifier's result is its verdict, with no rule proposals", async () => {
    await startAgent('vr', 'litter:verifier')
    await consumeOutput(ctx(), output('vr', 'litter:verifier', { verify_id: 'vf2', tasks: [], proposed_rules: ['x'] }))
    expect((await records()).map(r => r.kind)).toEqual(['verdict'])
  })

  test("other roles, other agents and other events record nothing", async () => {
    await startAgent('ex', 'litter:executor')
    await startAgent('gp', 'general-purpose')
    await consumeOutput(ctx(), output('ex', 'litter:executor', { status: 'done' }))
    await consumeOutput(ctx(), output('gp', 'general-purpose', VERDICT))
    await consumeOutput(ctx(), { v: 1, ev: 'mode', ts: 1, session_id: 'test-session', agent_id: null, mode: 'auto' })
    expect(await records()).toEqual([])
  })

  test('an unknown agent, a contradicting type, or no result is logged and skipped', async () => {
    await startAgent('gc', 'litter:gate-critic')
    await consumeOutput(ctx(), output('ghost', 'litter:gate-critic', VERDICT))
    await consumeOutput(ctx(), output('gc', 'litter:verifier', VERDICT))
    await consumeOutput(ctx(), output('gc', 'litter:gate-critic', undefined))
    expect(await records()).toEqual([])
    const logs = p.logs.join('\n')
    expect(logs).toContain('which has no start')
    expect(logs).toContain('contradicts')
    expect(logs).toContain('carries no result')
  })

  test("a fanout writer's result becomes its task.result, once, with the task from its latest binding", async () => {
    const rd = runDir(dir, RUN)
    await runJson('fanout')
    await startAgent('ex', 'litter:executor')
    const by = { source: 'agent' as const, agentId: 'ex', agentType: 'litter:executor' }
    const worktree = { name: 'wf_1-1', path: '/w', branch: `litter/${RUN}-w1` }
    await appendRecord(p, rd, { run: RUN, kind: 'task.bind', by, body: { task: 'a', worktree } })
    await appendRecord(p, rd, { run: RUN, kind: 'task.bind', by: { ...by, agentId: 'other' }, body: { task: 'b', worktree } })
    const TASK = { status: 'done', files: ['pkgA/a.ts'], checks: ['bun test'], summary: 'did A', notes: '' }
    await consumeOutput(ctx(), output('ex', 'litter:executor', TASK))
    await consumeOutput(ctx(), output('ex', 'litter:executor', TASK))
    const results = (await records()).filter(r => r.kind === 'task.result')
    expect(results).toHaveLength(1)
    expect(results[0]!.body).toEqual({ task: 'a', role: 'executor', tool_use_id: 'tu1', result: TASK })
    expect(results[0]!.by).toEqual(by)
    // A verdict-role path isn't taken for it.
    expect((await records()).map(r => r.kind)).not.toContain('verdict')
  })

  test('an unbound writer\'s blocked result is recorded with no task, and what output.sh observed', async () => {
    await runJson('fanout')
    await startAgent('ex', 'litter:executor')
    const BLOCKED = { status: 'blocked', files: [], checks: [], summary: 'no task has that bind value', notes: '', unbound: true, bind_refusal: 'no task of this run has that bind value' }
    await consumeOutput(ctx(), output('ex', 'litter:executor', BLOCKED))
    const r = (await records()).find(x => x.kind === 'task.result')!
    expect(r.body).toEqual({ task: null, role: 'executor', tool_use_id: 'tu1', result: BLOCKED, unbound: true, bind_refusal: BLOCKED.bind_refusal })
  })

  test("a researcher's result, and an execute run's executor, record nothing", async () => {
    await runJson('execute')
    await startAgent('ex', 'litter:executor')
    await startAgent('rs', 'litter:researcher')
    await consumeOutput(ctx(), output('ex', 'litter:executor', { status: 'done' }))
    await runJson('fanout')
    await consumeOutput(ctx(), output('rs', 'litter:researcher', { answer: 'x' }))
    expect(await records()).toEqual([])
  })

  test('writeOut takes an integrate_id', async () => {
    const out: OutFile = { v: 1, agent_id: 'relay-1', for: { integrate_id: 'i7' }, fields: { integrate_id: 'i7', status: 'merged' } }
    await writeOut(p, dir, out)
    expect(JSON.parse(readFileSync(outPath(dir, 'relay-1'), 'utf8'))).toEqual(out)
  })

  test('a tampered ledger is logged and nothing is appended', async () => {
    await startAgent('gc', 'litter:gate-critic')
    const rd = runDir(dir, RUN)
    await appendRecord(p, rd, { run: RUN, kind: 'verify', by: { source: 'mod' }, body: { n: 1 } })
    await appendRecord(p, rd, { run: RUN, kind: 'verify', by: { source: 'mod' }, body: { n: 2 } })
    const first = join(ledgerDir(rd), '000001-verify.json')
    writeFileSync(first, readFileSync(first, 'utf8').replace('"n":1', '"n":9'))
    await consumeOutput(ctx(), output('gc', 'litter:gate-critic', VERDICT))
    expect(readdirSync(ledgerDir(rd))).toHaveLength(2)
    expect(p.logs.join('\n')).toContain('tampered')
  })
})
