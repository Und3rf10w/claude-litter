// Tier 1: the Agents section as the engine runs it (WP-CG, phase 5b's WP-DA,
// WP-DF): /litter agents opens the `litter` pane on Agents, asking for the
// keyboard, and writes its view; the body's first line says what's shown;
// the roster is the chrome's list (on the terminal and the desktop a Client
// with a right-click menu, elsewhere Buttons); once one is selected, its
// inbox and its transcript under headings (the engine's wrapped messages as
// words, a tool's name in its own color, a window the wheel moves), [Stop]
// and the composer (a field labelled "To <name>"), on every surface (the
// mobile app with no fields); [Send]'s press reaches $.session.send. A team
// view with unread mail; only teams that run, the ended ones counted, and
// one shown on purpose saying it ended; every action by press and by the
// menu; and the drawings at 100 and 60 columns, docked and inline, nothing
// past the rows the hub gives the body. The agents come from an agent.list
// hook beneath, the transcript from a session.messages hook, the teams, the
// inboxes and the registry of running sessions from a $.fs over a map under
// the test's own config dir: no real ~/.claude/ is read.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { AgentsPaneView } from '../types/index'
import { drawText, drawWithColors } from './drawing'

const SESSION = 'tier1-session'
// Midday in UTC, so an entry a minute or two old is today in every zone (the inbox draws today's as HH:MM).
const NOW = Date.parse('2027-01-15T13:00:00Z')
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const
type Surface = (typeof SURFACES)[number]

type Over = { bodyColumns?: number; bodyRows?: number; placement?: 'dock' | 'inline'; isFocused?: boolean }
const pane = (o: Over = {}) =>
  ({ title: 'litter', isFocused: o.isFocused ?? false, bodyColumns: o.bodyColumns ?? 120, placement: o.placement ?? 'dock', scroll: { offset: 0, bodyRows: o.bodyRows ?? 80 }, view: {} }) as const

/** `/litter <args>`. */
const run = ($: Engine, args = '') =>
  $.command.run({ command: 'litter', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const AGENTS = [
  { id: 'a1', description: 'review the parser', type: 'general-purpose', status: 'running', name: 'reviewer' },
  { id: 'a2', description: 'fix G2', type: 'Explore', status: 'completed' },
] as const

/** a1's transcript: the engine's wrapped messages, its words, its tools. */
const TRANSCRIPT = [
  { role: 'user', text: '<teammate-message teammate_id="team-lead" color="blue" summary="the parser">\nreview the parser in compile.ts\n</teammate-message>', toolUses: [] },
  { role: 'assistant', text: 'found the bug in compile.ts', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'npm test' } }] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't2', tool: 'Read', input: { file_path: '/work/me/compile.ts' } }] },
  { role: 'user', text: '<system-reminder>\nnot for the pane\n</system-reminder>\n<teammate-message teammate_id="checker">\nG3 too, please\n</teammate-message>', toolUses: [] },
] as const

const iso = (ms: number) => new Date(ms).toISOString()
const member = (team: string, name: string, agentType: string, cwd: string) => ({ agentId: `${name}@${team}`, name, agentType, joinedAt: NOW - 3_600_000, cwd })
const config = (name: string, leadSessionId: string, members: readonly object[], createdAt: number) =>
  JSON.stringify({ name, createdAt, leadAgentId: `team-lead@${name}`, leadSessionId, members })

/**
 * The config dir's files: team-b, whose lead session runs (the registry
 * lists sid-b), with two messages unread in writer's inbox; three teams
 * whose lead sessions ended; and the registry, this session's entry and
 * team-b's lead's.
 */
const FILES: Record<string, string> = {
  '/cfg/teams/team-b/config.json': config(
    'team-b',
    'sid-b',
    [member('team-b', 'team-lead', 'team-lead', '/work/b'), member('team-b', 'writer', 'general-purpose', '/work/b'), member('team-b', 'checker', 'Explore', '/work/b')],
    NOW - 3_600_000,
  ),
  '/cfg/teams/team-b/inboxes/writer.json': JSON.stringify([
    { from: 'team-lead', text: 'the spec moved: see G2', timestamp: iso(NOW - 120_000), read: false },
    { from: 'checker', text: 'G3 fails on main\nthe log is in /tmp/g3.log', timestamp: iso(NOW - 60_000), read: false },
  ]),
  ...Object.fromEntries(
    [1, 2, 3].map(i => [`/cfg/teams/old-${i}/config.json`, config(`old-${i}`, `sid-gone-${i}`, [member(`old-${i}`, 'team-lead', 'team-lead', '/work/flex-web')], NOW - i * 86_400_000)]),
  ),
  '/cfg/sessions/4242.json': JSON.stringify({ pid: 4242, sessionId: 'sid-b', cwd: '/work/b', startedAt: NOW - 3_600_000, procStart: 'x', kind: 'interactive' }),
  '/cfg/sessions/4343.json': JSON.stringify({ pid: 4343, sessionId: SESSION, cwd: '/work/me', startedAt: NOW - 600_000, procStart: 'y', kind: 'interactive' }),
}

