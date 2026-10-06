// The band above the prompt (phase 5; COMMON step 1, decision 7; plan 11,
// "Band"): a row per active run, one for the newest run that ended in the
// last 10 minutes (the bandEndedMinutes option, WP-CH), a row per live
// swarm, then a row per open permission ask (CF's), built into the `band`
// atom by the ui tick and drawn by render.tsx. Keys are
// `band:<action>[:<arg>]`. Owner: WP-CB.
//
// A quiet tick is cheap: policy.json's stat, each tracked run's ledger head
// in $.store, and module memory (the live swarms, the open asks). A run's
// ledger is read again only when its head moved or the minute changed, and
// the view is written only when its rows changed: the elapsed time is in
// whole minutes, so a quiet run rewrites the band once a minute at most.
//
// The runs it tracks: policy.json's run, and each run seen there until that
// window has passed since it ended; and, at a module's first build (a reload,
// a new session), the three runs whose ledgers moved last, so a run that has just
// ended keeps its row. [Hide]'s keys live in module memory, mirrored in
// $.store under BAND_STORE_KEY with the session id and read back only by the
// session that wrote them, as the board's navigation is (board/view.ts).
//
// Every text from a ledger, run.json, a swarm or an ask is cleaned and cut
// (swarm/view.ts, oneLine): a record holds model text.

import type { Ports } from '../ports'
import type { BandPressHook, BandRender, PortHook } from '../hooktypes'
import type { BandButton, BandRow, BandView, SwarmSpan } from '../../types/index'
import type { StoredRecord } from '../records/core'
import type { RunJson } from '../records/run'
import type { LiveSwarm } from '../swarm/types'
import type { AskEntry } from '../uitypes'
import { headKey } from '../ledgercore'
import { PROPOSAL_VERSION, RUN_ID, SWARM_NAME, ledgerDir, policyPath, runDir } from '../layout'
import { FANOUT_GATE } from '../records/fanout'
import { readPolicy } from '../policy'
import { loadRun, runState } from '../lifecycle'
import { getOptions, session } from '../session'
import { runStatusOf, statusWord } from '../board/view'
import { openBoard } from '../board/pane'
import { openSwarmPane } from '../swarm/panes'
import { openAsks } from '../asks'
import { bindings, liveSwarms, openQuestions, status as admissionStatus } from '../swarm/state'
import { oneLine } from '../swarm/view'

// The other packages' modules the band calls, through one table so tier 2
// can stand in for them (COMMON, "Another package's module"): CF's open asks,
// CD's board and N's swarm pane. The mod never changes it.
export const deps = {
  openAsks: (): AskEntry[] => openAsks(),
  openBoard: (p: Ports, run: string): Promise<boolean> => openBoard(p, run),
  openSwarmPane: (p: Ports, name: string): Promise<string> => openSwarmPane(p, name),
}
const defaults = { ...deps }

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * How long a run that ended keeps its row by default (decision 7):
 * BAND_ENDED_MINUTES.default. The bandEndedMinutes option sets it, read at each build.
 */
export const ENDED_MS = 10 * 60_000
/** Open asks drawn a row each, newest first; the rest fold into `+<k> more asking`. */
export const ASK_ROWS = 3
/** The $.store key [Hide]'s keys are mirrored under, with the session that wrote them. */
export const BAND_STORE_KEY = 'litter.band.hidden'
/** litter's name, as register.tsx's atoms carry it: only its own buttons are the band's to answer. */
const PLUGIN = 'litter'
const MIN = 60_000
const HIDDEN_MAX = 50
/** A module's first build reads the newest run folders by name, then tracks the ones whose ledgers moved last. */
const SEED_NAMES = 20
const SEED_RUNS = 3
const SEP: SwarmSpan = { text: ' · ' }

// ---------------------------------------------------------------------------
// What a run's row says

type ExecuteProgress = { kind: 'execute'; gates: number; landed: number; current: string | null; index: number; attempt: number }
type DesignProgress = { kind: 'design'; version: string | null; pass: number | null; of: number | null; overall: string | null }
type FanoutProgress = { kind: 'fanout'; done: number; tasks: number; step: 'integrating' | 'verifying' | 'landing' | null; landed: boolean }
type PlanProgress = { kind: 'plan'; records: number }
type Progress = ExecuteProgress | DesignProgress | FanoutProgress | PlanProgress

