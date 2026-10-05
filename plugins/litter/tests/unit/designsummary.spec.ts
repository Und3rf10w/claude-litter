// Tier 2: hooks/design/summary.ts, summary.md's design part (plan section 9,
// "Run lifecycle"; COMMON decision 14), from records written through
// appendRecord and files in a scratch dir: each stop shape's line; the
// delivery; the verdict card with every bar id and record text kept in its
// cell; the versions; and the reframes, probes, default-off unknowns,
// decisions and rule items, each there when its records are and left out
// when they aren't, in the order the design skill reads them.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Author } from '../../hooks/records/core'
import type { RunEndBody } from '../../hooks/records/run'
import type { RunRef } from '../../hooks/lifecycle'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { designVerdictPath, planPath, probePath, proposalPath, runDir } from '../../hooks/layout'
import { sha256 } from '../../hooks/fsx'
import { designSummary } from '../../hooks/design/summary'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const RUN = '20261004-design-cd34ef'
const MOD: Author = { source: 'mod' }
const AUTHOR: Author = { source: 'agent', agentId: 'au', agentType: 'litter:author' }
const CRITIC: Author = { source: 'agent', agentId: 'dc', agentType: 'litter:design-critic' }

const BAR = [
  { id: 'C1', text: 'retries once', evidence: 'a test' },
  { id: 'C2', text: 'keeps the timeout', evidence: 'the config' },
  { id: 'C3', text: 'logs each retry', evidence: 'a log line' },
  { id: 'C4', text: 'needs no new dependency', evidence: 'package.json' },
  { id: 'C5', text: 'documents the retry', evidence: 'the README' },
  { id: 'B1', text: 'no sleep in tests', evidence: 'grep', reason: 'flaky' },
]
const RULE_ITEMS = [
  { id: 'B2', text: 'Never force-push', evidence: 'git log', reason: 'history is shared', rule: { id: 'no-force-push', version: 2 } },
  { id: 'C6', text: 'consistent with rules header-parser, no-deps', evidence: 'the rules', rules: [{ id: 'header-parser', version: 3 }, { id: 'no-deps', version: 1 }] },
]
const ALL_PASS = BAR.map(b => ({ id: b.id, verdict: 'PASS', evidence: `${b.id} holds` }))

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

type Args = { deliverable?: string; bar?: unknown[]; empiricalUnknowns?: unknown[] }

async function world(args: Args = {}, launched = true) {
  const p: TestPorts = nodePorts()
  const s = scratch()
  cleanups.push(s.cleanup)
  const ref: RunRef = { run: RUN, runDir: runDir(s.dir, RUN), litterDir: s.dir }
  const json = { v: 1, run: RUN, workflow: 'design', args: { deliverable: 'plan', bar: BAR, empiricalUnknowns: [], ...args }, rules: [] } as never
  const add = (kind: string, body: unknown, by: Author = MOD) => appendRecord(p, ref.runDir, { run: RUN, kind, by, body: body as Record<string, unknown> })
  await add('run.start', { workflow: 'design' }, { source: 'launcher' })
  if (launched) await add('run.launch', { taskId: 't1', runId: 'wf_1', scriptPath: null, generation: 1, session: 's', oid: 'o' })
  let n = 0
  let results = 0
  const shas = new Map<string, string>()
  return {
    p,
    ref,
    add,
    propose: async (text: string) => {
      const version = `v${++n}`
      const sha = await sha256(text)
      shas.set(version, sha)
      await p.fs.write(proposalPath(ref.runDir, version), text)
      await add('proposal', { text, version, sha256: sha }, AUTHOR)
      return { version, sha }
    },
    verdict: (version: string, o: { overall?: string; criteria?: unknown[]; source_changed?: boolean } = {}) =>
      add('verdict', { version, criteria: o.criteria ?? ALL_PASS, overall: o.overall ?? 'APPROVED', sha256: shas.get(version) ?? null, ...(o.source_changed !== undefined ? { source_changed: o.source_changed } : {}) }, CRITIC),
    result: (role: 'author' | 'reframer', result: Record<string, unknown>) =>
      add('design.result', { role, tool_use_id: `tu-${role}-${++results}`, result }, { source: 'agent', agentId: role, agentType: `litter:${role}` }),
    end: (body: Partial<RunEndBody>) => add('run.end', { taskId: 't1', generation: 1, status: 'done', reason: null, source: 'notification', ...body }),
    lines: async () => designSummary(p, ref, json, (await readLedger(p, ref.runDir, RUN)).records),
  }
}

