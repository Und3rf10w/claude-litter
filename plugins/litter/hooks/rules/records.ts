// The rules' record kinds through the tool (plan 16.9): rule.propose,
// rule.open, rule.import and the read-only rule.find. rule.accept,
// rule.dismiss and rule.retire never come through here: ledger.ts refuses
// them whatever the caller. Owner: phase 3, package AD.
//
// Each writes only to the rules ledgers (decision 17), never a rule file:
// a proposal is never delivered as accepted (16.4), and only the rules
// pane's buttons reach store.ts's steps that are yours alone.

import type { Ports } from '../ports'
import type { RecordCtx, RecordHandler, RecordInput, RecordReply, StoredRecord } from '../records/core'
import type { RunJson } from '../records/run'
import type {
  LoadedRule,
  ProposalRef,
  RuleImportBody,
  RuleLedgerStore,
  RuleOpenBody,
  RuleProposeBody,
  RuleScope,
  RuleStatus,
  RuleType,
} from '../records/rules'
import type { FoundRun } from '../litterdir'
import { fail } from '../records/core'
import { RULE_SCOPES, RULE_STATUSES, RULE_TYPES } from '../records/rules'
import { authorOf, needText } from '../records/design'
import { LedgerTampered } from '../ledgercore'
import { localRulesDir, projectRulesDir, ruleHistoryDir, runJsonPath, userRulesDir } from '../layout'
import { readJson } from '../fsx'
import { primaryOf } from '../lifecycle'
import { recordRunFind } from '../litterdir'
import { openSection } from '../ui/hub'
import { findApplicable } from './select'
import { matches } from './match'
import { readDeepwork } from './import'
import { appendRuleRecord, readRuleLedger } from './ledger'
import { bytes, foldText, parseRule, renderRule, RULE_ID, RULE_MAX_BYTES } from './format'
import { foldedSha, loadRules, narrowPaths, proposalsOf, proposalText } from './store'

// The other packages' functions reached from here (the `litter` pane's
// opener, AE's selection and matcher), through one table so tier 2 can stand
// in for them (COMMON, "Another package's module").
export const deps = {
  openSection: (...a: Parameters<typeof openSection>) => openSection(...a),
  findApplicable: (...a: Parameters<typeof findApplicable>) => findApplicable(...a),
  matches: (pattern: string, path: string) => matches(pattern, path),
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/
const EDITS = /^([UPL]-[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?)@([1-9][0-9]*)$/
const OPEN_IT = "litter's Rules section didn't open here; tell the user to run /litter rules"
const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

/** The rules ledger's own refusals in the tool's error shape; anything else throws, so the hook's catch denies. */
async function guarded(work: () => Promise<RecordReply>): Promise<RecordReply> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof LedgerTampered) return fail(`litter: the rules ledger is tampered at record ${err.seq} (${err.reason}); nothing more is recorded in it`)
    throw err
  }
}

/** The dispatcher resolves litterDir before any handler; one reached without it is a wiring bug. */
function litterDirOf(ctx: RecordCtx, input: RecordInput): string {
  if (!ctx.litterDir) throw new Error(`rules/records: '${input.kind}' reached its handler without a litter directory`)
  return ctx.litterDir
}

const validRef = (r: unknown): r is ProposalRef =>
  typeof r === 'object' && r !== null && ((r as ProposalRef).store === 'repo' || (r as ProposalRef).store === 'user') && Number.isInteger((r as ProposalRef).seq) && (r as ProposalRef).seq >= 1

/**
 * The Rules section on `focus`, through the `litter` pane's one opener
 * (ui/hub.ts). The model asked, not the person, so it doesn't ask for the
 * keyboard. A refusal or a throw: the reply says to run /litter rules.
 */
async function openPane(p: Ports, focus: RuleOpenBody): Promise<boolean> {
  try {
    return (await deps.openSection(p, 'rules', focus)).placed === true
  } catch (err) {
    p.log(`rules: the Rules section didn't open: ${errText(err)}`)
    return false
  }
}

