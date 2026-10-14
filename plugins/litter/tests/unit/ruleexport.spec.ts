// Tier 2: rules exported as Claude Code rule files (plan 16.7, phase 6;
// hooks/rules/export.ts), in scratch repositories: the file, with `paths:`
// from its applies and none for a ban; each scope's folder and its
// `rule.export` record; a hand edit never overwritten, adopted as the next
// version or put back; a deletion kept until a new version; a retired rule's
// untouched file removed and an edited one kept; a teammate's committed copy;
// the worktrees whose copy differs; claudeMdExcludes; and nothing on Codex.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import type { RuleDoc, RuleExportBody, RuleProposeBody, RuleScope } from '../../hooks/records/rules'
import { sha256 } from '../../hooks/fsx'
import { renderRule } from '../../hooks/rules/format'
import { readRuleLedger } from '../../hooks/rules/ledger'
import { acceptRule, loadRules, proposalsOf, retireRule } from '../../hooks/rules/store'
import { adoptExport, exportFooter, exportsOf, parseExport, renderExport, restoreExport, syncExports } from '../../hooks/rules/export'
import { updateSession } from '../../hooks/session'
import { fakePatterns, propose, ruleDoc, rulesWorld, writeRuleFile, type RulesWorld } from './rules-harness'

let w: RulesWorld
let restorePatterns: () => void
beforeEach(async () => {
  restorePatterns = fakePatterns()
  w = await rulesWorld()
})
afterEach(() => {
  restorePatterns()
  updateSession({ host: 'claude-code' })
  w.cleanup()
})

const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r)}`)
  return r as Extract<T, { ok: true }>
}
const reason = (r: { ok: boolean; reason?: string }): string => {
  if (r.ok) throw new Error('done, and should have been refused')
  return r.reason!
}

const exportPath = (scope: RuleScope, id: string): string =>
  scope === 'user' ? `${w.config}/rules/litter/${id}.md` : `${w.repo}/.claude/rules/${scope === 'project' ? 'litter' : 'litter-local'}/${id}.md`

/** The version in force of `id`. */
async function inForce(id: string): Promise<RuleDoc> {
  const r = (await loadRules(w.p, w.litterDir)).rules.find(x => x.doc.id === id && x.delivered)
  if (!r) throw new Error(`${id} isn't in force`)
  return r.delivered!
}

/** Proposes and accepts a rule, answering its id. */
async function accepted(rule: string, scope: RuleScope, more: Partial<RuleProposeBody> = {}): Promise<string> {
  const ref = await propose(w, { rule, ...more })
  const path = ok(await acceptRule(w.p, w.litterDir, { proposal: ref }, { scope })).path!
  return path.slice(path.lastIndexOf('/') + 1, -'.md'.length)
}

/** An accepted edit of `id@version`: its next version. */
async function edited(id: string, version: number, rule: string, more: Partial<RuleProposeBody> = {}): Promise<void> {
  const ref = await propose(w, { rule, edits: `${id}@${version}`, ...more })
  ok(await acceptRule(w.p, w.litterDir, { proposal: ref }, {}))
}

const exportRecords = async (store: 'repo' | 'user' = 'repo') =>
  (await readRuleLedger(w.p, w.litterDir, store)).records.filter(r => r.kind === 'rule.export').map(r => r.body as RuleExportBody)
const viewOf = async (id: string) => (await exportsOf(w.p, w.litterDir, { id })).views[0]!

