// Tier 1: the Swarms and Doctor sections of the one `litter` pane as the
// engine draws them (WP-N; phase 5b, WP-DA). Every view, fed to register.tsx's
// `litter` render through a state.get hook beneath (the section's atom, and
// the hub's naming the section shown), mounts on the terminal and the desktop
// (a mount rejects a tree the surface refuses); the tree is the Client where
// the surface has one and plain buttons where it hasn't; a press on [Launch],
// [Send], [Stop node] and [End swarm] reaches its owner (the pane logs each
// owner call before making it, so this holds with the owners' stubs and with
// their bodies); and `/litter swarms` and `/litter doctor` answer and open
// `litter`. The plugin's module state isn't the test's, so the pane's
// navigation and the section shown are seeded through $.store, as a reload
// finds them.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import { drawText, drawWithColors } from './drawing'
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

/** A view's first line, as view.ts's title builds it: the swarm's name bold in the name color, then what the view shows, muted. */
const TITLE = (name: string | null, ...rest: (string | { text: string; color: string })[]) => [
  ...(name ? [{ text: name, color: 'cyan_FOR_SUBAGENTS_ONLY', bold: true }] : []),
  ...rest.map(x => (typeof x === 'string' ? { text: x, color: 'inactive' } : x)),
]

const START: SwarmStartView = {
  view: 'start',
  v: 1,
  title: TITLE(null, 'new swarm'),
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
  needsYou: [],
}

