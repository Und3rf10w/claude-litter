// litterDir: `<primary checkout>/.claude/litter`, resolved once per session
// from git's own answers (plan section 10, "One litter directory"). Also the
// read-only `run.find` record. Owner: phase 1b, work package B.
//
// Every git call here is a fixed argv run with `cwd` set; nothing in it comes
// from a model or the repository except paths git itself printed, and those
// only ever go to `cwd` or $.fs (section 9, "Mod safety").

import type { Ports } from './ports'
import type { RecordHandler } from './records/core'
import type { RunJson, Workflow } from './records/run'
import { fail } from './records/core'
import { hooksDir, pointerPath, RUN_ID, runDir, runJsonPath } from './layout'
import { atomicWrite, readJson } from './fsx'
import { readLedger } from './ledgercore'

export type LitterDirResult = { ok: true; litterDir: string; primary: string | null; commonDir: string } | { ok: false; error: string }

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** The path with every link resolved, or null when it leads nowhere. */
async function real(p: Ports, path: string): Promise<string | null> {
  try {
    return (await p.fs.stat(path, { resolve: true })).realPath ?? null
  } catch {
    return null
  }
}

/** `git <argv>` in `cwd`: its stdout lines, or null when it exits non-zero or can't start. */
async function git(p: Ports, cwd: string, argv: readonly string[]): Promise<string[] | null> {
  try {
    const r = await p.run(['git', ...argv], { cwd })
    return r.code === 0 ? r.stdout.split('\n').filter(l => l !== '') : null
  } catch {
    return null
  }
}

/** One key of the common dir's own config file (not the worktree's), or null when unset. */
async function commonConfig(p: Ports, commonDir: string, key: string, bool = false): Promise<string | null> {
  const out = await git(p, commonDir, ['config', '--file', `${commonDir}/config`, ...(bool ? ['--bool'] : []), '--get', key])
  return out?.[0] ?? null
}

