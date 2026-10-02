// A fanout's integration (plan section 7, fanout.js steps 3 and 4): the
// `integrate` record kind, which merges the task branches onto the
// integration branch in the confirmed order, checks ownership per branch and
// for the whole result, stops at a conflict for the integrator, and finishes
// that merge on the next call. Owner: phase 2b, work package G. The
// signatures are the contract; the bodies are G's.
//
// The mod decides what to merge, never the model: the integrate call names
// only the run. Every git argv here is built from run.json's checked facts,
// the ledger's records and git's own answers; branches reach git as
// `refs/heads/<name>` or as the commit they resolved to, refs after `--`
// (plan section 9, "Mod safety"). Git runs with repo hooks off in the mod.

import type { Ports } from './ports'
import type { RecordCtx, RecordHandler, RecordReply, StoredRecord } from './records/core'
import type { RunJson } from './records/run'
import type {
  ChangedPath,
  IntegrateConflictBody,
  IntegrateDoneBody,
  IntegrateMergeBody,
  IntegrateReply,
  IntegrateSkipBody,
  SkippedTask,
  TaskResultBody,
  WorktreeCreateBody,
} from './records/fanout'
import type { ModWorktreeSpec } from './worktrees'
import { fail } from './records/core'
import { LedgerTampered, appendRecord, readLedger } from './ledgercore'
import { integrationBranch, integrationName } from './layout'
import { serial, sha256 } from './fsx'
import { SNAPSHOT_PATHSPEC, snapshot } from './snapshot'
import { addModWorktree } from './worktrees'
import { patchRunPolicy, primaryOf } from './lifecycle'
import { readPolicy } from './policy'
import { writeOut } from './output'
import { MOD, OID, type RunFacts, agentOf, ledgerFailure, loadRun, message, roleOf, runClosed } from './verify'

// ---------------------------------------------------------------------------
// git, as integration runs it: never rejects, so each step's failure is handled the same way.

type GitResult = { code: number; stdout: string; stderr: string }

function git(p: Ports, dir: string, argv: readonly string[], stdin?: string): Promise<GitResult> {
  const init = stdin === undefined ? { timeoutMs: 120_000 } : { timeoutMs: 120_000, stdin }
  return p.run(['git', '-C', dir, ...argv], init).then(
    r => ({ code: r.code, stdout: r.stdout, stderr: r.stderr }),
    err => ({ code: -1, stdout: '', stderr: message(err) }),
  )
}

const firstLine = (s: string): string => s.trim().split('\n')[0] ?? ''
/** What git said: its first error line, else its first output line (a merge reports on stdout). */
const said = (r: GitResult): string => firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}`
const nul = (s: string): string[] => s.split('\0').filter(x => x !== '')

/** The commit a ref names, or null when it doesn't resolve. */
async function commitOf(p: Ports, dir: string, ref: string): Promise<string | null> {
  const r = await git(p, dir, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])
  const oid = r.stdout.trim()
  return r.code === 0 && OID.test(oid) ? oid : null
}

async function treeOf(p: Ports, dir: string, commit: string): Promise<string | null> {
  const r = await git(p, dir, ['rev-parse', '--verify', '-q', `${commit}^{tree}`])
  const oid = r.stdout.trim()
  return r.code === 0 && OID.test(oid) ? oid : null
}

async function headRef(p: Ports, dir: string): Promise<string | null> {
  const r = await git(p, dir, ['symbolic-ref', '-q', 'HEAD'])
  return r.code === 0 ? r.stdout.trim() : null
}

/** `git diff --name-only -z --no-renames <from> <to>`: both sides of a move, odd names intact (section 7, "Ownership"). */
async function diffNames(p: Ports, dir: string, from: string, to: string): Promise<{ ok: true; paths: string[] } | { ok: false; why: string }> {
  const r = await git(p, dir, ['diff', '--name-only', '-z', '--no-renames', from, to, '--'])
  return r.code === 0 ? { ok: true, paths: [...new Set(nul(r.stdout))].sort() } : { ok: false, why: said(r) }
}

/** A worktree's uncommitted changes, tracked or new, the mod's own paths left out; null when the folder is gone. */
async function uncommitted(p: Ports, path: string): Promise<{ paths: string[] } | { error: string } | null> {
  if (!(await p.fs.exists(path))) return null
  const r = await git(p, path, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', ...SNAPSHOT_PATHSPEC])
  if (r.code !== 0) return { error: said(r) }
  return { paths: [...new Set(nul(r.stdout).map(e => e.slice(3)))].sort() }
}

/** The index as `ls-files -s` shows it, hashed: staging or unstaging anything changes it, a stat refresh doesn't. */
async function indexPrint(p: Ports, dir: string): Promise<string | null> {
  const r = await git(p, dir, ['ls-files', '-s', '-z'])
  return r.code === 0 ? sha256(r.stdout) : null
}

/** At most `n` names, then how many more: reasons a model reads stay short. */
function list(xs: readonly string[], n = 20): string {
  return xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`
}

const oneLine = (s: string, max = 300): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)

/** A branch name litter passes to git, as `refs/heads/<name>`: never an option, never a range. */
const BRANCH = /^(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9_-]$/