const BUILDER: SwarmBuilderView = {
  view: 'builder',
  v: 2,
  title: TITLE('demo', ' · builder', ' · rev 1'),
  notice: null,
  swarm: 'demo',
  base: 1,
  unsaved: false,
  live: false,
  blocked: null,
  goal: 'ship the parser, then the formatter, with a review of each part before it lands on main',
  tree: { swarm: 'demo', rows: [row('@lead'), row('part-a'), row('part-a/fixer', { mark: '✕', markColor: 'error' })], selected: 'part-a/fixer', editable: true, workers: ['fixer'] },
  inspector: {
    title: 'fixer · worker',
    fields: [
      { key: 'swarm:builder:field:demo/fixer/kind', label: 'Kind', kind: 'text', value: 'worker under part-a', options: [], placeholder: '', badge: null, note: null, noteColor: null, group: 'execution' },
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
        group: 'execution',
      },
      {
        key: 'swarm:builder:field:demo/fixer/maxTurns',
        label: 'Max turns',
        kind: 'input',
        value: 'lots',
        options: [],
        placeholder: 'a whole number',
        badge: 'engine',
        note: 'max turns is a whole number above 0',
        noteColor: 'error',
        group: 'limits',
      },
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
        group: 'authority',
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
  saveAs: null,
  proposals: [1],
  unreadable: [],
  superseded: [],
}

const PROPOSAL: SwarmProposalView = {
  view: 'proposal',
  v: 3,
  title: TITLE('demo', " · the lead's proposal 1", ' · rev 1 → 2'),
  notice: null,
  swarm: 'demo',
  n: 1,
  from: 1,
  to: 2,
  tree: { swarm: 'demo', rows: [row('@lead'), row('part-a', { mark: '~', markColor: 'warning' }), row('part-a/reviewer', { mark: '+', markColor: 'success' })], selected: null, editable: false, workers: [] },
  changes: [
    {
      index: 0,
      glyph: '~',
      color: 'warning',
      words: 'Change fixer · model · Sonnet → Opus',
      path: 'nodes.fixer.model',
      text: '"sonnet" → "opus"',
      reason: 'the parser is hard',
      conflict: true,
      yours: '"haiku"',
      yoursWords: 'Haiku',
      picked: false,
    },
    {
      index: 1,
      glyph: '+',
      color: 'success',
      words: 'Add reviewer · worker',
      path: 'nodes.reviewer',
      text: '{"id":"reviewer"}',
      reason: null,
      conflict: false,
      yours: null,
      yoursWords: null,
      picked: true,
    },
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
  technical: false,
}

const BROWSER: SwarmBrowserView = {
  view: 'browser',
  v: 4,
  title: TITLE('demo', { text: ' · ', color: 'inactive' }, { text: '▸ live 2m', color: 'background' }, ' · 3 agents · 2k tokens'),
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
    { key: 'lead', agentId: null, depth: 0, name: 'lead', role: 'lead', color: null, dim: false, status: 'idle', statusGlyph: '', statusColor: 'inactive', running: false, tool: '', turns: null, tokens: '', report: '', queued: [], question: null, flagged: false },
    {
      key: 'o1',
      agentId: 'o1',
      depth: 1,
      name: 'part-a',
      role: 'orchestrator',
      color: 'blue_FOR_SUBAGENTS_ONLY',
      dim: false,
      status: 'waiting',
      statusGlyph: '⚑',
      statusColor: 'permission',
      running: true,
      tool: 'Bash',
      turns: 3,
      tokens: '2k',
      report: '',
      queued: [],
      question: 'which branch?',
      flagged: false,
    },
    {
      key: 'w1',
      agentId: 'w1',
      depth: 2,
      name: 'fixer',
      role: 'worker',
      color: 'blue_FOR_SUBAGENTS_ONLY',
      dim: true,
      status: 'running',
      statusGlyph: '▸',
      statusColor: 'background',
      running: true,
      tool: 'Edit',
      turns: 1,
      tokens: '800',
      report: 'fixed the tokenizer',
      queued: [{ id: 'q1', text: 'also the lexer' }],
      question: null,
      flagged: true,
    },
    {
      key: 'w2',
      agentId: 'w2',
      depth: 2,
      name: 'reader',
      role: 'worker',
      color: 'blue_FOR_SUBAGENTS_ONLY',
      dim: true,
      status: 'done',
      statusGlyph: '✓',
      statusColor: 'success',
      running: false,
      tool: '',
      turns: 4,
      tokens: '3k',
      report: 'read the grammar',
      queued: [],
      question: null,
      flagged: false,
    },
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
  transcript: {
    agentId: 'w1',
    name: 'fixer',
    readable: true,
    lines: [
      [{ text: '◆ ', color: 'claude' }, { text: 'from part-a: fix the tokenizer (+ more)' }],
      // As view.ts's toolLine writes them (tier 2 checks it): ↳ faint, the tool bold in the label color, its argument muted or a path's.
      [{ text: '  ↳ ', color: 'subtle' }, { text: 'Read', color: 'text', bold: true }, { text: ' src/lexer.ts', color: 'suggestion' }, { text: ' ✓ done', color: 'success' }],
      [
        { text: '  ↳ ', color: 'subtle' },
        { text: 'Bash', color: 'text', bold: true },
        { text: ' bun test', color: 'inactive' },
        { text: ' (+1 more)', color: 'subtle' },
        { text: ' · no outcome recorded', color: 'inactive' },
      ],
    ],
  },
  selected: 'w1',
  proposals: [],
}

/** A repair swarm (2b-2): its run in the header, its budget row with a part used up, and its gate and budget events. */
const REPAIR: SwarmBrowserView = {
  ...BROWSER,
  title: TITLE('repair-0a1b2c', { text: ' · ', color: 'inactive' }, { text: '▸ live 2m', color: 'background' }, ' · 3 agents · 4k tokens', ' · repairs run 20261003-api'),
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
  title: [...BROWSER.title, { text: ' · read-only', color: 'inactive' }],
  readOnly: true,
  composer: null,
  flags: [],
  owner: { text: 'owned by session other on box', canTakeOver: true, why: null },
}

/** This session lost it to a handover: the owner in an error line, no composer, no Stop. */
const LOST: SwarmBrowserView = {
  ...BROWSER,
  title: [...BROWSER.title, { text: ' · ✕ lost to another session', color: 'error' }],
  lost: true,
  composer: null,
  flags: [],
  owner: { text: 'session other took it over at 09:40', canTakeOver: false, why: 'it asked for the swarm while this one was idle' },
}

const HISTORY: SwarmHistoryView = {
  view: 'history',
  v: 5,
  title: TITLE('demo', ' · goal history'),
  notice: null,
  swarm: 'demo',
  entries: [
    { at: '09:31', goal: 'parser first' },
    { at: '09:52', goal: 'parser done; the formatter next, then a review of both' },
  ],
}

const RECOVERY: SwarmRecoveryView = {
  view: 'recovery',
  v: 6,
  title: TITLE('demo', { text: ' · ! recreated after a restart', color: 'warning' }),
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
  title: TITLE('demo', { text: " · ! hasn't settled after 2m", color: 'warning' }),
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
    title: TITLE('demo', " · its spec against this session's settings"),
    notice: null,
    rows: [
      { id: 'concurrent', glyph: '✕', color: 'error', word: 'fails', title: 'too few concurrent subagents', detail: 'the spec runs 6 at once', values: ['needs 6', 'this process: 4'] },
      { id: 'summary', glyph: '!', color: 'warning', word: 'warning', title: 'no summary model set', detail: 'summaries use the main model, which costs more', values: ['this process: not set'] },
      { id: 'nesting', glyph: '✓', color: 'success', word: 'ok', title: 'nesting depth 3 is enough', detail: '', values: [] },
    ],
    errors: 1,
    warnings: 1,
    snippet: '{\n  "env": {\n    "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS": "8"\n  }\n}',
    settingsPath: '/home/me/.claude/settings.json',
    tested: false,
  },
}

/**
 * The views the sections' atoms hold, answered beneath register.tsx's reads,
 * and the hub's, which names the section shown: Doctor when a doctor view is
 * given, else Swarms. A write beneath them still lands.
 */
function views(on: On, swarm: SwarmPaneView | null, doctor: DoctorPaneView | null = null): void {
  const hub = { view: 'hub', v: 1, section: doctor ? 'doctor' : 'swarms', live: [], tabs: [] }
  on('state.get', async (_$, e, next) => {
    if (e.key === 'hub') return { value: { value: hub, version: 0 } }
    if (e.key === 'swarmPane' && swarm) return { value: { value: swarm, version: 0 } }
    if (e.key === 'doctorPane' && doctor) return { value: { value: doctor, version: 0 } }
    return next(e)
  })
}

/** What the pane logged (the debug lines, which the engine labels itself) and toasted; `nextLog(part)`, the first line holding `part` logged after it asked. */
function watch(on: On): { logs: string[]; toasts: string[]; nextLog: (part: string) => Promise<string> } {
  const seen = { logs: [] as string[], toasts: [] as string[] }
  const waiting: { part: string; resolve: (line: string) => void }[] = []
  on('ui.log', async (_$, e) => {
    seen.logs.push(e.text)
    for (const w of waiting.filter(w => e.text.includes(w.part))) {
      waiting.splice(waiting.indexOf(w), 1)
      w.resolve(e.text)
    }
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    seen.toasts.push(e.text)
    return { value: undefined }
  })
  return { ...seen, nextLog: part => new Promise<string>(resolve => waiting.push({ part, resolve })) }
}

/**
 * The pane's navigation as a reload finds it in $.store, written by this
 * session, and the hub's section shown, Swarms, so a press or a tree post is
 * routed to the swarm pane's handlers (ui/hub.ts's key rule).
 */
const navStore = (swarm: Record<string, unknown>) => ({
  'litter.hub': { v: 1, session: SESSION, section: 'swarms' },
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

/** The one `litter` pane, which draws the section the hub's atom names (views(): Swarms, or Doctor). */
const mountSwarm = <S extends 'terminal' | 'desktop' | 'vscode' | 'mobile'>($: Engine, surface: S, bodyColumns = 100) =>
  $.ui.mount({ plugin: 'litter', surface, component: 'Pane', requestId: 'litter', props: pane('litter', bodyColumns) })

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

    test(`the doctor section, on the ${surface}`, async ($, on) => {
      mock.store(on)
      views(on, null, DOCTOR)
      const ui = await mountSwarm($, surface)
      expect(await ui.find({ type: 'Text', text: ' · Doctor' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'swarm:doctor:ask-lead' })).toBeDefined()
      expect(await ui.find({ type: 'Code', text: 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS' })).toBeDefined()
    })

    test(`nothing to show yet, on the ${surface}`, async ($, on) => {
      mock.store(on)
      views(on, null)
      const ui = await mountSwarm($, surface)
      expect(await ui.find({ type: 'Text', text: ' · Swarms' })).toBeDefined()
      // The chrome's empty state: the next step as a command, in the link color.
      expect((await ui.find({ type: 'Text', text: /^\/litter swarms$/ }))?.props.color).toBe('suggestion')
      expect(await ui.find({ type: 'Text', text: ' opens the builder or a live swarm' })).toBeDefined()
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
    // The menu is the Client's own state, drawn again before the act resolves.
    await ui.pointer({ type: 'down', x: 6, y: 1, button: 'right', in: 'swarm-tree' })
    expect(await ui.find({ type: 'Text', text: 'duplicate', in: 'swarm-tree' })).toBeDefined()
    // A pick only posts: litter handles the post (a ui.message) after the act
    // resolves, which the act's settle can stop short of, so wait for its line.
    const picked = seen.nextLog("swarm pane: the tree's ")
    await ui.key({ key: 'down', in: 'swarm-tree' })
    await ui.key({ key: 'down', in: 'swarm-tree' })
    await ui.key({ key: 'return', in: 'swarm-tree' })
    expect(await picked).toContain("swarm pane: the tree's duplicate on part-a")
  })

  test('the keys post too: ↓ then a adds a child under the row', async ($, on) => {
    mock.store(on, navStore({ view: 'builder', swarm: 'demo' }))
    on('session.id', async () => ({ value: SESSION }))
    const seen = watch(on)
    views(on, BUILDER)
    const ui = await mountSwarm($, 'terminal')
    // Each post is handled after its act resolves: wait for its line (see above).
    let picked = seen.nextLog("swarm pane: the tree's ")
    await ui.pointer({ type: 'down', x: 6, y: 0, button: 'left', in: 'swarm-tree' })
    expect(await picked).toContain("swarm pane: the tree's select on @lead")
    picked = seen.nextLog("swarm pane: the tree's ")
    await ui.key({ key: 'down', in: 'swarm-tree' })
    await ui.key({ key: 'a', in: 'swarm-tree' })
    expect(await picked).toContain("swarm pane: the tree's add on part-a")
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
      expect(seen.logs).toContain('swarm pane: launchSwarm demo')
    })

    test(`[Send] reaches sendFromBrowser with the instance shown, on the ${surface}`, async ($, on) => {
      const seen = await start($, on, BROWSER, { view: 'browser', swarm: 'demo', selected: 'w1', inputs: { 'swarm:browser:text:demo': 'hello' } })
      const ui = await mountSwarm($, surface)
      await ui.press({ key: 'swarm:browser:send:demo/fixer#1' })
      expect(seen.logs).toContain('swarm pane: sendFromBrowser demo fixer#1 interject direct')
    })

    test(`[Stop node] reaches stopNode, on the ${surface}`, async ($, on) => {
      const seen = await start($, on, BROWSER, { view: 'browser', swarm: 'demo', selected: 'w1' })
      const ui = await mountSwarm($, surface)
      await ui.press({ key: 'swarm:browser:stop:demo/w1' })
      expect(seen.logs).toContain('swarm pane: stopNode demo w1 soft')
    })

    test(`[End swarm] reaches endSwarm, on the ${surface}`, async ($, on) => {
      const seen = await start($, on, BROWSER, { view: 'browser', swarm: 'demo' })
      const ui = await mountSwarm($, surface)
      await ui.press({ key: 'swarm:browser:end:demo' })
      expect(seen.logs).toContain('swarm pane: endSwarm demo request')
    })
  }

  test('a press on a view the pane no longer shows is ignored, with a toast', async ($, on) => {
    const seen = await start($, on, BROWSER, { view: 'builder', swarm: 'demo' })
    const ui = await mountSwarm($, 'terminal')
    await ui.press({ key: 'swarm:browser:end:demo' })
    expect(seen.logs).not.toContain('swarm pane: endSwarm demo request')
    // The swarm pane's own stale check answered it, not the hub's.
    expect(seen.toasts.some(t => t.includes('so it was ignored') && !t.includes('litter shows'))).toBe(true)
  })

  test("a Swarms key drawn before litter switched to Doctor reaches no handler: the hub's toast says so", async ($, on) => {
    // Drawn as Swarms (the hub's atom), while litter shows Doctor now (its module memory, from $.store).
    const seen = await start($, on, BROWSER, { view: 'browser', swarm: 'demo' }, { 'litter.hub': { v: 1, session: SESSION, section: 'doctor' } })
    const ui = await mountSwarm($, 'terminal')
    expect(await ui.press({ key: 'swarm:browser:end:demo' })).toEqual(expect.objectContaining({ element: 'swarm:browser:end:demo' }))
    expect(seen.logs).not.toContain('swarm pane: endSwarm demo request')
    expect(seen.toasts).toContain('that was on Swarms, and litter shows Doctor now, so it was ignored')
  })
})

// ---------------------------------------------------------------------------
// Phase 5b (WP-DD): the restyled bodies

/** The pane at `bodyColumns`, docked or inline, `bodyRows` tall. */
const mountAt = ($: Engine, bodyColumns: number, placement: 'dock' | 'inline' = 'dock', surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' = 'terminal', bodyRows = 60) =>
  $.ui.mount({
    plugin: 'litter',
    surface,
    component: 'Pane',
    requestId: 'litter',
    props: { title: 'litter', isFocused: false, bodyColumns, placement, scroll: { offset: 0, bodyRows }, view: {} },
  })

/** The texts of every Text drawn. */
const textsOf = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string }[]> }) => (await ui.findAll({ type: 'Text' })).map(t => t.text)

/** The drawing's row holding `part`, or undefined. */
const rowWith = (rows: readonly string[], part: string) => rows.find(r => r.includes(part))

/** Each view's first line as it starts, and a key its primary or main action has. */
const FIRST_LINES: [string, SwarmPaneView, string | null, string][] = [
  ['the start screen', START, null, 'swarm:start:use-template'],
  ['the builder', BUILDER, 'demo · builder · rev 1 ', 'swarm:builder:launch:demo'],
  ['a proposal', PROPOSAL, "demo · the lead's proposal 1 · rev 1 → 2 ", 'swarm:proposal:accept-all:demo/1'],
  ['the browser', BROWSER, 'demo · ▸ live 2m · 3 agents · 2k tokens ', 'swarm:browser:send:demo/fixer#1'],
  ['the goal history', HISTORY, 'demo · goal history ', 'swarm:history:back:demo'],
  ['the recovery card', RECOVERY, 'demo · ! recreated after a restart ', 'swarm:recovery:resume-all:demo'],
  ['the unsettled report', UNSETTLED, "demo · ! hasn't settled after 2m ", 'swarm:unsettled:wait:demo'],
]

describe('every view at 100 and 60 columns, docked and inline', () => {
  for (const columns of [100, 60]) {
    for (const placement of ['dock', 'inline'] as const) {
      for (const [what, fixture, first, key] of FIRST_LINES) {
        test(`${what} at ${columns} columns, ${placement}: its first line is its swarm and state with a rule, no title of its own`, async ($, on) => {
          mock.store(on)
          views(on, fixture)
          const ui = await mountAt($, columns, placement)
          const primary = await ui.find({ type: 'Button', key })
          expect(primary?.props.variant).toBe('primary')
          const rows = drawText(await ui.drawn(), columns)
          // The hub's header says `litter · Swarms`; the body never says `litter · …` again.
          expect(rows.filter(r => r.includes('litter ·'))).toEqual(['litter · Swarms'])
          if (first !== null) {
            const line = rowWith(rows, first)
            expect(line).toBeDefined()
            expect(line).toMatch(/ ─{3,}$/)
            expect([...line!].length).toBe(columns)
          }
          // One primary action per view.
          expect((await ui.findAll({ type: 'Button' })).filter(b => b.props.variant === 'primary')).toHaveLength(1)
        })
      }
      test(`Doctor at ${columns} columns, ${placement}`, async ($, on) => {
        mock.store(on)
        views(on, null, DOCTOR)
        const ui = await mountAt($, columns, placement)
        const rows = drawText(await ui.drawn(), columns)
        expect(rows.filter(r => r.includes('litter ·'))).toEqual(['litter · Doctor'])
        expect(rowWith(rows, "demo · its spec against this session's settings")).toMatch(/ ─{3,}$/)
        expect((await ui.findAll({ type: 'Button' })).filter(b => b.props.variant === 'primary').map(b => b.key)).toEqual(['swarm:doctor:ask-lead'])
      })
    }
  }
})

describe('the start screen', () => {
  test('with a template picked, wide: its form in a box beside the list; each parameter a field, its description and examples the caption', async ($, on) => {
    mock.store(on)
    views(on, START)
    const ui = await mountAt($, 100)
    const rows = drawText(await ui.drawn(), 100)
    // The list's first row (the picked template) and the box's top frame, side by side.
    expect(rowWith(rows, '› fan-out')).toMatch(/^› fan-out .*╭─+╮$/)
    expect(await ui.find({ type: 'Input', key: 'swarm:start:param:parts' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'one per part · e.g. main, feature/x' }))?.props.color).toBe('inactive')
    // The ask is empty, so [Use template] is the primary and [Ask the lead] is dim.
    expect((await ui.find({ type: 'Button', key: 'swarm:start:use-template' }))?.props.variant).toBe('primary')
    expect((await ui.find({ type: 'Button', key: 'swarm:start:ask-send' }))?.props.dimColor).toBe(true)
  })

  test('narrow: the form under the list', async ($, on) => {
    mock.store(on)
    views(on, START)
    const ui = await mountAt($, 60)
    const rows = drawText(await ui.drawn(), 60)
    const list = rows.findIndex(r => r.startsWith('› fan-out'))
    expect(list).toBeGreaterThan(0)
    expect(rows[list]).not.toContain('╭')
    expect(rows.slice(list + 1).some(r => r.startsWith('╭'))).toBe(true)
  })

  test('the ask with text makes [Ask the lead] the primary; its caption says what it does; [Blank] sits beside the template heading', async ($, on) => {
    mock.store(on)
    views(on, { ...START, ask: 'review the parser' })
    const ui = await mountAt($, 100)
    expect((await ui.find({ type: 'Button', key: 'swarm:start:ask-send' }))?.props.variant).toBe('primary')
    expect((await ui.find({ type: 'Button', key: 'swarm:start:use-template' }))?.props.variant).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: 'the lead proposes one; you review it here' }))?.props.color).toBe('inactive')
    const rows = drawText(await ui.drawn(), 100)
    expect(rowWith(rows, 'From a template')).toBe(`From a template ${'─'.repeat(71)} or [ Blank ]`)
    // No "Or" heading of its own.
    expect(rows.some(r => /^Or\b/.test(r))).toBe(false)
  })

  test('saved swarms are a list: the name, `▸ live` when live, the rev and node count muted; the goal the focused row\'s description', async ($, on) => {
    mock.store(on)
    views(on, { ...START, swarms: [...START.swarms, { name: 'nightly', goal: 'triage the nightly failures', revision: 5, nodes: 4, live: true }] })
    const ui = await mountAt($, 100)
    expect(await ui.find({ type: 'Button', key: 'swarm:start:open:demo' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^▸ live$/ }))?.props.color).toBe('background')
    expect((await ui.find({ type: 'Text', text: /^rev 5 · 4 nodes$/ }))?.props.color).toBe('inactive')
    const rows = drawText(await ui.drawn(), 100)
    expect(rowWith(rows, 'Saved swarms')).toMatch(/^Saved swarms ─+ \/litter swarms <name> opens one ──$/)
    expect(rowWith(rows, 'nightly')).toMatch(/^ {2}nightly +▸ live +rev 5 · 4 nodes +triage the nightly failures$/)
  })
})

