// Tier 2: hooks/execsummary.ts, summary.md's execute part (COMMON step 1),
// from a ledger built here: the Gates table as before, the attempts and last
// verdict per gate, where a halted or interrupted run stopped with the
// evidence, the chain's earlier lands, the rules used, and the proposals
// through the deps seam (AD's proposalsOf).

import { afterEach, describe, expect, test } from 'bun:test'
import type { StoredRecord } from '../../hooks/records/core'
import type { RunJson } from '../../hooks/records/run'
import { verdictFile } from '../../hooks/layout'
import { deps, executeSummary } from '../../hooks/execsummary'
import { nodePorts } from './support/node-ports'

const RUN = '20261003-execute-ab12cd'
const REF = { run: RUN, runDir: `/repo/.claude/litter/${RUN}`, litterDir: '/repo/.claude/litter' }
const C1 = '1'.repeat(40)

const realProposals = deps.proposalsOf
afterEach(() => {
  deps.proposalsOf = realProposals
})

/** A ledger, built in order: each record gets the next seq. */
function ledger() {
  const records: StoredRecord[] = []
  const add = (kind: string, body: Record<string, unknown>) => {
    records.push({ v: 1, seq: records.length + 1, kind, run: RUN, at: 1_700_000_000_000 + records.length, by: { source: 'mod' }, prev: null, body } as StoredRecord)
    return records.at(-1)!
  }
  const dim = (pass: boolean, evidence: string, gaps: string[] = []) => ({ pass, evidence, gaps })
  return {
    records,
    start: () => add('run.start', { workflow: 'execute' }),
    launch: () => add('run.launch', { taskId: 't1', runId: 'wf_1', session: 's1', oid: 'o' }),
    verify: (gate: string, attempt: number, green = true) =>
      add('verify', { verify_id: `${gate}-${attempt}-v`, gate, attempt, exit_code: green ? 0 : 1, signal: null, timed_out: false, spawn_error: null, green }),
    verdict: (gate: string, attempt: number, o: { failing?: Record<string, string[]>; plan_gap?: string } = {}) =>
      add('verdict', {
        verify_id: `${gate}-${attempt}-v`,
        ...Object.fromEntries(
          ['plan_adherence', 'tests_green', 'no_regressions', 'rules'].map(d => [
            d,
            o.failing?.[d] ? dim(false, `${d}: src/b.ts:4 is wrong`, o.failing[d]) : dim(true, `${d} holds`),
          ]),
        ),
        plan_gap: o.plan_gap ?? '',
        proposed_rules: [],
      }),
    land: (gate: string, commit: string) => add('land', { gate, verify_id: `${gate}-1-v`, commit }),
    end: (status: string, reason: string | null, generation = 1) => add('run.end', { taskId: 't1', generation, status, reason, source: 'notification' }),
    repair: () => add('run.repair', { swarm: 'sw1', launch: 'l1' }),
  }
}

function json(extra: Partial<RunJson> = {}, args: Record<string, unknown> = {}): RunJson {
  return {
    v: 1,
    run: RUN,
    workflow: 'execute',
    args: { gates: [{ id: 'G1', title: 'First' }, { id: 'G2', title: 'Second' }], ...args },
    rules: [{ id: 'header-parser', version: 2 }, { id: 'no-deps', version: 1 }],
    ...extra,
  } as RunJson
}

const file = (gate: string, attempt: number) => verdictFile(REF.runDir, gate, attempt)
const summary = (j: RunJson | null, records: StoredRecord[]) => executeSummary(nodePorts(), REF, j, records)
const section = (lines: string[], heading: string): string[] => {
  const at = lines.indexOf(heading)
  if (at < 0) return []
  const next = lines.findIndex((l, i) => i > at && l.startsWith('## '))
  return lines.slice(at, next < 0 ? lines.length : next)
}

