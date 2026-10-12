// Tier 2: a fanout's land against real git in scratch repos (plan section 7,
// fanout.js steps 5 and 6; section 9, "verify and land records"; section 12, "a
// fanout land is refused when the destination checkout or its index changed
// after launch"), and what a run that doesn't land keeps through its end and
// cleanup (plan 15.11). The run is integrated through the integrate record
// itself, from writers' worktrees made here with their records appended
// directly. The litter folder is in the repository, as in a real run, so
// cleanup works on its worktrees.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { recordLand } from '../../hooks/land'
import { recordVerify } from '../../hooks/verify'
import { recordIntegrate } from '../../hooks/integrate'
import { endRun } from '../../hooks/lifecycle'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { normalizeOptions } from '../../hooks/options'
import { outPath, summaryPath } from '../../hooks/layout'
import type { Caller, RecordCtx, RecordError } from '../../hooks/records/core'
import type { RunJson } from '../../hooks/records/run'
import type { IntegrateConflictBody, IntegrateReply, WorktreeCreateBody, WorktreeKeptBody } from '../../hooks/records/fanout'
import type { LandBody, LandIntentBody, LandReply, VerifyBody, VerifyReply } from '../../hooks/records/execute'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'
import { startedRunJson } from './support/runjson'

const RUN = '20261002-fanland'
const REF = `refs/heads/litter/${RUN}`
const BRANCH = `litter/${RUN}`
const IB = `litter/${RUN}-integration`
const WF = 'wf_9f8e7d6c-5b4'
const RELAY: Caller = { agentId: 'relay-1', agentType: 'litter:relay' }
const VERIFIER: Caller = { agentId: 'verifier-1', agentType: 'litter:verifier' }
const MOD = { source: 'mod' } as const

// Each test integrates, verifies and lands with real git, slow on a busy machine.
setDefaultTimeout(120_000)

type Task = { id: string; title: string; text: string; writes: boolean; files: string[] }
const TASKS: Task[] = [
  { id: 'a', title: 'A', text: 'do A', writes: true, files: ['pkgA/'] },
  { id: 'b', title: 'B', text: 'do B', writes: true, files: ['pkgB/', 'README.md'] },
  { id: 'r', title: 'R', text: 'find out', writes: false, files: [] },
]

let p: TestPorts
let dir: string
let litterDir: string
let runDir: string
let root: string
let base: string
let integration: string
let git: (...argv: string[]) => Promise<string>
let cleanups: (() => void)[]

beforeEach(async () => {
  p = nodePorts()
  const repo = scratch()
  // Resolved, as git lists worktrees and cleanup compares them (macOS's tmpdir is behind a link).
  dir = realpathSync(repo.dir)
  cleanups = [repo.cleanup]
  ;({ git } = await scratchRepo(p, dir))
  base = (await git('rev-parse', 'HEAD')).trim()
  await git('switch', '-q', '-c', BRANCH)
  litterDir = join(dir, '.claude', 'litter')
  runDir = join(litterDir, RUN)
  root = join(dir, '.claude', 'worktrees')
  await writeRun()
  integration = await addWorktree(`litter-${RUN}-integration`, IB)
})
afterEach(() => cleanups.forEach(c => c()))

function write(at: string, path: string, text: string): void {
  mkdirSync(join(at, path, '..'), { recursive: true })
  writeFileSync(join(at, path), text)
}

async function writeRun(patch: Partial<RunJson> = {}): Promise<void> {
  const json: RunJson = {
    v: 1,
    run: RUN,
    workflow: 'fanout',
    args: { run: RUN, tasks: TASKS.map(t => ({ ...t, rules: [] })), contract: '', mergeOrder: ['a', 'b'] },
    authorized: [],
    mode: 'auto',
    verify: ['true'],
    goalCheck: null,
    setup: null,
    linkDirs: [],
    base,
    ref: REF,
    checkout: dir,
    isolate: false,
    previousBranch: 'main',
    continueOf: null,
    amendOf: null,
    rules: [],
    planPath: null,
    planSha256: null,
    session: 'test-session',
    created: 0,
    ...patch,
  }
  // As if the run had started with this run.json (rechain keeps the ledger's records).
  await startedRunJson(p, runDir, json, JSON.stringify(json), { rechain: true })
}