describe('the builder', () => {
  test('a waiting proposal is a needs-you line with [Review]; the goal on its own wrapping row; the inspector under its headings', async ($, on) => {
    mock.store(on)
    views(on, BUILDER)
    const ui = await mountAt($, 60)
    expect((await ui.find({ type: 'Text', text: "⚑ the lead's proposal 1 waits on you" }))?.props.color).toBe('permission')
    expect(await ui.find({ type: 'Button', key: 'swarm:builder:proposal:demo/1' })).toBeDefined()
    const rows = drawText(await ui.drawn(), 60)
    const goal = rows.findIndex(r => r.startsWith('Goal ship the parser'))
    expect(goal).toBeGreaterThan(0)
    expect(rows[goal + 1]).toMatch(/^ {5}\S/)
    for (const h of ['Execution', 'Limits', 'Authority']) expect(rowWith(rows, `${h} ───`)).toBeDefined()
    // An unset authority field: `— nothing` beside it, and its warning kept.
    expect(await ui.find({ type: 'Text', text: /^— nothing$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '! not set: not checked by litter' }))?.props.color).toBe('warning')
    // A typed value that doesn't check: its error under the field.
    expect((await ui.find({ type: 'Text', text: '✕ max turns is a whole number above 0' }))?.props.color).toBe('error')
  })

  test('the save-as form open: its [Save template] is the one primary, its fields are fields, its scope a short choice', async ($, on) => {
    mock.store(on)
    views(on, { ...BUILDER, saveAs: { name: 'demo', description: '', scope: 'user', candidates: [{ id: 'goal', label: 'the goal', value: 'ship the parser', param: true }] } })
    const ui = await mountAt($, 100)
    const primaries = (await ui.findAll({ type: 'Button' })).filter(b => b.props.variant === 'primary').map(b => b.key)
    expect(primaries).toEqual(['swarm:builder:saveas-save:demo'])
    expect(await ui.find({ type: 'Input', key: 'swarm:builder:saveas-name:demo' })).toBeDefined()
    expect(await ui.find({ type: 'Select', key: 'swarm:builder:saveas-scope:demo' })).toBeDefined()
    expect(await ui.find({ key: 'swarm:builder:save-as:demo' })).toBeUndefined()
  })

  test('wide: the tree and the inspector side by side, from 100 columns', async ($, on) => {
    mock.store(on)
    views(on, BUILDER)
    const ui = await mountAt($, 100, 'dock', 'vscode')
    const rows = drawText(await ui.drawn(), 100)
    expect(rowWith(rows, 'Tree ')).toContain('fixer · worker')
  })
})

