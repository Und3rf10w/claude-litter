// Tier 1: the swarm panes as the engine draws them (WP-N). Every view, fed to
// register.tsx's ui.render hooks through a state.get hook beneath, mounts on
// the terminal and the desktop (a mount rejects a tree the surface refuses);
// the tree is the Client where the surface has one and plain buttons where it
// hasn't; a press on [Launch], [Send], [Stop node] and [End swarm] reaches its
// owner (the pane logs each owner call before making it, so this holds with
// the owners' stubs and with their bodies); and the two commands answer and
// open their panes. The plugin's module state isn't the test's, so the pane's
// navigation is seeded through $.store, as a reload finds it.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type {
  DoctorPaneView,
  SwarmBrowserView,
  SwarmBuilderView,
  SwarmHistoryView,
  SwarmPaneView,
  SwarmProposalView,
  SwarmRecoveryView,
  SwarmStartView,
  SwarmTreeRow,
  SwarmUnsettledView,
} from '../types/index'

const SURFACES = ['terminal', 'desktop'] as const
const SESSION = 'tier1-session'
const LITTER = '/repo/.claude/litter'

const pane = (title: string, bodyColumns = 100) =>
  ({ title, isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} }) as const

const row = (id: string, over: Partial<SwarmTreeRow> = {}): SwarmTreeRow => ({
  id,
  node: id === '@lead' ? null : id.split('/').at(-1)!,
  kind: id === '@lead' ? 'lead' : id.includes('/') ? 'worker' : 'orchestrator',
  depth: id === '@lead' ? 0 : id.split('/').length,
  label: id === '@lead' ? 'lead (this session)' : id.split('/').at(-1)!,
  detail: '',
  color: id === '@lead' ? null : 'blue_FOR_SUBAGENTS_ONLY',
  dim: id.includes('/'),
  mark: null,
  markColor: null,
  ...over,
})

const TITLE = (text: string) => [{ text: 'litter · ', bold: true }, { text, bold: true }]

const START: SwarmStartView = {
  view: 'start',
  v: 1,
  title: TITLE('new swarm'),
  notice: { text: 'asked the lead', level: 'ok' },
  blocked: null,
  name: 'demo',
  ask: '',
  templates: [
    { id: 'builtin:fan-out', name: 'fan-out', description: 'one worker per part', scope: 'builtin' },
    { id: 'user:mine', name: 'mine', description: 'mine', scope: 'user' },
  ],
  template: {
    id: 'builtin:fan-out',
    name: 'fan-out',
    description: 'one worker per part',
    params: [{ name: 'parts', list: true, description: 'one per part', value: 'a, b', suggestions: ['main', 'feature/x'] }],
    errors: [],
  },
  swarms: [{ name: 'demo', goal: 'ship the parser', revision: 2, nodes: 3, live: false }],
}

const BUILDER: SwarmBuilderView = {
  view: 'builder',
  v: 2,
  title: [...TITLE('swarm builder · demo'), { text: ' (unsaved)', color: 'gray' }],
  notice: null,
  swarm: 'demo',
  base: 1,
  unsaved: false,
  live: false,
  blocked: null,
  tree: { swarm: 'demo', rows: [row('@lead'), row('part-a'), row('part-a/fixer', { mark: '✕', markColor: 'error' })], selected: 'part-a/fixer', editable: true, workers: ['fixer'] },
  inspector: {
    title: 'fixer · worker',
    fields: [
      { key: 'swarm:builder:field:demo/fixer/kind', label: 'Kind', kind: 'text', value: 'worker under part-a', options: [], placeholder: '', badge: null, note: null, noteColor: null },
      {
        key: 'swarm:builder:field:demo/fixer/model',
        label: 'Model',
        kind: 'select',
        value: '',
        options: [
          { value: '', label: 'not set' },
          { value: 'inherit', label: 'inherit' },
        ],
        placeholder: '',
        badge: 'engine',
        note: "not set: the parent's model",
        noteColor: 'inactive',
      },
      { key: 'swarm:builder:field:demo/fixer/maxTurns', label: 'Max turns', kind: 'input', value: 'lots', options: [], placeholder: 'a whole number', badge: 'engine', note: 'max turns is a whole number above 0', noteColor: 'error' },
      {
        key: 'swarm:builder:field:demo/fixer/authority.push',
        label: 'Push',
        kind: 'select',
        value: '',
        options: [
          { value: '', label: 'not set' },
          { value: 'none', label: 'none' },
        ],
        placeholder: '',
        badge: '—',
        note: 'not set: not checked by litter',
        noteColor: 'inactive',
      },
    ],
  },
  brief: { node: 'fixer', markdown: '# Fixer\n\nFix what the tests say.', more: true, href: 'file:///repo/.claude/litter/swarms/demo/briefs/fixer.md', differs: false },
  strip: [
    { glyph: '✕', color: 'error', text: 'nodes.fixer.maxTurns: too many' },
    { glyph: '!', color: 'warning', text: 'the session cap is low' },
  ],
  checking: false,
  askLead: '',
  saveAs: { name: 'demo', description: '', scope: 'user', candidates: [{ id: 'goal', label: 'the goal', value: 'ship the parser', param: true }] },
  proposals: [1],
  unreadable: [],
}

