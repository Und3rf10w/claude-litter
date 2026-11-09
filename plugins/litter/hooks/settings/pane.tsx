// The `litter` pane's Settings section: `/litter settings`. Two views of the
// one table of run settings (registry.ts):
//
// - The launch form, which a skill's run.draft opens (draft.ts): the run's
//   overview as the skill wrote it, each setting the workflow takes, and
//   each of its roles' model and effort, filled from your saved settings and
//   the skill's proposals. Every change is written to the draft at once.
//   [Launch] confirms it and asks the lead, in a turn of its own, to record
//   run.start with the draft; [Cancel] drops it and tells the lead.
//   [Save as defaults] writes what the form shows to your settings.
// - Your saved defaults, for every project (store.ts): the same rows,
//   every workflow's settings and every role, each unset until you set it,
//   its note saying what applies then. [Save] writes the file.
//
// Above either, while a litter run is active, Running: each of its role
// agents with what its last request named, and a Model and an Effort select
// whose change applies from that agent's next request (apply.ts's tuneRole).
//
// Keys are `settings:<action>[:<arg>]`. The model select's "another id…"
// opens a field for a full id or an alias under that role.
//
// `h` and `Fragment` are the environment's JSX factory, so no name here takes them.

import type { RenderElement } from 'claude-code'
import type { Ports } from '../ports'
import type { CommandRunHook, PaneElements, PaneUiHandlers, PortHook } from '../hooktypes'
import type { RoleName } from '../hookfiles'
import type { SettingsAgentRow, SettingsBody, SettingsField, SettingsPaneView, SettingsRoleRow, SwarmNotice, SwarmOption } from '../../types/index'
import type { Loaded } from '../ui/hub'
import { STYLE } from '../ui/style'
import { actions, field, heading, notice, type BodyContext, type SectionMeta } from '../ui/chrome'
import { openSection, shownSection } from '../ui/hub'
import { choose } from '../swarm/builder'
import { clean, oneLine } from '../swarm/view'
import { getOptions, session } from '../session'
import { isRoleName } from '../roles'
import {
  ALL_ROLES,
  EFFORTS,
  MODEL_OPTIONS,
  ROLES_OF,
  ROLE_WORDS,
  RUN_SETTINGS,
  isEffort,
  isModel,
  runSettingDef,
  runValueOf,
  settingsOf,
  workflowsOfRole,
  type RunSettingDef,
} from './registry'
import { FROM_WORDS, emptySettings, loadSettings, saveSettings, savedRun, type LoadedSettings, type SettingsFile } from './store'
import { draftDeps, dropDraft, readDraft, writeDraft, type Draft } from './draft'
import { roleAgents, tuneRole, type RoleAgent } from './apply'
import { agentInfo, readPolicy } from '../policy'
import { MODEL_CHOICES } from './registry'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** What Settings tells the hub (ui/pane.tsx): drawn whole (fourteen roles run long), no keys of its own. */
export const settingsSection: SectionMeta<SettingsPaneView> = { fits: false, keys: () => [] }

/** The model select's value that opens a field for any id. */
export const OTHER = '__other'

const PREFIX = 'settings:'
export const settingsKey = (action: string, arg?: string): string => `${PREFIX}${action}${arg === undefined ? '' : `:${arg}`}`

// ---------------------------------------------------------------------------
// Module memory

type Nav = {
  mode: 'launch' | 'defaults'
  /** Your file as you're editing it; null until read. */
  work: SettingsFile | null
  dirty: boolean
  /** Roles whose model-id field is open. */
  other: RoleName[]
  notice: SwarmNotice | null
}

const blank = (): Nav => ({ mode: 'defaults', work: null, dirty: false, other: [], notice: null })
let nav: Nav = blank()
let seq = 0
/** A draft waits for your Launch: the strip's ⚑ (ui/hub.ts). */
let waiting = false

/** Whether a launch form waits for you, for the strip. */
export const settingsNeedYou = (): boolean => waiting

// ---------------------------------------------------------------------------
// The view

const plain = (s: string, max = 200): string => oneLine(clean(s, 2000), max)

