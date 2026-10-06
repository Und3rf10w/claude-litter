// Tier 2: the execute bridge (hooks/repair.ts; phase 3, WP-AC, COMMON steps
// 4 and 5; decisions 6, 7, 9 and 13), against real git: an execute run's
// ending read from its ledger, case by case; the preconditions in decision
// 7's order, each failing alone and in pairs; the baseline found as the
// chain's green verify of the branch tip, and missing, with no verify run;
// a decline recording repair.declined and rewriting the summary; under
// `off`, no run.repair, no swarm folder and no refs/litter-swarm/*; the
// Repair section's routes; repair.start's own ask, Cancel and Launch; and
// repair.budget in rejected attempts. The reopen and the generation's end are
// lifecycle.ts's real ones (AC's own).

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import type { RecordCtx, RecordReply } from '../../hooks/records/core'
import type { SwarmStartBody } from '../../hooks/records/swarm'
import type { SwarmSpec } from '../../hooks/swarm/types'
import { readLedger } from '../../hooks/ledgercore'
import { summaryPath, swarmDir } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { readPolicy } from '../../hooks/policy'
import { readLaunchLedger } from '../../hooks/records/swarm'
import { liveSwarm, setInteractive } from '../../hooks/swarm/state'
import { renderSlots } from '../../hooks/prompts/slots'
import { REPAIR_NOTE, REPAIR_START } from '../../hooks/prompts/swarm-repair'
import { CONFIRM_AUTO } from '../../hooks/prompts/swarm-plan'
import {
  continueAsRepair,
  deps as repairDeps,
  recordRepairBudget,
  recordRepairStart,
  repairNote,
  repairSummary,
  repairTurnComplete,
  resetRepairForTests,
} from '../../hooks/repair'
import { refOf, world, type World } from './swarmlaunch-harness'
import { runAfters, type TestPorts } from './support/node-ports'
import { BRANCH, CLASH, GAP, RUN, afterHalt, declinedReason, executeRun, runRecords, type Exec, type ExecOpts } from './execbridge-harness'

setDefaultTimeout(120_000)

const originals = { ...repairDeps }
const THE_TWO = 'a plan-template swarm takes on only a gate that halted on a plan gap or ran out of attempts'
const AMEND_HALT = "an amend's halt comes back to you; /litter:design is the recommended next step"

let w: World
let calls: { verifies: number; summaries: number }

beforeEach(async () => {
  w = await world('sess-a')
  resetRepairForTests()
  setInteractive(true)
  calls = { verifies: 0, summaries: 0 }
  Object.assign(repairDeps, {
    // The execute baseline finds a verify in the chain and runs none (decision 9).
    runVerify: async () => {
      calls.verifies++
      return { ok: false, error: 'litter: the execute bridge runs no verify' }
    },
    writeSummary: async (...a: Parameters<typeof originals.writeSummary>) => {
      calls.summaries++
      await originals.writeSummary(...a)
    },
  } as Partial<typeof repairDeps>)
})
afterEach(async () => {
  Object.assign(repairDeps, originals)
  resetRepairForTests()
  await w.done()
})

const run = (o: ExecOpts = {}): Promise<Exec> => executeRun(w, o)
const pendingKey = () => `litter.repair.start.${w.litterDir}`
const ctxOf = (p: TestPorts = w.p): RecordCtx => ({ p, caller: { agentId: null, agentType: null }, litterDir: w.litterDir, options: normalizeOptions(undefined) })
const leadTurn = { turnId: 'turn-1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' } as unknown as Parameters<typeof repairTurnComplete>[1]

async function swarmRefs(): Promise<string> {
  return (await w.git('for-each-ref', '--format=%(refname)', 'refs/litter-swarm/')).trim()
}

