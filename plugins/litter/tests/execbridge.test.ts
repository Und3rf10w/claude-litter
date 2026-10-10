// Tier 1: an execute run's bridge to a plan-template swarm (phase 3, WP-AC;
// plan 12:1554-1559), as the engine runs it. An execute run halted at G2 with
// G1 landed: its notification settles on prompt.submit, and the bridge
// declines under `repair: off` (the summary offers the routes, nothing
// starts) or, under `auto`, launches the swarm for the gates with no land.
// That swarm is then this session's own and live, so the lead spawns its
// runner through agent.spawn, and the runner's land goes through the record
// tool: refused without an approving verdict citing the verify, from a type
// without verdicts: true or from the executor, past maxAttempts rejections,
// and past the budget, where a spawn is refused too. The world is in memory:
// $.fs from a map of files, and $.process.run answering git for a checkout at
// /repo on the run's branch, with refs and blobs kept as git would. No verify
// runs here: the generation's verifies and verdicts are written into the
// run's ledger as the gate would record them (the gate's own verify and
// verdict are tier 2, tests/unit/execgate.spec.ts).

import type { On } from 'claude-code'
import type { Engine, MockClock } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const SESSION = 'tier1-session'
const LITTER = '/repo/.claude/litter'
const RUN = '20261003-exec'
const RUN_DIR = `${LITTER}/${RUN}`
const REF = `refs/heads/litter/${RUN}`
const TASK = 'task-1'
const BASE = 'b'.repeat(40)
/** G1's land commit, the branch's tip, and its tree (G1's green verify saw it). */
const TIP = 'c'.repeat(40)
const TIP_TREE = 'd'.repeat(40)
/** G2's halted attempt, in the tree uncommitted. */
const ATTEMPT_TREE = 'e'.repeat(40)
const VERIFY = ['sh', '-c', 'test ! -e .claude/red']
const GAP = 'the plan names no config file for the parser to read, and G2 needs one'
const HALT = `G2: the critic names a plan gap: ${GAP}`
const PLAN = [
  '# Config plan',
  '',
  '## G1: Parse the config file',
  'Files: g1.txt',
  'Read the settings with the strict parser.',
  '',
  '## G2: Load the defaults',
  'Files: g2.txt',
  'Merge the shipped defaults under the settings.',
  '',
  '## G3: Document the options',
  'Files: g3.txt',
  'List every option in the README.',
  '',
].join('\n')
const ASK = "report blocked to your parent, saying what more you need and for what; the lead can ask the user for it with repair.budget"

const SPAWN = {
  prompt: 'do it',
  description: 'test spawn',
  provider: { plugin: 'engine', tier: 'core' },
  parentModel: 'test-model',
  background: false,
  fork: false,
} as const

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const digest = async (algo: string, text: string) => hex(await crypto.subtle.digest(algo, new TextEncoder().encode(text)))
const sha256 = (text: string) => digest('SHA-256', text)

type Author = { source: 'mod' } | { source: 'agent'; agentId: string; agentType: string }
const MOD: Author = { source: 'mod' }
const agent = (agentId: string, agentType: string): Author => ({ source: 'agent', agentId, agentType })

/**
 * Appends a record to a ledger in the map, chained to the last one as
 * ledgercore.ts writes them, and with `store` moves the ledger's head there
 * as appendRecord does: past a head the mod stored, a record it doesn't name
 * is tampered.
 */
async function append(files: Map<string, string>, dir: string, run: string, kind: string, by: Author, body: Record<string, unknown>, store?: Map<string, unknown>): Promise<number> {
  const ledger = `${dir}/ledger/`
  const names = [...files.keys()].filter(k => k.startsWith(ledger) && /^\d{6}-/.test(k.slice(ledger.length))).sort()
  const seq = names.length + 1
  const prev = names.length > 0 ? await sha256(files.get(names.at(-1)!)!) : null
  const text = `${JSON.stringify({ v: 1, seq, kind, run, at: 1_791_028_800_000 + seq, by, prev, body })}\n`
  files.set(`${ledger}${String(seq).padStart(6, '0')}-${kind}.json`, text)
  store?.set(`litter.head.${dir}`, { v: 2, seq, sha: await sha256(text) })
  return seq
}

