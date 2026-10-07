// The `litter` pane's draw (phase 5b, WP-DA): the header, the section strip,
// the shown section's body through its own renderer, and the keys line on
// the terminal. A pure function of the hub's view and the shown section's
// view, which register.tsx reads from their atoms.
//
// Every body gets the themed table (chrome.tsx: a dim Text is muted) and a
// BodyContext. Home (home.tsx, WP-DB) fits its rows, so the keys line sits at
// the pane's foot; each other section says in its own module (its
// SectionMeta) whether its body fits `ctx.rows` yet, and which keys it adds
// to the keys line. One that doesn't fit is drawn whole (the keys line
// follows it, reached by scrolling).
//
// `h` and `Fragment` are the environment's JSX factory, so no name here takes them.

import type { RenderElement } from 'claude-code'
import type { PaneElements, PaneRender } from '../hooktypes'
import type { AgentsPaneView, BoardView, DoctorPaneView, HubSection, HubTab, HubView, RulesPaneView, SwarmPaneView, TasksPaneView } from '../../types/index'
import { tableFor } from '../swarm/builder'
import { renderBoardPane, runsSection } from '../board/pane'
import { renderSwarmPane, swarmsSection } from '../swarm/browser'
import { doctorSection, renderDoctorPane } from '../swarm/doctorpane'
import { renderRulesPane, rulesSection } from '../rules/pane'
import { renderTasksPane, tasksSection } from '../tasks/pane'
import { agentsSection, renderAgentsPane } from '../agents/pane'
import { header, keysLine, plan, strip, stripWidths, themed, type BodyContext, type KeyHint, type SectionMeta } from './chrome'
import { cells } from '../band/view'
import { noteDrawn } from './drawn'
import { renderHome } from './home'
import { LABEL, SECTIONS, tabsOf } from './hub'

/** The shown section's view, whichever it is: register.tsx reads the one atom the hub's section names. */
export type SectionView = BoardView | SwarmPaneView | RulesPaneView | TasksPaneView | AgentsPaneView | DoctorPaneView

/** Which section the hub's view shows; Home before the first write. */
export const sectionShown = (hub: HubView | null): HubSection => (hub && (SECTIONS as readonly string[]).includes(hub.section) ? hub.section : 'home')

/** The keys line while the pane has the keyboard. */
export const HUB_KEYS: readonly KeyHint[] = [
  { key: '1–7', word: 'section' },
  { key: 'tab', word: 'next' },
  { key: 'enter', word: 'press' },
  { key: 'esc', word: 'back to the prompt' },
]

/** Each section but Home, as its own module declares it (chrome.tsx's SectionMeta). Home fits and has no keys of its own. */
export type MetaTable = Record<Exclude<HubSection, 'home'>, SectionMeta<never>>
const META = {
  runs: runsSection,
  swarms: swarmsSection,
  rules: rulesSection,
  tasks: tasksSection,
  agents: agentsSection,
  doctor: doctorSection,
} satisfies MetaTable

/** Whether the shown section's body fits `ctx.rows` (the hub clips it there in the dock). The table is a seam for tier 2. */
export const fitsOf = (shown: HubSection, table: MetaTable = META): boolean => shown === 'home' || table[shown].fits

/** The shown section's own keys, drawn before the hub's. */
export const keysOf = (shown: HubSection, view: SectionView | null, table: MetaTable = META): readonly KeyHint[] => (shown === 'home' ? [] : table[shown].keys(view as never))

/** The keys line's keys: the shown section's, then the hub's. */
export const keysLineOf = (shown: HubSection, view: SectionView | null, table: MetaTable = META): KeyHint[] => [...keysOf(shown, view, table), ...HUB_KEYS]

/** The body's Box props: a section that fits is clipped to `rows` in the dock (so the keys line sits at the pane's foot); else drawn whole. */
export function bodyBox(shown: HubSection, placement: 'dock' | 'inline', rows: number, table: MetaTable = META): { height?: number; overflow?: 'hidden' } {
  return fitsOf(shown, table) && placement === 'dock' && Number.isFinite(rows) ? { height: rows, overflow: 'hidden' } : {}
}