/** A section's lines after its heading and blank line, up to the next section. */
const section = (lines: string[], name: string): string[] | null => {
  const at = lines.indexOf(`## ${name}`)
  if (at < 0) return null
  const next = lines.findIndex((l, i) => i > at && l.startsWith('## '))
  const body = lines.slice(at + 2, next < 0 ? lines.length : next)
  while (body.at(-1) === '') body.pop()
  return body
}
const headings = (lines: string[]) => lines.filter(l => l.startsWith('## '))

describe('Stop', () => {
  type Case = { name: string; end: Partial<RunEndBody>; line: string }
  const CASES: Case[] = [
    { name: 'approved', end: { payload: { outcome: 'approved', by: 'approved', version: 'v2' } }, line: 'Approved: the critic approved (approved), at v2' },
    { name: 'no new material', end: { payload: { outcome: 'holding', by: 'no-new-material', version: 'v2' } }, line: 'Holding: a round added nothing new (no-new-material), at v2' },
    { name: 'max rounds', end: { payload: { outcome: 'holding', by: 'max-rounds', version: 'v2' } }, line: 'Holding: max rounds reached (max-rounds), at v2' },
    { name: 'the budget', end: { payload: { outcome: 'holding', by: 'budget', version: 'v2' } }, line: 'Holding: the token budget ran out (budget), at v2' },
    {
      name: 'a goal change',
      end: {
        status: 'needs_user',
        reason: 'goal-change',
        payload: { stopped: 'goal-change', reframe: { recommendation: 'R2', changes_goal: true, candidates: [{ id: 'R1', alternative: 'keep it' }, { id: 'R2', alternative: 'drop the retry, cache the token' }] } },
      },
      line: 'Needs you: a reframe that changes the goal (goal-change); the reframer recommends R2: drop the retry, cache the token',
    },
    {
      name: 'a blocking decision',
      end: { status: 'needs_user', reason: 'blocking-decision', payload: { stopped: 'blocking-decision', decision: { question: 'Which header format\nis current?', blocking: true } } },
      line: 'Needs you: a blocking decision (blocking-decision): Which header format is current?',
    },
    {
      name: 'a user gap',
      end: { status: 'needs_user', reason: 'user-gap', payload: { stopped: 'user-gap', criteria: [{ id: 'C3', verdict: 'FAIL', gap_kind: 'user' }, { id: 'B1', verdict: 'CONDITIONAL', gap_kind: 'user' }] } },
      line: 'Needs you: a gap only you can close (user-gap): C3, B1',
    },
    {
      name: 'the checkout changed',
      end: { status: 'halted', reason: 'source-changed', payload: { version: 'v2' } },
      line: "Halted: the checkout changed during a round (source-changed), while v2 was judged. That round's evidence may mix old and new code.",
    },
    { name: 'halted', end: { status: 'halted', reason: 'the author returned nothing twice, in round 2' }, line: 'Halted: the author returned nothing twice, in round 2' },
    { name: 'interrupted', end: { status: 'interrupted', reason: "agent type 'litter:author' not found" }, line: "Interrupted: agent type 'litter:author' not found" },
    { name: 'failed', end: { status: 'failed', reason: 'unrecognized result' }, line: 'Failed: unrecognized result' },
    { name: 'stopped', end: { status: 'stopped', reason: 'stopped' }, line: 'Stopped before it finished, at v2' },
  ]
  for (const c of CASES) {
    test(c.name, async () => {
      const w = await world()
      await w.propose('# v1\n')
      await w.propose('# v2\n')
      await w.verdict('v2')
      await w.end(c.end)
      expect(section(await w.lines(), 'Stop')).toEqual([c.line])
    })
  }

  test('a launch that failed says so, with no version', async () => {
    const w = await world({}, false)
    await w.add('run.end', { taskId: null, generation: 0, status: 'launch_failed', reason: 'the Workflow call failed: no such workflow', source: 'mod' })
    await w.add('design.deliver', { version: null, refused: 'the run never launched' })
    const lines = await w.lines()
    expect(section(lines, 'Stop')).toEqual(['The launch failed (launch_failed): the Workflow call failed: no such workflow'])
    expect(section(lines, 'Delivery')).toEqual(['Not delivered: the run never launched'])
    expect(headings(lines)).toEqual(['## Stop', '## Delivery'])
  })

  test("for a deliverable that isn't a plan, an approval the ledger doesn't show is named", async () => {
    const w = await world({ deliverable: 'research' })
    await w.propose('# Findings\n')
    await w.verdict('v1', { overall: 'HOLDING', criteria: ALL_PASS.map(c => (c.id === 'C2' ? { ...c, verdict: 'FAIL', gap_kind: 'investigation' } : c)) })
    await w.end({ payload: { outcome: 'approved', by: 'approved', version: 'v1' } })
    expect(section(await w.lines(), 'Stop')).toEqual([
      'Approved: the critic approved (approved), at v1',
      '',
      "The ledger doesn't show that approval: the latest verdict isn't APPROVED: v1 is HOLDING. The verdict card below is the ledger's.",
    ])
  })

  test('a run with no end yet has no Stop and no Delivery', async () => {
    const w = await world()
    await w.propose('# v1\n')
    const lines = await w.lines()
    expect(section(lines, 'Stop')).toBeNull()
    expect(section(lines, 'Delivery')).toBeNull()
  })
})

