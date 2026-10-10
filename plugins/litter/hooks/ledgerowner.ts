// Claude Code's answer to ledgercore's `owned` (Ports.ledgerOwner): whether
// `$.store` owns a ledger. litterd answers for Codex with its own driver
// records.
//
// For now every ledger is this store's, as before heads had a version: a
// headless one is adopted on its next append.

import type { LedgerRead, Owner } from './ledgercore'

export async function claudeLedgerOwner(_runDir: string, _read: LedgerRead): Promise<Owner> {
  return 'mine'
}
