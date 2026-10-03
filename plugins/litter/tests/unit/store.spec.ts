// Tier 2: the store (hooks/swarm/store.ts; plan 15.8): a save read back, the
// revision counter, the briefs per revision, swarm.json and briefs/, a save
// that fails validation writing nothing, and the drafts in $.store surviving
// a fresh module. The proposals are propose.spec.ts's.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Draft, LiveSwarm, SwarmNode, SwarmSpec } from '../../hooks/swarm/types'
import { readSpecLedger } from '../../hooks/records/swarm'
import * as state from '../../hooks/swarm/state'
import {
  briefTextFor,
  clearDraft,
  draftKey,
  listSwarms,
  readDraft,
  readRevision,
  readSaved,
  saveRevision,
  writeDraft,
} from '../../hooks/swarm/store'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const W = ['Edit', 'Write', 'NotebookEdit']
const RO = { commit: false, push: 'none', forcePush: false, rewriteHistory: false, worktreeOps: false } as const

let p: TestPorts
let dir: string
let litterDir: string
let cleanup: () => void

beforeEach(async () => {
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ cwd: dir })
  await scratchRepo(p, dir)
  litterDir = join(dir, '.claude', 'litter')
  state.resetForTests()
})
afterEach(() => {
  state.resetForTests()
  cleanup()
})

const node = (id: string, over: Partial<SwarmNode> = {}): SwarmNode => ({ id, kind: 'worker', tools: { deny: W }, authority: RO, ...over })
const spec = (over: Partial<SwarmSpec> = {}): SwarmSpec => ({
  name: 'alpha',
  goal: 'Review the branches',
  nodes: [
    node('part-a', { kind: 'orchestrator', worktree: 'none', brief: 'briefs/part-a.md', spawns: { reviewer: 2 } }),
    node('reviewer', { brief: 'briefs/reviewer.md' }),
  ],
  ...over,
})
const swarm = (...parts: string[]) => join(litterDir, 'swarms', 'alpha', ...parts)
const read = (...parts: string[]) => readFileSync(swarm(...parts), 'utf8')
const ledger = async () => (await readSpecLedger(p, litterDir, 'alpha')).records

describe('saveRevision', () => {
  test('writes revision 1, its briefs, swarm.json and briefs/, and records swarm.revision', async () => {
    const briefs = { 'part-a': 'Own branch a.\n', reviewer: 'Review it.\n', stray: 'not a node' }
    expect(await saveRevision(p, litterDir, 'alpha', { spec: spec(), briefs }, { from: 'save', changes: ['nodes.part-a'] })).toEqual({ ok: true, revision: 1 })
    expect(JSON.parse(read('revisions', '1.json'))).toEqual(spec())
    expect(JSON.parse(read('swarm.json'))).toEqual(spec())
    expect(read('revisions', '1', 'briefs', 'part-a.md')).toBe('Own branch a.\n')
    expect(read('briefs', 'reviewer.md')).toBe('Review it.\n')
    expect(existsSync(swarm('briefs', 'stray.md'))).toBe(false)
    const recs = await ledger()
    expect(recs.map(r => [r.kind, r.run, r.body])).toEqual([['swarm.revision', 'swarm:alpha', { n: 1, from: 'save', changes: ['nodes.part-a'] }]])
    expect(await readSaved(p, litterDir, 'alpha')).toEqual({ spec: spec(), revision: 1, briefs: { 'part-a': 'Own branch a.\n', reviewer: 'Review it.\n' } })
  })

  test('counts revisions, keeps each one\'s briefs, and drops a brief its node no longer names from briefs/', async () => {
    await saveRevision(p, litterDir, 'alpha', { spec: spec(), briefs: { 'part-a': 'one', reviewer: 'r1' } }, { from: 'save', changes: [] })
    const two = spec({ goal: 'Second', nodes: [spec().nodes[0]!, node('reviewer')] })
    expect(await saveRevision(p, litterDir, 'alpha', { spec: two, briefs: { 'part-a': 'two' } }, { from: 'template', template: 'x', changes: [] })).toEqual({
      ok: true,
      revision: 2,
    })
    expect(read('revisions', '1', 'briefs', 'reviewer.md')).toBe('r1')
    expect(readdirSync(swarm('revisions', '2', 'briefs'))).toEqual(['part-a.md'])
    expect(readdirSync(swarm('briefs'))).toEqual(['part-a.md'])
    expect(read('briefs', 'part-a.md')).toBe('two')
    expect((await readRevision(p, litterDir, 'alpha', 1))!.briefs).toEqual({ 'part-a': 'one', reviewer: 'r1' })
    expect(await readRevision(p, litterDir, 'alpha', 3)).toBeNull()
    expect(await briefTextFor(p, litterDir, 'alpha', 1, 'reviewer')).toBe('r1')
    expect(await briefTextFor(p, litterDir, 'alpha', 2, 'reviewer')).toBeNull()
    expect(await briefTextFor(p, litterDir, 'alpha', 1, '../escape')).toBeNull()
    expect((await ledger()).map(r => r.body)).toEqual([
      { n: 1, from: 'save', changes: [] },
      { n: 2, from: 'template', template: 'x', changes: [] },
    ])
    expect((await readSaved(p, litterDir, 'alpha'))!.revision).toBe(2)
  })

  test('a save that fails validation writes nothing, and says why with each field', async () => {
    const bad = spec({ nodes: [node('part-a', { kind: 'orchestrator', worktree: 'none', spawns: { ghost: 1 }, brief: 'briefs/part-a.md' })] })
    const r = await saveRevision(p, litterDir, 'alpha', { spec: bad, briefs: {} }, { from: 'save', changes: [] })
    expect(r.ok).toBe(false)
    expect(r.ok ? [] : r.errors.map(e => e.field)).toEqual(['nodes.part-a.spawns.ghost', 'nodes.part-a.brief'])
    expect(existsSync(swarm())).toBe(false)
    expect(await ledger()).toEqual([])
  })

  test("a spec named for another swarm, or a name that isn't one, is refused", async () => {
    const r = await saveRevision(p, litterDir, 'beta', { spec: spec(), briefs: { 'part-a': 'a', reviewer: 'r' } }, { from: 'save', changes: [] })
    expect(r.ok ? [] : r.errors.map(e => e.field)).toEqual(['name'])
    const bad = await saveRevision(p, litterDir, '../x', { spec: spec(), briefs: {} }, { from: 'save', changes: [] })
    expect(bad.ok ? [] : bad.errors.map(e => e.field)).toEqual(['name'])
  })
})

