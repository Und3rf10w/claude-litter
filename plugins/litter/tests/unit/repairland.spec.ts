// Tier 2: a repair swarm's land (hooks/land.ts, landRepaired; WP-Y), through
// the gate the orchestrator calls, against a real scratch repository: the
// committed integration tip lands on the run's ref with landFanout's own steps
// once the critic's approving verdict cites a green verify of it; each check
// before the intent refuses on its own and moves nothing; a crash after the
// intent is reconciled at the next land; after a reload, the spawns are
// counted from the launch's ledger before the land (WP-AG). The world is
// repair-harness.ts's.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordReply } from '../../hooks/records/core'
import type { LandBody, LandIntentBody, LandReply, SwarmVerdictBody } from '../../hooks/records/execute'
import type { SwarmNodeBody } from '../../hooks/records/swarm'
import { appendRecord } from '../../hooks/ledgercore'
import { wholeResult } from '../../hooks/integrate'
import { reconcileLands } from '../../hooks/land'
import { launchDir } from '../../hooks/layout'
import { appendLaunchRecord } from '../../hooks/records/swarm'
import { resetGateForTests } from '../../hooks/swarm/gate'
import { readRunFacts, type RunFacts } from '../../hooks/verify'
import * as state from '../../hooks/swarm/state'
import {
  ALL_PASS,
  B_FAILS,
  BRANCH,
  IB,
  REF,
  RUN,
  SWARM,
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
  write,
  type World,
} from './repair-harness'

setDefaultTimeout(120_000)

const ASK = 'report blocked to your parent, saying what more you need and for what; the lead can ask the user for it with repair.budget'

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
const land = (verifyId: string, agentId = 'orch-1'): Promise<RecordReply> => gate(world(), 'land', agentId, { verify_id: verifyId })
const refTip = async (): Promise<string> => (await world().git('rev-parse', REF)).trim()
/** Tracked changes in the checkout (the litter folder is the mod's, untracked). */
const status = async (): Promise<string> => (await world().git('status', '--porcelain', '--untracked-files=no')).trim()
const landKinds = async (): Promise<string[]> => (await runKinds(world())).filter(k => k.startsWith('land'))

/** A refusal: landed false, the reason, the retry flag; nothing moved and no intent. */
async function refused(r: RecordReply, reason: string | RegExp, retry = false): Promise<void> {
  expect(r.ok).toBe(true)
  const l = r as LandReply
  expect(l.landed).toBe(false)
  if (typeof reason === 'string') expect(l.reason).toBe(reason)
  else expect(l.reason).toMatch(reason)
  expect(l.retry).toBe(retry)
  expect(await refTip()).toBe(world().base)
  expect(await landKinds()).toEqual([])
}

/** A verdict appended directly, as a gate would never record it, by `agentId` of `node`'s type. */
const verdictBy = (verifyId: string, agentId: string, node: string, over: Partial<SwarmVerdictBody> = {}) =>
  appendRecord(world().p, world().runDir, {
    run: RUN,
    kind: 'verdict',
    by: { source: 'agent', agentId, agentType: typeOf(node) },
    body: { verify_id: verifyId, tasks: ALL_PASS, combined: 'fine', proposed_rules: [], round: 1, approved: true, ...over } satisfies SwarmVerdictBody,
  })

