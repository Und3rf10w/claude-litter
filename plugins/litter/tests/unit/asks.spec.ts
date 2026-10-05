// Tier 2: the permission ask line (hooks/asks.ts; WP-CF, COMMON decision 1).
// An `ask` line pairs with the newest open call start of its agent and tool
// whose detail matches (by tool alone for a file tool), and closes at that
// call's end or deny, the agent's stop, a later call after a rejection, or 15
// minutes; `authorized` says what each role's launch let it do; the notice
// goes once its tool_use_id is known and once on the next tick; the band is
// refreshed on every change; the mirror comes back for its own session only.
// Lines go straight to consumeAsks, as the drain hands them; one case goes
// through the real drain.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SpoolCtx, SpoolLine } from '../../hooks/hookfiles'
import type { AgentInfo } from '../../hooks/policy'
import { drainSpool } from '../../hooks/policy'
import { agentPolicyPath, runDir, runJsonPath, spoolDir, spoolPath } from '../../hooks/layout'
import {
  ASK_STALE_MS,
  ASKS_STORE_KEY,
  CALLS_PER_AGENT,
  MIRROR_FRESH_MS,
  askText,
  asksTick,
  consumeAsks,
  deps,
  openAsks,
  resetAsksForTests,
  restoreAsks,
} from '../../hooks/asks'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const NOW = 1_800_000_000_000
const TS = NOW / 1000
const RUN = '20261005-retry'
const FANOUT = '20261005-split'
const SESSION = 'test-session'

let p: TestPorts
let dir: string
let ctx: SpoolCtx
let refreshed: number
let cleanup: () => void

beforeEach(() => {
  resetAsksForTests()
  const s = scratch()
  dir = s.dir
  cleanup = s.cleanup
  p = nodePorts()
  p.clock.now = NOW
  ctx = { p, litterDir: dir, sessionId: SESSION }
  refreshed = 0
  deps.refreshBand = async () => {
    refreshed++
  }
})

afterEach(() => {
  resetAsksForTests()
  cleanup()
})

// ---------------------------------------------------------------------------
// Lines, as the hooks spool them

const base = (ev: string, ts: number) => ({ v: 1, ev, ts, session_id: SESSION })
const start = (agent: string, tool: string, toolUseId: string, detail?: string, ts = TS) =>
  ({ ...base('call', ts), agent_id: agent, agent_type: 'litter:executor', tool, tool_use_id: toolUseId, phase: 'start', ...(detail === undefined ? {} : { detail }) }) as SpoolLine
const end = (agent: string, toolUseId: string, ts = TS, failed = false) =>
  ({ ...base('call', ts), agent_id: agent, agent_type: 'litter:executor', tool: 'Bash', tool_use_id: toolUseId, phase: 'end', failed }) as SpoolLine
const deny = (agent: string | null, toolUseId: string, ts = TS) =>
  ({ ...base('deny', ts), agent_id: agent, agent_type: 'litter:executor', tool: 'Bash', tool_use_id: toolUseId, reason: 'litter guard: no' }) as SpoolLine
const stop = (agent: string, ts = TS) =>
  ({ ...base('stop', ts), agent_id: agent, agent_type: 'litter:executor', transcript_path: '/t', stop_hook_active: false, background_tasks: 0 }) as SpoolLine
const ask = (agent: string, tool: string, detail: string, ts = TS, agentType: string | null = 'litter:executor') =>
  ({ ...base('ask', ts), agent_id: agent, agent_type: agentType, tool, detail, mode: 'default' }) as SpoolLine

const feed = async (...lines: SpoolLine[]) => {
  for (const l of lines) await consumeAsks(ctx, l)
}

