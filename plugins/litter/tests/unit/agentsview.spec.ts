// Tier 2: the agents pane's view (WP-CG; COMMON decisions 5, 6, 16), built by
// hooks/agents/view.ts from a listAgents fake and CE's store through `deps`
// (its body is CA's stub before the merge): every status word and an
// unknown one; a team's members with their inbox counts; a teammate of this
// session's team with both a status and a count; the selected agent's inbox
// and transcript tail, [More]; a message cleaned and cut; the stamp the tick
// compares; and what couldn't be read.

import { afterEach, describe, expect, test } from 'bun:test'
import type { ListedAgent, SessionMessage } from '../../hooks/ports'
import type { InboxEntry, TeamInfo } from '../../hooks/uitypes'
import type { AgentsBody } from '../../types/index'
import { clockAt } from '../../hooks/swarm/view'
import {
  INBOX_SHOWN,
  MAX_ROWS,
  NOT_HERE,
  TAIL,
  TAIL_MORE,
  blankAgentsNav,
  buildAgents,
  deps,
  entryOf,
  factsStamp,
  gather,
  messageLine,
  parseRowArg,
  rowArg,
  scopeOf,
  statusOf,
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

function team(name: string, members: readonly string[], over: Partial<TeamInfo> = {}): TeamInfo {
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

/** CE's store as a spec sets it: the teams, and each inbox by `<team>/<agent>` (null: none; an Error: unreadable). */
type Store = { teams: TeamInfo[] | Error; inboxes: Record<string, InboxEntry[] | null | Error>; stamps: Record<string, string>; reads: string[] }

function fakeStore(over: Partial<Store> = {}): Store {
  const s: Store = { teams: [], inboxes: {}, stamps: {}, reads: [], ...over }
  deps.teams = async () => {
    if (s.teams instanceof Error) throw s.teams
    return structuredClone(s.teams)
  }
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
    expect(b.title.map(s => s.text).join('')).toBe('litter · agents · this session · 8 agents · 1 running')
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
    expect(b.options).toEqual([{ value: 'session', label: 'this session' }])
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
    expect(b.title.map(s => s.text).join('')).toBe('litter · agents · team team-b · 3 members')
    expect(b.title.find(s => s.text === 'team-b')?.color).toBe('cyan')
    // A team's view keeps the composer for [Broadcast], with no row to [Send] to yet.
    expect(b.broadcast).toBe('team-b')
    expect(b.composer).toEqual({ key: 'agents:text:0', text: '', to: null })
    // The picker: this session first, then each team as the store answers them (newest first), with its member count.
    expect(b.options).toEqual([
      { value: 'session', label: 'this session' },
      { value: 'team.team-b', label: 'team-b (3 members)' },
      { value: 'team.team-a', label: 'team-a (1 member)' },
    ])
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
    expect(b.title.map(s => s.text).join('')).toBe('litter · agents · team team-a · 3 members · led by this session')
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
    expect(b.title.map(s => s.text).join('')).toBe('litter · agents · team gone · not found')
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

  test(`its transcript: the last ${TAIL} messages, one line each (the text, or the tool and its first argument); [More] shows ${TAIL_MORE}`, async () => {
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
    expect(t.more).toBe(false)
    expect(t.lines.length).toBe(TAIL)
    expect(t.lines.slice(-3)).toEqual([
      { text: '◆ step 40' },
      { text: '↳ Bash npm test (+1 more)', color: 'subtle' },
      { text: '› [bold]brackets[/bold] stay', dim: true },
    ])
    const more = (await body(p, nav({ selected: 'a1', more: true }))).selected!.transcript!
    expect(more.lines.length).toBe(TAIL_MORE)
    expect(more.more).toBe(true)
    expect(more.lines[0]).toEqual({ text: '◆ step 13' })
  })

  test("a transcript the engine won't read (another process's teammate, a finished agent) is unreadable, not empty", async () => {
    fakeStore()
    const p = ports([agent('a1')])
    const t = (await body(p, nav({ selected: 'a1' }))).selected!.transcript
    expect(t).toEqual({ readable: false, lines: [], total: 0, more: false })
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

  test('a message line: a tool with no argument, and a row with neither text nor tool, which reads as nothing', () => {
    expect(messageLine(toolCall('TaskList', {}))).toEqual({ text: '↳ TaskList', color: 'subtle' })
    expect(messageLine(toolCall('Edit', { file_path: { nested: true } }))).toEqual({ text: '↳ Edit {"nested":true}', color: 'subtle' })
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
