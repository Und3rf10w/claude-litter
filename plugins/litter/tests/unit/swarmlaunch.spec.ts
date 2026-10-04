// Tier 2: Launch (hooks/swarm/launch.ts; WP-K, plan 15.4 "Launch"), against
// real git: the checks that refuse before anything is written, your
// confirmation, the ref and the `new` worktree, every node's type, the bound
// branches, swarm.start, the policy entry and `active`, the prompt box, a
// failure after the ref; the node type specs; and mcp__litter__swarm_read.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSpec } from '../../hooks/ports'
import type { SwarmStartBody } from '../../hooks/records/swarm'
import type { Policy } from '../../hooks/hookfiles'
import type { SwarmSpec } from '../../hooks/swarm/types'
import { activePath, launchesDir, swarmDir } from '../../hooks/layout'
import { sha256 } from '../../hooks/fsx'
import { writePolicy } from '../../hooks/policy'
import { updateSession } from '../../hooks/session'
import { readLaunchLedger } from '../../hooks/records/swarm'
import { REPORT_EVENT_PHRASES, DELEGATION_NO_OTHER, DELEGATION_NONE, AUTHORITY_COMMIT_YES, AUTHORITY_PATHS } from '../../hooks/prompts/swarm-node'
import {
  closeGate,
  enqueue,
  liveSwarm,
  markRunning,
  markSettled,
  noteQuestion,
  noteReport,
  openGate,
  putLiveSwarm,
  stop,
} from '../../hooks/swarm/state'
import { SWARM_READ } from '../../hooks/swarm/tools'
import { deps as launchDeps, launchSwarm, nodeTypeSpec, specHash, swarmReadTool } from '../../hooks/swarm/launch'
import { recoverSwarms } from '../../hooks/swarm/recover'
import { writeSwarmSummary } from '../../hooks/swarm/end'
import {
  aSpec,
  bind,
  blobAt,
  BRIEFS,
  launched as harnessLaunched,
  NOW,
  policyText,
  refOf as harnessRefOf,
  saveSwarm,
  settle,
  swarmRead,
  world,
  type World,
} from './swarmlaunch-harness'

// Real git in every test; a loaded machine takes seconds.
setDefaultTimeout(120_000)

let w: World
beforeEach(async () => {
  w = await world()
})
afterEach(async () => {
  await w.done()
})

const LAUNCH = '20261003-120000'
const wtPath = () => join(w.dir, '.claude', 'worktrees', 'sw-alpha-lead-a')
const refOf = () => harnessRefOf(w)
const launched = (spec?: SwarmSpec) => harnessLaunched(w, spec)
const read = (input: Record<string, unknown>) => swarmRead(w, input)
const records = async (launch = LAUNCH) => (await readLaunchLedger(w.p, w.litterDir, 'alpha', launch)).records
const leases = () => (existsSync(swarmDir(w.litterDir, 'alpha')) ? readdirSync(swarmDir(w.litterDir, 'alpha')).filter(f => f.startsWith('owner-lease-')) : [])
const readPolicyJson = async () => JSON.parse((await policyText(w)) ?? 'null') as Policy | null

/** Nothing of a launch exists: no ref, worktree, branch, type, record, policy entry, `active`, live swarm or fill. */
async function nothingWritten(policyBefore: string | null = null): Promise<void> {
  expect(await refOf()).toBeNull()
  expect(existsSync(join(w.dir, '.claude', 'worktrees'))).toBe(false)
  expect((await w.p.run(['git', '-C', w.dir, 'show-ref', '--verify', '--quiet', 'refs/heads/feature/alpha'])).code).not.toBe(0)
  expect(w.p.registeredAgents).toEqual([])
  expect(existsSync(launchesDir(w.litterDir, 'alpha'))).toBe(false)
  expect(await policyText(w)).toBe(policyBefore)
  expect(existsSync(activePath(w.litterDir))).toBe(false)
  expect(leases()).toEqual([])
  expect(liveSwarm('alpha')).toBeNull()
  expect(w.p.filled).toEqual([])
}

