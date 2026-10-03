// Tier 2: the swarm's live state (hooks/swarm/state.ts; WP-C §5): every
// getter and changer, check-and-reserve under concurrent callers, the mirror
// to $.store, the ready gate under the fake clock, and the version.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as state from '../../hooks/swarm/state'
import type { LiveSwarm, NodeBinding, Reservation, WriteScope } from '../../hooks/swarm/types'
import { nodePorts, type TestPorts } from './support/node-ports'

const LITTER = '/repo/.claude/litter'
const NOW = 1_800_000_000_000

function swarm(name = 'alpha', over: Partial<LiveSwarm> = {}): LiveSwarm {
  return {
    name,
    launch: '20270115-093000',
    revision: 1,
    spec: { name, goal: 'ship it', nodes: [{ id: 'lead-a', kind: 'orchestrator' }, { id: 'fixer', kind: 'worker' }] },
    nonce: 'n0nce',
    types: { 'lead-a': `litter:sw-${name}-lead-a`, fixer: `litter:sw-${name}-fixer` },
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
    ...over,
  }
}

function bind(agentId: string, over: Partial<NodeBinding> = {}): NodeBinding {
  return {
    agentId,
    swarm: 'alpha',
    launch: '20270115-093000',
    node: 'fixer',
    n: 1,
    kind: 'worker',
    of: null,
    parent: 'orch-1',
    type: 'litter:sw-alpha-fixer',
    cwd: '/repo',
    branch: null,
    token: `tok-${agentId}`,
    revision: 1,
    generation: 1,
    boundAt: NOW,
    adopted: false,
    ...over,
  }
}

const scope = (dir: string, commit = false): WriteScope => ({ dir, paths: null, commit })

function res(key: string, over: Partial<Reservation> = {}): Reservation {
  return { key, swarm: 'alpha', node: 'fixer', parent: 'orch-1', kind: 'worker', n: null, scope: null, at: NOW, ...over }
}

let p: TestPorts

beforeEach(() => {
  state.resetForTests()
  p = nodePorts()
  p.clock.now = NOW
})
afterEach(() => state.resetForTests())

describe('live swarms', () => {
  test('put, read, patch and drop', () => {
    expect(state.liveSwarms()).toEqual([])
    expect(state.liveSwarm('alpha')).toBeNull()
    state.putLiveSwarm(swarm())
    expect(state.liveSwarm('alpha')?.revision).toBe(1)
    expect(state.liveSwarms().map(s => s.name)).toEqual(['alpha'])
    expect(state.patchLiveSwarm('alpha', { state: 'stopping', name: 'renamed' })?.state).toBe('stopping')
    expect(state.liveSwarm('alpha')?.name).toBe('alpha')
    expect(state.patchLiveSwarm('nope', { state: 'stopping' })).toBeNull()
    state.dropLiveSwarm('alpha')
    expect(state.liveSwarm('alpha')).toBeNull()
    state.dropLiveSwarm('alpha')
  })

  test('dropping a swarm drops everything held for it, and nothing of another', () => {
    state.putLiveSwarm(swarm())
    state.putLiveSwarm(swarm('beta'))
    state.putBinding(bind('w1'))
    state.putBinding(bind('w2', { swarm: 'beta', type: 'litter:sw-beta-fixer' }))
    state.markRunning('w1')
    state.enqueue({ swarm: 'alpha', agentId: 'w1', node: 'fixer', text: 'hi', from: 'user', at: NOW })
    state.reserve(res('t1'))
    state.dropLiveSwarm('alpha')
    expect(state.binding('w1')).toBeNull()
    expect(state.status('w1')).toBe('idle')
    expect(state.queued('alpha')).toEqual([])
    expect(state.reservations('alpha')).toEqual([])
    expect(state.binding('w2')?.swarm).toBe('beta')
  })

  test('swarmOfType answers from the type tables, with or without litter:, never by splitting', () => {
    // sw-a-b-c could be swarm a, node b-c, or swarm a-b, node c: only the table can tell.
    state.putLiveSwarm(swarm('a', { types: { 'b-c': 'litter:sw-a-b-c' } }))
    expect(state.swarmOfType('litter:sw-a-b-c')).toEqual({ swarm: 'a', node: 'b-c' })
    expect(state.swarmOfType('sw-a-b-c')).toEqual({ swarm: 'a', node: 'b-c' })
    expect(state.swarmOfType('litter:sw-a-b')).toBeNull()
    expect(state.swarmOfType('litter:executor')).toBeNull()
  })
})

