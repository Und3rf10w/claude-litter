// Tier 2: phase 3's contracts and one-time wiring (WP-AA), with the other
// packages' stubs in place: the new kinds' caller rules and their handlers;
// the trailers option from its value to a land's commit message; the
// adversary's clamp; run.start's args, run.json and summary.md with the
// stubs, and with a stand-in selection; and the seams to AB's and AD's
// functions in output.ts, verify.ts, land.ts and swarm/gate.ts, through
// their `deps` tables.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Policy, SpoolLine } from '../../hooks/hookfiles'
import type { Caller, RecordCtx, RecordError, RecordInput, RecordReply, StoredRecord } from '../../hooks/records/core'
import type { RunJson, RunStartReply } from '../../hooks/records/run'
import type { CriticProposal, SelectInput, Selection } from '../../hooks/records/rules'
import type { LandReply, VerifyReply } from '../../hooks/records/execute'
import type { RunRef } from '../../hooks/lifecycle'
import { dispatchRecord, type DispatchEnv } from '../../hooks/ledger'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { ledgerDir, modePath, outPath, runDir, runJsonPath, summaryPath, RUN_ID } from '../../hooks/layout'
import { isTrailerLine, normalizeOptions } from '../../hooks/options'
import { consumeAgents, writePolicy } from '../../hooks/policy'
import { KIND_RULES } from '../../hooks/records/design'
import { KIND_HANDLERS, SPOOL_CONSUMERS } from '../../hooks/registry'
import { recordGateAmend, recordPlanWrite } from '../../hooks/plan'
import { consumeInflight } from '../../hooks/inflight'
import { recordRuleFind, recordRuleImport, recordRuleOpen, recordRuleProposal } from '../../hooks/rules/records'
import { deps as lifecycleDeps, READ_ONLY_BASH, recordRunStart, runState, writeSummary } from '../../hooks/lifecycle'
import { deps as outputDeps, consumeOutput } from '../../hooks/output'
import { deps as verifyDeps, recordVerify } from '../../hooks/verify'
import { deps as landDeps, landGate, recordLand } from '../../hooks/land'
import { deps as gateDeps } from '../../hooks/swarm/gate'
import { stopLease, readLock } from '../../hooks/lock'
import { sha256 } from '../../hooks/fsx'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'
import { criticVerifies, judge, B_FAILS, repairWorld, teardown, useStandIn, RUN as REPAIR_RUN, SWARM, typeOf, type World as RepairWorld } from './repair-harness'

// run.start, verify and land run real git in scratch repos; a loaded machine takes seconds.
setDefaultTimeout(120_000)

const asError = (r: RecordReply): RecordError => {
  expect(r.ok).toBe(false)
  return r as RecordError
}

// The seams, put back after every test.
const saved = {
  lifecycle: { ...lifecycleDeps },
  output: { ...outputDeps },
  verify: { ...verifyDeps },
  land: { ...landDeps },
  gate: { ...gateDeps },
}
const cleanups: (() => void)[] = []
afterEach(() => {
  Object.assign(lifecycleDeps, saved.lifecycle)
  Object.assign(outputDeps, saved.output)
  Object.assign(verifyDeps, saved.verify)
  Object.assign(landDeps, saved.land)
  Object.assign(gateDeps, saved.gate)
  stopLease()
  for (const c of cleanups.splice(0)) c()
})

// ---------------------------------------------------------------------------
// The record tool's world (ledger.spec.ts's): a run, an agent map, no git

const RUN = '20261003-contracts'

type ToolWorld = { p: TestPorts; dir: string; env: DispatchEnv }

function policyFor(dir: string, run: string | null): Policy {
  return {
    v: 1,
    session: 'test-session',
    litterDir: dir,
    run: run
      ? {
          run,
          workflow: 'execute',
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
        }
      : null,
    roles: {},
    swarm: null,
  }
}

async function toolWorld(): Promise<ToolWorld> {
  const p = nodePorts()
  const s = scratch()
  cleanups.push(s.cleanup)
  const dir = s.dir
  await p.fs.write(runJsonPath(runDir(dir, RUN)), `${JSON.stringify({ v: 1, run: RUN, workflow: 'execute', args: {}, ref: `litter/${RUN}` })}\n`)
  await writePolicy(p, dir, policyFor(dir, RUN))
  return { p, dir, env: { litterDir: dir, litterDirError: null, ready: true, options: normalizeOptions(undefined) } }
}

async function startAgent(w: ToolWorld, id: string, type: string): Promise<void> {
  await consumeAgents(
    { p: w.p, litterDir: w.dir, sessionId: 'test-session' },
    { v: 1, ev: 'start', ts: 1_700_000_000, session_id: 'test-session', agent_id: id, agent_type: type, cwd: '/w', transcript_path: '/t' },
  )
}

