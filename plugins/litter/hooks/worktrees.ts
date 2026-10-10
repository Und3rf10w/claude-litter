// The mod's side of the run worktrees (plan section 9, "Run worktrees"):
// worktree.sh's spooled steps into the ledger, the worktrees the mod makes
// itself, worktree.json for your own worktrees, and cleanup after run.end.
// Owner: phase 2b, work package F. The signatures are the contract; the
// bodies are F's.
//
// The ledger is the record of what exists: `worktree.intent` before git
// touches anything, then `worktree.create` or `worktree.setup_failed`, and
// after the run's end `worktree.removed` or `worktree.kept`. Every git command
// here is the mod's own argv, built from validated parts, values after `--`
// (section 9, "Mod safety"). lifecycle.ts and this module import each other:
// lifecycle's exports are used only inside functions.

import type { Ports, RunResult, SpawnEnd } from './ports'
import type { LitterOptions } from './options'
import type { SpoolConsumer, SpoolLine, WorktreePolicy } from './hookfiles'
import type { Author, StoredRecord } from './records/core'
import type { RunJson, RunStatus } from './records/run'
import type {
  IntegrateMergeBody,
  TaskBindBody,
  WorktreeBody,
  WorktreeCreateBody,
  WorktreeKeptBody,
  WorktreeRemovedBody,
  WorktreeSetupFailedBody,
} from './records/fanout'
import { RESUMABLE } from './records/run'
import { appendRecord, elsewhere, owned, readLedger } from './ledgercore'
import {
  integrationName,
  ledgerDir,
  runDir as runDirOf,
  runJsonPath,
  RUN_ID,
  setupLogPart,
  verifyLogDir,
  verifyLogPart,
  worktreePolicyPath,
  writerBranch,
} from './layout'
import { atomicWriteJson, mkdirp, readJson, remove, serial } from './fsx'
import { readPolicy, updatePolicy } from './policy'
import { shellQuote } from './quote'
import { primaryOf, repoOf, runState, writeSummary } from './lifecycle'

/** A run's handle, as lifecycle.ts passes it. */
export type WorktreeRun = { run: string; runDir: string; litterDir: string }

const MOD: Author = { source: 'mod' }

// Exported (unchanged) where swarm/worktrees.ts reuses them (phase 2b-1, package C).

export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const nfc = (s: string): string => s.normalize('NFC')
const dirname = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')))
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
export const firstLine = (s: string): string => s.split('\n').map(l => l.trim()).find(l => l !== '') ?? 'no output'
const shown = (paths: readonly string[]): string =>
  paths.slice(0, 10).join(', ') + (paths.length > 10 ? `, and ${paths.length - 10} more` : '')

export const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/
/** A worktree name: one plain folder name. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/
/** A branch the mod makes or removes: never an option, never a pattern git would refuse. */
export const BRANCH = /^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\.lock$)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/
/** A workflow run id (`wf_` + the first 12 characters of a UUID, `:1493288`). */
const WF_ID = /^wf_[a-z0-9-]{6,}$/

/** Absolute, with no empty, `.` or `..` part, and nothing a line or a NUL could split. */
export const cleanAbsolute = (path: string): boolean =>
  path.startsWith('/') && path.length > 1 && !/[\0\n\r]/.test(path) && !path.slice(1).split('/').some(s => s === '' || s === '.' || s === '..')

export async function realOf(p: Ports, path: string): Promise<string> {
  try {
    return (await p.fs.stat(path, { resolve: true })).realPath ?? path
  } catch {
    return path
  }
}