/** One run's facts, from its ledger and run.json; read again when its head moves or the minute changes. */
type RunFacts = {
  run: string
  workflow: string
  /** board/view.ts's runStatusOf: `running`, `repairing`, `stopping`, or the last end's status. */
  status: string
  open: boolean
  /** The open generation's, else the latest's; 0 for a launch that never opened one. */
  generation: number
  openedAt: number | null
  /** The run.end record's time, once the run holds no lock. */
  endedAt: number | null
  repairSwarm: string | null
  tamperedAt: number | null
  progress: Progress | null
}

type Inflight = 'critique' | 'land' | null

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const posInt = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : null)
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The ids of run.json's `args.<field>` list of `{ id }` (execute's gates, a fanout's tasks), in order. */
function argIds(json: RunJson | null, field: 'gates' | 'tasks'): string[] {
  const list = json?.args?.[field]
  return Array.isArray(list) ? list.flatMap(x => (isObj(x) && typeof x.id === 'string' ? [x.id] : [])) : []
}

const DIMENSIONS = ['plan_adherence', 'tests_green', 'no_regressions', 'rules'] as const

/**
 * The attempt a gate is on in this generation: the highest its verifies
 * name, and one more once the verdict on that attempt rejected it.
 * execute.js numbers a gate's attempts from 1 in each workflow run, and its
 * critic records the verify of each attempt before judging it.
 */
function attemptOf(records: readonly StoredRecord[], gate: string): number {
  const verifies = new Map<string, { gate: string; attempt: number }>()
  let last = 0
  let verdict: { attempt: number | null; rejected: boolean } | null = null
  for (const r of records) {
    const b = r.body as Record<string, unknown>
    if (r.kind === 'verify' && typeof b.verify_id === 'string' && typeof b.gate === 'string') {
      const a = posInt(b.attempt)
      if (a === null) continue
      verifies.set(b.verify_id, { gate: b.gate, attempt: a })
      if (b.gate === gate && a > last) last = a
    } else if (r.kind === 'verdict' && DIMENSIONS.every(d => isObj(b[d]) && typeof (b[d] as { pass?: unknown }).pass === 'boolean')) {
      const cited = typeof b.verify_id === 'string' ? verifies.get(b.verify_id) : undefined
      if ((typeof b.gate === 'string' ? b.gate : cited?.gate) !== gate) continue
      verdict = { attempt: posInt(b.attempt) ?? cited?.attempt ?? null, rejected: DIMENSIONS.some(d => (b[d] as { pass: boolean }).pass === false) }
    }
  }
  if (verdict !== null && verdict.rejected && verdict.attempt === last) return last + 1
  return Math.max(last, 1)
}

/** Execute: the gate being worked (the first of `args.gates` with no land), counted in that order, and its attempt. */
function executeProgress(json: RunJson | null, records: readonly StoredRecord[], since: readonly StoredRecord[]): ExecuteProgress {
  const gates = argIds(json, 'gates')
  const lands = new Set(records.flatMap(r => (r.kind === 'land' && typeof r.body.gate === 'string' && typeof r.body.commit === 'string' ? [r.body.gate] : [])))
  const current = gates.find(g => !lands.has(g)) ?? null
  return {
    kind: 'execute',
    gates: gates.length,
    landed: gates.filter(g => lands.has(g)).length,
    current,
    index: current === null ? gates.length : gates.indexOf(current) + 1,
    attempt: current === null ? 0 : attemptOf(since, current),
  }
}

/** Design: the latest proposal's version, and the latest verdict on that version. */
function designProgress(records: readonly StoredRecord[]): DesignProgress {
  let version: string | null = null
  for (const r of records) if (r.kind === 'proposal' && typeof r.body.version === 'string' && PROPOSAL_VERSION.test(r.body.version)) version = r.body.version
  let judged: Record<string, unknown> | null = null
  if (version !== null) for (const r of records) if (r.kind === 'verdict' && r.body.version === version && Array.isArray(r.body.criteria)) judged = r.body
  const criteria = judged ? (judged.criteria as unknown[]).filter(isObj) : []
  return {
    kind: 'design',
    version,
    pass: judged ? criteria.filter(c => c.verdict === 'PASS').length : null,
    of: judged ? criteria.length : null,
    overall: judged && (judged.overall === 'APPROVED' || judged.overall === 'HOLDING') ? judged.overall : null,
  }
}

