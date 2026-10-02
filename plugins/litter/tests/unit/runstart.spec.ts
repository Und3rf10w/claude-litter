// Tier 2: run.start against real git in scratch repos (plan section 9,
// "Launch preconditions"): each refusal, in order, writing nothing and
// releasing the lock; the fenced transaction; a refusal after it rolled back
// and recorded; isolate, design, plan, fanout and continuations.

import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordCtx, RecordInput } from '../../hooks/records/core'
import type { RunJson, RunStartReply } from '../../hooks/records/run'
import { recordRunStart, getPending, endRun, runState } from '../../hooks/lifecycle'
import { acquireLock, readLock, releaseLock, stopLease } from '../../hooks/lock'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { activePath, leasePath, modePath, planPath, policyPath, runDir, runJsonPath, RUN_ID } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { readPolicy } from '../../hooks/policy'
import { sha256 } from '../../hooks/fsx'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

const SYMREF = (() => {
  const m = /git version ([0-9]+)\.([0-9]+)/.exec(Bun.spawnSync(['git', 'version']).stdout.toString())
  return m ? Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 46) : false
})()

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

type World = {
  p: TestPorts
  dir: string
  litterDir: string
  git: (...argv: string[]) => Promise<string>
  ctx: RecordCtx
  /** Where p.run without a cwd runs: the session's working directory. */
  cwd: { dir: string }
  jq: { ok: boolean }
  /** Returns replacement text for the nth read of a path, or null to read the file. */
  onRead: ((path: string, n: number) => string | null) | null
}

const cleanups: (() => void)[] = []

async function world(options: Record<string, unknown> = { verify: ['true'] }): Promise<World> {
  const s = scratch()
  cleanups.push(s.cleanup)
  const dir = realpathSync(s.dir)
  const base = nodePorts({ sessionId: 'session-a' })
  const cwd = { dir }
  const jq = { ok: true }
  const reads = new Map<string, number>()
  const w = { dir, cwd, jq, onRead: null } as unknown as World
  const p: TestPorts = {
    ...base,
    fs: {
      ...base.fs,
      read: async path => {
        const n = (reads.get(path) ?? 0) + 1
        reads.set(path, n)
        const replaced = w.onRead?.(path, n) ?? null
        return replaced ?? base.fs.read(path)
      },
    },
    run: (argv, init) => {
      if (argv[0] === 'jq') {
        return jq.ok ? Promise.resolve({ code: 0, stdout: 'jq-1.7.1\n', stderr: '', truncated: false }) : Promise.reject(new Error('jq: not found'))
      }
      return base.run(argv, init?.cwd ? init : { ...init, cwd: cwd.dir })
    },
  }
  const { git } = await scratchRepo(p, dir)
  await p.fs.write(join(dir, 'plan.md'), PLAN)
  await git('add', 'plan.md')
  await git('commit', '-q', '-m', 'plan')
  const litterDir = join(dir, '.claude', 'litter')
  await p.fs.write(modePath(litterDir), 'default\n')
  w.p = p
  w.litterDir = litterDir
  w.git = git
  w.ctx = { p, caller: { agentId: null, agentType: null }, litterDir, options: normalizeOptions(options) }
  return w
}

afterEach(() => {
  stopLease()
  for (const c of cleanups.splice(0)) c()
})

const AUTH = { authorized: ['change a.txt and b.txt'] }
const execute = (w: World, extra: Record<string, unknown> = {}) =>
  recordRunStart(w.ctx, { kind: 'run.start', workflow: 'execute', planPath: 'plan.md', ...AUTH, ...extra } as RecordInput)

function okReply(r: unknown): RunStartReply {
  if (!(r as { ok: boolean }).ok) throw new Error(`run.start refused: ${JSON.stringify(r)}`)
  return r as RunStartReply
}

const runsIn = (w: World) => (existsSync(w.litterDir) ? readdirSync(w.litterDir).filter(n => RUN_ID.test(n)) : [])
const headRef = async (w: World) => (await w.git('symbolic-ref', '-q', 'HEAD').catch(() => 'detached')).trim()
const litterRefs = async (w: World) => (await w.git('for-each-ref', '--format=%(refname)', 'refs/heads/litter', 'refs/litter')).trim()

