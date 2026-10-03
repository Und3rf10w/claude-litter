// WP-N: the panes' view models, plain JSON, built from state.ts, the ledgers
// and the other packages' read functions: the start screen, builder,
// proposal, browser, goal history, recovery card, unsettled report,
// read-only, and the doctor pane.
//
// Stub (phase 2b-1, package C): the signatures are the contract; the bodies are N's.
// The brief names no export here; C picked one builder per pane, which N may extend.

import type { DoctorPaneView, Ports, SwarmPaneView } from '../ports'

/** The swarm pane's current view, or null when it isn't open. */
export async function swarmView(p: Ports): Promise<SwarmPaneView | null> {
  throw new Error('litter: swarmView is not built yet (WP-N)')
}

/** The doctor pane's current view, or null when it isn't open. */
export async function doctorView(p: Ports): Promise<DoctorPaneView | null> {
  throw new Error('litter: doctorView is not built yet (WP-N)')
}
