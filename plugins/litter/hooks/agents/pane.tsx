// `/litter agents` and the agents pane, the `litter` pane's Agents section
// (phase 5; COMMON step 6, decisions 5, 6, 16; phase 5b, WP-DA): this
// session's agents and the picked team's members, with status and unread
// counts; the selected agent's pending inbox and transcript tail; a
// composer, a broadcast to the team, and [Stop] with a confirm. Rebuilt on
// the ui tick while Agents is shown. Keys are `agents:<action>[:<arg>]`.
// Inboxes go through hooks/team/store.ts. Owner: WP-CG.
//
// The render is a pure function of the view in $.state (view.ts builds it).
// Every press reads the rows again (view.ts, gather) and acts only on a row
// still listed in the scope the press was drawn for; one that's gone is
// ignored with a toast. A message goes through `p.send` to this session's
// agent or teammate (`{ agentId }`), by name to an unlisted member of a team
// this session leads, and through the store's locked append to another
// team's member (decision 5): "queued" is all a send can say. [Stop] is
// TaskStop through `p.callTool` on a second press within 5 s (decision 6),
// which litter's own TaskStop hook sees as it sees the model's.
//
// Phase 5b (WP-DF): only teams that run, unless asked (view.ts says how it
// tells); the picker a strip or the chrome's list; the roster a list with a
// right-click menu (Message, Transcript, Stop); the transcript in words, a
// window over its last 200 lines pinned at the newest; the composer a framed
// field; and the body keeps to the rows the hub gives it. The body has three
// scrolled things (the picker's list, the roster, the transcript), so the
// wheel hit-tests which one it's over (agentsTops, kept in step with the
// render) and passes on over the rest or at an edge (COMMON-5B, "The wheel").

import type { RenderElement } from 'claude-code'
import type { Ports, ToolCallResult } from '../ports'
import type { CommandRunHook, PaneElements, PaneUiHandlers, PortHook, UiScrollHook } from '../hooktypes'
import type { AgentsBody, AgentsInboxEntry, AgentsPaneView, AgentsRow, AgentsSelected, SwarmNotice } from '../../types/index'
import type { TeamInfo } from '../uitypes'
import type { AgentsFacts, RowFacts } from './view'
import type { Loaded } from '../ui/hub'
import { tableFor } from '../swarm/builder'
import { clean, oneLine } from '../swarm/view'
import { MARK, NOTICE_STYLE, STYLE, type NoticeLevel } from '../ui/style'
import { actions, empty, field, fieldRows, fitCell, heading, headingPlan, MIN_RULE, notice, packItems, RULE, RULE_TAIL, spansLine, textRows, type BodyContext, type SectionMeta } from '../ui/chrome'
import { cells } from '../band/view'
import { list, listPlace, pageOf, scrolled, type ListAction, type ListSpec } from '../ui/list'
import { lastDrawn } from '../ui/drawn'
import { listOffset, moveList, openSection, showSection } from '../ui/hub'
import {
  SESSION_SCOPE,
  agentsNavOf,
  agentsNavRev,
  agentsTextDirty,
  agentsView,
  armedLive,
  blankAgentsNav,
  deps,
  factsStamp,
  gather,
  parseRowArg,
  putText,
  resetAgentsNavForTests,
  restoreAgentsNav,
  rowArg,
  saveAgentsNav,
  scopeOf,
  scopeWords,
  setAgentsNav,
  teamEnded,
  teamOfScope,
} from './view'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

// ---------------------------------------------------------------------------
// The command, and drawing

let viewSeq = 0
/** What the last written view was built from: a rebuild that matches it writes nothing (decision 16). */
let lastKey: string | null = null
let savedRev = -1

/**
 * Reads the rows again and writes the view when what it's built from moved
 * (the reads' stamp, the navigation, the armed stop's expiry), or always with
 * `force` ($.state was wiped); then saves the navigation if it changed.
 */
async function drawAgents(p: Ports, force = false): Promise<AgentsFacts | null> {
  const n = agentsNavOf()
  if (!n) return null
  const facts = await gather(p, n)
  const now = await p.now()
  const key = `${factsStamp(facts)}|${agentsNavRev()}|${armedLive(n, now)}`
  if (force || key !== lastKey) {
    const view = agentsView(facts, n, now, ++viewSeq)
    await p.setView('agents', view)
    lastView = view
    lastKey = key
    await keepLinesPlace(p, view)
  }
  if (savedRev !== agentsNavRev() || agentsTextDirty()) {
    savedRev = agentsNavRev()
    await saveAgentsNav(p)
  }
  return facts
}

/** `/litter agents [team]` (ui/hub.ts's litterCommand): shows Agents on that team in the `litter` pane. */
export const agentsCommand: PortHook<CommandRunHook> = async (p, e, next) => ({ text: (await openSection(p, 'agents', e.args ?? '', { focus: true })).text })

/**
 * Agents' load (openSection): the team named, shown even when it ended (on
 * purpose); with no team, the team it showed if that still runs, else this
 * session's agents (WP-DF §0). Answers the reply's line.
 */
export async function loadAgents(p: Ports, args: string): Promise<Loaded> {
  await restoreAgentsNav(p)
  const arg = clean(args, 200).trim()
  if (arg === '') {
    const facts = await reopen(p)
    return { text: `Agents shows ${shownWords(agentsNavOf()?.team ?? null, facts?.rows.length ?? 0)}` }
  }
  let team: string | null = null
  let notice: SwarmNotice | null = null
  let list: TeamInfo[] = []
  let why = ''
  try {
    list = await deps.teams(p)
  } catch (err) {
    why = ` (the teams couldn't be read: ${oneLine(errText(err), 160)})`
  }
  const found = list.find(t => t.name === arg) ?? list.find(t => t.dir === arg) ?? null
  if (found) team = found.name
  else notice = { level: 'warning', text: `there's no team named ${oneLine(arg, 60)}${why}, so this session's agents are shown: the picker lists the teams that run` }
  // What was typed before stays, in a field drawn afresh; [Show all] too.
  const prev = agentsNavOf()
  const text = prev?.text ?? ''
  setAgentsNav({ ...blankAgentsNav(team), text, gen: (prev?.gen ?? 0) + 1, field: text, notice, showAll: prev?.showAll ?? false, named: team ?? prev?.named ?? null })
  const facts = await drawAgents(p, true)
  return { text: `Agents shows ${shownWords(team, facts?.rows.length ?? 0)}` }
}

const shownWords = (team: string | null, count: number): string => (team === null ? `this session's ${plural(count, 'agent')}` : `team ${oneLine(team, 60)}'s ${plural(count, 'member')}`)

/**
 * Agents opened with no team (the strip, Home, `/litter agents`): what it
 * showed, if that's this session or a team that still runs; a remembered
 * team that ended (or is gone) isn't reopened, and the notice says so once
 * (WP-DF §0). Selection, [More] and an armed stop go with a team left.
 */
async function reopen(p: Ports): Promise<AgentsFacts | null> {
  const prev = agentsNavOf()
  if (!prev) setAgentsNav(blankAgentsNav(null))
  else if (prev.team !== null && teamEnded(await gather(p, prev), prev.team)) {
    const name = oneLine(prev.team, 60)
    setAgentsNav({ ...prev, team: null, selected: null, armed: null, picking: false, notice: { level: 'info', text: `team ${name} ended, so this session's agents are shown` } })
  }
  return drawAgents(p, true)
}

/** Agents from the strip or Home: the scope it showed while that still runs, else this session's agents. */
export async function resumeAgents(p: Ports): Promise<void> {
  await restoreAgentsNav(p)
  await reopen(p)
}

