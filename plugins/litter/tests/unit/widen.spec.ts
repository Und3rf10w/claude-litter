// Tier 2: WP-AO, files added to a gate's Files. widen.ts's helpers; gate.widen
// (plan.ts), asked in the mod's own dialog and written into the run's plan.md
// and the chain root's; run.start's `widen` and `widenings`, asked before the
// run is made; what policy.json carries for the guard's note to a gate's
// executors (A8), checked against the run fields tier 3's guard cases read
// (tests/hooks/fixtures/widened.run.json). Real git in scratch repos, as
// plan.spec.ts.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordCtx, RecordError, RecordInput, RecordReply } from '../../hooks/records/core'
import type { RunJson, RunStartReply } from '../../hooks/records/run'
import { endRun, patchRunPolicy, recordRunStart } from '../../hooks/lifecycle'
import { consumeAgents, readPolicy } from '../../hooks/policy'
import { stopLease } from '../../hooks/lock'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { modePath, planPath, planVersionPath, policyPath, runJsonPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { parseGates } from '../../hooks/gates'
import type { VerifyReply } from '../../hooks/records/execute'
import { recordGateWiden } from '../../hooks/plan'
import { recordVerify } from '../../hooks/verify'
import {
  ADDED_NOTE,
  addedAfterLaunch,
  applyWidening,
  consumeExecutorGate,
  covers,
  dateOf,
  noteWidening,
  outsideOf,
  parseWidened,
  parseWidening,
  runGateFiles,
  widenNote,
  widenOf,
  widenPathError,
} from '../../hooks/widen'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const PLAN = [
  '# Plan',
  '',
  'Two files.',
  '',
  '### G1: First',
  'Files: a.txt',
  'Checks: test -f a.txt',
  'Done when: a.txt exists',
  '',
  'Create a.txt.',
  '',
  '### G2: Second',
  'Files: b.txt',
  'Checks: test -f b.txt',
  'Done when: b.txt exists',
  '',
].join('\n')

const DATE = '2026-10-04'
const ADD = 'Add them'
const KEEP = (gate: string) => `Keep ${gate} as written`

const asOk = (r: RecordReply) => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r)}`)
  return r as RecordReply & Record<string, unknown>
}
const asError = (r: RecordReply) => {
  expect(r.ok).toBe(false)
  return r as RecordError
}

// ---------------------------------------------------------------------------
// The helpers

describe('covers', () => {
  test('a path, a folder above it with or without its slash, or a glob that matches it', () => {
    expect(covers(['src/a.ts'], 'src/a.ts')).toBe(true)
    expect(covers(['./src/a.ts'], 'src/a.ts')).toBe(true)
    expect(covers(['src/'], 'src/deep/a.ts')).toBe(true)
    expect(covers(['src'], 'src/a.ts')).toBe(true)
    expect(covers(['src/**/*.ts'], 'src/deep/a.ts')).toBe(true)
    expect(covers(['src/a.ts'], 'src/a.tsx')).toBe(false)
    expect(covers(['src'], 'srcs/a.ts')).toBe(false)
    expect(covers([], 'a')).toBe(false)
  })
})

describe('widenPathError', () => {
  test('takes repository-relative paths and folders, and refuses what a Files line or the snapshot cannot hold', () => {
    expect(widenPathError('src/a.ts')).toBeNull()
    expect(widenPathError('lib/')).toBeNull()
    for (const bad of ['', ' a', '/etc/x', '~/x', 'C:/x', 'a\\b', 'a,b', 'a`b', 'a\nb', '../x', 'a/./b', 'src/*.ts', '.claude/litter/x', '.claude']) {
      expect({ bad, error: widenPathError(bad) === null }).toEqual({ bad, error: false })
    }
  })
})

describe('parseWidening', () => {
  test('a gate id, the paths deduplicated, and the why on one line without backticks', () => {
    const r = parseWidening({ gate: 'G2', files: ['gen.sh', 'gen.sh', 'lib/'], why: '  b.txt is\n`generated`  ' }, 'widenings[0]')
    expect(r).toEqual({ ok: true, value: { gate: 'G2', files: ['gen.sh', 'lib/'], why: "b.txt is 'generated'" } })
  })

  test('each refusal names its field', () => {
    const field = (v: unknown) => (parseWidening(v, 'widenings[1]') as RecordError).field
    expect(field('G2')).toBe('widenings[1]')
    expect(field({ gate: 'g2', files: ['a'], why: 'w' })).toBe('widenings[1].gate')
    expect(field({ gate: 'G2', files: [], why: 'w' })).toBe('widenings[1].files')
    expect(field({ gate: 'G2', files: Array.from({ length: 21 }, (_, i) => `f${i}`), why: 'w' })).toBe('widenings[1].files')
    expect(field({ gate: 'G2', files: ['ok', '../no'], why: 'w' })).toBe('widenings[1].files[1]')
    expect(field({ gate: 'G2', files: ['a'], why: ' ' })).toBe('widenings[1].why')
    expect((parseWidening({ gate: 'G2', files: ['a'] }, '') as RecordError).field).toBe('why')
  })
})

describe('applyWidening', () => {
  test("adds the files to the inline Files line and a note at the section's end, and the plan reads back to the same gates", () => {
    const r = applyWidening(PLAN, { gate: 'G2', files: ['gen.sh', 'lib/'], why: 'b.txt is generated' }, DATE)
    if (!r.ok) throw new Error(r.error)
    expect(r.added).toEqual(['gen.sh', 'lib/'])
    expect(r.text).toBe(
      PLAN.replace('Files: b.txt', 'Files: b.txt, gen.sh, lib/').replace(
        'Done when: b.txt exists\n',
        `Done when: b.txt exists\n\n${widenNote(['gen.sh', 'lib/'], 'b.txt is generated', DATE)}\n`,
      ),
    )
    expect(widenNote(['gen.sh'], 'w', DATE)).toBe(`Added to Files for this run by you, through litter (${DATE}): gen.sh. Why: w`)
    const back = parseGates(r.text)
    if (!back.ok) throw new Error(back.error)
    expect(back.gates.map(g => g.files)).toEqual([['a.txt'], ['b.txt', 'gen.sh', 'lib/']])
  })

  test("a middle gate's note goes after its prose, before the blank line that ends it", () => {
    const r = applyWidening(PLAN, { gate: 'G1', files: ['a2.txt'], why: 'w' }, DATE)
    if (!r.ok) throw new Error(r.error)
    expect(r.text).toBe(PLAN.replace('Files: a.txt', 'Files: a.txt, a2.txt').replace('Create a.txt.\n', `Create a.txt.\n\n${widenNote(['a2.txt'], 'w', DATE)}\n`))
  })

  test('a Files list takes the files as items, in its own bullet style', () => {
    const plan = '### G1: Listed\nFiles:\n* a.txt\n* b.txt\nChecks: true\nDone when: done\n'
    const r = applyWidening(plan, { gate: 'G1', files: ['c,d.txt'], why: 'w' }, DATE)
    if (!r.ok) throw new Error(r.error)
    expect(r.text).toBe(`### G1: Listed\nFiles:\n* a.txt\n* b.txt\n* c,d.txt\nChecks: true\nDone when: done\n\n${widenNote(['c,d.txt'], 'w', DATE)}\n`)
  })

  test('CRLF lines keep their line ends', () => {
    const plan = PLAN.replace(/\n/g, '\r\n')
    const r = applyWidening(plan, { gate: 'G2', files: ['gen.sh'], why: 'w' }, DATE)
    if (!r.ok) throw new Error(r.error)
    expect(r.text).toBe(plan.replace('Files: b.txt', 'Files: b.txt, gen.sh').replace('Done when: b.txt exists\r\n', `Done when: b.txt exists\r\n\r\n${widenNote(['gen.sh'], 'w', DATE)}\r\n`))
  })

  test("files the gate already covers are skipped; with none left the text comes back as it was", () => {
    const r = applyWidening(PLAN, { gate: 'G2', files: ['b.txt', './b.txt'], why: 'w' }, DATE)
    expect(r).toEqual({ ok: true, text: PLAN, added: [] })
  })

  test("an unknown gate, or a plan that doesn't parse, is refused", () => {
    expect(applyWidening(PLAN, { gate: 'G9', files: ['x'], why: 'w' }, DATE)).toEqual({ ok: false, error: 'the plan has no gate G9; its gates are G1, G2' })
    const r = applyWidening('### G1: x\nChecks: true\nDone when: y\n', { gate: 'G1', files: ['x'], why: 'w' }, DATE)
    expect(r.ok).toBe(false)
  })
})

describe('parseWidened, widenOf, runGateFiles, outsideOf', () => {
  test("a verdict's widened: [] when left out, each file checked and its why required", () => {
    expect(parseWidened(undefined)).toEqual({ ok: true, value: [] })
    expect(parseWidened([{ file: 'gen.sh', why: ' needed\n' }])).toEqual({ ok: true, value: [{ file: 'gen.sh', why: 'needed' }] })
    expect((parseWidened('gen.sh') as RecordError).field).toBe('widened')
    expect((parseWidened([{ file: '/abs', why: 'w' }]) as RecordError).field).toBe('widened[0].file')
    expect((parseWidened([{ file: 'a' }]) as RecordError).field).toBe('widened[0].why')
  })

  test("a run.json without widen is ask", () => {
    expect(widenOf({})).toBe('ask')
    expect(widenOf(null)).toBe('ask')
    expect(widenOf({ widen: 'critic' })).toBe('critic')
  })

  test("a gate's Files as the run has them: its args', then your widenings during the run", () => {
    const json = { args: { gates: [{ id: 'G1', files: ['a.txt'] }, { id: 'G2', files: ['b.txt'] }] } }
    const records = [
      { seq: 1, kind: 'gate.widen', body: { gate: 'G2', files: ['gen.sh'], by: 'you', at: 'run' } },
      { seq: 2, kind: 'gate.widen', body: { gate: 'G2', files: ['x.sh'], by: 'critic', at: 'land' } },
    ] as never
    expect(runGateFiles(json, records, 'G2')).toEqual(['b.txt', 'gen.sh'])
    expect(runGateFiles(json, records, 'G9')).toEqual([])
  })

  test("the changed paths no entry covers, without litter's own, sorted", () => {
    expect(outsideOf(['src/'], ['z.md', 'src/a.ts', '', '.claude/litter/x', 'b.md', 'b.md'])).toEqual(['b.md', 'z.md'])
  })
})

// ---------------------------------------------------------------------------
// gate.widen and run.start, against real git

type World = { p: TestPorts; dir: string; litterDir: string; git: (...argv: string[]) => Promise<string>; ctx: RecordCtx }

const cleanups: (() => void)[] = []
afterEach(() => {
  stopLease()
  for (const c of cleanups.splice(0)) c()
})

async function world(options: Record<string, unknown> = {}): Promise<World> {
  const s = scratch()
  cleanups.push(s.cleanup)
  const dir = realpathSync(s.dir)
  const base = nodePorts({ sessionId: 'session-a' })
  const p: TestPorts = {
    ...base,
    cwd: async () => dir,
    run: (argv, init) => {
      if (argv[0] === 'jq') return Promise.resolve({ code: 0, stdout: 'jq-1.7.1\n', stderr: '', truncated: false })
      return base.run(argv, init?.cwd ? init : { ...init, cwd: dir })
    },
  }
  const { git } = await scratchRepo(p, dir)
  await p.fs.write(join(dir, 'plan.md'), PLAN)
  await git('add', 'plan.md')
  await git('commit', '-q', '-m', 'plan')
  const litterDir = join(dir, '.claude', 'litter')
  await p.fs.write(modePath(litterDir), 'default\n')
  return { p, dir, litterDir, git, ctx: { p, caller: { agentId: null, agentType: null }, litterDir, options: normalizeOptions({ verify: ['true'], ...options }) } }
}

const AUTH = { authorized: ['change a.txt and b.txt'] }
const startRaw = (w: World, fields: Record<string, unknown>) => recordRunStart(w.ctx, { kind: 'run.start', ...AUTH, ...fields } as RecordInput)
const start = async (w: World, fields: Record<string, unknown>): Promise<RunStartReply> => {
  const r = await startRaw(w, fields)
  if (!(r as { ok: boolean }).ok) throw new Error(`run.start refused: ${JSON.stringify(r)}`)
  return r as RunStartReply
}
const end = (w: World, r: { run: string; runDir: string }, status: 'done' | 'halted', reason: string | null) =>
  endRun(w.p, { run: r.run, runDir: r.runDir, litterDir: w.litterDir }, { taskId: null, generation: 0, status, reason, source: 'mod' })
const widen = (w: World, fields: Record<string, unknown>) => recordGateWiden(w.ctx, { kind: 'gate.widen', ...fields } as RecordInput)
const gatesOf = (r: RunStartReply) => r.args.gates as { id: string; files: string[]; excerpt: string }[]
const today = () => dateOf(Date.now())
const widenings = async (w: World, runDir: string, run: string) => (await readLedger(w.p, runDir, run)).records.filter(r => r.kind === 'gate.widen')

/** An execute run of plan.md that halted at G1. */
async function halted(w: World): Promise<RunStartReply> {
  const first = await start(w, { workflow: 'execute', planPath: 'plan.md' })
  await end(w, first, 'halted', 'G2 plan gap: b.txt has to be generated by gen.sh')
  return first
}

