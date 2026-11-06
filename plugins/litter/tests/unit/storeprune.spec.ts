// Tier 2: the store prune (storeprune.ts): litter's `$.store` keys for
// folders that are gone are dropped, everything else stays, and the Doctor's
// row reads what the pass measured.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pruneStore, STORE_CAP_BYTES, storeMeasure } from '../../hooks/storeprune'
import { storeRow } from '../../hooks/swarm/doctor'
import { resetForTests } from '../../hooks/swarm/state'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

let p: TestPorts
let dir: string
let cleanup: () => void
let litterDir: string
const gone = '/nonexistent-litter-prune/repo/.claude/litter'

beforeEach(() => {
  resetForTests()
  p = nodePorts()
  ;({ dir, cleanup } = scratch())
  litterDir = join(dir, 'repo/.claude/litter')
  mkdirSync(join(litterDir, 'swarms/alpha/launches/20261105-100000/ledger'), { recursive: true })
  mkdirSync(join(litterDir, 'swarms/beta/launches/20261105-110000/ledger'), { recursive: true })
  mkdirSync(join(litterDir, '20261105-fanout-aaaaaa'), { recursive: true })
})
afterEach(() => {
  cleanup()
  resetForTests()
})

const put = (key: string, value: unknown) => p.storeMap.set(key, value)
const has = (key: string) => p.storeMap.has(key)

