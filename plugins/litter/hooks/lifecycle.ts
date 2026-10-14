// A run from run.start to run.end: the launch preconditions, generations,
// the completion decoder, TaskStop settling, reconcile (plan section 9,
// "Launch preconditions", "Run lifecycle", "Continuations"). Owner: phase 1b,
// work package D.
//
// The ledger is the record of truth for a run's state: run.start, then one
// generation per run.launch or run.resume, each closed by one run.end. A run
// holds the lock (refs/litter-active) while its latest generation is open,
// and from run.start until run.launch it's a pending launch beating a lease.
// $.store only indexes: a task id or a workflow run id to its run, the
// pending launch, the agents a run started. Store keys carry the litter
// directory or a globally unique id, because one store serves every project.

import type { PortHook, PromptSubmitHook, SessionEndHook, TurnCompleteHook } from './hooktypes'
import type { Ports } from './ports'
import type { LitterOptions, WidenMode } from './options'
import type { AgentPolicy, Policy, RolePolicy, SpoolConsumer } from './hookfiles'
import type { Author, RecordError, RecordHandler, RecordInput, StoredRecord } from './records/core'
import type { GateWidenBody, VerifyBody } from './records/execute'
import type {
  AmendOf,
  FanoutTaskInput,
  LockBlob,
  LockForcedBody,
  LockRecoveredBody,
  RepairSettings,
  RunDriver,
  RunEndBody,
  RunJson,
  RunLaunchBody,
  RunRepairBody,
  RunStartBody,
  RunStartReply,
  RunStatus,
  RunStoppingBody,
  WideningInput,
  Workflow,
} from './records/run'
import type { RuleRef, SelectInput, Selection, SelectUnit } from './records/rules'
import type { Gate } from './gates'
import type { LockHeld, LockRefused } from './lock'
import type { SessionRebindBody } from './records/swarm'
import type { RepairBudget, RunLink } from './swarm/types'
import type { DesignSpec } from './design/launch'
import { fail } from './records/core'
import { DESIGN_BYS, DESIGN_OUTCOMES, REPAIR_MODES, RUN_STATUSES, WORKFLOWS, workflowName } from './records/run'
import { readLaunchLedger } from './records/swarm'
import { REPAIR_AGENTS, REPAIR_ROUNDS, WIDEN_MODES } from './options'
import { parseGates } from './gates'
import { applyWidening, askWiden, dateOf, parseWidening } from './widen'
import { writePlanVersion } from './planversion'
import type { AppendOptions } from './ledgercore'
import { appendRecord, elsewhere, owned, readLedger } from './ledgercore'
import type { RunJsonRefusal } from './runjson'
import { checkedRunJson } from './runjson'
import {
  hooksDir,
  modePath,
  planPath as runPlanPath,
  policyPath,
  runDir as runDirOf,
  runJsonPath,
  summaryPath,
  verifyLogPart,
  LAUNCH_ID,
  RUN_ID,
  SNAPSHOT_EXCLUDES,
  SWARM_NAME,
} from './layout'
import { atomicWrite, randomId, readJson, remove, serial, sha256 } from './fsx'
import { forgetRunAgents, policyKey, readPolicy, setActive, updatePolicy, writePolicy } from './policy'
import { removeActiveIfUnbound } from './swarm/guard'
import { endVerifies, isGreen, notGreen, planGates, verifiesInFlight, verifyBody } from './verify'
import { ROLE_POLICIES } from './roles'
import { snapshot } from './snapshot'
import { shellQuote } from './quote'
import { reconcileLands } from './land'
import { getOptions, session } from './session'
import { NOT_INTO_SUBMODULES, cleanupRun, litterWorktreeRoot, worktreeSummary } from './worktrees'
import { fanoutSummary } from './integrate'
import { continueAsRepair, repairSummary } from './repair'
import { executeSummary } from './execsummary'
import { scheduleExport } from './ledgerexport'
import { selectForRun } from './rules/select'
import { designArgs, parseDesign } from './design/launch'
import { finalizeDesign } from './design/finalize'
import { designSummary } from './design/summary'
import {
  acquireLock,
  leaseStale,
  readLease,
  readLock,
  releaseLock,
  removeLease,
  startLease,
  stillHeld,
  stopLease,
  LOCK_REF,
} from './lock'

const MOD: Author = { source: 'mod' }
const LAUNCHER: Author = { source: 'launcher' }

// The other packages' functions phases 3 and 4 reach from here (AE's
// selection, AB's summary part; BD's design launch, BE's design end and
// summary part), through one table so tier 2 can stand in for them (COMMON,
// "Another package's module"). The mod never changes it.
export const deps = {
  selectForRun: (...a: Parameters<typeof selectForRun>) => selectForRun(...a),
  executeSummary: (...a: Parameters<typeof executeSummary>) => executeSummary(...a),
  parseDesign: (...a: Parameters<typeof parseDesign>) => parseDesign(...a),
  designArgs: (...a: Parameters<typeof designArgs>) => designArgs(...a),
  finalizeDesign: (...a: Parameters<typeof finalizeDesign>) => finalizeDesign(...a),
  designSummary: (...a: Parameters<typeof designSummary>) => designSummary(...a),
}

/** The modes the launch check and run.start refuse (plan section 9, "Launch check"). */
export const REFUSED_MODES = ['bypassPermissions', 'acceptEdits'] as const
/** A stopping run that hasn't settled by then is reported, and can be released by hand. */
export const UNSETTLED_MS = 2 * 60 * 1000

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const dirname = (path: string): string => path.slice(0, Math.max(1, path.lastIndexOf('/')))

// ---------------------------------------------------------------------------
// Where things are

/** The primary checkout, `<primary>/.claude/litter`'s parent's parent; null for a bare repository's `<common dir>/litter`. */
export function primaryOf(litterDir: string): string | null {
  const suffix = '/.claude/litter'
  return litterDir.endsWith(suffix) ? litterDir.slice(0, -suffix.length) : null
}

/** A directory git can run in for the repository's refs (the lock): the primary checkout, or the bare common dir. */
export function repoOf(litterDir: string): string {
  return primaryOf(litterDir) ?? dirname(litterDir)
}

async function realOf(p: Ports, path: string): Promise<string> {
  try {
    return (await p.fs.stat(path, { resolve: true })).realPath ?? path
  } catch {
    return path
  }
}

async function commonDirOf(p: Ports, dir: string): Promise<string | null> {
  const r = await p.run(['git', '-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  return r.code === 0 ? realOf(p, r.stdout.trim()) : null
}

/**
 * The checkout the session works in: `git rev-parse --show-toplevel` in the
 * session's working directory (it moves with EnterWorktree). Everything after
 * uses the absolute path. It must be a checkout of the repository litterDir
 * belongs to.
 */
async function sessionCheckout(p: Ports, litterDir: string): Promise<{ ok: true; checkout: string } | RecordError> {
  const top = await p.run(['git', 'rev-parse', '--show-toplevel'], { cwd: await p.cwd() })
  if (top.code !== 0 || top.stdout.trim() === '') {
    return fail("litter: the session's directory isn't inside a git checkout; start the run from the repository's checkout")
  }
  const checkout = top.stdout.trim()
  const [mine, theirs] = await Promise.all([commonDirOf(p, checkout), commonDirOf(p, repoOf(litterDir))])
  if (!mine || !theirs || mine !== theirs) {
    return fail(
      `litter: the session's checkout (${checkout}) isn't in the repository this session's litter directory belongs to (${litterDir}); start the run from that repository`,
    )
  }
  return { ok: true, checkout }
}

// ---------------------------------------------------------------------------
// $.store indexes

export type RunRef = { run: string; runDir: string; litterDir: string }
/** A run.start that holds the lock and waits for its Workflow call. */
export type Pending = RunRef & { checkout: string; oid: string; session: string; workflow: Workflow; at: number }

export const pendingKey = (litterDir: string) => `litter.pending.${litterDir}`
export const taskKey = (taskId: string) => `litter.task.${taskId}`
export const wfKey = (runId: string) => `litter.wf.${runId}`
const agentsKey = (runDir: string) => `litter.agents.${runDir}`
const projectKey = (litterDir: string) => `litter.projectDir.${litterDir}`
const eventsKey = (runDir: string) => `litter.events.${runDir}`

export async function getPending(p: Ports, litterDir: string): Promise<Pending | null> {
  const v = (await p.store.get(pendingKey(litterDir))) as Pending | undefined
  return v && typeof v.run === 'string' && typeof v.oid === 'string' ? v : null
}

export const clearPending = (p: Ports, litterDir: string): Promise<void> => p.store.delete(pendingKey(litterDir))

type AgentSet = { started: string[]; stopped: string[] }

/** Something the board shows later (a mode switch, a lost isolation context), kept with the run. */
async function noteEvent(p: Ports, runDir: string, event: Record<string, unknown>): Promise<void> {
  const list = ((await p.store.get(eventsKey(runDir))) as Record<string, unknown>[] | undefined) ?? []
  await p.store.set(eventsKey(runDir), [...list, event].slice(-50))
}

// ---------------------------------------------------------------------------
// Runs on disk and their state

export type Generation = {
  n: number
  /** The workflow task's id; '' for a repair generation, which runs no workflow. */
  taskId: string
  /** The workflow run's `wf_` id; '' for a repair generation. */
  runId: string
  scriptPath: string | null
  session: string
  /**
   * `session`, then each session a /clear moved it to while it was open
   * (`session.rebind`, O): the engine writes a run's snapshot under the id
   * current at the time (plan 15.4, "After /clear").
   */
  sessions: string[]
  oid: string
  openedAt: number
  end: RunEndBody | null
  /** Its first run.stopping: when, and the stop's warnings for the run.end (empty when there's none). */
  stopping: { at: number; warnings: string[] } | null
  /**
   * A repair generation's `run.repair` (2b-2): the swarm that works in it
   * and its budget at launch. Null for a workflow's (run.launch, run.resume).
   */
  repair: RunRepairBody | null
  /** The commit of the first `land` recorded in this generation, or null. */
  land: string | null
  /** The seq of the record that opened it, and of its run.end. */
  seq: number
  endSeq: number | null
}

export type RunState = {
  start: RunStartBody | null
  startedAt: number | null
  generations: Generation[]
  /** A run.end for generation 0: the launch never opened a generation. */
  launchEnd: RunEndBody | null
  latest: Generation | null
  /** The latest generation, while it has no run.end. */
  open: Generation | null
  /** The run holds no lock: its latest generation (or its launch) has a run.end. */
  ended: boolean
  /** The lock oid the run holds, or held last. */
  oid: string | null
}

/**
 * A run's state from its ledger records, in seq order. Generation 1 is the
 * workflow's launch; each run.resume, and each run.repair (2b-2: a repair
 * swarm's, after the run.end before it), opens the next, and each run.end
 * closes the one it names.
 */
export function runState(records: readonly StoredRecord[]): RunState {
  let start: RunStartBody | null = null
  let startedAt: number | null = null
  let launchEnd: RunEndBody | null = null
  const generations: Generation[] = []
  // A land belongs to the generation its intent was recorded in: a recovered land is recorded later (land.ts, reconcile).
  const intentOf = new Map<string, Generation>()
  for (const r of records) {
    if (r.kind === 'run.start' && start === null) {
      start = r.body as unknown as RunStartBody
      startedAt = r.at
    } else if (r.kind === 'run.launch' || r.kind === 'run.resume') {
      const b = r.body as unknown as RunLaunchBody
      generations.push({
        n: generations.length + 1,
        taskId: b.taskId,
        runId: b.runId,
        scriptPath: b.scriptPath ?? null,
        session: b.session ?? '',
        sessions: [b.session ?? ''],
        oid: b.oid ?? '',
        openedAt: r.at,
        end: null,
        stopping: null,
        repair: null,
        land: null,
        seq: r.seq,
        endSeq: null,
      })
    } else if (r.kind === 'run.repair') {
      const b = r.body as unknown as RunRepairBody
      generations.push({
        n: generations.length + 1,
        taskId: '',
        runId: '',
        scriptPath: null,
        session: '',
        sessions: [],
        oid: '',
        openedAt: r.at,
        end: null,
        stopping: null,
        repair: b,
        land: null,
        seq: r.seq,
        endSeq: null,
      })
    } else if (r.kind === 'land.intent' || r.kind === 'land') {
      const v = typeof r.body.verify_id === 'string' ? r.body.verify_id : null
      const g = (v !== null ? intentOf.get(v) : undefined) ?? generations.at(-1)
      if (!g) continue
      if (r.kind === 'land.intent') {
        if (v !== null && !intentOf.has(v)) intentOf.set(v, g)
      } else if (g.land === null && typeof r.body.commit === 'string') g.land = r.body.commit
    } else if (r.kind === 'session.rebind') {
      const b = r.body as unknown as SessionRebindBody
      const g = generations.at(-1)
      if (g && !g.end && typeof b.to === 'string' && !g.sessions.includes(b.to)) g.sessions.push(b.to)
    } else if (r.kind === 'run.stopping') {
      const b = r.body as unknown as RunStoppingBody
      const g = [...generations].reverse().find(x => x.taskId === b.taskId)
      if (g && !g.stopping) g.stopping = { at: r.at, warnings: Array.isArray(b.warnings) ? b.warnings.filter(x => typeof x === 'string') : [] }
    } else if (r.kind === 'run.end') {
      const b = r.body as unknown as RunEndBody
      if (b.generation === 0) launchEnd ??= b
      else {
        const g = generations[b.generation - 1]
        if (g && !g.end) {
          g.end = b
          g.endSeq = r.seq
        }
      }
    }
  }
  const latest = generations.at(-1) ?? null
  const open = latest && !latest.end ? latest : null
  const ended = latest ? latest.end !== null : launchEnd !== null
  return { start, startedAt, generations, launchEnd, latest, open, ended, oid: latest?.oid || start?.oid || null }
}

export type Loaded = {
  json: RunJson | null
  records: StoredRecord[]
  tampered: { seq: number; reason: string } | null
  /** Under `checked`: why run.json wasn't read, when the run exists but it's tampered, another store's or changed. */
  refused?: string
}

/**
 * A run's run.json (null unless it's this run's, version 1) and its ledger's
 * records, up to a tamper point if there is one. `checked` reads run.json
 * only as run.start wrote it (runjson.ts), for a caller that acts on it.
 * Exported for the design launch's prior run and the design end (phase 4, BD
 * and BE).
 */
export async function loadRun(p: Ports, litterDir: string, run: string, opts: { checked?: boolean } = {}): Promise<Loaded> {
  const dir = runDirOf(litterDir, run)
  if (opts.checked) {
    const ledger = await readLedger(p, dir, run)
    const c = await checkedRunJson(p, { run, runDir: dir }, ledger)
    const json = c.ok && c.json.v === 1 && c.json.run === run ? c.json : null
    const refused = !c.ok && c.why !== 'unstarted' && c.why !== 'missing' ? { refused: c.reason } : {}
    return { json, records: ledger.records, tampered: ledger.tampered, ...refused }
  }
  const [json, ledger] = await Promise.all([
    readJson<RunJson>(p, runJsonPath(dir)).catch(() => undefined),
    readLedger(p, dir, run),
  ])
  return { json: json?.v === 1 && json.run === run ? json : null, records: ledger.records, tampered: ledger.tampered }
}

/** Every run folder under litterDir, oldest first (run ids start with the date). */
async function listRuns(p: Ports, litterDir: string): Promise<string[]> {
  if (!(await p.fs.exists(litterDir))) return []
  return (await p.fs.list(litterDir))
    .filter(e => e.kind === 'dir' && !e.isLink && RUN_ID.test(e.name))
    .map(e => e.name)
    .sort()
}

// ---------------------------------------------------------------------------
// The policy files

async function policyFor(
  p: Ports,
  litterDir: string,
  json: RunJson,
  sessionId: string,
  flags: { runIds: string[]; launching: boolean },
): Promise<Policy> {
  const prev = await readPolicy(p, litterDir).catch(() => undefined)
  const [checkout, litter] = await Promise.all([realOf(p, json.checkout), realOf(p, litterDir)])
  const primary = primaryOf(litterDir)
  const bases = [...new Set([primary ? await realOf(p, primary) : null, checkout].filter((x): x is string => x !== null))]
  const ruleDirs = bases.flatMap(b => ['.litter', '.litter.local', '.claude/rules/litter', '.claude/rules/litter-local'].map(r => `${b}/${r}`))
  // Every litter worktree goes under the primary checkout, even from a run worktree (plan section 9, "Run worktrees").
  const worktreeRoot = await litterWorktreeRoot(p, litterDir)
  // A fanout's writers run isolated, each bound to its own worktree (plan section 7, fanout.js step 2).
  const roles = json.workflow === 'fanout' ? { ...ROLE_POLICIES, executor: FANOUT_WRITER } : { ...ROLE_POLICIES }
  return {
    v: 1,
    session: sessionId,
    litterDir,
    run: {
      run: json.run,
      workflow: json.workflow,
      runDir: runDirOf(litterDir, json.run),
      checkout: json.checkout,
      base: json.base,
      runIds: flags.runIds,
      launching: flags.launching,
      stopping: false,
      inflight: null,
      isolationLost: false,
      roots: {
        checkout,
        litterDir: litter,
        litterCopies: [...new Set([litter, `${checkout}/.claude/litter`])],
        ruleDirs,
        worktrees: [],
      },
      setup: json.setup,
      linkDirs: [...json.linkDirs],
      worktreeRoot,
      setupTimeoutSec: Math.min(Math.ceil(getOptions().verifyTimeoutMs / 1000), SETUP_HOOK_LIMIT_SEC),
    },
    roles,
    swarm: prev?.swarm ?? null,
  }
}

/** A fanout's executor: isolated, writing only its own worktree (the guard narrows it to its task's paths). */
const FANOUT_WRITER: RolePolicy = { write: 'own-worktree', bash: 'rw', isolated: true }

/** worktree.sh's setup limit: the WorktreeCreate hook gets 600 s, and the script needs time to answer after. */
const SETUP_HOOK_LIMIT_SEC = 570

/**
 * Makes the run active for the hooks: policy.json first, then `active` (policy.ts).
 * The read of the old file and the write run under updatePolicy's key, so a
 * swarm entry written at the same moment (swarm/guard.ts) isn't lost: policyFor
 * keeps the swarm part it reads.
 */
export async function activate(
  p: Ports,
  litterDir: string,
  json: RunJson,
  sessionId: string,
  flags: { runIds: string[]; launching: boolean },
): Promise<void> {
  await serial(policyKey(litterDir), async () => writePolicy(p, litterDir, await policyFor(p, litterDir, json, sessionId, flags)))
  await setActive(p, litterDir, true)
}

/** Changes the active run's flags, if policy.json names it. */
export async function patchRunPolicy(
  p: Ports,
  litterDir: string,
  run: string,
  patch: (r: NonNullable<Policy['run']>) => NonNullable<Policy['run']>,
  sessionId?: string,
): Promise<boolean> {
  // Under policy.ts's lock: the drain timer, the TaskStop hook and integrate each patch the same file.
  let wrote = false
  await updatePolicy(p, litterDir, policy => {
    if (!policy.run || policy.run.run !== run) return null
    wrote = true
    return { ...policy, ...(sessionId ? { session: sessionId } : {}), run: patch(policy.run) }
  })
  return wrote
}

/**
 * The run is no longer active: `active` goes first (unless a swarm is live,
 * or a node's binding file is left: swarm/guard.ts, Q10), then policy.json's
 * run. One read-modify-write under updatePolicy's key, so a swarm entry
 * written meanwhile is neither lost nor left without `active`. A policy.json
 * that doesn't parse, or of another version, is the guard's "unreadable, so
 * deny": `active` stays (removing it would pass every call), and it's logged.
 */
export async function deactivate(p: Ports, litterDir: string, run: string): Promise<void> {
  await serial(policyKey(litterDir), async () => {
    let policy: Policy | null | undefined
    try {
      policy = await readJson<Policy>(p, policyPath(litterDir))
    } catch (err) {
      p.log(`run ${run}: policy.json doesn't parse, so hooks/active is left and the run isn't taken off it: ${errText(err)}`)
      return
    }
    if (policy !== undefined && (policy === null || typeof policy !== 'object' || policy.v !== 1)) {
      p.log(`run ${run}: policy.json isn't version 1, so hooks/active is left and the run isn't taken off it`)
      return
    }
    if (policy && policy.run && policy.run.run !== run) return
    if (!policy || policy.swarm == null) await removeActiveIfUnbound(p, litterDir)
    if (policy?.run) await writePolicy(p, litterDir, { ...policy, run: null })
  })
}

/**
 * Removes the fanout writers' bindings (`agents/<id>.json` with `run` and no
 * `node`, task.bind's in records/design.ts) whose run `gone` names. One left
 * in agents/ keeps every hook off its fast path (lib.sh, lt_begin: a binding
 * file there makes each script read its input), and once its run is off
 * policy.json the guard denies that writer anyway ("no litter run is
 * active"). A file that doesn't read is left: it may be a node's.
 */
async function removeRunBindings(p: Ports, litterDir: string, gone: (run: string) => boolean): Promise<void> {
  const dir = `${hooksDir(litterDir)}/agents`
  if (!(await p.fs.exists(dir))) return
  for (const e of await p.fs.list(dir)) {
    if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
    const path = `${dir}/${e.name}`
    const file = await readJson<AgentPolicy>(p, path).catch(() => undefined)
    if (!file || typeof file !== 'object' || file.node !== undefined || typeof file.run !== 'string' || !gone(file.run)) continue
    await remove(p, path).catch(err => p.log(`agents/${e.name} wasn't removed: ${errText(err)}`))
  }
}

/** Releases refs/litter-active if its blob names this run. */
async function releaseRunLock(p: Ports, litterDir: string, run: string): Promise<void> {
  const repo = repoOf(litterDir)
  const lock = await readLock(p, repo)
  if (!lock || lock.blob?.run !== run) return
  stopLease(lock.oid)
  await releaseLock(p, repo, lock.oid)
  await removeLease(p, litterDir, lock.oid)
}

// ---------------------------------------------------------------------------
// Ending a generation

/**
 * Records `body` as the generation's run.end, once: a later attempt returns
 * the first record unchanged, and an end for an older generation is history
 * that changes nothing current. The current one writes summary.md, takes the
 * run off the policy files and releases the lock. A ledger this store doesn't
 * own refuses (ledgercore's LedgerNotOwned) unless `options` adopts it.
 */
export function endRun(p: Ports, ref: RunRef, body: RunEndBody, options: AppendOptions = {}): Promise<{ recorded: boolean; end: RunEndBody }> {
  return serial(`run:${ref.runDir}`, async () => {
    const ledger = await readLedger(p, ref.runDir, ref.run)
    const st = runState(ledger.records)
    let current = true
    if (body.generation === 0) {
      if (st.launchEnd) return { recorded: false, end: st.launchEnd }
      if (st.generations.length > 0) current = false
    } else {
      const g = st.generations[body.generation - 1]
      if (!g) throw new Error(`run ${ref.run} has no generation ${body.generation}`)
      if (g.end) return { recorded: false, end: g.end }
      current = g === st.latest
    }
    return recordEnd(p, ref, st, body, current, options)
  })
}

/**
 * endRun's steps once it chose to record, under the run's serial key, which
 * the caller holds: run.end, then for the current generation the cleanup, a
 * design's delivery (BE's finalizeDesign, decision 16), summary.md, the
 * policy files, the bindings, the lock and the indexes.
 */
async function recordEnd(
  p: Ports,
  ref: RunRef,
  st: RunState,
  body: RunEndBody,
  current: boolean,
  options: AppendOptions = {},
): Promise<{ recorded: true; end: RunEndBody }> {
  await appendRecord(p, ref.runDir, { run: ref.run, kind: 'run.end', by: body.source === 'launcher' ? LAUNCHER : MOD, body }, options)
  if (current) {
    // Cleanup first, so the summary lists what it kept (plan section 9, "Cleanup is the mod's").
    await cleanupRun(p, ref, body.status).catch(err => p.log(`worktree cleanup for ${ref.run} failed: ${errText(err)}`))
    // A design's plan.md before its summary, which says whether it was delivered.
    if (st.start?.workflow === 'design') {
      await deps.finalizeDesign(p, ref, body).catch(err => p.log(`design delivery for ${ref.run} failed: ${errText(err)}`))
    }
    await writeSummary(p, ref).catch(err => p.log(`summary for ${ref.run} failed: ${errText(err)}`))
    // The ledger's export, from a timer: run.end never waits for it (plan section 9, "Ledger").
    scheduleExport(p, ref.runDir, ref.run)
    await deactivate(p, ref.litterDir, ref.run).catch(err => p.log(`policy for ${ref.run} failed: ${errText(err)}`))
    await removeRunBindings(p, ref.litterDir, run => run === ref.run).catch(err => p.log(`writer bindings of ${ref.run} not removed: ${errText(err)}`))
    await releaseRunLock(p, ref.litterDir, ref.run)
    const gen = body.generation > 0 ? st.generations[body.generation - 1] : null
    if (gen && gen.taskId !== '') await p.store.delete(taskKey(gen.taskId))
    await p.store.delete(agentsKey(ref.runDir))
    await forgetRunAgents(p, ref.run).catch(err => p.log(`agent map for ${ref.run} not pruned: ${errText(err)}`))
    const pending = await getPending(p, ref.litterDir)
    if (pending?.run === ref.run) await clearPending(p, ref.litterDir)
  }
  return { recorded: true, end: body }
}

// ---------------------------------------------------------------------------
// The completion decoder (plan section 9, "Run lifecycle", the table)

export type EngineEnd = { status: 'completed' | 'failed' | 'killed'; result?: unknown; error?: string | null; warnings?: string[] }
export type Decoded = { status: RunStatus; reason: string | null; payload?: Record<string, unknown> }

const MISSING_ROLE = /agent type 'litter:[^']*' not found/
const UNRECOGNIZED: Decoded = { status: 'failed', reason: 'unrecognized result' }
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Maps a workflow's end to a run.end status, by the workflow run.json records. Fails closed. */
export function decodeReturn(workflow: Workflow, end: EngineEnd): Decoded {
  if (end.status === 'killed') return { status: 'stopped', reason: 'stopped' }
  if (end.status === 'failed') {
    const error = end.error ?? 'the workflow failed'
    return MISSING_ROLE.test(error) ? { status: 'interrupted', reason: error } : { status: 'failed', reason: error }
  }
  const r = end.result
  if (!isObject(r)) return UNRECOGNIZED
  if (workflow === 'execute' || workflow === 'fanout') {
    if (!('halted' in r)) return UNRECOGNIZED
    if (r.halted === null) return { status: 'done', reason: null }
    if (typeof r.halted !== 'string') return UNRECOGNIZED
    return r.interrupted === true ? { status: 'interrupted', reason: r.halted } : { status: 'halted', reason: r.halted }
  }
  if (workflow === 'plan') {
    if (typeof r.halted === 'string') {
      return r.interrupted === true ? { status: 'interrupted', reason: r.halted } : { status: 'halted', reason: r.halted }
    }
    if (Array.isArray(r.gates) || Array.isArray(r.questions)) return { status: 'done', reason: null }
    return UNRECOGNIZED
  }
  // design (DesignReturn, records/run.ts)
  if (!('stopped' in r)) return UNRECOGNIZED
  const { stopped } = r
  if (stopped === null) {
    // The budget's stop is done, holding (decision 2): a holding outcome never delivers.
    const outcomes: readonly string[] = DESIGN_OUTCOMES
    const bys: readonly string[] = DESIGN_BYS
    if (!outcomes.includes(String(r.outcome)) || !bys.includes(String(r.by))) return UNRECOGNIZED
    return { status: 'done', reason: null, payload: { outcome: r.outcome, by: r.by, version: r.version ?? null } }
  }
  if (stopped === 'goal-change' || stopped === 'blocking-decision' || stopped === 'user-gap') {
    return { status: 'needs_user', reason: stopped, payload: boundPayload(r) }
  }
  if (stopped === 'source-changed') return { status: 'halted', reason: 'source-changed', payload: { version: r.version ?? null } }
  // A call that returned nothing after its retry, or a refused prober worktree (decision 1): the reason names the role and the round.
  if (stopped === 'halted') {
    return typeof r.reason === 'string' && r.reason.trim() !== '' ? { status: 'halted', reason: oneLine(r.reason, HALT_REASON_MAX) } : UNRECOGNIZED
  }
  if (stopped === 'interrupted') return { status: 'interrupted', reason: typeof r.reason === 'string' ? r.reason : 'interrupted' }
  return UNRECOGNIZED
}

/** A design's halted reason, on one line and cut, as the hooks' other refusal reasons are (ledger.ts's recordFailed). */
const HALT_REASON_MAX = 300

/** A design stop's payload, kept well inside a record's bound. */
function boundPayload(r: Record<string, unknown>): Record<string, unknown> {
  const text = JSON.stringify(r)
  return text.length <= 256 * 1024 ? r : { stopped: r.stopped, truncated: true, bytes: text.length }
}

// ---------------------------------------------------------------------------
// The task notification (zDn in 2.1.287: tags, a result XML-escaped, cut at 8,000 characters)

export type Notification = {
  taskId: string
  status: string
  outputFile: string | null
  summary: string | null
  /** The <result> text, unescaped; null when there was none. */
  result: string | null
  truncated: boolean
}

const unescape = (s: string): string => s.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
const TRUNCATED = /\n\.\.\. \(truncated [0-9]+ chars, full result in [^\n]*\)$/

export function parseNotifications(text: string): Notification[] {
  const out: Notification[] = []
  for (const m of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = m[1]!
    const tag = (name: string): string | null => {
      const t = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)
      return t ? t[1]! : null
    }
    const taskId = tag('task-id')?.trim()
    const status = tag('status')?.trim()
    if (!taskId || !status) continue
    let result = tag('result')
    let truncated = false
    if (result !== null && TRUNCATED.test(result)) {
      truncated = true
      result = result.replace(TRUNCATED, '')
    }
    const summary = tag('summary')
    out.push({
      taskId,
      status,
      outputFile: tag('output-file')?.trim() || null,
      summary: summary === null ? null : unescape(summary),
      result: result === null ? null : unescape(result),
      truncated,
    })
  }
  return out
}

