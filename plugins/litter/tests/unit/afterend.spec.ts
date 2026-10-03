// Tier 2: what happens after End swarm (FIX-U, U1-U4, U6, U7): the policy
// files of agents still running are kept, so the guard denies them, then
// swept; admission refuses a former node; the cleanup's notion of a node in
// use is the settle wait's; a summary call that ends after swarm.end is
// dropped; a broken launch ledger doesn't hold the end; and a spool that
// never drains holds the settle only for a bounded time.
//
// K's ownership and M's swarm entry are other packages' (end.ts's `others`
// seam stands in for them, and records the calls); the node policies are
// real files, written and removed by guard.ts.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentPolicy, NodePolicy, Policy, SwarmEntry } from '../../hooks/hookfiles'
import type { ListedAgent, SessionSendResult, ToolCallResult } from '../../hooks/ports'
import { agentPolicyPath, launchSummaryPath, policyPath, spoolDir, swarmOwnBranch, swarmOwnWorktreeName } from '../../hooks/layout'
import { atomicWriteJson } from '../../hooks/fsx'
import { normalizeOptions } from '../../hooks/options'
import { appendLaunchRecord, newLaunchId, readLaunchLedger } from '../../hooks/records/swarm'
import { updateSession } from '../../hooks/session'
import { endSwarm, others, resetEndForTests } from '../../hooks/swarm/end'
import { resetObserveForTests } from '../../hooks/swarm/observe'
import * as admit from '../../hooks/swarm/admit'
import * as state from '../../hooks/swarm/state'
import type { LiveSwarm, NodeBinding } from '../../hooks/swarm/types'
import { addSwarmWorktree } from '../../hooks/swarm/worktrees'
import { fireEvery, nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// Real git in the cleanup; a loaded machine takes seconds.
setDefaultTimeout(120_000)

const T0 = 1_800_000_000_000
const options = normalizeOptions(undefined)
const OK = { result: { message: 'Successfully stopped task' }, text: 'Successfully stopped task' } as unknown as ToolCallResult

let p: TestPorts
let dir: string
let litterDir: string
let root: string
let launch: string
let main: string
let cleanup: () => void
let git: (...argv: string[]) => Promise<string>
/** Every call through `others`, in order. */
let calls: unknown[][]
const saved = { ...others }

beforeEach(async () => {
  state.resetForTests()
  resetEndForTests()
  resetObserveForTests()
  admit.resetForTests()
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ cwd: dir })
  p.clock.now = T0
  ;({ git } = await scratchRepo(p, dir))
  await p.fs.write(join(dir, '.gitignore'), '.env\n.claude/\nnode_modules\n')
  await git('add', '.gitignore')
  await git('commit', '-q', '-m', 'ignore')
  main = (await git('rev-parse', 'HEAD')).trim()
  litterDir = join(dir, '.claude', 'litter')
  root = join(realpathSync(dir), '.claude', 'worktrees')
  launch = await newLaunchId(p, litterDir, 'alpha')
  updateSession({ litterDir })

  calls = []
  others.patchSwarmPolicy = async (_p, _dir, name) => void calls.push(['patchSwarmPolicy', name])
  others.writeSwarmPolicy = async (_p, _dir, name, e) => void calls.push(['writeSwarmPolicy', name, e])
  others.releaseOwnership = async (_p, _dir, name) => void calls.push(['releaseOwnership', name])
  others.stopOwnerBeat = name => void calls.push(['stopOwnerBeat', name])
  others.releaseActive = async () => void calls.push(['releaseActive'])
  others.noteSummaryTrigger = () => undefined
  p.toolAnswer = () => OK
})

afterEach(() => {
  Object.assign(others, saved)
  resetEndForTests()
  admit.resetForTests()
  updateSession({ litterDir: null })
  state.resetForTests()
  cleanup()
})

const swarmOf = (over: Partial<LiveSwarm> = {}): LiveSwarm => ({
  name: 'alpha',
  launch,
  revision: 1,
  spec: {
    name: 'alpha',
    goal: 'fix the parser',
    nodes: [
      { id: 'boss', kind: 'orchestrator', spawns: { fixer: 2 } },
      { id: 'fixer', kind: 'worker', worktree: 'own' },
    ],
  },
  nonce: 'n0nce',
  types: { boss: 'litter:sw-alpha-boss', fixer: 'litter:sw-alpha-fixer' },
  typesReady: true,
  dirs: {},
  sessionCwd: dir,
  worktreeRoot: root,
  commonDir: realpathSync(join(dir, '.git')),
  roots: { litterDir, litterCopies: [litterDir], ruleDirs: [] },
  tips: { 'refs/heads/main': main },
  owner: { ref: 'refs/litter-swarm/alpha', oid: 'a'.repeat(40), generation: 1, session: 'test-session' },
  state: 'live',
  readOnly: false,
  lost: false,
  flags: { isolationLost: false },
  startedAt: T0,
  ...over,
})

