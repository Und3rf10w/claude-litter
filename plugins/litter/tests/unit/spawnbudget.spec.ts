// Tier 2: a repair swarm's budget at spawn (hooks/swarm/spawn.ts with
// swarm/gate.ts's budget; WP-Y, decision 7): a worker or child spawn counted
// against the agents in the step that reserves, so concurrent spawns at the
// edge start exactly what's left; a spawn that never started giving its count
// back; orchestrators not counted; every spawn refused once the rounds are
// used; recovery's count from the ledgers; the `<instance>` block's line. The
// world is repair-harness.ts's, with a spec whose orchestrator may start
// enough read-only workers to reach the edge.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSpawnInput, AgentSpawnResult } from 'claude-code'
import type { SwarmVerdictBody } from '../../hooks/records/execute'
import type { SwarmNodeBody } from '../../hooks/records/swarm'
import { appendRecord } from '../../hooks/ledgercore'
import { launchDir } from '../../hooks/layout'
import { appendLaunchRecord } from '../../hooks/records/swarm'
import { budgetRefusal, resetGateForTests } from '../../hooks/swarm/gate'
import { swarmSpawn } from '../../hooks/swarm/spawn'
import * as state from '../../hooks/swarm/state'
import type { SwarmSpec } from '../../hooks/swarm/types'
import { B_FAILS, OWNED, RUN, SWARM, repairWorld, teardown, typeOf, type World } from './repair-harness'

setDefaultTimeout(120_000)

const RO = { deny: ['Edit', 'Write', 'NotebookEdit'] }
const ASK = 'report blocked to your parent, saying what more you need and for what; the lead can ask the user for it with repair.budget'

/** The repair orchestrator may start five read-only scouts at once; a scout may start other agents. */
function spec(integration: string): SwarmSpec {
  return {
    name: SWARM,
    goal: `Repair run ${RUN}`,
    nodes: [
      { id: 'repair', kind: 'orchestrator', worktree: { existing: integration }, tools: RO, authority: { verify: true, land: true, push: 'none' }, paths: OWNED, spawns: { scout: 5 } },
      { id: 'scout', kind: 'worker', worktree: 'inherit', tools: RO },
    ],
  }
}

let w: World | null = null
beforeEach(async () => {
  w = await repairWorld({ spec: spec('/pending') })
  // The spec names the integration worktree once the world has made it.
  state.patchLiveSwarm(SWARM, { spec: spec(w.integration), types: { repair: typeOf('repair'), scout: typeOf('scout') }, budget: { rounds: 3, agents: 3 } })
  for (const id of ['fix-1', 'crit-1']) state.dropBinding(id)
})
afterEach(() => {
  teardown(w)
  w = null
})
const world = (): World => w!

let toolN = 0
function spawnE(subagentType: string, parentAgentId?: string, over: Partial<AgentSpawnInput> = {}): AgentSpawnInput {
  return {
    tool_use_id: `toolu_b${++toolN}`,
    prompt: 'look into it',
    description: 'a task',
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: false,
    fork: false,
    ...(parentAgentId !== undefined ? { parentAgentId } : {}),
    ...over,
  }
}

let agentN = 0
function engine(opts: { answer?: (e: AgentSpawnInput) => AgentSpawnResult | Promise<AgentSpawnResult>; hold?: Promise<void> } = {}) {
  const calls: AgentSpawnInput[] = []
  const next = async (e: AgentSpawnInput): Promise<AgentSpawnResult> => {
    calls.push(e)
    const id = `agent-${++agentN}`
    await opts.hold
    return opts.answer ? opts.answer(e) : { model: e.model ?? 'inherit', agentId: id }
  }
  return { next: next as never, calls }
}
const run = (e: AgentSpawnInput, next: never): Promise<AgentSpawnResult> => swarmSpawn(world().p, e as never, next) as Promise<AgentSpawnResult>
const scout = (next: never = engine().next): Promise<AgentSpawnResult> => run(spawnE(typeOf('scout'), 'orch-1'), next)

async function until(ok: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !ok(); i++) await new Promise(r => setTimeout(r, 5))
  if (!ok()) throw new Error(`timed out waiting for ${what}`)
}

