// Tier 2: the mod's writer for the files guard.sh and hold.sh read
// (hooks/swarm/guard.ts; plan 15.4, "The guard for nodes"; 15.8, "The node
// policy"): a node's or child's policy from its binding, the per-file patches
// and their serial key, policy.json's swarm entry with `active`, and the
// pending markers a crash left.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { AgentPolicy, NodePolicy, Policy, SwarmEntry } from '../../hooks/hookfiles'
import type { LiveSwarm, NodeBinding } from '../../hooks/swarm/types'
import { activePath, agentPolicyPath, donePath, holdPath, pendingDir, pendingPath, policyPath } from '../../hooks/layout'
import {
  clearPending,
  nodePolicyFor,
  patchNodePolicies,
  patchNodePolicy,
  patchSwarmPolicy,
  removeNodePolicy,
  writeNodePolicy,
  writeSwarmPolicy,
} from '../../hooks/swarm/guard'
import { readPolicy, updatePolicy, writePolicy } from '../../hooks/policy'
import { ROLE_NAMES, ROLE_POLICIES } from '../../hooks/roles'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const NOW = 1_800_000_000_000
const ADMITTED = { admitted: true, stopped: null, bind: false }

let p: TestPorts
let dir: string
let cleanup: () => void
let litterDir: string

beforeEach(() => {
  p = nodePorts()
  p.clock.now = NOW
  ;({ dir, cleanup } = scratch())
  litterDir = `${dir}/.claude/litter`
  mkdirSync(`${litterDir}/hooks`, { recursive: true })
})
afterEach(() => cleanup())

function swarm(over: Partial<LiveSwarm> = {}): LiveSwarm {
  return {
    name: 'stack',
    launch: '20261003-120000',
    revision: 2,
    spec: {
      name: 'stack',
      goal: 'resolve the threads',
      nodes: [
        {
          id: 'part-a',
          kind: 'orchestrator',
          worktree: { existing: '.claude/worktrees/part-a' },
          authority: { commit: true, push: 'own-branch', forcePush: false },
          spawns: { reviewer: 3, fixer: 2 },
          paths: ['src/', 'README.md', '../outside/', 'docs/./guide.md'],
          bash: { deny: ['npm publish', 'rm -rf'] },
        },
        { id: 'reviewer', kind: 'worker', tools: { deny: ['Edit', 'Write', 'NotebookEdit'] }, spawnOther: false },
        { id: 'fixer', kind: 'worker', authority: { commit: false }, worktree: 'own' },
      ],
    },
    nonce: 'n0nce',
    types: { 'part-a': 'litter:sw-stack-part-a', reviewer: 'litter:sw-stack-reviewer', fixer: 'litter:sw-stack-fixer' },
    typesReady: true,
    dirs: {},
    sessionCwd: dir,
    worktreeRoot: `${dir}/.claude/worktrees`,
    commonDir: `${dir}/.git`,
    roots: { litterDir, litterCopies: [litterDir, `${dir}/.claude/worktrees/part-a/.claude/litter`], ruleDirs: [`${dir}/.litter`, `${dir}/.claude/rules/litter/`] },
    tips: {},
    owner: { ref: 'refs/litter-swarm/stack', oid: 'a'.repeat(40), generation: 3, session: 'test-session' },
    state: 'live',
    readOnly: false,
    lost: false,
    flags: { isolationLost: false },
    startedAt: NOW,
    ...over,
  }
}

function binding(agentId: string, over: Partial<NodeBinding> = {}): NodeBinding {
  return {
    agentId,
    swarm: 'stack',
    launch: '20261003-120000',
    node: 'part-a',
    n: 1,
    kind: 'orchestrator',
    of: null,
    parent: null,
    type: 'litter:sw-stack-part-a',
    cwd: `${dir}/.claude/worktrees/part-a/`,
    branch: 'refs/heads/part-a',
    token: 'tok',
    revision: 2,
    generation: 3,
    boundAt: NOW,
    adopted: false,
    ...over,
  }
}

