// Tier 1: the mod loaded by the engine itself (`claude plugin test`). These
// pin the wiring: which hooks answer, and what a catch refuses. Each package
// adds its own *.test.ts beside this one for what only the engine can show;
// everything else is a tier-2 *.spec.ts under tests/unit/.

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
