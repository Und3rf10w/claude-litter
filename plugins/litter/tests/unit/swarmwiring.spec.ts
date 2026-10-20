// Tier 2: the swarm hooks' catches and the agent.offer handler
// (hooks/swarm/wiring.ts; WP-C §10), called directly with a fake `next`: a
// node's event is refused in its event's own shape, anyone else's passes on,
// and none is refused once its hook had called `next` (WP-CH, `next.called`).
// And two checks of register.tsx's source: session.start's order, and the
// renders that don't rebind.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as state from '../../hooks/swarm/state'
import type { LiveSwarm, NodeBinding } from '../../hooks/swarm/types'
import {
  agentOfferFailed,
  agentSpawnFailed,
  clearHoldFailed,
  litterCommandFailed,
  offerSwarmType,
  paneRenderFailed,
  sessionSendFailed,
  swarmProposeFailed,
  swarmReadFailed,
  swarmSendFailed,
  turnStartFailed,
  turnStepFailed,
  uiInputFailed,
  uiMessageFailed,
  uiPressFailed,
  uiSelectFailed,
} from '../../hooks/swarm/wiring'
import { nodePorts } from './support/node-ports'

const $ = {} as never
/** What the fake `next` answers: the event passed on. Typed as never so it stands for any event's result. */
const PASSED = { passed: true } as never

/**
 * A catch's `next`: records what it was called with, and carries the failure
 * and `called`, whether the failed hook had called its own `next` already.
 */
function caught(message: string | undefined = 'boom', called = false) {
  const calls: unknown[] = []
  const next = Object.assign(
    async (e: unknown) => {
      calls.push(e)
      return PASSED
    },
    { error: { kind: 'throw', message, budget: 1000 }, called },
  )
  return { next: next as never, calls }
}

function swarm(name: string, over: Partial<LiveSwarm> = {}): LiveSwarm {
  return {
    name,
    launch: '20270115-093000',
    revision: 1,
    spec: { name, goal: 'g', nodes: [{ id: 'fixer', kind: 'worker' }] },
    nonce: 'n',
    types: { fixer: `litter:sw-${name}-fixer` },
    typesReady: true,
    dirs: {},
    sessionCwd: '/repo',
    worktreeRoot: '/repo/.claude/worktrees',
    commonDir: '/repo/.git',
    roots: { litterDir: '/repo/.claude/litter', litterCopies: [], ruleDirs: [] },
    tips: {},
    owner: { ref: `refs/litter-swarm/${name}`, oid: 'a'.repeat(40), generation: 1, session: 's' },
    state: 'live',
    readOnly: false,
    lost: false,
    flags: { isolationLost: false },
    startedAt: 0,
    ...over,
  }
}

const node = (agentId: string): NodeBinding => ({
  agentId,
  swarm: 'alpha',
  launch: '20270115-093000',
  node: 'fixer',
  n: 1,
  kind: 'worker',
  of: null,
  parent: null,
  type: 'litter:sw-alpha-fixer',
  cwd: '/repo',
  branch: null,
  token: 't',
  revision: 1,
  generation: 1,
  boundAt: 0,
  adopted: false,
})

beforeEach(() => {
  state.resetForTests()
  state.putLiveSwarm(swarm('alpha'))
  state.putBinding(node('node-1'))
})
afterEach(() => state.resetForTests())

