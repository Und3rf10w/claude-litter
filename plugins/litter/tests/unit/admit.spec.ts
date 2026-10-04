// Tier 2: admission (hooks/swarm/admit.ts; WP-L): resumes through
// SendMessage, the browser and a queued delivery, each refused when its
// parent is at its count, it was stopped, a revision removed it, or the swarm
// is stopping; the reply route; settling; the engine's own wakes at
// turn.step; parked nodes, which keep their places (WP-AJ); and swarm.bind
// with adoption after a reload.
//
// The policy files are M's real writer's (guard.ts), so these specs read what
// the guard will read.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NodePolicy } from '../../hooks/hookfiles'
import { agentPolicyPath, donePath } from '../../hooks/layout'
import { nodePolicyFor, writeNodePolicy } from '../../hooks/swarm/guard'
import { normalizeOptions } from '../../hooks/options'
import type { RecordCtx } from '../../hooks/records/core'
import { appendLaunchRecord, newLaunchId, readLaunchLedger } from '../../hooks/records/swarm'
import { updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import * as admit from '../../hooks/swarm/admit'
import { swarmSpawn } from '../../hooks/swarm/spawn'
import { SWARM_SEND } from '../../hooks/swarm/tools'
import type { LiveSwarm, NodeBinding, SwarmSpec } from '../../hooks/swarm/types'
import type { AgentStatus, ListedAgent, SessionSendResult } from '../../hooks/ports'
import { fireEvery, nodePorts, scratch, type TestPorts } from './support/node-ports'

// ---------------------------------------------------------------------------
// Fixtures

const NOW = 1_800_000_000_000
const RO = { deny: ['Edit', 'Write', 'NotebookEdit'] }
const T = (node: string) => `litter:sw-alpha-${node}`

let p: TestPorts
let dir: string
let litterDir: string
let launch: string
let cleanup: () => void

function spec(over: Partial<SwarmSpec> = {}): SwarmSpec {
  return {
    name: 'alpha',
    goal: 'ship it',
    nodes: [
      { id: 'part-a', kind: 'orchestrator', tools: RO, spawns: { fixer: 1 } },
      { id: 'part-b', kind: 'orchestrator', tools: RO, spawns: { fixer: 1 } },
      { id: 'fixer', kind: 'worker', tools: RO, worktree: 'own' },
    ],
    ...over,
  }
}

function live(over: Partial<LiveSwarm> = {}): LiveSwarm {
  const s = over.spec ?? spec()
  return {
    name: 'alpha',
    launch,
    revision: 1,
    spec: s,
    nonce: 'n0nce',
    types: { 'part-a': T('part-a'), 'part-b': T('part-b'), fixer: T('fixer') },
    typesReady: true,
    dirs: {},
    sessionCwd: '/repo',
    worktreeRoot: '/repo/.claude/worktrees',
    commonDir: '/repo/.git',
    roots: { litterDir, litterCopies: [litterDir], ruleDirs: [] },
    tips: {},
    owner: { ref: 'refs/litter-swarm/alpha', oid: 'a'.repeat(40), generation: 1, session: 'test-session' },
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
    launch,
    node: 'fixer',
    n: 1,
    kind: 'worker',
    of: null,
    parent: 'o1',
    type: T('fixer'),
    cwd: '/repo/.claude/worktrees/sw-alpha-fixer-1',
    branch: null,
    token: null,
    revision: 1,
    generation: 1,
    boundAt: NOW,
    adopted: false,
    ...over,
  }
}

/** Binds an agent, writes its policy, and marks it running when asked. */
async function put(b: NodeBinding, running: boolean): Promise<void> {
  state.putBinding(b)
  if (running) state.markRunning(b.agentId, null)
  await writeNodePolicy(p, litterDir, b.agentId, nodePolicyFor(b, state.liveSwarm('alpha')!, { admitted: running, stopped: null, bind: false }))
}

const o1 = () => bind('o1', { node: 'part-a', kind: 'orchestrator', parent: null, cwd: '/repo' })
const o2 = () => bind('o2', { node: 'part-b', kind: 'orchestrator', parent: null, cwd: '/repo/b' })
const w1 = () => bind('w1')
const w2 = () => bind('w2', { n: 2, cwd: '/repo/.claude/worktrees/sw-alpha-fixer-2' })

const policyOf = (agentId: string): NodePolicy | null => {
  const path = agentPolicyPath(litterDir, agentId)
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as { node: NodePolicy }).node : null
}
const events = async () =>
  (await readLaunchLedger(p, litterDir, 'alpha', launch)).records.filter(r => r.kind === 'swarm.event').map(r => r.body as Record<string, unknown>)

const sendE = (to: string, text: string, agentId?: string) => ({ to, text, origin: { kind: 'model' as const }, ...(agentId !== undefined ? { agentId } : {}) })

/** The engine beneath session.send: records each send, delivers it unless `answer` says otherwise. */
function sendNext(answer?: SessionSendResult) {
  const calls: { to: string; text: string }[] = []
  const next = async (e: { to: string; text: string }): Promise<SessionSendResult> => {
    calls.push({ to: e.to, text: e.text })
    return answer ?? { isDelivered: true }
  }
  return { next: next as never, calls }
}

const send = (e: ReturnType<typeof sendE>, next: never) => admit.admitSend(p, e as never, next) as Promise<SessionSendResult>

/** The mod's own sends go through its session.send hook, as the engine's port does. */
function wireOwnSends(): void {
  p.sendHook = (to, text, deliver) =>
    admit.admitSend(p, { to, text, origin: { kind: 'plugin', name: 'litter' } } as never, (async (e: { to: string; text: string }) => deliver(e.to, e.text)) as never)
}

const tool = async (input: Record<string, unknown>, agentId?: string) =>
  JSON.parse(
    ((await admit.swarmSendTool(p, { tool: SWARM_SEND, tool_use_id: 'toolu_s', ...(agentId ? { agentId } : {}), ...input } as never, (() => {
      throw new Error('swarm_send is answered by the mod')
    }) as never)) as { result: string }).result,
  ) as Record<string, unknown>

const stepE = (agentId: string | undefined, turnId: string, index: number) => ({ turnId, index, model: 'm', messageCount: 2, ...(agentId ? { agentId } : {}) })

