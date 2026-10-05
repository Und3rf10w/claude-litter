// Tier 2: the author's section templates (COMMON decision 13; WP-BF), ported
// from deepwork's templates/synthesis/, and the author's and prober's prompt
// changes (decisions 6 and 18). The templates reach the author inside its
// template tag, so they pass the static prompt checks prompts.spec.ts runs
// over every role (plan section 12).

import { describe, expect, test } from 'bun:test'
import { parseGates } from '../../hooks/gates'
import { ROLE_PROMPTS } from '../../hooks/prompts/index'
import { TEMPLATES } from '../../hooks/prompts/templates'
import { DELIVERABLES } from '../../hooks/records/run'

const MODEL = /(?<!\.)\b(claude|anthropic|opus|sonnet|haiku|fable|gpt-?[0-9]|openai|gemini|llama)\b/i
const entries = () => Object.entries(TEMPLATES)
const headings = (text: string, level: number) =>
  text
    .split('\n')
    .filter(l => l.startsWith(`${'#'.repeat(level)} `))
    .map(l => l.slice(level + 1))

describe('the templates', () => {
  test('one per deliverable, none empty', () => {
    expect(Object.keys(TEMPLATES).sort()).toEqual([...DELIVERABLES].sort())
    for (const [kind, text] of entries()) expect({ kind, empty: text.trim() === '' }).toEqual({ kind, empty: false })
  })

  test('pass the static prompt checks: no backtick, no ${, no model named, and no tag of their own', () => {
    for (const [kind, text] of entries()) {
      expect({ kind, backtick: text.includes('`') }).toEqual({ kind, backtick: false })
      expect({ kind, interp: text.includes('${') }).toEqual({ kind, interp: false })
      expect({ kind, model: MODEL.exec(text)?.[0] ?? null }).toEqual({ kind, model: null })
      // The text goes inside the author's template tag: a tag in it would read as the envelope's.
      expect({ kind, tag: /<\/?[a-z_]+[\s>]/.exec(text)?.[0] ?? null }).toEqual({ kind, tag: null })
    }
  })

  test('each stays under 4 KiB', () => {
    for (const [kind, text] of entries()) expect({ kind, small: Buffer.byteLength(text, 'utf8') < 4096 }).toEqual({ kind, small: true })
  })

  test('each names its deliverable, then gives its sections as level-2 headings, each with one line on what it holds', () => {
    const article = { plan: 'a plan', research: 'research', audit: 'an audit', review: 'a review' } as const
    for (const [kind, text] of entries()) {
      expect(text.startsWith(`Sections for ${article[kind as keyof typeof article]}. `)).toBe(true)
      const lines = text.split('\n')
      const at = lines.flatMap((l, i) => (l.startsWith('## ') ? [i] : []))
      expect(at.length).toBeGreaterThanOrEqual(5)
      expect(new Set(headings(text, 2)).size).toBe(at.length)
      for (const i of at) {
        expect({ kind, heading: lines[i], line: (lines[i + 1] ?? '').trim() !== '' }).toEqual({ kind, heading: lines[i], line: true })
        expect({ kind, heading: lines[i], then: lines[i + 2] ?? '' }).toEqual({ kind, heading: lines[i], then: '' })
      }
      // Only level-2 headings: the author's level-1 title and level-3 parts are described, not written.
      expect(lines.filter(l => /^#{1,6} /.test(l) && !l.startsWith('## '))).toEqual([])
    }
  })

  test("they are deepwork's sections, in litter's words", () => {
    expect(headings(TEMPLATES.plan, 2)).toEqual(['Problem', 'Context', 'Design', 'Decisions and alternatives', 'Failure modes', 'Rollout', 'Residual unknowns'])
    expect(headings(TEMPLATES.research, 2)).toEqual(['Question', 'Method', 'Findings', 'How the findings relate', 'Open questions'])
    expect(headings(TEMPLATES.audit, 2)).toEqual(['Scope and constraints', 'Summary', 'Findings', 'Attack surface', 'Remediation order', 'Open questions'])
    expect(headings(TEMPLATES.review, 2)).toEqual(['Scope', 'Disposition', 'Findings', 'Strengths', 'What would change the disposition'])
    // A review's disposition is about the reviewed work, not the critic's verdict.
    expect(TEMPLATES.review).not.toMatch(/APPROVED|HOLDING/)
  })

  test('the plan template has no gate heading, and says the gates go in the record, appended under a Gates heading', () => {
    const plan = TEMPLATES.plan
    const parsed = parseGates(plan)
    expect(parsed).toEqual({ ok: true, gates: [] })
    expect(plan.split('\n').filter(l => /^#{1,6}[ \t]+(Gates\b|G[0-9]+[ \t]*:)/i.test(l))).toEqual([])
    expect(plan).toContain("Don't write a Gates section or a gate heading such as ### G1: Title anywhere in it.")
    expect(plan).toContain("Give the gates in the record's gates field: the plugin appends them after your text, under a Gates heading, in the format the execute run reads.")
    expect(plan).toContain("Each gate's plan_section is the heading it implements, written as the heading's text without the # marks")
    expect(plan).toContain('a plan_section that names no heading of your text is refused')
  })

  test('the other templates say the kind takes no gates', () => {
    for (const kind of ['research', 'audit', 'review'] as const) {
      expect(TEMPLATES[kind]).toContain('not an implementation plan. Give no gates, since the record refuses them for this kind')
      expect(TEMPLATES[kind]).not.toContain('plan_section')
    }
  })
})

describe("the author's and prober's prompts (decisions 6 and 18)", () => {
  test("the author's plan step names the gate fields, in order", () => {
    const author = ROLE_PROMPTS.author
    const step = author.slice(author.indexOf('7. For the plan kind'), author.indexOf('\n8. '))
    const fields = ['id (G1, G2 and so on)', 'title', 'plan_section, a heading of your prose', 'scope, what to change, in prose, with links to the files', 'files', 'checks', 'done_when', 'rollback', 'adversary']
    const at = fields.map(f => step.indexOf(f))
    expect(at.every(i => i > 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })

  test("the author's report keeps gate headings out of the prose, and names the plan_section refusal", () => {
    const report = ROLE_PROMPTS.author.slice(ROLE_PROMPTS.author.indexOf('## Your report'))
    expect(report).toContain("Give the gates only in the record's gates field, not as prose, and don't write gate headings, such as ### G1: Title, in your text")
    expect(report).toContain("a gate's plan_section names no heading of your text, or your text holds a gate heading")
    expect(report).toContain('Only the plan kind takes gates.')
    // The step's field list is the record's: the mod renders it with renderGateSection.
    expect(report).toContain('the gates, each with the fields of step 7')
  })

  test("the prober records unknown_id, report and verdict, and returns unknown_id", () => {
    const report = ROLE_PROMPTS.prober.slice(ROLE_PROMPTS.prober.indexOf('## Your report'))
    expect(report).toContain('Record kind: probe, with three fields: unknown_id, the id your task gives the unknown (U1, U2 and so on)')
    expect(report).toContain('verdict, one of confirmed, refuted or untested')
    expect(report).toContain('Put the same unknown_id and verdict in your structured result.')
  })
})
