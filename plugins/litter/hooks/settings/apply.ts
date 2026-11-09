// A litter run's roles on the models and efforts their run set
// (run.json's `roles`, settings/registry.ts), and what you change for one
// while it runs.
//
// The model at the spawn: a workflow's `agent()` raises agent.spawn, whose
// `model` rewrite applies to it (2.1.300) and resolves an alias as the Agent
// tool's parameter does. The effort at every request: agent.spawn has none,
// so turn.step sets it, as the swarm's nodes get theirs (swarm/admit.ts's
// tunedStep). The engine drops an effort for a model that takes none, and
// lowers one the model has no such level for.
//
// What you set for a running agent (the Agents section's Model and effort
// panel) goes on its next request, through turn.step alone, so a model there
// is a full id (turn.step resolves no alias); a new model reads its
// conversation again, without the cache. Every role agent a run starts is
// remembered here, in module memory and $.store (a reload keeps it), until
// its run ends.

import type { Ports } from '../ports'
import type { PortHook, SpawnHook, TurnStepHook } from '../hooktypes'
import type { RoleName } from '../hookfiles'
import type { Workflow } from '../records/run'
import type { Effort, StepEffort } from '../swarm/types'
import { roleOf, readPolicy } from '../policy'
import { session } from '../session'
import { checkedRunJson } from '../runjson'
import { runDir } from '../layout'
import { serial } from '../fsx'
import { runOfWorkflowId } from '../lifecycle'
import { modelCheck } from '../swarm/admit'
import { isEffort, isFullModel, type RoleTune } from './registry'

/** One role agent of a run: who it is, what its run set, what you set, and what its last request named. */
export type RoleAgent = {
  agentId: string
  run: string
  /** The workflow's `wf_` run id. */
  runId: string
  workflow: Workflow
  role: RoleName
  /** run.json's `roles` entry for its role, as its spawn read it. */
  tune: RoleTune
  /** What you set while it runs; absent for nothing. */
  live?: RoleTune
  /** Its last request's model and effort, as the engine resolved them. */
  seen?: { model: string; effort: StepEffort | null; at: number }
  started: number
}

/** A run's roles as its run.json set them, by `wf_` id, read once per run. */
type RunTunes = { run: string; workflow: Workflow; roles: Partial<Record<RoleName, RoleTune>> }

const STORE_KEY = 'litter.roleAgents'
/** At most this many are remembered: the oldest go first. A run's end forgets its own. */
const MAX_AGENTS = 400

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const agents = new Map<string, RoleAgent>()
const runs = new Map<string, RunTunes | null>()
let loaded: Promise<void> | null = null

/** The remembered agents, read from $.store once per module instance. */
function ready(p: Ports): Promise<void> {
  loaded ??= (async () => {
    try {
      const v = (await p.store.get(STORE_KEY)) as Record<string, RoleAgent> | undefined
      if (v && typeof v === 'object') for (const [id, a] of Object.entries(v)) if (a && typeof a === 'object' && a.agentId === id && !agents.has(id)) agents.set(id, a)
    } catch (err) {
      p.log(`settings: the role agents weren't read back: ${errText(err)}`)
    }
  })()
  return loaded
}

/** Writes the remembered agents, in order, after dropping the oldest past the cap. */
function persist(p: Ports): Promise<void> {
  while (agents.size > MAX_AGENTS) agents.delete(agents.keys().next().value!)
  const snapshot = Object.fromEntries(agents)
  return serial(STORE_KEY, () => p.store.set(STORE_KEY, snapshot)).catch(err => p.log(`settings: the role agents weren't saved: ${errText(err)}`))
}

/**
 * A workflow run's roles: the run its `wf_` id launched (the index the
 * Workflow hook writes), else the active run, for an agent a script starts
 * before that hook has written the index. Null for a run litter doesn't own,
 * or whose run.json changed outside it.
 */
async function runTunes(p: Ports, litterDir: string, runId: string): Promise<RunTunes | null> {
  if (runs.has(runId)) return runs.get(runId)!
  let run: string | null = null
  try {
    run = (await runOfWorkflowId(p, litterDir, runId))?.run ?? null
    if (run === null) run = (await readPolicy(p, litterDir))?.run?.run ?? null
  } catch (err) {
    p.log(`settings: the run of ${runId} wasn't found: ${errText(err)}`)
  }
  if (run === null) return null
  const c = await checkedRunJson(p, { run, runDir: runDir(litterDir, run) })
  if (!c.ok) {
    p.log(`settings: ${run}'s roles weren't read: ${c.reason}`)
    runs.set(runId, null)
    return null
  }
  const out: RunTunes = { run, workflow: c.json.workflow, roles: c.json.roles ?? {} }
  runs.set(runId, out)
  return out
}

/**
 * agent.spawn for a workflow's agent of a litter role: its run's model for
 * the role, when one is set, and the agent remembered for its requests and
 * the Agents section. Any other spawn passes on as it came.
 */
