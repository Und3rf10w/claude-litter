// Tier 1: a swarm node's verify, verdict and land through the record tool as
// the engine runs it (WP-Y): routed to swarm/gate.ts by the caller's
// binding, answered in the record tool's result shape, a refusal naming its
// field. The world is swarm-read.test.ts's: another session's swarm, recovered
// read-only at session.start with its bindings from the launch's swarm.node
// records, here with a child of its node too. A live repair swarm's records,
// which need real git, are tier 2 (tests/unit/gate.spec.ts, repairland.spec.ts).

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

/** The launch ledger: swarm.start, lead #1's swarm.node, then a child lead #1 started, chained as ledgercore.ts writes them. */
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
  const records = [start]
  const node = (seq: number, body: Record<string, unknown>) => ({ v: 1, seq, kind: 'swarm.node', run, at: seq, by, prev: '', body })
  records.push(
    node(2, { node: 'lead', n: 1, agentId: 'ag-1', parentAgentId: null, kind: 'orchestrator', cwd: '/repo', branch: null, model: null, revision: 1, generation: 1 }) as never,
    node(3, { node: 'lead', n: 0, agentId: 'ag-c', parentAgentId: 'ag-1', kind: 'child', of: 'ag-1', cwd: '/repo', branch: null, model: null, revision: 1, generation: 1 }) as never,
  )
  const files = new Map<string, string>()
  let prev: string | null = null
  for (const rec of records) {
    const text = `${JSON.stringify({ ...rec, prev })}\n`
    files.set(`${LEDGER}/${String(rec.seq).padStart(6, '0')}-${rec.kind}.json`, text)
    prev = await sha256(text)
  }
  return files
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
 * checkout at /repo answers, plus the swarm's ref and its blob naming
 * another session (swarm-read.test.ts's world).
 */
function world(on: On, files: Map<string, string>): void {
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

/** session.start in the world above, as the session tier1-session: alpha is shown read-only, ag-1 and ag-c bound. */
async function started($: Engine, on: On): Promise<Map<string, string>> {
  mock.store(on, PART)
  mock.clock(on, { now: 5_000 })
  const files = await ledger()
  world(on, files)
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('session.id', async () => ({ value: 'tier1-session' }))
  on('ui.log', async () => ({ value: undefined }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
  return files
}

const parse = (r: { result?: unknown }) => JSON.parse(String(r.result)) as Record<string, unknown>
const TASKS = JSON.stringify([{ id: 'a', pass: true, evidence: 'read it', gaps: [] }])
const FIELDS = {
  verify: {},
  verdict: { verify_id: 'repair-1-abcdef0123', tasks: TASKS, combined: 'fine' },
  land: { verify_id: 'repair-1-abcdef0123' },
} as const

describe("a swarm node's verify, verdict and land", () => {
  test("are the gate's, in the record tool's result shape: a node of another session's swarm records none, naming kind, and nothing is written", async ($, on) => {
    let reached = false
    on('tool.call', { tool: 'mcp__litter__record' }, async () => {
      reached = true
      return { result: 'engine' }
    })
    const files = await started($, on)
    const before = [...files.keys()].sort()
    for (const [kind, fields] of Object.entries(FIELDS)) {
      const r = await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: `g-${kind}`, agentId: 'ag-1', kind, ...fields })
      expect(r.deny).toBeUndefined()
      expect(parse(r)).toEqual({ ok: false, field: 'kind', error: `litter: swarm alpha is another session's; this session only shows it, so it records no ${kind}` })
    }
    expect(reached).toBe(false)
    expect([...files.keys()].sort()).toEqual(before)
  })

  test("from an agent a node started, each is refused, sending it to its node", async ($, on) => {
    await started($, on)
    for (const [kind, fields] of Object.entries(FIELDS)) {
      const r = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: `c-${kind}`, agentId: 'ag-c', kind, ...fields }))
      expect(r).toEqual({ ok: false, field: 'kind', error: `litter: an agent a node started records no ${kind}; its node lead records the swarm's ${kind}s, so report to it` })
    }
  })

  test("an unbound agent's verify goes on to the run's rules; a bound node's is the gate's, whatever run it names", async ($, on) => {
    await started($, on)
    // Not the gate's: no binding, so the run's rules answer.
    const unbound = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 'u-1', agentId: 'ag-x', kind: 'verify' }))
    expect(unbound).toEqual(expect.objectContaining({ ok: false }))
    expect(String(unbound.error)).toContain("'verify' is recorded by a litter run's agents, and this agent (not started through a litter run) isn't one")
    // The gate's: the swarm's state answers first, whatever run the node names.
    const named = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 'u-2', agentId: 'ag-1', kind: 'verify', run: '20261003-other' }))
    expect(named).toEqual({ ok: false, field: 'kind', error: "litter: swarm alpha is another session's; this session only shows it, so it records no verify" })
  })
})
