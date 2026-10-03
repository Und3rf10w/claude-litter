// Tier 1: the record tool as the engine runs it (plan section 12): registered
// at session.start, answered in its hook without reaching the bottom one, a
// throw inside it denied by its catch, and the main thread and an agent each
// identified. The store is mocked; the one case that writes a record answers
// $.fs from memory and git with what it would print for a plain checkout.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const RUN = '20261002-tier1'

/**
 * $.fs from a map of files, and $.process.run for the git calls litterdir.ts
 * makes in a plain checkout at /repo, plus the mv and rm fsx.ts runs.
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

/** An agent the map knows, as consumeAgents stores it (policy.ts). */
const AGENT = {
  'litter.agent.a1': {
    agentId: 'a1',
    agentType: 'litter:falsifier',
    role: 'falsifier',
    run: RUN,
    cwd: '/w',
    started: 1,
    stopped: null,
  },
}

const parse = (r: { result?: unknown }) => JSON.parse(String(r.result)) as { ok: boolean; error?: string; field?: string; allowed?: string[] }

describe('record tool', () => {
  test('session.start registers the record tool and the fourteen roles', async ($, on) => {
    mock.store(on)
    mock.clock(on)
    const tools: string[] = []
    const agents: string[] = []
    on('tool.register', async (_$, e) => {
      tools.push(e.name)
      return { value: { tool: `mcp__litter__${e.name}` } }
    })
    on('agent.register', async (_$, e) => {
      agents.push(e.name)
      return { value: { agent: `litter:${e.name}` } }
    })
    on('ui.log', async () => ({ value: undefined }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/nonexistent/litter-test', surface: null, isInteractive: false })
    expect(tools).toEqual(['record'])
    expect(agents.length).toBe(14)
    expect(agents).toContain('gate-critic')
  })

  test('a call is answered by the mod and never reaches the bottom hook', async ($, on) => {
    mock.store(on)
    let reached = false
    on('tool.call', { tool: 'mcp__litter__record' }, async () => {
      reached = true
      return { result: 'engine' }
    })
    const r = await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 't1', kind: 'rule.accept' })
    expect(reached).toBe(false)
    expect(parse(r)).toEqual(expect.objectContaining({ ok: false, field: 'kind', allowed: ['rule.propose'] }))
  })

  test("a throw inside the dispatcher reaches recordFailed's deny", async ($, on) => {
    // Nothing answers store.get, so the agent map's lookup throws.
    on('ui.log', async () => ({ value: undefined }))
    const r = await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 't2', agentId: 'a1', kind: 'finding', report: 'x' })
    expect(r.deny).toContain('litter guard failed: mcp__litter__record (')
    expect(r.deny).toContain('store.get')
    expect(r.deny).toContain('refusing')
  })

  test('a main-thread call is the launcher', async ($, on) => {
    mock.store(on, AGENT)
    const r = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 't3', kind: 'finding', report: 'x' }))
    expect(r).toEqual(expect.objectContaining({ ok: false, field: 'kind' }))
    expect(r.error).toContain('not from the main thread')
    expect(r.allowed).toContain('run.start')
    expect(r.allowed).not.toContain('finding')
  })

  test("an agent can't record a launcher's kind", async ($, on) => {
    mock.store(on, AGENT)
    const r = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 't4', agentId: 'a1', kind: 'run.start', workflow: 'execute' }))
    expect(r).toEqual(expect.objectContaining({ ok: false, field: 'kind' }))
    expect(r.error).toContain('not by an agent')
    expect(r.allowed).toContain('finding')
    expect(r.allowed).not.toContain('run.start')
  })

  test("an agent's call is recorded as that agent's, in the run the agent map gives it", async ($, on) => {
    mock.store(on, AGENT)
    mock.clock(on, { now: 5_000 })
    const files = world(on)
    on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
    on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
    on('session.id', async () => ({ value: 'tier1-session' }))
    on('ui.log', async () => ({ value: undefined }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const r = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 't5', agentId: 'a1', kind: 'Finding', report: '## Result\nnone' }))
    expect(r).toEqual(expect.objectContaining({ ok: true, kind: 'finding', run: RUN, seq: 1 }))
    const stored = JSON.parse(files.get(`/repo/.claude/litter/${RUN}/ledger/000001-finding.json`) ?? 'null')
    expect(stored).toEqual(
      expect.objectContaining({
        kind: 'finding',
        run: RUN,
        by: { source: 'agent', agentId: 'a1', agentType: 'litter:falsifier' },
        body: { report: '## Result\nnone' },
      }),
    )
  })
})
