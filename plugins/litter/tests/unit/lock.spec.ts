// Tier 2: the run lock against real git (plan section 9, "Launch
// preconditions", step 0): one winner, compare-and-delete, the lease, and
// orphan recovery that never steals a live holder.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { LockBlob } from '../../hooks/records/run'
import { acquireLock, LOCK_REF, leaseFor, readLease, readLock, releaseLock, startLease, stillHeld, stopLease } from '../../hooks/lock'
import { takeLock } from '../../hooks/lifecycle'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { leasePath, runDir } from '../../hooks/layout'
import { atomicWriteJson } from '../../hooks/fsx'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// Real git in every test; a loaded machine takes seconds.
setDefaultTimeout(120_000)

const NOW = 1_800_000_000_000
const mod = { source: 'mod' } as const

let p: TestPorts
let dir: string
let litterDir: string
let cleanup: () => void
let git: (...argv: string[]) => Promise<string>

beforeEach(async () => {
  p = nodePorts({ sessionId: 'session-b' })
  p.clock.now = NOW
  ;({ dir, cleanup } = scratch())
  ;({ git } = await scratchRepo(p, dir))
  litterDir = join(dir, '.claude', 'litter')
})
afterEach(() => {
  stopLease()
  cleanup()
})

const blob = (run: string, at = NOW, session = 'session-a'): LockBlob => ({ run, session, acquiredAt: at })

/** A run.start record for `run`, and a generation when `open`. */
async function ledgerOf(run: string, open = false): Promise<void> {
  const rd = runDir(litterDir, run)
  await appendRecord(p, rd, { run, kind: 'run.start', by: { source: 'launcher' }, body: { workflow: 'execute', oid: 'x' } })
  if (open) {
    await appendRecord(p, rd, {
      run,
      kind: 'run.launch',
      by: mod,
      body: { taskId: 't1', runId: 'wf_abc123', scriptPath: null, generation: 1, session: 'session-a', oid: 'x' },
    })
  }
}

const kinds = async (run: string) => (await readLedger(p, runDir(litterDir, run), run)).records.map(r => r.kind)

describe('the lock ref', () => {
  test('of eight concurrent acquirers exactly one wins, and the rest name it', async () => {
    const runs = Array.from({ length: 8 }, (_, i) => `20261002-execute-r${i}`)
    const results = await Promise.all(runs.map(r => acquireLock(p, dir, blob(r))))
    const winners = results.filter(r => r.ok)
    expect(winners).toHaveLength(1)
    const winner = winners[0]!
    if (!winner.ok) throw new Error('unreachable')
    expect((await readLock(p, dir))?.oid).toBe(winner.oid)
    for (const r of results.filter(x => !x.ok)) {
      if (r.ok) continue
      expect(r.holder?.run).toBe(winner.blob.run)
      expect(r.oid).toBe(winner.oid)
      expect(r.reason).toContain(winner.blob.run)
    }
  })

  test('only the holder oid releases it', async () => {
    const held = await acquireLock(p, dir, blob('20261002-execute-aaaaaa'))
    if (!held.ok) throw new Error(held.reason)
    const other = (await git('hash-object', '-w', '--stdin').catch(() => '')).trim() || '0'.repeat(40)
    expect(await releaseLock(p, dir, other)).toBe(false)
    expect(await releaseLock(p, dir, 'not-an-oid')).toBe(false)
    expect(await stillHeld(p, dir, held.oid)).toBe(true)
    expect(await releaseLock(p, dir, held.oid)).toBe(true)
    expect(await readLock(p, dir)).toBeNull()
  })

  test("a ref that isn't a litter blob reads as no holder", async () => {
    const head = (await git('rev-parse', 'HEAD')).trim()
    await git('update-ref', LOCK_REF, head)
    expect(await readLock(p, dir)).toEqual({ oid: head, blob: null })
    const r = await takeLock(p, litterDir, blob('20261002-execute-bbbbbb', NOW, 'session-b'), false)
    expect(r).toEqual(expect.objectContaining({ ok: false }))
    expect(!r.ok && r.error).toContain(`git update-ref -d ${LOCK_REF} ${head}`)
  })
})

describe('the lease', () => {
  test('beats now and every 10 s, through p.every, and stops on release', async () => {
    const held = await acquireLock(p, dir, blob('20261002-execute-cccccc'))
    if (!held.ok) throw new Error(held.reason)
    const lease = startLease(p, litterDir, dir, held)
    expect(await lease.beat()).toBe(true)
    expect(await readLease(p, litterDir, held.oid)).toEqual({ oid: held.oid, run: held.blob.run, session: 'session-a', beatAt: NOW })
    expect(p.timers.size).toBe(1)
    p.clock.now = NOW + 10_000
    for (const fn of p.timers) fn()
    // The beat runs git; poll for it rather than guess how long a loaded machine takes.
    for (let i = 0; i < 100 && (await readLease(p, litterDir, held.oid))?.beatAt !== NOW + 10_000; i++) await Bun.sleep(50)
    expect((await readLease(p, litterDir, held.oid))?.beatAt).toBe(NOW + 10_000)
    stopLease(held.oid)
    expect(lease.stopped).toBe(true)
    expect(p.timers.size).toBe(0)
    expect(leaseFor(held.oid)).toBeUndefined()
  })

  test('a beat that finds another oid on the ref stops for good and writes nothing', async () => {
    const held = await acquireLock(p, dir, blob('20261002-execute-dddddd'))
    if (!held.ok) throw new Error(held.reason)
    const lease = startLease(p, litterDir, dir, held)
    expect(await releaseLock(p, dir, held.oid)).toBe(true)
    const next = await acquireLock(p, dir, blob('20261002-execute-eeeeee', NOW + 1))
    expect(next.ok).toBe(true)
    expect(await lease.beat()).toBe(false)
    expect(lease.stopped).toBe(true)
    expect(existsSync(leasePath(litterDir, held.oid))).toBe(false)
    expect(await lease.beat()).toBe(false)
  })
})

