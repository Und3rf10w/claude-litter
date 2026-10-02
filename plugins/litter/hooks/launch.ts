// The launch check on Workflow, the TaskStop observer and the agent.spawn
// block on litter roles (plan sections 6 and 9). Owner: phase 1b, work package D.
//
// Every hook here is wired in register.tsx with a literal matcher and a .catch
// that decides by target as well as caller (plan section 9, "Mod hooks").
// Once next(e) has run, nothing here throws: a catch that ran after the engine
// launched a workflow or stopped a task would answer for a call that happened.

import type {
  PortHook,
  SpawnCatch,
  SpawnHook,
  TaskStopCatch,
  TaskStopHook,
  WorkflowCatch,
  WorkflowHook,
} from './hooktypes'
import type { Ports } from './ports'
import type { Workflow } from './records/run'
import type { RunRef } from './lifecycle'
import { RESUMABLE, WORKFLOWS } from './records/run'
import { session } from './session'
import { sha256 } from './fsx'
import { readLock, releaseLock, removeLease, stillHeld, stopLease } from './lock'
import {
  activate,
  clearPending,
  closeOpenAsInterrupted,
  deactivate,
  endRun,
  getPending,
  loadLaunchable,
  modeRefusal,
  observeStop,
  openGeneration,
  patchRunPolicy,
  repoOf,
  runOfWorkflowId,
  takeLock,
  wfKey,
} from './lifecycle'

const deny = (text: string) => ({ deny: text })
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/**
 * The shipped workflow scripts by sha256, once per module instance (phase 1
 * ships none). A failed read rejects and isn't kept, so the catch refuses the
 * call and the next one reads again.
 */
let shipped: Promise<Map<string, Workflow>> | null = null
function shippedScripts(p: Ports): Promise<Map<string, Workflow>> {
  shipped ??= (async () => {
    const out = new Map<string, Workflow>()
    for (const w of WORKFLOWS) {
      const path = `${p.pluginRoot}/workflows/${w}.js`
      if (await p.fs.exists(path)) out.set(await sha256(await p.fs.read(path)), w)
    }
    return out
  })().catch(err => {
    shipped = null
    throw err
  })
  return shipped
}

/**
 * A scriptPath's content. A relative path is the session's working directory's,
 * which `pwd` with no cwd reports (Ports has no cwd of its own). Rejects when
 * unreadable, so the catch refuses the call.
 */
async function scriptText(p: Ports, path: string): Promise<string> {
  if (path.startsWith('/')) return p.fs.read(path)
  const pwd = await p.run(['pwd'])
  const dir = pwd.stdout.trim()
  if (pwd.code !== 0 || !dir.startsWith('/')) throw new Error(`can't resolve the relative scriptPath ${path}`)
  return p.fs.read(`${dir}/${path.replace(/^\.\//, '')}`)
}

/** The call's args as an object; a JSON-encoded string is read as what it encodes. */
function argsOf(v: unknown): Record<string, unknown> | null {
  let a = v
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a)
    } catch {
      return null
    }
  }
  return typeof a === 'object' && a !== null && !Array.isArray(a) ? (a as Record<string, unknown>) : null
}

type Launched = { taskId: string; runId: string; scriptPath: string | null } | { error: string }

/** What next(e) said about the launch: the task and run ids, or the error (plan section 9, "run.launch"). */
function launchedOf(r: { deny?: string; isError?: true; text?: string; result?: unknown }): Launched {
  if (r.deny) return { error: r.deny }
  if (r.isError) return { error: r.text ?? String(r.result ?? 'the Workflow call failed') }
  const res = r.result as { taskId?: unknown; runId?: unknown; scriptPath?: unknown; error?: unknown } | undefined
  if (!res || typeof res !== 'object') return { error: 'the Workflow call returned no result' }
  if (typeof res.error === 'string' && res.error !== '') return { error: res.error }
  if (typeof res.taskId !== 'string' || res.taskId === '') return { error: 'the Workflow call returned no task id' }
  if (typeof res.runId !== 'string' || res.runId === '') return { error: 'the workflow launched without a local run id (a remote launch), which litter can\'t track' }
  return { taskId: res.taskId, runId: res.runId, scriptPath: typeof res.scriptPath === 'string' ? res.scriptPath : null }
}

