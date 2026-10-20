// Tier 2: hooks/design/finalize.ts, a design run's end (COMMON step 6;
// decision 16). Records through appendRecord and files in a scratch dir:
// an approved plan's plan.md is proposals/vN.md byte for byte and
// design.deliver names it, once per end; every refusal records its reason,
// writes no plan.md and leaves an existing one alone; the other
// deliverables record nothing; a launch that failed records that it never
// launched; and a write that doesn't read back throws.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { Author, StoredRecord } from '../../hooks/records/core'
import type { RunEndBody } from '../../hooks/records/run'
import type { RunRef } from '../../hooks/lifecycle'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { planPath, proposalPath, runDir, runJsonPath } from '../../hooks/layout'
import { runJsonChanged } from '../../hooks/runjson'
import { sha256 } from '../../hooks/fsx'
import { finalizeDesign, ledgerApproval } from '../../hooks/design/finalize'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const RUN = '20261004-design-ab12cd'
const MOD: Author = { source: 'mod' }
const AUTHOR: Author = { source: 'agent', agentId: 'au', agentType: 'litter:author' }
const CRITIC: Author = { source: 'agent', agentId: 'dc', agentType: 'litter:design-critic' }

const BAR = [
  { id: 'C1', text: 'retries once', evidence: 'a test' },
  { id: 'C2', text: 'keeps the timeout', evidence: 'the config' },
  { id: 'C3', text: 'logs each retry', evidence: 'a log line' },
  { id: 'C4', text: 'needs no new dependency', evidence: 'package.json' },
  { id: 'C5', text: 'consistent with rules', evidence: 'the rules' },
  { id: 'B1', text: 'no sleep in tests', evidence: 'grep', reason: 'flaky' },
]
const ALL_PASS = BAR.map(b => ({ id: b.id, verdict: 'PASS', evidence: `${b.id} holds` }))

// A plan as the mod stores it: prose, then the gates; unicode and no final newline, so a byte copy shows.
const PLAN = '# Retry the refresh — once\n\n## Approach\n\nRetry it.  \n\n## Gates\n\n### G1: Retry once\nFiles: src/refresh.ts\nChecks: bun test\nDone when: it retries\n\nImplements: Approach'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

type World = {
  p: TestPorts
  ref: RunRef
  add: (kind: string, body: Record<string, unknown>, by?: Author) => Promise<StoredRecord>
  /** The author's proposal, as the mod records it: the next version, the file, its sha256. */
  propose: (text: string) => Promise<{ version: string; sha: string }>
  /** The critic's verdict on a version, with the sha256 the mod copies from its proposal record. */
  verdict: (version: string, o?: { overall?: string; criteria?: unknown[]; sha?: string | null; source_changed?: boolean }) => Promise<void>
  /** Records the run.end and runs finalizeDesign with it, as recordEnd does. */
  end: (body: Partial<RunEndBody>) => Promise<RunEndBody>
  delivers: () => Promise<Record<string, unknown>[]>
}

async function world(deliverable = 'plan'): Promise<World> {
  const p = nodePorts()
  const s = scratch()
  cleanups.push(s.cleanup)
  const ref: RunRef = { run: RUN, runDir: runDir(s.dir, RUN), litterDir: s.dir }
  const json = { v: 1, run: RUN, workflow: 'design', args: { run: RUN, deliverable, bar: BAR, empiricalUnknowns: [] }, rules: [] }
  const jsonText = `${JSON.stringify(json, null, 2)}\n`
  await p.fs.write(runJsonPath(ref.runDir), jsonText)
  const shas = new Map<string, string>()
  const add = (kind: string, body: Record<string, unknown>, by: Author = MOD) => appendRecord(p, ref.runDir, { run: RUN, kind, by, body })
  await add('run.start', { workflow: 'design', runJsonSha256: await sha256(jsonText) }, { source: 'launcher' })
  await add('run.launch', { taskId: 't1', runId: 'wf_1', scriptPath: null, generation: 1, session: 's', oid: 'o' })
  let n = 0
  return {
    p,
    ref,
    add,
    propose: async text => {
      const version = `v${++n}`
      const sha = await sha256(text)
      shas.set(version, sha)
      await p.fs.write(proposalPath(ref.runDir, version), text)
      await add('proposal', { text, version, sha256: sha }, AUTHOR)
      return { version, sha }
    },
    verdict: async (version, o = {}) => {
      const sha = o.sha === undefined ? (shas.get(version) ?? null) : o.sha
      await add(
        'verdict',
        { version, criteria: o.criteria ?? ALL_PASS, overall: o.overall ?? 'APPROVED', sha256: sha, ...(o.source_changed !== undefined ? { source_changed: o.source_changed } : {}) },
        CRITIC,
      )
    },
    end: async body => {
      const end: RunEndBody = { taskId: 't1', generation: 1, status: 'done', reason: null, source: 'notification', ...body }
      await add('run.end', end as unknown as Record<string, unknown>)
      await finalizeDesign(p, ref, end)
      return end
    },
    delivers: async () => (await readLedger(p, ref.runDir, RUN)).records.filter(r => r.kind === 'design.deliver').map(r => r.body),
  }
}

