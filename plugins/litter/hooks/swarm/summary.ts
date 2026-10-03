// WP-O: the browser's generated summary (15.6, "The summary"): triggers
// noted by the hooks, run from O's own tick (never a send), inputs capped and
// hashed, p.complete with prompts/swarm-summary.ts, the last good summary
// kept, and swarm.summary when the goal line changes. Display-only: nothing
// here feeds an agent.
//
//  - noteSummaryTrigger only marks the swarm due (L and P call it from their
//    hooks); clear.ts's 2 s tick calls summaryTick, which runs a due swarm's
//    summary once summaryEverySec has passed since its last call.
//  - Only a swarm this session owns is summarised: a read-only one's ledger
//    is another session's to write.
//  - The last good summary is kept in module memory and in $.store, so a
//    reload shows it again (summaryOf is synchronous, so the tick loads it).

import type { SessionMessage } from 'claude-code'
import type { Ports } from '../ports'
import type { StoredRecord } from '../records/core'
import type { SwarmSummaryBody } from '../records/swarm'
import type { LiveSwarm, NodeBinding, SwarmSummary } from './types'
import { SUMMARY_LABELS, SWARM_SUMMARY } from '../prompts/swarm-summary'
import { appendLaunchRecord, readLaunchLedger } from '../records/swarm'
import { sha256 } from '../fsx'
import { getOptions, session } from '../session'
import { agentStopped, binding, bindings, lastReport, liveSwarms, roundsUsed, spawnsUsed, status, stopped } from './state'

/**
 * Why a summary is due: the lead's turn ended, a node messaged the lead (L);
 * a node finished, the guard denied a node, a node reported (P).
 * C's choice of names.
 */
export type SummaryTrigger = 'lead-turn' | 'to-lead' | 'finished' | 'denied' | 'report'

/** The inputs, in all (15.6, "Its inputs"). */
export const SUMMARY_INPUT_MAX = 24 * 1024
/** Each orchestrator's last report, and each of the lead's replies. */
export const REPORT_INPUT_MAX = 1536
export const LEAD_INPUT_MAX = 3 * 1024
export const EVENTS_KEPT = 30
const LEAD_REPLIES = 2
// Caps of our own, so the parts the plan leaves open can't crowd the rest out.
const GOAL_INPUT_MAX = 2 * 1024
const NODES_INPUT_MAX = 4 * 1024
const EVENT_INPUT_MAX = 512
/** The parsed parts, bounded: they're kept in $.store. */
const PART_MAX = 400
const PROGRESS_KEPT = 3
const WAITING_KEPT = 10
/** The plugin option's floor (plugin.json), in case a value below it reaches the mod. */
const MIN_EVERY_SEC = 10

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The last good summary of a launch, as kept in memory and $.store. */
type Kept = {
  launch: string
  summary: Omit<SwarmSummary, 'stale'>
  /** The trigger count when its inputs were read: a later trigger makes it stale. */
  seen: number
}

/** `litter.swarm.summary.<litterDir>.<swarm>`: the last good summary, its inputs' hash and the goal line last recorded. */
export const summaryKey = (litterDir: string, swarm: string) => `litter.swarm.summary.${litterDir}.${swarm}`
type Stored = { v: 1; launch: string; summary: Omit<SwarmSummary, 'stale'>; hash: string | null; goal: string | null }

const due = new Set<string>()
const triggers = new Map<string, number>()
const kept = new Map<string, Kept>()
const lastCallAt = new Map<string, number>()
const lastHash = new Map<string, string>()
const recordedGoal = new Map<string, string>()
/** `<swarm>\0<launch>` once its stored summary and goal line were read back. */
const loaded = new Set<string>()
/** `<swarm>\0<launch>` once End records its end: a summary call still out for it is dropped. */
const ending = new Set<string>()
let ticking = false

/** Synchronous: only marks the swarm due. */
export function noteSummaryTrigger(swarm: string, why: SummaryTrigger): void {
  due.add(swarm)
  triggers.set(swarm, (triggers.get(swarm) ?? 0) + 1)
}

/**
 * End's, synchronously before it appends swarm.end (FIX-U, U4): from then on
 * a summary call for that launch that answers late records and stores
 * nothing. Its check and its append run in one step, and appends to a ledger
 * go in call order, so no swarm.summary lands after swarm.end.
 */
