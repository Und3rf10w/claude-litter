// Tier 2: the Stats section (phase 5b, WP-DH). A swarm's spend is how far the
// session's cost total grew while it was live here (swarm/state.ts's
// noteSpend): counted from its first reading, on through a reading in the
// same session, carried over a /clear's new session and a ledger that began
// again; none for a swarm another session owns; kept in its part in $.store
// and read back. The lead's tokens count for each swarm live as its turn
// ends. The view puts every figure in words: the session's spend, context
// and limits, each swarm's spend "since launch" (or since its first
// reading), its tokens apart (cache reads apart from input), a row for the
// lead and one per node in the tree's order; the table's numbers align
// right. /litter stats draws it; a session.measure redraws it only while
// it's shown; [Open in Swarms] opens Swarms on its swarm.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { SessionUsage } from '../../hooks/ports'
import type { StatsPaneView } from '../../types/index'
import * as state from '../../hooks/swarm/state'
import type { LiveSwarm, NodeBinding } from '../../hooks/swarm/types'
import { measureSpend } from '../../hooks/stats/spend'
import { sessionStats, statsBody, swarmStats, tokenWords, usd } from '../../hooks/stats/view'
import { loadStats, onStatsUi, openSwarmKey, resetStatsPaneForTests, statsMeasured, tableCells } from '../../hooks/stats/pane'
import { openSection, resetHubForTests, sections } from '../../hooks/ui/hub'
import { nodePorts, type TestPorts } from './support/node-ports'

const T0 = Date.parse('2026-10-07T09:00:00Z')

let p: TestPorts

const swarmOf = (over: Partial<LiveSwarm> = {}): LiveSwarm => ({
  name: 'alpha',
  launch: '20261007-090000',
  revision: 1,
  spec: {
    name: 'alpha',
    goal: 'port the loop',
    nodes: [
      { id: 'boss', kind: 'orchestrator', spawns: { port: 2 } },
      { id: 'port', kind: 'worker', worktree: 'own' },
    ],
  },
  nonce: 'n0nce',
  types: { boss: 'litter:sw-alpha-boss', port: 'litter:sw-alpha-port' },
  typesReady: true,
  dirs: {},
  sessionCwd: '/repo',
  worktreeRoot: '/repo/.claude/worktrees',
  commonDir: '/repo/.git',
  roots: { litterDir: '/repo/.claude/litter', litterCopies: ['/repo/.claude/litter'], ruleDirs: [] },
  tips: {},
  owner: { ref: 'refs/litter-swarm/alpha', oid: 'a'.repeat(40), generation: 1, session: 'test-session' },
  state: 'live',
  readOnly: false,
  lost: false,
  flags: { isolationLost: false },
  startedAt: T0,
  ...over,
})

const bindingOf = (agentId: string, over: Partial<NodeBinding> = {}): NodeBinding => ({
  agentId,
  swarm: 'alpha',
  launch: '20261007-090000',
  node: 'port',
  n: 1,
  kind: 'worker',
  of: null,
  parent: 'a-boss',
  type: 'litter:sw-alpha-port',
  cwd: '/repo',
  branch: null,
  token: `tok-${agentId}`,
  revision: 1,
  generation: 1,
  boundAt: T0,
  adopted: false,
  ...over,
})

const usage = (usd?: number, over: Partial<SessionUsage> = {}): SessionUsage => ({
  startedAt: T0,
  context: { tokens: 45_000, window: 200_000, percent: 22 },
  rateLimits: [],
  ...(usd === undefined ? {} : { cost: { usd } }),
  ...over,
})

const turnUsage = (input: number, cacheRead: number, cacheWrite: number, output: number) => ({
  input_tokens: input,
  cache_read_input_tokens: cacheRead,
  cache_creation_input_tokens: cacheWrite,
  output_tokens: output,
  model: 'claude-opus-5-5',
})

function live(over: Partial<LiveSwarm> = {}): void {
  state.putLiveSwarm(swarmOf(over))
  state.putBinding(bindingOf('a-boss', { node: 'boss', kind: 'orchestrator', parent: null, type: 'litter:sw-alpha-boss' }))
  state.putBinding(bindingOf('a-port'))
}

beforeEach(() => {
  state.resetForTests()
  resetStatsPaneForTests()
  resetHubForTests()
  p = nodePorts()
  p.clock.now = T0
})

