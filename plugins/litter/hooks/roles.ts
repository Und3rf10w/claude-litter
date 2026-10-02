// The roles (plan section 6), registered with $.agent.register at
// session.start as `litter:<name>`. Owner: phase 1b, work package B.
//
// ROLE_POLICIES is the guard's view of each role; policy.ts writes it into
// policy.json, so the role table has one source. ROLE_TOOLS is the section 6
// table's Tools column. No role names a model: section 6 mentions a per-role
// `model` option, but section 10's option list has none, so every role runs on
// the session's model until one exists.

import type { AgentSpec, Ports } from './ports'
import type { RoleName, RolePolicy } from './hookfiles'
import { ROLE_PROMPTS } from './prompts/index'

export const ROLE_POLICIES: Record<RoleName, RolePolicy> = {
  falsifier: { write: 'none', bash: 'ro', isolated: false },
  coverage: { write: 'none', bash: 'ro', isolated: false },
  mechanism: { write: 'none', bash: 'ro', isolated: false },
  reframer: { write: 'none', bash: 'ro', isolated: false },
  prober: { write: 'own-worktree', bash: 'rw', isolated: true },
  author: { write: 'none', bash: 'ro', isolated: false },
  'design-critic': { write: 'none', bash: 'ro', isolated: false },
  'gate-critic': { write: 'none', bash: 'ro', isolated: false },
  executor: { write: 'checkout', bash: 'rw', isolated: false },
  adversary: { write: 'none', bash: 'ro', isolated: false },
  relay: { write: 'none', bash: 'ro', isolated: false },
  integrator: { write: 'integration', bash: 'rw', isolated: false },
  planner: { write: 'none', bash: 'ro', isolated: false },
  verifier: { write: 'none', bash: 'ro', isolated: false },
  researcher: { write: 'none', bash: 'ro', isolated: false },
}

export const ROLE_NAMES = Object.keys(ROLE_POLICIES) as RoleName[]

export const isRoleName = (name: string): name is RoleName => Object.hasOwn(ROLE_POLICIES, name)

const RECORD = 'mcp__litter__record'
const READ = ['Read', 'Grep', 'Glob']

/**
 * Section 6's Tools column. "Bash (read-only)" is Bash here: the guard's `ro`
 * rules (ROLE_POLICIES) and, for the adversary and researcher, the script's
 * bashCommandClamp make it read-only. Those two never record, because a clamp
 * drops every mcp__ tool (section 9, "Guard").
 */
export const ROLE_TOOLS: Readonly<Record<RoleName, readonly string[]>> = {
  falsifier: [...READ, 'Bash', RECORD],
  coverage: [...READ, 'Bash', RECORD],
  mechanism: [...READ, 'Bash', RECORD],
  reframer: [...READ, 'Bash', RECORD],
  prober: [...READ, 'Bash', 'Write', RECORD],
  author: [...READ, RECORD],
  'design-critic': [...READ, 'Bash', RECORD],
  'gate-critic': [...READ, 'Bash', RECORD],
  executor: [...READ, 'Edit', 'Write', 'Bash', RECORD],
  adversary: [...READ, 'Bash'],
  relay: [RECORD],
  integrator: [...READ, 'Edit', 'Bash', RECORD],
  planner: [...READ, RECORD],
  verifier: [...READ, 'Bash', RECORD],
  researcher: [...READ, 'Bash'],
}

/** Section 6's "Used in" column, for the listing line. */
const USED_IN: Readonly<Record<RoleName, string>> = {
  falsifier: 'design runs',
  coverage: 'design runs',
  mechanism: 'design runs',
  reframer: 'design runs',
  prober: 'design runs',
  author: 'design runs',
  'design-critic': 'design runs',
  'gate-critic': 'execute runs',
  executor: 'execute and fanout runs',
  adversary: 'execute runs',
  relay: 'execute and fanout runs',
  integrator: 'fanout runs',
  planner: 'litter:plan runs',
  verifier: 'fanout runs',
  researcher: 'fanout runs',
}

/**
 * The spec for one role. The listing still shows every role (agent.offer must
 * not hide them, section 6), so the description says who spawns it.
 */
export function roleSpec(role: RoleName): AgentSpec {
  const spec: AgentSpec = {
    name: role,
    description: `litter ${role} role (${USED_IN[role]}). Spawned by litter workflows only; don't spawn it yourself.`,
    prompt: ROLE_PROMPTS[role],
    tools: ROLE_TOOLS[role],
    permissionMode: 'auto',
  }
  if (ROLE_POLICIES[role].isolated) spec.isolation = 'worktree'
  return spec
}

/** Registers every role. Resolves the names it couldn't register, with the reason. */
export async function registerRoles(p: Ports): Promise<{ failed: { role: RoleName; reason: string }[] }> {
  const results = await Promise.allSettled(ROLE_NAMES.map(role => p.registerAgent(roleSpec(role))))
  const failed: { role: RoleName; reason: string }[] = []
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      failed.push({ role: ROLE_NAMES[i]!, reason: r.reason instanceof Error ? r.reason.message : String(r.reason) })
    }
  })
  return { failed }
}