export function noteSwarmEnding(swarm: string, launch: string): void {
  ending.add(`${swarm}\u0000${launch}`)
}

/** Whether the launch a summary call was made for is still live here, owned, and not ending. */
function stillCurrent(s: LiveSwarm): boolean {
  const now = liveSwarms().find(x => x.name === s.name)
  return now !== undefined && now.launch === s.launch && !now.readOnly && !now.lost && !ending.has(`${s.name}\u0000${s.launch}`)
}

/** The last good summary, with whether a newer event exists; null when there's none. */
export function summaryOf(swarm: string): SwarmSummary | null {
  const k = kept.get(swarm)
  if (!k) return null
  const live = liveSwarms().find(s => s.name === swarm)
  if (live && live.launch !== k.launch) return null
  return {
    goalNow: k.summary.goalNow,
    progress: [...k.summary.progress],
    waitingOnYou: [...k.summary.waitingOnYou],
    at: k.summary.at,
    stale: (triggers.get(swarm) ?? 0) > k.seen,
  }
}

/**
 * clear.ts's tick: each due swarm this session owns gets its summary once
 * summaryEverySec has passed since its last call. One tick at a time, since a
 * call can take up to 20 s. Never throws.
 */
export async function summaryTick(p: Ports): Promise<void> {
  if (ticking) return
  ticking = true
  try {
    const litterDir = session().litterDir
    if (!litterDir) return
    const owned = liveSwarms().filter(s => !s.readOnly && !s.lost)
    for (const s of owned) {
      try {
        await loadKept(p, litterDir, s)
        if (due.has(s.name)) await summarise(p, litterDir, s)
      } catch (err) {
        p.log(`swarm ${s.name}: the summary failed: ${errText(err)}`)
      }
    }
    // A swarm that ended takes its summary with it (its records stay in the ledger).
    const live = new Set(liveSwarms().map(s => s.name))
    for (const name of [...kept.keys()]) if (!live.has(name)) forget(name)
  } finally {
    ticking = false
  }
}

function forget(name: string): void {
  due.delete(name)
  triggers.delete(name)
  kept.delete(name)
  lastCallAt.delete(name)
  lastHash.delete(name)
  recordedGoal.delete(name)
  for (const k of [...loaded]) if (k.startsWith(`${name}\u0000`)) loaded.delete(k)
  for (const k of [...ending]) if (k.startsWith(`${name}\u0000`)) ending.delete(k)
}

/** Once per launch in this process: the stored summary, or the goal line from the ledger's last swarm.summary. */
async function loadKept(p: Ports, litterDir: string, s: LiveSwarm): Promise<void> {
  const key = `${s.name}\u0000${s.launch}`
  if (loaded.has(key)) return
  loaded.add(key)
  if (kept.get(s.name)?.launch === s.launch) return
  const raw = (await p.store.get(summaryKey(litterDir, s.name))) as Stored | undefined
  if (raw && raw.v === 1 && raw.launch === s.launch && raw.summary && typeof raw.summary.goalNow === 'string') {
    kept.set(s.name, { launch: s.launch, summary: raw.summary, seen: triggers.get(s.name) ?? 0 })
    if (raw.hash) lastHash.set(s.name, raw.hash)
    if (raw.goal !== null) recordedGoal.set(s.name, raw.goal)
    return
  }
  const last = (await readLaunchLedger(p, litterDir, s.name, s.launch)).records.filter(r => r.kind === 'swarm.summary').at(-1)
  if (last) recordedGoal.set(s.name, sameLine((last.body as unknown as SwarmSummaryBody).goal))
}

