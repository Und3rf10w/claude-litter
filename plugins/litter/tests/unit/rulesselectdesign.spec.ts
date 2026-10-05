// Tier 2: rule selection for a design (plan 16.5's design line; WP-BD), with
// AD's real store in a scratch repository holding rules in the three scopes:
// every rule without paths and every ban, the rules the anchors and the
// goal's named files bring, workflows and roles, what's never in force; and
// rule.find { applicable } for a design answering exactly what run.start
// put in args and run.json.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import type { RecordInput } from '../../hooks/records/core'
import type { BarItem } from '../../hooks/records/run'
import type { SelectInput } from '../../hooks/records/rules'
import { findApplicable, selectForRun } from '../../hooks/rules/select'
import { recordRuleFind } from '../../hooks/rules/records'
import { stopLease } from '../../hooks/lock'
import { updateSession } from '../../hooks/session'
import { writeRuleFile } from './rules-harness'
import { acceptedRule, BAR, launchWorld, okReply, repoFile, rule, runJsonOf, startDesign, type LaunchWorld } from './designlaunch-harness'

// run.start and the store run real git in scratch repos; a loaded machine takes seconds.
setDefaultTimeout(120_000)

const cleanups: (() => void)[] = []
afterEach(() => {
  stopLease()
  updateSession({ litterDir: null })
  for (const c of cleanups.splice(0)) c()
})

async function world(): Promise<LaunchWorld> {
  const w = await launchWorld()
  cleanups.push(w.cleanup)
  return w
}

const input = (w: LaunchWorld, o: Partial<SelectInput>): SelectInput => ({
  litterDir: w.litterDir,
  workflow: 'design',
  gates: [],
  tasks: [],
  planText: null,
  goal: null,
  anchors: [],
  checkout: w.repo,
  runRules: [],
  ...o,
})

/** The id of each rendered entry, in order. */
const ids = (entries: readonly string[]): string[] => entries.map(e => e.slice(0, e.indexOf('@')))

/** The rules of the selection cases: one per way in, and one per way out. */
async function rulesInThreeScopes(w: LaunchWorld) {
  await repoFile(w, 'src/retry.ts')
  await repoFile(w, 'lib/util.ts')
  await repoFile(w, 'docs/guide.md')
  await acceptedRule(w, 'user', rule('U-always', 'Name each option after what it does.'))
  await acceptedRule(w, 'project', rule('P-vendor', 'Never edit vendor code.', { type: 'ban', paths: ['vendor/**'], why: 'upstream' }))
  // Patterns with a slash before their last segment, so they're anchored (match.ts: `docs/**` reads as `docs`, anywhere).
  await acceptedRule(w, 'local', rule('L-src', 'Keep src/ free of I/O.', { paths: ['src/**/*.ts'] }))
  await acceptedRule(w, 'project', rule('P-util', 'Keep lib/util.ts pure.', { paths: ['lib/util.ts'] }))
  await acceptedRule(w, 'project', rule('P-docs', 'Docs follow the style guide.', { paths: ['docs/*.md'] }))
  await acceptedRule(w, 'project', rule('P-execute', 'Run the suite before each land.', { workflows: ['execute', 'fanout'] }))
  await acceptedRule(w, 'project', rule('P-design', 'Name the rollback of each step.', { workflows: ['design'] }))
  await acceptedRule(w, 'user', rule('U-author', 'Cite a file for each claim.', { roles: ['author'] }))
  await acceptedRule(w, 'user', rule('U-executor', 'Commit nothing yourself.', { roles: ['executor'] }))
  // Written by hand and never accepted: unverified (16.4), so never delivered.
  await writeRuleFile(w, 'project', rule('P-unverified', 'Never deploy on a Friday.'))
}

