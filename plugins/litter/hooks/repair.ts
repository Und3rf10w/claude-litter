// The failed-fanout bridge (plan 15.10, 15.11; COMMON 2b-2, steps 3, 4 and
// 6): whether a halted fanout continues as a repair swarm, its baseline, the
// spec generated from run facts, the launch with no ask under `repair: auto`
// (and with one on `repair.start` under `off`), the start on the lead's next
// turn, and more budget.
//
// Owner: phase 2b-2, package X. Package V's stubs: every export below is the
// contract. W's lifecycle.ts calls continueAsRepair after a halted fanout's
// endRun, and writeSummary takes repairSummary's section; register.tsx calls
// repairNote at prompt.submit and repairTurnComplete at turn.complete; the
// registry routes repair.start and repair.budget here; recover.ts calls
// restoreRepairStarts once the swarms are back.
//
// The order (COMMON step 3): every check that can decline runs before
// anything of the repair is written, the baseline last, since it runs the
// suite. A decline records `repair.declined { reason }` and nothing else (the
// baseline's own verify record stays, as history). From the reopen on, a
// failure ends the repair generation halted, with the reason.

import type { Ports } from './ports'
import type { Author, RecordCtx, RecordError, RecordHandler, RecordReply, StoredRecord } from './records/core'
import type { TurnCompleteHook } from './hooktypes'
import type { RepairDeclinedBody, RunEndBody, RunJson, RunRepairBody } from './records/run'
import type { IntegrateConflictBody, IntegrateDoneBody, IntegrateMergeBody, IntegrateSkipBody, TaskBindBody } from './records/fanout'
import type { VerifyBody } from './records/execute'
import type { SwarmEventBody } from './records/swarm'
import type { RepairBudget, RunLink, SwarmNode, SwarmSpec } from './swarm/types'
import type { RunFacts } from './verify'
import type { LaunchPlan } from './swarm/launch'
import type { RunRef, RunState } from './lifecycle'
import { fail } from './records/core'
import { appendRecord, readLedger } from './ledgercore'
import { RUN_ID, SWARM_NAME, launchDir, ledgerDir, ledgerFileName, runDir as runDirOf, runJsonPath, summaryPath, swarmDir, verifyLogDir } from './layout'
import { remove, serial, sha256 } from './fsx'
import { getOptions, session } from './session'
import { readLock } from './lock'
import { snapshot } from './snapshot'
import { REPAIR_AGENTS, REPAIR_ROUNDS } from './options'
import { MOD, howEnded, notGreen, verifyBody } from './verify'
import { fanoutTasks, integrationWorktree } from './integrate'
import { endRepairGeneration, loadLaunchable, reopenForRepair, repoOf, runState, writeSummary } from './lifecycle'
import { appendLaunchRecord, newLaunchId } from './records/swarm'
import { saveRevision } from './swarm/store'
import { beginLaunch, fillStart, goLive, launchQuestion, planLaunch } from './swarm/launch'
import { bindings, interactive, liveSwarm, patchLiveSwarm, reservations, roundsUsed, spawnsUsed } from './swarm/state'
import { confirmOwnership } from './swarm/owner'
import { readLaunchFacts } from './swarm/recover'
import { renderSlots } from './prompts/slots'
import {
  EVIDENCE_CONFLICT,
  EVIDENCE_VERDICT,
  EVIDENCE_VERIFY,
  FAILURE_CONFLICT,
  FAILURE_VERDICT,
  FAILURE_VERIFY,
  MERGED_ALL,
  MERGED_UNTIL_CONFLICT,
  REPAIR_CRITIC_BRIEF,
  REPAIR_FIXER_BRIEF,
  REPAIR_GOAL,
  REPAIR_NOTE,
  REPAIR_ORCHESTRATOR_BRIEF,
  REPAIR_START,
  REPAIR_TASK,
} from './prompts/swarm-repair'

// ---------------------------------------------------------------------------
// The other packages' functions, through one table so tier 2 can stand in for
// them (COMMON, "Another package's module"). The mod never changes it.

/** verify.ts's runVerify (main, fca57f6): what it's given. */
export type VerifyRun = { gate: string; attempt: number; where: string; by: Author; timeoutMs: number }
/** And what it answers: the verify body as recorded, its seq, and its log folder. */
export type VerifyRan = { ok: true; body: VerifyBody; seq: number; log: string }

