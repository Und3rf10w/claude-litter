// The world AC's tier-2 specs share (execbridge, execspec, execgate and
// runcheckout; phase 3, WP-AC): K's swarmlaunch world (a scratch repository
// on main with `.claude/` ignored, its litter directory, and the launch's
// stand-ins for J's validateSpec and health check) holding an execute run as
// the mod leaves it once generation 1 halted: the checkout switched to
// litter/<run> at base, plan.md, run.json and its run.start, run.launch, G1
// landed through execute's own land (land.ts, landGate: a real commit with
// its Litter-Run trailer), then the records of the halt asked for, the halted
// attempt left in the tree, and run.end. The verifies are Y's stand-in
// (repair-harness.ts), which snapshots the tree and runs the run's argv for
// real. Not a spec itself.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Author, RecordCtx, StoredRecord } from '../../hooks/records/core'
import type { RunEndBody, RunJson } from '../../hooks/records/run'
import type { GateVerdictBody, LandReply, VerdictDimension, VerifyBody } from '../../hooks/records/execute'
import type { RunFacts } from '../../hooks/verify'
import type { GateResultBody } from '../../hooks/output'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { planPath, runDir as runDirOf, runJsonPath } from '../../hooks/layout'
import { sha256 } from '../../hooks/fsx'
import { normalizeOptions } from '../../hooks/options'
import { MOD } from '../../hooks/verify'
import { landGate } from '../../hooks/land'
import { standInVerify } from './repair-harness'
import type { World } from './swarmlaunch-harness'

export const RUN = '20261003-exec'
export const REF = `refs/heads/litter/${RUN}`
export const BRANCH = `litter/${RUN}`
/** Green unless `.claude/red` exists: `.claude/` is ignored, so turning it red changes no tree. */
export const VERIFY = ['sh', '-c', 'test ! -e .claude/red']
/** The goal check, red while `.claude/goal-red` exists. */
export const GOAL = ['sh', '-c', 'test ! -e .claude/goal-red']
export const GAP = 'the plan names no config file for the parser to read, and G2 needs one'
export const CLASH = 'P-no-env@1 bans reading the environment, and plan.md:8 merges the defaults from it'
export const TITLES: Readonly<Record<string, string>> = { G1: 'Parse the config file', G2: 'Load the defaults', G3: 'Document the options' }
/** plan.md's text: a run fact the spec and the task must never copy. */
export const PLAN_TEXT = [
  '# Config plan',
  '',
  '## G1: Parse the config file',
  'Files: g1.txt',
  'Read the settings with the strict parser.',
  '',
  '## G2: Load the defaults',
  'Files: g2.txt',
  'Merge the shipped defaults under the settings.',
  '',
  '## G3: Document the options',
  'Files: g3.txt',
  'List every option in the README.',
  '',
].join('\n')

/**
 * How generation 1 ended. Every one but the last three is a halt at G2
 * (goal_red halts after every gate landed). `executor_gap`: G2's executor
 * stopped on attempt 1 with a plan gap, before any verdict on G2;
 * `executor_gap_late`: on attempt 2, after attempt 1 was rejected;
 * `rule_clash`: the critic's verdict on attempt 1 names a rule clash;
 * `executor_gap_then_clash`: the executor's plan-gap stop, then a later
 * verdict naming a rule clash (the verdict is the latest event);
 * `critic_null`: the executor's attempt 1 is done, and its critic returned
 * nothing (no verify, no verdict); `critic_null_verified`: the same, after
 * the critic recorded its verify of attempt 1; `adversary_null`: the
 * adversary of a done attempt 1 returned nothing.
 */
export type Halt =
  | 'plan_gap'
  | 'executor_gap'
  | 'executor_gap_late'
  | 'rule_clash'
  | 'executor_gap_then_clash'
  | 'critic_null'
  | 'critic_null_verified'
  | 'adversary_null'
  | 'attempts'
  | 'recritique'
  | 'abandoned'
  | 'blocked'
  | 'null_agent'
  | 'budget'
  | 'retry_false'
  | 'goal_red'
  | 'interrupted'
  | 'stopped'

