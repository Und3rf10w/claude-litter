// Tier 2: the board's view with a host's redactor (hooks/board/view.ts,
// buildBoard's `redact`). litterd redacts the values it forwards to role
// sessions out of what it shows; the board cuts its fields (120, 160, 200,
// 300, 600 and 8000 characters, and 4× those before a line is folded), and a
// cut inside a value leaves its start, which a redaction after the cut no
// longer matches. So the redactor runs on each text the build reads, before
// any cut: a 20-character value at every offset across the cuts leaves no
// prefix of 4 or more characters anywhere in the view. Without a redactor
// the view is the one boardview.spec.ts checks.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProposalRef, RuleProposeBody, RuleStatus } from '../../hooks/records/rules'
import type { BoardView } from '../../types/index'
import { appendRecord } from '../../hooks/ledgercore'
import { planPath, runDir, runJsonPath, verdictFile } from '../../hooks/layout'
import { updateSession } from '../../hooks/session'
import { MOD } from '../../hooks/verify'
import { blankBoardNav, buildBoard, deps, resetBoardForTests, setBoardNav } from '../../hooks/board/view'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

setDefaultTimeout(600_000)

/** The forwarded value: 20 characters, its first 4 in nothing else the fixtures write. */
const SECRET = 'Zq9#forwarded-v4lue!'
const PREFIX = SECRET.slice(0, 4)
const redact = (s: string): string => s.split(SECRET).join('[redacted]')
/** A source text with the value at offset `k`, filler before it and words after. */
const at = (k: number): string => `${'a'.repeat(k)}${SECRET} and the rest`

const OID = (c: string) => c.repeat(40)

let p: TestPorts
let dir: string
let litterDir: string
let cleanup: () => void
let proposals: { ref: ProposalRef; body: RuleProposeBody; status: RuleStatus }[]
const saved = { ...deps }

beforeEach(() => {
  resetBoardForTests()
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ sessionId: 's1', cwd: dir })
  litterDir = join(dir, '.claude', 'litter')
  updateSession({ litterDir, toolsRefused: null })
  proposals = []
  deps.loadRules = async () => ({ rules: [], problems: [] })
  deps.proposalsOf = async () => proposals
})

afterEach(() => {
  Object.assign(deps, saved)
  setBoardNav(null)
  updateSession({ litterDir: null, toolsRefused: null })
  cleanup()
})

type Rec = { kind: string; body: Record<string, unknown> }

async function writeRun(run: string, json: Record<string, unknown>, recs: readonly Rec[]): Promise<string> {
  const rd = runDir(litterDir, run)
  mkdirSync(rd, { recursive: true })
  writeFileSync(runJsonPath(rd), `${JSON.stringify({ v: 1, run, base: OID('b'), ref: `refs/heads/litter/${run}`, session: 's1', created: 0, rules: [], ...json })}\n`)
  for (const r of recs) await appendRecord(p, rd, { run, kind: r.kind, by: MOD, body: r.body })
  return rd
}

const dim = (pass: boolean, evidence: string, gaps: string[] = []) => ({ pass, evidence, gaps })
/** A verify record whole, as verify.ts's verifyBody reads it. */
const verify = (id: string, gate: string, attempt: number, green: boolean): Rec => ({
  kind: 'verify',
  body: {
    verify_id: id,
    gate,
    attempt,
    argv: ['bun', 'test'],
    tree_before: OID('c'),
    tree_after: OID('c'),
    dirty_submodules: [],
    exit_code: green ? 0 : 1,
    signal: null,
    timed_out: false,
    spawn_error: null,
    green,
    log_parts: 1,
    log_bytes: 10,
    output_tail: '',
  },
})

