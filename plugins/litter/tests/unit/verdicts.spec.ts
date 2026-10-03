// Tier 2: hooks/verdicts.ts, a verdict's file (plan section 10, "On disk"):
// one per gate and attempt, named from the verify the verdict cites, with the
// latest verdict for it winning, and none for a verdict whose verify isn't a
// plan gate's in the run's ledger.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { StoredRecord } from '../../hooks/records/core'
import type { VerifyBody } from '../../hooks/records/execute'
import { appendRecord } from '../../hooks/ledgercore'
import { runDir as runDirOf, verdictFile, verdictsDir } from '../../hooks/layout'
import { renderVerdict, verdictTarget, writeVerdictFile } from '../../hooks/verdicts'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const RUN = '20261003-execute-ab12cd'

let p: TestPorts
let dir: string
let cleanup: () => void
let rd: string

beforeEach(() => {
  p = nodePorts()
  ;({ dir, cleanup } = scratch())
  rd = runDirOf(dir, RUN)
})
afterEach(() => cleanup())

function verifyBody(id: string, gate: string, attempt: number, extra: Partial<VerifyBody> = {}): VerifyBody {
  return {
    verify_id: id,
    gate,
    attempt,
    argv: ['sh', 'check.sh'],
    tree_before: 'a'.repeat(40),
    tree_after: 'a'.repeat(40),
    dirty_submodules: [],
    exit_code: 0,
    signal: null,
    timed_out: false,
    spawn_error: null,
    green: true,
    log_parts: 1,
    log_bytes: 10,
    output_tail: 'ok',
    ...extra,
  }
}

const CRITIC = { source: 'agent' as const, agentId: 'gc1', agentType: 'litter:gate-critic' }

const verify = (body: VerifyBody) => appendRecord(p, rd, { run: RUN, kind: 'verify', by: CRITIC, body: body as unknown as Record<string, unknown> })

function verdictBody(verifyId: string, o: { failing?: string[]; plan_gap?: string; proposed?: string[] } = {}): Record<string, unknown> {
  const dim = (name: string) =>
    o.failing?.includes(name)
      ? { pass: false, evidence: `${name} failed at src/a.ts:3`, gaps: [`${name}: src/a.ts:3`, `${name}: src/a.ts:9`] }
      : { pass: true, evidence: `${name} holds`, gaps: [] }
  return {
    verify_id: verifyId,
    plan_adherence: dim('plan_adherence'),
    tests_green: dim('tests_green'),
    no_regressions: dim('no_regressions'),
    rules: dim('rules'),
    plan_gap: o.plan_gap ?? '',
    proposed_rules: o.proposed ?? [],
    tool_use_id: 'toolu_1',
  }
}
const verdict = (body: Record<string, unknown>, by = CRITIC) => appendRecord(p, rd, { run: RUN, kind: 'verdict', by, body })

