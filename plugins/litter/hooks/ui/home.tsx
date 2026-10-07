// Home's body (phase 5b, WP-DB), drawn by the hub under its header and strip:
// what needs you, what runs, what ended, then the other sections, each group
// under its heading, from the hub's view (homeview.ts words it). A pure
// function of the view and the body's context.
//
// It keeps to `ctx.rows` (homePlan): needs you and running are drawn whole,
// and ended and the others fold into "N more" lines first, so the hub clips
// nothing and the keys line stays at the pane's foot. Each row is one line
// with its mark in a column, its words cut to what's left, and [Open] at the
// row's end; below NARROW_COLUMNS it's two, the words then [Open]. The first
// needs-you row's [Open] is the primary, else the first running row's.
//
// `h` and `Fragment` are the environment's JSX factory, so no name here takes them.

import type { RenderElement } from 'claude-code'
import type { PaneElements } from '../hooktypes'
import type { HomeLine, HomeRow, HomeView, SwarmSpan } from '../../types/index'
import { cells, fitSpans } from '../band/view'
import { actions, empty, heading, notice, type BodyContext } from './chrome'
import { OPEN_CELLS, QUIET, homePlan, moreText, primaryOpen, type HomeGroup, type HomePlan } from './homeview'
import { STYLE } from './style'

/** Each group's heading, and the ended runs' note: the window they cover. */
const HEADING: Record<HomeGroup, string> = { needsYou: 'Needs you', running: 'Running', ended: 'Recently ended', others: 'Elsewhere' }

/** register.tsx draws Home through ui/pane.tsx with the hub's view's `home`; absent (a hub written before WP-DB), a line that says so. */
export function renderHome(home: HomeView | null | undefined, el: PaneElements, ctx: BodyContext): RenderElement {
  const { Box } = el
  if (!home) return notice(el, 'info', 'Home is read on the next tick.')
  const plan = homePlan(home, ctx.bodyColumns, ctx.rows)
  const primary = primaryOpen(home, plan)
  // One column for every group's marks, as wide as the widest drawn.
  const marks = (['needsYou', 'running', 'ended'] as const).flatMap(g => home[g].slice(0, drawnOf(plan, g)))
  const markWidth = Math.max(0, ...marks.map(r => cells(markText(r))))
  const parts: RenderElement[] = []
  if (plan.quiet) parts.push(notice(el, 'info', QUIET.line), empty(el, QUIET.what, QUIET.next))
  for (const g of ['needsYou', 'running', 'ended'] as const) parts.push(...markRows(el, home, g, plan, ctx, markWidth, primary))
  parts.push(...otherRows(el, home, plan, ctx))
  return <Box flexDirection="column">{parts}</Box>
}

/** How many of a group's rows are drawn (homePlan's -1 draws none, and no "N more" line). */
const drawnOf = (plan: HomePlan, g: HomeGroup): number => Math.max(0, plan.shown[g])

/** A group's heading, when it has rows drawn and the plan keeps headings. */
function groupHeading(el: PaneElements, home: HomeView, g: HomeGroup, plan: HomePlan, ctx: BodyContext): RenderElement | null {
  if (!plan.headings || drawnOf(plan, g) === 0) return null
  const note = g === 'ended' ? `the last ${home.endedMinutes === 1 ? 'minute' : `${home.endedMinutes} minutes`}` : null
  return heading(el, HEADING[g], ctx.bodyColumns, note)
}

/** A folded group's "N more" line, muted. */
function more(el: PaneElements, home: HomeView, g: HomeGroup, plan: HomePlan): RenderElement | null {
  const { Text } = el
  const total = g === 'others' ? home.others.length : home[g].length
  if (plan.shown[g] < 0 || plan.shown[g] >= total) return null
  return (
    <Text color={STYLE.muted} wrap="truncate-end">
      {moreText(home, g, plan.shown[g])}
    </Text>
  )
}

/** The [Open] of a row: the primary in the action color, the others secondary. */
const open = (el: PaneElements, key: string, primary: string | null): RenderElement => actions(el, [{ key, label: 'Open', primary: key === primary }])