const call = (w: ToolWorld, fields: Record<string, unknown>, agentId?: string) =>
  dispatchRecord(w.p, agentId, { tool: 'mcp__litter__record', tool_use_id: 'tu1', ...fields }, w.env)

const ledgerFiles = (w: ToolWorld) => (existsSync(ledgerDir(runDir(w.dir, RUN))) ? readdirSync(ledgerDir(runDir(w.dir, RUN))) : [])

describe('the new kinds', () => {
  test('the table: rule.open and rule.find from anyone with no run, rule.import from the main thread', () => {
    expect(KIND_RULES['rule.open']).toEqual({ by: 'any', run: 'none' })
    expect(KIND_RULES['rule.find']).toEqual({ by: 'any', run: 'none' })
    expect(KIND_RULES['rule.import']).toEqual({ by: 'launcher', run: 'none' })
    expect(KIND_RULES['rule.propose']).toEqual({ by: 'any', run: 'optional' })
  })

  test('each kind reaches its new module, and the in-flight consumer drains after the agent map', () => {
    expect(KIND_HANDLERS['rule.propose']).toBe(recordRuleProposal)
    expect(KIND_HANDLERS['rule.open']).toBe(recordRuleOpen)
    expect(KIND_HANDLERS['rule.import']).toBe(recordRuleImport)
    expect(KIND_HANDLERS['rule.find']).toBe(recordRuleFind)
    expect(KIND_HANDLERS['plan.write']).toBe(recordPlanWrite)
    expect(KIND_HANDLERS['gate.amend']).toBe(recordGateAmend)
    expect(SPOOL_CONSUMERS.indexOf(consumeInflight)).toBe(1)
  })

  test('rule.find and rule.open, from an agent and from the main thread, reach their stubs', async () => {
    const w = await toolWorld()
    await startAgent(w, 'gc', 'litter:gate-critic')
    for (const agentId of [undefined, 'gc']) {
      for (const kind of ['rule.find', 'rule.open']) {
        const e = asError(await call(w, { kind, id: 'keep-tests-near' }, agentId))
        expect(e).toEqual(expect.objectContaining({ field: 'kind', error: `litter: the '${kind}' record isn't built yet (phase 3)` }))
      }
    }
    expect(ledgerFiles(w)).toEqual([])
  })

  test('rule.import is refused from an agent, and reaches its stub from the main thread', async () => {
    const w = await toolWorld()
    await startAgent(w, 'gc', 'litter:gate-critic')
    const e = asError(await call(w, { kind: 'rule.import', from: 'deepwork' }, 'gc'))
    expect(e.field).toBe('kind')
    expect(e.error).toContain('main thread')
    expect(asError(await call(w, { kind: 'rule.import', from: 'deepwork' })).error).toBe("litter: the 'rule.import' record isn't built yet (phase 3)")
  })

  test('rule.accept, rule.dismiss and rule.retire are refused whoever calls, naming the two a tool call has', async () => {
    const w = await toolWorld()
    await startAgent(w, 'gc', 'litter:gate-critic')
    for (const kind of ['rule.accept', 'rule.dismiss', 'RULE.RETIRE']) {
      for (const agentId of [undefined, 'gc']) {
        const e = asError(await call(w, { kind, run: RUN }, agentId))
        expect(e.field).toBe('kind')
        expect(e.error).toContain('rules pane (/litter-rules)')
        expect(e.error).toContain('propose a rule or open one in the pane')
        expect(e.allowed).toEqual(['rule.propose', 'rule.open'])
      }
    }
    expect(ledgerFiles(w)).toEqual([])
  })

  test("plan.write, gate.amend and rule.propose keep today's checks in their new modules", async () => {
    const w = await toolWorld()
    expect(asError(await call(w, { kind: 'plan.write', run: RUN })).field).toBe('gates')
    expect(asError(await call(w, { kind: 'plan.write', run: RUN, gates: [{ id: 'G1', title: 't' }, { id: 'G1', title: 'u' }] })).field).toBe('gates[1].id')
    expect((await call(w, { kind: 'plan.write', run: RUN, gates: [{ id: 'G1', title: 'Parse' }] })).ok).toBe(true)
    expect(asError(await call(w, { kind: 'gate.amend', run: RUN, gate: 'two' })).field).toBe('gate')
    expect(asError(await call(w, { kind: 'gate.amend', run: RUN, gate: 'G2', after: 'a' })).field).toBe('reason')
    expect((await call(w, { kind: 'gate.amend', run: RUN, gate: 'G2', after: 'a', reason: 'r' })).ok).toBe(true)
    expect(asError(await call(w, { kind: 'rule.propose', run: RUN, rule: 'x'.repeat(8 * 1024 + 1) })).field).toBe('rule')
    expect(asError(await call(w, { kind: 'rule.propose', rule: 'r' })).field).toBe('run')
    expect((await call(w, { kind: 'rule.propose', run: RUN, rule: 'When touching hooks, run tier 3.' })).ok).toBe(true)
    const { records } = await readLedger(w.p, runDir(w.dir, RUN), RUN)
    expect(records.map(r => r.kind)).toEqual(['plan.write', 'gate.amend', 'rule.propose'])
    expect(records[2]!.body).toEqual({ rule: 'When touching hooks, run tier 3.', source: 'user' })
  })
})