/** tool.call on `Workflow`: the launch check, the args swap and run.launch. */
export const workflowCheck: PortHook<WorkflowHook> = async (p, e, next) => {
  const name = e.name ?? ''
  const scriptPath = typeof e.scriptPath === 'string' && e.scriptPath !== '' ? e.scriptPath : null
  const resume = typeof e.resumeFromRunId === 'string' && e.resumeFromRunId !== '' ? e.resumeFromRunId : null

  // Refused for every caller: a named launch takes `script ?? <the named script>`.
  if (typeof e.script === 'string' && (name !== '' || scriptPath !== null)) {
    return deny("litter guard: a Workflow call can't set 'script' together with 'name' or 'scriptPath'; send only one of them")
  }

  // Is it litter's? By name, by the script's content wherever the file is, or by the run it resumes.
  const named = name.startsWith('litter:') ? name.slice('litter:'.length) : null
  const byContent = scriptPath ? ((await shippedScripts(p)).get(await sha256(await scriptText(p, scriptPath))) ?? null) : null
  const litterDir = session().litterDir
  let resumeOf: RunRef | null = null
  if (resume) {
    // The index is global: a run of another project's litter directory is litter's, and not this one's to resume.
    const ix = (await p.store.get(wfKey(resume))) as RunRef | undefined
    if (ix && typeof ix.runDir === 'string') {
      if (litterDir !== null && ix.litterDir !== litterDir) {
        return deny(`litter: ${resume} is run ${ix.run} of another repository (${ix.litterDir}); resume it from a session there`)
      }
      resumeOf = ix
    } else if (litterDir) {
      resumeOf = await runOfWorkflowId(p, litterDir, resume)
    }
  }
  if (named === null && byContent === null && resumeOf === null) return next(e)

  if (named !== null && !(WORKFLOWS as readonly string[]).includes(named)) {
    return deny(`litter: there's no litter workflow '${name}'; litter's are ${WORKFLOWS.map(w => `litter:${w}`).join(', ')}`)
  }
  if (named !== null && scriptPath !== null && byContent === null) {
    return deny(`litter: '${name}' with a scriptPath runs that file instead of litter's script; launch it by name alone`)
  }
  const workflow = (byContent ?? named) as Workflow | null
  if (named !== null && byContent !== null && named !== byContent) {
    return deny(`litter: the scriptPath holds litter:${byContent}, not ${name}`)
  }

  const refused = session().toolsRefused
  if (refused) {
    return deny(
      `litter: the mod's tools were refused (${refused}). A managed allowedMcpServers list or allowManagedModsOnly does this; ` +
        'without mcp__litter__record nothing guards a run, so no litter run launches',
    )
  }
  if (!litterDir) {
    return deny(`litter: this session has no litter directory (${session().litterDirError ?? "session.start hasn't resolved it"}), so no litter run can launch`)
  }
  const mode = await modeRefusal(p, litterDir)
  if (mode.refusal) return deny(mode.refusal)

  if (resume) {
    if (!resumeOf) {
      return deny(`litter: resumeFromRunId ${resume} isn't a run litter launched in this project; resume a litter run by its own run id, or start a new one`)
    }
    return resumeRun(p, e, next, litterDir, workflow, resumeOf)
  }
  return freshLaunch(p, e, next, litterDir, workflow!)
}

type E = Parameters<PortHook<WorkflowHook>>[1]
type Next = Parameters<PortHook<WorkflowHook>>[2]
type R = Awaited<ReturnType<PortHook<WorkflowHook>>>