export type ExecOpts = {
  halt?: Halt
  mode?: 'auto' | 'off'
  source?: RunEndBody['source']
  /** No repair setting: a run.json from before 2b-2. */
  noRepair?: boolean
  rounds?: number
  agents?: number
  maxAttempts?: number
  goal?: boolean
  /** `run`: args.adversary; `gate`: G3's own Adversary line; `landed`: G1's, which lands in generation 1. */
  adversary?: 'run' | 'gate' | 'landed'
  /** An amend run (decision 13). */
  amend?: boolean
  /** G1's green verify recorded with another argv, so the chain has no green verify of the tip with the run's. */
  staleBaseline?: boolean
  /** `blocked`'s notes: why the executor stopped, with an empty plan_gap. */
  blocked?: string
  /** run.json's widen (WP-AO); left out, as in a run.json from before it. */
  widen?: 'ask' | 'critic'
}

export type Landed = { gate: string; verifyId: string; commit: string; tree: string }

export type Exec = {
  w: World
  runDir: string
  base: string
  json: RunJson
  /** `repair-<6 hex of sha256(runDir)>`, the name the bridge gives its swarm. */
  name: string
  lands: Landed[]
  /** The halted gate's verifies, in order. */
  g2: VerifyBody[]
}

const pass = (evidence: string): VerdictDimension => ({ pass: true, evidence, gaps: [] })
const failed = (gap: string): VerdictDimension => ({ pass: false, evidence: 'read the diff against the plan lines', gaps: [gap] })

/** An execute gate critic's verdict body, as output.ts records it. */
export function verdictOf(verifyId: string, o: { approve?: boolean; gap?: string; clash?: string } = {}): GateVerdictBody {
  const ok = o.approve === true
  return {
    verify_id: verifyId,
    plan_adherence: ok || o.gap || o.clash ? pass('plan.md:3-5 against the diff') : failed('the defaults are merged over the settings, not under'),
    tests_green: pass(`verify ${verifyId} exit 0`),
    no_regressions: pass('searched the callers of loadConfig'),
    rules: pass('none apply'),
    plan_gap: o.gap ?? '',
    rule_clash: o.clash ?? '',
    proposed_rules: [],
    tool_use_id: `tu-${verifyId}`,
  }
}

/** Generation 1's agents, as execute's roles record. */
export const criticOf = (gate: string): Author => ({ source: 'agent', agentId: `critic-${gate}`, agentType: 'litter:gate-critic' })
export const executorOf = (gate: string): Author => ({ source: 'agent', agentId: `executor-${gate}`, agentType: 'litter:executor' })

/** An execute executor's result body, as output.ts records it (GateResultBody): `gap` set for a plan-gap stop, `notes` for any other block. */
export function wroteOf(gate: string, attempt: number, o: { gap?: string; notes?: string } = {}): GateResultBody {
  const blocked = o.gap !== undefined || o.notes !== undefined
  return {
    task: null,
    role: 'executor',
    tool_use_id: `tu-write-${gate}-${attempt}`,
    result: {
      status: blocked ? 'blocked' : 'done',
      plan_lines: ['plan.md:7-9'],
      files: blocked ? [] : [`${gate.toLowerCase()}.txt`],
      checks: blocked ? [] : ['sh -c test: pass'],
      notes: o.notes ?? (o.gap !== undefined ? 'stopped before changing anything' : ''),
      plan_gap: o.gap ?? '',
    },
    gate,
    attempt,
  }
}

export function write(at: string, path: string, text: string): void {
  mkdirSync(join(at, path, '..'), { recursive: true })
  writeFileSync(join(at, path), text)
}

export const factsOf = (x: Pick<Exec, 'runDir' | 'json'>): RunFacts => ({ run: RUN, runDir: x.runDir, json: x.json })

/** A verify of the checkout as `by`, recorded in the run's ledger (the stand-in runs the argv for real). */
export async function verifyAs(x: Pick<Exec, 'w' | 'runDir' | 'json'>, gate: string, attempt: number, by: Author): Promise<VerifyBody> {
  const r = await standInVerify(x.w.p, factsOf(x), { gate, attempt, where: x.w.dir, by, timeoutMs: 60_000 })
  if (!r.ok) throw new Error(`the harness's verify failed: ${r.error}`)
  return r.body
}

