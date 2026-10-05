// The board's view (decision 21), built from a run's ledger and run.json
// only: the header, the execute gate table and its detail, a record list
// for the other workflows, the rule versions used and the proposals made.
// Owner: phase 3, package AF. Phase 5 (package CD; COMMON decisions 9 and
// 10): each gate row's menu items and full commit id, a design run's bar ×
// version matrix and its records' lines, and the critic note section.
//
// The navigation (the run shown, the selected row, the open section) lives
// in module memory and is mirrored in $.store (BOARD_STORE_KEY), as the
// swarm pane's is (swarm/view.ts, PANE_STORE_KEY), so a hot reload keeps it.
// $.state is wiped by every session end, /clear included, so after a clear
// pane.tsx's refreshBoard draws the view again from the ledger.
//
// Every text from the ledger, run.json, a plan or git is cleaned and cut
// (swarm/view.ts, clean): a record holds model text.

import type { Ports } from '../ports'
import type { StoredRecord } from '../records/core'
import type { RunJson, RunEndBody, Workflow } from '../records/run'
import type { GateVerdictBody, LandBody, VerdictDimension, VerifyBody } from '../records/execute'
import type { LoadedRule, ProposalRef, RuleProposeBody, RuleStatus } from '../records/rules'
import type { DesignCriterion, DesignVerdictBody } from '../records/design'
import type { RunState } from '../lifecycle'
import type { FoundRun } from '../litterdir'
import type {
  BoardBody,
  BoardButton,
  BoardDesign,
  BoardGateAction,
  BoardGateDetail,
  BoardGateRow,
  BoardGateState,
  BoardHeader,
  BoardMatrixCell,
  BoardMatrixRow,
  BoardProposalRow,
  BoardRecordRow,
  BoardRuleRow,
  BoardSection,
  BoardStatus,
  BoardVersionLine,
  BoardView,
  SwarmNotice,
  SwarmSpan,
} from '../../types/index'
import { headKey, readLedger } from '../ledgercore'
import { RUN_ID, UNKNOWN_ID, planPath, proposalPath, repoRulesLedgerDir, runDir, runJsonPath, userRulesLedgerDir, verdictFile, verifyLogDir } from '../layout'
import { GAP_KINDS, PROBE_VERDICTS } from '../records/design'
import { barIds, isVersion, proposalRecords, verdictRecords } from '../design/finalize'
import { readJson } from '../fsx'
import { readPolicy } from '../policy'
import { primaryOf, repoOf, resolveChain, runState } from '../lifecycle'
import { recordRunFind } from '../litterdir'
import { howEnded, verifyBody } from '../verify'
import { parseGates } from '../gates'
import { getOptions, session } from '../session'
import { clean, oneLine } from '../swarm/view'
import { loadRules, proposalsOf } from '../rules/store'

