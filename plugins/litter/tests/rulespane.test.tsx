// Tier 1: the rules pane as the engine draws it and dispatches its presses
// (WP-AF; plan 16.3, 16.8, 12:1566), as the Rules section of the one
// `litter` pane (phase 5b, WP-DA). The views (the hub's, on Rules, and the
// rules') are fed to register.tsx's render through a state.get hook beneath,
// and the pane's navigation (what each row showed, what a press waits on) and
// the section shown are seeded in $.store as a reload finds them. The plugin's module state isn't the test's, so AD's store can't
// be swapped here: the pane logs each store call before making it, and the
// tests count those lines (rulespaneview.spec.ts fakes the store through
// `deps` and runs the same flows end to end). Each press is one step, since
// the redraw after it reads AD's store again.

import type { On } from 'claude-code'
import { describe, expect, mock, test, type Engine } from 'claude-code/testing'
import type { HubView, RulesPaneView, RulesRow } from '../types/index'

const SESSION = 'tier1-session'
const LITTER = '/repo/.claude/litter'
const NOW = 1_800_000_000_000
const SURFACES = ['terminal', 'desktop'] as const

const pane = (title: string) =>
  ({ title, isFocused: false, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} }) as const

const PROPOSED = { text: 'proposed', color: 'permission', glyph: '⚑' }
const ACCEPTED = { text: 'accepted', color: 'success', glyph: '✓' }

const proposalRow = (key: string, over: Partial<RulesRow> = {}): RulesRow => ({
  key,
  kind: 'proposal',
  id: null,
  version: null,
  scope: null,
  type: 'rule',
  status: PROPOSED,
  when: 'touching the parser',
  rule: `rule ${key}`,
  paths: [],
  notes: ['drafted from your words (/litter:rules add)', 'its id is assigned when you accept it'],
  diff: null,
  source: 'user',
  actions: ['accept', 'edit', 'dismiss'],
  ...over,
})

/** What the pane showed for each row (paneview.ts's ShownRow), as the navigation keeps it. */
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
}

/** The navigation as a reload finds it in $.store, written by this session, with the hub's section shown: Rules. */
const navStore = (over: Record<string, unknown> = {}) => ({
  'litter.rules.pane': { v: 1, session: SESSION, nav: { ...NAV, ...over } },
  'litter.hub': { v: 1, session: SESSION, section: 'rules' },
})

/** The hub's view on Rules (no tabs yet: the render draws every section, uncounted). */
const HUB: HubView = { view: 'hub', v: 1, section: 'rules', live: [], tabs: [] }

const importRow = (key: string, instance: string, checked: boolean): RulesRow =>
  proposalRow(key, {
    scope: 'project',
    type: 'ban',
    source: 'import',
    notes: [`from deepwork instance ${instance}`, 'its id is assigned when you accept it'],
    checked,
  })

const VIEW: RulesPaneView = {
  view: 'rules',
  v: 3,
  tab: 'proposed',
  body: {
    title: [
      { text: 'litter · rules', bold: true },
      { text: ' · Proposed' },
    ],
    notice: null,
    counts: { proposed: 6, inForce: 1 },
    rows: [
      importRow('repo:10', 'auth-fix', true),
      { ...importRow('repo:11', 'auth-fix', false), paths: ['.github/**'] },
      importRow('repo:12', 'old-plan', true),
      proposalRow('repo:3', { scope: 'user' }),
      proposalRow('repo:4', { scope: 'project', paths: ['src/parser/**'] }),
      proposalRow('repo:5', {
        notes: ['proposed by a gate critic in run 20261003-api at G2', 'an edit of P-tests-first@2', 'its id is assigned when you accept it'],
        source: 'critic',
        diff: [
          { text: '  type: rule', dim: true },
          { text: '− Write the test first.', color: 'diffRemovedWord' },
          { text: '+ Write the failing test first.', color: 'diffAddedWord' },
        ],
      }),
    ],
    batch: {
      seq: 9,
      instances: [
        { id: 'auth-fix', goal: 'fix the auth refresh', date: '2026-09-30', archived: false },
        { id: 'old-plan', goal: 'an old plan', date: '2026-08-01', archived: true },
      ],
      preselected: ['repo:10'],
    },
    focus: 'repo:10',
    problems: [],
    pending: null,
    editing: null,
  },
}