describe('bindings', () => {
  test('put, read, list by swarm, drop', () => {
    state.putBinding(bind('w1'))
    state.putBinding(bind('w2', { swarm: 'beta' }))
    expect(state.binding('w1')?.node).toBe('fixer')
    expect(state.bindings().length).toBe(2)
    expect(state.bindings('beta').map(b => b.agentId)).toEqual(['w2'])
    state.dropBinding('w1')
    expect(state.binding('w1')).toBeNull()
    state.dropBinding('w1')
  })

  test('children and descendants follow parent, children of children included', () => {
    state.putBinding(bind('orch-1', { node: 'lead-a', kind: 'orchestrator', parent: null }))
    state.putBinding(bind('w1', { parent: 'orch-1' }))
    state.putBinding(bind('w2', { parent: 'orch-1' }))
    state.putBinding(bind('c1', { kind: 'child', parent: 'w1', of: 'w1', n: 0, token: null }))
    state.putBinding(bind('c2', { kind: 'child', parent: 'c1', of: 'w1', n: 0, token: null }))
    expect(state.childrenOf('orch-1').map(b => b.agentId).sort()).toEqual(['w1', 'w2'])
    expect(state.descendantsOf('orch-1').map(b => b.agentId).sort()).toEqual(['c1', 'c2', 'w1', 'w2'])
    expect(state.descendantsOf('w2')).toEqual([])
  })

  test('bindingByToken matches swarm and token only', () => {
    state.putBinding(bind('w1', { token: 'abc' }))
    state.putBinding(bind('c1', { kind: 'child', token: null }))
    expect(state.bindingByToken('alpha', 'abc')?.agentId).toBe('w1')
    expect(state.bindingByToken('beta', 'abc')).toBeNull()
    expect(state.bindingByToken('alpha', 'nope')).toBeNull()
  })
})