describe('Delivery', () => {
  test('delivered: the version, the path and the hash', async () => {
    const w = await world()
    const { sha } = await w.propose('# plan\n')
    await w.verdict('v1')
    await w.end({ payload: { outcome: 'approved', by: 'approved', version: 'v1' } })
    await w.add('design.deliver', { version: 'v1', sha256: sha, path: planPath(w.ref.runDir) })
    expect(section(await w.lines(), 'Delivery')).toEqual([`Delivered: v1 as ${planPath(w.ref.runDir)}, sha256 ${sha}, the approved bytes unchanged`])
  })

  test('refused: the reason', async () => {
    const w = await world()
    await w.propose('# plan\n')
    await w.end({ payload: { outcome: 'holding', by: 'max-rounds', version: 'v1' } })
    await w.add('design.deliver', { version: 'v1', refused: 'holding (max-rounds)' })
    expect(section(await w.lines(), 'Delivery')).toEqual(['Not delivered: holding (max-rounds)'])
  })

  test("a plan with no delivery recorded for this end says it didn't finish; an earlier end's doesn't count", async () => {
    const w = await world()
    await w.add('design.deliver', { version: null, refused: 'an earlier end' })
    await w.end({ payload: { outcome: 'approved', by: 'approved', version: null } })
    expect(section(await w.lines(), 'Delivery')).toEqual([
      "Not delivered: the delivery didn't finish, so no outcome was recorded; litter's debug log (claude --debug) says why",
    ])
  })

  test('the other deliverables have none', async () => {
    for (const deliverable of ['research', 'audit', 'review']) {
      const w = await world({ deliverable })
      await w.end({ payload: { outcome: 'holding', by: 'max-rounds', version: null } })
      expect(section(await w.lines(), 'Delivery')).toBeNull()
    }
  })
})

