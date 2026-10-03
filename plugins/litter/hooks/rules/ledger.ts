// The rules ledgers (decision 17): one chain per store, through ledgercore,
// in layout.ts's repoRulesLedgerDir (`repo`: every project and local rule's
// records and every proposal made in this repository) and userRulesLedgerDir
// (`user`: every user rule's), with the `run` RULES_LEDGER_RUN. Owner:
// phase 3, package AD.
//
// AA's stub: both throw.

import type { Ports } from '../ports'
import type { Author, StoredRecord } from '../records/core'
import type { RuleLedgerStore, RuleRecordKind } from '../records/rules'
import type { LedgerRead } from '../ledgercore'

/**
 * Appends one record to `store`'s chain and answers it as stored. `litterDir`
 * places the repo store; the user store is under `p.configDir()`. A tampered
 * chain refuses (ledgercore's LedgerTampered).
 */
export async function appendRuleRecord<B>(p: Ports, litterDir: string, store: RuleLedgerStore, kind: RuleRecordKind, by: Author, body: B): Promise<StoredRecord<B>> {
  throw new Error(`rules/ledger: appendRuleRecord isn't built yet (phase 3, package AD), for ${kind} in the ${store} store`)
}

/** Reads `store`'s chain, as ledgercore's readLedger reads a run's: in seq order, with `tampered` set when it's broken. */
export async function readRuleLedger(p: Ports, litterDir: string, store: RuleLedgerStore): Promise<LedgerRead> {
  throw new Error(`rules/ledger: readRuleLedger isn't built yet (phase 3, package AD), for the ${store} store`)
}