describe('agent.spawn', () => {
  const spawn = (subagentType: string, parentAgentId?: string) =>
    ({ subagentType, prompt: 'p', description: 'd', ...(parentAgentId ? { parentAgentId } : {}) }) as never

  test('a swarm type, from the lead or anyone, is denied naming the failure', async () => {
    for (const parent of [undefined, 'someone']) {
      const { next, calls } = caught('state unreadable')
      const r = await agentSpawnFailed($, spawn('litter:sw-alpha-fixer', parent), next)
      expect(r).toEqual({ deny: 'litter guard failed: agent.spawn (state unreadable); refusing' })
      expect(calls).toEqual([])
    }
  })

  test("a bound node's spawn of any type is denied", async () => {
    const { next, calls } = caught()
    expect(await agentSpawnFailed($, spawn('Explore', 'node-1'), next)).toEqual({ deny: 'litter guard failed: agent.spawn (boom); refusing' })
    expect(calls).toEqual([])
  })

  test("anything else gets the role block's catch: a main-thread litter role denied, the rest passed on", async () => {
    const role = caught()
    expect(await agentSpawnFailed($, spawn('litter:executor'), role.next)).toEqual({ deny: 'litter guard failed: agent.spawn; refusing' })
    const plain = caught()
    expect(await agentSpawnFailed($, spawn('Explore', 'unbound-agent'), plain.next)).toBe(PASSED)
    expect(plain.calls.length).toBe(1)
    const lead = caught()
    expect(await agentSpawnFailed($, spawn('Explore'), lead.next)).toBe(PASSED)
  })

  // 2.1.299 raises agent.spawn for a resumed run: a deny would leave it parked, and its first step is admitted at
  // turn.step (whose own catch refuses a bound node's), so a resume passes on, a swarm type's or a node's too.
  test('a resumed run passes on, of any type, by anyone', async () => {
    for (const [type, parent] of [['litter:sw-alpha-fixer', 'node-1'], ['litter:executor', undefined], ['Explore', 'node-1']] as const) {
      const { next, calls } = caught()
      const e = { ...(spawn(type, parent) as object), resume: { agentId: 'node-1' } } as never
      expect(await agentSpawnFailed($, e, next)).toBe(PASSED)
      expect(calls.length).toBe(1)
    }
  })

  // 2.1.292 raises agent.spawn for each agent() a workflow script starts (`workflow`, no parentAgentId), and asks
  // the catch in the hook's place for one raised beneath the hook's own frame (HookFailure 're-entry').
  test("a workflow's agent of a litter role passes, as litter's own runs start them; a workflow's of a swarm type is denied", async () => {
    const wf = (subagentType: string) => ({ ...(spawn(subagentType) as object), workflow: { runId: 'wf_1', agentIndex: 1 } }) as never
    for (const type of ['litter:executor', 'litter:verifier', 'Explore']) {
      const { next, calls } = caught('re-entry')
      expect(await agentSpawnFailed($, wf(type), next)).toBe(PASSED)
      expect(calls.length).toBe(1)
    }
    for (const type of ['litter:sw-alpha-fixer', 'sw-alpha-fixer']) {
      const { next, calls } = caught('re-entry')
      expect((await agentSpawnFailed($, wf(type), next)) as unknown).toEqual({ deny: expect.stringContaining('litter guard failed: agent.spawn') })
      expect(calls).toEqual([])
    }
  })

  test('once the hook had called next the subagent has started: every spawn gets what that call settled to, never a deny', async () => {
    for (const e of [spawn('litter:sw-alpha-fixer'), spawn('Explore', 'node-1'), spawn('litter:executor'), spawn('Explore')]) {
      const { next, calls } = caught('ran past its budget', true)
      expect(await agentSpawnFailed($, e, next)).toBe(PASSED)
      expect(calls).toEqual([e])
    }
  })
})