/** A refusal before step 3: no lock, no run folder, no branch, HEAD where it was, no pending launch. */
async function nothingWritten(w: World, head = 'refs/heads/main') {
  expect(await readLock(w.p, w.dir)).toBeNull()
  expect(runsIn(w)).toEqual([])
  expect(await litterRefs(w)).toBe('')
  expect(await headRef(w)).toBe(head)
  expect(await getPending(w.p, w.litterDir)).toBeNull()
  expect(existsSync(policyPath(w.litterDir))).toBe(false)
  expect(existsSync(activePath(w.litterDir))).toBe(false)
}

describe('run.start: success', () => {
  test('an execute run: the branch, HEAD switched in the fenced transaction, the run files, the policy, the args', async () => {
    const w = await world()
    const before = (await w.git('rev-parse', 'HEAD')).trim()
    const r = okReply(await execute(w, { runRules: ['keep the public API'] }))
    expect(r.run).toMatch(/^[0-9]{8}-execute-[0-9a-f]{6}$/)
    const rd = runDir(w.litterDir, r.run)
    expect(r.runDir).toBe(rd)
    expect(r.checkout).toBe(w.dir)

    // Step 3: the branch at base, HEAD on it, the lock held for this run.
    expect(await headRef(w)).toBe(`refs/heads/litter/${r.run}`)
    expect((await w.git('rev-parse', `refs/heads/litter/${r.run}`)).trim()).toBe(before)
    const lock = await readLock(w.p, w.dir)
    expect(lock?.blob).toEqual(expect.objectContaining({ run: r.run, session: 'session-a' }))
    expect(existsSync(leasePath(w.litterDir, lock!.oid))).toBe(true)

    // Step 4: run.json, plan.md, the ledger, the policy and `active`.
    const jsonText = await w.p.fs.read(runJsonPath(rd))
    const json = JSON.parse(jsonText) as RunJson
    expect(json).toEqual(
      expect.objectContaining({
        v: 1,
        run: r.run,
        workflow: 'execute',
        base: before,
        ref: `refs/heads/litter/${r.run}`,
        checkout: w.dir,
        isolate: false,
        previousBranch: 'refs/heads/main',
        verify: ['true'],
        mode: 'default',
        session: 'session-a',
        planSha256: await sha256(PLAN),
      }),
    )
    expect(await w.p.fs.read(planPath(rd))).toBe(PLAN)
    const ledger = await readLedger(w.p, rd, r.run)
    expect(ledger.records.map(x => x.kind)).toEqual(['run.start'])
    expect(ledger.records[0]!.by).toEqual({ source: 'launcher' })
    const st = runState(ledger.records)
    expect(st.start?.runJsonSha256).toBe(await sha256(jsonText))
    expect(st.start?.argsSha256).toBe(await sha256(JSON.stringify(r.args)))
    expect(st.start?.oid).toBe(lock!.oid)
    const policy = await readPolicy(w.p, w.litterDir)
    expect(policy?.run).toEqual(expect.objectContaining({ run: r.run, workflow: 'execute', runDir: rd, checkout: w.dir, launching: false, runIds: [] }))
    expect(existsSync(activePath(w.litterDir))).toBe(true)
    expect(await getPending(w.p, w.litterDir)).toEqual(expect.objectContaining({ run: r.run, oid: lock!.oid, session: 'session-a', workflow: 'execute' }))

    // Step 5: the args.
    expect(r.args).toEqual(
      expect.objectContaining({
        run: r.run,
        authorized: 'change a.txt and b.txt',
        rules: ['For this run (stated by you): keep the public API'],
        verifyCommand: 'true',
        planPath: planPath(rd),
        maxAttempts: 3,
        adversary: false,
      }),
    )
    expect(typeof r.args.nonce).toBe('string')
    const gates = r.args.gates as Record<string, unknown>[]
    expect(gates.map(g => g.id)).toEqual(['G1', 'G2'])
    expect(gates[0]).toEqual(
      expect.objectContaining({ files: ['a.txt'], checks: ['test -f a.txt'], done_when: 'a.txt exists', lines: '3-7', rules: [] }),
    )
    expect(r.args.goalCheck).toBeUndefined()
  })

  test("the record tool's own fields are ignored, an unknown one is refused", async () => {
    const w = await world()
    const bad = await execute(w, { bogus: 1 })
    expect(bad).toEqual(expect.objectContaining({ ok: false, field: 'bogus' }))
    await nothingWritten(w)
    okReply(await execute(w, { tool: 'mcp__litter__record', tool_use_id: 'tu1', agentId: null, consent: 'yes', run: 'ignored' }))
  })

  test('from a detached HEAD, HEAD moves to the branch and previousBranch is null', async () => {
    const w = await world()
    await w.git('checkout', '-q', '--detach')
    const r = okReply(await execute(w))
    expect(await headRef(w)).toBe(`refs/heads/litter/${r.run}`)
    expect((JSON.parse(await w.p.fs.read(runJsonPath(r.runDir))) as RunJson).previousBranch).toBeNull()
  })

  test('a verify argv other than the configured one runs only once you approve it', async () => {
    const w = await world()
    const refused = await execute(w, { verify: ['make', 'test'] })
    expect(refused).toEqual(expect.objectContaining({ ok: false, field: 'verify' }))
    expect(w.p.asked[0]?.question).toContain('make test')
    await nothingWritten(w)
    w.p.answers.push('Refuse')
    expect(await execute(w, { verify: ['make', 'test'] })).toEqual(expect.objectContaining({ ok: false, field: 'verify' }))
    await nothingWritten(w)
    w.p.answers.push('Approve')
    const r = okReply(await execute(w, { verify: ['make', 'test'] }))
    expect(r.args.verifyCommand).toBe('make test')
  })
})

