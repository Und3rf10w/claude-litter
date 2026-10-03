// Tier 2: the rules' record kinds through the record tool (WP-AD, plan
// 16.9): rule.propose with and without a run, from text and from a file,
// and the duplicate of an accepted rule; rule.find in all four forms, which
// writes nothing; rule.open and rule.import, with AF's openRulesPane and
// AE's findApplicable and matches faked through records.ts's deps.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Policy } from '../../hooks/hookfiles'
import type { RecordError, RecordReply } from '../../hooks/records/core'
import type { RuleOpenBody } from '../../hooks/records/rules'
import { dispatchRecord } from '../../hooks/ledger'
import { runDir, runJsonPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { consumeAgents, writePolicy } from '../../hooks/policy'
import { parseRule } from '../../hooks/rules/format'
import { readRuleLedger } from '../../hooks/rules/ledger'
import { deps as recordsDeps } from '../../hooks/rules/records'
import { acceptRule, dismissRule, retireRule } from '../../hooks/rules/store'
import { fakePatterns, ruleDoc, rulesWorld, writeRuleFile, type RulesWorld } from './rules-harness'

const RUN = '20261003-rules'

let w: RulesWorld
let restore: () => void
let opened: RuleOpenBody[]
let paneAnswer: () => Promise<boolean>
const realDeps = { ...recordsDeps }

beforeEach(async () => {
  restore = fakePatterns()
  w = await rulesWorld()
  opened = []
  paneAnswer = async () => true
  recordsDeps.openRulesPane = async (_p, focus) => {
    opened.push(focus as RuleOpenBody)
    return paneAnswer()
  }
  // AE's matcher, as far as these tests need it: a trailing /** matches under its folder, anything else exactly.
  recordsDeps.matches = (pattern, path) => (pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : pattern === path)
})
afterEach(() => {
  Object.assign(recordsDeps, realDeps)
  restore()
  w.cleanup()
})

const env = () => ({ litterDir: w.litterDir, litterDirError: null, ready: true, options: normalizeOptions(undefined) })
const call = (fields: Record<string, unknown>, agentId?: string) => dispatchRecord(w.p, agentId, { tool: 'mcp__litter__record', tool_use_id: 'tu1', ...fields }, env())
const asOk = (r: RecordReply) => {
  if (!r.ok) throw new Error(`refused: ${r.error}`)
  return r as Record<string, unknown>
}
const asError = (r: RecordReply): RecordError => {
  if (r.ok) throw new Error(`accepted: ${JSON.stringify(r)}`)
  return r
}
const repoRecords = async () => (await readRuleLedger(w.p, w.litterDir, 'repo')).records

function policyFor(run: string): Policy {
  return {
    v: 1,
    session: 'test-session',
    litterDir: w.litterDir,
    run: {
      run,
      workflow: 'execute',
      runDir: runDir(w.litterDir, run),
      checkout: w.repo,
      base: '0'.repeat(40),
      runIds: [],
      launching: false,
      stopping: false,
      inflight: null,
      isolationLost: false,
      roots: { checkout: w.repo, litterDir: w.litterDir, litterCopies: [w.litterDir], ruleDirs: [], worktrees: [] },
      setup: null,
      linkDirs: [],
    },
    roles: {},
    swarm: null,
  }
}

/** A run folder whose run.json lists the rule versions it used. */
const runUsing = (run: string, rules: { id: string; version: number }[]) =>
  w.p.fs.write(runJsonPath(runDir(w.litterDir, run)), `${JSON.stringify({ v: 1, run, workflow: 'execute', args: {}, ref: `litter/${run}`, rules })}\n`)

/** Every file under the scratch root, with its bytes and mtime. */
function snapshotFiles(dir: string, out = new Map<string, string>()): Map<string, string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name)
    if (e.isDirectory()) snapshotFiles(path, out)
    else if (e.isFile()) out.set(path, `${statSync(path).mtimeMs}:${readFileSync(path, 'utf8')}`)
  }
  return out
}

