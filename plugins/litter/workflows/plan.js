export const meta = {
  name: 'plan-run',
  description: 'Turn a goal, or a plan with no gate list, into ordered gates for an execute run; nothing is changed',
  whenToUse: 'Only through /litter:execute, which records run.start and passes its args; never called directly',
  phases: [{ title: 'Plan' }],
}

// litter's planner run (plan section 7, "Gates come from a litter:plan-run
// workflow"; docs/litter-execute COMMON.md, step 2). The main thread can't
// spawn litter roles, so the planner runs here, once. It reads code and
// changes nothing; the skill shows you its gates and questions, and only
// after you approve does plan.write render them into plan.md. The args are
// run.start's (hooks/lifecycle.ts, prepare, the plan branch): the goal or the
// plan's text and path, the commands, the planner's rules, and for a re-split
// the chain's landed gates and the halt's reason.

const str = { type: 'string' }, strs = { type: 'array', items: str }, bool = { type: 'boolean' }
const GATES = { type: 'object', properties: {          // litter-prompts.md, "Execute schemas"
  gates: { type: 'array', items: { type: 'object', properties: {
    id: str, title: str, scope: str, lines: str, files: strs, done_when: str, checks: strs, adversary: bool },
    required: ['id', 'title', 'scope', 'lines', 'files', 'done_when', 'checks', 'adversary'] } },
  out_of_scope: strs, assumptions: strs, questions: strs },
  required: ['gates', 'out_of_scope', 'assumptions', 'questions'] }

// Envelope (section 7a): data in tags carrying the run's nonce, instruction last.
const tag = (name, body, attrs = '') =>
  body == null || body === '' ? '' : `<${name} id="${args.nonce}"${attrs}>\n${body}\n</${name} id="${args.nonce}">\n`
const list = xs => (xs?.length ? xs.join('\n') : 'none')
// The plan's lines as the gates will cite them (path:start-end), numbered from 1.
const numbered = text => {
  const lines = String(text).split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.map((l, i) => `${i + 1}\t${l}`).join('\n')
}

let interrupted = null                                 // a role missing when the run (re)started (section 9)
let refused = null                                     // worktree.sh refused a worktree (section 9, "Run worktrees")
let outOfBudget = false                                // the engine's own token ceiling stopped the agent() call
async function call(prompt, opts) {                   // one retry on null, then the caller halts
  for (let i = 0; i < 2; i++) {
    let r
    try {
      r = await agent(prompt, { ...opts, label: i === 0 ? opts.label : `${opts.label} (retry)` })
    } catch (e) {                                      // agent() rejects, it doesn't return null, for these
      const msg = String(e?.message)
      if (/^\s*WorktreeCreate hook failed/.test(msg)) { refused = msg; return null }  // the same name would be refused again
      if (e?.name === 'WorkflowBudgetExceededError' || /^Workflow token budget exceeded/.test(msg)) { outOfBudget = true; return null }
      if (/subagent completed without calling StructuredOutput/.test(msg)) continue  // a role that ended without its result: a null (WP-BG)
      if (!/agent type 'litter:[^']*' not found/.test(msg)) throw e   // denied type, bad schema: fatal
      interrupted = msg                                // the run's agent list is fixed, so only a resume can help
      return null
    }
    if (r !== null) return r
  }
  return null
}
const halt = reason => interrupted
  ? { halted: `interrupted: ${interrupted}`, interrupted: true }
  : { halted: refused ?? (outOfBudget ? 'token budget reached' : reason) }

const hasGoal = typeof args?.goal === 'string' && args.goal.trim() !== ''
const hasPlan = typeof args?.plan === 'string' && args.plan.trim() !== ''
if (typeof args?.nonce !== 'string' || args.nonce === '') return halt('no nonce in args; launch through /litter:execute')
if (!hasGoal && !hasPlan) return halt('neither a goal nor a plan in args; launch through /litter:execute')

const resplit = typeof args.continueOf === 'string' && args.continueOf !== ''
const landed = Array.isArray(args.landed) ? args.landed.map(l => `${l.id} (${l.commit})`) : []
const prompt = tag('goal', hasGoal ? args.goal : '') +
  tag('plan', hasPlan ? numbered(args.plan) : '', args.planPath ? ` path="${args.planPath}"` : '') +
  tag('verify', args.verifyCommand) + tag('goal_check', args.goalCheckCommand) +
  tag('rules', (args.rules ?? []).join('\n')) +
  (resplit ? tag('landed', list(landed)) + tag('halted', args.halted ?? 'no reason was recorded') : '') +
  (resplit
    ? `Re-split the work that hasn't landed after run ${args.continueOf} halted, into gates. Don't plan the landed gates again.`
    : hasPlan ? 'Turn the plan into an ordered list of gates.' : 'Plan the goal as an ordered list of gates.')

const planned = await call(prompt, { label: 'planner', phase: 'Plan', agentType: 'litter:planner', schema: GATES })
if (planned === null) return halt('the planner returned nothing')
return { gates: planned.gates, out_of_scope: planned.out_of_scope, assumptions: planned.assumptions, questions: planned.questions }
