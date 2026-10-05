// A design's run.start (COMMON step 2): its fields, checked on the input
// alone, and its args. Owner: phase 4, WP-BD. lifecycle.ts reaches both
// through its `deps`.

import type { Ports } from '../ports'
import type { LitterOptions } from '../options'
import type { RecordInput } from '../records/core'
import type { BarItem, Deliverable, DesignPrior, EmpiricalUnknown, Lens, LensRole } from '../records/run'
import type { DesignCriterion, ProposalBody } from '../records/design'
import type { LoadedRule, RuleRef, SelectInput, Selection } from '../records/rules'
import type { Parsed, Spec } from '../lifecycle'
import { fail } from '../records/core'
import { DELIVERABLES } from '../records/run'
import { PROPOSAL_VERSION, proposalPath, runDir, RUN_ID } from '../layout'
import { sha256 } from '../fsx'
import { isObject, loadRun, ok, strings, text } from '../lifecycle'
import { loadRules } from '../rules/store'
import { TEMPLATES } from '../prompts/templates'
import { renderBar, rulesIntoBar, selectedRules } from './bar'

// The other packages' modules designArgs reaches (AD's store, BF's
// templates), through one table so tier 2 can stand in for them (COMMON,
// "Another package's module").
export const deps = {
  loadRules: (...a: Parameters<typeof loadRules>) => loadRules(...a),
  template: (deliverable: Deliverable): string => TEMPLATES[deliverable],
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * A design's own fields of run.start, as parseDesign checked them; run.start
 * keeps them as `spec.design`. The fields every run has (goal, maxRounds,
 * setup, linkDirs, runRules) are the spec's own.
 */
export type DesignSpec = {
  deliverable: Deliverable
  /** Your items only: the rules' join them in designArgs (decision 4). */
  bar: BarItem[]
  lenses: Lens[]
  /** At most two, `U1` and `U2` in the order given (decision 3). */
  empiricalUnknowns: EmpiricalUnknown[]
  anchors: string[]
  priorRun: string | null
  feedback: string | null
}

/** Decision 5, the interview's words: your items, at least this many criteria and at least one categorical ban. */
export const BAR_MIN_CRITERIA = 6
/** Past this many criteria the launch warns: the interview aims for about 10. */
export const BAR_WARN = 12

const BAR_USAGE = `at least ${BAR_MIN_CRITERIA} criteria (C<n>) and at least 1 categorical ban (B<n>), each { id, text, evidence, reason (a ban's) }`

/**
 * Your bar (decision 5): each item checked first, so a refusal names the
 * field to fix, then the minimum. Only your own fields are kept: an item
 * names a rule only when run.start adds it from the rules in scope, and
 * those never count toward the minimum or the warning.
 */
function parseBar(v: unknown): Parsed<BarItem[]> & { warnings?: string[] } {
  if (!Array.isArray(v) || v.length === 0) return fail(`'bar' is required for a design: ${BAR_USAGE}`, 'bar')
  const ids = new Set<string>()
  const bar: BarItem[] = []
  for (let i = 0; i < v.length; i++) {
    const b = v[i] as BarItem
    const at = `bar[${i}]`
    if (!isObject(b) || typeof b.id !== 'string' || !/^[CB][1-9][0-9]*$/.test(b.id)) return fail(`'${at}.id' must be C<n> for a criterion or B<n> for a ban`, `${at}.id`)
    if (ids.has(b.id)) return fail(`bar id '${b.id}' appears twice; give each item its own id`, `${at}.id`)
    ids.add(b.id)
    if (typeof b.text !== 'string' || b.text.trim() === '') return fail(`'${at}.text' is required`, `${at}.text`)
    if (typeof b.evidence !== 'string' || b.evidence.trim() === '') return fail(`'${at}.evidence' is required: what evidence ${b.id} needs`, `${at}.evidence`)
    if (b.id.startsWith('B') && (typeof b.reason !== 'string' || b.reason.trim() === '')) return fail(`ban ${b.id} needs a '${at}.reason'`, `${at}.reason`)
    bar.push({ id: b.id, text: b.text, evidence: b.evidence, ...(typeof b.reason === 'string' ? { reason: b.reason } : {}) })
  }
  const criteria = bar.filter(b => b.id.startsWith('C')).length
  const bans = bar.length - criteria
  if (criteria < BAR_MIN_CRITERIA) return fail(`'bar' has ${criteria} criteri${criteria === 1 ? 'on' : 'a'}; it needs ${BAR_USAGE}`, 'bar')
  if (bans === 0) return fail(`'bar' has no ban; it needs ${BAR_USAGE}`, 'bar')
  const warnings = criteria > BAR_WARN ? [`the bar has ${criteria} criteria; group related criteria (the interview aims for about 10)`] : []
  return { ...ok(bar), ...(warnings.length > 0 ? { warnings } : {}) }
}

const UNKNOWNS_USAGE = 'a list of at most two, each { question, smallest_test, kill_result } or a question'

/**
 * The interview's empirical unknowns (decision 3): each an object, or a bare
 * string as its question with the other two fields empty. The ids are
 * `U1` and `U2` in the order given, whatever ids came with them.
 */
function parseUnknowns(v: unknown): Parsed<EmpiricalUnknown[]> {
  if (v === undefined || v === null) return ok([])
  if (!Array.isArray(v)) return fail(`'empiricalUnknowns' must be ${UNKNOWNS_USAGE}`, 'empiricalUnknowns')
  if (v.length > 2) return fail(`'empiricalUnknowns' takes at most two, and has ${v.length}; keep the two the design depends on most`, 'empiricalUnknowns')
  const out: EmpiricalUnknown[] = []
  for (let i = 0; i < v.length; i++) {
    const at = `empiricalUnknowns[${i}]`
    const u = typeof v[i] === 'string' ? { question: v[i] } : v[i]
    if (!isObject(u)) return fail(`'${at}' must be { question, smallest_test, kill_result }, or the question as a string`, at)
    if (typeof u.question !== 'string' || u.question.trim() === '') return fail(`'${at}.question' is required: what the design needs to find out`, `${at}.question`)
    const rest: Record<'smallest_test' | 'kill_result', string> = { smallest_test: '', kill_result: '' }
    for (const f of ['smallest_test', 'kill_result'] as const) {
      const x = u[f]
      if (x !== undefined && x !== null && typeof x !== 'string') return fail(`'${at}.${f}' must be a string`, `${at}.${f}`)
      rest[f] = typeof x === 'string' ? x.trim() : ''
    }
    out.push({ id: `U${i + 1}`, question: u.question.trim(), ...rest })
  }
  return ok(out)
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
  const unknowns = parseUnknowns(input.empiricalUnknowns)
  if (!unknowns.ok) return unknowns
  const anchors = strings(input.anchors, 'anchors', { optional: true })
  if (!anchors.ok) return anchors
  const prior = text(input.priorRun, 'priorRun')
  if (!prior.ok) return prior
  if (prior.value && !RUN_ID.test(prior.value)) return fail("'priorRun' must be a run id", 'priorRun')
  const feedback = text(input.feedback, 'feedback')
  if (!feedback.ok) return feedback
  const spec = ok({
    deliverable,
    bar: bar.value,
    lenses: lenses.value,
    empiricalUnknowns: unknowns.value,
    anchors: anchors.value,
    priorRun: prior.value,
    feedback: feedback.value,
  })
  return bar.warnings ? { ...spec, warnings: bar.warnings } : spec
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
 * The rules selection delivers join the bar before it's frozen (16.5;
 * decision 4), read from the store as the selection named them, so bar.md,
 * `args.bar`, `args.rules` and `run.json.rules` are one selection.
 */
export async function designArgs(p: Ports, ctx: DesignArgsCtx): Promise<Parsed<DesignLaunch>> {
  const { spec, runRules } = ctx
  const design = spec.design
  if (!design) throw new Error(`designArgs: run ${ctx.run} reached it without its design fields`)
  const prior = design.priorRun ? await priorOf(p, ctx.litterDir, design.priorRun, design.feedback) : ok(null)
  if (!prior.ok) return prior
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
  const rules = await loadSelected(p, ctx.litterDir, sel.value.versions)
  if (!rules.ok) return rules
  const bar = rulesIntoBar(design.bar, rules.value)
  const args: Record<string, unknown> = {
    ...ctx.base,
    rules: [...runRules, ...sel.value.run],
    goal: spec.goal,
    deliverable: design.deliverable,
    bar,
    anchors: design.anchors,
    lenses: design.lenses,
    empiricalUnknowns: design.empiricalUnknowns,
    maxRounds: spec.maxRounds,
    base: ctx.snapBase,
    template: deps.template(design.deliverable),
    prior: prior.value,
    ...(design.priorRun ? { priorRun: design.priorRun } : {}),
    ...(design.feedback ? { feedback: design.feedback } : {}),
  }
  return ok({ args, rules: sel.value.versions, barText: renderBar(bar) })
}

/**
 * The selected rules' files, in selection order (decision 4); none to read
 * when nothing was selected. A rule edited since the selection read the
 * store refuses, since the bar would hold another version than args.rules;
 * one retired or deleted since can't join the bar, and is logged.
 */
async function loadSelected(p: Ports, litterDir: string, versions: readonly RuleRef[]): Promise<Parsed<LoadedRule[]>> {
  if (versions.length === 0) return ok([])
  let loaded: LoadedRule[]
  try {
    loaded = (await deps.loadRules(p, litterDir)).rules
  } catch (err) {
    return fail(`litter: the accepted rules couldn't be read into the bar (${errText(err)}); /litter-rules shows them and their problems. Launch again once it's fixed`)
  }
  const picked = selectedRules(loaded, versions)
  if ('changed' in picked) {
    return fail(`litter: rule ${picked.changed.id} changed while run.start read the rules (it was at version ${picked.changed.version}), so the bar can't hold it; launch again`)
  }
  if (picked.gone.length > 0) p.log(`design bar: ${picked.gone.map(v => `${v.id}@${v.version}`).join(', ')} selected but no longer in force, so not in the bar`)
  return ok(picked.rules)
}

// ---------------------------------------------------------------------------
// A follow-up run's prior (decision 12)

/** A prior proposal past this many UTF-8 bytes is cut, with a note naming its file. */
export const PRIOR_CAP = 64 * 1024

const bytes = (s: string): number => new TextEncoder().encode(s).length

/** The longest head of `s` within `n` UTF-8 bytes, cut between characters. */
function headBytes(s: string, n: number): string {
  const b = new TextEncoder().encode(s)
  if (b.length <= n) return s
  let end = Math.max(0, n)
  while (end > 0 && (b[end]! & 0xc0) === 0x80) end--
  return new TextDecoder().decode(b.subarray(0, end))
}

const cutNote = (n: number, path: string): string => `\n[cut: ${n} more bytes in ${path}]`

/** `text` within PRIOR_CAP, the note included: the cut says how much more there is, and where. */
function capped(text: string, path: string): string {
  const total = bytes(text)
  if (total <= PRIOR_CAP) return text
  // The note with the whole length is at least as long as the one written, so the result fits.
  const kept = headBytes(text, PRIOR_CAP - bytes(cutNote(total, path)))
  return kept + cutNote(total - bytes(kept), path)
}

/**
 * The prior run's latest proposal, as `proposals/<version>.md` holds it. A
 * file that's gone or no longer the bytes the record names isn't the
 * proposal: the ledger decides, so its record's prose stands in, saying so.
 */
async function priorText(p: Ports, dir: string, version: string, body: Partial<ProposalBody>): Promise<string> {
  const path = proposalPath(dir, version)
  const file = await p.fs.read(path).catch(() => null)
  if (file !== null && (typeof body.sha256 !== 'string' || (await sha256(file)) === body.sha256)) return capped(file, path)
  const prose = typeof body.text === 'string' ? body.text : ''
  return capped(`[litter: ${path} is missing or changed since ${version} was recorded; this is the prose its proposal record holds, without the gates]\n\n${prose}`, path)
}

/**
 * `args.prior` for a run that follows `priorRun` (decision 12): its latest
 * proposal's version and text, its latest verdict on that version, and the
 * feedback, its `design.feedback` records' then this run's. The prior must be
 * a design run in this litter directory; a tampered ledger gives the records
 * before the tamper point.
 */
async function priorOf(p: Ports, litterDir: string, priorRun: string, feedback: string | null): Promise<Parsed<DesignPrior>> {
  let loaded: Awaited<ReturnType<typeof loadRun>>
  try {
    loaded = await loadRun(p, litterDir, priorRun)
  } catch (err) {
    return fail(`litter: 'priorRun' ${priorRun} couldn't be read (${errText(err)}); pass the id of the design run this one follows`, 'priorRun')
  }
  if (!loaded.json) return fail(`litter: 'priorRun' ${priorRun} isn't a run in this litter directory (${litterDir}); pass the id of the design run this one follows`, 'priorRun')
  if (loaded.json.workflow !== 'design') {
    return fail(`litter: 'priorRun' ${priorRun} is a run of the ${loaded.json.workflow} workflow; a follow-up starts from a design run`, 'priorRun')
  }
  if (loaded.tampered) p.log(`design prior ${priorRun}: its ledger is tampered at seq ${loaded.tampered.seq} (${loaded.tampered.reason}); the prior is read from the records before it`)
  const { records } = loaded
  const body = records.filter(r => r.kind === 'proposal').at(-1)?.body as Partial<ProposalBody> | undefined
  const version = typeof body?.version === 'string' && PROPOSAL_VERSION.test(body.version) ? body.version : null
  const proposal = version ? await priorText(p, runDir(litterDir, priorRun), version, body!) : null
  const judged = version ? records.filter(r => r.kind === 'verdict' && r.body.version === version).at(-1)?.body : undefined
  const verdict = judged
    ? { criteria: Array.isArray(judged.criteria) ? (judged.criteria as DesignCriterion[]) : [], overall: typeof judged.overall === 'string' ? judged.overall : '' }
    : null
  const said = records.flatMap(r => (r.kind === 'design.feedback' && typeof r.body.feedback === 'string' ? [r.body.feedback] : []))
  return ok({ run: priorRun, version, proposal, verdict, feedback: [...said, ...(feedback ? [feedback] : [])] })
}