const approved = (version: string | null) => ({ status: 'done' as const, payload: { outcome: 'approved', by: 'approved', version } })

describe('an approved plan', () => {
  test("plan.md is proposals/vN.md byte for byte, design.deliver names its version, hash and path, and a second call records nothing more", async () => {
    const w = await world()
    await w.propose('# a first try\n')
    await w.verdict('v1', { overall: 'HOLDING', criteria: ALL_PASS.map(c => (c.id === 'C3' ? { ...c, verdict: 'FAIL', gap_kind: 'design' } : c)) })
    const { sha } = await w.propose(PLAN)
    await w.verdict('v2')
    const end = await w.end(approved('v2'))
    const plan = planPath(w.ref.runDir)
    expect(readFileSync(plan).equals(readFileSync(proposalPath(w.ref.runDir, 'v2')))).toBe(true)
    expect(readFileSync(plan, 'utf8')).toBe(PLAN)
    expect(await w.delivers()).toEqual([{ version: 'v2', sha256: sha, path: plan }])
    const records = (await readLedger(w.p, w.ref.runDir, RUN)).records
    expect(records.at(-1)).toEqual(expect.objectContaining({ kind: 'design.deliver', by: { source: 'mod' } }))
    expect(records.at(-2)?.kind).toBe('run.end')
    // The same end again: the delivery stands, and nothing more is recorded.
    await finalizeDesign(w.p, w.ref, end)
    expect(await w.delivers()).toHaveLength(1)
  })

  test("a return that gives no version delivers the ledger's", async () => {
    const w = await world()
    const { sha } = await w.propose(PLAN)
    await w.verdict('v1')
    await w.end(approved(null))
    expect(await w.delivers()).toEqual([{ version: 'v1', sha256: sha, path: planPath(w.ref.runDir) }])
  })

  test("each generation's end gets its own: a holding end, a resume, then an approved one", async () => {
    const w = await world()
    await w.propose('# v1\n')
    await w.verdict('v1', { overall: 'HOLDING', criteria: ALL_PASS.map(c => (c.id === 'C1' ? { ...c, verdict: 'CONDITIONAL', gap_kind: 'wording' } : c)) })
    await w.end({ status: 'interrupted', reason: 'a missing agent type' })
    await w.add('run.resume', { taskId: 't2', runId: 'wf_2', scriptPath: null, generation: 2, session: 's', oid: 'o' })
    const { sha } = await w.propose(PLAN)
    await w.verdict('v2')
    await w.end({ taskId: 't2', generation: 2, ...approved('v2') })
    expect(await w.delivers()).toEqual([
      { version: 'v1', refused: 'holding (interrupted: a missing agent type)' },
      { version: 'v2', sha256: sha, path: planPath(w.ref.runDir) },
    ])
  })
})

