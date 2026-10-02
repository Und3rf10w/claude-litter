// Tier 2: the fifteen roles (plan section 6) as registered with
// $.agent.register: each spec's fields, and the names that fail to register.

import { describe, expect, test } from 'bun:test'
import type { AgentSpec } from '../../hooks/ports'
import { ROLE_PROMPTS } from '../../hooks/prompts/index'
import { isRoleName, registerRoles, ROLE_NAMES, ROLE_POLICIES, ROLE_TOOLS, roleSpec } from '../../hooks/roles'
import { nodePorts } from './support/node-ports'

const RECORD = 'mcp__litter__record'

describe('the role table', () => {
  test('fifteen roles, the same names in the policies, the tools and the prompts', () => {
    expect(ROLE_NAMES).toHaveLength(15)
    expect(Object.keys(ROLE_TOOLS).sort()).toEqual([...ROLE_NAMES].sort())
    expect(Object.keys(ROLE_PROMPTS).sort()).toEqual([...ROLE_NAMES].sort())
    expect(isRoleName('gate-critic')).toBe(true)
    expect(isRoleName('litter:gate-critic')).toBe(false)
    expect(isRoleName('toString')).toBe(false)
  })

  test('only the clamped roles go without the record tool', () => {
    const without = ROLE_NAMES.filter(r => !ROLE_TOOLS[r].includes(RECORD)).sort()
    expect(without).toEqual(['adversary', 'researcher'])
  })

  test('write tools only where the guard allows writes', () => {
    for (const r of ROLE_NAMES) {
      const writes = ROLE_TOOLS[r].some(t => t === 'Write' || t === 'Edit')
      expect(writes).toBe(ROLE_POLICIES[r].write !== 'none')
    }
    expect(ROLE_TOOLS.relay).toEqual([RECORD])
  })
})

describe('roleSpec', () => {
  test("each spec: name, the listing line, tools, auto, and no model", () => {
    for (const r of ROLE_NAMES) {
      const spec = roleSpec(r)
      expect(spec.name).toBe(r)
      expect(spec.description).toContain('Spawned by litter workflows only')
      expect(spec.prompt).toBe(ROLE_PROMPTS[r])
      expect(spec.tools).toEqual([...ROLE_TOOLS[r]])
      expect(spec.permissionMode).toBe('auto')
      expect('model' in spec).toBe(false)
      expect('effort' in spec).toBe(false)
    }
  })

  test('only the isolated role runs in its own worktree', () => {
    for (const r of ROLE_NAMES) expect(roleSpec(r).isolation).toBe(ROLE_POLICIES[r].isolated ? 'worktree' : undefined)
    expect(roleSpec('prober').isolation).toBe('worktree')
  })
})

describe('registerRoles', () => {
  test('registers all fifteen', async () => {
    const p = nodePorts()
    const seen: AgentSpec[] = []
    p.registerAgent = async spec => void seen.push(spec)
    expect(await registerRoles(p)).toEqual({ failed: [] })
    expect(seen.map(s => s.name).sort()).toEqual([...ROLE_NAMES].sort())
  })

  test('a role the engine refuses is returned with the reason, and the rest still register', async () => {
    const p = nodePorts()
    const seen: string[] = []
    p.registerAgent = async spec => {
      if (spec.name === 'relay') throw new Error('refused by policy')
      if (spec.name === 'planner') throw 'plain string'
      seen.push(spec.name)
    }
    const { failed } = await registerRoles(p)
    expect(failed).toEqual([
      { role: 'relay', reason: 'refused by policy' },
      { role: 'planner', reason: 'plain string' },
    ])
    expect(seen).toHaveLength(13)
  })
})
