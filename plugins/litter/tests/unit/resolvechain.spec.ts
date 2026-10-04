// Tier 2: a chain with a re-split's planning run in it (hooks/lifecycle.ts,
// resolveChain; phase 3, AB's finding, built in AC), against real git: a plan
// run started with `continueOf` writes it into its run.json, so it leads back
// to the chain's root, but it's on its own refs/litter/<run>/base and lands
// nothing. The chain is its execute members only, and a continuation's
// run.start on it isn't refused as off the chain's branch.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import type { RecordCtx, RecordInput } from '../../hooks/records/core'
import type { RunJson, RunStartReply } from '../../hooks/records/run'
import { endRun, recordRunStart, resolveChain } from '../../hooks/lifecycle'
import { stopLease } from '../../hooks/lock'
import { appendRecord } from '../../hooks/ledgercore'
import { modePath, runJsonPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const PLAN = [
  '# Plan',
  '',
  '### G1: First',
  'Files: a.txt',
  'Checks: test -f a.txt',
  'Done when: a.txt exists',
  '',
  '### G2: Second',
  'Files: b.txt',
  'Checks: test -f b.txt',
  'Done when: b.txt exists',
  '',
].join('\n')
const AUTH = { authorized: ['change a.txt and b.txt'] }

type World = { p: TestPorts; dir: string; litterDir: string; git: (...argv: string[]) => Promise<string>; ctx: RecordCtx }
const cleanups: (() => void)[] = []
afterEach(() => {
  stopLease()
  for (const c of cleanups.splice(0)) c()
})

/** runstart.spec.ts's world: a scratch repository with plan.md committed, jq answered, every command run in the checkout. */
async function world(): Promise<World> {
  const s = scratch()
  cleanups.push(s.cleanup)
  const dir = realpathSync(s.dir)
  const base = nodePorts({ sessionId: 'session-a' })
  const p: TestPorts = {
    ...base,
    cwd: async () => dir,
    run: (argv, init) =>
      argv[0] === 'jq' ? Promise.resolve({ code: 0, stdout: 'jq-1.7.1\n', stderr: '', truncated: false }) : base.run(argv, init?.cwd ? init : { ...init, cwd: dir }),
  }
  const { git } = await scratchRepo(p, dir)
  await p.fs.write(join(dir, 'plan.md'), PLAN)
  await git('add', 'plan.md')
  await git('commit', '-q', '-m', 'plan')
  const litterDir = join(dir, '.claude', 'litter')
  await p.fs.write(modePath(litterDir), 'default\n')
  return { p, dir, litterDir, git, ctx: { p, caller: { agentId: null, agentType: null }, litterDir, options: normalizeOptions({ verify: ['true'] }) } }
}

function okReply(r: unknown): RunStartReply {
  if (!(r as { ok: boolean }).ok) throw new Error(`run.start refused: ${JSON.stringify(r)}`)
  return r as RunStartReply
}

const start = (w: World, input: Record<string, unknown>) => recordRunStart(w.ctx, { kind: 'run.start', ...AUTH, ...input } as RecordInput)

/** A run ended as a launch that never ran, which releases the lock. */
async function ended(w: World, r: RunStartReply): Promise<void> {
  await endRun(w.p, { run: r.run, runDir: r.runDir, litterDir: w.litterDir }, { taskId: null, generation: 0, status: 'launch_failed', reason: 'test', source: 'mod' })
}

/** The execute root with G1 landed and ended, then a re-split's plan run on it (continueOf), ended too. */
async function chain(w: World): Promise<{ root: RunStartReply; plan: RunStartReply }> {
  const root = okReply(await start(w, { workflow: 'execute', planPath: 'plan.md' }))
  await appendRecord(w.p, root.runDir, { run: root.run, kind: 'land', by: { source: 'mod' }, body: { gate: 'G1', commit: 'c0ffee' } })
  await ended(w, root)
  const plan = okReply(await start(w, { workflow: 'plan', goal: 'split G2 in two', continueOf: root.run }))
  await ended(w, plan)
  return { root, plan }
}

describe("a chain with a re-split's planning run", () => {
  test('the plan run names the chain and is on its own base ref, yet the chain resolves to the execute members only', async () => {
    const w = await world()
    const { root, plan } = await chain(w)
    const planJson = JSON.parse(await w.p.fs.read(runJsonPath(plan.runDir))) as RunJson
    expect(planJson.continueOf).toBe(root.run)
    expect(planJson.ref).not.toBe(`refs/heads/litter/${root.run}`)

    for (const named of [root.run, plan.run]) {
      const r = await resolveChain(w.p, w.litterDir, named)
      if (!r.ok) throw new Error(r.error)
      expect({ named, root: r.root.run, members: r.members.map(m => m.run) }).toEqual({ named, root: root.run, members: [root.run] })
    }
  })

  test("a continuation's run.start on that chain isn't refused, and runs the gates left", async () => {
    const w = await world()
    const { root } = await chain(w)
    const next = await start(w, { workflow: 'execute', continueOf: root.run })
    expect(next).toEqual(expect.objectContaining({ ok: true }))
    const r = next as RunStartReply
    expect((r.args.gates as { id: string }[]).map(g => g.id)).toEqual(['G2'])
    expect(r.args.landed).toEqual([{ id: 'G1', commit: 'c0ffee' }])
    const chained = await resolveChain(w.p, w.litterDir, r.run)
    if (!chained.ok) throw new Error(chained.error)
    expect(chained.members.map(m => m.run).sort()).toEqual([root.run, r.run].sort())
  })

  test('a plan run at the root of its own chain stays its member', async () => {
    const w = await world()
    const plan = okReply(await start(w, { workflow: 'plan', goal: 'add a retry' }))
    await ended(w, plan)
    const r = await resolveChain(w.p, w.litterDir, plan.run)
    if (!r.ok) throw new Error(r.error)
    expect(r.members.map(m => m.run)).toEqual([plan.run])
  })
})
