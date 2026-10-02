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
  'plan.write': recordGeneric,
  'gate.amend': recordGeneric,
  'wiki.write': recordGeneric,
  'run.find': recordRunFind,
}

/** In order: the agent map first, so the others can look an agent up. */
export const SPOOL_CONSUMERS: readonly SpoolConsumer[] = [consumeAgents, consumeOutput, consumeLifecycle]
