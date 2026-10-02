// Tier 2: the land record against real git in scratch repos (plan section 7,
// "Landing is the mod's" and its six steps; section 9, "verify and land
// records"; section 12's verify/land cases).

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { landFields, recordLand } from '../../hooks/land'
import { recordVerify } from '../../hooks/verify'
import { appendRecord, headKey, readLedger } from '../../hooks/ledgercore'
import { normalizeOptions } from '../../hooks/options'
import type { Caller, RecordCtx, RecordError } from '../../hooks/records/core'
import type { RunJson } from '../../hooks/records/run'
import type { LandBody, LandIntentBody, LandReply, VerifyReply } from '../../hooks/records/execute'
import type { Ports } from '../../hooks/ports'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

const RUN = '20261002-land'
const REF = `refs/heads/litter/${RUN}`
const BRANCH = `litter/${RUN}`
const CRITIC: Caller = { agentId: 'critic-1', agentType: 'litter:gate-critic' }
const EXECUTOR: Caller = { agentId: 'executor-1', agentType: 'litter:executor' }
const RELAY: Caller = { agentId: 'relay-1', agentType: 'litter:relay' }
const MOD = { source: 'mod' } as const

// Each test runs dozens of real git commands, slow on a busy machine.
setDefaultTimeout(20_000)

let p: TestPorts
let dir: string
let litterDir: string
let runDir: string
let base: string
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
  await writeRun()
})
afterEach(() => cleanups.forEach(c => c()))

async function writeRun(patch: Partial<RunJson> = {}): Promise<void> {
  const json: RunJson = {
    v: 1,
    run: RUN,
    workflow: 'execute',
    args: {
      gates: [
        { id: 'G1', title: 'Add the parser', lines: { start: 3, end: 9 } },
        { id: 'G2', title: 'Wire it in', lines: { start: 10, end: 20 } },
      ],
      planPath: join(runDir, 'plan.md'),
    },
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
    ...patch,
  }
  await p.fs.write(join(runDir, 'run.json'), JSON.stringify(json))
}

const ctx = (caller: Caller): RecordCtx => ({ p, caller, litterDir, options: normalizeOptions({}) })
const write = (path: string, text: string) => {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), text)
}

/** The critic's verify of the tree as it is now. */
async function verifyNow(caller: Caller = CRITIC, gate = 'G1', attempt = 1): Promise<VerifyReply> {
  const r = await recordVerify(ctx(caller), { kind: 'verify', run: RUN, gate, attempt })
  expect(r.ok).toBe(true)
  return r as VerifyReply
}

const PASS = { pass: true, evidence: 'checked', gaps: [] as string[] }
/** The critic's verdict, as the ledger holds it once its StructuredOutput is recorded. */
async function approve(verifyId: string, by: Caller = CRITIC, patch: Record<string, unknown> = {}): Promise<void> {
  await appendRecord(p, runDir, {
    run: RUN,
    kind: 'verdict',
    by: { source: 'agent', agentId: by.agentId!, agentType: by.agentType },
    body: { verify_id: verifyId, plan_adherence: PASS, tests_green: PASS, no_regressions: PASS, rules: PASS, plan_gap: '', proposed_rules: [], ...patch },
  })
}

/** A gate's change, verified green and approved: what a relay then lands. */
async function approvedChange(): Promise<string> {
  write('src/parser.ts', 'export const parse = (s: string) => s.split(",")\n')
  const v = await verifyNow()
  expect(v.green).toBe(true)
  await approve(v.verify_id)
  return v.verify_id
}

async function land(verifyId: string, gate = 'G1', caller: Caller = RELAY): Promise<LandReply> {
  const r = await recordLand(ctx(caller), { kind: 'land', run: RUN, gate, verify_id: verifyId })
  expect(r.ok).toBe(true)
  return r as LandReply
}

const tip = async (ref = REF) => (await git('rev-parse', ref)).trim()
const status = async () => (await git('status', '--porcelain')).trimEnd()
const staged = async () => (await git('diff', '--cached', '--name-only')).trim()
const kinds = async () => (await readLedger(p, runDir, RUN)).records.map(r => r.kind)
const blobOf = async (text: string) => (await p.run(['git', 'hash-object', '-w', '--stdin'], { cwd: dir, stdin: text })).stdout.trim()
const indexEntry = async (path: string) => (await git('ls-files', '-s', '--', path)).trim()

