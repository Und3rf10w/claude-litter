// Tier 2: the import from deepwork (plan 16.8, 12:1579; COMMON decision 3).
// A live instance's state.json holds user, flag, orchestrator,
// scope-boundary and incident guardrails, and its incidents.jsonl repeats
// one of them; an archived instance has its own flag guardrail. Each is
// offered once, as a proposed project ban; the live user and flag ones are
// preselected, the archived instance's flag one isn't; nothing is accepted.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import type { RecordReply } from '../../hooks/records/core'
import type { RuleImportBody, RuleOpenBody, RuleProposeBody } from '../../hooks/records/rules'
import { dispatchRecord } from '../../hooks/ledger'
import { normalizeOptions } from '../../hooks/options'
import { readDeepwork } from '../../hooks/rules/import'
import { readRuleLedger } from '../../hooks/rules/ledger'
import { deps as recordsDeps } from '../../hooks/rules/records'
import { loadRules, proposalsOf } from '../../hooks/rules/store'
import { fakePatterns, rulesWorld, type RulesWorld } from './rules-harness'

let w: RulesWorld
let restore: () => void
let opened: RuleOpenBody[]
const realOpen = recordsDeps.openRulesPane

beforeEach(async () => {
  restore = fakePatterns()
  w = await rulesWorld()
  opened = []
  recordsDeps.openRulesPane = async (_p, focus) => {
    opened.push(focus as RuleOpenBody)
    return true
  }
})
afterEach(() => {
  recordsDeps.openRulesPane = realOpen
  restore()
  w.cleanup()
})

const deepwork = () => `${w.repo}/.claude/deepwork`
const env = () => ({ litterDir: w.litterDir, litterDirError: null, ready: true, options: normalizeOptions(undefined) })
const importIt = () => dispatchRecord(w.p, undefined, { tool: 'mcp__litter__record', tool_use_id: 'tu1', kind: 'rule.import', from: 'deepwork' }, env())
const asOk = (r: RecordReply) => {
  if (!r.ok) throw new Error(`refused: ${r.error}`)
  return r as Record<string, unknown>
}

const LIVE_GOAL = 'Ship the parser'
const LIVE_DATE = '2026-09-30T10:00:00Z'
const OLD_DATE = '2026-08-01T09:00:00Z'

/** The two instances, and a folder with neither state file (not an instance). */
async function instances(): Promise<void> {
  const g = (rule: string, source: string, more: Record<string, unknown> = {}) => ({ rule, source, timestamp: LIVE_DATE, ...more })
  await w.p.fs.write(
    `${deepwork()}/live-1/state.json`,
    JSON.stringify({
      goal: LIVE_GOAL,
      started_at: LIVE_DATE,
      guardrails: [
        g('Never push to main.', 'user'),
        g('Keep the public API stable.', 'flag'),
        g('Ask before deleting files.', 'orchestrator'),
        g('Plan-only scope: no edits outside docs/.', 'scope-boundary'),
        g('Retry a flaky test once, never more.', 'incident', { incident_ref: 'inc-1' }),
      ],
    }),
  )
  await w.p.fs.write(
    `${deepwork()}/live-1/incidents.jsonl`,
    [
      // The same incident as state's: render_guardrails keeps the first of each incident_ref.
      JSON.stringify(g('Retry a flaky test once, never more.', 'incident', { incident_ref: 'inc-1' })),
      'not json',
      // No ref, so render_guardrails keeps it; its text is the user guardrail's.
      JSON.stringify(g('  never push to MAIN. ', 'incident')),
      JSON.stringify(g('Stop when the build is red.', 'incident', { incident_ref: 'inc-2' })),
      '',
    ].join('\n'),
  )
  await w.p.fs.write(
    `${deepwork()}/old-1/state.archived.json`,
    JSON.stringify({
      goal: 'Old work',
      last_updated: OLD_DATE,
      guardrails: [g('Use pnpm, never npm.', 'flag'), g('Keep the public API stable.', 'flag'), { source: 'user' }],
    }),
  )
  await w.p.fs.write(`${deepwork()}/empty-1/notes.md`, 'nothing here\n')
}

describe('readDeepwork', () => {
  test("every instance's guardrails, merged with its incidents as render_guardrails merges them", async () => {
    await instances()
    const batch = await readDeepwork(w.p, w.repo)
    expect(batch.instances).toEqual([
      { id: 'live-1', goal: LIVE_GOAL, date: LIVE_DATE, archived: false },
      { id: 'old-1', goal: 'Old work', date: OLD_DATE, archived: true },
    ])
    expect(batch.guardrails.map(g => [g.instance, g.source, g.text, g.incident_ref, g.archived])).toEqual([
      ['live-1', 'user', 'Never push to main.', null, false],
      ['live-1', 'flag', 'Keep the public API stable.', null, false],
      ['live-1', 'orchestrator', 'Ask before deleting files.', null, false],
      ['live-1', 'scope-boundary', 'Plan-only scope: no edits outside docs/.', null, false],
      ['live-1', 'incident', 'Retry a flaky test once, never more.', 'inc-1', false],
      ['live-1', 'incident', '  never push to MAIN. ', null, false],
      ['live-1', 'incident', 'Stop when the build is red.', 'inc-2', false],
      ['old-1', 'flag', 'Use pnpm, never npm.', null, true],
      ['old-1', 'flag', 'Keep the public API stable.', null, true],
    ])
    expect(batch.problems).toEqual(['instance old-1: 1 guardrail with no rule text left out'])
  })

  test('without an incidents.jsonl, state is listed as it is, a repeated incident_ref and all', async () => {
    const g = (rule: string) => ({ rule, source: 'incident', incident_ref: 'inc-9' })
    await w.p.fs.write(`${deepwork()}/live-2/state.json`, JSON.stringify({ goal: 'g', guardrails: [g('One.'), g('Two.')] }))
    expect((await readDeepwork(w.p, w.repo)).guardrails.map(x => x.text)).toEqual(['One.', 'Two.'])
  })

  test('no deepwork folder, an unreadable state, and a state that is no object', async () => {
    expect(await readDeepwork(w.p, w.repo)).toEqual({ instances: [], guardrails: [], problems: [] })
    await w.p.fs.write(`${deepwork()}/a/state.json`, '{ nope')
    await w.p.fs.write(`${deepwork()}/b/state.json`, '[]')
    const batch = await readDeepwork(w.p, w.repo)
    expect(batch.instances).toEqual([])
    expect(batch.problems).toHaveLength(2)
    expect(batch.problems[0]).toStartWith(`${deepwork()}/a/state.json couldn't be read:`)
    expect(batch.problems[1]).toBe(`${deepwork()}/b/state.json isn't a deepwork state object`)
  })
})

