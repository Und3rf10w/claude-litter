// The agents pane's view (phase 5; COMMON step 6, decisions 5, 6, 16): this
// session's agents (`$.agent.list()`) or a team's members (CE's store.ts),
// each with its status and unread count, and for the selected one its
// pending inbox and the tail of its transcript. Owner: WP-CG.
//
// The navigation (the team shown, the row selected, the composer's text, the
// armed stop and when it was armed) lives in module memory and is mirrored in
// $.store (AGENTS_STORE_KEY) with the session id, as the board's is
// (board/view.ts), so a hot reload keeps it. gather() does every read;
// agentsView() is pure and builds the view from what gather() read. The pane
// acts on the rows a fresh gather() reads, so a press for a row that's gone
// is caught.
//
// Every text from a file, a transcript or the agent list is cleaned and cut
// (swarm/view.ts, clean and oneLine): names, types and messages are model or
// user text.

import type { ListedAgent, Ports, SessionMessage } from '../ports'
import type { InboxEntry, TeamInfo } from '../uitypes'
import type {
  AgentsInboxEntry,
  AgentsPaneView,
  AgentsRow,
  AgentsSelected,
  AgentsStatus,
  SwarmNotice,
  SwarmOption,
  SwarmSpan,
} from '../../types/index'
import { appendInbox, readInbox, teams } from '../team/store'
import { clean, clockAt, firstLine, oneLine } from '../swarm/view'