/** Nothing of a swarm was written: no run.repair, swarm folder, ref, live swarm, pending start, ask, fill or submit, and no verify ran. */
async function nothingStarted(x: Exec): Promise<void> {
  expect((await runRecords(x)).some(r => r.kind === 'run.repair')).toBe(false)
  expect(existsSync(swarmDir(w.litterDir, x.name))).toBe(false)
  expect(await refOf(w, x.name)).toBeNull()
  expect(await swarmRefs()).toBe('')
  expect(liveSwarm(x.name)).toBeNull()
  expect(w.p.storeMap.has(pendingKey())).toBe(false)
  expect(w.p.asked).toEqual([])
  expect(w.p.filled).toEqual([])
  expect(w.p.submitted).toEqual([])
  expect(calls.verifies).toBe(0)
}

async function startOf(x: Exec, launch: string): Promise<SwarmStartBody> {
  const { records } = await readLaunchLedger(w.p, w.litterDir, x.name, launch)
  return records.find(r => r.kind === 'swarm.start')!.body as unknown as SwarmStartBody
}

async function savedSpec(x: Exec): Promise<SwarmSpec> {
  return JSON.parse(readFileSync(`${swarmDir(w.litterDir, x.name)}/revisions/1.json`, 'utf8')) as SwarmSpec
}

const summary = (x: Exec): string => readFileSync(summaryPath(x.runDir), 'utf8')

// ---------------------------------------------------------------------------

