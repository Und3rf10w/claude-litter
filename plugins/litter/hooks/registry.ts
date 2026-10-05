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
import { recordRepairBudget, recordRepairStart } from './repair'
import { recordGateAmend, recordGateWiden, recordPlanWrite } from './plan'
import { consumeInflight } from './inflight'
import { recordRuleFind, recordRuleImport, recordRuleOpen, recordRuleProposal } from './rules/records'
import { recordProbe, recordProposal, recordVerdict } from './design/records'

export const KIND_HANDLERS: Readonly<Record<KnownKind, RecordHandler>> = {
  finding: recordGeneric,
  coverage: recordGeneric,
  mechanism: recordGeneric,
  // Design (phase 4): the prober's, the author's and the design critic's, design/records.ts's (WP-BC).
  probe: recordProbe,
  reframe: recordGeneric,
  proposal: recordProposal,
  verdict: recordVerdict,
  'design.feedback': recordGeneric,
  verify: recordVerify,
  'land.intent': recordGeneric,
  land: recordLand,
  'land.abandoned': recordGeneric,
  'land.blocked': recordGeneric,
  'rule.propose': recordRuleProposal,
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
  'plan.write': recordPlanWrite,
  'gate.amend': recordGateAmend,
  'gate.widen': recordGateWiden,
  'wiki.write': recordGeneric,
  // Rules (phase 3): the rules ledger's, rules/records.ts.
  'rule.open': recordRuleOpen,
  'rule.import': recordRuleImport,
  'run.find': recordRunFind,
  'rule.find': recordRuleFind,
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
  // Repair (phase 2b-2): the launcher's two; the mod's own are refused before this table.
  // A bound swarm node's verify, verdict and land never reach it (ledger.ts routes them to swarm/gate.ts).
  'run.repair': recordGeneric,
  'repair.declined': recordGeneric,
  'repair.start': recordRepairStart,
  'repair.budget': recordRepairBudget,
  // Design (phase 4): the mod's own, refused before this table.
  'design.result': recordGeneric,
  'design.deliver': recordGeneric,
}

/**
 * In order: the agent map first, so the others can look an agent up; an
 * execute run's in-flight flag next (phase 3, decision 24), so a gate-critic's
 * start or stop is seen before its output; the swarm's consumer next, so its
 * in-flight table sees a call before anything acts on it; the worktree
 * records before the outputs, so a writer's result finds its worktree.
 */
export const SPOOL_CONSUMERS: readonly SpoolConsumer[] = [
  consumeAgents,
  consumeInflight,
  consumeSwarm,
  consumeWorktrees,
  consumeOutput,
  consumeLifecycle,
]