const ctx = (caller: Caller): RecordCtx => ({ p, caller, litterDir, options: normalizeOptions({}) })
const gitIn = async (at: string, ...argv: string[]): Promise<string> => {
  const r = await p.run(['git', ...argv], { cwd: at })
  if (r.code !== 0) throw new Error(`git ${argv.join(' ')}: ${r.stderr.trim()}`)
  return r.stdout
}

async function addWorktree(name: string, branch: string): Promise<string> {
  const path = join(root, name)
  await git('worktree', 'add', '-q', '-b', branch, path, base)
  const body: WorktreeCreateBody = { run: RUN, name, path, branch, base, disposable: false, ignored: [] }
  await appendRecord(p, runDir, { run: RUN, kind: 'worktree.create', by: MOD, body })
  return path
}

/** A writer that did its task: its worktree, its commit, its binding and its done result. */
async function writer(task: string, n: number, files: Record<string, string>, opts: { bind?: boolean } = {}): Promise<string> {
  const name = `${WF}-${n}`
  const branch = `litter/${RUN}-w${n}`
  const path = await addWorktree(name, branch)
  for (const [f, text] of Object.entries(files)) write(path, f, text)
  await gitIn(path, 'add', '-A')
  await gitIn(path, 'commit', '-q', '-m', `${RUN} ${task}`)
  if (opts.bind === false) return path
  const by = { source: 'agent' as const, agentId: `writer-${n}`, agentType: 'litter:executor' }
  await appendRecord(p, runDir, { run: RUN, kind: 'task.bind', by, body: { task, worktree: { name, path, branch } } })
  await appendRecord(p, runDir, {
    run: RUN,
    kind: 'task.result',
    by,
    body: { task, role: 'executor', tool_use_id: `tu-${n}`, result: { status: 'done', files: Object.keys(files), checks: [], summary: 'done', notes: '' } },
  })
  return path
}

async function integrated(): Promise<IntegrateReply> {
  await writer('a', 1, { 'pkgA/a.ts': 'export const a = 1\n' })
  await writer('b', 2, { 'pkgB/b.ts': 'export const b = 2\n', 'README.md': 'integrated\n' })
  const r = (await recordIntegrate(ctx(RELAY), { kind: 'integrate', run: RUN })) as unknown as IntegrateReply
  expect(r.status).toBe('merged')
  return r
}

async function verifyIntegration(by: Caller = VERIFIER, attempt = 1): Promise<VerifyReply> {
  const v = await recordVerify(ctx(by), { kind: 'verify', run: RUN, gate: 'integration', attempt })
  expect(v.ok).toBe(true)
  return v as VerifyReply
}

type Check = { id: string; pass: boolean }
const ALL_PASS: Check[] = TASKS.map(t => ({ id: t.id, pass: true }))

/** The verifier's FANOUT_CHECK, as the ledger holds it once its StructuredOutput is recorded. */
const judge = (verifyId: string, checks: Check[] = ALL_PASS, by: Caller = VERIFIER) =>
  appendRecord(p, runDir, {
    run: RUN,
    kind: 'verdict',
    by: { source: 'agent', agentId: by.agentId!, agentType: by.agentType },
    body: { verify_id: verifyId, tasks: checks.map(c => ({ ...c, evidence: 'read it', gaps: c.pass ? [] : ['missing'] })), combined: 'fits', tool_use_id: `tu-v-${checks.length}` },
  })

/** Integrated, verified green and passed: what a relay then lands. */
async function approved(): Promise<{ verifyId: string; tip: string; tree: string }> {
  const r = await integrated()
  const v = await verifyIntegration()
  expect(v.green).toBe(true)
  expect(v.tree).toBe(r.tree!)
  await judge(v.verify_id)
  return { verifyId: v.verify_id, tip: r.tip!, tree: r.tree! }
}

async function land(verifyId: string, gate = 'fanout'): Promise<LandReply> {
  const r = await recordLand(ctx(RELAY), { kind: 'land', run: RUN, gate, verify_id: verifyId })
  expect(r.ok).toBe(true)
  return r as LandReply
}