// ---------------------------------------------------------------------------
// The run's tasks and records.

/** As run.start validated them (lifecycle.ts TASK_ID). */
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** A fanout task as run.json's args hold it. */
export type FanoutTask = { id: string; title: string; writes: boolean; files: string[] }

/** The run's tasks from run.json's args, in order. A malformed entry is left out (run.start wrote them). */
export function fanoutTasks(json: RunJson): FanoutTask[] {
  const tasks = json.args?.tasks
  if (!Array.isArray(tasks)) return []
  return tasks.flatMap(t => {
    const x = t as { id?: unknown; title?: unknown; writes?: unknown; files?: unknown } | null
    if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !TASK_ID.test(x.id)) return []
    const files = Array.isArray(x.files) ? x.files.filter((f): f is string => typeof f === 'string' && f !== '') : []
    return [{ id: x.id, title: typeof x.title === 'string' ? x.title : '', writes: x.writes === true, files }]
  })
}

/** The writing tasks in merge order: run.json's mergeOrder, then any writer it leaves out, so none goes unchecked. */
function mergeOrder(json: RunJson, tasks: readonly FanoutTask[]): FanoutTask[] {
  const writers = tasks.filter(t => t.writes)
  const named = Array.isArray(json.args?.mergeOrder) ? (json.args.mergeOrder as unknown[]) : []
  const out: FanoutTask[] = []
  for (const id of named) {
    const w = writers.find(t => t.id === id)
    if (w && !out.includes(w)) out.push(w)
  }
  for (const w of writers) if (!out.includes(w)) out.push(w)
  return out
}

/** Does a task own the path? An entry ending in `/` owns everything under it; there are no globs (section 7, "Ownership"). */
export const owns = (files: readonly string[], path: string): boolean => files.some(f => (f.endsWith('/') ? path.startsWith(f) : path === f))

const body = <B>(r: StoredRecord): B => r.body as unknown as B

/**
 * The latest `worktree.create` per name: recordedWorktrees' rule (worktrees.ts,
 * package F), kept here so integration and its tests don't depend on that body.
 */
function createsByName(records: readonly StoredRecord[]): Map<string, WorktreeCreateBody> {
  const out = new Map<string, WorktreeCreateBody>()
  for (const r of records) {
    if (r.kind !== 'worktree.create') continue
    const b = body<WorktreeCreateBody>(r)
    if (typeof b.name === 'string' && typeof b.path === 'string' && b.path.startsWith('/') && typeof b.branch === 'string') out.set(b.name, b)
  }
  return out
}

/** The run's integration worktree, from its `worktree.create` record; null before integrate made it. */
export function integrationWorktree(records: readonly StoredRecord[], run: string): WorktreeCreateBody | null {
  return createsByName(records).get(integrationName(run)) ?? null
}

type BindWorktree = { name: string; path: string; branch: string }
/** A `task.bind` record (package F's body: `{ task, worktree: { name, path, branch }, supersedes? }`). */
type Binding = { seq: number; agent: string | null; task: string; worktree: BindWorktree | null }

function bindings(records: readonly StoredRecord[]): Binding[] {
  const out: Binding[] = []
  for (const r of records) {
    if (r.kind !== 'task.bind') continue
    const b = r.body as { task?: unknown; worktree?: unknown }
    if (typeof b.task !== 'string') continue
    const w = b.worktree as Partial<BindWorktree> | null | undefined
    const worktree =
      w && typeof w === 'object' && typeof w.name === 'string' && typeof w.path === 'string' && typeof w.branch === 'string'
        ? { name: w.name, path: w.path, branch: w.branch }
        : null
    out.push({ seq: r.seq, agent: agentOf(r), task: b.task, worktree })
  }
  return out
}

/** The integration so far, from the ledger. */
type IntegrationState = {
  merges: StoredRecord<IntegrateMergeBody>[]
  skips: StoredRecord<IntegrateSkipBody>[]
  /** A conflict whose task has no later integrate.merge: the integrator's turn. */
  open: StoredRecord<IntegrateConflictBody> | null
  done: StoredRecord<IntegrateDoneBody> | null
}

function stateOf(records: readonly StoredRecord[]): IntegrationState {
  const st: IntegrationState = { merges: [], skips: [], open: null, done: null }
  for (const r of records) {
    if (r.kind === 'integrate.merge') {
      st.merges.push(r as StoredRecord<IntegrateMergeBody>)
      if (st.open && st.open.body.task === body<IntegrateMergeBody>(r).task) st.open = null
    } else if (r.kind === 'integrate.skip') st.skips.push(r as StoredRecord<IntegrateSkipBody>)
    else if (r.kind === 'integrate.conflict') st.open = r as StoredRecord<IntegrateConflictBody>
    else if (r.kind === 'integrate.done') st.done = r as StoredRecord<IntegrateDoneBody>
  }
  return st
}

/** Where the integration branch should be: the last merge the mod made, or base. */
const expectedTip = (st: IntegrationState, base: string): string => st.merges.at(-1)?.body.commit ?? base

// ---------------------------------------------------------------------------
// The whole result (section 7, "Ownership": before verify, and again before land).

