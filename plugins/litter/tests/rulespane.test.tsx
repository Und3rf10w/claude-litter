// Tier 1: the rules pane as the engine draws it and dispatches its presses
// (WP-AF; plan 16.3, 16.8, 12:1566), as the Rules section of the one
// `litter` pane (phase 5b, WP-DA), restyled by WP-DE: two tabs in a strip of
// their own, the rules an in-pane list (a Client with a right-click menu on
// the terminal and the desktop, plain Buttons elsewhere), the picked row's
// description and actions beside the list from 100 columns and under it
// below, what [Accept] writes on the line above it, and every part kept to
// the pane's rows (`fits`).
//
// Two ways in. Fed views: the rules view is answered beneath register.tsx's
// read (the hub's follows what the plugin writes, so a window it moves is
// drawn), and the pane's navigation (what each row showed, what a press
// waits on) and the section shown are seeded in $.store as a reload finds
// them. The plugin's module state isn't the test's, so AD's store can't be
// swapped there: the pane logs each store call before making it, and those
// tests count the lines. Live: proposals recorded through the plugin's own
// record tool, so each press redraws from the store, and what an accept, a
// dismiss and a retire write is read back from the files.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { HubView, RulesPaneView, RulesRow, SwarmSpan } from '../types/index'
import { drawText, drawWithColors, findNode, keyOf, type DrawnNode } from './drawing'

const SESSION = 'tier1-session'
const LITTER = '/repo/.claude/litter'
const RULES_LEDGER = `${LITTER}/rules-ledger/ledger`
const NOW = 1_800_000_000_000
const SURFACES = ['terminal', 'desktop'] as const
type Surface = 'terminal' | 'desktop' | 'vscode' | 'mobile'

type At = { bodyColumns?: number; bodyRows?: number; placement?: 'dock' | 'inline'; isFocused?: boolean }
const pane = (o: At = {}) =>
  ({
    title: 'litter',
    isFocused: o.isFocused ?? false,
    bodyColumns: o.bodyColumns ?? 100,
    placement: o.placement ?? 'dock',
    scroll: { offset: 0, bodyRows: o.bodyRows ?? 40 },
    view: {},
  }) as const

// ---------------------------------------------------------------------------
// The fed views: paneview.ts's words, as it builds them

const PROPOSED_S = { text: 'proposed', color: 'permission', glyph: '⚑' }
const UNVERIFIED_S = { text: 'unverified', color: 'permission', glyph: '⚑' }
const IN_FORCE_S = { text: 'in force', color: 'success', glyph: '✓' }

const at = (text: string): SwarmSpan => ({ text, color: 'suggestion' })
const gets = (scope: string, many = false): SwarmSpan => ({ text: `${scope === 'project' ? ', for you to commit' : ''}; every later run in ${scope} scope gets ${many ? 'them' : 'it'}` })
const writesNew = (folder: string, scope: string, letter: string): SwarmSpan[] => [{ text: 'Accept', bold: true }, { text: ' writes ' }, at(`${folder}/${letter}-….md`), gets(scope)]
const NO_SCOPE: SwarmSpan[] = [{ text: 'Accept', bold: true }, { text: ' writes nothing until you pick a scope' }]
const ID_LATER = 'its id is assigned when you accept it'

const proposalRow = (key: string, over: Partial<RulesRow> = {}): RulesRow => ({
  key,
  kind: 'proposal',
  id: null,
  version: null,
  scope: null,
  type: 'rule',
  status: PROPOSED_S,
  when: 'touching the parser',
  rule: `rule ${key}`,
  paths: [],
  origin: 'drafted from your words (/litter:rules add)',
  notes: [ID_LATER],
  diff: null,
  source: 'user',
  actions: ['accept', 'edit', 'dismiss'],
  consequence: NO_SCOPE,
  ...over,
})

const ROWS = {
  noScope: proposalRow('repo:5', {
    rule: 'Retry a flaky network call at most twice, with backoff.',
    when: 'calling the network from a test',
    paths: ['src/net/**'],
    origin: 'proposed by a gate critic in run 20261003-api at G2',
    source: 'critic',
  }),
  user: proposalRow('repo:3', {
    scope: 'user',
    rule: 'Run the parser tests before you change the grammar.',
    paths: ['src/parser/**'],
    consequence: writesNew('/cfg/litter/rules', 'user', 'U'),
  }),
  project: proposalRow('repo:4', {
    scope: 'project',
    rule: 'Keep generated files out of review.',
    when: 'reviewing a change',
    consequence: writesNew('.litter/rules', 'project', 'P'),
  }),
  edit: proposalRow('repo:6', {
    scope: 'project',
    edits: 'P-tests-first@2',
    rule: 'Write the failing test first, then the fix.',
    when: 'changing behavior',
    paths: ['src/**'],
    notes: [],
    diff: [
      { text: '  type: rule', dim: true },
      { text: '− Write the test first.', color: 'error' },
      { text: '+ Write the failing test first, then the fix.', color: 'success' },
    ],
    consequence: [{ text: 'Accept', bold: true }, { text: ' writes ' }, at('.litter/rules/P-tests-first.md'), { text: ' as version 3' }, gets('project')],
  }),
  ban: proposalRow('repo:7', {
    scope: 'project',
    type: 'ban',
    rule: 'Never commit secrets.',
    when: 'any change',
    consequence: writesNew('.litter/rules', 'project', 'P'),
  }),
  unverified: proposalRow('P-gen', {
    kind: 'unverified',
    id: 'P-gen',
    version: 2,
    scope: 'project',
    status: UNVERIFIED_S,
    rule: 'Regenerate the client after a schema change.',
    when: 'changing the schema',
    paths: ['schema/**'],
    origin: 'not accepted in the rules pane (a hand edit, a Write, or a copied file)',
    notes: ['P-gen@1 stays in force until you accept this', 'file /repo/.litter/rules/P-gen.md'],
    source: null,
    actions: ['accept'],
    consequence: [{ text: 'Accept', bold: true }, { text: ' marks ' }, at('.litter/rules/P-gen.md'), { text: ' accepted, as it stands' }, gets('project')],
  }),
}

const body = (over: Partial<NonNullable<RulesPaneView['body']>> = {}): NonNullable<RulesPaneView['body']> => ({
  notice: null,
  counts: { proposed: 6, inForce: 2 },
  rows: [ROWS.noScope, ROWS.user, ROWS.project, ROWS.edit, ROWS.ban, ROWS.unverified],
  batch: null,
  focus: 'repo:5',
  more: null,
  problems: [],
  pending: null,
  editing: null,
  ...over,
})

const PROPOSED: RulesPaneView = { view: 'rules', v: 3, tab: 'proposed', body: body() }
const proposedOn = (focus: string, over: Partial<NonNullable<RulesPaneView['body']>> = {}): RulesPaneView => ({ ...PROPOSED, body: body({ focus, ...over }) })

const importRow = (key: string, instance: string, checked: boolean, over: Partial<RulesRow> = {}): RulesRow =>
  proposalRow(key, {
    scope: 'project',
    type: 'ban',
    source: 'import',
    rule: `never ${key === 'repo:10' ? 'push to main' : key === 'repo:11' ? 'edit the workflows' : 'skip the review'}`,
    when: 'any change',
    origin: `from deepwork instance ${instance}, a user guardrail`,
    checked,
    instance,
    consequence: writesNew('.litter/rules', 'project', 'P'),
    ...over,
  })

const BATCH: RulesPaneView = {
  view: 'rules',
  v: 4,
  tab: 'proposed',
  body: body({
    counts: { proposed: 4, inForce: 2 },
    rows: [importRow('repo:10', 'auth-fix', true), importRow('repo:11', 'auth-fix', false, { paths: ['.github/**'] }), importRow('repo:12', 'old-plan', true, { notes: ['from an archived instance', ID_LATER] }), ROWS.user],
    batch: {
      seq: 9,
      instances: [
        { id: 'auth-fix', goal: 'fix the auth refresh', date: '2026-09-30', archived: false },
        { id: 'old-plan', goal: 'an old plan', date: '2026-08-01', archived: true },
      ],
      preselected: ['repo:10'],
      consequence: [{ text: 'Accept selected', bold: true }, { text: ' writes ' }, { text: '2 new files in ' }, at('.litter/rules/'), gets('project', true)],
    },
    focus: 'repo:10',
  }),
}