const AGENTS_USED = `litter: repair swarm ${SWARM} has started all 3 agents its repair budget allows (the workers and agents its nodes start), so it starts no more; ${ASK}`

describe('the agents', () => {
  test('five worker spawns at once with three agents left start exactly three; the rest are refused as the budget case', async () => {
    let open!: () => void
    const hold = new Promise<void>(r => (open = r))
    const { next, calls } = engine({ hold })
    const runs = [1, 2, 3, 4, 5].map(() => scout(next))
    await until(() => calls.length === 3, 'three spawns to reach the engine')
    open()
    const out = await Promise.all(runs)
    expect(out.filter(r => r.agentId).length).toBe(3)
    expect(out.filter(r => r.deny).map(r => r.deny)).toEqual([AGENTS_USED, AGENTS_USED])
    expect(calls).toHaveLength(3)
    expect(state.spawnsUsed(SWARM)).toBe(3)
    expect(state.reservations()).toEqual([])
  })

  test("a spawn that never started gives its count back; one that started keeps it once it's done", async () => {
    expect((await scout(engine({ answer: () => ({ deny: 'no such agent' }) }).next)).deny).toBe('no such agent')
    expect((await scout(engine({ answer: () => Promise.reject(new Error('engine down')) }).next)).deny).toBe('litter: the spawn failed: engine down')
    expect(state.spawnsUsed(SWARM)).toBe(0)
    const a = (await scout()).agentId!
    expect(state.spawnsUsed(SWARM)).toBe(1)
    // Settled, its place is free again; its count isn't.
    state.markSettled(a)
    expect(state.spawnsUsed(SWARM)).toBe(1)
    await scout()
    await scout()
    expect((await scout()).deny).toBe(AGENTS_USED)
  })

  test('a child counts, an orchestrator never does', async () => {
    const s = (await scout()).agentId!
    const c = await run(spawnE('general-purpose', s), engine().next)
    expect(state.binding(c.agentId!)).toEqual(expect.objectContaining({ kind: 'child', node: 'scout', of: s }))
    expect(state.spawnsUsed(SWARM)).toBe(2)
    const o = await run(spawnE(typeOf('repair')), engine().next)
    expect(o.agentId).toBeDefined()
    expect(state.spawnsUsed(SWARM)).toBe(2)
    expect(budgetRefusal(SWARM, 'orchestrator')).toBeNull()
    await scout()
    expect((await run(spawnE('Explore', s), engine().next)).deny).toBe(AGENTS_USED)
    // The orchestrator, settled, is spawned again within no budget.
    state.markSettled(o.agentId!)
    expect((await run(spawnE(typeOf('repair')), engine().next)).agentId).toBeDefined()
  })

  test('raised live (repair.budget), the next spawn reads the new figure', async () => {
    for (let i = 0; i < 3; i++) await scout()
    expect((await scout()).deny).toBe(AGENTS_USED)
    state.patchLiveSwarm(SWARM, { budget: { rounds: 3, agents: 4 } })
    expect((await scout()).agentId).toBeDefined()
  })
})

describe('the rounds', () => {
  test('once they are used, every worker and child spawn is refused, the orchestrator not', async () => {
    const s = (await scout()).agentId!
    for (const v of ['v1', 'v2', 'v3']) state.noteRound(SWARM, v)
    const text = `litter: repair swarm ${SWARM} has used all 3 of its repair rounds (3 verdicts on distinct verifies), so it starts no more agents; ${ASK}`
    expect((await scout()).deny).toBe(text)
    expect((await run(spawnE('general-purpose', s), engine().next)).deny).toBe(text)
    expect(state.spawnsUsed(SWARM)).toBe(1)
    expect((await run(spawnE(typeOf('repair')), engine().next)).agentId).toBeDefined()
  })
})