afterEach(() => {
  state.resetForTests()
  resetStatsPaneForTests()
  resetHubForTests()
})

describe("a swarm's spend", () => {
  test('counted from its first reading; a later one in the same session moves it on', () => {
    live()
    expect(state.spent('alpha')).toBeNull()
    state.noteSpend('s1', 2.5, T0)
    expect(state.spent('alpha')).toEqual({ usd: 0, since: T0 })
    state.noteSpend('s1', 4, T0 + 60_000)
    expect(state.spent('alpha')).toEqual({ usd: 1.5, since: T0 })
  })

  test("a /clear's new session, and a ledger that began again, carry what it had", () => {
    live()
    state.noteSpend('s1', 2, T0)
    state.noteSpend('s1', 5, T0)
    // /clear: a new session id, its own total.
    state.noteSpend('s2', 0.5, T0)
    state.noteSpend('s2', 1.5, T0)
    expect(state.spent('alpha')?.usd).toBeCloseTo(4)
    // A restart whose ledger began again: the total went back.
    state.noteSpend('s2', 0.25, T0)
    state.noteSpend('s2', 0.75, T0)
    expect(state.spent('alpha')?.usd).toBeCloseTo(4.5)
    expect(state.spent('alpha')?.since).toBe(T0)
  })

  test('a swarm another session owns, or one lost to it, has none; a figure that is no count changes nothing', () => {
    live({ readOnly: true })
    state.putLiveSwarm(swarmOf({ name: 'beta', lost: true }))
    state.noteSpend('s1', 3, T0)
    expect(state.spent('alpha')).toBeNull()
    expect(state.spent('beta')).toBeNull()
    state.putLiveSwarm(swarmOf({ name: 'gamma' }))
    state.noteSpend('s1', Number.NaN, T0)
    state.noteSpend('s1', -1, T0)
    expect(state.spent('gamma')).toBeNull()
  })

  test("measureSpend reads the session's usage and notes its total; none where the host keeps no ledger; a usage that can't be read is logged", async () => {
    live()
    p.usageValue = usage(7.25)
    expect((await measureSpend(p))?.cost?.usd).toBe(7.25)
    expect(state.spent('alpha')).toEqual({ usd: 0, since: T0 })
    p.usageValue = usage(9.5)
    await measureSpend(p)
    expect(state.spent('alpha')?.usd).toBeCloseTo(2.25)
    p.usageValue = usage(undefined)
    await measureSpend(p)
    expect(state.spent('alpha')?.usd).toBeCloseTo(2.25)
    p.usageValue = null
    expect(await measureSpend(p)).toBeNull()
    expect(p.logs).toContain("the session's usage couldn't be read: no usage in tier 2 (usageValue is null)")
  })

  test("kept in the swarm's part in $.store with the lead's tokens, and read back", async () => {
    state.attach(p, '/repo/.claude/litter')
    live()
    state.noteSpend('s1', 1, T0)
    state.noteSpend('s1', 3, T0)
    state.addLeadTokens(turnUsage(100, 9_000, 400, 50))
    await state.flushed()
    const key = state.swarmStateKey('/repo/.claude/litter', 'alpha')
    expect(p.storeMap.get(key)).toEqual(
      expect.objectContaining({ spend: { session: 's1', base: 1, seen: 3, carried: 0, since: T0 }, lead: { input: 100, output: 50, cacheRead: 9_000, cacheCreation: 400, turns: 1 } }),
    )
    state.resetForTests()
    expect(state.spent('alpha')).toBeNull()
    await state.loadSwarm(p, '/repo/.claude/litter', 'alpha')
    expect(state.spent('alpha')).toEqual({ usd: 2, since: T0 })
    expect(state.leadTokens('alpha')).toEqual({ input: 100, output: 50, cacheRead: 9_000, cacheCreation: 400, turns: 1 })
  })

  test('a part whose spend is malformed reads back without one', async () => {
    const key = state.swarmStateKey('/repo/.claude/litter', 'alpha')
    await p.store.set(key, { v: 1, swarm: swarmOf(), bindings: [], spend: { session: 's1', base: 'x', seen: 1, carried: 0, since: T0 }, lead: { input: -1 } })
    await state.loadSwarm(p, '/repo/.claude/litter', 'alpha')
    expect(state.spent('alpha')).toBeNull()
    expect(state.leadTokens('alpha').turns).toBe(0)
  })
})

