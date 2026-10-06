// Tier 1: the board as the engine draws it (WP-AF; plan 12:1479, "board
// rendering from a recorded ledger"). Two recorded runs are laid out in a
// checkout at /repo, ledger files chained as ledgercore writes them: an
// execute run with one landed gate and one halted on a plan gap, and a
// fanout. /litter-board <run> builds the view from them, and the pane draws
// it on the terminal and the desktop: the gate table as the Client there,
// a static table of buttons on VS Code; a pick in the table shows its row's
// detail, [Diff G1] the land's stat, and [Rules] opens the rules pane.
// Phase 5 (WP-CD): the table's right-click menu with only its row's items,
// a pick that copies and one that fills the prompt; on VS Code the selected
// gate's actions as buttons, the critic note among them; and a design run's
// bar × version matrix, its record lines and its [Plan].

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { BoardView } from '../types/index'

const SESSION = 'tier1-session'
const LITTER = '/repo/.claude/litter'
const EXEC = '20261003-api'
const FAN = '20261003-fan'
const STOP = '20261001-stop'
const DESIGN = '20261002-design-ab12cd'
const STOP_GAP = 'the plan never says which header wins when both are sent'
const NOW = 1_800_000_000_000
const BASE = 'a'.repeat(40)
const LANDED = 'b'.repeat(40)
const SURFACES = ['terminal', 'desktop'] as const

const pane = (title: string) =>
  ({ title, isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }) as const

const run = ($: Engine, command: string, args = '') =>
  $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })

type World = {
  files: Map<string, string>
  argv: string[][]
  opened: string[]
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
  const opened: string[] = []
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
    opened.push(e.id)
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

const mountBoard = <S extends 'terminal' | 'desktop' | 'vscode' | 'mobile'>($: Engine, surface: S) =>
  $.ui.mount({ plugin: 'litter', surface, component: 'Pane', requestId: 'litter-board', props: pane('litter board') })

describe('the board, from a recorded ledger', () => {
  for (const surface of SURFACES) {
    test(`an execute run with one landed gate and one halted, on the ${surface}`, async ($, on) => {
      const w = await start($, on)
      const r = await run($, 'litter-board', EXEC)
      expect(r.text).toBe(`the board shows run ${EXEC} (execute, halted)`)
      expect(w.opened).toEqual(['litter-board'])
      const ui = await mountBoard($, surface)
      // The header, left-aligned: status, workflow, branch, base, when.
      expect(await ui.find({ type: 'Text', text: '⚑ halted' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: `branch litter/${EXEC} · base aaaaaaa` })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'started 2027-01-15' })).toBeDefined()
      // The gate table is the Client here, and draws both rows.
      expect(await ui.find({ type: 'Client', key: 'board-gates' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '✓ landed', in: 'board-gates' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '⚑ halted', in: 'board-gates' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '2/3', in: 'board-gates' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'bbbbbbb', in: 'board-gates' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '✕ PA TG', in: 'board-gates' })).toBeDefined()
      // The halted gate is selected by default: its verdict's dimensions, its verify, its plan gap and its rule clash.
      expect(await ui.find({ type: 'Text', text: 'the last verdict, on attempt 2' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'the retry has no backoff' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '− backoff missing' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'verify v-g2b: exit 1' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: `log ${LITTER}/${EXEC}/verify/v-g2b` })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '⚑ plan gap: the plan never says how long to wait between tries' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '⚑ rule clash: P-tests-first and L-no-sleeps clash: the retry test needs a wait' })).toBeDefined()
      // The rule versions it launched with, and its critic's proposal, not accepted.
      expect(await ui.find({ type: 'Text', text: 'P-tests-first@2' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '"Every retry waits with backoff"' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '⚑ proposed, not accepted' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'board:plan' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'board:rules' })).toBeDefined()
      // [Diff] only for a landed gate.
      expect(await ui.find({ key: 'board:diff:G2' })).toBeUndefined()
    })

    test(`a gate whose executor stopped on a plan gap after a verdict: halted, the gap the executor's, the dimensions the verdict's attempt's, on the ${surface}`, async ($, on) => {
      await start($, on)
      expect((await run($, 'litter-board', STOP)).text).toBe(`the board shows run ${STOP} (execute, halted)`)
      const ui = await mountBoard($, surface)
      expect(await ui.find({ type: 'Text', text: '⚑ halted', in: 'board-gates' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '2/3', in: 'board-gates' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'the last verdict, on attempt 1' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '− version missing' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: `⚑ plan gap (the executor stopped on attempt 2): ${STOP_GAP}` })).toBeDefined()
      // The earlier verdict's clash isn't why the run stopped.
      expect(await ui.find({ type: 'Text', text: '⚑ rule clash' })).toBeUndefined()
    })

    test(`a fanout gets its header and its last records, on the ${surface}`, async ($, on) => {
      await start($, on)
      const r = await run($, 'litter-board', FAN)
      expect(r.text).toBe(`the board shows run ${FAN} (fanout, done)`)
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
    await run($, 'litter-board', EXEC)
    const ui = await mountBoard($, 'vscode')
    expect(await ui.find({ type: 'Client' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'board:select:G1' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'board:select:G2' })).toBeDefined()
    // A press on a row selects it: the landed gate's verdict, and [Diff G1].
    await ui.press({ key: 'board:select:G1' })
    expect(await ui.find({ type: 'Text', text: 'G1 as planned' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'board:diff:G1' })).toBeDefined()
  })

  test("a click in the Client table posts the pick, and the row's detail is drawn; [Diff G1] runs git diff --stat on the land's oids", async ($, on) => {
    const w = await start($, on)
    await run($, 'litter-board', EXEC)
    const ui = await mountBoard($, 'terminal')
    // A press resolves once litter's handler has drawn the view. A click or a key
    // in the Client only posts: litter handles the post (a ui.message) after the
    // act resolves, and the act's settle can give up before that's done (it stops
    // at the first 2 ms in which no host call starts or ends while a hook of the
    // test's is held, as mock.clock holds the session's timers). So a read after
    // a post waits for the view that post writes.
    // The header is the table's first row; G1 is the next.
    let drawn = w.nextBoard()
    await ui.pointer({ type: 'down', x: 4, y: 1, button: 'left', in: 'board-gates' })
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

  test('[Rules] opens the rules pane', async ($, on) => {
    const w = await start($, on)
    await run($, 'litter-board', EXEC)
    const ui = await mountBoard($, 'desktop')
    await ui.press({ key: 'board:rules' })
    expect(w.opened).toEqual(['litter-board', 'litter-rules'])
    const rules = await $.ui.mount({ plugin: 'litter', surface: 'desktop', component: 'Pane', requestId: 'litter-rules', props: pane('litter rules') })
    expect(await rules.find({ type: 'Button', key: 'rules:tab:in-force' })).toBeDefined()
  })

  test('with no run named, the newest execute run; a name that is neither a run nor a workflow is said so', async ($, on) => {
    await start($, on)
    expect((await run($, 'litter-board', 'execute')).text).toBe(`the board shows run ${EXEC} (execute, halted)`)
    const bad = await run($, 'litter-board', 'nonsense')
    expect(bad.text).toContain(`"nonsense" isn't a run id`)
  })
})