/**
 * Checks the combined change at `tip`: every path of `git diff --name-only -z
 * --no-renames <base> <tip>` is owned by a merged task or is integrator_extra,
 * and every recorded worktree with commits past base or uncommitted changes
 * has a binding (a superseded one counts). `blocked` names each failure.
 */
export async function wholeResult(
  p: Ports,
  f: RunFacts,
  records: readonly StoredRecord[],
  tip: string,
): Promise<{ changed: ChangedPath[]; blocked: string[] }> {
  const { run, json } = f
  const tasks = fanoutTasks(json)
  const st = stateOf(records)
  const mergedIds = new Set(st.merges.map(m => m.body.task))
  const merged = tasks.filter(t => mergedIds.has(t.id))
  const extra = new Set(st.merges.flatMap(m => m.body.resolved?.integrator_extra ?? []))
  const changed: ChangedPath[] = []
  const blocked: string[] = []

  const names = await diffNames(p, json.checkout, json.base, tip)
  if (!names.ok) blocked.push(`the combined change ${json.base}..${tip} can't be listed: ${names.why}`)
  else {
    for (const path of names.paths) {
      const owner = merged.find(t => owns(t.files, path)) ?? null
      const isExtra = extra.has(path)
      changed.push({ path, task: owner?.id ?? null, integrator_extra: isExtra })
      if (owner || isExtra) continue
      const other = tasks.find(t => t.writes && owns(t.files, path))
      blocked.push(other ? `${path} belongs to task ${other.id}, which wasn't merged` : `${path} is owned by no task`)
    }
  }

  // A recorded worktree with changes and no binding blocks the land (section 7, fanout.js step 2).
  const bound = new Set(bindings(records).flatMap(b => (b.worktree ? [b.worktree.path] : [])))
  for (const c of createsByName(records).values()) {
    if (c.name === integrationName(run) || c.name === `litter-${run}` || c.path === json.checkout || bound.has(c.path)) continue
    const found: string[] = []
    if (BRANCH.test(c.branch)) {
      const at = await commitOf(p, json.checkout, `refs/heads/${c.branch}`)
      if (at && at !== json.base) {
        const n = await git(p, json.checkout, ['rev-list', '--count', `${json.base}..${at}`, '--'])
        if (n.code !== 0) found.push(`commits on ${c.branch} that can't be counted (${said(n)})`)
        else if (Number(n.stdout.trim()) > 0) found.push(`${n.stdout.trim()} commit(s) past base on ${c.branch}`)
      }
    } else found.push(`a branch name litter won't pass to git (${JSON.stringify(c.branch)})`)
    const dirt = await uncommitted(p, c.path)
    if (dirt && 'error' in dirt) found.push(`changes that can't be checked (${dirt.error})`)
    else if (dirt && dirt.paths.length > 0) found.push(`uncommitted changes (${list(dirt.paths)})`)
    if (found.length > 0) blocked.push(`worktree ${c.name} at ${c.path} has ${found.join(' and ')}, and no writer was bound to it`)
  }
  return { changed, blocked }
}

// ---------------------------------------------------------------------------
// Conflict markers (the brief's rule: `<<<<<<< `, `>>>>>>> `, or `=======` alone between them).

/** The 1-based lines of a text that are conflict markers. */
export function markerLines(text: string): number[] {
  const out: number[] = []
  let open = false
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '')
    if (line.startsWith('<<<<<<< ') || line === '<<<<<<<') {
      out.push(i + 1)
      open = true
    } else if (line.startsWith('>>>>>>> ') || line === '>>>>>>>') {
      out.push(i + 1)
      open = false
    } else if (open && line === '=======') out.push(i + 1)
  }
  return out
}

