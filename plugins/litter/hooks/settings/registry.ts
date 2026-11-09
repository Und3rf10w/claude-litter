// The run settings, one table for every place that shows, saves or applies
// one: the launch form and the Settings section draw their rows from it,
// run.start fills a launch's unset fields from it, and the role hooks
// (apply.ts) read its role half. A new setting is a row here, so no launch
// path is built again for it.
//
// Two halves. The run half is the launch's own fields (maxRounds, maxAttempts,
// adversary, widen, the repair budget), each for the workflows that take it.
// The role half is each litter role's model and effort, for the workflows
// that run that role: every workflow's agents get them, a design's lenses as
// much as an execute's executor.
//
// Where a value comes from, highest first: the launch (run.start's own field,
// or the launch form), this project's settings, yours, the plugin option,
// and the built-in default. A role's model and effort have no plugin option:
// unset, the role runs on the session's.

import type { RoleName } from '../hookfiles'
import type { Workflow } from '../records/run'
import type { Effort } from '../swarm/types'
import type { LitterOptions } from '../options'
import { REPAIR_AGENTS, REPAIR_ROUNDS } from '../options'

// ---------------------------------------------------------------------------
// The roles each workflow runs

/** The roles each workflow's script spawns (workflows/*.js, their `agentType`s). */
export const ROLES_OF: Readonly<Record<Workflow, readonly RoleName[]>> = {
  design: ['falsifier', 'coverage', 'mechanism', 'reframer', 'prober', 'author', 'design-critic'],
  execute: ['executor', 'gate-critic', 'adversary', 'relay'],
  fanout: ['executor', 'researcher', 'verifier', 'relay'],
  plan: ['planner'],
}

/** What each role does, in a few words, for the form's rows. */
export const ROLE_WORDS: Readonly<Record<RoleName, string>> = {
  falsifier: 'tries to break the hypothesis',
  coverage: 'looks for what was missed',
  mechanism: 'traces how it works',
  reframer: 'questions the goal',
  prober: 'runs the experiments',
  author: 'writes the proposal',
  'design-critic': 'judges each version',
  executor: 'does the work',
  'gate-critic': 'reviews each gate',
  adversary: 'tries to break each gate',
  relay: 'runs the verify and lands',
  planner: 'splits a goal into gates',
  verifier: 'checks the fanout',
  researcher: 'answers a read-only task',
}

/** Every role a workflow runs, each once, in the workflows' order: the Settings section's rows. */
export const ALL_ROLES: readonly RoleName[] = [...new Set((['design', 'plan', 'execute', 'fanout'] as const).flatMap(w => ROLES_OF[w]))]

/** The workflows a role runs in, for its row's note. */
export const workflowsOfRole = (role: RoleName): Workflow[] => (['design', 'plan', 'execute', 'fanout'] as const).filter(w => ROLES_OF[w].includes(role))

// ---------------------------------------------------------------------------
// Values

export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const isEffort = (v: unknown): v is Effort => typeof v === 'string' && (EFFORTS as readonly string[]).includes(v)

/** The aliases a spawn resolves (agent.spawn's `model`); a running agent's model is changed by a full id only (turn.step resolves none). */
export const MODEL_ALIASES: readonly string[] = ['haiku', 'sonnet', 'opus']

/** The full ids the selects offer beside the ones agents ran with (the swarm browser's too): turn.step resolves no alias. */
export const MODEL_CHOICES: readonly string[] = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5-20251001']

/** The models a launch's select offers: the aliases, then the full ids. */
export const MODEL_OPTIONS: readonly string[] = [...MODEL_ALIASES, ...MODEL_CHOICES]

/** A model as a setting takes it: an alias, or an id of letters, digits and `._:/-` with an optional `[1m]`-style suffix. */
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}(\[[0-9a-z]+\])?$/
export const isModel = (v: unknown): v is string => typeof v === 'string' && MODEL.test(v)
/** A full id, as turn.step takes it: not an alias, and with a `-`. */
export const isFullModel = (v: string): boolean => isModel(v) && !MODEL_ALIASES.includes(v) && v.includes('-')

