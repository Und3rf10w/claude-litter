// Tier 1: mcp__litter__swarm_read as the engine runs it (WP-K): answered in
// its hook, never passed on; its refusals as error results; a swarm another
// session owns, recovered read-only at session.start and read with nothing to
// spawn; and a throw inside the hook turned into its catch's deny. The world
// is in memory: $.fs from a map of files, git's answers for a plain checkout
// at /repo with the swarm's ownership ref, and the store holding the owner's
// copy of the swarm.

import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const LAUNCH = '20261003-120000'
const OID = 'a'.repeat(40)
const LITTER = '/repo/.claude/litter'
const LEDGER = `${LITTER}/swarms/alpha/launches/${LAUNCH}/ledger`
const SPEC = { name: 'alpha', goal: 'Tidy the docs.', nodes: [{ id: 'lead', kind: 'orchestrator', worktree: 'none' }] }
const AUTHORITY = 'lead: commit unchecked; push unchecked; rewrite history unchecked; worktree commands unchecked; files anywhere'

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/** The launch ledger: swarm.start, then lead #1's swarm.node, chained as ledgercore.ts writes them. */
async function ledger(): Promise<Map<string, string>> {
  const run = `swarm:alpha/${LAUNCH}`
  const by = { source: 'mod' }
  const start = {
    v: 1,
    seq: 1,
    kind: 'swarm.start',
    run,
    at: 1,
    by,
    prev: null,
    body: {
      swarm: 'alpha',
      launch: LAUNCH,
      revision: 1,
      specHash: 'f'.repeat(64),
      nonce: 'b'.repeat(32),
      types: { lead: 'litter:sw-alpha-lead' },
      nodes: { lead: { dir: '/repo', branch: null, created: false } },
      authority: { lead: AUTHORITY },
      tips: {},
      owner: { ref: 'refs/litter-swarm/alpha', oid: OID, generation: 1 },
      sessionCwd: '/repo',
      worktreeRoot: '/repo/.claude/worktrees',
      commonDir: '/repo/.git',
      roots: { litterDir: LITTER, litterCopies: [LITTER], ruleDirs: [] },
    },
  }
  const first = `${JSON.stringify(start)}\n`
  const node = {
    v: 1,
    seq: 2,
    kind: 'swarm.node',
    run,
    at: 2,
    by,
    prev: await sha256(first),
    body: { node: 'lead', n: 1, agentId: 'ag-1', parentAgentId: null, kind: 'orchestrator', cwd: '/repo', branch: null, model: null, revision: 1, generation: 1 },
  }
  return new Map([
    [`${LEDGER}/000001-swarm.start.json`, first],
    [`${LEDGER}/000002-swarm.node.json`, `${JSON.stringify(node)}\n`],
  ])
}

/** The owner's copy of the swarm in $.store (state.ts's part), with lead #1 running there. */
const PART = {
  [`litter.swarm.state.${LITTER}.alpha`]: {
    v: 1,
    swarm: {
      name: 'alpha',
      launch: LAUNCH,
      revision: 1,
      spec: SPEC,
      nonce: 'b'.repeat(32),
      types: { lead: 'litter:sw-alpha-lead' },
      typesReady: true,
      dirs: { lead: { dir: '/repo', branch: null, created: false } },
      sessionCwd: '/repo',
      worktreeRoot: '/repo/.claude/worktrees',
      commonDir: '/repo/.git',
      roots: { litterDir: LITTER, litterCopies: [LITTER], ruleDirs: [] },
      tips: {},
      owner: { ref: 'refs/litter-swarm/alpha', oid: OID, generation: 1, session: 'owner-session' },
      state: 'live',
      readOnly: false,
      lost: false,
      flags: { isolationLost: false },
      startedAt: 1,
    },
    bindings: [],
    admission: [{ agentId: 'ag-1', status: 'running', scope: null, swarm: 'alpha', node: 'lead', parent: null, kind: 'orchestrator' }],
    stopped: [],
    instances: { lead: 1 },
    calls: [],
    shells: [],
    agentStopped: [],
    reports: {},
    tokens: {},
    questions: [],
    direct: [],
    refused: {},
  },
}

/**
 * $.fs from a map of files, and $.process.run for the git calls a plain
 * checkout at /repo answers (as record.test.ts's world), plus the swarm's
 * ref and its blob, naming another session. With `fail.list` set, fs.list's
 * hook throws, so the engine skips it and the bottom hook throws in its place.
 */