const PROPOSAL: SwarmProposalView = {
  view: 'proposal',
  v: 3,
  title: TITLE("swarm builder · demo · lead's proposal (rev 1 → 2)"),
  notice: null,
  swarm: 'demo',
  n: 1,
  from: 1,
  to: 2,
  tree: { swarm: 'demo', rows: [row('@lead'), row('part-a', { mark: '~', markColor: 'warning' }), row('part-a/reviewer', { mark: '+', markColor: 'diffAddedWord' })], selected: null, editable: false, workers: [] },
  changes: [
    { index: 0, glyph: '~', color: 'warning', path: 'nodes.fixer.model', text: '"sonnet" → "opus"', reason: 'the parser is hard', conflict: true, yours: '"haiku"', picked: false },
    { index: 1, glyph: '+', color: 'diffAddedWord', path: 'nodes.reviewer', text: '{"id":"reviewer"}', reason: null, conflict: false, yours: null, picked: true },
  ],
  briefs: [
    {
      node: 'fixer',
      glyph: '~',
      color: 'warning',
      reason: 'clearer',
      conflict: false,
      withNode: false,
      open: true,
      lines: [
        { text: '− old', color: 'diffRemovedWord' },
        { text: '+ new', color: 'diffAddedWord' },
      ],
      yoursLines: [],
      picked: true,
    },
  ],
  counts: '1 added, 0 removed, 1 changed, 1 brief, 1 conflict',
  decided: null,
  picked: 2,
}

const BROWSER: SwarmBrowserView = {
  view: 'browser',
  v: 4,
  title: [...TITLE('swarm demo'), { text: ' · live 2m', color: 'background' }, { text: ' · 2 agents · 2k tokens' }],
  notice: null,
  swarm: 'demo',
  launch: '20270115-093000',
  state: 'live',
  readOnly: false,
  lost: false,
  owner: null,
  budget: null,
  summary: { goal: 'parser first', progress: ['tokenizer done'], waiting: ['which branch'], age: '1m ago', stale: true },
  rows: [
    { key: 'lead', agentId: null, depth: 0, name: 'lead', color: null, dim: false, status: 'idle', statusGlyph: '', statusColor: 'inactive', tool: '', turns: null, tokens: '', report: '', queued: [], question: null, flagged: false },
    { key: 'o1', agentId: 'o1', depth: 1, name: 'part-a', color: 'blue_FOR_SUBAGENTS_ONLY', dim: false, status: 'waiting', statusGlyph: '⚑', statusColor: 'warning', tool: 'Bash', turns: 3, tokens: '2k', report: '', queued: [], question: 'which branch?', flagged: false },
    { key: 'w1', agentId: 'w1', depth: 2, name: 'fixer', color: 'blue_FOR_SUBAGENTS_ONLY', dim: true, status: 'done', statusGlyph: '✓', statusColor: 'success', tool: '', turns: 1, tokens: '800', report: 'fixed it', queued: [{ id: 'q1', text: 'also the lexer' }], question: null, flagged: true },
  ],
  flags: [{ seq: 7, kind: 'branch-moved', text: 'refs/heads/main moved aaaaaaa → bbbbbbb while fixer ran', running: ['fixer'] }],
  events: [{ at: '09:30', who: 'you → part-a', text: 'direct, interject: "go"', color: null }],
  composer: {
    to: 'w1',
    address: 'fixer#1',
    targets: [
      { value: 'o1', label: 'part-a' },
      { value: 'w1', label: 'fixer' },
    ],
    text: 'hello',
    when: 'interject',
    route: 'direct',
    routes: [
      { value: 'direct', label: "via parent (it's idle)" },
      { value: 'lead', label: 'Via lead' },
      { value: 'parent', label: 'Via parent' },
    ],
    offerQueue: true,
  },
  transcript: { agentId: 'w1', name: 'fixer', readable: true, lines: [{ text: '◆ looking at the tokenizer' }, { text: '  ↳ Read', color: 'subtle' }] },
  selected: 'w1',
}

