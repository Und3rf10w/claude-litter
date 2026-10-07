// Tier 1: the spawn check, admission and swarm_send (WP-L), wired in the
// engine itself. A test here can't reach the mod's module memory, and only
// K's Launch or recovery puts a live swarm there, so these pin what holds
// with nothing live: mcp__litter__swarm_send answered by the mod with its
// reply as JSON in `result`, swarm.bind's refusal through the record tool,
// and every other loop's turn.step, session.send and agent.spawn passing to
// the engine as they came. A node's refusals (its turn.step stream and
// result, a send's `{ isDelivered: false }`, a spawn's `{ deny }` and the
// rewrite) are tier 2 (tests/unit/admit.spec.ts, spawn.spec.ts).
//
// One world puts a live swarm there through recovery (WP-AJ): a swarm this
// session owns, taken back whole at session.start from its ledger, its
// ownership ref and the $.store mirror, with a node the agent list shows
// `waiting`, so it's parked at a full cap. The parked cases in detail are
// tier 2 (tests/unit/admit.spec.ts). The same world shows a node's step going
// on with the model and effort set for it (WP-DI), and a message from the
// browser via a busy lead as a row in its conversation (2.1.293's
// mock.session); their cases in detail are tune.spec.ts and messages.spec.ts.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { SwarmBrowserView } from '../types/index'

const SPAWN = {
  tool_use_id: 'tu-admit',
  prompt: 'do it',
  description: 'test spawn',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'test-model',
  background: false,
  fork: false,
} as const

const parse = (r: { result?: unknown }) => JSON.parse(String(r.result)) as Record<string, unknown>

const LAUNCH = '20261003-120000'
const OID = 'a'.repeat(40)
const REF = 'refs/litter-swarm/alpha'
const LITTER = '/repo/.claude/litter'
const LEDGER = `${LITTER}/swarms/alpha/launches/${LAUNCH}/ledger`
/** Two read-only nodes, so no write scope applies: the lead may run one fixer, and the swarm two agents at once. */
const SPEC = {
  name: 'alpha',
  goal: 'Tidy the docs.',
  nodes: [
    { id: 'lead', kind: 'orchestrator', worktree: 'none', tools: { deny: ['Edit', 'Write', 'NotebookEdit'] }, spawns: { fixer: 1 } },
    { id: 'fixer', kind: 'worker', worktree: 'none', tools: { deny: ['Edit', 'Write', 'NotebookEdit'] } },
  ],
  limits: { maxAgentsAtOnce: 2 },
}
const TYPES = { lead: 'litter:sw-alpha-lead', fixer: 'litter:sw-alpha-fixer' }
const DIRS = { lead: { dir: '/repo', branch: null, created: false }, fixer: { dir: '/repo', branch: null, created: false } }
const ROOTS = { litterDir: LITTER, litterCopies: [LITTER], ruleDirs: [] }
/**
 * The ownership ref's blob, naming this session (tier1-session). Its host and pid are what this process reads
 * for itself here (neither uname nor sh answers), so recovery's retake writes the same blob, at the same oid.
 */
const BLOB = JSON.stringify({ swarm: 'alpha', launch: LAUNCH, session: 'tier1-session', generation: 1, host: 'unknown', pid: '', acquiredAt: 1 })

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/**
 * The launch ledger: swarm.start, with the spec's hash as launch.ts's specHash takes it, then lead #1's and
 * fixer #1's swarm.node, chained as ledgercore.ts writes them.
 */
