// Record bodies for design runs, plans and the rest of the kinds the record
// tool validates itself (plan section 9, "The record kinds"). Owner: phase 1b,
// work package B. Design runs are phase 4: in phase 1 these kinds are
// validated loosely and stored, so the tool's error shape and bounds are
// exercised end to end.

import type { RecordHandler } from './core'
import { notYet } from './core'

/** Every kind the record tool knows, in its canonical spelling. `kind` matches case-insensitively. */
export const KNOWN_KINDS = [
  // design
  'finding', 'coverage', 'mechanism', 'probe', 'reframe', 'proposal', 'verdict', 'design.feedback',
  // execute
  'verify', 'land.intent', 'land', 'land.abandoned', 'land.blocked', 'rule.propose',
  // fanout (phase 2)
  'task.bind',
  // the run lock
  'lock.recovered', 'lock.forced',
  // launchers and the mod's own
  'run.start', 'run.launch', 'run.resume', 'run.stopping', 'run.end',
  'worktree.intent', 'worktree.create', 'worktree.setup_failed',
  'plan.write', 'gate.amend', 'wiki.write',
  // read-only
  'run.find',
] as const

export type KnownKind = (typeof KNOWN_KINDS)[number]

/** Kinds only the mod writes; a call from an agent or the launcher is refused (run.end has the launcher fallback). */
export const MOD_ONLY_KINDS: readonly KnownKind[] = [
  'land.intent', 'land.abandoned', 'land.blocked', 'run.launch', 'run.resume', 'run.stopping',
  'lock.recovered', 'lock.forced', 'worktree.intent', 'worktree.create', 'worktree.setup_failed',
]

/** The kinds the record tool validates and stores itself. */
export const recordGeneric: RecordHandler = async (_ctx, input) => notYet(input.kind, '1b')