/** A gate written, verified green, approved and landed by execute's own land, as execute.js lands it. */
async function landed(x: Pick<Exec, 'w' | 'runDir' | 'json'>, gate: string, file: string): Promise<Landed> {
  write(x.w.dir, file, `${gate} done\n`)
  await appendRecord(x.w.p, x.runDir, { run: RUN, kind: 'task.result', by: executorOf(gate), body: wroteOf(gate, 1) })
  const v = await verifyAs(x, gate, 1, criticOf(gate))
  if (!v.green) throw new Error(`the harness's ${gate} verify isn't green: ${v.output_tail}`)
  await appendRecord(x.w.p, x.runDir, { run: RUN, kind: 'verdict', by: criticOf(gate), body: verdictOf(v.verify_id, { approve: true }) })
  const ctx: RecordCtx = { p: x.w.p, caller: { agentId: 'relay-1', agentType: 'litter:relay' }, litterDir: x.w.litterDir, options: normalizeOptions({}) }
  const r = (await landGate(ctx, factsOf(x), gate, v.verify_id, { observe: false })) as LandReply
  if (!r.ok || !r.landed) throw new Error(`the harness's land of ${gate} was refused: ${JSON.stringify(r)}`)
  return { gate, verifyId: v.verify_id, commit: r.commit, tree: v.tree_after }
}

/**
 * The execute run, generation 1 ended as `o.halt` says (plan_gap by default),
 * under `repair: auto` with 3 rounds and 6 agents, maxAttempts 3.
 */
