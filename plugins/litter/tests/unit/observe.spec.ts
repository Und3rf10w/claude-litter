// Tier 2: what the mod learns about running nodes (hooks/swarm/observe.ts;
// WP-P): the spool consumer's in-flight table, shells, denials, stops,
// hand-backs, holds and lost isolation; a node's turn.complete (tokens, the
// answer as its report, an aborted turn, the branch checks against real git);
// and [That was me].

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { SpoolLine } from '../../hooks/hookfiles'
import { modePath } from '../../hooks/layout'
import { appendLaunchRecord, newLaunchId, readLaunchLedger } from '../../hooks/records/swarm'
import { updateSession } from '../../hooks/session'
import { others } from '../../hooks/swarm/end'
import { ackBranchMoved, branchTips, consumeSwarm, observeNodeTurn, resetObserveForTests } from '../../hooks/swarm/observe'
import * as state from '../../hooks/swarm/state'
import type { LiveSwarm, NodeBinding } from '../../hooks/swarm/types'
import { nodePorts, runAfters, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// Real git in the branch checks; a loaded machine takes seconds.
setDefaultTimeout(120_000)

const T0 = 1_800_000_000_000

let p: TestPorts
let dir: string
let litterDir: string
let launch: string
let commonDir: string
let cleanup: () => void
let git: (...argv: string[]) => Promise<string>
let triggers: { swarm: string; why: string }[]
const saved = { ...others }

const swarmOf = (over: Partial<LiveSwarm> = {}): LiveSwarm => ({
  name: 'alpha',
  launch,
  revision: 1,
  spec: {
    name: 'alpha',
    goal: 'fix the parser',
    nodes: [
      { id: 'boss', kind: 'orchestrator', spawns: { fixer: 2 } },
      { id: 'fixer', kind: 'worker', worktree: 'own' },
    ],
  },
  nonce: 'n0nce',
  types: { boss: 'litter:sw-alpha-boss', fixer: 'litter:sw-alpha-fixer' },
  typesReady: true,
  dirs: {},
  sessionCwd: dir,
  worktreeRoot: join(realpathSync(dir), '.claude', 'worktrees'),
  commonDir,
  roots: { litterDir, litterCopies: [litterDir], ruleDirs: [] },
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
  launch,
  node: 'fixer',
  n: 1,
  kind: 'worker',
  of: null,
  parent: 'a-boss',
  type: 'litter:sw-alpha-fixer',
  cwd: dir,
  branch: null,
  token: `tok-${agentId}`,
  revision: 1,
  generation: 1,
  boundAt: T0,
  adopted: false,
  ...over,
})

const BOSS = (): NodeBinding => bindingOf('a-boss', { node: 'boss', kind: 'orchestrator', parent: null, type: 'litter:sw-alpha-boss' })

const ctx = () => ({ p, litterDir, sessionId: 'test-session' })
const base = { v: 1 as const, ts: T0 / 1000, session_id: 'test-session' }
const feed = (line: Record<string, unknown>) => consumeSwarm(ctx(), { ...base, ...line } as SpoolLine)
const callLine = (agent_id: string, tool_use_id: string, phase: 'start' | 'end', over: Record<string, unknown> = {}) =>
  feed({ ev: 'call', agent_id, agent_type: 'litter:sw-alpha-fixer', tool: 'Bash', tool_use_id, phase, ...over })

/** The launch's swarm.event bodies, each with its record's seq (an ack's own `seq` field wins). */
const events = async (): Promise<Record<string, unknown>[]> =>
  (await readLaunchLedger(p, litterDir, 'alpha', launch)).records.filter(r => r.kind === 'swarm.event').map(r => ({ seq: r.seq, ...r.body }))

type Turn = Parameters<typeof observeNodeTurn>[1]
const turn = (agentId: string, over: Partial<Record<string, unknown>> = {}): Turn =>
  ({ answer: '', durationMs: 1000, isAborted: false, turnId: 't1', agentId, reason: 'answer', ...over }) as Turn

beforeEach(async () => {
  state.resetForTests()
  resetObserveForTests()
  p = nodePorts({ cwd: '/' })
  p.clock.now = T0
  ;({ dir, cleanup } = scratch())
  ;({ git } = await scratchRepo(p, dir))
  await p.fs.write(join(dir, '.gitignore'), '.env\n.claude/\nnode_modules\n')
  await git('add', '.gitignore')
  await git('commit', '-q', '-m', 'ignore')
  litterDir = join(dir, '.claude', 'litter')
  commonDir = realpathSync(join(dir, '.git'))
  launch = await newLaunchId(p, litterDir, 'alpha')
  updateSession({ litterDir })
  triggers = []
  others.noteSummaryTrigger = (swarm, why) => void triggers.push({ swarm, why })
})

afterEach(() => {
  Object.assign(others, saved)
  updateSession({ litterDir: null })
  state.resetForTests()
  resetObserveForTests()
  cleanup()
})

/** The swarm live, tips taken now, with the boss and one fixer bound. */
async function live(over: Partial<LiveSwarm> = {}, fixer: Partial<NodeBinding> = {}) {
  state.putLiveSwarm(swarmOf({ tips: (await branchTips(p, commonDir)) ?? {}, ...over }))
  state.putBinding(BOSS())
  state.putBinding(bindingOf('a-fix1', fixer))
}

describe('consumeSwarm', () => {
  test('call starts and ends balance, and a background shell is recorded at its end', async () => {
    await live()
    await callLine('a-fix1', 'tu-1', 'start', { detail: 'npm test' })
    await callLine('a-fix1', 'tu-2', 'start', { detail: 42 })
    expect(state.inflight().map(c => [c.agentId, c.toolUseId, c.tool, c.detail, c.swarm, c.at])).toEqual([
      ['a-fix1', 'tu-1', 'Bash', 'npm test', 'alpha', T0],
      ['a-fix1', 'tu-2', 'Bash', '', 'alpha', T0],
    ])
    await callLine('a-fix1', 'tu-1', 'end', { shell: 'bsh_42' })
    expect(state.inflight().map(c => c.toolUseId)).toEqual(['tu-2'])
    expect(state.shells('alpha').map(s => [s.shellId, s.agentId])).toEqual([['bsh_42', 'a-fix1']])
    await callLine('a-fix1', 'tu-2', 'end', { failed: true })
    expect(state.inflight()).toEqual([])
    // A shell id that could be anything but an engine id never reaches TaskStop.
    await callLine('a-fix1', 'tu-3', 'end', { shell: 'x; rm -rf /' })
    expect(state.shells().length).toBe(1)
  })

  test("a run agent's calls are tracked too, but no shell, report or event of it", async () => {
    await live()
    await feed({ ev: 'call', agent_id: 'run-exec', agent_type: 'litter:executor', tool: 'Bash', tool_use_id: 'tu-r', phase: 'start' })
    expect(state.inflight().map(c => [c.agentId, c.swarm])).toEqual([['run-exec', null]])
    await feed({ ev: 'call', agent_id: 'run-exec', agent_type: 'litter:executor', tool: 'Bash', tool_use_id: 'tu-r', phase: 'end', shell: 'bsh_1' })
    expect(state.inflight()).toEqual([])
    expect(state.shells()).toEqual([])
    await feed({ ev: 'handback', agent_id: 'run-exec', agent_type: 'litter:executor', tool_use_id: 'h', message: 'done' })
    expect(await events()).toEqual([])
  })

  test('a deny closes its call and records `denied` for a node', async () => {
    await live()
    await callLine('a-fix1', 'tu-1', 'start')
    await feed({ ev: 'deny', agent_id: 'a-fix1', agent_type: 'litter:sw-alpha-fixer', tool: 'Edit', tool_use_id: 'tu-1', reason: 'litter guard: outside paths' })
    expect(state.inflight()).toEqual([])
    expect(await events()).toEqual([
      expect.objectContaining({ kind: 'denied', node: 'fixer', agentId: 'a-fix1', tool: 'Edit', reason: 'litter guard: outside paths' }),
    ])
    expect(triggers).toEqual([{ swarm: 'alpha', why: 'denied' }])
  })

  test('a SubagentStop closes every call the agent left open, and is noted for the settle wait', async () => {
    await live()
    await callLine('a-fix1', 'tu-1', 'start')
    await callLine('a-fix1', 'tu-2', 'start')
    await callLine('a-boss', 'tu-b', 'start', { agent_type: 'litter:sw-alpha-boss' })
    await feed({ ev: 'stop', agent_id: 'a-fix1', agent_type: 'litter:sw-alpha-fixer', transcript_path: '/t', stop_hook_active: false, background_tasks: 0 })
    expect(state.inflight().map(c => c.agentId)).toEqual(['a-boss'])
    expect(state.agentStopped('a-fix1')).toBe(true)
    expect(state.agentStopped('a-boss')).toBe(false)
  })

  test("a hand-back is the node's report and a `report` event", async () => {
    await live()
    await feed({ ev: 'handback', agent_id: 'a-boss', agent_type: 'litter:sw-alpha-boss', tool_use_id: 'h1', message: 'Parser fixed.\nAll tests pass.' })
    expect(state.lastReport('a-boss')).toEqual({ text: 'Parser fixed.\nAll tests pass.', via: 'handback', at: T0 })
    expect(await events()).toEqual([
      expect.objectContaining({ kind: 'report', node: 'boss', agentId: 'a-boss', via: 'handback', text: 'Parser fixed.\nAll tests pass.' }),
    ])
    expect(triggers).toEqual([{ swarm: 'alpha', why: 'report' }])
    // The same line again (a crash mid-drain) records nothing more.
    await feed({ ev: 'handback', agent_id: 'a-boss', agent_type: 'litter:sw-alpha-boss', tool_use_id: 'h1', message: 'Parser fixed.\nAll tests pass.' })
    expect((await events()).length).toBe(1)
  })

  test("a worker's hand-back that reached the lead is `report-to-lead`, found now or at the recheck", async () => {
    await live()
    const frame = (from: string, text: string) => ({
      role: 'user' as const,
      text: `<agent-message from="${from}">\n[Subagent hand-back] ${from} handed back:\n  ${text}\n</agent-message>`,
      toolUses: [],
    })
    p.transcripts.main = [frame('a-fix1', 'Fixed the lexer.')]
    await feed({ ev: 'handback', agent_id: 'a-fix1', agent_type: 'litter:sw-alpha-fixer', tool_use_id: 'h1', message: 'Fixed the lexer.' })
    expect((await events()).map(e => e.kind)).toEqual(['report', 'report-to-lead'])

    // Not in the lead's transcript yet: looked for once more later.
    state.putBinding(bindingOf('a-fix2', { n: 2 }))
    await feed({ ev: 'handback', agent_id: 'a-fix2', agent_type: 'litter:sw-alpha-fixer', tool_use_id: 'h2', message: 'Fixed the printer.' })
    expect((await events()).map(e => e.kind)).toEqual(['report', 'report-to-lead', 'report'])
    p.transcripts.main.push(frame('a-fix2', 'Fixed the printer.'))
    p.clock.now = T0 + 30_000
    expect(await runAfters(p)).toBe(1)
    expect((await events()).map(e => [e.kind, e.agentId])).toEqual([
      ['report', 'a-fix1'],
      ['report-to-lead', 'a-fix1'],
      ['report', 'a-fix2'],
      ['report-to-lead', 'a-fix2'],
    ])
  })

  test("an orchestrator's hand-back went to the lead, its parent: never `report-to-lead`", async () => {
    await live()
    p.transcripts.main = [{ role: 'user', text: '<agent-message from="a-boss">\n[Subagent hand-back]\n  Done.\n</agent-message>', toolUses: [] }]
    await feed({ ev: 'handback', agent_id: 'a-boss', agent_type: 'litter:sw-alpha-boss', tool_use_id: 'h1', message: 'Done.' })
    expect((await events()).map(e => e.kind)).toEqual(['report'])
    expect(p.afters).toEqual([])
  })

  /** Children c1 and c2 of a-fix1, bound and running. */
  const children = () => {
    for (const id of ['c1', 'c2']) {
      state.putBinding(bindingOf(id, { kind: 'child', of: 'a-fix1', parent: 'a-fix1', n: 0, type: 'general-purpose' }))
      state.markRunning(id)
    }
  }

  test('a hold timeout records `worker-ended-early`, a release `held`', async () => {
    await live()
    children()
    await feed({ ev: 'hold', agent_id: 'a-fix1', phase: 'held', children: ['c1'] })
    await feed({ ev: 'hold', agent_id: 'a-fix1', phase: 'timeout', children: ['c1', 'c2'] })
    await feed({ ev: 'hold', agent_id: 'a-fix1', phase: 'released', children: ['c1'] })
    expect((await events()).map(e => [e.kind, e.node, e.children])).toEqual([
      ['worker-ended-early', 'fixer', ['c1', 'c2']],
      ['held', 'fixer', ['c1']],
    ])
  })

  // R3, R11: a timeout is a worker ending its turn while children run, so only children still
  // running count; a listing that failed to the cap names none, and the worker's own stand in.
  test("a hold timeout names only children still running, and without names the worker's own", async () => {
    await live()
    children()
    state.noteAgentStopped('c2')
    await feed({ ev: 'hold', agent_id: 'a-fix1', phase: 'timeout', children: ['c1', 'c2', 'gone'] })
    await feed({ ev: 'hold', agent_id: 'a-fix1', phase: 'timeout', children: [] })
    state.noteAgentStopped('c1')
    await feed({ ev: 'hold', agent_id: 'a-fix1', phase: 'timeout', children: [] })
    await feed({ ev: 'hold', agent_id: 'a-fix1', phase: 'timeout', children: ['c1', 'c2'] })
    expect((await events()).map(e => [e.kind, e.children])).toEqual([
      ['worker-ended-early', ['c1']],
      ['worker-ended-early', ['c1']],
    ])
  })

  test("lost isolation flags the swarm once, and records it once per agent", async () => {
    await live()
    const line = { ev: 'isolation-lost', agent_id: 'a-fix1', agent_type: 'litter:sw-alpha-fixer', tool: 'Bash', cwd: '/elsewhere', expected: '/wt', source: 'guard' }
    await feed(line)
    await feed(line)
    expect(state.liveSwarm('alpha')!.flags.isolationLost).toBe(true)
    expect(await events()).toEqual([
      expect.objectContaining({ kind: 'isolation-lost', node: 'fixer', agentId: 'a-fix1', tool: 'Bash', cwd: '/elsewhere', expected: '/wt' }),
    ])
  })

  test('an unknown agent, an agent-summary fork, and a read-only or lost swarm change nothing', async () => {
    await live()
    const lines = (agent_id: string, agent_type: string) => [
      { ev: 'call', agent_id, agent_type, tool: 'Bash', tool_use_id: 'tu-x', phase: 'start' },
      { ev: 'deny', agent_id, agent_type, tool: 'Bash', tool_use_id: 'tu-x', reason: 'r' },
      { ev: 'handback', agent_id, agent_type, tool_use_id: 'h', message: 'report' },
      { ev: 'hold', agent_id, phase: 'timeout', children: [] },
      { ev: 'isolation-lost', agent_id, agent_type, tool: 'Bash', cwd: '/x', expected: null, source: 'watch' },
    ]
    for (const line of lines('stranger', 'general-purpose')) await feed(line)
    // A fork has the node's id and an empty type (15.9, item 18); its hold line carries no type, so leave that one out.
    for (const line of lines('a-fix1', '').filter(l => l.ev !== 'hold')) await feed(line)
    expect(state.inflight()).toEqual([])
    expect(state.lastReport('a-fix1')).toBeNull()
    expect(state.liveSwarm('alpha')!.flags.isolationLost).toBe(false)
    expect(await events()).toEqual([])
    expect(triggers).toEqual([])

    for (const flag of [{ readOnly: true }, { lost: true }]) {
      state.patchLiveSwarm('alpha', { readOnly: false, lost: false, ...flag })
      for (const line of lines('a-fix1', 'litter:sw-alpha-fixer')) await feed(line)
      expect(state.inflight()).toEqual([])
      expect(await events()).toEqual([])
    }
  })
})

describe('observeNodeTurn', () => {
  const usage = (input: number, output: number) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: 5, cache_creation_input_tokens: 1, model: 'm' })

  test('tokens are summed over turns, an interrupted one counting as a turn', async () => {
    await live()
    await observeNodeTurn(p, turn('a-fix1', { usage: usage(100, 20) }))
    await observeNodeTurn(p, turn('a-fix1', { usage: usage(50, 10) }))
    await observeNodeTurn(p, turn('a-fix1', { isAborted: true, reason: 'aborted' }))
    expect(state.tokens('a-fix1')).toEqual({ input: 150, output: 30, cacheRead: 10, cacheCreation: 2, turns: 3 })
  })

  test("an aborted turn closes the node's open calls and records no report", async () => {
    await live()
    await callLine('a-fix1', 'tu-1', 'start')
    await callLine('a-boss', 'tu-b', 'start', { agent_type: 'litter:sw-alpha-boss' })
    await observeNodeTurn(p, turn('a-fix1', { isAborted: true, reason: 'aborted', answer: 'half a thought' }))
    expect(state.inflight().map(c => c.agentId)).toEqual(['a-boss'])
    expect((await events()).filter(e => e.kind === 'report')).toEqual([])
  })

  test('outside auto mode the answer is the report; in auto mode, or after a hand-back this turn, it is not', async () => {
    await live()
    await observeNodeTurn(p, turn('a-boss', { answer: 'Half done; fixer #1 is on the lexer.' }))
    expect(state.lastReport('a-boss')).toEqual({ text: 'Half done; fixer #1 is on the lexer.', via: 'answer', at: T0 })
    expect(triggers).toEqual([{ swarm: 'alpha', why: 'finished' }])

    await feed({ ev: 'handback', agent_id: 'a-fix1', agent_type: 'litter:sw-alpha-fixer', tool_use_id: 'h', message: 'Lexer fixed.' })
    await observeNodeTurn(p, turn('a-fix1', { answer: 'Lexer fixed, I think.' }))
    expect(state.lastReport('a-fix1')!.via).toBe('handback')

    await p.fs.write(modePath(litterDir), 'auto\n')
    await observeNodeTurn(p, turn('a-boss', { answer: 'Should not be the report.' }))
    expect(state.lastReport('a-boss')!.text).toBe('Half done; fixer #1 is on the lexer.')
    expect((await events()).filter(e => e.kind === 'report').map(e => [e.agentId, e.via])).toEqual([
      ['a-boss', 'answer'],
      ['a-fix1', 'handback'],
    ])
  })

  test("a branch that moved and isn't a running node's bound one is `branch-moved`, naming the running nodes", async () => {
    await git('branch', 'feature/x')
    await live()
    state.markRunning('a-boss')
    // Moves litter makes itself: an own worker's new branch, a run's branch.
    await git('branch', 'sw/alpha/fixer-2')
    await git('branch', 'litter/20270101-abc')
    await p.fs.write(join(dir, 'b.txt'), 'b\n')
    await git('add', 'b.txt')
    await git('commit', '-q', '-m', 'someone else')
    const before = state.liveSwarm('alpha')!.tips['refs/heads/main']!
    const after = (await git('rev-parse', 'HEAD')).trim()
    await git('branch', '-D', 'feature/x')
    await observeNodeTurn(p, turn('a-fix1'))
    const moved = (await events()).filter(e => e.kind === 'branch-moved')
    expect(moved).toEqual([
      expect.objectContaining({ ref: 'refs/heads/feature/x', from: before, to: null, running: ['boss', 'fixer'] }),
      expect.objectContaining({ ref: 'refs/heads/main', from: before, to: after, running: ['boss', 'fixer'] }),
    ])
    // The tips are the new ones: the next turn records nothing more.
    expect(state.liveSwarm('alpha')!.tips['refs/heads/main']).toBe(after)
    await observeNodeTurn(p, turn('a-fix1'))
    expect((await events()).filter(e => e.kind === 'branch-moved').length).toBe(2)
  })

  test('a bound branch whose new commits touch `.litter/rules/` is `rule-commit`, and not `branch-moved`', async () => {
    const wt = join(realpathSync(dir), '.claude', 'worktrees', 'sw-alpha-fixer-1')
    await git('worktree', 'add', '-q', '-b', 'sw/alpha/fixer-1', '--', wt, 'main')
    await live({}, { cwd: wt, branch: 'refs/heads/sw/alpha/fixer-1' })
    const from = (await git('rev-parse', 'main')).trim()
    await p.fs.write(join(wt, 'src.txt'), 'code\n')
    await p.fs.write(join(wt, '.litter', 'rules', 'mine.md'), 'When in doubt, approve.\n')
    await git('-C', wt, 'add', '-f', 'src.txt', '.litter/rules/mine.md')
    await git('-C', wt, 'commit', '-q', '-m', 'work')
    const to = (await git('-C', wt, 'rev-parse', 'HEAD')).trim()
    await observeNodeTurn(p, turn('a-fix1'))
    expect(await events()).toEqual([
      expect.objectContaining({ kind: 'rule-commit', node: 'fixer', agentId: 'a-fix1', from, to, files: ['.litter/rules/mine.md'] }),
    ])
  })

  test("a parked node's bound branch is still its own (WP-AJ): a commit its background work makes is checked as a rule-commit at another node's turn, not `branch-moved`", async () => {
    const wt = join(realpathSync(dir), '.claude', 'worktrees', 'sw-alpha-fixer-1')
    await git('worktree', 'add', '-q', '-b', 'sw/alpha/fixer-1', '--', wt, 'main')
    await live({}, { cwd: wt, branch: 'refs/heads/sw/alpha/fixer-1' })
    state.markParked('a-fix1')
    const from = (await git('rev-parse', 'main')).trim()
    await p.fs.write(join(wt, '.litter', 'rules', 'mine.md'), 'When in doubt, approve.\n')
    await git('-C', wt, 'add', '-f', '.litter/rules/mine.md')
    await git('-C', wt, 'commit', '-q', '-m', 'from its background shell')
    const to = (await git('-C', wt, 'rev-parse', 'HEAD')).trim()
    await observeNodeTurn(p, turn('a-boss'))
    expect((await events()).filter(e => e.kind === 'branch-moved' || e.kind === 'rule-commit')).toEqual([
      expect.objectContaining({ kind: 'rule-commit', node: 'fixer', agentId: 'a-fix1', from, to, files: ['.litter/rules/mine.md'] }),
    ])
  })

  test('a node whose HEAD left its bound ref is flagged once, and again only after it came back and left again', async () => {
    const wt = join(realpathSync(dir), '.claude', 'worktrees', 'sw-alpha-fixer-1')
    await git('worktree', 'add', '-q', '-b', 'sw/alpha/fixer-1', '--', wt, 'main')
    await live({}, { cwd: wt, branch: 'refs/heads/sw/alpha/fixer-1' })
    await git('-C', wt, 'checkout', '-q', '--detach')
    await observeNodeTurn(p, turn('a-fix1'))
    await observeNodeTurn(p, turn('a-fix1'))
    await git('-C', wt, 'checkout', '-q', 'sw/alpha/fixer-1')
    await observeNodeTurn(p, turn('a-fix1'))
    await git('-C', wt, 'checkout', '-q', '-b', 'elsewhere')
    await observeNodeTurn(p, turn('a-fix1'))
    expect((await events()).filter(e => e.kind === 'head-moved').map(e => [e.expected, e.actual])).toEqual([
      ['refs/heads/sw/alpha/fixer-1', null],
      ['refs/heads/sw/alpha/fixer-1', 'refs/heads/elsewhere'],
    ])
  })

  test("an agent with no binding, or a read-only swarm's, isn't observed", async () => {
    await live({ readOnly: true })
    await observeNodeTurn(p, turn('a-fix1', { answer: 'x', usage: usage(1, 1) }))
    await observeNodeTurn(p, turn('nobody', { answer: 'x', usage: usage(1, 1) }))
    expect(state.tokens('a-fix1').turns).toBe(0)
    expect(await events()).toEqual([])
  })
})