const IN_FORCE_ROWS: RulesRow[] = [
  {
    key: 'P-tests-first',
    kind: 'accepted',
    id: 'P-tests-first',
    version: 2,
    scope: 'project',
    type: 'rule',
    status: IN_FORCE_S,
    when: 'changing behavior',
    rule: 'Write the failing test first.',
    paths: ['src/**'],
    origin: 'accepted in the rules pane on 2026-09-30',
    notes: ['matches no file', 'local L-mine overrides U-theirs', 'an edit of it is proposed: see the Proposed tab'],
    diff: null,
    source: null,
    actions: ['edit', 'retire'],
  },
  {
    key: 'U-vendor',
    kind: 'accepted',
    id: 'U-vendor',
    version: 1,
    scope: 'user',
    type: 'ban',
    status: IN_FORCE_S,
    when: 'any change',
    rule: 'Never edit vendored code.',
    paths: ['vendor/**'],
    origin: 'accepted in the rules pane on 2026-09-12',
    notes: [],
    diff: null,
    source: null,
    actions: ['edit', 'retire'],
  },
]

const IN_FORCE: RulesPaneView = {
  view: 'rules',
  v: 5,
  tab: 'in-force',
  body: body({ counts: { proposed: 6, inForce: 2 }, rows: IN_FORCE_ROWS, focus: 'P-tests-first', problems: ['P-dup is in two scopes: project and local'] }),
}

/** A project rule file as previewAccept renders it: long enough to window at 30 rows. */
const PREVIEW_TEXT = [
  '---',
  'id: P-keep-generated',
  'version: 1',
  'type: rule',
  'status: accepted',
  'applies:',
  '  paths: []',
  '  when: reviewing a change',
  'accepted:',
  '  at: 2027-01-15',
  '  via: ui',
  '---',
  '',
  '## Rule',
  'Keep generated files out of review.',
  '',
  '## Why',
  'A generated file changes with its generator; reviewing it twice wastes a turn.',
  '',
  '## How to check',
  '- git diff --stat names no file under gen/',
  '- the review lists no generated file',
].join('\n')

const PREVIEW: RulesPaneView = proposedOn('repo:4', {
  pending: { kind: 'preview', key: 'repo:4', path: '.litter/rules/P-keep-generated.md', text: PREVIEW_TEXT },
  notice: { level: 'info', text: 'this is the exact file [Confirm accept] writes, for you to commit' },
  rows: [ROWS.noScope, ROWS.user, { ...ROWS.project, consequence: [{ text: 'Confirm accept', bold: true }, { text: ' writes ' }, at('.litter/rules/P-keep-generated.md'), gets('project')] }, ROWS.edit, ROWS.ban, ROWS.unverified],
})

const EDITING: RulesPaneView = proposedOn('repo:3', { editing: { key: 'repo:3', paths: 'src/parser/**', type: 'rule', error: null } })

// ---------------------------------------------------------------------------
// What the pane showed (paneview.ts's ShownRow), as the navigation keeps it

const shown = (key: string, over: Record<string, unknown> = {}) => ({
  kind: 'proposal',
  ref: { store: 'repo', seq: Number(key.split(':')[1]) },
  file: null,
  id: null,
  version: null,
  scope: null,
  type: 'rule',
  paths: [],
  source: 'user',
  batch: null,
  actions: ['accept', 'edit', 'dismiss'],
  ...over,
})

const SHOWN = {
  'repo:3': shown('repo:3', { scope: 'user' }),
  'repo:4': shown('repo:4', { scope: 'project' }),
  'repo:5': shown('repo:5'),
  'repo:6': shown('repo:6', { scope: 'project' }),
  'repo:7': shown('repo:7', { scope: 'project', type: 'ban' }),
  'P-tests-first': {
    kind: 'accepted',
    ref: null,
    file: '/repo/.litter/rules/P-tests-first.md',
    id: 'P-tests-first',
    version: 2,
    scope: 'project',
    type: 'rule',
    paths: ['src/**'],
    source: null,
    batch: null,
    actions: ['edit', 'retire'],
  },
  'repo:10': shown('repo:10', { source: 'import', scope: 'project', type: 'ban', batch: 9 }),
  'repo:11': shown('repo:11', { source: 'import', scope: 'project', type: 'ban', paths: ['.github/**'], batch: 9 }),
  'repo:12': shown('repo:12', { source: 'import', scope: 'project', type: 'ban', batch: 9 }),
}

const NAV = {
  tab: 'proposed',
  focus: null,
  batch: 9,
  seeded: 9,
  checked: ['repo:10', 'repo:12'],
  pending: null,
  editing: null,
  held: {},
  notice: null,
  shown: SHOWN,
  selected: null,
  more: null,
}

/** The navigation as a reload finds it in $.store, written by this session, with the hub's section shown: Rules. */
const navStore = (over: Record<string, unknown> = {}) => ({
  'litter.rules.pane': { v: 1, session: SESSION, nav: { ...NAV, ...over } },
  'litter.hub': { v: 1, session: SESSION, section: 'rules' },
})

/** The hub's view on Rules before the plugin writes one (no tabs yet: the render draws every section, uncounted). */
const HUB: HubView = { view: 'hub', v: 1, section: 'rules', live: [], tabs: [] }

/**
 * The rules view answered beneath register.tsx's read, the fed one (`show`
 * swaps it); the hub's the last the plugin wrote (so a window it moves is
 * drawn, on Rules; `hubs` holds each as written). Each read answers the
 * version the write beneath it stands at, so a second write's compare-and-set
 * lands. The writes are heard through the world's state.set.
 */
function views(on: On, w: World, view: RulesPaneView): { written: RulesPaneView[]; hubs: HubView[]; show: (next: RulesPaneView) => void } {
  let current = view
  const seen = { written: [] as RulesPaneView[], hubs: [] as HubView[], show: (next: RulesPaneView) => void (current = next) }
  let hub: HubView = HUB
  on('state.get', async (_$, e, next) => {
    if (e.key !== 'rulesPane' && e.key !== 'hub') return next(e)
    const beneath = (await next(e)) as { value?: { version?: number } }
    return { value: { value: e.key === 'rulesPane' ? current : hub, version: beneath.value?.version ?? 0 } }
  })
  w.onSet((key, value) => {
    if (key === 'rulesPane') seen.written.push(value as RulesPaneView)
    if (key === 'hub') {
      seen.hubs.push(value as HubView)
      hub = { ...(value as HubView), section: 'rules' }
    }
  })
  return seen
}

// ---------------------------------------------------------------------------
// The world

/**
 * What a test waits on: the next rules view the plugin writes, or the next
 * hub view that holds what `met` asks (each asked before the act that writes
 * it), or the files' map standing a way. Each resolves once that write has
 * landed, so a read after it sees it; a wait that's never met fails at the
 * test's timeout.
 */
type Waits = {
  nextRules: () => Promise<RulesPaneView>
  nextHub: (met: (view: HubView) => boolean) => Promise<HubView>
  until: (met: () => boolean) => Promise<void>
}

type World = Waits & {
  files: Map<string, string>
  logs: string[]
  toasts: string[]
  filled: string[]
  opened: { id: string; focus: boolean }[]
  /** Hears each $.state write once it has landed (a test hooks state.set once, here). */
  onSet: (heard: (key: string, value: unknown) => void) => void
}

