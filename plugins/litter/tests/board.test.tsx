// Tier 1: the board as the engine draws it (WP-AF; plan 12:1479, "board
// rendering from a recorded ledger"). Two recorded runs are laid out in a
// checkout at /repo, ledger files chained as ledgercore writes them: an
// execute run with one landed gate and one halted on a plan gap, and a
// fanout. /litter runs <run> builds the view from them, and the `litter`
// pane (phase 5b, WP-DA) draws it as its Runs section on the terminal and the
// desktop: the gate table as the Client there, a static table of buttons on
// VS Code; a pick in the table shows its row's detail, [Diff G1] the land's
// stat, and [Rules] shows Rules in the same pane.
// Phase 5 (WP-CD): the table's right-click menu with only its row's items,
// a pick that copies and one that fills the prompt; on VS Code the selected
// gate's actions as buttons, the critic note among them; and a design run's
// bar × version matrix, its record lines and its [Plan].
// Phase 5b (WP-DC): the run's first lines, what needs you above the table,
// the failing dimensions in words, the selected gate's detail with its
// reason and its actions as Buttons (the one primary per state) on every
// surface, an empty board's next step and [Open]; and the drawings, laid out
// by tests/drawing.ts with the gate table's Client spliced in: an execute run
// going (a gate retried), halted, and ended with every gate landed, a design
// and a fanout, each at 100 and 60 columns with each row's colors.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine, type Mounted } from 'claude-code/testing'
import type { BoardView } from '../types/index'
import { drawText, drawWithColors, findNode, type DrawnNode } from './drawing'

const SESSION = 'tier1-session'
const LITTER = '/repo/.claude/litter'
const EXEC = '20261003-api'
const FAN = '20261003-fan'
const STOP = '20261001-stop'
const GOING = '20261001-going'
const DONE = '20261001-done'
const DESIGN = '20261002-design-ab12cd'
const STOP_GAP = 'the plan never says which header wins when both are sent'
const NOW = 1_800_000_000_000
const BASE = 'a'.repeat(40)
const LANDED = 'b'.repeat(40)
const LANDED2 = 'e'.repeat(40)
const SURFACES = ['terminal', 'desktop'] as const

type Over = { columns?: number; focused?: boolean; placement?: 'dock' | 'inline' }
const pane = (title: string, o: Over = {}) =>
  ({ title, isFocused: o.focused ?? false, bodyColumns: o.columns ?? 120, placement: o.placement ?? 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }) as const

