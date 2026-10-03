// Tier 2: who owns a live swarm (hooks/swarm/owner.ts; WP-K, plan 15.4 "One
// session owns a live swarm"), against real git: the lease beat and the
// policy's check time, a stale owner standing down, a beat that never writes
// over a new owner's entry, handover with its refusals and confirmations, the
// rebind's swap, and the release.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NodeBinding } from '../../hooks/swarm/types'
import type { Policy } from '../../hooks/hookfiles'
import { agentPolicyPath, ownerLeasePath, swarmDir } from '../../hooks/layout'
import { atomicWriteJson } from '../../hooks/fsx'
import { readLaunchLedger } from '../../hooks/records/swarm'
import { liveSwarm, markRunning } from '../../hooks/swarm/state'
import { deps as ownerDeps, handover, ownedSwarm, ownerLost, readOwner, rebindOwnership, releaseOwnership } from '../../hooks/swarm/owner'
import { recoverSwarms, recoveryCard, requestResume } from '../../hooks/swarm/recover'
import {
  bind,
  blobAt,
  deadPid,
  launched,
  moveRef,
  nodePolicyOf,
  NOW,
  policyText,
  readNodePolicy,
  refOf,
  settle,
  world,
  type World,
} from './swarmlaunch-harness'
import { fireEvery } from './support/node-ports'

// Real git in every test; a loaded machine takes seconds.
setDefaultTimeout(120_000)

let w: World
beforeEach(async () => {
  w = await world()
})
afterEach(async () => {
  await w.done()
})

const wtPath = () => join(w.dir, '.claude', 'worktrees', 'sw-alpha-lead-a')
const policy = async () => JSON.parse((await policyText(w)) ?? 'null') as Policy
const entry = async () => (await policy()).swarm!.swarms.alpha!
const leases = () => readdirSync(swarmDir(w.litterDir, 'alpha')).filter(f => f.startsWith('owner-lease-'))
const lease = (oid: string) => JSON.parse(readFileSync(ownerLeasePath(w.litterDir, 'alpha', oid), 'utf8')) as Record<string, unknown>
const nodePolicy = (b: NodeBinding) => atomicWriteJson(w.p, agentPolicyPath(w.litterDir, b.agentId), { v: 1, node: nodePolicyOf(b, { admitted: true, stopped: null, bind: false }) })
const tick = async (ms = 10_000) => {
  w.p.clock.now! += ms
  await fireEvery(w.p)
}

/** A launch in session sess-a with three nodes bound, two of them running, each with its policy. */
async function boundLaunch(): Promise<{ launch: string; bound: NodeBinding[] }> {
  const launch = await launched(w)
  const bound = [
    await bind(w, launch, { agentId: 'ag-l1', node: 'lead-a', n: 1, kind: 'orchestrator', cwd: wtPath(), branch: 'refs/heads/feature/alpha' }),
    await bind(w, launch, { agentId: 'ag-f1', node: 'fixer', n: 1, kind: 'worker', cwd: wtPath(), parent: 'ag-l1', branch: 'refs/heads/feature/alpha' }),
    await bind(w, launch, { agentId: 'ag-d1', node: 'docs', n: 1, kind: 'orchestrator', cwd: w.dir }),
  ]
  markRunning('ag-l1')
  markRunning('ag-f1')
  for (const b of bound) await nodePolicy(b)
  return { launch, bound }
}

