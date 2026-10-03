// Tier 2: the mod's side of the run worktrees (plan section 9, "Run
// worktrees", "Cleanup is the mod's"; section 12's run worktree cases), in
// scratch repos whose origin/main is behind HEAD: worktree.sh's spooled steps
// into the ledger, the worktrees the mod makes itself, worktree.json, and
// cleanup after run.end. worktree.sh is package E's, so the tests make its
// worktrees with git and hand the consumer the lines it would spool.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Policy, SpoolLine } from '../../hooks/hookfiles'
import type { Author, StoredRecord } from '../../hooks/records/core'
import type { RunJson, RunStatus } from '../../hooks/records/run'
import type { ModWorktreeSpec } from '../../hooks/worktrees'
import {
  addModWorktree,
  cleanupLeftovers,
  cleanupRun,
  consumeWorktrees,
  recordedWorktrees,
  startWorktreePolicy,
  worktreePolicyOf,
  worktreeRootFor,
  worktreeSummary,
} from '../../hooks/worktrees'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { integrationBranch, integrationName, runDir as runDirOf, runJsonPath, setupLogPart, summaryPath, worktreePolicyPath, writerBranch } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { readPolicy, writePolicy } from '../../hooks/policy'
import { endRun } from '../../hooks/lifecycle'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// Each test runs dozens of real git commands, slow on a busy machine.
setDefaultTimeout(120_000)

const RUN = '20261002-fanout-a1b2c3'
const WF = 'wf_1a2b3c4d-567'
const MOD: Author = { source: 'mod' }

let p: TestPorts
let repo: string
let litterDir: string
let runDir: string
let root: string
let base: string
let behind: string
let git: (...argv: string[]) => Promise<string>
let cleanups: (() => void)[]

beforeEach(async () => {
  p = nodePorts()
  const s = scratch()
  cleanups = [s.cleanup]
  // Resolved, as worktree.sh prints paths and git lists them (macOS's tmpdir is behind a link).
  repo = join(realpathSync(s.dir), 'repo')
  mkdirSync(repo)
  ;({ git } = await scratchRepo(p, repo))
  writeFileSync(join(repo, '.gitignore'), 'deps\n.env\ncache/\n')
  writeFileSync(join(repo, 'src.ts'), 'export const a = 1\n')
  await git('add', '.gitignore', 'src.ts')
  await git('commit', '-q', '-m', 'second')
  base = (await git('rev-parse', 'HEAD')).trim()
  behind = (await git('rev-parse', 'HEAD~1')).trim()
  // origin/main is behind HEAD: nothing here may start from it.
  await git('update-ref', 'refs/remotes/origin/main', behind)
  writeFileSync(join(repo, '.git', 'info', 'exclude'), '.claude/\n')
  await git('branch', `litter/${RUN}`, base)
  litterDir = join(repo, '.claude', 'litter')
  runDir = runDirOf(litterDir, RUN)
  root = join(repo, '.claude', 'worktrees')
  await makeRun(RUN, 'fanout', WF)
  await writePolicy(p, litterDir, policyFor(RUN, 'fanout', [WF]))
})
afterEach(() => cleanups.forEach(c => c()))

function policyFor(run: string, workflow: RunJson['workflow'], runIds: string[]): Policy {
  return {
    v: 1,
    session: 'test-session',
    litterDir,
    run: {
      run,
      workflow,
      runDir: runDirOf(litterDir, run),
      checkout: repo,
      base,
      runIds,
      launching: false,
      stopping: false,
      inflight: null,
      isolationLost: false,
      roots: { checkout: repo, litterDir, litterCopies: [litterDir], ruleDirs: [], worktrees: [] },
      setup: null,
      linkDirs: [],
      worktreeRoot: root,
      setupTimeoutSec: 60,
    },
    roles: {},
    swarm: null,
  }
}

/** run.json, run.start and run.launch for a run, as run.start and the Workflow hook leave them. */
async function makeRun(run: string, workflow: RunJson['workflow'], wf: string): Promise<void> {
  const dir = runDirOf(litterDir, run)
  const json: RunJson = {
    v: 1,
    run,
    workflow,
    args: {
      tasks: [
        { id: 'T1', title: 'one', text: 'do one', writes: true, files: ['a/'], bind: 'tok-1' },
        { id: 'T2', title: 'two', text: 'do two', writes: true, files: ['b.ts'], bind: 'tok-2' },
      ],
    },
    authorized: [],
    mode: 'auto',
    verify: ['true'],
    goalCheck: null,
    setup: null,
    linkDirs: [],
    base,
    ref: `refs/heads/litter/${run}`,
    checkout: repo,
    isolate: false,
    previousBranch: 'main',
    continueOf: null,
    amendOf: null,
    rules: [],
    planPath: null,
    planSha256: null,
    session: 'test-session',
    created: 0,
  }
  await p.fs.write(runJsonPath(dir), JSON.stringify(json))
  await appendRecord(p, dir, { run, kind: 'run.start', by: { source: 'launcher' }, body: { workflow, base, ref: json.ref, checkout: repo } })
  await appendRecord(p, dir, { run, kind: 'run.launch', by: MOD, body: { taskId: `task-${run}`, runId: wf, scriptPath: null, generation: 1, session: 'test-session', oid: '' } })
}

