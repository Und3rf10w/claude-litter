// The failed-fanout bridge (plan 15.10, 15.11; COMMON 2b-2, steps 3, 4 and
// 6): whether a halted fanout continues as a repair swarm, its baseline, the
// spec generated from run facts, the launch with no ask under `repair: auto`
// (and with one on `repair.start` under `off`), the start on the lead's next
// turn (your Enter on its start line when that turn didn't make it, WP-AS),
// and more budget. Phase 3 (AC; COMMON steps 4 and 5) adds the execute
// bridge beside it: a halted execute run whose first unlanded gate halted on
// a plan gap or ran out of attempts continues as a plan-template swarm, in
// the run's own checkout, through the same reopen, launch and start.
//
// Owner: phase 2b-2, package X; the execute parts phase 3, package AC.
// Package V's stubs: every export below is the contract. W's lifecycle.ts
// calls continueAsRepair after a halted fanout's or execute run's endRun, and
// writeSummary takes repairSummary's section; register.tsx calls repairNote
// at prompt.submit and repairTurnComplete at turn.complete; the registry
// routes repair.start and repair.budget here; recover.ts calls
// restoreRepairStarts once the swarms are back.
//
// The order (COMMON step 3): every check that can decline runs before
// anything of the repair is written, the baseline last, since it runs the
// suite (a fanout's; an execute run's finds a green verify in its chain, and
// runs nothing). A decline records `repair.declined { reason }` and nothing
// else (the baseline's own verify record stays, as history). From the reopen
// on, a failure ends the repair generation halted, with the reason.

import type { Ports } from './ports'
import type { RecordCtx, RecordHandler, RecordReply, StoredRecord } from './records/core'
import type { TurnCompleteHook } from './hooktypes'
import type { RepairDeclinedBody, RunEndBody, RunJson, RunRepairBody } from './records/run'
import type { IntegrateConflictBody, IntegrateDoneBody, IntegrateMergeBody, IntegrateSkipBody, TaskBindBody } from './records/fanout'
import type { VerifyBody } from './records/execute'
import type { SwarmEventBody } from './records/swarm'
import type { RepairBudget, RunLink, SwarmNode, SwarmSpec } from './swarm/types'
import type { LaunchPlan } from './swarm/launch'
import type { LaunchFacts } from './swarm/recover'
import type { RunRef, RunState } from './lifecycle'
import { fail } from './records/core'
import { appendRecord, readLedger } from './ledgercore'
import {
  RUN_ID,
  SWARM_NAME,
  launchDir,
  ledgerDir,
  ledgerFileName,
  planPath as runPlanPath,
  runDir as runDirOf,
  runJsonPath,
  summaryPath,
  swarmDir,
  verdictsDir,
  verifyLogDir,
} from './layout'
import { remove, serial, sha256 } from './fsx'
import { getOptions, session } from './session'
import { readLock } from './lock'
import { snapshot } from './snapshot'
import { REPAIR_AGENTS, REPAIR_ROUNDS } from './options'
import { MOD, howEnded, isGreen, notGreen, planGates, runVerify, verifyBody } from './verify'
import { fanoutTasks, integrationWorktree } from './integrate'
import { endRepairGeneration, greenBaseline, loadLaunchable, reopenForRepair, repoOf, resolveChain, runState, writeSummary } from './lifecycle'
import { appendLaunchRecord, newLaunchId } from './records/swarm'
import { saveRevision } from './swarm/store'
import { beginLaunch, fillStart, goLive, launchQuestion, planLaunch } from './swarm/launch'
import { bindings, interactive, liveSwarm, patchLiveSwarm, reservations, roundsUsed, spawnsUsed } from './swarm/state'
import { confirmOwnership } from './swarm/owner'
import { authorityLines, readLaunchFacts } from './swarm/recover'
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
import {
  CONFIRM_AUTO,
  PLAN_ADVERSARY_BRIEF,
  PLAN_CRITIC_BRIEF,
  PLAN_EVIDENCE_VERIFY,
  PLAN_EXECUTOR_BRIEF,
  PLAN_GAP_BY_CRITIC,
  PLAN_GAP_BY_EXECUTOR,
  PLAN_GOAL,
  PLAN_GOAL_LINE,
  PLAN_RUNNER_BRIEF,
  PLAN_TASK,
  PLAN_WHY_ATTEMPTS,
  PLAN_WHY_EXECUTOR_GAP,
  PLAN_WHY_GAP,
  PLAN_WIDEN_ASK,
  PLAN_WIDEN_CRITIC,
} from './prompts/swarm-plan'
import { widenOf } from './widen'

// ---------------------------------------------------------------------------
// The other packages' functions, through one table so tier 2 can stand in for
// them (COMMON, "Another package's module"). The mod never changes it.

export const deps = {
  reopenForRepair: (...a: Parameters<typeof reopenForRepair>) => reopenForRepair(...a),
  endRepairGeneration: (...a: Parameters<typeof endRepairGeneration>) => endRepairGeneration(...a),
  writeSummary: (...a: Parameters<typeof writeSummary>) => writeSummary(...a),
  saveRevision: (...a: Parameters<typeof saveRevision>) => saveRevision(...a),
  runVerify: (...a: Parameters<typeof runVerify>) => runVerify(...a),
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
/** The repair swarm's node ids (COMMON 2b-2, step 4). */
const ORCHESTRATOR = 'repair'
const FIXER = 'fixer'
const CRITIC = 'critic'
/** The plan template's (phase 3, COMMON step 5): its critic is `critic` too. */
const RUNNER = 'runner'
const EXECUTOR = 'executor'
const ADVERSARY = 'adversary'

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
/**
 * An execute run's two (phase 3, decision 6): the first unlanded gate's plan
 * gap, named by its critic's latest verdict or by its executor's stop before
 * the attempt was judged (WP-AH), or its attempts out.
 */
type PlanFailure =
  | { kind: 'plan_gap'; by: 'critic' | 'executor'; gate: string; gap: string; attempt: number | null; verify: VerifyRef | null }
  | { kind: 'attempts'; gate: string; count: number; max: number; verify: VerifyRef | null }
type Failure =
  | { kind: 'verify'; verify: VerifyRef }
  | { kind: 'verdict'; verdict: StoredRecord; failed: string[]; verify: VerifyRef | null }
  | { kind: 'conflict'; conflict: IntegrateConflictBody }
  | PlanFailure
/** `alone`: the why is the whole reason, with no "only these failures" after it (an amend's, decision 13). */
type Ending = { ok: true; failure: Failure } | { ok: false; why: string; advice: string; alone?: boolean }

const THE_THREE = 'a repair swarm takes on only a red integration verify, a task the verifier rejected, or a merge that stopped at a conflict'
const THE_TWO = 'a plan-template swarm takes on only a gate that halted on a plan gap or ran out of attempts'
/** Decision 13's words: an amend run never continues as a swarm. */
const AMEND_HALT = "an amend's halt comes back to you; /litter:design is the recommended next step"

/** The decline's reason for an ending that isn't one the bridge takes on. */
const notTaken = (json: RunJson, e: { why: string; alone?: boolean }): string => (e.alone ? e.why : `${e.why}, and ${json.workflow === 'execute' ? THE_TWO : THE_THREE}`)

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
  if (f.kind === 'conflict') return renderSlots(FAILURE_CONFLICT, { task: f.conflict.task, branch: f.conflict.branch })
  return `gate ${f.gate} halted: ${whyOf(f)}`
}

