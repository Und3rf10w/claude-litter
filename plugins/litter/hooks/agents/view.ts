// The agents pane's view (phase 5; COMMON step 6, decisions 5, 6, 16): this
// session's agents (`$.agent.list()`) or a team's members (CE's store.ts),
// each with its status and unread count, and for the selected one its
// pending inbox and its transcript's last 200 lines, which the pane shows a
// window of. Owner: WP-CG; phase 5b, WP-DF.
//
// Only teams that run (WP-DF §0, the user's ask). A team is active when this
// session lists one of its members, or leads it, or the engine's registry of
// running sessions (store.ts, runningSessions) lists its lead session. The
// picker leaves the rest out unless one is shown or was named, and counts
// them; a team that ended, shown on purpose, says so once, its members read
// "ended", and nothing sends to it. When the registry can't be read, nobody
// can tell: every team is offered, as before.
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
  AgentsBody,
  AgentsInboxEntry,
  AgentsOption,
  AgentsPaneView,
  AgentsRow,
  AgentsSelected,
  AgentsStatus,
  SwarmNotice,
  SwarmSpan,
} from '../../types/index'
import { appendInbox, readInbox, runningSessions, teams, type RunningSession, type TeamRecord } from '../team/store'
import { clean, clockAt, oneLine } from '../swarm/view'
import { STYLE } from '../ui/style'

// CE's store, through one table so tier 2 can stand in for it (COMMON,
// "Another package's module"). The mod never changes it.
export const deps = {
  teams: (...a: Parameters<typeof teams>) => teams(...a),
  readInbox: (...a: Parameters<typeof readInbox>) => readInbox(...a),
  appendInbox: (...a: Parameters<typeof appendInbox>) => appendInbox(...a),
  sessions: (...a: Parameters<typeof runningSessions>) => runningSessions(...a),
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

/** The $.store key the navigation is mirrored under, read back only by the session that wrote it. */
export const AGENTS_STORE_KEY = 'litter.agents.pane'
/** Rows drawn, and inboxes read, at most: the render stays small (decision 11). */
export const MAX_ROWS = 40
/** Inbox entries drawn at most: the newest, oldest first. */
export const INBOX_SHOWN = 20
/** The transcript's lines the view keeps, the newest: the pane shows a window of them (WP-DF). */
export const LINES_KEPT = 200
/** A first [Stop] arms it for this long; the second within it stops (decision 6). */
export const STOP_ARM_MS = 5000
/** The engine's name for a team's lead member (`Fi`, 2.1.289 `:66754`). */
export const LEAD_MEMBER = 'team-lead'
/** The picker's value for this session's agents; a team's is `team.<name, URI-encoded>`. */
export const SESSION_SCOPE = 'session'
/** Teams the picker offers at most, newest first: its list scrolls, and the view stays small (decision 11). */
export const MAX_TEAMS = 200

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
  /** The armed [Stop]: the row (`<scope>/<row>`) and when, in ms (decision 6). */
  armed: { arg: string; at: number } | null
  notice: SwarmNotice | null
  /** [Show all]: the picker lists the teams that ended too (WP-DF §0). */
  showAll: boolean
  /** The team `/litter agents <team>` named, or a pick chose: kept in the picker, ended or not. */
  named: string | null
  /** [Change] opened the picker where it's folded to a line (inline, or a short pane); a pick folds it again. */
  picking: boolean
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
  armed: null,
  notice: null,
  showAll: false,
  named: null,
  picking: false,
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
      armed: armed && typeof armed.arg === 'string' && typeof armed.at === 'number' && Number.isFinite(armed.at) ? { arg: armed.arg, at: armed.at } : null,
      notice:
        notice && typeof notice.text === 'string' && (NOTICE_LEVELS as readonly unknown[]).includes(notice.level)
          ? { text: oneLine(notice.text, 400), level: notice.level as SwarmNotice['level'] }
          : null,
      showAll: n.showAll === true,
      named: typeof n.named === 'string' && n.named !== '' ? n.named : null,
      picking: n.picking === true,
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
  ['running', { text: 'running', glyph: '▸', color: STYLE.running }],
  // The engine's `waiting` is held on its own background work (15.6: `running`), not a question.
  ['waiting', { text: 'waiting', glyph: '·', color: STYLE.running }],
  ['idle', { text: 'idle', glyph: '·', color: STYLE.idle }],
  ['completed', { text: 'completed', glyph: '✓', color: STYLE.done }],
  ['failed', { text: 'failed', glyph: '✕', color: STYLE.failed }],
  ['killed', { text: 'stopped', glyph: '−', color: STYLE.idle }],
])