const records = async (run = RUN): Promise<StoredRecord[]> => (await readLedger(p, runDirOf(litterDir, run), run)).records
const kinds = async (run = RUN) => (await records(run)).filter(r => r.kind.startsWith('worktree.')).map(r => `${r.kind}:${String(r.body.name)}`)
const ctx = () => ({ p, litterDir, sessionId: 'test-session' })
const consume = (line: Record<string, unknown>) => consumeWorktrees(ctx(), line as SpoolLine)

type Wt = { name: string; path: string; branch: string }

/** A writer's worktree, made with git as worktree.sh makes one: `<root>/<runId>-<n>` on `litter/<run>-w<n>` at base. */
async function writerWorktree(n: number, run = RUN, wf = WF): Promise<Wt> {
  const name = `${wf}-${n}`
  const path = join(root, name)
  const branch = writerBranch(run, n)
  await git('worktree', 'add', '-q', '-b', branch, '--', path, base)
  return { name, path, branch }
}

let ts = 1_700_000_000
/** worktree.sh's spool line for one step. Each line gets its own second, as real steps would. */
function line(step: 'intent' | 'create' | 'setup_failed', wt: Wt, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, ev: 'worktree', ts: ts++, session_id: 'test-session', step, run: RUN, name: wt.name, path: wt.path, branch: wt.branch, base, disposable: false, ...extra }
}

/** A writer worktree as the ledger has it after worktree.sh's intent and create were drained. */
async function recordedWriter(n: number, opts: { run?: string; wf?: string; disposable?: boolean; ignored?: string[] } = {}): Promise<Wt> {
  const run = opts.run ?? RUN
  const wt = await writerWorktree(n, run, opts.wf ?? WF)
  for (const step of ['intent', 'create'] as const) {
    await consume({ ...line(step, wt, { run, disposable: opts.disposable ?? false }), ...(step === 'create' ? { ignored: opts.ignored ?? [] } : {}) })
  }
  return wt
}

/** A task.bind as the record tool leaves it (records/fanout.ts TaskBindBody). */
async function bind(agentId: string, task: string, wt: Wt, extra: Record<string, unknown> = {}): Promise<void> {
  await appendRecord(p, runDir, {
    run: RUN,
    kind: 'task.bind',
    by: { source: 'agent', agentId, agentType: 'litter:executor' },
    body: { task, worktree: { name: wt.name, path: wt.path, branch: wt.branch }, ...extra },
  })
}

async function commitIn(path: string, file: string, text: string): Promise<string> {
  mkdirSync(join(path, file, '..'), { recursive: true })
  writeFileSync(join(path, file), text)
  const run = (...argv: string[]) => p.run(['git', '-C', path, ...argv]).then(r => {
    if (r.code !== 0) throw new Error(`git ${argv.join(' ')}: ${r.stderr}`)
    return r.stdout
  })
  await run('add', '--', file)
  await run('commit', '-q', '-m', `change ${file}`)
  return (await run('rev-parse', 'HEAD')).trim()
}