// ---------------------------------------------------------------------------
// The render (phase 5b, WP-DF)
//
// No title line of its own: the first line is what's shown ("this session",
// or "team <name>") and its counts. Then what needs you (a team that ended,
// the last action's outcome, what couldn't be read), the picker, the roster
// (the chrome's list, with a right-click menu on the terminal and the
// desktop), the selected agent's [Stop], its inbox and its transcript under
// headings, and the composer. agentsPlan shares the body's rows (ctx.rows)
// among them, so nothing is drawn past them: the lists window themselves,
// the inbox shows its newest entries, the transcript a window of its lines.

/** The picker is a strip of Buttons up to this many choices, the chrome's list past it. */
export const STRIP_CHOICES = 4
/** The picker list's window at most. */
export const PICKER_ROWS = 5
/** Under this many body rows, or inline, the picker folds to one line with [Change]. */
export const SHORT_ROWS = 24
/** The roster's window inline, and the share it keeps before the selected agent's detail takes the rest. */
export const ROSTER_ROWS = 8
/** The fewest roster rows the dock keeps. */
const ROSTER_MIN = 3
/** The transcript's window: at least this many lines in the dock while there are as many; inline, this many. */
export const LINES_MIN = 6
export const LINES_INLINE = 8
/** The inbox's rows before the transcript takes the rest. */
const INBOX_FIRST = 8
/** The lists' ids: the hub keeps each window by it, and its footer's keys are `<id>:up` and `<id>:down`. */
export const PICKER_LIST = 'agents:scopes'
export const ROSTER_LIST = 'agents:roster'
/** The transcript's window: the hub keeps its offset by this id too, counted from the newest line (0: pinned there). */
export const LINES_LIST = 'agents:lines'

/** Agents to the hub (chrome.tsx's SectionMeta): its body keeps to ctx.rows; its keys. */
export const agentsSection: SectionMeta<AgentsPaneView> = {
  fits: true,
  keys: view =>
    (view?.body?.rows.length ?? 0) > 0
      ? [
          { key: 'right-click', word: "an agent's actions" },
          { key: 'wheel', word: 'scrolls the list or the transcript under it' },
        ]
      : [],
}

/** What the planner reads of the context. */
export type AgentsCtx = Pick<BodyContext, 'surface' | 'bodyColumns' | 'rows' | 'placement' | 'focused' | 'lists'>

/**
 * How the body shares its rows: the picker's form and window, the roster's
 * window, the inbox's rows under its heading, the transcript's window of
 * lines and whether its footer line (`↑ n earlier · ↓ n newer`) is drawn.
 */
export type AgentsPlan = { picker: 'strip' | 'list' | 'folded'; pickerRows: number; rosterRows: number; inboxRows: number; linesRows: number; linesFooter: boolean }

const noticeText = (n: { level: NoticeLevel; text: string }): string => `${NOTICE_STYLE[n.level].glyph} ${n.text}`
const buttonRows = (labels: readonly string[], columns: number): number =>
  labels.length === 0 ? 0 : packItems(labels.map(label => ({ kind: 'button' as const, label })), Number.isFinite(columns) ? columns : Number.POSITIVE_INFINITY).length

/** The transcript's window over `count` lines: `rows` of them, ending `offset` lines before the newest (clamped), and how many lie each way. Pure. */
export type LinesWindow = { start: number; end: number; earlier: number; newer: number; offset: number; max: number }

export function linesWindow(count: number, offset: number, rows: number): LinesWindow {
  const n = Math.max(0, Math.floor(count))
  const b = Math.max(1, Math.floor(Number.isFinite(rows) ? rows : n || 1))
  const max = Math.max(0, n - b)
  const o = Math.min(max, Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0)))
  const end = n - o
  const start = Math.max(0, end - b)
  return { start, end, earlier: start, newer: n - end, offset: o, max }
}

/** The footer's words: what lies above and below the window. */
export const linesFooterText = (w: LinesWindow): string => [w.earlier > 0 ? `↑ ${w.earlier} earlier` : '', w.newer > 0 ? `↓ ${w.newer} newer` : ''].filter(x => x !== '').join(' · ')

/** The surfaces the wheel reaches (the hub notes a drawing for the terminal; the desktop has a pointer): elsewhere the footer is Buttons. */
const wheeled = (surface: string): boolean => surface === 'terminal' || surface === 'desktop'

/** The picker as the chrome's list: this session, then each team with its members and whether it runs; the focused one's description beside or under it. */
export function pickerSpec(body: AgentsBody, rows: number): ListSpec {
  return {
    id: PICKER_LIST,
    rows,
    items: body.options.map(o => ({
      key: `agents:scope:${o.value}`,
      label: o.label,
      cells: [
        { text: o.members === null ? '' : plural(o.members, 'member'), color: STYLE.muted },
        o.members === null || o.active === null
          ? { text: '' }
          : o.active
            ? { text: `${MARK.running.glyph} running`, color: MARK.running.color }
            : { text: `${MARK.stopped.glyph} ended`, color: MARK.stopped.color },
      ],
      description: o.description,
      selected: o.value === body.scope,
    })),
    columns: [{ drop: 1 }, { drop: 2 }],
  }
}

/** A row's status as drawn: its glyph and word. */
const statusWords = (s: AgentsRow['status']): string => (s.glyph ? `${s.glyph} ${s.text}` : s.text)

/**
 * The roster as the chrome's list: each row its name, its type muted, its
 * status (glyph, word, color) and `✉ n` unread in the warning color; the
 * type drops first when narrow. A live swarm's node (WP-DF) is named by its
 * node, then `· swarm <swarm>` and the engine's description, both muted;
 * with any node listed, those two columns come after the name, the
 * description dropping first, then the type, then the swarm. Its menu:
 * Message, Transcript and Stop, each where it applies today (decision 6's
 * confirm stays on Stop).
 */
export function rosterSpec(body: AgentsBody, rows: number): ListSpec {
  const scope = body.scope
  const nodes = body.rows.some(r => r.swarm !== null)
  return {
    id: ROSTER_LIST,
    rows,
    items: body.rows.map(r => {
      const arg = rowArg(scope, r.key)
      const actions: ListAction[] = []
      if (r.can.message) actions.push({ key: `agents:message:${arg}`, label: 'Message' })
      if (r.can.transcript) actions.push({ key: `agents:transcript:${arg}`, label: 'Transcript' })
      if (r.can.stop) actions.push({ key: `agents:stop:${arg}`, label: 'Stop', color: STYLE.failed })
      return {
        key: `agents:select:${arg}`,
        label: r.name,
        cells: [
          ...(nodes
            ? [
                { text: r.swarm ? `· swarm ${r.swarm.name}` : '', color: STYLE.muted },
                { text: r.swarm?.said ?? '', color: STYLE.muted },
              ]
            : []),
          { text: r.type, color: STYLE.muted },
          { text: statusWords(r.status), color: r.status.dim ? STYLE.muted : r.status.color },
          { text: r.unread !== null && r.unread > 0 ? `✉ ${r.unread}` : '', color: STYLE.warning },
        ],
        ...(r.description !== '' ? { description: r.description } : {}),
        selected: body.selected?.key === r.key,
        ...(actions.length > 0 ? { actions } : {}),
      }
    }),
    columns: [...(nodes ? [{ drop: 1 }, { drop: 3 }] : []), { drop: nodes ? 2 : 1 }, { drop: 0 }, { drop: 0 }],
    empty: body.scope === SESSION_SCOPE ? 'no agent in this session yet' : 'no member to show',
  }
}

/**
 * The inbox's entries that fit `rows` rows: the newest whole ones, and a line
 * counting what's left out when there's a row for it; the newest cut to the
 * rows when even it doesn't fit. What's drawn never takes more. Pure.
 */