function world(on: On, files: Map<string, string>, fail: { list: boolean }): void {
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  const run = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  const blob = JSON.stringify({ swarm: 'alpha', launch: LAUNCH, session: 'owner-session', generation: 1, host: 'elsewhere', pid: '4242', acquiredAt: 1 })
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
    if (fail.list) throw new Error('the disk went away')
    if (!isDir(e.path)) throw new Error(`ENOENT: ${e.path}`)
    const names = new Set([...files.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => k.slice(e.path.length + 1).split('/')[0]!))
    return {
      value: [...names].map(name => ({ name, kind: files.has(`${e.path}/${name}`) ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false })),
    }
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
    if (argv[0] === 'git' && argv.includes('refs/litter-swarm/alpha') && argv.includes('rev-parse')) return run(0, `${OID}\n`)
    if (argv[0] === 'git' && argv.includes('cat-file') && argv.includes(OID)) return run(0, blob)
    if (argv[0] === 'git' && argv.includes('rev-parse')) {
      if (argv.includes('--show-toplevel') && !argv.includes('--git-dir')) return run(0, '/repo\n')
      if (argv.includes('--git-dir') && argv.includes('--git-common-dir')) return run(0, '/repo/.git\n/repo/.git\n')
    }
    return run(1)
  })
}

/** session.start in the world above, as the session tier1-session: it shows alpha read-only. */
async function started($: Engine, on: On, fail: { list: boolean }): Promise<void> {
  mock.store(on, PART)
  mock.clock(on, { now: 5_000 })
  world(on, await ledger(), fail)
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('session.id', async () => ({ value: 'tier1-session' }))
  on('ui.log', async () => ({ value: undefined }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
}

const parse = (r: { result?: unknown }) => JSON.parse(String(r.result)) as Record<string, unknown>

describe('mcp__litter__swarm_read', () => {
  test("is answered by the mod, never passed on: an agent's call and a bad name are error results", async ($, on) => {
    mock.store(on)
    let reached = false
    on('tool.call', { tool: 'mcp__litter__swarm_read' }, async () => {
      reached = true
      return { result: 'engine' }
    })
    const agent = parse(await $.tool.call({ tool: 'mcp__litter__swarm_read', tool_use_id: 'r1', agentId: 'a1', swarm: 'alpha' }))
    expect(agent).toEqual({ ok: false, error: expect.stringContaining("mcp__litter__swarm_read is the lead's") })
    const bad = parse(await $.tool.call({ tool: 'mcp__litter__swarm_read', tool_use_id: 'r2', swarm: 'Not A Name' }))
    expect(bad).toEqual({ ok: false, error: expect.stringContaining("'swarm' must be a swarm name") })
    expect(reached).toBe(false)
  })

  test("another session's swarm, recovered at session.start, reads read-only with nothing to spawn", async ($, on) => {
    await started($, on, { list: false })
    const r = parse(await $.tool.call({ tool: 'mcp__litter__swarm_read', tool_use_id: 'r3', swarm: 'alpha' }))
    expect(r).toEqual({
      ok: true,
      swarm: 'alpha',
      launch: LAUNCH,
      revision: 1,
      readOnly: true,
      authority: [AUTHORITY],
      orchestrators: [],
      nodes: [{ node: 'lead', kind: 'orchestrator', instances: [{ n: 1, agentId: 'ag-1', status: 'running', lastReport: null, openQuestions: [] }] }],
    })
    const draft = parse(await $.tool.call({ tool: 'mcp__litter__swarm_read', tool_use_id: 'r4', swarm: 'alpha', node: 'lead', for: 'resume' }))
    expect(draft).toEqual({ ok: false, error: expect.stringContaining('owned by session owner-session') })
  })

  test("a throw inside the hook reaches swarmReadFailed's deny", async ($, on) => {
    const fail = { list: false }
    await started($, on, fail)
    fail.list = true
    const r = await $.tool.call({ tool: 'mcp__litter__swarm_read', tool_use_id: 'r5', swarm: 'alpha' })
    expect(r.result).toBeUndefined()
    // A hook that throws is skipped, so the read reaches the bottom one, which names its noun.
    expect(r.deny).toContain('litter guard failed: mcp__litter__swarm_read (')
    expect(r.deny).toContain('fs.list')
    expect(r.deny).toContain('refusing')
  })
})