describe('the file', () => {
  const doc = ruleDoc('P-validate-bodies', 'Validate every request body before it reaches a handler.', {
    applies: { paths: ['src/{api,web}/**', 'lib/parse.ts'], when: 'changing a request handler' },
    body: { rule: 'Validate every request body before it reaches a handler.', why: 'A bad body\ncrashed the worker twice.', exceptions: ['Health checks take no body.'], howToCheck: ['Send an empty body.'] },
  })

  test('a rule with paths gets them as frontmatter, brace sets expanded, then the rule, its exceptions, a one-line why and the footer', () => {
    expect(renderExport(doc, 'project')).toBe(
      [
        '---',
        'paths:',
        '  - "src/api/**"',
        '  - "src/web/**"',
        '  - "lib/parse.ts"',
        '---',
        '',
        '## Rule',
        'Validate every request body before it reaches a handler.',
        '',
        'Applies when: changing a request handler',
        '',
        '## Exceptions',
        '- Health checks take no body.',
        '',
        '## Why',
        'A bad body crashed the worker twice.',
        '',
        'Managed by litter (P-validate-bodies v1). Change it with /litter:rules or in the rules pane (/litter rules); an edit made here shows there, so you can adopt it.',
        '',
      ].join('\n'),
    )
    // No paths, or only `**`: no frontmatter, so Claude Code loads it from a session's start.
    for (const paths of [[], ['**']]) expect(renderExport({ ...doc, applies: { ...doc.applies, paths } }, 'project').startsWith('## Rule\n')).toBe(true)
  })

  test("a ban has no frontmatter, since it must hold for writes, and names what it protects; a local override names the user rule", () => {
    const ban = ruleDoc('L-keep-vendor', 'Never edit vendored code.', { type: 'ban', applies: { paths: ['vendor/**'], when: '' }, overrides: 'U-keep-vendor' })
    expect(renderExport(ban, 'local')).toBe(
      ['## Ban', 'Never edit vendored code.', '', 'It protects: vendor/**', 'In this repository it replaces your user rule U-keep-vendor.', '', exportFooter('L-keep-vendor', 1), ''].join('\n'),
    )
  })

  test('reads back as the rule it was written from, and an edit as the edited rule', () => {
    const doc2 = { ...doc, extra: [['owner', ' platform']] as [string, string][] }
    expect(renderRule(parseExport(renderExport(doc2, 'project'), doc2))).toBe(renderRule(doc2))
    const text = renderExport(doc2, 'project')
      .replace('Validate every request body', 'Validate and size-check every request body')
      .replace('- Health checks take no body.', '- Health checks take no body.\n- Webhooks are validated by their signer.')
      .replace('  - "src/web/**"\n', '')
    const back = parseExport(text, doc2)
    expect(back.body.rule).toBe('Validate and size-check every request body before it reaches a handler.')
    expect(back.body.exceptions).toEqual(['Health checks take no body.', 'Webhooks are validated by their signer.'])
    expect(back.applies.paths).toEqual(['src/api/**', 'lib/parse.ts'])
    // What the file never held is the base's.
    expect([back.body.howToCheck, back.extra, back.body.why, back.applies.when]).toEqual([doc2.body.howToCheck, doc2.extra, doc2.body.why, doc2.applies.when])
    // A heading turned to Ban makes it a ban, with the paths it names.
    const ban = parseExport('## Ban\nNever touch the lockfile.\n\nIt protects: package-lock.json, yarn.lock\n', doc2)
    expect([ban.type, ban.body.rule, ban.applies.paths]).toEqual(['ban', 'Never touch the lockfile.', ['package-lock.json', 'yarn.lock']])
  })
})