describe('writeVerdictFile', () => {
  test('writes verdicts/<gate>-<attempt>.md from the verify it cites, with everything the record holds', async () => {
    await verify(verifyBody('G1-1-aa', 'G1', 1))
    await verify(verifyBody('G1-2-bb', 'G1', 2, { exit_code: 1, green: false }))
    const rec = await verdict(verdictBody('G1-2-bb', { failing: ['tests_green', 'rules'], proposed: ['parse with the shared tokenizer'] }))
    await writeVerdictFile(p, rd, rec)
    const path = verdictFile(rd, 'G1', 2)
    expect(readdirSync(verdictsDir(rd))).toEqual(['G1-2.md'])
    expect(readFileSync(path, 'utf8')).toBe(
      [
        '# Verdict on G1, attempt 2',
        '',
        `- Run: ${RUN}`,
        '- Verify: G1-2-bb, exit 1, not green',
        '- Verdict: rejected, failing tests_green, rules',
        '- Agent: gc1 (litter:gate-critic)',
        `- Ledger seq: ${rec.seq}`,
        '',
        '## plan_adherence: pass',
        '',
        'Evidence: plan_adherence holds',
        '',
        '## tests_green: fail',
        '',
        'Evidence: tests_green failed at src/a.ts:3',
        '',
        'Gaps:',
        '- tests_green: src/a.ts:3',
        '- tests_green: src/a.ts:9',
        '',
        '## no_regressions: pass',
        '',
        'Evidence: no_regressions holds',
        '',
        '## rules: fail',
        '',
        'Evidence: rules failed at src/a.ts:3',
        '',
        'Gaps:',
        '- rules: src/a.ts:3',
        '- rules: src/a.ts:9',
        '',
        '## Plan gap',
        '',
        'none',
        '',
        '## Rules the critic proposed',
        '',
        '- proposed, not accepted: parse with the shared tokenizer',
        '',
      ].join('\n'),
    )
  })

  test('an approving verdict, a plan gap, a killed verify and the goal check each read as they are', async () => {
    await verify(verifyBody('G2-1-cc', 'G2', 1, { exit_code: null, signal: 'SIGKILL', green: false }))
    const gap = await verdict(verdictBody('G2-1-cc', { plan_gap: 'the plan names one header format; there are two' }))
    await writeVerdictFile(p, rd, gap)
    const text = readFileSync(verdictFile(rd, 'G2', 1), 'utf8')
    expect(text).toContain('- Verify: G2-1-cc, killed by SIGKILL, not green')
    expect(text).toContain('- Verdict: rejected, with a plan gap')
    expect(text).toContain('## Plan gap\n\nthe plan names one header format; there are two\n')

    await verify(verifyBody('goal-1-dd', 'goal', 1))
    const ok = await verdict(verdictBody('goal-1-dd'))
    await writeVerdictFile(p, rd, ok)
    const goal = readFileSync(verdictFile(rd, 'goal', 1), 'utf8')
    expect(goal).toContain('- Verdict: approved')
    expect(goal).toContain('## Rules the critic proposed\n\nnone\n')
  })

  test('the latest verdict for a gate and attempt wins, whatever order the files are written in', async () => {
    await verify(verifyBody('G1-1-aa', 'G1', 1))
    const older = await verdict(verdictBody('G1-1-aa', { failing: ['plan_adherence'] }))
    const newer = await verdict(verdictBody('G1-1-aa'))
    await writeVerdictFile(p, rd, newer)
    await writeVerdictFile(p, rd, older)
    const text = readFileSync(verdictFile(rd, 'G1', 1), 'utf8')
    expect(text).toContain(`- Ledger seq: ${newer.seq}`)
    expect(text).toContain('- Verdict: approved')
  })

  test('a swarm node\'s verdict names its gate, but the file still follows the cited verify', async () => {
    await verify(verifyBody('G3-4-ee', 'G3', 4))
    const rec = await verdict({ ...verdictBody('G3-4-ee'), gate: 'G3', attempt: 4, approved: true, round: null }, { source: 'agent', agentId: 'node-7', agentType: null } as never)
    await writeVerdictFile(p, rd, rec)
    expect(readFileSync(verdictFile(rd, 'G3', 4), 'utf8')).toContain('- Agent: node-7\n')
  })

  test("a verdict whose verify isn't in the ledger, or isn't a plan gate's, is logged and skipped", async () => {
    const lost = await verdict(verdictBody('G9-1-zz'))
    await writeVerdictFile(p, rd, lost)
    await verify(verifyBody('baseline-1-ff', 'baseline', 1))
    const base = await verdict(verdictBody('baseline-1-ff'))
    await writeVerdictFile(p, rd, base)
    expect(existsSync(verdictsDir(rd))).toBe(false)
    expect(p.logs.filter(l => l.includes("isn't a plan gate's verify in the run's ledger; no verdict file"))).toHaveLength(2)
    expect(p.logs.join('\n')).toContain('(G9-1-zz)')
  })

  test('a record that is not a verdict writes nothing', async () => {
    const v = await verify(verifyBody('G1-1-aa', 'G1', 1))
    await writeVerdictFile(p, rd, v as StoredRecord)
    expect(existsSync(verdictsDir(rd))).toBe(false)
  })
})

describe('verdictTarget and renderVerdict', () => {
  test('the target is the cited verify as recorded, and a missing dimension renders as missing', async () => {
    const v = await verify(verifyBody('G1-1-aa', 'G1', 1))
    const body = verdictBody('G1-1-aa')
    delete body.rules
    const rec = await verdict(body)
    const t = verdictTarget([v as StoredRecord, rec], rec)
    expect(t).toEqual(expect.objectContaining({ gate: 'G1', attempt: 1 }))
    const text = renderVerdict(RUN, rec, t!)
    expect(text).toContain('## rules: missing\n\nThe verdict has no such dimension.')
    expect(text).toContain('- Verdict: rejected, failing rules')
    expect(verdictTarget([rec], rec)).toBeNull()
  })
})
