export const meta = {
  name: 'design-run',
  description: 'Design rounds against a written bar: investigate, check nulls, probe, reframe, author, and judge each version; approval only over the whole bar',
  whenToUse: 'Only through /litter:design, which records run.start and passes its args; never called directly',
  phases: [{ title: 'Investigate' }, { title: 'Null check' }, { title: 'Probe' }, { title: 'Reframe' }, { title: 'Author' }, { title: 'Judge' }],
}

// litter's design (plan section 7, design.js and 7a; docs/litter-design
// COMMON.md, step 3), the rounds as the sketch has them: investigate, null
// check, probe, reframe, author, judge, route. The mod records every step: it
// assigns each version, renders a plan's gates into it, and fills the author's
// proposal and the critic's verdict from the ledger (decision 7), so the critic
// judges, and this script reads, exactly what the ledger holds. The script
// computes approval itself, over the whole bar, and returns one shape per stop
// (DesignReturn, hooks/records/run.ts), which the decoder maps to a run.end.
// The args are run.start's (DesignArgs, the same file).

const S = { type: 'string' }, B = { type: 'boolean' }
const say = (s, description) => ({ ...s, description })    // the judgment a field carries (prompts doc, "Design schemas")
const list = items => ({ type: 'array', items })
const strs = list(S)
const obj = (properties, optional = []) => ({ type: 'object', properties, required: Object.keys(properties).filter(k => !optional.includes(k)) })
const NEW = say(B, 'True only if this is not already in the material given, or it overturns something there')

const FALSIFIER = obj({
  results: say(list(obj({
    kind: say({ enum: ['problem', 'fact', 'null'] }, 'problem: something in the current system that blocks or endangers the goal. fact: something true that the design has to account for. null: something the goal assumes or needs that you could not find'),
    claim: say(S, 'One checkable sentence that names the code: where a value enters, where it takes effect, and what is or is not there'),
    evidence: say(strs, 'Each a path:line or path:start-end you read in this call, or a command you ran in this call with its output'),
    confidence: say({ enum: ['high', 'medium', 'low'] }, 'high: two or more independent sources agree. medium: one direct source. low: inference, with what is missing named in the claim'),
    checked: say(list(obj({ location: S, looked_for: S, result: S })), 'For a null, the inventory: each place you checked, what you looked for there, and what you found. Empty for a problem or a fact'),
    new_since_prior: NEW,
  })), 'A few certain results are worth more than many speculative ones'),
  null_check_of: say(S, 'In a null check only: the claim of the null you were asked to break, as the material gives it'),
}, ['null_check_of'])

const COVERAGE = obj({
  rows: say(list(obj({
    environment: S,
    share: say(S, 'Roughly what share of users this environment has, only if you can tell'),
    share_source: say(S, 'How you know the share'),
    status: say({ enum: ['works', 'degrades', 'fails', 'unknown'] }, 'How the current system behaves here, and the proposal when one is given. unknown is an honest answer; a confident guess is not'),
    evidence: say(S, 'The code or test that decides the status, as path:line'),
    fallback: say(S, 'For degrades or fails: what the user sees, and whether anything is lost or corrupted. A silent failure is the worst case'),
  }, ['share', 'share_source'])), 'One row per environment that matters, along the axis the task names; a matrix that says works everywhere is one nobody believes'),
  weighted_works: say(S, 'The weighted share that works, if you can compute it, and how'),
  silent_failures: say(strs, 'Every case that fails without telling the user'),
  needs_live_test: say(strs, 'The rows only a live test could settle'),
  new_since_prior: NEW,
}, ['weighted_works'])

const MECHANISM = obj({
  candidate: say(S, 'In candidate mode, the candidate you developed, as the task names it'),
  files: say(list(obj({ path: S, new: B })), 'Every file the design touches: existing files by path, new files with new set to true'),
  design: say(S, 'The smallest mechanism that meets the bar: data structures, interfaces, control flow and integration points, concrete enough to implement from'),
  bar_coverage: say(list(obj({ criterion: S, how: S })), 'How the design meets each bar criterion it bears on, by id'),
  failure_modes: say(list(obj({ trigger: S, consequence: S, handling: S, evidence: say(S, 'path:line, where the claim is about existing code') }, ['evidence'])),
    'Only the cases that apply, each with its trigger, its consequence and how the design handles it'),
  empirical_unknowns: say(list(obj({
    id: S,
    question: S,
    smallest_test: say(S, 'The smallest live test that would settle it'),
    kill_result: say(S, 'The result that would kill the design'),
    load_bearing: say(B, 'True only if the design depends on the answer; only load-bearing unknowns are probed'),
  })), 'Behaviours the design depends on that reading code and docs cannot settle, so only a live test can'),
  bans_checked: say(strs, 'Each categorical ban by id, and how the design stays clear of it'),
  new_since_prior: NEW,
}, ['candidate'])

// Per call: the unknown the prober was given is the only id its result may name (decision 18).
const PROBER = id => obj({
  unknown_id: say({ enum: [id] }, 'The unknown this probe settles, as the task names it'),
  commands: say(strs, 'The exact commands you ran'),
  output_excerpt: say(S, 'The relevant output, trimmed but not paraphrased'),
  verdict: say({ enum: ['confirmed', 'refuted', 'untested'] }, 'untested when no real test could run here; never confirmed without a test that ran'),
  meaning: say(S, 'What the result means for the design'),
})

