// Tier 2: the swarm's own worktrees (hooks/swarm/worktrees.ts; WP-C §9),
// against real git: a `new` and an `own` worktree made intent-first and
// recorded in the launch ledger, a replay, an interrupted add finished, the
// checks that refuse, a failed setup, and inspectWorktree's facts.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeOptions } from '../../hooks/options'
import { appendLaunchRecord, newLaunchId, readLaunchLedger } from '../../hooks/records/swarm'
import { swarmNewWorktreeName, swarmOwnBranch, swarmOwnWorktreeName } from '../../hooks/layout'
import { addSwarmWorktree, inspectWorktree, type SwarmWorktreeSpec } from '../../hooks/swarm/worktrees'
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
  p = nodePorts()
  ;({ dir, cleanup } = scratch())
  ;({ git } = await scratchRepo(p, dir))
  await p.fs.write(join(dir, '.gitignore'), '.env\n.claude/\nnode_modules\n')
  await git('add', '.gitignore')
  await git('commit', '-q', '-m', 'ignore')
  main = (await git('rev-parse', 'HEAD')).trim()
  litterDir = join(dir, '.claude', 'litter')
  // The module's own root for this litter directory: the primary checkout's, resolved.
  root = join(realpathSync(dir), '.claude', 'worktrees')
  launch = await newLaunchId(p, litterDir, 'alpha')
})
afterEach(() => cleanup())

const newSpec = (over: Partial<SwarmWorktreeSpec> = {}): SwarmWorktreeSpec => ({
  swarm: 'alpha',
  launch,
  node: 'part-a',
  path: join(root, swarmNewWorktreeName('alpha', 'part-a')),
  branch: 'feature/part-a',
  from: 'main',
  repo: dir,
  setup: null,
  linkDirs: [],
  ...over,
})

const ownSpec = (n: number, over: Partial<SwarmWorktreeSpec> = {}): SwarmWorktreeSpec => ({
  ...newSpec(),
  node: 'fixer',
  n,
  path: join(root, swarmOwnWorktreeName('alpha', 'fixer', n)),
  branch: swarmOwnBranch('alpha', 'fixer', n),
  from: main,
  ...over,
})

const records = async () => (await readLaunchLedger(p, litterDir, 'alpha', launch)).records
const kinds = async () => (await records()).map(r => r.kind)
const branchAt = async (path: string) => (await git('-C', path, 'symbolic-ref', '-q', 'HEAD')).trim()

