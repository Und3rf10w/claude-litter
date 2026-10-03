// Tier 1: phase 3's wiring in register.tsx and clear.ts (WP-AA), with the
// engine loading the mod. /litter-board and /litter-rules are registered at
// session.start and again after a /clear; each new hook's catch answers in
// its event's shape; setView writes the board's and the rules pane's atoms;
// and the doctor's trailers row, from the option. AF's handlers are stubs
// here, so a hook is made to throw beneath them: a render through an atom
// whose body the renderer can't draw, every other hook through `rebound`
// after a /clear whose new session id can't be read.

import type { On, RenderElement } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const SESSION = 'tier1-session'
const NO_SESSION = 'the session id is unavailable'

const pane = (title: string) =>
  ({ title, isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }) as const

const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

/**
 * $.fs and $.process.run for a plain checkout at /repo (swarm-panes.test.tsx's
 * world), so session.start resolves the litter directory; the commands
 * registered, in order.
 */
function world(on: On): { commands: { name: string; argumentHint?: string }[]; logs: string[] } {
  const files = new Map<string, string>()
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  const ran = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => {
    if (!isDir(e.path)) throw new Error(`ENOENT: ${e.path}`)
    const names = new Set([...files.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => k.slice(e.path.length + 1).split('/')[0]!))
    return { value: [...names].map(name => ({ name, kind: files.has(`${e.path}/${name}`) ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false })) }
  })
  on('fs.stat', async (_$, e) => {
    const known = files.has(e.path) || isDir(e.path) || e.path === '/repo' || e.path === '/repo/.git'
    if (!known) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: files.has(e.path) ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
  })
  on('process.run', async (_$, e) => {
    const argv = e.argv
    if (argv[0] === 'mv') {
      const [from, to] = argv.slice(-2) as [string, string]
      files.set(to, files.get(from) ?? '')
      files.delete(from)
      return ran(0)
    }
    if (argv[0] === 'rm') {
      const path = argv[argv.length - 1]!
      for (const k of [...files.keys()]) if (k === path || k.startsWith(`${path}/`)) files.delete(k)
      return ran(0)
    }
    if (argv[0] === 'git' && argv.includes('rev-parse')) {
      if (argv.includes('--show-toplevel') && !argv.includes('--git-dir')) return ran(0, '/repo\n')
      if (argv.includes('--git-dir') && argv.includes('--git-common-dir')) return ran(0, '/repo/.git\n/repo/.git\n')
    }
    return ran(1)
  })
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('agent.list', async () => ({ value: [] }))
  const commands: { name: string; argumentHint?: string }[] = []
  on('command.register', async (_$, e) => {
    commands.push({ name: e.name, ...(e.argumentHint ? { argumentHint: e.argumentHint } : {}) })
    return { value: { command: e.name } }
  })
  const logs: string[] = []
  on('ui.log', async (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('session.cwd', async () => ({ value: '/repo' }))
  // No variable is set: the doctor reads the limits' overrides, and none applies.
  mock.env(on, {})
  return { commands, logs }
}

/** The writes of the mod's $.state values, by key, as they land. */
function stateWrites(on: On): { key: string; value: unknown }[] {
  const seen: { key: string; value: unknown }[] = []
  on('state.set', async (_$, e, next) => {
    seen.push({ key: e.key, value: e.value })
    return next(e)
  })
  return seen
}

/** session.id answers `sid.value`, or throws once `sid.value` is null. */
function sessionId(on: On, sid: { value: string | null }): { calls: number } {
  const seen = { calls: 0 }
  on('session.id', async () => {
    seen.calls++
    if (sid.value === null) throw new Error(NO_SESSION)
    return { value: sid.value }
  })
  return seen
}

/** The engine's clear as the mod sees it: session.end `clear` for the session that ends. */
const clearEnds = ($: Engine, from: string) => $.session.end({ reason: 'clear', sessionId: from, resume: { id: from } })

const PHASE3 = [{ name: 'litter-board', argumentHint: '[run | execute | design]' }, { name: 'litter-rules' }]

describe('/litter-board and /litter-rules', () => {
  test('are registered at session.start, after the swarm commands, and again after a /clear', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1_800_000_000_000 })
    const { commands } = world(on)
    const sid = { value: SESSION as string | null }
    sessionId(on, sid)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    expect(commands).toEqual([{ name: 'litter-swarm', argumentHint: '[name]' }, { name: 'litter-doctor' }, ...PHASE3])

    // The engine's clear: session.end `clear`, then a new id, and no session.start.
    await clearEnds($, SESSION)
    sid.value = 'tier1-after-clear'
    const before = commands.length
    // The first hook after it rebinds, which registers every command again.
    await run($, 'litter-rules')
    expect(commands.slice(before).filter(c => c.name === 'litter-board' || c.name === 'litter-rules')).toEqual(PHASE3)
  })

  test("setView writes the board's and the rules pane's atoms, which their panes draw", async ($, on) => {
    mock.store(on)
    const writes = stateWrites(on)
    expect((await run($, 'litter-board')).text).toBe("litter: the board isn't built yet (phase 3, package AF)")
    expect((await run($, 'litter-rules')).text).toBe("litter: the rules pane isn't built yet (phase 3, package AF)")
    expect(writes).toEqual([
      { key: 'board', value: { view: 'board', v: 0, run: null } },
      { key: 'rulesPane', value: { view: 'rules', v: 0, tab: 'proposed' } },
    ])
    const board = await $.ui.mount({ plugin: 'litter', surface: 'terminal', component: 'Pane', requestId: 'litter-board', props: pane('litter board') })
    expect((await board.find({ type: 'Text', text: 'litter · board' }))?.text).toBe('litter · board')
    const rules = await $.ui.mount({ plugin: 'litter', surface: 'desktop', component: 'Pane', requestId: 'litter-rules', props: pane('litter rules') })
    expect((await rules.find({ type: 'Text', text: 'litter · rules' }))?.text).toBe('litter · rules')
  })
})