describe('the verdict card', () => {
  test("the last verdict: its version, a row per bar item in the bar's order, and the overall; record text stays in its cell", async () => {
    const w = await world()
    await w.propose('# v1\n')
    await w.verdict('v1', { overall: 'HOLDING', criteria: ALL_PASS.map(c => ({ ...c, verdict: 'FAIL', gap_kind: 'design' })) })
    await w.propose('# v2\n')
    const criteria = [
      { id: 'B1', verdict: 'PASS', evidence: 'grep finds no sleep' },
      { id: 'C3', verdict: 'CONDITIONAL', gap_or_reason: 'logs | but at debug\nlevel only', evidence: 'src/a.ts:3 | src/b.ts:9\r\nsee both', gap_kind: 'wording' },
      ...ALL_PASS.filter(c => c.id !== 'B1' && c.id !== 'C3'),
    ]
    await w.verdict('v2', { overall: 'HOLDING', criteria })
    await w.p.fs.write(designVerdictPath(w.ref.runDir, 'v2'), '# v2\n')
    await w.end({ payload: { outcome: 'holding', by: 'max-rounds', version: 'v2' } })
    expect(section(await w.lines(), 'Verdict card')).toEqual([
      `Version: v2 (${designVerdictPath(w.ref.runDir, 'v2')})`,
      '',
      '| Item | Verdict | Gap or reason | Evidence | Gap kind |',
      '|---|---|---|---|---|',
      '| C1 | PASS |  | C1 holds |  |',
      '| C2 | PASS |  | C2 holds |  |',
      '| C3 | CONDITIONAL | logs \\| but at debug<br>level only | src/a.ts:3 \\| src/b.ts:9<br>see both | wording |',
      '| C4 | PASS |  | C4 holds |  |',
      '| C5 | PASS |  | C5 holds |  |',
      '| B1 | PASS |  | grep finds no sleep |  |',
      '',
      'Overall: HOLDING',
    ])
  })

  test("every bar id has a row, one the verdict doesn't judge included; the checkout's change is named", async () => {
    const w = await world({ bar: [...BAR, ...RULE_ITEMS] })
    await w.propose('# v1\n')
    await w.verdict('v1', { overall: 'HOLDING', criteria: ALL_PASS, source_changed: true })
    const card = section(await w.lines(), 'Verdict card')!
    expect(card[0]).toBe('Version: v1')
    const rows = card.filter(l => /^\| [CB][0-9]+ \|/.test(l))
    expect(rows.map(l => l.split(' | ')[0]!.slice(2))).toEqual([...BAR, ...RULE_ITEMS].map(b => b.id))
    expect(rows.filter(l => l.includes('| not judged |')).map(l => l.slice(2, 4))).toEqual(['B2', 'C6'])
    expect(card.at(-1)).toBe('The checkout changed while v1 was judged (source_changed), so its evidence may mix old and new code.')
  })

  test('no verdict, no card', async () => {
    const w = await world()
    await w.propose('# v1\n')
    expect(section(await w.lines(), 'Verdict card')).toBeNull()
  })
})

describe('Versions', () => {
  test("each version's file and sha256, its latest verdict's overall, and source_changed where true", async () => {
    const w = await world()
    const v1 = await w.propose('# v1\n')
    await w.verdict('v1', { overall: 'HOLDING', criteria: ALL_PASS.map(c => (c.id === 'C1' ? { ...c, verdict: 'FAIL', gap_kind: 'design' } : c)) })
    const v2 = await w.propose('# v2\n')
    await w.verdict('v2', { source_changed: true })
    const v3 = await w.propose('# v3\n')
    expect(section(await w.lines(), 'Versions')).toEqual([
      `- v1: ${proposalPath(w.ref.runDir, 'v1')}, sha256 ${v1.sha}; HOLDING`,
      `- v2: ${proposalPath(w.ref.runDir, 'v2')}, sha256 ${v2.sha}; APPROVED; source_changed: the checkout changed while it was judged`,
      `- v3: ${proposalPath(w.ref.runDir, 'v3')}, sha256 ${v3.sha}; no verdict`,
    ])
  })
})