type World = {
  opened: { id: string; focus: boolean }[]
  sent: { to: unknown; text: string }[]
  calls: { tool: string; input: unknown }[]
  views: AgentsPaneView[]
  /** The next agents view litter writes: a Client's post is handled after the act that made it resolves. */
  nextView: () => Promise<AgentsPaneView>
  /** The $.fs map, for a test to change what's on disk. */
  files: Map<string, string>
}

/** The engine around the pane, over a $.fs of `files` (none: an empty config dir). */
function world(on: On, files: Record<string, string> = {}, transcripts: Record<string, readonly object[]> = { a1: TRANSCRIPT }, agents: readonly object[] = AGENTS): World {
  const opened: World['opened'] = []
  const sent: World['sent'] = []
  const calls: World['calls'] = []
  const views: AgentsPaneView[] = []
  const waiting: ((v: AgentsPaneView) => void)[] = []
  const map = new Map(Object.entries(files))
  const isDir = (path: string) => [...map.keys()].some(k => k.startsWith(`${path}/`))
  on('agent.list', async () => ({ value: structuredClone(agents) as never }))
  on('session.messages', async (_$, e) => {
    const t = transcripts[e.agentId ?? '']
    return (t ? { value: structuredClone(t) } : { deny: `no transcript for ${e.agentId}` }) as never
  })
  on('session.id', async () => ({ value: SESSION }))
  on('session.send', async (_$, e) => {
    sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  // TaskStop beneath the plugins: what it was asked, and the engine's answer.
  on('tool.call', { tool: 'TaskStop' }, async (_$, e) => {
    const id = String((e as { task_id?: unknown }).task_id)
    calls.push({ tool: 'TaskStop', input: { task_id: id } })
    return { result: { message: `Successfully stopped task: ${id}` }, text: 'stopped' } as never
  })
  on('ui.open', async (_$, e) => {
    opened.push({ id: e.id, focus: e.focus === true })
    return { value: { isPlaced: true } }
  })
  on('ui.panes', async () => ({ value: [{ id: 'litter', title: 'litter', isShown: true, isFocused: true, isPlaced: true }] }))
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  // The engine's ring and window, beneath the plugins: each lands.
  on('ui.focus', async () => ({}))
  on('ui.scroll', async () => ({}))
  on('state.set', async (_$, e, next) => {
    if (e.key === 'agentsPane') {
      views.push(e.value as AgentsPaneView)
      for (const w of waiting.splice(0)) w(e.value as AgentsPaneView)
    }
    return next(e)
  })
  on('fs.exists', async (_$, e) => ({ value: map.has(e.path) || isDir(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = map.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.list', async (_$, e) => {
    if (!isDir(e.path)) throw new Error(`ENOENT: ${e.path}`)
    const names = new Set([...map.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => k.slice(e.path.length + 1).split('/')[0]!))
    return { value: [...names].map(name => ({ name, kind: map.has(`${e.path}/${name}`) ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', async (_$, e) => {
    if (!map.has(e.path) && !isDir(e.path)) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: map.has(e.path) ? 'file' : 'dir', size: map.get(e.path)?.length ?? 0, mtimeMs: NOW, isLink: false } }
  })
  on('fs.write', async (_$, e) => {
    throw new Error(`nothing is written in this test: ${e.path}`)
  })
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: 'not in this test', isStdoutTruncated: false, isStderrTruncated: false } }))
  mock.env(on, { CLAUDE_CONFIG_DIR: '/cfg', HOME: '/home/tier1' })
  mock.store(on)
  mock.clock(on, { now: NOW })
  return {
    opened,
    sent,
    calls,
    views,
    nextView: () => new Promise<AgentsPaneView>(resolve => waiting.push(resolve)),
    files: map,
  }
}

const mountAgents = <S extends Surface>($: Engine, surface: S, o: Over = {}) => $.ui.mount({ plugin: 'litter', surface, component: 'Pane', requestId: 'litter', props: pane(o) })
/** A terminal's drawing: a Client's pointer and keys. */
type Ui = Awaited<ReturnType<typeof mountAgents<'terminal'>>>
/** Any surface's: what every one has. */
type AnyUi = { press: Ui['press']; find: Ui['find'] }

/** Where the roster is a Client (it has a menu to offer). */
const clientRoster = (surface: Surface): boolean => surface === 'terminal' || surface === 'desktop'

/** A row's press: a click on its row in the roster's Client (its post handled after the act, so the view it writes is awaited), else its Button. */
async function pressRow(ui: AnyUi, w: World, surface: Surface, index: number, key: string): Promise<void> {
  if (!clientRoster(surface)) {
    await ui.press({ key })
    return
  }
  const next = w.nextView()
  await (ui as Ui).pointer({ type: 'down', x: 4, y: index, button: 'left', in: 'agents:roster' })
  await next
}

/** The roster's menu on row `index`: a right-click, ↓ `down` times, Enter; the view the pick writes awaited. */
async function menuPick(ui: Ui, w: World, index: number, down: number): Promise<void> {
  await ui.pointer({ type: 'down', x: 4, y: index, button: 'right', in: 'agents:roster' })
  for (let i = 0; i < down; i++) await ui.key({ key: 'down', in: 'agents:roster' })
  const next = w.nextView()
  await ui.key({ key: 'return', in: 'agents:roster' })
  await next
}

/** The roster's Client drawn as lines, each trimmed: a row reads as one line, though each of its cells is a Text in its color. */
const rosterLines = async (ui: { drawn: Ui['drawn'] }, columns = 120): Promise<string[]> => drawText(await ui.drawn({ in: 'agents:roster' }), columns).map(r => r.trim())

/** The pane drawn as rows, the roster's Client in place with its own drawing (tests/drawing.ts draws a Client as its key). */
async function drawn(ui: Ui, columns: number, colors = false): Promise<string[]> {
  const draw = colors ? drawWithColors : drawText
  const rows = draw(await ui.drawn(), columns)
  const at = rows.findIndex(r => r.includes('‹Client agents:roster›'))
  if (at < 0) return rows
  return [...rows.slice(0, at), ...draw(await ui.drawn({ in: 'agents:roster' }), columns), ...rows.slice(at + 1)]
}

describe('/litter agents', () => {
  test("opens `litter` on this session's agents, with the keyboard, and writes its view", async ($, on) => {
    const w = world(on)
    const r = await run($, 'agents')
    expect(r.text).toBe("Agents shows this session's 2 agents")
    expect(w.opened).toEqual([{ id: 'litter', focus: true }])
    const body = w.views.at(-1)?.body
    expect(body?.scope).toBe('session')
    expect(body?.rows.map(x => [x.key, x.name, x.status.text])).toEqual([
      ['a1', 'reviewer', 'running'],
      ['a2', 'fix G2', 'completed'],
    ])
  })
})

describe('the render', () => {
  for (const surface of SURFACES) {
    test(`draws the first line, the rows, then the selected agent's inbox, transcript, [Stop] and composer, on the ${surface}`, async ($, on) => {
      const w = world(on)
      await run($, 'agents')
      const ui = await mountAgents($, surface)
      // The hub's header names the section; the body's first line says what's shown, and its counts.
      expect(await ui.find({ type: 'Text', text: ' · Agents' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: 'this session' }))?.props).toEqual(expect.objectContaining({ bold: true, color: 'suggestion' }))
      expect((await ui.find({ type: 'Text', text: '2 agents · 1 running' }))?.props.color).toBe('inactive')
      // The rows: the list's Client, with its right-click menu, where one is drawn, else Buttons; either way each cell in its own color.
      const at: { in?: string } = clientRoster(surface) ? { in: 'agents:roster' } : {}
      if (clientRoster(surface)) {
        expect(await rosterLines(ui)).toContainEqual(expect.stringMatching(/^reviewer +general-purpose +▸ running/))
        expect(await rosterLines(ui)).toContainEqual(expect.stringMatching(/^fix G2 +Explore +✓ completed/))
      } else {
        // A label is padded to its column (the list's planColumns).
        expect((await ui.find({ type: 'Button', key: 'agents:select:session/a1' }))?.text.trimEnd()).toBe('reviewer')
        expect((await ui.find({ type: 'Button', key: 'agents:select:session/a2' }))?.text.trimEnd()).toBe('fix G2')
      }
      expect((await ui.find({ type: 'Text', text: /^▸ running *$/, ...at }))?.props.color).toBe('background')
      expect((await ui.find({ type: 'Text', text: /^✓ completed *$/, ...at }))?.props.color).toBe('success')
      expect((await ui.find({ type: 'Text', text: /^Explore *$/, ...at }))?.props.color).toBe('inactive')
      // This session is the only choice and no team was left out: no picker, and no Select anywhere.
      expect(await ui.find({ type: 'Button', key: 'agents:scope:session' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'Show' })).toBeUndefined()
      expect(await ui.find({ type: 'Select' })).toBeUndefined()
      // Nothing selected: no composer.
      expect(await ui.find({ type: 'Button', key: 'agents:send:session/a1' })).toBeUndefined()

      await pressRow(ui, w, surface, 0, 'agents:select:session/a1')
      expect(await ui.find({ type: 'Text', text: 'Inbox · ' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: 'reviewer' }))?.props.color).toBe('cyan_FOR_SUBAGENTS_ONLY')
      expect(await ui.find({ type: 'Text', text: "no inbox: it isn't in a team" })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Transcript · ' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '5 lines' })).toBeDefined()
      // The engine's wrapped message in words, the sender in the name color.
      expect(await ui.find({ type: 'Text', text: '› from ' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: 'team-lead' }))?.props.color).toBe('cyan_FOR_SUBAGENTS_ONLY')
      expect(await ui.find({ type: 'Text', text: ': review the parser in compile.ts' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: ': G3 too, please' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /system-reminder|not for the pane/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: '◆ found the bug in compile.ts' })).toBeDefined()
      // A tool line: the name bold in the label color, the command muted, a path in the path color.
      expect((await ui.find({ type: 'Text', text: 'Bash' }))?.props).toEqual(expect.objectContaining({ bold: true, color: 'text' }))
      expect((await ui.find({ type: 'Text', text: ' npm test' }))?.props.color).toBe('inactive')
      expect((await ui.find({ type: 'Text', text: ' /work/me/compile.ts' }))?.props.color).toBe('suggestion')
      expect((await ui.find({ type: 'Text', text: '↳ ' }))?.props.color).toBe('subtle')
      expect(await ui.find({ type: 'Button', key: 'agents:stop:session/a1' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'agents:send:session/a1' })).toBeDefined()
      if (surface === 'mobile') expect(await ui.find({ type: 'Text', text: 'messages are typed on the terminal or the desktop' })).toBeDefined()
      else {
        const input = await ui.find({ type: 'Input', key: w.views.at(-1)!.body!.composer!.key })
        expect(input?.props).toEqual(expect.objectContaining({ label: 'To reviewer', placeholder: 'message' }))
        expect(await ui.find({ type: 'Text', text: 'sent through the engine: it reads it at its next turn' })).toBeDefined()
      }
      // A completed agent has no [Stop].
      await pressRow(ui, w, surface, 1, 'agents:select:session/a2')
      expect(await ui.find({ type: 'Button', key: 'agents:stop:session/a2' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: "its transcript can't be read here" })).toBeDefined()
    })
  }

  test("an empty session names the next step", async ($, on) => {
    world(on, {}, {}, [])
    await run($, 'agents')
    const ui = await mountAgents($, 'terminal')
    expect(await ui.find({ type: 'Text', text: 'no agent in this session yet: ' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '/litter swarms' }))?.props.color).toBe('suggestion')
  })
})

