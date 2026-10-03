// WP-K: how a swarm goes live (15.4, Launch's seven steps): the checks, your
// confirmation, ownership and the `new` worktrees, the node types, the bound
// branches, swarm.start; and the lead's mcp__litter__swarm_read.
//
// Stub (phase 2b-1, package C): the signatures are the contract; the bodies are K's.
// Where the brief left a parameter open, the doc comment says what C picked.

import type { AgentSpec, Ports } from '../ports'
import type { PortHook, SwarmReadHook } from '../hooktypes'
import type { SwarmSpec } from './types'

/** Launch's answer: the new launch's id, or why it refused (N shows it). */
export type LaunchResult = { ok: true; launch: string } | { ok: false; reason: string }

/**
 * Launches swarm `name` at its saved revision, or `opts.revision`. Every
 * refusing check runs before anything is written. Reads `session().litterDir`.
 */
export async function launchSwarm(p: Ports, name: string, opts?: { revision?: number }): Promise<LaunchResult> {
  throw new Error('litter: launchSwarm is not built yet (WP-K)')
}

/**
 * A node's type for `p.registerAgent`, the same for every instance: the node
 * prompt with its slots filled (prompts/swarm-node.ts), tools, model, effort,
 * maxTurns, permissionMode, `background: true`. No per-instance value.
 * C's choice: `ctx.brief` is the node's brief text at the spec's revision
 * (null when it has none), read by the caller, so this stays synchronous.
 */
export function nodeTypeSpec(spec: SwarmSpec, node: string, ctx: { brief: string | null }): AgentSpec {
  throw new Error('litter: nodeTypeSpec is not built yet (WP-K)')
}

/** tool.call on `mcp__litter__swarm_read`, after register.tsx's drain: answered here, never passed on. */
export const swarmReadTool: PortHook<SwarmReadHook> = async (p, e) => {
  return { result: JSON.stringify({ ok: false, error: "litter: mcp__litter__swarm_read isn't built yet" }) }
}