export const deps = {
  reopenForRepair: (...a: Parameters<typeof reopenForRepair>) => reopenForRepair(...a),
  endRepairGeneration: (...a: Parameters<typeof endRepairGeneration>) => endRepairGeneration(...a),
  writeSummary: (...a: Parameters<typeof writeSummary>) => writeSummary(...a),
  saveRevision: (...a: Parameters<typeof saveRevision>) => saveRevision(...a),
  // main's runVerify isn't in this package's branch: the merge swaps this default for
  // `runVerify: (...a: Parameters<typeof runVerify>) => runVerify(...a),` with `import { runVerify } from './verify'`.
  runVerify: async (_p: Ports, _f: RunFacts, _o: VerifyRun): Promise<VerifyRan | RecordError> =>
    fail("litter: runVerify isn't merged into this build, so the baseline can't run"),
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const oneLine = (s: string, max = 300): string => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max)
const short = (ref: string): string => ref.replace(/^refs\/heads\//, '')
const body = <B>(r: StoredRecord): B => r.body as unknown as B
const noLitter = (s: string): string => s.replace(/^litter: /, '')

/** A list in words: `a`, `a and b`, `a, b and c`, the first `max` only. */
function words(xs: readonly string[], max = 12): string {
  const shown = xs.slice(0, max)
  const more = xs.length > max ? [`${xs.length - max} more`] : []
  const all = [...shown, ...more]
  return all.length <= 1 ? (all[0] ?? 'none') : `${all.slice(0, -1).join(', ')} and ${all.at(-1)!}`
}

const WRITE_TOOLS = ['Edit', 'Write', 'NotebookEdit']
/** The repair swarm's node ids (COMMON step 4). */
const ORCHESTRATOR = 'repair'
const FIXER = 'fixer'
const CRITIC = 'critic'

// ---------------------------------------------------------------------------
// The run's facts

type Facts = { ref: RunRef; json: RunJson; st: RunState; records: StoredRecord[] }

/** A run folder's run.json (checked against run.start's sha256) and its ledger, read once. */
async function loadFacts(p: Ports, runDir: string): Promise<{ ok: true; facts: Facts } | { ok: false; reason: string }> {
  const cut = runDir.lastIndexOf('/')
  const run = runDir.slice(cut + 1)
  const litterDir = runDir.slice(0, cut)
  if (cut <= 0 || !RUN_ID.test(run)) return { ok: false, reason: `${runDir} isn't a run's folder` }
  const ref: RunRef = { run, runDir, litterDir }
  const loaded = await loadLaunchable(p, ref)
  if (!loaded.ok) return loaded
  const ledger = await readLedger(p, runDir, run)
  if (ledger.tampered) return { ok: false, reason: `run ${run}'s ledger is tampered at ${ledger.tampered.seq}` }
  return { ok: true, facts: { ref, json: loaded.json, st: runState(ledger.records), records: ledger.records } }
}

const latestEnd = (st: RunState): RunEndBody | null => (st.latest ? st.latest.end : st.launchEnd)
const repairOf = (records: readonly StoredRecord[]): StoredRecord<RunRepairBody> | null =>
  (records.filter(r => r.kind === 'run.repair').at(-1) as StoredRecord<RunRepairBody> | undefined) ?? null
const budgetOf = (json: RunJson): RepairBudget => ({ rounds: json.repair!.rounds, agents: json.repair!.agents })

// ---------------------------------------------------------------------------
// Which ending it is (15.11: only three failures repair)

type VerifyRef = { rec: StoredRecord; v: VerifyBody }
type Failure =
  | { kind: 'verify'; verify: VerifyRef }
  | { kind: 'verdict'; verdict: StoredRecord; failed: string[]; verify: VerifyRef | null }
  | { kind: 'conflict'; conflict: IntegrateConflictBody }
type Ending = { ok: true; failure: Failure } | { ok: false; why: string; advice: string }

const THE_THREE = 'a repair swarm takes on only a red integration verify, a task the verifier rejected, or a merge that stopped at a conflict'

/** The fanout's ending from its records, as fanoutSummary reads them: one of the three failures, or why not. */
function classify(json: RunJson, records: readonly StoredRecord[]): Ending {
  const skips = records.filter(r => r.kind === 'integrate.skip').map(r => body<IntegrateSkipBody>(r))
  if (skips.length > 0) {
    const what = skips.length === 1 ? `task ${skips[0]!.task} wasn't merged (${oneLine(skips[0]!.reason)})` : `tasks ${words(skips.map(s => s.task))} weren't merged`
    return { ok: false, why: what, advice: 'rerun the tasks that weren\'t merged, or merge the passing branches yourself' }
  }
  const conflict = records.find(r => r.kind === 'integrate.conflict')
  if (conflict) return { ok: true, failure: { kind: 'conflict', conflict: body<IntegrateConflictBody>(conflict) } }
  const done = records.filter(r => r.kind === 'integrate.done').at(-1)
  if (!done) return { ok: false, why: 'the integration never finished', advice: 'run the fanout again' }
  const blocked = body<IntegrateDoneBody>(done).blocked ?? []
  if (blocked.length > 0) {
    return {
      ok: false,
      why: `the combined change failed the ownership check (${oneLine(blocked[0]!)}${blocked.length > 1 ? `, and ${blocked.length - 1} more` : ''})`,
      advice: "give the change to the task that owns its files, or widen the tasks' files, then run the fanout again",
    }
  }
  const verifies = records.flatMap(r => {
    const v = r.kind === 'verify' && r.body.gate === 'integration' ? verifyBody(r) : null
    return v ? [{ rec: r, v }] : []
  })
  const verdict = records.filter(r => r.kind === 'verdict' && Array.isArray(r.body.tasks)).at(-1) ?? null
  const cited = verdict ? verifies.find(x => x.v.verify_id === verdict.body.verify_id) : undefined
  const verify = cited ?? verifies.at(-1) ?? null
  if (!verify) return { ok: false, why: 'the integration verify never ran', advice: 'run the fanout again' }
  if (verify.v.green !== true) return { ok: true, failure: { kind: 'verify', verify } }
  if (verdict) {
    const judged = verdict.body.tasks as { id?: unknown; pass?: unknown }[]
    const failed = fanoutTasks(json)
      .filter(t => !judged.some(j => j !== null && typeof j === 'object' && j.id === t.id && j.pass === true))
      .map(t => t.id)
    if (failed.length > 0) return { ok: true, failure: { kind: 'verdict', verdict, failed, verify } }
  }
  const land = records.filter(r => (r.kind === 'land.blocked' || r.kind === 'land.abandoned') && r.body.gate === 'fanout').at(-1)
  if (land && typeof land.body.reason === 'string') {
    return { ok: false, why: `the result was verified and approved, but its land was refused (${oneLine(land.body.reason)})`, advice: 'fix what the land names, then land it again' }
  }
  return verdict
    ? { ok: false, why: 'the result was verified and approved, and nothing failed that a repair could fix', advice: 'read the summary for what stopped the land' }
    : { ok: false, why: 'the verifier gave no verdict', advice: 'run the fanout again' }
}

/** The failure, in words: what the summary, the ask and the orchestrator's task say. */
function failureText(f: Failure): string {
  if (f.kind === 'verify') return renderSlots(FAILURE_VERIFY, { verify_id: f.verify.v.verify_id, how: notGreen(f.verify.v) })
  if (f.kind === 'verdict') return renderSlots(FAILURE_VERDICT, { failed: `${f.failed.length === 1 ? 'task' : 'tasks'} ${words(f.failed)}` })
  return renderSlots(FAILURE_CONFLICT, { task: f.conflict.task, branch: f.conflict.branch })
}

// ---------------------------------------------------------------------------
// The spec (COMMON step 4), from run facts only

/** A generated repair spec with its briefs (node id → text), or why the run's facts can't make one. */
export type RepairSpecResult = { ok: true; spec: SwarmSpec; briefs: Record<string, string> } | { ok: false; reason: string }

/** `repair-<6 hex of sha256(runDir)>`, then `-2`… while a swarm folder or a live swarm has it (decision 13). */
async function freeName(p: Ports, litterDir: string, runDir: string): Promise<string | null> {
  const stem = `repair-${(await sha256(runDir)).slice(0, 6)}`
  for (let n = 1; n <= 99; n++) {
    const name = n === 1 ? stem : `${stem}-${n}`
    if (!SWARM_NAME.test(name) || liveSwarm(name)) continue
    if (!(await p.fs.exists(swarmDir(litterDir, name)))) return name
  }
  return null
}

/** Each task's latest bound branch (`task.bind`), for the tasks a conflict left unmerged. */
function boundBranches(records: readonly StoredRecord[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of records) {
    if (r.kind !== 'task.bind') continue
    const b = body<Partial<TaskBindBody>>(r)
    if (typeof b.task === 'string' && typeof b.worktree?.branch === 'string') out.set(b.task, b.worktree.branch)
  }
  return out
}

async function specOf(p: Ports, f: Facts, failure: Failure, name: string): Promise<RepairSpecResult> {
  const { ref, json, records } = f
  const run = ref.run
  const tasks = fanoutTasks(json)
  const writers = tasks.filter(t => t.writes)
  const paths = [...new Set(writers.flatMap(t => t.files))].sort()
  if (paths.length === 0) return { ok: false, reason: `no task of run ${run} owns a file, so a repair would have nothing it may change` }
  const wt = integrationWorktree(records, run)
  if (!wt) return { ok: false, reason: `run ${run} has no integration worktree on record` }
  if (!(await p.fs.exists(wt.path))) return { ok: false, reason: `run ${run}'s integration worktree ${wt.path} is gone` }
  const merges = records.filter(r => r.kind === 'integrate.merge').map(r => body<IntegrateMergeBody>(r))
  const done = records.filter(r => r.kind === 'integrate.done').at(-1)
  const tip = failure.kind === 'conflict' || !done ? (merges.at(-1)?.commit ?? json.base) : body<IntegrateDoneBody>(done).tip

  // What's merged: everything, or up to the conflict, with the rest by branch.
  let merged = MERGED_ALL
  if (failure.kind === 'conflict') {
    const ids = new Set(merges.map(m => m.task))
    const branchOf = boundBranches(records)
    const rest = writers.filter(t => !ids.has(t.id) && t.id !== failure.conflict.task).map(t => (branchOf.has(t.id) ? `${t.id} (${branchOf.get(t.id)})` : t.id))
    merged = renderSlots(MERGED_UNTIL_CONFLICT, { merged: words(merges.map(m => m.task)), task: `${failure.conflict.task} (${failure.conflict.branch})`, rest: words(rest) })
  }
  const verify = failure.kind === 'verify' ? failure.verify : failure.kind === 'verdict' ? failure.verify : null
  const task = renderSlots(REPAIR_TASK, {
    run,
    failure: failureText(failure),
    tasks: words(tasks.map(t => t.id), 50),
    merged,
    worktree: wt.path,
    integration: wt.branch,
    tip,
    branch: short(json.ref),
    base: json.base,
    rounds: json.repair?.rounds ?? null,
    agents: json.repair?.agents ?? null,
    summary: summaryPath(ref.runDir),
    run_json: runJsonPath(ref.runDir),
    verify_line: verify ? renderSlots(EVIDENCE_VERIFY, { dir: verifyLogDir(ref.runDir, verify.v.verify_id), verify_id: verify.v.verify_id, how: howEnded(verify.v) }) : null,
    verdict_line:
      failure.kind === 'verdict'
        ? renderSlots(EVIDENCE_VERDICT, { path: `${ledgerDir(ref.runDir)}/${ledgerFileName(failure.verdict.seq, 'verdict')}`, seq: failure.verdict.seq })
        : null,
    conflict_line: failure.kind === 'conflict' ? renderSlots(EVIDENCE_CONFLICT, { files: words(failure.conflict.files, 40) }) : null,
  })
  const shared = { push: 'none' as const, rewriteHistory: false, worktreeOps: false, verify: true }
  const nodes: SwarmNode[] = [
    {
      id: ORCHESTRATOR,
      kind: 'orchestrator',
      brief: `briefs/${ORCHESTRATOR}.md`,
      task,
      worktree: { existing: wt.path },
      // It writes nothing: commit stays unset, since false would rank under the fixer's commit (15.3's rule).
      tools: { deny: [...WRITE_TOOLS] },
      bash: { deny: ['git commit'] },
      spawns: { [FIXER]: 2, [CRITIC]: 1 },
      paths,
      authority: { ...shared, land: true },
      report: ['blocked', 'done'],
    },
    {
      id: FIXER,
      kind: 'worker',
      brief: `briefs/${FIXER}.md`,
      worktree: 'inherit',
      serial: true,
      paths,
      authority: { commit: true, ...shared },
    },
    {
      id: CRITIC,
      kind: 'worker',
      brief: `briefs/${CRITIC}.md`,
      worktree: 'inherit',
      verdicts: true,
      spawnOther: false,
      tools: { deny: [...WRITE_TOOLS] },
      authority: { commit: false, ...shared },
    },
  ]
  const spec: SwarmSpec = { name, goal: renderSlots(REPAIR_GOAL, { run, branch: short(json.ref) }), nodes, limits: { maxAgentsAtOnce: 4 } }
  const briefs = { [ORCHESTRATOR]: REPAIR_ORCHESTRATOR_BRIEF, [FIXER]: REPAIR_FIXER_BRIEF, [CRITIC]: REPAIR_CRITIC_BRIEF }
  return { ok: true, spec, briefs }
}

/** The spec under a name free now, for a fanout ending in one of the three failures. */
async function makeSpec(p: Ports, f: Facts): Promise<RepairSpecResult & { failure?: Failure }> {
  if (f.json.workflow !== 'fanout') return { ok: false, reason: `run ${f.ref.run} is a ${f.json.workflow} run, not a fanout` }
  const ending = classify(f.json, f.records)
  if (!ending.ok) return { ok: false, reason: `${ending.why}, and ${THE_THREE}` }
  const name = await freeName(p, f.ref.litterDir, f.ref.runDir)
  if (!name) return { ok: false, reason: 'every repair swarm name for this run is taken' }
  const made = await specOf(p, f, ending.failure, name)
  return made.ok ? { ...made, failure: ending.failure } : made
}

/**
 * The repair swarm's spec (COMMON step 4), from the run's facts only: the
 * tasks' owned paths, the kept integration worktree and branch, the failure
 * kind and the evidence paths, never task or verifier text. It must pass
 * validateSpec.
 */
export async function repairSpec(p: Ports, runDir: string): Promise<RepairSpecResult> {
  const loaded = await loadFacts(p, runDir)
  if (!loaded.ok) return loaded
  const made = await makeSpec(p, loaded.facts)
  return made.ok ? { ok: true, spec: made.spec, briefs: made.briefs } : { ok: false, reason: made.reason }
}

// ---------------------------------------------------------------------------
// The baseline (15.10, "The baseline must be green"; decision 3)

async function gitOut(p: Ports, cwd: string, argv: readonly string[]): Promise<{ code: number; out: string }> {
  try {
    const r = await p.run(['git', '-C', cwd, ...argv])
    return { code: r.code, out: r.stdout.trim() }
  } catch {
    return { code: -1, out: '' }
  }
}

type Baseline = { ok: true; verifyId: string } | { ok: false; reason: string }

/**
 * The checkout on the run's branch, at base, snapshotting to base's tree with
 * no dirty submodule; then the run's verify once there, as gate `baseline`,
 * recorded in the run's ledger. Red or failed to run, the repair is declined.
 */
async function baseline(p: Ports, f: Facts, timeoutMs: number): Promise<Baseline> {
  const { json, ref } = f
  const co = json.checkout
  const branch = short(json.ref)
  const head = await gitOut(p, co, ['symbolic-ref', '-q', 'HEAD'])
  if (head.code !== 0 || head.out !== json.ref) {
    return { ok: false, reason: `the checkout changed: ${co} is on ${head.code === 0 && head.out !== '' ? short(head.out) : 'a detached HEAD'}, not the run's branch ${branch}` }
  }
  const at = await gitOut(p, co, ['rev-parse', '-q', '--verify', '--end-of-options', `${json.ref}^{commit}`])
  if (at.out !== json.base) return { ok: false, reason: `the checkout changed: ${branch} is at ${at.out || 'nothing'}, not the run's base ${json.base}` }
  let snap: Awaited<ReturnType<typeof snapshot>>
  try {
    snap = await snapshot(p, co)
  } catch (err) {
    return { ok: false, reason: `the checkout couldn't be checked against the run's base: ${errText(err)}` }
  }
  if (snap.dirty_submodules.length > 0) return { ok: false, reason: `the checkout changed: submodules have uncommitted changes (${words(snap.dirty_submodules)})` }
  const baseTree = await gitOut(p, co, ['rev-parse', '-q', '--verify', '--end-of-options', `${json.base}^{tree}`])
  if (baseTree.code !== 0 || snap.tree !== baseTree.out) {
    return { ok: false, reason: `the checkout changed: ${co} no longer matches the run's base ${json.base} (uncommitted or untracked changes)` }
  }
  const ran = await deps.runVerify(p, { run: ref.run, runDir: ref.runDir, json }, { gate: 'baseline', attempt: 1, where: co, by: MOD, timeoutMs })
  if (!ran.ok) return { ok: false, reason: `the baseline verify couldn't run: ${noLitter(ran.error)}` }
  if (ran.body.green !== true) {
    return {
      ok: false,
      reason: `the baseline verify ${ran.body.verify_id} wasn't green on the run's base (${notGreen(ran.body)}), so the suite failed before the tasks ran, and finishing it is a scope question`,
    }
  }
  return { ok: true, verifyId: ran.body.verify_id }
}

/** The run lock, in words, when someone holds it. */
async function lockHeld(p: Ports, litterDir: string): Promise<string | null> {
  const lock = await readLock(p, repoOf(litterDir)).catch(() => null)
  if (!lock) return null
  return lock.blob ? `the run lock is held by run ${lock.blob.run} (session ${lock.blob.session})` : `the run lock is held (refs/litter-active names an unreadable blob, ${lock.oid})`
}

// ---------------------------------------------------------------------------
// Going live: the reopen, the save, the launch

type Started = { ok: true; name: string; launch: string; link: RunLink; plan: LaunchPlan } | { ok: false; reason: string; reopened: boolean }

/**
 * COMMON step 3's "Started": the launch id, W's reopen (the lock, run.repair,
 * policy.run), the spec saved `from: 'repair'`, then K's launch from
 * ownership on. A refused reopen leaves nothing (the empty launch folder
 * goes); a failure after it ends the generation halted with the reason.
 */
async function startRepair(
  p: Ports,
  f: Facts,
  made: { spec: SwarmSpec; briefs: Record<string, string>; failure: Failure },
  budget: RepairBudget,
  confirmedBy: { run: string } | { ask: true },
): Promise<Started> {
  const { ref } = f
  const name = made.spec.name
  const release = beginLaunch(name)
  if (!release) return { ok: false, reason: `a launch of swarm ${name} is already under way`, reopened: false }
  let reopened = false
  const halt = async (reason: string): Promise<Started> => {
    try {
      await deps.endRepairGeneration(p, ref.runDir, { status: 'halted', reason })
    } catch (err) {
      p.log(`run ${ref.run}: its repair generation didn't end: ${errText(err)}`)
    }
    return { ok: false, reason, reopened: true }
  }
  try {
    const fresh = !(await p.fs.exists(swarmDir(ref.litterDir, name)))
    const launch = await newLaunchId(p, ref.litterDir, name)
    const open = await deps.reopenForRepair(p, ref.runDir, { swarm: name, launch, budget })
    if (!open.ok) {
      await remove(p, fresh ? swarmDir(ref.litterDir, name) : launchDir(ref.litterDir, name, launch)).catch(() => {})
      return { ok: false, reason: noLitter(open.reason), reopened: false }
    }
    reopened = true
    const saved = await deps.saveRevision(p, ref.litterDir, name, { spec: made.spec, briefs: made.briefs }, {
      from: 'repair',
      changes: [`generated for run ${ref.run}: ${failureText(made.failure)}`],
    })
    if (!saved.ok) return await halt(`the repair swarm's spec didn't save: ${saved.errors.map(e => `${e.field}: ${e.error}`).join('; ')}`)
    const planned = await planLaunch(p, name, { revision: saved.revision, grants: true })
    if (!planned.ok) return await halt(noLitter(planned.reason))
    const live = await goLive(p, planned.plan, { launch, run: open.link, budget, confirmedBy })
    if (!live.ok) return await halt(noLitter(live.reason))
    return { ok: true, name, launch, link: open.link, plan: planned.plan }
  } catch (err) {
    return reopened ? await halt(errText(err)) : { ok: false, reason: errText(err), reopened: false }
  } finally {
    release()
  }
}

async function rewriteSummary(p: Ports, ref: RunRef): Promise<void> {
  await deps.writeSummary(p, ref).catch((err: unknown) => p.log(`summary for ${ref.run} failed: ${errText(err)}`))
}

// ---------------------------------------------------------------------------
// The bridge, under `repair: auto`

/**
 * After a halted fanout's endRun returned, outside the run's serial key
 * (`run:<runDir>`): starts the repair swarm when COMMON step 3's conditions
 * all hold, else records `repair.declined { reason }` and rewrites summary.md.
 * A no-op for any other run, or one a repair was already started or declined
 * for. lifecycle.ts awaits it (so the notification turn's `<swarm>` block sees
 * the swarm it started) and logs a rejection: the run's end stands either way.
 */
export async function continueAsRepair(p: Ports, runDir: string): Promise<void> {
  await serial(`repair:${runDir}`, () => bridge(p, runDir))
}

async function bridge(p: Ports, runDir: string): Promise<void> {
  const loaded = await loadFacts(p, runDir)
  if (!loaded.ok) throw new Error(loaded.reason)
  const f = loaded.facts
  const { ref, json, records, st } = f
  // A run.json from before 2b-2 states no repair, so none starts for it.
  if (json.workflow !== 'fanout' || !json.repair) return
  const end = latestEnd(st)
  if (!end || end.status !== 'halted' || st.open) return
  if (records.some(r => r.kind === 'run.repair' || r.kind === 'repair.declined')) return

  const decline = async (reason: string): Promise<void> => {
    await appendRecord<RepairDeclinedBody>(p, runDir, { run: ref.run, kind: 'repair.declined', by: MOD, body: { reason } })
    await rewriteSummary(p, ref)
  }
  // COMMON step 3's order.
  if (json.repair.mode !== 'auto') return decline('repair is off for this run')
  if (end.source === 'reconcile') return decline('the run\'s end was found at session start, after the fact, and a repair never starts on its own from there')
  const ending = classify(json, records)
  if (!ending.ok) return decline(`${ending.why}, and ${THE_THREE}`)
  if (interactive() !== true) return decline("no one to watch it: this session isn't interactive")
  const made = await makeSpec(p, f)
  if (!made.ok || !made.failure) return decline(made.ok ? 'the repair spec has no failure' : made.reason)
  const planned = await planLaunch(p, made.spec.name, { saved: { spec: made.spec, revision: 0, briefs: made.briefs }, grants: true })
  if (!planned.ok) return decline(noLitter(planned.reason))
  const held = await lockHeld(p, ref.litterDir)
  if (held) return decline(held)
  const base = await baseline(p, f, getOptions().verifyTimeoutMs)
  if (!base.ok) return decline(base.reason)

  const started = await startRepair(p, f, { spec: made.spec, briefs: made.briefs, failure: made.failure }, budgetOf(json), { run: ref.run })
  if (!started.ok) {
    if (!started.reopened) return decline(started.reason)
    p.log(`run ${ref.run}: the repair swarm didn't start: ${started.reason}`)
    return
  }
  // The start waits for the notification turn's end (decision 2): the note now, the submit at turn.complete.
  await addPending(p, { swarm: started.name, launch: started.launch, run: ref.run, runDir, litterDir: ref.litterDir, at: await p.now() })
  await rewriteSummary(p, ref)
}

// ---------------------------------------------------------------------------
// repair.start, under `repair: off` (or after a decline)

/** `repair.start { run }` (the launcher's, under `repair: off`): the mod's own ask, going live, then the prompt fill. */
export const recordRepairStart: RecordHandler = async (ctx, input) => {
  if (ctx.litterDir === null) return fail("litter: this session has no litter directory (see /litter-doctor)")
  const run = input.run
  if (typeof run !== 'string' || !RUN_ID.test(run)) return fail("litter: 'run' must be a run id like 20261002-my-run", 'run')
  const runDir = runDirOf(ctx.litterDir, run)
  return serial(`repair:${runDir}`, () => startByAsk(ctx, runDir))
}

async function startByAsk(ctx: RecordCtx, runDir: string): Promise<RecordReply> {
  const { p } = ctx
  const loaded = await loadFacts(p, runDir)
  if (!loaded.ok) return fail(`litter: ${loaded.reason}`, 'run')
  const f = loaded.facts
  const { ref, json, records, st } = f
  const run = ref.run
  if (json.workflow !== 'fanout') return fail(`litter: run ${run} is a ${json.workflow} run; only a fanout's combined result is repaired`, 'run')
  if (!json.repair) {
    return fail(`litter: run ${run} started before litter repaired fanouts, so its launch confirmation stated no repair, and none starts for it`, 'run')
  }
  const already = repairOf(records)
  if (already) return fail(`litter: run ${run} has a repair already: swarm ${already.body.swarm}, launch ${already.body.launch}`, 'run')
  const end = latestEnd(st)
  if (st.open || !end) return fail(`litter: run ${run} hasn't ended; a repair starts only once it halted`, 'run')
  if (end.status !== 'halted') return fail(`litter: run ${run} ended ${end.status}, not halted, so there's nothing to repair`, 'run')
  const ending = classify(json, records)
  if (!ending.ok) return fail(`litter: run ${run} can't be repaired as a swarm: ${ending.why}, and ${THE_THREE}; ${ending.advice}`, 'run')
  const held = await lockHeld(p, ref.litterDir)
  if (held) return fail(`litter: ${held}; start the repair once it's free`)
  const made = await makeSpec(p, f)
  if (!made.ok || !made.failure) return fail(`litter: no repair swarm for run ${run}: ${made.ok ? 'it has no failure' : made.reason}`)
  const planned = await planLaunch(p, made.spec.name, { saved: { spec: made.spec, revision: 0, briefs: made.briefs }, grants: true })
  if (!planned.ok) return fail(planned.reason)
  const base = await baseline(p, f, ctx.options.verifyTimeoutMs)
  if (!base.ok) return fail(`litter: no repair of run ${run}: ${base.reason}`)

  // The builder's confirmation (COMMON step 3, "Under off"): the authority and the budget, in the mod's own ask.
  const budget = budgetOf(json)
  const wt = integrationWorktree(records, run)!
  const question = launchQuestion(planned.plan, [
    `Start repair swarm ${made.spec.name} for fanout run ${run}?`,
    `Failure: ${failureText(made.failure)}`,
    `It takes over the integration worktree ${wt.path} and commits fixes on ${wt.branch}. The mod lands the result on ${short(json.ref)} only once it's verified and an independent check approves it. Nothing is pushed.`,
    `Budget: up to ${budget.rounds} rounds and ${budget.agents} agents; only your answer to litter's own ask raises it.`,
    `Baseline: verify ${base.verifyId} is green on the run's base ${json.base.slice(0, 12)}.`,
  ])
  let answer: string
  try {
    answer = await p.ask(question, { options: ['Launch', 'Cancel'], header: 'Repair' })
  } catch (err) {
    return fail(`litter: the repair of run ${run} needs your confirmation, and the ask couldn't be shown (${oneLine(errText(err), 160)}); nothing was started`)
  }
  if (answer !== 'Launch') return fail(`litter: the repair of run ${run} wasn't confirmed; nothing was started`)

  const started = await startRepair(p, f, { spec: made.spec, briefs: made.briefs, failure: made.failure }, budget, { ask: true })
  if (!started.ok) {
    if (started.reopened) await rewriteSummary(p, ref)
    return fail(`litter: the repair swarm for run ${run} didn't start: ${started.reason}`)
  }
  // Your Enter on the start line starts it, as the builder's Launch does.
  const filled = await fillStart(p, started.plan)
  await rewriteSummary(p, ref)
  return {
    ok: true,
    run,
    swarm: started.name,
    launch: started.launch,
    generation: started.link.generation,
    budget,
    next: filled
      ? `Repair swarm ${started.name} is live. Its start line is in the user's prompt box: say so in a line and end your turn; their Enter starts it. Don't start it yourself.`
      : `Repair swarm ${started.name} is live, but the prompt box didn't take its start line: tell the user to send /litter:swarm start ${started.name}.`,
  }
}

// ---------------------------------------------------------------------------
// repair.budget (COMMON step 6; decision 8)

/** `repair.budget { swarm, rounds?, agents? }` (the launcher's): the mod's own ask, then the raised budget and a `budget` event. */
export const recordRepairBudget: RecordHandler = async (ctx, input) => {
  if (ctx.litterDir === null) return fail("litter: this session has no litter directory (see /litter-doctor)")
  const name = input.swarm
  if (typeof name !== 'string' || !SWARM_NAME.test(name)) return fail("litter: 'swarm' must be the repair swarm's name", 'swarm')
  const more: { rounds?: number; agents?: number } = {}
  for (const [field, range] of [['rounds', REPAIR_ROUNDS], ['agents', REPAIR_AGENTS]] as const) {
    const v = input[field]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > range.max) {
      return fail(`litter: '${field}' is how many more ${field} to ask for: a whole number from 1 to ${range.max}`, field)
    }
    more[field] = v
  }
  if (more.rounds === undefined && more.agents === undefined) return fail("litter: name how many more rounds, agents or both to ask for", 'rounds')
  return serial(`repair-budget:${name}`, () => raiseBudget(ctx, ctx.litterDir!, name, more))
}

