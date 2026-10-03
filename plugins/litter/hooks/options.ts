// The plugin options (plugin.json userConfig), normalised once. An optional
// field with no default reaches the mod as "" (plan section 10, "\"\" means
// unset"), so every "" becomes undefined here and nowhere else.
//
// Contract owner: phase 1a; the repair options are phase 2b-2's (package V).

export type RepairMode = 'auto' | 'off'

export type LitterOptions = {
  verify?: readonly string[]
  goalCheck?: readonly string[]
  setup?: readonly string[]
  linkDirs: readonly string[]
  verifyTimeoutMs: number
  maxAttempts: number
  maxRounds: number
  /** undefined means off. */
  summaryModel?: string
  summaryEverySec: number
  /** What a failed run does (plan 15.11): `auto` continues as a repair swarm, `off` stops and recommends one. */
  repair: RepairMode
  /** The repair budget's rounds (15.11, "The repair budget"). */
  repairRounds: number
  /** The repair budget's agents: the workers and children a repair swarm's nodes spawn. */
  repairAgents: number
}

/** Section 10's defaults and ranges for the repair budget; run.start holds an override to the same ranges. */
export const REPAIR_ROUNDS = { default: 3, min: 1, max: 10 } as const
export const REPAIR_AGENTS = { default: 6, min: 1, max: 50 } as const

const argv = (v: unknown): readonly string[] | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  if (Array.isArray(v)) {
    const list = v.filter((x): x is string => typeof x === 'string')
    return list.length === 0 ? undefined : list
  }
  return undefined
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback

/**
 * A whole number in its range. One outside it is clamped to the nearer end,
 * and a fraction rounded down, so 0 or 99 means as little or as much as the
 * option allows, never the default (which could be more than you set);
 * anything that isn't a number is the default.
 */
const within = (v: unknown, range: { default: number; min: number; max: number }): number =>
  Math.min(range.max, Math.max(range.min, Math.floor(num(v, range.default))))

/** `off` (any case, trimmed) is off; anything else, unset included, is the default `auto`. */
const repairMode = (v: unknown): RepairMode => (typeof v === 'string' && v.trim().toLowerCase() === 'off' ? 'off' : 'auto')

export function normalizeOptions(raw: Readonly<Record<string, unknown>> | undefined): LitterOptions {
  const o = raw ?? {}
  const model = typeof o.summaryModel === 'string' ? o.summaryModel.trim() : ''
  const out: LitterOptions = {
    linkDirs: argv(o.linkDirs) ?? [],
    verifyTimeoutMs: num(o.verifyTimeoutMs, 30 * 60 * 1000),
    maxAttempts: num(o.maxAttempts, 3),
    maxRounds: num(o.maxRounds, 4),
    summaryEverySec: num(o.summaryEverySec, 60),
    repair: repairMode(o.repair),
    repairRounds: within(o.repairRounds, REPAIR_ROUNDS),
    repairAgents: within(o.repairAgents, REPAIR_AGENTS),
  }
  const verify = argv(o.verify)
  const goalCheck = argv(o.goalCheck)
  const setup = argv(o.setup)
  if (verify) out.verify = verify
  if (goalCheck) out.goalCheck = goalCheck
  if (setup) out.setup = setup
  if (model !== '' && model !== 'off') out.summaryModel = model
  return out
}