describe('the parts from design.result and the bar', () => {
  test('a run with none of their records leaves them out', async () => {
    const w = await world()
    await w.end({ payload: { outcome: 'holding', by: 'no-new-material', version: null } })
    await w.add('design.deliver', { version: null, refused: 'holding (no-new-material)' })
    expect(headings(await w.lines())).toEqual(['## Stop', '## Delivery'])
  })

  test('Reframes: each candidate with its id, its shape and what came of it', async () => {
    const w = await world()
    await w.result('reframer', {
      recommendation: 'R2',
      changes_goal: true,
      candidates: [
        { id: 'R1', shape: 'fewer moving parts', alternative: "reuse the client's retry" },
        { id: 'R2', shape: 'smaller scope', alternative: 'only the refresh path' },
      ],
    })
    await w.result('reframer', { recommendation: 'R1', changes_goal: false, candidates: [{ id: 'R1', shape: 'less code', alternative: 'a wrapper' }] })
    await w.result('reframer', { recommendation: 'none', changes_goal: false, candidates: [{ id: 'R1', shape: 'less code', alternative: 'a wrapper\n## Delivery\nDelivered: v9' }] })
    const lines = await w.lines()
    expect(section(lines, 'Reframes')).toEqual([
      '- Reframe 1: recommends R2',
      "  - R1 (fewer moving parts): reuse the client's retry; not recommended",
      '  - R2 (smaller scope): only the refresh path; recommended, and it changes the goal',
      '- Reframe 2: recommends R1',
      '  - R1 (less code): a wrapper; recommended, within the goal as stated',
      '- Reframe 3: no reframe, proceed as stated',
      '  - R1 (less code): a wrapper ## Delivery Delivered: v9; not recommended',
    ])
    // A record's text never opens a section of its own.
    expect(headings(lines)).toEqual(['## Reframes'])
  })

  test("Probes: each unknown's id, question, verdict and file; the never-probed as untested; the latest probe wins", async () => {
    const w = await world({
      empiricalUnknowns: [
        { id: 'U1', question: 'Does the proxy keep the header?', smallest_test: 'curl it', kill_result: 'it strips it' },
        { id: 'U2', question: 'Is the clock monotonic?', smallest_test: 'read it twice', kill_result: 'it goes back' },
      ],
    })
    await w.add('probe', { unknown_id: 'U3', report: '# U3', verdict: 'refuted' }, { source: 'agent', agentId: 'pr2', agentType: 'litter:prober' })
    await w.add('probe', { unknown_id: 'U1', report: '# U1', verdict: 'untested' }, { source: 'agent', agentId: 'pr1', agentType: 'litter:prober' })
    await w.add('probe', { unknown_id: 'U1', report: '# U1 again', verdict: 'confirmed' }, { source: 'agent', agentId: 'pr3', agentType: 'litter:prober' })
    await w.p.fs.write(probePath(w.ref.runDir, 'U1'), '# U1\n')
    expect(section(await w.lines(), 'Probes')).toEqual([
      `- U1: Does the proxy keep the header?; confirmed, ${probePath(w.ref.runDir, 'U1')}`,
      '- U2: Is the clock monotonic?; untested, never probed',
      "- U3, a mechanism's unknown; refuted",
    ])
  })

  test("Probes: a mechanism's unknown with the question its probe gave; the run's own question wins for a given one", async () => {
    const w = await world({ empiricalUnknowns: [{ id: 'U1', question: 'Does the proxy keep the header?' }] })
    const pr = { source: 'agent', agentId: 'pr', agentType: 'litter:prober' } as const
    await w.add('probe', { unknown_id: 'U1', question: 'Something else?', report: '# U1', verdict: 'confirmed' }, pr)
    await w.add('probe', { unknown_id: 'U3', question: 'Does ash pad\n by bytes?', report: '# U3', verdict: 'refuted' }, pr)
    await w.add('probe', { unknown_id: 'U4', question: '  ', report: '# U4', verdict: 'untested' }, pr)
    expect(section(await w.lines(), 'Probes')).toEqual([
      '- U1: Does the proxy keep the header?; confirmed',
      "- U3, a mechanism's unknown: Does ash pad by bytes?; refuted",
      "- U4, a mechanism's unknown; untested",
    ])
  })

  test("Probes: before WP-BD, a bare string is its unknown's question, numbered in the order given", async () => {
    const w = await world({ empiricalUnknowns: ['Does the proxy keep the header?', 'Is the clock monotonic?'] })
    expect(section(await w.lines(), 'Probes')).toEqual([
      '- U1: Does the proxy keep the header?; untested, never probed',
      '- U2: Is the clock monotonic?; untested, never probed',
    ])
  })

  test("Ships default-off and User decisions: the latest author result's", async () => {
    const w = await world()
    await w.result('author', {
      version: 'v1',
      residual_unknowns: [{ id: 'R9', description: 'old', why_open: 'x', how_to_resolve: 'y', default_off: true }],
      user_decisions: [{ question: 'Old question?', options: [], recommended: 'a', blocking: false }],
    })
    await w.result('author', {
      version: 'v2',
      residual_unknowns: [
        { id: 'R1', description: 'the proxy may strip the header', why_open: 'no proxy in the test env', how_to_resolve: 'run the smoke test behind it', default_off: true },
        { id: 'R2', description: 'a slower path', why_open: 'not measured', how_to_resolve: 'benchmark it', default_off: false },
      ],
      user_decisions: [
        { question: 'Which header format is current?', options: [{ label: 'v1', tradeoff: 'drops old clients' }, { label: 'v2', tradeoff: 'needs a migration' }], recommended: 'v2', blocking: true },
        { question: 'Log at info or debug?', options: [], recommended: 'debug', blocking: false },
      ],
    })
    const lines = await w.lines()
    expect(section(lines, 'Ships default-off')).toEqual([
      '- R1: the proxy may strip the header',
      "  - Why it's open: no proxy in the test env",
      '  - How to resolve it: run the smoke test behind it',
    ])
    expect(section(lines, 'User decisions')).toEqual([
      '- Which header format is current? (blocking; recommended: v2)',
      '  - v1: drops old clients',
      '  - v2: needs a migration',
      '- Log at info or debug? (not blocking; recommended: debug)',
    ])
  })

  test('an author result with nothing default-off and no decisions leaves both out', async () => {
    const w = await world()
    await w.result('author', { version: 'v1', residual_unknowns: [{ id: 'R1', description: 'd', why_open: 'w', how_to_resolve: 'h', default_off: false }], user_decisions: [] })
    const lines = await w.lines()
    expect(section(lines, 'Ships default-off')).toBeNull()
    expect(section(lines, 'User decisions')).toBeNull()
  })

  test("Rules: the bar's rule items as id@v; a bar of your items only has none", async () => {
    const w = await world({ bar: [...BAR, ...RULE_ITEMS] })
    expect(section(await w.lines(), 'Rules')).toEqual(['- B2: no-force-push@2', '- C6: header-parser@3, no-deps@1'])
    const mine = await world()
    expect(section(await mine.lines(), 'Rules')).toBeNull()
  })
})

