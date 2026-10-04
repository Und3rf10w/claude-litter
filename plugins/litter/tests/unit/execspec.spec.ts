// Tier 2: the plan template's spec (hooks/repair.ts, repairSpec for an
// execute run; phase 3, WP-AC step 4) and its texts (hooks/prompts/
// swarm-plan.ts, step 5), against real git: the spec passes J's real
// validateSpec with and without an adversary; its nodes as COMMON step 5
// shapes them; the runner's task holds the run's facts only (the gap quoted
// from the critic's verdict, which the runner needs), never the plan's text
// or a gate's title; each node type carries its authority lines; and the
// texts keep plan 12:1440's rules (no backtick, no dollar-brace, a brief at
// most 16 KiB, the slots their docs list, the tags a node's prompt has).

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import type { SwarmNode } from '../../hooks/swarm/types'
import { planPath, summaryPath, verdictsDir, verifyLogDir } from '../../hooks/layout'
import { BRIEF_MAX_BYTES, validateCtxFor, validateSpec } from '../../hooks/swarm/spec'
import { nodeTypeSpec } from '../../hooks/swarm/launch'
import { renderSlots } from '../../hooks/prompts/slots'
import * as planPrompts from '../../hooks/prompts/swarm-plan'
import {
  PLAN_ADVERSARY_BRIEF,
  PLAN_CRITIC_BRIEF,
  PLAN_EXECUTOR_BRIEF,
  PLAN_GOAL,
  PLAN_GOAL_LINE,
  PLAN_RUNNER_BRIEF,
  PLAN_TASK,
} from '../../hooks/prompts/swarm-plan'
import { AUTHORITY_COMMIT_NO, AUTHORITY_LAND_YES, AUTHORITY_PUSH_NONE, AUTHORITY_VERDICTS_YES, AUTHORITY_VERIFY_YES } from '../../hooks/prompts/swarm-node'
import { repairSpec, resetRepairForTests, type RepairSpecResult } from '../../hooks/repair'
import { world, type World } from './swarmlaunch-harness'
import { BRANCH, GAP, PLAN_TEXT, RUN, TITLES, executeRun, type Exec, type ExecOpts } from './execbridge-harness'

setDefaultTimeout(120_000)

let w: World
beforeEach(async () => {
  w = await world('sess-a')
  resetRepairForTests()
})
afterEach(async () => {
  resetRepairForTests()
  await w.done()
})

const WRITES = ['Edit', 'Write', 'NotebookEdit']

async function made(o: ExecOpts = {}): Promise<{ x: Exec; r: Extract<RepairSpecResult, { ok: true }> }> {
  const x = await executeRun(w, o)
  const r = await repairSpec(w.p, x.runDir)
  if (!r.ok) throw new Error(r.reason)
  return { x, r }
}

async function validated(r: Extract<RepairSpecResult, { ok: true }>) {
  const ctx = await validateCtxFor(w.p, w.litterDir, async node => r.briefs[node] ?? null)
  return validateSpec(w.p, r.spec, ctx)
}

const nodeOf = (r: Extract<RepairSpecResult, { ok: true }>, id: string): SwarmNode => {
  const n = r.spec.nodes.find(x => x.id === id)
  if (!n) throw new Error(`no node ${id}`)
  return n
}