// ---------------------------------------------------------------------------
// rule.propose

/**
 * `rule.propose { rule, source?, scope?, type?, paths?, when?, slug?, edits?, run? }`:
 * a `rule.propose` in the repository's rules ledger, with or without a run
 * (16.9). `rule` is a whole rule file (it starts with `---`) or one plain
 * text. A proposal identical to a rule in force is refused with that rule's
 * id; one whose text was dismissed is recorded, and reads as dismissed.
 */
export const recordRuleProposal: RecordHandler = async (ctx, input) => {
  const missing = needText(input, 'rule', 'the rule as a person could accept it: the situation it applies to, then what to do or never do')
  if (missing) return missing
  const rule = input.rule as string
  if (bytes(rule) > RULE_MAX_BYTES) return fail(`litter: 'rule' is over ${RULE_MAX_BYTES} bytes; a rule goes into prompts, so cut it down`, 'rule')
  if (input.source !== undefined && (typeof input.source !== 'string' || input.source.trim() === '')) return fail("litter: 'source' must be a string, e.g. user or critic", 'source')
  if (input.edits !== undefined && (typeof input.edits !== 'string' || !EDITS.test(input.edits))) {
    return fail("litter: 'edits' names the rule an edit is for, as <id>@<version>", 'edits')
  }
  if (input.scope !== undefined && !(RULE_SCOPES as readonly unknown[]).includes(input.scope)) {
    return fail("litter: 'scope' is user, project or local; leave it out and the user chooses it at Accept", 'scope', RULE_SCOPES)
  }
  if (input.type !== undefined && !(RULE_TYPES as readonly unknown[]).includes(input.type)) return fail("litter: 'type' is rule (what to do) or ban (what never to do)", 'type', RULE_TYPES)
  let paths: string[] | undefined
  if (input.paths !== undefined) {
    if (!Array.isArray(input.paths)) return fail("litter: 'paths' is a list of path patterns relative to the repository, such as src/api/**", 'paths')
    const n = narrowPaths(input.paths as string[])
    if (!n.ok) return fail(`litter: 'paths': ${n.reason}`, 'paths')
    paths = n.paths
  }
  if (input.when !== undefined && typeof input.when !== 'string') return fail("litter: 'when' is one sentence: the situation the rule applies to", 'when')
  if (input.slug !== undefined && (typeof input.slug !== 'string' || !SLUG.test(input.slug))) {
    return fail("litter: 'slug' is lowercase letters, digits and dashes, at most 40, such as worktree-cleanup", 'slug')
  }
  const litterDir = litterDirOf(ctx, input)
  const scope = input.scope as RuleScope | undefined
  if (scope !== undefined && scope !== 'user' && primaryOf(litterDir) === null) {
    return fail("litter: a bare repository has no project or local scope; use user, or leave 'scope' out", 'scope', ['user'])
  }
  let doc: RuleProposeBody['doc']
  if (rule.startsWith('---')) {
    const parsed = parseRule(rule)
    if (!parsed.ok) return fail(`litter: 'rule' is a rule file that doesn't parse: ${parsed.error}`, 'rule')
    doc = parsed.doc
  }
  const text = doc ? doc.body.rule : rule
  const { rules } = await loadRules(ctx.p, litterDir)
  if (typeof input.edits === 'string') {
    const [, id, v] = EDITS.exec(input.edits)!
    const target = rules.find(r => r.doc.id === id && r.delivered)
    if (!target) return fail(`litter: ${id}, named in 'edits', isn't a rule in force; rule.find with status ['accepted'] lists them`, 'edits')
    const now = target.delivered!.version
    if (now !== Number(v)) return fail(`litter: ${id} is at version ${now}, so an edit of it is edits: '${id}@${now}'`, 'edits')
  } else {
    const same = rules.find(r => r.delivered && foldText(r.delivered.body.rule) === foldText(text))
    if (same) {
      const ref = `${same.delivered!.id}@${same.delivered!.version}`
      return fail(`litter: accepted rule ${ref} already says this; to change that rule, propose an edit of it with edits: '${ref}'`, 'rule')
    }
  }

  const body: RuleProposeBody = { rule, source: typeof input.source === 'string' ? input.source : ctx.caller.agentId === null ? 'user' : 'agent' }
  if (doc) body.doc = doc
  if (scope !== undefined) body.scope = scope
  if (typeof input.edits === 'string') body.edits = input.edits
  if (input.type !== undefined) body.type = input.type as RuleType
  if (paths !== undefined) body.paths = paths
  if (typeof input.when === 'string') body.when = input.when
  if (typeof input.slug === 'string') body.slug = input.slug
  if (typeof input.run === 'string') body.run = input.run
  return guarded(async () => {
    const folded = await foldedSha(text)
    const { records } = await readRuleLedger(ctx.p, litterDir, 'repo')
    const dismissed = records.some(r => r.kind === 'rule.dismiss' && r.body.folded === folded)
    const rec = await appendRuleRecord(ctx.p, litterDir, 'repo', 'rule.propose', authorOf(ctx.caller), body)
    const proposal: ProposalRef = { store: 'repo', seq: rec.seq }
    return {
      ok: true,
      kind: 'rule.propose',
      seq: rec.seq,
      proposal,
      status: dismissed ? 'dismissed' : 'proposed',
      ...(body.run ? { run: body.run } : {}),
      ...(dismissed ? { note: "the user dismissed a proposal with this text before, so it isn't offered again" } : {}),
    }
  })
}