describe('the beat', () => {
  test("writes the lease and policy.json's check time, in seconds, every 10 s", async () => {
    await launched(w)
    const oid = (await refOf(w))!
    await tick()
    expect(lease(oid)).toEqual({ oid, swarm: 'alpha', session: 'sess-a', beatAt: NOW + 10_000 })
    expect((await entry()).owner.checkedAt).toBe((NOW + 10_000) / 1000)
    await tick()
    expect(lease(oid).beatAt).toBe(NOW + 20_000)
    expect((await entry()).owner.checkedAt).toBe((NOW + 20_000) / 1000)
    expect(ownerLost('alpha')).toBe(false)
    expect(w.p.timers.size).toBe(1)
  })

  test('a beat that finds the ref moved stands down: lost in state.ts, the beat stopped, nothing written or removed', async () => {
    const { bound } = await boundLaunch()
    await settle(w.p)
    const oid = (await refOf(w))!
    const before = {
      policy: await policyText(w),
      nodes: await Promise.all(bound.map(b => w.p.fs.read(agentPolicyPath(w.litterDir, b.agentId)))),
      leases: leases(),
    }
    const theirs = await moveRef(w, { ...(await blobAt(w, oid)), session: 'sess-b', generation: 2 })
    await tick()
    expect(liveSwarm('alpha')!.lost).toBe(true)
    expect(ownerLost('alpha')).toBe(true)
    expect(ownedSwarm('alpha')).toBeNull()
    expect(w.p.timers.size).toBe(0)
    expect(w.p.toasts).toContain('litter: swarm alpha was handed to another session; this session no longer acts on it')
    expect(await policyText(w)).toBe(before.policy)
    expect(await Promise.all(bound.map(b => w.p.fs.read(agentPolicyPath(w.litterDir, b.agentId))))).toEqual(before.nodes)
    expect(leases()).toEqual(before.leases)
    expect(existsSync(wtPath())).toBe(true)
    // No more beats, and a release from here removes nothing.
    await tick()
    expect(await policyText(w)).toBe(before.policy)
    await releaseOwnership(w.p, w.litterDir, 'alpha')
    expect(await refOf(w)).toBe(theirs)
    expect(leases()).toEqual(before.leases)
  })

  test("a beat whose entry now names another generation or oid leaves the entry as it is", async () => {
    await launched(w)
    const oid = (await refOf(w))!
    const e = await entry()
    await ownerDeps.writeSwarmPolicy(w.p, w.litterDir, 'alpha', { ...e, owner: { ...e.owner, generation: 2, session: 'sess-b', checkedAt: 1 } })
    let text = await policyText(w)
    await tick()
    expect(await policyText(w)).toBe(text)
    await ownerDeps.writeSwarmPolicy(w.p, w.litterDir, 'alpha', { ...e, owner: { ...e.owner, oid: 'f'.repeat(40), checkedAt: 1 } })
    text = await policyText(w)
    await tick()
    expect(await policyText(w)).toBe(text)
    // The ref is still this session's, so the lease is still beaten.
    expect(lease(oid).beatAt).toBe(NOW + 20_000)
  })
})