export function inboxFit(
  entries: readonly AgentsInboxEntry[],
  hidden: number,
  rows: number,
): { kept: AgentsInboxEntry[]; left: number; leftLine: boolean; rows: number } {
  const all = entries.reduce((n, e) => n + e.lines.length, 0)
  if (all + (hidden > 0 ? 1 : 0) <= rows) return { kept: [...entries], left: hidden, leftLine: hidden > 0, rows: all + (hidden > 0 ? 1 : 0) }
  const room = rows >= 2 ? Math.floor(rows) - 1 : 1
  const kept: AgentsInboxEntry[] = []
  let used = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!
    if (used + e.lines.length > room) {
      if (kept.length === 0) {
        kept.unshift({ ...e, lines: e.lines.slice(0, room) })
        used = room
      }
      break
    }
    kept.unshift(e)
    used += e.lines.length
  }
  const left = hidden + entries.length - kept.length
  const leftLine = left > 0 && rows >= 2
  return { kept, left, leftLine, rows: used + (leftLine ? 1 : 0) }
}

/** A swarm node's messages as one-line entries, for inboxFit. */
const messageEntries = (m: NonNullable<AgentsSelected['swarm']>): AgentsInboxEntry[] => m.messages.map(x => ({ from: x.from, at: x.at, lines: [x.line] }))

/** The rows the inbox (or a swarm node's messages) takes under its heading at a budget of `rows`: one for a note in place of entries. */
function slotRows(sel: AgentsSelected, rows: number): number {
  const m = sel.swarm
  if (m) return m.messages.length === 0 ? 1 : inboxFit(messageEntries(m), m.hidden, rows).rows
  const inbox = sel.inbox
  if (inbox === null || inbox.error !== null || inbox.entries.length === 0) return 1
  return inboxFit(inbox.entries, inbox.hidden, rows).rows
}

/** The rows drawn under the inbox's heading: its slot's, and a swarm node's [Open in Swarms] row. */
const inboxDrawn = (sel: AgentsSelected, rows: number): number => slotRows(sel, rows) + (sel.swarm ? 1 : 0)

/** The inbox's rows it would take whole. */
const inboxWant = (sel: AgentsSelected): number => slotRows(sel, Number.POSITIVE_INFINITY)

/** The transcript's lines to window: 0 when a note stands in for them. */
const linesOf = (sel: AgentsSelected | null): number => {
  const t = sel?.transcript
  return t && t.readable ? t.lines.length : 0
}

/** The transcript's window and footer in `room` rows (at least one): every line when they fit, else the footer takes a row. */
function linesIn(count: number, room: number): { linesRows: number; linesFooter: boolean } {
  if (count <= room) return { linesRows: Math.max(1, count), linesFooter: false }
  if (room < 2) return { linesRows: 1, linesFooter: false }
  return { linesRows: Math.floor(room) - 1, linesFooter: true }
}

/** The rows the transcript draws under its heading: its window and footer, or one note. */
const linesDrawn = (sel: AgentsSelected, plan: AgentsPlan): number => (linesOf(sel) === 0 ? 1 : plan.linesRows + (plan.linesFooter ? 1 : 0))

/** The rows the ended notice and its [This session's agents], the notice and the problems take: drawn above the picker. */
function topRows(body: AgentsBody, cols: number): number {
  let n = 0
  if (body.ended) n += textRows(noticeText({ level: 'warning', text: body.ended }), cols) + 1
  if (body.notice) n += textRows(noticeText(body.notice), cols)
  for (const x of body.problems) n += textRows(noticeText({ level: 'warning', text: x }), cols)
  return n
}

/** The composer's rows: its field (or the line saying where messages are typed) and its Buttons. */
function composerRows(body: AgentsBody, ctx: AgentsCtx): number {
  if (!body.composer) return 0
  const labels = [body.composer.to !== null && body.selected !== null ? 'Send' : '', body.broadcast !== null ? `Broadcast to ${body.broadcast}` : ''].filter(l => l !== '')
  return (ctx.surface === 'mobile' ? 1 : fieldRows(ctx.surface, true)) + buttonRows(labels, ctx.bodyColumns)
}

/** The ended teams' line under the picker: drawn while some are hidden, or [Show all] is on. */
const hiddenLineRows = (body: AgentsBody): number => (body.hiddenTeams > 0 || body.showAll ? 1 : 0)

/** No picker at all: this session is the only choice, and no ended team was left out. */
const noChoice = (body: AgentsBody): boolean => body.options.length <= 1 && body.hiddenTeams === 0 && !body.showAll

/** The picker's rows in a form: none with no choice; one folded; the strip's Buttons wrapping past `Show`; the list under its heading, the ended line, the roster's heading. */
function pickerHeight(body: AgentsBody, ctx: AgentsCtx, form: AgentsPlan['picker'], rows: number): number {
  const cols = ctx.bodyColumns
  if (noChoice(body)) return 0
  if (form === 'folded') return 1
  // `Show` and a gap, then the Buttons wrapping in what's left.
  if (form === 'strip') return Math.max(1, buttonRows(body.options.map(o => o.label), Number.isFinite(cols) ? cols - 5 : cols)) + hiddenLineRows(body)
  return 1 + listPlace(pickerSpec(body, rows), ctx).height + hiddenLineRows(body) + 1
}

/** The roster's rows at a window of `rows`: the list's, or the line in place of none. */
const rosterHeight = (body: AgentsBody, ctx: AgentsCtx, rows: number): number => (body.rows.length === 0 ? 1 : listPlace(rosterSpec(body, rows), ctx).height)

/**
 * The plan: what every layout draws in full first (the first line, the
 * notices, [Stop], the composer, the headings), then the picker (folded on
 * a short or inline body, unless [Change] opened it), then the roster's
 * three rows, a row of the inbox and the transcript's six lines, then the
 * rest: the roster up to 8, the inbox up to 8, the transcript all it has
 * (the rest of the body: the wheel moves its window), the inbox, the roster
 * again. Inline, nothing bounds it: the roster's window is 8, the
 * transcript's 8, the inbox whole. Pure.
 */
export function agentsPlan(body: AgentsBody, ctx: AgentsCtx): AgentsPlan {
  const cols = ctx.bodyColumns
  const sel = body.selected
  const many = body.options.length > STRIP_CHOICES
  const unfolded: AgentsPlan['picker'] = many ? 'list' : 'strip'
  const lines = linesOf(sel)
  const bounded = ctx.placement === 'dock' && Number.isFinite(ctx.rows)
  if (!bounded) {
    const window = lines <= LINES_INLINE ? { linesRows: Math.max(1, lines), linesFooter: false } : { linesRows: LINES_INLINE, linesFooter: true }
    return { picker: body.picking ? unfolded : 'folded', pickerRows: Math.min(PICKER_ROWS, body.options.length), rosterRows: ROSTER_ROWS, inboxRows: Number.POSITIVE_INFINITY, ...window }
  }
  let fixed = 1 + topRows(body, cols) + composerRows(body, ctx)
  if (body.hiddenRows > 0) fixed += 1
  if (sel?.stop) fixed += 1
  if (sel) fixed += 2
  // A swarm node's [Open in Swarms] row, under its messages.
  if (sel?.swarm) fixed += 1
  const count = body.rows.length
  const iWant = sel ? inboxWant(sel) : 0
  // The transcript's least: six lines and the footer, or every line when there are fewer; a note's one row.
  const lMin = !sel ? 0 : lines === 0 ? 1 : lines <= LINES_MIN ? lines : LINES_MIN + 1
  const mins = (b: number): number => rosterHeight(body, ctx, b) + (sel ? Math.min(1, iWant) + lMin : 0)

  let picker: AgentsPlan['picker'] = ctx.rows < SHORT_ROWS && !body.picking ? 'folded' : unfolded
  let pickerRows = Math.min(PICKER_ROWS, body.options.length)
  const rosterMin = Math.max(1, Math.min(count, ROSTER_MIN))
  // A list picker gives up rows, then folds, before the roster goes under its three.
  while (picker === 'list' && pickerRows > 2 && ctx.rows - fixed - pickerHeight(body, ctx, picker, pickerRows) < mins(rosterMin)) pickerRows--
  if (picker !== 'folded' && !body.picking && ctx.rows - fixed - pickerHeight(body, ctx, picker, pickerRows) < mins(rosterMin)) picker = 'folded'
  let left = ctx.rows - fixed - pickerHeight(body, ctx, picker, pickerRows)

  let rosterRows = rosterMin
  left -= rosterHeight(body, ctx, rosterRows)
  let inboxRows = sel ? Math.min(1, iWant) : 0
  left -= inboxRows
  // What the transcript has, at least a row: less than six when the body is that short.
  let linesRoom = sel ? Math.max(1, Math.min(lMin, left)) : 0
  left -= linesRoom
  // The roster grows a row at a time while the rows it takes fit: up to 8 with an agent selected, else all.
  const grow = (cap: number): void => {
    while (rosterRows < Math.min(count, cap)) {
      const more = rosterHeight(body, ctx, rosterRows + 1) - rosterHeight(body, ctx, rosterRows)
      if (more > left) break
      left -= more
      rosterRows++
    }
  }
  grow(sel ? ROSTER_ROWS : count)
  if (sel) {
    const i = Math.max(0, Math.min(Math.min(iWant, INBOX_FIRST) - inboxRows, left))
    inboxRows += i
    left -= i
    if (lines > 0) {
      // Every line, with no footer, else all the rest (and the footer takes a row of it).
      const t = Math.max(0, Math.min(lines - linesRoom, left))
      linesRoom += t
      left -= t
    }
    const j = Math.max(0, Math.min(iWant - inboxRows, left))
    inboxRows += j
    left -= j
    grow(count)
  }
  return { picker, pickerRows: Math.max(1, pickerRows), rosterRows: Math.max(1, rosterRows), inboxRows, ...linesIn(lines, Math.max(1, linesRoom)) }
}

