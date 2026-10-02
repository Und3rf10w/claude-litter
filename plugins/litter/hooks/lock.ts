// The project's run lock: the create-only ref `refs/litter-active`, its lease,
// orphan recovery and compare-and-delete release (plan section 9, "Launch
// preconditions", step 0). Owner: phase 1b, work package D.
//
// The ref names a blob `{ run, session, acquiredAt }`, so every acquisition
// has its own oid. Git's ref lock makes the create atomic across processes,
// sessions and linked worktrees (refs live in the common directory). Only the
// holder's own oid can delete it, so a recovery never steals a live lock.

import type { Ports } from './ports'
import type { Lease, LockBlob } from './records/run'
import { leasePath } from './layout'
import { atomicWriteJson, readJson, remove } from './fsx'

export const LOCK_REF = 'refs/litter-active'
/** How often a pending launch beats its lease. */
export const LEASE_EVERY_MS = 10_000
/** A lease (or, with none, an acquisition) older than this, on a run with no generation, is an orphan. */
export const LEASE_STALE_MS = 60_000

export type LockHeld = { ok: true; oid: string; blob: LockBlob }
export type LockRefused = { ok: false; holder: LockBlob | null; reason: string; oid?: string }

const OID = /^[0-9a-f]{40,64}$/

async function git(p: Ports, checkout: string, argv: string[], stdin?: string) {
  const init = stdin === undefined ? {} : { stdin }
  return p.run(['git', '-C', checkout, ...argv], init)
}

/** The ref's oid and its blob, or null when no one holds it. A blob that doesn't parse reads as `holder: null`. */
export async function readLock(p: Ports, checkout: string): Promise<{ oid: string; blob: LockBlob | null } | null> {
  const r = await git(p, checkout, ['rev-parse', '-q', '--verify', LOCK_REF])
  if (r.code !== 0) return null
  const oid = r.stdout.trim()
  if (!OID.test(oid)) return null
  const b = await git(p, checkout, ['cat-file', 'blob', oid])
  if (b.code !== 0) return { oid, blob: null }
  try {
    const blob = JSON.parse(b.stdout) as LockBlob
    return typeof blob?.run === 'string' && typeof blob.session === 'string' && typeof blob.acquiredAt === 'number'
      ? { oid, blob }
      : { oid, blob: null }
  } catch {
    return { oid, blob: null }
  }
}

/** Creates the ref, or refuses naming the holder. Never waits and never steals. */
export async function acquireLock(p: Ports, checkout: string, blob: LockBlob): Promise<LockHeld | LockRefused> {
  const hashed = await git(p, checkout, ['hash-object', '-w', '--stdin'], JSON.stringify(blob))
  const oid = hashed.stdout.trim()
  if (hashed.code !== 0 || !OID.test(oid)) {
    return { ok: false, holder: null, reason: `litter: couldn't write the lock blob: ${hashed.stderr.trim()}` }
  }
  const created = await git(p, checkout, ['update-ref', '-m', `litter: lock for ${blob.run}`, LOCK_REF, oid, ''])
  if (created.code === 0) return { ok: true, oid, blob }
  const holder = await readLock(p, checkout)
  if (!holder) {
    return { ok: false, holder: null, reason: `litter: couldn't take ${LOCK_REF}: ${created.stderr.trim()}` }
  }
  const who = holder.blob ? `run ${holder.blob.run} (session ${holder.blob.session})` : `an unreadable holder (${holder.oid})`
  return { ok: false, holder: holder.blob, oid: holder.oid, reason: `litter: another litter run holds the project's run lock: ${who}` }
}

/** Compare-and-delete on exactly `oid`: only the holder's own oid can release it. */
export async function releaseLock(p: Ports, checkout: string, oid: string): Promise<boolean> {
  if (!OID.test(oid)) return false
  const r = await git(p, checkout, ['update-ref', '-m', 'litter: release', '-d', LOCK_REF, oid])
  return r.code === 0
}

/** Whether `refs/litter-active` still names `oid` (every write after acquisition checks this first). */
export async function stillHeld(p: Ports, checkout: string, oid: string): Promise<boolean> {
  const r = await git(p, checkout, ['rev-parse', '-q', '--verify', LOCK_REF])
  return r.code === 0 && r.stdout.trim() === oid
}

export async function readLease(p: Ports, litterDir: string, oid: string): Promise<Lease | null> {
  try {
    const lease = await readJson<Lease>(p, leasePath(litterDir, oid))
    return lease && lease.oid === oid && typeof lease.beatAt === 'number' ? lease : null
  } catch {
    return null
  }
}

export const removeLease = (p: Ports, litterDir: string, oid: string): Promise<void> =>
  remove(p, leasePath(litterDir, oid)).catch(() => {})

/**
 * A lock is orphaned when its run has no generation (the caller checks the
 * ledger) and its lease is stale: the lease names the same oid and beatAt is
 * over 60 s old, or there's no lease and acquiredAt is.
 */
export function leaseStale(lease: Lease | null, blob: LockBlob, now: number): boolean {
  const last = lease ? lease.beatAt : blob.acquiredAt
  return now - last > LEASE_STALE_MS
}

export type LeaseBeat = {
  /** One beat: false (and the beat stops for good) once the ref names another oid. */
  beat(): Promise<boolean>
  cancel(): void
  readonly stopped: boolean
}

const beats = new Map<string, LeaseBeat>()

/**
 * Beats `<litterDir>/lock-lease-<oid>.json` now and every 10 s, through
 * `p.every`, which keeps running while run.start waits on a $.ui.ask. Each
 * beat first checks that the ref still names this oid, and stops for good if
 * it doesn't, so a holder woken from a suspension never writes over its
 * replacement's lease (the file is per oid anyway).
 */
export function startLease(p: Ports, litterDir: string, checkout: string, held: LockHeld): LeaseBeat {
  beats.get(held.oid)?.cancel()
  let stopped = false
  let busy: Promise<boolean> | null = null
  let timer: { cancel(): void } | null = null
  const lease: LeaseBeat = {
    get stopped() {
      return stopped
    },
    cancel() {
      stopped = true
      timer?.cancel()
      if (beats.get(held.oid) === lease) beats.delete(held.oid)
    },
    beat() {
      if (stopped) return Promise.resolve(false)
      if (busy) return busy
      busy = (async () => {
        try {
          if (!(await stillHeld(p, checkout, held.oid))) {
            lease.cancel()
            return false
          }
          if (stopped) return false
          const body: Lease = { oid: held.oid, run: held.blob.run, session: held.blob.session, beatAt: await p.now() }
          await atomicWriteJson(p, leasePath(litterDir, held.oid), body)
          return true
        } catch (err) {
          p.log(`lease beat for ${held.blob.run} failed: ${err instanceof Error ? err.message : String(err)}`)
          return !stopped
        } finally {
          busy = null
        }
      })()
      return busy
    },
  }
  beats.set(held.oid, lease)
  timer = p.every(LEASE_EVERY_MS, () => void lease.beat())
  return lease
}

/** Stops the beat for one oid (run.launch, release), or every beat (session.end). */
export function stopLease(oid?: string): void {
  if (oid === undefined) {
    for (const b of [...beats.values()]) b.cancel()
    return
  }
  beats.get(oid)?.cancel()
}

/** The beat for an oid, while one runs in this module instance. */
export const leaseFor = (oid: string): LeaseBeat | undefined => beats.get(oid)