describe("the gate table's menu (phase 5)", () => {
  // A pick only posts: litter handles the post (a ui.message) after the act
  // resolves, which the act's settle can stop short of, so each read after a
  // pick waits for what it does (its toast, or the view it writes).
  test("a right-click on a row draws its menu with only that row's items; ↓ ⏎ copies the land's full commit id", async ($, on) => {
    const w = await start($, on)
    await run($, 'litter-board', EXEC)
    const ui = await mountBoard($, 'terminal')
    // The header is the table's first row; G1 is the next. The menu is the Client's own state, drawn before the act resolves.
    await ui.pointer({ type: 'down', x: 4, y: 1, button: 'right', in: 'board-gates' })
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
    await run($, 'litter-board', EXEC)
    const ui = await mountBoard($, 'terminal')
    await ui.pointer({ type: 'down', x: 4, y: 2, button: 'right', in: 'board-gates' })
    expect(await ui.find({ type: 'Text', text: 'open critic note', in: 'board-gates' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'copy commit', in: 'board-gates' })).toBeUndefined()
    await ui.pointer({ type: 'down', x: 4, y: 2, button: 'right', in: 'board-gates' })
    expect(await ui.find({ type: 'Text', text: 'open critic note', in: 'board-gates' })).toBeUndefined()

    await ui.pointer({ type: 'down', x: 4, y: 2, button: 'right', in: 'board-gates' })
    const toast = w.nextToast()
    await ui.key({ key: 'return', in: 'board-gates' })
    expect(await toast).toBe('/litter:amend G2 is in the prompt box: add the change and press Enter')
    expect(w.filled).toEqual(['/litter:amend G2 '])

    await ui.pointer({ type: 'down', x: 4, y: 2, button: 'right', in: 'board-gates' })
    const drawn = w.nextBoard()
    await ui.key({ key: 'down', in: 'board-gates' })
    await ui.key({ key: 'return', in: 'board-gates' })
    expect((await drawn).body?.section?.kind).toBe('verdict')
    expect(await ui.find({ type: 'Text', text: 'critic note on G2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: `${LITTER}/${EXEC}/verdicts/G2-2.md` })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: 'the retry has no backoff' })).toBeDefined()
  })

  test("with no Client (VS Code), the selected gate's actions are buttons under the table", async ($, on) => {
    const w = await start($, on)
    await run($, 'litter-board', EXEC)
    const ui = await mountBoard($, 'vscode')
    // G2 is selected: replay and its note, and no copy (it didn't land).
    expect(await ui.find({ type: 'Button', key: 'board:replay:G2' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'board:note:G2' })).toBeDefined()
    expect(await ui.find({ key: 'board:copy:G2' })).toBeUndefined()
    await ui.press({ key: 'board:note:G2' })
    expect(await ui.find({ type: 'Text', text: 'critic note on G2' })).toBeDefined()
    await ui.press({ key: 'board:replay:G2' })
    expect(w.filled).toEqual(['/litter:amend G2 '])
    await ui.press({ key: 'board:select:G1' })
    // The note was G2's, so it closed.
    expect(await ui.find({ type: 'Text', text: 'critic note on G2' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'board:copy:G1', text: "Copy G1's commit" })).toBeDefined()
    await ui.press({ key: 'board:copy:G1' })
    expect(w.copied).toEqual([LANDED])
  })
})

describe('the design view (phase 5)', () => {
  for (const surface of [...SURFACES, 'vscode'] as const) {
    test(`the bar × version matrix above the records, its legend and version lines, and [Plan] on the latest proposal, on the ${surface}`, async ($, on) => {
      await start($, on)
      expect((await run($, 'litter-board', DESIGN)).text).toBe(`the board shows run ${DESIGN} (design, done)`)
      const ui = await mountBoard($, surface)
      expect(await ui.find({ type: 'Client' })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: 'Bar × versions' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'item v1  v2' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'retries once on a 401' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '~d' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '✕w' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'not in the bar' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'gap kind: i investigation, d design, w wording, u user' })).toBeDefined()
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
