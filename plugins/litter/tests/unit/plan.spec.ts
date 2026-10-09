// Tier 2: hooks/plan.ts (COMMON steps 2 and 3): renderGateSection's round
// trip through parseGates and each refusal; plan.write into a plan run's
// plan.md, keeping the previous one; a re-split of a halted chain's plan with
// the landed sections byte for byte, then run.start's continuation; gate.amend,
// then run.start's amend run. Real git in scratch repos, as runstart.spec.ts.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { PlannedGate } from '../../hooks/records/execute'
import type { RecordCtx, RecordError, RecordInput, RecordReply } from '../../hooks/records/core'
import type { RunJson, RunStartBody, RunStartReply } from '../../hooks/records/run'
import { recordRunStart, endRun } from '../../hooks/lifecycle'
import { stopLease } from '../../hooks/lock'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { modePath, planPath, planVersionPath, runDir, runJsonPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { parseGates } from '../../hooks/gates'
import { recordGateAmend, recordPlanWrite, renderGateSection, writePlanVersion } from '../../hooks/plan'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const gate = (id: string, extra: Partial<PlannedGate> = {}): PlannedGate => ({
  id,
  title: `Add ${id.toLowerCase()}.txt`,
  scope: `Create ${id.toLowerCase()}.txt with one line.`,
  lines: '',
  files: [`${id.toLowerCase()}.txt`],
  done_when: `${id.toLowerCase()}.txt exists`,
  checks: [`test -f ${id.toLowerCase()}.txt`],
  adversary: false,
  ...extra,
})

// ---------------------------------------------------------------------------
// The renderer

describe('renderGateSection', () => {
  test('renders section 10, and parseGates reads it back as the same gate, excerpt and all', () => {
    const g = gate('G3', {
      title: 'Parse the\nheader',
      scope: '\n\nParse the header in src/header.ts:12.\n\nKeep the old reader.\n#### A note\nStill this gate.\n',
      lines: '3-9',
      files: ['src/header.ts', '`src/header.spec.ts`'],
      checks: ['bun test header', 'grep -c parse src/header.ts'],
      done_when: 'header.spec passes\nand nothing else changed',
      adversary: true,
    })
    const text = renderGateSection(g)
    expect(text).toBe(
      [
        '### G3: Parse the header',
        'Files: src/header.ts, src/header.spec.ts',
        'Checks:',
        '- bun test header',
        '- grep -c parse src/header.ts',
        'Done when: header.spec passes and nothing else changed',
        'Adversary: yes',
        '',
        'Parse the header in src/header.ts:12.',
        '',
        'Keep the old reader.',
        '#### A note',
        'Still this gate.',
        '',
        'Plan lines: 3-9',
        '',
      ].join('\n'),
    )
    const back = parseGates(text)
    if (!back.ok) throw new Error(back.error)
    expect(back.gates).toHaveLength(1)
    expect(back.gates[0]).toEqual(
      expect.objectContaining({
        id: 'G3',
        title: 'Parse the header',
        files: ['src/header.ts', 'src/header.spec.ts'],
        checks: 'bun test header\ngrep -c parse src/header.ts',
        doneWhen: 'header.spec passes and nothing else changed',
        adversary: true,
        excerpt: text.slice(0, -1),
      }),
    )
  })

  test('one check on its line, a path with a comma in the list form, no Adversary line, no scope', () => {
    const text = renderGateSection(gate('G1', { files: ['a,b.txt', 'c.txt'], scope: '', adversary: false }))
    expect(text).toBe('### G1: Add g1.txt\nFiles:\n- a,b.txt\n- c.txt\nChecks: test -f g1.txt\nDone when: g1.txt exists\n')
    const back = parseGates(text)
    expect(back.ok && back.gates[0]!.files).toEqual(['a,b.txt', 'c.txt'])
  })

  test('a fenced heading inside the scope stays inside the gate', () => {
    const text = renderGateSection(gate('G1', { scope: 'Like this:\n\n```md\n### G9: not a gate\n```' }))
    const back = parseGates(text)
    expect(back.ok && back.gates.map(g => g.id)).toEqual(['G1'])
  })

  const refusals: [string, Partial<PlannedGate>, string][] = [
    ['an id that is not G<n>', { id: 'gate1' }, "gate gate1: 'id' must be a gate id like G1"],
    ['an empty title', { title: '  \n ' }, "gate G1: 'title' is required"],
    ['no files', { files: [] }, "gate G1: 'files' needs at least one path"],
    ['a file with a line break', { files: ['a.txt\n### G2: x'] }, "gate G1: 'files[0]' holds a line break"],
    ['an empty check', { checks: ['``'] }, "gate G1: 'checks[0]' is empty"],
    ['no done when', { done_when: '' }, "gate G1: 'done_when' is required"],
    ['a fence left open', { scope: 'Run:\n```sh\nls' }, "gate G1: 'scope' opens a code fence it never closes"],
    ["another gate's heading", { scope: 'First.\n### G2: smuggled\nFiles: x\nChecks: y\nDone when: z' }, "gate G1: 'scope' holds another gate's heading (G1, G2)"],
    ['a heading that ends the section', { scope: 'First.\n## Next part\nMore.' }, "gate G1: 'scope' holds a heading that ends the section early"],
  ]
  for (const [what, extra, error] of refusals) {
    test(`refuses ${what}, naming the gate and the field`, () => {
      expect(() => renderGateSection(gate('G1', extra))).toThrow(error)
    })
  }
})

// ---------------------------------------------------------------------------
// The world: a scratch repo with a plan of two gates, as runstart.spec.ts has it

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

type World = { p: TestPorts; dir: string; litterDir: string; git: (...argv: string[]) => Promise<string>; ctx: RecordCtx }

const cleanups: (() => void)[] = []
afterEach(() => {
  stopLease()
  for (const c of cleanups.splice(0)) c()
})

async function world(): Promise<World> {
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
  return { p, dir, litterDir, git, ctx: { p, caller: { agentId: null, agentType: null }, litterDir, options: normalizeOptions({ verify: ['true'] }) } }
}

const AUTH = { authorized: ['change a.txt and b.txt'] }
const start = async (w: World, fields: Record<string, unknown>): Promise<RunStartReply> => {
  const r = await recordRunStart(w.ctx, { kind: 'run.start', ...AUTH, ...fields } as RecordInput)
  if (!(r as { ok: boolean }).ok) throw new Error(`run.start refused: ${JSON.stringify(r)}`)
  return r as RunStartReply
}
const end = (w: World, r: { run: string; runDir: string }, status: 'done' | 'halted', reason: string | null) =>
  endRun(w.p, { run: r.run, runDir: r.runDir, litterDir: w.litterDir }, { taskId: null, generation: 0, status, reason, source: 'mod' })

const planWrite = (w: World, fields: Record<string, unknown>) => recordPlanWrite(w.ctx, { kind: 'plan.write', ...fields } as RecordInput)
const gateAmend = (w: World, fields: Record<string, unknown>) => recordGateAmend(w.ctx, { kind: 'gate.amend', ...fields } as RecordInput)

const asOk = (r: RecordReply) => {
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r)}`)
  return r as RecordReply & Record<string, unknown>
}
const asError = (r: RecordReply) => {
  expect(r.ok).toBe(false)
  return r as RecordError
}

/** An execute run of plan.md whose G1 landed and which then halted at G2. */
async function haltedAtG2(w: World): Promise<RunStartReply> {
  const first = await start(w, { workflow: 'execute', planPath: 'plan.md' })
  await appendRecord(w.p, first.runDir, { run: first.run, kind: 'land', by: { source: 'mod' }, body: { gate: 'G1', commit: 'c0ffee' } })
  await end(w, first, 'halted', 'G2 plan gap: b.txt has to be generated')
  return first
}

// ---------------------------------------------------------------------------
// plan.write

describe('plan.write for a plan run', () => {
  test("renders a header and every section into the run's plan.md, then keeps it as plan.1.md on the next write", async () => {
    const w = await world()
    const plan = await start(w, { workflow: 'plan', goal: 'add a\nretry' })
    await end(w, plan, 'done', null)
    const r1 = asOk(await planWrite(w, { run: plan.run, gates: [gate('G1'), gate('G2', { lines: '4-6' })] }))
    const path = planPath(plan.runDir)
    expect(r1).toEqual(expect.objectContaining({ ok: true, kind: 'plan.write', run: plan.run, path, previous: null }))
    const text1 = readFileSync(path, 'utf8')
    expect(text1).toBe([`Gates planned by litter for run ${plan.run}: add a retry`, '', renderGateSection(gate('G1')), renderGateSection(gate('G2', { lines: '4-6' }))].join('\n'))
    const back = parseGates(text1)
    expect(back.ok && back.gates.map(g => [g.id, g.files, g.checks, g.doneWhen])).toEqual([
      ['G1', ['g1.txt'], 'test -f g1.txt', 'g1.txt exists'],
      ['G2', ['g2.txt'], 'test -f g2.txt', 'g2.txt exists'],
    ])

    const r2 = asOk(await planWrite(w, { run: plan.run, gates: [gate('G1', { title: 'Only one' })] }))
    expect(r2.previous).toBe(planVersionPath(plan.runDir, 1))
    expect(readFileSync(planVersionPath(plan.runDir, 1), 'utf8')).toBe(text1)
    expect(readFileSync(path, 'utf8')).toContain('### G1: Only one')

    const { records } = await readLedger(w.p, plan.runDir, plan.run)
    const writes = records.filter(r => r.kind === 'plan.write')
    expect(writes.map(r => [r.body.path, r.body.previous])).toEqual([
      [path, null],
      [path, planVersionPath(plan.runDir, 1)],
    ])
  })

  test('the execute launch reads the written plan: every gate as rendered, in args', async () => {
    const w = await world()
    const plan = await start(w, { workflow: 'plan', goal: 'two files' })
    await end(w, plan, 'done', null)
    const g2 = gate('G2', { checks: ['test -f g2.txt', 'grep -q x g2.txt'], adversary: true, lines: '7-8' })
    const wrote = asOk(await planWrite(w, { run: plan.run, gates: [gate('G1'), g2] }))
    const exec = await start(w, { workflow: 'execute', planPath: wrote.path })
    const args = exec.args.gates as { id: string; files: string[]; checks: string[]; done_when: string; adversary: boolean; excerpt: string }[]
    expect(args.map(g => [g.id, g.files, g.checks, g.done_when, g.adversary])).toEqual([
      ['G1', ['g1.txt'], ['test -f g1.txt'], 'g1.txt exists', false],
      ['G2', ['g2.txt'], ['test -f g2.txt', 'grep -q x g2.txt'], 'g2.txt exists', true],
    ])
    expect(args[1]!.excerpt).toBe(renderGateSection(g2).slice(0, -1))
  })

  test('the prose plan a plan run copied is kept as plan.1.md', async () => {
    const w = await world()
    const plan = await start(w, { workflow: 'plan', planPath: 'plan.md' })
    await end(w, plan, 'done', null)
    const r = asOk(await planWrite(w, { run: plan.run, gates: [gate('G1')] }))
    expect(r.previous).toBe(planVersionPath(plan.runDir, 1))
    expect(readFileSync(planVersionPath(plan.runDir, 1), 'utf8')).toBe(PLAN)
    // The header names the plan the run was given.
    expect(readFileSync(planPath(plan.runDir), 'utf8')).toStartWith(`Gates planned by litter for run ${plan.run}: ${join(w.dir, 'plan.md')}\n`)
  })

  test('refusals name the field, and write nothing', async () => {
    const w = await world()
    const plan = await start(w, { workflow: 'plan', goal: 'g' })
    await end(w, plan, 'done', null)
    const first = asError(await planWrite(w, { run: plan.run, gates: [gate('G1'), gate('G2', { scope: 'x\n## Break\ny' })] }))
    expect(first.field).toBe('gates[1]')
    expect(first.error).toContain("gate G2 doesn't render")
    expect(asError(await planWrite(w, { run: plan.run, gates: [gate('G1', { files: [] })] })).field).toBe('gates[0].files')
    expect(asError(await planWrite(w, { run: plan.run, gates: [gate('G1', { checks: 'x' as never })] })).field).toBe('gates[0].checks')
    expect(asError(await planWrite(w, { run: plan.run, gates: [gate('G1', { done_when: ' ' })] })).field).toBe('gates[0].done_when')
    expect(asError(await planWrite(w, { run: plan.run, gates: [gate('G1', { adversary: 'yes' as never })] })).field).toBe('gates[0].adversary')
    expect(asError(await planWrite(w, { run: plan.run, gates: [gate('G1')], continueOf: '../x' })).field).toBe('continueOf')
    expect(existsSync(planPath(plan.runDir))).toBe(false)
    const { records } = await readLedger(w.p, plan.runDir, plan.run)
    expect(records.filter(r => r.kind === 'plan.write')).toEqual([])
  })

  test("an execute run isn't a plan run", async () => {
    const w = await world()
    const first = await haltedAtG2(w)
    const e = asError(await planWrite(w, { run: first.run, gates: [gate('G3')] }))
    expect(e.field).toBe('run')
    expect(e.error).toContain('is a execute run')
  })
})

describe('a re-split (plan.write with continueOf)', () => {
  test("a plan run that continues the chain gets its landed gates and the halt's reason", async () => {
    const w = await world()
    const first = await haltedAtG2(w)
    const plan = await start(w, { workflow: 'plan', continueOf: first.run })
    expect(plan.args).toEqual(expect.objectContaining({ continueOf: first.run, landed: [{ id: 'G1', commit: 'c0ffee' }], halted: 'G2 plan gap: b.txt has to be generated' }))
    expect(plan.args.plan).toBe(PLAN)
  })

  // The plan runs below are started from a goal: one started with continueOf joins the
  // chain (its run.json names it) on its own base ref, and resolveChain then refuses the
  // chain as a whole; that's lifecycle.ts's to change (this package's report).
  test("rewrites the root's plan.md with the landed sections byte for byte, then run.start continues with only the new gates", async () => {
    const w = await world()
    const first = await haltedAtG2(w)
    const rootPlan = planPath(first.runDir)
    const old = readFileSync(rootPlan, 'utf8')
    expect(old).toBe(PLAN)

    const plan = await start(w, { workflow: 'plan', goal: 'finish b.txt' })
    await end(w, plan, 'done', null)
    const r = asOk(await planWrite(w, { run: plan.run, continueOf: first.run, gates: [gate('G3'), gate('G4')] }))
    expect(r).toEqual(expect.objectContaining({ path: rootPlan, previous: planVersionPath(first.runDir, 1), kept: ['G1'], replaced: ['G2'] }))

    const text = readFileSync(rootPlan, 'utf8')
    // The text before G1 and G1's section, as they were, then the new sections.
    const keptPart = old.slice(0, old.indexOf('### G2:'))
    expect(text).toBe(`${keptPart}${renderGateSection(gate('G3'))}\n${renderGateSection(gate('G4'))}`)
    expect(readFileSync(planVersionPath(first.runDir, 1), 'utf8')).toBe(old)

    // Stored in the plan run's ledger, naming the root and what changed.
    const { records } = await readLedger(w.p, plan.runDir, plan.run)
    expect(records.find(x => x.kind === 'plan.write')!.body).toEqual(
      expect.objectContaining({ continueOf: first.run, root: first.run, kept: ['G1'], replaced: ['G2'], path: rootPlan, previous: planVersionPath(first.runDir, 1) }),
    )

    const next = await start(w, { workflow: 'execute', continueOf: first.run })
    expect((next.args.gates as { id: string }[]).map(g => g.id)).toEqual(['G3', 'G4'])
    expect(next.args.landed).toEqual([{ id: 'G1', commit: 'c0ffee' }])
  })

  test("a new gate can't take a landed gate's id", async () => {
    const w = await world()
    const first = await haltedAtG2(w)
    const plan = await start(w, { workflow: 'plan', goal: 'finish b.txt' })
    await end(w, plan, 'done', null)
    const e = asError(await planWrite(w, { run: plan.run, continueOf: first.run, gates: [gate('G2'), gate('G1')] }))
    expect(e.field).toBe('gates[1].id')
    expect(e.error).toContain('gate G1 has landed')
    expect(readFileSync(planPath(first.runDir), 'utf8')).toBe(PLAN)
    expect(existsSync(planVersionPath(first.runDir, 1))).toBe(false)
  })

  test('a continueOf that is not an execute chain is refused', async () => {
    const w = await world()
    const plan = await start(w, { workflow: 'plan', goal: 'g' })
    await end(w, plan, 'done', null)
    const e = asError(await planWrite(w, { run: plan.run, continueOf: plan.run, gates: [gate('G1')] }))
    expect(e.field).toBe('continueOf')
  })
})

// ---------------------------------------------------------------------------
// gate.amend

const AMENDED = ['### G2: Second, generated', 'Files: b.txt, gen.sh', 'Checks: sh gen.sh && test -f b.txt', 'Done when: gen.sh writes b.txt', '', 'Generate b.txt with gen.sh.'].join('\n')

describe('gate.amend', () => {
  test("replaces the gate's section in the root's plan.md, keeping the old file, and run.start's amend run gets the amended gate", async () => {
    const w = await world()
    const first = await haltedAtG2(w)
    const rootPlan = planPath(first.runDir)
    const before = parseGates(PLAN)
    if (!before.ok) throw new Error(before.error)
    const r = asOk(await gateAmend(w, { run: first.run, gate: 'G2', before: before.gates[1]!.excerpt, after: `${AMENDED}\n`, reason: 'b.txt is generated' }))
    expect(r).toEqual(expect.objectContaining({ path: rootPlan, previous: planVersionPath(first.runDir, 1) }))
    const text = readFileSync(rootPlan, 'utf8')
    expect(text).toBe(`${PLAN.slice(0, PLAN.indexOf('### G2:'))}${AMENDED}\n`)
    expect(readFileSync(planVersionPath(first.runDir, 1), 'utf8')).toBe(PLAN)

    const { records } = await readLedger(w.p, first.runDir, first.run)
    expect(records.at(-1)!).toEqual(expect.objectContaining({ kind: 'gate.amend' }))
    expect(records.at(-1)!.body).toEqual(expect.objectContaining({ gate: 'G2', reason: 'b.txt is generated', root: first.run, path: rootPlan, previous: planVersionPath(first.runDir, 1) }))

    const amend = await start(w, { workflow: 'execute', amendOf: { run: first.run, gate: 'G2' } })
    const gates = amend.args.gates as { id: string; files: string[]; checks: string[]; done_when: string; excerpt: string }[]
    expect(gates).toHaveLength(1)
    expect(gates[0]).toEqual(expect.objectContaining({ id: 'G2', files: ['b.txt', 'gen.sh'], checks: ['sh gen.sh && test -f b.txt'], done_when: 'gen.sh writes b.txt', excerpt: AMENDED }))
  })

  test('a middle gate keeps the blank line before the next one, and a second amend keeps plan.1.md and adds plan.2.md', async () => {
    const w = await world()
    const first = await start(w, { workflow: 'execute', planPath: 'plan.md' })
    await end(w, first, 'halted', 'G1 did not land after 3 attempts')
    const g1 = '### G1: First, again\nFiles: a.txt\nChecks: test -s a.txt\nDone when: a.txt has a line'
    asOk(await gateAmend(w, { run: first.run, gate: 'G1', after: g1, reason: 'a.txt needs a line' }))
    const text = readFileSync(planPath(first.runDir), 'utf8')
    expect(text).toBe(PLAN.replace('### G1: First\nFiles: a.txt\nChecks: test -f a.txt\nDone when: a.txt exists\n\nCreate a.txt.', g1))
    asOk(await gateAmend(w, { run: first.run, gate: 'G1', after: `${g1}\n\nStill a.txt.`, reason: 'note' }))
    expect(readFileSync(planVersionPath(first.runDir, 1), 'utf8')).toBe(PLAN)
    expect(readFileSync(planVersionPath(first.runDir, 2), 'utf8')).toBe(text)
  })

  test('a landed gate is refused', async () => {
    const w = await world()
    const first = await haltedAtG2(w)
    const e = asError(await gateAmend(w, { run: first.run, gate: 'G1', after: '### G1: First\nFiles: a.txt\nChecks: true\nDone when: x', reason: 'r' }))
    expect(e.field).toBe('gate')
    expect(e.error).toContain('G1 has landed')
    expect(readFileSync(planPath(first.runDir), 'utf8')).toBe(PLAN)
  })

  test("a before that isn't the section's current text is refused", async () => {
    const w = await world()
    const first = await haltedAtG2(w)
    const e = asError(await gateAmend(w, { run: first.run, gate: 'G2', before: '### G2: Second\nFiles: c.txt', after: AMENDED, reason: 'r' }))
    expect(e.field).toBe('before')
    expect(existsSync(planVersionPath(first.runDir, 1))).toBe(false)
  })

  test("an after that isn't exactly the one gate's section is refused", async () => {
    const w = await world()
    const first = await haltedAtG2(w)
    const cases: [string, string][] = [
      ['two sections', `${AMENDED}\n\n### G3: More\nFiles: c.txt\nChecks: true\nDone when: c`],
      ['another id', AMENDED.replace('### G2', '### G3')],
      ['text before the heading', `Intro.\n\n${AMENDED}`],
      ['a heading that ends it', `${AMENDED}\n\n## Elsewhere\nmore`],
      ['no Checks', '### G2: Second\nFiles: b.txt\nDone when: b'],
      ['an open fence', `${AMENDED}\n\n\`\`\`sh\nls`],
    ]
    for (const [what, after] of cases) {
      const e = asError(await gateAmend(w, { run: first.run, gate: 'G2', after, reason: 'r' }))
      expect({ what, field: e.field }).toEqual({ what, field: 'after' })
    }
    expect(asError(await gateAmend(w, { run: first.run, gate: 'G7', after: AMENDED.replace('G2', 'G7'), reason: 'r' })).allowed).toEqual(['G1', 'G2'])
    expect(readFileSync(planPath(first.runDir), 'utf8')).toBe(PLAN)
  })

  const amendsOf = async (w: World, r: { run: string; runDir: string }) =>
    (await readLedger(w.p, r.runDir, r.run)).records.filter(x => x.kind === 'gate.amend').map(x => x.body)

  test("records what the amendment did to the gate's Files, in order; a text-only one's record is as before", async () => {
    const w = await world()
    const first = await haltedAtG2(w)
    const moved = '### G2: Second, moved\nFiles: c.txt, gen.sh\nChecks: sh gen.sh && test -f c.txt\nDone when: gen.sh writes c.txt'
    asOk(await gateAmend(w, { run: first.run, gate: 'G2', after: moved, reason: 'b.txt moves to c.txt' }))
    const textOnly = '### G2: Second, moved\nFiles: c.txt, gen.sh\nChecks: sh gen.sh && test -s c.txt\nDone when: gen.sh writes c.txt, not empty'
    asOk(await gateAmend(w, { run: first.run, gate: 'G2', after: textOnly, reason: 'c.txt has a line' }))
    const [added, same] = await amendsOf(w, first)
    expect(added).toEqual(expect.objectContaining({ filesAdded: ['c.txt', 'gen.sh'], filesRemoved: ['b.txt'] }))
    expect(same).toEqual({
      gate: 'G2',
      after: textOnly,
      reason: 'c.txt has a line',
      root: first.run,
      path: planPath(first.runDir),
      previous: planVersionPath(first.runDir, 2),
    })
  })

  test("a caller's own filesAdded or filesRemoved never reaches the record", async () => {
    const w = await world()
    const first = await haltedAtG2(w)
    const textOnly = '### G2: Second\nFiles: b.txt\nChecks: test -s b.txt\nDone when: b.txt has a line'
    asOk(await gateAmend(w, { run: first.run, gate: 'G2', after: textOnly, reason: 'r', filesAdded: ['evil.txt'], filesRemoved: ['b.txt'] }))
    asOk(await gateAmend(w, { run: first.run, gate: 'G2', after: AMENDED, reason: 'r', filesAdded: ['evil.txt'] }))
    const [none, mine] = await amendsOf(w, first)
    expect(Object.keys(none!)).not.toContain('filesAdded')
    expect(Object.keys(none!)).not.toContain('filesRemoved')
    expect(mine).toEqual(expect.objectContaining({ filesAdded: ['gen.sh'] }))
    expect(Object.keys(mine!)).not.toContain('filesRemoved')
  })

  test("the amend run's run.json and run.start carry the files its amendment added, and the reason on one line", async () => {
    const w = await world()
    const first = await haltedAtG2(w)
    asOk(await gateAmend(w, { run: first.run, gate: 'G2', after: AMENDED, reason: 'b.txt is generated\nby gen.sh' }))
    const amend = await start(w, { workflow: 'execute', amendOf: { run: first.run, gate: 'G2' } })
    const want = { run: first.run, gate: 'G2', filesAdded: ['gen.sh'], reason: 'b.txt is generated by gen.sh' }
    expect((JSON.parse(readFileSync(runJsonPath(amend.runDir), 'utf8')) as RunJson).amendOf).toEqual(want)
    const startRec = (await readLedger(w.p, amend.runDir, amend.run)).records.find(x => x.kind === 'run.start')!
    expect((startRec.body as unknown as RunStartBody).amendOf).toEqual(want)
    // The workflow's args name the run and the gate, as before.
    expect(amend.args.amendOf).toEqual({ run: first.run, gate: 'G2' })
  })

  test('an amend run with no gate.amend, or a text-only one, has amendOf { run, gate }, as before', async () => {
    for (const textOnly of [false, true]) {
      const w = await world()
      const first = await haltedAtG2(w)
      if (textOnly) {
        asOk(await gateAmend(w, { run: first.run, gate: 'G2', after: '### G2: Second\nFiles: b.txt\nChecks: test -s b.txt\nDone when: b.txt has a line', reason: 'r' }))
      }
      const amend = await start(w, { workflow: 'execute', amendOf: { run: first.run, gate: 'G2' } })
      expect({ textOnly, amendOf: (JSON.parse(readFileSync(runJsonPath(amend.runDir), 'utf8')) as RunJson).amendOf }).toEqual({ textOnly, amendOf: { run: first.run, gate: 'G2' } })
    }
  })
})

describe('writePlanVersion', () => {
  test('takes the next free n past the highest kept, and writes plan.md whole', async () => {
    const w = await world()
    const dir = runDir(w.litterDir, '20261003-x-aaaaaa')
    expect(await writePlanVersion(w.p, dir, 'one\n')).toEqual({ path: planPath(dir), previous: null })
    await w.p.fs.write(planVersionPath(dir, 4), 'old four\n')
    expect(await writePlanVersion(w.p, dir, 'two\n')).toEqual({ path: planPath(dir), previous: planVersionPath(dir, 5) })
    expect(readFileSync(planVersionPath(dir, 5), 'utf8')).toBe('one\n')
    expect(readFileSync(planPath(dir), 'utf8')).toBe('two\n')
  })
})
