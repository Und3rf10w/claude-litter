// Tier 2: phase 5's commands (hooks/uicommands.ts; WP-CA): /litter-tasks
// [list] and /litter-agents [team], each immediate, in that order; and a
// refused registration rejects, which session.start's and the rebind's steps
// log.

import { describe, expect, test } from 'bun:test'
import { registerPhase5Commands } from '../../hooks/uicommands'
import { nodePorts } from './support/node-ports'

describe('registerPhase5Commands', () => {
  test('registers /litter-tasks [list] and /litter-agents [team], immediate, in that order', async () => {
    const p = nodePorts()
    await registerPhase5Commands(p)
    expect(p.commands).toEqual([
      {
        name: 'litter-tasks',
        description: "Open the tasks pane: a task list's tasks, filtered, sorted and edited in place",
        argumentHint: '[list]',
        immediate: true,
      },
      {
        name: 'litter-agents',
        description: 'Open the agents pane: agents, their inboxes and transcripts; message one, broadcast to a team, or stop one',
        argumentHint: '[team]',
        immediate: true,
      },
    ])
  })

  test("a refused registration rejects with the engine's reason, so the caller's step logs it", async () => {
    const p = nodePorts()
    p.registerCommand = async spec => {
      p.commands.push(spec)
      if (spec.name === 'litter-tasks') throw new Error('command.register refused: the name is taken')
    }
    await expect(registerPhase5Commands(p)).rejects.toThrow('command.register refused: the name is taken')
    expect(p.commands.map(c => c.name)).toEqual(['litter-tasks'])
  })
})