describe('session.send', () => {
  test('a send from or to a bound node is not delivered', async () => {
    for (const e of [
      { to: 'main', text: 'hi', origin: { kind: 'model' }, agentId: 'node-1' },
      { to: 'node-1', text: 'hi', origin: { kind: 'model' } },
    ]) {
      const { next, calls } = caught('gate')
      expect(await sessionSendFailed($, e as never, next)).toEqual({ isDelivered: false, reason: 'litter guard failed: session.send (gate)' })
      expect(calls).toEqual([])
    }
  })

  test('while a swarm this session owns is live, a send to anything but a known non-node is refused: a name or address could be a node', async () => {
    for (const to of ['teammate', 'fixer', 'agent-xyz@session-1']) {
      const { next, calls } = caught('gate')
      expect(await sessionSendFailed($, { to, text: 'hi', origin: { kind: 'model' }, agentId: 'other' } as never, next)).toEqual({
        isDelivered: false,
        reason: 'litter guard failed: session.send (gate)',
      })
      expect(calls).toEqual([])
    }
  })

  test("an unbound sender's send to main, the lead, passes on while a swarm is live", async () => {
    const { next, calls } = caught()
    expect(await sessionSendFailed($, { to: 'main', text: 'hi', origin: { kind: 'model' }, agentId: 'other' } as never, next)).toBe(PASSED)
    expect(calls.length).toBe(1)
  })

  test("with no swarm live, or only another session's (read-only), anyone's unbound send passes on", async () => {
    state.resetForTests()
    for (const setup of [() => {}, () => state.putLiveSwarm(swarm('ro', { readOnly: true }))]) {
      setup()
      const { next, calls } = caught()
      expect(await sessionSendFailed($, { to: 'teammate', text: 'hi', origin: { kind: 'model' }, agentId: 'other' } as never, next)).toBe(PASSED)
      expect(calls.length).toBe(1)
    }
  })

  test("once the hook had called next the message was sent: a node's send gets that send's answer, never isDelivered false", async () => {
    for (const e of [
      { to: 'main', text: 'hi', origin: { kind: 'model' }, agentId: 'node-1' },
      { to: 'node-1', text: 'hi', origin: { kind: 'model' } },
      { to: 'teammate', text: 'hi', origin: { kind: 'model' }, agentId: 'other' },
    ]) {
      const { next, calls } = caught('gate', true)
      expect(await sessionSendFailed($, e as never, next)).toBe(PASSED)
      expect(calls).toEqual([e])
    }
  })
})

describe('turn.step', () => {
  async function run(gen: AsyncGenerator<unknown, unknown>) {
    const chunks: unknown[] = []
    for (;;) {
      const r = await gen.next()
      if (r.done) return { chunks, result: r.value }
      chunks.push(r.value)
    }
  }
  const stepNext = (message = 'boom', wasCalled = false) => {
    let called = 0
    const next = Object.assign(
      async function* () {
        called++
        yield { kind: 'text', index: 0, text: 'from the model' }
        return { turnId: 't', index: 0, answer: 'from the model', toolUses: [], stopReason: 'end_turn', usage: null }
      },
      { error: { kind: 'timeout', message, budget: 1000 }, called: wasCalled },
    )
    return { next: next as never, count: () => called }
  }

  test("a bound node's step gets the refusal stream and the whole TurnStepResult", async () => {
    const { next, count } = stepNext('state unreadable')
    const out = await run(turnStepFailed($, { turnId: 'turn-9', index: 2, model: 'm', messageCount: 3, agentId: 'node-1' } as never, next) as never)
    const answer = 'litter guard failed: turn.step (state unreadable); ending this turn'
    expect(out.chunks).toEqual([
      { kind: 'text', index: 0, text: answer },
      { kind: 'stop', stopReason: 'end_turn', usage: null },
    ])
    expect(out.result).toEqual({ turnId: 'turn-9', index: 2, answer, toolUses: [], stopReason: 'end_turn', usage: null })
    expect(count()).toBe(0)
  })

  test("the lead's and an unbound agent's steps pass through, chunks and result", async () => {
    for (const agentId of [undefined, 'other']) {
      const { next, count } = stepNext()
      const out = await run(turnStepFailed($, { turnId: 't', index: 0, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) } as never, next) as never)
      expect(out.chunks).toEqual([{ kind: 'text', index: 0, text: 'from the model' }])
      expect(out.result).toEqual(expect.objectContaining({ answer: 'from the model' }))
      expect(count()).toBe(1)
    }
  })

  test('once the hook had called next the request was sent: nothing is yielded, nothing beneath runs again, and that call stands', async () => {
    for (const agentId of ['node-1', undefined, 'other']) {
      const { next, count } = stepNext('the stream beneath failed', true)
      const out = await run(turnStepFailed($, { turnId: 't', index: 0, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) } as never, next) as never)
      expect({ agentId, ...out }).toEqual({ agentId, chunks: [], result: undefined })
      expect(count()).toBe(0)
    }
  })
})

