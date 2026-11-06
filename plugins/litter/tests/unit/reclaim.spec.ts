// Tier 2: the reclaim of ended workers' `own` worktrees while their swarm
// runs (hooks/swarm/reclaim.ts) against real git: a worker's worktree goes
// once its instance has ended for the grace, with nothing uncommitted and its
// branch unchanged or merged into its parent's; the branch stays, the removal
// is recorded with its reason, and a send or a resume of the instance is
// refused from then on, also after a recovery reads the ledger again.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { ListedAgent } from '../../hooks/ports'
import type { LiveSwarm, NodeBinding } from '../../hooks/swarm/types'
import { swarmOwnBranch, swarmOwnWorktreeName } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { newLaunchId, readLaunchLedger } from '../../hooks/records/swarm'
import { updateSession } from '../../hooks/session'
import { resetEndForTests } from '../../hooks/swarm/end'
import { readLaunchFacts } from '../../hooks/swarm/recover'
import { reclaimNow, RECLAIM_GRACE_MS, resetReclaimForTests, scheduleReclaim } from '../../hooks/swarm/reclaim'
import { resetForTests as resetAdmitForTests, resumeSpawn, sendFromBrowser } from '../../hooks/swarm/admit'
import * as state from '../../hooks/swarm/state'
import { addSwarmWorktree, keptIgnored, removedForms, type SwarmWorktreeSpec } from '../../hooks/swarm/worktrees'
import { nodePorts, runAfters, scratch, scratchRepo, type TestPorts } from './support/node-ports'

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
  resetAdmitForTests()
  resetEndForTests()
  resetReclaimForTests()
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ cwd: dir })
  p.clock.now = 1_000_000
  ;({ git } = await scratchRepo(p, dir))
  await p.fs.write(join(dir, '.gitignore'), '.env\n.claude/\nnode_modules\n')
  await git('add', '.gitignore')
  await git('commit', '-q', '-m', 'ignore')
  await git('branch', 'feature/a')
  main = (await git('rev-parse', 'HEAD')).trim()
  litterDir = join(dir, '.claude', 'litter')
  root = join(realpathSync(dir), '.claude', 'worktrees')
  launch = await newLaunchId(p, litterDir, 'alpha')
  updateSession({ litterDir })
  state.putLiveSwarm(live())
  state.putBinding(bound('a-lead', { node: 'lead-a', n: 1, kind: 'orchestrator', parent: null, cwd: realpathSync(dir), branch: 'refs/heads/feature/a', type: 'litter:sw-alpha-lead-a' }))
})

afterEach(() => {
  resetReclaimForTests()
  updateSession({ litterDir: null })
  state.resetForTests()
  cleanup()
})

function live(over: Partial<LiveSwarm> = {}): LiveSwarm {
  return {
    name: 'alpha',
    launch,
    revision: 1,
    spec: {
      name: 'alpha',
      goal: 'g',
      nodes: [
        { id: 'lead-a', kind: 'orchestrator', spawns: { fixer: 2 } },
        { id: 'fixer', kind: 'worker', worktree: 'own' },
      ],
    },
    nonce: 'n',
    types: { 'lead-a': 'litter:sw-alpha-lead-a', fixer: 'litter:sw-alpha-fixer' },
    typesReady: true,
    dirs: {},
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
    ...over,
  }
}

function bound(agentId: string, over: Partial<NodeBinding> = {}): NodeBinding {
  return {
    agentId,
    swarm: 'alpha',
    launch,
    node: 'fixer',
    n: 1,
    kind: 'worker',
    of: null,
    parent: 'a-lead',
    type: 'litter:sw-alpha-fixer',
    cwd: '',
    branch: null,
    token: 't',
    revision: 1,
    generation: 1,
    boundAt: 0,
    adopted: false,
    ...over,
  }
}

const own = (n: number): SwarmWorktreeSpec => ({
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
})

/** Worker fixer #n's worktree, and its instance bound there: ended, as the list shows it. */
async function worker(n = 1, status: ListedAgent['status'] = 'completed'): Promise<string> {
  const spec = own(n)
  const made = await addSwarmWorktree(p, litterDir, options, spec)
  expect(made.ok).toBe(true)
  const id = `a-fix${n}`
  state.putBinding(bound(id, { n, cwd: realpathSync(spec.path), branch: `refs/heads/${spec.branch}` }))
  p.agents = [...p.agents.filter(a => a.id !== id), { id, description: '', type: 'litter:sw-alpha-fixer', status } satisfies ListedAgent]
  return spec.path
}

