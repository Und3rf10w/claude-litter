// Tier 2: a repair start the lead's turn didn't make falls back to your Enter
// (hooks/repair.ts; WP-AS). The bridge's start was submitted, and the lead
// turn after it ended with no orchestrator spawned or admitted (a refused
// skill or spawn): a timer fills /litter:swarm start and the launch's
// authority into the prompt box, once, with a toast, a start-filled event and
// the pending start marked filled in the store; summary.md's Repair part says
// it waits for your Enter. Against the real execute bridge (execbridge
// harness: a halted execute run, continueAsRepair, the real launch), and a
// fanout repair swarm from the repair harness with its start restored from
// the store. Fake fillPrompt, toast and clock (node-ports).

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SwarmStartBody } from '../../hooks/records/swarm'
import { appendRecord } from '../../hooks/ledgercore'
import { summaryPath } from '../../hooks/layout'
import { sha256 } from '../../hooks/fsx'
import { MOD } from '../../hooks/verify'
import { appendLaunchRecord, readLaunchLedger } from '../../hooks/records/swarm'
import { liveSwarm, putBinding, reserve, setInteractive, dropBinding } from '../../hooks/swarm/state'
import { recoverSwarms } from '../../hooks/swarm/recover'
import * as repairPrompts from '../../hooks/prompts/swarm-repair'
import { REPAIR_START } from '../../hooks/prompts/swarm-repair'
import { renderSlots } from '../../hooks/prompts/slots'
import { continueAsRepair, deps as repairDeps, repairNote, repairSummary, repairTurnComplete, resetRepairForTests } from '../../hooks/repair'
import { NOW, world, type World } from './swarmlaunch-harness'
import { runAfters, type TestPorts } from './support/node-ports'
import { RUN, executeRun, type Exec } from './execbridge-harness'
import * as rh from './repair-harness'

setDefaultTimeout(120_000)