/**
 * Where the scrolled parts start, in rows from the body's first, and the
 * rows each takes: the picker's list (null unless it's a list), the roster's
 * (null with no rows) and the transcript's window (null with nothing to
 * window). Kept in step with renderAgentsPane, part by part: the wheel's
 * hit test (onAgentsScroll) reads it. Pure.
 */
export type AgentsTops = {
  plan: AgentsPlan
  picker: { top: number; height: number } | null
  roster: { top: number; height: number } | null
  lines: { top: number; height: number } | null
}

export function agentsTops(body: AgentsBody, ctx: AgentsCtx): AgentsTops {
  const plan = agentsPlan(body, ctx)
  const cols = ctx.bodyColumns
  const sel = body.selected
  // The first line, then what needs you.
  let at = 1 + topRows(body, cols)
  // The picker's list sits under its `Show` heading.
  const picker = plan.picker === 'list' ? { top: at + 1, height: listPlace(pickerSpec(body, plan.pickerRows), ctx).height } : null
  at += pickerHeight(body, ctx, plan.picker, plan.pickerRows)
  const rosterRows = rosterHeight(body, ctx, plan.rosterRows)
  const roster = body.rows.length > 0 ? { top: at, height: rosterRows } : null
  at += rosterRows
  if (body.hiddenRows > 0) at += 1
  if (!sel) return { plan, picker, roster, lines: null }
  if (sel.stop) at += 1
  // The inbox's heading and rows, then the transcript's heading.
  at += 1 + inboxDrawn(sel, plan.inboxRows) + 1
  const lines = linesOf(sel) > 0 ? { top: at, height: linesDrawn(sel, plan) } : null
  return { plan, picker, roster, lines }
}

/**
 * A heading whose title ends in a name drawn in the name color (WP-DF; the
 * chrome's heading has one color): `team <name>`, `Inbox · <name>`. Tasks'
 * first line uses it too. Pure.
 */
export function namedHeading(el: PaneElements, label: string, name: string, columns: number, note?: string | null): RenderElement {
  const { Box, Text } = el
  const whole = `${label}${name}`
  const plan = headingPlan(whole, columns, note ?? null)
  const title =
    plan.title === whole ? (
      <Box flexDirection="row">
        <Text bold color={STYLE.heading}>
          {label}
        </Text>
        <Text bold color={STYLE.name}>
          {name}
        </Text>
      </Box>
    ) : (
      <Text bold color={STYLE.heading} wrap="truncate-end">
        {plan.title}
      </Text>
    )
  return (
    <Box flexDirection="row" columnGap={1}>
      {title}
      {Number.isFinite(plan.rule) ? (
        <Text color={STYLE.faint}>{RULE.repeat(plan.rule)}</Text>
      ) : (
        <Box flexGrow={1} width={0} minWidth={MIN_RULE} height={1} overflow="hidden">
          <Text color={STYLE.faint} wrap="wrap">
            {RULE.repeat(400)}
          </Text>
        </Box>
      )}
      {plan.note !== null ? (
        <Text color={STYLE.muted} wrap="truncate-end">
          {plan.note}
        </Text>
      ) : null}
      {plan.note !== null ? <Text color={STYLE.faint}>{RULE.repeat(RULE_TAIL)}</Text> : null}
    </Box>
  )
}

/**
 * What each surface last drew of the body: a footer's page reads it, since a
 * press carries its surface but not the rows the body had there. The render
 * notes it (as ui/pane.tsx notes the terminal's drawing in ui/drawn.ts); the
 * note changes nothing drawn.
 */
const rendered = new Map<string, { body: AgentsBody; ctx: AgentsCtx }>()

/** Agents' body renderer (ui/pane.tsx calls it with the agentsPane atom under the hub's chrome). Pure but for its note of what it drew. */
export function renderAgentsPane(view: AgentsPaneView | null, resolved: PaneElements, ctx: BodyContext): RenderElement {
  const el = tableFor(resolved, ctx.surface)
  const { Box, Text } = el
  const body = view?.body
  if (!body) return empty(el, 'nothing to show yet', { command: '/litter agents', does: "opens this session's agents" })
  rendered.set(ctx.surface, { body, ctx })
  const plan = agentsPlan(body, ctx)
  const cols = ctx.bodyColumns
  const sel = body.selected
  return (
    <Box flexDirection="column">
      {body.head.team === null ? heading(el, 'this session', cols, body.head.note) : namedHeading(el, 'team ', body.head.team, cols, body.head.note)}
      {body.ended ? (
        <Box flexDirection="column">
          {notice(el, 'warning', body.ended)}
          {/* Its own key: the picker's strip has this session's too, and a key is drawn once. */}
          {actions(el, [{ key: `agents:leave:${SESSION_SCOPE}`, label: "This session's agents", primary: true }])}
        </Box>
      ) : null}
      {body.notice ? notice(el, body.notice.level, body.notice.text) : null}
      {body.problems.map(x => notice(el, 'warning', x))}
      {pickerPart(el, body, plan, ctx)}
      {rosterPart(el, body, plan, ctx)}
      {body.hiddenRows > 0 ? <Text color={STYLE.muted}>{`${body.hiddenRows} more not shown`}</Text> : null}
      {sel ? stopPart(el, body.scope, sel) : null}
      {sel ? inboxPart(el, body.scope, sel, plan.inboxRows, cols) : null}
      {sel ? transcriptPart(el, sel, plan, ctx) : null}
      {composerPart(el, body, ctx)}
    </Box>
  )
}

// `h` and `Fragment` are the environment's JSX factory, so no name here takes them.