/** `path:line,…` for each conflicted file that still holds a marker. A file resolved by deletion, or a link, has none. */
async function markersIn(p: Ports, where: string, files: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const file of files) {
    const path = `${where}/${file}`
    const st = await p.fs.stat(path).catch(() => null)
    if (!st || st.isLink || st.kind !== 'file') continue
    let text: string
    try {
      text = await p.fs.read(path)
    } catch (err) {
      out.push(`${file} (it can't be read: ${message(err)})`)
      continue
    }
    const lines = markerLines(text)
    if (lines.length > 0) out.push(`${file}:${lines.slice(0, 5).join(',')}${lines.length > 5 ? ',…' : ''}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// The integration worktree.

async function realOf(p: Ports, path: string): Promise<string> {
  try {
    return (await p.fs.stat(path, { resolve: true })).realPath ?? path
  } catch {
    return path
  }
}

const dirname = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')))

/** Where litter's worktrees go: policy.json's while it names the run, else as lifecycle's policyFor computes it. */
async function worktreeRoot(p: Ports, litterDir: string, run: string): Promise<string> {
  const policy = await readPolicy(p, litterDir).catch(() => undefined)
  const root = policy?.run?.run === run ? policy.run.worktreeRoot : undefined
  if (typeof root === 'string' && root.startsWith('/')) return root
  const primary = primaryOf(litterDir)
  return primary ? `${await realOf(p, primary)}/.claude/worktrees` : `${await realOf(p, dirname(litterDir))}/litter-worktrees`
}

/**
 * The integration worktree: the recorded one, or made now with package F's
 * addModWorktree at `<worktreeRoot>/litter-<run>-integration` on
 * `litter/<run>-integration` at base, setup or linkDirs first. Either way
 * policy.json's `roots.integration` names it, so the guard lets the
 * integrator write there and nowhere else.
 */
async function integrationTree(ctx: RecordCtx, f: RunFacts, records: readonly StoredRecord[]): Promise<{ ok: true; where: string } | { ok: false; where: string; reason: string }> {
  const { p } = ctx
  const litterDir = ctx.litterDir!
  const { run, runDir, json } = f
  const name = integrationName(run)
  const branch = integrationBranch(run)
  const recorded = integrationWorktree(records, run)
  let where: string
  if (recorded) {
    where = recorded.path
    if (recorded.branch !== branch || recorded.base !== json.base) {
      return { ok: false, where, reason: `the recorded integration worktree ${where} is on ${recorded.branch} from ${recorded.base}, not ${branch} from the run's base ${json.base}` }
    }
  } else {
    const spec: ModWorktreeSpec = {
      run,
      name,
      path: `${await worktreeRoot(p, litterDir, run)}/${name}`,
      branch,
      base: json.base,
      disposable: false,
      runDir,
      checkout: json.checkout,
      setup: json.setup,
      linkDirs: [...json.linkDirs],
    }
    let made: Awaited<ReturnType<typeof addModWorktree>>
    try {
      made = await addModWorktree(p, ctx.options, spec)
    } catch (err) {
      return { ok: false, where: spec.path, reason: `the integration worktree couldn't be made: ${message(err)}` }
    }
    if (!made.ok) return { ok: false, where: spec.path, reason: `the integration worktree couldn't be made: ${made.reason}` }
    where = made.path
  }
  try {
    const policy = await readPolicy(p, litterDir)
    if (policy?.run?.run === run && policy.run.roots.integration !== where) {
      await patchRunPolicy(p, litterDir, run, r => ({ ...r, roots: { ...r.roots, integration: where } }))
    }
  } catch (err) {
    // The integrator's writes are then denied, and it reports the conflict unresolved: the run halts.
    p.log(`integrate ${run}: roots.integration not set (${message(err)})`)
  }
  return { ok: true, where }
}

/** Why the integration worktree can't take the next merge: off its branch, moved, mid-merge, or changed. Null when ready. */
async function notReady(p: Ports, where: string, run: string, expected: string): Promise<string | null> {
  const ref = `refs/heads/${integrationBranch(run)}`
  const head = await headRef(p, where)
  if (head !== ref) return `the integration worktree ${where} is on ${head ?? 'a detached HEAD'}, not ${integrationBranch(run)}`
  const tip = await commitOf(p, where, ref)
  if (tip !== expected) return `${integrationBranch(run)} is at ${tip ?? 'nothing'}, not ${expected} where litter's last merge left it`
  if (await commitOf(p, where, 'MERGE_HEAD')) return `a merge litter didn't record is in progress in ${where}`
  const dirt = await uncommitted(p, where)
  if (!dirt) return `the integration worktree ${where} is gone`
  if ('error' in dirt) return `the integration worktree ${where} can't be checked: ${dirt.error}`
  if (dirt.paths.length > 0) return `the integration worktree ${where} has changes litter didn't make: ${list(dirt.paths)}`
  return null
}

// ---------------------------------------------------------------------------
// One task's branch, checked before it's merged (section 7, fanout.js step 3).

type Checked = { ok: true; branch: string; commit: string; paths: string[] } | { ok: false; skip: SkippedTask }