const IN_FORCE: RulesPaneView = {
  view: 'rules',
  v: 4,
  tab: 'in-force',
  body: {
    title: [
      { text: 'litter · rules', bold: true },
      { text: ' · In force' },
    ],
    notice: null,
    counts: { proposed: 0, inForce: 1 },
    rows: [
      {
        key: 'P-tests-first',
        kind: 'accepted',
        id: 'P-tests-first',
        version: 2,
        scope: 'project',
        type: 'rule',
        status: ACCEPTED,
        when: 'changing behavior',
        rule: 'Write the failing test first.',
        paths: ['src/**'],
        notes: ['matches no file', 'local L-mine overrides U-theirs'],
        diff: null,
        source: null,
        actions: ['edit', 'retire'],
      },
    ],
    batch: null,
    focus: null,
    problems: ['P-dup is in two scopes: project and local'],
    pending: null,
    editing: null,
  },
}

/** The views the pane's atoms hold (the rules' and the hub's), answered beneath register.tsx's read; what the pane writes still lands beneath. */
function views(on: On, view: RulesPaneView): { written: RulesPaneView[] } {
  const seen = { written: [] as RulesPaneView[] }
  on('state.get', async (_$, e, next) =>
    e.key === 'rulesPane' ? { value: { value: view, version: 0 } } : e.key === 'hub' ? { value: { value: HUB, version: 0 } } : next(e),
  )
  on('state.set', async (_$, e, next) => {
    if (e.key === 'rulesPane') seen.written.push(e.value as RulesPaneView)
    return next(e)
  })
  return seen
}

