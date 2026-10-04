// The rules ledgers (decision 17): one chain per store, through ledgercore,
// in layout.ts's repoRulesLedgerDir (`repo`: every project and local rule's
// records and every proposal made in this repository) and userRulesLedgerDir
// (`user`: every user rule's), with the `run` RULES_LEDGER_RUN. Owner:
// phase 3, package AD.
//
// The chains follow the run ledger's rules (section 9, "Ledger"): one file
// per record under `<store>/ledger/`, chained by sha256, the head in
// `$.store`, written only by the mod. A tampered chain refuses every append
// (ledgercore's LedgerTampered), and the store reads nothing in it as an
// acceptance.

import type { Ports } from '../ports'
import type { Author, StoredRecord } from '../records/core'
import type { RuleLedgerStore, RuleRecordKind } from '../records/rules'
import type { LedgerRead } from '../ledgercore'
import { appendRecord, readLedger } from '../ledgercore'
import { RULES_LEDGER_RUN, repoRulesLedgerDir, userRulesLedgerDir } from '../layout'

/** The folder holding `store`'s `ledger/`. The user store's rejects when the config dir can't be found (ports.ts, configDir). */
export async function ruleLedgerDir(p: Ports, litterDir: string, store: RuleLedgerStore): Promise<string> {
  return store === 'repo' ? repoRulesLedgerDir(litterDir) : userRulesLedgerDir(await p.configDir())
}

/**
 * Appends one record to `store`'s chain and answers it as stored. `litterDir`
 * places the repo store; the user store is under `p.configDir()`. A tampered
 * chain refuses (ledgercore's LedgerTampered).
 */
export async function appendRuleRecord<B>(p: Ports, litterDir: string, store: RuleLedgerStore, kind: RuleRecordKind, by: Author, body: B): Promise<StoredRecord<B>> {
  return appendRecord(p, await ruleLedgerDir(p, litterDir, store), { run: RULES_LEDGER_RUN, kind, by, body })
}

/** Reads `store`'s chain, as ledgercore's readLedger reads a run's: in seq order, with `tampered` set when it's broken. */
export async function readRuleLedger(p: Ports, litterDir: string, store: RuleLedgerStore): Promise<LedgerRead> {
  return readLedger(p, await ruleLedgerDir(p, litterDir, store), RULES_LEDGER_RUN)
}