describe('launchSwarm: the checks refuse before anything is written', () => {
  test('without a litter directory, with the tools refused, or without jq', async () => {
    await saveSwarm(w, aSpec())
    updateSession({ litterDir: null, litterDirError: 'not a git checkout' })
    let r = await launchSwarm(w.p, 'alpha')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('no litter directory (not a git checkout)') })
    updateSession({ litterDir: w.litterDir, litterDirError: null, toolsRefused: 'allowedMcpServers' })
    r = await launchSwarm(w.p, 'alpha')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("litter's tools were refused (allowedMcpServers)") })
    updateSession({ toolsRefused: null, swarmToolsRefused: 'refused' })
    r = await launchSwarm(w.p, 'alpha')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('the swarm tools were refused') })
    updateSession({ swarmToolsRefused: null })
    const run = w.p.run
    w.p.run = async (argv, init) => (argv[0] === 'jq' ? { code: 127, stdout: '', stderr: 'jq: not found', truncated: false } : run(argv, init))
    r = await launchSwarm(w.p, 'alpha')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("jq isn't on PATH") })
    w.p.run = run
    expect(w.p.asked).toEqual([])
    await nothingWritten()
  })

  test('a bad name, a swarm never saved, and a spec naming another swarm', async () => {
    expect(await launchSwarm(w.p, '../x')).toEqual({ ok: false, reason: expect.stringContaining("isn't a swarm name") })
    expect(await launchSwarm(w.p, 'alpha')).toEqual({ ok: false, reason: expect.stringContaining('never been saved') })
    expect(await launchSwarm(w.p, 'alpha', { revision: 3 })).toEqual({ ok: false, reason: expect.stringContaining("revision 3 doesn't exist") })
    // A beta spec saved under alpha's folder.
    await w.p.fs.write(join(swarmDir(w.litterDir, 'alpha'), 'revisions', '1.json'), JSON.stringify({ ...aSpec(), name: 'beta' }))
    expect(await launchSwarm(w.p, 'alpha')).toEqual({ ok: false, reason: expect.stringContaining("its spec names swarm 'beta'") })
    expect(w.p.asked).toEqual([])
    await nothingWritten()
  })

  test("J's validation errors and the health check's errors refuse, each named; warnings don't", async () => {
    await saveSwarm(w, aSpec())
    w.check = {
      ok: false,
      errors: [
        { field: 'nodes.fixer.authority.commit', node: 'fixer', error: 'is more than its parent lead-a allows' },
        { field: 'nodes.scout.worktree', node: 'scout', error: 'own is for workers' },
      ],
      warnings: [],
    }
    w.health = {
      rows: [{ id: 'linked', severity: 'error', title: 'Session in a linked worktree', detail: 'open the session in the primary checkout' }],
      errors: 1,
      warnings: 0,
      snippet: null,
    }
    const r = await launchSwarm(w.p, 'alpha')
    expect(r.ok).toBe(false)
    const reason = (r as { reason: string }).reason
    expect(reason).toContain('nodes.fixer.authority.commit: is more than its parent lead-a allows')
    expect(reason).toContain('nodes.scout.worktree: own is for workers')
    expect(reason).toContain('Session in a linked worktree: open the session in the primary checkout')
    // Validation saw the run's checkout (none) and the saved briefs.
    expect(w.calls.validated[0]!.ctx.activeRunCheckout).toBeNull()
    expect(await w.calls.validated[0]!.ctx.briefText('lead-a')).toBe(BRIEFS['lead-a']!)
    expect(await w.calls.validated[0]!.ctx.briefText('docs')).toBeNull()
    expect(w.calls.health[0]).toEqual({ spec: aSpec(), litterDir: w.litterDir })
    expect(w.p.asked).toEqual([])
    await nothingWritten()
  })

  test("a type another live swarm serves refuses: sw-alpha-lead-a is alpha's lead-a and alpha-lead's a", async () => {
    await saveSwarm(w, aSpec())
    putLiveSwarm({ ...(await otherLive()), name: 'alpha-lead', types: { a: 'litter:sw-alpha-lead-a' } })
    const r = await launchSwarm(w.p, 'alpha')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("its type litter:sw-alpha-lead-a is live swarm alpha-lead's too") })
    expect(w.p.asked).toEqual([])
    expect(await refOf()).toBeNull()
    expect(w.p.registeredAgents).toEqual([])
  })

  test("a `new` worktree's branch that exists, a `from` that names nothing, and an `existing` that isn't a worktree", async () => {
    await w.git('branch', 'feature/alpha')
    const spec = aSpec()
    spec.nodes[0]!.worktree = { new: { from: 'main', branch: 'feature/alpha' } }
    spec.nodes[1]!.worktree = { existing: 'not-a-worktree' }
    await saveSwarm(w, spec)
    let r = await launchSwarm(w.p, 'alpha')
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('nodes.lead-a.worktree.new.branch: feature/alpha already exists')
    expect((r as { reason: string }).reason).toContain("nodes.docs.worktree.existing: not-a-worktree isn't a worktree of this repository")
    await w.git('branch', '-D', 'feature/alpha')
    spec.nodes[0]!.worktree = { new: { from: 'no-such-ref', branch: 'feature/alpha' } }
    spec.nodes[1]!.worktree = 'none'
    await saveSwarm(w, spec)
    r = await launchSwarm(w.p, 'alpha')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("nodes.lead-a.worktree.new.from: 'no-such-ref' doesn't name a commit") })
    expect(w.p.asked).toEqual([])
    await nothingWritten()
  })

  test('a detached HEAD where a node commits refuses, naming the node, and an inherit worker that commits under it', async () => {
    const detached = join(w.dir, '.claude', 'detached')
    await w.git('worktree', 'add', '-q', '--detach', detached, 'main')
    const spec = aSpec()
    spec.nodes[1] = { ...spec.nodes[1]!, worktree: { existing: detached }, authority: { commit: true } }
    await saveSwarm(w, spec)
    let r = await launchSwarm(w.p, 'alpha')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining(`nodes.docs: ${detached} is on a detached HEAD, so docs can't commit there`) })
    // docs doesn't commit, but its inherit worker does.
    spec.nodes[1] = { ...spec.nodes[1]!, authority: { commit: false }, spawns: { fixer: 1 } }
    await saveSwarm(w, spec)
    r = await launchSwarm(w.p, 'alpha')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('so fixer can\'t commit there') })
    expect(w.p.asked).toEqual([])
    expect(await refOf()).toBeNull()
    expect(w.p.registeredAgents).toEqual([])
    expect(existsSync(launchesDir(w.litterDir, 'alpha'))).toBe(false)
  })

  test("no node works in the active run's checkout (15.4, \"Coexisting with runs\")", async () => {
    const checkout = join(w.dir, '.claude', 'run-checkout')
    await w.git('worktree', 'add', '-q', '-b', 'litter/run-1', checkout, 'main')
    const policy = { v: 1, session: 'sess-a', litterDir: w.litterDir, run: { run: 'run-1', checkout }, roles: {}, swarm: null } as unknown as Policy
    await writePolicy(w.p, w.litterDir, policy)
    const before = await policyText(w)
    const spec = aSpec()
    spec.nodes[1] = { ...spec.nodes[1]!, worktree: { existing: checkout } }
    await saveSwarm(w, spec)
    const r = await launchSwarm(w.p, 'alpha')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining(`nodes.docs: it would work in ${checkout}, the active litter run's checkout`) })
    expect(w.calls.validated[0]!.ctx.activeRunCheckout).toBe(checkout)
    expect(w.p.asked).toEqual([])
    await nothingWritten(before)
  })

  test('Cancel, and an ask nobody answers, refuse with nothing written', async () => {
    await saveSwarm(w, aSpec())
    w.p.answers.push('Cancel')
    expect(await launchSwarm(w.p, 'alpha')).toEqual({ ok: false, reason: expect.stringContaining('Launch needs your confirmation') })
    // No answers left: the ask rejects, as under -p.
    expect(await launchSwarm(w.p, 'alpha')).toEqual({ ok: false, reason: expect.stringContaining('Launch needs your confirmation') })
    expect(w.p.asked.length).toBe(2)
    expect(w.p.asked[0]!.options).toEqual(['Launch', 'Cancel'])
    await nothingWritten()
  })
})

