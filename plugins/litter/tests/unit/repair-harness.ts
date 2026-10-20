// The world Y's tier-2 specs share (gate, repairland; WP-Y): a scratch
// repository holding a fanout whose two writers merged cleanly and failed
// verify together, its first generation halted, and its second opened for a
// repair swarm, which is live in state.ts with its three nodes bound in the
// kept integration worktree. The records W's reopen and X's bridge would
// write are appended directly (COMMON, "Another package's module"), and
// main's runVerify, which this branch doesn't have, is stood in for by
// `standInVerify`: the same snapshot, run and append, on real files. Not a
// spec itself.

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ports } from '../../hooks/ports'
import type { Caller, RecordCtx, RecordError, RecordReply, StoredRecord } from '../../hooks/records/core'
import type { RunJson, RunRepairBody } from '../../hooks/records/run'
import type { VerifyBody, VerifyReply } from '../../hooks/records/execute'
import type { IntegrateReply, WorktreeCreateBody } from '../../hooks/records/fanout'
import type { RunFacts, VerifyRan, VerifyRun } from '../../hooks/verify'
import type { LiveSwarm, NodeBinding, SwarmNode, SwarmSpec } from '../../hooks/swarm/types'
import type { SwarmGateKind } from '../../hooks/swarm/gate'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { normalizeOptions } from '../../hooks/options'
import { verifyLogDir } from '../../hooks/layout'
import { snapshot } from '../../hooks/snapshot'
import { isGreen } from '../../hooks/verify'
import { recordIntegrate } from '../../hooks/integrate'
import { readLaunchLedger, newLaunchId } from '../../hooks/records/swarm'
import { deps as gateDeps, resetGateForTests, swarmGateRecord } from '../../hooks/swarm/gate'
import { updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import * as admit from '../../hooks/swarm/admit'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'
import { startedRunJson } from './support/runjson'

export const RUN = '20261003-repair'
export const REF = `refs/heads/litter/${RUN}`
export const BRANCH = `litter/${RUN}`
export const IB = `litter/${RUN}-integration`
export const SWARM = 'repair-abc123'
export const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)
const WF = 'wf_1a2b3c4d-5e6'
const MOD = { source: 'mod' } as const
const RELAY: Caller = { agentId: 'relay-1', agentType: 'litter:relay' }
const RO = { deny: ['Edit', 'Write', 'NotebookEdit'] }

/** a owns the server, b the client and the README; r only reads. */
export const TASKS = [
  { id: 'a', title: 'Server', text: 'serve it', writes: true, files: ['pkgA/'] },
  { id: 'b', title: 'Client', text: 'call it', writes: true, files: ['pkgB/', 'README.md'] },
  { id: 'r', title: 'Read', text: 'find out', writes: false, files: [] as string[] },
]
export const OWNED = ['pkgA/', 'pkgB/', 'README.md']

/** The repair spec X's repairSpec makes (its report to Y): an orchestrator that writes nothing, a committing fixer, a critic. */
export function repairSpec(integration: string, over: Partial<Record<'repair' | 'fixer' | 'critic', Partial<SwarmNode>>> = {}): SwarmSpec {
  return {
    name: SWARM,
    goal: `Repair run ${RUN}`,
    nodes: [
      {
        id: 'repair',
        kind: 'orchestrator',
        worktree: { existing: integration },
        tools: RO,
        authority: { verify: true, land: true, push: 'none' },
        paths: OWNED,
        spawns: { fixer: 2, critic: 1 },
        ...over.repair,
      },
      { id: 'fixer', kind: 'worker', worktree: 'inherit', serial: true, authority: { commit: true, verify: true, push: 'none' }, paths: OWNED, ...over.fixer },
      {
        id: 'critic',
        kind: 'worker',
        worktree: 'inherit',
        verdicts: true,
        tools: RO,
        authority: { commit: false, verify: true, push: 'none' },
        spawnOther: false,
        ...over.critic,
      },
    ],
    limits: { maxAgentsAtOnce: 4 },
  }
}

export const typeOf = (node: string): string => `litter:sw-${SWARM}-${node}`

/** The scratch world. Every field is set by `repairWorld()`. */
export type World = {
  p: TestPorts
  dir: string
  litterDir: string
  runDir: string
  root: string
  base: string
  integration: string
  launch: string
  git: (...argv: string[]) => Promise<string>
  gitIn: (at: string, ...argv: string[]) => Promise<string>
  cleanup: () => void
  /** The run.repair record that opened generation 2. */
  gen: StoredRecord<RunRepairBody>
}

export function write(at: string, path: string, text: string): void {
  mkdirSync(join(at, path, '..'), { recursive: true })
  writeFileSync(join(at, path), text)
}