/** The picker: one line with [Change] when folded, a strip of Buttons for a few choices, else the chrome's list; then the ended teams it left out, with [Show all]. */
function pickerPart(el: PaneElements, body: AgentsBody, plan: AgentsPlan, ctx: BodyContext): RenderElement | null {
  const { Box, Text } = el
  if (noChoice(body)) return null
  const shown = body.options.find(o => o.value === body.scope)
  if (plan.picker === 'folded') {
    const others = body.options.length - 1
    const note = [others > 0 ? plural(others, 'other') : '', body.hiddenTeams > 0 ? `${body.hiddenTeams} ended hidden` : ''].filter(x => x !== '').join(', ')
    return (
      <Box flexDirection="row" columnGap={1}>
        <Text color={STYLE.muted}>Show</Text>
        <Text color={body.head.team === null ? STYLE.label : STYLE.name} wrap="truncate-end">
          {shown?.label ?? (body.head.team ?? 'this session')}
        </Text>
        {note !== '' ? <Text color={STYLE.muted} wrap="truncate-end">{`· ${note}`}</Text> : null}
        {actions(el, [{ key: 'agents:picker:open', label: 'Change' }])}
      </Box>
    )
  }
  const hidden =
    body.hiddenTeams > 0 || body.showAll ? (
      <Box flexDirection="row" columnGap={1}>
        <Text color={STYLE.muted} wrap="truncate-end">
          {body.showAll ? 'every team shown, the ended ones too' : `${plural(body.hiddenTeams, 'ended team')} hidden`}
        </Text>
        {actions(el, [body.showAll ? { key: 'agents:teams:running', label: 'Running only' } : { key: 'agents:teams:all', label: 'Show all' }])}
      </Box>
    ) : null
  if (plan.picker === 'strip') {
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text color={STYLE.muted}>Show</Text>
          {actions(
            el,
            body.options.map(o => ({ key: `agents:scope:${o.value}`, label: o.label, primary: o.value === body.scope })),
          )}
        </Box>
        {hidden}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {heading(el, 'Show', ctx.bodyColumns, plural(body.options.length - 1, 'team'))}
      {list(el, pickerSpec(body, plan.pickerRows), ctx)}
      {hidden}
      {heading(el, body.scope === SESSION_SCOPE ? 'Agents' : 'Members', ctx.bodyColumns)}
    </Box>
  )
}

/** The roster: the chrome's list, or the empty state that names the next step. */
function rosterPart(el: PaneElements, body: AgentsBody, plan: AgentsPlan, ctx: BodyContext): RenderElement {
  const { Text } = el
  if (body.rows.length === 0) {
    return body.scope === SESSION_SCOPE ? (
      empty(el, 'no agent in this session yet', { command: '/litter swarms', does: 'builds a swarm to launch; agents the model starts show here too' })
    ) : (
      <Text color={STYLE.muted}>no member to show</Text>
    )
  }
  return list(el, rosterSpec(body, plan.rosterRows), ctx)
}

/** [Stop], with its confirm: the first press arms it for 5 s (decision 6). Only for an agent that runs or waits, so never beside a finished one. */
function stopPart(el: PaneElements, scope: string, sel: AgentsSelected): RenderElement | null {
  if (!sel.stop) return null
  const { Box, Text } = el
  return (
    <Box flexDirection="row" columnGap={1}>
      {actions(el, [{ key: `agents:stop:${rowArg(scope, sel.key)}`, label: 'Stop', primary: sel.stop.armed }])}
      {sel.stop.armed ? <Text color={STYLE.warning} wrap="truncate-end">{`[Stop] again to stop ${sel.name}`}</Text> : null}
    </Box>
  )
}

/**
 * A swarm node's messages in the inbox's place (WP-DF): under "Messages ·
 * <node>", the newest that fit `rows`, each `from → to · when · its first
 * line`, the names in the name color; "no messages yet" for none, or what
 * couldn't be read; then [Open in Swarms], which opens the swarm's browser
 * with this node picked (`/litter swarms <swarm> <agentId>`, WP-DG).
 */
function messagesPart(el: PaneElements, m: NonNullable<AgentsSelected['swarm']>, openKey: string, rows: number, columns: number): RenderElement {
  const { Box, Text } = el
  const total = m.messages.length + m.hidden
  const head = namedHeading(el, 'Messages · ', m.node, columns, total > 0 ? plural(total, 'message') : null)
  const see = actions(el, [{ key: openKey, label: 'Open in Swarms' }])
  if (m.messages.length === 0) {
    return (
      <Box flexDirection="column">
        {head}
        {m.error !== null ? (
          <Text color={NOTICE_STYLE.error.color} wrap="truncate-end">{`${NOTICE_STYLE.error.glyph} ${m.error}`}</Text>
        ) : (
          <Text color={STYLE.muted}>no messages yet</Text>
        )}
        {see}
      </Box>
    )
  }
  const { kept, left, leftLine } = inboxFit(messageEntries(m), m.hidden, rows)
  const shown = m.messages.slice(m.messages.length - kept.length)
  const fromW = nameWidth(shown.map(x => x.from), columns)
  const toW = nameWidth(shown.map(x => x.to), columns)
  return (
    <Box flexDirection="column">
      {head}
      {leftLine ? <Text color={STYLE.muted}>{`${left} earlier not shown`}</Text> : null}
      {shown.map(x => (
        <Box flexDirection="row" columnGap={1}>
          {fixed(el, fitCell(x.from, fromW), STYLE.name)}
          {fixed(el, '→', STYLE.muted)}
          {fixed(el, fitCell(x.to, toW), STYLE.name)}
          {fixed(el, `· ${x.at} ·`, STYLE.muted)}
          {rest(el, x.line)}
        </Box>
      ))}
      {see}
    </Box>
  )
}

/** A name column's width: its widest name, at most a fifth of the row (at least 6), so a longer one is cut (`…`) rather than wrapped. */
const nameWidth = (names: readonly string[], columns: number): number =>
  Math.min(Math.max(1, ...names.map(cells)), Math.max(6, Math.floor(columns / 5)))

/** A cell of a message row that keeps its width: the row's text gives way, never a name. */
function fixed(el: PaneElements, text: string, color: string): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexShrink={0}>
      <Text color={color}>{text}</Text>
    </Box>
  )
}

/** The rest of a message row: one line, cut at its end. */
function rest(el: PaneElements, text: string): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexGrow={1} width={0} height={1} overflow="hidden">
      <Text wrap="truncate-end">{text}</Text>
    </Box>
  )
}