const NOT_SET = (note: string): SwarmOption => ({ value: '', label: `not set: ${note}` })

const modelOptions = (value: string, unset: string): SwarmOption[] => {
  const opts: SwarmOption[] = [NOT_SET(unset), ...MODEL_OPTIONS.map(m => ({ value: m, label: m }))]
  if (value !== '' && !opts.some(o => o.value === value)) opts.push({ value, label: plain(value, 80) })
  opts.push({ value: OTHER, label: 'another id…' })
  return opts
}

const effortOptions = (unset: string): SwarmOption[] => [NOT_SET(unset), ...EFFORTS.map(e => ({ value: e, label: e }))]

/** A run setting's value as its field holds it. */
const valueText = (v: unknown): string => (v === undefined ? '' : String(v))

/** One run setting's field: `value` the field's text, `unset` what applies without it (null: it's always set, the launch form). */
function runField(def: RunSettingDef, value: string, unset: string | null): SettingsField {
  const key = settingsKey('run', def.key)
  if (def.kind === 'number') {
    const r = def.range!
    return { key, label: def.label, kind: 'input', value, placeholder: unset === null ? `${r.min}–${r.max}` : `${unset} (${r.min}–${r.max})`, note: def.words }
  }
  const choices = def.choices!.map(c => ({ value: c.value, label: c.label }))
  return { key, label: def.label, kind: 'select', value, options: unset === null ? choices : [NOT_SET(unset), ...choices], note: def.words }
}

function roleRow(role: RoleName, model: string, effort: string, unset: { model: string; effort: string }): SettingsRoleRow {
  const custom = model !== '' && !MODEL_OPTIONS.includes(model)
  const open = nav.other.includes(role) || custom
  return {
    role,
    words: `${ROLE_WORDS[role]} · ${workflowsOfRole(role).join(', ')}`,
    model: { key: settingsKey('model', role), label: 'Model', kind: 'select', value: model, options: modelOptions(model, unset.model), note: '' },
    modelId: open
      ? { key: settingsKey('model-id', role), label: 'Model id', kind: 'input', value: custom ? model : '', placeholder: 'an alias or a full id, such as claude-sonnet-5-5', note: 'enter to set it' }
      : null,
    effort: { key: settingsKey('effort', role), label: 'Effort', kind: 'select', value: effort, options: effortOptions(unset.effort), note: '' },
  }
}

function defaultsBody(saved: LoadedSettings, work: SettingsFile, draftWaiting: boolean): SettingsBody {
  // Unset, a run setting is the plugin option's or litter's default; a role, the session's.
  const none: LoadedSettings = { user: emptySettings(), path: null, problems: [] }
  const run = RUN_SETTINGS.map(def => {
    const fb = savedRun(none, def.key, getOptions())
    return runField(def, valueText(work.run[def.key]), `${String(fb.value)}, ${FROM_WORDS[fb.from]}`)
  })
  const roles = ALL_ROLES.map(role => roleRow(role, work.roles[role]?.model ?? '', work.roles[role]?.effort ?? '', { model: "the session's", effort: "the session's" }))
  return {
    running: null,
    mode: 'defaults',
    draft: null,
    path: saved.path ?? 'no config dir for your settings',
    run,
    roles,
    dirty: nav.dirty,
    draftWaiting,
    problems: saved.problems.map(x => plain(x, 300)),
  }
}

function launchBody(saved: LoadedSettings, d: Draft): SettingsBody {
  const run = settingsOf(d.workflow).map(def => runField(def, valueText(d.run[def.key]), null))
  const roles = ROLES_OF[d.workflow].map(role => roleRow(role, d.roles[role]?.model ?? '', d.roles[role]?.effort ?? '', { model: "the session's", effort: "the session's" }))
  return {
    running: null,
    mode: 'launch',
    draft: { id: d.id, workflow: d.workflow, overview: d.summary.map(x => plain(x, 400)), confirmed: d.confirmed !== null },
    path: saved.path ?? 'no config dir to save these in',
    run,
    roles,
    dirty: false,
    draftWaiting: false,
    problems: saved.problems.map(x => plain(x, 300)),
  }
}

