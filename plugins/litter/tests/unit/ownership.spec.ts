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
import type { LiveSwarm, NodeBinding, SwarmSpec } from '../../hooks/swarm/types'
import { activePath, agentPolicyPath, launchSummaryPath, policyPath, revisionPath } from '../../hooks/layout'
import { atomicWriteJson } from '../../hooks/fsx'
import { readPolicy, setActive } from '../../hooks/policy'
import { normalizeOptions } from '../../hooks/options'
import { deactivate } from '../../hooks/lifecycle'
import { appendLaunchRecord, newLaunchId, readLaunchLedger } from '../../hooks/records/swarm'
import { liveSwarm, putLiveSwarm, stopped } from '../../hooks/swarm/state'
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
import { endSwarm, recordSwarmEnd, stopNode } from '../../hooks/swarm/end'
import { addSwarmWorktree } from '../../hooks/swarm/worktrees'
import { noteSessionEnd, others as clearOthers, READ_ONLY_REFRESH_MS, rebindSettled, rebound, resetClearForTests, startSwarmTimers } from '../../hooks/clear'
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

/** Waits for work a timer started without handing back its promise (the swarm tick's refresh). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise<void>(resolve => setTimeout(resolve, 10))
  expect(cond()).toBe(true)
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

    // FIX-T 6: the one sweep watches the file it kept: once ag-d1 leaves the list, its file goes, and hooks/active with it.
    q.agents = [{ ...running('ag-d1', 'litter:sw-alpha-docs'), status: 'completed' }]
    await fireEvery(q)
    expect(existsSync(agentFile('ag-d1'))).toBe(false)
    expect(active()).toBe(false)
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

  test("End's stopping, after a handover, records nothing, leaves the new owner's entry as it is, and stands down", async () => {
    const launch = await launched(w)
    const h = await handedOver()
    const before = await kinds(launch)
    await expect(endSwarm(w.p, 'alpha', 'request')).rejects.toThrow('this session no longer owns the swarm alpha')
    // The launch ledger is the new owner's now: no swarm.stopping from this process.
    expect(await kinds(launch)).toEqual(before)
    expect(liveSwarm('alpha')?.state).toBe('live')
    expect(await policyText(w)).toBe(h.text)
    expect((await entryOf())?.state).toBe('live')
    expect(liveSwarm('alpha')?.lost).toBe(true)
    // No settle wait was started.
    await fireEvery(w.p)
    expect(await policyText(w)).toBe(h.text)
    expect(await kinds(launch)).toEqual(before)
  })

  test("the lead's swarm.end, after a handover, is refused, and records nothing", async () => {
    const launch = await launched(w)
    await handedOver()
    const before = await kinds(launch)
    const ctx = { p: w.p, caller: { agentId: null, agentType: null }, litterDir: w.litterDir, options: normalizeOptions(undefined) }
    expect(await recordSwarmEnd(ctx, { kind: 'swarm.end', swarm: 'alpha' })).toEqual({
      ok: false,
      error: 'litter: this session no longer owns the swarm alpha: it was handed to another session',
      field: 'swarm',
      allowed: [],
    })
    expect(await kinds(launch)).toEqual(before)
  })

  test('a Stop, after a handover, records nothing, stops no one and patches no policy', async () => {
    const launch = await launched(w)
    await bind(w, launch, { agentId: 'ag-l1', node: 'lead-a', n: 1, kind: 'orchestrator', cwd: wtPath(), branch: 'refs/heads/feature/alpha' })
    await nodeFile(await bind(w, launch, { agentId: 'ag-d1', node: 'docs', n: 1, kind: 'orchestrator', cwd: w.dir }))
    await handedOver()
    const before = await kinds(launch)
    const file = readFileSync(agentFile('ag-d1'), 'utf8')
    await expect(stopNode(w.p, 'alpha', 'ag-d1', 'soft')).rejects.toThrow('this session no longer owns the swarm alpha')
    expect(await kinds(launch)).toEqual(before)
    expect(stopped('alpha')).toEqual([])
    expect(readFileSync(agentFile('ag-d1'), 'utf8')).toBe(file)
    expect(w.p.toolCalls).toEqual([])
    expect(liveSwarm('alpha')?.lost).toBe(true)
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
// Q5

/** Another session's live swarm, as this one shows it. */
function copyOf(name: string, types: Record<string, string>): LiveSwarm {
  return {
    name,
    launch: '20261001-000000',
    revision: 1,
    spec: { name, goal: 'g', nodes: Object.keys(types).map(id => ({ id, kind: 'orchestrator' as const })) },
    nonce: 'n',
    types,
    typesReady: true,
    dirs: {},
    sessionCwd: w.dir,
    worktreeRoot: w.dir,
    commonDir: w.dir,
    roots: { litterDir: w.litterDir, litterCopies: [], ruleDirs: [] },
    tips: {},
    owner: { ref: `refs/litter-swarm/${name}`, oid: 'b'.repeat(40), generation: 1, session: 'sess-x' },
    state: 'live',
    readOnly: true,
    lost: false,
    flags: { isolationLost: false },
    startedAt: 1,
  }
}

