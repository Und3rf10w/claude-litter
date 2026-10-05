// Tier 2: phase 4's contracts and one-time wiring (WP-BA), with the other
// packages' stubs in place: the two new mod-only kinds; proposal, verdict and
// probe in their new module; run.start for a design with the stubs, a
// prober's setup and links, and the seams to BD's parseDesign and
// designArgs; the decoder's budget and halted rows; an author's and a
// reframer's design.result; recordEnd's finalizeDesign and the summary's
// design part, through lifecycle's `deps`; and the design roles' tags.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Policy, SpoolLine } from '../../hooks/hookfiles'
import type { RecordCtx, RecordError, RecordInput, RecordReply } from '../../hooks/records/core'
import type { RunEndBody, RunJson, RunStartReply, Workflow } from '../../hooks/records/run'
import type { DesignArgsCtx } from '../../hooks/design/launch'
import type { RunRef } from '../../hooks/lifecycle'
import { fail } from '../../hooks/records/core'
import { dispatchRecord, RECORD_TOOL, type DispatchEnv } from '../../hooks/ledger'
import { readLedger } from '../../hooks/ledgercore'
import { designVerdictPath, ledgerDir, modePath, probePath, PROPOSAL_VERSION, proposalPath, runDir, runJsonPath, summaryPath, RUN_ID, UNKNOWN_ID } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { consumeAgents, readPolicy, writePolicy } from '../../hooks/policy'
import { KIND_RULES, MOD_ONLY_KINDS } from '../../hooks/records/design'
import { KIND_HANDLERS } from '../../hooks/registry'
import { recordProbe, recordProposal, recordVerdict } from '../../hooks/design/records'
import { consumeOutput } from '../../hooks/output'
import { decodeReturn, deps as lifecycleDeps, endRun, getPending, openGeneration, patchRunPolicy, recordRunStart, writeSummary } from '../../hooks/lifecycle'
import { ROLE_PROMPTS, ROLE_TAGS } from '../../hooks/prompts/index'
import { readLock, stopLease } from '../../hooks/lock'
import { updateSession } from '../../hooks/session'
import { sha256 } from '../../hooks/fsx'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// run.start runs real git in scratch repos; a loaded machine takes seconds.
setDefaultTimeout(120_000)

const asError = (r: RecordReply): RecordError => {
  expect(r.ok).toBe(false)
  return r as RecordError
}

// The seams, put back after every test.
const saved = { ...lifecycleDeps }
const cleanups: (() => void)[] = []
afterEach(() => {
  Object.assign(lifecycleDeps, saved)
  stopLease()
  updateSession({ litterDir: null })
  for (const c of cleanups.splice(0)) c()
})

/** The six criteria and a ban that BD's minimum (decision 5) takes. */
const BAR = [
  { id: 'C1', text: 'retries once', evidence: 'a test' },
  { id: 'C2', text: 'keeps the timeout', evidence: 'the config' },
  { id: 'C3', text: 'logs each retry', evidence: 'a log line' },
  { id: 'C4', text: 'needs no new dependency', evidence: 'package.json' },
  { id: 'C5', text: 'consistent with rules', evidence: 'the rules' },
  { id: 'C6', text: 'keeps the public API', evidence: 'the exports' },
  { id: 'B1', text: 'no sleep in tests', evidence: 'grep', reason: 'flaky' },
]
const BAR_IDS = BAR.map(b => b.id)
const DESIGN_ROLES = ['falsifier', 'coverage', 'mechanism', 'prober', 'reframer', 'author', 'design-critic'] as const

// ---------------------------------------------------------------------------
// The record tool's world (design.spec.ts's): a run, an agent map, no git

const RUN = '20261004-contracts'

type ToolWorld = { p: TestPorts; dir: string; env: DispatchEnv }

function policyFor(dir: string, run: string, workflow: Workflow): Policy {
  return {
    v: 1,
    session: 'test-session',
    litterDir: dir,
    run: {
      run,
      workflow,
      runDir: runDir(dir, run),
      checkout: dir,
      base: '0'.repeat(40),
      runIds: [],
      launching: false,
      stopping: false,
      inflight: null,
      isolationLost: false,
      roots: { checkout: dir, litterDir: dir, litterCopies: [dir], ruleDirs: [], worktrees: [] },
      setup: null,
      linkDirs: [],
    },
    roles: {},
    swarm: null,
  }
}