/** `$.store` from a map in memory, as mock.store keeps it, so the test can move a ledger's head as the mod would. */
function memoryStore(on: On, entries: Record<string, unknown>): Map<string, unknown> {
  const store = new Map<string, unknown>(Object.entries(entries))
  on('store.get', async (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', async (_$, e) => {
    store.set(e.key, e.value === undefined ? undefined : JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', async (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', async () => ({ value: [...store.keys()] }))
  return store
}

const verifyBody = (verifyId: string, gate: string, attempt: number, tree: string) => ({
  verify_id: verifyId,
  gate,
  attempt,
  argv: VERIFY,
  tree_before: tree,
  tree_after: tree,
  dirty_submodules: [],
  exit_code: 0,
  signal: null,
  timed_out: false,
  spawn_error: null,
  green: true,
  log_parts: 0,
  log_bytes: 0,
  output_tail: '',
})
const pass = (evidence: string) => ({ pass: true, evidence, gaps: [] })
const failed = (gap: string) => ({ pass: false, evidence: 'read the diff against the plan lines', gaps: [gap] })

/**
 * `executorGap`: G2 halted on its executor's plan-gap stop (WP-AH), before
 * any verdict on G2: no G2 verify or verdict is seeded, and the executor's
 * StructuredOutput waits in the session's spool, as output.sh leaves it.
 */
type Opts = { mode: 'auto' | 'off'; rounds?: number; agents?: number; executorGap?: boolean }

/** G2's executor, in the agent map as its SubagentStart left it. */
const EXECUTOR = { agentId: 'ex-G2', agentType: 'litter:executor', role: 'executor', run: RUN, cwd: '/repo', started: 1, stopped: null, sessionId: SESSION, transcriptPath: '/t' }
/** Its StructuredOutput: blocked, the gap in plan_gap (execute.js's WRITTEN). */
const STOP = { status: 'blocked', plan_lines: ['plan.md:7-9'], files: [], checks: [], notes: 'stopped before changing anything', plan_gap: GAP }
const EXECUTOR_HALT = `G2 plan gap: ${GAP}`
/** The line output.sh appends to the session's spool for that StructuredOutput. */
const STOP_LINE = { v: 1, ev: 'output', ts: 2, session_id: SESSION, agent_id: EXECUTOR.agentId, agent_type: EXECUTOR.agentType, tool_use_id: 'toolu_w2', input: STOP }

/**
 * The execute run as generation 1 leaves it, still open: plan.md, run.json
 * with its repair setting, and the ledger (run.start, run.launch, G1 verified,
 * approved and landed, G2's attempt 1 with a verdict naming a plan gap). The
 * notification ends it. Its head is in `store`, as this session's appends left
 * it: a ledger with no head here is another store's, and the mod leaves it alone.
 */
async function seedRun(files: Map<string, string>, o: Opts, store: Map<string, unknown>): Promise<void> {
  files.set(`${RUN_DIR}/plan.md`, PLAN)
  files.set(`${LITTER}/hooks/mode`, 'default\n')
  const gates = ['G1', 'G2', 'G3'].map((id, i) => ({
    id,
    title: ['Parse the config file', 'Load the defaults', 'Document the options'][i],
    lines: { start: 3 + i * 4, end: 5 + i * 4 },
    files: [`g${i + 1}.txt`],
    adversary: false,
    rules: [],
  }))
  const repair = { mode: o.mode, rounds: o.rounds ?? 3, agents: o.agents ?? 6 }
  const json = {
    v: 1,
    run: RUN,
    workflow: 'execute',
    args: { verifyCommand: "sh -c 'test ! -e .claude/red'", rules: [], planPath: `${RUN_DIR}/plan.md`, gates, maxAttempts: 3, adversary: false, adversaryClamp: [] },
    authorized: ['commit on litter branches'],
    mode: 'default',
    verify: VERIFY,
    goalCheck: null,
    setup: null,
    linkDirs: [],
    base: BASE,
    ref: REF,
    checkout: '/repo',
    isolate: false,
    previousBranch: 'main',
    continueOf: null,
    amendOf: null,
    rules: [],
    planPath: 'plan.md',
    planSha256: await sha256(PLAN),
    session: SESSION,
    created: 1,
    repair,
  }
  const text = `${JSON.stringify(json, null, 2)}\n`
  files.set(`${RUN_DIR}/run.json`, text)
  const add = (kind: string, body: Record<string, unknown>, by: Author = MOD) => append(files, RUN_DIR, RUN, kind, by, body, store)
  await add('run.start', {
    workflow: 'execute',
    base: BASE,
    ref: REF,
    checkout: '/repo',
    isolate: false,
    previousBranch: 'main',
    verify: VERIFY,
    goalCheck: null,
    setup: null,
    authorized: json.authorized,
    mode: 'default',
    continueOf: null,
    amendOf: null,
    planSha256: json.planSha256,
    argsSha256: 'a'.repeat(64),
    runJsonSha256: await sha256(text),
    oid: '1'.repeat(40),
    session: SESSION,
    repair,
  })
  await add('run.launch', { taskId: TASK, runId: 'wf_exec1', scriptPath: null, generation: 1, session: SESSION, oid: '1'.repeat(40) })
  const g1 = agent('critic-G1', 'litter:gate-critic')
  const dims = { plan_adherence: pass('plan.md:3-5 against the diff'), tests_green: pass('exit 0'), no_regressions: pass('searched the callers'), rules: pass('none apply') }
  await add('verify', verifyBody('G1-1-a1b2c3d4e5', 'G1', 1, TIP_TREE), g1)
  await add('verdict', { verify_id: 'G1-1-a1b2c3d4e5', ...dims, plan_gap: '', proposed_rules: [], tool_use_id: 'tu-g1' }, g1)
  await add('land.intent', { gate: 'G1', verify_id: 'G1-1-a1b2c3d4e5', tree: TIP_TREE, old: BASE, ref: REF, mode: 'index' })
  await add('land', { gate: 'G1', verify_id: 'G1-1-a1b2c3d4e5', commit: TIP, tree: TIP_TREE, old: BASE, ref: REF })
  // The executor's spool line is the test's to write, after session.start, so prompt.submit's drain records it.
  if (o.executorGap) return
  const g2 = agent('critic-G2', 'litter:gate-critic')
  await add('verify', verifyBody('G2-1-f6a7b8c9d0', 'G2', 1, ATTEMPT_TREE), g2)
  await add('verdict', { verify_id: 'G2-1-f6a7b8c9d0', ...dims, plan_gap: GAP, proposed_rules: [], tool_use_id: 'tu-g2' }, g2)
}

type Git = { refs: Map<string, string>; unknown: string[] }

/**
 * $.fs from the map, and $.process.run: git for a checkout at /repo on the
 * run's branch at TIP, with its refs and blobs kept (update-ref compares and
 * swaps; hash-object names a blob by its text), the tools the health check
 * looks for, and mv, rm and mkdir as fsx.ts runs them. Any other command
 * fails, and is kept in `unknown`.
 */
function world(on: On, files: Map<string, string>): Git {
  const refs = new Map<string, string>([
    [REF, TIP],
    ['refs/heads/main', BASE],
  ])
  const blobs = new Map<string, string>()
  const unknown: string[] = []
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
    const argv = [...e.argv]
    const line = argv.join(' ')
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
    if (argv[0] === 'mkdir') return run(0)
    if (line === 'jq --version') return run(0, 'jq-1.7.1\n')
    if (line === 'sh -c command -v jq') return run(0, '/usr/bin/jq\n')
    if (line === 'uname -n') return run(0, 'tier1-host\n')
    if (line === 'sh -c echo $PPID') return run(0, '4242\n')
    if (argv[0] !== 'git') {
      unknown.push(line)
      return run(1)
    }
    const g = argv[1] === '-C' ? argv.slice(3) : argv.slice(1)
    const has = (...xs: string[]) => xs.every(x => g.includes(x))
    if (g[0] === '--version') return run(0, 'git version 2.50.1\n')
    if (g[0] === 'rev-parse') {
      if (has('--git-dir', '--git-common-dir')) return run(0, '/repo/.git\n/repo/.git\n')
      if (has('--git-common-dir')) return run(0, '/repo/.git\n')
      if (has('--show-toplevel')) return run(0, '/repo\n')
      const what = g.at(-1)!
      if (what === `${REF}^{commit}` || what === `${TIP}^{commit}` || what === 'HEAD') return run(0, `${TIP}\n`)
      if (what === `${TIP}^{tree}`) return run(0, `${TIP_TREE}\n`)
      const oid = refs.get(what)
      return oid ? run(0, `${oid}\n`) : run(1)
    }
    if (g[0] === 'symbolic-ref' && has('HEAD')) return run(0, `${REF}\n`)
    if (g[0] === 'worktree' && has('list', '--porcelain', '-z')) return run(0, `worktree /repo\0HEAD ${TIP}\0branch ${REF}\0\0`)
    if (g[0] === 'hash-object' && has('-w', '--stdin')) {
      const text = e.init?.stdin ?? ''
      const oid = await digest('SHA-1', `blob ${new TextEncoder().encode(text).length}\0${text}`)
      blobs.set(oid, text)
      return run(0, `${oid}\n`)
    }
    if (g[0] === 'cat-file' && g[1] === 'blob') {
      const text = blobs.get(g[2]!)
      return text === undefined ? run(128) : run(0, text)
    }
    if (g[0] === 'update-ref') {
      const rest = g.slice(1)
      if (rest[0] === '-m') rest.splice(0, 2)
      if (rest[0] === '-d') {
        const [, ref, old] = rest as [string, string, string | undefined]
        if (old !== undefined && refs.get(ref) !== old) return run(1)
        refs.delete(ref)
        return run(0)
      }
      const [ref, next, old] = rest as [string, string, string | undefined]
      if (old !== undefined && (refs.get(ref) ?? '') !== old) return run(1)
      refs.set(ref, next)
      return run(0)
    }
    // The commits on the run's branch past its base (land.ts's reconcile): G1's land, with its trailer.
    if (g[0] === 'log' && has('-z', `${BASE}..${REF}`)) return run(0, `${TIP}\x1f${BASE}\x1f${TIP_TREE}\x1f${RUN} G1 G1-1-a1b2c3d4e5\0`)
    if (g[0] === 'for-each-ref' && g.at(-1) === 'refs/heads') {
      return run(0, [...refs].filter(([r]) => r.startsWith('refs/heads/')).map(([r, o]) => `${r}\0${o}\n`).join(''))
    }
    unknown.push(line)
    return run(1)
  })
  return { refs, unknown }
}

