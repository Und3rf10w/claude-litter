// Tier 2: a design's launch (COMMON step 2; WP-BD): parseDesign's bar
// minimum (decision 5) and unknowns (decision 3), and designArgs' template
// (decision 13), prior (decision 12) and base snapshot (plan 12:1763),
// through run.start in scratch repositories with real git.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordError, RecordInput } from '../../hooks/records/core'
import type { BarItem, DesignPrior, Workflow } from '../../hooks/records/run'
import type { DesignCriterion } from '../../hooks/records/design'
import { BAR_MIN_CRITERIA, deps as launchDeps, parseDesign, PRIOR_CAP } from '../../hooks/design/launch'
import { TEMPLATES } from '../../hooks/prompts/templates'
import { appendRecord } from '../../hooks/ledgercore'
import { ledgerDir, proposalPath, runDir, runJsonPath } from '../../hooks/layout'
import { sha256 } from '../../hooks/fsx'
import { stopLease } from '../../hooks/lock'
import { updateSession } from '../../hooks/session'
import { acceptedRule, BAR, barOf, launchWorld, nothingWritten, okReply, rule, startDesign, type LaunchWorld } from './designlaunch-harness'

// run.start runs real git in scratch repos; a loaded machine takes seconds.
setDefaultTimeout(120_000)

const saved = { ...launchDeps }
const cleanups: (() => void)[] = []
afterEach(() => {
  Object.assign(launchDeps, saved)
  stopLease()
  updateSession({ litterDir: null })
  for (const c of cleanups.splice(0)) c()
})

async function world(options: Record<string, unknown> = {}): Promise<LaunchWorld> {
  const w = await launchWorld(options)
  cleanups.push(w.cleanup)
  return w
}

const parse = (fields: Record<string, unknown>) =>
  parseDesign({ kind: 'run.start', workflow: 'design', goal: 'design the retry', deliverable: 'plan', bar: BAR, ...fields } as RecordInput)

const refusal = (r: { ok: boolean }): { error: string; field?: string } => {
  if (r.ok) throw new Error('accepted, and should have been refused')
  const { error, field } = r as RecordError
  return { error, ...(field !== undefined ? { field } : {}) }
}

const MINIMUM = "at least 6 criteria (C<n>) and at least 1 categorical ban (B<n>), each { id, text, evidence, reason (a ban's) }"

// ---------------------------------------------------------------------------