describe('run.start: refusals in order, each writing nothing', () => {
  test('caller, mode, jq, checkout, lock, clean tree, gates, verify', async () => {
    const w = await world({})
    // A live run holds the lock.
    const holder = '20261002-execute-holder'
    const hd = runDir(w.litterDir, holder)
    await appendRecord(w.p, hd, { run: holder, kind: 'run.start', by: { source: 'launcher' }, body: { workflow: 'execute' } })
    await appendRecord(w.p, hd, {
      run: holder,
      kind: 'run.launch',
      by: { source: 'mod' },
      body: { taskId: 'tk', runId: 'wf_holder1', scriptPath: null, generation: 1, session: 'other', oid: '' },
    })
    const held = await acquireLock(w.p, w.dir, { run: holder, session: 'other', acquiredAt: 0 })
    if (!held.ok) throw new Error(held.reason)
    writeFileSync(join(w.dir, 'README.md'), 'dirty\n')
    await w.p.fs.write(join(w.dir, 'nogates.md'), '# Prose only\n')
    await w.git('add', 'nogates.md')
    await w.git('commit', '-q', '-m', 'prose')
    writeFileSync(join(w.dir, 'README.md'), 'dirty\n')
    const ours = () => runsIn(w).filter(r => r !== holder)
    const refused = async (input: Record<string, unknown>, expected: Record<string, unknown>, text: string) => {
      const r = await execute(w, input)
      expect(r).toEqual(expect.objectContaining({ ok: false, ...expected }))
      expect((r as { error: string }).error).toContain(text)
      expect(ours()).toEqual([])
      expect(await headRef(w)).toBe('refs/heads/main')
      expect(await litterRefs(w)).toBe('')
    }

    // 1. A litter agent can't start a run.
    w.ctx.caller = { agentId: 'agent-1', agentType: 'litter:executor' }
    await refused({ planPath: 'nogates.md' }, { field: 'kind' }, "launcher's")
    w.ctx.caller = { agentId: null, agentType: null }

    // 2. The mode: not recorded, then a refused one.
    await w.p.fs.write(modePath(w.litterDir), '')
    await refused({ planPath: 'nogates.md' }, { field: 'mode' }, "isn't recorded")
    await w.p.fs.write(modePath(w.litterDir), 'acceptEdits\n')
    await refused({ planPath: 'nogates.md' }, { field: 'mode' }, 'acceptEdits mode')
    await w.p.fs.write(modePath(w.litterDir), 'bypassPermissions\n')
    await refused({ planPath: 'nogates.md' }, { field: 'mode' }, 'bypassPermissions mode')
    await w.p.fs.write(modePath(w.litterDir), 'auto\n')

    // 3. jq.
    w.jq.ok = false
    await refused({ planPath: 'nogates.md' }, { field: 'jq' }, 'jq')
    w.jq.ok = true

    // 4. The session's checkout must be this repository's.
    const elsewhere = scratch()
    cleanups.push(elsewhere.cleanup)
    await scratchRepo(w.p, elsewhere.dir)
    w.cwd.dir = elsewhere.dir
    await refused({ planPath: 'nogates.md' }, {}, "isn't in the repository")
    w.cwd.dir = w.dir

    // 5. The lock: a live run holds it, and keeps it.
    await refused({ planPath: 'nogates.md' }, {}, `run ${holder} is active`)
    expect((await readLock(w.p, w.dir))?.oid).toBe(held.oid)
    expect(await releaseLock(w.p, w.dir, held.oid)).toBe(true)

    // 6. The clean tree.
    await refused({ planPath: 'nogates.md' }, { field: 'checkout' }, 'uncommitted changes (README.md)')
    expect(await readLock(w.p, w.dir)).toBeNull()
    await w.git('checkout', '-q', '--', 'README.md')

    // 7. The gates.
    await refused({ planPath: 'nogates.md' }, { field: 'planPath' }, 'no gate sections')
    await refused({ planPath: 'missing.md' }, { field: 'planPath' }, "can't read the plan")

    // 8. A verify command.
    await refused({}, { field: 'verify' }, 'no verify command')
    expect(await readLock(w.p, w.dir)).toBeNull()

    w.ctx.options = normalizeOptions({ verify: ['true'] })
    okReply(await execute(w))
  })

  test('no litter directory', async () => {
    const w = await world()
    w.ctx.litterDir = null
    expect(await execute(w)).toEqual(expect.objectContaining({ ok: false }))
    await nothingWritten(w)
  })

  test('an untracked file is uncommitted work', async () => {
    const w = await world()
    writeFileSync(join(w.dir, 'new.txt'), 'x\n')
    expect(await execute(w)).toEqual(expect.objectContaining({ ok: false, field: 'checkout' }))
    await nothingWritten(w)
  })

  test('an edit hidden by assume-unchanged is still uncommitted work', async () => {
    const w = await world()
    await w.git('update-index', '--assume-unchanged', 'README.md')
    writeFileSync(join(w.dir, 'README.md'), 'hidden edit\n')
    expect((await w.git('status', '--porcelain', '--', 'README.md')).trim()).toBe('')
    const r = await execute(w)
    expect(r).toEqual(expect.objectContaining({ ok: false, field: 'checkout' }))
    expect((r as { error: string }).error).toContain('README.md')
    await nothingWritten(w)
  })

  test('a submodule with uncommitted work is refused', async () => {
    const w = await world()
    const sub = scratch()
    cleanups.push(sub.cleanup)
    await scratchRepo(w.p, sub.dir)
    await w.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.dir, 'sub')
    await w.git('commit', '-q', '-m', 'sub')
    writeFileSync(join(w.dir, 'sub', 'README.md'), 'changed inside\n')
    const r = await execute(w)
    expect(r).toEqual(expect.objectContaining({ ok: false, field: 'dirty_submodules' }))
    expect((r as { error: string }).error).toContain('sub')
    await nothingWritten(w)
  })

  test('unmerged index entries are refused', async () => {
    const w = await world()
    await w.git('checkout', '-q', '-b', 'side')
    writeFileSync(join(w.dir, 'README.md'), 'side\n')
    await w.git('commit', '-q', '-am', 'side')
    await w.git('checkout', '-q', 'main')
    writeFileSync(join(w.dir, 'README.md'), 'main\n')
    await w.git('commit', '-q', '-am', 'main')
    await w.git('merge', '-q', 'side').catch(() => '')
    const r = await execute(w)
    expect(r).toEqual(expect.objectContaining({ ok: false, field: 'checkout' }))
    expect((r as { error: string }).error).toContain('unmerged entries (README.md)')
    await nothingWritten(w)
  })

  test("a gate missing a field is refused, naming it", async () => {
    const w = await world()
    await w.p.fs.write(join(w.dir, 'bad.md'), '### G1: A\nFiles: a.txt\nDone when: x\n')
    await w.git('add', 'bad.md')
    await w.git('commit', '-q', '-m', 'bad')
    const r = await execute(w, { planPath: 'bad.md' })
    expect(r).toEqual(expect.objectContaining({ ok: false, field: 'Checks' }))
    await nothingWritten(w)
  })

  test('the plan changed after its parse, before the transaction: refused, nothing written', async () => {
    const w = await world()
    const plan = join(w.dir, 'plan.md')
    w.onRead = (path, n) => (path === plan && n === 2 ? `${PLAN}\nedited\n` : null)
    const r = await execute(w)
    expect((r as { error: string }).error).toContain('changed while the launch was being checked')
    await nothingWritten(w)
  })
})

