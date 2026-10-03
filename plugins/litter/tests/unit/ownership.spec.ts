// Tier 2: a swarm's ownership across sessions and crashes (FIX-Q; plan 15.4,
// "Ownership", "A stale owner stands down", "After /clear"). Real git refs in
// a scratch repository (swarmlaunch-harness.ts), the real policy.json writers
// and ledgers. A second session is a second nodePorts with its own session id
// on the same repository: `w.restart` for a new process of this module, a
// bare nodePorts for another session's writes while this process runs on.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Policy } from '../../hooks/hookfiles'
import type { ListedAgent } from '../../hooks/ports'
import type { NodeBinding, SwarmSpec } from '../../hooks/swarm/types'
import { activePath, agentPolicyPath, launchSummaryPath, policyPath } from '../../hooks/layout'
import { atomicWriteJson } from '../../hooks/fsx'
import { readPolicy, setActive } from '../../hooks/policy'
import { normalizeOptions } from '../../hooks/options'
import { deactivate } from '../../hooks/lifecycle'
import { appendLaunchRecord, newLaunchId, readLaunchLedger } from '../../hooks/records/swarm'
import { liveSwarm } from '../../hooks/swarm/state'
import { heldBy, notNewer, patchSwarmPolicy, releaseActive, removeNodePolicy, writeSwarmPolicy } from '../../hooks/swarm/guard'
import {
  acquireOwnership,
  deps as ownerDeps,
  OWNER_BEAT_MS,
  OWNER_STALE_MS,
  ownedSwarm,
  rebindOwnership,
  releaseOwnership,
  startOwnerBeat,
  stopOwnerBeat,
} from '../../hooks/swarm/owner'
import { recoverSwarms } from '../../hooks/swarm/recover'
import { launchSwarm } from '../../hooks/swarm/launch'
import { endSwarm } from '../../hooks/swarm/end'
import { addSwarmWorktree } from '../../hooks/swarm/worktrees'
import { resetClearForTests } from '../../hooks/clear'
import { aSpec, bind, blobAt, deadPid, launched, moveRef, nodePolicyOf, policyText, refOf, saveSwarm, settle, world, type World } from './swarmlaunch-harness'
import { fireEvery, nodePorts, type TestPorts } from './support/node-ports'

// Every spec here runs git many times; a loaded machine takes seconds.
setDefaultTimeout(120_000)

let w: World
let sleeper: ChildProcess | null = null

const originalOwnerDeps = { ...ownerDeps }

beforeEach(async () => {
  resetClearForTests()
  w = await world()
})

afterEach(async () => {
  resetClearForTests()
  Object.assign(ownerDeps, originalOwnerDeps)
  await w.done()
  sleeper?.kill()
  sleeper = null
})

// ---------------------------------------------------------------------------
// Helpers

const wtPath = () => join(w.dir, '.claude', 'worktrees', 'sw-alpha-lead-a')
const agentFile = (id: string) => agentPolicyPath(w.litterDir, id)
const active = () => existsSync(activePath(w.litterDir))
const entryOf = async (name = 'alpha') => (await readPolicy(w.p, w.litterDir))?.swarm?.swarms[name]
const ledger = async (launch: string) => (await readLaunchLedger(w.p, w.litterDir, 'alpha', launch)).records
const kinds = async (launch: string) => (await ledger(launch)).map(r => r.kind)
const running = (id: string, type: string): ListedAgent => ({ id, description: 'a node', type, status: 'running' })
/** The fake clock (the harness sets it): its time, and moving it on. */
const nowOf = (p: TestPorts): number => p.clock.now!
const ahead = (p: TestPorts, ms: number): void => void (p.clock.now = nowOf(p) + ms)

/** One orchestrator, no worktree of its own: a launch of it leaves no branch, so the name can be launched again. */
const solo = (): SwarmSpec => ({
  name: 'alpha',
  goal: 'Document the parser.',
  nodes: [{ id: 'docs', kind: 'orchestrator', worktree: 'none', spawnOther: false, authority: { commit: false } }],
})

/** A pid that runs on this host and isn't this process's: another session's. */
function livePid(): string {
  sleeper = spawn('sleep', ['300'], { stdio: 'ignore' })
  return String(sleeper.pid)
}

/** A node's binding file, as M writes it. */
async function nodeFile(b: NodeBinding): Promise<void> {
  await atomicWriteJson(w.p, agentFile(b.agentId), { v: 1, node: nodePolicyOf(b, { admitted: true, stopped: null, bind: true }) })
}

/** End's crash right after swarm.end (15.4, step 3): the summary, the release and the removals never ran. */
async function endRecorded(launch: string): Promise<void> {
  await appendLaunchRecord(w.p, w.litterDir, 'alpha', launch, 'swarm.end', { status: 'ended', settled: true, nodes: {}, worktrees: [], branches: [] })
}

/**
 * The owner's process is gone: its blob names a pid no process has, and the
 * repository's next process is session `next` on this host, `later` ms on.
 */