/** A plan failure's {why} (PLAN_TASK). */
function whyOf(f: PlanFailure): string {
  if (f.kind === 'plan_gap' && f.by === 'executor') {
    return f.attempt === null ? 'the executor stopped with a plan gap, before its attempt was judged' : renderSlots(PLAN_WHY_EXECUTOR_GAP, { attempt: f.attempt })
  }
  if (f.kind === 'plan_gap') return f.attempt === null ? "the critic's last verdict names a plan gap" : renderSlots(PLAN_WHY_GAP, { attempt: f.attempt })
  return renderSlots(PLAN_WHY_ATTEMPTS, { count: f.count, max: f.max })
}

// ---------------------------------------------------------------------------
// An execute run's ending (phase 3, COMMON step 4; decision 6), from its ledger

/** The run's maxAttempts as execute.js reads it (`args.maxAttempts ?? 3`). */
const maxAttemptsOf = (json: RunJson): number => {
  const m = json.args.maxAttempts
  return typeof m === 'number' && Number.isSafeInteger(m) && m > 0 ? m : 3
}

/** The run's own lands, gate → commit, in ledger order. */
function landsOf(records: readonly StoredRecord[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of records) {
    if (r.kind === 'land' && typeof r.body.gate === 'string' && typeof r.body.commit === 'string' && !out.has(r.body.gate)) out.set(r.body.gate, r.body.commit)
  }
  return out
}

/** Where the run's ledger left its branch: the last land's commit, or base. */
function tipOfLedger(json: RunJson, records: readonly StoredRecord[]): string {
  const last = records.filter(r => r.kind === 'land' && typeof r.body.commit === 'string').at(-1)
  return last ? String(last.body.commit) : json.base
}

/** Each verify of the run by its id. */
function verifiesById(records: readonly StoredRecord[]): Map<string, VerifyRef> {
  const out = new Map<string, VerifyRef>()
  for (const r of records) {
    const v = verifyBody(r)
    if (v) out.set(v.verify_id, { rec: r, v })
  }
  return out
}

/** A verdict's gate: the one it names (a plan-template swarm's), else its cited verify's (an execute critic's). */
function gateOfVerdict(r: StoredRecord, verifies: Map<string, VerifyRef>): string | null {
  if (typeof r.body.gate === 'string') return r.body.gate
  return typeof r.body.verify_id === 'string' ? (verifies.get(r.body.verify_id)?.v.gate ?? null) : null
}

/** An execute executor's `task.result` (output.ts, GateResultBody): the gate and attempt the mod placed it at. */
const isGateResult = (r: StoredRecord): boolean => r.kind === 'task.result' && r.body.role === 'executor' && typeof r.body.gate === 'string'

/** The plan gap an executor's blocked result names (WP-AH), or null for any other result. */
function executorGap(r: StoredRecord): string | null {
  const res = r.body.result as Record<string, unknown> | null | undefined
  if (!res || typeof res !== 'object' || res.status !== 'blocked') return null
  return typeof res.plan_gap === 'string' && res.plan_gap.trim() !== '' ? res.plan_gap : null
}

/**
 * The execute run's ending from its ledger (decision 6), never the script's
 * reason: the first gate of `args.gates` with no land, then its latest
 * event. An executor's result after the gate's last verdict bridges only
 * when it's a block naming a plan gap (WP-AH), and every other stop there
 * declines. Otherwise a rule clash in the latest verdict declines, as the
 * user's to settle; then that verdict's plan gap, or `maxAttempts`
 * verdicts on it with none landed (a re-critique's verdict counts), in the
 * workflow's generations. A land the mod refused after its latest verdict
 * (land.abandoned or land.blocked: a retry: false refusal it recorded)
 * declines, as does every other halt; a moved branch or ref declines at the
 * baseline.
 */
