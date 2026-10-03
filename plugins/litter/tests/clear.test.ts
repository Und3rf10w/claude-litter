// Tier 1: /clear, with the mod loaded by the engine (WP-O; plan 15.4, "Litter
// holds /clear while anything is running" and "After /clear"). The hold
// answers the command itself, so a hook below it (the test's, standing for
// the engine's clear) sees no clear; with nothing running it passes on; and
// its catch passes the clear on. Then the rebind: session.end `clear`, no
// session.start, a new session id, with and without classic SessionStart.

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const LITTER = '/repo/.claude/litter'
const POLICY = `${LITTER}/hooks/policy.json`
const RUN = '20270115-execute-abcdef'
const CLEAR = { command: 'clear', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as const
const HELD = "litter: /clear held; the swarm browser shows when they're idle"

/**
 * $.fs from a map of files, and $.process.run for the git calls litterdir.ts
 * makes in a plain checkout at /repo, plus fsx.ts's mv and rm (wiring.test.ts's
 * world), so session.start resolves /repo/.claude/litter.
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

/** policy.json with an active run of `session` (written after session.start, so its reconcile leaves it). */
const runPolicy = (session: string) =>
  JSON.stringify({
    v: 1,
    session,
    litterDir: LITTER,
    run: {
      run: RUN,
      workflow: 'execute',
      runDir: `${LITTER}/${RUN}`,
      checkout: '/repo',
      base: 'b'.repeat(40),
      runIds: ['wf_abc123'],
      launching: false,
      stopping: false,
      inflight: null,
      isolationLost: false,
      roots: { checkout: '/repo', litterDir: LITTER, litterCopies: [LITTER], ruleDirs: [], worktrees: [] },
      setup: null,
      linkDirs: [],
    },
    roles: {},
    swarm: null,
  })

/**
 * The world and the nouns session.start calls; `sid` is read at each
 * session.id. A test registers its own hooks after this and before `start`
 * (the harness takes none once the test has called `$`).
 */
function setup(on: On, sid: { value: string }): Map<string, string> {
  mock.store(on)
  mock.clock(on, { now: 5_000 })
  const files = world(on)
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('session.id', async () => ({ value: sid.value }))
  on('ui.log', async () => ({ value: undefined }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  return files
}

/** session.start in /repo, which resolves /repo/.claude/litter. */
async function start($: Engine): Promise<void> {
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
}

/** The engine's clear, below every plugin's hook: it records that it ran. */
function engineClear(on: On): { ran: number } {
  const seen = { ran: 0 }
  on('command.run', { command: 'clear' }, async () => {
    seen.ran++
    return { text: 'engine cleared' }
  })
  return seen
}

describe('/clear, held while a run agent is running', () => {
  test("held: the mod answers { text } itself, and the clear below it doesn't run", async ($, on) => {
    const sid = { value: 'tier1-a' }
    const files = setup(on, sid)
    // A workflow's agents aren't listed; a role the list shows running is (the in-flight table is module memory, empty here).
    on('agent.list', async () => ({ value: [{ id: 'exec-1', type: 'litter:executor', status: 'running', description: 'executor' }] }))
    let asked = ''
    on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
      asked = JSON.stringify(e)
      // Nobody to answer (a -p run, an SDK host): the ask rejects.
      throw new Error('no one to ask')
    })
    const engine = engineClear(on)
    await start($)
    files.set(POLICY, runPolicy('tier1-a'))
    const r = await $.command.run(CLEAR)
    expect(r).toEqual(expect.objectContaining({ text: HELD }))
    expect(engine.ran).toBe(0)
    expect(asked).toContain('/clear stops these commands halfway (their shells are killed)')
    expect(asked).toContain(`executor in run ${RUN}: running, between commands`)
    expect(asked).toContain('Clear anyway')
  })

  test('with nothing live, the clear passes straight on', async ($, on) => {
    const sid = { value: 'tier1-a' }
    setup(on, sid)
    let listed = 0
    on('agent.list', async () => {
      listed++
      return { value: [] }
    })
    const engine = engineClear(on)
    await start($)
    expect(await $.command.run(CLEAR)).toEqual(expect.objectContaining({ text: 'engine cleared' }))
    expect(engine.ran).toBe(1)
    expect(listed).toBe(0)
  })

  test('with a run active and nothing of it running, it passes on without asking', async ($, on) => {
    const sid = { value: 'tier1-a' }
    const files = setup(on, sid)
    on('agent.list', async () => ({ value: [{ id: 'x', type: 'general-purpose', status: 'running', description: 'x' }, { id: 'e', type: 'litter:executor', status: 'completed', description: 'e' }] }))
    let asked = 0
    on('tool.call', { tool: 'AskUserQuestion' }, async () => {
      asked++
      throw new Error('no one to ask')
    })
    const engine = engineClear(on)
    await start($)
    files.set(POLICY, runPolicy('tier1-a'))
    expect(await $.command.run(CLEAR)).toEqual(expect.objectContaining({ text: 'engine cleared' }))
    expect(engine.ran).toBe(1)
    expect(asked).toBe(0)
  })

  test("the hook's catch passes the clear on (the agent list fails)", async ($, on) => {
    const sid = { value: 'tier1-a' }
    const files = setup(on, sid)
    on('agent.list', async () => {
      throw new Error('list refused')
    })
    const engine = engineClear(on)
    await start($)
    files.set(POLICY, runPolicy('tier1-a'))
    expect(await $.command.run(CLEAR)).toEqual(expect.objectContaining({ text: 'engine cleared' }))
    expect(engine.ran).toBe(1)
  })
})

describe('after a /clear', () => {
  for (const classic of [true, false]) {
    test(`${classic ? 'with' : 'without'} classic SessionStart (source clear): the first hook after it moves policy.json to the new session`, async ($, on) => {
      const sid = { value: 'tier1-a' }
      const files = setup(on, sid)
      let ended = false
      on('session.end', async (_$, e) => {
        ended = true
        return { sessionId: e.sessionId }
      })
      let classicSeen: string | null = null
      on('classic.SessionStart', async (_$, e) => {
        classicSeen = e.source
        return {}
      })
      on('agent.list', async () => ({ value: [] }))
      const engine = engineClear(on)
      await start($)
      files.set(POLICY, runPolicy('tier1-a'))

      // The engine's clear: session.end `clear`, then the new id, and (unless managed) classic SessionStart. No session.start.
      await $.session.end({ reason: 'clear', sessionId: 'tier1-a', resume: { id: 'tier1-a' } })
      expect(ended).toBe(true)
      sid.value = 'tier1-b'
      if (classic) {
        await $.classic.SessionStart({ source: 'clear' })
        // litter hooks no classic event: it reaches the hook below untouched, and moves nothing.
        expect(classicSeen).toBe('clear')
        expect(JSON.parse(files.get(POLICY)!).session).toBe('tier1-a')
      }

      // The first litter hook after it rebinds, then answers as usual.
      expect(await $.command.run(CLEAR)).toEqual(expect.objectContaining({ text: 'engine cleared' }))
      expect(engine.ran).toBe(1)
      expect(JSON.parse(files.get(POLICY)!).session).toBe('tier1-b')
    })
  }
})