describe('takeLock and orphans', () => {
  test('an orphan with no lease, acquired over 60 s ago, is recovered: lock.recovered, then launch_failed', async () => {
    const old = '20261002-execute-orphan'
    await ledgerOf(old)
    const first = await acquireLock(p, dir, blob(old, NOW - 61_000))
    if (!first.ok) throw new Error(first.reason)
    const r = await takeLock(p, litterDir, blob('20261002-execute-newone', NOW, 'session-b'), false)
    expect(r.ok).toBe(true)
    expect((await readLock(p, dir))?.blob?.run).toBe('20261002-execute-newone')
    expect(await kinds(old)).toEqual(['run.start', 'lock.recovered', 'run.end'])
    const end = (await readLedger(p, runDir(litterDir, old), old)).records.at(-1)!
    expect(end.body).toEqual(expect.objectContaining({ generation: 0, status: 'launch_failed', source: 'reconcile' }))
    const recovered = (await readLedger(p, runDir(litterDir, old), old)).records[1]!
    expect(recovered.body).toEqual(expect.objectContaining({ oid: first.oid, run: old, session: 'session-a', branch: null }))
  })

  test('an orphan whose lease is stale is recovered even with a fresh acquiredAt', async () => {
    const old = '20261002-execute-stale1'
    const first = await acquireLock(p, dir, blob(old, NOW))
    if (!first.ok) throw new Error(first.reason)
    await atomicWriteJson(p, leasePath(litterDir, first.oid), { oid: first.oid, run: old, session: 'session-a', beatAt: NOW - 61_000 })
    const r = await takeLock(p, litterDir, blob('20261002-execute-newtwo', NOW, 'session-b'), false)
    expect(r.ok).toBe(true)
    // No run.start: only the recovery is recorded.
    expect(await kinds(old)).toEqual(['lock.recovered'])
    expect(existsSync(leasePath(litterDir, first.oid))).toBe(false)
  })

  test('a launch with a fresh lease is not stolen; asked, it can be released by hand', async () => {
    const live = '20261002-execute-live01'
    await ledgerOf(live)
    const first = await acquireLock(p, dir, blob(live, NOW - 120_000))
    if (!first.ok) throw new Error(first.reason)
    await atomicWriteJson(p, leasePath(litterDir, first.oid), { oid: first.oid, run: live, session: 'session-a', beatAt: NOW - 5_000 })

    const refused = await takeLock(p, litterDir, blob('20261002-execute-other1', NOW, 'session-b'), false)
    expect(refused).toEqual(expect.objectContaining({ ok: false }))
    expect(!refused.ok && refused.error).toContain('still launching')
    expect(await stillHeld(p, dir, first.oid)).toBe(true)

    // Interactive, with no one to answer (-p): still refused.
    const unanswered = await takeLock(p, litterDir, blob('20261002-execute-other1', NOW, 'session-b'))
    expect(unanswered.ok).toBe(false)
    expect(p.asked).toHaveLength(1)
    expect(await stillHeld(p, dir, first.oid)).toBe(true)

    p.answers.push('Release it')
    const forced = await takeLock(p, litterDir, blob('20261002-execute-other1', NOW, 'session-b'))
    expect(forced.ok).toBe(true)
    expect(await kinds(live)).toEqual(['run.start', 'lock.forced', 'run.end'])
  })

  test('a run with an open generation keeps its lock, however stale its lease', async () => {
    const live = '20261002-execute-running'
    await ledgerOf(live, true)
    const first = await acquireLock(p, dir, blob(live, NOW - 3_600_000))
    if (!first.ok) throw new Error(first.reason)
    const r = await takeLock(p, litterDir, blob('20261002-execute-other2', NOW, 'session-b'), false)
    expect(r).toEqual(expect.objectContaining({ ok: false }))
    expect(!r.ok && r.error).toContain('is active (task t1)')
    expect(await stillHeld(p, dir, first.oid)).toBe(true)
    expect(await kinds(live)).toEqual(['run.start', 'run.launch'])
  })

  test('a lock left by a run that already ended is released as stale', async () => {
    const done = '20261002-execute-ended1'
    await ledgerOf(done, true)
    await appendRecord(p, runDir(litterDir, done), {
      run: done,
      kind: 'run.end',
      by: mod,
      body: { taskId: 't1', generation: 1, status: 'done', reason: null, source: 'notification' },
    })
    const first = await acquireLock(p, dir, blob(done))
    if (!first.ok) throw new Error(first.reason)
    const r = await takeLock(p, litterDir, blob('20261002-execute-other3', NOW, 'session-b'), false)
    expect(r.ok).toBe(true)
  })

  test("this session's own launch that never reached Workflow is replaced by its next run.start", async () => {
    const mine = '20261002-execute-mine01'
    await ledgerOf(mine)
    const first = await acquireLock(p, dir, blob(mine, NOW, 'session-b'))
    if (!first.ok) throw new Error(first.reason)
    await atomicWriteJson(p, leasePath(litterDir, first.oid), { oid: first.oid, run: mine, session: 'session-b', beatAt: NOW })
    const r = await takeLock(p, litterDir, blob('20261002-execute-mine02', NOW, 'session-b'), false)
    expect(r.ok).toBe(true)
    expect(p.asked).toHaveLength(0)
    expect(await kinds(mine)).toEqual(['run.start', 'run.end'])
  })
})