/** A listed agent's status; any other word (`pending`, a later engine's) as itself. */
export function statusOf(status: unknown): AgentsStatus {
  const known = typeof status === 'string' ? STATUS.get(status) : undefined
  return known ? { ...known } : { text: oneLine(status, 24) || 'unknown', glyph: '', color: STYLE.idle }
}

/** A team's member that `$.agent.list()` doesn't list: it runs in another session, or not at all. */
export const NOT_HERE: AgentsStatus = { text: 'not in this session', glyph: '', color: STYLE.muted, dim: true }
/** A member of a team whose lead session ended (WP-DF §0): nothing runs it. */
export const ENDED: AgentsStatus = { text: 'ended', glyph: '−', color: STYLE.idle }
/** The lead member of a team this session leads: this session itself. */
const THIS_SESSION: AgentsStatus = { text: 'this session', glyph: '', color: STYLE.muted, dim: true }

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
  /** TaskStop's `task_id` (stopIdOf: a teammate's bare name, else its id), while it's this session's and running or waiting. */
  stopId: string | null
}

export type InboxFacts = { entries: InboxEntry[] | null; stamp: string; error: string | null }

export type AgentsFacts = {
  /** The team shown, or null (this session, or a team that's gone). */
  team: TeamRecord | null
  /** This session leads the team shown. */
  led: boolean
  teams: TeamRecord[]
  /** The teams' folder was read: a team missing from `teams` is gone, not unknown. */
  teamsRead: boolean
  /** By team name: whether it runs (teamActive); null when the registry can't be read. */
  activity: Record<string, boolean | null>
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

/**
 * TaskStop's `task_id` for one of this session's agents (decision 6; WP-CH):
 * a teammate's bare name, its `teammateId` before the `@`, which TaskStop
 * matches in 2.1.289 and 2.1.290 alike (2.1.290 gives a teammate one id and
 * no longer matches `<name>@<team>`); any other agent's id, and a teammate's
 * whose `teammateId` isn't an address.
 */
const stopIdOf = (a: ListedAgent): string => addressOf(a.teammateId)?.name ?? a.id

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
      stopId: stoppable(a) ? stopIdOf(a) : null,
    })
  }
  return rows
}

/**
 * Whether a team runs (WP-DF §0): this session lists one of its members, or
 * leads it, or its lead session is in the engine's registry of running
 * sessions. Null when the registry couldn't be read: nobody can tell. Pure.
 */
export function teamActive(team: TeamInfo, sessionId: string, listed: readonly ListedAgent[], sessions: readonly RunningSession[] | null): boolean | null {
  if (listed.some(a => addressOf(a.teammateId)?.team === team.name)) return true
  if (team.leadSessionId !== null && team.leadSessionId !== '' && team.leadSessionId === sessionId) return true
  if (sessions === null) return null
  return team.leadSessionId !== null && sessions.some(s => s.sessionId === team.leadSessionId)
}

/**
 * A team's members, in its config's order. A member this session lists (a
 * teammate of the team it leads) is its agent: its status, its transcript,
 * a send through the engine and [Stop]. Any other member of a team this
 * session leads is sent to by name; of another team, by the locked append to
 * its inbox (decision 5). The lead member of a team this session leads is
 * this session. A team that ended (WP-DF §0): its members are `ended`, and
 * nothing sends to them, since a message would be read by nobody.
 */