describe("another session's swarm, read again (Q5)", () => {
  test('the swarm tick follows its owner, and drops it once the owner ended it', async () => {
    const launch = await launched(w, solo())
    const q = await w.restart('sess-b')
    await recoverSwarms(q, w.litterDir)
    expect(liveSwarm('alpha')).toEqual(expect.objectContaining({ readOnly: true, owner: expect.objectContaining({ session: 'sess-a', generation: 1 }) }))
    startSwarmTimers(q)

    // Handed over to sess-c.
    const oid = await moveRef(w, { ...(await blobAt(w, (await refOf(w))!)), session: 'sess-c', generation: 2 })
    await fireEvery(q)
    await until(() => liveSwarm('alpha')?.owner.oid === oid)
    expect(liveSwarm('alpha')!.owner).toEqual({ ref: 'refs/litter-swarm/alpha', oid, generation: 2, session: 'sess-c' })

    // sess-c ends it.
    const c = nodePorts({ sessionId: 'sess-c', cwd: w.dir })
    c.clock.now = q.clock.now
    await appendLaunchRecord(c, w.litterDir, 'alpha', launch, 'swarm.end', { status: 'ended', settled: true, nodes: {}, worktrees: [], branches: [] })
    await w.git('update-ref', '-d', 'refs/litter-swarm/alpha')
    ahead(q, READ_ONLY_REFRESH_MS)
    await fireEvery(q)
    await until(() => liveSwarm('alpha') === null)
  })

  test("Launch reads another session's copy again before it refuses: one its owner has ended doesn't refuse", async () => {
    const first = await launched(w, solo())
    const q = await w.restart('sess-b')
    await recoverSwarms(q, w.litterDir)
    expect(liveSwarm('alpha')?.readOnly).toBe(true)
    // sess-a ends it: swarm.end, the release, the entry's removal.
    const a = nodePorts({ sessionId: 'sess-a', cwd: w.dir })
    a.clock.now = q.clock.now
    await appendLaunchRecord(a, w.litterDir, 'alpha', first, 'swarm.end', { status: 'ended', settled: true, nodes: {}, worktrees: [], branches: [] })
    await w.git('update-ref', '-d', 'refs/litter-swarm/alpha')
    await writeSwarmPolicy(a, w.litterDir, 'alpha', null)
    ahead(q, 1_000)

    const next = await launched(w, solo())

    expect(next).not.toBe(first)
    expect(liveSwarm('alpha')).toEqual(expect.objectContaining({ launch: next, readOnly: false }))
  })

  test('the collision check counts neither a leftover entry nor a copy whose owner ended it', async () => {
    // alpha's types: litter:sw-alpha-lead-a and litter:sw-alpha-docs-b.
    const spec: SwarmSpec = {
      name: 'alpha',
      goal: 'g',
      nodes: [
        { id: 'lead-a', kind: 'orchestrator', worktree: 'none' },
        { id: 'docs-b', kind: 'orchestrator', worktree: 'none' },
      ],
    }
    // alpha-lead's node a serves litter:sw-alpha-lead-a: a copy of another session's swarm, whose ref is gone.
    putLiveSwarm(copyOf('alpha-lead', { a: 'litter:sw-alpha-lead-a' }))
    // alpha-docs's node b serves litter:sw-alpha-docs-b: an entry a crash left, with no ref.
    const q = nodePorts({ sessionId: 'sess-x', cwd: w.dir })
    await writeSwarmPolicy(q, w.litterDir, 'alpha-docs', {
      launch: '20261001-000000',
      state: 'live',
      commonDir: join(w.dir, '.git'),
      owner: { ref: 'refs/litter-swarm/alpha-docs', oid: 'c'.repeat(40), generation: 1, session: 'sess-x', checkedAt: Math.floor(nowOf(w.p) / 1000) },
      nodeTypes: ['litter:sw-alpha-docs-b'],
    })

    await launched(w, spec)

    expect(liveSwarm('alpha')?.readOnly).toBe(false)
    expect(liveSwarm('alpha-lead')).toBeNull()
  })

  test("a live swarm's entry still counts", async () => {
    await launched(w, { name: 'alpha-lead', goal: 'g', nodes: [{ id: 'a', kind: 'orchestrator', worktree: 'none' }] })
    // Another session, which hasn't read it yet: only the entry says it's live.
    const q = await w.restart('sess-b')
    const spec: SwarmSpec = { name: 'alpha', goal: 'g', nodes: [{ id: 'lead-a', kind: 'orchestrator', worktree: 'none' }] }
    await saveSwarm(w, spec)
    q.answers.push('Launch')
    const r = await launchSwarm(q, 'alpha')
    expect((r as { reason: string }).reason).toContain("its type litter:sw-alpha-lead-a is live swarm alpha-lead's too")
  })
})

