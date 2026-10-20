// Tier 2: phase 5's ui tick (hooks/uitick.ts; WP-CA, COMMON decision 16): the
// band's, the waiting cards' (WP-CH), the asks' and the `litter` pane's
// (phase 5b, WP-DA) steps run in that order on every tick, a step that throws
// is logged and the next still runs, and the timer never overlaps itself. The
// steps are stood in for through `deps`; with the real steps and nothing to
// show, a tick writes nothing (the pane's step does nothing while `litter`
// isn't open: hub.spec.ts).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Ports } from '../../hooks/ports'
import { deps, resetUiTickForTests, startUiTimer, uiTick, uiTicking, UI_TICK_MS } from '../../hooks/uitick'
import { resetBandForTests } from '../../hooks/band/view'
import { resetCardsForTests } from '../../hooks/card/view'
import { resetAsksForTests } from '../../hooks/asks'
import { resetHubForTests } from '../../hooks/ui/hub'
import { fireEvery, nodePorts, type TestPorts } from './support/node-ports'

let p: TestPorts
let calls: string[]

/** Each step records its name; `hold` makes one wait until released. */
function recordSteps(over: Partial<Record<keyof typeof deps, (p: Ports) => Promise<void>>> = {}): void {
  for (const name of Object.keys(deps) as (keyof typeof deps)[]) {
    deps[name] = async (q: Ports) => {
      calls.push(name)
      await over[name]?.(q)
    }
  }
}

/** The fake clock moves on by one tick. */
const advance = () => {
  p.clock.now = (p.clock.now ?? 0) + UI_TICK_MS
}

/** Waits for `cond` across the event loop's turns, with a generous cap (the machine is busy). */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i++) await new Promise<void>(resolve => setTimeout(resolve, 0))
  expect(cond()).toBe(true)
}

beforeEach(() => {
  resetUiTickForTests()
  // The real steps' module memory, fresh: another spec's band, cards, asks or hub would be drawn.
  resetBandForTests()
  resetCardsForTests()
  resetAsksForTests()
  resetHubForTests()
  p = nodePorts()
  p.clock.now = 1_800_000_000_000
  calls = []
})

afterEach(() => {
  resetUiTickForTests()
})

/** Every step, in the order a tick runs them. */
const ORDER = ['bandTick', 'cardsTick', 'asksTick', 'litterTick']

describe('one tick', () => {
  test('runs the band, the waiting cards right after it, the asks and the litter pane, in that order', async () => {
    recordSteps()
    await uiTick(p)
    expect(calls).toEqual(ORDER)
    expect(p.logs).toEqual([])
  })

  test('a step that throws is logged, and the steps after it still run', async () => {
    recordSteps({
      cardsTick: async () => {
        throw new Error('a ledger is unreadable')
      },
      asksTick: async () => {
        throw new Error('the spool is unreadable')
      },
      litterTick: async () => {
        throw 'not an Error'
      },
    })
    await uiTick(p)
    expect(calls).toEqual(ORDER)
    expect(p.logs).toEqual([
      'ui tick: cardsTick failed: a ledger is unreadable',
      'ui tick: asksTick failed: the spool is unreadable',
      'ui tick: litterTick failed: not an Error',
    ])
  })

  test("with the real steps and nothing to show, a tick writes no view, logs nothing and opens nothing", async () => {
    await uiTick(p)
    expect(p.views).toEqual({})
    expect(p.logs).toEqual([])
    expect(p.panes.opened).toEqual([])
    expect(p.notices).toEqual([])
  })
})

describe('the timer', () => {
  test('ticks every 2 s, and a second start replaces the first', async () => {
    recordSteps()
    expect(UI_TICK_MS).toBe(2000)
    startUiTimer(p)
    startUiTimer(p)
    expect(p.timers.size).toBe(1)
    await fireEvery(p)
    await until(() => calls.length === ORDER.length && !uiTicking())
    expect(calls).toEqual(ORDER)
  })

  test('never overlaps itself: a tick due while one is held is skipped, and the next after it runs', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => (release = resolve))
    let holding = true
    recordSteps({
      litterTick: async () => {
        if (holding) await held
      },
    })
    startUiTimer(p)
    await fireEvery(p)
    await until(() => calls.includes('litterTick'))
    expect(uiTicking()).toBe(true)

    // Two more ticks come due on the fake clock while the first holds: both skip.
    advance()
    await fireEvery(p)
    advance()
    await fireEvery(p)
    expect(calls).toEqual(ORDER)

    holding = false
    release()
    await until(() => !uiTicking())
    expect(calls).toEqual(ORDER)

    advance()
    await fireEvery(p)
    await until(() => calls.length === 2 * ORDER.length && !uiTicking())
    expect(calls.slice(ORDER.length)).toEqual(ORDER)
  })

  test('a tick whose steps all throw still lets the next one run', async () => {
    recordSteps({
      bandTick: async () => {
        throw new Error('a')
      },
      cardsTick: async () => {
        throw new Error('e')
      },
      asksTick: async () => {
        throw new Error('b')
      },
      litterTick: async () => {
        throw new Error('c')
      },
    })
    startUiTimer(p)
    await fireEvery(p)
    await until(() => calls.length === ORDER.length && !uiTicking())
    await fireEvery(p)
    await until(() => calls.length === 2 * ORDER.length && !uiTicking())
    expect(p.logs).toHaveLength(2 * ORDER.length)
  })

  test('resetUiTickForTests cancels the timer and puts the real steps back', async () => {
    const real = { ...deps }
    recordSteps()
    startUiTimer(p)
    resetUiTickForTests()
    expect(p.timers.size).toBe(0)
    expect(deps.bandTick).toBe(real.bandTick)
    expect(deps.cardsTick).toBe(real.cardsTick)
    expect(deps.litterTick).toBe(real.litterTick)
    expect(Object.keys(deps)).toEqual(ORDER)
  })
})