describe('under repair: auto, the halts that bridge', () => {
  test('a plan gap starts the plan-template swarm in the run checkout: no ask, no fill, no verify, the start after the turn', async () => {
    const x = await run({ halt: 'plan_gap' })
    await continueAsRepair(w.p, x.runDir)

    expect(await afterHalt(x)).toEqual(['run.repair'])
    const repair = (await runRecords(x)).find(r => r.kind === 'run.repair')!
    expect(repair.body).toEqual({ generation: 2, swarm: x.name, launch: expect.any(String), budget: { rounds: 3, agents: 6 } })
    const launch = String(repair.body.launch)
    const s = liveSwarm(x.name)!
    expect(s).toEqual(expect.objectContaining({ launch, run: { runDir: x.runDir, run: RUN, generation: 2 }, budget: { rounds: 3, agents: 6 }, readOnly: false, state: 'live' }))
    // Decision 10: the runner works in the run's own checkout, which the reopen made the active run's again.
    expect(s.dirs.runner).toEqual(expect.objectContaining({ dir: w.dir, created: false }))
    const policy = await readPolicy(w.p, w.litterDir)
    expect(policy?.run).toEqual(expect.objectContaining({ run: RUN, checkout: w.dir }))
    const start = await startOf(x, launch)
    expect(start.confirmedBy).toEqual({ run: RUN })
    expect(Object.keys(start.authority)).toEqual(['runner', 'executor', 'critic'])
    expect(await refOf(w, x.name)).not.toBeNull()
    const { records: spec } = await readLedger(w.p, swarmDir(w.litterDir, x.name), `swarm:${x.name}`)
    expect(spec.find(r => r.kind === 'swarm.revision')?.body).toEqual(expect.objectContaining({ n: 1, from: 'repair' }))
    // The spec takes over only the gates with no land; the gap is the critic's words.
    const task = (await savedSpec(x)).nodes[0]!.task!
    expect(task).toContain('Gates to land, in the plan\'s order: G2 and G3')
    expect(task).toContain(`The plan gap, as the critic's last verdict on G2 states it: "${GAP}"\n`)

    // The run's own confirmation covers it: no ask, no prompt fill; the baseline is found, not run.
    expect(w.p.asked).toEqual([])
    expect(w.p.filled).toEqual([])
    expect(calls.verifies).toBe(0)
    expect(calls.summaries).toBe(1)
    expect(summary(x)).toContain(`Plan-template swarm ${x.name} (launch ${launch}) took over in generation 2, to land gates G2 and G3`)

    // The notification turn's note, then the start from a timer after the lead's turn.
    expect(repairNote(w.p)).toBe(renderSlots(REPAIR_NOTE, { swarm: x.name, run: RUN }))
    await repairTurnComplete(w.p, leadTurn)
    expect(w.p.afters.map(a => a.ms)).toEqual([0])
    expect(w.p.submitted).toEqual([])
    expect(await runAfters(w.p)).toBe(1)
    expect(w.p.submitted).toEqual([renderSlots(REPAIR_START, { swarm: x.name, run: RUN })])
  })

  for (const [halt, n] of [['executor_gap', 1], ['executor_gap_late', 2]] as const) {
    test(`an executor's plan-gap stop on attempt ${n}${n === 2 ? ', after a rejection,' : ', before any verdict,'} starts it too, in the executor's words (WP-AH)`, async () => {
      const x = await run({ halt })
      await continueAsRepair(w.p, x.runDir)
      expect(await afterHalt(x)).toEqual(['run.repair'])
      expect(liveSwarm(x.name)?.run).toEqual({ runDir: x.runDir, run: RUN, generation: 2 })
      const task = (await savedSpec(x)).nodes[0]!.task!
      expect(task).toContain(`which halted at gate G2: the executor stopped on attempt ${n} with a plan gap, before the attempt was judged.\n`)
      expect(task).toContain(`The plan gap, as the executor stated it when it stopped on G2, before its attempt was judged: "${GAP}"\n`)
      expect(task).not.toContain("the critic's last verdict")
      // The stop cites no verify; the evidence is the last judged attempt's, when there was one.
      if (n === 1) expect(task).not.toContain("the full log of the halted gate's last verify")
      else expect(task).toContain(`the full log of the halted gate's last verify ${x.g2[0]!.verify_id} (exit 0)`)
      expect(task).toContain("Gates to land, in the plan's order: G2 and G3\n")
      expect(w.p.asked).toEqual([])
      expect(calls.verifies).toBe(0)
      // summary.md: the Repair part says what took over; Where it stopped shows the executor's gap.
      const text = summary(x)
      expect(text).toContain(`Plan-template swarm ${x.name} (launch `)
      expect(text).toContain(`Its executor stopped on attempt ${n} before the attempt was judged, naming a plan gap:\n- plan_gap: ${GAP}`)
    })
  }

  for (const halt of ['attempts', 'recritique'] as const) {
    test(`attempts out${halt === 'recritique' ? ', a re-critique counted,' : ''} start it too`, async () => {
      const x = await run({ halt })
      await continueAsRepair(w.p, x.runDir)
      expect(await afterHalt(x)).toEqual(['run.repair'])
      expect(liveSwarm(x.name)?.run).toEqual({ runDir: x.runDir, run: RUN, generation: 2 })
      const task = (await savedSpec(x)).nodes[0]!.task!
      expect(task).toContain('which halted at gate G2: 3 attempts were judged and none landed, and the run allows 3.')
      expect(task).not.toContain('The plan gap')
      expect(w.p.asked).toEqual([])
    })
  }

  test("a re-critique's verdict counts: attempts 1, 2 and 2 judged three times are the run's three", async () => {
    const x = await run({ halt: 'recritique', maxAttempts: 3 })
    const verdicts = (await runRecords(x)).filter(r => r.kind === 'verdict' && x.g2.some(v => v.verify_id === r.body.verify_id))
    expect(verdicts).toHaveLength(3)
    expect(x.g2.map(v => v.attempt)).toEqual([1, 2, 2])
    await continueAsRepair(w.p, x.runDir)
    expect(await declinedReason(x)).toBeNull()
  })
})