/** Fanout: the tasks with a result, and the step after them this generation's records show. */
function fanoutProgress(json: RunJson | null, records: readonly StoredRecord[], since: readonly StoredRecord[]): FanoutProgress {
  const tasks = argIds(json, 'tasks')
  const done = new Set(records.flatMap(r => (r.kind === 'task.result' && typeof r.body.task === 'string' && tasks.includes(r.body.task) ? [r.body.task] : [])))
  let step: FanoutProgress['step'] = null
  let landed = false
  for (const r of since) {
    const gate = r.body.gate
    if (r.kind === 'land' && gate === FANOUT_GATE) landed = true
    else if (r.kind === 'land.intent' && gate === FANOUT_GATE) step = 'landing'
    else if (step !== 'landing' && ((r.kind === 'verify' && gate === 'integration') || r.kind === 'integrate.done')) step = 'verifying'
    else if (step === null && (r.kind === 'integrate' || r.kind.startsWith('integrate.'))) step = 'integrating'
  }
  return { kind: 'fanout', done: done.size, tasks: tasks.length, step, landed }
}

function progressOf(workflow: string, json: RunJson | null, records: readonly StoredRecord[], since: readonly StoredRecord[]): Progress | null {
  if (workflow === 'execute') return executeProgress(json, records, since)
  if (workflow === 'design') return designProgress(records)
  if (workflow === 'fanout') return fanoutProgress(json, records, since)
  if (workflow === 'plan') return { kind: 'plan', records: records.length }
  return null
}

function factsOf(run: string, json: RunJson | null, records: readonly StoredRecord[], tampered: { seq: number } | null): RunFacts {
  const st = runState(records)
  const workflow = json?.workflow ?? st.start?.workflow ?? 'run'
  const gen = st.open ?? st.latest
  // The generation's own records: a resumed execute run numbers its attempts from 1 again.
  const since = gen ? records.filter(r => r.seq > gen.seq) : records
  const endSeq = st.latest?.endSeq ?? null
  const end = st.latest ? records.find(r => r.seq === endSeq) : records.find(r => r.kind === 'run.end' && r.body.generation === 0)
  return {
    run,
    workflow,
    status: runStatusOf(st, tampered !== null),
    open: st.open !== null,
    generation: gen?.n ?? 0,
    openedAt: gen?.openedAt ?? st.startedAt,
    endedAt: st.ended ? (end?.at ?? null) : null,
    repairSwarm: st.open?.repair ? oneLine(st.open.repair.swarm, 24) : null,
    tamperedAt: tampered?.seq ?? null,
    progress: progressOf(workflow, json, records, since),
  }
}

// ---------------------------------------------------------------------------
// The rows

/** Whole minutes (decision 7): `<1m`, `14m`, `2h 05m`. */
export function elapsed(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / MIN)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

const lead = (glyph: string, color: string): SwarmSpan[] => [{ text: glyph, color }, { text: ' litter · ' }]
const runLabel = (f: RunFacts): SwarmSpan[] => [{ text: `${oneLine(f.workflow, 16)} ` }, { text: oneLine(f.run, 72), color: 'cyan' }]
const runButtons = (run: string, key: string): BandButton[] => [
  { key: `band:board:${run}`, label: 'Board' },
  { key: `band:hide:${key}`, label: 'Hide' },
]

/** An open generation's progress, by workflow (WP-CB, "The rows"); a repair generation's is its swarm. */
function progressSpans(f: RunFacts, inflight: Inflight): SwarmSpan[] {
  if (f.tamperedAt !== null) return [{ text: `ledger tampered at ${f.tamperedAt}`, color: 'error' }]
  if (f.repairSwarm !== null) return [{ text: `↻ repair swarm ${f.repairSwarm}`, color: 'background' }]
  const g = f.progress
  switch (g?.kind) {
    case 'execute': {
      if (g.gates === 0) return [{ text: "the gates can't be read", dim: true }]
      const out: SwarmSpan[] = [{ text: `gate ${g.index}/${g.gates}` }]
      if (g.current === null) return out
      const gate = oneLine(g.current, 32)
      if (inflight === 'land') return [...out, SEP, { text: `landing ${gate}` }]
      const retry = g.attempt > 1
      if (!retry && inflight !== 'critique') return out
      out.push(SEP, { text: gate })
      if (retry) out.push({ text: ' ' }, { text: `retry ${g.attempt - 1}`, color: 'warning' })
      if (inflight === 'critique') out.push({ text: ' critic' })
      return out
    }
    case 'design':
      if (g.version === null) return [{ text: 'no proposal yet', dim: true }]
      return [{ text: g.version }, SEP, g.pass === null ? { text: 'awaiting the critic', dim: true } : { text: `${g.pass}/${g.of} pass` }]
    case 'fanout': {
      const step = inflight === 'land' ? 'landing' : g.step
      return [{ text: `${g.done}/${g.tasks} tasks` }, ...(step ? [SEP, { text: step }] : [])]
    }
    case 'plan':
      return [{ text: plural(g.records, 'record') }]
    default:
      return [{ text: 'running' }]
  }
}