export async function executeRun(w: World, o: ExecOpts = {}): Promise<Exec> {
  const halt = o.halt ?? 'plan_gap'
  const base = (await w.git('rev-parse', 'HEAD')).trim()
  await w.git('switch', '-q', '-c', BRANCH)
  const runDir = runDirOf(w.litterDir, RUN)
  await w.p.fs.write(planPath(runDir), PLAN_TEXT)
  const gates = ['G1', 'G2', 'G3'].map((id, i) => ({
    id,
    title: TITLES[id]!,
    lines: { start: 3 + i * 4, end: 5 + i * 4 },
    files: [`g${i + 1}.txt`],
    adversary: (o.adversary === 'gate' && id === 'G3') || (o.adversary === 'landed' && id === 'G1'),
    rules: [],
  }))
  const json: RunJson = {
    v: 1,
    run: RUN,
    workflow: 'execute',
    args: {
      verifyCommand: "sh -c 'test ! -e .claude/red'",
      rules: [],
      planPath: planPath(runDir),
      gates,
      maxAttempts: o.maxAttempts ?? 3,
      adversary: o.adversary === 'run',
      adversaryClamp: [],
      ...(o.goal ? { goalCheck: true, goalCheckCommand: "sh -c 'test ! -e .claude/goal-red'" } : {}),
      ...(o.amend ? { amendOf: { run: '20261002-orig', gate: 'G2' } } : {}),
    },
    authorized: ['commit on litter branches'],
    mode: 'default',
    verify: VERIFY,
    goalCheck: o.goal ? GOAL : null,
    setup: null,
    linkDirs: [],
    base,
    ref: REF,
    checkout: w.dir,
    isolate: false,
    previousBranch: 'main',
    continueOf: null,
    amendOf: o.amend ? { run: '20261002-orig', gate: 'G2' } : null,
    rules: [],
    planPath: 'plan.md',
    planSha256: await sha256(PLAN_TEXT),
    session: 'sess-a',
    created: 1,
    ...(o.noRepair ? {} : { repair: { mode: o.mode ?? 'auto', rounds: o.rounds ?? 3, agents: o.agents ?? 6 } }),
    ...(o.widen ? { widen: o.widen } : {}),
  }
  const text = `${JSON.stringify(json, null, 2)}\n`
  await w.p.fs.write(runJsonPath(runDir), text)
  const add = (kind: string, body: unknown, by: Author = MOD) => appendRecord(w.p, runDir, { run: RUN, kind, by, body })
  await add('run.start', {
    workflow: 'execute',
    base,
    ref: REF,
    checkout: w.dir,
    isolate: false,
    previousBranch: 'main',
    verify: VERIFY,
    goalCheck: json.goalCheck,
    setup: null,
    authorized: json.authorized,
    mode: 'default',
    continueOf: null,
    amendOf: json.amendOf,
    planSha256: json.planSha256,
    argsSha256: 'a'.repeat(64),
    runJsonSha256: await sha256(text),
    oid: '1'.repeat(40),
    session: 'sess-a',
    ...(json.repair ? { repair: json.repair } : {}),
  })
  await add('run.launch', { taskId: 'task-1', runId: 'wf_exec1', scriptPath: null, generation: 1, session: 'sess-a', oid: '1'.repeat(40) })
  const x = { w, runDir, json }

  // G1, landed. Its green verify of T1 is the baseline the bridge finds (decision 9), unless it ran another argv.
  let g1: Landed
  if (o.staleBaseline) {
    write(w.dir, 'g1.txt', 'G1 done\n')
    const v = await standInVerify(w.p, { run: RUN, runDir, json: { ...json, verify: ['true'] } }, { gate: 'G1', attempt: 1, where: w.dir, by: criticOf('G1'), timeoutMs: 60_000 })
    if (!v.ok) throw new Error(v.error)
    await add('verdict', verdictOf(v.body.verify_id, { approve: true }), criticOf('G1'))
    const ctx: RecordCtx = { p: w.p, caller: { agentId: 'relay-1', agentType: 'litter:relay' }, litterDir: w.litterDir, options: normalizeOptions({}) }
    const r = (await landGate(ctx, factsOf(x), 'G1', v.body.verify_id, { observe: false })) as LandReply
    if (!r.ok || !r.landed) throw new Error(`the stale G1 land was refused: ${JSON.stringify(r)}`)
    g1 = { gate: 'G1', verifyId: v.body.verify_id, commit: r.commit, tree: v.body.tree_after }
  } else g1 = await landed(x, 'G1', 'g1.txt')
  const lands = [g1]

  // G2's attempts, as the halt has them; the attempt stays in the tree, uncommitted.
  const g2: VerifyBody[] = []
  const critic = criticOf('G2')
  // Each attempt as execute.js leaves it: the executor's result (output.ts records it before the critic's verify), the verify, the verdict.
  const attempt = async (n: number, verdict: { approve?: boolean; gap?: string; clash?: string } | null): Promise<VerifyBody> => {
    write(w.dir, 'g2.txt', `G2 attempt ${n}\n`)
    await add('task.result', wroteOf('G2', n), executorOf('G2'))
    const v = await verifyAs(x, 'G2', n, critic)
    g2.push(v)
    if (verdict) await add('verdict', verdictOf(v.verify_id, verdict), critic)
    return v
  }
  let status: RunEndBody['status'] = 'halted'
  let reason = 'G2: halted'
  switch (halt) {
    case 'plan_gap':
      await attempt(1, { gap: GAP })
      reason = `G2: the critic names a plan gap: ${GAP}`
      break
    case 'executor_gap':
      // The executor stops before writing; its result is the only record of attempt 1 (a block writes no verdict).
      await add('task.result', wroteOf('G2', 1, { gap: GAP }), executorOf('G2'))
      reason = `G2 plan gap: ${GAP}`
      break
    case 'executor_gap_late':
      await attempt(1, {})
      await add('task.result', wroteOf('G2', 2, { gap: GAP }), executorOf('G2'))
      reason = `G2 plan gap: ${GAP}`
      break
    case 'rule_clash':
      await attempt(1, { clash: CLASH })
      reason = `G2 rule clash: ${CLASH}`
      break
    case 'executor_gap_then_clash': {
      // The executor's plan-gap stop, then a verify and a verdict naming a rule clash, with no result between:
      // only the verdict being the later event keeps the stale gap from bridging.
      await add('task.result', wroteOf('G2', 1, { gap: GAP }), executorOf('G2'))
      write(w.dir, 'g2.txt', 'G2 attempt 1\n')
      const v = await verifyAs(x, 'G2', 1, critic)
      g2.push(v)
      await add('verdict', verdictOf(v.verify_id, { clash: CLASH }), critic)
      reason = `G2 rule clash: ${CLASH}`
      break
    }
    case 'critic_null':
      // The executor's attempt 1 is done; its critic returned nothing, twice, so no verify and no verdict.
      write(w.dir, 'g2.txt', 'G2 attempt 1\n')
      await add('task.result', wroteOf('G2', 1), executorOf('G2'))
      reason = 'critic for G2 returned nothing'
      break
    case 'critic_null_verified':
      // Its critic recorded the verify of attempt 1, then ended without its verdict, twice.
      write(w.dir, 'g2.txt', 'G2 attempt 1\n')
      await add('task.result', wroteOf('G2', 1), executorOf('G2'))
      g2.push(await verifyAs(x, 'G2', 1, critic))
      reason = 'critic for G2 returned nothing'
      break
    case 'adversary_null':
      write(w.dir, 'g2.txt', 'G2 attempt 1\n')
      await add('task.result', wroteOf('G2', 1), executorOf('G2'))
      reason = "adversary for G2 returned nothing; the requested check didn't run"
      break
    case 'attempts':
      for (const n of [1, 2, 3]) await attempt(n, {})
      reason = 'G2: 3 attempts failed'
      break
    case 'recritique': {
      // Attempt 2 judged twice: its land was refused on a changed tree, and the critic judged it again.
      await attempt(1, {})
      await attempt(2, {})
      const again = await verifyAs(x, 'G2', 2, critic)
      g2.push(again)
      await add('verdict', verdictOf(again.verify_id, {}), critic)
      reason = 'G2: 3 attempts failed'
      break
    }
    case 'abandoned': {
      await attempt(1, {})
      await attempt(2, {})
      const v = await attempt(3, { approve: true })
      await add('land.intent', { gate: 'G2', verify_id: v.verify_id, tree: v.tree_after, old: g1.commit, ref: REF, mode: 'index' })
      await add('land.abandoned', { gate: 'G2', verify_id: v.verify_id, reason: 'git refused to move the index, so nothing moved: index.lock exists' })
      reason = 'G2: the land was refused: git refused to move the index'
      break
    }
    case 'retry_false':
      // A refusal with retry false records nothing in the ledger; the script halts with its reason.
      await attempt(1, { approve: true })
      reason = `G2: the land was refused: the checkout is on main, not ${BRANCH}`
      break
    case 'blocked': {
      // A block with an empty plan_gap (WP-AH): a rule clash, a denied tool or red checks, recorded as the executor returned it.
      const notes = o.blocked ?? 'it needs a database the plan never mentions'
      write(w.dir, 'g2.txt', 'G2 attempt 1\n')
      await add('task.result', wroteOf('G2', 1, { notes }), executorOf('G2'))
      reason = `G2: the executor is blocked: ${notes}`
      break
    }
    case 'null_agent':
      write(w.dir, 'g2.txt', 'G2 attempt 1\n')
      reason = 'G2: the executor returned nothing'
      break
    case 'budget':
      write(w.dir, 'g2.txt', 'G2 attempt 1\n')
      reason = 'the token budget ran out at G2'
      break
    case 'goal_red': {
      lands.push(await landed(x, 'G2', 'g2.txt'))
      lands.push(await landed(x, 'G3', 'g3.txt'))
      write(w.dir, '.claude/goal-red', 'red\n')
      const v = await verifyAs(x, 'goal', 1, { source: 'agent', agentId: 'relay-1', agentType: 'litter:relay' })
      if (v.green) throw new Error("the harness's goal check is green")
      reason = `the goal check ${v.verify_id} failed`
      break
    }
    case 'interrupted':
      await attempt(1, {})
      status = 'interrupted'
      reason = "agent type 'litter:executor' not found"
      break
    case 'stopped':
      await attempt(1, {})
      status = 'stopped'
      reason = 'stopped'
      break
  }
  await add('run.end', { taskId: 'task-1', generation: 1, status, reason, source: o.source ?? 'notification' } satisfies RunEndBody)
  return { w, runDir, base, json, name: `repair-${(await sha256(runDir)).slice(0, 6)}`, lands, g2 }
}

export const runRecords = async (x: Pick<Exec, 'w' | 'runDir'>): Promise<StoredRecord[]> => (await readLedger(x.w.p, x.runDir, RUN)).records

/** The run ledger's kinds after generation 1's run.end. */
export async function afterHalt(x: Pick<Exec, 'w' | 'runDir'>): Promise<string[]> {
  const rs = await runRecords(x)
  const end = rs.findIndex(r => r.kind === 'run.end')
  return rs.slice(end + 1).map(r => r.kind)
}

export async function declinedReason(x: Pick<Exec, 'w' | 'runDir'>): Promise<string | null> {
  const r = (await runRecords(x)).filter(rec => rec.kind === 'repair.declined').at(-1)
  return r ? String(r.body.reason) : null
}
