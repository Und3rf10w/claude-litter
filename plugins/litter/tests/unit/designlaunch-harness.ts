// The design launch's tier-2 fixtures (WP-BD): rules-harness's scratch
// repository, with rules in the three scopes, made ready for run.start (the
// session's checkout, a jq that answers, the permission mode); a bar with
// the minimum decision 5 takes; and accepted rules written as the pane
// writes them.

import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordCtx, RecordInput, RecordReply } from '../../hooks/records/core'
import type { BarItem, RunJson, RunStartReply } from '../../hooks/records/run'
import type { RuleDoc, RuleScope } from '../../hooks/records/rules'
import { recordRunStart } from '../../hooks/lifecycle'
import { modePath, runJsonPath, RUN_ID } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { readLock } from '../../hooks/lock'
import { updateSession } from '../../hooks/session'
import { acceptRule } from '../../hooks/rules/store'
import { parseRule } from '../../hooks/rules/format'
import { ruleDoc, rulesWorld, writeRuleFile, type RulesWorld } from './rules-harness'
import type { TestPorts } from './support/node-ports'

/** Six criteria and a ban of yours: decision 5's minimum. */
export const BAR: BarItem[] = [
  { id: 'C1', text: 'retries once', evidence: 'a test' },
  { id: 'C2', text: 'keeps the timeout', evidence: 'the config' },
  { id: 'C3', text: 'logs each retry', evidence: 'a log line' },
  { id: 'C4', text: 'needs no new dependency', evidence: 'package.json' },
  { id: 'C5', text: 'reads the retry count from the options', evidence: 'options.ts' },
  { id: 'C6', text: 'keeps the public API', evidence: 'the exports' },
  { id: 'B1', text: 'no sleep in tests', evidence: 'grep', reason: 'flaky' },
]

/** `criteria` criteria, then `bans` bans. */
export function barOf(criteria: number, bans = 1): BarItem[] {
  return [
    ...Array.from({ length: criteria }, (_, i) => ({ id: `C${i + 1}`, text: `criterion ${i + 1}`, evidence: `evidence ${i + 1}` })),
    ...Array.from({ length: bans }, (_, i) => ({ id: `B${i + 1}`, text: `ban ${i + 1}`, evidence: 'grep', reason: 'it broke once' })),
  ]
}

export type LaunchWorld = RulesWorld & { ctx: RecordCtx }

/** rules-harness's world, ready for run.start: run.start runs real git in it, as the session's checkout. */
export async function launchWorld(options: Record<string, unknown> = {}): Promise<LaunchWorld> {
  const w = await rulesWorld()
  const base = w.p
  const p: TestPorts = {
    ...base,
    cwd: async () => w.repo,
    run: (argv, init) =>
      argv[0] === 'jq' ? Promise.resolve({ code: 0, stdout: 'jq-1.7.1\n', stderr: '', truncated: false }) : base.run(argv, init?.cwd ? init : { ...init, cwd: w.repo }),
  }
  await p.fs.write(modePath(w.litterDir), 'default\n')
  updateSession({ litterDir: w.litterDir })
  return { ...w, p, ctx: { p, caller: { agentId: null, agentType: null }, litterDir: w.litterDir, options: normalizeOptions(options) } }
}

export const AUTH = { authorized: ['read the retry code'] }

/** A design's run.start through the record handler, with the bar above unless `extra` gives one. */
export const startDesign = (w: LaunchWorld, extra: Record<string, unknown> = {}): Promise<RecordReply> =>
  recordRunStart(w.ctx, { kind: 'run.start', workflow: 'design', ...AUTH, goal: 'design the retry', deliverable: 'plan', bar: BAR, ...extra } as RecordInput)

export function okReply(r: RecordReply): RunStartReply {
  if (!r.ok) throw new Error(`run.start refused: ${JSON.stringify(r)}`)
  return r as RunStartReply
}

export const runJsonOf = async (w: LaunchWorld, r: RunStartReply): Promise<RunJson> => JSON.parse(await w.p.fs.read(runJsonPath(r.runDir))) as RunJson

/** The run folders under litterDir. */
export const runsIn = (w: LaunchWorld): string[] => (existsSync(w.litterDir) ? readdirSync(w.litterDir).filter(n => RUN_ID.test(n)).sort() : [])

/** A refusal before step 3: no run folder but `kept`, no lock, no litter ref. */
export async function nothingWritten(w: LaunchWorld, kept: string[] = []): Promise<void> {
  if (JSON.stringify(runsIn(w)) !== JSON.stringify([...kept].sort())) throw new Error(`run folders: ${runsIn(w).join(', ')}`)
  if ((await readLock(w.p, w.repo)) !== null) throw new Error('the run lock is held')
  const refs = (await w.git('for-each-ref', '--format=%(refname)', 'refs/heads/litter', 'refs/litter')).trim()
  if (refs !== '') throw new Error(`litter refs: ${refs}`)
}

/**
 * A rule file in `scope`'s folder, accepted from the pane as it is (16.4),
 * at `doc.version`: the pane accepts an unverified file as the next version
 * of its id, so the file is written one below. Answers the doc in force.
 */
export async function acceptedRule(w: LaunchWorld, scope: RuleScope, doc: RuleDoc): Promise<RuleDoc> {
  const path = await writeRuleFile(w, scope, { ...doc, version: doc.version - 1, status: 'proposed' })
  const r = await acceptRule(w.p, w.litterDir, { file: path })
  if (!r.ok) throw new Error(`not accepted: ${r.reason}`)
  const parsed = parseRule(await w.p.fs.read(path))
  if (!parsed.ok || parsed.doc.version !== doc.version) throw new Error(`${doc.id} was accepted as ${parsed.ok ? `version ${parsed.doc.version}` : 'a file that does not parse'}`)
  return parsed.doc
}

/** A rule doc with the fields these specs vary. */
export function rule(id: string, text: string, more: { type?: 'rule' | 'ban'; paths?: string[]; workflows?: string[]; roles?: string[]; why?: string; howToCheck?: string[]; version?: number } = {}): RuleDoc {
  return ruleDoc(id, text, {
    version: more.version ?? 1,
    type: more.type ?? 'rule',
    applies: {
      paths: more.paths ?? [],
      ...(more.workflows ? { workflows: more.workflows } : {}),
      ...(more.roles ? { roles: more.roles } : {}),
      when: `working near ${id}`,
    },
    body: { rule: text, why: more.why ?? '', exceptions: [], howToCheck: more.howToCheck ?? [] },
  })
}

/** A file in the scratch repository, committed when `commit` is set. */
export async function repoFile(w: LaunchWorld, rel: string, text = 'x\n', commit = true): Promise<string> {
  const path = join(realpathSync(w.repo), rel)
  await w.p.fs.write(path, text)
  if (commit) {
    await w.git('add', '--', rel)
    await w.git('commit', '-q', '-m', `add ${rel}`)
  }
  return path
}
