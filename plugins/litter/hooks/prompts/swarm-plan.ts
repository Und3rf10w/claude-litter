// A plan-template swarm's texts (plan 15.10, 15.11; COMMON steps 4 and 5):
// the bridge's swarm for a halted execute run. The gate-runner's, executor's,
// gate-critic's and adversary's briefs are section 7's role prompts turned
// into node briefs; the goal and the runner's first task are slot templates
// filled from run facts only. Rendered with renderSlots (slots.ts) by
// repair.ts. No backtick and no dollar-brace in any text here, and no model
// named.
//
// Owner: phase 3, package AC. AA filled CONFIRM_AUTO and CONFIRM_OFF (COMMON
// step 4's words, the contract the execute skill uses as written); the rest
// are AC's to write, empty until then, and nothing uses them before AC.

/** The gate-runner orchestrator's brief: works the run's unlanded gates in plan.md, in the run's checkout. */
export const PLAN_RUNNER_BRIEF = ''

/** The executor worker's brief (hooks/prompts/executor.ts as a node brief). */
export const PLAN_EXECUTOR_BRIEF = ''

/** The gate-critic worker's brief, the `verdicts: true` node (hooks/prompts/gate-critic.ts as a node brief). */
export const PLAN_CRITIC_BRIEF = ''

/** The adversary worker's brief, when a remaining gate asks for one (hooks/prompts/adversary.ts as a node brief). */
export const PLAN_ADVERSARY_BRIEF = ''

/** The gate-runner's first task, from run facts only. Slots are AC's. */
export const PLAN_TASK = ''

/** The spec's goal. Slots are AC's. */
export const PLAN_GOAL = ''

/**
 * The launch confirmation's repair line under `repair: auto` (COMMON step 4).
 * Slots: {rounds} (repairRounds, N), {attempts} (maxAttempts, M), {agents}
 * (repairAgents, A).
 */
export const CONFIRM_AUTO =
  "if a gate halts on a plan gap or runs out of attempts, a plan-template swarm continues the gates that haven't landed, in this checkout, and the mod lands each gate only if it's verified and an independent critic approves it: up to {rounds} rejected attempts in all, {attempts} per gate, and {agents} agents; nothing is pushed"

/** The launch confirmation's repair line under `repair: off` (COMMON step 4). No slots. */
export const CONFIRM_OFF = "if a gate halts, the run stops and keeps everything, and you choose what's next"