/** Why the swarm isn't one whose budget this session may raise; null when it is. */
function notOwnedRepair(name: string): string | null {
  const s = liveSwarm(name)
  if (!s) return `swarm ${name} isn't live`
  if (s.readOnly) return `swarm ${name} is owned by session ${s.owner.session}; raise its budget there`
  if (s.lost) return `swarm ${name} was handed to another session; this session no longer acts on it`
  if (!s.run || !s.budget) return `swarm ${name} isn't a repair swarm, so it has no budget to raise`
  if (s.state === 'stopping') return `swarm ${name} is stopping`
  return null
}

async function raiseBudget(ctx: RecordCtx, litterDir: string, name: string, more: { rounds?: number; agents?: number }): Promise<RecordReply> {
  const { p } = ctx
  const refusal = notOwnedRepair(name)
  if (refusal) return fail(`litter: ${refusal}`, 'swarm')
  const s = liveSwarm(name)!
  const was = s.budget!
  const asked = [
    more.rounds !== undefined ? `${more.rounds} more ${more.rounds === 1 ? 'round' : 'rounds'}` : null,
    more.agents !== undefined ? `${more.agents} more ${more.agents === 1 ? 'agent' : 'agents'}` : null,
  ].filter((x): x is string => x !== null)
  const question = [
    `Give repair swarm ${name} ${asked.join(' and ')}?`,
    `It repairs fanout run ${s.run!.run}. It has used ${roundsUsed(name)} of ${was.rounds} rounds and ${spawnsUsed(name)} of ${was.agents} agents.`,
    `With this, its budget is ${was.rounds + (more.rounds ?? 0)} rounds and ${was.agents + (more.agents ?? 0)} agents. Each round is a verdict on a new verify; the agents are the workers and other agents its nodes spawn.`,
  ].join('\n')
  let answer: string | null
  try {
    answer = await p.ask(question, { options: ['Grant', 'Cancel'], header: 'Budget' })
  } catch (err) {
    p.log(`swarm ${name}: the budget ask couldn't be shown: ${errText(err)}`)
    answer = null
  }
  const granted = answer === 'Grant'
  // The swarm, again: it may have ended or moved while you answered. The ref is read again before the write (Q2).
  const again = notOwnedRepair(name)
  if (again) return fail(`litter: ${again}; nothing was raised`, 'swarm')
  const own = await confirmOwnership(p, litterDir, name)
  if (own === 'lost') return fail(`litter: swarm ${name} was handed to another session; nothing was raised`, 'swarm')
  if (own === null) return fail(`litter: git couldn't confirm this session still owns swarm ${name}; nothing was raised, so ask again in a moment`, 'swarm')
  const now = liveSwarm(name)!
  const budget: RepairBudget = granted ? { rounds: now.budget!.rounds + (more.rounds ?? 0), agents: now.budget!.agents + (more.agents ?? 0) } : now.budget!
  const event: SwarmEventBody = { kind: 'budget', requested: more, granted, budget }
  await appendLaunchRecord(p, litterDir, name, now.launch, 'swarm.event', event)
  if (granted) patchLiveSwarm(name, { budget })
  return granted
    ? {
        ok: true,
        swarm: name,
        granted: true,
        budget,
        next: `Tell the repair swarm's orchestrator with mcp__litter__swarm_send (node ${ORCHESTRATOR}) that its budget is now ${budget.rounds} rounds and ${budget.agents} agents.`,
      }
    : {
        ok: true,
        swarm: name,
        granted: false,
        budget,
        next: answer === null
          ? "The ask couldn't be shown, so the budget is unchanged. Tell the orchestrator it stays as it is."
          : 'The user didn\'t grant it, so the budget is unchanged. Tell the orchestrator, and ask the user how they want to go on.',
      }
}