/** $.fs from a map and git as a plain checkout at /repo answers it, so session.start resolves the litter directory. */
function world(on: On): World {
  const files = new Map<string, string>()
  const logs: string[] = []
  const toasts: string[] = []
  const filled: string[] = []
  const opened: { id: string; focus: boolean }[] = []
  const rulesWaits: ((view: RulesPaneView) => void)[] = []
  const hubWaits: { met: (view: HubView) => boolean; resolve: (view: HubView) => void }[] = []
  const untils: { met: () => boolean; resolve: () => void }[] = []
  const hearers: ((key: string, value: unknown) => void)[] = []
  // Each `until` is checked again once a write lands.
  const changed = () => {
    for (const u of [...untils]) {
      if (!u.met()) continue
      untils.splice(untils.indexOf(u), 1)
      u.resolve()
    }
  }
  const waits: Waits = {
    nextRules: () => new Promise(resolve => void rulesWaits.push(resolve)),
    nextHub: met => new Promise(resolve => void hubWaits.push({ met, resolve })),
    until: met => (met() ? Promise.resolve() : new Promise(resolve => void untils.push({ met, resolve }))),
  }
  // A view resolves its waits once the write beneath has landed (a compare-and-set refused resolves none).
  on('state.set', async (_$, e, next) => {
    const r = await next(e)
    for (const heard of hearers) heard(e.key, e.value)
    if (e.key === 'rulesPane') for (const resolve of rulesWaits.splice(0)) resolve(e.value as RulesPaneView)
    if (e.key === 'hub') {
      const view = e.value as HubView
      for (const h of [...hubWaits]) {
        if (!h.met(view)) continue
        hubWaits.splice(hubWaits.indexOf(h), 1)
        h.resolve(view)
      }
    }
    changed()
    return r
  })
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  const ran = (exitCode: number, stdout = '') => {
    changed()
    return { value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  }
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    changed()
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
    const a = e.argv
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
    // A folder is there once a file is under it (retireRule's .history).
    if (a[0] === 'mkdir') return ran(0)
    if (a[0] === 'git' && a.includes('rev-parse')) {
      if (a.includes('--show-toplevel') && !a.includes('--git-dir')) return ran(0, '/repo\n')
      if (a.includes('--git-dir') && a.includes('--git-common-dir')) return ran(0, '/repo/.git\n/repo/.git\n')
      // A local rule's accept excludes /.litter.local/ in the common dir's info/exclude.
      if (a.includes('--git-common-dir')) return ran(0, '/repo/.git\n')
    }
    return ran(1)
  })
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('agent.list', async () => ({ value: [] }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('ui.log', async (_$, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', async (_$, e) => {
    opened.push({ id: e.id, focus: e.focus === true })
    return { value: { isPlaced: true } }
  })
  on('ui.panes', async () => ({ value: [{ id: 'litter', title: 'litter', isShown: true, isFocused: true, isPlaced: true }] }))
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.cwd', async () => ({ value: '/repo' }))
  mock.env(on, { HOME: '/home/tier1', CLAUDE_CONFIG_DIR: '/cfg' })
  return { ...waits, files, logs, toasts, filled, opened, onSet: heard => void hearers.push(heard) }
}

/**
 * A click, a key or a post on a list's Client only posts: litter handles the
 * post (the hub presses the row's or the menu item's key on Rules) after the
 * act resolves, and the act's settle can stop before that press is done (it
 * gives up at the first 2 ms in which no host call starts or ends, and the
 * ledgers' records are hashed outside any). So the act waits for the rules
 * view its press ends by writing; a read after it sees that press's work and
 * its drawing. Answers that view.
 */
async function posted(w: Waits, act: () => Promise<void>): Promise<RulesPaneView> {
  const drawn = w.nextRules()
  await act()
  return drawn
}

/** A session started in /repo, interactive unless said, with the navigation seeded and the view fed. */
async function start($: Engine, on: On, opts: { nav?: Record<string, unknown>; view?: RulesPaneView; interactive?: boolean; files?: Record<string, string> } = {}) {
  mock.store(on, navStore(opts.nav))
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  for (const [k, v] of Object.entries(opts.files ?? {})) w.files.set(k, v)
  const seen = views(on, w, opts.view ?? PROPOSED)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: opts.interactive ?? true })
  return { ...w, ...seen, clock }
}

const mountRules = <S extends Surface>($: Engine, surface: S, o: At = {}) => $.ui.mount({ plugin: 'litter', surface, component: 'Pane', requestId: 'litter', props: pane(o) })
/** A terminal's drawing: the one with Clients, so pointer, key and post. */
type Ui = Awaited<ReturnType<typeof mountRules<'terminal'>>>

/** The store calls the pane logged, in order (`rules pane: <fn> …`). */
const storeCalls = (logs: readonly string[]) =>
  logs.filter(l => /^rules pane: (acceptRule|dismissRule|retireRule|previewAccept) /.test(l)).map(l => l.slice('rules pane: '.length))
const acting = (logs: readonly string[]) => storeCalls(logs).filter(l => /^(acceptRule|dismissRule|retireRule) /.test(l))

/** The drawing as rows of text, each list's Client drawn in its place (tests/drawing.ts draws a Client as its key) and each Code as its lines. */
async function drawing(ui: Ui, columns: number, colors = false): Promise<string[]> {
  const tree = (await ui.drawn()) as unknown
  const spliced = await splice(ui, tree)
  return colors ? drawWithColors(spliced, columns) : drawText(spliced, columns)
}

async function splice(ui: Ui, node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(n => splice(ui, n)))
  if (typeof node !== 'object' || node === null) return node
  const n = node as DrawnNode
  if (n.type === 'Client') return ui.drawn({ in: keyOf(n) ?? '' })
  if (n.type === 'Code') {
    const source = String(n.props?.source ?? '')
    return { type: 'Box', props: { flexDirection: 'column' }, children: source.split('\n').map(l => ({ type: 'Text', props: { wrap: 'truncate-end' }, children: [l] })) }
  }
  const children = n.children ?? (n.props?.children as unknown[] | undefined)
  if (!children) return n
  return { ...n, children: await splice(ui, children), props: { ...(n.props ?? {}), children: undefined } }
}

/** The picked row's detail as drawn (from 100 columns the Box beside the lists, below it the whole body), its rows as one line of words. */
async function detailWords(ui: Ui, columns: number): Promise<string> {
  const tree = await splice(ui, await ui.drawn())
  const width = columns - 2 - Math.floor((columns - 2) * 0.55)
  const node = columns >= 100 ? findNode(tree, n => n.type === 'Box' && n.props?.width === width) : tree
  return drawText(node, columns >= 100 ? width : columns)
    .map(r => r.trim())
    .filter(r => r !== '')
    .join(' ')
    .replace(/ +/g, ' ')
}

type Found = NonNullable<Awaited<ReturnType<Ui['find']>>>
/** The Text holding `text`; failing, the drawing at `columns`, so the failure says what was drawn instead. */
async function shows(ui: Ui, text: string | RegExp, columns = 100): Promise<Found> {
  const found = await ui.find({ type: 'Text', text })
  if (found) return found
  throw new Error(`no Text holding ${String(text)} is drawn; the drawing:\n${(await drawing(ui, columns)).join('\n')}`)
}

/** The row of a drawing whose text holds `part`, or -1. */
const rowOf = (rows: readonly string[], part: string) => rows.findIndex(r => r.includes(part))

/** The body's rows: from the tabs (the shown one first or second) to the last drawn row before the keys line (or the end). */
function bodyRows(rows: readonly string[]): string[] {
  const from = rows.findIndex(r => /(^|\s)› [⚑✓] (Proposed|In force) \d/.test(r))
  expect(from).toBeGreaterThanOrEqual(0)
  const keys = rows.findIndex((r, i) => i > from && /^(ctrl\+x tab gives the pane the keys|j\/k |right-click |1–8 )/.test(r))
  const body = rows.slice(from, keys < 0 ? undefined : keys)
  while (body.length > 0 && body[body.length - 1]!.trim() === '') body.pop()
  return body
}

/** The rows a pane of `bodyRows` gives the body in the dock: the header's two, the strip's one, the gap, the keys line's two (ui/pane.tsx's plan). */
const bodyBudget = (bodyRows: number) => bodyRows - 6
const INLINE_ROWS = 18

// ---------------------------------------------------------------------------
// The two tabs

