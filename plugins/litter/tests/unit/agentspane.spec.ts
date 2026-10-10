// Tier 2: the agents pane's actions (WP-CG; COMMON decisions 5, 6, 16):
// /litter agents opening on this session or a team; a send to `{ agentId }`,
// to a name, and to another team's member through CE's appendInbox (a `deps`
// fake: its body is CA's stub before the merge); a refused send, an empty
// message, a broadcast with one refusal; [Stop] armed, expired after 5 s on
// the fake clock, and confirmed with TaskStop's input checked; no stop for
// another team's member; stale presses; and the navigation and the
// composer's text surviving a rebuild and a module reset. WP-DF: only teams
// that run (a remembered one that ended isn't reopened, and says so once; one
// named is shown, ended, with nothing to send to it), [Show all], [Change],
// the roster's menu, the transcript's window pinned at the newest, and the
// wheel's hit test over what the terminal last drew (ui/drawn.ts).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ListedAgent, SessionMessage, ToolCallResult } from '../../hooks/ports'
import type { InboxEntry, WriteResult } from '../../hooks/uitypes'
import type { RunningSession, TeamRecord } from '../../hooks/team/store'
import type { AgentsBody, AgentsPaneView } from '../../types/index'
import type { BodyContext } from '../../hooks/ui/chrome'
import {
  LINES_LIST,
  ROSTER_LIST,
  agentsCommand,
  agentsHit,
  agentsTick,
  agentsTops,
  linesFooterText,
  linesWindow,
  onAgentsScroll,
  onAgentsUi,
  refreshAgents,
  resetAgentsPaneForTests,
} from '../../hooks/agents/pane'
import { AGENTS_STORE_KEY, agentsNavOf, deps, rowArg, scopeOf } from '../../hooks/agents/view'
import type { NodeBinding } from '../../hooks/swarm/types'
import { LITTER_PANE, listOffset, moveList, resetHubForTests, sections } from '../../hooks/ui/hub'
import { noteDrawn, resetDrawnForTests } from '../../hooks/ui/drawn'
import { nodePorts, type TestPorts } from './support/node-ports'

const SESSION = 'test-session'
const NOW = Date.parse('2026-10-05T15:00:00Z')
const saved = { ...deps }

beforeEach(() => {
  resetAgentsPaneForTests()
  resetHubForTests()
  resetDrawnForTests()
})
afterEach(() => {
  Object.assign(deps, saved)
  resetAgentsPaneForTests()
  resetHubForTests()
  resetDrawnForTests()
})

const agent = (id: string, over: Partial<ListedAgent> = {}): ListedAgent => ({ id, description: `task ${id}`, type: 'general-purpose', status: 'running', ...over })

function team(name: string, members: readonly string[], over: Partial<TeamRecord> = {}): TeamRecord {
  return {
    name,
    dir: name,
    leadSessionId: 'another-session',
    members: members.map(m => ({ name: m, agentId: `${m}@${name}`, agentType: 'general-purpose', color: null })),
    mtimeMs: 1,
    ...over,
  }
}

type Appended = { team: string; agent: string; entry: { from: string; text: string; summary?: string } }
type Store = { teams: TeamRecord[] | Error; inboxes: Record<string, InboxEntry[]>; appended: Appended[]; appendAnswer: (team: string, agent: string) => WriteResult }

function fakeStore(over: Partial<Store> = {}): Store {
  const s: Store = { teams: [], inboxes: {}, appended: [], appendAnswer: () => ({ ok: true, via: 'direct' }), ...over }
  deps.teams = async () => {
    if (s.teams instanceof Error) throw s.teams
    return structuredClone(s.teams)
  }
  deps.readInbox = async (_p, t, a) => {
    const entries = s.inboxes[`${t}/${a}`] ?? []
    return { entries: structuredClone(entries), stamp: `n ${entries.length}` }
  }
  deps.appendInbox = async (_p, t, a, entry) => {
    s.appended.push({ team: t, agent: a, entry: { ...entry } })
    return s.appendAnswer(t, a)
  }
  return s
}

function ports(agents: ListedAgent[] = []): TestPorts {
  const p = nodePorts({ sessionId: SESSION })
  p.clock.now = NOW
  p.agents = agents
  return p
}

const cmd = (args = '') => ({ command: 'litter', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } }) as never
const never = (async () => {
  throw new Error('the command answers, never passing on')
}) as never
const passOn = (async (e: unknown) => ({ passed: e })) as never

const ev = (element: string, over: Record<string, unknown> = {}) =>
  ({ plugin: 'litter', element, component: 'Pane', requestId: LITTER_PANE, surface: 'terminal', ...over }) as never
const press = (p: TestPorts, element: string) => onAgentsUi.press(p, ev(element), passOn)
const type = (p: TestPorts, value: string, kind: 'change' | 'submit' = 'change') => onAgentsUi.input(p, ev(`agents:text:${agentsNavOf()?.gen ?? 0}`, { kind, value }), passOn)
const pick = (p: TestPorts, value: string) => onAgentsUi.select(p, ev('agents:scope', { value }), passOn)

const view = (p: TestPorts): AgentsPaneView => p.views.agents as AgentsPaneView
const body = (p: TestPorts): AgentsBody => view(p).body!
const S = 'session'
const T = (name: string) => scopeOf(name)

async function open(p: TestPorts, args = ''): Promise<string> {
  const r = (await agentsCommand(p, cmd(args), never)) as { text: string }
  return r.text
}

