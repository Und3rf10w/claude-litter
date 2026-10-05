// A design's run.start (COMMON step 2): its fields, checked on the input
// alone, and its args. Owner: phase 4, WP-BD. WP-BA moved today's design
// parse and args here from lifecycle.ts unchanged; lifecycle.ts reaches both
// through its `deps`.

import type { Ports } from '../ports'
import type { LitterOptions } from '../options'
import type { RecordInput } from '../records/core'
import type { BarItem, Deliverable, Lens, LensRole } from '../records/run'
import type { RuleRef, SelectInput, Selection } from '../records/rules'
import type { Parsed, Spec } from '../lifecycle'
import { fail } from '../records/core'
import { DELIVERABLES } from '../records/run'
import { RUN_ID } from '../layout'
import { isObject, ok, strings, text } from '../lifecycle'
import { renderBar } from './bar'

/**
 * A design's own fields of run.start, as parseDesign checked them; run.start
 * keeps them as `spec.design`. The fields every run has (goal, maxRounds,
 * setup, linkDirs, runRules) are the spec's own.
 */
export type DesignSpec = {
  deliverable: Deliverable
  bar: BarItem[]
  lenses: Lens[]
  /** Stub (WP-BA): today's bare strings. WP-BD makes them decision 3's objects. */
  empiricalUnknowns: string[]
  anchors: string[]
  priorRun: string | null
  feedback: string | null
}

function parseBar(v: unknown): Parsed<BarItem[]> {
  if (!Array.isArray(v) || v.length === 0) return fail("'bar' is required for a design: a list of { id: 'C1' | 'B1', text, evidence, reason? }", 'bar')
  const ids = new Set<string>()
  const bar: BarItem[] = []
  for (let i = 0; i < v.length; i++) {
    const b = v[i] as BarItem
    const at = `bar[${i}]`
    if (!isObject(b) || typeof b.id !== 'string' || !/^[CB][0-9]+$/.test(b.id)) return fail(`'${at}.id' must be C<n> for a criterion or B<n> for a ban`, `${at}.id`)
    if (ids.has(b.id)) return fail(`bar id '${b.id}' appears twice`, `${at}.id`)
    ids.add(b.id)
    if (typeof b.text !== 'string' || b.text.trim() === '') return fail(`'${at}.text' is required`, `${at}.text`)
    if (typeof b.evidence !== 'string' || b.evidence.trim() === '') return fail(`'${at}.evidence' is required: what evidence ${b.id} needs`, `${at}.evidence`)
    if (b.id.startsWith('B') && (typeof b.reason !== 'string' || b.reason.trim() === '')) return fail(`ban ${b.id} needs a '${at}.reason'`, `${at}.reason`)
    bar.push({ id: b.id, text: b.text, evidence: b.evidence, ...(typeof b.reason === 'string' ? { reason: b.reason } : {}) })
  }
  return ok(bar)
}

const LENS_ROLES: readonly LensRole[] = ['falsifier', 'coverage', 'mechanism']
const DEFAULT_LENSES: Lens[] = LENS_ROLES.map(role => ({ role, name: role, focus: '', anchors: [] }))

function parseLenses(v: unknown): Parsed<Lens[]> {
  if (v === undefined || v === null) return ok(DEFAULT_LENSES.map(l => ({ ...l })))
  if (!Array.isArray(v) || v.length === 0) return fail("'lenses' must be a list of { role, name, focus, anchors }", 'lenses')
  const lenses: Lens[] = []
  for (let i = 0; i < v.length; i++) {
    const l = v[i] as Lens
    const at = `lenses[${i}]`
    if (!isObject(l) || !LENS_ROLES.includes(l.role)) return fail(`'${at}.role' must be one of ${LENS_ROLES.join(', ')}`, `${at}.role`, LENS_ROLES)
    const anchors = strings(l.anchors, `${at}.anchors`, { optional: true })
    if (!anchors.ok) return anchors
    lenses.push({ role: l.role, name: typeof l.name === 'string' && l.name.trim() !== '' ? l.name : l.role, focus: typeof l.focus === 'string' ? l.focus : '', anchors: anchors.value })
  }
  return ok(lenses)
}

/**
 * A design's own fields of run.start, on the input alone (run.start's
 * parse calls it after the fields every run has). A refusal names the
 * field; `warnings` go into run.start's reply with the others.
 *
 * The input is the record call's, unchecked: a field's type is this
 * function's to check.
 */
