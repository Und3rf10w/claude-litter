// Tier 2: a repair swarm's gates (hooks/swarm/gate.ts; WP-Y): who may call
// them, a node's verify run by the mod in its own directory, the critic's
// verdict and its rounds, the proposals it carries, and the land's own
// refusals before landRepaired (whose checks are repairland.spec.ts). Real
// git and real ledgers, in the world repair-harness.ts builds; runVerify is
// stood in for, except in "the real runVerify".

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import type { RecordError, RecordReply } from '../../hooks/records/core'
import type { LiveSwarm } from '../../hooks/swarm/types'
import type { SwarmVerdictBody, VerifyBody } from '../../hooks/records/execute'
import { appendRecord } from '../../hooks/ledgercore'
import { snapshot } from '../../hooks/snapshot'
import { normalizeOptions } from '../../hooks/options'
import { swarmGateRecord } from '../../hooks/swarm/gate'
import { readRuleLedger } from '../../hooks/rules/ledger'
import * as state from '../../hooks/swarm/state'
import {
  ALL_PASS,
  B_FAILS,
  RUN,
  SWARM,
  TASKS,
  approved,
  bind,
  criticVerifies,
  fixerCommits,
  gate,
  gateEvents,
  judge,
  repairSpec,
  repairWorld,
  runKinds,
  runRecords,
  teardown,
  typeOf,
  useStandIn,
  verifyCalls,
  type World,
} from './repair-harness'

setDefaultTimeout(120_000)

let w: World | null = null
beforeEach(async () => {
  w = await repairWorld()
  useStandIn()
})
afterEach(() => {
  teardown(w)
  w = null
})

const world = (): World => w!
const asError = (r: RecordReply): RecordError => {
  expect(r.ok).toBe(false)
  return r as RecordError
}
/** A verify reply's verify_id. */
const idOf = (r: RecordReply): string => {
  expect(r.ok).toBe(true)
  return (r as unknown as { verify_id: string }).verify_id
}
/** The run ledger's kinds after the reopen (seq > run.repair's). */
const since = async (): Promise<string[]> => (await runRecords(world())).filter(r => r.seq > world().gen.seq).map(r => r.kind)