describe('/litter agents', () => {
  test("opens on this session's agents, then on the team named; a name that's no team shows this session, saying so", async () => {
    fakeStore({ teams: [team('team-b', ['team-lead', 'writer'])] })
    const p = ports([agent('a1', { name: 'reviewer' }), agent('a2')])
    expect(await open(p)).toBe("Agents shows this session's 2 agents")
    expect(p.panes.opened).toEqual([{ id: 'litter', title: 'litter', focus: true }])
    expect(body(p).scope).toBe(S)
    expect(body(p).rows.map(r => r.key)).toEqual(['a1', 'a2'])

    expect(await open(p, 'team-b')).toBe("Agents shows team team-b's 2 members")
    expect(body(p).scope).toBe(T('team-b'))

    expect(await open(p, 'nope')).toBe("Agents shows this session's 2 agents")
    expect(body(p).notice).toEqual({ level: 'warning', text: "there's no team named nope, so this session's agents are shown: the picker lists the teams that run" })
  })

  test("a team named when the teams can't be read: this session's agents, and why", async () => {
    fakeStore({ teams: new Error('no config dir') })
    const p = ports()
    await open(p, 'team-b')
    expect(body(p).notice?.text).toBe("there's no team named team-b (the teams couldn't be read: no config dir), so this session's agents are shown: the picker lists the teams that run")
    expect(body(p).problems).toEqual(["the teams couldn't be read: no config dir"])
  })

  test('the navigation is mirrored in $.store with the session id', async () => {
    fakeStore({ teams: [team('team-b', ['writer'])] })
    const p = ports()
    await open(p, 'team-b')
    expect(p.storeMap.get(AGENTS_STORE_KEY)).toEqual({
      v: 1,
      session: SESSION,
      nav: { team: 'team-b', selected: null, text: '', gen: 1, field: '', armed: null, notice: null, showAll: false, named: 'team-b', picking: false },
    })
  })
})