const DRAFT = ['---', 'type: ban', 'applies:', '  paths: [db/migrations/**]', '  when: changing a migration', '---', '', '## Rule', 'Never edit a migration that has shipped.', '', '## Why', 'Deployed databases already ran it.', ''].join('\n')

describe('rule.propose', () => {
  test('from the main thread, without a run: in the rules ledger, as the user\'s, with its proposal ref', async () => {
    const r = asOk(await call({ kind: 'rule.propose', rule: 'Keep each test beside the code it covers.' }))
    expect(r).toEqual({ ok: true, kind: 'rule.propose', seq: 1, proposal: { store: 'repo', seq: 1 }, status: 'proposed' })
    const [rec] = await repoRecords()
    expect([rec!.kind, rec!.run, rec!.by, rec!.body]).toEqual(['rule.propose', 'rules', { source: 'launcher' }, { rule: 'Keep each test beside the code it covers.', source: 'user' }])
  })

  test('with a run, from a whole rule file, with every optional field', async () => {
    await runUsing(RUN, [])
    const r = asOk(
      await call({ kind: 'rule.propose', run: RUN, rule: DRAFT, source: 'user', scope: 'project', type: 'ban', paths: ['db/**', 'db/**'], when: 'any schema work', slug: 'no-shipped-migration-edits' }),
    )
    expect(r).toEqual(expect.objectContaining({ ok: true, run: RUN, proposal: { store: 'repo', seq: 1 } }))
    const body = (await repoRecords())[0]!.body
    expect(body).toEqual({
      rule: DRAFT,
      doc: (parseRule(DRAFT) as { doc: unknown }).doc,
      source: 'user',
      scope: 'project',
      type: 'ban',
      paths: ['db/**'],
      when: 'any schema work',
      slug: 'no-shipped-migration-edits',
      run: RUN,
    })
    // The run's own ledger has nothing of it.
    expect(readdirSync(runDir(w.litterDir, RUN))).toEqual(['run.json'])
  })

  test("from a run's agent: the run is its own, and the source agent", async () => {
    await runUsing(RUN, [])
    await writePolicy(w.p, w.litterDir, policyFor(RUN))
    await consumeAgents(
      { p: w.p, litterDir: w.litterDir, sessionId: 'test-session' },
      { v: 1, ev: 'start', ts: 1_700_000_000, session_id: 'test-session', agent_id: 'gc', agent_type: 'litter:gate-critic', cwd: '/w', transcript_path: '/t' },
    )
    const r = asOk(await call({ kind: 'rule.propose', rule: 'Freeze the clock in tests.' }, 'gc'))
    expect(r.run).toBe(RUN)
    const [rec] = await repoRecords()
    expect(rec!.by).toEqual({ source: 'agent', agentId: 'gc', agentType: 'litter:gate-critic' })
    expect(rec!.body).toEqual({ rule: 'Freeze the clock in tests.', source: 'agent', run: RUN })
  })

  test('each field is checked, naming it', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{}, 'rule'],
      [{ rule: 'x'.repeat(8 * 1024 + 1) }, 'rule'],
      [{ rule: '---\ntype: guideline\n---\n## Rule\nx\n' }, 'rule'],
      [{ rule: 'r', source: 7 }, 'source'],
      [{ rule: 'r', edits: 'nope' }, 'edits'],
      [{ rule: 'r', scope: 'team' }, 'scope'],
      [{ rule: 'r', type: 'guideline' }, 'type'],
      [{ rule: 'r', paths: ['../x'] }, 'paths'],
      [{ rule: 'r', paths: 'src/**' }, 'paths'],
      [{ rule: 'r', when: 3 }, 'when'],
      [{ rule: 'r', slug: 'Not A Slug' }, 'slug'],
      [{ rule: 'r', run: 'nope' }, 'run'],
    ]
    for (const [fields, field] of cases) expect({ fields, field: asError(await call({ kind: 'rule.propose', ...fields })).field }).toEqual({ fields, field })
    expect(asError(await call({ kind: 'rule.propose', rule: '---\ntype: guideline\n---\n## Rule\nx\n' })).error).toBe(
      "litter: 'rule' is a rule file that doesn't parse: line 2: type is rule or ban, not \"guideline\"",
    )
    expect(await repoRecords()).toEqual([])
  })

  test("the duplicate of an accepted rule is refused with that rule's id; an edit must name the version in force", async () => {
    const ref = (asOk(await call({ kind: 'rule.propose', rule: 'Never commit secrets.' })).proposal) as { store: 'repo'; seq: number }
    expect((await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope: 'project' })).ok).toBe(true)
    const dup = asError(await call({ kind: 'rule.propose', rule: '  NEVER commit\n secrets. ' }))
    expect(dup).toEqual({
      ok: false,
      error: "litter: accepted rule P-never-commit-secrets@1 already says this; to change that rule, propose an edit of it with edits: 'P-never-commit-secrets@1'",
      field: 'rule',
    })
    expect(asError(await call({ kind: 'rule.propose', rule: 'x', edits: 'P-never-commit-secrets@2' })).error).toBe(
      "litter: P-never-commit-secrets is at version 1, so an edit of it is edits: 'P-never-commit-secrets@1'",
    )
    expect(asError(await call({ kind: 'rule.propose', rule: 'x', edits: 'P-missing@1' })).field).toBe('edits')
    expect(asOk(await call({ kind: 'rule.propose', rule: 'Never commit secrets or keys.', edits: 'P-never-commit-secrets@1' })).status).toBe('proposed')
  })

  test('a dismissed text is recorded, reads as dismissed, and the reply says so', async () => {
    const ref = asOk(await call({ kind: 'rule.propose', rule: 'Always rebase onto main.' })).proposal as { store: 'repo'; seq: number }
    expect((await dismissRule(w.p, w.litterDir, ref)).ok).toBe(true)
    const again = asOk(await call({ kind: 'rule.propose', rule: 'always rebase onto MAIN.' }))
    expect(again).toEqual(expect.objectContaining({ status: 'dismissed', note: "the user dismissed a proposal with this text before, so it isn't offered again" }))
  })

  test('a bare repository takes only the user scope', async () => {
    const litterDir = `${w.repo}.git/litter`
    const r = await dispatchRecord(w.p, undefined, { kind: 'rule.propose', rule: 'Tag releases.', scope: 'project' }, { ...env(), litterDir })
    expect(asError(r)).toEqual({ ok: false, error: "litter: a bare repository has no project or local scope; use user, or leave 'scope' out", field: 'scope', allowed: ['user'] })
  })
})

