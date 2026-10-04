// Tier 2: how a node or a whole swarm stops (hooks/swarm/end.ts; WP-P,
// section 12's ending cases): Stop and Hard stop, End swarm's stopping step
// and settle wait against real git, the 2-minute report, [Wait longer] and
// [End, keep everything], the end itself (swarm.end, summary.md, the
// ownership ref, the policies, the lead's hand-off), a restart while
// stopping, and the lead's swarm.end request through the record tool.
//
// M's policy writers and K's ownership are other packages' (stubs here): the
// `others` seam stands in for them, and each spec checks the calls made.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { SwarmEntry } from '../../hooks/hookfiles'
import type { AgentStatus, ListedAgent, ToolCallResult } from '../../hooks/ports'
import type { RecordError, RecordOk } from '../../hooks/records/core'
import { dispatchRecord, type DispatchEnv } from '../../hooks/ledger'
import { agentPolicyPath, launchSummaryPath, swarmOwnBranch, swarmOwnWorktreeName } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { appendLaunchRecord, newLaunchId, readLaunchLedger } from '../../hooks/records/swarm'
import { updateSession } from '../../hooks/session'
import {
  endSwarm,
  headOf,
  others,
  recordSwarmEnd,
  resetEndForTests,
  resumeStopping,
  settleProgress,
  STOPPED_REASON,
  stopNode,
  sweepLeftPolicies,
  writeSwarmSummary,
} from '../../hooks/swarm/end'
import { ackBranchMoved, resetObserveForTests } from '../../hooks/swarm/observe'
import * as state from '../../hooks/swarm/state'
import type { LiveSwarm, NodeBinding } from '../../hooks/swarm/types'
import { addSwarmWorktree } from '../../hooks/swarm/worktrees'
import { fireEvery, nodePorts, runAfters, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// Real git in the cleanup; a loaded machine takes seconds.
setDefaultTimeout(120_000)

const T0 = 1_800_000_000_000
const options = normalizeOptions(undefined)
const OK = { result: { message: 'Successfully stopped task' }, text: 'Successfully stopped task' } as unknown as ToolCallResult
const errorOf = (text: string) => ({ isError: true, result: text, text }) as ToolCallResult

let p: TestPorts
let dir: string
let litterDir: string
let root: string
let launch: string
let main: string
let cleanup: () => void
let git: (...argv: string[]) => Promise<string>
/** Every call through `others`, in order. */
let calls: unknown[][]
/** policy.json's entry for the swarm, as M's writers would leave it. */
let entry: SwarmEntry | null
let stopAnswer: (taskId: string) => ToolCallResult
const saved = { ...others }

beforeEach(async () => {
  state.resetForTests()
  resetEndForTests()
  resetObserveForTests()
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ cwd: dir })
  p.clock.now = T0
  ;({ git } = await scratchRepo(p, dir))
  await p.fs.write(join(dir, '.gitignore'), '.env\n.claude/\nnode_modules\n')
  await git('add', '.gitignore')
  await git('commit', '-q', '-m', 'ignore')
  main = (await git('rev-parse', 'HEAD')).trim()
  litterDir = join(dir, '.claude', 'litter')
  root = join(realpathSync(dir), '.claude', 'worktrees')
  launch = await newLaunchId(p, litterDir, 'alpha')
  updateSession({ litterDir })

  calls = []
  entry = {
    launch,
    state: 'live',
    commonDir: realpathSync(join(dir, '.git')),
    owner: { ref: 'refs/litter-swarm/alpha', oid: 'a'.repeat(40), generation: 1, session: 'test-session', checkedAt: 0 },
    nodeTypes: ['litter:sw-alpha-boss', 'litter:sw-alpha-fixer'],
  }
  others.patchNodePolicies = async (_p, _dir, ids, patch) => void calls.push(['patchNodePolicies', [...ids], patch])
  others.patchSwarmPolicy = async (_p, _dir, name, change) => {
    calls.push(['patchSwarmPolicy', name])
    const next = entry ? change(entry) : null
    if (next) entry = next
  }
  others.writeSwarmPolicy = async (_p, _dir, name, e) => {
    calls.push(['writeSwarmPolicy', name, e])
    entry = e
  }
  others.removeNodePolicy = async (_p, _dir, agentId) => void calls.push(['removeNodePolicy', agentId])
  others.releaseOwnership = async (_p, _dir, name) => (calls.push(['releaseOwnership', name]), true)
  // K's ref check (Q2) against the entry's owner: there's no real ref in this world. ownership.spec has the real one.
  others.confirmOwnership = async () => (entry ? { launch: entry.launch, generation: entry.owner.generation, oids: [entry.owner.oid] } : 'lost')
  others.stopOwnerBeat = name => void calls.push(['stopOwnerBeat', name])
  others.noteSummaryTrigger = () => undefined

  stopAnswer = () => OK
  p.toolAnswer = (tool, input) => {
    if (tool !== 'TaskStop') throw new Error(`unexpected tool ${tool}`)
    return stopAnswer(String(input.task_id))
  }
})