/** $.fs from a map and git as a plain checkout at /repo answers it, so session.start resolves the litter directory. */
function world(on: On): { files: Map<string, string>; logs: string[]; toasts: string[]; filled: string[]; opened: { id: string; focus: boolean }[] } {
  const files = new Map<string, string>()
  const logs: string[] = []
  const toasts: string[] = []
  const filled: string[] = []
  const opened: { id: string; focus: boolean }[] = []
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
    if (a[0] === 'git' && a.includes('rev-parse')) {
      if (a.includes('--show-toplevel') && !a.includes('--git-dir')) return ran(0, '/repo\n')
      if (a.includes('--git-dir') && a.includes('--git-common-dir')) return ran(0, '/repo/.git\n/repo/.git\n')
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
  on('prompt.fill', async (_$, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.cwd', async () => ({ value: '/repo' }))
  mock.env(on, { HOME: '/home/tier1' })
  return { files, logs, toasts, filled, opened }
}

/** A session started in /repo, interactive unless said, with the navigation seeded and the view fed. */
async function start($: Engine, on: On, opts: { nav?: Record<string, unknown>; view?: RulesPaneView; interactive?: boolean; files?: Record<string, string> } = {}) {
  mock.store(on, navStore(opts.nav))
  const clock = mock.clock(on, { now: NOW })
  const w = world(on)
  for (const [k, v] of Object.entries(opts.files ?? {})) w.files.set(k, v)
  const seen = views(on, opts.view ?? VIEW)
  await $.session.start({ cwd: '/repo', surface: null, isInteractive: opts.interactive ?? true })
  return { ...w, ...seen, clock }
}

const mountRules = <S extends 'terminal' | 'desktop' | 'vscode' | 'mobile'>($: Engine, surface: S) =>
  $.ui.mount({ plugin: 'litter', surface, component: 'Pane', requestId: 'litter', props: pane('litter') })

/** The store calls the pane logged, in order (`rules pane: <fn> …`). */
const storeCalls = (logs: readonly string[]) =>
  logs.filter(l => /^rules pane: (acceptRule|dismissRule|retireRule|previewAccept) /.test(l)).map(l => l.slice('rules pane: '.length))
const acting = (logs: readonly string[]) => storeCalls(logs).filter(l => /^(acceptRule|dismissRule|retireRule) /.test(l))

describe('the rules pane draws both tabs', () => {
  for (const surface of SURFACES) {
    test(`the Proposed tab, an import batch grouped by instance, on the ${surface}`, async ($, on) => {
      await start($, on)
      const ui = await mountRules($, surface)
      // The hub's chrome: `litter · Rules`, and the strip with Rules shown (the other sections are Buttons).
      expect(await ui.find({ type: 'Text', text: ' · Rules' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'litter:section:home' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'litter:section:rules' })).toBeUndefined()
      expect(await ui.find({ type: 'Button', key: 'rules:tab:proposed' })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'rules:tab:in-force' }))?.text).toBe('In force (1)')
      expect(await ui.find({ type: 'Text', text: 'Import from deepwork' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '✓ live' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '− archived' })).toBeDefined()
      expect((await ui.find({ type: 'Button', key: 'rules:check:repo:10' }))?.text).toBe('[x]')
      expect((await ui.find({ type: 'Button', key: 'rules:check:repo:11' }))?.text).toBe('[ ]')
      expect(await ui.find({ type: 'Button', key: 'rules:accept-selected:9' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'no paths: applies to every gate' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'paths: src/parser/**' })).toBeDefined()
      // A ban's paths are what it protects.
      expect(await ui.find({ type: 'Text', text: 'protects: .github/**' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'paths: .github/**' })).toBeUndefined()
      // An import's scope is project, and can be changed before [Accept].
      expect(await ui.find({ type: 'Select', key: 'rules:scope:repo:10' })).toBeDefined()
      // An edit proposal shows as a diff against the version in force.
      expect(await ui.find({ type: 'Text', text: '+ Write the failing test first.' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '− Write the test first.' })).toBeDefined()
      for (const key of ['rules:accept:repo:3', 'rules:edit:repo:3', 'rules:dismiss:repo:3']) expect(await ui.find({ type: 'Button', key })).toBeDefined()
    })

    test(`the In force tab: standing, notes and problems, on the ${surface}`, async ($, on) => {
      await start($, on, { view: IN_FORCE, nav: { tab: 'in-force' } })
      const ui = await mountRules($, surface)
      expect(await ui.find({ type: 'Text', text: '✓ accepted' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'P-tests-first@2' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '! matches no file' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '! local L-mine overrides U-theirs' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '! P-dup is in two scopes' })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'rules:retire:P-tests-first' })).toBeDefined()
      expect(await ui.find({ key: 'rules:accept:P-tests-first' })).toBeUndefined()
    })
  }

  test('a pending scope is a Select where the surface has one, and a button per scope on mobile', async ($, on) => {
    const view: RulesPaneView = { ...VIEW, body: { ...VIEW.body!, pending: { kind: 'scope', key: 'repo:5' } } }
    await start($, on, { view })
    const terminal = await mountRules($, 'terminal')
    expect(await terminal.find({ type: 'Select', key: 'rules:scope:repo:5' })).toBeDefined()
    const mobile = await mountRules($, 'mobile')
    expect(await mobile.find({ type: 'Button', key: 'rules:scope-user:repo:5' })).toBeDefined()
    expect(await mobile.find({ type: 'Button', key: 'rules:scope-local:repo:5' })).toBeDefined()
  })

  test("a project preview shows the file and its path, and [Confirm accept] in place of [Accept]", async ($, on) => {
    const view: RulesPaneView = { ...VIEW, body: { ...VIEW.body!, pending: { kind: 'preview', key: 'repo:4', path: '/repo/.litter/rules/P-parser.md', text: '---\nid: P-parser\n---\n\n## Rule\nParse once.\n' } } }
    await start($, on, { view })
    const ui = await mountRules($, 'terminal')
    expect(await ui.find({ type: 'Text', text: '/repo/.litter/rules/P-parser.md' })).toBeDefined()
    expect(await ui.find({ type: 'Code', text: 'id: P-parser' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'rules:confirm:repo:4' })).toBeDefined()
    expect(await ui.find({ key: 'rules:accept:repo:4' })).toBeUndefined()
  })
})

