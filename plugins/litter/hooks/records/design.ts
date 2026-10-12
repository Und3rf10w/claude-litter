// Record bodies for design runs, plans and the rest of the kinds the record
// tool validates itself (plan section 9, "The record kinds"). Owner: phase 1b,
// work package B; phase 4's design bodies are WP-BA's contract. The design
// records' handlers (proposal, verdict, probe) are hooks/design/records.ts's
// (WP-BC); the rest of the kinds this file validates are below.

import type { Author, Caller, RecordCtx, RecordError, RecordHandler, RecordInput, RecordReply, StoredRecord } from './core'
import type { BoundWorktree, TaskBindBody, WorktreeCreateBody } from './fanout'
import type { AgentPolicy } from '../hookfiles'
import type { LedgerRead } from '../ledgercore'
import { fail } from './core'
import { appendRecord, readLedger } from '../ledgercore'
import { checkedRunJson } from '../runjson'
import { agentPolicyPath, integrationName, outPath, runDir, wikiPath } from '../layout'
import { atomicWrite, atomicWriteJson, remove, serial } from '../fsx'
import { safeFileName, writeOut } from '../output'
import { agentInfo } from '../policy'
import { recordedWorktrees } from '../worktrees'

/** Every kind the record tool knows, in its canonical spelling. `kind` matches case-insensitively. */
export const KNOWN_KINDS = [
  // design
  'finding', 'coverage', 'mechanism', 'probe', 'reframe', 'proposal', 'verdict', 'design.feedback',
  // execute
  'verify', 'land.intent', 'land', 'land.abandoned', 'land.blocked', 'rule.propose',
  // fanout (bodies in records/fanout.ts; task.result is also an execute gate executor's, output.ts's GateResultBody)
  'task.bind', 'task.result', 'integrate', 'integrate.merge', 'integrate.conflict', 'integrate.skip', 'integrate.done',
  // the run lock
  'lock.recovered', 'lock.forced',
  // launchers and the mod's own
  'run.start', 'run.launch', 'run.resume', 'run.stopping', 'run.end',
  'worktree.intent', 'worktree.create', 'worktree.setup_failed', 'worktree.removed', 'worktree.kept',
  'plan.write', 'gate.amend', 'gate.widen', 'wiki.write',
  // rules (phase 3; bodies in records/rules.ts): rule.propose above, and the
  // rules ledger's other two the tool takes
  'rule.open', 'rule.import',
  // read-only
  'run.find', 'rule.find',
  // swarms (phase 2b; bodies in records/swarm.ts). Through the tool only
  // swarm.bind (a node) and swarm.end (the lead's end request); the rest are the mod's.
  'swarm.revision', 'swarm.proposal', 'swarm.proposal.decided',
  'swarm.start', 'swarm.worktree.intent', 'swarm.worktree', 'swarm.worktree.failed', 'swarm.worktree.removed', 'swarm.worktree.kept',
  'swarm.instance', 'swarm.node', 'swarm.bind', 'swarm.event', 'swarm.summary',
  'swarm.stop', 'swarm.stopping', 'swarm.handover', 'swarm.end', 'session.rebind',
  // repair (phase 2b-2; bodies in records/run.ts and records/swarm.ts). Through
  // the tool only the launcher's repair.start and repair.budget; the rest are the mod's.
  'run.repair', 'repair.declined', 'repair.start', 'repair.budget',
  // design, the mod's (phase 4; bodies below): the author's and the reframer's
  // results (decision 15), and a plan's delivery at run.end (decision 16)
  'design.result', 'design.deliver',
] as const

export type KnownKind = (typeof KNOWN_KINDS)[number]

/** Kinds only the mod writes; a call from an agent or the launcher is refused (run.end has the launcher fallback). */
export const MOD_ONLY_KINDS: readonly KnownKind[] = [
  'land.intent', 'land.abandoned', 'land.blocked', 'run.launch', 'run.resume', 'run.stopping',
  'lock.recovered', 'lock.forced', 'worktree.intent', 'worktree.create', 'worktree.setup_failed',
  'worktree.removed', 'worktree.kept', 'task.result',
  'integrate.merge', 'integrate.conflict', 'integrate.skip', 'integrate.done',
  'swarm.revision', 'swarm.proposal', 'swarm.proposal.decided',
  'swarm.start', 'swarm.worktree.intent', 'swarm.worktree', 'swarm.worktree.failed', 'swarm.worktree.removed', 'swarm.worktree.kept',
  'swarm.instance', 'swarm.node', 'swarm.event', 'swarm.summary',
  'swarm.stop', 'swarm.stopping', 'swarm.handover', 'session.rebind',
  'run.repair', 'repair.declined',
  'design.result', 'design.deliver',
]