describe('admission', () => {
  test('reserve, promote, release, and a key held twice throws', () => {
    state.putLiveSwarm(swarm())
    state.reserve(res('t1', { scope: scope('/repo', true) }))
    expect(() => state.reserve(res('t1'))).toThrow(/already held/)
    expect(state.reservations().map(r => r.key)).toEqual(['t1'])
    expect(state.reservations('beta')).toEqual([])
    state.putBinding(bind('w1'))
    expect(state.promote('t1', 'w1')).toBe(true)
    expect(state.status('w1')).toBe('running')
    expect(state.activeScopes('alpha')).toEqual([{ dir: '/repo', paths: null, commit: true, swarm: 'alpha', node: 'fixer', agentId: 'w1', key: null }])
    expect(state.promote('t1', 'w1')).toBe(false)
    state.reserve(res('t2'))
    expect(state.release('t2')).toBe(true)
    expect(state.release('t2')).toBe(false)
  })

  test('running, settling and settled; countFor and countSwarm count places, children only in countSwarm', () => {
    state.putBinding(bind('w1'))
    state.putBinding(bind('w2', { parent: 'orch-2' }))
    state.putBinding(bind('c1', { kind: 'child', of: 'w1', parent: 'w1', n: 0, token: null }))
    state.markRunning('w1')
    state.markRunning('w2')
    state.markRunning('c1')
    state.reserve(res('t1'))
    expect(state.countFor('alpha', 'orch-1', 'fixer')).toBe(2)
    expect(state.countFor('alpha', 'orch-2', 'fixer')).toBe(1)
    expect(state.countSwarm('alpha')).toBe(4)
    state.markSettling('w1')
    expect(state.status('w1')).toBe('settling')
    expect(state.countFor('alpha', 'orch-1', 'fixer')).toBe(2)
    state.markSettled('w1')
    expect(state.status('w1')).toBe('idle')
    expect(state.countFor('alpha', 'orch-1', 'fixer')).toBe(1)
    state.markSettled('w1')
    expect(state.countSwarm('beta')).toBe(0)
  })

  test("a resume's reservation for an agent already counted isn't counted twice", () => {
    state.putBinding(bind('w1'))
    state.markSettling('w1')
    state.reserve(res('r1', { agentId: 'w1', n: 1 }))
    expect(state.countFor('alpha', 'orch-1', 'fixer')).toBe(1)
  })

  test('markRunning keeps the scope unless given, and clears a noted stop', () => {
    state.putBinding(bind('w1'))
    state.markRunning('w1', scope('/a'))
    state.markSettling('w1')
    state.noteAgentStopped('w1')
    expect(state.agentStopped('w1')).toBe(true)
    state.markRunning('w1')
    expect(state.agentStopped('w1')).toBe(false)
    expect(state.activeScopes('alpha')[0]?.dir).toBe('/a')
    state.markRunning('w1', null)
    expect(state.activeScopes('alpha')).toEqual([])
  })

  test('a promoted place counts before its binding is put, is mirrored, and goes with the binding', async () => {
    state.attach(p, LITTER)
    state.putLiveSwarm(swarm())
    state.reserve(res('t1', { scope: scope('/repo/wt', true) }))
    expect(state.promote('t1', 'w1')).toBe(true)
    // L awaits the swarm.node record here, before putBinding: a spawn checked now must still see the place.
    expect(state.binding('w1')).toBeNull()
    expect(state.countFor('alpha', 'orch-1', 'fixer')).toBe(1)
    expect(state.countSwarm('alpha')).toBe(1)
    expect(state.activeScopes('alpha')).toEqual([{ dir: '/repo/wt', paths: null, commit: true, swarm: 'alpha', node: 'fixer', agentId: 'w1', key: null }])
    await state.flushed()
    const part = p.storeMap.get(state.swarmStateKey(LITTER, 'alpha')) as state.SwarmPart
    expect(part.admission.map(a => [a.agentId, a.swarm, a.node, a.parent, a.kind])).toEqual([['w1', 'alpha', 'fixer', 'orch-1', 'worker']])
    state.putBinding(bind('w1'))
    expect(state.countFor('alpha', 'orch-1', 'fixer')).toBe(1)
    state.dropBinding('w1')
    expect(state.status('w1')).toBe('idle')
    expect(state.countSwarm('alpha')).toBe(0)
    expect(state.activeScopes('alpha')).toEqual([])
  })

  test("dropBinding frees a promoted agent's place even before its binding was put", () => {
    state.reserve(res('t1'))
    state.promote('t1', 'w1')
    state.dropBinding('w1')
    expect(state.countSwarm('alpha')).toBe(0)
  })

  test("a resume's markRunning takes its place from the binding, or the one given; with neither it throws", () => {
    state.putBinding(bind('w1'))
    state.markRunning('w1')
    expect(state.countFor('alpha', 'orch-1', 'fixer')).toBe(1)
    state.markRunning('w2', null, { swarm: 'alpha', node: 'fixer', parent: 'orch-2', kind: 'worker' })
    expect(state.countFor('alpha', 'orch-2', 'fixer')).toBe(1)
    expect(state.countSwarm('alpha')).toBe(2)
    expect(() => state.markRunning('ghost')).toThrow('litter: ghost has no place to run in')
    expect(state.status('ghost')).toBe('idle')
    // Settling keeps the place it holds; one with no place and no binding is left alone.
    state.markSettling('w2')
    expect(state.countFor('alpha', 'orch-2', 'fixer')).toBe(1)
    state.markSettling('ghost')
    expect(state.status('ghost')).toBe('idle')
  })

  test('noteInstance stores the number it raises to, and the mirror carries it', async () => {
    state.attach(p, LITTER)
    state.putLiveSwarm(swarm())
    state.noteInstance('alpha', 'fixer', 4)
    await state.flushed()
    expect((p.storeMap.get(state.swarmStateKey(LITTER, 'alpha')) as state.SwarmPart).instances).toEqual({ fixer: 4 })
    state.resetForTests()
    await state.loadSwarm(p, LITTER, 'alpha')
    expect(state.nextInstance('alpha', 'fixer')).toBe(5)
  })

  test('nextInstance counts from 1 per node; noteInstance only raises it', () => {
    expect(state.nextInstance('alpha', 'fixer')).toBe(1)
    expect(state.nextInstance('alpha', 'fixer')).toBe(2)
    expect(state.nextInstance('alpha', 'reviewer')).toBe(1)
    expect(state.nextInstance('beta', 'fixer')).toBe(1)
    state.noteInstance('alpha', 'fixer', 7)
    state.noteInstance('alpha', 'fixer', 3)
    expect(state.nextInstance('alpha', 'fixer')).toBe(8)
  })

  test('of five concurrent check-and-reserve callers against a limit of two, exactly two land', async () => {
    state.putLiveSwarm(swarm())
    // Each caller awaits once, then checks and reserves in one synchronous step, as L's spawn check does.
    const spawn = async (key: string): Promise<boolean> => {
      await state.ready(p)
      if (state.countFor('alpha', 'orch-1', 'fixer') >= 2) return false
      state.reserve(res(key))
      return true
    }
    const got = await Promise.all(['t1', 't2', 't3', 't4', 't5'].map(spawn))
    expect(got.filter(Boolean).length).toBe(2)
    expect(state.reservations('alpha').length).toBe(2)
  })
})