describe('an execute run that landed every gate', () => {
  test('the Gates table as before, each gate with one attempt and an approving verdict, no "Where it stopped"', async () => {
    const l = ledger()
    l.start(), l.launch(), l.verify('baseline', 1), l.verify('G1', 1), l.verdict('G1', 1), l.land('G1', C1)
    l.verify('G2', 1), l.verdict('G2', 1), l.land('G2', 'c2'), l.end('done', null)
    deps.proposalsOf = async () => []
    const lines = await summary(json(), l.records)
    expect(lines.slice(0, 7)).toEqual(['', '## Gates', '', '| Gate | Landed |', '|---|---|', `| G1 | ${C1} |`, '| G2 | c2 |'])
    expect(section(lines, '## Attempts')).toEqual([
      '## Attempts',
      '',
      `- G1 (First): 1 attempt; the last verdict (attempt 1) passed every dimension: ${file('G1', 1)}`,
      `- G2 (Second): 1 attempt; the last verdict (attempt 1) passed every dimension: ${file('G2', 1)}`,
      '',
    ])
    expect(lines).not.toContain('## Where it stopped')
    expect(section(lines, '## Rules used')).toEqual(['## Rules used', '', 'header-parser@2, no-deps@1'])
    expect(lines).not.toContain('## Rules proposed in this run')
  })
})

describe('a halted run', () => {
  test('a plan gap: the halt, the gate that stopped and its last verdict, with the failing attempt counted', async () => {
    const l = ledger()
    l.start(), l.launch(), l.verify('G1', 1), l.verdict('G1', 1), l.land('G1', C1)
    l.verify('G2', 1, false), l.verdict('G2', 1, { failing: { tests_green: ['b.spec:3 fails'] } })
    l.verify('G2', 2), l.verdict('G2', 2, { plan_gap: 'b.txt has to be generated; the plan says to write it' })
    l.end('halted', 'G2 plan gap: b.txt has to be generated; the plan says to write it')
    deps.proposalsOf = async () => []
    const lines = await summary(json(), l.records)
    expect(section(lines, '## Attempts')).toContain(`- G2 (Second): 2 attempts; the last verdict (attempt 2) failed plan_gap: ${file('G2', 2)}`)
    expect(section(lines, '## Where it stopped')).toEqual([
      '## Where it stopped',
      '',
      'halted: G2 plan gap: b.txt has to be generated; the plan says to write it',
      '',
      "The gate that didn't land: G2 (Second).",
      `Its last verdict, attempt 2 (${file('G2', 2)}):`,
      '- plan_gap: b.txt has to be generated; the plan says to write it',
      '',
    ])
  })

  test('three rejects: the evidence of each dimension that failed, with its gaps', async () => {
    const l = ledger()
    l.start(), l.launch()
    for (const n of [1, 2, 3]) l.verify('G1', n, n !== 3), l.verdict('G1', n, { failing: n === 3 ? { tests_green: ['a.spec:7 fails'], rules: ['header-parser@2: src/a.ts:2 writes a file'] } : { plan_adherence: [] } })
    l.end('halted', 'G1 did not land after 3 attempts')
    deps.proposalsOf = async () => []
    const lines = await summary(json(), l.records)
    expect(section(lines, '## Attempts')).toEqual([
      '## Attempts',
      '',
      `- G1 (First): 3 attempts; the last verdict (attempt 3) failed tests_green, rules: ${file('G1', 3)}`,
      '- G2 (Second): no attempt',
      '',
    ])
    expect(section(lines, '## Where it stopped').slice(2)).toEqual([
      'halted: G1 did not land after 3 attempts',
      '',
      "The gate that didn't land: G1 (First).",
      `Its last verdict, attempt 3 (${file('G1', 3)}):`,
      '- tests_green: tests_green: src/b.ts:4 is wrong',
      '  - a.spec:7 fails',
      '- rules: rules: src/b.ts:4 is wrong',
      '  - header-parser@2: src/a.ts:2 writes a file',
      '',
    ])
  })

  test("blocked: the gate with no verdict says so", async () => {
    const l = ledger()
    l.start(), l.launch(), l.verify('G1', 1), l.verdict('G1', 1), l.land('G1', C1)
    l.end('halted', 'G2 blocked: b.txt is generated')
    deps.proposalsOf = async () => []
    const lines = await summary(json(), l.records)
    expect(section(lines, '## Attempts')).toContain('- G2 (Second): no attempt')
    expect(section(lines, '## Where it stopped').slice(2)).toEqual(['halted: G2 blocked: b.txt is generated', '', "The gate that didn't land: G2 (Second).", 'No verdict was recorded for it.', ''])
  })

  test('an approved gate that did not land (a land refused) says its verdict passed', async () => {
    const l = ledger()
    l.start(), l.launch(), l.verify('G1', 1), l.verdict('G1', 1)
    l.end('halted', 'G1 approved but not landed: HEAD is on main')
    deps.proposalsOf = async () => []
    const lines = await summary(json(), l.records)
    expect(section(lines, '## Where it stopped')).toContain(`Its last verdict, attempt 1, passed every dimension (${file('G1', 1)}).`)
  })

  test('an interrupted run reports where it stopped the same way', async () => {
    const l = ledger()
    l.start(), l.launch(), l.verify('G1', 1), l.verdict('G1', 1), l.land('G1', C1)
    l.end('interrupted', "interrupted: agent type 'litter:executor' not found")
    deps.proposalsOf = async () => []
    const lines = await summary(json(), l.records)
    expect(section(lines, '## Where it stopped').slice(0, 5)).toEqual([
      '## Where it stopped',
      '',
      "interrupted: interrupted: agent type 'litter:executor' not found",
      '',
      "The gate that didn't land: G2 (Second).",
    ])
  })

  test("a repair generation after the halt doesn't hide where the workflow stopped, and its lands don't count", async () => {
    const l = ledger()
    l.start(), l.launch(), l.verify('G1', 1), l.verdict('G1', 1, { plan_gap: 'gap' }), l.end('halted', 'G1 plan gap: gap')
    l.repair(), l.verify('G1', 2), l.verdict('G1', 2), l.land('G1', C1), l.end('done', null, 2)
    deps.proposalsOf = async () => []
    const lines = await summary(json(), l.records)
    expect(section(lines, '## Where it stopped')).toContain('halted: G1 plan gap: gap')
    expect(section(lines, '## Where it stopped')).toContain(`Its last verdict, attempt 1 (${file('G1', 1)}):`)
    expect(lines).toContain(`| G1 | ${C1} |`)
  })
})

