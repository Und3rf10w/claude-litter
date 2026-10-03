// Tier 2: the rules store in scratch repositories (WP-AD): what counts as
// accepted (12:1561-1565), the scopes (12:1567), ids and `.history`,
// info/exclude, a bare repository, edits, retire, dismissed text (12:1573)
// and critics' proposals. AE's validPattern is a fake here, since it's a
// stub before the merge.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { LoadedRule, RuleAcceptBody, RuleDoc } from '../../hooks/records/rules'
import { sha256 } from '../../hooks/fsx'
import { appendLaunchRecord } from '../../hooks/records/swarm'
import { parseRule, renderRule } from '../../hooks/rules/format'
import { appendRuleRecord, readRuleLedger } from '../../hooks/rules/ledger'
import {
  acceptRule,
  assignId,
  dismissRule,
  loadRules,
  narrowPaths,
  previewAccept,
  proposalsOf,
  proposeFromCritic,
  retireRule,
  slugOf,
} from '../../hooks/rules/store'
import { fakePatterns, propose, ruleDoc, rulesWorld, writeRuleFile, type RulesWorld } from './rules-harness'

let w: RulesWorld
let restore: () => void
beforeEach(async () => {
  restore = fakePatterns()
  w = await rulesWorld()
})
afterEach(() => {
  restore()
  w.cleanup()
})

