// Tier 1: a repair swarm's start on the lead's next turn (WP-X; COMMON 2b-2,
// step 3, decision 2) as the engine runs it. A repair swarm this session owns
// is recovered at session.start with its start still pending in $.store (the
// bridge started it, then the session reloaded). The next prompt carries the
// note in its context; a subagent's turn.complete schedules nothing; the
// lead's schedules the start, which reaches the engine only once the clock
// runs the timer, as a prompt that doesn't start with a slash and carries no
// note of its own. The world is in memory: $.fs from a map of files, and
// git's answers for a plain checkout at /repo with the swarm's ownership ref,
// whose blob names this session.

import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const SESSION = 'tier1-session'
const LITTER = '/repo/.claude/litter'
const RUN = '20261003-fan'
const RUN_DIR = `${LITTER}/${RUN}`
const NAME = 'repair-1a2b3c'
const LAUNCH = '20261003-120000'
const OID = 'a'.repeat(40)
const SWARM = `${LITTER}/swarms/${NAME}`
const SPEC = { name: NAME, goal: `Repair the combined result of fanout run ${RUN}.`, nodes: [{ id: 'repair', kind: 'orchestrator', worktree: 'none' }] }
const NOTE = `litter: repair swarm ${NAME} is live for run ${RUN}; litter starts it after this turn.`

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/** The launch ledger's swarm.start, with the run and budget a repair swarm carries; and the spec at revision 1. */
async function files(): Promise<Map<string, string>> {
  const start = {
    v: 1,
    seq: 1,
    kind: 'swarm.start',
    run: `swarm:${NAME}/${LAUNCH}`,
    at: 1,
    by: { source: 'mod' },
    prev: null,
    body: {
      swarm: NAME,
      launch: LAUNCH,
      revision: 1,
      specHash: await sha256(JSON.stringify(SPEC)),
      nonce: 'b'.repeat(32),
      types: { repair: `litter:sw-${NAME}-repair` },
      nodes: { repair: { dir: '/repo', branch: null, created: false } },
      authority: { repair: 'repair: commit unchecked; push: the lead pushes nothing for it; files anywhere' },
      tips: {},
      owner: { ref: `refs/litter-swarm/${NAME}`, oid: OID, generation: 1 },
      sessionCwd: '/repo',
      worktreeRoot: '/repo/.claude/worktrees',
      commonDir: '/repo/.git',
      roots: { litterDir: LITTER, litterCopies: [LITTER], ruleDirs: [] },
      run: { runDir: RUN_DIR, run: RUN, generation: 2 },
      budget: { rounds: 3, agents: 6 },
      confirmedBy: { run: RUN },
    },
  }
  return new Map([
    [`${SWARM}/launches/${LAUNCH}/ledger/000001-swarm.start.json`, `${JSON.stringify(start)}\n`],
    [`${SWARM}/revisions/1.json`, `${JSON.stringify(SPEC)}\n`],
  ])
}

/**
 * $.fs from the map, and $.process.run for the git calls a plain checkout at
 * /repo answers, plus the swarm's ref and its blob, naming this session: a
 * retake that hashes to the same oid swaps nothing. mv, rm and mkdir as
 * fsx.ts runs them; anything else fails.
 */
