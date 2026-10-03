// WP-K: who owns a live swarm (15.4, "One session owns a live swarm"): the
// create-only ref and its blob, the lease beat, handover, the stale owner
// standing down, the rebind's swap after a /clear, and the release at End.
//
// Stub (phase 2b-1, package C): the signatures are the contract; the bodies are K's.
// Where the brief left a parameter open, the doc comment says what C picked.

import type { Ports } from '../ports'
import type { OwnerView } from './types'

const notBuilt = (name: string): Error => new Error(`litter: ${name} is not built yet (WP-K)`)

/** The ownership a launch took: `refs/litter-swarm/<name>` at its blob. */
export type Ownership = { ref: string; oid: string; generation: number }

/** Creates the ref, create-only, at a blob `{ swarm, launch, session, generation: 1, host, pid, acquiredAt }`. Rejects when it exists. */
export async function acquireOwnership(p: Ports, litterDir: string, name: string, launch: string): Promise<Ownership> {
  throw notBuilt('acquireOwnership')
}

/** Starts the 10 s beat for an owned swarm: the ref check, the lease file, policy.json's `owner.checkedAt`. */
export function startOwnerBeat(p: Ports, litterDir: string, name: string): void {
  throw notBuilt('startOwnerBeat')
}

/** Stops one swarm's beat, or every swarm's with no name (O at a session.end that isn't a clear). */
export function stopOwnerBeat(name?: string): void {
  throw notBuilt('stopOwnerBeat')
}

/** The ref, its blob, the lease's age, whether it's this session's, and whether a handover is possible. */
export async function readOwner(p: Ports, litterDir: string, name: string): Promise<OwnerView | null> {
  throw notBuilt('readOwner')
}

/** [Take over]: refused while the owner's lease is fresh or its pid alive here; then your confirmation, the swap to the next generation, and recovery. */
export async function handover(p: Ports, litterDir: string, name: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  throw notBuilt('handover')
}

/** After a /clear (O): each owned swarm's ref swapped to a blob naming `newSession`, keeping the generation. */
export async function rebindOwnership(p: Ports, litterDir: string, newSession: string): Promise<void> {
  throw notBuilt('rebindOwnership')
}

/** At End (P): a compare-and-delete of the ref on this session's oid, then the lease file. */
export async function releaseOwnership(p: Ports, litterDir: string, name: string): Promise<void> {
  throw notBuilt('releaseOwnership')
}

/** This session's ownership of `name` was lost (a beat found the ref moved). */
export function ownerLost(name: string): boolean {
  throw notBuilt('ownerLost')
}