describe('the catches that pass on', () => {
  test('turn.start, agent.offer, the clear, the panes and their ui events', async () => {
    const all = [turnStartFailed, agentOfferFailed, clearHoldFailed, paneRenderFailed, uiMessageFailed, uiPressFailed, uiInputFailed, uiSelectFailed]
    for (const [i, handler] of all.entries()) {
      const { next, calls } = caught()
      const e = { i }
      expect(await (handler as (a: never, b: never, c: never) => Promise<unknown>)($, e as never, next)).toBe(PASSED)
      expect(calls).toEqual([e])
    }
  })
})

describe('the commands and the tools', () => {
  test('/litter answers a one-line failure text, naming the section typed', async () => {
    const e = (args: string) => ({ command: 'litter', args, origin: { kind: 'user' }, presentation: 'text' }) as never
    expect(await litterCommandFailed($, e(''), caught('no pane').next)).toEqual({ text: '/litter failed (no pane)' })
    expect(await litterCommandFailed($, e('swarms demo'), caught('no pane').next)).toEqual({ text: '/litter swarms failed (no pane)' })
    // An error worded for the model, as litter's and the engine's are, is shown without its `litter: `.
    expect(await litterCommandFailed($, e('swarms demo'), caught("litter: there's no live swarm named demo").next)).toEqual({ text: "/litter swarms failed (there's no live swarm named demo)" })
    expect(await litterCommandFailed($, e('doctor'), caught('litter: $.ui.open refused').next)).toEqual({ text: '/litter doctor failed ($.ui.open refused)' })
    // The word typed is letters only, and short: nothing else of it is echoed.
    expect(await litterCommandFailed($, e('[x](y)-and-a-very-long-word'), caught('no pane').next)).toEqual({ text: '/litter xyandaverylo failed (no pane)' })
  })

  test('each swarm tool is denied naming its hook, never passed on', async () => {
    const cases = [
      [swarmProposeFailed, 'mcp__litter__swarm_propose'],
      [swarmReadFailed, 'mcp__litter__swarm_read'],
      [swarmSendFailed, 'mcp__litter__swarm_send'],
    ] as const
    for (const [handler, tool] of cases) {
      const { next, calls } = caught('line one\n  line two')
      const r = await (handler as (a: never, b: never, c: never) => Promise<unknown>)($, { tool, tool_use_id: 'u' } as never, next)
      expect(r).toEqual({ deny: `litter guard failed: ${tool} (line one line two); refusing` })
      expect(calls).toEqual([])
    }
  })

  test("a failure with no message names its kind, and a long one is cut", async () => {
    const none = Object.assign(async () => PASSED, { error: { kind: 'timeout', budget: 1000 }, called: false })
    expect(await swarmSendFailed($, { tool: 'mcp__litter__swarm_send' } as never, none as never)).toEqual({
      deny: 'litter guard failed: mcp__litter__swarm_send (timeout); refusing',
    })
    const r = (await swarmSendFailed($, { tool: 'mcp__litter__swarm_send' } as never, caught('x'.repeat(1000)).next)) as { deny: string }
    expect(r.deny.length).toBeLessThan(400)
  })
})