const REFRAMER = obj({
  goal_as_stated: say(S, 'The goal quoted as the user wrote it'),
  inferred_intent: say(S, 'The underlying intent you infer, kept separate from the goal as stated'),
  candidates: say(list(obj({
    id: say(S, 'R1, R2 and so on'),
    shape: say(S, 'Use existing machinery, the requirement is wrong, it already works, flip a default, delete instead of add, or another shape you name'),
    alternative: S,
    evidence: say(strs, 'The feasibility evidence, as path:line or a command with its output'),
    problems: S,
    cheapest_check: say(S, 'The cheapest check that would confirm or kill it'),
  })), 'At least one alternative that meets the intent with less code or fewer moving parts; an unsupported reframe is worse than none'),
  recommendation: say(S, 'A candidate id, or none to proceed as stated'),
  changes_goal: say(B, 'True only if the recommendation replaces what the user asked for, not if it meets it by other means. True stops the run and asks the user'),
  material_change: say(B, 'True only if this pass changes where the design stands since the earlier reframes: a new candidate worth weighing, an earlier one whose standing changed, or a wrong assumption not reported before'),
  invalid_assumptions: say(list(obj({ assumption: S, evidence: S })), 'Assumptions in the goal or the proposal that turned out wrong or worth questioning, each with its evidence'),
  irreducible_because: say(S, 'When no reframe helps: what makes the goal irreducible'),
}, ['irreducible_because'])

const AUTHOR = obj({
  version: say(S, 'The version the plugin assigned when you recorded the proposal, from the record result'),
  proposal: say(S, 'Observed: leave it empty. The plugin fills it with the text it recorded for your version, gates included. If the plugin rejects your result and asks for the text, copy the recorded proposal here exactly'),
  delta: say(list(obj({ change: S, why: say(S, 'The criterion or report that drove it'), kept: say(S, 'What was deliberately kept, where useful') }, ['kept'])),
    'From the second version on, one entry per change from the previous version; the critic reads it as a pointer, so it must be accurate. Empty for a first version'),
  bar_map: say(list(obj({ criterion: S, section: say(S, 'The section or gate that meets it'), evidence: strs })), 'For each bar id, criteria and bans, where the proposal meets it and its evidence'),
  overruled: say(list(obj({ source: S, what: S, why: S })), 'Each report you overruled or discounted, with a reason that stands on evidence'),
  residual_unknowns: say(list(obj({ id: S, description: S, why_open: S, how_to_resolve: S, default_off: say(B, 'True when what depends on it ships default-off') })),
    'The unknowns still open, each bounded: why it is open and how to resolve it'),
  user_decisions: say(list(obj({
    question: S,
    options: list(obj({ label: S, tradeoff: S })),
    recommended: S,
    blocking: say(B, 'True only if the design cannot go on without the answer. True stops the run and asks the user'),
  })), 'Choices only the user can settle; the proposal is written on the option you recommend'),
})

const LENS_ROLES = ['falsifier', 'coverage', 'mechanism']
const INVESTIGATORS = { falsifier: FALSIFIER, coverage: COVERAGE, mechanism: MECHANISM }
const DELIVERABLES = ['plan', 'research', 'audit', 'review']
const GAP_KINDS = ['investigation', 'design', 'wording', 'user']
const BAR_ID = /^[CB][0-9]+$/                                // run.start's (design/launch.ts, parseBar)
const VERSION = /^v[1-9][0-9]*$/                             // layout.ts's PROPOSAL_VERSION
const UNKNOWN = /^U[1-9][0-9]*$/                             // layout.ts's UNKNOWN_ID
const BUDGET_FLOOR = 50_000
const CAP = 48 * 1024                                        // decision 8: the material per call, in bytes
const isObj = v => typeof v === 'object' && v !== null && !Array.isArray(v)
const arr = v => (Array.isArray(v) ? v : [])

// The args, checked before any call: without them no call could carry the envelope.
const bar = Array.isArray(args?.bar) ? args.bar : []
const bad = typeof args?.nonce !== 'string' || args.nonce === '' ? 'no nonce in args'
  : typeof args.goal !== 'string' || args.goal.trim() === '' ? 'no goal in args'
  : bar.length === 0 ? 'no bar in args'
  : bar.some(b => !BAR_ID.test(String(b?.id))) || new Set(bar.map(b => b.id)).size !== bar.length ? 'the bar in args has an item with no usable id'
  : !DELIVERABLES.includes(args.deliverable) ? 'no deliverable in args'
  : !Array.isArray(args.lenses) || args.lenses.length === 0 || args.lenses.some(l => !LENS_ROLES.includes(l?.role)) ? 'no usable lenses in args'
  : !Number.isInteger(args.maxRounds) || args.maxRounds < 1 ? 'no maxRounds in args'
  : null
if (bad) return { stopped: 'halted', reason: `${bad}; launch through /litter:design` }

