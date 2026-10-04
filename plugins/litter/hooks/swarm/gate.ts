// A repair swarm's mod-held gates (plan 15.10, 15.11; COMMON 2b-2, step 5): a
// bound node's verify, the critic's verdict and the land of the repaired
// tree, all recorded in the swarm's run's ledger and mirrored as `gate`
// events; and the repair budget at spawn.
//
// Owner: phase 2b-2, package Y. The dispatcher in ledger.ts calls
// swarmGateRecord; spawn.ts's spawn check calls budgetCounted, then
// budgetRefusal in the step that reserves.
//
// The run is always the swarm's (`LiveSwarm.run`), never one the call names,
// and every record goes into the generation its run.repair opened (decision
// 1). The mod runs the verify argv run.json stored, in the node's own
// directory; a verdict cites a verify its own agent recorded (decision 5); a
// round is one verdict on a distinct verify (decision 6).
//
// Phase 3 (AC; COMMON step 5): a swarm whose run is an execute run is its
// plan-template swarm, and its gates are the plan's. A verify names a plan
// gate with no land (or `goal`), numbered across the run (decision 15); the
// verdict is execute's VERDICT plus `gate` (decision 14); the land is
// execute's own (land.ts, landGate). A round is a rejecting verdict, and
// maxAttempts caps each gate's rejections in the generation (decision 1). The
// fanout paths stay as they were.

import type { Ports } from '../ports'
import type { LitterOptions } from '../options'
import type { Author, RecordCtx, RecordError, RecordInput, RecordReply, StoredRecord } from '../records/core'
import type { RunJson, RunRepairBody } from '../records/run'
import type { LandReply, SwarmGateVerdictBody, SwarmVerdictBody, SwarmVerdictTask, VerdictDimension, VerifyReply } from '../records/execute'
import type { GateRecordKind, GateResult, SwarmEventBody, SwarmNodeBody } from '../records/swarm'
import type { FanoutTask } from '../integrate'
import type { RunFacts, VerifyRan, VerifyRun } from '../verify'
import type { CriticProposal } from '../records/rules'
import type { BindingKind, LiveSwarm, NodeBinding, RunLink, SwarmNode } from './types'
import { fail } from '../records/core'
import { FANOUT_GATE } from '../records/fanout'
import { appendLaunchRecord, readLaunchLedger } from '../records/swarm'
import { appendRecord, readLedger } from '../ledgercore'
import { runDir as runDirOf } from '../layout'
import { serial } from '../fsx'
import { gateIds, howEnded, isGreen, isPlanGate, notGreen, planGates, readRunFacts, runVerify, verifyBody, verifyFields } from '../verify'
import { fanoutTasks, integrationWorktree } from '../integrate'
import { landGate, landRepaired, REPAIR_GATE, repairGeneration } from '../land'
import { nodeOf, swarmRefusal, writesFiles } from './admit'
import { proposeFromCritic } from '../rules/store'
import { writeVerdictFile } from '../verdicts'
import { realOf } from '../worktrees'
import * as state from './state'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The record kinds a bound swarm node's call routes here instead of to the run's handlers. */
export type SwarmGateKind = 'verify' | 'verdict' | 'land'
export const SWARM_GATE_KINDS: readonly SwarmGateKind[] = ['verify', 'verdict', 'land']

export const isSwarmGateKind = (kind: string): kind is SwarmGateKind => (SWARM_GATE_KINDS as readonly string[]).includes(kind)

/**
 * A bound node's gate call, as the record tool's dispatcher hands it over
 * (ledger.ts, dispatchRecord): the kind matched, the spool drained, the
 * caller's binding found after the state's gate opened, the input decoded and
 * within the record bound. The caller is never a run agent (one whose agent
 * map entry has a role and a run): those are routed as before.
 *
 * `input.run` is whatever the node sent, if anything. The run is its swarm's
 * (`LiveSwarm.run`), never the input's, so the gate refuses or ignores it.
 */
export type SwarmGateCall = {
  kind: SwarmGateKind
  input: RecordInput
  /** The calling agent, with its type from the agent map (null when the map has none). */
  caller: { agentId: string; agentType: string | null }
  binding: NodeBinding
  litterDir: string
  options: LitterOptions
}

// ---------------------------------------------------------------------------
// The verify runner (verify.ts), AD's proposals (rules/store.ts, phase 3) and
// AB's verdict files (verdicts.ts), through a seam the specs stand in for.

export const deps: {
  runVerify: (p: Ports, f: RunFacts, o: VerifyRun) => Promise<VerifyRan | RecordError>
  proposeFromCritic: (p: Ports, litterDir: string, input: CriticProposal) => Promise<void>
  writeVerdictFile: (p: Ports, runDir: string, rec: StoredRecord) => Promise<void>
} = {
  runVerify: (...a) => runVerify(...a),
  proposeFromCritic: (...a) => proposeFromCritic(...a),
  writeVerdictFile: (...a) => writeVerdictFile(...a),
}

// ---------------------------------------------------------------------------
// The caller

/** The budget case's ending for a refusal a node reads (15.11, "It asks you only when it can't proceed itself"). */
const ASK_FOR_BUDGET = 'report blocked to your parent, saying what more you need and for what; the lead can ask the user for it with repair.budget'

/** A rule.propose's limit (records/design.ts): a rule goes into prompts. */
const RULE_MAX_BYTES = 8 * 1024
const bytes = (text: string): number => new TextEncoder().encode(text).length
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** A caller the gate accepts, with its swarm's run as the ledger has it now. */
type Gated = {
  s: LiveSwarm
  link: RunLink
  b: NodeBinding
  node: SwarmNode
  f: RunFacts
  records: StoredRecord[]
  /** The run.repair that opened the swarm's generation. */
  gen: StoredRecord<RunRepairBody>
  /** The record's author: the node's agent, with its type. */
  by: Author
}

const tamperedText = (run: string, t: { seq: number; reason: string }): string =>
  `litter: run ${run}'s ledger is tampered at record ${t.seq} (${t.reason}); nothing more is recorded for it`

/**
 * The caller: a bound node (not a child) of a live repair swarm this session
 * runs, with its type, in the swarm's current revision, whose run's open
 * generation is the swarm's.
 */