/** `/litter runs [arg]`: Runs in the `litter` pane. */
const runs = ($: Engine, arg = '') =>
  $.command.run({ command: 'litter', args: `runs ${arg}`, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

type World = {
  files: Map<string, string>
  argv: string[][]
  /** Each ui.open: the pane's id, and whether it asked for the keyboard. */
  opened: { id: string; focus: boolean }[]
  copied: string[]
  filled: string[]
  nextBoard: () => Promise<BoardView>
  nextToast: () => Promise<string>
}

/**
 * $.fs from a map, git as a plain checkout at /repo answers it, and `git diff --stat` for the land; what ran, opened, was copied
 * and filled into the prompt; `nextBoard()`, the next board view litter writes ($.state `board`) once it has landed, and
 * `nextToast()`, the next toast.
 */
function world(on: On): World {
  const files = new Map<string, string>()
  const argv: string[][] = []
  const opened: { id: string; focus: boolean }[] = []
  const copied: string[] = []
  const filled: string[] = []
  // Each waiter gets the first board view written after it asked, passed on beneath litter.
  const waiting: ((view: BoardView) => void)[] = []
  const toasted: ((text: string) => void)[] = []
  on('state.set', async (_$, e, next) => {
    const set = await next(e)
    if (e.key === 'board') for (const resolve of waiting.splice(0)) resolve(e.value as BoardView)
    return set
  })
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  const ran = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
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
    const a = [...e.argv]
    argv.push(a)
    if (a[0] === 'mv') {
      const [from, to] = a.slice(-2) as [string, string]
      files.set(to, files.get(from) ?? '')
      files.delete(from)
      return ran(0)
    }
    if (a[0] === 'rm') {
      const path = a[a.length - 1]!
      for (const k of [...files.keys()]) if (k === path || k.startsWith(`${path}/`)) files.delete(k)
      return ran(0)
    }
    if (a[0] === 'git' && a.includes('rev-parse')) {
      if (a.includes('--show-toplevel') && !a.includes('--git-dir')) return ran(0, '/repo\n')
      if (a.includes('--git-dir') && a.includes('--git-common-dir')) return ran(0, '/repo/.git\n/repo/.git\n')
    }
    if (a[0] === 'git' && a.includes('diff') && a.includes('--stat')) return ran(0, ' src/header.ts | 12 ++++++++++--\n 1 file changed, 10 insertions(+), 2 deletions(-)\n')
    return ran(1)
  })
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('agent.list', async () => ({ value: [] }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.toast', async (_$, e) => {
    for (const resolve of toasted.splice(0)) resolve(e.text)
    return { value: undefined }
  })
  on('ui.copy', async (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('ui.open', async (_$, e) => {
    opened.push({ id: e.id, focus: e.focus === true })
    return { value: { isPlaced: true } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.cwd', async () => ({ value: '/repo' }))
  mock.env(on, { HOME: '/home/tier1' })
  return {
    files,
    argv,
    opened,
    copied,
    filled,
    nextBoard: () => new Promise<BoardView>(resolve => waiting.push(resolve)),
    nextToast: () => new Promise<string>(resolve => toasted.push(resolve)),
  }
}

const hex = (buf: ArrayBuffer): string => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

/** A run's ledger, as ledgercore writes it: one file per record, each chained to the sha256 of the one before. */
async function ledger(files: Map<string, string>, run: string, records: { kind: string; body: Record<string, unknown>; by?: Record<string, unknown> }[]): Promise<void> {
  let prev: string | null = null
  for (const [i, r] of records.entries()) {
    const seq = i + 1
    const text = `${JSON.stringify({ v: 1, seq, kind: r.kind, run, at: NOW + seq * 60_000, by: r.by ?? { source: 'mod' }, prev, body: r.body })}\n`
    files.set(`${LITTER}/${run}/ledger/${String(seq).padStart(6, '0')}-${r.kind}.json`, text)
    prev = await sha256(text)
  }
}

const dim = (pass: boolean, evidence: string, gaps: string[] = []) => ({ pass, evidence, gaps })
const verify = (id: string, gate: string, attempt: number, green: boolean) => ({
  verify_id: id,
  gate,
  attempt,
  argv: ['bun', 'test'],
  tree_before: 'c'.repeat(40),
  tree_after: 'c'.repeat(40),
  dirty_submodules: [],
  exit_code: green ? 0 : 1,
  signal: null,
  timed_out: false,
  spawn_error: null,
  green,
  log_parts: 1,
  log_bytes: 10,
  output_tail: '',
})

const PLAN = [
  '# Plan',
  '',
  '### G1: Parse the header',
  'Files: src/header.ts',
  'Checks: bun test',
  'Done when: the header parses',
  '',
  'Parse it.',
  '',
  '### G2: Retry the refresh once',
  'Files: src/refresh.ts',
  'Checks: bun test',
  'Done when: one retry',
  '',
  'Retry it.',
  '',
].join('\n')

/**
 * The execute run: G1 landed (its verdict from before rule_clash), G2 halted
 * on a plan gap and a rule clash at its second attempt; the fanout, done; and
 * an older execute run whose executor stopped on a plan gap at G1's second
 * attempt, after the critic rejected its first.
 */
async function recordRuns(files: Map<string, string>): Promise<void> {
  const json = (run: string, workflow: string, args: Record<string, unknown>, rules: { id: string; version: number }[] = []) =>
    `${JSON.stringify({
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
      checkout: '/repo',
      isolate: false,
      previousBranch: 'main',
      continueOf: null,
      amendOf: null,
      rules,
      planPath: null,
      planSha256: null,
      session: SESSION,
      created: NOW,
    })}\n`
  files.set(
    `${LITTER}/${EXEC}/run.json`,
    json(EXEC, 'execute', { gates: [{ id: 'G1', title: 'Parse the header' }, { id: 'G2', title: 'Retry the refresh once' }], maxAttempts: 3 }, [{ id: 'P-tests-first', version: 2 }]),
  )
  files.set(`${LITTER}/${EXEC}/plan.md`, PLAN)
  const start = (workflow: string, run: string) => ({ workflow, base: BASE, ref: `refs/heads/litter/${run}`, checkout: '/repo', oid: 'd'.repeat(40), session: SESSION })
  const launch = { taskId: 't1', runId: 'wf_1', scriptPath: null, generation: 1, session: SESSION, oid: 'd'.repeat(40) }
  await ledger(files, EXEC, [
    { kind: 'run.start', body: start('execute', EXEC) },
    { kind: 'run.launch', body: launch },
    { kind: 'verify', body: verify('v-g1', 'G1', 1, true) },
    {
      kind: 'verdict',
      body: {
        verify_id: 'v-g1',
        plan_adherence: dim(true, 'G1 as planned'),
        tests_green: dim(true, 'verify v-g1 exit 0'),
        no_regressions: dim(true, 'none'),
        rules: dim(true, 'none apply'),
        plan_gap: '',
        proposed_rules: [],
      },
    },
    { kind: 'land', body: { gate: 'G1', verify_id: 'v-g1', commit: LANDED, tree: 'c'.repeat(40), old: BASE, ref: `refs/heads/litter/${EXEC}` } },
    { kind: 'verify', body: verify('v-g2a', 'G2', 1, false) },
    { kind: 'verify', body: verify('v-g2b', 'G2', 2, false) },
    {
      kind: 'verdict',
      body: {
        verify_id: 'v-g2b',
        plan_adherence: dim(false, 'the retry has no backoff', ['backoff missing']),
        tests_green: dim(false, 'verify v-g2b exit 1'),
        no_regressions: dim(true, 'none'),
        rules: dim(true, 'none apply'),
        plan_gap: 'the plan never says how long to wait between tries',
        rule_clash: 'P-tests-first and L-no-sleeps clash: the retry test needs a wait',
        proposed_rules: [],
      },
    },
    { kind: 'rule.propose', body: { rule: 'Every retry waits with backoff', source: 'critic', tool_use_id: 'tu1', index: 0 } },
    { kind: 'run.end', body: { taskId: 't1', generation: 1, status: 'halted', reason: 'G2: a plan gap', source: 'notification' } },
  ])
  files.set(`${LITTER}/${FAN}/run.json`, json(FAN, 'fanout', { tasks: [{ id: 'a', title: 'A', text: 'do a', writes: true, files: ['a/'] }] }))
  await ledger(files, FAN, [
    { kind: 'run.start', body: start('fanout', FAN) },
    { kind: 'run.launch', body: launch },
    { kind: 'verify', body: verify('v-int', 'integration', 1, true) },
    { kind: 'verdict', body: { verify_id: 'v-int', tasks: [{ id: 'a', pass: true, evidence: 'done', gaps: [] }], combined: 'ok' } },
    { kind: 'run.end', body: { taskId: 't1', generation: 1, status: 'done', reason: null, source: 'notification' } },
  ])
  files.set(`${LITTER}/${STOP}/run.json`, json(STOP, 'execute', { gates: [{ id: 'G1', title: 'Parse the header' }], maxAttempts: 3 }))
  await ledger(files, STOP, [
    { kind: 'run.start', body: start('execute', STOP) },
    { kind: 'run.launch', body: launch },
    { kind: 'verify', body: verify('v-s1', 'G1', 1, false) },
    {
      kind: 'verdict',
      body: {
        verify_id: 'v-s1',
        plan_adherence: dim(false, 'the header has no version', ['version missing']),
        tests_green: dim(false, 'verify v-s1 exit 1'),
        no_regressions: dim(true, 'none'),
        rules: dim(true, 'none apply'),
        plan_gap: '',
        rule_clash: 'P-tests-first and L-no-fixtures clash',
        proposed_rules: [],
      },
    },
    {
      kind: 'task.result',
      body: {
        task: null,
        role: 'executor',
        tool_use_id: 'tu-s2',
        result: { status: 'blocked', plan_lines: ['plan.md:3-8'], files: [], checks: [], notes: 'stopped before changing anything', plan_gap: STOP_GAP },
        gate: 'G1',
        attempt: 2,
      },
    },
    { kind: 'run.end', body: { taskId: 't1', generation: 1, status: 'halted', reason: `G1 plan gap: ${STOP_GAP}`, source: 'notification' } },
  ])
  // G2's critic note, for the menu (phase 5).
  files.set(`${LITTER}/${EXEC}/verdicts/G2-2.md`, '# G2, attempt 2\n\nplan_adherence: the retry has no backoff\n')

  // WP-DC: a run going, G1 landed and G2 sent back on its first attempt (so on its second), G3 waiting;
  // and a run ended done, both its gates landed.
  const three = [
    { id: 'G1', title: 'Parse the header' },
    { id: 'G2', title: 'Retry the refresh once' },
    { id: 'G3', title: 'Log each retry with its wait' },
  ]
  const passed = (verifyId: string) => ({
    verify_id: verifyId,
    plan_adherence: dim(true, 'as planned'),
    tests_green: dim(true, `verify ${verifyId} exit 0`),
    no_regressions: dim(true, 'none'),
    rules: dim(true, 'none apply'),
    plan_gap: '',
    rule_clash: '',
    proposed_rules: [],
  })
  files.set(`${LITTER}/${GOING}/run.json`, json(GOING, 'execute', { gates: three, maxAttempts: 3 }, [{ id: 'P-tests-first', version: 2 }]))
  await ledger(files, GOING, [
    { kind: 'run.start', body: start('execute', GOING) },
    { kind: 'run.launch', body: launch },
    { kind: 'verify', body: verify('v-g1', 'G1', 1, true) },
    { kind: 'verdict', body: passed('v-g1') },
    { kind: 'land', body: { gate: 'G1', verify_id: 'v-g1', commit: LANDED, tree: 'c'.repeat(40), old: BASE, ref: `refs/heads/litter/${GOING}` } },
    { kind: 'verify', body: verify('v-g2', 'G2', 1, false) },
    {
      kind: 'verdict',
      body: {
        ...passed('v-g2'),
        plan_adherence: dim(false, 'the retry waits a fixed second, not with backoff as the plan says', ['backoff missing', 'no cap on the wait', 'the wait is not logged']),
        tests_green: dim(false, 'verify v-g2 exit 1: 2 of 14 tests fail in refresh.test.ts'),
      },
    },
  ])
  files.set(`${LITTER}/${DONE}/run.json`, json(DONE, 'execute', { gates: three.slice(0, 2), maxAttempts: 3 }))
  await ledger(files, DONE, [
    { kind: 'run.start', body: start('execute', DONE) },
    { kind: 'run.launch', body: launch },
    { kind: 'verify', body: verify('v-d1', 'G1', 1, true) },
    { kind: 'verdict', body: passed('v-d1') },
    { kind: 'land', body: { gate: 'G1', verify_id: 'v-d1', commit: LANDED, tree: 'c'.repeat(40), old: BASE, ref: `refs/heads/litter/${DONE}` } },
    { kind: 'verify', body: verify('v-d2a', 'G2', 1, false) },
    { kind: 'verify', body: verify('v-d2b', 'G2', 2, true) },
    { kind: 'verdict', body: passed('v-d2b') },
    { kind: 'land', body: { gate: 'G2', verify_id: 'v-d2b', commit: LANDED2, tree: 'c'.repeat(40), old: LANDED, ref: `refs/heads/litter/${DONE}` } },
    { kind: 'run.end', body: { taskId: 't1', generation: 1, status: 'done', reason: null, source: 'notification' } },
  ])

  // A design run (phase 5): v1 HOLDING with the checkout changed, v2 not judged yet.
  const bar = [
    { id: 'C1', text: 'retries once on a 401', evidence: 'a test' },
    { id: 'C2', text: 'keeps the timeout', evidence: 'the config' },
    { id: 'B1', text: 'no sleep in tests', evidence: 'grep', reason: 'flaky' },
  ]
  files.set(`${LITTER}/${DESIGN}/run.json`, json(DESIGN, 'design', { deliverable: 'plan', bar, empiricalUnknowns: [] }))
  files.set(`${LITTER}/${DESIGN}/proposals/v1.md`, '# Proposal v1\n')
  files.set(`${LITTER}/${DESIGN}/proposals/v2.md`, '# Proposal v2\n\nRetry once, with backoff.\n')
  const critic = { source: 'agent', agentId: 'dc', agentType: 'litter:design-critic' }
  const author = { source: 'agent', agentId: 'au', agentType: 'litter:author' }
  await ledger(files, DESIGN, [
    { kind: 'run.start', body: start('design', DESIGN) },
    { kind: 'run.launch', body: launch },
    { kind: 'proposal', body: { text: 'Proposal v1', version: 'v1', sha256: '1'.repeat(64), gates: [{ id: 'G1' }, { id: 'G2' }] }, by: author },
    {
      kind: 'verdict',
      body: {
        version: 'v1',
        criteria: [
          { id: 'C1', verdict: 'PASS', evidence: 'a test' },
          { id: 'C2', verdict: 'CONDITIONAL', evidence: 'no timeout named', gap_kind: 'design' },
          { id: 'C7', verdict: 'FAIL', evidence: 'not in the bar', gap_kind: 'wording' },
        ],
        overall: 'HOLDING',
        sha256: '1'.repeat(64),
        source_changed: true,
      },
      by: critic,
    },
    { kind: 'proposal', body: { text: 'Proposal v2', version: 'v2', sha256: '2'.repeat(64), gates: [{ id: 'G1' }] }, by: author },
    { kind: 'run.end', body: { taskId: 't1', generation: 1, status: 'done', reason: null, source: 'notification', payload: { outcome: 'holding', by: 'max-rounds', version: 'v2' } } },
  ])
}

/** A session started in /repo, the runs recorded after its start-up (so reconcile leaves them as recorded). */
async function start($: Engine, on: On) {
  mock.store(on)
  const clock = mock.clock(on, { now: NOW + 3_600_000 })
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  await recordRuns(w.files)
  return { ...w, clock }
}

const mountBoard = <S extends 'terminal' | 'desktop' | 'vscode' | 'mobile'>($: Engine, surface: S, o: Over = {}) =>
  $.ui.mount({ plugin: 'litter', surface, component: 'Pane', requestId: 'litter', props: pane('litter', o) })

describe('the board, from a recorded ledger', () => {
  for (const surface of SURFACES) {
    test(`an execute run with one landed gate and one halted, on the ${surface}`, async ($, on) => {
      const w = await start($, on)
      const r = await runs($, EXEC)
      expect(r.text).toBe(`Runs shows run ${EXEC} (execute, halted)`)
      expect(w.opened).toEqual([{ id: 'litter', focus: true }])
      const ui = await mountBoard($, surface)
      // The hub's chrome: `litter · Runs`, the strip with Runs shown.
      expect(await ui.find({ type: 'Text', text: ' · Runs' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'litter:section:rules' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'litter:section:runs' })).toBeUndefined()
      // The first lines: the status bold in its color, the workflow and run; the generation and branch; the base and times muted.
      const status = await ui.find({ type: 'Text', text: '⚑ halted' })
      expect(status?.props).toEqual(expect.objectContaining({ bold: true, color: 'warning' }))
      expect((await ui.find({ type: 'Text', text: EXEC }))?.props.color).toBe('cyan_FOR_SUBAGENTS_ONLY')
      expect((await ui.find({ type: 'Text', text: `litter/${EXEC}` }))?.props.color).toBe('cyan_FOR_SUBAGENTS_ONLY')
      expect((await ui.find({ type: 'Text', text: 'aaaaaaa' }))?.props.color).toBe('inactive')
      expect(await ui.find({ type: 'Text', text: '2027-01-15' })).toBeDefined()
      // What needs you, one line in its color, above the table.
      const halt = await ui.find({ type: 'Text', text: '⚑ needs you · G2 halted on a plan gap: the plan never says how long to wait between tries' })
      expect(halt?.props.color).toBe('permission')
      // The gate table is the Client here, and draws both rows, the failing dimensions in words.
      expect(await ui.find({ type: 'Client', key: 'board-gates' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '✓ landed', in: 'board-gates' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '⚑ halted', in: 'board-gates' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'try 2/3', in: 'board-gates' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'bbbbbbb', in: 'board-gates' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: 'plan ✕ tests ✕', in: 'board-gates' }))?.props.color).toBe('error')
      expect(await ui.find({ type: 'Text', text: 'PA TG', in: 'board-gates' })).toBeUndefined()
      // The halted gate is selected by default: why it stands there, its dimensions spelled out, its verify, its plan gap and its rule clash.
      expect(await ui.find({ type: 'Text', text: '⚑ halted: the critic named a plan gap on attempt 2' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'plan adherence' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'no regressions' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'the retry has no backoff' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '− backoff missing' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'verify v-g2b: exit 1' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: `log ${LITTER}/${EXEC}/verify/v-g2b` })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '⚑ plan gap: the plan never says how long to wait between tries' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '⚑ rule clash: P-tests-first and L-no-sleeps clash: the retry test needs a wait' })).toBeDefined()
      // The rule versions it launched with, and its critic's proposal, not accepted: evidence, each under its heading with its count.
      expect(await ui.find({ type: 'Text', text: 'Rules used' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: 'P-tests-first@2' }))?.props.color).toBe('inactive')
      expect(await ui.find({ type: 'Text', text: 'Proposed in this run' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '"Every retry waits with backoff"' })).toBeDefined()
      // From the run's own ledger, so Rules can't accept it: not waiting on you.
      expect(await ui.find({ type: 'Text', text: '· proposed, not accepted' })).toBeDefined()
      // The material, secondary; the detail's actions, the critic note the one primary.
      expect((await ui.find({ type: 'Button', key: 'board:plan' }))?.props.dimColor).toBe(true)
      expect(await ui.find({ type: 'Button', key: 'board:rules' })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'board:note:G2' }))?.props).toEqual(expect.objectContaining({ label: 'Critic note', variant: 'primary' }))
      expect((await ui.find({ type: 'Button', key: 'board:replay:G2' }))?.props).toEqual(expect.objectContaining({ label: 'Replay with /litter:amend', dimColor: true }))
      expect((await ui.findAll({ type: 'Button' })).filter(b => b.props.variant === 'primary')).toHaveLength(1)
      // [Diff] only for a landed gate.
      expect(await ui.find({ key: 'board:diff:G2' })).toBeUndefined()
      // The keys line (the terminal's), once the pane has the keyboard: the board's own, before the hub's.
      if (surface === 'terminal') {
        await ui.unmount()
        const focused = await mountBoard($, surface, { focused: true })
        const keys = (await focused.findAll({ type: 'Text' })).map(t => t.text)
        const at = keys.indexOf('↑↓')
        expect(keys.slice(at, at + 9)).toEqual(['↑↓', ' gates', ' · ', 'enter', ' select', ' · ', '→', ' actions', ' · '])
      }
    })

    test(`inline, the short form: the first lines, what needs you, the table, the dimensions on one line, no evidence, on the ${surface}`, async ($, on) => {
      await start($, on)
      await runs($, EXEC)
      const ui = await mountBoard($, surface, { columns: 100, placement: 'inline' })
      expect(await ui.find({ type: 'Text', text: '⚑ needs you · G2 halted on a plan gap' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'generation' })).toBeDefined()
      // No base or times, no evidence, no records or rules.
      expect(await ui.find({ type: 'Text', text: 'aaaaaaa' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'the retry has no backoff' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'Rules used' })).toBeUndefined()
      // The dimensions as the row reads them, each word then its mark.
      const words = (await ui.findAll({ type: 'Text' })).map(t => t.text)
      const at = words.indexOf('plan')
      expect(words.slice(at, at + 8)).toEqual(['plan', '✕', 'tests', '✕', 'regressions', '✓', 'rules', '✓'])
      expect(await ui.find({ type: 'Button', key: 'board:note:G2' })).toBeDefined()
    })

    test(`a gate whose executor stopped on a plan gap after a verdict: halted, the gap the executor's, the dimensions the verdict's attempt's, on the ${surface}`, async ($, on) => {
      await start($, on)
      expect((await runs($, STOP)).text).toBe(`Runs shows run ${STOP} (execute, halted)`)
      const ui = await mountBoard($, surface)
      expect(await ui.find({ type: 'Text', text: '⚑ halted', in: 'board-gates' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'try 2/3', in: 'board-gates' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: `⚑ needs you · G1 halted on a plan gap the executor named: ${STOP_GAP}` })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '⚑ halted: the executor stopped on a plan gap on attempt 2' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '− version missing' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: `⚑ plan gap: ${STOP_GAP}` })).toBeDefined()
      // The earlier verdict's clash isn't why the run stopped.
      expect(await ui.find({ type: 'Text', text: '⚑ rule clash' })).toBeUndefined()
    })

    test(`a fanout gets its header and its last records, on the ${surface}`, async ($, on) => {
      await start($, on)
      const r = await runs($, FAN)
      expect(r.text).toBe(`Runs shows run ${FAN} (fanout, done)`)
      const ui = await mountBoard($, surface)
      expect(await ui.find({ type: 'Text', text: '✓ done' })).toBeDefined()
      expect(await ui.find({ type: 'Client' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'Records' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'integration attempt 1: ✓ green' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '1 of 1 tasks pass' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'generation 1: done' })).toBeDefined()
    })
  }

  test('with no Client (VS Code), the gate table is a button per row', async ($, on) => {
    await start($, on)
    await runs($, EXEC)
    const ui = await mountBoard($, 'vscode')
    expect(await ui.find({ type: 'Client' })).toBeUndefined()
    // Each row's id a plain Button, then its cells as the Client's: the state in its color, the failing dimensions in words.
    expect((await ui.find({ type: 'Button', key: 'board:select:G1' }))?.props).toEqual(expect.objectContaining({ label: 'G1', plain: true }))
    expect(await ui.find({ type: 'Button', key: 'board:select:G2' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '⚑ halted' }))?.props.color).toBe('warning')
    expect((await ui.find({ type: 'Text', text: 'plan ✕ tests ✕' }))?.props.color).toBe('error')
    // The selection mark beside G2 alone (the strip's `Home ›` is the hub's).
    expect((await ui.findAll({ type: 'Text', text: '›' })).filter(t => t.text === '›' && t.props.color === 'claude')).toHaveLength(1)
    // A press on a row selects it: the landed gate's verdict, and [Diff G1].
    await ui.press({ key: 'board:select:G1' })
    expect(await ui.find({ type: 'Text', text: 'G1 as planned' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'board:diff:G1' })).toBeDefined()
  })

  test("a click in the Client table posts the pick, and the row's detail is drawn; [Diff G1] runs git diff --stat on the land's oids", async ($, on) => {
    const w = await start($, on)
    await runs($, EXEC)
    const ui = await mountBoard($, 'terminal')
    // A press resolves once litter's handler has drawn the view. A click or a key
    // in the Client only posts: litter handles the post (a ui.message) after the
    // act resolves, and the act's settle can give up before that's done (it stops
    // at the first 2 ms in which no host call starts or ends while a hook of the
    // test's is held, as mock.clock holds the session's timers). So a read after
    // a post waits for the view that post writes.
    // G1 is the table's first row: the heading above it is the pane's (WP-DC).
    let drawn = w.nextBoard()
    await ui.pointer({ type: 'down', x: 4, y: 0, button: 'left', in: 'board-gates' })
    expect((await drawn).body?.gates?.selected).toBe('G1')
    expect(await ui.find({ type: 'Text', text: 'G1 as planned' })).toBeDefined()
    // G1's verdict predates rule_clash, so its detail has no clash line.
    expect(await ui.find({ type: 'Text', text: '⚑ rule clash' })).toBeUndefined()
    await ui.press({ key: 'board:diff:G1' })
    const diff = w.argv.find(a => a[0] === 'git' && a.includes('diff'))
    expect(diff).toEqual(['git', '-C', '/repo', 'diff', '--stat', '--no-color', '--end-of-options', BASE, LANDED, '--'])
    expect(await ui.find({ type: 'Code', text: 'src/header.ts | 12' })).toBeDefined()
    // ↑↓ and Enter post too: back to G2.
    drawn = w.nextBoard()
    await ui.key({ key: 'down', in: 'board-gates' })
    await ui.key({ key: 'return', in: 'board-gates' })
    expect((await drawn).body?.gates?.selected).toBe('G2')
    expect(await ui.find({ type: 'Text', text: 'the retry has no backoff' })).toBeDefined()
    // The diff was G1's, so it closed; [Plan] scrolls to G2's section.
    expect(await ui.find({ type: 'Code' })).toBeUndefined()
    await ui.press({ key: 'board:plan' })
    expect(await ui.find({ type: 'Text', text: 'plan.md from G2 (line 10)' })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: '### G2: Retry the refresh once' })).toBeDefined()
  })

  test('[Rules] shows Rules in the same pane, with the keyboard', async ($, on) => {
    const w = await start($, on)
    await runs($, EXEC)
    const ui = await mountBoard($, 'desktop')
    await ui.press({ key: 'board:rules' })
    expect(w.opened).toEqual([
      { id: 'litter', focus: true },
      { id: 'litter', focus: true },
    ])
    // The one pane draws Rules now, where the board was.
    expect(await ui.find({ type: 'Text', text: ' · Rules' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rules:tab:in-force' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'board:rules' })).toBeUndefined()
  })

  test('with no run named, the newest execute run; a name that is neither a run nor a workflow is said so', async ($, on) => {
    await start($, on)
    expect((await runs($, 'execute')).text).toBe(`Runs shows run ${EXEC} (execute, halted)`)
    const bad = await runs($, 'nonsense')
    expect(bad.text).toContain(`"nonsense" isn't a run id`)
  })
})

describe("the gate table's menu (phase 5)", () => {
  // A pick only posts: litter handles the post (a ui.message) after the act
  // resolves, which the act's settle can stop short of, so each read after a
  // pick waits for what it does (its toast, or the view it writes).
  test("a right-click on a row draws its menu with only that row's items; ↓ ⏎ copies the land's full commit id", async ($, on) => {
    const w = await start($, on)
    await runs($, EXEC)
    const ui = await mountBoard($, 'terminal')
    // G1 is the table's first row. The menu is the Client's own state, drawn before the act resolves.
    await ui.pointer({ type: 'down', x: 4, y: 0, button: 'right', in: 'board-gates' })
    expect(await ui.find({ type: 'Text', text: 'replay with /litter:amend', in: 'board-gates' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'copy commit', in: 'board-gates' })).toBeDefined()
    // G1 has no verdict file: no critic note.
    expect(await ui.find({ type: 'Text', text: 'open critic note', in: 'board-gates' })).toBeUndefined()
    const toast = w.nextToast()
    await ui.key({ key: 'down', in: 'board-gates' })
    await ui.key({ key: 'return', in: 'board-gates' })
    expect(await toast).toBe('copied bbbbbbb (G1)')
    expect(w.copied).toEqual([LANDED])
    expect(await ui.find({ type: 'Text', text: 'copy commit', in: 'board-gates' })).toBeUndefined()
  })

  test("G2's menu has its critic note and no copy; a second right-click closes it; replay fills the prompt, the note opens", async ($, on) => {
    const w = await start($, on)
    await runs($, EXEC)
    const ui = await mountBoard($, 'terminal')
    await ui.pointer({ type: 'down', x: 4, y: 1, button: 'right', in: 'board-gates' })
    expect(await ui.find({ type: 'Text', text: 'open critic note', in: 'board-gates' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'copy commit', in: 'board-gates' })).toBeUndefined()
    await ui.pointer({ type: 'down', x: 4, y: 1, button: 'right', in: 'board-gates' })
    expect(await ui.find({ type: 'Text', text: 'open critic note', in: 'board-gates' })).toBeUndefined()

    await ui.pointer({ type: 'down', x: 4, y: 1, button: 'right', in: 'board-gates' })
    const toast = w.nextToast()
    await ui.key({ key: 'return', in: 'board-gates' })
    expect(await toast).toBe('/litter:amend G2 is in the prompt box: add the change and press Enter')
    expect(w.filled).toEqual(['/litter:amend G2 '])

    await ui.pointer({ type: 'down', x: 4, y: 1, button: 'right', in: 'board-gates' })
    const drawn = w.nextBoard()
    await ui.key({ key: 'down', in: 'board-gates' })
    await ui.key({ key: 'return', in: 'board-gates' })
    expect((await drawn).body?.section?.kind).toBe('verdict')
    expect(await ui.find({ type: 'Text', text: 'critic note on G2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `${LITTER}/${EXEC}/verdicts/G2-2.md` })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: 'the retry has no backoff' })).toBeDefined()
  })

  // The detail's Buttons are the menu's items on every surface: on VS Code (no Client) the only way, beside the Client a shortcut.
  for (const surface of ['vscode', 'terminal'] as const) {
    test(`the selected gate's actions are Buttons in its detail, each doing what its menu item does, on the ${surface}`, async ($, on) => {
      const w = await start($, on)
      await runs($, EXEC)
      const ui = await mountBoard($, surface)
      // G2 is selected: its note, the one primary, and replay; no copy (it didn't land).
      expect((await ui.find({ type: 'Button', key: 'board:note:G2' }))?.props.variant).toBe('primary')
      expect(await ui.find({ type: 'Button', key: 'board:replay:G2' })).toBeDefined()
      expect(await ui.find({ key: 'board:copy:G2' })).toBeUndefined()
      await ui.press({ key: 'board:note:G2' })
      expect(await ui.find({ type: 'Text', text: 'critic note on G2' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: `${LITTER}/${EXEC}/verdicts/G2-2.md` })).toBeDefined()
      await ui.press({ key: 'board:replay:G2' })
      expect(w.filled).toEqual(['/litter:amend G2 '])
      // G1 picked: a static row's Button, or a click in the Client (its post lands after the act, so wait for its view).
      if (surface === 'vscode') await ui.press({ key: 'board:select:G1' })
      else {
        const drawn = w.nextBoard()
        await (ui as Mounted<'terminal', 'Pane'>).pointer({ type: 'down', x: 4, y: 0, button: 'left', in: 'board-gates' })
        await drawn
      }
      // The note was G2's, so it closed. The ended run's landed gate: Copy commit, the primary.
      expect(await ui.find({ type: 'Text', text: 'critic note on G2' })).toBeUndefined()
      expect((await ui.find({ type: 'Button', key: 'board:copy:G1', text: 'Copy commit' }))?.props.variant).toBe('primary')
      await ui.press({ key: 'board:copy:G1' })
      expect(w.copied).toEqual([LANDED])
    })
  }

  test('a run going: a retried gate is activity, not a decision; no replay, and no primary', async ($, on) => {
    await start($, on)
    expect((await runs($, GOING)).text).toBe(`Runs shows run ${GOING} (execute, running)`)
    const ui = await mountBoard($, 'terminal')
    expect((await ui.find({ type: 'Text', text: '↻ repairing G2, try 2 of 3' }))?.props.color).toBe('background')
    expect(await ui.find({ type: 'Text', text: 'needs you' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'the critic sent attempt 1 back (plan adherence and tests green), so attempt 2 of 3 is under way' })).toBeDefined()
    expect(await ui.find({ key: 'board:replay:G2' })).toBeUndefined()
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.props.variant === 'primary')).toHaveLength(0)
    // Three gaps: two shown, then [More] opens them whole and [Less] cuts them again.
    expect(await ui.find({ type: 'Text', text: '1 more gap' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '− the wait is not logged' })).toBeUndefined()
    await ui.press({ key: 'board:more:G2' })
    expect(await ui.find({ type: 'Text', text: '− the wait is not logged' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'board:more:G2', text: 'Less' })).toBeDefined()
    await ui.press({ key: 'board:more:G2' })
    expect(await ui.find({ type: 'Text', text: '1 more gap' })).toBeDefined()
  })

  test("no run of the workflow asked for: why, the skill that starts one, and the newest run's [Open]", async ($, on) => {
    await start($, on)
    expect((await runs($, 'plan')).text).toBe('Runs shows nothing: no plan run yet')
    const ui = await mountBoard($, 'terminal')
    expect(await ui.find({ type: 'Text', text: 'no plan run yet: ' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '/litter:execute' }))?.props.color).toBe('suggestion')
    expect(await ui.find({ type: 'Text', text: 'plans a goal into gates, then implements them' })).toBeDefined()
    const open = await ui.find({ type: 'Button', key: `board:open:${FAN}` })
    expect(open?.props).toEqual(expect.objectContaining({ label: `Open fanout ${FAN}`, variant: 'primary' }))
    await ui.press({ key: `board:open:${FAN}` })
    expect(await ui.find({ type: 'Text', text: '✓ done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: FAN })).toBeDefined()
  })
})

describe('the design view (phase 5)', () => {
  for (const surface of [...SURFACES, 'vscode'] as const) {
    test(`the bar × version matrix above the records, its legend and version lines, and [Plan] on the latest proposal, on the ${surface}`, async ($, on) => {
      await start($, on)
      expect((await runs($, DESIGN)).text).toBe(`Runs shows run ${DESIGN} (design, done)`)
      const ui = await mountBoard($, surface)
      expect(await ui.find({ type: 'Client' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'Bar × versions' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'item v1  v2' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'retries once on a 401' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '~d' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '✕w' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'not in the bar' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: 'gap kind: i investigation, d design, w wording, u user' }))?.props.color).toBe('inactive')
      // The matrix under its heading, the count beside the rule.
      expect((await ui.find({ type: 'Text', text: 'Bar × versions' }))?.props).toEqual(expect.objectContaining({ bold: true, color: 'suggestion' }))
      expect(await ui.find({ type: 'Text', text: '3 items, 2 versions' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'not judged' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'sha256 1111111' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '! source changed' })).toBeDefined()
      // The records: a design verdict reads its overall, never "✓ passes".
      expect(await ui.find({ type: 'Text', text: 'v1 HOLDING · 1/4 pass, open C2 B1 C7' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'v1 · 2 gates' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'passes' })).toBeUndefined()
      await ui.press({ key: 'board:plan' })
      expect(await ui.find({ type: 'Text', text: 'proposal v2' })).toBeDefined()
      expect(await ui.find({ type: 'Code', text: 'Retry once, with backoff.' })).toBeDefined()
    })
  }
})

// ---------------------------------------------------------------------------
// The drawings (WP-DC's report)

/** Replaces `target` in a drawn tree by `by`, the rest kept. */
function replaced(node: unknown, target: unknown, by: unknown): unknown {
  if (node === target) return by
  if (Array.isArray(node)) return node.map(c => replaced(c, target, by))
  if (typeof node !== 'object' || node === null) return node
  const n = node as DrawnNode
  const out: DrawnNode = { ...n }
  if (Array.isArray(n.children)) out.children = n.children.map(c => replaced(c, target, by))
  if (n.props && 'children' in n.props) out.props = { ...n.props, children: replaced(n.props.children, target, by) }
  return out
}

/** The pane as drawn, the gate table's Client replaced by what its module drew, so the drawing has its rows. */
async function drawnWhole(ui: { drawn: (scope?: { in?: string }) => Promise<unknown> }): Promise<unknown> {
  const tree = await ui.drawn()
  const client = findNode(tree, n => n.type === 'Client')
  return client ? replaced(tree, client, await ui.drawn({ in: 'board-gates' })) : tree
}

/** Rows of a drawing with the colors beside each, as drawWithColors writes them. */
const golden = (columns: number, rows: readonly [string, string][]): string[] => rows.map(([text, colors]) => (colors === '' ? text : `${text.padEnd(columns)}  | ${colors}`))

/** The body's rows: from the run's first line (its status glyph) to the last before the hub's keys line, the drawing's last. */
function bodyRows(rows: readonly string[]): string[] {
  const from = rows.findIndex(r => /^(▸|⚑|✓|✕|↻|−|·) /.test(r))
  const body = rows.slice(from, rows.findLastIndex(r => r.trim() !== ''))
  while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop()
  return body
}

const VIEWS: readonly { name: string; run: string; reply: string }[] = [
  { name: 'an execute run going, a gate retried', run: GOING, reply: `Runs shows run ${GOING} (execute, running)` },
  { name: 'an execute run halted', run: EXEC, reply: `Runs shows run ${EXEC} (execute, halted)` },
  { name: 'an execute run ended, every gate landed', run: DONE, reply: `Runs shows run ${DONE} (execute, done)` },
  { name: 'a design run', run: DESIGN, reply: `Runs shows run ${DESIGN} (design, done)` },
  { name: 'a fanout run', run: FAN, reply: `Runs shows run ${FAN} (fanout, done)` },
]

/**
 * The drawings in WP-DC's report: each view's body at 100 and 60 columns in
 * the dock, each row's colors beside it (theme keys: `background` is the
 * running role, `permission` needs-you, `suggestion` heading/path/link,
 * `inactive` muted, `subtle` faint, `cyan_FOR_SUBAGENTS_ONLY` a name,
 * `warning` a SHA, `claude` the accent and the primary Button).
 */
const DRAWINGS: Record<string, Record<number, [string, string][]>> = {
  'an execute run going, a gate retried': {
    100: [
      ['▸ running · execute 20261001-going ─────────────────────────────────────────────────────────────────', 'background bold, subtle, default, cyan_FOR_SUBAGENTS_ONLY, subtle'],
      ['generation 1  branch litter/20261001-going', 'inactive, text, inactive, cyan_FOR_SUBAGENTS_ONLY'],
      ['base aaaaaaa  checkout /repo  started 2027-01-15 08:01 UTC', 'inactive'],
      ['', ''],
      ['↻ repairing G2, try 2 of 3', 'background'],
      ['', ''],
      ['Gates ─────────────────────────────────────── 1 of 3 landed ──  G2 Retry the refresh once ──────────', 'suggestion bold, subtle, inactive, subtle, suggestion bold, subtle'],
      ['  G1 ✓ landed      try 1/3                Parse the header      ▸ the critic sent attempt 1 back', 'default, success, inactive, default, background'],
      ['› G2 ▸ in progress try 2/3 plan ✕ tests ✕ Retry the refresh o…  (plan adherence and tests green), so', 'claude, default bold, background bold, inactive bold, error bold, default bold, background'],
      ['  G3 · waiting                            Log each retry with…  attempt 2 of 3 is under way', 'default, inactive, background'],
      ['  click a gate, ↑↓ enter, → or right-click for actions          ✕ plan adherence', 'inactive, error, default'],
      ['                                                                  the retry waits a fixed second, n…', 'inactive'],
      ['                                                                  − backoff missing', 'warning'],
      ['                                                                  − no cap on the wait', 'warning'],
      ['                                                                  1 more gap', 'inactive'],
      ['                                                                ✕ tests green', 'error, default'],
      ['                                                                  verify v-g2 exit 1: 2 of 14 tests…', 'inactive'],
      ['                                                                ✓ no regressions', 'success, default'],
      ['                                                                  none', 'inactive'],
      ['                                                                ✓ rules', 'success, default'],
      ['                                                                  none apply', 'inactive'],
      ['                                                                verify v-g2: exit 1', 'default'],
      ['                                                                log /repo/.claude/litter/20261001-g…', 'suggestion'],
      ['', ''],
      ['                                                                [ More ]', 'default dim'],
      ['', ''],
      ['[ Rules ]', 'default dim'],
      ['', ''],
      ['Rules used ──────────────────────────────────────────────────────────────────────────────────── 1 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['P-tests-first@2 no longer in force', 'inactive'],
    ],
    60: [
      ['▸ running · execute 20261001-going ─────────────────────────', 'background bold, subtle, default, cyan_FOR_SUBAGENTS_ONLY, subtle'],
      ['generation 1  branch litter/20261001-going', 'inactive, text, inactive, cyan_FOR_SUBAGENTS_ONLY'],
      ['base aaaaaaa  checkout /repo  started 2027-01-15 08:01 UTC', 'inactive'],
      ['', ''],
      ['↻ repairing G2, try 2 of 3', 'background'],
      ['', ''],
      ['Gates ───────────────────────────────────── 1 of 3 landed ──', 'suggestion bold, subtle, inactive, subtle'],
      ['  G1 ✓ landed      try 1/3                Parse the header', 'default, success, inactive, default'],
      ['› G2 ▸ in progress try 2/3 plan ✕ tests ✕ Retry the refresh…', 'claude, default bold, background bold, inactive bold, error bold, default bold'],
      ['  G3 · waiting                            Log each retry wi…', 'default, inactive'],
      ['  click a gate, ↑↓ enter, → or right-click for actions', 'inactive'],
      ['', ''],
      ['G2 Retry the refresh once ──────────────────────────────────', 'suggestion bold, subtle'],
      ['▸ the critic sent attempt 1 back (plan adherence and tests', 'background'],
      ['green), so attempt 2 of 3 is under way', 'background'],
      ['✕ plan adherence', 'error, default'],
      ['  the retry waits a fixed second, not with backoff as the p…', 'inactive'],
      ['  − backoff missing', 'warning'],
      ['  − no cap on the wait', 'warning'],
      ['  1 more gap', 'inactive'],
      ['✕ tests green', 'error, default'],
      ['  verify v-g2 exit 1: 2 of 14 tests fail in refresh.test.ts', 'inactive'],
      ['✓ no regressions', 'success, default'],
      ['  none', 'inactive'],
      ['✓ rules', 'success, default'],
      ['  none apply', 'inactive'],
      ['verify v-g2: exit 1', 'default'],
      ['log /repo/.claude/litter/20261001-going/verify/v-g2', 'suggestion'],
      ['', ''],
      ['[ More ]', 'default dim'],
      ['', ''],
      ['[ Rules ]', 'default dim'],
      ['', ''],
      ['Rules used ──────────────────────────────────────────── 1 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['P-tests-first@2 no longer in force', 'inactive'],
    ],
  },
  'an execute run halted': {
    100: [
      ['⚑ halted · execute 20261003-api ────────────────────────────────────────────────────────────────────', 'warning bold, subtle, default, cyan_FOR_SUBAGENTS_ONLY, subtle'],
      ['generation 1  branch litter/20261003-api', 'inactive, text, inactive, cyan_FOR_SUBAGENTS_ONLY'],
      ['base aaaaaaa  checkout /repo  started 2027-01-15 08:01 UTC  ended 2027-01-15 08:10 UTC', 'inactive'],
      ['', ''],
      ['⚑ needs you · G2 halted on a plan gap: the plan never says how long to wait between tries', 'permission'],
      ['', ''],
      ['Gates ─────────────────────────────────────── 1 of 2 landed ──  G2 Retry the refresh once ──────────', 'suggestion bold, subtle, inactive, subtle, suggestion bold, subtle'],
      ['  G1 ✓ landed try 1/3 bbbbbbb                Parse the header   ⚑ halted: the critic named a plan', 'default, success, inactive, warning, default, warning'],
      ['› G2 ⚑ halted try 2/3         plan ✕ tests ✕ Retry the refres…  gap on attempt 2', 'claude, default bold, warning bold, inactive bold, error bold, default bold, warning'],
      ['  click a gate, ↑↓ enter, → or right-click for actions          ✕ plan adherence', 'inactive, error, default'],
      ['                                                                  the retry has no backoff', 'inactive'],
      ['                                                                  − backoff missing', 'warning'],
      ['                                                                ✕ tests green', 'error, default'],
      ['                                                                  verify v-g2b exit 1', 'inactive'],
      ['                                                                ✓ no regressions', 'success, default'],
      ['                                                                  none', 'inactive'],
      ['                                                                ✓ rules', 'success, default'],
      ['                                                                  none apply', 'inactive'],
      ['                                                                ⚑ plan gap: the plan never says how', 'warning'],
      ['                                                                long to wait between tries', 'warning'],
      ['                                                                ⚑ rule clash: P-tests-first and', 'warning'],
      ['                                                                L-no-sleeps clash: the retry test', 'warning'],
      ['                                                                needs a wait', 'warning'],
      ['                                                                verify v-g2b: exit 1', 'default'],
      ['                                                                log /repo/.claude/litter/20261003-a…', 'suggestion'],
      ['', ''],
      ['                                                                [ Critic note ]', 'claude'],
      ['                                                                [ Replay with /litter:amend ]', 'default dim'],
      ['', ''],
      ['[ Plan ] [ Rules ]', 'default dim'],
      ['', ''],
      ['Rules used ──────────────────────────────────────────────────────────────────────────────────── 1 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['P-tests-first@2 no longer in force', 'inactive'],
      ['', ''],
      ['Proposed in this run ────────────────────────────────────────────────────────────────────────── 1 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['"Every retry waits with backoff"', 'inactive'],
      ['critic · proposed, not accepted', 'inactive'],
    ],
    60: [
      ['⚑ halted · execute 20261003-api ────────────────────────────', 'warning bold, subtle, default, cyan_FOR_SUBAGENTS_ONLY, subtle'],
      ['generation 1  branch litter/20261003-api', 'inactive, text, inactive, cyan_FOR_SUBAGENTS_ONLY'],
      ['base aaaaaaa  checkout /repo  started 2027-01-15 08:01 UTC', 'inactive'],
      ['ended 2027-01-15 08:10 UTC', 'inactive'],
      ['', ''],
      ['⚑ needs you · G2 halted on a plan gap: the plan never says …', 'permission'],
      ['', ''],
      ['Gates ───────────────────────────────────── 1 of 2 landed ──', 'suggestion bold, subtle, inactive, subtle'],
      ['  G1 ✓ landed try 1/3                Parse the header', 'default, success, inactive, default'],
      ['› G2 ⚑ halted try 2/3 plan ✕ tests ✕ Retry the refresh once', 'claude, default bold, warning bold, inactive bold, error bold, default bold'],
      ['  click a gate, ↑↓ enter, → or right-click for actions', 'inactive'],
      ['', ''],
      ['G2 Retry the refresh once ──────────────────────────────────', 'suggestion bold, subtle'],
      ['⚑ halted: the critic named a plan gap on attempt 2', 'warning'],
      ['✕ plan adherence', 'error, default'],
      ['  the retry has no backoff', 'inactive'],
      ['  − backoff missing', 'warning'],
      ['✕ tests green', 'error, default'],
      ['  verify v-g2b exit 1', 'inactive'],
      ['✓ no regressions', 'success, default'],
      ['  none', 'inactive'],
      ['✓ rules', 'success, default'],
      ['  none apply', 'inactive'],
      ['⚑ plan gap: the plan never says how long to wait between', 'warning'],
      ['tries', 'warning'],
      ['⚑ rule clash: P-tests-first and L-no-sleeps clash: the retry', 'warning'],
      ['test needs a wait', 'warning'],
      ['verify v-g2b: exit 1', 'default'],
      ['log /repo/.claude/litter/20261003-api/verify/v-g2b', 'suggestion'],
      ['', ''],
      ['[ Critic note ] [ Replay with /litter:amend ]', 'claude, default dim'],
      ['', ''],
      ['[ Plan ] [ Rules ]', 'default dim'],
      ['', ''],
      ['Rules used ──────────────────────────────────────────── 1 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['P-tests-first@2 no longer in force', 'inactive'],
      ['', ''],
      ['Proposed in this run ────────────────────────────────── 1 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['"Every retry waits with backoff"', 'inactive'],
      ['critic · proposed, not accepted', 'inactive'],
    ],
  },
  'an execute run ended, every gate landed': {
    100: [
      ['✓ done · execute 20261001-done ─────────────────────────────────────────────────────────────────────', 'success bold, subtle, default, cyan_FOR_SUBAGENTS_ONLY, subtle'],
      ['generation 1  branch litter/20261001-done', 'inactive, text, inactive, cyan_FOR_SUBAGENTS_ONLY'],
      ['base aaaaaaa  checkout /repo  started 2027-01-15 08:01 UTC  ended 2027-01-15 08:10 UTC', 'inactive'],
      ['', ''],
      ['Gates ─────────────────────────────────────── 2 of 2 landed ──  G2 Retry the refresh once ──────────', 'suggestion bold, subtle, inactive, subtle, suggestion bold, subtle'],
      ['  G1 ✓ landed try 1/3 bbbbbbb Parse the header                  ✓ landed eeeeeee on attempt 2 of 3', 'default, success, inactive, warning, default, success'],
      ['› G2 ✓ landed try 2/3 eeeeeee Retry the refresh once            ✓ plan adherence', 'claude, default bold, success bold, inactive bold, warning bold, default bold, success, default'],
      ['  click a gate, ↑↓ enter, → or right-click for actions            as planned', 'inactive'],
      ['                                                                ✓ tests green', 'success, default'],
      ['                                                                  verify v-d2b exit 0', 'inactive'],
      ['                                                                ✓ no regressions', 'success, default'],
      ['                                                                  none', 'inactive'],
      ['                                                                ✓ rules', 'success, default'],
      ['                                                                  none apply', 'inactive'],
      ['                                                                verify v-d2b: exit 0, green', 'default'],
      ['                                                                log /repo/.claude/litter/20261001-d…', 'suggestion'],
      ['', ''],
      ['                                                                [ Copy commit ]', 'claude'],
      ['                                                                [ Replay with /litter:amend ]', 'default dim'],
      ['', ''],
      ['[ Diff G2 ] [ Rules ]', 'default dim'],
      ['', ''],
      ['Rules used ──────────────────────────────────────────────────────────────────────────────────── 0 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['none delivered', 'inactive'],
    ],
    60: [
      ['✓ done · execute 20261001-done ─────────────────────────────', 'success bold, subtle, default, cyan_FOR_SUBAGENTS_ONLY, subtle'],
      ['generation 1  branch litter/20261001-done', 'inactive, text, inactive, cyan_FOR_SUBAGENTS_ONLY'],
      ['base aaaaaaa  checkout /repo  started 2027-01-15 08:01 UTC', 'inactive'],
      ['ended 2027-01-15 08:10 UTC', 'inactive'],
      ['', ''],
      ['Gates ───────────────────────────────────── 2 of 2 landed ──', 'suggestion bold, subtle, inactive, subtle'],
      ['  G1 ✓ landed try 1/3 bbbbbbb Parse the header', 'default, success, inactive, warning, default'],
      ['› G2 ✓ landed try 2/3 eeeeeee Retry the refresh once', 'claude, default bold, success bold, inactive bold, warning bold, default bold'],
      ['  click a gate, ↑↓ enter, → or right-click for actions', 'inactive'],
      ['', ''],
      ['G2 Retry the refresh once ──────────────────────────────────', 'suggestion bold, subtle'],
      ['✓ landed eeeeeee on attempt 2 of 3', 'success'],
      ['✓ plan adherence', 'success, default'],
      ['  as planned', 'inactive'],
      ['✓ tests green', 'success, default'],
      ['  verify v-d2b exit 0', 'inactive'],
      ['✓ no regressions', 'success, default'],
      ['  none', 'inactive'],
      ['✓ rules', 'success, default'],
      ['  none apply', 'inactive'],
      ['verify v-d2b: exit 0, green', 'default'],
      ['log /repo/.claude/litter/20261001-done/verify/v-d2b', 'suggestion'],
      ['', ''],
      ['[ Copy commit ] [ Replay with /litter:amend ]', 'claude, default dim'],
      ['', ''],
      ['[ Diff G2 ] [ Rules ]', 'default dim'],
      ['', ''],
      ['Rules used ──────────────────────────────────────────── 0 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['none delivered', 'inactive'],
    ],
  },
  'a design run': {
    100: [
      ['✓ done · design 20261002-design-ab12cd ─────────────────────────────────────────────────────────────', 'success bold, subtle, default, cyan_FOR_SUBAGENTS_ONLY, subtle'],
      ['generation 1  branch litter/20261002-design-ab12cd', 'inactive, text, inactive, cyan_FOR_SUBAGENTS_ONLY'],
      ['base aaaaaaa  checkout /repo  started 2027-01-15 08:01 UTC  ended 2027-01-15 08:06 UTC', 'inactive'],
      ['', ''],
      ['Bar × versions ────────────────────────────────────────────────────────────── 3 items, 2 versions ──', 'suggestion bold, subtle, inactive, subtle'],
      ['  item v1  v2', 'inactive'],
      ['  C1   ✓   ·   retries once on a 401', 'text, success, inactive'],
      ['  C2   ~d  ·   keeps the timeout', 'text, warning, inactive'],
      ['  B1   ·   ·   no sleep in tests', 'text, inactive'],
      ['  C7   ✕w  ·   not in the bar', 'warning, error, inactive, warning'],
      ['  ✓ PASS  ~ CONDITIONAL  ✕ FAIL  · not judged  ·  gap kind: i investigation, d design, w wording, u…', 'inactive'],
      ['  v1   HOLDING sha256 1111111 ! source changed', 'default bold, warning'],
      ['  v2   not judged sha256 2222222', 'default bold, inactive, warning'],
      ['', ''],
      ['[ Plan ] [ Rules ]', 'default dim'],
      ['', ''],
      ['Records ────────────────────────────────────────────────────────────────────────────── the last 6 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['   1 run.start design run from aaaaaaa on litter/20261002-design-ab12cd', 'inactive'],
      ['   2 run.launch generation 1, task t1', 'inactive'],
      ['   3 proposal v1 · 2 gates', 'inactive'],
      ['   4 verdict v1 HOLDING · 1/4 pass, open C2 B1 C7', 'inactive'],
      ['   5 proposal v2 · 1 gate', 'inactive'],
      ['   6 run.end generation 1: done', 'inactive'],
      ['', ''],
      ['Rules used ──────────────────────────────────────────────────────────────────────────────────── 0 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['none delivered', 'inactive'],
    ],
    60: [
      ['✓ done · design 20261002-design-ab12cd ─────────────────────', 'success bold, subtle, default, cyan_FOR_SUBAGENTS_ONLY, subtle'],
      ['generation 1  branch litter/20261002-design-ab12cd', 'inactive, text, inactive, cyan_FOR_SUBAGENTS_ONLY'],
      ['base aaaaaaa  checkout /repo  started 2027-01-15 08:01 UTC', 'inactive'],
      ['ended 2027-01-15 08:06 UTC', 'inactive'],
      ['', ''],
      ['Bar × versions ────────────────────── 3 items, 2 versions ──', 'suggestion bold, subtle, inactive, subtle'],
      ['  item v1  v2', 'inactive'],
      ['  C1   ✓   ·   retries once on a 401', 'text, success, inactive'],
      ['  C2   ~d  ·   keeps the timeout', 'text, warning, inactive'],
      ['  B1   ·   ·   no sleep in tests', 'text, inactive'],
      ['  C7   ✕w  ·   not in the bar', 'warning, error, inactive, warning'],
      ['  ✓ PASS  ~ CONDITIONAL  ✕ FAIL  · not judged  ·  gap kind:…', 'inactive'],
      ['  v1   HOLDING sha256 1111111 ! source changed', 'default bold, warning'],
      ['  v2   not judged sha256 2222222', 'default bold, inactive, warning'],
      ['', ''],
      ['[ Plan ] [ Rules ]', 'default dim'],
      ['', ''],
      ['Records ────────────────────────────────────── the last 6 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['   1 run.start design run from aaaaaaa on litter/20261002-d…', 'inactive'],
      ['   2 run.launch generation 1, task t1', 'inactive'],
      ['   3 proposal v1 · 2 gates', 'inactive'],
      ['   4 verdict v1 HOLDING · 1/4 pass, open C2 B1 C7', 'inactive'],
      ['   5 proposal v2 · 1 gate', 'inactive'],
      ['   6 run.end generation 1: done', 'inactive'],
      ['', ''],
      ['Rules used ──────────────────────────────────────────── 0 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['none delivered', 'inactive'],
    ],
  },
  'a fanout run': {
    100: [
      ['✓ done · fanout 20261003-fan ───────────────────────────────────────────────────────────────────────', 'success bold, subtle, default, cyan_FOR_SUBAGENTS_ONLY, subtle'],
      ['generation 1  branch litter/20261003-fan', 'inactive, text, inactive, cyan_FOR_SUBAGENTS_ONLY'],
      ['base aaaaaaa  checkout /repo  started 2027-01-15 08:01 UTC  ended 2027-01-15 08:05 UTC', 'inactive'],
      ['', ''],
      ['[ Rules ]', 'default dim'],
      ['', ''],
      ['Records ────────────────────────────────────────────────────────────────────────────── the last 5 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['   1 run.start fanout run from aaaaaaa on litter/20261003-fan', 'inactive'],
      ['   2 run.launch generation 1, task t1', 'inactive'],
      ['   3 verify integration attempt 1: ✓ green', 'inactive'],
      ['   4 verdict 1 of 1 tasks pass', 'inactive'],
      ['   5 run.end generation 1: done', 'inactive'],
      ['', ''],
      ['Rules used ──────────────────────────────────────────────────────────────────────────────────── 0 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['none delivered', 'inactive'],
    ],
    60: [
      ['✓ done · fanout 20261003-fan ───────────────────────────────', 'success bold, subtle, default, cyan_FOR_SUBAGENTS_ONLY, subtle'],
      ['generation 1  branch litter/20261003-fan', 'inactive, text, inactive, cyan_FOR_SUBAGENTS_ONLY'],
      ['base aaaaaaa  checkout /repo  started 2027-01-15 08:01 UTC', 'inactive'],
      ['ended 2027-01-15 08:05 UTC', 'inactive'],
      ['', ''],
      ['[ Rules ]', 'default dim'],
      ['', ''],
      ['Records ────────────────────────────────────── the last 5 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['   1 run.start fanout run from aaaaaaa on litter/20261003-f…', 'inactive'],
      ['   2 run.launch generation 1, task t1', 'inactive'],
      ['   3 verify integration attempt 1: ✓ green', 'inactive'],
      ['   4 verdict 1 of 1 tasks pass', 'inactive'],
      ['   5 run.end generation 1: done', 'inactive'],
      ['', ''],
      ['Rules used ──────────────────────────────────────────── 0 ──', 'suggestion bold, subtle, inactive, subtle'],
      ['none delivered', 'inactive'],
    ],
  },
}

describe('the drawings', () => {
  for (const v of VIEWS) {
    for (const columns of [100, 60]) {
      test(`${v.name} at ${columns} columns`, async ($, on) => {
        await start($, on)
        expect((await runs($, v.run)).text).toBe(v.reply)
        const ui = await mountBoard($, 'terminal', { columns })
        const tree = await drawnWhole(ui)
        const expected = DRAWINGS[v.name]?.[columns]
        expect(expected).toBeDefined()
        expect(bodyRows(drawWithColors(tree, columns))).toEqual(golden(columns, expected ?? []))
      })
    }
  }

  test('a tampered ledger is an exception above everything, never folded into the first lines', async ($, on) => {
    const w = await start($, on)
    const third = `${LITTER}/${EXEC}/ledger/000003-verify.json`
    w.files.set(third, w.files.get(third)!.replace('"green":true', '"green":false'))
    expect((await runs($, EXEC)).text).toBe(`Runs shows run ${EXEC} (execute, ledger_tampered)`)
    const ui = await mountBoard($, 'terminal', { columns: 100 })
    const rows = drawText(await drawnWhole(ui), 100)
    const at = (text: string) => rows.findIndex(r => r.includes(text))
    expect(at('✕ ledger tampered at 4: nothing from that record on is acted on')).toBeGreaterThan(-1)
    expect(at('✕ ledger tampered · execute 20261003-api')).toBeGreaterThan(at('✕ ledger tampered at 4'))
    expect((await ui.find({ type: 'Text', text: '✕ ledger tampered at 4' }))?.props.color).toBe('error')
  })

  test('what needs you is above the table, the material under it, the evidence last', async ($, on) => {
    await start($, on)
    await runs($, EXEC)
    const ui = await mountBoard($, 'terminal', { columns: 100 })
    const rows = drawText(await drawnWhole(ui), 100)
    const at = (text: string) => rows.findIndex(r => r.includes(text))
    expect(at('⚑ needs you · G2 halted')).toBeGreaterThan(at('⚑ halted · execute'))
    expect(at('Gates')).toBeGreaterThan(at('⚑ needs you · G2 halted'))
    expect(at('[ Plan ]')).toBeGreaterThan(at('Gates'))
    expect(at('Rules used')).toBeGreaterThan(at('[ Plan ]'))
    // Wide: the detail beside the table, on the heading's row.
    expect(rows[at('Gates')]).toContain('G2 Retry the refresh once')
    await ui.unmount()
    const narrow = drawText(await drawnWhole(await mountBoard($, 'terminal', { columns: 60 })), 60)
    const nat = (text: string) => narrow.findIndex(r => r.includes(text))
    // Narrow: under it.
    expect(nat('G2 Retry the refresh once')).toBeGreaterThan(nat('Gates'))
    expect(narrow[nat('Gates')]).not.toContain('G2 Retry')
  })
})