function teamRows(team: TeamInfo, listed: readonly ListedAgent[], led: boolean, ended = false): RowFacts[] {
  const seen = new Set<string>()
  const rows: RowFacts[] = []
  for (const m of team.members) {
    if (typeof m.name !== 'string' || m.name === '' || seen.has(m.name)) continue
    seen.add(m.name)
    const a = listed.find(x => typeof x.teammateId === 'string' && (x.teammateId === m.agentId || x.teammateId === `${m.name}@${team.name}`)) ?? null
    const self = !a && led && m.name === LEAD_MEMBER
    const via: SendVia | null = a
      ? { kind: 'agent', agentId: a.id }
      : self || ended
        ? null
        : led
          ? { kind: 'name', name: m.name }
          : { kind: 'inbox', team: team.name, agent: m.name }
    rows.push({
      key: m.name,
      name: oneLine(m.name, 40),
      type: oneLine(m.agentType ?? '', 40),
      status: a ? statusOf(a.status) : self ? { ...THIS_SESSION } : ended ? { ...ENDED } : { ...NOT_HERE },
      listed: a,
      inbox: { team: team.name, agent: m.name },
      via,
      stopId: a && stoppable(a) ? stopIdOf(a) : null,
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
  let teamList: TeamRecord[] = []
  let teamsRead = true
  try {
    teamList = await deps.teams(p)
  } catch (err) {
    teamsRead = false
    problems.push(`the teams couldn't be read: ${oneLine(errText(err), 200)}`)
  }
  // The registry is read only, and only shown (WP-DF §0): a failure is "can't tell", never a problem line.
  const sessions = await deps.sessions(p).catch(() => null)
  const activity: Record<string, boolean | null> = {}
  for (const t of teamList) activity[t.name] = teamActive(t, sessionId, listed, sessions)
  const team = nav.team === null ? null : (teamList.find(t => t.name === nav.team) ?? null)
  if (nav.team !== null && !team) problems.push(`there's no team named ${oneLine(nav.team, 60)} with a readable config`)
  const led =
    team !== null &&
    ((team.leadSessionId !== null && team.leadSessionId !== '' && team.leadSessionId === sessionId) || listed.some(a => addressOf(a.teammateId)?.team === team.name))
  const rows = nav.team === null ? sessionRows(listed, teamList) : team ? teamRows(team, listed, led, activity[team.name] === false) : []

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
  return { team, led, teams: teamList, teamsRead, activity, rows, inboxes, messages, problems }
}

/** The team is known to have ended (WP-DF §0): the teams were read and it isn't among them, or it isn't running. */
export const teamEnded = (f: AgentsFacts, team: string | null): boolean => team !== null && f.teamsRead && (!f.teams.some(t => t.name === team) || f.activity[team] === false)

/**
 * What the tick compares (decision 16): the rows' ids and statuses, each
 * inbox's stamp (CE's: the file's size and mtime) and count, the teams and
 * whether each runs, the selected agent's message count, and what couldn't
 * be read.
 */
export function factsStamp(f: AgentsFacts): string {
  return JSON.stringify([
    f.rows.map(r => [r.key, r.status.text, r.name, r.type, r.via?.kind ?? '', r.stopId ?? '', f.inboxes[r.key]?.stamp ?? '', f.inboxes[r.key]?.entries?.length ?? -1]),
    f.teams.map(t => [t.name, t.mtimeMs, t.members.length, f.activity[t.name] ?? null]),
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

/** A tool call's first argument, one line, and whether it's a path (Read's, Edit's, Write's `file_path`, and the like). */
function firstArg(input: unknown): { text: string; path: boolean } {
  if (input === null || typeof input !== 'object') return { text: '', path: false }
  const first = Object.entries(input as Record<string, unknown>)[0]
  if (first === undefined) return { text: '', path: false }
  const [key, v] = first
  return { text: oneLine(typeof v === 'string' ? v : (JSON.stringify(v) ?? ''), 80), path: typeof v === 'string' && PATH_ARGS.has(key) }
}

/** The arguments that name a file, drawn in the path color. */
const PATH_ARGS = new Set(['file_path', 'notebook_path', 'path'])

// ---------------------------------------------------------------------------
// A transcript's lines: the engine's wrapped messages as plain words (WP-DF)

/**
 * The tags the engine wraps a delivered message in that name who sent it, and
 * the attribute (first present wins) that holds the sender, from 2.1.291's
 * writers: `teammate-message` (`A6t`, :369634: teammate_id, color, summary,
 * verified), `agent-message` (`dhe`, :108806: from), `cross-session-message`
 * (`urt`, :68179: from, from-session, hop-chain, from-name, from-mode,
 * from-plugin) and `channel` (`_dt`, :994317: source and meta keys). Each
 * writes `<tag …>\n<text>\n</tag>`, attributes escaped `&quot;` and `&apos;`
 * (`Ss`, :65888).
 */
const FROM_TAGS: Record<string, readonly string[]> = {
  'teammate-message': ['teammate_id'],
  'agent-message': ['from'],
  'cross-session-message': ['from-name', 'from'],
  channel: ['source'],
}

/**
 * The engine's other wrappers (its list `yne`, :17860, with the tag names at
 * :17797-17857), each read as a word before its text. One not here is
 * still shown, its markup taken out.
 */
const TAG_WORD: Record<string, string> = {
  'task-notification': 'task',
  'system-reminder': 'system reminder',
  system_reminder: 'system reminder',
  'command-name': 'command',
  'local-command-stdout': 'command output',
  'local-command-stderr': 'command error',
  'local-command-caveat': 'note',
  'bash-input': 'shell',
  'bash-stdout': 'shell output',
  'bash-stderr': 'shell error',
  'bash-exit-code': 'shell exit code',
  'user-prompt-submit-hook': 'hook',
  'fetched-web-content': 'web content',
  'coordinator-relay': 'relayed',
  'slack-ping': 'slack',
  'slack-tag-message': 'slack',
  'remote-review': 'remote review',
  'remote-review-progress': 'remote review',
  tick: 'tick',
}

/** One top-level block of a message: its tag, attributes and inner text (to its close, or to the end of a cut message); or text outside any tag. */
type Block = { tag: string | null; attrs: Record<string, string>; inner: string }

const OPEN_TAG = /^<([A-Za-z][\w-]*)((?:\s+[\w-]+="[^"]*")*)\s*(\/?)>/
const ATTR = /([\w-]+)="([^"]*)"/g
const unescapeAttr = (v: string): string => v.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')

/** A message's text as blocks: each leading `<tag …>…</tag>` in turn, then whatever text is left. A tag never closed runs to the end. */
function blocksOf(text: string): Block[] {
  const out: Block[] = []
  let rest = text.trim()
  for (let i = 0; i < 20 && rest !== ''; i++) {
    const m = OPEN_TAG.exec(rest)
    if (!m) {
      out.push({ tag: null, attrs: {}, inner: rest })
      break
    }
    const tag = m[1]!
    const attrs: Record<string, string> = {}
    for (const a of m[2]!.matchAll(ATTR)) attrs[a[1]!] = unescapeAttr(a[2]!)
    const after = rest.slice(m[0].length)
    if (m[3] === '/') {
      out.push({ tag, attrs, inner: '' })
      rest = after.trim()
      continue
    }
    const close = after.indexOf(`</${tag}>`)
    out.push({ tag, attrs, inner: close < 0 ? after : after.slice(0, close) })
    rest = close < 0 ? '' : after.slice(close + tag.length + 3).trim()
  }
  return out
}

/** Text with every tag taken out (the engine's escaped close, `<\/tag>`, too), its line breaks kept and the spaces left closed up. */
const untagged = (text: string): string => text.replace(/<\\?\/?[A-Za-z][\w-]*(?:\s+[\w-]+="[^"]*")*\s*\/?>/g, ' ').replace(/[ \t]{2,}/g, ' ')

/** A line's first non-empty line, one line, cut. */
const firstOf = (text: string, max: number): string => oneLine(text.split('\n').find(l => l.trim() !== '') ?? '', max)

/** A tagged block as the words drawn: who sent it (the name apart, for its color) and what it says. */
function blockWords(b: Block): { from: string | null; text: string } {
  if (b.tag === null) return { from: null, text: firstOf(b.inner, 200) }
  const from = FROM_TAGS[b.tag]
  if (from) {
    const who = from.map(k => b.attrs[k]).find(v => v !== undefined && v.trim() !== '') ?? null
    const text = firstOf(untagged(b.inner), 200)
    return { from: who === null ? null : oneLine(who, 40), text: who === null ? `${b.tag}: ${text}` : text }
  }
  if (b.tag === 'task-notification') {
    // `<task-notification>` holds `<task-id>`, `<status>`, `<summary>` and the rest (`Zi`, :384075).
    const inner = blocksOf(b.inner.trim())
    const pick = (t: string) => inner.find(x => x.tag === t)?.inner.trim() ?? ''
    const status = oneLine(pick('status'), 24)
    const summary = firstOf(untagged(pick('summary')), 160) || firstOf(untagged(b.inner), 160)
    return { from: null, text: `task${status ? ` ${status}` : ''}${summary ? `: ${summary}` : ''}` }
  }
  const word = TAG_WORD[b.tag] ?? b.tag
  const text = firstOf(untagged(b.inner), 200)
  return { from: null, text: text === '' ? word : `${word}: ${text}` }
}

/**
 * A user message's words: its first block that says something, past a
 * system reminder (the reminder itself when it's all there is), and how many
 * more say something. `<command-name>` and its `<command-args>` read as the
 * command typed. Pure.
 */
function userWords(text: string): { from: string | null; text: string; more: number } | null {
  const blocks = blocksOf(text).filter(b => b.tag !== null || b.inner.trim() !== '')
  if (blocks.length === 0) return null
  const command = blocks.find(b => b.tag === 'command-name')
  if (command) {
    const args = oneLine(untagged(blocks.find(b => b.tag === 'command-args')?.inner ?? ''), 160)
    return { from: null, text: `${oneLine(untagged(command.inner), 60)}${args ? ` ${args}` : ''}`, more: 0 }
  }
  const said = blocks.filter(b => b.tag !== 'system-reminder' && b.tag !== 'system_reminder')
  const pool = [said, blocks].map(bs => bs.filter(b => untagged(b.inner).trim() !== '')).find(bs => bs.length > 0) ?? (said.length > 0 ? said : blocks)
  return { ...blockWords(pool[0]!), more: pool.length - 1 }
}

/**
 * One message as one line of spans: an assistant's text `◆`, a user's `›`
 * muted, the engine's wrapped messages in words (`from lead: …`, the name in
 * the name color), else its first tool and that tool's first argument: `↳`
 * faint, the tool's name bold in the label color (as the engine draws one),
 * the argument muted (a file's path in the path color), `(+n more)` faint
 * (the user's ask, 2026-10-07; WP-DD's Swarms browser draws it the same).
 * Nothing for a row with neither. Markup it doesn't know is shown with the
 * tags taken out, never dropped. Text is cleaned and cut.
 */
export function messageLine(m: SessionMessage): SwarmSpan[] | null {
  const text = clean(m?.text, 8000)
  if (text.trim() !== '') {
    if (m.role === 'assistant') return [{ text: `◆ ${firstOf(text, 200)}` }]
    const w = userWords(text)
    if (w && w.text !== '') {
      const more = w.more > 0 ? ` (+${w.more} more)` : ''
      if (w.from !== null) return [{ text: '› from ', color: STYLE.muted }, { text: w.from, color: STYLE.name }, { text: `: ${w.text}${more}`, color: STYLE.muted }]
      return [{ text: `› ${w.text}${more}`, color: STYLE.muted }]
    }
  }
  const uses = Array.isArray(m?.toolUses) ? m.toolUses : []
  const t = uses[0] as { tool?: unknown; name?: unknown; input?: unknown } | undefined
  if (!t) return null
  const arg = firstArg(t.input)
  const spans: SwarmSpan[] = [
    { text: '↳ ', color: STYLE.faint },
    { text: oneLine(t.tool ?? t.name ?? 'tool', 40) || 'tool', bold: true, color: STYLE.label },
  ]
  if (arg.text !== '') spans.push({ text: ` ${arg.text}`, color: arg.path ? STYLE.path : STYLE.muted })
  if (uses.length > 1) spans.push({ text: ` (+${uses.length - 1} more)`, color: STYLE.faint })
  return spans
}

/** A line's text, its spans joined. */
export const lineText = (spans: readonly SwarmSpan[]): string => spans.map(s => s.text).join('')

/** The transcript as the view keeps it: its messages that read as a line, the last LINES_KEPT of them, and how many there are. */
export function tailOf(messages: readonly SessionMessage[] | null | undefined): NonNullable<AgentsSelected['transcript']> {
  if (!Array.isArray(messages)) return { readable: false, lines: [], total: 0 }
  const lines = messages.map(messageLine).filter((l): l is SwarmSpan[] => l !== null)
  return { readable: true, lines: lines.slice(-LINES_KEPT), total: lines.length }
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
    transcript: r.listed ? tailOf(f.messages) : null,
    sendNote: sendNote(r.via),
    stop: r.stopId ? { armed: nav.armed?.arg === arg && armedLive(nav, now) } : null,
  }
}

/** A moment in ms as whenOf draws it. */
const whenAt = (ms: number, now: number): string => whenOf(new Date(ms).toISOString(), now)

/** A team's description in the picker: where its lead runs (or ran), when it was made, its members. */
function teamDescription(t: TeamRecord, now: number): string {
  const names = t.members.map(m => oneLine(m.name, 30))
  const members = names.length === 0 ? 'no members' : `${names.slice(0, 6).join(', ')}${names.length > 6 ? ` +${names.length - 6} more` : ''}`
  return [t.leadCwd ? `lead in ${oneLine(t.leadCwd, 80)}` : null, t.createdAt !== undefined ? `made ${whenAt(t.createdAt, now)}` : null, members].filter(Boolean).join(' · ')
}

/**
 * The picker (WP-DF §0): this session first, then each team, newest first,
 * that runs, or can't be told to have ended, or is the one shown or named;
 * with [Show all] every team. Answers how many ended teams were left out.
 */
function pickerOf(f: AgentsFacts, nav: AgentsNav, now: number): { options: AgentsOption[]; hidden: number } {
  const mine = nav.team === null ? plural(f.rows.length, 'agent') : "the agents this session started, and its teammates"
  const options: AgentsOption[] = [{ value: SESSION_SCOPE, label: 'this session', members: null, active: true, description: mine }]
  let hidden = 0
  for (const t of f.teams) {
    const active = f.activity[t.name] ?? null
    if (!nav.showAll && active === false && t.name !== nav.team && t.name !== nav.named) {
      hidden++
      continue
    }
    if (options.length > MAX_TEAMS) continue
    options.push({ value: scopeOf(t.name), label: oneLine(t.name, 40), members: t.members.length, active, description: teamDescription(t, now) })
  }
  return { options, hidden }
}

/** The notice for a team shown that isn't running (WP-DF §0): its lead's folder and when it started, from its config, and why nothing sends. */
export function endedText(t: TeamRecord, now: number): string {
  const where = [t.leadCwd ? oneLine(t.leadCwd, 80) : null, t.createdAt !== undefined ? `started ${whenAt(t.createdAt, now)}` : null].filter(Boolean).join(', ')
  return `${oneLine(t.name, 60)} isn't running: its lead session${where ? ` (${where})` : ''} ended. Its inboxes stay readable; nothing here sends to it, since a message would be read by nobody.`
}

/** The body's first line: what's shown, and its counts. */
function headOf(f: AgentsFacts, nav: AgentsNav): AgentsBody['head'] {
  if (nav.team === null) {
    const running = f.rows.filter(r => r.listed?.status === 'running').length
    return { team: null, note: `${plural(f.rows.length, 'agent')}${running > 0 ? ` · ${running} running` : ''}` }
  }
  const team = oneLine(nav.team, 40)
  if (!f.team) return { team, note: 'not found' }
  const state = f.led ? ' · led by this session' : f.activity[f.team.name] === false ? ' · ended' : ''
  return { team, note: `${plural(f.rows.length, 'member')}${state}` }
}

/** A row's description: the selected agent's last line, else its task's own words when the row isn't named by them. */
function rowDescription(f: AgentsFacts, r: RowFacts, selected: boolean): string {
  if (selected && Array.isArray(f.messages)) {
    const last = tailOf(f.messages).lines.at(-1)
    if (last) return oneLine(lineText(last), 200)
  }
  const said = r.listed ? oneLine(r.listed.description, 200) : ''
  return said !== '' && said !== r.name ? said : ''
}

/** The view, from what gather() read and the navigation: a pure function, `v` the writer's. */
export function agentsView(f: AgentsFacts, nav: AgentsNav, now: number, v: number): AgentsPaneView {
  const shown = f.rows.slice(0, MAX_ROWS)
  const rows: AgentsRow[] = shown.map(r => ({
    key: r.key,
    name: r.name,
    type: r.type,
    status: r.status,
    unread: unreadOf(f, r),
    description: rowDescription(f, r, r.key === nav.selected),
    can: { message: r.via !== null, transcript: r.listed !== null, stop: r.stopId !== null },
  }))
  const sel = f.rows.find(r => r.key === nav.selected) ?? null
  const to = sel?.via ? sel.name : null
  const ended = nav.team !== null && f.team !== null && f.activity[f.team.name] === false
  const broadcast = nav.team !== null && f.team && !ended ? oneLine(f.team.name, 40) : null
  const picker = pickerOf(f, nav, now)
  return {
    view: 'agents',
    v,
    body: {
      head: headOf(f, nav),
      notice: nav.notice,
      ended: ended && f.team ? endedText(f.team, now) : null,
      scope: scopeOf(nav.team),
      options: picker.options,
      hiddenTeams: picker.hidden,
      showAll: nav.showAll,
      picking: nav.picking,
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
