// Tier 2: workflows/plan.js (plan section 7, "Gates come from a litter:plan-run
// workflow"; docs/litter-execute COMMON.md, step 2), run under bun against a
// scripted agent() whose results are checked against the GATES schema. One
// planner call, its tags as the planner's role sees them, and the return as
// decodeReturn's plan row reads it.

import { describe, expect, test } from 'bun:test'
import type { PlannedGate } from '../../hooks/records/execute'
import { decodeReturn } from '../../hooks/lifecycle'
import { ROLE_TAGS } from '../../hooks/prompts/index'
import {
  deliveredTags,
  gatesReply,
  GOAL_CHECK,
  instructionOf,
  loadScript,
  NONCE,
  planArgs,
  plannedGate,
  PROSE_PATH,
  runScript,
  strictProblem,
  tagBody,
  VERIFY,
  type Reply,
  type Run,
} from './executejs-harness'

const run = (args: unknown, replies: Record<string, Reply | Reply[]>) => runScript('plan', { args, replies })
const labels = (r: Run) => r.calls.map(c => c.label)
const decoded = (r: Run) => {
  expect(r.error).toBeNull()
  return decodeReturn('plan', { status: 'completed', result: r.result })
}
const tagsOf = (r: Run) => deliveredTags(r.calls[0]!.prompt, NONCE).filter(t => !t.close).map(t => t.name)

function expectPlannerEnvelope(r: Run) {
  for (const c of r.calls) {
    expect(c.agentType).toBe('litter:planner')
    for (const t of deliveredTags(c.prompt, NONCE)) {
      expect({ tag: t.name, nonce: t.nonce, allowed: ROLE_TAGS.planner!.includes(t.name as never) }).toEqual({ tag: t.name, nonce: true, allowed: true })
    }
    expect(instructionOf(c.prompt, NONCE)).not.toContain(`id="${NONCE}"`)
  }
}

const PROSE = '# Header parsing\n\nParse the header line.\nThen use it in main.\n'

describe('one planner call', () => {
  test('a goal: the goal, the commands and the rules, then the instruction', async () => {
    const reply = gatesReply(['G1', 'G2'])
    const r = await run(planArgs({ goalCheckCommand: GOAL_CHECK }), { planner: reply })
    expect(labels(r)).toEqual(['planner'])
    expect(r.calls[0]!.opts).toEqual(expect.objectContaining({ agentType: 'litter:planner', phase: 'Plan' }))
    expect(tagsOf(r)).toEqual(['goal', 'verify', 'goal_check', 'rules'])
    const p = r.calls[0]!.prompt
    expect(tagBody(p, 'goal', NONCE)).toBe('Parse and use the header.')
    expect(tagBody(p, 'verify', NONCE)).toBe(VERIFY)
    expect(tagBody(p, 'goal_check', NONCE)).toBe(GOAL_CHECK)
    expect(tagBody(p, 'rules', NONCE)).toBe('For this run (stated by you): keep changes small\nR0@1 (always): no new dependencies')
    expect(instructionOf(p, NONCE)).toBe('Plan the goal as an ordered list of gates.')
    expect(r.result).toEqual(reply)
    expect(decoded(r)).toEqual({ status: 'done', reason: null })
    expectPlannerEnvelope(r)
  })

  test('a prose plan: its path and its lines numbered from 1, and no goal tag', async () => {
    const r = await run(planArgs({ goal: '', plan: PROSE, planPath: PROSE_PATH }), { planner: gatesReply(['G1']) })
    expect(tagsOf(r)).toEqual(['plan', 'verify', 'rules'])
    const p = r.calls[0]!.prompt
    expect(p).toContain(`<plan id="${NONCE}" path="${PROSE_PATH}">`)
    expect(tagBody(p, 'plan', NONCE)).toBe('1\t# Header parsing\n2\t\n3\tParse the header line.\n4\tThen use it in main.')
    expect(instructionOf(p, NONCE)).toBe('Turn the plan into an ordered list of gates.')
    expect(decoded(r).status).toBe('done')
    expectPlannerEnvelope(r)
  })

  test('a re-split: the landed gates and the halt, and the instruction says to leave the landed ones', async () => {
    const args = planArgs({
      goal: '',
      plan: PROSE,
      planPath: '/repo/.claude/litter/20261003-execute-ab12cd/plan.md',
      continueOf: '20261003-execute-ab12cd',
      landed: [{ id: 'G1', commit: '1'.repeat(40) }],
      halted: 'G2 plan gap: the header has two formats',
    })
    const r = await run(args, { planner: gatesReply(['G3', 'G4']) })
    expect(tagsOf(r)).toEqual(['plan', 'verify', 'rules', 'landed', 'halted'])
    const p = r.calls[0]!.prompt
    expect(tagBody(p, 'landed', NONCE)).toBe(`G1 (${'1'.repeat(40)})`)
    expect(tagBody(p, 'halted', NONCE)).toBe('G2 plan gap: the header has two formats')
    expect(instructionOf(p, NONCE)).toBe(
      "Re-split the work that hasn't landed after run 20261003-execute-ab12cd halted, into gates. Don't plan the landed gates again.",
    )
    expect((r.result!.gates as PlannedGate[]).map(g => g.id)).toEqual(['G3', 'G4'])
    expectPlannerEnvelope(r)
  })

  test('a re-split with nothing landed says none', async () => {
    const r = await run(planArgs({ continueOf: 'r0', landed: [], halted: null }), { planner: gatesReply(['G1']) })
    expect(tagBody(r.calls[0]!.prompt, 'landed', NONCE)).toBe('none')
    expect(tagBody(r.calls[0]!.prompt, 'halted', NONCE)).toBe('no reason was recorded')
  })

  test('questions only, with no gates, decode as done', async () => {
    const r = await run(planArgs(), { planner: gatesReply([], { questions: ['Which header format is current?'] }) })
    expect(r.result).toEqual({ gates: [], out_of_scope: ['a faster parser'], assumptions: ['the header is one line'], questions: ['Which header format is current?'] })
    expect(decoded(r)).toEqual({ status: 'done', reason: null })
  })
})