function classifyExecute(json: RunJson, records: readonly StoredRecord[]): Ending {
  if (json.amendOf) return { ok: false, why: AMEND_HALT, advice: 'run /litter:design for the gate, then a new plan', alone: true }
  const gates = planGates(json)
  if (!gates || gates.length === 0) return { ok: false, why: "its run.json names no plan gates", advice: 'run it again from its plan' }
  const landed = landsOf(records)
  const verifies = verifiesById(records)
  const first = gates.find(g => !landed.has(g.id))
  const end = records.filter(r => r.kind === 'run.end').at(-1)
  const endReason = end && typeof end.body.reason === 'string' && end.body.reason !== '' ? oneLine(end.body.reason, 500) : null
  if (!first) {
    const goal = records.filter(r => verifyBody(r)?.gate === 'goal').at(-1)
    const gv = goal ? verifyBody(goal)! : null
    if (json.args.goalCheck === true && gv && !isGreen(gv)) {
      return {
        ok: false,
        why: `every gate landed, but the goal check ${gv.verify_id} wasn't green (${notGreen(gv)})`,
        advice: 'the goal needs more than the plan holds: plan the rest with /litter:design, or adjust the goal check',
      }
    }
    return { ok: false, why: `every gate landed${endReason ? `, and the run halted after them (${endReason})` : ''}`, advice: 'read the summary for what stopped it' }
  }
  const halted: Ending = {
    ok: false,
    why: `the run halted at gate ${first.id}${endReason ? ` (${endReason})` : ''}`,
    advice: `read the summary for why; amend the gate (/litter:amend ${first.id}), or continue the run once it's fixed`,
  }
  const repairAt = records.find(r => r.kind === 'run.repair')?.seq ?? Number.POSITIVE_INFINITY
  const verdicts = records.filter(r => r.seq < repairAt && r.kind === 'verdict' && gateOfVerdict(r, verifies) === first.id)
  const latest = verdicts.at(-1)
  const cited = latest && typeof latest.body.verify_id === 'string' ? (verifies.get(latest.body.verify_id) ?? null) : null
  // The executor's stop, before its attempt was judged: a plan gap bridges as a critic's does; a rule clash, a denied tool or red checks don't.
  // Its evidence verify is the one the gate's latest verdict cites, an earlier attempt's, when there is one.
  const wrote = records.filter(r => r.seq < repairAt && isGateResult(r) && r.body.gate === first.id).at(-1)
  if (wrote && (!latest || wrote.seq > latest.seq)) {
    const gap = executorGap(wrote)
    if (gap === null) return halted
    const attempt = Number.isSafeInteger(wrote.body.attempt) && (wrote.body.attempt as number) > 0 ? (wrote.body.attempt as number) : null
    return { ok: true, failure: { kind: 'plan_gap', by: 'executor', gate: first.id, gap, attempt, verify: cited } }
  }
  // A rule clash is the user's to settle, never a swarm's (WP-AH).
  if (latest && typeof latest.body.rule_clash === 'string' && latest.body.rule_clash.trim() !== '') {
    return {
      ok: false,
      why: `gate ${first.id}'s critic names a rule clash, which only you can settle ("${oneLine(latest.body.rule_clash, 500)}")`,
      advice: `edit the rule or add an exception in /litter rules, or change the plan's lines with /litter:amend ${first.id}, then continue the run`,
    }
  }
  if (latest && typeof latest.body.plan_gap === 'string' && latest.body.plan_gap.trim() !== '') {
    return { ok: true, failure: { kind: 'plan_gap', by: 'critic', gate: first.id, gap: latest.body.plan_gap, attempt: cited?.v.attempt ?? null, verify: cited } }
  }
  const max = maxAttemptsOf(json)
  if (latest && verdicts.length >= max) {
    const refused = records.filter(r => r.seq > latest.seq && (r.kind === 'land.abandoned' || r.kind === 'land.blocked') && r.body.gate === first.id).at(-1)
    if (refused) {
      return {
        ok: false,
        why: `gate ${first.id} was approved, but the mod refused its land (${oneLine(String(refused.body.reason ?? 'no reason recorded'))})`,
        advice: 'fix what the land names, then continue the run',
      }
    }
    return { ok: true, failure: { kind: 'attempts', gate: first.id, count: verdicts.length, max, verify: cited } }
  }
  return halted
}

/** The ending by workflow. */
const endingOf = (json: RunJson, records: readonly StoredRecord[]): Ending => (json.workflow === 'execute' ? classifyExecute(json, records) : classify(json, records))

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

/** The raw `args.gates` entry for a gate id (its `adversary` flag; planGates keeps only id, title and lines). */
function argsGate(json: RunJson, id: string): Record<string, unknown> | null {
  const gates = Array.isArray(json.args.gates) ? (json.args.gates as unknown[]) : []
  const g = gates.find(x => x !== null && typeof x === 'object' && (x as { id?: unknown }).id === id)
  return (g as Record<string, unknown> | undefined) ?? null
}

/**
 * The plan template's spec (phase 3, COMMON step 5; WP-AC step 4), from run
 * facts only: the gates with no land, the run's checkout and branch, the
 * halted gate and why (the gap quoted from the critic's verdict or the
 * executor's stop, which the runner needs, with whose words it is), the
 * budget and the evidence paths. Nodes never commit;
 * landing is the mod's.
 */