function entry(over: Partial<SwarmEntry> = {}): SwarmEntry {
  return {
    launch: '20261003-120000',
    state: 'live',
    commonDir: `${dir}/.git`,
    owner: { ref: 'refs/litter-swarm/stack', oid: 'a'.repeat(40), generation: 3, session: 'test-session', checkedAt: NOW / 1000 },
    nodeTypes: ['litter:sw-stack-part-a'],
    ...over,
  }
}

const readAgent = (id: string): AgentPolicy => JSON.parse(readFileSync(agentPolicyPath(litterDir, id), 'utf8'))
const readFile = (path: string): Policy => JSON.parse(readFileSync(path, 'utf8'))
const active = () => existsSync(activePath(litterDir))

describe('nodePolicyFor', () => {
  test('an orchestrator gets its spec, resolved under its directory, its branch and its flags', () => {
    const wt = `${dir}/.claude/worktrees/part-a`
    const n = nodePolicyFor(binding('a1'), swarm(), ADMITTED)
    expect(n).toEqual({
      swarm: 'stack',
      launch: '20261003-120000',
      node: 'part-a',
      n: 1,
      kind: 'orchestrator',
      of: null,
      type: 'litter:sw-stack-part-a',
      parent: null,
      generation: 3,
      dir: wt,
      // `../outside/` leaves the directory, so it allows nothing rather than something else.
      paths: [`${wt}/src/`, `${wt}/README.md`, `${wt}/docs/guide.md`],
      protect: [
        litterDir,
        `${wt}/.claude/litter`,
        `${dir}/.litter`,
        `${dir}/.claude/rules/litter`,
        `${wt}/.litter`,
        `${wt}/.litter.local`,
        `${wt}/.claude/rules/litter`,
        `${wt}/.claude/rules/litter-local`,
      ],
      branch: 'refs/heads/part-a',
      authority: { commit: true, push: 'own-branch', forcePush: false },
      toolsDeny: [],
      bashDeny: ['npm publish', 'rm -rf'],
      spawns: ['litter:sw-stack-reviewer', 'litter:sw-stack-fixer'],
      spawnOther: true,
      admitted: true,
      stopped: null,
      bind: false,
    } satisfies NodePolicy)
  })

  test('a worker carries its own limits, and no branch unless it may commit', () => {
    const fixer = nodePolicyFor(
      binding('w1', { node: 'fixer', kind: 'worker', n: 2, parent: 'a1', type: 'litter:sw-stack-fixer', cwd: `${dir}/wt-2`, branch: 'sw/stack/fixer-2' }),
      swarm(),
      { admitted: false, stopped: 'browser', bind: true },
    )
    expect(fixer).toMatchObject({
      node: 'fixer',
      kind: 'worker',
      n: 2,
      parent: 'a1',
      type: 'litter:sw-stack-fixer',
      dir: `${dir}/wt-2`,
      paths: null,
      branch: null,
      authority: { commit: false },
      spawns: [],
      spawnOther: true,
      admitted: false,
      stopped: 'browser',
      bind: true,
    })
    const reviewer = nodePolicyFor(binding('w2', { node: 'reviewer', kind: 'worker', parent: 'a1', type: '', branch: null }), swarm(), ADMITTED)
    expect(reviewer.type).toBe('litter:sw-stack-reviewer')
    expect(reviewer.toolsDeny).toEqual(['Edit', 'Write', 'NotebookEdit'])
    expect(reviewer.spawnOther).toBe(false)
    expect(reviewer.authority).toEqual({})
  })

  test("a child gets its node's scope, with n 0 and the node it belongs to", () => {
    const child = nodePolicyFor(
      binding('c1', { kind: 'child', n: 3, of: 'a1', parent: 'a1', token: null, branch: 'part-a' }),
      swarm(),
      ADMITTED,
    )
    const node = nodePolicyFor(binding('a1'), swarm(), ADMITTED)
    expect(child).toEqual({ ...node, kind: 'child', n: 0, of: 'a1', parent: 'a1' })
  })

  test('a short branch name becomes a full ref', () => {
    expect(nodePolicyFor(binding('a1', { branch: 'part-a' }), swarm(), ADMITTED).branch).toBe('refs/heads/part-a')
    expect(nodePolicyFor(binding('a1', { branch: null }), swarm(), ADMITTED).branch).toBeNull()
  })

  test("a node the launched spec doesn't have throws", () => {
    expect(() => nodePolicyFor(binding('a1', { node: 'gone' }), swarm(), ADMITTED)).toThrow('node gone isn')
  })
})