describe('[Send] and [Stop]', () => {
  test("[Send]'s press reaches $.session.send with the text typed and answers `{ element }`; the notice says queued", async ($, on) => {
    const w = world(on)
    await run($, 'agents')
    const ui = await mountAgents($, 'terminal')
    await pressRow(ui, w, 'terminal', 0, 'agents:select:session/a1')
    const key = w.views.at(-1)?.body?.composer?.key
    expect(key).toMatch(/^agents:text:\d+$/)
    expect(await ui.input({ key: key!, text: 'look at compile.ts:88 again', kind: 'change' })).toEqual(expect.objectContaining({ element: key, value: 'look at compile.ts:88 again' }))
    expect(await ui.press({ key: 'agents:send:session/a1' })).toEqual(expect.objectContaining({ element: 'agents:send:session/a1' }))
    expect(w.sent.map(s => s.text)).toEqual(['look at compile.ts:88 again'])
    expect(JSON.stringify(w.sent[0]!.to)).toContain('a1')
    expect(await ui.find({ type: 'Text', text: '✓ queued for reviewer: it reads it at its next turn' })).toBeDefined()
  })

  test('[Stop] armed: its second press within 5 s calls TaskStop; while armed [Send] is no longer primary', async ($, on) => {
    const w = world(on)
    await run($, 'agents')
    const ui = await mountAgents($, 'terminal')
    await pressRow(ui, w, 'terminal', 0, 'agents:select:session/a1')
    expect((await ui.find({ type: 'Button', key: 'agents:send:session/a1' }))?.props.variant).toBe('primary')
    await ui.press({ key: 'agents:stop:session/a1' })
    expect(await ui.find({ type: 'Text', text: '[Stop] again to stop reviewer' })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'agents:stop:session/a1' }))?.props.variant).toBe('primary')
    expect((await ui.find({ type: 'Button', key: 'agents:send:session/a1' }))?.props.variant).toBeUndefined()
    expect(w.calls).toEqual([])
    await ui.press({ key: 'agents:stop:session/a1' })
    expect(w.calls).toEqual([{ tool: 'TaskStop', input: { task_id: 'a1' } }])
    expect(await ui.find({ type: 'Text', text: '✓ stopped reviewer: Successfully stopped task: a1' })).toBeDefined()
  })
})

