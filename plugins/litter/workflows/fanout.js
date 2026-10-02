export const meta = {
  name: 'fanout',
  description: 'Run independent tasks in parallel, writers in their own worktrees; the mod merges and verifies, a verifier checks each task, the mod lands',
  whenToUse: 'Only through /litter:fanout, which records run.start and passes its args; never called directly',
  phases: [{ title: 'Run' }, { title: 'Integrate' }, { title: 'Verify' }, { title: 'Land' }],
}

// litter's fanout (plan section 7, fanout.js; docs/litter-phase2 COMMON.md,
// "The fanout, end to end"). The mod decides everything that lands: what is
// merged, the verify, the land. This script only orders the calls, and every
// schema names each field the mod fills, since strict schemas drop the rest
// (section 9, "Observed facts beat claimed ones").

const str = { type: 'string' }, strs = { type: 'array', items: str }, bool = { type: 'boolean' }
const TASK = { type: 'object', properties: {                 // a writer's result
  status: { enum: ['done', 'blocked'] }, files: strs, checks: strs, summary: str, notes: str,
  unbound: bool,                                             // set by output.sh for a writer that never bound
  bind_refusal: str },                                       // the task.bind refusal the mod recorded for it
  required: ['status', 'files', 'checks', 'summary', 'notes'] }
const RESEARCHED = { type: 'object', properties: {
  summary: str,
  findings: { type: 'array', items: { type: 'object', properties: { claim: str, evidence: strs }, required: ['claim', 'evidence'] } },
  open: strs }, required: ['summary', 'findings', 'open'] }
const INTEGRATED = { type: 'object', properties: {           // the integrator's
  resolved: bool,
  files: { type: 'array', items: { type: 'object', properties: { path: str, how: str }, required: ['path', 'how'] } },
  unresolved: strs, checks: strs }, required: ['resolved', 'files', 'unresolved', 'checks'] }
const INTEGRATE = { type: 'object', properties: {            // the mod's answer to an integrate, all but integrate_id filled by it
  integrate_id: str,
  status: { enum: ['merged', 'conflict', 'refused'] },
  where: str, base: str, merged: strs,
  skipped: { type: 'array', items: { type: 'object', properties: { task: str, reason: str, unowned: strs }, required: ['task', 'reason'] } },
  conflict: { type: 'object', properties: { task: str, branch: str, files: strs }, required: ['task', 'branch', 'files'] },
  tip: str, tree: str,
  changed: { type: 'array', items: { type: 'object', properties: {
    path: str, task: { type: ['string', 'null'] }, integrator_extra: bool }, required: ['path', 'task', 'integrator_extra'] } },
  reason: str }, required: ['integrate_id', 'status'] }
const LANDED = { type: 'object', properties: { landed: bool, commit: str, reason: str, retry: bool }, required: ['landed'] }  // mod's answer

// Section 9, "Guard": read-only git and listing commands only. No find, rg or
// git grep, which can run other programs (-exec, --pre, -O).
const READ_ONLY_BASH = ['Bash(cat:*)', 'Bash(git blame:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git ls-files:*)',
  'Bash(git show:*)', 'Bash(git status:*)', 'Bash(grep:*)', 'Bash(head:*)', 'Bash(ls:*)', 'Bash(pwd)', 'Bash(tail:*)', 'Bash(wc:*)']
const BUDGET_FLOOR = 50_000
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

const tasks = Array.isArray(args?.tasks) ? args.tasks : []
const writers = tasks.filter(t => t.writes === true)
const readers = tasks.filter(t => t.writes !== true)
const state = new Map(tasks.map(t => [t.id, { tries: 0, result: null, merged: null, check: null }]))

// Envelope (section 7a): data in tags carrying the run's nonce, instruction last.
const tag = (name, body, attrs = '') =>
  body == null || body === '' ? '' : `<${name} id="${args.nonce}"${attrs}>\n${body}\n</${name} id="${args.nonce}">\n`