/** An execute run with `t` in each text it shows: gate titles, the checkout, the critic's evidence, gaps, plan gap and rule clash, a proposal, the end's reason. */
async function executeRun(run: string, t: string): Promise<string> {
  const rd = await writeRun(run, { workflow: 'execute', checkout: t, args: { gates: [{ id: 'G1', title: t }, { id: 'G2', title: t }], maxAttempts: 3 } }, [
    { kind: 'run.start', body: { workflow: 'execute', base: OID('b'), ref: `refs/heads/litter/${run}`, checkout: t } },
    { kind: 'run.launch', body: { taskId: 't1', runId: 'wf_1', generation: 1, session: 's1', oid: OID('d') } },
    verify('v1', 'G1', 1, true),
    { kind: 'land', body: { gate: 'G1', verify_id: 'v1', commit: OID('c'), tree: OID('e'), old: OID('b') } },
    verify('v2', 'G2', 1, false),
    {
      kind: 'verdict',
      body: {
        verify_id: 'v2',
        plan_adherence: dim(false, t, [t, t]),
        tests_green: dim(false, t),
        no_regressions: dim(true, t),
        rules: dim(true, t),
        plan_gap: t,
        rule_clash: t,
        proposed_rules: [],
      },
    },
    { kind: 'rule.propose', body: { rule: t, source: t, gate: 'G2' } },
    { kind: 'run.end', body: { taskId: 't1', generation: 1, status: 'halted', reason: t, source: 'notification' } },
  ])
  writeFileSync(planPath(rd), `# Plan\n\n${t}\n`)
  return rd
}

/** A design run: its bar's texts, an unknown's question, a refused delivery, a reframer's recommendation. */
const designRun = (run: string, t: string) =>
  writeRun(run, { workflow: 'design', checkout: dir, args: { deliverable: 'plan', bar: [{ id: 'C1', text: t }, { id: 'C2', text: t }], empiricalUnknowns: [t] } }, [
    { kind: 'run.start', body: { workflow: 'design', base: OID('b'), ref: `refs/heads/litter/${run}`, checkout: dir } },
    { kind: 'probe', body: { unknown_id: 'U1', verdict: 'confirmed', report: t } },
    { kind: 'design.result', body: { role: 'reframer', result: { recommendation: t } } },
    { kind: 'design.deliver', body: { version: 'v1', refused: t } },
    { kind: 'land.blocked', body: { gate: 'G1', reason: t } },
  ])

/** A fanout run that halted: its record lines, an unknown record's keys and fields, the end's reason. */
const fanoutRun = (run: string, t: string) =>
  writeRun(run, { workflow: 'fanout', checkout: dir, args: {} }, [
    { kind: 'run.start', body: { workflow: 'fanout', base: OID('b'), ref: `refs/heads/litter/${run}`, checkout: dir } },
    { kind: 'run.launch', body: { taskId: 't1', runId: 'wf_1', generation: 1, session: 's1', oid: OID('d') } },
    { kind: 'something.new', body: { [t]: 'its key', text: t } },
    { kind: 'run.end', body: { taskId: 't1', generation: 1, status: 'halted', reason: t, source: 'notification' } },
  ])

/** Every string in the view. */
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) strings(x, out)
  else if (v !== null && typeof v === 'object') for (const [k, x] of Object.entries(v)) strings(x, strings(k, out))
  return out
}

const leaks = (view: BoardView): string[] => strings(view).filter(s => s.includes(PREFIX))

/** The three runs with the value at offset `k`, and the rules store's proposal. */
async function seed(k: number): Promise<void> {
  const t = at(k)
  await executeRun(`20261012-exec-${k}`, t)
  await designRun(`20261012-design-${k}`, t)
  await fanoutRun(`20261012-fan-${k}`, t)
  proposals = [{ ref: { ledger: 'repo', seq: 1 } as unknown as ProposalRef, body: { rule: t, source: t, gate: 'G2', doc: { body: { rule: t } } } as unknown as RuleProposeBody, status: 'proposed' }]
}

/** seed's runs, each built with `opts`: the execute run with its plan open, then the fanout run under the refused notice too. */
async function build(k: number, opts: { redact?: (s: string) => string }): Promise<BoardView[]> {
  const t = at(k)
  const exec = `20261012-exec-${k}`
  updateSession({ litterDir, toolsRefused: null })
  setBoardNav({ ...blankBoardNav(exec), run: exec, section: { kind: 'plan' } })
  const out = [await buildBoard(p, litterDir, exec, opts)]
  setBoardNav(null)
  out.push(await buildBoard(p, litterDir, `20261012-design-${k}`, opts), await buildBoard(p, litterDir, `20261012-fan-${k}`, opts))
  // The refused notice, which every board shows first.
  updateSession({ litterDir, toolsRefused: t })
  out.push(await buildBoard(p, litterDir, `20261012-fan-${k}`, opts))
  updateSession({ litterDir, toolsRefused: null })
  return out
}

