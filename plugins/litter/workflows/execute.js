export const meta = {
  name: 'execute-run',
  description: 'Implement an approved plan gate by gate; the critic vetoes, the mod verifies and lands',
  whenToUse: 'Only through /litter:execute or /litter:amend, which record run.start and pass its args; never called directly',
  phases: [{ title: 'Baseline' }, { title: 'Write' }, { title: 'Critique' }, { title: 'Land' }],
}

// litter's execute (plan section 7, execute.js; docs/litter-execute COMMON.md,
// step 1), the sketch as written. The mod decides everything that lands: the
// baseline and every verify are its runs, and a land commits only the tree a
// green verify ran on, with an approving verdict on that verify. This script
// orders the calls, carries feedback between attempts, and halts with a reason
// worded for you; the summary and the repair bridge read the ledger, not it.
// The args are run.start's (hooks/lifecycle.ts, prepare): each gate as argsGate
// shapes it, with its own rules, and the run's rules, nonce and clamp.

const str = { type: 'string' }, strs = { type: 'array', items: str }, bool = { type: 'boolean' }
const DIM = { type: 'object', properties: { pass: bool, evidence: str, gaps: strs }, required: ['pass', 'evidence', 'gaps'] }
const VERDICT = { type: 'object', properties: {
  verify_id: str,                 // from the mod's verify record; accepted only from the agent that recorded it
  plan_adherence: DIM,
  tests_green: DIM,               // pass and evidence overwritten by the mod from verify_id
  no_regressions: DIM,
  rules: DIM,                     // the accepted rules in this gate's <rules> (section 16.5); "none apply" passes
  plan_gap: str,                  // '' unless the gate can't pass without an amendment
  rule_clash: str,                // '' unless rules clash, the plan can't be met without breaking one, or an accepted rule looks wrong: yours to settle
  proposed_rules: strs,           // proposals only: run-local notes now, reviewed by you after the run
  widened: { type: 'array', items: { type: 'object', properties: { file: str, why: str }, required: ['file', 'why'] } } },
                                  // [] unless widen="critic": files outside the gate's Files it can't do without; the land lists each for you
  required: ['verify_id', 'plan_adherence', 'tests_green', 'no_regressions', 'rules', 'plan_gap', 'rule_clash', 'proposed_rules', 'widened'] }
const WRITTEN = { type: 'object', properties: {
  status: { enum: ['done', 'blocked'] }, plan_lines: strs, files: strs, checks: strs, notes: str,
  plan_gap: str },                // '' unless it stopped because the gate's plan lines don't settle the work
  required: ['status', 'plan_lines', 'files', 'checks', 'notes', 'plan_gap'] }
const BREAKS = { type: 'object', properties: {
  breaks: { type: 'array', items: { type: 'object', properties: { scenario: str, command: str, expected: str, observed: str },
    required: ['scenario', 'command', 'expected', 'observed'] } },
  suspicious_tests: strs, not_tested: strs }, required: ['breaks', 'suspicious_tests', 'not_tested'] }
const VERIFIED = { type: 'object', properties: {          // all but verify_id overwritten by the mod from the record
  verify_id: str, exit_code: { type: ['number', 'null'] },  // null when a signal or the mod's timeout ended it
  signal: { type: ['string', 'null'] }, timed_out: bool, green: bool }, required: ['verify_id', 'exit_code', 'green'] }
const LANDED = { type: 'object', properties: { landed: bool, commit: str, reason: str, retry: bool }, required: ['landed'] }  // mod's answer

const MAX_ATTEMPTS = args?.maxAttempts ?? 3
const DIMS = ['plan_adherence', 'tests_green', 'no_regressions', 'rules']
const proposed = new Set()                             // critics' proposed_rules: this run only, never accepted here
const PROPOSED_CAP = 10                                // each one goes into every later prompt
const BUDGET_FLOOR = 50_000
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

// Envelope (section 7a): data in tags carrying the run's nonce, instruction last.
const tag = (name, body, attrs = '') =>
  body == null || body === '' ? '' : `<${name} id="${args.nonce}"${attrs}>\n${body}\n</${name} id="${args.nonce}">\n`
const list = xs => (xs?.length ? xs.join('\n') : 'none')
const common = g => tag('authorized', args.authorized) + tag('verify', args.verifyCommand) +   // shell-quoted by run.start
  tag('rules', [...(args.rules ?? []), ...(g.rules ?? []),                      // accepted, rendered by run.start
    ...[...proposed].map(p => `Proposed in this run, not accepted: ${p}`)].join('\n'))