describe('the generated spec', () => {
  test("without an adversary: it passes J's real validateSpec, with the runner, executor and critic COMMON step 5 shapes", async () => {
    const { x, r } = await made()
    const check = await validated(r)
    expect(check.errors).toEqual([])
    expect(check.ok).toBe(true)

    expect(r.spec.name).toBe(x.name)
    expect(r.spec.goal).toBe(renderSlots(PLAN_GOAL, { run: RUN, branch: BRANCH }))
    expect(r.spec.limits).toEqual({ maxAgentsAtOnce: 3 })
    expect(r.spec.nodes.map(n => n.id)).toEqual(['runner', 'executor', 'critic'])
    const runner = nodeOf(r, 'runner')
    expect(runner).toEqual(
      expect.objectContaining({
        kind: 'orchestrator',
        brief: 'briefs/runner.md',
        worktree: { existing: w.dir },
        tools: { deny: WRITES },
        bash: { deny: ['git commit'] },
        spawns: { executor: 1, critic: 1 },
        report: ['blocked', 'done'],
      }),
    )
    // commit unset, for 2b-2's reason: a false would rank under its workers' (15.3).
    expect(runner.authority).toEqual({ push: 'none', rewriteHistory: false, worktreeOps: false, verify: true, land: true })
    const executor = nodeOf(r, 'executor')
    expect(executor).toEqual(expect.objectContaining({ kind: 'worker', worktree: 'inherit', serial: true }))
    expect(executor.authority).toEqual({ commit: false, push: 'none', rewriteHistory: false, worktreeOps: false, verify: true })
    const critic = nodeOf(r, 'critic')
    expect(critic).toEqual(expect.objectContaining({ kind: 'worker', worktree: 'inherit', verdicts: true, spawnOther: false, tools: { deny: WRITES } }))
    expect(critic.authority).toEqual({ commit: false, push: 'none', rewriteHistory: false, worktreeOps: false, verify: true })
    // No node is path-limited: a gate's Files are expected files, not owned ones.
    for (const n of r.spec.nodes) expect(n.paths).toBeUndefined()
    expect(r.briefs).toEqual({ runner: PLAN_RUNNER_BRIEF, executor: PLAN_EXECUTOR_BRIEF, critic: PLAN_CRITIC_BRIEF })
  })

  for (const [what, adversary] of [
    ['the run asks for one (args.adversary)', 'run'],
    ["a remaining gate's Adversary line", 'gate'],
  ] as const) {
    test(`with an adversary, when ${what}: four nodes, and it still validates`, async () => {
      const { r } = await made({ adversary })
      expect((await validated(r)).errors).toEqual([])
      expect(r.spec.nodes.map(n => n.id)).toEqual(['runner', 'executor', 'critic', 'adversary'])
      expect(nodeOf(r, 'runner').spawns).toEqual({ executor: 1, critic: 1, adversary: 1 })
      const adv = nodeOf(r, 'adversary')
      expect(adv).toEqual(expect.objectContaining({ kind: 'worker', worktree: 'inherit', tools: { deny: WRITES }, bash: { deny: ['git commit'] } }))
      expect(adv.authority).toEqual({ commit: false, push: 'none', rewriteHistory: false, worktreeOps: false })
      expect(adv.verdicts).toBeUndefined()
      expect(r.briefs.adversary).toBe(PLAN_ADVERSARY_BRIEF)
    })
  }

  test('a landed gate\'s Adversary line asks for none', async () => {
    const { r } = await made({ adversary: 'landed' })
    expect(r.spec.nodes.map(n => n.id)).toEqual(['runner', 'executor', 'critic'])
    expect(r.briefs.adversary).toBeUndefined()
  })

  test("the runner's task holds the run's facts only: the gates left, what landed, the budget and the evidence paths", async () => {
    const { x, r } = await made()
    const task = nodeOf(r, 'runner').task!
    const g1 = x.lands[0]!
    const last = x.g2.at(-1)!
    for (const line of [
      `Continue execute run ${RUN}, which halted at gate G2: the critic's verdict on attempt 1 names a plan gap.`,
      `The plan gap, as the critic's last verdict on G2 states it: "${GAP}"`,
      "Gates to land, in the plan's order: G2 and G3",
      `Landed before you: G1 (${g1.commit.slice(0, 12)})`,
      `The plan: ${planPath(x.runDir)}, each gate's section under its id`,
      `Your directory, the run's checkout: ${w.dir}, on ${BRANCH} at ${g1.commit}, with the halted attempt still in its tree, uncommitted`,
      'Budget: 3 rejected attempts in all, 3 per gate, and 6 agents',
      `- ${summaryPath(x.runDir)}: the run's summary`,
      `- ${verdictsDir(x.runDir)}: the critic's verdict files`,
      `- ${verifyLogDir(x.runDir, last.verify_id)}: the full log of the halted gate's last verify ${last.verify_id} (exit 0)`,
    ]) {
      expect(task).toContain(line)
    }
    expect(task).not.toContain(PLAN_GOAL_LINE)
    // Never the plan's own text or a gate's title, in the task or anywhere in the spec.
    const spec = JSON.stringify(r.spec)
    for (const text of [...Object.values(TITLES), 'Merge the shipped defaults', 'strict parser', 'Config plan']) {
      expect(task).not.toContain(text)
      expect(spec).not.toContain(text)
    }
    expect(readFileSync(planPath(x.runDir), 'utf8')).toBe(PLAN_TEXT)
    // Every slot was filled or its line dropped.
    expect(task).not.toMatch(/\{[a-z_]+\}/)
  })

  test("attempts out: the count in the task, no gap line, and the last judged attempt's verify as the evidence", async () => {
    const { x, r } = await made({ halt: 'attempts', maxAttempts: 3, rounds: 5, agents: 4 })
    const task = nodeOf(r, 'runner').task!
    expect(task).toContain('which halted at gate G2: 3 attempts were judged and none landed, and the run allows 3.')
    expect(task).not.toContain('The plan gap')
    expect(task).toContain('Budget: 5 rejected attempts in all, 3 per gate, and 4 agents')
    expect(task).toContain(`${verifyLogDir(x.runDir, x.g2[2]!.verify_id)}: the full log of the halted gate's last verify ${x.g2[2]!.verify_id}`)
  })

  test('in goal mode the task says so', async () => {
    const { r } = await made({ goal: true })
    expect(nodeOf(r, 'runner').task).toContain(PLAN_GOAL_LINE)
    expect((await validated(r)).errors).toEqual([])
  })

  test('a halt the template takes on only has a spec: a blocked one, or an amend, has none', async () => {
    const blocked = await executeRun(w, { halt: 'blocked' })
    expect(await repairSpec(w.p, blocked.runDir)).toEqual({ ok: false, reason: expect.stringContaining('a plan-template swarm takes on only a gate that halted on a plan gap or ran out of attempts') })
  })

  test("an amend run's reason is decision 13's alone", async () => {
    const x = await executeRun(w, { amend: true })
    expect(await repairSpec(w.p, x.runDir)).toEqual({ ok: false, reason: "an amend's halt comes back to you; /litter:design is the recommended next step" })
  })
})