export function parseDesign(input: RecordInput): Parsed<DesignSpec> & { warnings?: string[] } {
  const goal = text(input.goal, 'goal')
  if (!goal.ok) return goal
  if (!goal.value) return fail("a design run needs 'goal': the user's words, verbatim", 'goal')
  if (!DELIVERABLES.includes(input.deliverable as Deliverable)) return fail("'deliverable' must say what the design delivers", 'deliverable', DELIVERABLES)
  const deliverable = input.deliverable as Deliverable
  const bar = parseBar(input.bar)
  if (!bar.ok) return bar
  const lenses = parseLenses(input.lenses)
  if (!lenses.ok) return lenses
  const unknowns = strings(input.empiricalUnknowns, 'empiricalUnknowns', { optional: true })
  if (!unknowns.ok) return unknowns
  if (unknowns.value.length > 2) return fail("'empiricalUnknowns' takes at most two", 'empiricalUnknowns')
  const anchors = strings(input.anchors, 'anchors', { optional: true })
  if (!anchors.ok) return anchors
  const prior = text(input.priorRun, 'priorRun')
  if (!prior.ok) return prior
  if (prior.value && !RUN_ID.test(prior.value)) return fail("'priorRun' must be a run id", 'priorRun')
  const feedback = text(input.feedback, 'feedback')
  if (!feedback.ok) return feedback
  return ok({
    deliverable,
    bar: bar.value,
    lenses: lenses.value,
    empiricalUnknowns: unknowns.value,
    anchors: anchors.value,
    priorRun: prior.value,
    feedback: feedback.value,
  })
}

/** What run.start's prepare gives designArgs, before it writes anything. */
export type DesignArgsCtx = {
  litterDir: string
  /** Absolute: the session's checkout, which the base snapshot is of. */
  checkout: string
  run: string
  /** run.start's parse; `spec.design` is parseDesign's. */
  spec: Spec
  /** Your run rules as args.rules renders them ("For this run (stated by you): …"). */
  runRules: string[]
  /** The args every run has: run, nonce, authorized, and rules (your run rules). */
  base: Record<string, unknown>
  /** The base snapshot's commit, `refs/litter/<run>/base` once run.start writes it. */
  snapBase: string
  options: LitterOptions
  /**
   * run.start's selection (16.5; lifecycle.ts, selectRules): the launch's one
   * seam to rules/select.ts, whose refusal already says the launch can't
   * start without its rules.
   */
  selectRules: (input: SelectInput) => Promise<Parsed<Selection>>
}

/** designArgs' answer: the args, `run.json.rules`, and bar.md's text. */
export type DesignLaunch = { args: Record<string, unknown>; rules: RuleRef[]; barText: string }

/**
 * A design's args (the DesignArgs contract in records/run.ts), the accepted
 * rule versions they deliver, and bar.md, from prepare's design branch. A
 * refusal is the launch's, before anything is written.
 *
 * Stub (WP-BA): today's code moved. The selection gives `rules` after your
 * run rules (empty for a design until WP-BD), the bar is your items, each
 * unknown is its string, and there's no `template` or `prior`.
 */
export async function designArgs(_p: Ports, ctx: DesignArgsCtx): Promise<Parsed<DesignLaunch>> {
  const { spec, runRules } = ctx
  const design = spec.design
  if (!design) throw new Error(`designArgs: run ${ctx.run} reached it without its design fields`)
  const sel = await ctx.selectRules({
    litterDir: ctx.litterDir,
    workflow: 'design',
    gates: [],
    tasks: [],
    planText: null,
    goal: spec.goal,
    anchors: design.anchors,
    checkout: ctx.checkout,
    runRules,
  })
  if (!sel.ok) return sel
  const args: Record<string, unknown> = {
    ...ctx.base,
    rules: [...runRules, ...sel.value.run],
    goal: spec.goal,
    deliverable: design.deliverable,
    bar: design.bar,
    anchors: design.anchors,
    lenses: design.lenses,
    empiricalUnknowns: design.empiricalUnknowns,
    maxRounds: spec.maxRounds,
    base: ctx.snapBase,
    ...(design.priorRun ? { priorRun: design.priorRun } : {}),
    ...(design.feedback ? { feedback: design.feedback } : {}),
  }
  return ok({ args, rules: sel.value.versions, barText: renderBar(design.bar) })
}