describe("the roster's menu", () => {
  test('a right-click on a row offers Message, Transcript and Stop where each applies, and a pick presses it', async ($, on) => {
    const w = world(on)
    await run($, 'agents')
    const ui = await mountAgents($, 'terminal')
    await ui.pointer({ type: 'down', x: 4, y: 0, button: 'right', in: 'agents:roster' })
    for (const item of ['Message', 'Transcript', 'Stop']) expect(await ui.find({ type: 'Text', text: new RegExp(` ${item} *$`), in: 'agents:roster' })).toBeDefined()
    await ui.pointer({ type: 'down', x: 4, y: 0, button: 'right', in: 'agents:roster' })
    // Message: the row is selected, the composer writes to it.
    await menuPick(ui, w, 0, 0)
    expect(w.views.at(-1)?.body?.selected?.key).toBe('a1')
    expect(w.views.at(-1)?.body?.composer?.to).toBe('reviewer')
    // Stop, from the menu, arms it as its Button does.
    await menuPick(ui, w, 0, 2)
    expect(w.views.at(-1)?.body?.selected?.stop).toEqual({ armed: true })
    // The completed agent's menu has no Stop: Message, Transcript, close.
    await ui.pointer({ type: 'down', x: 4, y: 1, button: 'right', in: 'agents:roster' })
    expect(await ui.find({ type: 'Text', text: / Stop *$/, in: 'agents:roster' })).toBeUndefined()
    await ui.pointer({ type: 'down', x: 4, y: 1, button: 'right', in: 'agents:roster' })
    // Transcript: selected, at its newest line.
    await menuPick(ui, w, 1, 1)
    expect(w.views.at(-1)?.body?.selected?.key).toBe('a2')
  })

  test('where no Client is drawn, the focused row carries its actions as Buttons, and each press acts', async ($, on) => {
    const w = world(on)
    await run($, 'agents')
    const ui = await mountAgents($, 'vscode')
    await $.ui.focus({ component: 'Pane', requestId: 'litter', plugin: 'litter', element: 'agents:select:session/a1', origin: { kind: 'person' } })
    expect(await ui.find({ type: 'Button', key: 'agents:message:session/a1' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'agents:transcript:session/a1' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'agents:stop:session/a1' })).toBeDefined()
    await ui.press({ key: 'agents:message:session/a1' })
    expect(w.views.at(-1)?.body?.selected?.key).toBe('a1')
    await ui.press({ key: 'agents:transcript:session/a1' })
    expect(w.views.at(-1)?.body?.selected?.key).toBe('a1')
  })
})

