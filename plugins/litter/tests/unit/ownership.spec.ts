// Tier 2: a swarm's ownership across sessions and crashes (FIX-Q; plan 15.4,
// "Ownership", "A stale owner stands down", "After /clear"). Real git refs in
// a scratch repository (swarmlaunch-harness.ts), the real policy.json writers
// and ledgers. A second session is a second nodePorts with its own session id
// on the same repository: `w.restart` for a new process of this module, a
// bare nodePorts for another session's writes while this process runs on.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Policy } from '../../hooks/hookfiles'
import type { NodeBinding, SwarmSpec } from '../../hooks/swarm/types'
import { activePath, agentPolicyPath, launchSummaryPath, policyPath } from '../../hooks/layout'
import { atomicWriteJson } from '../../hooks/fsx'
import { readPolicy, setActive } from '../../hooks/policy'
import { deactivate } from '../../hooks/lifecycle'
import { readLaunchLedger } from '../../hooks/records/swarm'
import { liveSwarm } from '../../hooks/swarm/state'
import { heldBy, notNewer, patchSwarmPolicy, releaseActive, removeNodePolicy, writeSwarmPolicy } from '../../hooks/swarm/guard'
import { deps as ownerDeps, OWNER_BEAT_MS, ownedSwarm, rebindOwnership, releaseOwnership, stopOwnerBeat } from '../../hooks/swarm/owner'
import { endSwarm } from '../../hooks/swarm/end'
import { resetClearForTests } from '../../hooks/clear'
import { bind, blobAt, launched, moveRef, nodePolicyOf, policyText, refOf, settle, world, type World } from './swarmlaunch-harness'
import { fireEvery, nodePorts, type TestPorts } from './support/node-ports'

// Every spec here runs git many times; a loaded machine takes seconds.
setDefaultTimeout(120_000)

let w: World

const originalOwnerDeps = { ...ownerDeps }

beforeEach(async () => {
  resetClearForTests()
  w = await world()
})

afterEach(async () => {
  resetClearForTests()
  Object.assign(ownerDeps, originalOwnerDeps)
  await w.done()
})

// ---------------------------------------------------------------------------
// Helpers

const wtPath = () => join(w.dir, '.claude', 'worktrees', 'sw-alpha-lead-a')
const agentFile = (id: string) => agentPolicyPath(w.litterDir, id)
const active = () => existsSync(activePath(w.litterDir))
const entryOf = async (name = 'alpha') => (await readPolicy(w.p, w.litterDir))?.swarm?.swarms[name]
const ledger = async (launch: string) => (await readLaunchLedger(w.p, w.litterDir, 'alpha', launch)).records
const kinds = async (launch: string) => (await ledger(launch)).map(r => r.kind)
/** The fake clock (the harness sets it): its time, and moving it on. */
const nowOf = (p: TestPorts): number => p.clock.now!
const ahead = (p: TestPorts, ms: number): void => void (p.clock.now = nowOf(p) + ms)

/** One orchestrator, no worktree of its own: a launch of it leaves no branch, so the name can be launched again. */
const solo = (): SwarmSpec => ({
  name: 'alpha',
  goal: 'Document the parser.',
  nodes: [{ id: 'docs', kind: 'orchestrator', worktree: 'none', spawnOther: false, authority: { commit: false } }],
})

/** A node's binding file, as M writes it. */
async function nodeFile(b: NodeBinding): Promise<void> {
  await atomicWriteJson(w.p, agentFile(b.agentId), { v: 1, node: nodePolicyOf(b, { admitted: true, stopped: null, bind: true }) })
}

// ---------------------------------------------------------------------------
// Q2

