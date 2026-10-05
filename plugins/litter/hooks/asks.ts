// The permission ask line (phase 5; COMMON step 3, decision 1): ask.sh's
// `ask` spool lines, each paired with guard.sh's `call` start for the same
// agent, tool and detail (which gives the tool_use_id), and kept open until
// that call's `call` end or `deny`, the agent's stop, or a later call start
// from the same agent. The band (CB) draws openAsks(); each ask also gets
// one p.notice, for a later engine that draws it under permission prompts.
// Owner: WP-CF.
//
// CA's stub: no ask is ever open.

import type { Ports } from './ports'
import type { SpoolConsumer } from './hookfiles'
import type { AskEntry } from './uitypes'

/** In SPOOL_CONSUMERS after consumeInflight (registry.ts): the `ask`, `call`, `deny` and `stop` lines. */
export const consumeAsks: SpoolConsumer = async (ctx, line) => {}

/** The asks open now, oldest first, for the band (module memory; restoreAsks fills it after a reload). */
export function openAsks(): AskEntry[] {
  return []
}

/** session.start: the open asks back after a reload, from where CF keeps them. */
export async function restoreAsks(p: Ports): Promise<void> {}

/** The ui tick's second step (uitick.ts): asks whose call ended or whose agent stopped are closed. */
export async function asksTick(p: Ports): Promise<void> {}