describe("a design's selection (16.5)", () => {
  test("every rule without paths and every ban, plus those its anchors and the goal's named files bring; nothing else", async () => {
    const w = await world()
    await rulesInThreeScopes(w)
    const sel = await selectForRun(w.p, input(w, { anchors: ['src/retry.ts'], goal: 'make `lib/util.ts` retry once' }))
    // The shared ones first (pathless and bans, by id), then the path-matched ones.
    expect(ids(sel.run)).toEqual(['P-design', 'P-vendor', 'U-always', 'U-author', 'P-util', 'L-src'])
    expect(sel.run.find(e => e.startsWith('P-vendor@'))).toBe('P-vendor@1 (ban; protects vendor/**) working near P-vendor: Never edit vendor code.')
    expect(sel.versions.map(v => v.id)).toEqual(ids(sel.run))
    expect({ gates: sel.gates, tasks: sel.tasks, verifier: sel.verifier, planner: sel.planner }).toEqual({ gates: {}, tasks: {}, verifier: [], planner: [] })
  })

  test("a rule for a path nothing names isn't selected, nor one the goal names only in passing or that doesn't exist", async () => {
    const w = await world()
    await rulesInThreeScopes(w)
    const sel = await selectForRun(w.p, input(w, { goal: 'retry like docs/guide.md says, and see `docs/missing.md`' }))
    expect(ids(sel.run)).toEqual(['P-design', 'P-vendor', 'U-always', 'U-author'])
  })

  test("an anchor's :line, #section and backticks are dropped, a folder or glob gets every rule under it, and a phrase or URL is no path", async () => {
    const w = await world()
    await rulesInThreeScopes(w)
    const pick = async (anchors: string[]) => ids((await selectForRun(w.p, input(w, { anchors }))).run).filter(id => ['L-src', 'P-util', 'P-docs'].includes(id))
    expect(await pick(['src/retry.ts:12-30'])).toEqual(['L-src'])
    expect(await pick(['`lib/util.ts#retry`'])).toEqual(['P-util'])
    expect(await pick(['the retry in `src/retry.ts`'])).toEqual(['L-src'])
    expect(await pick([`${w.repo}/docs/guide.md`])).toEqual(['P-docs'])
    expect(await pick(['src', 'lib/'])).toEqual(['P-util', 'L-src'])
    expect(await pick(['docs/*.md'])).toEqual(['P-docs'])
    // Not yet in the checkout, and named as where the problem is: it still brings its rules.
    expect(await pick(['src/new/backoff.ts'])).toEqual(['L-src'])
    expect(await pick(['retry handling in docs', 'https://example.com/src/x.ts', '/etc/src/retry.ts', 'incident 2026-09'])).toEqual([])
  })

  test("your run rules count against the 8 KiB cap, first: past it the rest are counted, and aren't in versions", async () => {
    const w = await world()
    await rulesInThreeScopes(w)
    const runRules = [`For this run (stated by you): ${'y'.repeat(8 * 1024 - 120)}`]
    const sel = await selectForRun(w.p, input(w, { runRules }))
    expect(sel.run).toEqual(['and 4 more accepted rules; rule.find lists them'])
    expect(sel.versions).toEqual([])
  })
})

describe('rule.find { applicable } for a design', () => {
  test("answers exactly the run, the bar's added items and the versions run.start put in args and run.json, writing nothing", async () => {
    const w = await world()
    await rulesInThreeScopes(w)
    const anchors = ['src/retry.ts']
    const goal = 'make `lib/util.ts` retry once'
    const runRules = ['no new dependency']
    const before = (await w.git('status', '--porcelain', '--untracked-files=all', '--ignored')).trim()
    const found = await recordRuleFind(w.ctx, { kind: 'rule.find', applicable: { workflow: 'design', anchors, goal, runRules, bar: BAR } } as RecordInput)
    expect((await w.git('status', '--porcelain', '--untracked-files=all', '--ignored')).trim()).toBe(before)
    if (!found.ok) throw new Error(JSON.stringify(found))
    const f = found as unknown as { workflow: string; run: string[]; bar: BarItem[]; versions: unknown[]; problems: string[] }

    const r = okReply(await startDesign(w, { anchors, goal, runRules }))
    const args = r.args as { rules: string[]; bar: BarItem[] }
    expect(f.workflow).toBe('design')
    expect(f.run).toEqual(args.rules.slice(1))
    expect(args.rules[0]).toBe('For this run (stated by you): no new dependency')
    expect(f.bar).toEqual(args.bar.slice(BAR.length))
    expect(f.bar.map(b => b.id)).toEqual(['B2', 'C7'])
    expect(found).not.toHaveProperty('note')
    expect(f.versions).toEqual((await runJsonOf(w, r)).rules)
    expect(f.problems).toEqual([])
    expect(await w.p.fs.read(join(r.runDir, 'bar.md'))).toContain('- **B2** Never edit vendor code.')
  })

  test("without your draft bar its items number from B1 and C1, with a note that the ids are assigned at launch; with no rules in scope it adds nothing", async () => {
    const w = await world()
    await acceptedRule(w, 'project', rule('P-ban', 'Never drop a table.', { type: 'ban', why: 'data loss' }))
    await acceptedRule(w, 'project', rule('P-api', 'Keep the API.'))
    const note =
      "the ids in 'bar' are numbered from C1 and B1 here; run.start assigns them at launch, after your own items' ids. Pass 'bar', your draft bar, to see them numbered as run.start will"
    const a = (await findApplicable(w.p, w.litterDir, { workflow: 'design', goal: 'g' })) as unknown as { bar: BarItem[]; note?: string }
    expect(a.bar.map(b => [b.id, b.rule ?? b.rules])).toEqual([
      ['B1', { id: 'P-ban', version: 1 }],
      ['C1', [{ id: 'P-api', version: 1 }]],
    ])
    expect(a.note).toBe(note)
    // With your draft bar, numbered on from its highest C and B, as run.start numbers them; no note.
    const b = (await findApplicable(w.p, w.litterDir, { workflow: 'design', goal: 'g', bar: [{ id: 'C2' }, { id: 'C9' }, { id: 'B4' }, { id: 'C3' }] })) as unknown as { bar: BarItem[]; note?: string }
    expect(b.bar.map(x => x.id)).toEqual(['B5', 'C10'])
    expect(b.note).toBeUndefined()

    const bare = await world()
    expect(await findApplicable(bare.p, bare.litterDir, { workflow: 'design', goal: 'g', anchors: ['src/a.ts'] })).toEqual({
      ok: true,
      workflow: 'design',
      run: [],
      bar: [],
      versions: [],
      problems: [],
      note,
    })
  })
})