/** The agent map's entry, as consumeAgents writes it at the agent's start. */
function known(agentId: string, agentType: string, run: string | null): void {
  const role = agentType.startsWith('litter:') && !agentType.startsWith('litter:sw-') ? agentType.slice('litter:'.length) : null
  const info: AgentInfo = { agentId, agentType, role, run, cwd: '/repo', started: NOW - 60_000, stopped: null, sessionId: SESSION, transcriptPath: '/t' }
  p.storeMap.set(`litter.agent.${agentId}`, info)
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value)}\n`)
}

/** An execute run's run.json: its verify argv and its gates' Files, as run.start writes them. */
function executeRun(): void {
  writeJson(runJsonPath(runDir(dir, RUN)), {
    v: 1,
    run: RUN,
    workflow: 'execute',
    verify: ['npm', 'test'],
    args: { verifyCommand: 'npm test', gates: [{ id: 'G1', files: ['src/a.ts'] }, { id: 'G2', files: ['lib/**', 'tests/**'] }] },
    authorized: ['edit lib'],
  })
}

const only = () => {
  const open = openAsks()
  expect(open).toHaveLength(1)
  return open[0]!
}

// ---------------------------------------------------------------------------

describe('pairing', () => {
  test('a Bash ask pairs with the open call whose detail matches, not the newest one', async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'npm install left-pad'), start('a1', 'Bash', 'toolu_2', 'npm test'))
    await feed(ask('a1', 'Bash', 'npm install left-pad'))
    expect(only()).toEqual(expect.objectContaining({ agentId: 'a1', tool: 'Bash', detail: 'npm install left-pad', toolUseId: 'toolu_1', since: NOW }))
  })

  test('a file tool pairs by tool alone, the call start carrying no detail', async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'ls'), start('a1', 'Write', 'toolu_2'))
    await feed(ask('a1', 'Write', '/repo/lib/a.ts'))
    expect(only()).toEqual(expect.objectContaining({ tool: 'Write', detail: '/repo/lib/a.ts', toolUseId: 'toolu_2' }))
  })

  test("of two open calls alike, the newest pairs first, and a second ask takes the other; another agent's call never pairs", async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), start('a1', 'Bash', 'toolu_2', 'make'), start('a2', 'Bash', 'toolu_3', 'make'))
    await feed(ask('a1', 'Bash', 'make'))
    expect(only().toolUseId).toBe('toolu_2')
    await feed(ask('a1', 'Bash', 'make', TS + 1))
    expect(openAsks().map(e => e.toolUseId)).toEqual(['toolu_1', 'toolu_2'])
    await feed(ask('a1', 'Bash', 'make', TS + 2))
    expect(openAsks().map(e => e.toolUseId)).toEqual([null, 'toolu_1', 'toolu_2'])
  })

  test('with no matching call the entry opens unpaired, and no notice goes', async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'ls'), start('a1', 'Read', 'toolu_2'))
    await feed(ask('a1', 'Bash', 'npm install'))
    expect(only().toolUseId).toBeNull()
    expect(p.notices).toEqual([])
  })

  test('a call that ended or was denied pairs no more; only the last 20 per agent are kept', async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), end('a1', 'toolu_1'))
    await feed(start('a1', 'Bash', 'toolu_2', 'make'), deny('a1', 'toolu_2'))
    await feed(ask('a1', 'Bash', 'make'))
    expect(only().toolUseId).toBeNull()
    resetAsksForTests()
    p.storeMap.clear()
    deps.refreshBand = async () => {}
    for (let i = 0; i <= CALLS_PER_AGENT; i++) await feed(start('a1', 'Bash', `toolu_${i}`, i === 0 ? 'first' : 'later'))
    await feed(ask('a1', 'Bash', 'first'))
    expect(only().toolUseId).toBeNull()
  })

  test("two alike in one second are a batch's two asks, each with its key; a line delivered again after a reload is the one the mirror kept", async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), start('a1', 'Bash', 'toolu_2', 'make'))
    await feed(ask('a1', 'Bash', 'make'), ask('a1', 'Bash', 'make'))
    const both = openAsks()
    expect(both.map(e => [e.key, e.toolUseId])).toEqual([
      ['a1@1800000000#2', 'toolu_1'],
      ['a1@1800000000', 'toolu_2'],
    ])
    // A crash between delivery and the spool's removal: the drain hands the line over again.
    resetAsksForTests()
    deps.refreshBand = async () => {}
    await feed(ask('a1', 'Bash', 'make'))
    expect(openAsks()).toEqual(both)
  })

  test('the newest is first; texts are cleaned and cut', async () => {
    await feed(ask('a1', 'Bash', 'older', TS - 30), ask('a2', 'Bash', `a\u001b[31mred\u0007${'x'.repeat(200)}`, TS - 10))
    const [first, second] = openAsks()
    expect([first!.agentId, second!.agentId]).toEqual(['a2', 'a1'])
    expect(first!.detail).not.toContain('\u001b')
    expect(first!.detail.length).toBeLessThanOrEqual(120)
  })
})

describe('closing', () => {
  test("its call's end closes it, a failed end too, and the band is refreshed", async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), start('a1', 'Bash', 'toolu_2', 'ls'))
    await feed(ask('a1', 'Bash', 'make'), ask('a1', 'Bash', 'ls'))
    expect(openAsks()).toHaveLength(2)
    refreshed = 0
    await feed(end('a1', 'toolu_9'))
    expect(refreshed).toBe(0)
    await feed(end('a1', 'toolu_1'))
    expect(openAsks().map(e => e.toolUseId)).toEqual(['toolu_2'])
    await feed(end('a1', 'toolu_2', TS, true))
    expect(openAsks()).toEqual([])
    expect(refreshed).toBe(2)
  })

  test('a deny of its call closes it, with or without the agent named', async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), ask('a1', 'Bash', 'make'))
    await feed(deny('a1', 'toolu_1'))
    expect(openAsks()).toEqual([])
    await feed(start('a1', 'Bash', 'toolu_2', 'make'), ask('a1', 'Bash', 'make', TS + 5))
    await feed(deny(null, 'toolu_2'))
    expect(openAsks()).toEqual([])
  })

  test("its agent's stop closes every ask of that agent, and no other's", async () => {
    await feed(ask('a1', 'Bash', 'make'), ask('a1', 'Write', '/repo/x'), ask('a2', 'Bash', 'make'))
    await feed(stop('a1'))
    expect(openAsks().map(e => e.agentId)).toEqual(['a2'])
  })

  test('a later call of the same agent closes it (a rejected dialog raises nothing); a sibling started within a second does not', async () => {
    await feed(start('a1', 'Read', 'toolu_1'), ask('a1', 'Read', '/etc/hosts'))
    // The batch's other calls start side by side with the asking one.
    await feed(start('a1', 'Read', 'toolu_2', undefined, TS), start('a1', 'Grep', 'toolu_3', undefined, TS + 1))
    await feed(start('a2', 'Bash', 'toolu_4', 'make', TS + 30))
    expect(only().toolUseId).toBe('toolu_1')
    refreshed = 0
    // After you rejected it, the model's next call.
    await feed(start('a1', 'Bash', 'toolu_5', 'make', TS + 20))
    expect(openAsks()).toEqual([])
    expect(refreshed).toBe(1)
  })

  test('15 minutes open: the tick closes it as stale, logs it and refreshes the band; an ask line that old is never opened', async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), ask('a1', 'Bash', 'make'))
    p.clock.now = NOW + ASK_STALE_MS
    await asksTick(p)
    expect(openAsks()).toHaveLength(1)
    refreshed = 0
    p.clock.now = NOW + ASK_STALE_MS + 1
    await asksTick(p)
    expect(openAsks()).toEqual([])
    expect(refreshed).toBe(1)
    expect(p.logs.filter(l => l.includes('closed as stale'))).toHaveLength(1)
    await feed(ask('a1', 'Bash', 'make', TS))
    expect(openAsks()).toEqual([])
    expect(p.logs.filter(l => l.includes('not shown (stale)'))).toHaveLength(1)
  })

  test("calls older than 15 minutes are forgotten at the tick and pair no more", async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'))
    p.clock.now = NOW + ASK_STALE_MS + 1_000
    await asksTick(p)
    await feed(ask('a1', 'Bash', 'make', TS + ASK_STALE_MS / 1000))
    expect(only().toolUseId).toBeNull()
  })
})

describe('authorized, run, role, gate, swarm and node', () => {
  test("an execute executor: its run, its gate from its label, the verify command and the gate's Files", async () => {
    executeRun()
    known('a1', 'litter:executor', RUN)
    p.agents = [{ id: 'a1', description: 'write:G2#1', type: 'litter:executor', status: 'running' }]
    await feed(start('a1', 'Bash', 'toolu_1', 'npm install left-pad'), ask('a1', 'Bash', 'npm install left-pad'))
    const e = only()
    expect(e).toEqual(expect.objectContaining({ run: RUN, role: 'executor', gate: 'G2', swarm: null, node: null, authorized: 'verify npm test · Files lib/** tests/**' }))
    expect(askText(e)).toBe('G2 executor wants Bash: npm install left-pad · authorized: verify npm test · Files lib/** tests/**')
  })

  test("an execute executor that isn't listed: no gate, and the checkout it writes in", async () => {
    executeRun()
    known('a1', 'litter:executor', RUN)
    await feed(ask('a1', 'Bash', 'make'))
    expect(only()).toEqual(expect.objectContaining({ gate: null, authorized: 'verify npm test · writes in the checkout' }))
  })

  test("a gate critic: read only, with its gate", async () => {
    executeRun()
    known('c1', 'litter:gate-critic', RUN)
    p.agents = [{ id: 'c1', description: 'critic:G1#2', type: 'litter:gate-critic', status: 'running' }]
    await feed(ask('c1', 'Bash', 'npm run lint', TS, 'litter:gate-critic'))
    expect(only()).toEqual(expect.objectContaining({ role: 'gate-critic', gate: 'G1', authorized: 'read only' }))
  })

  test("a fanout writer: its task's files, from its binding", async () => {
    writeJson(runJsonPath(runDir(dir, FANOUT)), { v: 1, run: FANOUT, workflow: 'fanout', verify: null, args: {}, authorized: [] })
    known('w1', 'litter:executor', FANOUT)
    writeJson(agentPolicyPath(dir, 'w1'), { v: 1, run: FANOUT, task: { id: '3', owned: ['src/api/**'] }, worktree: { name: 'w', path: '/w', branch: 'b' } })
    await feed(ask('w1', 'Bash', 'npm install'))
    expect(only()).toEqual(expect.objectContaining({ run: FANOUT, role: 'executor', gate: null, authorized: "task 3's files: src/api/**" }))
  })

  test("a design prober: its own worktree", async () => {
    known('pr1', 'litter:prober', '20261005-currency')
    await feed(ask('pr1', 'Bash', 'cargo build', TS, 'litter:prober'))
    expect(only()).toEqual(expect.objectContaining({ run: '20261005-currency', role: 'prober', authorized: 'writes in its own worktree' }))
  })

  test("a node: its swarm, node and write scope under its directory; a child: its node's", async () => {
    const node = { swarm: 'review', launch: 'l1', node: 'fixer', n: 1, kind: 'worker', of: null, type: 'litter:sw-review-fixer', parent: 'o1', generation: 1, dir: '/repo', paths: ['/repo/server/', '/repo/README.md'], protect: [], branch: null, authority: {}, toolsDeny: [], bashDeny: [], spawns: [], spawnOther: false, admitted: true, stopped: null, bind: false }
    writeJson(agentPolicyPath(dir, 'n1'), { v: 1, node })
    writeJson(agentPolicyPath(dir, 'k1'), { v: 1, node: { ...node, kind: 'child', n: 0, of: 'n1', parent: 'n1', paths: null } })
    known('n1', 'litter:sw-review-fixer', null)
    await feed(ask('n1', 'Bash', 'git push', TS - 1, 'litter:sw-review-fixer'), ask('k1', 'Write', '/repo/x', TS, 'general-purpose'))
    const [child, fixer] = openAsks()
    expect(fixer).toEqual(expect.objectContaining({ run: null, role: null, swarm: 'review', node: 'fixer', authorized: 'write scope server/ README.md' }))
    expect(child).toEqual(expect.objectContaining({ swarm: 'review', node: 'fixer', authorized: 'write scope anywhere' }))
    expect(askText(fixer!)).toBe('node fixer of swarm review wants Bash: git push · authorized: write scope server/ README.md')
    expect(askText(child!)).toStartWith('a child of node fixer of swarm review wants Write: /repo/x')
  })

  test("an unreadable binding or run.json is logged, and the ask still opens", async () => {
    mkdirSync(join(dir, 'hooks', 'agents'), { recursive: true })
    writeFileSync(agentPolicyPath(dir, 'a1'), '{ not json')
    known('a1', 'litter:executor', RUN)
    mkdirSync(runDir(dir, RUN), { recursive: true })
    writeFileSync(runJsonPath(runDir(dir, RUN)), 'nope')
    await feed(ask('a1', 'Bash', 'make'))
    expect(only()).toEqual(expect.objectContaining({ run: RUN, role: 'executor', authorized: 'writes in the checkout' }))
    expect(p.logs.some(l => l.includes('agents/a1.json is unreadable'))).toBe(true)
  })

  test('an agent id that could reach a path opens nothing', async () => {
    await feed(ask('../a1', 'Bash', 'make'))
    expect(openAsks()).toEqual([])
  })
})

describe('the notice', () => {
  test('sent once its tool_use_id is known and once on the next tick, never after, nor after it closes', async () => {
    executeRun()
    known('a1', 'litter:executor', RUN)
    p.agents = [{ id: 'a1', description: 'write:G2#1', type: 'litter:executor', status: 'running' }]
    await feed(start('a1', 'Bash', 'toolu_1', 'npm install left-pad'), ask('a1', 'Bash', 'npm install left-pad'))
    const text = '⚑ asking · G2 executor wants Bash: npm install left-pad · authorized: verify npm test · Files lib/** tests/**'
    expect(p.notices).toEqual([{ toolUseId: 'toolu_1', text }])
    await asksTick(p)
    expect(p.notices).toEqual([
      { toolUseId: 'toolu_1', text },
      { toolUseId: 'toolu_1', text },
    ])
    await asksTick(p)
    expect(p.notices).toHaveLength(2)
    // A second ask, closed before the tick: its one notice, and none after.
    await feed(start('a1', 'Bash', 'toolu_2', 'make', TS + 30), ask('a1', 'Bash', 'make', TS + 30))
    expect(p.notices).toHaveLength(3)
    await feed(end('a1', 'toolu_2', TS + 31))
    await asksTick(p)
    expect(p.notices.map(n => n.toolUseId)).toEqual(['toolu_1', 'toolu_1', 'toolu_2'])
  })

  test('a notice that throws is logged, and counts', async () => {
    p.noticeAnswer = false
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), ask('a1', 'Bash', 'make'))
    await asksTick(p)
    await asksTick(p)
    expect(p.notices).toHaveLength(2)
    expect(p.logs.filter(l => l.includes('$.ui.notice threw'))).toHaveLength(2)
  })
})

describe('the band', () => {
  test('refreshed after every open and close, not after a call that changes no ask; its failure is logged', async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'))
    expect(refreshed).toBe(0)
    await feed(ask('a1', 'Bash', 'make'))
    expect(refreshed).toBe(1)
    await feed(start('a2', 'Bash', 'toolu_2', 'ls'), end('a2', 'toolu_2'), stop('a2'))
    expect(refreshed).toBe(1)
    deps.refreshBand = async () => {
      throw new Error('no band')
    }
    await feed(end('a1', 'toolu_1'))
    expect(openAsks()).toEqual([])
    expect(p.logs.some(l => l.includes("the band wasn't refreshed") && l.includes('no band'))).toBe(true)
  })
})

describe('the mirror', () => {
  const mirrored = () => p.storeMap.get(ASKS_STORE_KEY) as { session: string; at: number; asks: { key: string }[]; calls: Record<string, { toolUseId: string }[]> } | undefined

  test('written with the session id on every open and close, and by the tick for calls alone', async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'))
    expect(mirrored()).toBeUndefined()
    await asksTick(p)
    expect(mirrored()).toEqual(expect.objectContaining({ session: SESSION, at: NOW, asks: [] }))
    expect(mirrored()!.calls.a1!.map(c => c.toolUseId)).toEqual(['toolu_1'])
    await feed(ask('a1', 'Bash', 'make'))
    expect(mirrored()!.asks.map(a => a.key)).toEqual(['a1@1800000000'])
    await feed(end('a1', 'toolu_1'), stop('a1'))
    expect(p.storeMap.has(ASKS_STORE_KEY)).toBe(false)
  })

  test("restored for this session after a reload: the open asks, and the calls an ask then pairs with", async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), ask('a1', 'Bash', 'make'), start('a2', 'Bash', 'toolu_2', 'ls'))
    await asksTick(p)
    const before = openAsks()
    // A reload: module memory gone, the store kept.
    resetAsksForTests()
    deps.refreshBand = async () => {
      refreshed++
    }
    refreshed = 0
    p.clock.now = NOW + 5_000
    await restoreAsks(p)
    expect(openAsks()).toEqual(before)
    expect(refreshed).toBe(1)
    await feed(ask('a2', 'Bash', 'ls', TS + 5))
    expect(openAsks().map(e => e.toolUseId)).toEqual(['toolu_2', 'toolu_1'])
    // The notices carried over: a1's ask had both before the reload, a2's new one gets its second at the tick, and that's all.
    p.notices.length = 0
    await asksTick(p)
    await asksTick(p)
    expect(p.notices.map(n => n.toolUseId)).toEqual(['toolu_2'])
  })

  test("the drain's lines at session.start apply after the mirror: an end drained first still closes a restored ask", async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), ask('a1', 'Bash', 'make'))
    resetAsksForTests()
    deps.refreshBand = async () => {}
    await feed(end('a1', 'toolu_1'))
    await restoreAsks(p)
    expect(openAsks()).toEqual([])
  })

  test("another session's mirror is ignored, and so is one that's not version 1", async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), ask('a1', 'Bash', 'make'))
    const saved = p.storeMap.get(ASKS_STORE_KEY) as Record<string, unknown>
    resetAsksForTests()
    p.storeMap.set(ASKS_STORE_KEY, { ...saved, session: 'another-session' })
    await restoreAsks(p)
    expect(openAsks()).toEqual([])
    resetAsksForTests()
    p.storeMap.set(ASKS_STORE_KEY, { ...saved, v: 2 })
    await restoreAsks(p)
    expect(openAsks()).toEqual([])
    resetAsksForTests()
    p.storeMap.set(ASKS_STORE_KEY, { ...saved, asks: [{ key: 'x' }, 'junk'], calls: { '../a': [{}], a1: 'junk' } })
    await restoreAsks(p)
    expect(openAsks()).toEqual([])
  })

  test("asks older than 15 minutes are dropped; a mirror the tick stopped refreshing is a gone process's, and its asks aren't restored", async () => {
    await feed(ask('a1', 'Bash', 'old', TS - 600), start('a2', 'Bash', 'toolu_2', 'make'), ask('a2', 'Bash', 'make'))
    resetAsksForTests()
    p.clock.now = NOW + ASK_STALE_MS - 300_000 + 1
    // A reload soon after the last write: the old one goes, the other comes back.
    const saved = p.storeMap.get(ASKS_STORE_KEY) as Record<string, unknown>
    p.storeMap.set(ASKS_STORE_KEY, { ...saved, at: p.clock.now - 1_000 })
    await restoreAsks(p)
    expect(openAsks().map(e => e.agentId)).toEqual(['a2'])
    // A resume long after: nothing restored, and it says so.
    resetAsksForTests()
    p.storeMap.set(ASKS_STORE_KEY, { ...saved, at: NOW })
    p.clock.now = NOW + MIRROR_FRESH_MS + 1
    await restoreAsks(p)
    expect(openAsks()).toEqual([])
    expect(p.logs.some(l => l.includes("saved by a process that's gone"))).toBe(true)
  })

  test('the tick refreshes the mirror every 10 s while an ask is open', async () => {
    await feed(ask('a1', 'Bash', 'make'))
    expect(mirrored()!.at).toBe(NOW)
    p.clock.now = NOW + 4_000
    await asksTick(p)
    expect(mirrored()!.at).toBe(NOW)
    p.clock.now = NOW + 10_000
    await asksTick(p)
    expect(mirrored()!.at).toBe(NOW + 10_000)
  })
})

describe('through the real drain', () => {
  test("guard.sh's call start, then ask.sh's line, in one spool file: one paired ask", async () => {
    mkdirSync(spoolDir(dir), { recursive: true })
    const lines = [start('a1', 'Bash', 'toolu_1', 'npm install left-pad'), ask('a1', 'Bash', 'npm install left-pad')]
    writeFileSync(spoolPath(dir, SESSION), `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
    expect(await drainSpool(ctx, [consumeAsks])).toEqual({ lines: 2, bad: 0 })
    expect(only()).toEqual(expect.objectContaining({ toolUseId: 'toolu_1', detail: 'npm install left-pad' }))
    expect(refreshed).toBe(1)
  })
})
