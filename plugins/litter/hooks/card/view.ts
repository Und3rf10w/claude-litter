// The finished-run card (phase 5; plan 11, "Finished-run card"; COMMON step
// 2, decision 8): a litter run's task-notification row redrawn as a short
// verdict card, from the `cards` atom, built when a notification settles and
// rebuilt at session.start and after a /clear. Keys are
// `card:<action>[:<arg>]`. Owner: WP-CC.
//
// A card is built only for a generation whose run.end is recorded, from its
// run's ledger and run.json alone (plan section 9: the ledger is the record
// of truth), in the words summary.md uses. Every text is cleaned and cut
// here; render.tsx only lays it out.
//
// Which run a task is: settleNotices has already ended the run by the time
// noteCards runs, and the end deletes the task's $.store index (lifecycle.ts,
// recordEnd). So the cards keep their own, in module memory: every
// generation's task id of each run read. A task it doesn't know is looked for
// in the ledgers that changed since they were last read, newest first and a
// few at a time, so a notification of anything else costs a listing and one
// stat per run. A notification that arrives before its generation's end
// (a killed run still settling) waits, and is looked at again until the end
// is there: on the ui tick once its run's ledger moved (cardsTick, WP-CH),
// and at each prompt.submit.

import type { Ports } from '../ports'
import type { CardPressHook, CardRender, PortHook, PromptSubmitHook } from '../hooktypes'
import type { StoredRecord } from '../records/core'
import type { RunEndBody, RunJson } from '../records/run'
import type { Generation, RunState } from '../lifecycle'
import type { CardView, SwarmSpan } from '../../types/index'
import { readLedger } from '../ledgercore'
import { ledgerDir, runDir, runJsonPath, RUN_ID } from '../layout'
import { readJson } from '../fsx'
import { parseNotifications, runState } from '../lifecycle'
import { VERDICT_DIMENSIONS } from '../records/execute'
import { GAP_KINDS } from '../records/design'
import { verdictTarget } from '../verdicts'
import { fanoutTasks } from '../integrate'
import { barIds, proposalRecords, verdictRecords } from '../design/finalize'
import { session } from '../session'
import { oneLine } from '../swarm/view'
import { statusWord } from '../board/view'
import { openBoard } from '../board/pane'

// The board's opener (CD's file after CA), through one table so tier 2 can
// stand in for it (COMMON, "Another package's module"). The mod never changes it.
export const deps = {
  openBoard: (...a: Parameters<typeof openBoard>) => openBoard(...a),
}

/** The runs session.start and a /clear build cards for: run.find's newest (decision 8). */
export const CARD_RUNS = 20
/** The cards the view keeps at most; past it the oldest go, so a long session's view stays small. */
export const CARD_MAX = 60
/** How many changed ledgers a task the index doesn't know is looked for in. */
const SCAN_MAX = 3
/** A card's lines between its title and [Board]: six rows at most in all. */
const LINES_MAX = 4

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const named = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const short = (v: unknown): string => (typeof v === 'string' && /^[0-9a-f]{7,64}$/.test(v) ? v.slice(0, 7) : '')

// ---------------------------------------------------------------------------
// Module memory (none of it a fact anyone else reads; a hot reload empties it)

let seq = 0
/** The cards built in this module instance, oldest first; null until the first build. */
let cards: Map<string, CardView> | null = null
/** What the last write held, so a build that changed nothing writes nothing. An empty view draws as no view. */
let lastWritten = '{}'
/** Every generation's task id of the runs read, to its run. */
const runOfTask = new Map<string, string>()
/** Each run's ledger folder mtime when it was last read. */
const readMtime = new Map<string, number>()
/** Litter tasks noted before their generation's end. */
const waiting = new Set<string>()

export function resetCardsForTests(): void {
  seq = 0
  cards = null
  lastWritten = '{}'
  runOfTask.clear()
  readMtime.clear()
  waiting.clear()
}

/**
 * Whether this row may be a card: a task notification's
 * (`origin.kind === 'task-notification'`, with a `task.id`) and not expanded.
 * Runs for every message row before anything else, so it's synchronous and
 * cheap; false passes the render on.
 */
export function cardRow(e: CardRender): boolean {
  const { origin, task, isExpanded } = e.props
  return origin?.kind === 'task-notification' && typeof task?.id === 'string' && task.id !== '' && isExpanded === false
}

// ---------------------------------------------------------------------------
// The builders

