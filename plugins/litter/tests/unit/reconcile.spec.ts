// Tier 2: crash recovery for lands (plan section 7, "Crash recovery"; section
// 12). Each crash is simulated by doing the land's git steps by hand and
// leaving the ledger short, then reconciling.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { commitMessage, reconcileLands, recordLand } from '../../hooks/land'
import { recordVerify } from '../../hooks/verify'
import { appendRecord, headKey, readLedger } from '../../hooks/ledgercore'
import { normalizeOptions } from '../../hooks/options'
import { snapshot } from '../../hooks/snapshot'
import type { Caller, RecordCtx } from '../../hooks/records/core'
import type { RunJson } from '../../hooks/records/run'
import type { LandBlockedBody, LandBody, LandIntentBody, LandMode, LandReply, VerifyBody, VerifyReply } from '../../hooks/records/execute'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

const RUN = '20261002-crash'
const REF = `refs/heads/litter/${RUN}`
const BRANCH = `litter/${RUN}`
const CRITIC: Caller = { agentId: 'critic-1', agentType: 'litter:gate-critic' }
const RELAY: Caller = { agentId: 'relay-1', agentType: 'litter:relay' }
const MOD = { source: 'mod' } as const

// Each test runs dozens of real git commands, slow on a busy machine.
setDefaultTimeout(20_000)

let p: TestPorts
let dir: string
let litterDir: string
let runDir: string
let base: string
let json: RunJson
let git: (...argv: string[]) => Promise<string>
let cleanups: (() => void)[]

beforeEach(async () => {
  p = nodePorts()
  const repo = scratch()
  const out = scratch()
  dir = repo.dir
  cleanups = [repo.cleanup, out.cleanup]
  ;({ git } = await scratchRepo(p, dir))
  base = (await git('rev-parse', 'HEAD')).trim()
  await git('switch', '-q', '-c', BRANCH)
  litterDir = join(out.dir, '.claude', 'litter')
  runDir = join(litterDir, RUN)
  json = {
    v: 1,
    run: RUN,
    workflow: 'execute',
    args: { gates: [{ id: 'G1', title: 'Add the parser', lines: { start: 3, end: 9 } }], planPath: join(runDir, 'plan.md') },
    authorized: [],
    mode: 'auto',
    verify: ['true'],
    goalCheck: null,
    setup: null,
    base,
    ref: REF,
    checkout: dir,
    previousBranch: 'main',
    continueOf: null,
    amendOf: null,
    rules: [],
    planSha256: null,
    linkDirs: [],
    isolate: false,
    planPath: null,
    session: 'test-session',
    created: 0,
  }
  await p.fs.write(join(runDir, 'run.json'), JSON.stringify(json))
})
afterEach(() => cleanups.forEach(c => c()))

const ctx = (caller: Caller): RecordCtx => ({ p, caller, litterDir, options: normalizeOptions({}) })
const write = (path: string, text: string) => {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), text)
}
const PASS = { pass: true, evidence: 'checked', gaps: [] as string[] }

/** A gate's change, verified and approved, as a land finds it. Returns the verify and its tree T. */
async function approved(): Promise<{ verifyId: string; tree: string }> {
  write('src/parser.ts', 'export const parse = (s: string) => s.split(",")\n')
  const v = (await recordVerify(ctx(CRITIC), { kind: 'verify', run: RUN, gate: 'G1', attempt: 1 })) as VerifyReply
  expect(v.green).toBe(true)
  await appendRecord(p, runDir, {
    run: RUN,
    kind: 'verdict',
    by: { source: 'agent', agentId: CRITIC.agentId!, agentType: CRITIC.agentType },
    body: { verify_id: v.verify_id, plan_adherence: PASS, tests_green: PASS, no_regressions: PASS, rules: PASS, plan_gap: '', proposed_rules: [] },
  })
  return { verifyId: v.verify_id, tree: v.tree }
}

// The land's steps, by hand.
const intend = (verifyId: string, tree: string, mode: LandMode = 'index', gate = 'G1', old = base) =>
  appendRecord(p, runDir, { run: RUN, kind: 'land.intent', by: MOD, body: { gate, verify_id: verifyId, tree, old, ref: REF, mode } satisfies LandIntentBody })
const commitOf = async (tree: string, verifyId: string, gate = 'G1') =>
  (
    await p.run(['git', 'commit-tree', tree, '-p', base, '-F', '-'], {
      cwd: dir,
      stdin: commitMessage({ run: RUN, runDir, json }, gate, verifyId),
    })
  ).stdout.trim()
