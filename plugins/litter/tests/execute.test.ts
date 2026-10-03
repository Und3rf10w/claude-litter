// Tier 1: phase 3's execute side as the engine runs the mod (WP-AB). A
// Workflow call is litter's by its script's sha256 against the plugin's
// workflows/ files, for execute.js and plan.js as for the others; a gate
// critic's StructuredOutput, spooled, becomes its verdict record and its
// verdict file; and a plan run's questions-only return settles as done.
// Tier 1 reads no real files, so the scripts here are stand-ins served
// as the plugin's workflows/ files; tests/unit/executejs.spec.ts and
// planjs.spec.ts run the real ones, and check they're where this reads them.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

const LITTER = '/repo/.claude/litter'
const SESSION = 'tier1-session'

/** Stand-ins for the shipped scripts, by name: what launch.ts hashes from `<plugin root>/workflows/<name>.js`. */
const SHIPPED: Record<string, string> = {
  execute: 'export const meta = { name: "execute" }\n// stand-in for workflows/execute.js\n',
  plan: 'export const meta = { name: "plan" }\n// stand-in for workflows/plan.js\n',
  fanout: 'export const meta = { name: "fanout" }\n',
  design: 'export const meta = { name: "design" }\n',
}
const SHIPPED_PATH = /\/workflows\/(execute|plan|fanout|design)\.js$/

/**
 * $.fs from a map of files, with the plugin's workflows/ files served from
 * SHIPPED wherever the plugin root is, and $.process.run for the git calls
 * litterdir.ts makes in a plain checkout at /repo, plus fsx.ts's mv and rm
 * (as lifecyclerepair.test.ts's world).
 */
function world(on: On): Map<string, string> {
  const files = new Map<string, string>()
  const shipped = (path: string) => (files.has(path) ? undefined : SHIPPED[SHIPPED_PATH.exec(path)?.[1] ?? ''])
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  const run = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) || isDir(e.path) || shipped(e.path) !== undefined }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path) ?? shipped(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => {
    if (!isDir(e.path)) throw new Error(`ENOENT: ${e.path}`)
    const names = new Set([...files.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => k.slice(e.path.length + 1).split('/')[0]!))
    return {
      value: [...names].map(name => ({ name, kind: files.has(`${e.path}/${name}`) ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false })),
    }
  })
  on('fs.stat', async (_$, e) => {
    const known = files.has(e.path) || isDir(e.path) || e.path === '/repo' || e.path === '/repo/.git'
    if (!known) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: files.has(e.path) ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
  })
  on('process.run', async (_$, e) => {
    const argv = e.argv
    if (argv[0] === 'mv') {
      const [from, to] = argv.slice(-2) as [string, string]
      const text = files.get(from) ?? ''
      files.delete(from)
      files.set(to, text)
      return run(0)
    }
    if (argv[0] === 'rm') {
      const path = argv[argv.length - 1]!
      for (const k of [...files.keys()]) if (k === path || k.startsWith(`${path}/`)) files.delete(k)
      return run(0)
    }
    if (argv[0] === 'git' && argv.includes('rev-parse')) {
      if (argv.includes('--show-toplevel') && !argv.includes('--git-dir')) return run(0, '/repo\n')
      if (argv.includes('--git-dir') && argv.includes('--git-common-dir')) return run(0, '/repo/.git\n/repo/.git\n')
    }
    return run(1)
  })
  return files
}