/** Runs `act` once, just before or just after the first git call `when` matches: a stand-in for you, mid-land. */
function interpose(when: (argv: readonly string[]) => boolean, phase: 'before' | 'after', act: () => Promise<void>): void {
  const run: Ports['run'] = p.run
  let done = false
  p.run = async (argv, init) => {
    if (!done && phase === 'before' && when(argv)) {
      done = true
      await act()
    }
    const r = await run(argv, init)
    if (!done && phase === 'after' && when(argv)) {
      done = true
      await act()
    }
    return r
  }
}
const isSwap = (argv: readonly string[]) => argv.includes('update-ref') && argv.includes(REF)
const isIndexMove = (argv: readonly string[]) => argv.includes('read-tree') && argv.includes('-i') && argv.at(-1) !== 'HEAD'

describe('land: the six steps', () => {
  test('commits exactly the verified tree on the run ref, moves the index, and records intent then land', async () => {
    const verifyId = await approvedChange()
    const verified = (await readLedger(p, runDir, RUN)).records.find(r => r.kind === 'verify')!.body as { tree_after: string }
    const r = await land(verifyId)
    expect(r).toMatchObject({ landed: true, retry: false })
    if (!r.landed) throw new Error('not landed')
    expect(r.reason).toBeUndefined()
    expect(await tip()).toBe(r.commit)
    expect((await git('rev-parse', `${r.commit}^{tree}`)).trim()).toBe(verified.tree_after)
    expect((await git('rev-parse', `${r.commit}^`)).trim()).toBe(base)
    expect((await git('symbolic-ref', 'HEAD')).trim()).toBe(REF)
    expect(await status()).toBe('')
    const msg = await git('log', '-1', '--format=%B', r.commit)
    expect(msg).toBe(`G1: Add the parser\n\nRefs: .claude/litter/${RUN}/plan.md:3-9\nLitter-Run: ${RUN} G1 ${verifyId}\n\n`)
    expect((await git('log', '-1', '--format=%(trailers:key=Litter-Run,valueonly)', r.commit)).trim()).toBe(`${RUN} G1 ${verifyId}`)
    const recs = (await readLedger(p, runDir, RUN)).records
    expect(recs.map(x => x.kind)).toEqual(['verify', 'verdict', 'land.intent', 'land'])
    expect(recs[2]!.by).toEqual(MOD)
    expect(recs[2]!.body).toEqual({ gate: 'G1', verify_id: verifyId, tree: verified.tree_after, old: base, ref: REF, mode: 'index' } satisfies LandIntentBody)
    expect(recs[3]!.body).toEqual({ gate: 'G1', verify_id: verifyId, commit: r.commit, tree: verified.tree_after, old: base, ref: REF } satisfies LandBody)
  })

  test('is idempotent per verify_id: the first answer again, and no second commit', async () => {
    const verifyId = await approvedChange()
    const first = await land(verifyId)
    const second = await land(verifyId)
    expect(second).toEqual(first)
    expect(await git('rev-list', '--count', `${base}..${REF}`)).toBe('1\n')
    expect(await kinds()).toEqual(['verify', 'verdict', 'land.intent', 'land'])
    // The same verify_id under another gate is refused.
    expect(await land(verifyId, 'G2')).toMatchObject({ landed: false, retry: false })
  })

  test('a second gate lands on the first: the ledger says where the ref should be', async () => {
    const first = await land(await approvedChange())
    write('src/wire.ts', 'export {}\n')
    const v = await verifyNow(CRITIC, 'G2', 1)
    await approve(v.verify_id)
    const second = await land(v.verify_id, 'G2')
    expect(second.landed).toBe(true)
    if (!first.landed || !second.landed) throw new Error('not landed')
    expect((await git('rev-parse', `${second.commit}^`)).trim()).toBe(first.commit)
    expect(await status()).toBe('')
  })

  test('your staged content on other paths survives: another file, under .claude/litter/, intent-to-add', async () => {
    const blob = await blobOf('staged by you\n')
    await git('update-index', '--cacheinfo', `100644,${blob},README.md`)
    write('.claude/litter/notes.json', '{}\n')
    await git('add', '.claude/litter/notes.json')
    write('.claude/litter/ita.txt', 'later\n')
    await git('add', '-N', '.claude/litter/ita.txt')
    const before = await git('ls-files', '-s', '--', 'README.md', '.claude/litter')
    const r = await land(await approvedChange())
    expect(r.landed).toBe(true)
    expect(await git('ls-files', '-s', '--', 'README.md', '.claude/litter')).toBe(before)
    expect(await git('diff', '--cached', '--name-only', '--ita-visible-in-index')).toContain('.claude/litter/ita.txt')
    // The gate's own path is in the index at the new commit; README keeps your blob, not the commit's.
    expect(await indexEntry('README.md')).toContain(blob)
    expect((await git('diff', '--cached', '--name-only', 'HEAD', '--', 'src')).trim()).toBe('')
  })

  test("the mod's own paths and the rule folders never reach a gate's commit", async () => {
    write('.litter/rules/r1.md', '# rule\n')
    write('.claude/rules/litter/r1.md', '# export\n')
    write('.litter.local/rules/r2.md', '# local\n')
    write('.claude/litter/20261002-other/ledger/000001-finding.json', '{}\n')
    const r = await land(await approvedChange())
    if (!r.landed) throw new Error('not landed')
    expect((await git('ls-tree', '-r', '--name-only', r.commit)).trim().split('\n').sort()).toEqual(['README.md', 'src/parser.ts'])
  })

  test('a submodule whose HEAD moved (SC..) verifies and lands as an ordinary change', async () => {
    const { dir: subDir, cleanup } = scratch()
    cleanups.push(cleanup)
    await scratchRepo(p, subDir)
    await git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subDir, 'vendor/sub')
    await git('commit', '-q', '-m', 'add sub')
    base = (await git('rev-parse', 'HEAD')).trim()
    await writeRun()
    const sub = join(dir, 'vendor/sub')
    writeFileSync(join(sub, 'next.txt'), 'n\n')
    await p.run(['git', 'add', 'next.txt'], { cwd: sub })
    await p.run(['git', 'commit', '-q', '-m', 'next'], { cwd: sub })
    const moved = (await p.run(['git', 'rev-parse', 'HEAD'], { cwd: sub })).stdout.trim()
    const v = await verifyNow()
    expect(v.green).toBe(true)
    await approve(v.verify_id)
    const r = await land(v.verify_id)
    if (!r.landed) throw new Error(`not landed: ${r.reason}`)
    expect(await git('ls-tree', r.commit, 'vendor/sub')).toContain(moved)
    expect(await status()).toBe('')
  }, 30_000)

  test('after a restart (fresh module state, the same store), a land still goes through', async () => {
    const verifyId = await approvedChange()
    const restarted = nodePorts()
    for (const [k, v] of p.storeMap) restarted.storeMap.set(k, v)
    const r = await recordLand({ p: restarted, caller: { agentId: 'relay-2', agentType: 'litter:relay' }, litterDir, options: normalizeOptions({}) }, { kind: 'land', run: RUN, gate: 'G1', verify_id: verifyId })
    expect(r).toMatchObject({ ok: true, landed: true })
  })

  test("the relay's observed fields validate against LANDED, landed or not: no nulls, no extra keys", async () => {
    const LANDED: Record<string, string> = { landed: 'boolean', commit: 'string', reason: 'string', retry: 'boolean' }
    const check = (reply: LandReply) => {
      const fields = landFields(reply)
      expect('landed' in fields).toBe(true)
      for (const [k, v] of Object.entries(fields)) expect([k, typeof v]).toEqual([k, LANDED[k]!])
    }
    const verifyId = await approvedChange()
    write('src/parser.ts', 'moved on\n')
    check(await land(verifyId))
    write('src/parser.ts', 'export const parse = (s: string) => s.split(",")\n')
    check(await land(verifyId))
    check(await land('G1-1-nosuchverify'))
  })

  test('a sparse checkout lands clean, with absent files still absent and skip-worktree', async () => {
    write('in/a.ts', 'a\n')
    write('out/b.ts', 'b\n')
    await git('add', '-A')
    await git('commit', '-q', '-m', 'tree')
    base = (await git('rev-parse', 'HEAD')).trim()
    await writeRun()
    await git('sparse-checkout', 'set', '--cone', 'in')
    write('in/a.ts', 'changed by the gate\n')
    const v = await verifyNow()
    await approve(v.verify_id)
    const r = await land(v.verify_id)
    expect(r.landed).toBe(true)
    expect(await status()).toBe('')
    expect(existsSync(join(dir, 'out/b.ts'))).toBe(false)
    expect((await git('ls-files', '-t', 'out/b.ts')).trim()).toBe('S out/b.ts')
    if (!r.landed) throw new Error('not landed')
    expect((await git('cat-file', '-p', `${r.commit}:out/b.ts`)).trim()).toBe('b')
  })
})

