// The plugin options (plugin.json userConfig), normalised once. An optional
// field with no default reaches the mod as "" (plan section 10, "\"\" means
// unset"), so every "" becomes undefined here and nowhere else.
//
// Contract owner: phase 1a; the repair options are phase 2b-2's (package V),
// `trailers` phase 3's (package AA), `widen` WP-AO's, `bandEndedMinutes` WP-CH's.

export type RepairMode = 'auto' | 'off'

/**
 * Who may add files to a gate's Files for a run (WP-AO): `ask`, only you, in
 * the mod's own dialog; `critic`, you, or the gate's critic, for a file the
 * gate can't do without, each one listed in summary.md for you.
 */
export type WidenMode = 'ask' | 'critic'
export const WIDEN_MODES: readonly WidenMode[] = ['ask', 'critic']

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
  /** Who may add files to a gate's Files for an execute run (WP-AO); a launch can override it for its run. */
  widen: WidenMode
  /**
   * The lines litter adds to every commit it makes (decision 4), a land's or
   * a fanout's merge, one `Key: value` each, in order; empty by default.
   * run.start copies them into run.json, where `attribution` reads them.
   */
  trailers: readonly string[]
  /** The option's lines that weren't `Key: value` lines, dropped; session.start logs them once. */
  trailersDropped: readonly string[]
  /** How many minutes a run that ended keeps its row in the band (COMMON decision 7); 0 is no ended row. */
  bandEndedMinutes: number
}

/** The configured options a skill shows (design D9), from getOptions(); null where unset. */
export type ConfiguredOptions = {
  verify: readonly string[] | null
  goalCheck: readonly string[] | null
  setup: readonly string[] | null
  linkDirs: readonly string[]
  verifyTimeoutMs: number
  maxAttempts: number
  maxRounds: number
  repair: RepairMode
  repairRounds: number
  repairAgents: number
  widen: WidenMode
  trailers: readonly string[]
}

/** run.find's `options` (litterdir.ts): what a skill shows, without the UI and log settings. */
export const configuredOptions = (o: LitterOptions): ConfiguredOptions => ({
  verify: o.verify ?? null,
  goalCheck: o.goalCheck ?? null,
  setup: o.setup ?? null,
  linkDirs: o.linkDirs,
  verifyTimeoutMs: o.verifyTimeoutMs,
  maxAttempts: o.maxAttempts,
  maxRounds: o.maxRounds,
  repair: o.repair,
  repairRounds: o.repairRounds,
  repairAgents: o.repairAgents,
  widen: o.widen,
  trailers: o.trailers,
})

/**
 * One commit trailer line litter writes (section 9, "Commit message"):
 * `Key: value` on one line, never litter's own `Litter-Run`. land.ts's
 * attribution checks run.json's lines with it again.
 */
export const TRAILER_LINE = /^[A-Za-z][A-Za-z0-9-]*: \S[^\r\n]*$/
export const isTrailerLine = (line: string): boolean => TRAILER_LINE.test(line) && !/^litter-run:/i.test(line)

/** The attribution lines run.start copied into run.json (`trailers`), checked again; every commit litter makes ends with them. */
export function attribution(json: object): string[] {
  const t = (json as { trailers?: unknown }).trailers
  if (!Array.isArray(t)) return []
  return t.filter((x): x is string => typeof x === 'string' && isTrailerLine(x))
}

/** Section 10's defaults and ranges for the repair budget; run.start holds an override to the same ranges. */
export const REPAIR_ROUNDS = { default: 3, min: 1, max: 10 } as const
export const REPAIR_AGENTS = { default: 6, min: 1, max: 50 } as const
/** The band's ended-run window in minutes (WP-CH): decision 7's 10 by default, up to a day. */
export const BAND_ENDED_MINUTES = { default: 10, min: 0, max: 1440 } as const

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

/** `critic` (any case, trimmed) lets the critic widen a gate; anything else, unset included, is the default `ask`. */
const widenMode = (v: unknown): WidenMode => (typeof v === 'string' && v.trim().toLowerCase() === 'critic' ? 'critic' : 'ask')

/**
 * The trailers option (decision 4), a list or one string ("" is unset). Each
 * entry is split into lines and trimmed, and blank lines are skipped; a line
 * that isn't a trailer litter writes is dropped, and kept in `dropped`.
 */
function trailerLines(v: unknown): { kept: string[]; dropped: string[] } {
  const entries = typeof v === 'string' ? [v] : Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  const kept: string[] = []
  const dropped: string[] = []
  for (const line of entries.flatMap(e => e.split(/\r\n|\r|\n/)).map(l => l.trim())) {
    if (line === '') continue
    if (isTrailerLine(line)) kept.push(line)
    else dropped.push(line)
  }
  return { kept, dropped }
}

export function normalizeOptions(raw: Readonly<Record<string, unknown>> | undefined): LitterOptions {
  const o = raw ?? {}
  const model = typeof o.summaryModel === 'string' ? o.summaryModel.trim() : ''
  const trailers = trailerLines(o.trailers)
  const out: LitterOptions = {
    linkDirs: argv(o.linkDirs) ?? [],
    verifyTimeoutMs: num(o.verifyTimeoutMs, 30 * 60 * 1000),
    maxAttempts: num(o.maxAttempts, 3),
    maxRounds: num(o.maxRounds, 4),
    summaryEverySec: num(o.summaryEverySec, 60),
    repair: repairMode(o.repair),
    repairRounds: within(o.repairRounds, REPAIR_ROUNDS),
    repairAgents: within(o.repairAgents, REPAIR_AGENTS),
    widen: widenMode(o.widen),
    trailers: trailers.kept,
    trailersDropped: trailers.dropped,
    bandEndedMinutes: within(o.bandEndedMinutes, BAND_ENDED_MINUTES),
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