describe('the caller', () => {
  test('an agent a node started is refused, naming kind, and nothing is run or recorded', async () => {
    bind(world(), 'kid-1', 'critic', { kind: 'child', n: 0, of: 'crit-1', parent: 'crit-1', token: null })
    for (const kind of ['verify', 'verdict', 'land'] as const) {
      const e = asError(await gate(world(), kind, 'kid-1', { verify_id: 'v' }))
      expect(e.field).toBe('kind')
      expect(e.error).toBe(`litter: an agent a node started records no ${kind}; its node critic records the swarm's ${kind}s, so report to it`)
    }
    expect(verifyCalls).toEqual([])
    expect(await since()).toEqual([])
  })

  test('a swarm that is ending, read-only or handed over records nothing', async () => {
    const cases: [Partial<LiveSwarm>, string][] = [
      [{ state: 'stopping' }, `swarm ${SWARM} is ending`],
      [{ readOnly: true }, `swarm ${SWARM} is another session's; this session only shows it`],
      [{ lost: true }, `swarm ${SWARM} was handed to another session; this session no longer runs it`],
    ]
    for (const [over, text] of cases) {
      state.patchLiveSwarm(SWARM, { state: 'live', readOnly: false, lost: false, ...over })
      expect(asError(await gate(world(), 'verify', 'crit-1'))).toEqual({ ok: false, field: 'kind', error: `litter: ${text}, so it records no verify` })
    }
    // A binding the dispatcher found just before the swarm was dropped.
    const b = state.binding('crit-1')!
    state.dropLiveSwarm(SWARM)
    const gone = await swarmGateRecord(world().p, { kind: 'verify', input: { kind: 'verify' }, caller: { agentId: 'crit-1', agentType: b.type }, binding: b, litterDir: world().litterDir, options: normalizeOptions({}) })
    expect(asError(gone).error).toBe(`litter: swarm ${SWARM} isn't live, so it records no verify`)
    expect(verifyCalls).toEqual([])
  })

  test("a swarm that repairs no run: only a repair swarm a run starts verifies, judges or lands", async () => {
    state.patchLiveSwarm(SWARM, { run: undefined })
    const e = asError(await gate(world(), 'verdict', 'crit-1', { verify_id: 'v' }))
    expect(e.field).toBe('kind')
    expect(e.error).toBe(`litter: swarm ${SWARM} repairs no run, so its nodes record no verdict: only a repair swarm a run starts verifies, judges or lands`)
  })

  test("the run's generation must be the swarm's, and open", async () => {
    state.patchLiveSwarm(SWARM, { run: { ...state.liveSwarm(SWARM)!.run!, generation: 3 } })
    expect(asError(await gate(world(), 'verify', 'crit-1'))).toEqual({
      ok: false,
      field: 'run',
      error: `litter: run ${RUN} is open for repair generation 2, not 3, so swarm ${SWARM} records no verify for it; report to your parent`,
    })
    state.patchLiveSwarm(SWARM, { run: { ...state.liveSwarm(SWARM)!.run!, generation: 2 } })
    await appendRecord(world().p, world().runDir, { run: RUN, kind: 'run.end', by: { source: 'mod' }, body: { generation: 2, status: 'halted', reason: 'x' } })
    expect(asError(await gate(world(), 'verify', 'crit-1')).error).toBe(
      `litter: run ${RUN} has ended its repair generation, so swarm ${SWARM} records no verify for it; report to your parent`,
    )
    expect(verifyCalls).toEqual([])
  })

  test("'run' is the swarm's own: another is refused with it allowed, its own is taken", async () => {
    expect(asError(await gate(world(), 'verify', 'crit-1', { run: '20261003-other' }))).toEqual({
      ok: false,
      field: 'run',
      allowed: [RUN],
      error: `litter: 'run' is your swarm's run, ${RUN}; leave it out`,
    })
    expect((await gate(world(), 'verify', 'crit-1', { run: RUN })).ok).toBe(true)
  })

  test('a node bound in another launch, out of the revision, or whose type changed is refused', async () => {
    bind(world(), 'old-1', 'critic', { launch: '20261001-000000' })
    expect(asError(await gate(world(), 'verify', 'old-1')).error).toContain('you were bound in launch 20261001-000000')
    bind(world(), 'gone-1', 'scout', { type: typeOf('scout') })
    expect(asError(await gate(world(), 'verify', 'gone-1')).error).toContain(`scout isn't in swarm ${SWARM}'s revision 1`)
    const b = state.binding('crit-1')!
    const r = await swarmGateRecord(world().p, {
      kind: 'verify',
      input: { kind: 'verify' },
      caller: { agentId: 'crit-1', agentType: 'general-purpose' },
      binding: b,
      litterDir: world().litterDir,
      options: normalizeOptions({}),
    })
    expect(asError(r).error).toBe(`litter: this node lost its type (general-purpose, not ${typeOf('critic')}); end your turn`)
    expect(verifyCalls).toEqual([])
  })
})

