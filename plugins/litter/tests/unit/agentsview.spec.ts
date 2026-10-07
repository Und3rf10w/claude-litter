// Tier 2: the agents pane's view (WP-CG; COMMON decisions 5, 6, 16), built by
// hooks/agents/view.ts from a listAgents fake and CE's store through `deps`
// (its body is CA's stub before the merge): every status word and an
// unknown one; a team's members with their inbox counts; a teammate of this
// session's team with both a status and a count; the selected agent's inbox
// and transcript tail, [More]; a message cleaned and cut; the stamp the tick
// compares; and what couldn't be read. WP-DF: the first line in place of a
// title; only teams that run (the registry through `deps.sessions`), the
// ended ones counted, an ended team shown on purpose; and the engine's
// wrapped messages as words, on each tag, unknown markup and a cut message.

import { afterEach, describe, expect, test } from 'bun:test'
import type { ListedAgent, SessionMessage } from '../../hooks/ports'
import type { InboxEntry, TeamInfo } from '../../hooks/uitypes'
import type { AgentsBody } from '../../types/index'
import { clockAt } from '../../hooks/swarm/view'
import type { RunningSession, TeamRecord } from '../../hooks/team/store'
import {
  ENDED,
  INBOX_SHOWN,
  MAX_ROWS,
  NOT_HERE,
  LINES_KEPT,
  blankAgentsNav,
  buildAgents,
  deps,
  endedText,
  entryOf,
  factsStamp,
  gather,
  lineText,
  messageLine,
  parseRowArg,
  rowArg,
  scopeOf,
  statusOf,
  teamActive,
  teamEnded,
  teamOfScope,
  type AgentsNav,
} from '../../hooks/agents/view'
import { nodePorts, type TestPorts } from './support/node-ports'

const SESSION = 'test-session'
const NOW = Date.parse('2026-10-05T15:00:00Z')
const saved = { ...deps }

afterEach(() => {
  Object.assign(deps, saved)
})

const agent = (id: string, over: Partial<ListedAgent> = {}): ListedAgent => ({ id, description: `task ${id}`, type: 'general-purpose', status: 'running', ...over })

function team(name: string, members: readonly string[], over: Partial<TeamRecord> = {}): TeamRecord {
  return {
    name,
    dir: name,
    leadSessionId: 'another-session',
    members: members.map(m => ({ name: m, agentId: `${m}@${name}`, agentType: m === 'team-lead' ? 'team-lead' : 'general-purpose', color: null })),
    mtimeMs: 1,
    ...over,
  }
}

const entry = (text: string, over: Partial<InboxEntry> = {}): InboxEntry => ({ from: 'team-lead', text, timestamp: new Date(NOW - 60_000).toISOString(), summary: null, ...over })

/**
 * CE's store as a spec sets it: the teams, and each inbox by `<team>/<agent>`
 * (null: none; an Error: unreadable); the registry of running sessions
 * (undefined: the real reader, which can't tell in tier 2, so null).
 */
type Store = { teams: TeamRecord[] | Error; inboxes: Record<string, InboxEntry[] | null | Error>; stamps: Record<string, string>; reads: string[]; sessions?: RunningSession[] | null }

function fakeStore(over: Partial<Store> = {}): Store {
  const s: Store = { teams: [], inboxes: {}, stamps: {}, reads: [], ...over }
  deps.teams = async () => {
    if (s.teams instanceof Error) throw s.teams
    return structuredClone(s.teams)
  }
  if ('sessions' in over) deps.sessions = async () => structuredClone(s.sessions ?? null)
  deps.readInbox = async (_p, t, a) => {
    const k = `${t}/${a}`
    s.reads.push(k)
    const got = s.inboxes[k]
    if (got instanceof Error) throw got
    if (got === null) return null
    const entries = got ?? []
    return { entries: structuredClone(entries), stamp: s.stamps[k] ?? `size ${JSON.stringify(entries).length}` }
  }
  deps.appendInbox = async () => ({ ok: false, error: 'not in this spec' })
  return s
}

function ports(agents: ListedAgent[] = []): TestPorts {
  const p = nodePorts({ sessionId: SESSION })
  p.clock.now = NOW
  p.agents = agents
  return p
}

const nav = (over: Partial<AgentsNav> = {}): AgentsNav => ({ ...blankAgentsNav(null), ...over })

async function body(p: TestPorts, n: AgentsNav): Promise<AgentsBody> {
  const { view } = await buildAgents(p, n)
  expect(view.view).toBe('agents')
  return view.body!
}

const say = (text: string, role: 'user' | 'assistant' = 'assistant'): SessionMessage => ({ role, text, toolUses: [] })
const toolCall = (tool: string, input: Record<string, unknown>, more = 0): SessionMessage => ({
  role: 'assistant',
  text: '',
  toolUses: [{ tool_use_id: 't1', tool, input }, ...Array.from({ length: more }, (_, i) => ({ tool_use_id: `t${i + 2}`, tool: 'Read', input: { file_path: '/x' } }))],
})
/** A tool result's row: no text, no tool use. */
const result = (): SessionMessage => ({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: 'ok' } as never] })