async function toolWorld(workflow: Workflow = 'design'): Promise<ToolWorld> {
  const p = nodePorts()
  const s = scratch()
  cleanups.push(s.cleanup)
  const dir = s.dir
  await p.fs.write(runJsonPath(runDir(dir, RUN)), `${JSON.stringify({ v: 1, run: RUN, workflow, args: { bar: BAR }, ref: `litter/${RUN}` })}\n`)
  await writePolicy(p, dir, policyFor(dir, RUN, workflow))
  return { p, dir, env: { litterDir: dir, litterDirError: null, ready: true, options: normalizeOptions(undefined) } }
}

async function startAgent(w: ToolWorld, id: string, role: string): Promise<void> {
  await consumeAgents(
    { p: w.p, litterDir: w.dir, sessionId: 'test-session' },
    { v: 1, ev: 'start', ts: 1_700_000_000, session_id: 'test-session', agent_id: id, agent_type: `litter:${role}`, cwd: '/w', transcript_path: '/t' },
  )
}

const call = (w: ToolWorld, fields: Record<string, unknown>, agentId?: string) =>
  dispatchRecord(w.p, agentId, { tool: 'mcp__litter__record', tool_use_id: 'tu1', ...fields }, w.env)

const ledgerFiles = (w: ToolWorld) => (existsSync(ledgerDir(runDir(w.dir, RUN))) ? readdirSync(ledgerDir(runDir(w.dir, RUN))) : [])
const recordsOf = async (w: ToolWorld) => (await readLedger(w.p, runDir(w.dir, RUN), RUN)).records

describe('design.result and design.deliver', () => {
  test("are the mod's, with a run", () => {
    for (const kind of ['design.result', 'design.deliver'] as const) {
      expect(KIND_RULES[kind]).toEqual({ by: 'mod', run: 'required' })
      expect(MOD_ONLY_KINDS).toContain(kind)
    }
  })

  test('are refused through the tool, from an agent and from the launcher, recording nothing', async () => {
    const w = await toolWorld()
    await startAgent(w, 'au', 'author')
    for (const kind of ['design.result', 'DESIGN.DELIVER']) {
      for (const agentId of [undefined, 'au']) {
        const e = asError(await call(w, { kind, run: RUN, role: 'author', result: {} }, agentId))
        expect(e.field).toBe('kind')
        expect(e.error).toBe(`litter: '${kind.toLowerCase()}' is recorded by litter itself, never through this tool`)
        expect(e.allowed).not.toContain('design.result')
        expect(e.allowed).not.toContain('design.deliver')
      }
    }
    expect(ledgerFiles(w)).toEqual([])
  })
})

