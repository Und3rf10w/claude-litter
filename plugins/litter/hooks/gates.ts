// The gate sections of plan.md, a contract (plan section 10, "Gate sections in
// plan.md are a contract"). Owner: phase 1b, work package D. The design author,
// the planner and the execute launcher all render to or parse this shape.

export type Gate = {
  /** `G2`. */
  id: string
  title: string
  files: string[]
  checks: string
  doneWhen: string
  adversary: boolean
  rollback: string | null
  /** 1-based, inclusive: the heading line through the line before the next heading at the same or a higher level. */
  lines: { start: number; end: number }
  /** The section's text, verbatim. */
  excerpt: string
}

export type GateParse = { ok: true; gates: Gate[] } | { ok: false; error: string; gate: string | null; field: string | null }

export function parseGates(_planText: string): GateParse {
  return { ok: false, error: 'gates: not built yet (phase 1b, D)', gate: null, field: null }
}