describe('the stopped list and the queue', () => {
  test('stop, isStopped, stopped', () => {
    state.stop('alpha', ['w1', 'w2'], 'stopped from the swarm browser')
    expect(state.isStopped('w1')).toBe(true)
    expect(state.isStopped('w3')).toBe(false)
    expect(state.stopped('alpha').map(x => x.agentId).sort()).toEqual(['w1', 'w2'])
    expect(state.stopped('beta')).toEqual([])
  })

  test('enqueue assigns ids and cuts the text to 16 KiB; queued filters; dequeue and cancelQueued take one', () => {
    const a = state.enqueue({ swarm: 'alpha', agentId: 'w1', node: 'fixer', text: 'é'.repeat(10_000), from: 'user', at: NOW })
    const b = state.enqueue({ swarm: 'alpha', agentId: 'w2', node: 'fixer', text: 'two', from: 'lead', at: NOW + 1 })
    const c = state.enqueue({ swarm: 'beta', agentId: 'w3', node: 'x', text: 'three', from: 'user', at: NOW + 2 })
    expect(a.id).toMatch(/^q[0-9a-f]{8}$/)
    expect(new Set([a.id, b.id, c.id]).size).toBe(3)
    expect(new TextEncoder().encode(a.text).length).toBeLessThanOrEqual(state.QUEUED_MAX_BYTES)
    expect(a.text.length).toBe(state.QUEUED_MAX_BYTES / 2)
    expect(state.queued().length).toBe(3)
    expect(state.queued('alpha').map(m => m.id)).toEqual([a.id, b.id])
    expect(state.queued('alpha', 'w2').map(m => m.text)).toEqual(['two'])
    expect(state.dequeue(b.id)?.text).toBe('two')
    expect(state.dequeue(b.id)).toBeNull()
    expect(state.cancelQueued(c.id)?.swarm).toBe('beta')
    expect(state.cancelQueued(c.id)).toBeNull()
  })
})

describe('in flight', () => {
  test('calls start, end, close per agent, and carry their swarm (null for a run agent)', () => {
    state.putBinding(bind('w1'))
    state.callStart('w1', 'u1', 'Bash', NOW)
    state.callStart('w1', 'u2', 'Read', NOW + 1)
    state.callStart('run-agent', 'u3', 'Edit', NOW + 2)
    expect(state.inflight().map(c => [c.toolUseId, c.swarm])).toEqual([
      ['u1', 'alpha'],
      ['u2', 'alpha'],
      ['u3', null],
    ])
    expect(state.callEnd('w1', 'u1')).toBe(true)
    expect(state.callEnd('w1', 'u1')).toBe(false)
    expect(state.closeCalls('w1').map(c => c.toolUseId)).toEqual(['u2'])
    expect(state.closeCalls('w1')).toEqual([])
    expect(state.inflight().map(c => c.toolUseId)).toEqual(['u3'])
  })

  test('shells start and stop, by swarm', () => {
    state.putBinding(bind('w1'))
    state.shellStarted('w1', 'sh1', NOW)
    state.shellStarted('run-agent', 'sh2', NOW)
    expect(state.shells('alpha').map(s => s.shellId)).toEqual(['sh1'])
    expect(state.shells().length).toBe(2)
    expect(state.shellStopped('sh1')).toBe(true)
    expect(state.shellStopped('sh1')).toBe(false)
    expect(state.shells('alpha')).toEqual([])
  })

  test('noteAgentStopped and agentStopped', () => {
    expect(state.agentStopped('w1')).toBe(false)
    state.noteAgentStopped('w1')
    expect(state.agentStopped('w1')).toBe(true)
  })
})

describe("reports and the lead's view", () => {
  test('noteReport keeps the last, cut to 4 KiB', () => {
    expect(state.lastReport('w1')).toBeNull()
    state.noteReport('w1', 'first', 'handback', NOW)
    state.noteReport('w1', 'x'.repeat(10_000), 'answer', NOW + 1)
    const r = state.lastReport('w1')
    expect(r?.via).toBe('answer')
    expect(r?.text.length).toBe(state.REPORT_MAX_BYTES)
  })

  test('tokens add up per agent, per swarm by name first, and a turn without usage still counts', () => {
    state.putLiveSwarm(swarm())
    state.putBinding(bind('w1'))
    state.putBinding(bind('w2'))
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1, model: 'm' }
    state.addTokens('w1', usage)
    state.addTokens('w1', usage)
    state.addTokens('w2', null)
    expect(state.tokens('w1')).toEqual({ input: 20, output: 10, cacheRead: 4, cacheCreation: 2, turns: 2 })
    expect(state.tokens('alpha')).toEqual({ input: 20, output: 10, cacheRead: 4, cacheCreation: 2, turns: 3 })
    expect(state.tokens('nobody')).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0, turns: 0 })
  })

  test('questions open and close per agent; an unbound agent has none', () => {
    state.putBinding(bind('w1'))
    expect(state.noteQuestion('ghost', 'why?', NOW)).toBeNull()
    expect(state.noteQuestion('w1', 'rename the enum?', NOW)?.node).toBe('fixer')
    state.noteQuestion('w1', 'and the tests?', NOW + 1)
    expect(state.openQuestions('alpha').length).toBe(2)
    expect(state.closeQuestion('w1', NOW + 2)).toBe(2)
    expect(state.closeQuestion('w1', NOW + 3)).toBe(0)
    expect(state.openQuestions('alpha')).toEqual([])
    expect(state.questions('alpha').map(q => q.closedAt)).toEqual([NOW + 2, NOW + 2])
  })

  test('the questions kept per swarm are bounded, the oldest closed going first', () => {
    state.putBinding(bind('w1'))
    state.noteQuestion('w1', 'old, closed', NOW)
    state.closeQuestion('w1', NOW)
    for (let i = 0; i < 100; i++) state.noteQuestion('w1', `q${i}`, NOW + i)
    const kept = state.questions('alpha')
    expect(kept.length).toBe(100)
    expect(kept.some(q => q.text === 'old, closed')).toBe(false)
  })

  test('direct messages are taken once', () => {
    state.noteDirect('alpha', 'one')
    state.noteDirect('alpha', 'two')
    expect(state.takeDirect('alpha')).toEqual(['one', 'two'])
    expect(state.takeDirect('alpha')).toEqual([])
    expect(state.takeDirect('beta')).toEqual([])
  })
})