function activeRow(f: RunFacts, inflight: Inflight, now: number): BandRow {
  // A stopping or tampered run's glyph says so; a running or repairing one's is ▸ (the repair says itself in the progress).
  const st = statusWord(f.status === 'stopping' || f.status === 'ledger_tampered' ? f.status : 'running')
  const spans: SwarmSpan[] = [...lead(st.glyph, st.color), ...runLabel(f), SEP, ...progressSpans(f, inflight)]
  if (f.status === 'stopping') spans.push(SEP, { text: 'stopping', color: st.color })
  if (f.openedAt !== null) spans.push(SEP, { text: elapsed(now - f.openedAt), dim: true })
  const key = `run:${f.run}:${f.generation}:open`
  return { key, kind: 'run', spans, buttons: runButtons(f.run, key) }
}

/** What an ended run's row says after its status word: `7/7 landed`, `at G3`, a design's version. */
function outcomeSpans(f: RunFacts): SwarmSpan[] {
  if (f.tamperedAt !== null) return [{ text: ` at ${f.tamperedAt}` }]
  const g = f.progress
  switch (g?.kind) {
    case 'execute':
      if (f.status === 'halted' && g.current !== null) return [{ text: ` at ${oneLine(g.current, 32)}` }]
      return f.status === 'done' && g.gates > 0 ? [SEP, { text: `${g.landed}/${g.gates} landed` }] : []
    case 'design':
      return g.version === null ? [] : [SEP, { text: g.overall ? `${g.version} ${g.overall}` : g.version }]
    case 'fanout':
      return [SEP, { text: `${g.done}/${g.tasks} tasks` }, ...(g.landed ? [SEP, { text: 'landed' }] : [])]
    case 'plan':
      return [SEP, { text: plural(g.records, 'record') }]
    default:
      return []
  }
}

/** A run that ended: its status glyph and word in place of ▸ and the progress, and how long its last generation ran. */
function endedRow(f: RunFacts): BandRow {
  const st = statusWord(f.status)
  const spans: SwarmSpan[] = [...lead(st.glyph, st.color), ...runLabel(f), SEP, { text: f.status.replace(/_/g, ' '), color: st.color }, ...outcomeSpans(f)]
  if (f.openedAt !== null && f.endedAt !== null) spans.push(SEP, { text: elapsed(f.endedAt - f.openedAt), dim: true })
  const key = `run:${f.run}:${f.generation}:${f.status}`
  return { key, kind: 'ended', spans, buttons: runButtons(f.run, key) }
}

/**
 * A live swarm: its nodes counted as the browser words them, from the
 * admission table and the open questions (swarm/view.ts, statusOf): running
 * or settling, and ⚑ waiting on a question.
 */
function swarmRow(s: LiveSwarm, now: number): BandRow {
  const waiting = new Set(openQuestions(s.name).map(q => q.agentId))
  let running = 0
  for (const b of bindings(s.name)) {
    const st = admissionStatus(b.agentId)
    if ((st === 'running' || st === 'settling') && !waiting.has(b.agentId)) running++
  }
  const key = `swarm:${s.name}:${s.launch}`
  const spans: SwarmSpan[] = [
    { text: '▸', color: 'background' },
    { text: ' litter · swarm ' },
    { text: oneLine(s.name, 24), color: 'cyan' },
    SEP,
    { text: `${running} running`, color: 'background' },
    SEP,
    waiting.size > 0 ? { text: `${waiting.size} waiting`, color: 'warning' } : { text: '0 waiting' },
  ]
  if (s.state === 'stopping') spans.push(SEP, { text: 'stopping', color: 'warning' })
  if (s.lost) spans.push(SEP, { text: 'lost to another session', color: 'error' })
  else if (s.readOnly) spans.push(SEP, { text: 'read-only', color: 'inactive' })
  spans.push(SEP, { text: elapsed(now - s.startedAt), dim: true })
  return {
    key,
    kind: 'swarm',
    spans,
    buttons: [
      { key: `band:browser:${s.name}`, label: 'Browser' },
      { key: `band:hide:${key}`, label: 'Hide' },
    ],
  }
}