const gateTag = g => tag('gate', `${g.title}\n${g.excerpt}\nExpected files:\n${list(g.files)}\n` +
  `Checks:\n${list(g.checks)}\nDone when: ${g.done_when}`,
  ` gate="${g.id}" plan="${args.planPath}" lines="${g.lines}" widen="${args.widen === 'critic' ? 'critic' : 'ask'}"`)  // who may add files (WP-AO)

const passed = v => DIMS.every(d => v?.[d]?.pass === true)
const feedbackFrom = (v, wrote, n) => [`Attempt ${n} was rejected.`,
  ...DIMS.flatMap(d => (v[d].pass ? [] : [`${d}: ${v[d].evidence}`, ...v[d].gaps.map(x => `${d}: ${x}`)])),
  `What attempt ${n} said it tried: ${wrote.notes}`].join('\n')

let interrupted = null                                 // a role missing when the run (re)started (section 9)
let refused = null                                     // worktree.sh refused a worktree (section 9, "Run worktrees")
let outOfBudget = false                                // the engine's own token ceiling stopped an agent() call
async function call(prompt, opts) {                   // one retry on null, then the caller halts
  for (let i = 0; i < 2; i++) {
    let r
    try {
      r = await agent(prompt, { ...opts, label: i === 0 ? opts.label : `${opts.label} (retry)` })
    } catch (e) {                                      // agent() rejects, it doesn't return null, for these
      const msg = String(e?.message)
      if (/^\s*WorktreeCreate hook failed/.test(msg)) { refused = msg; return null }  // the same name would be refused again
      if (e?.name === 'WorkflowBudgetExceededError' || /^Workflow token budget exceeded/.test(msg)) { outOfBudget = true; return null }
      if (!/agent type 'litter:[^']*' not found/.test(msg)) throw e   // denied type, bad schema: fatal
      interrupted = msg                                // the run's agent list is fixed, so only a resume can help
      return null
    }
    if (r !== null) return r
  }
  return null
}
const halt = (results, reason) => interrupted
  ? { results, halted: `interrupted: ${interrupted}`, interrupted: true, proposed: [...proposed] }
  : { results, halted: refused ?? (outOfBudget ? 'token budget reached' : reason), proposed: [...proposed] }
const relay = (what, label) => call(what, { label, phase: label === 'baseline' ? 'Baseline' : 'Land',
  agentType: 'litter:relay', schema: what.startsWith('Land') ? LANDED : VERIFIED })
const ended = v => v.timed_out ? 'timed out' : v.exit_code === null ? `killed by ${v.signal ?? 'a signal'}` : `exit ${v.exit_code}`

const gates = Array.isArray(args?.gates) ? args.gates : []
if (gates.length === 0 || typeof args.nonce !== 'string' || args.nonce === '') return halt([], 'no gates or nonce in args; launch through /litter:execute')
const unsafe = gates.find(g => !SAFE_ID.test(String(g?.id)))
if (unsafe) return halt([], 'a gate in args has no usable id; launch through /litter:execute')
// The adversary's Bash is clamped by the engine to run.start's list (decision 23): without it, no adversary runs.
const clamp = Array.isArray(args.adversaryClamp) && args.adversaryClamp.length > 0 ? args.adversaryClamp : null
if (!clamp && (args.adversary || gates.some(g => g.adversary))) return halt([], 'an adversary is asked for, but args has no adversaryClamp; launch through /litter:execute')

// An amend that keeps a halted attempt can't verify the base through the dirty tree, so run.start passes
// the green verify it found for HEAD's tree instead (section 9). Green = exit 0 on a tree the run didn't change.
const baseline = args.baseline ?? await relay('Record a verify for gate baseline and return the mod\'s answer.', 'baseline')
if (baseline === null) return halt([], 'baseline relay returned nothing')
if (baseline.green !== true) return halt([], `baseline is not green (${baseline.verify_id}, ${ended(baseline)}); ` +
  'fix the suite, or choose a verify command that passes today and leaves the tree unchanged')

