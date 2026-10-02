// The launch check on Workflow, the TaskStop observer and the agent.spawn
// block on litter roles (plan sections 6 and 9). Owner: phase 1b, work package D.
//
// Every hook here is wired in register.tsx with a literal matcher and a .catch
// that decides by target as well as caller (plan section 9, "Mod hooks").
// The stubs pass everything on; the catches already refuse what's litter's.

import type {
  PortHook,
  SpawnCatch,
  SpawnHook,
  TaskStopCatch,
  TaskStopHook,
  WorkflowCatch,
  WorkflowHook,
} from './hooktypes'

/** tool.call on `Workflow`: the launch check, the args swap and run.launch. */
export const workflowCheck: PortHook<WorkflowHook> = async (_p, e, next) => next(e)

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

/** tool.call on `TaskStop`: observes a stop of the run's task (run.stopping). */
export const taskStop: PortHook<TaskStopHook> = async (_p, e, next) => next(e)

/** Its catch only observes: the mod reconciles the stop later. */
export const taskStopFailed: TaskStopCatch = async ($, e, next) => next(e)

/** agent.spawn: the main thread can't spawn a litter role; swarm types pass to the spawn check (phase 2b). */
export const spawnBlock: PortHook<SpawnHook> = async (_p, e, next) => next(e)

/** Its catch: refuses a main-thread spawn of a litter type. */
export const spawnBlockFailed: SpawnCatch = async ($, e, next) => {
  const fromMain = (e as { agentId?: string }).agentId === undefined
  return fromMain && e.subagentType.startsWith('litter:')
    ? { deny: 'litter guard failed: agent.spawn; refusing' }
    : next(e)
}