/** `path` is `dir` or inside it. */
const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`)

export function git(p: Ports, cwd: string, argv: readonly string[], timeoutMs = 120_000): Promise<RunResult> {
  return p.run(['git', '-C', cwd, ...argv], { timeoutMs })
}

/** A checkout can take a while on a large repository: up to the engine's 10 minutes. */
const SLOW_GIT_MS = 600_000

export async function revParse(p: Ports, repo: string, ref: string): Promise<string | null> {
  const r = await git(p, repo, ['rev-parse', '-q', '--verify', `${ref}^{commit}`])
  return r.code === 0 ? r.stdout.trim() : null
}

/** Is `a` an ancestor of `b` (or `b` itself)? Null when git can't tell. */
export async function isAncestor(p: Ports, repo: string, a: string, b: string): Promise<boolean | null> {
  const r = await git(p, repo, ['merge-base', '--is-ancestor', a, b])
  return r.code === 0 ? true : r.code === 1 ? false : null
}

/** The commits on `branch` past `base`; null when git can't count them. */
export async function commitsPast(p: Ports, repo: string, base: string, branch: string): Promise<number | null> {
  const r = await git(p, repo, ['rev-list', '--count', `${base}..refs/heads/${branch}`])
  const n = Number(r.stdout.trim())
  return r.code === 0 && Number.isInteger(n) ? n : null
}

export type Listed = { path: string; head: string | null; branch: string | null; locked: boolean }

/** `git worktree list --porcelain -z`: every worktree git has registered, paths as git resolved them. */
export async function listWorktrees(p: Ports, repo: string): Promise<Listed[] | null> {
  const r = await git(p, repo, ['worktree', 'list', '--porcelain', '-z'])
  if (r.code !== 0) return null
  const out: Listed[] = []
  let cur: Listed | null = null
  for (const field of r.stdout.split('\0')) {
    if (field === '') {
      if (cur) out.push(cur)
      cur = null
      continue
    }
    const sp = field.indexOf(' ')
    const key = sp < 0 ? field : field.slice(0, sp)
    const value = sp < 0 ? '' : field.slice(sp + 1)
    if (key === 'worktree') {
      if (cur) out.push(cur)
      cur = { path: value, head: null, branch: null, locked: false }
    } else if (cur && key === 'HEAD') cur.head = value
    else if (cur && key === 'branch') cur.branch = value
    else if (cur && key === 'locked') cur.locked = true
  }
  if (cur) out.push(cur)
  return out
}

/** The registered worktree at `path`, matched as git resolved it. */
export async function listedAt(p: Ports, list: readonly Listed[], path: string): Promise<Listed | undefined> {
  const want = new Set([nfc(path), nfc(await realOf(p, path))])
  return list.find(w => want.has(nfc(w.path)))
}

export type Status = { changes: string[]; ignored: string[] }

/** `git status --porcelain --ignored -z` in a worktree: what's uncommitted, and the ignored paths, apart. */
export async function statusOf(p: Ports, path: string): Promise<Status | null> {
  const r = await git(p, path, ['status', '--porcelain', '--ignored', '-z'])
  if (r.code !== 0) return null
  const fields = r.stdout.split('\0')
  const out: Status = { changes: [], ignored: [] }
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i]!
    if (f.length < 4) continue
    const code = f.slice(0, 2)
    if (code === '!!') out.ignored.push(f.slice(3))
    else out.changes.push(f.slice(3))
    // A rename or copy carries its source as the next field.
    if (code[0] === 'R' || code[0] === 'C') i++
  }
  return out
}

/** Ignored paths now that the setup didn't leave: one is new unless a recorded path is it or holds it. */
export function newIgnored(now: readonly string[], recorded: readonly string[]): string[] {
  const bare = (s: string) => s.replace(/\/+$/, '')
  const known = recorded.map(bare)
  return now.filter(path => !known.some(k => bare(path) === k || path.startsWith(`${k}/`)))
}

// ---------------------------------------------------------------------------
// What the ledger says about each worktree name

const STEP_KINDS: readonly string[] = ['worktree.intent', 'worktree.create', 'worktree.setup_failed']

type StepRecord = StoredRecord<WorktreeBody & Record<string, unknown>>

const isWorktreeBody = (b: Record<string, unknown>): boolean =>
  typeof b.name === 'string' && typeof b.path === 'string' && typeof b.branch === 'string' && typeof b.base === 'string'

/** The mod's intent, create and setup_failed records for one name, in order. */
function stepsFor(records: readonly StoredRecord[], name: string): StepRecord[] {
  return records.filter(r => STEP_KINDS.includes(r.kind) && r.by.source === 'mod' && r.body.name === name && isWorktreeBody(r.body)) as StepRecord[]
}

const ignoredOf = (body: Record<string, unknown>): string[] =>
  Array.isArray(body.ignored) ? body.ignored.filter((x): x is string => typeof x === 'string') : []

/** The run's worktrees with a `worktree.create` (the latest per name), from its records. */
export function recordedWorktrees(records: readonly StoredRecord[]): WorktreeCreateBody[] {
  const byName = new Map<string, WorktreeCreateBody>()
  for (const r of records) {
    if (r.kind !== 'worktree.create' || r.by.source !== 'mod' || !isWorktreeBody(r.body)) continue
    const b = r.body as unknown as WorktreeCreateBody
    byName.set(b.name, { ...b, disposable: b.disposable === true, ignored: ignoredOf(r.body) })
  }
  return [...byName.values()]
}

/** One recorded worktree name as cleanup and the summary see it. */
type Tracked = {
  name: string
  path: string
  branch: string
  base: string
  disposable: boolean
  /** The ignored paths its setup left: none until a `worktree.create` says. */
  ignored: string[]
  /** `live` until cleanup records an outcome; a later intent or create makes it live again. */
  outcome: 'live' | 'kept' | 'removed'
  keptReason: string | null
}

function tracked(records: readonly StoredRecord[]): Map<string, Tracked> {
  const out = new Map<string, Tracked>()
  for (const r of records) {
    if (r.by.source !== 'mod' || typeof r.body.name !== 'string') continue
    const b = r.body
    const t = out.get(b.name as string)
    if (r.kind === 'worktree.intent' || r.kind === 'worktree.create') {
      if (!isWorktreeBody(b)) continue
      const created = r.kind === 'worktree.create'
      out.set(b.name as string, {
        name: b.name as string,
        path: b.path as string,
        branch: b.branch as string,
        base: b.base as string,
        disposable: b.disposable === true,
        ignored: created ? ignoredOf(b) : (t?.ignored ?? []),
        outcome: 'live',
        keptReason: null,
      })
    } else if (t && r.kind === 'worktree.kept') {
      t.outcome = 'kept'
      t.keptReason = typeof b.reason === 'string' ? b.reason : ''
    } else if (t && r.kind === 'worktree.removed') {
      t.outcome = 'removed'
      t.keptReason = null
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// The run's worktree root

const rootKey = (runDir: string) => `litter.worktreeRoot.${runDir}`

/**
 * Where litter's worktrees go for a litter directory: the primary checkout's
 * `.claude/worktrees`, resolved, or `litter-worktrees` beside a bare
 * repository's litter folder (its common dir). The one computation:
 * policyFor (lifecycle.ts) gives a run this root, worktreeRootFor falls back
 * to it, and swarm/worktrees.ts checks a swarm worktree's path against it.
 */
export async function litterWorktreeRoot(p: Ports, litterDir: string): Promise<string> {
  const primary = primaryOf(litterDir)
  return primary ? `${await realOf(p, primary)}/.claude/worktrees` : `${await realOf(p, dirname(litterDir))}/litter-worktrees`
}

/**
 * Where the run's litter worktrees go: the root policy.json gave the run,
 * kept in the store with the run so a drain or a cleanup after its end still
 * checks against it. Without either, it's litterWorktreeRoot's, as policyFor
 * computes it (lifecycle.ts).
 */
export async function worktreeRootFor(p: Ports, litterDir: string, run: string): Promise<string> {
  const dir = runDirOf(litterDir, run)
  const policy = await readPolicy(p, litterDir).catch(() => undefined)
  const given = policy?.run?.run === run ? policy.run.worktreeRoot : undefined
  if (typeof given === 'string' && cleanAbsolute(given)) {
    if ((await p.store.get(rootKey(dir))) !== given) await p.store.set(rootKey(dir), given)
    return given
  }
  const kept = await p.store.get(rootKey(dir))
  if (typeof kept === 'string' && cleanAbsolute(kept)) return kept
  return litterWorktreeRoot(p, litterDir)
}

// ---------------------------------------------------------------------------
// worktree.sh's spooled steps

type WorktreeLine = Extract<SpoolLine, { ev: 'worktree' }>

const STEP_KIND = { intent: 'worktree.intent', create: 'worktree.create', setup_failed: 'worktree.setup_failed' } as const

/** The agent index in `<runId>-<n>` for one of the run's workflow run ids, matched as a prefix (run ids hold dashes). */
function agentIndex(name: string, runIds: readonly string[]): number | null {
  for (const id of runIds) {
    if (!WF_ID.test(id) || !name.startsWith(`${id}-`)) continue
    const rest = name.slice(id.length + 1)
    if (/^(0|[1-9][0-9]{0,8})$/.test(rest)) return Number(rest)
  }
  return null
}

/** The record body a checked line becomes, or why it isn't one. */
function lineBody(line: WorktreeLine, runDir: string): Record<string, unknown> | string {
  const body: Record<string, unknown> = {
    run: line.run,
    name: line.name,
    path: line.path,
    branch: line.branch,
    base: line.base,
    disposable: line.disposable,
    spooled: { session_id: line.session_id, ts: line.ts },
  }
  if (line.step === 'create') {
    const ignored = line.ignored ?? []
    if (!Array.isArray(ignored) || ignored.some(x => typeof x !== 'string')) return "'ignored' isn't a list of paths"
    body.ignored = ignored
  } else if (line.step === 'setup_failed') {
    const code = line.exit_code ?? null
    if (code !== null && !Number.isInteger(code)) return "'exit_code' isn't a number or null"
    if (line.timed_out !== undefined && typeof line.timed_out !== 'boolean') return "'timed_out' isn't true or false"
    const logDir = `${verifyLogDir(runDir, `setup-${line.name}`)}/`
    if (typeof line.log !== 'string' || !cleanAbsolute(line.log) || !line.log.startsWith(logDir)) return `'log' isn't under ${logDir}`
    body.exit_code = code
    body.timed_out = line.timed_out === true
    body.log = line.log
  }
  return body
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * Spool consumer: worktree.sh's `worktree` lines become `worktree.intent`,
 * `worktree.create` and `worktree.setup_failed` records in the named run's
 * ledger (by the mod, once per step and name), and each created path joins
 * policy.json's `roots.worktrees`. A line for a run that isn't this
 * litterDir's, or whose path isn't `<worktreeRoot>/<name>`, is logged and
 * skipped.
 */