/** A launch that follows a run.start: matched by args.run, args swapped for the stored copy. */
async function freshLaunch(p: Ports, e: E, next: Next, litterDir: string, workflow: Workflow): Promise<R> {
  const args = argsOf(e.args)
  if (!args || typeof args.run !== 'string') {
    return deny("litter: pass the 'args' that run.start returned, as a JSON object; its 'run' names the run")
  }
  const sessionId = await p.sessionId()
  const pending = await getPending(p, litterDir)
  if (!pending || pending.run !== args.run || pending.session !== sessionId) {
    return deny(`litter: run ${args.run} has no pending run.start in this session; record run.start first, then launch with the args it returns`)
  }
  if (pending.workflow !== workflow) {
    return deny(`litter: run ${pending.run} was started for litter:${pending.workflow}, not litter:${workflow}`)
  }
  const ref: RunRef = { run: pending.run, runDir: pending.runDir, litterDir }
  const repo = repoOf(litterDir)
  if (!(await stillHeld(p, repo, pending.oid))) {
    stopLease(pending.oid)
    await clearPending(p, litterDir)
    await endRun(p, ref, { taskId: null, generation: 0, status: 'launch_failed', reason: 'lock lost', source: 'mod' }).catch(err =>
      p.log(`run ${ref.run}: launch_failed not recorded: ${errText(err)}`),
    )
    return deny("litter: the project's run lock was lost since run.start (another session recovered it); start again with run.start")
  }
  const loaded = await loadLaunchable(p, ref)
  if (!loaded.ok) return deny(`litter: ${loaded.reason}; start again with run.start`)

  // worktree.sh waits for a litter run id while `launching` is set.
  await patchRunPolicy(p, litterDir, ref.run, r => ({ ...r, launching: true }))
  let r: R
  try {
    r = await next({ ...e, args: loaded.json.args })
  } catch (err) {
    // The catch answers; the launch stays pending, and turn.complete ends it.
    await patchRunPolicy(p, litterDir, ref.run, x => ({ ...x, launching: false })).catch(() => false)
    throw err
  }
  try {
    const launched = launchedOf(r)
    stopLease(pending.oid)
    await clearPending(p, litterDir)
    if ('error' in launched) {
      await endRun(p, ref, { taskId: null, generation: 0, status: 'launch_failed', reason: launched.error, source: 'mod' })
    } else {
      await openGeneration(p, ref, 'run.launch', launched, sessionId, pending.oid)
      await patchRunPolicy(p, litterDir, ref.run, x => ({ ...x, launching: false, runIds: [...new Set([...x.runIds, launched.runId])] }))
      await removeLease(p, litterDir, pending.oid)
    }
  } catch (err) {
    p.log(`run ${ref.run}: the launch wasn't recorded: ${errText(err)}`)
  }
  return r
}

