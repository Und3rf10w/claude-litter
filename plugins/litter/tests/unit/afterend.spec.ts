// Tier 2: what happens after End swarm (FIX-U, U1-U4, U6, U7): the policy
// files of agents still running are kept, so the guard denies them, then
// swept; admission refuses a former node; the cleanup's notion of a node in
// use is the settle wait's; a summary call that ends after swarm.end is
// dropped; a broken launch ledger doesn't hold the end; and a spool that
// never drains holds the settle only for a bounded time.
//
// K's ownership and M's swarm entry are other packages' (end.ts's `others`
// seam stands in for them, and records the calls); the node policies are
// real files, written and removed by guard.ts.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentPolicy, NodePolicy, Policy, SwarmEntry } from '../../hooks/hookfiles'
import type { AgentStatus, ListedAgent, SessionSendResult, ToolCallResult } from '../../hooks/ports'
import { agentPolicyPath, launchSummaryPath, policyPath, spoolDir, swarmOwnBranch, swarmOwnWorktreeName } from '../../hooks/layout'
import { atomicWriteJson } from '../../hooks/fsx'
import { normalizeOptions } from '../../hooks/options'
import { appendLaunchRecord, newLaunchId, readLaunchLedger } from '../../hooks/records/swarm'
import { setOptions, updateSession } from '../../hooks/session'
import { endSwarm, others, resetEndForTests, sweepNodePolicies } from '../../hooks/swarm/end'
import { resetObserveForTests } from '../../hooks/swarm/observe'
import { noteSummaryTrigger, resetSummaryForTests, summaryKey, summaryTick } from '../../hooks/swarm/summary'
import * as admit from '../../hooks/swarm/admit'
import * as state from '../../hooks/swarm/state'
import { sessionSendFailed, turnStepFailed } from '../../hooks/swarm/wiring'
import type { LiveSwarm, NodeBinding } from '../../hooks/swarm/types'
import { addSwarmWorktree } from '../../hooks/swarm/worktrees'
import { fireEvery, nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// Real git in the cleanup; a loaded machine takes seconds.
setDefaultTimeout(120_000)

const T0 = 1_800_000_000_000
const options = normalizeOptions(undefined)
const OK = { result: { message: 'Successfully stopped task' }, text: 'Successfully stopped task' } as unknown as ToolCallResult

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
const saved = { ...others }

beforeEach(async () => {
  state.resetForTests()
  resetEndForTests()
  resetObserveForTests()
  admit.resetForTests()
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
  others.patchSwarmPolicy = async (_p, _dir, name) => void calls.push(['patchSwarmPolicy', name])
  others.writeSwarmPolicy = async (_p, _dir, name, e) => void calls.push(['writeSwarmPolicy', name, e])
  // Answers as FIX-Q's releaseOwnership does (released), and its confirmOwnership (still this session's).
  others.releaseOwnership = (async (_p: unknown, _dir: unknown, name: string) => {
    calls.push(['releaseOwnership', name])
    return true
  }) as unknown as typeof others.releaseOwnership
  Object.assign(others, { confirmOwnership: async () => ({ launch, generation: 1, oids: ['a'.repeat(40)] }) })
  others.stopOwnerBeat = name => void calls.push(['stopOwnerBeat', name])
  others.releaseActive = async () => void calls.push(['releaseActive'])
  others.noteSummaryTrigger = () => undefined
  p.toolAnswer = () => OK
})

afterEach(() => {
  Object.assign(others, saved)
  resetEndForTests()
  admit.resetForTests()
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

/** A node's policy file as nodePolicyFor writes it, for the swarm's launch unless given. */
function policyFor(b: NodeBinding, over: Partial<NodePolicy> = {}): NodePolicy {
  return {
    swarm: b.swarm,
    launch: b.launch,
    node: b.node,
    n: b.n,
    kind: b.kind,
    of: b.of,
    type: b.type,
    parent: b.parent,
    generation: b.generation,
    dir: b.cwd,
    paths: null,
    protect: [],
    branch: null,
    authority: {},
    toolsDeny: [],
    bashDeny: [],
    spawns: [],
    spawnOther: true,
    admitted: true,
    stopped: null,
    bind: false,
    ...over,
  }
}

const writePolicy = (agentId: string, node: NodePolicy) => atomicWriteJson(p, agentPolicyPath(litterDir, agentId), { v: 1, node } satisfies AgentPolicy)
const hasPolicy = (agentId: string) => existsSync(agentPolicyPath(litterDir, agentId))

/** The boss and fixer #1 bound (and their files written), fixer #1 in `wt` when given. */
async function live(wt: string | null = null, over: Partial<LiveSwarm> = {}) {
  state.putLiveSwarm(swarmOf(over))
  const boss = bindingOf('a-boss', { node: 'boss', kind: 'orchestrator', parent: null, type: 'litter:sw-alpha-boss', n: 1 })
  const fix = bindingOf('a-fix1', wt ? { cwd: wt, branch: 'refs/heads/sw/alpha/fixer-1' } : {})
  for (const b of [boss, fix]) {
    state.putBinding(b)
    await writePolicy(b.agentId, policyFor(b))
  }
  p.agents = [listed('a-boss', 'completed', 'litter:sw-alpha-boss'), listed('a-fix1', 'completed')]
}

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

const records = async () => (await readLaunchLedger(p, litterDir, 'alpha', launch)).records
const kinds = async () => (await records()).map(r => r.kind)
const bodyOf = async (kind: string) => (await records()).filter(r => r.kind === kind).map(r => r.body)

describe('U1: End never leaves a running agent unguarded', () => {
  /** A held agent of the launch with no binding (admit.ts's holdToBind). */
  const heldFile = (agentId: string) => writePolicy(agentId, policyFor(bindingOf(agentId, { token: null }), { bind: true }))

  test('[End, keep everything] keeps the policies of the agents still running, removes the rest, then sweeps the kept ones', async () => {
    const wt = await ownWorktree(1)
    await live(wt)
    const child = bindingOf('c-1', { kind: 'child', n: 0, of: 'a-fix1', parent: 'a-fix1', token: null, type: 'general-purpose', cwd: wt })
    state.putBinding(child)
    await writePolicy('c-1', policyFor(child))
    await heldFile('h-idle')
    await heldFile('h-run')
    // Not this launch's, nor this swarm's: End leaves them to their own.
    await writePolicy('old-1', policyFor(bindingOf('old-1'), { launch: '20200101-000000' }))
    await writePolicy('b-1', policyFor(bindingOf('b-1', { swarm: 'beta' })))
    state.markRunning('a-fix1')
    state.markRunning('c-1')
    p.agents = [
      listed('a-boss', 'completed', 'litter:sw-alpha-boss'),
      listed('a-fix1', 'running'),
      listed('c-1', 'running', 'general-purpose'),
      listed('h-idle', 'completed'),
      listed('h-run', 'running'),
    ]
    await endSwarm(p, 'alpha', 'keep-everything')
    expect(await bodyOf('swarm.end')).toEqual([expect.objectContaining({ settled: false })])
    expect(state.liveSwarm('alpha')).toBeNull()
    // The running ones keep theirs, so the guard denies them ("the swarm is not live").
    expect(['a-fix1', 'c-1', 'h-run'].map(hasPolicy)).toEqual([true, true, true])
    expect(['a-boss', 'h-idle'].map(hasPolicy)).toEqual([false, false])
    expect(['old-1', 'b-1'].map(hasPolicy)).toEqual([true, true])
    // `active` is Q's to remove, once no binding file is left: asked after the removal.
    expect(calls.at(-1)).toEqual(['releaseActive'])
    expect(p.timers.size).toBe(1)

    // The node and the held agent leave the list; the child still runs.
    p.agents = [listed('a-fix1', 'completed'), listed('c-1', 'running', 'general-purpose'), listed('h-run', 'completed')]
    await fireEvery(p)
    expect(['a-fix1', 'h-run'].map(hasPolicy)).toEqual([false, false])
    expect(hasPolicy('c-1')).toBe(true)
    expect(p.timers.size).toBe(1)

    // While it runs, its file is beaten, so another session's start leaves it.
    utimesSync(agentPolicyPath(litterDir, 'c-1'), (T0 - 300_000) / 1000, (T0 - 300_000) / 1000)
    p.clock.now = T0 + 30_000
    await fireEvery(p)
    expect(Math.round(statMtime('c-1'))).not.toBe(T0 - 300_000)

    p.agents = [listed('c-1', 'completed', 'general-purpose')]
    calls = []
    await fireEvery(p)
    expect(hasPolicy('c-1')).toBe(false)
    expect(calls).toEqual([['releaseActive']])
    expect(p.timers.size).toBe(0)
    expect(['old-1', 'b-1'].map(hasPolicy)).toEqual([true, true])
  })

  test("a list that can't be read keeps every file, for the sweep to try again", async () => {
    await live()
    p.listAgents = async () => {
      throw new Error('the engine is busy')
    }
    await endSwarm(p, 'alpha', 'keep-everything')
    expect(['a-boss', 'a-fix1'].map(hasPolicy)).toEqual([true, true])
    p.listAgents = async () => [listed('a-boss', 'completed'), listed('a-fix1', 'completed')]
    await fireEvery(p)
    expect(['a-boss', 'a-fix1'].map(hasPolicy)).toEqual([false, false])
    expect(p.timers.size).toBe(0)
  })

  test("a settled End removes every policy of the launch, held ones too, and starts no sweep", async () => {
    await live()
    await heldFile('h-idle')
    await endSwarm(p, 'alpha', 'request')
    await fireEvery(p)
    expect(await kinds()).toContain('swarm.end')
    expect(['a-boss', 'a-fix1', 'h-idle'].map(hasPolicy)).toEqual([false, false, false])
    expect(calls.at(-1)).toEqual(['releaseActive'])
    expect(p.timers.size).toBe(0)
  })

  test("at session.start, a file whose swarm isn't live goes, unless its agent runs here or another session still beats it", async () => {
    const entry: SwarmEntry = {
      launch: 'L-beta',
      state: 'live',
      commonDir: realpathSync(join(dir, '.git')),
      owner: { ref: 'refs/litter-swarm/beta', oid: 'b'.repeat(40), generation: 1, session: 'other', checkedAt: T0 / 1000 },
      nodeTypes: [],
    }
    const policy: Policy = { v: 1, session: 'other', litterDir, run: null, roles: {}, swarm: { swarms: { beta: entry } } }
    await atomicWriteJson(p, policyPath(litterDir), policy)
    const at = (id: string, ms: number) => utimesSync(agentPolicyPath(litterDir, id), ms / 1000, ms / 1000)
    await writePolicy('b-live', policyFor(bindingOf('b-live', { swarm: 'beta', launch: 'L-beta' })))
    await writePolicy('b-old', policyFor(bindingOf('b-old', { swarm: 'beta', launch: 'L-older' })))
    await writePolicy('gone', policyFor(bindingOf('gone')))
    await writePolicy('theirs', policyFor(bindingOf('theirs')))
    await writePolicy('mine', policyFor(bindingOf('mine')))
    await atomicWriteJson(p, agentPolicyPath(litterDir, 'writer'), { v: 1, run: 'r1', task: { id: 't1', owned: [] } })
    for (const id of ['b-live', 'b-old', 'gone', 'mine', 'writer']) at(id, T0 - 600_000)
    at('theirs', T0 - 5_000)
    p.agents = [listed('mine', 'running')]
    await sweepNodePolicies(p, litterDir)
    expect(['b-old', 'gone'].map(hasPolicy)).toEqual([false, false])
    expect(['b-live', 'theirs', 'mine', 'writer'].map(hasPolicy)).toEqual([true, true, true, true])
    expect(calls).toEqual([['releaseActive']])
    // The sweep watches the two it kept: one once its agent leaves this session's list, one once nobody beats it.
    p.agents = [listed('mine', 'completed')]
    p.clock.now = T0 + 120_000
    await fireEvery(p)
    expect(['mine', 'theirs'].map(hasPolicy)).toEqual([false, false])
    expect(['b-live', 'writer'].map(hasPolicy)).toEqual([true, true])
    expect(p.timers.size).toBe(0)
  })

  test("at session.start, a policy.json that doesn't parse removes nothing", async () => {
    await writePolicy('gone', policyFor(bindingOf('gone')))
    writeFileSync(policyPath(litterDir), '{ not json')
    await sweepNodePolicies(p, litterDir)
    expect(hasPolicy('gone')).toBe(true)
    expect(calls).toEqual([])
  })

  test('at session.start, with no leftover file, the sweep reads no agent list and starts no timer', async () => {
    let lists = 0
    p.listAgents = async () => {
      lists++
      return []
    }
    await sweepNodePolicies(p, litterDir)
    // A run's writer binding is no node's.
    await atomicWriteJson(p, agentPolicyPath(litterDir, 'writer'), { v: 1, run: 'r1', task: { id: 't1', owned: [] } })
    await sweepNodePolicies(p, litterDir)
    expect(lists).toBe(0)
    expect(p.timers.size).toBe(0)
    expect(calls).toEqual([])
  })
})

const statMtime = (agentId: string): number => Bun.file(agentPolicyPath(litterDir, agentId)).lastModified

describe('U2: after End, admission refuses an agent that still has a policy file', () => {
  const sendE = (to: string, text: string, agentId?: string) => ({ to, text, origin: { kind: 'model' as const }, ...(agentId !== undefined ? { agentId } : {}) })
  function sendNext() {
    const sent: { to: string; text: string }[] = []
    const next = async (e: { to: string; text: string }): Promise<SessionSendResult> => {
      sent.push({ to: e.to, text: e.text })
      return { isDelivered: true }
    }
    return { next: next as never, sent }
  }
  const send = (e: ReturnType<typeof sendE>, next: never) => admit.admitSend(p, e as never, next) as Promise<SessionSendResult>
  async function step(agentId: string) {
    let called = false
    const next = async function* () {
      called = true
      yield { kind: 'text' as const, index: 0, text: 'resumed' }
      return { turnId: 't1', index: 0, answer: 'resumed', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    }
    const gen = admit.admitStep(p, { turnId: 't1', index: 0, model: 'm', messageCount: 2, agentId } as never, next as never) as AsyncGenerator<unknown, unknown>
    const chunks: unknown[] = []
    let s = await gen.next()
    while (!s.done) {
      chunks.push(s.value)
      s = await gen.next()
    }
    return { chunks, result: s.value, called }
  }

  /** Ended with [End, keep everything] while fixer #1 and its child still ran: their files are kept. */
  async function endedWithRunners() {
    await live()
    const child = bindingOf('c-1', { kind: 'child', n: 0, of: 'a-fix1', parent: 'a-fix1', token: null, type: 'general-purpose' })
    state.putBinding(child)
    await writePolicy('c-1', policyFor(child))
    state.markRunning('a-fix1')
    p.agents = [listed('a-boss', 'completed', 'litter:sw-alpha-boss'), { ...listed('a-fix1', 'running'), name: 'fixy' }, listed('c-1', 'running', 'general-purpose')]
    await endSwarm(p, 'alpha', 'keep-everything')
    expect(['a-fix1', 'c-1'].map(hasPolicy)).toEqual([true, true])
    expect(state.liveSwarms()).toEqual([])
  }

  test("a SendMessage to a former node, by id or by name, is refused: its swarm has ended", async () => {
    await endedWithRunners()
    const { next, sent } = sendNext()
    expect(await send(sendE('c-1', 'one more thing', 'a-fix1'), next)).toEqual({ isDelivered: false, reason: expect.stringContaining('swarm alpha has ended') })
    expect(await send(sendE('a-fix1', 'another fix'), next)).toEqual({ isDelivered: false, reason: expect.stringContaining('swarm alpha has ended') })
    expect(await send(sendE('fixy', 'another fix'), next)).toEqual({ isDelivered: false, reason: expect.stringContaining('swarm alpha has ended') })
    expect(sent).toEqual([])
    // With another swarm live, the same.
    state.putLiveSwarm(swarmOf({ name: 'beta', launch: 'L-beta', types: {} }))
    expect(await send(sendE('a-fix1', 'another fix'), next)).toEqual({ isDelivered: false, reason: expect.stringContaining('swarm alpha has ended') })
    expect(sent).toEqual([])
  })

  test('a send to an agent the mod never knew still passes, and so does the lead', async () => {
    await endedWithRunners()
    const { next, sent } = sendNext()
    expect(await send(sendE('someone-else', 'hi'), next)).toEqual({ isDelivered: true })
    expect(await send(sendE('main', 'done', 'a-boss'), next)).toEqual({ isDelivered: true })
    expect(sent).toEqual([
      { to: 'someone-else', text: 'hi' },
      { to: 'main', text: 'done' },
    ])
  })

  test("a former node's wake (a late child's report) is refused at its first step", async () => {
    await endedWithRunners()
    const r = await step('a-fix1')
    expect(r.called).toBe(false)
    expect(r.chunks[0]).toEqual({ kind: 'text', index: 0, text: expect.stringContaining('swarm alpha has ended') })
    expect(r.result).toEqual(expect.objectContaining({ stopReason: 'end_turn', toolUses: [] }))
    // One the mod never bound passes straight through.
    expect((await step('plain-agent')).called).toBe(true)
  })

  // FIX-T 2: the hook that throws after End falls back to its catch, which reads no file.
  test("the session.send and turn.step catches refuse a former node too, and still pass anyone else's", async () => {
    await endedWithRunners()
    const caught = () => {
      const passed: unknown[] = []
      const next = Object.assign(
        async (e: unknown) => {
          passed.push(e)
          return { isDelivered: true }
        },
        { error: { kind: 'throw', message: 'gate', budget: 1000 }, called: false },
      )
      return { next: next as never, passed }
    }
    for (const to of ['a-fix1', 'c-1', 'fixy']) {
      const { next, passed } = caught()
      expect(await sessionSendFailed({} as never, sendE(to, 'another fix') as never, next)).toEqual({ isDelivered: false, reason: 'litter guard failed: session.send (gate)' })
      expect(passed).toEqual([])
    }
    // The lead, and an id the mod never knew while no former node runs, pass on.
    const lead = caught()
    expect(await sessionSendFailed({} as never, sendE('main', 'done', 'a-boss') as never, lead.next)).toEqual({ isDelivered: true })
    const turn = async (agentId: string) => {
      let called = false
      const next = Object.assign(
        async function* () {
          called = true
          yield { kind: 'text' as const, index: 0, text: 'resumed' }
          return { turnId: 't1', index: 0, answer: 'resumed', toolUses: [], stopReason: 'end_turn' as const, usage: null }
        },
        { error: { kind: 'throw', message: 'gate', budget: 1000 }, called: false },
      )
      const gen = turnStepFailed({} as never, { turnId: 't1', index: 0, model: 'm', messageCount: 2, agentId } as never, next as never) as AsyncGenerator<unknown, unknown>
      let s = await gen.next()
      const chunks: unknown[] = []
      while (!s.done) {
        chunks.push(s.value)
        s = await gen.next()
      }
      return { called, chunks }
    }
    expect(await turn('a-fix1')).toEqual({ called: false, chunks: [expect.objectContaining({ kind: 'text' }), expect.objectContaining({ kind: 'stop' })] })
    expect((await turn('plain-agent')).called).toBe(true)

    // Once the sweep removed their files, nothing is left to refuse.
    p.agents = [listed('a-fix1', 'completed'), listed('c-1', 'completed', 'general-purpose')]
    await fireEvery(p)
    expect(['a-fix1', 'c-1'].map(hasPolicy)).toEqual([false, false])
    const after = caught()
    expect(await sessionSendFailed({} as never, sendE('teammate', 'hi', 'other') as never, after.next)).toEqual({ isDelivered: true })
  })
})

describe('U4: a summary call that answers after swarm.end is dropped', () => {
  const USAGE = { input_tokens: 900, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

  beforeEach(() => {
    resetSummaryForTests()
    setOptions({ summaryModel: 'haiku', summaryEverySec: 60 })
  })
  afterEach(() => {
    resetSummaryForTests()
    setOptions(undefined)
  })

  /** A summary call held open until `answer()`; `asked` settles once the call is out. */
  function heldCall(): { answer: () => void; asked: Promise<void> } {
    let answer!: () => void
    let asked!: () => void
    const out = new Promise<void>(r => (asked = r))
    const gate = new Promise<void>(r => (answer = r))
    p.completeAnswer = async () => {
      asked()
      await gate
      return { isAnswered: true, text: 'Goal now: Ship the parser.\nProgress:\n- fixer #1 is done\nWaiting on you: nothing', usage: USAGE }
    }
    return { answer, asked: out }
  }

  /** End held at the ownership ref: after swarm.end, before the live state goes. */
  function holdAtRelease(): { reached: Promise<void>; release: () => void } {
    let release!: () => void
    let reach!: () => void
    const reached = new Promise<void>(r => (reach = r))
    const gate = new Promise<void>(r => (release = r))
    others.releaseOwnership = (async (_p: unknown, _dir: unknown, name: string) => {
      calls.push(['releaseOwnership', name])
      reach()
      await gate
      return true
    }) as unknown as typeof others.releaseOwnership
    return { reached, release }
  }

  test('swarm.end recorded and the live state not yet dropped: the answer records nothing and stores nothing', async () => {
    await live()
    const call = heldCall()
    noteSummaryTrigger('alpha', 'report')
    const tick = summaryTick(p)
    await call.asked
    const hold = holdAtRelease()
    const ending = endSwarm(p, 'alpha', 'keep-everything')
    await hold.reached
    expect(await kinds()).toContain('swarm.end')
    expect(state.liveSwarm('alpha')).not.toBeNull()
    call.answer()
    await tick
    hold.release()
    await ending
    expect(await kinds()).not.toContain('swarm.summary')
    expect(p.storeMap.get(summaryKey(litterDir, 'alpha'))).toBeUndefined()
  })

  test('the swarm gone before the answer: nothing either; one that answers while the swarm is stopping is recorded', async () => {
    await live()
    const call = heldCall()
    noteSummaryTrigger('alpha', 'report')
    const tick = summaryTick(p)
    await call.asked
    await endSwarm(p, 'alpha', 'keep-everything')
    expect(state.liveSwarm('alpha')).toBeNull()
    call.answer()
    await tick
    expect(await kinds()).not.toContain('swarm.summary')
    expect(p.storeMap.get(summaryKey(litterDir, 'alpha'))).toBeUndefined()

    // A new launch that's only stopping still takes its summary.
    resetSummaryForTests()
    launch = await newLaunchId(p, litterDir, 'alpha')
    await live()
    await endSwarm(p, 'alpha', 'request')
    const again = heldCall()
    noteSummaryTrigger('alpha', 'report')
    const second = summaryTick(p)
    await again.asked
    again.answer()
    await second
    expect(await kinds()).toContain('swarm.summary')
    expect(p.storeMap.get(summaryKey(litterDir, 'alpha'))).toEqual(expect.objectContaining({ launch }))
  })
})

describe("U6: a broken launch ledger doesn't hold the end", () => {
  /** Rewrites the launch ledger's swarm.stopping record, so its hash no longer chains. */
  function tamper(): void {
    const ledger = join(litterDir, 'swarms', 'alpha', 'launches', launch, 'ledger')
    const name = readdirSync(ledger).find(f => f.endsWith('-swarm.stopping.json'))!
    const path = join(ledger, name)
    writeFileSync(path, readFileSync(path, 'utf8').replace('"browser"', '"lead"'))
  }

  for (const how of ['settled', 'keep-everything'] as const) {
    test(`End still finishes (${how}): the ref released, the entry and the state gone, and the toast and summary say there's no swarm.end`, async () => {
      await live()
      await endSwarm(p, 'alpha', 'request')
      tamper()
      expect((await readLaunchLedger(p, litterDir, 'alpha', launch)).tampered).not.toBeNull()
      if (how === 'settled') await fireEvery(p)
      else await endSwarm(p, 'alpha', 'keep-everything')
      expect(calls.map(c => c[0])).toEqual(expect.arrayContaining(['releaseOwnership', 'stopOwnerBeat', 'writeSwarmPolicy', 'releaseActive']))
      expect(state.liveSwarm('alpha')).toBeNull()
      expect(p.timers.size).toBe(0)
      expect(p.toasts).toEqual([expect.stringMatching(/swarm alpha has ended, but its launch ledger is broken at record \d+.*no swarm\.end/)])
      const summary = readFileSync(launchSummaryPath(litterDir, 'alpha', launch), 'utf8')
      expect(summary).toContain('- Status: ended, but its launch ledger is broken, so it holds no swarm.end')
      expect(summary).toContain('- Ledger: tampered at record')
    })
  }
})

describe('U7: a spool that never drains holds the settle only for a bounded time', () => {
  /** A spool file of this session: an aside an earlier drain left (only session.start drains those), or the live one. */
  async function spoolFile(name: string): Promise<string> {
    const path = join(spoolDir(litterDir), name)
    await p.fs.write(path, `${JSON.stringify({ ev: 'call', agent_id: 'a-fix1', tool: 'Bash' })}\n`)
    return path
  }

  test('an aside no drain here will take: the settle waits 30 s for it, then ends settled and says which file', async () => {
    await live()
    await spoolFile('test-session.jsonl.draining-abc123')
    await endSwarm(p, 'alpha', 'request')
    await fireEvery(p)
    expect(state.liveSwarm('alpha')).not.toBeNull()
    p.clock.now! += 29_000
    await fireEvery(p)
    expect(await kinds()).not.toContain('swarm.end')
    p.clock.now! += 2_000
    await fireEvery(p)
    expect(state.liveSwarm('alpha')).toBeNull()
    const [end] = await bodyOf('swarm.end')
    expect(end).toEqual(expect.objectContaining({ status: 'ended', settled: true, reason: expect.stringContaining('test-session.jsonl.draining-abc123') }))
    expect(String((end as { reason: string }).reason)).toContain('30 s')
    expect(p.logs.some(l => l.includes('test-session.jsonl.draining-abc123'))).toBe(true)
    const summary = readFileSync(launchSummaryPath(litterDir, 'alpha', launch), 'utf8')
    expect(summary).toMatch(/- Status: ended, settled \(.*test-session\.jsonl\.draining-abc123/)
  })

  test("a spool that drains in time holds the settle until it's drained, and the end says nothing of it", async () => {
    await live()
    const path = await spoolFile('test-session.jsonl')
    await endSwarm(p, 'alpha', 'request')
    await fireEvery(p)
    p.clock.now! += 10_000
    await fireEvery(p)
    expect(state.liveSwarm('alpha')).not.toBeNull()
    rmSync(path)
    await fireEvery(p)
    expect(state.liveSwarm('alpha')).toBeNull()
    const [end] = await bodyOf('swarm.end')
    expect(end).toEqual(expect.objectContaining({ settled: true }))
    expect(end).not.toHaveProperty('reason')
  })
})

describe('U3: the cleanup counts a node as ended the way the settle wait does', () => {
  test("a node whose turn.complete landed, still listed running, doesn't keep its worktree", async () => {
    const wt = await ownWorktree(1)
    await live(wt)
    state.markRunning('a-fix1')
    p.agents[1]!.status = 'running'
    await endSwarm(p, 'alpha', 'request')
    // Its turn.complete lands; the settle tick runs before L's poll sees it leave the list.
    state.markSettling('a-fix1')
    await fireEvery(p)
    const [end] = await bodyOf('swarm.end')
    expect(end).toEqual(expect.objectContaining({ settled: true }))
    expect(await bodyOf('swarm.worktree.kept')).toEqual([])
    expect(existsSync(wt)).toBe(false)
    expect(await bodyOf('swarm.worktree.removed')).toEqual([{ path: wt, branch: 'sw/alpha/fixer-1', branchDeleted: true }])
  })
})
