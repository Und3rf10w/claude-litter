// Tier 2: ending a repair swarm (hooks/swarm/end.ts; WP-Z, COMMON 2b-2 step
// 7): finish, in any End mode, calls W's endRepairGeneration after swarm.end
// and the policy removal, `done` when a land was recorded in the generation
// (the launch ledger's gate mirror or the run's own ledger) and `halted`
// otherwise; a plain swarm's End never calls it; an end the run already has
// (reconcile was first) or a failing call leaves the swarm's end as it is.
// summary.md's repair part lists the gate records, the rounds and the budget
// used and left, and the hand-off names the run's own summary.md.
//
// W's endRepairGeneration is a stub in this worktree: the `others` seam
// stands in for it, and for M's and K's functions, as in end.spec.ts.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SwarmEntry } from '../../hooks/hookfiles'
import type { RepairOutcome } from '../../hooks/lifecycle'
import type { RunEndBody } from '../../hooks/records/run'
import type { SwarmEventBody, SwarmStartBody } from '../../hooks/records/swarm'
import { appendRecord } from '../../hooks/ledgercore'
import { launchSummaryPath, summaryPath } from '../../hooks/layout'
import { appendLaunchRecord, newLaunchId, readLaunchLedger } from '../../hooks/records/swarm'
import { updateSession } from '../../hooks/session'
import { endSwarm, headOf, others, repairPart, resetEndForTests, writeSwarmSummary } from '../../hooks/swarm/end'
import { resetObserveForTests } from '../../hooks/swarm/observe'
import * as state from '../../hooks/swarm/state'
import type { LiveSwarm, NodeBinding, RunLink } from '../../hooks/swarm/types'
import { MOD } from '../../hooks/verify'
import { fireEvery, nodePorts, runAfters, scratch, scratchRepo, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const T0 = 1_800_000_000_000
const RUN = '20261003-api'

let p: TestPorts
let dir: string
let litterDir: string
let runDir: string
let launch: string
let link: RunLink
let cleanup: () => void
let calls: unknown[][]
let entry: SwarmEntry | null
/** What the stand-in for W's endRepairGeneration does with each call. */
let endGen: (runDir: string, outcome: RepairOutcome) => Promise<{ recorded: boolean; end: RunEndBody }>
const saved = { ...others }

const endOf = (o: RepairOutcome): RunEndBody => ({ taskId: null, generation: 2, status: o.status, reason: o.reason, source: 'mod' })

/** policy.json's entry for the launch, as M's writers would leave it. */
const entryOf = (): SwarmEntry => ({
  launch,
  state: 'live',
  commonDir: realpathSync(join(dir, '.git')),
  owner: { ref: 'refs/litter-swarm/repair-0a1b2c', oid: 'a'.repeat(40), generation: 1, session: 'test-session', checkedAt: 0 },
  nodeTypes: ['litter:sw-repair-0a1b2c-repair', 'litter:sw-repair-0a1b2c-fixer', 'litter:sw-repair-0a1b2c-critic'],
})

beforeEach(async () => {
  state.resetForTests()
  resetEndForTests()
  resetObserveForTests()
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ cwd: dir })
  p.clock.now = T0
  await scratchRepo(p, dir)
  litterDir = join(dir, '.claude', 'litter')
  runDir = join(litterDir, RUN)
  link = { runDir, run: RUN, generation: 2 }
  launch = await newLaunchId(p, litterDir, 'repair-0a1b2c')
  updateSession({ litterDir })

  calls = []
  entry = entryOf()
  others.patchNodePolicies = async () => undefined
  others.patchSwarmPolicy = async (_p, _dir, name, change) => {
    calls.push(['patchSwarmPolicy', name])
    const next = entry ? change(entry) : null
    if (next) entry = next
  }
  others.writeSwarmPolicy = async (_p, _dir, name, e) => {
    calls.push(['writeSwarmPolicy', name, e])
    entry = e
  }
  others.removeNodePolicy = async (_p, _dir, agentId) => void calls.push(['removeNodePolicy', agentId])
  others.releaseOwnership = async (_p, _dir, name) => (calls.push(['releaseOwnership', name]), true)
  others.confirmOwnership = async () => (entry ? { launch: entry.launch, generation: entry.owner.generation, oids: [entry.owner.oid] } : 'lost')
  others.stopOwnerBeat = name => void calls.push(['stopOwnerBeat', name])
  others.noteSummaryTrigger = () => undefined
  others.releaseActive = async () => void calls.push(['releaseActive'])
  endGen = async (_dir, outcome) => ({ recorded: true, end: endOf(outcome) })
  others.endRepairGeneration = async (_p, at, outcome) => {
    // What W's end sees when it's called: the swarm's own end already recorded.
    calls.push(['endRepairGeneration', at, outcome, (await kinds()).includes('swarm.end'), state.liveSwarm(NAME) !== null])
    return endGen(at, outcome)
  }
})