/** Who is asking: `<gate> <role>` for a run agent, `<node> in swarm <name>` for a node, else the agent type. */
function whoOf(a: AskEntry): string {
  if (a.swarm && a.node) return `${oneLine(a.node, 24)} in swarm ${oneLine(a.swarm, 24)}`
  if (a.run && a.role) return oneLine(a.gate ? `${a.gate} ${a.role}` : a.role, 48)
  return oneLine(a.agentType || 'an agent', 48)
}

function askRow(a: AskEntry): BandRow {
  const detail = oneLine(a.detail, 120)
  const authorized = oneLine(a.authorized, 200)
  const spans: SwarmSpan[] = [
    { text: '⚑ asking', color: 'permission' },
    SEP,
    { text: whoOf(a), color: 'cyan' },
    { text: ` wants ${oneLine(a.tool, 40)}${detail ? `: ${detail}` : ''}` },
  ]
  if (authorized) spans.push(SEP, { text: `authorized: ${authorized}`, dim: true })
  return { key: `ask:${oneLine(a.key, 120)}`, kind: 'ask', spans, buttons: [] }
}

/** The row the band folds what it can't fit into: the asks first, then the swarms (decision 7). */
export function moreRow(n: { swarms?: number; asks?: number }): BandRow {
  const parts = [n.swarms ? `+${n.swarms} more ${n.swarms === 1 ? 'swarm' : 'swarms'}` : '', n.asks ? `+${n.asks} more asking` : ''].filter(Boolean)
  return { key: 'more', kind: 'more', spans: [n.asks ? { text: parts.join(' · '), color: 'permission' } : { text: parts.join(' · '), dim: true }], buttons: [] }
}

// ---------------------------------------------------------------------------
// Fitting the band (render.tsx draws what these answer; pure, so tier 2 tests them)

const wide = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd)

/** Terminal cells a text takes: wide characters two. */
export function cells(text: string): number {
  let n = 0
  for (const ch of text) n += wide(ch.codePointAt(0)!) ? 2 : 1
  return n
}

/** The cells left for a row's text at `columns`: less each button, drawn `[ label ]` on the terminal, and the cell before it. */
export function roomFor(buttons: readonly BandButton[], columns: number): number {
  if (!Number.isFinite(columns)) return Number.POSITIVE_INFINITY
  return Math.max(0, Math.floor(columns) - buttons.reduce((n, b) => n + cells(b.label) + 5, 0))
}

/** The spans cut to `room` cells, the last cut one ending in `…`: the buttons beside them are never cut. */
export function fitSpans(spans: readonly SwarmSpan[], room: number): SwarmSpan[] {
  if (spans.reduce((n, s) => n + cells(s.text), 0) <= room) return [...spans]
  if (room < 1) return []
  const out: SwarmSpan[] = []
  let left = room - 1
  for (const s of spans) {
    const w = cells(s.text)
    if (w <= left) {
      out.push(s)
      left -= w
      continue
    }
    let cut = ''
    for (const ch of s.text) {
      const c = cells(ch)
      if (c > left) break
      cut += ch
      left -= c
    }
    out.push({ ...s, text: `${cut}…` })
    break
  }
  return out
}

/**
 * At most `maxRows` rows: the runs' rows always, then the swarms, then the
 * asks, and one `+<k> more` row for what's left. Past `maxRows` runs (a band
 * a row or two high), the runs alone.
 */
export function fitRows(view: BandView, maxRows: number): BandRow[] {
  const rows = view.rows
  if (!Number.isFinite(maxRows) || rows.length <= maxRows) return rows
  const budget = Math.max(1, Math.floor(maxRows))
  const runs = rows.filter(r => r.kind !== 'swarm' && r.kind !== 'ask' && r.kind !== 'more')
  if (runs.length >= budget) return runs.slice(0, budget)
  const swarms = rows.filter(r => r.kind === 'swarm')
  const asks = rows.filter(r => r.kind === 'ask')
  let room = budget - runs.length - 1
  const shownSwarms = swarms.slice(0, room)
  room -= shownSwarms.length
  const shownAsks = asks.slice(0, room)
  const asking = Math.max(view.asking ?? 0, asks.length)
  return [...runs, ...shownSwarms, ...shownAsks, moreRow({ swarms: swarms.length - shownSwarms.length, asks: asking - shownAsks.length })]
}

// ---------------------------------------------------------------------------
// Module memory: the runs tracked, [Hide]'s keys, the last view

