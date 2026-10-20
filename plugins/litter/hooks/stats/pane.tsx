// The `litter` pane's Stats section (phase 5b, WP-DH): `/litter stats`. Under
// "This session", what it has spent, its context and its rate limits; then a
// heading per swarm owned here, its state on the rule: its spend since
// launch (what the spend counts, muted, under it), and a table of the
// lead's and each node's tokens, uncached input, cache reads, cache writes
// and output apart, numbers right-aligned, the swarm's total in bold last;
// then [Open in Swarms]. No swarm live: a line that says so, and the next
// step.
//
// Its view is built from the session's usage and the swarm state alone, so
// it's cheap: the tick builds it while Stats is shown (writing it only when
// it moved), and a session.measure (a turn ended) builds it from the figures
// it carries.
//
// `h` and `Fragment` are the environment's JSX factory, so no name here takes them.

import type { RenderElement } from 'claude-code'
import type { ListedAgent, Ports, SessionUsage } from '../ports'
import type { CommandRunHook, PaneElements, PaneUiHandlers, PortHook } from '../hooktypes'
import type { StatsBody, StatsPaneView, StatsSwarm, StatsTokens, SwarmSpan } from '../../types/index'
import type { Loaded } from '../ui/hub'
import { STYLE } from '../ui/style'
import { actions, empty, fitCell, heading, notice, planColumns, row, spansLine, type BodyContext, type Cell, type Column, type SectionMeta } from '../ui/chrome'
import { cells } from '../band/view'
import { LITTER_PANE, openSection, shownSection } from '../ui/hub'
import { measureSpend } from './spend'
import { statsBody } from './view'
import { oneLine } from '../swarm/view'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** What Stats tells the hub (ui/pane.tsx): drawn whole (a swarm's table can be long), no keys of its own. */
export const statsSection: SectionMeta<StatsPaneView> = { fits: false, keys: () => [] }

const OPEN_PREFIX = 'stats:open-swarm:'
/** A swarm's [Open in Swarms]. */
export const openSwarmKey = (swarm: string): string => `${OPEN_PREFIX}${encodeURIComponent(swarm)}`

// ---------------------------------------------------------------------------
// The view

let seq = 0
let lastJson = ''

/** Builds the body (from `usage` when given, else a fresh reading) and writes the view when it moved, or always with `force`. */
async function drawStats(p: Ports, usage?: SessionUsage | null, force = false): Promise<StatsBody> {
  const problems: string[] = []
  const u = usage !== undefined ? usage : await measureSpend(p)
  if (u === null) problems.push("the session's usage couldn't be read: the debug log has why")
  let listed: ListedAgent[] = []
  try {
    listed = await p.listAgents()
  } catch (err) {
    problems.push(`the agent list couldn't be read: ${oneLine(errText(err), 160)}`)
  }
  const body = statsBody(u, listed, await p.now(), problems)
  const json = JSON.stringify(body)
  if (force || json !== lastJson) {
    lastJson = json
    await p.setView('stats', { view: 'stats', v: ++seq, body })
  }
  return body
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** The reply's line: what Stats shows. */
const shownWords = (b: StatsBody): string =>
  `${b.session.spend === null ? "this session's figures" : `this session's ${b.session.spend}`}${b.swarms.length > 0 ? ` and ${plural(b.swarms.length, 'live swarm')}` : ''}`

/** `/litter stats` (ui/hub.ts's litterCommand): shows Stats in the `litter` pane. */
export const statsCommand: PortHook<CommandRunHook> = async (p, e, next) => ({ text: (await openSection(p, 'stats', e.args ?? '', { focus: true })).text })

/** Stats' load (openSection): it takes no argument (the hub's usage refuses one). */
export async function loadStats(p: Ports): Promise<Loaded> {
  return { text: `Stats shows ${shownWords(await drawStats(p, undefined, true))}` }
}

/** Stats from the strip or Home: drawn afresh (a /clear may have wiped its view). */
export async function resumeStats(p: Ports): Promise<void> {
  await drawStats(p, undefined, true)
}

/** Stats' tick (ui/hub.ts's litterTick, while Stats is shown). */
export async function statsTick(p: Ports): Promise<void> {
  await drawStats(p)
}

/** A session.measure: while Stats is shown in an open pane, built from its figures, so nothing is read twice. */
export async function statsMeasured(p: Ports, e: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>): Promise<void> {
  if (shownSection() !== 'stats' || !(await p.paneOpen(LITTER_PANE))) return
  await drawStats(p, { startedAt: 0, context: e.context, rateLimits: e.rateLimits, ...(e.cost !== undefined ? { cost: e.cost } : {}) })
}

/** The pane's ui.press: [Open in Swarms] shows Swarms on its swarm (a toast says why when it can't); anything else passes on. */
export const onStatsUi: PaneUiHandlers = {
  message: async (p, e, next) => next(e),
  press: async (p, e, next) => {
    if (!e.element.startsWith(OPEN_PREFIX)) return next(e)
    let name = ''
    try {
      name = decodeURIComponent(e.element.slice(OPEN_PREFIX.length))
    } catch {
      return { element: e.element }
    }
    if (name === '') return { element: e.element }
    const opened = await openSection(p, 'swarms', name)
    if (!opened.placed) p.toast(opened.text)
    return { element: e.element }
  },
  input: async (p, e, next) => (e.element.startsWith('stats:') ? { element: e.element, value: e.value } : next(e)),
  select: async (p, e, next) => (e.element.startsWith('stats:') ? { element: e.element, value: e.value } : next(e)),
}

/** Tier 2: module memory as a fresh load finds it. */
export function resetStatsPaneForTests(): void {
  seq = 0
  lastJson = ''
}

// ---------------------------------------------------------------------------
// The render

/** One label-value line: the label muted in a column `width` wide, then the value's spans, cut to `columns`. */
function fact(el: PaneElements, label: string, width: number, value: readonly SwarmSpan[], columns: number): RenderElement {
  return spansLine(el, [{ text: `${fitCell(label, width)} `, color: STYLE.muted }, ...value], columns)
}

/** The labels down the body's left, one width for all. */
function labelWidth(b: StatsBody): number {
  const labels = ['spend', 'context', ...b.session.limits.map(l => l.label)]
  return Math.max(...labels.map(cells))
}

function sessionPart(el: PaneElements, b: StatsBody, w: number, columns: number): RenderElement {
  const { Box } = el
  const s = b.session
  return (
    <Box flexDirection="column">
      {heading(el, 'This session', columns)}
      {fact(el, 'spend', w, s.spend === null ? [{ text: 'the host keeps no cost ledger', color: STYLE.muted }] : [{ text: s.spend, color: STYLE.label }, { text: ' so far', color: STYLE.muted }], columns)}
      {fact(el, 'context', w, [{ text: s.context ?? 'no response yet', color: s.context === null ? STYLE.muted : STYLE.label }], columns)}
      {s.limits.map(l =>
        fact(el, l.label, w, [{ text: l.used, color: l.color }, { text: ' used', color: STYLE.muted }, ...(l.resets === null ? [] : [{ text: ` · resets ${l.resets}`, color: STYLE.muted }])], columns),
      )}
    </Box>
  )
}

/** The table's columns: the mark and the name, then the turns and the four counts, right-aligned. The name fills; turns go first, then input, then cache writes. */
const COLUMNS: readonly Column[] = [{ drop: 0 }, { drop: 0, fill: true }, { drop: 4 }, { drop: 3 }, { drop: 0 }, { drop: 2 }, { drop: 0 }]
const HEAD = ['', '', 'turns', 'input', 'cache read', 'cache write', 'output'] as const

const countsOf = (t: StatsTokens): string[] => [String(t.turns), t.input, t.cacheRead, t.cacheWrite, t.output]

/** The table's rows as cells: the head, a row each, then the swarm's total in bold; each count padded to its column so the numbers align right. */
export function tableCells(s: StatsSwarm): Cell[][] {
  const counts = [...s.rows.map(r => countsOf(r.tokens)), countsOf(s.tokens)]
  const widths = HEAD.slice(2).map((h, i) => Math.max(cells(h), ...counts.map(c => cells(c[i]!))))
  const right = (text: string, i: number): string => ' '.repeat(Math.max(0, widths[i]! - cells(text))) + text
  const total = counts[counts.length - 1]!
  return [
    [{ text: '' }, { text: '' }, ...HEAD.slice(2).map((h, i) => ({ text: right(h, i), color: STYLE.muted }))],
    ...s.rows.map((r, n) => [
      r.mark ? { text: r.mark.glyph, color: r.mark.color } : { text: ' ' },
      { text: r.name, color: r.color ?? STYLE.name },
      ...counts[n]!.map((c, i) => ({ text: right(c, i), ...(i === 0 ? { color: STYLE.muted } : {}) })),
    ]),
    [{ text: ' ' }, { text: 'total', color: STYLE.label, bold: true }, ...total.map((c, i) => ({ text: right(c, i), bold: true }))],
  ]
}

function swarmPart(el: PaneElements, s: StatsSwarm, w: number, columns: number): RenderElement {
  const { Box, Text } = el
  const data = tableCells(s)
  const planned = planColumns(COLUMNS, data, columns)
  return (
    <Box flexDirection="column" marginTop={1}>
      {heading(el, `Swarm ${s.name}`, columns, { text: s.state.text, color: s.state.color })}
      {fact(el, 'spend', w, s.spend === null ? [{ text: 'not read yet', color: STYLE.muted }] : [{ text: s.spend, color: STYLE.label }], columns)}
      <Text color={STYLE.muted} wrap="wrap">
        {s.spendNote}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {data.map(r => row(el, r, planned))}
      </Box>
      {s.hiddenRows > 0 ? <Text color={STYLE.muted}>{`${plural(s.hiddenRows, 'more agent')} not shown`}</Text> : null}
      {actions(el, [{ key: openSwarmKey(s.name), label: 'Open in Swarms' }])}
    </Box>
  )
}

/** Stats' body (ui/pane.tsx): the session's figures, then each swarm owned here, or the empty state. Pure. */
export function renderStatsPane(view: StatsPaneView | null, el: PaneElements, ctx: BodyContext): RenderElement {
  const { Box, Text } = el
  const b = view?.body
  if (!b) return <Text color={STYLE.muted}>reading the session's figures…</Text>
  const columns = ctx.bodyColumns
  const w = labelWidth(b)
  return (
    <Box flexDirection="column">
      {sessionPart(el, b, w, columns)}
      {b.problems.map(x => notice(el, 'error', x))}
      {b.swarms.length === 0 ? (
        <Box marginTop={1}>{empty(el, 'no swarm live: its spend and tokens show here while it runs', { command: '/litter swarms', does: 'builds one to launch' })}</Box>
      ) : (
        b.swarms.map(s => swarmPart(el, s, w, columns))
      )}
    </Box>
  )
}