describe('gate.widen', () => {
  test("asks you in the mod's dialog, then adds the files to the run's plan.md with the note, keeping the old one, and records it", async () => {
    const w = await world()
    const first = await halted(w)
    w.p.answers.push(ADD)
    const r = asOk(await widen(w, { run: first.run, gate: 'G2', files: ['gen.sh'], why: 'b.txt is generated by gen.sh' }))
    expect(r).toEqual(expect.objectContaining({ kind: 'gate.widen', gate: 'G2', added: ['gen.sh'], plans: [planPath(first.runDir)] }))
    expect(w.p.asked).toHaveLength(1)
    expect(w.p.asked[0]!.options).toEqual([KEEP('G2'), ADD])
    expect(w.p.asked[0]!.question).toContain('Gate G2 ("Second")')
    expect(w.p.asked[0]!.question).toContain('covers these files: b.txt.')
    expect(w.p.asked[0]!.question).toContain('  gen.sh')
    expect(w.p.asked[0]!.question).toContain('Why, as the request puts it: b.txt is generated by gen.sh')
    expect(w.p.asked[0]!.question.trimEnd().endsWith('?')).toBe(true)
    // During a run, the dialog says the critic is told at its next verify (WP-AP).
    expect(w.p.asked[0]!.question).toContain("from its critic's next verify, where litter tells the critic of them")
    // And that an executor at work on it is told at its next tool call (A8).
    expect(w.p.asked[0]!.question).toContain('an executor at work on it is told at its next tool call')
    expect(r.applies).toContain("In a running execute workflow, the gate's executor is told at its next tool call.")
    // The run halted, so no executor is at work on it, and policy.json has no run to note it in.
    expect((await readPolicy(w.p, w.litterDir))?.run ?? null).toBeNull()
    const text = readFileSync(planPath(first.runDir), 'utf8')
    expect(text).toContain('Files: b.txt, gen.sh\n')
    expect(text).toContain(widenNote(['gen.sh'], 'b.txt is generated by gen.sh', today()))
    expect(readFileSync(planVersionPath(first.runDir, 1), 'utf8')).toBe(PLAN)
    const recs = await widenings(w, first.runDir, first.run)
    expect(recs.map(x => x.body)).toEqual([{ gate: 'G2', files: ['gen.sh'], why: 'b.txt is generated by gen.sh', by: 'you', at: 'run', plans: [planPath(first.runDir)] }])
    expect(recs[0]!.by).toEqual({ source: 'launcher' })

    // The chain's next run takes the gate as widened.
    const next = await start(w, { workflow: 'execute', continueOf: first.run })
    const g2 = gatesOf(next).find(g => g.id === 'G2')!
    expect(g2.files).toEqual(['b.txt', 'gen.sh'])
    expect(g2.excerpt).toContain('Added to Files for this run by you, through litter')
  })

  test("in a live run, the gate's next verify tells its critic of the files you added, and no other gate's does (WP-AP)", async () => {
    const w = await world()
    w.p.answers.push(ADD)
    const live = await start(w, { workflow: 'execute', planPath: 'plan.md', widenings: [{ gate: 'G1', files: ['a2.txt'], why: 'at launch' }] })
    w.p.answers.push(ADD)
    asOk(await widen(w, { run: live.run, gate: 'G2', files: ['gen.sh'], why: 'b.txt is generated by gen.sh' }))
    const verify = (gate: string) => recordVerify(w.ctx, { kind: 'verify', run: live.run, gate, attempt: 1 } as RecordInput)
    const g2 = asOk(await verify('G2')) as unknown as VerifyReply
    expect(g2.added).toEqual([{ files: ['gen.sh'], why: 'b.txt is generated by gen.sh' }])
    expect(g2.added_note).toBe(ADDED_NOTE)
    // G1's launch widening is in its <gate> already, so its verify adds nothing.
    const g1 = asOk(await verify('G1')) as unknown as VerifyReply
    expect(g1.added).toBeUndefined()
    expect(g1.added_note).toBeUndefined()
    expect(addedAfterLaunch((await readLedger(w.p, live.runDir, live.run)).records, 'G1')).toEqual([])
  })

  test('your "keep it" refuses it, and no one to ask refuses it too; nothing is written either way', async () => {
    const w = await world()
    const first = await halted(w)
    w.p.answers.push(KEEP('G2'))
    const kept = asError(await widen(w, { run: first.run, gate: 'G2', files: ['gen.sh'], why: 'w' }))
    expect(kept.error).toContain('you kept G2 as written')
    const unasked = asError(await widen(w, { run: first.run, gate: 'G2', files: ['gen.sh'], why: 'w' }))
    expect(unasked.error).toContain('no one could be asked to widen G2')
    expect(readFileSync(planPath(first.runDir), 'utf8')).toBe(PLAN)
    expect(existsSync(planVersionPath(first.runDir, 1))).toBe(false)
    expect(await widenings(w, first.runDir, first.run)).toEqual([])
  })

  test('files the gate already covers ask nothing and record nothing', async () => {
    const w = await world()
    const first = await halted(w)
    const r = asOk(await widen(w, { run: first.run, gate: 'G2', files: ['b.txt'], why: 'w' }))
    expect(r.added).toEqual([])
    expect(w.p.asked).toEqual([])
    expect(await widenings(w, first.runDir, first.run)).toEqual([])
  })

  test("a landed gate, an unknown gate, a bad path and a run that isn't execute are refused before anyone is asked", async () => {
    const w = await world()
    const first = await start(w, { workflow: 'execute', planPath: 'plan.md' })
    await appendRecord(w.p, first.runDir, { run: first.run, kind: 'land', by: { source: 'mod' }, body: { gate: 'G1', commit: 'c0ffee' } })
    await end(w, first, 'halted', 'G2 plan gap')
    expect(asError(await widen(w, { run: first.run, gate: 'G1', files: ['x'], why: 'w' })).error).toContain('G1 has landed')
    const unknown = asError(await widen(w, { run: first.run, gate: 'G7', files: ['x'], why: 'w' }))
    expect(unknown.allowed).toEqual(['G1', 'G2'])
    expect(asError(await widen(w, { run: first.run, gate: 'G2', files: ['../x'], why: 'w' })).field).toBe('files[0]')
    expect(asError(await widen(w, { run: first.run, gate: 'G2', files: ['x'] })).field).toBe('why')
    expect(w.p.asked).toEqual([])
  })

  test("in a continuation it writes the run's copy and the chain root's, so the chain's next run keeps the files", async () => {
    const w = await world()
    const first = await halted(w)
    const second = await start(w, { workflow: 'execute', continueOf: first.run })
    await end(w, second, 'halted', 'G2 plan gap again')
    w.p.answers.push(ADD)
    const r = asOk(await widen(w, { run: second.run, gate: 'G2', files: ['gen.sh'], why: 'w' }))
    expect(r.plans).toEqual([planPath(second.runDir), planPath(first.runDir)])
    for (const dir of [second.runDir, first.runDir]) expect(readFileSync(planPath(dir), 'utf8')).toContain('Files: b.txt, gen.sh\n')
    const third = await start(w, { workflow: 'execute', continueOf: second.run })
    expect(gatesOf(third).find(g => g.id === 'G2')!.files).toEqual(['b.txt', 'gen.sh'])
  })
})