/** The tabs before the hub's first write: every section, nothing counted. */
const blankTabs = (): HubTab[] => tabsOf({ runs: 0, swarms: 0, swarmsNeedYou: false, rules: null, tasks: null, agents: null })

/**
 * The rows the keys line wraps to past its first at `columns` (WP-DB): chrome's
 * plan counts it one row, but keysLine is a wrapping row of keys, each after
 * the first with ` · ` before it, and at 60 columns the hub's own four
 * already take two. Unfocused it's one line. Pure.
 */
export function keysOverflow(keys: readonly KeyHint[], isFocused: boolean, columns: number): number {
  if (!isFocused || !Number.isFinite(columns)) return 0
  let rows = 1
  let used = 0
  keys.forEach((k, i) => {
    const w = (i > 0 ? 3 : 0) + cells(k.key) + 1 + cells(k.word)
    if (used > 0 && used + w > columns) {
      rows++
      used = w
    } else used += w
  })
  return rows - 1
}

/** register.tsx's ui.render hook for `{ component: 'Pane', requestId: 'litter' }`. Pure but for its note of what the terminal drew (ui/drawn.ts). */
export function renderLitterPane(hub: HubView | null, view: SectionView | null, resolved: PaneElements, e: PaneRender): RenderElement {
  const el = themed(tableFor(resolved, e.surface))
  const { Box } = el
  const shown = sectionShown(hub)
  const tabs = hub?.tabs && hub.tabs.length === SECTIONS.length ? hub.tabs : blankTabs()
  const { bodyColumns, isFocused, placement, scroll } = e.props
  const keys = e.surface === 'terminal'
  const keyHints = keysLineOf(shown, view)
  // plan counts the keys line one row: the rows it wraps to past that come off the body's.
  const over = keys ? keysOverflow(keyHints, isFocused, bodyColumns) : 0
  const layout = plan({ bodyColumns, bodyRows: scroll.bodyRows - over, context: false, strip: stripWidths(tabs, shown, isFocused), keys })
  const ctx: BodyContext = { surface: e.surface, bodyColumns, isFocused, placement, scroll, rows: layout.bodyRows, focused: hub?.focus ?? null, lists: hub?.lists ?? {} }
  // The header's rows, the strip's, and the gap above the body.
  if (e.surface === 'terminal') noteDrawn({ shown, view, ctx, bodyTop: layout.headerRows + layout.stripRows + 1, scrollOffset: scroll.offset })
  return (
    <Box flexDirection="column">
      {header(el, { section: LABEL[shown], live: hub?.live ?? [] }, bodyColumns)}
      {strip(el, tabs, shown, isFocused)}
      <Box flexDirection="column" marginTop={1} {...bodyBox(shown, placement, layout.bodyRows)}>
        {body(shown, hub, view, el, ctx)}
      </Box>
      {keys ? keysLine(el, keyHints, isFocused) : null}
    </Box>
  )
}

/** The shown section's body, through its renderer, over the view register.tsx read from that section's atom (Home's is the hub's own). */
function body(shown: HubSection, hub: HubView | null, view: SectionView | null, el: PaneElements, ctx: BodyContext): RenderElement {
  switch (shown) {
    case 'home':
      return renderHome(hub?.home, el, ctx)
    case 'runs':
      return renderBoardPane(view as BoardView | null, el, ctx)
    case 'swarms':
      return renderSwarmPane(view as SwarmPaneView | null, el, ctx)
    case 'rules':
      return renderRulesPane(view as RulesPaneView | null, el, ctx)
    case 'tasks':
      return renderTasksPane(view as TasksPaneView | null, el, ctx)
    case 'agents':
      return renderAgentsPane(view as AgentsPaneView | null, el, ctx)
    case 'doctor':
      return renderDoctorPane(view as DoctorPaneView | null, el, ctx)
  }
}