async function checkTask(
  p: Ports,
  f: RunFacts,
  records: readonly StoredRecord[],
  task: FanoutTask,
): Promise<Checked> {
  const { json } = f
  const base = json.base
  const id = task.id
  const binding = bindings(records).filter(b => b.task === id).at(-1)
  const creates = [...createsByName(records).values()]
  const create = binding?.worktree ? creates.find(c => c.path === binding.worktree!.path) : undefined

  const skip = async (reason: string, unowned?: string[]): Promise<Checked> => {
    // What the writer left uncommitted isn't merged: the reason says so.
    const dirt = create ? await uncommitted(p, create.path) : null
    const full = dirt && 'paths' in dirt && dirt.paths.length > 0 ? `${reason}; its worktree also has uncommitted changes, which aren't merged: ${list(dirt.paths)}` : reason
    return { ok: false, skip: unowned ? { task: id, reason: full, unowned } : { task: id, reason: full } }
  }

  // The latest result says done.
  const result = records.filter(r => r.kind === 'task.result' && body<TaskResultBody>(r).task === id).at(-1)
  if (!result) return skip(`task ${id} has no result`)
  const res = body<TaskResultBody>(result).result ?? {}
  if (res.status !== 'done') {
    return skip(
      res.status === 'blocked'
        ? `task ${id} returned blocked: ${oneLine(typeof res.summary === 'string' ? res.summary : String(res.notes ?? ''))}`
        : `task ${id}'s result says ${JSON.stringify(res.status ?? null)}, not done`,
    )
  }
  // Its latest binding, to a recorded worktree.
  if (!binding) return skip(`task ${id} isn't bound to a worktree`)
  if (!binding.worktree) return skip(`task ${id}'s binding names no worktree`)
  if (!create) return skip(`task ${id} is bound to ${binding.worktree.path}, which isn't a worktree this run recorded`)
  if (binding.worktree.branch !== create.branch || binding.worktree.name !== create.name) {
    return skip(`task ${id}'s binding names ${binding.worktree.name} on ${binding.worktree.branch}, but the recorded worktree at that path is ${create.name} on ${create.branch}`)
  }
  // The result is about that worktree: its writer was bound there.
  const by = agentOf(result)
  if (!bindings(records).some(b => b.task === id && b.agent === by && b.worktree?.path === create.path)) {
    return skip(`task ${id}'s latest result isn't from a writer bound to ${create.path}`)
  }
  // The branch, checked again at use (section 9, "Run worktrees").
  const branch = create.branch
  if (!BRANCH.test(branch)) return skip(`task ${id}'s branch ${JSON.stringify(branch)} isn't a name litter passes to git`)
  if (create.base !== base) return skip(`worktree ${create.name} was made from ${create.base}, not the run's base ${base}`)
  const commit = await commitOf(p, json.checkout, `refs/heads/${branch}`)
  if (!commit) return skip(`branch ${branch} doesn't exist`)
  const mb = await git(p, json.checkout, ['merge-base', commit, base])
  const fork = mb.stdout.trim()
  if (mb.code !== 0 || fork !== base) return skip(`branch ${branch} forks from ${fork || 'no common commit'}, not the run's base ${base}`)
  if (commit === base) return skip(`branch ${branch} has no commits past base`)
  // Ownership: every path the branch changes is its own task's.
  const names = await diffNames(p, json.checkout, base, commit)
  if (!names.ok) return skip(`the change on ${branch} can't be listed: ${names.why}`)
  const unowned = names.paths.filter(x => !owns(task.files, x))
  if (unowned.length > 0) return skip(`branch ${branch} changes paths task ${id} doesn't own: ${list(unowned)}`, unowned)
  return { ok: true, branch, commit, paths: names.paths }
}

// ---------------------------------------------------------------------------
// Merging.

const mergeMessage = (task: string, run: string): string => `litter: merge ${task} of ${run}`

/**
 * The mod's merge argv: always a merge commit, no editor, no hooks, no
 * autostash, never over an ignored file, no rerere replay, and no rename
 * detection, so every file lands where its branch put it and ownership's
 * `--no-renames` view is the merge's too.
 */
const mergeArgv = (msg: string, commit: string): string[] => [
  '-c', 'rerere.enabled=false',
  'merge', '--no-ff', '--no-edit', '--no-verify', '--no-autostash', '--no-overwrite-ignore', '--no-log', '--no-squash', '--no-stat',
  '-s', 'ort', '-X', 'no-renames', '-m', msg, '--', commit,
]

/**
 * Finishes the open conflict after the integrator: the worktree still
 * mid-merge as the conflict left it, no marker left, then everything staged,
 * the tree written, committed with both parents, the branch swapped, the
 * merge state ended. `unchanged` when nothing happened since the conflict
 * (the integrator hasn't run, or changed nothing): the same conflict again.
 */