describe('launchSwarm: a launch', () => {
  test('takes the ref, makes the `new` worktree, registers every type, binds branches, records swarm.start, writes the entry and `active`, and fills the prompt box', async () => {
    w.check.warnings = [{ field: 'nodes.scout.report', node: 'scout', error: 'reports only when blocked' }]
    w.health = { rows: [{ id: 'peak', severity: 'warning', title: 'Peak agents', detail: 'the swarm can start 5 at once' }], errors: 0, warnings: 1, snippet: null }
    const launch = await launched()
    expect(launch).toBe(LAUNCH)

    // The ask: each node's directory and authority, what's unchecked, the worktree, the warnings, the new types.
    expect(w.p.asked.length).toBe(1)
    const q = w.p.asked[0]!.question
    expect(q).toContain(`- lead-a (orchestrator), in ${wtPath()} (a new worktree)`)
    expect(q).toContain(`- docs (orchestrator), in ${w.dir}`)
    expect(q).toContain("- fixer (worker), in its parent's directory")
    expect(q).toContain('- scout (worker), in its own worktree per instance, on sw/alpha/scout-<n>')
    expect(q).toContain('  commit yes, on feature/alpha; push: the lead may push its own branch only (feature/alpha), without force;')
    expect(q).toContain('files only under src/')
    expect(q).toContain('Unchecked by litter: rewriteHistory, worktreeOps, paths')
    expect(q).toContain(`- ${wtPath()}, on a new branch feature/alpha from main`)
    expect(q).toContain('- nodes.scout.report: reports only when blocked')
    expect(q).toContain('- Peak agents: the swarm can start 5 at once')
    expect(q).toContain('New agent types: litter:sw-alpha-lead-a, litter:sw-alpha-docs, litter:sw-alpha-fixer, litter:sw-alpha-scout')

    // The ref, at a blob naming this session, generation 1.
    const oid = (await refOf())!
    expect(oid).toMatch(/^[0-9a-f]{40}$/)
    const blob = await blobAt(w, oid)
    expect(blob).toEqual({ swarm: 'alpha', launch, session: 'sess-a', generation: 1, host: expect.any(String), pid: expect.stringMatching(/^[0-9]+$/), acquiredAt: NOW })

    // The `new` worktree, on its branch, recorded intent-first; then swarm.start.
    expect((await w.git('-C', wtPath(), 'symbolic-ref', '-q', 'HEAD')).trim()).toBe('refs/heads/feature/alpha')
    const rs = await records(launch)
    expect(rs.map(r => r.kind)).toEqual(['swarm.worktree.intent', 'swarm.worktree', 'swarm.start'])
    expect(rs[1]!.body).toEqual(expect.objectContaining({ node: 'lead-a', path: wtPath(), branch: 'feature/alpha', created_by: launch }))

    // Every type, workers included, with the right disallowedTools.
    const types = Object.fromEntries(w.p.registeredAgents.map(a => [a.name, a]))
    expect(Object.keys(types)).toEqual(['sw-alpha-lead-a', 'sw-alpha-docs', 'sw-alpha-fixer', 'sw-alpha-scout'])
    expect(types['sw-alpha-lead-a']!.disallowedTools).toEqual(['WebFetch'])
    expect(types['sw-alpha-docs']!.disallowedTools).toEqual(['Agent'])
    expect(types['sw-alpha-fixer']!.disallowedTools).toEqual(['Agent'])
    expect(types['sw-alpha-scout']!.disallowedTools).toBeUndefined()
    for (const t of Object.values(types)) expect(t.background).toBe(true)

    // swarm.start: the bound branch, the tips, the owner, the nonce and the spec's hash.
    const start = rs[2]!.body as SwarmStartBody
    const main = (await w.git('rev-parse', 'refs/heads/main')).trim()
    expect(start).toEqual(
      expect.objectContaining({
        swarm: 'alpha',
        launch,
        revision: 1,
        specHash: await sha256(JSON.stringify(aSpec())),
        nonce: expect.stringMatching(/^[0-9a-f]{32}$/),
        types: { 'lead-a': 'litter:sw-alpha-lead-a', docs: 'litter:sw-alpha-docs', fixer: 'litter:sw-alpha-fixer', scout: 'litter:sw-alpha-scout' },
        nodes: {
          'lead-a': { dir: wtPath(), branch: 'refs/heads/feature/alpha', created: true },
          docs: { dir: w.dir, branch: null, created: false },
        },
        tips: { 'refs/heads/main': main, 'refs/heads/feature/alpha': main },
        owner: { ref: 'refs/litter-swarm/alpha', oid, generation: 1 },
        sessionCwd: w.dir,
        worktreeRoot: join(w.dir, '.claude', 'worktrees'),
        commonDir: join(w.dir, '.git'),
      }),
    )
    expect(start.specHash).toBe(await specHash(aSpec()))
    expect(start.roots.litterCopies).toEqual([w.litterDir, join(wtPath(), '.claude', 'litter')])
    expect(start.roots.ruleDirs).toContain(join(w.dir, '.claude', 'rules', 'litter'))
    expect(start.roots.ruleDirs).toContain(join(wtPath(), '.litter'))

    // Live in state, the types ready.
    const s = liveSwarm('alpha')!
    expect(s).toEqual(expect.objectContaining({ launch, revision: 1, nonce: start.nonce, typesReady: true, readOnly: false, lost: false, state: 'live' }))
    expect(s.owner).toEqual({ ref: 'refs/litter-swarm/alpha', oid, generation: 1, session: 'sess-a' })

    // The entry, and `active`.
    const policy = await readPolicyJson()
    expect(policy!.swarm!.swarms.alpha).toEqual({
      launch,
      state: 'live',
      commonDir: join(w.dir, '.git'),
      owner: { ref: 'refs/litter-swarm/alpha', oid, generation: 1, session: 'sess-a', checkedAt: NOW / 1000 },
      nodeTypes: ['litter:sw-alpha-lead-a', 'litter:sw-alpha-docs', 'litter:sw-alpha-fixer', 'litter:sw-alpha-scout'],
    })
    expect(existsSync(activePath(w.litterDir))).toBe(true)

    // The prompt box: the start line, then the authority, one line per node, as swarm.start recorded it.
    expect(w.p.filled.length).toBe(1)
    const lines = w.p.filled[0]!.split('\n')
    expect(lines[0]).toBe('/litter:swarm start alpha')
    expect(lines.slice(1)).toEqual(['lead-a', 'docs', 'fixer', 'scout'].map(n => start.authority[n]!))
    expect(lines[1]).toStartWith('lead-a: commit yes, on feature/alpha;')
    expect(lines[2]).toStartWith('docs: commit no;')
    expect(lines[3]).toStartWith("fixer: commit yes, on its parent's branch;")
    expect(lines[4]).toStartWith('scout: commit yes, on sw/alpha/scout-<n>;')
    expect(w.p.toasts).toEqual([])
  })

  test('the beat runs from the launch: the lease file and the check time', async () => {
    const launch = await launched()
    w.p.clock.now = NOW + 10_000
    await settle(w.p)
    const oid = (await refOf())!
    const lease = JSON.parse(await w.p.fs.read(join(swarmDir(w.litterDir, 'alpha'), `owner-lease-${oid}.json`)))
    expect(lease).toEqual({ oid, swarm: 'alpha', session: 'sess-a', beatAt: NOW + 10_000 })
    expect((await readPolicyJson())!.swarm!.swarms.alpha!.owner.checkedAt).toBe((NOW + 10_000) / 1000)
    expect(launch).toBe(LAUNCH)
  })

  test("a prompt box that doesn't take the start line leaves the swarm live, and says so", async () => {
    w.p.fillAnswer = () => false
    await launched()
    expect(liveSwarm('alpha')).not.toBeNull()
    expect(w.p.toasts).toEqual(['litter: swarm alpha is live; send /litter:swarm start alpha to start it'])
  })

  test("a second Launch is refused while it's live, and while its ref exists in another session", async () => {
    await launched()
    w.p.answers.push('Launch')
    expect(await launchSwarm(w.p, 'alpha')).toEqual({ ok: false, reason: expect.stringContaining(`it's already live (launch ${LAUNCH})`) })
    const oid = await refOf()
    const q = await w.restart('sess-b')
    q.answers.push('Launch')
    const r = await launchSwarm(q, 'alpha')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining(`refs/litter-swarm/alpha exists: it's owned by session sess-a (launch ${LAUNCH})`) })
    expect(q.asked).toEqual([])
    expect(q.registeredAgents).toEqual([])
    expect(await refOf()).toBe(oid)
  })

  test('a failure after the ref cleans up first, then records launch_failed with what is left, and releases the ref (Q6)', async () => {
    w.realCleanup = true
    w.p.registerAgentAnswer = spec => {
      if (spec.name === 'sw-alpha-scout') throw new Error('agent.register: refused for the test')
    }
    await saveSwarm(w, aSpec())
    w.p.answers.push('Launch')
    const r = await launchSwarm(w.p, 'alpha')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining('the engine refused the types of scout: agent.register: refused for the test') })
    const rs = await records()
    // End's order: the cleanup's records before swarm.end, so it says what was removed and what's left.
    expect(rs.map(x => x.kind)).toEqual(['swarm.worktree.intent', 'swarm.worktree', 'swarm.worktree.removed', 'swarm.end'])
    expect(rs[3]!.body).toEqual({
      status: 'launch_failed',
      settled: true,
      reason: 'the engine refused the types of scout: agent.register: refused for the test',
      nodes: {},
      worktrees: [{ path: wtPath(), branch: 'feature/alpha', node: 'lead-a', removed: true }],
      // A `new` branch you named is kept (15.4, "Cleanup"), and the next Launch's refusal names it.
      branches: ['feature/alpha'],
    })
    expect(existsSync(wtPath())).toBe(false)
    expect(readFileSync(await writeSwarmSummary(w.p, 'alpha', LAUNCH), 'utf8')).toContain('- Branches left: feature/alpha')
    expect(w.calls.cleanups).toEqual([{ swarm: 'alpha', launch: LAUNCH }])
    expect(await refOf()).toBeNull()
    expect(leases()).toEqual([])
    expect(liveSwarm('alpha')).toBeNull()
    expect(await policyText(w)).toBeNull()
    expect(existsSync(activePath(w.litterDir))).toBe(false)
    expect(w.p.filled).toEqual([])
    expect(w.p.timers.size).toBe(0)
  })

  test('a branch switched while you confirmed fails the launch: the bound branch is the one you confirmed', async () => {
    const spec = aSpec()
    spec.nodes[1] = { ...spec.nodes[1]!, authority: { commit: true } }
    await saveSwarm(w, spec)
    const ask = w.p.ask
    w.p.ask = async (question, opts) => {
      await w.git('checkout', '-q', '-b', 'elsewhere')
      return ask(question, opts)
    }
    w.p.answers.push('Launch')
    const r = await launchSwarm(w.p, 'alpha')
    expect(w.p.asked[0]!.question).toContain('  commit yes, on main;')
    expect(r).toEqual({ ok: false, reason: expect.stringContaining(`${w.dir}, where docs commit, is on elsewhere now, not main as you confirmed`) })
    expect((await records()).map(x => x.kind)).toEqual(['swarm.worktree.intent', 'swarm.worktree', 'swarm.end'])
    expect(await refOf()).toBeNull()
  })

  test('a failure once live drops the swarm and its entry too', async () => {
    const write = launchDeps.writeSwarmPolicy
    launchDeps.writeSwarmPolicy = async (p, litterDir, name, entry) => {
      if (entry) throw new Error('policy.json: disk full')
      return write(p, litterDir, name, entry)
    }
    await saveSwarm(w, aSpec())
    w.p.answers.push('Launch')
    expect(await launchSwarm(w.p, 'alpha')).toEqual({ ok: false, reason: expect.stringContaining('the launch failed: policy.json: disk full') })
    expect((await records()).map(x => x.kind)).toEqual(['swarm.worktree.intent', 'swarm.worktree', 'swarm.start', 'swarm.end'])
    expect(liveSwarm('alpha')).toBeNull()
    expect((await readPolicyJson())?.swarm ?? null).toBeNull()
    expect(existsSync(activePath(w.litterDir))).toBe(false)
    expect(await refOf()).toBeNull()
  })

  test('no node type holds a per-instance value: no launch, nonce, session, path, instance or token', async () => {
    await launched()
    const start = (await records()).find(r => r.kind === 'swarm.start')!.body as SwarmStartBody
    for (const t of w.p.registeredAgents) {
      const text = JSON.stringify(t)
      for (const v of [LAUNCH, start.nonce, 'sess-a', w.dir, 'tok-', '#1', 'scout-1']) expect(text).not.toContain(v)
      expect(t.prompt).not.toMatch(/\{[a-z][a-z0-9_]*\}/)
    }
    // The same spec gives the same type, whatever the launch.
    for (const n of aSpec().nodes) {
      expect(nodeTypeSpec(aSpec(), n.id, { brief: BRIEFS[n.id] ?? null })).toEqual(w.p.registeredAgents.find(a => a.name === `sw-alpha-${n.id}`)!)
    }
  })
})

