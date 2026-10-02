// The plugin options (plugin.json userConfig), normalised once. An optional
// field with no default reaches the mod as "" (plan section 10, "\"\" means
// unset"), so every "" becomes undefined here and nowhere else.
//
// Contract owner: phase 1a.

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
}

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

export function normalizeOptions(raw: Readonly<Record<string, unknown>> | undefined): LitterOptions {
  const o = raw ?? {}
  const model = typeof o.summaryModel === 'string' ? o.summaryModel.trim() : ''
  const out: LitterOptions = {
    linkDirs: argv(o.linkDirs) ?? [],
    verifyTimeoutMs: num(o.verifyTimeoutMs, 30 * 60 * 1000),
    maxAttempts: num(o.maxAttempts, 3),
    maxRounds: num(o.maxRounds, 4),
    summaryEverySec: num(o.summaryEverySec, 60),
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