async function planSpecOf(p: Ports, f: Facts, failure: PlanFailure, name: string): Promise<RepairSpecResult> {
  const { ref, json, records } = f
  const run = ref.run
  const landed = landsOf(records)
  const remaining = (planGates(json) ?? []).filter(g => !landed.has(g.id)).map(g => g.id)
  if (remaining.length === 0) return { ok: false, reason: `every gate of run ${run} has landed, so a plan-template swarm would have nothing to land` }
  if (!(await p.fs.exists(json.checkout))) return { ok: false, reason: `run ${run}'s checkout ${json.checkout} is gone` }
  const earlier = Array.isArray(json.args.landed)
    ? (json.args.landed as unknown[]).flatMap(x => {
        const l = x as { id?: unknown; commit?: unknown } | null
        return l && typeof l.id === 'string' && typeof l.commit === 'string' ? [`${l.id} (${l.commit.slice(0, 12)}, by an earlier run of the chain)`] : []
      })
    : []
  const here = [...landed].map(([id, commit]) => `${id} (${commit.slice(0, 12)})`)
  const plan = typeof json.args.planPath === 'string' && json.args.planPath.startsWith('/') ? json.args.planPath : runPlanPath(ref.runDir)
  const v = failure.verify
  const task = renderSlots(PLAN_TASK, {
    run,
    gate: failure.gate,
    why: whyOf(failure),
    gap_by: failure.kind === 'plan_gap' ? renderSlots(failure.by === 'executor' ? PLAN_GAP_BY_EXECUTOR : PLAN_GAP_BY_CRITIC, { gate: failure.gate }) : null,
    gap: failure.kind === 'plan_gap' ? `"${oneLine(failure.gap, 2000)}"` : null,
    remaining: words(remaining, 100),
    landed: earlier.length + here.length > 0 ? words([...earlier, ...here], 100) : null,
    plan,
    checkout: json.checkout,
    branch: short(json.ref),
    tip: tipOfLedger(json, records),
    rounds: json.repair?.rounds ?? null,
    attempts: maxAttemptsOf(json),
    agents: json.repair?.agents ?? null,
    widen_line: widenOf(json) === 'critic' ? PLAN_WIDEN_CRITIC : PLAN_WIDEN_ASK,
    goal_line: json.args.goalCheck === true ? PLAN_GOAL_LINE : null,
    summary: summaryPath(ref.runDir),
    verdicts: verdictsDir(ref.runDir),
    verify_line: v ? renderSlots(PLAN_EVIDENCE_VERIFY, { dir: verifyLogDir(ref.runDir, v.v.verify_id), verify_id: v.v.verify_id, how: howEnded(v.v) }) : null,
  })
  const adversary = json.args.adversary === true || remaining.some(id => argsGate(json, id)?.adversary === true)
  const shared = { push: 'none' as const, rewriteHistory: false, worktreeOps: false }
  const nodes: SwarmNode[] = [
    {
      id: RUNNER,
      kind: 'orchestrator',
      brief: `briefs/${RUNNER}.md`,
      task,
      worktree: { existing: json.checkout },
      // It writes nothing: commit stays unset, for 2b-2's reason (a false would rank under its workers').
      tools: { deny: [...WRITE_TOOLS] },
      bash: { deny: ['git commit'] },
      spawns: { [EXECUTOR]: 1, [CRITIC]: 1, ...(adversary ? { [ADVERSARY]: 1 } : {}) },
      authority: { ...shared, verify: true, land: true },
      report: ['blocked', 'done'],
    },
    {
      id: EXECUTOR,
      kind: 'worker',
      brief: `briefs/${EXECUTOR}.md`,
      worktree: 'inherit',
      // One writer at a time in the run's checkout (decision 10); no paths: a gate's Files are expected, not owned.
      serial: true,
      authority: { commit: false, ...shared, verify: true },
    },
    {
      id: CRITIC,
      kind: 'worker',
      brief: `briefs/${CRITIC}.md`,
      worktree: 'inherit',
      verdicts: true,
      spawnOther: false,
      tools: { deny: [...WRITE_TOOLS] },
      authority: { commit: false, ...shared, verify: true },
    },
  ]
  if (adversary) {
    nodes.push({
      id: ADVERSARY,
      kind: 'worker',
      brief: `briefs/${ADVERSARY}.md`,
      worktree: 'inherit',
      tools: { deny: [...WRITE_TOOLS] },
      bash: { deny: ['git commit'] },
      authority: { commit: false, ...shared },
    })
  }
  const spec: SwarmSpec = { name, goal: renderSlots(PLAN_GOAL, { run, branch: short(json.ref) }), nodes, limits: { maxAgentsAtOnce: 3 } }
  const briefs: Record<string, string> = { [RUNNER]: PLAN_RUNNER_BRIEF, [EXECUTOR]: PLAN_EXECUTOR_BRIEF, [CRITIC]: PLAN_CRITIC_BRIEF }
  if (adversary) briefs[ADVERSARY] = PLAN_ADVERSARY_BRIEF
  return { ok: true, spec, briefs }
}

/** The spec under a name free now, for a fanout ending in one of the three failures, or an execute run in one of the two. */
async function makeSpec(p: Ports, f: Facts): Promise<RepairSpecResult & { failure?: Failure }> {
  const wf = f.json.workflow
  if (wf !== 'fanout' && wf !== 'execute') return { ok: false, reason: `run ${f.ref.run} is a ${wf} run, not a fanout or an execute run` }
  const ending = endingOf(f.json, f.records)
  if (!ending.ok) return { ok: false, reason: notTaken(f.json, ending) }
  const name = await freeName(p, f.ref.litterDir, f.ref.runDir)
  if (!name) return { ok: false, reason: 'every repair swarm name for this run is taken' }
  const failure = ending.failure
  const made = failure.kind === 'plan_gap' || failure.kind === 'attempts' ? await planSpecOf(p, f, failure, name) : await specOf(p, f, failure, name)
  return made.ok ? { ...made, failure } : made
}

/**
 * The repair swarm's spec (COMMON 2b-2, step 4; phase 3's plan template for
 * an execute run), from the run's facts only: for a fanout, the tasks' owned
 * paths, the kept integration worktree and branch, the failure kind and the
 * evidence paths, never task or verifier text; for an execute run, as
 * planSpecOf. It must pass validateSpec.
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

/**
 * An execute run's baseline (decision 9): the checkout on the run's branch,
 * the branch tip where the ledger left it (the last land's commit, or base),
 * and a green verify of that tip's tree with the run's verify argv anywhere in
 * the run's chain (lifecycle's greenBaseline, as amend's carry-over finds
 * it). Unlike a fanout's, the halted attempt stays in the tree, and no verify
 * runs.
 */
async function executeBaseline(p: Ports, f: Facts): Promise<Baseline> {
  const { json, ref, records } = f
  const co = json.checkout
  const branch = short(json.ref)
  if (!(await p.fs.exists(co))) return { ok: false, reason: `the run's checkout ${co} is gone` }
  const head = await gitOut(p, co, ['symbolic-ref', '-q', 'HEAD'])
  if (head.code !== 0 || head.out !== json.ref) {
    return { ok: false, reason: `the checkout changed: ${co} is on ${head.code === 0 && head.out !== '' ? short(head.out) : 'a detached HEAD'}, not the run's branch ${branch}` }
  }
  const left = tipOfLedger(json, records)
  const at = await gitOut(p, co, ['rev-parse', '-q', '--verify', '--end-of-options', `${json.ref}^{commit}`])
  if (at.code !== 0 || at.out !== left) return { ok: false, reason: `the run's branch moved: ${branch} is at ${at.out || 'nothing'}, not ${left} where the run left it` }
  const tree = await gitOut(p, co, ['rev-parse', '-q', '--verify', '--end-of-options', `${left}^{tree}`])
  if (tree.code !== 0 || tree.out === '') return { ok: false, reason: `git can't read the tree of ${branch}'s tip ${left}` }
  const chain = await resolveChain(p, ref.litterDir, ref.run)
  if (!chain.ok) return { ok: false, reason: `the run's chain can't be read: ${noLitter(chain.error)}` }
  const found = json.verify ? greenBaseline(chain.members, tree.out, json.verify) : null
  if (!found || typeof found.verify_id !== 'string') return { ok: false, reason: "no green verify of the branch's tip; the suite may have been red before the halted gate" }
  return { ok: true, verifyId: found.verify_id }
}

