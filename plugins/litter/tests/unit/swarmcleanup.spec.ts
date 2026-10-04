// Tier 2: the cleanup of a launch's worktrees (hooks/swarm/end.ts's
// cleanupLaunch; WP-P, 15.4 "Cleanup removes only worktrees this launch
// created") against real git: an `existing` worktree is never removed, a
// created one is removed only when unchanged with nothing in use, and each
// kept one is recorded with why and listed in summary.md.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ListedAgent } from '../../hooks/ports'
import { launchSummaryPath, swarmNewWorktreeName, swarmOwnBranch, swarmOwnWorktreeName } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { appendLaunchRecord, newLaunchId, readLaunchLedger, type SwarmStartBody } from '../../hooks/records/swarm'
import { updateSession } from '../../hooks/session'
import { cleanupLaunch, resetEndForTests, writeSwarmSummary } from '../../hooks/swarm/end'
import * as state from '../../hooks/swarm/state'
import { addSwarmWorktree, type SwarmWorktreeSpec } from '../../hooks/swarm/worktrees'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// Real git in every test; a loaded machine takes seconds.
setDefaultTimeout(120_000)

const options = normalizeOptions(undefined)

let p: TestPorts
let dir: string
let litterDir: string
let root: string
let launch: string
let main: string
let cleanup: () => void
let git: (...argv: string[]) => Promise<string>

beforeEach(async () => {
  state.resetForTests()
  resetEndForTests()
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ cwd: dir })
  ;({ git } = await scratchRepo(p, dir))
  await p.fs.write(join(dir, '.gitignore'), '.env\n.claude/\nnode_modules\n')
  await git('add', '.gitignore')
  await git('commit', '-q', '-m', 'ignore')
  main = (await git('rev-parse', 'HEAD')).trim()
  litterDir = join(dir, '.claude', 'litter')
  root = join(realpathSync(dir), '.claude', 'worktrees')
  launch = await newLaunchId(p, litterDir, 'alpha')
  updateSession({ litterDir })
})

afterEach(() => {
  updateSession({ litterDir: null })
  state.resetForTests()
  cleanup()
})

const own = (n: number, over: Partial<SwarmWorktreeSpec> = {}): SwarmWorktreeSpec => ({
  swarm: 'alpha',
  launch,
  node: 'fixer',
  n,
  path: join(root, swarmOwnWorktreeName('alpha', 'fixer', n)),
  branch: swarmOwnBranch('alpha', 'fixer', n),
  from: main,
  repo: dir,
  setup: null,
  linkDirs: [],
  ...over,
})

async function make(spec: SwarmWorktreeSpec): Promise<string> {
  const made = await addSwarmWorktree(p, litterDir, options, spec)
  expect(made.ok).toBe(true)
  return spec.path
}

const records = async () => (await readLaunchLedger(p, litterDir, 'alpha', launch)).records
const bodies = async (kind: string) => (await records()).filter(r => r.kind === kind).map(r => r.body)
const branchExists = async (branch: string) => (await p.run(['git', '-C', dir, 'rev-parse', '-q', '--verify', `refs/heads/${branch}`])).code === 0

/** swarm.start as K records it, with `part-a` in an existing worktree. */
async function started(existing: string) {
  const body: SwarmStartBody = {
    swarm: 'alpha',
    launch,
    revision: 1,
    specHash: 'h',
    nonce: 'n',
    types: { 'part-a': 'litter:sw-alpha-part-a', fixer: 'litter:sw-alpha-fixer' },
    nodes: { 'part-a': { dir: existing, branch: 'refs/heads/feature/a', created: false } },
    authority: {},
    tips: {},
    owner: { ref: 'refs/litter-swarm/alpha', oid: 'a'.repeat(40), generation: 1 },
    sessionCwd: dir,
    worktreeRoot: root,
    commonDir: realpathSync(join(dir, '.git')),
    roots: { litterDir, litterCopies: [litterDir], ruleDirs: [] },
  }
  await appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.start', body)
}

