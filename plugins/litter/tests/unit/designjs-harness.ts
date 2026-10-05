// Runs workflows/design.js's body under bun against a scripted agent(),
// parallel(), phase(), log() and budget, the way the engine runs it, after
// executejs-harness.ts: the `export const meta` block stripped and the rest
// wrapped in an async function. parallel() calls its thunks in order,
// synchronously, and turns a rejection into null, as the engine's does (cli
// 2.1.287 :955574-955607). Every scripted result is checked against its
// call's schema first, as the engine checks a StructuredOutput, here with
// enum, minItems and maxItems too: the design critic's schema is built per
// run with all three (plan 7, step 8), which the engine's strict conversion
// doesn't take, so it validates the schema as written (cli 2.1.289
// :294977-295120, the fallback at :295236). A result that doesn't match
// rejects the way the engine's retry cap does, and the script treats that as
// fatal. Each call's prompt is kept twice: as the script built it, and as the
// role receives it, with prompt provenance's indent on every line (plan 7a),
// which the tag readers strip before they match a tag. Shared by
// designjs.spec.ts; not a spec itself.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentOpts, Budget, Reply } from './fanoutjs-harness'
import { retryCap } from './executejs-harness'

export { retryCap, strictProblem } from './executejs-harness'
export type { AgentOpts, Budget, Reply } from './fanoutjs-harness'

export const SCRIPT_PATH = join(import.meta.dir, '..', '..', 'workflows', 'design.js')

export function loadScript(): { meta: Record<string, unknown>; body: string; text: string } {
  const text = readFileSync(SCRIPT_PATH, 'utf8')
  const m = /^export const meta = (\{[\s\S]*?\n\})\n/.exec(text)
  if (!m) throw new Error('design.js: no `export const meta = {...}` block first')
  const meta = new Function(`return (${m[1]})`)() as Record<string, unknown>
  return { meta, body: text.slice(m[0].length), text }
}

export type Call = {
  n: number
  /** The prompt as the script built it. */
  prompt: string
  /** The prompt as the role receives it: every line indented by prompt provenance (plan 7a). */
  delivered: string
  opts: AgentOpts
  label: string
  agentType: string
  /** The phase() in effect when the call started. */
  current: string | null
}

export type Run = {
  result: Record<string, unknown> | undefined
  error: unknown
  calls: Call[]
  phases: string[]
  logs: string[]
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v

/**
 * Where a value breaks a schema, or null: executejs-harness.ts's subset (type,
 * enum, properties with required, items, and no field the schema doesn't
 * name), plus minItems and maxItems.
 */
export function schemaProblem(s: Record<string, unknown>, v: unknown, at = '$'): string | null {
  if (Array.isArray(s.enum) && !s.enum.includes(v)) return `${at}: ${JSON.stringify(v)} isn't one of ${JSON.stringify(s.enum)}`
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [String(s.type)]
    const t = typeOf(v)
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) return `${at}: expected ${types.join(' or ')}, got ${t}`
  }
  if (isObj(v) && isObj(s.properties)) {
    const props = s.properties as Record<string, Record<string, unknown>>
    for (const r of (s.required as string[] | undefined) ?? []) if (!(r in v)) return `${at}: missing required '${r}'`
    for (const [k, x] of Object.entries(v)) {
      if (!Object.hasOwn(props, k)) return `${at}: '${k}' isn't in the schema`
      const e = schemaProblem(props[k]!, x, `${at}.${k}`)
      if (e) return e
    }
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === 'number' && v.length < s.minItems) return `${at}: must NOT have fewer than ${s.minItems} items`
    if (typeof s.maxItems === 'number' && v.length > s.maxItems) return `${at}: must NOT have more than ${s.maxItems} items`
    if (isObj(s.items)) {
      for (let i = 0; i < v.length; i++) {
        const e = schemaProblem(s.items as Record<string, unknown>, v[i], `${at}[${i}]`)
        if (e) return e
      }
    }
  }
  return null
}

async function settle(c: Call, r: Reply): Promise<unknown> {
  const v = typeof r === 'function' ? (r as (c: Call) => unknown)(c) : r
  if (isObj(v) && typeof v.throws === 'string') {
    const e = new Error(v.throws)
    if (typeof v.name === 'string') e.name = v.name
    throw e
  }
  let out = v
  if (isObj(v) && typeof v.ticks === 'number' && 'value' in v) {
    for (let i = 0; i < v.ticks; i++) await Promise.resolve()
    out = v.value
  }
  if (out === null) return null
  if (isObj(c.opts.schema)) {
    const problem = schemaProblem(c.opts.schema, out)
    if (problem) throw new Error(retryCap(problem))
  }
  return structuredClone(out)
}

