// litter's one command (phase 5b, WP-DA): `/litter [section] [arg]`, which
// opens the `litter` pane on a section (ui/hub.ts, litterCommand). It
// replaces phase 3's and phase 5's six pane commands. Registered at
// session.start and again after a /clear (clear.ts), served by the
// command.run hook in register.tsx.

import type { Ports } from './ports'
import { ARGUMENT_HINT } from './ui/hub'

export async function registerLitterCommand(p: Ports): Promise<void> {
  await p.registerCommand({
    name: 'litter',
    description: "Open litter's pane: Home, Runs, Swarms, Rules, Tasks, Agents, Stats or Doctor",
    argumentHint: ARGUMENT_HINT,
    immediate: true,
  })
}