// ---------------------------------------------------------------------------
// The start on the lead's next turn (decision 2; spike 19)

/** A repair swarm the bridge started, waiting for the lead's start. In `$.store`, so a reload keeps it. */
type PendingStart = { swarm: string; launch: string; run: string; runDir: string; litterDir: string; at: number; submitted?: boolean }

const pendingKey = (litterDir: string) => `litter.repair.start.${litterDir}`
const keyOf = (e: Pick<PendingStart, 'swarm' | 'launch'>) => `${e.swarm}/${e.launch}`

/** This process's copy, per litter directory loaded; the store is the truth across a reload. */
let pending: PendingStart[] = []
const loaded = new Set<string>()
/** Starts handed to a timer and not settled yet. */
const scheduled = new Set<string>()

const isPending = (v: unknown): v is PendingStart => {
  const e = v as Partial<PendingStart> | null
  return !!e && typeof e === 'object' && typeof e.swarm === 'string' && typeof e.launch === 'string' && typeof e.run === 'string' && typeof e.runDir === 'string' && typeof e.litterDir === 'string'
}

async function loadPending(p: Ports, litterDir: string): Promise<void> {
  const list = await p.store.get(pendingKey(litterDir))
  const read = Array.isArray(list) ? list.filter(isPending).filter(e => e.litterDir === litterDir) : []
  pending = [...pending.filter(e => e.litterDir !== litterDir), ...read]
  loaded.add(litterDir)
}