describe('only teams that run (WP-DF §0)', () => {
  const running = (sessionId: string): RunningSession => ({ pid: 1, sessionId, cwd: '/work', startedAt: NOW, status: null, kind: 'interactive', jobId: null })

  test("Agents with no team reopens a remembered team while it runs; one that ended isn't, and the notice says so once", async () => {
    fakeStore({ teams: [team('team-b', ['team-lead', 'writer'], { leadSessionId: 'sid-b', leadCwd: '/work/b', createdAt: NOW - 60_000 })] })
    let live = [running('sid-b')]
    deps.sessions = async () => structuredClone(live)
    const p = ports([agent('a1')])
    await open(p, 'team-b')
    expect(await open(p)).toBe("Agents shows team team-b's 2 members")
    expect(body(p).notice).toBeNull()
    await press(p, `agents:select:${rowArg(T('team-b'), 'writer')}`)
    // Its lead session ends.
    live = []
    expect(await open(p)).toBe("Agents shows this session's 1 agent")
    expect(body(p).scope).toBe(S)
    expect(body(p).notice).toEqual({ level: 'info', text: "team team-b ended, so this session's agents are shown" })
    expect(agentsNavOf()).toEqual(expect.objectContaining({ team: null, selected: null }))
    // Once: the next press's outcome replaces it.
    await press(p, `agents:select:${rowArg(S, 'a1')}`)
    expect(body(p).notice).toBeNull()
    // Named, it's shown on purpose: the notice at the top, [This session's agents], no composer.
    expect(await open(p, 'team-b')).toBe("Agents shows team team-b's 2 members")
    expect(body(p).ended).toMatch(/^team-b isn't running: its lead session \(\/work\/b, started \d\d:\d\d\) ended\./)
    expect(body(p).composer).toBeNull()
    expect(body(p).rows.map(r => r.status.text)).toEqual(['ended', 'ended'])
    // A message to it is refused before anything is written: nothing here sends to it.
    await press(p, `agents:select:${rowArg(T('team-b'), 'writer')}`)
    await press(p, `agents:send:${rowArg(T('team-b'), 'writer')}`)
    expect(p.sent).toEqual([])
    await press(p, `agents:scope:${S}`)
    expect(body(p).scope).toBe(S)
  })

  test('the picker leaves the ended teams out and counts them; [Show all] lists them, [Running only] hides them again; the one named stays', async () => {
    fakeStore({ teams: [team('live', ['team-lead'], { leadSessionId: 'sid-live' }), team('old', ['team-lead'], { leadSessionId: 'sid-old' }), team('older', ['team-lead'], { leadSessionId: 'sid-older' })] })
    deps.sessions = async () => [running('sid-live')]
    const p = ports()
    await open(p)
    expect(body(p).options.map(o => o.value)).toEqual([S, T('live')])
    expect(body(p).hiddenTeams).toBe(2)
    expect(await press(p, 'agents:teams:all')).toEqual({ element: 'agents:teams:all' })
    expect(body(p).options.map(o => o.value)).toEqual([S, T('live'), T('old'), T('older')])
    expect(body(p).showAll).toBe(true)
    await press(p, 'agents:teams:running')
    expect(body(p).hiddenTeams).toBe(2)
    await open(p, 'old')
    await press(p, `agents:scope:${S}`)
    // Named once, it stays in the picker after another pick.
    expect(body(p).options.map(o => o.value)).toEqual([S, T('live'), T('old')])
    expect(body(p).hiddenTeams).toBe(1)
  })

  test('[Change] opens a folded picker; a pick folds it again', async () => {
    fakeStore({ teams: [team('team-b', ['writer'])] })
    const p = ports()
    await open(p)
    expect(body(p).picking).toBe(false)
    await press(p, 'agents:picker:open')
    expect(body(p).picking).toBe(true)
    await press(p, `agents:scope:${T('team-b')}`)
    expect(body(p).picking).toBe(false)
    expect(body(p).scope).toBe(T('team-b'))
    await press(p, 'agents:picker:open')
    await press(p, `agents:scope:${T('team-b')}`)
    expect(body(p).picking).toBe(false)
  })
})

describe('sending', () => {
  test("to this session's agent: `{ agentId }` through p.send; the notice says queued, never delivered; the field is drawn afresh, empty", async () => {
    fakeStore()
    const p = ports([agent('a1', { name: 'reviewer' })])
    await open(p)
    expect(await press(p, `agents:select:${rowArg(S, 'a1')}`)).toEqual({ element: `agents:select:${rowArg(S, 'a1')}` })
    const gen = agentsNavOf()!.gen
    expect(await type(p, 'look at G2 again')).toEqual({ element: `agents:text:${gen}`, value: 'look at G2 again' })
    expect(await press(p, `agents:send:${rowArg(S, 'a1')}`)).toEqual({ element: `agents:send:${rowArg(S, 'a1')}` })
    expect(p.sent).toEqual([{ to: { agentId: 'a1' }, text: 'look at G2 again' }])
    expect(body(p).notice).toEqual({ level: 'ok', text: 'queued for reviewer: it reads it at its next turn' })
    expect(body(p).composer).toEqual({ key: `agents:text:${gen + 1}`, text: '', to: 'reviewer' })
    expect(agentsNavOf()!.text).toBe('')
  })

  test('to an unlisted member of the team this session leads: by its name', async () => {
    fakeStore({ teams: [team('team-a', ['team-lead', 'idler'], { leadSessionId: SESSION })] })
    const p = ports()
    await open(p, 'team-a')
    await press(p, `agents:select:${rowArg(T('team-a'), 'idler')}`)
    await type(p, 'wake up')
    await press(p, `agents:send:${rowArg(T('team-a'), 'idler')}`)
    expect(p.sent).toEqual([{ to: 'idler', text: 'wake up' }])
    expect(body(p).notice?.text).toBe('queued for idler: it reads it at its next turn')
  })

  test("to another team's member: the store's locked append of `{ from: 'user', text }`, and no p.send", async () => {
    const s = fakeStore({ teams: [team('team-b', ['team-lead', 'writer'])] })
    const p = ports()
    await open(p, 'team-b')
    await press(p, `agents:select:${rowArg(T('team-b'), 'writer')}`)
    await type(p, 'the spec moved')
    await press(p, `agents:send:${rowArg(T('team-b'), 'writer')}`)
    expect(s.appended).toEqual([{ team: 'team-b', agent: 'writer', entry: { from: 'user', text: 'the spec moved' } }])
    expect(p.sent).toEqual([])
    expect(body(p).notice).toEqual({ level: 'ok', text: 'queued for writer in its inbox (team team-b): it reads it at its next turn' })
  })

  test("a refused send gives the refusal's words and keeps the text for another try; a throw is a refusal too", async () => {
    const s = fakeStore({ teams: [team('team-b', ['writer'])], appendAnswer: () => ({ ok: false, error: 'the inbox lock is held by another writer' }) })
    const p = ports([agent('a1', { name: 'reviewer' })])
    p.sendAnswer = () => ({ isDelivered: false, reason: 'no agent named reviewer is running' })
    await open(p)
    await press(p, `agents:select:${rowArg(S, 'a1')}`)
    const gen = agentsNavOf()!.gen
    await type(p, 'hello')
    await press(p, `agents:send:${rowArg(S, 'a1')}`)
    expect(body(p).notice).toEqual({ level: 'error', text: 'not sent to reviewer: no agent named reviewer is running' })
    expect(agentsNavOf()!.text).toBe('hello')
    // The field the person typed in stays (its key unchanged), so what they typed is still there.
    expect(body(p).composer?.key).toBe(`agents:text:${gen}`)

    p.sendAnswer = () => {
      throw new Error('the session is ending')
    }
    await press(p, `agents:send:${rowArg(S, 'a1')}`)
    expect(body(p).notice?.text).toBe('not sent to reviewer: the session is ending')

    await pick(p, T('team-b'))
    await press(p, `agents:select:${rowArg(T('team-b'), 'writer')}`)
    await press(p, `agents:send:${rowArg(T('team-b'), 'writer')}`)
    expect(s.appended.length).toBe(1)
    expect(body(p).notice).toEqual({ level: 'error', text: 'not sent to writer: the inbox lock is held by another writer' })
  })

  test('an empty message is refused before anything is sent', async () => {
    const s = fakeStore({ teams: [team('team-b', ['writer'])] })
    const p = ports([agent('a1')])
    await open(p)
    await press(p, `agents:select:${rowArg(S, 'a1')}`)
    await type(p, '  \n\u0007 ')
    await press(p, `agents:send:${rowArg(S, 'a1')}`)
    expect(body(p).notice).toEqual({ level: 'warning', text: 'type a message first: an empty one is never sent' })
    await pick(p, T('team-b'))
    await press(p, `agents:broadcast:${T('team-b')}`)
    expect(body(p).notice?.text).toBe('type a message first: an empty one is never sent')
    expect(p.sent).toEqual([])
    expect(s.appended).toEqual([])
  })

  test('Enter sends to the selected row; the engine empties that field, and a refusal puts the text back in a new one', async () => {
    fakeStore()
    const p = ports([agent('a1', { name: 'reviewer' })])
    await open(p)
    await press(p, `agents:select:${rowArg(S, 'a1')}`)
    const gen = agentsNavOf()!.gen
    expect(await type(p, 'by enter', 'submit')).toEqual({ element: `agents:text:${gen}`, value: 'by enter' })
    expect(p.sent).toEqual([{ to: { agentId: 'a1' }, text: 'by enter' }])
    expect(body(p).composer).toEqual({ key: `agents:text:${gen}`, text: '', to: 'reviewer' })

    p.sendAnswer = () => ({ isDelivered: false, reason: 'refused by a hook' })
    await type(p, 'again', 'submit')
    expect(body(p).notice?.text).toBe('not sent to reviewer: refused by a hook')
    expect(body(p).composer).toEqual({ key: `agents:text:${gen + 1}`, text: 'again', to: 'reviewer' })
  })

  test("Enter with nothing selected sends nothing, says what to do, and gives the text back", async () => {
    fakeStore({ teams: [team('team-b', ['writer'])] })
    const p = ports([agent('a1')])
    await open(p, 'team-b')
    const gen = agentsNavOf()!.gen
    await type(p, 'for whom?', 'submit')
    expect(p.sent).toEqual([])
    expect(body(p).notice).toEqual({ level: 'info', text: 'press a member first, or [Broadcast to team-b]' })
    expect(body(p).composer).toEqual({ key: `agents:text:${gen + 1}`, text: 'for whom?', to: null })
  })

  test("a broadcast: one append each to another team's members, and one notice listing who it was queued for and who refused", async () => {
    const s = fakeStore({
      teams: [team('team-b', ['team-lead', 'writer', 'checker'])],
      appendAnswer: (_t, a) => (a === 'checker' ? { ok: false, error: 'the inbox lock is held' } : { ok: true, via: 'direct' }),
    })
    const p = ports()
    await open(p, 'team-b')
    await type(p, 'stand down at 5')
    expect(await press(p, `agents:broadcast:${T('team-b')}`)).toEqual({ element: `agents:broadcast:${T('team-b')}` })
    expect(s.appended.map(a => [a.agent, a.entry])).toEqual([
      ['team-lead', { from: 'user', text: 'stand down at 5' }],
      ['writer', { from: 'user', text: 'stand down at 5' }],
      ['checker', { from: 'user', text: 'stand down at 5' }],
    ])
    expect(body(p).notice).toEqual({ level: 'warning', text: 'broadcast to team-b: queued for team-lead, writer; refused: checker (the inbox lock is held)' })
    // Two members have it: sending it again would repeat it to them, so the field empties.
    expect(agentsNavOf()!.text).toBe('')

    s.appendAnswer = () => ({ ok: false, error: 'not built yet (WP-CE)' })
    await type(p, 'again')
    await press(p, `agents:broadcast:${T('team-b')}`)
    expect(body(p).notice?.level).toBe('error')
    expect(agentsNavOf()!.text).toBe('again')
  })

  test('a broadcast to the team this session leads: its listed teammates through p.send, the rest by name, and never to this session itself', async () => {
    const s = fakeStore({ teams: [team('team-a', ['team-lead', 'reviewer', 'idler'], { leadSessionId: SESSION })] })
    const p = ports([agent('a1', { teammateId: 'reviewer@team-a', name: 'reviewer' })])
    await open(p, 'team-a')
    await type(p, 'wrap up')
    await press(p, `agents:broadcast:${T('team-a')}`)
    expect(p.sent).toEqual([
      { to: { agentId: 'a1' }, text: 'wrap up' },
      { to: 'idler', text: 'wrap up' },
    ])
    expect(s.appended).toEqual([])
    expect(body(p).notice).toEqual({ level: 'ok', text: 'broadcast to team-a: queued for reviewer, idler' })
  })
})

describe('[Stop]', () => {
  const stopped = (task: string): ToolCallResult => ({ result: { message: `Successfully stopped task: ${task}`, task_id: task, task_type: 'local_agent' }, text: 'stopped' }) as never

  test('the first press arms it; one 5 s later arms it again; a second within 5 s calls TaskStop with the id as task_id and gives its answer', async () => {
    fakeStore()
    const p = ports([agent('a1', { name: 'reviewer', status: 'running' })])
    p.toolAnswer = (_tool, input) => stopped(String(input.task_id))
    await open(p)
    const key = `agents:stop:${rowArg(S, 'a1')}`
    await press(p, `agents:select:${rowArg(S, 'a1')}`)
    expect(body(p).selected?.stop).toEqual({ armed: false })

    expect(await press(p, key)).toEqual({ element: key })
    expect(p.toolCalls).toEqual([])
    expect(body(p).notice).toEqual({ level: 'warning', text: '[Stop] again within 5 s to stop reviewer' })
    expect(body(p).selected?.stop).toEqual({ armed: true })

    // The tick redraws it disarmed once the 5 s are up.
    p.clock.now! += 5_000
    await agentsTick(p)
    expect(body(p).selected?.stop).toEqual({ armed: false })
    await press(p, key)
    expect(p.toolCalls).toEqual([])
    expect(body(p).notice?.text).toBe('[Stop] again within 5 s to stop reviewer')

    p.clock.now! += 4_999
    await press(p, key)
    expect(p.toolCalls).toEqual([{ tool: 'TaskStop', input: { task_id: 'a1' } }])
    expect(body(p).notice).toEqual({ level: 'ok', text: 'stopped reviewer: Successfully stopped task: a1' })
    expect(agentsNavOf()!.armed).toBeNull()
  })

  test("a teammate is stopped by its bare name, which TaskStop matches in 2.1.289 and 2.1.290 (name@team no longer does); a refusal is the notice's error", async () => {
    fakeStore({ teams: [team('team-a', ['team-lead', 'reviewer'], { leadSessionId: SESSION })] })
    const p = ports([agent('a1', { teammateId: 'reviewer@team-a', name: 'reviewer', status: 'waiting' })])
    p.toolAnswer = () => ({ deny: 'TaskStop is denied by a policy hook' }) as never
    await open(p, 'team-a')
    const key = `agents:stop:${rowArg(T('team-a'), 'reviewer')}`
    await press(p, key)
    await press(p, key)
    expect(p.toolCalls).toEqual([{ tool: 'TaskStop', input: { task_id: 'reviewer' } }])
    expect(body(p).notice).toEqual({ level: 'error', text: "reviewer wasn't stopped: TaskStop is denied by a policy hook" })

    // The same teammate from this session's view: the same task_id.
    p.toolCalls.length = 0
    await pick(p, S)
    await press(p, `agents:stop:${rowArg(S, 'a1')}`)
    await press(p, `agents:stop:${rowArg(S, 'a1')}`)
    expect(p.toolCalls).toEqual([{ tool: 'TaskStop', input: { task_id: 'reviewer' } }])
    await pick(p, T('team-a'))

    p.toolAnswer = () => ({ result: 'x', text: 'Task reviewer is not running (status: completed)', isError: true }) as never
    await press(p, key)
    await press(p, key)
    expect(body(p).notice?.text).toBe("reviewer wasn't stopped: Task reviewer is not running (status: completed)")

    p.toolAnswer = () => {
      throw new Error('no tool named TaskStop')
    }
    await press(p, key)
    await press(p, key)
    expect(body(p).notice?.text).toBe("reviewer wasn't stopped: no tool named TaskStop")
  })

  test("no stop for another team's member, nor for an agent that isn't running or waiting", async () => {
    fakeStore({ teams: [team('team-b', ['writer'])] })
    const p = ports([agent('a1', { name: 'done-one', status: 'completed' })])
    await open(p, 'team-b')
    await press(p, `agents:select:${rowArg(T('team-b'), 'writer')}`)
    expect(body(p).selected?.stop).toBeNull()
    await press(p, `agents:stop:${rowArg(T('team-b'), 'writer')}`)
    await press(p, `agents:stop:${rowArg(T('team-b'), 'writer')}`)
    expect(body(p).notice).toEqual({ level: 'info', text: "writer isn't this session's agent, so it can't be stopped here" })

    await pick(p, S)
    await press(p, `agents:stop:${rowArg(S, 'a1')}`)
    await press(p, `agents:stop:${rowArg(S, 'a1')}`)
    expect(body(p).notice?.text).toBe("done-one is completed, not running or waiting, so there's nothing to stop")
    expect(p.toolCalls).toEqual([])
  })

  test('an armed stop is for its row only: a press on another row arms that one instead', async () => {
    fakeStore()
    const p = ports([agent('a1', { name: 'one' }), agent('a2', { name: 'two' })])
    p.toolAnswer = (_tool, input) => stopped(String(input.task_id))
    await open(p)
    await press(p, `agents:stop:${rowArg(S, 'a1')}`)
    await press(p, `agents:stop:${rowArg(S, 'a2')}`)
    expect(p.toolCalls).toEqual([])
    expect(body(p).notice?.text).toBe('[Stop] again within 5 s to stop two')
  })
})

describe('stale presses and the picker', () => {
  test("a press for an agent no longer listed is ignored with a toast; one drawn for another scope too", async () => {
    fakeStore({ teams: [team('team-b', ['writer'])] })
    const p = ports([agent('a1', { name: 'reviewer' })])
    await open(p)
    await press(p, `agents:select:${rowArg(S, 'a1')}`)
    await type(p, 'hello')
    p.agents = []
    await press(p, `agents:send:${rowArg(S, 'a1')}`)
    expect(p.toasts).toEqual(["a1 isn't listed any more, so that was ignored"])
    expect(p.sent).toEqual([])
    expect(agentsNavOf()!.selected).toBeNull()

    await press(p, `agents:send:${rowArg(T('team-b'), 'writer')}`)
    expect(p.toasts.at(-1)).toBe("that was for team team-b, and Agents shows this session's agents now, so it was ignored")
    await press(p, `agents:broadcast:${T('team-b')}`)
    expect(p.toasts.at(-1)).toBe("that was for team team-b, and Agents shows this session's agents now, so it was ignored")
    await press(p, `agents:stop:${rowArg(S, 'a9')}`)
    expect(p.toasts.at(-1)).toBe("a9 isn't listed any more, so that was ignored")
    expect(p.sent).toEqual([])
    expect(p.toolCalls).toEqual([])
  })

  test('a press while the pane was never opened is ignored with a toast', async () => {
    fakeStore()
    const p = ports([agent('a1')])
    expect(await press(p, `agents:send:${rowArg(S, 'a1')}`)).toEqual({ element: `agents:send:${rowArg(S, 'a1')}` })
    expect(p.toasts).toEqual(["Agents isn't open in this session, so that was ignored: /litter agents opens it"])
    expect(p.sent).toEqual([])
  })

  test("a scope's row (or Button) changes the scope, dropping the selection and an armed stop; an old Select's pick still does; a value that's no scope is left alone", async () => {
    fakeStore({ teams: [team('team-b', ['writer'])] })
    const p = ports([agent('a1')])
    await open(p)
    await press(p, `agents:select:${rowArg(S, 'a1')}`)
    await press(p, `agents:stop:${rowArg(S, 'a1')}`)
    expect(agentsNavOf()).toEqual(expect.objectContaining({ selected: 'a1', armed: expect.anything() }))
    expect(await press(p, `agents:scope:${T('team-b')}`)).toEqual({ element: `agents:scope:${T('team-b')}` })
    expect(agentsNavOf()).toEqual(expect.objectContaining({ team: 'team-b', selected: null, armed: null }))
    expect(body(p).scope).toBe(T('team-b'))
    expect(await pick(p, S)).toEqual({ element: 'agents:scope', value: S })
    expect(agentsNavOf()!.team).toBeNull()
    await pick(p, 'not-a-scope')
    await press(p, 'agents:scope:not-a-scope')
    expect(agentsNavOf()!.team).toBeNull()
  })

  test("the roster's menu: Message selects the row for the composer; Transcript selects it at its transcript's newest line", async () => {
    fakeStore()
    const p = ports([agent('a1', { name: 'one' }), agent('a2', { name: 'two' })])
    p.transcripts = { a2: Array.from({ length: 30 }, (_, i) => say(`m${i}`)) }
    await open(p)
    expect(await press(p, `agents:message:${rowArg(S, 'a1')}`)).toEqual({ element: `agents:message:${rowArg(S, 'a1')}` })
    expect(body(p).selected?.key).toBe('a1')
    expect(body(p).composer?.to).toBe('one')
    await press(p, `agents:transcript:${rowArg(S, 'a2')}`)
    expect(body(p).selected?.key).toBe('a2')
    await moveList(p, LINES_LIST, 5, 20)
    await press(p, `agents:transcript:${rowArg(S, 'a2')}`)
    expect(listOffset(LINES_LIST)).toBe(0)
    // A menu row for a scope it wasn't drawn for is stale, as any press is.
    await press(p, `agents:message:${rowArg(T('team-x'), 'a1')}`)
    expect(p.toasts.at(-1)).toBe("that was for team team-x, and Agents shows this session's agents now, so it was ignored")
  })

  test("a key that isn't the pane's passes on, for every event", async () => {
    const p = ports()
    for (const event of ['message', 'press', 'input', 'select'] as const) {
      const e = ev(`board:${event}`, { value: 'x', kind: 'change' })
      expect(await onAgentsUi[event](p, e as never, passOn)).toEqual({ passed: e } as never)
    }
    expect(await onAgentsUi.scroll!(p, { by: 1 } as never, passOn)).toEqual({ passed: { by: 1 } } as never)
  })
})

const say = (text: string): SessionMessage => ({ role: 'assistant', text, toolUses: [] })

/** The terminal's body context, docked, as the hub hands it. */
const dock = (rows: number, columns = 100, over: Partial<BodyContext> = {}): BodyContext => ({
  surface: 'terminal',
  bodyColumns: columns,
  isFocused: true,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: rows },
  rows,
  focused: null,
  lists: {},
  ...over,
})

