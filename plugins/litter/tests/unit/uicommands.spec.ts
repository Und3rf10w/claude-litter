// Tier 2: litter's one command (hooks/uicommands.ts; phase 5b, WP-DA):
// `/litter [section] [arg]`, immediate, with the sections as its hint; it
// replaces the six pane commands. A refused registration rejects, which
// session.start's and the rebind's steps log. Its typeahead (WP-EC): the
// sections whose names start with the token while it's the command's first
// argument, none for a name typed in full, a later argument or another
// prompt, and the rows of the plugins beneath first.

import { describe, expect, test } from 'bun:test'
import { litterAutocomplete, litterSuggestions, registerLitterCommand } from '../../hooks/uicommands'
import { nodePorts } from './support/node-ports'

/** prompt.autocomplete's input with the cursor at the end of `text`, the token its last word. */
const box = (text: string) => {
  const start = text.search(/\S+$/)
  return { text, cursor: text.length, token: text.slice(start), start }
}
const texts = (text: string) => litterSuggestions(box(text)).map(s => s.text)

describe('registerLitterCommand', () => {
  test('registers /litter [section] [arg] alone, immediate', async () => {
    const p = nodePorts()
    await registerLitterCommand(p)
    expect(p.commands).toEqual([
      {
        name: 'litter',
        description: "Open litter's pane: Home, Runs, Swarms, Rules, Tasks, Agents, Stats or Doctor",
        argumentHint: '[home | runs | swarms | rules | tasks | agents | stats | doctor] [arg]',
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

describe("the typeahead's sections (WP-EC)", () => {
  test("the sections a token starts, any case, each with what it opens, in the strip's order", () => {
    expect(litterSuggestions(box('/litter r'))).toEqual([
      { text: 'runs', description: "Open litter's pane on Runs" },
      { text: 'rules', description: "Open litter's pane on Rules" },
    ])
    expect(texts('/litter S')).toEqual(['swarms', 'stats'])
    expect(texts('/litter  ag')).toEqual(['agents'])
    expect(texts('/litter h')).toEqual(['home'])
    expect(texts('/litter do')).toEqual(['doctor'])
  })

  test('none for a name typed in full, one no section starts, a later argument, or any other prompt', () => {
    expect(texts('/litter runs')).toEqual([])
    expect(texts('/litter x')).toEqual([])
    expect(texts('/litter runs e')).toEqual([])
    expect(texts('/litter swarms review f')).toEqual([])
    expect(texts('/litterr r')).toEqual([])
    expect(texts('/litter:execute r')).toEqual([])
    expect(texts('please /litter r')).toEqual([])
    expect(texts('/clear r')).toEqual([])
    // The token is what the cursor ends, the command itself included.
    expect(litterSuggestions({ text: '/litter', cursor: 7, token: '/litter', start: 0 })).toEqual([])
    // The cursor back in the first word, with text after it.
    expect(litterSuggestions({ text: '/litter run tasks', cursor: 11, token: 'run', start: 8 }).map(s => s.text)).toEqual(['runs'])
  })

  test("the hook: the plugins beneath first, then litter's; it hands the event on as it came", async () => {
    const e = box('/litter t')
    const seen: unknown[] = []
    const next = (async (x: unknown) => {
      seen.push(x)
      return { suggestions: [{ text: 'theirs' }] }
    }) as never
    const r = await litterAutocomplete(nodePorts(), e as never, next)
    expect(r).toEqual({ suggestions: [{ text: 'theirs' }, { text: 'tasks', description: "Open litter's pane on Tasks" }] })
    expect(seen).toEqual([e])
  })
})