describe("the lead's tokens", () => {
  test('each lead turn counts for every swarm owned here that is live as it ends; an interrupted one is a turn with none', () => {
    live()
    state.putLiveSwarm(swarmOf({ name: 'theirs', readOnly: true }))
    state.addLeadTokens(turnUsage(10, 1_000, 20, 5))
    state.addLeadTokens(undefined)
    expect(state.leadTokens('alpha')).toEqual({ input: 10, output: 5, cacheRead: 1_000, cacheCreation: 20, turns: 2 })
    expect(state.leadTokens('theirs').turns).toBe(0)
  })
})

describe('the view', () => {
  test('dollars to the cent, grouped by thousands', () => {
    expect(usd(0)).toBe('$0.00')
    expect(usd(0.004)).toBe('$0.00')
    expect(usd(8.1)).toBe('$8.10')
    expect(usd(1234.567)).toBe('$1,234.57')
    expect(usd(-3)).toBe('$0.00')
  })

  test("the session's figures in words: its spend, its context, each limit with its color by how full", () => {
    const s = sessionStats(
      usage(12.345, {
        rateLimits: [
          { kind: 'five_hour', percentUsed: 23.5, resetsAt: new Date(T0 + 3_600_000).toISOString() },
          { kind: 'seven_day', percentUsed: 75 },
          { kind: 'spend_limit', percentUsed: 92 },
          { kind: 'some_new_window', percentUsed: 1 },
        ],
      }),
      T0,
    )
    expect(s.spend).toBe('$12.35')
    expect(s.context).toBe('45k of 200k tokens · 22%')
    expect(s.limits.map(l => [l.label, l.used, l.color])).toEqual([
      ['5-hour', '23.5%', 'text'],
      ['7-day', '75%', 'warning'],
      ['spend limit', '92%', 'error'],
      ['some new window', '1%', 'text'],
    ])
    expect(s.limits[0]!.resets).toMatch(/^\d\d:\d\d$/)
    expect(s.limits[1]!.resets).toBeNull()
    expect(sessionStats(usage(undefined, { context: { window: 200_000 } }), T0)).toEqual({ spend: null, context: null, limits: [] })
    expect(sessionStats(null, T0)).toEqual({ spend: null, context: null, limits: [] })
  })

  test("a swarm: its spend since launch, its tokens with cache reads apart, the lead's row then each node's in the tree's order", () => {
    live()
    state.noteSpend('s1', 1, T0 + 5_000)
    state.noteSpend('s1', 9.1, T0 + 5_000)
    state.addLeadTokens(turnUsage(1_000, 50_000, 2_000, 500))
    state.addTokens('a-boss', turnUsage(2_000, 1_200_000, 30_000, 4_000), 't1')
    state.addTokens('a-port', turnUsage(300_000, 12_000_000, 600_000, 120_000), 't2')
    const s = swarmStats(state.liveSwarm('alpha')!, new Map(), T0 + 2 * 3_600_000 + 14 * 60_000, 0)
    expect(s.state).toEqual({ text: '▸ live 2h 14m', color: 'background' })
    expect(s.spend).toBe('$8.10 since launch')
    expect(s.spendNote).toBe("the session's whole spend since launch, the lead's and every agent's")
    expect(s.tokens).toEqual({ input: '303k', cacheRead: '13.3M', cacheWrite: '632k', output: '125k', turns: 3 })
    expect(s.rows.map(r => [r.key, r.name, r.tokens.cacheRead, r.tokens.turns])).toEqual([
      ['lead', 'lead', '50k', 1],
      ['a-boss', 'boss', '1.2M', 1],
      ['a-port', '  port', '12.0M', 1],
    ])
    expect(s.hiddenRows).toBe(0)
  })

  test('a swarm launched before litter counted is counted from its first reading; another live swarm counts the same spend, and its note says so', () => {
    live()
    state.putLiveSwarm(swarmOf({ name: 'beta' }))
    state.noteSpend('s1', 2, T0 + 3_600_000)
    const s = swarmStats(state.liveSwarm('alpha')!, new Map(), T0 + 2 * 3_600_000, 1)
    expect(s.spend).toMatch(/^\$0\.00 since \d\d:\d\d$/)
    expect(s.spendNote).toMatch(/^the session's whole spend since \d\d:\d\d, the lead's and every agent's; the other live swarm counts it too$/)
    expect(swarmStats(state.liveSwarm('alpha')!, new Map(), T0, 2).spendNote).toMatch(/the 2 other live swarms count it too$/)
  })

  test("no reading yet: no spend, and the note says when one shows; a stopping swarm says so in the warning's color", () => {
    live({ state: 'stopping' })
    const s = swarmStats(state.liveSwarm('alpha')!, new Map(), T0 + 90_000, 0)
    expect(s.spend).toBeNull()
    expect(s.spendNote).toBe('not read yet: it shows once the session reports its cost')
    expect(s.state).toEqual({ text: '! stopping 1m', color: 'warning' })
  })

  test('the body: the swarms owned here only, and what could not be read', () => {
    live()
    state.putLiveSwarm(swarmOf({ name: 'theirs', readOnly: true }))
    const b = statsBody(usage(1), [], T0, ['the agent list broke'])
    expect(b.swarms.map(s => s.name)).toEqual(['alpha'])
    expect(b.problems).toEqual(['the agent list broke'])
  })

  test("the table: a head, then a row each, every count padded so the numbers align right; the turns muted", () => {
    live()
    state.addTokens('a-port', turnUsage(300_000, 12_000_000, 600_000, 120_000), 't2')
    const cells = tableCells(swarmStats(state.liveSwarm('alpha')!, new Map(), T0, 0))
    expect(cells.map(r => r.map(c => c.text).join('|'))).toEqual([
      '||turns|input|cache read|cache write|output',
      // The lead between turns; the nodes the agent list doesn't show, stopped.
      '·|lead|    0|    0|         0|          0|     0',
      '−|boss|    0|    0|         0|          0|     0',
      '−|  port|    1| 300k|     12.0M|       600k|  120k',
      ' |total|    1| 300k|     12.0M|       600k|  120k',
    ])
    expect(cells[0]!.slice(2).every(c => c.color === 'inactive')).toBe(true)
    expect(cells[1]![2]!.color).toBe('inactive')
    // A worker takes its orchestrator's color, the first one's here.
    expect(cells[3]![1]!.color).toBe('blue_FOR_SUBAGENTS_ONLY')
    expect(cells[4]!.slice(1).every(c => c.bold === true)).toBe(true)
    expect(tokenWords({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, turns: 0 }).input).toBe('0')
  })
})

describe('the section', () => {
  const view = (): StatsPaneView => p.views.stats as StatsPaneView

  test("/litter stats draws it: the session's spend and the live swarms in its reply", async () => {
    live()
    p.usageValue = usage(3.5)
    expect(await loadStats(p)).toEqual({ text: "Stats shows this session's $3.50 and 1 live swarm" })
    expect(view().view).toBe('stats')
    expect(view().body?.session.spend).toBe('$3.50')
    expect(view().body?.swarms[0]?.spend).toBe('$0.00 since launch')
    p.usageValue = null
    await loadStats(p)
    expect(view().body?.problems).toEqual(["the session's usage couldn't be read: the debug log has why"])
  })

  test('a session.measure redraws it from its figures only while Stats is shown in an open pane', async () => {
    p.usageValue = usage(1)
    await loadStats(p)
    const v = view().v
    await statsMeasured(p, usage(2))
    expect(view().v).toBe(v)
    await openSection(p, 'stats')
    expect(view().v).toBe(v + 1)
    await statsMeasured(p, usage(2))
    expect(view().v).toBe(v + 2)
    expect(view().body?.session.spend).toBe('$2.00')
    // Nothing moved: no write.
    await statsMeasured(p, usage(2))
    expect(view().v).toBe(v + 2)
  })

  test('[Open in Swarms] shows Swarms on its swarm; a key not its own passes on', async () => {
    const loads: unknown[] = []
    const real = sections.swarms
    sections.swarms = { ...real, load: async (_q, arg) => (loads.push(arg), { text: 'Swarms shows alpha beta' }) }
    try {
      const press = (element: string) => onStatsUi.press(p, { element } as never, (async (e: { element: string }) => ({ element: `next ${e.element}` })) as never)
      expect(await press(openSwarmKey('alpha beta'))).toEqual({ element: openSwarmKey('alpha beta') })
      expect(loads).toEqual(['alpha beta'])
      expect(await press('agents:x')).toEqual({ element: 'next agents:x' })
    } finally {
      sections.swarms = real
    }
  })
})
