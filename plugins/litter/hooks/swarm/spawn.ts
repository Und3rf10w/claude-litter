// WP-L: the spawn check on agent.spawn (15.4, "The spawn check"): check and
// reserve in one synchronous step, the pending marker, `own` worktrees, the
// instance and rules blocks, the rewrite, the binding before the parent sees
// the result, and a node's non-swarm children.
//
// Stub (phase 2b-1, package C), not built yet: the signature is the contract;
// the body is L's. Until then every spawn passes to the engine unchanged.

import type { PortHook, SpawnHook } from '../hooktypes'

/**
 * Called by register.tsx after launch.ts's role check lets the spawn through,
 * with the engine's own `next` (never a wrapper: it carries properties a lambda lacks).
 */
export const swarmSpawn: PortHook<SpawnHook> = async (p, e, next) => next(e)
