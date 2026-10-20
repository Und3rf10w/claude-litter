// Tier 2: 2b-2's spec rules (hooks/swarm/spec.ts; WP-Z, plan 15.3 and
// 15.10): a `verdicts: true` node writes nothing, `authority.land` needs a
// `verdicts: true` node with `authority.verify` in the tree, and `verify` and
// `land` follow the worker-at-most-its-parent rule, unset being not given.
// Each rule both ways, each error on its node and field, as the builder's
// strip shows the others. Real git in a scratch repo, as spec.spec.ts.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import type { SpecError, SwarmNode, SwarmSpec, ValidateCtx } from '../../hooks/swarm/types'
import { validateSpec } from '../../hooks/swarm/spec'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const W = ['Edit', 'Write', 'NotebookEdit']
const RO = { commit: false, push: 'none' } as const

let p: TestPorts
let dir: string
let cleanup: () => void

beforeEach(async () => {
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ cwd: dir })
  await scratchRepo(p, dir)
})
afterEach(() => cleanup())

const ctx = (): ValidateCtx => ({
  repo: dir,
  litterDir: join(dir, '.claude', 'litter'),
  limits: p.limitsValue,
  briefText: async () => null,
  activeRunCheckout: null,
})

const lead = (id: string, over: Partial<SwarmNode> = {}): SwarmNode => ({ id, kind: 'orchestrator', worktree: 'none', tools: { deny: W }, authority: RO, ...over })
const worker = (id: string, over: Partial<SwarmNode> = {}): SwarmNode => ({ id, kind: 'worker', tools: { deny: W }, authority: RO, ...over })
const critic = (over: Partial<SwarmNode> = {}): SwarmNode => worker('critic', { verdicts: true, spawnOther: false, authority: { ...RO, verify: true }, ...over })
const spec = (nodes: SwarmNode[]): SwarmSpec => ({ name: 'alpha', goal: 'Repair the combined result', nodes })

const check = (s: SwarmSpec) => validateSpec(p, s, ctx())
const at = (es: SpecError[], field: string) => es.find(e => e.field === field)
const fields = (es: SpecError[]) => es.map(e => e.field)

describe('a verdicts: true node writes nothing', () => {
  test('commit false and Edit, Write and NotebookEdit denied passes', async () => {
    const r = await check(spec([lead('o', { spawns: { critic: 1 }, authority: { ...RO, verify: true } }), critic()]))
    expect(r).toEqual({ ok: true, errors: [], warnings: [] })
  })

  test('commit true, or left unset (litter would let it commit), is refused on authority.commit', async () => {
    for (const commit of [true, undefined]) {
      const authority = commit === undefined ? { push: 'none' as const, verify: true } : { ...RO, commit, verify: true }
      const r = await check(spec([lead('o', { spawns: { critic: 1 }, authority: { push: 'none', verify: true } }), critic({ authority })]))
      const e = at(r.errors, 'nodes.critic.authority.commit')
      expect(e).toEqual(expect.objectContaining({ node: 'critic' }))
      expect(e!.error).toContain('a verdicts: true node writes nothing')
      expect(e!.error).toContain('set authority.commit to false')
    }
  })

  test('a write tool left open is refused on tools.deny, naming it', async () => {
    const r = await check(spec([lead('o', { spawns: { critic: 1 }, authority: { ...RO, verify: true } }), critic({ tools: { deny: ['Edit', 'NotebookEdit'] } })]))
    expect(fields(r.errors)).toEqual(['nodes.critic.tools.deny'])
    expect(at(r.errors, 'nodes.critic.tools.deny')).toEqual(expect.objectContaining({ node: 'critic', error: expect.stringContaining('leaves Write') }))
    // No tools.deny at all: all three are named.
    const none = await check(spec([lead('o', { spawns: { critic: 1 }, authority: { ...RO, verify: true } }), critic({ tools: {} })]))
    expect(at(none.errors, 'nodes.critic.tools.deny')!.error).toContain('leaves Edit, Write, NotebookEdit')
  })

  test('verdicts unset or false has no such rule', async () => {
    for (const verdicts of [false, undefined]) {
      const r = await check(spec([lead('o', { spawns: { w: 1 }, authority: {} }), worker('w', { verdicts, tools: {}, authority: {}, paths: ['src/'] })]))
      expect(r.errors).toEqual([])
    }
  })

  test("one with no authority.verify is warned: its verdicts can't cite a verify of its own", async () => {
    const r = await check(spec([lead('o', { spawns: { critic: 1 } }), critic({ authority: RO })]))
    expect(r.ok).toBe(true)
    expect(r.warnings).toEqual([expect.objectContaining({ field: 'nodes.critic.authority.verify', node: 'critic', error: expect.stringContaining('set authority.verify to true') })])
  })
})