/** The failed notification's error, from its summary: `Dynamic workflow "…" failed: <error>`. */
const notificationError = (n: Notification): string | null => {
  const m = n.summary ? /^Dynamic workflow "[^\n]*?" failed: ([\s\S]*)$/.exec(n.summary) : null
  return m ? m[1]!.trim() : null
}

/**
 * The engine's own snapshot of a run, `<projectDir>/<sessionId>/workflows/<runId>.json`
 * ($mo), under the session current when the engine wrote it: the one it
 * launched under, one a /clear moved it to (`gen.sessions`), or this one.
 */
async function engineSnapshot(p: Ports, litterDir: string, gen: Generation): Promise<EngineEnd | null> {
  const projectDir = (await p.store.get(projectKey(litterDir))) as string | undefined
  if (typeof projectDir !== 'string' || !/^wf_[a-z0-9-]{6,}$/.test(gen.runId)) return null
  const sessions = [...new Set([...gen.sessions, await p.sessionId()].filter(s => /^[A-Za-z0-9-]+$/.test(s)))]
  for (const sid of sessions) {
    try {
      const snap = await readJson<{ status?: string; result?: unknown; error?: string }>(p, `${projectDir}/${sid}/workflows/${gen.runId}.json`)
      if (snap && (snap.status === 'completed' || snap.status === 'failed' || snap.status === 'killed')) {
        return { status: snap.status, result: snap.result, error: snap.error ?? null }
      }
    } catch {
      // unreadable: try the next session id
    }
  }
  return null
}

/** A notification's end, the full result read from the output file when the text was cut. */
async function notificationEnd(p: Ports, n: Notification): Promise<EngineEnd | null> {
  if (n.status === 'killed') return { status: 'killed' }
  if (n.status === 'failed') return { status: 'failed', error: notificationError(n) }
  if (n.status !== 'completed') return null
  if (n.result !== null && !n.truncated) {
    try {
      return { status: 'completed', result: JSON.parse(n.result) }
    } catch {
      return { status: 'completed', result: undefined }
    }
  }
  if (n.outputFile) {
    try {
      const out = JSON.parse(await p.fs.read(n.outputFile)) as { result?: unknown }
      return { status: 'completed', result: out.result }
    } catch {
      // the output file isn't readable: the decoder fails closed below
    }
  }
  return { status: 'completed', result: undefined }
}

/** The run's workflow, from its run.start record: chained in the ledger, unlike run.json, which an agent past the guard could rewrite. */
function workflowOf(st: RunState): Workflow {
  return st.start?.workflow ?? 'execute'
}

const ISOLATION_CAUSE =
  "likely another plugin's tool.call hook matches this agent's tools: disable it, or ask its author for a literal matcher"

/** Why the run halts, while its policy says an agent lost its isolation context (the guard or watch.sh spooled it); else null. */
async function isolationLoss(p: Ports, ref: RunRef): Promise<string | null> {
  const policy = await readPolicy(p, ref.litterDir).catch(() => undefined)
  if (policy?.run?.run !== ref.run || policy.run.isolationLost !== true) return null
  const events = ((await p.store.get(eventsKey(ref.runDir))) as Record<string, unknown>[] | undefined) ?? []
  const last = [...events].reverse().find(ev => ev.ev === 'isolation-lost')
  const what = last
    ? `agent ${String(last.agent_id)} lost its isolation context on ${String(last.tool)} (cwd ${String(last.cwd)})`
    : 'an agent lost its isolation context'
  return `${what}; ${ISOLATION_CAUSE}`
}

/** The open workflow generation a task id names, with its run; null when there's none (or the ledger is tampered). */
async function taskGeneration(p: Ports, taskId: string): Promise<{ ref: RunRef; st: RunState; gen: Generation } | null> {
  const ref = (await p.store.get(taskKey(taskId))) as RunRef | undefined
  if (!ref || typeof ref.runDir !== 'string') return null
  const ledger = await readLedger(p, ref.runDir, ref.run)
  if (ledger.tampered) {
    p.log(`run ${ref.run}: ledger tampered at ${ledger.tampered.seq}; its task's end isn't acted on`)
    return null
  }
  const st = runState(ledger.records)
  // A repair generation has no workflow task: no notification is its, and its swarm ends it (2b-2).
  const gen = st.generations.find(g => g.repair === null && g.taskId === taskId)
  if (!gen || gen.end) return null
  return { ref, st, gen }
}

async function settleNotification(p: Ports, n: Notification): Promise<void> {
  const found = await taskGeneration(p, n.taskId)
  if (!found) return
  const { ref, gen } = found
  let end = await notificationEnd(p, n)
  if (end?.status === 'completed' && end.result === undefined) end = (await engineSnapshot(p, ref.litterDir, gen)) ?? end
  if (!end) return
  await settleGeneration(p, found, end)
}

/**
 * A workflow task's end, from a host that runs the script itself (Codex's
 * workflow host, design D3) and so has no task notification: what a
 * notification with that end does. False when the task has no open generation.
 */
export async function settleTaskEnd(p: Ports, taskId: string, end: EngineEnd): Promise<boolean> {
  const found = await taskGeneration(p, taskId)
  if (!found) return false
  await settleGeneration(p, found, end)
  return true
}

/** A generation's end: a kill settles as a stop; anything else is decoded into its run.end. */
async function settleGeneration(p: Ports, found: { ref: RunRef; st: RunState; gen: Generation }, end: EngineEnd): Promise<void> {
  const { ref, st, gen } = found
  if (end.status === 'killed') {
    await markStopping(p, ref, gen, end.warnings)
    await trySettle(p, ref, end.warnings)
    return
  }
  const workflow = workflowOf(st)
  let d = decodeReturn(workflow, end)
  // A run that lost an agent's isolation halts, whatever its script returned (section 14).
  const lost = d.status === 'stopped' ? null : await isolationLoss(p, ref)
  if (lost) d = { status: 'halted', reason: lost }
  const out = await endRun(p, ref, {
    taskId: gen.taskId,
    generation: gen.n,
    status: d.status,
    reason: d.reason,
    ...(d.payload ? { payload: d.payload } : {}),
    source: 'notification',
    ...(end.warnings?.length ? { warnings: end.warnings } : {}),
  })
  await afterEnd(p, ref, workflow, out)
}

/**
 * prompt.submit's first step: each task notification for a run's task writes
 * run.end and summary.md, and hands a halted fanout to the repair bridge,
 * before the prompt goes on. register.tsx builds the `<swarm>` block only
 * after this resolves, so the block sees a repair swarm the bridge started (2b-2).
 */
export async function settleNotices(p: Ports, e: Parameters<PromptSubmitHook>[1]): Promise<void> {
  if (e.origin?.kind !== 'task-notification' || !e.text.includes('<task-notification>')) return
  for (const n of parseNotifications(e.text)) {
    try {
      await settleNotification(p, n)
    } catch (err) {
      p.log(`notification for task ${n.taskId} not settled: ${errText(err)}`)
    }
  }
}

/** prompt.submit: a task notification for a run's task writes run.end and summary.md, then next(e). */
export const onPromptSubmit: PortHook<PromptSubmitHook> = async (p, e, next) => {
  await settleNotices(p, e)
  return next(e)
}

// ---------------------------------------------------------------------------
// The repair bridge's call-out, and a repair generation (phase 2b-2)

/**
 * Hands a halted fanout, or a halted execute run (phase 3, AC), to the bridge
 * (repair.ts) once its run.end is recorded: after endRun returned, so outside
 * the run's serial key, which the bridge's own records and summary rewrite
 * take. Only the end this call recorded: a notification and the launcher's
 * fallback can race, and the loser's endRun records nothing. A rejection is
 * logged; the end stands.
 */
async function afterEnd(p: Ports, ref: RunRef, workflow: Workflow, out: { recorded: boolean; end: RunEndBody }): Promise<void> {
  if (!out.recorded || out.end.status !== 'halted' || (workflow !== 'fanout' && workflow !== 'execute')) return
  try {
    await continueAsRepair(p, ref.runDir)
  } catch (err) {
    p.log(`run ${ref.run}: the repair bridge failed: ${errText(err)}`)
  }
}

/** What `run.repair` records besides its generation, which reopenForRepair assigns. */
export type RepairOpen = { swarm: string; launch: string; budget: RepairBudget }

/**
 * How a repair generation ends (Z's finish, X's failure after the reopen):
 * `done` when a land was recorded in it, else `halted` with why.
 */
export type RepairOutcome = { status: 'done' | 'halted'; reason: string | null }

type Reopened = { ok: true; link: RunLink } | { ok: false; reason: string }

/** The run a run folder is, `<litterDir>/<run>`; null for any other path. */
function runRefOf(runDir: string): RunRef | null {
  const cut = runDir.lastIndexOf('/')
  const run = runDir.slice(cut + 1)
  const litterDir = runDir.slice(0, Math.max(0, cut))
  return cut > 0 && RUN_ID.test(run) && runDirOf(litterDir, run) === runDir ? { run, runDir, litterDir } : null
}

const wholeIn = (v: unknown, lo: number, hi: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi

/**
 * Reopens a halted run for its repair swarm (COMMON 2b-2, step 3): takes the
 * run lock, records `run.repair` for the next generation, and activates
 * `policy.run` as run.start does. With the lock held, or a generation still
 * open, it refuses and writes nothing. Answers the link the swarm carries
 * (`LiveSwarm.run`).
 *
 * Also refused, writing nothing: a run.json that isn't run.start's (its sha),
 * a run that isn't a fanout or an execute run (phase 3's plan template, AC),
 * one launched before repairs (no `repair` in
 * run.json, so its confirmation never stated one), one that never launched or
 * ended done, and a budget over the one its launch approved. A lock whose run
 * has ended is stale (a crash before its release) and is released first, as
 * reconcile would. If the policy can't be written after run.repair, the
 * generation is ended halted with why, so a refusal never leaves one open.
 */
export async function reopenForRepair(p: Ports, runDir: string, open: RepairOpen): Promise<Reopened> {
  const ref = runRefOf(runDir)
  if (!ref) return { ok: false, reason: `litter: ${runDir} isn't a litter run's folder` }
  const no = (why: string): Reopened => ({ ok: false, reason: `litter: run ${ref.run} can't be reopened for a repair: ${why}` })
  if (typeof open?.swarm !== 'string' || !SWARM_NAME.test(open.swarm)) return no(`'${String(open?.swarm)}' isn't a swarm name`)
  if (typeof open.launch !== 'string' || !LAUNCH_ID.test(open.launch)) return no(`'${String(open.launch)}' isn't a launch id`)
  const b = open.budget
  if (!b || !wholeIn(b.rounds, REPAIR_ROUNDS.min, REPAIR_ROUNDS.max) || !wholeIn(b.agents, REPAIR_AGENTS.min, REPAIR_AGENTS.max)) {
    return no(`the budget must be ${REPAIR_ROUNDS.min} to ${REPAIR_ROUNDS.max} rounds and ${REPAIR_AGENTS.min} to ${REPAIR_AGENTS.max} agents, whole numbers`)
  }
  const sessionId = await p.sessionId()
  return serial(`run:${ref.runDir}`, async (): Promise<Reopened> => {
    const loaded = await loadLaunchable(p, ref)
    if (!loaded.ok) return no(loaded.reason)
    const { json, st } = loaded
    if (json.workflow !== 'fanout' && json.workflow !== 'execute') {
      return no(`its workflow is ${json.workflow}, and only a fanout or an execute run continues as a repair swarm`)
    }
    const approved: RepairSettings | undefined = json.repair
    if (!approved) return no("its run.json has no repair setting (it was launched before repairs), so its launch confirmation never stated one")
    if (b.rounds > approved.rounds || b.agents > approved.agents) {
      return no(`the budget (${b.rounds} rounds, ${b.agents} agents) is more than its launch approved (${approved.rounds} rounds, ${approved.agents} agents)`)
    }
    if (st.open) return no(`its generation ${st.open.n} is still open`)
    if (!st.latest) return no('it never launched')
    if (st.latest.end?.status === 'done') return no('it ended done, so there is nothing to repair')

    const lock = await takeRepairLock(p, ref.litterDir, { run: ref.run, session: sessionId, acquiredAt: await p.now() })
    if (!lock.ok) return no(lock.reason)
    const n = st.generations.length + 1
    const body: RunRepairBody = { generation: n, swarm: open.swarm, launch: open.launch, budget: { rounds: b.rounds, agents: b.agents } }
    try {
      await appendRecord<RunRepairBody>(p, ref.runDir, { run: ref.run, kind: 'run.repair', by: MOD, body })
    } catch (err) {
      await releaseLock(p, repoOf(ref.litterDir), lock.oid)
      return no(`run.repair couldn't be recorded (${errText(err)}), so nothing was reopened`)
    }
    try {
      await activate(p, ref.litterDir, json, sessionId, { runIds: [], launching: false })
    } catch (err) {
      const why = `the run's policy couldn't be written for the repair (${errText(err)})`
      try {
        const now = runState((await readLedger(p, ref.runDir, ref.run)).records)
        await recordEnd(p, ref, now, { taskId: null, generation: n, status: 'halted', reason: why, source: 'mod' }, true)
      } catch (e) {
        p.log(`run ${ref.run}: repair generation ${n} wasn't ended after its policy failed: ${errText(e)}`)
      }
      return no(why)
    }
    return { ok: true, link: { runDir: ref.runDir, run: ref.run, generation: n } }
  })
}

/** The run lock for a reopen: free, or held by a run that has ended (stale, released first); anyone else's refuses. */
async function takeRepairLock(p: Ports, litterDir: string, blob: LockBlob): Promise<LockHeld | { ok: false; reason: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await acquireLock(p, repoOf(litterDir), blob)
    if (r.ok) return r
    if (!(await releaseIfEnded(p, litterDir, r))) return { ok: false, reason: r.reason.replace(/^litter: /, '') }
  }
  return { ok: false, reason: "the project's run lock kept changing hands" }
}