describe('every section', () => {
  test('in the order the skill reads them', async () => {
    const w = await world({ bar: [...BAR, ...RULE_ITEMS], empiricalUnknowns: [{ id: 'U1', question: 'q', smallest_test: 't', kill_result: 'k' }] })
    const { sha } = await w.propose('# plan\n')
    await w.result('reframer', { recommendation: 'none', changes_goal: false, candidates: [] })
    await w.result('author', {
      version: 'v1',
      residual_unknowns: [{ id: 'R1', description: 'd', why_open: 'w', how_to_resolve: 'h', default_off: true }],
      user_decisions: [{ question: 'q?', options: [], recommended: 'a', blocking: false }],
    })
    await w.verdict('v1', { criteria: [...ALL_PASS, ...RULE_ITEMS.map(b => ({ id: b.id, verdict: 'PASS', evidence: 'ok' }))] })
    await w.end({ payload: { outcome: 'approved', by: 'approved', version: 'v1' } })
    await w.add('design.deliver', { version: 'v1', sha256: sha, path: planPath(w.ref.runDir) })
    expect(headings(await w.lines())).toEqual([
      '## Stop',
      '## Delivery',
      '## Verdict card',
      '## Versions',
      '## Reframes',
      '## Probes',
      '## Ships default-off',
      '## User decisions',
      '## Rules',
    ])
  })
})
