// The launch form's draft: what a skill proposes for a run's settings, as
// you edit it in the Settings section and confirm with [Launch].
//
// `run.draft` (the launcher's, before run.start) names the workflow, its
// `overview` (the lines the form shows above the settings: what will run,
// what's authorized), and any `settings` and `roles` the skill proposes from
// your words. The mod
// fills the rest from your saved settings, keeps the draft in $.store, one
// per litter directory, and opens the form. [Launch] marks it confirmed and
// asks the lead, in its own turn, to record run.start with `draft: <id>`;
// run.start then takes the run settings and the roles from the draft, over
// whatever its own fields said, and deletes it, so a draft launches once.
// [Cancel] deletes it and tells the lead.
//
// Without a pane (headless, or a host with none) the reply says `form:
// false`, and the skill asks for Launch as it did before, passing `roles`.

import type { Ports } from '../ports'
import type { RoleName } from '../hookfiles'
import type { RecordError, RecordHandler, RecordInput } from '../records/core'
import type { Workflow } from '../records/run'
import { fail } from '../records/core'
import { WORKFLOWS } from '../records/run'
import { randomId } from '../fsx'
import { session } from '../session'
import { ROLES_OF, checkRoleTune, checkRunValue, layTune, runSettingDef, settingsOf, type RoleTuneInput, type RunSettingKey, type RunSettings } from './registry'
import { loadSettings, optionsWithSaved, savedRole, savedRun, type LoadedSettings } from './store'
import type { LitterOptions } from '../options'

/** A draft lives this long unconfirmed or unused: a form left open past it launches nothing. */
export const DRAFT_TTL_MS = 60 * 60 * 1000

export type Draft = {
  v: 1
  id: string
  workflow: Workflow
  /** The session that recorded it: only its run.start takes it. */
  session: string
  created: number
  /** The skill's lines, shown above the settings: cleaned and cut when drawn. */
  summary: string[]
  /** Every run setting the workflow takes, as the form holds it now. */
  run: RunSettings
  /** Every role the workflow runs: its model and effort now, null for the session's. */
  roles: Partial<Record<RoleName, { model: string | null; effort: RoleTuneInput['effort'] | null }>>
  /** When you pressed [Launch]; null until you do. */
  confirmed: number | null
}

export const draftKey = (litterDir: string) => `litter.draft.${litterDir}`

const SUMMARY_MAX = 24

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The draft kept for a litter directory, or null (none, another shape). */
export async function readDraft(p: Ports, litterDir: string): Promise<Draft | null> {
  const d = (await p.store.get(draftKey(litterDir))) as Draft | undefined
  return d && typeof d === 'object' && d.v === 1 && typeof d.id === 'string' ? d : null
}

export const writeDraft = (p: Ports, litterDir: string, d: Draft): Promise<void> => p.store.set(draftKey(litterDir), d)
export const dropDraft = (p: Ports, litterDir: string): Promise<void> => p.store.delete(draftKey(litterDir))

/**
 * A new draft's values: the skill's proposals over your saved settings,
 * every setting and role of the workflow given one, so the form shows each
 * as it will run.
 */
export function draftValues(
  workflow: Workflow,
  options: LitterOptions,
  saved: LoadedSettings,
  proposed: { run: RunSettings; roles: Partial<Record<RoleName, RoleTuneInput>> },
): Pick<Draft, 'run' | 'roles'> {
  const o = optionsWithSaved(options, saved)
  const run: RunSettings = {}
  for (const def of settingsOf(workflow)) run[def.key] = proposed.run[def.key] ?? savedRun(saved, def.key, o).value
  const roles: Draft['roles'] = {}
  for (const role of ROLES_OF[workflow]) {
    const t = layTune(savedRole(saved, role).tune, proposed.roles[role])
    roles[role] = { model: t.model ?? null, effort: t.effort ?? null }
  }
  return { run, roles }
}

/** `run.draft`'s input checked: the workflow, the summary lines, and the proposals. */
function parseDraft(input: RecordInput): { ok: true; workflow: Workflow; summary: string[]; run: RunSettings; roles: Partial<Record<RoleName, RoleTuneInput>> } | RecordError {
  const known = new Set(['kind', 'workflow', 'overview', 'settings', 'roles', 'tool', 'tool_use_id', 'agentId', 'consent'])
  const extra = Object.keys(input).find(k => !known.has(k))
  if (extra !== undefined) return fail(`run.draft doesn't take '${extra}'; it takes workflow, overview, settings and roles`, extra, ['workflow', 'overview', 'settings', 'roles'])
  const workflow = input.workflow as Workflow
  if (!WORKFLOWS.includes(workflow)) return fail("'workflow' must name the workflow to launch", 'workflow', WORKFLOWS)
  const raw = input.overview ?? []
  if (!Array.isArray(raw) || raw.some(x => typeof x !== 'string')) return fail("'overview' must be a list of lines: what will run, and what the user is authorizing", 'overview')
  const summary = (raw as string[]).map(s => s.trim()).filter(s => s !== '')
  if (summary.length > SUMMARY_MAX) return fail(`'overview' has ${summary.length} lines; the form shows at most ${SUMMARY_MAX}`, 'overview')
  const run: RunSettings = {}
  if (input.settings !== undefined && input.settings !== null) {
    if (!isObj(input.settings)) return fail("'settings' must be { <setting>: value }", 'settings')
    const allowed = settingsOf(workflow).map(d => d.key)
    for (const [k, v] of Object.entries(input.settings)) {
      const def = runSettingDef(k)
      if (!def || !def.workflows.includes(workflow)) return fail(`a ${workflow} run has no '${k}' setting; it has ${allowed.join(', ') || 'none'}`, `settings.${k}`, allowed)
      const c = checkRunValue(def, v)
      if (!c.ok) return fail(c.error, `settings.${k}`)
      run[def.key] = c.value
    }
  }
  const roles: Partial<Record<RoleName, RoleTuneInput>> = {}
  if (input.roles !== undefined && input.roles !== null) {
    if (!isObj(input.roles)) return fail("'roles' must be { <role>: { model?, effort? } }", 'roles')
    for (const [role, v] of Object.entries(input.roles)) {
      if (!(ROLES_OF[workflow] as readonly string[]).includes(role)) return fail(`a ${workflow} run has no ${role} role; its roles are ${ROLES_OF[workflow].join(', ')}`, `roles.${role}`, ROLES_OF[workflow])
      const c = checkRoleTune(v, `roles.${role}`)
      if (!c.ok) return fail(c.error, c.field)
      roles[role as RoleName] = c.value
    }
  }
  return { ok: true, workflow, summary, run, roles }
}