describe("this session's agents", () => {
  test('every status word of 2.1.289 as glyph and word in its theme key, and any other word as itself', async () => {
    fakeStore()
    const p = ports([
      agent('a1', { status: 'running', name: 'reviewer' }),
      agent('a2', { status: 'waiting' }),
      agent('a3', { status: 'idle' }),
      agent('a4', { status: 'completed' }),
      agent('a5', { status: 'failed' }),
      agent('a6', { status: 'killed' }),
      agent('a7', { status: 'pending' }),
      agent('a8', { status: 'dozing' as never }),
    ])
    const b = await body(p, nav())
    expect(b.rows.map(r => [r.key, r.status.glyph, r.status.text, r.status.color])).toEqual([
      ['a1', '▸', 'running', 'background'],
      ['a2', '·', 'waiting', 'background'],
      ['a3', '·', 'idle', 'inactive'],
      ['a4', '✓', 'completed', 'success'],
      ['a5', '✕', 'failed', 'error'],
      ['a6', '−', 'stopped', 'inactive'],
      ['a7', '', 'pending', 'inactive'],
      ['a8', '', 'dozing', 'inactive'],
    ])
    // Its name, else its description; its type beside it.
    expect(b.rows.map(r => r.name).slice(0, 2)).toEqual(['reviewer', 'task a2'])
    expect(b.rows[0]!.type).toBe('general-purpose')
    // A plain subagent has no inbox, so no count.
    expect(b.rows.every(r => r.unread === null)).toBe(true)
    expect(b.scope).toBe('session')
    // No title line: the first line is what's shown, and its counts (WP-DF).
    expect(b.head).toEqual({ team: null, note: '8 agents · 1 running' })
    expect(b.broadcast).toBeNull()
    expect(b.problems).toEqual([])
    // Nothing selected: no composer.
    expect(b.selected).toBeNull()
    expect(b.composer).toBeNull()
  })

  test('a name or a type is cleaned and cut: no terminal sequence, no control character, at most 40 characters', async () => {
    fakeStore()
    const p = ports([agent('a1', { name: '\u001b[31mred\u001b[0m\u0007 one', type: `t${'y'.repeat(80)}` }), agent('a2', { description: '', type: 'Explore' })])
    const b = await body(p, nav())
    expect(b.rows[0]!.name).toBe('red one')
    expect(b.rows[0]!.type.length).toBe(40)
    expect(b.rows[0]!.type.endsWith('…')).toBe(true)
    // No name and no description: its type.
    expect(b.rows[1]!.name).toBe('Explore')
  })

  test('a teammate of the team this session leads gets both its status and its unread count', async () => {
    const s = fakeStore({
      teams: [team('team-a', ['team-lead', 'reviewer', 'fixer'], { leadSessionId: SESSION })],
      inboxes: { 'team-a/reviewer': [entry('look at G2'), entry('and G3')], 'team-a/fixer': [] },
    })
    const p = ports([
      agent('a1', { teammateId: 'reviewer@team-a', name: 'reviewer', type: 'teammate', status: 'idle' }),
      agent('a2', { teammateId: 'fixer@team-a', name: 'fixer', type: 'teammate', status: 'running' }),
      agent('a3', { status: 'running' }),
    ])
    const b = await body(p, nav())
    expect(b.rows.map(r => [r.name, r.status.text, r.unread])).toEqual([
      ['reviewer', 'idle', 2],
      ['fixer', 'running', 0],
      ['task a3', 'running', null],
    ])
    expect(s.reads.sort()).toEqual(['team-a/fixer', 'team-a/reviewer'])
  })

  test("TaskStop's task_id: a subagent's id, a teammate's bare name (2.1.290 no longer matches name@team), none unless running or waiting", async () => {
    fakeStore({ teams: [team('team-a', ['team-lead', 'reviewer'], { leadSessionId: SESSION })] })
    const p = ports([
      agent('a1', { status: 'running' }),
      agent('a2', { status: 'waiting', teammateId: 'reviewer@team-a', name: 'reviewer', type: 'teammate' }),
      // A name with an `@` of its own: split at the last one, as addressOf reads an address.
      agent('a3', { status: 'running', teammateId: 'ops@east@team-b', name: 'ops@east' }),
      // A teammateId that isn't `<name>@<team>`: its id.
      agent('a4', { status: 'running', teammateId: 'loner' }),
      agent('a5', { status: 'idle', teammateId: 'fixer@team-a', name: 'fixer' }),
      agent('a6', { status: 'completed' }),
    ])
    const f = await gather(p, nav())
    expect(f.rows.map(r => [r.key, r.stopId])).toEqual([
      ['a1', 'a1'],
      ['a2', 'reviewer'],
      ['a3', 'ops@east'],
      ['a4', 'a4'],
      ['a5', null],
      ['a6', null],
    ])
    // The team's view of the same teammate stops it the same way.
    const t = await gather(p, nav({ team: 'team-a' }))
    expect(t.rows.map(r => [r.key, r.stopId])).toEqual([
      ['team-lead', null],
      ['reviewer', 'reviewer'],
    ])
  })

  test("a teammate whose team has no config reads no inbox; a team's unreadable inbox is a problem, not a count", async () => {
    const s = fakeStore({ teams: [team('team-a', ['team-lead', 'reviewer'])], inboxes: { 'team-a/reviewer': new Error('EACCES: permission denied') } })
    const p = ports([agent('a1', { teammateId: 'reviewer@team-a', name: 'reviewer' }), agent('a2', { teammateId: 'ghost@gone', name: 'ghost' })])
    const b = await body(p, nav())
    expect(b.rows.map(r => r.unread)).toEqual([null, null])
    expect(s.reads).toEqual(['team-a/reviewer'])
    expect(b.problems).toEqual(["reviewer's inbox couldn't be read: EACCES: permission denied"])
  })

  test("an agent list that throws, or teams that can't be read, are problem lines; the view still builds", async () => {
    fakeStore({ teams: new Error('neither CLAUDE_CONFIG_DIR nor an absolute HOME is set') })
    const p = ports()
    p.listAgents = async () => {
      throw new Error('the session is not bound')
    }
    const b = await body(p, nav())
    expect(b.rows).toEqual([])
    expect(b.problems).toEqual([
      "this session's agents couldn't be listed: the session is not bound",
      "the teams couldn't be read: neither CLAUDE_CONFIG_DIR nor an absolute HOME is set",
    ])
    expect(b.options).toEqual([{ value: 'session', label: 'this session', members: null, active: true, description: '0 agents' }])
  })

  test(`past ${MAX_ROWS} rows the rest are counted, not drawn, and their inboxes aren't read`, async () => {
    const names = Array.from({ length: MAX_ROWS + 5 }, (_, i) => `m${i}`)
    const s = fakeStore({ teams: [team('big', names)] })
    const p = ports()
    const b = await body(p, nav({ team: 'big' }))
    expect(b.rows.length).toBe(MAX_ROWS)
    expect(b.hiddenRows).toBe(5)
    expect(s.reads.length).toBe(MAX_ROWS)
  })
})