const refused = async (verifyId: string, why: RegExp, retry = false): Promise<void> => {
  const r = await land(verifyId)
  expect(r).toMatchObject({ landed: false, retry })
  if (!r.landed) expect(r.reason).toMatch(why)
}

const records = async () => (await readLedger(p, runDir, RUN)).records
const kinds = async () => (await records()).map(r => r.kind)
const tipOf = async (ref = REF) => (await git('rev-parse', ref)).trim()
/** The checkout's status, litter's own folders left out as the skill's preflight leaves them out. */
const status = async () => (await git('status', '--porcelain', '--', '.', ':(exclude).claude/litter', ':(exclude).claude/worktrees')).trimEnd()

describe('fanout land', () => {
  test('lands the integration tip: the ref fast-forwards to it, and the checkout is clean there', async () => {
    const { verifyId, tip, tree } = await approved()
    const r = await land(verifyId)
    expect(r).toEqual({ ok: true, landed: true, commit: tip, retry: false })
    expect(await tipOf()).toBe(tip)
    expect((await git('symbolic-ref', 'HEAD')).trim()).toBe(REF)
    expect(await status()).toBe('')
    expect(readFileSync(join(dir, 'pkgA/a.ts'), 'utf8')).toBe('export const a = 1\n')
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('integrated\n')
    const recs = await records()
    const intent = recs.find(x => x.kind === 'land.intent')!
    expect(intent.by).toEqual(MOD)
    expect(intent.body).toEqual({ gate: 'fanout', verify_id: verifyId, tree, old: base, ref: REF, mode: 'checkout', commit: tip } satisfies LandIntentBody)
    expect(recs.at(-1)!.kind).toBe('land')
    expect(recs.at(-1)!.body).toEqual({ gate: 'fanout', verify_id: verifyId, commit: tip, tree, old: base, ref: REF } satisfies LandBody)
    // The relay's observed fields.
    expect(JSON.parse(readFileSync(outPath(litterDir, RELAY.agentId!), 'utf8'))).toMatchObject({ for: { land_of: verifyId }, fields: { landed: true, commit: tip } })
  })

  test('is idempotent per verify_id: the first answer again, and nothing moved', async () => {
    const { verifyId } = await approved()
    const first = await land(verifyId)
    const before = await kinds()
    expect(await land(verifyId)).toEqual(first)
    expect(await kinds()).toEqual(before)
  })

  test('only gate fanout, in a fanout run', async () => {
    const { verifyId } = await approved()
    const r = (await recordLand(ctx(RELAY), { kind: 'land', run: RUN, gate: 'G1', verify_id: verifyId })) as RecordError
    expect(r).toMatchObject({ ok: false, field: 'gate', allowed: ['fanout'] })
    expect(await recordLand(ctx(RELAY), { kind: 'land', run: RUN, gate: 'fanout', verify_id: '' })).toMatchObject({ ok: false, field: 'verify_id' })
    expect(await kinds()).not.toContain('land.intent')
  })
})