describe('ackBranchMoved', () => {
  test('records the ack for a branch-moved event, once; another seq is refused', async () => {
    await live()
    const moved = await appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.event', {
      kind: 'branch-moved',
      ref: 'refs/heads/main',
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      running: ['boss'],
    })
    const other = await appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.event', { kind: 'held', node: 'fixer', agentId: 'a-fix1', children: [] })
    await ackBranchMoved(p, 'alpha', moved.seq)
    await ackBranchMoved(p, 'alpha', moved.seq)
    expect((await events()).filter(e => e.kind === 'branch-moved-ack').map(e => e.seq)).toEqual([moved.seq])
    await expect(ackBranchMoved(p, 'alpha', other.seq)).rejects.toThrow("isn't a branch-moved or rule-commit event")
    await expect(ackBranchMoved(p, 'beta', moved.seq)).rejects.toThrow("isn't a live swarm this session owns")
  })

  test('a rule-commit flag takes the same ack, by its seq (FIX-S, S4)', async () => {
    await live()
    const rule = await appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.event', {
      kind: 'rule-commit',
      node: 'fixer',
      agentId: 'a-fix1',
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      files: ['.claude/rules/x.md'],
    })
    await ackBranchMoved(p, 'alpha', rule.seq)
    expect((await events()).filter(e => e.kind === 'branch-moved-ack').map(e => e.seq)).toEqual([rule.seq])
  })
})