describe('a real land', () => {
  test("the integration branch's committed tip lands on the run's ref with fanout's steps, the checkout clean there, and mirrored", async () => {
    const { verifyId, tip } = await approved(world())
    const tree = (await world().git('rev-parse', `${tip}^{tree}`)).trim()
    expect(await land(verifyId)).toEqual({ ok: true, landed: true, commit: tip, retry: false })
    expect(await refTip()).toBe(tip)
    expect((await world().git('symbolic-ref', 'HEAD')).trim()).toBe(REF)
    expect(await status()).toBe('')
    expect(readFileSync(join(world().dir, 'pkgB/b.ts'), 'utf8')).toBe('fetch("/v2/items") // fixed\n')
    expect(readFileSync(join(world().dir, 'pkgA/a.ts'), 'utf8')).toBe('export const route = "/v2/items"\n')

    const recs = (await runRecords(world())).filter(r => r.kind.startsWith('land'))
    expect(recs.map(r => [r.kind, r.by])).toEqual([
      ['land.intent', { source: 'mod' }],
      ['land', { source: 'mod' }],
    ])
    expect(recs[0]!.body).toEqual({ gate: 'fanout', verify_id: verifyId, tree, old: world().base, ref: REF, mode: 'checkout', commit: tip } satisfies LandIntentBody)
    expect(recs[1]!.body).toEqual({ gate: 'fanout', verify_id: verifyId, commit: tip, tree, old: world().base, ref: REF } satisfies LandBody)
    expect((await gateEvents(world())).map(e => [e.node, e.record, e.result])).toEqual([
      ['critic', 'verify', 'green'],
      ['critic', 'verdict', 'approved'],
      ['repair', 'land', 'landed'],
    ])
    expect((await gateEvents(world())).at(-1)).toEqual({ kind: 'gate', node: 'repair', agentId: 'orch-1', run: RUN, record: 'land', seq: recs[1]!.seq, gate: 'fanout', result: 'landed', verify_id: verifyId })
  })

  test('is idempotent per verify_id: the same answer again, nothing more recorded or mirrored', async () => {
    const { verifyId, tip } = await approved(world())
    await land(verifyId)
    const before = [await runKinds(world()), await gateEvents(world())]
    expect(await land(verifyId)).toEqual({ ok: true, landed: true, commit: tip, retry: false })
    expect([await runKinds(world()), await gateEvents(world())]).toEqual(before)
  })

  test('a fanout lands once: a second approved verify is refused after the first landed', async () => {
    const first = await approved(world())
    await land(first.verifyId)
    const v = await criticVerifies(world())
    expect((await judge(world(), v.verify_id)).ok).toBe(true)
    const r = (await land(v.verify_id)) as LandReply
    expect(r).toEqual({ ok: true, landed: false, retry: false, reason: `run ${RUN} already landed ${first.tip} with verify ${first.verifyId}; a fanout lands once` })
  })
})

