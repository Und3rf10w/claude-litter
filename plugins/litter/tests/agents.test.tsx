// Tier 1: the Agents section as the engine runs it (WP-CG, phase 5b's WP-DA):
// /litter agents opens the `litter` pane on Agents, asking for the keyboard,
// and writes its view; the render draws this session's agents
// with their status and, once one is selected, its inbox, its transcript's
// tail, [Stop] and the composer, on every surface (the mobile app with no
// fields); and [Send]'s press reaches $.session.send and answers
// `{ element }`. The agents come from an agent.list hook beneath, the
// transcript from a session.messages hook. CE's store is whatever store.ts
// is in the tree, over an empty config dir and an empty $.fs, so no real
// ~/.claude/ is read and no team rows are expected here (tier 2 covers the
// teams through `deps`).

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { AgentsPaneView } from '../types/index'

const SESSION = 'tier1-session'
const NOW = 1_800_000_000_000
const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const pane = (title: string) =>
  ({ title, isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }) as const

/** `/litter <args>`. */
const run = ($: Engine, args = '') =>
  $.command.run({ command: 'litter', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

const AGENTS = [
  { id: 'a1', description: 'review the parser', type: 'general-purpose', status: 'running', name: 'reviewer' },
  { id: 'a2', description: 'fix G2', type: 'Explore', status: 'completed' },
] as const

const TRANSCRIPT = [
  { role: 'user', text: 'review the parser', toolUses: [] },
  { role: 'assistant', text: 'found the bug in compile.ts', toolUses: [] },
  { role: 'assistant', text: '', toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'npm test' } }] },
] as const

/** The engine around the pane: what opened, what was sent, the agents pane's views as written. */
function world(on: On): { opened: { id: string; focus: boolean }[]; sent: { to: unknown; text: string }[]; views: AgentsPaneView[] } {
  const opened: { id: string; focus: boolean }[] = []
  const sent: { to: unknown; text: string }[] = []
  const views: AgentsPaneView[] = []
  on('agent.list', async () => ({ value: AGENTS.map(a => ({ ...a })) }))
  on('session.messages', async (_$, e) => ({ value: e.agentId === 'a1' ? TRANSCRIPT.map(m => ({ ...m, toolUses: [...m.toolUses] })) : { deny: `no transcript for ${e.agentId}` } }) as never)
  on('session.id', async () => ({ value: SESSION }))
  on('session.send', async (_$, e) => {
    sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('ui.open', async (_$, e) => {
    opened.push({ id: e.id, focus: e.focus === true })
    return { value: { isPlaced: true } }
  })
  on('ui.toast', async () => ({ value: undefined }))
  on('ui.log', async () => ({ value: undefined }))
  on('state.set', async (_$, e, next) => {
    if (e.key === 'agentsPane') views.push(e.value as AgentsPaneView)
    return next(e)
  })
  // An empty $.fs under a config dir of the test's own: nothing outside the test is read or written.
  on('fs.exists', async () => ({ value: false }))
  on('fs.read', async (_$, e) => {
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.list', async (_$, e) => {
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.stat', async (_$, e) => {
    throw new Error(`ENOENT: ${e.path}`)
  })
  on('fs.write', async (_$, e) => {
    throw new Error(`nothing is written in this test: ${e.path}`)
  })
  on('process.run', async () => ({ value: { exitCode: 1, stdout: '', stderr: 'not in this test', isStdoutTruncated: false, isStderrTruncated: false } }))
  mock.env(on, { CLAUDE_CONFIG_DIR: '/tier1-config', HOME: '/home/tier1' })
  mock.store(on)
  mock.clock(on, { now: NOW })
  return { opened, sent, views }
}

const mountAgents = <S extends (typeof SURFACES)[number]>($: Engine, surface: S) =>
  $.ui.mount({ plugin: 'litter', surface, component: 'Pane', requestId: 'litter', props: pane('litter') })

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
    test(`draws the rows, then the selected agent's inbox, transcript, [Stop] and composer, on the ${surface}`, async ($, on) => {
      const w = world(on)
      await run($, 'agents')
      const ui = await mountAgents($, surface)
      // The hub's header names the section; Agents' own title follows in the body.
      expect(await ui.find({ type: 'Text', text: ' · Agents' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^ · this session · 2 agents · 1 running$/ })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'agents:select:session/a1' }))?.text).toBe('reviewer')
      expect((await ui.find({ type: 'Button', key: 'agents:select:session/a2' }))?.text).toBe('fix G2')
      expect(await ui.find({ type: 'Text', text: '▸ running' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '✓ completed' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Explore' })).toBeDefined()
      // The picker: a Select where the surface draws one, a button per choice elsewhere.
      if (surface === 'mobile') expect(await ui.find({ type: 'Button', key: 'agents:scope:session' })).toBeDefined()
      else expect(await ui.find({ type: 'Select', key: 'agents:scope' })).toBeDefined()

      expect(await ui.press({ key: 'agents:select:session/a1' })).toEqual(expect.objectContaining({ element: 'agents:select:session/a1' }))
      expect(await ui.find({ type: 'Text', text: "no inbox: only a team's members have one" })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '◆ found the bug in compile.ts' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '↳ Bash npm test' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'agents:stop:session/a1' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'agents:send:session/a1' })).toBeDefined()
      if (surface === 'mobile') expect(await ui.find({ type: 'Text', text: 'messages are typed on the terminal or the desktop' })).toBeDefined()
      else expect(await ui.find({ type: 'Input', key: w.views.at(-1)!.body!.composer!.key })).toBeDefined()
      // A completed agent has no [Stop].
      await ui.press({ key: 'agents:select:session/a2' })
      expect(await ui.find({ type: 'Button', key: 'agents:stop:session/a2' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: "its transcript can't be read here" })).toBeDefined()
    })
  }
})

describe('[Send]', () => {
  test("its press reaches $.session.send with the text typed and answers `{ element }`; the notice says queued", async ($, on) => {
    const w = world(on)
    await run($, 'agents')
    const ui = await mountAgents($, 'terminal')
    await ui.press({ key: 'agents:select:session/a1' })
    const key = w.views.at(-1)?.body?.composer?.key
    expect(key).toMatch(/^agents:text:\d+$/)
    expect(await ui.input({ key: key!, text: 'look at compile.ts:88 again', kind: 'change' })).toEqual(expect.objectContaining({ element: key, value: 'look at compile.ts:88 again' }))
    expect(await ui.press({ key: 'agents:send:session/a1' })).toEqual(expect.objectContaining({ element: 'agents:send:session/a1' }))
    expect(w.sent.map(s => s.text)).toEqual(['look at compile.ts:88 again'])
    expect(JSON.stringify(w.sent[0]!.to)).toContain('a1')
    expect(await ui.find({ type: 'Text', text: '✓ queued for reviewer: it reads it at its next turn' })).toBeDefined()
  })
})