describe('run.start: the fenced transaction', () => {
  test('a lock taken over before step 3 creates nothing and leaves HEAD', async () => {
    const w = await world()
    let other = ''
    w.p.ask = async () => {
      // Another session recovers the lock while you're asked about the verify argv.
      const mine = await readLock(w.p, w.dir)
      await releaseLock(w.p, w.dir, mine!.oid)
      const theirs = await acquireLock(w.p, w.dir, { run: '20261002-execute-thief0', session: 'other', acquiredAt: 1 })
      if (!theirs.ok) throw new Error(theirs.reason)
      other = theirs.oid
      return 'Approve'
    }
    const r = await execute(w, { verify: ['make'] })
    expect((r as { error: string }).error).toContain('taken over')
    expect(runsIn(w)).toEqual([])
    expect(await litterRefs(w)).toBe('')
    expect(await headRef(w)).toBe('refs/heads/main')
    expect((await readLock(w.p, w.dir))?.oid).toBe(other)
  })

  test.skipIf(!SYMREF)('a HEAD moved before step 3 fails the transaction: no branch, HEAD where you moved it', async () => {
    const w = await world()
    w.p.ask = async () => {
      await w.git('checkout', '-q', '-b', 'moved')
      return 'Approve'
    }
    const r = await execute(w, { verify: ['make'] })
    expect((r as { error: string }).error).toContain("couldn't create")
    expect(runsIn(w)).toEqual([])
    expect(await litterRefs(w)).toBe('')
    expect(await headRef(w)).toBe('refs/heads/moved')
    expect(await readLock(w.p, w.dir)).toBeNull()
  })

  test('the plan changed between its parse and its copy: launch_failed, HEAD back, the branch gone, the lock released', async () => {
    const w = await world()
    const plan = join(w.dir, 'plan.md')
    w.onRead = (path, n) => (path === plan && n === 3 ? `${PLAN}\nedited\n` : null)
    const r = await execute(w)
    expect((r as { error: string }).error).toContain('changed between its parse and its copy')
    const [run] = runsIn(w)
    expect(run).toBeDefined()
    const ledger = await readLedger(w.p, runDir(w.litterDir, run!), run!)
    expect(ledger.records.map(x => x.kind)).toEqual(['run.start', 'run.end'])
    expect(ledger.records[1]!.body).toEqual(expect.objectContaining({ generation: 0, status: 'launch_failed', taskId: null }))
    expect(await headRef(w)).toBe('refs/heads/main')
    expect(await litterRefs(w)).toBe('')
    expect(await readLock(w.p, w.dir)).toBeNull()
    expect(await getPending(w.p, w.litterDir)).toBeNull()
    expect(existsSync(join(runDir(w.litterDir, run!), 'summary.md'))).toBe(true)
  })

  test('from a detached HEAD, a rollback detaches HEAD at base again', async () => {
    const w = await world()
    await w.git('checkout', '-q', '--detach')
    const base = (await w.git('rev-parse', 'HEAD')).trim()
    const plan = join(w.dir, 'plan.md')
    w.onRead = (path, n) => (path === plan && n === 3 ? 'edited' : null)
    expect((await execute(w)).ok).toBe(false)
    expect(await headRef(w)).toBe('detached')
    expect((await w.git('rev-parse', 'HEAD')).trim()).toBe(base)
    expect(await litterRefs(w)).toBe('')
  })
})