// ---------------------------------------------------------------------------
// rule.open

/**
 * `rule.open { id }` or `rule.open { proposal: { store, seq } }`: records the
 * open in the rules ledger, then shows it in the `litter` pane's Rules
 * section (openSection). A pane that doesn't open answers "run /litter rules".
 */
export const recordRuleOpen: RecordHandler = async (ctx, input) => {
  const litterDir = litterDirOf(ctx, input)
  if ((input.id === undefined) === (input.proposal === undefined)) {
    return fail("litter: rule.open takes one of 'id', a rule id such as P-keep-tests-near, or 'proposal', the { store, seq } rule.propose answered", 'id')
  }
  let body: RuleOpenBody
  let store: RuleLedgerStore
  if (input.id !== undefined) {
    const id = input.id
    if (typeof id !== 'string' || !RULE_ID.test(id)) return fail("litter: 'id' is a rule id: U-, P- or L-, then its slug", 'id')
    const { rules } = await loadRules(ctx.p, litterDir)
    if (!rules.some(r => r.doc.id === id)) return fail(`litter: there's no rule ${id}; rule.find with status ['accepted', 'proposed'] lists them`, 'id')
    body = { id }
    store = id.startsWith('U-') ? 'user' : 'repo'
  } else {
    const ref = input.proposal
    if (!validRef(ref)) return fail("litter: 'proposal' is { store: 'repo' or 'user', seq: a whole number }, as rule.propose answered it", 'proposal')
    let records: StoredRecord[]
    try {
      records = (await readRuleLedger(ctx.p, litterDir, ref.store)).records
    } catch (err) {
      return fail(`litter: the ${ref.store} rules ledger can't be read: ${errText(err)}`, 'proposal')
    }
    if (!records.some(r => r.seq === ref.seq && r.kind === 'rule.propose')) return fail(`litter: there's no proposal ${ref.store}:${ref.seq}`, 'proposal')
    body = { proposal: { store: ref.store, seq: ref.seq } }
    store = ref.store
  }
  return guarded(async () => {
    const rec = await appendRuleRecord(ctx.p, litterDir, store, 'rule.open', authorOf(ctx.caller), body)
    const opened = await openPane(ctx.p, body)
    return { ok: true, kind: 'rule.open', seq: rec.seq, opened, ...(opened ? {} : { note: OPEN_IT }) }
  })
}

// ---------------------------------------------------------------------------
// rule.import