const views = async (k: number, opts: { redact?: (s: string) => string }): Promise<BoardView[]> => {
  await seed(k)
  return build(k, opts)
}

describe("buildBoard's redactor", () => {
  test('a value at every offset across the cuts leaves no prefix of 4 or more characters in any field', async () => {
    // Up to past the longest field cut (600) by the value's length and a margin.
    for (let k = 0; k <= 640; k++) {
      for (const view of await views(k, { redact })) expect({ k, leaks: leaks(view) }).toEqual({ k, leaks: [] })
    }
  })

  test('the control: without it, a value across each cut leaves its start in that field, so the sweep reaches every one', async () => {
    /** The value's start without the rest of it: what a cut leaves. */
    const cutIn = (s: string | undefined) => typeof s === 'string' && s.includes(PREFIX) && !s.includes(SECRET)
    const [exec] = await views(110, {})
    // 120: the gate titles.
    expect(exec!.body!.gates!.rows.map(r => cutIn(r.title))).toEqual([true, true])
    // 160: a record's line, `generation 1: halted (` before the reason.
    expect((await views(130, {}))[2]!.body!.records.some(r => cutIn(r.text))).toBe(true)
    // 200: the run's halt in what needs you, and a proposal's text.
    const [, , fan185] = await views(185, {})
    expect(fan185!.body!.attention.some(a => cutIn(a.text))).toBe(true)
    expect((await views(190, {}))[0]!.body!.proposals.some(x => cutIn(x.text))).toBe(true)
    // 300: the checkout, a gap, the halted gate's line, a bar item's text, the refused notice.
    const [e290, d290, , n290] = await views(290, {})
    expect(cutIn(e290!.body!.header!.checkout)).toBe(true)
    expect(cutIn(e290!.body!.detail!.dimensions[0]!.gaps[0])).toBe(true)
    expect(e290!.body!.attention.some(a => cutIn(a.text))).toBe(true)
    expect(d290!.body!.design!.rows.map(r => cutIn(r.text))).toEqual([true, true])
    expect(cutIn(n290!.body!.notice?.text)).toBe(true)
    // 600: the evidence, the plan gap and the rule clash.
    const [e590] = await views(590, {})
    const d = e590!.body!.detail!
    expect([cutIn(d.dimensions[0]!.evidence), cutIn(d.planGap), cutIn(d.ruleClash)]).toEqual([true, true, true])
  })

  test("a section's text, cut at 8000: the plan and the critic note", async () => {
    for (let k = 7970; k <= 8010; k++) {
      const t = at(k)
      const run = `20261012-sect-${k}`
      const rd = await executeRun(run, 'a gate')
      writeFileSync(planPath(rd), t)
      mkdirSync(join(rd, 'verdicts'), { recursive: true })
      writeFileSync(verdictFile(rd, 'G2', 1), t)
      for (const section of [{ kind: 'plan' as const }, { kind: 'verdict' as const, gate: 'G2' }]) {
        setBoardNav({ ...blankBoardNav(run), run, section })
        const view = await buildBoard(p, litterDir, run, { redact })
        expect({ k, section: section.kind, leaks: leaks(view) }).toEqual({ k, section: section.kind, leaks: [] })
      }
    }
  })

  test('the redacted value reads as the redactor wrote it, and the view is otherwise the one built without it', async () => {
    await seed(5)
    const plain = await build(5, {})
    const redacted = await build(5, { redact })
    const strip = (v: BoardView) => JSON.stringify({ ...v, v: 0 }).split(SECRET).join('[redacted]')
    expect(redacted.map(v => JSON.stringify({ ...v, v: 0 }))).toEqual(plain.map(strip))
    expect(strings(redacted)).toContain(`${'a'.repeat(5)}[redacted] and the rest`)
  })

  test("another redactor, or none, builds again: the last view isn't answered for a build that redacts differently", async () => {
    const run = '20261012-cache'
    await fanoutRun(run, at(3))
    const first = await buildBoard(p, litterDir, run)
    expect(leaks(first).length).toBeGreaterThan(0)
    expect(await buildBoard(p, litterDir, run)).toBe(first)
    const second = await buildBoard(p, litterDir, run, { redact })
    expect(second).not.toBe(first)
    expect(leaks(second)).toEqual([])
    expect(await buildBoard(p, litterDir, run, { redact })).toBe(second)
  })
})