describe('the node types', () => {
  test('each carries its authority lines: the runner verify and land, the critic verify and verdicts, and nobody commits', async () => {
    const { r } = await made({ adversary: 'run' })
    const typeOf = (id: string) => nodeTypeSpec(r.spec, id, { brief: r.briefs[id]! })
    const runner = typeOf('runner').prompt
    for (const line of [AUTHORITY_PUSH_NONE, AUTHORITY_VERIFY_YES, AUTHORITY_LAND_YES]) expect(runner).toContain(line)
    expect(runner).not.toContain(AUTHORITY_VERDICTS_YES)
    expect(runner).toContain(PLAN_RUNNER_BRIEF)
    const critic = typeOf('critic')
    for (const line of [AUTHORITY_COMMIT_NO, AUTHORITY_VERIFY_YES, AUTHORITY_VERDICTS_YES]) expect(critic.prompt).toContain(line)
    expect(critic.prompt).not.toContain(AUTHORITY_LAND_YES)
    expect(critic.disallowedTools).toEqual(expect.arrayContaining([...WRITES, 'Agent']))
    const executor = typeOf('executor').prompt
    for (const line of [AUTHORITY_COMMIT_NO, AUTHORITY_VERIFY_YES]) expect(executor).toContain(line)
    expect(executor).not.toContain(AUTHORITY_LAND_YES)
    const adversary = typeOf('adversary')
    expect(adversary.prompt).toContain(AUTHORITY_COMMIT_NO)
    expect(adversary.prompt).not.toContain(AUTHORITY_VERIFY_YES)
    expect(adversary.disallowedTools).toEqual(expect.arrayContaining(WRITES))
  })
})