describe('rule.import', () => {
  test('each guardrail is offered once, as a proposed project ban; the live user and flag ones are preselected', async () => {
    await instances()
    const r = asOk(await importIt())
    expect(r).toEqual({
      ok: true,
      kind: 'rule.import',
      seq: 8,
      proposals: 7,
      live: 6,
      archived: 1,
      preselected: 2,
      skipped: { accepted: 0, pending: 0, dismissed: 0, repeated: 2 },
      instances: 2,
      problems: ['instance old-1: 1 guardrail with no rule text left out'],
      opened: true,
    })
    const recs = (await readRuleLedger(w.p, w.litterDir, 'repo')).records
    const proposed = recs.filter(x => x.kind === 'rule.propose').map(x => x.body as RuleProposeBody)
    expect(proposed.map(b => [b.rule, b.import?.source, b.import?.archived])).toEqual([
      ['Never push to main.', 'user', false],
      ['Keep the public API stable.', 'flag', false],
      ['Ask before deleting files.', 'orchestrator', false],
      ['Plan-only scope: no edits outside docs/.', 'scope-boundary', false],
      ['Retry a flaky test once, never more.', 'incident', false],
      ['Stop when the build is red.', 'incident', false],
      ['Use pnpm, never npm.', 'flag', true],
    ])
    for (const b of proposed) {
      expect([b.source, b.scope, b.type, b.paths, b.doc?.type, b.doc?.status, b.doc?.applies]).toEqual(['import', 'project', 'ban', [], 'ban', 'proposed', { paths: [], when: '' }])
    }
    expect(proposed[4]!.import).toEqual({ instance: 'live-1', source: 'incident', archived: false, incident_ref: 'inc-1' })
    expect(proposed[0]!.doc!.body.why).toBe(`Imported from deepwork instance live-1 (${LIVE_GOAL}, ${LIVE_DATE}); source user`)
    expect(proposed[6]!.doc!.body.why).toBe(`Imported from deepwork instance old-1 (Old work, ${OLD_DATE}); source flag`)

    // The batch: every proposal, the two preselected, the archived instance's flag guardrail not among them.
    const batch = recs.at(-1)!
    expect(batch.kind).toBe('rule.import')
    const body = batch.body as RuleImportBody
    expect(body.proposals).toEqual([1, 2, 3, 4, 5, 6, 7].map(seq => ({ store: 'repo', seq })))
    expect(body.preselected).toEqual([
      { store: 'repo', seq: 1 },
      { store: 'repo', seq: 2 },
    ])
    expect(body.preselected).not.toContainEqual({ store: 'repo', seq: 7 })
    expect(opened).toEqual([{ proposal: { store: 'repo', seq: 8 } }])
  })

  test('nothing is accepted: no rule file, no rule.accept, every proposal still proposed', async () => {
    await instances()
    asOk(await importIt())
    const { rules } = await loadRules(w.p, w.litterDir)
    expect(rules).toEqual([])
    for (const dir of Object.values(w.dirs)) expect(existsSync(dir)).toBe(false)
    expect((await readRuleLedger(w.p, w.litterDir, 'repo')).records.some(x => x.kind === 'rule.accept')).toBe(false)
    expect((await proposalsOf(w.p, w.litterDir, {})).map(v => v.status)).toEqual(Array(7).fill('proposed'))
  })

  test('a second import offers nothing again: each is pending, and the repeats are counted', async () => {
    await instances()
    asOk(await importIt())
    const again = asOk(await importIt())
    expect(again).toEqual(expect.objectContaining({ proposals: 0, skipped: { accepted: 0, pending: 7, dismissed: 0, repeated: 2 }, opened: false, note: 'no new guardrails to propose' }))
    expect(opened).toHaveLength(1)
  })

  test("a long goal is cut to one line in the Why", async () => {
    const goal = `Rewrite\n  the parser ${'x'.repeat(300)}`
    await w.p.fs.write(`${deepwork()}/live-3/state.json`, JSON.stringify({ goal, guardrails: [{ rule: 'Keep it small.', source: 'user' }] }))
    asOk(await importIt())
    const why = ((await readRuleLedger(w.p, w.litterDir, 'repo')).records[0]!.body as RuleProposeBody).doc!.body.why
    const shown = why.slice('Imported from deepwork instance live-3 ('.length, why.indexOf(', no date)'))
    expect(shown).toHaveLength(160)
    expect(shown).toStartWith('Rewrite the parser xxx')
    expect(shown).toEndWith('…')
    expect(why).toEndWith(', no date); source user')
  })
})
