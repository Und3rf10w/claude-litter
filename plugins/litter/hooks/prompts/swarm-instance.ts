// The blocks L's spawn check puts at the top of each spawn's prompt, before
// the parent's task (plan 15.4, "It rewrites the call"), ported verbatim from
// docs/litter-prompts.md ("Instance block", "The rules block"). Rendered with
// renderSlots (slots.ts) for each spawn: one worker template runs under
// several parents, and the spawns left change as instances start. `{nonce}`
// is the instance's own, made at its spawn after the parent's task is fixed
// (spawn.ts, R12), so text in a task can't close or forge a block.
//
// Contract owner: phase 2b-1, package C.

/** Slots: {nonce}, {node}, {n}, {swarm}, {parent_node}, {parent_route}, {cwd}, {branch} (unset drops its line), {spawns_left}, {token}. */
export const SWARM_INSTANCE = `<instance id="{nonce}">
You are {node} #{n} in swarm {swarm}.
Parent: {parent_node}. {parent_route}
Directory: {cwd}
Branch: {branch}
You may still start: {spawns_left}
Bind token: {token}
</instance id="{nonce}">`

/** Slots: {nonce}, {rules} (RULES_NONE until phase 3 selects them). */
export const SWARM_RULES = `<rules id="{nonce}">
{rules}
</rules id="{nonce}">`

/** {parent_node} for an orchestrator. */
export const PARENT_LEAD = 'the lead'
/** {parent_route} by the node's kind. */
export const PARENT_ROUTE_ORCHESTRATOR = 'Send to it with SendMessage, addressed to main; your report goes to it too.'
export const PARENT_ROUTE_WORKER = 'Your report goes to it.'

/** {spawns_left} without `spawns`. With them, "fixer 1 of 2, reviewer 3 of 3" (SPAWNS_LEFT_ITEM, joined with ", "). */
export const SPAWNS_LEFT_NONE = "nothing (you don't spawn swarm agents)"
/** Slots: {node}, {left}, {of}. */
export const SPAWNS_LEFT_ITEM = '{node} {left} of {of}'
/** Added after the counts, for a worker that may spawn (open decision 1, C: hold.sh, with the engine's park behind it). */
export const SPAWNS_LEFT_WORKER_HOLD =
  'If your turn ends while agents you started are still running, the swarm holds it until they finish; their results then arrive as messages, and you report after reading them.'

/** {rules} when nothing matches the instance (and until phase 3 builds the selection). */
export const RULES_NONE = 'none apply'
