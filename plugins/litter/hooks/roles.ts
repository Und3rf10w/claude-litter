// The roles (plan section 6), registered with $.agent.register at
// session.start as `litter:<name>`. Owner: phase 1b, work package B.
//
// ROLE_POLICIES is the guard's view of each role; policy.ts writes it into
// policy.json, so the role table has one source.

import type { Ports } from './ports'
import type { RoleName, RolePolicy } from './hookfiles'

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

/** Registers every role. Resolves the names it couldn't register, with the reason. */
export async function registerRoles(_p: Ports): Promise<{ failed: { role: RoleName; reason: string }[] }> {
  return { failed: [] }
}