describe('the store prune', () => {
  test("keys named by a path that's gone go; the same keys for a folder that's there stay", async () => {
    const run = join(litterDir, '20261105-fanout-aaaaaa')
    for (const prefix of ['litter.head.', 'litter.events.', 'litter.worktreeRoot.', 'litter.agents.']) {
      put(`${prefix}${run}`, 1)
      put(`${prefix}${gone}/20261001-fanout-bbbbbb`, 1)
    }
    for (const prefix of ['litter.projectDir.', 'litter.pending.', 'litter.inflight.', 'litter.repair.start.']) {
      put(`${prefix}${litterDir}`, 1)
      put(`${prefix}${gone}`, 1)
    }
    const m = await pruneStore(p)
    for (const prefix of ['litter.head.', 'litter.events.', 'litter.worktreeRoot.', 'litter.agents.']) {
      expect(has(`${prefix}${run}`)).toBe(true)
      expect(has(`${prefix}${gone}/20261001-fanout-bbbbbb`)).toBe(false)
    }
    for (const prefix of ['litter.projectDir.', 'litter.pending.', 'litter.inflight.', 'litter.repair.start.']) {
      expect(has(`${prefix}${litterDir}`)).toBe(true)
      expect(has(`${prefix}${gone}`)).toBe(false)
    }
    expect(m?.dropped).toBe(8)
    expect(m?.keys).toBe(8)
  })

  test("a workflow's or task's run folder, and an agent's cwd, decide for keys named by an id; a run's agent list goes with its last agent", async () => {
    const run = join(litterDir, '20261105-fanout-aaaaaa')
    put('litter.wf.wf_here', { run: 'r', runDir: run, litterDir })
    put('litter.wf.wf_gone', { run: 'r', runDir: `${gone}/x`, litterDir: gone })
    put('litter.task.t_here', { run: 'r', runDir: run, litterDir })
    put('litter.task.t_gone', { run: 'r', runDir: `${gone}/x`, litterDir: gone })
    put('litter.agent.a1', { agentId: 'a1', run: 'run-a', cwd: dir })
    put('litter.agent.a2', { agentId: 'a2', run: 'run-b', cwd: gone })
    put('litter.agent.a3', { agentId: 'a3', run: 'run-b', cwd: gone })
    put('litter.agents.run-a', ['a1'])
    put('litter.agents.run-b', ['a2', 'a3'])
    // Anything not shaped as expected stays.
    put('litter.wf.wf_odd', 'not an object')
    put('litter.agent.a4', { agentId: 'a4' })
    await pruneStore(p)
    expect([...p.storeMap.keys()].sort()).toEqual(
      ['litter.agent.a1', 'litter.agent.a4', 'litter.agents.run-a', 'litter.task.t_here', 'litter.wf.wf_here', 'litter.wf.wf_odd'].sort(),
    )
  })

  test("a swarm's keys go with its litter folder or its swarm folder; a draft only with the litter folder", async () => {
    for (const prefix of ['litter.swarm.summary.', 'litter.swarm.composer.', 'litter.swarm.draft.']) {
      put(`${prefix}${litterDir}.alpha`, { v: 1 })
      put(`${prefix}${litterDir}.deleted`, { v: 1 })
      put(`${prefix}${gone}.alpha`, { v: 1 })
    }
    await pruneStore(p)
    expect(has(`litter.swarm.summary.${litterDir}.alpha`)).toBe(true)
    expect(has(`litter.swarm.summary.${litterDir}.deleted`)).toBe(false)
    expect(has(`litter.swarm.composer.${litterDir}.deleted`)).toBe(false)
    expect(has(`litter.swarm.draft.${litterDir}.deleted`)).toBe(true)
    for (const prefix of ['litter.swarm.summary.', 'litter.swarm.composer.', 'litter.swarm.draft.']) expect(has(`${prefix}${gone}.alpha`)).toBe(false)
  })

  test("a swarm's state part goes once its launch recorded swarm.end; a live launch's stays", async () => {
    writeFileSync(join(litterDir, 'swarms/alpha/launches/20261105-100000/ledger/000001-swarm.start.json'), '{}\n')
    writeFileSync(join(litterDir, 'swarms/alpha/launches/20261105-100000/ledger/000002-swarm.end.json'), '{}\n')
    writeFileSync(join(litterDir, 'swarms/beta/launches/20261105-110000/ledger/000001-swarm.start.json'), '{}\n')
    put(`litter.swarm.state.${litterDir}.alpha`, { v: 1, swarm: { name: 'alpha', launch: '20261105-100000' } })
    put(`litter.swarm.state.${litterDir}.beta`, { v: 1, swarm: { name: 'beta', launch: '20261105-110000' } })
    put(`litter.swarm.state.${litterDir}.odd`, { v: 1 })
    await pruneStore(p)
    expect(has(`litter.swarm.state.${litterDir}.alpha`)).toBe(false)
    expect(has(`litter.swarm.state.${litterDir}.beta`)).toBe(true)
    // No swarm folder named odd: gone.
    expect(has(`litter.swarm.state.${litterDir}.odd`)).toBe(false)
  })

  test("the pane's and the session's own keys are never touched, nor a key it can't read", async () => {
    for (const k of ['litter.hub', 'litter.asks', 'litter.swarm.pane', 'litter.board.pane', 'litter.agents.pane', 'litter.band.hidden']) put(k, { v: 1 })
    put('litter.head.relative/path', 1)
    put(`litter.swarm.state.${litterDir}`, { v: 1 })
    const before = [...p.storeMap.keys()].sort()
    const m = await pruneStore(p)
    expect([...p.storeMap.keys()].sort()).toEqual(before)
    expect(m?.dropped).toBe(0)
  })

  test("the Doctor's row: unmeasured, ok, over half, nearly full", async () => {
    expect(storeRow(null).severity).toBe('info')
    put('litter.hub', { v: 1 })
    await pruneStore(p)
    const ok = storeRow(storeMeasure())
    expect(ok.severity).toBe('ok')
    expect(ok.detail).toMatch(/^1 keys, 0 KiB of 4096 KiB$/)
    expect(storeRow({ at: 0, keys: 9, bytes: STORE_CAP_BYTES * 0.6, dropped: 2 }).severity).toBe('warning')
    const full = storeRow({ at: 0, keys: 9, bytes: STORE_CAP_BYTES * 0.95, dropped: 0 })
    expect(full.severity).toBe('error')
    expect(full.detail).toContain('nearly full')
  })

  test('a host whose store lists no keys is never pruned', async () => {
    put(`litter.head.${gone}/x`, 1)
    const q = { ...p, store: { get: p.store.get, set: p.store.set, delete: p.store.delete } }
    expect(await pruneStore(q)).toBeNull()
    expect(has(`litter.head.${gone}/x`)).toBe(true)
  })
})