describe('run.start: isolate, design, plan, fanout', () => {
  test('isolate makes the run worktree on the branch, and leaves your checkout where it was', async () => {
    const w = await world()
    const r = okReply(await execute(w, { isolate: true }))
    const wt = join(w.dir, '.claude', 'worktrees', `litter-${r.run}`)
    expect(r.checkout).toBe(wt)
    expect(await headRef(w)).toBe('refs/heads/main')
    expect((await w.p.run(['git', '-C', wt, 'symbolic-ref', 'HEAD'])).stdout.trim()).toBe(`refs/heads/litter/${r.run}`)
    const kinds = (await readLedger(w.p, r.runDir, r.run)).records.map(x => x.kind)
    expect(kinds).toEqual(['run.start', 'worktree.intent', 'worktree.create'])
    expect((JSON.parse(await w.p.fs.read(runJsonPath(r.runDir))) as RunJson).checkout).toBe(wt)
  })

  test('isolate with a failing setup: setup_failed, launch_failed, the worktree and branch removed', async () => {
    const w = await world({ verify: ['true'], setup: ['false'] })
    const r = await execute(w, { isolate: true })
    expect((r as { error: string }).error).toContain('setup command false failed')
    const [run] = runsIn(w)
    const kinds = (await readLedger(w.p, runDir(w.litterDir, run!), run!)).records.map(x => x.kind)
    expect(kinds).toEqual(['run.start', 'worktree.intent', 'worktree.setup_failed', 'run.end'])
    expect(existsSync(join(w.dir, '.claude', 'worktrees', `litter-${run}`))).toBe(false)
    expect(await litterRefs(w)).toBe('')
    expect(await readLock(w.p, w.dir)).toBeNull()
  })

  test("a design run's base is a snapshot of the checkout, uncommitted work included; HEAD stays", async () => {
    const w = await world({})
    writeFileSync(join(w.dir, 'README.md'), 'work in progress\n')
    const r = okReply(
      await recordRunStart(w.ctx, {
        kind: 'run.start',
        workflow: 'design',
        ...AUTH,
        goal: 'design the retry',
        deliverable: 'plan',
        bar: [{ id: 'C1', text: 'retries once', evidence: 'a test' }, { id: 'B1', text: 'no sleep', evidence: 'grep', reason: 'flaky' }],
      }),
    )
    const ref = `refs/litter/${r.run}/base`
    const base = (await w.git('rev-parse', ref)).trim()
    expect(r.args.base).toBe(base)
    expect((await w.git('show', `${base}:README.md`))).toBe('work in progress\n')
    expect(await headRef(w)).toBe('refs/heads/main')
    expect(await w.p.fs.read(join(r.runDir, 'bar.md'))).toContain('**B1** no sleep')
    expect(r.args).toEqual(expect.objectContaining({ goal: 'design the retry', deliverable: 'plan', maxRounds: 4 }))
    expect((r.args.lenses as { role: string }[]).map(l => l.role)).toEqual(['falsifier', 'coverage', 'mechanism'])
    const json = JSON.parse(await w.p.fs.read(runJsonPath(r.runDir))) as RunJson
    expect(json).toEqual(expect.objectContaining({ ref, base, verify: null, workflow: 'design' }))
  })

  test('a plan run carries the goal and the configured commands as text', async () => {
    const w = await world({ verify: ['uv', 'run', 'pytest', '-q'], goalCheck: ['make', 'e2e'] })
    const r = okReply(await recordRunStart(w.ctx, { kind: 'run.start', workflow: 'plan', ...AUTH, goal: 'add a retry' }))
    expect(r.args).toEqual(expect.objectContaining({ goal: 'add a retry', verifyCommand: 'uv run pytest -q', goalCheckCommand: 'make e2e' }))
    expect(r.args.plan).toBeUndefined()
    expect((await w.git('for-each-ref', '--format=%(refname)', 'refs/litter')).trim()).toBe(`refs/litter/${r.run}/base`)
  })

  test('a fanout binds each writer, keeps the merge order, and refuses tasks that share files', async () => {
    const w = await world()
    const tasks = [
      { id: 'a', title: 'A', text: 'do a', files: ['a.txt'] },
      { id: 'b', title: 'B', text: 'do b', files: ['b/'] },
      { id: 'r', title: 'R', text: 'read only', writes: false },
    ]
    const shared = await recordRunStart(w.ctx, {
      kind: 'run.start',
      workflow: 'fanout',
      ...AUTH,
      tasks: [...tasks, { id: 'c', title: 'C', text: 'do c', files: ['b/x.txt'] }],
    })
    expect(shared).toEqual(expect.objectContaining({ ok: false, field: 'tasks' }))
    expect((shared as { error: string }).error).toContain("'b' and 'c' both own")
    await nothingWritten(w)

    const r = okReply(await recordRunStart(w.ctx, { kind: 'run.start', workflow: 'fanout', ...AUTH, tasks, contract: 'one function each' }))
    const out = r.args.tasks as { id: string; bind?: string; writes: boolean }[]
    expect(out.map(t => [t.id, t.writes, typeof t.bind])).toEqual([
      ['a', true, 'string'],
      ['b', true, 'string'],
      ['r', false, 'undefined'],
    ])
    expect(r.args.mergeOrder).toEqual(['a', 'b'])
    expect(r.args.contract).toBe('one function each')
    expect(await headRef(w)).toBe(`refs/heads/litter/${r.run}`)
  })
})

