// WP-N: /litter-swarm and /litter-doctor, and the panes' handlers: every
// press, input, pick and tree message calls the package that owns it, then
// refreshes the view (p.setView), which register.tsx's ui.render hooks draw.
//
// Stub (phase 2b-1, package C), not built yet: the signatures are the
// contract; the bodies are N's. Until then nothing is registered, and every
// handler passes on.

import type { Ports } from '../ports'
import type { CommandRunHook, PortHook, UiInputHook, UiMessageHook, UiPressHook, UiSelectHook } from '../hooktypes'

/** At session.start, with the roles: `/litter-swarm [name]` and `/litter-doctor`. */
export async function registerSwarmCommands(p: Ports): Promise<void> {}

/** command.run on `litter-swarm`: opens the `litter-swarm` pane, answering with a one-line `text`. */
export const swarmCommand: PortHook<CommandRunHook> = async (p, e, next) => next(e)

/** command.run on `litter-doctor`: opens the `litter-doctor` pane. */
export const doctorCommand: PortHook<CommandRunHook> = async (p, e, next) => next(e)

/** ui.message from the tree's Client (`e.element === 'swarm-tree'`). */
export const onUiMessage: PortHook<UiMessageHook> = async (p, e, next) => next(e)

/** ui.press on the panes' buttons, keyed `swarm:<view>:<action>[:<arg>]`. */
export const onUiPress: PortHook<UiPressHook> = async (p, e, next) => next(e)

export const onUiInput: PortHook<UiInputHook> = async (p, e, next) => next(e)

export const onUiSelect: PortHook<UiSelectHook> = async (p, e, next) => next(e)

/** At session.start, with the timers: rebuilds an open pane's view every second when state.ts's version or a ledger head changed. */
export function startPaneTimer(p: Ports): void {}

/** Rebuilds both views now (O after a /clear rebind, since $.state was wiped). */
export async function refreshPanes(p: Ports): Promise<void> {}