const branchExists = async (branch: string) => (await p.run(['git', '-C', repo, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`])).code === 0

function integrationSpec(patch: Partial<ModWorktreeSpec> = {}): ModWorktreeSpec {
  const name = integrationName(RUN)
  return { run: RUN, name, path: join(root, name), branch: integrationBranch(RUN), base, disposable: false, runDir, checkout: repo, setup: null, linkDirs: [], ...patch }
}

const options = (patch: Record<string, unknown> = {}) => normalizeOptions(patch)

/** node-ports never fires a timer by itself: this fires every one, repeatedly, until `work` settles. */
function fireTimers(work: Promise<unknown>, startAfter: () => Promise<void>): void {
  let done = false
  void work.finally(() => (done = true))
  void (async () => {
    await startAfter()
    while (!done) {
      for (const fn of [...p.timers]) fn()
      await Bun.sleep(20)
    }
  })()
}

async function until(check: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(20)
  }
}

// ---------------------------------------------------------------------------

describe("consumeWorktrees: worktree.sh's steps into the ledger", () => {
  test('records each step once, by the mod, and the same lines drained twice change nothing', async () => {
    const wt = await writerWorktree(1)
    const intent = line('intent', wt)
    const create = line('create', wt, { ignored: ['deps'] })
    for (const l of [intent, create, intent, create]) await consume(l)
    const recs = (await records()).filter(r => r.kind.startsWith('worktree.'))
    expect(recs.map(r => r.kind)).toEqual(['worktree.intent', 'worktree.create'])
    expect(recs.every(r => r.by.source === 'mod')).toBe(true)
    expect(recs[1]!.body).toEqual({
      run: RUN,
      name: wt.name,
      path: wt.path,
      branch: wt.branch,
      base,
      disposable: false,
      spooled: { session_id: 'test-session', ts: create.ts },
      ignored: ['deps'],
    })
    expect(recordedWorktrees(await records())).toEqual([recs[1]!.body as never])
  })

  test('a failed setup is recorded with its log, and a later create is a new step', async () => {
    const wt = await writerWorktree(2)
    const log = setupLogPart(runDir, wt.name)
    await consume(line('intent', wt))
    await consume(line('setup_failed', wt, { exit_code: 3, timed_out: false, log }))
    expect(recordedWorktrees(await records())).toEqual([])
    await consume(line('setup_failed', wt, { exit_code: 3, timed_out: false, log }))
    await consume(line('create', wt, { ignored: [] }))
    expect(await kinds()).toEqual([
      `worktree.intent:${wt.name}`,
      `worktree.setup_failed:${wt.name}`,
      `worktree.setup_failed:${wt.name}`,
      `worktree.create:${wt.name}`,
    ])
    const failed = (await records()).find(r => r.kind === 'worktree.setup_failed')!
    expect(failed.body).toMatchObject({ exit_code: 3, timed_out: false, log })
    expect(recordedWorktrees(await records()).map(w => w.name)).toEqual([wt.name])
  })

  test('a create adds the resolved path to roots.worktrees, once', async () => {
    const wt = await writerWorktree(1)
    await consume(line('intent', wt))
    expect((await readPolicy(p, litterDir))!.run!.roots.worktrees).toEqual([])
    const create = line('create', wt)
    await consume(create)
    await consume(create)
    expect((await readPolicy(p, litterDir))!.run!.roots.worktrees).toEqual([wt.path])
  })

  test('a wrong path, branch, base, name, run or disposable flag is skipped with a log line', async () => {
    const wt = await writerWorktree(1)
    const cases: [Record<string, unknown>, string][] = [
      [{ path: join(repo, 'elsewhere', wt.name) }, `isn't ${root}/${wt.name}`],
      [{ branch: writerBranch(RUN, 2) }, `isn't ${wt.branch}`],
      [{ base: behind }, `isn't the run's ${base}`],
      [{ name: 'wf_ffffffff-000-1', path: join(root, 'wf_ffffffff-000-1') }, "isn't one of the run's workflow run ids"],
      [{ name: `${WF}-x`, path: join(root, `${WF}-x`) }, "isn't one of the run's workflow run ids"],
      [{ name: '../escape' }, "can't name a worktree folder"],
      [{ run: '20261002-nope' }, "there's no run 20261002-nope"],
      [{ disposable: true }, "'disposable' is true"],
      [{ step: 'toString' }, 'unknown step'],
    ]
    for (const [patch, why] of cases) {
      p.logs.length = 0
      await consume({ ...line('create', wt), ...patch })
      expect(p.logs.join('\n')).toContain(why)
    }
    await consume({ ...line('setup_failed', wt), exit_code: 1, log: '/tmp/elsewhere.log' })
    expect(p.logs.at(-1)).toContain("'log' isn't under")
    expect(await kinds()).toEqual([])
    expect((await readPolicy(p, litterDir))!.run!.roots.worktrees).toEqual([])
  })

  test("the run's root is kept with it, so a line drained after the policy moved on is still checked", async () => {
    const one = await writerWorktree(1)
    await consume(line('intent', one))
    expect(await worktreeRootFor(p, litterDir, RUN)).toBe(root)
    // The run ended: policy.json no longer names it, and its lines still drain.
    await writePolicy(p, litterDir, { ...policyFor(RUN, 'fanout', [WF]), run: null })
    await consume(line('create', one))
    await consume({ ...line('create', one), path: join(repo, 'other', one.name) })
    expect(await kinds()).toEqual([`worktree.intent:${one.name}`, `worktree.create:${one.name}`])
    expect(p.logs.join('\n')).toContain(`isn't ${root}/${one.name}`)
  })

  test('recordedWorktrees: the latest create per name, and only the mod\'s', async () => {
    const recs: StoredRecord[] = [
      { v: 1, seq: 1, kind: 'worktree.create', run: RUN, at: 0, by: MOD, prev: null, body: { run: RUN, name: 'a', path: '/w/a', branch: 'b1', base, disposable: false, ignored: ['x'] } },
      { v: 1, seq: 2, kind: 'worktree.create', run: RUN, at: 0, by: { source: 'launcher' }, prev: null, body: { run: RUN, name: 'b', path: '/w/b', branch: 'b2', base, disposable: false, ignored: [] } },
      { v: 1, seq: 3, kind: 'worktree.create', run: RUN, at: 0, by: MOD, prev: null, body: { run: RUN, name: 'a', path: '/w/a', branch: 'b1', base, disposable: false, ignored: ['y'] } },
    ]
    expect(recordedWorktrees(recs)).toEqual([{ run: RUN, name: 'a', path: '/w/a', branch: 'b1', base, disposable: false, ignored: ['y'] }])
  })
})

// ---------------------------------------------------------------------------