describe('handover', () => {
  /** sess-a's launch, then sess-b's process on the same repository, which shows it read-only. */
  async function inSessionB() {
    const { launch } = await boundLaunch()
    const q = await w.restart('sess-b')
    await recoverSwarms(q, w.litterDir)
    expect(liveSwarm('alpha')!.readOnly).toBe(true)
    return { launch, q }
  }

  test("is refused while the owner's lease is fresh and while its pid is alive here; then needs your confirmation, and records swarm.handover", async () => {
    const { launch, q } = await inSessionB()
    q.clock.now = NOW + 30_000
    let r = await handover(q, w.litterDir, 'alpha')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('beat its lease 30 s ago; a handover needs it over 60 s stale') })
    q.clock.now = NOW + 120_000
    // sess-a's pid is this test's process: alive.
    r = await handover(q, w.litterDir, 'alpha')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("its owner's process") })
    expect((r as { reason: string }).reason).toContain('is still running on this host')
    expect(q.asked).toEqual([])
    expect((await readOwner(q, w.litterDir, 'alpha'))!.canHandOver).toBe(false)

    // sess-a's process is gone (its blob names a pid no process has), and its lease is stale.
    const old = (await refOf(w))!
    const blobA = await blobAt(w, old)
    const gone = await moveRef(w, { ...blobA, pid: await deadPid(w) })
    // Its last beat, 90 s ago.
    await atomicWriteJson(q, ownerLeasePath(w.litterDir, 'alpha', gone), { oid: gone, swarm: 'alpha', session: 'sess-a', beatAt: NOW + 30_000 })
    const view = (await readOwner(q, w.litterDir, 'alpha'))!
    expect(view.leaseAgeMs).toBe(90_000)
    expect(view).toEqual(expect.objectContaining({ oid: gone, mine: false, canHandOver: true, why: null }))
    q.answers.push('Cancel')
    r = await handover(q, w.litterDir, 'alpha')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('a handover needs your confirmation') })
    expect(q.asked[0]!.options).toEqual(['Take over', 'Cancel'])
    expect(q.asked[0]!.question).toContain('lead-a #1 (ag-l1), fixer #1 (ag-f1), docs #1 (ag-d1)')
    expect(q.asked[0]!.question).toContain('would be duplicated')
    expect(await refOf(w)).toBe(gone)

    q.answers.push('Take over')
    expect(await handover(q, w.litterDir, 'alpha')).toEqual({ ok: true })
    const now = (await refOf(w))!
    expect(await blobAt(w, now)).toEqual(expect.objectContaining({ swarm: 'alpha', launch, session: 'sess-b', generation: 2, acquiredAt: NOW + 120_000 }))
    const rs = (await readLaunchLedger(q, w.litterDir, 'alpha', launch)).records
    expect(rs.at(-1)!.kind).toBe('swarm.handover')
    expect(rs.at(-1)!.body).toEqual({ from: 'sess-a', to: 'sess-b', generation: 2 })
    expect(ownedSwarm('alpha')).toEqual({ ref: 'refs/litter-swarm/alpha', oid: now, generation: 2 })
    expect(q.timers.size).toBe(1)
    // The old lease went with the old blob.
    expect(existsSync(ownerLeasePath(w.litterDir, 'alpha', gone))).toBe(false)
  })

  test("after it, the entry carries the next generation, the old bindings' policies keep theirs, and the card offers only re-spawn", async () => {
    const { launch, q } = await inSessionB()
    q.clock.now = NOW + 120_000
    await moveRef(w, { ...(await blobAt(w, (await refOf(w))!)), pid: await deadPid(w) })
    q.answers.push('Take over')
    expect(await handover(q, w.litterDir, 'alpha')).toEqual({ ok: true })
    const oid = (await refOf(w))!
    expect(await entry()).toEqual(
      expect.objectContaining({ launch, state: 'live', owner: { ref: 'refs/litter-swarm/alpha', oid, generation: 2, session: 'sess-b', checkedAt: (NOW + 120_000) / 1000 } }),
    )
    for (const id of ['ag-l1', 'ag-f1', 'ag-d1']) {
      const node = (await readNodePolicy(w, id))!.node
      expect(node.generation).toBe(1)
      // Not in this session's list: not admitted.
      expect(node.admitted).toBe(false)
    }
    const s = liveSwarm('alpha')!
    expect(s).toEqual(expect.objectContaining({ readOnly: false, lost: false, typesReady: true }))
    expect(s.owner).toEqual({ ref: 'refs/litter-swarm/alpha', oid, generation: 2, session: 'sess-b' })
    expect(q.registeredAgents.map(a => a.name)).toEqual(['sw-alpha-lead-a', 'sw-alpha-docs', 'sw-alpha-fixer', 'sw-alpha-scout'])
    // The two that were running at sess-a's last save, re-spawn only.
    const card = recoveryCard('alpha')!
    expect(card.nodes.map(n => [n.agentId, n.state, n.respawnOnly])).toEqual([
      ['ag-l1', 'gone', true],
      ['ag-f1', 'gone', true],
    ])
    await expect(requestResume(q, 'alpha', ['lead-a'], 'resume')).rejects.toThrow('no instance this session can resume')
    await requestResume(q, 'alpha', ['lead-a'], 'respawn')
    expect(q.filled[0]!.split('\n')[0]).toBe('/litter:swarm respawn alpha lead-a')
  })

  test('from another host, it needs your word that the session is closed', async () => {
    const { q } = await inSessionB()
    q.clock.now = NOW + 120_000
    await moveRef(w, { ...(await blobAt(w, (await refOf(w))!)), host: 'elsewhere.invalid', pid: '4242' })
    expect((await readOwner(q, w.litterDir, 'alpha'))!.canHandOver).toBe(true)
    q.answers.push('Cancel')
    expect(await handover(q, w.litterDir, 'alpha')).toEqual({ ok: false, reason: expect.stringContaining('needs your confirmation that its session is closed') })
    expect(q.asked[0]!.options).toEqual(['It is closed', 'Cancel'])
    expect(q.asked[0]!.question).toContain('on elsewhere.invalid')
    q.answers.push('It is closed', 'Take over')
    expect(await handover(q, w.litterDir, 'alpha')).toEqual({ ok: true })
    expect((await blobAt(w, (await refOf(w))!)).generation).toBe(2)
  })

  test("refused for this session's own swarm, for one no one owns, and when the ref moved while you confirmed", async () => {
    await launched(w)
    expect(await handover(w.p, w.litterDir, 'alpha')).toEqual({ ok: false, reason: expect.stringContaining('this session owns it') })
    expect((await readOwner(w.p, w.litterDir, 'alpha'))!.mine).toBe(true)
    expect(await handover(w.p, w.litterDir, 'nobody')).toEqual({ ok: false, reason: expect.stringContaining('no session owns it') })
    const q = await w.restart('sess-b')
    q.clock.now = NOW + 120_000
    await moveRef(w, { ...(await blobAt(w, (await refOf(w))!)), pid: await deadPid(w) })
    const ask = q.ask
    q.ask = async (question, opts) => {
      await moveRef(w, { ...(await blobAt(w, (await refOf(w))!)), session: 'sess-c', generation: 2 })
      return ask(question, opts)
    }
    q.answers.push('Take over')
    expect(await handover(q, w.litterDir, 'alpha')).toEqual({ ok: false, reason: expect.stringContaining('changed while you confirmed') })
    expect((await blobAt(w, (await refOf(w))!)).session).toBe('sess-c')
  })
})

