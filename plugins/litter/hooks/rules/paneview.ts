// The rules pane's view (16.3, 16.8): the Proposed tab (pending proposals,
// unverified rule files, an import batch) and the In force tab (accepted
// rules, overrides, rules that match no file, the load's problems), from
// AD's store. Owner: phase 3, package AF.
//
// The pane's navigation (the tab, the focus, what [Edit…] holds for a
// proposal until [Accept], what a press waits on) lives in module memory and
// is mirrored in $.store (RULES_STORE_KEY), as the swarm pane's is, so a hot
// reload keeps it. `shown` is what the last build drew for each row: a press
// acts on what you saw (AD's store refuses one that's no longer true).
//
// Every text from a rule file, a proposal or the ledger is cleaned and cut
// (swarm/view.ts, clean): a proposal holds model text.

import type { Ports } from '../ports'
import type { StoredRecord } from '../records/core'
import type {
  LoadedRule,
  ProposalRef,
  RuleDoc,
  RuleImportBody,
  RuleProposeBody,
  RuleScope,
  RuleStatus,
  RuleType,
} from '../records/rules'
import type {
  BoardStatus,
  RulesBatch,
  RulesBody,
  RulesPaneView,
  RulesPending,
  RulesRow,
  RulesTab,
  SwarmNotice,
  SwarmSpan,
} from '../../types/index'
import { loadRules, proposalsOf } from './store'
import { readRuleLedger } from './ledger'
import { matches } from './match'
import { primaryOf } from '../lifecycle'
import { interactive } from '../swarm/state'
import { clean, oneLine } from '../swarm/view'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

// AD's store and AE's matcher, through one table so tier 2 can stand in for
// them (COMMON, "Another package's module"). The mod never changes it.
export const deps = {
  loadRules: (...a: Parameters<typeof loadRules>) => loadRules(...a),
  proposalsOf: (...a: Parameters<typeof proposalsOf>) => proposalsOf(...a),
  readRuleLedger: (...a: Parameters<typeof readRuleLedger>) => readRuleLedger(...a),
  matches: (...a: Parameters<typeof matches>) => matches(...a),
  /** The primary checkout's tracked files, for "matches no file" (16.6): `git ls-files -z`, argv the mod builds. */
  lsFiles: async (p: Ports, primary: string): Promise<string[] | null> => {
    const r = await p.run(['git', '-C', primary, 'ls-files', '-z'])
    return r.code === 0 && !r.truncated ? r.stdout.split('\0').filter(Boolean) : null
  },
}

// ---------------------------------------------------------------------------
// The navigation

/** What [Edit…] and the scope pick set on a proposal, held in the pane until [Accept] (`paths` already through narrowPaths). */
export type HeldEdit = { scope?: RuleScope; paths?: string[]; type?: RuleType }

/** What the pane drew for one row: what a press on it acts on. */
export type ShownRow = {
  kind: RulesRow['kind']
  /** A proposal's. */
  ref: ProposalRef | null
  /** An unverified file's, absolute: accepted as it is. */
  file: string | null
  id: string | null
  version: number | null
  /** Null for a proposal with none: [Accept] asks first. */
  scope: RuleScope | null
  type: RuleType
  paths: string[]
  source: string | null
  /** The `rule.import` seq of the batch it's in, or null. */
  batch: number | null
  actions: string[]
}

export type RulesEditing = { key: string; paths: string; type: string; error: string | null }

export type RulesFocus = { id?: string; proposal?: ProposalRef } | null

export type RulesNav = {
  tab: RulesTab
  focus: RulesFocus
  /** The focused import batch's seq; found from the focus at the first build. */
  batch: number | null
  /** The batch whose preselection `checked` was seeded from, once. */
  seeded: number | null
  /** The batch's checked row keys. */
  checked: string[]
  pending: RulesPending | null
  editing: RulesEditing | null
  held: Record<string, HeldEdit>
  notice: SwarmNotice | null
  shown: Record<string, ShownRow>
}