describe('a proposal', () => {
  test('its changes read in words first, a conflict a warning with its choice; the raw path behind [Technical diff]', async ($, on) => {
    mock.store(on)
    views(on, PROPOSAL)
    const ui = await mountAt($, 100)
    expect(await ui.find({ type: 'Text', text: /^Change fixer · model · Sonnet → Opus$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Add reviewer · worker$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: "lead: the parser is hard" }))?.props.color).toBe('inactive')
    expect((await ui.find({ type: 'Text', text: '! you changed it too: yours Haiku' }))?.props.color).toBe('warning')
    expect(await ui.find({ type: 'Button', key: 'swarm:proposal:keep:demo/1/0' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'swarm:proposal:take:demo/1/0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'nodes.fixer.model' })).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'swarm:proposal:diff:demo/1/#technical' }))?.text).toBe('Technical diff')
    expect((await ui.find({ type: 'Button', key: 'swarm:proposal:accept-all:demo/1' }))?.props.variant).toBe('primary')
    expect((await ui.find({ type: 'Button', key: 'swarm:proposal:reject:demo/1' }))?.props.dimColor).toBe(true)
  })

  test('with [Technical diff] open, each change\'s path and value under its words', async ($, on) => {
    mock.store(on)
    views(on, { ...PROPOSAL, technical: true })
    const ui = await mountAt($, 100)
    expect(await ui.find({ type: 'Text', text: /^nodes\.fixer\.model$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '"sonnet" → "opus"' })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'swarm:proposal:diff:demo/1/#technical' }))?.text).toBe('Hide technical diff')
  })
})

