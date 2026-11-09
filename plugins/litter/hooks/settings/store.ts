// The saved run settings (registry.ts's two halves): yours, in one file,
// `<config dir>/litter/settings.json`, for every project (your choice of
// 2026-11-08: per user, across projects; no repository sets them). A
// launch's own values lie over it, key by key.
//
// The file is read leniently: an entry that isn't a setting, or a value its
// setting refuses, is dropped and named in `problems`, so one bad line
// costs that line and no launch.

import type { Ports } from '../ports'
import type { RoleName } from '../hookfiles'
import type { LitterOptions } from '../options'
import { atomicWriteJson, readJson, serial } from '../fsx'
import { isRoleName } from '../roles'
import {
  checkRoleTune,
  checkRunValue,
  layTune,
  runSettingDef,
  someTune,
  type RoleTune,
  type RoleTunes,
  type RunSettingKey,
  type RunSettingValue,
  type RunSettings,
} from './registry'

/** One settings file as saved. */
export type SettingsFile = { v: 1; run: RunSettings; roles: RoleTunes }

export const emptySettings = (): SettingsFile => ({ v: 1, run: {}, roles: {} })

/** Where a value came from, highest first: the launch, your file, the plugin option, the built-in. */
export type SettingFrom = 'launch' | 'user' | 'option' | 'builtin' | 'session'

export const FROM_WORDS: Readonly<Record<SettingFrom, string>> = {
  launch: 'this launch',
  user: 'your settings',
  option: 'the plugin option',
  builtin: "litter's default",
  session: "the session's",
}

/** Your file as read, and what was dropped from it. `path` is null with no config dir. */
export type LoadedSettings = {
  user: SettingsFile
  path: string | null
  problems: string[]
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Your file, or why there's none. */
export async function settingsPath(p: Ports): Promise<{ path: string } | { none: string }> {
  try {
    return { path: `${await p.configDir()}/litter/settings.json` }
  } catch (err) {
    return { none: `there's no config dir for your settings (${errText(err)})` }
  }
}

/** A file's text as a SettingsFile: what's valid kept, the rest named in `problems`. */
export function parseSettings(raw: unknown, where: string, problems: string[]): SettingsFile {
  const out = emptySettings()
  if (raw === undefined) return out
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push(`${where} isn't a settings object; it was ignored`)
    return out
  }
  const o = raw as Record<string, unknown>
  if (o.v !== 1) {
    problems.push(`${where} has no "v": 1; it was ignored`)
    return out
  }
  const run = o.run
  if (run !== undefined) {
    if (typeof run !== 'object' || run === null || Array.isArray(run)) problems.push(`${where}: "run" isn't an object; it was ignored`)
    else
      for (const [k, v] of Object.entries(run as Record<string, unknown>)) {
        const def = runSettingDef(k)
        if (!def) {
          problems.push(`${where}: "run.${k}" isn't a run setting; dropped`)
          continue
        }
        const c = checkRunValue(def, v)
        if (c.ok) out.run[def.key] = c.value
        else problems.push(`${where}: ${c.error}; dropped`)
      }
  }
  const roles = o.roles
  if (roles !== undefined) {
    if (typeof roles !== 'object' || roles === null || Array.isArray(roles)) problems.push(`${where}: "roles" isn't an object; it was ignored`)
    else
      for (const [k, v] of Object.entries(roles as Record<string, unknown>)) {
        if (!isRoleName(k)) {
          problems.push(`${where}: "roles.${k}" isn't a litter role; dropped`)
          continue
        }
        const c = checkRoleTune(v, `roles.${k}`)
        if (!c.ok) {
          problems.push(`${where}: ${c.error}; dropped`)
          continue
        }
        // A file saves values only: a null in one has nothing under it to clear.
        const t = someTune(layTune(undefined, c.value))
        if (t) out.roles[k] = t
      }
  }
  return out
}

/** Your file. One that can't be read or parsed counts as empty, and says so in `problems`. */
export async function loadSettings(p: Ports): Promise<LoadedSettings> {
  const problems: string[] = []
  const at = await settingsPath(p)
  if ('none' in at) return { user: emptySettings(), path: null, problems }
  let raw: unknown
  try {
    raw = await readJson<unknown>(p, at.path)
  } catch (err) {
    problems.push(`${at.path} couldn't be read (${errText(err)}); it was ignored`)
    return { user: emptySettings(), path: at.path, problems }
  }
  return { user: parseSettings(raw, at.path, problems), path: at.path, problems }
}

/** Saves your file whole; the value is checked again, so a bad one is refused, never written. */
export async function saveSettings(p: Ports, file: SettingsFile): Promise<string> {
  const at = await settingsPath(p)
  if ('none' in at) throw new Error(`litter: ${at.none}`)
  const problems: string[] = []
  const checked = parseSettings(file, 'the settings', problems)
  if (problems.length > 0) throw new Error(`litter: ${problems[0]}`)
  await serial(`settings:${at.path}`, () => atomicWriteJson(p, at.path, checked))
  return at.path
}

// ---------------------------------------------------------------------------
// Resolving

/** A run setting's saved value over its base: yours, else the option's or built-in. */
export function savedRun(s: LoadedSettings, key: RunSettingKey, o: LitterOptions): { value: RunSettingValue; from: SettingFrom } {
  if (s.user.run[key] !== undefined) return { value: s.user.run[key]!, from: 'user' }
  return runSettingDef(key)!.base(o)
}

/** A role's saved tune. */
export function savedRole(s: LoadedSettings, role: RoleName): { tune: RoleTune } {
  return { tune: { ...(s.user.roles[role] ?? {}) } }
}

/**
 * The options run.start parses with: each run setting's saved value in place
 * of the plugin option's, so a launch that leaves a field out gets your
 * saved one. `adversary` has no option: run.start reads it from here.
 */
export function optionsWithSaved(o: LitterOptions, s: LoadedSettings): LitterOptions {
  const v = (key: RunSettingKey) => savedRun(s, key, o).value
  return {
    ...o,
    maxRounds: v('maxRounds') as number,
    maxAttempts: v('maxAttempts') as number,
    widen: v('widen') as LitterOptions['widen'],
    repair: v('repair') as LitterOptions['repair'],
    repairRounds: v('repairRounds') as number,
    repairAgents: v('repairAgents') as number,
  }
}

/** Every saved role tune for a workflow's roles (the defaults a launch's `roles` lies over). */
export function savedRoles(s: LoadedSettings, roles: readonly RoleName[]): RoleTunes {
  const out: RoleTunes = {}
  for (const r of roles) {
    const t = someTune(savedRole(s, r).tune)
    if (t) out[r] = t
  }
  return out
}