const ids = bar.map(b => b.id)
// Built per run (plan 7, step 8): an enum of the frozen bar's ids, and exactly the bar's length.
const CRITIC = obj({
  version: say(S, 'The version you judged, as its proposal tag names it'),
  source_changed: say(B, 'Observed: set it to false. The plugin sets it from its own snapshot of the checkout when you record the verdict'),
  criteria: say({ type: 'array', minItems: ids.length, maxItems: ids.length, items: obj({
    id: say({ enum: ids }, 'The bar id this verdict is for'),
    verdict: say({ enum: ['PASS', 'CONDITIONAL', 'FAIL'] }, 'PASS: the evidence clears it. CONDITIONAL: met except for one specific, named gap that can close without redesign. FAIL: not met. Borderline is not PASS'),
    gap_or_reason: say(S, 'For CONDITIONAL the gap, for FAIL the specific reason'),
    evidence: say(S, 'The file:line, empirical result or report section the verdict rests on'),
    kept_from: say(S, 'The earlier version an unchanged verdict is kept from, once its evidence is confirmed to still hold'),
    reversed: say(B, 'True when new evidence reverses an earlier verdict'),
    gap_kind: say({ enum: GAP_KINDS }, 'Required when the verdict is not PASS: what would close it. investigation: more investigation. design: a design change. wording: a fix to the proposal\'s wording or evidence. user: a decision only the user can make, a trade-off of taste with no evidence to settle it'),
  }, ['gap_or_reason', 'kept_from', 'reversed', 'gap_kind']) }, 'Exactly one verdict for every bar id, criteria and bans'),
  overall: say({ enum: ['APPROVED', 'HOLDING'] }, 'APPROVED only when every criterion is PASS'),
})

// Two lenses of one role with no names would share one; each name is unique in labels and material.
const used = new Set()
const lenses = args.lenses.map(l => {
  const base = String(l.name ?? '').replace(/\s+/g, ' ').trim() || l.role
  let name = base
  for (let n = 2; used.has(name); n++) name = `${base}-${n}`
  used.add(name)
  return { role: l.role, name, focus: String(l.focus ?? ''), anchors: Array.isArray(l.anchors) ? l.anchors.map(String) : [] }
})

// The interview's unknowns (decision 3): U1 and U2 as given, a bare string as the question.
const unknowns = []                                          // { id, question, smallest_test, kill_result, result }
for (const u of Array.isArray(args.empiricalUnknowns) ? args.empiricalUnknowns : []) {
  const o = typeof u === 'string' ? { question: u } : isObj(u) ? u : {}
  if (String(o.question ?? '').trim() === '') continue
  unknowns.push({ id: UNKNOWN.test(String(o.id)) && !unknowns.some(x => x.id === o.id) ? o.id : null,
    question: String(o.question), smallest_test: String(o.smallest_test ?? ''), kill_result: String(o.kill_result ?? ''), result: null })
}
let nextU = 1 + Math.max(0, ...unknowns.filter(u => u.id).map(u => Number(u.id.slice(1))))
const takeId = () => `U${nextU++}`
for (const u of unknowns) u.id ??= takeId()

const prior = isObj(args.prior) && typeof args.prior.run === 'string' ? args.prior : null
const feedback = (prior && Array.isArray(prior.feedback) ? prior.feedback : typeof args.feedback === 'string' ? [args.feedback] : [])
  .map(String).filter(f => f.trim() !== '')

// ---------------------------------------------------------------------------
// The envelope (section 7a): <goal>, <bar>, <rules>, <anchors>, then the call's
// <material>, then its own tags, and last its <task>, each tag carrying the nonce.