/** What the pane's render notes for the hit test (ui/drawn.ts): the body's top 4 rows down, the pane not scrolled. */
const BODY_TOP = 4
function drawnAt(p: TestPorts, ctx: BodyContext): void {
  noteDrawn({ shown: 'agents', view: view(p), ctx, bodyTop: BODY_TOP, scrollOffset: 0 })
}
const tick = (by: number, row?: number, column = 5) => ({ component: 'Pane', requestId: LITTER_PANE, offset: 0, by, bodyRows: 40, contentRows: 40, origin: { kind: 'person' }, ...(row !== undefined ? { pointer: { row, column } } : {}) }) as never

describe("the transcript's window and the wheel (the user's asks, 2026-10-07)", () => {
  test('linesWindow: the newest lines at offset 0, the offset counted from the newest and clamped; the footer says what lies each way', () => {
    expect(linesWindow(30, 0, 8)).toEqual({ start: 22, end: 30, earlier: 22, newer: 0, offset: 0, max: 22 })
    expect(linesWindow(30, 5, 8)).toEqual({ start: 17, end: 25, earlier: 17, newer: 5, offset: 5, max: 22 })
    expect(linesWindow(30, 99, 8)).toEqual({ start: 0, end: 8, earlier: 0, newer: 22, offset: 22, max: 22 })
    expect(linesWindow(5, 3, 8)).toEqual({ start: 0, end: 5, earlier: 0, newer: 0, offset: 0, max: 0 })
    expect(linesFooterText(linesWindow(30, 5, 8))).toBe('↑ 17 earlier · ↓ 5 newer')
    expect(linesFooterText(linesWindow(30, 0, 8))).toBe('↑ 22 earlier')
    expect(linesFooterText(linesWindow(30, 22, 8))).toBe('↓ 22 newer')
  })

  test('pinned at the newest while lines come in; scrolled up, it stays on what it showed; another row starts at the newest', async () => {
    fakeStore()
    const p = ports([agent('a1'), agent('a2')])
    const lines = Array.from({ length: 40 }, (_, i) => say(`m${i}`))
    p.transcripts = { a1: lines.slice(0, 30), a2: lines.slice(0, 3) }
    await open(p)
    await press(p, `agents:select:${rowArg(S, 'a1')}`)
    expect(listOffset(LINES_LIST)).toBe(0)
    p.transcripts = { ...p.transcripts, a1: lines.slice(0, 32) }
    await agentsTick(p)
    expect(listOffset(LINES_LIST)).toBe(0)
    // Scrolled up 4: two more lines come in, and the window moves up with them.
    await moveList(p, LINES_LIST, 4, 31)
    p.transcripts = { ...p.transcripts, a1: lines.slice(0, 34) }
    await agentsTick(p)
    expect(listOffset(LINES_LIST)).toBe(6)
    await press(p, `agents:select:${rowArg(S, 'a2')}`)
    expect(listOffset(LINES_LIST)).toBe(0)
  })

  test('the hit test: agentsTops names where the roster and the transcript start, at 100 and 60 columns; a row between them is neither', async () => {
    fakeStore()
    const p = ports(Array.from({ length: 12 }, (_, i) => agent(`a${i}`, { name: `agent-${i}` })))
    p.transcripts = { a0: Array.from({ length: 50 }, (_, i) => say(`m${i}`)) }
    await open(p)
    await press(p, `agents:select:${rowArg(S, 'a0')}`)
    for (const columns of [100, 60]) {
      const tops = agentsTops(body(p), dock(40, columns))
      // The first line; no picker (this session is the only choice); then the roster.
      expect(tops.picker).toBeNull()
      expect(tops.roster!.top).toBe(1)
      expect(tops.roster!.height).toBe(tops.plan.rosterRows + 1)
      // Under the roster: [Stop], the inbox's heading and its line, the transcript's heading.
      expect(tops.lines!.top).toBe(tops.roster!.top + tops.roster!.height + 1 + 2 + 1)
      expect(tops.lines!.height).toBe(tops.plan.linesRows + 1)
      expect(agentsHit(tops, tops.roster!.top)).toBe('roster')
      expect(agentsHit(tops, tops.lines!.top + tops.lines!.height - 1)).toBe('lines')
      expect(agentsHit(tops, tops.lines!.top - 1)).toBeNull()
      expect(agentsHit(tops, 0)).toBeNull()
    }
  })

  test("with more than four choices the picker is a list under its heading: its rows, then the roster under its own, at 100 and 60 columns; short, it folds", async () => {
    fakeStore({ teams: Array.from({ length: 6 }, (_, i) => team(`t${i}`, ['team-lead'], { leadSessionId: SESSION })) })
    const p = ports(Array.from({ length: 4 }, (_, i) => agent(`a${i}`)))
    await open(p)
    for (const columns of [100, 60]) {
      const tops = agentsTops(body(p), dock(40, columns))
      expect(tops.plan.picker).toBe('list')
      // The first line, the `Show` heading, then the list's five rows and its footer.
      expect(tops.picker).toEqual({ top: 2, height: 6 })
      // The `Agents` heading, then the roster: four rows and the Client's status line.
      expect(tops.roster).toEqual({ top: 9, height: 5 })
      expect(agentsHit(tops, 2)).toBe('picker')
      expect(agentsHit(tops, 8)).toBeNull()
      expect(agentsHit(tops, 9)).toBe('roster')
      // Under 24 rows the picker folds to one line, and the roster moves up.
      const short = agentsTops(body(p), dock(20, columns))
      expect(short.plan.picker).toBe('folded')
      expect(short.picker).toBeNull()
      expect(short.roster!.top).toBe(2)
    }
  })

  test('a tick over the transcript moves its window (up: earlier), over the roster the roster; over the rest, or at an edge, it passes on', async () => {
    fakeStore()
    const p = ports(Array.from({ length: 12 }, (_, i) => agent(`a${i}`, { name: `agent-${i}` })))
    p.transcripts = { a0: Array.from({ length: 50 }, (_, i) => say(`m${i}`)) }
    await open(p)
    await press(p, `agents:select:${rowArg(S, 'a0')}`)
    const ctx = dock(40)
    drawnAt(p, ctx)
    const tops = agentsTops(body(p), ctx)
    const overLines = BODY_TOP + tops.lines!.top
    const overRoster = BODY_TOP + tops.roster!.top
    expect(await onAgentsScroll(p, tick(-1, overLines), passOn)).toEqual({})
    expect(listOffset(LINES_LIST)).toBe(1)
    expect(await onAgentsScroll(p, tick(1, overLines), passOn)).toEqual({})
    expect(listOffset(LINES_LIST)).toBe(0)
    // At the newest already: it passes on.
    expect(await onAgentsScroll(p, tick(1, overLines), passOn)).toEqual({ passed: tick(1, overLines) } as never)
    expect(await onAgentsScroll(p, tick(1, overRoster), passOn)).toEqual({})
    expect(listOffset(ROSTER_LIST)).toBe(1)
    expect(listOffset(LINES_LIST)).toBe(0)
    // The first line, past the body's right edge, another section's drawing: passed on.
    expect(await onAgentsScroll(p, tick(1, BODY_TOP), passOn)).toEqual({ passed: tick(1, BODY_TOP) } as never)
    expect(await onAgentsScroll(p, tick(1, overRoster, 100), passOn)).toEqual({ passed: tick(1, overRoster, 100) } as never)
    noteDrawn({ shown: 'tasks', view: null, ctx, bodyTop: BODY_TOP, scrollOffset: 0 })
    expect(await onAgentsScroll(p, tick(1, overRoster), passOn)).toEqual({ passed: tick(1, overRoster) } as never)
  })

  test('the scroll keys carry no pointer: the list the ring is in, else the transcript, a page at most', async () => {
    fakeStore()
    const p = ports(Array.from({ length: 12 }, (_, i) => agent(`a${i}`, { name: `agent-${i}` })))
    p.transcripts = { a0: Array.from({ length: 50 }, (_, i) => say(`m${i}`)) }
    await open(p)
    await press(p, `agents:select:${rowArg(S, 'a0')}`)
    drawnAt(p, dock(40))
    const page = agentsTops(body(p), dock(40)).plan.linesRows - 1
    expect(await onAgentsScroll(p, tick(-40), passOn)).toEqual({})
    expect(listOffset(LINES_LIST)).toBe(page)
    drawnAt(p, dock(40, 100, { focused: `agents:select:${rowArg(S, 'a3')}` }))
    expect(await onAgentsScroll(p, tick(1), passOn)).toEqual({})
    expect(listOffset(ROSTER_LIST)).toBe(1)
  })

  test("where no wheel reaches, the footers page: the roster's [↓ n more], the transcript's [↑ n earlier]", async () => {
    fakeStore()
    const p = ports(Array.from({ length: 20 }, (_, i) => agent(`a${i}`)))
    p.transcripts = { a0: Array.from({ length: 50 }, (_, i) => say(`m${i}`)) }
    await open(p)
    expect(await press(p, `${ROSTER_LIST}:down`)).toEqual({ element: `${ROSTER_LIST}:down` })
    // No drawing noted (not the terminal): the last view at its inline windows, the roster's 8.
    expect(listOffset(ROSTER_LIST)).toBe(7)
    await press(p, `${ROSTER_LIST}:up`)
    expect(listOffset(ROSTER_LIST)).toBe(0)
    await press(p, `agents:select:${rowArg(S, 'a0')}`)
    await press(p, `${LINES_LIST}:up`)
    expect(listOffset(LINES_LIST)).toBe(7)
    await press(p, `${LINES_LIST}:down`)
    expect(listOffset(LINES_LIST)).toBe(0)
  })
})