const load = () => loadRules(w.p, w.litterDir)
const byId = async (id: string): Promise<LoadedRule> => {
  const r = (await load()).rules.find(x => x.doc.id === id)
  if (!r) throw new Error(`${id} isn't loaded`)
  return r
}
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r)}`)
  return r as Extract<T, { ok: true }>
}
const reason = (r: { ok: true } | { ok: false; reason: string }): string => {
  if (r.ok) throw new Error('accepted, and should have been refused')
  return r.reason
}
/** Commits the project rules (litterDir's run state stays out, as a real checkout keeps it). */
const commitAll = async (msg = 'rules') => {
  await w.git('add', '-A', '--', '.litter')
  await w.git('commit', '-q', '-m', msg)
  return (await w.git('rev-parse', 'HEAD')).trim()
}
const accepts = async (store: 'repo' | 'user' = 'repo') =>
  (await readRuleLedger(w.p, w.litterDir, store)).records.filter(r => r.kind === 'rule.accept').map(r => r.body as RuleAcceptBody)

/** Proposes `rule` and accepts it from the pane, answering the file written. */
async function accepted(rule: string, scope: 'user' | 'project' | 'local', more: Record<string, unknown> = {}): Promise<string> {
  const ref = await propose(w, { rule, ...more })
  return ok(await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope })).path!
}

describe('what counts as accepted (16.4)', () => {
  test('a file the mod wrote on accept is accepted, in each scope, and its sha256 is the one recorded', async () => {
    for (const scope of ['user', 'project', 'local'] as const) await accepted(`Rule for the ${scope} scope.`, scope)
    const { rules, problems } = await load()
    expect(problems).toEqual([])
    expect(rules.map(r => [r.scope, r.doc.id, r.standing, r.delivered === r.doc])).toEqual([
      ['user', 'U-rule-for-the-user-scope', 'accepted', true],
      ['project', 'P-rule-for-the-project-scope', 'accepted', true],
      ['local', 'L-rule-for-the-local-scope', 'accepted', true],
    ])
    const repo = await accepts('repo')
    const user = await accepts('user')
    expect(repo.map(a => a.scope)).toEqual(['project', 'local'])
    expect(user.map(a => a.scope)).toEqual(['user'])
    for (const r of rules) {
      const a = [...repo, ...user].find(x => x.id === r.doc.id)!
      expect(a).toEqual(expect.objectContaining({ version: 1, path: r.path, via: 'ui', sha256: await sha256(readFileSync(r.path, 'utf8')) }))
    }
    // Yours names this repository, since your ledger is every repository's.
    expect(user[0]).toEqual(expect.objectContaining({ proposal: { store: 'repo', seq: 1 }, litterDir: w.litterDir }))
  })

  test('the same file edited by hand is unverified, with nothing in force for a user or local rule', async () => {
    const path = await accepted('Keep fixtures small.', 'local')
    writeFileSync(path, readFileSync(path, 'utf8').replace('Keep fixtures small.', 'Keep fixtures tiny.'))
    const r = await byId('L-keep-fixtures-small')
    expect([r.standing, r.delivered]).toEqual(['unverified', null])
    expect(r.why).toBe('edited since it was accepted (a hand edit or a Write); accept the edit in the rules pane, or restore the file')
  })

  test("an edited committed rule is unverified, and HEAD's version is delivered instead", async () => {
    const path = await accepted('Run tier 3 before a hook script lands.', 'project')
    await commitAll()
    const headText = readFileSync(path, 'utf8')
    writeFileSync(path, headText.replace('tier 3', 'tier 1'))
    const r = await byId('P-run-tier-3-before-a-hook-script-lands')
    expect(r.standing).toBe('unverified')
    expect(r.doc.body.rule).toContain('tier 1')
    expect(r.delivered).toEqual(parseRule(headText).ok ? (parseRule(headText) as { doc: RuleDoc }).doc : null)
    expect(r.why).toBe("edited since HEAD (a hand edit or a Write); HEAD's version stays in force until the edit is accepted or committed")
  })

  test('a project rule committed at HEAD with no ledger entry is accepted (committed)', async () => {
    const doc = ruleDoc('P-committed', 'Name every fixture after what it holds.')
    await writeRuleFile(w, 'project', doc)
    await commitAll()
    const r = await byId('P-committed')
    expect([r.standing, r.why, r.delivered]).toEqual(['accepted (committed)', undefined, r.doc])
    expect(await accepts()).toEqual([])
  })

  test("a teammate's uncommitted file and a file the main session wrote are unverified", async () => {
    await writeRuleFile(w, 'project', ruleDoc('P-teammate', 'Squash before merging.'))
    await writeRuleFile(w, 'local', ruleDoc('L-written', 'Prefer small diffs.'))
    await writeRuleFile(w, 'user', ruleDoc('U-written', 'Answer in English.'))
    const { rules } = await load()
    expect(rules.map(r => [r.doc.id, r.standing, r.delivered, r.why])).toEqual([
      ['U-written', 'unverified', null, 'not accepted in the rules pane (a hand edit, a Write, or a copied file)'],
      ['P-teammate', 'unverified', null, "not committed, and not accepted in the rules pane (a teammate's uncommitted file, a Write, or a hand edit)"],
      ['L-written', 'unverified', null, 'not accepted in the rules pane (a hand edit, a Write, or a copied file)'],
    ])
  })

  test("a rule a node committed, inside a rule-commit range, is unverified with the node's name, until you commit it yourself", async () => {
    const from = (await w.git('rev-parse', 'HEAD')).trim()
    await writeRuleFile(w, 'project', ruleDoc('P-by-node', 'Skip the slow tests.'))
    const to = await commitAll('a node commits a rule')
    await appendLaunchRecord(w.p, w.litterDir, 'alpha', '20261003-120000', 'swarm.event', { kind: 'rule-commit', node: 'fixer', agentId: 'ag-1', from, to, files: ['.litter/rules/P-by-node.md'] })
    const r = await byId('P-by-node')
    expect([r.standing, r.delivered, r.why]).toEqual(['unverified', null, `committed by node fixer in ${to.slice(0, 7)}`])
    // Your own commit of it afterwards is outside the node's range.
    await writeRuleFile(w, 'project', ruleDoc('P-by-node', 'Never skip the slow tests.'))
    await commitAll('I reviewed it')
    expect((await byId('P-by-node')).standing).toBe('accepted (committed)')
  })

  test("a tampered launch ledger makes a committed rule unverified, since a node's commit can't be ruled out", async () => {
    await writeRuleFile(w, 'project', ruleDoc('P-unsure', 'Keep the lockfile.'))
    await commitAll()
    const head = (await w.git('rev-parse', 'HEAD')).trim()
    await appendLaunchRecord(w.p, w.litterDir, 'alpha', '20261003-120000', 'swarm.event', { kind: 'rule-commit', node: 'n', from: head, to: head, files: [] })
    await appendLaunchRecord(w.p, w.litterDir, 'alpha', '20261003-120000', 'swarm.event', { kind: 'question', node: 'n', text: 'x' })
    const dir = `${w.litterDir}/swarms/alpha/launches/20261003-120000/ledger`
    unlinkSync(`${dir}/${readdirSync(dir).sort().at(-1)}`)
    const r = await byId('P-unsure')
    expect(r.standing).toBe('unverified')
    expect(r.why).toBe("swarm alpha's launch 20261003-120000 has a tampered ledger at record 2, so a node's commit of it can't be ruled out")
  })

  test("a deleted committed rule leaves HEAD's version in force", async () => {
    const doc = ruleDoc('P-deleted', 'Keep migrations append-only.')
    const path = await writeRuleFile(w, 'project', doc)
    await commitAll()
    unlinkSync(path)
    const r = await byId('P-deleted')
    expect([r.standing, r.delivered?.body.rule, r.path]).toEqual(['unverified', 'Keep migrations append-only.', path])
    expect(r.why).toBe("deleted from the working tree; HEAD's version stays in force until the deletion is committed")
    await commitAll('deleted')
    expect((await load()).rules).toEqual([])
  })

  test("a file that doesn't parse is a problem; a committed one's HEAD version stays in force", async () => {
    await writeRuleFile(w, 'local', ruleDoc('L-broken', 'x'), '---\ntype: guideline\n---\n## Rule\nx\n')
    const doc = ruleDoc('P-committed', 'Keep it.')
    const path = await writeRuleFile(w, 'project', doc)
    await commitAll()
    writeFileSync(path, '## Rule\nno frontmatter\n')
    const { rules, problems } = await load()
    expect(problems).toEqual([`${path}: line 1: a rule file starts with a --- line, then its frontmatter`, `${w.dirs.local}/L-broken.md: line 2: type is rule or ban, not "guideline"`])
    expect(rules.map(r => [r.doc.id, r.standing, r.delivered?.version])).toEqual([['P-committed', 'unverified', 1]])
  })

  test('a file whose id, scope letter, version or status is wrong is unverified', async () => {
    await writeRuleFile(w, 'local', ruleDoc('L-status', 'a', { status: 'proposed' }))
    await writeRuleFile(w, 'local', ruleDoc('P-wrong-letter', 'b'))
    await w.p.fs.write(`${w.dirs.local}/L-named.md`, renderRule(ruleDoc('L-other', 'c')))
    const { rules } = await load()
    expect(rules.map(r => [r.doc.id, r.why])).toEqual([
      ['L-other', 'its id is L-other, and the file is L-named.md'],
      ['L-status', 'its status is proposed'],
      ['P-wrong-letter', 'P-wrong-letter is in the local folder, whose ids start with L-'],
    ])
    expect(rules.every(r => r.delivered === null)).toBe(true)
  })

  test('.history is never loaded, and a file that is not a rule name is a problem', async () => {
    mkdirSync(`${w.dirs.local}/.history`, { recursive: true })
    writeFileSync(`${w.dirs.local}/.history/L-old@1.md`, renderRule(ruleDoc('L-old', 'old')))
    writeFileSync(`${w.dirs.local}/notes.md`, 'not a rule')
    const { rules, problems } = await load()
    expect(rules).toEqual([])
    expect(problems).toEqual([`${w.dirs.local}/notes.md: not a rule file's name (<id>.md, with an id like P-keep-tests-near), so it isn't read`])
  })
})

describe('scopes (16.6; 12:1567)', () => {
  test('an override of a project rule is refused at accept, and ignored in a file', async () => {
    const draft = renderRule({ ...ruleDoc('', 'Use tabs.'), status: 'proposed', version: 0, overrides: 'P-spaces' })
    const ref = await propose(w, { rule: draft, doc: (parseRule(draft) as { doc: RuleDoc }).doc })
    expect(reason(await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope: 'local' }))).toBe(
      'it overrides project rule P-spaces; a local or user override of a project rule is refused, so change the project rule instead',
    )
    expect(reason(await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope: 'user' }))).toMatch(/^it overrides project rule P-spaces/)
    // A file that names one: the override is ignored, and said so.
    const path = await accepted('Use two spaces.', 'local')
    writeFileSync(path, readFileSync(path, 'utf8').replace('export: true', 'overrides: P-spaces\nexport: true'))
    expect((await load()).problems).toEqual([
      "L-use-two-spaces names project rule P-spaces in overrides; a local or user override of a project rule is refused, so it's ignored",
    ])
    // A committed project rule in force that names one: it stays in force, without the override.
    await writeRuleFile(w, 'project', ruleDoc('P-tabs', 'Use tabs.', { overrides: 'U-spaces' }))
    await commitAll()
    const r = await byId('P-tabs')
    expect([r.standing, r.doc.overrides, r.delivered?.overrides, r.delivered?.body.rule]).toEqual(['accepted (committed)', 'U-spaces', undefined, 'Use tabs.'])
    expect((await load()).problems).toContain('P-tabs is a project rule, and only a local rule may override one; its override of U-spaces is ignored')
  })

  test('a local override of a user rule is kept, for the run cards to show', async () => {
    await accepted('Answer tersely.', 'user')
    const overriding = async (rule: string) => {
      const draft = renderRule({ ...ruleDoc('', rule), status: 'proposed', version: 0, overrides: 'U-answer-tersely' })
      return propose(w, { rule: draft, doc: (parseRule(draft) as { doc: RuleDoc }).doc })
    }
    ok(await acceptRule(w.p, w.litterDir, { proposal: await overriding('Answer in full here.') }, { scope: 'local' }))
    const { rules, problems } = await load()
    expect(problems).toEqual([])
    expect(rules.find(r => r.scope === 'local')!.delivered!.overrides).toBe('U-answer-tersely')
    expect(rules.find(r => r.scope === 'user')!.delivered).not.toBeNull()
    // Only a local rule may override.
    expect(reason(await acceptRule(w.p, w.litterDir, { proposal: await overriding('Answer twice.') }, { scope: 'user' }))).toBe(
      'only a local rule may name a user rule in overrides, and this user rule names U-answer-tersely',
    )
  })

  test('one id in two scopes is reported', async () => {
    await accepted('Use the typed client.', 'user')
    await writeRuleFile(w, 'local', ruleDoc('U-use-the-typed-client', 'Use the typed client.'))
    const { problems } = await load()
    expect(problems).toContain('one id in two scopes: U-use-the-typed-client is in user and local')
  })

  // AE's selectForRun and selectForSpawn call loadRules on every run.start and spawn, and tier 2's default ports reject configDir.
  test("a config dir that can't be found means no user rules; the project and local ones load, and accept, all the same", async () => {
    await accepted('Rule for the user scope.', 'user')
    await accepted('Rule for the project scope.', 'project')
    await commitAll()
    await accepted('Rule for the local scope.', 'local')
    w.p.configDirValue = null
    const { rules, problems } = await load()
    expect(rules.map(r => [r.doc.id, r.standing, r.delivered === r.doc])).toEqual([
      ['P-rule-for-the-project-scope', 'accepted', true],
      ['L-rule-for-the-local-scope', 'accepted', true],
    ])
    expect(problems).toEqual(["your user rules aren't read: no config dir in tier 2 (set configDirValue)"])
    // Only the user scope is refused; the repository's steps go on.
    const local = await propose(w, { rule: 'Another local rule.' })
    expect(ok(await acceptRule(w.p, w.litterDir, { proposal: local }, { scope: 'local' })).path).toBe(`${w.dirs.local}/L-another-local-rule.md`)
    const mine = await propose(w, { rule: 'Answer tersely.' })
    expect(reason(await acceptRule(w.p, w.litterDir, { proposal: mine }, { scope: 'user' }))).toBe("there's no user scope: no config dir in tier 2 (set configDirValue)")
    expect((await proposalsOf(w.p, w.litterDir, { status: ['proposed'] })).map(v => v.body.rule)).toContain('Answer tersely.')
  })
})

describe('ids, .history and info/exclude', () => {
  test("the slug comes from the proposal's slug, else the Rule's first words, with -2, -3 on a collision", async () => {
    expect(slugOf('Remove a worktree only if a litter launch or run created it')).toBe('remove-a-worktree-only-if-a-litter')
    expect(slugOf('Ünïcode: déjà vu!')).toBe('unicode-deja-vu')
    expect(slugOf('!!!')).toBe('rule')
    expect(assignId('project', 'x', new Set(['P-x', 'P-x-2']))).toBe('P-x-3')
    expect(await accepted('Keep it short.', 'project')).toEndWith('/P-keep-it-short.md')
    const second = await accepted('Keep it short, please.', 'project', { slug: 'keep-it-short' })
    expect(second).toEndWith('/P-keep-it-short-2.md')
    // An id in .history is taken too.
    mkdirSync(`${w.dirs.project}/.history`, { recursive: true })
    writeFileSync(`${w.dirs.project}/.history/P-keep-it-short-3@1.md`, 'old')
    expect(await accepted('Keep it short, really.', 'project', { slug: 'keep-it-short' })).toEndWith('/P-keep-it-short-4.md')
    // A different scope's letter is a different id.
    expect(await accepted('Keep it short, for me.', 'local', { slug: 'keep-it-short' })).toEndWith('/L-keep-it-short.md')
  })

  test('/.litter.local/ goes into info/exclude the first time .litter.local/ is made, once', async () => {
    const exclude = `${w.repo}/.git/info/exclude`
    const before = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
    await accepted('First local rule.', 'local')
    await accepted('Second local rule.', 'local')
    const after = readFileSync(exclude, 'utf8')
    expect(after.startsWith(before)).toBe(true)
    expect(after.split('\n').filter(l => l === '/.litter.local/')).toHaveLength(1)
    expect(await w.git('status', '--porcelain', '--', '.litter.local')).toBe('')
  })

  test('a bare repository has no project or local scope', async () => {
    const bare = `${w.repo}-bare.git`
    mkdirSync(bare)
    await w.p.run(['git', 'init', '-q', '--bare', bare])
    const litterDir = `${bare}/litter`
    const p = w.p
    const ref = { store: 'repo' as const, seq: (await appendRuleRecord(p, litterDir, 'repo', 'rule.propose', { source: 'launcher' }, { rule: 'Tag releases.', source: 'user' })).seq }
    expect(reason(await acceptRule(p, litterDir, { proposal: ref }, { scope: 'project' }))).toBe('a bare repository has no project or local scope')
    expect(reason(await acceptRule(p, litterDir, { proposal: ref }, { scope: 'local' }))).toBe('a bare repository has no project or local scope')
    expect(ok(await acceptRule(p, litterDir, { proposal: ref }, { scope: 'user' })).path).toBe(`${w.dirs.user}/U-tag-releases.md`)
    expect((await loadRules(p, litterDir)).rules.map(r => r.scope)).toEqual(['user'])
  })
})

describe('accept', () => {
  test('previewAccept gives the exact file acceptRule writes, and writes nothing', async () => {
    const ref = await propose(w, { rule: 'Pin every action to a commit.', type: 'ban', paths: ['.github/**'], when: 'editing a workflow' })
    const preview = ok(await previewAccept(w.p, w.litterDir, { proposal: ref }, { scope: 'project' }))
    expect(existsSync(w.dirs.project)).toBe(false)
    expect((await readRuleLedger(w.p, w.litterDir, 'repo')).records.map(r => r.kind)).toEqual(['rule.propose'])
    const done = ok(await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope: 'project' }))
    expect(done.path).toBe(preview.path)
    expect(readFileSync(done.path!, 'utf8')).toBe(preview.text)
    expect(preview.text).toContain('type: ban\napplies:\n  paths: [.github/**]\n  when: editing a workflow\naccepted: { at: ')
  })

  test("the pane's scope, paths and type win over the proposal's; with no scope anywhere it's refused", async () => {
    const ref = await propose(w, { rule: 'Mock the clock in tests.', paths: ['src/**'] })
    expect(reason(await acceptRule(w.p, w.litterDir, { proposal: ref }))).toBe('choose a scope: user, project or local')
    expect(reason(await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope: 'local', paths: ['../x'] }))).toBe('"../x" isn\'t a path pattern litter takes: a .. segment')
    const path = ok(await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope: 'local', paths: ['tests/**'], type: 'ban' })).path!
    const doc = (parseRule(readFileSync(path, 'utf8')) as { doc: RuleDoc }).doc
    expect([doc.type, doc.applies.paths]).toEqual(['ban', ['tests/**']])
    expect(reason(await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope: 'local' }))).toBe('proposal repo:1 is accepted already')
  })

  test('a proposal identical to an accepted rule is refused', async () => {
    await accepted('Never commit secrets.', 'project')
    const ref = await propose(w, { rule: '  never COMMIT\nsecrets.  ' })
    expect(reason(await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope: 'local' }))).toBe("it's identical to P-never-commit-secrets@1, which is in force")
  })

  test('an edit is version + 1, the old version moves to .history, and unknown fields survive it (12:1572)', async () => {
    const draft = renderRule({ ...ruleDoc('', 'Log every retry.'), status: 'proposed', version: 0, extra: [['owner', ' jane'], ['ticket', ' OPS-7']] })
    const ref = await propose(w, { rule: draft, doc: (parseRule(draft) as { doc: RuleDoc }).doc })
    const path = ok(await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope: 'project' })).path!
    const v1 = readFileSync(path, 'utf8')
    const edit = await propose(w, { rule: 'Log every retry, with its attempt number.', edits: 'P-log-every-retry@1' })
    expect(ok(await acceptRule(w.p, w.litterDir, { proposal: edit })).path).toBe(path)
    expect(readFileSync(`${w.dirs.project}/.history/P-log-every-retry@1.md`, 'utf8')).toBe(v1)
    const r = await byId('P-log-every-retry')
    expect([r.standing, r.doc.version, r.doc.body.rule, r.doc.extra]).toEqual(['accepted', 2, 'Log every retry, with its attempt number.', [['owner', ' jane'], ['ticket', ' OPS-7']]])
    expect((await accepts()).map(a => [a.id, a.version])).toEqual([['P-log-every-retry', 1], ['P-log-every-retry', 2]])
    // An edit of a version that's no longer in force, or one that changes nothing, is refused.
    expect(reason(await acceptRule(w.p, w.litterDir, { proposal: await propose(w, { rule: 'x', edits: 'P-log-every-retry@1' }) }))).toBe(
      'the edit is of P-log-every-retry@1, and P-log-every-retry is at version 2 now; propose the edit again against that version',
    )
    expect(reason(await acceptRule(w.p, w.litterDir, { proposal: await propose(w, { rule: 'Log every retry, with its attempt number.', edits: 'P-log-every-retry@2' }) }))).toBe(
      'the edit changes nothing in P-log-every-retry@2',
    )
  })

  test('an unverified file accepted as it is becomes the next version of its id, keeping its unknown keys', async () => {
    const path = await accepted('Prefer composition.', 'local')
    writeFileSync(path, readFileSync(path, 'utf8').replace('Prefer composition.', 'Prefer composition over inheritance.').replace('export: true', 'export: true\nowner: me'))
    expect((await byId('L-prefer-composition')).standing).toBe('unverified')
    ok(await acceptRule(w.p, w.litterDir, { file: path }))
    const r = await byId('L-prefer-composition')
    expect([r.standing, r.doc.version, r.doc.extra]).toEqual(['accepted', 2, [['owner', ' me']]])
    expect(reason(await acceptRule(w.p, w.litterDir, { file: path }))).toBe(`${path} is accepted already`)
    expect(reason(await acceptRule(w.p, w.litterDir, { file: `${w.repo}/elsewhere/L-x.md` }))).toMatch(/isn't in a rule folder/)
  })
})

describe('retire and dismiss', () => {
  test('retire moves the file to .history and records rule.retire; nothing of it is in force after', async () => {
    const path = await accepted('Use the staging bucket.', 'local')
    const text = readFileSync(path, 'utf8')
    expect(ok(await retireRule(w.p, w.litterDir, { id: 'L-use-the-staging-bucket', version: 1 })).path).toBe(path)
    expect(existsSync(path)).toBe(false)
    expect(readFileSync(`${w.dirs.local}/.history/L-use-the-staging-bucket@1.md`, 'utf8')).toBe(text)
    const { records } = await readRuleLedger(w.p, w.litterDir, 'repo')
    expect(records.at(-1)!.body).toEqual({ id: 'L-use-the-staging-bucket', version: 1, via: 'ui' })
    expect((await load()).rules).toEqual([])
    expect((await proposalsOf(w.p, w.litterDir, {})).map(v => v.status)).toEqual(['retired'])
    expect(reason(await retireRule(w.p, w.litterDir, { id: 'L-use-the-staging-bucket', version: 1 }))).toBe("L-use-the-staging-bucket@1 isn't a rule in force")
  })

  test("a retired project rule's deletion is yours to commit; until then HEAD's version isn't in force", async () => {
    const path = await accepted('Tag every release.', 'project')
    await commitAll()
    expect(ok(await retireRule(w.p, w.litterDir, { id: 'P-tag-every-release', version: 1 })).path).toBe(path)
    expect((await w.git('status', '--porcelain', '--', '.litter')).split('\n')).toEqual([' D .litter/rules/P-tag-every-release.md', '?? .litter/rules/.history/', ''])
    const r = await byId('P-tag-every-release')
    expect([r.standing, r.delivered]).toEqual(['unverified', null])
    expect(r.why).toBe("deleted from the working tree, and retired in the rules pane (version 1); commit the file's deletion")
  })

  test('a dismissed text is never offered again, whatever its spacing and case (12:1573)', async () => {
    const first = await propose(w, { rule: 'Always rebase onto main.' })
    ok(await dismissRule(w.p, w.litterDir, first))
    const { records } = await readRuleLedger(w.p, w.litterDir, 'repo')
    expect(records.at(-1)!.body).toEqual({ proposal: first, folded: await sha256('always rebase onto main.'), via: 'ui' })
    const again = await propose(w, { rule: '  always   REBASE onto main.\n', source: 'critic', run: '20261003-x' })
    expect((await proposalsOf(w.p, w.litterDir, {})).map(v => [v.ref.seq, v.status])).toEqual([
      [1, 'dismissed'],
      [3, 'dismissed'],
    ])
    expect(await proposalsOf(w.p, w.litterDir, { status: ['proposed'] })).toEqual([])
    expect(reason(await acceptRule(w.p, w.litterDir, { proposal: again }, { scope: 'local' }))).toBe('proposal repo:3 is dismissed already')
    expect(reason(await dismissRule(w.p, w.litterDir, again))).toBe('proposal repo:3 is dismissed already')
  })
})

describe('proposals', () => {
  test("a run critic's proposal goes to the rules ledger once per tool_use_id and index", async () => {
    const by = { source: 'agent' as const, agentId: 'gc', agentType: 'litter:gate-critic' }
    const input = { run: '20261003-run', rule: 'Freeze the clock in tests.', source: 'critic' as const, by, index: 0, tool_use_id: 'tu1', gate: 'G1', verify_id: 'vf1' }
    await proposeFromCritic(w.p, w.litterDir, input)
    await proposeFromCritic(w.p, w.litterDir, input)
    await proposeFromCritic(w.p, w.litterDir, { ...input, index: 1, rule: 'Keep fixtures small.' })
    const { records } = await readRuleLedger(w.p, w.litterDir, 'repo')
    expect(records.map(r => [r.kind, r.by, r.body])).toEqual([
      ['rule.propose', by, { rule: 'Freeze the clock in tests.', source: 'critic', run: '20261003-run', index: 0, tool_use_id: 'tu1', gate: 'G1', verify_id: 'vf1' }],
      ['rule.propose', by, { rule: 'Keep fixtures small.', source: 'critic', run: '20261003-run', index: 1, tool_use_id: 'tu1', gate: 'G1', verify_id: 'vf1' }],
    ])
    expect((await proposalsOf(w.p, w.litterDir, { run: '20261003-run' })).map(v => v.status)).toEqual(['proposed', 'proposed'])
    expect(await proposalsOf(w.p, w.litterDir, { run: 'other' })).toEqual([])
  })

  test("a swarm critic's goes once per verify_id and index, with its swarm and round", async () => {
    const by = { source: 'agent' as const, agentId: 'crit-1', agentType: 'litter:sw-alpha-critic' }
    const input = { run: '20261003-run', rule: 'Call the server through its typed client.', source: 'critic' as const, by, index: 0, swarm: 'alpha', verify_id: 'vf9', round: 2 }
    await proposeFromCritic(w.p, w.litterDir, input)
    await proposeFromCritic(w.p, w.litterDir, input)
    await proposeFromCritic(w.p, w.litterDir, { ...input, verify_id: 'vf10', round: 3 })
    const found = await proposalsOf(w.p, w.litterDir, { swarm: 'alpha' })
    expect(found.map(v => [v.body.verify_id, v.body.round, v.body.swarm])).toEqual([
      ['vf9', 2, 'alpha'],
      ['vf10', 3, 'alpha'],
    ])
    await expect(proposeFromCritic(w.p, w.litterDir, { ...input, rule: 'x'.repeat(8 * 1024 + 1) })).rejects.toThrow('over 8192 bytes')
  })
})

describe('narrowPaths', () => {
  test('validates each pattern, then sorts and removes duplicates', () => {
    expect(narrowPaths(['src/b/**', 'src/a.ts', 'src/b/**'])).toEqual({ ok: true, paths: ['src/a.ts', 'src/b/**'] })
    expect(narrowPaths([])).toEqual({ ok: true, paths: [] })
    expect(narrowPaths(['ok', '/abs'])).toEqual({ ok: false, reason: '"/abs" isn\'t a path pattern litter takes: an absolute path' })
  })
})

describe('a scratch clone', () => {
  test("another machine's clone counts the project's rules accepted through their commit", async () => {
    await accepted('Review every migration.', 'project')
    await commitAll()
    const clone = `${w.repo}-clone`
    await w.p.run(['git', 'clone', '-q', w.repo, clone])
    // The clone has no rules ledger at all.
    const { rules } = await loadRules(w.p, `${clone}/.claude/litter`)
    expect(rules.find(r => r.scope === 'project')?.standing).toBe('accepted (committed)')
  })
})