describe('the rebind and the release', () => {
  test('rebindOwnership swaps the ref to the new session, keeping the generation and pid, and patches the entry to match', async () => {
    const { bound } = await boundLaunch()
    await settle(w.p)
    const old = (await refOf(w))!
    const was = await blobAt(w, old)
    const node = await w.p.fs.read(agentPolicyPath(w.litterDir, bound[0]!.agentId))
    w.p.clock.now = NOW + 5_000
    await rebindOwnership(w.p, w.litterDir, 'sess-c')
    const now = (await refOf(w))!
    expect(now).not.toBe(old)
    expect(await blobAt(w, now)).toEqual({ ...was, session: 'sess-c' })
    expect((await entry()).owner).toEqual({ ref: 'refs/litter-swarm/alpha', oid: now, generation: 1, session: 'sess-c', checkedAt: (NOW + 5_000) / 1000 })
    expect(liveSwarm('alpha')!.owner).toEqual({ ref: 'refs/litter-swarm/alpha', oid: now, generation: 1, session: 'sess-c' })
    expect(ownedSwarm('alpha')).toEqual({ ref: 'refs/litter-swarm/alpha', oid: now, generation: 1 })
    expect(existsSync(ownerLeasePath(w.litterDir, 'alpha', old))).toBe(false)
    // The node policies hold the generation, not the oid: unchanged.
    expect(await w.p.fs.read(agentPolicyPath(w.litterDir, bound[0]!.agentId))).toBe(node)
    // The beat carries on, at the new oid.
    await tick()
    expect(lease(now)).toEqual({ oid: now, swarm: 'alpha', session: 'sess-c', beatAt: NOW + 15_000 })
  })

  test('releaseOwnership deletes its own oid and its lease', async () => {
    await launched(w)
    await settle(w.p)
    const oid = (await refOf(w))!
    expect(existsSync(ownerLeasePath(w.litterDir, 'alpha', oid))).toBe(true)
    await releaseOwnership(w.p, w.litterDir, 'alpha')
    expect(await refOf(w)).toBeNull()
    expect(leases()).toEqual([])
    expect(w.p.timers.size).toBe(0)
    expect(ownedSwarm('alpha')).toBeNull()
  })

  test('releaseOwnership deletes only its own oid: never one another session took, and nothing from a process that never held it', async () => {
    await launched(w)
    const theirs = await moveRef(w, { ...(await blobAt(w, (await refOf(w))!)), session: 'sess-b', generation: 2 })
    // No beat ran since, so this process still thinks it holds the ref.
    await releaseOwnership(w.p, w.litterDir, 'alpha')
    expect(await refOf(w)).toBe(theirs)
    expect(w.p.logs.some(l => l.includes("wasn't released"))).toBe(true)
    const q = await w.restart('sess-b')
    await releaseOwnership(q, w.litterDir, 'alpha')
    expect(await refOf(w)).toBe(theirs)
  })
})