describe('turns, the clear and the rest', () => {
  test('a refused turn is kept, bounded to the latest sixteen', () => {
    state.refuseTurn('w1', 't0')
    state.refuseTurn('w1', 't0')
    expect(state.isRefusedTurn('w1', 't0')).toBe(true)
    expect(state.isRefusedTurn('w2', 't0')).toBe(false)
    for (let i = 1; i <= 16; i++) state.refuseTurn('w1', `t${i}`)
    expect(state.isRefusedTurn('w1', 't0')).toBe(false)
    expect(state.isRefusedTurn('w1', 't16')).toBe(true)
  })

  test("the lead's turn state", () => {
    expect(state.leadBusy()).toBe(false)
    state.setLeadBusy(true)
    expect(state.leadBusy()).toBe(true)
    state.setLeadBusy(false)
    expect(state.leadBusy()).toBe(false)
  })

  test('the rebind flag, the cleared mark, the kills and the recorded session', () => {
    expect(state.rebindPending()).toBeNull()
    state.setRebindPending('old-session')
    expect(state.rebindPending()).toBe('old-session')
    state.clearRebind()
    expect(state.rebindPending()).toBeNull()
    expect(state.takeCleared()).toBe(false)
    state.markCleared()
    expect(state.takeCleared()).toBe(true)
    expect(state.takeCleared()).toBe(false)
    state.noteClearKills([{ agentId: 'w1', who: 'fixer #1 under lead-a', tool: 'Bash', detail: 'npm test' }])
    expect(state.takeClearKills().map(k => k.who)).toEqual(['fixer #1 under lead-a'])
    expect(state.takeClearKills()).toEqual([])
    expect(state.recordedSession()).toBeNull()
    state.setRecordedSession('s2')
    expect(state.recordedSession()).toBe('s2')
  })

  test('proposals are taken once', () => {
    state.noteProposal('alpha', 3)
    expect(state.takeProposals()).toEqual([{ name: 'alpha', n: 3 }])
    expect(state.takeProposals()).toEqual([])
  })

  test('every changer bumps the version', () => {
    const steps: (() => unknown)[] = [
      () => state.putLiveSwarm(swarm()),
      () => state.patchLiveSwarm('alpha', { revision: 2 }),
      () => state.putBinding(bind('w1')),
      () => state.reserve(res('t1')),
      () => state.promote('t1', 'w1'),
      () => state.markSettling('w1'),
      () => state.markRunning('w1'),
      () => state.markSettled('w1'),
      () => state.reserve(res('t2')),
      () => state.release('t2'),
      () => state.nextInstance('alpha', 'fixer'),
      () => state.noteInstance('alpha', 'fixer', 9),
      () => state.stop('alpha', ['w1'], 'r'),
      () => state.enqueue({ swarm: 'alpha', agentId: 'w1', node: 'fixer', text: 't', from: 'user', at: NOW }),
      () => state.callStart('w1', 'u1', 'Bash', NOW),
      () => state.callEnd('w1', 'u1'),
      () => state.shellStarted('w1', 'sh1', NOW),
      () => state.shellStopped('sh1'),
      () => state.noteAgentStopped('w1'),
      () => state.noteReport('w1', 'r', 'message', NOW),
      () => state.addTokens('w1', null),
      () => state.noteQuestion('w1', 'q', NOW),
      () => state.closeQuestion('w1', NOW),
      () => state.noteDirect('alpha', 'd'),
      () => state.takeDirect('alpha'),
      () => state.refuseTurn('w1', 't'),
      () => state.setLeadBusy(true),
      () => state.setRebindPending('s'),
      () => state.clearRebind(),
      () => state.markCleared(),
      () => state.takeCleared(),
      () => state.noteClearKills([]),
      () => state.setRecordedSession('s'),
      () => state.closeGate(),
      () => state.openGate(),
      () => state.noteProposal('alpha', 1),
      () => state.takeProposals(),
      () => state.dropBinding('w1'),
      () => state.dropLiveSwarm('alpha'),
    ]
    for (const [i, change] of steps.entries()) {
      const before = state.version()
      change()
      expect({ i, bumped: state.version() > before }).toEqual({ i, bumped: true })
    }
  })
})

