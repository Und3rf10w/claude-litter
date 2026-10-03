// WP-M: the mod's writer for the files guard.sh and hold.sh read: a node's or
// child's policy (`agents/<agentId>.json` with `node`), policy.json's `swarm`
// entry with `active`, and the pending markers left by a crash.
//
// Stub (phase 2b-1, package C): the signatures are the contract; the bodies are M's.
// Where the brief left a parameter open, the doc comment says what C picked.

import type { Ports } from '../ports'
import type { NodePolicy, SwarmEntry } from '../hookfiles'
import type { LiveSwarm, NodeBinding } from './types'

const notBuilt = (name: string): Error => new Error(`litter: ${name} is not built yet (WP-M)`)

/** The binding's state flags a policy carries. */
export type NodeFlags = { admitted: boolean; stopped: string | null; bind: boolean }

/** A node's or child's NodePolicy, from the spec at `swarm.revision`, the binding and the flags. A child gets its node's scope. */
export function nodePolicyFor(binding: NodeBinding, swarm: LiveSwarm, flags: NodeFlags): NodePolicy {
  throw notBuilt('nodePolicyFor')
}

/** Writes `agents/<agentId>.json` as `{ v: 1, node }`, atomically. */
export async function writeNodePolicy(p: Ports, litterDir: string, agentId: string, node: NodePolicy): Promise<void> {
  throw notBuilt('writeNodePolicy')
}

/** Read, change and write under one serial key per file; a missing file stays missing. */
export async function patchNodePolicy(p: Ports, litterDir: string, agentId: string, patch: Partial<NodePolicy>): Promise<void> {
  throw notBuilt('patchNodePolicy')
}

export async function patchNodePolicies(p: Ports, litterDir: string, agentIds: readonly string[], patch: Partial<NodePolicy>): Promise<void> {
  throw notBuilt('patchNodePolicies')
}

/** Removes an agent's policy, with its `done/` and `hold/` files. */
export async function removeNodePolicy(p: Ports, litterDir: string, agentId: string): Promise<void> {
  throw notBuilt('removeNodePolicy')
}

/**
 * Sets (or with null removes) policy.json's `swarm.swarms[name]` through
 * policy.ts's updatePolicy, creating policy.json when there's none, and
 * `active` when the first swarm goes live (removed when the last goes and no run is active).
 */
export async function writeSwarmPolicy(p: Ports, litterDir: string, name: string, entry: SwarmEntry | null): Promise<void> {
  throw notBuilt('writeSwarmPolicy')
}

/** Changes the entry through updatePolicy; `change` returning null, or a missing entry, leaves the file alone. */
export async function patchSwarmPolicy(p: Ports, litterDir: string, name: string, change: (entry: SwarmEntry) => SwarmEntry | null): Promise<void> {
  throw notBuilt('patchSwarmPolicy')
}

/** At session.start: removes leftover `hooks/pending/` markers (a crash between reservation and binding). Does nothing until M builds it. */
export async function clearPending(p: Ports, litterDir: string): Promise<void> {}