/** Running shows at most this many agents, the newest. */
const RUNNING_MAX = 24

const effortText = (e: string | number | null | undefined): string | null => (e === null || e === undefined ? null : typeof e === 'number' ? `${e} thinking tokens` : e)

function agentRow(a: RoleAgent, done: boolean): SettingsAgentRow {
  const last = a.seen ? `its last request: ${plain(a.seen.model, 80)}${effortText(a.seen.effort) ? ` · ${effortText(a.seen.effort)}` : ''}` : 'no request yet'
  if (done) return { agentId: a.agentId, role: a.role, last, done, model: null, effort: null }
  const runModel = a.tune.model ?? "the session's"
  const runEffort = a.tune.effort ?? "the session's"
  const ids = [...new Set([...(a.live?.model ? [a.live.model] : []), ...(a.seen ? [a.seen.model] : []), ...MODEL_CHOICES])]
  return {
    agentId: a.agentId,
    role: a.role,
    last,
    done,
    model: { key: settingsKey('tune-model', a.agentId), label: 'Model', kind: 'select', value: a.live?.model ?? '', options: [{ value: '', label: `its run's: ${plain(runModel, 60)}` }, ...ids.map(m => ({ value: m, label: plain(m, 80) }))], note: '' },
    effort: { key: settingsKey('tune-effort', a.agentId), label: 'Effort', kind: 'select', value: a.live?.effort ?? '', options: [{ value: '', label: `its run's: ${runEffort}` }, ...EFFORTS.map(e => ({ value: e, label: e }))], note: '' },
  }
}

/** The active run's role agents, for Running; null while no run is active. */
async function runningOf(p: Ports, litterDir: string): Promise<SettingsBody['running']> {
  const r = (await readPolicy(p, litterDir).catch(() => undefined))?.run
  if (!r) return null
  const all = await roleAgents(p, r.run)
  const shown = all.slice(-RUNNING_MAX)
  const agents: SettingsAgentRow[] = []
  for (const a of shown) {
    const info = await agentInfo(p, a.agentId).catch(() => undefined)
    agents.push(agentRow(a, info !== undefined && info.stopped !== null))
  }
  return { run: r.run, workflow: r.workflow, agents, hidden: all.length - shown.length }
}

let lastJson = ''
/** The files as the last forced draw read them. */
let cached: LoadedSettings | null = null

/** Builds and writes the view (only when it moved, unless `force`): the launch form while one is shown and its draft is there, else the defaults. */
async function draw(p: Ports, force = true): Promise<SettingsBody | null> {
  const litterDir = session().litterDir
  if (!litterDir) {
    await p.setView('settings', { view: 'settings', v: ++seq, notice: { level: 'warning', text: `no litter directory: ${session().litterDirError ?? 'the session is still starting'}` } })
    return null
  }
  // The files are read when you act or the section opens; a tick reuses them.
  const saved = force || cached === null ? await loadSettings(p) : cached
  cached = saved
  const d = await readDraft(p, litterDir)
  waiting = d !== null && d.confirmed === null
  if (nav.mode === 'launch' && !d) nav = { ...nav, mode: 'defaults' }
  if (nav.work === null || !nav.dirty) nav = { ...nav, work: structuredClone(saved.user) }
  const body = nav.mode === 'launch' && d ? launchBody(saved, d) : defaultsBody(saved, nav.work!, waiting)
  body.running = await runningOf(p, litterDir)
  const json = JSON.stringify([body, nav.notice])
  if (force || json !== lastJson) {
    lastJson = json
    await p.setView('settings', { view: 'settings', v: ++seq, body, notice: nav.notice })
  }
  return body
}

const say = (level: SwarmNotice['level'], text: string): void => {
  nav = { ...nav, notice: { level, text: plain(text, 300) } }
}

// ---------------------------------------------------------------------------
// The section's entries