/** The engine as the mod's hooks reach it: tools and agents registered, the session's id, the logs. */
function engine(on: On): string[] {
  const logs: string[] = []
  on('ui.log', async (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('agent.list', async () => ({ value: [] }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  return logs
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/** A run's run.json and its ledger, built by hand, each record chained to the one before; no stored head, so it's accepted. */
async function seedRun(files: Map<string, string>, run: string, workflow: string, records: { kind: string; by?: Record<string, unknown>; body: Record<string, unknown> }[]) {
  const dir = `${LITTER}/${run}`
  const json = { v: 1, run, workflow, args: {}, ref: `refs/heads/litter/${run}`, base: '0'.repeat(40), checkout: '/repo', isolate: false, linkDirs: [], rules: [] }
  files.set(`${dir}/run.json`, `${JSON.stringify(json)}\n`)
  let prev: string | null = null
  for (const [i, r] of records.entries()) {
    const seq = i + 1
    const text = `${JSON.stringify({ v: 1, seq, kind: r.kind, run, at: seq * 1_000, by: r.by ?? { source: 'mod' }, prev, body: r.body })}\n`
    files.set(`${dir}/ledger/${String(seq).padStart(6, '0')}-${r.kind}.json`, text)
    prev = await sha256(text)
  }
}

const started = async ($: Engine) => $.session.start({ cwd: '/repo', surface: null, isInteractive: false })

describe("execute.js and plan.js are litter's by their content", () => {
  test('a copy of either at any path is that workflow, and a name that disagrees with the content is refused', async ($, on) => {
    mock.store(on)
    const files = world(on)
    engine(on)
    files.set('/elsewhere/copy-of-execute.js', SHIPPED.execute!)
    files.set('/elsewhere/copy-of-plan.js', SHIPPED.plan!)
    files.set('/elsewhere/mine.js', 'export const meta = { name: "mine" }\n')
    let reached = 0
    on('tool.call', { tool: 'Workflow' }, async () => {
      reached++
      return { result: 'engine' }
    })
    // No litter directory in this session: a call litter recognizes stops there, anyone else's goes on.
    const exec = await $.tool.call({ tool: 'Workflow', tool_use_id: 'w1', scriptPath: '/elsewhere/copy-of-execute.js', args: { run: '20261003-execute-x' } })
    expect(exec.deny).toContain('no litter directory')
    const plan = await $.tool.call({ tool: 'Workflow', tool_use_id: 'w2', scriptPath: '/elsewhere/copy-of-plan.js', name: 'litter:plan', args: { run: 'x' } })
    expect(plan.deny).toContain('no litter directory')
    const wrong = await $.tool.call({ tool: 'Workflow', tool_use_id: 'w3', scriptPath: '/elsewhere/copy-of-plan.js', name: 'litter:execute' })
    expect(wrong.deny).toBe('litter: the scriptPath holds litter:plan, not litter:execute')
    expect(reached).toBe(0)
    expect((await $.tool.call({ tool: 'Workflow', tool_use_id: 'w4', scriptPath: '/elsewhere/mine.js' })).result).toBe('engine')
    expect(reached).toBe(1)
  })
})

describe("a gate critic's StructuredOutput", () => {
  const RUN = '20261003-execute-ab12cd'
  const RUN_DIR = `${LITTER}/${RUN}`
  const CRITIC = { agentId: 'gc1', agentType: 'litter:gate-critic', role: 'gate-critic', run: RUN, cwd: '/repo', started: 1, stopped: null, sessionId: SESSION, transcriptPath: '/t' }
  const VERIFY = {
    verify_id: 'G1-1-aa', gate: 'G1', attempt: 1, argv: ['sh', 'check.sh'], tree_before: 'a'.repeat(40), tree_after: 'a'.repeat(40), dirty_submodules: [],
    exit_code: 0, signal: null, timed_out: false, spawn_error: null, green: true, log_parts: 1, log_bytes: 3, output_tail: 'ok',
  }
  const dim = (pass: boolean, evidence: string) => ({ pass, evidence, gaps: pass ? [] : ['src/a.ts:3 skips the version'] })
  const VERDICT = {
    verify_id: 'G1-1-aa',
    plan_adherence: dim(false, 'the version field is not parsed'),
    tests_green: dim(true, 'verify G1-1-aa exit 0'),
    no_regressions: dim(true, 'nothing else changed'),
    rules: dim(true, 'none apply'),
    plan_gap: '',
    proposed_rules: [],
  }

  test('drained from the spool, it is recorded as the verdict, and its verdict file is written from the cited verify', async ($, on) => {
    mock.store(on, { 'litter.agent.gc1': CRITIC })
    mock.clock(on, { now: 5_000 })
    const files = world(on)
    const logs = engine(on)
    await started($)
    await seedRun(files, RUN, 'execute', [{ kind: 'verify', by: { source: 'agent', agentId: 'gc1', agentType: 'litter:gate-critic' }, body: VERIFY }])
    const line = { v: 1, ev: 'output', ts: 2, session_id: SESSION, agent_id: 'gc1', agent_type: 'litter:gate-critic', tool_use_id: 'toolu_v1', input: VERDICT }
    files.set(`${LITTER}/hooks/spool/${SESSION}.jsonl`, `${JSON.stringify(line)}\n`)

    // The record tool drains the spool before its handler runs.
    const r = await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 'r1', kind: 'run.find' })
    expect(JSON.parse(String(r.result)).ok).toBe(true)

    const rec = JSON.parse(files.get(`${RUN_DIR}/ledger/000002-verdict.json`) ?? 'null') as { by: unknown; body: Record<string, unknown> } | null
    expect(rec?.by).toEqual({ source: 'agent', agentId: 'gc1', agentType: 'litter:gate-critic' })
    expect(rec?.body).toEqual({ ...VERDICT, tool_use_id: 'toolu_v1' })
    const file = files.get(`${RUN_DIR}/verdicts/G1-1.md`) ?? ''
    expect(file).toStartWith('# Verdict on G1, attempt 1\n')
    expect(file).toContain('- Verify: G1-1-aa, exit 0, green')
    expect(file).toContain('- Verdict: rejected, failing plan_adherence')
    expect(file).toContain('- Agent: gc1 (litter:gate-critic)')
    expect(file).toContain('- Ledger seq: 2')
    expect(file).toContain('## plan_adherence: fail\n\nEvidence: the version field is not parsed\n\nGaps:\n- src/a.ts:3 skips the version')
    expect(logs.filter(l => l.includes('verdict'))).toEqual([])
  })
})

describe("plan.js's return", () => {
  const RUN = '20261003-plan-cd34ef'
  const RUN_DIR = `${LITTER}/${RUN}`
  const TASK = 'task-p1'
  const notice = (result: string) =>
    `<task-notification>\n<task-id>${TASK}</task-id>\n<status>completed</status>\n` +
    '<summary>Dynamic workflow "litter:plan" completed</summary>\n' +
    `<result>${result}</result>\n</task-notification>`

  test('questions and no gates settle the plan run as done', async ($, on) => {
    mock.store(on, { [`litter.task.${TASK}`]: { run: RUN, runDir: RUN_DIR, litterDir: LITTER } })
    mock.clock(on, { now: 5_000 })
    const files = world(on)
    engine(on)
    await seedRun(files, RUN, 'plan', [
      { kind: 'run.launch', body: { taskId: TASK, runId: 'wf_p1', scriptPath: null, generation: 1, session: SESSION, oid: '1'.repeat(40) } },
    ])
    on('prompt.submit', async (_$, e) => ({ text: e.text }))
    await started($)
    const text = notice('{"gates":[],"out_of_scope":[],"assumptions":["one header format"],"questions":["Which header format is current?"]}')
    await $.prompt.submit({ text, origin: { kind: 'task-notification' }, wait: false })
    const end = JSON.parse(files.get(`${RUN_DIR}/ledger/000002-run.end.json`) ?? 'null') as { body?: Record<string, unknown> } | null
    expect(end?.body).toEqual(expect.objectContaining({ generation: 1, status: 'done', reason: null, source: 'notification' }))
  })
})