/**
 * The run's verify passes once the client calls the server's renamed route:
 * red on the integrated tree, green once a fixer commits `fixed` into pkgB.
 */
export const VERIFY = ['sh', '-c', 'grep -q fixed pkgB/b.ts']

async function writeRun(w: Pick<World, 'p' | 'runDir' | 'base' | 'dir'>): Promise<void> {
  const json: RunJson = {
    v: 1,
    run: RUN,
    workflow: 'fanout',
    args: { run: RUN, tasks: TASKS.map(t => ({ ...t, rules: [] })), contract: '', mergeOrder: ['a', 'b'] },
    authorized: [],
    mode: 'auto',
    verify: VERIFY,
    goalCheck: null,
    setup: null,
    linkDirs: [],
    base: w.base,
    ref: REF,
    checkout: w.dir,
    isolate: false,
    previousBranch: 'main',
    continueOf: null,
    amendOf: null,
    rules: [],
    planPath: null,
    planSha256: null,
    session: 'test-session',
    created: 0,
    repair: { mode: 'auto', rounds: 3, agents: 6 },
  }
  await startedRunJson(w.p, w.runDir, json)
}

/**
 * The fanout, its first generation and the reopen: two writers merged by the
 * integrate record itself, a red integration verify and a rejecting verdict,
 * run.end halted, then run.repair for generation 2 naming the swarm.
 */
export async function repairWorld(opts: { live?: Partial<LiveSwarm>; spec?: SwarmSpec } = {}): Promise<World> {
  state.resetForTests()
  admit.resetForTests()
  resetGateForTests()
  const p = nodePorts()
  const repo = scratch()
  const dir = realpathSync(repo.dir)
  const { git } = await scratchRepo(p, dir)
  const base = (await git('rev-parse', 'HEAD')).trim()
  await git('switch', '-q', '-c', BRANCH)
  const litterDir = join(dir, '.claude', 'litter')
  const runDir = join(litterDir, RUN)
  const root = join(dir, '.claude', 'worktrees')
  const gitIn = async (at: string, ...argv: string[]): Promise<string> => {
    const r = await p.run(['git', ...argv], { cwd: at })
    if (r.code !== 0) throw new Error(`git ${argv.join(' ')}: ${r.stderr.trim()}`)
    return r.stdout
  }
  await writeRun({ p, runDir, base, dir })
  const append = (kind: string, body: unknown, by: StoredRecord['by'] = MOD) => appendRecord(p, runDir, { run: RUN, kind, by, body })

  await append('run.launch', { taskId: 'task-1', runId: WF, scriptPath: null, generation: 1, session: 'test-session', oid: '1'.repeat(40) })
  const addWorktree = async (name: string, branch: string): Promise<string> => {
    const path = join(root, name)
    await git('worktree', 'add', '-q', '-b', branch, path, base)
    const body: WorktreeCreateBody = { run: RUN, name, path, branch, base, disposable: false, ignored: [] }
    await append('worktree.create', body)
    return path
  }
  const integration = await addWorktree(`litter-${RUN}-integration`, IB)
  const writer = async (task: string, n: number, files: Record<string, string>): Promise<void> => {
    const name = `${WF}-${n}`
    const branch = `litter/${RUN}-w${n}`
    const path = await addWorktree(name, branch)
    for (const [f, text] of Object.entries(files)) write(path, f, text)
    await gitIn(path, 'add', '-A')
    await gitIn(path, 'commit', '-q', '-m', `${RUN} ${task}`)
    const by = { source: 'agent' as const, agentId: `writer-${n}`, agentType: 'litter:executor' }
    await append('task.bind', { task, worktree: { name, path, branch } }, by)
    await append('task.result', { task, role: 'executor', tool_use_id: `tu-${n}`, result: { status: 'done', files: Object.keys(files), checks: [], summary: 'done', notes: '' } }, by)
  }
  await writer('a', 1, { 'pkgA/a.ts': 'export const route = "/v2/items"\n' })
  await writer('b', 2, { 'pkgB/b.ts': 'fetch("/v1/items")\n', 'README.md': 'client and server\n' })
  const ctx: RecordCtx = { p, caller: RELAY, litterDir, options: normalizeOptions({}) }
  const r = (await recordIntegrate(ctx, { kind: 'integrate', run: RUN })) as unknown as IntegrateReply
  if (r.status !== 'merged' || !r.tree) throw new Error(`the harness's integration didn't merge: ${JSON.stringify(r)}`)
  // The verifier's red verify and its rejection, then the run's halt (generation 1).
  const verifier = { source: 'agent' as const, agentId: 'verifier-1', agentType: 'litter:verifier' }
  await append(
    'verify',
    {
      verify_id: 'integration-1-aaaaaaaaaa', gate: 'integration', attempt: 1, argv: VERIFY, tree_before: r.tree, tree_after: r.tree, dirty_submodules: [],
      exit_code: 1, signal: null, timed_out: false, spawn_error: null, green: false, log_parts: 0, log_bytes: 0, output_tail: '',
    } satisfies VerifyBody,
    verifier,
  )
  await append('verdict', { verify_id: 'integration-1-aaaaaaaaaa', tasks: TASKS.map(t => ({ id: t.id, pass: t.id !== 'b', evidence: 'read it', gaps: t.id === 'b' ? ['calls /v1'] : [] })), combined: 'the client calls the old route' }, verifier)
  await append('run.end', { taskId: 'task-1', generation: 1, status: 'halted', reason: 'not verified', source: 'notification' })

  p.clock.now = NOW
  updateSession({ litterDir })
  const launch = await newLaunchId(p, litterDir, SWARM)
  const gen = (await append('run.repair', { generation: 2, swarm: SWARM, launch, budget: { rounds: 3, agents: 6 } } satisfies RunRepairBody)) as StoredRecord<RunRepairBody>

  const spec = opts.spec ?? repairSpec(integration)
  state.putLiveSwarm(liveSwarm({ dir, litterDir, root, integration, launch, spec }, opts.live))
  const w: World = { p, dir, litterDir, runDir, root, base, integration, launch, git, gitIn, cleanup: repo.cleanup, gen }
  bind(w, 'orch-1', 'repair', { kind: 'orchestrator', n: 1, parent: null })
  bind(w, 'fix-1', 'fixer', { branch: `refs/heads/${IB}` })
  bind(w, 'crit-1', 'critic')
  return w
}