describe('the browser', () => {
  test('a question waits on you above the roster, with [Answer]; the roster a list with its status, role and the call in flight', async ($, on) => {
    mock.store(on)
    views(on, BROWSER)
    const ui = await mountAt($, 100, 'dock', 'vscode')
    const rows = drawText(await ui.drawn(), 100)
    const asks = rows.findIndex(r => r.startsWith('⚑ part-a asks: which branch?'))
    const agents = rows.findIndex(r => r.startsWith('Agents '))
    expect(asks).toBeGreaterThan(0)
    expect(asks).toBeLessThan(agents)
    expect(await ui.find({ type: 'Button', key: 'swarm:browser:select:demo/o1' })).toBeDefined()
    expect(rows[agents]).toMatch(/lead · idle ──$/)
    expect(rowWith(rows, '  part-a')).toMatch(/^ {2}part-a +⚑ waiting +orchestrator +▸ Bash/)
    // The selected row: `›`, then the worker indented under its orchestrator.
    expect(rows.find(r => r.startsWith('›   fixer'))).toMatch(/^› {3}fixer +▸ running +worker +! flagged · 1 queued +▸ Edit/)
  })

  test('a finished node has no Stop: only a running node of a live swarm this session owns offers Stop and Hard stop', async ($, on) => {
    mock.store(on)
    views(on, { ...BROWSER, selected: 'w2' })
    const ui = await mountAt($, 100)
    expect(await ui.find({ type: 'Button', key: 'swarm:browser:transcript:demo/w2' })).toBeDefined()
    expect(await ui.find({ key: 'swarm:browser:stop:demo/w2' })).toBeUndefined()
    expect(await ui.find({ key: 'swarm:browser:hard-stop:demo/w2' })).toBeUndefined()
  })

  test('on the terminal the roster is a Client: a right-click on a running node offers Stop node, and the pick reaches stopNode', async ($, on) => {
    mock.store(on, navStore({ view: 'browser', swarm: 'demo', selected: 'w1' }))
    mock.clock(on, { now: 1_800_000_000_000 })
    world(on)
    views(on, BROWSER)
    on('session.id', async () => ({ value: SESSION }))
    const seen = watch(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const ui = await mountSwarm($, 'terminal')
    const roster = 'swarm:browser:roster:demo'
    // The reader is done: its menu is Transcript alone.
    await ui.pointer({ type: 'down', x: 4, y: 2, button: 'right', in: roster })
    expect(await ui.find({ type: 'Text', text: ' Transcript', in: roster })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' Stop node', in: roster })).toBeUndefined()
    await ui.pointer({ type: 'down', x: 4, y: 2, button: 'right', in: roster })
    // part-a runs: Transcript, Stop node, Hard stop.
    await ui.pointer({ type: 'down', x: 4, y: 0, button: 'right', in: roster })
    expect(await ui.find({ type: 'Text', text: ' Hard stop', in: roster })).toBeDefined()
    const stopped = seen.nextLog('swarm pane: stopNode')
    await ui.key({ key: 'down', in: roster })
    await ui.key({ key: 'return', in: roster })
    expect(await stopped).toContain('swarm pane: stopNode demo o1 soft')
  })

  test('read-only: the owner as a warning first, [Take over] the primary, no composer and no Stop', async ($, on) => {
    mock.store(on)
    views(on, READ_ONLY)
    const ui = await mountAt($, 100)
    expect((await ui.find({ type: 'Text', text: '! read-only: owned by session other on box' }))?.props.color).toBe('warning')
    const take = await ui.find({ type: 'Button', key: 'swarm:browser:takeover:demo' })
    expect(take?.props).toEqual(expect.objectContaining({ variant: 'primary', autoFocus: true }))
    expect(await ui.find({ key: 'swarm:browser:stop:demo/w1' })).toBeUndefined()
    expect(await ui.find({ type: 'Input', key: 'swarm:browser:text:demo' })).toBeUndefined()
  })

  test('lost: the owner as an error, why under it, no [Take over], no Stop, no End swarm', async ($, on) => {
    mock.store(on)
    views(on, LOST)
    const ui = await mountAt($, 100)
    expect((await ui.find({ type: 'Text', text: '✕ this session lost it: session other took it over at 09:40' }))?.props.color).toBe('error')
    expect((await ui.find({ type: 'Text', text: 'it asked for the swarm while this one was idle' }))?.props.color).toBe('inactive')
    expect(await ui.find({ key: 'swarm:browser:takeover:demo' })).toBeUndefined()
    expect(await ui.find({ key: 'swarm:browser:stop:demo/w1' })).toBeUndefined()
    expect(await ui.find({ key: 'swarm:browser:end:demo' })).toBeUndefined()
  })

  test("the transcript's tool lines in two colors: ↳ faint, the tool bold in the label color, its argument muted or a path's", async ($, on) => {
    mock.store(on)
    views(on, BROWSER)
    const ui = await mountAt($, 100)
    expect((await ui.find({ type: 'Text', text: /^Read$/ }))?.props).toEqual(expect.objectContaining({ bold: true, color: 'text' }))
    expect((await ui.find({ type: 'Text', text: /^ src\/lexer\.ts$/ }))?.props.color).toBe('suggestion')
    expect((await ui.find({ type: 'Text', text: /^ bun test$/ }))?.props.color).toBe('inactive')
    expect((await ui.find({ type: 'Text', text: /^ {2}↳ $/ }))?.props.color).toBe('subtle')
    expect((await ui.find({ type: 'Text', text: /^ · no outcome recorded$/ }))?.props.color).toBe('inactive')
  })

  test("the engine's ToolUseSummary, as view.ts's toolLine writes it (tier 2 builds it through the browser's transcript), draws `↳ Bash cd /x && grep -rn foo .`", async ($, on) => {
    mock.store(on)
    const line = [
      { text: '  ↳ ', color: 'subtle' },
      { text: 'Bash', color: 'text', bold: true },
      { text: ' cd /x && grep -rn foo .', color: 'inactive' },
      { text: ' · no outcome recorded', color: 'inactive' },
    ]
    views(on, { ...BROWSER, transcript: { ...BROWSER.transcript!, lines: [line] } })
    const ui = await mountAt($, 100)
    const rows = drawText(await ui.drawn(), 100)
    expect(rows.find(r => r.includes('↳ Bash'))).toMatch(/^│ {3}↳ Bash cd \/x && grep -rn foo \. · no outcome recorded +│$/)
  })

  test('a long transcript is a window at its newest lines, `↑ n earlier` muted under it', async ($, on) => {
    mock.store(on)
    const lines = Array.from({ length: 40 }, (_, i) => [{ text: `◆ ` , color: 'claude' }, { text: `line ${i + 1}` }])
    views(on, { ...BROWSER, transcript: { ...BROWSER.transcript!, lines } })
    const ui = await mountAt($, 100)
    const texts = await textsOf(ui)
    expect(texts).toContain('line 40')
    expect(texts).not.toContain('line 1')
    const footer = await ui.find({ type: 'Text', text: /^↑ \d+ earlier$/ })
    expect(footer?.props.color).toBe('inactive')
    const earlier = Number(/\d+/.exec(footer!.text)![0])
    expect(texts).toContain(`line ${earlier + 1}`)
    expect(texts).not.toContain(`line ${earlier}`)
  })

  test("the composer's message is a field, where it goes and how its caption; the summary after the roster, its age a warning when stale", async ($, on) => {
    mock.store(on)
    views(on, BROWSER)
    const ui = await mountAt($, 100)
    expect(await ui.find({ type: 'Input', key: 'swarm:browser:text:demo' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: "to fixer · interjects now · via parent (it's idle)" }))?.props.color).toBe('inactive')
    expect((await ui.find({ type: 'Text', text: 'generated 1m ago, before the latest event' }))?.props.color).toBe('warning')
    const rows = drawText(await ui.drawn(), 100)
    expect(rows.findIndex(r => r.startsWith('Summary '))).toBeGreaterThan(rows.findIndex(r => r.startsWith('Agents ')))
    expect(rowWith(rows, 'Events ')).toBeDefined()
  })

  test('inline: the roster first, the summary one line, no events', async ($, on) => {
    mock.store(on)
    views(on, BROWSER)
    const ui = await mountAt($, 100, 'inline')
    const rows = drawText(await ui.drawn(), 100)
    expect(rowWith(rows, 'Goal now parser first')).toBeDefined()
    expect(rows.some(r => r.startsWith('Summary '))).toBe(false)
    expect(rows.some(r => r.startsWith('Events '))).toBe(false)
  })
})

