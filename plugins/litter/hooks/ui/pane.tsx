// The `litter` pane's draw (phase 5b, WP-DA): the header, the section strip,
// the shown section's body through its own renderer, and the keys line on
// the terminal. A pure function of the hub's view and the shown section's
// view, which register.tsx reads from their atoms.
//
// Every body gets the themed table (chrome.tsx: a dim Text is muted) and a
// BodyContext. Home fits its rows, so the keys line sits at the pane's foot;
// each other section says in its own module (its SectionMeta) whether its
// body fits `ctx.rows` yet, and which keys it adds to the keys line. One that
// doesn't fit is drawn whole (the keys line follows it, reached by scrolling).
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
import { actions, header, heading, keysLine, plan, strip, stripWidths, themed, type BodyContext, type KeyHint, type SectionMeta } from './chrome'
import { LABEL, SECTIONS, tabsOf } from './hub'
import { STYLE } from './style'

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
const META = {
  runs: runsSection,
  swarms: swarmsSection,
  rules: rulesSection,
  tasks: tasksSection,
  agents: agentsSection,
  doctor: doctorSection,
} satisfies Record<Exclude<HubSection, 'home'>, SectionMeta<never>>

/** Whether the shown section's body fits `ctx.rows` (the hub clips it there in the dock). */
const fitsOf = (shown: HubSection): boolean => shown === 'home' || META[shown].fits

/** The shown section's own keys, drawn before the hub's. */
const keysOf = (shown: HubSection, view: SectionView | null): readonly KeyHint[] => (shown === 'home' ? [] : META[shown].keys(view as never))

/** The tabs before the hub's first write: every section, nothing counted. */
const blankTabs = (): HubTab[] => tabsOf({ runs: 0, swarms: 0, swarmsNeedYou: false, rules: null, tasks: null, agents: null })

/** register.tsx's ui.render hook for `{ component: 'Pane', requestId: 'litter' }`. Pure. */
export function renderLitterPane(hub: HubView | null, view: SectionView | null, resolved: PaneElements, e: PaneRender): RenderElement {
  const el = themed(tableFor(resolved, e.surface))
  const { Box } = el
  const shown = sectionShown(hub)
  const tabs = hub?.tabs && hub.tabs.length === SECTIONS.length ? hub.tabs : blankTabs()
  const { bodyColumns, isFocused, placement, scroll } = e.props
  const keys = e.surface === 'terminal'
  const layout = plan({ bodyColumns, bodyRows: scroll.bodyRows, context: false, strip: stripWidths(tabs, shown, isFocused), keys })
  const ctx: BodyContext = { surface: e.surface, bodyColumns, isFocused, placement, scroll, rows: layout.bodyRows }
  const clip = fitsOf(shown) && placement === 'dock' && Number.isFinite(layout.bodyRows)
  return (
    <Box flexDirection="column">
      {header(el, { section: LABEL[shown], live: hub?.live ?? [] }, bodyColumns)}
      {strip(el, tabs, shown, isFocused)}
      <Box flexDirection="column" marginTop={1} {...(clip ? { height: layout.bodyRows, overflow: 'hidden' as const } : {})}>
        {body(shown, tabs, view, el, ctx)}
      </Box>
      {keys ? keysLine(el, [...keysOf(shown, view), ...HUB_KEYS], isFocused) : null}
    </Box>
  )
}

/** The shown section's body, through its renderer, over the view register.tsx read from that section's atom. */
function body(shown: HubSection, tabs: readonly HubTab[], view: SectionView | null, el: PaneElements, ctx: BodyContext): RenderElement {
  switch (shown) {
    case 'home':
      return renderHome(tabs, el, ctx)
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

/**
 * Home, a placeholder (WP-DB fills it): each section with its count in
 * words and one [Open]. The first section that needs you has the primary
 * [Open]; the rows past `ctx.rows` are left out.
 */
export function renderHome(tabs: readonly HubTab[], el: PaneElements, ctx: BodyContext): RenderElement {
  const { Box, Text } = el
  const listed = tabs.filter(t => t.section !== 'home')
  const first = listed.find(t => t.needsYou)?.section ?? null
  // A heading, then a row per section (two when narrow: the line, then [Open]).
  const narrow = Number.isFinite(ctx.bodyColumns) && ctx.bodyColumns < 60
  const perRow = narrow ? 2 : 1
  const room = Number.isFinite(ctx.rows) ? Math.max(0, Math.floor((ctx.rows - 1) / perRow)) : listed.length
  const fits = listed.slice(0, room)
  return (
    <Box flexDirection="column">
      {heading(el, 'Sections', listed.length > fits.length ? `${listed.length - fits.length} more below the fold` : null)}
      {fits.map(t => (
        <Box flexDirection={narrow ? 'column' : 'row'} columnGap={1}>
          <Box flexDirection="row" columnGap={1} flexGrow={1}>
            <Text bold color={t.needsYou ? STYLE.needsYou : STYLE.label}>{`${t.needsYou ? '⚑ ' : ''}${t.label}`}</Text>
            <Text color={STYLE.muted} wrap="truncate-end">
              {t.summary}
            </Text>
          </Box>
          {actions(el, [{ key: `home:open:${t.section}`, label: 'Open', primary: t.section === first }])}
        </Box>
      ))}
    </Box>
  )
}