type Tracking = {
  litterDir: string
  runs: Set<string>
  seeded: boolean
  /** policy.json's size and mtime when last read, or `none`; read again only when it moves. */
  policyStamp: string | null
  active: { run: string; inflight: Inflight } | null
  /** By run: the head and minute the facts were read at; null facts when the ledger couldn't be read. */
  facts: Map<string, { key: string; facts: RunFacts | null }>
}

let tracking: Tracking | null = null
let hidden: string[] = []
let restored = false
let viewSeq = 0
let current: BandView | null = null
const EMPTY = JSON.stringify({ rows: [], asking: 0 })
let currentJson = EMPTY
/** Problems already in the debug log, by what they're about: each is said once until it clears. */
const logged = new Set<string>()

function logOnce(p: Ports, key: string, text: string): void {
  if (logged.has(key)) return
  logged.add(key)
  p.log(text)
}

/** A fresh module's memory, for tests: nothing tracked or hidden, no view, the real calls back in `deps`. */
export function resetBandForTests(): void {
  tracking = null
  hidden = []
  restored = false
  viewSeq = 0
  current = null
  currentJson = EMPTY
  logged.clear()
  Object.assign(deps, defaults)
}

/** The rows [Hide] hid, oldest first (tests). */
export const hiddenKeys = (): readonly string[] => hidden

type BandStore = { v: 1; session: string; hidden: string[] }

/** After a hot reload module memory is empty: the hidden keys come back from $.store, when this session wrote them. */
async function restoreHidden(p: Ports): Promise<void> {
  if (restored) return
  restored = true
  try {
    const raw = (await p.store.get(BAND_STORE_KEY)) as Partial<BandStore> | undefined
    if (!raw || raw.v !== 1 || raw.session !== (await p.sessionId()) || !Array.isArray(raw.hidden) || hidden.length > 0) return
    hidden = raw.hidden.filter((k): k is string => typeof k === 'string' && k.length <= 200).slice(-HIDDEN_MAX)
  } catch (err) {
    p.log(`band: the hidden rows weren't read back: ${errText(err)}`)
  }
}

async function saveHidden(p: Ports): Promise<void> {
  try {
    const value: BandStore = { v: 1, session: await p.sessionId(), hidden }
    await p.store.set(BAND_STORE_KEY, value)
  } catch (err) {
    p.log(`band: the hidden rows weren't saved: ${errText(err)}`)
  }
}

// ---------------------------------------------------------------------------
// The build

/** policy.json's run, read again only when the file's size or mtime moved. */
async function readActive(p: Ports, t: Tracking): Promise<void> {
  let stamp = 'none'
  try {
    const s = await p.fs.stat(policyPath(t.litterDir))
    stamp = `${s.size}:${s.mtimeMs}`
  } catch {
    // No policy.json: no run is active.
  }
  if (stamp === t.policyStamp) return
  t.policyStamp = stamp
  t.active = null
  if (stamp === 'none') {
    if (!(await p.fs.exists(t.litterDir).catch(() => false))) logOnce(p, `dir:${t.litterDir}`, `band: ${t.litterDir} isn't there, so no run has a row`)
    return
  }
  try {
    const run = (await readPolicy(p, t.litterDir))?.run
    if (run && typeof run.run === 'string' && RUN_ID.test(run.run)) {
      t.active = { run: run.run, inflight: run.inflight === 'critique' || run.inflight === 'land' ? run.inflight : null }
    }
    logged.delete(`policy:${t.litterDir}`)
  } catch (err) {
    logOnce(p, `policy:${t.litterDir}`, `band: policy.json can't be read, so the active run has no row: ${errText(err)}`)
  }
}

/** Once per module: the runs whose ledgers moved last, of the newest run folders, so a run that has just ended keeps its row. */
async function seed(p: Ports, t: Tracking): Promise<void> {
  t.seeded = true
  try {
    if (!(await p.fs.exists(t.litterDir))) return
    const names = (await p.fs.list(t.litterDir))
      .filter(e => e.kind === 'dir' && !e.isLink && RUN_ID.test(e.name))
      .map(e => e.name)
      .sort()
      .reverse()
      .slice(0, SEED_NAMES)
    const moved: { run: string; at: number }[] = []
    for (const run of names) {
      const s = await p.fs.stat(ledgerDir(runDir(t.litterDir, run))).catch(() => null)
      if (s) moved.push({ run, at: s.mtimeMs })
    }
    for (const m of moved.sort((a, b) => b.at - a.at).slice(0, SEED_RUNS)) t.runs.add(m.run)
  } catch (err) {
    logOnce(p, `dir:${t.litterDir}`, `band: ${t.litterDir} can't be listed, so only the active run has a row: ${errText(err)}`)
  }
}

