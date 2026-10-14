// Tier 1: the permission ask line (WP-CF; COMMON decision 1) as the engine
// runs the mod. The PermissionRequest hook is ask.sh, a command hook in
// hooks.json, and the engine runs no settings hook under a test, so what tier
// 1 shows is the mod's half: litter puts no mod hook of its own on
// classic.PermissionRequest (decision 14), so the event and its answer are the
// engine's; and an `ask` line the test spools, after guard.sh's call start
// for the same agent, tool and detail, is drained at session.start into an
// open ask, which sends its notice for the paired call and is mirrored to
// $.store. Its transcript row (WP-CK) goes through $.ui.log at the ui tick,
// for an ask the drain timer opens, never for one a resume's session.start
// replays, and the band draws no row for it. A reload's (WP-EC): an ask whose
// line session.start's drain opens under 30 s after it was spooled gets its
// row, its dialog being up still. hooks.json's entry is tier 3's
// (ask.test.sh, case_wired).

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const LITTER = '/repo/.claude/litter'
const SESSION = 'tier1-session'
const NOW = 1_800_000_000_000

/** $.fs from a map of files, and $.process.run for litterdir.ts's git calls in a plain checkout at /repo and fsx.ts's mv and rm. */
function world(on: On): Map<string, string> {
  const files = new Map<string, string>()
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  const run = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
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
      return run(0)
    }
    if (argv[0] === 'rm') {
      const path = argv[argv.length - 1]!
      for (const k of [...files.keys()]) if (k === path || k.startsWith(`${path}/`)) files.delete(k)
      return run(0)
    }
    if (argv[0] === 'git' && argv.includes('rev-parse')) {
      if (argv.includes('--show-toplevel') && !argv.includes('--git-dir')) return run(0, '/repo\n')
      if (argv.includes('--git-dir') && argv.includes('--git-common-dir')) return run(0, '/repo/.git\n/repo/.git\n')
    }
    return run(1)
  })
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('agent.list', async () => ({ value: [] }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  mock.env(on, {})
  return files
}

describe('the permission ask line', () => {
  test("litter hooks no classic.PermissionRequest of its own: the event and its answer are the engine's", async ($, on) => {
    mock.store(on)
    const seen: unknown[] = []
    on('classic.PermissionRequest', async (_$, e) => {
      seen.push(e)
      return {}
    })
    const input = {
      permission_mode: 'default',
      agent_id: 'a1',
      agent_type: 'litter:executor',
      tool_name: 'Bash',
      tool_input: { command: 'npm install left-pad' },
      permission_suggestions: [],
    }
    const r = await $.classic.PermissionRequest(input as never)
    expect(r).toEqual({})
    expect(seen).toEqual([expect.objectContaining({ hook_event_name: 'PermissionRequest', agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'npm install left-pad' } })])
  })

  test("an ask line drained at session.start opens an ask paired with its call start: its notice goes, and it's mirrored", async ($, on) => {
    // The store in memory, as mock.store keeps it, so the test reads what the mod wrote.
    const store = new Map<string, unknown>()
    on('store.get', async (_$, e) => ({ value: store.get(e.key) }))
    on('store.set', async (_$, e) => {
      store.set(e.key, e.value === undefined ? undefined : JSON.parse(JSON.stringify(e.value)))
      return { value: undefined }
    })
    on('store.delete', async (_$, e) => {
      store.delete(e.key)
      return { value: undefined }
    })
    const clock = mock.clock(on, { now: NOW })
    const files = world(on)
    const notices: { tool_use_id: string; text: string | undefined }[] = []
    on('ui.notice', async (_$, e) => {
      notices.push({ tool_use_id: e.tool_use_id, text: e.text })
      return { value: undefined }
    })
    const ts = NOW / 1000
    const lines = [
      { v: 1, ev: 'call', ts, session_id: SESSION, agent_id: 'a1', agent_type: 'litter:executor', tool: 'Bash', tool_use_id: 'toolu_9', phase: 'start', detail: 'npm install left-pad' },
      { v: 1, ev: 'ask', ts, session_id: SESSION, agent_id: 'a1', agent_type: 'litter:executor', tool: 'Bash', detail: 'npm install left-pad', mode: 'default' },
    ]
    files.set(`${LITTER}/hooks/spool/${SESSION}.jsonl`, `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })

    // $.ui.notice is fire-and-forget: its dispatch settles after the call.
    await clock.settle()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toEqual({ tool_use_id: 'toolu_9', text: '⚑ asking · executor wants Bash: npm install left-pad · authorized: writes in the checkout' })
    const mirror = store.get('litter.asks') as { session: string; asks: { agentId: string; toolUseId: string | null }[] } | undefined
    expect(mirror?.session).toBe(SESSION)
    expect(mirror?.asks.map(a => [a.agentId, a.toolUseId])).toEqual([['a1', 'toolu_9']])
    // The drain took the spool apart.
    expect(files.has(`${LITTER}/hooks/spool/${SESSION}.jsonl`)).toBe(false)
  })

  test("the transcript row (WP-CK): none for an ask a resume's session.start replays; one for an ask the drain timer opens, at the ui tick, never twice", async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on, { now: NOW })
    const files = world(on)
    // $.ui.log's transcript rows, apart from the debug log's lines.
    const rows: string[] = []
    on('ui.log', async (_$, e) => {
      if (e.to !== 'debug') rows.push(e.text)
      return { value: undefined }
    })
    on('ui.notice', async () => ({ value: undefined }))
    // Beneath the band: the engine's own, which draws nothing.
    on('ui.render', { component: 'AbovePrompt' }, async () => ({ type: 'engine', ref: 0 }))
    const spool = `${LITTER}/hooks/spool/${SESSION}.jsonl`
    const lines = (ts: number, toolUseId: string, detail: string) => [
      { v: 1, ev: 'call', ts, session_id: SESSION, agent_id: 'a1', agent_type: 'litter:executor', tool: 'Bash', tool_use_id: toolUseId, phase: 'start', detail },
      { v: 1, ev: 'ask', ts, session_id: SESSION, agent_id: 'a1', agent_type: 'litter:executor', tool: 'Bash', detail, mode: 'default' },
    ]
    const write = (ls: unknown[]) => files.set(spool, `${ls.map(l => JSON.stringify(l)).join('\n')}\n`)
    // A run is active, so the drain timer drains (policy.ts, tick); the spool holds an ask a process that's gone spooled a minute ago.
    files.set(`${LITTER}/hooks/active`, '')
    write(lines(NOW / 1000 - 60, 'toolu_1', 'npm install left-pad'))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(files.has(spool)).toBe(false)
    for (let i = 0; i < 3; i++) await clock.advance(2_000)
    expect(rows).toEqual([])

    // A new ask, spooled while the session runs: the drain timer opens it, the ui tick writes its row.
    write(lines(NOW / 1000 + 6, 'toolu_2', 'pwd'))
    for (let i = 0; i < 4 && rows.length === 0; i++) await clock.advance(2_000)
    expect(files.has(spool)).toBe(false)
    expect(rows).toEqual(['⚑ asking · executor wants Bash: pwd · authorized: writes in the checkout'])
    for (let i = 0; i < 3; i++) await clock.advance(2_000)
    expect(rows).toHaveLength(1)

    // The ask is still open, and the band draws no row for it.
    const band = await $.ui.mount({
      plugin: 'litter',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 95, scroll: { offset: 0, bodyRows: 9 }, view: {} },
    })
    expect(await band.find({ type: 'Text', text: /asking/ })).toBeUndefined()
  })

  test("a reload (WP-EC): an ask spooled seconds before the module came back, which session.start's drain opens, gets its row at the ui tick, once", async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on, { now: NOW })
    const files = world(on)
    const rows: string[] = []
    on('ui.log', async (_$, e) => {
      if (e.to !== 'debug') rows.push(e.text)
      return { value: undefined }
    })
    on('ui.notice', async () => ({ value: undefined }))
    const spool = `${LITTER}/hooks/spool/${SESSION}.jsonl`
    const ts = NOW / 1000 - 3
    const lines = [
      { v: 1, ev: 'call', ts, session_id: SESSION, agent_id: 'a1', agent_type: 'litter:executor', tool: 'Bash', tool_use_id: 'toolu_1', phase: 'start', detail: 'pwd' },
      { v: 1, ev: 'ask', ts, session_id: SESSION, agent_id: 'a1', agent_type: 'litter:executor', tool: 'Bash', detail: 'pwd', mode: 'default' },
    ]
    files.set(`${LITTER}/hooks/active`, '')
    files.set(spool, `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)

    // The earlier module's dialog is still up: no `end` for its call, and no mirror (it drained nothing).
    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    await clock.settle()
    expect(files.has(spool)).toBe(false)
    for (let i = 0; i < 4 && rows.length === 0; i++) await clock.advance(2_000)
    expect(rows).toEqual(['⚑ asking · executor wants Bash: pwd · authorized: writes in the checkout'])
    for (let i = 0; i < 3; i++) await clock.advance(2_000)
    expect(rows).toHaveLength(1)
  })
})
