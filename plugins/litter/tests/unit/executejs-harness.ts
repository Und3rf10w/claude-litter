// Runs workflows/execute.js's or plan.js's body under bun against a scripted
// agent(), phase(), log() and budget, the way the engine runs it, after
// fanoutjs-harness.ts: the `export const meta` block stripped and the rest
// wrapped in an async function. Unlike that harness, every scripted result is
// checked against its call's schema first, as the engine checks a
// StructuredOutput (plan 12, the seventh review): a result that doesn't match
// rejects the way the engine's retry cap does, and the script treats that as
// fatal. Shared by executejs.spec.ts and planjs.spec.ts; not a spec itself.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { READ_ONLY_BASH } from '../../hooks/lifecycle'
import type { AgentOpts, Budget, Call, Reply, Run } from './fanoutjs-harness'

export { instructionOf, nonceTags } from './fanoutjs-harness'
export type { AgentOpts, Budget, Call, Reply, Run } from './fanoutjs-harness'

export type Script = 'execute' | 'plan'

export const scriptPath = (name: Script) => join(import.meta.dir, '..', '..', 'workflows', `${name}.js`)

export function loadScript(name: Script): { meta: Record<string, unknown>; body: string; text: string } {
  const text = readFileSync(scriptPath(name), 'utf8')
  const m = /^export const meta = (\{[\s\S]*?\n\})\n/.exec(text)
  if (!m) throw new Error(`${name}.js: no \`export const meta = {...}\` block first`)
  const meta = new Function(`return (${m[1]})`)() as Record<string, unknown>
  return { meta, body: text.slice(m[0].length), text }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v

/**
 * Where a value breaks a schema, or null. The subset the scripts use: type
 * (one or a union of scalars), enum, properties with required, items. The
 * engine's strict conversion sets additionalProperties: false, so a field the
 * schema doesn't name is an error too.
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
  if (Array.isArray(v) && isObj(s.items)) {
    for (let i = 0; i < v.length; i++) {
      const e = schemaProblem(s.items as Record<string, unknown>, v[i], `${at}[${i}]`)
      if (e) return e
    }
  }
  return null
}

const KEYWORDS = new Set(['$schema', 'type', 'description', 'title', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf'])
const SCALARS = new Set(['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'])

/** The engine's strict-schema conversion (p5n, cli 2.1.287 :289525-289640), as fanoutjs.spec.ts has it: null when it converts. */
export function strictProblem(s: unknown, depth = 32): string | null {
  if (depth <= 0) return 'max_depth'
  if (!isObj(s)) return 'not_object'
  for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) return `unsupported_keyword ${k}`
  if (s.anyOf !== undefined) {
    if (!Array.isArray(s.anyOf) || s.anyOf.length === 0) return 'unsupported_keyword anyOf'
    for (const x of s.anyOf) {
      const e = strictProblem(x, depth - 1)
      if (e) return e
    }
    return null
  }
  if (s.enum !== undefined && (!Array.isArray(s.enum) || s.enum.length === 0 || new Set(s.enum).size !== s.enum.length)) return 'unsupported_enum'
  const t = s.type
  if (t !== undefined) {
    if (typeof t === 'string') {
      if (!SCALARS.has(t)) return 'unsupported_type'
    } else if (Array.isArray(t)) {
      if (t.length === 0 || new Set(t).size !== t.length || !t.every(x => typeof x === 'string' && SCALARS.has(x) && x !== 'object' && x !== 'array')) return 'unsupported_type'
    } else return 'unsupported_type'
  }
  if (t !== 'object' && (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined)) return 'mismatched_keywords'
  if (t !== 'array' && s.items !== undefined) return 'mismatched_keywords'
  if (t === 'object') {
    const props = s.properties
    if (!isObj(props)) return 'no_properties'
    if (s.additionalProperties !== undefined && s.additionalProperties !== false) return 'additional_properties'
    const req = s.required
    if (req !== undefined && (!Array.isArray(req) || new Set(req).size !== req.length || !req.every(r => typeof r === 'string' && Object.hasOwn(props, r)))) return 'invalid_required'
    for (const v of Object.values(props)) {
      const e = strictProblem(v, depth - 1)
      if (e) return e
    }
  } else if (t === 'array') {
    if (s.items === undefined || Array.isArray(s.items)) return 'unsupported_items'
    return strictProblem(s.items, depth - 1)
  } else if (t === undefined && s.enum === undefined && !('const' in s)) return 'missing_type'
  return null
}

/** The engine's rejection when no StructuredOutput call validated (agent({schema}), cli 2.1.287). */
export const retryCap = (problem: string) =>
  `agent({schema}): StructuredOutput retry cap (5) exceeded — 5 failed calls with no valid output — last StructuredOutput error: Output does not match required schema: ${problem}`

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