const results = []
for (const gate of gates) {
  let feedback = gate.carryOver ?? '', verdict = null, wrote = null, landed = null, tries = 0, recritique = false
  while (tries < MAX_ATTEMPTS && landed?.landed !== true) {
    if (budget.total && budget.remaining() < BUDGET_FLOOR) return halt(results, 'token budget reached')
    tries += 1
    if (!recritique) {
      wrote = await call(gateTag(gate) + common(gate) + tag('feedback', feedback) +
        `Implement gate ${gate.id}, attempt ${tries} of ${MAX_ATTEMPTS}. Don't commit.`,
        { label: `write:${gate.id}#${tries}`, phase: 'Write', agentType: 'litter:executor', schema: WRITTEN })
      if (wrote === null) return halt(results, `executor for ${gate.id} returned nothing`)
      // A plan-gap stop halts as a critic's gap does, so the bridge can take it (WP-AH); any other block is the user's.
      if (wrote.status === 'blocked') {
        return halt(results, String(wrote.plan_gap ?? '').trim() !== '' ? `${gate.id} plan gap: ${wrote.plan_gap}` : `${gate.id} blocked: ${wrote.notes}`)
      }
    }
    const wantBreaks = Boolean(gate.adversary || args.adversary) && !recritique
    const breaks = wantBreaks
      ? await call(gateTag(gate) + common(gate) + tag('change', JSON.stringify(wrote)) + `Try to break gate ${gate.id}.`,
          { label: `adversary:${gate.id}#${tries}`, phase: 'Critique', agentType: 'litter:adversary', schema: BREAKS, bashCommandClamp: clamp })
      : null
    if (wantBreaks && breaks === null) return halt(results, `adversary for ${gate.id} returned nothing; the requested check didn't run`)
    verdict = await call(gateTag(gate) + common(gate) + tag('change', JSON.stringify(wrote)) +
      tag('adversary', breaks ? JSON.stringify(breaks) : '') + tag('feedback', feedback) +
      `Judge the uncommitted change for gate ${gate.id}, attempt ${tries}.`,
      { label: `critic:${gate.id}#${tries}`, phase: 'Critique', agentType: 'litter:gate-critic', schema: VERDICT })
    if (verdict === null) return halt(results, `critic for ${gate.id} returned nothing`)
    for (const p of verdict.proposed_rules) {          // all are recorded as rule.propose; only ten reach prompts
      if (proposed.size < PROPOSED_CAP) proposed.add(p)
    }
    // A rule clash is the user's to settle, never a swarm's, so it halts ahead of a plan gap and the bridge declines it.
    if (String(verdict.rule_clash ?? '').trim() !== '') return halt(results, `${gate.id} rule clash: ${verdict.rule_clash}`)
    // A blank gap names none, as the mod reads it (land.ts, repair.ts).
    if (String(verdict.plan_gap ?? '').trim() !== '') return halt(results, `${gate.id} plan gap: ${verdict.plan_gap}`)
    recritique = false
    if (!passed(verdict)) {
      feedback = feedbackFrom(verdict, wrote, tries)
      continue
    }
    // The verify_id goes into the relay's instruction, so it must be one the mod could have made.
    if (!SAFE_ID.test(String(verdict.verify_id))) return halt(results, `critic for ${gate.id} returned no usable verify_id`)
    landed = await relay(`Land gate ${gate.id} with verify_id ${verdict.verify_id}. Return the mod's answer exactly.`, `land:${gate.id}`)
    if (landed === null) return halt(results, `relay for ${gate.id} returned nothing`)
    if (!landed.landed) {                              // approved, but the tree moved: re-critique, don't rewrite
      if (landed.retry !== true) return halt(results, `${gate.id} approved but not landed: ${landed.reason}`)  // branch, ref or index
      feedback = `Approved but not landed: ${landed.reason}.`
      recritique = true
    }
  }
  results.push({ gate: gate.id, tries, verdict, commit: landed?.landed ? landed.commit : null })
  if (landed?.landed !== true) return halt(results, `${gate.id} did not land after ${tries} attempts`)
}

if (args.goalCheck) {                                  // goal mode: the goal's own check must pass at the end
  const goal = await relay('Record a verify for gate goal, using the goal check, and return the mod\'s answer.', 'goal')
  if (goal === null || goal.green !== true) return halt(results, `goal check not met (${goal ? `${goal.verify_id}, ${ended(goal)}` : 'no result'})`)
}
return { results, halted: null, proposed: [...proposed] }