/** Runs admitStep, answering its chunks and result, and whether it called `next`. */
async function step(e: ReturnType<typeof stepE>) {
  let called = false
  const next = async function* () {
    called = true
    yield { kind: 'text' as const, index: 0, text: 'model says hi' }
    return { turnId: e.turnId, index: e.index, answer: 'model says hi', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  }
  const gen = admit.admitStep(p, e as never, next as never) as AsyncGenerator<unknown, unknown>
  const chunks: unknown[] = []
  let s = await gen.next()
  while (!s.done) {
    chunks.push(s.value)
    s = await gen.next()
  }
  return { chunks, result: s.value, called }
}

const agent = (id: string, type: string, status: AgentStatus, parentId?: string): ListedAgent => ({
  id,
  description: 'a node',
  type,
  status,
  ...(parentId !== undefined ? { parentId } : {}),
})

beforeEach(async () => {
  state.resetForTests()
  admit.resetForTests()
  p = nodePorts()
  ;({ dir, cleanup } = scratch())
  litterDir = join(dir, '.claude', 'litter')
  launch = await newLaunchId(p, litterDir, 'alpha')
  p.clock.now = NOW
  updateSession({ litterDir })
  state.putLiveSwarm(live())
})

afterEach(() => {
  admit.resetForTests()
  state.resetForTests()
  updateSession({ litterDir: null })
  cleanup()
})

// ---------------------------------------------------------------------------

describe('resume admission', () => {
  test("a SendMessage from its parent resuming a finished worker takes a place, its policy admitted first", async () => {
    await put(o1(), true)
    await put(w1(), false)
    let admittedAtSend: boolean | undefined
    const next = (async (e: { to: string; text: string }) => {
      admittedAtSend = policyOf('w1')?.admitted
      return { isDelivered: true }
    }) as never
    expect(await send(sendE('w1', 'one more fix', 'o1'), next)).toEqual({ isDelivered: true })
    expect(admittedAtSend).toBe(true)
    expect(state.status('w1')).toBe('running')
    expect(state.reservations()).toEqual([])
    expect((await events()).at(-1)).toEqual(expect.objectContaining({ kind: 'message', agentId: 'w1', from: 'o1', to: 'w1', route: 'direct', delivery: 'interject' }))
  })

  // R2: hold.sh reads done/ as "finished"; a worker its parent resumes runs again, so a parent ending
  // its turn meanwhile must be held for it.
  test("a resumed worker's done/ from its last stop is gone before it's sent to, and a wake's too", async () => {
    await put(o1(), true)
    await put(w1(), false)
    const mark = () => p.fs.write(donePath(litterDir, 'w1'), '{"v":1,"at":1,"via":"stop"}\n')
    await mark()
    let doneAtSend: boolean | undefined
    const next = (async () => {
      doneAtSend = existsSync(donePath(litterDir, 'w1'))
      return { isDelivered: true }
    }) as never
    expect(await send(sendE('w1', 'one more fix', 'o1'), next)).toEqual({ isDelivered: true })
    expect(doneAtSend).toBe(false)
    // It settles, stops again (done/), and the engine wakes it at turn.step.
    state.markSettled('w1')
    await mark()
    expect((await step(stepE('w1', 't-2', 0))).called).toBe(true)
    expect(existsSync(donePath(litterDir, 'w1'))).toBe(false)
  })

  // FIX-T 4: the last admission path, a wake while it's still settling, runs again too.
  test("a wake while it's settling (the engine's stranded-message resume) removes the done/ its stop wrote", async () => {
    await put(o1(), true)
    await put(w1(), true)
    p.agents = [agent('w1', T('fixer'), 'running', 'o1')]
    await admit.settleNode(p, { agentId: 'w1', turnId: 't-1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
    expect(state.status('w1')).toBe('settling')
    // Its SubagentStop let it go with no background task: hold.sh's done/.
    await p.fs.write(donePath(litterDir, 'w1'), '{"v":1,"at":1,"via":"stop"}\n')
    expect((await step(stepE('w1', 't-2', 0))).called).toBe(true)
    expect(state.status('w1')).toBe('running')
    expect(existsSync(donePath(litterDir, 'w1'))).toBe(false)
    expect(policyOf('w1')?.admitted).toBe(true)
  })

  const conditions: [string, () => Promise<void>, string][] = [
    [
      'its parent is at its count',
      async () => put(w2(), true),
      'part-a (o1) already runs 1 of its max 1 fixer at once; wait for one to finish',
    ],
    ['it was stopped', async () => state.stop('alpha', ['w1'], 'you stopped it'), 'fixer #1 (w1) was stopped (you stopped it)'],
    [
      "it's not in the current revision",
      async () => state.putLiveSwarm(live({ revision: 2, spec: spec({ nodes: spec().nodes.filter(n => n.id !== 'fixer') }) })),
      "fixer isn't in swarm alpha's revision 2",
    ],
    ['the swarm is stopping', async () => void state.patchLiveSwarm('alpha', { state: 'stopping' }), 'the swarm is ending; report and end your turn'],
  ]

  for (const [why, arrange, reason] of conditions) {
    test(`a SendMessage resuming a finished worker is refused when ${why}`, async () => {
      await put(o1(), true)
      await put(w1(), false)
      await arrange()
      const { next, calls } = sendNext()
      expect(await send(sendE('w1', 'one more fix', 'o1'), next)).toEqual({ isDelivered: false, reason: `litter: ${reason}` })
      expect(calls).toEqual([])
      expect(state.status('w1')).toBe('idle')
      expect(state.reservations()).toEqual([])
      expect(policyOf('w1')?.admitted).toBe(false)
    })
  }

  const orchestratorConditions: [string, () => Promise<void>, string][] = [
    [
      'another instance of it runs',
      async () => put(bind('o1b', { node: 'part-a', n: 2, kind: 'orchestrator', parent: null, cwd: '/repo', boundAt: NOW - 1 }), true),
      'another instance of part-a is running; send to it instead',
    ],
    ['it was stopped', async () => state.stop('alpha', ['o1'], 'you stopped it'), 'part-a (o1) was stopped (you stopped it)'],
    [
      "it's not in the current revision",
      async () => state.putLiveSwarm(live({ revision: 2, spec: spec({ nodes: spec().nodes.filter(n => n.id !== 'part-a') }) })),
      "part-a isn't in swarm alpha's revision 2",
    ],
    ['the swarm is stopping', async () => void state.patchLiveSwarm('alpha', { state: 'stopping' }), 'swarm alpha is ending'],
  ]

  test('a browser send to a finished orchestrator takes a place', async () => {
    wireOwnSends()
    await put(o1(), false)
    expect(await admit.sendFromBrowser(p, { swarm: 'alpha', node: 'part-a#1', text: 'look at the flaky test', when: 'interject', route: 'direct' })).toEqual({
      kind: 'delivered',
    })
    expect(p.sent).toEqual([{ to: 'o1', text: 'look at the flaky test' }])
    expect(state.status('o1')).toBe('running')
    expect(policyOf('o1')?.admitted).toBe(true)
  })

  for (const [why, arrange, reason] of orchestratorConditions) {
    test(`a browser send to a finished orchestrator is refused when ${why}`, async () => {
      wireOwnSends()
      await put(o1(), false)
      await arrange()
      const out = await admit.sendFromBrowser(p, { swarm: 'alpha', node: 'part-a#1', text: 'look at the flaky test', when: 'interject', route: 'direct' })
      expect(out).toEqual(expect.objectContaining({ kind: 'refused', reason }))
      expect(p.sent).toEqual([])
      expect(state.status('o1')).toBe('idle')
      expect(state.reservations()).toEqual([])
    })
  }

  test('a queued delivery to a finished orchestrator takes a place', async () => {
    wireOwnSends()
    await put(o1(), false)
    const m = state.enqueue({ swarm: 'alpha', agentId: 'o1', node: 'part-a', text: 'when you can: rebase', from: 'user', at: NOW })
    expect(await tool({ queued: m.id })).toEqual({ ok: true, node: 'part-a', agentId: 'o1', outcome: { kind: 'delivered' } })
    expect(p.sent).toEqual([{ to: 'o1', text: 'when you can: rebase' }])
    expect(state.queued()).toEqual([])
    expect(state.status('o1')).toBe('running')
    expect((await events()).map(e => e.kind)).toEqual(['message', 'queue-sent'])
  })

  for (const [why, arrange, reason] of orchestratorConditions) {
    test(`a queued delivery to a finished orchestrator is refused when ${why}`, async () => {
      wireOwnSends()
      await put(o1(), false)
      const m = state.enqueue({ swarm: 'alpha', agentId: 'o1', node: 'part-a', text: 'when you can: rebase', from: 'user', at: NOW })
      await arrange()
      const out = await tool({ queued: m.id })
      expect(out.ok).toBe(false)
      expect(String(out.error)).toContain(reason)
      expect(p.sent).toEqual([])
      expect(state.status('o1')).toBe('idle')
      // Refused for room it stays queued, to be handed on again; otherwise it's dropped.
      const kept = why === 'another instance of it runs'
      expect(state.queued().map(q => q.id)).toEqual(kept ? [m.id] : [])
      expect(String(out.error)).toContain(kept ? 'litter keeps the message queued' : 'the queued message was dropped')
    })
  }

  test('an interject to a running node needs no place', async () => {
    wireOwnSends()
    await put(o1(), true)
    await put(w1(), true)
    expect(await tool({ node: 'fixer', text: 'also check the docs' })).toEqual({ ok: true, node: 'fixer#1', agentId: 'w1', outcome: { kind: 'delivered' } })
    expect(p.sent).toEqual([{ to: 'w1', text: 'From the lead:\n\nalso check the docs' }])
    expect(state.reservations()).toEqual([])
    expect(state.countFor('alpha', 'o1', 'fixer')).toBe(1)
  })
})

describe('the reply route', () => {
  const wrapped = (from: string, text: string) => `For your worker fixer (w1), from ${from}:\n\n${text}\n\nPass it on with SendMessage, or answer it yourself.`

  test("a SendMessage from the lead to an idle worker goes to its parent, wrapped", async () => {
    await put(o1(), true)
    await put(w1(), false)
    const { next, calls } = sendNext()
    expect(await send(sendE('w1', 'check the tests'), next)).toEqual({ isDelivered: true })
    expect(calls).toEqual([{ to: 'o1', text: wrapped('the lead', 'check the tests') }])
    expect(state.status('w1')).toBe('idle')
    const ev = await events()
    expect(ev[0]).toEqual(expect.objectContaining({ kind: 'readdressed', agentId: 'w1', from: 'lead', to: 'w1', parent: 'o1' }))
    expect(ev[1]).toEqual(expect.objectContaining({ kind: 'message', agentId: 'o1', route: 'reply' }))
  })

  test("a browser send to an idle worker is readdressed too, and says why", async () => {
    wireOwnSends()
    await put(o1(), true)
    await put(w1(), false)
    const out = await admit.sendFromBrowser(p, { swarm: 'alpha', node: 'fixer', text: 'use the helper', when: 'interject', route: 'direct' })
    expect(out).toEqual({ kind: 'readdressed', to: 'o1', parentNode: 'part-a', why: "via parent (it's idle)" })
    expect(p.sent).toEqual([{ to: 'o1', text: wrapped('the user', 'use the helper') }])
  })

  test('an idle orchestrator the reply resumes for the lead takes its own place', async () => {
    await put(o1(), false)
    await put(w1(), false)
    const { next, calls } = sendNext()
    expect(await send(sendE('w1', 'check the tests'), next)).toEqual({ isDelivered: true })
    expect(calls).toEqual([{ to: 'o1', text: wrapped('the lead', 'check the tests') }])
    expect(state.status('o1')).toBe('running')
  })

  test("another node's send, when the worker and its orchestrator are both idle, goes to the lead", async () => {
    await put(o1(), false)
    await put(o2(), true)
    await put(w1(), false)
    const { next, calls } = sendNext()
    expect(await send(sendE('w1', 'is the API stable?', 'o2'), next)).toEqual({ isDelivered: true })
    expect(calls).toEqual([
      {
        to: 'main',
        text: `For your orchestrator part-a (o1), from part-b (o2):\n\n${wrapped('part-b (o2)', 'is the API stable?')}\n\nPass it on with mcp__litter__swarm_send, or answer it yourself.`,
      },
    ])
    expect(state.status('o1')).toBe('idle')
    expect(state.status('w1')).toBe('idle')
  })

  test('an interject to a running worker goes direct, from anyone', async () => {
    await put(o1(), true)
    await put(w1(), true)
    const { next, calls } = sendNext()
    expect(await send(sendE('w1', 'stop editing README'), next)).toEqual({ isDelivered: true })
    expect(calls).toEqual([{ to: 'w1', text: 'stop editing README' }])
  })

  test('a send to no node from no node passes as it came', async () => {
    await put(o1(), true)
    const { next, calls } = sendNext()
    const e = sendE('someone-else', 'hi')
    expect(await send(e, next)).toEqual({ isDelivered: true })
    expect(calls).toEqual([{ to: 'someone-else', text: 'hi' }])
    expect(await events()).toEqual([])
  })

  test("a node's address in SendMessage's from form, or its listed name, resolves to it", async () => {
    await put(o1(), true)
    await put(bind('a1b2c3d4e5f60718', { parent: 'o1' }), true)
    const { next, calls } = sendNext()
    await send(sendE('fixer [a1b2c3d4]', 'via the from address'), next)
    p.agents = [agent('a1b2c3d4e5f60718', T('fixer'), 'running', 'o1'), agent('x9', 'Explore', 'running')]
    p.agents[0]!.name = 'helper'
    await send(sendE('helper', 'via its name'), next)
    expect(calls.map(c => c.to)).toEqual(['a1b2c3d4e5f60718', 'a1b2c3d4e5f60718'])
  })
})

describe('settling', () => {
  test("between a worker's turn.complete and its status leaving running, a send waits up to 2 s, then queues and answers delivered", async () => {
    await put(o1(), true)
    await put(w1(), true)
    p.agents = [agent('w1', T('fixer'), 'running', 'o1')]
    await admit.settleNode(p, { agentId: 'w1', turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
    expect(state.status('w1')).toBe('settling')
    const { next, calls } = sendNext()
    expect(await send(sendE('w1', 'and the changelog'), next)).toEqual({ isDelivered: true })
    expect(p.sleeps).toEqual(Array(8).fill(250))
    expect(calls).toEqual([])
    const q = state.queued('alpha')
    expect(q.map(m => [m.agentId, m.from, m.text])).toEqual([['w1', 'lead', 'and the changelog']])

    // The list lets it go: the poll settles it and hands the message to the lead, from its timer.
    p.agents = [agent('w1', T('fixer'), 'completed', 'o1')]
    await fireEvery(p)
    expect(state.status('w1')).toBe('idle')
    expect(policyOf('w1')?.admitted).toBe(false)
    expect(p.submitted.length).toBe(1)
    expect(p.submitted[0]).toContain(`- fixer#1 in swarm alpha: 1 message, queued: "${q[0]!.id}"`)
    expect(p.submitted[0]).toContain('mcp__litter__swarm_send')
    // Nothing left to do: the poll stops, and the message isn't handed twice.
    await fireEvery(p)
    expect(p.timers.size).toBe(0)
    expect(p.submitted.length).toBe(1)
  })

  test('a send to a settling node goes as soon as the list lets it go', async () => {
    await put(o1(), true)
    await put(w1(), true)
    p.agents = [agent('w1', T('fixer'), 'running', 'o1')]
    await admit.settleNode(p, { agentId: 'w1', turnId: 't1', answer: 'done', durationMs: 5, isAborted: true, reason: 'aborted' } as never)
    p.onSleep = () => (p.agents = [agent('w1', T('fixer'), 'completed', 'o1')])
    const { next, calls } = sendNext()
    expect(await send(sendE('w1', 'next file', 'o1'), next)).toEqual({ isDelivered: true })
    expect(p.sleeps).toEqual([250])
    expect(calls).toEqual([{ to: 'w1', text: 'next file' }])
    expect(state.status('w1')).toBe('running')
  })

  // Only `running` (2.1.289: finalizing too) holds a settle. A `waiting` node that ended its turn is parked
  // on children or background work, completed to the engine, so a message resumes it through admission;
  // it keeps its place meanwhile (WP-AJ).
  test('the poll parks a node whose row is `waiting`: between turns, its policy not admitted, its place kept; a `running` one (finalizing) stays settling', async () => {
    await put(o1(), true)
    await put(w1(), true)
    await put(w2(), true)
    p.agents = [agent('w1', T('fixer'), 'running', 'o1'), agent('w2', T('fixer'), 'waiting', 'o1')]
    for (const id of ['w1', 'w2']) await admit.settleNode(p, { agentId: id, turnId: `t-${id}`, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
    await fireEvery(p)
    expect(state.status('w1')).toBe('settling')
    expect(policyOf('w1')?.admitted).toBe(true)
    expect(state.status('w2')).toBe('idle')
    expect(state.isParked('w2')).toBe(true)
    expect(policyOf('w2')?.admitted).toBe(false)
    expect(state.countFor('alpha', 'o1', 'fixer')).toBe(2)
    // w1 settles; the poll keeps running while w2 is parked, and stops once it has ended.
    p.agents = [agent('w1', T('fixer'), 'completed', 'o1'), agent('w2', T('fixer'), 'waiting', 'o1')]
    await fireEvery(p)
    expect(state.status('w1')).toBe('idle')
    expect(state.isParked('w2')).toBe(true)
    expect(p.timers.size).toBe(1)
    p.agents = [agent('w1', T('fixer'), 'completed', 'o1'), agent('w2', T('fixer'), 'completed', 'o1')]
    await fireEvery(p)
    expect(state.isParked('w2')).toBe(false)
    expect(p.timers.size).toBe(0)
  })

  test("a send to a settling node whose row turns `waiting` goes through admission as soon as the send's own check sees it", async () => {
    await put(o1(), true)
    await put(w1(), true)
    p.agents = [agent('w1', T('fixer'), 'running', 'o1')]
    await admit.settleNode(p, { agentId: 'w1', turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
    p.onSleep = () => (p.agents = [agent('w1', T('fixer'), 'waiting', 'o1')])
    const { next, calls } = sendNext()
    expect(await send(sendE('w1', 'and the docs', 'o1'), next)).toEqual({ isDelivered: true })
    expect(p.sleeps).toEqual([250])
    expect(calls).toEqual([{ to: 'w1', text: 'and the docs' }])
    expect(state.status('w1')).toBe('running')
    expect(policyOf('w1')?.admitted).toBe(true)
  })

  test("the lead's turn start and end set and clear its busy state", async () => {
    await admit.leadTurnStart(p, { text: 'hi', turnId: 'L1' } as never)
    expect(state.leadBusy()).toBe(true)
    await admit.settleNode(p, { turnId: 'L1', answer: 'ok', durationMs: 5, isAborted: false, reason: 'answer' } as never)
    expect(state.leadBusy()).toBe(false)
  })
})

describe('engine wakes (turn.step)', () => {
  const refusal = (e: ReturnType<typeof stepE>, reason: string) => {
    const answer = `litter: not admitted: ${reason}; ending this turn`
    return {
      chunks: [{ kind: 'text', index: 0, text: answer }, { kind: 'stop', stopReason: 'end_turn', usage: null }],
      result: { turnId: e.turnId, index: e.index, answer, toolUses: [], stopReason: 'end_turn', usage: null },
      called: false,
    }
  }

  test("a stopped node's first step is refused without calling next, and a later step of that turn too", async () => {
    await put(o1(), true)
    await put(w1(), false)
    state.stop('alpha', ['w1'], 'you stopped it')
    const first = stepE('w1', 'T1', 0)
    expect(await step(first)).toEqual(refusal(first, 'fixer #1 (w1) was stopped (you stopped it)'))
    const later = stepE('w1', 'T1', 1)
    expect(await step(later)).toEqual(refusal(later, 'this turn was refused at its first step'))
    expect((await events()).filter(e => e.kind === 'wake-refused')).toEqual([
      { kind: 'wake-refused', node: 'fixer', agentId: 'w1', turnId: 'T1', reason: 'fixer #1 (w1) was stopped (you stopped it)' },
    ])
    expect(state.status('w1')).toBe('idle')
  })

  test('the same for a node a revision removed, and one past its parent\'s count', async () => {
    await put(o1(), true)
    await put(w1(), false)
    await put(w2(), true)
    const past = stepE('w1', 'T2', 0)
    expect(await step(past)).toEqual(refusal(past, 'part-a (o1) already runs 1 of its max 1 fixer at once; wait for one to finish'))
    state.putLiveSwarm(live({ revision: 2, spec: spec({ nodes: spec().nodes.filter(n => n.id !== 'fixer') }) }))
    const gone = stepE('w1', 'T3', 0)
    expect(await step(gone)).toEqual(refusal(gone, "fixer isn't in swarm alpha's revision 2"))
    expect(await step(stepE('w1', 'T3', 4))).toEqual(refusal(stepE('w1', 'T3', 4), 'this turn was refused at its first step'))
  })

  test("an admitted wake takes a place and marks its policy admitted; a running node's step, and anyone else's, pass", async () => {
    await put(o1(), true)
    await put(w1(), false)
    const woke = await step(stepE('w1', 'T4', 0))
    expect(woke.called).toBe(true)
    expect(woke.chunks).toEqual([{ kind: 'text', index: 0, text: 'model says hi' }])
    expect(state.status('w1')).toBe('running')
    expect(policyOf('w1')?.admitted).toBe(true)
    expect((await step(stepE('w1', 'T4', 1))).called).toBe(true)
    expect((await step(stepE(undefined, 'L1', 0))).called).toBe(true)
    expect((await step(stepE('not-a-node', 'X1', 0))).called).toBe(true)
  })

  test('a wake while it settles (parked, or a stranded message) keeps its place', async () => {
    await put(o1(), true)
    await put(w1(), true)
    await put(w2(), false)
    state.markSettling('w1')
    expect((await step(stepE('w1', 'T5', 0))).called).toBe(true)
    expect(state.status('w1')).toBe('running')
  })
})

// WP-AJ: a node that ends its turn while the list shows it `waiting` is parked. It's alive, so it keeps its
// place in the swarm's count and its parent's, and its wake is admitted on that place.
describe('parked nodes', () => {
  const ended = (id: string) => admit.settleNode(p, { agentId: id, turnId: `t-${id}`, answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)

  /** o1 running, w1 ended its turn and parked on work that will wake it; the swarm at `cap` agents at once. */
  async function parkedW1(cap = 2): Promise<void> {
    state.putLiveSwarm(live({ spec: spec({ limits: { maxAgentsAtOnce: cap } }) }))
    await put(o1(), true)
    await put(w1(), true)
    p.agents = [agent('o1', T('part-a'), 'running'), agent('w1', T('fixer'), 'waiting', 'o1')]
    await ended('w1')
    await fireEvery(p)
    expect(state.isParked('w1')).toBe(true)
  }

  const PARKED_W1 =
    '1 of them is parked: fixer #1 (w1), which ended its turn with its own agents or background work still running, and keeps its place until it ends; wait for one to finish, or go on without this agent'

  test('its wake is admitted at a full cap and at its parent\'s max, on its own place: the count never passes the cap', async () => {
    await parkedW1()
    expect(state.countSwarm('alpha')).toBe(2)
    expect(state.countFor('alpha', 'o1', 'fixer')).toBe(1)
    const woke = await step(stepE('w1', 'T1', 0))
    expect(woke.called).toBe(true)
    expect(state.status('w1')).toBe('running')
    expect(state.isParked('w1')).toBe(false)
    expect(policyOf('w1')?.admitted).toBe(true)
    expect(state.countSwarm('alpha')).toBe(2)
    expect((await events()).filter(e => e.kind === 'wake-refused')).toEqual([])
    // Its later steps run, and its next turn.complete settles it as before.
    expect((await step(stepE('w1', 'T1', 1))).called).toBe(true)
    p.agents = [agent('o1', T('part-a'), 'running'), agent('w1', T('fixer'), 'completed', 'o1')]
    await ended('w1')
    await fireEvery(p)
    expect(state.status('w1')).toBe('idle')
    expect(state.isParked('w1')).toBe(false)
    expect(state.countSwarm('alpha')).toBe(1)
  })

  test('while it holds its place, a spawn at the cap is refused naming it, and so is a resume past its parent\'s max', async () => {
    await parkedW1()
    const { next, calls } = sendNext()
    // A child o1 starts counts toward the cap, which w1 fills with o1.
    const spawned = (await swarmSpawn(
      p,
      { tool_use_id: 'toolu_c', prompt: 'look around', description: 'a helper', subagentType: 'Explore', parentAgentId: 'o1', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'opus', background: false, fork: false } as never,
      (async () => ({ model: 'opus', agentId: 'c1' })) as never,
    )) as { deny?: string }
    expect(spawned.deny).toBe(`litter: swarm alpha is at its limit of 2 agents at once (limits.maxAgentsAtOnce), and ${PARKED_W1}`)
    expect(state.reservations()).toEqual([])
    // A finished fixer #2 its parent resumes: o1 runs w1 already, of its max 1.
    await put(w2(), false)
    expect(await send(sendE('w2', 'and the docs', 'o1'), next)).toEqual({
      isDelivered: false,
      reason: `litter: part-a (o1) already runs 1 of its max 1 fixer at once, and ${PARKED_W1}`,
    })
    expect(calls).toEqual([])
    expect(state.status('w2')).toBe('idle')
  })

  test('a refusal names only the parked: one with nothing parked reads as before', async () => {
    state.putLiveSwarm(live({ spec: spec({ limits: { maxAgentsAtOnce: 2 } }) }))
    await put(o1(), true)
    await put(w1(), true)
    expect(admit.capRefusal(state.liveSwarm('alpha')!)).toBe('swarm alpha is at its limit of 2 agents at once (limits.maxAgentsAtOnce); wait for one to finish')
    expect(admit.parentCountRefusal(state.liveSwarm('alpha')!, 'o1', 'fixer', 1)).toBe('part-a (o1) already runs 1 of its max 1 fixer at once; wait for one to finish')
    expect(admit.parentCountRefusal(state.liveSwarm('alpha')!, 'o1', 'fixer', 2)).toBeNull()
  })

  for (const [how, row] of [
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['killed', 'killed'],
    ['gone from the list', null],
  ] as const) {
    test(`once the list shows it ${how}, it's settled: its place frees and its policy stays not admitted`, async () => {
      await parkedW1()
      p.agents = row === null ? [agent('o1', T('part-a'), 'running')] : [agent('o1', T('part-a'), 'running'), agent('w1', T('fixer'), row, 'o1')]
      await fireEvery(p)
      expect(state.isParked('w1')).toBe(false)
      expect(state.status('w1')).toBe('idle')
      expect(state.countSwarm('alpha')).toBe(1)
      expect(policyOf('w1')?.admitted).toBe(false)
      // Nothing settles or is parked: the poll stops.
      await fireEvery(p)
      expect(p.timers.size).toBe(0)
    })
  }

  test('still alive in the list (`waiting`, `pending`, or `running` on a wake its step has yet to admit), it stays parked', async () => {
    await parkedW1()
    for (const st of ['waiting', 'pending', 'running'] as const) {
      p.agents = [agent('o1', T('part-a'), 'running'), agent('w1', T('fixer'), st, 'o1')]
      await fireEvery(p)
      expect(state.isParked('w1')).toBe(true)
      expect(state.countSwarm('alpha')).toBe(2)
    }
  })

  test("a resume its parent starts while the poll reads the list keeps its place and its admitted policy: the poll frees nothing it holds", async () => {
    await parkedW1()
    // The list now shows it completed, but its parent resumes it meanwhile: admitted, its send in flight.
    p.agents = [agent('o1', T('part-a'), 'running'), agent('w1', T('fixer'), 'completed', 'o1')]
    let entered!: () => void
    const inFlight = new Promise<void>(r => (entered = r))
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const next = (async () => {
      entered()
      await gate
      return { isDelivered: true }
    }) as never
    const sent = send(sendE('w1', 'and the docs', 'o1'), next)
    await inFlight
    expect(policyOf('w1')?.admitted).toBe(true)
    await fireEvery(p)
    expect(state.isParked('w1')).toBe(true)
    expect(policyOf('w1')?.admitted).toBe(true)
    release()
    expect(await sent).toEqual({ isDelivered: true })
    expect(state.status('w1')).toBe('running')
    expect(policyOf('w1')?.admitted).toBe(true)
    expect(state.countSwarm('alpha')).toBe(2)
  })

  test("another session's swarm, read-only here, is never settled, parked or freed by this session's poll, nor its policies written", async () => {
    state.putLiveSwarm(live({ readOnly: true }))
    await put(o1(), false)
    await put(w1(), true)
    state.markParked('w1')
    state.putBinding(w2())
    state.markSettling('w2')
    p.agents = []
    // A tool call kicks the poll: nothing of a read-only swarm is its work.
    await tool({ node: 'fixer#1', text: 'hi' })
    expect(p.timers.size).toBe(0)
    // A swarm of this session's own gives it work, and its tick, with no agent listed, still leaves them be.
    state.putLiveSwarm(live({ name: 'beta', owner: { ref: 'refs/litter-swarm/beta', oid: 'b'.repeat(40), generation: 1, session: 'test-session' } }))
    state.putBinding(bind('b1', { swarm: 'beta', node: 'part-a', kind: 'orchestrator', parent: null, cwd: '/repo' }))
    state.markSettling('b1')
    await tool({ node: 'fixer#1', text: 'hi' })
    expect(p.timers.size).toBe(1)
    await fireEvery(p)
    expect(state.status('b1')).toBe('idle')
    expect(p.timers.size).toBe(0)
    expect(state.isParked('w1')).toBe(true)
    expect(state.status('w2')).toBe('settling')
    expect(policyOf('w1')?.admitted).toBe(true)
  })

  test('a message to it goes as to a finished node, never queued: its parent resumes it on its own place, anyone else is readdressed', async () => {
    await parkedW1()
    wireOwnSends()
    // The browser's sends: it isn't running or settling, so nothing waits for it; it's idle, so they go via its
    // parent, an interject at once, a queued one on the running parent's queue, never on its own.
    const out = await admit.sendFromBrowser(p, { swarm: 'alpha', node: 'fixer#1', text: 'the docs too', when: 'interject', route: 'direct' })
    expect(out).toEqual(expect.objectContaining({ kind: 'readdressed', to: 'o1' }))
    const later = await admit.sendFromBrowser(p, { swarm: 'alpha', node: 'fixer#1', text: 'when you can: the docs', when: 'queue', route: 'direct' })
    expect(later).toEqual(expect.objectContaining({ kind: 'queued' }))
    expect(state.queued('alpha', 'w1')).toEqual([])
    expect(state.queued('alpha', 'o1').length).toBe(1)
    // Its parent's SendMessage resumes it at the full cap: admitted before the send, then running.
    let admittedAtSend: boolean | undefined
    const next = (async () => {
      admittedAtSend = policyOf('w1')?.admitted
      return { isDelivered: true }
    }) as never
    expect(await send(sendE('w1', 'and the docs', 'o1'), next)).toEqual({ isDelivered: true })
    expect(admittedAtSend).toBe(true)
    expect(state.status('w1')).toBe('running')
    expect(state.isParked('w1')).toBe(false)
    expect(state.reservations()).toEqual([])
    expect(state.countSwarm('alpha')).toBe(2)
  })

  test('a parked orchestrator is resumed on its own place too, not refused as another instance of itself', async () => {
    state.putLiveSwarm(live({ spec: spec({ limits: { maxAgentsAtOnce: 1 } }) }))
    wireOwnSends()
    await put(o1(), true)
    p.agents = [agent('o1', T('part-a'), 'waiting')]
    await ended('o1')
    await fireEvery(p)
    expect(state.isParked('o1')).toBe(true)
    expect(await tool({ node: 'part-a', text: 'status?' })).toEqual({ ok: true, node: 'part-a', agentId: 'o1', outcome: { kind: 'delivered' } })
    expect(state.status('o1')).toBe('running')
  })

  describe('its scope', () => {
    // A fixer that writes, sharing its parent's directory.
    const WRITER = spec({
      limits: { maxAgentsAtOnce: 4 },
      nodes: [
        { id: 'part-a', kind: 'orchestrator', tools: RO, spawns: { fixer: 2 } },
        { id: 'part-b', kind: 'orchestrator', tools: RO, spawns: { fixer: 1 } },
        { id: 'fixer', kind: 'worker' },
      ],
    })
    const scope = { dir: '/repo', paths: null, commit: false }

    async function parkedWriter(): Promise<void> {
      state.putLiveSwarm(live({ spec: WRITER }))
      await put(o1(), true)
      await put(bind('w1', { cwd: '/repo' }), false)
      state.markRunning('w1', scope)
      p.agents = [agent('w1', T('fixer'), 'waiting', 'o1')]
      await ended('w1')
      await fireEvery(p)
      expect(state.isParked('w1')).toBe(true)
      expect(state.activeScopes('alpha').map(x => x.agentId)).toEqual(['w1'])
    }

    test('another writer in its scope refuses its wake, and it stays parked; its own held scope does not', async () => {
      await parkedWriter()
      // Another writer got in (after a reload that lost w1's scope, say): fixer #2 under part-b, in /repo.
      await put(o2(), true)
      state.putBinding(bind('w2', { n: 2, parent: 'o2', cwd: '/repo' }))
      state.markRunning('w2', scope)
      const first = stepE('w1', 'T1', 0)
      const r = await step(first)
      expect(r.called).toBe(false)
      expect(r.result).toEqual(expect.objectContaining({ answer: 'litter: not admitted: another fixer is writing in /repo; wait for it, or use own worktrees; ending this turn' }))
      expect(state.isParked('w1')).toBe(true)
      expect(policyOf('w1')?.admitted).toBe(false)
      // Gone, it no longer refuses: the next wake is admitted.
      state.markSettled('w2')
      expect((await step(stepE('w1', 'T2', 0))).called).toBe(true)
      expect(state.status('w1')).toBe('running')
    })

    test('the agents working under it, in its scope, never refuse its wake', async () => {
      await parkedWriter()
      // fixer #2 under w1 (workers may spawn, decision C), and a child w1 started, both writing in /repo.
      state.putBinding(bind('w2', { n: 2, parent: 'w1', cwd: '/repo' }))
      state.markRunning('w2', scope)
      state.putBinding(bind('c1', { node: 'fixer', kind: 'child', n: 0, of: 'w1', parent: 'w1', cwd: '/repo' }))
      state.markRunning('c1', scope)
      expect((await step(stepE('w1', 'T1', 0))).called).toBe(true)
      expect(state.status('w1')).toBe('running')
    })
  })
})

describe('swarm.bind and adoption after a reload', () => {
  const TOK1 = '1'.repeat(32)
  const TOK2 = '2'.repeat(32)
  const TOK3 = '3'.repeat(32)
  const instance = (n: number, token: string, over: Record<string, unknown> = {}) =>
    appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.instance', {
      node: 'fixer',
      n,
      parentAgentId: 'o1',
      tool_use_id: `toolu_${n}`,
      cwd: `/repo/.claude/worktrees/sw-alpha-fixer-${n}`,
      branch: null,
      token,
      ...over,
    } as never)
  const ctx = (agentId: string | null): RecordCtx => ({ p, caller: { agentId, agentType: T('fixer') }, litterDir, options: normalizeOptions(undefined) })

  test('two own workers of one template under one parent, bindings lost: neither is guessed; each binds with its own token', async () => {
    await put(o1(), true)
    await instance(1, TOK1)
    await instance(2, TOK2)
    p.agents = [agent('x1', T('fixer'), 'running', 'o1'), agent('x2', T('fixer'), 'running', 'o1')]
    await admit.adoptUnbound(p)
    expect(state.binding('x1')).toBeNull()
    expect(state.binding('x2')).toBeNull()
    expect(policyOf('x1')).toEqual(expect.objectContaining({ bind: true, admitted: true }))
    expect(policyOf('x2')).toEqual(expect.objectContaining({ bind: true }))

    expect(await admit.recordSwarmBind(ctx('x2'), { kind: 'swarm.bind', token: TOK2 })).toEqual({
      ok: true,
      node: 'fixer',
      n: 2,
      cwd: '/repo/.claude/worktrees/sw-alpha-fixer-2',
      branch: null,
    })
    expect(state.binding('x2')).toEqual(expect.objectContaining({ node: 'fixer', n: 2, parent: 'o1', adopted: true, token: TOK2 }))
    expect(policyOf('x2')).toEqual(expect.objectContaining({ bind: false, admitted: true, n: 2 }))
    expect(state.status('x2')).toBe('running')
    // The other's token, now bound, is refused; its own is taken.
    expect(await admit.recordSwarmBind(ctx('x1'), { kind: 'swarm.bind', token: TOK2 })).toEqual(expect.objectContaining({ ok: false, field: 'token' }))
    expect(await admit.recordSwarmBind(ctx('x1'), { kind: 'swarm.bind', token: TOK1 })).toEqual(expect.objectContaining({ ok: true, n: 1 }))
    const rs = (await readLaunchLedger(p, litterDir, 'alpha', launch)).records
    expect(rs.map(r => r.kind)).toEqual(['swarm.instance', 'swarm.instance', 'swarm.bind', 'swarm.node', 'swarm.bind', 'swarm.node'])
    expect(rs[2]!.by).toEqual(expect.objectContaining({ source: 'agent', agentId: 'x2' }))
    expect(rs[3]!.body).toEqual(expect.objectContaining({ agentId: 'x2', n: 2, adopted: true }))
  })

  test("a token of another node's instance, from a bound agent, or from an agent with another parent is refused", async () => {
    await put(o1(), true)
    await instance(1, TOK1)
    await instance(1, TOK3, { node: 'scout' })
    p.agents = [agent('x1', T('fixer'), 'running', 'o1'), agent('x3', T('fixer'), 'running', 'o2'), agent('o1', T('part-a'), 'running')]
    const refusedToken = expect.objectContaining({ ok: false, field: 'token' })
    expect(await admit.recordSwarmBind(ctx('x1'), { kind: 'swarm.bind', token: TOK3 })).toEqual(refusedToken)
    expect(await admit.recordSwarmBind(ctx('x3'), { kind: 'swarm.bind', token: TOK1 })).toEqual(refusedToken)
    expect(await admit.recordSwarmBind(ctx('o1'), { kind: 'swarm.bind', token: TOK1 })).toEqual(expect.objectContaining({ ok: false, field: 'kind' }))
    expect(await admit.recordSwarmBind(ctx(null), { kind: 'swarm.bind', token: TOK1 })).toEqual(expect.objectContaining({ ok: false, field: 'kind' }))
    expect(await admit.recordSwarmBind(ctx('x1'), { kind: 'swarm.bind', token: 'not-a-token' })).toEqual(refusedToken)
    expect(state.binding('x1')).toBeNull()
    expect(state.binding('x3')).toBeNull()
  })

  test('a single matching instance is adopted without a token', async () => {
    await put(o1(), true)
    await instance(1, TOK1)
    p.agents = [agent('x1', T('fixer'), 'completed', 'o1')]
    await admit.adoptUnbound(p)
    expect(state.binding('x1')).toEqual(expect.objectContaining({ node: 'fixer', n: 1, adopted: true, cwd: '/repo/.claude/worktrees/sw-alpha-fixer-1' }))
    expect(state.status('x1')).toBe('idle')
    expect(policyOf('x1')).toEqual(expect.objectContaining({ bind: false, admitted: false }))
    const rs = (await readLaunchLedger(p, litterDir, 'alpha', launch)).records
    expect(rs.at(-1)!.body).toEqual(expect.objectContaining({ agentId: 'x1', adopted: true }))
  })

  // WP-AJ: as recovery marks a `waiting` node with no copy, so its next step is admitted on the place it holds.
  test('one the list shows `waiting` (2.1.289) is adopted parked: it holds its place, its policy admitted, as it may be mid-turn, and so is its next step', async () => {
    await put(o1(), true)
    await instance(1, TOK1)
    p.agents = [agent('x1', T('fixer'), 'waiting', 'o1')]
    await admit.adoptUnbound(p)
    expect(state.binding('x1')).toEqual(expect.objectContaining({ node: 'fixer', n: 1, adopted: true }))
    expect(state.isParked('x1')).toBe(true)
    expect(state.countFor('alpha', 'o1', 'fixer')).toBe(1)
    // With no copy to say its turn is over, a call of its response may still be due with no step between.
    expect(policyOf('x1')).toEqual(expect.objectContaining({ bind: false, admitted: true }))
    // Its parent is at its max of 1 fixer, x1 counted: the step is admitted on x1's own place.
    expect((await step(stepE('x1', 'T1', 0))).called).toBe(true)
    expect(state.status('x1')).toBe('running')
    expect(state.isParked('x1')).toBe(false)
    expect(policyOf('x1')?.admitted).toBe(true)
  })
})

describe('U5: one budget per hook dispatch', () => {
  /** The engine's `next.budget`, read fresh on each access: `left` ms when made, spent by the fake clock's sleeps. */
  function metered<N extends object>(next: N, left: number): N {
    const start = p.clock.now!
    Object.defineProperty(next, 'budget', {
      get: () => Object.freeze({ ms: 10_000, remainingMs: Math.max(0, left - (p.clock.now! - start)) }),
      enumerable: true,
    })
    return next
  }
  const slept = () => p.sleeps.reduce((a, b) => a + b, 0)

  async function settlingWorker(): Promise<void> {
    await put(o1(), true)
    await put(w1(), true)
    p.agents = [agent('w1', T('fixer'), 'running', 'o1')]
    await admit.settleNode(p, { agentId: 'w1', turnId: 't1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as never)
    expect(state.status('w1')).toBe('settling')
  }

  test('a send to a settling node after a slow rebind waits only what the hook has left, then refuses and queues nothing', async () => {
    await settlingWorker()
    const { next, calls } = sendNext()
    // rebound spent 8.9 s of the 10 s: 1.1 s left, of which 500 ms is kept back.
    const r = await send(sendE('w1', 'and the changelog'), metered(next as object, 1_100) as never)
    expect(r).toEqual({ isDelivered: false, reason: expect.stringContaining('ran out of time to wait for it') })
    expect(slept()).toBeLessThanOrEqual(600)
    expect(calls).toEqual([])
    expect(state.queued('alpha')).toEqual([])
    expect((await events()).at(-1)).toEqual(expect.objectContaining({ kind: 'send-refused', agentId: 'w1' }))
  })

  test("the ready gate takes only what's left too: a closed gate rejects before the hook's budget does", async () => {
    await settlingWorker()
    state.closeGate()
    const { next, calls } = sendNext()
    await expect(send(sendE('w1', 'and the changelog'), metered(next as object, 2_000) as never)).rejects.toThrow("litter: the swarm state isn't ready")
    expect(slept()).toBeLessThanOrEqual(1_500)
    expect(calls).toEqual([])
    expect(state.queued('alpha')).toEqual([])
  })

  test("with nothing metering the dispatch, its waits share the hook's 10 s from the hook's start", async () => {
    await settlingWorker()
    state.closeGate()
    // The gate opens after 7.9 s of polling, inside ready's own 8 s: the settle wait gets what's left of the 9.5 s.
    p.onSleep = () => {
      if (slept() === 7_900) state.openGate()
    }
    const { next, calls } = sendNext()
    const r = await send(sendE('w1', 'and the changelog'), next)
    expect(r).toEqual({ isDelivered: false, reason: expect.stringContaining('ran out of time to wait for it') })
    expect(slept()).toBeLessThanOrEqual(9_500)
    expect(calls).toEqual([])
    expect(state.queued('alpha')).toEqual([])
  })

  test('plenty left: the settle wait keeps its own 2 s cap, then queues as before', async () => {
    await settlingWorker()
    const { next } = sendNext()
    expect(await send(sendE('w1', 'and the changelog'), metered(next as object, 9_000) as never)).toEqual({ isDelivered: true })
    expect(p.sleeps).toEqual(Array(8).fill(250))
    expect(state.queued('alpha').map(m => m.text)).toEqual(['and the changelog'])
  })

  test("swarm_send: the lead's send to a settling node is refused in the tool's shape, with nothing queued", async () => {
    await settlingWorker()
    const next = metered(
      (() => {
        throw new Error('swarm_send is answered by the mod')
      }) as object,
      1_100,
    )
    const reply = (await admit.swarmSendTool(p, { tool: SWARM_SEND, tool_use_id: 'toolu_s', swarm: 'alpha', node: 'fixer#1', text: 'and the changelog' } as never, next as never)) as {
      result: string
    }
    expect(JSON.parse(reply.result)).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('ran out of time to wait for it') }))
    expect(slept()).toBeLessThanOrEqual(600)
    expect(state.queued('alpha')).toEqual([])
  })

  test("turn.step: a node's step waits on a closed gate only for what's left", async () => {
    await put(o1(), true)
    await put(w1(), false)
    state.closeGate()
    const next = metered(async function* () {
      yield { kind: 'text' as const, index: 0, text: 'model says hi' }
    } as object, 1_000)
    const gen = admit.admitStep(p, stepE('w1', 't1', 0) as never, next as never) as AsyncGenerator<unknown, unknown>
    await expect(gen.next()).rejects.toThrow("litter: the swarm state isn't ready")
    expect(slept()).toBeLessThanOrEqual(500)
  })

  test("the browser's send takes the budget it's handed", async () => {
    await settlingWorker()
    const budget = await admit.waitBudget(p, metered({}, 1_100))
    const out = await admit.sendFromBrowser(p, { swarm: 'alpha', node: 'fixer#1', text: 'and the changelog', when: 'interject', route: 'direct' }, budget)
    expect(out).toEqual(expect.objectContaining({ kind: 'refused', canQueue: true, reason: expect.stringContaining('ran out of time to wait for it') }))
    expect(slept()).toBeLessThanOrEqual(600)
    expect(state.queued('alpha')).toEqual([])
  })
})
