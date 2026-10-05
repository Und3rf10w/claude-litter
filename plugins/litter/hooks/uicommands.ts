// Phase 5's commands (WP-CA): `/litter-tasks [list]` (CE's pane) and
// `/litter-agents [team]` (CG's), registered at session.start and again after
// a /clear (clear.ts), each served by a command.run hook in register.tsx.

import type { Ports } from './ports'

export async function registerPhase5Commands(p: Ports): Promise<void> {
  await p.registerCommand({
    name: 'litter-tasks',
    description: "Open the tasks pane: a task list's tasks, filtered, sorted and edited in place",
    argumentHint: '[list]',
    immediate: true,
  })
  await p.registerCommand({
    name: 'litter-agents',
    description: 'Open the agents pane: agents, their inboxes and transcripts; message one, broadcast to a team, or stop one',
    argumentHint: '[team]',
    immediate: true,
  })
}