describe('the ready gate', () => {
  test('resolves at once while open, without sleeping', async () => {
    await state.ready(p)
    expect(p.sleeps).toEqual([])
  })

  test('polls with p.sleep(25) while closed, and resolves once it opens', async () => {
    state.closeGate()
    state.closeGate()
    let polls = 0
    p.onSleep = () => {
      polls++
      if (polls === 3) state.openGate()
      if (polls === 5) state.openGate()
    }
    await state.ready(p)
    expect(p.sleeps).toEqual([25, 25, 25, 25, 25])
  })

  test('rejects after 8 s of fake clock, inside the 10 s hook budget, so the waiting hook fails closed with its own error', async () => {
    expect(state.READY_MS).toBe(8_000)
    state.closeGate()
    await expect(state.ready(p)).rejects.toThrow("litter: the swarm state isn't ready")
    expect(p.sleeps.length).toBe(state.READY_MS / state.READY_POLL_MS)
    expect(p.clock.now).toBe(NOW + state.READY_MS)
  })

  /** The gate is open: ready resolves without one sleep. */
  async function gateIsOpen(): Promise<boolean> {
    const q = nodePorts()
    q.clock.now = NOW
    q.onSleep = () => {
      throw new Error('closed')
    }
    try {
      await state.ready(q)
      return true
    } catch {
      return false
    }
  }

  test('withGateClosed holds the gate until its open is called, then the rest of the work runs with it open', async () => {
    const seen: boolean[] = []
    const r = await state.withGateClosed(async open => {
      seen.push(await gateIsOpen())
      open()
      seen.push(await gateIsOpen())
      return 7
    })
    expect(seen).toEqual([false, true])
    expect(r).toBe(7)
    expect(await gateIsOpen()).toBe(true)
  })

  test("withGateClosed opens it once: a second open, and its finally, leave another holder's close in place", async () => {
    state.closeGate()
    await state.withGateClosed(async open => {
      open()
      open()
      expect(await gateIsOpen()).toBe(false)
    })
    expect(await gateIsOpen()).toBe(false)
    state.openGate()
    expect(await gateIsOpen()).toBe(true)
  })

  test('withGateClosed opens the gate when the work throws before its open', async () => {
    await expect(
      state.withGateClosed(async () => {
        throw new Error('a step threw')
      }),
    ).rejects.toThrow('a step threw')
    expect(await gateIsOpen()).toBe(true)
  })

  test('openGate never goes below open', async () => {
    state.openGate()
    state.openGate()
    state.closeGate()
    let opened = false
    p.onSleep = () => {
      if (!opened) state.openGate()
      opened = true
    }
    await state.ready(p)
    expect(p.sleeps.length).toBe(1)
  })
})

