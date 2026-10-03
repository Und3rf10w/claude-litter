// The rules store (plan 16.1-16.6): the three scopes' folders, what counts as
// accepted, proposals, and the steps that are yours alone. Owner: phase 3,
// package AD.
//
// acceptRule, dismissRule and retireRule are reached only from the rules
// pane's ui.press (AF's rules/pane.tsx): no path from the record tool, a
// spool line, a timer or a skill may call them (COMMON, "Only you accept").
//
// AA's stub: no rules load, no proposals list, and every step that's yours
// refuses. proposeFromCritic keeps today's behavior (COMMON step 0): it
// appends the proposal to the run's ledger as output.ts and swarm/gate.ts
// did before phase 3.

import type { Ports } from '../ports'
import type {
  CriticProposal,
  LoadedRule,
  ProposalRef,
  RuleProposeBody,
  RuleRef,
  RuleScope,
  RuleStatus,
  RuleType,
} from '../records/rules'
import { appendRecord, readLedger } from '../ledgercore'
import { runDir } from '../layout'

const NOT_BUILT = "rules can't be accepted, dismissed or retired yet (phase 3, package AD)"

/**
 * Every rule file in the three scopes, each with its standing (16.4: read per
 * file at every load) and the version in force; and what's wrong (a file
 * that doesn't parse, one id in two scopes, an `overrides` refused).
 */
export async function loadRules(p: Ports, litterDir: string): Promise<{ rules: LoadedRule[]; problems: string[] }> {
  return { rules: [], problems: [] }
}

/**
 * One of a gate critic's `proposed_rules` (output.ts; swarm/gate.ts): AD
 * makes it a `rule.propose` in the repo rules ledger with `source: 'critic'`
 * and whatever it has of run, gate, swarm, verify_id, tool_use_id and index,
 * once per tool_use_id and index (once per verify_id and index for a
 * swarm's). A throw is logged by the caller.
 *
 * The stub: the run-ledger `rule.propose` of before phase 3, with the same
 * body: a run's critic's `{ rule, source, tool_use_id, index }`, once per
 * tool_use_id and index; a swarm critic's `{ rule, source, verify_id, round }`.
 */
export async function proposeFromCritic(p: Ports, litterDir: string, input: CriticProposal): Promise<void> {
  const dir = runDir(litterDir, input.run)
  const { run, rule, source, by } = input
  if (input.swarm !== undefined) {
    await appendRecord(p, dir, { run, kind: 'rule.propose', by, body: { rule, source, verify_id: input.verify_id, round: input.round } })
    return
  }
  const { records } = await readLedger(p, dir, run)
  const done = records.some(
    r => r.kind === 'rule.propose' && r.by.source === 'agent' && r.body.tool_use_id === input.tool_use_id && r.body.index === input.index,
  )
  if (done) return
  await appendRecord(p, dir, { run, kind: 'rule.propose', by, body: { rule, source, tool_use_id: input.tool_use_id, index: input.index } })
}

/**
 * The proposals in both rules ledgers that fit `filter` (all of them when
 * it's empty), oldest first, each with its status: `proposed` until a
 * rule.accept or rule.dismiss cites it, and `dismissed` from the start when
 * its folded text matches a dismissed one's (16.3).
 */
export async function proposalsOf(
  p: Ports,
  litterDir: string,
  filter: { run?: string; swarm?: string; status?: RuleStatus[] },
): Promise<{ ref: ProposalRef; body: RuleProposeBody; status: RuleStatus }[]> {
  return []
}

/** What [Accept] accepts: a proposal, or an unverified rule file (absolute) as it is. */
export type AcceptWhat = { proposal: ProposalRef } | { file: string }
/**
 * What the pane holds until [Accept]: the scope it asked for, and the paths
 * and type [Edit…] set (`paths` already through narrowPaths).
 */
export type AcceptOpts = { scope?: RuleScope; paths?: string[]; type?: RuleType }

/**
 * Accepts, from the rules pane's ui.press only: resolves the scope and id,
 * writes the file atomically (an edit moves the old version to `.history`),
 * then records `rule.accept { …, via: 'ui' }`. `path` is the file written.
 */
export async function acceptRule(p: Ports, litterDir: string, what: AcceptWhat, opts?: AcceptOpts): Promise<{ ok: true; path?: string } | { ok: false; reason: string }> {
  return { ok: false, reason: NOT_BUILT }
}

/** Dismisses a proposal, from the rules pane's ui.press only: `rule.dismiss { proposal, folded, via: 'ui' }`. */
export async function dismissRule(p: Ports, litterDir: string, proposal: ProposalRef): Promise<{ ok: true; path?: string } | { ok: false; reason: string }> {
  return { ok: false, reason: NOT_BUILT }
}

/** Retires an accepted rule, from the rules pane's ui.press only: its file to `.history`, then `rule.retire { id, version, via: 'ui' }`. */
export async function retireRule(p: Ports, litterDir: string, rule: RuleRef): Promise<{ ok: true; path?: string } | { ok: false; reason: string }> {
  return { ok: false, reason: NOT_BUILT }
}

/** The exact file acceptRule would write for `what` and `opts`, and its absolute path; writes nothing. */
export async function previewAccept(p: Ports, litterDir: string, what: AcceptWhat, opts?: AcceptOpts): Promise<{ ok: true; path: string; text: string } | { ok: false; reason: string }> {
  return { ok: false, reason: NOT_BUILT }
}

/** Paths for a proposal, as [Edit…] takes them: each validated by match.ts's validPattern, sorted, without duplicates. Stores nothing. */
export function narrowPaths(paths: string[]): { ok: true; paths: string[] } | { ok: false; reason: string } {
  return { ok: false, reason: `paths can't be checked yet (phase 3, package AD); ${paths.length} given` }
}