describe('the bar (decision 5)', () => {
  test('six criteria and a ban of yours are the minimum: five criteria with bans, or six without a ban, refuse naming bar and the minimum', () => {
    expect(BAR_MIN_CRITERIA).toBe(6)
    expect(parse({}).ok).toBe(true)
    expect(parse({ bar: barOf(6) }).ok).toBe(true)
    expect(refusal(parse({ bar: BAR.filter(b => b.id !== 'C5') }))).toEqual({ error: `'bar' has 5 criteria; it needs ${MINIMUM}`, field: 'bar' })
    // Seven items, two of them bans: still five criteria.
    expect(refusal(parse({ bar: barOf(5, 2) }))).toEqual({ error: `'bar' has 5 criteria; it needs ${MINIMUM}`, field: 'bar' })
    expect(refusal(parse({ bar: barOf(1, 1) }))).toEqual({ error: `'bar' has 1 criterion; it needs ${MINIMUM}`, field: 'bar' })
    expect(refusal(parse({ bar: barOf(6, 0) }))).toEqual({ error: `'bar' has no ban; it needs ${MINIMUM}`, field: 'bar' })
    expect(refusal(parse({ bar: [] }))).toEqual({ error: `'bar' is required for a design: ${MINIMUM}`, field: 'bar' })
    expect(refusal(parse({ bar: undefined }))).toEqual({ error: `'bar' is required for a design: ${MINIMUM}`, field: 'bar' })
  })

  test("each item's fields are checked first, each refusal naming bar[i] and the field", () => {
    const at = (i: number, patch: Partial<BarItem> | null) => {
      const bar: unknown[] = BAR.map(b => ({ ...b }))
      bar[i] = patch === null ? 'C9' : { ...(bar[i] as BarItem), ...patch }
      return refusal(parse({ bar }))
    }
    expect(at(2, { id: 'C1' })).toEqual({ error: "bar id 'C1' appears twice; give each item its own id", field: 'bar[2].id' })
    expect(at(1, { text: '  ' })).toEqual({ error: "'bar[1].text' is required", field: 'bar[1].text' })
    expect(at(3, { evidence: '' })).toEqual({ error: "'bar[3].evidence' is required: what evidence C4 needs", field: 'bar[3].evidence' })
    expect(at(6, { reason: undefined })).toEqual({ error: "ban B1 needs a 'bar[6].reason'", field: 'bar[6].reason' })
    for (const id of ['X1', 'C0', 'B01', 'c2', 'C']) expect(at(0, { id })).toEqual({ error: "'bar[0].id' must be C<n> for a criterion or B<n> for a ban", field: 'bar[0].id' })
    expect(at(4, null)).toEqual({ error: "'bar[4].id' must be C<n> for a criterion or B<n> for a ban", field: 'bar[4].id' })
    // A short bar with a bad item names the item first: the field to fix, then the minimum.
    expect(refusal(parse({ bar: [{ id: 'C1', text: 't' }] }))).toEqual({ error: "'bar[0].evidence' is required: what evidence C1 needs", field: 'bar[0].evidence' })
  })

  test('past 12 criteria it succeeds with the warning; 12 criteria give none, however many bans; your items keep only their own fields', () => {
    const thirteen = parse({ bar: barOf(13, 2) })
    expect(thirteen).toEqual(expect.objectContaining({ ok: true, warnings: ['the bar has 13 criteria; group related criteria (the interview aims for about 10)'] }))
    const twelve = parse({ bar: barOf(12, 4) })
    expect(twelve.ok && twelve.warnings).toBeUndefined()
    const forged = parse({ bar: [...BAR.slice(0, 6), { ...BAR[6]!, rule: { id: 'P-x', version: 9 }, rules: [] }] })
    expect(forged.ok && forged.value.bar).toEqual(BAR)
  })

  test("through run.start: the rules' items don't count toward the minimum, nor toward the warning", async () => {
    const w = await world()
    await acceptedRule(w, 'project', rule('P-ban', 'Never drop a table.', { type: 'ban', why: 'data loss' }))
    await acceptedRule(w, 'project', rule('P-api', 'Keep the API.'))
    expect(refusal(await startDesign(w, { bar: barOf(5) }))).toEqual({ error: `'bar' has 5 criteria; it needs ${MINIMUM}`, field: 'bar' })
    expect(refusal(await startDesign(w, { bar: barOf(6, 0) }))).toEqual({ error: `'bar' has no ban; it needs ${MINIMUM}`, field: 'bar' })
    await nothingWritten(w)
    const r = okReply(await startDesign(w, { bar: barOf(12) }))
    expect((r.args.bar as BarItem[]).map(b => b.id).slice(-3)).toEqual(['B1', 'B2', 'C13'])
    expect(r.warnings).toBeUndefined()
  })

  test('through run.start: thirteen criteria launch, and the reply carries the warning', async () => {
    const w = await world()
    const r = okReply(await startDesign(w, { bar: barOf(13) }))
    expect(r.warnings).toEqual(['the bar has 13 criteria; group related criteria (the interview aims for about 10)'])
  })
})