describe('the node policy files', () => {
  const node = (): NodePolicy => nodePolicyFor(binding('a1'), swarm(), ADMITTED)

  test('writeNodePolicy writes { v: 1, node } through a temp file, and refuses an id that is no file name', async () => {
    await writeNodePolicy(p, litterDir, 'a1', node())
    expect(readAgent('a1')).toEqual({ v: 1, node: node() })
    expect(readdirSync(`${litterDir}/hooks/agents`)).toEqual(['a1.json'])
    await expect(writeNodePolicy(p, litterDir, '../a1', node())).rejects.toThrow('agent id')
  })

  test('patchNodePolicy changes the fields it names, and a missing file stays missing', async () => {
    await writeNodePolicy(p, litterDir, 'a1', node())
    await patchNodePolicy(p, litterDir, 'a1', { stopped: 'browser' })
    expect(readAgent('a1').node).toEqual({ ...node(), stopped: 'browser' })
    await patchNodePolicy(p, litterDir, 'gone', { stopped: 'browser' })
    expect(existsSync(agentPolicyPath(litterDir, 'gone'))).toBe(false)
  })

  test("patchNodePolicy leaves a file that isn't a node's alone", async () => {
    mkdirSync(`${litterDir}/hooks/agents`, { recursive: true })
    const task = { v: 1, run: '20261003-x', task: { id: 't1', owned: ['a.py'] } }
    writeFileSync(agentPolicyPath(litterDir, 'w1'), JSON.stringify(task))
    await expect(patchNodePolicy(p, litterDir, 'w1', { admitted: false })).rejects.toThrow("isn't a node's policy")
    expect(readAgent('w1')).toEqual(task as AgentPolicy)
  })

  test('the patches of one file are serialised: none is lost', async () => {
    await writeNodePolicy(p, litterDir, 'a1', node())
    await Promise.all([
      patchNodePolicy(p, litterDir, 'a1', { admitted: false }),
      patchNodePolicy(p, litterDir, 'a1', { stopped: 'browser' }),
      patchNodePolicy(p, litterDir, 'a1', { bind: true }),
      patchNodePolicy(p, litterDir, 'a1', { spawnOther: false }),
      patchNodePolicy(p, litterDir, 'a1', { generation: 4 }),
      writeNodePolicy(p, litterDir, 'a2', node()),
    ])
    expect(readAgent('a1').node).toMatchObject({ admitted: false, stopped: 'browser', bind: true, spawnOther: false, generation: 4 })
  })

  test('patchNodePolicies patches every agent, skips the missing, and reports a failure after trying the rest', async () => {
    await writeNodePolicy(p, litterDir, 'a1', node())
    await writeNodePolicy(p, litterDir, 'a2', node())
    await patchNodePolicies(p, litterDir, ['a1', 'a2', 'gone', 'a1'], { stopped: 'parent stopped' })
    expect(readAgent('a1').node?.stopped).toBe('parent stopped')
    expect(readAgent('a2').node?.stopped).toBe('parent stopped')
    writeFileSync(agentPolicyPath(litterDir, 'bad'), '{"v":1,')
    await expect(patchNodePolicies(p, litterDir, ['bad', 'a1'], { admitted: false })).rejects.toThrow('1 of 2 node policies')
    expect(readAgent('a1').node?.admitted).toBe(false)
  })

  test('removeNodePolicy removes the policy with its done/ and hold/ files', async () => {
    await writeNodePolicy(p, litterDir, 'a1', node())
    await p.fs.write(donePath(litterDir, 'a1'), '{"v":1,"at":1,"via":"stop"}\n')
    await p.fs.write(holdPath(litterDir, 'a1'), '{"v":1,"children":["c1"]}\n')
    await removeNodePolicy(p, litterDir, 'a1')
    expect([agentPolicyPath(litterDir, 'a1'), donePath(litterDir, 'a1'), holdPath(litterDir, 'a1')].map(existsSync)).toEqual([false, false, false])
    await removeNodePolicy(p, litterDir, 'a1')
  })
})