/** Rule steps that are yours alone, from the rules pane (section 16.3); the tool refuses them whatever the caller. */
export const USER_ONLY_KINDS = ['rule.accept', 'rule.dismiss', 'rule.retire'] as const

/**
 * Who may record each kind through the tool, and where its run comes from
 * (section 9's grouping of the kinds: the roles' kinds, the launchers' kinds,
 * the mod's own). `run`: `required` and `optional` resolve a run, from the
 * agent map for an agent and from the input for the main thread; `none`
 * leaves `run` to the handler (run.start makes one, run.find filters by it).
 */
export type KindRule = { by: 'agent' | 'launcher' | 'any' | 'mod'; run: 'required' | 'optional' | 'none' }

const agentKind: KindRule = { by: 'agent', run: 'required' }
const launcherKind: KindRule = { by: 'launcher', run: 'required' }
const modKind: KindRule = { by: 'mod', run: 'required' }

export const KIND_RULES: Readonly<Record<KnownKind, KindRule>> = {
  finding: agentKind,
  coverage: agentKind,
  mechanism: agentKind,
  probe: agentKind,
  reframe: agentKind,
  proposal: agentKind,
  verdict: agentKind,
  'design.feedback': launcherKind,
  verify: agentKind,
  'land.intent': modKind,
  land: agentKind,
  'land.abandoned': modKind,
  'land.blocked': modKind,
  'rule.propose': { by: 'any', run: 'optional' },
  'task.bind': agentKind,
  'task.result': modKind,
  integrate: agentKind,
  'integrate.merge': modKind,
  'integrate.conflict': modKind,
  'integrate.skip': modKind,
  'integrate.done': modKind,
  'lock.recovered': modKind,
  'lock.forced': modKind,
  'run.start': { by: 'launcher', run: 'none' },
  'run.launch': modKind,
  'run.resume': modKind,
  'run.stopping': modKind,
  'run.end': launcherKind,
  'worktree.intent': modKind,
  'worktree.create': modKind,
  'worktree.setup_failed': modKind,
  'worktree.removed': modKind,
  'worktree.kept': modKind,
  'plan.write': launcherKind,
  'gate.amend': launcherKind,
  // WP-AO: the lead's or the execute skill's request; the handler asks you, and records it only on your yes.
  'gate.widen': launcherKind,
  'wiki.write': { by: 'launcher', run: 'none' },
  // Rules (phase 3): the rules ledger is no run's, so none is resolved.
  'rule.open': { by: 'any', run: 'none' },
  'rule.import': { by: 'launcher', run: 'none' },
  'run.find': { by: 'any', run: 'none' },
  'rule.find': { by: 'any', run: 'none' },
  // Swarms: no run is resolved for the two the tool takes; their handlers find the launch.
  'swarm.revision': modKind,
  'swarm.proposal': modKind,
  'swarm.proposal.decided': modKind,
  'swarm.start': modKind,
  'swarm.worktree.intent': modKind,
  'swarm.worktree': modKind,
  'swarm.worktree.failed': modKind,
  'swarm.worktree.removed': modKind,
  'swarm.worktree.kept': modKind,
  'swarm.instance': modKind,
  'swarm.node': modKind,
  'swarm.bind': { by: 'agent', run: 'none' },
  'swarm.event': modKind,
  'swarm.summary': modKind,
  'swarm.stop': modKind,
  'swarm.stopping': modKind,
  'swarm.handover': modKind,
  'swarm.end': { by: 'launcher', run: 'none' },
  'session.rebind': modKind,
  // Repair (2b-2): repair.start names the run it repairs; repair.budget names
  // a swarm, and its handler finds the swarm's run.
  'run.repair': modKind,
  'repair.declined': modKind,
  'repair.start': launcherKind,
  'repair.budget': { by: 'launcher', run: 'none' },
  // Design (phase 4): consumeOutput's and finalizeDesign's, never the tool's.
  'design.result': modKind,
  'design.deliver': modKind,
}