describe('empirical unknowns (decision 3)', () => {
  test('objects and bare strings, numbered U1 and U2 in order whatever ids came with them', () => {
    const r = parse({
      empiricalUnknowns: [
        { id: 'U7', question: ' Does the server send Retry-After? ', smallest_test: 'curl -I the endpoint', kill_result: 'no header in 10 tries' },
        'Is the timeout per attempt?',
      ],
    })
    expect(r.ok && r.value.empiricalUnknowns).toEqual([
      { id: 'U1', question: 'Does the server send Retry-After?', smallest_test: 'curl -I the endpoint', kill_result: 'no header in 10 tries' },
      { id: 'U2', question: 'Is the timeout per attempt?', smallest_test: '', kill_result: '' },
    ])
    const one = parse({ empiricalUnknowns: [{ question: 'q', smallest_test: null }] })
    expect(one.ok && one.value.empiricalUnknowns).toEqual([{ id: 'U1', question: 'q', smallest_test: '', kill_result: '' }])
    const none = parse({})
    expect(none.ok && none.value.empiricalUnknowns).toEqual([])
  })

  test('a third, a blank question, a field of another type or a list of another kind refuse, naming the field', () => {
    expect(refusal(parse({ empiricalUnknowns: ['a', 'b', 'c'] }))).toEqual({
      error: "'empiricalUnknowns' takes at most two, and has 3; keep the two the design depends on most",
      field: 'empiricalUnknowns',
    })
    expect(refusal(parse({ empiricalUnknowns: ['a', { question: '  ', smallest_test: 't' }] }))).toEqual({
      error: "'empiricalUnknowns[1].question' is required: what the design needs to find out",
      field: 'empiricalUnknowns[1].question',
    })
    expect(refusal(parse({ empiricalUnknowns: [''] }))).toEqual({
      error: "'empiricalUnknowns[0].question' is required: what the design needs to find out",
      field: 'empiricalUnknowns[0].question',
    })
    expect(refusal(parse({ empiricalUnknowns: [{ question: 'q', kill_result: 3 }] }))).toEqual({ error: "'empiricalUnknowns[0].kill_result' must be a string", field: 'empiricalUnknowns[0].kill_result' })
    expect(refusal(parse({ empiricalUnknowns: [7] }))).toEqual({
      error: "'empiricalUnknowns[0]' must be { question, smallest_test, kill_result }, or the question as a string",
      field: 'empiricalUnknowns[0]',
    })
    expect(refusal(parse({ empiricalUnknowns: 'one question' }))).toEqual({
      error: "'empiricalUnknowns' must be a list of at most two, each { question, smallest_test, kill_result } or a question",
      field: 'empiricalUnknowns',
    })
  })

  test('through run.start, args.empiricalUnknowns are the objects', async () => {
    const w = await world()
    const r = okReply(await startDesign(w, { empiricalUnknowns: ['Is the timeout per attempt?'] }))
    expect(r.args.empiricalUnknowns).toEqual([{ id: 'U1', question: 'Is the timeout per attempt?', smallest_test: '', kill_result: '' }])
  })
})

describe('args.template (decision 13)', () => {
  test("is the deliverable's template, through designArgs' deps", async () => {
    const w = await world()
    const asked: string[] = []
    launchDeps.template = d => {
      asked.push(d)
      return `the ${d} sections`
    }
    const r = okReply(await startDesign(w, { deliverable: 'research' }))
    expect(r.args.template).toBe('the research sections')
    expect(asked).toEqual(['research'])
  })

  test("unstood-in, it's TEMPLATES[deliverable]", async () => {
    for (const deliverable of ['plan', 'audit'] as const) {
      const r = okReply(await startDesign(await world(), { deliverable }))
      expect(r.args.template).toBe(TEMPLATES[deliverable])
    }
  })
})

// ---------------------------------------------------------------------------
// A follow-up run's prior (decision 12)

const PRIOR = '20261003-design-a1b2c3'
const CRITIC = { source: 'agent' as const, agentId: 'critic-1', agentType: 'litter:design-critic' }
const AUTHOR = { source: 'agent' as const, agentId: 'author-1', agentType: 'litter:author' }
const LAUNCHER = { source: 'launcher' as const }

type Rec = [kind: string, body: Record<string, unknown>]

/** A run folder as the mod leaves one: run.json, its ledger, and each proposal's file. */
async function pastRun(w: LaunchWorld, run: string, workflow: Workflow, proposals: Record<string, string>, records: Rec[]): Promise<string> {
  const dir = runDir(w.litterDir, run)
  await w.p.fs.write(runJsonPath(dir), `${JSON.stringify({ v: 1, run, workflow, args: {} })}\n`)
  for (const [version, text] of Object.entries(proposals)) await w.p.fs.write(proposalPath(dir, version), text)
  for (const [kind, body] of records) {
    const by = kind === 'proposal' ? AUTHOR : kind === 'verdict' ? CRITIC : LAUNCHER
    const extra = kind === 'proposal' ? { sha256: await sha256(proposals[body.version as string] ?? '') } : {}
    await appendRecord(w.p, dir, { run, kind, by, body: { ...body, ...extra } })
  }
  return dir
}