/** A group of marked rows (needs you, running, ended): the heading, the rows drawn, the "N more" line. */
function markRows(el: PaneElements, home: HomeView, g: Exclude<HomeGroup, 'others'>, plan: HomePlan, ctx: BodyContext, markWidth: number, primary: string | null): RenderElement[] {
  const rows = home[g]
  if (rows.length === 0) return []
  const drawn = rows.slice(0, drawnOf(plan, g))
  const out: (RenderElement | null)[] = [groupHeading(el, home, g, plan, ctx)]
  for (const r of drawn) out.push(plan.narrow ? narrowRow(el, r, ctx.bodyColumns, primary) : wideRow(el, r, markWidth, ctx.bodyColumns, primary))
  out.push(more(el, home, g, plan))
  return out.filter((x): x is RenderElement => x !== null)
}

const markText = (r: HomeRow): string => `${r.mark.glyph} ${r.mark.word}`

/** One line: the mark padded to its column, the words cut to what's left, [Open] at the row's end. */
function wideRow(el: PaneElements, r: HomeRow, markWidth: number, columns: number, primary: string | null): RenderElement {
  const { Box, Text } = el
  // The mark, a cell, the words, a cell, [Open].
  const room = Math.max(1, columns - markWidth - 1 - 1 - OPEN_CELLS)
  return (
    <Box flexDirection="row" columnGap={1}>
      <Text color={r.mark.color}>{`${markText(r)}${' '.repeat(Math.max(0, markWidth - cells(markText(r))))}`}</Text>
      <Box flexGrow={1} flexShrink={1}>
        {spansText(el, fitSpans(r.spans, room))}
      </Box>
      {open(el, r.open, primary)}
    </Box>
  )
}

/** Two lines: the mark and the words, cut to the body; then [Open]. */
function narrowRow(el: PaneElements, r: HomeRow, columns: number, primary: string | null): RenderElement {
  const { Box } = el
  const spans = fitSpans([{ text: markText(r), color: r.mark.color }, { text: ' ' }, ...r.spans], Number.isFinite(columns) ? columns : Number.POSITIVE_INFINITY)
  return (
    <Box flexDirection="column">
      {spansText(el, spans)}
      {open(el, r.open, primary)}
    </Box>
  )
}

/** Spans as one Text that truncates, each in its color (a dim one muted). */
function spansText(el: PaneElements, spans: readonly SwarmSpan[]): RenderElement {
  const { Text } = el
  return (
    <Text wrap="truncate-end">
      {spans.map(s => (
        <Text color={s.color ?? (s.dim ? STYLE.muted : undefined)} bold={s.bold}>
          {s.text}
        </Text>
      ))}
    </Text>
  )
}

/** The other sections: the heading, a line each (the label, what it has to say, [Open]), the "N more" line. */
function otherRows(el: PaneElements, home: HomeView, plan: HomePlan, ctx: BodyContext): RenderElement[] {
  const { Box, Text } = el
  if (home.others.length === 0) return []
  const drawn = home.others.slice(0, drawnOf(plan, 'others'))
  const labelWidth = Math.max(0, ...drawn.map(o => cells(o.label)))
  const line = (o: HomeLine): RenderElement => {
    const room = plan.narrow ? ctx.bodyColumns : Math.max(1, ctx.bodyColumns - labelWidth - 1 - 1 - OPEN_CELLS)
    const words = fitSpans([{ text: o.text }], Number.isFinite(room) ? room - (plan.narrow ? cells(o.label) + 1 : 0) : Number.POSITIVE_INFINITY)[0]?.text ?? ''
    const label = (
      <Text bold color={STYLE.label}>
        {plan.narrow ? o.label : o.label.padEnd(labelWidth)}
      </Text>
    )
    const text = (
      <Text color={STYLE.muted} wrap="truncate-end">
        {words}
      </Text>
    )
    if (plan.narrow) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {label}
            {text}
          </Box>
          {open(el, o.open, null)}
        </Box>
      )
    }
    return (
      <Box flexDirection="row" columnGap={1}>
        {label}
        <Box flexGrow={1} flexShrink={1}>
          {text}
        </Box>
        {open(el, o.open, null)}
      </Box>
    )
  }
  const out: (RenderElement | null)[] = [groupHeading(el, home, 'others', plan, ctx), ...drawn.map(line), more(el, home, 'others', plan)]
  return out.filter((x): x is RenderElement => x !== null)
}
