// The blocks L's spawn check puts at the top of each spawn's prompt, before
// the parent's task (plan 15.4, "It rewrites the call"), ported verbatim from
// docs/litter-prompts.md ("Instance block", "The rules block"). Rendered with
// renderSlots (slots.ts) for each spawn: one worker template runs under
// several parents, and the spawns left change as instances start. `{nonce}`
// is the instance's own, made at its spawn after the parent's task is fixed
// (spawn.ts, R12), so text in a task can't close or forge a block.
//
// Contract owner: phase 2b-1, package C; the repair budget line is phase
// 2b-2's (package Y).

/**
 * Slots: {nonce}, {node}, {n}, {swarm}, {parent_node}, {parent_route}, {cwd},
 * {branch} (unset drops its line), {spawns_left}, {budget} (REPAIR_BUDGET_LEFT
 * for a repair swarm; unset drops its line), {token}.
 */
export const SWARM_INSTANCE = `<instance id="{nonce}">
You are {node} #{n} in swarm {swarm}.
Parent: {parent_node}. {parent_route}
Directory: {cwd}
Branch: {branch}
You may still start: {spawns_left}
Repair budget left: {budget}
Bind token: {token}
</instance id="{nonce}">`

/**
 * {budget} for a repair swarm (plan 15.11, "The repair budget"), at this
 * spawn, after its own count. Slots: {rounds_left}, {rounds}, {agents_left}, {agents}.
 */
export const REPAIR_BUDGET_LEFT =
  "{rounds_left} of {rounds} rounds (a round is the critic's verdict on a new verify), {agents_left} of {agents} agents (the workers and agents the swarm's nodes start). Past either, litter refuses the next spawn or land: report blocked to your parent, saying what you need."

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
