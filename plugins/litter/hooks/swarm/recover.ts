// WP-K: what session.start does with a swarm that was live (15.4,
// "Recreating a swarm after a restart"): an owned one's types, tables,
// bindings and policies back, the recovery card; another session's read-only;
// and the resume and re-spawn requests with their continuation texts.
//
// Stub (phase 2b-1, package C): the signatures are the contract; the bodies are K's.
// Where the brief left a parameter open, the doc comment says what C picked.

import type { Ports } from '../ports'
import type { RecoveryCard } from './types'

/** At session.start, after the drain and the reconcile, with the state.ts gate closed. Does nothing until K builds it. */
export async function recoverSwarms(p: Ports, litterDir: string): Promise<void> {}

/** The recovery card's data for N, or null when there's none. */
export function recoveryCard(name: string): RecoveryCard | null {
  throw new Error('litter: recoveryCard is not built yet (WP-K)')
}

/** Fills the prompt box with `/litter:swarm resume <name> <nodes>` or `respawn`, and the confirmed authority. */
export async function requestResume(p: Ports, name: string, nodes: readonly string[], how: 'resume' | 'respawn'): Promise<void> {
  throw new Error('litter: requestResume is not built yet (WP-K)')
}

/**
 * The text the lead resumes a node with (`how: 'resume'`) or re-spawns it
 * with (`'respawn'`), for swarm_read's `for`. C's choice: the brief's
 * `(p, name, node)` plus `how`, since the two texts differ.
 */
export async function continuationText(p: Ports, name: string, node: string, how: 'resume' | 'respawn'): Promise<string> {
  throw new Error('litter: continuationText is not built yet (WP-K)')
}