/** A `resumeFromRunId` of a litter run: its own script, a resumable end, the lock again, then run.resume. */
async function resumeRun(p: Ports, e: E, next: Next, litterDir: string, workflow: Workflow | null, ref: RunRef): Promise<R> {
  const loaded = await loadLaunchable(p, ref)
  if (!loaded.ok) return deny(`litter: ${loaded.reason}; it can't be resumed`)
  const { json, st } = loaded
  if (workflow === null) {
    return deny(`litter: run ${ref.run} resumes only with litter's own script: Workflow({ name: 'litter:${json.workflow}', resumeFromRunId })`)
  }
  if (workflow !== json.workflow) return deny(`litter: run ${ref.run} is a litter:${json.workflow} run, not litter:${workflow}`)
  const given = argsOf(e.args)
  if (given && given.run !== undefined && given.run !== ref.run) {
    return deny(`litter: resumeFromRunId belongs to run ${ref.run}, but the args name run ${String(given.run)}; a resume takes its own run's args`)
  }
  const latest = st.latest
  if (!latest) return deny(`litter: run ${ref.run} never launched, so there's nothing to resume`)
  if (latest.stopping && !latest.end) return deny(`litter: run ${ref.run} is still stopping; resume it once its stop has settled`)
  if (latest.end && !RESUMABLE.includes(latest.end.status)) {
    return deny(`litter: run ${ref.run} ended ${latest.end.status}; only failed, stopped and interrupted runs resume. Start a continuation (continueOf) instead`)
  }

  // The lock: the run's own, or taken again like step 0 of a launch.
  const repo = repoOf(litterDir)
  const sessionId = await p.sessionId()
  const lock = await readLock(p, repo)
  let oid: string
  let took = false
  if (lock && lock.blob?.run === ref.run) oid = lock.oid
  else {
    const t = await takeLock(p, litterDir, { run: ref.run, session: sessionId, acquiredAt: await p.now() }, false)
    if (!t.ok) return deny(t.error)
    oid = t.held.oid
    took = true
  }
  const runIds = [...new Set(st.generations.map(g => g.runId))]
  await activate(p, litterDir, json, sessionId, { runIds, launching: true })
  const undo = async () => {
    if (took) await releaseLock(p, repo, oid)
    if (latest.end) await deactivate(p, litterDir, ref.run)
  }
  let r: R
  try {
    r = await next({ ...e, args: json.args })
  } catch (err) {
    await undo().catch(() => {})
    throw err
  }
  try {
    const launched = launchedOf(r)
    if ('error' in launched) {
      p.log(`run ${ref.run}: resume failed: ${launched.error}`)
      await undo()
    } else {
      if (st.open) await closeOpenAsInterrupted(p, ref)
      await openGeneration(p, ref, 'run.resume', launched, sessionId, oid)
      await patchRunPolicy(p, litterDir, ref.run, x => ({ ...x, launching: false, runIds: [...new Set([...x.runIds, launched.runId])] }))
    }
  } catch (err) {
    p.log(`run ${ref.run}: the resume wasn't recorded: ${errText(err)}`)
  }
  return r
}

/**
 * Its catch: refuses a `litter:` name, any `scriptPath`, `script` with `name`
 * or `scriptPath`, and any `wf_` resume; passes everything else on.
 */
export const workflowCheckFailed: WorkflowCatch = async ($, e, next) => {
  const name = e.name ?? ''
  const litter =
    name.startsWith('litter:') ||
    typeof e.scriptPath === 'string' ||
    (typeof e.script === 'string' && name !== '') ||
    (typeof e.resumeFromRunId === 'string' && e.resumeFromRunId.startsWith('wf_'))
  return litter ? { deny: 'litter guard failed: Workflow; refusing (retry the launch)' } : next(e)
}

/** tool.call on `TaskStop`: observes a stop of the run's task (run.stopping), after the stop went through. */
export const taskStop: PortHook<TaskStopHook> = async (p, e, next) => {
  const r = await next(e)
  try {
    const taskId = e.task_id ?? e.shell_id
    if (typeof taskId === 'string' && taskId !== '' && !r.deny && !r.isError) await observeStop(p, taskId)
  } catch (err) {
    p.log(`TaskStop: the stop wasn't recorded (reconcile will): ${errText(err)}`)
  }
  return r
}

/** Its catch only observes: the mod reconciles the stop later. */
export const taskStopFailed: TaskStopCatch = async ($, e, next) => next(e)

const isRole = (type: string) => type.startsWith('litter:') && !type.startsWith('litter:sw-')

/**
 * agent.spawn: the main thread can't spawn a litter role (section 6). The
 * spawner is `parentAgentId`, absent on the main thread. Swarm types pass on
 * to the swarm's spawn check (phase 2b).
 */
export const spawnBlock: PortHook<SpawnHook> = async (_p, e, next) => {
  if (e.parentAgentId === undefined && isRole(e.subagentType)) {
    return { deny: `litter roles run inside litter workflows only; use /litter:design, /litter:execute or /litter:fanout instead of spawning ${e.subagentType}` }
  }
  return next(e)
}

/** Its catch: refuses a main-thread spawn of a litter type, swarm types included. */
export const spawnBlockFailed: SpawnCatch = async ($, e, next) => {
  return e.parentAgentId === undefined && e.subagentType.startsWith('litter:')
    ? { deny: 'litter guard failed: agent.spawn; refusing' }
    : next(e)
}
