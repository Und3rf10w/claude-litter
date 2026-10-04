// Tier 2: the swarm prompts (hooks/prompts/swarm-*.ts, slots.ts; WP-C §8):
// no backtick, no `${`, no model or vendor named, renderSlots' rules, and the
// instance and rules blocks closing with the swarm's nonce. They aren't roles,
// so prompts.spec.ts doesn't see them.

import { describe, expect, test } from 'bun:test'
import { renderSlots } from '../../hooks/prompts/slots'
import * as context from '../../hooks/prompts/swarm-context'
import * as instance from '../../hooks/prompts/swarm-instance'
import * as node from '../../hooks/prompts/swarm-node'
import * as summary from '../../hooks/prompts/swarm-summary'

/** Every text the four modules export, by name (record values included). */
function texts(): [string, string][] {
  const out: [string, string][] = []
  for (const [mod, exports] of Object.entries({ context, instance, node, summary })) {
    for (const [name, v] of Object.entries(exports)) {
      if (typeof v === 'string') out.push([`${mod}.${name}`, v])
      else if (Array.isArray(v)) v.forEach((s, i) => typeof s === 'string' && out.push([`${mod}.${name}[${i}]`, s]))
      else if (v && typeof v === 'object') for (const [k, s] of Object.entries(v)) if (typeof s === 'string') out.push([`${mod}.${name}.${k}`, s])
    }
  }
  return out
}

describe('every swarm prompt text', () => {
  test('there are texts to check', () => {
    expect(texts().length).toBeGreaterThan(30)
  })

  test('has no backtick and no ${', () => {
    for (const [name, text] of texts()) {
      expect({ name, backtick: text.includes('`') }).toEqual({ name, backtick: false })
      expect({ name, interp: text.includes('${') }).toEqual({ name, interp: false })
    }
  })

  test('names no model or vendor', () => {
    const MODEL = /(?<!\.)\b(claude|anthropic|opus|sonnet|haiku|gpt-?[0-9]|openai|gemini|llama)\b/i
    for (const [name, text] of texts()) expect({ name, model: MODEL.exec(text)?.[0] ?? null }).toEqual({ name, model: null })
  })

  test("uses only lowercase slots, so renderSlots sees every one", () => {
    for (const [name, text] of texts()) {
      const odd = [...text.matchAll(/\{([^}]*)\}/g)].map(m => m[1]).filter(s => !/^[a-z][a-z0-9_]*$/.test(s!))
      expect({ name, odd }).toEqual({ name, odd: [] })
    }
  })
})

describe('renderSlots', () => {
  test('fills each slot with its value, as data', () => {
    expect(renderSlots('a {x} b {y_2}', { x: 1, y_2: 'two' })).toBe('a 1 b two')
    // A value holding a slot or a replacement pattern is inserted as it is.
    expect(renderSlots('say {x}', { x: '{y} $& $1' })).toBe('say {y} $& $1')
  })

  test('drops the whole line of a slot that is null, undefined or empty', () => {
    const t = 'one\nBranch: {branch}\ntwo {n}\nthree'
    expect(renderSlots(t, { branch: null, n: 2 })).toBe('one\ntwo 2\nthree')
    expect(renderSlots(t, { branch: undefined, n: 2 })).toBe('one\ntwo 2\nthree')
    expect(renderSlots(t, { branch: '', n: '' })).toBe('one\nthree')
    expect(renderSlots(t, { branch: 'main', n: 0 })).toBe('one\nBranch: main\ntwo 0\nthree')
  })

  test('throws on a slot the values do not name, before rendering anything', () => {
    expect(() => renderSlots('a {x}\nb {missing}', { x: 1 })).toThrow("litter: the prompt's slot {missing} has no value")
  })

  test('the node prompt renders with every slot given, and drops an unset one', () => {
    const values = {
      node: 'part-a',
      goal: 'Ship the release.',
      brief: 'Own the API package.',
      authority: node.AUTHORITY_COMMIT_YES,
      delegation: node.DELEGATION_NONE,
      report_how: `${node.REPORT_HOW_COMMON} ${node.REPORT_HOW_WORKER}`,
      report_events: node.REPORT_EVENTS_UNSET,
    }
    const out = renderSlots(node.SWARM_NODE, values)
    expect(out).toContain('You are part-a, one agent in a swarm')
    expect(out).not.toMatch(/\{[a-z_]+\}/)
    expect(renderSlots(node.SWARM_NODE, { ...values, brief: null })).not.toContain('Own the API package.')
  })
})