const moveIndex = (commit: string) => git('read-tree', '-m', '-i', base, commit)
const swap = (commit: string) => git('update-ref', REF, commit, base)
const resync = (commit: string) => git('read-tree', '-m', '-i', commit, 'HEAD')

const records = async () => (await readLedger(p, runDir, RUN)).records
const kinds = async () => (await records()).map(r => r.kind)
const tip = async () => (await git('rev-parse', REF)).trim()
const status = async () => (await git('status', '--porcelain')).trimEnd()
const staged = async () => (await git('diff', '--cached', '--name-only')).trim()
const commitsOnRef = async () => Number((await git('rev-list', '--count', `${base}..${REF}`)).trim())

async function land(verifyId: string): Promise<LandReply> {
  const r = await recordLand(ctx(RELAY), { kind: 'land', run: RUN, gate: 'G1', verify_id: verifyId })
  expect(r.ok).toBe(true)
  return r as LandReply
}

describe('reconcile, execute (index mode): a crash after each step', () => {
  test('after the intent: abandoned, and a retried land commits once', async () => {
    const { verifyId, tree } = await approved()
    await intend(verifyId, tree)
    expect(await reconcileLands(p, runDir, RUN)).toEqual({ problems: [] })
    expect((await kinds()).slice(-2)).toEqual(['land.intent', 'land.abandoned'])
    expect((await land(verifyId)).landed).toBe(true)
    expect(await commitsOnRef()).toBe(1)
    expect(await status()).toBe('')
  })

  test('after commit-tree (an unreferenced commit): abandoned, and a retried land commits once', async () => {
    const { verifyId, tree } = await approved()
    await intend(verifyId, tree)
    await commitOf(tree, verifyId)
    await reconcileLands(p, runDir, RUN)
    expect((await kinds()).at(-1)).toBe('land.abandoned')
    expect((await land(verifyId)).landed).toBe(true)
    expect(await commitsOnRef()).toBe(1)
  })

  test('after the index moved: the repair unstages the gate, the edit stays in the working tree, and the land is abandoned', async () => {
    const { verifyId, tree } = await approved()
    await intend(verifyId, tree)
    await moveIndex(await commitOf(tree, verifyId))
    expect(await staged()).toBe('src/parser.ts')
    await reconcileLands(p, runDir, RUN)
    expect(await staged()).toBe('')
    expect(readFileSync(join(dir, 'src/parser.ts'), 'utf8')).toContain('parse')
    expect((await kinds()).at(-1)).toBe('land.abandoned')
    const again = await land(verifyId)
    expect(again.landed).toBe(true)
    expect(await status()).toBe('')
  })

  test('after the swap: the trailer is found, the land recovered, and a retried land returns that commit', async () => {
    const { verifyId, tree } = await approved()
    await intend(verifyId, tree)
    const commit = await commitOf(tree, verifyId)
    await moveIndex(commit)
    await swap(commit)
    await reconcileLands(p, runDir, RUN)
    const rec = (await records()).at(-1)!
    expect(rec.kind).toBe('land')
    expect(rec.by).toEqual(MOD)
    expect(rec.body).toEqual({ gate: 'G1', verify_id: verifyId, commit, tree, old: base, ref: REF, recovered: true } satisfies LandBody)
    expect(await land(verifyId)).toEqual({ ok: true, landed: true, commit, retry: false })
    expect(await commitsOnRef()).toBe(1)
    expect(await status()).toBe('')
  })

  test('after the re-sync, before the land record: recovered the same way', async () => {
    const { verifyId, tree } = await approved()
    await intend(verifyId, tree)
    const commit = await commitOf(tree, verifyId)
    await moveIndex(commit)
    await swap(commit)
    await resync(commit)
    const r = await land(verifyId)
    expect(r).toEqual({ ok: true, landed: true, commit, retry: false })
    expect(await kinds()).toEqual(['verify', 'verdict', 'land.intent', 'land'])
    expect(((await records()).at(-1)!.body as LandBody).recovered).toBe(true)
  })

  test('a recovered land after you switched to a branch at the new commit leaves that checkout clean', async () => {
    const { verifyId, tree } = await approved()
    await intend(verifyId, tree)
    const commit = await commitOf(tree, verifyId)
    await moveIndex(commit)
    await swap(commit)
    await git('switch', '-q', '-c', 'at-new', commit)
    await reconcileLands(p, runDir, RUN)
    expect((await kinds()).at(-1)).toBe('land')
    expect(await status()).toBe('')
  })

  test('an abandoned intent leaves a clean checkout on another branch clean', async () => {
    const { verifyId, tree } = await approved()
    await intend(verifyId, tree)
    rmSync(join(dir, 'src'), { recursive: true })
    write('other.txt', 'o\n')
    await git('switch', '-q', '-c', 'other', 'main')
    await git('add', 'other.txt')
    await git('commit', '-q', '-m', 'other')
    expect(await status()).toBe('')
    await reconcileLands(p, runDir, RUN)
    expect((await kinds()).at(-1)).toBe('land.abandoned')
    expect(await status()).toBe('')
  })

  test('a gate you staged yourself, exactly, is unstaged by the repair, and its tree stays in the object database', async () => {
    const { verifyId, tree } = await approved()
    await intend(verifyId, tree)
    await git('add', 'src/parser.ts')
    await reconcileLands(p, runDir, RUN)
    expect(await staged()).toBe('')
    expect((await git('cat-file', '-t', tree)).trim()).toBe('tree')
  })

  test('nothing to settle records nothing', async () => {
    await approved()
    expect(await reconcileLands(p, runDir, RUN)).toEqual({ problems: [] })
    expect(await kinds()).toEqual(['verify', 'verdict'])
  })
})

