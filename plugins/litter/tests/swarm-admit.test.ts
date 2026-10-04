// Tier 1: the spawn check, admission and swarm_send (WP-L), wired in the
// engine itself. A test here can't reach the mod's module memory, and only
// K's Launch or recovery puts a live swarm there, so these pin what holds
// with nothing live: mcp__litter__swarm_send answered by the mod with its
// reply as JSON in `result`, swarm.bind's refusal through the record tool,
// and every other loop's turn.step, session.send and agent.spawn passing to
// the engine as they came. A node's refusals (its turn.step stream and
// result, a send's `{ isDelivered: false }`, a spawn's `{ deny }` and the
// rewrite) are tier 2 (tests/unit/admit.spec.ts, spawn.spec.ts).

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const SPAWN = {
  tool_use_id: 'tu-admit',
  prompt: 'do it',
  description: 'test spawn',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'test-model',
  background: false,
  fork: false,
} as const

const parse = (r: { result?: unknown }) => JSON.parse(String(r.result)) as Record<string, unknown>

/**
 * session.start's litter directory at /repo/.claude/litter: a plain checkout, files in memory (as wiring.test.ts's world).
 * `sid` is read at each session.id; `register` runs before each agent.register answers.
 */
function world(on: On, opts: { sid?: { value: string }; register?: () => Promise<void> } = {}): void {
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
    return { value: [...names].map(name => ({ name, kind: files.has(`${e.path}/${name}`) ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false })) }
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
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => {
    await opts.register?.()
    return { value: { agent: `litter:${e.name}` } }
  })
  on('session.id', async () => ({ value: opts.sid?.value ?? 'tier1-session' }))
  on('ui.log', async () => ({ value: undefined }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
}

describe('mcp__litter__swarm_send', () => {
  test("it's answered by the mod, its reply JSON in result, and never passed on", async ($, on) => {
    mock.store(on)
    let reached = 0
    on('tool.call', { tool: 'mcp__litter__swarm_send' }, async () => {
      reached++
      return { result: 'engine' }
    })
    const lead = await $.tool.call({ tool: 'mcp__litter__swarm_send', tool_use_id: 's1', node: 'fixer', text: 'hi' })
    expect(parse(lead)).toEqual({ ok: false, error: 'litter: this session has no litter directory, so no swarm is live in it' })
    const node = await $.tool.call({ tool: 'mcp__litter__swarm_send', tool_use_id: 's2', agentId: 'agent-7', node: 'fixer', text: 'hi' })
    expect(parse(node)).toEqual({ ok: false, error: "litter: mcp__litter__swarm_send is the lead's alone; a node sends with SendMessage" })
    expect(reached).toBe(0)
  })

  test('with a litter directory and nothing live, it names what is missing', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 5_000 })
    world(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const r = await $.tool.call({ tool: 'mcp__litter__swarm_send', tool_use_id: 's3', node: 'fixer', text: 'hi' })
    expect(parse(r)).toEqual({ ok: false, error: "litter: no live swarm has a node 'fixer'" })
    const q = await $.tool.call({ tool: 'mcp__litter__swarm_send', tool_use_id: 's4', queued: 'q1234abcd' })
    expect(parse(q)).toEqual({ ok: false, error: "litter: no message is queued as 'q1234abcd': it was delivered or cancelled" })
  })
})

describe('swarm.bind through the record tool', () => {
  test('an agent the engine lists as no swarm node is refused, naming kind', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 5_000 })
    world(on)
    on('agent.list', async () => ({ value: [{ id: 'agent-9', description: 'a helper', type: 'general-purpose', status: 'running' }] }))
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const r = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 'b1', agentId: 'agent-9', kind: 'swarm.bind', token: '1'.repeat(32) }))
    expect(r).toEqual({
      ok: false,
      field: 'kind',
      error: "litter: 'swarm.bind' is for a swarm node with no binding, and this agent (general-purpose) isn't one",
    })
  })

  test("when the agent list can't be read, the record tool's catch refuses, naming the hook", async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 5_000 })
    world(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const r = await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 'b2', agentId: 'agent-9', kind: 'swarm.bind', token: '1'.repeat(32) })
    expect(r.deny).toContain('litter guard failed: mcp__litter__record')
  })
})

