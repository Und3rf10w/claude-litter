// Tier 2: the swarm hooks' catches and the agent.offer handler
// (hooks/swarm/wiring.ts; WP-C §10), called directly with a fake `next`: a
// node's event is refused in its event's own shape, anyone else's passes on.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as state from '../../hooks/swarm/state'
import type { LiveSwarm, NodeBinding } from '../../hooks/swarm/types'
import {
  agentOfferFailed,
  agentSpawnFailed,
  clearHoldFailed,
  doctorCommandFailed,
  offerSwarmType,
  paneRenderFailed,
  sessionSendFailed,
  swarmCommandFailed,
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

/** A catch's `next`: records what it was called with, and carries the failure. */
function caught(message: string | undefined = 'boom') {
  const calls: unknown[] = []
  const next = Object.assign(
    async (e: unknown) => {
      calls.push(e)
      return PASSED
    },
    { error: { kind: 'throw', message, budget: 1000 }, called: false },
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

  test("anyone else's passes on", async () => {
    const { next, calls } = caught()
    expect(await sessionSendFailed($, { to: 'teammate', text: 'hi', origin: { kind: 'model' }, agentId: 'other' } as never, next)).toBe(PASSED)
    expect(calls.length).toBe(1)
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
  const stepNext = (message = 'boom') => {
    let called = 0
    const next = Object.assign(
      async function* () {
        called++
        yield { kind: 'text', index: 0, text: 'from the model' }
        return { turnId: 't', index: 0, answer: 'from the model', toolUses: [], stopReason: 'end_turn', usage: null }
      },
      { error: { kind: 'timeout', message, budget: 1000 }, called: false },
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
  test('the swarm commands answer a one-line failure text', async () => {
    const e = { command: 'litter-swarm', args: '', origin: { kind: 'user' }, presentation: 'text' } as never
    expect(await swarmCommandFailed($, e, caught('no pane').next)).toEqual({ text: 'litter: /litter-swarm failed (no pane)' })
    expect(await doctorCommandFailed($, e, caught('no pane').next)).toEqual({ text: 'litter: /litter-doctor failed (no pane)' })
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