async function crashed(next: string, later = OWNER_STALE_MS + 1_000): Promise<TestPorts> {
  const oid = await refOf(w)
  if (oid) await moveRef(w, { ...(await blobAt(w, oid)), pid: await deadPid(w) })
  const q = await w.restart(next)
  ahead(q, later)
  return q
}

/**
 * A Launch that crashed between its ref and swarm.start, built from Launch's
 * own steps: the launch folder, the ref and its beat, and lead-a's `new`
 * worktree on `branch` (swarm.worktree.intent and swarm.worktree recorded).
 */
async function neverStarted(branch = 'feature/old'): Promise<string> {
  await saveSwarm(w, aSpec())
  const launch = await newLaunchId(w.p, w.litterDir, 'alpha')
  await acquireOwnership(w.p, w.litterDir, 'alpha', launch)
  startOwnerBeat(w.p, w.litterDir, 'alpha')
  const r = await addSwarmWorktree(w.p, w.litterDir, normalizeOptions(undefined), {
    swarm: 'alpha',
    launch,
    node: 'lead-a',
    path: wtPath(),
    branch,
    from: 'main',
    repo: w.dir,
    setup: null,
    linkDirs: [],
  })
  if (!r.ok) throw new Error(r.reason)
  await settle(w.p)
  return launch
}

// ---------------------------------------------------------------------------
// Q1