/**
 * A lock whose run's ledger has ended it: a crash came between that run.end
 * and the release. Released as reconcile does: another store's run only once
 * its lease is stale too.
 */
async function releaseIfEnded(p: Ports, litterDir: string, r: LockRefused): Promise<boolean> {
  const blob = r.holder
  if (!r.oid || !blob || !RUN_ID.test(blob.run)) return false
  const ledger = await readLedger(p, runDirOf(litterDir, blob.run), blob.run)
  if (ledger.tampered || !runState(ledger.records).ended) return false
  if ((await owned(p, runDirOf(litterDir, blob.run), ledger)) !== 'mine' && !leaseStale(await readLease(p, litterDir, r.oid), blob, await p.now())) return false
  if (!(await releaseLock(p, repoOf(litterDir), r.oid))) return false
  await removeLease(p, litterDir, r.oid)
  p.log(`released a stale lock of ended run ${blob.run}`)
  return true
}

/**
 * Ends the open repair generation (COMMON 2b-2, step 7): its run.end (`done`
 * only with a land of this generation in the ledger), the cleanup, the
 * summary, `deactivate` and the lock's release, in endRun's order and under
 * its serial key. Idempotent: an ended generation answers its run.end with
 * `recorded: false`.
 *
 * The ledger decides the status, not `outcome`: for a fanout, `done` exactly
 * when a land belongs to the generation; for an execute run (phase 3, COMMON
 * step 5), exactly when every gate of `args.gates` has a land in the run's
 * ledger and, with a goal check, the generation's latest goal verify is green
 * on the last land's tree. Else `halted` with the outcome's reason (or what's
 * missing). Nothing is cleaned up for the halted attempt: an execute run has
 * no integration worktree, and whatever is uncommitted in its checkout stays.
 * Lands are reconciled first (land.ts, under its own key), so a land a crash
 * left between its intent and its record counts. The generation is the open
 * one, or the latest repair generation once it ended. Throws for a run with
 * none, or a tampered ledger.
 */
export async function endRepairGeneration(p: Ports, runDir: string, outcome: RepairOutcome): Promise<{ recorded: boolean; end: RunEndBody }> {
  const ref = runRefOf(runDir)
  if (!ref) throw new Error(`litter: ${runDir} isn't a litter run's folder`)
  await reconcileLands(p, ref.runDir, ref.run).catch(err => p.log(`run ${ref.run}: lands not reconciled before its repair generation ended: ${errText(err)}`))
  return serial(`run:${ref.runDir}`, async () => {
    const ledger = await readLedger(p, ref.runDir, ref.run)
    if (ledger.tampered) throw new Error(`litter: run ${ref.run}'s ledger is tampered at ${ledger.tampered.seq}; its repair generation isn't ended`)
    const st = runState(ledger.records)
    const gen = [...st.generations].reverse().find(g => g.repair !== null)
    if (!gen) throw new Error(`litter: run ${ref.run} has no repair generation to end`)
    if (gen.end) return { recorded: false, end: gen.end }
    const swarm = gen.repair!.swarm
    // An execute run's rule needs its gates, from run.json; the workflow is run.start's, so a changed run.json can't make it a fanout.
    let missing: string | null
    if (st.start?.workflow === 'execute') {
      const loaded = await loadLaunchable(p, ref)
      missing = loaded.ok ? executeUnfinished(swarm, loaded.json, ledger.records, gen.seq) : `its gates can't be checked: ${loaded.reason}`
    } else missing = gen.land !== null ? null : `repair swarm ${swarm} ended without a land`
    if (outcome.status === 'done' && missing !== null) {
      const why = st.start?.workflow === 'execute' ? `isn't done (${missing})` : 'has no land'
      p.log(`run ${ref.run}: repair swarm ${swarm} ended done, but generation ${gen.n} ${why}, so it ends halted`)
    }
    const body: RunEndBody =
      missing === null
        ? { taskId: null, generation: gen.n, status: 'done', reason: null, source: 'mod' }
        : {
            taskId: null,
            generation: gen.n,
            status: 'halted',
            reason: outcome.status === 'halted' && outcome.reason ? outcome.reason : missing,
            source: 'mod',
          }
    return recordEnd(p, ref, st, body, gen === st.latest)
  })
}

/**
 * Why an execute run's repair generation isn't done (COMMON step 5, decision
 * 12), or null when it is: a gate of `args.gates` with no land in the run's
 * ledger, or in goal mode no green goal verify in this generation after the
 * last land, on the tree it landed.
 */
function executeUnfinished(swarm: string, json: RunJson, records: readonly StoredRecord[], since: number): string | null {
  const gates = (planGates(json) ?? []).map(g => g.id)
  if (gates.length === 0) return `run.json names no plan gates, so repair swarm ${swarm} can't have landed them`
  const lands = records.filter(r => r.kind === 'land' && typeof r.body.gate === 'string')
  const left = gates.filter(id => !lands.some(r => r.body.gate === id))
  if (left.length > 0) return `repair swarm ${swarm} ended with ${left.length === 1 ? 'gate' : 'gates'} ${left.join(', ')} not landed`
  if (json.args.goalCheck !== true) return null
  const last = lands.at(-1)!
  const goal = records.filter(r => r.seq > since && verifyBody(r)?.gate === 'goal').at(-1)
  const v = goal ? verifyBody(goal)! : null
  if (!goal || !v || goal.seq < last.seq) return `every gate landed, but repair swarm ${swarm} ran no goal check after the last land`
  if (!isGreen(v)) return `every gate landed, but the goal check ${v.verify_id} wasn't green (${notGreen(v)})`
  if (v.tree_before !== last.body.tree) return `every gate landed, but the goal check ${v.verify_id} ran on tree ${v.tree_before}, not the landed tree ${String(last.body.tree)}`
  return null
}

/**
 * How long a repair generation's swarm may go without swarm.start before
 * reconcile ends the generation: its launch may still be going live in the
 * session that reopened the run (X's bridge, between run.repair and swarm.start).
 */
export const REPAIR_LAUNCH_GRACE_MS = UNSETTLED_MS

type RepairFate = { live: boolean; why: string }

/**
 * Whether an open repair generation's swarm still owns it, from that launch's
 * own ledger: live from swarm.start until swarm.end (records/swarm.ts). One
 * that ended, whose ledger is broken (it could never record swarm.end), or
 * that never reached swarm.start within the grace, doesn't, and `why` is the
 * generation's halted reason.
 */
async function repairFate(p: Ports, litterDir: string, gen: Generation): Promise<RepairFate> {
  const r = gen.repair!
  if (!SWARM_NAME.test(r.swarm) || !LAUNCH_ID.test(r.launch)) return { live: false, why: `its run.repair names no valid swarm launch (${r.swarm} ${r.launch})` }
  const { records, tampered } = await readLaunchLedger(p, litterDir, r.swarm, r.launch)
  if (records.some(x => x.kind === 'swarm.end')) return { live: false, why: `repair swarm ${r.swarm} ended without a land` }
  if (tampered) return { live: false, why: `repair swarm ${r.swarm}'s launch ledger is broken at record ${tampered.seq}, so it can never end` }
  if (records.some(x => x.kind === 'swarm.start')) return { live: true, why: `repair swarm ${r.swarm} is live` }
  if ((await p.now()) - gen.openedAt < REPAIR_LAUNCH_GRACE_MS) return { live: true, why: `repair swarm ${r.swarm} is going live` }
  return { live: false, why: `repair swarm ${r.swarm} never went live` }
}

/**
 * Reconcile of an open repair generation (WP-W): a live swarm owns it and is
 * left alone; one that ended, or never went live, is ended here. The
 * engine's snapshot has nothing to say about it: no workflow runs in it.
 */
async function reconcileRepair(p: Ports, ref: RunRef, gen: Generation): Promise<void> {
  const fate = await repairFate(p, ref.litterDir, gen)
  if (fate.live) return
  await endRepairGeneration(p, ref.runDir, { status: 'halted', reason: fate.why })
}

// ---------------------------------------------------------------------------
// Stopping and settling

/** run.stopping, once, with the stop's `warnings` for whoever settles the run (trySettle), and stopping in the policy. */
async function markStopping(p: Ports, ref: RunRef, gen: Generation, warnings?: string[]): Promise<void> {
  if (!gen.stopping) {
    await appendRecord<RunStoppingBody>(p, ref.runDir, {
      run: ref.run,
      kind: 'run.stopping',
      by: MOD,
      body: { taskId: gen.taskId, generation: gen.n, ...(warnings?.length ? { warnings } : {}) },
    })
  }
  await patchRunPolicy(p, ref.litterDir, ref.run, r => ({ ...r, stopping: true }))
}

/** What still keeps a stopping run from settling, as text for a refusal; empty when nothing does. */
async function unsettled(p: Ports, ref: RunRef, records: readonly StoredRecord[], gen: Generation): Promise<string[]> {
  const open: string[] = []
  const agents = ((await p.store.get(agentsKey(ref.runDir))) as AgentSet | undefined) ?? { started: [], stopped: [] }
  const live = agents.started.filter(a => !agents.stopped.includes(a))
  if (live.length > 0) open.push(`agents still running: ${live.join(', ')}`)
  const verifies = verifiesInFlight(ref.run)
  if (verifies > 0) open.push(`${verifies} verify run(s) still ending`)
  const policy = await readPolicy(p, ref.litterDir).catch(() => undefined)
  if (policy?.run?.run === ref.run && policy.run.inflight) open.push(`a ${policy.run.inflight} in flight`)
  // Each name's latest step: a gone worktree re-added after its create opens a new intent.
  const latest = new Map<string, string>()
  for (const r of records) {
    const name = typeof r.body.name === 'string' ? r.body.name : null
    if (name && (r.kind === 'worktree.intent' || r.kind === 'worktree.create' || r.kind === 'worktree.setup_failed')) latest.set(name, r.kind)
  }
  const pendingWorktrees = [...latest].filter(([, kind]) => kind === 'worktree.intent').map(([name]) => name)
  if (pendingWorktrees.length > 0) open.push(`worktrees still being made: ${pendingWorktrees.join(', ')}`)
  if ((await engineSnapshot(p, ref.litterDir, gen)) === null && (await snapshotExpected(p, ref.litterDir, gen))) {
    open.push("the engine hasn't written the run's snapshot yet")
  }
  return open
}

/**
 * Whether the engine's snapshot would be readable once written: the project
 * folder is known and the session's workflows/ folder exists. Under storage v5
 * the snapshot may go to a sidecar instead, and then it isn't waited for.
 */
async function snapshotExpected(p: Ports, litterDir: string, gen: Generation): Promise<boolean> {
  const projectDir = (await p.store.get(projectKey(litterDir))) as string | undefined
  if (typeof projectDir !== 'string') return false
  for (const sid of gen.sessions.filter(s => /^[A-Za-z0-9-]+$/.test(s))) {
    if (await p.fs.exists(`${projectDir}/${sid}/workflows`).catch(() => false)) return true
  }
  return false
}

/**
 * A stopping run settles to run.end stopped once nothing of it is live (plan
 * section 9, "Settled means"). Never one this store doesn't own: what keeps it
 * live is in its owner's store, so here it would settle at once. The run.end
 * carries the warnings its run.stopping kept, then any of `given` not among
 * them, so an agent's stop line settles it as the stopper would.
 */
export async function trySettle(p: Ports, ref: RunRef, given?: string[]): Promise<boolean> {
  const ledger = await readLedger(p, ref.runDir, ref.run)
  if (ledger.tampered) return false
  if ((await owned(p, ref.runDir, ledger)) !== 'mine') return false
  const st = runState(ledger.records)
  const gen = st.open
  if (!gen?.stopping) return false
  if ((await unsettled(p, ref, ledger.records, gen)).length > 0) return false
  const snap = await engineSnapshot(p, ref.litterDir, gen)
  const d = snap && snap.status !== 'killed' ? decodeReturn(workflowOf(st), snap) : null
  const warnings = [...gen.stopping.warnings, ...(given ?? []).filter(x => !gen.stopping!.warnings.includes(x))]
  await endRun(p, ref, {
    taskId: gen.taskId,
    generation: gen.n,
    status: d?.status ?? 'stopped',
    reason: d?.reason ?? 'stopped',
    ...(d?.payload ? { payload: d.payload } : {}),
    source: 'taskstop',
    settled: true,
    ...(warnings.length > 0 ? { warnings } : {}),
  })
  return true
}

/** tool.call(TaskStop), after next(e) succeeded: run.stopping, stopping in the policy, then settle if it can. */
export async function observeStop(p: Ports, taskId: string): Promise<boolean> {
  const ref = (await p.store.get(taskKey(taskId))) as RunRef | undefined
  if (!ref || typeof ref.runDir !== 'string') return false
  const ledger = await readLedger(p, ref.runDir, ref.run)
  if (ledger.tampered) return false
  const gen = runState(ledger.records).open
  if (!gen || gen.taskId !== taskId) return false
  await markStopping(p, ref, gen)
  // A stop ends the run's verifies too: each leaves its loop, kills its child and records nothing.
  endVerifies(ref.run)
  await trySettle(p, ref)
  return true
}

// ---------------------------------------------------------------------------
// The pending launch: turn.complete and session.end end it

async function endPending(p: Ports, pending: Pending, reason: string): Promise<void> {
  const repo = repoOf(pending.litterDir)
  stopLease(pending.oid)
  await releaseLock(p, repo, pending.oid)
  await clearPending(p, pending.litterDir)
  await removeLease(p, pending.litterDir, pending.oid)
  const ledger = await readLedger(p, pending.runDir, pending.run)
  const st = runState(ledger.records)
  if (st.start && st.generations.length === 0 && !st.launchEnd) {
    await endRun(p, pending, { taskId: null, generation: 0, status: 'launch_failed', reason, source: 'mod' })
  }
}

/** turn.complete: a main turn that ends with a pending launch and no Workflow call releases the lock. */
export const onTurnComplete: PortHook<TurnCompleteHook> = async (p, e, next) => {
  const litterDir = session().litterDir
  if (e.agentId === undefined && litterDir) {
    try {
      const pending = await getPending(p, litterDir)
      if (pending && pending.session === (await p.sessionId())) await endPending(p, pending, 'not launched')
    } catch (err) {
      p.log(`turn.complete: pending launch not ended: ${errText(err)}`)
    }
  }
  return next(e)
}

/**
 * session.end: stops the lease beat; a pending launch is released and ended
 * (launch_failed). The budget is 1.5 s, so the release comes first; reconcile
 * records what's left if the budget runs out.
 *
 * A /clear (reason `clear`) isn't the process ending: it goes on under a new
 * session id and clear.ts rebinds it (plan 15.4, "After /clear"), so the beat
 * isn't stopped. The cleared conversation's pending launch still ends: its
 * Workflow call can't follow, and ending it stops its own beat.
 */
export const onSessionEnd: PortHook<SessionEndHook> = async (p, e, next) => {
  if (e.reason !== 'clear') stopLease()
  const litterDir = session().litterDir
  if (litterDir) {
    try {
      const pending = await getPending(p, litterDir)
      if (pending && pending.session === e.sessionId) await endPending(p, pending, 'not launched')
    } catch (err) {
      p.log(`session.end: pending launch not ended: ${errText(err)}`)
    }
  }
  return next(e)
}

/**
 * After a /clear (clear.ts's rebind; plan 15.4, "After /clear"): the open run
 * records `session.rebind { from, to }`, so the snapshot lookups above try
 * every session it ran under; and a pending launch still under this
 * process's old id (a clear whose session.end never reached the mod) becomes
 * the new id's, which turn.complete and the launch check compare with the
 * current one. `mine` is this process's earlier session ids: a run that
 * another live session owns (policy.json is shared) is left alone. Answers the
 * run it recorded in, or null.
 */
export async function rebindRun(p: Ports, litterDir: string, from: string, to: string, mine: readonly string[]): Promise<string | null> {
  const ours = (id: string) => id === from || id === to || mine.includes(id)
  const pending = await getPending(p, litterDir)
  if (pending && pending.session !== to && ours(pending.session)) await p.store.set(pendingKey(litterDir), { ...pending, session: to } satisfies Pending)
  const policy = await readPolicy(p, litterDir)
  if (!policy?.run || !ours(policy.session)) return null
  const ref: RunRef = { run: policy.run.run, runDir: policy.run.runDir, litterDir }
  return serial(`run:${ref.runDir}`, async () => {
    const ledger = await readLedger(p, ref.runDir, ref.run)
    if (ledger.tampered) {
      p.log(`run ${ref.run}: ledger tampered at ${ledger.tampered.seq}; session.rebind not recorded`)
      return null
    }
    if ((await owned(p, ref.runDir, ledger)) !== 'mine') {
      p.log(`${elsewhere(ref.run)}; session.rebind not recorded`)
      return null
    }
    const st = runState(ledger.records)
    if (!st.start || st.ended) return null
    const again = ledger.records.some(r => r.kind === 'session.rebind' && r.body.from === from && r.body.to === to)
    if (!again) await appendRecord<SessionRebindBody>(p, ref.runDir, { run: ref.run, kind: 'session.rebind', by: MOD, body: { from, to } })
    return ref.run
  })
}

// ---------------------------------------------------------------------------
// The lock's holder, reconciled before an acquisition (plan section 9, step 0)

type Freed = { freed: true } | { freed: false; message: string }

async function askYes(p: Ports, question: string, yes: string, no: string): Promise<boolean> {
  try {
    return (await p.ask(question, { options: [no, yes], header: 'litter' })) === yes
  } catch {
    return false // dismissed, or no one to ask (-p): the refusal stands
  }
}

/**
 * A lock whose holder is gone, or whose holder you release, is freed;
 * otherwise the refusal says why. `self` is the acquiring session: its own
 * launch that never reached its Workflow call is replaced, not asked about.
 */
