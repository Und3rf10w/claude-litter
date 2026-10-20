// Tier 2: the finished-run cards (hooks/card/view.ts; WP-CC, COMMON decision
// 8) from ledgers the real ledgercore writes under a scratch litter folder:
// a card for each way a run ends (execute done and halted, design approved
// and holding, fanout done, a workflow that failed); a notification that
// isn't litter's, one before its run's end and the end after it, at the
// next prompt.submit or on the ui tick (cardsTick, WP-CH); the restore
// of the 20 newest of 25 runs with a repair and a resumed generation, each
// ledger read once; an unreadable and a tampered ledger; no write when
// nothing changed, and the refresh's write anyway; a hot reload; cardRow;
// and the [Board] press. WP-DB (the UI review's item 11): the title is the
// run's line as the band and Home draw it (the status's mark and word, then
// `litter` muted), then the recorded outcome, then the evidence: the gate
// that didn't land with its verdict's dimensions in plain words, the land.
// A15: a repair generation, which has no row, shows on the card of the
// generation it took over from, rebuilt on the tick as it records.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { chmodSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CardRender } from '../../hooks/hooktypes'
import type { CardView, CardsView, SwarmSpan } from '../../types/index'
import { appendRecord } from '../../hooks/ledgercore'
import { ledgerDir, runDir, runJsonPath } from '../../hooks/layout'
import { updateSession } from '../../hooks/session'
import { MOD } from '../../hooks/verify'
import { CARD_RUNS, cardRow, cardsTick, deps, duration, noteCards, onCardUi, refreshCards, resetCardsForTests, restoreCards } from '../../hooks/card/view'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const NOW = 1_800_000_000_000
const MIN = 60_000
const BASE = 'a'.repeat(40)
const C1 = '1'.repeat(40)
const C2 = '2'.repeat(40)
const C3 = '3'.repeat(40)

let p: TestPorts
let dir: string
let litterDir: string
let cleanup: () => void
let writes: CardsView[]
let boards: (string | null)[]
let boardAnswer: boolean
/** The runs the live repair swarms work on, as swarm/state.ts would list them. */
let links: { runDir: string; run: string; generation: number }[]
const saved = { ...deps }

beforeEach(() => {
  resetCardsForTests()
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ sessionId: 's1', cwd: dir })
  p.clock.now = NOW
  litterDir = join(dir, '.claude', 'litter')
  updateSession({ litterDir, litterDirError: null })
  writes = []
  const setView = p.setView
  p.setView = async (pane, view) => {
    if (pane === 'cards') writes.push(structuredClone(view as CardsView))
    return setView(pane, view)
  }
  boards = []
  boardAnswer = true
  // The card's [Board] is the person's press: Runs on the run, the keyboard asked for.
  deps.openSection = async (_p, id, run, opts) => {
    expect({ id, opts }).toEqual({ id: 'runs', opts: { focus: true } })
    boards.push(run as string)
    return { placed: boardAnswer, text: '' }
  }
  links = []
  deps.repairRuns = () => links
})

afterEach(() => {
  Object.assign(deps, saved)
  updateSession({ litterDir: null, litterDirError: null })
  resetCardsForTests()
  cleanup()
})

// ---------------------------------------------------------------------------
// Fixtures

type Rec = { kind: string; body: Record<string, unknown> }

let moves = 0
/**
 * A new mtime for a run's ledger folder, later than any before: the file
 * system keeps whole milliseconds, and a test can append twice in one, where
 * the card would see no change.
 */
function moveLedger(run: string): void {
  const at = new Date(Date.now() + ++moves * 1000)
  utimesSync(ledgerDir(runDir(litterDir, run)), at, at)
}

/** Each record through ledgercore, one minute apart on the fake clock, its folder's mtime moved. */
async function record(run: string, recs: readonly Rec[]): Promise<void> {
  for (const r of recs) {
    p.clock.now = (p.clock.now ?? NOW) + MIN
    await appendRecord(p, runDir(litterDir, run), { run, kind: r.kind, by: MOD, body: r.body })
    moveLedger(run)
  }
}

function writeRunJson(run: string, workflow: string, args: Record<string, unknown>, created = NOW): void {
  const json = {
    v: 1,
    run,
    workflow,
    args,
    authorized: [],
    mode: 'default',
    verify: ['bun', 'test'],
    goalCheck: null,
    setup: null,
    linkDirs: [],
    base: BASE,
    ref: `refs/heads/litter/${run}`,
    checkout: dir,
    isolate: false,
    previousBranch: 'main',
    continueOf: null,
    amendOf: null,
    rules: [],
    planPath: null,
    planSha256: null,
    session: 's1',
    created,
  }
  writeFileSync(runJsonPath(runDir(litterDir, run)), `${JSON.stringify(json)}\n`)
}