// AD's store, through one table so tier 2 can stand in for it (COMMON,
// "Another package's module"). The mod never changes it.
export const deps = {
  loadRules: (...a: Parameters<typeof loadRules>) => loadRules(...a),
  proposalsOf: (...a: Parameters<typeof proposalsOf>) => proposalsOf(...a),
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The workflows `/litter-board <workflow>` takes: the newest run of it. */
const WORKFLOW_ARGS: readonly Workflow[] = ['execute', 'design', 'fanout', 'plan']
/** A full object id, as the land record holds it; only these reach git's argv, or the clipboard (the menu's copy). */
export const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/
/** How many records the other workflows list (decision 21). */
export const RECORD_ROWS = 30
/** A section's text: under the engine's 10000-character bound for Code. */
const SECTION_MAX = 8000

// ---------------------------------------------------------------------------
// The navigation

/** [Plan], [Diff G<n>], or the menu's critic note on a gate. */
export type BoardSectionNav = { kind: 'plan' } | { kind: 'diff'; gate: string } | { kind: 'verdict'; gate: string }

export type BoardNav = {
  /** /litter-board's argument as given: a run id, a workflow, or null. */
  arg: string | null
  /** The run shown, once resolved; null when there was none. */
  run: string | null
  /** The selected gate; null takes the default (the gate being worked, else the last). */
  selected: string | null
  section: BoardSectionNav | null
  notice: SwarmNotice | null
}

/** The $.store key the navigation is mirrored under, read back only by the session that wrote it. */
export const BOARD_STORE_KEY = 'litter.board.pane'

type BoardStore = { v: 1; session: string; nav: BoardNav | null }

let boardNav: BoardNav | null = null
let restored = false
let rev = 0

export const blankBoardNav = (arg: string | null): BoardNav => ({ arg, run: null, selected: null, section: null, notice: null })

/** The board's navigation, or null while it was never opened in this session. */
export const navOf = (): BoardNav | null => boardNav
/** Bumped by every change of the navigation: part of the rebuild check. */
export const boardNavRev = (): number => rev

export function setBoardNav(next: BoardNav | null): void {
  boardNav = next
  restored = true
  rev++
}

/** After a hot reload module memory is empty: the navigation comes back from $.store, when this session wrote it. */
export async function restoreBoardNav(p: Ports): Promise<void> {
  if (restored) return
  restored = true
  try {
    const raw = (await p.store.get(BOARD_STORE_KEY)) as Partial<BoardStore> | undefined
    if (!raw || raw.v !== 1 || raw.session !== (await p.sessionId()) || !raw.nav || boardNav !== null) return
    const n = raw.nav
    boardNav = {
      arg: typeof n.arg === 'string' ? n.arg : null,
      run: typeof n.run === 'string' && RUN_ID.test(n.run) ? n.run : null,
      selected: typeof n.selected === 'string' ? n.selected : null,
      section:
        n.section && (n.section.kind === 'plan' || ((n.section.kind === 'diff' || n.section.kind === 'verdict') && typeof n.section.gate === 'string')) ? n.section : null,
      notice: null,
    }
    rev++
  } catch (err) {
    p.log(`board: the navigation wasn't read back: ${errText(err)}`)
  }
}

export async function saveBoardNav(p: Ports): Promise<void> {
  try {
    const value: BoardStore = { v: 1, session: await p.sessionId(), nav: boardNav }
    await p.store.set(BOARD_STORE_KEY, value)
  } catch (err) {
    p.log(`board: the navigation wasn't saved: ${errText(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Caches (module memory; none is a fact anyone else reads)

let viewSeq = 0
let cached: { key: string; view: BoardView } | null = null
/** `git diff --stat` of a land: commits never change, so once per pair. */
const diffs = new Map<string, string>()

export function resetBoardForTests(): void {
  boardNav = null
  restored = false
  rev = 0
  viewSeq = 0
  cached = null
  diffs.clear()
}

// ---------------------------------------------------------------------------
// Which run

export type PickedRun = { run: string | null; why: string | null }

/**
 * /litter-board's argument: a run id names that run; `execute` or `design`
 * (or `fanout`, `plan`) the newest run of that workflow; nothing the active
 * run (policy.json's), else the newest. Newest is run.find's order.
 */
export async function resolveRun(p: Ports, litterDir: string, arg: string | null): Promise<PickedRun> {
  const a = (arg ?? '').trim()
  if (a !== '' && RUN_ID.test(a)) {
    if (await p.fs.exists(runJsonPath(runDir(litterDir, a)))) return { run: a, why: null }
    return { run: null, why: `there's no run ${a} in ${litterDir}` }
  }
  if (a !== '' && !(WORKFLOW_ARGS as readonly string[]).includes(a)) {
    return { run: null, why: `"${oneLine(a, 60)}" isn't a run id (<yyyymmdd>-<slug>) or a workflow (execute, design)` }
  }
  if (a === '') {
    const active = (await readPolicy(p, litterDir).catch(() => undefined))?.run?.run
    if (typeof active === 'string' && RUN_ID.test(active) && (await p.fs.exists(runJsonPath(runDir(litterDir, active))))) return { run: active, why: null }
  }
  const runs = await listRuns(p, litterDir, a === '' ? undefined : (a as Workflow))
  if (runs.length > 0) return { run: runs[0]!.run, why: null }
  return { run: null, why: a === '' ? 'no litter run yet' : `no ${a} run yet` }
}

/** run.find's listing, newest first: the record tool's own handler, which writes nothing. */
async function listRuns(p: Ports, litterDir: string, workflow?: Workflow): Promise<FoundRun[]> {
  const reply = await recordRunFind(
    { p, caller: { agentId: null, agentType: null }, litterDir, options: getOptions() },
    { kind: 'run.find', ...(workflow ? { workflow } : {}) },
  )
  if (!reply.ok) throw new Error(reply.error)
  return Array.isArray(reply.runs) ? (reply.runs as FoundRun[]) : []
}

// ---------------------------------------------------------------------------
// The change check

const headOf = async (p: Ports, dir: string): Promise<string> => {
  const head = (await p.store.get(headKey(dir))) as { seq?: unknown; sha?: unknown } | undefined
  return head && typeof head.seq === 'number' ? `${head.seq}:${String(head.sha ?? '').slice(0, 12)}` : '0'
}

/**
 * The heads the view reads: the run's ledger, and both rules ledgers (a
 * critic's proposal arrives in the repository's; an acceptance in either).
 * Only $.store reads, so the tick stays cheap.
 */
export async function boardStamp(p: Ports, litterDir: string, run: string): Promise<string> {
  const user = await p.configDir().then(
    dir => headOf(p, userRulesLedgerDir(dir)),
    () => '-',
  )
  return `${await headOf(p, runDir(litterDir, run))}|${await headOf(p, repoRulesLedgerDir(litterDir))}|${user}`
}

// ---------------------------------------------------------------------------
// Words, colors and glyphs (15.6)

const RUN_STATUS: Record<string, { color: string; glyph: string }> = {
  running: { color: 'background', glyph: '▸' },
  repairing: { color: 'background', glyph: '↻' },
  stopping: { color: 'warning', glyph: '!' },
  pending: { color: 'inactive', glyph: '·' },
  done: { color: 'success', glyph: '✓' },
  halted: { color: 'warning', glyph: '⚑' },
  needs_user: { color: 'permission', glyph: '⚑' },
  failed: { color: 'error', glyph: '✕' },
  launch_failed: { color: 'error', glyph: '✕' },
  stopped: { color: 'inactive', glyph: '−' },
  interrupted: { color: 'inactive', glyph: '−' },
  ledger_tampered: { color: 'error', glyph: '✕' },
}

const GATE_STATE: Record<BoardGateState, { color: string; glyph: string }> = {
  landed: { color: 'success', glyph: '✓' },
  'in progress': { color: 'background', glyph: '▸' },
  halted: { color: 'warning', glyph: '⚑' },
  waiting: { color: 'inactive', glyph: '·' },
  repairing: { color: 'background', glyph: '↻' },
}

export function statusWord(text: string): BoardStatus {
  const s = RUN_STATUS[text] ?? { color: 'inactive', glyph: '·' }
  return { text, color: s.color, glyph: s.glyph }
}

/** A run's status from its ledger (runState): the open generation's, else the last end's, else `pending`. */
export function runStatusOf(st: RunState, tampered: boolean): string {
  if (tampered) return 'ledger_tampered'
  if (st.open) return st.open.stopping ? 'stopping' : st.open.repair ? 'repairing' : 'running'
  const end = st.latest?.end ?? st.launchEnd
  return end ? end.status : 'pending'
}

/** A time in UTC, so the board reads the same wherever it's drawn. */
export function utcAt(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`
}

const shortSha = (v: unknown): string => (typeof v === 'string' && /^[0-9a-f]{7,64}$/.test(v) ? v.slice(0, 7) : '')
const branchOf = (ref: unknown): string => (typeof ref === 'string' ? oneLine(ref.replace(/^refs\/heads\//, ''), 120) : '')

// ---------------------------------------------------------------------------
// One run's facts

type RunFiles = {
  run: string
  dir: string
  json: RunJson | null
  records: StoredRecord[]
  tampered: { seq: number; reason: string } | null
}

async function loadRunFiles(p: Ports, litterDir: string, run: string): Promise<RunFiles> {
  const dir = runDir(litterDir, run)
  let json: RunJson | null = null
  try {
    const j = await readJson<RunJson>(p, runJsonPath(dir))
    json = j && j.v === 1 && j.run === run ? j : null
  } catch (err) {
    p.log(`board: ${run}/run.json unreadable: ${errText(err)}`)
  }
  const ledger = await readLedger(p, dir, run)
  return { run, dir, json, records: ledger.records, tampered: ledger.tampered }
}

const DIMENSIONS = ['plan_adherence', 'tests_green', 'no_regressions', 'rules'] as const

/** A verdict with execute's four dimensions, from execute.js's critic or a plan-template swarm's (gate and attempt beside them). */
type GateVerdict = { rec: StoredRecord; body: GateVerdictBody; gate: string | null; attempt: number | null }

function isDim(v: unknown): v is VerdictDimension {
  return v !== null && typeof v === 'object' && typeof (v as { pass?: unknown }).pass === 'boolean'
}

/** Every verify, verdict and land, and the latest executor result, by gate. */
type GateFacts = {
  verifies: Map<string, VerifyBody[]>
  verdicts: Map<string, GateVerdict[]>
  lands: Map<string, LandBody>
  /** An execute executor's latest `task.result` (output.ts, GateResultBody), whatever it says. */
  results: Map<string, StoredRecord>
}

function gateFacts(records: readonly StoredRecord[]): GateFacts {
  const byId = new Map<string, VerifyBody>()
  const verifies = new Map<string, VerifyBody[]>()
  const verdicts = new Map<string, GateVerdict[]>()
  const lands = new Map<string, LandBody>()
  const results = new Map<string, StoredRecord>()
  for (const r of records) {
    if (r.kind === 'verify') {
      const v = verifyBody(r)
      if (!v) continue
      byId.set(v.verify_id, v)
      verifies.set(v.gate, [...(verifies.get(v.gate) ?? []), v])
    } else if (r.kind === 'verdict') {
      const b = r.body as Partial<GateVerdictBody> & { gate?: unknown; attempt?: unknown }
      if (!DIMENSIONS.every(d => isDim(b[d]))) continue
      const cited = typeof b.verify_id === 'string' ? byId.get(b.verify_id) : undefined
      const gate = typeof b.gate === 'string' ? b.gate : (cited?.gate ?? null)
      const attempt = typeof b.attempt === 'number' ? b.attempt : (cited?.attempt ?? null)
      if (gate === null) continue
      verdicts.set(gate, [...(verdicts.get(gate) ?? []), { rec: r, body: b as GateVerdictBody, gate, attempt }])
    } else if (r.kind === 'land') {
      const b = r.body as Partial<LandBody>
      if (typeof b.gate === 'string' && typeof b.commit === 'string' && !lands.has(b.gate)) lands.set(b.gate, b as LandBody)
    } else if (r.kind === 'task.result' && r.body.role === 'executor' && typeof r.body.gate === 'string') {
      results.set(r.body.gate, r)
    }
  }
  return { verifies, verdicts, lands, results }
}

/** An executor's stop on a plan gap, before its attempt was judged (WP-AH). */
type ExecutorStop = { gap: string; attempt: number }

/**
 * The gate's latest executor result, when it comes after the gate's last
 * verdict and is a block naming a plan gap, as repair.ts (classifyExecute)
 * and execsummary.ts (executorStop) read it; null for any other result.
 */
function executorStop(result: StoredRecord | undefined, verdict: GateVerdict | undefined): ExecutorStop | null {
  if (!result || (verdict !== undefined && result.seq <= verdict.rec.seq)) return null
  const res = result.body.result as Record<string, unknown> | null | undefined
  if (!res || typeof res !== 'object' || res.status !== 'blocked' || typeof res.plan_gap !== 'string' || res.plan_gap.trim() === '') return null
  const attempt = result.body.attempt
  return { gap: res.plan_gap, attempt: Number.isSafeInteger(attempt) && (attempt as number) > 0 ? (attempt as number) : 0 }
}

const failingOf = (v: GateVerdict | undefined): string[] => (v ? DIMENSIONS.filter(d => !v.body[d].pass) : [])
const attemptOf = (verifies: readonly VerifyBody[] | undefined): number =>
  (verifies ?? []).reduce((n, v) => (Number.isInteger(v.attempt) && v.attempt > n ? v.attempt : n), 0)

/** The gates execute.js works, from the stored args. */
function argGates(json: RunJson | null): { id: string; title: string }[] {
  const gates = json?.args?.gates
  if (!Array.isArray(gates)) return []
  return gates.flatMap(g => {
    if (g === null || typeof g !== 'object' || typeof (g as { id?: unknown }).id !== 'string') return []
    const { id, title } = g as { id: string; title?: unknown }
    return [{ id, title: typeof title === 'string' ? title : '' }]
  })
}

/** A continuation's earlier lands (`args.landed`, lifecycle.ts's chainLanded at launch). */
function earlierLands(json: RunJson | null): { id: string; commit: string }[] {
  const landed = json?.args?.landed
  if (!Array.isArray(landed)) return []
  return landed.flatMap(l =>
    l !== null && typeof l === 'object' && typeof (l as { id?: unknown }).id === 'string' && typeof (l as { commit?: unknown }).commit === 'string'
      ? [l as { id: string; commit: string }]
      : [],
  )
}

async function readText(p: Ports, path: string): Promise<string | null> {
  try {
    return (await p.fs.exists(path)) ? await p.fs.read(path) : null
  } catch (err) {
    p.log(`board: ${path} unreadable: ${errText(err)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// The build

/**
 * The view of `run` as /litter-board's argument gives it: a run id; `execute`
 * or `design`, the newest run of that workflow; or null, the active run, else
 * the newest. `v` increases on every rebuild; `body.stamp` is the ledger head
 * it read. A build whose run, heads and navigation are those of the last one
 * answers the last view, unchanged.
 */
export async function buildBoard(p: Ports, litterDir: string, run: string | null): Promise<BoardView> {
  const nav = boardNav ?? blankBoardNav(run)
  const picked = await resolveRun(p, litterDir, run)
  const refused = session().toolsRefused
  if (picked.run === null) {
    const key = `none|${picked.why}|${rev}|${refused}`
    if (cached?.key === key) return cached.view
    const view: BoardView = { view: 'board', v: ++viewSeq, run: null, body: emptyBody(picked.why ?? 'no run to show', nav, refused) }
    cached = { key, view }
    return view
  }
  const stamp = await boardStamp(p, litterDir, picked.run)
  const key = `${picked.run}|${stamp}|${rev}|${refused}`
  if (cached?.key === key) return cached.view
  const body = await runBody(p, litterDir, picked.run, nav, stamp, refused)
  const view: BoardView = { view: 'board', v: ++viewSeq, run: picked.run, body }
  cached = { key, view }
  return view
}

const title = (...parts: SwarmSpan[]): SwarmSpan[] => [{ text: 'litter · board', bold: true }, ...parts]

function emptyBody(why: string, nav: BoardNav, refused: string | null): BoardBody {
  return {
    title: title(),
    notice: refusedNotice(refused) ?? nav.notice ?? { level: 'info', text: `${why}: /litter-board <run | execute | design> opens one` },
    header: null,
    gates: null,
    detail: null,
    design: null,
    records: [],
    rules: [],
    proposals: [],
    section: null,
    buttons: [{ key: 'board:rules', label: 'Rules' }],
    stamp: '',
  }
}

/** Under a managed allowedMcpServers the record tool is refused, and every litter launch with it (12, "managed policy"). */
const refusedNotice = (refused: string | null): SwarmNotice | null => (refused ? { level: 'error', text: oneLine(refused, 300) } : null)

async function runBody(p: Ports, litterDir: string, run: string, nav: BoardNav, stamp: string, refused: string | null): Promise<BoardBody> {
  const f = await loadRunFiles(p, litterDir, run)
  const st = runState(f.records)
  const workflow = f.json?.workflow ?? st.start?.workflow ?? 'unknown'
  const header = headerOf(f, st)
  const planText = await readText(p, planPath(f.dir))
  const plan = workflow === 'design' ? await designPlan(p, f, planText) : planText !== null ? { title: 'plan.md', path: planPath(f.dir), text: planText, scroll: true } : null

  let gates: BoardBody['gates'] = null
  let detail: BoardGateDetail | null = null
  let design: BoardDesign | null = null
  let records: BoardRecordRow[] = []
  let selectedRow: BoardGateRow | null = null
  if (workflow === 'execute') {
    const table = await gateRows(p, litterDir, f, st, planText)
    const selected = table.rows.some(r => r.id === nav.selected) ? nav.selected! : defaultSelection(table.rows)
    gates = { run, rows: table.rows, selected }
    selectedRow = table.rows.find(r => r.id === selected) ?? null
    detail = selected ? detailOf(table.facts.get(selected) ?? null, selected) : null
  } else if (workflow === 'design') {
    design = designOf(f.json, f.records)
    records = recordRows(f.records, recordContext(f.json))
  } else {
    records = recordRows(f.records)
  }

  const [rules, proposals] = await Promise.all([ruleRows(p, litterDir, f.json), proposalRows(p, litterDir, run, f.records)])
  const section = await sectionOf(p, litterDir, f, nav, plan, gates)

  const buttons: BoardButton[] = []
  // A design's [Plan] is its delivered plan.md, else its latest proposal; for a deliverable that isn't a plan, that proposal.
  if (plan !== null) buttons.push({ key: 'board:plan', label: workflow === 'design' && f.json?.args?.deliverable !== 'plan' ? 'Proposal' : 'Plan' })
  if (selectedRow && selectedRow.state === 'landed' && selectedRow.commit) buttons.push({ key: `board:diff:${selectedRow.id}`, label: `Diff ${selectedRow.id}` })
  buttons.push({ key: 'board:rules', label: 'Rules' })
  if (section) buttons.push({ key: 'board:close', label: 'Close' })

  const notice = refusedNotice(refused) ?? nav.notice ?? (f.json ? null : { level: 'warning' as const, text: `run.json of ${run} can't be read; the header is from the ledger` })
  return {
    title: title({ text: ` · ${run}` }),
    notice,
    header,
    gates,
    detail,
    design,
    records,
    rules,
    proposals,
    section,
    buttons,
    stamp,
  }
}

function headerOf(f: RunFiles, st: RunState): BoardHeader {
  const start = st.start
  const json = f.json
  const status = runStatusOf(st, f.tampered !== null)
  const endAt = (end: RunEndBody | null | undefined, seq: number | null): number | null => {
    if (!end) return null
    const rec = seq !== null ? f.records.find(r => r.seq === seq) : f.records.find(r => r.kind === 'run.end' && r.body.generation === 0)
    return rec?.at ?? null
  }
  const ended = st.open ? null : st.latest ? endAt(st.latest.end, st.latest.endSeq) : endAt(st.launchEnd, null)
  const started = st.startedAt ?? json?.created ?? null
  return {
    run: f.run,
    workflow: json?.workflow ?? start?.workflow ?? 'unknown',
    status: statusWord(status),
    generation: st.latest?.n ?? 0,
    repairSwarm: st.open?.repair ? oneLine(st.open.repair.swarm, 60) : null,
    branch: branchOf(json?.ref ?? start?.ref),
    base: shortSha(json?.base ?? start?.base),
    checkout: oneLine(json?.checkout ?? start?.checkout ?? '', 300),
    started: started !== null ? utcAt(started) : '',
    ended: ended !== null ? utcAt(ended) : null,
    tampered: f.tampered ? `ledger tampered at ${f.tampered.seq}` : null,
  }
}

/** One gate's facts, for the detail of its row. */
type RowFacts = { verifies: VerifyBody[]; verdict: GateVerdict | undefined; stop: ExecutorStop | null; runDir: string }

async function gateRows(
  p: Ports,
  litterDir: string,
  f: RunFiles,
  st: RunState,
  planText: string | null,
): Promise<{ rows: BoardGateRow[]; facts: Map<string, RowFacts> }> {
  const facts = gateFacts(f.records)
  const maxAttempts = typeof f.json?.args?.maxAttempts === 'number' ? (f.json.args.maxAttempts as number) : getOptions().maxAttempts
  const worked = argGates(f.json)
  const earlier = earlierLands(f.json).filter(l => !worked.some(g => g.id === l.id))
  const parsed = planText !== null ? parseGates(planText) : null
  const planned = parsed?.ok ? parsed.gates : []
  const titleOf = (id: string, given: string) => given || planned.find(g => g.id === id)?.title || ''

  const rowFacts = new Map<string, RowFacts>()
  const rows: BoardGateRow[] = []
  const status = runStatusOf(st, f.tampered !== null)
  const current = worked.find(g => !facts.lands.has(g.id))?.id ?? null
  // Replay is for a run that has ended: not running, stopping or repairing, and not before its launch (decision 9).
  const ended = st.open === null && st.ended

  // The chain's earlier lands: the run that landed each, read from its own ledger.
  const members = earlier.length > 0 ? await chainMembers(p, litterDir, f.run) : []
  const earlierRows = new Map<string, BoardGateRow>()
  for (const l of earlier) {
    const m = members.find(x => x.run !== f.run && x.records.some(r => r.kind === 'land' && r.body.gate === l.id))
    const mf = m ? gateFacts(m.records) : null
    const verdict = mf?.verdicts.get(l.id)?.at(-1)
    const mDir = m ? runDir(litterDir, m.run) : f.dir
    rowFacts.set(l.id, { verifies: mf?.verifies.get(l.id) ?? [], verdict, stop: null, runDir: mDir })
    const file = await verdictPath(p, mDir, verdict)
    const oid = OID.test(l.commit) ? l.commit : null
    earlierRows.set(l.id, {
      id: l.id,
      title: oneLine(titleOf(l.id, ''), 120),
      state: 'landed',
      ...GATE_STATE.landed,
      attempt: attemptOf(mf?.verifies.get(l.id)),
      maxAttempts: m && typeof m.json.args?.maxAttempts === 'number' ? (m.json.args.maxAttempts as number) : maxAttempts,
      failing: failingOf(verdict),
      verdictFile: file,
      commit: shortSha(l.commit) || null,
      oid,
      earlier: m ? m.run : 'an earlier run',
      actions: actionsOf(ended, file, oid),
    })
  }

  const workedRows = new Map<string, BoardGateRow>()
  for (const g of worked) {
    const verifies = facts.verifies.get(g.id) ?? []
    const verdict = facts.verdicts.get(g.id)?.at(-1)
    const land = facts.lands.get(g.id)
    // An executor that stopped on a plan gap halts its gate as a critic's plan gap does, verified or not.
    const stop = land ? null : executorStop(facts.results.get(g.id), verdict)
    let state: BoardGateState
    if (land) state = 'landed'
    else if (st.open?.repair) state = 'repairing'
    else if (st.open) state = g.id === current ? 'in progress' : 'waiting'
    else if (st.ended && status !== 'done' && g.id === current && (verifies.length > 0 || verdict !== undefined || stop !== null)) state = 'halted'
    else state = 'waiting'
    rowFacts.set(g.id, { verifies, verdict, stop, runDir: f.dir })
    const file = await verdictPath(p, f.dir, verdict)
    const oid = land && OID.test(land.commit) ? land.commit : null
    workedRows.set(g.id, {
      id: g.id,
      title: oneLine(titleOf(g.id, g.title), 120),
      state,
      ...GATE_STATE[state],
      // The stop's attempt is one past its verifies' (output.ts, gateResultAt): the attempt it stopped on.
      attempt: Math.max(attemptOf(verifies), stop?.attempt ?? 0),
      maxAttempts,
      failing: failingOf(verdict),
      verdictFile: file,
      commit: land ? shortSha(land.commit) || null : null,
      oid,
      earlier: null,
      actions: actionsOf(ended, file, oid),
    })
  }

  // In the plan's order, where plan.md reads; else the earlier lands first.
  const order = planned.map(g => g.id)
  const all = [...earlierRows.values(), ...workedRows.values()]
  const rank = (id: string) => {
    const i = order.indexOf(id)
    return i < 0 ? order.length + all.findIndex(r => r.id === id) : i
  }
  rows.push(...all.sort((a, b) => rank(a.id) - rank(b.id)))
  return { rows, facts: rowFacts }
}

async function chainMembers(p: Ports, litterDir: string, run: string): Promise<{ run: string; json: RunJson; records: StoredRecord[] }[]> {
  try {
    const chain = await resolveChain(p, litterDir, run)
    return chain.ok ? chain.members : []
  } catch (err) {
    p.log(`board: run ${run}'s chain unreadable: ${errText(err)}`)
    return []
  }
}

/** The verdict's file (AB's verdicts.ts), when it's there: the gate and attempt of the verify it cites. */
async function verdictPath(p: Ports, dir: string, v: GateVerdict | undefined): Promise<string | null> {
  if (!v || v.gate === null || v.attempt === null || !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(v.gate) || !Number.isInteger(v.attempt)) return null
  const path = verdictFile(dir, v.gate, v.attempt)
  return (await p.fs.exists(path).catch(() => false)) ? path : null
}

/** A row's menu items (decision 9), in the menu's order, each only where it applies. */
function actionsOf(ended: boolean, verdictFile: string | null, oid: string | null): BoardGateAction[] {
  const out: BoardGateAction[] = []
  if (ended) out.push('replay')
  if (verdictFile !== null) out.push('note')
  if (oid !== null) out.push('copy')
  return out
}

/** The gate being worked, else the last row. */
function defaultSelection(rows: readonly BoardGateRow[]): string | null {
  return (rows.find(r => r.state !== 'landed') ?? rows.at(-1))?.id ?? null
}

function detailOf(facts: RowFacts | null, gate: string): BoardGateDetail {
  const v = facts?.verdict
  const last = facts?.verifies.at(-1)
  const stop = facts?.stop ?? null
  const judged = v && Number.isSafeInteger(v.attempt) && (v.attempt as number) > 0 ? (v.attempt as number) : null
  // The executor's stop after the last verdict wins, as it does for the bridge and the summary.
  const planGap = stop ? clean(stop.gap, 600) : v ? clean(v.body.plan_gap, 600) : ''
  return {
    gate,
    dimensions: v
      ? DIMENSIONS.map(name => ({
          name,
          pass: v.body[name].pass,
          evidence: clean(v.body[name].evidence, 600),
          gaps: (Array.isArray(v.body[name].gaps) ? v.body[name].gaps : []).slice(0, 10).map(g => oneLine(g, 300)),
        }))
      : [],
    verdictAttempt: judged,
    verify: last && facts ? { id: oneLine(last.verify_id, 80), ended: howEnded(last) + (last.green ? ', green' : ''), log: verifyLogDir(facts.runDir, last.verify_id) } : null,
    planGap,
    gapBy: planGap === '' ? null : stop ? { who: 'executor', attempt: stop.attempt > 0 ? stop.attempt : null } : { who: 'critic', attempt: judged },
    // Absent from a verdict recorded before it (WP-AH); a blank one names none, and a later executor stop replaces it.
    ruleClash: v && !stop ? clean(v.body.rule_clash, 600).trim() : '',
  }
}

// The other workflows: a record list

function field(b: Record<string, unknown>, k: string): string {
  const v = b[k]
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** What a design run's record lines read beyond the record: the bar's ids, and each unknown's question by its id. */
export type RecordContext = { bar: readonly string[] | null; unknowns: ReadonlyMap<string, string> }

const NO_CONTEXT: RecordContext = { bar: null, unknowns: new Map() }

/** A design run's context from run.json's args: the frozen bar, and the unknowns as summary.ts reads them (a bare string is `U<n>`'s question). */
function recordContext(json: RunJson | null): RecordContext {
  const list = Array.isArray(json?.args?.empiricalUnknowns) ? (json!.args.empiricalUnknowns as unknown[]) : []
  const unknowns = new Map<string, string>()
  list.forEach((u, i) => {
    if (typeof u === 'string') unknowns.set(`U${i + 1}`, u)
    else if (isObj(u) && typeof u.id === 'string' && UNKNOWN_ID.test(u.id) && typeof u.question === 'string') unknowns.set(u.id, u.question)
  })
  return { bar: barIds(json), unknowns }
}

/** A verdict's criteria with an id, the first of each id. */
function criteriaOf(v: unknown): DesignCriterion[] {
  const out: DesignCriterion[] = []
  for (const c of Array.isArray(v) ? v : []) if (isObj(c) && typeof c.id === 'string' && !out.some(x => x.id === c.id)) out.push(c as unknown as DesignCriterion)
  return out
}

/**
 * A design critic's verdict: `v3 APPROVED · 8/8 pass`, or `v3 HOLDING · 5/8
 * pass, open C3 C5`. Counted over the bar and every id the verdict judged, so a
 * bar item it left out is open, as the approval reads it (design/finalize.ts).
 */
function designVerdictLine(b: Record<string, unknown>, bar: readonly string[] | null): string {
  const criteria = criteriaOf(b.criteria)
  const ids = [...new Set([...(bar ?? []), ...criteria.map(c => c.id)])]
  const open = ids.filter(id => criteria.find(c => c.id === id)?.verdict !== 'PASS')
  const counted = `${ids.length - open.length}/${ids.length} pass${open.length > 0 ? `, open ${open.map(id => oneLine(id, 20)).join(' ')}` : ''}`
  return `${field(b, 'version')} ${oneLine(b.overall, 20)} · ${counted}`
}

/** One record in a line: its kind's own summary where there is one, else its first plain fields. */
export function recordLine(r: StoredRecord, ctx: RecordContext = NO_CONTEXT): string {
  const b = (r.body ?? {}) as Record<string, unknown>
  const text = (() => {
    switch (r.kind) {
      case 'run.start':
        return `${field(b, 'workflow')} run from ${shortSha(b.base)} on ${branchOf(b.ref)}`
      case 'run.launch':
      case 'run.resume':
        return `generation ${field(b, 'generation')}${field(b, 'taskId') ? `, task ${field(b, 'taskId')}` : ''}`
      case 'run.repair':
        return `generation ${field(b, 'generation')}: repair swarm ${field(b, 'swarm')}`
      case 'run.stopping':
        return `generation ${field(b, 'generation')} stopping`
      case 'run.end':
        return `generation ${field(b, 'generation')}: ${field(b, 'status')}${field(b, 'reason') ? ` (${field(b, 'reason')})` : ''}`
      case 'verify': {
        const v = verifyBody(r)
        return v ? `${v.gate} attempt ${v.attempt}: ${v.green ? '✓ green' : `✕ ${howEnded(v)}`}` : 'verify'
      }
      case 'verdict': {
        // Three shapes, told apart before any is worded: a design critic's, a fanout's, execute's four dimensions.
        if (Array.isArray(b.criteria) && typeof b.overall === 'string') return designVerdictLine(b, ctx.bar)
        if (Array.isArray(b.tasks)) {
          const tasks = b.tasks as { pass?: unknown }[]
          return `${tasks.filter(t => t?.pass === true).length} of ${tasks.length} tasks pass${b.approved === true ? ', approved' : ''}`
        }
        if (DIMENSIONS.every(d => isDim(b[d]))) {
          const failing = DIMENSIONS.filter(d => !(b[d] as VerdictDimension).pass)
          return `on ${field(b, 'verify_id')}: ${failing.length === 0 ? '✓ passes' : `✕ ${failing.join(', ')}`}`
        }
        return 'verdict (unrecognized)'
      }
      case 'proposal': {
        const n = Array.isArray(b.gates) ? b.gates.length : null
        return `${field(b, 'version')}${n === null ? '' : ` · ${n} gate${n === 1 ? '' : 's'}`}`
      }
      case 'probe': {
        const id = typeof b.unknown_id === 'string' && UNKNOWN_ID.test(b.unknown_id) ? b.unknown_id : null
        // A probe recorded before the unknown and the verdict were required has only its report.
        if (id === null) return `no unknown named: ${field(b, 'report')}`
        const verdict = (PROBE_VERDICTS as readonly unknown[]).includes(b.verdict) ? String(b.verdict) : 'no verdict recorded'
        const question = typeof b.question === 'string' && b.question.trim() !== '' ? b.question : (ctx.unknowns.get(id) ?? '')
        return `${id} ${verdict}${question ? `: ${question}` : ''}`
      }
      case 'design.result': {
        const res = isObj(b.result) ? b.result : {}
        if (b.role === 'author') return `author${isVersion(res.version) ? `, ${res.version}` : ''}`
        if (b.role !== 'reframer') return field(b, 'role')
        const rec = typeof res.recommendation === 'string' ? oneLine(res.recommendation, 40) : ''
        return `reframer, ${rec === '' || rec.toLowerCase() === 'none' ? 'no reframe' : `recommends ${rec}`}`
      }
      case 'design.deliver': {
        const version = isVersion(b.version) ? ` ${b.version}` : ''
        if (typeof b.refused === 'string') return `refused${version}: ${b.refused}`
        return `delivered${version} as ${field(b, 'path')}`
      }
      case 'land':
        return `${field(b, 'gate')} landed ${shortSha(b.commit)}`
      case 'land.intent':
        return `${field(b, 'gate')}: landing ${field(b, 'verify_id')}`
      case 'land.blocked':
      case 'land.abandoned':
      case 'repair.declined':
        return `${field(b, 'gate') ? `${field(b, 'gate')}: ` : ''}${field(b, 'reason')}`
      case 'rule.propose':
        return `"${field(b, 'rule')}"`
      default:
        return Object.keys(b)
          .map(k => [k, field(b, k)] as const)
          .filter(([, v]) => v !== '')
          .slice(0, 3)
          .map(([k, v]) => `${k} ${v}`)
          .join(', ')
    }
  })()
  return oneLine(text, 160)
}

function recordRows(records: readonly StoredRecord[], ctx: RecordContext = NO_CONTEXT): BoardRecordRow[] {
  return records.slice(-RECORD_ROWS).map(r => ({ seq: r.seq, kind: oneLine(r.kind, 40), text: recordLine(r, ctx) }))
}

// The design view: the bar × version matrix (decision 10)

/** The versions the matrix shows at most, the last ones. */
export const MATRIX_VERSIONS = 8
/** Ids a verdict names outside the bar get a row each, up to this many: a verdict's ids are model text. */
const OUTSIDE_ROWS = 10

const CELL: Record<string, { glyph: string; color: string }> = {
  PASS: { glyph: '✓', color: 'success' },
  CONDITIONAL: { glyph: '~', color: 'warning' },
  FAIL: { glyph: '✕', color: 'error' },
}
const NOT_JUDGED: BoardMatrixCell = { text: '·', color: 'inactive' }
const OVERALL_COLOR: Record<string, string> = { APPROVED: 'success', HOLDING: 'warning' }

/** The line under the matrix that spells its glyphs and the gap kinds' letters out. */
export const MATRIX_LEGEND = `✓ PASS  ~ CONDITIONAL  ✕ FAIL  · not judged  ·  gap kind: ${GAP_KINDS.map(k => `${k[0]} ${k}`).join(', ')}`

const versionNumber = (v: string): number => Number(v.slice(1))

/** A criterion's cell: its glyph, then for CONDITIONAL and FAIL its gap kind's first letter. */
function cellOf(c: DesignCriterion | undefined): BoardMatrixCell {
  const look = c ? CELL[c.verdict] : undefined
  if (!c || !look) return NOT_JUDGED
  const gap = c.verdict !== 'PASS' && (GAP_KINDS as readonly unknown[]).includes(c.gap_kind) ? c.gap_kind![0]! : ''
  return { text: `${look.glyph}${gap}`, color: look.color }
}

/**
 * A design run's matrix: a row per bar item (run.json's bar, its rule items
 * included, in its order), a column per version (the last 8), each cell from
 * the latest verdict on that version; then a row for each id a shown verdict
 * names that the bar doesn't have, and a line per version shown.
 */
function designOf(json: RunJson | null, records: readonly StoredRecord[]): BoardDesign {
  const bar = (Array.isArray(json?.args?.bar) ? (json!.args.bar as unknown[]) : []).filter(
    (b): b is { id: string; text?: unknown } => isObj(b) && typeof b.id === 'string',
  )
  const proposals = proposalRecords(records)
  const verdicts = verdictRecords(records)
  const all = [...new Set([...proposals, ...verdicts].map(r => r.body.version as string))].sort((a, b) => versionNumber(a) - versionNumber(b))
  const versions = all.slice(-MATRIX_VERSIONS)
  const judged = versions.map(v => {
    const body = verdicts.filter(r => r.body.version === v).at(-1)?.body as Partial<DesignVerdictBody> | undefined
    return body ? { body, criteria: criteriaOf(body.criteria) } : null
  })
  const outside: string[] = []
  for (const j of judged) {
    for (const c of j?.criteria ?? []) if (!bar.some(b => b.id === c.id) && !outside.includes(c.id)) outside.push(c.id)
  }
  const cells = (id: string) => judged.map(j => cellOf(j?.criteria.find(c => c.id === id)))
  const rows: BoardMatrixRow[] = [
    ...bar.map(b => ({ id: oneLine(b.id, 16), text: oneLine(b.text, 300), cells: cells(b.id), outside: false })),
    ...outside.slice(0, OUTSIDE_ROWS).map(id => ({ id: oneLine(id, 16), text: 'not in the bar', cells: cells(id), outside: true })),
  ]
  const lines: BoardVersionLine[] = versions.map((version, i) => {
    const j = judged[i]
    const overall = j ? oneLine(j.body.overall, 20) || 'no overall' : 'not judged'
    const sha = shortSha(proposals.find(r => r.body.version === version)?.body.sha256)
    return { version, overall, color: OVERALL_COLOR[overall] ?? 'inactive', sha, sourceChanged: j?.body.source_changed === true }
  })
  return { versions, hidden: all.length - versions.length, rows, legend: MATRIX_LEGEND, lines }
}

/** What a design's [Plan] opens (decision 10): plan.md once a delivery is recorded, else the latest proposals/vN.md. */
type PlanFile = { title: string; path: string; text: string | null; scroll: boolean }

async function designPlan(p: Ports, f: RunFiles, planText: string | null): Promise<PlanFile | null> {
  const delivered = f.records.filter(r => r.kind === 'design.deliver' && typeof r.body.path === 'string' && r.body.refused === undefined).at(-1)
  if (delivered && planText !== null) {
    const v = isVersion(delivered.body.version) ? `${delivered.body.version}, ` : ''
    return { title: `plan.md (${v}delivered)`, path: planPath(f.dir), text: planText, scroll: false }
  }
  // isVersion has passed it, so it names a file under proposals/.
  const latest = proposalRecords(f.records).at(-1)?.body.version as string | undefined
  if (!latest) return null
  const path = proposalPath(f.dir, latest)
  return { title: `proposal ${latest}`, path, text: await readText(p, path), scroll: false }
}

// The rules

const STANDING_COLOR: Record<string, string> = { accepted: 'success', 'accepted (committed)': 'success', unverified: 'warning' }

/** `run.json.rules` as `id@v` (decision 19), each with its standing now (AD's loadRules). */
async function ruleRows(p: Ports, litterDir: string, json: RunJson | null): Promise<BoardRuleRow[]> {
  const used = Array.isArray(json?.rules) ? json!.rules.filter(r => r && typeof r.id === 'string' && Number.isInteger(r.version)) : []
  if (used.length === 0) return []
  let loaded: LoadedRule[] | null = null
  try {
    loaded = (await deps.loadRules(p, litterDir)).rules
  } catch (err) {
    p.log(`board: the rules couldn't be loaded: ${errText(err)}`)
  }
  return used.map(u => {
    const ref = `${oneLine(u.id, 80)}@${u.version}`
    if (loaded === null) return { ref, standing: "standing unknown: the rules couldn't be read", color: 'warning' }
    const found = loaded.find(r => r.doc.id === u.id)
    if (!found) return { ref, standing: 'no longer in force', color: 'inactive' }
    const inForce = found.delivered
    if (!inForce) return { ref, standing: 'unverified now', color: 'warning' }
    if (inForce.version !== u.version) return { ref, standing: `in force now as ${ref.split('@')[0]}@${inForce.version}`, color: 'warning' }
    const word = found.standing === 'unverified' ? 'accepted (committed)' : found.standing
    return { ref, standing: word, color: STANDING_COLOR[word] ?? 'success' }
  })
}

const PROPOSAL_LABEL: Record<RuleStatus, string> = {
  proposed: 'proposed, not accepted',
  accepted: 'accepted since, in the rules pane',
  dismissed: 'dismissed',
  retired: 'retired',
}

/**
 * The run's proposals as they arrive (AD's proposalsOf({ run })), and the
 * run-ledger `rule.propose` records written before phase 3, which stay
 * where they are (decision 16), each marked "proposed, not accepted".
 */
async function proposalRows(p: Ports, litterDir: string, run: string, records: readonly StoredRecord[]): Promise<BoardProposalRow[]> {
  const rows: BoardProposalRow[] = []
  let found: { ref: ProposalRef; body: RuleProposeBody; status: RuleStatus }[] = []
  try {
    found = await deps.proposalsOf(p, litterDir, { run })
  } catch (err) {
    p.log(`board: the run's proposals couldn't be read: ${errText(err)}`)
  }
  const seen = new Set<string>()
  const keyOf = (b: { rule?: unknown; tool_use_id?: unknown; index?: unknown; verify_id?: unknown }) => `${String(b.tool_use_id ?? b.verify_id ?? '')}#${String(b.index ?? '')}#${String(b.rule ?? '')}`
  for (const x of found) {
    seen.add(keyOf(x.body))
    rows.push({
      text: oneLine(x.body.doc?.body?.rule || x.body.rule, 200),
      source: oneLine(x.body.source, 40),
      gate: typeof x.body.gate === 'string' ? oneLine(x.body.gate, 32) : null,
      label: PROPOSAL_LABEL[x.status] ?? 'proposed, not accepted',
    })
  }
  for (const r of records) {
    if (r.kind !== 'rule.propose' || typeof r.body.rule !== 'string' || seen.has(keyOf(r.body))) continue
    rows.push({
      text: oneLine(r.body.rule, 200),
      source: oneLine(typeof r.body.source === 'string' ? r.body.source : 'agent', 40),
      gate: typeof r.body.gate === 'string' ? oneLine(r.body.gate, 32) : null,
      label: 'proposed, not accepted',
    })
  }
  return rows
}

// The sections [Plan], [Diff G<n>] and the menu's critic note open

async function sectionOf(
  p: Ports,
  litterDir: string,
  f: RunFiles,
  nav: BoardNav,
  plan: PlanFile | null,
  gates: BoardBody['gates'],
): Promise<BoardSection | null> {
  const s = nav.section
  if (!s) return null
  if (s.kind === 'plan') {
    if (plan === null) return { kind: 'plan', title: "plan.md isn't there", path: planPath(f.dir), text: '' }
    if (plan.text === null) return { kind: 'plan', title: `${plan.title} isn't there`, path: plan.path, text: '' }
    // "Scrolled to the selected gate's section": from its heading on (gates.ts's lines, 1-based).
    const parsed = plan.scroll ? parseGates(plan.text) : null
    const g = parsed?.ok && gates?.selected ? parsed.gates.find(x => x.id === gates.selected) : undefined
    const from = g ? g.lines.start : 1
    const shown = plan.text.split('\n').slice(from - 1).join('\n')
    return {
      kind: 'plan',
      title: g ? `${plan.title} from ${g.id} (line ${from})` : plan.title,
      path: plan.path,
      text: clean(shown, SECTION_MAX),
    }
  }
  if (s.kind === 'verdict') return verdictSection(p, gates, s.gate)
  return diffSection(p, litterDir, f, s.gate)
}

/** The menu's critic note: the row's verdict file (AB's verdicts.ts), cleaned and cut as the plan is. */
async function verdictSection(p: Ports, gates: BoardBody['gates'], gate: string): Promise<BoardSection> {
  const file = gates?.rows.find(r => r.id === gate)?.verdictFile ?? null
  if (file === null) return { kind: 'verdict', title: `${gate} has no critic note`, path: null, text: '' }
  const text = await readText(p, file)
  if (text === null) return { kind: 'verdict', title: `${gate}'s critic note isn't there`, path: file, text: '' }
  return { kind: 'verdict', title: `critic note on ${gate}`, path: file, text: clean(text, SECTION_MAX) }
}

/**
 * `git diff --stat <old> <commit>` for a landed gate, with argv the mod builds
 * from the land record's oids (an earlier land's parent, `<commit>^`), each
 * checked as a full object id first.
 */
async function diffSection(p: Ports, litterDir: string, f: RunFiles, gate: string): Promise<BoardSection> {
  const facts = gateFacts(f.records)
  const land = facts.lands.get(gate)
  let old: string | null = null
  let commit: string | null = null
  if (land && OID.test(land.commit) && OID.test(land.old)) {
    old = land.old
    commit = land.commit
  } else {
    const earlier = earlierLands(f.json).find(l => l.id === gate)
    if (earlier && OID.test(earlier.commit)) {
      commit = earlier.commit
      old = `${earlier.commit}^`
    }
  }
  if (!commit || !old) return { kind: 'diff', title: `${gate} has no land with a commit to diff`, path: null, text: '' }
  const pair = `${old}..${commit}`
  let text = diffs.get(pair)
  if (text === undefined) {
    const where = primaryOf(litterDir) ?? repoOf(litterDir)
    const r = await p.run(['git', '-C', where, 'diff', '--stat', '--no-color', '--end-of-options', old, commit, '--'])
    if (r.code !== 0) return { kind: 'diff', title: `git diff --stat for ${gate} failed`, path: null, text: oneLine(r.stderr, 300) }
    text = clean(r.stdout, SECTION_MAX)
    diffs.set(pair, text)
  }
  return { kind: 'diff', title: `${gate}: git diff --stat ${old.slice(0, 7)}${old.endsWith('^') ? '^' : ''} ${commit.slice(0, 7)}`, path: null, text }
}