describe('policy.json swarm entry', () => {
  const runPolicy = (): Policy => ({
    v: 1,
    session: 'run-session',
    litterDir,
    run: {
      run: '20261003-run',
      workflow: 'execute',
      runDir: `${litterDir}/20261003-run`,
      checkout: dir,
      base: '0'.repeat(40),
      runIds: [],
      launching: false,
      stopping: false,
      inflight: null,
      isolationLost: false,
      roots: { checkout: dir, litterDir, litterCopies: [litterDir], ruleDirs: [], worktrees: [] },
      setup: null,
      linkDirs: [],
    },
    roles: { ...ROLE_POLICIES },
    swarm: null,
  })

  test('the first swarm creates policy.json with no run and every role, then active', async () => {
    await writeSwarmPolicy(p, litterDir, 'stack', entry())
    const policy = readFile(policyPath(litterDir))
    expect(policy).toEqual({ v: 1, session: 'test-session', litterDir, run: null, roles: ROLE_POLICIES, swarm: { swarms: { stack: entry() } } })
    expect(Object.keys(policy.roles).sort()).toEqual([...ROLE_NAMES].sort())
    expect(active()).toBe(true)
  })

  test('the last swarm to go removes active and leaves swarm null, never an empty swarms', async () => {
    await writeSwarmPolicy(p, litterDir, 'stack', entry())
    await writeSwarmPolicy(p, litterDir, 'other', entry({ launch: '20261003-130000' }))
    await writeSwarmPolicy(p, litterDir, 'stack', null)
    expect(active()).toBe(true)
    expect(Object.keys(readFile(policyPath(litterDir)).swarm!.swarms)).toEqual(['other'])
    await writeSwarmPolicy(p, litterDir, 'other', null)
    expect(active()).toBe(false)
    expect(readFile(policyPath(litterDir)).swarm).toBeNull()
  })

  test('with a run active, the swarm comes and goes beside it, and active stays', async () => {
    await writePolicy(p, litterDir, runPolicy())
    await p.fs.write(activePath(litterDir), '')
    await writeSwarmPolicy(p, litterDir, 'stack', entry())
    expect(readFile(policyPath(litterDir))).toEqual({ ...runPolicy(), swarm: { swarms: { stack: entry() } } })
    await writeSwarmPolicy(p, litterDir, 'stack', null)
    expect(readFile(policyPath(litterDir))).toEqual(runPolicy())
    expect(active()).toBe(true)
  })

  test("removing an entry that isn't there writes nothing, and creates no policy.json", async () => {
    await writeSwarmPolicy(p, litterDir, 'stack', null)
    expect(existsSync(policyPath(litterDir))).toBe(false)
    expect(active()).toBe(false)
  })

  test('a policy.json that does not parse, or of another version, is never written over', async () => {
    writeFileSync(policyPath(litterDir), '{"v":1,"run":')
    await expect(writeSwarmPolicy(p, litterDir, 'stack', entry())).rejects.toThrow()
    writeFileSync(policyPath(litterDir), '{"v":2}\n')
    await expect(writeSwarmPolicy(p, litterDir, 'stack', entry())).rejects.toThrow("isn't version 1")
    expect(readFileSync(policyPath(litterDir), 'utf8')).toBe('{"v":2}\n')
  })

  test('a swarm named like an Object property is an entry like any other', async () => {
    await writeSwarmPolicy(p, litterDir, 'constructor', null)
    expect(existsSync(policyPath(litterDir))).toBe(false)
    await writeSwarmPolicy(p, litterDir, 'constructor', entry())
    await patchSwarmPolicy(p, litterDir, 'tostring', () => entry({ state: 'stopping' }))
    expect(Object.keys(readFile(policyPath(litterDir)).swarm!.swarms)).toEqual(['constructor'])
  })

  test('writeSwarmPolicy and updatePolicy share a key: neither change is lost', async () => {
    await writePolicy(p, litterDir, runPolicy())
    await Promise.all([
      writeSwarmPolicy(p, litterDir, 'stack', entry()),
      updatePolicy(p, litterDir, cur => ({ ...cur, session: 'rebound' })),
      writeSwarmPolicy(p, litterDir, 'other', entry()),
    ])
    const policy = (await readPolicy(p, litterDir))!
    expect(policy.session).toBe('rebound')
    expect(Object.keys(policy.swarm!.swarms).sort()).toEqual(['other', 'stack'])
  })

  test('patchSwarmPolicy changes the entry, and leaves the file alone when change says null or the entry is gone', async () => {
    await writeSwarmPolicy(p, litterDir, 'stack', entry())
    await patchSwarmPolicy(p, litterDir, 'stack', e => ({ ...e, owner: { ...e.owner, checkedAt: e.owner.checkedAt + 10 } }))
    expect(readFile(policyPath(litterDir)).swarm!.swarms.stack!.owner.checkedAt).toBe(NOW / 1000 + 10)
    const before = readFileSync(policyPath(litterDir), 'utf8')
    // A beat whose generation the entry no longer has changes nothing.
    await patchSwarmPolicy(p, litterDir, 'stack', e => (e.owner.generation === 2 ? e : null))
    await patchSwarmPolicy(p, litterDir, 'gone', () => entry())
    expect(readFileSync(policyPath(litterDir), 'utf8')).toBe(before)
  })

  test('patchSwarmPolicy with no policy.json does nothing', async () => {
    await patchSwarmPolicy(p, litterDir, 'stack', () => entry())
    expect(existsSync(policyPath(litterDir))).toBe(false)
  })
})

