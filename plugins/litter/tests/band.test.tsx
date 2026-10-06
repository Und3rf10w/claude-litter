// Tier 1: the band above the prompt as the engine draws it (WP-CB; COMMON
// decision 7). The band's view is fed to register.tsx's render through a
// state.get hook beneath, as tier 2's bandview.spec.ts builds it, and the
// tree another plugin draws in the band comes from an AbovePrompt hook of the
// test's, beneath litter: litter's rows draw above it and it stays whole; with
// nothing beneath (the engine's own band, which draws nothing) litter's rows
// alone; under a survey, only what's beneath. Each row is one line: every Text
// truncates, the spans are cut at a narrow band and the buttons kept, none with
// a hotkey; past maxRows the swarms fold into `+<k> more` (the band has no ask
// rows since WP-CK: tests/asks.test.ts checks none is drawn). A view the render
// can't draw passes to what's beneath (the render's catch), and [Hide]'s press
// answers `{ element }`. These are the cases WP-CB's brief names for a tier-2
// bandrender.spec.ts, here at tier 1 since tier 2 has no JSX (COMMON, "Tests").

import type { On, RenderElement } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { BandView } from '../types/index'

const SESSION = 'tier1-session'
const RUN = '20261005-retry'
const SURFACES = ['terminal', 'desktop'] as const

const BAND = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 95, scroll: { offset: 0, bodyRows: 9 }, view: {} } as const

const runRow = {
  key: `run:${RUN}:1:open`,
  kind: 'run',
  spans: [
    { text: '▸', color: 'background' },
    { text: ' litter · execute ' },
    { text: RUN, color: 'cyan' },
    { text: ' · gate 3/7 · G2 ' },
    { text: 'retry 2', color: 'warning' },
    { text: ' · ' },
    { text: '14m', dim: true },
  ],
  buttons: [
    { key: `band:board:${RUN}`, label: 'Board' },
    { key: `band:hide:run:${RUN}:1:open`, label: 'Hide' },
  ],
}
const swarmRow = (n: number) => ({
  key: `swarm:s${n}:20261005-093000`,
  kind: 'swarm',
  spans: [{ text: '▸', color: 'background' }, { text: ' litter · swarm ' }, { text: `s${n}`, color: 'cyan' }, { text: ' · ' }, { text: '1 waiting', color: 'warning' }],
  buttons: [
    { key: `band:browser:s${n}`, label: 'Browser' },
    { key: `band:hide:swarm:s${n}:20261005-093000`, label: 'Hide' },
  ],
})
const ONE_ROW = { view: 'band', v: 3, rows: [runRow] } as BandView

/** The band atom holds `view`, as the ui tick would have written it. */
function bandAtom(on: On, view: unknown): void {
  on('state.get', async (_$, e, next) => (e.key === 'band' ? { value: { value: view, version: 1 } } : next(e)))
}

/** The plugins beneath litter draw this in the band: a line and two buttons, one keyed as litter's would be. */
function bandBeneath(on: On, reached: string[] = []): void {
  on('ui.render', { component: 'AbovePrompt' }, async (hooks, e): Promise<RenderElement> => {
    const { Box, Text, Button } = hooks.ui.resolve(e)
    return Box({
      flexDirection: 'column',
      children: [
        Text({ children: 'drawn beneath litter' }),
        Button({ key: 'band:board:20261005-retry', label: 'Board', onPress: () => void reached.push('band:board') }),
        Button({ key: 'other', label: 'Other', onPress: () => void reached.push('other') }),
      ],
    })
  })
}

/** Nothing beneath: the engine's own band, which draws nothing above the prompt. */
function engineBeneath(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async (): Promise<RenderElement> => ({ type: 'engine', ref: 0 }))
}

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }
/** Every element of a drawn tree, depth first. */
function walk(n: unknown, out: Node[] = []): Node[] {
  if (n === null || typeof n !== 'object') return out
  out.push(n as Node)
  for (const c of (n as Node).children ?? []) walk(c, out)
  return out
}
const shownText = (n: unknown): string =>
  typeof n === 'string' ? n : n !== null && typeof n === 'object' ? ((n as Node).children ?? []).map(shownText).join('') : ''