const start = (workflow: string, run: string): Rec => ({
  kind: 'run.start',
  body: { workflow, base: BASE, ref: `refs/heads/litter/${run}`, checkout: dir, oid: 'd'.repeat(40), session: 's1' },
})
const launch = (taskId: string, generation = 1, kind = 'run.launch'): Rec => ({
  kind,
  body: { taskId, runId: `wf_${taskId}`, scriptPath: null, generation, session: 's1', oid: 'd'.repeat(40) },
})
const end = (taskId: string | null, generation: number, status: string, reason: string | null = null, payload?: Record<string, unknown>): Rec => ({
  kind: 'run.end',
  body: { taskId, generation, status, reason, source: 'notification', ...(payload ? { payload } : {}) },
})
const verify = (id: string, gate: string, attempt: number, green: boolean): Rec => ({
  kind: 'verify',
  body: { verify_id: id, gate, attempt, argv: ['bun', 'test'], tree_before: 'c'.repeat(40), tree_after: 'c'.repeat(40), dirty_submodules: [], exit_code: green ? 0 : 1, signal: null, timed_out: false, spawn_error: null, green, log_parts: 1, log_bytes: 10, output_tail: '' },
})
const dim = (pass: boolean) => ({ pass, evidence: pass ? 'fine' : 'not fine', gaps: [] })
const verdict = (verifyId: string, failing: string[] = [], over: Record<string, unknown> = {}): Rec => ({
  kind: 'verdict',
  body: {
    verify_id: verifyId,
    plan_adherence: dim(!failing.includes('plan_adherence')),
    tests_green: dim(!failing.includes('tests_green')),
    no_regressions: dim(!failing.includes('no_regressions')),
    rules: dim(!failing.includes('rules')),
    plan_gap: '',
    proposed_rules: [],
    ...over,
  },
})
const land = (gate: string, verifyId: string, commit: string): Rec => ({
  kind: 'land',
  body: { gate, verify_id: verifyId, commit, tree: 'c'.repeat(40), old: BASE, ref: 'refs/heads/litter/x' },
})
const GATES = [
  { id: 'G1', title: 'Parse the header' },
  { id: 'G2', title: 'Retry the refresh once' },
  { id: 'G3', title: 'Log the retry' },
]

/** An execute run of three gates, all landed, done. */
async function executeDone(run: string, taskId: string, created = NOW): Promise<void> {
  await record(run, [
    start('execute', run),
    launch(taskId),
    verify(`${run}-1`, 'G1', 1, true),
    verdict(`${run}-1`),
    land('G1', `${run}-1`, C1),
    verify(`${run}-2`, 'G2', 1, true),
    verdict(`${run}-2`),
    land('G2', `${run}-2`, C2),
    verify(`${run}-3`, 'G3', 1, true),
    verdict(`${run}-3`),
    land('G3', `${run}-3`, C3),
    end(taskId, 1, 'done'),
  ])
  writeRunJson(run, 'execute', { gates: GATES, maxAttempts: 3 }, created)
}