describe('rule.find', () => {
  test('{ id }: the rule, its versions from the file, .history and the ledger, and the runs that used each', async () => {
    const ref = asOk(await call({ kind: 'rule.propose', rule: 'Log every retry.' })).proposal as { store: 'repo'; seq: number }
    await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope: 'local' })
    const edit = asOk(await call({ kind: 'rule.propose', rule: 'Log every retry, with its attempt.', edits: 'L-log-every-retry@1' })).proposal as { store: 'repo'; seq: number }
    await acceptRule(w.p, w.litterDir, { proposal: edit })
    await runUsing('20261003-one', [{ id: 'L-log-every-retry', version: 1 }])
    await runUsing('20261003-two', [{ id: 'L-log-every-retry', version: 2 }, { id: 'P-other', version: 1 }])
    const r = asOk(await call({ kind: 'rule.find', id: 'L-log-every-retry' }))
    expect((r.rules as { id: string; version: number; standing: string; text: string }[]).map(x => [x.id, x.version, x.standing])).toEqual([['L-log-every-retry', 2, 'accepted']])
    expect((r.rules as { text: string }[])[0]!.text).toContain('Log every retry, with its attempt.')
    expect((r.versions as { version: number; from: string[] }[]).map(v => [v.version, v.from])).toEqual([
      [1, ['.history', 'accepted in the rules pane']],
      [2, ['the file', 'accepted in the rules pane']],
    ])
    expect((r.runs as { run: string; version: number }[]).map(x => [x.run, x.version]).sort()).toEqual([
      ['20261003-one', 1],
      ['20261003-two', 2],
    ])
    expect(asError(await call({ kind: 'rule.find', id: 'L-nothing' })).field).toBe('id')
    expect(asError(await call({ kind: 'rule.find', id: 'not an id' })).field).toBe('id')
  })

  test('{ id } of a retired rule answers its history', async () => {
    const ref = asOk(await call({ kind: 'rule.propose', rule: 'Use the staging bucket.' })).proposal as { store: 'repo'; seq: number }
    await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope: 'local' })
    await retireRule(w.p, w.litterDir, { id: 'L-use-the-staging-bucket', version: 1 })
    const r = asOk(await call({ kind: 'rule.find', id: 'L-use-the-staging-bucket' }))
    expect(r.rules).toEqual([])
    expect((r.retired as { version: number }[]).map(x => x.version)).toEqual([1])
  })

  test('{ status }: rules and proposals in those states, the list JSON-encoded or not', async () => {
    const ref = asOk(await call({ kind: 'rule.propose', rule: 'Keep fixtures small.' })).proposal as { store: 'repo'; seq: number }
    await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope: 'local' })
    await call({ kind: 'rule.propose', rule: 'Name fixtures after what they hold.', scope: 'project' })
    await writeRuleFile(w, 'project', ruleDoc('P-teammate', 'Squash before merging.'))
    for (const status of [['accepted', 'proposed'], JSON.stringify(['accepted', 'proposed'])]) {
      const r = asOk(await call({ kind: 'rule.find', status }))
      expect((r.rules as { id: string; standing: string; delivered: string | null }[]).map(x => [x.id, x.standing, x.delivered])).toEqual([
        ['P-teammate', 'unverified', null],
        ['L-keep-fixtures-small', 'accepted', 'L-keep-fixtures-small@1'],
      ])
      expect((r.proposals as { proposal: unknown; status: string; rule: string }[]).map(x => [x.status, x.rule])).toEqual([
        ['accepted', 'Keep fixtures small.'],
        ['proposed', 'Name fixtures after what they hold.'],
      ])
    }
    const only = asOk(await call({ kind: 'rule.find', status: 'proposed' }))
    expect((only.proposals as { status: string }[]).map(x => x.status)).toEqual(['proposed'])
    expect(asError(await call({ kind: 'rule.find', status: ['live'] }))).toEqual(expect.objectContaining({ field: 'status', allowed: ['proposed', 'accepted', 'dismissed', 'retired'] }))
  })

  test('{ similar }: rules with the same folded text, rules whose paths overlap, and pending proposals', async () => {
    await writeRuleFile(w, 'project', ruleDoc('P-migrations', 'Never edit a migration that has shipped.', { type: 'ban' }))
    await writeRuleFile(w, 'project', ruleDoc('P-db', 'Run the schema check.', { applies: { paths: ['db/**'], when: 'changing the schema' } }))
    await writeRuleFile(w, 'project', ruleDoc('P-docs', 'Wrap prose at 100.', { applies: { paths: ['docs/**'], when: 'writing docs' } }))
    await w.git('add', '.litter')
    await w.git('commit', '-q', '-m', 'rules')
    // A committed rule is in force, so proposing its text again is refused.
    expect(asError(await call({ kind: 'rule.propose', rule: 'never edit a migration that has SHIPPED.' })).error).toContain('accepted rule P-migrations@1 already says this')
    await call({ kind: 'rule.propose', rule: 'Wrap prose at 100 columns.' })
    const r = asOk(await call({ kind: 'rule.find', similar: DRAFT }))
    expect((r.same as { id: string }[]).map(x => x.id)).toEqual(['P-migrations'])
    expect((r.overlapping as { id: string }[]).map(x => x.id)).toEqual(['P-db'])
    expect(r.pending).toEqual([])
    const pending = asOk(await call({ kind: 'rule.find', similar: 'wrap prose at 100 COLUMNS.' }))
    expect((pending.pending as { proposal: unknown }[]).map(x => x.proposal)).toEqual([{ store: 'repo', seq: 1 }])
    // A plain-text draft with no paths overlaps nothing by path.
    const plain = asOk(await call({ kind: 'rule.find', similar: 'Wrap prose at 100.' }))
    expect([(plain.same as { id: string }[]).map(x => x.id), plain.overlapping]).toEqual([['P-docs'], []])
  })

  test("{ applicable }: AE's findApplicable, given the call's field as it is", async () => {
    const seen: unknown[] = []
    recordsDeps.findApplicable = async (_p, litterDir, applicable) => {
      seen.push([litterDir, applicable])
      return { ok: true, run: ['x'], gates: {}, versions: [] }
    }
    const r = await call({ kind: 'rule.find', applicable: JSON.stringify({ workflow: 'execute', planPath: '/p/plan.md' }) })
    expect(r).toEqual({ ok: true, run: ['x'], gates: {}, versions: [] })
    expect(seen).toEqual([[w.litterDir, { workflow: 'execute', planPath: '/p/plan.md' }]])
    expect(asError(await call({ kind: 'rule.find', applicable: 'nope' })).field).toBe('applicable')
  })

  test("with no config dir to be found, every form answers, the user rules named as unread", async () => {
    w.p.configDirValue = null
    asOk(await call({ kind: 'rule.propose', rule: 'Keep fixtures small.' }))
    const r = asOk(await call({ kind: 'rule.find', status: ['proposed', 'retired'] }))
    expect(r).toEqual(expect.objectContaining({ rules: [], retired: [], problems: ["your user rules aren't read: no config dir in tier 2 (set configDirValue)"] }))
    expect((r.proposals as unknown[]).length).toBe(1)
    expect(asError(await call({ kind: 'rule.find', id: 'U-answer-tersely' })).field).toBe('id')
    expect(asOk(await call({ kind: 'rule.find', similar: 'Keep fixtures small.' })).pending).toHaveLength(1)
  })

  test('takes exactly one form, and writes nothing in any of them', async () => {
    expect(asError(await call({ kind: 'rule.find' })).field).toBe('id')
    expect(asError(await call({ kind: 'rule.find', id: 'P-x', status: ['accepted'] })).field).toBe('status')
    const ref = asOk(await call({ kind: 'rule.propose', rule: 'Keep fixtures small.' })).proposal as { store: 'repo'; seq: number }
    await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope: 'project' })
    await runUsing(RUN, [{ id: 'P-keep-fixtures-small', version: 1 }])
    recordsDeps.findApplicable = async () => ({ ok: true })
    const root = w.repo.slice(0, w.repo.lastIndexOf('/'))
    const before = snapshotFiles(root)
    for (const fields of [{ id: 'P-keep-fixtures-small' }, { status: ['accepted', 'proposed', 'dismissed', 'retired'] }, { similar: 'Keep fixtures small.' }, { applicable: {} }]) {
      expect((await call({ kind: 'rule.find', ...fields })).ok).toBe(true)
    }
    expect(snapshotFiles(root)).toEqual(before)
  })
})

