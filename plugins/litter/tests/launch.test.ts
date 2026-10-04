// Tier 1: the launch check, the spawn block and their catches, wired in the
// engine itself. No session.start resolves a litter directory here, so these
// pin what holds without one: the refusals for every caller, the passes for
// other plugins' workflows, and what a catch refuses when the hook throws (an
// unmocked store or file read). The args swap and run.launch are tier 2
// (tests/unit/launch.spec.ts), which needs a litter directory.

import { describe, expect, mock, test } from 'claude-code/testing'

const SPAWN = {
  tool_use_id: 'tu-spawn',
  prompt: 'do it',
  description: 'test spawn',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'test-model',
  background: false,
  fork: false,
} as const

describe('the Workflow launch check', () => {
  test("'script' with 'name' or 'scriptPath' is refused for every caller", async ($, on) => {
    mock.store(on)
    let reached = 0
    on('tool.call', { tool: 'Workflow' }, async () => {
      reached++
      return { result: 'engine' }
    })
    const named = await $.tool.call({ tool: 'Workflow', tool_use_id: 'w1', script: 'export const meta = {}', name: 'mine' })
    expect(named.deny).toContain("can't set 'script'")
    const pathed = await $.tool.call({ tool: 'Workflow', tool_use_id: 'w2', script: 'export const meta = {}', scriptPath: '/tmp/x.js' })
    expect(pathed.deny).toContain("can't set 'script'")
    expect(reached).toBe(0)
  })

  test("another plugin's named workflow and a plain script reach the engine", async ($, on) => {
    mock.store(on)
    on('tool.call', { tool: 'Workflow' }, async () => ({ result: 'engine' }))
    expect((await $.tool.call({ tool: 'Workflow', tool_use_id: 'w3', name: 'deepwork:run' })).result).toBe('engine')
    expect((await $.tool.call({ tool: 'Workflow', tool_use_id: 'w4', script: 'export const meta = {}' })).result).toBe('engine')
  })

  test('a litter workflow with no litter directory is refused', async ($, on) => {
    mock.store(on)
    on('tool.call', { tool: 'Workflow' }, async () => ({ result: 'engine' }))
    const r = await $.tool.call({ tool: 'Workflow', tool_use_id: 'w5', name: 'litter:execute', args: { run: '20261002-execute-abcdef' } })
    expect(r.deny).toContain('no litter directory')
  })

  test('an unknown litter workflow is refused by name', async ($, on) => {
    mock.store(on)
    on('tool.call', { tool: 'Workflow' }, async () => ({ result: 'engine' }))
    const r = await $.tool.call({ tool: 'Workflow', tool_use_id: 'w6', name: 'litter:nope' })
    expect(r.deny).toContain("no litter workflow 'litter:nope'")
  })

  test('refused tools refuse every litter launch, naming allowedMcpServers', async ($, on) => {
    mock.store(on)
    on('tool.register', async () => ({ deny: 'mcp__litter__record is not in allowedMcpServers' }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    on('tool.call', { tool: 'Workflow' }, async () => ({ result: 'engine' }))
    await $.session.start({ cwd: '/nonexistent/litter-test', surface: null, isInteractive: false })
    const r = await $.tool.call({ tool: 'Workflow', tool_use_id: 'w7', name: 'litter:design', args: { run: 'x' } })
    expect(r.deny).toContain("the mod's tools were refused")
    expect(r.deny).toContain('allowedMcpServers')
    // Not anyone else's.
    expect((await $.tool.call({ tool: 'Workflow', tool_use_id: 'w8', name: 'deepwork:run' })).result).toBe('engine')
  })

  test('when the hook throws, the catch refuses a wf_ resume and a scriptPath, and passes another resume', async ($, on) => {
    // No mock.store and no file to read: the store read and the script read throw.
    on('tool.call', { tool: 'Workflow' }, async () => ({ result: 'engine' }))
    const resume = await $.tool.call({ tool: 'Workflow', tool_use_id: 'w9', name: 'litter:execute', resumeFromRunId: 'wf_abc123' })
    expect(resume.deny).toContain('litter guard failed: Workflow')
    const plainWf = await $.tool.call({ tool: 'Workflow', tool_use_id: 'w10', resumeFromRunId: 'wf_abc123' })
    expect(plainWf.deny).toContain('litter guard failed: Workflow')
    const byPath = await $.tool.call({ tool: 'Workflow', tool_use_id: 'w11', scriptPath: '/nonexistent/litter-test/x.js' })
    expect(byPath.deny).toContain('litter guard failed: Workflow')
    expect((await $.tool.call({ tool: 'Workflow', tool_use_id: 'w12', resumeFromRunId: 'run-123' })).result).toBe('engine')
  })
})

describe('the agent.spawn block', () => {
  test("the main thread is refused a litter role; a subagent's spawn of one, a swarm type and others pass", async ($, on) => {
    mock.store(on)
    on('agent.spawn', async () => ({ model: 'test-model', agentId: 'agent-new' }))
    const main = await $.agent.spawn({ ...SPAWN, subagentType: 'litter:executor' })
    expect(main.deny).toContain('litter roles run inside litter workflows only')
    const nested = await $.agent.spawn({ ...SPAWN, subagentType: 'litter:executor', parentAgentId: 'agent-parent' })
    expect(nested.deny).toBeUndefined()
    expect(nested.agentId).toBe('agent-new')
    expect((await $.agent.spawn({ ...SPAWN, subagentType: 'litter:sw-worker' })).deny).toBeUndefined()
    expect((await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose' })).deny).toBeUndefined()
  })

  // 2.1.289 runs agent.spawn for a teammate (isTeammate, background): the fast path past the waits skips no refusal.
  test("a main-thread teammate of a litter role is refused the same; an outside teammate passes", async ($, on) => {
    mock.store(on)
    on('agent.spawn', async () => ({ model: 'test-model', agentId: 'agent-new' }))
    const mate = { ...SPAWN, name: 'mate', isTeammate: true, background: true } as const
    expect((await $.agent.spawn({ ...mate, subagentType: 'litter:executor' })).deny).toContain('litter roles run inside litter workflows only')
    expect(await $.agent.spawn({ ...mate, subagentType: 'general-purpose' })).toEqual({ model: 'test-model', agentId: 'agent-new' })
  })
})