async function reconcileHolder(
  p: Ports,
  litterDir: string,
  oid: string,
  blob: LockBlob | null,
  interactive: boolean,
  self: string | null,
): Promise<Freed> {
  const repo = repoOf(litterDir)
  if (!blob || !RUN_ID.test(blob.run)) {
    return {
      freed: false,
      message:
        `litter: ${LOCK_REF} names ${oid}, which isn't a litter lock; if no litter run is active, ` +
        `delete it with 'git update-ref -d ${LOCK_REF} ${oid}' and launch again`,
    }
  }
  const ref: RunRef = { run: blob.run, runDir: runDirOf(litterDir, blob.run), litterDir }
  const ledger = await readLedger(p, ref.runDir, ref.run)
  if (ledger.tampered) {
    return { freed: false, message: `litter: run ${blob.run} holds the lock, and its ledger is tampered at ${ledger.tampered.seq}; litter won't act on it` }
  }
  const st = runState(ledger.records)
  if ((await owned(p, ref.runDir, ledger)) !== 'mine') return releaseForeign(p, litterDir, oid, blob, st, interactive)
  const now = await p.now()
  const ago = (t: number) => `${Math.round((now - t) / 1000)} s ago`

  if (st.ended) {
    // A stale lock left by a crash: the holder's run already ended.
    await releaseLock(p, repo, oid)
    await removeLease(p, litterDir, oid)
    p.log(`released a stale lock of ended run ${blob.run}`)
    return { freed: true }
  }

  if (st.generations.length === 0) {
    if (self !== null && blob.session === self) {
      // This session's own launch that never reached its Workflow call: a new run.start replaces it.
      stopLease(oid)
      if (!(await releaseLock(p, repo, oid))) return { freed: false, message: `litter: couldn't release run ${blob.run}'s lock; launch again` }
      await removeLease(p, litterDir, oid)
      if ((await getPending(p, litterDir))?.run === blob.run) await clearPending(p, litterDir)
      if (st.start && !st.launchEnd) {
        await endRun(p, ref, { taskId: null, generation: 0, status: 'launch_failed', reason: 'not launched (a later run.start replaced it)', source: 'mod' })
      }
      return { freed: true }
    }
    const lease = await readLease(p, litterDir, oid)
    if (leaseStale(lease, blob, now)) {
      await recoverOrphan(p, ref, oid, blob, st)
      return (await readLock(p, repo))?.oid === oid
        ? { freed: false, message: `litter: couldn't recover the lock of run ${blob.run}; launch again` }
        : { freed: true }
    }
    const beat = lease ? lease.beatAt : blob.acquiredAt
    const question =
      `Run ${blob.run} (session ${blob.session}) holds this project's litter run lock, waiting for its launch ` +
      `(last seen ${ago(beat)}). Release it? Only do this if that session is hung.`
    if (interactive && (await askYes(p, question, 'Release it', 'Keep it'))) {
      await forceRelease(p, ref, oid, blob, st)
      return { freed: true }
    }
    return {
      freed: false,
      message:
        `litter: run ${blob.run} (session ${blob.session}) holds the project's run lock and is still launching ` +
        `(its lease was beaten ${ago(beat)}); wait for it to launch or end, or release it when litter asks`,
    }
  }

  const gen = st.open!
  // A repair generation's lock is its swarm's: never marked interrupted, only ended once that swarm can't end it (2b-2).
  if (gen.repair) {
    const fate = await repairFate(p, litterDir, gen)
    if (!fate.live) {
      await endRepairGeneration(p, ref.runDir, { status: 'halted', reason: fate.why })
      return (await readLock(p, repo))?.oid === oid
        ? { freed: false, message: `litter: run ${blob.run}'s repair generation ended, but its lock wasn't released; launch again` }
        : { freed: true }
    }
    return {
      freed: false,
      message:
        `litter: run ${blob.run} holds the project's run lock while ${fate.why.replace(/^repair swarm/, 'its repair swarm')} (generation ${gen.n}); ` +
        `the lock is released when that swarm ends (End swarm in /litter swarms ${gen.repair.swarm}), then launch again`,
    }
  }
  if (gen.stopping) {
    if (await trySettle(p, ref)) return { freed: true }
    const open = await unsettled(p, ref, ledger.records, gen)
    if (now - gen.stopping.at > UNSETTLED_MS) {
      const question =
        `Run ${blob.run} was stopped ${ago(gen.stopping.at)} and hasn't settled (${open.join('; ') || 'nothing seen'}). ` +
        'Release it by hand? Anything of it still running keeps running.'
      if (interactive && (await askYes(p, question, 'Release it', 'Keep it'))) {
        await endRun(p, ref, { taskId: gen.taskId, generation: gen.n, status: 'stopped', reason: 'released by you before it settled', source: 'mod', settled: false })
        return { freed: true }
      }
    }
    return {
      freed: false,
      message: `litter: run ${blob.run} is stopping and holds the project's run lock (${open.join('; ') || 'waiting for its stop to settle'}); launch again once it settles`,
    }
  }

  const snap = await engineSnapshot(p, litterDir, gen)
  if (snap) {
    const d = decodeReturn(workflowOf(st), snap)
    await endRun(p, ref, { taskId: gen.taskId, generation: gen.n, status: d.status, reason: d.reason, ...(d.payload ? { payload: d.payload } : {}), source: 'reconcile' })
    return { freed: true }
  }
  const question =
    `Run ${blob.run} (task ${gen.taskId}, launched ${ago(gen.openedAt)}) is still recorded as running and holds this ` +
    "project's litter run lock. If it isn't running any more, mark it interrupted and release the lock?"
  if (interactive && (await askYes(p, question, 'Mark it interrupted', 'Keep it'))) {
    await endRun(p, ref, { taskId: gen.taskId, generation: gen.n, status: 'interrupted', reason: 'marked interrupted by you', source: 'mod' })
    return { freed: true }
  }
  return {
    freed: false,
    message: `litter: run ${blob.run} is active (task ${gen.taskId}) and holds the project's run lock; stop it from /workflows or wait for it to end, then launch again`,
  }
}

/**
 * A holder whose ledger this store doesn't own (`owned`). The lock is the
 * repository's, so it's freed when its lease is stale and the run ended or
 * never launched, or when you release it; but nothing is recorded in the
 * holder's ledger and the run isn't ended here: its owner's reconcile ends it.
 */
async function releaseForeign(p: Ports, litterDir: string, oid: string, blob: LockBlob, st: RunState, interactive: boolean): Promise<Freed> {
  const now = await p.now()
  const lease = await readLease(p, litterDir, oid)
  const who = `run ${blob.run} (session ${blob.session})`
  // A launched run's lease isn't beaten, so a stale one says its host is gone only before the launch or after the end.
  let why = 'its lease was stale'
  if (!(leaseStale(lease, blob, now) && (st.ended || st.generations.length === 0))) {
    const seen = Math.round((now - (lease ? lease.beatAt : blob.acquiredAt)) / 1000)
    const question =
      `Run ${blob.run} (session ${blob.session}) holds this project's litter run lock (last seen ${seen} s ago), and ${elsewhere(blob.run)}. ` +
      "Release the lock? Only do this if that host is gone: nothing is recorded in the run's ledger, and its own host ends it."
    if (!(interactive && (await askYes(p, question, 'Release it', 'Keep it')))) {
      return { freed: false, message: `litter: ${who} holds the project's run lock, and ${elsewhere(blob.run)}; end it there, or release the lock when litter asks` }
    }
    why = 'you released it'
  }
  if (!(await releaseLock(p, repoOf(litterDir), oid))) return { freed: false, message: `litter: couldn't release run ${blob.run}'s lock; launch again` }
  await removeLease(p, litterDir, oid)
  p.log(`released the lock of ${who}, as ${why}; ${elsewhere(blob.run)}, so nothing was recorded in its ledger`)
  return { freed: true }
}

/**
 * The branch a recovered launch left behind, and the branch it switched from,
 * for the records: run.start's, chained in the ledger, never run.json's.
 */
async function leftBranch(p: Ports, ref: RunRef, st: RunState): Promise<{ branch: string | null; previousBranch: string | null }> {
  const name = `refs/heads/litter/${ref.run}`
  const r = await p.run(['git', '-C', repoOf(ref.litterDir), 'rev-parse', '-q', '--verify', name])
  return { branch: r.code === 0 ? `litter/${ref.run}` : null, previousBranch: st.start?.previousBranch ?? null }
}

/** An orphan: recorded as lock.recovered (and launch_failed when run.start was), then compare-and-delete. */
async function recoverOrphan(p: Ports, ref: RunRef, oid: string, blob: LockBlob, st: RunState): Promise<void> {
  const left = await leftBranch(p, ref, st)
  await appendRecord<LockRecoveredBody>(p, ref.runDir, {
    run: ref.run,
    kind: 'lock.recovered',
    by: MOD,
    body: { oid, run: blob.run, session: blob.session, ...left },
  })
  if (!(await releaseLock(p, repoOf(ref.litterDir), oid))) return
  await removeLease(p, ref.litterDir, oid)
  if (st.start && !st.launchEnd) {
    const where = left.branch ? `; it left ${left.branch}${left.previousBranch ? `, switched from ${left.previousBranch}` : ''}` : ''
    await endRun(p, ref, { taskId: null, generation: 0, status: 'launch_failed', reason: `not launched (lock recovered${where})`, source: 'reconcile' })
  }
}

async function forceRelease(p: Ports, ref: RunRef, oid: string, blob: LockBlob, st: RunState): Promise<void> {
  await appendRecord<LockForcedBody>(p, ref.runDir, { run: ref.run, kind: 'lock.forced', by: MOD, body: { oid, run: blob.run, session: blob.session } })
  await releaseLock(p, repoOf(ref.litterDir), oid)
  await removeLease(p, ref.litterDir, oid)
  if (st.start && !st.launchEnd) {
    await endRun(p, ref, { taskId: null, generation: 0, status: 'launch_failed', reason: 'not launched (lock released by you)', source: 'mod' })
  }
}

/** Takes the lock for `blob`, reconciling a holder first: a stale or orphaned lock is freed, a live one refuses. */
export async function takeLock(p: Ports, litterDir: string, blob: LockBlob, interactive = true): Promise<{ ok: true; held: LockHeld } | RecordError> {
  const repo = repoOf(litterDir)
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await acquireLock(p, repo, blob)
    if (r.ok) return { ok: true, held: r }
    if (!r.oid) return fail(r.reason)
    const freed = await reconcileHolder(p, litterDir, r.oid, r.holder, interactive, blob.session)
    if (!freed.freed) return fail(freed.message)
  }
  return fail("litter: the project's run lock kept changing hands; launch again")
}

// ---------------------------------------------------------------------------
// run.start: input

type Task = { id: string; title: string; text: string; writes: boolean; files: string[] }

/** run.start's input once parseStart checked it (exported for the design launch's designArgs, BD's). */
export type Spec = {
  workflow: Workflow
  authorized: string[]
  planPath: string | null
  goal: string | null
  verify: string[] | null
  goalCheck: string[] | null
  setup: string[] | null
  maxAttempts: number
  adversary: boolean
  isolate: boolean
  continueOf: string | null
  amendOf: { run: string; gate: string } | null
  carryOver: boolean
  runRules: string[]
  tasks: Task[]
  contract: string | null
  /** A fanout's writers' and a design's probers' (decision 11); none for every other workflow. */
  linkDirs: string[]
  mergeOrder: string[]
  /** A design's own fields, parseDesign's (BD's); null for every other workflow. */
  design: DesignSpec | null
  maxRounds: number
  /** What run.start's reply says beside the launch, from the parse (parseDesign's). */
  warnings: string[]
  /** A fanout's repair setting (2b-2), the options' values filled in; null for every other workflow. */
  repair: RepairSettings | null
  /** An execute run's widen setting (WP-AO), the option's value filled in; null for every other workflow. */
  widen: WidenMode | null
  /** An execute run's widenings before Launch (WP-AO), each to be confirmed in the mod's dialog. */
  widenings: WideningInput[]
}

// The parse's helpers, exported for the design launch's parse (design/launch.ts, BD's).

/** A field's value as checked, or the refusal naming it. */
export type Parsed<T> = { ok: true; value: T } | RecordError

export const ok = <T>(value: T): Parsed<T> => ({ ok: true, value })

/** A list of strings, each trimmed and the empty ones dropped. */
export function strings(v: unknown, field: string, opts: { min?: number; optional?: boolean } = {}): Parsed<string[]> {
  if (v === undefined || v === null) {
    return opts.optional ? ok([]) : fail(`'${field}' is required: a list of strings`, field)
  }
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) return fail(`'${field}' must be a list of strings`, field)
  const list = (v as string[]).map(s => s.trim()).filter(s => s !== '')
  if (list.length < (opts.min ?? 0)) return fail(`'${field}' needs at least ${opts.min} non-empty entr${opts.min === 1 ? 'y' : 'ies'}`, field)
  return ok(list)
}

function argvOf(v: unknown, field: string): Parsed<string[] | null> {
  if (v === undefined || v === null || v === '') return ok(null)
  if (!Array.isArray(v) || v.length === 0 || v.some(x => typeof x !== 'string')) {
    return fail(`'${field}' must be an argument list (e.g. ["uv", "run", "pytest", "-q"]), not a shell string`, field)
  }
  const list = v as string[]
  if (list[0]!.trim() === '' || list.some(a => a.includes('\0'))) return fail(`'${field}' needs a command first, and no NUL bytes`, field)
  return ok(list)
}

/** A string, trimmed; null when it's absent or blank and `optional`. */
export const text = (v: unknown, field: string, optional = true): Parsed<string | null> => {
  if (v === undefined || v === null) return optional ? ok(null) : fail(`'${field}' is required`, field)
  if (typeof v !== 'string') return fail(`'${field}' must be a string`, field)
  const t = v.trim()
  return t === '' ? (optional ? ok(null) : fail(`'${field}' is required`, field)) : ok(t)
}

const intIn = (v: unknown, field: string, lo: number, hi: number, fallback: number): Parsed<number> => {
  if (v === undefined || v === null) return ok(fallback)
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) return fail(`'${field}' must be a whole number from ${lo} to ${hi}`, field)
  return ok(v)
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/

/** A repo-relative owned path: no absolute path, no `..`, no glob, nothing under the mod's own folders. */
function ownedPathError(path: string): string | null {
  if (path.startsWith('/') || path.startsWith('~') || /^[A-Za-z]:/.test(path)) return 'is absolute'
  if (path.split('/').some(s => s === '..' || s === '.')) return "contains '.' or '..'"
  if (/[*?[\]\\]/.test(path)) return 'has a glob or a backslash; list paths, with a trailing / for a folder'
  const bare = path.replace(/\/+$/, '')
  if (bare === '') return 'is empty'
  for (const ex of SNAPSHOT_EXCLUDES) {
    if (bare === ex || bare.startsWith(`${ex}/`) || ex.startsWith(`${bare}/`)) return `lies under litter's own ${ex}/`
  }
  return null
}

/**
 * One entry is the other, or lies under it at a `/`: `x`, `x/` and `x/f` all
 * overlap, since a file and a folder of one name conflict in a merge. Case and
 * Unicode normalization are folded: names that differ only in either collide
 * on a case-insensitive or normalization-insensitive checkout (macOS), where
 * git merges them without a conflict into one file.
 */
const overlaps = (a: string, b: string): boolean => {
  const [x, y] = [a, b].map(s => s.replace(/\/+$/, '').normalize('NFC').toLowerCase()) as [string, string]
  return x === y || y.startsWith(`${x}/`) || x.startsWith(`${y}/`)
}

function parseTasks(v: unknown): Parsed<Task[]> {
  if (!Array.isArray(v) || v.length === 0) return fail("'tasks' is required for a fanout: a list of { id, title, text, writes, files }", 'tasks')
  if (v.length > 1000) return fail("'tasks' has more than 1,000 entries, a run's limit", 'tasks')
  const tasks: Task[] = []
  const ids = new Set<string>()
  for (let i = 0; i < v.length; i++) {
    const t = v[i] as FanoutTaskInput
    const at = `tasks[${i}]`
    if (!isObject(t)) return fail(`'${at}' must be an object { id, title, text, writes, files }`, at)
    if (typeof t.id !== 'string' || !TASK_ID.test(t.id)) return fail(`'${at}.id' must be letters, digits, '.', '_' or '-'`, `${at}.id`)
    if (ids.has(t.id)) return fail(`task id '${t.id}' appears twice`, `${at}.id`)
    ids.add(t.id)
    if (typeof t.title !== 'string' || t.title.trim() === '') return fail(`'${at}.title' is required`, `${at}.title`)
    if (typeof t.text !== 'string' || t.text.trim() === '') return fail(`'${at}.text' is required: what the agent must do`, `${at}.text`)
    const files = strings(t.files, `${at}.files`, { optional: true })
    if (!files.ok) return files
    const writes = t.writes ?? files.value.length > 0
    if (typeof writes !== 'boolean') return fail(`'${at}.writes' must be true or false`, `${at}.writes`)
    if (writes && files.value.length === 0) return fail(`task '${t.id}' changes files, so '${at}.files' must list the paths it owns`, `${at}.files`)
    for (const f of files.value) {
      const why = ownedPathError(f)
      if (why) return fail(`task '${t.id}' owns '${f}', which ${why}`, `${at}.files`)
    }
    tasks.push({ id: t.id, title: t.title.trim(), text: t.text, writes, files: writes ? files.value : [] })
  }
  const writers = tasks.filter(t => t.writes)
  for (let i = 0; i < writers.length; i++) {
    for (let j = i + 1; j < writers.length; j++) {
      for (const a of writers[i]!.files) {
        const b = writers[j]!.files.find(x => overlaps(a, x))
        if (b !== undefined) {
          return fail(`tasks '${writers[i]!.id}' and '${writers[j]!.id}' both own '${a}' / '${b}'; tasks that share files aren't independent`, 'tasks')
        }
      }
    }
  }
  return ok(tasks)
}

/**
 * The ignored folders each new worktree links from the checkout: a fanout's
 * writers' and, from phase 4, a design's probers' (decision 11). Unset, the
 * option's apply.
 */
function parseLinkDirs(input: RecordInput, options: LitterOptions): Parsed<string[]> {
  const links = strings(input.linkDirs, 'linkDirs', { optional: true })
  if (!links.ok) return links
  const dirs = input.linkDirs === undefined ? [...options.linkDirs] : links.value
  for (const d of dirs) {
    const why = ownedPathError(d.endsWith('/') ? d : `${d}/`)
    if (why) return fail(`linkDirs entry '${d}' ${why}`, 'linkDirs')
  }
  return ok(dirs)
}

const KNOWN_FIELDS = new Set([
  'kind', 'workflow', 'authorized', 'planPath', 'goal', 'verify', 'goalCheck', 'setup', 'maxAttempts', 'adversary',
  'isolate', 'continueOf', 'amendOf', 'carryOver', 'runRules', 'tasks', 'contract', 'linkDirs', 'mergeOrder',
  'deliverable', 'bar', 'lenses', 'empiricalUnknowns', 'anchors', 'maxRounds', 'priorRun', 'feedback',
  'repair', 'repairRounds', 'repairAgents', 'widen', 'widenings',
])
const REPAIR_FIELDS = ['repair', 'repairRounds', 'repairAgents'] as const
/** At most this many gates widened at one launch. */
const WIDENINGS_MAX = 20

/**
 * An execute run's widen setting and its widenings before Launch (WP-AO):
 * the launch's override as its confirmation stated it, else the option's
 * value. Every other workflow refuses both fields. Two widenings of one gate
 * are refused: the launch states each gate's once.
 */
function parseWiden(input: RecordInput, options: LitterOptions, workflow: Workflow): Parsed<{ widen: WidenMode | null; widenings: WideningInput[] }> {
  if (workflow !== 'execute') {
    const given = (['widen', 'widenings'] as const).find(f => input[f] !== undefined && input[f] !== null)
    return given ? fail(`'${given}' is for execute runs, not ${workflow}: only an execute run's gates have Files to widen`, given) : ok({ widen: null, widenings: [] })
  }
  const mode = input.widen ?? options.widen
  if (!(WIDEN_MODES as readonly unknown[]).includes(mode)) {
    return fail("'widen' must be 'ask' (only you add files to a gate) or 'critic' (the gate's critic may also accept a file the gate can't do without)", 'widen', WIDEN_MODES)
  }
  const raw = input.widenings
  if (raw === undefined || raw === null) return ok({ widen: mode as WidenMode, widenings: [] })
  if (!Array.isArray(raw)) return fail("'widenings' must be a list of { gate, files, why }: the files you asked to add to a gate, and why", 'widenings')
  if (raw.length > WIDENINGS_MAX) return fail(`'widenings' widens ${raw.length} gates; a launch widens at most ${WIDENINGS_MAX}`, 'widenings')
  const widenings: WideningInput[] = []
  for (const [i, v] of raw.entries()) {
    const w = parseWidening(v, `widenings[${i}]`)
    if (!w.ok) return w
    if (widenings.some(x => x.gate === w.value.gate)) return fail(`'widenings' widens ${w.value.gate} twice; give its files in one entry`, `widenings[${i}].gate`)
    widenings.push(w.value)
  }
  return ok({ widen: mode as WidenMode, widenings })
}

/**
 * A fanout's or execute run's repair setting (plan 15.11, "Where it's set"):
 * the launch's override for this run, as its confirmation stated it, else the
 * options' values. A failed fanout continues as a repair swarm, and a halted
 * execute as a plan-template swarm (phase 3, COMMON step 4); an amend run
 * stores its setting too, though its halt never continues (decision 13).
 * Design and plan runs have no repair, so they refuse the fields.
 */
function parseRepair(input: RecordInput, options: LitterOptions, workflow: Workflow): Parsed<RepairSettings | null> {
  if (workflow !== 'fanout' && workflow !== 'execute') {
    const given = REPAIR_FIELDS.find(f => input[f] !== undefined && input[f] !== null)
    return given
      ? fail(`'${given}' is for fanout and execute runs, not ${workflow}: only a failed fanout or a halted execute run continues as a repair swarm`, given)
      : ok(null)
  }
  const mode = input.repair ?? options.repair
  if (!(REPAIR_MODES as readonly unknown[]).includes(mode)) {
    return fail("'repair' must be 'auto' (a failed run continues as a repair swarm) or 'off' (it stops and keeps everything)", 'repair', REPAIR_MODES)
  }
  const rounds = intIn(input.repairRounds, 'repairRounds', REPAIR_ROUNDS.min, REPAIR_ROUNDS.max, options.repairRounds)
  if (!rounds.ok) return rounds
  const agents = intIn(input.repairAgents, 'repairAgents', REPAIR_AGENTS.min, REPAIR_AGENTS.max, options.repairAgents)
  if (!agents.ok) return agents
  return ok({ mode: mode as RepairSettings['mode'], rounds: rounds.value, agents: agents.value })
}
/** The record tool's own fields, which reach a handler with the input. */
const RESERVED_FIELDS = new Set(['tool', 'tool_use_id', 'agentId', 'consent', 'run'])

