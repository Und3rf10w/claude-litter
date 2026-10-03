// /litter-board and /litter-rules, and the board pane (phase 3; plan section
// 11, decision 21): a run drawn from its ledger, rebuilt by a timer while
// the pane is open, its keys `board:<action>[:<arg>]`. Owner: phase 3,
// package AF.
//
// AA's stub: the two commands are registered for real. /litter-board writes
// an empty view (so the board's atom is wired end to end) and answers that
// the board isn't built yet; the render draws a placeholder, and a view's
// gate table as the Client (so the plugin loads gates.tsx); every ui.* event
// passes on; the timer and refreshBoard do nothing.

import type { RenderElement } from 'claude-code'
import type { Ports } from '../ports'
import type { CommandRunHook, PaneElements, PaneRender, PaneUiHandlers, PortHook } from '../hooktypes'
import type { BoardGatesProps, BoardView } from '../../types/index'

export const BOARD_PANE = 'litter-board'

/**
 * At session.start's commands step and again after a /clear (clear.ts):
 * `/litter-board [run | execute | design]` and `/litter-rules`.
 */
export async function registerPhase3Commands(p: Ports): Promise<void> {
  await p.registerCommand({
    name: 'litter-board',
    description: 'Open the board: a litter run, its gates, verdicts, rules and proposals, from its ledger',
    argumentHint: '[run | execute | design]',
    immediate: true,
  })
  await p.registerCommand({
    name: 'litter-rules',
    description: 'Open the rules pane: accept, edit, dismiss or retire rules and proposals',
    immediate: true,
  })
}

/**
 * command.run on `litter-board`: builds the view (view.ts, buildBoard) for
 * the run named, else the newest `execute` or `design` run, else the active
 * one, else the newest; writes it with `p.setView('board', …)`, opens the
 * `litter-board` pane, and answers a one-line `text`.
 */
export const boardCommand: PortHook<CommandRunHook> = async (p, e, next) => {
  await p.setView('board', { view: 'board', v: 0, run: null })
  return { text: "litter: the board isn't built yet (phase 3, package AF)" }
}

/** register.tsx's ui.render hook for `{ component: 'Pane', requestId: 'litter-board' }` calls it with the board atom. A pure renderer. */
export function renderBoardPane(view: BoardView | null, el: PaneElements, e: PaneRender): RenderElement {
  const { Box, Text } = el
  const title = view?.body ? view.body.title.map(s => s.text).join('') : 'litter · board'
  const gates = view?.body?.gates ?? null
  return (
    <Box flexDirection="column">
      <Text bold>{title}</Text>
      <Text dimColor>{view?.run ? `run ${view.run}: nothing to show yet` : 'nothing to show yet: /litter-board opens a run'}</Text>
      {gates && (e.surface === 'terminal' || e.surface === 'desktop') ? gatesTable(el, gates) : null}
    </Box>
  )
}

/** The gate table as the Client module (gates.tsx) where the surface has one. */
function gatesTable(el: PaneElements, gates: BoardGatesProps): RenderElement | null {
  if (!('Client' in el)) return null
  const { Client } = el
  return <Client key="board-gates" module="./gates.tsx" props={gates} width="100%" />
}

/** The board's ui.message (the gate table's posts), ui.press, ui.input and ui.select; anything not keyed `board:` passes on. */
export const onBoardUi: PaneUiHandlers = {
  message: async (p, e, next) => next(e),
  press: async (p, e, next) => next(e),
  input: async (p, e, next) => next(e),
  select: async (p, e, next) => next(e),
}

/** At session.start's timers step: `p.every(2000, …)` rebuilds the view while the board pane is open, only when the run's ledger head moved. */
export function startBoardTimer(p: Ports): void {}

/** Rebuilds the board's view now, if one is shown (after a /clear, from the ledger); cheap when nothing changed. */
export async function refreshBoard(p: Ports): Promise<void> {}
