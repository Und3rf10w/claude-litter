// Tier 2: the live state's 2b-2 parts (hooks/swarm/state.ts; WP-V): the
// repair budget's counters (spawns by reservation key, rounds by verify id),
// their mirror to $.store and their reset, and whether the session is
// interactive, from session.start and from each prompt origin.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as state from '../../hooks/swarm/state'
import type { LiveSwarm } from '../../hooks/swarm/types'
import { nodePorts, type TestPorts } from './support/node-ports'

const LITTER = '/repo/.claude/litter'
const NOW = 1_800_000_000_000

function swarm(name = 'repair-abc123', over: Partial<LiveSwarm> = {}): LiveSwarm {
  return {
    name,
    launch: '20270115-093000',
    revision: 1,
    spec: { name, goal: 'repair it', nodes: [{ id: 'repair', kind: 'orchestrator' }, { id: 'fixer', kind: 'worker' }] },
    nonce: 'n0nce',
    types: { repair: `litter:sw-${name}-repair`, fixer: `litter:sw-${name}-fixer` },
    typesReady: true,
    dirs: {},
    sessionCwd: '/repo',
    worktreeRoot: '/repo/.claude/worktrees',
    commonDir: '/repo/.git',
    roots: { litterDir: LITTER, litterCopies: [LITTER], ruleDirs: [] },
    tips: {},
    owner: { ref: `refs/litter-swarm/${name}`, oid: 'a'.repeat(40), generation: 1, session: 'test-session' },
    state: 'live',
    readOnly: false,
    lost: false,
    flags: { isolationLost: false },
    startedAt: NOW,
    run: { runDir: `${LITTER}/20270115-fan`, run: '20270115-fan', generation: 2 },
    budget: { rounds: 3, agents: 6 },
    ...over,
  }
}

let p: TestPorts

beforeEach(() => {
  state.resetForTests()
  p = nodePorts()
  p.clock.now = NOW
})
afterEach(() => state.resetForTests())

describe('the spawns counted against the agents', () => {
  test('noted by key, a key twice counting once, given back by unnoteSpawned', () => {
    const s = 'repair-abc123'
    expect(state.spawnsUsed(s)).toBe(0)
    state.noteSpawned(s, 'tu-1')
    state.noteSpawned(s, 'tu-2')
    state.noteSpawned(s, 'tu-2')
    expect(state.spawnsUsed(s)).toBe(2)
    expect(state.unnoteSpawned(s, 'tu-2')).toBe(true)
    expect(state.unnoteSpawned(s, 'tu-2')).toBe(false)
    expect(state.unnoteSpawned(s, 'never')).toBe(false)
    expect(state.unnoteSpawned('other', 'tu-1')).toBe(false)
    expect(state.spawnsUsed(s)).toBe(1)
    expect(state.spawnsUsed('other')).toBe(0)
  })

  test('a check and the note in one synchronous step: of five concurrent spawns against six used of seven, one lands', async () => {
    const s = 'repair-abc123'
    for (let i = 0; i < 6; i++) state.noteSpawned(s, `old-${i}`)
    const landed: string[] = []
    await Promise.all(
      [1, 2, 3, 4, 5].map(async i => {
        await Promise.resolve()
        // No await between the check and the note (15.4, "It reserves the place before it awaits anything").
        if (state.spawnsUsed(s) < 7) {
          state.noteSpawned(s, `new-${i}`)
          landed.push(`new-${i}`)
        }
        await Promise.resolve()
      }),
    )
    expect(landed).toHaveLength(1)
    expect(state.spawnsUsed(s)).toBe(7)
  })
})

describe('the rounds', () => {
  test('one per distinct verify, from 1; a verify noted again keeps its round', () => {
    const s = 'repair-abc123'
    expect(state.roundsUsed(s)).toBe(0)
    expect(state.roundOf(s, 'v1')).toBeNull()
    expect(state.noteRound(s, 'v1')).toBe(1)
    expect(state.noteRound(s, 'v2')).toBe(2)
    expect(state.noteRound(s, 'v1')).toBe(1)
    expect(state.noteRound(s, 'v3')).toBe(3)
    expect(state.roundsUsed(s)).toBe(3)
    expect(state.roundOf(s, 'v2')).toBe(2)
    expect(state.roundOf(s, 'v9')).toBeNull()
    // Per swarm.
    expect(state.noteRound('other', 'v1')).toBe(1)
    expect(state.roundsUsed('other')).toBe(1)
  })
})

