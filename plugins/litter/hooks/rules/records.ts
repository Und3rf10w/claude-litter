// The rules' record kinds through the tool (plan 16.9): rule.propose,
// rule.open, rule.import and the read-only rule.find. rule.accept,
// rule.dismiss and rule.retire never come through here: ledger.ts refuses
// them whatever the caller. Owner: phase 3, package AD.
//
// AA's stub: rule.propose is the handler moved from records/design.ts, its
// body unchanged (a proposal with a run goes to that run's ledger, one
// without is refused); the other three refuse as not built yet.

import type { RecordHandler } from '../records/core'
import { fail, notYet } from '../records/core'
import { bodyOf, needText, store } from '../records/design'

const RULE_MAX_BYTES = 8 * 1024
const bytes = (text: string) => new TextEncoder().encode(text).length

/**
 * `rule.propose { rule, source?, scope?, type?, paths?, when?, slug?, edits?, run? }`.
 * AD records it in the rules ledger, with or without a run (16.9).
 */
export const recordRuleProposal: RecordHandler = async (ctx, input) => {
  const missing = needText(input, 'rule', 'the rule as a person could accept it: the situation it applies to, then what to do or never do')
  if (missing) return missing
  if (bytes(input.rule as string) > RULE_MAX_BYTES) return fail(`litter: 'rule' is over ${RULE_MAX_BYTES} bytes; a rule goes into prompts, so cut it down`, 'rule')
  if (input.source !== undefined && typeof input.source !== 'string') return fail("litter: 'source' must be a string, e.g. user or critic", 'source')
  if (input.edits !== undefined && (typeof input.edits !== 'string' || !/^[A-Za-z0-9._-]+@[1-9][0-9]*$/.test(input.edits))) {
    return fail("litter: 'edits' names the rule an edit is for, as <id>@<version>", 'edits')
  }
  if (typeof input.run !== 'string') {
    return fail("litter: a rule.propose without a run goes to the rules ledger, which comes with rules (phase 3); name the run it came from in 'run'", 'run')
  }
  const source = input.source ?? (ctx.caller.agentId === null ? 'user' : 'agent')
  return store(ctx, input, { ...bodyOf(input), source })
}

/**
 * `rule.open { id }` or `rule.open { proposal: { store, seq } }`: records the
 * open in the rules ledger, then opens the rules pane on it (AF's
 * openRulesPane). A pane that doesn't open answers "run /litter-rules".
 */
export const recordRuleOpen: RecordHandler = async () => notYet('rule.open', '3')

/**
 * `rule.import { from: 'deepwork' }`, from the main thread: one rule.propose
 * per new guardrail (import.ts), a rule.import batch, then the pane on it.
 */
export const recordRuleImport: RecordHandler = async () => notYet('rule.import', '3')

/**
 * `rule.find { id }`, `{ status: [...] }`, `{ similar }` or `{ applicable }`:
 * read-only, it writes nothing. `applicable` is AE's findApplicable, exactly
 * what run.start would select. `status` arrives JSON-encoded from some
 * models: ledger.ts doesn't declare it (run.end's `status` is a string), so
 * this handler decodes it.
 */
export const recordRuleFind: RecordHandler = async () => notYet('rule.find', '3')