/** `<dir>/<rel>` with `.` and `..` folded; `rel` absolute is taken as it is. */
function resolvePath(dir: string, rel: string): string {
  const parts = rel.startsWith('/') ? [] : dir.split('/').filter(Boolean)
  for (const part of rel.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** `git worktree list --porcelain`, as entries in git's order. */
async function worktreeList(p: Ports, cwd: string): Promise<{ path: string; branch: string | null; bare: boolean }[] | null> {
  const out = await git(p, cwd, ['worktree', 'list', '--porcelain'])
  if (!out) return null
  const list: { path: string; branch: string | null; bare: boolean }[] = []
  for (const line of out) {
    if (line.startsWith('worktree ')) list.push({ path: line.slice('worktree '.length), branch: null, bare: false })
    else if (list.length > 0 && line.startsWith('branch ')) list[list.length - 1]!.branch = line.slice('branch '.length)
    else if (list.length > 0 && line === 'bare') list[list.length - 1]!.bare = true
  }
  return list
}

/**
 * A candidate primary counts only as a directory whose top level is itself
 * and whose git dir and common dir are both this repository's common dir
 * (step 3), so a stale or forged litter-primary fails here.
 */
async function verifyPrimary(p: Ports, candidate: string, commonDir: string): Promise<string | null> {
  if (!candidate.startsWith('/')) return null
  const dir = await real(p, candidate)
  if (!dir || (await p.fs.stat(dir).catch(() => null))?.kind !== 'dir') return null
  const out = await git(p, dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'])
  if (!out || out.length !== 3) return null
  const [top, gitDir, common] = await Promise.all(out.map(o => real(p, o)))
  return top === dir && gitDir === commonDir && common === commonDir ? dir : null
}

const primaryRecordPath = (commonDir: string) => `${commonDir}/litter-primary`

/**
 * The repository's primary checkout and litterDir, for the session's starting
 * directory (section 10, steps 1 to 6). From a linked worktree it also writes
 * the pointer the command hooks follow (`<toplevel>/.claude/litter/hooks/pointer`,
 * layout.pointerPath), and refuses when it can't, since without it the scripts
 * there would find no `active` and let everything through.
 */
export async function resolveLitterDir(p: Ports, cwd: string): Promise<LitterDirResult> {
  if (!cwd.startsWith('/')) return { ok: false, error: `litter: the session's directory isn't absolute (${cwd})` }
  const dirs = await git(p, cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'])
  if (!dirs || dirs.length !== 2) {
    return { ok: false, error: `litter: ${cwd} isn't inside a git repository. litter runs need one: start the session in a repository's checkout.` }
  }
  const gitDir = await real(p, dirs[0]!)
  const commonDir = await real(p, dirs[1]!)
  if (!gitDir || !commonDir) return { ok: false, error: `litter: git named a git directory that doesn't exist (${dirs.join(', ')})` }
  // A bare repository has no top level, so it's asked for on its own.
  const topOut = await git(p, cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel'])
  const toplevel = topOut?.[0] ? await real(p, topOut[0]) : null

  let primary: string | null = null
  let litterDir: string
  if (gitDir === commonDir && toplevel) {
    // Step 1: the primary checkout (an ordinary repo, a submodule, a separate git dir's own checkout).
    primary = toplevel
    litterDir = `${primary}/.claude/litter`
    // Step 4: recorded, so a later session in a separate git dir's linked worktree can find it.
    try {
      const recorded = (await p.fs.exists(primaryRecordPath(commonDir))) ? (await p.fs.read(primaryRecordPath(commonDir))).trim() : null
      if (recorded !== primary) await atomicWrite(p, primaryRecordPath(commonDir), `${primary}\n`)
    } catch (err) {
      p.log(`litter-primary not recorded in ${commonDir}: ${errText(err)}`)
    }
  } else if ((await commonConfig(p, commonDir, 'core.bare', true)) === 'true') {
    // Step 5: no primary checkout; the same answer from every worktree.
    litterDir = `${commonDir}/litter`
  } else {
    // Step 2: a linked worktree. The candidates, in order.
    const candidates: string[] = []
    const wt = await commonConfig(p, commonDir, 'core.worktree')
    if (wt) candidates.push(resolvePath(commonDir, wt))
    const first = (await worktreeList(p, cwd))?.[0]
    if (first && !first.bare && (await real(p, first.path)) !== commonDir) candidates.push(first.path)
    try {
      if (await p.fs.exists(primaryRecordPath(commonDir))) candidates.push((await p.fs.read(primaryRecordPath(commonDir))).trim())
    } catch (err) {
      p.log(`litter-primary in ${commonDir} unreadable: ${errText(err)}`)
    }
    for (const c of candidates) {
      primary = await verifyPrimary(p, c, commonDir)
      if (primary) break
    }
    if (!primary) {
      // Step 6.
      return {
        ok: false,
        error:
          `litter: can't find the primary checkout of the repository at ${cwd}: it's a linked worktree whose primary ` +
          `no litter session has opened yet (a separate git dir, or a moved checkout). Open a session in the primary ` +
          `checkout once, then this worktree resolves too.`,
      }
    }
    litterDir = `${primary}/.claude/litter`
  }

  if (toplevel && toplevel !== primary) {
    const res = await writePointer(p, toplevel, litterDir)
    if (res) return { ok: false, error: res }
  }
  return { ok: true, litterDir, primary, commonDir }
}

/**
 * Writes `<projectDir>/.claude/litter/hooks/pointer`, the absolute hooks/
 * folder the scripts follow from a linked worktree (layout.pointerPath), when
 * it doesn't already say so. Resolves null, or why it couldn't.
 */
export async function writePointer(p: Ports, projectDir: string, litterDir: string): Promise<string | null> {
  const path = pointerPath(projectDir)
  const want = hooksDir(litterDir)
  try {
    if ((await p.fs.exists(path)) && (await p.fs.read(path)).trim() === want) return null
    await atomicWrite(p, path, `${want}\n`)
    return null
  } catch (err) {
    return `litter: couldn't write ${path}, which the command hooks in this worktree need to find ${want} (${errText(err)})`
  }
}

/**
 * `<litterDir>/.gitignore`: what of litter's folder never goes into git (plan
 * section 14, "Should .claude/litter/ be committed?"). The rest is yours to
 * commit.
 */
export const LITTER_GITIGNORE = [
  "# Written by litter. Its runtime files and logs stay out of git: the hooks' state, the locks, the ledgers and",
  "# the verify logs. The rest is yours to commit: each run's run.json, its copies of the plan, summary.md,",
  '# verdicts and proposals; each swarm\'s spec, briefs, revisions and summaries; the swarm templates.',
  '/hooks/',
  '/lock-lease-*.json',
  '/rules-ledger/',
  '/[0-9]*/ledger/',
  '/[0-9]*/ledger-export/',
  '/[0-9]*/verify/',
  '/swarms/*/ledger/',
  '/swarms/*/owner-lease-*.json',
  '/swarms/*/launches/*/ledger/',
  '',
].join('\n')

/**
 * Writes `<litterDir>/.gitignore` (LITTER_GITIGNORE) once, when there's none:
 * one you've changed or removed the lines of is left as it is. Only for a
 * checkout's `.claude/litter`; a bare repository's lies outside any tree.
 */
export async function writeGitignore(p: Ports, litterDir: string): Promise<void> {
  if (!litterDir.endsWith('/.claude/litter')) return
  const path = `${litterDir}/.gitignore`
  if (await p.fs.exists(path)) return
  await atomicWrite(p, path, LITTER_GITIGNORE)
}

const WORKFLOWS: readonly Workflow[] = ['execute', 'fanout', 'design', 'plan']

export type FoundRun = {
  run: string
  runDir: string
  checkout: string | null
  workflow: Workflow
  status: string
  started: number | null
}

/**
 * A run's status from its ledger: the last of run.launch or run.resume
 * (active), run.stopping (stopping) and run.end (its status); `pending`
 * before the first launch; `ledger_tampered` once the chain is broken.
 */
async function runStatus(p: Ports, dir: string, run: string): Promise<{ status: string; started: number | null }> {
  const { records, tampered } = await readLedger(p, dir, run)
  let status = 'pending'
  for (const r of records) {
    if (r.kind === 'run.launch' || r.kind === 'run.resume') status = 'active'
    else if (r.kind === 'run.stopping') status = 'stopping'
    else if (r.kind === 'run.end' && typeof r.body.status === 'string') status = r.body.status
  }
  const started = records.find(r => r.kind === 'run.start')?.at ?? null
  return { status: tampered ? 'ledger_tampered' : status, started }
}

/** The repository litterDir belongs to, for `git worktree list`: the primary checkout, or a bare repo's common dir. */
const repoOf = (litterDir: string) =>
  litterDir.endsWith('/.claude/litter') ? litterDir.slice(0, -'/.claude/litter'.length) : litterDir.slice(0, litterDir.lastIndexOf('/'))

/** `run.find { run?, workflow? }`: absolute paths, newest first, writes nothing. */
export const recordRunFind: RecordHandler = async (ctx, input) => {
  if (!ctx.litterDir) return fail("litter: this session has no litter directory, so there's no run to find")
  const want = input.run
  if (want !== undefined && (typeof want !== 'string' || !RUN_ID.test(want))) {
    return fail("litter: 'run' must be a run id, <yyyymmdd>-<slug>, or left out to list every run", 'run')
  }
  const wf = input.workflow
  if (wf !== undefined && (typeof wf !== 'string' || !(WORKFLOWS as readonly string[]).includes(wf))) {
    return fail("litter: 'workflow' must be one of the allowed values, or left out", 'workflow', WORKFLOWS)
  }
  const litterDir = ctx.litterDir
  const names = (await ctx.p.fs.exists(litterDir))
    ? (await ctx.p.fs.list(litterDir)).filter(e => e.kind === 'dir' && RUN_ID.test(e.name) && (want === undefined || e.name === want)).map(e => e.name)
    : []
  // Where each branch is checked out; null for all when git can't say.
  const byBranch = new Map<string, string>()
  for (const w of (await worktreeList(ctx.p, repoOf(litterDir))) ?? []) if (w.branch) byBranch.set(w.branch, w.path)
  const runs: FoundRun[] = []
  for (const run of names) {
    const dir = runDir(litterDir, run)
    let json: RunJson | undefined
    try {
      json = await readJson<RunJson>(ctx.p, runJsonPath(dir))
    } catch (err) {
      ctx.p.log(`run.find: ${run}/run.json unreadable: ${errText(err)}`)
      continue
    }
    if (!json || json.v !== 1 || json.run !== run) continue
    if (wf !== undefined && json.workflow !== wf) continue
    const { status, started } = await runStatus(ctx.p, dir, run)
    const ref = typeof json.ref === 'string' ? (json.ref.startsWith('refs/') ? json.ref : `refs/heads/${json.ref}`) : null
    runs.push({ run, runDir: dir, checkout: ref ? (byBranch.get(ref) ?? null) : null, workflow: json.workflow, status, started })
  }
  runs.sort((a, b) => (b.started ?? 0) - (a.started ?? 0) || b.run.localeCompare(a.run))
  return { ok: true, litterDir, runs }
}