describe('the mirror', () => {
  test("the counters ride in the swarm's part and come back with loadSwarm", async () => {
    state.attach(p, LITTER)
    const s = swarm()
    state.putLiveSwarm(s)
    state.noteSpawned(s.name, 'tu-1')
    state.noteSpawned(s.name, 'tu-2')
    state.noteRound(s.name, 'v1')
    state.noteRound(s.name, 'v2')
    await state.flushed()
    const part = p.storeMap.get(state.swarmStateKey(LITTER, s.name)) as { spawned?: string[]; rounds?: string[]; swarm: LiveSwarm }
    expect(part.spawned).toEqual(['tu-1', 'tu-2'])
    expect(part.rounds).toEqual(['v1', 'v2'])
    expect(part.swarm.run).toEqual(s.run)
    expect(part.swarm.budget).toEqual({ rounds: 3, agents: 6 })

    state.resetForTests()
    expect(state.spawnsUsed(s.name)).toBe(0)
    const back = await state.loadSwarm(p, LITTER, s.name)
    expect(back?.run).toEqual(s.run)
    expect(back?.budget).toEqual({ rounds: 3, agents: 6 })
    expect(state.spawnsUsed(s.name)).toBe(2)
    expect(state.roundsUsed(s.name)).toBe(2)
    expect(state.noteRound(s.name, 'v2')).toBe(2)
    expect(state.noteRound(s.name, 'v3')).toBe(3)
  })

  test('each change is written: noting, giving back and a new round', async () => {
    state.attach(p, LITTER)
    const s = swarm()
    state.putLiveSwarm(s)
    await state.flushed()
    const key = state.swarmStateKey(LITTER, s.name)
    const part = () => p.storeMap.get(key) as { spawned?: string[]; rounds?: string[] }
    state.noteSpawned(s.name, 'tu-1')
    await state.flushed()
    expect(part().spawned).toEqual(['tu-1'])
    state.unnoteSpawned(s.name, 'tu-1')
    await state.flushed()
    expect(part().spawned).toEqual([])
    state.noteRound(s.name, 'v1')
    await state.flushed()
    expect(part().rounds).toEqual(['v1'])
  })

  test('an older part without the counters loads with none', async () => {
    const s = swarm()
    await p.store.set(state.swarmStateKey(LITTER, s.name), {
      v: 1, swarm: s, bindings: [], admission: [], stopped: [], queue: [], instances: {}, calls: [], shells: [],
      agentStopped: [], reports: {}, tokens: {}, questions: [], direct: [], refused: {},
    })
    expect((await state.loadSwarm(p, LITTER, s.name))?.name).toBe(s.name)
    expect(state.spawnsUsed(s.name)).toBe(0)
    expect(state.roundsUsed(s.name)).toBe(0)
  })

  test("they go with the swarm, and a read-only swarm's aren't mirrored", async () => {
    state.attach(p, LITTER)
    const s = swarm()
    state.putLiveSwarm(s)
    state.noteSpawned(s.name, 'tu-1')
    state.noteRound(s.name, 'v1')
    state.dropLiveSwarm(s.name)
    expect(state.spawnsUsed(s.name)).toBe(0)
    expect(state.roundsUsed(s.name)).toBe(0)
    await state.flushed()
    expect(p.storeMap.has(state.swarmStateKey(LITTER, s.name))).toBe(false)

    state.putLiveSwarm(swarm('theirs', { readOnly: true }))
    state.noteSpawned('theirs', 'tu-9')
    await state.flushed()
    expect(p.storeMap.has(state.swarmStateKey(LITTER, 'theirs'))).toBe(false)
  })

  test('resetForTests clears them', () => {
    state.noteSpawned('a', 'k')
    state.noteRound('a', 'v')
    state.resetForTests()
    expect(state.spawnsUsed('a')).toBe(0)
    expect(state.roundsUsed('a')).toBe(0)
  })
})

describe('interactive', () => {
  test('unknown (null) until something sets it, which the bridge treats as no', () => {
    expect(state.interactive()).toBeNull()
  })

  test('from the first prompt with an origin: sdk is not interactive; any other origin is', () => {
    const cases: [string, boolean][] = [
      ['sdk', false],
      ['composer', true],
      ['bridge', true],
      ['task-notification', true],
      ['plugin', true],
      ['unclassified', true],
    ]
    for (const [kind, expected] of cases) {
      state.resetForTests()
      state.notePromptOrigin({ kind })
      expect({ kind, interactive: state.interactive() }).toEqual({ kind, interactive: expected })
    }
  })

  test('a prompt with no origin leaves it unknown, for the next to set; then it stays', () => {
    state.notePromptOrigin(undefined)
    state.notePromptOrigin(null)
    state.notePromptOrigin({})
    state.notePromptOrigin({ kind: '' })
    state.notePromptOrigin({ kind: 3 })
    expect(state.interactive()).toBeNull()
    state.notePromptOrigin({ kind: 'sdk' })
    expect(state.interactive()).toBe(false)
    state.notePromptOrigin({ kind: 'composer' })
    expect(state.interactive()).toBe(false)
  })

  test("session.start's answer wins over a prompt's origin, before it and after", () => {
    state.setInteractive(true)
    state.notePromptOrigin({ kind: 'sdk' })
    expect(state.interactive()).toBe(true)
    state.resetForTests()
    state.notePromptOrigin({ kind: 'composer' })
    state.setInteractive(false)
    expect(state.interactive()).toBe(false)
  })

  test('a change bumps the version; the same answer again does not', () => {
    const v0 = state.version()
    state.setInteractive(true)
    const v1 = state.version()
    expect(v1).toBeGreaterThan(v0)
    state.setInteractive(true)
    state.notePromptOrigin({ kind: 'sdk' })
    expect(state.version()).toBe(v1)
  })

  test("it isn't mirrored: no swarm's part carries it", async () => {
    state.attach(p, LITTER)
    state.putLiveSwarm(swarm())
    state.setInteractive(true)
    await state.flushed()
    expect(JSON.stringify([...p.storeMap.values()])).not.toContain('interactive')
  })
})

describe('the version', () => {
  test('every counter change bumps it', () => {
    const steps: (() => unknown)[] = [
      () => state.noteSpawned('a', 'k1'),
      () => state.unnoteSpawned('a', 'k1'),
      () => state.noteRound('a', 'v1'),
      () => state.notePromptOrigin({ kind: 'composer' }),
      () => state.setInteractive(false),
    ]
    for (const [i, change] of steps.entries()) {
      const before = state.version()
      change()
      expect({ i, bumped: state.version() > before }).toEqual({ i, bumped: true })
    }
  })
})
