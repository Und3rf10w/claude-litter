// The rules store's tier-2 fixtures (WP-AD): a scratch repository whose
// primary checkout holds litterDir, a scratch config dir for user rules, a
// fake for AE's validPattern (a stub before the merge), and 16.2's example.

import { mkdirSync, realpathSync } from 'node:fs'
import type { ProposalRef, RuleDoc, RuleProposeBody, RuleScope } from '../../hooks/records/rules'
import { deps as formatDeps, renderRule } from '../../hooks/rules/format'
import { appendRuleRecord } from '../../hooks/rules/ledger'
import { localRulesDir, projectRulesDir, userRulesDir } from '../../hooks/layout'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

/** AE's rules, as far as these tests need them: no negation, absolute path, `..`, backslash or empty pattern. */
export const fakeValidPattern = (p: string): string | null =>
  p === ''
    ? 'an empty pattern'
    : p.startsWith('!')
      ? 'a negation'
      : p.startsWith('/')
        ? 'an absolute path'
        : p.split('/').includes('..')
          ? 'a .. segment'
          : p.includes('\\')
            ? 'a backslash'
            : null

/** Puts the fake in place; the returned function restores AE's own. */
export function fakePatterns(): () => void {
  const real = formatDeps.validPattern
  formatDeps.validPattern = fakeValidPattern
  return () => {
    formatDeps.validPattern = real
  }
}

/** 16.2's example, as the plan has it. */
export const EXAMPLE = [
  '---',
  'id: P-worktree-cleanup',
  'version: 2',
  'status: accepted',
  'type: rule',
  'applies:',
  '  paths: [plugins/litter/hooks/worktrees.ts, plugins/litter/hooks/swarm/end.ts]',
  '  workflows: [execute, fanout, swarm]',
  '  when: removing a worktree or deleting a branch',
  'accepted: { at: 2026-10-01, commit: 3f2c1a9, via: ui }',
  'export: true',
  '---',
  '',
  '## Rule',
  'Remove a worktree only if a litter launch or run created it and recorded it, and only when it holds no ignored files beyond those its setup left. Keep and list anything else; never force it.',
  '',
  '## Why',
  'A worktree you made yourself can hold ignored files (`.env`) that an unforced `git worktree remove` deletes without a warning.',
  '',
  '## Exceptions',
  "- A prober's disposable worktree is force-removed after its branch is checked for commits (section 9).",
  '',
  '## How to check',
  '- A swarm node on an `existing` worktree ends: the worktree is still there, and listed.',
  '- A recorded worktree holding a new ignored `.env` is kept, and the listing names the file.',
  '',
].join('\n')

export type RulesWorld = {
  p: TestPorts
  /** The primary checkout, real path. */
  repo: string
  litterDir: string
  config: string
  git: (...argv: string[]) => Promise<string>
  dirs: Record<RuleScope, string>
  cleanup: () => void
}

/** A scratch repository with one commit, its litterDir, and a config dir the user scope lives in. */
export async function rulesWorld(): Promise<RulesWorld> {
  const p = nodePorts()
  const s = scratch('litter-rules-')
  const root = realpathSync(s.dir)
  const repo = `${root}/repo`
  mkdirSync(repo, { recursive: true })
  const { git } = await scratchRepo(p, repo)
  const config = `${root}/config`
  p.configDirValue = config
  const litterDir = `${repo}/.claude/litter`
  return {
    p,
    repo,
    litterDir,
    config,
    git,
    dirs: { user: userRulesDir(config), project: projectRulesDir(repo), local: localRulesDir(repo) },
    cleanup: s.cleanup,
  }
}

/** A rule doc in force, as the mod writes one. */
export function ruleDoc(id: string, rule: string, more: Partial<RuleDoc> = {}): RuleDoc {
  return {
    id,
    version: 1,
    status: 'accepted',
    type: 'rule',
    applies: { paths: [], when: 'changing anything' },
    accepted: { at: '2026-10-03', via: 'ui' },
    export: true,
    extra: [],
    body: { rule, why: '', exceptions: [], howToCheck: [] },
    ...more,
  }
}

/** Writes a rule file straight into a scope's folder, as a hand or a Write would; answers its path. */
export async function writeRuleFile(w: RulesWorld, scope: RuleScope, doc: RuleDoc, text = renderRule(doc)): Promise<string> {
  const path = `${w.dirs[scope]}/${doc.id}.md`
  await w.p.fs.write(path, text)
  return path
}

/** A proposal in the repository's rules ledger, as the record tool or a critic makes one. */
export async function propose(w: RulesWorld, body: Partial<RuleProposeBody> & { rule: string }): Promise<ProposalRef> {
  const rec = await appendRuleRecord(w.p, w.litterDir, 'repo', 'rule.propose', { source: 'launcher' }, { source: 'user', ...body })
  return { store: 'repo', seq: rec.seq }
}