/** The `by` of a record a caller made through the tool. */
export const authorOf = (caller: Caller): Author =>
  caller.agentId === null ? { source: 'launcher' } : { source: 'agent', agentId: caller.agentId, agentType: caller.agentType }

// ---------------------------------------------------------------------------
// The design records' bodies (phase 4; COMMON decisions 6, 7, 15 to 18). A
// version and an unknown id are layout.ts's PROPOSAL_VERSION and UNKNOWN_ID.

/** A criterion's verdict, and a verdict's overall result (plan 7, step 8). */
export const CRITERION_VERDICTS = ['PASS', 'CONDITIONAL', 'FAIL'] as const
export const OVERALLS = ['APPROVED', 'HOLDING'] as const
/** Where a criterion that isn't PASS sends the next round (plan 7, step 9). */
export const GAP_KINDS = ['investigation', 'design', 'wording', 'user'] as const
export type GapKind = (typeof GAP_KINDS)[number]
/** A probe's verdict on its unknown (decision 18). */
export const PROBE_VERDICTS = ['confirmed', 'refuted', 'untested'] as const
export type ProbeVerdict = (typeof PROBE_VERDICTS)[number]

/**
 * One of the author's gates (decision 6), as its `proposal` record carries
 * it. renderProposal (hooks/design/proposal.ts) writes it after the prose in
 * section 10's format: `scope` is the gate's prose, closed by the line
 * `Implements: <plan_section>`, and `plan_section` names a heading of the
 * proposal's prose.
 */
export type AuthorGate = {
  id: string
  title: string
  plan_section: string
  scope: string
  files: string[]
  checks: string[]
  done_when: string
  rollback: string
  adversary?: boolean
}

/**
 * A stored `proposal` record's body: the mod assigns `version`. `text` is the
 * author's prose as recorded, and `sha256` is the stored file's,
 * `proposals/<version>.md`, which for a plan holds the gate sections too.
 */
export type ProposalBody = { text: string; delta?: unknown; gates?: AuthorGate[]; version: string; sha256: string }

/** One bar item's verdict, by its id. Every one that isn't PASS carries a `gap_kind` (BC checks it). */
export type DesignCriterion = {
  id: string
  verdict: (typeof CRITERION_VERDICTS)[number]
  gap_or_reason?: string
  evidence: string
  kept_from?: string
  reversed?: boolean
  gap_kind?: GapKind
}

/**
 * A stored `verdict` record's body, the design critic's: `sha256` is the
 * judged version's, from its proposal record. `tree` and `source_changed`
 * are the checkout's snapshot when the critic recorded it, against base
 * (decision 17, WP-BC's); a record from before BC has neither.
 */
export type DesignVerdictBody = {
  version: string
  criteria: DesignCriterion[]
  overall: (typeof OVERALLS)[number]
  sha256: string | null
  tree?: string
  source_changed?: boolean
}

/**
 * A stored `probe` record's body (decision 18): the unknown it settles and
 * the verdict. The record tool requires both (WP-BC); they stay optional
 * here for a probe recorded before then, which has only its report. The
 * question, as the task gave it, is optional: for an unknown a mechanism
 * proposed, it's the only record of the question.
 */
export type ProbeBody = { unknown_id?: string; question?: string; report: string; verdict?: ProbeVerdict }

/**
 * `design.result`, the mod's (decision 15): the author's or the reframer's
 * StructuredOutput, as spooled, recorded once per `tool_use_id` by
 * consumeOutput. The author's `proposal` is left out of `result`, since its
 * text is in `proposals/<version>.md`; its `version` stays.
 */
export type DesignResultBody = { role: 'author' | 'reframer'; tool_use_id: string; result: Record<string, unknown> }

/**
 * `design.deliver`, the mod's (decision 16): one per run end of a plan
 * deliverable, recorded by finalizeDesign (WP-BE). Delivered: `version`,
 * `sha256` and `path` (`<runDir>/plan.md`, the approved bytes). Refused:
 * `refused` says why, and `version` is the latest one, or null when none
 * was recorded.
 */
export type DesignDeliverBody = { version: string | null; sha256?: string; path?: string; refused?: string }