describe('a stale owner stands down before anything destructive (Q2)', () => {
  /**
   * Session sess-b takes alpha over from its own process, as handover does:
   * the ref at generation 2, and its entry. This process hasn't seen it: its
   * beat (every 10 s) is stopped, so only End's own checks can tell.
   */
  async function handedOver(): Promise<{ oid: string; text: string | null }> {
    stopOwnerBeat('alpha')
    const q = nodePorts({ sessionId: 'sess-b', cwd: w.dir })
    q.clock.now = nowOf(w.p)
    const oid = await moveRef(w, { ...(await blobAt(w, (await refOf(w))!)), session: 'sess-b', generation: 2, acquiredAt: nowOf(q) })
    const e = (await readPolicy(q, w.litterDir))!.swarm!.swarms.alpha!
    const entry = { ...e, owner: { ...e.owner, oid, generation: 2, session: 'sess-b', checkedAt: Math.floor(nowOf(q) / 1000) } }
    await writeSwarmPolicy(q, w.litterDir, 'alpha', entry, notNewer(e.launch, 2))
    return { oid, text: await policyText(w) }
  }

  /** alpha stopping in this session, its lead's file the new owner's (generation 2), then handed over. */
  async function stoppingThenHandedOver() {
    const launch = await launched(w)
    const lead = await bind(w, launch, { agentId: 'ag-l1', node: 'lead-a', n: 1, kind: 'orchestrator', cwd: wtPath(), branch: 'refs/heads/feature/alpha' })
    await endSwarm(w.p, 'alpha', 'request')
    const h = await handedOver()
    await nodeFile({ ...lead, generation: 2 })
    return { launch, ...h, kinds: await kinds(launch), file: readFileSync(agentFile('ag-l1'), 'utf8') }
  }

  async function expectStoodDown(s: Awaited<ReturnType<typeof stoppingThenHandedOver>>): Promise<void> {
    expect(liveSwarm('alpha')?.lost).toBe(true)
    expect(ownedSwarm('alpha')).toBeNull()
    expect(await refOf(w)).toBe(s.oid)
    expect(await policyText(w)).toBe(s.text)
    expect(active()).toBe(true)
    expect(await kinds(s.launch)).toEqual(s.kinds)
    expect(readFileSync(agentFile('ag-l1'), 'utf8')).toBe(s.file)
    expect(existsSync(wtPath())).toBe(true)
    expect(existsSync(launchSummaryPath(w.litterDir, 'alpha', s.launch))).toBe(false)
  }

  test("the settle wait's finish, after a handover: no cleanup, no swarm.end, no removal, and this process stands down", async () => {
    const s = await stoppingThenHandedOver()
    // The settle wait's tick: nothing is open, so it would end the swarm.
    await fireEvery(w.p)
    await expectStoodDown(s)
  })

  test('[End, keep everything], after a handover: the same', async () => {
    const s = await stoppingThenHandedOver()
    await endSwarm(w.p, 'alpha', 'keep-everything')
    await expectStoodDown(s)
  })

  test("End's stopping, after a handover, leaves the new owner's entry as it is, and stands down", async () => {
    await launched(w)
    const h = await handedOver()
    await endSwarm(w.p, 'alpha', 'request')
    expect(await policyText(w)).toBe(h.text)
    expect((await entryOf())?.state).toBe('live')
    expect(liveSwarm('alpha')?.lost).toBe(true)
    // Its settle wait went with it.
    await fireEvery(w.p)
    expect(await policyText(w)).toBe(h.text)
  })

  test("releaseOwnership answers false for a stale owner, and the policy writers leave an entry another owner holds", async () => {
    const launch = await launched(w)
    const old = (await refOf(w))!
    const h = await handedOver()
    const mine = heldBy({ launch, generation: 1, oids: [old] })

    await writeSwarmPolicy(w.p, w.litterDir, 'alpha', null, mine)
    await patchSwarmPolicy(w.p, w.litterDir, 'alpha', e => ({ ...e, state: 'stopping' }), mine)
    expect(await policyText(w)).toBe(h.text)
    expect(await releaseOwnership(w.p, w.litterDir, 'alpha')).toBe(false)
    expect(await refOf(w)).toBe(h.oid)
    expect(ownedSwarm('alpha')).toBeNull()

    // The new owner's own expectation holds.
    await patchSwarmPolicy(w.p, w.litterDir, 'alpha', e => ({ ...e, state: 'stopping' }), heldBy({ launch, generation: 2, oids: [h.oid] }))
    expect((await entryOf())?.state).toBe('stopping')
  })
})

// ---------------------------------------------------------------------------
// Q3, Q4

