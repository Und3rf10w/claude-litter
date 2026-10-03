// The failed-fanout bridge (plan 15.10, 15.11; COMMON 2b-2, steps 3, 4 and
// 6): whether a halted fanout continues as a repair swarm, its baseline, the
// spec generated from run facts, the launch with no ask under `repair: auto`
// (and with one on `repair.start` under `off`), the start on the lead's next
// turn, and more budget.
//
// Owner: phase 2b-2, package X. Package V's stubs: every export below is the
// contract. W's lifecycle.ts calls continueAsRepair after a halted fanout's
// endRun, and writeSummary takes repairSummary's section; register.tsx calls
// repairNote at prompt.submit and repairTurnComplete at turn.complete; the
// registry routes repair.start and repair.budget here.

import type { Ports } from './ports'
import type { RecordHandler } from './records/core'
import type { TurnCompleteHook } from './hooktypes'
import type { SwarmSpec } from './swarm/types'
import { notYet } from './records/core'

const notBuilt = (what: string): Error => new Error(`litter: ${what} isn't built yet (phase 2b-2)`)

/**
 * After a halted fanout's endRun returned, outside the run's serial key
 * (`run:<runDir>`): starts the repair swarm when COMMON step 3's conditions
 * all hold, else records `repair.declined { reason }` and rewrites summary.md.
 * A no-op for any other run, or one a repair was already started or declined
 * for. lifecycle.ts awaits it (so the notification turn's `<swarm>` block sees
 * the swarm it started) and logs a rejection: the run's end stands either way.
 */
export async function continueAsRepair(_p: Ports, _runDir: string): Promise<void> {
  throw notBuilt('the repair bridge')
}

/**
 * The "Repair" section of the run's summary.md, as markdown with its own
 * heading: what started (the swarm, its budget, how to watch it), or why not
 * and the recommendation, or the recommendation under `repair: off`. Empty
 * for a run with nothing to say (not a fanout, or done). W's writeSummary
 * appends it, and keeps the rest of the summary when it rejects.
 */
export async function repairSummary(_p: Ports, _runDir: string): Promise<string> {
  throw notBuilt("the summary's Repair section")
}

/** `repair.start { run }` (the launcher's, under `repair: off`): the mod's own ask, going live, then the prompt fill. */
export const recordRepairStart: RecordHandler = async () => notYet('repair.start', '2b-2')

/** `repair.budget { swarm, rounds?, agents? }` (the launcher's): the mod's own ask, then the raised budget and a `budget` event. */
export const recordRepairBudget: RecordHandler = async () => notYet('repair.budget', '2b-2')

/**
 * Every turn.complete, the lead's and each subagent's (it acts on the lead's):
 * once the notification turn that started a repair swarm ends, it schedules
 * `p.after(0, …)` to submit the start for that swarm (never awaited in the
 * hook; the text doesn't start with `/`). register.tsx calls it inside the
 * hook's own catch: a rejection is logged and the turn passes on.
 */
export async function repairTurnComplete(_p: Ports, _e: Parameters<TurnCompleteHook>[1]): Promise<void> {
  throw notBuilt('the repair start')
}

/**
 * The notification turn's context line, after the `<swarm>` block: "repair
 * swarm S is live for run R; litter starts it after this turn", while a swarm
 * the bridge just started waits for its start; else null. Synchronous: it
 * reads module memory only. register.tsx calls it after the run's notice
 * settled and the block was built, and drops a throw (logged).
 */
export function repairNote(_p: Ports): string | null {
  throw notBuilt('the repair note')
}

/** A generated repair spec with its briefs (node id → text), or why the run's facts can't make one. */
export type RepairSpecResult = { ok: true; spec: SwarmSpec; briefs: Record<string, string> } | { ok: false; reason: string }

/**
 * The repair swarm's spec (COMMON step 4), from the run's facts only: the
 * tasks' owned paths, the kept integration worktree and branch, the failure
 * kind and the evidence paths, never task or verifier text. It must pass
 * validateSpec.
 */
export async function repairSpec(_p: Ports, _runDir: string): Promise<RepairSpecResult> {
  throw notBuilt('the repair spec')
}