describe('with nothing live, every other loop passes to the engine as it came', () => {
  test("a subagent's and the lead's turn.step pass through, every index, chunks and result", async ($, on) => {
    on('turn.step', async function* (_$, e) {
      yield { kind: 'text', index: 0, text: `engine ${e.agentId ?? 'main'} ${e.index}` }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: `engine ${e.agentId ?? 'main'} ${e.index}`, toolUses: [], stopReason: 'end_turn', usage: null }
    })
    for (const agentId of [undefined, 'agent-7']) {
      for (const index of [0, 1]) {
        const s = $.turn.step({ turnId: 'turn-1', index, model: 'test-model', messageCount: 1, ...(agentId ? { agentId } : {}) })
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
        const text = `engine ${agentId ?? 'main'} ${index}`
        expect(chunks).toEqual([
          { kind: 'text', index: 0, text },
          { kind: 'stop', stopReason: 'end_turn', usage: null },
        ])
        expect(result).toEqual({ turnId: 'turn-1', index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null })
      }
    }
  })

  test('a SendMessage from a subagent to main, and to another agent, reaches the engine unchanged', async ($, on) => {
    const seen: { to: string; text: string; agentId?: string }[] = []
    on('session.send', async (_$, e) => {
      seen.push({ to: e.to, text: e.text, ...(e.agentId ? { agentId: e.agentId } : {}) })
      return { isDelivered: true }
    })
    expect(await $.session.send({ to: 'main', text: 'report', origin: { kind: 'model' }, agentId: 'agent-7' })).toEqual({ isDelivered: true })
    expect(await $.session.send({ to: 'agent-8', text: 'hello', origin: { kind: 'model' }, agentId: 'agent-7' })).toEqual({ isDelivered: true })
    expect(seen).toEqual([
      { to: 'main', text: 'report', agentId: 'agent-7' },
      { to: 'agent-8', text: 'hello', agentId: 'agent-7' },
    ])
  })

  test("a spawn no swarm governs reaches the engine with the caller's parameters", async ($, on) => {
    mock.store(on)
    let seen: { cwd?: string; background?: boolean; prompt?: string; model?: string } | null = null
    on('agent.spawn', async (_$, e) => {
      seen = { cwd: e.cwd, background: e.background, prompt: e.prompt, model: e.model }
      return { model: 'test-model', agentId: 'agent-new' }
    })
    const r = await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose', parentAgentId: 'agent-7', cwd: '/repo/sub' })
    expect(r).toEqual({ model: 'test-model', agentId: 'agent-new' })
    expect(seen).toEqual({ cwd: '/repo/sub', background: false, prompt: 'do it', model: undefined })
  })

  // 2.1.289 runs agent.spawn for teammates: one litter has no stake in waits on no rebind (spawn.ts, outsideTeammate).
  test("an outside teammate's spawn reaches the engine at once while a /clear's rebind holds the gate closed", async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on, { now: 5_000 })
    const sid = { value: 'tier1-a' }
    let hold = false
    let held = 0
    world(on, {
      sid,
      register: async () => {
        if (!hold) return
        held++
        await clock.sleep(1_000)
      },
    })
    on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
    const spawned: string[] = []
    on('agent.spawn', async (_$, e) => {
      spawned.push(e.tool_use_id)
      return { model: 'test-model', agentId: `agent-${e.tool_use_id}` }
    })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })

    // The engine's clear, then the new id: the next hook starts the rebind, which closes the gate and is held here
    // at its roles' registration.
    await $.session.end({ reason: 'clear', sessionId: 'tier1-a', resume: { id: 'tier1-a' } })
    sid.value = 'tier1-b'
    hold = true
    const first = $.agent.spawn({ ...SPAWN, tool_use_id: 'tu-first', subagentType: 'general-purpose' })
    await clock.settle()
    expect(held).toBeGreaterThan(0)
    hold = false

    let mate: unknown = null
    void $.agent.spawn({ ...SPAWN, tool_use_id: 'tu-mate', subagentType: 'general-purpose', name: 'scout', isTeammate: true, background: true }).then(r => {
      mate = r
    })
    await clock.settle()
    expect(mate).toEqual({ model: 'test-model', agentId: 'agent-tu-mate' })
    expect(spawned).toEqual(['tu-mate'])

    // The rebind goes on, and the spawn that started it reaches the engine after it.
    await clock.advance(1_000)
    expect(await first).toEqual({ model: 'test-model', agentId: 'agent-tu-first' })
    expect(spawned).toEqual(['tu-mate', 'tu-first'])
  })

  test("the lead's turn.start and turn.complete pass on", async ($, on) => {
    mock.store(on)
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    expect(await $.turn.start({ text: 'hi', turnId: 'turn-3' })).toEqual({ turnId: 'turn-3' })
    expect(await $.turn.complete({ turnId: 'turn-3', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })).toEqual(
      expect.objectContaining({ text: 'done' }),
    )
  })
})