describe('authority.land needs a verdicts: true node with authority.verify in the tree', () => {
  const lander = (spawns: Record<string, number>) => lead('o', { spawns, authority: { ...RO, verify: true, land: true } })

  test('with one the orchestrator spawns, it passes', async () => {
    const r = await check(spec([lander({ critic: 1 }), critic()]))
    expect(r.errors).toEqual([])
  })

  test('a critic further down the tree counts too', async () => {
    const r = await check(spec([lander({ mid: 1 }), worker('mid', { spawns: { critic: 1 }, authority: { ...RO, verify: true } }), critic()]))
    expect(r.errors).toEqual([])
  })

  test('with none, or only one without verify, or one nothing spawns, it is refused on authority.land', async () => {
    const cases: SwarmSpec[] = [
      spec([lander({})]),
      spec([lander({ critic: 1 }), critic({ authority: RO })]),
      // Nothing spawns it: it never runs (and the tree rule says so too).
      spec([lander({}), critic()]),
    ]
    for (const s of cases) {
      const r = await check(s)
      const e = at(r.errors, 'nodes.o.authority.land')
      expect(e).toEqual(expect.objectContaining({ node: 'o' }))
      expect(e!.error).toContain('a land needs an approving verdict from a verdicts: true node with authority.verify')
    }
  })

  test('land false or unset needs no critic', async () => {
    for (const land of [false, undefined]) {
      const r = await check(spec([lead('o', { authority: { ...RO, verify: true, ...(land === undefined ? {} : { land }) } })]))
      expect(r.errors).toEqual([])
    }
  })
})

describe('verify and land follow the worker-at-most-its-parent rule', () => {
  test('a worker given verify under a parent without it is refused, unset reading as not given', async () => {
    for (const parent of [undefined, false]) {
      const r = await check(spec([lead('o', { spawns: { w: 1 }, authority: { ...RO, ...(parent === undefined ? {} : { verify: parent }) } }), worker('w', { authority: { ...RO, verify: true } })]))
      const e = at(r.errors, 'nodes.w.authority.verify')
      expect(e).toEqual(expect.objectContaining({ node: 'w' }))
      expect(e!.error).toContain(`more than its parent o's ${parent === undefined ? 'unset (not given)' : 'false'}`)
      expect(e!.error).toContain('leave it unset, or set it to false')
    }
  })

  test('a worker given land under a parent without it is refused', async () => {
    const r = await check(spec([lead('o', { spawns: { w: 1, critic: 1 }, authority: { ...RO, verify: true } }), worker('w', { authority: { ...RO, verify: true, land: true } }), critic()]))
    expect(fields(r.errors)).toEqual(['nodes.w.authority.land'])
  })

  test('under a parent that has them, the worker may have them, or not', async () => {
    for (const mine of [{ verify: true, land: true }, { verify: false }, {}]) {
      const r = await check(spec([lead('o', { spawns: { w: 1, critic: 1 }, authority: { ...RO, verify: true, land: true } }), worker('w', { authority: { ...RO, ...mine } }), critic()]))
      expect(r.errors).toEqual([])
    }
  })

  test('a worker under two parents is held to each', async () => {
    const r = await check(
      spec([
        lead('a', { spawns: { w: 1 }, authority: { ...RO, verify: true } }),
        lead('b', { spawns: { w: 1 }, authority: RO }),
        worker('w', { authority: { ...RO, verify: true } }),
      ]),
    )
    expect(r.errors).toEqual([expect.objectContaining({ field: 'nodes.w.authority.verify', error: expect.stringContaining("its parent b's") })])
  })
})

test("the repair swarm's shape (COMMON 2b-2, step 4) validates: an orchestrator that writes nothing and lands, a serial fixer that commits, a critic", async () => {
  const r = await check({
    name: 'repair-0a1b2c',
    goal: 'Repair the combined result of run 20261003-api',
    limits: { maxAgentsAtOnce: 4 },
    nodes: [
      // The orchestrator leaves commit unset: a parent at false would bound the fixer's commit (15.3).
      { id: 'repair', kind: 'orchestrator', worktree: 'none', tools: { deny: W }, authority: { push: 'none', verify: true, land: true }, spawns: { fixer: 2, critic: 1 }, paths: ['server/', 'client/'] },
      { id: 'fixer', kind: 'worker', worktree: 'inherit', serial: true, authority: { commit: true, push: 'none', verify: true }, paths: ['server/', 'client/'] },
      { id: 'critic', kind: 'worker', verdicts: true, spawnOther: false, tools: { deny: W }, authority: { commit: false, push: 'none', verify: true } },
    ],
  })
  expect(r).toEqual({ ok: true, errors: [], warnings: [] })
})
