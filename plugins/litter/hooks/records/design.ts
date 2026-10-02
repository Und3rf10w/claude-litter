// Record bodies for design runs, plans and the rest of the kinds the record
// tool validates itself (plan section 9, "The record kinds"). Owner: phase 1b,
// work package B. Design runs are phase 4: in phase 1 these kinds are
// validated as loosely as section 9 allows and stored, so the tool's error
// shape and bounds are exercised end to end.

import type { Author, Caller, RecordCtx, RecordError, RecordHandler, RecordInput, RecordReply } from './core'
import type { RunJson } from './run'
import { fail } from './core'
import { appendRecord, readLedger } from '../ledgercore'
import { agentPolicyPath, proposalPath, runDir, runJsonPath } from '../layout'
import { atomicWrite, atomicWriteJson, readJson, serial, sha256 } from '../fsx'
import { safeFileName, writeOut } from '../output'
import { agentInfo } from '../policy'

/** Every kind the record tool knows, in its canonical spelling. `kind` matches case-insensitively. */
export const KNOWN_KINDS = [
  // design
  'finding', 'coverage', 'mechanism', 'probe', 'reframe', 'proposal', 'verdict', 'design.feedback',
  // execute
  'verify', 'land.intent', 'land', 'land.abandoned', 'land.blocked', 'rule.propose',
  // fanout (phase 2)
  'task.bind',
  // the run lock
  'lock.recovered', 'lock.forced',
  // launchers and the mod's own
  'run.start', 'run.launch', 'run.resume', 'run.stopping', 'run.end',
  'worktree.intent', 'worktree.create', 'worktree.setup_failed',
  'plan.write', 'gate.amend', 'wiki.write',
  // read-only
  'run.find',
] as const

export type KnownKind = (typeof KNOWN_KINDS)[number]

/** Kinds only the mod writes; a call from an agent or the launcher is refused (run.end has the launcher fallback). */
export const MOD_ONLY_KINDS: readonly KnownKind[] = [
  'land.intent', 'land.abandoned', 'land.blocked', 'run.launch', 'run.resume', 'run.stopping',
  'lock.recovered', 'lock.forced', 'worktree.intent', 'worktree.create', 'worktree.setup_failed',
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
  'plan.write': launcherKind,
  'gate.amend': launcherKind,
  'wiki.write': { by: 'launcher', run: 'none' },
  'run.find': { by: 'any', run: 'none' },
}

/** The `by` of a record a caller made through the tool. */
export const authorOf = (caller: Caller): Author =>
  caller.agentId === null ? { source: 'launcher' } : { source: 'agent', agentId: caller.agentId, agentType: caller.agentType }

/** `<litterDir>/WIKI.md` (section 10, "On disk"). layout.ts has no entry for it yet. */
export const wikiPath = (litterDir: string) => `${litterDir}/WIKI.md`

const RULE_MAX_BYTES = 8 * 1024
const GATE_ID = /^G[0-9]+$/
const VERSION = /^v[1-9][0-9]*$/
const VERDICTS = ['PASS', 'CONDITIONAL', 'FAIL'] as const
const OVERALLS = ['APPROVED', 'HOLDING'] as const

const bytes = (text: string) => new TextEncoder().encode(text).length

/** A required non-empty string field, or the error naming it. */
function needText(input: RecordInput, field: string, what: string): RecordError | null {
  const v = input[field]
  return typeof v === 'string' && v.trim() !== '' ? null : fail(`litter: '${field}' is required: ${what}`, field)
}

/** The input without the envelope's own fields, as the record's body. */
function bodyOf(input: RecordInput): Record<string, unknown> {
  const { kind: _kind, run: _run, ...rest } = input
  return rest
}

type Scoped = { run: string; runDir: string }

/** The run the record tool resolved. A handler reached without one is a wiring bug, so it throws. */
function scoped(ctx: RecordCtx, input: RecordInput): Scoped {
  if (!ctx.litterDir || typeof input.run !== 'string') throw new Error(`records/design: '${input.kind}' reached its handler without a run`)
  return { run: input.run, runDir: runDir(ctx.litterDir, input.run) }
}