async function summarise(p: Ports, litterDir: string, s: LiveSwarm): Promise<void> {
  const model = getOptions().summaryModel
  // Unset or `off` (options.ts maps both to undefined): no call, and nothing stays due.
  if (model === undefined) {
    due.delete(s.name)
    return
  }
  const now = await p.now()
  const every = Math.max(MIN_EVERY_SEC, getOptions().summaryEverySec) * 1000
  const last = lastCallAt.get(s.name)
  if (last !== undefined && now - last < every) return // debounced: it stays due
  const seen = triggers.get(s.name) ?? 0
  due.delete(s.name)
  const prompt = await summaryInputs(p, litterDir, s)
  const hash = await sha256(prompt)
  if (hash === lastHash.get(s.name)) {
    // The same inputs as the last call: the summary still stands for them.
    const k = kept.get(s.name)
    if (k) k.seen = seen
    return
  }
  lastCallAt.set(s.name, now)
  let r
  try {
    r = await p.complete({ model, system: SWARM_SUMMARY, prompt, maxTokens: 300, effort: 'low', timeoutMs: 20_000 })
  } catch (err) {
    due.add(s.name)
    p.log(`swarm ${s.name}: the summary call was refused: ${errText(err)}`)
    return
  }
  // The call can take 20 s: the swarm may have ended meanwhile, and its summary goes with it.
  // Nothing below awaits before the append, so this check holds for it.
  if (!stillCurrent(s)) return
  if (!r.isAnswered) {
    // It fails quietly: the last good summary stays, and the next tick past the debounce tries again.
    due.add(s.name)
    p.log(`swarm ${s.name}: no summary (${r.reason})`)
    return
  }
  lastHash.set(s.name, hash)
  const parsed = parseSummary(r.text)
  if (!parsed) {
    p.log(`swarm ${s.name}: the summary's answer didn't have its three parts; the last good one stays`)
    return
  }
  const summary = { ...parsed, at: now }
  kept.set(s.name, { launch: s.launch, summary, seen })
  const goal = sameLine(parsed.goalNow)
  if (goal !== recordedGoal.get(s.name)) {
    const body: SwarmSummaryBody = { text: summaryText(summary), goal: parsed.goalNow, inputsHash: hash, usage: r.usage ?? null }
    await appendLaunchRecord(p, litterDir, s.name, s.launch, 'swarm.summary', body)
    recordedGoal.set(s.name, goal)
    if (!stillCurrent(s)) return
  }
  const stored: Stored = { v: 1, launch: s.launch, summary, hash, goal: recordedGoal.get(s.name) ?? null }
  await p.store.set(summaryKey(litterDir, s.name), stored)
}

// ---------------------------------------------------------------------------
// The inputs

const encoder = new TextEncoder()
const byteLength = (text: string): number => encoder.encode(text).length

/** Cut to at most `max` UTF-8 bytes, on a character boundary and never inside an entity. */
function cut(text: string, max: number): string {
  if (text.length * 3 <= max) return text
  let bytes = 0
  let end = 0
  for (const ch of text) {
    const n = byteLength(ch)
    if (bytes + n > max) break
    bytes += n
    end += ch.length
  }
  return end === text.length ? text : text.slice(0, end).replace(/&[a-z]*$/, '')
}

/** Material, not markup: the tags can't be closed from inside, and the model reads it as text. */
const material = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const one = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** A node's status, as the browser words it. */
function statusWord(swarm: string, agentId: string): string {
  const st = status(agentId)
  if (st === 'running') return 'running'
  if (st === 'settling') return 'finishing its turn'
  const stop = stopped(swarm).find(x => x.agentId === agentId)
  if (stop) return `stopped (${one(stop.reason)})`
  return agentStopped(agentId) ? 'finished' : 'idle'
}

function parentName(b: NodeBinding): string {
  if (b.parent === null) return 'the lead'
  const parent = binding(b.parent)
  return parent ? `${parent.node} #${parent.n}` : b.parent
}

function nodeRows(s: LiveSwarm): string[] {
  const all = bindings(s.name).filter(b => b.kind !== 'child')
  const rows: string[] = []
  for (const node of s.spec.nodes) {
    const mine = all.filter(b => b.node === node.id).sort((a, b) => a.n - b.n)
    if (mine.length === 0) {
      rows.push(`${node.id} (${node.kind}): not started`)
      continue
    }
    for (const b of mine) {
      const where = b.kind === 'worker' ? `worker under ${parentName(b)}` : 'orchestrator'
      rows.push(`${node.id} #${b.n} (${where}): ${statusWord(s.name, b.agentId)}`)
    }
  }
  // A repair swarm's budget (2b-2, 15.11): what it used of what you approved.
  if (s.run && s.budget) {
    rows.push(`repair budget for run ${s.run.run}: ${roundsUsed(s.name)} of ${s.budget.rounds} rounds used, ${spawnsUsed(s.name)} of ${s.budget.agents} agents used`)
  }
  return rows
}

