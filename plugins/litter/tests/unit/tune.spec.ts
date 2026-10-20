// Tier 2: a node's model and effort (WP-DI; the user's live look of
// 2026-10-07, "right click here and see the model and effort level ... bonus
// points for adjustment"): state.ts keeps what each node's last request named
// and what you set, mirrored with the swarm; admitStep sends each request
// with what you set (and the spec node's effort otherwise), and notes what
// it named; tuneNode checks a model nothing here ran with before it sets it.
// The browser's rows and panel are view.spec.ts's.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { nodePolicyFor, writeNodePolicy } from '../../hooks/swarm/guard'
import { newLaunchId, readLaunchLedger } from '../../hooks/records/swarm'
import { updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import * as admit from '../../hooks/swarm/admit'
import type { LiveSwarm, NodeBinding, SwarmSpec } from '../../hooks/swarm/types'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const NOW = 1_800_000_000_000
const T = (node: string) => `litter:sw-alpha-${node}`
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

let p: TestPorts
let litterDir: string
let launch: string
let cleanup: () => void

const spec = (): SwarmSpec => ({
  name: 'alpha',
  goal: 'ship it',
  nodes: [
    { id: 'part-a', kind: 'orchestrator', effort: 'high', spawns: { fixer: 1 } },
    { id: 'fixer', kind: 'worker' },
  ],
})

const live = (over: Partial<LiveSwarm> = {}): LiveSwarm => ({
  name: 'alpha',
  launch,
  revision: 1,
  spec: spec(),
  nonce: 'n0nce',
  types: { 'part-a': T('part-a'), fixer: T('fixer') },
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
})

const bind = (agentId: string, over: Partial<NodeBinding> = {}): NodeBinding => ({
  agentId,
  swarm: 'alpha',
  launch,
  node: 'fixer',
  n: 1,
  kind: 'worker',
  of: null,
  parent: 'o1',
  type: T('fixer'),
  cwd: '/repo',
  branch: null,
  token: null,
  revision: 1,
  generation: 1,
  boundAt: NOW,
  adopted: false,
  ...over,
})

const o1 = () => bind('o1', { node: 'part-a', kind: 'orchestrator', parent: null, type: T('part-a') })
const c1 = () => bind('c1', { node: 'part-a', kind: 'child', parent: 'o1', of: 'o1', type: 'general-purpose' })

async function put(b: NodeBinding): Promise<void> {
  state.putBinding(b)
  state.markRunning(b.agentId, null)
  await writeNodePolicy(p, litterDir, b.agentId, nodePolicyFor(b, state.liveSwarm('alpha')!, { admitted: true, stopped: null, bind: false }))
}

/** Runs admitStep on a running node's step; answers what `next` was given. */
async function step(agentId: string, over: { model?: string; effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | number } = {}) {
  const e = { turnId: 't1', index: 0, model: 'claude-opus-5-5[1m]', messageCount: 2, agentId, ...over }
  let sent: typeof e | null = null
  const next = async function* (x: typeof e) {
    sent = x
    yield { kind: 'text' as const, index: 0, text: 'hi' }
    return { turnId: x.turnId, index: x.index, answer: 'hi', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  }
  const gen = admit.admitStep(p, e as never, next as never) as AsyncGenerator<unknown, unknown>
  for (let s = await gen.next(); !s.done; s = await gen.next());
  return { e, sent: sent as typeof e | null }
}

const events = async () =>
  (await readLaunchLedger(p, litterDir, 'alpha', launch)).records.filter(r => r.kind === 'swarm.event').map(r => r.body as Record<string, unknown>)

beforeEach(async () => {
  state.resetForTests()
  admit.resetForTests()
  p = nodePorts()
  let dir: string
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

describe('state: what a node ran with and what you set', () => {
  test('a request is noted only when its model or effort changes, and mirrored with the swarm across a reload', async () => {
    state.attach(p, litterDir)
    state.putBinding(o1())
    state.noteStepModel('o1', 'claude-opus-5-5[1m]', 'xhigh', NOW)
    const v = state.version()
    state.noteStepModel('o1', 'claude-opus-5-5[1m]', 'xhigh', NOW + 1)
    expect(state.version()).toBe(v)
    state.noteStepModel('o1', 'claude-opus-5-5[1m]', null, NOW + 2)
    expect(state.version()).toBe(v + 1)
    state.tuneModel('o1', { model: 'claude-sonnet-5-5' })
    await state.flushed()
    const part = p.storeMap.get(state.swarmStateKey(litterDir, 'alpha')) as state.SwarmPart
    expect(part.seen).toEqual({ o1: { model: 'claude-opus-5-5[1m]', effort: null, at: NOW + 2 } })
    expect(part.tuned).toEqual({ o1: { model: 'claude-sonnet-5-5' } })
    state.resetForTests()
    await state.loadSwarm(p, litterDir, 'alpha')
    expect(state.stepModel('o1')).toEqual({ model: 'claude-opus-5-5[1m]', effort: null, at: NOW + 2 })
    expect(state.tunedModel('o1')).toEqual({ model: 'claude-sonnet-5-5' })
    expect(state.modelsSeen()).toEqual(['claude-opus-5-5[1m]'])
  })

  test('each field is set and cleared on its own; an unbound agent is ignored; a dropped one keeps neither', () => {
    state.putBinding(o1())
    state.tuneModel('o1', { model: 'claude-sonnet-5-5', effort: 'low' })
    state.tuneModel('o1', { model: null })
    expect(state.tunedModel('o1')).toEqual({ effort: 'low' })
    state.tuneModel('o1', { effort: null })
    expect(state.tunedModel('o1')).toBeNull()
    state.tuneModel('nobody', { effort: 'max' })
    expect(state.tunedModel('nobody')).toBeNull()
    state.tuneModel('o1', { effort: 'max' })
    state.noteStepModel('o1', 'm', 'max', NOW)
    state.dropBinding('o1')
    expect([state.tunedModel('o1'), state.stepModel('o1')]).toEqual([null, null])
  })

  test("an older part has neither; a malformed entry is dropped, a part's good fields kept", async () => {
    state.attach(p, litterDir)
    state.putBinding(o1())
    await state.flushed()
    const key = state.swarmStateKey(litterDir, 'alpha')
    const part = p.storeMap.get(key) as state.SwarmPart
    expect('seen' in part || 'tuned' in part).toBe(false)
    p.storeMap.set(key, {
      ...part,
      seen: { o1: { model: '', effort: 'high', at: NOW }, w9: { model: 'claude-x', effort: 'loud', at: NOW } },
      tuned: { o1: { model: 7, effort: 'max' }, w9: { effort: 'loud' } },
    })
    state.resetForTests()
    await state.loadSwarm(p, litterDir, 'alpha')
    expect(state.stepModel('o1')).toBeNull()
    expect(state.stepModel('w9')).toEqual({ model: 'claude-x', effort: null, at: NOW })
    expect(state.tunedModel('o1')).toEqual({ effort: 'max' })
    expect(state.tunedModel('w9')).toBeNull()
  })
})

describe('turn.step: each request goes with what you set', () => {
  test('a running node: the model and effort you set, from its next request; the browser notes what it named', async () => {
    await put(o1())
    state.tuneModel('o1', { model: 'claude-sonnet-5-5', effort: 'low' })
    const { sent } = await step('o1', { effort: 'xhigh' })
    expect(sent).toEqual(expect.objectContaining({ model: 'claude-sonnet-5-5', effort: 'low', turnId: 't1', index: 0, messageCount: 2, agentId: 'o1' }))
    expect(state.stepModel('o1')).toEqual({ model: 'claude-sonnet-5-5', effort: 'low', at: NOW })
  })

  test("unset, the spec node's effort holds against the request's (2.1.292's Agent effort); a child keeps its own", async () => {
    await put(o1())
    expect((await step('o1', { effort: 'max' })).sent?.effort).toBe('high')
    await put(c1())
    expect((await step('c1', { effort: 'max' })).sent?.effort).toBe('max')
    // A child you set something for has it, though.
    state.tuneModel('c1', { effort: 'medium' })
    expect((await step('c1', { effort: 'max' })).sent?.effort).toBe('medium')
  })

  test('a request that already names them goes as it came, and a model without effort is noted with none', async () => {
    await put(bind('w1'))
    const r = await step('w1')
    expect(r.sent).toBe(r.e)
    expect(state.stepModel('w1')).toEqual({ model: 'claude-opus-5-5[1m]', effort: null, at: NOW })
  })
})

describe('tuneNode: the browser sets a model or an effort', () => {
  test('a model nothing here ran with is checked first: one that answers is set, from the next request, and recorded', async () => {
    state.putBinding(o1())
    p.completeAnswer = () => ({ isAnswered: true, text: 'OK', usage: USAGE }) as never
    expect(await admit.tuneNode(p, { swarm: 'alpha', agentId: 'o1', model: 'claude-haiku-4-5-20251001' })).toEqual({
      ok: true,
      text: 'part-a uses claude-haiku-4-5-20251001 from its next request; it reads its conversation again, without the cache',
    })
    expect(p.completions).toEqual([expect.objectContaining({ model: 'claude-haiku-4-5-20251001', maxTokens: 8, timeoutMs: admit.MODEL_CHECK_MS })])
    expect(state.tunedModel('o1')).toEqual({ model: 'claude-haiku-4-5-20251001' })
    expect((await events()).at(-1)).toEqual({ kind: 'tuned', node: 'part-a', agentId: 'o1', model: 'claude-haiku-4-5-20251001' })
  })

  test("one the provider refuses, or a check that doesn't finish, isn't set, and says why", async () => {
    state.putBinding(o1())
    p.completeAnswer = () => ({ isAnswered: false, reason: 'api-error', status: 404, error: 'not_found', usage: USAGE }) as never
    expect(await admit.tuneNode(p, { swarm: 'alpha', agentId: 'o1', model: 'claude-fable-5-1' })).toEqual({
      ok: false,
      reason: "claude-fable-5-1 wasn't set: the provider refused it (not_found, status 404)",
    })
    p.completeAnswer = () => ({ isAnswered: false, reason: 'aborted', usage: USAGE }) as never
    expect(await admit.tuneNode(p, { swarm: 'alpha', agentId: 'o1', model: 'claude-fable-5-1' })).toEqual({
      ok: false,
      reason: `claude-fable-5-1 wasn't set: the check didn't finish in ${admit.MODEL_CHECK_MS / 1000} s; try again`,
    })
    expect(state.tunedModel('o1')).toBeNull()
    expect(await events()).toEqual([])
  })

  test("a model a node here ran with is set unchecked; an alias or junk isn't a model id", async () => {
    state.putBinding(o1())
    state.putBinding(bind('w1'))
    state.noteStepModel('w1', 'claude-opus-5-5[1m]', 'xhigh', NOW)
    expect(await admit.tuneNode(p, { swarm: 'alpha', agentId: 'o1', model: 'claude-opus-5-5[1m]' })).toEqual(expect.objectContaining({ ok: true }))
    expect(p.completions).toEqual([])
    for (const bad of ['haiku', 'claude opus', '[1m]']) {
      expect(await admit.tuneNode(p, { swarm: 'alpha', agentId: 'o1', model: bad })).toEqual({ ok: false, reason: `${bad} isn't a model id (a full one, such as claude-sonnet-5-5)` })
    }
  })

  test("an effort is set and cleared; a model back to the launch's; what it has already changes nothing; an unknown agent or a read-only swarm is refused", async () => {
    state.putBinding(o1())
    state.noteStepModel('o1', 'claude-opus-5-5[1m]', 'xhigh', NOW)
    expect(await admit.tuneNode(p, { swarm: 'alpha', agentId: 'o1', effort: 'low' })).toEqual({ ok: true, text: 'part-a thinks at low from its next request' })
    expect(await admit.tuneNode(p, { swarm: 'alpha', agentId: 'o1', effort: 'low' })).toEqual({ ok: true, text: 'part-a has that effort already' })
    expect(await admit.tuneNode(p, { swarm: 'alpha', agentId: 'o1', effort: null })).toEqual({
      ok: true,
      text: 'part-a goes back to the effort it was launched with, from its next request',
    })
    expect(await admit.tuneNode(p, { swarm: 'alpha', agentId: 'o1', model: null })).toEqual({ ok: true, text: 'part-a has that model already' })
    await admit.tuneNode(p, { swarm: 'alpha', agentId: 'o1', model: 'claude-opus-5-5[1m]' })
    expect(await admit.tuneNode(p, { swarm: 'alpha', agentId: 'o1', model: null })).toEqual({
      ok: true,
      text: 'part-a goes back to the model it was launched with, from its next request',
    })
    expect((await events()).map(e => [e.model, e.effort])).toEqual([
      [undefined, 'low'],
      [undefined, null],
      ['claude-opus-5-5[1m]', undefined],
      [null, undefined],
    ])
    expect(await admit.tuneNode(p, { swarm: 'alpha', agentId: 'nobody', effort: 'low' })).toEqual({ ok: false, reason: "nobody isn't a node of swarm alpha" })
    state.putLiveSwarm(live({ readOnly: true }))
    expect(await admit.tuneNode(p, { swarm: 'alpha', agentId: 'o1', effort: 'low' })).toEqual(expect.objectContaining({ ok: false }))
  })
})