/** The $.store key the navigation is mirrored under, read back only by the session that wrote it. */
export const RULES_STORE_KEY = 'litter.rules.pane'

type RulesStore = { v: 1; session: string; nav: RulesNav | null }

let rulesNav: RulesNav | null = null
let restored = false
let rev = 0

export const blankRulesNav = (tab: RulesTab = 'proposed', focus: RulesFocus = null): RulesNav => ({
  tab,
  focus,
  batch: null,
  seeded: null,
  checked: [],
  pending: null,
  editing: null,
  held: {},
  notice: null,
  shown: {},
})

/** The pane's navigation, or null while it was never opened in this session. */
export const rulesNavOf = (): RulesNav | null => rulesNav
export const rulesNavRev = (): number => rev

export function setRulesNav(next: RulesNav | null): void {
  rulesNav = next
  restored = true
  rev++
}

const TABS: readonly RulesTab[] = ['proposed', 'in-force']
const SCOPES: readonly RuleScope[] = ['user', 'project', 'local']

/** After a hot reload module memory is empty: the navigation comes back from $.store, when this session wrote it. */
export async function restoreRulesNav(p: Ports): Promise<void> {
  if (restored) return
  restored = true
  try {
    const raw = (await p.store.get(RULES_STORE_KEY)) as Partial<RulesStore> | undefined
    if (!raw || raw.v !== 1 || raw.session !== (await p.sessionId()) || !raw.nav || rulesNav !== null) return
    const n = raw.nav
    rulesNav = {
      ...blankRulesNav(TABS.includes(n.tab) ? n.tab : 'proposed', n.focus ?? null),
      batch: typeof n.batch === 'number' ? n.batch : null,
      seeded: typeof n.seeded === 'number' ? n.seeded : null,
      checked: Array.isArray(n.checked) ? n.checked.filter(k => typeof k === 'string') : [],
      pending: n.pending ?? null,
      editing: n.editing ?? null,
      held: n.held && typeof n.held === 'object' ? n.held : {},
      shown: n.shown && typeof n.shown === 'object' ? n.shown : {},
    }
    rev++
  } catch (err) {
    p.log(`rules pane: the navigation wasn't read back: ${errText(err)}`)
  }
}

export async function saveRulesNav(p: Ports): Promise<void> {
  try {
    const value: RulesStore = { v: 1, session: await p.sessionId(), nav: rulesNav }
    await p.store.set(RULES_STORE_KEY, value)
  } catch (err) {
    p.log(`rules pane: the navigation wasn't saved: ${errText(err)}`)
  }
}

let viewSeq = 0

export function resetRulesViewForTests(): void {
  rulesNav = null
  restored = false
  rev = 0
  viewSeq = 0
}

// ---------------------------------------------------------------------------
// Words, colors and glyphs (15.6: a word on every status)

export const STATUS: Record<'proposed' | 'unverified' | 'accepted' | 'accepted (committed)', BoardStatus> = {
  proposed: { text: 'proposed', color: 'permission', glyph: '⚑' },
  unverified: { text: 'unverified', color: 'warning', glyph: '!' },
  accepted: { text: 'accepted', color: 'success', glyph: '✓' },
  'accepted (committed)': { text: 'accepted (committed)', color: 'success', glyph: '✓' },
}

export const NO_PATHS = 'no paths: applies to every gate'
export const MATCHES_NO_FILE = 'matches no file'
/** A ban's paths say what must not change, so matching nothing yet isn't a warning: it reaches every gate anyway (16.5). */
export const BAN_MATCHES_NO_FILE = 'its paths match no file yet; a ban still reaches every gate'

/** A batch row's first note, which the pane groups the batch by. */
export const instanceNote = (instance: string): string => `from deepwork instance ${oneLine(instance, 80)}`

export const proposalKey = (ref: ProposalRef): string => `${ref.store}:${ref.seq}`
export const batchKey = (seq: number): string => `batch:${seq}`

/** A proposal's key back to its ref; null for a rule id or anything else. */
export function refOfKey(key: string): ProposalRef | null {
  const m = /^(repo|user):([1-9][0-9]*)$/.exec(key)
  return m ? { store: m[1] as ProposalRef['store'], seq: Number(m[2]) } : null
}