describe('recovery', () => {
  const node = (agentId: string, kind: SwarmNodeBody['kind'], over: Partial<SwarmNodeBody> = {}): SwarmNodeBody => ({
    node: kind === 'orchestrator' ? 'repair' : 'scout',
    n: kind === 'child' ? 0 : 1,
    agentId,
    parentAgentId: kind === 'orchestrator' ? null : 'orch-1',
    kind,
    cwd: world().integration,
    branch: null,
    model: null,
    revision: 1,
    generation: 1,
    ...over,
  })

  test("the count is caught up from the launch's worker and child swarm.node records (adopted ones not, each agent once), and the rounds from the generation's verdicts", async () => {
    const { p, litterDir, launch } = world()
    for (const body of [
      node('orch-1', 'orchestrator'),
      node('old-1', 'worker'),
      node('old-2', 'worker', { n: 2 }),
      node('old-c', 'child', { of: 'old-1', parentAgentId: 'old-1' }),
      node('old-1', 'worker'),
      node('took-1', 'worker', { n: 3, adopted: true }),
    ]) {
      await appendLaunchRecord(p, litterDir, SWARM, launch, 'swarm.node', body)
    }
    // A verdict of this generation the state never noted: a lost mirror.
    await appendRecord(p, world().runDir, {
      run: RUN,
      kind: 'verdict',
      by: { source: 'agent', agentId: 'crit-0', agentType: typeOf('critic') },
      body: { verify_id: 'repair-1-zzzzzzzzzz', tasks: B_FAILS, combined: 'no', proposed_rules: [], round: 1, approved: false } satisfies SwarmVerdictBody,
    })
    state.patchLiveSwarm(SWARM, { budget: { rounds: 3, agents: 4 } })
    expect(state.spawnsUsed(SWARM)).toBe(0)
    const { next, calls } = engine()
    expect((await scout(next)).agentId).toBeDefined()
    expect(state.spawnsUsed(SWARM)).toBe(4)
    expect(state.roundsUsed(SWARM)).toBe(1)
    expect(calls[0]!.prompt).toContain(
      "Repair budget left: 2 of 3 rounds (a round is the critic's verdict on a new verify), 0 of 4 agents (the workers and agents the swarm's nodes start).",
    )
    expect((await scout()).deny).toContain('has started all 4 agents its repair budget allows')
  })

  test('the count is taken once per launch in a process, and never lowers what the state holds', async () => {
    const { p, litterDir, launch } = world()
    await appendLaunchRecord(p, litterDir, SWARM, launch, 'swarm.node', node('old-1', 'worker'))
    await scout()
    expect(state.spawnsUsed(SWARM)).toBe(2)
    // Records appended since (this process's own spawns) aren't counted twice.
    await scout()
    expect(state.spawnsUsed(SWARM)).toBe(3)
    // A fresh module's first check counts again: the state already holds more than the records.
    resetGateForTests()
    expect((await scout()).deny).toBe(AGENTS_USED)
    expect(state.spawnsUsed(SWARM)).toBe(3)
  })

  test("a broken launch ledger denies the spawn (it can't be counted), and the next spawn tries again", async () => {
    const { p, litterDir, launch } = world()
    await appendLaunchRecord(p, litterDir, SWARM, launch, 'swarm.node', node('orch-1', 'orchestrator'))
    const ledger = join(launchDir(litterDir, SWARM, launch), 'ledger')
    const name = readdirSync(ledger).find(f => f.endsWith('-swarm.node.json'))!
    writeFileSync(join(ledger, name), readFileSync(join(ledger, name), 'utf8').replace('"orch-1"', '"orch-9"'))
    const { next, calls } = engine()
    const r = await scout(next)
    expect(r.deny).toStartWith(`litter: swarm ${SWARM}'s repair budget couldn't be counted, so it starts nothing: launch ${launch}'s ledger is tampered at record `)
    expect((await scout(next)).deny).toStartWith(`litter: swarm ${SWARM}'s repair budget couldn't be counted`)
    expect(calls).toEqual([])
    expect(state.reservations()).toEqual([])
  })
})

describe('the instance block', () => {
  test("a repair swarm's spawn reads the budget left, its own spawn counted; another swarm's has no such line", async () => {
    const { next, calls } = engine()
    await scout(next)
    expect(calls[0]!.prompt).toContain(
      "\nRepair budget left: 3 of 3 rounds (a round is the critic's verdict on a new verify), 2 of 3 agents (the workers and agents the swarm's nodes start). Past either, litter refuses the next spawn or land: report blocked to your parent, saying what you need.\n",
    )
    state.patchLiveSwarm(SWARM, { budget: undefined })
    await scout(next)
    expect(calls[1]!.prompt).not.toContain('Repair budget left')
  })
})
