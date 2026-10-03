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

import type { Ports } from '../ports'
import type { LitterOptions } from '../options'
import type { Author, RecordCtx, RecordError, RecordInput, RecordReply, StoredRecord } from '../records/core'
import type { RunRepairBody } from '../records/run'
import type { SwarmVerdictBody, SwarmVerdictTask, VerifyBody, VerifyReply } from '../records/execute'
import type { GateRecordKind, GateResult, SwarmEventBody, SwarmNodeBody } from '../records/swarm'
import type { FanoutTask } from '../integrate'
import type { RunFacts } from '../verify'
import type { BindingKind, LiveSwarm, NodeBinding, RunLink, SwarmNode } from './types'
import { fail } from '../records/core'
import { FANOUT_GATE } from '../records/fanout'
import { appendLaunchRecord, readLaunchLedger } from '../records/swarm'
import { appendRecord, readLedger } from '../ledgercore'
import { runDir as runDirOf } from '../layout'
import { serial } from '../fsx'
import { readRunFacts, verifyBody } from '../verify'
import { fanoutTasks, integrationWorktree } from '../integrate'
import { landRepaired, REPAIR_GATE, repairGeneration } from '../land'
import { nodeOf, swarmRefusal, writesFiles } from './admit'
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
// The verify runner. main extracted runVerify into verify.ts (fca57f6) during
// the build; it isn't merged into this branch, so the gate calls it through
// this seam, and the specs stand in for it.

/** A verify the mod runs: its gate and attempt, the directory (the mod's, never the call's), who records it, its timeout. */
export type VerifyRun = { gate: string; attempt: number; where: string; by: Author; timeoutMs: number }
export type VerifyRan = { ok: true; body: VerifyBody; seq: number; log: string }

export const deps: { runVerify: (p: Ports, f: RunFacts, o: VerifyRun) => Promise<VerifyRan | RecordError> } = {
  // At the merge: `runVerify: (...a) => runVerify(...a),` with `import { runVerify } from '../verify'`.
  runVerify: async () => fail("litter: runVerify isn't merged into this branch", 'kind'),
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
  return { s, link, b, node, f, records: ledger.records, gen: gen.rec, by }
}

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
 */
async function catchUpVerdicts(p: Ports, litterDir: string, g: Gated, records: readonly StoredRecord[], since: number): Promise<void> {
  const verdicts = records.filter(r => r.seq > since && r.kind === 'verdict' && typeof r.body.verify_id === 'string' && typeof r.body.round === 'number')
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
    const gate = (cited ? verifyBody(cited)?.gate : undefined) ?? REPAIR_GATE
    const result: GateResult = r.body.approved === true ? 'approved' : 'rejected'
    await mirror(p, litterDir, g, { record: 'verdict', seq: r.seq, gate, result, verify_id: verifyId, round: r.body.round as number }, { node, agentId })
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
  // Proposals stay proposals (decision 14): each a rule.propose of the run, labelled as the critic's.
  let proposed = 0
  for (const rule of input.proposed_rules) {
    try {
      await appendRecord(p, link.runDir, { run: link.run, kind: 'rule.propose', by: g.by, body: { rule, source: 'critic', verify_id: id, round } })
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
 * The repaired tree's land (land.ts, landRepaired), then each land record of
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
 * a spawn could only serve a land, which needs none.
 */
export function budgetRefusal(swarm: string, kind: BindingKind): string | null {
  if (kind === 'orchestrator') return null
  const b = state.liveSwarm(swarm)?.budget
  if (!b) return null
  const rounds = state.roundsUsed(swarm)
  if (rounds >= b.rounds) {
    return `repair swarm ${swarm} has used all ${b.rounds} of its repair rounds (${rounds} verdicts on distinct verifies), so it starts no more agents; ${ASK_FOR_BUDGET}`
  }
  const used = state.spawnsUsed(swarm)
  if (used >= b.agents) {
    return `repair swarm ${swarm} has started all ${b.agents} agents its repair budget allows (the workers and agents its nodes start), so it starts no more; ${ASK_FOR_BUDGET}`
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
  const gen = repairGeneration(run.records, link)
  if (gen.ok) syncRounds(s.name, run.records, gen.rec.seq)
}

/** A fresh module's memory, for tests (with state.ts's resetForTests). A spec that sets `deps` puts it back itself. */
export function resetGateForTests(): void {
  counted.clear()
}