describe('under repair: auto, the halts that decline (decision 6)', () => {
  const cases: [string, ExecOpts, string][] = [
    ["an executor's blocked", { halt: 'blocked' }, `the run halted at gate G2 (G2: the executor is blocked: it needs a database the plan never mentions), and ${THE_TWO}`],
    // WP-AH: every block with an empty plan_gap still declines, whatever stopped it.
    ["an executor's block on a plan line clashing with a rule", { halt: 'blocked', blocked: 'plan.md:8 asks for curl, and P-no-net@1 bans the network' }, `the run halted at gate G2 (G2: the executor is blocked: plan.md:8 asks for curl, and P-no-net@1 bans the network), and ${THE_TWO}`],
    ["an executor's block on a denied tool", { halt: 'blocked', blocked: 'Bash(npm install) was denied' }, `(G2: the executor is blocked: Bash(npm install) was denied), and ${THE_TWO}`],
    ["an executor's block on checks it can't make pass", { halt: 'blocked', blocked: 'tests/test_load.sh still fails' }, `(G2: the executor is blocked: tests/test_load.sh still fails), and ${THE_TWO}`],
    ["a critic's rule clash, the user's to settle", { halt: 'rule_clash' }, `gate G2's critic names a rule clash, which only you can settle ("${CLASH}"), and ${THE_TWO}`],
    // The executor's earlier plan-gap stop doesn't bridge once a later verdict on the gate is the latest event.
    ["an executor's plan-gap stop, then a later verdict's rule clash", { halt: 'executor_gap_then_clash' }, `gate G2's critic names a rule clash, which only you can settle ("${CLASH}"), and ${THE_TWO}`],
    // A done executor result after the gate's last verdict, with no verify: the critic returned nothing.
    ['a critic that returned nothing after a done executor', { halt: 'critic_null' }, `the run halted at gate G2 (critic for G2 returned nothing), and ${THE_TWO}`],
    ['an agent that returned nothing', { halt: 'null_agent' }, `the run halted at gate G2 (G2: the executor returned nothing), and ${THE_TWO}`],
    ['the token budget', { halt: 'budget' }, `the run halted at gate G2 (the token budget ran out at G2), and ${THE_TWO}`],
    ['a land refused with retry: false', { halt: 'retry_false' }, `the run halted at gate G2 (G2: the land was refused: the checkout is on main, not ${BRANCH}), and ${THE_TWO}`],
    ['an approval whose land the mod abandoned, at the last attempt', { halt: 'abandoned' }, 'gate G2 was approved, but the mod refused its land (git refused to move the index, so nothing moved: index.lock exists)'],
    ['a red goal check after every gate landed', { halt: 'goal_red', goal: true }, 'every gate landed, but the goal check goal-1-'],
    ['an amend run (decision 13)', { halt: 'plan_gap', amend: true }, AMEND_HALT],
  ]
  for (const [what, opts, reason] of cases) {
    test(`${what}: repair.declined with the reason, the summary rewritten, and nothing else`, async () => {
      const x = await run(opts)
      await continueAsRepair(w.p, x.runDir)
      const got = await declinedReason(x)
      expect(got).toContain(reason)
      expect(await afterHalt(x)).toEqual(['repair.declined'])
      await nothingStarted(x)
      expect(calls.summaries).toBe(1)
      expect(summary(x)).toContain(`No plan-template swarm started: ${got}.`)
    })
  }

  test("a red goal check's reason names the verify and how it ended", async () => {
    const red = await run({ halt: 'goal_red', goal: true })
    await continueAsRepair(w.p, red.runDir)
    expect(await declinedReason(red)).toMatch(/^every gate landed, but the goal check goal-1-[0-9a-f]{10} wasn't green \(exit 1\), and a plan-template swarm takes on only/)
  })

  for (const halt of ['interrupted', 'stopped'] as const) {
    test(`an ${halt} run is no bridge's: nothing is recorded or started`, async () => {
      const x = await run({ halt })
      await continueAsRepair(w.p, x.runDir)
      expect(await afterHalt(x)).toEqual([])
      await nothingStarted(x)
      expect(await repairSummary(w.p, x.runDir)).toBe('')
    })
  }

  test('a run.json from before 2b-2 (no repair setting) is a no-op', async () => {
    const x = await run({ noRepair: true })
    await continueAsRepair(w.p, x.runDir)
    expect(await afterHalt(x)).toEqual([])
    await nothingStarted(x)
  })

  test('a second call after a decline adds nothing', async () => {
    const x = await run({ mode: 'off' })
    await continueAsRepair(w.p, x.runDir)
    await continueAsRepair(w.p, x.runDir)
    expect(await afterHalt(x)).toEqual(['repair.declined'])
  })
})

describe("the preconditions, in decision 7's order", () => {
  test('under off: repair.declined, no run.repair, no swarm folder, no refs/litter-swarm/*, and the summary offers the routes', async () => {
    const x = await run({ mode: 'off' })
    await continueAsRepair(w.p, x.runDir)
    expect(await declinedReason(x)).toBe('repair is off for this run')
    expect(await afterHalt(x)).toEqual(['repair.declined'])
    await nothingStarted(x)
    expect(existsSync(`${w.litterDir}/swarms`)).toBe(false)
    const text = summary(x)
    expect(text).toContain('No plan-template swarm started: repair is off for this run.')
    expect(text).toContain("Recommended: continue as a plan-template swarm. Gate G2 halted: the critic's verdict on attempt 1 names a plan gap.")
    expect(text).toContain(`The plan gap: "${GAP}".`)
    expect(text).toContain(`Under repair: auto, ${renderSlots(CONFIRM_AUTO, { rounds: 3, attempts: 3, agents: 6 })}.`)
    expect(text).toContain(
      `The ways on: continue as a plan-template swarm (/litter:swarm repair ${RUN}), amend the gate (/litter:amend G2 …), or stop; the halted attempt, if any, is still in the tree.`,
    )
  })

  type Case = { what: string; opts?: ExecOpts; set?: (x: Exec) => Promise<void> | void; reason: string }
  const lockHeld = async () => {
    const blob = JSON.stringify({ run: '20261003-other', session: 'sess-b', acquiredAt: 1 })
    const r = await w.p.run(['git', '-C', w.dir, 'hash-object', '-w', '--stdin'], { stdin: blob })
    await w.git('update-ref', 'refs/litter-active', r.stdout.trim())
  }
  const badSpec = () => void (w.check = { ok: false, errors: [{ field: 'nodes.runner.worktree', node: 'runner', error: 'a bad worktree' }], warnings: [] })
  const cases: Case[] = [
    { what: 'an end found at reconcile', opts: { source: 'reconcile' }, reason: "the run's end was found at session start" },
    { what: 'a non-interactive session', set: () => setInteractive(false), reason: "no one to watch it: this session isn't interactive" },
    { what: 'a spec that fails validation', set: badSpec, reason: 'nodes.runner.worktree: a bad worktree' },
    {
      what: 'a health check error',
      set: () => void (w.health = { rows: [{ id: 'depth', severity: 'error', title: 'Spawn depth', detail: 'too shallow' }], errors: 1, warnings: 0, snippet: null }),
      reason: 'Spawn depth: too shallow',
    },
    { what: 'the run lock held', set: lockHeld, reason: 'the run lock is held by run 20261003-other (session sess-b)' },
    // Pairs: the earlier check's reason wins.
    { what: 'off and an amend run', opts: { mode: 'off', amend: true }, reason: 'repair is off for this run' },
    { what: 'reconcile and a blocked halt', opts: { source: 'reconcile', halt: 'blocked' }, reason: "the run's end was found at session start" },
    { what: 'an amend run in a non-interactive session', opts: { amend: true }, set: () => setInteractive(false), reason: AMEND_HALT },
    {
      what: 'a non-interactive session and a bad spec',
      set: () => {
        setInteractive(false)
        badSpec()
      },
      reason: "no one to watch it: this session isn't interactive",
    },
    {
      what: 'a bad spec and the lock held',
      set: async () => {
        badSpec()
        await lockHeld()
      },
      reason: 'nodes.runner.worktree: a bad worktree',
    },
    { what: 'the lock held and no baseline', opts: { staleBaseline: true }, set: lockHeld, reason: 'the run lock is held by run 20261003-other' },
  ]
  for (const c of cases) {
    test(`${c.what}: declined with "${c.reason.slice(0, 40)}…", nothing started`, async () => {
      const x = await run(c.opts)
      await c.set?.(x)
      await continueAsRepair(w.p, x.runDir)
      expect(await declinedReason(x)).toContain(c.reason)
      expect(await afterHalt(x)).toEqual(['repair.declined'])
      await nothingStarted(x)
      expect(calls.summaries).toBe(1)
    })
  }
})

describe('the baseline (decision 9)', () => {
  test("found: G1's green verify of the branch tip's tree, from the chain, named in the ask; no verify runs", async () => {
    const x = await run({ mode: 'off' })
    w.p.answers.push('Cancel')
    await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })
    const g1 = x.lands[0]!
    expect(w.p.asked[0]!.question).toContain(`Baseline: verify ${g1.verifyId} is green on ${BRANCH}'s tip ${g1.commit.slice(0, 12)}.`)
    expect(calls.verifies).toBe(0)
  })

  const missing: [string, ExecOpts, (x: Exec) => Promise<void> | void, (x: Exec) => string][] = [
    ['no green verify of the tip with the run\'s argv', { staleBaseline: true }, () => {}, () => "no green verify of the branch's tip; the suite may have been red before the halted gate"],
    [
      'the branch moved past the last land',
      {},
      async () => void (await w.git('commit', '-q', '--allow-empty', '-m', 'by hand')),
      () => `the run's branch moved: ${BRANCH} is at`,
    ],
    ['the checkout on another branch', {}, async () => void (await w.git('switch', '-q', 'main')), () => `the checkout changed: ${w.dir} is on main, not the run's branch ${BRANCH}`],
  ]
  for (const [what, opts, set, reason] of missing) {
    test(`missing (${what}): declined, nothing started, no verify run`, async () => {
      const x = await run(opts)
      await set(x)
      await continueAsRepair(w.p, x.runDir)
      expect(await declinedReason(x)).toContain(reason(x))
      expect(await afterHalt(x)).toEqual(['repair.declined'])
      await nothingStarted(x)
    })
  }

  test("a moved branch names where the run left it: the last land's commit", async () => {
    const x = await run()
    await w.git('commit', '-q', '--allow-empty', '-m', 'by hand')
    await continueAsRepair(w.p, x.runDir)
    expect(await declinedReason(x)).toContain(`not ${x.lands[0]!.commit} where the run left it`)
  })

  test('a stale baseline still offers the routes, without recommending the swarm', async () => {
    const x = await run({ staleBaseline: true })
    await continueAsRepair(w.p, x.runDir)
    const text = await repairSummary(w.p, x.runDir)
    expect(text).toContain("No plan-template swarm started: no green verify of the branch's tip")
    expect(text).not.toContain('Recommended:')
    expect(text).toContain(`/litter:swarm repair ${RUN}`)
  })
})