afterEach(() => {
  Object.assign(others, saved)
  resetEndForTests()
  updateSession({ litterDir: null })
  state.resetForTests()
  cleanup()
})

const NAME = 'repair-0a1b2c'
const W = ['Edit', 'Write', 'NotebookEdit']

const swarmOf = (over: Partial<LiveSwarm> = {}): LiveSwarm => ({
  name: NAME,
  launch,
  revision: 1,
  spec: {
    name: NAME,
    goal: `Repair the combined result of run ${RUN}`,
    nodes: [
      { id: 'repair', kind: 'orchestrator', tools: { deny: W }, authority: { push: 'none', verify: true, land: true }, spawns: { fixer: 2, critic: 1 } },
      { id: 'fixer', kind: 'worker', serial: true, authority: { commit: true, push: 'none', verify: true } },
      { id: 'critic', kind: 'worker', verdicts: true, tools: { deny: W }, authority: { commit: false, push: 'none', verify: true } },
    ],
  },
  nonce: 'n0nce',
  types: { repair: `litter:sw-${NAME}-repair`, fixer: `litter:sw-${NAME}-fixer`, critic: `litter:sw-${NAME}-critic` },
  typesReady: true,
  dirs: {},
  sessionCwd: dir,
  worktreeRoot: join(realpathSync(dir), '.claude', 'worktrees'),
  commonDir: realpathSync(join(dir, '.git')),
  roots: { litterDir, litterCopies: [litterDir], ruleDirs: [] },
  tips: {},
  owner: { ref: `refs/litter-swarm/${NAME}`, oid: 'a'.repeat(40), generation: 1, session: 'test-session' },
  state: 'live',
  readOnly: false,
  lost: false,
  flags: { isolationLost: false },
  startedAt: T0,
  run: link,
  budget: { rounds: 3, agents: 6 },
  ...over,
})

const bindingOf = (agentId: string, node: string, over: Partial<NodeBinding> = {}): NodeBinding => ({
  agentId,
  swarm: NAME,
  launch,
  node,
  n: 1,
  kind: 'worker',
  of: null,
  parent: 'a-repair',
  type: `litter:sw-${NAME}-${node}`,
  cwd: dir,
  branch: null,
  token: `tok-${agentId}`,
  revision: 1,
  generation: 1,
  boundAt: T0,
  adopted: false,
  ...over,
})

/** The repair swarm live, as X's launch leaves it: swarm.start with its run and budget, the orchestrator, a fixer and the critic bound and settled. */
async function live(over: Partial<LiveSwarm> = {}): Promise<void> {
  const s = swarmOf(over)
  const start = { swarm: NAME, launch, revision: 1, specHash: 'h', nonce: 'n0nce', types: s.types, nodes: {}, authority: {}, tips: {}, owner: { ref: s.owner.ref, oid: s.owner.oid, generation: 1 }, sessionCwd: dir, worktreeRoot: s.worktreeRoot, commonDir: s.commonDir, roots: s.roots, confirmedBy: { run: RUN } } as SwarmStartBody
  if (s.run) start.run = s.run
  if (s.budget) start.budget = s.budget
  await appendLaunchRecord(p, litterDir, NAME, launch, 'swarm.start', start)
  state.putLiveSwarm(s)
  const bs = [
    bindingOf('a-repair', 'repair', { kind: 'orchestrator', parent: null }),
    bindingOf('a-fix1', 'fixer'),
    bindingOf('a-crit1', 'critic'),
  ]
  for (const b of bs) {
    state.putBinding(b)
    await appendLaunchRecord(p, litterDir, NAME, launch, 'swarm.node', { node: b.node, n: b.n, agentId: b.agentId, parentAgentId: b.parent, kind: b.kind, cwd: dir, branch: null, model: null, revision: 1, generation: 1 })
  }
  p.agents = bs.map(b => ({ id: b.agentId, description: b.node, type: b.type, status: 'completed' }))
}

