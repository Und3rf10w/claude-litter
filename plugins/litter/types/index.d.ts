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

declare module 'claude-code' {
  interface PluginState {
    litter: { board: LitterBoard }
  }
}
