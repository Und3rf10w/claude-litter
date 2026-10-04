// Record bodies for design runs, plans and the rest of the kinds the record
// tool validates itself (plan section 9, "The record kinds"). Owner: phase 1b,
// work package B. Design runs are phase 4: in phase 1 these kinds are
// validated as loosely as section 9 allows and stored, so the tool's error
// shape and bounds are exercised end to end.

import type { Author, Caller, RecordCtx, RecordError, RecordHandler, RecordInput, RecordReply, StoredRecord } from './core'
import type { RunJson } from './run'
import type { BoundWorktree, TaskBindBody, WorktreeCreateBody } from './fanout'
import type { AgentPolicy } from '../hookfiles'
import { fail } from './core'
import { appendRecord, readLedger } from '../ledgercore'
import { agentPolicyPath, integrationName, outPath, proposalPath, runDir, runJsonPath, wikiPath } from '../layout'
import { atomicWrite, atomicWriteJson, readJson, remove, serial, sha256 } from '../fsx'
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
}

/** The `by` of a record a caller made through the tool. */
export const authorOf = (caller: Caller): Author =>
  caller.agentId === null ? { source: 'launcher' } : { source: 'agent', agentId: caller.agentId, agentType: caller.agentType }


const VERSION = /^v[1-9][0-9]*$/
const VERDICTS = ['PASS', 'CONDITIONAL', 'FAIL'] as const
const OVERALLS = ['APPROVED', 'HOLDING'] as const

// needText, bodyOf and store are shared with the handlers phase 3 moved out
// (plan.ts's plan.write and gate.amend, rules/records.ts's rule.propose).

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

type Scoped = { run: string; runDir: string }

/** The run the record tool resolved. A handler reached without one is a wiring bug, so it throws. */
function scoped(ctx: RecordCtx, input: RecordInput): Scoped {
  if (!ctx.litterDir || typeof input.run !== 'string') throw new Error(`records/design: '${input.kind}' reached its handler without a run`)
  return { run: input.run, runDir: runDir(ctx.litterDir, input.run) }
}