// ---------------------------------------------------------------------------
// A rule as lines, and the diff an edit shows

/** A rule's fields and sections as lines, the form an edit's diff compares. */
export function docLines(doc: RuleDoc): string[] {
  const out = [`type: ${doc.type}`, `paths: ${doc.applies.paths.length > 0 ? doc.applies.paths.join(', ') : 'everywhere'}`]
  if (doc.applies.workflows?.length) out.push(`workflows: ${doc.applies.workflows.join(', ')}`)
  if (doc.applies.roles?.length) out.push(`roles: ${doc.applies.roles.join(', ')}`)
  out.push(`when: ${doc.applies.when}`, '## Rule', ...doc.body.rule.split('\n'))
  if (doc.body.why) out.push('## Why', ...doc.body.why.split('\n'))
  if (doc.body.exceptions.length > 0) out.push('## Exceptions', ...doc.body.exceptions.map(x => `- ${x}`))
  if (doc.body.howToCheck.length > 0) out.push('## How to check', ...doc.body.howToCheck.map(x => `- ${x}`))
  return out.map(l => oneLine(l, 300))
}

const DIFF_LINES = 120

/** A line diff, old → new: `+` and `−` lines in the diff word colors, `~`-free (15.6), the rest dim. */
export function diffSpans(before: readonly string[], after: readonly string[]): SwarmSpan[] {
  const a = before.slice(0, 400)
  const b = after.slice(0, 400)
  // The longest common subsequence, then a walk.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out: SwarmSpan[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ text: `  ${a[i]}`, dim: true })
      i++
      j++
    } else if (j < b.length && (i >= a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      out.push({ text: `+ ${b[j]}`, color: 'diffAddedWord' })
      j++
    } else {
      out.push({ text: `− ${a[i]}`, color: 'diffRemovedWord' })
      i++
    }
  }
  return out.length > DIFF_LINES ? [...out.slice(0, DIFF_LINES), { text: `… ${out.length - DIFF_LINES} more lines`, dim: true }] : out
}

// ---------------------------------------------------------------------------
// The build

type Proposal = { ref: ProposalRef; body: RuleProposeBody; status: RuleStatus }
type Batch = { seq: number; body: RuleImportBody }

/** Which import batch the focus names: the `rule.import` record itself, or one of the proposals it made. */
function batchOf(imports: readonly Batch[], n: RulesNav): Batch | null {
  if (n.batch !== null) return imports.find(b => b.seq === n.batch) ?? null
  const ref = n.focus?.proposal
  if (!ref || ref.store !== 'repo') return null
  return imports.find(b => b.seq === ref.seq) ?? imports.find(b => b.body.proposals.some(x => x.store === ref.store && x.seq === ref.seq)) ?? null
}

async function readImports(p: Ports, litterDir: string): Promise<Batch[]> {
  const ledger = await deps.readRuleLedger(p, litterDir, 'repo')
  return ledger.records.flatMap((r: StoredRecord) => {
    if (r.kind !== 'rule.import') return []
    const b = r.body as Partial<RuleImportBody>
    if (!Array.isArray(b.instances) || !Array.isArray(b.proposals) || !Array.isArray(b.preselected)) return []
    return [{ seq: r.seq, body: b as RuleImportBody }]
  })
}

/** Where a proposal came from, in words. */
function provenance(b: RuleProposeBody): string {
  if (b.import) return instanceNote(b.import.instance)
  if (b.source === 'critic') {
    const at = [b.run && `run ${oneLine(b.run, 70)}`, b.gate && `at ${oneLine(b.gate, 32)}`, b.swarm && `in swarm ${oneLine(b.swarm, 40)}`].filter(Boolean).join(' ')
    return `proposed by a gate critic${at ? ` in ${at}` : ''}`
  }
  if (b.source === 'user') return 'drafted from your words (/litter:rules add)'
  return `proposed by ${oneLine(b.source, 40)}`
}

