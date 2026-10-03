// Tier 1: the lead's end request, `mcp__litter__record { kind: 'swarm.end',
// swarm }`, as the engine runs it (WP-P): its reply shape through the record
// tool, an agent refused before the handler, and a throw inside it denied by
// the record tool's catch. Nothing is live in a tier-1 session, so the
// stopping itself is tier 2's (tests/unit/end.spec.ts).

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'

/**
 * $.fs from a map of files, and $.process.run for the git calls litterdir.ts
 * makes in a plain checkout at /repo, plus the mv and rm fsx.ts runs (as
 * record.test.ts's world), so session.start resolves a litter directory.
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

/** session.start at /repo, every port answered; `broken.sessionId` makes `$.session.id` throw from then on. */
async function started($: Engine, on: On, store: Record<string, unknown> = {}) {
  const broken = { sessionId: false }
  mock.store(on, store)
  mock.clock(on, { now: 5_000 })
  const files = world(on)
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('session.id', async () => {
    if (broken.sessionId) throw new Error('session.id is down')
    return { value: 'tier1-session' }
  })
  on('ui.log', async () => ({ value: undefined }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  return { broken, files }
}

const parse = (r: { result?: unknown }) => JSON.parse(String(r.result)) as { ok: boolean; error?: string; field?: string; allowed?: string[]; status?: string }

describe('the lead’s swarm.end through the record tool', () => {
  test('with nothing live, the reply names the swarm field and the live swarms, and records nothing', async ($, on) => {
    const { files } = await started($, on)
    const r = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 'e1', kind: 'swarm.end', swarm: 'alpha' }))
    expect(r).toEqual({ ok: false, error: "litter: there's no live swarm named alpha", field: 'swarm', allowed: [] })
    const missing = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 'e2', kind: 'swarm.end' }))
    expect(missing).toEqual(expect.objectContaining({ ok: false, field: 'swarm', allowed: [] }))
    expect(missing.error).toContain("'swarm' is required")
    expect([...files.keys()].filter(k => k.includes('/swarms/'))).toEqual([])
  })

  test("an agent's swarm.end is refused before the handler, naming kind", async ($, on) => {
    await started($, on, {
      'litter.agent.n1': { agentId: 'n1', agentType: 'litter:sw-alpha-boss', role: null, run: null, cwd: '/repo', started: 1, stopped: null },
    })
    const r = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 'e3', agentId: 'n1', kind: 'swarm.end', swarm: 'alpha' }))
    expect(r).toEqual(expect.objectContaining({ ok: false, field: 'kind' }))
    expect(r.error).toContain('not by an agent')
  })

  test("a throw inside it reaches the record tool's catch, which refuses", async ($, on) => {
    const { broken } = await started($, on)
    // The dispatcher drains the spool before any handler, and the drain asks for the session id:
    // the harness skips a hook that throws, so nothing answers it.
    broken.sessionId = true
    const r = await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 'e4', kind: 'swarm.end', swarm: 'alpha' })
    expect(r.deny).toContain('litter guard failed: mcp__litter__record (')
    expect(r.deny).toContain('session.id')
    expect(r.deny).toContain('refusing')
  })
})