const list = xs => (xs?.length ? xs.join('\n') : 'none')
const oneLine = s => String(s ?? '').replace(/\s+/g, ' ').trim()
const short = (s, n = 300) => { const t = oneLine(s); return t.length > n ? `${t.slice(0, n)}…` : t }
const showPath = s => (/[\u0000-\u001f"\\]/.test(s) ? JSON.stringify(s) : s)
const rulesFor = ts => [...new Set([...(args.rules ?? []), ...ts.flatMap(t => t.rules ?? [])])].join('\n')
const taskBody = t => `${t.title}\n${t.text}` + (t.writes === true ? `\nOwned files:\n${list(t.files)}` : '')
const mergedLine = t => {
  const s = state.get(t.id)
  if (t.writes !== true || s.merged === null) return []
  return [s.merged === true ? 'Merged by the mod: yes' : `Not merged by the mod: ${s.merged}`]
}
// <tasks> for the integrator and the verifier: never a bind token.
const tasksTag = (ts, note = () => []) => tag('tasks', ts.map(t => [
  `Task ${t.id} (${t.writes === true ? 'changes files' : 'read-only'}): ${t.title}`, t.text,
  ...(t.writes === true ? ['Owned files:', list(t.files)] : []),
  ...note(t), 'Report:', JSON.stringify(state.get(t.id).result)].join('\n')).join('\n\n'))

let interrupted = null                                       // a role missing when the run (re)started (section 9)
let refused = null                                           // worktree.sh refused a worktree (section 9, "Run worktrees")
let outOfBudget = false                                      // the engine's hard ceiling stopped an agent() call
let verifyId = null, landed = null

/** One agent() call: null for a null result, and for the rejections that halt without a retry. */
async function attempt(prompt, opts) {
  try {
    return await agent(prompt, opts)
  } catch (e) {                                              // agent() rejects, it doesn't return null, for these
    const msg = String(e?.message)
    if (/^\s*WorktreeCreate hook failed/.test(msg)) { refused ??= msg; return null }  // the same name would be refused again
    if (/agent type 'litter:[^']*' not found/.test(msg)) { interrupted ??= msg; return null }  // only a resume can help
    if (e?.name === 'WorkflowBudgetExceededError' || /^Workflow token budget exceeded/.test(msg)) { outOfBudget = true; return null }
    throw e                                                  // a denied type, a bad schema: fatal
  }
}
const stopped = () => interrupted !== null || refused !== null || outOfBudget
async function call(prompt, opts) {                          // one retry on null, then the caller halts
  for (let i = 0; i < 2; i++) {
    const r = await attempt(prompt, i === 0 ? opts : { ...opts, label: `${opts.label} (retry)` })
    if (r !== null || stopped()) return r
  }
  return null
}
const results = () => tasks.map(t => ({ id: t.id, writes: t.writes === true, ...state.get(t.id) }))
const halt = reason => interrupted
  ? { halted: `interrupted: ${interrupted}`, interrupted: true, results: results(), verify_id: verifyId, landed }
  : { halted: refused ?? (outOfBudget ? 'token budget reached' : reason), results: results(), verify_id: verifyId, landed }
const lowBudget = () => budget.total && budget.remaining() < BUDGET_FLOOR
const relay = (what, label, phase, schema) => call(what, { label, phase, agentType: 'litter:relay', schema })

if (tasks.length === 0 || typeof args.nonce !== 'string' || args.nonce === '') return halt('no tasks or nonce in args; launch through /litter:fanout')
const unsafe = tasks.find(t => !SAFE_ID.test(String(t.id)) || (t.writes === true && !SAFE_ID.test(String(t.bind ?? ''))))
if (unsafe) return halt(`task ${short(unsafe.id, 80)} has no usable id or bind token; launch through /litter:fanout`)

// 1. Run: every task at once, writers each in a worktree the mod's worktree.sh makes at base.
phase('Run')
log(`${writers.length} writing ${writers.length === 1 ? 'task' : 'tasks'} in worktrees, ${readers.length} read-only`)
const prompts = new Map(tasks.map(t => [t.id, t.writes === true
  ? tag('task', taskBody(t), ` task="${t.id}" bind="${t.bind}"`) + tag('contract', args.contract) + tag('authorized', args.authorized) +
    tag('verify', args.verifyCommand) + tag('rules', rulesFor([t])) +
    `Bind to task ${t.id} first, with the bind value in <task>. Then do the task in your own worktree. When its checks pass, ` +
    `commit only your task's files on this worktree's branch with the message "${oneLine(args.run)} ${t.id}: ${oneLine(t.title).replace(/"/g, "'")}". ` +
    "Don't merge, rebase or push."
  : tag('task', taskBody(t), ` task="${t.id}"`) + tag('contract', args.contract) + tag('authorized', args.authorized) +
    tag('rules', rulesFor([t])) + `Answer task ${t.id}. Don't change files.`]))
const optsFor = (t, retry) => {
  const label = `${t.writes === true ? 'write' : 'research'}:${t.id}${retry ? ' (retry)' : ''}`
  return t.writes === true
    ? { label, phase: 'Run', agentType: 'litter:executor', schema: TASK, isolation: 'worktree' }
    : { label, phase: 'Run', agentType: 'litter:researcher', schema: RESEARCHED, bashCommandClamp: READ_ONLY_BASH }
}
// parallel() turns a thrown thunk into null, so a fatal rejection is kept and rethrown after it.
let fatal = null
const runAll = async (ts, retry) => {
  const out = await parallel(ts.map(t => async () => {
    state.get(t.id).tries += 1
    try {
      return await attempt(prompts.get(t.id), optsFor(t, retry))
    } catch (e) {
      fatal ??= e
      return null
    }
  }))
  if (fatal) throw fatal
  ts.forEach((t, i) => { state.get(t.id).result = out[i] ?? null })
}

if (lowBudget()) return halt('token budget reached')
await runAll(tasks, false)
// A null is retried once. The retries start after every first call, in task order, so a
// replay starts each call in the same order and asks the engine for the same worktree names.
let missing = tasks.filter(t => state.get(t.id).result === null)
if (missing.length > 0 && !stopped()) {
  if (lowBudget()) return halt('token budget reached')
  log(`retrying ${missing.map(t => t.id).join(', ')}, which returned nothing`)
  await runAll(missing, true)
  missing = tasks.filter(t => state.get(t.id).result === null)
}
if (stopped()) return halt('a task call was refused')
if (missing.length > 0) {
  return halt(missing.map(t => `${t.writes === true ? 'executor' : 'researcher'} for ${t.id} returned nothing`).join('; '))
}
const isBlocked = t => t.writes === true && (state.get(t.id).result.status !== 'done' || state.get(t.id).result.unbound === true)

// 2. Integrate: the mod merges the branches in the confirmed order; an integrator resolves each conflict.
phase('Integrate')
if (lowBudget()) return halt('token budget reached')
const INTEGRATE_ASK = "Record an integrate and return the mod's answer, field for field."
let answer = await relay(INTEGRATE_ASK, 'integrate', 'Integrate', INTEGRATE)
const resolutions = []
while (answer !== null && answer.status === 'conflict') {
  const c = answer.conflict
  const mergedSoFar = `merged so far: ${list(answer.merged)}`
  if (!c || !state.has(c.task) || typeof answer.where !== 'string' || !answer.where.startsWith('/')) {
    return halt(`the mod reported a conflict without its task or worktree; ${mergedSoFar}`)
  }
  if (resolutions.some(r => r.task === c.task) || resolutions.length >= writers.length) {   // at most once per writer
    return halt(`the mod still reports a conflict merging ${c.task} after the integrator; ${mergedSoFar}`)
  }
  if (lowBudget()) return halt('token budget reached')
  const sides = writers.filter(t => t.id === c.task || (answer.merged ?? []).includes(t.id))
  const resolved = await call(tag('where', answer.where) +
    tag('conflict', `Merging task ${c.task} (branch ${c.branch}) stopped with conflicts in:\n${list((c.files ?? []).map(showPath))}\n` +
      `Already merged: ${list(answer.merged)}`) +
    tasksTag(sides, t => [t.id === c.task ? 'Side: the task being merged' : 'Side: already merged']) +
    tag('contract', args.contract) + tag('rules', rulesFor(sides)) + tag('authorized', args.authorized) +
    'Resolve the conflicts listed in <conflict>, working only inside <where>.',
    { label: `integrator:${c.task}`, phase: 'Integrate', agentType: 'litter:integrator', schema: INTEGRATED })
  if (resolved === null) return halt(stopped() ? 'the integrator was refused' : `the integrator for ${c.task} returned nothing; ${mergedSoFar}`)
  if (resolved.resolved !== true || (resolved.unresolved ?? []).length > 0) {
    return halt(`the integrator left ${c.task}'s conflicts unresolved: ${short((resolved.unresolved ?? []).join('; ') || 'no detail', 600)}; ${mergedSoFar}`)
  }
  resolutions.push({ task: c.task, branch: c.branch, conflicted: c.files ?? [], result: resolved })
  if (lowBudget()) return halt('token budget reached')
  answer = await relay(INTEGRATE_ASK, `integrate#${resolutions.length + 1}`, 'Integrate', INTEGRATE)
}
if (answer === null) return halt(stopped() ? 'the integrate relay was refused' : 'relay for integrate returned nothing')
if (answer.status === 'refused') return halt(`integration refused: ${short(answer.reason || 'the mod gave no reason', 600)}`)
if (answer.status !== 'merged' || typeof answer.where !== 'string' || !answer.where.startsWith('/') || typeof answer.base !== 'string') {
  return halt(`the integrate relay returned no usable answer (status ${short(answer.status, 40)})`)
}
for (const t of writers) {
  const skip = (answer.skipped ?? []).find(s => s.task === t.id)
  state.get(t.id).merged = (answer.merged ?? []).includes(t.id) ? true
    : skip ? `${short(skip.reason)}${skip.unowned?.length ? ` (unowned: ${skip.unowned.map(showPath).join(', ')})` : ''}` : 'not merged'
}

// 3. Verify: the verifier records the mod's verify in the integration worktree, then judges each task.
phase('Verify')
if (lowBudget()) return halt('token budget reached')
const ids = tasks.map(t => t.id)
const FANOUT_CHECK = { type: 'object', properties: {
  verify_id: str,                                            // from the mod's verify record; accepted only from the agent that recorded it
  tasks: { type: 'array', items: { type: 'object', properties: { id: { enum: ids }, pass: bool, evidence: str, gaps: strs },
    required: ['id', 'pass', 'evidence', 'gaps'] } },
  combined: str }, required: ['verify_id', 'tasks', 'combined'] }
const changed = (answer.changed ?? []).map(c =>
  `${showPath(c.path)}  owner: ${c.task ?? 'none'}${c.integrator_extra ? '  integrator_extra: read it in full' : ''}`)
const check = await call(tag('where', answer.where) + tag('base', answer.base) + tasksTag(tasks, mergedLine) +
  tag('changed', list(changed)) + tag('contract', args.contract) + tag('rules', rulesFor(tasks)) +
  tag('integrator', resolutions.length ? JSON.stringify(resolutions) : '') +
  'Check the combined result. Record a verify for gate integration, attempt 1, first.' +
  (readers.length ? ' For read-only tasks, open the cited file:line locations, confirm they say what the report claims, ' +
    'and check that the findings answer the task as asked.' : ''),
  { label: 'verifier', phase: 'Verify', agentType: 'litter:verifier', schema: FANOUT_CHECK })
if (check === null) return halt(stopped() ? 'the verifier was refused' : 'verifier returned nothing')
if (typeof check.verify_id !== 'string' || !SAFE_ID.test(check.verify_id)) return halt('the verifier returned no usable verify_id')
verifyId = check.verify_id
for (const x of check.tasks ?? []) if (state.has(x.id) && state.get(x.id).check === null) state.get(x.id).check = { pass: x.pass, evidence: x.evidence, gaps: x.gaps }
const seen = (check.tasks ?? []).map(x => x.id)
const covered = seen.length === ids.length && new Set(seen).size === ids.length && ids.every(id => seen.includes(id))

// 4. Land: all or nothing, only when every task did its part and passed.
const blockers = []
for (const t of writers) {
  const r = state.get(t.id).result
  if (isBlocked(t)) blockers.push(`${t.id} blocked: ${short(r.bind_refusal || r.summary || r.notes || 'no reason given')}`)
  else if (state.get(t.id).merged !== true) blockers.push(`${t.id} not merged: ${state.get(t.id).merged}`)
}
if (!covered) blockers.push(`the verifier didn't judge each task once (it judged: ${seen.join(', ') || 'none'})`)
for (const t of tasks) {
  const c = state.get(t.id).check
  if (c && c.pass !== true) blockers.push(`${t.id} failed the verifier: ${short(c.evidence)}`)
}
if (blockers.length > 0) {
  const why = blockers.join('; ')
  return halt(`${writers.length ? 'nothing landed' : 'not verified'}: ${why.length > 2000 ? `${why.slice(0, 2000)}…` : why}`)
}
if (writers.length === 0) return { halted: null, results: results(), verify_id: verifyId, landed }   // verified, nothing to land

phase('Land')
if (lowBudget()) return halt('token budget reached')
landed = await relay(`Land gate fanout with verify_id ${verifyId}. Return the mod's answer exactly.`, 'land:fanout', 'Land', LANDED)
if (landed === null) return halt(stopped() ? 'the land relay was refused' : 'relay for the land returned nothing')
if (landed.landed !== true) return halt(`verified but not landed: ${short(landed.reason || 'the mod gave no reason', 600)}`)
return { halted: null, results: results(), verify_id: verifyId, landed }