/** The Why an imported guardrail gets (16.8), its goal cut to a line. */
const importWhy = (id: string, goal: string, date: string | null, source: string) =>
  `Imported from deepwork instance ${id} (${cut(goal.replace(/\s+/g, ' ').trim() || 'no goal', 160)}, ${date ?? 'no date'}); source ${source}`

/**
 * `rule.import { from: 'deepwork' }`, from the main thread: one rule.propose
 * per new guardrail (import.ts), a rule.import batch, then the pane on it.
 * Each is a project ban with no paths. The same folded text is offered once;
 * one that matches a rule in force, a pending proposal or a dismissed one
 * is skipped and counted. Nothing is accepted.
 */
export const recordRuleImport: RecordHandler = async (ctx, input) => {
  if (input.from !== 'deepwork') return fail("litter: 'from' is where the guardrails come from, and litter imports from deepwork", 'from', ['deepwork'])
  const litterDir = litterDirOf(ctx, input)
  const primary = primaryOf(litterDir)
  if (!primary) return fail('litter: a bare repository has no project scope, so there is nothing to import deepwork guardrails into')
  const { tampered } = await readRuleLedger(ctx.p, litterDir, 'repo')
  if (tampered) return fail(`litter: the rules ledger is tampered at record ${tampered.seq} (${tampered.reason}); nothing more is recorded in it`)
  const batch = await readDeepwork(ctx.p, primary)
  const { rules } = await loadRules(ctx.p, litterDir)
  // What's already there, by folded text.
  const known = new Map<string, 'accepted' | 'pending' | 'dismissed'>()
  for (const r of rules) if (r.delivered) known.set(await foldedSha(r.delivered.body.rule), 'accepted')
  for (const v of await proposalsOf(ctx.p, litterDir, {})) {
    const k = await foldedSha(proposalText(v.body))
    if (v.status === 'proposed' && !known.has(k)) known.set(k, 'pending')
    else if (v.status === 'dismissed') known.set(k, 'dismissed')
  }
  const skipped = { accepted: 0, pending: 0, dismissed: 0, repeated: 0 }
  const problems = [...batch.problems]
  const instances = new Map(batch.instances.map(i => [i.id, i]))
  // Live instances first, so a guardrail that's in both is offered as a live one.
  const ordered = [...batch.guardrails.filter(g => !g.archived), ...batch.guardrails.filter(g => g.archived)]
  const seen = new Set<string>()
  return guarded(async () => {
    const proposals: ProposalRef[] = []
    const preselected: ProposalRef[] = []
    let live = 0
    let archived = 0
    for (const g of ordered) {
      const k = await foldedSha(g.text)
      if (seen.has(k)) {
        skipped.repeated++
        continue
      }
      seen.add(k)
      const was = known.get(k)
      if (was) {
        skipped[was]++
        continue
      }
      const text = g.text.trim()
      if (bytes(text) > RULE_MAX_BYTES) {
        problems.push(`a guardrail of instance ${g.instance} is over ${RULE_MAX_BYTES} bytes, too long to be a rule, so it isn't offered`)
        continue
      }
      const inst = instances.get(g.instance)!
      const why = importWhy(inst.id, inst.goal, inst.date, g.source)
      const body: RuleProposeBody = {
        rule: text,
        doc: {
          id: '',
          version: 0,
          status: 'proposed',
          type: 'ban',
          applies: { paths: [], when: '' },
          export: true,
          extra: [],
          body: { rule: text, why, exceptions: [], howToCheck: [] },
        },
        source: 'import',
        scope: 'project',
        type: 'ban',
        paths: [],
        import: { instance: g.instance, source: g.source, archived: g.archived, ...(g.incident_ref !== null ? { incident_ref: g.incident_ref } : {}) },
      }
      const rec = await appendRuleRecord(ctx.p, litterDir, 'repo', 'rule.propose', authorOf(ctx.caller), body)
      const ref: ProposalRef = { store: 'repo', seq: rec.seq }
      proposals.push(ref)
      if (g.archived) archived++
      else live++
      // You set user and flag guardrails yourself; from a live instance only (16.8; decision 3).
      if (!g.archived && (g.source === 'user' || g.source === 'flag')) preselected.push(ref)
    }
    const counts = { proposals: proposals.length, live, archived, preselected: preselected.length, skipped, instances: batch.instances.length, ...(problems.length ? { problems } : {}) }
    if (proposals.length === 0) {
      return { ok: true, kind: 'rule.import', ...counts, opened: false, note: batch.instances.length === 0 ? `there are no deepwork instances in ${primary}/.claude/deepwork` : 'no new guardrails to propose' }
    }
    const importBody: RuleImportBody = { from: 'deepwork', instances: batch.instances, proposals, preselected }
    const rec = await appendRuleRecord(ctx.p, litterDir, 'repo', 'rule.import', authorOf(ctx.caller), importBody)
    // The pane opens on the batch: its rule.import record (types/index.d.ts, RulesBatch.seq).
    const opened = await openPane(ctx.p, { proposal: { store: 'repo', seq: rec.seq } })
    return { ok: true, kind: 'rule.import', seq: rec.seq, ...counts, opened, ...(opened ? {} : { note: OPEN_IT }) }
  })
}

