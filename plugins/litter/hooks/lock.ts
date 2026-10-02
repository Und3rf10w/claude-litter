// The project's run lock: the create-only ref `refs/litter-active`, its lease,
// orphan recovery and compare-and-delete release (plan section 9, "Launch
// preconditions", step 0). Owner: phase 1b, work package D.

import type { Ports } from './ports'
import type { LockBlob } from './records/run'

export type LockHeld = { ok: true; oid: string; blob: LockBlob }
export type LockRefused = { ok: false; holder: LockBlob | null; reason: string }

export async function acquireLock(_p: Ports, _checkout: string, _blob: LockBlob): Promise<LockHeld | LockRefused> {
  return { ok: false, holder: null, reason: 'lock: not built yet (phase 1b, D)' }
}

/** Compare-and-delete on exactly `oid`: only the holder's own oid can release it. */
export async function releaseLock(_p: Ports, _checkout: string, _oid: string): Promise<boolean> {
  return false
}

/** Whether `refs/litter-active` still names `oid` (every write after acquisition checks this first). */
export async function stillHeld(_p: Ports, _checkout: string, _oid: string): Promise<boolean> {
  return false
}