const originals = { ...repairDeps }
const ROOT = join(import.meta.dir, '..', '..')
const leadTurn = { turnId: 'turn-1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as unknown as Parameters<typeof repairTurnComplete>[1]
const abortedTurn = { ...leadTurn, isAborted: true, reason: 'aborted' } as unknown as Parameters<typeof repairTurnComplete>[1]
const subagentTurn = { ...leadTurn, agentId: 'agent-7' } as unknown as Parameters<typeof repairTurnComplete>[1]
const pendingAfters = (p: TestPorts): number => p.afters.filter(a => a.state === 'pending').length

const refused = (swarm: string) => `repair swarm ${swarm} didn't start on the lead's turn (its start may have been refused)`
const pressEnter = (swarm: string) => `${refused(swarm)}; press Enter to start it, or /litter:swarm end ${swarm} to stop it`
const sendLine = (swarm: string) => `${refused(swarm)}; send /litter:swarm start ${swarm} to start it, or /litter:swarm end ${swarm} to stop it`
const waitingForEnter = (swarm: string) => `it's waiting for your Enter on /litter:swarm start ${swarm}, which litter put in your prompt box, or /litter:swarm end ${swarm} to stop it.`

// ---------------------------------------------------------------------------
// A plan-template swarm the execute bridge started

describe("the execute bridge's start, when the lead's turn didn't make it", () => {
  let w: World
  let x: Exec
  let launch: string

  beforeEach(async () => {
    w = await world('sess-a')
    resetRepairForTests()
    setInteractive(true)
    // The execute baseline finds a green verify in the chain and runs none (decision 9).
    Object.assign(repairDeps, { runVerify: async () => ({ ok: false, error: 'litter: the execute bridge runs no verify' }) } as Partial<typeof repairDeps>)
    x = await executeRun(w, { halt: 'plan_gap' })
    await continueAsRepair(w.p, x.runDir)
    launch = liveSwarm(x.name)!.launch
  })
  afterEach(async () => {
    Object.assign(repairDeps, originals)
    resetRepairForTests()
    await w.done()
  })

  const pendingKey = () => `litter.repair.start.${w.litterDir}`
  const stored = () => w.p.storeMap.get(pendingKey()) as Record<string, unknown>[] | undefined
  const summary = () => readFileSync(summaryPath(x.runDir), 'utf8')
  const launchRecords = async (p: TestPorts = w.p) => (await readLaunchLedger(p, w.litterDir, x.name, launch)).records
  const fills = async (p: TestPorts = w.p) => (await launchRecords(p)).filter(r => r.kind === 'swarm.event' && r.body.kind === 'start-filled').map(r => r.body)
  const startBody = async () => (await launchRecords()).find(r => r.kind === 'swarm.start')!.body as unknown as SwarmStartBody
  /** The start line, then the authority swarm.start recorded, one line per node in the spec's order, as fillStart fills the builder's. */
  const startText = async () => {
    const start = await startBody()
    return [`/litter:swarm start ${x.name}`, ...liveSwarm(x.name)!.spec.nodes.map(n => start.authority[n.id]!)].join('\n')
  }

  /** The notification turn ends, and its timer submits REPAIR_START. */
  async function submitted(p: TestPorts = w.p): Promise<void> {
    await repairTurnComplete(p, leadTurn)
    expect(await runAfters(p)).toBe(1)
    expect(p.submitted).toEqual([renderSlots(REPAIR_START, { swarm: x.name, run: RUN })])
  }

  /** The gate-runner as L binds it: its swarm.node in the launch ledger, then the binding. */
  async function runnerBound(): Promise<void> {
    const s = liveSwarm(x.name)!
    await appendLaunchRecord(w.p, w.litterDir, x.name, launch, 'swarm.node', {
      node: 'runner', n: 1, agentId: 'runner-1', parentAgentId: null, kind: 'orchestrator', cwd: w.dir, branch: null, model: null, revision: 1, generation: 1,
    })
    putBinding({
      agentId: 'runner-1', swarm: x.name, launch, node: 'runner', n: 1, kind: 'orchestrator', of: null, parent: null, type: s.types.runner!,
      cwd: w.dir, branch: null, token: 'tok-runner-1', revision: 1, generation: 1, boundAt: NOW, adopted: false,
    })
  }

  test("the start's own turn ends with no orchestrator: the timer after it fills the start line once, with a toast, a start-filled event and the start marked filled", async () => {
    await submitted()
    expect(summary()).not.toContain('waiting for your Enter')
    await repairTurnComplete(w.p, leadTurn)
    // Only from the timer.
    expect(w.p.filled).toEqual([])
    expect(pendingAfters(w.p)).toBe(1)
    expect(w.p.afters.at(-1)!.ms).toBe(0)
    expect(await runAfters(w.p)).toBe(1)

    const text = await startText()
    expect(w.p.filled).toEqual([text])
    expect(text.split('\n')).toHaveLength(4)
    expect(w.p.toasts).toEqual([pressEnter(x.name)])
    expect(await fills()).toEqual([{ kind: 'start-filled', filled: true }])
    expect(stored()).toEqual([expect.objectContaining({ swarm: x.name, launch, run: RUN, submitted: true, filled: true, inBox: true })])
    // Nothing submitted again, and no note: it's handed to you.
    expect(w.p.submitted).toHaveLength(1)
    expect(repairNote(w.p)).toBeNull()
    // summary.md's Repair part, rewritten: it waits for your Enter, and still says how to watch it.
    const repair = summary().slice(summary().indexOf('## Repair'))
    expect(repair).toContain(`It didn't start on the lead's turn (its start may have been refused): ${waitingForEnter(x.name)}`)
    expect(repair).toContain(`Watch it with /litter swarms ${x.name}`)
    expect(await repairSummary(w.p, x.runDir)).toContain(waitingForEnter(x.name))

    // Never twice: later lead turns, interrupted or not, fill nothing more.
    await repairTurnComplete(w.p, leadTurn)
    await repairTurnComplete(w.p, abortedTurn)
    expect(pendingAfters(w.p)).toBe(0)
    expect(w.p.filled).toHaveLength(1)
    expect(await fills()).toHaveLength(1)
  })

  test("an orchestrator spawned on the start's turn: no fill, and the pending start is pruned", async () => {
    await submitted()
    await runnerBound()
    await repairTurnComplete(w.p, leadTurn)
    expect(pendingAfters(w.p)).toBe(0)
    expect(w.p.filled).toEqual([])
    expect(await fills()).toEqual([])
    expect(w.p.storeMap.has(pendingKey())).toBe(false)
  })

  test("an orchestrator being admitted on that turn: no fill", async () => {
    await submitted()
    reserve({ key: 'res-1', swarm: x.name, node: 'runner', parent: null, kind: 'orchestrator', n: 1, scope: null, at: NOW })
    await repairTurnComplete(w.p, leadTurn)
    expect(pendingAfters(w.p)).toBe(0)
    expect(w.p.filled).toEqual([])
  })

  test('an orchestrator bound before the timer runs: the timer fills nothing, and marks nothing', async () => {
    await submitted()
    await repairTurnComplete(w.p, leadTurn)
    expect(pendingAfters(w.p)).toBe(1)
    await runnerBound()
    await runAfters(w.p)
    expect(w.p.filled).toEqual([])
    expect(w.p.toasts).toEqual([])
    expect(await fills()).toEqual([])
    expect(stored()?.[0]?.filled).toBeUndefined()
  })

  test("a subagent's turn.complete fills nothing; the lead's does", async () => {
    await submitted()
    await repairTurnComplete(w.p, subagentTurn)
    expect(pendingAfters(w.p)).toBe(0)
    await repairTurnComplete(w.p, leadTurn)
    await repairTurnComplete(w.p, leadTurn)
    // The second lead turn, before the timer ran, schedules nothing more.
    expect(pendingAfters(w.p)).toBe(1)
    await runAfters(w.p)
    expect(w.p.filled).toHaveLength(1)
  })

  test('an interrupted lead turn after the submit still fills it, once', async () => {
    await submitted()
    await repairTurnComplete(w.p, abortedTurn)
    expect(pendingAfters(w.p)).toBe(1)
    await runAfters(w.p)
    expect(w.p.filled).toEqual([await startText()])
    expect(await fills()).toEqual([{ kind: 'start-filled', filled: true }])
    await repairTurnComplete(w.p, abortedTurn)
    expect(pendingAfters(w.p)).toBe(0)
  })

  test('an interrupted notification turn submits nothing and fills nothing (the start comes after the next lead turn)', async () => {
    await repairTurnComplete(w.p, abortedTurn)
    expect(pendingAfters(w.p)).toBe(0)
    expect(w.p.submitted).toEqual([])
    expect(w.p.filled).toEqual([])
  })

  test("a box that refuses the fill: filled false, the toast names the line to send, and the summary says to send it", async () => {
    w.p.fillAnswer = () => false
    await submitted()
    await repairTurnComplete(w.p, leadTurn)
    await runAfters(w.p)
    expect(w.p.filled).toHaveLength(1)
    expect(w.p.toasts).toEqual([sendLine(x.name)])
    expect(w.p.logs.some(l => l.includes(`repair swarm ${x.name}: the prompt box didn't take its start line`))).toBe(true)
    expect(await fills()).toEqual([{ kind: 'start-filled', filled: false }])
    expect(stored()).toEqual([expect.objectContaining({ filled: true, inBox: false })])
    const repair = summary().slice(summary().indexOf('## Repair'))
    expect(repair).toContain(`and the prompt box didn't take its start line: it's waiting for you to send /litter:swarm start ${x.name}, or /litter:swarm end ${x.name} to stop it.`)
    expect(repair).not.toContain('waiting for your Enter')
    // Still never twice.
    await repairTurnComplete(w.p, leadTurn)
    expect(pendingAfters(w.p)).toBe(0)
  })

  test('a fill that throws counts as one the box refused', async () => {
    w.p.fillPrompt = async () => {
      throw new Error('no composer')
    }
    await submitted()
    await repairTurnComplete(w.p, leadTurn)
    await runAfters(w.p)
    expect(await fills()).toEqual([{ kind: 'start-filled', filled: false }])
    expect(w.p.toasts).toEqual([sendLine(x.name)])
  })

  test('a session that is not interactive fills nothing', async () => {
    await submitted()
    setInteractive(false)
    await repairTurnComplete(w.p, leadTurn)
    expect(pendingAfters(w.p)).toBe(0)
    expect(w.p.filled).toEqual([])
  })

  test('a reload with a filled start fills it no more', async () => {
    await submitted()
    await repairTurnComplete(w.p, leadTurn)
    await runAfters(w.p)
    expect(w.p.filled).toHaveLength(1)
    const q = await w.restart('sess-a')
    resetRepairForTests()
    setInteractive(true)
    await recoverSwarms(q, w.litterDir)
    expect(liveSwarm(x.name)).toEqual(expect.objectContaining({ launch, readOnly: false, state: 'live' }))
    await repairTurnComplete(q, leadTurn)
    await repairTurnComplete(q, abortedTurn)
    expect(pendingAfters(q)).toBe(0)
    expect(q.filled).toEqual([])
    expect(q.submitted).toEqual([])
    expect(await fills(q)).toHaveLength(1)
    // The store keeps it filled, and the summary still says it waits for your Enter.
    expect(q.storeMap.get(pendingKey())).toEqual([expect.objectContaining({ filled: true, inBox: true })])
    expect(await repairSummary(q, x.runDir)).toContain(waitingForEnter(x.name))
  })

  test("a reload after the submit, before its turn's end filled it: the next lead turn fills it", async () => {
    await submitted()
    const q = await w.restart('sess-a')
    resetRepairForTests()
    setInteractive(true)
    await recoverSwarms(q, w.litterDir)
    await repairTurnComplete(q, leadTurn)
    await runAfters(q)
    expect(q.submitted).toEqual([])
    expect(q.filled.map(f => f.split('\n')[0])).toEqual([`/litter:swarm start ${x.name}`])
    expect(await fills(q)).toEqual([{ kind: 'start-filled', filled: true }])
  })

  test("once it starts on your Enter, the pending start is pruned and summary.md stops saying it waits", async () => {
    await submitted()
    await repairTurnComplete(w.p, leadTurn)
    await runAfters(w.p)
    expect(summary()).toContain(waitingForEnter(x.name))
    // Your Enter: the lead runs the start, and the gate-runner is bound; that turn's end prunes the start and rewrites the summary.
    await runnerBound()
    expect(await repairSummary(w.p, x.runDir)).not.toContain('waiting for your Enter')
    await repairTurnComplete(w.p, leadTurn)
    expect(w.p.storeMap.has(pendingKey())).toBe(false)
    expect(summary()).not.toContain('waiting for your Enter')
    expect(summary()).toContain(`Watch it with /litter swarms ${x.name}`)
    // The event stays in the launch ledger before the runner's swarm.node: it started on your Enter.
    const rs = await launchRecords()
    const fill = rs.find(r => r.kind === 'swarm.event' && r.body.kind === 'start-filled')!
    const node = rs.find(r => r.kind === 'swarm.node' && r.body.kind === 'orchestrator')!
    expect(fill.seq).toBeLessThan(node.seq)
  })
})

// ---------------------------------------------------------------------------
// A fanout's repair swarm (repair-harness), its start restored from the store

describe("a fanout repair swarm's start, restored from the store", () => {
  let w: rh.World
  const pendingKey = () => `litter.repair.start.${w.litterDir}`
  const AUTHORITY: Record<string, string> = {
    repair: 'repair: verify, land; commit unchecked; push: the lead pushes nothing for it',
    fixer: 'fixer: commit, verify; push: the lead pushes nothing for it',
    critic: 'critic: verdicts, verify; no commit; push: the lead pushes nothing for it',
  }

  beforeEach(async () => {
    w = await rh.repairWorld()
    resetRepairForTests()
    setInteractive(true)
    // Nothing spawned yet: the harness binds an orchestrator, which this start never got.
    dropBinding('orch-1')
    const s = liveSwarm(rh.SWARM)!
    const start: SwarmStartBody = {
      swarm: rh.SWARM,
      launch: w.launch,
      revision: 1,
      specHash: 'f'.repeat(64),
      nonce: s.nonce,
      types: s.types,
      nodes: {},
      authority: AUTHORITY,
      tips: {},
      owner: { ref: s.owner.ref, oid: s.owner.oid, generation: 1 },
      sessionCwd: w.dir,
      worktreeRoot: w.root,
      commonDir: s.commonDir,
      roots: s.roots,
      run: s.run!,
      budget: s.budget!,
      confirmedBy: { run: rh.RUN },
    }
    await appendLaunchRecord(w.p, w.litterDir, rh.SWARM, w.launch, 'swarm.start', start)
    // The run's run.start, which the harness leaves out, so repairSummary reads the run (run.json is checked against it).
    const text = readFileSync(join(w.runDir, 'run.json'), 'utf8')
    await appendRecord(w.p, w.runDir, { run: rh.RUN, kind: 'run.start', by: MOD, body: { workflow: 'fanout', runJsonSha256: await sha256(text) } })
    w.p.storeMap.set(pendingKey(), [{ swarm: rh.SWARM, launch: w.launch, run: rh.RUN, runDir: w.runDir, litterDir: w.litterDir, at: rh.NOW }])
  })
  afterEach(() => {
    resetRepairForTests()
    rh.teardown(w)
  })

  test('submitted, then a lead turn with no orchestrator: the start line and the recorded authority, in the spec order, then the Repair part waits for your Enter', async () => {
    await repairTurnComplete(w.p, leadTurn)
    await runAfters(w.p)
    expect(w.p.submitted).toEqual([renderSlots(REPAIR_START, { swarm: rh.SWARM, run: rh.RUN })])
    await repairTurnComplete(w.p, leadTurn)
    await runAfters(w.p)
    expect(w.p.filled).toEqual([[`/litter:swarm start ${rh.SWARM}`, AUTHORITY.repair, AUTHORITY.fixer, AUTHORITY.critic].join('\n')])
    expect(w.p.toasts).toEqual([pressEnter(rh.SWARM)])
    const events = (await readLaunchLedger(w.p, w.litterDir, rh.SWARM, w.launch)).records.filter(r => r.kind === 'swarm.event').map(r => r.body)
    expect(events).toEqual([{ kind: 'start-filled', filled: true }])
    expect(w.p.storeMap.get(pendingKey())).toEqual([expect.objectContaining({ submitted: true, filled: true, inBox: true })])
    const repair = await repairSummary(w.p, w.runDir)
    expect(repair).toContain(`Repair swarm ${rh.SWARM} (launch ${w.launch}) took over in generation 2`)
    expect(repair).toContain(`It didn't start on the lead's turn (its start may have been refused): ${waitingForEnter(rh.SWARM)}`)
    // Before the fill, the Repair part says nothing of it.
    resetRepairForTests()
    w.p.storeMap.set(pendingKey(), [{ swarm: rh.SWARM, launch: w.launch, run: rh.RUN, runDir: w.runDir, litterDir: w.litterDir, at: rh.NOW, submitted: true }])
    expect(await repairSummary(w.p, w.runDir)).not.toContain('waiting for')
  })

  test('a launch that ended meanwhile is pruned, not filled', async () => {
    w.p.storeMap.set(pendingKey(), [{ swarm: rh.SWARM, launch: w.launch, run: rh.RUN, runDir: w.runDir, litterDir: w.litterDir, at: rh.NOW, submitted: true }])
    await appendLaunchRecord(w.p, w.litterDir, rh.SWARM, w.launch, 'swarm.end', { status: 'ended', settled: true, nodes: {}, worktrees: [], branches: [] })
    await repairTurnComplete(w.p, leadTurn)
    expect(pendingAfters(w.p)).toBe(0)
    expect(w.p.filled).toEqual([])
    expect(w.p.storeMap.has(pendingKey())).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The texts

describe("the start's texts", () => {
  test("REPAIR_START's last sentence says what happens when the start is refused, and the static checks hold", () => {
    const text = renderSlots(REPAIR_START, { swarm: 'repair-abc123', run: RUN })
    expect(text).toBe(
      `litter: repair swarm repair-abc123 is live for run ${RUN}, and the run's launch confirmation already covers it. Start it now: run the litter swarm skill with start repair-abc123, and spawn its orchestrator as the skill says. If the skill or a spawn is refused, say so and end your turn; litter then puts the start line in the user's prompt box.`,
    )
    expect(text.startsWith('/')).toBe(false)
    for (const [key, t] of Object.entries(repairPrompts)) {
      expect({ key, backtick: t.includes('`'), dollar: t.includes('${') }).toEqual({ key, backtick: false, dollar: false })
    }
  })

  test('the execute and fanout skills each say litter fills the start line when its start is refused', () => {
    const execute = readFileSync(join(ROOT, 'skills', 'execute', 'SKILL.md'), 'utf8')
    expect(execute).toContain(
      "Don't start it yourself or offer other routes. If its start is refused, litter puts /litter:swarm start `<name>` in the prompt box; tell the user to press Enter to start it, or /litter:swarm end `<name>` to stop it.",
    )
    const fanout = readFileSync(join(ROOT, 'skills', 'fanout', 'SKILL.md'), 'utf8')
    expect(fanout).toContain(
      "Don't start it yourself or offer other routes. If its start is refused, litter puts `/litter:swarm start <name>` in the prompt box; tell the user to press Enter to start it, or `/litter:swarm end <name>` to stop it.",
    )
  })
})