describe('the sync', () => {
  test("writes each scope's file, records it with its sha256, and adds the local folder to info/exclude; a second sync changes nothing", async () => {
    const ids = { user: await accepted('Answer in plain words.', 'user'), project: await accepted('Keep fixtures small.', 'project'), local: await accepted('Log every retry.', 'local') }
    const r = await syncExports(w.p, w.litterDir)
    expect(r).toEqual({ written: (['user', 'project', 'local'] as const).map(s => exportPath(s, ids[s])), removed: [], recorded: 0, problems: [] })
    for (const scope of ['user', 'project', 'local'] as const) {
      const text = readFileSync(exportPath(scope, ids[scope]), 'utf8')
      expect(text).toBe(renderExport(await inForce(ids[scope]), scope))
    }
    expect(await exportRecords('user')).toEqual([{ id: ids.user, version: 1, scope: 'user', path: exportPath('user', ids.user), sha256: await sha256(readFileSync(exportPath('user', ids.user), 'utf8')), via: 'mod' }])
    expect((await exportRecords('repo')).map(b => [b.id, b.scope])).toEqual([
      [ids.project, 'project'],
      [ids.local, 'local'],
    ])
    expect(readFileSync(`${w.repo}/.git/info/exclude`, 'utf8').split('\n')).toContain('/.claude/rules/litter-local/')
    expect(await syncExports(w.p, w.litterDir)).toEqual({ written: [], removed: [], recorded: 0, problems: [] })
    expect((await exportsOf(w.p, w.litterDir)).views.map(v => [v.id, v.state, v.bindsAfterRead])).toEqual([
      [ids.user, 'exported', false],
      [ids.project, 'exported', false],
      [ids.local, 'exported', false],
    ])
  })

  test("an accepted rule with paths binds after a Read; a ban with paths doesn't", async () => {
    const rule = await accepted('Validate every request body.', 'project', { paths: ['src/api/**'] })
    const ban = await accepted('Never edit vendored code.', 'project', { type: 'ban', paths: ['vendor/**'] })
    await syncExports(w.p, w.litterDir)
    expect(readFileSync(exportPath('project', rule), 'utf8').startsWith('---\npaths:\n  - "src/api/**"\n---\n')).toBe(true)
    expect(readFileSync(exportPath('project', ban), 'utf8')).toContain('It protects: vendor/**')
    expect([(await viewOf(rule)).bindsAfterRead, (await viewOf(ban)).bindsAfterRead]).toEqual([true, false])
  })

  test("a hand edit isn't overwritten when the rule is edited, and shows; adopted and accepted, the next sync writes that version", async () => {
    const id = await accepted('Keep fixtures small.', 'project')
    await syncExports(w.p, w.litterDir)
    const path = exportPath('project', id)
    const hand = readFileSync(path, 'utf8').replace('Keep fixtures small.', 'Keep fixtures small, and name them after what they hold.')
    writeFileSync(path, hand)
    await edited(id, 1, 'Keep fixtures under 1 KiB.')
    expect((await syncExports(w.p, w.litterDir)).written).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(hand)
    const v = await viewOf(id)
    expect([v.version, v.state, v.actual, v.expected]).toEqual([2, 'edited', hand, renderExport(await inForce(id), 'project')])

    const ref = ok(await adoptExport(w.p, w.litterDir, { id, version: 2 })).proposal
    const proposal = (await proposalsOf(w.p, w.litterDir, {})).find(x => x.ref.seq === ref.seq)!
    expect(proposal.body).toEqual(
      expect.objectContaining({ source: 'export', edits: `${id}@2`, rule: 'Keep fixtures small, and name them after what they hold.', fromExport: { path, sha256: await sha256(hand) } }),
    )
    expect(reason(await adoptExport(w.p, w.litterDir, { id, version: 2 }))).toBe(`this edit is proposed already (repo:${ref.seq}): it's on the Proposed tab`)
    expect((await viewOf(id)).adoption).toEqual({ proposal: ref, status: 'proposed' })
    ok(await acceptRule(w.p, w.litterDir, { proposal: ref }, {}))
    expect((await syncExports(w.p, w.litterDir)).written).toEqual([path])
    const v3 = await inForce(id)
    expect([v3.version, v3.body.rule]).toEqual([3, 'Keep fixtures small, and name them after what they hold.'])
    expect(readFileSync(path, 'utf8')).toBe(renderExport(v3, 'project'))
  })

  test("an edit of the layout alone isn't adopted, and Restore file puts litter's copy back, keeping the edit", async () => {
    const id = await accepted('Keep fixtures small.', 'local')
    await syncExports(w.p, w.litterDir)
    const path = exportPath('local', id)
    const expected = readFileSync(path, 'utf8')
    writeFileSync(path, expected.replace('## Rule\n', '## Rule\n\n'))
    expect(reason(await adoptExport(w.p, w.litterDir, { id, version: 1 }))).toBe(`the edit changes nothing ${id}@1 holds (only the file's layout); Restore file puts litter's copy back`)
    const done = ok(await restoreExport(w.p, w.litterDir, { id, version: 1 }))
    expect(readFileSync(path, 'utf8')).toBe(expected)
    expect(done.kept).toStartWith(`${w.litterDir}/rules-ledger/export-edits/${id}@1-`)
    expect(readFileSync(done.kept!, 'utf8')).toBe(expected.replace('## Rule\n', '## Rule\n\n'))
    expect((await viewOf(id)).state).toBe('exported')
    expect(reason(await restoreExport(w.p, w.litterDir, { id, version: 1 }))).toBe(`${path} is litter's copy already`)
  })

  test("a deleted file isn't written again for the same version; Restore file writes it now, and a new version does", async () => {
    const id = await accepted('Keep fixtures small.', 'project')
    await syncExports(w.p, w.litterDir)
    const path = exportPath('project', id)
    unlinkSync(path)
    expect((await syncExports(w.p, w.litterDir)).written).toEqual([])
    expect((await viewOf(id)).state).toBe('deleted')
    expect(ok(await restoreExport(w.p, w.litterDir, { id, version: 1 })).kept).toBeNull()
    expect(existsSync(path)).toBe(true)
    unlinkSync(path)
    await edited(id, 1, 'Keep fixtures under 1 KiB.')
    expect((await syncExports(w.p, w.litterDir)).written).toEqual([path])
    expect(readFileSync(path, 'utf8')).toContain('Keep fixtures under 1 KiB.')
  })

  test("retiring a rule deletes its untouched file, recording the removal, and keeps an edited one, naming it", async () => {
    const a = await accepted('Keep fixtures small.', 'project')
    const b = await accepted('Name branches after their ticket.', 'project')
    await syncExports(w.p, w.litterDir)
    writeFileSync(exportPath('project', b), `${readFileSync(exportPath('project', b), 'utf8')}\nAnd keep them short.\n`)
    ok(await retireRule(w.p, w.litterDir, { id: a, version: 1 }))
    ok(await retireRule(w.p, w.litterDir, { id: b, version: 1 }))
    expect(await syncExports(w.p, w.litterDir)).toEqual({ written: [], removed: [exportPath('project', a)], recorded: 0, problems: [] })
    expect(existsSync(exportPath('project', a))).toBe(false)
    expect(existsSync(exportPath('project', b))).toBe(true)
    expect((await exportRecords()).at(-1)).toEqual({ id: a, version: 1, scope: 'project', path: exportPath('project', a), sha256: null, via: 'mod' })
    expect((await exportsOf(w.p, w.litterDir)).problems).toEqual([
      `${exportPath('project', b)}: a rule file for ${b} that litter didn't write (a hand edit), and ${b} isn't exported now; litter leaves it, so delete it if it's stale`,
    ])
  })

  test("export: false and a rule narrowed to litter's workflows aren't exported, and the file of one that was is removed", async () => {
    const id = await accepted('Keep fixtures small.', 'project')
    await syncExports(w.p, w.litterDir)
    await edited(id, 1, 'Keep fixtures small.', { doc: { ...ruleDoc('', 'Keep fixtures small.'), export: false } as RuleDoc })
    expect((await syncExports(w.p, w.litterDir)).removed).toEqual([exportPath('project', id)])
    expect((await viewOf(id)).state).toBe('off')
    const narrowed = await accepted('Squash before landing.', 'project', { doc: { ...ruleDoc('', 'Squash before landing.'), applies: { paths: [], workflows: ['execute'], when: '' } } as RuleDoc })
    expect((await syncExports(w.p, w.litterDir)).written).toEqual([])
    expect([(await viewOf(narrowed)).state, existsSync(exportPath('project', narrowed))]).toEqual(['litter-only', false])
  })

  test("a teammate's committed export, with no record here, is litter's copy; an older version's is rewritten", async () => {
    await writeRuleFile(w, 'project', ruleDoc('P-team', 'Name fixtures plainly.'))
    const v1 = ruleDoc('P-old', 'Run tier 1 first.')
    await writeRuleFile(w, 'project', v1)
    await w.git('add', '-A', '--', '.litter')
    await w.git('commit', '-q', '-m', 'rules')
    // P-old moves on to version 2, its version 1 in .history, as an accepted edit leaves it.
    mkdirSync(`${w.dirs.project}/.history`, { recursive: true })
    writeFileSync(`${w.dirs.project}/.history/P-old@1.md`, renderRule(v1))
    await writeRuleFile(w, 'project', { ...v1, version: 2, body: { ...v1.body, rule: 'Run tier 1, then tier 2.' } })
    await w.git('add', '-A', '--', '.litter')
    await w.git('commit', '-q', '-m', 'P-old v2')
    mkdirSync(`${w.repo}/.claude/rules/litter`, { recursive: true })
    writeFileSync(exportPath('project', 'P-team'), renderExport(await inForce('P-team'), 'project'))
    writeFileSync(exportPath('project', 'P-old'), renderExport(v1, 'project'))
    const r = await syncExports(w.p, w.litterDir)
    expect([r.written, r.recorded]).toEqual([[exportPath('project', 'P-old')], 1])
    expect(readFileSync(exportPath('project', 'P-old'), 'utf8')).toContain('Run tier 1, then tier 2.')
    expect((await exportRecords()).map(b => [b.id, b.version])).toEqual([
      ['P-old', 2],
      ['P-team', 1],
    ])
  })

  test('a project export names the worktrees whose copy differs, and the claudeMdExcludes pattern that drops it', async () => {
    const id = await accepted('Keep fixtures small.', 'project')
    await syncExports(w.p, w.litterDir)
    await w.git('add', '-A', '--', '.litter', '.claude/rules')
    await w.git('commit', '-q', '-m', 'rules')
    await w.git('worktree', 'add', '-q', '--detach', '.claude/worktrees/wt-a', 'HEAD')
    expect((await exportsOf(w.p, w.litterDir, { id, worktrees: true })).views[0]!.staleIn).toEqual([])
    await edited(id, 1, 'Keep fixtures under 1 KiB.')
    await syncExports(w.p, w.litterDir)
    expect((await exportsOf(w.p, w.litterDir, { id, worktrees: true })).views[0]!.staleIn).toEqual(['wt-a'])
    w.p.settingsValue.claudeMdExcludes = ['/elsewhere/**', '**/.claude/rules/litter/**']
    expect((await exportsOf(w.p, w.litterDir, { id, settings: true })).views[0]!.excludedBy).toBe('**/.claude/rules/litter/**')
  })

  test('on Codex nothing is exported, and nothing is removed', async () => {
    const id = await accepted('Keep fixtures small.', 'project')
    const other = await accepted('Name branches after their ticket.', 'project')
    await syncExports(w.p, w.litterDir)
    ok(await retireRule(w.p, w.litterDir, { id, version: 1 }))
    unlinkSync(exportPath('project', other))
    updateSession({ host: 'codex' })
    expect(await syncExports(w.p, w.litterDir)).toEqual({ written: [], removed: [], recorded: 0, problems: [] })
    expect(existsSync(exportPath('project', id))).toBe(true)
    expect((await viewOf(other)).state).toBe('none')
    updateSession({ host: 'claude-code' })
    expect((await syncExports(w.p, w.litterDir)).removed).toEqual([exportPath('project', id)])
  })

  test("a file in litter's folder that isn't a rule file's name is reported and left", async () => {
    mkdirSync(`${w.repo}/.claude/rules/litter`, { recursive: true })
    writeFileSync(`${w.repo}/.claude/rules/litter/notes.md`, 'mine\n')
    expect((await syncExports(w.p, w.litterDir)).removed).toEqual([])
    expect((await exportsOf(w.p, w.litterDir)).problems).toEqual([
      `${w.repo}/.claude/rules/litter/notes.md: not a litter rule file's name (<id>.md), so litter leaves it; Claude Code loads it as a rule all the same`,
    ])
    expect(readdirSync(`${w.repo}/.claude/rules/litter`)).toEqual(['notes.md'])
  })
})
