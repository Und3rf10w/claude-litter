// WP-J: how revisions, briefs, drafts and proposals are stored (15.8's
// layout, the mod the only writer): swarm.json and revisions/, the drafts in
// $.store, staged proposals, accept and reject.
//
// Stub (phase 2b-1, package C): the signatures are the contract; the bodies are J's.
// Where the brief left a parameter open, the doc comment says what C picked.

import type { Ports } from '../ports'
import type { ProposedChange } from '../records/swarm'
import type { DiffCounts, Draft, ProposalView, RevisionFrom, SavedSwarm, SpecError, SwarmListing, SwarmSpec } from './types'

const notBuilt = (name: string): Error => new Error(`litter: ${name} is not built yet (WP-J)`)

/** How a revision came to be, for its `swarm.revision` record. */
export type RevisionNote = {
  from: RevisionFrom
  /** `from: 'proposal'`. */
  proposal?: number
  /** `from: 'template'`. */
  template?: string
  changes: string[]
}

/** A save's answer: the new revision, or every validation error (nothing written). */
export type SaveResult = { ok: true; revision: number } | { ok: false; errors: SpecError[] }

/** Every swarm under `<litterDir>/swarms/`, for the start screen. */
export async function listSwarms(p: Ports, litterDir: string): Promise<SwarmListing[]> {
  throw notBuilt('listSwarms')
}

/** The latest saved revision (swarm.json and briefs/), or null when the swarm was never saved. */
export async function readSaved(p: Ports, litterDir: string, name: string): Promise<SavedSwarm | null> {
  throw notBuilt('readSaved')
}

/** Revision `n` (revisions/<n>.json and its briefs), or null. */
export async function readRevision(p: Ports, litterDir: string, name: string, n: number): Promise<SavedSwarm | null> {
  throw notBuilt('readRevision')
}

/**
 * Validates, then writes the next revision, then swarm.json and briefs/, and
 * records `swarm.revision`. C's choice: the spec and briefs as one argument,
 * and the record's fields as `note`; J builds the ValidateCtx itself.
 */
export async function saveRevision(
  p: Ports,
  litterDir: string,
  name: string,
  saved: { spec: SwarmSpec; briefs: Record<string, string> },
  note: RevisionNote,
): Promise<SaveResult> {
  throw notBuilt('saveRevision')
}

/** The builder's draft from `$.store` (`litter.swarm.draft.<litterDir>.<name>`), or null. */
export async function readDraft(p: Ports, litterDir: string, name: string): Promise<Draft | null> {
  throw notBuilt('readDraft')
}

export async function writeDraft(p: Ports, litterDir: string, name: string, draft: Draft): Promise<void> {
  throw notBuilt('writeDraft')
}

export async function clearDraft(p: Ports, litterDir: string, name: string): Promise<void> {
  throw notBuilt('clearDraft')
}

/**
 * Stages a proposal that passed the checks under `proposals/<n>/` and records
 * `swarm.proposal`. C's choice: the decoded tool input with its spec typed;
 * it answers the proposal's number and the diff's counts.
 */
export async function stageProposal(
  p: Ports,
  litterDir: string,
  name: string,
  proposal: { baseRevision: number; spec: SwarmSpec; briefs: Record<string, string>; changes: ProposedChange[] },
): Promise<{ n: number; diff: DiffCounts }> {
  throw notBuilt('stageProposal')
}

/** A staged proposal's diff over the current draft, conflicts marked, or null when there's no proposal `n`. */
export async function readProposal(p: Ports, litterDir: string, name: string, n: number): Promise<ProposalView | null> {
  throw notBuilt('readProposal')
}

/**
 * Applies all of proposal `n`, or only the change paths `pick` names, over the
 * draft, validates, writes the next revision, and records the decision.
 * C's choice: `pick` is `'all'` or the list of change paths.
 */
export async function acceptProposal(p: Ports, litterDir: string, name: string, n: number, pick: 'all' | readonly string[]): Promise<SaveResult> {
  throw notBuilt('acceptProposal')
}

/** Records only the decision, `accepted: 'none'`; nothing reaches briefs/. */
export async function rejectProposal(p: Ports, litterDir: string, name: string, n: number): Promise<void> {
  throw notBuilt('rejectProposal')
}

/** A node's brief text at a revision (revisions/<n>/briefs/<node>.md), or null when it has none. */
export async function briefTextFor(p: Ports, litterDir: string, name: string, revision: number, node: string): Promise<string | null> {
  throw notBuilt('briefTextFor')
}