const EVENT_KINDS = new Set(['swarm.event', 'swarm.node', 'swarm.stop', 'swarm.stopping'])

function eventLine(r: StoredRecord): string {
  const b = r.body as Record<string, unknown>
  if (r.kind === 'swarm.node') return `#${r.seq} spawned ${String(b.node)} #${String(b.n)} (${String(b.kind)})`
  if (r.kind === 'swarm.stop') return `#${r.seq} stopped ${Array.isArray(b.nodes) ? b.nodes.length : 0} agents (${String(b.how)})`
  if (r.kind === 'swarm.stopping') return `#${r.seq} the swarm is stopping (asked by ${String(b.by)})`
  // A repair swarm's gates and budget asks (2b-2), in words: the round and the result, not the fields.
  if (b.kind === 'gate') {
    const round = b.record === 'verdict' && typeof b.round === 'number' ? `, round ${b.round}` : ''
    return `#${r.seq} ${String(b.record)}${typeof b.node === 'string' ? ` by ${b.node}` : ''}${round}: ${String(b.result)} (verify ${String(b.verify_id)})`
  }
  if (b.kind === 'budget') {
    const after = b.budget as { rounds?: unknown; agents?: unknown } | undefined
    return `#${r.seq} the lead asked for more repair budget: ${b.granted === true ? 'granted' : 'not granted'}; now ${String(after?.rounds)} rounds, ${String(after?.agents)} agents`
  }
  const { kind, node, agentId: _agentId, ...rest } = b
  const fields = Object.keys(rest).length > 0 ? `: ${JSON.stringify(rest)}` : ''
  return `#${r.seq} ${String(kind)}${typeof node === 'string' ? ` ${node}` : ''}${fields}`
}

/** Each orchestrator's last report, in the spec's order, with when it came. */
function reportRows(s: LiveSwarm): { at: number; text: string }[] {
  const rows: { at: number; text: string }[] = []
  for (const node of s.spec.nodes.filter(n => n.kind === 'orchestrator')) {
    const latest = bindings(s.name)
      .filter(b => b.node === node.id && b.kind === 'orchestrator')
      .map(b => ({ b, r: lastReport(b.agentId) }))
      .filter((x): x is { b: NodeBinding; r: NonNullable<typeof x.r> } => x.r !== null)
      .sort((x, y) => y.r.at - x.r.at)[0]
    if (latest) rows.push({ at: latest.r.at, text: cut(material(`${node.id} #${latest.b.n} (${latest.r.via}): ${latest.r.text}`), REPORT_INPUT_MAX) })
  }
  return rows
}

function leadReplies(messages: readonly SessionMessage[] | null): string[] {
  const replies = (messages ?? []).filter(m => m.role === 'assistant' && m.text.trim() !== '').slice(-LEAD_REPLIES)
  return replies.map(m => cut(material(m.text.trim()), LEAD_INPUT_MAX))
}

const block = (tag: string, rows: readonly string[]): string => `<${tag}>\n${rows.join('\n')}\n</${tag}>`

/** Over the cap, the oldest events go down to these before any report goes. */
const EVENTS_FLOOR = 10

/**
 * The call's prompt: the goal, each node with its status, the last 30
 * events, each orchestrator's last report (1.5 KiB each) and the lead's last
 * two replies (3 KiB each), in tagged blocks, at most 24 KiB in all. Over it,
 * the oldest events go first down to the last ten, then the oldest reports,
 * then the older reply, then the last events, and then the node list is cut.
 */
