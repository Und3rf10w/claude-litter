// Tier 2: mcp__litter__swarm_propose and the proposals it stages
// (hooks/swarm/propose.ts and store.ts; plan 15.4 "The swarm tools", 15.5
// "Asking the lead", section 12's proposal cases): every error with its
// field and nothing staged, a staged proposal and its record, the diff over
// the draft with its conflicts, accept all, accept some, and reject.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NodeBinding, SwarmNode, SwarmSpec } from '../../hooks/swarm/types'
import { readSpecLedger } from '../../hooks/records/swarm'
import { sha256 } from '../../hooks/fsx'
import { updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import { swarmProposeTool } from '../../hooks/swarm/propose'
import { acceptProposal, readDraft, readProposal, readSaved, rejectProposal, saveRevision, writeDraft } from '../../hooks/swarm/store'
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
  updateSession({ litterDir, litterDirError: null, toolsRefused: null, swarmToolsRefused: null, ready: true })
})
afterEach(() => {
  updateSession({ litterDir: null, swarmToolsRefused: null, ready: false })
  state.resetForTests()
  cleanup()
})

const node = (id: string, over: Partial<SwarmNode> = {}): SwarmNode => ({ id, kind: 'worker', tools: { deny: W }, authority: RO, ...over })
const lead = (id: string, over: Partial<SwarmNode> = {}): SwarmNode => node(id, { kind: 'orchestrator', worktree: 'none', ...over })
const rev1 = (): SwarmSpec => ({
  name: 'alpha',
  goal: 'Review the branches',
  nodes: [lead('part-a', { brief: 'briefs/part-a.md', task: 'Review a', spawns: { reviewer: 2 } }), node('reviewer', { brief: 'briefs/reviewer.md' })],
})
const REV1_BRIEFS = { 'part-a': 'Own branch a.\nReview it.\n', reviewer: 'Review what you are sent.\n' }

/** The lead's call, as the engine hands it to the hook. */
async function propose(input: Record<string, unknown>, agentId?: string): Promise<Record<string, unknown>> {
  const e = { tool: 'mcp__litter__swarm_propose', tool_use_id: 'tu-1', ...(agentId ? { agentId } : {}), ...input }
  const next = (() => {
    throw new Error('never passed on')
  }) as never
  const r = (await swarmProposeTool(p, e as never, next)) as { result: string }
  expect(typeof r.result).toBe('string')
  return JSON.parse(r.result) as Record<string, unknown>
}

const swarm = (...parts: string[]) => join(litterDir, 'swarms', 'alpha', ...parts)
const kinds = async () => (await readSpecLedger(p, litterDir, 'alpha')).records.map(r => r.kind)
const bodies = async (kind: string) => (await readSpecLedger(p, litterDir, 'alpha')).records.filter(r => r.kind === kind).map(r => r.body)
const fieldsOf = (r: Record<string, unknown>) => (r.errors as { field: string }[]).map(e => e.field)
const saveRev1 = () => saveRevision(p, litterDir, 'alpha', { spec: rev1(), briefs: REV1_BRIEFS }, { from: 'save', changes: [] })

describe('swarm_propose refuses', () => {
  test('a proposal that fails gets every error with its field, and nothing is staged', async () => {
    const spec = {
      ...rev1(),
      oops: 1,
      nodes: [lead('part-a', { brief: 'briefs/part-a.md', spawns: { reviewer: 2 } }), node('reviewer', { spawns: { reviewer: 1 } }), lead('part-b', { brief: 'briefs/part-b.md' })],
    }
    const r = await propose({ swarm: 'alpha', baseRevision: 3, spec, briefs: { ghost: 'x', reviewer: 'y' }, changes: [{ path: 'nodes.part-b', reason: '' }] })
    expect(r.ok).toBe(false)
    expect(fieldsOf(r)).toEqual([
      'changes[0].reason',
      'baseRevision',
      'briefs.ghost',
      'briefs.reviewer',
      'oops',
      'nodes.reviewer.spawns.reviewer',
      'nodes.part-a.brief',
      'nodes.part-b.brief',
    ])
    expect((r.errors as { field: string; node?: string; error: string }[]).find(e => e.field === 'nodes.part-b.brief')).toEqual(
      expect.objectContaining({ node: 'part-b', error: expect.stringContaining('briefs.part-b') }),
    )
    expect(existsSync(swarm('proposals'))).toBe(false)
    expect(await kinds()).toEqual([])
    expect(state.takeProposals()).toEqual([])
  })

  test('a node, by its node name, and any other agent', async () => {
    state.putBinding({ agentId: 'ag-1', swarm: 'alpha', node: 'part-a', kind: 'orchestrator' } as unknown as NodeBinding)
    const r = await propose({ swarm: 'alpha', baseRevision: 0, spec: rev1(), changes: [] }, 'ag-1')
    expect(r).toEqual({ ok: false, error: expect.stringContaining('node part-a of swarm alpha (ag-1)') })
    expect(await propose({ swarm: 'alpha', baseRevision: 0, spec: rev1(), changes: [] }, 'ag-9')).toEqual({ ok: false, error: expect.stringContaining('agent ag-9') })
  })

  test('refused tools, no litter directory, and a swarm name that is no name', async () => {
    updateSession({ swarmToolsRefused: 'not in allowedMcpServers' })
    expect((await propose({ swarm: 'alpha' })).error).toContain('allowedMcpServers')
    updateSession({ swarmToolsRefused: null, litterDir: null, litterDirError: 'not a repository' })
    expect((await propose({ swarm: 'alpha' })).error).toContain('not a repository')
    updateSession({ litterDir })
    expect(fieldsOf(await propose({ swarm: '../x', baseRevision: 0, spec: rev1(), changes: [] }))).toEqual(['swarm'])
  })

  test('a spec named for another swarm', async () => {
    const r = await propose({ swarm: 'beta', baseRevision: 0, spec: rev1(), briefs: REV1_BRIEFS, changes: [] })
    expect(fieldsOf(r)).toEqual(['name'])
  })
})