/** The baseline by workflow: a fanout's runs the suite on its base, an execute run's finds the chain's green verify of its tip. */
const baselineOf = (p: Ports, f: Facts, timeoutMs: number): Promise<Baseline> => (f.json.workflow === 'execute' ? executeBaseline(p, f) : baseline(p, f, timeoutMs))

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
    // The run's own repair swarm may work in its checkout (decision 10): the reopen made this run the active one.
    const planned = await planLaunch(p, name, { revision: saved.revision, grants: true, forRun: ref.run })
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

/** The declines that say only that nothing started it, not that it couldn't start: the summary still recommends the swarm. */
const NOT_AUTO = 'repair is off for this run'
const AT_RECONCILE = "the run's end was found at session start, after the fact, and a repair never starts on its own from there"
const NOT_INTERACTIVE = "no one to watch it: this session isn't interactive"

/**
 * After a halted fanout's or execute run's endRun returned, outside the run's
 * serial key (`run:<runDir>`): starts the repair swarm (an execute run's
 * plan-template swarm) when COMMON step 3's conditions all hold (phase 3's
 * decision 7 for execute, in the same order), else records `repair.declined
 * { reason }` and rewrites summary.md. A no-op for any other run, or one a
 * repair was already started or declined for. lifecycle.ts awaits it (so the
 * notification turn's `<swarm>` block sees the swarm it started) and logs a
 * rejection: the run's end stands either way.
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
  if ((json.workflow !== 'fanout' && json.workflow !== 'execute') || !json.repair) return
  const end = latestEnd(st)
  if (!end || end.status !== 'halted' || st.open) return
  if (records.some(r => r.kind === 'run.repair' || r.kind === 'repair.declined')) return

  const decline = async (reason: string): Promise<void> => {
    await appendRecord<RepairDeclinedBody>(p, runDir, { run: ref.run, kind: 'repair.declined', by: MOD, body: { reason } })
    await rewriteSummary(p, ref)
  }
  // COMMON step 3's order (phase 3's decision 7).
  if (json.repair.mode !== 'auto') return decline(NOT_AUTO)
  if (end.source === 'reconcile') return decline(AT_RECONCILE)
  const ending = endingOf(json, records)
  if (!ending.ok) return decline(notTaken(json, ending))
  if (interactive() !== true) return decline(NOT_INTERACTIVE)
  const made = await makeSpec(p, f)
  if (!made.ok || !made.failure) return decline(made.ok ? 'the repair spec has no failure' : made.reason)
  const planned = await planLaunch(p, made.spec.name, { saved: { spec: made.spec, revision: 0, briefs: made.briefs }, grants: true, forRun: ref.run })
  if (!planned.ok) return decline(noLitter(planned.reason))
  const held = await lockHeld(p, ref.litterDir)
  if (held) return decline(held)
  const base = await baselineOf(p, f, getOptions().verifyTimeoutMs)
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
  if (ctx.litterDir === null) return fail("litter: this session has no litter directory (see /litter doctor)")
  const run = input.run
  if (typeof run !== 'string' || !RUN_ID.test(run)) return fail("litter: 'run' must be a run id like 20261002-my-run", 'run')
  const runDir = runDirOf(ctx.litterDir, run)
  return serial(`repair:${runDir}`, () => startByAsk(ctx, runDir))
}

/** A fanout's repair ask, as 2b-2 wrote it. */
function fanoutAsk(f: Facts, name: string, failure: Failure, budget: RepairBudget, verifyId: string): string[] {
  const { json, records, ref } = f
  const wt = integrationWorktree(records, ref.run)!
  return [
    `Start repair swarm ${name} for fanout run ${ref.run}?`,
    `Failure: ${failureText(failure)}`,
    `It takes over the integration worktree ${wt.path} and commits fixes on ${wt.branch}. The mod lands the result on ${short(json.ref)} only once it's verified and an independent check approves it. Nothing is pushed.`,
    `Budget: up to ${budget.rounds} rounds and ${budget.agents} agents; only your answer to litter's own ask raises it.`,
    `Baseline: verify ${verifyId} is green on the run's base ${json.base.slice(0, 12)}.`,
  ]
}

/** The gates of an execute run with no land, in the plan's order. */
const remainingOf = (json: RunJson, records: readonly StoredRecord[]): string[] => {
  const landed = landsOf(records)
  return (planGates(json) ?? []).filter(g => !landed.has(g.id)).map(g => g.id)
}

/** The budget in CONFIRM_AUTO's terms. */
const planBudgetText = (json: RunJson, budget: RepairBudget): string =>
  `up to ${budget.rounds} rejected attempts in all, ${maxAttemptsOf(json)} per gate, and ${budget.agents} agents`

/** An execute run's ask (WP-AC step 3): the run and the halted gate, why, the gates left, where it works and who lands, the budget, the baseline. */
function planAsk(f: Facts, name: string, failure: PlanFailure, budget: RepairBudget, verifyId: string): string[] {
  const { json, records, ref } = f
  const branch = short(json.ref)
  return [
    `Start plan-template swarm ${name} for execute run ${ref.run}?`,
    `Halted: gate ${failure.gate}, because ${whyOf(failure)}.`,
    ...(failure.kind === 'plan_gap' ? [`The plan gap: "${oneLine(failure.gap, 300)}"`] : []),
    `Gates left: ${words(remainingOf(json, records), 50)}.`,
    `It works in the run's checkout ${json.checkout}, on ${branch}, starting from the halted attempt, if any, still in its tree. The mod lands each gate on ${branch} only once it's verified and an independent critic approves it. Nothing is pushed.`,
    `Budget: ${planBudgetText(json, budget)}; only your answer to litter's own ask raises it.`,
    `Baseline: verify ${verifyId} is green on ${branch}'s tip ${tipOfLedger(json, records).slice(0, 12)}.`,
  ]
}