describe('proposal, verdict and probe', () => {
  test('reach their handlers in design/records.ts', () => {
    expect(KIND_HANDLERS.proposal).toBe(recordProposal)
    expect(KIND_HANDLERS.verdict).toBe(recordVerdict)
    expect(KIND_HANDLERS.probe).toBe(recordProbe)
  })

  test("keep today's checks: a proposal's text and version, a verdict's version and bar, a probe's report", async () => {
    const w = await toolWorld()
    await startAgent(w, 'au', 'author')
    await startAgent(w, 'cr', 'design-critic')
    await startAgent(w, 'pr', 'prober')
    expect(asError(await call(w, { kind: 'proposal' }, 'au')).field).toBe('text')
    expect(asError(await call(w, { kind: 'proposal', text: 'x', gates: [{ id: 'G1' }] }, 'au')).field).toBe('gates')
    expect(asError(await call(w, { kind: 'verdict', version: 'v1', criteria: [], overall: 'HOLDING' }, 'cr')).field).toBe('version')
    expect(await call(w, { kind: 'proposal', text: 'the design' }, 'au')).toEqual(expect.objectContaining({ ok: true, version: 'v1', sha256: await sha256('the design') }))
    expect(await w.p.fs.read(proposalPath(runDir(w.dir, RUN), 'v1'))).toBe('the design')
    const pass = BAR_IDS.map(id => ({ id, verdict: 'PASS', evidence: 'x.ts:1' }))
    const short = asError(await call(w, { kind: 'verdict', version: 'v1', criteria: pass.slice(1), overall: 'HOLDING' }, 'cr'))
    expect(short).toEqual(expect.objectContaining({ field: 'criteria', allowed: BAR_IDS }))
    expect(short.error).toContain('missing C1')
    expect((await call(w, { kind: 'verdict', version: 'v1', criteria: pass, overall: 'APPROVED' }, 'cr')).ok).toBe(true)
    expect(asError(await call(w, { kind: 'probe' }, 'pr')).field).toBe('report')
    expect((await call(w, { kind: 'probe', report: '## Result\nconfirmed' }, 'pr')).ok).toBe(true)
    const recs = await recordsOf(w)
    expect(recs.map(r => r.kind)).toEqual(['proposal', 'verdict', 'probe'])
    expect(recs[1]!.body.sha256).toBe(await sha256('the design'))
    expect(recs[2]!.body).toEqual({ report: '## Result\nconfirmed' })
  })

  test("the layout's new paths and ids", () => {
    expect(designVerdictPath('/r', 'v3')).toBe('/r/verdicts/v3.md')
    expect(probePath('/r', 'U2')).toBe('/r/probes/U2.md')
    expect(['v1', 'v12', 'v0', 'v01', 'V1', 'v1.md'].map(v => PROPOSAL_VERSION.test(v))).toEqual([true, true, false, false, false, false])
    expect(['U1', 'U10', 'U0', 'u1', 'U1/'].map(v => UNKNOWN_ID.test(v))).toEqual([true, true, false, false, false])
  })
})