async function finishConflict(
  p: Ports,
  f: RunFacts,
  where: string,
  c: IntegrateConflictBody,
): Promise<'unchanged' | { stop: string } | { merged: IntegrateMergeBody }> {
  const { run, json } = f
  const ib = integrationBranch(run)
  const ref = `refs/heads/${ib}`
  const head = await headRef(p, where)
  const tip = await commitOf(p, where, ref)
  const mergeHead = await commitOf(p, where, 'MERGE_HEAD')
  const index = await indexPrint(p, where)
  let now: Awaited<ReturnType<typeof snapshot>>
  try {
    now = await snapshot(p, where)
  } catch (err) {
    return { stop: `the integration worktree ${where} can't be snapshotted after the integrator: ${message(err)}` }
  }
  if (head === ref && tip === c.head && mergeHead === c.commit && index === c.index && now.tree === c.left) return 'unchanged'

  const found: string[] = []
  if (head !== ref) found.push(`the integration worktree is on ${head ?? 'a detached HEAD'}, not ${ib}`)
  if (tip !== c.head) found.push(`a commit was made: ${ib} moved from ${c.head} to ${tip ?? 'nothing'}`)
  if (mergeHead === null) found.push(`the merge of ${c.branch} is no longer in progress (it was aborted or committed)`)
  else if (mergeHead !== c.commit) found.push(`the merge in progress is of ${mergeHead}, not ${c.commit}`)
  // An ended merge changed the index too; that's said above.
  else if (index === null) found.push("the integration worktree's index can't be read")
  else if (index !== c.index) found.push('files were staged or unstaged; litter stages the resolution itself')
  const marked = await markersIn(p, where, c.files)
  if (marked.length > 0) found.push(`conflict markers are left in ${list(marked)}`)
  if (now.dirty_submodules.length > 0) found.push(`submodules have uncommitted changes (${list(now.dirty_submodules)})`)
  if (found.length > 0) {
    return { stop: `the resolution of ${c.task}'s merge can't be committed: ${found.join('; ')}. The integration worktree ${where} is left as it is` }
  }

  // What the integrator changed beyond the conflicted files: the verifier reads each in full.
  const since = await git(p, where, ['diff-tree', '-r', '--name-only', '-z', '--no-renames', c.left, now.tree, '--'])
  if (since.code !== 0) return { stop: `what the integrator changed can't be listed: ${said(since)}` }
  const extra = [...new Set(nul(since.stdout))].filter(x => !c.files.includes(x)).sort()

  const msg = mergeMessage(c.task, run)
  const added = await git(p, where, ['add', '-A', '--', ...SNAPSHOT_PATHSPEC])
  if (added.code !== 0) return { stop: `staging the resolution failed: ${said(added)}` }
  const written = await git(p, where, ['write-tree'])
  const tree = written.stdout.trim()
  if (written.code !== 0 || !OID.test(tree)) return { stop: `writing the resolved tree failed: ${said(written)}` }
  const made = await git(p, where, ['commit-tree', tree, '-p', c.head, '-p', c.commit, '-F', '-'], `${msg}\n`)
  const commit = made.stdout.trim()
  if (made.code !== 0 || !OID.test(commit)) return { stop: `committing the resolution failed: ${said(made)}` }
  const swap = await git(p, where, ['update-ref', '-m', msg, ref, commit, c.head])
  if (swap.code !== 0) return { stop: `${ib} moved while the resolution was committed: ${said(swap)}` }
  // HEAD and the index are the commit now; only the merge state is left. If it stays, the next merge's check stops.
  const quit = await git(p, where, ['merge', '--quit'])
  if (quit.code !== 0) p.log(`integrate ${run}: git merge --quit failed in ${where}: ${said(quit)}`)
  const names = await diffNames(p, json.checkout, json.base, c.commit)
  return {
    merged: { task: c.task, branch: c.branch, commit, paths: names.ok ? names.paths : [], resolved: { files: [...c.files], integrator_extra: extra } },
  }
}

// ---------------------------------------------------------------------------
// The record.

/** Every answer goes to the relay's out file, keyed by integrate_id, before the call is answered. */
async function answer(ctx: RecordCtx, run: string, reply: IntegrateReply): Promise<IntegrateReply> {
  const { ok: _ok, ...fields } = reply
  const agentId = ctx.caller.agentId
  if (agentId !== null && ctx.litterDir !== null) {
    try {
      await writeOut(ctx.p, ctx.litterDir, { v: 1, agent_id: agentId, for: { integrate_id: reply.integrate_id }, fields })
    } catch (err) {
      // output.sh then denies the relay's result, and it records again: the answer is the same.
      ctx.p.log(`integrate ${run}: out file for ${agentId} not written: ${message(err)}`)
    }
  }
  return reply
}

type Common = Pick<IntegrateReply, 'ok' | 'where' | 'base' | 'merged' | 'skipped'>

const commonOf = (f: RunFacts, where: string, st: IntegrationState): Common => ({
  ok: true,
  where,
  base: f.json.base,
  merged: st.merges.map(m => m.body.task),
  skipped: st.skips.map(s => s.body),
})

function doneReply(common: Common, rec: StoredRecord<IntegrateDoneBody>): IntegrateReply {
  const b = rec.body
  const id = `i${rec.seq}`
  return b.blocked.length === 0
    ? { ...common, integrate_id: id, status: 'merged', tip: b.tip, tree: b.tree, changed: b.changed }
    : { ...common, integrate_id: id, status: 'refused', reason: b.blocked.join('; ') }
}

const conflictReply = (common: Common, rec: StoredRecord<IntegrateConflictBody>): IntegrateReply => ({
  ...common,
  integrate_id: `i${rec.seq}`,
  status: 'conflict',
  conflict: { task: rec.body.task, branch: rec.body.branch, files: [...rec.body.files] },
})

/**
 * `mcp__litter__record({ kind: 'integrate', run })`, from the run's relay
 * only. Answers an IntegrateReply (records/fanout.ts) and writes the relay's
 * out file keyed by `integrate_id`, so output.sh fills its StructuredOutput.
 */
export const recordIntegrate: RecordHandler = async (ctx, input) => {
  const facts = await loadRun(ctx, input)
  if ('ok' in facts) return facts
  const role = roleOf(ctx.caller)
  if (ctx.caller.agentId === null || role !== 'relay') {
    return fail(`litter: 'integrate' is recorded by the run's relay, not by ${ctx.caller.agentType ?? (ctx.caller.agentId === null ? 'the main thread' : 'an agent litter doesn\'t know')}`, 'kind')
  }
  if (facts.json.workflow !== 'fanout') return fail(`litter: run ${facts.run} is a ${facts.json.workflow} run; only a fanout integrates`, 'run')
  return serial(`integrate:${facts.runDir}`, () => integrate(ctx, facts))
}