/**
 * The view of `n.tab`, with what the navigation holds, and what each row
 * showed (for the presses). A focused batch's preselection seeds `checked`
 * once (`seeded`).
 */
export async function rulesView(
  p: Ports,
  litterDir: string,
  n: RulesNav,
): Promise<{ view: RulesPaneView; shown: Record<string, ShownRow>; batch: number | null; seeded: number | null; checked: string[] }> {
  // What couldn't be read, on both tabs; loadRules' own problems on the In force tab.
  const failures: string[] = []
  const loadProblems: string[] = []
  let loaded: LoadedRule[] = []
  try {
    const r = await deps.loadRules(p, litterDir)
    loaded = r.rules
    loadProblems.push(...r.problems.map(x => oneLine(x, 300)))
  } catch (err) {
    failures.push(`the rules couldn't be loaded: ${oneLine(errText(err), 240)}`)
  }
  let proposals: Proposal[] = []
  try {
    proposals = (await deps.proposalsOf(p, litterDir, { status: ['proposed'] })).filter(x => x.status === 'proposed')
  } catch (err) {
    failures.push(`the proposals couldn't be read: ${oneLine(errText(err), 240)}`)
  }
  let batch: Batch | null = null
  if (n.batch !== null || n.focus?.proposal) {
    try {
      batch = batchOf(await readImports(p, litterDir), n)
    } catch (err) {
      failures.push(`the import batch couldn't be read: ${oneLine(errText(err), 240)}`)
    }
  }

  const canAccept = interactive() !== false
  const shown: Record<string, ShownRow> = {}
  const keys = new Set<string>()
  const fileKey = (scope: RuleScope, id: string): string => {
    const k = keys.has(id) ? `${id}@${scope}` : id
    keys.add(k)
    return k
  }
  const inForceOf = (id: string): RuleDoc | null => loaded.find(r => r.doc.id === id && r.delivered)?.delivered ?? null

  // The Proposed tab: proposals, then unverified files.
  const batchKeys = new Set((batch?.body.proposals ?? []).map(proposalKey))
  const checked = batch ? (n.seeded === batch.seq ? n.checked : batch.body.preselected.map(proposalKey)) : []
  const proposalRows: RulesRow[] = []
  for (const x of proposals) {
    const key = proposalKey(x.ref)
    const b = x.body
    const held = n.held[key] ?? {}
    const doc = b.doc
    const type: RuleType = held.type ?? b.type ?? doc?.type ?? (b.import ? 'ban' : 'rule')
    const paths = held.paths ?? b.paths ?? doc?.applies.paths ?? []
    const scope = held.scope ?? b.scope ?? null
    const inBatch = batchKeys.has(key)
    const notes = [provenance(b)]
    if (b.import?.archived) notes.push('from an archived instance')
    if (b.edits) notes.push(`an edit of ${oneLine(b.edits, 80)}`)
    if (held.scope) notes.push(`scope ${held.scope}, chosen here`)
    if (held.paths || held.type) notes.push('narrowed here: kept until you accept it')
    notes.push('its id is assigned when you accept it')
    let diff: SwarmSpan[] | null = null
    if (b.edits) {
      const old = inForceOf(b.edits.split('@')[0]!)
      if (old) diff = diffSpans(docLines(old), doc ? docLines(doc) : clean(b.rule, 8000).split('\n'))
      else notes.push(`${oneLine(b.edits, 80)} isn't in force now`)
    }
    const actions = [...(canAccept ? ['accept'] : []), 'edit', 'dismiss']
    shown[key] = { kind: 'proposal', ref: x.ref, file: null, id: null, version: null, scope, type, paths, source: b.source, batch: inBatch ? batch!.seq : null, actions }
    proposalRows.push({
      key,
      kind: 'proposal',
      id: null,
      version: null,
      scope,
      type,
      status: STATUS.proposed,
      when: oneLine(b.when ?? doc?.applies.when ?? '', 300),
      rule: clean(doc?.body.rule || b.rule, 1500),
      paths: paths.map(x => oneLine(x, 200)),
      notes,
      diff,
      source: oneLine(b.source, 40),
      actions,
      ...(inBatch ? { checked: checked.includes(key) } : {}),
    })
  }
  // A focused batch first, grouped by instance as its record lists them.
  const instanceRank = (r: RulesRow): number => {
    const i = (batch?.body.instances ?? []).findIndex(inst => r.notes[0] === instanceNote(inst.id))
    return i < 0 ? Number.MAX_SAFE_INTEGER : i
  }
  const inBatchRows = proposalRows.filter(r => batchKeys.has(r.key)).sort((a, b) => instanceRank(a) - instanceRank(b))
  const otherRows = proposalRows.filter(r => !batchKeys.has(r.key))

  const unverifiedRows: RulesRow[] = []
  for (const r of loaded.filter(x => x.standing === 'unverified')) {
    const key = fileKey(r.scope, r.doc.id)
    const id = oneLine(r.doc.id, 80)
    const notes = [oneLine(r.why ?? 'its bytes are none the mod wrote when you accepted it', 300)]
    notes.push(r.delivered ? `${id}@${r.delivered.version} stays in force until you accept this` : 'nothing of it is in force')
    notes.push(`file ${oneLine(r.path, 300)}`)
    const actions = canAccept ? ['accept'] : []
    shown[key] = { kind: 'unverified', ref: null, file: r.path, id: r.doc.id, version: r.doc.version, scope: r.scope, type: r.doc.type, paths: r.doc.applies.paths, source: null, batch: null, actions }
    unverifiedRows.push({
      key,
      kind: 'unverified',
      id,
      version: r.doc.version,
      scope: r.scope,
      type: r.doc.type,
      status: STATUS.unverified,
      when: oneLine(r.doc.applies.when, 300),
      rule: clean(r.doc.body.rule, 1500),
      paths: r.doc.applies.paths.map(x => oneLine(x, 200)),
      notes,
      diff: r.delivered ? diffSpans(docLines(r.delivered), docLines(r.doc)) : null,
      source: null,
      actions,
    })
  }

  // The In force tab: the version in force of every rule, an edited committed one's HEAD version included.
  const inForceRows: RulesRow[] = []
  if (n.tab === 'in-force') {
    keys.clear()
    const files = await trackedFiles(p, litterDir)
    for (const r of loaded) {
      const doc = r.delivered
      if (!doc) continue
      const key = fileKey(r.scope, doc.id)
      const id = oneLine(doc.id, 80)
      const word = r.standing === 'unverified' ? 'accepted (committed)' : r.standing
      const notes: string[] = []
      for (const o of overrides(loaded, r)) notes.push(o)
      if (r.standing === 'unverified') notes.push('the file has an edit you haven\'t accepted: see the Proposed tab')
      else if (r.why) notes.push(oneLine(r.why, 300))
      if (doc.applies.paths.length > 0 && files !== null && matchesNothing(p, doc.applies.paths, files)) {
        notes.push(doc.type === 'ban' ? BAN_MATCHES_NO_FILE : MATCHES_NO_FILE)
      }
      const actions = ['edit', 'retire']
      shown[key] = { kind: 'accepted', ref: null, file: r.path, id: doc.id, version: doc.version, scope: r.scope, type: doc.type, paths: doc.applies.paths, source: null, batch: null, actions }
      inForceRows.push({
        key,
        kind: 'accepted',
        id,
        version: doc.version,
        scope: r.scope,
        type: doc.type,
        status: STATUS[word],
        when: oneLine(doc.applies.when, 300),
        rule: clean(doc.body.rule, 1500),
        paths: doc.applies.paths.map(x => oneLine(x, 200)),
        notes,
        diff: null,
        source: null,
        actions,
      })
    }
  }

  const rows = n.tab === 'proposed' ? [...inBatchRows, ...otherRows, ...unverifiedRows] : inForceRows
  const visible: Record<string, ShownRow> = {}
  for (const r of rows) visible[r.key] = shown[r.key]!

  const focusKey = n.focus?.proposal ? proposalKey(n.focus.proposal) : n.focus?.id ? (rows.find(r => r.id === n.focus!.id)?.key ?? null) : null
  const pending = n.pending && (visible[n.pending.key] || (batch && n.pending.key === batchKey(batch.seq))) ? n.pending : null
  const editing = n.editing && visible[n.editing.key]?.kind === 'proposal' ? n.editing : null
  const rulesBatch: RulesBatch | null = batch
    ? {
        seq: batch.seq,
        instances: batch.body.instances.map(i => ({ id: oneLine(i.id, 80), goal: oneLine(i.goal, 200), date: i.date === null ? null : oneLine(i.date, 40), archived: i.archived === true })),
        preselected: batch.body.preselected.map(proposalKey),
      }
    : null
  const notice = n.notice ?? (canAccept ? null : { level: 'warning' as const, text: "this session isn't interactive, so nothing can be accepted here (16.3)" })
  const body: RulesBody = {
    title: [{ text: 'litter · rules', bold: true }, { text: ` · ${n.tab === 'proposed' ? 'Proposed' : 'In force'}` }],
    notice,
    counts: { proposed: proposalRows.length + unverifiedRows.length, inForce: loaded.filter(r => r.delivered).length },
    rows,
    batch: rulesBatch,
    focus: focusKey,
    problems: n.tab === 'in-force' ? [...failures, ...loadProblems] : failures,
    pending,
    editing,
  }
  return {
    view: { view: 'rules', v: ++viewSeq, tab: n.tab, body },
    shown: visible,
    batch: batch?.seq ?? null,
    seeded: batch?.seq ?? n.seeded,
    checked: batch ? checked.filter(k => batchKeys.has(k)) : n.checked,
  }
}

