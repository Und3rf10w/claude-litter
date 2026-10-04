// Tier 2: a plan-template swarm's gates (hooks/swarm/gate.ts for an execute
// run; phase 3, WP-AC step 6; decisions 1, 14 and 15) and its generation's
// end (hooks/lifecycle.ts, endRepairGeneration; step 7, decision 12), against
// a scratch repository with a real run ledger: the swarm is the one the
// bridge starts for a halted execute run, its runner, executor and critic
// bound in the run's checkout. A verify's attempt numbering across the run's
// generations; every verdict refusal, each on its own; tests_green set by the
// mod; a round only on a rejection, refused past repairRounds; the per-gate
// cap; the land, through execute's own landGate, and each refusal before it;
// and the generation's end, done and halted, with and without a goal check.
// WP-AG: the generation's part of summary.md (rounds, approvals and lands)
// and the budget line a spawn's instance block reads.
// The verify is Y's stand-in (it snapshots and runs the argv for real).

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSpawnInput, AgentSpawnResult } from 'claude-code'
import type { RecordError, RecordReply, StoredRecord } from '../../hooks/records/core'
import type { CriticProposal } from '../../hooks/records/rules'
import type { LandReply, SwarmGateVerdictBody, VerifyReply } from '../../hooks/records/execute'
import type { NodeBinding } from '../../hooks/swarm/types'
import { appendRecord } from '../../hooks/ledgercore'
import { summaryPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { readPolicy } from '../../hooks/policy'
import { appendLaunchRecord, readLaunchLedger } from '../../hooks/records/swarm'
import { endRepairGeneration } from '../../hooks/lifecycle'
import { budgetCounted, budgetRefusal, deps as gateDeps, resetGateForTests, swarmGateRecord, type SwarmGateKind } from '../../hooks/swarm/gate'
import { binding, liveSwarm, noteRound, noteSpawned, putBinding, roundsUsed, setInteractive } from '../../hooks/swarm/state'
import { swarmSpawn } from '../../hooks/swarm/spawn'
import { continueAsRepair, resetRepairForTests } from '../../hooks/repair'
import { standInVerify, verifyCalls } from './repair-harness'
import { NOW, world, type World } from './swarmlaunch-harness'
import { BRANCH, REF, RUN, declinedReason, executeRun, runRecords, write, type Exec, type ExecOpts } from './execbridge-harness'

setDefaultTimeout(120_000)

const originals = { ...gateDeps }
const ASK = 'report blocked to your parent, saying what more you need and for what; the lead can ask the user for it with repair.budget'

let w: World
let x: Exec
let files: StoredRecord[]
let proposals: CriticProposal[]

beforeEach(async () => {
  w = await world('sess-a')
  resetRepairForTests()
  resetGateForTests()
  setInteractive(true)
  files = []
  proposals = []
  verifyCalls.length = 0
  Object.assign(gateDeps, {
    runVerify: standInVerify,
    writeVerdictFile: async (_p: unknown, _dir: string, rec: StoredRecord) => void files.push(rec),
    proposeFromCritic: async (_p: unknown, _litterDir: string, input: CriticProposal) => void proposals.push(input),
  } as Partial<typeof gateDeps>)
})
afterEach(async () => {
  Object.assign(gateDeps, originals)
  resetGateForTests()
  resetRepairForTests()
  await w.done()
})

/** The halted run, its plan-template swarm started by the bridge, and its runner, executor and critic bound in the run's checkout. */
async function started(o: ExecOpts = {}): Promise<void> {
  x = await executeRun(w, o)
  await continueAsRepair(w.p, x.runDir)
  if (!liveSwarm(x.name)) throw new Error(`the bridge didn't start the swarm: ${await declinedReason(x)}`)
  bind('run-1', 'runner', { kind: 'orchestrator', parent: null })
  bind('ex-1', 'executor')
  bind('cr-1', 'critic')
  // Generation 1's verifies were the harness's.
  verifyCalls.length = 0
}

function bind(agentId: string, node: string, over: Partial<NodeBinding> = {}): NodeBinding {
  const s = liveSwarm(x.name)!
  const b: NodeBinding = {
    agentId,
    swarm: s.name,
    launch: s.launch,
    node,
    n: 1,
    kind: 'worker',
    of: null,
    parent: 'run-1',
    type: s.types[node]!,
    cwd: w.dir,
    branch: null,
    token: `tok-${agentId}`,
    revision: s.revision,
    generation: 1,
    boundAt: NOW,
    adopted: false,
    ...over,
  }
  putBinding(b)
  return b
}

function gate(kind: SwarmGateKind, agentId: string, fields: Record<string, unknown> = {}): Promise<RecordReply> {
  const b = binding(agentId)
  if (!b) throw new Error(`no binding for ${agentId}`)
  return swarmGateRecord(w.p, { kind, input: { kind, ...fields }, caller: { agentId, agentType: b.type }, binding: b, litterDir: w.litterDir, options: normalizeOptions({}) })
}

const asError = (r: RecordReply): RecordError => {
  expect(r.ok).toBe(false)
  return r as RecordError
}

async function verify(agentId: string, g: string, extra: Record<string, unknown> = {}): Promise<VerifyReply & { gate: string; attempt: number }> {
  const r = await gate('verify', agentId, { gate: g, ...extra })
  if (!r.ok) throw new Error(`the verify was refused: ${JSON.stringify(r)}`)
  return r as VerifyReply & { gate: string; attempt: number }
}

const dim = (pass: boolean, gap = 'the defaults are merged over the settings') => ({ pass, evidence: 'plan.md:7-9 against git diff HEAD', gaps: pass ? [] : [gap] })

/** A critic's verdict fields: every dimension passing unless `reject`, no plan gap unless `gap`, no rule clash unless `clash`. */
const verdict = (verifyId: string, o: { gate?: string; reject?: boolean; gap?: string; clash?: string; rules?: string[] } = {}): Record<string, unknown> => ({
  gate: o.gate ?? 'G2',
  verify_id: verifyId,
  plan_adherence: dim(!o.reject),
  tests_green: { pass: true, evidence: 'the run was green', gaps: [] },
  no_regressions: dim(true),
  rules: { pass: true, evidence: 'none apply', gaps: [] },
  plan_gap: o.gap ?? '',
  rule_clash: o.clash ?? '',
  ...(o.rules ? { proposed_rules: o.rules } : {}),
})

const judge = (agentId: string, verifyId: string, o: Parameters<typeof verdict>[1] = {}) => gate('verdict', agentId, verdict(verifyId, o))

/** A gate's change written, then verified green and approved by the critic: what the runner lands. */
async function approved(g: string, file: string, critic = 'cr-1'): Promise<string> {
  write(w.dir, file, `${g} done in the swarm\n`)
  const v = await verify(critic, g)
  if (!v.green) throw new Error(`${g}'s verify isn't green: ${v.output_tail}`)
  const r = await judge(critic, v.verify_id, { gate: g })
  if (!r.ok || (r as { approved?: boolean }).approved !== true) throw new Error(`${g} wasn't approved: ${JSON.stringify(r)}`)
  return v.verify_id
}

async function landed(g: string, file: string): Promise<LandReply & { landed: true }> {
  const vid = await approved(g, file)
  const r = (await gate('land', 'run-1', { gate: g, verify_id: vid })) as LandReply
  if (!r.ok || !r.landed) throw new Error(`${g}'s land was refused: ${JSON.stringify(r)}`)
  return r as LandReply & { landed: true }
}

const verdictsNow = async (): Promise<StoredRecord[]> => (await runRecords(x)).filter(r => r.kind === 'verdict')
const kindsAfterRepair = async (): Promise<string[]> => {
  const rs = await runRecords(x)
  return rs.slice(rs.findIndex(r => r.kind === 'run.repair') + 1).map(r => r.kind)
}
const gateEvents = async (): Promise<Record<string, unknown>[]> => {
  const s = liveSwarm(x.name)!
  return (await readLaunchLedger(w.p, w.litterDir, s.name, s.launch)).records.filter(r => r.kind === 'swarm.event' && r.body.kind === 'gate').map(r => r.body)
}
const tipOf = async (): Promise<string> => (await w.git('rev-parse', REF)).trim()

// ---------------------------------------------------------------------------

describe('verify', () => {
  test("numbered across the run's ledger (decision 15): generation 1 holds G2's attempt 1, so the swarm's first is 2; the call's attempt is ignored", async () => {
    await started()
    expect(x.g2.map(v => v.attempt)).toEqual([1])
    const a = await verify('cr-1', 'G2', { attempt: 99 })
    expect(a).toEqual(expect.objectContaining({ ok: true, gate: 'G2', attempt: 2, green: true, tree_changed: false }))
    expect((await verify('ex-1', 'G2')).attempt).toBe(3)
    expect((await verify('cr-1', 'G3')).attempt).toBe(1)
    // Two at once each get their own number before either is recorded.
    const both = await Promise.all([verify('cr-1', 'G3'), verify('ex-1', 'G3')])
    expect(both.map(v => v.attempt).sort()).toEqual([2, 3])
    // Each ran the run's argv in the node's directory, as the node.
    const ran = verifyCalls.map(c => [c.gate, c.where, c.by.source === 'agent' ? c.by.agentId : null].join(' '))
    expect(ran.slice(0, 3)).toEqual([`G2 ${w.dir} cr-1`, `G2 ${w.dir} ex-1`, `G3 ${w.dir} cr-1`])
    expect(ran.slice(3).sort()).toEqual([`G3 ${w.dir} cr-1`, `G3 ${w.dir} ex-1`])
    const ev = (await gateEvents()).find(e => e.record === 'verify' && e.verify_id === a.verify_id)
    expect(ev).toEqual(expect.objectContaining({ node: 'critic', agentId: 'cr-1', run: RUN, gate: 'G2', result: 'green' }))
  })

  test('refused, running nothing: no gate, a landed gate, a gate not in the plan, goal with no goal check, outside the checkout, no verify authority', async () => {
    await started({ adversary: 'run' })
    bind('cr-2', 'critic', { cwd: join(w.dir, 'elsewhere') })
    bind('adv-1', 'adversary')
    const cases: [string, Record<string, unknown>, string, string][] = [
      ['cr-1', {}, 'gate', "litter: 'gate' is required: the plan gate whose tree you verify"],
      ['cr-1', { gate: 'G1' }, 'gate', 'litter: gate G1 has landed already; verify a gate with no land yet'],
      ['cr-1', { gate: 'G9' }, 'gate', `litter: run ${RUN} has no plan gate 'G9'`],
      ['cr-1', { gate: 'goal' }, 'gate', `litter: run ${RUN} has no goal check, so there's no goal verify`],
      ['cr-2', { gate: 'G2' }, 'kind', `litter: your directory ${join(w.dir, 'elsewhere')} isn't the run's checkout ${w.dir}`],
      ['adv-1', { gate: 'G2' }, 'kind', 'litter: adversary has no verify authority (authority.verify)'],
    ]
    for (const [agent, fields, field, error] of cases) {
      const r = asError(await gate('verify', agent, fields))
      expect({ agent, fields, field: r.field, error: r.error.slice(0, error.length) }).toEqual({ agent, fields, field, error })
    }
    expect(asError(await gate('verify', 'cr-1', {})).allowed).toEqual(['G2', 'G3'])
    expect(verifyCalls).toEqual([])
  })

  test('goal mode: gate goal runs the goal check, and is allowed beside the gates left', async () => {
    await started({ goal: true })
    expect(asError(await gate('verify', 'run-1', {})).allowed).toEqual(['G2', 'G3', 'goal'])
    const v = await verify('run-1', 'goal')
    expect(v).toEqual(expect.objectContaining({ gate: 'goal', attempt: 1, green: true }))
    expect((await runRecords(x)).find(r => r.body.verify_id === v.verify_id)?.body.argv).toEqual(['sh', '-c', 'test ! -e .claude/goal-red'])
  })
})

describe('verdict', () => {
  test('each field refused on its own, and from a node without verdicts: true; nothing is recorded', async () => {
    await started()
    const v = await verify('cr-1', 'G2')
    const base = verdict(v.verify_id)
    const cases: [string, string, Record<string, unknown>, string, string][] = [
      ['the executor', 'ex-1', base, 'kind', 'litter: only a node whose type has verdicts: true records a verdict'],
      ['the runner', 'run-1', base, 'kind', 'litter: only a node whose type has verdicts: true records a verdict'],
      ['no verify_id', 'cr-1', { ...base, verify_id: undefined }, 'verify_id', "litter: 'verify_id' is required"],
      ['no gate', 'cr-1', { ...base, gate: undefined }, 'gate', "litter: 'gate' is required: the plan gate you judge"],
      ['a gate not in the plan', 'cr-1', { ...base, gate: 'G9' }, 'gate', "litter: 'gate' is required"],
      ['no plan_adherence', 'cr-1', { ...base, plan_adherence: undefined }, 'plan_adherence', "litter: 'plan_adherence' is required: an object { pass, evidence, gaps }"],
      ['a pass that is not a boolean', 'cr-1', { ...base, no_regressions: { pass: 'yes', evidence: 'e', gaps: [] } }, 'no_regressions.pass', "litter: 'no_regressions.pass' must be true or false"],
      ['no evidence', 'cr-1', { ...base, rules: { pass: true, evidence: ' ', gaps: [] } }, 'rules.evidence', "litter: 'rules.evidence' is required"],
      ['gaps not a list', 'cr-1', { ...base, plan_adherence: { pass: false, evidence: 'e', gaps: 'all of it' } }, 'plan_adherence.gaps', "litter: 'plan_adherence.gaps' must be a list of strings"],
      ['no plan_gap', 'cr-1', { ...base, plan_gap: undefined }, 'plan_gap', "litter: 'plan_gap' is required"],
      ['no rule_clash', 'cr-1', { ...base, rule_clash: undefined }, 'rule_clash', "litter: 'rule_clash' is required: the rule clash in words, naming the rules' ids"],
      ['a rule_clash that is not a string', 'cr-1', { ...base, rule_clash: ['P-a', 'P-b'] }, 'rule_clash', "litter: 'rule_clash' is required"],
      ['proposed_rules not a list', 'cr-1', { ...base, proposed_rules: 'run uv sync' }, 'proposed_rules', "litter: 'proposed_rules' must be a list"],
      ['an empty proposed rule', 'cr-1', { ...base, proposed_rules: ['ok', ' '] }, 'proposed_rules[1]', "litter: 'proposed_rules[1]' must be a rule's text"],
    ]
    for (const [what, agent, fields, field, error] of cases) {
      const r = asError(await gate('verdict', agent, fields))
      expect({ what, field: r.field, error: r.error.slice(0, error.length) }).toEqual({ what, field, error })
    }
    expect((await verdictsNow()).filter(r => r.body.gate !== undefined)).toEqual([])
    // tests_green's evidence is the mod's, so the critic may leave it out.
    const ok = await gate('verdict', 'cr-1', { ...base, tests_green: { pass: true } })
    expect(ok.ok).toBe(true)
  })

  test('what it cites: a verify of this generation, for its gate, by its own agent, the latest it made; green for an all-pass; one verdict each', async () => {
    await started()
    const exec = await verify('ex-1', 'G2')
    const g3 = await verify('cr-1', 'G3')
    const first = await verify('cr-1', 'G2')
    const latest = await verify('cr-1', 'G2')
    const cases: [string, string, Record<string, unknown>, string, string][] = [
      ['an unknown verify', 'cr-1', verdict('G2-9-0123456789'), 'verify_id', `litter: run ${RUN} has no verify G2-9-0123456789`],
      ["generation 1's verify", 'cr-1', verdict(x.g2[0]!.verify_id), 'verify_id', `litter: verify ${x.g2[0]!.verify_id} is from before this repair (generation 2)`],
      ["the executor's verify", 'cr-1', verdict(exec.verify_id), 'verify_id', `litter: verify ${exec.verify_id} wasn't recorded by you`],
      ["another gate's verify", 'cr-1', verdict(g3.verify_id), 'verify_id', `litter: verify ${g3.verify_id} is for gate G3, not G2`],
      ['an older verify of its own', 'cr-1', verdict(first.verify_id), 'verify_id', `litter: verify ${first.verify_id} isn't the latest you recorded for gate G2 (that's ${latest.verify_id})`],
      ['a landed gate', 'cr-1', verdict(latest.verify_id, { gate: 'G1' }), 'gate', 'litter: gate G1 has landed already; judge a gate with no land yet'],
    ]
    for (const [what, agent, fields, field, error] of cases) {
      const r = asError(await gate('verdict', agent, fields))
      expect({ what, field: r.field, error: r.error.slice(0, error.length) }).toEqual({ what, field, error })
    }
    // A second verdict on the same verify.
    expect((await judge('cr-1', latest.verify_id, { reject: true })).ok).toBe(true)
    const again = asError(await judge('cr-1', latest.verify_id, { reject: true }))
    expect(again).toEqual(expect.objectContaining({ field: 'verify_id', error: `litter: verify ${latest.verify_id} already has a verdict; verify the tree as it is now, and judge that` }))
    // An all-pass verdict on a red verify.
    write(w.dir, '.claude/red', 'red\n')
    const red = await verify('cr-1', 'G2')
    expect(red.green).toBe(false)
    const allPass = asError(await judge('cr-1', red.verify_id))
    expect(allPass.field).toBe('tests_green')
    expect(allPass.error).toStartWith(`litter: verify ${red.verify_id} isn't green (exit 1), so a verdict passing every dimension on it can't land`)
    // From outside the checkout.
    bind('cr-2', 'critic', { cwd: join(w.dir, 'elsewhere') })
    expect(asError(await judge('cr-2', red.verify_id)).error).toContain("isn't the run's checkout")
    expect((await verdictsNow()).filter(r => r.body.gate !== undefined)).toHaveLength(1)
  })

  test("tests_green is the mod's, from the cited verify, keeping the critic's gaps; the body is execute's VERDICT plus gate, its file written and its proposals passed on", async () => {
    await started()
    write(w.dir, 'g2.txt', 'G2 in the swarm\n')
    const v = await verify('cr-1', 'G2')
    const r = (await gate('verdict', 'cr-1', {
      ...verdict(v.verify_id, { rules: ['run uv sync before the tests'] }),
      tests_green: { pass: false, evidence: 'I doubt the runner', gaps: ['flaky on a loaded machine?'] },
    })) as Record<string, unknown>
    const tests_green = { pass: true, evidence: `verify ${v.verify_id} exit 0 on tree ${v.tree}`, gaps: ['flaky on a loaded machine?'] }
    expect(r).toEqual(
      expect.objectContaining({ ok: true, kind: 'verdict', run: RUN, gate: 'G2', verify_id: v.verify_id, attempt: 2, approved: true, round: null, tests_green, rejected_attempts_left: 3, gate_attempts_left: 3, proposed_rules: 1 }),
    )
    const rec = (await verdictsNow()).at(-1)!
    const body = rec.body as unknown as SwarmGateVerdictBody
    expect(body).toEqual(
      expect.objectContaining({ verify_id: v.verify_id, gate: 'G2', attempt: 2, approved: true, round: null, tests_green, plan_gap: '', rule_clash: '', proposed_rules: ['run uv sync before the tests'] }),
    )
    expect(rec.by).toEqual({ source: 'agent', agentId: 'cr-1', agentType: liveSwarm(x.name)!.types.critic! })
    expect(files.map(f => f.seq)).toEqual([rec.seq])
    expect(proposals).toEqual([expect.objectContaining({ run: RUN, rule: 'run uv sync before the tests', source: 'critic', index: 0, gate: 'G2', swarm: x.name, verify_id: v.verify_id, round: null })])

    // Red: the mod's fail, with the output, whatever the critic said.
    write(w.dir, '.claude/red', 'red\n')
    const red = await verify('cr-1', 'G2')
    const rr = (await judge('cr-1', red.verify_id, { reject: true })) as Record<string, unknown>
    expect(rr.approved).toBe(false)
    const redGreen = rr.tests_green as { pass: boolean; evidence: string }
    expect(redGreen.pass).toBe(false)
    expect(redGreen.evidence).toStartWith(`verify ${red.verify_id} exit 1: `)
  })

  test('a plan gap rejects even when every dimension passes', async () => {
    await started()
    const v = await verify('cr-1', 'G2')
    const r = (await judge('cr-1', v.verify_id, { gap: 'the plan never says where the defaults live' })) as Record<string, unknown>
    expect(r).toEqual(expect.objectContaining({ ok: true, approved: false, round: 1 }))
  })

  test("a rule clash rejects as a plan gap does, with its round, and its land is refused as the user's to settle (WP-AH)", async () => {
    await started()
    const tip = await tipOf()
    const clash = 'P-tests-first and L-no-fixtures clash: the test G2 names needs a fixture'
    write(w.dir, 'g2.txt', 'G2 in the swarm\n')
    const v = await verify('cr-1', 'G2')
    const r = (await judge('cr-1', v.verify_id, { clash })) as Record<string, unknown>
    expect(r).toEqual(expect.objectContaining({ ok: true, approved: false, round: 1, rejected_attempts_left: 2, gate_attempts_left: 2 }))
    expect(roundsUsed(x.name)).toBe(1)
    const body = (await verdictsNow()).at(-1)!.body as unknown as SwarmGateVerdictBody
    expect(body).toEqual(expect.objectContaining({ verify_id: v.verify_id, gate: 'G2', approved: false, round: 1, plan_gap: '', rule_clash: clash }))
    expect(await gate('land', 'run-1', { gate: 'G2', verify_id: v.verify_id })).toEqual({
      ok: true,
      landed: false,
      retry: false,
      reason: `the latest verdict on gate G2 (on verify ${v.verify_id}) names a rule clash, which only the user can settle; report it to your parent as a rule clash`,
    })
    expect(await tipOf()).toBe(tip)
    expect(await kindsAfterRepair()).not.toContain('land')
  })

  // WP-AO: who may add files to a gate.
  test("under widen ask, the default, the verify says so and a verdict's widened is refused, naming the plan gap instead", async () => {
    await started()
    const v = await verify('cr-1', 'G2')
    expect(v.widen).toBe('ask')
    const r = asError(await gate('verdict', 'cr-1', { ...verdict(v.verify_id), widened: [{ file: 'gen.sh', why: 'g2.txt is generated' }] }))
    expect(r.field).toBe('widened')
    expect(r.error).toContain("only the user adds files to a gate (widen: ask), so leave 'widened' empty")
    expect(asError(await gate('verdict', 'cr-1', { ...verdict(v.verify_id), widened: 'gen.sh' })).field).toBe('widened')
    expect((await gate('verdict', 'cr-1', { ...verdict(v.verify_id), widened: [] })).ok).toBe(true)
  })

  test("under widen critic, the verdict keeps widened, and its land records each file as the critic's widening", async () => {
    await started({ widen: 'critic' })
    write(w.dir, 'g2.txt', 'G2 in the swarm\n')
    write(w.dir, 'gen.sh', 'echo g2\n')
    const v = await verify('cr-1', 'G2')
    expect(v.widen).toBe('critic')
    const widened = [{ file: 'gen.sh', why: 'g2.txt is generated' }]
    const r = (await gate('verdict', 'cr-1', { ...verdict(v.verify_id), widened })) as Record<string, unknown>
    expect(r).toEqual(expect.objectContaining({ ok: true, approved: true }))
    expect(((await verdictsNow()).at(-1)!.body as unknown as SwarmGateVerdictBody).widened).toEqual(widened)
    const land = (await gate('land', 'run-1', { gate: 'G2', verify_id: v.verify_id })) as LandReply
    expect(land).toEqual(expect.objectContaining({ ok: true, landed: true }))
    const after = await runRecords(x)
    expect(after.filter(r => r.kind === 'gate.widen').map(r => r.body)).toEqual([{ gate: 'G2', files: ['gen.sh'], why: 'g2.txt is generated', by: 'critic', at: 'land', verify_id: v.verify_id }])
    expect(after.filter(r => r.kind === 'land').at(-1)!.body).not.toHaveProperty('outside')
  })

  test('a round only on a rejection: an approval is round null and uses none; past repairRounds a rejection is refused with the ask', async () => {
    await started({ rounds: 2 })
    const name = x.name
    const v1 = await verify('cr-1', 'G2')
    expect(await judge('cr-1', v1.verify_id, { reject: true })).toEqual(expect.objectContaining({ ok: true, approved: false, round: 1, rejected_attempts_left: 1, gate_attempts_left: 2 }))
    expect(roundsUsed(name)).toBe(1)
    const v2 = await verify('cr-1', 'G2')
    expect(await judge('cr-1', v2.verify_id)).toEqual(expect.objectContaining({ ok: true, approved: true, round: null, rejected_attempts_left: 1 }))
    expect(roundsUsed(name)).toBe(1)
    const v3 = await verify('cr-1', 'G3')
    expect(await judge('cr-1', v3.verify_id, { gate: 'G3', reject: true })).toEqual(expect.objectContaining({ round: 2, rejected_attempts_left: 0 }))
    const v4 = await verify('cr-1', 'G3')
    const past = asError(await judge('cr-1', v4.verify_id, { gate: 'G3', reject: true }))
    expect(past).toEqual({ ok: false, field: 'kind', error: `litter: plan-template swarm ${name} has used all 2 of the rejected attempts its budget allows, so this rejection isn't recorded; ${ASK}` })
    // An approval still records: it uses no round.
    expect(await judge('cr-1', v4.verify_id, { gate: 'G3' })).toEqual(expect.objectContaining({ ok: true, approved: true, round: null }))
    // The gate events: a round only on the rejections.
    const verdicts = (await gateEvents()).filter(e => e.record === 'verdict')
    expect(verdicts.map(e => [e.gate, e.result, e.round])).toEqual([
      ['G2', 'rejected', 1],
      ['G2', 'approved', undefined],
      ['G3', 'rejected', 2],
      ['G3', 'approved', undefined],
    ])
    // The spawn check's text counts rejected attempts.
    expect(budgetRefusal(name, 'worker')).toBe(`plan-template swarm ${name} has used all 2 of the rejected attempts its budget allows (2 rejecting verdicts), so it starts no more agents; ${ASK}`)
    expect(budgetRefusal(name, 'orchestrator')).toBeNull()
  })
})

describe('the per-gate cap (maxAttempts rejections in the generation)', () => {
  test("refuses the gate's verify, a rejection past it, and its land; another gate goes on", async () => {
    await started({ maxAttempts: 2, rounds: 6 })
    bind('cr-2', 'critic')
    const theirs = await verify('cr-2', 'G2')
    for (let n = 0; n < 2; n++) {
      const v = await verify('cr-1', 'G2')
      expect((await judge('cr-1', v.verify_id, { reject: true })).ok).toBe(true)
    }
    const capped = `litter: report up: gate G2 has used its attempts (2 rejected in this repair, of the run's 2); keep its attempt in the tree, and report blocked to your parent with what the gate needs`
    expect(asError(await gate('verify', 'cr-1', { gate: 'G2' }))).toEqual({ ok: false, field: 'gate', error: capped })
    expect(asError(await judge('cr-2', theirs.verify_id, { reject: true }))).toEqual({ ok: false, field: 'gate', error: capped })
    // An approval records (it isn't a rejection), but its land is past the cap.
    expect(await judge('cr-2', theirs.verify_id)).toEqual(expect.objectContaining({ ok: true, approved: true, gate_attempts_left: 0 }))
    const tip = await tipOf()
    const land = await gate('land', 'run-1', { gate: 'G2', verify_id: theirs.verify_id })
    expect(land).toEqual({ ok: true, landed: false, retry: false, reason: capped.replace(/^litter: /, '') })
    expect(await tipOf()).toBe(tip)
    expect((await verify('cr-1', 'G3')).attempt).toBe(1)
  })
})

describe('land', () => {
  test("from the runner after an approval: execute's land commits the tree with the Litter-Run trailer on the run's branch, and is mirrored", async () => {
    await started()
    const old = await tipOf()
    expect(old).toBe(x.lands[0]!.commit)
    const vid = await approved('G2', 'g2.txt')
    const tree = (await runRecords(x)).find(r => r.body.verify_id === vid && r.kind === 'verify')!.body.tree_after as string
    const r = (await gate('land', 'run-1', { gate: 'G2', verify_id: vid })) as LandReply
    expect(r).toEqual({ ok: true, landed: true, commit: expect.stringMatching(/^[0-9a-f]{40}$/), retry: false })
    const commit = (r as { commit: string }).commit
    expect(await tipOf()).toBe(commit)
    expect((await w.git('rev-parse', `${commit}^{tree}`)).trim()).toBe(tree)
    expect((await w.git('rev-parse', `${commit}^`)).trim()).toBe(old)
    const message = await w.git('log', '-1', '--format=%B', commit)
    expect(message).toStartWith('G2: Load the defaults')
    expect(message).toContain(`Litter-Run: ${RUN} G2 ${vid}`)
    const land = (await runRecords(x)).filter(rec => rec.kind === 'land').at(-1)!
    expect(land.body).toEqual({ gate: 'G2', verify_id: vid, commit, tree, old, ref: REF })
    expect((await gateEvents()).filter(e => e.record === 'land')).toEqual([expect.objectContaining({ node: 'runner', agentId: 'run-1', gate: 'G2', result: 'landed', verify_id: vid })])
    // Idempotent per verify_id: the same answer, nothing more committed.
    expect(await gate('land', 'run-1', { gate: 'G2', verify_id: vid })).toEqual(r)
    expect((await runRecords(x)).filter(rec => rec.kind === 'land')).toHaveLength(2)
    // The next gate's verify starts from the new tip, and G2 is no longer a gate to verify.
    expect(asError(await gate('verify', 'cr-1', { gate: 'G2' })).error).toContain('gate G2 has landed already')
  })

  test('refused, landing nothing: no authority, a bad field, no verdict, a rejection, another verify, a landed gate', async () => {
    await started()
    const tip = await tipOf()
    const notLanded = (reason: string): LandReply => ({ ok: true, landed: false, retry: false, reason })
    // The field and authority refusals.
    const v0 = await verify('cr-1', 'G2')
    expect(asError(await gate('land', 'ex-1', { gate: 'G2', verify_id: v0.verify_id })).error).toBe(
      'litter: executor has no land authority (authority.land), so it lands nothing; report the approved verify to your parent',
    )
    expect(asError(await gate('land', 'cr-1', { gate: 'G2', verify_id: v0.verify_id })).field).toBe('kind')
    expect(asError(await gate('land', 'run-1', { verify_id: v0.verify_id })).field).toBe('gate')
    expect(asError(await gate('land', 'run-1', { gate: 'G9', verify_id: v0.verify_id })).field).toBe('gate')
    expect(asError(await gate('land', 'run-1', { gate: 'G2' })).field).toBe('verify_id')
    // No verdict on the gate in this generation.
    expect(await gate('land', 'run-1', { gate: 'G2', verify_id: v0.verify_id })).toEqual(
      notLanded('no verdict of this repair judges gate G2; the critic records its own verify of the gate, then a verdict citing it'),
    )
    // The latest verdict rejects.
    await judge('cr-1', v0.verify_id, { reject: true })
    expect(await gate('land', 'run-1', { gate: 'G2', verify_id: v0.verify_id })).toEqual(
      notLanded(`the latest verdict on gate G2 (on verify ${v0.verify_id}) doesn't approve it; send its gaps to the executor, then have the critic judge again`),
    )
    // An approval that a later verdict superseded.
    const v1 = await verify('cr-1', 'G2')
    await judge('cr-1', v1.verify_id)
    const v2 = await verify('cr-1', 'G2')
    await judge('cr-1', v2.verify_id, { reject: true })
    expect(await gate('land', 'run-1', { gate: 'G2', verify_id: v1.verify_id })).toEqual(
      notLanded(`the latest verdict on gate G2 cites verify ${v2.verify_id}, not ${v1.verify_id}; a land follows the critic's latest judgment of the gate`),
    )
    // A gate landed already.
    expect(await gate('land', 'run-1', { gate: 'G1', verify_id: v1.verify_id })).toEqual(
      notLanded(`gate G1 has landed already (commit ${x.lands[0]!.commit}); land the next gate with no land`),
    )
    expect(await tipOf()).toBe(tip)
    expect(await kindsAfterRepair()).not.toContain('land')
  })

  test("a verdict from a type without verdicts: true, or from an agent bound as the executor, lands nothing", async () => {
    await started()
    const tip = await tipOf()
    const s = liveSwarm(x.name)!
    const v = await verify('ex-1', 'G2')
    const body = (agentType: string) => ({ ...verdict(v.verify_id), tests_green: { pass: true, evidence: 'mod', gaps: [] }, attempt: v.attempt, approved: true, round: null })
    // Written straight into the ledger: the gate never takes one from these, so this is land's own check.
    await appendRecord(w.p, x.runDir, { run: RUN, kind: 'verdict', by: { source: 'agent', agentId: 'ex-1', agentType: s.types.executor! }, body: body(s.types.executor!) })
    expect(await gate('land', 'run-1', { gate: 'G2', verify_id: v.verify_id })).toEqual({
      ok: true,
      landed: false,
      retry: false,
      reason: `the verdict on verify ${v.verify_id} isn't from a node of swarm ${x.name} whose type has verdicts: true`,
    })
    await appendRecord(w.p, x.runDir, { run: RUN, kind: 'verdict', by: { source: 'agent', agentId: 'ex-1', agentType: s.types.critic! }, body: body(s.types.critic!) })
    expect(await gate('land', 'run-1', { gate: 'G2', verify_id: v.verify_id })).toEqual({
      ok: true,
      landed: false,
      retry: false,
      reason: `the verdict on verify ${v.verify_id} is from an agent that may write in the run's checkout, so it could be judging its own change`,
    })
    expect(await tipOf()).toBe(tip)
  })

  test('past the rounds budget, a land is refused with the ask; at it, an approval still lands', async () => {
    await started({ rounds: 2 })
    const name = x.name
    const vid = await approved('G2', 'g2.txt')
    // More rejections than repairRounds can only be a state the verdict gate never let in (a backstop, as 2b-2's).
    for (const id of ['r1', 'r2', 'r3']) noteRound(name, id)
    expect(await gate('land', 'run-1', { gate: 'G2', verify_id: vid })).toEqual({
      ok: true,
      landed: false,
      retry: false,
      reason: `plan-template swarm ${name} has 3 rejected attempts, past its budget's 2; ${ASK}`,
    })
  })

  test('with every rejected attempt used, an approval lands: the budget caps rejections, not approvals (decision 1)', async () => {
    await started({ rounds: 1 })
    const v = await verify('cr-1', 'G2')
    expect(await judge('cr-1', v.verify_id, { reject: true })).toEqual(expect.objectContaining({ round: 1, rejected_attempts_left: 0 }))
    const r = (await landed('G2', 'g2.txt')) as LandReply
    expect(r.landed).toBe(true)
  })

  test('past the agents budget, a land is refused with the ask, and so is the next spawn', async () => {
    await started({ agents: 1 })
    const name = x.name
    const vid = await approved('G2', 'g2.txt')
    noteSpawned(name, 'node:ex-1')
    expect(budgetRefusal(name, 'worker')).toBe(
      `plan-template swarm ${name} has started all 1 agents its repair budget allows (the workers and agents its nodes start), so it starts no more; ${ASK}`,
    )
    noteSpawned(name, 'node:cr-1')
    expect(await gate('land', 'run-1', { gate: 'G2', verify_id: vid })).toEqual({
      ok: true,
      landed: false,
      retry: false,
      reason: `plan-template swarm ${name} started 2 agents, past its budget of 1; ${ASK}`,
    })
  })

  test("execute's land still checks the tree: a change after the critic's verify is refused with retry true", async () => {
    await started()
    const vid = await approved('G2', 'g2.txt')
    write(w.dir, 'g2.txt', 'changed after the verdict\n')
    const r = (await gate('land', 'run-1', { gate: 'G2', verify_id: vid })) as LandReply
    expect(r).toEqual(expect.objectContaining({ ok: true, landed: false, retry: true }))
    expect((r as { reason: string }).reason).toContain("the tree changed after verify")
    expect(await tipOf()).toBe(x.lands[0]!.commit)
  })
})

describe("the budget's recount after a reload", () => {
  test("a fresh gate module reads the run's workflow again, so the spawn check's text stays the plan template's", async () => {
    await started({ rounds: 1 })
    const v = await verify('cr-1', 'G2')
    await judge('cr-1', v.verify_id, { reject: true })
    resetGateForTests()
    await budgetCounted(w.p, w.litterDir, x.name)
    expect(budgetRefusal(x.name, 'worker')).toStartWith(`plan-template swarm ${x.name} has used all 1 of the rejected attempts its budget allows`)
  })

  test("a land before any spawn of a fresh module counts the launch's spawns first, so past the agents budget it's refused", async () => {
    await started({ agents: 1 })
    const s = liveSwarm(x.name)!
    const vid = await approved('G2', 'g2.txt')
    // The workers' swarm.node records, as spawn.ts writes them; this process never noted their spawns.
    for (const [node, agentId] of [
      ['executor', 'ex-1'],
      ['critic', 'cr-1'],
    ] as const) {
      await appendLaunchRecord(w.p, w.litterDir, s.name, s.launch, 'swarm.node', {
        node,
        n: 1,
        agentId,
        parentAgentId: 'run-1',
        kind: 'worker',
        cwd: w.dir,
        branch: null,
        model: null,
        revision: s.revision,
        generation: 1,
      })
    }
    resetGateForTests()
    const tip = await tipOf()
    expect(await gate('land', 'run-1', { gate: 'G2', verify_id: vid })).toEqual({
      ok: true,
      landed: false,
      retry: false,
      reason: `plan-template swarm ${x.name} started 2 agents, past its budget of 1; ${ASK}`,
    })
    expect(await tipOf()).toBe(tip)
  })
})

describe("the repair generation's end (decision 12)", () => {
  test('done once every gate of the plan has a land; the run is taken off the policy, and the summary says what landed', async () => {
    await started()
    const g2 = await landed('G2', 'g2.txt')
    const g3 = await landed('G3', 'g3.txt')
    const r = await endRepairGeneration(w.p, x.runDir, { status: 'done', reason: null })
    expect(r).toEqual({ recorded: true, end: { taskId: null, generation: 2, status: 'done', reason: null, source: 'mod' } })
    expect((await readPolicy(w.p, w.litterDir))?.run ?? null).toBeNull()
    const text = readFileSync(summaryPath(x.runDir), 'utf8')
    expect(text).toContain(`It landed G2 (${g2.commit.slice(0, 12)}) and G3 (${g3.commit.slice(0, 12)}) on ${BRANCH}: generation 2 ended done.`)
  })

  test("halted with a gate not landed, whatever the outcome said; what's uncommitted stays in the checkout", async () => {
    await started()
    await landed('G2', 'g2.txt')
    write(w.dir, 'g3.txt', 'G3 half done\n')
    const r = await endRepairGeneration(w.p, x.runDir, { status: 'done', reason: null })
    expect(r.end).toEqual(expect.objectContaining({ generation: 2, status: 'halted', reason: `repair swarm ${x.name} ended with gate G3 not landed` }))
    expect(w.p.logs.some(l => l.includes(`repair swarm ${x.name} ended done, but generation 2 isn't done (repair swarm ${x.name} ended with gate G3 not landed), so it ends halted`))).toBe(true)
    expect(existsSync(join(w.dir, 'g3.txt'))).toBe(true)
    expect((await w.git('status', '--porcelain', '--', 'g3.txt')).trim()).toBe('?? g3.txt')
    const text = readFileSync(summaryPath(x.runDir), 'utf8')
    expect(text).toContain('It ended halted')
    expect(text).toContain("and G3 hasn't landed")
  })

  test("halted with the outcome's reason when it gives one", async () => {
    await started()
    const r = await endRepairGeneration(w.p, x.runDir, { status: 'halted', reason: 'the runner reported blocked: G2 needs a scope change' })
    expect(r.end).toEqual(expect.objectContaining({ status: 'halted', reason: 'the runner reported blocked: G2 needs a scope change' }))
  })

  test('with a goal check: halted with no goal verify after the last land', async () => {
    await started({ goal: true })
    // A goal verify before the last land doesn't count.
    await landed('G2', 'g2.txt')
    await verify('run-1', 'goal')
    await landed('G3', 'g3.txt')
    const r = await endRepairGeneration(w.p, x.runDir, { status: 'done', reason: null })
    expect(r.end).toEqual(expect.objectContaining({ status: 'halted', reason: `every gate landed, but repair swarm ${x.name} ran no goal check after the last land` }))
  })

  test('with a goal check: halted when the latest goal verify is red', async () => {
    await started({ goal: true })
    await landed('G2', 'g2.txt')
    await landed('G3', 'g3.txt')
    write(w.dir, '.claude/goal-red', 'red\n')
    const v = await verify('run-1', 'goal')
    expect(v.green).toBe(false)
    const r = await endRepairGeneration(w.p, x.runDir, { status: 'done', reason: null })
    expect(r.end).toEqual(expect.objectContaining({ status: 'halted', reason: `every gate landed, but the goal check ${v.verify_id} wasn't green (exit 1)` }))
  })

  test('with a goal check: halted when the goal verify ran on another tree than the landed one', async () => {
    await started({ goal: true })
    await landed('G2', 'g2.txt')
    const g3 = await landed('G3', 'g3.txt')
    write(w.dir, 'extra.txt', 'not landed\n')
    const v = await verify('run-1', 'goal')
    expect(v.green).toBe(true)
    const landedTree = (await w.git('rev-parse', `${g3.commit}^{tree}`)).trim()
    const r = await endRepairGeneration(w.p, x.runDir, { status: 'done', reason: null })
    expect(r.end).toEqual(expect.objectContaining({ status: 'halted', reason: `every gate landed, but the goal check ${v.verify_id} ran on tree ${v.tree}, not the landed tree ${landedTree}` }))
  })

  test('with a goal check: done once a green goal verify of the landed tree follows the last land', async () => {
    await started({ goal: true })
    await landed('G2', 'g2.txt')
    await landed('G3', 'g3.txt')
    expect((await verify('run-1', 'goal')).green).toBe(true)
    const r = await endRepairGeneration(w.p, x.runDir, { status: 'done', reason: null })
    expect(r.end).toEqual(expect.objectContaining({ generation: 2, status: 'done', reason: null }))
    // Ended: the gates record nothing more.
    expect(asError(await gate('verify', 'cr-1', { gate: 'goal' })).error).toContain(`run ${RUN} has ended its repair generation`)
  })
})

describe("summary.md's repair generation part (lifecycle.ts, repairPart; WP-AG)", () => {
  test('its rounds are the rejections, an approval is listed with its gate and no index, and every gate it landed is listed', async () => {
    await started()
    const launch = liveSwarm(x.name)!.launch
    const rejected = await verify('cr-1', 'G2')
    expect(await judge('cr-1', rejected.verify_id, { reject: true })).toEqual(expect.objectContaining({ ok: true, round: 1 }))
    const land = async (g: string, file: string): Promise<{ verifyId: string; commit: string }> => {
      const verifyId = await approved(g, file)
      const r = (await gate('land', 'run-1', { gate: g, verify_id: verifyId })) as LandReply
      if (!r.ok || !r.landed) throw new Error(`${g}'s land was refused: ${JSON.stringify(r)}`)
      return { verifyId, commit: r.commit }
    }
    const g2 = await land('G2', 'g2.txt')
    const g3 = await land('G3', 'g3.txt')
    await endRepairGeneration(w.p, x.runDir, { status: 'done', reason: null })
    const lines = readFileSync(summaryPath(x.runDir), 'utf8').split('\n')
    const from = lines.indexOf('## Repair generation 2')
    expect(from).toBeGreaterThan(0)
    expect(lines.slice(from, lines.indexOf('- Ended: done', from) + 1)).toEqual([
      '## Repair generation 2',
      '',
      `- Swarm: ${x.name}, launch ${launch}`,
      '- Budget: 3 rounds and 6 agents',
      '- Verifies: 3 (3 green)',
      '- Rounds: 1 of 3',
      `  1. verify ${rejected.verify_id} (gate G2): rejected`,
      `  - verify ${g2.verifyId} (gate G2): approved`,
      `  - verify ${g3.verifyId} (gate G3): approved`,
      `- Landed: 2 gates on ${BRANCH}`,
      `  - G2: ${g2.commit}, verify ${g2.verifyId}`,
      `  - G3: ${g3.commit}, verify ${g3.verifyId}`,
      '- Ended: done',
    ])
  })

  test("with nothing landed it says no, and an approval that didn't land is no round either", async () => {
    await started()
    const v = await verify('cr-1', 'G2')
    await judge('cr-1', v.verify_id, { reject: true })
    const a = await approved('G2', 'g2.txt')
    await endRepairGeneration(w.p, x.runDir, { status: 'halted', reason: 'the runner reported blocked' })
    const text = readFileSync(summaryPath(x.runDir), 'utf8')
    expect(text).toContain(
      `- Rounds: 1 of 3\n  1. verify ${v.verify_id} (gate G2): rejected\n  - verify ${a} (gate G2): approved\n- Landed: no\n- Ended: halted (the runner reported blocked)`,
    )
  })
})

describe("the spawn's budget line (spawn.ts; WP-AG)", () => {
  /** The bridge's swarm with only its runner bound, and the runner's spawn of the executor through the spawn check. */
  async function spawnExecutor(): Promise<{ r: AgentSpawnResult; prompts: string[] }> {
    const s = liveSwarm(x.name)!
    const prompts: string[] = []
    const next = async (e: AgentSpawnInput): Promise<AgentSpawnResult> => {
      prompts.push(e.prompt)
      return { model: 'inherit', agentId: 'ex-1' }
    }
    const e: AgentSpawnInput = {
      tool_use_id: 'toolu_ex1',
      prompt: 'Gate G2 of the plan',
      description: 'G2',
      subagentType: s.types.executor!,
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'opus',
      background: false,
      fork: false,
      parentAgentId: 'run-1',
    }
    return { r: (await swarmSpawn(w.p, e as never, next as never)) as AgentSpawnResult, prompts }
  }
  async function bridged(): Promise<void> {
    x = await executeRun(w)
    await continueAsRepair(w.p, x.runDir)
    if (!liveSwarm(x.name)) throw new Error(`the bridge didn't start the swarm: ${await declinedReason(x)}`)
    bind('run-1', 'runner', { kind: 'orchestrator', parent: null })
  }

  test("a plan-template swarm's instance block says a round is a rejecting verdict, chosen by its run's workflow", async () => {
    await bridged()
    const { r, prompts } = await spawnExecutor()
    expect(r.deny).toBeUndefined()
    expect(r.agentId).toBe('ex-1')
    expect(prompts[0]).toContain(
      "\nRepair budget left: 3 of 3 rounds (a round is a verdict that rejects an attempt; an approval uses none), 5 of 6 agents (the workers and agents the swarm's nodes start). Past either, litter refuses the next spawn or land: report blocked to your parent, saying what you need.\n",
    )
    expect(prompts[0]).not.toContain("a round is the critic's verdict on a new verify")
  })

  test("a run.json the gates can't read denies the spawn, recording no instance and starting nothing", async () => {
    await bridged()
    const s = liveSwarm(x.name)!
    const json = JSON.parse(readFileSync(join(x.runDir, 'run.json'), 'utf8')) as Record<string, unknown>
    await w.p.fs.write(join(x.runDir, 'run.json'), JSON.stringify({ ...json, base: 'not-a-commit' }))
    const { r, prompts } = await spawnExecutor()
    expect(r.deny).toBe(`litter: executor couldn't be prepared: run ${RUN}'s run.json has no valid base commit; it's written by run.start, and no record call can fix it`)
    expect(prompts).toEqual([])
    const launch = await readLaunchLedger(w.p, w.litterDir, s.name, s.launch)
    expect(launch.records.filter(rec => rec.kind === 'swarm.instance')).toEqual([])
  })
})