const gate = (body: Omit<Extract<SwarmEventBody, { kind: 'gate' }>, 'kind'>) =>
  appendLaunchRecord(p, litterDir, NAME, launch, 'swarm.event', { kind: 'gate', ...body } as SwarmEventBody)

/** The repair's gates as Y mirrors them: the fixer's green verify, the critic's own, its approving verdict, the orchestrator's land. */
async function repaired(landed: boolean): Promise<void> {
  await gate({ node: 'fixer', agentId: 'a-fix1', run: RUN, seq: 21, record: 'verify', gate: 'repair', result: 'red', verify_id: 'v-1' })
  await gate({ node: 'critic', agentId: 'a-crit1', run: RUN, seq: 22, record: 'verify', gate: 'repair', result: 'red', verify_id: 'v-2' })
  await gate({ node: 'critic', agentId: 'a-crit1', run: RUN, seq: 23, record: 'verdict', gate: 'repair', result: 'rejected', verify_id: 'v-2', round: 1 })
  await gate({ node: 'critic', agentId: 'a-crit1', run: RUN, seq: 25, record: 'verify', gate: 'repair', result: 'green', verify_id: 'v-3' })
  await gate({ node: 'critic', agentId: 'a-crit1', run: RUN, seq: 26, record: 'verdict', gate: 'repair', result: 'approved', verify_id: 'v-3', round: 2 })
  if (landed) await gate({ node: 'repair', agentId: 'a-repair', run: RUN, seq: 27, record: 'land', gate: 'fanout', result: 'landed', verify_id: 'v-3' })
}

/** The run's own ledger: generation 1's end, the reopen for generation 2, and optionally a land in either. */
async function runLedger(opts: { landIn?: 1 | 2 } = {}): Promise<void> {
  const rec = (kind: string, body: Record<string, unknown>) => appendRecord(p, runDir, { run: RUN, kind, by: MOD, body })
  if (opts.landIn === 1) await rec('land', { gate: 'fanout', verify_id: 'v-0', commit: 'c'.repeat(40), tree: 't'.repeat(40), old: 'o'.repeat(40), ref: 'refs/heads/main' })
  await rec('run.end', { taskId: 't1', generation: 1, status: 'halted', reason: 'integration verify red', source: 'notification' })
  await rec('run.repair', { generation: 2, swarm: NAME, launch, budget: { rounds: 3, agents: 6 } })
  if (opts.landIn === 2) await rec('land', { gate: 'fanout', verify_id: 'v-3', commit: 'c'.repeat(40), tree: 't'.repeat(40), old: 'o'.repeat(40), ref: 'refs/heads/main' })
}

const records = async () => (await readLaunchLedger(p, litterDir, NAME, launch)).records
const kinds = async () => (await records()).map(r => r.kind)
const endCalls = () => calls.filter(c => c[0] === 'endRepairGeneration')
const swarmSummary = () => readFileSync(launchSummaryPath(litterDir, NAME, launch), 'utf8')

/** End swarm, settled through the wait's tick. */
async function endSettled(): Promise<void> {
  await endSwarm(p, NAME, 'request')
  await fireEvery(p)
  expect(await kinds()).toContain('swarm.end')
}

