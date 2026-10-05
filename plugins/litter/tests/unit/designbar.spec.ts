// Tier 2: the accepted rules joining a design's frozen bar (plan 16.5;
// COMMON decision 4; WP-BD): rulesIntoBar's numbering and items, bar.md, and
// run.start for real in a scratch repository with rules in the three
// scopes, its args.bar, args.rules, bar.md and run.json.rules one selection.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import type { BarItem } from '../../hooks/records/run'
import type { LoadedRule, RuleDoc } from '../../hooks/records/rules'
import { BAN_EVIDENCE, RULES_EVIDENCE, renderBar, rulesIntoBar, selectedRules } from '../../hooks/design/bar'
import { deps as launchDeps } from '../../hooks/design/launch'
import { stopLease } from '../../hooks/lock'
import { updateSession } from '../../hooks/session'
import { acceptedRule, BAR, launchWorld, nothingWritten, okReply, rule, runJsonOf, startDesign, type LaunchWorld } from './designlaunch-harness'

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

async function world(): Promise<LaunchWorld> {
  const w = await launchWorld()
  cleanups.push(w.cleanup)
  return w
}

/** A rule as loadRules hands it over, in force as `delivered`. */
function loaded(doc: RuleDoc, delivered: RuleDoc | null = doc): LoadedRule {
  return { doc, scope: 'project', path: `/rules/${doc.id}.md`, sha256: 'f'.repeat(64), standing: 'accepted', delivered }
}

describe('rulesIntoBar (decision 4)', () => {
  const mine: BarItem[] = [
    { id: 'C1', text: 'a', evidence: 'e' },
    { id: 'C7', text: 'b', evidence: 'e' },
    { id: 'B2', text: 'c', evidence: 'e', reason: 'r' },
    { id: 'C3', text: 'd', evidence: 'e' },
  ]

  test('your items come first, unchanged; each ban becomes B<next> after your highest B, the rest one C<next> after your highest C', () => {
    const vendor = rule('P-vendor', 'Never edit\n  vendor/.', { type: 'ban', paths: ['vendor/**'], why: 'It is\nupstream code.', howToCheck: ['git diff --stat vendor/ is empty', '  no vendor path in the plan  '] })
    const sleep = rule('U-no-sleep', 'Never sleep in a test.', { type: 'ban', version: 3 })
    const api = rule('P-api', 'Keep the public API.', { version: 2 })
    const docs = rule('L-docs', 'Document each option.')
    const bar = rulesIntoBar(mine, [vendor, api, sleep, docs].map(d => loaded(d)))
    expect(bar.slice(0, mine.length)).toEqual(mine)
    expect(bar.slice(mine.length)).toEqual([
      {
        id: 'B3',
        text: 'Never edit vendor/.',
        evidence: 'git diff --stat vendor/ is empty; no vendor path in the plan',
        reason: 'It is upstream code.',
        rule: { id: 'P-vendor', version: 1 },
      },
      { id: 'B4', text: 'Never sleep in a test.', evidence: BAN_EVIDENCE, reason: 'the accepted ban U-no-sleep@3', rule: { id: 'U-no-sleep', version: 3 } },
      {
        id: 'C8',
        text: 'Consistent with rules P-api@2, L-docs@1, or asks before changing one, as a blocking user decision.',
        evidence: RULES_EVIDENCE,
        rules: [
          { id: 'P-api', version: 2 },
          { id: 'L-docs', version: 1 },
        ],
      },
    ])
  })

  test('with no rule but bans, no criterion is added; with no rules, the bar is yours', () => {
    const ban = rule('P-ban', 'Never drop a table.', { type: 'ban', why: 'data loss' })
    expect(rulesIntoBar(mine, [loaded(ban)]).map(b => b.id)).toEqual(['C1', 'C7', 'B2', 'C3', 'B3'])
    expect(rulesIntoBar(mine, [])).toEqual(mine)
  })

  test('the numbering starts at 1 when you have none of a kind, and a rule is read in the version in force', () => {
    const edited = rule('P-api', 'Keep the API, now with a typo fixd.', { version: 3 })
    const atHead = rule('P-api', 'Keep the API.', { version: 2 })
    const bar = rulesIntoBar([{ id: 'C2', text: 'x', evidence: 'e' }], [loaded(edited, atHead), loaded(rule('P-ban', 'Never.', { type: 'ban', why: 'w' }))])
    expect(bar.map(b => [b.id, b.rule ?? b.rules])).toEqual([
      ['C2', undefined],
      ['B1', { id: 'P-ban', version: 1 }],
      ['C3', [{ id: 'P-api', version: 2 }]],
    ])
  })

  test('selectedRules picks the selection\'s versions in its order; one at another version now is changed, one not in force is gone', () => {
    const a = loaded(rule('P-a', 'A.'))
    const b = loaded(rule('P-b', 'B.', { version: 2 }))
    expect(selectedRules([a, b], [{ id: 'P-b', version: 2 }, { id: 'P-a', version: 1 }])).toEqual({ rules: [b, a], gone: [] })
    expect(selectedRules([a, b], [{ id: 'P-b', version: 1 }])).toEqual({ changed: { id: 'P-b', version: 1 } })
    expect(selectedRules([a, loaded(rule('P-c', 'C.'), null)], [{ id: 'P-c', version: 1 }, { id: 'P-a', version: 1 }])).toEqual({ rules: [a], gone: [{ id: 'P-c', version: 1 }] })
  })
})