/**
 * Runs the script once. `replies` maps a call's label to its answer, or to a
 * list of answers taken in turn. A call with no scripted answer rejects, which
 * the script treats as fatal, so the run errors and the test sees it.
 */
export async function runScript(
  name: Script,
  opts: { args: unknown; replies: Record<string, Reply | Reply[]>; budget?: (calls: Call[]) => Budget },
): Promise<Run> {
  const { body } = loadScript(name)
  const calls: Call[] = []
  const phases: string[] = []
  const logs: string[] = []
  const taken = new Map<string, number>()
  let current: string | null = null

  const agent = (prompt: string, o: AgentOpts = {}): Promise<unknown> => {
    const c: Call = { n: calls.length + 1, prompt, opts: o, label: String(o.label), agentType: String(o.agentType), current }
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
  const parallel = () => Promise.reject(new Error(`test: ${name}.js does not use parallel()`))
  const pipeline = () => Promise.reject(new Error(`test: ${name}.js does not use pipeline()`))
  const workflow = () => Promise.reject(new Error(`test: ${name}.js does not use workflow()`))
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

/**
 * The tags a role sees in a delivered prompt: prompt provenance indents every
 * line (litter-prompts.md, "Tag contract"), so each line is indented, then
 * stripped of its leading whitespace before a tag is matched. Every opening
 * and closing tag, with whether it carries the nonce.
 */
export function deliveredTags(prompt: string, nonce: string): { name: string; close: boolean; nonce: boolean }[] {
  const out: { name: string; close: boolean; nonce: boolean }[] = []
  for (const raw of prompt.split('\n').map(l => `  ${l}`)) {
    const line = raw.replace(/^\s+/, '')
    const m = /^<(\/?)([a-z_]+)((?:\s[^>]*)?)>/.exec(line)
    if (!m) continue
    out.push({ name: m[2]!, close: m[1] === '/', nonce: m[3]!.includes(`id="${nonce}"`) })
  }
  return out
}

/** The body of the first `<name>` tag with the nonce, or null. */
export function tagBody(prompt: string, name: string, nonce: string): string | null {
  const open = new RegExp(`<${name} id="${nonce}"[^>]*>\\n`)
  const m = open.exec(prompt)
  if (!m) return null
  const from = m.index + m[0].length
  const end = prompt.indexOf(`\n</${name} id="${nonce}">`, from)
  return end < 0 ? null : prompt.slice(from, end)
}

// ---------------------------------------------------------------------------
// Fixtures: two gates, as run.start builds an execute run's args (lifecycle.ts, prepare and argsGate).

export const NONCE = '7c41e09ab3d2'
export const RUN = '20261003-execute-ab12cd'
export const PLAN_PATH = `/repo/.claude/litter/${RUN}/plan.md`
/** shellQuote(['sh', 'check.sh', 'a b']), as run.start renders it. */
export const VERIFY = "sh check.sh 'a b'"
export const GOAL_CHECK = 'sh goal.sh'
export const CLAMP = [...READ_ONLY_BASH, `Bash(${VERIFY}:*)`]
export const RUN_RULES = ['For this run (stated by you): keep changes small', 'R0@1 (always): no new dependencies']

export type ArgsGate = {
  id: string
  title: string
  excerpt: string
  files: string[]
  checks: string[]
  done_when: string
  lines: string
  adversary: boolean
  rollback: string
  rules: string[]
  carryOver?: string
}

export const G1: ArgsGate = {
  id: 'G1',
  title: 'Parse the header',
  excerpt: '### G1: Parse the header\nFiles: src/header.ts\nChecks: bun test header\nDone when: header.spec passes\n\nParse the header line.',
  files: ['src/header.ts'],
  checks: ['bun test header'],
  done_when: 'header.spec passes',
  lines: '3-9',
  adversary: false,
  rollback: '',
  rules: ['R1@2 (src/header.ts): keep the parser pure'],
}
export const G2: ArgsGate = {
  id: 'G2',
  title: 'Use the header',
  excerpt: '### G2: Use the header\nFiles: src/main.ts\nChecks: bun test main\nDone when: main.spec passes\n\nCall the parser.',
  files: ['src/main.ts'],
  checks: ['bun test main'],
  done_when: 'main.spec passes',
  lines: '11-16',
  adversary: false,
  rollback: '',
  rules: ['R2@1 (src/main.ts): log through the logger'],
}

export function executeArgs(gates: ArgsGate[] = [G1, G2], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run: RUN,
    nonce: NONCE,
    authorized: 'edit the files the gate names\nrun the verify command',
    rules: RUN_RULES,
    verifyCommand: VERIFY,
    planPath: PLAN_PATH,
    gates,
    maxAttempts: 3,
    adversary: false,
    adversaryClamp: CLAMP,
    ...extra,
  }
}

export const verified = (id: string, extra: Record<string, unknown> = {}) => ({ verify_id: id, exit_code: 0, signal: null, timed_out: false, green: true, ...extra })
export const red = (id: string, extra: Record<string, unknown> = {}) => verified(id, { exit_code: 1, green: false, ...extra })
export const written = (notes = 'Changed the file the gate names.', extra: Record<string, unknown> = {}) => ({
  status: 'done',
  plan_lines: ['3-9'],
  files: ['src/header.ts'],
  checks: ['bun test header: pass'],
  notes,
  plan_gap: '',
  ...extra,
})
export const blockedWrite = (why: string) => written(why, { status: 'blocked', files: [], checks: [] })
/** The executor's stop on a plan gap (executor.ts, "When the plan doesn't settle something"): blocked, the gap in plan_gap. */
export const gapWrite = (gap: string, notes = 'Stopped before changing anything.') => written(notes, { status: 'blocked', files: [], checks: [], plan_gap: gap })

type DimName = 'plan_adherence' | 'tests_green' | 'no_regressions' | 'rules'
export const pass = (evidence = 'checked') => ({ pass: true, evidence, gaps: [] as string[] })
export const failDim = (evidence: string, gaps: string[] = []) => ({ pass: false, evidence, gaps })

/** A verdict on `verifyId`: every dimension passing unless `fail` replaces it. */
export function verdict(
  verifyId: string,
  o: {
    fail?: Partial<Record<DimName, { pass: boolean; evidence: string; gaps: string[] }>>
    plan_gap?: string
    rule_clash?: string
    proposed?: string[]
    widened?: { file: string; why: string }[]
  } = {},
): Record<string, unknown> {
  return {
    verify_id: verifyId,
    plan_adherence: o.fail?.plan_adherence ?? pass('every plan line is covered'),
    tests_green: o.fail?.tests_green ?? pass(`verify ${verifyId} exit 0`),
    no_regressions: o.fail?.no_regressions ?? pass('no behavior changed outside the gate'),
    rules: o.fail?.rules ?? pass('R1@2 holds'),
    plan_gap: o.plan_gap ?? '',
    rule_clash: o.rule_clash ?? '',
    proposed_rules: o.proposed ?? [],
    widened: o.widened ?? [],
  }
}

export const noBreaks = { breaks: [], suspicious_tests: [], not_tested: ['the empty header'] }
export const landedAt = (commit: string) => ({ landed: true, commit, retry: false })
export const notLanded = (reason: string, retry: boolean) => ({ landed: false, reason, retry })

export const C1 = '1'.repeat(40)
export const C2 = '2'.repeat(40)

/** Two gates, each written, judged and landed at the first attempt. */
export const happy = (extra: Record<string, Reply | Reply[]> = {}): Record<string, Reply | Reply[]> => ({
  baseline: verified('baseline-1-aa'),
  'write:G1#1': written(),
  'critic:G1#1': verdict('G1-1-bb'),
  'land:G1': landedAt(C1),
  'write:G2#1': written('Called the parser.', { files: ['src/main.ts'], plan_lines: ['11-16'] }),
  'critic:G2#1': verdict('G2-1-cc'),
  'land:G2': landedAt(C2),
  ...extra,
})

// ---------------------------------------------------------------------------
// Fixtures for plan.js: run.start's plan args (lifecycle.ts, prepare, the plan branch).

export const PLAN_RUN = '20261003-plan-cd34ef'
export const PROSE_PATH = '/repo/docs/feature.md'

export function planArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run: PLAN_RUN,
    nonce: NONCE,
    authorized: 'read the code\nchange nothing',
    rules: ['For this run (stated by you): keep changes small', 'R0@1 (always): no new dependencies'],
    goal: 'Parse and use the header.',
    verifyCommand: VERIFY,
    ...extra,
  }
}

export const plannedGate = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Gate ${id}`,
  scope: `Change src/${id}.ts so that the header parses.`,
  lines: '',
  files: [`src/${id}.ts`],
  done_when: `bun test ${id} passes`,
  checks: [`bun test ${id}`],
  adversary: false,
  ...extra,
})
export const gatesReply = (ids: string[], extra: Record<string, unknown> = {}) => ({
  gates: ids.map(id => plannedGate(id)),
  out_of_scope: ['a faster parser'],
  assumptions: ['the header is one line'],
  questions: [],
  ...extra,
})