describe("a repair swarm's End closes its run's generation", () => {
  test('with a land: done, after swarm.end and the policy removal, before the hand-off, which names the run summary', async () => {
    await live()
    await runLedger({ landIn: 2 })
    await repaired(true)
    await endSettled()

    expect(endCalls()).toEqual([['endRepairGeneration', runDir, { status: 'done', reason: null }, true, false]])
    const order = calls.map(c => c[0])
    const at = (name: string) => order.lastIndexOf(name)
    expect(at('writeSwarmPolicy')).toBeLessThan(at('endRepairGeneration'))
    expect(at('removeNodePolicy')).toBeLessThan(at('endRepairGeneration'))
    expect(at('releaseActive')).toBeLessThan(at('endRepairGeneration'))
    expect(state.liveSwarm(NAME)).toBeNull()

    // The hand-off comes after, from a timer, and points at the run's own summary.
    expect(p.submitted).toEqual([])
    await runAfters(p)
    expect(p.submitted.length).toBe(1)
    expect(p.submitted[0]).toContain(`It was the repair swarm of run ${RUN}, generation 2. The run's own summary is ${summaryPath(runDir)}`)
    expect(p.toasts).toEqual([])
  })

  test('with no land: halted, saying so', async () => {
    await live()
    await runLedger()
    await repaired(false)
    await endSettled()
    expect(endCalls()).toEqual([
      ['endRepairGeneration', runDir, { status: 'halted', reason: `the repair swarm ${NAME} ended with no land` }, true, false],
    ])
  })

  test("a land only the run's ledger holds (the mirror was lost to a crash) is done; one before the generation opened isn't", async () => {
    await live()
    await runLedger({ landIn: 2 })
    await repaired(false)
    await endSettled()
    expect(endCalls().map(c => (c[2] as RepairOutcome).status)).toEqual(['done'])

    resetEndForTests()
    state.resetForTests()
    calls = []
    launch = await newLaunchId(p, litterDir, NAME)
    entry = entryOf()
    runDir = join(litterDir, '20261003-other')
    link = { runDir, run: '20261003-other', generation: 2 }
    await live({ run: link })
    const rec = (kind: string, body: Record<string, unknown>) => appendRecord(p, runDir, { run: link.run, kind, by: MOD, body })
    await rec('land', { gate: 'fanout', verify_id: 'v-0', commit: 'c'.repeat(40), tree: 't'.repeat(40), old: 'o'.repeat(40), ref: 'refs/heads/main' })
    await rec('run.end', { taskId: 't1', generation: 1, status: 'halted', reason: 'red', source: 'notification' })
    await rec('run.repair', { generation: 2, swarm: NAME, launch, budget: { rounds: 3, agents: 6 } })
    await endSettled()
    expect(endCalls().map(c => (c[2] as RepairOutcome).status)).toEqual(['halted'])
  })

  test('[End, keep everything] closes it too, saying it ended before it settled', async () => {
    await live()
    await runLedger()
    state.markRunning('a-fix1')
    p.agents[1]!.status = 'running'
    await endSwarm(p, NAME, 'request')
    await fireEvery(p)
    expect(endCalls()).toEqual([])
    await endSwarm(p, NAME, 'keep-everything')
    expect(endCalls()).toEqual([
      [
        'endRepairGeneration',
        runDir,
        { status: 'halted', reason: `the repair swarm ${NAME} ended with no land, with [End, keep everything] before it settled` },
        true,
        false,
      ],
    ])
  })

  test('a launch ledger that broke still closes it, from the run ledger', async () => {
    await live()
    await runLedger({ landIn: 2 })
    await endSwarm(p, NAME, 'request')
    const ledger = join(litterDir, 'swarms', NAME, 'launches', launch, 'ledger')
    const name = readdirSync(ledger).find(f => f.endsWith('-swarm.stopping.json'))!
    writeFileSync(join(ledger, name), readFileSync(join(ledger, name), 'utf8').replace('"browser"', '"lead"'))
    await fireEvery(p)
    expect(await kinds()).not.toContain('swarm.end')
    expect(endCalls().map(c => c.slice(1, 3))).toEqual([[runDir, { status: 'done', reason: null }]])
  })

  test('a swarm handed to another session leaves the generation to its new owner', async () => {
    await live()
    await runLedger()
    await endSwarm(p, NAME, 'request')
    entry = null
    await fireEvery(p)
    expect(endCalls()).toEqual([])
  })
})