// CE's store, through one table so tier 2 can stand in for it (COMMON,
// "Another package's module"). The mod never changes it.
export const deps = {
  teams: (...a: Parameters<typeof teams>) => teams(...a),
  readInbox: (...a: Parameters<typeof readInbox>) => readInbox(...a),
  appendInbox: (...a: Parameters<typeof appendInbox>) => appendInbox(...a),
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The $.store key the navigation is mirrored under, read back only by the session that wrote it. */
export const AGENTS_STORE_KEY = 'litter.agents.pane'
/** Rows drawn, and inboxes read, at most: the render stays small (decision 11). */
export const MAX_ROWS = 40
/** Inbox entries drawn at most: the newest, oldest first. */
export const INBOX_SHOWN = 20
/** The transcript's tail, and with [More] (the brief; the swarm browser's tail). */
export const TAIL = 8
export const TAIL_MORE = 30
/** A first [Stop] arms it for this long; the second within it stops (decision 6). */
export const STOP_ARM_MS = 5000
/** The engine's name for a team's lead member (`Fi`, 2.1.289 `:66754`). */
export const LEAD_MEMBER = 'team-lead'
/** The picker's value for this session's agents; a team's is `team.<name, URI-encoded>`. */
export const SESSION_SCOPE = 'session'

// ---------------------------------------------------------------------------
// Keys

/** The scope token every key of the view carries: this session, or a team by name. */
export const scopeOf = (team: string | null): string => (team === null ? SESSION_SCOPE : `team.${encodeURIComponent(team)}`)

/** A scope token back to its team (null for this session), or null when it's no token of ours. */
export function teamOfScope(scope: string): { team: string | null } | null {
  if (scope === SESSION_SCOPE) return { team: null }
  if (!scope.startsWith('team.')) return null
  try {
    const team = decodeURIComponent(scope.slice('team.'.length))
    return team === '' ? null : { team }
  } catch {
    return null
  }
}

/** A row's address in a key: `<scope>/<row key, URI-encoded>`, so neither part holds a `/` or a `:`. */
export const rowArg = (scope: string, key: string): string => `${scope}/${encodeURIComponent(key)}`

export function parseRowArg(arg: string): { scope: string; key: string } | null {
  const i = arg.indexOf('/')
  if (i <= 0) return null
  try {
    const key = decodeURIComponent(arg.slice(i + 1))
    return key === '' ? null : { scope: arg.slice(0, i), key }
  } catch {
    return null
  }
}

/** What a scope shows, in words, for a stale press's toast. */
export function scopeWords(scope: string): string {
  const t = teamOfScope(scope)
  return !t ? 'something else' : t.team === null ? "this session's agents" : `team ${oneLine(t.team, 40)}`
}

// ---------------------------------------------------------------------------
// The navigation

export type AgentsNav = {
  /** The team shown, as its config names it; null for this session's agents. */
  team: string | null
  /** The selected row's key: an agent's id (this session), or a member's name (a team). */
  selected: string | null
  /** What's typed in the composer, from its change events: kept without a redraw, so a keystroke in flight isn't lost. */
  text: string
  /**
   * The composer field's generation and the text it's drawn holding (the
   * view's `composer`). The engine keeps what you type until the field is
   * drawn holding another text, so the pane draws a new field (gen + 1) to
   * clear it after a send, or to put the text back after a refusal.
   */
  gen: number
  field: string
  /** [More]: the transcript's last 30 messages instead of 8. */
  more: boolean
  /** The armed [Stop]: the row (`<scope>/<row>`) and when, in ms (decision 6). */
  armed: { arg: string; at: number } | null
  notice: SwarmNotice | null
}

type AgentsStore = { v: 1; session: string; nav: AgentsNav | null }

let agentsNav: AgentsNav | null = null
let restored = false
let rev = 0
let textDirty = false

export const blankAgentsNav = (team: string | null): AgentsNav => ({
  team,
  selected: null,
  text: '',
  gen: 0,
  field: '',
  more: false,
  armed: null,
  notice: null,
})

/** The pane's navigation, or null while it was never opened in this session. */
export const agentsNavOf = (): AgentsNav | null => agentsNav
/** Bumped by every change of the navigation but typing: part of the rebuild check. */
export const agentsNavRev = (): number => rev
/** Typing changed the text since the navigation was last saved. */
export const agentsTextDirty = (): boolean => textDirty

export function setAgentsNav(next: AgentsNav | null): void {
  agentsNav = next
  restored = true
  rev++
}

/** A change event's text: kept, saved on the next save, and never a redraw. */
export function putText(value: string): void {
  if (!agentsNav) return
  agentsNav = { ...agentsNav, text: value }
  textDirty = true
}

/** Whether the armed stop is still live at `now`: a second [Stop] now would stop. */
export const armedLive = (n: AgentsNav, now: number): boolean => n.armed !== null && now - n.armed.at < STOP_ARM_MS

const str = (x: unknown, fallback = ''): string => (typeof x === 'string' ? x : fallback)
const NOTICE_LEVELS = ['ok', 'info', 'warning', 'error'] as const

/** After a hot reload module memory is empty: the navigation comes back from $.store, when this session wrote it. */
export async function restoreAgentsNav(p: Ports): Promise<void> {
  if (restored) return
  restored = true
  try {
    const raw = (await p.store.get(AGENTS_STORE_KEY)) as Partial<AgentsStore> | undefined
    if (!raw || raw.v !== 1 || raw.session !== (await p.sessionId()) || !raw.nav || agentsNav !== null) return
    const n = raw.nav as Partial<AgentsNav>
    const armed = n.armed as { arg?: unknown; at?: unknown } | null | undefined
    const notice = n.notice as { text?: unknown; level?: unknown } | null | undefined
    agentsNav = {
      team: typeof n.team === 'string' && n.team !== '' ? n.team : null,
      selected: typeof n.selected === 'string' && n.selected !== '' ? n.selected : null,
      text: str(n.text),
      gen: Number.isInteger(n.gen) && (n.gen as number) >= 0 ? (n.gen as number) : 0,
      field: str(n.field),
      more: n.more === true,
      armed: armed && typeof armed.arg === 'string' && typeof armed.at === 'number' && Number.isFinite(armed.at) ? { arg: armed.arg, at: armed.at } : null,
      notice:
        notice && typeof notice.text === 'string' && (NOTICE_LEVELS as readonly unknown[]).includes(notice.level)
          ? { text: oneLine(notice.text, 400), level: notice.level as SwarmNotice['level'] }
          : null,
    }
    // What was typed and not drawn comes back in a field of its own.
    if (agentsNav.text !== agentsNav.field) agentsNav = { ...agentsNav, gen: agentsNav.gen + 1, field: agentsNav.text }
    rev++
  } catch (err) {
    p.log(`agents pane: the navigation wasn't read back: ${errText(err)}`)
  }
}

export async function saveAgentsNav(p: Ports): Promise<void> {
  try {
    const value: AgentsStore = { v: 1, session: await p.sessionId(), nav: agentsNav }
    await p.store.set(AGENTS_STORE_KEY, value)
    textDirty = false
  } catch (err) {
    p.log(`agents pane: the navigation wasn't saved: ${errText(err)}`)
  }
}

/** A fresh module's memory, as after a hot reload (the store is kept). */
export function resetAgentsNavForTests(): void {
  agentsNav = null
  restored = false
  rev = 0
  textDirty = false
}

// ---------------------------------------------------------------------------
// Statuses

/** `$.agent.list()`'s words in 2.1.289 (AgentStatus), as drawn: the brief's glyphs, 15.6's theme keys. */
const STATUS = new Map<string, AgentsStatus>([
  ['running', { text: 'running', glyph: '▸', color: 'background' }],
  // The engine's `waiting` is held on its own background work (15.6: `background`), not a question.
  ['waiting', { text: 'waiting', glyph: '·', color: 'background' }],
  ['idle', { text: 'idle', glyph: '·', color: 'inactive' }],
  ['completed', { text: 'completed', glyph: '✓', color: 'success' }],
  ['failed', { text: 'failed', glyph: '✕', color: 'error' }],
  ['killed', { text: 'stopped', glyph: '−', color: 'inactive' }],
])

/** A listed agent's status; any other word (`pending`, a later engine's) as itself. */
export function statusOf(status: unknown): AgentsStatus {
  const known = typeof status === 'string' ? STATUS.get(status) : undefined
  return known ? { ...known } : { text: oneLine(status, 24) || 'unknown', glyph: '', color: 'inactive' }
}

/** A team's member that `$.agent.list()` doesn't list: it runs in another session, or not at all. */
export const NOT_HERE: AgentsStatus = { text: 'not in this session', glyph: '', color: 'inactive', dim: true }
/** The lead member of a team this session leads: this session itself. */
const THIS_SESSION: AgentsStatus = { text: 'this session', glyph: '', color: 'inactive', dim: true }

// ---------------------------------------------------------------------------
// The reads

/** How a message reaches a row (COMMON decision 5). */
export type SendVia =
  | { kind: 'agent'; agentId: string }
  | { kind: 'name'; name: string }
  | { kind: 'inbox'; team: string; agent: string }

/** One row as read, with what the pane may do to it. */
export type RowFacts = {
  key: string
  name: string
  type: string
  status: AgentsStatus
  /** This session's agent it is, or null. */
  listed: ListedAgent | null
  /** Its inbox, as the team's config names the team and the agent; null when it has none. */
  inbox: { team: string; agent: string } | null
  /** Null: nothing here sends to it. */
  via: SendVia | null
  /** TaskStop's `task_id` (a teammate's address, else its id: the d.ts, AgentInfo.teammateId), while it's this session's and running or waiting. */
  stopId: string | null
}

export type InboxFacts = { entries: InboxEntry[] | null; stamp: string; error: string | null }

export type AgentsFacts = {
  /** The team shown, or null (this session, or a team that's gone). */
  team: TeamInfo | null
  /** This session leads the team shown. */
  led: boolean
  teams: TeamInfo[]
  rows: RowFacts[]
  /** By row key: the inboxes read (the shown rows' and the selected one's). */
  inboxes: Record<string, InboxFacts>
  /** The selected agent's transcript: null when it can't be read, undefined when it wasn't (no agent of this session selected). */
  messages: SessionMessage[] | null | undefined
  problems: string[]
}

/** `<name>@<team>`, a teammate's address, split at its last `@`. */
function addressOf(id: string | undefined): { name: string; team: string } | null {
  if (typeof id !== 'string') return null
  const at = id.lastIndexOf('@')
  return at > 0 && at < id.length - 1 ? { name: id.slice(0, at), team: id.slice(at + 1) } : null
}

const labelOf = (a: ListedAgent): string => oneLine(a.name || a.description || a.type || a.id, 40) || 'agent'
const stoppable = (a: ListedAgent): boolean => a.status === 'running' || a.status === 'waiting'

/** This session's agents, in the engine's order; a teammate's inbox is its team's file for its name. */
function sessionRows(listed: readonly ListedAgent[], teamList: readonly TeamInfo[]): RowFacts[] {
  const seen = new Set<string>()
  const rows: RowFacts[] = []
  for (const a of listed) {
    if (typeof a.id !== 'string' || a.id === '' || seen.has(a.id)) continue
    seen.add(a.id)
    const addr = addressOf(a.teammateId)
    const team = addr ? teamList.find(t => t.name === addr.team) : undefined
    rows.push({
      key: a.id,
      name: labelOf(a),
      type: oneLine(a.type, 40),
      status: statusOf(a.status),
      listed: a,
      inbox: addr && team ? { team: team.name, agent: addr.name } : null,
      via: { kind: 'agent', agentId: a.id },
      stopId: stoppable(a) ? (a.teammateId ?? a.id) : null,
    })
  }
  return rows
}

/**
 * A team's members, in its config's order. A member this session lists (a
 * teammate of the team it leads) is its agent: its status, its transcript,
 * a send through the engine and [Stop]. Any other member of a team this
 * session leads is sent to by name; of another team, by the locked append to
 * its inbox (decision 5). The lead member of a team this session leads is
 * this session.
 */
function teamRows(team: TeamInfo, listed: readonly ListedAgent[], led: boolean): RowFacts[] {
  const seen = new Set<string>()
  const rows: RowFacts[] = []
  for (const m of team.members) {
    if (typeof m.name !== 'string' || m.name === '' || seen.has(m.name)) continue
    seen.add(m.name)
    const a = listed.find(x => typeof x.teammateId === 'string' && (x.teammateId === m.agentId || x.teammateId === `${m.name}@${team.name}`)) ?? null
    const self = !a && led && m.name === LEAD_MEMBER
    const via: SendVia | null = a
      ? { kind: 'agent', agentId: a.id }
      : self
        ? null
        : led
          ? { kind: 'name', name: m.name }
          : { kind: 'inbox', team: team.name, agent: m.name }
    rows.push({
      key: m.name,
      name: oneLine(m.name, 40),
      type: oneLine(m.agentType ?? '', 40),
      status: a ? statusOf(a.status) : self ? { ...THIS_SESSION } : { ...NOT_HERE },
      listed: a,
      inbox: { team: team.name, agent: m.name },
      via,
      stopId: a && stoppable(a) ? (a.teammateId ?? a.id) : null,
    })
  }
  return rows
}

/**
 * Everything the view and the presses read, once: the agent list, the
 * teams, the shown rows' inboxes, and the selected agent's transcript only
 * (decision 16). A read that fails is a problem line, never a throw.
 */
export async function gather(p: Ports, nav: AgentsNav): Promise<AgentsFacts> {
  const problems: string[] = []
  const sessionId = await p.sessionId().catch(() => '')
  let listed: ListedAgent[] = []
  try {
    listed = await p.listAgents()
  } catch (err) {
    problems.push(`this session's agents couldn't be listed: ${oneLine(errText(err), 200)}`)
  }
  let teamList: TeamInfo[] = []
  try {
    teamList = await deps.teams(p)
  } catch (err) {
    problems.push(`the teams couldn't be read: ${oneLine(errText(err), 200)}`)
  }
  const team = nav.team === null ? null : (teamList.find(t => t.name === nav.team) ?? null)
  if (nav.team !== null && !team) problems.push(`there's no team named ${oneLine(nav.team, 60)} with a readable config`)
  const led =
    team !== null &&
    ((team.leadSessionId !== null && team.leadSessionId !== '' && team.leadSessionId === sessionId) || listed.some(a => addressOf(a.teammateId)?.team === team.name))
  const rows = nav.team === null ? sessionRows(listed, teamList) : team ? teamRows(team, listed, led) : []

  const toRead = rows.slice(0, MAX_ROWS)
  const sel = rows.find(r => r.key === nav.selected) ?? null
  if (sel && !toRead.includes(sel)) toRead.push(sel)
  const inboxes: Record<string, InboxFacts> = {}
  await Promise.all(
    toRead.map(async r => {
      if (!r.inbox) return
      try {
        const got = await deps.readInbox(p, r.inbox.team, r.inbox.agent)
        inboxes[r.key] = got ? { entries: Array.isArray(got.entries) ? got.entries : [], stamp: str(got.stamp), error: null } : { entries: [], stamp: 'none', error: null }
      } catch (err) {
        const error = oneLine(errText(err), 200)
        inboxes[r.key] = { entries: null, stamp: `error ${error}`, error }
      }
    }),
  )
  for (const r of toRead) {
    const e = inboxes[r.key]?.error
    if (e) problems.push(`${r.name}'s inbox couldn't be read: ${e}`)
  }

  let messages: SessionMessage[] | null | undefined
  if (sel?.listed) {
    try {
      messages = await p.messages(sel.listed.id)
    } catch {
      messages = null
    }
  }
  return { team, led, teams: teamList, rows, inboxes, messages, problems }
}

/**
 * What the tick compares (decision 16): the rows' ids and statuses, each
 * inbox's stamp (CE's: the file's size and mtime) and count, the teams, the
 * selected agent's message count, and what couldn't be read.
 */
export function factsStamp(f: AgentsFacts): string {
  return JSON.stringify([
    f.rows.map(r => [r.key, r.status.text, r.name, r.type, r.via?.kind ?? '', r.stopId ?? '', f.inboxes[r.key]?.stamp ?? '', f.inboxes[r.key]?.entries?.length ?? -1]),
    f.teams.map(t => [t.name, t.mtimeMs, t.members.length]),
    f.led,
    f.messages === undefined ? -2 : f.messages === null ? -1 : f.messages.length,
    f.problems,
  ])
}

// ---------------------------------------------------------------------------
// The view (pure)

const pad = (n: number): string => String(n).padStart(2, '0')

/** An entry's time: `HH:MM` today, else the day before it; the timestamp as written when it doesn't parse. */
export function whenOf(timestamp: unknown, now: number): string {
  const at = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN
  if (!Number.isFinite(at)) return oneLine(timestamp, 24) || 'no time'
  const d = new Date(at)
  const n = new Date(now)
  const today = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()
  return today ? clockAt(at) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clockAt(at)}`
}

/** One pending entry: its sender, its time, and its text cleaned, in at most 3 lines (the last marked when there's more). */
export function entryOf(e: InboxEntry, now: number): AgentsInboxEntry {
  const all = clean(e?.text, 8000)
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '')
  const lines = all.slice(0, 3).map(l => oneLine(l, 200))
  if (all.length > 3) lines[2] = `${lines[2]} …`
  return { from: oneLine(e?.from, 40) || 'unknown', at: whenOf(e?.timestamp, now), lines: lines.length > 0 ? lines : ['(empty)'] }
}

/** A tool call's first argument, one line. */
function firstArg(input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const v = Object.values(input as Record<string, unknown>)[0]
  if (v === undefined) return ''
  return oneLine(typeof v === 'string' ? v : (JSON.stringify(v) ?? ''), 80)
}

/** One message as one line: its text's first line, else its first tool and that tool's first argument; nothing for a row with neither. */
export function messageLine(m: SessionMessage): SwarmSpan | null {
  const text = firstLine(m?.text, 200)
  if (text !== '') return { text: `${m.role === 'assistant' ? '◆' : '›'} ${text}`, ...(m.role === 'user' ? { dim: true } : {}) }
  const uses = Array.isArray(m?.toolUses) ? m.toolUses : []
  const t = uses[0] as { tool?: unknown; name?: unknown; input?: unknown } | undefined
  if (!t) return null
  const arg = firstArg(t.input)
  const more = uses.length > 1 ? ` (+${uses.length - 1} more)` : ''
  return { text: `↳ ${oneLine(t.tool ?? t.name ?? 'tool', 40)}${arg ? ` ${arg}` : ''}${more}`, color: 'subtle' }
}

/** The transcript's tail: the last 8 messages that read as a line, or 30 with [More]. */
export function tailOf(messages: readonly SessionMessage[] | null | undefined, more: boolean): NonNullable<AgentsSelected['transcript']> {
  if (!Array.isArray(messages)) return { readable: false, lines: [], total: 0, more: false }
  const lines = messages.map(messageLine).filter((l): l is SwarmSpan => l !== null)
  return { readable: true, lines: lines.slice(-(more ? TAIL_MORE : TAIL)), total: lines.length, more }
}

function sendNote(via: SendVia | null): string | null {
  if (!via) return null
  if (via.kind === 'inbox') return `appended to its inbox in team ${oneLine(via.team, 40)}: it reads it at its next turn`
  if (via.kind === 'name') return 'sent by its name through the engine: it reads it at its next turn'
  return 'sent through the engine: it reads it at its next turn'
}

function unreadOf(f: AgentsFacts, r: RowFacts): number | null {
  if (!r.inbox) return null
  const box = f.inboxes[r.key]
  return box?.entries ? box.entries.length : null
}

function selectedOf(f: AgentsFacts, nav: AgentsNav, r: RowFacts, now: number): AgentsSelected {
  const box = r.inbox ? f.inboxes[r.key] : undefined
  const entries = box?.entries ?? []
  const inbox = r.inbox
    ? { entries: entries.slice(-INBOX_SHOWN).map(e => entryOf(e, now)), hidden: Math.max(0, entries.length - INBOX_SHOWN), error: box?.error ?? null }
    : null
  const arg = rowArg(scopeOf(nav.team), r.key)
  return {
    key: r.key,
    name: r.name,
    inbox,
    transcript: r.listed ? tailOf(f.messages, nav.more) : null,
    sendNote: sendNote(r.via),
    stop: r.stopId ? { armed: nav.armed?.arg === arg && armedLive(nav, now) } : null,
  }
}

/** This session first, then each team (newest first, as the store answers), with its member count. */
function pickerOptions(teamList: readonly TeamInfo[]): SwarmOption[] {
  return [
    { value: SESSION_SCOPE, label: 'this session' },
    ...teamList.slice(0, 20).map(t => ({ value: scopeOf(t.name), label: `${oneLine(t.name, 40)} (${plural(t.members.length, 'member')})` })),
  ]
}

function titleOf(f: AgentsFacts, nav: AgentsNav): SwarmSpan[] {
  const head: SwarmSpan = { text: 'litter · agents', bold: true }
  if (nav.team === null) {
    const running = f.rows.filter(r => r.listed?.status === 'running').length
    return [head, { text: ` · this session · ${plural(f.rows.length, 'agent')}${running > 0 ? ` · ${running} running` : ''}` }]
  }
  return [
    head,
    { text: ' · team ' },
    { text: oneLine(nav.team, 40), color: 'cyan' },
    { text: f.team ? ` · ${plural(f.rows.length, 'member')}${f.led ? ' · led by this session' : ''}` : ' · not found', ...(f.team ? {} : { dim: true }) },
  ]
}

/** The view, from what gather() read and the navigation: a pure function, `v` the writer's. */
export function agentsView(f: AgentsFacts, nav: AgentsNav, now: number, v: number): AgentsPaneView {
  const shown = f.rows.slice(0, MAX_ROWS)
  const rows: AgentsRow[] = shown.map(r => ({ key: r.key, name: r.name, type: r.type, status: r.status, unread: unreadOf(f, r) }))
  const sel = f.rows.find(r => r.key === nav.selected) ?? null
  const to = sel?.via ? sel.name : null
  const broadcast = nav.team !== null && f.team ? oneLine(f.team.name, 40) : null
  return {
    view: 'agents',
    v,
    body: {
      title: titleOf(f, nav),
      notice: nav.notice,
      scope: scopeOf(nav.team),
      options: pickerOptions(f.teams),
      rows,
      hiddenRows: f.rows.length - shown.length,
      selected: sel ? selectedOf(f, nav, sel, now) : null,
      composer: to !== null || broadcast !== null ? { key: `agents:text:${nav.gen}`, text: nav.field, to } : null,
      broadcast,
      problems: f.problems.slice(0, 6),
    },
  }
}

/** gather() then agentsView(), for a caller that wants both (the pane, tier 2). */
export async function buildAgents(p: Ports, nav: AgentsNav, v = 1): Promise<{ view: AgentsPaneView; facts: AgentsFacts }> {
  const facts = await gather(p, nav)
  return { view: agentsView(facts, nav, await p.now(), v), facts }
}