type Seen = { text: string; context: readonly string[] }
type World = {
  files: Map<string, string>
  /** The plugin's `$.store`. */
  store: Map<string, unknown>
  git: Git
  clock: MockClock
  seen: Seen[]
  logs: string[]
  /** Each type the mod registered, by name: its prompt. */
  types: Map<string, string>
  /** Each spawn that reached the engine. */
  spawned: { subagentType: string; cwd?: string; prompt: string }[]
}

/** session.start in the world above, interactive, as tier1-session: the run is open, its task generation 1's. */
async function started($: Engine, on: On, o: Opts): Promise<World> {
  const store = memoryStore(on, {
    [`litter.task.${TASK}`]: { run: RUN, runDir: RUN_DIR, litterDir: LITTER },
    ...(o.executorGap ? { [`litter.agent.${EXECUTOR.agentId}`]: EXECUTOR } : {}),
  })
  const clock = mock.clock(on, { now: 1_791_028_800_000 })
  // Every variable unset: the launch reads none from the machine running the test.
  mock.env(on, {})
  const files = new Map<string, string>()
  await seedRun(files, o, store)
  const git = world(on, files)
  const logs: string[] = []
  on('ui.log', async (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  const types = new Map<string, string>()
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => {
    types.set(e.name, e.prompt)
    return { value: { agent: `litter:${e.name}` } }
  })
  on('agent.list', async () => ({ value: [] }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  const seen: Seen[] = []
  on('prompt.submit', async (_$, e) => {
    seen.push({ text: e.text, context: [...(e.context ?? [])] })
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  const spawned: World['spawned'] = []
  on('agent.spawn', async (_$, e) => {
    spawned.push({ subagentType: e.subagentType, prompt: e.prompt, ...(e.cwd ? { cwd: e.cwd } : {}) })
    return { model: 'test-model', agentId: `ag-${e.tool_use_id}` }
  })
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  return { files, store, git, clock, seen, logs, types, spawned }
}

const noticeOf = (halt: string) =>
  `<task-notification>\n<task-id>${TASK}</task-id>\n<status>completed</status>\n` +
  '<summary>Dynamic workflow "litter:execute-run" completed</summary>\n' +
  `<result>${JSON.stringify({ halted: halt })}</result>\n` +
  '</task-notification>'
const NOTICE = noticeOf(HALT)

/** Generation 1's notification, on prompt.submit: the spool drained, run.end, summary.md, then the bridge. */
async function halted($: Engine, w: World, text = NOTICE): Promise<void> {
  await $.prompt.submit({ text, origin: { kind: 'task-notification' }, wait: false })
  expect(w.git.unknown).toEqual([])
}

const kindsAfter = (files: Map<string, string>, seq: number) =>
  [...files.keys()]
    .filter(k => k.startsWith(`${RUN_DIR}/ledger/`))
    .sort()
    .map(k => JSON.parse(files.get(k)!) as { seq: number; kind: string; body: Record<string, unknown> })
    .filter(r => r.seq > seq)
const swarmFiles = (files: Map<string, string>) => [...files.keys()].filter(k => k.startsWith(`${LITTER}/swarms/`))

/** The swarm the bridge launched: its name, launch folder and node types, from its swarm.start. */
function launched(files: Map<string, string>): { name: string; launchDir: string; types: Record<string, string> } {
  const key = [...files.keys()].find(k => /\/swarms\/repair-[0-9a-f]{6}\/launches\/[^/]+\/ledger\/000001-swarm\.start\.json$/.test(k))
  if (!key) throw new Error(`no swarm.start; swarms/ holds ${JSON.stringify(swarmFiles(files))}`)
  const start = JSON.parse(files.get(key)!) as { body: { swarm: string; types: Record<string, string> } }
  return { name: start.body.swarm, launchDir: key.slice(0, key.indexOf('/ledger/')), types: start.body.types }
}

/** The auto start, and the runner spawned by the lead (an orchestrator: it counts against no budget). */
async function live($: Engine, on: On, o: Omit<Opts, 'mode'> = {}) {
  const w = await started($, on, { mode: 'auto', ...o })
  await halted($, w)
  const s = launched(w.files)
  const r = await $.agent.spawn({ ...SPAWN, tool_use_id: 'runner', subagentType: s.types.runner! })
  expect(r).toEqual(expect.objectContaining({ agentId: 'ag-runner' }))
  return { w, s, since: kindsAfter(w.files, 0).find(r => r.kind === 'run.repair')!.seq }
}

const parse = (r: { result?: unknown; deny?: string }) => {
  expect(r.deny).toBeUndefined()
  return JSON.parse(String(r.result)) as Record<string, unknown>
}
const land = async ($: Engine, agentId: string, verifyId: string, id = verifyId) =>
  parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: `land-${id}`, agentId, kind: 'land', gate: 'G2', verify_id: verifyId }))
const notLanded = (reason: string) => ({ ok: true, landed: false, retry: false, reason })

/** A verify of G2 and its verdict in the repair generation, as the gate records them (a rejection carries its round), the head moved with them. */
async function judged(w: World, n: number, by: Author, o: { approved: boolean; round: number | null }): Promise<string> {
  const id = `G2-${n}-${String(n).repeat(10)}`
  await append(w.files, RUN_DIR, RUN, 'verify', by, verifyBody(id, 'G2', n, ATTEMPT_TREE), w.store)
  const dims = { plan_adherence: o.approved ? pass('plan.md:7-9 against the diff') : failed('the defaults are merged over the settings'), tests_green: pass(`verify ${id} exit 0`), no_regressions: pass('searched the callers'), rules: pass('none apply') }
  await append(w.files, RUN_DIR, RUN, 'verdict', by, { verify_id: id, ...dims, plan_gap: '', rule_clash: '', proposed_rules: [], gate: 'G2', attempt: n, approved: o.approved, round: o.round }, w.store)
  return id
}

describe('the execute bridge', () => {
  test('under off, the halted run records why no swarm started, the summary offers the routes, and nothing starts', async ($, on) => {
    const w = await started($, on, { mode: 'off' })
    await halted($, w)
    const after = kindsAfter(w.files, 8)
    expect(after.map(r => r.kind)).toEqual(['run.end', 'repair.declined'])
    expect(after[0]!.body).toEqual(expect.objectContaining({ generation: 1, status: 'halted', reason: HALT, source: 'notification' }))
    expect(after[1]!.body).toEqual({ reason: 'repair is off for this run' })
    const summary = w.files.get(`${RUN_DIR}/summary.md`) ?? ''
    expect(summary).toContain('No plan-template swarm started: repair is off for this run.')
    expect(summary).toContain('Recommended: continue as a plan-template swarm.')
    expect(summary).toContain(`The plan gap: "${GAP}"`)
    expect(summary).toContain('It would land G2 and G3, starting from the halted attempt in the tree')
    expect(summary).toContain(`The ways on: continue as a plan-template swarm (/litter:swarm repair ${RUN}), amend the gate (/litter:amend G2 …), or stop`)
    // Nothing started: no swarm folder, no swarm ref, no node type, no lock, and no note in the prompt.
    expect(swarmFiles(w.files)).toEqual([])
    expect([...w.git.refs.keys()].filter(r => r.startsWith('refs/litter'))).toEqual([])
    expect([...w.types.keys()].filter(n => n.startsWith('sw-'))).toEqual([])
    expect(w.seen.at(-1)!.context.some(c => c.includes('is live for run'))).toBe(false)
    await $.turn.complete({ turnId: 'turn-1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })
    await w.clock.settle()
    expect(w.seen).toHaveLength(1)
  })

  test("under auto, a plan-gap halt starts the swarm for the gates with no land; the runner's task names them and the gap, its brief the four ask cases", async ($, on) => {
    const w = await started($, on, { mode: 'auto' })
    await halted($, w)
    expect(w.logs.filter(l => l.includes(RUN) || l.includes('repair-'))).toEqual([])
    const after = kindsAfter(w.files, 8)
    expect(after.map(r => r.kind)).toEqual(['run.end', 'run.repair'])
    const s = launched(w.files)
    expect(s.name).toBe(`repair-${(await sha256(RUN_DIR)).slice(0, 6)}`)
    expect(after[1]!.body).toEqual(expect.objectContaining({ generation: 2, swarm: s.name, budget: { rounds: 3, agents: 6 } }))
    expect(w.git.refs.get(`refs/litter-swarm/${s.name}`)).toMatch(/^[0-9a-f]{40}$/)
    expect(w.git.refs.has('refs/litter-active')).toBe(true)

    // The spec at its revision: the runner in the run's checkout, the executor and critic under it.
    const spec = JSON.parse(w.files.get(`${LITTER}/swarms/${s.name}/revisions/1.json`)!) as { nodes: { id: string; task?: string; worktree?: unknown; verdicts?: boolean }[] }
    expect(spec.nodes.map(n => n.id)).toEqual(['runner', 'executor', 'critic'])
    const runner = spec.nodes[0]!
    expect(runner.worktree).toEqual({ existing: '/repo' })
    expect(spec.nodes[2]!.verdicts).toBe(true)
    const task = runner.task ?? ''
    expect(task).toContain(`Continue execute run ${RUN}, which halted at gate G2: the critic's verdict on attempt 1 names a plan gap.`)
    expect(task).toContain(`The plan gap, as the critic's last verdict on G2 states it: "${GAP}"`)
    expect(task).toContain("Gates to land, in the plan's order: G2 and G3\n")
    expect(task).toContain(`Landed before you: G1 (${TIP.slice(0, 12)})`)
    expect(task).toContain(`on litter/${RUN} at ${TIP}`)
    expect(task).toContain('Budget: 3 rejected attempts in all, 3 per gate, and 6 agents')

    // The brief, at the revision and in the runner's registered type: the four ask cases (decision 8).
    const brief = w.files.get(`${LITTER}/swarms/${s.name}/revisions/1/briefs/runner.md`) ?? ''
    const prompt = w.types.get(s.types.runner!.replace(/^litter:/, '')) ?? ''
    for (const text of [
      '- intent: requirements conflict',
      '- scope: finishing a gate means changing what the plan asks or requires',
      'recommend amending that gate with /litter:amend',
      "- authority: you need access you weren't given",
      '- budget: finishing needs more rejected attempts or agents than you have',
    ]) {
      expect(brief).toContain(text)
      expect(prompt).toContain(text)
    }

    // The summary says it took over; the note rides in this prompt, and the start comes after the lead's turn.
    expect(w.files.get(`${RUN_DIR}/summary.md`) ?? '').toContain(`Plan-template swarm ${s.name} (launch `)
    expect(w.seen).toHaveLength(1)
    expect(w.seen[0]!.context.some(c => c.startsWith(`litter: repair swarm ${s.name} is live for run ${RUN}; litter starts it after this turn.`))).toBe(true)
    await $.turn.complete({ turnId: 'turn-1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })
    await w.clock.settle()
    expect(w.seen).toHaveLength(2)
    expect(w.seen[1]!.text).toContain(`run the litter swarm skill with start ${s.name}`)
    expect(w.logs.filter(l => l.includes('repair') && l.includes('failed'))).toEqual([])
  })

  test("under auto, an executor's plan-gap stop (WP-AH): its spooled result is recorded at G2, attempt 1, and the swarm starts with the executor's words", async ($, on) => {
    const w = await started($, on, { mode: 'auto', executorGap: true })
    // Spooled after session.start, so the notification's prompt.submit drains it ahead of run.end.
    w.files.set(`${LITTER}/hooks/spool/${SESSION}.jsonl`, `${JSON.stringify(STOP_LINE)}\n`)
    await halted($, w, noticeOf(EXECUTOR_HALT))
    // After the 6 seeded records (G1 landed).
    const after = kindsAfter(w.files, 6)
    expect(after.map(r => r.kind)).toEqual(['task.result', 'run.end', 'run.repair'])
    expect(after[0]!.body).toEqual({ task: null, role: 'executor', tool_use_id: 'toolu_w2', result: STOP, gate: 'G2', attempt: 1 })
    expect(after[1]!.body).toEqual(expect.objectContaining({ status: 'halted', reason: EXECUTOR_HALT }))
    const s = launched(w.files)
    expect(after[2]!.body).toEqual(expect.objectContaining({ generation: 2, swarm: s.name }))
    const spec = JSON.parse(w.files.get(`${LITTER}/swarms/${s.name}/revisions/1.json`)!) as { nodes: { id: string; task?: string }[] }
    expect(spec.nodes.map(n => n.id)).toEqual(['runner', 'executor', 'critic'])
    const task = spec.nodes[0]!.task ?? ''
    expect(task).toContain(`Continue execute run ${RUN}, which halted at gate G2: the executor stopped on attempt 1 with a plan gap, before the attempt was judged.`)
    expect(task).toContain(`The plan gap, as the executor stated it when it stopped on G2, before its attempt was judged: "${GAP}"`)
    expect(task).toContain("Gates to land, in the plan's order: G2 and G3\n")
    const summary = w.files.get(`${RUN_DIR}/summary.md`) ?? ''
    expect(summary).toContain(`Plan-template swarm ${s.name} (launch `)
    expect(summary).toContain(`Its executor stopped on attempt 1 before the attempt was judged, naming a plan gap:\n- plan_gap: ${GAP}`)
    // The executor brief at the revision says to report such a stop as a plan gap.
    const brief = w.files.get(`${LITTER}/swarms/${s.name}/revisions/1/briefs/executor.md`) ?? ''
    expect(brief).toContain('Stop and report a plan gap to your parent if the plan lines are ambiguous')
    await $.turn.complete({ turnId: 'turn-1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })
    await w.clock.settle()
    expect(w.seen.at(-1)!.text).toContain(`run the litter swarm skill with start ${s.name}`)
  })
})

describe('land in a plan-template swarm', () => {
  test('refused without an approving verdict citing the verify, from the executor or a type without verdicts: true, and past maxAttempts rejections', async ($, on) => {
    const { w, s, since } = await live($, on)
    const critic = agent('ag-critic', s.types.critic!)
    // The executor, spawned by the runner into the run's checkout.
    const ex = await $.agent.spawn({ ...SPAWN, tool_use_id: 'exec', subagentType: s.types.executor!, parentAgentId: 'ag-runner' })
    expect(ex).toEqual(expect.objectContaining({ agentId: 'ag-exec' }))
    expect(w.spawned.map(x => [x.subagentType, x.cwd])).toEqual([
      [s.types.runner, '/repo'],
      [s.types.executor, '/repo'],
    ])

    // No verdict of this repair (generation 1's plan-gap verdict doesn't count).
    expect(await land($, 'ag-runner', 'G2-1-f6a7b8c9d0')).toEqual(
      notLanded('no verdict of this repair judges gate G2; the critic records its own verify of the gate, then a verdict citing it'),
    )
    // A rejection, and a land citing another verify than the latest verdict's.
    const two = await judged(w, 2, critic, { approved: false, round: 1 })
    expect(await land($, 'ag-runner', two)).toEqual(
      notLanded(`the latest verdict on gate G2 (on verify ${two}) doesn't approve it; send its gaps to the executor, then have the critic judge again`),
    )
    expect(await land($, 'ag-runner', 'G2-1-f6a7b8c9d0', 'old')).toEqual(
      notLanded(`the latest verdict on gate G2 cites verify ${two}, not G2-1-f6a7b8c9d0; a land follows the critic's latest judgment of the gate`),
    )
    // An approval from the executor's type (no verdicts: true), then one from the executor's own agent.
    const three = await judged(w, 3, agent('ag-x', s.types.executor!), { approved: true, round: null })
    expect(await land($, 'ag-runner', three)).toEqual(notLanded(`the verdict on verify ${three} isn't from a node of swarm ${s.name} whose type has verdicts: true`))
    const four = await judged(w, 4, agent('ag-exec', s.types.critic!), { approved: true, round: null })
    expect(await land($, 'ag-runner', four)).toEqual(
      notLanded(`the verdict on verify ${four} is from an agent that may write in the run's checkout, so it could be judging its own change`),
    )
    // The executor lands nothing itself.
    expect(await land($, 'ag-exec', four, 'exec')).toEqual({ ok: false, field: 'kind', error: 'litter: executor has no land authority (authority.land), so it lands nothing; report the approved verify to your parent' })

    // Past maxAttempts (3) rejections of G2 in this repair, an approval still doesn't land.
    await judged(w, 5, critic, { approved: false, round: 2 })
    await judged(w, 6, critic, { approved: false, round: 3 })
    const seven = await judged(w, 7, critic, { approved: true, round: null })
    expect(await land($, 'ag-runner', seven)).toEqual(
      notLanded(
        'report up: gate G2 has used its attempts (3 rejected in this repair, of the run\'s 3); keep its attempt in the tree, and report blocked to your parent with what the gate needs',
      ),
    )
    // Nothing landed: no land record after the repair's start.
    expect(kindsAfter(w.files, since).filter(r => r.kind.startsWith('land'))).toEqual([])
    expect(w.git.unknown).toEqual([])
  })
})

describe('the repair budget', () => {
  test('past repairRounds rejections, the next spawn and land are refused with the ask text', async ($, on) => {
    const { w, s } = await live($, on, { rounds: 1 })
    const critic = agent('ag-critic', s.types.critic!)
    // Two rejections where the budget allows one (an earlier process's, say), then an approval.
    await judged(w, 2, critic, { approved: false, round: 1 })
    await judged(w, 3, critic, { approved: false, round: 2 })
    const four = await judged(w, 4, critic, { approved: true, round: null })
    expect(await land($, 'ag-runner', four)).toEqual(notLanded(`plan-template swarm ${s.name} has 2 rejected attempts, past its budget's 1; ${ASK}`))
    const r = await $.agent.spawn({ ...SPAWN, tool_use_id: 'exec', subagentType: s.types.executor!, parentAgentId: 'ag-runner' })
    expect(r.deny).toContain(`plan-template swarm ${s.name} has used all 1 of the rejected attempts its budget allows (2 rejecting verdicts), so it starts no more agents; ${ASK}`)
    expect(w.spawned.map(x => x.subagentType)).toEqual([s.types.runner])
  })

  test('past repairAgents spawns, the next spawn is refused with the ask text', async ($, on) => {
    const { w, s } = await live($, on, { agents: 1 })
    const ex = await $.agent.spawn({ ...SPAWN, tool_use_id: 'exec', subagentType: s.types.executor!, parentAgentId: 'ag-runner' })
    expect(ex.deny).toBeUndefined()
    const cr = await $.agent.spawn({ ...SPAWN, tool_use_id: 'critic', subagentType: s.types.critic!, parentAgentId: 'ag-runner' })
    expect(cr.deny).toContain(
      `plan-template swarm ${s.name} has started all 1 agents its repair budget allows (the workers and agents its nodes start), so it starts no more; ${ASK}`,
    )
    expect(w.spawned.map(x => x.subagentType)).toEqual([s.types.runner, s.types.executor])
  })
})