/** A repair swarm (2b-2): its run in the header, its budget row with a part used up, and its gate and budget events. */
const REPAIR: SwarmBrowserView = {
  ...BROWSER,
  title: [...TITLE('swarm repair-0a1b2c'), { text: ' · live 2m', color: 'background' }, { text: ' · 3 agents · 4k tokens' }, { text: ' · repairs run 20261003-api' }],
  swarm: 'repair-0a1b2c',
  budget: {
    run: '20261003-api',
    generation: 2,
    rounds: { used: 3, of: 3, text: 'rounds 3 of 3, all used', glyph: '!', color: 'warning' },
    agents: { used: 2, of: 6, text: 'agents 2 of 6', glyph: '', color: null },
    note: 'no verdict past its last round is taken, until you grant more when the lead asks (repair.budget)',
  },
  events: [
    { at: '09:31', who: 'fixer', text: 'verify v-1: ✕ red', color: 'error' },
    { at: '09:32', who: 'critic', text: 'verdict, round 1, on v-2: ✕ rejected', color: 'error' },
    { at: '09:33', who: 'lead', text: 'asked for more budget (rounds 2): ✓ granted, now 5 rounds, 6 agents', color: 'success' },
    { at: '09:34', who: 'repair', text: 'land of v-3: ✓ landed', color: 'success' },
  ],
  composer: null,
  flags: [],
}

const READ_ONLY: SwarmBrowserView = {
  ...BROWSER,
  readOnly: true,
  composer: null,
  flags: [],
  owner: { text: 'owned by session other on box', canTakeOver: true, why: null },
}

const HISTORY: SwarmHistoryView = { view: 'history', v: 5, title: TITLE('swarm demo · goal history'), notice: null, swarm: 'demo', entries: [{ at: '09:31', goal: 'parser first' }] }

const RECOVERY: SwarmRecoveryView = {
  view: 'recovery',
  v: 6,
  title: TITLE('swarm demo · recreated after a restart'),
  notice: null,
  swarm: 'demo',
  launch: '20270115-093000',
  stopping: false,
  rows: [
    {
      node: 'part-a',
      kind: 'orchestrator',
      pickable: true,
      resumable: true,
      picked: true,
      note: '',
      instances: [{ agentId: 'o1', name: 'part-a #1', state: 'settled', glyph: '✓', color: 'success', report: 'half done', respawnOnly: false }],
    },
    {
      node: 'part-c',
      kind: 'orchestrator',
      pickable: true,
      resumable: false,
      picked: false,
      note: 're-spawn only',
      instances: [{ agentId: 'o3', name: 'part-c #1', state: 'gone', glyph: '−', color: 'inactive', report: '', respawnOnly: true }],
    },
    {
      node: 'fixer',
      kind: 'worker',
      pickable: false,
      resumable: false,
      picked: false,
      note: 'comes back through part-a',
      instances: [{ agentId: 'w2', name: 'fixer #2', state: 'gone', glyph: '−', color: 'inactive', report: '', respawnOnly: true }],
    },
  ],
}

const UNSETTLED: SwarmUnsettledView = {
  view: 'unsettled',
  v: 7,
  title: TITLE("swarm demo · hasn't settled after 2m"),
  notice: null,
  swarm: 'demo',
  since: '09:30',
  nodes: [{ agentId: 'o1', name: 'part-a', status: 'running' }],
  calls: [{ name: 'part-a', tool: 'Bash', age: '1m' }],
  shells: [{ shellId: 'sh-1', name: 'fixer', age: '3m' }],
  reservations: 1,
}

const DOCTOR: DoctorPaneView = {
  view: 'doctor',
  v: 8,
  body: {
    swarm: 'demo',
    title: TITLE('doctor · demo'),
    notice: null,
    rows: [{ id: 'concurrent', glyph: '✕', color: 'error', title: 'too few concurrent subagents', detail: 'the spec runs 6 at once', values: ['needs 6', 'this process: 4'] }],
    errors: 1,
    warnings: 0,
    snippet: '{\n  "env": {\n    "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "8"\n  }\n}',
    settingsPath: '/home/me/.claude/settings.json',
    tested: false,
  },
}