describe('swarm_propose stages', () => {
  test('a new swarm at revision 0: its spec and briefs staged, swarm.proposal recorded, the builder told', async () => {
    const changes = [{ path: 'nodes.part-a', reason: 'one per branch' }]
    const r = await propose({ swarm: 'alpha', baseRevision: 0, spec: rev1(), briefs: REV1_BRIEFS, changes })
    // Over nothing saved: two nodes added, and the goal changed from empty.
    expect(r).toEqual({ ok: true, proposal: 1, diff: { added: 2, removed: 0, changed: 1, briefs: 2, conflicts: 0 } })
    expect(JSON.parse(readFileSync(swarm('proposals', '1', 'spec.json'), 'utf8'))).toEqual(rev1())
    expect(readFileSync(swarm('proposals', '1', 'briefs', 'part-a.md'), 'utf8')).toBe(REV1_BRIEFS['part-a'])
    expect(await bodies('swarm.proposal')).toEqual([
      { n: 1, baseRevision: 0, spec: rev1(), briefs: { 'part-a': await sha256(REV1_BRIEFS['part-a']), reviewer: await sha256(REV1_BRIEFS.reviewer) }, changes },
    ])
    expect(state.takeProposals()).toEqual([{ name: 'alpha', n: 1 }])
    expect(existsSync(swarm('briefs'))).toBe(false)
  })

  test('the spec, briefs and changes sent as JSON text are decoded', async () => {
    const r = await propose({
      swarm: 'alpha',
      baseRevision: '0',
      spec: JSON.stringify(rev1()),
      briefs: JSON.stringify(REV1_BRIEFS),
      changes: JSON.stringify([{ path: 'goal', reason: 'r' }]),
    })
    expect(r).toEqual(expect.objectContaining({ ok: true, proposal: 1 }))
  })

  test("a brief left out is taken from the base revision; one in neither is refused", async () => {
    await saveRev1()
    const spec = { ...rev1(), nodes: [...rev1().nodes, lead('part-b', { brief: 'briefs/part-b.md' })] }
    const missing = await propose({ swarm: 'alpha', baseRevision: 1, spec, changes: [] })
    expect(fieldsOf(missing)).toEqual(['nodes.part-b.brief'])
    const ok = await propose({ swarm: 'alpha', baseRevision: 1, spec, briefs: { 'part-b': 'Own b.\n' }, changes: [{ path: 'nodes.part-b', reason: 'split' }] })
    expect(ok).toEqual({ ok: true, proposal: 1, diff: { added: 1, removed: 0, changed: 0, briefs: 1, conflicts: 0 } })
    expect(readdirSync(swarm('proposals', '1', 'briefs'))).toEqual(['part-b.md'])
  })

  test("the base must be the draft's revision or a saved one", async () => {
    await saveRev1()
    const at = async (baseRevision: number) => propose({ swarm: 'alpha', baseRevision, spec: rev1(), briefs: REV1_BRIEFS, changes: [] })
    expect(fieldsOf(await at(0))).toEqual(['baseRevision'])
    expect(fieldsOf(await at(2))).toEqual(['baseRevision'])
    expect((await at(1)).ok).toBe(true)
  })
})