afterEach(() => {
  Object.assign(others, saved)
  resetEndForTests()
  updateSession({ litterDir: null })
  state.resetForTests()
  cleanup()
})

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
  worktreeRoot: root,
  commonDir: realpathSync(join(dir, '.git')),
  roots: { litterDir, litterCopies: [litterDir], ruleDirs: [] },
  tips: { 'refs/heads/main': main },
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

const listed = (id: string, status: AgentStatus, type = 'litter:sw-alpha-fixer'): ListedAgent => ({ id, description: id, type, status })

/** An `own` worktree for fixer #n, made as the spawn check makes it. */
async function ownWorktree(n: number): Promise<string> {
  const path = join(root, swarmOwnWorktreeName('alpha', 'fixer', n))
  const made = await addSwarmWorktree(p, litterDir, options, {
    swarm: 'alpha',
    launch,
    node: 'fixer',
    n,
    path,
    branch: swarmOwnBranch('alpha', 'fixer', n),
    from: main,
    repo: dir,
    setup: null,
    linkDirs: [],
  })
  expect(made.ok).toBe(true)
  return path
}

/** The swarm live with the boss and fixer #1 bound, fixer #1 in `wt` when given. */
function live(wt: string | null = null, over: Partial<LiveSwarm> = {}) {
  state.putLiveSwarm(swarmOf(over))
  state.putBinding(bindingOf('a-boss', { node: 'boss', kind: 'orchestrator', parent: null, type: 'litter:sw-alpha-boss', n: 1 }))
  state.putBinding(bindingOf('a-fix1', wt ? { cwd: wt, branch: 'refs/heads/sw/alpha/fixer-1' } : {}))
  p.agents = [listed('a-boss', 'completed', 'litter:sw-alpha-boss'), listed('a-fix1', 'completed')]
}

const records = async () => (await readLaunchLedger(p, litterDir, 'alpha', launch)).records
const kinds = async () => (await records()).map(r => r.kind)
const bodyOf = async (kind: string) => (await records()).filter(r => r.kind === kind).map(r => r.body)
const summaryPath = () => launchSummaryPath(litterDir, 'alpha', launch)