export const consumeWorktrees: SpoolConsumer = async (ctx, line) => {
  if (line.ev !== 'worktree') return
  const { p, litterDir } = ctx
  const skip = (why: string): void => p.log(`worktree ${String(line.name)} of run ${String(line.run)}: ${why}; not recorded`)
  if (typeof line.step !== 'string' || !Object.hasOwn(STEP_KIND, line.step)) return skip(`unknown step ${JSON.stringify(line.step)}`)
  if (!RUN_ID.test(line.run)) return skip("the run isn't a run id")
  if (!NAME.test(line.name)) return skip("the name can't name a worktree folder")
  if (typeof line.disposable !== 'boolean') return skip("'disposable' isn't true or false")
  const dir = runDirOf(litterDir, line.run)
  const json = await readJson<RunJson>(p, runJsonPath(dir)).catch(() => undefined)
  if (!json || json.v !== 1 || json.run !== line.run) return skip(`there's no run ${line.run} in ${litterDir}`)
  const kind = STEP_KIND[line.step]
  const created = await serial(`worktrees:${dir}`, async (): Promise<boolean> => {
    const read = await readLedger(p, dir, line.run)
    const { records, tampered } = read
    if (tampered) {
      skip(`the run's ledger is tampered at ${tampered.seq}`)
      return false
    }
    // A spool this session drained can hold another host's lines (policy.ts, drainAllSpools).
    if ((await owned(p, dir, read)) !== 'mine') {
      skip(elsewhere(line.run))
      return false
    }
    const st = runState(records)
    if (!st.start) {
      skip('the run has no run.start')
      return false
    }
    // An ended run's line is still recorded, so leftover cleanup finds the worktree at the next session.start.
    if (st.ended) p.log(`worktree ${line.name} of run ${line.run}: a ${line.step} after the run ended; recorded for cleanup`)
    if (line.base !== json.base) {
      skip(`base ${line.base} isn't the run's ${json.base}`)
      return false
    }
    const policy = await readPolicy(p, litterDir).catch(() => undefined)
    const runIds = [...st.generations.map(g => g.runId), ...(policy?.run?.run === line.run ? policy.run.runIds : [])]
    const n = agentIndex(line.name, runIds)
    if (n === null) {
      skip("the name isn't one of the run's workflow run ids plus -<n>")
      return false
    }
    const root = await worktreeRootFor(p, litterDir, line.run)
    if (nfc(line.path) !== nfc(`${root}/${line.name}`)) {
      skip(`the path ${line.path} isn't ${root}/${line.name}`)
      return false
    }
    const branch = writerBranch(line.run, n)
    if (line.branch !== branch) {
      skip(`the branch ${line.branch} isn't ${branch}`)
      return false
    }
    // Only a design run's worktrees are discarded after the end (section 9, "Disposable worktrees").
    if (line.disposable !== (json.workflow === 'design')) {
      skip(`'disposable' is ${line.disposable}, but run ${line.run} is a ${json.workflow} run`)
      return false
    }
    const body = lineBody(line, dir)
    if (typeof body === 'string') {
      skip(body)
      return false
    }
    // A line drained twice (a crash between delivery and the spool's removal) is a record already: same step, same line.
    if (!stepsFor(records, line.name).some(r => r.kind === kind && sameJson(r.body, body))) {
      await appendRecord(p, dir, { run: line.run, kind, by: MOD, body })
    }
    return kind === 'worktree.create'
  })
  if (!created) return
  // The guard compares roots exactly, so it gets the path resolved (section 9, "Mod-to-hook state").
  const real = await realOf(p, line.path)
  await updatePolicy(p, litterDir, pol => {
    const roots = pol.run?.run === line.run ? (pol.run.roots.worktrees ?? []) : null
    return pol.run && roots && !roots.includes(real) ? { ...pol, run: { ...pol.run, roots: { ...pol.run.roots, worktrees: [...roots, real] } } } : null
  })
}

// ---------------------------------------------------------------------------
// The mod's own worktrees

/** What the mod needs to make one worktree itself: the integration worktree, or the run worktree. */
export type ModWorktreeSpec = WorktreeBody & {
  runDir: string
  /** The run's checkout: the repository to add the worktree from, and linkDirs' source. */
  checkout: string
  setup: string[] | null
  linkDirs: string[]
}

type Made = { ok: true; path: string; ignored: string[] } | { ok: false; reason: string }

function specProblem(spec: ModWorktreeSpec): string | null {
  if (typeof spec.run !== 'string' || !RUN_ID.test(spec.run)) return "'run' isn't a run id"
  if (typeof spec.name !== 'string' || !NAME.test(spec.name)) return `the name '${String(spec.name)}' can't name a worktree folder`
  if (typeof spec.path !== 'string' || !cleanAbsolute(spec.path) || !spec.path.endsWith(`/${spec.name}`)) {
    return `the path ${String(spec.path)} must be absolute, end in the name, and have no empty, . or .. part`
  }
  if (typeof spec.branch !== 'string' || !BRANCH.test(spec.branch)) return `the branch '${String(spec.branch)}' isn't one the mod makes`
  if (typeof spec.base !== 'string' || !OID.test(spec.base)) return "'base' isn't a commit id"
  if (typeof spec.checkout !== 'string' || !cleanAbsolute(spec.checkout)) return "'checkout' isn't an absolute path"
  if (typeof spec.runDir !== 'string' || !cleanAbsolute(spec.runDir)) return "'runDir' isn't an absolute path"
  if (spec.setup !== null && (!Array.isArray(spec.setup) || spec.setup.length === 0 || spec.setup.some(a => typeof a !== 'string'))) {
    return "'setup' isn't an argv"
  }
  if (!Array.isArray(spec.linkDirs) || spec.linkDirs.some(d => typeof d !== 'string')) return "'linkDirs' isn't a list of folders"
  return null
}