/** Every check on the input alone, before anything else runs. */
function parseStart(input: RecordInput, options: LitterOptions): Parsed<Spec> {
  const unknown = Object.keys(input).filter(k => !KNOWN_FIELDS.has(k) && !RESERVED_FIELDS.has(k))
  if (unknown.length > 0) return fail(`run.start doesn't take '${unknown[0]}'`, unknown[0], [...KNOWN_FIELDS])
  const workflow = input.workflow as Workflow
  if (!WORKFLOWS.includes(workflow)) return fail("'workflow' must name the workflow to launch", 'workflow', WORKFLOWS)
  const authorized = strings(input.authorized, 'authorized', { min: 1 })
  if (!authorized.ok) return authorized
  const planPath = text(input.planPath, 'planPath')
  if (!planPath.ok) return planPath
  const goal = text(input.goal, 'goal')
  if (!goal.ok) return goal
  const verify = argvOf(input.verify, 'verify')
  if (!verify.ok) return verify
  const goalCheck = argvOf(input.goalCheck, 'goalCheck')
  if (!goalCheck.ok) return goalCheck
  const setup = argvOf(input.setup, 'setup')
  if (!setup.ok) return setup
  const maxAttempts = intIn(input.maxAttempts, 'maxAttempts', 1, 10, options.maxAttempts)
  if (!maxAttempts.ok) return maxAttempts
  const maxRounds = intIn(input.maxRounds, 'maxRounds', 1, 10, options.maxRounds)
  if (!maxRounds.ok) return maxRounds
  for (const f of ['adversary', 'isolate', 'carryOver'] as const) {
    if (input[f] !== undefined && typeof input[f] !== 'boolean') return fail(`'${f}' must be true or false`, f)
  }
  const continueOf = text(input.continueOf, 'continueOf')
  if (!continueOf.ok) return continueOf
  if (continueOf.value && !RUN_ID.test(continueOf.value)) return fail("'continueOf' must be a run id (yyyymmdd-slug)", 'continueOf')
  let amendOf: Spec['amendOf'] = null
  if (input.amendOf !== undefined && input.amendOf !== null) {
    const a = input.amendOf as { run?: unknown; gate?: unknown }
    if (!isObject(a) || typeof a.run !== 'string' || !RUN_ID.test(a.run) || typeof a.gate !== 'string' || !/^G[0-9]+$/.test(a.gate)) {
      return fail("'amendOf' must be { run: <run id>, gate: 'G<n>' }", 'amendOf')
    }
    amendOf = { run: a.run, gate: a.gate }
  }
  if (continueOf.value && amendOf) return fail("pass 'continueOf' or 'amendOf', not both", 'amendOf')
  const runRules = strings(input.runRules, 'runRules', { optional: true })
  if (!runRules.ok) return runRules
  const isolate = input.isolate === true
  if (isolate && (continueOf.value || amendOf)) {
    return fail("a continuation or an amend runs on the original run's branch where it's checked out; don't pass 'isolate'", 'isolate')
  }
  const carryOver = input.carryOver === true
  if (carryOver && !amendOf) return fail("'carryOver' is for an amend ('amendOf')", 'carryOver')

  const spec: Spec = {
    workflow,
    authorized: authorized.value,
    planPath: planPath.value,
    goal: goal.value,
    verify: verify.value,
    goalCheck: goalCheck.value,
    setup: setup.value,
    maxAttempts: maxAttempts.value,
    adversary: input.adversary === true,
    isolate,
    continueOf: continueOf.value,
    amendOf,
    carryOver,
    runRules: runRules.value,
    tasks: [],
    contract: null,
    linkDirs: [],
    mergeOrder: [],
    design: null,
    maxRounds: maxRounds.value,
    warnings: [],
    repair: null,
    widen: null,
    widenings: [],
  }

  if (workflow === 'execute') {
    if (!planPath.value && !continueOf.value && !amendOf) {
      return fail("an execute run needs 'planPath' (a plan with gate sections), 'continueOf' or 'amendOf'; a goal goes through a 'plan' run first", 'planPath')
    }
    if (amendOf && planPath.value) return fail("an amend takes its gate from the original run's plan; drop 'planPath'", 'planPath')
  } else if (continueOf.value && workflow !== 'plan') {
    return fail(`'continueOf' is for execute and plan runs, not ${workflow}`, 'continueOf')
  } else if (amendOf) {
    return fail("'amendOf' is for execute runs", 'amendOf')
  }

  if (workflow === 'fanout') {
    const tasks = parseTasks(input.tasks)
    if (!tasks.ok) return tasks
    spec.tasks = tasks.value
    const contract = text(input.contract, 'contract')
    if (!contract.ok) return contract
    spec.contract = contract.value
    const links = parseLinkDirs(input, options)
    if (!links.ok) return links
    spec.linkDirs = links.value
    const writers = spec.tasks.filter(t => t.writes).map(t => t.id)
    const order = strings(input.mergeOrder, 'mergeOrder', { optional: true })
    if (!order.ok) return order
    if (input.mergeOrder === undefined) spec.mergeOrder = writers
    else {
      const o = order.value
      if (o.length !== writers.length || new Set(o).size !== o.length || !o.every(id => writers.includes(id))) {
        return fail(`'mergeOrder' must list each writing task once: ${writers.join(', ')}`, 'mergeOrder', writers)
      }
      spec.mergeOrder = o
    }
  } else if (input.tasks !== undefined) {
    return fail(`'tasks' is for fanout runs, not ${workflow}`, 'tasks')
  }

  if (workflow === 'design') {
    // A design's own fields are BD's parse (design/launch.ts); its warnings join the reply's.
    const design = deps.parseDesign(input)
    if (!design.ok) return design
    spec.design = design.value
    spec.warnings.push(...(design.warnings ?? []))
    // The probers' worktrees take the setup and links a fanout's writers do (decision 11).
    const links = parseLinkDirs(input, options)
    if (!links.ok) return links
    spec.linkDirs = links.value
  } else {
    for (const f of ['deliverable', 'bar', 'lenses', 'empiricalUnknowns'] as const) {
      if (input[f] !== undefined) return fail(`'${f}' is for design runs, not ${workflow}`, f)
    }
  }

  if (workflow === 'plan' && !goal.value && !planPath.value && !continueOf.value) {
    return fail("a plan run needs 'goal', or 'planPath' for a prose plan to split into gates", 'goal')
  }
  const repair = parseRepair(input, options, workflow)
  if (!repair.ok) return repair
  spec.repair = repair.value
  const widen = parseWiden(input, options, workflow)
  if (!widen.ok) return widen
  spec.widen = widen.value.widen
  spec.widenings = widen.value.widenings
  return ok(spec)
}

// ---------------------------------------------------------------------------
// run.start: the checks that read the repository

/** git in one directory, with argv the mod built (exported for plan.ts's chainLanded call, phase 3). */
export type Git = (argv: readonly string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>

export const gitAt = (p: Ports, dir: string): Git => (argv, stdin) =>
  p.run(['git', '-C', dir, ...argv], stdin === undefined ? { timeoutMs: 120_000 } : { stdin, timeoutMs: 120_000 })

async function must(git: Git, argv: readonly string[], what: string): Promise<string> {
  const r = await git(argv)
  if (r.code !== 0) throw new Error(`${what}: git ${argv.join(' ')} failed (exit ${r.code}): ${r.stderr.trim()}`)
  return r.stdout
}

/** `git update-ref --stdin` with `start … prepare commit`: all of it or none of it. */
async function transaction(git: Git, lines: string[], noDeref: boolean): Promise<{ ok: boolean; error: string }> {
  const r = await git(['update-ref', ...(noDeref ? ['--no-deref'] : []), '--stdin'], ['start', ...lines, 'prepare', 'commit', ''].join('\n'))
  return { ok: r.code === 0, error: r.stderr.trim() }
}

/** `symref-update` in a ref transaction needs git 2.46 or later. */
async function hasSymrefUpdate(git: Git): Promise<boolean> {
  const m = /git version ([0-9]+)\.([0-9]+)/.exec((await git(['version'])).stdout)
  return m ? Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 46) : false
}

async function readMode(p: Ports, litterDir: string): Promise<string | null> {
  try {
    return (await p.fs.read(modePath(litterDir))).split('\n')[0]!.trim()
  } catch {
    return null
  }
}

/** The mode refusal, shared with the launch check; null when the mode allows a launch. */
export async function modeRefusal(p: Ports, litterDir: string): Promise<{ mode: string; refusal: string | null }> {
  const mode = await readMode(p, litterDir)
  if (mode === null || mode === '') {
    return {
      mode: '',
      refusal:
        "litter: the session's permission mode isn't recorded (no hooks/mode), so litter's command hooks haven't run " +
        "in this session and its guard can't either; check that plugin hooks aren't disabled (disableAllHooks, " +
        'allowManagedHooksOnly), send any prompt, and launch again',
    }
  }
  // On Codex the lead's mode never reaches litter's agents: each is a session litterd starts in its own
  // sandbox (D4), and exec reports bypassPermissions for every session (L4). The recorded mode still shows
  // that litter's hooks ran in the lead.
  if ((REFUSED_MODES as readonly string[]).includes(mode) && session().host !== 'codex') {
    return {
      mode,
      refusal: `litter: the session is in ${mode} mode, where litter's agents would ${mode === 'acceptEdits' ? 'stall on Bash prompts' : 'skip every check'}; switch to auto or default mode with shift+tab, then launch again`,
    }
  }
  return { mode, refusal: null }
}

async function hasJq(p: Ports): Promise<boolean> {
  try {
    return (await p.run(['jq', '--version'])).code === 0
  } catch {
    return false
  }
}

const datePart = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/** `<yyyymmdd>-<workflow>-<6 random>`: unique across projects too, since one store holds every ledger head. */
async function newRun(p: Ports, litterDir: string, workflow: Workflow): Promise<string> {
  const day = datePart(await p.now())
  for (;;) {
    const run = `${day}-${workflow}-${randomId().replace(/-/g, '').slice(0, 6)}`
    if (!(await p.fs.exists(runDirOf(litterDir, run)))) return run
  }
}

/** The checkout's tree must be what HEAD has, with no dirty submodule and no unmerged entry (plan section 9, step 1). */
async function cleanCheck(
  p: Ports,
  git: Git,
  checkout: string,
  allowTree: string | null,
): Promise<{ ok: true; head: string; headTree: string; tree: string; sparse: boolean } | RecordError> {
  const head = await git(['rev-parse', '-q', '--verify', 'HEAD^{commit}'])
  if (head.code !== 0) return fail('litter: the checkout has no commit yet; commit something first, then launch')
  const headTree = (await must(git, ['rev-parse', 'HEAD^{tree}'], 'clean check')).trim()
  const unmerged = (await must(git, ['ls-files', '-u', '-z'], 'clean check')).split('\0').filter(Boolean)
  if (unmerged.length > 0) {
    const paths = [...new Set(unmerged.map(l => l.split('\t')[1] ?? l))]
    return fail(`litter: the index has unmerged entries (${paths.slice(0, 10).join(', ')}); finish or abort the merge first`, 'checkout')
  }
  const snap = await snapshot(p, checkout)
  if (snap.dirty_submodules.length > 0) {
    return fail(`litter: submodules have uncommitted work (${snap.dirty_submodules.join(', ')}); commit, stash or discard inside them first`, 'dirty_submodules')
  }
  if (snap.tree !== headTree && snap.tree !== allowTree) {
    const changed = (await must(git, ['diff-tree', '-r', '--name-only', '--no-commit-id', '-z', headTree, snap.tree], 'clean check'))
      .split('\0')
      .filter(Boolean)
    const shown = changed.slice(0, 20).join(', ') + (changed.length > 20 ? `, and ${changed.length - 20} more` : '')
    return fail(
      `litter: the working tree has uncommitted changes (${shown}); they'd be reviewed and committed with the first gate. Commit or stash them, then launch`,
      'checkout',
    )
  }
  return { ok: true, head: head.stdout.trim(), headTree, tree: snap.tree, sparse: snap.sparse }
}

/** Reads a plan file the launcher named, absolute or relative to the checkout. */
async function readPlan(p: Ports, checkout: string, path: string): Promise<{ ok: true; path: string; text: string; sha: string } | RecordError> {
  const abs = path.startsWith('/') ? path : `${checkout}/${path.replace(/^\.\//, '')}`
  try {
    const t = await p.fs.read(abs)
    return { ok: true, path: abs, text: t, sha: await sha256(t) }
  } catch (err) {
    return fail(`litter: can't read the plan '${path}' (${errText(err)}); pass its path, absolute or relative to the checkout`, 'planPath')
  }
}

/** One run of a chain, as resolveChain loaded it. Exported, with resolveChain and chainLanded, for plan.ts (phase 3). */
export type Member = { run: string; json: RunJson; records: StoredRecord[] }

/**
 * A continuation's or amend's chain: the original run, its amends and its
 * continuations (plan section 9, "Continuations"). A plan run that names the
 * chain (a re-split's, with `continueOf`) isn't a member: it names it only for
 * its landed and halted context, lands nothing, and is on its own
 * `refs/litter/<run>/base`, not the chain's branch (phase 3, AB's finding).
 */
export async function resolveChain(
  p: Ports,
  litterDir: string,
  run: string,
  opts: { checked?: boolean } = {},
): Promise<{ ok: true; root: Member; members: Member[] } | RecordError> {
  // A view (the board) reads the chain as it stands; everything else acts on it, so on run.json as run.start wrote it.
  const checked = opts.checked !== false
  const cache = new Map<string, Loaded>()
  const load = async (r: string): Promise<Loaded> => {
    let l = cache.get(r)
    if (!l) {
      l = await loadRun(p, litterDir, r, { checked })
      cache.set(r, l)
    }
    return l
  }
  const startOf = (l: Loaded) => runState(l.records).start
  // The run it continues or amends; undefined: no run. Checked, from its run.start (chained), so a changed run.json moves no run into or out of a chain.
  const parentOf = (l: Loaded): string | null | undefined => {
    const start = startOf(l)
    if (!checked) return l.json ? (l.json.continueOf ?? l.json.amendOf?.run ?? null) : undefined
    return start ? (start.continueOf ?? start.amendOf?.run ?? null) : undefined
  }
  const rootOf = async (r: string): Promise<string | null> => {
    const seen = new Set<string>()
    let cur = r
    for (;;) {
      if (seen.has(cur) || seen.size > 100) return null
      seen.add(cur)
      const up = parentOf(await load(cur))
      if (up === undefined) return null
      if (up === null) return cur
      cur = up
    }
  }
  const named = await load(run)
  if (!named.json) return fail(`litter: ${named.refused ?? `no run ${run} in ${litterDir} (no run.json)`}`, 'continueOf')
  const rootRun = await rootOf(run)
  if (!rootRun) return fail(`litter: run ${run}'s chain doesn't lead back to an original run`, 'continueOf')
  const members: Member[] = []
  for (const r of await listRuns(p, litterDir)) {
    if ((await rootOf(r)) !== rootRun) continue
    const l = await load(r)
    if ((l.json?.workflow ?? startOf(l)?.workflow) === 'plan' && r !== rootRun) continue
    if (l.tampered) return fail(`litter: run ${r} in this chain has a tampered ledger (at ${l.tampered.seq}); litter won't continue it`, 'continueOf')
    if (!l.json) return fail(`litter: ${l.refused ?? `run ${r} in this chain has no run.json`}`, 'continueOf')
    members.push({ run: r, json: l.json, records: l.records })
  }
  const root = members.find(m => m.run === rootRun)!
  const stray = members.find(m => m.json.ref !== root.json.ref)
  if (stray) return fail(`litter: run ${stray.run} in this chain isn't on ${root.json.ref}`, 'continueOf')
  return { ok: true, root, members }
}

export type Landed = { landed: Map<string, string>; foreign: string[] }

/** A gate landed if it has a land record anywhere in the chain, or a commit with its trailer on the chain's ref. */
export async function chainLanded(git: Git, root: Member, members: Member[]): Promise<Landed> {
  const landed = new Map<string, string>()
  const runs = new Set(members.map(m => m.run))
  for (const m of members) {
    for (const r of m.records) {
      if (r.kind === 'land' && typeof r.body.gate === 'string' && typeof r.body.commit === 'string') landed.set(r.body.gate, r.body.commit)
    }
  }
  const foreign: string[] = []
  const log = await git(['log', '-z', '--format=%H%x01%(trailers:key=Litter-Run,valueonly)', `${root.json.base}..${root.json.ref}`])
  if (log.code === 0) {
    for (const entry of log.stdout.split('\0').filter(Boolean)) {
      const [hash, trailers = ''] = entry.split('\x01')
      const ours = trailers
        .split('\n')
        .map(l => l.trim().split(/\s+/))
        .filter(parts => parts.length >= 2 && runs.has(parts[0]!))
      if (ours.length === 0) foreign.push(hash!.trim())
      for (const [, gate] of ours) if (!landed.has(gate!)) landed.set(gate!, hash!.trim())
    }
  }
  return { landed, foreign }
}

/** The plan's gates as execute.js reads them (snake_case `done_when`, `lines` as text, `checks` as a list). */
function argsGate(g: Gate, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: g.id,
    title: g.title,
    excerpt: g.excerpt,
    files: g.files,
    checks: g.checks.split('\n').filter(c => c !== ''),
    done_when: g.doneWhen,
    lines: `${g.lines.start}-${g.lines.end}`,
    adversary: g.adversary,
    rollback: g.rollback,
    rules: [],
    ...extra,
  }
}

/** Your constraints for this run, first in args.rules (plan section 16.5), before the accepted rules selection adds. */
const renderRunRules = (rules: readonly string[]): string[] => rules.map(r => `For this run (stated by you): ${r}`)

/**
 * AE's selection for a launch. A failure refuses the launch before anything
 * is written: a run that can't be told its rules doesn't start (section 9,
 * "Fail closed").
 */
async function selectRules(p: Ports, input: SelectInput): Promise<Parsed<Selection>> {
  try {
    return ok(await deps.selectForRun(p, input))
  } catch (err) {
    return fail(`litter: the accepted rules couldn't be selected for this run (${errText(err)}); /litter rules shows them and their problems. Launch again once it's fixed`)
  }
}

/**
 * The adversary's Bash clamp (decision 23): fanout.js's read-only list
 * (workflows/fanout.js, READ_ONLY_BASH), plus the verify command as a prefix,
 * so it can run the suite and nothing else that writes.
 */
export const READ_ONLY_BASH = [
  'Bash(cat:*)',
  'Bash(git blame:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git ls-files:*)',
  'Bash(git show:*)',
  'Bash(git status:*)',
  'Bash(grep:*)',
  'Bash(head:*)',
  'Bash(ls:*)',
  'Bash(pwd)',
  'Bash(tail:*)',
  'Bash(wc:*)',
] as const
const adversaryClamp = (verifyCommand: string): string[] => [...READ_ONLY_BASH, `Bash(${verifyCommand}:*)`]

/** Asks you to approve an argv other than the configured one, showing it exactly. */
async function approveArgv(p: Ports, what: string, given: string[] | null, configured: readonly string[] | undefined): Promise<Parsed<string[] | null>> {
  if (given === null) return ok(configured ? [...configured] : null)
  if (configured && configured.length === given.length && configured.every((a, i) => a === given[i])) return ok(given)
  const question = `litter wants to run this ${what} command, which isn't the configured one:\n\n  ${shellQuote(given)}\n\nRun it for this launch?`
  try {
    const answer = await p.ask(question, { options: ['Refuse', 'Approve'], header: `litter ${what}` })
    if (answer === 'Approve') return ok(given)
    return fail(`litter: you refused the ${what} command ${shellQuote(given)}; use the configured one or set the ${what} plugin option`, what)
  } catch {
    return fail(
      `litter: the ${what} command ${shellQuote(given)} isn't the configured one, and no one could approve it here (as under -p); set the ${what} plugin option instead`,
      what,
    )
  }
}

function sameArgv(a: readonly string[], b: unknown): boolean {
  return Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i])
}

/**
 * A carry-over reuses a green verify of HEAD's tree with the same argv, from
 * anywhere in the chain. Exported for the execute bridge's baseline
 * (repair.ts, decision 9), which finds the branch tip's the same way.
 */