describe('the chain, the rules and the proposals', () => {
  test("a continuation lists the chain's earlier lands after the table, as before", async () => {
    const l = ledger()
    l.start(), l.launch(), l.verify('G2', 1), l.verdict('G2', 1), l.land('G2', 'c2'), l.end('done', null)
    deps.proposalsOf = async () => []
    const lines = await summary(json({}, { gates: [{ id: 'G2', title: 'Second' }], landed: [{ id: 'G1', commit: C1 }] }), l.records)
    expect(lines.slice(0, 8)).toEqual(['', '## Gates', '', '| Gate | Landed |', '|---|---|', '| G2 | c2 |', '', `Landed earlier in this chain: G1 (${C1})`])
  })

  test('no rules recorded reads none', async () => {
    deps.proposalsOf = async () => []
    const lines = await summary(json({ rules: [] }), [])
    expect(section(lines, '## Rules used')).toEqual(['## Rules used', '', 'none'])
  })

  test("the run's proposals come through the seam, for this run, marked proposed and not accepted", async () => {
    const asked: unknown[] = []
    deps.proposalsOf = async (_p, litterDir, filter) => {
      asked.push([litterDir, filter])
      return [
        { ref: { store: 'repo', seq: 4 }, body: { rule: 'parse with\nthe shared tokenizer', source: 'critic', gate: 'G2', run: RUN }, status: 'proposed' },
        { ref: { store: 'repo', seq: 5 }, body: { rule: 'log through the logger', source: 'critic', run: RUN }, status: 'dismissed' },
      ]
    }
    const lines = await summary(json(), [])
    expect(asked).toEqual([[REF.litterDir, { run: RUN }]])
    expect(section(lines, '## Rules proposed in this run')).toEqual([
      '## Rules proposed in this run',
      '',
      'Proposed, not accepted, waiting in /litter-rules:',
      '',
      '- parse with the shared tokenizer (critic, G2)',
      '- log through the logger (critic), now dismissed',
    ])
  })

  test("proposals that can't be read say so, and the rest stands", async () => {
    deps.proposalsOf = async () => {
      throw new Error('the rules ledger is tampered at 3')
    }
    const lines = await summary(json(), [])
    expect(section(lines, '## Rules proposed in this run')).toEqual([
      '## Rules proposed in this run',
      '',
      "The proposals couldn't be read: the rules ledger is tampered at 3. /litter-rules lists them.",
    ])
    expect(lines).toContain('## Gates')
  })

  test('no run.json still gives the rules line and a table of what landed', async () => {
    const l = ledger()
    l.land('G1', C1)
    deps.proposalsOf = async () => []
    const lines = await summary(null, l.records)
    expect(lines).toContain(`| G1 | ${C1} |`)
    expect(lines).not.toContain('## Attempts')
    expect(section(lines, '## Rules used')).toEqual(['## Rules used', '', 'none'])
  })
})