// needText, bodyOf, scoped and store are shared with the handlers moved out
// (plan.ts's plan.write and gate.amend, rules/records.ts's rule.propose, and
// design/records.ts's proposal, verdict and probe).

/** A required non-empty string field, or the error naming it. */
export function needText(input: RecordInput, field: string, what: string): RecordError | null {
  const v = input[field]
  return typeof v === 'string' && v.trim() !== '' ? null : fail(`litter: '${field}' is required: ${what}`, field)
}

/** The input without the envelope's own fields, as the record's body. */
export function bodyOf(input: RecordInput): Record<string, unknown> {
  const { kind: _kind, run: _run, ...rest } = input
  return rest
}

export type Scoped = { run: string; runDir: string }

/** The run the record tool resolved. A handler reached without one is a wiring bug, so it throws. */
export function scoped(ctx: RecordCtx, input: RecordInput): Scoped {
  if (!ctx.litterDir || typeof input.run !== 'string') throw new Error(`records/design: '${input.kind}' reached its handler without a run`)
  return { run: input.run, runDir: runDir(ctx.litterDir, input.run) }
}

/** Appends `body` to the resolved run's ledger, by the caller, and answers with its seq and `extra`. */
export async function store(ctx: RecordCtx, input: RecordInput, body: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<RecordReply> {
  const { run, runDir: dir } = scoped(ctx, input)
  const rec = await appendRecord(ctx.p, dir, { run, kind: input.kind, by: authorOf(ctx.caller), body })
  return { ok: true, kind: rec.kind, run, seq: rec.seq, ...extra }
}

// The investigators' reports (section 6): one markdown report each. The
// prober's is design/records.ts's recordProbe.
const report: RecordHandler = async (ctx, input) =>
  needText(input, 'report', 'your report, as markdown, in the sections your role names') ?? store(ctx, input, bodyOf(input))

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|rb|go|rs|java|kt|c|h|cc|cpp|hpp|cs|sh|yml|yaml|toml|txt|css|html|sql|swift)$/i

/** A backticked span that reads as a repository path (with or without a :line suffix). */
const looksLikePath = (span: string): boolean => {
  const s = span.replace(/:[0-9]+(-[0-9]+)?$/, '')
  return /^[\w.@~-]+(\/[\w.@~-]+)+\/?$/.test(s) || /^[\w@~-][\w.@~-]*$/.test(s) && CODE_EXT.test(s)
}

/**
 * Bare backticked paths in a proposal's prose (section 9, "Its rules"):
 * fenced and indented code is skipped, and so is a span that is already a
 * link's label.
 */
