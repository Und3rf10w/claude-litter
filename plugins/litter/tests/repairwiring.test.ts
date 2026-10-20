// Tier 1: the repair wiring (phase 2b-2, WP-V) as the engine runs it. On
// prompt.submit a task notification settles before anything else is built,
// and a halted fanout's goes to the repair bridge after its run.end. Then the
// <swarm> block and the repair note are built, and the prompt goes on with its
// context kept. Each new call is caught in its event's shape: X's bridge
// rejects a run it can't check, and every hook still passes on (X's own
// tier 1, repair.test.ts, has a swarm waiting for its start). The block built after the bridge is tier 2
// (tests/unit/repaircallout.spec.ts), which can put a swarm in the state.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const LITTER = '/repo/.claude/litter'
const RUN = '20261003-fan'
const RUN_DIR = `${LITTER}/${RUN}`
const TASK = 'task-1'

/**
 * $.fs from a map of files, and $.process.run for the git calls litterdir.ts
 * makes in a plain checkout at /repo, plus the mv and rm fsx.ts runs (as
 * record.test.ts's world). Any other git call fails, which the run's ending
 * steps log or read as "no lock".
 */
function world(on: On): Map<string, string> {
  const files = new Map<string, string>()
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  const run = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
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
      files.set(to, files.get(from) ?? '')
      files.delete(from)
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
 * A fanout run with its first generation open, built by hand: run.json and
 * the run.launch record (seq 1). No run.start, so session.start's reconcile
 * leaves it be. Answers the head this session's appends left in `$.store`,
 * for mock.store: with no head there the ledger is another store's, and the
 * mod leaves it alone.
 */
async function seedFanout(files: Map<string, string>): Promise<Record<string, unknown>> {
  const json = { v: 1, run: RUN, workflow: 'fanout', args: {}, ref: `refs/heads/litter/${RUN}`, base: '0'.repeat(40), checkout: '/repo', isolate: false, linkDirs: [] }
  files.set(`${RUN_DIR}/run.json`, `${JSON.stringify(json)}\n`)
  const launch = {
    v: 1,
    seq: 1,
    kind: 'run.launch',
    run: RUN,
    at: 1_000,
    by: { source: 'mod' },
    prev: null,
    body: { taskId: TASK, runId: 'wf_abc123', scriptPath: null, generation: 1, session: 'tier1-session', oid: '1'.repeat(40) },
  }
  const text = `${JSON.stringify(launch)}\n`
  files.set(`${RUN_DIR}/ledger/000001-run.launch.json`, text)
  return { [`litter.head.${RUN_DIR}`]: { v: 2, seq: 1, sha: await sha256(text) } }
}

const HALTED_NOTICE =
  `<task-notification>\n<task-id>${TASK}</task-id>\n<status>completed</status>\n` +
  '<summary>Dynamic workflow "litter:fanout-run" completed</summary>\n' +
  '<result>{"halted":"not verified: client failed the verifier"}</result>\n' +
  '</task-notification>'

/** The mod's log lines, as the engine's ui.log receives them. */
function logged(on: On): string[] {
  const logs: string[] = []
  on('ui.log', async (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  return logs
}

describe('the repair wiring', () => {
  test("prompt.submit: a halted fanout's notice settles and reaches the bridge before the engine sees the prompt, its context kept", async ($, on) => {
    const files = world(on)
    mock.store(on, { [`litter.task.${TASK}`]: { run: RUN, runDir: RUN_DIR, litterDir: LITTER }, ...(await seedFanout(files)) })
    mock.clock(on, { now: 5_000 })
    const logs = logged(on)
    on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
    on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
    on('session.id', async () => ({ value: 'tier1-session' }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    // The engine's own answer, beneath the mod: what it sees when the prompt reaches it.
    let seen: { ended: boolean; context: readonly string[] | undefined; logs: string[] } | null = null
    on('prompt.submit', async (_$, e) => {
      seen = { ended: files.has(`${RUN_DIR}/ledger/000002-run.end.json`), context: e.context, logs: [...logs] }
      return { text: e.text, ...(e.context ? { context: e.context } : {}) }
    })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
    const r = await $.prompt.submit({ text: HALTED_NOTICE, origin: { kind: 'task-notification' }, context: ['earlier'], wait: false })
    expect(r).toEqual(expect.objectContaining({ text: HALTED_NOTICE, context: ['earlier'] }))
    expect(seen).not.toBeNull()
    const at = seen!
    expect(at.ended).toBe(true)
    expect(at.context).toEqual(['earlier'])
    const end = JSON.parse(files.get(`${RUN_DIR}/ledger/000002-run.end.json`) ?? 'null') as { body?: { status?: string; source?: string } } | null
    expect(end?.body).toEqual(expect.objectContaining({ status: 'halted', source: 'notification' }))
    // X's bridge reached the run after its end, before the engine's turn: with no run.start to check run.json
    // against, it rejects, which is logged. No repair swarm waits, so there's no note, and nothing failed.
    expect(at.logs.some(l => l.includes(`run ${RUN}: the repair bridge failed: run ${RUN} has no run.start record`))).toBe(true)
    expect(at.logs.some(l => l.includes('prompt.submit repair note failed'))).toBe(false)
  })

  test('prompt.submit: a plain prompt passes on with its context unchanged, and no note with no repair waiting', async ($, on) => {
    mock.store(on)
    const logs = logged(on)
    let seen: readonly string[] | undefined | null = null
    on('prompt.submit', async (_$, e) => {
      seen = e.context
      return { text: e.text, ...(e.context ? { context: e.context } : {}) }
    })
    const r = await $.prompt.submit({ text: 'hello', origin: { kind: 'composer' }, context: ['mine'], wait: false })
    expect(r).toEqual(expect.objectContaining({ text: 'hello', context: ['mine'] }))
    expect(seen).toEqual(['mine'])
    expect(logs.some(l => l.includes('prompt.submit repair note failed'))).toBe(false)
    // With no context the prompt goes on as it came.
    seen = null
    await $.prompt.submit({ text: 'again', origin: { kind: 'sdk' }, wait: false })
    expect(seen).toBeUndefined()
  })

  test("turn.complete: the repair call passes the turn on, the lead's and a subagent's, with nothing to start", async ($, on) => {
    mock.store(on)
    const logs = logged(on)
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    expect(await $.turn.complete({ turnId: 'turn-1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })).toEqual(
      expect.objectContaining({ text: 'done' }),
    )
    expect(await $.turn.complete({ turnId: 'turn-2', answer: 'sub', durationMs: 5, isAborted: false, reason: 'answer', agentId: 'agent-7' })).toEqual(
      expect.objectContaining({ text: 'sub' }),
    )
    expect(logs.filter(l => l.includes('turn.complete repair failed'))).toHaveLength(0)
  })

  test('session.start passes on with isInteractive either way', async ($, on) => {
    mock.store(on)
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    for (const isInteractive of [true, false]) {
      expect((await $.session.start({ cwd: '/nonexistent/litter-test', surface: null, isInteractive })).cwd).toBe('/nonexistent/litter-test')
    }
  })
})