async function store(ctx: RecordCtx, input: RecordInput, body: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<RecordReply> {
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

/**
 * `rule.propose`. A proposal goes to the rules ledger (section 16.9), which
 * comes with rules in phase 3; until then one that names its run is stored in
 * that run's ledger, and one without a run is refused.
 */
const ruleProposal: RecordHandler = async (ctx, input) => {
  const missing = needText(input, 'rule', 'the rule as a person could accept it: the situation it applies to, then what to do or never do')
  if (missing) return missing
  if (bytes(input.rule as string) > RULE_MAX_BYTES) return fail(`litter: 'rule' is over ${RULE_MAX_BYTES} bytes; a rule goes into prompts, so cut it down`, 'rule')
  if (input.source !== undefined && typeof input.source !== 'string') return fail("litter: 'source' must be a string, e.g. user or critic", 'source')
  if (input.edits !== undefined && (typeof input.edits !== 'string' || !/^[A-Za-z0-9._-]+@[1-9][0-9]*$/.test(input.edits))) {
    return fail("litter: 'edits' names the rule an edit is for, as <id>@<version>", 'edits')
  }
  if (typeof input.run !== 'string') {
    return fail("litter: a rule.propose without a run goes to the rules ledger, which comes with rules (phase 3); name the run it came from in 'run'", 'run')
  }
  const source = input.source ?? (ctx.caller.agentId === null ? 'user' : 'agent')
  return store(ctx, input, { ...bodyOf(input), source })
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

/**
 * `task.bind`: binds the calling writer to the task whose token it presents,
 * and its worktree (its SubagentStart cwd) to that task. Each task binds to
 * one worktree and each worktree to one task; a second agent with the same
 * token is accepted only from the same worktree, the restarted writer. The
 * token itself is never stored.
 */
const taskBind: RecordHandler = async (ctx, input) => {
  const missing = needText(input, 'token', 'the bind value from your <task>, exactly')
  if (missing) return missing
  const { run, runDir: dir } = scoped(ctx, input)
  const agentId = ctx.caller.agentId
  if (agentId === null) throw new Error('records/design: task.bind reached its handler from the main thread')
  const task = (await bindTasks(ctx, dir)).find(t => t.bind === input.token)
  if (!task) return fail("litter: no task of this run has that bind value; copy it exactly from the bind attribute of your <task>", 'token')
  const me = await agentInfo(ctx.p, agentId)
  if (!me) return fail(`litter: agent ${agentId} has no recorded worktree yet, so it can't bind; call task.bind again`)
  return serial(`bind:${dir}`, async () => {
    const { records } = await readLedger(ctx.p, dir, run)
    for (const rec of records) {
      if (rec.kind !== 'task.bind' || rec.by.source !== 'agent') continue
      const other = rec.by.agentId
      const boundTask = (rec.body as { task?: string }).task
      const otherCwd = other === agentId ? me.cwd : (await agentInfo(ctx.p, other))?.cwd
      if (other === agentId && boundTask !== task.id) {
        return fail(`litter: you're already bound to task ${boundTask}; a writer binds to one task`, 'token')
      }
      if (boundTask === task.id && otherCwd !== me.cwd) {
        return fail(`litter: task ${task.id} is already bound to another writer's worktree; only that worktree can bind it again`, 'token')
      }
      if (boundTask !== task.id && otherCwd === me.cwd) {
        return fail(`litter: this worktree is already bound to task ${boundTask}; each worktree binds to one task`, 'token')
      }
    }
    if (!safeFileName(agentId)) throw new Error(`records/design: agent id '${agentId}' can't name a binding file`)
    // The guard reads the binding, so it's written before the call is answered.
    await atomicWriteJson(ctx.p, agentPolicyPath(ctx.litterDir!, agentId), { v: 1, run, task: { id: task.id, owned: task.files } })
    return store(ctx, input, { task: task.id }, { task: task.id })
  })
}

/** `plan.write { run, gates }`: the approved planner gates. Rendering them into plan.md comes with goal mode (phase 3). */
const planWrite: RecordHandler = async (ctx, input) => {
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

/** `gate.amend { run, gate, before, after, reason }`. Writing the amended plan.md comes with amend (phase 3). */
const gateAmend: RecordHandler = async (ctx, input) => {
  if (typeof input.gate !== 'string' || !GATE_ID.test(input.gate)) return fail("litter: 'gate' must be the gate id being amended, like G2", 'gate')
  if (input.before !== undefined && typeof input.before !== 'string') return fail("litter: 'before' must be the gate's text before the amendment", 'before')
  return (
    needText(input, 'after', "the amended gate's text, in the plan's gate format") ??
    needText(input, 'reason', 'why the gate is amended') ??
    store(ctx, input, bodyOf(input))
  )
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
  'rule.propose': ruleProposal,
  'task.bind': taskBind,
  'plan.write': planWrite,
  'gate.amend': gateAmend,
  'wiki.write': wikiWrite,
}

/** The kinds the record tool validates and stores itself. The mod's own kinds never come through the tool. */
export const recordGeneric: RecordHandler = async (ctx, input) => {
  const handler = HANDLERS[input.kind as KnownKind]
  if (!handler) return fail(`litter: '${input.kind}' is recorded by litter itself, never through this tool`, 'kind')
  return handler(ctx, input)
}
