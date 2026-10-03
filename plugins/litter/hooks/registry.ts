// Which module answers each record kind, and who consumes the spool. A static
// table, so `claude plugin validate` and the reader both see the whole wiring.
//
// Contract owner: phase 1a. A package adds its handler to its own module and,
// if a new kind needs a row here, says so in its report.

import type { RecordHandler } from './records/core'
import type { KnownKind } from './records/design'
import type { SpoolConsumer } from './hookfiles'
import { recordGeneric } from './records/design'
import { recordRunFind } from './litterdir'
import { recordVerify } from './verify'
import { recordLand } from './land'
import { consumeLifecycle, recordRunEnd, recordRunStart } from './lifecycle'
import { consumeAgents } from './policy'
import { consumeOutput } from './output'
import { recordIntegrate } from './integrate'
import { consumeWorktrees } from './worktrees'
import { recordSwarmBind } from './swarm/admit'
import { recordSwarmEnd } from './swarm/end'
import { consumeSwarm } from './swarm/observe'

export const KIND_HANDLERS: Readonly<Record<KnownKind, RecordHandler>> = {
  finding: recordGeneric,
  coverage: recordGeneric,
  mechanism: recordGeneric,
  probe: recordGeneric,
  reframe: recordGeneric,
  proposal: recordGeneric,
  verdict: recordGeneric,
  'design.feedback': recordGeneric,
  verify: recordVerify,
  'land.intent': recordGeneric,
  land: recordLand,
  'land.abandoned': recordGeneric,
  'land.blocked': recordGeneric,
  'rule.propose': recordGeneric,
  'task.bind': recordGeneric,
  'task.result': recordGeneric,
  integrate: recordIntegrate,
  'integrate.merge': recordGeneric,
  'integrate.conflict': recordGeneric,
  'integrate.skip': recordGeneric,
  'integrate.done': recordGeneric,
  'lock.recovered': recordGeneric,
  'lock.forced': recordGeneric,
  'run.start': recordRunStart,
  'run.launch': recordGeneric,
  'run.resume': recordGeneric,
  'run.stopping': recordGeneric,
  'run.end': recordRunEnd,
  'worktree.intent': recordGeneric,
  'worktree.create': recordGeneric,
  'worktree.setup_failed': recordGeneric,
  'worktree.removed': recordGeneric,
  'worktree.kept': recordGeneric,
  'plan.write': recordGeneric,
  'gate.amend': recordGeneric,
  'wiki.write': recordGeneric,
  'run.find': recordRunFind,
  // Swarms (phase 2b): the two kinds the tool takes have handlers; the mod's own are refused before this table.
  'swarm.revision': recordGeneric,
  'swarm.proposal': recordGeneric,
  'swarm.proposal.decided': recordGeneric,
  'swarm.start': recordGeneric,
  'swarm.worktree.intent': recordGeneric,
  'swarm.worktree': recordGeneric,
  'swarm.worktree.failed': recordGeneric,
  'swarm.worktree.removed': recordGeneric,
  'swarm.worktree.kept': recordGeneric,
  'swarm.instance': recordGeneric,
  'swarm.node': recordGeneric,
  'swarm.bind': recordSwarmBind,
  'swarm.event': recordGeneric,
  'swarm.summary': recordGeneric,
  'swarm.stop': recordGeneric,
  'swarm.stopping': recordGeneric,
  'swarm.handover': recordGeneric,
  'swarm.end': recordSwarmEnd,
  'session.rebind': recordGeneric,
}

/**
 * In order: the agent map first, so the others can look an agent up; the
 * swarm's consumer next, so its in-flight table sees a call before anything
 * acts on it; the worktree records before the outputs, so a writer's result
 * finds its worktree.
 */
export const SPOOL_CONSUMERS: readonly SpoolConsumer[] = [consumeAgents, consumeSwarm, consumeWorktrees, consumeOutput, consumeLifecycle]