describe("each new hook's catch answers in its event's shape", () => {
  test('command.run: a line naming the command', async ($, on) => {
    mock.store(on)
    on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
    on('ui.log', async () => ({ value: undefined }))
    const sid = { value: SESSION as string | null }
    const ids = sessionId(on, sid)
    await clearEnds($, SESSION)
    sid.value = null
    // The engine skips the throwing session.id hook, and nothing beneath it answers: `rebound` throws either way.
    expect(await run($, 'litter-board')).toEqual(expect.objectContaining({ text: expect.stringMatching(/^litter: \/litter-board failed \(.*session\.id.*\)$/) }))
    expect(await run($, 'litter-rules')).toEqual(expect.objectContaining({ text: expect.stringMatching(/^litter: \/litter-rules failed \(.*session\.id.*\)$/) }))
    expect(ids.calls).toBeGreaterThanOrEqual(2)
  })

  for (const [requestId, atom] of [
    ['litter-board', 'board'],
    ['litter-rules', 'rulesPane'],
  ] as const) {
    test(`${requestId}: ui.render passes on, then ui.press, ui.input and ui.select pass on`, async ($, on) => {
      mock.store(on)
      // The pane's atom holds a body whose title isn't spans: the mod's render throws on it, and its catch passes the render on.
      on('state.get', async (_$, e, next) => {
        if (e.key === atom) return { value: { value: { view: atom === 'board' ? 'board' : 'rules', v: 1, body: { title: 'not spans' } }, version: 1 } }
        return next(e)
      })
      on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
      const reached: string[] = []
      on('ui.render', { component: 'Pane', requestId }, async (hooks, e): Promise<RenderElement> => {
        const el = hooks.ui.resolve(e)
        const { Box, Text, Button } = el
        const children: RenderElement[] = [
          Text({ children: 'drawn below the mod' }),
          Button({ key: 'probe', label: 'Probe', onPress: () => void reached.push('press') }),
        ]
        if ('Input' in el && 'Select' in el) {
          children.push(el.Input({ key: 'probe-in', label: 'In', onSubmit: v => void reached.push(`input ${v}`) }))
          children.push(
            el.Select({
              key: 'probe-sel',
              label: 'Pick',
              options: [
                { value: 'a', label: 'A' },
                { value: 'b', label: 'B' },
              ],
              value: 'a',
              onSelect: v => void reached.push(`select ${v}`),
            }),
          )
        }
        return Box({ flexDirection: 'column', children })
      })
      const sid = { value: SESSION as string | null }
      const ids = sessionId(on, sid)

      const ui = await $.ui.mount({ plugin: 'litter', surface: 'desktop', component: 'Pane', requestId, props: pane(requestId) })
      expect((await ui.find({ type: 'Text', text: 'drawn below the mod' }))?.text).toBe('drawn below the mod')

      // A /clear whose new id can't be read: every hook's `rebound` throws, and each catch passes on.
      await clearEnds($, SESSION)
      sid.value = null
      const before = ids.calls
      // The elements are the test's, drawn in the mod's pane: each event's chain runs the mod's hook first.
      expect(await ui.press({ key: 'probe', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'probe' }))
      expect(await ui.input({ key: 'probe-in', text: 'typed', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'probe-in', value: 'typed' }))
      expect(await ui.select({ key: 'probe-sel', value: 'b', plugin: 'test' })).toEqual(expect.objectContaining({ element: 'probe-sel', value: 'b' }))
      expect(reached).toEqual(['press', 'input typed', 'select b'])
      // Each of the three hooks reached `rebound`, which threw.
      expect(ids.calls - before).toBeGreaterThanOrEqual(3)
    })
  }

  // Only the plugin's own tree loads its Client modules, and only its own hooks hear their posts, so
  // the board draws the gate table itself here and the post settles on core's `{}` once the catch
  // passes it on. The rules pane has no Client yet, so its ui.message can't be raised at this tier.
  test('litter-board: ui.message from the gate table passes on', async ($, on) => {
    mock.store(on)
    const view = { view: 'board', v: 1, run: 'r', body: { title: [{ text: 'litter · board' }], gates: { run: 'r', rows: [], selected: null } } }
    on('state.get', async (_$, e, next) => (e.key === 'board' ? { value: { value: view, version: 1 } } : next(e)))
    on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
    const sid = { value: SESSION as string | null }
    const ids = sessionId(on, sid)

    const ui = await $.ui.mount({ plugin: 'litter', surface: 'desktop', component: 'Pane', requestId: 'litter-board', props: pane('litter-board') })
    expect((await ui.find({ type: 'Text', text: 'litter · board' }))?.text).toBe('litter · board')

    await clearEnds($, SESSION)
    sid.value = null
    const before = ids.calls
    expect(await ui.post({ pick: 1 }, { in: 'board-gates' })).toBeUndefined()
    // The mod's hook reached `rebound`, which threw; the drawing is still whole.
    expect(ids.calls - before).toBeGreaterThanOrEqual(1)
    expect((await ui.find({ type: 'Text', text: 'litter · board' }))?.text).toBe('litter · board')
  })
})