// ---------------------------------------------------------------------------
// The guard's note to a gate's executors (A8): policy.json's run.widened and
// run.executors, which guard.sh reads

const FIXTURES = join(import.meta.dir, '..', 'hooks', 'fixtures')
const startLine = (w: World, agent: string, type: string) =>
  ({ v: 1, ev: 'start', ts: 1_700_000_000, session_id: 'session-a', agent_id: agent, agent_type: type, cwd: w.dir, transcript_path: '/t' }) as never
/** An agent's start line through consumeAgents, then consumeExecutorGate, in registry.ts's order. */
async function started(w: World, agent: string, type = 'litter:executor') {
  const ctx = { p: w.p, litterDir: w.litterDir, sessionId: 'session-a' }
  await consumeAgents(ctx, startLine(w, agent, type))
  await consumeExecutorGate(ctx, startLine(w, agent, type))
}
const runPolicy = async (w: World) => (await readPolicy(w.p, w.litterDir))?.run
const landed = (w: World, r: RunStartReply, gate: string) =>
  appendRecord(w.p, r.runDir, { run: r.run, kind: 'land', by: { source: 'mod' }, body: { gate, commit: 'c0ffee' } })

describe("the guard's note to a gate's executors (A8)", () => {
  test("your widening in a live run goes into policy.json in order, and each executor's gate is the first with no land", async () => {
    const w = await world()
    const live = await start(w, { workflow: 'execute', planPath: 'plan.md' })
    expect((await runPolicy(w))?.widened).toBeUndefined()
    await started(w, 'x1')
    expect((await runPolicy(w))?.executors).toEqual({ x1: 'G1' })
    await landed(w, live, 'G1')
    w.p.answers.push(ADD)
    asOk(await widen(w, { run: live.run, gate: 'G2', files: ['gen.sh', 'lib/'], why: 'b.txt is generated by gen.sh' }))
    await started(w, 'a1')
    // The fields tier 3's guard cases are given (guard.test.sh, setup_widened), with the record's own seq.
    const r = (await runPolicy(w))!
    const fixture = JSON.parse(readFileSync(join(FIXTURES, 'widened.run.json'), 'utf8')) as Required<Pick<typeof r, 'widened' | 'executors'>>
    const [first] = await widenings(w, live.runDir, live.run)
    expect({ widened: r.widened, executors: r.executors }).toEqual({
      widened: fixture.widened.map(x => ({ ...x, seq: first!.seq })),
      executors: { x1: 'G1', ...fixture.executors },
    })
    w.p.answers.push(ADD)
    asOk(await widen(w, { run: live.run, gate: 'G2', files: ['gen2.sh'], why: 'and gen2.sh' }))
    const second = (await widenings(w, live.runDir, live.run))[1]!
    expect(second.seq).toBeGreaterThan(first!.seq)
    expect((await runPolicy(w))?.widened).toEqual([...r.widened!, { seq: second.seq, gate: 'G2', files: ['gen2.sh'], why: 'and gen2.sh' }])
  })

  test("a launch widening isn't noted, being in the gates already, and files the gate covers note nothing", async () => {
    const w = await world()
    w.p.answers.push(ADD)
    const live = await start(w, { workflow: 'execute', planPath: 'plan.md', widenings: [{ gate: 'G1', files: ['a2.txt'], why: 'at launch' }] })
    asOk(await widen(w, { run: live.run, gate: 'G2', files: ['b.txt'], why: 'w' }))
    expect((await runPolicy(w))?.widened).toBeUndefined()
  })

  test("an executor already mapped keeps its gate; a critic, an executor the agent map gives no run or another, or one in a run that isn't execute, isn't mapped", async () => {
    const w = await world()
    // x9's start was taken before the run was active, so the agent map gives it no run, and its next start keeps that.
    await consumeAgents({ p: w.p, litterDir: w.litterDir, sessionId: 'session-a' }, startLine(w, 'x9', 'litter:executor'))
    const live = await start(w, { workflow: 'execute', planPath: 'plan.md' })
    await started(w, 'x9')
    expect((await runPolicy(w))?.executors).toBeUndefined()
    await started(w, 'x1')
    await started(w, 'c1', 'litter:gate-critic')
    await landed(w, live, 'G1')
    await started(w, 'x1')
    expect((await runPolicy(w))?.executors).toEqual({ x1: 'G1' })
    await patchRunPolicy(w.p, w.litterDir, live.run, x => ({ ...x, workflow: 'fanout', executors: undefined }))
    await started(w, 'x2')
    expect((await runPolicy(w))?.executors).toBeUndefined()
  })

  test("a run.json that fails its check maps nothing and is logged; a policy.json that can't be written leaves the widening standing, logged", async () => {
    const w = await world()
    const live = await start(w, { workflow: 'execute', planPath: 'plan.md' })
    writeFileSync(runJsonPath(live.runDir), '{')
    await started(w, 'x1')
    expect((await runPolicy(w))?.executors).toBeUndefined()
    expect(w.p.logs.some(l => l.startsWith("executor x1: its gate isn't noted for the guard: "))).toBe(true)

    await noteWidening(w.p, w.litterDir, live.run, { seq: 5, gate: 'G2', files: ['gen.sh'], why: 'w' })
    expect((await runPolicy(w))?.widened).toEqual([{ seq: 5, gate: 'G2', files: ['gen.sh'], why: 'w' }])
    writeFileSync(policyPath(w.litterDir), '{')
    await noteWidening(w.p, w.litterDir, live.run, { seq: 6, gate: 'G2', files: ['lib/'], why: 'w' })
    expect(w.p.logs.some(l => l.startsWith(`gate.widen ${live.run} G2: the guard can't tell its executors, since policy.json wasn't written: `))).toBe(true)
    expect(readFileSync(policyPath(w.litterDir), 'utf8')).toBe('{')
  })
})