async function ownedLedger(): Promise<Map<string, string>> {
  const run = `swarm:alpha/${LAUNCH}`
  const unchecked = (node: string) => `${node}: commit unchecked; push unchecked; rewrite history unchecked; worktree commands unchecked; files anywhere`
  const node = (body: Record<string, unknown>) => ({ kind: 'swarm.node', body: { cwd: '/repo', branch: null, model: null, revision: 1, generation: 1, ...body } })
  const records = [
    {
      kind: 'swarm.start',
      body: {
        swarm: 'alpha',
        launch: LAUNCH,
        revision: 1,
        specHash: await sha256(JSON.stringify(SPEC)),
        nonce: 'b'.repeat(32),
        types: TYPES,
        nodes: DIRS,
        authority: { lead: unchecked('lead'), fixer: unchecked('fixer') },
        tips: {},
        owner: { ref: REF, oid: OID, generation: 1 },
        sessionCwd: '/repo',
        worktreeRoot: '/repo/.claude/worktrees',
        commonDir: '/repo/.git',
        roots: ROOTS,
      },
    },
    node({ node: 'lead', n: 1, agentId: 'ag-1', parentAgentId: null, kind: 'orchestrator' }),
    node({ node: 'fixer', n: 1, agentId: 'ag-f1', parentAgentId: 'ag-1', kind: 'worker' }),
  ]
  const files = new Map<string, string>()
  let prev: string | null = null
  for (const [i, r] of records.entries()) {
    const seq = i + 1
    const text = `${JSON.stringify({ v: 1, seq, kind: r.kind, run, at: seq, by: { source: 'mod' }, prev, body: r.body })}\n`
    files.set(`${LEDGER}/${String(seq).padStart(6, '0')}-${r.kind}.json`, text)
    prev = await sha256(text)
  }
  return files
}

/** This session's mirror of the swarm in $.store (state.ts's part): the spec recovery checks against specHash. */
const PART = {
  [`litter.swarm.state.${LITTER}.alpha`]: {
    v: 1,
    swarm: {
      name: 'alpha',
      launch: LAUNCH,
      revision: 1,
      spec: SPEC,
      nonce: 'b'.repeat(32),
      types: TYPES,
      typesReady: true,
      dirs: DIRS,
      sessionCwd: '/repo',
      worktreeRoot: '/repo/.claude/worktrees',
      commonDir: '/repo/.git',
      roots: ROOTS,
      tips: {},
      owner: { ref: REF, oid: OID, generation: 1, session: 'tier1-session' },
      state: 'live',
      readOnly: false,
      lost: false,
      flags: { isolationLost: false },
      startedAt: 1,
    },
    bindings: [],
    admission: [
      { agentId: 'ag-1', status: 'running', scope: null, swarm: 'alpha', node: 'lead', parent: null, kind: 'orchestrator' },
      // The fixer's turn.complete came before the reload: settling, so the list's `waiting` is a park, not a foreground child.
      { agentId: 'ag-f1', status: 'settling', scope: null, swarm: 'alpha', node: 'fixer', parent: 'ag-1', kind: 'worker' },
    ],
    stopped: [],
    instances: { lead: 1, fixer: 1 },
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
 * session.start's litter directory at /repo/.claude/litter: a plain checkout, files in memory (as wiring.test.ts's world).
 * `sid` is read at each session.id; `register` runs before each agent.register answers. `files` starts the
 * map; with `owner`, git answers swarm alpha's ownership ref at OID with that blob, and hashes it to OID again.
 */
function world(on: On, opts: { sid?: { value: string }; register?: () => Promise<void>; files?: Map<string, string>; owner?: string } = {}): void {
  const files = opts.files ?? new Map<string, string>()
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
    if (argv[0] === 'git' && opts.owner !== undefined) {
      // owner.ts's readOwnerRef, then retakeOwnership's writeBlob: the same blob hashes to the same oid, so no swap.
      if (argv.includes('rev-parse') && argv.includes(REF)) return run(0, `${OID}\n`)
      if (argv.includes('cat-file') && argv.includes(OID)) return run(0, opts.owner)
      if (argv.includes('hash-object') && e.init?.stdin === opts.owner) return run(0, `${OID}\n`)
    }
    if (argv[0] === 'git' && argv.includes('rev-parse')) {
      if (argv.includes('--show-toplevel') && !argv.includes('--git-dir')) return run(0, '/repo\n')
      if (argv.includes('--git-dir') && argv.includes('--git-common-dir')) return run(0, '/repo/.git\n/repo/.git\n')
    }
    return run(1)
  })
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => {
    await opts.register?.()
    return { value: { agent: `litter:${e.name}` } }
  })
  on('session.id', async () => ({ value: opts.sid?.value ?? 'tier1-session' }))
  on('ui.log', async () => ({ value: undefined }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
}

describe('mcp__litter__swarm_send', () => {
  test("it's answered by the mod, its reply JSON in result, and never passed on", async ($, on) => {
    mock.store(on)
    let reached = 0
    on('tool.call', { tool: 'mcp__litter__swarm_send' }, async () => {
      reached++
      return { result: 'engine' }
    })
    const lead = await $.tool.call({ tool: 'mcp__litter__swarm_send', tool_use_id: 's1', node: 'fixer', text: 'hi' })
    expect(parse(lead)).toEqual({ ok: false, error: 'litter: this session has no litter directory, so no swarm is live in it' })
    const node = await $.tool.call({ tool: 'mcp__litter__swarm_send', tool_use_id: 's2', agentId: 'agent-7', node: 'fixer', text: 'hi' })
    expect(parse(node)).toEqual({ ok: false, error: "litter: mcp__litter__swarm_send is the lead's alone; a node sends with SendMessage" })
    expect(reached).toBe(0)
  })

  test('with a litter directory and nothing live, it names what is missing', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 5_000 })
    world(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const r = await $.tool.call({ tool: 'mcp__litter__swarm_send', tool_use_id: 's3', node: 'fixer', text: 'hi' })
    expect(parse(r)).toEqual({ ok: false, error: "litter: no live swarm has a node 'fixer'" })
    // An older litter's request for a held message: it holds none now.
    const q = await $.tool.call({ tool: 'mcp__litter__swarm_send', tool_use_id: 's4', queued: 'q1234abcd' })
    expect(parse(q)).toEqual({
      ok: false,
      error: "litter: litter no longer holds messages to send later, so there's nothing queued to deliver; send the text with 'node' and it goes now",
    })
  })
})