/** One role's model and effort; either may be unset (the session's). */
export type RoleTune = { model?: string; effort?: Effort }
export type RoleTunes = Partial<Record<RoleName, RoleTune>>

/** A launch's or a file's role entry: a value, or null for "the session's" over a default. */
export type RoleTuneInput = { model?: string | null; effort?: Effort | null }

export type RunSettingKey = 'maxRounds' | 'maxAttempts' | 'adversary' | 'widen' | 'repair' | 'repairRounds' | 'repairAgents'
export type RunSettingValue = number | boolean | string
export type RunSettings = Partial<Record<RunSettingKey, RunSettingValue>>

export type Choice = { value: string; label: string }

/**
 * One run setting: its label, the workflows that take it, how it's edited
 * (a select of `choices`, or a whole number in `range`), and its value when
 * nothing set it (the plugin option's, else the built-in).
 */
export type RunSettingDef = {
  key: RunSettingKey
  label: string
  /** One line under it in the form. */
  words: string
  workflows: readonly Workflow[]
  kind: 'select' | 'number'
  choices?: readonly Choice[]
  range?: { min: number; max: number }
  /** The value when nothing set it, and where that comes from. */
  base: (o: LitterOptions) => { value: RunSettingValue; from: 'option' | 'builtin' }
}

const YES_NO: readonly Choice[] = [
  { value: 'true', label: 'yes' },
  { value: 'false', label: 'no' },
]

export const RUN_SETTINGS: readonly RunSettingDef[] = [
  {
    key: 'maxRounds',
    label: 'Design rounds',
    words: 'rounds before the run stops for you',
    workflows: ['design'],
    kind: 'number',
    range: { min: 1, max: 10 },
    base: o => ({ value: o.maxRounds, from: 'option' }),
  },
  {
    key: 'maxAttempts',
    label: 'Attempts per gate',
    words: 'executor attempts before the run halts',
    workflows: ['execute'],
    kind: 'number',
    range: { min: 1, max: 10 },
    base: o => ({ value: o.maxAttempts, from: 'option' }),
  },
  {
    key: 'adversary',
    label: 'Adversary',
    words: 'an adversary tries to break each gate before its critic',
    workflows: ['execute'],
    kind: 'select',
    choices: YES_NO,
    base: () => ({ value: false, from: 'builtin' }),
  },
  {
    key: 'widen',
    label: 'Files outside a gate',
    words: "ask: only you add files to a gate; critic: its critic may too, each listed for you",
    workflows: ['execute'],
    kind: 'select',
    choices: [
      { value: 'ask', label: 'ask' },
      { value: 'critic', label: 'critic' },
    ],
    base: o => ({ value: o.widen, from: 'option' }),
  },
  {
    key: 'repair',
    label: 'Repair',
    words: 'auto: a failed run continues as a repair swarm; off: it stops',
    workflows: ['execute', 'fanout'],
    kind: 'select',
    choices: [
      { value: 'auto', label: 'auto' },
      { value: 'off', label: 'off' },
    ],
    base: o => ({ value: o.repair, from: 'option' }),
  },
  {
    key: 'repairRounds',
    label: 'Repair rounds',
    words: "the repair swarm's rounds",
    workflows: ['execute', 'fanout'],
    kind: 'number',
    range: { min: REPAIR_ROUNDS.min, max: REPAIR_ROUNDS.max },
    base: o => ({ value: o.repairRounds, from: 'option' }),
  },
  {
    key: 'repairAgents',
    label: 'Repair agents',
    words: "the agents the repair swarm's nodes may spawn",
    workflows: ['execute', 'fanout'],
    kind: 'number',
    range: { min: REPAIR_AGENTS.min, max: REPAIR_AGENTS.max },
    base: o => ({ value: o.repairAgents, from: 'option' }),
  },
]