describe('the mirror', () => {
  test('a burst of changes is one write per swarm, and a fresh module gets it back with loadSwarm', async () => {
    let writes = 0
    const set = p.store.set
    p.store.set = async (key, value) => {
      writes++
      await set(key, value)
    }
    state.attach(p, LITTER)
    state.putLiveSwarm(swarm())
    state.putBinding(bind('w1'))
    state.markRunning('w1', scope('/repo', true))
    state.stop('alpha', ['w9'], 'stopped from the swarm browser')
    state.enqueue({ swarm: 'alpha', agentId: 'w1', node: 'fixer', text: 'later', from: 'user', at: NOW })
    state.nextInstance('alpha', 'fixer')
    state.callStart('w1', 'u1', 'Bash', NOW)
    state.shellStarted('w1', 'sh1', NOW)
    state.noteReport('w1', 'done', 'handback', NOW)
    state.addTokens('w1', null)
    state.noteQuestion('w1', 'q?', NOW)
    state.noteDirect('alpha', 'hi')
    state.refuseTurn('w1', 'turn-1')
    state.noteAgentStopped('w1')
    await state.flushed()
    expect(writes).toBe(1)
    expect(p.storeMap.has(state.swarmStateKey(LITTER, 'alpha'))).toBe(true)

    state.resetForTests()
    expect(state.liveSwarm('alpha')).toBeNull()
    const back = await state.loadSwarm(p, LITTER, 'alpha')
    expect(back?.name).toBe('alpha')
    expect(state.binding('w1')?.node).toBe('fixer')
    expect(state.status('w1')).toBe('running')
    expect(state.activeScopes('alpha')[0]?.commit).toBe(true)
    expect(state.isStopped('w9')).toBe(true)
    expect(state.queued('alpha').map(m => m.text)).toEqual(['later'])
    expect(state.nextInstance('alpha', 'fixer')).toBe(2)
    expect(state.inflight().map(c => c.toolUseId)).toEqual(['u1'])
    expect(state.shells('alpha').map(s => s.shellId)).toEqual(['sh1'])
    expect(state.lastReport('w1')?.text).toBe('done')
    expect(state.tokens('w1').turns).toBe(1)
    expect(state.openQuestions('alpha').length).toBe(1)
    expect(state.takeDirect('alpha')).toEqual(['hi'])
    expect(state.isRefusedTurn('w1', 'turn-1')).toBe(true)
    expect(state.agentStopped('w1')).toBe(true)
  })

  test('changes made while a write runs are one more write, and nothing is lost', async () => {
    let writes = 0
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const set = p.store.set
    p.store.set = async (key, value) => {
      writes++
      if (writes === 1) await gate
      await set(key, value)
    }
    state.attach(p, LITTER)
    state.putLiveSwarm(swarm())
    await Promise.resolve()
    await Promise.resolve()
    state.putBinding(bind('w1'))
    state.putBinding(bind('w2'))
    release()
    await state.flushed()
    expect(writes).toBe(2)
    const part = p.storeMap.get(state.swarmStateKey(LITTER, 'alpha')) as state.SwarmPart
    expect(part.bindings.map(b => b.agentId).sort()).toEqual(['w1', 'w2'])
  })

  test('changes made before attach are written at attach', async () => {
    state.putLiveSwarm(swarm())
    await state.flushed()
    expect(p.storeMap.size).toBe(0)
    state.attach(p, LITTER)
    await state.flushed()
    expect(p.storeMap.has(state.swarmStateKey(LITTER, 'alpha'))).toBe(true)
  })

  test('a read-only swarm and a lost one are never mirrored', async () => {
    state.attach(p, LITTER)
    state.putLiveSwarm(swarm('ro', { readOnly: true }))
    state.putLiveSwarm(swarm('gone', { lost: true }))
    state.putBinding(bind('w1', { swarm: 'ro' }))
    await state.flushed()
    expect(p.storeMap.size).toBe(0)
  })

  test("dropLiveSwarm deletes an owned swarm's key, and leaves a read-only one's alone", async () => {
    state.attach(p, LITTER)
    state.putLiveSwarm(swarm())
    await state.flushed()
    p.storeMap.set(state.swarmStateKey(LITTER, 'ro'), { v: 1, swarm: { name: 'ro' } })
    state.putLiveSwarm(swarm('ro', { readOnly: true }))
    state.dropLiveSwarm('alpha')
    state.dropLiveSwarm('ro')
    await state.flushed()
    expect(p.storeMap.has(state.swarmStateKey(LITTER, 'alpha'))).toBe(false)
    expect(p.storeMap.has(state.swarmStateKey(LITTER, 'ro'))).toBe(true)
  })

  test("reservations, the lead's turn and the gate aren't mirrored", async () => {
    state.attach(p, LITTER)
    state.putLiveSwarm(swarm())
    state.reserve(res('t1'))
    state.setLeadBusy(true)
    state.closeGate()
    await state.flushed()
    state.resetForTests()
    await state.loadSwarm(p, LITTER, 'alpha')
    expect(state.reservations()).toEqual([])
    expect(state.leadBusy()).toBe(false)
    await state.ready(p)
  })

  test('a failed write is logged, and the next change writes again', async () => {
    let fail = true
    const set = p.store.set
    p.store.set = async (key, value) => {
      if (fail) throw new Error('store full')
      await set(key, value)
    }
    state.attach(p, LITTER)
    state.putLiveSwarm(swarm())
    await state.flushed()
    expect(p.logs.some(l => l.includes('store full'))).toBe(true)
    fail = false
    state.patchLiveSwarm('alpha', { revision: 2 })
    await state.flushed()
    expect((p.storeMap.get(state.swarmStateKey(LITTER, 'alpha')) as state.SwarmPart).swarm.revision).toBe(2)
  })

  test('loadSwarm answers null for a missing or unreadable part, and changes nothing', async () => {
    expect(await state.loadSwarm(p, LITTER, 'alpha')).toBeNull()
    p.storeMap.set(state.swarmStateKey(LITTER, 'alpha'), { v: 2 })
    expect(await state.loadSwarm(p, LITTER, 'alpha')).toBeNull()
    p.storeMap.set(state.swarmStateKey(LITTER, 'alpha'), { v: 1, swarm: { name: 'other' } })
    expect(await state.loadSwarm(p, LITTER, 'alpha')).toBeNull()
    expect(state.liveSwarms()).toEqual([])
  })

  test("loadSwarm brings typesReady back false: the types were registered in the earlier process, not this one", async () => {
    state.attach(p, LITTER)
    state.putLiveSwarm(swarm('alpha', { typesReady: true }))
    await state.flushed()
    expect((p.storeMap.get(state.swarmStateKey(LITTER, 'alpha')) as state.SwarmPart).swarm.typesReady).toBe(true)
    state.resetForTests()
    const back = await state.loadSwarm(p, LITTER, 'alpha')
    expect(back?.typesReady).toBe(false)
    expect(state.liveSwarm('alpha')?.typesReady).toBe(false)
  })
})