describe('swarm.bind through the record tool', () => {
  test('an agent the engine lists as no swarm node is refused, naming kind', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 5_000 })
    world(on)
    on('agent.list', async () => ({ value: [{ id: 'agent-9', description: 'a helper', type: 'general-purpose', status: 'running' }] }))
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const r = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 'b1', agentId: 'agent-9', kind: 'swarm.bind', token: '1'.repeat(32) }))
    expect(r).toEqual({
      ok: false,
      field: 'kind',
      error: "litter: 'swarm.bind' is for a swarm node with no binding, and this agent (general-purpose) isn't one",
    })
  })

  test("when the agent list can't be read, the record tool's catch refuses, naming the hook", async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 5_000 })
    world(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const r = await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 'b2', agentId: 'agent-9', kind: 'swarm.bind', token: '1'.repeat(32) })
    expect(r.deny).toContain('litter guard failed: mcp__litter__record')
  })
})

describe('with nothing live, every other loop passes to the engine as it came', () => {
  test("a subagent's and the lead's turn.step pass through, every index, chunks and result", async ($, on) => {
    on('turn.step', async function* (_$, e) {
      yield { kind: 'text', index: 0, text: `engine ${e.agentId ?? 'main'} ${e.index}` }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: `engine ${e.agentId ?? 'main'} ${e.index}`, toolUses: [], stopReason: 'end_turn', usage: null }
    })
    for (const agentId of [undefined, 'agent-7']) {
      for (const index of [0, 1]) {
        const s = $.turn.step({ turnId: 'turn-1', index, model: 'test-model', messageCount: 1, ...(agentId ? { agentId } : {}) })
        const chunks: unknown[] = []
        let result: unknown
        for (;;) {
          const r = await s.next()
          if (r.done) {
            result = r.value
            break
          }
          chunks.push(r.value)
        }
        const text = `engine ${agentId ?? 'main'} ${index}`
        expect(chunks).toEqual([
          { kind: 'text', index: 0, text },
          { kind: 'stop', stopReason: 'end_turn', usage: null },
        ])
        expect(result).toEqual({ turnId: 'turn-1', index, answer: text, toolUses: [], stopReason: 'end_turn', usage: null })
      }
    }
  })

  test('a SendMessage from a subagent to main, and to another agent, reaches the engine unchanged', async ($, on) => {
    const seen: { to: string; text: string; agentId?: string }[] = []
    on('session.send', async (_$, e) => {
      seen.push({ to: e.to, text: e.text, ...(e.agentId ? { agentId: e.agentId } : {}) })
      return { isDelivered: true }
    })
    expect(await $.session.send({ to: 'main', text: 'report', origin: { kind: 'model' }, agentId: 'agent-7' })).toEqual({ isDelivered: true })
    expect(await $.session.send({ to: 'agent-8', text: 'hello', origin: { kind: 'model' }, agentId: 'agent-7' })).toEqual({ isDelivered: true })
    expect(seen).toEqual([
      { to: 'main', text: 'report', agentId: 'agent-7' },
      { to: 'agent-8', text: 'hello', agentId: 'agent-7' },
    ])
  })

  test("a spawn no swarm governs reaches the engine with the caller's parameters", async ($, on) => {
    mock.store(on)
    let seen: { cwd?: string; background?: boolean; prompt?: string; model?: string } | null = null
    on('agent.spawn', async (_$, e) => {
      seen = { cwd: e.cwd, background: e.background, prompt: e.prompt, model: e.model }
      return { model: 'test-model', agentId: 'agent-new' }
    })
    const r = await $.agent.spawn({ ...SPAWN, subagentType: 'general-purpose', parentAgentId: 'agent-7', cwd: '/repo/sub' })
    expect(r).toEqual({ model: 'test-model', agentId: 'agent-new' })
    expect(seen).toEqual({ cwd: '/repo/sub', background: false, prompt: 'do it', model: undefined })
  })

  // 2.1.289 runs agent.spawn for teammates: one litter has no stake in waits on no rebind (spawn.ts, outsideTeammate).
  test("an outside teammate's spawn reaches the engine at once while a /clear's rebind holds the gate closed", async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on, { now: 5_000 })
    const sid = { value: 'tier1-a' }
    let hold = false
    let held = 0
    world(on, {
      sid,
      register: async () => {
        if (!hold) return
        held++
        await clock.sleep(1_000)
      },
    })
    on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
    const spawned: string[] = []
    on('agent.spawn', async (_$, e) => {
      spawned.push(e.tool_use_id)
      return { model: 'test-model', agentId: `agent-${e.tool_use_id}` }
    })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })

    // The engine's clear, then the new id: the next hook starts the rebind, which closes the gate and is held here
    // at its roles' registration.
    await $.session.end({ reason: 'clear', sessionId: 'tier1-a', resume: { id: 'tier1-a' } })
    sid.value = 'tier1-b'
    hold = true
    const first = $.agent.spawn({ ...SPAWN, tool_use_id: 'tu-first', subagentType: 'general-purpose' })
    await clock.settle()
    expect(held).toBeGreaterThan(0)
    hold = false

    let mate: unknown = null
    void $.agent.spawn({ ...SPAWN, tool_use_id: 'tu-mate', subagentType: 'general-purpose', name: 'scout', isTeammate: true, background: true }).then(r => {
      mate = r
    })
    await clock.settle()
    expect(mate).toEqual({ model: 'test-model', agentId: 'agent-tu-mate' })
    expect(spawned).toEqual(['tu-mate'])

    // The rebind goes on, and the spawn that started it reaches the engine after it.
    await clock.advance(1_000)
    expect(await first).toEqual({ model: 'test-model', agentId: 'agent-tu-first' })
    expect(spawned).toEqual(['tu-mate', 'tu-first'])
  })

  test("the lead's turn.start and turn.complete pass on", async ($, on) => {
    mock.store(on)
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
    on('turn.complete', async (_$, e) => ({ text: e.answer }))
    expect(await $.turn.start({ text: 'hi', turnId: 'turn-3' })).toEqual({ turnId: 'turn-3' })
    expect(await $.turn.complete({ turnId: 'turn-3', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })).toEqual(
      expect.objectContaining({ text: 'done' }),
    )
  })
})