export function bareBacktickPaths(text: string): string[] {
  const found = new Set<string>()
  let fenced = false
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced || /^( {4}|\t)/.test(line)) continue
    for (const m of line.matchAll(/(?<!\[)`([^`\s]+)`(?!\]\()/g)) {
      if (looksLikePath(m[1]!)) found.add(m[1]!)
    }
  }
  return [...found]
}

type BindTask = { id: string; bind: string; files: string[] }

/**
 * The writing tasks run.start put in run.json's args, each with its `bind`
 * token (section 7, fanout.js step 2): from run.json as run.start wrote it,
 * else why not.
 */
async function bindTasks(ctx: RecordCtx, run: string, dir: string, ledger: LedgerRead): Promise<BindTask[] | { refused: string }> {
  const c = await checkedRunJson(ctx.p, { run, runDir: dir }, ledger)
  if (!c.ok) return { refused: c.reason }
  const tasks = c.json.args?.tasks
  if (!Array.isArray(tasks)) return []
  return tasks.flatMap(t => {
    const task = t as { id?: unknown; bind?: unknown; files?: unknown }
    if (typeof task?.id !== 'string' || typeof task.bind !== 'string' || task.bind === '') return []
    const files = Array.isArray(task.files) ? task.files.filter((f): f is string => typeof f === 'string') : []
    return [{ id: task.id, bind: task.bind, files }]
  })
}

type Binding = { seq: number; agent: string; body: TaskBindBody }

/** The run's task.bind records, in order. A body without its worktree (phase 1's) names none. */
function bindingsOf(records: readonly StoredRecord[]): Binding[] {
  return records.flatMap(r => {
    if (r.kind !== 'task.bind' || r.by.source !== 'agent' || typeof r.body.task !== 'string') return []
    return [{ seq: r.seq, agent: r.by.agentId, body: r.body as unknown as TaskBindBody }]
  })
}

/** The agent a task.result speaks for: its author, or the agent the mod recorded it from. */
const resultAgent = (rec: StoredRecord): string | null =>
  rec.by.source === 'agent' ? rec.by.agentId : typeof rec.body.agent_id === 'string' ? rec.body.agent_id : null

const nfc = (s: string): string => s.normalize('NFC')

async function resolved(ctx: RecordCtx, path: string): Promise<string> {
  try {
    return (await ctx.p.fs.stat(path, { resolve: true })).realPath ?? path
  } catch {
    return path
  }
}

type BindOutcome = { reply: RecordReply; bound: boolean }

/**
 * `task.bind`: binds the calling writer to the task whose token it presents,
 * and to its worktree: its SubagentStart cwd, which must be one of this run's
 * recorded `worktree.create` paths (section 7, fanout.js step 2). Each task
 * binds to one worktree and each worktree to one task. A second agent with
 * the same token is accepted from the same worktree (the restarted writer),
 * and from another worktree only once the agent bound before it has stopped
 * without a `task.result`; that binding names the one it `supersedes`
 * (COMMON.md, "Rebinding"). The token itself is never stored.
 *
 * A refused writer that isn't bound gets its out file, `bind_refusal`, before
 * the answer, so output.sh can add the reason to its blocked result; a
 * successful bind removes it.
 */
const taskBind: RecordHandler = async (ctx, input) => {
  const { run, runDir: dir } = scoped(ctx, input)
  const agentId = ctx.caller.agentId
  if (agentId === null) throw new Error('records/design: task.bind reached its handler from the main thread')
  if (!safeFileName(agentId)) throw new Error(`records/design: agent id '${agentId}' can't name a binding file`)
  if (ctx.caller.agentType !== 'litter:executor') {
    return fail(`litter: task.bind is for a fanout's writers (litter:executor), not ${ctx.caller.agentType ?? 'this agent'}`, 'kind')
  }
  return serial(`bind:${dir}`, async () => {
    const out = await bindWriter(ctx, input, run, dir, agentId)
    const outFile = outPath(ctx.litterDir!, agentId)
    if (out.reply.ok) {
      if (await ctx.p.fs.exists(outFile)) await remove(ctx.p, outFile)
    } else if (!out.bound) {
      // Written before the answer: the writer's next call may be its blocked StructuredOutput.
      await writeOut(ctx.p, ctx.litterDir!, { v: 1, agent_id: agentId, for: {}, fields: { bind_refusal: out.reply.error } })
    }
    return out.reply
  })
}

