// /litter-tasks and the tasks pane (phase 5; COMMON step 5, decisions 4, 15,
// 16): a task list's tasks with filters, a sort, owners and blocked state,
// and an inline editor, rebuilt on the ui tick while the pane is open. Keys
// are `tasks:<action>[:<arg>]`. Reads and writes go through
// hooks/team/store.ts. Owner: WP-CE.
//
// CA's stub: the command answers that the pane isn't built yet, the render
// draws the "nothing yet" tree, the handlers pass on, the tick and the
// refresh write nothing.

import type { RenderElement } from 'claude-code'
import type { Ports } from '../ports'
import type { CommandRunHook, PaneElements, PaneRender, PaneUiHandlers, PortHook } from '../hooktypes'
import type { TasksPaneView } from '../../types/index'
import { header, tableFor } from '../swarm/builder'

export const TASKS_PANE = 'litter-tasks'

/** command.run on `litter-tasks`: opens the pane on the list named, else this session's own; answers a one-line `text`. */
export const tasksCommand: PortHook<CommandRunHook> = async (p, e, next) => ({ text: "litter: the tasks pane isn't built yet (WP-CE)" })

/** register.tsx's ui.render hook for `{ component: 'Pane', requestId: 'litter-tasks' }` calls it with the tasksPane atom. A pure renderer. */
export function renderTasksPane(view: TasksPaneView | null, resolved: PaneElements, e: PaneRender): RenderElement {
  const el = tableFor(resolved, e.surface)
  const { Box, Text } = el
  const body = view?.body
  if (!body) {
    return (
      <Box flexDirection="column">
        <Text bold>litter · tasks</Text>
        <Text dimColor>nothing to show yet: /litter-tasks opens a task list</Text>
      </Box>
    )
  }
  return <Box flexDirection="column">{header(el, body.title, body.notice ?? null)}</Box>
}

/** The pane's ui.message, ui.press, ui.input and ui.select; anything not keyed `tasks:` passes on. */
export const onTasksUi: PaneUiHandlers = {
  message: async (p, e, next) => next(e),
  press: async (p, e, next) => next(e),
  input: async (p, e, next) => next(e),
  select: async (p, e, next) => next(e),
}

/** The ui tick's third step (uitick.ts): the pane's view again while it's open, written only when its stamp moved. */
export async function tasksTick(p: Ports): Promise<void> {}

/** After a /clear wiped $.state (clear.ts): the pane's view again, if it's open. */
export async function refreshTasks(p: Ports): Promise<void> {}