describe('cleanupLaunch', () => {
  test('an unchanged worktree with only its setup’s ignored paths is removed, and its own branch with it', async () => {
    const wt = await make(own(1, { setup: ['sh', '-c', 'mkdir -p node_modules && echo x > node_modules/a'] }))
    expect((await bodies('swarm.worktree'))[0]!.ignored).toEqual(['node_modules/'])
    await cleanupLaunch(p, 'alpha', launch)
    expect(existsSync(wt)).toBe(false)
    expect(await bodies('swarm.worktree.removed')).toEqual([{ path: wt, branch: 'sw/alpha/fixer-1', branchDeleted: true }])
    expect(await branchExists('sw/alpha/fixer-1')).toBe(false)
    // Again: nothing more to do, nothing more recorded.
    await cleanupLaunch(p, 'alpha', launch)
    expect((await records()).filter(r => r.kind.startsWith('swarm.worktree.')).map(r => r.kind)).toEqual(['swarm.worktree.intent', 'swarm.worktree.removed'])
  })

  test('a created worktree holding an ignored .env its setup didn’t leave is kept, and listed with why', async () => {
    const wt = await make(own(1))
    await p.fs.write(join(wt, '.env'), 'TOKEN=secret\n')
    await cleanupLaunch(p, 'alpha', launch)
    expect(existsSync(join(wt, '.env'))).toBe(true)
    const [kept] = await bodies('swarm.worktree.kept')
    expect(kept).toEqual({ path: wt, branch: 'sw/alpha/fixer-1', reason: expect.stringContaining('.env') })
    expect(String(kept!.reason)).toContain("ignored paths its setup didn't leave")
    const summary = readFileSync(await writeSwarmSummary(p, 'alpha', launch), 'utf8')
    expect(summary).toContain(`- Kept: ${wt} (branch sw/alpha/fixer-1), fixer: it holds ignored paths`)
    // The same reason at the next cleanup isn't recorded twice; once the .env is gone, it's removed.
    await cleanupLaunch(p, 'alpha', launch)
    expect((await bodies('swarm.worktree.kept')).length).toBe(1)
    rmSync(join(wt, '.env'))
    await cleanupLaunch(p, 'alpha', launch)
    expect(existsSync(wt)).toBe(false)
    expect((await bodies('swarm.worktree.removed')).length).toBe(1)
  })

  test('one with a commit past `from` is kept, its branch too', async () => {
    const wt = await make(own(1))
    await p.fs.write(join(wt, 'work.txt'), 'work\n')
    await git('-C', wt, 'add', 'work.txt')
    await git('-C', wt, 'commit', '-q', '-m', 'work')
    await cleanupLaunch(p, 'alpha', launch)
    expect(existsSync(wt)).toBe(true)
    expect(await branchExists('sw/alpha/fixer-1')).toBe(true)
    expect((await bodies('swarm.worktree.kept'))[0]!.reason).toBe(`sw/alpha/fixer-1 has 1 commit past ${main.slice(0, 12)}`)
  })

  test('one with uncommitted changes is kept', async () => {
    const wt = await make(own(1))
    await p.fs.write(join(wt, 'README.md'), 'changed\n')
    await cleanupLaunch(p, 'alpha', launch)
    expect(existsSync(wt)).toBe(true)
    expect((await bodies('swarm.worktree.kept'))[0]!.reason).toBe('it holds uncommitted changes (README.md)')
  })

  test('an `existing` worktree is never removed, even unchanged with no commits, and is listed', async () => {
    // Where litter would make part-a's `new` worktree, so only the record says it isn't litter's.
    const existing = join(root, swarmNewWorktreeName('alpha', 'part-a'))
    await git('worktree', 'add', '-q', '-b', 'feature/a', '--', existing, main)
    await started(existing)
    await cleanupLaunch(p, 'alpha', launch)
    expect(existsSync(existing)).toBe(true)
    expect(await records()).toEqual([expect.objectContaining({ kind: 'swarm.start' })])

    // Even a swarm.worktree record naming it leaves it alone: swarm.start says Launch didn't make it.
    await appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.worktree', {
      node: 'part-a',
      path: existing,
      branch: 'feature/a',
      from: main,
      created_by: launch,
      ignored: [],
    })
    await cleanupLaunch(p, 'alpha', launch)
    expect(existsSync(existing)).toBe(true)
    expect(await branchExists('feature/a')).toBe(true)
    expect((await bodies('swarm.worktree.kept'))[0]!.reason).toBe("it's a node's existing worktree, which litter never removes")
  })

  test("while live, an existing worktree is listed from the spec in summary.md", async () => {
    const existing = join(dir, 'mine')
    await git('worktree', 'add', '-q', '-b', 'feature/a', '--', existing, main)
    state.putLiveSwarm({
      name: 'alpha',
      launch,
      revision: 1,
      spec: { name: 'alpha', goal: 'g', nodes: [{ id: 'part-a', kind: 'orchestrator', worktree: { existing } }] },
      nonce: 'n',
      types: { 'part-a': 'litter:sw-alpha-part-a' },
      typesReady: true,
      dirs: { 'part-a': { dir: realpathSync(existing), branch: 'refs/heads/feature/a', created: false } },
      sessionCwd: dir,
      worktreeRoot: root,
      commonDir: realpathSync(join(dir, '.git')),
      roots: { litterDir, litterCopies: [], ruleDirs: [] },
      tips: {},
      owner: { ref: 'refs/litter-swarm/alpha', oid: 'a'.repeat(40), generation: 1, session: 'test-session' },
      state: 'live',
      readOnly: false,
      lost: false,
      flags: { isolationLost: false },
      startedAt: 0,
    })
    await cleanupLaunch(p, 'alpha', launch)
    const summary = readFileSync(await writeSwarmSummary(p, 'alpha', launch), 'utf8')
    expect(summary).toContain(`- Kept: ${realpathSync(existing)} (branch feature/a), part-a: an existing worktree you named; litter never removes those`)
    expect(existsSync(existing)).toBe(true)
  })

  test("one still in use is kept: a node running there, or a list the session couldn't read", async () => {
    const wt = await make(own(1))
    state.putBinding({
      agentId: 'a-fix1',
      swarm: 'alpha',
      launch,
      node: 'fixer',
      n: 1,
      kind: 'worker',
      of: null,
      parent: null,
      type: 'litter:sw-alpha-fixer',
      cwd: realpathSync(wt),
      branch: 'refs/heads/sw/alpha/fixer-1',
      token: 't',
      revision: 1,
      generation: 1,
      boundAt: 0,
      adopted: false,
    })
    p.agents = [{ id: 'a-fix1', description: '', type: 'litter:sw-alpha-fixer', status: 'running' } satisfies ListedAgent]
    await cleanupLaunch(p, 'alpha', launch)
    expect(existsSync(wt)).toBe(true)
    expect((await bodies('swarm.worktree.kept'))[0]!.reason).toBe("it's still in use: a-fix1 is still running there")

    p.listAgents = async () => {
      throw new Error('no list')
    }
    await cleanupLaunch(p, 'alpha', launch)
    expect(existsSync(wt)).toBe(true)
    expect((await bodies('swarm.worktree.kept'))[1]!.reason).toContain("couldn't list the session's agents")
  })

  test('one a node the list shows `waiting` (2.1.289) works in is kept, parked after its turn too, until it completes', async () => {
    const wt = await make(own(1))
    state.putBinding({
      agentId: 'a-fix1',
      swarm: 'alpha',
      launch,
      node: 'fixer',
      n: 1,
      kind: 'worker',
      of: null,
      parent: null,
      type: 'litter:sw-alpha-fixer',
      cwd: realpathSync(wt),
      branch: 'refs/heads/sw/alpha/fixer-1',
      token: 't',
      revision: 1,
      generation: 1,
      boundAt: 0,
      adopted: false,
    })
    // Its turn ended (turn.complete, SubagentStop) on a child or background work that will wake it.
    state.markSettling('a-fix1')
    state.noteAgentStopped('a-fix1')
    p.agents = [{ id: 'a-fix1', description: '', type: 'litter:sw-alpha-fixer', status: 'waiting' } satisfies ListedAgent]
    await cleanupLaunch(p, 'alpha', launch)
    expect(existsSync(wt)).toBe(true)
    expect((await bodies('swarm.worktree.kept'))[0]!.reason).toBe("it's still in use: a-fix1 is held there, waiting on a child or background work")

    p.agents[0]!.status = 'completed'
    await cleanupLaunch(p, 'alpha', launch)
    expect(existsSync(wt)).toBe(false)
    expect(await bodies('swarm.worktree.removed')).toEqual([{ path: wt, branch: 'sw/alpha/fixer-1', branchDeleted: true }])
  })

  test("a `new` worktree you named is removed when unchanged, but its branch is yours and kept", async () => {
    const path = join(root, swarmNewWorktreeName('alpha', 'part-a'))
    const wt = await make({ ...own(1), n: undefined, node: 'part-a', path, branch: 'feature/part-a', from: 'main' })
    await cleanupLaunch(p, 'alpha', launch)
    expect(existsSync(wt)).toBe(false)
    expect(await bodies('swarm.worktree.removed')).toEqual([{ path: wt, branch: 'feature/part-a', branchDeleted: false }])
    expect(await branchExists('feature/part-a')).toBe(true)
  })

  test('after swarm.end, a cleanup that changes an outcome writes summary.md again', async () => {
    const wt = await make(own(1))
    await p.fs.write(join(wt, '.env'), 'x\n')
    await cleanupLaunch(p, 'alpha', launch)
    await appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.end', {
      status: 'ended',
      settled: true,
      nodes: {},
      worktrees: [{ path: wt, branch: 'sw/alpha/fixer-1', node: 'fixer', removed: false, reason: 'kept' }],
      branches: ['sw/alpha/fixer-1'],
    })
    await writeSwarmSummary(p, 'alpha', launch)
    expect(readFileSync(launchSummaryPath(litterDir, 'alpha', launch), 'utf8')).toContain(`- Kept: ${wt}`)
    rmSync(join(wt, '.env'))
    await cleanupLaunch(p, 'alpha', launch)
    const summary = readFileSync(launchSummaryPath(litterDir, 'alpha', launch), 'utf8')
    expect(summary).toContain(`- Removed: ${wt} (branch sw/alpha/fixer-1), fixer`)
    expect(summary).not.toContain(`- Kept: ${wt}`)
  })

  test('a failed launch: K cleans up fresh worktrees with no live swarm at all', async () => {
    const a = await make(own(1))
    const b = await make(own(2))
    await cleanupLaunch(p, 'alpha', launch)
    expect([existsSync(a), existsSync(b)]).toEqual([false, false])
    expect((await bodies('swarm.worktree.removed')).map(x => x.path)).toEqual([a, b])
  })
})