const criteria = (verdict: 'PASS' | 'FAIL'): DesignCriterion[] => [
  { id: 'C1', verdict, evidence: 'src/retry.ts:12', ...(verdict === 'FAIL' ? { gap_or_reason: 'no test', gap_kind: 'investigation' as const } : {}) },
  { id: 'B1', verdict: 'PASS', evidence: 'grep' },
]

describe('args.prior (decision 12)', () => {
  test("holds the prior's latest version, its text, its verdict on that version, and both runs' feedback", async () => {
    const w = await world()
    await pastRun(w, PRIOR, 'design', { v1: '# Retry\n\nfirst\n', v2: '# Retry\n\nsecond, with `src/retry.ts`\n' }, [
      ['proposal', { text: 'first', version: 'v1' }],
      ['verdict', { version: 'v1', criteria: criteria('FAIL'), overall: 'HOLDING', sha256: null }],
      ['design.feedback', { feedback: 'the first one ignored the timeout' }],
      ['proposal', { text: 'second', version: 'v2' }],
      ['verdict', { version: 'v2', criteria: criteria('PASS'), overall: 'HOLDING', sha256: null }],
      ['design.feedback', { feedback: 'closer; keep the backoff' }],
    ])
    const r = okReply(await startDesign(w, { priorRun: PRIOR, feedback: 'and log each retry' }))
    expect(r.args.prior).toEqual({
      run: PRIOR,
      version: 'v2',
      proposal: '# Retry\n\nsecond, with `src/retry.ts`\n',
      verdict: { criteria: criteria('PASS'), overall: 'HOLDING' },
      feedback: ['the first one ignored the timeout', 'closer; keep the backoff', 'and log each retry'],
    } satisfies DesignPrior)
    expect(r.args).toEqual(expect.objectContaining({ priorRun: PRIOR, feedback: 'and log each retry' }))
  })

  test('a latest version with no verdict yet has none; a prior with no proposal has neither; no priorRun is no prior', async () => {
    const w = await world()
    await pastRun(w, PRIOR, 'design', { v1: 'one', v2: 'two' }, [
      ['proposal', { text: 'one', version: 'v1' }],
      ['verdict', { version: 'v1', criteria: criteria('PASS'), overall: 'APPROVED', sha256: null }],
      ['proposal', { text: 'two', version: 'v2' }],
    ])
    const r = okReply(await startDesign(w, { priorRun: PRIOR }))
    expect(r.args.prior).toEqual({ run: PRIOR, version: 'v2', proposal: 'two', verdict: null, feedback: [] })

    const w2 = await world()
    await pastRun(w2, PRIOR, 'design', {}, [['design.feedback', { feedback: 'start over' }]])
    const r2 = okReply(await startDesign(w2, { priorRun: PRIOR }))
    expect(r2.args.prior).toEqual({ run: PRIOR, version: null, proposal: null, verdict: null, feedback: ['start over'] })

    const fresh = await world()
    const r3 = okReply(await startDesign(fresh, { feedback: 'a note without a prior' }))
    expect(r3.args.prior).toBeNull()
    expect(r3.args.feedback).toBe('a note without a prior')
  })

  test('a long proposal is cut at 64 KiB between characters, with a note saying how much more and where', async () => {
    const w = await world()
    const long = `# Plan\n\n${'é'.repeat(40_000)}${'x'.repeat(30_000)}\n`
    const dir = await pastRun(w, PRIOR, 'design', { v1: long }, [['proposal', { text: 'the prose', version: 'v1' }]])
    const r = okReply(await startDesign(w, { priorRun: PRIOR }))
    const text = (r.args.prior as DesignPrior).proposal!
    const enc = new TextEncoder()
    const path = proposalPath(dir, 'v1')
    const m = /\n\[cut: ([0-9]+) more bytes in (.+)\]$/.exec(text)
    expect(m?.[2]).toBe(path)
    const kept = text.slice(0, m!.index)
    expect(long.startsWith(kept)).toBe(true)
    expect(enc.encode(kept).length + Number(m![1])).toBe(enc.encode(long).length)
    expect(enc.encode(text).length).toBeLessThanOrEqual(PRIOR_CAP)
    expect(enc.encode(text).length).toBeGreaterThan(PRIOR_CAP - 8)
  })

  test('a proposal file changed after its record gives the prose the record holds, saying so', async () => {
    const w = await world()
    const dir = await pastRun(w, PRIOR, 'design', { v1: 'the plan as recorded\n' }, [['proposal', { text: 'the prose as recorded', version: 'v1' }]])
    writeFileSync(proposalPath(dir, 'v1'), 'edited by hand\n')
    const r = okReply(await startDesign(w, { priorRun: PRIOR }))
    expect((r.args.prior as DesignPrior).proposal).toBe(
      `[litter: ${proposalPath(dir, 'v1')} is missing or changed since v1 was recorded; this is the prose its proposal record holds, without the gates]\n\nthe prose as recorded`,
    )
  })

  test('a tampered prior ledger gives the records before the tamper point', async () => {
    const w = await world()
    const dir = await pastRun(w, PRIOR, 'design', { v1: 'one', v2: 'two' }, [
      ['proposal', { text: 'one', version: 'v1' }],
      ['design.feedback', { feedback: 'kept' }],
      ['verdict', { version: 'v1', criteria: criteria('FAIL'), overall: 'HOLDING', sha256: null }],
      ['proposal', { text: 'two', version: 'v2' }],
      ['design.feedback', { feedback: 'past the tamper point' }],
    ])
    // A record before the last that doesn't parse: the chain is broken there (ledgercore's readLedger).
    writeFileSync(`${ledgerDir(dir)}/000004-proposal.json`, '{ "seq": 4, "kind": "proposal", "body": { "version": "v9"\n')
    const r = okReply(await startDesign(w, { priorRun: PRIOR }))
    expect(r.args.prior).toEqual({ run: PRIOR, version: 'v1', proposal: 'one', verdict: { criteria: criteria('FAIL'), overall: 'HOLDING' }, feedback: ['kept'] })
    expect(w.p.logs.some(l => l.includes(`design prior ${PRIOR}: its ledger is tampered at seq 4`))).toBe(true)
  })

  test('a priorRun naming an execute run, or no run here, refuses naming priorRun, writing nothing', async () => {
    const w = await world()
    const exec = '20261003-execute-b2c3d4'
    await pastRun(w, exec, 'execute', {}, [])
    expect(refusal(await startDesign(w, { priorRun: exec }))).toEqual({
      error: `litter: 'priorRun' ${exec} is a run of the execute workflow; a follow-up starts from a design run`,
      field: 'priorRun',
    })
    expect(refusal(await startDesign(w, { priorRun: PRIOR }))).toEqual({
      error: `litter: 'priorRun' ${PRIOR} isn't a run in this litter directory (${w.litterDir}); pass the id of the design run this one follows`,
      field: 'priorRun',
    })
    expect(refusal(await startDesign(w, { priorRun: '../elsewhere' }))).toEqual({ error: "'priorRun' must be a run id", field: 'priorRun' })
    await nothingWritten(w, [exec])
  })
})