describe('a parked node keeps its place (WP-AJ)', () => {
  // session.start recovers a swarm a crash left: a recovery under load takes longer than the default 5 s.
  test("recovered `waiting` at a full cap: a spawn under it is denied naming it, and its wake reaches the engine's step", { timeoutMs: 20_000 }, async ($, on) => {
    mock.store(on, PART)
    mock.clock(on, { now: 5_000 })
    const files = await ownedLedger()
    world(on, { files, owner: BLOB })
    // The lead runs; its fixer ended its turn and waits on its own work: 2 of the cap's 2 places.
    on('agent.list', async () => ({
      value: [
        { id: 'ag-1', description: 'the lead node', type: TYPES.lead, status: 'running' as const },
        { id: 'ag-f1', description: 'a fixer', type: TYPES.fixer, parentId: 'ag-1', status: 'waiting' as const },
      ],
    }))
    const spawned: string[] = []
    on('agent.spawn', async (_$, e) => {
      spawned.push(e.tool_use_id)
      return { model: 'test-model', agentId: 'agent-new' }
    })
    on('turn.step', async function* (_$, e) {
      yield { kind: 'text', index: 0, text: `engine ${e.agentId ?? 'main'} ${e.index}` }
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: `engine ${e.agentId ?? 'main'} ${e.index}`, toolUses: [], stopReason: 'end_turn', usage: null }
    })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const admitted = (agentId: string) =>
      (JSON.parse(files.get(`${LITTER}/hooks/agents/${agentId}.json`) ?? '{}') as { node?: { admitted?: boolean } }).node?.admitted
    // Recovery took the swarm back as this session's: the lead admitted, the parked fixer not until its next step.
    expect(admitted('ag-1')).toBe(true)
    expect(admitted('ag-f1')).toBe(false)

    // A child of the lead's would be a third agent: the cap refuses it, naming the parked one.
    const denied = await $.agent.spawn({ ...SPAWN, tool_use_id: 'tu-parked', subagentType: 'Explore', parentAgentId: 'ag-1' })
    expect(denied).toEqual({
      deny:
        'litter: swarm alpha is at its limit of 2 agents at once (limits.maxAgentsAtOnce), and 1 of them is parked: fixer #1 (ag-f1), ' +
        'which ended its turn with its own agents or background work still running, and keeps its place until it ends; wait for one to finish, or go on without this agent',
    })

    // Its wake at the full cap: counted already, so no count or cap refuses it; the step reaches the engine as it came.
    const s = $.turn.step({ turnId: 'turn-wake', index: 0, model: 'test-model', messageCount: 1, agentId: 'ag-f1' })
    const chunks: unknown[] = []
    let result: unknown
    for (;;) {
      const r = await s.next()
      if (r.done) {
        result = r.value
        break
      }
      chunks.push(r.value)
    }
    expect(chunks).toEqual([
      { kind: 'text', index: 0, text: 'engine ag-f1 0' },
      { kind: 'stop', stopReason: 'end_turn', usage: null },
    ])
    expect(result).toEqual({ turnId: 'turn-wake', index: 0, answer: 'engine ag-f1 0', toolUses: [], stopReason: 'end_turn', usage: null })
    expect(admitted('ag-f1')).toBe(true)

    // Running now, it holds the same place: the cap still refuses, and names no one parked.
    const again = await $.agent.spawn({ ...SPAWN, tool_use_id: 'tu-running', subagentType: 'Explore', parentAgentId: 'ag-1' })
    expect(again).toEqual({ deny: 'litter: swarm alpha is at its limit of 2 agents at once (limits.maxAgentsAtOnce); wait for one to finish' })
    expect(spawned).toEqual([])
  })
})