describe("the owner's entry: the rebind's order, and the beat that heals it (Q3, Q4)", () => {
  test("a /clear rebind whose oid patch fails keeps the swarm: the check time was refreshed before the swap, the oid is its own at once, and the next beat writes the entry", async () => {
    await launched(w)
    const old = (await refOf(w))!
    // clear.ts stops the beats before the swap; a while passes.
    stopOwnerBeat('alpha')
    ahead(w.p, 30_000)
    const at = Math.floor(nowOf(w.p) / 1000)
    const seen: { ref: string | null; checkedAt: number | undefined }[] = []
    let n = 0
    ownerDeps.patchSwarmPolicy = async (...a) => {
      if (++n === 2) throw new Error('policy.json is busy')
      await originalOwnerDeps.patchSwarmPolicy(...a)
      seen.push({ ref: await refOf(w), checkedAt: (await entryOf())?.owner.checkedAt })
    }

    await rebindOwnership(w.p, w.litterDir, 'sess-c')
    await settle(w.p)

    const now = (await refOf(w))!
    expect(now).not.toBe(old)
    expect(await blobAt(w, now)).toEqual(expect.objectContaining({ session: 'sess-c', generation: 1 }))
    // Before the swap: the old ref, the check time refreshed.
    expect(seen).toEqual([{ ref: old, checkedAt: at }])
    expect(n).toBe(2)
    expect(w.p.logs.some(l => l.includes("the rebind's oid in policy.json failed"))).toBe(true)
    // The owner never stood down from its own swap, and the beat wrote the entry.
    expect(ownedSwarm('alpha')).toEqual({ ref: 'refs/litter-swarm/alpha', oid: now, generation: 1 })
    expect(liveSwarm('alpha')).toEqual(expect.objectContaining({ lost: false, owner: expect.objectContaining({ oid: now, session: 'sess-c' }) }))
    expect((await entryOf())?.owner).toEqual({ ref: 'refs/litter-swarm/alpha', oid: now, generation: 1, session: 'sess-c', checkedAt: at })
  })

  test("the beat writes its entry back when another session's write of policy.json lost it, and hooks/active with it", async () => {
    await launched(w)
    const e = (await entryOf())!
    // Another session's read-modify-write from before this launch's entry: the swarm gone, and hooks/active with it.
    const q = nodePorts({ sessionId: 'sess-b', cwd: w.dir })
    await writeSwarmPolicy(q, w.litterDir, 'alpha', null)
    expect(await entryOf()).toBeUndefined()
    expect(active()).toBe(false)

    ahead(w.p, OWNER_BEAT_MS)
    await settle(w.p)
    expect(await entryOf()).toEqual({ ...e, owner: { ...e.owner, checkedAt: Math.floor(nowOf(w.p) / 1000) } })
    expect(active()).toBe(true)

    // A node's Bash removed hooks/active: the next beat makes it again.
    await setActive(w.p, w.litterDir, false)
    ahead(w.p, OWNER_BEAT_MS)
    await settle(w.p)
    expect(active()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Q9, Q10

describe('hooks/active (Q9, Q10)', () => {
  const freshPolicy = (): Policy => ({ v: 1, session: 'sess-a', litterDir: w.litterDir, run: null, roles: {}, swarm: null })

  test("a run's deactivate leaves it when policy.json doesn't parse, or isn't version 1, and says so", async () => {
    await setActive(w.p, w.litterDir, true)
    await w.p.fs.write(policyPath(w.litterDir), '{"v": 1, "run":')
    await deactivate(w.p, w.litterDir, 'r1')
    expect(active()).toBe(true)
    expect(w.p.logs.some(l => l.includes("policy.json doesn't parse, so hooks/active is left"))).toBe(true)

    await atomicWriteJson(w.p, policyPath(w.litterDir), { ...freshPolicy(), v: 2 })
    await deactivate(w.p, w.litterDir, 'r1')
    expect(active()).toBe(true)

    // Version 1, with no run and no swarm: it goes.
    await atomicWriteJson(w.p, policyPath(w.litterDir), freshPolicy())
    await deactivate(w.p, w.litterDir, 'r1')
    expect(active()).toBe(false)
  })

  test("it stays while a node's binding file is left (writeSwarmPolicy, deactivate, releaseActive); a fanout writer's file doesn't count", async () => {
    const launch = await launched(w, solo())
    const lead = await bind(w, launch, { agentId: 'ag-d1', node: 'docs', n: 1, kind: 'orchestrator', cwd: w.dir })
    await nodeFile(lead)
    await atomicWriteJson(w.p, agentFile('wf-1'), { v: 1, run: '20261003-120000-abcd' })
    stopOwnerBeat('alpha')

    await writeSwarmPolicy(w.p, w.litterDir, 'alpha', null)
    expect(await entryOf()).toBeUndefined()
    expect(active()).toBe(true)
    await deactivate(w.p, w.litterDir, 'r1')
    expect(active()).toBe(true)
    await releaseActive(w.p, w.litterDir)
    expect(active()).toBe(true)

    // U's sweep removed the last node's file: releaseActive takes it, past the fanout file.
    await removeNodePolicy(w.p, w.litterDir, 'ag-d1')
    await releaseActive(w.p, w.litterDir)
    expect(active()).toBe(false)

    // A file that doesn't parse may be a node's: it counts.
    await setActive(w.p, w.litterDir, true)
    await w.p.fs.write(agentFile('ag-x'), '{"v": 1, "node": ')
    await releaseActive(w.p, w.litterDir)
    expect(active()).toBe(true)
  })
})