describe('when the planner does not answer', () => {
  test('a null result is retried once, then the run halts', async () => {
    const r = await run(planArgs(), { planner: null, 'planner (retry)': null })
    expect(labels(r)).toEqual(['planner', 'planner (retry)'])
    expect(r.result).toEqual({ halted: 'the planner returned nothing' })
    expect(decoded(r)).toEqual({ status: 'halted', reason: 'the planner returned nothing' })
  })

  test('a null answered by its retry returns the retry', async () => {
    const r = await run(planArgs(), { planner: null, 'planner (retry)': gatesReply(['G1']) })
    expect(decoded(r).status).toBe('done')
  })

  test('a missing role ends interrupted, without a retry', async () => {
    const msg = "agent type 'litter:planner' not found"
    const r = await run(planArgs(), { planner: { throws: msg } })
    expect(labels(r)).toEqual(['planner'])
    expect(r.result).toEqual({ halted: `interrupted: ${msg}`, interrupted: true })
    expect(decoded(r)).toEqual({ status: 'interrupted', reason: `interrupted: ${msg}` })
  })

  test('a refused worktree halts with its reason', async () => {
    const msg = 'WorktreeCreate hook failed: litter: refused'
    const r = await run(planArgs(), { planner: { throws: msg } })
    expect(r.result).toEqual({ halted: msg })
  })

  test('any other rejection fails the workflow', async () => {
    const r = await run(planArgs(), { planner: { throws: "agent type 'litter:planner' is denied" } })
    expect(r.result).toBeUndefined()
    expect(String((r.error as Error).message)).toBe("agent type 'litter:planner' is denied")
  })

  test('a result that breaks GATES fails its schema, and the workflow fails', async () => {
    const bad = gatesReply(['G1'])
    const { checks: _, ...noChecks } = plannedGate('G1')
    const r = await run(planArgs(), { planner: { ...bad, gates: [noChecks] } })
    expect(r.result).toBeUndefined()
    expect(String((r.error as Error).message)).toContain("missing required 'checks'")
  })

  test('neither a goal nor a plan, or no nonce, halts before the call', async () => {
    for (const args of [planArgs({ goal: '' }), planArgs({ nonce: '' }), undefined]) {
      const r = await run(args, {})
      expect(labels(r)).toEqual([])
      expect(typeof r.result!.halted).toBe('string')
    }
  })
})

describe('the script', () => {
  test('meta names the workflow and its one phase; deterministic; a strict GATES schema', async () => {
    const { meta, body } = loadScript('plan')
    expect(meta.name).toBe('plan-run')
    expect((meta.phases as { title: string }[]).map(p => p.title)).toEqual(['Plan'])
    expect(body).not.toMatch(/Date\.now|Math\.random|new Date\b|performance\.|crypto\./)
    expect(body).not.toMatch(/^\s*import\b|\brequire\(|\bimport\(/m)
    const r = await run(planArgs(), { planner: gatesReply(['G1']) })
    const s = r.calls[0]!.opts.schema
    expect(strictProblem(s)).toBeNull()
    const gate = ((s as { properties: { gates: { items: { properties: object; required: string[] } } } }).properties.gates.items)
    const fields: Record<keyof PlannedGate, true> = { id: true, title: true, scope: true, lines: true, files: true, done_when: true, checks: true, adversary: true }
    expect(Object.keys(gate.properties).sort()).toEqual(Object.keys(fields).sort())
    expect([...gate.required].sort()).toEqual(Object.keys(fields).sort())
  })
})