export function greenBaseline(members: Member[], headTree: string, verify: readonly string[]): Record<string, unknown> | null {
  for (const m of [...members].reverse()) {
    for (const r of [...m.records].reverse()) {
      if (r.kind !== 'verify') continue
      const v = r.body as unknown as VerifyBody
      if (v.exit_code === 0 && !v.timed_out && v.tree_before === headTree && v.tree_after === headTree && v.dirty_submodules?.length === 0 && sameArgv(verify, v.argv)) {
        return { verify_id: v.verify_id, exit_code: 0, green: true }
      }
    }
  }
  return null
}

/** What a run.start computed before it writes anything. */
type Prepared = {
  checkout: string
  base: string
  ref: string
  previousBranch: string | null
  /** Steps 3's transaction lines (after `verify` of the lock). */
  create: string[]
  /** Switch HEAD in the same transaction (the default for execute and fanout). */
  switchHead: string | null
  isolatePath: string | null
  plan: { path: string; text: string; sha: string } | null
  /**
   * An execute run's widenings you confirmed before Launch (WP-AO), each
   * with the files it added; `planCopy` is the plan's text with them, which
   * the run's plan.md gets, and `rootDir` the chain root's folder, whose
   * plan.md gets them too, for a continuation or an amend.
   */
  widened: WideningInput[]
  planCopy: string | null
  rootDir: string | null
  /** The date their notes give, `yyyy-mm-dd`. */
  widenedOn: string
  verify: string[] | null
  goalCheck: string[] | null
  setup: string[] | null
  linkDirs: string[]
  args: Record<string, unknown>
  foreignCommits: string[]
  warnings: string[]
  barText: string | null
  /** The accepted rule versions selection delivered (phase 3), for run.json's `rules`. */
  rules: RuleRef[]
  /** An amend's original run and gate, for run.json and run.start, with what its amendment added (amendNote). */
  amendOf: AmendOf | null
}

/**
 * An amend's `amendOf` as run.json keeps it: the files the original run's
 * latest gate.amend of the gate added to its Files (plan.ts, `filesAdded`),
 * and that amendment's reason on one line, when it added any. A text-only
 * amendment, or one recorded before the mod kept them, adds neither.
 */
function amendNote(a: { run: string; gate: string }, amended: Member | null): AmendOf {
  const last = amended ? [...amended.records].reverse().find(r => r.kind === 'gate.amend' && r.body.gate === a.gate) : undefined
  const added = Array.isArray(last?.body.filesAdded) ? (last.body.filesAdded as unknown[]).filter((f): f is string => typeof f === 'string') : []
  if (added.length === 0) return { run: a.run, gate: a.gate }
  const reason = last!.body.reason
  return { run: a.run, gate: a.gate, filesAdded: added, ...(typeof reason === 'string' && reason.trim() !== '' ? { reason: oneLine(reason, 500) } : {}) }
}

const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'litter',
  GIT_AUTHOR_EMAIL: 'litter@localhost',
  GIT_COMMITTER_NAME: 'litter',
  GIT_COMMITTER_EMAIL: 'litter@localhost',
}

/** A design's or plan's base: the checkout's snapshot wrapped in a commit, uncommitted work included (plan section 9, "Run worktrees"). */
async function snapshotBase(p: Ports, git: Git, checkout: string, run: string): Promise<string> {
  const snap = await snapshot(p, checkout)
  const head = await git(['rev-parse', '-q', '--verify', 'HEAD^{commit}'])
  const argv = ['commit-tree', snap.tree, ...(head.code === 0 ? ['-p', head.stdout.trim()] : []), '-F', '-']
  const r = await p.run(['git', '-C', checkout, ...argv], { stdin: `litter: base snapshot for ${run}\n`, env: SNAPSHOT_IDENTITY, timeoutMs: 120_000 })
  if (r.code !== 0) throw new Error(`base snapshot: git commit-tree failed (exit ${r.code}): ${r.stderr.trim()}`)
  return r.stdout.trim()
}

/** Steps 1 and 2, and the args of step 5: everything that can refuse, writing nothing. */
async function prepare(
  p: Ports,
  litterDir: string,
  options: LitterOptions,
  spec: Spec,
  run: string,
  nonce: string,
  checkout: string,
): Promise<{ ok: true; value: Prepared } | RecordError> {
  const git = gitAt(p, checkout)
  const runDir = runDirOf(litterDir, run)
  const runRules = renderRunRules(spec.runRules)
  // `rules` is filled once the accepted rules are selected (phase 3, AE): your run rules, then the run's.
  const base: Record<string, unknown> = { run, nonce, authorized: spec.authorized.join('\n'), rules: runRules }
  const select = (units: { gates?: SelectUnit[]; tasks?: SelectUnit[]; planText?: string | null }) =>
    selectRules(p, {
      litterDir,
      workflow: spec.workflow,
      gates: units.gates ?? [],
      tasks: units.tasks ?? [],
      planText: units.planText ?? null,
      goal: spec.goal,
      anchors: spec.design?.anchors ?? [],
      checkout,
      runRules,
    })
  // The parse's warnings first (a design's bar, BD's), then the checks'.
  const warnings: string[] = [...spec.warnings]
  const symbolic = await git(['symbolic-ref', '-q', 'HEAD'])
  const headRef = symbolic.code === 0 ? symbolic.stdout.trim() : null
  if (headRef !== null && !/^refs\/heads\/[^\s]+$/.test(headRef)) return fail(`litter: HEAD names '${headRef}', which isn't a branch`)
  // Every run makes commits with commit-tree (a design's base, a land), as you: without an identity the
  // land would fail after the run's work was done (tier 4, a box with no git config).
  for (const who of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const id = await git(['var', who])
    if (id.code !== 0) {
      const why = id.stderr.trim().split('\n').find(l => l.trim() !== '') ?? `git var ${who} failed`
      return fail(`litter: git has no identity to commit with here (${why}); set user.name and user.email, then launch`, 'checkout')
    }
  }

  if (spec.workflow === 'design' || spec.workflow === 'plan') {
    let plan: Prepared['plan'] = null
    let landedArgs: Record<string, unknown> = {}
    if (spec.planPath) {
      const r = await readPlan(p, checkout, spec.planPath)
      if (!r.ok) return r
      plan = r
    }
    if (spec.continueOf) {
      const chain = await resolveChain(p, litterDir, spec.continueOf)
      if (!chain.ok) return chain
      const landed = await chainLanded(git, chain.root, chain.members)
      const last = chain.members.at(-1)!
      const lastEnd = runState(last.records).latest?.end ?? runState(last.records).launchEnd
      landedArgs = {
        continueOf: spec.continueOf,
        landed: [...landed.landed].map(([id, commit]) => ({ id, commit })),
        halted: lastEnd?.reason ?? null,
      }
      if (!plan) {
        const r = await readPlan(p, checkout, runPlanPath(runDirOf(litterDir, chain.root.run)))
        if (!r.ok) return r
        plan = r
      }
    }
    // A plan run's selection is the planner's (phase 3); a design's is in its args, BD's designArgs.
    const sel = spec.workflow === 'plan' ? await select({ planText: plan?.text ?? null }) : null
    if (sel && !sel.ok) return sel
    const snapBase = await snapshotBase(p, git, checkout, run)
    const ref = `refs/litter/${run}/base`
    let args: Record<string, unknown>
    let rules: RuleRef[]
    let barText: string | null = null
    let setup: string[] | null = null
    let linkDirs: string[] = []
    if (spec.workflow === 'design') {
      const launch = await deps.designArgs(p, {
        litterDir,
        checkout,
        run,
        spec,
        runRules,
        base,
        snapBase,
        options,
        selectRules: input => selectRules(p, input),
      })
      if (!launch.ok) return launch
      ;({ args, rules, barText } = launch.value)
      // The probers' worktrees (decision 11): the setup a fanout's writers get, asked for the same
      // way, after the args' own refusals. policy.json carries it and the links for worktree.sh.
      const approved = await approveArgv(p, 'setup', spec.setup, options.setup)
      if (!approved.ok) return approved
      setup = approved.value
      linkDirs = spec.linkDirs
    } else {
      const verify = spec.verify ?? (options.verify ? [...options.verify] : null)
      const goalCheck = spec.goalCheck ?? (options.goalCheck ? [...options.goalCheck] : null)
      args = {
        ...base,
        // The planner's own selection (phase 3): the rules without paths and every ban, and those the plan or goal's files bring.
        rules: [...runRules, ...sel!.value.planner],
        goal: spec.goal,
        // planPath for the planner's <plan> tag (AB's plan.js).
        ...(plan ? { plan: plan.text, planPath: plan.path } : {}),
        ...(verify ? { verifyCommand: shellQuote(verify) } : {}),
        ...(goalCheck ? { goalCheckCommand: shellQuote(goalCheck) } : {}),
        ...landedArgs,
      }
      rules = sel!.value.versions
    }
    return {
      ok: true,
      value: {
        checkout,
        base: snapBase,
        ref,
        previousBranch: headRef,
        create: [`create ${ref} ${snapBase}`],
        switchHead: null,
        isolatePath: null,
        plan: spec.workflow === 'plan' ? plan : null,
        widened: [],
        planCopy: null,
        rootDir: null,
        widenedOn: '',
        // A design or plan run runs no argv: the mod doesn't run verify for them.
        verify: null,
        goalCheck: null,
        // A plan run makes no worktree; a design's probers each get one.
        setup,
        linkDirs,
        args,
        foreignCommits: [],
        warnings,
        barText,
        rules,
        amendOf: null,
      },
    }
  }

  // execute and fanout: step 1, the clean tree.
  let allowTree: string | null = null
  let chain: { root: Member; members: Member[] } | null = null
  let amended: Member | null = null
  if (spec.continueOf || spec.amendOf) {
    const c = await resolveChain(p, litterDir, (spec.continueOf ?? spec.amendOf!.run)!)
    if (!c.ok) return c
    chain = c
    if (headRef !== c.root.json.ref) {
      return fail(
        `litter: this run continues ${c.root.json.ref}, which isn't checked out here (HEAD is ${headRef ?? 'detached'}); ` +
          `run it from the checkout where it's checked out${c.root.json.isolate ? ` (${c.root.json.checkout})` : ''}`,
        spec.continueOf ? 'continueOf' : 'amendOf',
      )
    }
    if (spec.amendOf) {
      amended = c.members.find(m => m.run === spec.amendOf!.run) ?? null
      if (spec.carryOver && amended) {
        const last = [...amended.records].reverse().find(r => r.kind === 'verify' && r.body.gate === spec.amendOf!.gate)
        allowTree = last ? String((last.body as unknown as VerifyBody).tree_after) : null
        if (!allowTree) return fail(`litter: run ${spec.amendOf.run} has no verify of ${spec.amendOf.gate}, so there's no halted attempt to carry over; start clean`, 'carryOver')
      }
    }
  }
  const clean = await cleanCheck(p, git, checkout, allowTree)
  if (!clean.ok) return clean
  if (spec.workflow === 'fanout' && clean.sparse) {
    return fail("litter: a fanout can't land into a sparse checkout (read-tree -m -u refuses it); run it from a full checkout", 'checkout')
  }

  // Step 2: the gates, the chain, the tasks, then the argv asks.
  let plan: Prepared['plan'] = null
  let gates: Record<string, unknown>[] = []
  let landedArgs: Record<string, unknown> = {}
  let foreignCommits: string[] = []
  let baseline: Record<string, unknown> | null = null
  const widened: WideningInput[] = []
  let planCopy: string | null = null
  let widenedOn = ''
  if (spec.workflow === 'execute') {
    if (chain) {
      const r = await readPlan(p, checkout, runPlanPath(runDirOf(litterDir, chain.root.run)))
      if (!r.ok) return r
      plan = r
    } else {
      const r = await readPlan(p, checkout, spec.planPath!)
      if (!r.ok) return r
      plan = r
    }
    const read = parseGates(plan.text)
    if (!read.ok) return fail(`litter: ${read.error}`, read.field ?? 'planPath')
    if (read.gates.length === 0) {
      return fail("litter: the plan has no gate sections ('### G<n>: <title>'); split it into gates with a 'plan' run first", 'planPath')
    }
    // A continuation's landed gates; an amend's only when it widens one.
    const chainLands = chain && (!spec.amendOf || spec.widenings.length > 0) ? await chainLanded(git, chain.root, chain.members) : null
    // WP-AO: each widening you asked for before Launch, confirmed in the mod's dialog, then
    // applied to the text the run's copy of the plan gets; the gates are parsed from that.
    planCopy = plan.text
    if (spec.widenings.length > 0) {
      const ids = read.gates.map(x => x.id)
      const date = dateOf(await p.now())
      widenedOn = date
      for (const [i, w] of spec.widenings.entries()) {
        const at = `widenings[${i}]`
        const g = read.gates.find(x => x.id === w.gate)
        if (!g) return fail(`litter: the plan has no gate ${w.gate} to widen; its gates are ${ids.join(', ')}`, `${at}.gate`, ids)
        const landedAt = chainLands?.landed.get(w.gate)
        if (landedAt !== undefined) return fail(`litter: gate ${w.gate} has landed in this chain (${landedAt}), so it takes no more files`, `${at}.gate`)
        const applied = applyWidening(planCopy, w, date)
        if (!applied.ok) return fail(`litter: ${w.gate} can't be widened: ${applied.error}`, at)
        if (applied.added.length === 0) continue
        const answer = await askWiden(p, { run: chain ? chain.root.run : null, gate: w.gate, title: g.title, current: g.files, files: applied.added, why: w.why, at: 'launch' })
        if (answer === 'unasked') {
          return fail(
            `litter: no one could be asked to confirm ${w.gate}'s added files here (as under -p), and only your answer in litter's dialog widens a gate; launch without 'widenings', or from a session you're at`,
            at,
          )
        }
        if (answer === 'no') return fail(`litter: you kept ${w.gate} as written, so nothing was launched; launch again without its widening, or with the files you want`, at)
        planCopy = applied.text
        widened.push({ gate: w.gate, files: applied.added, why: w.why })
      }
    }
    const parsed = parseGates(planCopy)
    if (!parsed.ok) return fail(`litter: ${parsed.error}`, parsed.field ?? 'planPath')
    if (spec.amendOf) {
      const g = parsed.gates.find(x => x.id === spec.amendOf!.gate)
      if (!g) return fail(`litter: the plan has no gate ${spec.amendOf.gate}; its gates are ${parsed.gates.map(x => x.id).join(', ')}`, 'amendOf', parsed.gates.map(x => x.id))
      const carry = spec.carryOver
        ? 'The working tree holds the halted attempt at this gate, kept as your starting point. Read it first, then finish or correct it rather than starting beside it.'
        : undefined
      gates = [argsGate(g, carry ? { carryOver: carry } : {})]
    } else if (chain) {
      const landed = chainLands!
      const remaining = parsed.gates.filter(g => !landed.landed.has(g.id))
      if (remaining.length === 0) return fail(`litter: every gate of run ${chain.root.run}'s plan has landed; there's nothing left to continue`, 'continueOf')
      gates = remaining.map(g => argsGate(g))
      landedArgs = { landed: [...landed.landed].map(([id, commit]) => ({ id, commit })) }
      foreignCommits = landed.foreign
    } else {
      gates = parsed.gates.map(g => argsGate(g))
    }
  }

  // The accepted rules (16.5, AE): each gate's by its Files, each task's by its owned files.
  const sel = await select(
    spec.workflow === 'execute'
      ? { gates: gates.map(g => ({ id: String(g.id), files: [...(g.files as string[])] })), planText: plan?.text ?? null }
      : { tasks: spec.tasks.map(t => ({ id: t.id, files: [...t.files] })) },
  )
  if (!sel.ok) return sel
  const selection = sel.value

  const verify = await approveArgv(p, 'verify', spec.verify, options.verify)
  if (!verify.ok) return verify
  if (!verify.value) return fail("litter: no verify command: set the verify plugin option, or pass 'verify' as an argument list", 'verify')
  const goalCheck = await approveArgv(p, 'goalCheck', spec.goalCheck, spec.goalCheck ? options.goalCheck : undefined)
  if (!goalCheck.ok) return goalCheck
  const setup = await approveArgv(p, 'setup', spec.setup, options.setup)
  if (!setup.ok) return setup

  if (spec.carryOver && chain) {
    baseline = greenBaseline(chain.members, clean.headTree, verify.value)
    if (!baseline) {
      return fail(
        "litter: carry-over needs a green verify of HEAD's tree with the same verify command, and the chain has none " +
          '(a hand-made commit, or a changed verify command); stash the attempt and start clean',
        'carryOver',
      )
    }
  }

  const ref = chain ? chain.root.json.ref : `refs/heads/litter/${run}`
  const runPlan = runPlanPath(runDir)
  const verifyCommand = shellQuote(verify.value)
  const common = {
    ...base,
    rules: [...runRules, ...selection.run],
    verifyCommand,
  }
  const args: Record<string, unknown> =
    spec.workflow === 'execute'
      ? {
          ...common,
          planPath: runPlan,
          gates: gates.map(g => ({ ...g, rules: selection.gates[String(g.id)] ?? [] })),
          ...landedArgs,
          maxAttempts: spec.maxAttempts,
          adversary: spec.adversary,
          adversaryClamp: adversaryClamp(verifyCommand),
          ...(goalCheck.value ? { goalCheck: true, goalCheckCommand: shellQuote(goalCheck.value) } : {}),
          ...(baseline ? { baseline } : {}),
          ...(spec.continueOf ? { continueOf: spec.continueOf } : {}),
          ...(spec.amendOf ? { amendOf: spec.amendOf } : {}),
          // Who may add files to a gate (WP-AO): the critic's tag says so (execute.js).
          widen: spec.widen ?? 'ask',
        }
      : {
          ...common,
          tasks: spec.tasks.map(t => ({
            id: t.id,
            title: t.title,
            text: t.text,
            writes: t.writes,
            files: t.files,
            rules: selection.tasks[t.id] ?? [],
            ...(t.writes ? { bind: randomId() } : {}),
          })),
          contract: spec.contract ?? '',
          mergeOrder: spec.mergeOrder,
          // The verifier's own beyond args.rules, already capped (decision 20).
          verifierRules: selection.verifier,
        }

  const isolatePath = spec.isolate ? `${checkout}/.claude/worktrees/litter-${run}` : null
  const fenced = !chain
  let create: string[] = []
  let switchHead: string | null = null
  if (fenced) {
    create = [`create ${ref} ${clean.head}`]
    if (!spec.isolate) {
      if (await hasSymrefUpdate(git)) switchHead = headRef ? `symref-update HEAD ${ref} ref ${headRef}` : `symref-update HEAD ${ref} oid ${clean.head}`
      else {
        switchHead = 'plain'
        warnings.push("git is older than 2.46, so the switch to the run's branch isn't in the lock's transaction; litter checked the lock just before it")
      }
    }
  }
  return {
    ok: true,
    value: {
      checkout: isolatePath ?? checkout,
      base: clean.head,
      ref,
      previousBranch: headRef,
      create,
      switchHead,
      isolatePath,
      plan,
      widened,
      planCopy,
      rootDir: chain && widened.length > 0 ? runDirOf(litterDir, chain.root.run) : null,
      widenedOn,
      verify: verify.value,
      goalCheck: goalCheck.value,
      setup: setup.value,
      linkDirs: spec.linkDirs,
      args,
      foreignCommits,
      warnings,
      barText: null,
      rules: selection.versions,
      amendOf: spec.amendOf ? amendNote(spec.amendOf, amended) : null,
    },
  }
}

// ---------------------------------------------------------------------------
// run.start: the writes

type Started = {
  ref: RunRef
  held: LockHeld
  git: Git
  prep: Prepared
  /** The session's checkout, where the branch was made. */
  origin: string
  switched: boolean
  branchMade: boolean
  /** The run.start record is in the ledger, so a refusal from here is recorded as launch_failed. */
  recorded: boolean
}

/** Undoes step 3 after a refusal past it: HEAD back where it was, then the branch deleted at base. Only while the lock holds. */
async function rollback(p: Ports, s: Started): Promise<string | null> {
  const repo = repoOf(s.ref.litterDir)
  if (!(await stillHeld(p, repo, s.held.oid))) return 'the lock was lost, so the branch was left as it is'
  const verify = `verify ${LOCK_REF} ${s.held.oid}`
  if (s.prep.isolatePath && (await p.fs.exists(s.prep.isolatePath))) {
    await s.git(['worktree', 'remove', '--force', '--force', '--', s.prep.isolatePath])
  }
  // Two transactions: one that moves HEAD and deletes the branch HEAD names is refused ("multiple updates for 'HEAD'").
  if (s.switched) {
    const back = s.prep.previousBranch ? `symref-update HEAD ${s.prep.previousBranch} ref ${s.prep.ref}` : `update HEAD ${s.prep.base}`
    const r = await transaction(s.git, [verify, back], true)
    if (!r.ok) return `HEAD wasn't switched back (${r.error})`
  }
  if (s.branchMade) {
    const r = await transaction(s.git, [verify, `delete ${s.prep.ref} ${s.prep.base}`], false)
    if (!r.ok) return `${s.prep.ref} wasn't deleted (${r.error})`
  }
  return null
}

