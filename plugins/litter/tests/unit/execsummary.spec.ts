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
    add,
    start: () => add('run.start', { workflow: 'execute' }),
    launch: () => add('run.launch', { taskId: 't1', runId: 'wf_1', session: 's1', oid: 'o' }),
    verify: (gate: string, attempt: number, green = true) =>
      add('verify', { verify_id: `${gate}-${attempt}-v`, gate, attempt, exit_code: green ? 0 : 1, signal: null, timed_out: false, spawn_error: null, green }),
    /** A critic's verdict; `rule_clash` only when given, as before WP-AH. */
    verdict: (gate: string, attempt: number, o: { failing?: Record<string, string[]>; plan_gap?: string; rule_clash?: string } = {}) =>
      add('verdict', {
        verify_id: `${gate}-${attempt}-v`,
        ...Object.fromEntries(
          ['plan_adherence', 'tests_green', 'no_regressions', 'rules'].map(d => [
            d,
            o.failing?.[d] ? dim(false, `${d}: src/b.ts:4 is wrong`, o.failing[d]) : dim(true, `${d} holds`),
          ]),
        ),
        plan_gap: o.plan_gap ?? '',
        ...(o.rule_clash !== undefined ? { rule_clash: o.rule_clash } : {}),
        proposed_rules: [],
      }),
    land: (gate: string, commit: string) => add('land', { gate, verify_id: `${gate}-1-v`, commit }),
    /** An executor's result, as output.ts records it (GateResultBody): blocked when `gap` or `notes` is given. */
    wrote: (gate: string, attempt: number, o: { gap?: string; notes?: string } = {}) =>
      add('task.result', {
        task: null,
        role: 'executor',
        tool_use_id: `tu-w-${gate}-${attempt}`,
        result: { status: o.gap !== undefined || o.notes !== undefined ? 'blocked' : 'done', plan_lines: [], files: [], checks: [], notes: o.notes ?? '', plan_gap: o.gap ?? '' },
        gate,
        attempt,
      }),
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

  test("an executor's plan-gap stop (WP-AH): the gate that stopped shows the executor's gap, with no verdict", async () => {
    const gap = 'plan.md:12 says "Hello, World"; the contract at plan.md:3 says tests/expected.txt decides'
    const l = ledger()
    l.start(), l.launch(), l.wrote('G1', 1), l.verify('G1', 1), l.verdict('G1', 1), l.land('G1', C1)
    l.wrote('G2', 1, { gap })
    l.end('halted', `G2 plan gap: ${gap}`)
    deps.proposalsOf = async () => []
    const lines = await summary(json(), l.records)
    // The stop is an attempt, though nothing judged it.
    expect(section(lines, '## Attempts')).toContain('- G2 (Second): 1 attempt; no verdict recorded')
    expect(section(lines, '## Where it stopped').slice(2)).toEqual([
      `halted: G2 plan gap: ${gap}`,
      '',
      "The gate that didn't land: G2 (Second).",
      'Its executor stopped on attempt 1 before the attempt was judged, naming a plan gap:',
      `- plan_gap: ${gap}`,
      'No verdict was recorded for it.',
      '',
    ])
  })

  test("an executor's plan-gap stop after a rejected attempt shows the gap, then that attempt's verdict", async () => {
    const l = ledger()
    l.start(), l.launch(), l.wrote('G1', 1), l.verify('G1', 1), l.verdict('G1', 1, { failing: { plan_adherence: ['the version field'] } })
    l.wrote('G1', 2, { gap: 'the gaps ask for a version field plan.md:4 never names' })
    l.end('halted', 'G1 plan gap: the gaps ask for a version field plan.md:4 never names')
    deps.proposalsOf = async () => []
    const lines = await summary(json(), l.records)
    expect(section(lines, '## Attempts')).toContain(`- G1 (First): 2 attempts; the last verdict (attempt 1) failed plan_adherence: ${file('G1', 1)}`)
    const where = section(lines, '## Where it stopped')
    expect(where.slice(4, 8)).toEqual([
      "The gate that didn't land: G1 (First).",
      'Its executor stopped on attempt 2 before the attempt was judged, naming a plan gap:',
      '- plan_gap: the gaps ask for a version field plan.md:4 never names',
      `Its last verdict, attempt 1 (${file('G1', 1)}):`,
    ])
  })

  test("an executor's block with no plan gap, and a gap the critic judged after, add no executor line", async () => {
    const l = ledger()
    l.start(), l.launch(), l.verify('G1', 1), l.verdict('G1', 1), l.land('G1', C1)
    l.wrote('G2', 1, { notes: 'plan.md:8 conflicts with P-no-net@1' })
    l.end('halted', 'G2 blocked: plan.md:8 conflicts with P-no-net@1')
    deps.proposalsOf = async () => []
    expect(section(await summary(json(), l.records), '## Where it stopped').join('\n')).not.toContain('Its executor stopped')
    const m = ledger()
    m.start(), m.launch(), m.wrote('G1', 1, { gap: 'old' }), m.verify('G1', 1), m.verdict('G1', 1, { plan_gap: 'new' }), m.end('halted', 'G1 plan gap: new')
    const where = section(await summary(json(), m.records), '## Where it stopped')
    expect(where.join('\n')).not.toContain('Its executor stopped')
    expect(where).toContain('- plan_gap: new')
  })

  test("a critic's rule clash (WP-AH) fails its verdict and is quoted where it stopped; a blank one fails nothing", async () => {
    const clash = 'P-no-net@1 bans the network, and plan.md:8 asks for curl'
    const l = ledger()
    l.start(), l.launch(), l.verify('G1', 1), l.verdict('G1', 1, { rule_clash: '  ' }), l.land('G1', C1)
    l.verify('G2', 1), l.verdict('G2', 1, { rule_clash: clash })
    l.end('halted', `G2 rule clash: ${clash}`)
    deps.proposalsOf = async () => []
    const lines = await summary(json(), l.records)
    expect(section(lines, '## Attempts').slice(2)).toEqual([
      `- G1 (First): 1 attempt; the last verdict (attempt 1) passed every dimension: ${file('G1', 1)}`,
      `- G2 (Second): 1 attempt; the last verdict (attempt 1) failed rule_clash: ${file('G2', 1)}`,
      '',
    ])
    const where = section(lines, '## Where it stopped')
    expect(where).toContain(`Its last verdict, attempt 1 (${file('G2', 1)}):`)
    expect(where).toContain(`- rule_clash: ${clash}`)
    expect(where.join('\n')).not.toContain('- plan_gap:')
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
      'Proposed, not accepted, waiting in /litter rules:',
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
      "The proposals couldn't be read: the rules ledger is tampered at 3. /litter rules lists them.",
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

// WP-AO: the files added to gates, and what a land changed outside its gate's Files.
describe("files outside the gates' Files", () => {
  const HEADING = "## Files outside the gates' Files"

  test('your widenings, the critic\'s, and what a land changed with neither, in the ledger\'s order, before the rules', async () => {
    const l = ledger()
    l.start()
    l.add('gate.widen', { gate: 'G2', files: ['gen.sh', 'lib/'], why: 'b.txt is generated', by: 'you', at: 'launch', plans: [] })
    l.launch(), l.verify('G1', 1), l.verdict('G1', 1), l.land('G1', C1)
    l.add('gate.widen', { gate: 'G1', files: ['src/gen.sh'], why: 'the parser is generated', by: 'critic', at: 'land', verify_id: 'G1-1-v' })
    l.add('gate.widen', { gate: 'G2', files: ['x.sh'], why: 'w', by: 'you', at: 'run', plans: [] })
    l.add('land', { gate: 'G2', verify_id: 'G2-1-v', commit: 'c2'.repeat(20), outside: ['notes.md', 'z.md'] })
    l.end('done', null)
    deps.proposalsOf = async () => []
    const lines = await summary(json({ widen: 'critic' }), l.records)
    expect(section(lines, HEADING)).toEqual([
      HEADING,
      '',
      "This run's critics could accept a file a gate can't do without (widen: critic).",
      '',
      '- G2: gen.sh, lib/, added by you before Launch: b.txt is generated',
      '- G1: src/gen.sh, accepted by its critic (verify G1-1-v); review it: the parser is generated',
      '- G2: x.sh, added by you during the run: w',
      '',
      "Changed by a land outside its gate's Files, neither added by you nor accepted by its critic:",
      '',
      `- G2 (${'c2'.repeat(6)}): notes.md, z.md`,
      '',
    ])
    expect(lines.indexOf(HEADING)).toBeLessThan(lines.indexOf('## Rules used'))
  })

  test('none of them, no section', async () => {
    const l = ledger()
    l.start(), l.launch(), l.verify('G1', 1), l.verdict('G1', 1), l.land('G1', C1), l.end('done', null)
    deps.proposalsOf = async () => []
    expect(await summary(json(), l.records)).not.toContain(HEADING)
  })

  test("an amend run: the files its amendment added to the gate's Files, first, and alone they make the section", async () => {
    const l = ledger()
    l.start(), l.launch(), l.verify('G2', 1), l.verdict('G2', 1), l.land('G2', C1), l.end('done', null)
    deps.proposalsOf = async () => []
    const amendOf = { run: '20261002-execute-0a0b0c', gate: 'G2', filesAdded: ['gen.sh', 'lib/'], reason: 'b.txt is generated' }
    const lines = await summary(json({ amendOf }), l.records)
    expect(section(lines, HEADING)).toEqual([HEADING, '', '- G2: gen.sh, lib/, added to its Files by the amendment of run 20261002-execute-0a0b0c: b.txt is generated', ''])
    // With your widening after it, in the same list; with no reason, none is given.
    l.add('gate.widen', { gate: 'G2', files: ['x.sh'], why: 'w', by: 'you', at: 'run', plans: [] })
    const { reason: _reason, ...noReason } = amendOf
    expect(section(await summary(json({ amendOf: noReason }), l.records), HEADING)).toEqual([
      HEADING,
      '',
      '- G2: gen.sh, lib/, added to its Files by the amendment of run 20261002-execute-0a0b0c',
      '- G2: x.sh, added by you during the run: w',
      '',
    ])
    // An amend whose amendment added nothing has no section.
    expect(await summary(json({ amendOf: { run: amendOf.run, gate: 'G2' } }), l.records.filter(r => r.kind !== 'gate.widen'))).not.toContain(HEADING)
  })
})