describe('reconcile: anything else is refused with the facts', () => {
  test('an intent whose old is no longer the tip, with no commit for it', async () => {
    const { verifyId, tree } = await approved()
    await intend(verifyId, tree)
    const elsewhere = (await p.run(['git', 'commit-tree', `${base}^{tree}`, '-p', base, '-m', 'by hand'], { cwd: dir })).stdout.trim()
    await git('update-ref', REF, elsewhere, base)
    const r = await reconcileLands(p, runDir, RUN)
    expect(r.problems.length).toBe(1)
    expect(r.problems[0]).toMatch(new RegExp(`moved from ${base} to ${elsewhere}`))
    expect((await kinds()).at(-1)).toBe('land.blocked')
    // Reconciling again repeats the facts but records them once.
    expect((await reconcileLands(p, runDir, RUN)).problems).toEqual(r.problems)
    expect((await kinds()).filter(k => k === 'land.blocked').length).toBe(1)
    // And the land is refused with them.
    const l = await land(verifyId)
    expect(l).toMatchObject({ landed: false, retry: false })
    if (!l.landed) expect(l.reason).toContain(r.problems[0]!)
  })

  test("a trailer naming another run", async () => {
    const { verifyId, tree } = await approved()
    const foreign = (
      await p.run(['git', 'commit-tree', tree, '-p', base, '-F', '-'], { cwd: dir, stdin: `x\n\nLitter-Run: 20261002-other G1 G1-1-abc\n` })
    ).stdout.trim()
    await git('update-ref', REF, foreign, base)
    const r = await reconcileLands(p, runDir, RUN)
    expect(r.problems[0]).toMatch(/another run \(20261002-other G1 G1-1-abc\)/)
    const blocked = (await records()).at(-1)!
    expect(blocked.kind).toBe('land.blocked')
    expect(blocked.body).toMatchObject({ gate: 'G1', verify_id: 'G1-1-abc' })
    expect((await land(verifyId)).landed).toBe(false)
  })

  test('a commit with no trailer (yours, by hand) is no problem to reconcile', async () => {
    await approved()
    const mine = (await p.run(['git', 'commit-tree', `${base}^{tree}`, '-p', base, '-m', 'mine'], { cwd: dir })).stdout.trim()
    await git('update-ref', REF, mine, base)
    expect(await reconcileLands(p, runDir, RUN)).toEqual({ problems: [] })
  })

  test('a tampered ledger: nothing is acted on', async () => {
    const { verifyId, tree } = await approved()
    await intend(verifyId, tree)
    p.storeMap.set(headKey(RUN), { seq: 3, sha: 'not-the-hash' })
    const r = await reconcileLands(p, runDir, RUN)
    expect(r.problems[0]).toMatch(/tampered/)
    p.storeMap.delete(headKey(RUN))
    expect((await kinds()).at(-1)).toBe('land.intent')
  })

  test('a run with no run.json is reported; a ref that is gone is reported once the run began a land', async () => {
    expect((await reconcileLands(p, join(litterDir, '20261002-none'), '20261002-none')).problems[0]).toMatch(/no run/)
    await git('switch', '-q', 'main')
    await git('branch', '-q', '-D', BRANCH)
    expect(await reconcileLands(p, runDir, RUN)).toEqual({ problems: [] })
    await intend('G1-1-x', (await git('rev-parse', 'HEAD^{tree}')).trim())
    expect((await reconcileLands(p, runDir, RUN)).problems[0]).toMatch(/can't be listed/)
  })

  test('a design or plan run has nothing to reconcile', async () => {
    await p.fs.write(join(runDir, 'run.json'), JSON.stringify({ ...json, workflow: 'design', ref: '' }))
    expect(await reconcileLands(p, runDir, RUN)).toEqual({ problems: [] })
    expect(await kinds()).toEqual([])
  })
})

describe('reconcile, fanout (checkout mode)', () => {
  /** The integration's tree: files a fanout lands, made by snapshotting them, then put back to base. */
  async function integrationTree(): Promise<string> {
    write('int/a.ts', 'a\n')
    write('int/b.ts', 'b\n')
    write('README.md', 'integrated\n')
    const t = (await snapshot(p, dir)).tree
    rmSync(join(dir, 'int'), { recursive: true })
    await git('checkout', '-q', '--', 'README.md')
    expect(await status()).toBe('')
    return t
  }
  const moveFiles = (tree: string) => git('read-tree', '-m', '-u', base, tree)

  test('a crash between read-tree -m -u and the swap: the -u repair leaves the checkout clean at base', async () => {
    const t = await integrationTree()
    await intend('integration-1-x', t, 'checkout', 'fanout')
    await moveFiles(t)
    expect(await status()).not.toBe('')
    expect(await reconcileLands(p, runDir, RUN)).toEqual({ problems: [] })
    expect(await status()).toBe('')
    expect((await git('rev-parse', 'HEAD^{tree}')).trim()).toBe((await git('rev-parse', `${base}^{tree}`)).trim())
    expect((await kinds()).at(-1)).toBe('land.abandoned')
  })

  test('the index-only repair would have left the files behind, as unstaged changes', async () => {
    const t = await integrationTree()
    await moveFiles(t)
    await git('read-tree', '-m', '-i', t, 'HEAD')
    const dirt = await status()
    expect(dirt).toContain(' M README.md')
    expect(dirt).toContain('?? int/')
  })

  test('with a file you edited after the crash, the repair changes nothing and records land.blocked with the path', async () => {
    const t = await integrationTree()
    await intend('integration-1-x', t, 'checkout', 'fanout')
    await moveFiles(t)
    write('README.md', 'your edit after the crash\n')
    const before = await status()
    const r = await reconcileLands(p, runDir, RUN)
    expect(r.problems.length).toBe(1)
    expect(r.problems[0]).toMatch(/checkout repair/)
    expect(await status()).toBe(before)
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('your edit after the crash\n')
    const blocked = (await records()).at(-1)!
    expect(blocked.kind).toBe('land.blocked')
    expect((blocked.body as LandBlockedBody).paths).toEqual(['README.md'])
    // Once you've decided (here: put the integration's content back), the next reconcile repairs and abandons.
    write('README.md', 'integrated\n')
    expect(await reconcileLands(p, runDir, RUN)).toEqual({ problems: [] })
    expect(await status()).toBe('')
    expect((await kinds()).at(-1)).toBe('land.abandoned')
  })

  test('after the swap: the trailer records the land, and the -u repair is a no-op', async () => {
    const t = await integrationTree()
    await intend('integration-1-x', t, 'checkout', 'fanout')
    await moveFiles(t)
    const commit = await commitOf(t, 'integration-1-x', 'fanout')
    await swap(commit)
    const before = await status()
    expect(before).toBe('')
    expect(await reconcileLands(p, runDir, RUN)).toEqual({ problems: [] })
    expect(await status()).toBe('')
    const rec = (await records()).at(-1)!
    expect(rec.kind).toBe('land')
    expect(rec.body).toMatchObject({ gate: 'fanout', verify_id: 'integration-1-x', commit, recovered: true })
    expect((await git('ls-files', 'int')).trim().split('\n')).toEqual(['int/a.ts', 'int/b.ts'])
  })
})

describe('reconcile: the ledger and the verify it cites', () => {
  test('a recovered land carries the tree and parent from git, not from the intent', async () => {
    const { verifyId, tree } = await approved()
    const commit = await commitOf(tree, verifyId)
    await moveIndex(commit)
    await swap(commit)
    // No intent at all (a lost record): the trailer alone recovers the land.
    await reconcileLands(p, runDir, RUN)
    const body = (await records()).at(-1)!.body as LandBody
    expect(body).toMatchObject({ commit, tree, old: base, recovered: true })
    const v = (await records()).find(r => r.kind === 'verify')!.body as VerifyBody
    expect(v.tree_after).toBe(tree)
  })
})
