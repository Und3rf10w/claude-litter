// One exported template string per role, ported from docs/litter-prompts.md.
// Owner: phase 1b, work package B. The static prompt checks (plan section 12)
// run over every export here: no backtick, no `${`, no model named, and the
// tags each names.

import type { RoleName } from '../hookfiles'
import { adversary } from './adversary'
import { author } from './author'
import { coverage } from './coverage'
import { designCritic } from './design-critic'
import { executor } from './executor'
import { falsifier } from './falsifier'
import { gateCritic } from './gate-critic'
import { mechanism } from './mechanism'
import { planner } from './planner'
import { prober } from './prober'
import { reframer } from './reframer'
import { relay } from './relay'
import { researcher } from './researcher'
import { verifier } from './verifier'

/**
 * The tag contract between workflows/*.js and these prompts (litter-prompts.md,
 * "Tag contract"). The doc puts the list in types/index.d.ts, which is the
 * $.state contract, so it's kept here until it moves. `changed` is missing
 * from the doc's list but is in its fanout table and the verifier's prompt.
 * The design tags are plan 7a's envelope (phase 4); design.js's `task` is the
 * call's instruction, where execute's and fanout's is a task's data.
 */
export const PROMPT_TAGS = [
  'gate', 'task', 'contract', 'authorized', 'verify', 'rules', 'feedback', 'change', 'adversary',
  'where', 'base', 'tasks', 'changed', 'goal', 'goal_check', 'plan', 'landed', 'halted',
  'bar', 'anchors', 'material', 'proposal', 'delta', 'prior_verdict', 'template',
] as const

export type PromptTag = (typeof PROMPT_TAGS)[number]

/** Plan 7a's envelope, which every design call carries: then its own tags, and last its task. */
const DESIGN_ENVELOPE = ['goal', 'bar', 'rules', 'anchors', 'material', 'task'] as const

/**
 * The tags each role's calls carry (plan section 7's execute.js sketch and
 * 7a's design envelope; litter-prompts.md's fanout.js table and design
 * roles). Its prompt names every one: a design role's through SHARED_CORE.
 */
export const ROLE_TAGS: Readonly<Record<RoleName, readonly PromptTag[]>> = {
  falsifier: [...DESIGN_ENVELOPE],
  coverage: [...DESIGN_ENVELOPE],
  mechanism: [...DESIGN_ENVELOPE],
  prober: [...DESIGN_ENVELOPE],
  reframer: [...DESIGN_ENVELOPE, 'proposal'],
  author: [...DESIGN_ENVELOPE, 'proposal', 'prior_verdict', 'template', 'feedback'],
  'design-critic': [...DESIGN_ENVELOPE, 'proposal', 'delta', 'prior_verdict'],
  executor: ['gate', 'task', 'contract', 'authorized', 'verify', 'rules', 'feedback'],
  'gate-critic': ['gate', 'authorized', 'verify', 'rules', 'change', 'adversary', 'feedback'],
  adversary: ['gate', 'authorized', 'verify', 'rules', 'change'],
  relay: [],
  planner: ['goal', 'plan', 'verify', 'goal_check', 'rules', 'landed', 'halted'],
  verifier: ['where', 'base', 'tasks', 'changed', 'contract', 'rules'],
  researcher: ['task', 'contract', 'authorized', 'rules'],
}

export const ROLE_PROMPTS: Readonly<Record<RoleName, string>> = {
  falsifier,
  coverage,
  mechanism,
  reframer,
  prober,
  author,
  'design-critic': designCritic,
  'gate-critic': gateCritic,
  executor,
  adversary,
  relay,
  planner,
  verifier,
  researcher,
}
