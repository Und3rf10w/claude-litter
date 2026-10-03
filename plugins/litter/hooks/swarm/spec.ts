// WP-J: what a spec is and when it's valid: the schema, every 15.3 rule, and
// the tree's shape (depth, peak, and each writing template's instances).
//
// Stub (phase 2b-1, package C): the signatures are the contract; the bodies are J's.

import type { Ports } from '../ports'
import type { InstancePlan, SpecCheck, SpecError, SwarmSpec, TreeShape, ValidateCtx } from './types'

const notBuilt = (name: string): Error => new Error(`litter: ${name} is not built yet (WP-J)`)

/** The schema first, then every 15.3 rule, each error naming the node and the field. Every error, never the first only. */
export async function validateSpec(p: Ports, spec: unknown, ctx: ValidateCtx): Promise<SpecCheck> {
  throw notBuilt('validateSpec')
}

/** The schema alone: types, required fields, known keys only, the patterns and the value sets. */
export function specSchemaErrors(spec: unknown): SpecError[] {
  throw notBuilt('specSchemaErrors')
}

/** Each node's depth (the lead is 0), and the peak (15.7). */
export function treeShape(spec: SwarmSpec): TreeShape {
  throw notBuilt('treeShape')
}

/** Each writing template expanded per parent, with the directory each instance would get. */
export function instancesOf(spec: SwarmSpec): InstancePlan[] {
  throw notBuilt('instancesOf')
}