const headOf = async (p: Ports, dir: string): Promise<string> => {
  try {
    const head = (await p.store.get(headKey(dir))) as { seq?: unknown; sha?: unknown } | undefined
    return head && typeof head.seq === 'number' ? `${head.seq}:${String(head.sha ?? '').slice(0, 12)}` : '0'
  } catch {
    return '?'
  }
}

/** A run's facts: the cached ones while its head and the minute stand, else its ledger again. Null when it can't be read. */
async function runFacts(p: Ports, t: Tracking, run: string, minute: number): Promise<RunFacts | null> {
  const key = `${await headOf(p, runDir(t.litterDir, run))}|${minute}`
  const hit = t.facts.get(run)
  if (hit && hit.key === key) return hit.facts
  let facts: RunFacts | null = null
  try {
    const loaded = await loadRun(p, t.litterDir, run)
    facts = factsOf(run, loaded.json, loaded.records, loaded.tampered)
    logged.delete(`run:${t.litterDir}:${run}`)
  } catch (err) {
    logOnce(p, `run:${t.litterDir}:${run}`, `band: run ${run}'s ledger can't be read, so it has no row: ${errText(err)}`)
  }
  t.facts.set(run, { key, facts })
  return facts
}

async function runRows(p: Ports, litterDir: string, now: number): Promise<BandRow[]> {
  if (tracking?.litterDir !== litterDir) tracking = { litterDir, runs: new Set(), seeded: false, policyStamp: null, active: null, facts: new Map() }
  const t = tracking
  await readActive(p, t)
  if (!t.seeded) await seed(p, t)
  const active = t.active
  if (active) t.runs.add(active.run)
  const minute = Math.floor(now / MIN)
  // The option's minutes, 0 to a day (options.ts); 0 keeps no ended row at all.
  const endedMs = getOptions().bandEndedMinutes * MIN
  const all: RunFacts[] = []
  for (const run of [...t.runs]) {
    const f = await runFacts(p, t, run, minute)
    // Kept while it's the active run, its generation is open, or it ended inside the window.
    const keep = run === active?.run || (f !== null && (f.open || (f.endedAt !== null && now - f.endedAt < endedMs)))
    if (!keep) {
      t.runs.delete(run)
      t.facts.delete(run)
    } else if (f) all.push(f)
  }
  const rows: BandRow[] = []
  // The active run first, then any other whose ledger shows an open generation (COMMON step 1).
  const isActive = (f: RunFacts) => (f.run === active?.run ? 1 : 0)
  const open = all.filter(f => f.open).sort((a, b) => isActive(b) - isActive(a) || (b.openedAt ?? 0) - (a.openedAt ?? 0))
  for (const f of open) rows.push(activeRow(f, f.run === active?.run ? active.inflight : null, now))
  // One ended row at most: the newest end.
  const ended = all.filter(f => !f.open && f.endedAt !== null && now - f.endedAt < endedMs).sort((a, b) => b.endedAt! - a.endedAt!)[0]
  if (ended) rows.push(endedRow(ended))
  return rows
}

function swarmRows(p: Ports, now: number): BandRow[] {
  try {
    // A run's repair swarm is shown in that run's row only.
    return liveSwarms()
      .filter(s => s.run === undefined)
      .map(s => swarmRow(s, now))
  } catch (err) {
    logOnce(p, 'swarms', `band: the live swarms can't be read: ${errText(err)}`)
    return []
  }
}

function askRows(p: Ports): { rows: BandRow[]; total: number } {
  let asks: AskEntry[]
  try {
    asks = [...deps.openAsks()].sort((a, b) => b.since - a.since)
    logged.delete('asks')
  } catch (err) {
    logOnce(p, 'asks', `band: the open asks can't be read: ${errText(err)}`)
    return { rows: [], total: 0 }
  }
  const rows = asks.slice(0, ASK_ROWS).map(askRow)
  if (asks.length > ASK_ROWS) rows.push(moreRow({ asks: asks.length - ASK_ROWS }))
  return { rows, total: asks.length }
}