describe('a refusal records its reason, writes no plan.md, and leaves an existing one alone', () => {
  type Case = { name: string; arrange: (w: World) => Promise<Partial<RunEndBody>>; version: string | null; refused: string | RegExp }
  const CASES: Case[] = [
    {
      name: 'a holding run',
      arrange: async w => {
        await w.propose(PLAN)
        await w.verdict('v1')
        return { status: 'done', payload: { outcome: 'holding', by: 'max-rounds', version: 'v1' } }
      },
      version: 'v1',
      refused: 'holding (max-rounds)',
    },
    {
      name: 'the budget',
      arrange: async w => {
        await w.propose(PLAN)
        return { status: 'done', payload: { outcome: 'holding', by: 'budget', version: 'v1' } }
      },
      version: 'v1',
      refused: 'holding (budget)',
    },
    {
      name: 'an early return for you',
      arrange: async w => {
        await w.propose(PLAN)
        await w.verdict('v1')
        return { status: 'needs_user', reason: 'goal-change', payload: { stopped: 'goal-change', reframe: {} } }
      },
      version: 'v1',
      refused: 'holding (needs_user: goal-change)',
    },
    {
      name: 'the checkout changed',
      arrange: async w => {
        await w.propose(PLAN)
        await w.verdict('v1', { source_changed: true })
        return { status: 'halted', reason: 'source-changed', payload: { version: 'v1' } }
      },
      version: 'v1',
      refused: 'holding (halted: source-changed)',
    },
    {
      name: 'a verdict on an older version',
      arrange: async w => {
        await w.propose('# v1\n')
        await w.verdict('v1')
        await w.propose(PLAN)
        return approved('v2')
      },
      version: 'v2',
      refused: 'no verdict on the latest version, v2; the latest verdict is on v1',
    },
    {
      name: 'no verdict at all',
      arrange: async w => {
        await w.propose(PLAN)
        return approved('v1')
      },
      version: 'v1',
      refused: 'no verdict on the latest version, v1',
    },
    {
      name: "a latest verdict that isn't APPROVED",
      arrange: async w => {
        await w.propose(PLAN)
        await w.verdict('v1', { overall: 'HOLDING', criteria: ALL_PASS.map(c => (c.id === 'B1' ? { ...c, verdict: 'FAIL', gap_kind: 'investigation' } : c)) })
        return approved('v1')
      },
      version: 'v1',
      refused: "the latest verdict isn't APPROVED: v1 is HOLDING",
    },
    {
      name: "an APPROVED verdict with a criterion that isn't PASS, and a bar item it doesn't judge",
      arrange: async w => {
        await w.propose(PLAN)
        const criteria = ALL_PASS.filter(c => c.id !== 'B1').map(c => (c.id === 'C3' ? { ...c, verdict: 'CONDITIONAL', gap_kind: 'wording' } : c))
        await w.verdict('v1', { criteria })
        return approved('v1')
      },
      version: 'v1',
      refused: "the latest verdict isn't APPROVED: it says APPROVED, but C3 is CONDITIONAL, B1 has no verdict",
    },
    {
      name: 'an approving verdict whose checkout changed',
      arrange: async w => {
        await w.propose(PLAN)
        await w.verdict('v1', { source_changed: true })
        return approved('v1')
      },
      version: 'v1',
      refused: "the run's return says approved, and the ledger doesn't: the checkout changed while v1 was judged (source_changed)",
    },
    {
      name: 'a return naming another version',
      arrange: async w => {
        await w.propose('# v1\n')
        await w.verdict('v1', { overall: 'HOLDING', criteria: ALL_PASS.map(c => (c.id === 'C2' ? { ...c, verdict: 'FAIL', gap_kind: 'design' } : c)) })
        await w.propose(PLAN)
        await w.verdict('v2')
        return approved('v1')
      },
      version: 'v2',
      refused: "the run's return says v1 was approved, and the ledger's latest version is v2",
    },
    {
      name: 'an approved return with no proposal recorded',
      arrange: async () => approved('v1'),
      version: null,
      refused: "the run's return says approved, and the ledger doesn't: no proposal was recorded",
    },
    {
      name: 'proposals/vN.md edited after approval',
      arrange: async w => {
        await w.propose(PLAN)
        await w.verdict('v1')
        writeFileSync(proposalPath(w.ref.runDir, 'v1'), `${PLAN}\n\nOne more line.`)
        return approved('v1')
      },
      version: 'v1',
      refused: /^proposals\/v1\.md changed after it was approved: its sha256 is [0-9a-f]{64}, and the approving verdict names [0-9a-f]{64}$/,
    },
    {
      name: "a proposal record whose sha256 isn't the file's, though the verdict's is",
      arrange: async w => {
        const { sha } = await w.propose(PLAN)
        // The record and the verdict disagree; the file matches the verdict's.
        await w.add('proposal', { text: PLAN, version: 'v2', sha256: 'f'.repeat(64) }, AUTHOR)
        await w.p.fs.write(proposalPath(w.ref.runDir, 'v2'), PLAN)
        await w.verdict('v2', { sha })
        return approved('v2')
      },
      version: 'v2',
      refused: /^proposals\/v2\.md changed after it was recorded: its sha256 is [0-9a-f]{64}, and its proposal record names f{64}$/,
    },
    {
      name: 'proposals/vN.md removed',
      arrange: async w => {
        await w.propose(PLAN)
        await w.verdict('v1')
        await w.p.run(['rm', '-f', '--', proposalPath(w.ref.runDir, 'v1')])
        return approved('v1')
      },
      version: 'v1',
      refused: "proposals/v1.md changed after it was recorded: it's gone",
    },
    {
      name: 'run.json changed since run.start',
      arrange: async w => {
        await w.propose(PLAN)
        await w.verdict('v1')
        const path = runJsonPath(w.ref.runDir)
        writeFileSync(path, readFileSync(path, 'utf8').replace('"plan"', '"research"'))
        return approved('v1')
      },
      version: 'v1',
      refused: runJsonChanged(RUN),
    },
  ]

  for (const c of CASES) {
    test(c.name, async () => {
      const w = await world()
      const plan = planPath(w.ref.runDir)
      writeFileSync(plan, 'my own plan.md\n')
      await w.end(await c.arrange(w))
      const [d, ...more] = await w.delivers()
      expect(more).toEqual([])
      expect(d!.version).toBe(c.version)
      if (typeof c.refused === 'string') expect(d!.refused).toBe(c.refused)
      else expect(d!.refused).toMatch(c.refused)
      expect(Object.keys(d!).sort()).toEqual(['refused', 'version'])
      expect(readFileSync(plan, 'utf8')).toBe('my own plan.md\n')
    })
  }

  test('with no plan.md before, none is written', async () => {
    const w = await world()
    await w.propose(PLAN)
    await w.verdict('v1', { overall: 'HOLDING', criteria: ALL_PASS.map(c => (c.id === 'C1' ? { ...c, verdict: 'FAIL', gap_kind: 'user' } : c)) })
    await w.end({ status: 'needs_user', reason: 'user-gap', payload: { stopped: 'user-gap', criteria: [] } })
    expect((await w.delivers())[0]).toEqual({ version: 'v1', refused: 'holding (needs_user: user-gap)' })
    expect(existsSync(planPath(w.ref.runDir))).toBe(false)
  })
})