describe('verify', () => {
  test("runs the run's own argv in the node's own directory as gate repair, recorded as the node's, and mirrored", async () => {
    const red = await gate(world(), 'verify', 'crit-1', { gate: 'repair', attempt: 9, where: '/elsewhere' })
    expect(red).toEqual(expect.objectContaining({ ok: true, green: false, exit_code: 1, tree_changed: false }))
    expect(verifyCalls[0]).toEqual({
      gate: 'repair',
      attempt: 1,
      where: world().integration,
      by: { source: 'agent', agentId: 'crit-1', agentType: typeOf('critic') },
      timeoutMs: normalizeOptions({}).verifyTimeoutMs,
    })
    await fixerCommits(world())
    const green = await gate(world(), 'verify', 'fix-1')
    expect(green).toEqual(expect.objectContaining({ ok: true, green: true, exit_code: 0 }))
    expect(verifyCalls[1]?.attempt).toBe(2)
    const recs = (await runRecords(world())).filter(r => r.kind === 'verify' && r.seq > world().gen.seq)
    expect(recs.map(r => [r.body.gate, r.body.green, r.by])).toEqual([
      ['repair', false, { source: 'agent', agentId: 'crit-1', agentType: typeOf('critic') }],
      ['repair', true, { source: 'agent', agentId: 'fix-1', agentType: typeOf('fixer') }],
    ])
    const ids = [idOf(red), idOf(green)]
    expect(await gateEvents(world())).toEqual([
      { kind: 'gate', node: 'critic', agentId: 'crit-1', run: RUN, record: 'verify', seq: recs[0]!.seq, gate: 'repair', result: 'red', verify_id: ids[0] },
      { kind: 'gate', node: 'fixer', agentId: 'fix-1', run: RUN, record: 'verify', seq: recs[1]!.seq, gate: 'repair', result: 'green', verify_id: ids[1] },
    ])
  })

  test('a node without authority.verify is refused, and nothing runs', async () => {
    state.patchLiveSwarm(SWARM, { spec: repairSpec(world().integration, { critic: { authority: { commit: false } } }) })
    const e = asError(await gate(world(), 'verify', 'crit-1'))
    expect(e.field).toBe('kind')
    expect(e.error).toContain('critic has no verify authority (authority.verify)')
    expect(verifyCalls).toEqual([])
  })

  test('any gate but repair is refused, naming gate', async () => {
    expect(asError(await gate(world(), 'verify', 'crit-1', { gate: 'integration' }))).toEqual({
      ok: false,
      field: 'gate',
      allowed: ['repair'],
      error: "litter: a swarm node's verify is gate 'repair', run in your own directory; leave 'gate' out",
    })
    expect(verifyCalls).toEqual([])
  })
})