function world(on: On, map: Map<string, string>): void {
  const isDir = (path: string) => [...map.keys()].some(k => k.startsWith(`${path}/`))
  const run = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const blob = JSON.stringify({ swarm: NAME, launch: LAUNCH, session: SESSION, generation: 1, host: 'unknown', pid: '', acquiredAt: 1 })
  on('fs.exists', async (_$, e) => ({ value: map.has(e.path) || isDir(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = map.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    map.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => {
    if (!isDir(e.path)) throw new Error(`ENOENT: ${e.path}`)
    const names = new Set([...map.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => k.slice(e.path.length + 1).split('/')[0]!))
    return {
      value: [...names].map(name => ({ name, kind: map.has(`${e.path}/${name}`) ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false })),
    }
  })
  on('fs.stat', async (_$, e) => {
    const known = map.has(e.path) || isDir(e.path) || e.path === '/repo' || e.path === '/repo/.git'
    if (!known) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: map.has(e.path) ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
  })
  on('process.run', async (_$, e) => {
    const argv = e.argv
    if (argv[0] === 'mv') {
      const [from, to] = argv.slice(-2) as [string, string]
      map.set(to, map.get(from) ?? '')
      map.delete(from)
      return run(0)
    }
    if (argv[0] === 'rm') {
      const path = argv[argv.length - 1]!
      for (const k of [...map.keys()]) if (k === path || k.startsWith(`${path}/`)) map.delete(k)
      return run(0)
    }
    if (argv[0] === 'mkdir') return run(0)
    if (argv[0] === 'git' && argv.includes(`refs/litter-swarm/${NAME}`) && argv.includes('rev-parse')) return run(0, `${OID}\n`)
    if (argv[0] === 'git' && argv.includes('cat-file') && argv.includes(OID)) return run(0, blob)
    if (argv[0] === 'git' && argv.includes('hash-object')) return run(0, `${OID}\n`)
    if (argv[0] === 'git' && argv.includes('rev-parse')) {
      if (argv.includes('--show-toplevel') && !argv.includes('--git-dir')) return run(0, '/repo\n')
      if (argv.includes('--git-dir') && argv.includes('--git-common-dir')) return run(0, '/repo/.git\n/repo/.git\n')
    }
    return run(1)
  })
}

type Seen = { text: string; context: readonly string[] }

/** session.start as this session, its repair swarm's start pending in $.store; every prompt the engine sees is kept. */
async function started($: Engine, on: On): Promise<{ clock: MockClock; seen: Seen[]; logs: string[] }> {
  mock.store(on, { [`litter.repair.start.${LITTER}`]: [{ swarm: NAME, launch: LAUNCH, run: RUN, runDir: RUN_DIR, litterDir: LITTER, at: 1 }] })
  const clock = mock.clock(on, { now: 5_000 })
  world(on, await files())
  const logs: string[] = []
  on('ui.log', async (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('agent.list', async () => ({ value: [] }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  const seen: Seen[] = []
  on('prompt.submit', async (_$, e) => {
    seen.push({ text: e.text, context: [...(e.context ?? [])] })
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  return { clock, seen, logs }
}

const turn = (agentId?: string) => ({ turnId: 'turn-1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' as const, ...(agentId ? { agentId } : {}) })

describe("a repair swarm's start on the lead's next turn", () => {
  test("the prompt's context carries the note; the lead's turn.complete schedules the start, which a timer submits", async ($, on) => {
    const { clock, seen, logs } = await started($, on)
    // Nothing is submitted at session.start itself.
    await clock.settle()
    expect(seen).toEqual([])

    // The next prompt: the note rides in its context, after what was there.
    await $.prompt.submit({ text: 'what happened?', origin: { kind: 'composer' }, context: ['earlier'], wait: false })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.context[0]).toBe('earlier')
    expect(seen[0]!.context.some(c => c.startsWith(NOTE))).toBe(true)

    // A subagent's turn schedules nothing.
    expect((await $.turn.complete(turn('agent-7'))).text).toBe('done')
    await clock.settle()
    expect(seen).toHaveLength(1)

    // The lead's turn passes on, and only the timer after it submits the start.
    expect((await $.turn.complete(turn())).text).toBe('done')
    expect(seen).toHaveLength(1)
    await clock.settle()
    expect(seen).toHaveLength(2)
    const start = seen[1]!
    expect(start.text.startsWith('/')).toBe(false)
    expect(start.text).toStartWith(`litter: repair swarm ${NAME} is live for run ${RUN}`)
    expect(start.text).toContain(`run the litter swarm skill with start ${NAME}`)
    // The start's own turn carries no note: it's handed over already.
    expect(start.context.some(c => c.startsWith(NOTE))).toBe(false)
    expect(logs.some(l => l.includes("its start wasn't submitted"))).toBe(false)

    // Once submitted, a later turn submits nothing more, and the note is gone.
    await $.turn.complete(turn())
    await clock.settle()
    expect(seen).toHaveLength(2)
    await $.prompt.submit({ text: 'and now?', origin: { kind: 'composer' }, wait: false })
    expect(seen[2]!.context.some(c => c.startsWith(NOTE))).toBe(false)
  })

  test('an interrupted lead turn schedules nothing, and the note stays for the next prompt', async ($, on) => {
    const { clock, seen } = await started($, on)
    await $.turn.complete({ ...turn(), isAborted: true, reason: 'aborted' })
    await clock.settle()
    expect(seen).toEqual([])
    await $.prompt.submit({ text: 'go on', origin: { kind: 'composer' }, wait: false })
    expect(seen[0]!.context.some(c => c.startsWith(NOTE))).toBe(true)
  })
})