describe('run.start: continuations', () => {
  /** A finished execute run whose G1 landed. */
  async function landedG1(w: World): Promise<string> {
    const first = okReply(await execute(w))
    await appendRecord(w.p, first.runDir, { run: first.run, kind: 'land', by: { source: 'mod' }, body: { gate: 'G1', commit: 'c0ffee' } })
    await endRun(w.p, { run: first.run, runDir: first.runDir, litterDir: w.litterDir }, {
      taskId: null,
      generation: 0,
      status: 'launch_failed',
      reason: 'test',
      source: 'mod',
    })
    expect(await readLock(w.p, w.dir)).toBeNull()
    return first.run
  }

  test('a continuation runs the gates left, on the same branch, with no new branch', async () => {
    const w = await world()
    const first = await landedG1(w)
    const r = okReply(await execute(w, { planPath: undefined, continueOf: first }))
    expect((r.args.gates as { id: string }[]).map(g => g.id)).toEqual(['G2'])
    expect(r.args.landed).toEqual([{ id: 'G1', commit: 'c0ffee' }])
    expect(r.args.continueOf).toBe(first)
    expect(await headRef(w)).toBe(`refs/heads/litter/${first}`)
    expect(await litterRefs(w)).toBe(`refs/heads/litter/${first}`)
    const json = JSON.parse(await w.p.fs.read(runJsonPath(r.runDir))) as RunJson
    expect(json.ref).toBe(`refs/heads/litter/${first}`)
  })

  test('a continuation with no gates left is refused, writing nothing', async () => {
    const w = await world()
    const first = await landedG1(w)
    await appendRecord(w.p, runDir(w.litterDir, first), { run: first, kind: 'land', by: { source: 'mod' }, body: { gate: 'G2', commit: 'beef' } })
    const r = await execute(w, { planPath: undefined, continueOf: first })
    expect(r).toEqual(expect.objectContaining({ ok: false, field: 'continueOf' }))
    expect((r as { error: string }).error).toContain('nothing left to continue')
    expect(runsIn(w)).toEqual([first])
    expect(await readLock(w.p, w.dir)).toBeNull()
  })

  test("a continuation from a checkout that isn't on the run's branch is refused", async () => {
    const w = await world()
    const first = await landedG1(w)
    await w.git('checkout', '-q', 'main')
    const r = await execute(w, { planPath: undefined, continueOf: first })
    expect((r as { error: string }).error).toContain("isn't checked out here")
    expect(runsIn(w)).toEqual([first])
  })
})
