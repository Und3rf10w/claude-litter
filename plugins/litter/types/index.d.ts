// litter's $.state contract (named in plugin.json as "types"). Self-contained:
// no import or reference. The board's values arrive with the board (phase 3);
// until then the mod keeps nothing in $.state, since /clear wipes it and every
// run fact lives in the ledger or $.store.

export type LitterBoard = {
  /** The run the board shows, or null. */
  run: string | null
  /** Bumped by the drain and the record tool, so readers redraw. */
  version: number
}

/**
 * The `litter-swarm` pane's view (plan 15.5, 15.6): plain data the mod writes
 * through `p.setView('swarm', …)` and register.tsx's ui.render hook draws.
 * Phase 2b's package N types it; until then it's loose.
 */
export type SwarmPaneView = { view: string; v: number } & Record<string, unknown>

/** The `litter-doctor` pane's view (plan 15.7). Package N types it. */
export type DoctorPaneView = { view: string; v: number } & Record<string, unknown>

declare module 'claude-code' {
  interface PluginState {
    litter: { board: LitterBoard; swarmPane: SwarmPaneView | null; doctorPane: DoctorPaneView | null }
  }
}