describe('a launch that failed (generation 0)', () => {
  test("records that the run never launched, with no version", async () => {
    const w = await world()
    await w.end({ taskId: null, generation: 0, status: 'launch_failed', reason: 'the Workflow call failed', source: 'mod' })
    expect(await w.delivers()).toEqual([{ version: null, refused: 'the run never launched' }])
    expect(existsSync(planPath(w.ref.runDir))).toBe(false)
  })

  test('even with no run.json, since run.start can fail before writing it', async () => {
    const w = await world()
    await w.p.run(['rm', '-f', '--', runJsonPath(w.ref.runDir)])
    await w.end({ taskId: null, generation: 0, status: 'launch_failed', reason: 'lock lost', source: 'mod' })
    expect(await w.delivers()).toEqual([{ version: null, refused: 'the run never launched' }])
  })
})

describe('the other deliverables', () => {
  for (const deliverable of ['research', 'audit', 'review']) {
    test(`${deliverable}: approved, nothing is recorded and no plan.md is written`, async () => {
      const w = await world(deliverable)
      await w.propose('# Findings\n')
      await w.verdict('v1')
      await w.end(approved('v1'))
      expect(await w.delivers()).toEqual([])
      expect(existsSync(planPath(w.ref.runDir))).toBe(false)
    })
  }
})

describe('failures throw, for recordEnd to log', () => {
  test("a plan.md that doesn't read back as the approved bytes is removed, and nothing is recorded", async () => {
    const w = await world()
    await w.propose(PLAN)
    await w.verdict('v1')
    const plan = planPath(w.ref.runDir)
    const read = w.p.fs.read
    w.p.fs.read = async path => (path === plan ? 'not the plan' : read(path))
    const end: RunEndBody = { taskId: 't1', generation: 1, reason: null, source: 'notification', ...approved('v1') }
    await w.add('run.end', end as unknown as Record<string, unknown>)
    await expect(finalizeDesign(w.p, w.ref, end)).rejects.toThrow(/^plan\.md read back with sha256 [0-9a-f]{64}, not the approved [0-9a-f]{64}; it was removed$/)
    expect(existsSync(plan)).toBe(false)
    expect(await w.delivers()).toEqual([])
  })

  test('an end that the ledger has no run.end for', async () => {
    const w = await world()
    await expect(finalizeDesign(w.p, w.ref, { taskId: 't1', generation: 1, status: 'done', reason: null, source: 'notification' })).rejects.toThrow(
      `run ${RUN} has no run.end for generation 1`,
    )
  })
})

describe('ledgerApproval', () => {
  test("reads only the records it's given: a verdict after the end doesn't count", async () => {
    const w = await world()
    await w.propose(PLAN)
    const before = (await readLedger(w.p, w.ref.runDir, RUN)).records
    const end: RunEndBody = { taskId: 't1', generation: 1, reason: null, source: 'notification', ...approved('v1') }
    expect(ledgerApproval(end, before, BAR.map(b => b.id))).toEqual({ ok: false, version: 'v1', refused: 'no verdict on the latest version, v1' })
    await w.verdict('v1')
    const after = (await readLedger(w.p, w.ref.runDir, RUN)).records
    expect(ledgerApproval(end, after, BAR.map(b => b.id))).toEqual({ ok: true, version: 'v1', proposalSha: await sha256(PLAN), verdictSha: await sha256(PLAN) })
  })
})