async function integrate(ctx: RecordCtx, f: RunFacts): Promise<RecordReply> {
  const { p } = ctx
  const { run, runDir, json } = f
  const base = json.base

  const read = async (): Promise<StoredRecord[] | RecordReply> => {
    const ledger = await readLedger(p, runDir, run)
    return ledger.tampered ? ledgerFailure(new LedgerTampered(ledger.tampered.seq, ledger.tampered.reason)) : ledger.records
  }
  let got = await read()
  if (!Array.isArray(got)) return got
  const closed = runClosed(got)
  if (closed) return fail(`litter: run ${run} ${closed}; it takes no more integrate records`, 'run')

  // The outcome is recorded once; every later call answers the same and changes nothing.
  const settled = stateOf(got)
  if (settled.done) {
    const where = integrationWorktree(got, run)?.path ?? `${await worktreeRoot(p, ctx.litterDir!, run)}/${integrationName(run)}`
    return answer(ctx, run, doneReply(commonOf(f, where, settled), settled.done))
  }

  // 1. The integration worktree.
  const wt = await integrationTree(ctx, f, got)
  got = await read()
  if (!Array.isArray(got)) return got
  const records: StoredRecord[] = got
  const where = wt.where
  const append = async <B>(kind: string, b: B): Promise<StoredRecord<B>> => {
    const rec = await appendRecord(p, runDir, { run, kind, by: MOD, body: b })
    records.push(rec as StoredRecord)
    return rec
  }
  const stop = async (reason: string): Promise<IntegrateReply> => {
    const tip = expectedTip(stateOf(records), base)
    const tree = (await treeOf(p, json.checkout, tip)) ?? ''
    const rec = await append<IntegrateDoneBody>('integrate.done', { tip, tree, changed: [], blocked: [reason] })
    return answer(ctx, run, doneReply(commonOf(f, where, stateOf(records)), rec))
  }
  // No worktree, nothing merged: that's the outcome too, so the run halts with the reason.
  if (!wt.ok) return stop(wt.reason)

  // 2. An open conflict: finish it, or answer it again when nothing happened since.
  const open = stateOf(records).open
  if (open) {
    const r = await finishConflict(p, f, where, open.body)
    if (r === 'unchanged') return answer(ctx, run, conflictReply(commonOf(f, where, stateOf(records)), open))
    if ('stop' in r) return stop(r.stop)
    await append<IntegrateMergeBody>('integrate.merge', r.merged)
  }

  // 3. Each remaining writing task, in merge order.
  const tasks = fanoutTasks(json)
  for (const task of mergeOrder(json, tasks)) {
    const st = stateOf(records)
    if (st.merges.some(m => m.body.task === task.id) || st.skips.some(s => s.body.task === task.id)) continue
    const checked = await checkTask(p, f, records, task)
    if (!checked.ok) {
      await append<IntegrateSkipBody>('integrate.skip', checked.skip)
      continue
    }
    const expected = expectedTip(st, base)
    const problem = await notReady(p, where, run, expected)
    if (problem) return stop(problem)
    const m = await git(p, where, mergeArgv(mergeMessage(task.id, run), checked.commit))
    if (m.code === 0) {
      const made = await commitOf(p, where, `refs/heads/${integrationBranch(run)}`)
      const parents = made ? (await git(p, where, ['rev-list', '--parents', '-n', '1', made, '--'])).stdout.trim() : ''
      if (!made || parents !== `${made} ${expected} ${checked.commit}`) {
        return stop(`the merge of ${checked.branch} didn't make a merge commit on ${expected} and ${checked.commit} (${parents || 'no commit'})`)
      }
      await append<IntegrateMergeBody>('integrate.merge', { task: task.id, branch: checked.branch, commit: made, paths: checked.paths })
      continue
    }
    // A conflict leaves the merge in progress, for the integrator; anything else stops the integration.
    const mergeHead = await commitOf(p, where, 'MERGE_HEAD')
    const u = await git(p, where, ['diff', '--name-only', '-z', '--diff-filter=U', '--'])
    const files = u.code === 0 ? [...new Set(nul(u.stdout))].sort() : []
    if (mergeHead !== checked.commit || files.length === 0) return stop(`git merge of ${checked.branch} failed without a conflict to resolve: ${said(m)}`)
    let left: Awaited<ReturnType<typeof snapshot>>
    try {
      left = await snapshot(p, where)
    } catch (err) {
      return stop(`the conflicted merge of ${checked.branch} can't be snapshotted: ${message(err)}`)
    }
    const index = await indexPrint(p, where)
    if (index === null) return stop(`the conflicted merge of ${checked.branch} left an index that can't be read`)
    const rec = await append<IntegrateConflictBody>('integrate.conflict', {
      task: task.id,
      branch: checked.branch,
      files,
      head: expected,
      commit: checked.commit,
      left: left.tree,
      index,
    })
    return answer(ctx, run, conflictReply(commonOf(f, where, stateOf(records)), rec))
  }

  // 4. The whole result, once nothing is left.
  const st = stateOf(records)
  const tip = expectedTip(st, base)
  const problem = await notReady(p, where, run, tip)
  if (problem) return stop(problem)
  const tree = await treeOf(p, json.checkout, tip)
  if (!tree) return stop(`the integration tip ${tip} has no tree`)
  const whole = await wholeResult(p, f, records, tip)
  const rec = await append<IntegrateDoneBody>('integrate.done', { tip, tree, changed: whole.changed, blocked: whole.blocked })
  return answer(ctx, run, doneReply(commonOf(f, where, stateOf(records)), rec))
}