describe('rule.open', () => {
  test('records the open by id or proposal, then opens the pane on it', async () => {
    const ref = asOk(await call({ kind: 'rule.propose', rule: 'Keep fixtures small.' })).proposal as { store: 'repo'; seq: number }
    const r = asOk(await call({ kind: 'rule.open', proposal: JSON.stringify(ref) }))
    expect(r).toEqual({ ok: true, kind: 'rule.open', seq: 2, opened: true })
    await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope: 'user' })
    expect(asOk(await call({ kind: 'rule.open', id: 'U-keep-fixtures-small' })).opened).toBe(true)
    expect(opened).toEqual([{ proposal: ref }, { id: 'U-keep-fixtures-small' }])
    // A user rule's open is in your ledger; a proposal's in the one it's in.
    expect((await repoRecords()).map(x => [x.kind, x.body])).toEqual([
      ['rule.propose', { rule: 'Keep fixtures small.', source: 'user' }],
      ['rule.open', { proposal: ref }],
    ])
    expect((await readRuleLedger(w.p, w.litterDir, 'user')).records.map(x => x.kind)).toEqual(['rule.accept', 'rule.open'])
  })

  test('a pane that refuses or throws: the open is still recorded, and the reply says to run /litter-rules', async () => {
    const ref = asOk(await call({ kind: 'rule.propose', rule: 'Keep fixtures small.' })).proposal
    paneAnswer = async () => false
    expect(asOk(await call({ kind: 'rule.open', proposal: ref }))).toEqual(expect.objectContaining({ opened: false, note: "the rules pane didn't open here; tell the user to run /litter-rules" }))
    paneAnswer = async () => {
      throw new Error('ui.open refused')
    }
    expect(asOk(await call({ kind: 'rule.open', proposal: ref }))).toEqual(expect.objectContaining({ opened: false }))
    expect((await repoRecords()).map(x => x.kind)).toEqual(['rule.propose', 'rule.open', 'rule.open'])
    expect(w.p.logs.join('\n')).toContain('ui.open refused')
  })

  test('refuses what names nothing, naming the field', async () => {
    expect(asError(await call({ kind: 'rule.open' })).field).toBe('id')
    expect(asError(await call({ kind: 'rule.open', id: 'P-x', proposal: { store: 'repo', seq: 1 } })).field).toBe('id')
    expect(asError(await call({ kind: 'rule.open', id: 'P-missing' })).error).toBe("litter: there's no rule P-missing; rule.find with status ['accepted', 'proposed'] lists them")
    expect(asError(await call({ kind: 'rule.open', proposal: { store: 'repo', seq: 9 } })).error).toBe("litter: there's no proposal repo:9")
    expect(asError(await call({ kind: 'rule.open', proposal: { store: 'elsewhere', seq: 1 } })).field).toBe('proposal')
    expect(opened).toEqual([])
  })
})