/**
 * prompt.submit, right after settleNotices: a card for each notification
 * whose task is a litter run's generation that has ended, and for each one
 * noted earlier that has ended since. A notification for anything else
 * changes nothing.
 */
export async function noteCards(p: Ports, e: Parameters<PromptSubmitHook>[1]): Promise<void> {
  const litterDir = session().litterDir
  if (!litterDir) return
  const noted = e.origin?.kind === 'task-notification' && e.text.includes('<task-notification>') ? parseNotifications(e.text).map(n => n.taskId) : []
  await settleCards(p, litterDir, [...new Set([...noted, ...waiting])])
}

/**
 * The ui tick's step after the band's (uitick.ts; WP-CH): each notification
 * still waiting for its generation's end, looked at again once its run's
 * ledger moved since it was last read, so the card appears when the end is
 * recorded, with no prompt.submit. Nothing waiting: nothing read. Never throws.
 */
export async function cardsTick(p: Ports): Promise<void> {
  if (waiting.size === 0) return
  try {
    const litterDir = session().litterDir
    if (!litterDir) return
    const moved: string[] = []
    for (const taskId of [...waiting]) {
      const run = runOfTask.get(taskId)
      // One stat a tick: a ledger that hasn't changed can't hold the end yet.
      if (run !== undefined && readMtime.get(run) === (await ledgerMtime(p, litterDir, run))) continue
      moved.push(taskId)
    }
    await settleCards(p, litterDir, moved)
  } catch (err) {
    p.log(`card: the tick failed: ${errText(err)}`)
  }
}

/** The cards of these tasks whose generation has ended, written with the others' (noteCards, cardsTick). */
async function settleCards(p: Ports, litterDir: string, asked: readonly string[]): Promise<void> {
  if (asked.length === 0) return
  const found = new Map<string, CardView>()
  for (const taskId of asked) {
    try {
      const card = await cardForTask(p, litterDir, taskId)
      if (card) found.set(taskId, card)
    } catch (err) {
      waiting.delete(taskId)
      p.log(`card: task ${oneLine(taskId, 80)} keeps the engine's row: ${errText(err)}`)
    }
  }
  if (found.size === 0) return
  // After a hot reload the other rows' cards come back first, so the write doesn't drop them;
  // the tick and a prompt.submit can both get here, and the first to build keeps its map.
  if (cards === null) {
    const recent = await buildRecent(p, litterDir)
    cards ??= recent
  }
  for (const [taskId, card] of found) {
    cards.delete(taskId)
    cards.set(taskId, card)
  }
  await write(p, false)
}

/** session.start: the cards of the 20 newest runs, so a resumed session's rows get theirs. */
export async function restoreCards(p: Ports): Promise<void> {
  const litterDir = session().litterDir
  cards = litterDir ? await buildRecent(p, litterDir) : new Map()
  await write(p, false)
}

/** After a /clear wiped $.state (clear.ts): the cards again, written even when they're the same. */
export async function refreshCards(p: Ports): Promise<void> {
  const litterDir = session().litterDir
  cards = litterDir ? await buildRecent(p, litterDir) : new Map()
  await write(p, true)
}

async function write(p: Ports, force: boolean): Promise<void> {
  const map = cards ?? new Map<string, CardView>()
  for (const oldest of [...map.keys()].slice(0, Math.max(0, map.size - CARD_MAX))) map.delete(oldest)
  const byTask = Object.fromEntries(map)
  const key = JSON.stringify(byTask)
  if (!force && key === lastWritten) return
  await p.setView('cards', { view: 'cards', v: ++seq, byTask })
  lastWritten = key
}

type RunFacts = { run: string; json: RunJson | null; records: StoredRecord[]; tampered: { seq: number; reason: string } | null }

/** The card of a task's generation; null for a task that isn't litter's, or whose end isn't recorded yet (it waits). */
async function cardForTask(p: Ports, litterDir: string, taskId: string): Promise<CardView | null> {
  const known = runOfTask.get(taskId)
  // Either way the run is the task's: the index says so, or its ledger (up to any tamper point) does.
  const f = known !== undefined ? await loadRun(p, litterDir, known) : await findTask(p, litterDir, taskId)
  waiting.delete(taskId)
  if (!f) return null
  if (f.tampered) {
    p.log(`card: run ${f.run}'s ledger is tampered at ${f.tampered.seq}, so task ${oneLine(taskId, 80)} keeps the engine's row`)
    return null
  }
  const st = runState(f.records)
  const gen = st.generations.find(g => g.repair === null && g.taskId === taskId)
  if (!gen) return null
  if (!gen.end) {
    waiting.add(taskId)
    return null
  }
  return cardOf(f, st, gen)
}