describe('fanout land: the verify', () => {
  test("refused for a verify that isn't green, isn't for gate integration, or isn't its recorder's latest", async () => {
    await integrated()
    await writeRun({ verify: ['false'] })
    const red = await verifyIntegration()
    await judge(red.verify_id)
    await refused(red.verify_id, /isn't green \(exit 1\)/)
    await writeRun()
    const baseline = (await recordVerify(ctx(VERIFIER), { kind: 'verify', run: RUN, gate: 'baseline' })) as VerifyReply
    await judge(baseline.verify_id)
    await refused(baseline.verify_id, /is for gate baseline; a fanout lands on the verifier's verify for gate integration/)
    const first = await verifyIntegration()
    await judge(first.verify_id)
    const second = await verifyIntegration()
    await refused(first.verify_id, new RegExp(`isn't the latest its recorder made for integration attempt 1 \\(that's ${second.verify_id}\\)`))
    await refused('integration-1-nope', /has no verify integration-1-nope/)
    expect(await tipOf()).toBe(base)
  })

  test("refused for a verify no agent recorded", async () => {
    await integrated()
    const v = (await recordVerify(ctx({ agentId: null, agentType: null }), { kind: 'verify', run: RUN, gate: 'integration', attempt: 1 })) as VerifyReply
    await refused(v.verify_id, /wasn't recorded by an agent/)
  })

  test("refused when the verify's tree isn't the integration's, or the integration worktree changed since", async () => {
    await integrated()
    write(integration, 'pkgA/extra.ts', 'uncommitted\n')
    const off = await verifyIntegration()
    await judge(off.verify_id)
    await refused(off.verify_id, /ran on tree .*, not the integration's/)
    // Put it back, verify, then change the integration worktree after.
    await gitIn(integration, 'clean', '-fdq')
    const v = await verifyIntegration(VERIFIER, 2)
    await judge(v.verify_id)
    write(integration, 'README.md', 'changed after the verify\n')
    await refused(v.verify_id, /the integration worktree .* changed after the integration/)
    await gitIn(integration, 'checkout', '-q', '--', 'README.md')
    expect((await land(v.verify_id)).landed).toBe(true)
  })
})

describe('fanout land: the integration', () => {
  test('refused while the integration has skipped tasks or was refused', async () => {
    await writer('a', 1, { 'pkgA/a.ts': 'a\n' })
    await writer('b', 2, { 'pkgB/b.ts': 'b\n', 'ci.yml': 'unowned\n' })
    const r = (await recordIntegrate(ctx(RELAY), { kind: 'integrate', run: RUN })) as unknown as IntegrateReply
    expect(r.status).toBe('merged')
    expect(r.skipped.map(s => s.task)).toEqual(['b'])
    const v = await verifyIntegration()
    await judge(v.verify_id)
    await refused(v.verify_id, /these tasks weren't merged: b/)
  })

  test('refused when integrate.done blocked', async () => {
    await writer('a', 1, { 'pkgA/a.ts': 'a\n' })
    await writer('b', 2, { 'pkgB/b.ts': 'b\n' })
    await writer('a', 3, { 'pkgA/stray.ts': 'stray\n' }, { bind: false })
    const r = (await recordIntegrate(ctx(RELAY), { kind: 'integrate', run: RUN })) as unknown as IntegrateReply
    expect(r.status).toBe('refused')
    const v = await verifyIntegration()
    await judge(v.verify_id)
    await refused(v.verify_id, /the integration was refused: worktree .* no writer was bound to it/)
  })

  test('refused when the whole-result check fails again on the tip', async () => {
    const { verifyId } = await approved()
    // A worktree with a commit and no binding, made after the integration: the re-run catches it.
    await writer('a', 3, { 'pkgA/late.ts': 'late\n' }, { bind: false })
    await refused(verifyId, new RegExp(`the combined change fails the ownership check: worktree ${WF}-3 at .* has 1 commit\\(s\\) past base`))
    expect(await tipOf()).toBe(base)
  })

  test("refused before integrate.done, and when the integration branch moved", async () => {
    await writer('a', 1, { 'pkgA/a.ts': 'a\n' })
    // No integrate yet: verify runs in the recorded integration worktree, but there's nothing to land.
    const early = await verifyIntegration()
    await judge(early.verify_id)
    await refused(early.verify_id, /integration hasn't finished/)
    await writer('b', 2, { 'pkgB/b.ts': 'b\n' })
    await recordIntegrate(ctx(RELAY), { kind: 'integrate', run: RUN })
    const v = await verifyIntegration(VERIFIER, 2)
    await judge(v.verify_id)
    const moved = (await p.run(['git', 'commit-tree', `${base}^{tree}`, '-p', base, '-m', 'by hand'], { cwd: dir })).stdout.trim()
    const tip = await tipOf(`refs/heads/${IB}`)
    await git('update-ref', `refs/heads/${IB}`, moved, tip)
    await refused(v.verify_id, new RegExp(`${IB} is at ${moved}, not the integration tip ${tip}`))
  })
})

describe('fanout land: the verdict', () => {
  test('refused with no verdict, one from another agent, one missing a task, or one failing a task', async () => {
    const r = await integrated()
    const v = await verifyIntegration()
    await refused(v.verify_id, /no verdict cites/)
    await judge(v.verify_id, ALL_PASS, { agentId: 'verifier-2', agentType: 'litter:verifier' })
    await refused(v.verify_id, /isn't from the agent that recorded it/)
    await judge(v.verify_id, ALL_PASS.filter(c => c.id !== 'r'))
    await refused(v.verify_id, /doesn't pass every task: r$/)
    await judge(v.verify_id, ALL_PASS.map(c => (c.id === 'b' ? { ...c, pass: false } : c)))
    await refused(v.verify_id, /doesn't pass every task: b$/)
    await judge(v.verify_id)
    expect(await land(v.verify_id)).toMatchObject({ landed: true, commit: r.tip })
  })
})

describe('fanout land: the destination checkout', () => {
  test('refused off the run branch, or with the ref moved', async () => {
    const { verifyId } = await approved()
    await git('switch', '-q', 'main')
    await refused(verifyId, /the checkout is on main, not litter\/20261002-fanland/)
    await git('switch', '-q', BRANCH)
    const elsewhere = (await p.run(['git', 'commit-tree', `${base}^{tree}`, '-p', base, '-m', 'by hand'], { cwd: dir })).stdout.trim()
    await git('update-ref', REF, elsewhere, base)
    await refused(verifyId, new RegExp(`is at ${elsewhere}, not the run's base`))
  })

  test('the checkout edited after the launch refuses with retry: true and overwrites nothing', async () => {
    const { verifyId, tip } = await approved()
    writeFileSync(join(dir, 'README.md'), 'your edit\n')
    await refused(verifyId, /the checkout changed after the launch/, true)
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('your edit\n')
    expect(existsSync(join(dir, 'pkgA/a.ts'))).toBe(false)
    expect(await tipOf()).toBe(base)
    expect(await kinds()).not.toContain('land.intent')
    // Once you've put it back, the same verify lands.
    await git('checkout', '-q', '--', 'README.md')
    expect(await land(verifyId)).toMatchObject({ landed: true, commit: tip })
  })

  test('a submodule with uncommitted changes in the checkout refuses the land without retry', async () => {
    const { verifyId } = await approved()
    const sub = scratch()
    cleanups.push(sub.cleanup)
    await scratchRepo(p, sub.dir)
    await git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.dir, 'sub')
    write(join(dir, 'sub'), 'README.md', 'edited inside the submodule\n')
    await refused(verifyId, /submodules have uncommitted changes \(sub\)/)
    expect(await tipOf()).toBe(base)
    expect(await kinds()).not.toContain('land.intent')
  })

  test('content you staged on a path the integration changes refuses the land, moves nothing, and keeps your staging', async () => {
    const { verifyId } = await approved()
    const blob = (await p.run(['git', 'hash-object', '-w', '--stdin'], { cwd: dir, stdin: 'staged by you\n' })).stdout.trim()
    await git('update-index', '--cacheinfo', `100644,${blob},README.md`)
    const r = await land(verifyId)
    expect(r).toMatchObject({ landed: false, retry: false })
    if (!r.landed) expect(r.reason).toMatch(/git refused to move the checkout to the integration, so nothing moved: .*README\.md/)
    expect(await tipOf()).toBe(base)
    expect((await git('ls-files', '-s', '--', 'README.md')).trim()).toContain(blob)
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('scratch\n')
    expect(existsSync(join(dir, 'pkgA/a.ts'))).toBe(false)
    expect((await kinds()).slice(-2)).toEqual(['land.intent', 'land.abandoned'])
  })
})

// ---------------------------------------------------------------------------
// A run that doesn't land: nothing is thrown away (plan 15.11; section 7,
// fanout.js steps 5 and 6). Its end runs the real cleanup before summary.md.

describe('a fanout that ends without landing keeps everything', () => {
  /** run.launch, as the Workflow hook leaves it after writeRun's run.start, so the run can end. */
  async function launched(): Promise<void> {
    await appendRecord(p, runDir, {
      run: RUN,
      kind: 'run.launch',
      by: MOD,
      body: { taskId: `task-${RUN}`, runId: WF, scriptPath: null, generation: 1, session: 'test-session', oid: '' },
    })
  }
  const end = (reason: string) =>
    endRun(p, { run: RUN, runDir, litterDir }, { taskId: `task-${RUN}`, generation: 1, status: 'halted', reason, source: 'notification' })
  const writerBranch = (n: number) => `litter/${RUN}-w${n}`
  const kept = async () => (await records()).filter(r => r.kind === 'worktree.kept').map(r => r.body as unknown as WorktreeKeptBody)

  test('branches that merge cleanly but fail verify together: unlanded, every branch, the integration worktree at its tip, the verify and the verdict kept, cleanup included', async () => {
    await launched()
    // Task a changes an API, task b consumes it to another reading of it. Each passes alone; together they don't.
    await writeRun({ verify: ['sh', '-c', 'test ! -f pkgA/api.txt || test ! -f pkgB/client.txt || test "$(cat pkgA/api.txt)" = "$(cat pkgB/client.txt)"'] })
    const wa = await writer('a', 1, { 'pkgA/api.txt': 'v2\n' })
    const wb = await writer('b', 2, { 'pkgB/client.txt': 'v1\n' })
    const r = (await recordIntegrate(ctx(RELAY), { kind: 'integrate', run: RUN })) as unknown as IntegrateReply
    expect(r).toMatchObject({ status: 'merged', merged: ['a', 'b'], skipped: [] })
    const v = await verifyIntegration()
    expect(v).toMatchObject({ green: false, exit_code: 1, tree: r.tree })
    const evidence = 'pkgB/client.txt:1 reads the API as v1, but pkgA/api.txt:1 makes it v2'
    await appendRecord(p, runDir, {
      run: RUN,
      kind: 'verdict',
      by: { source: 'agent', agentId: VERIFIER.agentId!, agentType: VERIFIER.agentType },
      body: {
        verify_id: v.verify_id,
        tasks: [
          { id: 'a', pass: true, evidence: 'pkgA/api.txt:1 is v2, as asked', gaps: [] },
          { id: 'b', pass: false, evidence, gaps: ['read the API version a sets'] },
          { id: 'r', pass: true, evidence: 'cited lines say what the report claims', gaps: [] },
        ],
        combined: 'a and b disagree on the API version',
        tool_use_id: 'tu-v-seam',
      },
    })
    // The script stops before a land; the mod would refuse one anyway.
    await refused(v.verify_id, /isn't green \(exit 1\)/)
    const tips = [await tipOf(`refs/heads/${writerBranch(1)}`), await tipOf(`refs/heads/${writerBranch(2)}`)]
    await end(`nothing landed: b failed the verifier: ${evidence}`)

    // Nothing landed, and nothing was thrown away.
    expect(await tipOf()).toBe(base)
    expect(await kinds()).not.toContain('land')
    expect(await kinds()).not.toContain('worktree.removed')
    // Every task branch, at its commit, in its worktree.
    expect([await tipOf(`refs/heads/${writerBranch(1)}`), await tipOf(`refs/heads/${writerBranch(2)}`)]).toEqual(tips)
    for (const path of [wa, wb, integration]) expect(existsSync(path)).toBe(true)
    // The integration worktree at its merged tip, clean.
    expect((await gitIn(integration, 'symbolic-ref', 'HEAD')).trim()).toBe(`refs/heads/${IB}`)
    expect((await gitIn(integration, 'rev-parse', 'HEAD')).trim()).toBe(r.tip!)
    expect(await tipOf(`refs/heads/${IB}`)).toBe(r.tip!)
    expect((await gitIn(integration, 'status', '--porcelain')).trim()).toBe('')
    // The verify record and its output, and the verifier's per-task result.
    const recs = await records()
    const verify = recs.find(x => x.kind === 'verify' && x.body.verify_id === v.verify_id)!.body as unknown as VerifyBody
    expect(verify).toMatchObject({ gate: 'integration', green: false, exit_code: 1, tree_before: r.tree })
    expect(existsSync(v.log)).toBe(true)
    const verdict = recs.find(x => x.kind === 'verdict' && x.body.verify_id === v.verify_id)!
    expect((verdict.body.tasks as { id: string; pass: boolean; gaps: string[] }[]).find(t => t.id === 'b')).toMatchObject({ pass: false, gaps: ['read the API version a sets'] })
    // Cleanup kept each worktree, and said why.
    const why = new Map((await kept()).map(k => [k.path, k.reason]))
    expect(why.get(integration)).toBe(`the run ended halted without landing, and it holds 4 commits past base on ${IB}`)
    expect(why.get(wa)).toMatch(/^task a didn't land \(the run ended halted\), and it holds 1 commit past base on /)
    expect(why.get(wb)).toMatch(/^task b didn't land \(the run ended halted\)/)
    // summary.md gives the evidence and where everything is.
    const summary = readFileSync(summaryPath(runDir), 'utf8')
    expect(summary).toContain('| b | writer | done | merged | fail: read the API version a sets |')
    expect(summary).toContain(`- the integration verify ${v.verify_id} isn't green (exit 1); its full log is in verify/${v.verify_id}/ beside this summary`)
    expect(summary).toContain(`- the verifier failed task b: ${evidence}`)
    for (const path of [wa, wb, integration]) expect(summary).toContain(`- Kept: ${path} (branch `)
    expect(summary).toContain('- Removed: 0')
  })

  test('a merge that stopped at a conflict (a hand-written run.json): the integration worktree is kept mid-merge, and the branches too', async () => {
    await launched()
    // Both tasks own README.md: run.start refuses that, so only a run.json written by hand gets here.
    await writeRun({
      args: {
        run: RUN,
        tasks: [
          { id: 'a', title: 'A', text: 'do A', writes: true, files: ['pkgA/', 'README.md'], rules: [] },
          { id: 'b', title: 'B', text: 'do B', writes: true, files: ['pkgB/', 'README.md'], rules: [] },
        ],
        contract: '',
        mergeOrder: ['a', 'b'],
      },
    })
    const wa = await writer('a', 1, { 'README.md': 'from a\n' })
    const wb = await writer('b', 2, { 'README.md': 'from b\n' })
    const r = (await recordIntegrate(ctx(RELAY), { kind: 'integrate', run: RUN })) as unknown as IntegrateReply
    expect(r).toMatchObject({ status: 'conflict', merged: ['a'], conflict: { task: 'b', branch: writerBranch(2), files: ['README.md'] } })
    // The script halts on it, with no verify: the run ends.
    const bTip = await tipOf(`refs/heads/${writerBranch(2)}`)
    await end('the merge of b stopped at a conflict in README.md; merged so far: a')

    expect(await tipOf()).toBe(base)
    expect(await kinds()).not.toContain('worktree.removed')
    for (const path of [wa, wb, integration]) expect(existsSync(path)).toBe(true)
    // Mid-merge, as the merge left it: the evidence, after cleanup.
    expect((await gitIn(integration, 'rev-parse', 'MERGE_HEAD')).trim()).toBe(bTip)
    expect((await gitIn(integration, 'diff', '--name-only', '--diff-filter=U')).trim()).toBe('README.md')
    expect((await records()).filter(x => x.kind === 'integrate.conflict').map(x => x.body as unknown as IntegrateConflictBody)).toEqual([
      { task: 'b', branch: writerBranch(2), files: ['README.md'] },
    ])
    const why = new Map((await kept()).map(k => [k.path, k.reason]))
    expect(why.get(integration)).toBe(`the run ended halted without landing, and it holds 2 commits past base on ${IB} and uncommitted changes (README.md)`)
    expect(why.get(wa)).toMatch(/^task a didn't land \(the run ended halted\)/)
    expect(why.get(wb)).toMatch(/^task b didn't land \(the run ended halted\)/)
    const summary = readFileSync(summaryPath(runDir), 'utf8')
    expect(summary).toContain('| b | writer | done | conflict in README.md | - |')
    expect(summary).toContain(
      `- the merge of task b (branch ${writerBranch(2)}) stopped at a conflict in README.md, after a (${writerBranch(1)}); the integration worktree is left mid-merge`,
    )
  })
})