describe('verdict', () => {
  test("is recorded in the run's ledger as round 1, approved when every task passes, and mirrored", async () => {
    await fixerCommits(world())
    const v = await criticVerifies(world())
    const r = await judge(world(), v.verify_id)
    expect(r).toEqual({ ok: true, kind: 'verdict', run: RUN, seq: expect.any(Number), verify_id: v.verify_id, round: 1, approved: true, rounds_left: 2, proposed_rules: 0 })
    const rec = (await runRecords(world())).find(x => x.kind === 'verdict' && x.body.verify_id === v.verify_id)!
    expect(rec.by).toEqual({ source: 'agent', agentId: 'crit-1', agentType: typeOf('critic') })
    expect(rec.body).toEqual({ verify_id: v.verify_id, tasks: ALL_PASS, combined: 'the client and server agree on /v2', proposed_rules: [], round: 1, approved: true } satisfies SwarmVerdictBody)
    expect(state.roundsUsed(SWARM)).toBe(1)
    expect((await gateEvents(world())).at(-1)).toEqual({
      kind: 'gate', node: 'critic', agentId: 'crit-1', run: RUN, record: 'verdict', seq: rec.seq, gate: 'repair', result: 'approved', verify_id: v.verify_id, round: 1,
    })
  })

  test('a failing task makes it a rejection, a round all the same; the mod derives approved, never the node', async () => {
    const v = await criticVerifies(world())
    const r = await judge(world(), v.verify_id, B_FAILS, 'crit-1', { approved: true, round: 7 })
    expect(r).toEqual(expect.objectContaining({ ok: true, round: 1, approved: false, rounds_left: 2 }))
    expect((await gateEvents(world())).at(-1)).toEqual(expect.objectContaining({ record: 'verdict', result: 'rejected', round: 1 }))
  })

  test('its proposed rules are recorded as rule.propose, labelled as the critic\'s; one over 8 KiB refuses the verdict', async () => {
    const v = await criticVerifies(world())
    expect(asError(await judge(world(), v.verify_id, B_FAILS, 'crit-1', { proposed_rules: ['ok', 'x'.repeat(8 * 1024 + 1)] })).field).toBe('proposed_rules[1]')
    expect(await since()).toEqual(['verify'])
    const r = await judge(world(), v.verify_id, B_FAILS, 'crit-1', { proposed_rules: ['Call the server through its typed client, never a literal route.'] })
    expect(r).toEqual(expect.objectContaining({ ok: true, proposed_rules: 1 }))
    // AD's store: the repository's rules ledger, with the run and the swarm (decision 17); none in the run's.
    expect((await runRecords(world())).some(x => x.kind === 'rule.propose')).toBe(false)
    const rules = (await readRuleLedger(world().p, world().litterDir, 'repo')).records
    expect(rules.map(x => x.kind)).toEqual(['rule.propose'])
    expect(rules[0]!.by).toEqual({ source: 'agent', agentId: 'crit-1', agentType: typeOf('critic') })
    expect(rules[0]!.body).toEqual({ rule: 'Call the server through its typed client, never a literal route.', source: 'critic', run: RUN, index: 0, swarm: SWARM, verify_id: v.verify_id, round: 1 })
  })

  test('from a type without verdicts: true, from a child, or from a node that may write, it is refused', async () => {
    await fixerCommits(world())
    const fv = { verify_id: idOf(await gate(world(), 'verify', 'fix-1')) }
    expect(asError(await judge(world(), fv.verify_id, ALL_PASS, 'fix-1')).error).toBe(
      "litter: only a node whose type has verdicts: true records a verdict, and fixer's hasn't; the critic judges, so report to your parent",
    )
    bind(world(), 'kid-1', 'critic', { kind: 'child', n: 0, of: 'crit-1', parent: 'crit-1', token: null })
    expect(asError(await judge(world(), fv.verify_id, ALL_PASS, 'kid-1')).error).toContain('an agent a node started records no verdict')
    state.patchLiveSwarm(SWARM, { spec: repairSpec(world().integration, { critic: { tools: {}, authority: { verify: true } } }) })
    expect(asError(await judge(world(), fv.verify_id)).error).toBe(
      'litter: critic may write, so a verdict from it could judge its own change; a verdicts node writes nothing',
    )
    expect(await since()).toEqual(['verify'])
  })

  test("citing another agent's verify, one from before the generation, or none is refused, naming verify_id", async () => {
    await fixerCommits(world())
    const fv = { verify_id: idOf(await gate(world(), 'verify', 'fix-1')) }
    const other = asError(await judge(world(), fv.verify_id))
    expect(other.field).toBe('verify_id')
    expect(other.error).toContain(`verify ${fv.verify_id} wasn't recorded by you`)
    const before = asError(await judge(world(), 'integration-1-aaaaaaaaaa'))
    expect(before.error).toBe('litter: verify integration-1-aaaaaaaaaa is from before this repair (generation 2); verify the tree as it is now, and cite that')
    expect(asError(await judge(world(), 'repair-1-nope')).error).toContain(`run ${RUN} has no verify repair-1-nope`)
    expect(asError(await judge(world(), '')).field).toBe('verify_id')
    expect(await since()).toEqual(['verify'])
  })

  test('its tasks judge every task of the run exactly once, each with its fields', async () => {
    const v = await criticVerifies(world())
    const ids = TASKS.map(t => t.id)
    const missing = asError(await judge(world(), v.verify_id, B_FAILS.slice(1)))
    expect(missing).toEqual({ ok: false, field: 'tasks', allowed: ids, error: "litter: 'tasks' must judge every task of the run exactly once: missing a" })
    const twice = asError(await judge(world(), v.verify_id, [...B_FAILS, B_FAILS[0], { id: 'zz', pass: true, evidence: 'e' }]))
    expect(twice.error).toBe("litter: 'tasks' must judge every task of the run exactly once: repeated a; not a task of the run zz")
    expect(asError(await judge(world(), v.verify_id, 'nope')).field).toBe('tasks')
    expect(asError(await judge(world(), v.verify_id, [{ ...B_FAILS[0], pass: 'yes' }])).field).toBe('tasks[0].pass')
    expect(asError(await judge(world(), v.verify_id, [{ ...B_FAILS[0], evidence: ' ' }])).field).toBe('tasks[0].evidence')
    expect(asError(await judge(world(), v.verify_id, [{ ...B_FAILS[0], gaps: 'none' }])).field).toBe('tasks[0].gaps')
    expect(asError(await judge(world(), v.verify_id, B_FAILS, 'crit-1', { combined: '' })).field).toBe('combined')
    // gaps may be left out: [] then.
    const ok = await judge(world(), v.verify_id, B_FAILS.map(({ gaps: _g, ...t }) => t))
    expect(ok.ok).toBe(true)
    expect(state.roundsUsed(SWARM)).toBe(1)
  })

  test('a verify gets one verdict; passing every task on a red verify is refused', async () => {
    const red = await criticVerifies(world())
    expect(asError(await judge(world(), red.verify_id, ALL_PASS)).error).toContain(`verify ${red.verify_id} isn't green, so a verdict passing every task on it can't land`)
    expect((await judge(world(), red.verify_id, B_FAILS)).ok).toBe(true)
    expect(asError(await judge(world(), red.verify_id, B_FAILS)).error).toBe(
      `litter: verify ${red.verify_id} already has a verdict (round 1); verify the tree as it is now, and judge that`,
    )
    expect(state.roundsUsed(SWARM)).toBe(1)
  })

  test('the critic judges in the integration worktree, or not at all', async () => {
    const v = await criticVerifies(world())
    bind(world(), 'crit-1', 'critic', { cwd: world().dir })
    expect(asError(await judge(world(), v.verify_id)).error).toContain(`isn't the integration worktree ${world().integration} the repair commits in`)
  })

  test('one round past the budget is refused as the budget case, until the budget is raised', async () => {
    state.patchLiveSwarm(SWARM, { budget: { rounds: 1, agents: 6 } })
    const v1 = await criticVerifies(world())
    expect((await judge(world(), v1.verify_id, B_FAILS)).ok).toBe(true)
    const v2 = await criticVerifies(world())
    const e = asError(await judge(world(), v2.verify_id, B_FAILS))
    expect(e.field).toBe('kind')
    expect(e.error).toBe(
      `litter: repair swarm ${SWARM} has used all 1 of its repair rounds (each verdict on a new verify is one), so this verdict isn't recorded; ` +
        'report blocked to your parent, saying what more you need and for what; the lead can ask the user for it with repair.budget',
    )
    expect((await runKinds(world())).filter(k => k === 'verdict')).toHaveLength(2)
    // X raises the budget through the state; the next verdict reads it live.
    state.patchLiveSwarm(SWARM, { budget: { rounds: 2, agents: 6 } })
    expect(await judge(world(), v2.verify_id, B_FAILS)).toEqual(expect.objectContaining({ ok: true, round: 2, rounds_left: 0 }))
  })

  test("the rounds and their gate events are caught up from the ledger's verdicts (a lost mirror), each event once", async () => {
    const v1 = await criticVerifies(world())
    // A verdict an earlier process recorded, whose round the state never noted and whose event was never appended.
    const lost = await appendRecord(world().p, world().runDir, {
      run: RUN,
      kind: 'verdict',
      by: { source: 'agent', agentId: 'crit-0', agentType: typeOf('critic') },
      body: { verify_id: v1.verify_id, tasks: B_FAILS, combined: 'no', proposed_rules: [], round: 1, approved: false } satisfies SwarmVerdictBody,
    })
    expect(state.roundsUsed(SWARM)).toBe(0)
    const v2 = await criticVerifies(world())
    const r2 = await judge(world(), v2.verify_id, B_FAILS)
    expect(r2).toEqual(expect.objectContaining({ ok: true, round: 2 }))
    expect(state.roundOf(SWARM, v1.verify_id)).toBe(1)
    expect(state.roundOf(SWARM, v2.verify_id)).toBe(2)
    const v3 = await criticVerifies(world())
    expect(await judge(world(), v3.verify_id, B_FAILS)).toEqual(expect.objectContaining({ ok: true, round: 3 }))
    // One event per verdict, the lost one as its own agent's (its binding gone, its node from its type).
    expect((await gateEvents(world())).filter(e => e.record === 'verdict').map(e => [e.seq, e.node, e.agentId, e.verify_id, e.round, e.result])).toEqual([
      [lost.seq, 'critic', 'crit-0', v1.verify_id, 1, 'rejected'],
      [(r2 as unknown as { seq: number }).seq, 'critic', 'crit-1', v2.verify_id, 2, 'rejected'],
      [expect.any(Number), 'critic', 'crit-1', v3.verify_id, 3, 'rejected'],
    ])
  })

  test('concurrent verdicts on distinct verifies at the edge take one round between them', async () => {
    state.patchLiveSwarm(SWARM, { budget: { rounds: 1, agents: 6 } })
    bind(world(), 'crit-2', 'critic', { n: 2 })
    const a = await criticVerifies(world(), 'crit-1')
    const b = await criticVerifies(world(), 'crit-2')
    const [ra, rb] = await Promise.all([judge(world(), a.verify_id, B_FAILS, 'crit-1'), judge(world(), b.verify_id, B_FAILS, 'crit-2')])
    expect([ra.ok, rb.ok].sort()).toEqual([false, true])
    expect((await runKinds(world())).filter(k => k === 'verdict')).toHaveLength(2)
    expect(state.roundsUsed(SWARM)).toBe(1)
  })
})