// register.tsx is the engine's to load (tier 1), and its module state isn't a
// spec's to read; validate lists its hooks, not what each body awaits. So
// these two pin, from its source, what a behaviour test can't see yet.
describe("register.tsx's order and its renders", () => {
  const source = readFileSync(join(import.meta.dir, '..', '..', 'hooks', 'register.tsx'), 'utf8')
  const hookBody = (head: string): string => {
    const at = source.indexOf(head)
    expect({ head, found: at >= 0 }).toEqual({ head, found: true })
    return source.slice(at, source.indexOf('}).catch(', at))
  }

  test('session.start opens the gate right after the swarms are recovered, before the slower steps', () => {
    const body = hookBody("on('session.start'")
    expect(body).toContain('await withGateClosed(async openGateNow =>')
    const marks = [...body.matchAll(/step\(p, '([^']+)'|openGateNow\(\)/g)].map(m => m[1] ?? 'the gate opens')
    expect(marks).toEqual([
      'tools',
      'swarm tools',
      'roles',
      // Phase 5b (WP-DA): /litter, the one command.
      'litter command',
      'litterDir',
      'swarm state',
      'swarm pending',
      'swarms',
      'the gate opens',
      // WP-DH: the swarms' spend counts from the session's total, first after the gate.
      'swarm spend',
      'worktree.json',
      // WP-AQ: litterDir's .gitignore, once worktree.json has made the folder.
      '.gitignore',
      // Phase 6 (16.7): the rule exports' sync, on a timer, once litterDir is set up.
      'rule exports',
      'drain',
      'reconcile',
      'leftover worktrees',
      'leftover node policies',
      'options',
      'timers',
      'swarm timers',
      'pane timer',
      // Phase 5 (WP-CA): the asks and the cards back, then the ui tick (which took the board's timer, WP-DA).
      'asks',
      'cards',
      'ui timer',
    ])
  })

  test("the `litter` pane's ui.render doesn't await rebound: a rebind writes $.state, which a render can't", () => {
    const body = hookBody(`on('ui.render', { component: 'Pane', requestId: 'litter' }`)
    expect(body.includes('rebound(')).toBe(false)
    // One pane: no render for the old pane ids is left.
    for (const old of ['litter-swarm', 'litter-doctor', 'litter-board', 'litter-rules', 'litter-tasks', 'litter-agents']) expect(source.includes(`requestId: '${old}'`)).toBe(false)
    // Every other hook but session.start and session.end still does.
    const others = [...source.matchAll(/on\('([a-z.]+)'[^\n]*\n([\s\S]*?)\}\)\.catch\(/g)].filter(
      m => !['session.start', 'session.end', 'ui.render'].includes(m[1]!),
    )
    expect(others.length).toBeGreaterThan(15)
    for (const m of others) expect({ hook: m[1], rebound: m[2]!.includes('await rebound(p)') }).toEqual({ hook: m[1], rebound: true })
  })
})

describe('offerSwarmType', () => {
  const p = nodePorts()
  const offer = async (agent: string) => {
    const { next, calls } = caught()
    const r = await offerSwarmType(p, { agent, description: 'd', source: 'plugin', provider: { plugin: 'litter', tier: 'user' } } as never, next)
    return { r, passed: calls.length === 1 }
  }

  test("a live, owned swarm's type is offered", async () => {
    expect(await offer('litter:sw-alpha-fixer')).toEqual({ r: PASSED, passed: true })
  })

  test("an ended swarm's type, a read-only one's and a lost one's are not", async () => {
    state.putLiveSwarm(swarm('ro', { readOnly: true }))
    state.putLiveSwarm(swarm('gone', { lost: true }))
    state.putLiveSwarm(swarm('ended'))
    state.dropLiveSwarm('ended')
    for (const t of ['litter:sw-ended-fixer', 'litter:sw-ro-fixer', 'litter:sw-gone-fixer', 'litter:sw-never-fixer']) {
      expect({ t, ...(await offer(t)) }).toEqual({ t, r: { isOffered: false }, passed: false })
    }
  })

  test('a run role and any other type pass on', async () => {
    for (const t of ['litter:executor', 'Explore', 'other-plugin:sw-x']) expect(await offer(t)).toEqual({ r: PASSED, passed: true })
  })
})