/** `/litter settings [defaults | launch]`. */
export const settingsCommand: PortHook<CommandRunHook> = async (p, e) => ({ text: (await openSection(p, 'settings', e.args ?? '', { focus: true })).text })

/** Settings' load: `launch` the waiting form, `defaults` your settings, nothing whichever waits. */
export async function loadSettingsSection(p: Ports, arg: string): Promise<Loaded> {
  const a = arg.trim()
  if (a !== '' && a !== 'launch' && a !== 'defaults') return { text: 'usage: /litter settings [defaults | launch]', refused: true }
  const litterDir = session().litterDir
  const d = litterDir ? await readDraft(p, litterDir) : null
  if (a === 'launch' && !d) return { text: 'no launch form waits: a litter skill opens one before it launches a run', refused: true }
  nav = { ...nav, mode: a === 'defaults' ? 'defaults' : d && (a === 'launch' || d.confirmed === null) ? 'launch' : 'defaults', notice: null }
  const body = await draw(p)
  if (body?.mode === 'launch') return { text: `Settings shows the launch form for the ${body.draft!.workflow} run` }
  return { text: 'Settings shows your saved settings' }
}

export async function resumeSettings(p: Ports): Promise<void> {
  await draw(p)
}

/** The tick, while Settings is shown: Running's agents and a draft that came or went, written only when they moved. */
export async function settingsTick(p: Ports): Promise<void> {
  if (session().litterDir) await draw(p, false)
}

// draft.ts opens the form through this, so it imports no hub.
draftDeps.openForm = async (p: Ports): Promise<boolean> => {
  nav = { ...nav, mode: 'launch', other: [], notice: null }
  return (await openSection(p, 'settings', 'launch', { focus: true })).placed
}

// ---------------------------------------------------------------------------
// Changes

/** A change to the launch form: the draft rewritten at once. Refused once you've pressed Launch. */
async function editDraft(p: Ports, change: (d: Draft) => string | null): Promise<void> {
  const litterDir = session().litterDir
  const d = litterDir ? await readDraft(p, litterDir) : null
  if (!litterDir || !d) return say('warning', 'that launch form is gone')
  if (d.confirmed !== null) return say('warning', 'Launch was pressed already: the lead is launching it as it was')
  const why = change(d)
  if (why) return say('error', why)
  await writeDraft(p, litterDir, d)
  nav = { ...nav, notice: null }
}

/** A change to the shown defaults, kept until [Save]. */
function editWork(change: (w: SettingsFile) => string | null): void {
  const w = nav.work ?? emptySettings()
  const next = structuredClone(w)
  const why = change(next)
  if (why) return say('error', why)
  nav = { ...nav, work: next, dirty: true, notice: null }
}

function setRun(p: Ports, key: string, text: string): void | Promise<void> {
  const def = runSettingDef(key)
  if (!def) return
  if (nav.mode === 'launch') {
    return editDraft(p, d => {
      if (!def.workflows.includes(d.workflow)) return null
      const v = runValueOf(def, text)
      if (!v.ok) return v.error
      d.run[def.key] = v.value
      return null
    })
  }
  editWork(w => {
    if (text.trim() === '') {
      delete w.run[def.key]
      return null
    }
    const v = runValueOf(def, text)
    if (!v.ok) return v.error
    w.run[def.key] = v.value
    return null
  })
}

function setRole(p: Ports, role: RoleName, what: 'model' | 'effort', value: string): void | Promise<void> {
  if (what === 'model' && value !== '' && !isModel(value)) return say('error', `${plain(value, 60)} isn't a model: an alias or a full id such as claude-sonnet-5-5`)
  if (what === 'effort' && value !== '' && !isEffort(value)) return say('error', `effort is one of ${EFFORTS.join(', ')}`)
  if (nav.mode === 'launch') {
    return editDraft(p, d => {
      const r = d.roles[role]
      if (!r) return null
      d.roles[role] = { ...r, [what]: value === '' ? null : value }
      return null
    })
  }
  editWork(w => {
    const r = { ...(w.roles[role] ?? {}) }
    if (value === '') delete r[what]
    else (r as Record<string, string>)[what] = value
    if (r.model === undefined && r.effort === undefined) delete w.roles[role]
    else w.roles[role] = r
    return null
  })
}

