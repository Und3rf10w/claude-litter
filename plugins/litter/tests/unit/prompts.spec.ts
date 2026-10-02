// Tier 2: the static prompt checks (plan section 12, "Prompt and skill
// checks"): no backtick, no `${`, no model named, the tags each execute and
// fanout role's calls carry, and the shared parts each role assembles.

import { describe, expect, test } from 'bun:test'
import { PROMPT_TAGS, ROLE_PROMPTS, ROLE_TAGS } from '../../hooks/prompts/index'
import { HARNESS_FRAME, READ_ONLY_LIMITS, SHARED_CORE } from '../../hooks/prompts/shared'
import { ROLE_NAMES } from '../../hooks/roles'

const DESIGN = ['falsifier', 'coverage', 'mechanism', 'reframer', 'author', 'design-critic'] as const
const entries = () => Object.entries(ROLE_PROMPTS)

describe('every prompt', () => {
  test('has no backtick and no ${', () => {
    for (const [role, text] of entries()) {
      expect({ role, backtick: text.includes('`') }).toEqual({ role, backtick: false })
      expect({ role, interp: text.includes('${') }).toEqual({ role, interp: false })
    }
  })

  test('names no model and no vendor', () => {
    // `.claude/litter/` is a path, not a model: a name after a dot doesn't count.
    const MODEL = /(?<!\.)\b(claude|anthropic|opus|sonnet|haiku|gpt-?[0-9]|openai|gemini|llama)\b/i
    expect(MODEL.test('under .claude/litter/')).toBe(false)
    expect(MODEL.test('ask Claude')).toBe(true)
    for (const [role, text] of entries()) expect({ role, model: MODEL.exec(text)?.[0] ?? null }).toEqual({ role, model: null })
  })

  test('is non-empty, ends its role with a "when you\'re done" step, and carries the harness frame', () => {
    for (const [role, text] of entries()) {
      expect(text.length).toBeGreaterThan(500)
      expect({ role, done: /StructuredOutput|When you're done/.test(text) }).toEqual({ role, done: true })
      expect({ role, frame: text.includes(HARNESS_FRAME) }).toEqual({ role, frame: true })
    }
  })

  test('the design roles add the shared core and the read-only limits; the prober the core alone', () => {
    for (const role of ROLE_NAMES) {
      const text = ROLE_PROMPTS[role]
      const design = (DESIGN as readonly string[]).includes(role)
      expect({ role, core: text.includes(SHARED_CORE) }).toEqual({ role, core: design || role === 'prober' })
      expect({ role, ro: text.includes(READ_ONLY_LIMITS) }).toEqual({ role, ro: design })
    }
  })
})

describe('tags', () => {
  test("each execute and fanout role names every tag its calls carry, and only the contract's", () => {
    for (const [role, tags] of Object.entries(ROLE_TAGS)) {
      const text = ROLE_PROMPTS[role as keyof typeof ROLE_PROMPTS]
      for (const tag of tags!) expect({ role, tag, named: text.includes(`<${tag}>`) }).toEqual({ role, tag, named: true })
      const named = [...text.matchAll(/<([a-z_]+)>/g)].map(m => m[1]!)
      for (const tag of named) expect({ role, tag, known: (PROMPT_TAGS as readonly string[]).includes(tag) }).toEqual({ role, tag, known: true })
    }
  })

  test('the fanout calls match the prompts doc', () => {
    expect([...ROLE_TAGS.verifier!].sort()).toEqual(['base', 'changed', 'contract', 'integrator', 'rules', 'tasks', 'where'])
    expect([...ROLE_TAGS.integrator!].sort()).toEqual(['authorized', 'conflict', 'contract', 'rules', 'tasks', 'where'])
    expect([...ROLE_TAGS.researcher!].sort()).toEqual(['authorized', 'contract', 'rules', 'task'])
  })

  test('every execute and fanout role is listed', () => {
    const listed = Object.keys(ROLE_TAGS).sort()
    expect(listed).toEqual(ROLE_NAMES.filter(r => !(DESIGN as readonly string[]).includes(r) && r !== 'prober').sort())
  })
})