async function savePending(p: Ports, litterDir: string): Promise<void> {
  const mine = pending.filter(e => e.litterDir === litterDir)
  if (mine.length === 0) await p.store.delete(pendingKey(litterDir))
  else await p.store.set(pendingKey(litterDir), mine)
}

async function addPending(p: Ports, e: PendingStart): Promise<void> {
  if (!loaded.has(e.litterDir)) await loadPending(p, e.litterDir)
  pending = [...pending.filter(x => keyOf(x) !== keyOf(e)), e]
  await savePending(p, e.litterDir)
}

/** Owned and live in this process, not stopping: the only swarm this session starts. */
function ownedHere(e: PendingStart): boolean {
  const s = liveSwarm(e.swarm)
  return s !== null && s.launch === e.launch && !s.readOnly && !s.lost && s.state === 'live'
}

/** An orchestrator of it was spawned or is being admitted. */
const startedHere = (e: PendingStart): boolean =>
  bindings(e.swarm).some(b => b.launch === e.launch && b.kind === 'orchestrator') || reservations(e.swarm).some(r => r.kind === 'orchestrator')

/** Waiting for its start in this process: not submitted, not handed to a timer, owned here, nothing spawned. */
const waiting = (e: PendingStart): boolean => !e.submitted && !scheduled.has(keyOf(e)) && ownedHere(e) && !startedHere(e)