describe("addModWorktree: the mod's own worktrees", () => {
  test('a first request: the intent, the worktree at base (not origin/main) beside litter/<run>, then the create', async () => {
    const spec = integrationSpec()
    const r = await addModWorktree(p, options(), spec)
    expect(r).toEqual({ ok: true, path: spec.path, ignored: [] })
    expect(await kinds()).toEqual([`worktree.intent:${spec.name}`, `worktree.create:${spec.name}`])
    expect((await records()).at(-1)!.body).toEqual({ run: RUN, name: spec.name, path: spec.path, branch: spec.branch, base, disposable: false, ignored: [] })
    expect((await p.run(['git', '-C', spec.path, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(base)
    expect((await p.run(['git', '-C', spec.path, 'symbolic-ref', 'HEAD'])).stdout.trim()).toBe(`refs/heads/litter/${RUN}-integration`)
    // refs/heads/litter/<run> and refs/heads/litter/<run>-integration coexist.
    expect(await branchExists(`litter/${RUN}`)).toBe(true)
    expect(await branchExists(`litter/${RUN}-integration`)).toBe(true)
  })

  test('an unfinished request with only the branch made is finished without -b', async () => {
    const spec = integrationSpec()
    await appendRecord(p, runDir, { run: RUN, kind: 'worktree.intent', by: MOD, body: { run: RUN, name: spec.name, path: spec.path, branch: spec.branch, base, disposable: false } })
    await git('branch', spec.branch, base)
    const r = await addModWorktree(p, options(), spec)
    expect(r.ok).toBe(true)
    expect(await kinds()).toEqual([`worktree.intent:${spec.name}`, `worktree.create:${spec.name}`])
    expect((await p.run(['git', '-C', spec.path, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(base)
  })

  test('an unfinished request whose worktree was added but whose setup was killed keeps it and runs the setup again', async () => {
    const spec = integrationSpec({ setup: ['sh', '-c', 'mkdir -p deps && echo built > deps/x && echo setup-ran'] })
    await appendRecord(p, runDir, { run: RUN, kind: 'worktree.intent', by: MOD, body: { run: RUN, name: spec.name, path: spec.path, branch: spec.branch, base, disposable: false } })
    await git('worktree', 'add', '-q', '-b', spec.branch, '--', spec.path, base)
    // What the killed setup left: an ignored partial file, which a re-made worktree wouldn't have.
    mkdirSync(join(spec.path, 'deps'))
    writeFileSync(join(spec.path, 'deps', 'partial'), 'half')
    const r = await addModWorktree(p, options(), spec)
    expect(r).toEqual({ ok: true, path: spec.path, ignored: ['deps/'] })
    expect(existsSync(join(spec.path, 'deps', 'partial'))).toBe(true)
    expect(readFileSync(join(spec.path, 'deps', 'x'), 'utf8')).toBe('built\n')
    expect(readFileSync(setupLogPart(runDir, spec.name), 'utf8')).toContain('setup-ran')
    expect(await kinds()).toEqual([`worktree.intent:${spec.name}`, `worktree.create:${spec.name}`])
  })

  test('an unfinished request whose checkout was cut off part way is replaced', async () => {
    const spec = integrationSpec()
    await appendRecord(p, runDir, { run: RUN, kind: 'worktree.intent', by: MOD, body: { run: RUN, name: spec.name, path: spec.path, branch: spec.branch, base, disposable: false } })
    await git('worktree', 'add', '-q', '-b', spec.branch, '--', spec.path, base)
    rmSync(join(spec.path, 'src.ts'))
    const r = await addModWorktree(p, options(), spec)
    expect(r.ok).toBe(true)
    expect(readFileSync(join(spec.path, 'src.ts'), 'utf8')).toBe('export const a = 1\n')
    expect((await p.run(['git', '-C', spec.path, 'status', '--porcelain'])).stdout).toBe('')
  })

  test('a branch with commits past base blocks an unfinished request, recorded as a failure with the reason', async () => {
    const spec = integrationSpec()
    await appendRecord(p, runDir, { run: RUN, kind: 'worktree.intent', by: MOD, body: { run: RUN, name: spec.name, path: spec.path, branch: spec.branch, base, disposable: false } })
    const tree = (await git('rev-parse', `${base}^{tree}`)).trim()
    const ahead = (await git('commit-tree', tree, '-p', base, '-m', 'ahead')).trim()
    await git('update-ref', `refs/heads/${spec.branch}`, ahead)
    const r = await addModWorktree(p, options(), spec)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toContain(`${spec.branch} has 1 commit past ${base}`)
    expect(existsSync(spec.path)).toBe(false)
    const last = (await records()).at(-1)!
    expect(last.kind).toBe('worktree.setup_failed')
    expect(last.body).toMatchObject({ exit_code: null, timed_out: false, log: setupLogPart(runDir, spec.name) })
    expect(readFileSync(setupLogPart(runDir, spec.name), 'utf8')).toContain('1 commit past')
  })

  test("a path that exists but isn't the worktree is refused", async () => {
    const spec = integrationSpec()
    mkdirSync(spec.path, { recursive: true })
    writeFileSync(join(spec.path, 'mine.txt'), 'yours')
    const r = await addModWorktree(p, options(), spec)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("exists but isn't a worktree of this repository")
    expect(readFileSync(join(spec.path, 'mine.txt'), 'utf8')).toBe('yours')
    expect(await kinds()).toEqual([`worktree.intent:${spec.name}`, `worktree.setup_failed:${spec.name}`])
    expect(await branchExists(spec.branch)).toBe(false)
  })

  test('a replay reuses the worktree with its commit and uncommitted change intact', async () => {
    const spec = integrationSpec()
    expect((await addModWorktree(p, options(), spec)).ok).toBe(true)
    const commit = await commitIn(spec.path, 'merged.ts', 'x\n')
    writeFileSync(join(spec.path, 'wip.ts'), 'not yet\n')
    const r = await addModWorktree(p, options(), spec)
    expect(r).toEqual({ ok: true, path: spec.path, ignored: [] })
    expect((await p.run(['git', '-C', spec.path, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(commit)
    expect(readFileSync(join(spec.path, 'wip.ts'), 'utf8')).toBe('not yet\n')
    expect(await kinds()).toEqual([`worktree.intent:${spec.name}`, `worktree.create:${spec.name}`])
  })

  test('a replay refuses a worktree mid-merge, or one whose fork point is no longer base', async () => {
    const spec = integrationSpec()
    expect((await addModWorktree(p, options(), spec)).ok).toBe(true)
    const mergeHead = (await p.run(['git', '-C', spec.path, 'rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'])).stdout.trim()
    writeFileSync(mergeHead, `${base}\n`)
    let r = await addModWorktree(p, options(), spec)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('a merge is in progress')
    rmSync(mergeHead)
    await p.run(['git', '-C', spec.path, 'reset', '-q', '--hard', behind])
    r = await addModWorktree(p, options(), spec)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain(`${base} isn't an ancestor of its HEAD`)
  })

  test('a recorded worktree that is gone is re-added from its branch, intent first', async () => {
    const spec = integrationSpec()
    expect((await addModWorktree(p, options(), spec)).ok).toBe(true)
    const commit = await commitIn(spec.path, 'kept.ts', 'k\n')
    rmSync(spec.path, { recursive: true, force: true })
    const r = await addModWorktree(p, options(), spec)
    expect(r.ok).toBe(true)
    expect((await p.run(['git', '-C', spec.path, 'rev-parse', 'HEAD'])).stdout.trim()).toBe(commit)
    expect(await kinds()).toEqual([
      `worktree.intent:${spec.name}`,
      `worktree.create:${spec.name}`,
      `worktree.intent:${spec.name}`,
      `worktree.create:${spec.name}`,
    ])
  })

  test('setup: success records what it left ignored, failure and timeout are recorded and refused, and a retry finishes it', async () => {
    const failing = integrationSpec({ setup: ['sh', '-c', 'echo broken; exit 3'] })
    let r = await addModWorktree(p, options(), failing)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain("the setup command sh -c 'echo broken; exit 3' failed (exit 3)")
    let last = (await records()).at(-1)!
    expect(last.kind).toBe('worktree.setup_failed')
    expect(last.body).toMatchObject({ exit_code: 3, timed_out: false, log: setupLogPart(runDir, failing.name) })
    expect(readFileSync(setupLogPart(runDir, failing.name), 'utf8')).toBe('broken\n')

    // The next request retries it, and a setup past verifyTimeoutMs is killed.
    const slow = integrationSpec({ setup: ['sleep', '30'] })
    const work = addModWorktree(p, options({ verifyTimeoutMs: 1000 }), slow)
    fireTimers(work, () => until(() => p.timers.size > 0))
    r = await work
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('timed out')
    last = (await records()).at(-1)!
    expect(last.body).toMatchObject({ exit_code: null, timed_out: true })

    const good = integrationSpec({ setup: ['sh', '-c', 'mkdir -p deps && echo ok > deps/built'] })
    r = await addModWorktree(p, options(), good)
    expect(r).toEqual({ ok: true, path: good.path, ignored: ['deps/'] })
    expect(await kinds()).toEqual([
      `worktree.intent:${good.name}`,
      `worktree.setup_failed:${good.name}`,
      `worktree.setup_failed:${good.name}`,
      `worktree.create:${good.name}`,
    ])
  })

  test("linkDirs: linked from the checkout when ignored as a link, refused otherwise, and a link that's right is left alone", async () => {
    mkdirSync(join(repo, 'deps'))
    writeFileSync(join(repo, 'deps', 'lib.js'), 'lib')
    mkdirSync(join(repo, 'cache'))
    const linked = integrationSpec({ linkDirs: ['deps/'] })
    const r = await addModWorktree(p, options(), linked)
    expect(r).toEqual({ ok: true, path: linked.path, ignored: ['deps'] })
    expect(readlinkSync(join(linked.path, 'deps'))).toBe(join(repo, 'deps'))
    expect(readFileSync(join(linked.path, 'deps', 'lib.js'), 'utf8')).toBe('lib')

    for (const [dirs, why] of [
      [['cache'], "isn't ignored as a link"],
      [['../deps'], "no '.' or '..' part"],
      [['missing'], "isn't a folder in the checkout"],
    ] as const) {
      const name = `litter-${RUN}-${why.length}`
      const spec = integrationSpec({ name, path: join(root, name), branch: `litter/${RUN}-x${why.length}`, linkDirs: [...dirs] })
      const refused = await addModWorktree(p, options(), spec)
      expect(refused.ok).toBe(false)
      if (!refused.ok) expect(refused.reason).toContain(why)
    }
  })

  test('linkDirs on an unfinished request: a link already pointing at the checkout is left alone, one pointing elsewhere is replaced', async () => {
    mkdirSync(join(repo, 'deps'))
    const spec = integrationSpec({ linkDirs: ['deps'] })
    await appendRecord(p, runDir, { run: RUN, kind: 'worktree.intent', by: MOD, body: { run: RUN, name: spec.name, path: spec.path, branch: spec.branch, base, disposable: false } })
    await git('worktree', 'add', '-q', '-b', spec.branch, '--', spec.path, base)
    symlinkSync(join(repo, 'deps'), join(spec.path, 'deps'))
    const before = lstatSync(join(spec.path, 'deps')).ino
    expect((await addModWorktree(p, options(), spec)).ok).toBe(true)
    expect(lstatSync(join(spec.path, 'deps')).ino).toBe(before)

    const other = scratch()
    cleanups.push(other.cleanup)
    const name2 = `litter-${RUN}-two`
    const spec2 = integrationSpec({ name: name2, path: join(root, name2), branch: `litter/${RUN}-two`, linkDirs: ['deps'] })
    await appendRecord(p, runDir, { run: RUN, kind: 'worktree.intent', by: MOD, body: { run: RUN, name: name2, path: spec2.path, branch: spec2.branch, base, disposable: false } })
    await git('worktree', 'add', '-q', '-b', spec2.branch, '--', spec2.path, base)
    symlinkSync(other.dir, join(spec2.path, 'deps'))
    expect((await addModWorktree(p, options(), spec2)).ok).toBe(true)
    expect(readlinkSync(join(spec2.path, 'deps'))).toBe(join(repo, 'deps'))
  })

  test('a spec the mod would never build is refused before anything is recorded', async () => {
    for (const patch of [{ branch: '-delete' }, { path: 'relative/path' }, { base: 'HEAD' }, { name: '../x' }, { setup: [] as string[] }]) {
      const r = await addModWorktree(p, options(), integrationSpec(patch))
      expect(r.ok).toBe(false)
    }
    expect(await kinds()).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('worktree.json', () => {
  const read = () => JSON.parse(readFileSync(worktreePolicyPath(litterDir), 'utf8'))

  test('written from the merged settings, with no run active, and defaults for odd values', async () => {
    await writePolicy(p, litterDir, { ...policyFor(RUN, 'fanout', [WF]), run: null })
    p.settingsValue.worktree = { baseRef: 'head', symlinkDirectories: ['node_modules', 3, null, '.venv'] }
    await startWorktreePolicy(p, litterDir)
    expect(read()).toEqual({ v: 1, baseRef: 'head', symlinkDirectories: ['node_modules', '.venv'] })
    expect(worktreePolicyOf({})).toEqual({ v: 1, baseRef: 'fresh', symlinkDirectories: [] })
    expect(worktreePolicyOf({ worktree: 'head' })).toEqual({ v: 1, baseRef: 'fresh', symlinkDirectories: [] })
    expect(worktreePolicyOf({ worktree: { baseRef: 'HEAD', symlinkDirectories: 'node_modules' } })).toEqual({ v: 1, baseRef: 'fresh', symlinkDirectories: [] })
  })

  test('rewritten by the 30 s check when the settings change; a second start replaces the timer', async () => {
    await startWorktreePolicy(p, litterDir)
    expect(read()).toEqual({ v: 1, baseRef: 'fresh', symlinkDirectories: [] })
    expect(p.timers.size).toBe(1)
    p.settingsValue.worktree = { baseRef: 'head', symlinkDirectories: ['.venv'] }
    for (const fn of [...p.timers]) fn()
    await until(() => read().baseRef === 'head')
    expect(read()).toEqual({ v: 1, baseRef: 'head', symlinkDirectories: ['.venv'] })
    await startWorktreePolicy(p, litterDir)
    expect(p.timers.size).toBe(1)
  })
})

// ---------------------------------------------------------------------------

describe('cleanup after run.end', () => {
  type Outcome = { kind: string; name: string; path: string; branch: string; forced?: boolean; reason?: string; branch_kept?: string }
  const outcomes = async (run = RUN): Promise<Outcome[]> =>
    (await records(run)).filter(r => r.kind === 'worktree.removed' || r.kind === 'worktree.kept').map(r => ({ kind: r.kind, ...r.body }) as Outcome)

  test('an unchanged writer worktree is removed without --force, with its branch', async () => {
    const wt = await recordedWriter(1)
    await cleanupRun(p, { run: RUN, runDir, litterDir }, 'halted')
    expect(existsSync(wt.path)).toBe(false)
    expect(await branchExists(wt.branch)).toBe(false)
    expect(await outcomes()).toEqual([{ kind: 'worktree.removed', name: wt.name, path: wt.path, branch: wt.branch, forced: false }])
    expect(await branchExists(`litter/${RUN}`)).toBe(true)
  })

  test("a design's prober worktrees are discarded, an untracked scratch file and a lock included; one with a commit is kept", async () => {
    const DRUN = '20261002-design-d4e5f6'
    const DWF = 'wf_9f8e7d6c-543'
    await makeRun(DRUN, 'design', DWF)
    await writePolicy(p, litterDir, policyFor(DRUN, 'design', [DWF]))
    const scratchy = await recordedWriter(1, { run: DRUN, wf: DWF, disposable: true })
    writeFileSync(join(scratchy.path, 'fixture.txt'), 'scratch')
    const locked = await recordedWriter(2, { run: DRUN, wf: DWF, disposable: true })
    await git('worktree', 'lock', '--', locked.path)
    const committed = await recordedWriter(3, { run: DRUN, wf: DWF, disposable: true })
    await commitIn(committed.path, 'probe.ts', 'p\n')
    await cleanupRun(p, { run: DRUN, runDir: runDirOf(litterDir, DRUN), litterDir }, 'done')
    for (const wt of [scratchy, locked]) {
      expect(existsSync(wt.path)).toBe(false)
      expect(await branchExists(wt.branch)).toBe(false)
    }
    expect(existsSync(committed.path)).toBe(true)
    const got = await outcomes(DRUN)
    expect(got.filter(o => o.kind === 'worktree.removed').map(o => [o.name, o.forced])).toEqual([
      [scratchy.name, true],
      [locked.name, true],
    ])
    expect(got.find(o => o.name === committed.name)).toMatchObject({ kind: 'worktree.kept', reason: expect.stringContaining("which a prober can't make") })
  })

  test("a merged writer's worktree and the integration worktree of a landed run are removed; their commits stay on litter/<run>", async () => {
    const w1 = await recordedWriter(1)
    await bind('agent-1', 'T1', w1)
    const work = await commitIn(w1.path, 'a/one.ts', 'one\n')
    const integ = integrationSpec()
    expect((await addModWorktree(p, options(), integ)).ok).toBe(true)
    await p.run(['git', '-C', integ.path, 'merge', '-q', '--no-ff', '-m', 'litter: merge T1', '--', w1.branch])
    const tip = (await p.run(['git', '-C', integ.path, 'rev-parse', 'HEAD'])).stdout.trim()
    await appendRecord(p, runDir, { run: RUN, kind: 'integrate.merge', by: MOD, body: { task: 'T1', branch: w1.branch, commit: tip, paths: ['a/one.ts'] } })
    await git('update-ref', `refs/heads/litter/${RUN}`, tip, base)
    await appendRecord(p, runDir, { run: RUN, kind: 'land', by: { source: 'agent', agentId: 'relay-1', agentType: 'litter:relay' }, body: { gate: 'fanout', verify_id: 'v1', commit: tip, tree: '', old: base, ref: `refs/heads/litter/${RUN}` } })
    await cleanupRun(p, { run: RUN, runDir, litterDir }, 'done')
    expect(existsSync(w1.path)).toBe(false)
    expect(existsSync(integ.path)).toBe(false)
    expect(await branchExists(w1.branch)).toBe(false)
    expect(await branchExists(integ.branch)).toBe(false)
    expect((await p.run(['git', '-C', repo, 'merge-base', '--is-ancestor', work, `refs/heads/litter/${RUN}`])).code).toBe(0)
    expect((await outcomes()).map(o => [o.kind, o.name])).toEqual([
      ['worktree.removed', w1.name],
      ['worktree.removed', integ.name],
    ])
  })

  test("a changed writer's worktree that didn't land is kept and listed, and so is the integration worktree after a halt", async () => {
    const w1 = await recordedWriter(1)
    await bind('agent-1', 'T1', w1)
    await commitIn(w1.path, 'a/one.ts', 'one\n')
    const w2 = await recordedWriter(2)
    writeFileSync(join(w2.path, 'stray.ts'), 'unbound\n')
    const integ = integrationSpec()
    expect((await addModWorktree(p, options(), integ)).ok).toBe(true)
    await p.run(['git', '-C', integ.path, 'merge', '-q', '--no-ff', '-m', 'm', '--', w1.branch])
    await cleanupRun(p, { run: RUN, runDir, litterDir }, 'halted')
    for (const wt of [w1, w2, integ]) expect(existsSync(wt.path)).toBe(true)
    expect(await branchExists(w1.branch)).toBe(true)
    const got = await outcomes()
    expect(got.map(o => o.kind)).toEqual(['worktree.kept', 'worktree.kept', 'worktree.kept'])
    expect(got[0]!.reason).toBe(`task T1 didn't land (the run ended halted), and it holds 1 commit past base on ${w1.branch}`)
    expect(got[1]!.reason).toBe('no task was bound to it, and it holds uncommitted changes (stray.ts)')
    expect(got[2]!.reason).toContain('the run ended halted without landing')
    const summary = worktreeSummary(await records())
    expect(summary).toContain(`- Kept: ${w1.path} (branch ${w1.branch}): ${got[0]!.reason}`)
    expect(summary).toContain('- Removed: 0')
    // Cleaned up again with nothing changed, nothing new is recorded.
    await cleanupRun(p, { run: RUN, runDir, litterDir }, 'halted')
    expect(await outcomes()).toHaveLength(3)
  })

  test("an ignored path its setup didn't leave keeps a worktree; the setup's own ignored paths don't", async () => {
    const withEnv = await recordedWriter(1, { ignored: ['deps/'] })
    mkdirSync(join(withEnv.path, 'deps'))
    writeFileSync(join(withEnv.path, 'deps', 'x'), '')
    writeFileSync(join(withEnv.path, '.env'), 'SECRET=1\n')
    const setupOnly = await recordedWriter(2, { ignored: ['deps/'] })
    mkdirSync(join(setupOnly.path, 'deps', 'nested'), { recursive: true })
    writeFileSync(join(setupOnly.path, 'deps', 'nested', 'y'), '')
    await cleanupRun(p, { run: RUN, runDir, litterDir }, 'done')
    expect(readFileSync(join(withEnv.path, '.env'), 'utf8')).toBe('SECRET=1\n')
    expect(existsSync(setupOnly.path)).toBe(false)
    const got = await outcomes()
    expect(got[0]).toMatchObject({ kind: 'worktree.kept', name: withEnv.name, reason: expect.stringContaining("ignored paths its setup didn't leave (.env)") })
    expect(got[1]).toMatchObject({ kind: 'worktree.removed', name: setupOnly.name, forced: false })
  })

  test('a resumable end keeps everything', async () => {
    const wt = await recordedWriter(1)
    for (const status of ['interrupted', 'stopped', 'failed'] as RunStatus[]) {
      await cleanupRun(p, { run: RUN, runDir, litterDir }, status)
    }
    expect(existsSync(wt.path)).toBe(true)
    expect((await outcomes()).map(o => o.reason)).toEqual([
      "the run ended interrupted, which can be resumed, so it's kept until the run is resumed or discarded",
      "the run ended stopped, which can be resumed, so it's kept until the run is resumed or discarded",
      "the run ended failed, which can be resumed, so it's kept until the run is resumed or discarded",
    ])
  })

  test("never removes a worktree the session works in, and never deletes litter/<run>", async () => {
    // The run worktree under `isolate`: litter-<run> on litter/<run> itself.
    const name = `litter-${RUN}`
    const spec = integrationSpec({ name, path: join(root, name), branch: `litter/${RUN}` })
    expect((await addModWorktree(p, options(), spec)).ok).toBe(true)
    mkdirSync(join(spec.path, 'sub'))
    p.cwd = async () => join(spec.path, 'sub')
    await cleanupRun(p, { run: RUN, runDir, litterDir }, 'done')
    expect(existsSync(spec.path)).toBe(true)
    expect((await outcomes()).at(-1)).toMatchObject({ kind: 'worktree.kept', reason: "the session's working directory is inside it" })
  })

  test("the run worktree, once the session left it, is removed and its branch litter/<run> kept", async () => {
    const name = `litter-${RUN}`
    const spec = integrationSpec({ name, path: join(root, name), branch: `litter/${RUN}` })
    expect((await addModWorktree(p, options(), spec)).ok).toBe(true)
    await cleanupRun(p, { run: RUN, runDir, litterDir }, 'done')
    expect(existsSync(spec.path)).toBe(false)
    expect(await branchExists(`litter/${RUN}`)).toBe(true)
    expect((await outcomes()).at(-1)).toEqual({ kind: 'worktree.removed', name, path: spec.path, branch: `litter/${RUN}`, forced: false, branch_kept: "it's the run's own branch" })
  })

  test('leftovers at session.start: an ended run\'s worktrees still on disk get the same cleanup, and summary.md is written again', async () => {
    const wt = await recordedWriter(1)
    const changed = await recordedWriter(2)
    await commitIn(changed.path, 'b.ts', 'b\n')
    await appendRecord(p, runDir, { run: RUN, kind: 'run.end', by: MOD, body: { taskId: `task-${RUN}`, generation: 1, status: 'halted', reason: 'x', source: 'notification' } })
    // An open run's worktrees are left alone.
    const ORUN = '20261002-fanout-open01'
    const OWF = 'wf_0a0b0c0d-111'
    await makeRun(ORUN, 'fanout', OWF)
    await writePolicy(p, litterDir, policyFor(ORUN, 'fanout', [OWF]))
    const open = await recordedWriter(1, { run: ORUN, wf: OWF })
    await cleanupLeftovers(p, litterDir)
    expect(existsSync(wt.path)).toBe(false)
    expect(existsSync(changed.path)).toBe(true)
    expect(existsSync(open.path)).toBe(true)
    expect((await outcomes()).map(o => [o.kind, o.name])).toEqual([
      ['worktree.removed', wt.name],
      ['worktree.kept', changed.name],
    ])
    expect(await outcomes(ORUN)).toEqual([])
    const summary = readFileSync(summaryPath(runDir), 'utf8')
    expect(summary).toContain(`- Kept: ${changed.path} (branch ${changed.branch})`)
    expect(summary).toContain('- Removed: 1')
    // Nothing changed since: the next session.start records nothing.
    await cleanupLeftovers(p, litterDir)
    expect(await outcomes()).toHaveLength(2)
  })

  test("endRun cleans up before summary.md, which lists what's kept", async () => {
    const gone = await recordedWriter(1)
    const kept = await recordedWriter(2)
    await commitIn(kept.path, 'b.ts', 'b\n')
    await endRun(p, { run: RUN, runDir, litterDir }, { taskId: `task-${RUN}`, generation: 1, status: 'halted', reason: 'verifier failed T2', source: 'notification' })
    expect(existsSync(gone.path)).toBe(false)
    const summary = readFileSync(summaryPath(runDir), 'utf8')
    expect(summary).toContain('## Worktrees')
    expect(summary).toContain(`- Kept: ${kept.path} (branch ${kept.branch}): no task was bound to it, and it holds 1 commit past base on ${kept.branch}`)
    expect(summary).toContain('- Removed: 1')
  })

  test('worktreeSummary: nothing for a run without worktrees', () => {
    expect(worktreeSummary([])).toEqual([])
  })
})
