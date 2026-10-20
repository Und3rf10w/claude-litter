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
// WP-DB: the rows as band/view.ts builds them now (`<glyph> <word> · litter ·
// …`, in the `litter` pane's style table: a dim span is drawn muted), and
// the band drawn at 100 and 60 columns with each row's colors beside it.

import type { On, RenderElement } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { BandView } from '../types/index'
import { drawWithColors } from './drawing'

const SESSION = 'tier1-session'
const RUN = '20261005-retry'
const SURFACES = ['terminal', 'desktop'] as const

const BAND = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 95, scroll: { offset: 0, bodyRows: 9 }, view: {} } as const

const NAME = 'cyan_FOR_SUBAGENTS_ONLY'
const SEP = { text: ' · ' }
const LITTER = [SEP, { text: 'litter', color: 'inactive' }, SEP]
const runRow = {
  key: `run:${RUN}:1:open`,
  kind: 'run',
  spans: [
    { text: '▸ running', color: 'background' },
    ...LITTER,
    { text: 'execute ' },
    { text: RUN, color: NAME },
    SEP,
    { text: 'gate 3/7' },
    SEP,
    { text: 'G2' },
    { text: ' ' },
    { text: 'retry 2', color: 'warning' },
    SEP,
    { text: '14m', color: 'inactive' },
  ],
  buttons: [
    { key: `band:board:${RUN}`, label: 'Board' },
    { key: `band:hide:run:${RUN}:1:open`, label: 'Hide' },
  ],
}
const swarmRow = (n: number) => ({
  key: `swarm:s${n}:20261005-093000`,
  kind: 'swarm',
  spans: [{ text: '▸ live', color: 'background' }, ...LITTER, { text: 'swarm ' }, { text: `s${n}`, color: NAME }, SEP, { text: '2 running', color: 'background' }, SEP, { text: '⚑ 1 waiting', color: 'permission' }],
  buttons: [
    { key: `band:browser:s${n}`, label: 'Browser' },
    { key: `band:hide:swarm:s${n}:20261005-093000`, label: 'Hide' },
  ],
})
const endedRow = {
  key: 'run:20261005-split:1:done',
  kind: 'ended',
  spans: [{ text: '✓ done', color: 'success' }, ...LITTER, { text: 'fanout ' }, { text: '20261005-split', color: NAME }, SEP, { text: '3/3 tasks' }, SEP, { text: 'landed' }, SEP, { text: '9m', color: 'inactive' }],
  buttons: [
    { key: 'band:board:20261005-split', label: 'Board' },
    { key: 'band:hide:run:20261005-split:1:done', label: 'Hide' },
  ],
}
const ONE_ROW = { view: 'band', v: 3, rows: [runRow] } as BandView
const ROW_TEXT = `▸ running · litter · execute ${RUN} · gate 3/7 · G2 retry 2 · 14m`

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
      expect(shownText(first)).toBe(ROW_TEXT)
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
    expect(texts.find(t => shownText(t) === RUN)?.props?.color).toBe(NAME)
    expect(texts.find(t => shownText(t) === 'retry 2')?.props?.color).toBe('warning')
    expect(texts.find(t => shownText(t) === '⚑ 1 waiting')?.props?.color).toBe('permission')
    // The style table's muted role, as the pane draws a dim text (WP-DB); no faint attribute.
    expect(texts.find(t => shownText(t) === '14m')?.props?.color).toBe('inactive')
    expect(texts.some(t => t.props?.dimColor === true)).toBe(false)
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
    // `[ Board ]` and `[ Hide ]` with a cell before each leave 21 cells: the mark and litter's name.
    expect(shownText(root.children?.[0])).toBe('▸ running · litter ·…')
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
    expect((root.children ?? []).map(shownText)).toEqual([ROW_TEXT, '▸ live · litter · swarm s1 · 2 running · ⚑ 1 waiting', '+2 more swarms'])
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

/** Rows of a drawing with the colors beside each, as drawWithColors writes them. */
const golden = (columns: number, rows: readonly (readonly [string, string])[]): string[] => rows.map(([text, colors]) => `${text.padEnd(columns)}  | ${colors}`)

/**
 * The band at 100 and 60 columns (WP-DB's report): each row the mark and its
 * word in the state's color, `litter` muted, what it is with the name in the
 * name color, its progress or outcome, the time muted, then its buttons.
 * Narrow, the words are cut and the buttons kept.
 */
const BAND_DRAWN: Record<number, [string, string][]> = {
  100: [
    [`▸ running · litter · execute ${RUN} · gate 3/7 · G2 retry 2 · 14m [ Board ] [ Hide ]`, `background, default, inactive, default, ${NAME}, default, warning, default, inactive, default`],
    ['✓ done · litter · fanout 20261005-split · 3/3 tasks · landed · 9m [ Board ] [ Hide ]', `success, default, inactive, default, ${NAME}, default, inactive, default`],
    ['▸ live · litter · swarm s1 · 2 running · ⚑ 1 waiting [ Browser ] [ Hide ]', `background, default, inactive, default, ${NAME}, default, background, default, permission, default`],
  ],
  60: [
    ['▸ running · litter · execute 20261005-re… [ Board ] [ Hide ]', `background, default, inactive, default, ${NAME}, default`],
    ['✓ done · litter · fanout 20261005-split … [ Board ] [ Hide ]', `success, default, inactive, default, ${NAME}, default`],
    ['▸ live · litter · swarm s1 · 2 running… [ Browser ] [ Hide ]', `background, default, inactive, default, ${NAME}, default, background, default`],
  ],
}

describe('the drawings', () => {
  for (const columns of [100, 60]) {
    test(`an open run, a run that ended and a live swarm, at ${columns} columns`, async ($, on) => {
      mock.store(on)
      bandAtom(on, { view: 'band', v: 8, rows: [runRow, endedRow, swarmRow(1)] })
      engineBeneath(on)
      const ui = await $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: columns } })
      expect(drawWithColors(await ui.drawn(), columns)).toEqual(golden(columns, BAND_DRAWN[columns]!))
    })
  }
})