/** An existing path that isn't an empty folder: something a worktree add would clobber or fail on. */
async function occupied(p: Ports, path: string): Promise<boolean> {
  const s = await p.fs.stat(path).catch(() => null)
  if (!s) return false
  if (s.kind !== 'dir' || s.isLink) return true
  return (await p.fs.list(path)).length > 0
}

/**
 * A replay's checks (section 9, "A replay"): `git worktree list` shows the
 * path on the recorded branch, `base` is an ancestor of its HEAD and still
 * the fork point, and nothing is unmerged or mid-operation. `gone` when the
 * worktree isn't there any more but its branch would pass.
 */
export async function replayCheck(p: Ports, spec: ModWorktreeSpec): Promise<'reuse' | 'gone' | string> {
  const list = await listWorktrees(p, spec.checkout)
  if (!list) return `git worktree list failed in ${spec.checkout}`
  const at = await listedAt(p, list, spec.path)
  if (!at || !(await p.fs.exists(spec.path))) {
    if (await occupied(p, spec.path)) return `${spec.path} exists but isn't a worktree of this repository`
    const tip = await revParse(p, spec.checkout, `refs/heads/${spec.branch}`)
    if (!tip) return `the recorded worktree is gone, and so is its branch ${spec.branch}`
    if ((await isAncestor(p, spec.checkout, spec.base, tip)) !== true) return `${spec.branch}'s fork point isn't ${spec.base}`
    return 'gone'
  }
  if (at.branch !== `refs/heads/${spec.branch}`) {
    return `it's checked out on ${at.branch ? at.branch.replace(/^refs\/heads\//, '') : 'a detached HEAD'}, not ${spec.branch}`
  }
  const head = at.head ?? ''
  if (!OID.test(head) || (await isAncestor(p, spec.checkout, spec.base, head)) !== true) return `${spec.base} isn't an ancestor of its HEAD ${head}`
  const mb = await git(p, spec.checkout, ['merge-base', `refs/heads/${spec.branch}`, spec.base])
  if (mb.code !== 0 || mb.stdout.trim() !== spec.base) return `${spec.branch}'s fork point isn't ${spec.base}`
  const unmerged = await git(p, spec.path, ['ls-files', '-u', '-z'])
  if (unmerged.code !== 0 || unmerged.stdout !== '') return 'it has unmerged paths'
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply']) {
    const at2 = await git(p, spec.path, ['rev-parse', '--path-format=absolute', '--git-path', marker])
    if (at2.code !== 0) return `git rev-parse failed in it: ${firstLine(at2.stderr)}`
    if (await p.fs.exists(at2.stdout.trim())) return `a ${marker === 'MERGE_HEAD' ? 'merge' : marker.startsWith('rebase') ? 'rebase' : marker === 'REVERT_HEAD' ? 'revert' : 'cherry-pick'} is in progress in it`
  }
  return 'reuse'
}

/**
 * The git steps of a first or unfinished request (section 9, "An unfinished
 * request"), never repeating `-b`: neither branch nor path exists, add with
 * `-b`; the branch exists unregistered, add without `-b`; the worktree is
 * registered on the branch, keep it, or replace a checkout cut off part way.
 * A worktree that was created before (`created`, re-added after it went)
 * needs only `base` as an ancestor; one never handed out needs the branch at
 * `base`. Null when the worktree is in place, else the facts that block it.
 */
export async function place(p: Ports, spec: ModWorktreeSpec, created: boolean): Promise<string | null> {
  const repo = spec.checkout
  const list = await listWorktrees(p, repo)
  if (!list) return `git worktree list failed in ${repo}`
  const at = await listedAt(p, list, spec.path)
  const ref = `refs/heads/${spec.branch}`
  const elsewhere = list.find(w => w !== at && w.branch === ref)
  if (elsewhere) return `${spec.branch} is checked out at ${elsewhere.path}`
  const tip = await revParse(p, repo, ref)
  const dirThere = await p.fs.exists(spec.path)
  const add = async (argv: string[]): Promise<string | null> => {
    const r = await git(p, repo, ['worktree', 'add', ...argv], SLOW_GIT_MS)
    return r.code === 0 ? null : `git worktree add failed: ${firstLine(r.stderr)}`
  }
  if (tip === null) {
    if (created) return `its branch ${spec.branch} is gone`
    if (at) return `${spec.path} is a registered worktree, but ${spec.branch} doesn't exist`
    if (await occupied(p, spec.path)) return `${spec.path} exists but isn't a worktree of this repository`
    return add(['-b', spec.branch, '--', spec.path, spec.base])
  }
  if (!created && tip !== spec.base) {
    const past = await commitsPast(p, repo, spec.base, spec.branch)
    return past !== null && past > 0
      ? `${spec.branch} has ${plural(past, 'commit')} past ${spec.base}`
      : `${spec.branch} is at ${tip}, not at ${spec.base}`
  }
  if (created && (await isAncestor(p, repo, spec.base, tip)) !== true) return `${spec.branch}'s fork point isn't ${spec.base}`
  if (at && dirThere) {
    if (at.branch !== ref) return `${spec.path} is a worktree on ${at.branch ? at.branch.replace(/^refs\/heads\//, '') : 'a detached HEAD'}, not ${spec.branch}`
    // Nothing in it was handed to an agent before its create, so a checkout cut off part way is replaced.
    const st = await git(p, spec.path, ['status', '--porcelain', '-z'])
    if (st.code === 0 && st.stdout === '') return null
    const rm = await git(p, repo, ['worktree', 'remove', '--force', '--', spec.path], SLOW_GIT_MS)
    if (rm.code !== 0) return `git worktree remove failed: ${firstLine(rm.stderr)}`
    return add(['--', spec.path, spec.branch])
  }
  if (at) {
    // Registered, but its folder is gone: clear the registration (a locked one refuses).
    const rm = await git(p, repo, ['worktree', 'remove', '--', spec.path])
    if (rm.code !== 0) return `${spec.path} is registered but missing, and git won't clear it: ${firstLine(rm.stderr)}`
  }
  if (await occupied(p, spec.path)) return `${spec.path} exists but isn't a worktree of this repository`
  return add(['--', spec.path, spec.branch])
}