/** "local L-… overrides U-…" (16.6), on the local rule and on the user rule it overrides. */
function overrides(loaded: readonly LoadedRule[], r: LoadedRule): string[] {
  const out: string[] = []
  const id = r.delivered?.id ?? r.doc.id
  if (r.scope === 'local' && r.doc.overrides) {
    const target = loaded.find(x => x.scope === 'user' && x.doc.id === r.doc.overrides)
    if (target) out.push(`local ${oneLine(id, 80)} overrides ${oneLine(target.doc.id, 80)}`)
  }
  if (r.scope === 'user') {
    for (const l of loaded) if (l.scope === 'local' && l.doc.overrides === id) out.push(`local ${oneLine(l.doc.id, 80)} overrides ${oneLine(id, 80)}`)
  }
  return out
}

/** The primary checkout's tracked files, once per build; null for a bare repository or when git can't say. */
async function trackedFiles(p: Ports, litterDir: string): Promise<string[] | null> {
  const primary = primaryOf(litterDir)
  if (!primary) return null
  try {
    return await deps.lsFiles(p, primary)
  } catch (err) {
    p.log(`rules pane: git ls-files failed: ${errText(err)}`)
    return null
  }
}

/** True when none of the patterns matches a tracked file (AE's matches); a matcher that throws flags nothing. */
function matchesNothing(p: Ports, patterns: readonly string[], files: readonly string[]): boolean {
  try {
    return !patterns.some(pattern => files.some(f => deps.matches(pattern, f)))
  } catch (err) {
    p.log(`rules pane: paths not checked against the files: ${errText(err)}`)
    return false
  }
}

/** The view of `tab`, focused on a rule id, a proposal or an import batch's proposals, or on nothing. */
export async function buildRulesPane(
  p: Ports,
  litterDir: string,
  tab: RulesTab,
  focus: { id?: string; proposal?: ProposalRef } | null,
): Promise<RulesPaneView> {
  const n = rulesNav ?? blankRulesNav(tab, focus)
  return (await rulesView(p, litterDir, { ...n, tab, focus })).view
}

/** The scope a proposal's [Accept] asks for, first in the list: project for an import (16.8), else user. */
export const scopeChoices = (row: Pick<ShownRow, 'source'>): RuleScope[] =>
  row.source === 'import' ? ['project', 'user', 'local'] : [...SCOPES]