describe('the tick, and surviving a rebuild and a module reset', () => {
  test('the tick writes a view only when what it was built from moved', async () => {
    fakeStore({ teams: [team('team-a', ['team-lead', 'reviewer'])], inboxes: {} })
    const p = ports([agent('a1', { teammateId: 'reviewer@team-a', name: 'reviewer' })])
    await open(p)
    const v = view(p).v
    await agentsTick(p)
    await agentsTick(p)
    expect(view(p).v).toBe(v)
    p.agents = [agent('a1', { teammateId: 'reviewer@team-a', name: 'reviewer', status: 'idle' })]
    await agentsTick(p)
    expect(view(p).v).toBe(v + 1)
    expect(body(p).rows[0]?.status.text).toBe('idle')
    // A message arrives in its inbox.
    fakeStore({ teams: [team('team-a', ['team-lead', 'reviewer'])], inboxes: { 'team-a/reviewer': [{ from: 'team-lead', text: 'x', timestamp: 'now', summary: null }] } })
    await agentsTick(p)
    expect(view(p).v).toBe(v + 2)
    expect(body(p).rows[0]?.unread).toBe(1)
  })

  test("typing is kept without a redraw, and survives a rebuild (the field keeps its key) and a module reset (the text in a new field)", async () => {
    fakeStore()
    const p = ports([agent('a1', { name: 'reviewer' })])
    await open(p)
    await press(p, `agents:select:${rowArg(S, 'a1')}`)
    const v = view(p).v
    const key = body(p).composer!.key
    await type(p, 'half a thought')
    expect(view(p).v).toBe(v)
    // A rebuild (the agent's status moved) draws the same field, so the engine keeps what was typed.
    p.agents = [agent('a1', { name: 'reviewer', status: 'waiting' })]
    await agentsTick(p)
    expect(view(p).v).toBe(v + 1)
    expect(body(p).composer!.key).toBe(key)
    expect(agentsNavOf()!.text).toBe('half a thought')
    expect((p.storeMap.get(AGENTS_STORE_KEY) as { nav: { text: string } }).nav.text).toBe('half a thought')

    // A hot reload: module memory is empty; the store brings the navigation back.
    resetAgentsPaneForTests()
    expect(agentsNavOf()).toBeNull()
    await agentsTick(p)
    expect(agentsNavOf()).toEqual(expect.objectContaining({ team: null, selected: 'a1', text: 'half a thought' }))
    expect(body(p).composer).toEqual({ key: `agents:text:${Number(key.split(':')[2]) + 1}`, text: 'half a thought', to: 'reviewer' })
    await press(p, `agents:send:${rowArg(S, 'a1')}`)
    expect(p.sent).toEqual([{ to: { agentId: 'a1' }, text: 'half a thought' }])
  })

  test("another session's navigation in the store isn't read back", async () => {
    fakeStore()
    const p = ports([agent('a1')])
    p.storeMap.set(AGENTS_STORE_KEY, { v: 1, session: 'other-session', nav: { team: null, selected: 'a1', text: 'theirs', gen: 0, field: '', more: false, armed: null, notice: null } })
    await agentsTick(p)
    expect(agentsNavOf()).toBeNull()
    expect(p.views.agents).toBeUndefined()
  })

  test('a malformed navigation in the store is read back as far as it holds', async () => {
    fakeStore()
    const p = ports([agent('a1')])
    p.storeMap.set(AGENTS_STORE_KEY, { v: 1, session: SESSION, nav: { team: 7, selected: 'a1', text: 3, gen: -2, armed: { arg: 1 }, notice: { level: 'shout', text: 'x' } } })
    await agentsTick(p)
    expect(agentsNavOf()).toEqual({ team: null, selected: 'a1', text: '', gen: 0, field: '', armed: null, notice: null, showAll: false, named: null, picking: false })
    expect(body(p).selected?.key).toBe('a1')
  })

  test('after a /clear wiped $.state, refresh writes the view again even when nothing moved', async () => {
    fakeStore()
    const p = ports([agent('a1')])
    await open(p)
    const v = view(p).v
    p.views.agents = null
    await agentsTick(p)
    expect(p.views.agents).toBeNull()
    await refreshAgents(p)
    expect(view(p).v).toBe(v + 1)
  })
})