// ---------------------------------------------------------------------------
// The trailers option

describe('the trailers option', () => {
  test('unset, "" and a list of nothing are no lines', () => {
    for (const trailers of [undefined, '', '  \n ', []]) {
      expect(normalizeOptions(trailers === undefined ? {} : { trailers })).toEqual(expect.objectContaining({ trailers: [], trailersDropped: [] }))
    }
  })

  test('a list or one string of lines, each trimmed; a line that is not Key: value, or is Litter-Run, is dropped and kept aside', () => {
    expect(normalizeOptions({ trailers: ['  Co-Authored-By: A Person <a@example.com> ', 'Signed-off-by: B <b@example.com>'] })).toEqual(
      expect.objectContaining({ trailers: ['Co-Authored-By: A Person <a@example.com>', 'Signed-off-by: B <b@example.com>'], trailersDropped: [] }),
    )
    expect(normalizeOptions({ trailers: 'Reviewed-by: C <c@example.com>\r\n\nnot a trailer\nLitter-Run: x G1 v\n2nd-Key: no' })).toEqual(
      expect.objectContaining({ trailers: ['Reviewed-by: C <c@example.com>'], trailersDropped: ['not a trailer', 'Litter-Run: x G1 v', '2nd-Key: no'] }),
    )
    expect(normalizeOptions({ trailers: ['Key:value', 'Key: ', 7, 'Ok-Key: v'] })).toEqual(
      expect.objectContaining({ trailers: ['Ok-Key: v'], trailersDropped: ['Key:value', 'Key:'] }),
    )
  })

  test('isTrailerLine is the one check land.ts makes again', () => {
    expect(isTrailerLine('Co-Authored-By: Claude Code <ai@example.com>')).toBe(true)
    expect(isTrailerLine('litter-run: r G1 v')).toBe(false)
    expect(isTrailerLine('Key: two\nlines')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// run.start's world (runstart.spec.ts's): a scratch repo with a two-gate plan

const PLAN = [
  '# Plan',
  '',
  '### G1: First',
  'Files: a.txt',
  'Checks: test -f a.txt',
  'Done when: a.txt exists',
  '',
  '### G2: Second',
  'Files: b.txt',
  'Checks: test -f b.txt',
  'Done when: b.txt exists',
  '',
].join('\n')

type StartWorld = { p: TestPorts; dir: string; litterDir: string; git: (...argv: string[]) => Promise<string>; ctx: RecordCtx }

async function startWorld(options: Record<string, unknown> = { verify: ['true'] }): Promise<StartWorld> {
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
  await p.fs.write(join(dir, 'plan.md'), PLAN)
  await git('add', 'plan.md')
  await git('commit', '-q', '-m', 'plan')
  const litterDir = join(dir, '.claude', 'litter')
  await p.fs.write(modePath(litterDir), 'default\n')
  return { p, dir, litterDir, git, ctx: { p, caller: { agentId: null, agentType: null }, litterDir, options: normalizeOptions(options) } }
}

const AUTH = { authorized: ['change a.txt and b.txt'] }
const TASKS = [
  { id: 'a', title: 'A', text: 'do a', files: ['a.txt'] },
  { id: 'b', title: 'B', text: 'do b', files: ['b/'] },
  { id: 'r', title: 'R', text: 'read only', writes: false },
]

const start = (w: StartWorld, workflow: string, extra: Record<string, unknown> = {}) => {
  const byWorkflow: Record<string, Record<string, unknown>> = {
    execute: { planPath: 'plan.md' },
    fanout: { tasks: TASKS },
    plan: { goal: 'add a retry' },
    design: { goal: 'design the retry', deliverable: 'plan', bar: [{ id: 'C1', text: 'retries once', evidence: 'a test' }] },
  }
  return recordRunStart(w.ctx, { kind: 'run.start', workflow, ...AUTH, ...byWorkflow[workflow], ...extra } as RecordInput)
}

function okReply(r: RecordReply): RunStartReply {
  if (!r.ok) throw new Error(`run.start refused: ${JSON.stringify(r)}`)
  return r as RunStartReply
}

const runJsonOf = async (w: StartWorld, r: RunStartReply) => {
  const text = await w.p.fs.read(runJsonPath(r.runDir))
  return { text, json: JSON.parse(text) as RunJson & { trailers?: string[] } }
}
const runsIn = (w: StartWorld) => (existsSync(w.litterDir) ? readdirSync(w.litterDir).filter(n => RUN_ID.test(n)) : [])

describe('run.start: the trailers', () => {
  test('the option\'s lines go into run.json, under its sha', async () => {
    const w = await startWorld({ verify: ['true'], trailers: ['Co-Authored-By: A Person <a@example.com>', 'not one'] })
    const r = okReply(await start(w, 'execute'))
    const { text, json } = await runJsonOf(w, r)
    expect(json.trailers).toEqual(['Co-Authored-By: A Person <a@example.com>'])
    const st = runState((await readLedger(w.p, r.runDir, r.run)).records)
    expect(st.start?.runJsonSha256).toBe(await sha256(text))
  })

  test('with none, run.json has no trailers key', async () => {
    const w = await startWorld()
    const r = okReply(await start(w, 'execute'))
    expect('trailers' in (await runJsonOf(w, r)).json).toBe(false)
  })
})

describe('run.start with the stubs', () => {
  test('execute: the args of before, plus the adversary clamp; every gate has no rules; run.json has none', async () => {
    const w = await startWorld()
    const r = okReply(await start(w, 'execute', { runRules: ['keep the public API'] }))
    expect(Object.keys(r.args).sort()).toEqual(
      ['adversary', 'adversaryClamp', 'authorized', 'gates', 'maxAttempts', 'nonce', 'planPath', 'rules', 'run', 'verifyCommand'],
    )
    expect(r.args.rules).toEqual(['For this run (stated by you): keep the public API'])
    expect((r.args.gates as { id: string; rules: unknown }[]).map(g => [g.id, g.rules])).toEqual([
      ['G1', []],
      ['G2', []],
    ])
    expect(r.args.adversaryClamp).toEqual([...READ_ONLY_BASH, 'Bash(true:*)'])
    expect((await runJsonOf(w, r)).json.rules).toEqual([])
  })

  test('fanout: the args of before, plus no verifier rules; no clamp; every task has no rules', async () => {
    const w = await startWorld()
    const r = okReply(await start(w, 'fanout'))
    expect(Object.keys(r.args).sort()).toEqual(['authorized', 'contract', 'mergeOrder', 'nonce', 'rules', 'run', 'tasks', 'verifierRules', 'verifyCommand'])
    expect(r.args.verifierRules).toEqual([])
    expect((r.args.tasks as { id: string; rules: unknown }[]).map(t => [t.id, t.rules])).toEqual([
      ['a', []],
      ['b', []],
      ['r', []],
    ])
  })

  test("an execute run's summary.md has today's Gates table", async () => {
    const w = await startWorld()
    const r = okReply(await start(w, 'execute'))
    const ref: RunRef = { run: r.run, runDir: r.runDir, litterDir: w.litterDir }
    await writeSummary(w.p, ref)
    expect(await w.p.fs.read(summaryPath(r.runDir))).toContain('\n## Gates\n\n| Gate | Landed |\n|---|---|\n| G1 | no |\n| G2 | no |')
  })
})

describe('the adversary clamp', () => {
  test("is fanout.js's read-only list, then the verify command, quoted as args.verifyCommand is, as a prefix", async () => {
    const fanout = readFileSync(join(import.meta.dir, '..', '..', 'workflows', 'fanout.js'), 'utf8')
    const list = /const READ_ONLY_BASH = \[([^\]]*)\]/.exec(fanout)?.[1] ?? ''
    expect([...list.matchAll(/'([^']*)'/g)].map(m => m[1])).toEqual([...READ_ONLY_BASH])

    const w = await startWorld({ verify: ['pytest', 'tests dir', '-k', "it's"] })
    const r = okReply(await start(w, 'execute'))
    expect(r.args.verifyCommand).toBe(`pytest 'tests dir' -k 'it'\\''s'`)
    expect(r.args.adversaryClamp).toEqual([...READ_ONLY_BASH, `Bash(pytest 'tests dir' -k 'it'\\''s':*)`])
  })
})

// ---------------------------------------------------------------------------
// The selection, stood in for (AE's selectForRun)

const SELECTION: Selection = {
  run: ['Keep the public API stable.'],
  gates: { G1: ['G1: a.txt is generated; edit its template.'] },
  tasks: { b: ['b/: one file per handler.'] },
  verifier: ['Run the suite twice.'],
  planner: ['Name each gate after its outcome.'],
  versions: [
    { id: 'public-api', version: 2 },
    { id: 'generated-a', version: 1 },
  ],
}

function standIn(answer: Selection | Error = SELECTION): SelectInput[] {
  const seen: SelectInput[] = []
  lifecycleDeps.selectForRun = async (_p, input) => {
    seen.push(input)
    if (answer instanceof Error) throw answer
    return answer
  }
  return seen
}

describe('run.start with a selection', () => {
  test('execute: the input, then the shared rules after yours, each gate its own, and run.json the versions', async () => {
    const seen = standIn()
    const w = await startWorld()
    const r = okReply(await start(w, 'execute', { runRules: ['keep the public API'] }))
    expect(seen).toEqual([
      {
        litterDir: w.litterDir,
        workflow: 'execute',
        gates: [
          { id: 'G1', files: ['a.txt'] },
          { id: 'G2', files: ['b.txt'] },
        ],
        tasks: [],
        planText: PLAN,
        goal: null,
        anchors: [],
        checkout: w.dir,
        runRules: ['For this run (stated by you): keep the public API'],
      },
    ])
    expect(r.args.rules).toEqual(['For this run (stated by you): keep the public API', 'Keep the public API stable.'])
    expect((r.args.gates as { id: string; rules: unknown }[]).map(g => [g.id, g.rules])).toEqual([
      ['G1', ['G1: a.txt is generated; edit its template.']],
      ['G2', []],
    ])
    expect((await runJsonOf(w, r)).json.rules).toEqual(SELECTION.versions)
  })

  test("fanout: each task's own, and the verifier's", async () => {
    const seen = standIn()
    const w = await startWorld()
    const r = okReply(await start(w, 'fanout'))
    expect(seen[0]).toEqual(expect.objectContaining({ workflow: 'fanout', gates: [], tasks: [{ id: 'a', files: ['a.txt'] }, { id: 'b', files: ['b/'] }, { id: 'r', files: [] }] }))
    expect((r.args.tasks as { id: string; rules: unknown }[]).map(t => [t.id, t.rules])).toEqual([
      ['a', []],
      ['b', ['b/: one file per handler.']],
      ['r', []],
    ])
    expect(r.args.verifierRules).toEqual(['Run the suite twice.'])
    expect(r.args.rules).toEqual(['Keep the public API stable.'])
  })

  test("plan: the planner's rules after yours, and the plan's path beside its text", async () => {
    const seen = standIn()
    const w = await startWorld()
    const r = okReply(await start(w, 'plan', { planPath: 'plan.md', runRules: ['no new deps'] }))
    expect(seen[0]).toEqual(expect.objectContaining({ workflow: 'plan', planText: PLAN, goal: 'add a retry', gates: [], tasks: [] }))
    expect(r.args.rules).toEqual(['For this run (stated by you): no new deps', 'Name each gate after its outcome.'])
    expect(r.args).toEqual(expect.objectContaining({ plan: PLAN, planPath: join(w.dir, 'plan.md') }))
    expect((await runJsonOf(w, r)).json.rules).toEqual(SELECTION.versions)
  })

  test("design: the shared rules after yours", async () => {
    standIn()
    const w = await startWorld({})
    const r = okReply(await start(w, 'design'))
    expect(r.args.rules).toEqual(['Keep the public API stable.'])
  })

  test('a selection that throws refuses the launch, writing nothing', async () => {
    standIn(new Error('two scopes hold the rule public-api'))
    const w = await startWorld()
    for (const workflow of ['execute', 'fanout', 'plan']) {
      const e = asError(await start(w, workflow))
      expect(e.error).toBe(
        "litter: the accepted rules couldn't be selected for this run (two scopes hold the rule public-api); /litter-rules shows them and their problems. Launch again once it's fixed",
      )
    }
    expect(runsIn(w)).toEqual([])
    expect(await readLock(w.p, w.dir)).toBeNull()
    expect((await w.git('for-each-ref', '--format=%(refname)', 'refs/heads/litter', 'refs/litter')).trim()).toBe('')
  })
})

describe("summary.md's execute part", () => {
  test("is AB's executeSummary's lines, given the run's json and records; a throw is logged and the rest stands", async () => {
    const w = await startWorld()
    const r = okReply(await start(w, 'execute'))
    const ref: RunRef = { run: r.run, runDir: r.runDir, litterDir: w.litterDir }
    const seen: { ref: RunRef; json: RunJson | null; kinds: string[] }[] = []
    lifecycleDeps.executeSummary = async (_p, ref2, json, records) => {
      seen.push({ ref: ref2, json, kinds: records.map(x => x.kind) })
      return ['', '## Attempts', '', '- G1: 1']
    }
    await writeSummary(w.p, ref)
    expect(seen).toEqual([{ ref, json: expect.objectContaining({ run: r.run, workflow: 'execute' }), kinds: ['run.start'] }])
    const text = await w.p.fs.read(summaryPath(r.runDir))
    expect(text).toContain('\n## Attempts\n\n- G1: 1')
    expect(text).not.toContain('## Gates')

    lifecycleDeps.executeSummary = async () => {
      throw new Error('verdicts unreadable')
    }
    await writeSummary(w.p, ref)
    expect(w.p.logs).toContain(`run ${r.run}: the summary's execute part failed: verdicts unreadable`)
    expect(await w.p.fs.read(summaryPath(r.runDir))).toContain(`# litter run ${r.run}`)
  })

  test("a fanout's summary doesn't call it", async () => {
    let called = 0
    lifecycleDeps.executeSummary = async () => {
      called++
      return []
    }
    const w = await startWorld()
    const r = okReply(await start(w, 'fanout'))
    await writeSummary(w.p, { run: r.run, runDir: r.runDir, litterDir: w.litterDir })
    expect(called).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// output.ts: a run agent's result, to AB's verdict file and AD's store

describe("a gate critic's output", () => {
  const VERDICT = {
    verify_id: 'vf1',
    plan_adherence: { pass: true, evidence: 'a.ts:3', gaps: [] },
    tests_green: { pass: true, evidence: 'exit 0', gaps: [] },
    no_regressions: { pass: true, evidence: 'ok', gaps: [] },
    rules: { pass: true, evidence: 'none apply', gaps: [] },
    plan_gap: '',
    proposed_rules: ['When a test touches the clock, freeze it.', '', 'Keep fixtures small.'],
  }
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

  function fakes() {
    const files: StoredRecord[] = []
    const proposals: CriticProposal[] = []
    outputDeps.writeVerdictFile = async (_p, _dir, rec) => void files.push(rec)
    outputDeps.proposeFromCritic = async (_p, _litterDir, input) => void proposals.push(input)
    return { files, proposals }
  }

  test('records its verdict, writes its file once with that record, and proposes each rule with the cited gate and verify', async () => {
    const w = await toolWorld()
    const { files, proposals } = fakes()
    await appendRecord(w.p, runDir(w.dir, RUN), { run: RUN, kind: 'verify', by: { source: 'mod' }, body: { verify_id: 'vf1', gate: 'G2', attempt: 1 } })
    await startAgent(w, 'gc', 'litter:gate-critic')
    const ctx = { p: w.p, litterDir: w.dir, sessionId: 'test-session' }
    await consumeOutput(ctx, output('gc', 'litter:gate-critic', VERDICT))
    const recs = (await readLedger(w.p, runDir(w.dir, RUN), RUN)).records
    expect(recs.map(r => r.kind)).toEqual(['verify', 'verdict'])
    expect(files).toEqual([recs[1]!])
    const by = { source: 'agent', agentId: 'gc', agentType: 'litter:gate-critic' } as const
    expect(proposals).toEqual([
      { run: RUN, rule: VERDICT.proposed_rules[0]!, source: 'critic', by, index: 0, tool_use_id: 'tu1', gate: 'G2', verify_id: 'vf1' },
      { run: RUN, rule: VERDICT.proposed_rules[2]!, source: 'critic', by, index: 2, tool_use_id: 'tu1', gate: 'G2', verify_id: 'vf1' },
    ])
    // Drained again: no second verdict and no second file; the store dedupes the proposals itself.
    await consumeOutput(ctx, output('gc', 'litter:gate-critic', VERDICT))
    expect(files).toHaveLength(1)
    expect((await readLedger(w.p, runDir(w.dir, RUN), RUN)).records).toHaveLength(2)
  })

  test("a verdict citing no verify the ledger holds proposes with neither gate nor verify_id", async () => {
    const w = await toolWorld()
    const { proposals } = fakes()
    await startAgent(w, 'gc', 'litter:gate-critic')
    await consumeOutput({ p: w.p, litterDir: w.dir, sessionId: 'test-session' }, output('gc', 'litter:gate-critic', { ...VERDICT, proposed_rules: ['One.'] }))
    expect(proposals).toEqual([expect.objectContaining({ rule: 'One.', index: 0, tool_use_id: 'tu1' })])
    expect('gate' in proposals[0]! || 'verify_id' in proposals[0]!).toBe(false)
  })

  test("a verifier's result writes no verdict file and proposes nothing", async () => {
    const w = await toolWorld()
    const { files, proposals } = fakes()
    await startAgent(w, 'vr', 'litter:verifier')
    await consumeOutput({ p: w.p, litterDir: w.dir, sessionId: 'test-session' }, output('vr', 'litter:verifier', { verify_id: 'vf9', pass: true, proposed_rules: ['x'] }))
    expect((await readLedger(w.p, runDir(w.dir, RUN), RUN)).records.map(r => r.kind)).toEqual(['verdict'])
    expect(files).toEqual([])
    expect(proposals).toEqual([])
  })

  test('a verdict file or a proposal that fails is logged; the verdict stands and the other proposals go on', async () => {
    const w = await toolWorld()
    const proposals: string[] = []
    outputDeps.writeVerdictFile = async () => {
      throw new Error('disk full')
    }
    outputDeps.proposeFromCritic = async (_p, _l, input) => {
      if (input.index === 0) throw new Error('rules ledger tampered')
      proposals.push(input.rule)
    }
    await startAgent(w, 'gc', 'litter:gate-critic')
    await consumeOutput({ p: w.p, litterDir: w.dir, sessionId: 'test-session' }, output('gc', 'litter:gate-critic', VERDICT))
    const recs = (await readLedger(w.p, runDir(w.dir, RUN), RUN)).records
    expect(recs.map(r => r.kind)).toEqual(['verdict'])
    expect(w.p.logs).toContain(`verdict ${RUN} seq ${recs[0]!.seq}: its file wasn't written: disk full`)
    expect(w.p.logs).toContain("output tu1: proposed rule 0 wasn't recorded: rules ledger tampered")
    expect(proposals).toEqual(['Keep fixtures small.'])
  })
})

// ---------------------------------------------------------------------------
// verify.ts and land.ts: AB's in-flight flag; land.ts's trailers and landGate

const LAND_RUN = '20261003-land'
const LAND_REF = `refs/heads/litter/${LAND_RUN}`
const CRITIC: Caller = { agentId: 'critic-1', agentType: 'litter:gate-critic' }
const EXECUTOR: Caller = { agentId: 'executor-1', agentType: 'litter:executor' }
const RELAY: Caller = { agentId: 'relay-1', agentType: 'litter:relay' }
const PASS = { pass: true, evidence: 'checked', gaps: [] as string[] }

type LandWorld = { p: TestPorts; dir: string; litterDir: string; runDir: string; git: (...argv: string[]) => Promise<string>; ctx: (c: Caller) => RecordCtx }

/** land.spec.ts's world: a branch for the run, run.json as run.start writes it, the litter directory outside the repo. */
async function landWorld(patch: Record<string, unknown> = {}): Promise<LandWorld> {
  const p = nodePorts()
  const repo = scratch()
  const out = scratch()
  cleanups.push(repo.cleanup, out.cleanup)
  const dir = repo.dir
  const { git } = await scratchRepo(p, dir)
  const base = (await git('rev-parse', 'HEAD')).trim()
  await git('switch', '-q', '-c', `litter/${LAND_RUN}`)
  const litterDir = join(out.dir, '.claude', 'litter')
  const rd = join(litterDir, LAND_RUN)
  const json = {
    v: 1,
    run: LAND_RUN,
    workflow: 'execute',
    args: { gates: [{ id: 'G1', title: 'Add the parser', lines: { start: 3, end: 9 } }], planPath: join(rd, 'plan.md') },
    authorized: [],
    mode: 'auto',
    verify: ['true'],
    goalCheck: null,
    setup: null,
    base,
    ref: LAND_REF,
    checkout: dir,
    previousBranch: 'main',
    continueOf: null,
    amendOf: null,
    rules: [],
    planSha256: null,
    linkDirs: [],
    isolate: false,
    planPath: null,
    session: 'test-session',
    created: 0,
    ...patch,
  }
  await p.fs.write(join(rd, 'run.json'), JSON.stringify(json))
  return { p, dir, litterDir, runDir: rd, git, ctx: caller => ({ p, caller, litterDir, options: normalizeOptions({}) }) }
}

async function verifiedAndApproved(w: LandWorld): Promise<string> {
  await w.p.fs.write(join(w.dir, 'src', 'parser.ts'), 'export const parse = (s: string) => s.split(",")\n')
  const v = (await recordVerify(w.ctx(CRITIC), { kind: 'verify', run: LAND_RUN, gate: 'G1', attempt: 1 })) as VerifyReply
  expect(v.ok && v.green).toBe(true)
  await appendRecord(w.p, w.runDir, {
    run: LAND_RUN,
    kind: 'verdict',
    by: { source: 'agent', agentId: CRITIC.agentId!, agentType: CRITIC.agentType },
    body: { verify_id: v.verify_id, plan_adherence: PASS, tests_green: PASS, no_regressions: PASS, rules: PASS, plan_gap: '', proposed_rules: [] },
  })
  return v.verify_id
}

describe("verify: AB's critique flag", () => {
  test("a gate critic's verify of an execute run marks the critique first; another role's doesn't", async () => {
    const w = await landWorld()
    const marks: unknown[][] = []
    verifyDeps.markCritique = async (...a) => void marks.push(a.slice(1))
    await w.p.fs.write(join(w.dir, 'a.txt'), 'a\n')
    expect((await recordVerify(w.ctx(CRITIC), { kind: 'verify', run: LAND_RUN, gate: 'G1', attempt: 1 })).ok).toBe(true)
    expect(marks).toEqual([[w.litterDir, LAND_RUN, 'critic-1']])
    expect((await recordVerify(w.ctx(EXECUTOR), { kind: 'verify', run: LAND_RUN, gate: 'G1', attempt: 1 })).ok).toBe(true)
    expect(marks).toHaveLength(1)
  })

  test('a mark that throws fails the verify before the suite runs, recording nothing', async () => {
    const w = await landWorld()
    verifyDeps.markCritique = async () => {
      throw new Error('policy.json is locked')
    }
    await expect(recordVerify(w.ctx(CRITIC), { kind: 'verify', run: LAND_RUN, gate: 'G1', attempt: 1 })).rejects.toThrow('policy.json is locked')
    expect((await readLedger(w.p, w.runDir, LAND_RUN)).records).toEqual([])
  })
})

describe('land: the trailers, the in-flight flag and landGate', () => {
  test("run.json's trailers end the commit message's trailer paragraph, after Litter-Run", async () => {
    const w = await landWorld({ trailers: ['Co-Authored-By: A Person <a@example.com>', 'Signed-off-by: B <b@example.com>'] })
    const verifyId = await verifiedAndApproved(w)
    const r = (await recordLand(w.ctx(RELAY), { kind: 'land', run: LAND_RUN, gate: 'G1', verify_id: verifyId })) as LandReply
    if (!r.ok || !r.landed) throw new Error(`not landed: ${JSON.stringify(r)}`)
    expect(await w.git('log', '-1', '--format=%B', r.commit)).toBe(
      `G1: Add the parser\n\nRefs: .claude/litter/${LAND_RUN}/plan.md:3-9\nLitter-Run: ${LAND_RUN} G1 ${verifyId}\n` +
        'Co-Authored-By: A Person <a@example.com>\nSigned-off-by: B <b@example.com>\n\n',
    )
    expect((await w.git('log', '-1', '--format=%(trailers:key=Co-Authored-By,valueonly)', r.commit)).trim()).toBe('A Person <a@example.com>')
  })

  test('recordLand runs the land inside withInflight, for its run, as land', async () => {
    const w = await landWorld()
    const verifyId = await verifiedAndApproved(w)
    const seen: { litterDir: string; run: string; what: string; tipBefore: string; landed: boolean }[] = []
    landDeps.withInflight = (async (_p: unknown, litterDir: string, run: string, what: 'land', fn: () => Promise<unknown>) => {
      const tipBefore = (await w.git('rev-parse', LAND_REF)).trim()
      const out = (await fn()) as LandReply
      seen.push({ litterDir, run, what, tipBefore, landed: out.ok && out.landed })
      return out
    }) as typeof landDeps.withInflight
    const base = (await w.git('rev-parse', LAND_REF)).trim()
    const r = (await recordLand(w.ctx(RELAY), { kind: 'land', run: LAND_RUN, gate: 'G1', verify_id: verifyId })) as LandReply
    expect(r.ok && r.landed).toBe(true)
    expect(seen).toEqual([{ litterDir: w.litterDir, run: LAND_RUN, what: 'land', tipBefore: base, landed: true }])
  })

  test('landGate with observe false lands and writes no out file; recordLand writes the relay\'s', async () => {
    const w = await landWorld()
    const verifyId = await verifiedAndApproved(w)
    const json = JSON.parse(await w.p.fs.read(join(w.runDir, 'run.json'))) as RunJson
    const r = (await landGate(w.ctx(RELAY), { run: LAND_RUN, runDir: w.runDir, json }, 'G1', verifyId, { observe: false })) as LandReply
    expect(r.ok && r.landed).toBe(true)
    expect(existsSync(outPath(w.litterDir, 'relay-1'))).toBe(false)
    // The same land again through recordLand answers the first land and observes it.
    const again = (await recordLand(w.ctx(RELAY), { kind: 'land', run: LAND_RUN, gate: 'G1', verify_id: verifyId })) as LandReply
    expect(again).toEqual(r)
    expect(JSON.parse(readFileSync(outPath(w.litterDir, 'relay-1'), 'utf8')).for).toEqual({ land_of: verifyId })
  })
})

// ---------------------------------------------------------------------------
// swarm/gate.ts: a repair swarm critic's proposals, to AD's store

describe("a repair swarm critic's proposals", () => {
  let rw: RepairWorld | null = null
  beforeEach(async () => {
    rw = await repairWorld()
    useStandIn()
  })
  afterEach(() => {
    teardown(rw)
    rw = null
  })

  test('each goes to proposeFromCritic with the run, swarm, verify, round and index; one that fails is logged and not counted', async () => {
    const proposals: CriticProposal[] = []
    gateDeps.proposeFromCritic = async (_p, _litterDir, input) => {
      if (input.index === 1) throw new Error('rules ledger tampered')
      proposals.push(input)
    }
    const v = await criticVerifies(rw!)
    const r = await judge(rw!, v.verify_id, B_FAILS, 'crit-1', { proposed_rules: ['Call the server through its typed client.', 'Bad one.', 'Pin the port.'] })
    expect(r).toEqual(expect.objectContaining({ ok: true, proposed_rules: 2 }))
    const by = { source: 'agent', agentId: 'crit-1', agentType: typeOf('critic') } as const
    const common = { run: REPAIR_RUN, source: 'critic', by, swarm: SWARM, verify_id: v.verify_id, round: 1 } as const
    expect(proposals).toEqual([
      { ...common, rule: 'Call the server through its typed client.', index: 0 },
      { ...common, rule: 'Pin the port.', index: 2 },
    ])
    expect(rw!.p.logs.some(l => l.includes(`a proposed rule from the verdict on ${v.verify_id} wasn't recorded: rules ledger tampered`))).toBe(true)
  })
})