async function gated(p: Ports, call: SwarmGateCall): Promise<Gated | RecordError> {
  const { kind, binding: b, input } = call
  if (b.kind === 'child') {
    return fail(`litter: an agent a node started records no ${kind}; its node ${b.node} records the swarm's ${kind}s, so report to it`, 'kind')
  }
  const s = state.liveSwarm(b.swarm)
  const off = swarmRefusal(s, b.swarm, false)
  if (off !== null || !s) return fail(`litter: ${off ?? `swarm ${b.swarm} isn't live`}, so it records no ${kind}`, 'kind')
  const link = s.run
  if (!link) {
    return fail(`litter: swarm ${s.name} repairs no run, so its nodes record no ${kind}: only a repair swarm a run starts verifies, judges or lands`, 'kind')
  }
  if (b.launch !== s.launch) return fail(`litter: you were bound in launch ${b.launch} of swarm ${s.name}, not its live launch ${s.launch}; end your turn`, 'kind')
  if (call.caller.agentType !== null && call.caller.agentType !== b.type) {
    return fail(`litter: this node lost its type (${call.caller.agentType}, not ${b.type}); end your turn`, 'kind')
  }
  const node = nodeOf(s, b.node)
  if (!node) return fail(`litter: ${b.node} isn't in swarm ${s.name}'s revision ${s.revision}, so it records nothing; report to your parent`, 'kind')
  if (input.run !== undefined && input.run !== link.run) return fail(`litter: 'run' is your swarm's run, ${link.run}; leave it out`, 'run', [link.run])
  // The link is the mod's own (X's bridge); a runDir outside this litter directory is a bug, never a path to act on.
  if (link.runDir !== runDirOf(call.litterDir, link.run)) throw new Error(`swarm ${s.name}'s run link names ${link.runDir}, not run ${link.run}'s folder`)
  const f = await readRunFacts(p, link.runDir, link.run)
  if ('ok' in f) return f
  const ledger = await readLedger(p, link.runDir, link.run)
  if (ledger.tampered) return fail(tamperedText(link.run, ledger.tampered), 'run')
  const gen = repairGeneration(ledger.records, link)
  if (!gen.ok) return fail(`litter: run ${link.run} ${gen.why}, so swarm ${s.name} records no ${kind} for it; report to your parent`, 'run')
  const by: Author = { source: 'agent', agentId: call.caller.agentId, agentType: call.caller.agentType ?? b.type }
  noteWorkflow(s, f.json.workflow)
  return { s, link, b, node, f, records: ledger.records, gen: gen.rec, by }
}

/**
 * Each repair swarm launch's run workflow, as its gates and its recount read
 * it: budgetRefusal is synchronous, so it can't read run.json, and an execute
 * swarm's budget is in rejected attempts.
 */
const workflows = new Map<string, string>()
const launchKey = (s: Pick<LiveSwarm, 'name' | 'launch'>): string => `${s.name}\u0000${s.launch}`
const noteWorkflow = (s: Pick<LiveSwarm, 'name' | 'launch'>, workflow: unknown): void => {
  if (typeof workflow === 'string') workflows.set(launchKey(s), workflow)
}
const isPlanSwarm = (s: Pick<LiveSwarm, 'name' | 'launch'>): boolean => workflows.get(launchKey(s)) === 'execute'

/**
 * Mirrors a run-ledger gate record into the launch ledger, for the browser
 * and End (decision 1), as the caller's unless `who` names the record's own
 * node and agent. A failure is logged: the run's record stands.
 */
async function mirror(
  p: Ports,
  litterDir: string,
  g: Pick<Gated, 's' | 'b' | 'link'>,
  fields: { record: GateRecordKind; seq: number; gate: string; result: GateResult; verify_id: string; round?: number },
  who: { node: string; agentId: string } = { node: g.b.node, agentId: g.b.agentId },
): Promise<void> {
  const body: SwarmEventBody = { kind: 'gate', node: who.node, agentId: who.agentId, run: g.link.run, ...fields }
  try {
    await appendLaunchRecord(p, litterDir, g.s.name, g.s.launch, 'swarm.event', body)
  } catch (err) {
    p.log(`swarm ${g.s.name}: the gate event for ${fields.record} ${fields.verify_id} wasn't recorded: ${errText(err)}`)
  }
}

/** The run-ledger seqs of the `record` records the launch ledger's gate events already mirror for this run. */
async function mirroredSeqs(p: Ports, litterDir: string, g: Pick<Gated, 's' | 'link'>, record: GateRecordKind): Promise<Set<number>> {
  const launch = await readLaunchLedger(p, litterDir, g.s.name, g.s.launch)
  const out = new Set<number>()
  for (const r of launch.records) {
    const b = r.body as Partial<SwarmEventBody> & { record?: unknown; run?: unknown; seq?: unknown }
    if (r.kind === 'swarm.event' && b.kind === 'gate' && b.record === record && b.run === g.link.run && typeof b.seq === 'number') out.add(b.seq)
  }
  return out
}

/**
 * Answers a bound node's `verify`, `verdict` or `land` in the dispatcher's
 * result shape: a refusal names the field and the fix ("Errors are
 * recoverable"); a failure that isn't the node's throws, so the record tool's
 * catch denies the call.
 */
export async function swarmGateRecord(p: Ports, call: SwarmGateCall): Promise<RecordReply> {
  const g = await gated(p, call)
  if ('error' in g) return g
  if (g.f.json.workflow === 'execute') {
    if (call.kind === 'verify') return planVerify(p, call, g)
    if (call.kind === 'verdict') return planVerdict(p, call, g)
    return planLand(p, call, g)
  }
  if (call.kind === 'verify') return gateVerify(p, call, g)
  if (call.kind === 'verdict') return gateVerdict(p, call, g)
  return gateLand(p, call, g)
}

// ---------------------------------------------------------------------------
// verify

/** The run's own verify argv, in the node's own directory, gate `repair`, recorded as the node's (15.10's table). */
async function gateVerify(p: Ports, call: SwarmGateCall, g: Gated): Promise<RecordReply> {
  if (g.node.authority?.verify !== true) {
    return fail(`litter: ${g.b.node} has no verify authority (authority.verify), so litter runs no verify for it; ask a node that has it, or report to your parent`, 'kind')
  }
  const gate = call.input.gate
  if (gate !== undefined && gate !== REPAIR_GATE) {
    return fail(`litter: a swarm node's verify is gate '${REPAIR_GATE}', run in your own directory; leave 'gate' out`, 'gate', [REPAIR_GATE])
  }
  // Numbered by the mod, within the generation: the call's `attempt` is ignored.
  const attempt = g.records.filter(r => r.seq > g.gen.seq && verifyBody(r)?.gate === REPAIR_GATE).length + 1
  const ran = await deps.runVerify(p, g.f, { gate: REPAIR_GATE, attempt, where: g.b.cwd, by: g.by, timeoutMs: call.options.verifyTimeoutMs })
  if (!ran.ok) return ran
  const v = ran.body
  await mirror(p, call.litterDir, g, { record: 'verify', seq: ran.seq, gate: REPAIR_GATE, result: v.green ? 'green' : 'red', verify_id: v.verify_id })
  const reply: VerifyReply = {
    ok: true,
    verify_id: v.verify_id,
    exit_code: v.exit_code,
    signal: v.signal,
    timed_out: v.timed_out,
    green: v.green,
    tree: v.tree_before,
    tree_changed: v.tree_before !== v.tree_after,
    dirty_submodules: v.dirty_submodules,
    spawn_error: v.spawn_error,
    log: ran.log,
    output_tail: v.output_tail,
  }
  return reply
}

// ---------------------------------------------------------------------------
// verdict

type VerdictIn = { verify_id: string; tasks: SwarmVerdictTask[]; combined: string; proposed_rules: string[] }

/** The verdict's fields, each refused on its own: every task of the run judged exactly once (as FANOUT_CHECK). */
function parseVerdict(input: RecordInput, runTasks: readonly FanoutTask[]): VerdictIn | RecordError {
  const verifyId = input.verify_id
  if (typeof verifyId !== 'string' || verifyId.trim() === '') {
    return fail("litter: 'verify_id' is required: the verify_id of your own verify of the tree you judge", 'verify_id')
  }
  const ids = runTasks.map(t => t.id)
  if (!Array.isArray(input.tasks)) return fail("litter: 'tasks' is required: one { id, pass, evidence, gaps } for each task of the run", 'tasks', ids)
  const tasks: SwarmVerdictTask[] = []
  for (const [i, t] of input.tasks.entries()) {
    const at = `tasks[${i}]`
    if (!isObj(t)) return fail(`litter: '${at}' must be an object { id, pass, evidence, gaps }`, at)
    if (typeof t.id !== 'string' || t.id === '') return fail(`litter: '${at}.id' must be a task id of the run`, `${at}.id`, ids)
    if (typeof t.pass !== 'boolean') return fail(`litter: '${at}.pass' must be true or false`, `${at}.pass`)
    if (typeof t.evidence !== 'string' || t.evidence.trim() === '') {
      return fail(`litter: '${at}.evidence' is required: what you read or ran that shows it`, `${at}.evidence`)
    }
    const gaps = t.gaps ?? []
    if (!Array.isArray(gaps) || !gaps.every(x => typeof x === 'string')) {
      return fail(`litter: '${at}.gaps' must be a list of strings, [] when it passes`, `${at}.gaps`)
    }
    tasks.push({ id: t.id, pass: t.pass, evidence: t.evidence, gaps: [...gaps] })
  }
  const got = tasks.map(t => t.id)
  const missing = ids.filter(id => !got.includes(id))
  const repeated = [...new Set(got.filter((id, i) => got.indexOf(id) !== i))]
  const unknown = [...new Set(got.filter(id => !ids.includes(id)))]
  if (missing.length + repeated.length + unknown.length > 0) {
    const parts = [
      missing.length > 0 ? `missing ${missing.join(', ')}` : '',
      repeated.length > 0 ? `repeated ${repeated.join(', ')}` : '',
      unknown.length > 0 ? `not a task of the run ${unknown.join(', ')}` : '',
    ].filter(x => x !== '')
    return fail(`litter: 'tasks' must judge every task of the run exactly once: ${parts.join('; ')}`, 'tasks', ids)
  }
  if (typeof input.combined !== 'string' || input.combined.trim() === '') {
    return fail("litter: 'combined' is required: whether the tasks work together, against the run's contract", 'combined')
  }
  const rules = input.proposed_rules ?? []
  if (!Array.isArray(rules)) return fail("litter: 'proposed_rules' must be a list of rules as a person could accept them, or left out", 'proposed_rules')
  for (const [i, r] of rules.entries()) {
    if (typeof r !== 'string' || r.trim() === '') return fail(`litter: 'proposed_rules[${i}]' must be a rule's text`, `proposed_rules[${i}]`)
    if (bytes(r) > RULE_MAX_BYTES) return fail(`litter: 'proposed_rules[${i}]' is over ${RULE_MAX_BYTES} bytes; a rule goes into prompts, so cut it down`, `proposed_rules[${i}]`)
  }
  return { verify_id: verifyId, tasks, combined: input.combined, proposed_rules: rules as string[] }
}

/** The swarm's rounds as the generation's verdicts number them: a mirror that was lost or behind is caught up, in order. */
function syncRounds(swarm: string, records: readonly StoredRecord[], since: number): void {
  for (const r of records) {
    if (r.seq <= since || r.kind !== 'verdict' || typeof r.body.verify_id !== 'string' || typeof r.body.round !== 'number') continue
    state.noteRound(swarm, r.body.verify_id)
  }
}

/**
 * The generation's verdicts no gate event mirrors yet (an earlier process's
 * whose mirror failed), each as its own agent's: End and the swarm's summary
 * count the rounds by these events, so each round syncRounds numbers has one.
 * A plan-template verdict names its gate, and its approval has no round
 * (decision 1); it's caught up too, with no round.
 */
async function catchUpVerdicts(p: Ports, litterDir: string, g: Gated, records: readonly StoredRecord[], since: number): Promise<void> {
  const verdicts = records.filter(
    r => r.seq > since && r.kind === 'verdict' && typeof r.body.verify_id === 'string' && (typeof r.body.round === 'number' || typeof r.body.gate === 'string'),
  )
  if (verdicts.length === 0) return
  let mirrored: Set<number>
  try {
    mirrored = await mirroredSeqs(p, litterDir, g, 'verdict')
  } catch (err) {
    p.log(`swarm ${g.s.name}: the verdicts of run ${g.link.run} couldn't be checked against the gate events: ${errText(err)}`)
    return
  }
  for (const r of verdicts) {
    if (mirrored.has(r.seq)) continue
    const verifyId = r.body.verify_id as string
    const agentId = r.by.source === 'agent' ? r.by.agentId : g.b.agentId
    const type = r.by.source === 'agent' ? r.by.agentType : null
    const node = state.binding(agentId)?.node ?? Object.entries(g.s.types).find(([, t]) => t === type)?.[0] ?? g.b.node
    const cited = records.find(x => verifyBody(x)?.verify_id === verifyId)
    const gate = typeof r.body.gate === 'string' ? r.body.gate : ((cited ? verifyBody(cited)?.gate : undefined) ?? REPAIR_GATE)
    const result: GateResult = r.body.approved === true ? 'approved' : 'rejected'
    const round = typeof r.body.round === 'number' ? { round: r.body.round } : {}
    await mirror(p, litterDir, g, { record: 'verdict', seq: r.seq, gate, result, verify_id: verifyId, ...round }, { node, agentId })
  }
}

/** The critic's veto (15.10's table): from a `verdicts: true` node that writes nothing, judging its own verify of the integration worktree. */
async function gateVerdict(p: Ports, call: SwarmGateCall, g: Gated): Promise<RecordReply> {
  const { b, node } = g
  if (node.verdicts !== true) {
    return fail(`litter: only a node whose type has verdicts: true records a verdict, and ${b.node}'s hasn't; the critic judges, so report to your parent`, 'kind')
  }
  if (writesFiles(node)) return fail(`litter: ${b.node} may write, so a verdict from it could judge its own change; a verdicts node writes nothing`, 'kind')
  const input = parseVerdict(call.input, fanoutTasks(g.f.json))
  if ('error' in input) return input
  const wt = integrationWorktree(g.records, g.link.run)
  if (!wt) return fail(`litter: run ${g.link.run} has no integration worktree recorded, so there's no repaired tree to judge`, 'kind')
  if (b.cwd !== wt.path) {
    return fail(`litter: your directory ${b.cwd} isn't the integration worktree ${wt.path} the repair commits in, so a verify there judges another tree; report to your parent`, 'kind')
  }
  // One verdict at a time per run: a round is numbered and its cap checked against the ledger as it is.
  return serial(`gate.verdict:${g.link.runDir}`, () => judged(p, call, g, input))
}

async function judged(p: Ports, call: SwarmGateCall, g: Gated, input: VerdictIn): Promise<RecordReply> {
  const { s, b, link } = g
  const ledger = await readLedger(p, link.runDir, link.run)
  if (ledger.tampered) return fail(tamperedText(link.run, ledger.tampered), 'run')
  const records = ledger.records
  const gen = repairGeneration(records, link)
  if (!gen.ok) return fail(`litter: run ${link.run} ${gen.why}, so swarm ${s.name} records no verdict for it; report to your parent`, 'run')
  const since = gen.rec.seq
  const id = input.verify_id

  // What it cites: a verify of this generation, the gate's, recorded by the verdict's own agent (decision 5).
  const vRec = records.find(r => verifyBody(r)?.verify_id === id)
  const v = vRec ? verifyBody(vRec) : null
  if (!vRec || !v) return fail(`litter: run ${link.run} has no verify ${id}; record your own verify of the tree (kind verify), then cite its verify_id`, 'verify_id')
  if (vRec.seq < since) {
    return fail(`litter: verify ${id} is from before this repair (generation ${link.generation}); verify the tree as it is now, and cite that`, 'verify_id')
  }
  if (vRec.by.source !== 'agent' || vRec.by.agentId !== b.agentId) {
    return fail(`litter: verify ${id} wasn't recorded by you; a verdict cites a verify its own agent recorded, so record your own verify of the tree and cite it`, 'verify_id')
  }
  if (v.gate !== REPAIR_GATE) return fail(`litter: verify ${id} is for gate ${v.gate}, not a repair verify; record your own verify (kind verify) and cite it`, 'verify_id')
  if (!v.green && input.tasks.every(t => t.pass)) {
    return fail(`litter: verify ${id} isn't green, so a verdict passing every task on it can't land; fail what the verify shows, or verify again once it's fixed`, 'tasks')
  }
  const earlier = records.find(r => r.seq > since && r.kind === 'verdict' && r.body.verify_id === id)
  if (earlier) {
    return fail(`litter: verify ${id} already has a verdict (round ${String(earlier.body.round)}); verify the tree as it is now, and judge that`, 'verify_id')
  }

  // The round (decision 6): numbered by the mod, one past the budget refused. The budget is read live: repair.budget raises it.
  syncRounds(s.name, records, since)
  await catchUpVerdicts(p, call.litterDir, g, records, since)
  const budget = state.liveSwarm(s.name)?.budget
  if (!budget) return fail(`litter: swarm ${s.name} has no repair budget, so it records no verdict`, 'kind')
  const round = state.roundsUsed(s.name) + 1
  if (round > budget.rounds) {
    return fail(`litter: repair swarm ${s.name} has used all ${budget.rounds} of its repair rounds (each verdict on a new verify is one), so this verdict isn't recorded; ${ASK_FOR_BUDGET}`, 'kind')
  }

  const approved = input.tasks.every(t => t.pass)
  const body: SwarmVerdictBody = { verify_id: id, tasks: input.tasks, combined: input.combined, proposed_rules: input.proposed_rules, round, approved }
  const rec = await appendRecord(p, link.runDir, { run: link.run, kind: 'verdict', by: g.by, body })
  state.noteRound(s.name, id)
  // Proposals stay proposals (decision 14): each one to the rules ledger through AD's store, labelled as the critic's.
  let proposed = 0
  for (const [index, rule] of input.proposed_rules.entries()) {
    try {
      await deps.proposeFromCritic(p, call.litterDir, { run: link.run, rule, source: 'critic', by: g.by, index, swarm: s.name, verify_id: id, round })
      proposed++
    } catch (err) {
      p.log(`swarm ${s.name}: a proposed rule from the verdict on ${id} wasn't recorded: ${errText(err)}`)
    }
  }
  await mirror(p, call.litterDir, g, { record: 'verdict', seq: rec.seq, gate: v.gate, result: approved ? 'approved' : 'rejected', verify_id: id, round })
  return { ok: true, kind: 'verdict', run: link.run, seq: rec.seq, verify_id: id, round, approved, rounds_left: budget.rounds - round, proposed_rules: proposed }
}

// ---------------------------------------------------------------------------
// land

/**
 * The repaired tree's land (land.ts, landRepaired), once the budget is
 * counted (a count that fails lands nothing), then each land record of
 * the generation for this verify that no gate event mirrors yet: the ones
 * this land made, and one an earlier reconcile made (a crash's land recovered
 * at session.start). Z's End reads the `landed` event to end done.
 */
async function gateLand(p: Ports, call: SwarmGateCall, g: Gated): Promise<RecordReply> {
  if (g.node.authority?.land !== true) {
    return fail(`litter: ${g.b.node} has no land authority (authority.land), so it lands nothing; report the approved verify to your parent`, 'kind')
  }
  const verifyId = call.input.verify_id
  if (typeof verifyId !== 'string' || verifyId.trim() === '') {
    return fail("litter: 'verify_id' is required: the verify the critic's approving verdict cites", 'verify_id')
  }
  const gate = call.input.gate
  if (gate !== undefined && gate !== FANOUT_GATE) {
    return fail(`litter: a repair swarm lands its run's integration, gate '${FANOUT_GATE}'; leave 'gate' out`, 'gate', [FANOUT_GATE])
  }
  // The spawns first, caught up from the launch's swarm.node records, as planLand does: landRepaired's budget
  // check reads the count, and a land after a reload may come before any spawn's recount. A land already
  // made for this verify answers as it did (landRepaired), so it isn't counted again.
  if (!g.records.some(r => r.kind === 'land' && r.body.verify_id === verifyId)) {
    try {
      await budgetCounted(p, call.litterDir, g.s.name)
    } catch (err) {
      return notLanded(`swarm ${g.s.name}'s repair budget couldn't be counted, so nothing lands: ${errText(err)}`)
    }
  }
  const ctx: RecordCtx = { p, caller: { agentId: call.caller.agentId, agentType: g.by.source === 'agent' ? g.by.agentType : null }, litterDir: call.litterDir, options: call.options }
  const reply = await landRepaired(ctx, g.f, { verifyId, swarm: g.s.name, agentId: g.b.agentId })
  try {
    const mirrored = await mirroredSeqs(p, call.litterDir, g, 'land')
    const after = await readLedger(p, g.link.runDir, g.link.run)
    for (const r of after.records) {
      if (r.seq <= g.gen.seq || r.body.verify_id !== verifyId || mirrored.has(r.seq)) continue
      const result: GateResult | null = r.kind === 'land' ? 'landed' : r.kind === 'land.abandoned' || r.kind === 'land.blocked' ? 'not-landed' : null
      if (result) await mirror(p, call.litterDir, g, { record: 'land', seq: r.seq, gate: FANOUT_GATE, result, verify_id: verifyId })
    }
  } catch (err) {
    // The land stands in the run's ledger, End's fallback; only the browser's copy is behind.
    p.log(`swarm ${g.s.name}: the land of ${verifyId} wasn't mirrored: ${errText(err)}`)
  }
  return reply
}

// ---------------------------------------------------------------------------
// The budget at spawn (15.11, "The repair budget"; decision 7)

/**
 * The spawn check's budget refusal for a repair swarm (15.11): the text the
 * spawning node reads, telling it to report blocked to its parent with what
 * it needs; null when the spawn is within the budget, or the swarm has none
 * (no `LiveSwarm.budget`), or `kind` is an orchestrator's (decision 7). It
 * reads the state only, never awaits, so the spawn check can call it in the
 * step that reserves.
 *
 * Once the rounds are used up, every worker and child spawn is refused,
 * whatever the last verdict said: no further verdict can be recorded then, so
 * a spawn could only serve a land, which needs none. A plan-template swarm's
 * rounds are its rejected attempts (phase 3, decision 1), and its text says
 * so; its workers are reused across gates, so a spawn past them asks too.
 */
export function budgetRefusal(swarm: string, kind: BindingKind): string | null {
  if (kind === 'orchestrator') return null
  const s = state.liveSwarm(swarm)
  const b = s?.budget
  if (!s || !b) return null
  const plan = isPlanSwarm(s)
  const rounds = state.roundsUsed(swarm)
  if (rounds >= b.rounds) {
    return plan
      ? `plan-template swarm ${swarm} has used all ${b.rounds} of the rejected attempts its budget allows (${rounds} rejecting verdicts), so it starts no more agents; ${ASK_FOR_BUDGET}`
      : `repair swarm ${swarm} has used all ${b.rounds} of its repair rounds (${rounds} verdicts on distinct verifies), so it starts no more agents; ${ASK_FOR_BUDGET}`
  }
  const used = state.spawnsUsed(swarm)
  if (used >= b.agents) {
    return `${plan ? 'plan-template' : 'repair'} swarm ${swarm} has started all ${b.agents} agents its repair budget allows (the workers and agents its nodes start), so it starts no more; ${ASK_FOR_BUDGET}`
  }
  return null
}

/** Whether a spawn of `kind` counts against the swarm's agents (decision 7): a repair swarm's workers and children. */
export const countsAgainstBudget = (s: LiveSwarm, kind: BindingKind): boolean => s.budget !== undefined && kind !== 'orchestrator'

/** The `<instance>` block's budget figures for a repair swarm, after this spawn's own count; null for any other. */
export function budgetLeft(s: LiveSwarm): { roundsLeft: number; rounds: number; agentsLeft: number; agents: number } | null {
  const b = s.budget
  if (!b) return null
  return {
    roundsLeft: Math.max(0, b.rounds - state.roundsUsed(s.name)),
    rounds: b.rounds,
    agentsLeft: Math.max(0, b.agents - state.spawnsUsed(s.name)),
    agents: b.agents,
  }
}

/**
 * Raises the swarm's spawn count to the launch's non-adopted worker and child
 * swarm.node records, each agent once; never lowers it. $.store's mirror keys
 * the count by reservation, which the ledger doesn't record for a child, so
 * the two can't be matched one to one: a mirror that came back whole already
 * holds at least as many; a lost or older one is caught up here.
 */
export function recountSpawns(swarm: string, nodes: readonly SwarmNodeBody[]): void {
  const agents = [...new Set(nodes.filter(n => n.kind !== 'orchestrator' && n.adopted !== true).map(n => n.agentId))]
  for (const id of agents) {
    if (state.spawnsUsed(swarm) >= agents.length) return
    state.noteSpawned(swarm, `node:${id}`)
  }
}

/** The recount per launch, once per process: every spawn check of the launch awaits the same one. */
const counted = new Map<string, Promise<void>>()

/**
 * Before a repair swarm's spawn check reserves: once per launch in this
 * process (a reload's fresh module counts again), its spawns and rounds are
 * caught up from the ledgers, the launch's swarm.node records and the run's
 * verdicts of the generation, so recovery with a lost or older mirror can't
 * hand back budget that was used. A failure is the caller's to deny with, and
 * the next spawn tries again.
 */
export async function budgetCounted(p: Ports, litterDir: string, swarm: string): Promise<void> {
  const s = state.liveSwarm(swarm)
  if (!s?.budget || !s.run) return
  const key = `${swarm}\u0000${s.launch}`
  let done = counted.get(key)
  if (!done) {
    done = recount(p, litterDir, s, s.run).catch((err: unknown) => {
      counted.delete(key)
      throw err
    })
    counted.set(key, done)
  }
  await done
}

async function recount(p: Ports, litterDir: string, s: LiveSwarm, link: RunLink): Promise<void> {
  const launch = await readLaunchLedger(p, litterDir, s.name, s.launch)
  if (launch.tampered) throw new Error(`launch ${s.launch}'s ledger is tampered at record ${launch.tampered.seq} (${launch.tampered.reason})`)
  recountSpawns(
    s.name,
    launch.records.filter(r => r.kind === 'swarm.node').map(r => r.body as unknown as SwarmNodeBody),
  )
  const run = await readLedger(p, link.runDir, link.run)
  if (run.tampered) throw new Error(tamperedText(link.run, run.tampered).replace(/^litter: /, ''))
  noteWorkflow(s, run.records.find(r => r.kind === 'run.start')?.body.workflow)
  const gen = repairGeneration(run.records, link)
  if (gen.ok) syncRounds(s.name, run.records, gen.rec.seq)
}

/** A fresh module's memory, for tests (with state.ts's resetForTests). A spec that sets `deps` puts it back itself. */
export function resetGateForTests(): void {
  counted.clear()
  workflows.clear()
  issued.clear()
}

// ---------------------------------------------------------------------------
// The plan template's gates (phase 3, AC; COMMON step 5), for a swarm whose run is an execute run

/** The run's maxAttempts as execute.js reads it (`args.maxAttempts ?? 3`). */
const maxAttemptsOf = (json: RunJson): number => {
  const m = json.args.maxAttempts
  return typeof m === 'number' && Number.isSafeInteger(m) && m > 0 ? m : 3
}

/** The plan gates with a land in the run's ledger, gate → commit. */
function landed(records: readonly StoredRecord[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of records) {
    if (r.kind === 'land' && typeof r.body.gate === 'string' && typeof r.body.commit === 'string' && !out.has(r.body.gate)) out.set(r.body.gate, r.body.commit)
  }
  return out
}

/** The plan's gates with no land yet, in order: what a verify, a verdict or a land may name. */
const unlanded = (json: RunJson, records: readonly StoredRecord[]): string[] => {
  const done = landed(records)
  return (planGates(json) ?? []).map(g => g.id).filter(id => !done.has(id))
}

/** The goal check is the run's (execute.js's `args.goalCheck`). */
const hasGoal = (json: RunJson): boolean => json.args.goalCheck === true

/** This generation's rejecting verdicts on a gate (decision 1: maxAttempts counts them fresh in each generation). */
const rejections = (records: readonly StoredRecord[], since: number, gate: string): number =>
  records.filter(r => r.seq > since && r.kind === 'verdict' && r.body.gate === gate && r.body.approved === false).length

/** The per-gate cap (15.10's table, "Attempts are capped"): past it, the gate's verify and land are refused, and the runner reports up. */
function capped(json: RunJson, records: readonly StoredRecord[], since: number, gate: string): string | null {
  const max = maxAttemptsOf(json)
  const n = rejections(records, since, gate)
  return n >= max
    ? `litter: report up: gate ${gate} has used its attempts (${n} rejected in this repair, of the run's ${max}); keep its attempt in the tree, and report blocked to your parent with what the gate needs`
    : null
}

/** The node works in the run's checkout, where the gates land (decision 10). */
async function inCheckout(p: Ports, g: Gated): Promise<boolean> {
  const co = g.f.json.checkout
  return g.b.cwd === co || g.b.cwd === (await realOf(p, co))
}

const notInCheckout = (g: Gated): RecordError =>
  fail(`litter: your directory ${g.b.cwd} isn't the run's checkout ${g.f.json.checkout}, where its gates land, so a verify or verdict there is of another tree; report to your parent`, 'kind')

/**
 * The attempt numbers this process issued per run and gate: two verifies of
 * one gate can run at once (the executor's and the critic's), and each must
 * get its own number before either is recorded (decision 15: never repeated).
 */
const issued = new Map<string, number>()

/** A plan gate's verify (or the goal check's): the run's own argv, in the node's directory, numbered across the run. */
async function planVerify(p: Ports, call: SwarmGateCall, g: Gated): Promise<RecordReply> {
  const { b, f } = g
  const json = f.json
  if (g.node.authority?.verify !== true) {
    return fail(`litter: ${b.node} has no verify authority (authority.verify), so litter runs no verify for it; ask a node that has it, or report to your parent`, 'kind')
  }
  const left = unlanded(json, g.records)
  const allowed = hasGoal(json) ? [...left, 'goal'] : left
  const gate = call.input.gate
  if (typeof gate !== 'string' || gate === '') {
    return fail(`litter: 'gate' is required: the plan gate whose tree you verify${hasGoal(json) ? ', or goal for the goal check' : ''}`, 'gate', allowed)
  }
  if (gate === 'goal') {
    if (!hasGoal(json)) return fail(`litter: run ${f.run} has no goal check, so there's no goal verify; name the plan gate you verify`, 'gate', allowed)
  } else if (!isPlanGate(json, gate)) {
    return fail(`litter: run ${f.run} has no plan gate '${gate}'; name one of its gates with no land yet`, 'gate', allowed)
  } else if (!left.includes(gate)) {
    return fail(`litter: gate ${gate} has landed already; verify a gate with no land yet`, 'gate', allowed)
  }
  if (!(await inCheckout(p, g))) return notInCheckout(g)
  if (gate !== 'goal') {
    const cap = capped(json, g.records, g.gen.seq, gate)
    if (cap) return fail(cap, 'gate')
  }
  // Decision 15: 1 + the gate's verifies anywhere in the run's ledger; the call's `attempt` is ignored.
  const key = `${f.runDir}\u0000${gate}`
  const attempt = Math.max(g.records.filter(r => verifyBody(r)?.gate === gate).length, issued.get(key) ?? 0) + 1
  issued.set(key, attempt)
  const ran = await deps.runVerify(p, f, { gate, attempt, where: b.cwd, by: g.by, timeoutMs: call.options.verifyTimeoutMs })
  if (!ran.ok) return ran
  const v = ran.body
  await mirror(p, call.litterDir, g, { record: 'verify', seq: ran.seq, gate, result: v.green ? 'green' : 'red', verify_id: v.verify_id })
  const reply: VerifyReply & { gate: string; attempt: number } = {
    ok: true,
    verify_id: v.verify_id,
    exit_code: v.exit_code,
    signal: v.signal,
    timed_out: v.timed_out,
    green: v.green,
    tree: v.tree_before,
    tree_changed: v.tree_before !== v.tree_after,
    dirty_submodules: v.dirty_submodules,
    spawn_error: v.spawn_error,
    log: ran.log,
    output_tail: v.output_tail,
    gate,
    attempt,
  }
  return reply
}

/** A VERDICT dimension, as the critic sends it. */
const DIMENSIONS = ['plan_adherence', 'tests_green', 'no_regressions', 'rules'] as const
type PlanVerdictIn = {
  verify_id: string
  gate: string
  dims: Record<(typeof DIMENSIONS)[number], VerdictDimension>
  plan_gap: string
  proposed_rules: string[]
}

/** Execute's VERDICT plus `gate` (decision 14), each field refused on its own. */
function parsePlanVerdict(input: RecordInput, json: RunJson, left: readonly string[]): PlanVerdictIn | RecordError {
  const verifyId = input.verify_id
  if (typeof verifyId !== 'string' || verifyId.trim() === '') {
    return fail("litter: 'verify_id' is required: the verify_id of your own latest verify of the gate you judge", 'verify_id')
  }
  const gate = input.gate
  if (typeof gate !== 'string' || gate === '' || !isPlanGate(json, gate)) {
    return fail("litter: 'gate' is required: the plan gate you judge, one with no land yet", 'gate', left.length > 0 ? left : gateIds(json))
  }
  const dims = {} as PlanVerdictIn['dims']
  for (const d of DIMENSIONS) {
    const x = input[d]
    if (!isObj(x)) return fail(`litter: '${d}' is required: an object { pass, evidence, gaps }`, d)
    if (typeof x.pass !== 'boolean') return fail(`litter: '${d}.pass' must be true or false`, `${d}.pass`)
    // tests_green's pass and evidence are the mod's (from the verify), so only its gaps are the critic's.
    if (d !== 'tests_green' && (typeof x.evidence !== 'string' || x.evidence.trim() === '')) {
      return fail(`litter: '${d}.evidence' is required: what you read or ran that shows it`, `${d}.evidence`)
    }
    const gaps = x.gaps ?? []
    if (!Array.isArray(gaps) || !gaps.every(s => typeof s === 'string')) return fail(`litter: '${d}.gaps' must be a list of strings, [] when it passes`, `${d}.gaps`)
    dims[d] = { pass: x.pass, evidence: typeof x.evidence === 'string' ? x.evidence : '', gaps: [...gaps] }
  }
  const gap = input.plan_gap
  if (typeof gap !== 'string') return fail("litter: 'plan_gap' is required: the plan gap in words, or an empty string when there is none", 'plan_gap')
  const rules = input.proposed_rules ?? []
  if (!Array.isArray(rules)) return fail("litter: 'proposed_rules' must be a list of rules as a person could accept them, or left out", 'proposed_rules')
  for (const [i, r] of rules.entries()) {
    if (typeof r !== 'string' || r.trim() === '') return fail(`litter: 'proposed_rules[${i}]' must be a rule's text`, `proposed_rules[${i}]`)
    if (bytes(r) > RULE_MAX_BYTES) return fail(`litter: 'proposed_rules[${i}]' is over ${RULE_MAX_BYTES} bytes; a rule goes into prompts, so cut it down`, `proposed_rules[${i}]`)
  }
  return { verify_id: verifyId, gate, dims, plan_gap: gap, proposed_rules: rules as string[] }
}

/** The critic's veto (15.10's table) for one plan gate: from a `verdicts: true` node that writes nothing, in the run's checkout. */
async function planVerdict(p: Ports, call: SwarmGateCall, g: Gated): Promise<RecordReply> {
  const { b, node } = g
  if (node.verdicts !== true) {
    return fail(`litter: only a node whose type has verdicts: true records a verdict, and ${b.node}'s hasn't; the critic judges, so report to your parent`, 'kind')
  }
  if (writesFiles(node)) return fail(`litter: ${b.node} may write, so a verdict from it could judge its own change; a verdicts node writes nothing`, 'kind')
  const input = parsePlanVerdict(call.input, g.f.json, unlanded(g.f.json, g.records))
  if ('error' in input) return input
  if (!(await inCheckout(p, g))) return notInCheckout(g)
  // One verdict at a time per run, with the lands: a rejection is numbered and its caps checked against the ledger as it is.
  return serial(`gate.verdict:${g.link.runDir}`, () => planJudged(p, call, g, input))
}

async function planJudged(p: Ports, call: SwarmGateCall, g: Gated, input: PlanVerdictIn): Promise<RecordReply> {
  const { s, b, link } = g
  const json = g.f.json
  const ledger = await readLedger(p, link.runDir, link.run)
  if (ledger.tampered) return fail(tamperedText(link.run, ledger.tampered), 'run')
  const records = ledger.records
  const gen = repairGeneration(records, link)
  if (!gen.ok) return fail(`litter: run ${link.run} ${gen.why}, so swarm ${s.name} records no verdict for it; report to your parent`, 'run')
  const since = gen.rec.seq
  const { verify_id: id, gate } = input
  const left = unlanded(json, records)
  if (!left.includes(gate)) return fail(`litter: gate ${gate} has landed already; judge a gate with no land yet`, 'gate', left)

  // What it cites: a verify of this generation, for this gate, by the verdict's own agent, and the latest that agent made for it.
  const vRec = records.find(r => verifyBody(r)?.verify_id === id)
  const v = vRec ? verifyBody(vRec) : null
  if (!vRec || !v) return fail(`litter: run ${link.run} has no verify ${id}; record your own verify of gate ${gate} (kind verify), then cite its verify_id`, 'verify_id')
  if (vRec.seq < since) {
    return fail(`litter: verify ${id} is from before this repair (generation ${link.generation}); verify the tree as it is now, and cite that`, 'verify_id')
  }
  if (vRec.by.source !== 'agent' || vRec.by.agentId !== b.agentId) {
    return fail(`litter: verify ${id} wasn't recorded by you; a verdict cites a verify its own agent recorded, so record your own verify of gate ${gate} and cite it`, 'verify_id')
  }
  if (v.gate !== gate) return fail(`litter: verify ${id} is for gate ${v.gate}, not ${gate}; record your own verify with gate ${gate} and cite it`, 'verify_id')
  const mine = records.filter(r => r.seq > since && r.by.source === 'agent' && r.by.agentId === b.agentId && verifyBody(r)?.gate === gate).at(-1)
  const latestId = mine ? verifyBody(mine)!.verify_id : null
  if (latestId !== id) return fail(`litter: verify ${id} isn't the latest you recorded for gate ${gate} (that's ${String(latestId)}); judge the tree your latest verify saw, and cite it`, 'verify_id')
  const green = isGreen(v)
  if (!green && DIMENSIONS.every(d => input.dims[d].pass)) {
    return fail(`litter: verify ${id} isn't green (${notGreen(v)}), so a verdict passing every dimension on it can't land; fail what the verify shows, or verify again once it's fixed`, 'tests_green')
  }
  const earlier = records.find(r => r.seq > since && r.kind === 'verdict' && r.body.verify_id === id)
  if (earlier) return fail(`litter: verify ${id} already has a verdict; verify the tree as it is now, and judge that`, 'verify_id')

  // tests_green is the mod's, from the cited verify (decision 14, as output.sh sets it in execute); its gaps stay the critic's.
  const observed = verifyFields('gate-critic', v)?.tests_green as VerdictDimension | undefined
  const tests_green: VerdictDimension = {
    pass: green,
    evidence: observed?.evidence ?? `verify ${id} ${howEnded(v)}`,
    gaps: input.dims.tests_green.gaps,
  }
  const dims = { ...input.dims, tests_green }
  const approved = DIMENSIONS.every(d => dims[d].pass) && input.plan_gap.trim() === ''

  // The round (decision 1): only a rejection is one, numbered by the mod; one past the budget, or past the gate's cap, is refused.
  syncRounds(s.name, records, since)
  await catchUpVerdicts(p, call.litterDir, g, records, since)
  const budget = state.liveSwarm(s.name)?.budget
  if (!budget) return fail(`litter: swarm ${s.name} has no repair budget, so it records no verdict`, 'kind')
  const max = maxAttemptsOf(json)
  let round: number | null = null
  if (!approved) {
    const cap = capped(json, records, since, gate)
    if (cap) return fail(cap, 'gate')
    round = state.roundsUsed(s.name) + 1
    if (round > budget.rounds) {
      return fail(
        `litter: plan-template swarm ${s.name} has used all ${budget.rounds} of the rejected attempts its budget allows, so this rejection isn't recorded; ${ASK_FOR_BUDGET}`,
        'kind',
      )
    }
  }

  const body: SwarmGateVerdictBody = {
    verify_id: id,
    plan_adherence: dims.plan_adherence,
    tests_green: dims.tests_green,
    no_regressions: dims.no_regressions,
    rules: dims.rules,
    plan_gap: input.plan_gap,
    proposed_rules: input.proposed_rules,
    gate,
    attempt: v.attempt,
    approved,
    round,
  }
  const rec = await appendRecord(p, link.runDir, { run: link.run, kind: 'verdict', by: g.by, body })
  if (round !== null) state.noteRound(s.name, id)
  try {
    await deps.writeVerdictFile(p, link.runDir, rec as unknown as StoredRecord)
  } catch (err) {
    p.log(`swarm ${s.name}: the verdict file for ${gate} attempt ${v.attempt} wasn't written: ${errText(err)}`)
  }
  // Proposals stay proposals (decision 16): each one to the rules ledger through AD's store, labelled as the critic's.
  let proposed = 0
  for (const [index, rule] of input.proposed_rules.entries()) {
    try {
      await deps.proposeFromCritic(p, call.litterDir, { run: link.run, rule, source: 'critic', by: g.by, index, gate, swarm: s.name, verify_id: id, round })
      proposed++
    } catch (err) {
      p.log(`swarm ${s.name}: a proposed rule from the verdict on ${id} wasn't recorded: ${errText(err)}`)
    }
  }
  await mirror(p, call.litterDir, g, { record: 'verdict', seq: rec.seq, gate, result: approved ? 'approved' : 'rejected', verify_id: id, ...(round !== null ? { round } : {}) })
  return {
    ok: true,
    kind: 'verdict',
    run: link.run,
    seq: rec.seq,
    gate,
    verify_id: id,
    attempt: v.attempt,
    approved,
    round,
    tests_green,
    rejected_attempts_left: Math.max(0, budget.rounds - state.roundsUsed(s.name)),
    gate_attempts_left: Math.max(0, max - rejections(records, since, gate) - (approved ? 0 : 1)),
    proposed_rules: proposed,
  }
}

/** Why a land of a plan gate is refused before landGate runs, in the land's own answer: the runner reads `landed: false` and the reason. */
const notLanded = (reason: string): LandReply => ({ ok: true, landed: false, reason, retry: false })

/**
 * A plan gate's land (15.10's table): from a node with land authority, on
 * the generation's latest verdict for that gate, approving, from a `verdicts:
 * true` node whose agent writes nothing, under the gate's cap and the budget;
 * then execute's land itself (land.ts, landGate) with `observe: false`, and
 * each land record of the verify mirrored with the plan gate.
 */
async function planLand(p: Ports, call: SwarmGateCall, g: Gated): Promise<RecordReply> {
  const { s, f } = g
  const json = f.json
  if (g.node.authority?.land !== true) {
    return fail(`litter: ${g.b.node} has no land authority (authority.land), so it lands nothing; report the approved verify to your parent`, 'kind')
  }
  const left = unlanded(json, g.records)
  const gate = call.input.gate
  if (typeof gate !== 'string' || gate === '' || !isPlanGate(json, gate)) {
    return fail("litter: 'gate' is required: the plan gate whose approved verify you land", 'gate', left.length > 0 ? left : gateIds(json))
  }
  const verifyId = call.input.verify_id
  if (typeof verifyId !== 'string' || verifyId.trim() === '') {
    return fail("litter: 'verify_id' is required: the verify the critic's approving verdict on the gate cites", 'verify_id')
  }
  // Under the verdicts' key: no verdict on the gate can come between these checks and the land.
  const reply = await serial(`gate.verdict:${g.link.runDir}`, async (): Promise<RecordReply> => {
    const ledger = await readLedger(p, g.link.runDir, g.link.run)
    if (ledger.tampered) return fail(tamperedText(g.link.run, ledger.tampered), 'run')
    const records = ledger.records
    const gen = repairGeneration(records, g.link)
    if (!gen.ok) return notLanded(`run ${g.link.run} ${gen.why}, so nothing more lands`)
    const since = gen.rec.seq
    const ctx: RecordCtx = { p, caller: { agentId: call.caller.agentId, agentType: g.by.source === 'agent' ? g.by.agentType : null }, litterDir: call.litterDir, options: call.options }
    // Idempotent per verify_id, as execute's land is: a land already made answers as it did.
    if (records.some(r => r.kind === 'land' && r.body.verify_id === verifyId)) return landGate(ctx, f, gate, verifyId, { observe: false })
    const done = landed(records).get(gate)
    if (done !== undefined) return notLanded(`gate ${gate} has landed already (commit ${done}); land the next gate with no land`)

    // The generation's latest verdict on the gate is the one a land follows: an approval of this verify.
    const latest = records.filter(r => r.seq > since && r.kind === 'verdict' && r.body.gate === gate).at(-1)
    if (!latest) return notLanded(`no verdict of this repair judges gate ${gate}; the critic records its own verify of the gate, then a verdict citing it`)
    if (latest.body.verify_id !== verifyId) {
      return notLanded(`the latest verdict on gate ${gate} cites verify ${String(latest.body.verify_id)}, not ${verifyId}; a land follows the critic's latest judgment of the gate`)
    }
    if (latest.body.approved !== true) return notLanded(`the latest verdict on gate ${gate} (on verify ${verifyId}) doesn't approve it; send its gaps to the executor, then have the critic judge again`)
    const judgeId = latest.by.source === 'agent' ? latest.by.agentId : null
    const type = latest.by.source === 'agent' ? latest.by.agentType : null
    const judge = Object.entries(s.types).find(([, t]) => t === type)?.[0]
    const judgeNode = judge === undefined ? null : nodeOf(s, judge)
    if (judgeId === null || !judgeNode || judgeNode.verdicts !== true) {
      return notLanded(`the verdict on verify ${verifyId} isn't from a node of swarm ${s.name} whose type has verdicts: true`)
    }
    const writer = state.bindings(s.name).some(x => {
      const n = nodeOf(s, x.node)
      return x.agentId === judgeId && (!n || writesFiles(n))
    })
    if (writesFiles(judgeNode) || writer) return notLanded(`the verdict on verify ${verifyId} is from an agent that may write in the run's checkout, so it could be judging its own change`)

    // The gate's cap, and the budget (15.11: past it, the swarm can't land, and has to ask).
    const cap = capped(json, records, since, gate)
    if (cap) return notLanded(cap.replace(/^litter: /, ''))
    // The spawns too, caught up from the launch's swarm.node records: a land after a reload may come before any spawn's recount.
    try {
      await budgetCounted(p, call.litterDir, s.name)
    } catch (err) {
      return notLanded(`swarm ${s.name}'s repair budget couldn't be counted, so nothing lands: ${errText(err)}`)
    }
    const budget = state.liveSwarm(s.name)?.budget
    if (!budget) return notLanded(`swarm ${s.name} has no repair budget, so nothing it made lands`)
    syncRounds(s.name, records, since)
    if (state.roundsUsed(s.name) > budget.rounds) {
      return notLanded(`plan-template swarm ${s.name} has ${state.roundsUsed(s.name)} rejected attempts, past its budget's ${budget.rounds}; ${ASK_FOR_BUDGET}`)
    }
    if (state.spawnsUsed(s.name) > budget.agents) {
      return notLanded(`plan-template swarm ${s.name} started ${state.spawnsUsed(s.name)} agents, past its budget of ${budget.agents}; ${ASK_FOR_BUDGET}`)
    }
    return landGate(ctx, f, gate, verifyId, { observe: false })
  })
  if (!reply.ok) return reply
  try {
    const mirrored = await mirroredSeqs(p, call.litterDir, g, 'land')
    const after = await readLedger(p, g.link.runDir, g.link.run)
    for (const r of after.records) {
      if (r.seq <= g.gen.seq || r.body.verify_id !== verifyId || mirrored.has(r.seq)) continue
      const result: GateResult | null = r.kind === 'land' ? 'landed' : r.kind === 'land.abandoned' || r.kind === 'land.blocked' ? 'not-landed' : null
      if (result) await mirror(p, call.litterDir, g, { record: 'land', seq: r.seq, gate, result, verify_id: verifyId })
    }
  } catch (err) {
    p.log(`swarm ${s.name}: the land of ${gate} with ${verifyId} wasn't mirrored: ${errText(err)}`)
  }
  return reply
}