// ---------------------------------------------------------------------------
// rule.find, read-only

type RuleRow = {
  id: string
  version: number
  scope: RuleScope
  type: string
  when: string
  paths: string[]
  standing: string
  why?: string
  path: string
  /** The version in force, `id@v`, or null. */
  delivered: string | null
  overrides?: string
}

function rowOf(r: LoadedRule): RuleRow {
  const row: RuleRow = {
    id: r.doc.id,
    version: r.doc.version,
    scope: r.scope,
    type: r.doc.type,
    when: r.doc.applies.when,
    paths: r.doc.applies.paths,
    standing: r.standing,
    path: r.path,
    delivered: r.delivered ? `${r.delivered.id}@${r.delivered.version}` : null,
  }
  if (r.why) row.why = r.why
  if (r.delivered?.overrides) row.overrides = r.delivered.overrides
  return row
}

const proposalRow = (v: { ref: ProposalRef; body: RuleProposeBody; status: RuleStatus }) => {
  const b = v.body
  const out: Record<string, unknown> = { proposal: v.ref, status: v.status, source: b.source, rule: cut(proposalText(b), 600) }
  for (const k of ['scope', 'type', 'paths', 'edits', 'run', 'gate', 'swarm', 'import'] as const) if (b[k] !== undefined) out[k] = b[k]
  return out
}

/** The literal segments before the first with a glob character, joined: what two patterns are compared by. */
function staticPrefix(pattern: string): string {
  const segs = pattern.replace(/^\/+/, '').split('/')
  const out: string[] = []
  for (const s of segs) {
    if (/[*?[{]/.test(s) || s === '') break
    out.push(s)
  }
  return out.join('/')
}

const under = (a: string, b: string) => b === '' || a === b || a.startsWith(`${b}/`)

function matchesSafely(pattern: string, path: string): boolean {
  try {
    return path !== '' && deps.matches(pattern, path)
  } catch {
    return false
  }
}

/** Two pattern lists that could match one file: static prefixes that nest, or AE's matches either way on them. */
function overlap(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      const sx = staticPrefix(x)
      const sy = staticPrefix(y)
      if (under(sx, sy) || under(sy, sx) || matchesSafely(y, sx) || matchesSafely(x, sy)) return true
    }
  }
  return false
}

