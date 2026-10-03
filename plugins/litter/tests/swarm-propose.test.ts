// Tier 1: mcp__litter__swarm_propose as the engine runs it (plan 15.4, "The
// swarm tools"): the reply is JSON in `result`, never passed on to the bottom
// hook; a proposal staged into a litter directory; and a throw inside the
// hook answered by its catch, a deny naming the hook. Everything else about
// proposals is propose.spec.ts's.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const TOOL = 'mcp__litter__swarm_propose'

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

/** session.start in /repo, with the tools and roles registered, so the session has a litter directory. */
async function started($: Parameters<TestBody>[0], on: On): Promise<Map<string, string>> {
  const files = world(on)
  mock.clock(on, { now: 5_000 })
  mock.env(on, {})
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('session.id', async () => ({ value: 'tier1-session' }))
  on('ui.log', async () => ({ value: undefined }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  return files
}

const RO = { commit: false, push: 'none', forcePush: false, rewriteHistory: false, worktreeOps: false }
const SPEC = {
  name: 'alpha',
  goal: 'Review the branch',
  nodes: [
    { id: 'lead-a', kind: 'orchestrator', worktree: 'none', brief: 'briefs/lead-a.md', tools: { deny: ['Edit', 'Write', 'NotebookEdit'] }, authority: RO, spawns: { reviewer: 2 } },
    { id: 'reviewer', kind: 'worker', tools: { deny: ['Edit', 'Write', 'NotebookEdit'] }, authority: RO },
  ],
}

const parse = (r: { result?: unknown }) => JSON.parse(String(r.result)) as { ok: boolean; error?: string; errors?: { field: string }[]; proposal?: number }

describe('swarm_propose', () => {
  test('its reply is JSON in result, and the call never reaches the bottom hook', async ($, on) => {
    mock.store(on)
    let reached = false
    on('tool.call', { tool: TOOL }, async () => {
      reached = true
      return { result: 'engine' }
    })
    const r = await $.tool.call({ tool: TOOL, tool_use_id: 'p1', swarm: 'alpha', baseRevision: 0, spec: SPEC, changes: [] })
    expect(typeof r.result).toBe('string')
    expect(parse(r)).toEqual({ ok: false, error: expect.stringContaining('litter: no litter directory') })
    const sub = parse(await $.tool.call({ tool: TOOL, tool_use_id: 'p2', agentId: 'agent-9', swarm: 'alpha' }))
    expect(sub).toEqual({ ok: false, error: expect.stringContaining('agent agent-9') })
    expect(reached).toBe(false)
  })

  test('a proposal that passes is staged in the litter directory and answered with its number and counts', async ($, on) => {
    mock.store(on)
    const files = await started($, on)
    const bad = parse(await $.tool.call({ tool: TOOL, tool_use_id: 'p3', swarm: 'alpha', baseRevision: 0, spec: SPEC, changes: [] }))
    expect(bad).toEqual({ ok: false, errors: [expect.objectContaining({ field: 'nodes.lead-a.brief' })] })
    const r = await $.tool.call({
      tool: TOOL,
      tool_use_id: 'p4',
      swarm: 'alpha',
      baseRevision: 0,
      spec: JSON.stringify(SPEC),
      briefs: { 'lead-a': 'Lead the review.\n' },
      changes: [{ path: 'nodes.lead-a', reason: 'one lead' }],
    })
    expect(parse(r)).toEqual({ ok: true, proposal: 1, diff: { added: 2, removed: 0, changed: 1, briefs: 1, conflicts: 0 } })
    const swarm = '/repo/.claude/litter/swarms/alpha'
    expect(JSON.parse(files.get(`${swarm}/proposals/1/spec.json`) ?? 'null')).toEqual(SPEC)
    expect(files.get(`${swarm}/proposals/1/briefs/lead-a.md`)).toBe('Lead the review.\n')
    expect([...files.keys()].filter(k => k.startsWith(`${swarm}/ledger/`))).toEqual([`${swarm}/ledger/000001-swarm.proposal.json`])
  })

  test("a throw inside the hook reaches swarmProposeFailed's deny, naming the tool", async ($, on) => {
    // No store: the session starts, but reading the swarm's ledger head throws.
    await started($, on)
    const r = await $.tool.call({ tool: TOOL, tool_use_id: 'p5', swarm: 'alpha', baseRevision: 0, spec: SPEC, briefs: { 'lead-a': 'x' }, changes: [] })
    expect(r.deny).toContain(`litter guard failed: ${TOOL} (`)
    expect(r.deny).toContain('store.get')
    expect(r.deny).toContain('refusing')
  })
})
