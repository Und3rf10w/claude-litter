// Runs workflows/fanout.js's body under bun against a scripted agent(),
// parallel(), phase(), log() and budget, the way the engine runs it: the
// `export const meta` block stripped and the rest wrapped in an async
// function. parallel() calls its thunks in order, synchronously, and turns a
// rejection into null, as the engine's does (cli 2.1.287 :955574-955607).
// Shared by fanoutjs.spec.ts and prompts.spec.ts; not a spec itself.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const SCRIPT_PATH = join(import.meta.dir, '..', '..', 'workflows', 'fanout.js')

export type AgentOpts = {
  label?: string
  phase?: string
  agentType?: string
  schema?: Record<string, unknown>
  isolation?: string
  bashCommandClamp?: string[]
  [k: string]: unknown
}

export type Call = {
  n: number
  prompt: string
  opts: AgentOpts
  label: string
  agentType: string
  /** The phase() in effect when the call started. */
  current: string | null
}

/** A scripted answer: a value, a rejection, or a value resolved after some microtask turns. */
export type Reply = { throws: string; name?: string } | { ticks: number; value: unknown } | ((c: Call) => unknown) | unknown

export type Budget = { total: number | null; spent: () => number; remaining: () => number }

export type Run = {
  result: Record<string, unknown> | undefined
  error: unknown
  calls: Call[]
  phases: string[]
  logs: string[]
}

export function loadScript(): { meta: Record<string, unknown>; body: string; text: string } {
  const text = readFileSync(SCRIPT_PATH, 'utf8')
  const m = /^export const meta = (\{[\s\S]*?\n\})\n/.exec(text)
  if (!m) throw new Error('fanout.js: no `export const meta = {...}` block first')
  const meta = new Function(`return (${m[1]})`)() as Record<string, unknown>
  return { meta, body: text.slice(m[0].length), text }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

async function settle(c: Call, r: Reply): Promise<unknown> {
  const v = typeof r === 'function' ? (r as (c: Call) => unknown)(c) : r
  if (isObj(v) && typeof v.throws === 'string') {
    const e = new Error(v.throws)
    if (typeof v.name === 'string') e.name = v.name
    throw e
  }
  if (isObj(v) && typeof v.ticks === 'number' && 'value' in v) {
    for (let i = 0; i < v.ticks; i++) await Promise.resolve()
    return v.value === null ? null : structuredClone(v.value)
  }
  return v === null ? null : structuredClone(v)
}

const NO_BUDGET: Budget = { total: null, spent: () => 0, remaining: () => Infinity }

/**
 * Runs the script once. `replies` maps a call's label to its answer, or to a
 * list of answers taken in turn. A call with no scripted answer rejects, which
 * the script treats as fatal, so the run errors and the test sees it.
 */
export async function runFanout(opts: {
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
  const pipeline = () => Promise.reject(new Error('test: fanout.js does not use pipeline()'))
  const workflow = () => Promise.reject(new Error('test: fanout.js does not use workflow()'))
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

/** Every tag in a prompt that carries the nonce, by name, in order. */
export function nonceTags(prompt: string, nonce: string): string[] {
  const out: string[] = []
  const open = new RegExp(`<([a-z_]+) id="${nonce}"[^>]*>`, 'g')
  for (const m of prompt.matchAll(open)) out.push(m[1]!)
  return out
}

/** The text after the last closing tag: the call's instruction. */
export function instructionOf(prompt: string, nonce: string): string {
  const close = `id="${nonce}">`
  const at = prompt.lastIndexOf(close)
  return (at < 0 ? prompt : prompt.slice(at + close.length)).trim()
}

// ---------------------------------------------------------------------------
// Fixtures: three tasks, two writing, as run.start builds args (lifecycle.ts, prepare).

export const NONCE = '3f9ac0de1b27'
export const RUN = '20261002-fanout-ab12cd'
export const BIND_A = '6f1d2c4e-8a1b-4c3d-9e2f-0a1b2c3d4e5f'
export const BIND_B = '9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d'
export const WHERE = `/repo/.claude/worktrees/litter-${RUN}-integration`
export const BASE = 'b'.repeat(40)
export const VERIFY_ID = 'integration-1-0a1b2c3d4e'

export type Task = { id: string; title: string; text: string; writes: boolean; files: string[]; rules: string[]; bind?: string }

export const TASK_A: Task = { id: 'A', title: 'Add hello', text: 'Create a/hello.txt with the line hello, and test it.', writes: true, files: ['a/'], rules: ['R1 v1: keep a/ POSIX sh'], bind: BIND_A }
export const TASK_B: Task = { id: 'B', title: 'Add "world"', text: 'Create b/world.txt with the line world, and test it.', writes: true, files: ['b/'], rules: [], bind: BIND_B }
export const TASK_R: Task = { id: 'R', title: 'Find the entry point', text: 'Where does the check script start?', writes: false, files: [], rules: ['R2 v3: cite file:line'] }

export function argsWith(tasks: Task[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run: RUN,
    nonce: NONCE,
    authorized: 'each writing task commits once on its own worktree branch\nnothing is pushed',
    rules: ['For this run (stated by you): keep changes small'],
    verifyCommand: 'sh check.sh',
    tasks,
    contract: 'Every new file ends with a newline.',
    mergeOrder: tasks.filter(t => t.writes).map(t => t.id),
    ...extra,
  }
}

export const done = (files: string[]) => ({ status: 'done', files, checks: ['sh check.sh: exit 0'], summary: 'Added the file and its test.', notes: '' })
export const blocked = (why: string) => ({ status: 'blocked', files: [], checks: [], summary: why, notes: '' })
export const unbound = (refusal: string) => ({ ...blocked(refusal), unbound: true, bind_refusal: refusal })
export const researched = { summary: 'check.sh starts at check.sh:1.', findings: [{ claim: 'The check starts at line 1', evidence: ['check.sh:1'] }], open: [] }

export const merged = (ids: string[], extra: Record<string, unknown> = {}) => ({
  integrate_id: 'i14',
  status: 'merged',
  where: WHERE,
  base: BASE,
  merged: ids,
  skipped: [],
  tip: 'c'.repeat(40),
  tree: 'd'.repeat(40),
  changed: [
    { path: 'a/hello.txt', task: 'A' },
    { path: 'b/world.txt', task: 'B' },
  ],
  ...extra,
})
/** The mod's final answer for a merge that stopped: reachable only from a hand-written run.json (plan section 7, fanout.js step 3). */
export const conflict = (task: string, mergedIds: string[], files = ['b/world.txt']) => ({
  integrate_id: 'i11',
  status: 'conflict',
  where: WHERE,
  base: BASE,
  merged: mergedIds,
  skipped: [],
  conflict: { task, branch: `litter/${RUN}-w2`, files },
})
export const check = (ids: string[], fail: string[] = []) => ({
  verify_id: VERIFY_ID,
  tasks: ids.map(id => ({ id, pass: !fail.includes(id), evidence: fail.includes(id) ? `${id}: b/world.txt:1 is empty` : `${id}: verify ${VERIFY_ID} exit 0`, gaps: fail.includes(id) ? ['b/world.txt:1 is empty'] : [] })),
  combined: 'The tasks fit together.',
})
export const landedOk = { landed: true, commit: 'c'.repeat(40), retry: false }