/** Appends `body` to the resolved run's ledger, by the caller, and answers with its seq and `extra`. */
export async function store(ctx: RecordCtx, input: RecordInput, body: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<RecordReply> {
  const { run, runDir: dir } = scoped(ctx, input)
  const rec = await appendRecord(ctx.p, dir, { run, kind: input.kind, by: authorOf(ctx.caller), body })
  return { ok: true, kind: rec.kind, run, seq: rec.seq, ...extra }
}

// The investigators' reports (section 6): one markdown report each.
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

/**
 * `proposal`: the mod assigns the next version, stores the text as
 * `proposals/vN.md` and its sha256 in the record, and writes the author's
 * observed `proposal` field for output.sh. Rendering `gates` into plan
 * sections, checked by execute's parser, comes with design runs (phase 4), so
 * a proposal with gates is refused until then rather than stored unrendered.
 */
const proposal: RecordHandler = async (ctx, input) => {
  const missing = needText(input, 'text', 'the full proposal text, as markdown')
  if (missing) return missing
  if (input.gates !== undefined && !(Array.isArray(input.gates) && input.gates.length === 0)) {
    return fail(
      "litter: a proposal's 'gates' are rendered into the plan's gate sections from phase 4 (design runs); record the text without them for now",
      'gates',
    )
  }
  if (input.delta !== undefined && typeof input.delta !== 'string' && !Array.isArray(input.delta)) {
    return fail("litter: 'delta' must be a list of changes from the previous version, or one text", 'delta')
  }
  const { run, runDir: dir } = scoped(ctx, input)
  const text = input.text as string
  // One version per call: the count and the write must not interleave with another proposal of this run.
  return serial(`proposal:${dir}`, async () => {
    const { records } = await readLedger(ctx.p, dir, run)
    const n = records.filter(r => r.kind === 'proposal').length + 1
    const version = `v${n}`
    const sha = await sha256(text)
    await atomicWrite(ctx.p, proposalPath(dir, version), text)
    const reply = await store(ctx, input, { ...bodyOf(input), version, sha256: sha }, { version, sha256: sha })
    const warnings: string[] = []
    const bare = bareBacktickPaths(text)
    if (bare.length > 0) {
      const shown = bare.slice(0, 10).join(', ') + (bare.length > 10 ? `, and ${bare.length - 10} more` : '')
      warnings.push(
        `litter: bare backticked paths in the prose (${shown}); write them as [label](path) links so they navigate. ${version} was recorded as it is.`,
      )
    }
    if (ctx.caller.agentId !== null) {
      try {
        await writeOut(ctx.p, ctx.litterDir!, {
          v: 1,
          agent_id: ctx.caller.agentId,
          for: { version },
          fields: { version, proposal: text },
        })
      } catch (err) {
        ctx.p.log(`proposal ${run} ${version}: out file not written: ${err instanceof Error ? err.message : String(err)}`)
        warnings.push(`litter: ${version} is recorded, but the observed proposal field couldn't be written; return your result anyway`)
      }
    }
    return warnings.length > 0 ? { ...reply, warnings } : reply
  })
}

/** The bar's ids (criteria and bans), fixed at run.start in run.json's args; null when the run has no bar. */
async function barIds(ctx: RecordCtx, dir: string): Promise<string[] | null> {
  const json = await readJson<RunJson>(ctx.p, runJsonPath(dir))
  const bar = json?.args?.bar
  if (!Array.isArray(bar)) return null
  const ids = bar.map(c => (c && typeof c === 'object' ? (c as { id?: unknown }).id : undefined)).filter((id): id is string => typeof id === 'string')
  return ids.length > 0 ? ids : null
}

/**
 * `verdict`, the design critic's: it must name the run's latest proposal
 * version (the bar is fixed at run.start), cover the bar exactly once, and
 * agree with its own criteria. The mod adds the judged version's sha256.
 */
const verdict: RecordHandler = async (ctx, input) => {
  const { run, runDir: dir } = scoped(ctx, input)
  const { records } = await readLedger(ctx.p, dir, run)
  const latest = records.filter(r => r.kind === 'proposal').at(-1)?.body as { version?: string; sha256?: string } | undefined
  if (!latest?.version) return fail("litter: no proposal is recorded in this run yet, so there's no version to judge", 'version')
  if (input.version !== latest.version) {
    return fail(`litter: 'version' must name the run's latest proposal, ${latest.version}`, 'version', [latest.version])
  }
  const bar = await barIds(ctx, dir)
  const criteria = input.criteria
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return fail("litter: 'criteria' is required: one { id, verdict } per bar id, with verdict PASS, CONDITIONAL or FAIL", 'criteria', bar ?? undefined)
  }
  const ids: string[] = []
  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i] as { id?: unknown; verdict?: unknown } | null
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || c.id === '') {
      return fail(`litter: 'criteria[${i}].id' is required: the bar id this verdict is for`, `criteria[${i}].id`, bar ?? undefined)
    }
    if (typeof c.verdict !== 'string' || !(VERDICTS as readonly string[]).includes(c.verdict)) {
      return fail(`litter: 'criteria[${i}].verdict' must be one of the allowed values`, `criteria[${i}].verdict`, VERDICTS)
    }
    ids.push(c.id)
  }
  if (typeof input.overall !== 'string' || !(OVERALLS as readonly string[]).includes(input.overall)) {
    return fail("litter: 'overall' must be one of the allowed values", 'overall', OVERALLS)
  }
  if (bar) {
    const missing = bar.filter(id => !ids.includes(id))
    const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
    const unknown = [...new Set(ids.filter(id => !bar.includes(id)))]
    if (missing.length + repeated.length + unknown.length > 0) {
      const parts = [
        missing.length ? `missing ${missing.join(', ')}` : '',
        repeated.length ? `repeated ${repeated.join(', ')}` : '',
        unknown.length ? `not in the bar ${unknown.join(', ')}` : '',
      ].filter(Boolean)
      return fail(`litter: 'criteria' must cover the bar exactly once: ${parts.join('; ')}`, 'criteria', bar)
    }
  }
  const allPass = criteria.every(c => (c as { verdict: string }).verdict === 'PASS')
  if (input.overall === 'APPROVED' && !allPass) {
    return fail("litter: 'overall' is APPROVED only when every criterion is PASS", 'overall', ['HOLDING'])
  }
  return store(ctx, input, { ...bodyOf(input), sha256: latest.sha256 ?? null })
}

type BindTask = { id: string; bind: string; files: string[] }

/** The writing tasks run.start put in run.json's args, each with its `bind` token (section 7, fanout.js step 2). */
async function bindTasks(ctx: RecordCtx, dir: string): Promise<BindTask[]> {
  const json = await readJson<RunJson>(ctx.p, runJsonPath(dir))
  const tasks = json?.args?.tasks
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
  const { records } = await readLedger(ctx.p, dir, run)
  const bindings = bindingsOf(records)
  const mine = bindings.filter(b => b.agent === agentId).at(-1)
  const refuse = (error: string, field?: string): BindOutcome => ({ reply: fail(error, field), bound: mine !== undefined })

  const missing = needText(input, 'token', 'the bind value from your <task>, exactly')
  if (missing) return { reply: missing, bound: mine !== undefined }
  const task = (await bindTasks(ctx, dir)).find(t => t.bind === input.token)
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

const HANDLERS: Partial<Record<KnownKind, RecordHandler>> = {
  finding: report,
  coverage: report,
  mechanism: report,
  probe: report,
  reframe: report,
  proposal,
  verdict,
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