// ---------------------------------------------------------------------------
// summary.md.

/** A table cell: one line, pipes escaped, short. */
const cell = (s: string): string => oneLine(s, 200).replace(/\|/g, '\\|')

/**
 * summary.md's fanout lines: each task's result, merge and verdict, the
 * conflicts the integrator resolved, and what blocked the land. Empty for a
 * run that isn't a fanout.
 */
export function fanoutSummary(json: RunJson | null, records: readonly StoredRecord[]): string[] {
  if (json?.workflow !== 'fanout') return []
  const tasks = fanoutTasks(json)
  const st = stateOf(records)
  const results = records.filter(r => r.kind === 'task.result')
  const resultOf = (id: string) => results.filter(r => body<TaskResultBody>(r).task === id).at(-1)
  const land = records.filter(r => r.kind === 'land' && r.body.gate === 'fanout').at(-1)
  // The verdict the land cited, else the latest one (the verifier's FANOUT_CHECK).
  const verdicts = records.filter(r => r.kind === 'verdict' && Array.isArray(r.body.tasks))
  const verdict = (land ? verdicts.find(v => v.body.verify_id === land.body.verify_id) : undefined) ?? verdicts.at(-1)
  const checks = (verdict?.body.tasks as { id?: unknown; pass?: unknown; gaps?: unknown }[] | undefined) ?? []

  const lines = ['', '## Tasks', '', '| Task | Kind | Result | Integration | Verifier |', '|---|---|---|---|---|']
  for (const t of tasks) {
    const r = resultOf(t.id)
    const res = r ? (body<TaskResultBody>(r).result ?? {}) : null
    const result = !t.writes
      ? 'passed to the verifier'
      : res
        ? res.status === 'blocked'
          ? `blocked: ${String(res.summary ?? '')}`
          : String(res.status ?? 'unknown')
        : 'none'
    const merge = st.merges.find(m => m.body.task === t.id)
    const skip = st.skips.find(s => s.body.task === t.id)
    const integration = !t.writes
      ? '-'
      : merge
        ? `merged${merge.body.resolved ? ' after a conflict' : ''}`
        : skip
          ? `skipped: ${skip.body.reason}`
          : st.open?.body.task === t.id
            ? 'conflict, not resolved'
            : 'not merged'
    const check = checks.find(c => c?.id === t.id)
    const gaps = Array.isArray(check?.gaps) ? (check!.gaps as unknown[]).filter((g): g is string => typeof g === 'string') : []
    const verifier = check ? (check.pass === true ? 'pass' : `fail${gaps.length > 0 ? `: ${gaps.join('; ')}` : ''}`) : '-'
    lines.push(`| ${cell(t.id)} | ${t.writes ? 'writer' : 'read-only'} | ${cell(result)} | ${cell(integration)} | ${cell(verifier)} |`)
  }
  for (const r of results) {
    const b = body<TaskResultBody>(r)
    if (b.task !== null) continue
    const summary = typeof b.result?.summary === 'string' ? b.result.summary : ''
    lines.push('', `An unbound writer returned ${String(b.result?.status ?? 'nothing')}: ${oneLine(summary)}${b.bind_refusal ? ` (its bind was refused: ${oneLine(b.bind_refusal)})` : ''}`)
  }

  const resolved = st.merges.filter(m => m.body.resolved)
  if (resolved.length > 0 || st.open) {
    lines.push('', '## Conflicts', '')
    for (const m of resolved) {
      const extra = m.body.resolved!.integrator_extra
      lines.push(`- ${m.body.task}: the integrator resolved ${list(m.body.resolved!.files)}; integrator_extra: ${extra.length > 0 ? list(extra) : 'none'}`)
    }
    if (st.open) lines.push(`- ${st.open.body.task}: ${list(st.open.body.files)}, not resolved`)
  }

  if (land) {
    lines.push('', '## Landed', '', `${json.base}..${String(land.body.commit)} on ${json.ref.replace(/^refs\/heads\//, '')}`)
    return lines
  }
  const blocked: string[] = []
  if (!st.done) blocked.push(st.open ? `the merge of ${st.open.body.task} stopped at a conflict` : 'the integration never finished')
  else blocked.push(...st.done.body.blocked)
  for (const s of st.skips) blocked.push(`task ${s.body.task} wasn't merged: ${s.body.reason}`)
  for (const c of checks) if (c && c.pass !== true && typeof c.id === 'string') blocked.push(`the verifier failed task ${c.id}`)
  for (const r of records) {
    if ((r.kind === 'land.blocked' || r.kind === 'land.abandoned') && r.body.gate === 'fanout' && typeof r.body.reason === 'string') blocked.push(r.body.reason)
  }
  if (blocked.length > 0) lines.push('', '## What blocked the land', '', ...blocked.map(b => `- ${oneLine(b, 1000)}`))
  return lines
}