/** Drops each start whose launch ended, never started, or has an orchestrator: it's done with. */
async function prunePending(p: Ports, litterDir: string): Promise<void> {
  const keep: PendingStart[] = []
  let dropped = false
  for (const e of pending.filter(x => x.litterDir === litterDir)) {
    const facts = await readLaunchFacts(p, litterDir, e.swarm, e.launch).catch(() => null)
    const spawned = facts !== null && [...facts.nodes.values()].some(r => r.body.kind === 'orchestrator')
    if (facts && (!facts.start || facts.ended || spawned || startedHere(e))) dropped = true
    else keep.push(e)
  }
  if (!dropped) return
  pending = [...pending.filter(x => x.litterDir !== litterDir), ...keep]
  await savePending(p, litterDir)
}

/**
 * At session.start, once recovery put the swarms back (recover.ts): the
 * pending starts from `$.store`, pruned. Nothing is submitted from here: the
 * next prompt carries the note, and its turn.complete schedules the start.
 */
export async function restoreRepairStarts(p: Ports, litterDir: string): Promise<void> {
  await loadPending(p, litterDir)
  await prunePending(p, litterDir)
}

/**
 * The notification turn's context line, after the `<swarm>` block: "repair
 * swarm S is live for run R; litter starts it after this turn", while a swarm
 * the bridge just started waits for its start; else null. Synchronous: it
 * reads module memory only. register.tsx calls it after the run's notice
 * settled and the block was built, and drops a throw (logged).
 */
