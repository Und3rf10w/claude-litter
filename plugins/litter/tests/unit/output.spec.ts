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
          roots: { checkout: dir, litterDir: dir, litterCopies: [dir], ruleDirs: [], worktrees: [], integration: null },
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
  test("a gate critic's result becomes its verdict, and each proposed rule a rule.propose", async () => {
    await startAgent('gc', 'litter:gate-critic')
    await consumeOutput(ctx(), output('gc', 'litter:gate-critic', VERDICT))
    const recs = await records()
    expect(recs.map(r => r.kind)).toEqual(['verdict', 'rule.propose', 'rule.propose'])
    expect(recs[0]!.body).toEqual({ ...VERDICT, tool_use_id: 'tu1' })
    expect(recs[0]!.by).toEqual({ source: 'agent', agentId: 'gc', agentType: 'litter:gate-critic' })
    expect(recs[1]!.body).toEqual({ rule: VERDICT.proposed_rules[0], source: 'critic', tool_use_id: 'tu1', index: 0 })
    expect(recs[2]!.body).toEqual(expect.objectContaining({ rule: VERDICT.proposed_rules[2], index: 2 }))
  })

  test('a line drained twice records nothing new', async () => {
    await startAgent('gc', 'litter:gate-critic')
    await consumeOutput(ctx(), output('gc', 'litter:gate-critic', VERDICT))
    await consumeOutput(ctx(), output('gc', 'litter:gate-critic', VERDICT))
    expect((await records()).length).toBe(3)
    await consumeOutput(ctx(), output('gc', 'litter:gate-critic', VERDICT, 'tu2'))
    expect((await records()).length).toBe(6)
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