/** The run worktree under `isolate: true`, intent first (plan section 9, "Run worktrees"). */
async function addRunWorktree(p: Ports, options: LitterOptions, s: Started): Promise<string | null> {
  const path = s.prep.isolatePath!
  const name = `litter-${s.ref.run}`
  const branch = s.prep.ref.replace(/^refs\/heads\//, '')
  const body = { run: s.ref.run, name, path, branch, base: s.prep.base, disposable: false }
  await appendRecord(p, s.ref.runDir, { run: s.ref.run, kind: 'worktree.intent', by: MOD, body })
  const added = await s.git(['worktree', 'add', '--', path, branch])
  if (added.code !== 0) return `git worktree add failed: ${added.stderr.trim()}`
  const head = await p.run(['git', '-C', path, 'rev-parse', 'HEAD'])
  if (head.code !== 0 || head.stdout.trim() !== s.prep.base) return `the run worktree isn't at ${s.prep.base}`
  if (s.prep.setup) {
    const log = verifyLogPart(s.ref.runDir, `setup-${name}`, 1)
    let r: { code: number; stdout: string; stderr: string }
    try {
      r = await p.run(s.prep.setup, { cwd: path, timeoutMs: Math.min(options.verifyTimeoutMs, 600_000) })
    } catch (err) {
      r = { code: -1, stdout: '', stderr: errText(err) }
    }
    await p.fs.write(log, `${r.stdout}${r.stderr}`)
    if (r.code !== 0) {
      await appendRecord(p, s.ref.runDir, { run: s.ref.run, kind: 'worktree.setup_failed', by: MOD, body: { ...body, exit_code: r.code, log } })
      return `the setup command ${shellQuote(s.prep.setup)} failed in the run worktree (exit ${r.code}); its output is in ${log}`
    }
  }
  const status = await p.run(['git', '-C', path, 'status', '--porcelain', '--ignored', '-z', NOT_INTO_SUBMODULES])
  const ignored = status.stdout.split('\0').filter(l => l.startsWith('!! ')).map(l => l.slice(3))
  await appendRecord(p, s.ref.runDir, { run: s.ref.run, kind: 'worktree.create', by: MOD, body: { ...body, ignored } })
  return null
}

/**
 * The chain root's plan.md with your launch widenings (WP-AO), so the
 * chain's next run keeps them. Under the plan lock plan.ts's handlers take,
 * and read again there, so an amend or a re-split written since the parse
 * is kept; the previous file is kept as plan.<n>.md. Throws when a widening
 * no longer applies.
 */
async function widenRoot(p: Ports, rootDir: string, widened: readonly WideningInput[], date: string): Promise<void> {
  await serial(`plan:${rootDir}`, async () => {
    const before = await p.fs.read(runPlanPath(rootDir))
    let text = before
    for (const w of widened) {
      const a = applyWidening(text, w, date)
      if (!a.ok) throw new Error(`the chain's plan ${runPlanPath(rootDir)} couldn't take ${w.gate}'s added files: ${a.error}`)
      text = a.text
    }
    if (text !== before) await writePlanVersion(p, rootDir, text)
  })
}

/** run.start's `next` (design D9): the host's launch step, so one skill text serves both hosts. */
export function launchStep(host: 'claude-code' | 'codex', workflow: Workflow, run: string, checkout: string, isolate: boolean): string {
  if (host === 'codex') {
    return [
      `Call \`mcp__litter__run\` with \`{ op: 'launch', run: '${run}' }\`. If it refuses, show the reason and stop.`,
      `Tell the user in two or three lines what launched.`,
      `Then call \`mcp__litter__run\` with \`{ op: 'wait', run: '${run}' }\`, and again each time it answers that the run is still running, until it answers that the run has ended.`,
      `Its answer carries the run's \`status\`, \`reason\`, \`summary\` and the workflow's return value as \`result\`.`,
      `To stop the run, call it with \`{ op: 'stop', run: '${run}' }\`.`,
      `litter's agents work in ${checkout} themselves, so stay in your own directory.`,
    ].join(' ')
  }
  return [
    ...(isolate ? [`First call EnterWorktree with \`path\` set to ${checkout}. Don't call it with a name.`] : []),
    `Call Workflow with \`name: '${workflowName(workflow)}'\` and the \`args\` above, as a JSON object rather than a string. If it returns an error, show it; the mod records the failed launch.`,
    `Tell the user in two or three lines what launched, then end your turn.`,
    `The completion notification will come to you, so don't sleep, poll or re-read run files.`,
    `To stop the run, call TaskStop with the task id from the launch result.`,
  ].join(' ')
}

/** Steps 1 to 5 with the lock held. Every refusal before step 3 writes nothing; one after it records launch_failed and rolls back. */
async function startHeld(
  p: Ports,
  litterDir: string,
  options: LitterOptions,
  spec: Spec,
  run: string,
  mode: string,
  checkout: string,
  sessionId: string,
  held: LockHeld,
): Promise<RunStartReply | RecordError> {
  const nonce = randomId().replace(/-/g, '').slice(0, 12)
  const prepared = await prepare(p, litterDir, options, spec, run, nonce, checkout)
  if (!prepared.ok) return prepared
  const prep = prepared.value
  const ref: RunRef = { run, runDir: runDirOf(litterDir, run), litterDir }
  const repo = repoOf(litterDir)
  const git = gitAt(p, checkout)

  // The plan as parsed must still be the file (step 4's rule, checked again before step 3 writes anything).
  if (prep.plan) {
    const again = await readPlan(p, checkout, prep.plan.path)
    if (!again.ok || again.sha !== prep.plan.sha) return fail(`litter: the plan ${prep.plan.path} changed while the launch was being checked; launch again`, 'planPath')
  }

  const json: RunJson = {
    v: 1,
    run,
    workflow: spec.workflow,
    args: prep.args,
    authorized: spec.authorized,
    mode,
    verify: prep.verify,
    goalCheck: prep.goalCheck,
    setup: prep.setup,
    linkDirs: prep.linkDirs,
    base: prep.base,
    ref: prep.ref,
    checkout: prep.checkout,
    isolate: spec.isolate,
    previousBranch: prep.previousBranch,
    continueOf: spec.continueOf,
    amendOf: prep.amendOf,
    rules: prep.rules,
    planPath: prep.plan?.path ?? null,
    planSha256: prep.plan?.sha ?? null,
    session: sessionId,
    created: await p.now(),
    // The trailers option's lines at launch (decision 4): land.ts's attribution adds them to every land's message.
    ...(options.trailers.length > 0 ? { trailers: [...options.trailers] } : {}),
    // The repair setting the launch confirmation stated (2b-2), under runJsonSha256 with the rest.
    ...(spec.repair ? { repair: spec.repair } : {}),
    // Who may add files to a gate (WP-AO), likewise.
    ...(spec.widen ? { widen: spec.widen } : {}),
  }
  const jsonText = `${JSON.stringify(json, null, 2)}\n`

  // Step 3: freeze base and branch off, fenced by the lock.
  const s: Started = { ref, held, git, prep, origin: checkout, switched: false, branchMade: false, recorded: false }
  const verifyLock = `verify ${LOCK_REF} ${held.oid}`
  if (prep.create.length > 0 || prep.switchHead) {
    const lines = [verifyLock, ...prep.create, ...(prep.switchHead && prep.switchHead !== 'plain' ? [prep.switchHead] : [])]
    const tx = await transaction(git, lines, true)
    if (!tx.ok) {
      const lost = !(await stillHeld(p, repo, held.oid))
      return fail(
        lost
          ? "litter: the project's run lock was taken over while this launch was being checked (another session recovered it); nothing was created. Launch again"
          : `litter: couldn't create ${prep.ref}: ${tx.error}`,
        'checkout',
      )
    }
    s.branchMade = prep.create.length > 0
    s.switched = prep.switchHead !== null && prep.switchHead !== 'plain'
    if (prep.switchHead === 'plain') {
      if (!(await stillHeld(p, repo, held.oid))) {
        s.switched = false
        await rollback(p, s)
        return fail("litter: the project's run lock was lost before the switch; nothing was launched. Launch again", 'checkout')
      }
      const sw = await git(['symbolic-ref', '-m', `litter: run ${run}`, 'HEAD', prep.ref])
      if (sw.code !== 0) {
        await rollback(p, s)
        return fail(`litter: couldn't switch to ${prep.ref}: ${sw.stderr.trim()}`, 'checkout')
      }
      s.switched = true
    }
  } else if (!(await stillHeld(p, repo, held.oid))) {
    return fail("litter: the project's run lock was lost while this launch was being checked; launch again", 'checkout')
  }

  // From here a refusal is a launch that failed: recorded, rolled back, the lock released by the caller.
  const abort = async (reason: string): Promise<RecordError> => {
    const undone = await rollback(p, s)
    const stated = undone ? `${reason}; ${undone}` : reason
    if (s.recorded) {
      try {
        await endRun(p, ref, { taskId: null, generation: 0, status: 'launch_failed', reason: stated, source: 'mod' })
      } catch (err) {
        p.log(`run ${run}: launch_failed not recorded: ${errText(err)}`)
      }
    }
    return fail(`litter: ${stated}; nothing was launched`)
  }

  try {
    const args = prep.args
    const start: RunStartBody = {
      workflow: spec.workflow,
      base: prep.base,
      ref: prep.ref,
      checkout: prep.checkout,
      isolate: spec.isolate,
      previousBranch: prep.previousBranch,
      verify: prep.verify,
      goalCheck: prep.goalCheck,
      setup: prep.setup,
      authorized: spec.authorized,
      mode,
      continueOf: spec.continueOf,
      amendOf: prep.amendOf,
      planSha256: prep.plan?.sha ?? null,
      argsSha256: await sha256(JSON.stringify(args)),
      runJsonSha256: await sha256(jsonText),
      oid: held.oid,
      session: sessionId,
      ...(spec.repair ? { repair: spec.repair } : {}),
    }
    if (!(await stillHeld(p, repo, held.oid))) return await abort('the lock was lost before the run files were written')
    await appendRecord<RunStartBody>(p, ref.runDir, { run, kind: 'run.start', by: LAUNCHER, body: start })
    s.recorded = true

    if (prep.isolatePath) {
      const why = await addRunWorktree(p, options, s)
      if (why) return await abort(why)
    }

    // Step 4: the run files, then the policy and `active`.
    if (!(await stillHeld(p, repo, held.oid))) return await abort('lock lost')
    await atomicWrite(p, runJsonPath(ref.runDir), jsonText)
    if (prep.plan) {
      const now = await readPlan(p, checkout, prep.plan.path)
      if (!now.ok || now.sha !== prep.plan.sha) return await abort(`the plan ${prep.plan.path} changed between its parse and its copy`)
      await atomicWrite(p, runPlanPath(ref.runDir), prep.planCopy ?? prep.plan.text)
    }
    if (prep.barText) await atomicWrite(p, `${ref.runDir}/bar.md`, prep.barText)
    await activate(p, litterDir, json, sessionId, { runIds: [], launching: false })

    if (!(await stillHeld(p, repo, held.oid))) return await abort('lock lost')
    // Your widenings (WP-AO), last, so a refused launch leaves the chain's plan as it was:
    // one record each, then the chain root's plan.md, for a continuation or an amend.
    if (prep.widened.length > 0) {
      const plans = [runPlanPath(ref.runDir), ...(prep.rootDir ? [runPlanPath(prep.rootDir)] : [])]
      for (const w of prep.widened) {
        await appendRecord<GateWidenBody>(p, ref.runDir, { run, kind: 'gate.widen', by: MOD, body: { ...w, by: 'you', at: 'launch', plans } })
      }
      if (prep.rootDir) await widenRoot(p, prep.rootDir, prep.widened, prep.widenedOn)
    }
    const pending: Pending = { ...ref, checkout: prep.checkout, oid: held.oid, session: sessionId, workflow: spec.workflow, at: await p.now() }
    await p.store.set(pendingKey(litterDir), pending)
    const host = session().host
    const reply: RunStartReply = { ok: true, run, runDir: ref.runDir, checkout: prep.checkout, args, host, next: launchStep(host, spec.workflow, run, prep.checkout, spec.isolate) }
    if (prep.foreignCommits.length > 0) reply.foreignCommits = prep.foreignCommits
    if (prep.warnings.length > 0) reply.warnings = prep.warnings
    return reply
  } catch (err) {
    return await abort(`run.start failed after the branch was made: ${errText(err)}`)
  }
}

/** `run.start`: every check that can refuse, then the lock, the branch, the run files and the args. */
export const recordRunStart: RecordHandler = async (ctx, input) => {
  const { p, litterDir, options } = ctx
  if (ctx.caller.agentId !== null) return fail("run.start is the launcher's: a litter agent can't start a run", 'kind')
  if (!litterDir) {
    return fail(`litter: this session has no litter directory (${session().litterDirError ?? "session.start hasn't resolved it"}); open a session in the repository's checkout once, then launch`)
  }
  const parsed = parseStart(input, options)
  if (!parsed.ok) return parsed
  const spec = parsed.value

  // Step 0: the mode, jq, then the lock.
  const mode = await modeRefusal(p, litterDir)
  if (mode.refusal) return fail(mode.refusal, 'mode')
  if (!(await hasJq(p))) return fail("litter: jq isn't on PATH, and every litter command hook needs it; install jq, then launch again", 'jq')
  const where = await sessionCheckout(p, litterDir)
  if (!where.ok) return where
  const sessionId = await p.sessionId()
  const run = await newRun(p, litterDir, spec.workflow)
  const lock = await takeLock(p, litterDir, { run, session: sessionId, acquiredAt: await p.now() })
  if (!lock.ok) return lock
  const repo = repoOf(litterDir)
  const lease = startLease(p, litterDir, repo, lock.held)
  await lease.beat()
  let launched = false
  try {
    const r = await startHeld(p, litterDir, options, spec, run, mode.mode, where.checkout, sessionId, lock.held)
    launched = r.ok
    return r
  } catch (err) {
    return fail(`litter: run.start failed: ${errText(err)}; nothing was launched`)
  } finally {
    if (!launched) {
      lease.cancel()
      await releaseLock(p, repo, lock.held.oid)
      await removeLease(p, litterDir, lock.held.oid)
    }
  }
}

// ---------------------------------------------------------------------------
// The launcher's run.end fallback

const ENGINE_WORDS: Record<string, RunStatus> = { failed: 'failed', killed: 'stopped' }

/** `run.end` from a launcher: the fallback, accepted only for the open generation's task id. */
export const recordRunEnd: RecordHandler = async (ctx, input) => {
  const { p, litterDir } = ctx
  if (ctx.caller.agentId !== null) return fail("run.end is the launcher's fallback: a litter agent can't end a run", 'kind')
  if (!litterDir) return fail('litter: this session has no litter directory')
  if (typeof input.run !== 'string' || !RUN_ID.test(input.run)) return fail("'run' must be the run id", 'run')
  if (typeof input.taskId !== 'string' || input.taskId === '') return fail("'taskId' must be the task id from the notification", 'taskId')
  const status = typeof input.status === 'string' ? input.status : ''
  const allowed = [...RUN_STATUSES.filter(s => s !== 'launch_failed'), 'completed', 'failed', 'killed']
  if (!allowed.includes(status)) return fail("'status' must be the notification's status, or a run status", 'status', allowed)
  const ref: RunRef = { run: input.run, runDir: runDirOf(litterDir, input.run), litterDir }
  const ledger = await readLedger(p, ref.runDir, ref.run)
  if (ledger.tampered) return fail(`litter: run ${ref.run}'s ledger is tampered at ${ledger.tampered.seq}; litter won't act on it`, 'run')
  // Another host's run ends there. One with no head here may be this store's own, lost: only your yes adopts it.
  const foreign = (await owned(p, ref.runDir, ledger)) !== 'mine'
  const elsewhereText = `litter: run ${ref.run} is driven by another host or Codex home; end it there`
  if (foreign && ledger.anchor !== 'none') return fail(elsewhereText, 'run')
  const st = runState(ledger.records)
  const gen = st.generations.find(g => g.repair === null && g.taskId === input.taskId)
  // A repair generation has no task: its swarm's End closes it (2b-2), never this fallback.
  const repairing = st.open?.repair ? `; its open generation ${st.open.n} is repair swarm ${st.open.repair.swarm}'s, which ends it when the swarm ends` : ''
  if (!gen) {
    const latest = [...st.generations].reverse().find(g => g.repair === null)
    return fail(`litter: task ${input.taskId} isn't a generation of run ${ref.run}${latest ? ` (its latest task is ${latest.taskId})` : ''}${repairing}`, 'taskId')
  }
  if (gen.end) return { ok: true, recorded: false, end: gen.end }
  if (gen !== st.open) return fail(`litter: task ${input.taskId} isn't run ${ref.run}'s open generation${repairing || ` (task ${st.latest?.taskId})`}`, 'taskId')
  let decoded: Decoded
  if (status === 'completed' || status === 'done') {
    // Done only from a script return the decoder recognises; a claim alone fails closed (the decoder table's last row).
    let result: unknown = input.result
    if (typeof result === 'string') {
      try {
        result = JSON.parse(result)
      } catch {
        result = undefined
      }
    }
    decoded =
      result === undefined
        ? { status: 'failed', reason: 'unrecognized result: the launcher reported the run complete without its result' }
        : decodeReturn(workflowOf(st), { status: 'completed', result })
  } else {
    decoded = { status: ENGINE_WORDS[status] ?? (status as RunStatus), reason: typeof input.reason === 'string' ? input.reason : null }
  }
  if (foreign) {
    const last = ledger.records.at(-1)!
    const question =
      `Run ${ref.run} (session ${st.start?.session ?? 'unknown'}) has no head in this store: another host or Codex home may drive it, ` +
      `or this store lost its head. Its last record is ${last.seq}, ${last.kind}, at ${iso(last.at)}. ` +
      `End it here as ${decoded.status}? Only do this if this session launched it.`
    if (!(await askYes(p, question, 'End it here', 'Leave it'))) return fail(elsewhereText, 'run')
  }
  const r = await endRun(
    p,
    ref,
    {
      taskId: gen.taskId,
      generation: gen.n,
      status: decoded.status,
      reason: decoded.reason,
      ...(decoded.payload ? { payload: decoded.payload } : {}),
      source: 'launcher',
    },
    { adopt: foreign },
  )
  await afterEnd(p, ref, workflowOf(st), r)
  return { ok: true, recorded: r.recorded, end: r.end, summary: summaryPath(ref.runDir) }
}

// ---------------------------------------------------------------------------
// summary.md

const iso = (ms: number | null | undefined): string => (typeof ms === 'number' ? new Date(ms).toISOString() : 'unknown')

/**
 * summary.md from the ledger: the latest generation's end, earlier ones as
 * history, the gates that landed. A fanout's own part (integrate.ts) reads
 * the records up to its first repair; the "Repair" section is X's
 * (repair.ts, repairSummary), and each repair generation adds its own part.
 *
 * Exported so the repair bridge can rewrite it outside the run's serial key
 * (COMMON 2b-2, step 3); endRun writes it inside that key, so nothing it
 * calls takes the key.
 */
export async function writeSummary(p: Ports, ref: RunRef): Promise<void> {
  const { json, records, tampered } = await loadRun(p, ref.litterDir, ref.run)
  const st = runState(records)
  const start = st.start
  const workflow = json?.workflow ?? start?.workflow ?? 'unknown'
  const end = st.latest ? st.latest.end : st.launchEnd
  const lines: string[] = [`# litter run ${ref.run}`, '']
  const repairing = st.open?.repair ? `repairing (generation ${st.open.n}, repair swarm ${st.open.repair.swarm})` : null
  const status = end
    ? `${end.status}${end.reason ? ` (${end.reason})` : ''}${end.source === 'launcher' ? ', recorded by the launcher' : ''}`
    : (repairing ?? (st.open?.stopping ? 'stopping' : 'running'))
  lines.push(`- Workflow: ${workflow}`, `- Status: ${status}`)
  if (end?.settled === false) lines.push('- Settled: no (released before every agent had stopped)')
  if (tampered) lines.push(`- Ledger: tampered at record ${tampered.seq} (${tampered.reason}); nothing from there on is acted on`)
  if (json || start) {
    const ref2 = json?.ref ?? start!.ref
    lines.push(`- Branch: ${ref2.replace(/^refs\/heads\//, '')}`, `- Base: ${json?.base ?? start!.base}`, `- Checkout: ${json?.checkout ?? start!.checkout}`)
  }
  if (json?.continueOf) lines.push(`- Continues: ${json.continueOf}`)
  if (json?.amendOf) lines.push(`- Amends: ${json.amendOf.gate} of ${json.amendOf.run}`)
  lines.push(`- Started: ${iso(st.startedAt)}`)
  if (end && records.length > 0) lines.push(`- Ended: ${iso(records.filter(r => r.kind === 'run.end').at(-1)?.at)}`)
  if (end?.payload) lines.push('', '## Result', '', '```json', JSON.stringify(end.payload, null, 2), '```')
  if (end?.warnings?.length) lines.push('', '## Warnings', '', ...end.warnings.map(w => `- ${w}`))

  if (workflow === 'execute') {
    // AB's execute part (phase 3): attempts, verdicts, the halt, rules and proposals.
    lines.push(...(await executePart(p, ref, json, records)))
  } else if (workflow === 'design') {
    // BE's design part (phase 4): the stop, the delivery, the verdict card and the rest the skill reads.
    lines.push(...(await designPart(p, ref, json, records)))
  } else {
    const lands = records.filter(r => r.kind === 'land' && typeof r.body.gate === 'string')
    const planned = Array.isArray(json?.args.gates) ? (json!.args.gates as { id?: unknown }[]).map(g => String(g.id)) : []
    if (planned.length > 0 || lands.length > 0) {
      lines.push('', '## Gates', '', '| Gate | Landed |', '|---|---|')
      const landedBy = new Map(lands.map(r => [String(r.body.gate), String(r.body.commit ?? '')]))
      for (const id of [...new Set([...planned, ...landedBy.keys()])]) lines.push(`| ${id} | ${landedBy.has(id) ? landedBy.get(id) : 'no'} |`)
      const earlier = Array.isArray(json?.args.landed) ? (json!.args.landed as { id: string; commit: string }[]) : []
      if (earlier.length > 0) lines.push('', `Landed earlier in this chain: ${earlier.map(l => `${l.id} (${l.commit})`).join(', ')}`)
    }
  }
  // The fanout's own part describes how its workflow ended; a repair's verdicts and land are the repair's part below.
  const firstRepair = st.generations.find(g => g.repair !== null)
  lines.push(...fanoutSummary(json, firstRepair ? records.filter(r => r.seq < firstRepair.seq) : records))
  lines.push(...(await repairSection(p, ref)))
  for (const g of st.generations) if (g.repair) lines.push(...(await repairPart(p, ref, json, records, g)))
  lines.push(...worktreeSummary(records))
  if (st.generations.length > 1 || (st.generations.length === 1 && st.generations[0]!.stopping)) {
    lines.push('', '## Generations', '')
    for (const g of st.generations) {
      const e = g.end
      const what = g.repair ? `repair swarm ${g.repair.swarm} (launch ${g.repair.launch})` : `task ${g.taskId} (${g.runId})`
      lines.push(
        `${g.n}. ${what}: ${e ? `${e.status}${e.reason ? ` (${e.reason})` : ''}, from ${e.source}` : g.stopping ? 'stopping' : 'open'}${g.stopping ? `; stop requested ${iso(g.stopping.at)}` : ''}`,
      )
    }
  }
  lines.push('')
  await atomicWrite(p, summaryPath(ref.runDir), lines.join('\n'))
}

/** AB's execute part (execsummary.ts). Its failure is logged, and the rest of the summary stands. */
async function executePart(p: Ports, ref: RunRef, json: RunJson | null, records: readonly StoredRecord[]): Promise<string[]> {
  try {
    return await deps.executeSummary(p, ref, json, records)
  } catch (err) {
    p.log(`run ${ref.run}: the summary's execute part failed: ${errText(err)}`)
    return []
  }
}

/** BE's design part (design/summary.ts). Its failure is logged, and the rest of the summary stands. */
async function designPart(p: Ports, ref: RunRef, json: RunJson | null, records: readonly StoredRecord[]): Promise<string[]> {
  try {
    return await deps.designSummary(p, ref, json, records)
  } catch (err) {
    p.log(`run ${ref.run}: the summary's design part failed: ${errText(err)}`)
    return []
  }
}

/** X's "Repair" section (repair.ts). Its failure is logged, and the rest of the summary stands. */
async function repairSection(p: Ports, ref: RunRef): Promise<string[]> {
  try {
    const text = (await repairSummary(p, ref.runDir)).trim()
    return text === '' ? [] : ['', ...text.split('\n')]
  } catch (err) {
    p.log(`run ${ref.run}: the summary's Repair section failed: ${errText(err)}`)
    return []
  }
}

const counted = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`
const oneLine = (s: string, max = 300): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * The budget a repair swarm has now: its run.repair's, or the last one you
 * granted through `repair.budget` (a `budget` event in its launch ledger, X).
 */
async function budgetNow(p: Ports, litterDir: string, r: RunRepairBody): Promise<{ budget: RepairBudget; raised: boolean }> {
  let budget = r.budget
  let raised = false
  if (!SWARM_NAME.test(r.swarm) || !LAUNCH_ID.test(r.launch)) return { budget, raised }
  try {
    for (const x of (await readLaunchLedger(p, litterDir, r.swarm, r.launch)).records) {
      const b = x.body as { kind?: unknown; granted?: unknown; budget?: { rounds?: unknown; agents?: unknown } }
      if (x.kind !== 'swarm.event' || b.kind !== 'budget' || b.granted !== true) continue
      if (wholeIn(b.budget?.rounds, 1, 1_000) && wholeIn(b.budget?.agents, 1, 1_000)) {
        budget = { rounds: b.budget!.rounds as number, agents: b.budget!.agents as number }
        raised = true
      }
    }
  } catch {
    // an unreadable launch ledger: the budget the run.repair recorded
  }
  return { budget, raised }
}

/**
 * A repair generation's own part of summary.md (WP-W): its swarm and budget,
 * its verifies, each round's verdict, its land (or what refused one), and how
 * it ended. From the run's ledger, the records between its run.repair and its
 * run.end (decision 1: the swarm's gate records go there).
 *
 * An execute run's generation is its plan-template swarm's (phase 3): a round
 * is a rejecting verdict, so an approval is listed with its gate and no round,
 * and each gate it landed is listed. A fanout's lines are as before.
 */
async function repairPart(p: Ports, ref: RunRef, json: RunJson | null, records: readonly StoredRecord[], g: Generation): Promise<string[]> {
  const r = g.repair!
  const mine = records.filter(x => x.seq > g.seq && (g.endSeq === null || x.seq < g.endSeq))
  const { budget, raised } = await budgetNow(p, ref.litterDir, r)
  const execute = (json?.workflow ?? records.find(x => x.kind === 'run.start')?.body.workflow) === 'execute'
  const verifies = mine.filter(x => x.kind === 'verify' && typeof x.body.verify_id === 'string')
  const green = verifies.filter(x => x.body.green === true).length
  const verdicts = mine.map(v => {
    if (v.kind !== 'verdict' || typeof v.body.verify_id !== 'string') return null
    const tasks = Array.isArray(v.body.tasks) ? (v.body.tasks as { id?: unknown; pass?: unknown }[]) : []
    const failing = tasks.filter(t => t !== null && typeof t === 'object' && t.pass !== true && typeof t.id === 'string').map(t => String(t.id))
    const approved = typeof v.body.approved === 'boolean' ? v.body.approved : tasks.length > 0 && failing.length === 0
    return { v, failing, approved }
  }).filter(x => x !== null)
  // Decision 1: an execute generation's rounds are its rejections; a fanout's, every verdict (2b-2).
  const rounds = execute ? verdicts.filter(x => !x.approved).length : verdicts.length
  const lines = [
    '',
    `## Repair generation ${g.n}`,
    '',
    `- Swarm: ${r.swarm}, launch ${r.launch}`,
    `- Budget: ${counted(budget.rounds, 'round')} and ${counted(budget.agents, 'agent')}${raised ? ` (raised from ${r.budget.rounds} and ${r.budget.agents})` : ''}`,
    `- Verifies: ${verifies.length} (${green} green)`,
    `- Rounds: ${rounds} of ${budget.rounds}`,
  ]
  verdicts.forEach(({ v, failing, approved }, i) => {
    const gate = execute && typeof v.body.gate === 'string' ? ` (gate ${v.body.gate})` : ''
    const what = `verify ${String(v.body.verify_id)}${gate}: ${approved ? 'approved' : `rejected${failing.length > 0 ? `, failing ${failing.join(', ')}` : ''}`}`
    // A plan-template approval has no round, so no index of its own; a fanout's verdict keeps its place as before.
    const round = typeof v.body.round === 'number' ? v.body.round : execute ? null : i + 1
    lines.push(round === null ? `  - ${what}` : `  ${round}. ${what}`)
  })
  const branchOf = (land: StoredRecord): string => String(json?.ref ?? land.body.ref ?? '').replace(/^refs\/heads\//, '')
  // A plan-template swarm lands gate by gate: each land whose intent (or itself) is in the generation, as runState counts them.
  const intents = new Set(mine.filter(x => x.kind === 'land.intent' || x.kind === 'land').map(x => x.body.verify_id))
  const lands = execute ? records.filter(x => x.kind === 'land' && typeof x.body.verify_id === 'string' && intents.has(x.body.verify_id)) : []
  const land = !execute && g.land !== null ? records.find(x => x.kind === 'land' && x.body.commit === g.land) : undefined
  if (lands.length > 0) {
    lines.push(`- Landed: ${counted(lands.length, 'gate')} on ${branchOf(lands[0]!)}`)
    for (const x of lands) lines.push(`  - ${String(x.body.gate)}: ${String(x.body.commit)}, verify ${String(x.body.verify_id)}`)
  } else if (land) {
    lines.push(`- Landed: ${json?.base ?? String(land.body.old ?? '')}..${String(land.body.commit)} on ${branchOf(land)}, verify ${String(land.body.verify_id)}`)
  } else {
    lines.push('- Landed: no')
    for (const x of mine) {
      if ((x.kind === 'land.blocked' || x.kind === 'land.abandoned') && typeof x.body.reason === 'string') lines.push(`  - ${oneLine(x.body.reason)}`)
    }
  }
  lines.push(`- Ended: ${g.end ? `${g.end.status}${g.end.reason ? ` (${g.end.reason})` : ''}` : 'not yet: the swarm is working in it'}`)
  return lines
}