export const RUN_SETTING_KEYS: readonly RunSettingKey[] = RUN_SETTINGS.map(d => d.key)
export const runSettingDef = (key: string): RunSettingDef | undefined => RUN_SETTINGS.find(d => d.key === key)
export const settingsOf = (workflow: Workflow): RunSettingDef[] => RUN_SETTINGS.filter(d => d.workflows.includes(workflow))

/** A run setting's value checked against its def: the value, or why not. */
export function checkRunValue(def: RunSettingDef, v: unknown): { ok: true; value: RunSettingValue } | { ok: false; error: string } {
  if (def.kind === 'number') {
    const r = def.range!
    if (typeof v !== 'number' || !Number.isInteger(v) || v < r.min || v > r.max) return { ok: false, error: `${def.key} is a whole number from ${r.min} to ${r.max}` }
    return { ok: true, value: v }
  }
  const choices = def.choices!.map(c => c.value)
  if (choices.includes('true')) {
    if (typeof v !== 'boolean') return { ok: false, error: `${def.key} is true or false` }
    return { ok: true, value: v }
  }
  if (typeof v !== 'string' || !choices.includes(v)) return { ok: false, error: `${def.key} is one of ${choices.join(', ')}` }
  return { ok: true, value: v }
}

/** A run setting as a form's field holds it (a string), back to its value; or why not. */
export function runValueOf(def: RunSettingDef, text: string): { ok: true; value: RunSettingValue } | { ok: false; error: string } {
  const t = text.trim()
  if (def.kind === 'number') return checkRunValue(def, /^[0-9]+$/.test(t) ? Number(t) : Number.NaN)
  if (def.choices!.some(c => c.value === 'true')) return checkRunValue(def, t === 'true' ? true : t === 'false' ? false : t)
  return checkRunValue(def, t)
}

/** A role entry checked: `null` keeps a "the session's" over a default; anything else must be a model and an effort. */
export function checkRoleTune(v: unknown, at: string): { ok: true; value: RoleTuneInput } | { ok: false; error: string; field: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, error: `'${at}' must be { model?, effort? }`, field: at }
  const o = v as Record<string, unknown>
  const extra = Object.keys(o).find(k => k !== 'model' && k !== 'effort')
  if (extra !== undefined) return { ok: false, error: `'${at}' takes model and effort, not '${extra}'`, field: `${at}.${extra}` }
  const out: RoleTuneInput = {}
  if (o.model === null) out.model = null
  else if (o.model !== undefined) {
    const m = typeof o.model === 'string' ? o.model.trim() : o.model
    if (!isModel(m)) return { ok: false, error: `'${at}.model' must be a model: an alias (${MODEL_ALIASES.join(', ')}) or a full id such as claude-sonnet-5-5`, field: `${at}.model` }
    out.model = m
  }
  if (o.effort === null) out.effort = null
  else if (o.effort !== undefined) {
    if (!isEffort(o.effort)) return { ok: false, error: `'${at}.effort' must be one of ${EFFORTS.join(', ')}`, field: `${at}.effort` }
    out.effort = o.effort
  }
  return { ok: true, value: out }
}

/** One role's entry laid over another: a value replaces, null clears, absent keeps. */
export function layTune(under: RoleTune | undefined, over: RoleTuneInput | undefined): RoleTune {
  const out: RoleTune = { ...(under ?? {}) }
  if (over?.model === null) delete out.model
  else if (over?.model !== undefined) out.model = over.model
  if (over?.effort === null) delete out.effort
  else if (over?.effort !== undefined) out.effort = over.effort
  return out
}

/** A tune with something set, or undefined. */
export const someTune = (t: RoleTune): RoleTune | undefined => (t.model === undefined && t.effort === undefined ? undefined : t)

/** A role's tune in words: `sonnet · low`, `the session's`. */
export const tuneWords = (t: RoleTune | undefined): string =>
  t === undefined || (t.model === undefined && t.effort === undefined) ? "the session's" : [t.model ?? "session's model", t.effort ?? "session's effort"].join(' · ')
