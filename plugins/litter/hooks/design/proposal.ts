// A proposal's stored text: the author's prose, and for a plan its gates
// rendered after it in section 10's format (plan 7, step 6; COMMON decision
// 6). Owner: phase 4, WP-BC.
//
// The rendered text is what the critic judges and what delivery copies to
// plan.md byte for byte, so nothing the author wrote may add, drop or reshape
// a gate: every gate goes through renderGateSection, and parseGates must read
// the whole text back as exactly the author's gates (plan 7, step 6, "For a
// plan, the recorded text is the rendered plan").

import type { AuthorGate } from '../records/design'
import type { PlannedGate } from '../records/execute'
import type { Deliverable } from '../records/run'
import { parseGates } from '../gates'
import { renderGateSection } from '../plan'

export type RenderedProposal = { ok: true; text: string } | { ok: false; error: string; field: string }

const FENCE = /^[ \t]{0,3}(```|~~~)/
/** A heading a gate's plan_section may name: levels 1 to 4, unindented, as parseGates reads headings. */
const SECTION_HEADING = /^#{1,4}[ \t]+(.*)$/
/** renderGateSection's errors name the field first: `gate G1: 'files[0]' …`. */
const RENDER_FIELD = /^gate [^:]*: '([^']+)'/

const GATE_SHAPE = '{ id, title, plan_section, scope, files, checks, done_when, rollback, adversary? }'
const REQUIRED = {
  plan_section: "the heading of the text's section this gate implements, as written",
  scope: "the gate's prose: what to change, for the implementer",
  rollback: 'how to undo the gate once it has landed',
} as const

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
/**
 * A plan_section as the author may give it, the heading's text or the heading
 * with its # marks (the author's template asks for the text): leading #s and
 * whitespace dropped, on one line. This is the text the Implements line names.
 */
const sectionName = (s: string): string => oneLine(s.replace(/^[#\s]+/, ''))
/**
 * A heading or a plan_section as they're compared: leading #s dropped from
 * both, so a heading whose own text starts with # still matches, then
 * trimmed, whitespace and case folded.
 */
const fold = (s: string): string => sectionName(s).toLowerCase()
const refuse = (error: string, field: string): RenderedProposal => ({ ok: false, error, field })

/** The prose's headings outside code fences, folded, and whether a fence is left open at its end. */
function proseHeadings(prose: string): { headings: Set<string>; fenceOpen: boolean } {
  const headings = new Set<string>()
  let fence: string | null = null
  for (const raw of prose.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const f = FENCE.exec(line)
    if (f) {
      if (fence === null) fence = f[1]!
      else if (fence === f[1]) fence = null
      continue
    }
    if (fence !== null) continue
    const h = SECTION_HEADING.exec(line)
    // A closing run of #s isn't part of the heading's text.
    const name = h ? fold(h[1]!.replace(/[ \t]+#+[ \t]*$/, '')) : ''
    if (name !== '') headings.add(name)
  }
  return { headings, fenceOpen: fence !== null }
}

/**
 * The bytes `proposals/vN.md` holds for a proposal of `deliverable`: the
 * prose, then for a plan `## Gates` and each gate's section through
 * renderGateSection, read back whole by parseGates. A refusal names the
 * field, `text`, `gates` or `gates[i].<field>`, and what to fix.
 *
 * A research, audit or review proposal is its text unchanged, and refuses
 * gates (an empty list is none). A plan needs at least one gate. Each maps to
 * renderGateSection's input with `scope` as the prose, closed by the line
 * `Implements: <plan_section>`, and `rollback`; the text is the prose with
 * its trailing whitespace trimmed, a blank line, `## Gates`, a blank line,
 * and the sections, a blank line between two. A `plan_section` may be the
 * heading's text or the heading with its # marks; the marks are dropped, and
 * the Implements line names the text. Refused: a gate that doesn't render,
 * two gates with one id, a `plan_section` that names no heading of the prose
 * (`#` to `####`, compared trimmed, case and whitespace folded), a prose
 * that parseGates reads a gate from or that leaves a code fence open,
 * and a whole text that doesn't read back as exactly the author's gates, in
 * order (decision 6).
 */
export function renderProposal(text: string, gates: AuthorGate[] | undefined, deliverable: Deliverable): RenderedProposal {
  const given: unknown[] = gates ?? []
  if (deliverable !== 'plan') {
    if (given.length > 0) return refuse(`litter: a ${deliverable} proposal has no gates, only a plan's has; record the text without 'gates'`, 'gates')
    return { ok: true, text }
  }
  if (given.length === 0) {
    return refuse(`litter: a plan proposal needs its gates in 'gates', at least one, each ${GATE_SHAPE} and implementing a section of the text`, 'gates')
  }

  const prose = text.trimEnd()
  const { headings, fenceOpen } = proseHeadings(prose)
  if (fenceOpen) return refuse("litter: the proposal's text opens a code fence it never closes, which would hide the gates after it; close the fence", 'text')
  // A gate heading in the prose would add a gate nobody gave in 'gates'.
  const own = parseGates(prose)
  if (!own.ok || own.gates.length > 0) {
    const which = own.ok ? own.gates.map(g => g.id).join(', ') : (own.gate ?? 'a gate')
    return refuse(
      `litter: the proposal's text holds a gate heading (${which}), which would read as a gate of the plan; give every gate in 'gates' only, and reword that heading so it isn't '### G<n>:'`,
      'text',
    )
  }

  const sections: string[] = []
  const ids = new Map<string, number>()
  for (let i = 0; i < given.length; i++) {
    const at = `gates[${i}]`
    const raw = given[i]
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse(`litter: '${at}' must be a gate, ${GATE_SHAPE}`, at)
    const g = raw as Record<string, unknown>
    const name = typeof g.id === 'string' && g.id !== '' ? g.id : `#${i + 1}`
    if (typeof g.id === 'string' && ids.has(g.id)) {
      return refuse(`litter: gate ${g.id} appears twice in 'gates' (gates[${ids.get(g.id)}] and ${at}); give each gate its own id`, `${at}.id`)
    }
    for (const field of ['plan_section', 'scope', 'rollback'] as const) {
      const v = g[field]
      const empty = typeof v !== 'string' || (field === 'plan_section' ? sectionName(v) : v.trim()) === ''
      if (empty) return refuse(`litter: '${at}.${field}' (gate ${name}) is required: ${REQUIRED[field]}`, `${at}.${field}`)
    }
    if (g.adversary !== undefined && typeof g.adversary !== 'boolean') {
      return refuse(`litter: '${at}.adversary' (gate ${name}) must be true or false`, `${at}.adversary`)
    }
    const section = sectionName(g.plan_section as string)
    const planned: PlannedGate = {
      id: g.id as string,
      title: g.title as string,
      scope: `${(g.scope as string).trimEnd()}\n\nImplements: ${section}`,
      lines: '',
      files: g.files as string[],
      checks: g.checks as string[],
      done_when: g.done_when as string,
      adversary: g.adversary === true,
      rollback: g.rollback as string,
    }
    try {
      sections.push(renderGateSection(planned))
    } catch (err) {
      const why = errText(err)
      const field = RENDER_FIELD.exec(why)?.[1]
      return refuse(`litter: gate ${name} doesn't render in the plan's gate format: ${why}`, field ? `${at}.${field}` : at)
    }
    if (!headings.has(fold(section))) {
      return refuse(
        `litter: '${at}.plan_section' (gate ${name}) is "${section}", which isn't a heading of the proposal's text; give the text of the # to #### heading of the section it implements, as written there`,
        `${at}.plan_section`,
      )
    }
    ids.set(g.id as string, i)
  }

  const out = `${prose}\n\n## Gates\n\n${sections.join('\n')}`
  const back = parseGates(out)
  if (!back.ok) return refuse(`litter: the plan doesn't read back with its gates (${back.error}); nothing was recorded`, 'gates')
  // Each section renderGateSection read back alone as its gate; the same bytes in place read back the same.
  const got = back.gates.map(g => g.id)
  const want = [...ids.keys()]
  const moved = got.length !== want.length ? -1 : back.gates.findIndex((g, i) => g.id !== want[i] || g.excerpt.trimEnd() !== sections[i]!.trimEnd())
  if (got.length !== want.length || moved >= 0) {
    return refuse(`litter: the plan reads back with gates ${got.join(', ') || 'none'}, not as given (${want.join(', ')}); nothing was recorded`, moved >= 0 ? `gates[${moved}]` : 'gates')
  }
  return { ok: true, text: out }
}
