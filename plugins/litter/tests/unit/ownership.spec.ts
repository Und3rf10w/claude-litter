// Tier 2: a swarm's ownership across sessions and crashes (FIX-Q; plan 15.4,
// "Ownership", "A stale owner stands down", "After /clear"). Real git refs in
// a scratch repository (swarmlaunch-harness.ts), the real policy.json writers
// and ledgers. A second session is a second nodePorts with its own session id
// on the same repository: `w.restart` for a new process of this module, a
// bare nodePorts for another session's writes while this process runs on.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync } from 'node:fs'
import type { Policy } from '../../hooks/hookfiles'
import type { NodeBinding, SwarmSpec } from '../../hooks/swarm/types'
import { activePath, agentPolicyPath, policyPath } from '../../hooks/layout'
import { atomicWriteJson } from '../../hooks/fsx'
import { readPolicy, setActive } from '../../hooks/policy'
import { deactivate } from '../../hooks/lifecycle'
import { releaseActive, removeNodePolicy, writeSwarmPolicy } from '../../hooks/swarm/guard'
import { stopOwnerBeat } from '../../hooks/swarm/owner'
import { resetClearForTests } from '../../hooks/clear'
import { bind, launched, nodePolicyOf, world, type World } from './swarmlaunch-harness'

// Every spec here runs git many times; a loaded machine takes seconds.
setDefaultTimeout(120_000)

let w: World

beforeEach(async () => {
  resetClearForTests()
  w = await world()
})

afterEach(async () => {
  resetClearForTests()
  await w.done()
})

// ---------------------------------------------------------------------------
// Helpers

const agentFile = (id: string) => agentPolicyPath(w.litterDir, id)
const active = () => existsSync(activePath(w.litterDir))
const entryOf = async (name = 'alpha') => (await readPolicy(w.p, w.litterDir))?.swarm?.swarms[name]

/** One orchestrator, no worktree of its own: a launch of it leaves no branch, so the name can be launched again. */
const solo = (): SwarmSpec => ({
  name: 'alpha',
  goal: 'Document the parser.',
  nodes: [{ id: 'docs', kind: 'orchestrator', worktree: 'none', spawnOther: false, authority: { commit: false } }],
})

/** A node's binding file, as M writes it. */
async function nodeFile(b: NodeBinding): Promise<void> {
  await atomicWriteJson(w.p, agentFile(b.agentId), { v: 1, node: nodePolicyOf(b, { admitted: true, stopped: null, bind: true }) })
}

// ---------------------------------------------------------------------------
// Q9, Q10

describe('hooks/active (Q9, Q10)', () => {
  const freshPolicy = (): Policy => ({ v: 1, session: 'sess-a', litterDir: w.litterDir, run: null, roles: {}, swarm: null })

  test("a run's deactivate leaves it when policy.json doesn't parse, or isn't version 1, and says so", async () => {
    await setActive(w.p, w.litterDir, true)
    await w.p.fs.write(policyPath(w.litterDir), '{"v": 1, "run":')
    await deactivate(w.p, w.litterDir, 'r1')
    expect(active()).toBe(true)
    expect(w.p.logs.some(l => l.includes("policy.json doesn't parse, so hooks/active is left"))).toBe(true)

    await atomicWriteJson(w.p, policyPath(w.litterDir), { ...freshPolicy(), v: 2 })
    await deactivate(w.p, w.litterDir, 'r1')
    expect(active()).toBe(true)

    // Version 1, with no run and no swarm: it goes.
    await atomicWriteJson(w.p, policyPath(w.litterDir), freshPolicy())
    await deactivate(w.p, w.litterDir, 'r1')
    expect(active()).toBe(false)
  })

  test("it stays while a node's binding file is left (writeSwarmPolicy, deactivate, releaseActive); a fanout writer's file doesn't count", async () => {
    const launch = await launched(w, solo())
    const lead = await bind(w, launch, { agentId: 'ag-d1', node: 'docs', n: 1, kind: 'orchestrator', cwd: w.dir })
    await nodeFile(lead)
    await atomicWriteJson(w.p, agentFile('wf-1'), { v: 1, run: '20261003-120000-abcd' })
    stopOwnerBeat('alpha')

    await writeSwarmPolicy(w.p, w.litterDir, 'alpha', null)
    expect(await entryOf()).toBeUndefined()
    expect(active()).toBe(true)
    await deactivate(w.p, w.litterDir, 'r1')
    expect(active()).toBe(true)
    await releaseActive(w.p, w.litterDir)
    expect(active()).toBe(true)

    // U's sweep removed the last node's file: releaseActive takes it, past the fanout file.
    await removeNodePolicy(w.p, w.litterDir, 'ag-d1')
    await releaseActive(w.p, w.litterDir)
    expect(active()).toBe(false)

    // A file that doesn't parse may be a node's: it counts.
    await setActive(w.p, w.litterDir, true)
    await w.p.fs.write(agentFile('ag-x'), '{"v": 1, "node": ')
    await releaseActive(w.p, w.litterDir)
    expect(active()).toBe(true)
  })
})