function liveSwarm(
  w: { dir: string; litterDir: string; root: string; integration: string; launch: string; spec: SwarmSpec },
  over: Partial<LiveSwarm> = {},
): LiveSwarm {
  return {
    name: SWARM,
    launch: w.launch,
    revision: 1,
    spec: w.spec,
    nonce: 'n'.repeat(32),
    types: Object.fromEntries(w.spec.nodes.map(n => [n.id, typeOf(n.id)])),
    typesReady: true,
    dirs: { repair: { dir: w.integration, branch: `refs/heads/${IB}`, created: false } },
    sessionCwd: w.dir,
    worktreeRoot: w.root,
    commonDir: join(w.dir, '.git'),
    roots: { litterDir: w.litterDir, litterCopies: [w.litterDir], ruleDirs: [] },
    tips: {},
    owner: { ref: `refs/litter-swarm/${SWARM}`, oid: 'a'.repeat(40), generation: 1, session: 'test-session' },
    state: 'live',
    readOnly: false,
    lost: false,
    flags: { isolationLost: false },
    startedAt: NOW,
    run: { runDir: join(w.litterDir, RUN), run: RUN, generation: 2 },
    budget: { rounds: 3, agents: 6 },
    ...over,
  }
}

/** A node bound in the integration worktree (a worker of the orchestrator unless `over` says otherwise). */
export function bind(w: World, agentId: string, node: string, over: Partial<NodeBinding> = {}): NodeBinding {
  const b: NodeBinding = {
    agentId,
    swarm: SWARM,
    launch: w.launch,
    node,
    n: 1,
    kind: 'worker',
    of: null,
    parent: 'orch-1',
    type: typeOf(node),
    cwd: w.integration,
    branch: null,
    token: `tok-${agentId}`,
    revision: 1,
    generation: 1,
    boundAt: NOW,
    adopted: false,
    ...over,
  }
  state.putBinding(b)
  return b
}

// ---------------------------------------------------------------------------
// runVerify, stood in for

/** What the stand-in was asked. */
export const verifyCalls: VerifyRun[] = []

/**
 * verify.ts's runVerify, quicker: the run's stored argv in `o.where`, a
 * snapshot before and after, the record appended as `o.by`. No log parts: the
 * tail is the output. "the real runVerify" in gate.spec.ts runs the real one.
 */