describe('stopNode', () => {
  test('Stop puts the node and its descendants on the stopped list, patches their policies, records swarm.stop, and sends nothing', async () => {
    live()
    state.putBinding(bindingOf('a-fix2', { n: 2 }))
    state.putBinding(bindingOf('c-1', { kind: 'child', n: 0, of: 'a-fix1', parent: 'a-fix1', token: null }))
    await stopNode(p, 'alpha', 'a-fix1', 'soft')
    expect(state.stopped('alpha')).toEqual([
      { agentId: 'a-fix1', swarm: 'alpha', reason: STOPPED_REASON },
      { agentId: 'c-1', swarm: 'alpha', reason: STOPPED_REASON },
    ])
    expect(calls).toEqual([['patchNodePolicies', ['a-fix1', 'c-1'], { stopped: 'stopped from the swarm browser' }]])
    expect(await bodyOf('swarm.stop')).toEqual([{ nodes: ['a-fix1', 'c-1'], how: 'soft' }])
    expect(p.sent).toEqual([])
    expect(p.toolCalls).toEqual([])

    // The orchestrator: everything under it, by parent.
    await stopNode(p, 'alpha', 'a-boss', 'soft')
    expect((await bodyOf('swarm.stop')).at(-1)).toEqual({ nodes: ['a-boss', 'a-fix1', 'a-fix2', 'c-1'], how: 'soft' })
    expect(p.sent).toEqual([])
  })

  test('Hard stop calls TaskStop with the agentId first, then stops the same way', async () => {
    live()
    await stopNode(p, 'alpha', 'a-fix1', 'hard')
    expect(p.toolCalls).toEqual([{ tool: 'TaskStop', input: { task_id: 'a-fix1' } }])
    expect(state.isStopped('a-fix1')).toBe(true)
    expect(await bodyOf('swarm.stop')).toEqual([{ nodes: ['a-fix1'], how: 'hard' }])
    expect(p.sent).toEqual([])

    // One already over is fine: TaskStop says so.
    stopAnswer = id => errorOf(`Task ${id} is not running (status: completed)`)
    await stopNode(p, 'alpha', 'a-boss', 'hard')
    expect((await bodyOf('swarm.stop')).length).toBe(2)
  })

  test('a hard stop whose TaskStop failed still stops them on the list, then says why', async () => {
    live()
    stopAnswer = () => errorOf('the engine is busy')
    await expect(stopNode(p, 'alpha', 'a-fix1', 'hard')).rejects.toThrow('the engine is busy')
    expect(state.isStopped('a-fix1')).toBe(true)
    expect(await bodyOf('swarm.stop')).toEqual([{ nodes: ['a-fix1'], how: 'hard' }])
  })

  test("refuses an agent that isn't the swarm's node, and a swarm another session owns", async () => {
    live()
    await expect(stopNode(p, 'alpha', 'nobody', 'soft')).rejects.toThrow("isn't a node of the swarm alpha")
    state.patchLiveSwarm('alpha', { readOnly: true })
    await expect(stopNode(p, 'alpha', 'a-fix1', 'hard')).rejects.toThrow('another session owns the swarm alpha')
    expect(p.toolCalls).toEqual([])
    expect(state.stopped('alpha')).toEqual([])
  })

  test('an agent of a swarm type the list shows running, with no binding, is stopped alone (FIX-S, S8)', async () => {
    live()
    p.agents.push(listed('ag-x', 'running', 'litter:sw-alpha-boss'))
    await stopNode(p, 'alpha', 'ag-x', 'hard')
    expect(p.toolCalls).toEqual([{ tool: 'TaskStop', input: { task_id: 'ag-x' } }])
    expect(state.isStopped('ag-x')).toBe(true)
    expect(calls).toEqual([['patchNodePolicies', ['ag-x'], { stopped: STOPPED_REASON }]])
    expect(await bodyOf('swarm.stop')).toEqual([{ nodes: ['ag-x'], how: 'hard' }])
    // One the list doesn't show running, or of another type, is still no node.
    p.agents.push(listed('ag-y', 'completed', 'litter:sw-alpha-boss'), listed('ag-z', 'running', 'general-purpose'))
    await expect(stopNode(p, 'alpha', 'ag-y', 'hard')).rejects.toThrow("isn't a node of the swarm alpha")
    await expect(stopNode(p, 'alpha', 'ag-z', 'hard')).rejects.toThrow("isn't a node of the swarm alpha")
    expect(p.toolCalls.length).toBe(1)
    // One the list shows `waiting` (2.1.289) is alive, and stopped the same way.
    p.agents.push(listed('ag-w', 'waiting', 'litter:sw-alpha-boss'))
    await stopNode(p, 'alpha', 'ag-w', 'soft')
    expect(state.isStopped('ag-w')).toBe(true)
  })
})

