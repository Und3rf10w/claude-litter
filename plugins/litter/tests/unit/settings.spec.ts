// Tier 2: the run settings (hooks/settings/): the registry's checks, the
// saved files and their order, run.start's `roles` and its launch form's
// draft, a role agent's model at its spawn and its effort at each request,
// and a change for a running agent. Real git in scratch repos; the config
// dir is a scratch folder, never ~/.claude.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordCtx, RecordInput } from '../../hooks/records/core'
import type { RunJson, RunStartReply } from '../../hooks/records/run'
import { recordRunStart } from '../../hooks/lifecycle'
import { updateSession } from '../../hooks/session'
import { stopLease } from '../../hooks/lock'
import { modePath, runDir, runJsonPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { checkRoleTune, layTune, runSettingDef, runValueOf, ROLES_OF } from '../../hooks/settings/registry'
import { loadSettings, optionsWithSaved, parseSettings, saveSettings, savedRun } from '../../hooks/settings/store'
import { draftDeps, readDraft, recordRunDraft, writeDraft } from '../../hooks/settings/draft'
import { checks, resetRoleAgentsForTests, roleAgent, roleSpawn, roleStep, tuneRole } from '../../hooks/settings/apply'
import { nodePorts, runAfters, scratch, scratchRepo, type TestPorts } from './support/node-ports'
import type { SettingsPaneView } from '../../types/index'
import { onSettingsUi, resetSettingsPaneForTests, settingsKey } from '../../hooks/settings/pane'
import { openSection, resetHubForTests } from '../../hooks/ui/hub'

setDefaultTimeout(120_000)

const PLAN = ['# Plan', '', '### G1: First', 'Files: a.txt', 'Checks: test -f a.txt', 'Done when: a.txt exists', ''].join('\n')

type World = { p: TestPorts; dir: string; litterDir: string; config: string; ctx: RecordCtx }

const cleanups: (() => void)[] = []
/** The pane's opener, as settings/pane.tsx set it; the form tests stand in for it, so it's put back after each. */
const OPEN_FORM = draftDeps.openForm

async function world(): Promise<World> {
  const s = scratch()
  cleanups.push(s.cleanup)
  const dir = realpathSync(s.dir)
  const c = scratch('litter-config-')
  cleanups.push(c.cleanup)
  const config = realpathSync(c.dir)
  const base = nodePorts({ sessionId: 'session-a' })
  const p: TestPorts = {
    ...base,
    cwd: async () => dir,
    run: (argv, init) => {
      if (argv[0] === 'jq') return Promise.resolve({ code: 0, stdout: 'jq-1.7.1\n', stderr: '', truncated: false })
      return base.run(argv, init?.cwd ? init : { ...init, cwd: dir })
    },
  }
  // The ports' configDir reads its own object's value: set it there.
  base.configDirValue = config
  const { git } = await scratchRepo(p, dir)
  await p.fs.write(join(dir, 'plan.md'), PLAN)
  await git('add', 'plan.md')
  await git('commit', '-q', '-m', 'plan')
  const litterDir = join(dir, '.claude', 'litter')
  await p.fs.write(modePath(litterDir), 'default\n')
  updateSession({ litterDir, host: 'claude-code' })
  return { p, dir, litterDir, config, ctx: { p, caller: { agentId: null, agentType: null }, litterDir, options: normalizeOptions({ verify: ['true'] }) } }
}

afterEach(() => {
  stopLease()
  resetRoleAgentsForTests()
  resetSettingsPaneForTests()
  resetHubForTests()
  draftDeps.openForm = OPEN_FORM
  updateSession({ litterDir: null, host: 'claude-code' })
  for (const c of cleanups.splice(0)) c()
})

const AUTH = { authorized: ['change a.txt'] }
const execute = (w: World, extra: Record<string, unknown> = {}) =>
  recordRunStart(w.ctx, { kind: 'run.start', workflow: 'execute', planPath: 'plan.md', ...AUTH, ...extra } as RecordInput)

function okReply(r: unknown): RunStartReply {
  if (!(r as { ok: boolean }).ok) throw new Error(`refused: ${JSON.stringify(r)}`)
  return r as RunStartReply
}

const runJsonOf = async (w: World, run: string): Promise<RunJson> => JSON.parse(await w.p.fs.read(runJsonPath(runDir(w.litterDir, run)))) as RunJson

describe('the registry', () => {
  test("a role entry: an alias or a full id, one of the five efforts, null for the session's; nothing else", () => {
    expect(checkRoleTune({ model: 'sonnet', effort: 'low' }, 'r')).toEqual({ ok: true, value: { model: 'sonnet', effort: 'low' } })
    expect(checkRoleTune({ model: 'claude-opus-5-5[1m]' }, 'r')).toEqual({ ok: true, value: { model: 'claude-opus-5-5[1m]' } })
    expect(checkRoleTune({ model: null, effort: null }, 'r')).toEqual({ ok: true, value: { model: null, effort: null } })
    expect(checkRoleTune({ model: 'rm -rf /' }, 'r').ok).toBe(false)
    expect(checkRoleTune({ effort: 'huge' }, 'r').ok).toBe(false)
    expect(checkRoleTune({ temperature: 1 }, 'r').ok).toBe(false)
    expect(checkRoleTune('opus', 'r').ok).toBe(false)
  })

  test('an entry over another: a value replaces, null clears, absent keeps', () => {
    expect(layTune({ model: 'opus', effort: 'high' }, { effort: 'low' })).toEqual({ model: 'opus', effort: 'low' })
    expect(layTune({ model: 'opus', effort: 'high' }, { model: null })).toEqual({ effort: 'high' })
    expect(layTune(undefined, undefined)).toEqual({})
  })

  test("a field's text back to its setting's value, in its range", () => {
    expect(runValueOf(runSettingDef('maxRounds')!, '3')).toEqual({ ok: true, value: 3 })
    expect(runValueOf(runSettingDef('maxRounds')!, '11').ok).toBe(false)
    expect(runValueOf(runSettingDef('adversary')!, 'true')).toEqual({ ok: true, value: true })
    expect(runValueOf(runSettingDef('widen')!, 'critic')).toEqual({ ok: true, value: 'critic' })
    expect(runValueOf(runSettingDef('widen')!, 'anyone').ok).toBe(false)
  })
})

describe('the saved settings', () => {
  test('a file is read leniently: each bad entry dropped and named, the rest kept', () => {
    const problems: string[] = []
    const s = parseSettings(
      { v: 1, run: { maxRounds: 2, maxAttempts: 99, nope: 1 }, roles: { executor: { model: 'opus' }, wizard: { model: 'opus' }, relay: { effort: 'warp' } } },
      'f',
      problems,
    )
    expect(s).toEqual({ v: 1, run: { maxRounds: 2 }, roles: { executor: { model: 'opus' } } })
    expect(problems).toHaveLength(4)
    expect(parseSettings({ run: {} }, 'f', problems)).toEqual({ v: 1, run: {}, roles: {} })
  })

  test('yours, in the config dir, over the plugin option, key by key; saved through the same checks', async () => {
    const w = await world()
    await saveSettings(w.p, { v: 1, run: { maxAttempts: 5, maxRounds: 2 }, roles: { executor: { model: 'opus', effort: 'high' } } })
    const s = await loadSettings(w.p)
    expect(s.path).toBe(join(w.config, 'litter', 'settings.json'))
    const o = w.ctx.options
    expect(savedRun(s, 'maxAttempts', o)).toEqual({ value: 5, from: 'user' })
    expect(savedRun(s, 'repair', o)).toEqual({ value: 'auto', from: 'option' })
    expect(optionsWithSaved(o, s).maxAttempts).toBe(5)
    await expect(saveSettings(w.p, { v: 1, run: { maxAttempts: 0 }, roles: {} })).rejects.toThrow('maxAttempts')
  })

  test("no config dir: nothing is read or saved, never ~/.claude, and a repository's file is never read", async () => {
    const w = await world()
    await w.p.fs.write(join(w.dir, '.litter', 'settings.json'), JSON.stringify({ v: 1, run: {}, roles: { relay: { model: 'haiku' } } }))
    expect((await loadSettings(w.p)).user.roles).toEqual({})
    w.p.configDir = async () => {
      throw new Error('no config dir')
    }
    const s = await loadSettings(w.p)
    expect(s.path).toBeNull()
    await expect(saveSettings(w.p, { v: 1, run: {}, roles: {} })).rejects.toThrow('no config dir')
  })
})

describe("run.start's roles", () => {
  test("the saved roles, the launch's over them, in run.json and the reply; adversary from the saved settings", async () => {
    const w = await world()
    await saveSettings(w.p, { v: 1, run: { adversary: true }, roles: { executor: { model: 'opus', effort: 'high' }, relay: { model: 'haiku' } } })
    const r = okReply(await execute(w, { roles: { executor: { effort: 'max' }, relay: { model: null } } }))
    expect(r.roles).toEqual({ executor: { model: 'opus', effort: 'max' } })
    const json = await runJsonOf(w, r.run)
    expect(json.roles).toEqual({ executor: { model: 'opus', effort: 'max' } })
    expect((json.args as { adversary?: boolean }).adversary).toBe(true)
  })

  test("a role the workflow doesn't run, or a bad value, is refused naming the field", async () => {
    const w = await world()
    const r = await execute(w, { roles: { author: { model: 'opus' } } })
    expect(r).toMatchObject({ ok: false, field: 'roles.author' })
    expect((r as { allowed?: string[] }).allowed).toEqual([...ROLES_OF.execute])
    expect(await execute(w, { roles: { executor: { effort: 'extreme' } } })).toMatchObject({ ok: false, field: 'roles.executor.effort' })
  })

  test('nothing set anywhere: run.json has no roles', async () => {
    const w = await world()
    const r = okReply(await execute(w))
    expect(r.roles).toBeUndefined()
    expect((await runJsonOf(w, r.run)).roles).toBeUndefined()
  })
})

describe('the launch form', () => {
  test('run.draft fills every setting and role; run.start takes the confirmed draft over its own fields, once', async () => {
    const w = await world()
    draftDeps.openForm = async () => true
    await saveSettings(w.p, { v: 1, run: { maxAttempts: 4 }, roles: { relay: { model: 'haiku' } } })
    const d = (await recordRunDraft(w.ctx, { kind: 'run.draft', workflow: 'execute', overview: ['G1: First'], roles: { executor: { model: 'sonnet' } } } as RecordInput)) as {
      ok: true
      draft: string
      form: boolean
    }
    expect(d).toMatchObject({ ok: true, form: true })
    const draft = (await readDraft(w.p, w.litterDir))!
    expect(draft.run).toEqual({ maxAttempts: 4, adversary: false, widen: 'ask', repair: 'auto', repairRounds: 3, repairAgents: 6 })
    expect(draft.roles).toEqual({
      executor: { model: 'sonnet', effort: null },
      'gate-critic': { model: null, effort: null },
      adversary: { model: null, effort: null },
      relay: { model: 'haiku', effort: null },
    })
    // Unconfirmed: refused.
    expect(await execute(w, { draft: d.draft })).toMatchObject({ ok: false, field: 'draft' })
    // The form's edits, then Launch.
    draft.run.maxAttempts = 2
    draft.roles.relay = { model: null, effort: 'low' }
    draft.confirmed = Date.now()
    await writeDraft(w.p, w.litterDir, draft)
    const r = okReply(await execute(w, { draft: d.draft, maxAttempts: 9 }))
    expect(r.warnings?.some(x => x.includes('maxAttempts'))).toBe(true)
    const json = await runJsonOf(w, r.run)
    expect(json.roles).toEqual({ executor: { model: 'sonnet' }, relay: { effort: 'low' } })
    expect(await readDraft(w.p, w.litterDir)).toBeNull()
  })

  test("no pane: form false, the settings in the reply, and no draft kept", async () => {
    const w = await world()
    draftDeps.openForm = async () => false
    const d = await recordRunDraft(w.ctx, { kind: 'run.draft', workflow: 'design' } as RecordInput)
    expect(d).toMatchObject({ ok: true, form: false, draft: null })
    expect(await readDraft(w.p, w.litterDir)).toBeNull()
  })

  test("a setting or role the workflow doesn't take is refused", async () => {
    const w = await world()
    draftDeps.openForm = async () => true
    expect(await recordRunDraft(w.ctx, { kind: 'run.draft', workflow: 'plan', settings: { maxRounds: 3 } } as RecordInput)).toMatchObject({ ok: false, field: 'settings.maxRounds' })
    expect(await recordRunDraft(w.ctx, { kind: 'run.draft', workflow: 'fanout', roles: { planner: {} } } as RecordInput)).toMatchObject({ ok: false, field: 'roles.planner' })
  })
})

describe("a role agent's model and effort", () => {
  type Spawn = Parameters<typeof roleSpawn>[1]
  type Step = Parameters<typeof roleStep>[1]
  const spawnOf = (type: string): Spawn =>
    ({ tool_use_id: 't', prompt: 'x', description: 'd', subagentType: type, model: undefined, parentModel: 'claude-opus-5-5', background: true, fork: false, workflow: { runId: 'wf_abc123', agentIndex: 1 } }) as unknown as Spawn
  const stepOf = (agentId: string, model = 'claude-opus-5-5', effort?: string): Step => ({ turnId: 'turn', index: 0, model, ...(effort ? { effort } : {}), agentId }) as unknown as Step

  test("the spawn gets its run's model for the role (the active run, before the index is written); each request its effort", async () => {
    const w = await world()
    const r = okReply(await execute(w, { roles: { executor: { model: 'sonnet', effort: 'low' } } }))
    const seen: Spawn[] = []
    const next = (async (e: Spawn) => {
      seen.push(e)
      return { model: 'claude-sonnet-5-5', agentId: 'agent-1' }
    }) as unknown as Parameters<typeof roleSpawn>[2]
    await roleSpawn(w.p, spawnOf('litter:executor'), next)
    expect(seen[0]!.model).toBe('sonnet')
    expect((await roleAgent(w.p, 'agent-1'))?.run).toBe(r.run)
    // A role with nothing set passes as it came.
    const n2 = (async (e: Spawn) => ({ model: e.model ?? 'x', agentId: 'agent-2' })) as unknown as Parameters<typeof roleSpawn>[2]
    const out = await roleSpawn(w.p, spawnOf('litter:relay'), n2)
    expect(out).toMatchObject({ agentId: 'agent-2' })
    const s = await roleStep(w.p, stepOf('agent-1', 'claude-sonnet-5-5', 'high'))
    expect(s).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' })
    // Anyone else's request is untouched.
    const other = stepOf('stranger', 'claude-opus-5-5', 'high')
    expect(await roleStep(w.p, other)).toBe(other)
  })

  test("what you set for a running agent goes on its next request; null goes back to its run's", async () => {
    const w = await world()
    okReply(await execute(w, { roles: { executor: { effort: 'low' } } }))
    const next = (async () => ({ model: 'claude-opus-5-5', agentId: 'agent-1' })) as unknown as Parameters<typeof roleSpawn>[2]
    await roleSpawn(w.p, spawnOf('litter:executor'), next)
    const checked: string[] = []
    checks.model = async (_p, m) => (checked.push(m), null)
    expect(await tuneRole(w.p, { agentId: 'agent-1', model: 'sonnet' })).toMatchObject({ ok: false })
    expect(await tuneRole(w.p, { agentId: 'agent-1', model: 'claude-haiku-4-5-20251001' })).toMatchObject({ ok: true })
    expect(checked).toEqual(['claude-haiku-4-5-20251001'])
    expect(await tuneRole(w.p, { agentId: 'agent-1', effort: 'max' })).toMatchObject({ ok: true })
    expect(await roleStep(w.p, stepOf('agent-1'))).toMatchObject({ model: 'claude-haiku-4-5-20251001', effort: 'max' })
    expect(await tuneRole(w.p, { agentId: 'agent-1', effort: null })).toMatchObject({ ok: true })
    expect(await roleStep(w.p, stepOf('agent-1'))).toMatchObject({ effort: 'low' })
    expect(await tuneRole(w.p, { agentId: 'nobody', effort: 'low' })).toMatchObject({ ok: false })
  })
})

describe('the Settings section', () => {
  const view = (w: World) => w.p.views.settings as SettingsPaneView
  const press = (w: World, element: string) => onSettingsUi.press(w.p, { element } as never, (async () => ({})) as never)
  const select = (w: World, element: string, value: string) => onSettingsUi.select(w.p, { element, value } as never, (async () => ({})) as never)
  const input = (w: World, element: string, value: string) => onSettingsUi.input(w.p, { element, value, kind: 'submit' } as never, (async () => ({})) as never)

  test("the launch form: its workflow's settings and roles, edits written to the draft, and Launch asks the lead with the draft's id", async () => {
    const w = await world()
    const d = (await recordRunDraft(w.ctx, { kind: 'run.draft', workflow: 'fanout', overview: ['t1: a task'] } as RecordInput)) as unknown as { draft: string; form: boolean }
    expect(d.form).toBe(true)
    const b = view(w).body!
    expect(b.mode).toBe('launch')
    expect(b.draft).toMatchObject({ workflow: 'fanout', overview: ['t1: a task'], confirmed: false })
    expect(b.run.map(f => f.key)).toEqual(['settings:run:repair', 'settings:run:repairRounds', 'settings:run:repairAgents'])
    expect(b.roles.map(r => r.role)).toEqual([...ROLES_OF.fanout])
    await select(w, settingsKey('model', 'researcher'), 'haiku')
    await select(w, settingsKey('effort', 'verifier'), 'high')
    await input(w, settingsKey('run', 'repairRounds'), '5')
    // Another id, typed.
    await select(w, settingsKey('model', 'executor'), '__other')
    expect(view(w).body!.roles.find(r => r.role === 'executor')!.modelId).not.toBeNull()
    await input(w, settingsKey('model-id', 'executor'), 'claude-sonnet-5-5[1m]')
    const draft = (await readDraft(w.p, w.litterDir))!
    expect(draft.roles.researcher).toEqual({ model: 'haiku', effort: null })
    expect(draft.roles.verifier).toEqual({ model: null, effort: 'high' })
    expect(draft.roles.executor).toEqual({ model: 'claude-sonnet-5-5[1m]', effort: null })
    expect(draft.run.repairRounds).toBe(5)
    await press(w, settingsKey('launch'))
    expect((await readDraft(w.p, w.litterDir))!.confirmed).not.toBeNull()
    await runAfters(w.p, { all: true })
    expect(w.p.submitted.at(-1)).toContain(`draft: '${d.draft}'`)
  })

  test('Save as defaults writes the form to the chosen file; Cancel drops the draft and tells the lead', async () => {
    const w = await world()
    await recordRunDraft(w.ctx, { kind: 'run.draft', workflow: 'plan', roles: { planner: { model: 'opus', effort: 'max' } } } as RecordInput)
    await press(w, settingsKey('save-defaults'))
    expect((await loadSettings(w.p)).user.roles.planner).toEqual({ model: 'opus', effort: 'max' })
    await press(w, settingsKey('cancel'))
    expect(await readDraft(w.p, w.litterDir)).toBeNull()
    await runAfters(w.p, { all: true })
    expect(w.p.submitted.at(-1)).toContain('cancelled')
  })

  test('the saved settings: every setting and role, each unset until set; Save writes your file', async () => {
    const w = await world()
    await openSection(w.p, 'settings', 'defaults')
    let b = view(w).body!
    expect(b.mode).toBe('defaults')
    expect(b.roles).toHaveLength(14)
    expect(b.run.every(f => f.value === '')).toBe(true)
    await select(w, settingsKey('effort', 'author'), 'xhigh')
    await input(w, settingsKey('run', 'maxRounds'), '12')
    expect(view(w).notice?.level).toBe('error')
    await input(w, settingsKey('run', 'maxRounds'), '6')
    b = view(w).body!
    expect(b.dirty).toBe(true)
    await press(w, settingsKey('save'))
    expect((await loadSettings(w.p)).user).toEqual({ v: 1, run: { maxRounds: 6 }, roles: { author: { effort: 'xhigh' } } })
  })
})