export async function summaryInputs(p: Ports, litterDir: string, s: LiveSwarm): Promise<string> {
  const goal = cut(material(s.spec.goal), GOAL_INPUT_MAX)
  let nodes = cut(material(nodeRows(s).join('\n')), NODES_INPUT_MAX)
  const records = (await readLaunchLedger(p, litterDir, s.name, s.launch)).records
  const events = records.filter(r => EVENT_KINDS.has(r.kind)).slice(-EVENTS_KEPT).map(r => cut(material(eventLine(r)), EVENT_INPUT_MAX))
  const reports = reportRows(s)
  const lead = leadReplies(await p.messages().catch(() => null))
  const prompt = () =>
    [
      block('goal', [goal]),
      block('nodes', [nodes]),
      block('events', events),
      block('reports', reports.map(r => r.text)),
      block('lead', lead.length > 0 ? [lead.join('\n---\n')] : []),
    ].join('\n')
  let text = prompt()
  while (byteLength(text) > SUMMARY_INPUT_MAX) {
    if (events.length > EVENTS_FLOOR) events.shift()
    else if (reports.length > 0) reports.splice(reports.indexOf(reports.reduce((a, b) => (b.at < a.at ? b : a))), 1)
    else if (lead.length > 1) lead.shift()
    else if (events.length > 0) events.shift()
    else {
      nodes = cut(nodes, Math.max(0, byteLength(nodes) - (byteLength(text) - SUMMARY_INPUT_MAX)))
      text = prompt()
      break
    }
    text = prompt()
  }
  return text
}

// ---------------------------------------------------------------------------
// The answer

// Terminal sequences, controls, zero-widths and bidi overrides: none may reach the pane.
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]/g
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g
/** Markdown the model may wrap a label or a line in: emphasis, headings, quotes, bullets. */
const LEAD_MARKS = /^[\s>#*_~`\-+\u2022\u00b7]+/
const EMPHASIS = /(\*\*|__|\*|_|~~|`)/g

/** Plain text for the pane, which draws text as it is: no terminal sequences and no Markdown marks. */
export function plainText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').replace(ANSI, '').replace(CONTROL, '')
}

const plainLine = (line: string): string => one(line.replace(LEAD_MARKS, '').replace(EMPHASIS, ''))

const LABELS = SUMMARY_LABELS.map(l => l.slice(0, -1).toLowerCase())

/**
 * The three labelled parts (prompts/swarm-summary.ts), as plain text; null
 * when one is missing or the goal is empty. Labels are found at a line's
 * start, with any Markdown around them.
 */
export function parseSummary(answer: string): Omit<SwarmSummary, 'at' | 'stale'> | null {
  const parts: (string[] | null)[] = [null, null, null]
  let at = -1
  for (const raw of plainText(answer).split('\n')) {
    const line = plainLine(raw)
    const lower = line.toLowerCase()
    const label = LABELS.findIndex(l => lower.startsWith(`${l}:`))
    if (label >= 0 && parts[label] === null) {
      at = label
      parts[label] = []
      const rest = plainLine(line.slice(LABELS[label]!.length + 1))
      if (rest !== '') parts[label]!.push(rest)
    } else if (at >= 0 && line !== '') parts[at]!.push(line)
  }
  const [goal, progress, waiting] = parts
  if (!goal || !progress || !waiting) return null
  const goalNow = cut(goal.join(' '), PART_MAX)
  if (goalNow === '') return null
  const nothing = waiting.length === 1 && /^"?nothing"?\.?$/i.test(waiting[0]!)
  return {
    goalNow,
    progress: progress.slice(0, PROGRESS_KEPT).map(l => cut(l, PART_MAX)),
    waitingOnYou: nothing ? [] : waiting.slice(0, WAITING_KEPT).map(l => cut(l, PART_MAX)),
  }
}

/** One line, for comparing goal lines: a change of spacing or case isn't a new goal. */
const sameLine = (text: string): string => one(text).toLowerCase()

/** The summary as swarm.summary's `text` (and the goal history). */
export function summaryText(s: Omit<SwarmSummary, 'stale'>): string {
  const lines = [`Goal now: ${s.goalNow}`, 'Progress:', ...s.progress.map(l => `- ${l}`), 'Waiting on you:']
  lines.push(...(s.waitingOnYou.length === 0 ? ['- nothing'] : s.waitingOnYou.map(l => `- ${l}`)))
  return lines.join('\n')
}

/** A fresh module's memory, for tests. The store is left as it is. */
export function resetSummaryForTests(): void {
  due.clear()
  triggers.clear()
  kept.clear()
  lastCallAt.clear()
  lastHash.clear()
  recordedGoal.clear()
  loaded.clear()
  ending.clear()
  ticking = false
}