/**
 * A task the index doesn't know: the run folders whose ledger changed since
 * it was last read, newest change first, SCAN_MAX of them read (each read
 * indexes all its generations). The run that just ended changed last.
 */
async function findTask(p: Ports, litterDir: string, taskId: string): Promise<RunFacts | null> {
  if (!(await p.fs.exists(litterDir))) return null
  const runs = (await p.fs.list(litterDir)).filter(e => e.kind === 'dir' && !e.isLink && RUN_ID.test(e.name)).map(e => e.name)
  const stamped = await Promise.all(runs.map(async run => ({ run, mtime: await ledgerMtime(p, litterDir, run) })))
  const changed = stamped.filter((s): s is { run: string; mtime: number } => s.mtime !== null && readMtime.get(s.run) !== s.mtime)
  changed.sort((a, b) => b.mtime - a.mtime || b.run.localeCompare(a.run))
  for (const { run, mtime } of changed.slice(0, SCAN_MAX)) {
    try {
      const f = await loadRun(p, litterDir, run)
      if (runOfTask.get(taskId) === run) return f
    } catch (err) {
      // Not read again until it changes, so one bad ledger isn't logged at every notification.
      readMtime.set(run, mtime)
      p.log(`card: run ${run}'s ledger can't be read: ${errText(err)}`)
    }
  }
  return null
}

async function ledgerMtime(p: Ports, litterDir: string, run: string): Promise<number | null> {
  try {
    return (await p.fs.stat(ledgerDir(runDir(litterDir, run)))).mtimeMs
  } catch {
    return null
  }
}

/** run.json when it's this run's, version 1; else null, with a log line when it can't be read. */
async function readRunJson(p: Ports, litterDir: string, run: string): Promise<RunJson | null> {
  try {
    const j = await readJson<RunJson>(p, runJsonPath(runDir(litterDir, run)))
    return j && j.v === 1 && j.run === run ? j : null
  } catch (err) {
    p.log(`card: ${run}/run.json unreadable: ${errText(err)}`)
    return null
  }
}

/** A run's run.json and ledger, each read once; its generations' task ids go into the index. */
async function loadRun(p: Ports, litterDir: string, run: string, json?: RunJson | null): Promise<RunFacts> {
  // The stamp before the read: a record appended during it reads as a change next time.
  const mtime = await ledgerMtime(p, litterDir, run)
  const j = json === undefined ? await readRunJson(p, litterDir, run) : json
  const ledger = await readLedger(p, runDir(litterDir, run), run)
  if (mtime !== null) readMtime.set(run, mtime)
  for (const g of runState(ledger.records).generations) if (g.taskId !== '') runOfTask.set(g.taskId, run)
  return { run, json: j, records: ledger.records, tampered: ledger.tampered }
}

/**
 * The cards of the newest CARD_RUNS runs, in run.find's order (litterdir.ts:
 * newest start first, then the run id), oldest first in the map. The start is
 * run.json's `created`, which run.start writes with its record, so no ledger
 * is read to sort and each of these is read once. A run whose run.json isn't
 * its own is left out, as run.find leaves it out.
 */