describe('listSwarms and readSaved', () => {
  test('lists each saved swarm with its revision, and marks a live one', async () => {
    expect(await listSwarms(p, litterDir)).toEqual([])
    expect(await readSaved(p, litterDir, 'alpha')).toBeNull()
    await saveRevision(p, litterDir, 'alpha', { spec: spec(), briefs: { 'part-a': 'a', reviewer: 'r' } }, { from: 'save', changes: [] })
    state.putLiveSwarm({ name: 'alpha', readOnly: true, lost: false } as unknown as LiveSwarm)
    expect(await listSwarms(p, litterDir)).toEqual([{ name: 'alpha', goal: 'Review the branches', revision: 1, nodes: 2, live: true }])
  })
})

describe('drafts', () => {
  const draft = (over: Partial<Draft> = {}): Draft => ({ base: 0, edits: [], spec: spec(), briefs: { 'part-a': 'a' }, updatedAt: 1, ...over })

  test('a draft survives a fresh module over the same store', async () => {
    await writeDraft(p, litterDir, 'alpha', draft())
    const fresh = nodePorts({ cwd: dir })
    for (const [k, v] of p.storeMap) fresh.storeMap.set(k, v)
    expect(await readDraft(fresh, litterDir, 'alpha')).toEqual(draft())
    expect(p.storeMap.has(draftKey(litterDir, 'alpha'))).toBe(true)
    await clearDraft(fresh, litterDir, 'alpha')
    expect(await readDraft(fresh, litterDir, 'alpha')).toBeNull()
  })

  test('edits are kept one per path, in the order of the latest', async () => {
    const edits = [
      { path: 'goal', at: 1 },
      { path: 'nodes.part-a.task', at: 2 },
      { path: 'goal', at: 3 },
    ]
    await writeDraft(p, litterDir, 'alpha', draft({ edits }))
    expect((await readDraft(p, litterDir, 'alpha'))!.edits).toEqual([
      { path: 'nodes.part-a.task', at: 2 },
      { path: 'goal', at: 3 },
    ])
  })

  test("a draft over 1 MiB isn't kept, and a value that isn't a draft reads as none", async () => {
    await expect(writeDraft(p, litterDir, 'alpha', draft({ briefs: { big: 'x'.repeat(1024 * 1024) } }))).rejects.toThrow('over 1 MiB')
    expect(p.storeMap.has(draftKey(litterDir, 'alpha'))).toBe(false)
    p.storeMap.set(draftKey(litterDir, 'alpha'), { base: 'one' })
    expect(await readDraft(p, litterDir, 'alpha')).toBeNull()
  })

  test('a save resets an existing draft to the new revision, with no edits', async () => {
    p.clock.now = 5_000
    await writeDraft(p, litterDir, 'alpha', draft({ edits: [{ path: 'goal', at: 1 }] }))
    await saveRevision(p, litterDir, 'alpha', { spec: spec(), briefs: { 'part-a': 'a', reviewer: 'r' } }, { from: 'save', changes: [] })
    expect(await readDraft(p, litterDir, 'alpha')).toEqual({ base: 1, edits: [], spec: spec(), briefs: { 'part-a': 'a', reviewer: 'r' }, updatedAt: 5_000 })
  })
})