const NO_BUDGET: Budget = { total: null, spent: () => 0, remaining: () => Infinity }

/** Prompt provenance's framing of a computed task: every line indented (cli 2.1.287 :951255-951267). */
export const frame = (prompt: string): string => prompt.split('\n').map(l => `  ${l}`).join('\n')

/**
 * Runs the script once. `replies` maps a call's label to its answer, or to a
 * list of answers taken in turn. A call with no scripted answer rejects, which
 * the script treats as fatal, so the run errors and the test sees it.
 */
export async function runDesign(opts: {
  args: unknown
  replies: Record<string, Reply | Reply[]>
  budget?: (calls: Call[]) => Budget
}): Promise<Run> {
  const { body } = loadScript()
  const calls: Call[] = []
  const phases: string[] = []
  const logs: string[] = []
  const taken = new Map<string, number>()
  let current: string | null = null

  const agent = (prompt: string, o: AgentOpts = {}): Promise<unknown> => {
    const c: Call = { n: calls.length + 1, prompt, delivered: frame(prompt), opts: o, label: String(o.label), agentType: String(o.agentType), current }
    calls.push(c)
    const scripted = opts.replies[c.label]
    let r: Reply
    if (Array.isArray(scripted)) {
      const i = taken.get(c.label) ?? 0
      taken.set(c.label, i + 1)
      if (i >= scripted.length) return Promise.reject(new Error(`test: no reply number ${i + 1} for ${c.label}`))
      r = scripted[i]
    } else if (scripted === undefined) {
      return Promise.reject(new Error(`test: no reply scripted for ${c.label}`))
    } else {
      r = scripted
    }
    return settle(c, r)
  }
  const parallel = async (thunks: (() => Promise<unknown>)[]): Promise<unknown[]> => {
    const settled = await Promise.allSettled(
      thunks.map(f => {
        try {
          return f()
        } catch (e) {
          return Promise.reject(e)
        }
      }),
    )
    return settled.map(s => (s.status === 'fulfilled' ? s.value : null))
  }
  const pipeline = () => Promise.reject(new Error('test: design.js does not use pipeline()'))
  const workflow = () => Promise.reject(new Error('test: design.js does not use workflow()'))
  const phase = (t: string) => {
    current = t
    phases.push(t)
  }
  const log = (m: string) => void logs.push(m)
  const budget = opts.budget
    ? {
        get total() {
          return opts.budget!(calls).total
        },
        spent: () => opts.budget!(calls).spent(),
        remaining: () => opts.budget!(calls).remaining(),
      }
    : NO_BUDGET

  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...v: unknown[]) => Promise<unknown>
  const fn = new AsyncFunction('agent', 'parallel', 'pipeline', 'phase', 'log', 'args', 'budget', 'workflow', body)
  let result: Record<string, unknown> | undefined
  let error: unknown = null
  try {
    result = (await fn(agent, parallel, pipeline, phase, log, opts.args, budget, workflow)) as Record<string, unknown>
  } catch (e) {
    error = e
  }
  return { result, error, calls, phases, logs }
}

// ---------------------------------------------------------------------------
// Reading a delivered prompt, as a role does: each line stripped of its
// leading whitespace before a tag is matched (litter-prompts.md, "Tag contract").

export type Tag = { name: string; attrs: Record<string, string>; nonce: boolean; body: string; closed: boolean }

const attrsOf = (s: string): Record<string, string> => Object.fromEntries([...s.matchAll(/\s([a-z_]+)="([^"]*)"/g)].map(m => [m[1]!, m[2]!]))

/**
 * Every top-level tag of a delivered prompt, in order: its name, attributes,
 * whether it carries the nonce, and its body with the framing indent taken
 * off each line. A tag's body runs to the closing tag with the same nonce,
 * so a forged closing tag inside it stays body.
 */
export function tagsOf(delivered: string, nonce: string): Tag[] {
  const ls = delivered.split('\n')
  const out: Tag[] = []
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i]!.replace(/^\s+/, '')
    const m = /^<([a-z_]+)((?:\s[^>]*)?)>$/.exec(line)
    if (!m) continue
    const attrs = attrsOf(m[2] ?? '')
    const close = `</${m[1]} id="${attrs.id ?? ''}">`
    let j = i + 1
    while (j < ls.length && ls[j]!.replace(/^\s+/, '') !== close) j++
    out.push({ name: m[1]!, attrs, nonce: attrs.id === nonce, body: ls.slice(i + 1, j).map(l => l.replace(/^ {2}/, '')).join('\n'), closed: j < ls.length })
    i = j
  }
  return out
}

