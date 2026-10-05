// The band above the prompt (phase 5; COMMON step 1, decision 7): a row per
// active run and live swarm, then a row per open permission ask, built into
// the `band` atom by the ui tick and drawn by render.tsx. Keys are
// `band:<action>[:<arg>]`. Owner: WP-CB.
//
// CA's stub: no band. bandShows answers false, so register.tsx's render
// passes to next(e); the tick and the refresh write nothing; a press passes on.

import type { Ports } from '../ports'
import type { BandPressHook, BandRender, PortHook } from '../hooktypes'
import type { BandView } from '../../types/index'

/**
 * Whether the band draws litter's rows for this render: a view with rows, no
 * survey holding the band (`e.props.hasSurvey`). False passes the render on.
 */
export function bandShows(view: BandView | null, e: BandRender): view is BandView {
  return false
}

/** The ui tick's first step (uitick.ts): the band's view again, written only when it changed. */
export async function bandTick(p: Ports): Promise<void> {}

/** After a /clear wiped $.state (clear.ts): the band's view again, written even when unchanged. */
export async function refreshBand(p: Ports): Promise<void> {}

/** The band's presses ([Board], [Browser], [Hide]); a key not `band:` passes on. */
export const onBandUi: { press: PortHook<BandPressHook> } = {
  press: async (p, e, next) => next(e),
}