async function bindWriter(ctx: RecordCtx, input: RecordInput, run: string, dir: string, agentId: string): Promise<BindOutcome> {
  const read = await readLedger(ctx.p, dir, run)
  const { records } = read
  const bindings = bindingsOf(records)
  const mine = bindings.filter(b => b.agent === agentId).at(-1)
  const refuse = (error: string, field?: string): BindOutcome => ({ reply: fail(error, field), bound: mine !== undefined })

  const missing = needText(input, 'token', 'the bind value from your <task>, exactly')
  if (missing) return { reply: missing, bound: mine !== undefined }
  const tasks = await bindTasks(ctx, run, dir, read)
  if (!Array.isArray(tasks)) return refuse(`litter: ${tasks.refused}`)
  const task = tasks.find(t => t.bind === input.token)
  if (!task) return refuse("litter: no task of this run has that bind value; copy it exactly from the bind attribute of your <task>", 'token')
  const me = await agentInfo(ctx.p, agentId)
  if (!me) return refuse(`litter: agent ${agentId} has no recorded start yet, so its worktree isn't known; call task.bind again`)

  // The worktree, from the engine: the caller's cwd is one this run recorded (worktree.sh's creates, drained before this call).
  const cwd = nfc(await resolved(ctx, me.cwd))
  const own = new Set([integrationName(run), `litter-${run}`])
  const created = recordedWorktrees(records).filter(w => !own.has(w.name) && !w.disposable)
  let wt: WorktreeCreateBody | undefined
  for (const w of created) {
    if (nfc(w.path) === cwd || nfc(await resolved(ctx, w.path)) === cwd) {
      wt = w
      break
    }
  }
  if (!wt) return refuse(`litter: your working directory ${me.cwd} isn't one of this run's worktrees, so task.bind can't bind you`)
  const worktree: BoundWorktree = { name: wt.name, path: wt.path, branch: wt.branch }
  const sameWorktree = (b: Binding) => b.body.worktree?.name === wt!.name

  if (mine) {
    if (mine.body.task !== task.id) return refuse(`litter: you're already bound to task ${mine.body.task}; a writer binds to one task`, 'token')
    // The same call again: the binding stands.
    await writeBinding(ctx, run, agentId, task, worktree)
    return { reply: { ok: true, kind: 'task.bind', run, seq: mine.seq, task: task.id, worktree }, bound: true }
  }
  const taken = bindings.find(b => sameWorktree(b) && b.body.task !== task.id)
  if (taken) return refuse(`litter: this worktree is already bound to task ${taken.body.task}; each worktree binds to one task`, 'token')

  let supersedes: string | undefined
  const holder = bindings.filter(b => b.body.task === task.id).at(-1)
  if (holder && !sameWorktree(holder)) {
    // Rebinding from a second worktree: only once the first writer stopped without a result.
    const where = holder.body.worktree?.path ?? "another writer's worktree"
    const other = await agentInfo(ctx.p, holder.agent)
    if (!other) return refuse(`litter: task ${task.id} is bound to agent ${holder.agent} in ${where}, and litter can't tell whether it has stopped; only that worktree can bind it`, 'token')
    if (other.stopped === null) return refuse(`litter: task ${task.id} is bound to agent ${holder.agent} in ${where}, which is still running; only that worktree can bind it`, 'token')
    if (records.some(r => r.kind === 'task.result' && resultAgent(r) === holder.agent)) {
      return refuse(`litter: task ${task.id} was bound in ${where}, and that writer already returned its result; it can't be bound again`, 'token')
    }
    supersedes = holder.agent
  }

  // The guard reads the binding, so it's written before the call is answered.
  await writeBinding(ctx, run, agentId, task, worktree)
  const body: TaskBindBody = { task: task.id, worktree, ...(supersedes ? { supersedes } : {}) }
  const reply = await store(ctx, input, body, { task: task.id, worktree, ...(supersedes ? { supersedes } : {}) })
  return { reply, bound: true }
}

/** agents/<agent_id>.json: the task's owned paths and the worktree, the mod's half of the binding (hookfiles.AgentPolicy). */
async function writeBinding(ctx: RecordCtx, run: string, agentId: string, task: BindTask, worktree: BoundWorktree): Promise<void> {
  const policy: AgentPolicy = { v: 1, run, task: { id: task.id, owned: task.files }, worktree }
  await atomicWriteJson(ctx.p, agentPolicyPath(ctx.litterDir!, agentId), policy)
}

/** `design.feedback { run, feedback }`: your feedback on a delivered plan. */
const designFeedback: RecordHandler = async (ctx, input) =>
  needText(input, 'feedback', "the user's feedback, in their words") ?? store(ctx, input, bodyOf(input))

/** `wiki.write { content }`: WIKI.md is the mod's to write, so the wiki skill writes through here. */
const wikiWrite: RecordHandler = async (ctx, input) => {
  const missing = needText(input, 'content', "the whole of WIKI.md, as markdown")
  if (missing) return missing
  if (!ctx.litterDir) throw new Error('records/design: wiki.write reached its handler without a litter directory')
  const path = wikiPath(ctx.litterDir)
  await atomicWrite(ctx.p, path, input.content as string)
  return { ok: true, kind: 'wiki.write', path }
}

// proposal, verdict and probe are design/records.ts's (registry.ts points to them).
const HANDLERS: Partial<Record<KnownKind, RecordHandler>> = {
  finding: report,
  coverage: report,
  mechanism: report,
  reframe: report,
  'design.feedback': designFeedback,
  'task.bind': taskBind,
  'wiki.write': wikiWrite,
}

/** The kinds the record tool validates and stores itself. The mod's own kinds never come through the tool. */
export const recordGeneric: RecordHandler = async (ctx, input) => {
  const handler = HANDLERS[input.kind as KnownKind]
  if (!handler) return fail(`litter: '${input.kind}' is recorded by litter itself, never through this tool`, 'kind')
  return handler(ctx, input)
}
