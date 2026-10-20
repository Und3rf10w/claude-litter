// Tier 1: a halted fanout's notification settles before the <swarm> block
// (phase 2b-2, WP-W, with V's wiring), as the engine runs it. On prompt.submit
// the notice's run.end is recorded, then summary.md with its Repair section
// (repair.ts's), then the repair bridge is called; the <swarm> block and the
// repair note are built only after, and the engine's turn last. A late notice for generation 1 while
// a repair generation is open records nothing and calls no bridge. The tier-2
// cases are tests/unit/lifecyclerepair.spec.ts.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const LITTER = '/repo/.claude/litter'
const RUN = '20261003-fan'
const RUN_DIR = `${LITTER}/${RUN}`
const TASK = 'task-1'

type Timeline = string[]

/**
 * $.fs from a map of files, and $.process.run for the git calls litterdir.ts
 * makes in a plain checkout at /repo, plus the mv and rm fsx.ts runs (as
 * repairwiring.test.ts's world). Each run.end and summary.md written, and
 * each log line, goes on the timeline in the order it happened.
 */
function world(on: On, timeline: Timeline): Map<string, string> {
  const files = new Map<string, string>()
  const set = (path: string, text: string) => {
    files.set(path, text)
    if (path === `${RUN_DIR}/summary.md`) timeline.push('summary.md')
    else if (path.startsWith(`${RUN_DIR}/ledger/`) && path.endsWith('-run.end.json')) timeline.push('run.end')
  }
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  const run = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    set(e.path, e.text)
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
      set(to, text)
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

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/**
 * A fanout run's ledger built by hand, each record chained to the one before
 * (its `prev` the sha256 of that file's text): run.launch (generation 1), then
 * the bodies given. With no stored head the ledger is accepted. run.json has
 * the repair setting a 2b-2 run.start writes; there is no run.start, so
 * session.start's reconcile leaves the run be. Answers the head this
 * session's appends left in `$.store`, for mock.store: with no head there the
 * ledger is another store's, and the mod leaves it alone.
 */
async function seedFanout(files: Map<string, string>, more: { kind: string; body: Record<string, unknown> }[] = []): Promise<Record<string, unknown>> {
  const json = {
    v: 1,
    run: RUN,
    workflow: 'fanout',
    args: {},
    ref: `refs/heads/litter/${RUN}`,
    base: '0'.repeat(40),
    checkout: '/repo',
    isolate: false,
    linkDirs: [],
    repair: { mode: 'auto', rounds: 3, agents: 6 },
  }
  files.set(`${RUN_DIR}/run.json`, `${JSON.stringify(json)}\n`)
  const all = [{ kind: 'run.launch', body: { taskId: TASK, runId: 'wf_abc123', scriptPath: null, generation: 1, session: 'tier1-session', oid: '1'.repeat(40) } }, ...more]
  let prev: string | null = null
  for (const [i, r] of all.entries()) {
    const seq = i + 1
    const text = `${JSON.stringify({ v: 1, seq, kind: r.kind, run: RUN, at: seq * 1_000, by: { source: 'mod' }, prev, body: r.body })}\n`
    files.set(`${RUN_DIR}/ledger/${String(seq).padStart(6, '0')}-${r.kind}.json`, text)
    prev = await sha256(text)
  }
  return { [`litter.head.${RUN_DIR}`]: { v: 2, seq: all.length, sha: prev } }
}

const HALTED_NOTICE =
  `<task-notification>\n<task-id>${TASK}</task-id>\n<status>completed</status>\n` +
  '<summary>Dynamic workflow "litter:fanout-run" completed</summary>\n' +
  '<result>{"halted":"not verified: client failed the verifier"}</result>\n' +
  '</task-notification>'

/** The engine as the mod's hooks reach it: tools and agents registered, the session's id, and the logs on the timeline. */
function engine(on: On, timeline: Timeline): string[] {
  const logs: string[] = []
  on('ui.log', async (_$, e) => {
    logs.push(e.text)
    timeline.push(`log: ${e.text}`)
    return { value: undefined }
  })
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('session.id', async () => ({ value: 'tier1-session' }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  return logs
}

const at = (timeline: Timeline, match: string) => timeline.findIndex(t => t.includes(match))

describe('a halted fanout notice and the repair', () => {
  test('settles before the <swarm> block: run.end, then summary.md with its Repair section, then the bridge, then the note and the engine', async ($, on) => {
    const timeline: Timeline = []
    const files = world(on, timeline)
    mock.store(on, { [`litter.task.${TASK}`]: { run: RUN, runDir: RUN_DIR, litterDir: LITTER }, ...(await seedFanout(files)) })
    mock.clock(on, { now: 5_000 })
    engine(on, timeline)
    let context: readonly string[] | undefined
    on('prompt.submit', async (_$, e) => {
      timeline.push('engine')
      context = e.context
      return { text: e.text, ...(e.context ? { context: e.context } : {}) }
    })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
    const r = await $.prompt.submit({ text: HALTED_NOTICE, origin: { kind: 'task-notification' }, context: ['earlier'], wait: false })
    expect(r).toEqual(expect.objectContaining({ text: HALTED_NOTICE, context: ['earlier'] }))
    // Nothing live, so no <swarm> block: the context is the prompt's own.
    expect(context).toEqual(['earlier'])

    const end = JSON.parse(files.get(`${RUN_DIR}/ledger/000002-run.end.json`) ?? 'null') as { body?: Record<string, unknown> } | null
    expect(end?.body).toEqual(expect.objectContaining({ generation: 1, status: 'halted', reason: 'not verified: client failed the verifier', source: 'notification' }))
    const summary = files.get(`${RUN_DIR}/summary.md`) ?? ''
    expect(summary).toContain('- Status: halted (not verified: client failed the verifier)')
    expect(summary).not.toContain('## Repair generation')

    // The bridge (repair.ts) is reached: with no run.start in this hand-built ledger it refuses, and that log marks the call.
    const order = {
      end: at(timeline, 'run.end'),
      summary: timeline.lastIndexOf('summary.md'),
      bridge: at(timeline, `run ${RUN}: the repair bridge failed:`),
      engine: at(timeline, 'engine'),
    }
    expect(order).toEqual({ end: expect.any(Number), summary: expect.any(Number), bridge: expect.any(Number), engine: expect.any(Number) })
    expect(Object.values(order).every(i => i >= 0)).toBe(true)
    expect(order.end).toBeLessThan(order.summary)
    expect(order.summary).toBeLessThan(order.bridge)
    expect(order.bridge).toBeLessThan(order.engine)
    // The Repair section and the note are built without failing.
    expect(timeline.some(t => t.includes("the summary's Repair section failed") || t.includes('repair note failed'))).toBe(false)
  })

  test('a late notice for generation 1 while its repair generation is open records nothing and calls no bridge', async ($, on) => {
    // The task's key outlived its run.end (a write that failed, say): the notice still finds the run.
    const timeline: Timeline = []
    const files = world(on, timeline)
    const head = await seedFanout(files, [
      { kind: 'run.end', body: { taskId: TASK, generation: 1, status: 'halted', reason: 'not verified', source: 'notification' } },
      { kind: 'run.repair', body: { generation: 2, swarm: 'repair-abc123', launch: '20261003-120000', budget: { rounds: 3, agents: 6 } } },
    ])
    mock.store(on, { [`litter.task.${TASK}`]: { run: RUN, runDir: RUN_DIR, litterDir: LITTER }, ...head })
    mock.clock(on, { now: 9_000 })
    const before = [...files.keys()].sort()
    const logs = engine(on, timeline)
    on('prompt.submit', async (_$, e) => ({ text: e.text, ...(e.context ? { context: e.context } : {}) }))
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
    const r = await $.prompt.submit({ text: HALTED_NOTICE, origin: { kind: 'task-notification' }, wait: false })
    expect(r).toEqual(expect.objectContaining({ text: HALTED_NOTICE }))
    expect(files.has(`${RUN_DIR}/ledger/000004-run.end.json`)).toBe(false)
    expect([...files.keys()].filter(k => k.startsWith(`${RUN_DIR}/`)).sort()).toEqual(before.filter(k => k.startsWith(`${RUN_DIR}/`)))
    expect(timeline.filter(t => t === 'run.end' || t === 'summary.md')).toEqual([])
    expect(logs.some(l => l.includes('the repair bridge failed'))).toBe(false)
    expect(logs.some(l => l.includes(`notification for task ${TASK} not settled`))).toBe(false)
  })
})