describe('End swarm', () => {
  test('records swarm.stopping, and while stopping the state and the policy entry say so', async () => {
    live()
    state.markRunning('a-fix1')
    p.agents[1]!.status = 'running'
    await endSwarm(p, 'alpha', 'request')
    expect(await bodyOf('swarm.stopping')).toEqual([{ by: 'browser' }])
    expect(state.liveSwarm('alpha')!.state).toBe('stopping')
    expect(entry!.state).toBe('stopping')
    expect(p.timers.size).toBe(1)
    // Again while stopping: nothing more recorded, one wait.
    await endSwarm(p, 'alpha', 'request')
    await fireEvery(p)
    expect(await bodyOf('swarm.stopping')).toEqual([{ by: 'browser' }])
    expect(p.timers.size).toBe(1)
    expect(state.liveSwarm('alpha')!.state).toBe('stopping')
    expect(p.sent).toEqual([])
  })

  test('with a node mid-call, a spawn reserved and a shell running, nothing ends or is removed until all three settle', async () => {
    const wt = await ownWorktree(1)
    live(wt)
    state.markRunning('a-fix1')
    state.callStart('a-fix1', 'tu-1', 'Bash', T0)
    state.reserve({ key: 'tu-spawn', swarm: 'alpha', node: 'fixer', parent: 'a-boss', kind: 'worker', n: 2, scope: null, at: T0 })
    state.shellStarted('a-fix1', 'bsh_1', T0)
    p.agents[1]!.status = 'running'
    let shellStops = false
    stopAnswer = id => (id === 'bsh_1' && !shellStops ? errorOf('TaskStop could not reach the shell') : OK)

    await endSwarm(p, 'alpha', 'request')
    expect(p.toolCalls).toEqual([{ tool: 'TaskStop', input: { task_id: 'bsh_1' } }])
    const stillOpen = async () => {
      await fireEvery(p)
      expect(await kinds()).not.toContain('swarm.end')
      expect(existsSync(summaryPath())).toBe(false)
      expect(existsSync(wt)).toBe(true)
      expect(calls.map(c => c[0])).not.toContain('releaseOwnership')
      expect(state.liveSwarm('alpha')!.state).toBe('stopping')
    }
    await stillOpen()
    expect(settleProgress('alpha')).toEqual(
      expect.objectContaining({ nodes: [expect.objectContaining({ agentId: 'a-fix1' })], reservations: 1 }),
    )

    // The call ends with the node's turn, and the list shows it settled.
    state.callEnd('a-fix1', 'tu-1')
    state.markSettling('a-fix1')
    p.agents[1]!.status = 'completed'
    await stillOpen()
    // The spawn is refused (the swarm is stopping), so its place goes.
    state.release('tu-spawn')
    await stillOpen()
    expect(settleProgress('alpha')).toEqual(expect.objectContaining({ nodes: [], calls: [], reservations: 0, shells: [expect.objectContaining({ shellId: 'bsh_1' })] }))
    // TaskStop takes at its next try, 10 s on: everything has settled, and the swarm ends.
    shellStops = true
    p.clock.now = T0 + 10_000
    await fireEvery(p)
    expect(state.shells()).toEqual([])
    expect(await kinds()).toContain('swarm.end')
    expect(existsSync(wt)).toBe(false)
    expect(await bodyOf('swarm.worktree.removed')).toEqual([{ path: wt, branch: 'sw/alpha/fixer-1', branchDeleted: true }])
    const [end] = await bodyOf('swarm.end')
    expect(end).toEqual(
      expect.objectContaining({
        status: 'ended',
        settled: true,
        worktrees: [{ path: wt, branch: 'sw/alpha/fixer-1', node: 'fixer', removed: true }],
        branches: [],
      }),
    )
    expect(existsSync(summaryPath())).toBe(true)
    expect(p.timers.size).toBe(0)
  })

  test('the end: swarm.end, summary.md, the ownership ref released, the policy entry and node policies removed, then the hand-off', async () => {
    live()
    state.putBinding(bindingOf('c-1', { kind: 'child', n: 0, of: 'a-fix1', parent: 'a-fix1', token: null }))
    state.addTokens('a-fix1', { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' })
    state.addTokens('c-1', { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' })
    await appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.event', {
      kind: 'report',
      node: 'fixer',
      agentId: 'a-fix1',
      via: 'handback',
      text: 'Lexer fixed.\n## Not a heading of the summary',
    })
    await appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.summary', { text: 't', goal: 'Parser fixed; tests next', inputsHash: 'h', usage: null })
    await endSwarm(p, 'alpha', 'request')
    expect(calls.map(c => c[0])).toEqual(['patchSwarmPolicy'])
    await fireEvery(p)

    const [end] = await bodyOf('swarm.end')
    expect(end).toEqual({
      status: 'ended',
      settled: true,
      nodes: {
        boss: { agentIds: ['a-boss'], lastReport: null, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, turns: 0 } },
        fixer: {
          agentIds: ['a-fix1'],
          lastReport: 'Lexer fixed.\n## Not a heading of the summary',
          tokens: { input: 1300, output: 350, cacheRead: 0, cacheCreation: 0, turns: 2 },
        },
      },
      worktrees: [],
      branches: [],
    })
    expect(calls).toEqual([
      ['patchSwarmPolicy', 'alpha'],
      ['releaseOwnership', 'alpha'],
      ['stopOwnerBeat', 'alpha'],
      ['writeSwarmPolicy', 'alpha', null],
      ['removeNodePolicy', 'a-boss'],
      ['removeNodePolicy', 'a-fix1'],
      ['removeNodePolicy', 'c-1'],
    ])
    expect(state.liveSwarm('alpha')).toBeNull()
    expect(state.bindings('alpha')).toEqual([])

    const summary = readFileSync(summaryPath(), 'utf8')
    expect(summary).toContain('# litter swarm alpha, launch')
    expect(summary).toContain('- Status: ended, settled')
    expect(summary).toContain('## Goal\n\nfix the parser')
    expect(summary).toContain('### fixer (worker)')
    expect(summary).toContain('> Lexer fixed.\n> ## Not a heading of the summary')
    expect(summary).toContain('## Goal history')
    expect(summary).toContain('Parser fixed; tests next')

    // The hand-off: from a timer, never from a hook, with the summary's path and its own opening lines.
    expect(p.submitted).toEqual([])
    await runAfters(p)
    expect(p.submitted.length).toBe(1)
    const handoff = p.submitted[0]!
    expect(handoff).toContain(`litter: the swarm alpha has ended. Its summary is ${summaryPath()}`)
    expect(handoff).toContain('- Status: ended, settled')
    expect(handoff).toContain('section 6')
    expect(handoff).not.toContain('Lexer fixed')
    expect(headOf(summary)).not.toContain('## ')
  })

  test("unsettled after 2 minutes, settleProgress lists what's open; [Wait longer] counts the 2 minutes again", async () => {
    live()
    state.markRunning('a-fix1')
    p.agents[1]!.status = 'running'
    state.callStart('a-fix1', 'tu-9', 'Bash', T0 + 5_000)
    await endSwarm(p, 'alpha', 'request')
    p.clock.now = T0 + 60_000
    await fireEvery(p)
    expect(p.toasts).toEqual([])
    p.clock.now = T0 + 120_000
    await fireEvery(p)
    await fireEvery(p)
    expect(p.toasts.length).toBe(1)
    expect(p.toasts[0]).toContain("swarm alpha hasn't settled after 2 minutes")
    expect(settleProgress('alpha')).toEqual({
      swarm: 'alpha',
      since: T0,
      nodes: [{ agentId: 'a-fix1', node: 'fixer', n: 1, status: 'running' }],
      calls: [{ agentId: 'a-fix1', node: 'fixer', tool: 'Bash', toolUseId: 'tu-9', at: T0 + 5_000 }],
      shells: [],
      reservations: 0,
    })

    await endSwarm(p, 'alpha', 'wait-longer')
    expect(settleProgress('alpha')!.since).toBe(T0 + 120_000)
    p.clock.now = T0 + 200_000
    await fireEvery(p)
    expect(p.toasts.length).toBe(1)
    p.clock.now = T0 + 240_000
    await fireEvery(p)
    expect(p.toasts.length).toBe(2)
    expect(await kinds()).not.toContain('swarm.end')
    expect(settleProgress('beta')).toBeNull()
  })

  test("an agent of the swarm's types that no binding knows keeps the wait open", async () => {
    live()
    p.agents.push(listed('a-stray', 'running'))
    await endSwarm(p, 'alpha', 'request')
    await fireEvery(p)
    expect(await kinds()).not.toContain('swarm.end')
    expect(settleProgress('alpha')!.nodes).toEqual([{ agentId: 'a-stray', node: 'fixer', n: 0, status: 'running, not bound' }])
    p.agents[2]!.status = 'completed'
    await fireEvery(p)
    expect(await kinds()).toContain('swarm.end')
  })

  test('an unbound agent of its types the list shows `waiting` or `pending` keeps the wait open too, worded as the browser words them', async () => {
    live()
    p.agents.push(listed('a-stray', 'waiting'), listed('a-new', 'pending'), listed('a-idle', 'idle'))
    await endSwarm(p, 'alpha', 'request')
    await fireEvery(p)
    expect(await kinds()).not.toContain('swarm.end')
    expect(settleProgress('alpha')!.nodes).toEqual([
      { agentId: 'a-stray', node: 'fixer', n: 0, status: 'held, not bound' },
      { agentId: 'a-new', node: 'fixer', n: 0, status: 'starting, not bound' },
    ])
  })

  test('a `waiting` node (2.1.289) never counts as ended: mid-turn on a foreground child, or parked after its turn, the wait, its call and its worktree stay until the list shows it completed', async () => {
    const wt = await ownWorktree(1)
    live(wt)
    state.markRunning('a-fix1')
    // Mid-turn on a foreground child: its one call in flight is the Agent call.
    state.callStart('a-fix1', 'tu-agent', 'Agent', T0)
    p.agents[1]!.status = 'waiting'
    await endSwarm(p, 'alpha', 'request')
    const stillOpen = async () => {
      await fireEvery(p)
      expect(await kinds()).not.toContain('swarm.end')
      expect(existsSync(wt)).toBe(true)
      expect(calls.map(c => c[0])).not.toContain('removeNodePolicy')
      expect(state.liveSwarm('alpha')!.state).toBe('stopping')
    }
    await stillOpen()
    // The list's `waiting` doesn't close its call: the Agent call is in flight on its child.
    expect(settleProgress('alpha')).toEqual(
      expect.objectContaining({
        nodes: [{ agentId: 'a-fix1', node: 'fixer', n: 1, status: 'held' }],
        calls: [expect.objectContaining({ agentId: 'a-fix1', toolUseId: 'tu-agent', tool: 'Agent' })],
      }),
    )

    // Parked: its turn ended (turn.complete, then SubagentStop) on work that will wake it. Neither ends it.
    state.callEnd('a-fix1', 'tu-agent')
    state.markSettling('a-fix1')
    state.noteAgentStopped('a-fix1')
    await stillOpen()
    // L's poll parks it (the list shows it `waiting`), so it keeps its place (WP-AJ); still not ended.
    state.markParked('a-fix1')
    await stillOpen()
    expect(settleProgress('alpha')).toEqual(expect.objectContaining({ nodes: [{ agentId: 'a-fix1', node: 'fixer', n: 1, status: 'held' }], calls: [] }))

    // Its wake-up turn ends, and the list shows it completed: the wait settles, as before.
    p.agents[1]!.status = 'completed'
    await fireEvery(p)
    expect(await kinds()).toContain('swarm.end')
    expect(existsSync(wt)).toBe(false)
    expect(calls.filter(c => c[0] === 'removeNodePolicy').map(c => c[1])).toEqual(['a-boss', 'a-fix1'])
  })

  test('before the wait has read the list, a parked node (WP-AJ) holds its place, so it reads held, not ended', async () => {
    live()
    state.markParked('a-fix1')
    p.agents[1]!.status = 'waiting'
    await endSwarm(p, 'alpha', 'request')
    expect(settleProgress('alpha')!.nodes).toEqual([{ agentId: 'a-fix1', node: 'fixer', n: 1, status: 'held' }])
    // The list read, it goes by the list, as any node does.
    p.agents[1]!.status = 'completed'
    await fireEvery(p)
    expect(await kinds()).toContain('swarm.end')
  })

  test("[End, keep everything] keeps a `waiting` node's policy file, and the sweep keeps it until the list shows it completed", async () => {
    live()
    p.agents[1]!.status = 'waiting'
    await endSwarm(p, 'alpha', 'keep-everything')
    const removed = () => calls.filter(c => c[0] === 'removeNodePolicy').map(c => c[1])
    expect(removed()).toEqual(['a-boss'])
    expect(p.timers.size).toBe(1)
    await fireEvery(p)
    expect(removed()).toEqual(['a-boss'])
    p.agents[1]!.status = 'completed'
    await fireEvery(p)
    expect(removed()).toEqual(['a-boss', 'a-fix1'])
    expect(p.timers.size).toBe(0)
  })

  test("session start's sweep keeps a leftover policy file of a `waiting` agent until the list shows it completed", async () => {
    const node = { swarm: 'alpha', launch, node: 'fixer', n: 1 }
    await p.fs.write(agentPolicyPath(litterDir, 'a-fix1'), JSON.stringify({ v: 1, node }))
    p.agents = [listed('a-fix1', 'waiting')]
    await sweepLeftPolicies(p, litterDir, x => x.swarm === 'alpha', false)
    expect(calls.filter(c => c[0] === 'removeNodePolicy')).toEqual([])
    p.agents[0]!.status = 'completed'
    await fireEvery(p)
    expect(calls.filter(c => c[0] === 'removeNodePolicy')).toEqual([['removeNodePolicy', 'a-fix1']])
  })

  test('[End, keep everything] records settled: false, removes nothing, and lists each worktree kept', async () => {
    const wt = await ownWorktree(1)
    live(wt)
    state.markRunning('a-fix1')
    p.agents[1]!.status = 'running'
    await endSwarm(p, 'alpha', 'request')
    await fireEvery(p)
    expect(await kinds()).not.toContain('swarm.end')
    await endSwarm(p, 'alpha', 'keep-everything')
    expect(existsSync(wt)).toBe(true)
    expect(await bodyOf('swarm.worktree.removed')).toEqual([])
    const [kept] = await bodyOf('swarm.worktree.kept')
    expect(kept).toEqual(expect.objectContaining({ path: wt, branch: 'sw/alpha/fixer-1' }))
    const [end] = await bodyOf('swarm.end')
    expect(end).toEqual(
      expect.objectContaining({
        status: 'ended',
        settled: false,
        worktrees: [expect.objectContaining({ path: wt, removed: false })],
        branches: ['sw/alpha/fixer-1'],
      }),
    )
    expect(readFileSync(summaryPath(), 'utf8')).toContain(`- Kept: ${wt} (branch sw/alpha/fixer-1), fixer`)
    expect(calls.map(c => c[0])).toContain('releaseOwnership')
    expect(state.liveSwarm('alpha')).toBeNull()
    // The settle wait is over; the sweep watches fixer #1's kept policy, since it still runs (FIX-U, U1).
    expect(calls.filter(c => c[0] === 'removeNodePolicy')).toEqual([['removeNodePolicy', 'a-boss']])
    expect(p.timers.size).toBe(1)
    // Ended straight from the browser (not stopping before): the stopping comes first.
    expect((await kinds()).filter(k => k === 'swarm.stopping').length).toBe(1)
  })

  test('[End, keep everything] straight from live records the stopping first', async () => {
    live()
    await endSwarm(p, 'alpha', 'keep-everything')
    expect((await kinds()).filter(k => k.startsWith('swarm.') && ['swarm.stopping', 'swarm.end'].includes(k))).toEqual(['swarm.stopping', 'swarm.end'])
    await expect(endSwarm(p, 'alpha', 'wait-longer')).rejects.toThrow("there's no live swarm named alpha")
  })

  test("[Wait longer] refuses a swarm that isn't ending", async () => {
    live()
    await expect(endSwarm(p, 'alpha', 'wait-longer')).rejects.toThrow("isn't ending")
  })
})

describe('resumeStopping', () => {
  test('a restart while stopping resumes no node: the state and policy stay stopping, and the wait counts from the ledger', async () => {
    const stopping = await appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.stopping', { by: 'lead' })
    p.clock.now = T0 + 90_000
    // K's recovery put it back, as swarm.start describes it.
    live()
    state.markRunning('a-fix1')
    p.agents[1]!.status = 'running'
    await resumeStopping(p, 'alpha')
    expect(state.liveSwarm('alpha')!.state).toBe('stopping')
    expect(entry!.state).toBe('stopping')
    expect(settleProgress('alpha')!.since).toBe(stopping.at)
    expect(p.toolCalls).toEqual([])
    expect(p.sent).toEqual([])
    expect(p.submitted).toEqual([])
    expect(p.timers.size).toBe(1)
    // No second stopping is recorded, and it ends once it settles.
    p.clock.now = T0 + 120_000
    await fireEvery(p)
    expect(p.toasts.length).toBe(1)
    p.agents[1]!.status = 'completed'
    state.markSettling('a-fix1')
    await fireEvery(p)
    expect((await kinds()).filter(k => k === 'swarm.stopping' || k === 'swarm.end')).toEqual(['swarm.stopping', 'swarm.end'])
  })

  test('a launch that never began stopping, or has ended, is left alone', async () => {
    live()
    await resumeStopping(p, 'alpha')
    expect(state.liveSwarm('alpha')!.state).toBe('live')
    expect(p.timers.size).toBe(0)
    await appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.stopping', { by: 'lead' })
    await appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.end', { status: 'ended', settled: true, nodes: {}, worktrees: [], branches: [] })
    await resumeStopping(p, 'alpha')
    expect(state.liveSwarm('alpha')!.state).toBe('live')
    expect(calls).toEqual([])
  })
})

describe("summary.md's flags", () => {
  // FIX-T 7: [That was me] records branch-moved-ack for a rule-commit too (S4), and summary.md says so.
  test('a flag you acknowledged says so, a rule-commit as a branch-moved, and a rule-commit is still not your acceptance', async () => {
    live()
    const ev = (body: Record<string, unknown>) => appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.event', body as never)
    const moved = await ev({ kind: 'branch-moved', ref: 'refs/heads/main', from: 'a'.repeat(40), to: 'b'.repeat(40), running: [] })
    const rule = await ev({ kind: 'rule-commit', node: 'fixer', agentId: 'a-fix1', from: 'c'.repeat(40), to: 'd'.repeat(40), files: ['.litter/x.md'] })
    await ev({ kind: 'rule-commit', node: 'boss', agentId: 'a-boss', from: 'c'.repeat(40), to: 'e'.repeat(40), files: ['.litter/y.md'] })
    await ackBranchMoved(p, 'alpha', moved.seq)
    await ackBranchMoved(p, 'alpha', rule.seq)
    const lines = readFileSync(await writeSwarmSummary(p, 'alpha', launch), 'utf8').split('\n')
    const flags = lines.slice(lines.indexOf('## Flags') + 2).filter(l => l.startsWith('- '))
    expect(flags.slice(0, 3).map(l => l.replace(/^- \S+ /, ''))).toEqual([
      `branch-moved: main ${'a'.repeat(40)} -> ${'b'.repeat(40)}, acknowledged`,
      'rule-commit (fixer): .litter/x.md, acknowledged; not your acceptance',
      'rule-commit (boss): .litter/y.md; not your acceptance',
    ])
  })
})

describe('recordSwarmEnd', () => {
  const ctxOf = (agentId: string | null = null, dirOverride: string | null | undefined = undefined) => ({
    p,
    caller: { agentId, agentType: agentId ? 'litter:sw-alpha-boss' : null },
    litterDir: dirOverride === undefined ? litterDir : dirOverride,
    options,
  })
  const asError = (r: unknown) => {
    expect((r as { ok: boolean }).ok).toBe(false)
    return r as RecordError
  }

  test('the lead gets { ok: true, status: stopping } at once, and swarm.stopping is recorded by the lead', async () => {
    live()
    state.markRunning('a-fix1')
    p.agents[1]!.status = 'running'
    const r = (await recordSwarmEnd(ctxOf(), { kind: 'swarm.end', swarm: 'alpha' })) as RecordOk
    expect(r).toEqual({ ok: true, status: 'stopping' })
    expect(await bodyOf('swarm.stopping')).toEqual([{ by: 'lead' }])
    expect(state.liveSwarm('alpha')!.state).toBe('stopping')
    expect(await kinds()).not.toContain('swarm.end')
    // Asked again while stopping: the same answer, nothing more recorded.
    expect(await recordSwarmEnd(ctxOf(), { kind: 'swarm.end', swarm: 'alpha' })).toEqual({ ok: true, status: 'stopping' })
    expect((await bodyOf('swarm.stopping')).length).toBe(1)
  })

  test('refusals name the field and the live swarms', async () => {
    live()
    state.putLiveSwarm(swarmOf({ name: 'other', readOnly: true }))
    expect(asError(await recordSwarmEnd(ctxOf(), { kind: 'swarm.end' }))).toEqual(expect.objectContaining({ field: 'swarm', allowed: ['alpha'] }))
    expect(asError(await recordSwarmEnd(ctxOf(), { kind: 'swarm.end', swarm: 'beta' }))).toEqual(
      expect.objectContaining({ field: 'swarm', allowed: ['alpha'], error: "litter: there's no live swarm named beta" }),
    )
    expect(asError(await recordSwarmEnd(ctxOf(), { kind: 'swarm.end', swarm: 'other' })).error).toContain('another session owns the swarm other')
    expect(asError(await recordSwarmEnd(ctxOf(), { kind: 'swarm.end', swarm: '../x' })).field).toBe('swarm')
    expect(asError(await recordSwarmEnd(ctxOf('a-boss'), { kind: 'swarm.end', swarm: 'alpha' })).field).toBe('kind')
    expect(asError(await recordSwarmEnd(ctxOf(null, null), { kind: 'swarm.end', swarm: 'alpha' })).error).toContain('no litter directory')
    state.patchLiveSwarm('alpha', { lost: true })
    expect(asError(await recordSwarmEnd(ctxOf(), { kind: 'swarm.end', swarm: 'alpha' })).error).toContain('no longer owns')
    expect(await kinds()).not.toContain('swarm.stopping')
  })

  test('through the record tool: the lead is answered stopping, an agent is refused before the handler', async () => {
    live()
    const env: DispatchEnv = { litterDir, litterDirError: null, ready: true, options }
    expect(await dispatchRecord(p, undefined, { kind: 'swarm.end', swarm: 'beta' }, env)).toEqual(expect.objectContaining({ ok: false, field: 'swarm' }))
    const agent = await dispatchRecord(p, 'a-boss', { kind: 'swarm.end', swarm: 'alpha' }, env)
    expect(agent).toEqual(expect.objectContaining({ ok: false, field: 'kind' }))
    expect(await kinds()).not.toContain('swarm.stopping')
    expect(await dispatchRecord(p, undefined, { kind: 'swarm.end', swarm: 'alpha' }, env)).toEqual({ ok: true, status: 'stopping' })
    expect(await bodyOf('swarm.stopping')).toEqual([{ by: 'lead' }])
  })
})