describe('repair.start for an execute run, under off', () => {
  test('Cancel writes nothing; the ask names the run, the halt, the gap, the gates left, the checkout, the budget and the baseline', async () => {
    const x = await run({ mode: 'off' })
    w.p.answers.push('Cancel')
    const r = (await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as RecordReply & { error?: string }
    expect(r).toEqual({ ok: false, error: `litter: the repair of run ${RUN} wasn't confirmed; nothing was started` })
    expect(w.p.asked).toHaveLength(1)
    const q = w.p.asked[0]!
    expect(q.options).toEqual(['Launch', 'Cancel'])
    for (const line of [
      `Start plan-template swarm ${x.name} for execute run ${RUN}?`,
      "Halted: gate G2, because the critic's verdict on attempt 1 names a plan gap.",
      `The plan gap: "${GAP}"`,
      'Gates left: G2 and G3.',
      `It works in the run's checkout ${w.dir}, on ${BRANCH}, starting from the halted attempt, if any, still in its tree.`,
      `The mod lands each gate on ${BRANCH} only once it's verified and an independent critic approves it. Nothing is pushed.`,
      'Budget: up to 3 rejected attempts in all, 3 per gate, and 6 agents',
      "verify yes (the mod runs the run's verify)",
      'land yes (the mod lands only a verified, approved tree)',
    ]) {
      expect(q.question).toContain(line)
    }
    expect(await afterHalt(x)).toEqual([])
    expect(existsSync(swarmDir(w.litterDir, x.name))).toBe(false)
    expect(await refOf(w, x.name)).toBeNull()
    expect(calls.verifies).toBe(0)
  })

  test('Launch goes live with confirmedBy ask and fills the start line; the summary then says what took over', async () => {
    const x = await run({ mode: 'off', halt: 'attempts' })
    w.p.answers.push('Launch')
    const r = (await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as Record<string, unknown>
    expect(r).toEqual(expect.objectContaining({ ok: true, run: RUN, swarm: x.name, generation: 2, budget: { rounds: 3, agents: 6 } }))
    expect(String(r.next)).toStartWith(`Plan-template swarm ${x.name} is live.`)
    expect((await startOf(x, String(r.launch))).confirmedBy).toEqual({ ask: true })
    expect(w.p.filled).toHaveLength(1)
    expect(w.p.filled[0]!.split('\n')[0]).toBe(`/litter:swarm start ${x.name}`)
    expect(await afterHalt(x)).toEqual(['run.repair'])
    expect(repairNote(w.p)).toBeNull()
    expect(summary(x)).toContain(`Plan-template swarm ${x.name} (launch ${String(r.launch)}) took over in generation 2, to land gates G2 and G3`)
  })

  test('an amend run is refused with decision 13 words, asking nothing', async () => {
    const asError = async () => (await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as { ok: boolean; error?: string; field?: string }
    const amend = await run({ mode: 'off', amend: true })
    expect((await asError()).error).toBe(`litter: run ${RUN} can't continue as a swarm: ${AMEND_HALT}; run /litter:design for the gate, then a new plan`)
    expect(await afterHalt(amend)).toEqual([])
    expect(w.p.asked).toEqual([])
  })

  test('a blocked halt is refused with the advice to amend the gate', async () => {
    await run({ mode: 'off', halt: 'blocked' })
    const r = (await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as { ok: boolean; error?: string; field?: string }
    expect(r).toEqual({ ok: false, field: 'run', error: expect.stringContaining("can't continue as a swarm: the run halted at gate G2") })
    expect(r.error).toContain('amend the gate (/litter:amend G2)')
    expect(w.p.asked).toEqual([])
  })

  test('a missing baseline is refused before the ask', async () => {
    await run({ mode: 'off', staleBaseline: true })
    const r = (await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as { ok: boolean; error?: string }
    expect(r.error).toBe(`litter: no repair of run ${RUN}: no green verify of the branch's tip; the suite may have been red before the halted gate`)
    expect(w.p.asked).toEqual([])
  })

  test('an interrupted run is refused: it ended interrupted, not halted', async () => {
    await run({ mode: 'off', halt: 'interrupted' })
    const r = (await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as { ok: boolean; error?: string }
    expect(r.error).toBe(`litter: run ${RUN} ended interrupted, not halted, so there's nothing to repair`)
  })

  test('after an auto decline (a non-interactive session), repair.start can still start it', async () => {
    const x = await run()
    setInteractive(false)
    await continueAsRepair(w.p, x.runDir)
    expect(await declinedReason(x)).toContain('no one to watch it')
    expect(summary(x)).toContain('Recommended: continue as a plan-template swarm.')
    w.p.answers.push('Launch')
    expect(((await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as { ok: boolean }).ok).toBe(true)
    expect(await afterHalt(x)).toEqual(['repair.declined', 'run.repair'])
  })
})

describe("summary.md's Repair section for an execute run", () => {
  test("an amend's halt says decision 13's words, and offers no swarm", async () => {
    const x = await run({ amend: true })
    await continueAsRepair(w.p, x.runDir)
    const text = await repairSummary(w.p, x.runDir)
    expect(text).toContain(`No plan-template swarm started: ${AMEND_HALT}.`)
    expect(text).not.toContain('/litter:swarm repair')
    expect(text).not.toContain("A plan-template swarm can't take this on")
  })

  test("a halt that doesn't bridge says why and what instead, with no swarm route", async () => {
    const x = await run({ halt: 'blocked' })
    await continueAsRepair(w.p, x.runDir)
    const text = await repairSummary(w.p, x.runDir)
    expect(text).toContain("A plan-template swarm can't take this on: the run halted at gate G2 (G2: the executor is blocked")
    expect(text).toContain('Instead, read the summary for why; amend the gate (/litter:amend G2)')
    expect(text).not.toContain('/litter:swarm repair')
  })

  test("a critic's rule clash under off offers no swarm, and repair.start refuses it with where to settle it (WP-AH)", async () => {
    const x = await run({ mode: 'off', halt: 'rule_clash' })
    await continueAsRepair(w.p, x.runDir)
    const text = await repairSummary(w.p, x.runDir)
    expect(text).toContain(`A plan-template swarm can't take this on: gate G2's critic names a rule clash, which only you can settle ("${CLASH}").`)
    expect(text).toContain('Instead, edit the rule or add an exception in /litter rules, or change the plan\'s lines with /litter:amend G2, then continue the run.')
    expect(text).not.toContain('/litter:swarm repair')
    expect(summary(x)).toContain(`- rule_clash: ${CLASH}`)
    const r = (await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })) as { ok: boolean; error?: string }
    expect(r.error).toContain("can't continue as a swarm: gate G2's critic names a rule clash, which only you can settle")
    expect(w.p.asked).toEqual([])
  })

  test("under off, an executor's plan-gap stop is recommended as a swarm with the executor's gap, and repair.start's ask names it", async () => {
    const x = await run({ mode: 'off', halt: 'executor_gap' })
    await continueAsRepair(w.p, x.runDir)
    expect(await declinedReason(x)).toBe('repair is off for this run')
    const text = await repairSummary(w.p, x.runDir)
    expect(text).toContain(
      'Recommended: continue as a plan-template swarm. Gate G2 halted: the executor stopped on attempt 1 with a plan gap, before the attempt was judged.',
    )
    expect(text).toContain(`The plan gap: "${GAP}".`)
    const all = summary(x)
    expect(all).toContain(`halted: G2 plan gap: ${GAP}`)
    expect(all).toContain(`Its executor stopped on attempt 1 before the attempt was judged, naming a plan gap:\n- plan_gap: ${GAP}\nNo verdict was recorded for it.`)
    w.p.answers.push('Cancel')
    await recordRepairStart(ctxOf(), { kind: 'repair.start', run: RUN })
    const q = w.p.asked[0]!.question
    expect(q).toContain('Halted: gate G2, because the executor stopped on attempt 1 with a plan gap, before the attempt was judged.')
    expect(q).toContain(`The plan gap: "${GAP}"`)
  })

  test('attempts out names the count, with no gap; an unknown run has no section', async () => {
    const x = await run({ mode: 'off', halt: 'attempts' })
    await continueAsRepair(w.p, x.runDir)
    const text = await repairSummary(w.p, x.runDir)
    expect(text).toContain('Gate G2 halted: 3 attempts were judged and none landed, and the run allows 3.')
    expect(text).not.toContain('The plan gap')
    expect(await repairSummary(w.p, `${w.litterDir}/20261003-none`)).toBe('')
  })
})

describe('repair.budget for a plan-template swarm', () => {
  test('its ask and its answer count rejected attempts, and point to the runner', async () => {
    const x = await run()
    await continueAsRepair(w.p, x.runDir)
    w.p.answers.push('Grant')
    const r = (await recordRepairBudget(ctxOf(), { kind: 'repair.budget', swarm: x.name, rounds: 2 })) as Record<string, unknown>
    expect(r).toEqual(expect.objectContaining({ ok: true, swarm: x.name, granted: true, budget: { rounds: 5, agents: 6 } }))
    const q = w.p.asked[0]!.question
    expect(q).toContain(`Give plan-template swarm ${x.name} 2 more rejected attempts?`)
    expect(q).toContain(`It lands the remaining gates of execute run ${RUN}. It has used 0 of 3 rejected attempts and 0 of 6 agents.`)
    expect(q).toContain('With this, its budget is 5 rejected attempts and 6 agents.')
    expect(String(r.next)).toBe(`Tell the plan-template swarm's runner with mcp__litter__swarm_send (node runner) that its budget is now 5 rejected attempts and 6 agents.`)
    expect(liveSwarm(x.name)?.budget).toEqual({ rounds: 5, agents: 6 })
  })
})
