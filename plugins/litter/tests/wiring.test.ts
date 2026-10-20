// Tier 1: the mod loaded by the engine itself (`claude plugin test`). These
// pin the wiring: which hooks answer, and what a catch refuses. Each package
// adds its own *.test.ts beside this one for what only the engine can show;
// everything else is a tier-2 *.spec.ts under tests/unit/.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

describe('wiring', () => {
  test('session.start passes on, whatever its steps do', async ($, on) => {
    mock.store(on)
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    const r = await $.session.start({ cwd: '/nonexistent/litter-test', surface: null, isInteractive: false })
    expect(r.cwd).toBe('/nonexistent/litter-test')
  })

  test('the record tool is answered by the mod, never passed on', async ($, on) => {
    mock.store(on)
    const r = await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 't1', kind: 'finding' })
    expect(typeof r.result).toBe('string')
    expect(JSON.parse(String(r.result))).toEqual(expect.objectContaining({ ok: false, field: 'kind' }))
  })

  test('a plain Workflow call reaches the engine', async ($, on) => {
    on('tool.call', { tool: 'Workflow' }, async () => ({ result: 'engine' }))
    const r = await $.tool.call({ tool: 'Workflow', tool_use_id: 't2', script: 'export const meta = {}' })
    expect(r.result).toBe('engine')
  })
})

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

const parse = (r: { result?: unknown }) => JSON.parse(String(r.result)) as { ok: boolean; error?: string; field?: string }

const OFFER = { description: 'd', source: 'plugin', provider: { plugin: 'litter', tier: 'core' } } as const

// Phase 2b-1 (WP-C): with nothing live, every swarm hook leaves the engine's
// answer as it was; the swarm tools are the mod's, and refuse with no session.
describe('the swarm wiring, with nothing live', () => {
  test('a session.send reaches the engine unchanged', async ($, on) => {
    let seen: { to?: string; text?: string } | null = null
    on('session.send', async (_$, e) => {
      seen = { to: e.to, text: e.text }
      return { isDelivered: true }
    })
    const r = await $.session.send({ to: 'teammate', text: 'hello', origin: { kind: 'model' } })
    expect(r).toEqual({ isDelivered: true })
    expect(seen).toEqual({ to: 'teammate', text: 'hello' })
  })

  test("a turn.step's chunks and result pass through, the lead's and a subagent's", async ($, on) => {
    on('turn.step', async function* (_$, e) {
      yield { kind: 'text', index: 0, text: `engine ${e.agentId ?? 'main'}` }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: `engine ${e.agentId ?? 'main'}`, toolUses: [], stopReason: 'end_turn', usage: null }
    })
    for (const agentId of [undefined, 'agent-7']) {
      const s = $.turn.step({ turnId: 'turn-1', index: 0, model: 'test-model', messageCount: 1, ...(agentId ? { agentId } : {}) })
      const chunks: unknown[] = []
      let result: unknown
      for (;;) {
        const r = await s.next()
        if (r.done) {
          result = r.value
          break
        }
        chunks.push(r.value)
      }
      const who = agentId ?? 'main'
      expect(chunks).toEqual([
        { kind: 'text', index: 0, text: `engine ${who}` },
        { kind: 'stop', stopReason: 'end_turn', usage: null },
      ])
      expect(result).toEqual(expect.objectContaining({ turnId: 'turn-1', answer: `engine ${who}`, stopReason: 'end_turn' }))
    }
  })

  test('a turn.start passes on', async ($, on) => {
    let reached = false
    on('turn.start', async (_$, e) => {
      reached = true
      return { turnId: e.turnId }
    })
    expect(await $.turn.start({ text: 'hi', turnId: 'turn-2' })).toEqual({ turnId: 'turn-2' })
    expect(reached).toBe(true)
  })

  test('agent.offer passes a role and another type on, and offers no litter:sw-* type', async ($, on) => {
    let reached: string[] = []
    on('agent.offer', async (_$, e) => {
      reached.push(e.agent)
      return { isOffered: true }
    })
    expect(await $.agent.offer({ agent: 'litter:executor', ...OFFER })).toEqual({ isOffered: true })
    expect(await $.agent.offer({ agent: 'Explore', ...OFFER })).toEqual({ isOffered: true })
    expect(await $.agent.offer({ agent: 'litter:sw-alpha-fixer', ...OFFER })).toEqual({ isOffered: false })
    expect(reached).toEqual(['litter:executor', 'Explore'])
  })

  test('a /clear reaches the engine', async ($, on) => {
    mock.store(on)
    let reached = false
    on('command.run', { command: 'clear' }, async () => {
      reached = true
      return { text: 'engine cleared' }
    })
    const r = await $.command.run({ command: 'clear', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    expect(r).toEqual(expect.objectContaining({ text: 'engine cleared' }))
    expect(reached).toBe(true)
  })

  test('each swarm tool is answered by the mod and never passed on', async ($, on) => {
    mock.store(on)
    let reached = 0
    const tools = ['mcp__litter__swarm_propose', 'mcp__litter__swarm_read', 'mcp__litter__swarm_send'] as const
    for (const tool of tools) {
      on('tool.call', { tool }, async () => {
        reached++
        return { result: 'engine' }
      })
    }
    for (const tool of tools) {
      const r = await $.tool.call({ tool, tool_use_id: `t-${tool}`, swarm: 'alpha' })
      expect(parse(r)).toEqual(expect.objectContaining({ ok: false, error: expect.stringContaining('litter: ') }))
    }
    expect(reached).toBe(0)
  })

  test("the record tool refuses a mod kind (swarm.start) naming kind, and reaches swarm.end's handler", async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 5_000 })
    world(on)
    on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
    on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
    on('session.id', async () => ({ value: 'tier1-session' }))
    on('ui.log', async () => ({ value: undefined }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const start = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 'r1', kind: 'swarm.start', swarm: 'alpha' }))
    expect(start).toEqual(expect.objectContaining({ ok: false, field: 'kind', error: "litter: 'swarm.start' is recorded by litter itself, never through this tool" }))
    const end = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 'r2', kind: 'swarm.end', swarm: 'alpha' }))
    expect(end).toEqual(expect.objectContaining({ ok: false, field: 'swarm', error: "litter: there's no live swarm named alpha" }))
  })
})