describe('a proposal over a draft', () => {
  /** Revision 1 saved; your draft since changes part-a's task and the goal; the lead's proposal over revision 1. */
  async function staged(): Promise<void> {
    await saveRev1()
    const mine = rev1()
    mine.goal = 'Your goal'
    mine.nodes[0]!.task = 'Your task'
    await writeDraft(p, litterDir, 'alpha', {
      base: 1,
      edits: [
        { path: 'goal', at: 1 },
        { path: 'nodes.part-a.task', at: 2 },
      ],
      spec: mine,
      briefs: REV1_BRIEFS,
      updatedAt: 2,
    })
    const theirs = rev1()
    theirs.nodes[0]!.task = 'The lead task'
    theirs.nodes[0]!.spawns = { reviewer: 3 }
    theirs.nodes.push(lead('part-b', { brief: 'briefs/part-b.md', task: 'Review b' }))
    const r = await propose({
      swarm: 'alpha',
      baseRevision: 1,
      spec: theirs,
      briefs: { 'part-b': 'Own branch b.\n', reviewer: 'Review what you are sent.\nCite lines.\n' },
      changes: [
        { path: 'nodes.part-a.spawns', reason: 'more reviewers' },
        { path: 'nodes.part-b', reason: 'a second branch' },
        { path: 'nodes.part-a.task', reason: 'clearer' },
      ],
    })
    expect(r).toEqual({ ok: true, proposal: 1, diff: { added: 1, removed: 0, changed: 2, briefs: 2, conflicts: 1 } })
  }

  test('the diff names each change, its reason and its conflicts, and each brief\'s lines', async () => {
    await staged()
    const v = (await readProposal(p, litterDir, 'alpha', 1))!
    expect(v.changes).toEqual([
      {
        path: 'nodes.part-a.task',
        node: 'part-a',
        kind: 'changed',
        before: 'Review a',
        after: 'The lead task',
        reason: 'clearer',
        conflict: true,
        yours: 'Your task',
      },
      { path: 'nodes.part-a.spawns.reviewer', node: 'part-a', kind: 'changed', before: 2, after: 3, reason: 'more reviewers', conflict: false },
      { path: 'nodes.part-b', node: 'part-b', kind: 'added', after: expect.objectContaining({ id: 'part-b' }), reason: 'a second branch', conflict: false },
    ])
    expect(v.briefs).toEqual([
      { node: 'reviewer', kind: 'changed', lines: [{ op: ' ', text: 'Review what you are sent.' }, { op: '+', text: 'Cite lines.' }], reason: null, conflict: false },
      { node: 'part-b', kind: 'added', lines: [{ op: '+', text: 'Own branch b.' }], reason: 'a second branch', conflict: false },
    ])
    expect(v.decided).toBeNull()
  })

  test('accept all takes every change but the conflict, writes the next revision and its briefs, and decides it', async () => {
    await staged()
    expect(await acceptProposal(p, litterDir, 'alpha', 1, 'all')).toEqual({ ok: true, revision: 2 })
    const saved = (await readSaved(p, litterDir, 'alpha'))!
    expect(saved.revision).toBe(2)
    expect(saved.spec.goal).toBe('Your goal')
    expect(saved.spec.nodes.map(n => n.id)).toEqual(['part-a', 'reviewer', 'part-b'])
    expect(saved.spec.nodes[0]).toEqual(expect.objectContaining({ task: 'Your task', spawns: { reviewer: 3 } }))
    expect(readFileSync(swarm('revisions', '2', 'briefs', 'part-b.md'), 'utf8')).toBe('Own branch b.\n')
    expect(readFileSync(swarm('briefs', 'reviewer.md'), 'utf8')).toBe('Review what you are sent.\nCite lines.\n')
    expect(await kinds()).toEqual(['swarm.revision', 'swarm.proposal', 'swarm.revision', 'swarm.proposal.decided'])
    const picked = ['nodes.part-a.spawns.reviewer', 'nodes.part-b', 'brief:reviewer']
    expect((await bodies('swarm.revision'))[1]).toEqual({ n: 2, from: 'proposal', proposal: 1, changes: picked })
    expect(await bodies('swarm.proposal.decided')).toEqual([{ proposal: 1, accepted: 'some', picked, revision: 2 }])
    expect((await readDraft(p, litterDir, 'alpha'))!.base).toBe(2)
    expect((await readProposal(p, litterDir, 'alpha', 1))!.decided).toBe('some')
  })

  test("the lead's value wins a conflict only when you pick it, and a list takes only what it names", async () => {
    await staged()
    expect(await acceptProposal(p, litterDir, 'alpha', 1, ['nodes.part-a.task'])).toEqual({ ok: true, revision: 2 })
    const saved = (await readSaved(p, litterDir, 'alpha'))!
    expect(saved.spec.nodes.map(n => n.id)).toEqual(['part-a', 'reviewer'])
    expect(saved.spec.nodes[0]).toEqual(expect.objectContaining({ task: 'The lead task', spawns: { reviewer: 2 } }))
    expect(saved.briefs.reviewer).toBe(REV1_BRIEFS.reviewer)
    expect(existsSync(swarm('briefs', 'part-b.md'))).toBe(false)
    expect(await bodies('swarm.proposal.decided')).toEqual([{ proposal: 1, accepted: 'some', picked: ['nodes.part-a.task'], revision: 2 }])
  })

  test('taking every change, the conflict included, is accepted all', async () => {
    await staged()
    const all = ['nodes.part-a.task', 'nodes.part-a.spawns.reviewer', 'nodes.part-b', 'brief:reviewer']
    expect(await acceptProposal(p, litterDir, 'alpha', 1, all)).toEqual({ ok: true, revision: 2 })
    expect(await bodies('swarm.proposal.decided')).toEqual([{ proposal: 1, accepted: 'all', revision: 2 }])
  })

  test('a pick that names no change, or none at all, is refused, and nothing is written', async () => {
    await staged()
    const r = await acceptProposal(p, litterDir, 'alpha', 1, ['nodes.part-z'])
    expect(r).toEqual({ ok: false, errors: [{ field: 'pick', error: expect.stringContaining('nodes.part-z') }] })
    expect((await acceptProposal(p, litterDir, 'alpha', 1, [])).ok).toBe(false)
    expect(await kinds()).toEqual(['swarm.revision', 'swarm.proposal'])
  })

  test("a merge that doesn't validate writes nothing and decides nothing", async () => {
    await staged()
    // A second proposal adds helper and spawns it; picking the spawn without the node names a node that isn't there.
    const theirs = rev1()
    theirs.nodes[0]!.spawns = { reviewer: 2, helper: 1 }
    theirs.nodes.push(node('helper'))
    expect((await propose({ swarm: 'alpha', baseRevision: 1, spec: theirs, changes: [] })).ok).toBe(true)
    const r = await acceptProposal(p, litterDir, 'alpha', 2, ['nodes.part-a.spawns.helper'])
    expect(r.ok).toBe(false)
    expect(r.ok ? [] : r.errors.map(e => e.field)).toEqual(['nodes.part-a.spawns.helper'])
    expect((await readSaved(p, litterDir, 'alpha'))!.revision).toBe(1)
    expect((await readProposal(p, litterDir, 'alpha', 2))!.decided).toBeNull()
  })

  test('reject records only the decision; nothing reaches briefs/, and a second decision is refused', async () => {
    await staged()
    await rejectProposal(p, litterDir, 'alpha', 1)
    expect(await bodies('swarm.proposal.decided')).toEqual([{ proposal: 1, accepted: 'none' }])
    expect(existsSync(swarm('briefs', 'part-b.md'))).toBe(false)
    expect(readFileSync(swarm('briefs', 'reviewer.md'), 'utf8')).toBe(REV1_BRIEFS.reviewer)
    expect(existsSync(swarm('proposals', '1', 'briefs', 'part-b.md'))).toBe(true)
    await expect(rejectProposal(p, litterDir, 'alpha', 1)).rejects.toThrow('already decided')
    expect(await acceptProposal(p, litterDir, 'alpha', 1, 'all')).toEqual({ ok: false, errors: [expect.objectContaining({ field: 'proposal' })] })
    await expect(rejectProposal(p, litterDir, 'alpha', 9)).rejects.toThrow('no proposal 9')
  })

  test("a staged brief changed after it was proposed isn't accepted", async () => {
    await staged()
    writeFileSync(swarm('proposals', '1', 'briefs', 'part-b.md'), 'Something else.\n')
    await expect(acceptProposal(p, litterDir, 'alpha', 1, 'all')).rejects.toThrow("isn't the one the lead proposed")
    expect((await readSaved(p, litterDir, 'alpha'))!.revision).toBe(1)
  })

  test('a node the proposal removes takes its brief with it', async () => {
    await saveRev1()
    const theirs = rev1()
    theirs.nodes[0]!.spawns = {}
    theirs.nodes = [theirs.nodes[0]!]
    expect(await propose({ swarm: 'alpha', baseRevision: 1, spec: theirs, changes: [{ path: 'nodes.reviewer', reason: 'not needed' }] })).toEqual({
      ok: true,
      proposal: 1,
      diff: { added: 0, removed: 2, changed: 0, briefs: 1, conflicts: 0 },
    })
    expect(await acceptProposal(p, litterDir, 'alpha', 1, 'all')).toEqual({ ok: true, revision: 2 })
    expect(readdirSync(swarm('briefs'))).toEqual(['part-a.md'])
    expect((await readSaved(p, litterDir, 'alpha'))!.spec.nodes[0]!.spawns).toBeUndefined()
  })
})