describe("a team's members", () => {
  test("each member with its type and ✉ count; its status is `not in this session`, since $.agent.list() knows only this session's", async () => {
    fakeStore({
      teams: [team('team-b', ['team-lead', 'writer', 'checker']), team('team-a', ['team-lead'])],
      inboxes: { 'team-b/team-lead': [entry('done')], 'team-b/writer': [entry('a'), entry('b'), entry('c')], 'team-b/checker': null },
    })
    const p = ports([agent('a1')])
    const b = await body(p, nav({ team: 'team-b' }))
    expect(b.rows.map(r => [r.key, r.name, r.type, r.status, r.unread])).toEqual([
      ['team-lead', 'team-lead', 'team-lead', NOT_HERE, 1],
      ['writer', 'writer', 'general-purpose', NOT_HERE, 3],
      // No inbox file yet: nothing pending.
      ['checker', 'checker', 'general-purpose', NOT_HERE, 0],
    ])
    expect(b.scope).toBe('team.team-b')
    expect(b.head).toEqual({ team: 'team-b', note: '3 members' })
    // A team's view keeps the composer for [Broadcast], with no row to [Send] to yet.
    expect(b.broadcast).toBe('team-b')
    expect(b.composer).toEqual({ key: 'agents:text:0', text: '', to: null })
    // The picker: this session first, then each team as the store answers them (newest first), with its
    // member count; whether it runs is null, since tier 2 has no registry to read (no config dir).
    expect(b.options).toEqual([
      { value: 'session', label: 'this session', members: null, active: true, description: 'the agents this session started, and its teammates' },
      { value: 'team.team-b', label: 'team-b', members: 3, active: null, description: 'team-lead, writer, checker' },
      { value: 'team.team-a', label: 'team-a', members: 1, active: null, description: 'team-lead' },
    ])
    expect(b.hiddenTeams).toBe(0)
    expect(b.ended).toBeNull()
  })

  test("a member of the team this session leads that it lists is its agent; the lead member is this session; an unlisted member is sent to by name", async () => {
    fakeStore({ teams: [team('team-a', ['team-lead', 'reviewer', 'idler'], { leadSessionId: SESSION })], inboxes: { 'team-a/reviewer': [entry('x')] } })
    const p = ports([agent('a1', { teammateId: 'reviewer@team-a', name: 'reviewer', status: 'running' })])
    const n = nav({ team: 'team-a' })
    const f = await gather(p, n)
    expect(f.led).toBe(true)
    expect(f.rows.map(r => [r.key, r.status.text, r.via, r.stopId])).toEqual([
      ['team-lead', 'this session', null, null],
      ['reviewer', 'running', { kind: 'agent', agentId: 'a1' }, 'reviewer'],
      ['idler', 'not in this session', { kind: 'name', name: 'idler' }, null],
    ])
    const b = await body(p, n)
    expect(b.head).toEqual({ team: 'team-a', note: '3 members · led by this session' })
    // What the menu offers each row: Message where something sends, Transcript for this session's agent, Stop while it runs.
    expect(b.rows.map(r => [r.key, r.can])).toEqual([
      ['team-lead', { message: false, transcript: false, stop: false }],
      ['reviewer', { message: true, transcript: true, stop: true }],
      ['idler', { message: true, transcript: false, stop: false }],
    ])
    // The lead member, selected: nothing sends to it, nothing stops it.
    const lead = (await body(p, nav({ team: 'team-a', selected: 'team-lead' }))).selected!
    expect(lead.sendNote).toBeNull()
    expect(lead.stop).toBeNull()
  })

  test("another team's member is sent to by its inbox, and has no stop and no transcript", async () => {
    fakeStore({ teams: [team('team-b', ['team-lead', 'writer'])], inboxes: { 'team-b/writer': [] } })
    const p = ports()
    const n = nav({ team: 'team-b', selected: 'writer' })
    const f = await gather(p, n)
    expect(f.led).toBe(false)
    expect(f.rows.find(r => r.key === 'writer')?.via).toEqual({ kind: 'inbox', team: 'team-b', agent: 'writer' })
    const b = await body(p, n)
    expect(b.selected).toEqual({
      key: 'writer',
      name: 'writer',
      inbox: { entries: [], hidden: 0, error: null },
      transcript: null,
      sendNote: 'appended to its inbox in team team-b: it reads it at its next turn',
      stop: null,
    })
    expect(b.composer).toEqual({ key: 'agents:text:0', text: '', to: 'writer' })
  })

  test('a team named that has no readable config: a problem line and no rows', async () => {
    fakeStore({ teams: [team('team-a', ['team-lead'])] })
    const b = await body(ports(), nav({ team: 'gone' }))
    expect(b.rows).toEqual([])
    expect(b.problems).toEqual(["there's no team named gone with a readable config"])
    expect(b.broadcast).toBeNull()
    expect(b.head).toEqual({ team: 'gone', note: 'not found' })
  })
})