/** The runs whose run.json lists a version of `id` (decision 19), through run.find's listing. */
async function runsUsing(ctx: RecordCtx, id: string): Promise<{ run: string; version: number; workflow: string; status: string }[]> {
  const found = await recordRunFind(ctx, { kind: 'run.find' })
  if (!found.ok || !Array.isArray(found.runs)) return []
  const out: { run: string; version: number; workflow: string; status: string }[] = []
  for (const r of found.runs as FoundRun[]) {
    const json = await readJson<RunJson>(ctx.p, runJsonPath(r.runDir)).catch(() => undefined)
    for (const ref of Array.isArray(json?.rules) ? json!.rules : []) {
      if (ref && ref.id === id && typeof ref.version === 'number') out.push({ run: r.run, version: ref.version, workflow: r.workflow, status: r.status })
    }
  }
  return out
}

async function findId(ctx: RecordCtx, litterDir: string, id: unknown): Promise<RecordReply> {
  if (typeof id !== 'string' || !RULE_ID.test(id)) return fail("litter: 'id' is a rule id: U-, P- or L-, then its slug", 'id')
  const { rules, problems } = await loadRules(ctx.p, litterDir)
  const here = rules.filter(r => r.doc.id === id)
  const versions = new Map<number, { version: number; from: string[]; path?: string; at?: number }>()
  const add = (version: number, from: string, extra: { path?: string; at?: number } = {}) => {
    const v = versions.get(version) ?? { version, from: [] }
    if (!v.from.includes(from)) v.from.push(from)
    Object.assign(v, extra)
    versions.set(version, v)
  }
  for (const r of here) {
    add(r.doc.version, r.standing === 'unverified' ? 'the file, unverified' : 'the file', { path: r.path })
    if (r.delivered && r.delivered !== r.doc) add(r.delivered.version, 'HEAD')
  }
  // `.history`, in the id's own scope's folder.
  let dir: string | null = null
  const primary = primaryOf(litterDir)
  if (id.startsWith('U-')) dir = await ctx.p.configDir().then(userRulesDir, () => null)
  else if (primary) dir = id.startsWith('P-') ? projectRulesDir(primary) : localRulesDir(primary)
  if (dir) {
    const hist = ruleHistoryDir(dir)
    if (await ctx.p.fs.exists(hist)) {
      for (const e of await ctx.p.fs.list(hist)) {
        const m = /^(.+)@([1-9][0-9]*)\.md$/.exec(e.name)
        if (m && m[1] === id) add(Number(m[2]), '.history', { path: `${hist}/${e.name}` })
      }
    }
  }
  // The ledger's steps for it.
  const retired: { version: number; at: number }[] = []
  const store: RuleLedgerStore = id.startsWith('U-') ? 'user' : 'repo'
  const ledger = await readRuleLedger(ctx.p, litterDir, store).catch(() => null)
  for (const r of ledger && !ledger.tampered ? ledger.records : []) {
    if (r.body.id !== id || typeof r.body.version !== 'number') continue
    if (r.kind === 'rule.accept') add(r.body.version, 'accepted in the rules pane', { at: r.at })
    else if (r.kind === 'rule.retire') retired.push({ version: r.body.version, at: r.at })
  }
  if (here.length === 0 && versions.size === 0) return fail(`litter: there's no rule ${id} in any scope; rule.find with status ['accepted', 'proposed'] lists them`, 'id')
  return {
    ok: true,
    id,
    rules: here.map(r => ({ ...rowOf(r), text: renderRule(r.doc), ...(r.delivered && r.delivered !== r.doc ? { deliveredText: renderRule(r.delivered) } : {}) })),
    versions: [...versions.values()].sort((a, b) => a.version - b.version),
    retired,
    runs: await runsUsing(ctx, id),
    ...(problems.length ? { problems } : {}),
  }
}

