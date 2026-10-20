// Claude Code's answer to ledgercore's `owned` (Ports.ledgerOwner): whether
// `$.store` owns a run's ledger. A v2 head is this store's own append. A
// legacy head (from before heads had a version, set by an append or a read)
// is this store's unless the ledger shows Codex's litterd driving the run: a
// run.launch or run.resume with a `driver`, or a `codex-` task id. With no
// head here, another host or Codex home drives it, or this store was lost:
// the mod doesn't act on it on its own. litterd answers for Codex with its own
// driver records.
//
// The shared ledgers (rules, swarm specs and launches) don't ask: Claude Code
// is their only writer until Codex has one of its own, so on Claude Code
// their appends adopt a chain whose head `$.store` lost (a lost store mustn't
// keep you from accepting a rule or a proposal), and on Codex they refuse
// (rules/ledger.ts, records/swarm.ts).

import type { AppendOptions, LedgerRead, Owner } from './ledgercore'
import type { StoredRecord } from './records/core'
import { session } from './session'

/** A shared ledger's append on Codex. */
export class NotOnCodex extends Error {
  constructor(what: string) {
    super(`${what} isn't written on Codex yet; do it from Claude Code`)
  }
}

/** The options for an append to a shared ledger (`what`, for the refusal): adopt on Claude Code; on Codex it throws NotOnCodex. */
export function sharedAppend(what: string): AppendOptions {
  if (session().host === 'codex') throw new NotOnCodex(what)
  return { adopt: true }
}

export async function claudeLedgerOwner(_runDir: string, read: LedgerRead): Promise<Owner> {
  if (read.anchor === 'head') return 'mine'
  if (read.anchor === 'none') return 'other'
  return read.records.some(codexDriven) ? 'other' : 'mine'
}

const codexDriven = (r: StoredRecord): boolean =>
  (r.kind === 'run.launch' || r.kind === 'run.resume') &&
  (r.body.driver !== undefined || (typeof r.body.taskId === 'string' && r.body.taskId.startsWith('codex-')))