/** The Settings section's opener for a draft, set by settings/pane.tsx (it imports the hub; this module doesn't). */
export const draftDeps = {
  openForm: async (_p: Ports, _litterDir: string): Promise<boolean> => false,
}

/** `run.draft`: the launch form, opened on the skill's proposals; `form: false` when no pane can show it. */
export const recordRunDraft: RecordHandler = async (ctx, input) => {
  const { p, litterDir, options } = ctx
  if (ctx.caller.agentId !== null) return fail("run.draft is the launcher's: a litter agent can't start a run", 'kind')
  if (!litterDir) return fail(`litter: this session has no litter directory (${session().litterDirError ?? "session.start hasn't resolved it"})`)
  const parsed = parseDraft(input)
  if (!parsed.ok) return parsed
  const saved = await loadSettings(p)
  const id = `d-${randomId().replace(/-/g, '').slice(0, 8)}`
  const draft: Draft = {
    v: 1,
    id,
    workflow: parsed.workflow,
    session: await p.sessionId(),
    created: await p.now(),
    summary: parsed.summary,
    ...draftValues(parsed.workflow, options, saved, parsed),
    confirmed: null,
  }
  await writeDraft(p, litterDir, draft)
  const form = session().host === 'claude-code' && (await draftDeps.openForm(p, litterDir))
  if (!form) {
    await dropDraft(p, litterDir)
    return {
      ok: true,
      draft: null,
      form: false,
      settings: { run: draft.run, roles: draft.roles },
      next:
        "No pane can show the launch form here, so nothing is kept. Show these settings with the rest and ask for an explicit Launch as your skill says. Then record run.start without `draft`, passing the settings the user changed as its own fields and the roles they named as `roles`; the saved settings fill the rest.",
    }
  }
  return {
    ok: true,
    draft: id,
    form: true,
    settings: { run: draft.run, roles: draft.roles },
    next:
      `The launch form is open in the litter pane, with these settings. Tell the user in one line that they can change any setting there and press Launch, then end your turn without asking anything: the form's Launch is their opt-in. ` +
      `When they press it, a message comes to you: then record run.start as you planned it, adding \`draft: '${id}'\`; the mod takes the run settings and the roles from the form. If they press Cancel, a message says so: launch nothing.`,
    ...(saved.problems.length > 0 ? { warnings: saved.problems } : {}),
  }
}

/** The fields run.start takes from a confirmed draft. */
const DRAFT_FIELDS: readonly RunSettingKey[] = ['maxRounds', 'maxAttempts', 'adversary', 'widen', 'repair', 'repairRounds', 'repairAgents']

/**
 * run.start's draft (lifecycle.ts): with no `draft`, the input as it is.
 * With one, the confirmed draft of this session and workflow, its run
 * settings and roles over the input's own (a difference is said in a
 * warning). `id` is the draft's: run.start deletes it once the run is made,
 * so a refused launch keeps the form you confirmed.
 */
export async function takeDraft(p: Ports, litterDir: string, input: RecordInput): Promise<{ ok: true; input: RecordInput; warnings: string[]; id: string | null } | RecordError> {
  if (input.draft === undefined || input.draft === null) return { ok: true, input, warnings: [], id: null }
  if (typeof input.draft !== 'string') return fail("'draft' must be the id run.draft returned", 'draft')
  const d = await readDraft(p, litterDir)
  if (!d || d.id !== input.draft) return fail(`litter: there's no launch form ${input.draft} (a later run.draft replaced it, or it launched already); record run.draft again`, 'draft')
  if (d.session !== (await p.sessionId())) return fail(`litter: launch form ${d.id} is another session's`, 'draft')
  if (d.confirmed === null) return fail(`litter: launch form ${d.id} hasn't been confirmed: the user presses Launch in it first`, 'draft')
  if ((await p.now()) - d.created > DRAFT_TTL_MS) {
    await dropDraft(p, litterDir)
    return fail(`litter: launch form ${d.id} is over an hour old; record run.draft again`, 'draft')
  }
  if (input.workflow !== d.workflow) return fail(`litter: launch form ${d.id} is for a ${d.workflow} run, not ${String(input.workflow)}`, 'workflow')
  const out: RecordInput = { ...input }
  delete out.draft
  const warnings: string[] = []
  for (const key of DRAFT_FIELDS) {
    if (!(key in d.run)) continue
    if (out[key] !== undefined && out[key] !== d.run[key]) warnings.push(`the launch form's ${key} (${String(d.run[key])}) replaced the ${String(out[key])} run.start was given`)
    out[key] = d.run[key]
  }
  if (out.roles !== undefined && JSON.stringify(out.roles) !== JSON.stringify(d.roles)) warnings.push("the launch form's roles replaced the ones run.start was given")
  out.roles = d.roles
  return { ok: true, input: out, warnings, id: d.id }
}