export function repairNote(_p: Ports): string | null {
  const litterDir = session().litterDir
  if (!litterDir) return null
  const lines = pending.filter(e => e.litterDir === litterDir && waiting(e)).map(e => renderSlots(REPAIR_NOTE, { swarm: e.swarm, run: e.run }))
  return lines.length > 0 ? lines.join('\n') : null
}

/**
 * Every turn.complete, the lead's and each subagent's (it acts on the lead's):
 * once the notification turn that started a repair swarm ends, it schedules
 * `p.after(0, …)` to submit the start for that swarm (never awaited in the
 * hook; the text doesn't start with `/`). register.tsx calls it inside the
 * hook's own catch: a rejection is logged and the turn passes on.
 */
export async function repairTurnComplete(p: Ports, e: Parameters<TurnCompleteHook>[1]): Promise<void> {
  if (e.agentId !== undefined || e.isAborted) return
  const litterDir = session().litterDir
  if (!litterDir) return
  if (!loaded.has(litterDir)) await loadPending(p, litterDir)
  if (!pending.some(x => x.litterDir === litterDir)) return
  await prunePending(p, litterDir)
  if (interactive() !== true) return
  for (const entry of pending.filter(x => x.litterDir === litterDir && waiting(x))) {
    scheduled.add(keyOf(entry))
    p.after(0, () => void submitStart(p, entry))
  }
}