describe('land: each precondition refused on its own, nothing moved', () => {
  async function refusedWith(verifyId: string, reason: RegExp, retry = false, gate = 'G1'): Promise<void> {
    const before = await kinds()
    const r = await land(verifyId, gate)
    expect(r.landed).toBe(false)
    if (r.landed) return
    expect(r.reason).toMatch(reason)
    expect(r.retry).toBe(retry)
    expect(await tip()).toBe(base)
    expect(await kinds()).toEqual(before)
  }

  test('an unknown verify_id', async () => {
    await approvedChange()
    await refusedWith('G1-1-nosuchverify', /no verify/)
  })

  test('a verify for another gate', async () => {
    write('src/x.ts', 'x\n')
    const v = await verifyNow(CRITIC, 'G2', 1)
    await approve(v.verify_id)
    await refusedWith(v.verify_id, /is for gate G2/)
  })

  test('a red verify', async () => {
    await writeRun({ verify: ['sh', '-c', 'exit 1'] })
    write('src/x.ts', 'x\n')
    const v = await verifyNow()
    await approve(v.verify_id)
    await refusedWith(v.verify_id, /isn't green \(exit 1\)/)
  })

  test('a verify whose tree changed during the run', async () => {
    await writeRun({ verify: ['sh', '-c', 'echo drift >> README.md'] })
    const v = await verifyNow()
    await approve(v.verify_id)
    await refusedWith(v.verify_id, /tree changed during the run/)
  })

  test("an executor's verify, cited by the critic's verdict", async () => {
    write('src/x.ts', 'x\n')
    const v = await verifyNow(EXECUTOR)
    await approve(v.verify_id, CRITIC)
    await refusedWith(v.verify_id, /isn't from the agent that recorded it/)
  })

  test('a verify that is not the latest its recorder made for that gate and attempt', async () => {
    write('src/x.ts', 'x\n')
    const first = await verifyNow()
    const second = await verifyNow()
    await approve(first.verify_id)
    await refusedWith(first.verify_id, new RegExp(`isn't the latest.*${second.verify_id}`))
  })

  test('a verify the launcher recorded', async () => {
    write('src/x.ts', 'x\n')
    const v = await verifyNow({ agentId: null, agentType: null })
    await approve(v.verify_id)
    await refusedWith(v.verify_id, /wasn't recorded by an agent/)
  })

  test('no verdict', async () => {
    write('src/x.ts', 'x\n')
    const v = await verifyNow()
    await refusedWith(v.verify_id, /no verdict cites/)
  })

  test('a verdict that fails plan adherence, no regressions or rules, or names a plan gap', async () => {
    write('src/x.ts', 'x\n')
    for (const [patch, name] of [
      [{ plan_adherence: { ...PASS, pass: false } }, 'plan_adherence'],
      [{ no_regressions: { ...PASS, pass: false } }, 'no_regressions'],
      [{ rules: { ...PASS, pass: false } }, 'rules'],
      [{ plan_gap: 'G1 needs a schema change' }, 'plan_gap'],
      [{ plan_adherence: undefined }, 'plan_adherence'],
    ] as const) {
      const v = await verifyNow()
      await approve(v.verify_id, CRITIC, patch)
      await refusedWith(v.verify_id, new RegExp(`doesn't pass ${name}`))
    }
  }, 30_000)

  test("a verdict from another agent than the verify's recorder", async () => {
    write('src/x.ts', 'x\n')
    const v = await verifyNow()
    await approve(v.verify_id, { agentId: 'critic-2', agentType: 'litter:gate-critic' })
    await refusedWith(v.verify_id, /isn't from the agent that recorded it/)
  })

  test('a switched branch at the same commit: refused, and that branch is untouched', async () => {
    const verifyId = await approvedChange()
    await git('switch', '-q', '-c', 'same')
    await refusedWith(verifyId, /the checkout is on same, not litter\/20261002-land/)
    expect(await tip('refs/heads/same')).toBe(base)
    expect(await staged()).toBe('')
  })

  test('a detached HEAD', async () => {
    const verifyId = await approvedChange()
    await git('switch', '-q', '--detach')
    await refusedWith(verifyId, /a detached HEAD/)
  })

  test('a moved ref', async () => {
    const verifyId = await approvedChange()
    const elsewhere = (await p.run(['git', 'commit-tree', `${base}^{tree}`, '-p', base, '-m', 'by hand'], { cwd: dir })).stdout.trim()
    await git('update-ref', REF, elsewhere, base)
    const r = await land(verifyId)
    expect(r).toMatchObject({ landed: false, retry: false })
    if (r.landed) return
    expect(r.reason).toMatch(new RegExp(`is at ${elsewhere}, not ${base}`))
    expect(await tip()).toBe(elsewhere)
  })

  test('an out-of-band edit after the verify: retry, to re-critique the new tree', async () => {
    const verifyId = await approvedChange()
    write('src/parser.ts', 'edited by someone else\n')
    await refusedWith(verifyId, /tree changed after verify/, true)
    expect(await staged()).toBe('')
  })

  test('a submodule dirtied after the verify', async () => {
    const { dir: subDir, cleanup } = scratch()
    cleanups.push(cleanup)
    await scratchRepo(p, subDir)
    await git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subDir, 'vendor/sub')
    await git('commit', '-q', '-m', 'add sub')
    base = (await git('rev-parse', 'HEAD')).trim()
    await writeRun()
    const verifyId = await approvedChange()
    writeFileSync(join(dir, 'vendor/sub/README.md'), 'edit inside\n')
    await refusedWith(verifyId, /submodules have uncommitted changes \(vendor\/sub\)/)
  }, 30_000)

  test('a tampered ledger', async () => {
    const verifyId = await approvedChange()
    p.storeMap.set(headKey(RUN), { seq: 2, sha: 'not-the-hash' })
    const r = await land(verifyId)
    expect(r).toMatchObject({ landed: false, retry: false })
    if (!r.landed) expect(r.reason).toMatch(/tampered/)
    expect(await tip()).toBe(base)
  })

  test('a run that is stopping or has ended', async () => {
    const verifyId = await approvedChange()
    await appendRecord(p, runDir, { run: RUN, kind: 'run.launch', by: MOD, body: {} })
    await appendRecord(p, runDir, { run: RUN, kind: 'run.stopping', by: MOD, body: {} })
    await refusedWith(verifyId, /is stopping/)
    await appendRecord(p, runDir, { run: RUN, kind: 'run.end', by: MOD, body: {} })
    await refusedWith(verifyId, /has ended/)
  })

  test('malformed input names its field', async () => {
    const verifyId = await approvedChange()
    const bad = async (input: Record<string, unknown>) =>
      (await recordLand(ctx(RELAY), { kind: 'land', run: RUN, ...input })) as RecordError
    expect(await bad({ verify_id: verifyId })).toMatchObject({ ok: false, field: 'gate', allowed: ['G1', 'G2'] })
    expect(await bad({ gate: 'baseline', verify_id: verifyId })).toMatchObject({ ok: false, field: 'gate' })
    expect(await bad({ gate: 'integration', verify_id: verifyId })).toMatchObject({ ok: false, field: 'gate' })
    expect(await bad({ gate: 'G7', verify_id: verifyId })).toMatchObject({ ok: false, field: 'gate' })
    expect(await bad({ gate: 'G1' })).toMatchObject({ ok: false, field: 'verify_id' })
    expect(await bad({ gate: 'G1', verify_id: 7 })).toMatchObject({ ok: false, field: 'verify_id' })
    expect((await recordLand(ctx(RELAY), { kind: 'land', run: '20261002-other', gate: 'G1', verify_id: verifyId })) as RecordError).toMatchObject({ ok: false, field: 'run' })
    expect(await kinds()).toEqual(['verify', 'verdict'])
  })
})

describe('land: the index step refuses with retry false, changing nothing', () => {
  async function refusedInIndex(reason: RegExp): Promise<void> {
    const verifyId = await approvedChange()
    const r = await land(verifyId)
    expect(r).toMatchObject({ landed: false, retry: false })
    if (r.landed) return
    expect(r.reason).toMatch(reason)
    expect(await tip()).toBe(base)
    expect(await kinds()).toEqual(['verify', 'verdict', 'land.intent', 'land.abandoned'])
  }

  test("other content you staged on the gate's path: the land is refused, and your staged blob is intact", async () => {
    const blob = await blobOf('your own version\n')
    await git('update-index', '--add', '--cacheinfo', `100644,${blob},src/parser.ts`)
    await refusedInIndex(/src\/parser\.ts/)
    expect(await indexEntry('src/parser.ts')).toContain(blob)
  })

  test('a held index.lock', async () => {
    writeFileSync(join(dir, '.git', 'index.lock'), '')
    await refusedInIndex(/index\.lock/)
    rmSync(join(dir, '.git', 'index.lock'))
    expect(await staged()).toBe('')
  })

  test('unmerged entries in the index', async () => {
    const [a, b, c] = [await blobOf('base\n'), await blobOf('ours\n'), await blobOf('theirs\n')]
    await p.run(['git', 'update-index', '--index-info'], { cwd: dir, stdin: `100644 ${a} 1\tconflict.txt\n100644 ${b} 2\tconflict.txt\n100644 ${c} 3\tconflict.txt\n` })
    expect((await git('ls-files', '-u')).trim()).not.toBe('')
    await refusedInIndex(/resolve your current index|needs merge|conflict\.txt/)
    expect((await git('ls-files', '-u')).trim().split('\n').length).toBe(3)
  })

  test('a retried land after the index is fixed goes through', async () => {
    writeFileSync(join(dir, '.git', 'index.lock'), '')
    const verifyId = await approvedChange()
    expect((await land(verifyId)).landed).toBe(false)
    rmSync(join(dir, '.git', 'index.lock'))
    expect((await land(verifyId)).landed).toBe(true)
    expect(await git('rev-list', '--count', `${base}..${REF}`)).toBe('1\n')
  })
})

describe("land: step 5's re-sync to whatever HEAD is now", () => {
  test('after a normal land it changes nothing', async () => {
    const blob = await blobOf('staged by you\n')
    await git('update-index', '--cacheinfo', `100644,${blob},README.md`)
    const r = await land(await approvedChange())
    expect(r.landed).toBe(true)
    expect(await staged()).toBe('README.md')
    expect(await indexEntry('README.md')).toContain(blob)
  })

  test('a switch after step 4 to a branch at the new commit leaves that checkout clean, not MM', async () => {
    const verifyId = await approvedChange()
    interpose(isSwap, 'after', async () => {
      await git('switch', '-q', '-c', 'at-new', REF)
    })
    const r = await land(verifyId)
    expect(r).toMatchObject({ landed: true, retry: false })
    if (!r.landed) return
    expect(r.reason).toMatch(/the checkout moved to at-new/)
    expect((await git('symbolic-ref', 'HEAD')).trim()).toBe('refs/heads/at-new')
    expect(await status()).toBe('')
    expect(await tip()).toBe(r.commit)
    const rec = (await readLedger(p, runDir, RUN)).records.at(-1)!
    expect(rec.kind).toBe('land')
    expect((rec.body as LandBody).note).toMatch(/moved to at-new/)
  })

  test("a failed swap after a switch to a branch at the old commit takes back only the gate's staged content", async () => {
    const blob = await blobOf('staged by you\n')
    await git('update-index', '--cacheinfo', `100644,${blob},README.md`)
    const verifyId = await approvedChange()
    const elsewhere = (await p.run(['git', 'commit-tree', `${base}^{tree}`, '-p', base, '-m', 'by hand'], { cwd: dir })).stdout.trim()
    interpose(isSwap, 'before', async () => {
      // Step 3 staged the gate; you switch to a branch at the old commit (git carries the staging over), and the ref moves.
      await git('switch', '-q', '-c', 'at-old', base)
      await git('update-ref', REF, elsewhere)
    })
    const r = await land(verifyId)
    expect(r).toMatchObject({ landed: false, retry: false })
    if (r.landed) return
    expect(r.reason).toMatch(/moved during the land/)
    expect(r.reason).toMatch(/the checkout moved to at-old/)
    expect(await staged()).toBe('README.md')
    expect(await indexEntry('README.md')).toContain(blob)
    // The working-tree edit git's own checkout carried along stays, as git would leave it.
    expect(existsSync(join(dir, 'src/parser.ts'))).toBe(true)
    expect(await tip()).toBe(elsewhere)
    expect(await kinds()).toEqual(['verify', 'verdict', 'land.intent', 'land.abandoned'])
  })

  test("a switch before step 4 to a branch at the old commit: the land stands on the run's branch, and that branch's index is as it was", async () => {
    const blob = await blobOf('staged by you\n')
    await git('update-index', '--cacheinfo', `100644,${blob},README.md`)
    const verifyId = await approvedChange()
    interpose(isIndexMove, 'after', async () => {
      await git('switch', '-q', '-c', 'side', base)
    })
    const r = await land(verifyId)
    expect(r).toMatchObject({ landed: true, retry: false })
    if (!r.landed) return
    expect(r.reason).toMatch(/moved to side/)
    expect(await tip()).toBe(r.commit)
    expect(await tip('refs/heads/side')).toBe(base)
    expect(await staged()).toBe('README.md')
    expect(await indexEntry('README.md')).toContain(blob)
  })
})