/** How long a killed setup gets to end before the mod goes on. */
const KILL_GRACE_MS = 5_000
const PART_BYTES = 1024 * 1024

const utf8 = (s: string): number => new TextEncoder().encode(s).length

/** A setup's output in numbered parts, `verify/setup-<name>/0001.log` first, both streams as they arrived. */
class SetupLog {
  parts = 0
  private buf = ''
  private bytes = 0
  constructor(
    private readonly p: Ports,
    private readonly runDir: string,
    private readonly name: string,
  ) {}

  async add(text: string): Promise<void> {
    this.buf += text
    this.bytes += utf8(text)
    if (this.bytes >= PART_BYTES) await this.flush()
  }

  /** Always leaves at least the first part, so the record's `log` names a file. */
  async close(): Promise<void> {
    if (this.bytes > 0 || this.parts === 0) await this.flush()
  }

  private async flush(): Promise<void> {
    this.parts++
    await this.p.fs.write(verifyLogPart(this.runDir, `setup-${this.name}`, this.parts), this.buf)
    this.buf = ''
    this.bytes = 0
  }
}

/** A timer through the ports, so the engine's clock runs it (and a test fires it). */
function after(p: Ports, ms: number): { promise: Promise<'timeout'>; cancel: () => void } {
  let fire!: () => void
  const promise = new Promise<'timeout'>(resolve => (fire = () => resolve('timeout')))
  const t = p.every(Math.max(1, ms), () => {
    t.cancel()
    fire()
  })
  return { promise, cancel: () => t.cancel() }
}

export type SetupEnd = { exit_code: number | null; signal: string | null; timed_out: boolean; spawn_error: string | null; parts: number }

/**
 * The approved setup argv in the worktree's root, streamed with
 * `$.process.spawn` into the setup log (verify.ts streams the same way).
 * `$.process.spawn` has no timeout, so the mod leaves the read loop at
 * `verifyTimeoutMs`, which kills the child.
 */
export async function runSetup(p: Ports, argv: readonly string[], spec: ModWorktreeSpec, timeoutMs: number): Promise<SetupEnd> {
  // A retry starts its log afresh, so no part of an earlier run is left beside it.
  await remove(p, verifyLogDir(spec.runDir, `setup-${spec.name}`)).catch(() => undefined)
  const log = new SetupLog(p, spec.runDir, spec.name)
  const clock = after(p, timeoutMs)
  const stream = p.spawn({ argv, cwd: spec.path })
  let end: SpawnEnd = { code: null, signal: null }
  let timedOut = false
  let spawnError: string | null = null
  let pending = stream.next()
  try {
    for (;;) {
      const r = await Promise.race([pending, clock.promise])
      if (r === 'timeout') {
        timedOut = true
        break
      }
      if (r.done) {
        end = r.value
        break
      }
      await log.add(r.value.text)
      pending = stream.next()
    }
  } catch (err) {
    // It couldn't start, or its stream broke: the child, if any, is killed.
    spawnError = errText(err)
    void stream.return({ code: null, signal: null }).catch(() => undefined)
    await log.add(`litter: the setup command failed to run: ${spawnError}\n`)
  } finally {
    clock.cancel()
  }
  if (timedOut) {
    pending.catch(() => undefined)
    const grace = after(p, KILL_GRACE_MS)
    await Promise.race([stream.return({ code: null, signal: null }).catch(() => undefined), grace.promise])
    grace.cancel()
    end = { code: null, signal: end.signal }
    await log.add(`litter: the setup command ran past ${Math.round(timeoutMs / 1000)} s and was killed\n`)
  }
  await log.close()
  return { exit_code: end.code, signal: end.signal, timed_out: timedOut, spawn_error: spawnError, parts: log.parts }
}

/** How a setup ended, for a refusal. */
export function setupEnded(e: SetupEnd): string {
  if (e.spawn_error !== null) return `couldn't run (${e.spawn_error})`
  if (e.timed_out) return 'timed out'
  if (e.exit_code === null) return `was killed by ${e.signal ?? 'a signal'}`
  return `failed (exit ${e.exit_code})`
}

/**
 * linkDirs, with worktree.sh's checks (section 7, fanout.js step 3,
 * "Dependencies"): a relative folder without `..`, present in the checkout,
 * and ignored *as a link* in the new worktree (`git check-ignore` on the name
 * without its slash); a link that already points at the checkout's folder is
 * left alone. Null when every link is in place, else why not.
 */
export async function linkDirs(p: Ports, spec: ModWorktreeSpec): Promise<string | null> {
  for (const entry of spec.linkDirs) {
    const rel = entry.replace(/\/+$/, '')
    if (rel === '' || rel.startsWith('/') || rel.split('/').some(s => s === '' || s === '.' || s === '..')) {
      return `linkDirs entry '${entry}' must be a relative folder with no '.' or '..' part`
    }
    const src = `${spec.checkout}/${rel}`
    const from = await p.fs.stat(src).catch(() => null)
    if (!from || from.kind !== 'dir') return `linkDirs entry '${entry}' isn't a folder in the checkout ${spec.checkout}`
    const ci = await git(p, spec.path, ['check-ignore', '-q', '--', rel])
    if (ci.code === 1) {
      return `linkDirs entry '${entry}' isn't ignored as a link, so the link would go into the snapshot; ignore '${rel}' without a trailing slash`
    }
    if (ci.code !== 0) return `git check-ignore failed for linkDirs entry '${entry}': ${firstLine(ci.stderr)}`
    const dst = `${spec.path}/${rel}`
    const have = await p.fs.stat(dst, { resolve: true }).catch(() => null)
    if (have && !have.isLink) return `linkDirs entry '${entry}' is already a ${have.kind === 'dir' ? 'folder' : 'file'} in the worktree, not a link`
    if (have?.realPath !== undefined && have.realPath === (await realOf(p, src))) continue
    // -n replaces a link that points elsewhere (or nowhere) instead of following it.
    await mkdirp(p, dirname(dst))
    const ln = await p.run(['ln', '-sfn', '--', src, dst])
    if (ln.code !== 0) return `couldn't link ${dst} to ${src}: ${firstLine(ln.stderr)}`
  }
  return null
}

/**
 * Makes a worktree the way worktree.sh makes a litter one, recorded straight
 * into the ledger: a first request (intent, `git worktree add -b`, HEAD at
 * base, setup or linkDirs, create), an unfinished one (intent without create:
 * finished without `-b`), or a replay (create recorded: reused after the
 * ancestry checks). Anything else is refused with the facts. Resolves the
 * created path, resolved, and the ignored paths the setup left.
 *
 * A refusal after the intent is recorded as `worktree.setup_failed` with the
 * reason in its log, so the intent never stays open (a stopping run settles
 * only once every intent has an outcome), and the next request retries it.
 */
