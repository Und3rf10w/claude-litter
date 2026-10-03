// WP-O: the browser's generated summary (15.6, "The summary"): triggers
// noted by the hooks, run from O's own tick (never a send), inputs capped and
// hashed, p.complete with prompts/swarm-summary.ts, the last good summary
// kept, and swarm.summary when the goal line changes. Display-only.
//
// Stub (phase 2b-1, package C), not built yet: the signatures are the
// contract; the bodies are O's. Until then nothing is noted, and there's no summary.

import type { SwarmSummary } from './types'

/**
 * Why a summary is due: the lead's turn ended, a node messaged the lead (L);
 * a node finished, the guard denied a node, a node reported (P).
 * C's choice of names.
 */
export type SummaryTrigger = 'lead-turn' | 'to-lead' | 'finished' | 'denied' | 'report'

/** Synchronous: only marks the swarm due. */
export function noteSummaryTrigger(swarm: string, why: SummaryTrigger): void {}

/** The last good summary, with whether a newer event exists; null when there's none. */
export function summaryOf(swarm: string): SwarmSummary | null {
  return null
}