describe('the band', () => {
  test("a view with one row draws litter's row above the tree beneath, which stays whole, on the terminal and the desktop", async ($, on) => {
    mock.store(on)
    bandAtom(on, ONE_ROW)
    bandBeneath(on)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'litter', surface, component: 'AbovePrompt', props: BAND })
      const root = (await ui.drawn()) as unknown as Node
      expect(root.type).toBe('Box')
      expect(root.props?.flexDirection).toBe('column')
      const [first, last] = [root.children?.[0], root.children?.at(-1)]
      expect(root.children).toHaveLength(2)
      expect(shownText(first)).toBe(`▸ litter · execute ${RUN} · gate 3/7 · G2 retry 2 · 14m`)
      expect(shownText(last)).toBe('drawn beneath litter')
      // litter's two buttons, then the two beneath, in that order.
      expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['Board', 'Hide', 'Board', 'Other'])
      await ui.unmount()
    }
  })

  test('every Text of a row truncates, the colors are kept, and no Button has a hotkey', async ($, on) => {
    mock.store(on)
    bandAtom(on, { view: 'band', v: 4, rows: [runRow, swarmRow(1)] })
    bandBeneath(on)
    const ui = await $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    const root = (await ui.drawn()) as unknown as Node
    const ours = (root.children ?? []).slice(0, 2).flatMap(c => walk(c))
    const texts = ours.filter(n => n.type === 'Text')
    expect(texts.length).toBeGreaterThan(0)
    expect(texts.every(t => t.props?.wrap === 'truncate-end')).toBe(true)
    expect(texts.find(t => shownText(t) === RUN)?.props?.color).toBe('cyan')
    expect(texts.find(t => shownText(t) === 'retry 2')?.props?.color).toBe('warning')
    expect(texts.find(t => shownText(t) === '1 waiting')?.props?.color).toBe('warning')
    expect(texts.find(t => shownText(t) === '14m')?.props?.dimColor).toBe(true)
    const buttons = ours.filter(n => n.type === 'Button')
    expect(buttons.map(b => b.props?.key)).toEqual([`band:board:${RUN}`, `band:hide:run:${RUN}:1:open`, 'band:browser:s1', 'band:hide:swarm:s1:20261005-093000'])
    expect(buttons.every(b => b.props?.hotkey === undefined)).toBe(true)
  })

  test('at a narrow band the spans are cut and the buttons kept', async ($, on) => {
    mock.store(on)
    bandAtom(on, ONE_ROW)
    engineBeneath(on)
    const ui = await $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 40 } })
    const root = (await ui.drawn()) as unknown as Node
    // `[ Board ]` and `[ Hide ]` with a cell before each leave 21 cells.
    expect(shownText(root.children?.[0])).toBe('▸ litter · execute 2…')
    expect((await ui.findAll({ type: 'Button' })).map(b => b.props.label)).toEqual(['Board', 'Hide'])
  })

  test('with nothing beneath, litter draws its rows alone: the engine node is left out', async ($, on) => {
    mock.store(on)
    bandAtom(on, ONE_ROW)
    engineBeneath(on)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'litter', surface, component: 'AbovePrompt', props: BAND })
      const root = (await ui.drawn()) as unknown as Node
      expect(root.children).toHaveLength(1)
      expect(walk(root).some(n => n.type === 'engine')).toBe(false)
      await ui.unmount()
    }
  })

  test('past maxRows the swarms fold into the `+<k> more` row', async ($, on) => {
    mock.store(on)
    bandAtom(on, { view: 'band', v: 5, rows: [runRow, swarmRow(1), swarmRow(2), swarmRow(3)] })
    engineBeneath(on)
    const ui = await $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, maxRows: 3 } })
    const root = (await ui.drawn()) as unknown as Node
    expect((root.children ?? []).map(shownText)).toEqual([`▸ litter · execute ${RUN} · gate 3/7 · G2 retry 2 · 14m`, '▸ litter · swarm s1 · 1 waiting', '+2 more swarms'])
  })

  test('a survey holds the band: only what is beneath is drawn', async ($, on) => {
    mock.store(on)
    bandAtom(on, ONE_ROW)
    bandBeneath(on)
    for (const surface of SURFACES) {
      const ui = await $.ui.mount({ plugin: 'litter', surface, component: 'AbovePrompt', props: { ...BAND, hasSurvey: true } })
      expect(await ui.find({ type: 'Text', text: /litter · execute/ })).toBeUndefined()
      expect((await ui.find({ type: 'Text', text: 'drawn beneath litter' }))?.text).toBe('drawn beneath litter')
      await ui.unmount()
    }
  })

  test("a view with no rows, or one the render can't draw, draws what is beneath (the render's catch)", async ($, on) => {
    mock.store(on)
    let view: unknown = { view: 'band', v: 6, rows: [] }
    on('state.get', async (_$, e, next) => (e.key === 'band' ? { value: { value: view, version: 1 } } : next(e)))
    bandBeneath(on)
    const empty = await $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    expect((await empty.drawn()) as unknown as Node).toMatchObject({ type: 'Box', children: [expect.objectContaining({ type: 'Text' }), expect.anything(), expect.anything()] })
    await empty.unmount()
    // Rows whose spans aren't spans: the render throws, and its catch passes the render on.
    view = { view: 'band', v: 7, rows: [{ key: 'run:x', kind: 'run', spans: 'not spans', buttons: [] }] }
    const broken = await $.ui.mount({ plugin: 'litter', surface: 'desktop', component: 'AbovePrompt', props: BAND })
    expect((await broken.find({ type: 'Text', text: 'drawn beneath litter' }))?.text).toBe('drawn beneath litter')
    expect(await broken.findAll({ type: 'Button' })).toHaveLength(2)
  })
})

describe("the band's presses", () => {
  test("[Hide]'s press answers { element }: one for a row the band no longer shows is ignored with a toast", async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1_800_000_000_000 })
    on('session.id', async () => ({ value: SESSION }))
    const toasts: string[] = []
    on('ui.toast', async (_$, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    on('ui.log', async () => ({ value: undefined }))
    bandAtom(on, ONE_ROW)
    const reached: string[] = []
    bandBeneath(on, reached)
    const ui = await $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'AbovePrompt', props: BAND })
    // The atom was fed here, not built by this module's tick: the band shows no row of its own, so the press is stale.
    expect(await ui.press({ key: `band:hide:run:${RUN}:1:open` })).toEqual({ element: `band:hide:run:${RUN}:1:open` })
    expect(toasts).toEqual([`the band doesn't show run ${RUN} now, so that was ignored`])
    // Another plugin's buttons, a `band:` key among them, pass on to their own handlers.
    expect(await ui.press({ key: 'band:board:20261005-retry', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'band:board:20261005-retry' }))
    expect(await ui.press({ key: 'other', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'other' }))
    expect(reached).toEqual(['band:board', 'other'])
    expect(toasts).toHaveLength(1)
  })
})