describe('nodeTypeSpec', () => {
  const typeOf = (node: string, brief: string | null = null): AgentSpec => nodeTypeSpec(aSpec(), node, { brief })

  test("fills the node prompt's slots from the spec, and drops an unset brief's line", () => {
    const lead = typeOf('lead-a', 'Own the parser.')
    expect(lead.prompt).toContain('You are lead-a, one agent in a swarm')
    expect(lead.prompt).toContain('<goal>\nMake the parser accept trailing commas, and document it.\n</goal>')
    expect(lead.prompt).toContain('<brief>\nOwn the parser.\n</brief>')
    expect(lead.prompt).toContain(AUTHORITY_COMMIT_YES)
    expect(lead.prompt).toContain('the lead pushes it, your own branch only, without force')
    expect(lead.prompt).toContain('litter:sw-alpha-fixer (fixer), up to 2 at once; litter:sw-alpha-scout (scout), up to 1 at once')
    expect(lead.prompt).toContain(`${REPORT_EVENT_PHRASES.blocked}, or ${REPORT_EVENT_PHRASES.done}`)
    expect(lead.prompt).toContain('addressed to main')
    expect(typeOf('lead-a').prompt).toContain('<brief>\n</brief>')
    const fixer = typeOf('fixer')
    expect(fixer.prompt).toContain(AUTHORITY_PATHS.replace('{paths}', 'src/'))
    expect(fixer.prompt).toContain(`${DELEGATION_NONE} ${DELEGATION_NO_OTHER}`)
    expect(fixer.prompt).toContain('Your report goes to your parent')
    expect(typeOf('scout').prompt).toContain('Rewriting history (rebase, reset --hard, amend): no.')
  })

  test('tools, disallowedTools, model, effort, maxTurns, permissionMode and background', () => {
    expect(typeOf('lead-a')).toEqual(expect.objectContaining({ name: 'sw-alpha-lead-a', disallowedTools: ['WebFetch'], model: 'sonnet', effort: 'high', background: true }))
    expect(typeOf('lead-a').tools).toBeUndefined()
    expect(typeOf('docs')).toEqual(expect.objectContaining({ disallowedTools: ['Agent'], maxTurns: 40 }))
    expect(typeOf('fixer')).toEqual(
      expect.objectContaining({ tools: ['Read', 'Edit', 'Bash', 'mcp__litter__record'], disallowedTools: ['Agent'], permissionMode: 'acceptEdits' }),
    )
    expect(typeOf('fixer').description).toContain('Spawned only by lead-a')
    expect(() => nodeTypeSpec(aSpec(), 'nobody', { brief: null })).toThrow("node nobody isn't in swarm alpha")
  })
})