describe('the selected agent', () => {
  test('its pending entries, oldest first, each from · time · text, the newest 20 when there are more', async () => {
    const many = Array.from({ length: INBOX_SHOWN + 3 }, (_, i) => entry(`message ${i}`, { from: i % 2 ? 'fixer' : 'team-lead' }))
    fakeStore({ teams: [team('team-a', ['team-lead', 'reviewer'])], inboxes: { 'team-a/reviewer': many } })
    const b = await body(ports(), nav({ team: 'team-a', selected: 'reviewer' }))
    const inbox = b.selected!.inbox!
    expect(inbox.hidden).toBe(3)
    expect(inbox.entries.length).toBe(INBOX_SHOWN)
    expect(inbox.entries[0]).toEqual({ from: 'fixer', at: clockAt(NOW - 60_000), lines: ['message 3'] })
    expect(inbox.entries.at(-1)!.lines).toEqual([`message ${INBOX_SHOWN + 2}`])
  })

  test('an empty inbox is `nothing pending` data (no entries, no error); an unreadable one carries its error', async () => {
    fakeStore({ teams: [team('team-a', ['team-lead', 'reviewer', 'fixer'])], inboxes: { 'team-a/reviewer': [], 'team-a/fixer': new Error('not JSON') } })
    const p = ports()
    expect((await body(p, nav({ team: 'team-a', selected: 'reviewer' }))).selected!.inbox).toEqual({ entries: [], hidden: 0, error: null })
    expect((await body(p, nav({ team: 'team-a', selected: 'fixer' }))).selected!.inbox).toEqual({ entries: [], hidden: 0, error: 'not JSON' })
  })

  test("a message's text is cleaned (terminal sequences, control characters; markup brackets kept as written) and cut to 3 lines", () => {
    const text = `\u001b[31mred\u001b[0m [bold]not markup[/bold]\u0007 <b>nor this</b>\r\nline two\n\n   line three\nline four\nline five`
    expect(entryOf(entry(text), NOW)).toEqual({
      from: 'team-lead',
      at: clockAt(NOW - 60_000),
      lines: ['red [bold]not markup[/bold] <b>nor this</b>', 'line two', 'line three …'],
    })
    const long = entryOf(entry('x'.repeat(500)), NOW)
    expect(long.lines[0]!.length).toBe(200)
    expect(long.lines[0]!.endsWith('…')).toBe(true)
    // An older one gets its day; a sender or a time that's no string is still drawn.
    expect(entryOf(entry('old', { timestamp: new Date(NOW - 3 * 86_400_000).toISOString() }), NOW).at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(entryOf({ from: 7, text: '', timestamp: 'yesterday', summary: null } as never, NOW)).toEqual({ from: '7', at: 'yesterday', lines: ['(empty)'] })
  })

  test(`its transcript: every message that reads as a line, one each, up to the last ${LINES_KEPT} (the pane windows them)`, async () => {
    fakeStore()
    const p = ports([agent('a1', { name: 'reviewer' })])
    const rows: SessionMessage[] = []
    for (let i = 1; i <= 40; i++) rows.push(say(`step ${i}\nsecond line`), result())
    rows.push(toolCall('Bash', { command: 'npm test', description: 'run the tests' }, 1))
    rows.push(say('[bold]brackets[/bold] \u001b[2Kstay', 'user'))
    p.transcripts = { a1: rows }
    const t = (await body(p, nav({ selected: 'a1' }))).selected!.transcript!
    expect(t.readable).toBe(true)
    expect(t.total).toBe(42)
    expect(t.lines.length).toBe(42)
    expect(t.lines[0]).toEqual([{ text: '◆ step 1' }])
    // Each line its spans: assistant and tool lines keep their glyphs, a user's is muted; a tool's name bold in the label color.
    expect(t.lines.slice(-3)).toEqual([
      [{ text: '◆ step 40' }],
      [
        { text: '↳ ', color: 'subtle' },
        { text: 'Bash', bold: true, color: 'text' },
        { text: ' npm test', color: 'inactive' },
        { text: ' (+1 more)', color: 'subtle' },
      ],
      [{ text: '› [bold]brackets[/bold] stay', color: 'inactive' }],
    ])
    // Past the cap, the newest are kept and the total counts them all.
    p.transcripts = { a1: Array.from({ length: LINES_KEPT + 30 }, (_, i) => say(`line ${i}`)) }
    const long = (await body(p, nav({ selected: 'a1' }))).selected!.transcript!
    expect(long.total).toBe(LINES_KEPT + 30)
    expect(long.lines.length).toBe(LINES_KEPT)
    expect(lineText(long.lines[0]!)).toBe('◆ line 30')
  })

  test("a transcript the engine won't read (another process's teammate, a finished agent) is unreadable, not empty", async () => {
    fakeStore()
    const p = ports([agent('a1')])
    const t = (await body(p, nav({ selected: 'a1' }))).selected!.transcript
    expect(t).toEqual({ readable: false, lines: [], total: 0 })
    p.messages = async () => {
      throw new Error('boom')
    }
    expect((await body(p, nav({ selected: 'a1' }))).selected!.transcript!.readable).toBe(false)
  })

  test('only the selected agent’s transcript is read, never every agent’s (decision 16)', async () => {
    fakeStore()
    const p = ports([agent('a1'), agent('a2'), agent('a3')])
    const asked: (string | undefined)[] = []
    p.messages = async id => {
      asked.push(id)
      return []
    }
    await gather(p, nav())
    expect(asked).toEqual([])
    await gather(p, nav({ selected: 'a2' }))
    expect(asked).toEqual(['a2'])
  })

  test("a tool line (the user's ask, 2026-10-07): ↳ faint, the name bold in the label color, a command muted, a file's path in the path color, (+n more) faint", () => {
    const arrow = { text: '↳ ', color: 'subtle' }
    const name = (n: string) => ({ text: n, bold: true, color: 'text' })
    expect(messageLine(toolCall('Bash', { command: 'cd /Users/me && grep -n x' }))).toEqual([arrow, name('Bash'), { text: ' cd /Users/me && grep -n x', color: 'inactive' }])
    expect(messageLine(toolCall('Read', { file_path: '/work/a.ts' }, 2))).toEqual([arrow, name('Read'), { text: ' /work/a.ts', color: 'suggestion' }, { text: ' (+2 more)', color: 'subtle' }])
    expect(messageLine(toolCall('Edit', { file_path: '/work/b.ts', old_string: 'x' }))![2]).toEqual({ text: ' /work/b.ts', color: 'suggestion' })
    expect(messageLine(toolCall('Write', { file_path: '/work/c.ts' }))![2]!.color).toBe('suggestion')
    // A path argument that isn't a string is muted, as any other.
    expect(messageLine(toolCall('Edit', { file_path: { nested: true } }))).toEqual([arrow, name('Edit'), { text: ' {"nested":true}', color: 'inactive' }])
  })

  test('a message line: a tool with no argument, and a row with neither text nor tool, which reads as nothing', () => {
    expect(messageLine(toolCall('TaskList', {}))).toEqual([
      { text: '↳ ', color: 'subtle' },
      { text: 'TaskList', bold: true, color: 'text' },
    ])
    expect(messageLine(result())).toBeNull()
  })

  test('[Stop] is offered for a running or waiting agent of this session only; armed while a second press would stop it', async () => {
    fakeStore()
    const p = ports([agent('a1', { status: 'running' }), agent('a2', { status: 'waiting' }), agent('a3', { status: 'idle' }), agent('a4', { status: 'completed' })])
    const stopOf = async (selected: string, over: Partial<AgentsNav> = {}) => (await body(p, nav({ selected, ...over }))).selected!.stop
    expect(await stopOf('a1')).toEqual({ armed: false })
    expect(await stopOf('a2')).toEqual({ armed: false })
    expect(await stopOf('a3')).toBeNull()
    expect(await stopOf('a4')).toBeNull()
    const arg = rowArg('session', 'a1')
    expect(await stopOf('a1', { armed: { arg, at: NOW - 4_999 } })).toEqual({ armed: true })
    expect(await stopOf('a1', { armed: { arg, at: NOW - 5_000 } })).toEqual({ armed: false })
    // Armed for another row, it isn't this one's.
    expect(await stopOf('a2', { armed: { arg, at: NOW } })).toEqual({ armed: false })
  })

  test("the composer draws the navigation's field text under its generation's key, and names the row it sends to", async () => {
    fakeStore()
    const p = ports([agent('a1', { name: 'reviewer' })])
    const b = await body(p, nav({ selected: 'a1', text: 'typed since', field: 'restored', gen: 3 }))
    expect(b.composer).toEqual({ key: 'agents:text:3', text: 'restored', to: 'reviewer' })
    expect(b.selected!.sendNote).toBe('sent through the engine: it reads it at its next turn')
  })
})

/** A registry entry as store.ts reads it. */
const running = (sessionId: string, cwd = '/work'): RunningSession => ({ pid: 100, sessionId, cwd, startedAt: NOW - 3_600_000, status: null })

describe('only teams that run (WP-DF §0)', () => {
  test('teamActive: a member this session lists, a team it leads, or its lead in the registry; null when the registry is unread', () => {
    const t = team('team-a', ['team-lead', 'reviewer'], { leadSessionId: 'lead-sid' })
    expect(teamActive(t, SESSION, [agent('a1', { teammateId: 'reviewer@team-a' })], [])).toBe(true)
    expect(teamActive({ ...t, leadSessionId: SESSION }, SESSION, [], [])).toBe(true)
    expect(teamActive(t, SESSION, [], [running('lead-sid')])).toBe(true)
    expect(teamActive(t, SESSION, [], [running('other')])).toBe(false)
    expect(teamActive({ ...t, leadSessionId: null }, SESSION, [], [running('other')])).toBe(false)
    expect(teamActive(t, SESSION, [], null)).toBeNull()
    // Leading it, or listing a member, needs no registry.
    expect(teamActive({ ...t, leadSessionId: SESSION }, SESSION, [], null)).toBe(true)
    expect(teamActive(t, SESSION, [agent('a1', { teammateId: 'reviewer@team-a' })], null)).toBe(true)
  })

  test("the picker: this session, then the teams that run; the ended ones counted and left out, [Show all] lists them; one shown or named stays", async () => {
    fakeStore({
      teams: [
        team('live', ['team-lead'], { leadSessionId: 'sid-live', leadCwd: '/work/live', createdAt: NOW - 600_000 }),
        team('old-1', ['team-lead'], { leadSessionId: 'sid-gone' }),
        team('old-2', ['team-lead', 'x'], { leadSessionId: 'sid-gone-2' }),
        team('mine', ['team-lead'], { leadSessionId: SESSION }),
      ],
      sessions: [running('sid-live')],
    })
    const p = ports()
    const b = await body(p, nav())
    expect(b.options.map(o => [o.value, o.active])).toEqual([
      ['session', true],
      ['team.live', true],
      ['team.mine', true],
    ])
    expect(b.hiddenTeams).toBe(2)
    expect(b.showAll).toBe(false)
    // Its description: where its lead runs, when it was made, its members.
    expect(b.options[1]!.description).toBe(`lead in /work/live · made ${clockAt(NOW - 600_000)} · team-lead`)
    const all = await body(p, nav({ showAll: true }))
    expect(all.options.map(o => [o.value, o.active])).toEqual([
      ['session', true],
      ['team.live', true],
      ['team.old-1', false],
      ['team.old-2', false],
      ['team.mine', true],
    ])
    expect(all.hiddenTeams).toBe(0)
    expect(all.showAll).toBe(true)
    expect((await body(p, nav({ named: 'old-1' }))).options.map(o => o.value)).toEqual(['session', 'team.live', 'team.old-1', 'team.mine'])
    const shown = await body(p, nav({ team: 'old-2' }))
    expect(shown.options.map(o => o.value)).toEqual(['session', 'team.live', 'team.old-2', 'team.mine'])
    expect(shown.hiddenTeams).toBe(1)
  })

  test("an ended team shown on purpose: one notice naming its lead's folder and start; members `ended`; inboxes read; no composer", async () => {
    const s = fakeStore({
      teams: [team('session-ff3586a6', ['team-lead'], { leadSessionId: 'sid-gone', leadCwd: '/Users/me/flex-web', createdAt: NOW - 3 * 86_400_000 })],
      inboxes: { 'session-ff3586a6/team-lead': [entry('left over')] },
      sessions: [running('sid-other')],
    })
    const p = ports([agent('a1')])
    const n = nav({ team: 'session-ff3586a6', selected: 'team-lead' })
    const b = await body(p, n)
    expect(b.head).toEqual({ team: 'session-ff3586a6', note: '1 member · ended' })
    expect(b.ended).toMatch(
      /^session-ff3586a6 isn't running: its lead session \(\/Users\/me\/flex-web, started \d{4}-\d{2}-\d{2} \d{2}:\d{2}\) ended\. Its inboxes stay readable; nothing here sends to it, since a message would be read by nobody\.$/,
    )
    expect(b.rows.map(r => [r.key, r.status, r.unread, r.can])).toEqual([['team-lead', ENDED, 1, { message: false, transcript: false, stop: false }]])
    expect(s.reads).toContain('session-ff3586a6/team-lead')
    expect(b.selected!.inbox!.entries.map(e => e.lines)).toEqual([['left over']])
    expect(b.selected!.sendNote).toBeNull()
    expect(b.composer).toBeNull()
    expect(b.broadcast).toBeNull()
    expect(teamEnded(await gather(p, n), 'session-ff3586a6')).toBe(true)
    // Without a folder or a start in its config, the notice says only what's known.
    expect(endedText(team('bare', []), NOW)).toBe("bare isn't running: its lead session ended. Its inboxes stay readable; nothing here sends to it, since a message would be read by nobody.")
  })

  test('teamEnded never says so without evidence: an unread registry or unread teams is not ended; a team gone from a read folder is', async () => {
    // No `sessions`: the real reader, which tier 2's ports can't point at a registry.
    fakeStore({ teams: [team('t', ['team-lead'], { leadSessionId: 'sid-gone' })] })
    const p = ports()
    const unread = await gather(p, nav())
    expect(unread.activity).toEqual({ t: null })
    expect(teamEnded(unread, 't')).toBe(false)
    expect(teamEnded(unread, 'gone')).toBe(true)
    expect(teamEnded(unread, null)).toBe(false)
    fakeStore({ teams: new Error('EACCES'), sessions: [] })
    expect(teamEnded(await gather(p, nav()), 't')).toBe(false)
    fakeStore({ teams: [team('t', ['team-lead'], { leadSessionId: 'sid-gone' })], sessions: [] })
    expect(teamEnded(await gather(p, nav()), 't')).toBe(true)
  })

  test('the stamp moves when a team starts or stops running', async () => {
    const s = fakeStore({ teams: [team('t', ['team-lead'], { leadSessionId: 'sid-t' })], sessions: [] })
    const p = ports()
    const before = factsStamp(await gather(p, nav()))
    s.sessions = [running('sid-t')]
    expect(factsStamp(await gather(p, nav()))).not.toBe(before)
  })
})

describe("a transcript's wrapped messages (WP-DF; 2.1.291's tags)", () => {
  const user = (text: string): SessionMessage => say(text, 'user')
  const words = (text: string): string | null => {
    const l = messageLine(user(text))
    return l === null ? null : lineText(l)
  }

  test('<teammate-message> reads "from <name>: text", the name in the name color, the rest muted; more than one is counted', () => {
    expect(messageLine(user('<teammate-message teammate_id="lead" color="blue" summary="next step">\nlook at G2 first\nthen G3\n</teammate-message>'))).toEqual([
      { text: '› from ', color: 'inactive' },
      { text: 'lead', color: 'cyan_FOR_SUBAGENTS_ONLY' },
      { text: ': look at G2 first', color: 'inactive' },
    ])
    expect(words('<teammate-message teammate_id="a">\nx\n</teammate-message>\n\n<teammate-message teammate_id="b">\ny\n</teammate-message>')).toBe('› from a: x (+1 more)')
  })

  test('each sender tag: agent-message from, cross-session-message from-name (else from), channel source; attributes unescaped', () => {
    expect(words('<agent-message from="planner">\nplan ready\n</agent-message>')).toBe('› from planner: plan ready')
    expect(words('<cross-session-message from="sid-1" from-session="sid-1" hop-chain="a" from-name="web &quot;main&quot;">\nhello\n</cross-session-message>')).toBe('› from web "main": hello')
    expect(words('<cross-session-message from="sid-9">\nhi\n</cross-session-message>')).toBe('› from sid-9: hi')
    expect(words('<channel source="slack" chat_id="C1">\nping\n</channel>')).toBe('› from slack: ping')
    // No sender in it: the tag's name says what it was.
    expect(words('<teammate-message>\nanon\n</teammate-message>')).toBe('› teammate-message: anon')
  })

  test('a task notification, a command, shell input and command output; a system reminder gives way to the words after it', () => {
    expect(
      words(
        '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>t1</tool-use-id>\n<task-type>local_bash</task-type>\n<output-file>/tmp/x</output-file>\n<status>completed</status>\n<summary>Background command "npm test" completed (exit code 0)</summary>\n</task-notification>',
      ),
    ).toBe('› task completed: Background command "npm test" completed (exit code 0)')
    expect(words('<command-name>/litter</command-name>\n<command-message>litter</command-message>\n<command-args>agents team-a</command-args>')).toBe('› /litter agents team-a')
    expect(words('<bash-input>ls -la</bash-input>')).toBe('› shell: ls -la')
    // An empty block says nothing, so it isn't counted.
    expect(words('<bash-stdout>total 0</bash-stdout><bash-stderr></bash-stderr>')).toBe('› shell output: total 0')
    expect(words('<bash-stdout>a</bash-stdout><bash-stderr>b</bash-stderr>')).toBe('› shell output: a (+1 more)')
    expect(words('<local-command-stdout>done</local-command-stdout>')).toBe('› command output: done')
    expect(words('<system-reminder>\nnote to the model\n</system-reminder>\nplease fix G2')).toBe('› please fix G2')
    expect(words('<system-reminder>\nonly this\n</system-reminder>')).toBe('› system reminder: only this')
  })

  test('unknown markup is shown with its tags taken out, never dropped; text that starts with none is as written', () => {
    expect(words('<future-wrapper kind="x">\nsomething new\n</future-wrapper>')).toBe('› future-wrapper: something new')
    expect(words('<empty-thing/>')).toBe('› empty-thing')
    expect(words('<outer>\n<inner a="1">deep</inner>\n</outer>')).toBe('› outer: deep')
    expect(words('compare <b>this</b> and <i>that</i>')).toBe('› compare <b>this</b> and <i>that</i>')
  })

  test('a cut message: a tag never closed runs to the end, one cut inside itself is shown as written, an escaped close is words, a long one is cut', () => {
    expect(words('<teammate-message teammate_id="lead">\nthe text was cut here')).toBe('› from lead: the text was cut here')
    expect(words('<teammate-message teammate_id="le')).toBe('› <teammate-message teammate_id="le')
    // The engine escapes a close inside the text as `<\/tag>`: it isn't the end.
    expect(words('<teammate-message teammate_id="lead">\nquote: <\\/teammate-message> done\n</teammate-message>')).toBe('› from lead: quote: done')
    const long = words(`<teammate-message teammate_id="lead">\n${'x'.repeat(500)}\n</teammate-message>`)!
    expect(long.length).toBe('› from lead: '.length + 200)
    expect(long.endsWith('…')).toBe(true)
  })
})

describe('keys and the stamp', () => {
  test('a scope and a row survive any name: a team or a member with `/`, `:` or spaces', () => {
    for (const name of ['team-a', 'a/b:c d', '%41']) {
      const scope = scopeOf(name)
      expect(scope).not.toMatch(/[/:]/)
      expect(teamOfScope(scope)).toEqual({ team: name })
      expect(parseRowArg(rowArg(scope, 'x/y:z'))).toEqual({ scope, key: 'x/y:z' })
    }
    expect(teamOfScope('session')).toEqual({ team: null })
    expect(teamOfScope('team.')).toBeNull()
    expect(teamOfScope('team.%E0%A4%A')).toBeNull()
    expect(teamOfScope('other')).toBeNull()
    expect(parseRowArg('no-slash')).toBeNull()
    expect(parseRowArg('session/')).toBeNull()
    expect(statusOf(undefined)).toEqual({ text: 'unknown', glyph: '', color: 'inactive' })
  })

  test("the stamp moves with an agent's status, an inbox's stamp, the selected agent's message count, a team's config; and only then", async () => {
    const s = fakeStore({ teams: [team('team-a', ['team-lead', 'reviewer'])], inboxes: { 'team-a/reviewer': [entry('x')] } })
    const p = ports([agent('a1', { teammateId: 'reviewer@team-a', name: 'reviewer' })])
    p.transcripts = { a1: [say('one')] }
    const n = nav({ selected: 'a1' })
    const stamp = async () => factsStamp(await gather(p, n))
    const first = await stamp()
    expect(await stamp()).toBe(first)
    p.agents = [agent('a1', { teammateId: 'reviewer@team-a', name: 'reviewer', status: 'idle' })]
    const second = await stamp()
    expect(second).not.toBe(first)
    s.stamps['team-a/reviewer'] = 'size 999 mtime 2'
    const third = await stamp()
    expect(third).not.toBe(second)
    p.transcripts = { a1: [say('one'), say('two')] }
    const fourth = await stamp()
    expect(fourth).not.toBe(third)
    ;(s.teams as TeamInfo[])[0]!.mtimeMs = 2
    expect(await stamp()).not.toBe(fourth)
  })
})