describe('clearPending', () => {
  const marker = (key: string, swarmName: string, atSec: number) =>
    p.fs.write(pendingPath(litterDir, key), `${JSON.stringify({ v: 1, swarm: swarmName, node: 'fixer', parent: 'a1', at: atSec })}\n`)

  test('removes every marker a crash left, and is a no-op with none', async () => {
    await clearPending(p, litterDir)
    await marker('toolu_1', 'stack', NOW / 1000)
    await p.fs.write(`${pendingDir(litterDir)}/toolu_2.tmp-x`, '{')
    await clearPending(p, litterDir)
    expect(readdirSync(pendingDir(litterDir))).toEqual([])
  })

  test('keeps the fresh markers of a swarm another session owns and still beats for', async () => {
    await writeSwarmPolicy(p, litterDir, 'theirs', entry({ owner: { ...entry().owner, session: 'other', checkedAt: NOW / 1000 - 5 } }))
    await writeSwarmPolicy(p, litterDir, 'gone', entry({ owner: { ...entry().owner, session: 'other', checkedAt: NOW / 1000 - 600 } }))
    await writeSwarmPolicy(p, litterDir, 'mine', entry())
    await marker('toolu_theirs', 'theirs', NOW / 1000 - 30)
    await marker('toolu_old', 'theirs', NOW / 1000 - 3600)
    await marker('toolu_gone', 'gone', NOW / 1000 - 30)
    await marker('toolu_mine', 'mine', NOW / 1000 - 30)
    await clearPending(p, litterDir)
    expect(readdirSync(pendingDir(litterDir))).toEqual(['toolu_theirs'])
  })
})
