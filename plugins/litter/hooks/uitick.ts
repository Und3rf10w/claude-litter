// Phase 5's one ui tick (WP-CA; COMMON decision 16): every 2 s, in order, the
// band (CB), the cards waiting for their run's end (CC's, WP-CH), the open
// permission asks (CF), and the `litter` pane (phase 5b, WP-DA: ui/hub.ts's
// litterTick, which refreshes only the section shown, and only while the
// pane is open; it took over the tasks and agents steps and the board's own
// timer). Each step is caught and logged on its own, so one that throws
// never stops the next, and the tick never overlaps itself: a tick still
// running when the next is due skips it. Each step writes only a view that
// changed.

import type { Ports } from './ports'
import { bandTick } from './band/view'
import { cardsTick } from './card/view'
import { asksTick } from './asks'
import { litterTick } from './ui/hub'

export const UI_TICK_MS = 2000

/**
 * The four steps, through one table so tier 2 can count and hold the calls.
 * Each reads its import when called, never at import time.
 */
export const deps = {
  bandTick: (p: Ports) => bandTick(p),
  cardsTick: (p: Ports) => cardsTick(p),
  asksTick: (p: Ports) => asksTick(p),
  litterTick: (p: Ports) => litterTick(p),
}
const defaults = { ...deps }

/** The order they run in: the band first, so the pane's strip counts what it just built. */
const STEPS = ['bandTick', 'cardsTick', 'asksTick', 'litterTick'] as const

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

let timer: { cancel(): void } | null = null
let ticking = false

/** At session.start: one `p.every(2000, …)`, replacing any earlier one. */
export function startUiTimer(p: Ports): void {
  timer?.cancel()
  timer = p.every(UI_TICK_MS, () => {
    if (ticking) return
    ticking = true
    uiTick(p)
      .catch((err: unknown) => p.log(`ui tick failed: ${errText(err)}`))
      .finally(() => {
        ticking = false
      })
  })
}

/** One tick: each step in order, a failure logged and the next still run. */
export async function uiTick(p: Ports): Promise<void> {
  for (const name of STEPS) {
    try {
      await deps[name](p)
    } catch (err) {
      p.log(`ui tick: ${name} failed: ${errText(err)}`)
    }
  }
}

/** Whether a tick is running now (tests). */
export const uiTicking = (): boolean => ticking

/** A fresh module's memory, for tests: no timer, no tick running, the real steps back in `deps`. */
export function resetUiTickForTests(): void {
  timer?.cancel()
  timer = null
  ticking = false
  Object.assign(deps, defaults)
}