const tag = (name, body, attrs = '') =>
  body == null || body === '' ? '' : `<${name} id="${args.nonce}"${attrs}>\n${body}\n</${name} id="${args.nonce}">\n`
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const cut = (s, n = 300) => { const t = oneLine(s); return t.length > n ? `${t.slice(0, n)}…` : t }
const attr = s => cut(s, 120).replace(/["<>]/g, "'")       // a value from args or a model, inside an attribute
const lines = xs => (Array.isArray(xs) && xs.length ? xs.map(String).join('\n') : 'none')
const refs = rs => rs.map(r => `${r?.id}@${r?.version}`).join(', ')
const barText = bar.map(b => [
  `${b.id}${b.id.startsWith('B') ? ' (ban)' : ''}: ${b.text}`,
  `  Evidence: ${b.evidence}`,
  ...(b.reason ? [`  Reason: ${b.reason}`] : []),
  ...(b.rule ? [`  From rule ${refs([b.rule])}`] : Array.isArray(b.rules) && b.rules.length ? [`  From rules ${refs(b.rules)}`] : []),
].join('\n')).join('\n')
const head = tag('goal', args.goal) + tag('bar', barText) + tag('rules', lines(args.rules)) + tag('anchors', lines(args.anchors))
const envelope = (material, own, task) => head + material + own + tag('task', task)

// ---------------------------------------------------------------------------
// <material> (decision 8): one block per upstream report, from="<role>/<name>",
// with the report's round for every role but the critic (decision 19). Past
// 48 KiB the rounds before the last two go to one line per claim; if that's
// not enough, they're left out, oldest first, then the last two rounds go to
// one line per claim too, then the previous round is left out, and last what
// remains is cut to fit. A last block names every cut, so no call reads one as
// covered. Plain arithmetic, so a replay cuts the same.

function utf8(s, max) {                                      // the leading characters of s that fit in max bytes
  let b = 0, i = 0
  while (i < s.length) {
    const c = s.charCodeAt(i), pair = c >= 0xd800 && c < 0xdc00
    const w = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3
    if (b + w > max) break
    b += w
    i += pair ? 2 : 1
  }
  return { i, b }
}
const bytes = s => utf8(s, Infinity).b

// A null stays in full until its cross-check is done (decision 8).
const openNull = x => x.kind === 'null' && x.null_check === undefined
function claimsOf(r) {
  const b = r.body
  const ev = xs => cut((xs ?? []).join(', '), 160)
  const ls = r.role === 'falsifier' ? b.results.map(x => openNull(x) ? JSON.stringify(x)
      : `${x.kind}${x.null_check ? `, ${x.null_check}` : ''}${x.overturns_null ? ', overturns a null' : ''} (${x.confidence}): ${cut(x.claim)} [${ev(x.evidence)}]`)
    : r.role === 'coverage' ? [...b.rows.map(x => `${cut(x.environment, 80)}: ${x.status}: ${cut(x.evidence, 160)}`),
      ...b.silent_failures.map(x => `silent failure: ${cut(x)}`)]
    : r.role === 'mechanism' ? [`design: ${cut(b.design)}`, ...b.failure_modes.map(x => `failure mode: ${cut(x.trigger, 140)}: ${cut(x.handling, 140)}`),
      ...b.empirical_unknowns.map(x => `unknown${x.load_bearing ? ', load-bearing' : ''}: ${cut(x.question)}`)]
    : r.role === 'prober' ? [`${b.unknown.id} ${b.result.verdict}: ${cut(b.unknown.question, 140)}: ${cut(b.result.meaning, 140)}`]
    : r.role === 'reframer' ? [...b.candidates.map(x => `${cut(x.id, 20)} (${cut(x.shape, 60)}): ${cut(x.alternative)}`), `recommendation: ${cut(b.recommendation, 80)}`,
      ...b.invalid_assumptions.map(x => `wrong assumption: ${cut(x.assumption)}`)]
    : r.role === 'author' ? [...b.bar_map.map(x => `${cut(x.criterion, 20)}: ${cut(x.section, 160)}`),
      ...b.overruled.map(x => `overruled ${cut(x.source, 80)}: ${cut(x.why, 200)}`),
      ...b.residual_unknowns.map(x => `residual ${cut(x.id, 20)}${x.default_off ? ', default-off' : ''}: ${cut(x.description, 200)}`)]
    : [`${b.version ?? 'no version'} of run ${b.run}: ${isObj(b.verdict) ? b.verdict.overall : 'no verdict'}`,      // a follow-up's prior, without its text
      ...arr(b.verdict?.criteria).filter(c => c?.verdict !== 'PASS').map(c => `${c?.id} ${c?.verdict}${c?.gap_kind ? `, ${c.gap_kind}` : ''}: ${cut(c?.gap_or_reason || c?.evidence)}`),
      ...arr(b.feedback).map(f => `feedback: ${cut(f)}`)]
  return ls.map(l => `- ${l}`).join('\n') || '- no claims'
}

function material(rs, showRound) {
  if (rs.length === 0) return ''
  const newest = Math.max(...rs.map(r => r.round))
  const blocks = rs.map(r => {
    const b = { r, full: JSON.stringify(r.body), lines: claimsOf(r),
      open: r.role === 'falsifier' && r.body.results.some(openNull),
      attrs: ` from="${attr(r.from)}"${showRound && r.round > 0 ? ` round="${r.round}"` : ''}` }
    return { ...b, fullSize: bytes(tag('material', b.full, b.attrs)), linesSize: bytes(tag('material', b.lines, b.attrs)) }
  })
  const forms = blocks.map(() => 'full')                     // 'full', 'lines', 'out', or { cut: bytes, of: 'full' | 'lines' }
  const text = (b, f) => f === 'out' ? '' : typeof f === 'object' ? b[f.of].slice(0, utf8(b[f.of], f.cut).i) : b[f]
  const size = (b, f) => f === 'full' ? b.fullSize : f === 'lines' ? b.linesSize : f === 'out' ? 0 : bytes(tag('material', text(b, f), b.attrs))
  const said = f => f === 'lines' ? 'one line per claim' : f === 'out' ? 'left out'
    : `${f.of === 'lines' ? 'one line per claim, then ' : ''}cut to its first ${f.cut} bytes`
  const named = b => (showRound && b.r.round > 0 ? `${b.r.from}, round ${b.r.round}` : b.r.from)
  const omitted = () => {
    const xs = blocks.flatMap((b, i) => (forms[i] === 'full' ? [] : [`- ${named(b)}: ${said(forms[i])}`]))
    return xs.length ? tag('material', `Cut to fit this call's 48 KiB of material, so don't read any of these as covered:\n${xs.join('\n')}`, ' from="litter" kind="omitted"') : ''
  }
  const render = () => blocks.map((b, i) => tag('material', text(b, forms[i]), b.attrs)).join('') + omitted()
  const fits = () => blocks.reduce((n, b, i) => n + size(b, forms[i]), 0) + bytes(omitted()) <= CAP
  if (!fits()) {
    const old = b => b.r.round < newest - 1
    // The last two rounds stay in full as long as leaving out earlier rounds' blocks can make room.
    blocks.forEach((b, i) => { if (old(b)) forms[i] = 'lines' })
    for (let i = 0; i < blocks.length && !fits(); i++) if (old(blocks[i]) && !blocks[i].open) forms[i] = 'out'
    for (let i = 0; i < blocks.length && !fits(); i++) if (forms[i] === 'full') forms[i] = 'lines'
    // Then the previous round's blocks go whole; this round's, and an open null, are only ever cut.
    for (let i = 0; i < blocks.length && !fits(); i++) if (!blocks[i].open && blocks[i].r.round < newest) forms[i] = 'out'
    if (!fits()) {
      // The largest share of bytes each remaining block may keep, found by bisection; a smaller block stays whole.
      const left = blocks.flatMap((_, i) => (forms[i] === 'out' ? [] : [i]))
      const of = left.map(i => forms[i])
      const keep = share => left.forEach((i, k) => { forms[i] = size(blocks[i], of[k]) > share ? { cut: share, of: of[k] } : of[k] })
      let lo = 0, hi = CAP
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        keep(mid)
        if (fits()) lo = mid
        else hi = mid - 1
      }
      keep(lo)
    }
  }
  return render()
}

// ---------------------------------------------------------------------------
// Calls (as execute.js's call()): one retry on null, a role that ended without
// its StructuredOutput included; a missing role interrupts, a refused worktree
// halts, and the engine's budget ends the run holding.

let interrupted = null                                       // a role missing when the run (re)started (section 9)
let refused = null                                           // worktree.sh refused a prober's worktree (section 9, "Run worktrees")
let outOfBudget = false                                      // the budget floor, or the engine's own token ceiling (decision 2)
const stopped = () => interrupted !== null || refused !== null || outOfBudget
const tooLow = () => (outOfBudget ||= Boolean(budget.total) && budget.remaining() < BUDGET_FLOOR)

async function attempt(prompt, opts) {
  try {
    return await agent(prompt, opts)
  } catch (e) {                                              // agent() rejects, it doesn't return null, for these
    const msg = String(e?.message)
    if (/^\s*WorktreeCreate hook failed/.test(msg)) { refused ??= msg; return null }  // the same name would be refused again
    if (/agent type 'litter:[^']*' not found/.test(msg)) { interrupted ??= msg; return null }  // only a resume can help
    if (e?.name === 'WorkflowBudgetExceededError' || /^Workflow token budget exceeded/.test(msg)) { outOfBudget = true; return null }
    if (/subagent completed without calling StructuredOutput/.test(msg)) return null  // a null, retried once (WP-BG)
    throw e                                                  // a denied type, a bad schema: fatal
  }
}
async function call(prompt, opts) {
  for (let i = 0; i < 2; i++) {
    if (tooLow()) return null
    const r = await attempt(prompt, i === 0 ? opts : { ...opts, label: `${opts.label} (retry)` })
    if (r !== null || stopped()) return r
  }
  return null
}
// parallel() turns a thrown thunk into null, so a fatal rejection is kept and rethrown after it. Each null
// is retried once, after every first call and in the same order, so a replay starts every call in the same
// order and asks the engine for the same prober worktree names (section 9, "A replay").
async function batch(jobs) {
  let fatal = null
  const go = (js, retry) => parallel(js.map(j => async () => {
    try {
      return await attempt(j.prompt, retry ? { ...j.opts, label: `${j.opts.label} (retry)` } : j.opts)
    } catch (e) {
      fatal ??= e
      return null
    }
  }))
  const out = tooLow() ? jobs.map(() => null) : await go(jobs, false)
  if (fatal) throw fatal
  const missing = jobs.flatMap((_, i) => (out[i] == null ? [i] : []))
  if (missing.length > 0 && !stopped() && !tooLow()) {
    const again = await go(missing.map(i => jobs[i]), true)
    if (fatal) throw fatal
    missing.forEach((i, k) => { out[i] = again[k] })
  }
  return out.map(r => r ?? null)
}

let version = null                                           // the latest version the author recorded
const holding = by => ({ stopped: null, outcome: 'holding', by, version })
// A call that gave nothing: the missing role, the refusal or the budget when one is why; else halted (decision 1).
const end = reason => interrupted !== null ? { stopped: 'interrupted', reason: interrupted }
  : refused !== null ? { stopped: 'halted', reason: refused }
  : outOfBudget ? holding('budget')
  : { stopped: 'halted', reason }

// ---------------------------------------------------------------------------
// The tasks.

const deliverable = args.deliverable
const hasMechanism = lenses.some(l => l.role === 'mechanism')
const hasFacts = lenses.some(l => l.role !== 'mechanism')
// Plan 7's table: investigation to the falsifier and coverage lenses, design to mechanism (to every lens when there's none).
const routed = (l, open) => open.filter(c => (c.gap_kind === 'investigation' ? l.role !== 'mechanism' || !hasFacts
  : c.gap_kind === 'design' ? l.role === 'mechanism' || !hasMechanism : false))

const investigateTask = (l, open, given) => [
  `${l.role === 'falsifier' ? 'Investigate. ' : ''}You are the ${l.name} lens.`,
  `Focus: ${l.focus.trim() || 'the goal as a whole, against the bar'}`,
  ...(l.anchors.length ? [`Start from: ${l.anchors.join(', ')}`] : []),
  ...(routed(l, open).length ? [`The critic left these criteria of ${version} open for you; settle what each one needs, by id:`,
    ...routed(l, open).map(c => `- ${c.id} (${c.verdict}): ${cut(c.gap_or_reason || c.evidence, 600)}`)] : []),
  ...(given ? ['Earlier reports are in the material: set new_since_prior as its description says.'] : []),
].join('\n')

const nullTask = from => `Null check. The material from ${from} is a null another falsifier reported, with its inventory. ` +
  "Break it: search for what it says is absent, starting where its inventory didn't look, then re-check the entries that carry the most weight. " +
  "Set null_check_of to the null's claim."

const probeTask = u => [
  `Settle unknown ${u.id} with a live test in your own worktree.`,
  `Question: ${u.question}`,
  `Smallest test: ${u.smallest_test.trim() || 'not given; choose the smallest test that exercises the real behaviour'}`,
  `Kill result: ${u.kill_result.trim() || 'not given; state the result that would refute it before you run anything'}`,
  `Record a probe with unknown_id ${u.id}, the question above and your verdict, then return your result with unknown_id ${u.id}.`,
].join('\n')

const reframeTask = later => later
  ? `Later pass: challenge how heavy proposal ${version} is against the goal, with the findings and the earlier reframes in the material. ` +
    "Don't repeat an earlier reframe unless new evidence changes its standing."
  : 'First pass: challenge the goal itself, with the findings in the material.'

const authorTask = (round, followUp) => [
  round > 1 ? `Write the next version of the ${deliverable}, from ${version} and its verdict: each criterion that isn't PASS needs a change in this version ` +
      `or a plain statement of why its gap stays open. List the delta from ${version}.`
    : followUp ? `Write this run's first version of the ${deliverable}, from the prior run's proposal and verdict and the user's feedback on it.`
    : `Write the first version of the ${deliverable}.`,
  `Record it as one proposal${deliverable === 'plan' ? ", with its gates in the record's gates field" : ''}, then return your result with the version the record gave you.`,
].join(' ')

const criticTask = (v, problems) => [
  `Judge proposal ${v} against the bar, criterion by criterion, and record one verdict on ${v} with exactly one entry for every bar id, criteria and bans alike.`,
  ...(problems ? [`A verdict on ${v} couldn't be used: ${problems.join('; ')}. Judge ${v} again, and give overall APPROVED only when every criterion is PASS.`] : []),
].join(' ')

// The critic's verdict as the script reads it (plan 7, step 8): what makes it unusable, and the criteria it settles.
function problemsOf(v, ver) {
  const seen = v.criteria.map(c => c.id)
  const missing = ids.filter(id => !seen.includes(id))
  const repeated = [...new Set(seen.filter((id, i) => seen.indexOf(id) !== i))]
  return [
    ...(v.version !== ver ? [`it names ${attr(v.version)}, not ${ver}`] : []),
    ...(missing.length ? [`it has no verdict for ${missing.join(', ')}`] : []),
    ...(repeated.length ? [`it gives ${repeated.join(', ')} more than once`] : []),
    ...((v.overall === 'APPROVED') !== v.criteria.every(c => c.verdict === 'PASS') ? [`its overall, ${v.overall}, disagrees with its criteria`] : []),
  ]
}
// One per bar id, in bar order: a missing id is a FAIL for investigation; a repeated one its worst.
const settled = (v, ver) => ids.map(id => {
  const xs = v.version === ver ? v.criteria.filter(c => c.id === id) : []
  const c = xs.find(x => x.verdict !== 'PASS') ?? xs[0]
  if (!c) return { id, verdict: 'FAIL', gap_or_reason: `the critic gave ${id} no verdict on ${ver}`, evidence: 'none', gap_kind: 'investigation' }
  return c.verdict === 'PASS' || GAP_KINDS.includes(c.gap_kind) ? c : { ...c, gap_kind: 'investigation' }
})

const isNew = r => (r.role === 'falsifier' ? r.body.results.some(x => x.new_since_prior === true) : r.body.new_since_prior === true)
const fold = s => oneLine(s).toLowerCase()
const known = q => unknowns.some(u => fold(u.question) === fold(q)) || queue.some(u => fold(u.question) === fold(q))

// ---------------------------------------------------------------------------
// The rounds.

const reports = []                                           // { round, role, name, from, kind, body }, in the order made
const queue = []                                             // mechanisms' load-bearing unknowns waiting for a probe (decision 10)
let proposal = null                                          // the latest version's text, as the mod recorded it
let verdict = null                                           // the latest verdict the run acted on: { version, criteria, overall }
const priorReport = prior ? { round: 0, role: 'prior', name: prior.run, from: `prior/${prior.run}`, kind: 'prior', body: prior } : null
const versionAttr = v => ` version="${v}"`

for (let round = 1; round <= args.maxRounds; round++) {
  if (tooLow()) return holding('budget')
  const open = verdict ? verdict.criteria.filter(c => c.verdict !== 'PASS') : []
  // Plan 7, step 9: wording goes to the author only, so the investigators skip the round (and it never counts as no new material, decision 9).
  const wordingOnly = open.length > 0 && open.every(c => c.gap_kind === 'wording')
  log(`round ${round} of ${args.maxRounds}${wordingOnly ? ': wording only, no investigators' : ''}`)

  // 1. Investigate: one call per lens, the earlier reports as material.
  const found = []
  if (!wordingOnly) {
    phase('Investigate')
    const given = [...(round === 1 && priorReport ? [priorReport] : []), ...reports]
    const mat = material(given, true)
    const jobs = lenses.map(l => ({ l, prompt: envelope(mat, '', investigateTask(l, open, given.length > 0)),
      opts: { label: `r${round}:${l.role}:${l.name}`, phase: 'Investigate', agentType: `litter:${l.role}`, schema: INVESTIGATORS[l.role] } }))
    const out = await batch(jobs)
    if (stopped()) return end('')
    const lost = jobs.filter((_, i) => out[i] === null)
    if (lost.length) return end(`${lost.map(j => `the ${j.l.role} ${j.l.name}`).join(', ')} returned nothing twice in round ${round} (Investigate)`)
    jobs.forEach((j, i) => found.push({ round, role: j.l.role, name: j.l.name, from: `${j.l.role}/${j.l.name}`, kind: 'investigate', body: out[i] }))
    reports.push(...found)
  }
  const fresh = found.some(isNew)

  // 2. Null check: a fresh falsifier tries to break each new null; it stands only if that search comes back empty too.
  // A null reported as already in the material was checked when it was new, so it isn't held in full again.
  const toCheck = x => x.kind === 'null' && (round === 1 || x.new_since_prior === true)
  for (const r of found) {
    if (r.role === 'falsifier') r.body = { ...r.body, results: r.body.results.map(x => x.kind === 'null' && !toCheck(x) ? { ...x, null_check: 'not checked again: reported as already in the earlier material' } : x) }
  }
  const nulls = found.filter(r => r.role === 'falsifier').flatMap(r => r.body.results.flatMap((x, i) => (toCheck(x) ? [{ r, i }] : [])))
  if (nulls.length) {
    phase('Null check')
    const jobs = nulls.map((n, k) => ({ n,
      prompt: envelope(material([{ ...n.r, body: { results: [n.r.body.results[n.i]] } }], true), '', nullTask(n.r.from)),
      opts: { label: `r${round}:null:${k + 1}`, phase: 'Null check', agentType: 'litter:falsifier', schema: FALSIFIER } }))
    const out = await batch(jobs)
    if (stopped()) return end('')
    const lost = jobs.find((_, i) => out[i] === null)
    if (lost) return end(`the falsifier checking a null from ${lost.n.r.from} returned nothing twice in round ${round} (Null check)`)
    const swaps = new Map()                                  // report → its result index → what stands in its place
    jobs.forEach((j, k) => {
      const x = j.n.r.body.results[j.n.i], check = out[k].results
      const hits = check.filter(y => y.kind !== 'null')
      const sub = hits.length ? hits.map(y => ({ ...y, overturns_null: x.claim }))
        : check.length ? [{ ...x, null_check: 'confirmed by a second, independent search', null_check_inventory: check.flatMap(y => y.checked) }]
        : [{ ...x, null_check: 'not confirmed: its null check reported nothing' }]
      if (!swaps.has(j.n.r)) swaps.set(j.n.r, new Map())
      swaps.get(j.n.r).set(j.n.i, sub)
    })
    for (const [r, at] of swaps) r.body = { ...r.body, results: r.body.results.flatMap((x, i) => at.get(i) ?? [x]) }
  }

  // 3. Probe: the interview's unknowns in round 1; then at most two new ones a round from the mechanisms (decision 10), each in a worktree at base.
  if (round > 1) for (const q of queue.splice(0, 2)) unknowns.push({ ...q, id: takeId(), result: null })
  const toProbe = unknowns.filter(u => u.result === null)
  if (toProbe.length) {
    phase('Probe')
    const jobs = toProbe.map(u => ({ u, prompt: envelope('', '', probeTask(u)),
      opts: { label: `r${round}:probe:${u.id}`, phase: 'Probe', agentType: 'litter:prober', schema: PROBER(u.id), isolation: 'worktree' } }))
    const out = await batch(jobs)
    if (stopped()) return end('')
    const lost = jobs.find((_, i) => out[i] === null)
    if (lost) return end(`the prober for ${lost.u.id} returned nothing twice in round ${round} (Probe)`)
    jobs.forEach((j, i) => {
      j.u.result = out[i]
      const { result: _r, ...unknown } = j.u
      reports.push({ round, role: 'prober', name: j.u.id, from: `prober/${j.u.id}`, kind: 'probe', body: { unknown, result: out[i] } })
    })
  }
  // A load-bearing unknown a mechanism names waits for the next round's probe, numbered when it's let in.
  for (const r of found) {
    if (r.role !== 'mechanism') continue
    for (const x of r.body.empirical_unknowns) {
      if (x.load_bearing === true && oneLine(x.question) !== '' && !known(x.question)) {
        queue.push({ question: String(x.question), smallest_test: String(x.smallest_test), kill_result: String(x.kill_result) })
      }
    }
  }

  // 4. Reframe, every round; from round 2 against the latest proposal and the earlier reframes.
  phase('Reframe')
  const reframe = await call(envelope(material(reports, true), round > 1 ? tag('proposal', proposal, versionAttr(version)) : '', reframeTask(round > 1)),
    { label: `r${round}:reframer`, phase: 'Reframe', agentType: 'litter:reframer', schema: REFRAMER })
  if (reframe === null) return end(`the reframer returned nothing twice in round ${round} (Reframe)`)
  if (reframe.changes_goal === true) return { stopped: 'goal-change', reframe }
  reports.push({ round, role: 'reframer', name: 'reframer', from: 'reframer/reframer', kind: 'reframe', body: reframe })

  // 5. Author: it records the next version; the mod assigns N and fills the result's proposal with the recorded text.
  phase('Author')
  const followUp = round === 1 && prior !== null
  const priorAttrs = prior ? ` version="${attr(prior.version ?? 'none')}" run="${attr(prior.run)}"` : ''
  const own = (round > 1 ? tag('proposal', proposal, versionAttr(version)) + tag('prior_verdict', JSON.stringify({ criteria: verdict.criteria, overall: verdict.overall }), versionAttr(verdict.version))
    : followUp ? tag('proposal', prior.proposal ?? '', priorAttrs) + tag('prior_verdict', prior.verdict ? JSON.stringify(prior.verdict) : '', priorAttrs)
    : '') +
    tag('template', typeof args.template === 'string' ? args.template : '', ` kind="${deliverable}"`) +   // decision 13: left out when empty
    tag('feedback', feedback.join('\n\n'))
  const authored = await call(envelope(material(reports, true), own, authorTask(round, followUp)),
    { label: `r${round}:author`, phase: 'Author', agentType: 'litter:author', schema: AUTHOR })
  if (authored === null) return end(`the author returned nothing twice in round ${round} (Author)`)
  // The version goes into the critic's tags, so it must be one the mod could have assigned.
  if (!VERSION.test(String(authored.version))) return end(`the author's result in round ${round} has no usable version (${attr(authored.version)}); the record result gives it`)
  if (typeof authored.proposal !== 'string' || authored.proposal === '') return end(`the author's result for ${authored.version} carries no proposal text; the mod fills it from the record`)
  version = authored.version
  proposal = authored.proposal
  const blocking = authored.user_decisions.find(d => d.blocking === true)
  if (blocking) return { stopped: 'blocking-decision', decision: blocking }

  // 6. Judge: the recorded text, the delta, the bar map and the probes; never the round or maxRounds (decision 19).
  phase('Judge')
  const judged = version
  const judgeMat = material([...reports.filter(r => r.kind === 'probe'), { round, role: 'author', name: judged, from: `author/${judged}`, kind: 'author',
    body: { bar_map: authored.bar_map, overruled: authored.overruled, residual_unknowns: authored.residual_unknowns, user_decisions: authored.user_decisions } }], false)
  const judgeOwn = tag('proposal', proposal, versionAttr(judged)) + tag('delta', authored.delta.length ? JSON.stringify(authored.delta) : '', versionAttr(judged)) +
    (verdict ? tag('prior_verdict', JSON.stringify({ criteria: verdict.criteria, overall: verdict.overall }), versionAttr(verdict.version)) : '')
  const judge = problems => call(envelope(judgeMat, judgeOwn, criticTask(judged, problems)),
    { label: `critic:${judged}${problems ? ' (again)' : ''}`, phase: 'Judge', agentType: 'litter:design-critic', schema: CRITIC })
  let v = await judge(null)
  if (v === null) return end(`the design critic returned nothing twice on ${judged} in round ${round} (Judge)`)
  if (v.source_changed === true) return { stopped: 'source-changed', version: judged }   // section 9: before anything acts on it
  // 7. Approval, over the whole bar: once more with the problem named, then the criteria as they stand.
  let problems = problemsOf(v, judged)
  if (problems.length) {
    log(`the verdict on ${judged} couldn't be used (${problems.join('; ')}); judging once more`)
    v = await judge(problems)
    if (v === null) return end(`the design critic returned nothing twice on ${judged} in round ${round} (Judge, again)`)
    if (v.source_changed === true) return { stopped: 'source-changed', version: judged }
    problems = problemsOf(v, judged)
  }
  const criteria = settled(v, judged)
  if (problems.length === 0 && criteria.every(c => c.verdict === 'PASS')) return { stopped: null, outcome: 'approved', by: 'approved', version: judged }
  verdict = { version: judged, criteria, overall: 'HOLDING' }

  // 8. Route: a user gap stops for you; the rest shape the next round.
  const user = criteria.filter(c => c.verdict !== 'PASS' && c.gap_kind === 'user')
  if (user.length) return { stopped: 'user-gap', criteria: user }
  if (round > 1 && !wordingOnly && !fresh && reframe.material_change !== true) return holding('no-new-material')
}
return holding('max-rounds')