// ---------------------------------------------------------------------------
// Reconcile at session.start (plan section 9, "Reconcile, for ends nobody saw")

/** The runs reconcileRuns said it leaves to their owner, so each is logged once. */
const leftToOwner = new Set<string>()

/**
 * At session.start, after the spools are drained: every run without a
 * run.end is reconciled, and every run's lands. A run this store doesn't own
 * is its owner's to reconcile, and is skipped.
 */
export async function reconcileRuns(p: Ports, litterDir: string): Promise<void> {
  const repo = repoOf(litterDir)
  const sessionId = await p.sessionId()
  const lock = await readLock(p, repo).catch(() => null)
  const pending = await getPending(p, litterDir).catch(() => null)
  for (const run of await listRuns(p, litterDir)) {
    const ref: RunRef = { run, runDir: runDirOf(litterDir, run), litterDir }
    try {
      const ledger = await readLedger(p, ref.runDir, run)
      if (ledger.tampered) {
        p.log(`run ${run}: ledger tampered at ${ledger.tampered.seq} (${ledger.tampered.reason}); not reconciled`)
        continue
      }
      if ((await owned(p, ref.runDir, ledger)) !== 'mine') {
        if (!leftToOwner.has(ref.runDir)) p.log(`${elsewhere(run)}; not reconciled here`)
        leftToOwner.add(ref.runDir)
        continue
      }
      const st = runState(ledger.records)
      if (st.start && !st.ended) {
        if (st.generations.length === 0) await reconcilePending(p, ref, st, lock, pending, sessionId)
        else if (st.open?.repair) await reconcileRepair(p, ref, st.open)
        else if (st.open?.stopping) await trySettle(p, ref)
        else if (st.open) await reconcileOpen(p, ref, st, st.open, sessionId)
      }
      if (st.start) await reconcileLands(p, ref.runDir, run)
    } catch (err) {
      p.log(`run ${run} not reconciled: ${errText(err)}`)
    }
  }
  // The lock: a holder that ended is a stale lock; an orphan is recovered.
  const now = await readLock(p, repo).catch(() => null)
  if (now) {
    const freed = await reconcileHolder(p, litterDir, now.oid, now.blob, false, null).catch(err => ({ freed: false, message: errText(err) }) as Freed)
    if (!freed.freed) p.log(`lock: ${freed.message}`)
  }
  // Leases of oids that no longer hold the lock.
  const held = (await readLock(p, repo).catch(() => null))?.oid ?? null
  for (const e of (await p.fs.exists(litterDir)) ? await p.fs.list(litterDir) : []) {
    const m = /^lock-lease-([0-9a-f]{40,64})\.json$/.exec(e.name)
    if (m && m[1] !== held) await removeLease(p, litterDir, m[1]!)
  }
  // Writers' bindings of any run but the active one: a run.end that didn't finish its cleanup left them.
  // A policy.json that doesn't parse, or of another version, removes none.
  let policy: Policy | null | undefined
  try {
    policy = await readJson<Policy>(p, policyPath(litterDir))
  } catch (err) {
    p.log(`policy.json doesn't parse, so no writer binding was removed: ${errText(err)}`)
    return
  }
  if (policy !== undefined && (policy === null || typeof policy !== 'object' || policy.v !== 1)) return
  const active = policy?.run?.run ?? null
  await removeRunBindings(p, litterDir, run => run !== active).catch(err => p.log(`leftover writer bindings not removed: ${errText(err)}`))
}

/** A run.start with no generation: still this session's pending launch, someone else's live one, or dead. */
async function reconcilePending(
  p: Ports,
  ref: RunRef,
  st: RunState,
  lock: { oid: string; blob: LockBlob | null } | null,
  pending: Pending | null,
  sessionId: string,
): Promise<void> {
  const ours = pending?.run === ref.run && pending.session === sessionId
  if (lock && lock.blob?.run === ref.run) {
    if (ours && lock.oid === pending!.oid) {
      // A reload in the middle of a launch: the beat ended with the old module instance.
      const lease = startLease(p, ref.litterDir, repoOf(ref.litterDir), { ok: true, oid: lock.oid, blob: lock.blob })
      await lease.beat()
    }
    return // someone's lock: the lock pass below recovers it if it's an orphan
  }
  if (ours) await clearPending(p, ref.litterDir)
  await endRun(p, ref, { taskId: null, generation: 0, status: 'launch_failed', reason: 'not launched', source: 'reconcile' })
}

/** An open generation: the engine's snapshot ends it; otherwise it may still be running (adopted after backgrounding). */
async function reconcileOpen(p: Ports, ref: RunRef, st: RunState, gen: Generation, sessionId: string): Promise<void> {
  const snap = await engineSnapshot(p, ref.litterDir, gen)
  if (snap) {
    if (snap.status === 'killed') {
      await markStopping(p, ref, gen)
      await trySettle(p, ref)
      return
    }
    const d = decodeReturn(workflowOf(st), snap)
    await endRun(p, ref, { taskId: gen.taskId, generation: gen.n, status: d.status, reason: d.reason, ...(d.payload ? { payload: d.payload } : {}), source: 'reconcile' })
    return
  }
  // Still running, as far as anyone can tell: the policy names the new session, the task index is back.
  await p.store.set(taskKey(gen.taskId), ref)
  await p.store.set(wfKey(gen.runId), ref)
  if (!(await patchRunPolicy(p, ref.litterDir, ref.run, r => ({ ...r, launching: false }), sessionId))) {
    // The policy is built from run.json, so only from the one run.start wrote.
    const c = await checkedRunJson(p, ref)
    if (c.ok) await activate(p, ref.litterDir, c.json, sessionId, { runIds: [...new Set(st.generations.map(g => g.runId))], launching: false })
    else p.log(`reconcile ${ref.run}: ${c.reason}; its policy isn't restored`)
  }
}

// ---------------------------------------------------------------------------
// The spool

/** Spool consumer: stops (settling a stopping run), mode switches, a lost isolation context. */
export const consumeLifecycle: SpoolConsumer = async (ctx, line) => {
  const { p, litterDir } = ctx
  if (line.ev === 'start' || line.ev === 'stop') {
    // The transcript's folder is the project folder the engine's run snapshots live under.
    if (typeof line.transcript_path === 'string' && line.transcript_path.startsWith('/')) {
      const cut = line.transcript_path.indexOf('/subagents/')
      const projectDir = dirname(cut >= 0 ? line.transcript_path.slice(0, cut) : line.transcript_path)
      if ((await p.store.get(projectKey(litterDir))) !== projectDir) await p.store.set(projectKey(litterDir), projectDir)
    }
  }
  const policy = await readPolicy(p, litterDir).catch(() => undefined)
  const active = policy?.run ?? null
  if (!active) return
  const ref: RunRef = { run: active.run, runDir: active.runDir, litterDir }
  switch (line.ev) {
    case 'start':
    case 'stop': {
      if (!line.agent_type.startsWith('litter:') || line.agent_type.startsWith('litter:sw-')) return
      const key = agentsKey(ref.runDir)
      const set = ((await p.store.get(key)) as AgentSet | undefined) ?? { started: [], stopped: [] }
      const list = line.ev === 'start' ? set.started : set.stopped
      if (!list.includes(line.agent_id)) list.push(line.agent_id)
      await p.store.set(key, set)
      if (line.ev === 'stop' && active.stopping) await trySettle(p, ref)
      return
    }
    case 'mode': {
      if (line.agent_id !== null || !(REFUSED_MODES as readonly string[]).includes(line.mode)) return
      // The guard denies the run's agents in this mode (guard.sh); the board shows the switch.
      p.log(`run ${active.run}: the session switched to ${line.mode} mid-run; agents that start now are denied until it's back`)
      await noteEvent(p, ref.runDir, { ev: 'mode', mode: line.mode, ts: line.ts })
      return
    }
    case 'isolation-lost': {
      // A run agent's only: a swarm node's (or a node's child's) is the swarm's (observe.ts), and halts no run.
      if (!line.agent_type.startsWith('litter:') || line.agent_type.startsWith('litter:sw-')) return
      // Every later call of the run is denied, so the run halts rather than reading the parent checkout.
      await patchRunPolicy(p, litterDir, active.run, r => ({ ...r, isolationLost: true }))
      p.log(`run ${active.run}: agent ${line.agent_id} (${line.agent_type}) lost its isolation context on ${line.tool} (cwd ${line.cwd}); ${ISOLATION_CAUSE}`)
      await noteEvent(p, ref.runDir, { ev: 'isolation-lost', agent_id: line.agent_id, tool: line.tool, cwd: line.cwd, ts: line.ts })
      return
    }
    default:
      return
  }
}

// ---------------------------------------------------------------------------
// Generations, opened from the Workflow hook (launch.ts)

/** run.launch or run.resume after next(e) returned the task: opens the next generation and indexes it. */
export async function openGeneration(
  p: Ports,
  ref: RunRef,
  kind: 'run.launch' | 'run.resume',
  launched: { taskId: string; runId: string; scriptPath: string | null; driver?: RunDriver },
  sessionId: string,
  oid: string,
): Promise<number> {
  return serial(`run:${ref.runDir}`, async () => {
    const st = runState((await readLedger(p, ref.runDir, ref.run)).records)
    const n = st.generations.length + 1
    const body: RunLaunchBody = { ...launched, generation: n, session: sessionId, oid }
    await p.store.set(taskKey(launched.taskId), ref)
    await p.store.set(wfKey(launched.runId), ref)
    await appendRecord<RunLaunchBody>(p, ref.runDir, { run: ref.run, kind, by: MOD, body })
    return n
  })
}

/** Closes a generation still open when the next one opens, as interrupted (a crash-respawn's old one). */
export async function closeOpenAsInterrupted(p: Ports, ref: RunRef): Promise<void> {
  const st = runState((await readLedger(p, ref.runDir, ref.run)).records)
  if (!st.open) return
  await appendRecord<RunEndBody>(p, ref.runDir, {
    run: ref.run,
    kind: 'run.end',
    by: MOD,
    body: { taskId: st.open.taskId, generation: st.open.n, status: 'interrupted', reason: 'superseded by a resume', source: 'mod' },
  })
  await p.store.delete(taskKey(st.open.taskId))
}

/** The run a `wf_` id belongs to: the index, then the ledgers (the index may be gone with the store). */
export async function runOfWorkflowId(p: Ports, litterDir: string, runId: string): Promise<RunRef | null> {
  const ix = (await p.store.get(wfKey(runId))) as RunRef | undefined
  if (ix && ix.litterDir === litterDir) return ix
  for (const run of (await listRuns(p, litterDir)).reverse()) {
    const ref: RunRef = { run, runDir: runDirOf(litterDir, run), litterDir }
    const names = (await p.fs.exists(`${ref.runDir}/ledger`)) ? await p.fs.list(`${ref.runDir}/ledger`) : []
    if (!names.some(e => /-run\.(launch|resume)\.json$/.test(e.name))) continue
    const st = runState((await readLedger(p, ref.runDir, run)).records)
    if (st.generations.some(g => g.runId === runId)) return ref
  }
  return null
}

/**
 * Loads a run for the launch check: run.json, verified against the run.start
 * record's sha256. A run this store doesn't own is refused: a launch, a
 * resume, a reopen for a repair and the repair's checks all start here.
 */
export async function loadLaunchable(
  p: Ports,
  ref: RunRef,
): Promise<{ ok: true; json: RunJson; st: RunState } | { ok: false; reason: string; why: RunJsonRefusal }> {
  const c = await checkedRunJson(p, ref)
  return c.ok ? { ok: true, json: c.json, st: runState(c.ledger.records) } : { ok: false, reason: c.reason, why: c.why }
}
