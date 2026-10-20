// The fixed lines of the lead's <swarm> block (litter-prompts.md, "The lead's
// swarm context"), word for word. L's swarmContext composes the block from
// them, with the node rows between the open line and the hint, at most 1 KiB
// in all; render each with renderSlots (slots.ts).
//
// Contract owner: phase 2b-1, package C.

/** The block's first line. Slots: {swarm} (a validated name), {status} (`live` or `stopping`). */
export const SWARM_CONTEXT_OPEN = '<swarm name="{swarm}" status="{status}">'
/** The block's last line. */
export const SWARM_CONTEXT_CLOSE = '</swarm>'

/** The line before the close, in every block. */
export const SWARM_CONTEXT_HINT = 'Send to nodes with mcp__litter__swarm_send by node name.'

/**
 * The first block after a /clear opens with this (state.takeCleared()), and
 * lists every node rather than only the changed ones. Slot: {swarm}.
 */
export const SWARM_CONTEXT_CLEARED =
  "The conversation was cleared, but this swarm kept running and you are still its lead. Load the lead's instructions with the litter swarm skill: lead {swarm}."

/**
 * In SWARM_CONTEXT_CLEARED's place when the session id moved with no /clear
 * the mod saw (backgrounding, or a clear whose end it missed): the lead may
 * still remember the swarm, so it's told only what to do if it doesn't. Slot: {swarm}.
 */
export const SWARM_CONTEXT_MOVED =
  "This session moved to a new id; this swarm kept running and you are still its lead. If you no longer have the lead's instructions, load them with the litter swarm skill: lead {swarm}."

/**
 * After SWARM_CONTEXT_CLEARED, one per command the clear killed (state.takeClearKills(),
 * only when you chose [Clear anyway]). Slots: {who} ("fixer #2 under part-b", the
 * ClearKill's `who`), {call} (its `tool`, then its `detail` in parentheses when there
 * is one: "Bash (npm test)").
 */
export const SWARM_CONTEXT_CLEAR_KILLED = 'Cut short by the clear: {who} was running {call}, and the clear killed that command.'

/**
 * A direct message from you since the last block (state.takeDirect()). The form is
 * litter-prompts.md's example line. Slots: {node}, {text}.
 */
export const SWARM_CONTEXT_DIRECT = 'The user sent {node} directly: {text}'