/** The text a delivered prompt has outside its tags: none, when the instruction is in <task>. */
export function untagged(delivered: string, nonce: string): string {
  const ls = delivered.split('\n')
  const keep: string[] = []
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i]!.replace(/^\s+/, '')
    const m = /^<([a-z_]+) id="([^"]*)"[^>]*>$/.exec(line)
    if (m && m[2] === nonce) {
      let j = i + 1
      while (j < ls.length && ls[j]!.replace(/^\s+/, '') !== `</${m[1]} id="${nonce}">`) j++
      i = j
      continue
    }
    keep.push(line)
  }
  return keep.join('\n').trim()
}

/** The body of the first `<name>` tag with the nonce in the prompt as built, byte for byte, or null. */
export function tagBody(prompt: string, name: string, nonce: string, attrs = ''): string | null {
  const open = `<${name} id="${nonce}"${attrs}`
  const at = prompt.indexOf(open)
  if (at < 0) return null
  const from = prompt.indexOf('>\n', at) + 2
  const end = prompt.indexOf(`\n</${name} id="${nonce}">`, from)
  return end < 0 ? null : prompt.slice(from, end)
}

// ---------------------------------------------------------------------------
// Fixtures: a plan design with three lenses, as run.start builds its args
// (DesignArgs, hooks/records/run.ts; design/launch.ts, designArgs).

export const NONCE = '9e4b17c2a0d5'
export const RUN = '20261004-design-ab12cd'
export const BASE = 'b'.repeat(40)
export const GOAL = 'Retry a failed upload without writing twice.'

export type BarItem = { id: string; text: string; evidence: string; reason?: string; rule?: { id: string; version: number }; rules?: { id: string; version: number }[] }

export const BAR: BarItem[] = [
  { id: 'C1', text: 'A failed upload is retried at most three times', evidence: 'a test that counts the attempts' },
  { id: 'C2', text: 'A retry never repeats a write that landed', evidence: 'the write path read end to end, with file:line' },
  { id: 'B1', text: 'No new dependency', evidence: "the design's file list", reason: 'the vendored tree is frozen (the March incident)' },
]
export const IDS = BAR.map(b => b.id)

export type Lens = { role: 'falsifier' | 'coverage' | 'mechanism'; name: string; focus: string; anchors: string[] }
export const LENSES: Lens[] = [
  { role: 'falsifier', name: 'hunter', focus: 'where a retry is decided, and whether a write can land twice', anchors: ['src/upload.ts'] },
  { role: 'coverage', name: 'platforms', focus: 'the storage backends', anchors: [] },
  { role: 'mechanism', name: 'mechanism', focus: '', anchors: [] },
]
export const RULES = ['For this run (stated by you): keep the change small', 'R4@2 (ban): no new dependencies']

export function designArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run: RUN,
    nonce: NONCE,
    authorized: 'read the repository\nrecord through mcp__litter__record',
    goal: GOAL,
    deliverable: 'plan',
    bar: BAR,
    rules: RULES,
    anchors: ['src/upload.ts', 'docs/retry.md'],
    lenses: LENSES,
    empiricalUnknowns: [],
    maxRounds: 3,
    base: BASE,
    template: '',
    prior: null,
    ...extra,
  }
}

/** The label of each investigator's call in a round, lens by lens. */
export const lensLabels = (round: number, lenses: Lens[] = LENSES) => lenses.map(l => `r${round}:${l.role}:${l.name}`)