describe('mcp__litter__swarm_read', () => {
  // FIX-T 3: a closed gate (a slow /clear rebind) is waited on only for what the hook has left.
  test('waits on a closed gate only for what its hook has left, then fails through its catch', async () => {
    closeGate()
    const start = w.p.clock.now!
    const next = Object.defineProperty(
      async () => {
        throw new Error('passed on')
      },
      'budget',
      { get: () => Object.freeze({ ms: 10_000, remainingMs: Math.max(0, 1_000 - (w.p.clock.now! - start)) }) },
    )
    const e = { tool: SWARM_READ, tool_use_id: 'tu-read', swarm: 'alpha' } as unknown as Parameters<typeof swarmReadTool>[1]
    try {
      await expect(swarmReadTool(w.p, e, next as never)).rejects.toThrow("litter: the swarm state isn't ready")
      expect(w.p.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(500)
    } finally {
      openGate()
    }
  })

  test("a draft read: J's draft with its base revision, else the saved spec", async () => {
    expect(await read({ swarm: 'alpha', draft: true })).toEqual({ ok: false, error: expect.stringContaining('no draft and was never saved') })
    await saveSwarm(w, aSpec())
    expect(await read({ swarm: 'alpha', draft: 'true' })).toEqual({ ok: true, swarm: 'alpha', draft: false, revision: 1, spec: aSpec(), briefs: BRIEFS })
    const edited = { ...aSpec(), goal: 'Something else.' }
    w.p.storeMap.set(`litter.swarm.draft.${w.litterDir}.alpha`, { base: 1, edits: [], spec: edited, briefs: {}, updatedAt: NOW })
    expect(await read({ swarm: 'alpha', draft: true })).toEqual({ ok: true, swarm: 'alpha', draft: true, revision: 1, spec: edited, briefs: {} })
  })

  test('its refusals: an agent, a bad name, a node without for, a swarm not live, and a worker re-spawned', async () => {
    expect(await read({ swarm: 'alpha', agentId: 'a1' })).toEqual({ ok: false, error: expect.stringContaining("is the lead's") })
    expect(await read({ swarm: 'Alpha!' })).toEqual({ ok: false, error: expect.stringContaining("'swarm' must be a swarm name") })
    expect(await read({ swarm: 'alpha', node: 'lead-a' })).toEqual({ ok: false, error: expect.stringContaining("'node' goes with 'for'") })
    expect(await read({ swarm: 'alpha', for: 'later', node: 'lead-a' })).toEqual({ ok: false, error: expect.stringContaining("'for' must be resume or respawn") })
    expect(await read({ swarm: 'alpha' })).toEqual({ ok: false, error: expect.stringContaining("swarm alpha isn't live") })
    await launched()
    expect(await read({ swarm: 'alpha', node: 'fixer', for: 'respawn' })).toEqual({ ok: false, error: expect.stringContaining('fixer is a worker') })
    expect(await read({ swarm: 'alpha', node: 'lead-a', for: 'resume' })).toEqual({ ok: false, error: expect.stringContaining('no instance this session can resume') })
  })

  test('a live read: the authority, the orchestrators to spawn, and each instance with its status, report, questions and queue', async () => {
    const launch = await launched()
    let r = await read({ swarm: 'alpha' })
    expect(r).toEqual(
      expect.objectContaining({
        ok: true,
        swarm: 'alpha',
        launch,
        revision: 1,
        readOnly: false,
        authority: w.p.filled[0]!.split('\n').slice(1),
        orchestrators: [
          { node: 'lead-a', subagent_type: 'litter:sw-alpha-lead-a', description: 'swarm alpha: lead-a', task: 'Split the parser change between your workers.' },
          { node: 'docs', subagent_type: 'litter:sw-alpha-docs', description: 'swarm alpha: docs', task: 'Work on your part of the goal, as your brief describes.' },
        ],
      }),
    )
    expect(r.nodes.map((n: { instances: unknown[] }) => n.instances)).toEqual([[], [], [], []])

    await bind(w, launch, { agentId: 'ag-l1', node: 'lead-a', n: 1, kind: 'orchestrator', cwd: wtPath(), branch: 'refs/heads/feature/alpha' })
    await bind(w, launch, { agentId: 'ag-f1', node: 'fixer', n: 1, kind: 'worker', cwd: wtPath(), parent: 'ag-l1', branch: 'refs/heads/feature/alpha' })
    await bind(w, launch, { agentId: 'ag-f2', node: 'fixer', n: 2, kind: 'worker', cwd: wtPath(), parent: 'ag-l1' })
    await bind(w, launch, { agentId: 'ag-c1', node: 'fixer', n: 0, kind: 'child', cwd: wtPath(), parent: 'ag-f1', of: 'ag-f1' })
    markRunning('ag-l1')
    markSettled('ag-f1')
    stop('alpha', ['ag-f2'], 'stopped (soft)')
    noteReport('ag-f1', 'The tokenizer half is done.', 'handback', NOW)
    noteQuestion('ag-l1', 'Keep the old error text?', NOW)
    const m = enqueue({ swarm: 'alpha', agentId: 'ag-f1', node: 'fixer', text: 'x'.repeat(3000), from: 'user', at: NOW })
    w.p.agents = [{ id: 'ag-f1', description: 'fixer', type: 'litter:sw-alpha-fixer', status: 'completed' } as never]
    r = await read({ swarm: 'alpha' })
    // lead-a has an instance; docs is still to spawn.
    expect(r.orchestrators.map((o: { node: string }) => o.node)).toEqual(['docs'])
    const byNode = Object.fromEntries(r.nodes.map((n: { node: string; instances: unknown[] }) => [n.node, n.instances]))
    expect(byNode['lead-a']).toEqual([{ n: 1, agentId: 'ag-l1', status: 'running', lastReport: null, openQuestions: ['Keep the old error text?'], queued: [] }])
    // fixer's two instances; its child ag-c1 isn't one.
    expect(byNode.fixer).toEqual([
      { n: 1, agentId: 'ag-f1', status: 'completed', lastReport: 'The tokenizer half is done.', openQuestions: [], queued: [{ id: m.id, text: `${'x'.repeat(1000)}…` }] },
      { n: 2, agentId: 'ag-f2', status: 'stopped', lastReport: null, openQuestions: [], queued: [] },
    ])
    expect(byNode.docs).toEqual([])
  })

  // 2.1.289's list says waiting, idle and pending, each of which would read as one of litter's own words.
  test("the list's waiting reads held, its idle between turns and its pending starting; an admitted node keeps litter's word", async () => {
    const launch = await launched()
    await bind(w, launch, { agentId: 'ag-l1', node: 'lead-a', n: 1, kind: 'orchestrator', cwd: wtPath(), branch: 'refs/heads/feature/alpha' })
    await bind(w, launch, { agentId: 'ag-f1', node: 'fixer', n: 1, kind: 'worker', cwd: wtPath(), parent: 'ag-l1' })
    await bind(w, launch, { agentId: 'ag-f2', node: 'fixer', n: 2, kind: 'worker', cwd: wtPath(), parent: 'ag-l1' })
    await bind(w, launch, { agentId: 'ag-s1', node: 'scout', n: 1, kind: 'worker', cwd: wtPath(), parent: 'ag-l1' })
    markRunning('ag-l1')
    const row = (id: string, status: string) => ({ id, description: id, type: 'litter:sw-alpha-fixer', status })
    w.p.agents = [row('ag-l1', 'waiting'), row('ag-f1', 'waiting'), row('ag-f2', 'idle'), row('ag-s1', 'pending')] as never
    const r = await read({ swarm: 'alpha' })
    const status = Object.fromEntries(
      r.nodes.flatMap((n: { instances: { agentId: string; status: string }[] }) => n.instances.map(i => [i.agentId, i.status])),
    )
    // lead-a is mid-turn on its children: admitted, so running. fixer #1's turn ended, but it holds work that wakes it.
    expect(status).toEqual({ 'ag-l1': 'running', 'ag-f1': 'held', 'ag-f2': 'between turns', 'ag-s1': 'starting' })
    // None reads as litter's own: the read-only idle, or the <swarm> block's waiting (a node with nothing to do).
    expect(Object.values(status)).not.toContain('idle')
    expect(Object.values(status)).not.toContain('waiting')
  })

  test("a session that doesn't own it reads it read-only, with nothing to spawn", async () => {
    const launch = await launched()
    await bind(w, launch, { agentId: 'ag-l1', node: 'lead-a', n: 1, kind: 'orchestrator', cwd: wtPath(), branch: 'refs/heads/feature/alpha' })
    markRunning('ag-l1')
    const authority = w.p.filled[0]!.split('\n').slice(1)
    const q = await w.restart('sess-b')
    await recoverSwarms(q, w.litterDir)
    // Another session's agents aren't in this one's list.
    q.agents = []
    const r = await read({ swarm: 'alpha' })
    expect(r).toEqual(expect.objectContaining({ ok: true, launch, readOnly: true, authority, orchestrators: [] }))
    expect(r.nodes[0].instances).toEqual([{ n: 1, agentId: 'ag-l1', status: 'running', lastReport: null, openQuestions: [], queued: [] }])
    expect(await read({ swarm: 'alpha', node: 'lead-a', for: 'respawn' })).toEqual({ ok: false, error: expect.stringContaining('owned by session sess-a') })
  })
})

/** A live swarm another launch put, to collide with. */
async function otherLive() {
  const spec: SwarmSpec = { name: 'alpha-lead', goal: 'g', nodes: [{ id: 'a', kind: 'orchestrator' }] }
  return {
    name: 'alpha-lead',
    launch: '20261001-000000',
    revision: 1,
    spec,
    nonce: 'n',
    types: {},
    typesReady: true,
    dirs: {},
    sessionCwd: w.dir,
    worktreeRoot: w.dir,
    commonDir: w.dir,
    roots: { litterDir: w.litterDir, litterCopies: [], ruleDirs: [] },
    tips: {},
    owner: { ref: 'refs/litter-swarm/alpha-lead', oid: 'x', generation: 1, session: 'sess-a' },
    state: 'live' as const,
    readOnly: false,
    lost: false,
    flags: { isolationLost: false },
    startedAt: NOW,
  }
}