async function startByAsk(ctx: RecordCtx, runDir: string): Promise<RecordReply> {
  const { p } = ctx
  const loaded = await loadFacts(p, runDir)
  if (!loaded.ok) return fail(`litter: ${loaded.reason}`, 'run')
  const f = loaded.facts
  const { ref, json, records, st } = f
  const run = ref.run
  const execute = json.workflow === 'execute'
  if (json.workflow !== 'fanout' && !execute) {
    return fail(`litter: run ${run} is a ${json.workflow} run; only a fanout's combined result, or a halted execute run's gates, continue as a swarm`, 'run')
  }
  if (!json.repair) {
    return fail(`litter: run ${run} started before litter repaired ${execute ? 'execute runs' : 'fanouts'}, so its launch confirmation stated no repair, and none starts for it`, 'run')
  }
  const already = repairOf(records)
  if (already) return fail(`litter: run ${run} has a repair already: swarm ${already.body.swarm}, launch ${already.body.launch}`, 'run')
  const end = latestEnd(st)
  if (st.open || !end) return fail(`litter: run ${run} hasn't ended; a repair starts only once it halted`, 'run')
  if (end.status !== 'halted') return fail(`litter: run ${run} ended ${end.status}, not halted, so there's nothing to repair`, 'run')
  const ending = endingOf(json, records)
  if (!ending.ok) return fail(`litter: run ${run} can't ${execute ? 'continue' : 'be repaired'} as a swarm: ${notTaken(json, ending)}; ${ending.advice}`, 'run')
  const held = await lockHeld(p, ref.litterDir)
  if (held) return fail(`litter: ${held}; start the repair once it's free`)
  const made = await makeSpec(p, f)
  if (!made.ok || !made.failure) return fail(`litter: no repair swarm for run ${run}: ${made.ok ? 'it has no failure' : made.reason}`)
  const planned = await planLaunch(p, made.spec.name, { saved: { spec: made.spec, revision: 0, briefs: made.briefs }, grants: true, forRun: run })
  if (!planned.ok) return fail(planned.reason)
  const base = await baselineOf(p, f, ctx.options.verifyTimeoutMs)
  if (!base.ok) return fail(`litter: no repair of run ${run}: ${base.reason}`)

  // The builder's confirmation (COMMON step 3, "Under off"): the authority and the budget, in the mod's own ask.
  const budget = budgetOf(json)
  const question = launchQuestion(planned.plan, execute ? planAsk(f, made.spec.name, made.failure as PlanFailure, budget, base.verifyId) : fanoutAsk(f, made.spec.name, made.failure, budget, base.verifyId))
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
  const what = execute ? 'Plan-template swarm' : 'Repair swarm'
  return {
    ok: true,
    run,
    swarm: started.name,
    launch: started.launch,
    generation: started.link.generation,
    budget,
    next: filled
      ? `${what} ${started.name} is live. Its start line is in the user's prompt box: say so in a line and end your turn; their Enter starts it. Don't start it yourself.`
      : `${what} ${started.name} is live, but the prompt box didn't take its start line: tell the user to send /litter:swarm start ${started.name}.`,
  }
}

// ---------------------------------------------------------------------------
// repair.budget (COMMON step 6; decision 8)