describe('refused before the intent, moving nothing', () => {
  test('with no verdict, or a verdict that cites another verify, or not the latest one', async () => {
    await fixerCommits(world())
    const v1 = await criticVerifies(world())
    await refused(await land(v1.verify_id), `no verdict cites verify ${v1.verify_id}; the critic records its own verify of the committed tree, then a verdict citing it`)
    expect((await judge(world(), v1.verify_id)).ok).toBe(true)
    const v2 = await criticVerifies(world())
    await refused(await land(v2.verify_id), `no verdict cites verify ${v2.verify_id}; the critic records its own verify of the committed tree, then a verdict citing it`)
    // The critic's later rejection supersedes its earlier approval.
    expect((await judge(world(), v2.verify_id, B_FAILS)).ok).toBe(true)
    await refused(await land(v1.verify_id), /^the verdict on verify .* isn't this repair's latest: round 2 on verify .* came after it/)
  })

  test("with a rejecting verdict, a red verify, or a verify from before the generation", async () => {
    await fixerCommits(world())
    const v = await criticVerifies(world())
    expect((await judge(world(), v.verify_id, B_FAILS)).ok).toBe(true)
    await refused(await land(v.verify_id), `the verdict on verify ${v.verify_id} doesn't approve every task: b didn't pass`)
    await refused(await land('integration-1-aaaaaaaaaa'), 'verify integration-1-aaaaaaaaaa is from before this repair (generation 2); verify the repaired tree and have it judged')
  })

  test('a red verify: an approving verdict on one (appended directly; the gate refuses it) lands nothing', async () => {
    const red = await criticVerifies(world())
    expect(red.green).toBe(false)
    await verdictBy(red.verify_id, 'crit-1', 'critic')
    await refused(await land(red.verify_id), /^verify .* isn't green \(/)
  })

  test("with a verdict from a type without verdicts: true, from another agent than the verify's, or from a node that may write (each appended directly)", async () => {
    await fixerCommits(world())
    const fv = await criticVerifies(world(), 'fix-1')
    // The fixer's own verify, its own verdict: a fixer's type has no verdicts.
    await verdictBy(fv.verify_id, 'fix-1', 'fixer')
    await refused(await land(fv.verify_id), `the verdict on verify ${fv.verify_id} isn't from a node of swarm ${SWARM} whose type has verdicts: true`)
    // The critic citing the fixer's verify.
    await verdictBy(fv.verify_id, 'crit-1', 'critic', { round: 2 })
    await refused(await land(fv.verify_id), `the verdict citing verify ${fv.verify_id} isn't from the agent that recorded it`)
    // A verdicts type that may write: the critic given commit authority.
    const cv = await criticVerifies(world())
    await verdictBy(cv.verify_id, 'crit-1', 'critic', { round: 3 })
    state.patchLiveSwarm(SWARM, { spec: repairSpec(world().integration, { critic: { authority: { commit: true, verify: true } } }) })
    await refused(await land(cv.verify_id), `the verdict on verify ${cv.verify_id} is from an agent that may write in ${world().integration}, so it could be judging its own change`)
  })

  test('with a verdict past the rounds, or the agents past the budget', async () => {
    await fixerCommits(world())
    const v = await criticVerifies(world())
    await verdictBy(v.verify_id, 'crit-1', 'critic', { round: 4 })
    await refused(await land(v.verify_id), /^the verdict on verify .* is round 4, past the repair budget's 3; report blocked to your parent/)
    state.patchLiveSwarm(SWARM, { budget: { rounds: 4, agents: 1 } })
    state.noteSpawned(SWARM, 'k1')
    state.noteSpawned(SWARM, 'k2')
    await refused(await land(v.verify_id), `repair swarm ${SWARM} started 2 agents, past its budget of 1; report blocked to your parent, saying what more you need and for what; the lead can ask the user for it with repair.budget`)
  })

  test('with uncommitted work in the integration worktree, retry true', async () => {
    const { verifyId } = await approved(world())
    write(world().integration, 'pkgB/b.ts', 'fetch("/v2/items") // fixed, and more\n')
    await refused(await land(verifyId), `the integration worktree ${world().integration} has uncommitted changes on top of ${IB}'s tip; commit them on ${IB} or discard them, then verify and judge the tip`, true)
  })

  test('with a tree committed after the verify, retry true', async () => {
    const { verifyId } = await approved(world())
    const tip = await fixerCommits(world(), { 'pkgA/a.ts': 'export const route = "/v3/items"\n' })
    const tree = (await world().git('rev-parse', `${tip}^{tree}`)).trim()
    await refused(await land(verifyId), new RegExp(`^verify ${verifyId} ran on tree [0-9a-f]+, but ${IB}'s tip ${tip} has tree ${tree}: what lands is the committed tip`), true)
  })

  test('with the integration worktree off its branch', async () => {
    const { verifyId } = await approved(world())
    await world().gitIn(world().integration, 'switch', '-q', '--detach')
    await refused(await land(verifyId), `the integration worktree ${world().integration} is on a detached HEAD, not ${IB}; the repair commits on ${IB}`)
  })

  test("with a tip that rewrote the integration instead of adding to it", async () => {
    await fixerCommits(world())
    // The same files in one commit on base: the integration's merges are gone from its history.
    await world().gitIn(world().integration, 'reset', '-q', '--soft', world().base)
    await world().gitIn(world().integration, 'commit', '-q', '-m', 'squashed')
    const v = await criticVerifies(world())
    expect(v.green).toBe(true)
    expect((await judge(world(), v.verify_id)).ok).toBe(true)
    await refused(await land(v.verify_id), /^litter\/20261003-repair-integration's tip [0-9a-f]+ doesn't descend from the integration's tip [0-9a-f]+; a repair adds commits on/)
  })

  test('with a path no task owns: the scope case', async () => {
    await fixerCommits(world(), { 'pkgB/b.ts': 'fetch("/v2/items") // fixed\n', 'tools/route.ts': 'export {}\n' })
    const v = await criticVerifies(world())
    expect((await judge(world(), v.verify_id)).ok).toBe(true)
    await refused(
      await land(v.verify_id),
      "the repaired change fails the ownership check: tools/route.ts is owned by no task. Changing a path no task of the run owns changes what was asked: that's the scope case, so report blocked to your parent with the paths and why",
    )
  })

  test("a path of a task that wasn't merged is the repair's to finish (wholeResult, owners: 'all'); one no task owns still blocks", async () => {
    const tip = await fixerCommits(world(), { 'pkgB/b.ts': 'fetch("/v2/items") // fixed\n', 'tools/route.ts': 'export {}\n' })
    const f = (await readRunFacts(world().p, world().runDir, RUN)) as RunFacts
    // The ledger as it would read had b's merge stopped at a conflict.
    const records = (await runRecords(world())).filter(r => !(r.kind === 'integrate.merge' && r.body.task === 'b'))
    const merged = await wholeResult(world().p, f, records, tip)
    expect(merged.blocked).toEqual(['README.md belongs to task b, which wasn\'t merged', 'pkgB/b.ts belongs to task b, which wasn\'t merged', 'tools/route.ts is owned by no task'])
    const all = await wholeResult(world().p, f, records, tip, { owners: 'all' })
    expect(all.blocked).toEqual(['tools/route.ts is owned by no task'])
    expect(all.changed).toEqual([
      { path: 'README.md', task: 'b' },
      { path: 'pkgA/a.ts', task: 'a' },
      { path: 'pkgB/b.ts', task: 'b' },
      { path: 'tools/route.ts', task: null },
    ])
  })

  test('with an edited checkout, retry true, and the edit kept', async () => {
    const { verifyId } = await approved(world())
    write(world().dir, 'README.md', 'my edit\n')
    await refused(
      await land(verifyId),
      `the checkout changed after the launch (it no longer snapshots to base ${world().base}), so moving the repaired files in would overwrite or mix in those changes; commit, stash or discard them, then land again`,
      true,
    )
    expect(readFileSync(join(world().dir, 'README.md'), 'utf8')).toBe('my edit\n')
  })

  test("with the ref moved, or the checkout off the run's branch", async () => {
    const { verifyId } = await approved(world())
    const baseTree = (await world().git('rev-parse', `${world().base}^{tree}`)).trim()
    const moved = (await world().p.run(['git', 'commit-tree', baseTree, '-p', world().base, '-m', 'someone else'], { cwd: world().dir })).stdout.trim()
    await world().git('update-ref', REF, moved, world().base)
    expect(await status()).toBe('')
    const r = (await land(verifyId)) as LandReply
    expect(r).toEqual({ ok: true, landed: false, retry: false, reason: `${BRANCH} is at ${moved}, not the run's base ${world().base}; something else moved it` })
    expect(await landKinds()).toEqual([])
    await world().git('update-ref', REF, world().base, moved)
    await world().git('switch', '-q', 'main')
    await refused(await land(verifyId), `the checkout is on main, not ${BRANCH}; switch back (git switch ${BRANCH}) and land again`)
  })

  test('a repair swarm with no budget lands nothing', async () => {
    const { verifyId } = await approved(world())
    state.patchLiveSwarm(SWARM, { budget: undefined })
    await refused(await land(verifyId), `repair swarm ${SWARM} has no repair budget, so nothing it made lands`)
  })
})

describe("the budget's recount after a reload (WP-AG)", () => {
  /** The workers' swarm.node records, as spawn.ts writes them at each spawn. */
  const spawned = async (): Promise<void> => {
    for (const [node, agentId] of [
      ['fixer', 'fix-1'],
      ['critic', 'crit-1'],
    ] as const) {
      await appendLaunchRecord(world().p, world().litterDir, SWARM, world().launch, 'swarm.node', {
        node,
        n: 1,
        agentId,
        parentAgentId: 'orch-1',
        kind: 'worker',
        cwd: world().integration,
        branch: null,
        model: null,
        revision: 1,
        generation: 1,
      } satisfies SwarmNodeBody)
    }
  }

  test("a land before any spawn of a fresh module counts the launch's spawns first, so past the agents budget it's refused", async () => {
    const { verifyId } = await approved(world())
    state.patchLiveSwarm(SWARM, { budget: { rounds: 3, agents: 1 } })
    await spawned()
    // A reload: a fresh gate module, and a state that never noted those spawns.
    resetGateForTests()
    expect(state.spawnsUsed(SWARM)).toBe(0)
    await refused(await land(verifyId), `repair swarm ${SWARM} started 2 agents, past its budget of 1; ${ASK}`)
    expect(state.spawnsUsed(SWARM)).toBe(2)
  })

  test("a launch ledger that can't be counted lands nothing, the next land counts again, and a land already made answers as it did", async () => {
    const { verifyId, tip } = await approved(world())
    await spawned()
    const ledger = join(launchDir(world().litterDir, SWARM, world().launch), 'ledger')
    // The fixer's swarm.node record, the first of the two: the critic's after it no longer chains to it.
    const name = readdirSync(ledger).sort().find(f => f.endsWith('-swarm.node.json'))!
    const good = readFileSync(join(ledger, name), 'utf8')
    expect(good).toContain('"fix-1"')
    writeFileSync(join(ledger, name), good.replace('"fix-1"', '"fix-9"'))
    resetGateForTests()
    await refused(
      await land(verifyId),
      new RegExp(`^swarm ${SWARM}'s repair budget couldn't be counted, so nothing lands: launch ${world().launch}'s ledger is tampered at record `),
    )
    writeFileSync(join(ledger, name), good)
    expect(await land(verifyId)).toEqual({ ok: true, landed: true, commit: tip, retry: false })
    // Sent again once it landed, with the ledger broken again in a fresh module: the land's own answer, not the count's.
    writeFileSync(join(ledger, name), good.replace('"fix-1"', '"fix-9"'))
    resetGateForTests()
    expect(await land(verifyId)).toEqual({ ok: true, landed: true, commit: tip, retry: false })
  })
})

describe('the steps after the intent', () => {
  test('the ref moved during the land: the swap refuses, the checkout is re-synced, and the intent abandoned', async () => {
    const { verifyId } = await approved(world())
    const p = world().p
    const run = p.run
    const baseTree = (await world().git('rev-parse', `${world().base}^{tree}`)).trim()
    const other = (await run(['git', 'commit-tree', baseTree, '-p', world().base, '-m', 'raced'], { cwd: world().dir })).stdout.trim()
    p.run = async (argv, init) => {
      if (argv.includes('update-ref') && argv.includes(REF) && argv.at(-1) === world().base) await run(['git', 'update-ref', REF, other, world().base], { cwd: world().dir })
      return run(argv, init)
    }
    try {
      const r = (await land(verifyId)) as LandReply
      expect(r.landed).toBe(false)
      expect(r.reason).toStartWith(`${BRANCH} moved during the land (it's at ${other}), so nothing landed`)
    } finally {
      p.run = run
    }
    expect(await refTip()).toBe(other)
    expect(await status()).toBe('')
    expect(await landKinds()).toEqual(['land.intent', 'land.abandoned'])
    expect((await gateEvents(world())).at(-1)).toEqual(expect.objectContaining({ record: 'land', result: 'not-landed', verify_id: verifyId }))
  })
})

describe('a crash after the intent, reconciled at the next land', () => {
  /**
   * Runs the land with the mod stopping at the first git call `at` matches:
   * the run port throws as it's called, before any promise, so the land's
   * git wrapper (which turns a rejection into a failed step) can't catch it,
   * and nothing after that step happens, as when the process dies there.
   */
  async function crashAt(verifyId: string, at: (argv: readonly string[]) => boolean): Promise<void> {
    const p = world().p
    const run = p.run
    p.run = (argv, init) => {
      if (at(argv)) throw new Error('the mod crashed')
      return run(argv, init)
    }
    try {
      await expect(land(verifyId)).rejects.toThrow('the mod crashed')
    } finally {
      p.run = run
    }
  }

  test('after the swap: the next land records it landed, recovered, and answers with its commit', async () => {
    const { verifyId, tip } = await approved(world())
    // The re-sync, after the swap.
    await crashAt(verifyId, argv => argv.includes('read-tree') && argv.at(-1) === 'HEAD' && argv.at(-2) === tip)
    expect(await refTip()).toBe(tip)
    expect(await landKinds()).toEqual(['land.intent'])
    expect(await land(verifyId)).toEqual({ ok: true, landed: true, commit: tip, retry: false })
    const last = (await runRecords(world())).at(-1)!
    expect(last.kind).toBe('land')
    expect(last.body).toEqual(expect.objectContaining({ gate: 'fanout', verify_id: verifyId, commit: tip, recovered: true }))
    expect(await status()).toBe('')
    expect((await gateEvents(world())).at(-1)).toEqual(expect.objectContaining({ record: 'land', result: 'landed', verify_id: verifyId, seq: last.seq }))
  })

  test("after the swap, recovered by session.start's reconcile: the next land answers with its commit and mirrors that land once", async () => {
    const { verifyId, tip } = await approved(world())
    await crashAt(verifyId, argv => argv.includes('read-tree') && argv.at(-1) === 'HEAD' && argv.at(-2) === tip)
    expect(await reconcileLands(world().p, world().runDir, RUN)).toEqual({ problems: [] })
    const recovered = (await runRecords(world())).at(-1)!
    expect([recovered.kind, recovered.body.recovered, recovered.body.verify_id]).toEqual(['land', true, verifyId])
    expect((await gateEvents(world())).filter(e => e.record === 'land')).toEqual([])
    expect(await land(verifyId)).toEqual({ ok: true, landed: true, commit: tip, retry: false })
    expect(await land(verifyId)).toEqual({ ok: true, landed: true, commit: tip, retry: false })
    expect((await gateEvents(world())).filter(e => e.record === 'land')).toEqual([
      { kind: 'gate', node: 'repair', agentId: 'orch-1', run: RUN, record: 'land', seq: recovered.seq, gate: 'fanout', result: 'landed', verify_id: verifyId },
    ])
  })

  test('before the swap: the next land puts the checkout back, abandons the intent, and lands', async () => {
    const { verifyId, tip } = await approved(world())
    await crashAt(verifyId, argv => argv.includes('update-ref') && argv.includes(REF))
    // The files moved, the ref didn't.
    expect(await refTip()).toBe(world().base)
    expect(await status()).not.toBe('')
    expect(await land(verifyId)).toEqual({ ok: true, landed: true, commit: tip, retry: false })
    expect(await landKinds()).toEqual(['land.intent', 'land.abandoned', 'land.intent', 'land'])
    expect(await status()).toBe('')
    expect((await gateEvents(world())).filter(e => e.record === 'land').map(e => e.result)).toEqual(['not-landed', 'landed'])
  })
})

describe('the critic in its place', () => {
  test("a critic bound elsewhere than the integration worktree can't record the verdict a land needs", async () => {
    await fixerCommits(world())
    bind(world(), 'crit-2', 'critic', { n: 2, cwd: world().dir })
    const v = await criticVerifies(world(), 'crit-2')
    // Its verify ran on the checkout, which isn't the repaired tree, so it's red; it can't judge it at all.
    expect(v.green).toBe(false)
    expect((await judge(world(), v.verify_id, B_FAILS, 'crit-2')).ok).toBe(false)
    expect(await runKinds(world())).not.toContain('rule.propose')
    expect((await runRecords(world())).filter(r => r.kind === 'verdict' && r.seq > world().gen.seq)).toEqual([])
    await refused(await land(v.verify_id), /^verify .* isn't green \(exit 2\)$/)
  })
})