async function commitIn(wt: string, file = 'work.txt'): Promise<string> {
  await p.fs.write(join(wt, file), `${file}\n`)
  await git('-C', wt, 'add', file)
  await git('-C', wt, 'commit', '-q', '-m', file)
  return (await git('-C', wt, 'rev-parse', 'HEAD')).trim()
}

/** A pass that sees it ended, the grace, and the pass that may remove it. */
async function twoPasses(): Promise<void> {
  await reclaimNow(p)
  p.clock.now! += RECLAIM_GRACE_MS
  await reclaimNow(p)
}

const removed = async () => (await readLaunchLedger(p, litterDir, 'alpha', launch)).records.filter(r => r.kind === 'swarm.worktree.removed').map(r => r.body)
const branchAt = async (branch: string) => (await git('rev-parse', `refs/heads/${branch}`)).trim()

describe('reclaim', () => {
  test("an ended worker's unchanged worktree goes after the grace, its branch stays, and its sends and resumes are refused", async () => {
    const wt = await worker()
    await reclaimNow(p)
    expect(existsSync(wt)).toBe(true)
    p.clock.now! += RECLAIM_GRACE_MS - 1
    await reclaimNow(p)
    expect(existsSync(wt)).toBe(true)
    p.clock.now! += 1
    await reclaimNow(p)
    expect(existsSync(wt)).toBe(false)
    expect(await branchAt('sw/alpha/fixer-1')).toBe(main)
    expect(await removed()).toEqual([{ path: wt, branch: 'sw/alpha/fixer-1', branchDeleted: false, reason: 'ended-unchanged' }])

    const sent = await sendFromBrowser(p, { swarm: 'alpha', node: 'fixer#1', text: 'one more thing', route: 'direct' })
    expect(sent).toEqual({ kind: 'refused', reason: expect.stringContaining(`its worktree ${realpathSync(root)}/sw-alpha-fixer-1 was removed`) })
    expect(sent.kind === 'refused' && sent.reason).toContain('spawn a new fixer instead')
    const resumed = await resumeSpawn(p, { resume: { agentId: 'a-fix1' }, subagentType: 'litter:sw-alpha-fixer' } as never, (async () => ({})) as never)
    expect(resumed).toEqual({ deny: expect.stringContaining("so it can't run again") })
  })

  test('the settle poll schedules a pass; a swarm with no `own` workers schedules none', async () => {
    scheduleReclaim(p)
    expect(p.afters.filter(a => a.state === 'pending')).toHaveLength(1)
    scheduleReclaim(p)
    expect(p.afters.filter(a => a.state === 'pending')).toHaveLength(1)
    await runAfters(p, { all: true })
    resetReclaimForTests()
    state.patchLiveSwarm('alpha', { spec: { name: 'alpha', goal: 'g', nodes: [{ id: 'lead-a', kind: 'orchestrator' }] } })
    scheduleReclaim(p)
    expect(p.afters.filter(a => a.state === 'pending')).toHaveLength(0)
  })

  test("one with commits stays until its parent's branch holds them, then goes as merged", async () => {
    const wt = await worker()
    const tip = await commitIn(wt)
    await twoPasses()
    expect(existsSync(wt)).toBe(true)
    expect(await removed()).toEqual([])
    // The parent merges it.
    await git('update-ref', 'refs/heads/feature/a', tip)
    await reclaimNow(p)
    expect(existsSync(wt)).toBe(false)
    expect(await branchAt('sw/alpha/fixer-1')).toBe(tip)
    expect(await removed()).toEqual([{ path: wt, branch: 'sw/alpha/fixer-1', branchDeleted: false, reason: 'ended-merged', mergedInto: 'feature/a' }])
  })

  test('uncommitted or untracked work keeps it, and an ignored .env does; ignored dependencies don’t', async () => {
    const changed = await worker(1)
    await p.fs.write(join(changed, 'README.md'), 'changed\n')
    const untracked = await worker(2)
    await p.fs.write(join(untracked, 'notes.txt'), 'mine\n')
    const secret = await worker(3)
    await p.fs.write(join(secret, '.env'), 'TOKEN=secret\n')
    const deps = await worker(4)
    await p.fs.write(join(deps, 'node_modules', 'pkg', 'index.js'), 'x\n')
    await twoPasses()
    expect([changed, untracked, secret].map(existsSync)).toEqual([true, true, true])
    expect(existsSync(deps)).toBe(false)
    expect((await removed()).map(b => b.path)).toEqual([deps])
  })

  test('a running, waiting or reserved instance, or one with a child running there, keeps its worktree', async () => {
    const running = await worker(1, 'running')
    const waiting = await worker(2, 'waiting')
    const resuming = await worker(3)
    state.reserve({ key: 'resume:a-fix3', swarm: 'alpha', node: 'fixer', parent: 'a-lead', kind: 'worker', n: 3, scope: null, at: 0, agentId: 'a-fix3' })
    const child = await worker(4)
    state.putBinding(bound('a-child', { kind: 'child', n: 0, of: 'a-fix4', parent: 'a-fix4', cwd: realpathSync(child) }))
    state.markRunning('a-child')
    p.agents.push({ id: 'a-child', description: '', type: 'general-purpose', status: 'running' } satisfies ListedAgent)
    await twoPasses()
    expect([running, waiting, resuming, child].map(existsSync)).toEqual([true, true, true, true])
    expect(await removed()).toEqual([])
  })

  test('git refusing the removal (a locked worktree) leaves it, and its instance may run again', async () => {
    const wt = await worker()
    await git('worktree', 'lock', '--', wt)
    await twoPasses()
    expect(existsSync(wt)).toBe(true)
    expect(await removed()).toEqual([])
    expect(state.retiredDir('alpha', realpathSync(wt))).toBeNull()
    expect(p.logs.some(l => l.includes("wasn't removed"))).toBe(true)
  })

  test('an ended worker whose worktree was removed outside litter is refused too, with nothing recorded', async () => {
    const wt = await worker()
    await git('worktree', 'remove', '--', wt)
    await twoPasses()
    expect(await removed()).toEqual([])
    const resumed = await resumeSpawn(p, { resume: { agentId: 'a-fix1' }, subagentType: 'litter:sw-alpha-fixer' } as never, (async () => ({})) as never)
    expect(resumed).toEqual({ deny: expect.stringContaining('spawn a new fixer instead') })
  })

  test('a stopping swarm is left to the cleanup at its end', async () => {
    const wt = await worker()
    state.patchLiveSwarm('alpha', { state: 'stopping' })
    await twoPasses()
    expect(existsSync(wt)).toBe(true)
  })

  test("the launch facts recovery reads name the removed worktrees, and retiring their forms covers a binding's cwd in one", async () => {
    const wt = await worker()
    await twoPasses()
    expect(existsSync(wt)).toBe(false)
    const facts = await readLaunchFacts(p, litterDir, 'alpha', launch)
    expect(facts.removed).toEqual([wt])
    state.resetForTests()
    state.putLiveSwarm(live())
    state.putBinding(bound('a-fix1', { cwd: join(wt, 'src') }))
    for (const path of facts.removed) state.retire('alpha', ...(await removedForms(p, path)))
    expect(state.retiredDir('alpha', state.binding('a-fix1')!.cwd)).toBe(wt)
  })

  test('removedForms resolves the folder a removed worktree was in', async () => {
    const unresolved = join(dir, '.claude', 'worktrees', 'gone')
    await p.fs.write(join(dir, '.claude', 'worktrees', 'keep'), 'x')
    expect(await removedForms(p, unresolved)).toContain(join(realpathSync(join(dir, '.claude', 'worktrees')), 'gone'))
  })

  test('keptIgnored names the ignored files that look like secrets', () => {
    expect(keptIgnored(['.env', 'app/.env.local', 'node_modules/', 'dist/', 'certs/server.pem', '.npmrc', 'tsconfig.tsbuildinfo', 'secrets/'])).toEqual([
      '.env',
      'app/.env.local',
      'certs/server.pem',
      '.npmrc',
      'secrets/',
    ])
  })
})