/** The views the panes' atoms hold, answered beneath register.tsx's reads; a write beneath them still lands. */
function views(on: On, swarm: SwarmPaneView | null, doctor: DoctorPaneView | null = null): void {
  on('state.get', async (_$, e, next) => {
    if (e.key === 'swarmPane' && swarm) return { value: { value: swarm, version: 0 } }
    if (e.key === 'doctorPane' && doctor) return { value: { value: doctor, version: 0 } }
    return next(e)
  })
}

/** What the pane logged (`litter: …` lines) and toasted. */
function watch(on: On): { logs: string[]; toasts: string[] } {
  const seen = { logs: [] as string[], toasts: [] as string[] }
  on('ui.log', async (_$, e) => {
    seen.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return seen
}

/** The pane's navigation as a reload finds it in $.store, written by this session. */
const navStore = (swarm: Record<string, unknown>) => ({
  'litter.swarm.pane': {
    v: 1,
    session: SESSION,
    swarm: {
      selected: null,
      proposal: null,
      picked: [],
      pickedBriefs: [],
      diff: null,
      transcript: null,
      inputs: {},
      template: null,
      saveAs: null,
      recoveryPicked: [],
      offerQueue: false,
      waitedOn: null,
      notice: null,
      ...swarm,
    },
    doctor: null,
  },
})

/**
 * $.fs and $.process.run for a plain checkout at /repo (as wiring.test.ts's
 * world), so session.start resolves the litter directory the handlers need.
 */
function world(on: On): { commands: { name: string; argumentHint?: string }[] } {
  const files = new Map<string, string>()
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
    if (argv[0] === 'git' && argv.includes('rev-parse')) {
      if (argv.includes('--show-toplevel') && !argv.includes('--git-dir')) return run(0, '/repo\n')
      if (argv.includes('--git-dir') && argv.includes('--git-common-dir')) return run(0, '/repo/.git\n/repo/.git\n')
    }
    return run(1)
  })
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  const commands: { name: string; argumentHint?: string }[] = []
  on('command.register', async (_$, e) => {
    commands.push({ name: e.name, ...(e.argumentHint ? { argumentHint: e.argumentHint } : {}) })
    return { value: { command: e.name } }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  return { commands }
}

const mountSwarm = <S extends 'terminal' | 'desktop' | 'vscode' | 'mobile'>($: Engine, surface: S, bodyColumns = 100) =>
  $.ui.mount({ plugin: 'litter', surface, component: 'Pane', requestId: 'litter-swarm', props: pane('litter swarm', bodyColumns) })

describe('the swarm panes draw every view', () => {
  for (const surface of SURFACES) {
    const cases: [string, SwarmPaneView, string][] = [
      ['the start screen', START, 'swarm:start:ask-send'],
      ['the builder', BUILDER, 'swarm:builder:launch:demo'],
      ['a proposal', PROPOSAL, 'swarm:proposal:accept-all:demo/1'],
      ['the browser', BROWSER, 'swarm:browser:send:demo/fixer#1'],
      ['a read-only swarm', READ_ONLY, 'swarm:browser:takeover:demo'],
      ['the goal history', HISTORY, 'swarm:history:back:demo'],
      ['the recovery card', RECOVERY, 'swarm:recovery:resume-all:demo'],
      ['the unsettled report', UNSETTLED, 'swarm:unsettled:keep:demo'],
    ]
    for (const [what, fixture, key] of cases) {
      test(`${what}, on the ${surface}`, async ($, on) => {
        mock.store(on)
        views(on, fixture)
        const ui = await mountSwarm($, surface)
        expect(await ui.find({ type: 'Button', key })).toBeDefined()
      })
    }

    test(`the doctor pane, on the ${surface}`, async ($, on) => {
      mock.store(on)
      views(on, null, DOCTOR)
      const ui = await $.ui.mount({ plugin: 'litter', surface, component: 'Pane', requestId: 'litter-doctor', props: pane('litter doctor') })
      expect(await ui.find({ type: 'Button', key: 'swarm:doctor:ask-lead' })).toBeDefined()
      expect(await ui.find({ type: 'Code', text: 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS' })).toBeDefined()
    })

    test(`nothing to show yet, on the ${surface}`, async ($, on) => {
      mock.store(on)
      const ui = await mountSwarm($, surface)
      expect(await ui.find({ type: 'Text', text: '/litter-swarm opens' })).toBeDefined()
    })

    // 2b-2 (WP-Z): a repair swarm's budget row and its gate and budget events.
    test(`a repair swarm's budget row and gate events, on the ${surface}`, async ($, on) => {
      mock.store(on)
      views(on, REPAIR)
      const ui = await mountSwarm($, surface)
      expect(await ui.find({ type: 'Text', text: 'repairs run 20261003-api' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'Repair budget' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '! rounds 3 of 3, all used' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^agents 2 of 6$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '! no verdict past its last round is taken' })).toBeDefined()
      for (const text of ['verify v-1: ✕ red', 'verdict, round 1, on v-2: ✕ rejected', 'asked for more budget (rounds 2): ✓ granted', 'land of v-3: ✓ landed']) {
        expect(await ui.find({ type: 'Text', text })).toBeDefined()
      }
      expect(await ui.find({ type: 'Button', key: 'swarm:browser:end:repair-0a1b2c' })).toBeDefined()
    })

    test(`a plain swarm has no budget row, on the ${surface}`, async ($, on) => {
      mock.store(on)
      views(on, BROWSER)
      const ui = await mountSwarm($, surface)
      expect(await ui.find({ type: 'Text', text: 'Repair budget' })).toBeUndefined()
    })
  }

  test('a read-only swarm has no composer and no stop buttons', async ($, on) => {
    mock.store(on)
    views(on, READ_ONLY)
    const ui = await mountSwarm($, 'terminal')
    expect(await ui.find({ key: 'swarm:browser:send:demo/fixer#1' })).toBeUndefined()
    expect(await ui.find({ key: 'swarm:browser:stop:demo/w1' })).toBeUndefined()
    expect(await ui.find({ key: 'swarm:browser:transcript:demo/w1' })).toBeDefined()
  })

  test('a narrow pane stacks the builder', async ($, on) => {
    mock.store(on)
    views(on, BUILDER)
    const ui = await mountSwarm($, 'terminal', 60)
    expect(await ui.find({ type: 'Button', key: 'swarm:builder:save:demo' })).toBeDefined()
  })

  test("a brief that comes with its node has no pick of its own (S1)", async ($, on) => {
    mock.store(on)
    const brief = PROPOSAL.briefs[0]!
    views(on, { ...PROPOSAL, briefs: [brief, { ...brief, node: 'reviewer', glyph: '+', withNode: true, open: false, lines: [] }] })
    const ui = await mountSwarm($, 'terminal')
    expect(await ui.find({ type: 'Button', key: 'swarm:proposal:pick-brief:demo/1/fixer' })).toBeDefined()
    expect(await ui.find({ key: 'swarm:proposal:pick-brief:demo/1/reviewer' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'with its node' })).toBeDefined()
  })

  test("a brief you edited too shows both diffs, with [Keep yours] and [Take the lead's] (S12)", async ($, on) => {
    mock.store(on)
    const brief = {
      ...PROPOSAL.briefs[0]!,
      conflict: true,
      picked: false,
      lines: [{ text: "+ the lead's line", color: 'diffAddedWord' }],
      yoursLines: [{ text: '+ your line', color: 'diffAddedWord' }],
    }
    views(on, { ...PROPOSAL, briefs: [brief] })
    const ui = await mountSwarm($, 'terminal')
    expect(await ui.find({ type: 'Text', text: "+ the lead's line" })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+ your line' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'swarm:proposal:keep-brief:demo/1/fixer' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'swarm:proposal:take-brief:demo/1/fixer' })).toBeDefined()
    expect(await ui.find({ key: 'swarm:proposal:pick-brief:demo/1/fixer' })).toBeUndefined()
  })

  test('the recovery card picks orchestrators by node; a worker says what brings it back (S5)', async ($, on) => {
    mock.store(on)
    views(on, RECOVERY)
    const ui = await mountSwarm($, 'terminal')
    expect(await ui.find({ type: 'Button', key: 'swarm:recovery:pick:demo/part-a' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'swarm:recovery:pick:demo/part-c' })).toBeDefined()
    expect(await ui.find({ key: 'swarm:recovery:pick:demo/fixer' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'comes back through part-a' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 're-spawn only' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'last report: half done' })).toBeDefined()
  })

  test("a template's values that don't check are shown on its form (S10)", async ($, on) => {
    mock.store(on)
    views(on, { ...START, template: { ...START.template!, errors: ['params.parts: needs a value'] } })
    const ui = await mountSwarm($, 'terminal')
    expect(await ui.find({ type: 'Text', text: 'params.parts: needs a value' })).toBeDefined()
  })

  test("a proposal that can't be read still has [Reject] (S11)", async ($, on) => {
    mock.store(on)
    views(on, { ...BUILDER, proposals: [], unreadable: [{ n: 2, error: 'not JSON' }] })
    const ui = await mountSwarm($, 'terminal')
    expect(await ui.find({ type: 'Button', key: 'swarm:builder:reject:demo/2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: "proposal 2 can't be read: not JSON" })).toBeDefined()
  })
})

describe('the tree', () => {
  test('the terminal draws it as the Client: a right-click opens the menu, and a pick posts to the pane', async ($, on) => {
    mock.store(on, navStore({ view: 'builder', swarm: 'demo' }))
    on('session.id', async () => ({ value: SESSION }))
    const seen = watch(on)
    views(on, BUILDER)
    const ui = await mountSwarm($, 'terminal')
    expect(await ui.find({ type: 'Text', text: 'part-a', in: 'swarm-tree' })).toBeDefined()
    await ui.pointer({ type: 'down', x: 6, y: 1, button: 'right', in: 'swarm-tree' })
    expect(await ui.find({ type: 'Text', text: 'duplicate', in: 'swarm-tree' })).toBeDefined()
    await ui.key({ key: 'down', in: 'swarm-tree' })
    await ui.key({ key: 'down', in: 'swarm-tree' })
    await ui.key({ key: 'return', in: 'swarm-tree' })
    expect(seen.logs.some(l => l.includes("swarm pane: the tree's duplicate on part-a"))).toBe(true)
  })

  test('the keys post too: ↓ then a adds a child under the row', async ($, on) => {
    mock.store(on, navStore({ view: 'builder', swarm: 'demo' }))
    on('session.id', async () => ({ value: SESSION }))
    const seen = watch(on)
    views(on, BUILDER)
    const ui = await mountSwarm($, 'terminal')
    await ui.pointer({ type: 'down', x: 6, y: 0, button: 'left', in: 'swarm-tree' })
    await ui.key({ key: 'down', in: 'swarm-tree' })
    await ui.key({ key: 'a', in: 'swarm-tree' })
    expect(seen.logs.some(l => l.includes("swarm pane: the tree's select on @lead"))).toBe(true)
    expect(seen.logs.some(l => l.includes("swarm pane: the tree's add on part-a"))).toBe(true)
  })

  test('a saved draft focuses [Launch], so the keyboard reaches it (ctrl+x tab, Enter)', async ($, on) => {
    mock.store(on)
    views(on, BUILDER)
    const ui = await mountSwarm($, 'terminal')
    expect((await ui.find({ type: 'Button', key: 'swarm:builder:launch:demo' }))?.props).toEqual(expect.objectContaining({ autoFocus: true }))
    expect((await ui.find({ type: 'Button', key: 'swarm:builder:save:demo' }))?.props.autoFocus).toBeUndefined()
  })

  test('an unsaved draft focuses [Save] instead', async ($, on) => {
    mock.store(on)
    views(on, { ...BUILDER, unsaved: true })
    const ui = await mountSwarm($, 'terminal')
    expect((await ui.find({ type: 'Button', key: 'swarm:builder:save:demo' }))?.props).toEqual(expect.objectContaining({ autoFocus: true }))
    expect((await ui.find({ type: 'Button', key: 'swarm:builder:launch:demo' }))?.props.autoFocus).toBeUndefined()
  })

  for (const surface of ['vscode', 'mobile'] as const) {
    test(`with no Client (${surface}), each row is a button and the edits are buttons under the selection`, async ($, on) => {
      mock.store(on)
      views(on, BUILDER)
      const ui = await mountSwarm($, surface)
      expect(await ui.find({ type: 'Button', key: 'swarm:builder:select:demo/part-a' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'swarm:builder:delete:demo/part-a/fixer' })).toBeDefined()
    })
  }
})

describe('a press reaches its owner', () => {
  /** A session started in /repo (so the litter directory resolves), the pane's navigation seeded, the view drawn from `shown`. */
  const start = async ($: Engine, on: On, shown: SwarmPaneView, nav: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    mock.store(on, { ...navStore(nav), ...extra })
    mock.clock(on, { now: 1_800_000_000_000 })
    world(on)
    views(on, shown)
    on('session.id', async () => ({ value: SESSION }))
    const seen = watch(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    return seen
  }

  for (const surface of SURFACES) {
    test(`[Launch] reaches launchSwarm, on the ${surface}`, async ($, on) => {
      // A draft with nothing unsaved, as J's store holds it (types.ts's Draft).
      const draft = { base: 1, edits: [], spec: { name: 'demo', goal: 'g', nodes: [] }, briefs: {}, updatedAt: 0 }
      const seen = await start($, on, BUILDER, { view: 'builder', swarm: 'demo' }, { [`litter.swarm.draft.${LITTER}.demo`]: draft })
      const ui = await mountSwarm($, surface)
      await ui.press({ key: 'swarm:builder:launch:demo' })
      expect(seen.logs).toContain('litter: swarm pane: launchSwarm demo')
    })

    test(`[Send] reaches sendFromBrowser with the instance shown, on the ${surface}`, async ($, on) => {
      const seen = await start($, on, BROWSER, { view: 'browser', swarm: 'demo', selected: 'w1', inputs: { 'swarm:browser:text:demo': 'hello' } })
      const ui = await mountSwarm($, surface)
      await ui.press({ key: 'swarm:browser:send:demo/fixer#1' })
      expect(seen.logs).toContain('litter: swarm pane: sendFromBrowser demo fixer#1 interject direct')
    })

    test(`[Stop node] reaches stopNode, on the ${surface}`, async ($, on) => {
      const seen = await start($, on, BROWSER, { view: 'browser', swarm: 'demo', selected: 'w1' })
      const ui = await mountSwarm($, surface)
      await ui.press({ key: 'swarm:browser:stop:demo/w1' })
      expect(seen.logs).toContain('litter: swarm pane: stopNode demo w1 soft')
    })

    test(`[End swarm] reaches endSwarm, on the ${surface}`, async ($, on) => {
      const seen = await start($, on, BROWSER, { view: 'browser', swarm: 'demo' })
      const ui = await mountSwarm($, surface)
      await ui.press({ key: 'swarm:browser:end:demo' })
      expect(seen.logs).toContain('litter: swarm pane: endSwarm demo request')
    })
  }

  test('a press on a view the pane no longer shows is ignored, with a toast', async ($, on) => {
    const seen = await start($, on, BROWSER, { view: 'builder', swarm: 'demo' })
    const ui = await mountSwarm($, 'terminal')
    await ui.press({ key: 'swarm:browser:end:demo' })
    expect(seen.logs).not.toContain('litter: swarm pane: endSwarm demo request')
    expect(seen.toasts.some(t => t.includes('so it was ignored'))).toBe(true)
  })
})

describe('the commands', () => {
  const run = ($: Engine, command: string, args = '') =>
    $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

  test('session.start registers /litter-swarm [name] and /litter-doctor', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1_800_000_000_000 })
    const { commands } = world(on)
    on('session.id', async () => ({ value: SESSION }))
    on('ui.log', async () => ({ value: undefined }))
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    expect(commands).toEqual([{ name: 'litter-swarm', argumentHint: '[name]' }, { name: 'litter-doctor' }])
  })

  test('/litter-swarm answers with a line and opens its pane', async ($, on) => {
    mock.store(on)
    const opened: string[] = []
    on('ui.open', async (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    const r = await run($, 'litter-swarm')
    expect(r.text).toBe('litter: the swarm pane shows the start screen')
    expect(opened).toEqual(['litter-swarm'])
    const named = await run($, 'litter-swarm', 'demo')
    expect(named.text).toBe('litter: the swarm pane shows the builder for demo')
  })

  test('/litter-doctor answers with a line and opens its pane', async ($, on) => {
    mock.store(on)
    const opened: string[] = []
    on('ui.open', async (_$, e) => {
      opened.push(e.id)
      return { value: { isPlaced: true } }
    })
    const r = await run($, 'litter-doctor')
    expect(r.text).toMatch(/^litter: the doctor pane checks this session, with no swarm spec/)
    expect(opened).toEqual(['litter-doctor'])
  })
})