async function findStatus(ctx: RecordCtx, litterDir: string, raw: unknown): Promise<RecordReply> {
  // Not declared in the tool's schema (run.end's `status` is a string), so a list may arrive JSON-encoded.
  let status = raw
  if (typeof status === 'string') {
    try {
      status = JSON.parse(status)
    } catch {
      status = [status]
    }
    if (typeof status === 'string') status = [status]
  }
  if (!Array.isArray(status) || status.length === 0 || status.some(s => !(RULE_STATUSES as readonly unknown[]).includes(s))) {
    return fail("litter: 'status' is a list of rule states", 'status', RULE_STATUSES)
  }
  const want = new Set(status as RuleStatus[])
  const { rules, problems } = await loadRules(ctx.p, litterDir)
  const shown = rules.filter(r => (want.has('accepted') && r.delivered !== null) || (want.has('proposed') && r.standing === 'unverified'))
  const proposals = await proposalsOf(ctx.p, litterDir, { status: [...want] })
  const retired: { id: string; version: number; at: number }[] = []
  if (want.has('retired')) {
    for (const store of ['repo', 'user'] as const) {
      const l = await readRuleLedger(ctx.p, litterDir, store).catch(() => null)
      for (const r of l && !l.tampered ? l.records : []) {
        if (r.kind === 'rule.retire' && typeof r.body.id === 'string' && typeof r.body.version === 'number') retired.push({ id: r.body.id, version: r.body.version, at: r.at })
      }
    }
  }
  return { ok: true, rules: shown.map(rowOf), proposals: proposals.map(proposalRow), ...(want.has('retired') ? { retired } : {}), ...(problems.length ? { problems } : {}) }
}

async function findSimilar(ctx: RecordCtx, litterDir: string, input: RecordInput): Promise<RecordReply> {
  const draft = input.similar
  if (typeof draft !== 'string' || draft.trim() === '') return fail("litter: 'similar' is a draft rule: its text, or a whole rule file", 'similar')
  let text = draft
  let paths: string[] = []
  if (draft.startsWith('---')) {
    const parsed = parseRule(draft)
    if (parsed.ok) {
      text = parsed.doc.body.rule
      paths = parsed.doc.applies.paths
    }
  }
  if (Array.isArray(input.paths)) paths = (input.paths as unknown[]).filter((x): x is string => typeof x === 'string')
  const folded = foldText(text)
  const { rules } = await loadRules(ctx.p, litterDir)
  const inForce = rules.filter(r => r.delivered !== null)
  const same = inForce.filter(r => foldText(r.delivered!.body.rule) === folded)
  const overlapping = inForce.filter(r => !same.includes(r) && overlap(paths, r.delivered!.applies.paths))
  const pending = (await proposalsOf(ctx.p, litterDir, { status: ['proposed'] })).filter(v => foldText(proposalText(v.body)) === folded)
  return { ok: true, same: same.map(rowOf), overlapping: overlapping.map(rowOf), pending: pending.map(proposalRow) }
}

/**
 * `rule.find { id }`, `{ status: [...] }`, `{ similar }` or `{ applicable }`:
 * read-only, it writes nothing. `applicable` is AE's findApplicable, exactly
 * what run.start would select. `status` arrives JSON-encoded from some
 * models: ledger.ts doesn't declare it (run.end's `status` is a string), so
 * this handler decodes it.
 */
export const recordRuleFind: RecordHandler = async (ctx, input) => {
  const litterDir = litterDirOf(ctx, input)
  const forms = (['id', 'status', 'similar', 'applicable'] as const).filter(k => input[k] !== undefined)
  if (forms.length !== 1) {
    return fail(
      "litter: rule.find takes exactly one of 'id' (a rule id), 'status' (a list of rule states), 'similar' (a draft rule) or 'applicable' ({ workflow, planPath | tasks | anchors, goal })",
      forms[1] ?? 'id',
    )
  }
  switch (forms[0]!) {
    case 'id':
      return findId(ctx, litterDir, input.id)
    case 'status':
      return findStatus(ctx, litterDir, input.status)
    case 'similar':
      return findSimilar(ctx, litterDir, input)
    case 'applicable': {
      const a = input.applicable
      if (typeof a !== 'object' || a === null || Array.isArray(a)) {
        return fail("litter: 'applicable' is { workflow, planPath | tasks | anchors, goal }, the launch you'd start", 'applicable')
      }
      return deps.findApplicable(ctx.p, litterDir, a as Record<string, unknown>)
    }
  }
}