describe('rule.import', () => {
  const state = (guardrails: unknown[], more: Record<string, unknown> = {}) => JSON.stringify({ goal: 'Ship the parser', started_at: '2026-09-30T10:00:00Z', guardrails, ...more })

  test('proposes each new guardrail once as a project ban, records the batch, and opens the pane on it', async () => {
    await w.p.fs.write(
      `${w.repo}/.claude/deepwork/live-1/state.json`,
      state([
        { rule: 'Never push to main.', source: 'user' },
        { rule: 'Keep the public API stable.', source: 'flag' },
        { rule: 'Ask before deleting files.', source: 'orchestrator' },
      ]),
    )
    await w.p.fs.write(`${w.repo}/.claude/deepwork/old-1/state.archived.json`, state([{ rule: 'NEVER push to main.', source: 'flag' }, { rule: 'Use pnpm.', source: 'flag' }], { goal: 'Old work' }))
    const r = asOk(await call({ kind: 'rule.import', from: 'deepwork' }))
    expect(r).toEqual(
      expect.objectContaining({ ok: true, kind: 'rule.import', seq: 5, proposals: 4, live: 3, archived: 1, preselected: 2, skipped: { accepted: 0, pending: 0, dismissed: 0, repeated: 1 }, opened: true }),
    )
    const recs = await repoRecords()
    expect(recs.map(x => x.kind)).toEqual(['rule.propose', 'rule.propose', 'rule.propose', 'rule.propose', 'rule.import'])
    expect(recs[0]!.body).toEqual(
      expect.objectContaining({ rule: 'Never push to main.', source: 'import', scope: 'project', type: 'ban', paths: [], import: { instance: 'live-1', source: 'user', archived: false } }),
    )
    expect((recs[0]!.body as { doc: { body: { why: string } } }).doc.body.why).toBe('Imported from deepwork instance live-1 (Ship the parser, 2026-09-30T10:00:00Z); source user')
    expect(recs[4]!.body).toEqual({
      from: 'deepwork',
      instances: [
        { id: 'live-1', goal: 'Ship the parser', date: '2026-09-30T10:00:00Z', archived: false },
        { id: 'old-1', goal: 'Old work', date: '2026-09-30T10:00:00Z', archived: true },
      ],
      proposals: [1, 2, 3, 4].map(seq => ({ store: 'repo', seq })),
      preselected: [1, 2].map(seq => ({ store: 'repo', seq })),
    })
    expect(opened).toEqual([{ proposal: { store: 'repo', seq: 5 } }])
    // Accepting is the pane's: an imported ban takes its paths there.
    const done = await acceptRule(w.p, w.litterDir, { proposal: { store: 'repo', seq: 1 } }, { paths: ['src/**'] })
    expect(done).toEqual({ ok: true, path: `${w.dirs.project}/P-never-push-to-main.md` })
    expect(readFileSync(done.ok ? done.path! : '', 'utf8')).toContain('type: ban\napplies:\n  paths: [src/**]')
  })

  test('a second import skips what is pending, accepted or dismissed, and counts each', async () => {
    await w.p.fs.write(`${w.repo}/.claude/deepwork/live-1/state.json`, state([{ rule: 'A.', source: 'user' }, { rule: 'B.', source: 'user' }, { rule: 'C.', source: 'user' }]))
    asOk(await call({ kind: 'rule.import', from: 'deepwork' }))
    await acceptRule(w.p, w.litterDir, { proposal: { store: 'repo', seq: 1 } })
    await dismissRule(w.p, w.litterDir, { store: 'repo', seq: 2 })
    const again = asOk(await call({ kind: 'rule.import', from: 'deepwork' }))
    expect(again).toEqual(expect.objectContaining({ proposals: 0, skipped: { accepted: 1, pending: 1, dismissed: 1, repeated: 0 }, opened: false, note: 'no new guardrails to propose' }))
    expect(opened).toHaveLength(1)
  })

  test("is the main thread's only, and takes from: 'deepwork'", async () => {
    expect(asError(await call({ kind: 'rule.import', from: 'deepwork' }, 'some-agent')).field).toBe('kind')
    expect(asError(await call({ kind: 'rule.import', from: 'swarm-loop' }))).toEqual(expect.objectContaining({ field: 'from', allowed: ['deepwork'] }))
    expect(asOk(await call({ kind: 'rule.import', from: 'deepwork' }))).toEqual(expect.objectContaining({ proposals: 0, note: `there are no deepwork instances in ${w.repo}/.claude/deepwork` }))
  })
})

describe('the steps that are yours alone', () => {
  test('rule.accept, rule.dismiss and rule.retire are refused through the tool, and nothing is written', async () => {
    const ref = asOk(await call({ kind: 'rule.propose', rule: 'Keep fixtures small.' })).proposal
    const before = await repoRecords()
    for (const kind of ['rule.accept', 'rule.dismiss', 'rule.retire']) {
      for (const agentId of [undefined, 'gc']) {
        const e = asError(await call({ kind, proposal: ref, id: 'P-x', version: 1, scope: 'project', via: 'ui' }, agentId))
        expect(e.allowed).toEqual(['rule.propose', 'rule.open'])
      }
    }
    expect(await repoRecords()).toEqual(before)
  })
})