describe('Doctor', () => {
  test('a failing check first: its glyph and word in its color, what it found, its values muted; its fix the primary', async ($, on) => {
    mock.store(on)
    views(on, null, DOCTOR)
    const ui = await mountAt($, 100)
    // The words padded to one width (`! warning`'s), so the titles line up.
    expect((await ui.find({ type: 'Text', text: /^✕ fails {2}$/ }))?.props.color).toBe('error')
    expect((await ui.find({ type: 'Text', text: /^! warning$/ }))?.props.color).toBe('warning')
    expect((await ui.find({ type: 'Text', text: '✕ 1 check fails, 1 warning' }))?.props.color).toBe('error')
    expect((await ui.find({ type: 'Text', text: /^this process: 4$/ }))?.props.color).toBe('inactive')
    const rows = drawText(await ui.drawn(), 100)
    expect(rows.findIndex(r => r.includes('too few concurrent subagents'))).toBeLessThan(rows.findIndex(r => r.includes('no summary model set')))
    expect((await ui.find({ type: 'Button', key: 'swarm:doctor:ask-lead' }))?.props).toEqual(expect.objectContaining({ variant: 'primary', autoFocus: true }))
    expect((await ui.find({ type: 'Button', key: 'swarm:doctor:recheck' }))?.props.variant).toBeUndefined()
  })

  test('with nothing to fix, [Recheck] is the primary', async ($, on) => {
    mock.store(on)
    views(on, null, { ...DOCTOR, body: { ...DOCTOR.body!, rows: [DOCTOR.body!.rows[2]!], errors: 0, warnings: 0, snippet: null } })
    const ui = await mountAt($, 60)
    expect((await ui.find({ type: 'Text', text: '✓ nothing falls short' }))?.props.color).toBe('success')
    expect(await ui.find({ key: 'swarm:doctor:ask-lead' })).toBeUndefined()
    expect((await ui.find({ type: 'Button', key: 'swarm:doctor:recheck' }))?.props.variant).toBe('primary')
  })

  test("nothing checked yet names the next step", async ($, on) => {
    mock.store(on)
    views(on, null, { view: 'doctor', v: 1 })
    const ui = await mountAt($, 100)
    expect((await ui.find({ type: 'Text', text: /^\/litter doctor$/ }))?.props.color).toBe('suggestion')
  })
})

