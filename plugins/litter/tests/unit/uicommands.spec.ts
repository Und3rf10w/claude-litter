// Tier 2: litter's one command (hooks/uicommands.ts; phase 5b, WP-DA):
// `/litter [section] [arg]`, immediate, with the sections as its hint; it
// replaces the six pane commands. A refused registration rejects, which
// session.start's and the rebind's steps log.

import { describe, expect, test } from 'bun:test'
import { registerLitterCommand } from '../../hooks/uicommands'
import { nodePorts } from './support/node-ports'

describe('registerLitterCommand', () => {
  test('registers /litter [section] [arg] alone, immediate', async () => {
    const p = nodePorts()
    await registerLitterCommand(p)
    expect(p.commands).toEqual([
      {
        name: 'litter',
        description: "Open litter's pane: Home, Runs, Swarms, Rules, Tasks, Agents or Doctor",
        argumentHint: '[home | runs | swarms | rules | tasks | agents | doctor] [arg]',
        immediate: true,
      },
    ])
  })

  test("a refused registration rejects with the engine's reason, so the caller's step logs it", async () => {
    const p = nodePorts()
    p.registerCommand = async spec => {
      p.commands.push(spec)
      throw new Error('command.register refused: the name is taken')
    }
    await expect(registerLitterCommand(p)).rejects.toThrow('command.register refused: the name is taken')
    expect(p.commands.map(c => c.name)).toEqual(['litter'])
  })
})