async function buildRecent(p: Ports, litterDir: string): Promise<Map<string, CardView>> {
  const map = new Map<string, CardView>()
  if (!(await p.fs.exists(litterDir))) return map
  const names = (await p.fs.list(litterDir)).filter(e => e.kind === 'dir' && !e.isLink && RUN_ID.test(e.name)).map(e => e.name)
  const found = (await Promise.all(names.map(async run => ({ run, json: await readRunJson(p, litterDir, run) })))).filter(
    (r): r is { run: string; json: RunJson } => r.json !== null,
  )
  const created = (j: RunJson) => (typeof j.created === 'number' ? j.created : 0)
  found.sort((a, b) => created(b.json) - created(a.json) || b.run.localeCompare(a.run))
  for (const { run, json } of found.slice(0, CARD_RUNS).reverse()) {
    try {
      const f = await loadRun(p, litterDir, run, json)
      if (f.tampered) {
        p.log(`card: run ${run}'s ledger is tampered at ${f.tampered.seq}, so its rows keep the engine's drawing`)
        continue
      }
      const st = runState(f.records)
      for (const g of st.generations) {
        if (g.repair !== null || g.taskId === '' || !g.end) continue
        map.set(g.taskId, cardOf(f, st, g))
        waiting.delete(g.taskId)
      }
    } catch (err) {
      p.log(`card: run ${run}'s cards weren't built: ${errText(err)}`)
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// A card's content (plan 11; COMMON decisions 8 and 12)

/** A generation's time, run.launch to run.end, as the engine draws a duration (`2m 2s`). */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** The reason of an end that isn't done, on one line: `error` for a failure, else `warning`. */
function reasonLine(end: RunEndBody): SwarmSpan[] | null {
  if (end.status === 'done' || !named(end.reason)) return null
  const color = end.status === 'failed' || end.status === 'launch_failed' ? 'error' : 'warning'
  return [{ text: oneLine(`${end.status}: ${end.reason}`, 300), color }]
}

/** One generation's card: the status, the run and its time, then what the ledger says of how it ended. */
function cardOf(f: RunFacts, st: RunState, gen: Generation): CardView {
  const end = gen.end!
  const workflow = f.json?.workflow ?? st.start?.workflow ?? 'unknown'
  const sw = statusWord(end.status)
  const endAt = f.records.find(r => r.seq === gen.endSeq)?.at
  const title: SwarmSpan[] = [
    { text: `${sw.glyph} ${oneLine(sw.text, 40)}`, color: sw.color, bold: true },
    { text: ` · litter · ${oneLine(workflow, 40)} ` },
    { text: f.run, color: 'cyan' },
  ]
  if (gen.repair) title.push({ text: ' · repair' })
  else if (gen.n > 1) title.push({ text: ` · generation ${gen.n}` })
  if (typeof endAt === 'number') title.push({ text: ` · ${duration(endAt - gen.openedAt)}`, dim: true })

  const endSeq = gen.endSeq ?? Infinity
  const before = f.records.filter(r => r.seq < endSeq)
  const after = f.records.filter(r => r.seq > endSeq)
  let lines: SwarmSpan[][]
  // A design's stop says its reason in the summary's words; any other run's end says it as it was recorded.
  if (workflow === 'design') lines = designLines(f.json, before, after, end)
  else {
    const reason = reasonLine(end)
    const own = workflow === 'execute' ? executeLines(f.json, before, end) : workflow === 'fanout' ? fanoutLines(f.json, before) : []
    lines = [...own, ...(reason ? [reason] : [])]
  }

  return { taskId: gen.taskId, run: f.run, title, lines: lines.slice(0, LINES_MAX), buttons: [{ key: `card:board:${f.run}`, label: 'Board' }] }
}

/** run.json's gate ids: the ones this run works, and a continuation's earlier lands (`args.landed`). */
function gateIds(json: RunJson | null): { worked: string[]; earlier: string[] } {
  const ids = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap(g => (isObj(g) && typeof g.id === 'string' ? [g.id] : [])) : [])
  const worked = ids(json?.args?.gates)
  return { worked, earlier: ids(json?.args?.landed).filter(id => !worked.includes(id)) }
}

/** execute: the gates landed and the last land's commit; when it didn't end done, the gate that didn't land. */
function executeLines(json: RunJson | null, before: readonly StoredRecord[], end: RunEndBody): SwarmSpan[][] {
  const { worked, earlier } = gateIds(json)
  const lands = before.filter(r => r.kind === 'land' && typeof r.body.gate === 'string' && typeof r.body.commit === 'string')
  const landed = new Set(lands.map(r => String(r.body.gate)))
  const total = worked.length + earlier.length
  const count = total > 0 ? `${worked.filter(id => landed.has(id)).length + earlier.length}/${total} gates landed` : `${landed.size} landed`
  const head: SwarmSpan[] = [{ text: count }]
  const last = short(lands.at(-1)?.body.commit)
  if (last) head.push({ text: ' · last land ' }, { text: last, color: 'yellow' })
  const out = [head]
  const stuck = end.status === 'done' ? undefined : worked.find(id => !landed.has(id))
  if (stuck) out.push(...stuckLines(before, stuck))
  return out
}

type Dim = { pass?: unknown }

/**
 * The gate that didn't land: its attempt and its last verdict's failing
 * dimensions, then the plan gap or the rule clash. An executor's stop on a
 * plan gap after that verdict wins, as it does for the bridge and the summary.
 * Nothing for a gate with no attempt, verdict or stop.
 */
function stuckLines(records: readonly StoredRecord[], gate: string): SwarmSpan[][] {
  let attempt = 0
  for (const r of records) {
    const counts = r.kind === 'verify' || (r.kind === 'task.result' && r.body.role === 'executor')
    if (counts && r.body.gate === gate && Number.isSafeInteger(r.body.attempt)) attempt = Math.max(attempt, r.body.attempt as number)
  }
  const gateOf = (r: StoredRecord): string | null => (typeof r.body.gate === 'string' ? r.body.gate : (verdictTarget(records, r)?.gate ?? null))
  const verdict = records.filter(r => r.kind === 'verdict' && VERDICT_DIMENSIONS.every(d => isObj(r.body[d])) && gateOf(r) === gate).at(-1)
  const result = records.filter(r => r.kind === 'task.result' && r.body.role === 'executor' && r.body.gate === gate).at(-1)
  const res = result && (!verdict || result.seq > verdict.seq) ? result.body.result : null
  const stop = isObj(res) && res.status === 'blocked' && named(res.plan_gap) ? res.plan_gap : null
  const failing = verdict ? VERDICT_DIMENSIONS.filter(d => (verdict.body[d] as Dim).pass !== true) : []
  // A gate nothing was tried on didn't halt the run (the board's halted state asks the same).
  if (attempt === 0 && !verdict && stop === null) return []

  const head: SwarmSpan[] = [{ text: `${oneLine(gate, 40)}${attempt > 0 ? `, attempt ${attempt}` : ''}: ` }]
  if (stop !== null) head.push({ text: 'its executor stopped before the attempt was judged', color: 'warning' })
  else if (failing.length > 0) head.push({ text: `failed ${failing.join(', ')}`, color: 'warning' })
  else head.push({ text: verdict ? 'its last verdict passed every dimension' : 'no verdict recorded' })
  const out = [head]
  const gap = stop ?? (verdict && named(verdict.body.plan_gap) ? verdict.body.plan_gap : null)
  if (gap !== null) out.push([{ text: oneLine(`plan gap: ${gap}`, 300), color: 'warning' }])
  else if (verdict && named(verdict.body.rule_clash)) out.push([{ text: oneLine(`rule clash: ${verdict.body.rule_clash}`, 300), color: 'warning' }])
  return out
}

/** `by` of a done design, and an early return's reason, in design/summary.ts's words. */
const BY: Record<string, string> = {
  approved: 'the critic approved',
  'no-new-material': 'a round added nothing new',
  'max-rounds': 'max rounds reached',
  budget: 'the token budget ran out',
}
const NEEDS: Record<string, string> = {
  'goal-change': 'a reframe that changes the goal',
  'blocking-decision': 'a blocking decision',
  'user-gap': 'a gap only you can close',
}

/** design: the latest version and its verdict, how it stopped when it isn't approved, and a plan's delivery. */
function designLines(json: RunJson | null, before: readonly StoredRecord[], after: readonly StoredRecord[], end: RunEndBody): SwarmSpan[][] {
  const out: SwarmSpan[][] = []
  const version = proposalRecords(before).at(-1)?.body.version
  if (typeof version !== 'string') out.push([{ text: 'no version recorded' }])
  else out.push(versionLine(version, verdictRecords(before).filter(v => v.body.version === version).at(-1), barIds(json) ?? []))
  const pl = end.payload ?? {}
  if (end.status === 'done') {
    if (pl.outcome !== 'approved') {
      const by = typeof pl.by === 'string' ? (BY[pl.by] ?? oneLine(pl.by, 60)) : 'no outcome recorded'
      out.push([{ text: `holding: ${by}`, color: 'warning' }])
    }
  } else if (end.status === 'needs_user') {
    out.push([{ text: oneLine(`needs you: ${NEEDS[end.reason ?? ''] ?? end.reason ?? 'no reason recorded'}`, 300), color: 'permission' }])
  } else if (end.status === 'halted' && end.reason === 'source-changed') {
    out.push([{ text: 'halted: the checkout changed during a round (source-changed)', color: 'warning' }])
  } else {
    const r = reasonLine(end)
    if (r) out.push(r)
  }
  if (json?.args?.deliverable === 'plan') out.push(deliveryLine(after))
  return out
}

/** `v3 APPROVED · 8/8 pass`, or `v4 HOLDING · 2 open: C3 investigation, C5 design`: every bar item, judged or not. */
function versionLine(version: string, verdict: StoredRecord | undefined, bar: readonly string[]): SwarmSpan[] {
  const v = oneLine(version, 20)
  if (!verdict) return [{ text: `${v} · no verdict` }]
  const criteria = (Array.isArray(verdict.body.criteria) ? verdict.body.criteria : []).filter(isObj)
  const ids = [...new Set([...bar, ...criteria.flatMap(c => (typeof c.id === 'string' ? [c.id] : []))])]
  const open = ids.flatMap(id => {
    const c = criteria.find(x => x.id === id)
    if (c?.verdict === 'PASS') return []
    const kind = c ? ((GAP_KINDS as readonly unknown[]).includes(c.gap_kind) ? String(c.gap_kind) : oneLine(String(c.verdict), 20)) : 'not judged'
    return [`${oneLine(id, 20)} ${kind}`]
  })
  const overall = typeof verdict.body.overall === 'string' ? oneLine(verdict.body.overall, 20) : 'no overall'
  const out: SwarmSpan[] = [{ text: `${v} ` }, { text: overall, color: overall === 'APPROVED' ? 'success' : 'warning' }]
  if (ids.length === 0) out.push({ text: ' · no criterion judged' })
  else if (open.length === 0) out.push({ text: ` · ${ids.length}/${ids.length} pass` })
  else out.push({ text: ` · ${oneLine(`${open.length} open: ${open.join(', ')}`, 300)}` })
  if (verdict.body.source_changed === true) out.push({ text: ' · source changed', color: 'warning' })
  return out
}

/** A plan's delivery, from the design.deliver recorded after this end (design/finalize.ts). */
function deliveryLine(after: readonly StoredRecord[]): SwarmSpan[] {
  const rec = after.find(r => r.kind === 'design.deliver')
  if (!rec) return [{ text: "plan.md not delivered: the delivery didn't finish", color: 'warning' }]
  if (named(rec.body.refused)) return [{ text: oneLine(`plan.md not delivered: ${rec.body.refused}`, 300), color: 'warning' }]
  return [{ text: 'plan.md delivered', color: 'success' }]
}

/** fanout: the writers done of all, and the land's commit (the halt's reason follows from reasonLine). */
function fanoutLines(json: RunJson | null, before: readonly StoredRecord[]): SwarmSpan[][] {
  const out: SwarmSpan[][] = []
  if (json) {
    const tasks = fanoutTasks(json)
    const writers = tasks.filter(t => t.writes)
    const done = writers.filter(t => {
      const res = before.filter(r => r.kind === 'task.result' && r.body.task === t.id).at(-1)?.body.result
      return isObj(res) && res.status === 'done' && res.unbound !== true
    }).length
    const readOnly = tasks.length - writers.length
    const parts = [...(writers.length > 0 ? [`${done}/${writers.length} writers done`] : []), ...(readOnly > 0 ? [`${readOnly} read-only`] : [])]
    if (parts.length > 0) out.push([{ text: parts.join(' · ') }])
  }
  const land = short(before.filter(r => r.kind === 'land' && r.body.gate === 'fanout').at(-1)?.body.commit)
  if (land) out.push([{ text: 'landed ' }, { text: land, color: 'yellow' }])
  return out
}

// ---------------------------------------------------------------------------
// The presses

/**
 * The card's presses: `card:board:<run>` opens the board on that run while it
 * still has a run.json, else a toast says it's gone. Litter's keys are
 * answered `{ element }`; any other key passes on (CA: matched on the
 * component alone).
 */
export const onCardUi: { press: PortHook<CardPressHook> } = {
  press: async (p, e, next) => {
    if (!e.element.startsWith('card:')) return next(e)
    const m = /^card:board:(.+)$/.exec(e.element)
    const run = m && RUN_ID.test(m[1]!) ? m[1]! : null
    if (run === null) return { element: e.element }
    const litterDir = session().litterDir
    if (!litterDir || !(await p.fs.exists(runJsonPath(runDir(litterDir, run))))) {
      p.toast(`litter: run ${run} is gone (its run.json isn't there), so there's no board to open`)
      return { element: e.element }
    }
    if (!(await deps.openBoard(p, run))) p.toast(`litter: the board didn't open here; run /litter-board ${run}`)
    return { element: e.element }
  },
}