describe('a swarm node', () => {
  const node: NodeBinding = {
    agentId: 'a-fix1',
    swarm: 'alpha',
    launch: '20261007-010203',
    node: 'fixer',
    n: 1,
    kind: 'worker',
    of: null,
    parent: null,
    type: 'litter:sw-alpha-fixer',
    cwd: '/repo',
    branch: null,
    token: 't',
    revision: 1,
    generation: 1,
    boundAt: 0,
    adopted: false,
  }

  test("[Open in Swarms] shows its swarm's browser with the node picked (`<swarm> <agentId>`), in this pane; a row that's no node opens nothing", async () => {
    fakeStore()
    deps.binding = id => (id === node.agentId ? node : null)
    deps.bindings = () => [node]
    deps.launchOf = () => node.launch
    deps.litterDir = () => '/repo/.claude/litter'
    deps.launchLedger = async () => ({ records: [], head: { seq: 0, sha: 'sha' }, tampered: null, brokenTail: null, anchor: 'head' })
    const p = ports([agent('a-fix1', { type: 'litter:sw-alpha-fixer' }), agent('a-help')])
    const loads: unknown[] = []
    const real = sections.swarms
    sections.swarms = { ...real, load: async (_q, arg) => (loads.push(arg), { text: 'Swarms shows alpha' }) }
    try {
      await open(p)
      await press(p, `agents:select:${rowArg(S, 'a-fix1')}`)
      expect(body(p).selected?.swarm?.name).toBe('alpha')
      const key = `agents:open-swarm:${rowArg(S, 'a-fix1')}`
      expect(await press(p, key)).toEqual({ element: key })
      expect(loads).toEqual(['alpha a-fix1'])
      await press(p, `agents:open-swarm:${rowArg(S, 'a-help')}`)
      expect(loads).toEqual(['alpha a-fix1'])
    } finally {
      sections.swarms = real
    }
  })
})