async function launch(p: Ports): Promise<void> {
  const litterDir = session().litterDir
  const d = litterDir ? await readDraft(p, litterDir) : null
  if (!litterDir || !d) return say('warning', 'that launch form is gone')
  // Pressed again (a launch the mod refused, say): the lead is asked again.
  d.confirmed = await p.now()
  await writeDraft(p, litterDir, d)
  waiting = false
  const text = `Launch: I pressed Launch in litter's launch form ${d.id}. Record run.start for the ${d.workflow} run as you planned it, adding draft: '${d.id}'; litter applies the form's settings. Don't ask me to confirm again.`
  p.after(0, () => {
    p.submitPrompt(text).then(
      () => p.log(`settings: launch form ${d.id} reached the lead`),
      (err: unknown) => p.toast(`the launch didn't reach the lead: ${oneLine(errText(err), 100)}; press Launch again`),
    )
  })
  say('ok', `sent to the lead: it records the ${d.workflow} run's start with these settings`)
}

async function cancel(p: Ports): Promise<void> {
  const litterDir = session().litterDir
  const d = litterDir ? await readDraft(p, litterDir) : null
  if (!litterDir || !d) return say('warning', 'that launch form is gone')
  // After Launch too: run.start then finds no form and launches nothing; a run already made is stopped as any run is.
  await dropDraft(p, litterDir)
  waiting = false
  nav = { ...nav, mode: 'defaults' }
  p.after(0, () => {
    p.submitPrompt(`I cancelled litter's launch form ${d.id}: don't launch the ${d.workflow} run.`).catch((err: unknown) => p.log(`settings: the cancel didn't reach the lead: ${errText(err)}`))
  })
  say('info', 'cancelled: the lead is told, and nothing launches')
}

async function save(p: Ports): Promise<void> {
  const litterDir = session().litterDir
  if (!litterDir || !nav.work) return
  try {
    const path = await saveSettings(p, nav.work)
    nav = { ...nav, dirty: false }
    say('ok', `saved to ${path}`)
  } catch (err) {
    say('error', `not saved: ${errText(err)}`)
  }
}

/** The launch form's values into the chosen file, over what it holds: its settings, and each role (the session's clears it). */
async function saveDraftAsDefaults(p: Ports): Promise<void> {
  const litterDir = session().litterDir
  const d = litterDir ? await readDraft(p, litterDir) : null
  if (!litterDir || !d) return say('warning', 'that launch form is gone')
  const file = structuredClone((await loadSettings(p)).user)
  for (const def of settingsOf(d.workflow)) if (d.run[def.key] !== undefined) file.run[def.key] = d.run[def.key]
  for (const role of ROLES_OF[d.workflow]) {
    const r = d.roles[role]
    const t = { ...(r?.model ? { model: r.model } : {}), ...(r?.effort ? { effort: r.effort } : {}) }
    if (t.model === undefined && t.effort === undefined) delete file.roles[role]
    else file.roles[role] = t
  }
  try {
    const path = await saveSettings(p, file)
    nav = { ...nav, work: null, dirty: false }
    say('ok', `the form's settings are saved to ${path}`)
  } catch (err) {
    say('error', `not saved: ${errText(err)}`)
  }
}