/** The inbox under its heading: its newest entries that fit `rows` (inboxFit; one line counts what's left out); a swarm node's messages in its place. */
function inboxPart(el: PaneElements, scope: string, sel: AgentsSelected, rows: number, columns: number): RenderElement {
  const { Box, Text } = el
  if (sel.swarm) return messagesPart(el, sel.swarm, `agents:open-swarm:${rowArg(scope, sel.key)}`, rows, columns)
  const inbox = sel.inbox
  // The inbox is an unread queue: an empty one isn't "nothing was ever sent".
  const head = namedHeading(el, 'Inbox · ', sel.name, columns, 'unread only')
  if (inbox === null || inbox.error !== null || inbox.entries.length === 0) {
    return (
      <Box flexDirection="column">
        {head}
        {inbox === null ? (
          <Text color={STYLE.muted}>no inbox: it isn't in a team</Text>
        ) : inbox.error !== null ? (
          // One line: the problems above say it whole.
          <Text color={NOTICE_STYLE.error.color} wrap="truncate-end">{`${NOTICE_STYLE.error.glyph} it couldn't be read: ${inbox.error}`}</Text>
        ) : (
          <Text color={STYLE.muted}>nothing pending</Text>
        )}
      </Box>
    )
  }
  const { kept, left, leftLine } = inboxFit(inbox.entries, inbox.hidden, rows)
  const fromW = nameWidth(kept.map(x => x.from), columns)
  return (
    <Box flexDirection="column">
      {head}
      {leftLine ? <Text color={STYLE.muted}>{`${left} earlier not shown`}</Text> : null}
      {kept.map(x => (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {fixed(el, fitCell(x.from, fromW), STYLE.name)}
            {fixed(el, `· ${x.at} ·`, STYLE.muted)}
            {rest(el, x.lines[0] ?? '')}
          </Box>
          {x.lines.slice(1).map(l => (
            <Text wrap="truncate-end">{`    ${l}`}</Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

/**
 * The transcript under its heading: a window of its lines, each its spans,
 * ending at the newest unless the wheel moved it (the hub's offset,
 * `agents:lines`, counted from the newest), and a muted footer saying what
 * lies each way. Where no wheel reaches (mobile, the web), the footer is
 * Buttons that page it.
 */
function transcriptPart(el: PaneElements, sel: AgentsSelected, plan: AgentsPlan, ctx: BodyContext): RenderElement {
  const { Box, Text } = el
  const columns = ctx.bodyColumns
  const t = sel.transcript
  if (t === null || !t.readable || t.lines.length === 0) {
    return (
      <Box flexDirection="column">
        {namedHeading(el, 'Transcript · ', sel.name, columns)}
        <Text color={STYLE.muted}>{t === null ? "not in this session: its transcript is its own session's" : !t.readable ? "its transcript can't be read here" : 'nothing yet'}</Text>
      </Box>
    )
  }
  const w = linesWindow(t.lines.length, ctx.lists?.[LINES_LIST] ?? 0, plan.linesRows)
  const note = t.total > t.lines.length ? `last ${t.lines.length} of ${t.total}` : plural(t.total, 'line')
  const footer = plan.linesFooter && (w.earlier > 0 || w.newer > 0)
  return (
    <Box flexDirection="column">
      {namedHeading(el, 'Transcript · ', sel.name, columns, note)}
      {t.lines.slice(w.start, w.end).map(l => spansLine(el, l, columns))}
      {footer ? (
        wheeled(ctx.surface) ? (
          <Text color={STYLE.muted} wrap="truncate-end">
            {linesFooterText(w)}
          </Text>
        ) : (
          actions(el, [w.earlier > 0 && { key: `${LINES_LIST}:up`, label: `↑ ${w.earlier} earlier` }, w.newer > 0 && { key: `${LINES_LIST}:down`, label: `↓ ${w.newer} newer` }])
        )
      ) : null}
    </Box>
  )
}

/**
 * The composer (the user's item 3): a field labelled `To <name>` (or `To
 * every member of <team>`) with a short placeholder, its caption one muted
 * line under the frame saying how it's sent; [Send] primary (but while a
 * [Stop] is armed), [Broadcast to <team>] secondary. With no Input, where
 * messages are typed.
 */
function composerPart(el: PaneElements, body: AgentsBody, ctx: BodyContext): RenderElement | null {
  const c = body.composer
  if (!c) return null
  const { Box, Text } = el
  const sel = body.selected
  const team = body.broadcast
  const label = c.to !== null ? `To ${c.to}` : `To every member of ${team ?? 'the team'}`
  const caption = c.to !== null ? (sel?.sendNote ?? null) : `one message to each member, each reported; press a member to write to it alone`
  return (
    <Box flexDirection="column">
      {'Input' in el ? (
        field(el, { key: c.key, label, value: c.text, placeholder: 'message', submitLabel: 'send' }, caption, { surface: ctx.surface, isFocused: ctx.isFocused, focused: ctx.focused, columns: ctx.bodyColumns })
      ) : (
        <Text color={STYLE.muted}>messages are typed on the terminal or the desktop</Text>
      )}
      {actions(el, [
        c.to !== null && sel !== null && { key: `agents:send:${rowArg(body.scope, sel.key)}`, label: 'Send', primary: !sel.stop?.armed },
        team !== null && { key: `agents:broadcast:${body.scope}`, label: `Broadcast to ${team}` },
      ])}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// The events

type AgentsKey = { action: string; arg: string }

const parseKey = (key: string): AgentsKey | null => {
  if (!key.startsWith('agents:')) return null
  const [, action, ...rest] = key.split(':')
  return action ? { action, arg: rest.join(':') } : null
}

/** The last action's outcome, on the pane. */
function say(level: SwarmNotice['level'], text: string): void {
  const n = agentsNavOf()
  if (n) setAgentsNav({ ...n, notice: { level, text: oneLine(text, 600) } })
}

const staleToast = (p: Ports, was: string, now: string): void =>
  p.toast(`that was for ${scopeWords(was)}, and Agents shows ${scopeWords(now)} now, so it was ignored`)

/**
 * The row a press names, read again: only while the pane still shows the
 * scope it was drawn for and still lists the row. Otherwise the press is
 * stale: a toast, and null.
 */
async function rowFor(p: Ports, arg: string): Promise<RowFacts | null> {
  const n = agentsNavOf()!
  const a = parseRowArg(arg)
  if (!a) return null
  const scope = scopeOf(n.team)
  if (a.scope !== scope) {
    staleToast(p, a.scope, scope)
    return null
  }
  const facts = await gather(p, n)
  const row = facts.rows.find(r => r.key === a.key) ?? null
  if (!row) {
    p.toast(`${oneLine(a.key, 40)} isn't listed any more, so that was ignored`)
    const cur = agentsNavOf()!
    if (cur.selected === a.key) setAgentsNav({ ...cur, selected: null, armed: null })
  }
  return row
}

/** The composer's text as it's sent: no control characters; '' when it's only space. */
const outgoing = (text: string): string => clean(text, 100_000).trim()

type Sent = { ok: true } | { ok: false; reason: string }

/** One message to one row, the way decision 5 says for it; a throw is a refusal with its words. */
async function deliver(p: Ports, row: RowFacts, text: string): Promise<Sent> {
  const via = row.via
  if (!via) return { ok: false, reason: 'nothing here sends to it' }
  p.log(`agents pane: a message for ${row.name} (${via.kind === 'inbox' ? `appended to its inbox in team ${via.team}` : via.kind === 'name' ? 'sent by name' : `sent to agent ${via.agentId}`})`)
  try {
    if (via.kind === 'inbox') {
      const r = await deps.appendInbox(p, via.team, via.agent, { from: 'user', text })
      return r.ok ? { ok: true } : { ok: false, reason: oneLine(r.error, 200) || 'refused' }
    }
    const r = await p.send(via.kind === 'agent' ? { agentId: via.agentId } : via.name, text)
    return r.isDelivered ? { ok: true } : { ok: false, reason: oneLine(r.reason, 200) || 'refused' }
  } catch (err) {
    return { ok: false, reason: oneLine(errText(err), 200) }
  }
}

/**
 * [Send] (`button`) or Enter in the field (`enter`) to one row. Queued, the
 * text goes: a button's press draws a new, empty field; Enter's field the
 * engine empties itself once the hook answers.
 */
async function send(p: Ports, row: RowFacts, typed: string, from: 'button' | 'enter'): Promise<void> {
  const text = outgoing(typed)
  if (text === '') return say('warning', 'type a message first: an empty one is never sent')
  if (!row.via) return say('info', `${row.name} is this session, so there's nothing to send it`)
  const r = await deliver(p, row, text)
  const n = agentsNavOf()!
  if (!r.ok) return say('error', `not sent to ${row.name}: ${r.reason}`)
  const where = row.via.kind === 'inbox' ? ` in its inbox (team ${oneLine(row.via.team, 40)})` : ''
  setAgentsNav({
    ...n,
    text: '',
    field: '',
    gen: from === 'button' ? n.gen + 1 : n.gen,
    notice: { level: 'ok', text: `queued for ${row.name}${where}: it reads it at its next turn` },
  })
}

/** [Broadcast to <team>]: the composer's text to every member it can reach, one send or append each, and one notice for them all. */
async function broadcast(p: Ports, scopeArg: string): Promise<void> {
  const n = agentsNavOf()!
  const scope = scopeOf(n.team)
  if (scopeArg !== scope || n.team === null) return staleToast(p, scopeArg, scope)
  const text = outgoing(n.text)
  if (text === '') return say('warning', 'type a message first: an empty one is never sent')
  const facts = await gather(p, n)
  const name = oneLine(n.team, 40)
  if (!facts.team) return say('error', `there's no team named ${name} any more, so nothing was sent`)
  const targets = facts.rows.filter(r => r.via !== null)
  if (targets.length === 0) return say('info', `team ${name} has no member to send to`)
  const queued: string[] = []
  const refused: string[] = []
  for (const r of targets) {
    const got = await deliver(p, r, text)
    if (got.ok) queued.push(r.name)
    else refused.push(`${r.name} (${got.reason})`)
  }
  const cur = agentsNavOf()!
  const words = [queued.length > 0 ? `queued for ${queued.join(', ')}` : '', refused.length > 0 ? `refused: ${refused.join('; ')}` : ''].filter(x => x !== '').join('; ')
  const level: SwarmNotice['level'] = refused.length === 0 ? 'ok' : queued.length === 0 ? 'error' : 'warning'
  setAgentsNav({
    ...cur,
    // Once any member has it, sending it again would repeat it to them, so the field empties.
    ...(queued.length > 0 ? { text: '', field: '', gen: cur.gen + 1 } : {}),
    notice: { level, text: oneLine(`broadcast to ${name}: ${words}`, 600) },
  })
}

/** [Stop]: the first press arms it; a second on the same row within 5 s calls TaskStop (decision 6). */
async function stop(p: Ports, arg: string): Promise<void> {
  const row = await rowFor(p, arg)
  if (!row) return
  if (!row.stopId) {
    return say(
      'info',
      row.listed ? `${row.name} is ${row.status.text}, not running or waiting, so there's nothing to stop` : `${row.name} isn't this session's agent, so it can't be stopped here`,
    )
  }
  const n = agentsNavOf()!
  const now = await p.now()
  if (n.armed?.arg !== arg || !armedLive(n, now)) {
    setAgentsNav({ ...n, armed: { arg, at: now }, notice: { level: 'warning', text: `[Stop] again within 5 s to stop ${row.name}` } })
    return
  }
  setAgentsNav({ ...n, armed: null })
  p.log(`agents pane: TaskStop ${row.stopId} (${row.name})`)
  let r: ToolCallResult
  try {
    r = await p.callTool('TaskStop', { task_id: row.stopId })
  } catch (err) {
    return say('error', `${row.name} wasn't stopped: ${errText(err)}`)
  }
  const deny = (r as { deny?: unknown }).deny
  if (typeof deny === 'string') return say('error', `${row.name} wasn't stopped: ${deny}`)
  const text = typeof r.text === 'string' ? r.text : ''
  if (r.isError === true) return say('error', `${row.name} wasn't stopped: ${text || 'TaskStop reported an error'}`)
  const message = (r.result as { message?: unknown } | null | undefined)?.message
  say('ok', `stopped ${row.name}: ${typeof message === 'string' && message !== '' ? message : text || 'TaskStop answered with no message'}`)
}

/** A scope picked: a row of the picker's list, or a Button of its strip. Selection and an armed stop go with the old scope. */
function pickScope(token: string): void {
  const t = teamOfScope(token)
  const n = agentsNavOf()
  if (!t || !n) return
  // A pick folds a picker [Change] opened, whichever it picked.
  if (t.team === n.team) {
    if (n.picking) setAgentsNav({ ...n, picking: false })
    return
  }
  setAgentsNav({ ...n, team: t.team, selected: null, armed: null, picking: false })
}

/** The last view this module wrote: a footer's page where no render was noted. */
let lastView: AgentsPaneView | null = null

/** A context for a list's page where nothing was noted: unbounded, so the plan's windows are the inline ones. */
const NOMINAL: AgentsCtx = { surface: 'desktop', bodyColumns: 100, rows: Number.POSITIVE_INFINITY, placement: 'dock', focused: null, lists: {} }

/** The body and the context the lists were last drawn at on `surface`, else the last view written at NOMINAL. */
function drawnBody(surface: string | undefined): { body: AgentsBody; ctx: AgentsCtx } | null {
  const noted = surface !== undefined ? rendered.get(surface) : undefined
  if (noted) return noted
  return lastView?.body ? { body: lastView.body, ctx: NOMINAL } : null
}

/** What the wheel or a footer moves: the picker's list, the roster's, or the transcript's window. */
export type AgentsScrolled = 'picker' | 'roster' | 'lines'

/** The list a wheel tick or a footer moves: the picker's (while it's a list), else the roster's. */
function listFor(body: AgentsBody, ctx: AgentsCtx, which: 'picker' | 'roster', plan = agentsPlan(body, ctx)): ListSpec | null {
  if (which === 'picker') return plan.picker === 'list' ? pickerSpec(body, plan.pickerRows) : null
  return body.rows.length > 0 ? rosterSpec(body, plan.rosterRows) : null
}

/**
 * Moves one of the three by `by` rows (toward the top when negative) and
 * answers whether it moved; at its edge, or with nothing there, it didn't.
 * The transcript's offset counts from the newest line, so a tick down (by
 * > 0) brings it nearer.
 */
async function moveBy(p: Ports, body: AgentsBody, ctx: AgentsCtx, which: AgentsScrolled, by: number): Promise<boolean> {
  const plan = agentsPlan(body, ctx)
  if (which === 'lines') {
    const count = linesOf(body.selected)
    if (count === 0) return false
    const w = linesWindow(count, listOffset(LINES_LIST), plan.linesRows)
    return moveList(p, LINES_LIST, w.offset - Math.trunc(by), w.max)
  }
  const spec = listFor(body, ctx, which, plan)
  if (!spec) return false
  const place = listPlace(spec, ctx)
  return moveList(p, spec.id, scrolled(place.count, listOffset(spec.id), place.budget, by), place.window.max)
}

/** The rows a page moves: the window less one, so a row stays in sight. */
function pageRows(body: AgentsBody, ctx: AgentsCtx, which: AgentsScrolled): number {
  const plan = agentsPlan(body, ctx)
  return pageOf(which === 'lines' ? plan.linesRows : which === 'picker' ? plan.pickerRows : plan.rosterRows)
}

/** A footer's [↑ n above] or [↓ n more] (the lists'), or the transcript's where no wheel reaches, on `surface`: its window a page that way, as that surface drew it. */
async function pageList(p: Ports, which: AgentsScrolled, dir: string, surface: string | undefined): Promise<void> {
  const drawn = drawnBody(surface)
  if (!drawn || (dir !== 'up' && dir !== 'down')) return
  await moveBy(p, drawn.body, drawn.ctx, which, (dir === 'up' ? -1 : 1) * pageRows(drawn.body, drawn.ctx, which))
}

/**
 * Which part a body row is in: the picker's list, the roster's, the
 * transcript's window, or none (agentsTops; the hit test COMMON-5B asks for
 * where a body has two scrolled things). Pure.
 */
export function agentsHit(tops: AgentsTops, row: number): AgentsScrolled | null {
  const inside = (part: { top: number; height: number } | null): boolean => part !== null && row >= part.top && row < part.top + part.height
  if (inside(tops.picker)) return 'picker'
  if (inside(tops.roster)) return 'roster'
  if (inside(tops.lines)) return 'lines'
  return null
}

/**
 * The wheel (ui.scroll, routed by the hub). A tick over the picker's list,
 * the roster or the transcript moves that one, the row it's over told by
 * what the terminal last drew (ui/drawn.ts: the body's top, the pane's
 * offset) and agentsTops; over the rest of the body it passes on. The scroll
 * keys carry no pointer: they move the list the ring is in, else the
 * transcript, else the roster, a page at most. At an edge the tick passes on.
 */
export const onAgentsScroll: PortHook<UiScrollHook> = async (p, e, next) => {
  const d = lastDrawn()
  if (!d || d.shown !== 'agents' || e.by === 0) return next(e)
  const body = (d.view as AgentsPaneView | null)?.body
  if (!body) return next(e)
  const tops = agentsTops(body, d.ctx)
  let which: AgentsScrolled | null
  let by = e.by
  if (e.pointer) {
    const cols = d.ctx.bodyColumns
    if (e.pointer.column < 0 || (Number.isFinite(cols) && e.pointer.column >= cols)) return next(e)
    which = agentsHit(tops, d.scrollOffset + e.pointer.row - d.bodyTop)
  } else {
    const ring = d.ctx.focused ?? ''
    which = ring.startsWith('agents:scope:') || ring.startsWith(`${PICKER_LIST}:`) ? 'picker' : ring.startsWith('agents:select:') ? 'roster' : tops.lines ? 'lines' : 'roster'
    const page = pageRows(body, d.ctx, which)
    by = Math.sign(e.by) * Math.min(Math.abs(e.by), page)
  }
  if (which === null) return next(e)
  return (await moveBy(p, body, d.ctx, which, by)) ? {} : next(e)
}

/**
 * The transcript stays where the person left it (the user's ask, 2026-10-07):
 * pinned at the newest line while its offset is 0; scrolled up, it's moved
 * by the lines that came in since, so what's shown stays still; another row
 * selected starts at the newest again. The row and the line count last seen
 * are module memory: after a reload the window starts at the newest.
 */
let seenLines: { row: string; total: number } | null = null

async function keepLinesPlace(p: Ports, view: AgentsPaneView): Promise<void> {
  const sel = view.body?.selected ?? null
  const t = sel?.transcript
  const was = seenLines
  seenLines = sel && t && t.readable ? { row: sel.key, total: t.total } : null
  const offset = listOffset(LINES_LIST)
  if (offset === 0) return
  if (!was || !seenLines || was.row !== seenLines.row) {
    await moveList(p, LINES_LIST, 0, 0)
    return
  }
  const came = seenLines.total - was.total
  if (came > 0) await moveList(p, LINES_LIST, offset + came, Math.max(0, (t?.lines.length ?? 1) - 1))
}

/** One press (on `surface`, which a footer's page reads): the action on rows read again, then the redraw. */
export async function pressAgents(p: Ports, key: string, surface?: string): Promise<void> {
  const k = parseKey(key)
  if (!k) return
  await restoreAgentsNav(p)
  const cur = agentsNavOf()
  if (!cur) {
    p.toast("Agents isn't open in this session, so that was ignored: /litter agents opens it")
    return
  }
  // A new action's outcome replaces the last one's.
  setAgentsNav({ ...cur, notice: null })
  try {
    switch (k.action) {
      case 'scope':
      case 'leave':
        // A picker's row or Button; [This session's agents] under an ended team's notice.
        pickScope(k.arg)
        break
      case 'select':
      case 'message': {
        // A row's press, or its menu's Message: it's selected, so the composer writes to it.
        const row = await rowFor(p, k.arg)
        const n = agentsNavOf()!
        if (row && n.selected !== row.key) setAgentsNav({ ...n, selected: row.key, armed: null })
        break
      }
      case 'transcript': {
        // The menu's Transcript: selected, its transcript at its newest line.
        const row = await rowFor(p, k.arg)
        const n = agentsNavOf()!
        if (!row) break
        if (n.selected !== row.key) setAgentsNav({ ...n, selected: row.key, armed: null })
        await moveList(p, LINES_LIST, 0, 0)
        break
      }
      case 'teams': {
        const n = agentsNavOf()!
        if (k.arg === 'all' || k.arg === 'running') setAgentsNav({ ...n, showAll: k.arg === 'all' })
        break
      }
      case 'picker': {
        const n = agentsNavOf()!
        if (k.arg === 'open') setAgentsNav({ ...n, picking: true })
        break
      }
      case 'scopes':
        await pageList(p, 'picker', k.arg, surface)
        break
      case 'roster':
        await pageList(p, 'roster', k.arg, surface)
        break
      case 'lines':
        await pageList(p, 'lines', k.arg, surface)
        break
      case 'send': {
        const row = await rowFor(p, k.arg)
        if (row) await send(p, row, agentsNavOf()!.text, 'button')
        break
      }
      case 'broadcast':
        await broadcast(p, k.arg)
        break
      case 'stop':
        await stop(p, k.arg)
        break
      case 'open-swarm': {
        // A swarm node's [Open in Swarms]: its swarm's browser, the node picked (WP-DG's `<swarm> <agentId>`), in this pane.
        const row = await rowFor(p, k.arg)
        const b = row?.swarm?.binding
        if (!b) break
        await showSection(p, 'swarms', `${b.swarm} ${b.agentId}`)
        return
      }
      default:
        break
    }
  } catch (err) {
    p.log(`agents pane: ${key} failed: ${errText(err)}`)
    say('error', `that failed: ${errText(err)}`)
  }
  await drawAgents(p)
}

/** The composer's field: a change is kept without a redraw; Enter sends to the selected row. */
async function inputAgents(p: Ports, key: string, value: string, kind: 'change' | 'submit'): Promise<void> {
  const k = parseKey(key)
  if (!k || k.action !== 'text') return
  await restoreAgentsNav(p)
  const n = agentsNavOf()
  if (!n) return
  if (kind !== 'submit') {
    putText(value)
    return
  }
  setAgentsNav({ ...n, text: value, notice: null })
  try {
    if (n.selected === null) {
      say('info', n.team === null ? 'press an agent first: Enter sends to the one selected' : `press a member first, or [Broadcast to ${oneLine(n.team, 40)}]`)
    } else {
      const row = await rowFor(p, rowArg(scopeOf(n.team), n.selected))
      if (row) await send(p, row, value, 'enter')
    }
  } catch (err) {
    p.log(`agents pane: ${key} failed: ${errText(err)}`)
    say('error', `that failed: ${errText(err)}`)
  }
  // The engine empties a submitted field once the hook answers: text that wasn't sent comes back in a new field.
  const after = agentsNavOf()!
  if (after.text !== '') setAgentsNav({ ...after, gen: after.gen + 1, field: after.text })
  await drawAgents(p)
}

async function selectAgents(p: Ports, key: string, value: string): Promise<void> {
  const k = parseKey(key)
  if (!k || k.action !== 'scope') return
  await restoreAgentsNav(p)
  if (!agentsNavOf()) return
  pickScope(value)
  await drawAgents(p)
}

/** The pane's ui.message, ui.press, ui.input, ui.select and ui.scroll; anything not keyed `agents:` passes on. */
export const onAgentsUi: PaneUiHandlers = {
  // The roster's Client posts to the hub, which presses its keys here (ui/hub.ts, listPost); nothing else posts.
  message: async (p, e, next) => next(e),
  press: async (p, e, next) => {
    if (!parseKey(e.element)) return next(e)
    await pressAgents(p, e.element, e.surface)
    return { element: e.element }
  },
  input: async (p, e, next) => {
    if (!parseKey(e.element)) return next(e)
    await inputAgents(p, e.element, e.value, e.kind)
    return { element: e.element, value: e.value }
  },
  select: async (p, e, next) => {
    if (!parseKey(e.element)) return next(e)
    await selectAgents(p, e.element, e.value)
    return { element: e.element, value: e.value }
  },
  // Reached once the hub's agents section forwards ui.scroll (a hub.ts line, WP-DB's; the report has it).
  scroll: async (p, e, next) => onAgentsScroll(p, e, next),
}

// ---------------------------------------------------------------------------
// The tick

/** Agents' tick (ui/hub.ts's litterTick, while Agents is shown): the view again, written only when its stamp moved. */
export async function agentsTick(p: Ports): Promise<void> {
  await restoreAgentsNav(p)
  if (!agentsNavOf()) return
  await drawAgents(p)
}

/** After a /clear wiped $.state (clear.ts): the pane's view again, if it's open. */
export async function refreshAgents(p: Ports): Promise<void> {
  await restoreAgentsNav(p)
  if (agentsNavOf()) await drawAgents(p, true)
}

/** A fresh module's memory, as after a hot reload: no navigation (it comes back from $.store), nothing written yet. */
export function resetAgentsPaneForTests(): void {
  viewSeq = 0
  lastKey = null
  lastView = null
  rendered.clear()
  seenLines = null
  savedRev = -1
  resetAgentsNavForTests()
}