describe('a proposal over revision 0', () => {
  /** Nothing saved; your draft has rev1's nodes and a third orchestrator, extra, with its brief. */
  async function draftWithExtra(): Promise<void> {
    const mine = rev1()
    mine.nodes.push(lead('extra', { brief: 'briefs/extra.md' }))
    await writeDraft(p, litterDir, 'alpha', {
      base: 0,
      edits: [{ path: 'nodes.extra', at: 1 }],
      spec: mine,
      briefs: { ...REV1_BRIEFS, extra: 'Help out.\n' },
      updatedAt: 1,
    })
  }

  test('a draft node the proposal leaves out is removed, with its brief, and accept all drops it', async () => {
    await draftWithExtra()
    const r = await propose({ swarm: 'alpha', baseRevision: 0, spec: rev1(), briefs: REV1_BRIEFS, changes: [{ path: 'nodes.extra', reason: 'not needed' }] })
    expect(r).toEqual(expect.objectContaining({ ok: true, proposal: 1, diff: expect.objectContaining({ removed: 1 }) }))
    const v = (await readProposal(p, litterDir, 'alpha', 1))!
    expect(v.changes.find(c => c.path === 'nodes.extra')).toEqual({
      path: 'nodes.extra',
      node: 'extra',
      kind: 'removed',
      before: expect.objectContaining({ id: 'extra' }),
      reason: 'not needed',
      conflict: false,
    })
    expect(v.briefs.find(b => b.node === 'extra')).toEqual({ node: 'extra', kind: 'removed', lines: [{ op: '-', text: 'Help out.' }], reason: 'not needed', conflict: false })

    expect(await acceptProposal(p, litterDir, 'alpha', 1, 'all')).toEqual({ ok: true, revision: 1 })
    const saved = (await readSaved(p, litterDir, 'alpha'))!
    expect(saved.spec.nodes.map(n => n.id)).toEqual(['part-a', 'reviewer'])
    expect(saved.briefs.extra).toBeUndefined()
    expect(existsSync(swarm('briefs', 'extra.md'))).toBe(false)
  })

  test('a pick that leaves the removal out keeps the draft node', async () => {
    await draftWithExtra()
    const theirs = rev1()
    theirs.goal = 'Review both branches'
    expect((await propose({ swarm: 'alpha', baseRevision: 0, spec: theirs, briefs: REV1_BRIEFS, changes: [{ path: 'goal', reason: 'clearer' }] })).ok).toBe(true)
    const v = (await readProposal(p, litterDir, 'alpha', 1))!
    expect(v.changes.filter(c => c.kind === 'removed').map(c => c.path)).toEqual(['nodes.extra'])
    expect(await acceptProposal(p, litterDir, 'alpha', 1, ['goal'])).toEqual({ ok: true, revision: 1 })
    const saved = (await readSaved(p, litterDir, 'alpha'))!
    expect(saved.spec.goal).toBe('Review both branches')
    expect(saved.spec.nodes.map(n => n.id)).toEqual(['part-a', 'reviewer', 'extra'])
    expect(saved.briefs.extra).toBe('Help out.\n')
  })

  test('over a saved revision, a node you added since stays yours', async () => {
    await saveRev1()
    const mine = rev1()
    mine.nodes.push(lead('part-b', { brief: 'briefs/part-b.md' }))
    await writeDraft(p, litterDir, 'alpha', { base: 1, edits: [{ path: 'nodes.part-b', at: 1 }], spec: mine, briefs: { ...REV1_BRIEFS, 'part-b': 'Own b.\n' }, updatedAt: 1 })
    const theirs = rev1()
    theirs.goal = 'Review both branches'
    expect((await propose({ swarm: 'alpha', baseRevision: 1, spec: theirs, changes: [{ path: 'goal', reason: 'clearer' }] })).ok).toBe(true)
    const v = (await readProposal(p, litterDir, 'alpha', 1))!
    expect(v.changes.map(c => c.path)).toEqual(['goal'])
    expect(v.briefs).toEqual([])
  })
})