export const roleSpawn: PortHook<SpawnHook> = async (p, e, next) => {
  const role = e.workflow !== undefined && e.resume === undefined ? roleOf(e.subagentType) : null
  const litterDir = session().litterDir
  if (role === null || !litterDir || !e.workflow?.runId) return next(e)
  await ready(p)
  const run = await runTunes(p, litterDir, e.workflow.runId)
  const tune = run?.roles[role as RoleName] ?? {}
  const r = await next(tune.model !== undefined && tune.model !== e.model ? { ...e, model: tune.model } : e)
  // Past next(e) nothing may throw: the catch would start the agent a second time.
  if (run && typeof r.agentId === 'string' && r.agentId !== '') {
    try {
      agents.set(r.agentId, { agentId: r.agentId, run: run.run, runId: e.workflow.runId, workflow: run.workflow, role: role as RoleName, tune, started: await p.now() })
      await persist(p)
    } catch (err) {
      p.log(`settings: ${r.agentId} (${role}) wasn't remembered: ${errText(err)}`)
    }
  }
  return r
}

type Step = Parameters<TurnStepHook>[1]

/**
 * A role agent's request with its effort, and the model you set for it: its
 * live setting over its run's. Anyone else's goes on as it came.
 */
export async function roleStep(p: Ports, e: Step): Promise<Step> {
  if (e.agentId === undefined) return e
  await ready(p)
  const a = agents.get(e.agentId)
  if (!a) return e
  const model = a.live?.model
  const effort = a.live?.effort ?? a.tune.effort
  const newModel = model !== undefined && model !== e.model
  const newEffort = effort !== undefined && effort !== e.effort
  const s: Step = newModel || newEffort ? { ...e, ...(newModel ? { model } : {}), ...(newEffort ? { effort } : {}) } : e
  const was = a.seen
  if (!was || was.model !== s.model || was.effort !== (s.effort ?? null)) {
    a.seen = { model: s.model, effort: s.effort ?? null, at: await p.now() }
    void persist(p)
  }
  return s
}

/** The role agents remembered for a run, or every one, oldest first. */
export async function roleAgents(p: Ports, run?: string): Promise<RoleAgent[]> {
  await ready(p)
  return [...agents.values()].filter(a => run === undefined || a.run === run)
}

/** One role agent, or undefined. */
export async function roleAgent(p: Ports, agentId: string): Promise<RoleAgent | undefined> {
  await ready(p)
  return agents.get(agentId)
}

/** A run that ended: its agents are forgotten (lifecycle.ts, after run.end), and its roles' read. */
export async function forgetRoleAgents(p: Ports, run: string): Promise<void> {
  await ready(p)
  let changed = false
  for (const [id, a] of agents) {
    if (a.run !== run) continue
    agents.delete(id)
    changed = true
  }
  for (const [id, r] of runs) if (r?.run === run) runs.delete(id)
  if (changed) await persist(p)
}

export type TuneOutcome = { ok: true; text: string } | { ok: false; reason: string }

/** The check a model no request here has named goes through first (swarm/admit.ts's), through one table for tier 2. */
export const checks = {
  model: (p: Ports, model: string): Promise<string | null> => modelCheck(p, model),
}

/**
 * The Model and effort panel's change for a running role agent: `model` or
 * `effort` set, or null for its run's. A model no request here has named
 * yet is checked with a short completion first. It applies from the agent's
 * next request.
 */
export async function tuneRole(p: Ports, input: { agentId: string; model?: string | null; effort?: Effort | null }): Promise<TuneOutcome> {
  await ready(p)
  const a = agents.get(input.agentId)
  if (!a) return { ok: false, reason: `${input.agentId} isn't a litter run's agent this session knows` }
  const who = `the ${a.role} of run ${a.run}`
  if (input.model !== undefined) {
    if (input.model === null) {
      if (a.live?.model === undefined) return { ok: true, text: `${who} has its run's model already` }
      const { model: _gone, ...rest } = a.live
      a.live = rest
      await persist(p)
      return { ok: true, text: `${who} goes back to its run's model from its next request` }
    }
    const model = input.model.trim()
    if (!isFullModel(model)) return { ok: false, reason: `${model} isn't a full model id (such as claude-sonnet-5-5): a running agent's request takes no alias` }
    if (model === (a.live?.model ?? a.seen?.model)) return { ok: true, text: `${who} uses ${model} already` }
    const seen = [...agents.values()].some(x => x.seen?.model === model)
    if (!seen) {
      const bad = await checks.model(p, model)
      if (bad) return { ok: false, reason: `${model} wasn't set: ${bad}` }
    }
    a.live = { ...a.live, model }
    await persist(p)
    return { ok: true, text: `${who} uses ${model} from its next request; it reads its conversation again, without the cache` }
  }
  if (input.effort !== undefined) {
    if (input.effort !== null && !isEffort(input.effort)) return { ok: false, reason: `${String(input.effort)} isn't an effort` }
    if (input.effort === null) {
      if (a.live?.effort === undefined) return { ok: true, text: `${who} has its run's effort already` }
      const { effort: _gone, ...rest } = a.live
      a.live = rest
      await persist(p)
      return { ok: true, text: `${who} goes back to its run's effort from its next request` }
    }
    if (input.effort === (a.live?.effort ?? a.tune.effort)) return { ok: true, text: `${who} has that effort already` }
    a.live = { ...a.live, effort: input.effort }
    await persist(p)
    return { ok: true, text: `${who} thinks at ${input.effort} from its next request` }
  }
  return { ok: false, reason: 'nothing to change: give a model or an effort' }
}

/** Tier 2: module memory as a fresh load finds it. */
export function resetRoleAgentsForTests(): void {
  agents.clear()
  runs.clear()
  loaded = null
}