describe('the call is idempotent from this side', () => {
  test('an end the run already has (reconcile was first) answers recorded: false, and the swarm still ends whole', async () => {
    endGen = async () => ({ recorded: false, end: { taskId: null, generation: 2, status: 'halted', reason: 'reconciled', source: 'reconcile' } })
    await live()
    await runLedger()
    await endSettled()
    expect(endCalls().length).toBe(1)
    expect(p.logs).toContain(`swarm ${NAME}: run ${RUN}'s generation 2 had ended already (halted)`)
    expect(p.toasts).toEqual([])
    expect(state.liveSwarm(NAME)).toBeNull()
    await runAfters(p)
    expect(p.submitted.length).toBe(1)
    // Ended once: nothing calls it again.
    await fireEvery(p)
    expect(endCalls().length).toBe(1)
  })

  test("a failing call is logged and toasted (the run's lock stays until a restart reconciles it); the swarm's end stands", async () => {
    endGen = async () => {
      throw new Error('the run lock is not this run')
    }
    await live()
    await runLedger()
    await endSettled()
    expect(endCalls().length).toBe(1)
    expect(p.logs.some(l => l.includes(`closing run ${RUN}'s generation 2 failed: the run lock is not this run`))).toBe(true)
    expect(p.toasts).toEqual([expect.stringContaining(`repair swarm ${NAME} has ended, but run ${RUN}'s generation 2 wasn't closed`)])
    expect(state.liveSwarm(NAME)).toBeNull()
    expect(calls.map(c => c[0])).toContain('releaseOwnership')
    await runAfters(p)
    expect(p.submitted.length).toBe(1)
  })
})

describe("a plain swarm's End", () => {
  test('never calls it, and its hand-off names no run', async () => {
    await live({ run: undefined, budget: undefined })
    await endSettled()
    expect(endCalls()).toEqual([])
    await runAfters(p)
    expect(p.submitted[0]).not.toContain('repair swarm of run')
    const summary = swarmSummary()
    expect(summary).not.toContain('## Repair')
    expect(summary).not.toContain('- Repairs:')
  })
})