/** One event on a Settings key; answers whether it was one. */
async function handle(p: Ports, element: string, value: string | undefined, kind?: 'change' | 'submit'): Promise<boolean> {
  if (!element.startsWith(PREFIX)) return false
  const [action, arg = ''] = element.slice(PREFIX.length).split(':') as [string, string?]
  switch (action) {
    case 'run':
      if (value === undefined) break
      // A number's field acts on enter; a select at once.
      if (runSettingDef(arg)?.kind === 'number' && kind === 'change') return true
      await setRun(p, arg, value)
      break
    case 'model':
      if (!isRoleName(arg) || value === undefined) break
      if (value === OTHER) {
        nav = { ...nav, other: [...new Set([...nav.other, arg])] }
        break
      }
      nav = { ...nav, other: nav.other.filter(r => r !== arg) }
      await setRole(p, arg, 'model', value)
      break
    case 'model-id':
      if (!isRoleName(arg) || value === undefined || kind === 'change') return true
      if (value.trim() !== '') {
        await setRole(p, arg, 'model', value.trim())
        nav = { ...nav, other: nav.other.filter(r => r !== arg) }
      }
      break
    case 'effort':
      if (isRoleName(arg) && value !== undefined) await setRole(p, arg, 'effort', value)
      break
    case 'tune-model':
    case 'tune-effort': {
      if (value === undefined) break
      const what = action === 'tune-model' ? 'model' : 'effort'
      if (what === 'effort' && value !== '' && !isEffort(value)) {
        say('error', `effort is one of ${EFFORTS.join(', ')}`)
        break
      }
      const r = await tuneRole(p, what === 'model' ? { agentId: arg, model: value === '' ? null : value } : { agentId: arg, effort: value === '' ? null : (value as (typeof EFFORTS)[number]) })
      if (r.ok) say('ok', r.text)
      else say('error', r.reason)
      break
    }
    case 'launch':
      await launch(p)
      break
    case 'cancel':
      await cancel(p)
      break
    case 'save':
      await save(p)
      break
    case 'revert':
      nav = { ...nav, work: null, dirty: false, other: [], notice: { level: 'info', text: 'back to the saved file' } }
      break
    case 'save-defaults':
      await saveDraftAsDefaults(p)
      break
    case 'show-defaults':
      nav = { ...nav, mode: 'defaults', notice: null }
      break
    case 'show-launch':
      nav = { ...nav, mode: 'launch', notice: null }
      break
    default:
      return true
  }
  await draw(p)
  return true
}

export const onSettingsUi: PaneUiHandlers = {
  message: async (p, e, next) => next(e),
  press: async (p, e, next) => ((await handle(p, e.element, undefined)) ? { element: e.element } : next(e)),
  input: async (p, e, next) => ((await handle(p, e.element, e.value, e.kind)) ? { element: e.element, value: e.value } : next(e)),
  select: async (p, e, next) => ((await handle(p, e.element, e.value)) ? { element: e.element, value: e.value } : next(e)),
}

/** Tier 2: module memory as a fresh load finds it. */
export function resetSettingsPaneForTests(): void {
  nav = blank()
  seq = 0
  waiting = false
  lastJson = ''
  cached = null
}

/** Tier 2: the nav as it stands. */
export const settingsNavForTests = (): Readonly<Nav> => nav

/** Whether Settings is the shown section (for a caller that redraws only then). */
export const settingsShown = (): boolean => shownSection() === 'settings'

// ---------------------------------------------------------------------------
// The render

function fieldOf(el: PaneElements, f: SettingsField, ctx: BodyContext): RenderElement {
  if (f.kind === 'select') return choose(el, { key: f.key, label: f.label, value: f.value, options: f.options ?? [] })
  return field(el, { key: f.key, label: f.label, value: f.value, ...(f.placeholder ? { placeholder: f.placeholder } : {}) }, null, {
    surface: ctx.surface,
    isFocused: ctx.isFocused,
    focused: ctx.focused,
    columns: ctx.bodyColumns,
  })
}