describe("swarm-plan.ts's texts", () => {
  const texts = Object.entries(planPrompts) as [string, string][]
  const briefs = { PLAN_RUNNER_BRIEF, PLAN_EXECUTOR_BRIEF, PLAN_CRITIC_BRIEF, PLAN_ADVERSARY_BRIEF }
  const slotsOf = (text: string) => [...new Set([...text.matchAll(/\{([a-z_]+)\}/g)].map(m => m[1]!))].sort()

  test('no backtick, no dollar-brace and no model named in any of them', () => {
    expect(texts.length).toBeGreaterThan(10)
    for (const [key, text] of texts) {
      expect({ key, type: typeof text }).toEqual({ key, type: 'string' })
      expect({ key, backtick: text.includes('`'), dollar: text.includes('${') }).toEqual({ key, backtick: false, dollar: false })
      expect({ key, model: /\b(opus|sonnet|haiku|claude-[0-9])/i.test(text) }).toEqual({ key, model: false })
    }
  })

  test('each brief is at most 16 KiB and has no slot; it names only the tags a node prompt has', () => {
    for (const [key, text] of Object.entries(briefs)) {
      expect({ key, small: new TextEncoder().encode(text).length <= BRIEF_MAX_BYTES }).toEqual({ key, small: true })
      expect({ key, slots: slotsOf(text) }).toEqual({ key, slots: [] })
      const tags = [...new Set([...text.matchAll(/<([a-z][a-z_-]*)>/g)].map(m => m[1]!))]
      for (const tag of tags) expect({ key, tag, known: ['instance', 'rules', 'goal', 'brief'].includes(tag) }).toEqual({ key, tag, known: true })
    }
  })

  test("the templates' slots are the ones their docs list", () => {
    expect(slotsOf(PLAN_TASK)).toEqual(
      ['agents', 'attempts', 'branch', 'checkout', 'gap', 'gate', 'goal_line', 'landed', 'plan', 'remaining', 'rounds', 'run', 'summary', 'tip', 'verdicts', 'verify_line', 'why'].sort(),
    )
    expect(slotsOf(planPrompts.PLAN_WHY_GAP)).toEqual(['attempt'])
    expect(slotsOf(planPrompts.PLAN_WHY_ATTEMPTS)).toEqual(['count', 'max'])
    expect(slotsOf(PLAN_GOAL_LINE)).toEqual([])
    expect(slotsOf(planPrompts.PLAN_EVIDENCE_VERIFY)).toEqual(['dir', 'how', 'verify_id'])
    expect(slotsOf(PLAN_GOAL)).toEqual(['branch', 'run'])
    expect(slotsOf(planPrompts.CONFIRM_AUTO)).toEqual(['agents', 'attempts', 'rounds'])
    expect(slotsOf(planPrompts.CONFIRM_OFF)).toEqual([])
  })

  test("the runner's brief carries 15.11's four ask cases, the amendment, and the mod's verify, verdict and land (decision 8)", () => {
    for (const text of [
      '- intent: requirements conflict',
      '- scope: finishing a gate means changing what the plan asks or requires',
      'recommend amending that gate with /litter:amend',
      '- authority: you need access you weren\'t given',
      '- budget: finishing needs more rejected attempts or agents than you have',
      "a plan gap that the plan's own lines and contracts settle",
      'mcp__litter__record with kind verify and the gate',
      'call mcp__litter__record with kind land, the gate, and the verify_id that verdict cites',
      'with kind verify and goal as gate',
      'report done to the lead',
      'Keep your workers across gates',
    ]) {
      expect(PLAN_RUNNER_BRIEF).toContain(text)
    }
  })

  test("the critic's brief records its verify first, then execute's VERDICT plus gate; nobody commits", () => {
    for (const text of [
      'Before anything else, call mcp__litter__record with kind verify and the gate',
      "- gate: the gate you judged;",
      '- verify_id: the verify you recorded for it;',
      '- plan_adherence, tests_green, no_regressions and rules',
      '- plan_gap: the plan gap in words, or an empty string',
      '- proposed_rules:',
      'the mod sets it from your verify',
    ]) {
      expect(PLAN_CRITIC_BRIEF).toContain(text)
    }
    expect(PLAN_EXECUTOR_BRIEF).toContain('Never commit, push or stage anything')
    expect(PLAN_ADVERSARY_BRIEF).toContain('You change nothing')
    for (const brief of [PLAN_EXECUTOR_BRIEF, PLAN_CRITIC_BRIEF, PLAN_ADVERSARY_BRIEF]) expect(brief).toContain('<rules>')
  })

  test("the briefs don't correct the authority and budget lines, which now hold for this swarm (WP-AG)", () => {
    for (const [key, brief] of Object.entries(briefs)) {
      expect({ key, corrects: /Your authority list (speaks|says)|counts rejected attempts as rounds/.test(brief) }).toEqual({ key, corrects: false })
    }
    // What they add stays: a rejection is what the budget counts, and nobody but the mod commits.
    expect(PLAN_RUNNER_BRIEF).toContain('Only a rejection counts against your budget: each one is a rejected attempt, and the mod caps them per gate and in all. An approval uses none.')
    expect(PLAN_RUNNER_BRIEF).toContain('nobody in this swarm commits')
    expect(PLAN_CRITIC_BRIEF).toContain('You are the critic for one gate of a plan at a time.')
  })
})