const notice = (taskId: string, status = 'completed') =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>Dynamic workflow "litter:execute-run" ${status}</summary>\n</task-notification>`
const submit = (text: string, kind = 'task-notification') => ({ text, origin: { kind }, wait: false }) as never

const textOf = (spans: readonly SwarmSpan[]): string => spans.map(s => s.text).join('')
const linesOf = (card: CardView): string[] => card.lines.map(textOf)
const last = (): CardsView => writes.at(-1)!
const cardOf = (taskId: string): CardView => {
  const c = last().byTask[taskId]
  if (!c) throw new Error(`no card for ${taskId} in ${Object.keys(last().byTask).join(', ')}`)
  return c
}
const span = (card: CardView, text: string): SwarmSpan | undefined => [card.title, ...card.lines].flat().find(s => s.text === text)

/** Every path the fs port reads, lists, stats or checks from now on, in order. */
function spyFs(): string[] {
  const touched: string[] = []
  const { read, list, stat, exists } = p.fs
  p.fs.read = async path => (touched.push(path), read(path))
  p.fs.list = async path => (touched.push(path), list(path))
  p.fs.stat = async (path, options) => (touched.push(path), stat(path, options))
  p.fs.exists = async path => (touched.push(path), exists(path))
  return touched
}

// ---------------------------------------------------------------------------

describe('a card for each way a run ends', () => {
  test('execute, done: the gates landed and the last land, the run cyan, the commit yellow, the time from launch to end', async () => {
    const run = '20261005-exec'
    await executeDone(run, 't-exec')
    await noteCards(p, submit(notice('t-exec')))
    expect(writes).toHaveLength(1)
    const card = cardOf('t-exec')
    // run.launch at minute 2, run.end at minute 12.
    expect(textOf(card.title)).toBe(`✓ done · litter · execute ${run} · 10m 0s`)
    expect(card.title[0]).toEqual({ text: '✓ done', color: 'success', bold: true })
    // litter's name and the time in the muted role, as the band's.
    expect(card.title[2]).toEqual({ text: 'litter', color: 'inactive' })
    expect(card.title.at(-1)).toEqual({ text: '10m 0s', color: 'inactive' })
    expect(span(card, run)?.color).toBe('cyan_FOR_SUBAGENTS_ONLY')
    expect(linesOf(card)).toEqual(['3/3 gates landed · last land 3333333'])
    expect(span(card, '3333333')?.color).toBe('warning')
    expect(card.buttons).toEqual([{ key: `card:board:${run}`, label: 'Board' }])
    expect(card).toEqual(expect.objectContaining({ taskId: 't-exec', run }))
    expect(p.logs).toEqual([])
  })

  test('execute, halted at a gate: the reason, then its attempt with each dimension in plain words, the plan gap, then the gates landed', async () => {
    const run = '20261005-halt'
    await record(run, [
      start('execute', run),
      launch('t-halt'),
      verify('h1', 'G1', 1, true),
      verdict('h1'),
      land('G1', 'h1', C1),
      verify('h2a', 'G2', 1, false),
      verdict('h2a', ['tests_green']),
      verify('h2b', 'G2', 2, false),
      verdict('h2b', ['tests_green', 'no_regressions'], { plan_gap: "the plan doesn't say\nhow long to wait between tries" }),
      end('t-halt', 1, 'halted', 'G2: out of attempts'),
    ])
    writeRunJson(run, 'execute', { gates: GATES, maxAttempts: 2 })
    await noteCards(p, submit(notice('t-halt')))
    const card = cardOf('t-halt')
    expect(card.title[0]).toEqual({ text: '⚑ halted', color: 'warning', bold: true })
    expect(linesOf(card)).toEqual([
      'G2: out of attempts',
      'G2, attempt 2: plan ✓ tests ✕ regressions ✕ rules ✓',
      "plan gap: the plan doesn't say how long to wait between tries",
      '1/3 gates landed · last land 1111111',
    ])
    expect(card.lines[0]![0]!.color).toBe('warning')
    expect(span(card, 'tests ✕')?.color).toBe('error')
    expect(span(card, 'plan ✓')?.color).toBe('success')
    expect(span(card, '1111111')?.color).toBe('warning')
  })

  test("execute, halted on an executor's plan-gap stop after the verdict, and on a rule clash", async () => {
    const stop = '20261005-stop'
    await record(stop, [
      start('execute', stop),
      launch('t-stop'),
      verify('s1', 'G1', 1, false),
      verdict('s1', ['plan_adherence']),
      { kind: 'task.result', body: { task: null, role: 'executor', gate: 'G1', attempt: 2, tool_use_id: 'tu2', result: { status: 'blocked', plan_gap: 'which header wins?', files: [], checks: [], summary: 's', notes: '' } } },
      end('t-stop', 1, 'halted', 'G1: a plan gap'),
    ])
    writeRunJson(stop, 'execute', { gates: GATES.slice(0, 1) })
    const clash = '20261005-clash'
    await record(clash, [
      start('execute', clash),
      launch('t-clash'),
      verify('c1', 'G1', 1, true),
      verdict('c1', [], { rule_clash: 'P-tests-first and L-no-sleeps clash' }),
      end('t-clash', 1, 'halted', 'G1: a rule clash'),
    ])
    writeRunJson(clash, 'execute', { gates: GATES.slice(0, 1) })
    await noteCards(p, submit(`${notice('t-stop')}\n${notice('t-clash')}`))
    expect(writes).toHaveLength(1)
    expect(linesOf(cardOf('t-stop'))).toEqual(['G1: a plan gap', 'G1, attempt 2: its executor stopped before the attempt was judged', 'plan gap: which header wins?', '0/1 gates landed'])
    expect(linesOf(cardOf('t-clash'))).toEqual([
      'G1: a rule clash',
      'G1, attempt 1: plan ✓ tests ✓ regressions ✓ rules ✓',
      'rule clash: P-tests-first and L-no-sleeps clash',
      '0/1 gates landed',
    ])
  })

  test('design, approved with its plan delivered', async () => {
    const run = '20261005-currency'
    const crit = (id: string, v = 'PASS', gap_kind?: string) => ({ id, verdict: v, evidence: 'e', ...(gap_kind ? { gap_kind } : {}) })
    await record(run, [
      start('design', run),
      launch('t-design'),
      { kind: 'proposal', body: { version: 'v1', sha256: 'f'.repeat(64) } },
      { kind: 'verdict', body: { version: 'v1', criteria: [crit('C1', 'FAIL', 'design'), crit('C2'), crit('B1')], overall: 'HOLDING', sha256: 'f'.repeat(64) } },
      { kind: 'proposal', body: { version: 'v2', sha256: 'e'.repeat(64) } },
      { kind: 'verdict', body: { version: 'v2', criteria: [crit('C1'), crit('C2'), crit('B1')], overall: 'APPROVED', sha256: 'e'.repeat(64) } },
      end('t-design', 1, 'done', null, { outcome: 'approved', by: 'approved', version: 'v2' }),
      { kind: 'design.deliver', body: { version: 'v2', sha256: 'e'.repeat(64), path: join(runDir(litterDir, run), 'plan.md') } },
    ])
    writeRunJson(run, 'design', { deliverable: 'plan', bar: [{ id: 'C1' }, { id: 'C2' }, { id: 'B1' }] })
    await noteCards(p, submit(notice('t-design')))
    const card = cardOf('t-design')
    expect(textOf(card.title)).toBe(`✓ done · litter · design ${run} · 5m 0s`)
    expect(linesOf(card)).toEqual(['v2 APPROVED · 3/3 pass', 'plan.md delivered'])
    expect(span(card, 'APPROVED')?.color).toBe('success')
  })

  test('design, holding with open criteria: each with its gap kind, the stop, and why the plan was not delivered', async () => {
    const run = '20261005-hold'
    await record(run, [
      start('design', run),
      launch('t-hold'),
      { kind: 'proposal', body: { version: 'v4', sha256: 'f'.repeat(64) } },
      {
        kind: 'verdict',
        body: {
          version: 'v4',
          criteria: [
            { id: 'C1', verdict: 'PASS', evidence: 'e' },
            { id: 'C3', verdict: 'CONDITIONAL', evidence: 'e', gap_kind: 'investigation' },
            { id: 'C5', verdict: 'FAIL', evidence: 'e', gap_kind: 'design' },
          ],
          overall: 'HOLDING',
          sha256: 'f'.repeat(64),
          source_changed: true,
        },
      },
      end('t-hold', 1, 'done', null, { outcome: 'holding', by: 'max-rounds', version: 'v4' }),
      { kind: 'design.deliver', body: { version: 'v4', refused: 'holding (max-rounds)' } },
    ])
    writeRunJson(run, 'design', { deliverable: 'plan', bar: [{ id: 'C1' }, { id: 'C3' }, { id: 'C5' }, { id: 'C7' }] })
    await noteCards(p, submit(notice('t-hold')))
    const card = cardOf('t-hold')
    // The outcome first, then the version's verdict, then the delivery.
    expect(linesOf(card)).toEqual([
      'holding: max rounds reached',
      'v4 HOLDING · 3 open: C3 investigation, C5 design, C7 not judged · source changed',
      'plan.md not delivered: holding (max-rounds)',
    ])
    expect(span(card, 'HOLDING')?.color).toBe('warning')
  })

  test('design, needing you: the title says so in words, the first line what for in the summary words, in the permission color', async () => {
    const run = '20261005-needs'
    await record(run, [start('design', run), launch('t-needs'), end('t-needs', 1, 'needs_user', 'user-gap', { stopped: 'user-gap' })])
    writeRunJson(run, 'design', { deliverable: 'decision', bar: [] })
    await noteCards(p, submit(notice('t-needs')))
    const card = cardOf('t-needs')
    expect(card.title[0]).toEqual({ text: '⚑ needs you', color: 'permission', bold: true })
    expect(linesOf(card)).toEqual(['for a gap only you can close', 'no version recorded'])
    expect(card.lines[0]![0]!.color).toBe('permission')
  })

  test('fanout, done: the writers done of all, and the land', async () => {
    const run = '20261005-split'
    const result = (task: string, status: string) => ({ kind: 'task.result', body: { task, role: 'executor', tool_use_id: `tu-${task}`, result: { status, files: [], checks: [], summary: 's', notes: '' } } })
    await record(run, [
      start('fanout', run),
      launch('t-fan'),
      result('a', 'done'),
      result('b', 'blocked'),
      result('b', 'done'),
      verify('int', 'integration', 1, true),
      land('fanout', 'int', 'e'.repeat(40)),
      end('t-fan', 1, 'done'),
    ])
    writeRunJson(run, 'fanout', {
      tasks: [
        { id: 'a', title: 'A', writes: true, files: ['a/'] },
        { id: 'b', title: 'B', writes: true, files: ['b/'] },
        { id: 'r', title: 'R', writes: false, files: [] },
      ],
    })
    await noteCards(p, submit(notice('t-fan')))
    const card = cardOf('t-fan')
    expect(linesOf(card)).toEqual(['2/2 writers done · 1 read-only', 'landed eeeeeee'])
    expect(span(card, 'eeeeeee')?.color).toBe('warning')
  })

  test('a workflow that failed at launch: the status and the reason, in the error color; a launch that never opened a generation has no card', async () => {
    const run = '20261005-broke'
    await record(run, [start('execute', run), launch('t-broke'), end('t-broke', 1, 'failed', 'the workflow failed: SyntaxError at line 3')])
    writeRunJson(run, 'execute', { gates: GATES.slice(0, 2) })
    const never = '20261005-never'
    await record(never, [start('execute', never), end(null, 0, 'launch_failed', 'not launched')])
    writeRunJson(never, 'execute', { gates: GATES })
    await noteCards(p, submit(notice('t-broke', 'failed')))
    const card = cardOf('t-broke')
    expect(card.title[0]).toEqual({ text: '✕ failed', color: 'error', bold: true })
    expect(linesOf(card)).toEqual(['the workflow failed: SyntaxError at line 3', '0/2 gates landed'])
    expect(card.lines[0]![0]!.color).toBe('error')
    await restoreCards(p)
    expect(Object.keys(last().byTask)).toEqual(['t-broke'])
  })

  test('a resumed generation says so in its title, and a plan run with a reason gets the reason line', async () => {
    const run = '20261005-plan'
    await record(run, [start('plan', run), launch('t-p1'), end('t-p1', 1, 'interrupted', 'superseded by a resume'), launch('t-p2', 2, 'run.resume'), end('t-p2', 2, 'halted', 'the plan has no gates')])
    writeRunJson(run, 'plan', {})
    await noteCards(p, submit(notice('t-p2')))
    const card = cardOf('t-p2')
    expect(textOf(card.title)).toBe(`⚑ halted · litter · plan ${run} · generation 2 · 1m 0s`)
    expect(linesOf(card)).toEqual(['the plan has no gates'])
  })

  test('every text from the ledger is cleaned and cut to one line', async () => {
    const run = '20261005-dirty'
    await record(run, [start('fanout', run), launch('t-dirty'), end('t-dirty', 1, 'halted', `the merge\u001b[31m stopped\n${'x'.repeat(2000)}`)])
    writeRunJson(run, 'fanout', { tasks: [] })
    await noteCards(p, submit(notice('t-dirty')))
    const line = linesOf(cardOf('t-dirty'))[0]!
    expect(line.startsWith('the merge')).toBe(true)
    expect(line).not.toContain('\n')
    expect(line).not.toContain('\u001b')
    expect(line.length).toBeLessThanOrEqual(300)
  })
})

describe('which notifications get a card', () => {
  test("a notification for a task that isn't litter's changes nothing, and a typed prompt reads nothing", async () => {
    await executeDone('20261005-exec', 't-exec')
    await noteCards(p, submit(notice('b-shell-7')))
    await noteCards(p, submit('fix the parser', 'composer'))
    await noteCards(p, submit(notice('t-exec'), 'composer'))
    expect(writes).toEqual([])
    expect(p.logs).toEqual([])
  })

  test("one before its run's end is recorded waits; once the end is there, the next prompt.submit builds it", async () => {
    const run = '20261005-kill'
    await record(run, [start('execute', run), launch('t-kill'), verify('k1', 'G1', 1, true)])
    writeRunJson(run, 'execute', { gates: GATES })
    await noteCards(p, submit(notice('t-kill', 'killed')))
    expect(writes).toEqual([])
    // The kill settles later, when the run's agents stop (lifecycle.ts, trySettle).
    await record(run, [{ kind: 'run.stopping', body: { taskId: 't-kill', generation: 1 } }, end('t-kill', 1, 'stopped', 'stopped')])
    await noteCards(p, submit('next prompt', 'composer'))
    expect(writes).toHaveLength(1)
    expect(cardOf('t-kill').title[0]).toEqual({ text: '− stopped', color: 'inactive', bold: true })
    // A reason that only repeats the title's status isn't said again.
    expect(linesOf(cardOf('t-kill'))).toEqual(['G1, attempt 1: no verdict recorded', '0/3 gates landed'])
    // Built once: the next prompt reads nothing more and writes nothing.
    await noteCards(p, submit('and another', 'composer'))
    expect(writes).toHaveLength(1)
  })

  test("one before its run's end waits; once the end is recorded, cardsTick writes the card with no prompt.submit", async () => {
    const run = '20261005-late'
    await record(run, [start('execute', run), launch('t-late'), verify('l1', 'G1', 1, true)])
    writeRunJson(run, 'execute', { gates: GATES })
    await noteCards(p, submit(notice('t-late', 'killed')))
    expect(writes).toEqual([])
    // Its ledger hasn't moved: the tick stats it and reads nothing more.
    const touched = spyFs()
    await cardsTick(p)
    expect(touched).toEqual([ledgerDir(runDir(litterDir, run))])
    expect(writes).toEqual([])
    await record(run, [{ kind: 'run.stopping', body: { taskId: 't-late', generation: 1 } }, end('t-late', 1, 'stopped', 'stopped')])
    await cardsTick(p)
    expect(writes).toHaveLength(1)
    expect(cardOf('t-late').title[0]).toEqual({ text: '− stopped', color: 'inactive', bold: true })
    expect(linesOf(cardOf('t-late'))).toEqual(['G1, attempt 1: no verdict recorded', '0/3 gates landed'])
    // Built: nothing waits now, so the next tick and the next prompt read nothing and write nothing.
    touched.length = 0
    await cardsTick(p)
    expect(touched).toEqual([])
    await noteCards(p, submit('next prompt', 'composer'))
    expect(writes).toHaveLength(1)
  })

  test("cardsTick with nothing waiting reads nothing, a notification that isn't litter's included", async () => {
    await executeDone('20261005-exec', 't-exec')
    await noteCards(p, submit(notice('b-shell-7')))
    const touched = spyFs()
    await cardsTick(p)
    expect(touched).toEqual([])
    expect(writes).toEqual([])
    expect(p.logs).toEqual([])
  })

  test("a waiting run's ledger that turns unreadable: one log line, the engine's row kept, and it waits no more", async () => {
    const run = '20261005-gone'
    await record(run, [start('execute', run), launch('t-gone')])
    writeRunJson(run, 'execute', { gates: GATES })
    await noteCards(p, submit(notice('t-gone', 'killed')))
    const ledger = ledgerDir(runDir(litterDir, run))
    const file = join(ledger, readdirSync(ledger).sort()[1]!)
    chmodSync(file, 0o000)
    try {
      // A stray file moves the folder's mtime, so the tick reads the ledger again.
      writeFileSync(join(ledger, 'stray.tmp'), '')
      await cardsTick(p)
      expect(p.logs).toEqual([expect.stringMatching(/^card: task t-gone keeps the engine's row: /)])
      expect(writes).toEqual([])
      const touched = spyFs()
      await cardsTick(p)
      expect(touched).toEqual([])
    } finally {
      chmodSync(file, 0o644)
    }
  })

  test('the same notification again writes nothing', async () => {
    await executeDone('20261005-exec', 't-exec')
    await noteCards(p, submit(notice('t-exec')))
    await noteCards(p, submit(notice('t-exec')))
    expect(writes).toHaveLength(1)
  })

  test("a run found once is known by its task: a later generation's notification reads only its ledger", async () => {
    const run = '20261005-twice'
    await record(run, [start('execute', run), launch('t-a'), end('t-a', 1, 'interrupted', 'superseded by a resume')])
    writeRunJson(run, 'execute', { gates: GATES })
    await noteCards(p, submit(notice('t-a')))
    await record(run, [launch('t-b', 2, 'run.resume'), end('t-b', 2, 'done')])
    await executeDone('20261005-other', 't-other')
    const listed: string[] = []
    const list = p.fs.list
    p.fs.list = async path => (listed.push(path), list(path))
    // t-b isn't in the index yet: the newest changed ledgers are looked in, the run that just ended first.
    await noteCards(p, submit(notice('t-b')))
    expect(Object.keys(last().byTask)).toEqual(['t-a', 't-b'])
    listed.length = 0
    await noteCards(p, submit(notice('t-a')))
    expect(listed).toEqual([ledgerDir(runDir(litterDir, run))])
  })
})

describe('restoreCards and refreshCards', () => {
  test('restore builds the cards of the 20 newest of 25 runs, a repair and a resumed generation among them, reading each ledger once', async () => {
    for (let i = 0; i < 25; i++) {
      const run = `20261001-r${String(i).padStart(2, '0')}`
      // Created out of name order, to show the order is run.find's (the start), not the name.
      await executeDone(run, `t-${i}`, NOW + (i % 2 === 0 ? i : 100 - i) * MIN)
    }
    // A fanout halted, then its repair swarm's generation (no task) landed; and a run resumed.
    const rep = '20261002-repair'
    await record(rep, [
      start('fanout', rep),
      launch('t-rep'),
      end('t-rep', 1, 'halted', 'the integration verify is red'),
      { kind: 'run.repair', body: { generation: 2, swarm: 'fix-1', launch: 'l1', budget: {} } },
      end(null, 2, 'done'),
    ])
    writeRunJson(rep, 'fanout', { tasks: [] }, NOW + 500 * MIN)
    const res = '20261002-resumed'
    await record(res, [start('execute', res), launch('t-res1'), end('t-res1', 1, 'interrupted', 'superseded by a resume'), launch('t-res2', 2, 'run.resume'), end('t-res2', 2, 'done')])
    writeRunJson(res, 'execute', { gates: [] }, NOW + 501 * MIN)

    const listed: string[] = []
    const list = p.fs.list
    p.fs.list = async path => (listed.push(path), list(path))
    await restoreCards(p)
    const ledgerReads = listed.filter(l => l.endsWith('/ledger'))
    expect(ledgerReads).toHaveLength(CARD_RUNS)
    expect(new Set(ledgerReads).size).toBe(CARD_RUNS)

    const byTask = last().byTask
    // The newest 18 of the 25 by their start, and the two newer runs; the repair generation has no task, so no card of its own.
    const starts = Array.from({ length: 25 }, (_, i) => ({ i, at: i % 2 === 0 ? i : 100 - i })).sort((a, b) => b.at - a.at)
    const kept = starts.slice(0, 18).map(s => `t-${s.i}`)
    expect(Object.keys(byTask).sort()).toEqual([...kept, 't-rep', 't-res1', 't-res2'].sort())
    for (const s of starts.slice(18)) expect(byTask[`t-${s.i}`]).toBeUndefined()
    // The generation it took over from shows it: its end, the repair label, and whose it was.
    expect(textOf(byTask['t-rep']!.title)).toBe(`✓ done · litter · fanout ${rep} · repair · 1m 0s`)
    expect(linesOf(byTask['t-rep']!)).toEqual(['repair swarm fix-1 took over when generation 1 halted: the integration verify is red'])
    expect(textOf(byTask['t-res2']!.title)).toContain(' · generation 2 · ')
    expect(textOf(byTask['t-res1']!.title)).not.toContain('generation')
    // Oldest first, so the cap drops the oldest: the newest run's cards come last.
    expect(Object.keys(byTask).slice(-2)).toEqual(['t-res1', 't-res2'])
  })

  test("a ledger that can't be read, or is tampered, keeps its rows the engine's, with one log line each; the others' cards are built", async () => {
    await executeDone('20261005-good', 't-good')
    await executeDone('20261005-locked', 't-locked')
    await executeDone('20261005-forged', 't-forged')
    const locked = ledgerDir(runDir(litterDir, '20261005-locked'))
    const lockedFile = join(locked, readdirSync(locked).sort()[2]!)
    chmodSync(lockedFile, 0o000)
    const forged = ledgerDir(runDir(litterDir, '20261005-forged'))
    // Record 4 rewritten: the chain breaks at record 5, whose `prev` no longer matches.
    const forgedFile = join(forged, readdirSync(forged).sort()[3]!)
    writeFileSync(forgedFile, readFileSync(forgedFile, 'utf8').replace('"verify_id"', '"verify_id" '))
    try {
      await restoreCards(p)
      expect(Object.keys(last().byTask)).toEqual(['t-good'])
      expect(p.logs.filter(l => l.includes('20261005-locked'))).toEqual([expect.stringMatching(/^card: run 20261005-locked's cards weren't built: /)])
      expect(p.logs.filter(l => l.includes('20261005-forged'))).toEqual(["card: run 20261005-forged's ledger is tampered at 5, so its rows keep the engine's drawing"])

      // Their notifications: the tampered run is known and says so; the unreadable one isn't, and is looked for once.
      p.logs.length = 0
      await noteCards(p, submit(`${notice('t-forged')}\n${notice('t-locked')}`))
      expect(writes).toHaveLength(1)
      expect(p.logs).toEqual([
        "card: run 20261005-forged's ledger is tampered at 5, so task t-forged keeps the engine's row",
        expect.stringMatching(/^card: run 20261005-locked's ledger can't be read: /),
      ])
      p.logs.length = 0
      await noteCards(p, submit(notice('t-locked')))
      expect(p.logs).toEqual([])
    } finally {
      chmodSync(lockedFile, 0o644)
    }
  })

  test('restore writes nothing when nothing changed, or when there are no cards; refresh writes anyway', async () => {
    await restoreCards(p)
    expect(writes).toEqual([])
    await executeDone('20261005-exec', 't-exec')
    await restoreCards(p)
    expect(writes).toHaveLength(1)
    await restoreCards(p)
    expect(writes).toHaveLength(1)
    await refreshCards(p)
    expect(writes).toHaveLength(2)
    expect(writes[1]!.byTask).toEqual(writes[0]!.byTask)
    expect(writes[1]!.v).toBeGreaterThan(writes[0]!.v)
    expect(p.views.cards).toEqual(writes[1])
  })

  test('with no litter directory: nothing is read; restore writes nothing and refresh writes an empty view', async () => {
    updateSession({ litterDir: null, litterDirError: 'not a git checkout' })
    await noteCards(p, submit(notice('t-exec')))
    await restoreCards(p)
    expect(writes).toEqual([])
    await refreshCards(p)
    expect(writes.map(w => w.byTask)).toEqual([{}])
  })

  test("after a hot reload a new card is written with the other rows' cards, rebuilt first", async () => {
    await executeDone('20261005-old', 't-old')
    await restoreCards(p)
    // A reload empties module memory; the atom keeps its view.
    resetCardsForTests()
    await executeDone('20261005-new', 't-new', NOW + 100 * MIN)
    await noteCards(p, submit(notice('t-new')))
    expect(Object.keys(last().byTask)).toEqual(['t-old', 't-new'])
  })
})

describe('a repair generation, on the card of the generation it took over from (A15)', () => {
  const repair = (generation: number, swarm: string): Rec => ({ kind: 'run.repair', body: { generation, swarm, launch: `l-${swarm}`, budget: { rounds: 2, agents: 3 } } })

  /** An execute run halted at G2 with a plan gap (its own card four lines), then its repair swarm's generation opened. */
  async function haltedThenRepairing(run: string, taskId: string): Promise<void> {
    await record(run, [
      start('execute', run),
      launch(taskId),
      verify('r1', 'G1', 1, true),
      verdict('r1'),
      land('G1', 'r1', C1),
      verify('r2a', 'G2', 1, false),
      verdict('r2a', ['tests_green'], { plan_gap: 'which retry wins?' }),
      end(taskId, 1, 'halted', 'G2: out of attempts'),
      repair(2, 'fix-g2'),
    ])
    writeRunJson(run, 'execute', { gates: GATES, maxAttempts: 1 })
  }

  test("while it's open the card says the swarm works on it; once its end is recorded the tick shows that end, labelled repair, with no notification", async () => {
    const run = '20261005-mend'
    await haltedThenRepairing(run, 't-mend')
    await noteCards(p, submit(notice('t-mend')))
    const open = cardOf('t-mend')
    expect(textOf(open.title)).toBe(`⚑ halted · litter · execute ${run} · 6m 0s`)
    // What came after the row's own generation is always said: the gates line makes room for it.
    expect(linesOf(open)).toEqual(['G2: out of attempts', 'G2, attempt 1: plan ✓ tests ✕ regressions ✓ rules ✓', 'plan gap: which retry wins?', 'repair swarm fix-g2 is working on it'])
    expect(open.lines.at(-1)).toEqual([{ text: 'repair swarm fix-g2 is working on it', color: 'background' }])

    // A ledger that hasn't moved: one stat a tick, nothing read, nothing written.
    const touched = spyFs()
    await cardsTick(p)
    expect(touched).toEqual([ledgerDir(runDir(litterDir, run))])
    expect(writes).toHaveLength(1)

    await record(run, [verify('r2b', 'G2', 2, true), verdict('r2b'), land('G2', 'r2b', C2), verify('r3', 'G3', 1, true), verdict('r3'), land('G3', 'r3', C3), end(null, 2, 'done')])
    await cardsTick(p)
    expect(writes).toHaveLength(2)
    const done = cardOf('t-mend')
    expect(textOf(done.title)).toBe(`✓ done · litter · execute ${run} · repair · 7m 0s`)
    expect(done.title[0]).toEqual({ text: '✓ done', color: 'success', bold: true })
    expect(linesOf(done)).toEqual(['3/3 gates landed · last land 3333333', 'repair swarm fix-g2 took over when generation 1 halted: G2: out of attempts'])
    expect(done.lines.at(-1)![0]!.color).toBe('inactive')

    // Ended, it isn't watched: the next tick reads nothing.
    touched.length = 0
    await cardsTick(p)
    expect(touched).toEqual([])
    expect(writes).toHaveLength(2)
    expect(p.logs).toEqual([])
  })

  test('a repair started after the card was built: the live repair swarm names its run, so the tick reads it; a link to another folder is left alone', async () => {
    const run = '20261005-later'
    await record(run, [start('fanout', run), launch('t-later'), end('t-later', 1, 'halted', 'the integration verify is red')])
    writeRunJson(run, 'fanout', { tasks: [] })
    await noteCards(p, submit(notice('t-later')))
    expect(linesOf(cardOf('t-later'))).toEqual(['the integration verify is red'])
    // Nothing open when it was read: the tick reads nothing.
    const touched = spyFs()
    await cardsTick(p)
    expect(touched).toEqual([])

    // The person asked for the repair (repair.start), and its swarm went live; another folder's link is never read.
    await record(run, [repair(2, 'fix-1')])
    links = [
      { runDir: runDir(litterDir, run), run, generation: 2 },
      { runDir: join(dir, 'elsewhere', run), run: '20261005-other', generation: 2 },
    ]
    await cardsTick(p)
    expect(touched.filter(t => t.includes('elsewhere') || t.includes('20261005-other'))).toEqual([])
    expect(writes).toHaveLength(2)
    expect(linesOf(cardOf('t-later'))).toEqual(['the integration verify is red', 'repair swarm fix-1 is working on it'])

    // It ended halted: its own reason first, then whose it was.
    await record(run, [end(null, 2, 'halted', 'repair swarm fix-1 ended without a land')])
    await cardsTick(p)
    const halted = cardOf('t-later')
    expect(textOf(halted.title)).toBe(`⚑ halted · litter · fanout ${run} · repair · 1m 0s`)
    expect(linesOf(halted)).toEqual(['repair swarm fix-1 ended without a land', 'repair swarm fix-1 took over when generation 1 halted: the integration verify is red'])

    // The swarm gone: the next tick reads nothing.
    links = []
    touched.length = 0
    await cardsTick(p)
    expect(touched).toEqual([])
    expect(writes).toHaveLength(3)
  })

  test("a later generation's notification rebuilds the run's earlier card too, where it stands", async () => {
    const run = '20261005-again'
    await record(run, [start('execute', run), launch('t-g1'), end('t-g1', 1, 'halted', 'G1: out of attempts')])
    writeRunJson(run, 'execute', { gates: GATES.slice(0, 1) })
    await noteCards(p, submit(notice('t-g1')))
    await executeDone('20261005-between', 't-between')
    await noteCards(p, submit(notice('t-between')))
    // Repaired in another session (nothing here watched it), then resumed.
    await record(run, [repair(2, 'fix-1'), end(null, 2, 'halted', 'repair swarm fix-1 ended without a land'), launch('t-g3', 3, 'run.resume'), end('t-g3', 3, 'done')])
    await noteCards(p, submit(notice('t-g3')))
    expect(Object.keys(last().byTask)).toEqual(['t-g1', 't-between', 't-g3'])
    expect(textOf(cardOf('t-g1').title)).toBe(`⚑ halted · litter · execute ${run} · repair · 1m 0s`)
    expect(textOf(cardOf('t-g3').title)).toBe(`✓ done · litter · execute ${run} · generation 3 · 1m 0s`)
    // A resumed generation has its own row: it isn't on the earlier card.
    expect(linesOf(cardOf('t-g1')).join('\n')).not.toContain('generation 3')
  })

  test("a watched run's ledger that can't be read: one log line, its card kept, not read again until it changes; a tampered one stops the watch", async () => {
    const run = '20261005-sick'
    await haltedThenRepairing(run, 't-sick')
    await noteCards(p, submit(notice('t-sick')))
    const before = cardOf('t-sick')
    const ledger = ledgerDir(runDir(litterDir, run))
    const file = join(ledger, readdirSync(ledger).sort()[1]!)
    chmodSync(file, 0o000)
    try {
      writeFileSync(join(ledger, 'stray.tmp'), '')
      await cardsTick(p)
      expect(p.logs).toEqual([expect.stringMatching(new RegExp(`^card: run ${run}'s cards weren't rebuilt: `))])
      expect(writes).toHaveLength(1)
      // One stat a tick while it's unchanged, and no second log line.
      const touched = spyFs()
      await cardsTick(p)
      expect(touched).toEqual([ledger])
      expect(p.logs).toHaveLength(1)
    } finally {
      chmodSync(file, 0o644)
    }
    // Record 4 rewritten, and the folder's mtime moved: the chain breaks at record 5. The card stays, and the run isn't watched after.
    const forged = join(ledger, readdirSync(ledger).filter(n => n.endsWith('.json')).sort()[3]!)
    writeFileSync(forged, readFileSync(forged, 'utf8').replace('"verify_id"', '"verify_id" '))
    moveLedger(run)
    await cardsTick(p)
    expect(p.logs.at(-1)).toBe(`card: run ${run}'s ledger is tampered at 5, so its cards aren't rebuilt`)
    expect(writes).toHaveLength(1)
    expect(cardOf('t-sick')).toEqual(before)
    const touched = spyFs()
    await cardsTick(p)
    expect(touched).toEqual([])
  })
})

describe('cardRow', () => {
  const rowE = (props: Record<string, unknown>) => ({ surface: 'terminal', component: 'UserMessage', requestId: 'msg-1', props }) as unknown as CardRender
  const task = { id: 't-exec', status: 'completed' }

  test('only a notification row with a task id, expanded or not (WP-CK: an expanded one draws the card above the engine row)', () => {
    expect(cardRow(rowE({ text: 'fix the parser', origin: { kind: 'composer' }, isExpanded: false }))).toBe(false)
    expect(cardRow(rowE({ text: 'fix the parser', origin: { kind: 'composer' }, isExpanded: true }))).toBe(false)
    expect(cardRow(rowE({ text: 'done', origin: { kind: 'task-notification' }, isExpanded: false, task }))).toBe(true)
    expect(cardRow(rowE({ text: 'done', origin: { kind: 'task-notification' }, isExpanded: true, task }))).toBe(true)
    expect(cardRow(rowE({ text: 'done', origin: { kind: 'task-notification' }, isExpanded: false }))).toBe(false)
    expect(cardRow(rowE({ text: 'done', origin: { kind: 'task-notification' }, isExpanded: false, task: { status: 'completed' } }))).toBe(false)
    expect(cardRow(rowE({ text: 'done', origin: { kind: 'task-notification' }, isExpanded: false, task: { id: '' } }))).toBe(false)
  })
})

describe('the [Board] press', () => {
  const press = (element: string) => ({ plugin: 'litter', element, component: 'UserMessage', requestId: 'msg-1', surface: 'terminal' }) as never
  const passOn = (async (e: { element: string }) => ({ element: e.element, passed: true })) as never

  test('opens the board on the run, while it has a run.json', async () => {
    await executeDone('20261005-exec', 't-exec')
    expect(await onCardUi.press(p, press('card:board:20261005-exec'), passOn)).toEqual({ element: 'card:board:20261005-exec' })
    expect(boards).toEqual(['20261005-exec'])
    expect(p.toasts).toEqual([])
  })

  test("a run that's gone toasts that, and a board that isn't placed says what to run", async () => {
    expect(await onCardUi.press(p, press('card:board:20261004-gone'), passOn)).toEqual({ element: 'card:board:20261004-gone' })
    expect(boards).toEqual([])
    expect(p.toasts).toEqual(["run 20261004-gone is gone (its run.json isn't there), so there's no board to open"])
    await executeDone('20261005-exec', 't-exec')
    boardAnswer = false
    await onCardUi.press(p, press('card:board:20261005-exec'), passOn)
    expect(p.toasts.at(-1)).toBe("the board didn't open here; run /litter runs 20261005-exec")
    // An open that throws is the same toast, its reason logged.
    deps.openSection = async () => {
      throw new Error('ui.open refused')
    }
    await onCardUi.press(p, press('card:board:20261005-exec'), passOn)
    expect(p.toasts.at(-1)).toBe("the board didn't open here; run /litter runs 20261005-exec")
    expect(p.logs).toContain("card: Runs didn't open on run 20261005-exec: ui.open refused")
  })

  test("a card key that isn't a run's is answered and does nothing; any other key passes on", async () => {
    expect(await onCardUi.press(p, press('card:board:../../etc'), passOn)).toEqual({ element: 'card:board:../../etc' })
    expect(await onCardUi.press(p, press('card:replay'), passOn)).toEqual({ element: 'card:replay' })
    expect(await onCardUi.press(p, press('board:select:G1'), passOn)).toEqual({ element: 'board:select:G1', passed: true } as never)
    expect(boards).toEqual([])
    expect(p.toasts).toEqual([])
  })
})

test('duration reads as the engine draws one', () => {
  expect(duration(45_400)).toBe('45s')
  expect(duration(125_000)).toBe('2m 5s')
  expect(duration(3_725_000)).toBe('1h 2m')
  expect(duration(-5)).toBe('0s')
})