describe('the base snapshot (plan 12:1763)', () => {
  test('a design started with an uncommitted edit and a new file has a base holding both; HEAD and the index stay', async () => {
    const w = await world()
    writeFileSync(join(w.repo, 'README.md'), 'work in progress\n')
    writeFileSync(join(w.repo, 'notes.txt'), 'untracked\n')
    const head = (await w.git('rev-parse', 'HEAD')).trim()
    const r = okReply(await startDesign(w))
    const base = (await w.git('rev-parse', `refs/litter/${r.run}/base`)).trim()
    expect(r.args.base).toBe(base)
    expect(await w.git('show', `${base}:README.md`)).toBe('work in progress\n')
    expect(await w.git('show', `${base}:notes.txt`)).toBe('untracked\n')
    expect((await w.git('ls-tree', '-r', '--name-only', base)).split('\n').filter(f => f.startsWith('.claude/'))).toEqual([])
    expect((await w.git('rev-parse', `${base}^`)).trim()).toBe(head)
    expect((await w.git('rev-parse', 'HEAD')).trim()).toBe(head)
    expect((await w.git('status', '--porcelain', '--', 'README.md', 'notes.txt')).split('\n').filter(Boolean).sort()).toEqual([' M README.md', '?? notes.txt'])
  })
})