describe("land's own refusals", () => {
  test('a node without authority.land, a missing verify_id, or a gate but fanout is refused before anything is read', async () => {
    const { verifyId } = await approved(world())
    const critic = asError(await gate(world(), 'land', 'crit-1', { verify_id: verifyId }))
    expect(critic).toEqual({
      ok: false,
      field: 'kind',
      error: 'litter: critic has no land authority (authority.land), so it lands nothing; report the approved verify to your parent',
    })
    expect(asError(await gate(world(), 'land', 'orch-1')).field).toBe('verify_id')
    expect(asError(await gate(world(), 'land', 'orch-1', { verify_id: verifyId, gate: 'G1' }))).toEqual({
      ok: false,
      field: 'gate',
      allowed: ['fanout'],
      error: "litter: a repair swarm lands its run's integration, gate 'fanout'; leave 'gate' out",
    })
    expect((await runKinds(world())).filter(k => k.startsWith('land'))).toEqual([])
  })
})

describe('the real runVerify', () => {
  test("a node's verify runs the run's argv in the node's directory, gate repair, recorded as the node's agent", async () => {
    teardown(null)
    w = await repairWorld()
    const id = idOf(await gate(world(), 'verify', 'crit-1'))
    const rec = (await runRecords(world())).find(r => r.kind === 'verify' && r.body.verify_id === id)!
    const body = rec.body as unknown as VerifyBody
    expect(body.gate).toBe('repair')
    expect(id).toMatch(/^repair-1-[0-9a-f]{10}$/)
    expect(rec.seq).toBeGreaterThan(world().gen.seq)
    expect(rec.by).toEqual(expect.objectContaining({ source: 'agent', agentId: 'crit-1' }))
    const snap = await snapshot(world().p, world().integration)
    expect(body.tree_before).toBe(snap.tree)
    expect(verifyCalls).toEqual([])
  })
})