describe('a press opens a saved swarm', () => {
  test('a press on its row opens it: the builder for it is drawn', async ($, on) => {
    mock.store(on, navStore({ view: 'start', swarm: null }))
    mock.clock(on, { now: 1_800_000_000_000 })
    world(on)
    views(on, START)
    on('session.id', async () => ({ value: SESSION }))
    watch(on)
    const drawn: SwarmPaneView[] = []
    on('state.set', async (_$, e, next) => {
      const set = await next(e)
      if (e.key === 'swarmPane') drawn.push(e.value as SwarmPaneView)
      return set
    })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const ui = await mountAt($, 100)
    await ui.press({ key: 'swarm:start:open:demo' })
    expect(drawn.at(-1)).toEqual(expect.objectContaining({ view: 'builder', swarm: 'demo' }))
  })
})

describe('what needs you is the first thing in the body (the user\'s "It says it needs me, but where")', () => {
  test("the browser with a current proposal: the banner under the first line, before the roster and the summary, with [Review]", async ($, on) => {
    mock.store(on)
    views(on, { ...BROWSER, proposals: [6] })
    const ui = await mountAt($, 100)
    const rows = drawText(await ui.drawn(), 100)
    const first = rows.findIndex(r => r.startsWith('demo · ▸ live'))
    expect(rows[first + 1]).toBe(`⚑ the lead's proposal 6 waits on you [ Review ]`)
    expect(rows[first + 2]).toMatch(/^⚑ part-a asks: which branch\? \[ Answer \]/)
    expect(rows.findIndex(r => r.startsWith('Agents '))).toBeGreaterThan(first + 2)
    expect((await ui.find({ type: 'Text', text: "⚑ the lead's proposal 6 waits on you" }))?.props.color).toBe('permission')
    // Not a second primary: [Send] stays the one.
    expect((await ui.find({ type: 'Button', key: 'swarm:browser:builder:demo/6' }))?.props.dimColor).toBe(true)
  })

  test('[Review] on the browser reaches the proposal: the builder, whose first line is it with its own [Review]', async ($, on) => {
    mock.store(on, navStore({ view: 'browser', swarm: 'demo' }))
    mock.clock(on, { now: 1_800_000_000_000 })
    world(on)
    views(on, { ...BROWSER, proposals: [6] })
    on('session.id', async () => ({ value: SESSION }))
    watch(on)
    const drawn: SwarmPaneView[] = []
    on('state.set', async (_$, e, next) => {
      const set = await next(e)
      if (e.key === 'swarmPane') drawn.push(e.value as SwarmPaneView)
      return set
    })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const ui = await mountAt($, 100)
    await ui.press({ key: 'swarm:browser:builder:demo/6' })
    // This world has no live swarm and no ledger, so the builder is drawn; tier 2 walks it to the proposal.
    expect(drawn.at(-1)).toEqual(expect.objectContaining({ view: 'builder', swarm: 'demo' }))
  })

  test('only superseded proposals: no ⚑ anywhere; the builder lists them under "Older proposals", muted, each with [Reject]', async ($, on) => {
    mock.store(on)
    views(on, { ...BUILDER, proposals: [], superseded: [2, 3] })
    const ui = await mountAt($, 100)
    const rows = drawText(await ui.drawn(), 100)
    expect(rows.some(r => r.includes('⚑'))).toBe(false)
    expect(rowWith(rows, 'Older proposals, superseded')).toMatch(/^Older proposals, superseded ─+ 2 ──$/)
    expect((await ui.find({ type: 'Text', text: "the lead's proposal 2" }))?.props.color).toBe('inactive')
    expect(await ui.find({ type: 'Button', key: 'swarm:builder:reject:demo/2' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'swarm:builder:reject:demo/3' })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'swarm:builder:reject-older:demo' }))?.text).toBe('Reject all older')
    expect(await ui.find({ key: 'swarm:builder:proposal:demo/2' })).toBeUndefined()
    expect((await ui.findAll({ type: 'Button' })).filter(b => b.props.variant === 'primary').map(b => b.key)).toEqual(['swarm:builder:launch:demo'])
  })

  test('the start screen: each saved swarm that needs you, first, with [Review] or [Answer]', async ($, on) => {
    mock.store(on)
    views(on, {
      ...START,
      notice: null,
      swarms: [...START.swarms, { name: 'nightly', goal: 'triage', revision: 5, nodes: 4, live: true }],
      needsYou: [{ swarm: 'nightly', live: true, proposals: [6], questions: [{ who: 'part-a', text: 'which branch?' }] }],
    })
    const ui = await mountAt($, 100)
    const rows = drawText(await ui.drawn(), 100)
    const nav = rows.findIndex(r => r.startsWith('Home '))
    expect(rows[nav + 2]).toBe(`⚑ nightly: the lead's proposal 6 waits on you [ Review ]`)
    expect(rows[nav + 3]).toBe('⚑ nightly: part-a asks: which branch? [ Answer ]')
    expect(rows.findIndex(r => r.includes('Name:'))).toBeGreaterThan(nav + 3)
  })

  test("the events' time and who never wrap: fixed cells, the event wrapping in its own column", async ($, on) => {
    mock.store(on)
    const long = 'goal: the parser first, then the formatter, with a review of each part before it lands on main'
    views(on, {
      ...BROWSER,
      events: [
        { at: '00:47', who: 'summary', text: long, color: null },
        { at: '09:30', who: 'you → part-a', text: 'direct, interject: "go"', color: null },
      ],
    })
    const ui = await mountAt($, 60)
    const rows = drawText(await ui.drawn(), 60)
    const at = rows.findIndex(r => r.startsWith('00:47 summary      goal: the parser'))
    expect(at).toBeGreaterThan(0)
    // The rest of the event under its own column, past the time and who cells.
    expect(rows[at + 1]).toMatch(/^ {19}\S/)
    expect(rowWith(rows, '09:30 you → part-a')).toMatch(/^09:30 you → part-a direct, interject: "go"$/)
  })
})