/** From the timer: the start text, once, if the swarm still waits for it. A refusal is logged, and the next turn tries again. */
async function submitStart(p: Ports, entry: PendingStart): Promise<void> {
  const key = keyOf(entry)
  try {
    const now = pending.find(x => keyOf(x) === key)
    if (!now || now.submitted || !ownedHere(now) || startedHere(now)) return
    await p.submitPrompt(renderSlots(REPAIR_START, { swarm: entry.swarm, run: entry.run }))
    now.submitted = true
    await savePending(p, entry.litterDir)
  } catch (err) {
    p.log(`repair swarm ${entry.swarm}: its start wasn't submitted: ${errText(err)}`)
    p.toast(`litter: repair swarm ${entry.swarm} is live; send /litter:swarm start ${entry.swarm} to start it`)
  } finally {
    scheduled.delete(key)
  }
}

/** A fresh module's pending starts, for tests. */
export function resetRepairForTests(): void {
  pending = []
  loaded.clear()
  scheduled.clear()
}

// ---------------------------------------------------------------------------
// summary.md's Repair section

/**
 * The "Repair" section of the run's summary.md, as markdown with its own
 * heading: what started (the swarm, its budget, how to watch it), or why not
 * and the recommendation, or the recommendation under `repair: off`. Empty
 * for a run with nothing to say (not a fanout, or done). W's writeSummary
 * appends it, and keeps the rest of the summary when it rejects.
 */
export async function repairSummary(p: Ports, runDir: string): Promise<string> {
  const read = await loadFacts(p, runDir)
  if (!read.ok) return ''
  const { ref, json, records, st } = read.facts
  if (json.workflow !== 'fanout' || !json.repair) return ''
  const lines = ['## Repair', '']
  const branch = short(json.ref)

  const open = repairOf(records)
  if (open) {
    const b = open.body
    lines.push(
      `Repair swarm ${b.swarm} (launch ${b.launch}) took over in generation ${b.generation}, with a budget of ${b.budget.rounds} rounds and ${b.budget.agents} agents. It works in the run's integration worktree, and the mod lands its result on ${branch} only once it's verified and an independent check approves it; nothing is pushed.`,
    )
    const end = records.filter(r => r.kind === 'run.end' && r.seq > open.seq && r.body.generation === b.generation).at(-1)
    const status = end ? body<RunEndBody>(end) : null
    if (!status) lines.push('', `Watch it with /litter-swarm ${b.swarm}; it shows the budget used and each verify, verdict and land.`)
    else if (status.status === 'done') {
      const land = records.filter(r => r.kind === 'land' && r.seq > open.seq).at(-1)
      lines.push('', `It landed${land && typeof land.body.commit === 'string' ? ` ${land.body.commit} on ${branch}` : ''}: generation ${b.generation} ended done.`)
    } else lines.push('', `It ended without a land (${status.status}${status.reason ? `: ${oneLine(status.reason, 500)}` : ''}).`)
    lines.push('')
    return lines.join('\n')
  }

  const end = latestEnd(st)
  if (!end || end.status !== 'halted') return ''
  const declined = records.filter(r => r.kind === 'repair.declined').at(-1)
  const ending = classify(json, records)
  const why = declined ? oneLine(String(body<RepairDeclinedBody>(declined).reason ?? ''), 1000) : json.repair.mode === 'off' ? 'repair is off for this run' : null
  lines.push(why ? `No repair swarm started: ${why}.` : 'No repair swarm has started for this run.')
  const redBase = records.filter(r => r.kind === 'verify' && r.body.gate === 'baseline').at(-1)?.body.green === false
  if (!ending.ok) lines.push('', `A repair swarm can't take this on: ${ending.why}. Instead, ${ending.advice}.`)
  else if (redBase) {
    lines.push('', "The suite was red on the run's base before the tasks ran, which a repair of the tasks' result can't take on. Fix it on the base branch, then run the fanout again.")
  } else {
    const b = budgetOf(json)
    const wt = integrationWorktree(records, ref.run)
    lines.push(
      '',
      `Recommended: repair it as a swarm. The failure: ${failureText(ending.failure)}. A repair swarm takes over the integration worktree${wt ? ` ${wt.path}` : ''}, commits fixes on ${wt ? wt.branch : 'the integration branch'}, and the mod lands the result on ${branch} only if it's verified and an independent check approves it: up to ${b.rounds} rounds and ${b.agents} agents; nothing is pushed.`,
      '',
      `To start one, ask for /litter:swarm repair ${ref.run}; litter asks you to confirm its authority and budget first. The other ways on: rerun the failed tasks, merge the passing branches yourself, or stop here. Everything the run made is kept.`,
    )
  }
  lines.push('')
  return lines.join('\n')
}