export async function addModWorktree(
  p: Ports,
  options: LitterOptions,
  spec: ModWorktreeSpec,
): Promise<{ ok: true; path: string; ignored: string[] } | { ok: false; reason: string }> {
  const bad = specProblem(spec)
  if (bad) return { ok: false, reason: `litter: can't make worktree ${String(spec.name)}: ${bad}` }
  return serial(`worktree:${spec.runDir}:${spec.name}`, () => makeWorktree(p, options, spec))
}

async function makeWorktree(p: Ports, options: LitterOptions, spec: ModWorktreeSpec): Promise<Made> {
  const body: WorktreeBody = { run: spec.run, name: spec.name, path: spec.path, branch: spec.branch, base: spec.base, disposable: spec.disposable === true }
  const refuse = (reason: string): Made => ({ ok: false, reason: `litter: worktree ${spec.name} at ${spec.path}: ${reason}` })
  const { records, tampered } = await readLedger(p, spec.runDir, spec.run)
  if (tampered) return refuse(`run ${spec.run}'s ledger is tampered at record ${tampered.seq}`)
  const steps = stepsFor(records, spec.name)
  const differs = steps.find(s => s.body.path !== spec.path || s.body.branch !== spec.branch || s.body.base !== spec.base)
  if (differs) return refuse(`the ledger records it at ${String(differs.body.path)} on ${String(differs.body.branch)} from ${String(differs.body.base)}`)
  const last = steps.at(-1)
  const created = steps.some(s => s.kind === 'worktree.create')
  if (last?.kind === 'worktree.create') {
    const again = await replayCheck(p, spec)
    if (again === 'reuse') return { ok: true, path: await realOf(p, spec.path), ignored: ignoredOf(last.body) }
    if (again !== 'gone') return refuse(again)
  }

  // The intent before git touches anything: a first request, or a recorded worktree that's gone and is added again.
  if (!last || last.kind === 'worktree.create') await appendRecord<WorktreeBody>(p, spec.runDir, { run: spec.run, kind: 'worktree.intent', by: MOD, body })
  const failed: Failed = async (reason, end) => {
    const log = setupLogPart(spec.runDir, spec.name)
    if (!end) {
      await remove(p, verifyLogDir(spec.runDir, `setup-${spec.name}`)).catch(() => undefined)
      await p.fs.write(log, `litter: refused: ${reason}\n`)
    }
    await appendRecord<WorktreeSetupFailedBody>(p, spec.runDir, {
      run: spec.run,
      kind: 'worktree.setup_failed',
      by: MOD,
      body: { ...body, exit_code: end?.exit_code ?? null, timed_out: end?.timed_out ?? false, log },
    })
    return refuse(reason)
  }
  try {
    return await finish(p, options, spec, body, created, failed)
  } catch (err) {
    // A git call that couldn't run or ran out of time: the intent still gets its outcome.
    return failed(`making it failed: ${errText(err)}`, null)
  }
}

type Failed = (reason: string, end: { exit_code: number | null; timed_out: boolean } | null) => Promise<Made>

/** Everything after the intent: the git steps, the HEAD check, linkDirs or setup, then the create. */
async function finish(p: Ports, options: LitterOptions, spec: ModWorktreeSpec, body: WorktreeBody, created: boolean, failed: Failed): Promise<Made> {
  const blocked = await place(p, spec, created)
  if (blocked) return failed(blocked, null)
  const head = await revParse(p, spec.path, 'HEAD')
  if (!head) return failed("its HEAD doesn't resolve", null)
  if (!created && head !== spec.base) return failed(`its HEAD is ${head}, not ${spec.base}`, null)
  if (created && (await isAncestor(p, spec.checkout, spec.base, head)) !== true) return failed(`${spec.base} isn't an ancestor of its HEAD ${head}`, null)

  const links = await linkDirs(p, spec)
  if (links) return failed(links, null)
  if (spec.setup) {
    const end = await runSetup(p, spec.setup, spec, options.verifyTimeoutMs)
    if (end.spawn_error !== null || end.timed_out || end.exit_code !== 0) {
      const where = end.parts > 1 ? `the parts in ${verifyLogDir(spec.runDir, `setup-${spec.name}`)}` : setupLogPart(spec.runDir, spec.name)
      return failed(`the setup command ${shellQuote(spec.setup)} ${setupEnded(end)}; its output is in ${where}`, end)
    }
  }
  const st = await statusOf(p, spec.path)
  if (!st) return failed('git status failed in it after the setup', null)
  await appendRecord<WorktreeCreateBody>(p, spec.runDir, { run: spec.run, kind: 'worktree.create', by: MOD, body: { ...body, ignored: st.ignored } })
  return { ok: true, path: await realOf(p, spec.path), ignored: st.ignored }
}

// ---------------------------------------------------------------------------
// worktree.json

/** worktree.json's values from the merged settings: `baseRef` `head` or else `fresh`, and the strings of `symlinkDirectories`. */
export function worktreePolicyOf(settings: Readonly<Record<string, unknown>>): WorktreePolicy {
  const raw = settings.worktree
  const wt = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const links = Array.isArray(wt.symlinkDirectories) ? wt.symlinkDirectories.filter((d): d is string => typeof d === 'string') : []
  return { v: 1, baseRef: wt.baseRef === 'head' ? 'head' : 'fresh', symlinkDirectories: links }
}

/** Rewrites worktree.json when the settings' values differ from the file's (or there's no file). */
async function syncWorktreePolicy(p: Ports, litterDir: string): Promise<void> {
  const want = worktreePolicyOf(await p.settings())
  const path = worktreePolicyPath(litterDir)
  const have = await readJson<unknown>(p, path).catch(() => undefined)
  if (sameJson(have, want)) return
  await atomicWriteJson(p, path, want)
}

let policyTimer: { cancel(): void } | null = null
let policySyncing = false

/** How often the settings are read again for worktree.json (section 9, "Run worktrees"). */
export const WORKTREE_POLICY_EVERY_MS = 30_000

/**
 * Writes worktree.json from the merged settings (`worktree.baseRef`,
 * `worktree.symlinkDirectories`) now, and again whenever a 30 s check finds
 * them changed. Called once per session.start; a later call replaces the timer.
 */