/** Drains a step's stream; answers its result. */
async function drain(s: AsyncGenerator<unknown, unknown>): Promise<unknown> {
  for (;;) {
    const r = await s.next()
    if (r.done) return r.value
  }
}

/** The recovered swarm's lead node running, the fixer done: what the agent list says in the tests below. */
const LISTED = {
  value: [
    { id: 'ag-1', description: 'the lead node', type: TYPES.lead, status: 'running' as const },
    { id: 'ag-f1', description: 'a fixer', type: TYPES.fixer, parentId: 'ag-1', status: 'completed' as const },
  ],
}

/** The browser as the pane draws it, enough for [Send] to lead #1: the real view is tier 2's; the press reaches the real send. */
const BROWSER: SwarmBrowserView = {
  view: 'browser',
  v: 1,
  title: [{ text: 'alpha' }],
  notice: null,
  swarm: 'alpha',
  launch: LAUNCH,
  state: 'live',
  readOnly: false,
  lost: false,
  owner: null,
  budget: null,
  summary: null,
  rows: [],
  flags: [],
  events: [],
  composer: { to: 'ag-1', address: 'lead#1', targets: [{ value: 'ag-1', label: 'lead' }], text: 'split the PR', route: 'lead', routes: [{ value: 'lead', label: 'Via lead' }] },
  transcript: null,
  tune: null,
  selected: 'ag-1',
  proposals: [],
  confirmEnd: false,
}