/** `repair.budget { swarm, rounds?, agents? }` (the launcher's): the mod's own ask, then the raised budget and a `budget` event. */
export const recordRepairBudget: RecordHandler = async (ctx, input) => {
  if (ctx.litterDir === null) return fail("litter: this session has no litter directory (see /litter doctor)")
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
  // The plan template's rounds are rejected attempts (decision 1); its orchestrator is the runner.
  const plan = s.spec.nodes.some(n => n.kind === 'orchestrator' && n.id === RUNNER)
  const unit = plan ? 'rejected attempt' : 'round'
  const asked = [
    more.rounds !== undefined ? `${more.rounds} more ${more.rounds === 1 ? unit : `${unit}s`}` : null,
    more.agents !== undefined ? `${more.agents} more ${more.agents === 1 ? 'agent' : 'agents'}` : null,
  ].filter((x): x is string => x !== null)
  const question = [
    `Give ${plan ? 'plan-template' : 'repair'} swarm ${name} ${asked.join(' and ')}?`,
    plan
      ? `It lands the remaining gates of execute run ${s.run!.run}. It has used ${roundsUsed(name)} of ${was.rounds} rejected attempts and ${spawnsUsed(name)} of ${was.agents} agents.`
      : `It repairs fanout run ${s.run!.run}. It has used ${roundsUsed(name)} of ${was.rounds} rounds and ${spawnsUsed(name)} of ${was.agents} agents.`,
    plan
      ? `With this, its budget is ${was.rounds + (more.rounds ?? 0)} rejected attempts and ${was.agents + (more.agents ?? 0)} agents. A rejected attempt is a verdict the critic didn't approve; an approval uses none, and each gate still gets at most its run's attempts. The agents are the workers and other agents its nodes spawn.`
      : `With this, its budget is ${was.rounds + (more.rounds ?? 0)} rounds and ${was.agents + (more.agents ?? 0)} agents. Each round is a verdict on a new verify; the agents are the workers and other agents its nodes spawn.`,
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
        next: plan
          ? `Tell the plan-template swarm's runner with mcp__litter__swarm_send (node ${RUNNER}) that its budget is now ${budget.rounds} rejected attempts and ${budget.agents} agents.`
          : `Tell the repair swarm's orchestrator with mcp__litter__swarm_send (node ${ORCHESTRATOR}) that its budget is now ${budget.rounds} rounds and ${budget.agents} agents.`,
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
// The start on the lead's next turn (decision 2; spike 19), and your Enter
// when that turn didn't make it (WP-AS)

/**
 * A repair swarm the bridge started, waiting for the lead's start. In
 * `$.store`, so a reload keeps it. `submitted`: the start went to the lead.
 * `filled`: that start's turn ended with nothing spawned, and the mod put the
 * start line in your prompt box (`inBox`: whether the box took it); never twice.
 */
type PendingStart = {
  swarm: string
  launch: string
  run: string
  runDir: string
  litterDir: string
  at: number
  submitted?: boolean
  filled?: boolean
  inBox?: boolean
}

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

async function storedPending(p: Ports, litterDir: string): Promise<PendingStart[]> {
  const list = await p.store.get(pendingKey(litterDir))
  return Array.isArray(list) ? list.filter(isPending).filter(e => e.litterDir === litterDir) : []
}

async function loadPending(p: Ports, litterDir: string): Promise<void> {
  const read = await storedPending(p, litterDir)
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

/** Submitted, and its turn ended with nothing spawned (WP-AS): not filled, not handed to a timer, owned here. */
const unstarted = (e: PendingStart): boolean => e.submitted === true && e.filled !== true && !scheduled.has(keyOf(e)) && ownedHere(e) && !startedHere(e)

/** The launch ledger has an orchestrator's swarm.node. */
const orchestratorBound = (facts: LaunchFacts): boolean => [...facts.nodes.values()].some(r => r.body.kind === 'orchestrator')

const runRefOf = (e: PendingStart): RunRef => ({ run: e.run, runDir: e.runDir, litterDir: e.litterDir })

/** Drops each start whose launch ended, never started, or has an orchestrator: it's done with. */
async function prunePending(p: Ports, litterDir: string): Promise<void> {
  const keep: PendingStart[] = []
  const done: PendingStart[] = []
  for (const e of pending.filter(x => x.litterDir === litterDir)) {
    const facts = await readLaunchFacts(p, litterDir, e.swarm, e.launch).catch(() => null)
    if (facts && (!facts.start || facts.ended || orchestratorBound(facts) || startedHere(e))) done.push(e)
    else keep.push(e)
  }
  if (done.length === 0) return
  pending = [...pending.filter(x => x.litterDir !== litterDir), ...keep]
  await savePending(p, litterDir)
  // A filled start's summary said it waited for your Enter, which it no longer does.
  for (const e of done) if (e.filled === true) await rewriteSummary(p, runRefOf(e))
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
 * hook; the text doesn't start with `/`). The lead turn after a submitted
 * start, aborted or not, that left no orchestrator spawned or admitted
 * schedules the fill of its start line instead, once (WP-AS: the skill or the
 * spawn may have been refused). register.tsx calls it inside the hook's own
 * catch: a rejection is logged and the turn passes on.
 */
export async function repairTurnComplete(p: Ports, e: Parameters<TurnCompleteHook>[1]): Promise<void> {
  if (e.agentId !== undefined) return
  const litterDir = session().litterDir
  if (!litterDir) return
  if (!loaded.has(litterDir)) await loadPending(p, litterDir)
  if (!pending.some(x => x.litterDir === litterDir)) return
  await prunePending(p, litterDir)
  if (interactive() !== true) return
  // The engine doesn't await a timer's callback, and neither step rejects; the promise is handed back for a test's runAfters.
  for (const entry of pending.filter(x => x.litterDir === litterDir && unstarted(x))) {
    scheduled.add(keyOf(entry))
    p.after(0, () => fillStartLine(p, entry))
  }
  if (e.isAborted) return
  for (const entry of pending.filter(x => x.litterDir === litterDir && waiting(x))) {
    scheduled.add(keyOf(entry))
    p.after(0, () => submitStart(p, entry))
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
    p.toast(`repair swarm ${entry.swarm} is live; send /litter:swarm start ${entry.swarm} to start it`)
  } finally {
    scheduled.delete(key)
  }
}

/**
 * From the timer, once per pending start (WP-AS): the start went to the
 * lead, and its turn ended with no orchestrator spawned or admitted. The
 * start line, with the authority the launch recorded, goes in your prompt
 * box, so your Enter makes the start your own message, as the builder's
 * Launch does (`fillStart`). A toast says so; a `start-filled` event records
 * whether the box took it; the start is marked filled in the store first, so
 * a reload doesn't fill it again; summary.md says it's waiting for you.
 */
async function fillStartLine(p: Ports, entry: PendingStart): Promise<void> {
  const key = keyOf(entry)
  try {
    const now = pending.find(x => keyOf(x) === key)
    if (!now || now.submitted !== true || now.filled === true || !ownedHere(now) || startedHere(now)) return
    const facts = await readLaunchFacts(p, now.litterDir, now.swarm, now.launch)
    if (facts.ended || orchestratorBound(facts)) return
    now.filled = true
    await savePending(p, now.litterDir)
    const line = `/litter:swarm start ${now.swarm}`
    const s = liveSwarm(now.swarm)
    const authority = s ? authorityLines(s, facts.start?.body ?? null) : []
    const inBox = await p.fillPrompt([line, ...authority].join('\n')).catch(() => false)
    now.inBox = inBox
    await savePending(p, now.litterDir)
    const why = `repair swarm ${now.swarm} didn't start on the lead's turn (its start may have been refused)`
    if (inBox) p.toast(`${why}; press Enter to start it, or /litter:swarm end ${now.swarm} to stop it`)
    else {
      p.log(`repair swarm ${now.swarm}: the prompt box didn't take its start line`)
      p.toast(`${why}; send ${line} to start it, or /litter:swarm end ${now.swarm} to stop it`)
    }
    const event: SwarmEventBody = { kind: 'start-filled', filled: inBox }
    // The event log is a record, not a gate: a failed append is logged, and the summary still says it waits.
    await appendLaunchRecord(p, now.litterDir, now.swarm, now.launch, 'swarm.event', event).catch((err: unknown) =>
      p.log(`repair swarm ${now.swarm}: its start-filled event wasn't recorded: ${errText(err)}`),
    )
    await rewriteSummary(p, runRefOf(now))
  } catch (err) {
    p.log(`repair swarm ${entry.swarm}: its start line wasn't filled: ${errText(err)}`)
  } finally {
    scheduled.delete(key)
  }
}

/**
 * The Repair section's line while the start litter filled waits for you
 * (WP-AS): a filled pending start of this launch, with no orchestrator and
 * the launch not ended. Null otherwise. Reads the store when this process
 * hasn't loaded it, and changes nothing.
 */
async function waitingLine(p: Ports, litterDir: string, swarm: string, launch: string): Promise<string | null> {
  const list = loaded.has(litterDir) ? pending.filter(x => x.litterDir === litterDir) : await storedPending(p, litterDir)
  const e = list.find(x => x.swarm === swarm && x.launch === launch && x.filled === true)
  if (!e || startedHere(e)) return null
  const facts = await readLaunchFacts(p, litterDir, swarm, launch).catch(() => null)
  if (facts && (facts.ended || orchestratorBound(facts))) return null
  const line = `/litter:swarm start ${swarm}`
  return e.inBox === false
    ? `It didn't start on the lead's turn (its start may have been refused), and the prompt box didn't take its start line: it's waiting for you to send ${line}, or /litter:swarm end ${swarm} to stop it.`
    : `It didn't start on the lead's turn (its start may have been refused): it's waiting for your Enter on ${line}, which litter put in your prompt box, or /litter:swarm end ${swarm} to stop it.`
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
 * and the recommendation, or the recommendation under `repair: off`; an
 * execute run's is planSummary's. Empty for a run with nothing to say (not a
 * fanout or an execute run, or done). W's writeSummary appends it, and keeps
 * the rest of the summary when it rejects.
 */
export async function repairSummary(p: Ports, runDir: string): Promise<string> {
  const read = await loadFacts(p, runDir)
  if (!read.ok) return ''
  const { ref, json, records, st } = read.facts
  if ((json.workflow !== 'execute' && json.workflow !== 'fanout') || !json.repair) return ''
  const open = repairOf(records)
  // A start the lead's turn didn't make, waiting for your Enter (WP-AS).
  const wait = open ? await waitingLine(p, ref.litterDir, open.body.swarm, open.body.launch) : null
  if (json.workflow === 'execute') return planSummary(read.facts, wait)
  const lines = ['## Repair', '']
  const branch = short(json.ref)

  if (open) {
    const b = open.body
    lines.push(
      `Repair swarm ${b.swarm} (launch ${b.launch}) took over in generation ${b.generation}, with a budget of ${b.budget.rounds} rounds and ${b.budget.agents} agents. It works in the run's integration worktree, and the mod lands its result on ${branch} only once it's verified and an independent check approves it; nothing is pushed.`,
    )
    const end = records.filter(r => r.kind === 'run.end' && r.seq > open.seq && r.body.generation === b.generation).at(-1)
    const status = end ? body<RunEndBody>(end) : null
    if (!status && wait) lines.push('', wait)
    if (!status) lines.push('', `Watch it with /litter swarms ${b.swarm}; it shows the budget used and each verify, verdict and land.`)
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

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * An execute run's Repair section (WP-AC step 3): what started (the swarm,
 * the gates it took over, the budget, how to watch it) and how it ended; or
 * why nothing started, and, when the halt is one the plan template takes on,
 * decision 5's routes: continue as that swarm, amend the gate, or stop.
 * `wait` is waitingLine's, while the swarm waits for your Enter (WP-AS).
 */
function planSummary(f: Facts, wait: string | null): string {
  const { ref, json, records, st } = f
  const lines = ['## Repair', '']
  const branch = short(json.ref)

  const open = repairOf(records)
  if (open) {
    const b = open.body
    const taken = remainingOf(json, records.filter(r => r.seq < open.seq))
    lines.push(
      `Plan-template swarm ${b.swarm} (launch ${b.launch}) took over in generation ${b.generation}, to land ${taken.length === 1 ? 'gate' : 'gates'} ${words(taken, 50)}, with a budget of ${planBudgetText(json, b.budget)}. It works in the run's checkout ${json.checkout}, starting from the halted attempt, if any, and the mod lands each gate on ${branch} only once it's verified and an independent critic approves it; nothing is pushed.`,
    )
    const end = records.filter(r => r.kind === 'run.end' && r.seq > open.seq && r.body.generation === b.generation).at(-1)
    const status = end ? body<RunEndBody>(end) : null
    const lands = records
      .filter(r => r.kind === 'land' && r.seq > open.seq && typeof r.body.gate === 'string')
      .map(r => `${String(r.body.gate)} (${String(r.body.commit ?? '').slice(0, 12)})`)
    if (!status && wait) lines.push('', wait)
    if (!status) lines.push('', `Watch it with /litter swarms ${b.swarm}; it shows the budget used and each verify, verdict and land.`)
    else if (status.status === 'done') lines.push('', `It landed ${words(lands, 50)} on ${branch}: generation ${b.generation} ended done.`)
    else {
      const left = remainingOf(json, records)
      lines.push(
        '',
        `It ended ${status.status}${status.reason ? ` (${oneLine(status.reason, 500)})` : ''}. ${lands.length > 0 ? `It landed ${words(lands, 50)} on ${branch}` : 'It landed nothing'}${left.length > 0 ? `, and ${words(left, 50)} ${left.length === 1 ? "hasn't" : "haven't"} landed` : ''}. Its lands stay on ${branch}, and whatever it left uncommitted stays in the checkout.`,
      )
    }
    lines.push('')
    return lines.join('\n')
  }

  const end = latestEnd(st)
  if (!end || end.status !== 'halted') return ''
  const declined = records.filter(r => r.kind === 'repair.declined').at(-1)
  const reason = declined ? oneLine(String(body<RepairDeclinedBody>(declined).reason ?? ''), 1000) : null
  const why = reason ?? (json.repair!.mode === 'off' ? NOT_AUTO : null)
  lines.push(why ? `No plan-template swarm started: ${why}.` : 'No plan-template swarm has started for this run.')
  const ending = classifyExecute(json, records)
  if (!ending.ok) {
    if (ending.why !== why) lines.push('', ending.alone ? `${capital(ending.why)}.` : `A plan-template swarm can't take this on: ${ending.why}. Instead, ${ending.advice}.`)
  } else {
    const fl = ending.failure as PlanFailure
    const b = budgetOf(json)
    // Recommended only when nothing but the setting, or the moment, kept it from starting.
    const recommend = reason === null || reason === NOT_AUTO || reason === AT_RECONCILE || reason === NOT_INTERACTIVE
    const auto = renderSlots(CONFIRM_AUTO, { rounds: b.rounds, attempts: maxAttemptsOf(json), agents: b.agents })
    lines.push(
      '',
      `${recommend ? 'Recommended: continue as a plan-template swarm. ' : ''}${capital(failureText(fl))}. ${fl.kind === 'plan_gap' ? `The plan gap: "${oneLine(fl.gap, 500)}". ` : ''}Under repair: auto, ${auto}. It would land ${words(remainingOf(json, records), 50)}, starting from the halted attempt in the tree, if any, and its gate-runner asks you before a gap changes the plan's scope or requirements.`,
      '',
      `The ways on: continue as a plan-template swarm (/litter:swarm repair ${ref.run}), amend the gate (/litter:amend ${fl.gate} …), or stop; the halted attempt, if any, is still in the tree. Continuing asks you to confirm its authority and budget first.`,
    )
  }
  lines.push('')
  return lines.join('\n')
}