describe('addSwarmWorktree', () => {
  test('a `new` worktree: intent, then made, recorded with its launch and the commit it came from', async () => {
    const spec = newSpec()
    const made = await addSwarmWorktree(p, litterDir, options, spec)
    expect(made).toEqual(expect.objectContaining({ ok: true, branch: 'feature/part-a', from: main, ignored: [] }))
    expect(existsSync(join(spec.path, 'README.md'))).toBe(true)
    expect(await branchAt(spec.path)).toBe('refs/heads/feature/part-a')
    const rs = await records()
    expect(rs.map(r => r.kind)).toEqual(['swarm.worktree.intent', 'swarm.worktree'])
    expect(rs[0]!.body).toEqual({ node: 'part-a', path: spec.path, branch: 'feature/part-a', from: main })
    expect(rs[1]!.body).toEqual({ node: 'part-a', path: spec.path, branch: 'feature/part-a', from: main, created_by: launch, ignored: [] })
  })

  test('an `own` worktree carries its instance number', async () => {
    const spec = ownSpec(2)
    const made = await addSwarmWorktree(p, litterDir, options, spec)
    expect(made.ok).toBe(true)
    expect(await branchAt(spec.path)).toBe('refs/heads/sw/alpha/fixer-2')
    const rs = await records()
    expect(rs.map(r => [r.kind, r.body.n])).toEqual([
      ['swarm.worktree.intent', 2],
      ['swarm.worktree', 2],
    ])
  })

  test('a replay of a made worktree reuses it and records nothing more', async () => {
    expect((await addSwarmWorktree(p, litterDir, options, newSpec())).ok).toBe(true)
    const again = await addSwarmWorktree(p, litterDir, options, newSpec())
    expect(again.ok).toBe(true)
    expect(await kinds()).toEqual(['swarm.worktree.intent', 'swarm.worktree'])
  })

  test('an interrupted add (an intent, no worktree) is finished on replay, without a second intent', async () => {
    const spec = newSpec()
    await appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.worktree.intent', { node: 'part-a', path: spec.path, branch: spec.branch, from: main })
    const made = await addSwarmWorktree(p, litterDir, options, spec)
    expect(made.ok).toBe(true)
    expect(await kinds()).toEqual(['swarm.worktree.intent', 'swarm.worktree'])
  })

  test('an add cut off after git made the worktree is finished on replay, not failed on its existing branch', async () => {
    const spec = newSpec()
    await appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.worktree.intent', { node: 'part-a', path: spec.path, branch: spec.branch, from: main })
    await git('worktree', 'add', '-q', '-b', spec.branch, '--', spec.path, main)
    const made = await addSwarmWorktree(p, litterDir, options, spec)
    expect(made.ok).toBe(true)
    expect(await kinds()).toEqual(['swarm.worktree.intent', 'swarm.worktree'])
  })

  test('a replay that names another commit than the records is refused with the facts', async () => {
    expect((await addSwarmWorktree(p, litterDir, options, newSpec())).ok).toBe(true)
    await p.fs.write(join(dir, 'later.txt'), 'x\n')
    await git('add', 'later.txt')
    await git('commit', '-q', '-m', 'later')
    const r = await addSwarmWorktree(p, litterDir, options, newSpec())
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain('the launch ledger records it')
  })

  test("a path that is not <the litter directory's worktree root>/<its name> is refused, and nothing is made or recorded", async () => {
    const unresolved = join(dir, '.claude', 'worktrees', 'sw-alpha-part-a')
    const paths = [join(dir, 'elsewhere', 'sw-alpha-part-a'), join(root, 'sw-alpha-other'), join(root, 'sub', 'sw-alpha-part-a')]
    // On a machine whose temp folder is a link, the unresolved spelling isn't the root either.
    if (unresolved !== newSpec().path) paths.push(unresolved)
    for (const path of paths) {
      const r = await addSwarmWorktree(p, litterDir, options, newSpec({ path }))
      expect({ path, ok: r.ok }).toEqual({ path, ok: false })
      expect(!r.ok && r.reason).toContain(`isn't ${root}/sw-alpha-part-a`)
      expect(existsSync(path)).toBe(false)
    }
    expect(await records()).toEqual([])
  })

  test('a branch git refuses, and a `from` that names no commit, are refused before git adds anything, recording nothing', async () => {
    const bad = await addSwarmWorktree(p, litterDir, options, newSpec({ branch: 'feature/.hidden' }))
    expect(!bad.ok && bad.reason).toContain("git won't take 'feature/.hidden'")
    const dots = await addSwarmWorktree(p, litterDir, options, newSpec({ branch: 'a..b' }))
    expect(dots.ok).toBe(false)
    const from = await addSwarmWorktree(p, litterDir, options, newSpec({ from: 'no-such-ref' }))
    expect(!from.ok && from.reason).toContain("'no-such-ref' doesn't name a commit")
    const opt = await addSwarmWorktree(p, litterDir, options, newSpec({ from: '--all' }))
    expect(opt.ok).toBe(false)
    expect(existsSync(newSpec().path)).toBe(false)
    expect(await records()).toEqual([])
  })

  test('after a refused check, the next attempt records its intent and makes the worktree', async () => {
    expect((await addSwarmWorktree(p, litterDir, options, newSpec({ from: 'no-such-ref' }))).ok).toBe(false)
    const made = await addSwarmWorktree(p, litterDir, options, newSpec())
    expect(made.ok).toBe(true)
    expect(await kinds()).toEqual(['swarm.worktree.intent', 'swarm.worktree'])
  })

  test('a check that fails on an open intent is its outcome, and the next attempt records a fresh intent', async () => {
    const spec = newSpec()
    await appendLaunchRecord(p, litterDir, 'alpha', launch, 'swarm.worktree.intent', { node: 'part-a', path: spec.path, branch: spec.branch, from: main })
    const r = await addSwarmWorktree(p, litterDir, options, newSpec({ from: 'no-such-ref' }))
    expect(r.ok).toBe(false)
    expect((await records()).map(x => [x.kind, x.body.step])).toEqual([
      ['swarm.worktree.intent', undefined],
      ['swarm.worktree.failed', 'check'],
    ])
    expect((await addSwarmWorktree(p, litterDir, options, spec)).ok).toBe(true)
    expect(await kinds()).toEqual(['swarm.worktree.intent', 'swarm.worktree.failed', 'swarm.worktree.intent', 'swarm.worktree'])
  })

  test('a retry after a failed setup records its own intent', async () => {
    expect((await addSwarmWorktree(p, litterDir, options, newSpec({ setup: ['sh', '-c', 'exit 3'] }))).ok).toBe(false)
    await git('worktree', 'remove', '--force', '--', newSpec().path)
    await git('branch', '-D', 'feature/part-a')
    expect((await addSwarmWorktree(p, litterDir, options, newSpec())).ok).toBe(true)
    expect(await kinds()).toEqual(['swarm.worktree.intent', 'swarm.worktree.failed', 'swarm.worktree.intent', 'swarm.worktree'])
  })

  test('a spec naming no launch folder, or a bad name, is refused and records nothing', async () => {
    const r1 = await addSwarmWorktree(p, litterDir, options, newSpec({ launch: '20990101-000000' }))
    expect(!r1.ok && r1.reason).toContain("doesn't exist")
    const r2 = await addSwarmWorktree(p, litterDir, options, newSpec({ node: 'Bad Node' }))
    expect(!r2.ok && r2.reason).toContain("'node' isn't a node id")
    expect(await records()).toEqual([])
  })

  test('a failed setup records swarm.worktree.failed with its step and log', async () => {
    const r = await addSwarmWorktree(p, litterDir, options, newSpec({ setup: ['sh', '-c', 'echo setting up; exit 3'] }))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain('failed (exit 3)')
    const failed = (await records()).at(-1)!
    expect(failed.kind).toBe('swarm.worktree.failed')
    expect(failed.body.step).toBe('setup')
    expect(readFileSync(String(failed.body.log), 'utf8')).toContain('setting up')
  })

  test("a setup's ignored leftovers are recorded, so cleanup can tell them from a node's", async () => {
    const r = await addSwarmWorktree(p, litterDir, options, newSpec({ setup: ['sh', '-c', 'mkdir -p node_modules && echo x > node_modules/a'] }))
    expect(r).toEqual(expect.objectContaining({ ok: true, ignored: ['node_modules/'] }))
    expect((await records()).at(-1)!.body.ignored).toEqual(['node_modules/'])
  })

  test('two concurrent adds of one path make it once', async () => {
    const [a, b] = await Promise.all([addSwarmWorktree(p, litterDir, options, newSpec()), addSwarmWorktree(p, litterDir, options, newSpec())])
    expect(a.ok && b.ok).toBe(true)
    expect(await kinds()).toEqual(['swarm.worktree.intent', 'swarm.worktree'])
  })
})