export const fact = (claim: string, extra: Record<string, unknown> = {}) => ({
  kind: 'fact', claim, evidence: ['src/upload.ts:40'], confidence: 'high', checked: [], new_since_prior: true, ...extra,
})
export const problem = (claim: string, extra: Record<string, unknown> = {}) => fact(claim, { kind: 'problem', ...extra })
export const nullOf = (claim: string, extra: Record<string, unknown> = {}) => fact(claim, {
  kind: 'null', confidence: 'medium', evidence: [],
  checked: [{ location: 'src/upload.ts', looked_for: 'an idempotency key', result: 'none' }], ...extra,
})
export const falsified = (...results: Record<string, unknown>[]) => ({ results })
export const covered = (newSince = true, extra: Record<string, unknown> = {}) => ({
  rows: [{ environment: 'local disk', status: 'works', evidence: 'src/store/disk.ts:12', fallback: 'none needed' }],
  silent_failures: [], needs_live_test: [], new_since_prior: newSince, ...extra,
})
export const unknownOf = (question: string, loadBearing = true) => ({
  id: 'X', question, smallest_test: `run the smallest test for: ${question}`, kill_result: 'it writes twice', load_bearing: loadBearing,
})
export const mechanized = (newSince = true, unknowns: Record<string, unknown>[] = [], extra: Record<string, unknown> = {}) => ({
  files: [{ path: 'src/upload.ts', new: false }],
  design: 'Keep an idempotency key per upload and check it before each write.',
  bar_coverage: [{ criterion: 'C2', how: 'the key is checked before the write' }],
  failure_modes: [{ trigger: 'two retries at once', consequence: 'a double write', handling: 'the key check is atomic' }],
  empirical_unknowns: unknowns,
  bans_checked: ['B1: no new dependency'],
  new_since_prior: newSince,
  ...extra,
})
export const probed = (id: string, verdict = 'confirmed') => ({
  unknown_id: id, commands: ['sh probe.sh'], output_excerpt: 'wrote once', verdict, meaning: `${id} holds for the design`,
})
export const reframed = (extra: Record<string, unknown> = {}) => ({
  goal_as_stated: GOAL, inferred_intent: 'uploads survive a flaky network', candidates: [],
  recommendation: 'none', changes_goal: false, material_change: false, invalid_assumptions: [], ...extra,
})
/** The proposal text the mod recorded for a version, as output.sh fills it into the author's result. */
export const textOf = (version: string) => `# Retry design ${version}\n\n## Approach\n\nKeep a key per upload.\n`
export const authored = (version: string, extra: Record<string, unknown> = {}) => ({
  version,
  proposal: textOf(version),
  delta: [],
  bar_map: IDS.map(id => ({ criterion: id, section: 'Approach', evidence: ['src/upload.ts:40'] })),
  overruled: [],
  residual_unknowns: [],
  user_decisions: [],
  ...extra,
})

export type Verdict = 'PASS' | 'CONDITIONAL' | 'FAIL'
export type Criterion = { id: string; verdict: Verdict; evidence: string; gap_or_reason?: string; gap_kind?: string }
export const criterion = (id: string, verdict: Verdict = 'PASS', gapKind?: string): Criterion => ({
  id, verdict, evidence: `${id}: checked src/upload.ts:40`,
  ...(verdict === 'PASS' ? {} : { gap_or_reason: `${id} isn't met yet`, gap_kind: gapKind ?? 'investigation' }),
})
/** A verdict on `version`: every bar id PASS unless `not` names it, in bar order; `criteria` replaces the list outright. */
export function judged(version: string, o: { not?: Record<string, [Verdict, string?]>; criteria?: Criterion[]; overall?: string; source_changed?: boolean } = {}) {
  const criteria = o.criteria ?? IDS.map(id => (o.not?.[id] ? criterion(id, o.not[id]![0], o.not[id]![1]) : criterion(id)))
  return {
    version,
    source_changed: o.source_changed ?? false,
    criteria,
    overall: o.overall ?? (criteria.every(c => c.verdict === 'PASS') ? 'APPROVED' : 'HOLDING'),
  }
}

type Step = 'falsifier' | 'coverage' | 'mechanism' | 'reframer' | 'author' | 'critic'

/** One round's replies: every lens, the reframer, the author and the critic, each replaceable (by null too). */
export function round(n: number, o: Partial<Record<Step, Reply | Reply[]>> = {}): Record<string, Reply | Reply[]> {
  const or = (k: Step, d: Reply) => (k in o ? o[k]! : d)
  return {
    [`r${n}:falsifier:hunter`]: or('falsifier', falsified(fact(`the retry is decided at src/upload.ts:4${n}`))),
    [`r${n}:coverage:platforms`]: or('coverage', covered()),
    [`r${n}:mechanism:mechanism`]: or('mechanism', mechanized()),
    [`r${n}:reframer`]: or('reframer', reframed()),
    [`r${n}:author`]: or('author', authored(`v${n}`)),
    [`critic:v${n}`]: or('critic', judged(`v${n}`)),
  }
}

/** A round the critic holds on C1 for more investigation, so another follows. */
export const holdingRound = (n: number, o: Parameters<typeof round>[1] = {}) =>
  round(n, { critic: judged(`v${n}`, { not: { C1: ['FAIL', 'investigation'] } }), ...o })
