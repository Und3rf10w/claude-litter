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
import { integrator } from './integrator'
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
 */
export const PROMPT_TAGS = [
  'gate', 'task', 'contract', 'authorized', 'verify', 'rules', 'feedback', 'change', 'adversary',
  'where', 'base', 'conflict', 'tasks', 'changed', 'integrator', 'goal', 'goal_check', 'plan', 'landed', 'halted',
] as const

export type PromptTag = (typeof PROMPT_TAGS)[number]

/**
 * The tags each execute and fanout role's calls carry (plan section 7's
 * execute.js sketch; litter-prompts.md's fanout.js table). Its prompt names
 * every one. The design roles' calls use section 7a's design tags, which their
 * prompts describe in prose.
 */
export const ROLE_TAGS: Readonly<Partial<Record<RoleName, readonly PromptTag[]>>> = {
  executor: ['gate', 'task', 'contract', 'authorized', 'verify', 'rules', 'feedback'],
  'gate-critic': ['gate', 'authorized', 'verify', 'rules', 'change', 'adversary', 'feedback'],
  adversary: ['gate', 'authorized', 'verify', 'rules', 'change'],
  relay: [],
  integrator: ['where', 'conflict', 'tasks', 'contract', 'rules', 'authorized'],
  planner: ['goal', 'plan', 'verify', 'goal_check', 'rules', 'landed', 'halted'],
  verifier: ['where', 'base', 'tasks', 'changed', 'contract', 'rules', 'integrator'],
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
  integrator,
  planner,
  verifier,
  researcher,
}