describe('the two tabs, at 100 and 60 columns, docked and inline', () => {
  const cases = [
    { name: 'Proposed', view: PROPOSED, nav: {}, shown: '› ⚑ Proposed 6', color: 'permission', other: ['rules:tab:in-force', '✓ In force 2'], last: '[ Accept ]', word: /⚑ (proposed|unverified)/ },
    { name: 'In force', view: IN_FORCE, nav: { tab: 'in-force' }, shown: '› ✓ In force 2', color: 'success', other: ['rules:tab:proposed', '⚑ Proposed 6'], last: '[ Retire ]', word: /✓ in force/ },
  ] as const
  for (const c of cases) {
    for (const columns of [100, 60]) {
      for (const placement of ['dock', 'inline'] as const) {
        test(`${c.name} at ${columns} columns, ${placement}`, async ($, on) => {
          await start($, on, { view: c.view, nav: c.nav })
          const ui = await mountRules($, 'terminal', { bodyColumns: columns, bodyRows: 40, placement })
          // A strip of their own: the shown tab bold in its mark's color with `›`, the other a plain Button; each with its count.
          expect((await ui.find({ type: 'Text', text: c.shown }))?.props).toEqual(expect.objectContaining({ bold: true, color: c.color }))
          const other = await ui.find({ type: 'Button', key: c.other[0] })
          expect(other?.text).toBe(c.other[1])
          expect(other?.props.plain).toBe(true)
          // No title line of the section's own: the hub's header names it.
          expect(await ui.find({ type: 'Text', text: 'litter · rules' })).toBeUndefined()
          // The rows are the chrome's list, a Client here: one row per rule, each with its status word (inline, the window's).
          const listed = drawText(await ui.drawn({ in: 'rules:list:main' }), columns)
          const rows = listed.filter(r => c.word.test(r))
          if (placement === 'dock') expect(rows).toHaveLength(c.view.body!.rows.length)
          else expect(rows.length).toBeGreaterThan(0)
          // A proposal never wears the in-force mark, nor a rule in force the proposed one.
          expect(listed.some(r => (c.name === 'Proposed' ? /in force/ : /proposed/).test(r))).toBe(false)
          const drawn = await drawing(ui, columns)
          const inBody = bodyRows(drawn)
          // `fits`: everything the body lays out is drawn, its last action included, within its rows.
          expect(rowOf(inBody, c.last)).toBeGreaterThan(0)
          if (placement === 'dock') expect(inBody.length).toBeLessThanOrEqual(bodyBudget(40))
          // Inline: the compact form, a few rows above the prompt.
          else expect(inBody.length).toBeLessThanOrEqual(INLINE_ROWS)
          // The picked row's detail beside the list from 100 columns (same row as the first list row), under it below.
          const head = rowOf(drawn, c.name === 'Proposed' ? 'new rule ─' : 'P-tests-first@2 ─')
          const first = rowOf(drawn, c.name === 'Proposed' ? 'Retry a flaky' : 'Write the failing test fir')
          if (columns >= 100) expect(head).toBe(first)
          else expect(head).toBeGreaterThan(first)
        })
      }
    }
  }

  test('in the dock the hub clips the body to its rows (`fits`), and the keys line names the list\'s keys', async ($, on) => {
    await start($, on)
    const ui = await mountRules($, 'terminal', { bodyColumns: 100, bodyRows: 30, isFocused: true })
    const tree = await ui.drawn()
    // Rules' two key hints and the hub's wrap the keys line to two rows at 100 columns; the second comes off the body's (pane.tsx's keysOverflow).
    const clipped = findNode(tree, n => n.type === 'Box' && n.props?.overflow === 'hidden' && n.props?.height === bodyBudget(30) - 1)
    expect(clipped).not.toBeNull()
    expect(await ui.find({ type: 'Text', text: 'j/k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'right-click' })).toBeDefined()
    // [previous] and [next] take k and j while the pane has the keys: a Client's rows are no Tab stop.
    expect((await ui.find({ type: 'Button', key: 'rules:next' }))?.props).toEqual(expect.objectContaining({ plain: true, hotkey: 'j' }))
    expect((await ui.find({ type: 'Button', key: 'rules:prev' }))?.props).toEqual(expect.objectContaining({ plain: true, hotkey: 'k' }))
    // No Button anywhere has a digit hotkey but the strip's.
    const digits = (await ui.findAll({ type: 'Button' })).filter(b => /^[0-9]$/.test(String(b.props.hotkey ?? '')) && !String(b.key).startsWith('litter:section:'))
    expect(digits).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The cases

describe('the cases, at 100 and 60 columns', () => {
  for (const columns of [100, 60]) {
    test(`a proposal with no scope, at ${columns}`, async ($, on) => {
      await start($, on, { view: PROPOSED })
      const ui = await mountRules($, 'terminal', { bodyColumns: columns })
      expect((await ui.find({ type: 'Text', text: /no scope yet/, in: 'rules:list:main' }))?.text).toContain('! no scope yet')
      expect((await ui.find({ type: 'Text', text: '! no scope yet' }))?.props.color).toBe('warning')
      // The pick stays explicit: nothing picked, a Button per scope.
      expect(await ui.find({ type: 'Text', text: 'pick a scope' })).toBeDefined()
      for (const s of ['user', 'project', 'local']) expect((await ui.find({ type: 'Button', key: `rules:scope-${s}:repo:5` }))?.props.plain).toBe(true)
      // What [Accept] does, on the line above it; Accept is the proposal's primary.
      expect(await ui.find({ type: 'Text', text: ' writes nothing until you pick a scope' })).toBeDefined()
      const accept = await ui.find({ type: 'Button', key: 'rules:accept:repo:5' })
      expect(accept?.props.variant).toBe('primary')
      const rows = await drawing(ui, columns)
      expect(rowOf(rows, 'Accept writes nothing until you pick a scope')).toBe(rowOf(rows, '[ Accept ]') - 1)
    })

    test(`an import batch, at ${columns}`, async ($, on) => {
      await start($, on, { view: BATCH })
      const ui = await mountRules($, 'terminal', { bodyColumns: columns })
      const head = await ui.find({ type: 'Text', text: 'Import from deepwork' })
      expect(head?.props).toEqual(expect.objectContaining({ bold: true, color: 'suggestion' }))
      expect(await ui.find({ type: 'Text', text: '2 of 3 checked' })).toBeDefined()
      // Each instance a heading, its goal muted under it, its rules a list with check boxes.
      expect(await ui.find({ type: 'Text', text: '✓ live auth-fix' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '− archived old-plan' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '2026-09-30' })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: 'fix the auth refresh' }))?.props.color).toBe('inactive')
      const live = drawText(await ui.drawn({ in: 'rules:list:i0' }), columns)
      expect(live.filter(r => /\[x\] never push to main/.test(r))).toHaveLength(1)
      expect(live.filter(r => /\[ \] never edit the work/.test(r))).toHaveLength(1)
      expect(drawText(await ui.drawn({ in: 'rules:list:i1' }), columns).filter(r => /\[x\] never skip the review/.test(r))).toHaveLength(1)
      // The proposals outside the batch, under their own heading.
      expect(await ui.find({ type: 'Text', text: 'Other proposals' })).toBeDefined()
      expect(drawText(await ui.drawn({ in: 'rules:list:main' }), columns).some(r => r.includes('Run the parser tests'))).toBe(true)
      // [Accept selected] is the one primary, with what it writes; the row's own [Accept] is secondary, and it can be unchecked.
      expect((await ui.find({ type: 'Button', key: 'rules:accept-selected:9' }))?.props.variant).toBe('primary')
      expect(await ui.find({ type: 'Text', text: '2 new files in ' })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'rules:accept:repo:10' }))?.props.variant).toBeUndefined()
      expect((await ui.find({ type: 'Button', key: 'rules:check:repo:10' }))?.text).toBe('Uncheck')
      expect((await ui.findAll({ type: 'Button' })).filter(b => b.props.variant === 'primary')).toHaveLength(1)
      // An import's scope is project, and can be changed before [Accept].
      expect(await ui.find({ type: 'Text', text: '› project' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'rules:scope-user:repo:10' })).toBeDefined()
    })

    test(`an accepted rule with a newer proposal: its diff, at ${columns}`, async ($, on) => {
      await start($, on, { view: proposedOn('repo:6') })
      const ui = await mountRules($, 'terminal', { bodyColumns: columns })
      await shows(ui, 'edit of P-tests-first@2', columns)
      await shows(ui, 'against the version in force:', columns)
      expect((await ui.find({ type: 'Text', text: '+ Write the failing test first, then the fix.' }))?.props.color).toBe('success')
      expect((await ui.find({ type: 'Text', text: '− Write the test first.' }))?.props.color).toBe('error')
      // An edit stays in its rule's scope: no pick, and [Accept] writes the next version of its file.
      expect(await ui.find({ type: 'Button', key: 'rules:scope-user:repo:6' })).toBeUndefined()
      expect(await detailWords(ui, columns)).toContain('Accept writes .litter/rules/P-tests-first.md as version 3, for you to commit; every later run in project scope gets it [ Accept ]')
      expect((await ui.find({ type: 'Text', text: '.litter/rules/P-tests-first.md' }))?.props.color).toBe('suggestion')
    })

    test(`a ban with no paths, and one that protects its paths, at ${columns}`, async ($, on) => {
      const s = await start($, on, { view: proposedOn('repo:7') })
      const ui = await mountRules($, 'terminal', { bodyColumns: columns })
      // Its line in the warning color, wrapped at the detail's width.
      expect((await ui.find({ type: 'Text', text: /^! no paths: it reaches every gate/ }))?.props.color).toBe('warning')
      const warnings = (await ui.findAll({ type: 'Text' })).filter(t => t.props.color === 'warning').map(t => t.text)
      expect(warnings.join(' ')).toContain('! no paths: it reaches every gate, but protects nothing by name')
      // A ban in force with paths: they're what it protects, in the path color.
      s.show({ ...IN_FORCE, body: { ...IN_FORCE.body!, focus: 'U-vendor' } })
      await ui.redraw()
      expect((await ui.find({ type: 'Text', text: 'protects ' }))?.props.color).toBe('inactive')
      expect((await ui.find({ type: 'Text', text: 'vendor/**' }))?.props.color).toBe('suggestion')
      expect(await ui.find({ type: 'Text', text: /protects nothing/ })).toBeUndefined()
    })

    test(`the editor open, at ${columns}`, async ($, on) => {
      await start($, on, { view: EDITING })
      const ui = await mountRules($, 'terminal', { bodyColumns: columns })
      const tree = await ui.drawn()
      const input = findNode(tree, n => n.type === 'Input' && keyOf(n) === 'rules:paths:repo:3')
      expect(input?.props).toEqual(expect.objectContaining({ label: 'Paths', value: 'src/parser/**' }))
      // A field: framed, its caption one muted line under the frame, saying what an empty one means.
      const rows = await drawing(ui, columns)
      const at = rowOf(rows, 'Paths: src/parser/**')
      expect(rows[at - 1]).toMatch(/╭─+╮/)
      expect(rows[at + 2]).toContain('globs, comma-separated; empty: every gate')
      expect((await ui.find({ type: 'Text', text: 'globs, comma-separated; empty: every gate' }))?.props.color).toBe('inactive')
      // Type a short Select, and [Done].
      expect((await ui.find({ type: 'Select', key: 'rules:type:repo:3' }))?.props).toEqual(expect.objectContaining({ label: 'Type', value: 'rule' }))
      expect(await ui.find({ type: 'Button', key: 'rules:edit-done:repo:3' })).toBeDefined()
    })

    test(`the accept preview takes the body, [Cancel] in view, at ${columns}`, async ($, on) => {
      await start($, on, { view: PREVIEW })
      const ui = await mountRules($, 'terminal', { bodyColumns: columns, bodyRows: 30 })
      expect(await ui.find({ type: 'Text', text: 'The file [Confirm accept] writes' })).toBeDefined()
      if (columns >= 100) expect((await ui.find({ type: 'Text', text: '.litter/rules/P-keep-generated.md' }))?.props.color).toBe('suggestion')
      expect(await ui.find({ type: 'Text', text: 'Confirm accept' })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'rules:confirm:repo:4' }))?.props.variant).toBe('primary')
      expect(await ui.find({ type: 'Button', key: 'rules:cancel:repo:4' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'rules:accept:repo:4' })).toBeUndefined()
      // No list while it waits: the file is the body.
      expect(await ui.find({ type: 'Client' })).toBeUndefined()
      const code = await ui.find({ type: 'Code' })
      expect(String(code?.props.source).split('\n')[0]).toBe('---')
      expect(code?.props.language).toBe('markdown')
      // The file is windowed; [↓ n more] moves it, the buttons stay where they are.
      const down = await ui.find({ type: 'Button', key: 'rules:window:preview:down' })
      expect(down?.text).toMatch(/^↓ \d+ more$/)
      await ui.press({ key: 'rules:window:preview:down' })
      expect(String((await ui.find({ type: 'Code' }))?.props.source).split('\n')[0]).not.toBe('---')
      expect(await ui.find({ type: 'Button', key: 'rules:window:preview:up' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'rules:cancel:repo:4' })).toBeDefined()
      expect(bodyRows(await drawing(ui, columns)).length).toBeLessThanOrEqual(bodyBudget(30))
    })
  }

  test('a rule in force: where it came from, and the notes that flag something in the warning color', async ($, on) => {
    await start($, on, { view: IN_FORCE, nav: { tab: 'in-force' } })
    const ui = await mountRules($, 'terminal', { bodyColumns: 100 })
    expect((await shows(ui, 'accepted in the rules pane on 2026-09-30')).props.color).toBe('inactive')
    expect((await ui.find({ type: 'Text', text: '! matches no file' }))?.props.color).toBe('warning')
    expect((await ui.find({ type: 'Text', text: '! local L-mine overrides U-theirs' }))?.props.color).toBe('warning')
    // A note that flags nothing, muted (wrapped at the detail's width).
    expect((await shows(ui, /^an edit of it is proposed/)).props.color).toBe('inactive')
    expect((await ui.find({ type: 'Text', text: 'src/**' }))?.props.color).toBe('suggestion')
    // Retire is never the primary.
    expect((await ui.find({ type: 'Button', key: 'rules:retire:P-tests-first' }))?.props.variant).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'rules:accept:P-tests-first' })).toBeUndefined()
  })

  test('the problems: above the list as warnings, the rest under [More]; and all of them taking the body', async ($, on) => {
    const problems = ['P-dup is in two scopes: project and local', 'L-x overrides nothing', 'U-y has no version', 'P-z is in a folder of another scope', 'P-w has an unknown key']
    const s = await start($, on, { view: { ...IN_FORCE, body: { ...IN_FORCE.body!, problems } }, nav: { tab: 'in-force' } })
    const ui = await mountRules($, 'terminal', { bodyColumns: 60 })
    expect((await ui.find({ type: 'Text', text: '! P-dup is in two scopes: project and local' }))?.props.color).toBe('warning')
    expect(await ui.find({ type: 'Text', text: '! L-x overrides nothing' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '! U-y has no version' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: '! 3 more problems' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rules:more:problems' })).toBeDefined()
    // Above the list.
    const rows = await drawing(ui, 60)
    expect(rowOf(rows, '! P-dup')).toBeLessThan(rowOf(rows, 'Write the failing test first.'))
    // [More] on them: every one, taking the body, and [Back].
    s.show({ ...IN_FORCE, body: { ...IN_FORCE.body!, problems, more: 'problems' } })
    await ui.redraw()
    expect(await ui.find({ type: 'Text', text: 'Problems' })).toBeDefined()
    for (const p of problems) expect(await ui.find({ type: 'Text', text: `! ${p}` })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rules:less' })).toBeDefined()
    expect(await ui.find({ type: 'Client' })).toBeUndefined()
  })

  test("a row's whole description takes the body under [More], windowed, with [Less]", async ($, on) => {
    const long = proposalRow('repo:8', { scope: 'user', rule: Array.from({ length: 30 }, (_, i) => `step ${i + 1} of the rule`).join('\n'), consequence: writesNew('/cfg/litter/rules', 'user', 'U') })
    const s = await start($, on, { view: proposedOn('repo:8', { rows: [long, ROWS.user] }) })
    const ui = await mountRules($, 'terminal', { bodyColumns: 60, bodyRows: 30 })
    expect(await ui.find({ type: 'Text', text: /more lines of its description/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rules:more:repo:8' })).toBeDefined()
    s.show(proposedOn('repo:8', { rows: [long, ROWS.user], more: 'repo:8' }))
    await ui.redraw()
    expect(await ui.find({ type: 'Client' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'all of it' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rules:less' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'step 1 of the rule' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rules:window:detail:down' })).toBeDefined()
    await ui.press({ key: 'rules:window:detail:down' })
    expect(await ui.find({ type: 'Text', text: 'step 1 of the rule' })).toBeUndefined()
    // Its actions stay under it.
    expect(await ui.find({ type: 'Button', key: 'rules:accept:repo:8' })).toBeDefined()
    expect(bodyRows(await drawing(ui, 60)).length).toBeLessThanOrEqual(bodyBudget(30))
  })
})

// ---------------------------------------------------------------------------
// Every action, by its Button and by the list's menu

/** A pick from the list's right-click menu, as its Client posts it (ui/listmenu.tsx): the hub presses the key on Rules. Answers the view that press wrote. */
const menuPick = (w: Waits, ui: Ui, list: string, key: string) => posted(w, () => ui.post({ list, press: key }, { in: list }))

const MENU_WORDS = new Set(['Accept', 'Edit…', 'Dismiss', 'Retire', 'Check', 'Uncheck', 'close'])
/** The open menu's items, as the list's Client draws them (one padded Text each, under the row's own text). */
const menuItems = async (ui: Ui, list: string): Promise<string[]> =>
  (await ui.findAll({ type: 'Text', in: list })).map(t => t.text.trim()).filter(t => MENU_WORDS.has(t))

describe('every action reaches the store by its Button and by the menu, one press at a time', () => {
  for (const by of ['press', 'menu'] as const) {
    // A Button is the picked row's; the menu is any row's, so its row is picked only for the press.
    const act = async (w: Waits, ui: Ui, key: string, list = 'rules:list:main') => {
      if (by === 'press') return ui.press({ key })
      await menuPick(w, ui, list, key)
      return undefined
    }
    const on_ = (view: RulesPaneView, key: string): RulesPaneView => (by === 'press' ? { ...view, body: { ...view.body!, focus: key } } : view)

    test(`[Accept] on a user proposal calls acceptRule once, and nothing else (${by})`, async ($, on) => {
      const s = await start($, on, { view: on_(PROPOSED, 'repo:3') })
      const ui = await mountRules($, 'terminal')
      await act(s, ui, 'rules:accept:repo:3')
      expect(storeCalls(s.logs)).toEqual(['acceptRule repo:3 user'])
    })

    test(`a project proposal shows the preview first: [Accept] calls previewAccept, never acceptRule (${by})`, async ($, on) => {
      const s = await start($, on, { view: on_(PROPOSED, 'repo:4') })
      const ui = await mountRules($, 'terminal')
      await act(s, ui, 'rules:accept:repo:4')
      expect(storeCalls(s.logs)).toEqual(['previewAccept repo:4 project'])
    })

    test(`a scope is asked when there is none: [Accept] calls nothing (${by})`, async ($, on) => {
      const s = await start($, on)
      const ui = await mountRules($, 'terminal')
      await act(s, ui, 'rules:accept:repo:5')
      expect(storeCalls(s.logs)).toEqual([])
      expect(s.logs).toContain('rules pane: asks the scope for repo:5')
      expect(s.written.at(-1)?.body?.notice?.text).toContain('pick the scope to accept it into')
    })

    test(`[Dismiss] calls dismissRule (${by})`, async ($, on) => {
      const s = await start($, on, { view: on_(PROPOSED, 'repo:3') })
      const ui = await mountRules($, 'terminal')
      await act(s, ui, 'rules:dismiss:repo:3')
      expect(storeCalls(s.logs)).toEqual(['dismissRule repo:3'])
    })

    test(`[Retire] asks for [Confirm retire] first, which calls retireRule (${by})`, async ($, on) => {
      const s = await start($, on, { view: IN_FORCE, nav: { tab: 'in-force' } })
      const ui = await mountRules($, 'terminal')
      await act(s, ui, 'rules:retire:P-tests-first')
      expect(storeCalls(s.logs)).toEqual([])
      expect(s.written.at(-1)?.body?.notice?.text ?? '').toContain('[Confirm retire]')
    })

    test(`[Edit…] on a rule in force fills the prompt with /litter:rules show <id> (${by})`, async ($, on) => {
      const s = await start($, on, { view: IN_FORCE, nav: { tab: 'in-force' } })
      const ui = await mountRules($, 'terminal')
      await act(s, ui, 'rules:edit:P-tests-first')
      expect(s.filled).toEqual(['/litter:rules show P-tests-first'])
      expect(acting(s.logs)).toEqual([])
    })

    test(`a check toggles a row of the batch, and calls nothing (${by})`, async ($, on) => {
      const s = await start($, on, { view: on_(BATCH, 'repo:11') })
      const ui = await mountRules($, 'terminal')
      expect(await act(s, ui, 'rules:check:repo:11', 'rules:list:i0')).toEqual(by === 'press' ? expect.objectContaining({ element: 'rules:check:repo:11' }) : undefined)
      expect(storeCalls(s.logs)).toEqual([])
    })
  }

  test("the menu is the row's actions, only those that apply, from a right-click on its row", async ($, on) => {
    const s = await start($, on, { view: BATCH })
    const ui = await mountRules($, 'terminal')
    // The batch's first list: its second row, right-clicked.
    await ui.pointer({ type: 'down', x: 4, y: 1, button: 'right', in: 'rules:list:i0' })
    expect(await menuItems(ui, 'rules:list:i0')).toEqual(['Accept', 'Edit…', 'Dismiss', 'Check', 'close'])
    // ↓ ↓ to Dismiss (the menu's own), Enter: the press its Button would make, posted.
    await ui.key({ key: 'down', in: 'rules:list:i0' })
    await ui.key({ key: 'down', in: 'rules:list:i0' })
    await posted(s, () => ui.key({ key: 'return', in: 'rules:list:i0' }))
    expect(storeCalls(s.logs)).toEqual(['dismissRule repo:11'])
    // A rule in force offers Edit… and Retire, never Accept.
    s.show(IN_FORCE)
    await ui.redraw()
    await ui.pointer({ type: 'down', x: 4, y: 0, button: 'right', in: 'rules:list:main' })
    expect(await menuItems(ui, 'rules:list:main')).toEqual(['Edit…', 'Retire', 'close'])
  })

  test('after the preview, [Confirm accept] calls acceptRule once', async ($, on) => {
    const pending = { kind: 'preview', key: 'repo:4', path: '/repo/.litter/rules/P-parser.md', text: '## Rule\nParse once.\n' }
    const s = await start($, on, { view: PREVIEW, nav: { pending } })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:confirm:repo:4' })
    expect(storeCalls(s.logs)).toEqual(['acceptRule repo:4 project'])
  })

  test('[Confirm accept] on a stale drawing, with no preview waiting, is ignored with a toast', async ($, on) => {
    const s = await start($, on, { view: PREVIEW })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:confirm:repo:4' })
    expect(storeCalls(s.logs)).toEqual([])
    expect(s.toasts.some(t => t.includes('no file waiting to be confirmed'))).toBe(true)
  })

  // Live, since a press redraws from the plugin's own store (a fed view's rows are gone after one).
  test('a scope picked, then [Accept]: acceptRule once, into that scope; the pick itself accepts nothing', { timeoutMs: 20000 }, async ($, on) => {
    const w = await live($, on)
    const { logs, files } = w
    const ui = await mountRules($, 'terminal')
    // The ban, with no scope yet: clicked, so its actions are drawn.
    const picked = await posted(w, () => ui.pointer({ type: 'down', x: 4, y: 2, button: 'left', in: 'rules:list:main' }))
    expect(picked.body?.focus).toBe('repo:3')
    await ui.press({ key: 'rules:scope-local:repo:3' })
    expect(storeCalls(logs)).toEqual([])
    expect((await shows(ui, '› local')).props.bold).toBe(true)
    await ui.press({ key: 'rules:accept:repo:3' })
    expect(storeCalls(logs)).toEqual(['acceptRule repo:3 local'])
    await shows(ui, /accepted into local scope/)
    expect([...files.keys()].filter(k => k.includes('/L-'))).toEqual(['/repo/.litter.local/rules/L-never-commit-secrets.md'])
  })

  test('[Accept selected] on an import batch of project bans previews exactly the checked ones, and accepts none yet', async ($, on) => {
    const s = await start($, on, { view: BATCH })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:accept-selected:9' })
    expect(storeCalls(s.logs)).toEqual(['previewAccept repo:10 project', 'previewAccept repo:12 project'])
  })

  test('[Accept selected] accepts exactly the checked ones, one by one, in the scopes picked', async ($, on) => {
    const s = await start($, on, { view: BATCH, nav: { held: { 'repo:10': { scope: 'local' }, 'repo:11': { scope: 'local' }, 'repo:12': { scope: 'user' } } } })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:accept-selected:9' })
    expect(storeCalls(s.logs)).toEqual(['acceptRule repo:10 local', 'acceptRule repo:12 user'])
  })

  test('[Confirm accept] on a batch accepts exactly the checked ones, one by one', async ($, on) => {
    const pending = { kind: 'preview', key: 'batch:9', path: '/repo/.litter/rules/', text: '--- a\n--- b' }
    const view: RulesPaneView = { ...BATCH, body: { ...BATCH.body!, pending: pending as never } }
    const s = await start($, on, { view, nav: { pending } })
    const ui = await mountRules($, 'terminal')
    expect(await ui.find({ type: 'Text', text: 'The files [Confirm accept] writes' })).toBeDefined()
    await ui.press({ key: 'rules:confirm:batch:9' })
    expect(storeCalls(s.logs)).toEqual(['acceptRule repo:10 project', 'acceptRule repo:12 project'])
    // Each failure is reported (the fed store has no such proposal).
    expect(s.written.at(-1)?.body?.notice?.text).toMatch(/^accepted 0 of 2; not accepted: repo:10: .*; repo:12: /)
  })

  test('[Confirm retire] calls retireRule with the version shown; neither it nor [Cancel] is primary', async ($, on) => {
    const pending = { kind: 'retire', key: 'P-tests-first' }
    const view: RulesPaneView = { ...IN_FORCE, body: { ...IN_FORCE.body!, pending: pending as never } }
    const s = await start($, on, { view, nav: { tab: 'in-force', pending } })
    const ui = await mountRules($, 'terminal')
    expect((await ui.find({ type: 'Text', text: /^! retire P-tests-first@2\?/ }))?.props.color).toBe('warning')
    expect((await ui.find({ type: 'Button', key: 'rules:confirm-retire:P-tests-first' }))?.props.variant).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'rules:cancel:P-tests-first' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rules:retire:P-tests-first' })).toBeUndefined()
    await ui.press({ key: 'rules:confirm-retire:P-tests-first' })
    expect(storeCalls(s.logs)).toEqual(['retireRule P-tests-first@2'])
  })

  test('under -p nothing is accepted: [Accept] says so and calls nothing', async ($, on) => {
    const s = await start($, on, { interactive: false, view: proposedOn('repo:3') })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:accept:repo:3' })
    expect(storeCalls(s.logs)).toEqual([])
    expect(s.written.at(-1)?.body?.notice?.text).toContain("isn't interactive")
  })

  test('a press on a row the pane no longer shows is ignored, with a toast', async ($, on) => {
    const view = proposedOn('repo:99', { rows: [...PROPOSED.body!.rows, proposalRow('repo:99', { scope: 'user' })] })
    const s = await start($, on, { view })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:accept:repo:99' })
    expect(storeCalls(s.logs)).toEqual([])
    expect(s.toasts.some(t => t.includes("isn't shown any more"))).toBe(true)
  })

  test("a key that isn't Rules' passes on", async ($, on) => {
    const s = await start($, on)
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'litter:section:home' })
    expect(storeCalls(s.logs)).toEqual([])
    // The hub took it, and showed Home.
    expect(s.hubs.at(-1)?.section).toBe('home')
  })
})

// ---------------------------------------------------------------------------
// Where no Client is drawn

describe('the static fallbacks', () => {
  test('VS Code: each row a plain Button with its cells in their colors, the actions Buttons under the list, the footer Buttons', async ($, on) => {
    await start($, on)
    const ui = await mountRules($, 'vscode', { bodyColumns: 60, bodyRows: 20 })
    expect(await ui.find({ type: 'Client' })).toBeUndefined()
    const row = await ui.find({ type: 'Button', key: 'rules:row:repo:5' })
    expect(row?.props.plain).toBe(true)
    expect(row?.text).toContain('Retry a flaky network')
    expect((await ui.find({ type: 'Text', text: /⚑ proposed/ }))?.props.color).toBe('permission')
    expect((await ui.find({ type: 'Text', text: /no scope yet/ }))?.props.color).toBe('warning')
    for (const key of ['rules:accept:repo:5', 'rules:edit:repo:5', 'rules:dismiss:repo:5']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
    // The rows' own Buttons carry no actions: the picked row's are the detail's, once.
    expect((await ui.findAll({ type: 'Button', key: 'rules:accept:repo:5' })).length).toBe(1)
    // A short pane windows the list; its footer moves it.
    const down = await ui.find({ type: 'Button', key: 'rules:list:main:down' })
    expect(down?.text).toMatch(/^↓ \d+ more$/)
    const before = (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('rules:row:')).map(b => b.key)
    await ui.press({ key: 'rules:list:main:down' })
    const after = (await ui.findAll({ type: 'Button' })).filter(b => String(b.key).startsWith('rules:row:')).map(b => b.key)
    expect(after).not.toEqual(before)
    expect(await ui.find({ type: 'Button', key: 'rules:list:main:up' })).toBeDefined()
  })

  test('mobile: no Input or Select, so the field shows its value, and the type and the scope are Buttons', async ($, on) => {
    await start($, on, { view: EDITING })
    const ui = await mountRules($, 'mobile', { bodyColumns: 60 })
    expect(await ui.find({ type: 'Input' })).toBeUndefined()
    expect(await ui.find({ type: 'Select' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Paths: src/parser/**' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'globs, comma-separated; empty: every gate' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '› rule' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rules:type-ban:repo:3' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rules:scope-project:repo:3' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rules:row:repo:3' })).toBeDefined()
  })

  for (const surface of SURFACES) {
    test(`the ${surface} draws the list as a Client with its menu`, async ($, on) => {
      await start($, on)
      const ui = await mountRules($, surface)
      const client = await ui.find({ type: 'Client', key: 'rules:list:main' })
      expect(String(client?.props.module)).toMatch(/(^|\/)listmenu\.tsx$/)
      expect(await ui.find({ type: 'Button', key: 'rules:row:repo:5' })).toBeUndefined()
    })
  }
})

// ---------------------------------------------------------------------------
// Live: the plugin's own store, so each press redraws from it

let n = 0
const record = async ($: Engine, fields: Record<string, unknown>) =>
  JSON.parse(String((await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: `t${++n}`, ...fields })).result)) as Record<string, unknown>

/** A rules ledger's records in order: the repository's, or with `user` your config dir's. */
const ruleLedger = (files: Map<string, string>, dir = RULES_LEDGER) =>
  [...files.keys()]
    .filter(k => k.startsWith(`${dir}/`))
    .sort()
    .map(k => JSON.parse(files.get(k)!) as { seq: number; kind: string; body: Record<string, unknown> })
const USER_LEDGER = '/cfg/litter/rules-ledger/ledger'

/** A session with three proposals of yours, Rules open on them: a user rule, a project one, a ban with no scope. */
async function live($: Engine, on: On) {
  mock.store(on)
  mock.clock(on, { now: NOW })
  const w = world(on)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
  for (const fields of [
    { rule: 'Keep fixtures small.', scope: 'user', when: 'writing a test' },
    { rule: 'Name each test after what it checks.', scope: 'project', when: 'writing a test', paths: ['tests/**'] },
    { rule: 'Never commit secrets.', type: 'ban', when: 'any change' },
  ]) expect((await record($, { kind: 'rule.propose', ...fields })).ok).toBe(true)
  const r = await $.command.run({ command: 'litter', args: 'rules', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(r.text).toBe('Rules shows 3 proposed or unverified, 0 in force')
  return w
}

describe('live: the flows still write what they wrote', () => {
  test('a click, [next] and [previous] pick a row; its description and actions follow', { timeoutMs: 20000 }, async ($, on) => {
    const w = await live($, on)
    const ui = await mountRules($, 'terminal', { bodyColumns: 100, isFocused: true })
    await shows(ui, '1 of 3')
    expect(await ui.find({ type: 'Button', key: 'rules:accept:repo:1' })).toBeDefined()
    expect((await posted(w, () => ui.pointer({ type: 'down', x: 4, y: 1, button: 'left', in: 'rules:list:main' }))).body?.focus).toBe('repo:2')
    await shows(ui, '2 of 3')
    await shows(ui, 'Name each test after what it checks.')
    expect(await ui.find({ type: 'Button', key: 'rules:accept:repo:2' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rules:accept:repo:1' })).toBeUndefined()
    expect(drawText(await ui.drawn({ in: 'rules:list:main' }), 53).filter(r => r.startsWith('›'))).toHaveLength(1)
    await ui.press({ key: 'rules:next' })
    await shows(ui, '3 of 3')
    // A ban with no scope yet: the pick, and what [Accept] can't write yet.
    await shows(ui, 'pick a scope')
    await shows(ui, ' writes nothing until you pick a scope')
    await ui.press({ key: 'rules:next' })
    await shows(ui, '3 of 3')
    await ui.press({ key: 'rules:prev' })
    await shows(ui, '2 of 3')
    // What [Accept] writes for the project one: its folder, for you to commit.
    expect((await shows(ui, '.litter/rules/P-….md')).props.color).toBe('suggestion')
    expect(await detailWords(ui, 100)).toContain('Accept writes .litter/rules/P-….md, for you to commit; every later run in project scope gets it [ Accept ]')
  })

  test("[Edit…] on a proposal: its paths through the field, its type through the Select, kept for the accept", { timeoutMs: 20000 }, async ($, on) => {
    const w = await live($, on)
    const ui = await mountRules($, 'terminal', { bodyColumns: 100 })
    // The ban, the third row, clicked: its actions are drawn.
    expect((await posted(w, () => ui.pointer({ type: 'down', x: 4, y: 2, button: 'left', in: 'rules:list:main' }))).body?.focus).toBe('repo:3')
    await ui.press({ key: 'rules:edit:repo:3' })
    expect(await ui.find({ type: 'Input', key: 'rules:paths:repo:3' })).toBeDefined()
    await shows(ui, 'globs it protects; a ban reaches every gate')
    await ui.input({ key: 'rules:paths:repo:3', text: 'secrets/**' })
    expect((await ui.find({ type: 'Input', key: 'rules:paths:repo:3' }))?.props.value).toBe('secrets/**')
    await ui.press({ key: 'rules:edit-done:repo:3' })
    expect(await ui.find({ type: 'Input', key: 'rules:paths:repo:3' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'secrets/**' })).toBeDefined()
    // A scope picked, then [Accept]: the user rule file, with the paths held.
    await ui.press({ key: 'rules:scope-user:repo:3' })
    expect(await ui.find({ type: 'Text', text: '› user' })).toBeDefined()
  })

  test('[Accept], [Dismiss] (from the menu), the preview and [Confirm accept], then [Retire] and its confirm: each writes what it wrote', { timeoutMs: 30000 }, async ($, on) => {
    const w = await live($, on)
    const { files, filled } = w
    const ui = await mountRules($, 'terminal', { bodyColumns: 100 })
    // A user rule: written to your config dir's rules, its accept in the ledger.
    await ui.press({ key: 'rules:accept:repo:1' })
    expect(files.has('/cfg/litter/rules/U-keep-fixtures-small.md')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /^✓ accepted into user scope/ })).toBeDefined()
    expect(ruleLedger(files, USER_LEDGER).map(r => [r.kind, r.body.id, r.body.via])).toEqual([['rule.accept', 'U-keep-fixtures-small', 'ui']])
    // The ban, dismissed from its menu: the record lands before the view the press ends with.
    expect((await menuPick(w, ui, 'rules:list:main', 'rules:dismiss:repo:3')).body?.notice?.text).toMatch(/^dismissed/)
    expect(ruleLedger(files).map(r => r.kind).slice(3)).toEqual(['rule.dismiss'])
    // The project rule: the preview first, nothing written; then [Confirm accept] writes it.
    await ui.press({ key: 'rules:accept:repo:2' })
    expect(await ui.find({ type: 'Text', text: 'The file [Confirm accept] writes' })).toBeDefined()
    expect(String((await ui.find({ type: 'Code' }))?.props.source)).toContain('Name each test after what it checks.')
    expect([...files.keys()].filter(k => k.startsWith('/repo/.litter/rules/'))).toEqual([])
    await ui.press({ key: 'rules:confirm:repo:2' })
    const written = [...files.keys()].filter(k => k.startsWith('/repo/.litter/rules/P-'))
    expect(written).toEqual(['/repo/.litter/rules/P-name-each-test-after-what-it-checks.md'])
    expect(await ui.find({ type: 'Text', text: 'nothing proposed: ' })).toBeDefined()
    // In force: both, each with the done mark; [Retire] asks first, then moves the file to .history.
    await ui.press({ key: 'rules:tab:in-force' })
    expect(await ui.find({ type: 'Text', text: '› ✓ In force 2' })).toBeDefined()
    const rows = drawText(await ui.drawn({ in: 'rules:list:main' }), 53).filter(r => /✓ in force/.test(r))
    expect(rows).toHaveLength(2)
    const id = 'P-name-each-test-after-what-it-checks'
    expect((await menuPick(w, ui, 'rules:list:main', `rules:retire:${id}`)).body?.pending).toEqual(expect.objectContaining({ kind: 'retire', key: id }))
    expect(await ui.find({ type: 'Button', key: `rules:confirm-retire:${id}` })).toBeDefined()
    expect(files.has(`/repo/.litter/rules/${id}.md`)).toBe(true)
    await ui.press({ key: `rules:confirm-retire:${id}` })
    await shows(ui, `retired ${id}@1; commit the removal yourself`)
    expect(files.has(`/repo/.litter/rules/${id}.md`)).toBe(false)
    expect(files.has(`/repo/.litter/rules/.history/${id}@1.md`)).toBe(true)
    expect(ruleLedger(files).map(r => r.kind).slice(3)).toEqual(['rule.dismiss', 'rule.accept', 'rule.retire'])
    // [Edit…] on the one left fills the prompt.
    await ui.press({ key: 'rules:edit:U-keep-fixtures-small' })
    expect(filled).toEqual(['/litter:rules show U-keep-fixtures-small'])
  })

  test('the empty states name the next step', { timeoutMs: 20000 }, async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: NOW })
    world(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
    await $.command.run({ command: 'litter', args: 'rules', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    const ui = await mountRules($, 'terminal')
    expect((await ui.find({ type: 'Text', text: 'nothing proposed: ' }))?.props.color).toBe('inactive')
    expect((await ui.find({ type: 'Text', text: '/litter:rules add' }))?.props.color).toBe('suggestion')
    expect(await ui.find({ type: 'Text', text: ' drafts a rule' })).toBeDefined()
    await ui.press({ key: 'rules:tab:in-force' })
    expect(await ui.find({ type: 'Text', text: 'a rule is in force once you accept its proposal under Proposed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'nothing in force yet: ' })).toBeDefined()
  })
})

describe('no other hook reaches acceptRule, dismissRule or retireRule (12:1566)', () => {
  test('the record tool, the spool and the timers leave them uncalled, with a confirm waiting', async ($, on) => {
    // A confirm is waiting on each kind, so any path that pressed it would act.
    const pending = { kind: 'preview', key: 'repo:4', path: '/repo/.litter/rules/P-parser.md', text: 'x' }
    const spool = [
      JSON.stringify({ v: 1, event: 'SubagentStop', agent_id: 'a1', kind: 'rule.accept', key: 'rules:confirm:repo:4' }),
      JSON.stringify({ v: 1, event: 'PostToolUse', tool_name: 'mcp__litter__record', tool_input: { kind: 'rule.accept', id: 'P-parser' } }),
      'rules:confirm:repo:4',
    ].join('\n')
    const s = await start($, on, { view: BATCH, nav: { pending }, files: { [`${LITTER}/hooks/spool/${SESSION}.jsonl`]: `${spool}\n` } })
    // The record tool: each step that's yours, and the open and propose a model may make.
    for (const input of [
      { kind: 'rule.accept', id: 'P-parser', proposal: { store: 'repo', seq: 4 } },
      { kind: 'rule.dismiss', proposal: { store: 'repo', seq: 3 } },
      { kind: 'rule.retire', id: 'P-tests-first', version: 2 },
      { kind: 'rule.open', proposal: { store: 'repo', seq: 4 } },
      { kind: 'rule.propose', rule: 'Always accept rules', run: '20261003-api' },
    ]) {
      await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: `t-${input.kind}`, ...input })
      await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: `t-${input.kind}-agent`, agentId: 'a1', ...input })
    }
    // The timers: the drain, the swarm ticks and the ui tick, whose `litter` step redraws Rules, the section shown.
    // The advance can return mid-drain (the settle stops while records are hashed), so the drain is waited for:
    // the spool renamed aside, its lines delivered, and the aside file removed.
    const spoolFile = `${LITTER}/hooks/spool/${SESSION}.jsonl`
    await s.clock.advance(10_000)
    await s.until(() => ![...s.files.keys()].some(k => k.startsWith(spoolFile)))
    // A scope pick and a wheel of the pane's own keys, and a post that isn't a list's.
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:scope-user:repo:10' })
    // The wheel's post moves the list once the hub has handled it, after the act.
    const moved = s.nextHub(h => h.lists?.['rules:list:i0'] === 1)
    await ui.post({ list: 'rules:list:i0', offset: 1, max: 1 }, { in: 'rules:list:i0' })
    await moved
    await ui.post({ list: 'rules:list:i0', press: 'litter:section:home' }, { in: 'rules:list:i0' })
    // The spool was drained (its lines read), and nothing acted.
    expect(s.files.has(spoolFile)).toBe(false)
    expect(acting(s.logs)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The drawings in WP-DE's report

/**
 * The main views drawn at 100 and 60 columns in a 40-row dock, each row's
 * colors named beside it (tests/drawing.ts; a list's Client drawn in its
 * place, a Code as its lines). Held whole, so a change to what Rules draws
 * shows here first.
 */
describe('the drawings', () => {
  const views = [
    ['Proposed, a proposal with no scope', PROPOSED, {}],
    ['an import batch', BATCH, {}],
    ['an edit with its diff', proposedOn('repo:6'), {}],
    ['the editor open', EDITING, {}],
    ['the accept preview', PREVIEW, {}],
    ['In force', IN_FORCE, { tab: 'in-force' }],
  ] as const
  for (const [name, view, nav] of views) {
    for (const columns of [100, 60]) {
      test(`${name} at ${columns} columns`, async ($, on) => {
        await start($, on, { view, nav })
        const ui = await mountRules($, 'terminal', { bodyColumns: columns, bodyRows: 40 })
        const rows = bodyRows(await drawing(ui, columns, true))
        expect(rows.length).toBeGreaterThan(3)
        expect(rows.length).toBeLessThanOrEqual(bodyBudget(40))
        // Printed for the report; the test holds their bounds, not their every cell.
        ;(globalThis as { console?: { log: (s: string) => void } }).console?.log(`--- ${name}, ${columns} columns\n${rows.join('\n').replace(/\s+$/, '')}`)
      })
    }
  }
})