describe('a name a crash left stuck is settled at recovery and at Launch (Q1)', () => {
  test("at recovery, a launch that ended, its session gone: the release is finished (node policies but a running agent's, the entry, the ref), nothing is recorded, and hooks/active stays for the file left", async () => {
    const launch = await launched(w)
    await nodeFile(await bind(w, launch, { agentId: 'ag-l1', node: 'lead-a', n: 1, kind: 'orchestrator', cwd: wtPath(), branch: 'refs/heads/feature/alpha' }))
    await nodeFile(await bind(w, launch, { agentId: 'ag-d1', node: 'docs', n: 1, kind: 'orchestrator', cwd: w.dir }))
    await endRecorded(launch)
    const q = await crashed('sess-b')
    // ag-d1 still runs (U1): its file stays, so the guard denies it, and hooks/active stays for it.
    q.agents = [running('ag-d1', 'litter:sw-alpha-docs')]
    const before = await kinds(launch)

    await recoverSwarms(q, w.litterDir)

    expect(await refOf(w)).toBeNull()
    expect((await readPolicy(q, w.litterDir))?.swarm).toBeNull()
    expect(existsSync(agentFile('ag-l1'))).toBe(false)
    expect(existsSync(agentFile('ag-d1'))).toBe(true)
    expect(active()).toBe(true)
    expect(await kinds(launch)).toEqual(before)
    expect(liveSwarm('alpha')).toBeNull()
  })

  test('at Launch, a launch that ended, its session gone: the release is finished, and the launch goes on', async () => {
    const first = await launched(w, solo())
    await nodeFile(await bind(w, first, { agentId: 'ag-d1', node: 'docs', n: 1, kind: 'orchestrator', cwd: w.dir }))
    await endRecorded(first)
    await crashed('sess-b')
    const before = await kinds(first)

    const next = await launched(w, solo())

    expect(next).not.toBe(first)
    expect(await kinds(first)).toEqual(before)
    expect((await blobAt(w, (await refOf(w))!)).launch).toBe(next)
    expect((await entryOf())?.launch).toBe(next)
    expect(existsSync(agentFile('ag-d1'))).toBe(false)
  })

  test("at Launch, this session's own launch that ended, whose release this process didn't finish: settled at once, whatever its pid", async () => {
    const first = await launched(w, solo())
    await endRecorded(first)
    // The same session, a process that holds nothing of it; its blob names a running pid.
    await moveRef(w, { ...(await blobAt(w, (await refOf(w))!)), pid: livePid() })
    await w.restart('sess-a')

    const next = await launched(w, solo())

    expect((await blobAt(w, (await refOf(w))!)).launch).toBe(next)
  })

  test("at recovery, a launch that never reached swarm.start, its session gone: it ends as a failed launch does (the cleanup, then launch_failed with what's left), and the ref is released", async () => {
    const launch = await neverStarted()
    await crashed('sess-b')
    w.realCleanup = true

    await recoverSwarms(w.p, w.litterDir)

    const rs = await ledger(launch)
    expect(rs.map(r => r.kind)).toEqual(['swarm.worktree.intent', 'swarm.worktree', 'swarm.worktree.removed', 'swarm.end'])
    expect(rs[3]!.body).toEqual({
      status: 'launch_failed',
      settled: true,
      reason: 'the launching session ended before swarm.start',
      nodes: {},
      worktrees: [{ path: wtPath(), branch: 'feature/old', node: 'lead-a', removed: true }],
      branches: ['feature/old'],
    })
    expect(w.calls.cleanups).toEqual([{ swarm: 'alpha', launch }])
    expect(existsSync(wtPath())).toBe(false)
    expect(await refOf(w)).toBeNull()
    expect(liveSwarm('alpha')).toBeNull()
  })

  test('at Launch, a launch that never reached swarm.start, its session gone: it ends as a failed launch, and the launch goes on', async () => {
    const old = await neverStarted()
    await crashed('sess-b')
    w.realCleanup = true

    const launch = await launched(w)

    expect((await ledger(old)).map(r => [r.kind, r.body.status])).toEqual([
      ['swarm.worktree.intent', undefined],
      ['swarm.worktree', undefined],
      ['swarm.worktree.removed', undefined],
      ['swarm.end', 'launch_failed'],
    ])
    expect((await w.git('-C', wtPath(), 'symbolic-ref', '-q', 'HEAD')).trim()).toBe('refs/heads/feature/alpha')
    expect((await blobAt(w, (await refOf(w))!)).launch).toBe(launch)
  })

  test("at recovery, an entry whose ref is gone goes once its owner hasn't beaten for a minute, and hooks/active with it; a fresh one is left", async () => {
    const launch = await launched(w, solo())
    await endRecorded(launch)
    // End's crash after the release, before the entry's removal.
    stopOwnerBeat('alpha')
    await w.git('update-ref', '-d', 'refs/litter-swarm/alpha')
    const text = await policyText(w)

    // Another session, at once: the entry's owner beat 0 s ago.
    let q = await w.restart('sess-b')
    await recoverSwarms(q, w.litterDir)
    expect(await policyText(w)).toBe(text)
    expect(active()).toBe(true)

    q = await w.restart('sess-b')
    ahead(q, OWNER_STALE_MS + 1_000)
    await recoverSwarms(q, w.litterDir)
    expect(await entryOf()).toBeUndefined()
    expect(active()).toBe(false)
  })

  test("at recovery, an entry whose ref names another launch goes at once in its owner's own session", async () => {
    await launched(w, solo())
    stopOwnerBeat('alpha')
    // Another session's launch of the name, which this repository's folders don't know.
    await moveRef(w, { ...(await blobAt(w, (await refOf(w))!)), launch: '20261003-110000', session: 'sess-x', pid: livePid() })
    const ref = await refOf(w)

    const q = await w.restart('sess-a')
    await recoverSwarms(q, w.litterDir)

    expect(await entryOf()).toBeUndefined()
    expect(await refOf(w)).toBe(ref)
  })

  test('at Launch, a ref of a later launch that never started and an entry its ref no longer names: both are settled, and the launch goes on', async () => {
    const first = await launched(w, solo())
    await endRecorded(first)
    // End's crash after the release: the entry stays, with no ref.
    await w.git('update-ref', '-d', 'refs/litter-swarm/alpha')
    // Then a Launch's crash before swarm.start.
    ahead(w.p, 5_000)
    const second = await newLaunchId(w.p, w.litterDir, 'alpha')
    await acquireOwnership(w.p, w.litterDir, 'alpha', second)
    await crashed('sess-b')

    const third = await launched(w, solo())

    expect((await ledger(second)).map(r => [r.kind, r.body.status, r.body.reason])).toEqual([
      ['swarm.end', 'launch_failed', 'the launching session ended before swarm.start'],
    ])
    expect((await entryOf())?.launch).toBe(third)
    expect((await blobAt(w, (await refOf(w))!)).launch).toBe(third)
  })

  test('a holder that may still be running is left alone, at recovery and at Launch, which says why', async () => {
    const launch = await launched(w, solo())
    await nodeFile(await bind(w, launch, { agentId: 'ag-d1', node: 'docs', n: 1, kind: 'orchestrator', cwd: w.dir }))
    await endRecorded(launch)
    // Its process still runs on this host, long after its last beat.
    const oid = await moveRef(w, { ...(await blobAt(w, (await refOf(w))!)), pid: livePid() })
    const q = await w.restart('sess-b')
    ahead(q, OWNER_STALE_MS + 1_000)
    const text = await policyText(w)
    const before = await kinds(launch)

    await recoverSwarms(q, w.litterDir)
    q.answers.push('Launch')
    const r = await launchSwarm(q, 'alpha')

    expect(r.ok).toBe(false)
    const reason = (r as { reason: string }).reason
    expect(reason).toContain(`refs/litter-swarm/alpha exists: its launch ${launch} has ended, but its session sess-a on `)
    expect(reason).toContain('may still be running; launch again once that session has closed')
    expect(await refOf(w)).toBe(oid)
    expect(await policyText(w)).toBe(text)
    expect(existsSync(agentFile('ag-d1'))).toBe(true)
    expect(await kinds(launch)).toEqual(before)
  })

  test("another session's launch short of swarm.start, its pid gone but its ref taken under a minute ago, is left", async () => {
    const launch = await neverStarted()
    const q = await crashed('sess-b', 30_000)
    w.realCleanup = true
    const oid = await refOf(w)

    await recoverSwarms(q, w.litterDir)
    q.answers.push('Launch')
    const r = await launchSwarm(q, 'alpha')

    expect((r as { reason: string }).reason).toContain(`its launch ${launch} never reached swarm.start, but its session sess-a on `)
    expect(await refOf(w)).toBe(oid)
    expect(await kinds(launch)).toEqual(['swarm.worktree.intent', 'swarm.worktree'])
    expect(existsSync(wtPath())).toBe(true)
  })
})

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