describe("summary.md's repair part", () => {
  test('the run and its summary in the opening lines, the rounds and agents used and left, each gate record with its round and result', async () => {
    await live()
    await runLedger({ landIn: 2 })
    await repaired(true)
    // A worker spawned and one adopted after a reload: only the spawn counts.
    await appendLaunchRecord(p, litterDir, NAME, launch, 'swarm.node', { node: 'fixer', n: 2, agentId: 'a-fix2', parentAgentId: 'a-repair', kind: 'worker', cwd: dir, branch: null, model: null, revision: 1, generation: 1 })
    await appendLaunchRecord(p, litterDir, NAME, launch, 'swarm.node', { node: 'fixer', n: 1, agentId: 'a-fix1', parentAgentId: 'a-repair', kind: 'worker', cwd: dir, branch: null, model: null, adopted: true, revision: 1, generation: 1 })
    await appendLaunchRecord(p, litterDir, NAME, launch, 'swarm.event', { kind: 'budget', requested: { rounds: 2 }, granted: true, budget: { rounds: 5, agents: 6 } })
    await endSettled()

    const summary = swarmSummary()
    const head = headOf(summary)
    expect(head).toContain(`- Repairs: run ${RUN}, generation 2; the run's summary is ${summaryPath(runDir)}`)
    // The live budget (3 rounds) at End: X raises LiveSwarm.budget with the event it records.
    expect(head).toContain('- Repair budget: 2 of 3 rounds used, 1 left; 3 of 6 agents used, 3 left')
    expect(head).toContain('- Land: landed on verify v-3')

    const lines = summary.split('\n')
    const part = lines.slice(lines.indexOf('## Repair'), lines.indexOf('## Nodes')).map(l => l.replace(/^- \d{4}-\S+ /, '- '))
    expect(part).toEqual([
      '## Repair',
      '',
      "Its verify, verdict and land records, as the run's ledger holds them:",
      '',
      '- verify by fixer: red (verify v-1, gate repair, run record #21)',
      '- verify by critic: red (verify v-2, gate repair, run record #22)',
      '- verdict by critic: round 1, rejected (on verify v-2, run record #23)',
      '- verify by critic: green (verify v-3, gate repair, run record #25)',
      '- verdict by critic: round 2, approved (on verify v-3, run record #26)',
      '- land by repair: landed (on verify v-3, run record #27)',
      '',
      'More budget the lead asked you for:',
      '',
      '- rounds 2: granted; now 5 rounds and 6 agents',
      '',
    ])
    // The opening lines are what the lead is handed: the gate list isn't in them.
    expect(head).not.toContain('verdict by critic')
  })

  test('once ended, the budget is the last event\'s; before any gate it says none yet', async () => {
    await live()
    await appendLaunchRecord(p, litterDir, NAME, launch, 'swarm.event', { kind: 'budget', requested: { agents: 4 }, granted: false, budget: { rounds: 3, agents: 6 } })
    let summary = readFileSync(await writeSwarmSummary(p, NAME, launch), 'utf8')
    expect(summary).toContain('- Land: none yet')
    expect(summary).toContain("as the run's ledger holds them:\n\n- none yet")
    expect(summary).toMatch(/\n- \S+ agents 4: not granted; still 3 rounds and 6 agents\n/)

    // Not live any more: the ledger's own facts.
    await appendLaunchRecord(p, litterDir, NAME, launch, 'swarm.event', { kind: 'budget', requested: { rounds: 1 }, granted: true, budget: { rounds: 4, agents: 6 } })
    state.dropLiveSwarm(NAME)
    const part = repairPart(await records(), null)
    expect(part).toEqual(expect.objectContaining({ link, budget: { rounds: 4, agents: 6 }, rounds: 0, agents: 2 }))
    summary = readFileSync(await writeSwarmSummary(p, NAME, launch), 'utf8')
    expect(summary).toContain('- Repair budget: 0 of 4 rounds used, 4 left; 2 of 6 agents used, 4 left')
  })

  test('a rejected verdict on the same verify twice is one round (decision 6)', async () => {
    await live()
    await gate({ node: 'critic', run: RUN, seq: 5, record: 'verdict', gate: 'repair', result: 'rejected', verify_id: 'v-1', round: 1 })
    await gate({ node: 'critic', run: RUN, seq: 6, record: 'verdict', gate: 'repair', result: 'rejected', verify_id: 'v-1', round: 1 })
    expect(repairPart(await records(), state.liveSwarm(NAME))!.rounds).toBe(1)
  })

  test("a plan-template swarm's approvals carry no round and count none; a fanout's approval, mirrored with its round, still counts", async () => {
    await live()
    // A plan-template swarm's verdicts as gate.ts mirrors them (phase 3, decision 1): a rejection is a round, an approval isn't.
    await gate({ node: 'critic', agentId: 'a-crit1', run: RUN, seq: 5, record: 'verdict', gate: 'G2', result: 'rejected', verify_id: 'G2-2-a', round: 1 })
    await gate({ node: 'critic', agentId: 'a-crit1', run: RUN, seq: 7, record: 'verdict', gate: 'G2', result: 'approved', verify_id: 'G2-3-b' })
    await gate({ node: 'critic', agentId: 'a-crit1', run: RUN, seq: 9, record: 'verdict', gate: 'G3', result: 'approved', verify_id: 'G3-1-c' })
    expect(repairPart(await records(), state.liveSwarm(NAME))!.rounds).toBe(1)
    let summary = readFileSync(await writeSwarmSummary(p, NAME, launch), 'utf8')
    expect(summary).toContain('- Repair budget: 1 of 3 rounds used, 2 left;')
    expect(summary).toMatch(/\n- \S+ verdict by critic: approved \(on verify G2-3-b, run record #7\)\n/)

    // A fanout's verdicts always carry their round, the approval's too: both count, as before.
    await gate({ node: 'critic', agentId: 'a-crit1', run: RUN, seq: 11, record: 'verdict', gate: 'repair', result: 'rejected', verify_id: 'v-1', round: 2 })
    await gate({ node: 'critic', agentId: 'a-crit1', run: RUN, seq: 13, record: 'verdict', gate: 'repair', result: 'approved', verify_id: 'v-2', round: 3 })
    expect(repairPart(await records(), state.liveSwarm(NAME))!.rounds).toBe(3)
    summary = readFileSync(await writeSwarmSummary(p, NAME, launch), 'utf8')
    expect(summary).toContain('- Repair budget: 3 of 3 rounds used, 0 left;')
  })
})