/** The rows in their order (decision 7): the runs, the swarms, then the asks; a row [Hide] hid is left out. */
async function build(p: Ports): Promise<{ rows: BandRow[]; asking: number }> {
  await restoreHidden(p)
  const now = await p.now()
  const litterDir = session().litterDir
  const runs = litterDir ? await runRows(p, litterDir, now) : []
  const shown = [...runs, ...swarmRows(p, now)].filter(r => !hidden.includes(r.key))
  const asks = askRows(p)
  return { rows: [...shown, ...asks.rows], asking: asks.total }
}

/** Builds the view; true when its rows changed, and with them its `v`. */
async function rebuild(p: Ports): Promise<boolean> {
  const built = await build(p)
  const json = JSON.stringify(built)
  if (json === currentJson) {
    current ??= { view: 'band', v: viewSeq, ...built }
    return false
  }
  currentJson = json
  current = { view: 'band', v: ++viewSeq, ...built }
  return true
}

/**
 * Whether the band draws litter's rows for this render: a view with rows, no
 * survey holding the band (`e.props.hasSurvey`). False passes the render on.
 */
export function bandShows(view: BandView | null, e: BandRender): view is BandView {
  return !e.props.hasSurvey && view !== null && Array.isArray(view.rows) && view.rows.length > 0
}

/** The ui tick's first step (uitick.ts): the band's view again, written only when it changed. Never throws. */
export async function bandTick(p: Ports): Promise<void> {
  try {
    if (await rebuild(p)) await p.setView('band', current)
  } catch (err) {
    p.log(`band: the tick failed: ${errText(err)}`)
  }
}

/** After a /clear wiped $.state (clear.ts): the band's view again, written even when unchanged. */
export async function refreshBand(p: Ports): Promise<void> {
  try {
    await rebuild(p)
    await p.setView('band', current)
  } catch (err) {
    p.log(`band: the refresh failed: ${errText(err)}`)
  }
}

// ---------------------------------------------------------------------------
// The presses

type BandKey = { action: string; arg: string }

const parseKey = (key: string): BandKey | null => {
  if (!key.startsWith('band:')) return null
  const [, action, ...rest] = key.split(':')
  return action ? { action, arg: rest.join(':') } : null
}

/** What a press was for, in words: a run, a swarm, or a row's key (`run:<run>:…`, `swarm:<name>:…`). */
function aboutOf(k: BandKey): string {
  const [kind, name] = k.action === 'hide' ? k.arg.split(':') : [k.action === 'board' ? 'run' : 'swarm', k.arg]
  return `${kind === 'run' ? 'run' : 'swarm'} ${oneLine(name ?? '', 72)}`
}

async function handleBand(p: Ports, key: string, k: BandKey): Promise<void> {
  if (current === null) await rebuild(p)
  // A press drawn for a row the band no longer shows is stale: ignored, with a toast (as the board's).
  if (!(current?.rows ?? []).some(r => r.buttons.some(b => b.key === key))) {
    p.toast(`litter: the band doesn't show ${aboutOf(k)} now, so that was ignored`)
    return
  }
  switch (k.action) {
    case 'board': {
      if (!RUN_ID.test(k.arg)) return
      if (!(await deps.openBoard(p, k.arg))) p.toast(`litter: the board can't be drawn here now: run /litter-board ${k.arg}`)
      return
    }
    case 'browser': {
      if (!SWARM_NAME.test(k.arg)) return
      const line = await deps.openSwarmPane(p, k.arg)
      if (!line.startsWith('litter: the swarm pane shows ') || line.includes("can't draw")) p.toast(oneLine(line, 200))
      return
    }
    case 'hide': {
      // Until its state changes: the key carries the run's generation and state, or the swarm's launch.
      hidden = [...hidden.filter(h => h !== k.arg), k.arg].slice(-HIDDEN_MAX)
      await saveHidden(p)
      if (await rebuild(p)) await p.setView('band', current)
      return
    }
    default:
      return
  }
}

/**
 * The band's presses ([Board], [Browser], [Hide]). Its hook matches every
 * plugin's band button, so only litter's own `band:` keys are answered; the
 * rest pass on. Every press of litter's answers `{ element }`.
 */
export const onBandUi: { press: PortHook<BandPressHook> } = {
  press: async (p, e, next) => {
    const k = e.plugin === PLUGIN ? parseKey(e.element) : null
    if (!k) return next(e)
    try {
      await handleBand(p, e.element, k)
    } catch (err) {
      p.log(`band: ${e.element} failed: ${errText(err)}`)
      p.toast(`litter: that didn't work (${oneLine(errText(err), 120)}); claude --debug has the details`)
    }
    return { element: e.element }
  },
}