describe('the buttons reach the store, one press at a time', () => {
  test('[Accept] on a user proposal calls acceptRule once, and nothing else', async ($, on) => {
    const s = await start($, on)
    const ui = await mountRules($, 'terminal')
    expect(await ui.press({ key: 'rules:accept:repo:3' })).toEqual(expect.objectContaining({ element: 'rules:accept:repo:3' }))
    expect(storeCalls(s.logs)).toEqual(['acceptRule repo:3 user'])
  })

  test('a project proposal shows the preview first: [Accept] calls previewAccept, never acceptRule', async ($, on) => {
    const s = await start($, on)
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:accept:repo:4' })
    expect(storeCalls(s.logs)).toEqual(['previewAccept repo:4 project'])
  })

  test('[Confirm accept] on a stale drawing, with no preview waiting, is ignored with a toast', async ($, on) => {
    // The drawing still shows a preview the pane no longer holds.
    const view: RulesPaneView = { ...VIEW, body: { ...VIEW.body!, pending: { kind: 'preview', key: 'repo:4', path: '/p', text: 'x' } } }
    const s = await start($, on, { view })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:confirm:repo:4' })
    expect(storeCalls(s.logs)).toEqual([])
    expect(s.toasts.some(t => t.includes('no file waiting to be confirmed'))).toBe(true)
  })

  test('after the preview, [Confirm accept] calls acceptRule once', async ($, on) => {
    const pending = { kind: 'preview', key: 'repo:4', path: '/repo/.litter/rules/P-parser.md', text: '## Rule\nParse once.\n' }
    const view: RulesPaneView = { ...VIEW, body: { ...VIEW.body!, pending: pending as never } }
    const s = await start($, on, { view, nav: { pending } })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:confirm:repo:4' })
    expect(storeCalls(s.logs)).toEqual(['acceptRule repo:4 project'])
  })

  test('a scope is asked when there is none: [Accept] calls nothing, and a pick never accepts', async ($, on) => {
    const s = await start($, on)
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:accept:repo:5' })
    expect(storeCalls(s.logs)).toEqual([])
    expect(s.logs).toContain('rules pane: asks the scope for repo:5')
    expect(s.written.at(-1)?.body?.notice?.text).toContain('pick the scope to accept it into')
  })

  test('a scope picked, then [Accept]: acceptRule once, into that scope', async ($, on) => {
    const s = await start($, on, { nav: { held: { 'repo:5': { scope: 'local' } } } })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:accept:repo:5' })
    expect(storeCalls(s.logs)).toEqual(['acceptRule repo:5 local'])
  })

  test('[Accept selected] on an import batch of project bans previews exactly the checked ones, and accepts none yet', async ($, on) => {
    // Imports are project bans (16.8), so their files are shown first.
    const s = await start($, on)
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:accept-selected:9' })
    expect(storeCalls(s.logs)).toEqual(['previewAccept repo:10 project', 'previewAccept repo:12 project'])
  })

  test('[Accept selected] accepts exactly the checked ones, one by one, in the scopes picked', async ($, on) => {
    const s = await start($, on, { nav: { held: { 'repo:10': { scope: 'local' }, 'repo:11': { scope: 'local' }, 'repo:12': { scope: 'user' } } } })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:accept-selected:9' })
    expect(storeCalls(s.logs)).toEqual(['acceptRule repo:10 local', 'acceptRule repo:12 user'])
  })

  test('a check toggles a row of the batch, and calls nothing', async ($, on) => {
    const s = await start($, on)
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:check:repo:11' })
    expect(storeCalls(s.logs)).toEqual([])
  })

  test('[Confirm accept] on a batch accepts exactly the checked ones, one by one', async ($, on) => {
    const pending = { kind: 'preview', key: 'batch:9', path: '/repo/.litter/rules/', text: '--- a\n--- b' }
    const view: RulesPaneView = { ...VIEW, body: { ...VIEW.body!, pending: pending as never } }
    const s = await start($, on, { view, nav: { pending } })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:confirm:batch:9' })
    expect(storeCalls(s.logs)).toEqual(['acceptRule repo:10 project', 'acceptRule repo:12 project'])
    // Each failure is reported (AD's stub refuses both until the store is built, or the store has no such proposal).
    expect(s.written.at(-1)?.body?.notice?.text).toMatch(/^accepted 0 of 2; not accepted: repo:10: .*; repo:12: /)
  })

  test('[Dismiss] calls dismissRule', async ($, on) => {
    const s = await start($, on)
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:dismiss:repo:3' })
    expect(storeCalls(s.logs)).toEqual(['dismissRule repo:3'])
  })

  test('[Retire] asks for [Confirm retire] first, which calls retireRule', async ($, on) => {
    const s = await start($, on, { view: IN_FORCE, nav: { tab: 'in-force' } })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:retire:P-tests-first' })
    expect(storeCalls(s.logs)).toEqual([])
    expect(s.written.at(-1)?.body?.notice?.text ?? '').toContain('[Confirm retire]')
  })

  test('[Confirm retire] calls retireRule with the version shown', async ($, on) => {
    const pending = { kind: 'retire', key: 'P-tests-first' }
    const view: RulesPaneView = { ...IN_FORCE, body: { ...IN_FORCE.body!, pending: pending as never } }
    const s = await start($, on, { view, nav: { tab: 'in-force', pending } })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:confirm-retire:P-tests-first' })
    expect(storeCalls(s.logs)).toEqual(['retireRule P-tests-first@2'])
  })

  test("[Edit…] on an accepted rule fills the prompt with /litter:rules show <id>", async ($, on) => {
    const s = await start($, on, { view: IN_FORCE, nav: { tab: 'in-force' } })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:edit:P-tests-first' })
    expect(s.filled).toEqual(['/litter:rules show P-tests-first'])
    expect(acting(s.logs)).toEqual([])
  })

  test('under -p nothing is accepted: [Accept] says so and calls nothing', async ($, on) => {
    const s = await start($, on, { interactive: false })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:accept:repo:3' })
    expect(storeCalls(s.logs)).toEqual([])
    expect(s.written.at(-1)?.body?.notice?.text).toContain("isn't interactive")
  })

  test('a press on a row the pane no longer shows is ignored, with a toast', async ($, on) => {
    // The drawing has a row the last build didn't show.
    const view: RulesPaneView = { ...VIEW, body: { ...VIEW.body!, rows: [...VIEW.body!.rows, proposalRow('repo:99', { scope: 'user' })] } }
    const s = await start($, on, { view })
    const ui = await mountRules($, 'terminal')
    await ui.press({ key: 'rules:accept:repo:99' })
    expect(storeCalls(s.logs)).toEqual([])
    expect(s.toasts.some(t => t.includes("isn't shown any more"))).toBe(true)
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
    const s = await start($, on, { nav: { pending }, files: { [`${LITTER}/hooks/spool/${SESSION}.jsonl`]: `${spool}\n` } })
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
    await s.clock.advance(10_000)
    // A field and a pick on the pane's keys.
    const ui = await mountRules($, 'terminal')
    await ui.select({ key: 'rules:scope:repo:10', value: 'user' })
    expect(acting(s.logs)).toEqual([])
    // The spool was drained (its lines read), and still nothing acted.
    expect(s.files.has(`${LITTER}/hooks/spool/${SESSION}.jsonl`)).toBe(false)
  })
})

describe('/litter rules', () => {
  test('opens `litter` on Rules, on the Proposed tab, with the keyboard, and answers a line', async ($, on) => {
    mock.store(on)
    const w = world(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: true })
    const r = await $.command.run({ command: 'litter', args: 'rules', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
    expect(r.text).toBe('Rules shows 0 proposed or unverified, 0 in force')
    expect(w.opened).toEqual([{ id: 'litter', focus: true }])
    const ui = await mountRules($, 'desktop')
    expect(await ui.find({ type: 'Text', text: ' · Rules' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'nothing proposed' })).toBeDefined()
  })
})