describe('bar.md', () => {
  test("lists every item, a ban from a rule naming it, and is today's for your items alone", () => {
    const bar = rulesIntoBar(BAR, [loaded(rule('P-ban', 'Never drop a table.', { type: 'ban', why: 'data loss' })), loaded(rule('P-api', 'Keep the API.'))])
    expect(renderBar(bar)).toBe(
      [
        '# Bar',
        '',
        '- **C1** retries once\n  Evidence: a test',
        '- **C2** keeps the timeout\n  Evidence: the config',
        '- **C3** logs each retry\n  Evidence: a log line',
        '- **C4** needs no new dependency\n  Evidence: package.json',
        '- **C5** reads the retry count from the options\n  Evidence: options.ts',
        '- **C6** keeps the public API\n  Evidence: the exports',
        '- **B1** no sleep in tests\n  Evidence: grep\n  Reason: flaky',
        `- **B2** Never drop a table.\n  Evidence: ${BAN_EVIDENCE}\n  Reason: data loss\n  Rule: P-ban@1`,
        `- **C7** Consistent with rules P-api@1, or asks before changing one, as a blocking user decision.\n  Evidence: ${RULES_EVIDENCE}`,
        '',
      ].join('\n'),
    )
  })
})

describe('run.start: the rules in scope join the frozen bar', () => {
  test('bans become B<next> with their rule, the rest one C<next>; bar.md lists them, args.rules carries them after yours, run.json.rules their versions', async () => {
    const w = await world()
    await acceptedRule(w, 'user', rule('U-no-sleep', 'Never sleep in a test.', { type: 'ban', why: 'Sleeps make tests flaky.', howToCheck: ['grep -r sleep tests/'] }))
    await acceptedRule(w, 'project', rule('P-api', 'Keep the public API stable.', { version: 2 }))
    await acceptedRule(w, 'local', rule('L-small', 'Keep each change under 300 lines.'))
    const r = okReply(await startDesign(w, { runRules: ['touch nothing under docs/'] }))
    const added = [
      { id: 'B2', text: 'Never sleep in a test.', evidence: 'grep -r sleep tests/', reason: 'Sleeps make tests flaky.', rule: { id: 'U-no-sleep', version: 1 } },
      {
        id: 'C7',
        text: 'Consistent with rules L-small@1, P-api@2, or asks before changing one, as a blocking user decision.',
        evidence: RULES_EVIDENCE,
        rules: [
          { id: 'L-small', version: 1 },
          { id: 'P-api', version: 2 },
        ],
      },
    ]
    expect(r.args.bar).toEqual([...BAR, ...added])
    expect(await w.p.fs.read(join(r.runDir, 'bar.md'))).toBe(renderBar([...BAR, ...added] as BarItem[]))
    expect(await w.p.fs.read(join(r.runDir, 'bar.md'))).toContain('- **B2** Never sleep in a test.\n  Evidence: grep -r sleep tests/\n  Reason: Sleeps make tests flaky.\n  Rule: U-no-sleep@1')
    const rules = r.args.rules as string[]
    expect(rules[0]).toBe('For this run (stated by you): touch nothing under docs/')
    expect(rules.slice(1).map(x => x.slice(0, x.indexOf(' ')))).toEqual(['L-small@1', 'P-api@2', 'U-no-sleep@1'])
    expect((await runJsonOf(w, r)).rules).toEqual([
      { id: 'L-small', version: 1 },
      { id: 'P-api', version: 2 },
      { id: 'U-no-sleep', version: 1 },
    ])
  })

  test('with only bans in scope no criterion is added, and with none the bar is yours', async () => {
    const w = await world()
    await acceptedRule(w, 'project', rule('P-ban', 'Never drop a table.', { type: 'ban', why: 'data loss' }))
    const r = okReply(await startDesign(w))
    expect((r.args.bar as BarItem[]).map(b => b.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'B1', 'B2'])

    const bare = await world()
    const r2 = okReply(await startDesign(bare))
    expect(r2.args.bar).toEqual(BAR)
    expect((await runJsonOf(bare, r2)).rules).toEqual([])
  })

  test('a rule edited since the selection read the store refuses the launch, writing nothing; one gone since stays out of the bar', async () => {
    const w = await world()
    const api = await acceptedRule(w, 'project', rule('P-api', 'Keep the public API stable.'))
    launchDeps.loadRules = async () => ({ rules: [loaded({ ...api, version: 2 })], problems: [] })
    expect(await startDesign(w)).toEqual({
      ok: false,
      error: "litter: rule P-api changed while run.start read the rules (it was at version 1), so the bar can't hold it; launch again",
    })
    await nothingWritten(w)

    launchDeps.loadRules = async () => ({ rules: [], problems: [] })
    const r = okReply(await startDesign(w))
    expect(r.args.bar).toEqual(BAR)
    expect((await runJsonOf(w, r)).rules).toEqual([{ id: 'P-api', version: 1 }])
    expect(w.p.logs.some(l => l.includes('P-api@1 selected but no longer in force, so not in the bar'))).toBe(true)
  })

  test("a store that throws when the bar reads it refuses the launch, writing nothing", async () => {
    const w = await world()
    await acceptedRule(w, 'project', rule('P-api', 'Keep the public API stable.'))
    launchDeps.loadRules = async () => {
      throw new Error('the rules ledger is tampered at seq 2')
    }
    expect(await startDesign(w)).toEqual({
      ok: false,
      error: "litter: the accepted rules couldn't be read into the bar (the rules ledger is tampered at seq 2); /litter-rules shows them and their problems. Launch again once it's fixed",
    })
    await nothingWritten(w)
  })
})