function runPart(el: PaneElements, b: SettingsBody, ctx: BodyContext): RenderElement | null {
  const { Box, Text } = el
  if (b.run.length === 0) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      {heading(el, 'Run', ctx.bodyColumns)}
      {b.run.map(f => (
        <Box flexDirection="column">
          {fieldOf(el, f, ctx)}
          <Text color={STYLE.muted} wrap="wrap">
            {f.note}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function rolesPart(el: PaneElements, b: SettingsBody, ctx: BodyContext): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="column" marginTop={1}>
      {heading(el, 'Roles', ctx.bodyColumns, 'model · effort')}
      {b.roles.map(r => (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Text bold color={STYLE.name}>
              {r.role}
            </Text>
            <Text color={STYLE.muted}>{r.words}</Text>
          </Box>
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            {fieldOf(el, r.model, ctx)}
            {fieldOf(el, r.effort, ctx)}
          </Box>
          {r.modelId ? fieldOf(el, r.modelId, ctx) : null}
        </Box>
      ))}
    </Box>
  )
}

function runningPart(el: PaneElements, b: SettingsBody, ctx: BodyContext): RenderElement | null {
  const { Box, Text } = el
  const r = b.running
  if (!r) return null
  return (
    <Box flexDirection="column" marginBottom={1}>
      {heading(el, `Running · ${r.workflow} run ${r.run}`, ctx.bodyColumns, 'from each next request')}
      {r.agents.length === 0 ? <Text color={STYLE.muted}>no role agent has started yet</Text> : null}
      {r.agents.map(a => (
        <Box flexDirection="column">
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            <Text color={a.done ? STYLE.muted : STYLE.name}>{a.role}</Text>
            <Text color={STYLE.muted}>{a.done ? `done · ${a.last}` : a.last}</Text>
          </Box>
          {a.model && a.effort ? (
            <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
              {fieldOf(el, a.model, ctx)}
              {fieldOf(el, a.effort, ctx)}
            </Box>
          ) : null}
        </Box>
      ))}
      {r.hidden > 0 ? <Text color={STYLE.muted}>{`${r.hidden} earlier not shown`}</Text> : null}
      <Text color={STYLE.muted} wrap="wrap">
        {'A new model reads its conversation again, without the cache.'}
      </Text>
    </Box>
  )
}

/** Settings' body (ui/pane.tsx): Running, then the launch form or your defaults. Pure. */
export function renderSettingsPane(view: SettingsPaneView | null, el: PaneElements, ctx: BodyContext): RenderElement {
  const { Box, Text } = el
  const b = view?.body
  const top = view?.notice ? notice(el, view.notice.level, view.notice.text) : null
  if (!b)
    return (
      <Box flexDirection="column">
        {top}
        <Text color={STYLE.muted}>reading the settings…</Text>
      </Box>
    )
  const launchMode = b.mode === 'launch' && b.draft !== null
  return (
    <Box flexDirection="column">
      {top}
      {runningPart(el, b, ctx)}
      {launchMode ? (
        <Box flexDirection="column">
          {heading(el, `Launch a ${b.draft!.workflow} run`, ctx.bodyColumns, b.draft!.confirmed ? 'launching' : 'waiting for you')}
          {b.draft!.overview.map(line => (
            <Text wrap="wrap">{line}</Text>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column">
          {heading(el, 'Saved settings', ctx.bodyColumns, b.dirty ? 'unsaved' : null)}
          <Text color={STYLE.muted} wrap="wrap">
            {'Each launch, in every project, starts from these, then the plugin options. A launch form can change any of them for its run.'}
          </Text>
          {b.draftWaiting ? notice(el, 'needsYou', 'a launch form waits for you') : null}
        </Box>
      )}
      {b.problems.map(x => notice(el, 'warning', x))}
      {runPart(el, b, ctx)}
      {rolesPart(el, b, ctx)}
      <Box flexDirection="column" marginTop={1}>
        <Text color={STYLE.muted} wrap="wrap">
          {`Saved to ${b.path}`}
        </Text>
      </Box>
      {launchMode
        ? actions(el, [
            { key: settingsKey('launch'), label: b.draft!.confirmed ? 'Launch again' : 'Launch', primary: !b.draft!.confirmed },
            { key: settingsKey('cancel'), label: 'Cancel' },
            { key: settingsKey('save-defaults'), label: 'Save as defaults' },
            { key: settingsKey('show-defaults'), label: 'Saved settings' },
          ])
        : actions(el, [
            { key: settingsKey('save'), label: 'Save', primary: b.dirty },
            b.dirty && { key: settingsKey('revert'), label: 'Revert' },
            b.draftWaiting && { key: settingsKey('show-launch'), label: 'Back to the launch form', primary: !b.dirty },
          ])}
    </Box>
  )
}