describe('the commands', () => {
  const run = ($: Engine, args = '') =>
    $.command.run({ command: 'litter', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })

  /** What `litter` opened, each with `(focus)` when the open asked for the keyboard; the debug lines and the agent list answered. */
  const opens = (on: On): string[] => {
    const opened: string[] = []
    on('ui.open', async (_$, e) => {
      opened.push(e.focus ? `${e.id} (focus)` : e.id)
      return { value: { isPlaced: true } }
    })
    on('ui.log', async () => ({ value: undefined }))
    on('agent.list', async () => ({ value: [] }))
    on('session.id', async () => ({ value: SESSION }))
    return opened
  }

  test('session.start registers /litter alone, with the sections as its hint: no /litter-swarm or /litter-doctor', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1_800_000_000_000 })
    const { commands } = world(on)
    on('session.id', async () => ({ value: SESSION }))
    on('ui.log', async () => ({ value: undefined }))
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    expect(commands).toEqual([{ name: 'litter', argumentHint: '[home | runs | swarms | rules | tasks | agents | doctor] [arg]' }])
  })

  test('/litter swarms answers with a line and opens `litter` on Swarms, with the keyboard', async ($, on) => {
    mock.store(on)
    const opened = opens(on)
    const r = await run($, 'swarms')
    expect(r.text).toBe('Swarms shows the start screen')
    expect(opened).toEqual(['litter (focus)'])
    const named = await run($, 'swarms demo')
    expect(named.text).toBe('Swarms shows the builder for demo')
    // The pane draws Swarms: the hub's atom says so, the swarm pane's atom has the builder.
    const ui = await mountSwarm($, 'terminal')
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(texts).toContain(' · Swarms')
    // The body's first line: the swarm's name, then the view, no `litter · swarm builder` of its own.
    expect(texts).toEqual(expect.arrayContaining(['demo', ' · builder']))
    expect(texts.some(t => t.includes('swarm builder'))).toBe(false)
  })

  test('/litter doctor answers with a line and opens `litter` on Doctor, with the keyboard', async ($, on) => {
    mock.store(on)
    const opened = opens(on)
    const r = await run($, 'doctor')
    expect(r.text).toMatch(/^Doctor checks this session, with no swarm spec/)
    expect(opened).toEqual(['litter (focus)'])
    const ui = await mountSwarm($, 'terminal')
    expect(await ui.find({ type: 'Text', text: ' · Doctor' })).toBeDefined()
  })

  test("a swarm name that isn't one is the reply, and nothing opens", async ($, on) => {
    mock.store(on)
    const opened = opens(on)
    const r = await run($, 'swarms Not-A-Name')
    expect(r.text).toBe(`"Not-A-Name" isn't a swarm name (a-z, 0-9 and -, up to 24, not starting with -)`)
    expect(opened).toEqual([])
  })
})