describe('the bounds on what the mirror holds', () => {
  const bytes = (text: string) => new TextEncoder().encode(text).length
  const msg = (swarm: string, i: number) => ({ swarm, agentId: 'w1', node: 'fixer', text: `m${i}`, from: 'user', at: NOW + i })

  test('a question and a direct message are cut to 4 KiB', () => {
    state.putBinding(bind('w1'))
    const q = state.noteQuestion('w1', 'é'.repeat(5_000), NOW)
    expect(bytes(q!.text)).toBeLessThanOrEqual(state.NOTE_MAX_BYTES)
    expect(q!.text.length).toBe(state.NOTE_MAX_BYTES / 2)
    state.noteDirect('alpha', 'x'.repeat(10_000))
    expect(state.takeDirect('alpha')[0]!.length).toBe(state.NOTE_MAX_BYTES)
  })

  test('a swarm queues at most 50 messages: the next throws naming the node, and queues nothing', () => {
    for (let i = 0; i < state.QUEUE_MAX; i++) state.enqueue(msg('alpha', i))
    expect(state.QUEUE_MAX).toBe(50)
    expect(() => state.enqueue(msg('alpha', 99))).toThrow('litter: the queue for fixer is full')
    expect(state.queued('alpha').length).toBe(50)
    // Another swarm's queue is its own; a message taken off makes room.
    state.enqueue(msg('beta', 0))
    state.dequeue(state.queued('alpha')[0]!.id)
    state.enqueue(msg('alpha', 100))
    expect(state.queued('alpha').length).toBe(50)
  })

  test("dropBinding prunes the agent's report, tokens, refused turns, stop mark and questions, in memory and the mirror", async () => {
    state.attach(p, LITTER)
    state.putLiveSwarm(swarm())
    for (const id of ['w1', 'w2']) {
      state.putBinding(bind(id))
      state.noteReport(id, `report of ${id}`, 'handback', NOW)
      state.addTokens(id, null)
      state.refuseTurn(id, 'turn-1')
      state.noteAgentStopped(id)
      state.noteQuestion(id, `question of ${id}`, NOW)
    }
    state.dropBinding('w1')
    expect(state.lastReport('w1')).toBeNull()
    expect(state.tokens('w1').turns).toBe(0)
    expect(state.isRefusedTurn('w1', 'turn-1')).toBe(false)
    expect(state.agentStopped('w1')).toBe(false)
    expect(state.questions('alpha').map(q => q.agentId)).toEqual(['w2'])
    expect(state.lastReport('w2')?.text).toBe('report of w2')
    expect(state.agentStopped('w2')).toBe(true)
    await state.flushed()
    const part = p.storeMap.get(state.swarmStateKey(LITTER, 'alpha')) as state.SwarmPart
    expect(Object.keys(part.reports)).toEqual(['w2'])
    expect(part.questions.map(q => q.agentId)).toEqual(['w2'])
    expect(part.agentStopped).toEqual(['w2'])
  })

  test('a part over 256 KiB drops the oldest reports and closed questions of agents not running, from memory too, and logs it', async () => {
    state.attach(p, LITTER)
    state.putLiveSwarm(swarm())
    // 80 settled workers with a 4 KiB report each: about 330 KiB.
    for (let i = 0; i < 80; i++) {
      state.putBinding(bind(`w${i}`))
      state.noteReport(`w${i}`, 'r'.repeat(4096), 'handback', NOW + i)
    }
    // A running agent's report stays, however old.
    state.putBinding(bind('busy'))
    state.markRunning('busy')
    state.noteReport('busy', 'b'.repeat(4096), 'handback', NOW - 10_000)
    // Ten closed questions, older than every report, and an open one, older still.
    state.noteQuestion('w1', 'still open?', NOW - 9_000)
    for (let i = 0; i < 10; i++) state.noteQuestion('w0', 'q'.repeat(4096), NOW - 5_000 + i)
    state.closeQuestion('w0', NOW)
    await state.flushed()

    const part = p.storeMap.get(state.swarmStateKey(LITTER, 'alpha')) as state.SwarmPart
    expect(bytes(JSON.stringify(part))).toBeLessThanOrEqual(state.PART_MAX_BYTES)
    expect(part.reports.busy?.text.length).toBe(4096)
    expect(part.questions.map(q => q.text)).toEqual(['still open?'])
    // Oldest first: the closed questions, then the oldest reports; the newest stay.
    expect(part.reports.w0).toBeUndefined()
    expect(part.reports.w79).toBeDefined()
    expect(state.lastReport('w0')).toBeNull()
    expect(state.lastReport('w79')).not.toBeNull()
    const line = p.logs.find(l => l.includes('its state was over 262144 bytes'))
    expect(line).toContain('fixer (w0)')
    expect(line).toContain('10 closed questions')
    expect(line).not.toContain('busy')
  })
})
