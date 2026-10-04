// Tier 2: agentLive (hooks/ports.ts), the one test of whether a listed agent
// is still alive. 2.1.289's $.agent.list() status is AgentStatus: `waiting`
// (mid-turn on Agent calls alone, or ended but holding background work) and
// `pending` are alive like `running`; `idle` is between turns, and the rest
// have ended.

import { describe, expect, test } from 'bun:test'
import type { AgentStatus } from '../../hooks/ports'
import { agentLive } from '../../hooks/ports'

describe('agentLive', () => {
  test('running, waiting and pending are alive', () => {
    for (const s of ['running', 'waiting', 'pending'] as const) expect(agentLive(s)).toBe(true)
  })

  test('idle, completed, failed and killed are not', () => {
    for (const s of ['idle', 'completed', 'failed', 'killed'] as const) expect(agentLive(s)).toBe(false)
  })

  test('every AgentStatus is decided', () => {
    const all: Record<AgentStatus, boolean> = { pending: true, running: true, waiting: true, idle: false, completed: false, failed: false, killed: false }
    for (const [s, live] of Object.entries(all)) expect(agentLive(s as AgentStatus)).toBe(live)
  })
})