describe("the doctor's trailers row", () => {
  const trailersRow = (writes: { key: string; value: unknown }[]) => {
    const doctor = writes.filter(w => w.key === 'doctorPane').at(-1)?.value as { body?: { rows: { id: string; title: string; detail: string; glyph: string }[] } } | undefined
    return doctor?.body?.rows.find(r => r.id === 'trailers')
  }

  test('an info row when the option is empty', async ($, on) => {
    mock.store(on)
    world(on)
    const writes = stateWrites(on)
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    await run($, 'litter-doctor')
    expect(trailersRow(writes)).toEqual(
      expect.objectContaining({
        title: 'Commit trailers',
        detail: "litter's commits carry no attribution lines; set the trailers option if your organization requires them",
      }),
    )
  })

  test('ok with the count when it is set; a line that is not Key: value is dropped and logged once', { options: { trailers: ['Co-Authored-By: A Person <a@example.com>', 'not a trailer'] } }, async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1_800_000_000_000 })
    const { logs } = world(on)
    sessionId(on, { value: SESSION })
    const writes = stateWrites(on)
    on('ui.open', async () => ({ value: { isPlaced: true } }))
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const dropped = logs.filter(l => l.includes("the trailers option's lines"))
    expect(dropped).toEqual([`litter: the trailers option's lines that aren't one Key: value each were dropped: "not a trailer"`])
    await run($, 'litter-doctor')
    expect(trailersRow(writes)).toEqual(
      expect.objectContaining({ title: 'Commit trailers', detail: 'litter adds 1 line from the trailers option to each commit it lands' }),
    )
  })
})