const bindingOf = (agentId: string, over: Partial<NodeBinding> = {}): NodeBinding => ({
  agentId,
  swarm: 'alpha',
  launch,
  node: 'fixer',
  n: 1,
  kind: 'worker',
  of: null,
  parent: 'a-boss',
  type: 'litter:sw-alpha-fixer',
  cwd: dir,
  branch: null,
  token: `tok-${agentId}`,
  revision: 1,
  generation: 1,
  boundAt: T0,
  adopted: false,
  ...over,
})

const listed = (id: string, status: string, type = 'litter:sw-alpha-fixer'): ListedAgent => ({ id, description: id, type, status })

/** A node's policy file as nodePolicyFor writes it, for the swarm's launch unless given. */
function policyFor(b: NodeBinding, over: Partial<NodePolicy> = {}): NodePolicy {
  return {
    swarm: b.swarm,
    launch: b.launch,
    node: b.node,
    n: b.n,
    kind: b.kind,
    of: b.of,
    type: b.type,
    parent: b.parent,
    generation: b.generation,
    dir: b.cwd,
    paths: null,
    protect: [],
    branch: null,
    authority: {},
    toolsDeny: [],
    bashDeny: [],
    spawns: [],
    spawnOther: true,
    admitted: true,
    stopped: null,
    bind: false,
    ...over,
  }
}

const writePolicy = (agentId: string, node: NodePolicy) => atomicWriteJson(p, agentPolicyPath(litterDir, agentId), { v: 1, node } satisfies AgentPolicy)
const hasPolicy = (agentId: string) => existsSync(agentPolicyPath(litterDir, agentId))

/** The boss and fixer #1 bound (and their files written), fixer #1 in `wt` when given. */
async function live(wt: string | null = null, over: Partial<LiveSwarm> = {}) {
  state.putLiveSwarm(swarmOf(over))
  const boss = bindingOf('a-boss', { node: 'boss', kind: 'orchestrator', parent: null, type: 'litter:sw-alpha-boss', n: 1 })
  const fix = bindingOf('a-fix1', wt ? { cwd: wt, branch: 'refs/heads/sw/alpha/fixer-1' } : {})
  for (const b of [boss, fix]) {
    state.putBinding(b)
    await writePolicy(b.agentId, policyFor(b))
  }
  p.agents = [listed('a-boss', 'completed', 'litter:sw-alpha-boss'), listed('a-fix1', 'completed')]
}

/** An `own` worktree for fixer #n, made as the spawn check makes it. */
async function ownWorktree(n: number): Promise<string> {
  const path = join(root, swarmOwnWorktreeName('alpha', 'fixer', n))
  const made = await addSwarmWorktree(p, litterDir, options, {
    swarm: 'alpha',
    launch,
    node: 'fixer',
    n,
    path,
    branch: swarmOwnBranch('alpha', 'fixer', n),
    from: main,
    repo: dir,
    setup: null,
    linkDirs: [],
  })
  expect(made.ok).toBe(true)
  return path
}

const records = async () => (await readLaunchLedger(p, litterDir, 'alpha', launch)).records
const kinds = async () => (await records()).map(r => r.kind)
const bodyOf = async (kind: string) => (await records()).filter(r => r.kind === kind).map(r => r.body)

describe('U3: the cleanup counts a node as ended the way the settle wait does', () => {
  test("a node whose turn.complete landed, still listed running, doesn't keep its worktree", async () => {
    const wt = await ownWorktree(1)
    await live(wt)
    state.markRunning('a-fix1')
    p.agents[1]!.status = 'running'
    await endSwarm(p, 'alpha', 'request')
    // Its turn.complete lands; the settle tick runs before L's poll sees it leave the list.
    state.markSettling('a-fix1')
    await fireEvery(p)
    const [end] = await bodyOf('swarm.end')
    expect(end).toEqual(expect.objectContaining({ settled: true }))
    expect(await bodyOf('swarm.worktree.kept')).toEqual([])
    expect(existsSync(wt)).toBe(false)
    expect(await bodyOf('swarm.worktree.removed')).toEqual([{ path: wt, branch: 'sw/alpha/fixer-1', branchDeleted: true }])
  })
})