export async function startWorktreePolicy(p: Ports, litterDir: string): Promise<void> {
  // The timer first, so a failed first write is tried again on the next check.
  policyTimer?.cancel()
  policyTimer = p.every(WORKTREE_POLICY_EVERY_MS, () => {
    if (policySyncing) return
    policySyncing = true
    void syncWorktreePolicy(p, litterDir)
      .catch(err => p.log(`worktree.json not written: ${errText(err)}`))
      .finally(() => {
        policySyncing = false
      })
  })
  await syncWorktreePolicy(p, litterDir)
}

// ---------------------------------------------------------------------------
// Cleanup after run.end (plan section 9, "Cleanup is the mod's")

type Outcome = { keep: string } | { removed: WorktreeRemovedBody }

/** What a run's records say about its landing, merges and bindings, for cleanup's rules. */
type RunFacts = {
  run: string
  status: RunStatus
  root: string
  /** `litter/<run>`, never deleted. */
  runBranch: string
  integration: string
  /** The landed result's commit (the integration tip for a fanout), or null when nothing landed. */
  landed: string | null
  merges: IntegrateMergeBody[]
  bindings: { agent: string; body: TaskBindBody }[]
}

function runFacts(records: readonly StoredRecord[], json: RunJson | undefined, ref: WorktreeRun, status: RunStatus, root: string): RunFacts {
  const start = runState(records).start
  const runBranch = (json?.ref ?? start?.ref ?? `refs/heads/litter/${ref.run}`).replace(/^refs\/heads\//, '')
  const land = records.filter(r => r.kind === 'land' && typeof r.body.commit === 'string').at(-1)
  const merges = records
    .filter(r => r.kind === 'integrate.merge' && r.by.source === 'mod' && typeof r.body.task === 'string' && typeof r.body.branch === 'string')
    .map(r => r.body as unknown as IntegrateMergeBody)
  const bindings = records
    .filter(r => r.kind === 'task.bind' && r.by.source === 'agent' && typeof r.body.task === 'string')
    .map(r => ({ agent: (r.by as { agentId: string }).agentId, body: r.body as unknown as TaskBindBody }))
  return {
    run: ref.run,
    status,
    root,
    runBranch,
    integration: integrationName(ref.run),
    landed: land ? (land.body.commit as string) : null,
    merges,
    bindings,
  }
}

/** The latest binding of this worktree, by name, and whether a later binding of its task moved to another worktree. */
function bindingOf(facts: RunFacts, t: Tracked): { task: string; superseded: boolean } | null {
  const mine = facts.bindings.filter(b => b.body.worktree?.name === t.name || b.body.worktree?.path === t.path).at(-1)
  if (!mine) return null
  const latest = facts.bindings.filter(b => b.body.task === mine.body.task).at(-1)!
  return { task: mine.body.task, superseded: latest.body.worktree?.name !== t.name }
}

/** Why a changed worktree is kept: what it holds, and why that didn't land. */
function keptWhy(facts: RunFacts, t: Tracked, past: number, changes: readonly string[]): string {
  const holds = [past > 0 ? `${plural(past, 'commit')} past base on ${t.branch}` : '', changes.length > 0 ? `uncommitted changes (${shown(changes)})` : '']
    .filter(Boolean)
    .join(' and ')
  let why: string
  if (t.name === facts.integration) why = facts.landed ? "the land didn't take its tip" : `the run ended ${facts.status} without landing`
  else if (t.branch === facts.runBranch) why = "it's the run's own worktree"
  else {
    const b = bindingOf(facts, t)
    if (!b) why = 'no task was bound to it'
    else if (b.superseded) why = `its binding to task ${b.task} was superseded`
    else if (!facts.landed) why = `task ${b.task} didn't land (the run ended ${facts.status})`
    else why = `task ${b.task}'s branch isn't in the landed result`
  }
  return `${why}, and it holds ${holds}`
}

/** `git branch -D` of a removed worktree's branch: undefined once deleted, else why it stays. Never `litter/<run>`. */
async function dropBranch(p: Ports, repo: string, facts: RunFacts, branch: string): Promise<string | undefined> {
  if (branch === facts.runBranch) return "it's the run's own branch"
  const r = await git(p, repo, ['branch', '-D', '--', branch])
  return r.code === 0 ? undefined : `git branch -D refused: ${firstLine(r.stderr)}`
}

const removedBody = (t: Tracked, forced: boolean, branchKept: string | undefined): Outcome => ({
  removed: { name: t.name, path: t.path, branch: t.branch, forced, ...(branchKept ? { branch_kept: branchKept } : {}) },
})

/** One worktree's outcome under the rules (section 9, "Cleanup is the mod's"). */
async function decide(p: Ports, repo: string, cwd: string, list: readonly Listed[], facts: RunFacts, t: Tracked): Promise<Outcome> {
  const real = await realOf(p, t.path)
  if (inside(cwd, real) || inside(cwd, t.path)) return { keep: "the session's working directory is inside it" }
  const at = await listedAt(p, list, t.path)
  if (!at) return { keep: "git doesn't list it as one of this repository's worktrees, so litter leaves it alone" }
  if (at.branch !== `refs/heads/${t.branch}`) {
    return { keep: `it's checked out on ${at.branch ? at.branch.replace(/^refs\/heads\//, '') : 'a detached HEAD'}, not ${t.branch}` }
  }
  const tip = await revParse(p, repo, `refs/heads/${t.branch}`)
  const past = await commitsPast(p, repo, t.base, t.branch)
  if (!tip || past === null) return { keep: `git can't compare ${t.branch} with base ${t.base}` }

  // A design's prober worktrees are discarded on purpose: only a commit, which a prober can't make, keeps one.
  if (t.disposable) {
    if (nfc(t.path) !== nfc(`${facts.root}/${t.name}`)) return { keep: `it isn't at ${facts.root}/${t.name}, where litter makes a prober's worktree` }
    if (past > 0) return { keep: `${t.branch} has ${plural(past, 'commit')} past base, which a prober can't make; look at it before removing it` }
    const rm = await git(p, repo, ['worktree', 'remove', '--force', '--force', '--', t.path], SLOW_GIT_MS)
    if (rm.code !== 0) return { keep: `git refused to remove it: ${firstLine(rm.stderr)}` }
    return removedBody(t, true, await dropBranch(p, repo, facts, t.branch))
  }

  // Everything else is removed only unforced, when merged into a landed result or unchanged.
  const st = await statusOf(p, t.path)
  if (!st) return { keep: 'git status failed in it' }
  let merged = false
  if (facts.landed) {
    if (t.name === facts.integration) merged = facts.landed === tip
    else {
      const b = bindingOf(facts, t)
      merged = b !== null && facts.merges.some(m => m.task === b.task && m.branch === t.branch)
    }
    // Its commits must stay reachable from litter/<run>.
    if (merged) merged = (await isAncestor(p, repo, tip, `refs/heads/${facts.runBranch}`)) === true
  }
  const unchanged = past === 0 && st.changes.length === 0
  if (!merged && !unchanged) return { keep: keptWhy(facts, t, past, st.changes) }
  if (st.changes.length > 0) return { keep: `its commits landed, but it holds uncommitted changes that didn't (${shown(st.changes)})` }
  // An unforced remove still deletes ignored files (tenth review).
  const fresh = newIgnored(st.ignored, t.ignored)
  if (fresh.length > 0) return { keep: `it holds ignored paths its setup didn't leave (${shown(fresh)}), which removing it would delete` }
  const rm = await git(p, repo, ['worktree', 'remove', '--', t.path], SLOW_GIT_MS)
  if (rm.code !== 0) return { keep: `git refused to remove it: ${firstLine(rm.stderr)}` }
  return removedBody(t, false, await dropBranch(p, repo, facts, t.branch))
}

/** Applies the rules to the run's recorded worktrees still on disk. Resolves how many outcomes it recorded. */
async function cleanup(p: Ports, ref: WorktreeRun, status: RunStatus): Promise<number> {
  const read = await readLedger(p, ref.runDir, ref.run)
  const { records, tampered } = read
  if (tampered) {
    p.log(`worktree cleanup for ${ref.run}: the ledger is tampered at ${tampered.seq}; nothing removed`)
    return 0
  }
  if ((await owned(p, ref.runDir, read)) !== 'mine') {
    p.log(`worktree cleanup for ${ref.run}: ${elsewhere(ref.run)}; nothing removed`)
    return 0
  }
  const targets = [...tracked(records).values()].filter(t => t.outcome !== 'removed')
  if (targets.length === 0) return 0
  const json = await readJson<RunJson>(p, runJsonPath(ref.runDir)).catch(() => undefined)
  const facts = runFacts(records, json, ref, status, await worktreeRootFor(p, ref.litterDir, ref.run))
  const repo = repoOf(ref.litterDir)
  const cwd = await realOf(p, await p.cwd())
  const resumable = RESUMABLE.includes(status)
  // One listing for the run: removing one worktree changes nothing git says about another.
  const list = resumable ? [] : await listWorktrees(p, repo)
  let wrote = 0
  for (const t of targets) {
    if (!(await p.fs.exists(t.path))) continue
    let outcome: Outcome
    try {
      outcome = resumable
        ? { keep: `the run ended ${status}, which can be resumed, so it's kept until the run is resumed or discarded` }
        : list
          ? await decide(p, repo, cwd, list, facts, t)
          : { keep: `git worktree list failed in ${repo}` }
    } catch (err) {
      outcome = { keep: `cleanup couldn't check it (${errText(err)})` }
    }
    if ('keep' in outcome) {
      // The same outcome as the last cleanup's: nothing new to record.
      if (t.outcome === 'kept' && t.keptReason === outcome.keep) continue
      await appendRecord<WorktreeKeptBody>(p, ref.runDir, {
        run: ref.run,
        kind: 'worktree.kept',
        by: MOD,
        body: { name: t.name, path: t.path, branch: t.branch, reason: outcome.keep },
      })
    } else {
      await appendRecord<WorktreeRemovedBody>(p, ref.runDir, { run: ref.run, kind: 'worktree.removed', by: MOD, body: outcome.removed })
    }
    wrote++
  }
  return wrote
}

/**
 * Cleanup after a generation's run.end (plan section 9, "Cleanup is the
 * mod's"), before summary.md is written. A resumable end (RESUMABLE) keeps
 * everything. Otherwise: disposable worktrees are discarded, merged writers'
 * of a landed fanout and unchanged ones are removed without --force, and the
 * rest are kept; each outcome is recorded as `worktree.removed` or
 * `worktree.kept`.
 */
export async function cleanupRun(p: Ports, run: WorktreeRun, status: RunStatus): Promise<void> {
  await serial(`cleanup:${run.runDir}`, () => cleanup(p, run, status))
}

/** The runs whose ledgers name a worktree, oldest first. */
async function runsWithWorktrees(p: Ports, litterDir: string): Promise<string[]> {
  if (!(await p.fs.exists(litterDir))) return []
  const out: string[] = []
  for (const e of await p.fs.list(litterDir)) {
    if (e.kind !== 'dir' || e.isLink || !RUN_ID.test(e.name)) continue
    const dir = ledgerDir(runDirOf(litterDir, e.name))
    if (!(await p.fs.exists(dir))) continue
    if ((await p.fs.list(dir)).some(f => /-worktree\.(intent|create)\.json$/.test(f.name))) out.push(e.name)
  }
  return out.sort()
}

/** At session.start: recorded worktrees of ended runs still on disk get the same cleanup; another store's runs get theirs from it. */
export async function cleanupLeftovers(p: Ports, litterDir: string): Promise<void> {
  for (const run of await runsWithWorktrees(p, litterDir)) {
    const ref: WorktreeRun = { run, runDir: runDirOf(litterDir, run), litterDir }
    try {
      const read = await readLedger(p, ref.runDir, run)
      const { records, tampered } = read
      if (tampered || (await owned(p, ref.runDir, read)) !== 'mine') continue
      const st = runState(records)
      const end = st.latest ? st.latest.end : st.launchEnd
      if (!st.ended || !end) continue
      let onDisk = false
      for (const t of tracked(records).values()) {
        if (t.outcome !== 'removed' && (await p.fs.exists(t.path))) {
          onDisk = true
          break
        }
      }
      if (!onDisk) continue
      const wrote = await serial(`cleanup:${ref.runDir}`, () => cleanup(p, ref, end.status))
      // summary.md lists what's kept, so it's written again when that changed.
      if (wrote > 0) await writeSummary(p, ref).catch(err => p.log(`summary for ${run} not rewritten: ${errText(err)}`))
    } catch (err) {
      p.log(`leftover worktrees of ${run} not cleaned up: ${errText(err)}`)
    }
  }
}

/** summary.md's worktree lines: what was kept and why, with paths. Empty when nothing was. */
export function worktreeSummary(records: readonly StoredRecord[]): string[] {
  const all = [...tracked(records).values()]
  if (all.length === 0) return []
  const lines = ['', '## Worktrees', '']
  for (const t of all) {
    if (t.outcome === 'kept') lines.push(`- Kept: ${t.path} (branch ${t.branch}): ${t.keptReason}`)
  }
  lines.push(`- Removed: ${all.filter(t => t.outcome === 'removed').length}`)
  return lines
}