describe("the tool's empiricalUnknowns", () => {
  test('are declared as texts or objects, and a list sent as a string of its JSON is decoded before the parse', async () => {
    const props = (RECORD_TOOL.inputSchema as { properties: Record<string, unknown> }).properties
    expect(props.empiricalUnknowns).toEqual({ type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object' }] } })
    const w = await toolWorld()
    const seen: unknown[] = []
    lifecycleDeps.parseDesign = input => {
      seen.push(input.empiricalUnknowns)
      return fail('litter: stood in', 'goal')
    }
    const unknowns = [{ question: 'Does the server send Retry-After?', smallest_test: 'curl -I', kill_result: 'no header' }, 'a bare question']
    const e = asError(await call(w, { kind: 'run.start', workflow: 'design', authorized: ['x'], empiricalUnknowns: JSON.stringify(unknowns) }))
    expect(e.error).toBe('litter: stood in')
    expect(seen).toEqual([unknowns])
  })
})

// ---------------------------------------------------------------------------
// run.start's world (runstart.spec.ts's): a scratch repo, real git

type StartWorld = { p: TestPorts; dir: string; litterDir: string; git: (...argv: string[]) => Promise<string>; ctx: RecordCtx }

async function startWorld(options: Record<string, unknown> = {}): Promise<StartWorld> {
  const s = scratch()
  cleanups.push(s.cleanup)
  const dir = realpathSync(s.dir)
  const base = nodePorts({ sessionId: 'session-a' })
  const p: TestPorts = {
    ...base,
    cwd: async () => dir,
    run: (argv, init) =>
      argv[0] === 'jq'
        ? Promise.resolve({ code: 0, stdout: 'jq-1.7.1\n', stderr: '', truncated: false })
        : base.run(argv, init?.cwd ? init : { ...init, cwd: dir }),
  }
  const { git } = await scratchRepo(p, dir)
  await p.fs.write(join(dir, 'plan.md'), '### G1: One\nFiles: a.txt\nChecks: true\nDone when: a.txt exists\n')
  await git('add', 'plan.md')
  await git('commit', '-q', '-m', 'plan')
  const litterDir = join(dir, '.claude', 'litter')
  await p.fs.write(modePath(litterDir), 'default\n')
  updateSession({ litterDir })
  return { p, dir, litterDir, git, ctx: { p, caller: { agentId: null, agentType: null }, litterDir, options: normalizeOptions(options) } }
}

const AUTH = { authorized: ['change the retry'] }
const design = (w: StartWorld, extra: Record<string, unknown> = {}) =>
  recordRunStart(w.ctx, { kind: 'run.start', workflow: 'design', ...AUTH, goal: 'design the retry', deliverable: 'plan', bar: BAR, ...extra } as RecordInput)
const startOf = (w: StartWorld, workflow: Workflow, extra: Record<string, unknown> = {}) =>
  workflow === 'design'
    ? design(w, extra)
    : recordRunStart(w.ctx, {
        kind: 'run.start',
        workflow,
        ...AUTH,
        ...(workflow === 'execute' ? { planPath: 'plan.md' } : workflow === 'plan' ? { goal: 'add a retry' } : { tasks: [{ id: 'a', title: 'A', text: 'do a', files: ['a.txt'] }] }),
        ...extra,
      } as RecordInput)

function okReply(r: RecordReply): RunStartReply {
  if (!r.ok) throw new Error(`run.start refused: ${JSON.stringify(r)}`)
  return r as RunStartReply
}

const runJsonOf = async (w: StartWorld, r: RunStartReply) => JSON.parse(await w.p.fs.read(runJsonPath(r.runDir))) as RunJson
const runsIn = (w: StartWorld) => (existsSync(w.litterDir) ? readdirSync(w.litterDir).filter(n => RUN_ID.test(n)) : [])
const refOf = (w: StartWorld, r: RunStartReply): RunRef => ({ run: r.run, runDir: r.runDir, litterDir: w.litterDir })

/** A refusal before step 3: no run folder, no lock, no litter ref. */
async function nothingWritten(w: StartWorld) {
  expect(runsIn(w)).toEqual([])
  expect(await readLock(w.p, w.dir)).toBeNull()
  expect((await w.git('for-each-ref', '--format=%(refname)', 'refs/heads/litter', 'refs/litter')).trim()).toBe('')
}

const DEFAULT_LENSES = ['falsifier', 'coverage', 'mechanism'].map(role => ({ role, name: role, focus: '', anchors: [] }))

describe('run.start for a design, with the stubs', () => {
  test("the args, bar.md and run.json of before; BD's template and prior aside", async () => {
    const w = await startWorld()
    const r = okReply(await design(w, { runRules: ['keep the public API'], anchors: ['src/retry.ts'] }))
    expect(r.warnings).toBeUndefined()
    const base = (await w.git('rev-parse', `refs/litter/${r.run}/base`)).trim()
    const { template: _template, prior: _prior, ...args } = r.args
    expect(args).toEqual({
      run: r.run,
      nonce: expect.stringMatching(/^[0-9a-f]{12}$/),
      authorized: 'change the retry',
      rules: ['For this run (stated by you): keep the public API'],
      goal: 'design the retry',
      deliverable: 'plan',
      bar: BAR,
      anchors: ['src/retry.ts'],
      lenses: DEFAULT_LENSES,
      empiricalUnknowns: [],
      maxRounds: 4,
      base,
    })
    expect(await w.p.fs.read(join(r.runDir, 'bar.md'))).toBe(
      [
        '# Bar',
        '',
        '- **C1** retries once\n  Evidence: a test',
        '- **C2** keeps the timeout\n  Evidence: the config',
        '- **C3** logs each retry\n  Evidence: a log line',
        '- **C4** needs no new dependency\n  Evidence: package.json',
        '- **C5** consistent with rules\n  Evidence: the rules',
        '- **C6** keeps the public API\n  Evidence: the exports',
        '- **B1** no sleep in tests\n  Evidence: grep\n  Reason: flaky',
        '',
      ].join('\n'),
    )
    expect(await runJsonOf(w, r)).toEqual({
      v: 1,
      run: r.run,
      workflow: 'design',
      args: r.args,
      authorized: AUTH.authorized,
      mode: 'default',
      verify: null,
      goalCheck: null,
      setup: null,
      linkDirs: [],
      base,
      ref: `refs/litter/${r.run}/base`,
      checkout: w.dir,
      isolate: false,
      previousBranch: 'refs/heads/main',
      continueOf: null,
      amendOf: null,
      rules: [],
      planPath: null,
      planSha256: null,
      session: 'session-a',
      created: expect.any(Number),
    })
  })

  test("parseDesign's warnings reach the reply", async () => {
    const w = await startWorld()
    lifecycleDeps.parseDesign = input => {
      const parsed = saved.parseDesign(input)
      return parsed.ok ? { ...parsed, warnings: ['the bar has 13 items; group related criteria (the interview aims for about 10)'] } : parsed
    }
    const r = okReply(await design(w))
    expect(r.warnings).toEqual(['the bar has 13 items; group related criteria (the interview aims for about 10)'])
  })

  test("parseDesign's refusal is run.start's, before anything is written", async () => {
    const w = await startWorld()
    lifecycleDeps.parseDesign = () => fail("litter: the bar needs at least 6 items, 1 a ban; it has 1", 'bar')
    expect(await design(w)).toEqual({ ok: false, error: 'litter: the bar needs at least 6 items, 1 a ban; it has 1', field: 'bar' })
    await nothingWritten(w)
  })

  test("designArgs gets prepare's context, and its refusal refuses the launch, writing nothing", async () => {
    const w = await startWorld()
    const seen: DesignArgsCtx[] = []
    lifecycleDeps.designArgs = async (p, ctx) => {
      seen.push(ctx)
      return saved.designArgs(p, ctx)
    }
    const r = okReply(await design(w, { runRules: ['no new deps'] }))
    expect(seen).toHaveLength(1)
    const ctx = seen[0]!
    expect(ctx).toEqual(
      expect.objectContaining({
        litterDir: w.litterDir,
        checkout: w.dir,
        run: r.run,
        runRules: ['For this run (stated by you): no new deps'],
        base: { run: r.run, nonce: r.args.nonce, authorized: 'change the retry', rules: ['For this run (stated by you): no new deps'] },
        snapBase: r.args.base,
        options: w.ctx.options,
      }),
    )
    expect(ctx.spec.design).toEqual(expect.objectContaining({ deliverable: 'plan', bar: BAR }))
    expect(typeof ctx.selectRules).toBe('function')

    const w2 = await startWorld()
    lifecycleDeps.designArgs = async () => fail("litter: no template for 'research' yet", 'deliverable')
    expect(await design(w2, { deliverable: 'research' })).toEqual({ ok: false, error: "litter: no template for 'research' yet", field: 'deliverable' })
    await nothingWritten(w2)
  })
})

describe("a design's probers: setup and linkDirs (decision 11)", () => {
  const QUESTION = "litter wants to run this setup command, which isn't the configured one:\n\n  npm ci\n\nRun it for this launch?"

  test('a setup is asked for as a fanout asks, and policy.json carries the approved argv and the links', async () => {
    const fw = await startWorld({ verify: ['true'] })
    fw.p.answers.push('Approve')
    okReply(await startOf(fw, 'fanout', { setup: ['npm', 'ci'] }))
    expect(fw.p.asked).toEqual([{ question: QUESTION, options: ['Refuse', 'Approve'] }])

    const w = await startWorld()
    w.p.answers.push('Approve')
    const r = okReply(await design(w, { setup: ['npm', 'ci'], linkDirs: ['node_modules'] }))
    expect(w.p.asked).toEqual(fw.p.asked)
    const json = await runJsonOf(w, r)
    expect({ setup: json.setup, linkDirs: json.linkDirs }).toEqual({ setup: ['npm', 'ci'], linkDirs: ['node_modules'] })
    const run = (await readPolicy(w.p, w.litterDir))?.run
    expect({ run: run?.run, setup: run?.setup, linkDirs: run?.linkDirs }).toEqual({ run: r.run, setup: ['npm', 'ci'], linkDirs: ['node_modules'] })
  })

  test('refused, or with no one to ask (as under -p), the launch is refused, writing nothing', async () => {
    const w = await startWorld()
    w.p.answers.push('Refuse')
    expect(await design(w, { setup: ['npm', 'ci'] })).toEqual({
      ok: false,
      error: 'litter: you refused the setup command npm ci; use the configured one or set the setup plugin option',
      field: 'setup',
    })
    await nothingWritten(w)
    const e = asError(await design(w, { setup: ['npm', 'ci'] }))
    expect(e.field).toBe('setup')
    expect(e.error).toContain('no one could approve it here (as under -p)')
    await nothingWritten(w)
  })

  test("unset, the options' setup and links apply unasked, as a fanout's; a plan run still takes none", async () => {
    const options = { setup: ['make', 'deps'], linkDirs: ['vendor'] }
    const w = await startWorld(options)
    const r = okReply(await design(w))
    expect(w.p.asked).toEqual([])
    expect((await readPolicy(w.p, w.litterDir))?.run).toEqual(expect.objectContaining({ setup: ['make', 'deps'], linkDirs: ['vendor'] }))
    expect(await runJsonOf(w, r)).toEqual(expect.objectContaining({ setup: ['make', 'deps'], linkDirs: ['vendor'] }))

    const pw = await startWorld(options)
    const pr = okReply(await startOf(pw, 'plan'))
    expect(await runJsonOf(pw, pr)).toEqual(expect.objectContaining({ setup: null, linkDirs: [] }))
  })

  test("a link under litter's own folder is refused, as a fanout's is", async () => {
    const w = await startWorld()
    const e = asError(await design(w, { linkDirs: ['.claude/litter'] }))
    expect(e.field).toBe('linkDirs')
    await nothingWritten(w)
  })
})

// ---------------------------------------------------------------------------
// The decoder (plan section 9's table): the budget and halted rows

describe("the decoder's design rows", () => {
  const decoded = (result: unknown) => decodeReturn('design', { status: 'completed', result })

  test("by: 'budget' is done, holding, with its payload", () => {
    expect(decoded({ stopped: null, outcome: 'holding', by: 'budget', version: 'v3' })).toEqual({
      status: 'done',
      reason: null,
      payload: { outcome: 'holding', by: 'budget', version: 'v3' },
    })
    expect(decoded({ stopped: null, outcome: 'approved', by: 'approved', version: 'v2' }).status).toBe('done')
    expect(decoded({ stopped: null, outcome: 'holding', by: 'time', version: 'v3' })).toEqual({ status: 'failed', reason: 'unrecognized result' })
  })

  test("{ stopped: 'halted', reason } is halted with the reason, on one line and cut", () => {
    expect(decoded({ stopped: 'halted', reason: 'the author returned nothing after its retry (round 2)' })).toEqual({
      status: 'halted',
      reason: 'the author returned nothing after its retry (round 2)',
    })
    const long = decoded({ stopped: 'halted', reason: `the prober's worktree\nwas refused: ${'x'.repeat(400)}` })
    expect(long.status).toBe('halted')
    expect(long.reason!.length).toBe(300)
    expect(long.reason!.startsWith("the prober's worktree was refused: xxx")).toBe(true)
    expect(long.reason!.endsWith('…')).toBe(true)
  })

  test('halted without a string reason is unrecognized', () => {
    for (const reason of [undefined, '', '   ', 7, null]) {
      expect(decoded({ stopped: 'halted', ...(reason === undefined ? {} : { reason }) })).toEqual({ status: 'failed', reason: 'unrecognized result' })
    }
  })
})

// ---------------------------------------------------------------------------
// output.ts: an author's and a reframer's result as design.result

describe("a design's author and reframer results", () => {
  const output = (id: string, type: string, input: Record<string, unknown>, toolUseId = 'tu1'): SpoolLine => ({
    v: 1,
    ev: 'output',
    ts: 1_700_000_001,
    session_id: 'test-session',
    agent_id: id,
    agent_type: type,
    tool_use_id: toolUseId,
    input,
  })
  const ctxOf = (w: ToolWorld) => ({ p: w.p, litterDir: w.dir, sessionId: 'test-session' })
  const AUTHOR = { version: 'v2', proposal: '# The design\n...', residual_unknowns: ['Is the cache shared?'], user_decisions: [] }
  const REFRAMER = { candidates: [{ goal: 'make the client idempotent', why: 'retries are a symptom' }], recommendation: 'keep' }

  test("each records one design.result: the author's without its proposal, the reframer's whole; drained twice, still one", async () => {
    const w = await toolWorld()
    await startAgent(w, 'au', 'author')
    await startAgent(w, 'rf', 'reframer')
    for (let i = 0; i < 2; i++) {
      await consumeOutput(ctxOf(w), output('au', 'litter:author', AUTHOR, 'tu-a'))
      await consumeOutput(ctxOf(w), output('rf', 'litter:reframer', REFRAMER, 'tu-r'))
    }
    const recs = await recordsOf(w)
    expect(recs.map(r => [r.kind, r.by])).toEqual([
      ['design.result', { source: 'agent', agentId: 'au', agentType: 'litter:author' }],
      ['design.result', { source: 'agent', agentId: 'rf', agentType: 'litter:reframer' }],
    ])
    const { proposal: _proposal, ...kept } = AUTHOR
    expect(recs[0]!.body).toEqual({ role: 'author', tool_use_id: 'tu-a', result: kept })
    expect(recs[1]!.body).toEqual({ role: 'reframer', tool_use_id: 'tu-r', result: REFRAMER })
  })

  test("another design role's result records nothing, nor an author's outside a design", async () => {
    const w = await toolWorld()
    for (const role of ['falsifier', 'coverage', 'mechanism', 'prober', 'design-critic']) {
      await startAgent(w, role, role)
      await consumeOutput(ctxOf(w), output(role, `litter:${role}`, { report: 'r', version: 'v1' }))
    }
    expect(ledgerFiles(w)).toEqual([])

    const ex = await toolWorld('execute')
    await startAgent(ex, 'au', 'author')
    await consumeOutput(ctxOf(ex), output('au', 'litter:author', AUTHOR))
    expect(ledgerFiles(ex)).toEqual([])
  })

  test('a result from an agent the map lacks, or that contradicts it, is logged and skipped', async () => {
    const w = await toolWorld()
    await consumeOutput(ctxOf(w), output('ghost', 'litter:author', AUTHOR))
    await startAgent(w, 'au', 'author')
    await consumeOutput(ctxOf(w), output('au', 'litter:reframer', REFRAMER))
    expect(w.p.logs).toContain('output from agent ghost (litter:author), which has no start; not recorded')
    expect(w.p.logs).toContain('output from agent au as litter:reframer contradicts litter:author; not recorded')
    expect(ledgerFiles(w)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// recordEnd and writeSummary: BE's finalizeDesign and designSummary

/** What the Workflow hook does once next(e) returned the task (lifecycle.spec.ts's launched). */
async function launched(w: StartWorld, r: RunStartReply): Promise<RunRef> {
  const ref = refOf(w, r)
  const pending = (await getPending(w.p, w.litterDir))!
  stopLease(pending.oid)
  await w.p.store.delete(`litter.pending.${w.litterDir}`)
  await openGeneration(w.p, ref, 'run.launch', { taskId: 'task-1', runId: 'wf_abc123', scriptPath: null }, 'session-a', pending.oid)
  await patchRunPolicy(w.p, w.litterDir, r.run, x => ({ ...x, runIds: ['wf_abc123'] }))
  return ref
}

function timeline() {
  const steps: unknown[][] = []
  lifecycleDeps.finalizeDesign = async (_p, ref, end) => void steps.push(['finalize', ref, end])
  lifecycleDeps.designSummary = async (_p, ref, json, records) => {
    steps.push(['design summary', ref.run, json?.workflow, records.map(x => x.kind)])
    return ['', '## Design', '', '- held at v3']
  }
  lifecycleDeps.executeSummary = async (_p, ref) => {
    steps.push(['execute summary', ref.run])
    return []
  }
  return steps
}

describe("recordEnd's finalizeDesign", () => {
  test("a design's current generation: finalizeDesign with its end, then the summary with BE's part", async () => {
    const w = await startWorld()
    const r = okReply(await design(w))
    const ref = await launched(w, r)
    const steps = timeline()
    const end: RunEndBody = { taskId: 'task-1', generation: 1, status: 'done', reason: null, source: 'notification' }
    expect(await endRun(w.p, ref, end)).toEqual({ recorded: true, end })
    expect(steps).toEqual([
      ['finalize', ref, end],
      ['design summary', r.run, 'design', ['run.start', 'run.launch', 'run.end']],
    ])
    expect(await w.p.fs.read(summaryPath(r.runDir))).toContain('\n## Design\n\n- held at v3\n')
    // A second end of the generation changes nothing, and delivers nothing again.
    await endRun(w.p, ref, { ...end, status: 'halted', reason: 'late' })
    expect(steps).toHaveLength(2)
  })

  test('generation 0 too (a launch that failed), so a design never ends without it', async () => {
    const w = await startWorld()
    const r = okReply(await design(w))
    const steps = timeline()
    const end: RunEndBody = { taskId: null, generation: 0, status: 'launch_failed', reason: 'test', source: 'mod' }
    await endRun(w.p, refOf(w, r), end)
    expect(steps.map(s => s[0])).toEqual(['finalize', 'design summary'])
  })

  test('a failure is logged, and the summary is still written', async () => {
    const w = await startWorld()
    const r = okReply(await design(w))
    const steps = timeline()
    lifecycleDeps.finalizeDesign = async () => {
      throw new Error('plan.md is locked')
    }
    await endRun(w.p, refOf(w, r), { taskId: null, generation: 0, status: 'launch_failed', reason: 'test', source: 'mod' })
    expect(w.p.logs).toContain(`design delivery for ${r.run} failed: plan.md is locked`)
    expect(steps.map(s => s[0])).toEqual(['design summary'])
    expect(await w.p.fs.read(summaryPath(r.runDir))).toContain(`# litter run ${r.run}`)
  })

  test('an execute or a plan run never calls it', async () => {
    for (const workflow of ['execute', 'plan'] as const) {
      const w = await startWorld({ verify: ['true'] })
      const r = okReply(await startOf(w, workflow))
      const steps = timeline()
      await endRun(w.p, refOf(w, r), { taskId: null, generation: 0, status: 'launch_failed', reason: 'test', source: 'mod' })
      expect(steps.map(s => s[0])).toEqual(workflow === 'execute' ? ['execute summary'] : [])
    }
  })
})

describe("summary.md's design part", () => {
  test("is BE's designSummary's lines; a throw is logged and the rest stands", async () => {
    const w = await startWorld()
    const r = okReply(await design(w))
    timeline()
    await writeSummary(w.p, refOf(w, r))
    expect(await w.p.fs.read(summaryPath(r.runDir))).toContain('\n## Design\n\n- held at v3\n')
    lifecycleDeps.designSummary = async () => {
      throw new Error('verdicts unreadable')
    }
    await writeSummary(w.p, refOf(w, r))
    expect(w.p.logs).toContain(`run ${r.run}: the summary's design part failed: verdicts unreadable`)
    const text = await w.p.fs.read(summaryPath(r.runDir))
    expect(text).toContain(`# litter run ${r.run}`)
    expect(text).not.toContain('## Design')
  })

  test("with the stub, a design's summary has no design part and no Gates table", async () => {
    const w = await startWorld()
    const r = okReply(await design(w))
    await writeSummary(w.p, refOf(w, r))
    const text = await w.p.fs.read(summaryPath(r.runDir))
    expect(text).toContain('- Workflow: design')
    expect(text).not.toContain('## Gates')
  })
})

// ---------------------------------------------------------------------------
// The design tags (plan 7a's envelope)

describe('the design tags', () => {
  test("every design role's prompt names every tag in its ROLE_TAGS entry", () => {
    for (const role of DESIGN_ROLES) {
      expect(ROLE_TAGS[role].length).toBeGreaterThanOrEqual(6)
      for (const tag of ROLE_TAGS[role]) expect({ role, tag, named: ROLE_PROMPTS[role].includes(`<${tag}>`) }).toEqual({ role, tag, named: true })
    }
  })
})