describe('the instance and rules blocks', () => {
  const NONCE = '3f2c1a9e8d7b4c6a'
  const values = {
    nonce: NONCE,
    node: 'fixer',
    n: 2,
    swarm: 'stack-review',
    parent_node: 'part-b',
    parent_route: instance.PARENT_ROUTE_WORKER,
    cwd: '/repo/.claude/worktrees/sw-stack-review-fixer-2',
    branch: 'sw/stack-review/fixer-2',
    spawns_left: instance.SPAWNS_LEFT_NONE,
    budget: null,
    token: 'tok123',
  }

  test('the instance block opens and closes with the nonce', () => {
    const lines = renderSlots(instance.SWARM_INSTANCE, values).split('\n')
    expect(lines[0]).toBe(`<instance id="${NONCE}">`)
    expect(lines.at(-1)).toBe(`</instance id="${NONCE}">`)
    expect(lines).toContain('You are fixer #2 in swarm stack-review.')
    expect(lines).toContain('Parent: part-b. Your report goes to it.')
    expect(lines).toContain('Bind token: tok123')
  })

  test('an unset branch drops its line', () => {
    const out = renderSlots(instance.SWARM_INSTANCE, { ...values, branch: null })
    expect(out).not.toContain('Branch:')
    expect(out.split('\n').length).toBe(renderSlots(instance.SWARM_INSTANCE, values).split('\n').length - 1)
  })

  test('the rules block closes with the nonce, and says none apply until rules are selected', () => {
    const out = renderSlots(instance.SWARM_RULES, { nonce: NONCE, rules: instance.RULES_NONE })
    expect(out).toBe(`<rules id="${NONCE}">\nnone apply\n</rules id="${NONCE}">`)
  })

  test("a spawns-left item reads as litter-prompts.md's example", () => {
    const items = [
      renderSlots(instance.SPAWNS_LEFT_ITEM, { node: 'fixer', left: 1, of: 2 }),
      renderSlots(instance.SPAWNS_LEFT_ITEM, { node: 'reviewer', left: 3, of: 3 }),
    ]
    expect(items.join(', ')).toBe('fixer 1 of 2, reviewer 3 of 3')
  })

  test("the repair budget line: a plan-template swarm's takes the same slots and counts only rejections as rounds (WP-AG)", () => {
    const slots = (t: string) => [...t.matchAll(/\{([a-z_]+)\}/g)].map(m => m[1]).sort()
    expect(slots(instance.REPAIR_BUDGET_LEFT_PLAN)).toEqual(slots(instance.REPAIR_BUDGET_LEFT))
    const left = { rounds_left: 2, rounds: 3, agents_left: 4, agents: 6 }
    const tail = "4 of 6 agents (the workers and agents the swarm's nodes start). Past either, litter refuses the next spawn or land: report blocked to your parent, saying what you need."
    expect(renderSlots(instance.REPAIR_BUDGET_LEFT, left)).toBe(`2 of 3 rounds (a round is the critic's verdict on a new verify), ${tail}`)
    expect(renderSlots(instance.REPAIR_BUDGET_LEFT_PLAN, left)).toBe(`2 of 3 rounds (a round is a verdict that rejects an attempt; an approval uses none), ${tail}`)
  })
})

describe("the repair grants' authority lines (2b-2; phase 3, WP-AG)", () => {
  test("hold for a fanout's repair swarm and a plan-template swarm alike", () => {
    expect(node.AUTHORITY_VERIFY_YES).toBe(
      "Verify: yes. Call mcp__litter__record with kind verify (in a plan-template swarm, with its gate), and the mod runs the run's own verify command in your directory and records the result. Cite the verify_id it returns; don't run the verify command yourself in its place, since only the mod's record counts.",
    )
    expect(node.AUTHORITY_VERDICTS_YES).toBe(
      'Verdicts: yes. Your verdict record is the independent check a land needs. It counts only when it cites a verify you recorded yourself on the tree you judged, and it judges every task of a fanout once, or the one plan gate it names. You never change the tree you judge.',
    )
    expect(node.AUTHORITY_LAND_YES).toBe(
      'Land: yes. Once a verdict approves a green verify, call mcp__litter__record with kind land and that verify_id, and in a plan-template swarm with its gate. The mod checks everything again before it lands, and refuses a land of any tree but the one that verify ran on. Nothing is pushed.',
    )
    // Nothing in them is true of one kind only.
    for (const text of [node.AUTHORITY_VERIFY_YES, node.AUTHORITY_VERDICTS_YES, node.AUTHORITY_LAND_YES]) {
      expect({ text, fanoutOnly: /nothing else|integration branch|committed tip|every task of the run/.test(text) }).toEqual({ text, fanoutOnly: false })
    }
  })
})

describe("the lead's <swarm> block lines", () => {
  test('the cleared lines take their slots', () => {
    expect(renderSlots(context.SWARM_CONTEXT_CLEARED, { swarm: 'stack-review' })).toBe(
      "The conversation was cleared, but this swarm kept running and you are still its lead. Load the lead's instructions with the litter swarm skill: lead stack-review.",
    )
    expect(renderSlots(context.SWARM_CONTEXT_CLEAR_KILLED, { who: 'fixer #2 under part-b', call: 'Bash (npm test)' })).toBe(
      'Cut short by the clear: fixer #2 under part-b was running Bash (npm test), and the clear killed that command.',
    )
  })

  test('the block opens and closes as the example does', () => {
    expect(renderSlots(context.SWARM_CONTEXT_OPEN, { swarm: 'stack-review', status: 'live' })).toBe('<swarm name="stack-review" status="live">')
    expect(context.SWARM_CONTEXT_CLOSE).toBe('</swarm>')
    expect(context.SWARM_CONTEXT_HINT).toBe('Send to nodes with mcp__litter__swarm_send by node name.')
  })
})

describe('the summary prompt', () => {
  test('names its three labels', () => {
    for (const label of summary.SUMMARY_LABELS) expect(summary.SWARM_SUMMARY).toContain(`\n${label} `)
  })
})