describe("a node's model and effort, and a message through the lead (WP-DI, 2.1.293)", () => {
  // The user's live look (2026-10-07): "right click here and see the model and effort level ... bonus points for adjustment".
  test("a node's request goes on with the model and effort set for it, as the engine's step sees them", { timeoutMs: 20_000 }, async ($, on) => {
    const part = PART[`litter.swarm.state.${LITTER}.alpha`]
    mock.store(on, { [`litter.swarm.state.${LITTER}.alpha`]: { ...part, tuned: { 'ag-1': { model: 'claude-sonnet-5-5', effort: 'low' } } } })
    mock.clock(on, { now: 5_000 })
    world(on, { files: await ownedLedger(), owner: BLOB })
    on('agent.list', async () => LISTED)
    const seen: { model: string; effort?: unknown }[] = []
    on('turn.step', async function* (_$, e) {
      seen.push({ model: e.model, effort: e.effort })
      yield { kind: 'stop', stopReason: 'end_turn', usage: null }
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
    })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    await drain($.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-opus-5-5[1m]', effort: 'xhigh', messageCount: 3, agentId: 'ag-1' }))
    // The lead's own step is the session's, untouched.
    await drain($.turn.step({ turnId: 'turn-main', index: 0, model: 'claude-opus-5-5[1m]', effort: 'xhigh', messageCount: 3 }))
    expect(seen).toEqual([
      { model: 'claude-sonnet-5-5', effort: 'low' },
      { model: 'claude-opus-5-5[1m]', effort: 'xhigh' },
    ])
  })

  // The user, 2026-10-07: "get rid of the ability to queue messages and interject only". A busy lead reads it now.
  test("the browser's message via a busy lead is a user row in the lead's conversation (mock.session)", { timeoutMs: 20_000 }, async ($, on) => {
    mock.store(on, {
      ...PART,
      [`litter.swarm.composer.${LITTER}.alpha`]: { route: 'lead' },
      'litter.hub': { v: 1, session: 'tier1-session', section: 'swarms' },
      'litter.swarm.pane': {
        v: 1,
        session: 'tier1-session',
        swarm: { view: 'browser', swarm: 'alpha', selected: 'ag-1', inputs: { 'swarm:browser:text:alpha': 'split the PR' } },
        doctor: null,
      },
    })
    const session = mock.session(on)
    mock.clock(on, { now: 5_000 })
    world(on, { files: await ownedLedger(), owner: BLOB })
    on('agent.list', async () => LISTED)
    on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
    on('state.get', async (_$, e, next) => {
      if (e.key === 'hub') return { value: { value: { view: 'hub', v: 1, section: 'swarms', live: [], tabs: [] }, version: 0 } }
      if (e.key === 'swarmPane') return { value: { value: BROWSER, version: 0 } }
      return next(e)
    })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    // The lead's turn under way: it reads the row in this turn.
    await $.turn.start({ text: 'carry on', turnId: 'turn-lead' })
    const ui = await $.ui.mount({
      plugin: 'litter',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'litter',
      props: { title: 'litter', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
    })
    await ui.press({ key: 'swarm:browser:send:alpha/lead#1' })
    const rows = session.appended()
    expect(rows.length).toBe(1)
    const content = (rows[0]!.message as { type: string; content: { type: string; text: string }[] })
    expect(content.type).toBe('user')
    expect(content.content).toEqual([{ type: 'text', text: expect.stringContaining('for lead in swarm alpha, through you, to deliver now') }])
    expect(content.content[0]!.text).toEndWith('<message>\nsplit the PR\n</message>')
  })
})
