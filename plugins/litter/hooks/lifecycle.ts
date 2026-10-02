// A run from run.start to run.end: the launch preconditions, generations,
// the completion decoder, TaskStop settling, reconcile (plan section 9,
// "Launch preconditions", "Run lifecycle", "Continuations"). Owner: phase 1b,
// work package D.

import type { PortHook, PromptSubmitHook, SessionEndHook, TurnCompleteHook } from './hooktypes'
import type { Ports } from './ports'
import type { SpoolConsumer } from './hookfiles'
import type { RecordHandler } from './records/core'
import { notYet } from './records/core'

/** `run.start`: every check that can refuse, then the lock, the branch, the run files and the args. */
export const recordRunStart: RecordHandler = async () => notYet('run.start', '1b')

/** `run.end` from a launcher: the fallback, accepted only for the open generation's task id. */
export const recordRunEnd: RecordHandler = async () => notYet('run.end', '1b')

/** prompt.submit: a task notification for a run's task writes run.end and summary.md, then next(e). */
export const onPromptSubmit: PortHook<PromptSubmitHook> = async (_p, e, next) => next(e)

/** turn.complete: a main turn that ends with a pending launch and no Workflow call releases the lock. */
export const onTurnComplete: PortHook<TurnCompleteHook> = async (_p, e, next) => next(e)

/** session.end: stops the lease beat; a pending launch is ended (launch_failed). */
export const onSessionEnd: PortHook<SessionEndHook> = async (_p, e, next) => next(e)

/** At session.start, after the spools are drained: every run without a run.end is reconciled. */
export async function reconcileRuns(_p: Ports, _litterDir: string): Promise<void> {}

/** Spool consumer: stops (settling a stopping run), mode switches, a lost isolation context. */
export const consumeLifecycle: SpoolConsumer = async () => {}
