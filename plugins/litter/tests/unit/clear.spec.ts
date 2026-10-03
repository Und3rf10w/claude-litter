// Tier 2: litter holds /clear while anything of a swarm or a run is running
// (hooks/clear.ts, holdClear; plan 15.4, "Litter holds /clear while anything
// is running"). The in-flight table and the bindings are set up in state.ts
// as P's consumer and L's binding would have left them; the agent list,
// the ask and the launch ledger are the fakes and real files.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { ListedAgent } from '../../hooks/ports'
import * as state from '../../hooks/swarm/state'
import type { LiveSwarm, NodeBinding } from '../../hooks/swarm/types'
import { CLEAR_HELD, CLEAR_OPTIONS, holdClear, resetClearForTests } from '../../hooks/clear'
import { readLaunchLedger } from '../../hooks/records/swarm'
import { updateSession } from '../../hooks/session'
import { atomicWriteJson } from '../../hooks/fsx'
import { policyPath } from '../../hooks/layout'
import type { Policy, RunPolicy } from '../../hooks/hookfiles'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const NOW = 1_800_000_000_000
const LAUNCH = '20270115-093000'
const RUN = '20270115-execute-abcdef'

function swarm(name = 'alpha', over: Partial<LiveSwarm> = {}): LiveSwarm {
  return {
    name,
    launch: LAUNCH,
    revision: 1,
    spec: { name, goal: 'g', nodes: [{ id: 'part-b', kind: 'orchestrator' }, { id: 'fixer', kind: 'worker' }] },
    nonce: 'n0nce',
    types: { 'part-b': `litter:sw-${name}-part-b`, fixer: `litter:sw-${name}-fixer` },
    typesReady: true,
    dirs: {},
    sessionCwd: '/repo',
    worktreeRoot: '/repo/.claude/worktrees',
    commonDir: '/repo/.git',
    roots: { litterDir: '/repo/.claude/litter', litterCopies: [], ruleDirs: [] },
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
    launch: LAUNCH,
    node: 'part-b',
    n: 1,
    kind: 'orchestrator',
    of: null,
    parent: null,
    type: 'litter:sw-alpha-part-b',
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

const listed = (id: string, type: string, status = 'running', over: Partial<ListedAgent> = {}): ListedAgent => ({ id, type, status, description: id, ...over })

function runPolicy(litterDir: string): RunPolicy {
  return {
    run: RUN,
    workflow: 'execute',
    runDir: join(litterDir, RUN),
    checkout: '/repo',
    base: 'b'.repeat(40),
    runIds: ['wf_abc123'],
    launching: false,
    stopping: false,
    inflight: null,
    isolationLost: false,
    roots: { checkout: '/repo', litterDir, litterCopies: [litterDir], ruleDirs: [], worktrees: [] },
    setup: null,
    linkDirs: [],
  }
}

let p: TestPorts
let litterDir: string
let cleanup: () => void

const CLEAR = { command: 'clear', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never
const ENGINE = { text: 'engine cleared' }

/** Runs the hold; `cleared` says whether it passed the clear on. */
async function clear(): Promise<{ r: unknown; cleared: boolean }> {
  let cleared = false
  const r = await holdClear(p, CLEAR, (async () => {
    cleared = true
    return ENGINE
  }) as never)
  return { r, cleared }
}

/** A live swarm with orchestrator part-b running and its worker fixer #2 mid-Bash for 40 s. */
function busySwarm(): void {
  state.putLiveSwarm(swarm())
  state.putBinding(bind('orch-b'))
  state.putBinding(bind('fix-2', { node: 'fixer', n: 2, kind: 'worker', parent: 'orch-b', type: 'litter:sw-alpha-fixer' }))
  state.markRunning('orch-b')
  state.markRunning('fix-2')
  state.callStart('fix-2', 'tu-bash', 'Bash', NOW - 40_000)
  p.agents = [listed('orch-b', 'litter:sw-alpha-part-b'), listed('fix-2', 'litter:sw-alpha-fixer')]
}

beforeEach(() => {
  state.resetForTests()
  resetClearForTests()
  const s = scratch()
  cleanup = s.cleanup
  litterDir = join(s.dir, '.claude', 'litter')
  updateSession({ litterDir })
  p = nodePorts()
  p.clock.now = NOW
})

afterEach(() => {
  state.resetForTests()
  resetClearForTests()
  updateSession({ litterDir: null })
  cleanup()
})

describe('the clear passes', () => {
  test('with no live swarm and no active run, at once: no list, no ask', async () => {
    let listedCalls = 0
    p.listAgents = async () => {
      listedCalls++
      return []
    }
    expect(await clear()).toEqual({ r: ENGINE, cleared: true })
    expect(listedCalls).toBe(0)
    expect(p.asked).toEqual([])
  })

  test("with a live swarm and nothing of it running: idle nodes, finished ones' stale calls, other agents", async () => {
    state.putLiveSwarm(swarm())
    state.putBinding(bind('orch-b'))
    state.putBinding(bind('fix-2', { node: 'fixer', n: 2, kind: 'worker', parent: 'orch-b', type: 'litter:sw-alpha-fixer' }))
    // A call whose end never came, of an agent the list shows finished: nothing to kill.
    state.callStart('fix-2', 'tu-old', 'Bash', NOW - 600_000)
    p.agents = [listed('orch-b', 'litter:sw-alpha-part-b', 'completed'), listed('fix-2', 'litter:sw-alpha-fixer', 'killed'), listed('x', 'Explore')]
    expect(await clear()).toEqual({ r: ENGINE, cleared: true })
    expect(p.asked).toEqual([])
  })

  test("another session's swarm (read-only) holds nothing here", async () => {
    state.putLiveSwarm(swarm('alpha', { readOnly: true }))
    state.putBinding(bind('orch-b'))
    state.callStart('orch-b', 'tu-1', 'Bash', NOW - 1000)
    p.agents = [listed('orch-b', 'litter:sw-alpha-part-b')]
    expect(await clear()).toEqual({ r: ENGINE, cleared: true })
  })
})

describe('the clear is held', () => {
  test('with something running, it asks, listing each agent with its open call and how long it has run', async () => {
    busySwarm()
    p.answers.push('Cancel')
    expect(await clear()).toEqual({ r: { text: CLEAR_HELD }, cleared: false })
    expect(p.asked).toHaveLength(1)
    const { question, options } = p.asked[0]!
    expect(options).toEqual([...CLEAR_OPTIONS])
    expect(options[0]).toBe('Cancel')
    expect(question).toContain('/clear stops these commands halfway (their shells are killed)')
    expect(question).toContain('- fixer #2 under part-b: Bash, running for 40 s')
    expect(question).toContain('- part-b: running, between commands')
    expect(question.trimEnd().endsWith('?')).toBe(true)
  })

  test("a child of a node, and a node not bound yet, are listed by their node", async () => {
    state.putLiveSwarm(swarm())
    state.putBinding(bind('orch-b'))
    state.putBinding(bind('kid-1', { kind: 'child', n: 0, of: 'orch-b', parent: 'orch-b', type: 'litter:sw-alpha-part-b', token: null }))
    state.callStart('kid-1', 'tu-k', 'Grep', NOW - 3000)
    p.agents = [listed('kid-1', 'Explore', 'running', { parentId: 'orch-b' }), listed('new-1', 'litter:sw-alpha-fixer'), listed('kid-2', 'Explore', 'running', { parentId: 'orch-b' })]
    p.answers.push('Cancel')
    await clear()
    const q = p.asked[0]!.question
    expect(q).toContain('- a child of part-b: Grep, running for 3 s')
    expect(q).toContain('- fixer (not bound yet): running, between commands')
    expect(q).toContain('- a child of part-b (not bound yet): running, between commands')
  })

  test('an ask that rejects (nobody can answer: -p, an SDK host) holds it, with the same text', async () => {
    busySwarm()
    expect(await clear()).toEqual({ r: { text: CLEAR_HELD }, cleared: false })
    expect(p.logs.some(l => l.includes('/clear held: the ask got no answer'))).toBe(true)
  })

  test('an answer typed under "Other" holds it', async () => {
    busySwarm()
    p.answers.push('clear it please')
    expect(await clear()).toEqual({ r: { text: CLEAR_HELD }, cleared: false })
    expect(state.takeClearKills()).toEqual([])
  })

  test("Clear anyway records the kills for the next <swarm> block and in the launch's ledger, then passes", async () => {
    busySwarm()
    p.answers.push('Clear anyway')
    expect(await clear()).toEqual({ r: ENGINE, cleared: true })
    expect(state.takeClearKills()).toEqual([{ agentId: 'fix-2', who: 'fixer #2 under part-b', tool: 'Bash', detail: '' }])
    const events = (await readLaunchLedger(p, litterDir, 'alpha', LAUNCH)).records.filter(r => r.kind === 'swarm.event')
    expect(events.map(r => r.body)).toEqual([{ kind: 'clear-killed', node: 'fixer', agentId: 'fix-2', tool: 'Bash', detail: '' }])
  })

  test('a run alone (no swarm) is held the same way: its agents are known by their open calls', async () => {
    await atomicWriteJson(p, policyPath(litterDir), { v: 1, session: 'test-session', litterDir, run: runPolicy(litterDir), roles: {}, swarm: null } satisfies Policy)
    // The agent map (policy.ts) knows the run's executor; workflow agents aren't in $.agent.list().
    await p.store.set('litter.agent.exec-1', { agentId: 'exec-1', agentType: 'litter:executor', role: 'executor', run: RUN, cwd: '/repo', started: NOW, stopped: null })
    state.callStart('exec-1', 'tu-npm', 'Bash', NOW - 5000)
    p.answers.push('Cancel')
    expect(await clear()).toEqual({ r: { text: CLEAR_HELD }, cleared: false })
    expect(p.asked[0]!.question).toContain(`- executor in run ${RUN}: Bash, running for 5 s`)
  })

  test("a run's litter role the list shows running holds it too; Clear anyway with no swarm notes no kills", async () => {
    await atomicWriteJson(p, policyPath(litterDir), { v: 1, session: 'test-session', litterDir, run: runPolicy(litterDir), roles: {}, swarm: null } satisfies Policy)
    p.agents = [listed('gc-1', 'litter:gate-critic'), listed('x', 'general-purpose')]
    state.callStart('exec-1', 'tu-npm', 'Bash', NOW - 5000)
    p.answers.push('Clear anyway')
    expect(await clear()).toEqual({ r: ENGINE, cleared: true })
    const q = p.asked[0]!.question
    expect(q).toContain(`- gate-critic in run ${RUN}: running, between commands`)
    expect(q).toContain(`- agent exec-1: Bash, running for 5 s`)
    expect(q).not.toContain('general-purpose')
    // The kills are for a live swarm's <swarm> block; with none live, a later swarm's first block would show them wrongly.
    expect(state.takeClearKills()).toEqual([])
  })

  test("with no active run, a call of no swarm doesn't hold", async () => {
    state.putLiveSwarm(swarm())
    state.callStart('stray', 'tu-1', 'Bash', NOW - 1000)
    expect(await clear()).toEqual({ r: ENGINE, cleared: true })
  })

  test('a thrown error reaches the hook (register.tsx passes the clear on in its catch)', async () => {
    busySwarm()
    p.listAgents = async () => {
      throw new Error('list refused')
    }
    await expect(clear()).rejects.toThrow('list refused')
  })
})