describe("a team's view", () => {
  test('team-b: its members, writer with two unread; selected, its inbox under its heading, the composer to it and [Broadcast]', async ($, on) => {
    const w = world(on, FILES)
    expect((await run($, 'agents team-b')).text).toBe("Agents shows team team-b's 3 members")
    const ui = await mountAgents($, 'terminal')
    expect(await ui.find({ type: 'Text', text: 'team ' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'team-b' }))?.props.color).toBe('cyan_FOR_SUBAGENTS_ONLY')
    expect(await ui.find({ type: 'Text', text: '3 members' })).toBeDefined()
    expect(await rosterLines(ui)).toContainEqual(expect.stringMatching(/^writer +general-purpose +not in this session +✉ 2/))
    // With no row selected, the composer broadcasts.
    expect((await ui.find({ type: 'Input' }))?.props.label).toBe('To every member of team-b')
    expect(await ui.find({ type: 'Button', key: 'agents:broadcast:team.team-b' })).toBeDefined()
    await pressRow(ui, w, 'terminal', 1, 'agents:select:team.team-b/writer')
    expect(await ui.find({ type: 'Text', text: 'unread only' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'the spec moved: see G2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '    the log is in /tmp/g3.log' })).toBeDefined()
    expect((await ui.find({ type: 'Input' }))?.props.label).toBe('To writer')
    expect(await ui.find({ type: 'Text', text: 'appended to its inbox in team team-b: it reads it at its next turn' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: "not in this session: its transcript is its own session's" })).toBeDefined()
  })
})

describe('only teams that run (WP-DF §0)', () => {
  test("the picker lists this session and team-b, and counts the three ended teams, with [Show all]", async ($, on) => {
    const w = world(on, FILES)
    await run($, 'agents')
    const ui = await mountAgents($, 'terminal')
    expect(w.views.at(-1)?.body?.options.map(o => o.value)).toEqual(['session', 'team.team-b'])
    expect(await ui.find({ type: 'Button', key: 'agents:scope:team.team-b' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'agents:scope:team.old-1' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '3 ended teams hidden' })).toBeDefined()
    await ui.press({ key: 'agents:teams:all' })
    // Five choices: the picker is a list now, and says it's showing them all.
    expect(await ui.find({ type: 'Button', key: 'agents:scope:team.old-1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'every team shown, the ended ones too' })).toBeDefined()
    await ui.press({ key: 'agents:teams:running' })
    expect(await ui.find({ type: 'Button', key: 'agents:scope:team.old-1' })).toBeUndefined()
  })

  test('an ended team shown on purpose: one notice with its lead\'s folder and start, [This session\'s agents] primary, members "ended", no composer', async ($, on) => {
    world(on, FILES)
    expect((await run($, 'agents old-1')).text).toBe("Agents shows team old-1's 1 member")
    const ui = await mountAgents($, 'terminal')
    expect(await ui.find({ type: 'Text', text: /^! old-1 isn't running: its lead session \(\/work\/flex-web, started \d{4}-\d\d-\d\d \d\d:\d\d\) ended\. .*read by nobody\.$/ })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'agents:leave:session' }))?.props).toEqual(expect.objectContaining({ label: "This session's agents", variant: 'primary' }))
    expect(await ui.find({ type: 'Text', text: '1 member · ended' })).toBeDefined()
    // With nothing to send to and no menu to offer, the roster is Buttons, even on the terminal.
    expect(await ui.find({ type: 'Button', key: 'agents:select:team.old-1/team-lead' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '− ended' }))?.props.color).toBe('inactive')
    expect(await ui.find({ type: 'Input' })).toBeUndefined()
    await ui.press({ key: 'agents:leave:session' })
    expect(await ui.find({ type: 'Text', text: 'this session' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'agents:leave:session' })).toBeUndefined()
  })

  test("reopened with no team, a remembered team that ended isn't: the notice says so once", async ($, on) => {
    const w = world(on, FILES)
    await run($, 'agents team-b')
    expect((await run($, 'agents')).text).toBe("Agents shows team team-b's 3 members")
    // team-b's lead session ends: its registry entry goes.
    w.files.delete('/cfg/sessions/4242.json')
    expect((await run($, 'agents')).text).toBe("Agents shows this session's 2 agents")
    expect(w.views.at(-1)?.body?.notice).toEqual({ level: 'info', text: "team team-b ended, so this session's agents are shown" })
  })
})

describe('the transcript window', () => {
  test('its newest lines, the footer saying what lies above; [↑ n earlier] pages it where no wheel reaches', async ($, on) => {
    const long = Array.from({ length: 60 }, (_, i) => ({ role: 'assistant', text: `step ${i + 1}`, toolUses: [] }))
    const w = world(on, {}, { a1: long })
    await run($, 'agents')
    const ui = await mountAgents($, 'mobile', { bodyRows: 40, bodyColumns: 60 })
    await pressRow(ui, w, 'mobile', 0, 'agents:select:session/a1')
    expect(await ui.find({ type: 'Text', text: '◆ step 60' })).toBeDefined()
    const up = await ui.find({ type: 'Button', key: 'agents:lines:up' })
    expect(up?.text).toMatch(/^↑ \d+ earlier$/)
    await ui.press({ key: 'agents:lines:up' })
    expect(await ui.find({ type: 'Text', text: '◆ step 60' })).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'agents:lines:down' }))?.text).toMatch(/^↓ \d+ newer$/)
  })

  test("on the terminal the transcript's footer is one muted line, no Buttons: the wheel moves it (tier 2's onAgentsScroll; the hub routes ui.scroll to Agents once hub.ts forwards it)", async ($, on) => {
    const long = Array.from({ length: 60 }, (_, i) => ({ role: 'assistant', text: `step ${i + 1}`, toolUses: [] }))
    const w = world(on, {}, { a1: long })
    await run($, 'agents')
    const ui = await mountAgents($, 'terminal', { bodyRows: 40, bodyColumns: 100 })
    await pressRow(ui, w, 'terminal', 0, 'agents:select:session/a1')
    const footer = await ui.find({ type: 'Text', text: /^↑ \d+ earlier$/ })
    expect(footer?.props.color).toBe('inactive')
    expect(await ui.find({ type: 'Button', key: 'agents:lines:up' })).toBeUndefined()
  })
})

/** The body as drawn: its first line to its last, the hub's chrome left out; a time and a day as placeholders, since they're the zone's. */
function bodyOf(rows: readonly string[], first: string, last: string): string[] {
  const from = rows.findIndex(r => r.startsWith(first))
  const to = rows.findIndex((r, i) => i >= from && r.includes(last))
  return rows.slice(from, to + 1).map(r => r.replace(/\d{4}-\d\d-\d\d/g, 'YYYY-MM-DD').replace(/\b\d\d:\d\d\b/g, 'HH:MM'))
}

/** Rows with the colors beside each, as drawWithColors writes them. */
const golden = (columns: number, rows: readonly [string, string][]): string[] => rows.map(([text, colors]) => (colors === '' ? text : `${text.padEnd(columns)}  | ${colors}`))
/** A heading: its title, the faint rule, its note and the rule's tail (chrome.tsx's heading). */
const ruled = (title: string, columns: number, note?: string): string =>
  note === undefined ? `${title} ${'─'.repeat(columns - title.length - 1)}` : `${title} ${'─'.repeat(columns - title.length - note.length - 5)} ${note} ──`
const HEADING = 'suggestion bold, subtle, inactive, subtle'
const NAMED = 'suggestion bold, cyan_FOR_SUBAGENTS_ONLY bold, subtle, inactive, subtle'
/** The composer's field in its frame (the terminal's). */
const framed = (text: string, columns: number): [string, string][] => [
  [`╭${'─'.repeat(columns - 2)}╮`, 'promptBorder'],
  [`│ ${text.padEnd(columns - 4)} │`, 'promptBorder, default, default dim, promptBorder'],
  [`╰${'─'.repeat(columns - 2)}╯`, 'promptBorder'],
]

/**
 * The drawings in WP-DF's report, each row's colors beside it: this
 * session's agents with reviewer selected (its transcript the engine's
 * wrapped messages in words, its tools in two colors), and team-b with
 * writer's unread mail. The roster is the list's Client, drawn by its
 * module (ui/listmenu.tsx), each cell in its color: the type muted, the
 * status in its own.
 */
const SESSION_ROWS = (columns: number): [string, string][] => [
  [ruled('this session', columns, '2 agents · 1 running'), HEADING],
  columns >= 100
    ? ['› reviewer general-purpose ▸ running    › from checker: G3 too, please', 'claude, default bold, inactive bold, background bold, inactive']
    : ['› reviewer general-purpose ▸ running', 'claude, default bold, inactive bold, background bold'],
  ['  fix G2   Explore         ✓ completed', 'default, inactive, success'],
  [columns >= 100 ? '  right-click a row for its actions' : '  › from checker: G3 too, please', 'inactive'],
  ['[ Stop ]', 'default dim'],
  [ruled('Inbox · reviewer', columns, 'unread only'), NAMED],
  ["no inbox: it isn't in a team", 'inactive'],
  [ruled('Transcript · reviewer', columns, '5 lines'), NAMED],
  ['› from team-lead: review the parser in compile.ts', 'inactive, cyan_FOR_SUBAGENTS_ONLY, inactive'],
  ['◆ found the bug in compile.ts', 'default'],
  ['↳ Bash npm test', 'subtle, text bold, inactive'],
  ['↳ Read /work/me/compile.ts', 'subtle, text bold, suggestion'],
  ['› from checker: G3 too, please', 'inactive, cyan_FOR_SUBAGENTS_ONLY, inactive'],
  ...framed('To reviewer: message', columns),
  ['sent through the engine: it reads it at its next turn', 'inactive'],
  ['[ Send ]', 'claude'],
]

const TEAM_ROWS = (columns: number): [string, string][] => [
  [ruled('team team-b', columns, '3 members'), NAMED],
  // At 60 columns the strip takes two rows (eight tabs, WP-DH), so in 30 the picker folds to its one line.
  ...(columns >= 100
    ? ([
        ['Show [ this session ] [ team-b ]', 'inactive, default dim, claude'],
        ['3 ended teams hidden [ Show all ]', 'inactive, default dim'],
      ] as [string, string][])
    : ([['Show team-b · 1 other, 3 ended hidden [ Change ]', 'inactive, cyan_FOR_SUBAGENTS_ONLY, inactive, default dim']] as [string, string][])),
  ['  team-lead team-lead       not in this session', 'default, inactive'],
  ['› writer    general-purpose not in this session ✉ 2', 'claude, default bold, inactive bold, warning bold'],
  ['  checker   Explore         not in this session', 'default, inactive'],
  ['  right-click a row for its actions', 'inactive'],
  [ruled('Inbox · writer', columns, 'unread only'), NAMED],
  ['team-lead · HH:MM · the spec moved: see G2', 'cyan_FOR_SUBAGENTS_ONLY, inactive, default'],
  ['checker   · HH:MM · G3 fails on main', 'cyan_FOR_SUBAGENTS_ONLY, inactive, default'],
  ['    the log is in /tmp/g3.log', 'default'],
  [ruled('Transcript · writer', columns), 'suggestion bold, cyan_FOR_SUBAGENTS_ONLY bold, subtle'],
  ["not in this session: its transcript is its own session's", 'inactive'],
  ...framed('To writer: message', columns),
  [columns >= 100 ? 'appended to its inbox in team team-b: it reads it at its next turn' : 'appended to its inbox in team team-b: it reads it at its ne…', 'inactive'],
  ['[ Send ] [ Broadcast to team-b ]', 'claude, default dim'],
]

describe('the drawings', () => {
  for (const columns of [100, 60]) {
    test(`this session at ${columns} columns, docked in 40 rows, reviewer selected: the body keeps to its rows, the keys line under it`, async ($, on) => {
      const w = world(on)
      await run($, 'agents')
      const ui = await mountAgents($, 'terminal', { bodyColumns: columns, bodyRows: 40 })
      await pressRow(ui, w, 'terminal', 0, 'agents:select:session/a1')
      const rows = await drawn(ui, columns, true)
      expect(bodyOf(rows, 'this session', '[ Send ]')).toEqual(golden(columns, SESSION_ROWS(columns)))
      expect(rows.at(-1)).toMatch(/^ctrl\+x tab gives the pane the keys/)
    })

    test(`this session at ${columns} columns, inline`, async ($, on) => {
      const w = world(on)
      await run($, 'agents')
      const ui = await mountAgents($, 'terminal', { bodyColumns: columns, placement: 'inline' })
      await pressRow(ui, w, 'terminal', 0, 'agents:select:session/a1')
      expect(bodyOf(await drawn(ui, columns, true), 'this session', '[ Send ]')).toEqual(golden(columns, SESSION_ROWS(columns)))
    })

    test(`team-b at ${columns} columns, docked in 30 rows, writer selected`, async ($, on) => {
      const w = world(on, FILES)
      await run($, 'agents team-b')
      const ui = await mountAgents($, 'terminal', { bodyColumns: columns, bodyRows: 30 })
      await pressRow(ui, w, 'terminal', 1, 'agents:select:team.team-b/writer')
      expect(bodyOf(await drawn(ui, columns, true), 'team team-b', '[ Send ]')).toEqual(golden(columns, TEAM_ROWS(columns)))
    })

    test(`a long transcript at ${columns} columns in a short dock: the roster, the window and its footer, and the composer all fit`, async ($, on) => {
      const long = Array.from({ length: 60 }, (_, i) => ({ role: 'assistant', text: `step ${i + 1}`, toolUses: [] }))
      const w = world(on, {}, { a1: long })
      await run($, 'agents')
      const ui = await mountAgents($, 'terminal', { bodyColumns: columns, bodyRows: 24 })
      await pressRow(ui, w, 'terminal', 0, 'agents:select:session/a1')
      const rows = await drawn(ui, columns)
      const body = bodyOf(rows, 'this session', '[ Send ]')
      expect(body.at(-1)).toBe('[ Send ]')
      expect(body).toContain('◆ step 60')
      expect(body.some(r => /^↑ \d+ earlier$/.test(r))).toBe(true)
      expect(rows.at(-1)).toMatch(/^ctrl\+x tab gives the pane the keys/)
    })
  }
})

/**
 * A swarm node selected (WP-DF): in the inbox's place its messages from the
 * launch ledger. The view is fed to the pane through a state.get hook
 * beneath, as swarm-panes.test.tsx feeds its own, since a swarm's binding
 * isn't this test's world.
 */
function nodeView(): AgentsPaneView {
  const messages = [
    { from: 'port', to: 'lead', at: '03:52', line: 'port, on codex-rs/core: the session loop now builds and its tests pass' },
    { from: 'implementer', to: 'port', at: '03:55', line: 'the sandbox crate next, please' },
    { from: 'lead', to: 'implementer', at: '03:58', line: 'hold until port reports' },
  ]
  return {
    view: 'agents',
    v: 1,
    body: {
      head: { team: null, note: '1 agent · 1 running' },
      notice: null,
      ended: null,
      scope: 'session',
      options: [{ value: 'session', label: 'this session', members: null, active: true, description: '' }],
      hiddenTeams: 0,
      showAll: false,
      picking: false,
      rows: [
        {
          key: 'a-port',
          name: 'port',
          type: 'litter:sw-codex-port',
          status: { text: 'running', glyph: '▸', color: 'background' },
          unread: null,
          description: '',
          can: { message: true, transcript: true, stop: true },
          swarm: { name: 'codex', said: '' },
        },
      ],
      hiddenRows: 0,
      selected: {
        key: 'a-port',
        name: 'port',
        inbox: null,
        transcript: { readable: true, lines: [], total: 0 },
        sendNote: 'sent through the engine: it reads it at its next turn',
        stop: null,
        swarm: { name: 'codex', node: 'port', messages, hidden: 2, error: null },
      },
      composer: { key: 'agents:text:0', text: '', to: 'port' },
      broadcast: null,
      problems: [],
    },
  }
}

describe("a swarm node's messages", () => {
  for (const [columns, from, to] of [
    [100, 'implementer', 'implementer'],
    [40, 'impleme…', 'impleme…'],
  ] as const) {
    test(`at ${columns} columns: each one line, the names whole or cut in their own columns, never wrapped`, async ($, on) => {
      world(on)
      const view = nodeView()
      on('state.get', async (_$, e, next) => {
        if (e.key === 'hub') return { value: { value: { view: 'hub', v: 1, section: 'agents', live: [], tabs: [] }, version: 0 } }
        if (e.key === 'agentsPane') return { value: { value: view, version: 0 } }
        return next(e)
      })
      const ui = await mountAgents($, 'terminal', { bodyColumns: columns, bodyRows: 40 })
      const rows = drawText(await ui.drawn(), columns)
      const at = rows.findIndex(r => r.startsWith('Messages · port'))
      const end = rows.findIndex(r => r.startsWith('[ Open in Swarms ]'))
      expect(at).toBeGreaterThanOrEqual(0)
      const shown = rows.slice(at + 1, end).map(r => r.trimEnd())
      const w = from.length
      expect(shown).toHaveLength(4)
      expect(shown[0]).toBe('2 earlier not shown')
      expect(shown[1]).toStartWith(`${'port'.padEnd(w)} → ${'lead'.padEnd(w)} · 03:52 · port, on`)
      expect(shown[2]).toStartWith(`${from} → ${'port'.padEnd(w)} · 03:55 · the sand`)
      expect(shown[3]).toBe(`${'lead'.padEnd(w)} → ${to} · 03:58 · ${columns >= 100 ? 'hold until port reports' : 'hold unti…'}`)
      for (const r of shown) expect(r.length).toBeLessThanOrEqual(columns)
      expect((await ui.find({ type: 'Text', text: from }))?.props.color).toBe('cyan_FOR_SUBAGENTS_ONLY')
    })
  }
})