describe('inspectWorktree', () => {
  test('an unchanged worktree: listed, no commits past from, no changes, nothing new ignored', async () => {
    const spec = newSpec()
    await addSwarmWorktree(p, litterDir, options, spec)
    expect(await inspectWorktree(p, dir, spec.path, spec.branch, main, [])).toEqual({
      listed: true,
      checkedOut: 'refs/heads/feature/part-a',
      commitsPast: 0,
      changes: [],
      newIgnored: [],
    })
  })

  test('a committed one counts its commits', async () => {
    const spec = newSpec()
    await addSwarmWorktree(p, litterDir, options, spec)
    writeFileSync(join(spec.path, 'work.txt'), 'done\n')
    await git('-C', spec.path, 'add', 'work.txt')
    await git('-C', spec.path, 'commit', '-q', '-m', 'work')
    const facts = await inspectWorktree(p, dir, spec.path, spec.branch, main, [])
    expect(facts.commitsPast).toBe(1)
    expect(facts.changes).toEqual([])
  })

  test('a dirtied one lists its changes, and an ignored file its setup did not leave', async () => {
    const spec = newSpec()
    await addSwarmWorktree(p, litterDir, options, spec)
    writeFileSync(join(spec.path, 'README.md'), 'edited\n')
    writeFileSync(join(spec.path, 'new.txt'), 'new\n')
    writeFileSync(join(spec.path, '.env'), 'SECRET=1\n')
    const facts = await inspectWorktree(p, dir, spec.path, spec.branch, main, [])
    expect(facts.changes?.sort()).toEqual(['README.md', 'new.txt'])
    expect(facts.newIgnored).toEqual(['.env'])
    expect((await inspectWorktree(p, dir, spec.path, spec.branch, main, ['.env'])).newIgnored).toEqual([])
  })

  test('a removed one is not listed, and its changes are unknown', async () => {
    const spec = newSpec()
    await addSwarmWorktree(p, litterDir, options, spec)
    await git('worktree', 'remove', '--', spec.path)
    expect(await inspectWorktree(p, dir, spec.path, spec.branch, main, [])).toEqual({
      listed: false,
      checkedOut: null,
      commitsPast: 0,
      changes: null,
      newIgnored: null,
    })
  })
})
