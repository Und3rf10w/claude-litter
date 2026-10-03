// plan.write and gate.amend (COMMON steps 2 and 3): the planner's gates
// rendered into plan.md in section 10's format, a re-split of a halted
// chain's plan, and an amended gate. Every rewrite keeps the previous file as
// plan.<n>.md. Owner: phase 3, package AB.
//
// AA's stub: the two handlers keep today's validation and store the record in
// the run's ledger, writing no file; renderGateSection and writePlanVersion
// throw until AB builds them.

import type { RecordHandler } from './records/core'
import type { PlannedGate } from './records/execute'
import type { Ports } from './ports'
import { fail } from './records/core'
import { bodyOf, needText, store } from './records/design'

const GATE_ID = /^G[0-9]+$/

/**
 * `plan.write { run, gates, continueOf? }` (a PlanWriteInput): the approved
 * planner gates. AB renders them into the plan run's plan.md, or with
 * `continueOf` rewrites the chain root's plan.md past its landed gates, and
 * answers `{ ok: true, path }`.
 */
export const recordPlanWrite: RecordHandler = async (ctx, input) => {
  const gates = input.gates
  if (!Array.isArray(gates) || gates.length === 0) return fail("litter: 'gates' is required: the approved gates, in order", 'gates')
  const seen = new Set<string>()
  for (let i = 0; i < gates.length; i++) {
    const g = gates[i] as { id?: unknown; title?: unknown } | null
    if (!g || typeof g !== 'object' || typeof g.id !== 'string' || !GATE_ID.test(g.id)) {
      return fail(`litter: 'gates[${i}].id' must be a gate id like G1`, `gates[${i}].id`)
    }
    if (seen.has(g.id)) return fail(`litter: gate id ${g.id} appears twice in 'gates'`, `gates[${i}].id`)
    seen.add(g.id)
    if (typeof g.title !== 'string' || g.title.trim() === '') return fail(`litter: 'gates[${i}].title' is required`, `gates[${i}].title`)
  }
  return store(ctx, input, bodyOf(input))
}

/**
 * `gate.amend { run, gate, before?, after, reason }` (a GateAmendInput). AB
 * replaces the gate's section in the chain root's plan.md with `after`.
 */
export const recordGateAmend: RecordHandler = async (ctx, input) => {
  if (typeof input.gate !== 'string' || !GATE_ID.test(input.gate)) return fail("litter: 'gate' must be the gate id being amended, like G2", 'gate')
  if (input.before !== undefined && typeof input.before !== 'string') return fail("litter: 'before' must be the gate's text before the amendment", 'before')
  return (
    needText(input, 'after', "the amended gate's text, in the plan's gate format") ??
    needText(input, 'reason', 'why the gate is amended') ??
    store(ctx, input, bodyOf(input))
  )
}

/**
 * One gate's section in section 10's format: the heading, the Files, Checks
 * and Done when lines (and `Adversary: yes`), then the scope as prose, ending
 * with `Plan lines: <lines>` when it cites any. The one renderer; phase 4's
 * proposals reuse it.
 */
export function renderGateSection(g: PlannedGate): string {
  throw new Error(`plan: renderGateSection isn't built yet (phase 3, package AB), for ${g.id}`)
}

/**
 * Writes `text` as `<runDir>/plan.md`, first moving the current one, if any,
 * to `plan.<n>.md` with the next free n (layout.ts, planVersionPath).
 * Answers the path written (absolute) and the previous file's new path, or
 * null when there was none.
 */
export async function writePlanVersion(p: Ports, runDir: string, text: string): Promise<{ path: string; previous: string | null }> {
  throw new Error(`plan: writePlanVersion isn't built yet (phase 3, package AB), for ${runDir}`)
}