export async function standInVerify(p: Ports, f: RunFacts, o: VerifyRun): Promise<VerifyRan | RecordError> {
  verifyCalls.push(o)
  const argv = o.gate === 'goal' ? f.json.goalCheck : f.json.verify
  if (!Array.isArray(argv) || argv.length === 0) return { ok: false, error: `litter: run ${f.run} has no verify argv in run.json`, field: 'run' }
  const verifyId = `${o.gate}-${o.attempt}-${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}`
  const before = await snapshot(p, o.where)
  const ran = await p.run([...argv], { cwd: o.where })
  const after = await snapshot(p, o.where)
  const body: VerifyBody = {
    verify_id: verifyId,
    gate: o.gate,
    attempt: o.attempt,
    argv: [...argv],
    tree_before: before.tree,
    tree_after: after.tree,
    dirty_submodules: [...new Set([...before.dirty_submodules, ...after.dirty_submodules])].sort(),
    exit_code: ran.code,
    signal: null,
    timed_out: false,
    spawn_error: null,
    green: false,
    log_parts: 0,
    log_bytes: 0,
    output_tail: `${ran.stdout}${ran.stderr}`,
  }
  body.green = isGreen(body)
  const rec = await appendRecord(p, f.runDir, { run: f.run, kind: 'verify', by: o.by, body })
  return { ok: true, body, seq: rec.seq, log: verifyLogDir(f.runDir, verifyId) }
}

const realVerify = gateDeps.runVerify
export const useStandIn = (): void => {
  verifyCalls.length = 0
  gateDeps.runVerify = standInVerify
}
export const restoreVerify = (): void => {
  gateDeps.runVerify = realVerify
}

// ---------------------------------------------------------------------------
// Calls and reads

/** A bound node's record call, as the dispatcher hands it to the gate (its agent map type is its binding's). */
export function gate(w: World, kind: SwarmGateKind, agentId: string, fields: Record<string, unknown> = {}): Promise<RecordReply> {
  const b = state.binding(agentId)
  if (!b) throw new Error(`no binding for ${agentId}`)
  return swarmGateRecord(w.p, { kind, input: { kind, ...fields }, caller: { agentId, agentType: b.type }, binding: b, litterDir: w.litterDir, options: normalizeOptions({}) })
}

export const ALL_PASS = TASKS.map(t => ({ id: t.id, pass: true, evidence: 'ran the contract check', gaps: [] as string[] }))
export const B_FAILS = TASKS.map(t => ({ id: t.id, pass: t.id !== 'b', evidence: 'ran the contract check', gaps: t.id === 'b' ? ['still calls /v1'] : [] }))

/** The fixer's commit on the integration branch, in the integration worktree. */
export async function fixerCommits(w: World, files: Record<string, string> = { 'pkgB/b.ts': 'fetch("/v2/items") // fixed\n' }): Promise<string> {
  for (const [f, text] of Object.entries(files)) write(w.integration, f, text)
  await w.gitIn(w.integration, 'add', '-A')
  await w.gitIn(w.integration, 'commit', '-q', '-m', 'fix the client route')
  return (await w.gitIn(w.integration, 'rev-parse', 'HEAD')).trim()
}

/** The critic's green verify of the committed tip, as the gate answers it. */
export async function criticVerifies(w: World, agentId = 'crit-1'): Promise<VerifyReply> {
  const v = await gate(w, 'verify', agentId)
  if (!v.ok) throw new Error(`the critic's verify was refused: ${JSON.stringify(v)}`)
  return v as VerifyReply
}

/** The critic's verdict through the gate. */
export const judge = (w: World, verifyId: string, tasks: unknown = ALL_PASS, agentId = 'crit-1', extra: Record<string, unknown> = {}) =>
  gate(w, 'verdict', agentId, { verify_id: verifyId, tasks, combined: 'the client and server agree on /v2', ...extra })

/** Fixed, verified green and approved: what the orchestrator then lands. */
export async function approved(w: World): Promise<{ verifyId: string; tip: string }> {
  const tip = await fixerCommits(w)
  const v = await criticVerifies(w)
  if (!v.green) throw new Error(`the critic's verify isn't green: ${v.output_tail}`)
  const r = await judge(w, v.verify_id)
  if (!r.ok) throw new Error(`the verdict was refused: ${JSON.stringify(r)}`)
  return { verifyId: v.verify_id, tip }
}

export const runRecords = async (w: World): Promise<StoredRecord[]> => (await readLedger(w.p, w.runDir, RUN)).records
export const runKinds = async (w: World): Promise<string[]> => (await runRecords(w)).map(r => r.kind)
export const gateEvents = async (w: World): Promise<Record<string, unknown>[]> =>
  (await readLaunchLedger(w.p, w.litterDir, SWARM, w.launch)).records.filter(r => r.kind === 'swarm.event' && r.body.kind === 'gate').map(r => r.body)

export function teardown(w: World | null): void {
  restoreVerify()
  state.resetForTests()
  admit.resetForTests()
  resetGateForTests()
  updateSession({ litterDir: null })
  w?.cleanup()
}