describe("run.start's widen and widenings", () => {
  test('each widening is asked before the run is made, then the gates, the copy of the plan, run.json and the ledger carry it', async () => {
    const w = await world()
    w.p.answers.push(ADD)
    const r = await start(w, { workflow: 'execute', planPath: 'plan.md', widenings: [{ gate: 'G2', files: ['gen.sh'], why: 'b.txt is generated' }] })
    expect(w.p.asked).toHaveLength(1)
    expect(w.p.asked[0]!.question).not.toContain(' of run ')
    expect(w.p.asked[0]!.question).toContain('in this run and any continuation of it')
    expect(gatesOf(r).find(g => g.id === 'G2')!.files).toEqual(['b.txt', 'gen.sh'])
    expect(r.args.widen).toBe('ask')
    const copy = readFileSync(planPath(r.runDir), 'utf8')
    expect(copy).toContain(widenNote(['gen.sh'], 'b.txt is generated', today()))
    // Your plan file isn't changed.
    expect(readFileSync(join(w.dir, 'plan.md'), 'utf8')).toBe(PLAN)
    const json = JSON.parse(readFileSync(runJsonPath(r.runDir), 'utf8')) as RunJson
    expect(json.widen).toBe('ask')
    const { records } = await readLedger(w.p, r.runDir, r.run)
    expect(records.findIndex(x => x.kind === 'gate.widen')).toBeGreaterThan(records.findIndex(x => x.kind === 'run.start'))
    expect(records.filter(x => x.kind === 'gate.widen').map(x => x.body)).toEqual([
      { gate: 'G2', files: ['gen.sh'], why: 'b.txt is generated', by: 'you', at: 'launch', plans: [planPath(r.runDir)] },
    ])
  })

  test('a widening you keep as written refuses the launch, with nothing made', async () => {
    const w = await world()
    w.p.answers.push(KEEP('G1'))
    const e = asError(await startRaw(w, { workflow: 'execute', planPath: 'plan.md', widenings: [{ gate: 'G1', files: ['z.txt'], why: 'w' }] }))
    expect(e.field).toBe('widenings[0]')
    expect(e.error).toContain('you kept G1 as written')
    expect((await w.git('branch', '--list', 'litter/*')).trim()).toBe('')
    const unasked = asError(await startRaw(w, { workflow: 'execute', planPath: 'plan.md', widenings: [{ gate: 'G1', files: ['z.txt'], why: 'w' }] }))
    expect(unasked.error).toContain('no one could be asked')
  })

  test('the widen setting: the option, the launch override, a bad value, and the fields refused outside execute', async () => {
    const w = await world({ widen: 'critic' })
    const r = await start(w, { workflow: 'execute', planPath: 'plan.md' })
    expect(r.args.widen).toBe('critic')
    expect((JSON.parse(readFileSync(runJsonPath(r.runDir), 'utf8')) as RunJson).widen).toBe('critic')
    await end(w, r, 'halted', 'x')
    const o = await start(w, { workflow: 'execute', planPath: 'plan.md', widen: 'ask' })
    expect(o.args.widen).toBe('ask')
    await end(w, o, 'halted', 'x')
    expect(asError(await startRaw(w, { workflow: 'execute', planPath: 'plan.md', widen: 'always' })).field).toBe('widen')
    expect(asError(await startRaw(w, { workflow: 'plan', goal: 'g', widen: 'ask' })).field).toBe('widen')
    expect(asError(await startRaw(w, { workflow: 'plan', goal: 'g', widenings: [] })).field).toBe('widenings')
    const twice = asError(
      await startRaw(w, { workflow: 'execute', planPath: 'plan.md', widenings: [{ gate: 'G1', files: ['x'], why: 'w' }, { gate: 'G1', files: ['y'], why: 'w' }] }),
    )
    expect(twice.field).toBe('widenings[1].gate')
    expect(asError(await startRaw(w, { workflow: 'execute', planPath: 'plan.md', widenings: [{ gate: 'G5', files: ['x'], why: 'w' }] })).field).toBe('widenings[0].gate')
  })

  test("a continuation's widening also goes into the chain root's plan.md, after the run is made", async () => {
    const w = await world()
    const first = await halted(w)
    w.p.answers.push(ADD)
    const second = await start(w, { workflow: 'execute', continueOf: first.run, widenings: [{ gate: 'G2', files: ['gen.sh'], why: 'w' }] })
    expect(gatesOf(second).find(g => g.id === 'G2')!.files).toEqual(['b.txt', 'gen.sh'])
    for (const dir of [second.runDir, first.runDir]) expect(readFileSync(planPath(dir), 'utf8')).toContain('Files: b.txt, gen.sh\n')
    expect(readFileSync(planVersionPath(first.runDir, 1), 'utf8')).toBe(PLAN)
    const recs = await widenings(w, second.runDir, second.run)
    expect(recs.map(x => x.body.plans)).toEqual([[planPath(second.runDir), planPath(first.runDir)]])
  })
})
