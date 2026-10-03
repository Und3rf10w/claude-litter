// WP-J: the lead's mcp__litter__swarm_propose: the schema, then validateSpec
// with the proposal's briefs, then the staged proposal and its diff's counts,
// or every error with its field and nothing written.
//
// Stub (phase 2b-1, package C), not built yet: the signature is the contract;
// the body is J's. Until then the tool answers that it isn't built.

import type { PortHook, SwarmProposeHook } from '../hooktypes'

/** tool.call on `mcp__litter__swarm_propose`: answered here, never passed on. Its input through tools.ts's decodeSwarmInput. */
export const swarmProposeTool: PortHook<SwarmProposeHook> = async (p, e) => {
  return { result: JSON.stringify({ ok: false, error: "litter: mcp__litter__swarm_propose isn't built yet" }) }
}
