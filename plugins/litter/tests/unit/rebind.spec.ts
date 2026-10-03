// Tier 2: the rebind after a /clear (hooks/clear.ts; plan 15.4, "After
// /clear", steps 1-4), and lifecycle.ts's session lookups that a clear would
// break. A clear isn't a restart: session.end comes with reason `clear`, no
// session.start follows, the module's memory lives on, $.state is wiped, and
// the session id changes. The other packages' calls (K's types and swap, N's
// commands and panes, M's policy entry) are faked through clear.ts's
// `others`; the run, the ledgers and policy.json are real, in scratch repos.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordCtx, RecordInput } from '../../hooks/records/core'
import type { RunEndBody, RunStartReply } from '../../hooks/records/run'
import type { RunRef } from '../../hooks/lifecycle'
import type { Policy, SwarmEntry } from '../../hooks/hookfiles'
import type { AgentSpec, Ports } from '../../hooks/ports'
import type { LiveSwarm, NodeBinding, SwarmSpec } from '../../hooks/swarm/types'
import * as state from '../../hooks/swarm/state'
import { TICK_MS, holdClear, noteSessionEnd, others, rebindSettled, rebound, resetClearForTests, startSwarmTimers } from '../../hooks/clear'
import {
  consumeLifecycle,
  getPending,
  observeStop,
  onSessionEnd,
  onTurnComplete,
  openGeneration,
  patchRunPolicy,
  rebindRun,
  reconcileRuns,
  recordRunStart,
  runState,
  trySettle,
} from '../../hooks/lifecycle'
import { leaseFor, readLock, stopLease } from '../../hooks/lock'
import { readLedger } from '../../hooks/ledgercore'
import { readLaunchLedger } from '../../hooks/records/swarm'
import { modePath, policyPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { readPolicy, updatePolicy } from '../../hooks/policy'
import { ROLE_NAMES } from '../../hooks/roles'
import { session, updateSession } from '../../hooks/session'
import { atomicWriteJson } from '../../hooks/fsx'
import { fireEvery, nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// The run worlds run run.start against real git; a loaded machine takes seconds.
setDefaultTimeout(120_000)

const LAUNCH = '20270115-093000'
const pass = (async (e: unknown) => e) as never

// ---------------------------------------------------------------------------
// Worlds

type World = { p: TestPorts; dir: string; litterDir: string; projectDir: string; sid: { value: string }; ctx: RecordCtx }

const cleanups: (() => void)[] = []

beforeEach(() => {
  state.resetForTests()
  resetClearForTests()
  released.clear()
})

afterEach(() => {
  stopLease()
  state.resetForTests()
  resetClearForTests()
  updateSession({ litterDir: null })
  for (const c of cleanups.splice(0)) c()
})

/** A scratch folder with a litter directory; `repo` makes it a git repo with a plan, for run.start. */
async function world(repo = false): Promise<World> {
  const s = scratch()
  cleanups.push(s.cleanup)
  const dir = realpathSync(s.dir)
  const p = nodePorts()
  const sid = { value: 'session-a' }
  // The fake's methods read its fields when called, so these stand for the engine's.
  p.sessionId = async () => sid.value
  p.cwd = async () => dir
  const run = p.run
  p.run = (argv, init) =>
    argv[0] === 'jq' ? Promise.resolve({ code: 0, stdout: 'jq-1.7.1\n', stderr: '', truncated: false }) : run(argv, init?.cwd ? init : { ...init, cwd: dir })
  const litterDir = join(dir, '.claude', 'litter')
  if (repo) {
    const { git } = await scratchRepo(p, dir)
    await p.fs.write(join(dir, 'plan.md'), '### G1: One\nFiles: a.txt\nChecks: true\nDone when: a.txt\n')
    await git('add', 'plan.md')
    await git('commit', '-q', '-m', 'plan')
    await p.fs.write(modePath(litterDir), 'default\n')
  }
  updateSession({ litterDir })
  const projectDir = join(dir, 'project')
  mkdirSync(projectDir, { recursive: true })
  return { p, dir, litterDir, projectDir, sid, ctx: { p, caller: { agentId: null, agentType: null }, litterDir, options: normalizeOptions({ verify: ['true'] }) } }
}

async function started(w: World): Promise<RunStartReply & { ref: RunRef }> {
  const r = (await recordRunStart(w.ctx, { kind: 'run.start', workflow: 'execute', authorized: ['test'], planPath: 'plan.md' } as RecordInput)) as RunStartReply
  if (!r.ok) throw new Error(JSON.stringify(r))
  return { ...r, ref: { run: r.run, runDir: r.runDir, litterDir: w.litterDir } }
}

/** What the Workflow hook does once next(e) returned the task (launch.ts), as lifecycle.spec's. */
async function launched(w: World, taskId = 'task-1', runId = 'wf_abc123') {
  const r = await started(w)
  const pending = (await getPending(w.p, w.litterDir))!
  stopLease(pending.oid)
  await w.p.store.delete(`litter.pending.${w.litterDir}`)
  await openGeneration(w.p, r.ref, 'run.launch', { taskId, runId, scriptPath: null }, 'session-a', pending.oid)
  await patchRunPolicy(w.p, w.litterDir, r.run, x => ({ ...x, runIds: [runId] }))
  return { ...r, oid: pending.oid, taskId, runId }
}

const ledgerOf = async (w: World, ref: RunRef) => (await readLedger(w.p, ref.runDir, ref.run)).records
const lastEnd = async (w: World, ref: RunRef) => (await ledgerOf(w, ref)).filter(r => r.kind === 'run.end').at(-1)?.body as RunEndBody | undefined
const launchRecords = async (w: World, name = 'alpha') => (await readLaunchLedger(w.p, w.litterDir, name, LAUNCH)).records

/** A subagent's start line, which also tells lifecycle.ts the project folder (from its transcript path). */
const startLine = (w: World, agent: string, type = 'general-purpose') =>
  ({
    v: 1,
    ev: 'start',
    ts: 1,
    session_id: 'session-a',
    agent_id: agent,
    agent_type: type,
    cwd: w.dir,
    transcript_path: join(w.projectDir, 'session-a', 'subagents', `agent-${agent}.jsonl`),
  }) as never

// ---------------------------------------------------------------------------
// A live swarm of this session, and the fakes for the other packages

const SPEC: SwarmSpec = { name: 'alpha', goal: 'g', nodes: [{ id: 'part-a', kind: 'orchestrator' }, { id: 'fixer', kind: 'worker' }] }

function live(w: World, over: Partial<LiveSwarm> = {}): LiveSwarm {
  const name = over.name ?? 'alpha'
  return {
    name,
    launch: LAUNCH,
    revision: 2,
    spec: { ...SPEC, name },
    nonce: 'n0nce',
    types: { 'part-a': `litter:sw-${name}-part-a`, fixer: `litter:sw-${name}-fixer` },
    typesReady: true,
    dirs: {},
    sessionCwd: w.dir,
    worktreeRoot: join(w.dir, '.claude', 'worktrees'),
    commonDir: join(w.dir, '.git'),
    roots: { litterDir: w.litterDir, litterCopies: [], ruleDirs: [] },
    tips: {},
    owner: { ref: `refs/litter-swarm/${name}`, oid: 'a'.repeat(40), generation: 3, session: 'session-a' },
    state: 'live',
    readOnly: false,
    lost: false,
    flags: { isolationLost: false },
    startedAt: 1,
    ...over,
  }
}

const entry = (w: World, name: string, session: string, generation = 3): SwarmEntry => ({
  launch: LAUNCH,
  state: 'live',
  commonDir: join(w.dir, '.git'),
  owner: { ref: `refs/litter-swarm/${name}`, oid: 'a'.repeat(40), generation, session, checkedAt: 0 },
  nodeTypes: [`litter:sw-${name}-part-a`, `litter:sw-${name}-fixer`],
})

const orchestrator: NodeBinding = {
  agentId: 'orch-a',
  swarm: 'alpha',
  launch: LAUNCH,
  node: 'part-a',
  n: 1,
  kind: 'orchestrator',
  of: null,
  parent: null,
  type: 'litter:sw-alpha-part-a',
  cwd: '/repo',
  branch: null,
  token: 'tok-orch-a',
  revision: 2,
  generation: 3,
  boundAt: 1,
  adopted: false,
}

type Call = { name: string; args: unknown[]; gateOpen?: boolean; pending?: string | null }

/** Each of the other packages' calls, recorded; patchSwarmPolicy applies its change to policy.json as M's will. */
function fakes(calls: Call[]): void {
  Object.assign(others, {
    nodeTypeSpec: (spec: SwarmSpec, node: string, ctx: { brief: string | null }): AgentSpec => {
      calls.push({ name: 'nodeTypeSpec', args: [spec.name, node, ctx] })
      return { name: `sw-${spec.name}-${node}`, description: 'd', prompt: ctx.brief ?? '' }
    },
    briefTextFor: async (_p: Ports, litterDir: string, name: string, revision: number, node: string) => {
      calls.push({ name: 'briefTextFor', args: [litterDir, name, revision, node] })
      return `brief of ${node} at ${revision}`
    },
    registerSwarmCommands: async () => void calls.push({ name: 'registerSwarmCommands', args: [] }),
    refreshPanes: async (p: Ports) => {
      // After the gate opens: a hook would answer at once.
      let gateOpen = true
      const slept = (p as TestPorts).sleeps.length
      await state.ready(p)
      if ((p as TestPorts).sleeps.length > slept) gateOpen = false
      calls.push({ name: 'refreshPanes', args: [], gateOpen, pending: state.rebindPending() })
    },
    patchSwarmPolicy: async (p: Ports, litterDir: string, name: string, change: (e: SwarmEntry) => SwarmEntry | null) => {
      calls.push({ name: 'patchSwarmPolicy', args: [litterDir, name] })
      await updatePolicy(p, litterDir, policy => {
        const cur = policy.swarm?.swarms[name]
        const next = cur ? change(cur) : null
        return next ? { ...policy, swarm: { swarms: { ...policy.swarm!.swarms, [name]: next } } } : null
      })
    },
    rebindOwnership: async (_p: Ports, litterDir: string, to: string) => void calls.push({ name: 'rebindOwnership', args: [litterDir, to] }),
    startOwnerBeat: (_p: Ports, litterDir: string, name: string) => void calls.push({ name: 'startOwnerBeat', args: [litterDir, name] }),
    stopOwnerBeat: (name?: string) => void calls.push({ name: 'stopOwnerBeat', args: [name] }),
    // K's holdings: every owned swarm's ref is this process's, until a spec drops one (`released`).
    ownedSwarm: (name: string) => (released.has(name) ? null : { ref: `refs/litter-swarm/${name}`, oid: 'a'.repeat(40), generation: 3 }),
    // K's read-only refresh on the tick (Q5) has its own spec (ownership.spec.ts).
    refreshReadOnly: async () => undefined,
  })
}

/** Swarms whose ref this process no longer holds (End released it): ownedSwarm answers null for them. */
const released = new Set<string>()

/** policy.json with the swarm entries, over whatever run.start wrote (or a fresh one). */
async function swarmPolicy(w: World, swarms: Record<string, SwarmEntry>): Promise<void> {
  const cur = await readPolicy(w.p, w.litterDir)
  const base: Policy = cur ?? { v: 1, session: 'session-a', litterDir: w.litterDir, run: null, roles: {}, swarm: null }
  await atomicWriteJson(w.p, policyPath(w.litterDir), { ...base, swarm: { swarms } } satisfies Policy)
  expect((await readPolicy(w.p, w.litterDir))?.swarm?.swarms).toEqual(swarms)
}

/** This session's live swarm alpha, its orchestrator running; gamma is another session's (read-only). */
async function liveSwarms(w: World): Promise<void> {
  await swarmPolicy(w, { alpha: entry(w, 'alpha', 'session-a'), gamma: entry(w, 'gamma', 'session-x') })
  state.attach(w.p, w.litterDir)
  state.setRecordedSession('session-a')
  state.putLiveSwarm(live(w))
  state.putLiveSwarm(live(w, { name: 'gamma', readOnly: true, owner: { ref: 'refs/litter-swarm/gamma', oid: 'b'.repeat(40), generation: 1, session: 'session-x' } }))
  state.putBinding(orchestrator)
  state.markRunning('orch-a')
}

/** The engine's /clear, as register.tsx sees it: session.end `clear` (O's flag, then lifecycle's), $.state wiped, the new id. No session.start. */
async function clearTo(w: World, to: string, opts: { sessionEnd?: boolean } = {}): Promise<void> {
  const from = w.sid.value
  if (opts.sessionEnd !== false) {
    const e = { sessionId: from, reason: 'clear' } as never
    await noteSessionEnd(w.p, e)
    await onSessionEnd(w.p, e, pass)
  }
  w.p.views = {}
  w.sid.value = to
}

/** Waits a few turns of the event loop for `cond` (a tick's rebind starts after its sessionId read). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise<void>(resolve => setTimeout(resolve, 0))
  expect(cond()).toBe(true)
}

// ---------------------------------------------------------------------------
// The rebind

describe('the rebind after a /clear', () => {
  test('a live swarm and an open run: everything that names the session moves to the new one; nothing is resumed', async () => {
    const w = await world(true)
    const calls: Call[] = []
    fakes(calls)
    const r = await launched(w)
    await liveSwarms(w)
    w.p.views = { swarm: null }

    await clearTo(w, 'session-b')
    // session.end only set the flag: nothing registered, nothing rewritten.
    expect(state.rebindPending()).toBe('session-a')
    expect(calls.filter(c => c.name !== 'stopOwnerBeat')).toEqual([])
    expect(w.p.registeredAgents).toEqual([])
    expect(w.p.views).toEqual({})

    // The first litter hook after it.
    await rebound(w.p)
    await rebindSettled()

    // The roles, the tools, each owned swarm's types at its revision, and the commands, registered again.
    const agents = w.p.registeredAgents.map(a => a.name)
    for (const role of ROLE_NAMES) expect(agents).toContain(role)
    expect(agents).toContain('sw-alpha-part-a')
    expect(agents).toContain('sw-alpha-fixer')
    expect(agents.some(a => a.includes('gamma'))).toBe(false)
    expect(w.p.registeredTools.map(t => t.name).sort()).toEqual(['record', 'swarm_propose', 'swarm_read', 'swarm_send'])
    expect(session().toolsRefused).toBeNull()
    expect(calls.filter(c => c.name === 'nodeTypeSpec').map(c => c.args)).toEqual([
      ['alpha', 'part-a', { brief: 'brief of part-a at 2' }],
      ['alpha', 'fixer', { brief: 'brief of fixer at 2' }],
    ])
    expect(calls.filter(c => c.name === 'briefTextFor').map(c => c.args)).toEqual([
      [w.litterDir, 'alpha', 2, 'part-a'],
      [w.litterDir, 'alpha', 2, 'fixer'],
    ])
    expect(calls.filter(c => c.name === 'registerSwarmCommands')).toHaveLength(1)

    // policy.json names the new session, and so does this session's swarm entry (the generation kept); another session's is left.
    const policy = (await readPolicy(w.p, w.litterDir))!
    expect(policy.session).toBe('session-b')
    expect(policy.swarm?.swarms.alpha?.owner).toEqual(expect.objectContaining({ session: 'session-b', generation: 3 }))
    expect(policy.swarm?.swarms.gamma?.owner.session).toBe('session-x')
    expect(policy.run?.run).toBe(r.run)

    // K's swap, once, to the new session; the beat stopped around it and started again.
    const names = calls.map(c => c.name)
    expect(calls.filter(c => c.name === 'rebindOwnership').map(c => c.args)).toEqual([[w.litterDir, 'session-b']])
    expect(names.indexOf('stopOwnerBeat')).toBeLessThan(names.indexOf('rebindOwnership'))
    expect(names.lastIndexOf('startOwnerBeat')).toBeGreaterThan(names.indexOf('rebindOwnership'))
    expect(calls.filter(c => c.name === 'startOwnerBeat').map(c => c.args)).toEqual([[w.litterDir, 'alpha']])
    expect(state.liveSwarm('alpha')?.owner).toEqual(expect.objectContaining({ session: 'session-b', generation: 3 }))
    expect(state.liveSwarm('gamma')?.owner.session).toBe('session-x')

    // session.rebind in the launch's ledger and in the open run's, and the run's generation knows both sessions.
    expect((await launchRecords(w)).filter(x => x.kind === 'session.rebind').map(x => x.body)).toEqual([{ from: 'session-a', to: 'session-b' }])
    expect((await launchRecords(w, 'gamma')).filter(x => x.kind === 'session.rebind')).toEqual([])
    const runRecords = await ledgerOf(w, r.ref)
    expect(runRecords.filter(x => x.kind === 'session.rebind').map(x => x.body)).toEqual([{ from: 'session-a', to: 'session-b' }])
    expect(runState(runRecords).open?.sessions).toEqual(['session-a', 'session-b'])

    // The panes redrawn after the gate opened; the next <swarm> block marked; the flag down; the new id recorded.
    expect(calls.at(-1)).toEqual({ name: 'refreshPanes', args: [], gateOpen: true, pending: null })
    expect(calls.filter(c => c.name === 'refreshPanes')).toHaveLength(1)
    expect(state.takeCleared()).toBe('clear')
    expect(state.rebindPending()).toBeNull()
    expect(state.recordedSession()).toBe('session-b')

    // Nothing resumed, re-spawned, sent or submitted: the orchestrator just goes on running.
    expect(state.status('orch-a')).toBe('running')
    expect(state.binding('orch-a')).toEqual(orchestrator)
    expect(w.p.sent).toEqual([])
    expect(w.p.submitted).toEqual([])
    expect(w.p.appended).toEqual([])
    expect(w.p.toolCalls).toEqual([])
    expect(w.p.asked).toEqual([])

    // The hooks after it: nothing pending, so nothing again.
    await rebound(w.p)
    expect(calls.filter(c => c.name === 'rebindOwnership')).toHaveLength(1)
    expect((await launchRecords(w)).filter(x => x.kind === 'session.rebind')).toHaveLength(1)
  })

  test("with or without a classic SessionStart (source clear), the rebind is the same: litter hooks none", async () => {
    // On a managed machine no classic.* hook reaches a user mod; elsewhere the
    // engine runs SessionStart's command hooks and mod classic.SessionStart
    // hooks after a clear. litter has neither (tier 1, clear.test.ts, shows
    // $.classic.SessionStart passing litter by), so what the rebind does can't
    // depend on it; this pins the half that lives in hooks.json.
    const hooks = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', 'hooks', 'hooks.json'), 'utf8')) as { hooks: Record<string, unknown> }
    expect(Object.keys(hooks.hooks)).not.toContain('SessionStart')
    const register = readFileSync(join(import.meta.dir, '..', '..', 'hooks', 'register.tsx'), 'utf8')
    expect(register).not.toMatch(/on\(\s*'classic\./)
  })

  test('a swarm alone (no run): policy.json and the launch move; no run ledger is touched', async () => {
    const w = await world()
    const calls: Call[] = []
    fakes(calls)
    await liveSwarms(w)
    await clearTo(w, 'session-b')
    await rebound(w.p)
    await rebindSettled()
    expect((await readPolicy(w.p, w.litterDir))?.session).toBe('session-b')
    expect((await launchRecords(w)).map(x => x.kind)).toEqual(['session.rebind'])
    expect(state.takeCleared()).toBe('clear')
  })

  test("a run alone: policy.json and the run's ledger move, and no <swarm> block is marked", async () => {
    const w = await world(true)
    const calls: Call[] = []
    fakes(calls)
    const r = await launched(w)
    state.attach(w.p, w.litterDir)
    state.setRecordedSession('session-a')
    await clearTo(w, 'session-b')
    await rebound(w.p)
    await rebindSettled()
    expect((await readPolicy(w.p, w.litterDir))?.session).toBe('session-b')
    expect((await ledgerOf(w, r.ref)).filter(x => x.kind === 'session.rebind').map(x => x.body)).toEqual([{ from: 'session-a', to: 'session-b' }])
    expect(calls.filter(c => c.name === 'rebindOwnership')).toHaveLength(1)
    expect(calls.filter(c => c.name === 'patchSwarmPolicy' || c.name === 'startOwnerBeat')).toEqual([])
    // Only a live swarm's <swarm> block reads it; with none, a later swarm's first block would say it wrongly.
    expect(state.takeCleared()).toBeNull()
  })

  test("an entry another session took over since (a newer generation) isn't rewritten", async () => {
    const w = await world()
    const calls: Call[] = []
    fakes(calls)
    await liveSwarms(w)
    await swarmPolicy(w, { alpha: entry(w, 'alpha', 'session-x', 4) })
    await clearTo(w, 'session-b')
    await rebound(w.p)
    await rebindSettled()
    expect((await readPolicy(w.p, w.litterDir))?.swarm?.swarms.alpha?.owner).toEqual(expect.objectContaining({ session: 'session-x', generation: 4 }))
  })

  test("a hook between session.end and the switch to the new id rebinds nothing yet; the first one after does", async () => {
    const w = await world()
    const calls: Call[] = []
    fakes(calls)
    await liveSwarms(w)
    const e = { sessionId: 'session-a', reason: 'clear' } as never
    await noteSessionEnd(w.p, e)
    await rebound(w.p)
    expect(state.rebindPending()).toBe('session-a')
    expect(calls).toEqual([])
    expect(w.p.registeredAgents).toEqual([])

    w.sid.value = 'session-b'
    await rebound(w.p)
    await rebindSettled()
    expect(state.rebindPending()).toBeNull()
    expect((await readPolicy(w.p, w.litterDir))?.session).toBe('session-b')
  })

  test('with nothing pending, a hook costs one check: not even the session id is read', async () => {
    const w = await world()
    let reads = 0
    w.p.sessionId = async () => {
      reads++
      return w.sid.value
    }
    await rebound(w.p)
    await rebound(w.p)
    expect(reads).toBe(0)
  })

  test('the gate holds the other hooks while the rebind runs, and the first caller runs it once', async () => {
    const w = await world()
    const calls: Call[] = []
    fakes(calls)
    await liveSwarms(w)
    await clearTo(w, 'session-b')

    let release!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    let briefs = 0
    others.briefTextFor = async () => {
      briefs++
      await blocked
      return null
    }
    const order: string[] = []
    const first = rebound(w.p).then(() => order.push('first'))
    await until(() => briefs === 1)

    // A second hook arrives mid-rebind: it waits on the gate, polling with p.sleep(25).
    w.p.onSleep = () => {
      if (w.p.sleeps.length === 3) {
        order.push('released')
        release()
      }
    }
    const second = rebound(w.p).then(() => order.push('second'))
    await Promise.all([first, second])
    await rebindSettled()

    expect(w.p.sleeps.length).toBeGreaterThanOrEqual(3)
    expect(new Set(w.p.sleeps)).toEqual(new Set([state.READY_POLL_MS]))
    expect(order.indexOf('released')).toBeLessThan(order.indexOf('second'))
    // One rebind: the roles registered once, one swap, one record.
    expect(w.p.registeredAgents.filter(a => a.name === ROLE_NAMES[0])).toHaveLength(1)
    expect(calls.filter(c => c.name === 'rebindOwnership')).toHaveLength(1)
    expect((await launchRecords(w)).filter(x => x.kind === 'session.rebind')).toHaveLength(1)
    // Open again: a hook now answers at once.
    const slept = w.p.sleeps.length
    await state.ready(w.p)
    expect(w.p.sleeps.length).toBe(slept)
  })

  test('a step that fails is logged, the rest still run, and the gate reopens', async () => {
    const w = await world()
    const calls: Call[] = []
    fakes(calls)
    await liveSwarms(w)
    others.rebindOwnership = async () => {
      throw new Error('ref moved')
    }
    others.nodeTypeSpec = () => {
      throw new Error('bad spec')
    }
    w.p.registerToolAnswer = spec => {
      if (spec.name === 'record') throw new Error('tool refused')
    }
    await clearTo(w, 'session-b')
    await rebound(w.p)
    await rebindSettled()

    expect(w.p.logs).toContain('/clear rebind: the ownership swap failed: ref moved')
    expect(w.p.logs).toContain('/clear rebind: swarm alpha type part-a failed: bad spec')
    expect(w.p.logs).toContain('/clear rebind: swarm alpha type fixer failed: bad spec')
    // registerRecordTool answers a refusal rather than throwing: session.ts keeps it for the board.
    expect(session().toolsRefused).toBe('tool refused')
    // The swap failed, so the swarm's own memory still names the old session; the beat starts again regardless.
    expect(state.liveSwarm('alpha')?.owner.session).toBe('session-a')
    expect(calls.filter(c => c.name === 'startOwnerBeat')).toHaveLength(1)
    // The steps after it ran.
    expect((await readPolicy(w.p, w.litterDir))?.session).toBe('session-b')
    expect((await launchRecords(w)).filter(x => x.kind === 'session.rebind')).toHaveLength(1)
    expect(state.takeCleared()).toBe('clear')
    expect(calls.at(-1)?.name).toBe('refreshPanes')
    expect(state.rebindPending()).toBeNull()
    const slept = w.p.sleeps.length
    await state.ready(w.p)
    expect(w.p.sleeps.length).toBe(slept)
  })

  test("the panes' redraw failing is logged after the gate opened", async () => {
    const w = await world()
    const calls: Call[] = []
    fakes(calls)
    await liveSwarms(w)
    others.refreshPanes = async () => {
      throw new Error('no pane')
    }
    await clearTo(w, 'session-b')
    await rebound(w.p)
    await rebindSettled()
    expect(w.p.logs).toContain('/clear rebind: the panes failed: no pane')
    expect(state.takeCleared()).toBe('clear')
  })
})

describe('session.end', () => {
  test("a clear only sets the flag; any other end stops every owner beat and sets none", async () => {
    const w = await world()
    const calls: Call[] = []
    fakes(calls)
    await noteSessionEnd(w.p, { sessionId: 'session-a', reason: 'clear' } as never)
    expect(state.rebindPending()).toBe('session-a')
    expect(calls).toEqual([])

    state.clearRebind()
    await noteSessionEnd(w.p, { sessionId: 'session-a', reason: 'prompt_input_exit' } as never)
    expect(state.rebindPending()).toBeNull()
    expect(calls).toEqual([{ name: 'stopOwnerBeat', args: [undefined] }])
  })

  test("lifecycle's onSessionEnd stops the lease beat only when the reason isn't clear", async () => {
    const w = await world(true)
    await started(w)
    const oid = (await getPending(w.p, w.litterDir))!.oid
    expect(leaseFor(oid)?.stopped).toBe(false)
    // Another session's end, so the pending launch (this session's) isn't ended, and its own beat with it.
    await onSessionEnd(w.p, { sessionId: 'session-other', reason: 'clear' } as never, pass)
    expect(leaseFor(oid)?.stopped).toBe(false)
    await onSessionEnd(w.p, { sessionId: 'session-other', reason: 'logout' } as never, pass)
    expect(leaseFor(oid)).toBeUndefined()
  })
})

describe('the tick', () => {
  test('a session id that moved with no session.end the mod saw starts the rebind', async () => {
    const w = await world()
    const calls: Call[] = []
    fakes(calls)
    await liveSwarms(w)
    startSwarmTimers(w.p)
    startSwarmTimers(w.p)
    expect(w.p.timers.size).toBe(1)
    expect(TICK_MS).toBe(2000)

    // The id hasn't moved: nothing.
    await fireEvery(w.p)
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(calls).toEqual([])

    // Backgrounding, or a clear whose session.end never reached the mod.
    await clearTo(w, 'session-b', { sessionEnd: false })
    await fireEvery(w.p)
    await until(() => state.recordedSession() === 'session-b')
    await rebindSettled()
    expect((await readPolicy(w.p, w.litterDir))?.session).toBe('session-b')
    expect((await launchRecords(w)).filter(x => x.kind === 'session.rebind').map(x => x.body)).toEqual([{ from: 'session-a', to: 'session-b' }])
    expect(calls.filter(c => c.name === 'rebindOwnership').map(c => c.args)).toEqual([[w.litterDir, 'session-b']])
    expect(state.rebindPending()).toBeNull()
    // No clear was seen, so the block says the session moved, not that it was cleared.
    expect(state.takeCleared()).toBe('session-moved')
  })

  test('a /clear the hold passed on, whose session.end never came, still marks the block cleared', async () => {
    const w = await world()
    fakes([])
    await liveSwarms(w)
    startSwarmTimers(w.p)
    const r = await holdClear(w.p, { command: 'clear', args: '' } as never, (async () => ({ text: 'engine cleared' })) as never)
    expect(r).toEqual({ text: 'engine cleared' })
    await clearTo(w, 'session-b', { sessionEnd: false })
    await fireEvery(w.p)
    await until(() => state.recordedSession() === 'session-b')
    await rebindSettled()
    expect(state.takeCleared()).toBe('clear')
  })

  test('a rebind flag the tick finds first runs from the tick too', async () => {
    const w = await world()
    const calls: Call[] = []
    fakes(calls)
    await liveSwarms(w)
    startSwarmTimers(w.p)
    await clearTo(w, 'session-b')
    await fireEvery(w.p)
    await until(() => state.rebindPending() === null)
    await rebindSettled()
    expect((await launchRecords(w)).filter(x => x.kind === 'session.rebind')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// lifecycle.ts's lookups by session, after a clear

describe("a run's sessions after a /clear (lifecycle.ts)", () => {
  test("runState: each session.rebind of the open generation, once each, none after its run.end", async () => {
    const w = await world(true)
    const r = await launched(w)
    expect(await rebindRun(w.p, w.litterDir, 'session-a', 'session-b', ['session-a'])).toBe(r.run)
    expect(await rebindRun(w.p, w.litterDir, 'session-b', 'session-c', ['session-a', 'session-b'])).toBe(r.run)
    // The same pair again (a second rebind attempt) records nothing new.
    expect(await rebindRun(w.p, w.litterDir, 'session-b', 'session-c', ['session-a', 'session-b'])).toBe(r.run)
    const records = await ledgerOf(w, r.ref)
    expect(records.filter(x => x.kind === 'session.rebind').map(x => x.body)).toEqual([
      { from: 'session-a', to: 'session-b' },
      { from: 'session-b', to: 'session-c' },
    ])
    expect(runState(records).open?.sessions).toEqual(['session-a', 'session-b', 'session-c'])

    // Ended: nothing to rebind.
    w.sid.value = 'session-c'
    expect(await observeStop(w.p, r.taskId)).toBe(true)
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ status: 'stopped' }))
    expect(await rebindRun(w.p, w.litterDir, 'session-c', 'session-d', ['session-a', 'session-b', 'session-c'])).toBeNull()
    expect((await ledgerOf(w, r.ref)).filter(x => x.kind === 'session.rebind')).toHaveLength(2)
  })

  test("another session's run is left alone", async () => {
    const w = await world(true)
    const r = await launched(w)
    expect(await rebindRun(w.p, w.litterDir, 'session-x', 'session-b', ['session-x'])).toBeNull()
    expect((await ledgerOf(w, r.ref)).filter(x => x.kind === 'session.rebind')).toEqual([])
  })

  test("the engine's snapshot under the session a clear moved the run to is found by a later reconcile", async () => {
    const w = await world(true)
    const r = await launched(w)
    await consumeLifecycle({ p: w.p, litterDir: w.litterDir, sessionId: 'session-a' }, startLine(w, 'x'))
    w.sid.value = 'session-b'
    await rebindRun(w.p, w.litterDir, 'session-a', 'session-b', ['session-a'])
    // The engine wrote it under the id current when the run finished.
    await atomicWriteJson(w.p, join(w.projectDir, 'session-b', 'workflows', `${r.runId}.json`), { status: 'completed', result: { halted: null } })
    // A restart after that: reconcile runs under yet another id.
    w.sid.value = 'session-c'
    await reconcileRuns(w.p, w.litterDir)
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ status: 'done', source: 'reconcile' }))
  })

  test('a stop holds for the snapshot the engine will write under the new session, then settles from it', async () => {
    const w = await world(true)
    const r = await launched(w)
    await consumeLifecycle({ p: w.p, litterDir: w.litterDir, sessionId: 'session-a' }, startLine(w, 'x'))
    w.sid.value = 'session-b'
    await rebindRun(w.p, w.litterDir, 'session-a', 'session-b', ['session-a'])
    // The engine keeps workflows under the new session's folder only.
    mkdirSync(join(w.projectDir, 'session-b', 'workflows'), { recursive: true })
    expect(await observeStop(w.p, r.taskId)).toBe(true)
    expect(await lastEnd(w, r.ref)).toBeUndefined()
    expect((await readPolicy(w.p, w.litterDir))?.run?.stopping).toBe(true)

    await atomicWriteJson(w.p, join(w.projectDir, 'session-b', 'workflows', `${r.runId}.json`), { status: 'killed' })
    expect(await trySettle(w.p, r.ref)).toBe(true)
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ status: 'stopped', settled: true }))
  })

  test("a pending launch the clear's session.end never ended becomes the new session's, and its main turn.complete releases it", async () => {
    const w = await world(true)
    const r = await started(w)
    w.sid.value = 'session-b'
    // Before the rebind, the new session's turn.complete doesn't see it as its own.
    await onTurnComplete(w.p, { reason: 'answer' } as never, pass)
    expect(await readLock(w.p, w.dir)).not.toBeNull()

    expect(await rebindRun(w.p, w.litterDir, 'session-a', 'session-b', ['session-a'])).toBe(r.run)
    expect((await getPending(w.p, w.litterDir))?.session).toBe('session-b')
    await onTurnComplete(w.p, { reason: 'answer' } as never, pass)
    expect(await readLock(w.p, w.dir)).toBeNull()
    expect(await getPending(w.p, w.litterDir)).toBeNull()
    expect(await lastEnd(w, r.ref)).toEqual(expect.objectContaining({ generation: 0, status: 'launch_failed', reason: 'not launched' }))
  })

  test("another session's pending launch keeps its session", async () => {
    const w = await world(true)
    await started(w)
    await rebindRun(w.p, w.litterDir, 'session-x', 'session-b', ['session-x'])
    expect((await getPending(w.p, w.litterDir))?.session).toBe('session-a')
  })
})