// ---------------------------------------------------------------------------
// Q7, Q8

describe('the /clear rebind of a swarm this session owns (Q7, Q8)', () => {
  /** The engine's /clear: session.end `clear`, then the id moves; the first litter hook after it rebinds. */
  async function cleared(p: TestPorts, from: string, to: string): Promise<void> {
    clearOthers.registerLitterCommand = async () => undefined
    clearOthers.refreshPanes = async () => undefined
    await noteSessionEnd(p, { sessionId: from, reason: 'clear' } as never)
    p.sessionId = async () => to
    await rebound(p)
    await rebindSettled()
  }

  /** alpha's process crashed, and the same session took it back: recovery, with what `prepare` changed. */
  async function recovered(prepare: (q: TestPorts) => Promise<void> | void): Promise<TestPorts> {
    await launched(w)
    const q = await crashed('sess-a', 0)
    await prepare(q)
    await recoverSwarms(q, w.litterDir)
    expect(ownedSwarm('alpha')).not.toBeNull()
    return q
  }

  const swarmTypes = (q: TestPorts) => q.registeredAgents.map(a => a.name).filter(n => n.startsWith('sw-alpha-'))

  test("doesn't register the types of a swarm whose spec recovery didn't take", async () => {
    const q = await recovered(q => atomicWriteJson(q, revisionPath(w.litterDir, 'alpha', 1), { ...aSpec(), goal: 'Something else.' }))
    expect(liveSwarm('alpha')?.typesReady).toBe(false)
    expect(swarmTypes(q)).toEqual([])

    await cleared(q, 'sess-a', 'sess-c')

    expect(swarmTypes(q)).toEqual([])
    expect(liveSwarm('alpha')?.typesReady).toBe(false)
    // The rest of the rebind ran: the ref names the new session.
    expect((await blobAt(w, (await refOf(w))!)).session).toBe('sess-c')
  })

  test('registers the types the engine refused at recovery, and the swarm is ready once they are in', async () => {
    const q = await recovered(q => {
      q.registerAgentAnswer = spec => {
        if (spec.name.startsWith('sw-alpha-')) throw new Error('agent.register: refused for the test')
      }
    })
    expect(liveSwarm('alpha')?.typesReady).toBe(false)
    q.registerAgentAnswer = undefined
    // The port lists the refused calls too.
    q.registeredAgents = []

    await cleared(q, 'sess-a', 'sess-c')

    expect(swarmTypes(q).sort()).toEqual(['sw-alpha-docs', 'sw-alpha-fixer', 'sw-alpha-lead-a', 'sw-alpha-scout'])
    expect(liveSwarm('alpha')?.typesReady).toBe(true)
  })

  test('a swarm End finished during the rebind gets no more of it: no beat, no session.rebind after its swarm.end', async () => {
    const launch = await launched(w)
    const swap = clearOthers.rebindOwnership
    clearOthers.rebindOwnership = async (p, litterDir, to) => {
      await endSwarm(w.p, 'alpha', 'keep-everything')
      return swap(p, litterDir, to)
    }

    await cleared(w.p, 'sess-a', 'sess-c')

    const ks = await kinds(launch)
    expect(ks.at(-1)).toBe('swarm.end')
    expect(ks).not.toContain('session.rebind')
    expect(liveSwarm('alpha')).toBeNull()
    expect(w.p.logs.filter(l => l.includes("swarm alpha's beat failed"))).toEqual([])
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
