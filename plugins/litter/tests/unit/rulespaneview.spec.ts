// Tier 2: the rules pane (WP-AF; plan 16.3, 16.6, 16.8, 12:1566). Its view
// (hooks/rules/paneview.ts) on both tabs: proposals with where they came
// from, an edit's diff, an import batch grouped by instance with its
// preselection, unverified files, overrides, a rule that matches no file and
// a ban's own note for it (WP-AH). And its handlers (hooks/rules/pane.tsx)
// end to end, with AD's store and AE's
// matcher stood in for through `deps` (each a stub before the merge): each
// acting call is made once, by a press, with what the pane showed; a field,
// a pick, a message, a tick and an open never make one. Last, a scan of the
// source: no module but the pane imports AD's acting functions.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { LedgerRead } from '../../hooks/ledgercore'
import { headKey } from '../../hooks/ledgercore'
import { repoRulesLedgerDir } from '../../hooks/layout'
import type { StoredRecord } from '../../hooks/records/core'
import type { LoadedRule, ProposalRef, RuleDoc, RuleExportView, RuleImportBody, RuleProposeBody, RuleStatus } from '../../hooks/records/rules'
import type { RulesPaneView, RulesRow } from '../../types/index'
import { updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import { MOD } from '../../hooks/verify'
import {
  BAN_MATCHES_NO_FILE,
  BAN_NO_PATHS,
  EXPORT_DELETED,
  EXPORT_DIFF,
  EXPORT_EDITED,
  MATCHES_NO_FILE,
  NO_PATHS,
  NO_PATHS_IN_FORCE,
  STATUS,
  batchConsequence,
  blankRulesNav,
  consequenceOf,
  describeRow,
  flagged,
  deps as viewDeps,
  resetRulesViewForTests,
  rulesNavOf,
  rulesView,
} from '../../hooks/rules/paneview'
import { deps as paneDeps, onRulesUi, pressRules, refreshRulesPane, resetRulesPaneForTests, rulesCommand, rulesTick } from '../../hooks/rules/pane'
import { boardTick, resetBoardPaneForTests } from '../../hooks/board/pane'
import { resetBoardForTests } from '../../hooks/board/view'
import { openSection, resetHubForTests, type SectionArg } from '../../hooks/ui/hub'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

/** The rules records' open (rule.open, rule.import): Rules on its focus, through the hub's opener. */
const openRulesPane = async (p: TestPorts, focus: SectionArg): Promise<boolean> => (await openSection(p, 'rules', focus)).placed

setDefaultTimeout(120_000)

const NOW = 1_800_000_000_000

let p: TestPorts
let dir: string
let litterDir: string
let cleanup: () => void
let loaded: LoadedRule[]
let problems: string[]
let proposals: { ref: ProposalRef; body: RuleProposeBody; status: RuleStatus }[]
let ruleRecords: StoredRecord[]
let tracked: string[] | null
/** Every call the stand-ins for AD's store got, without the ports and the litter directory. */
let calls: { fn: string; args: unknown[] }[]
/** What acceptRule answers, by proposal key; unset, it's written. */
let refuse: Record<string, string>
/** What export.ts's stand-ins answer: the rules' exports and their problems, and the files a sync wrote. */
let exportViews: RuleExportView[]
let exportProblems: string[]
let synced: string[]
const savedView = { ...viewDeps }
const savedPane = { ...paneDeps }

const ACTING = ['acceptRule', 'dismissRule', 'retireRule']
const acting = () => calls.filter(c => ACTING.includes(c.fn))
const called = (fn: string) => calls.filter(c => c.fn === fn).map(c => c.args)
const next = (async () => 'beneath') as never

const rulesPath = (id: string) => join(dir, '.litter', 'rules', `${id}.md`)
const keyOf = (what: unknown): string => {
  const w = what as { proposal?: ProposalRef; file?: string }
  return w.proposal ? `${w.proposal.store}:${w.proposal.seq}` : String(w.file)
}

beforeEach(() => {
  state.resetForTests()
  resetRulesViewForTests()
  resetRulesPaneForTests()
  resetBoardForTests()
  resetBoardPaneForTests()
  resetHubForTests()
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ sessionId: 's1', cwd: dir })
  p.clock.now = NOW
  litterDir = join(dir, '.claude', 'litter')
  updateSession({ litterDir })
  loaded = LOADED()
  problems = ['P-dup is in two scopes: project and local']
  proposals = PROPOSALS()
  ruleRecords = [importRecord()]
  tracked = ['src/a.ts', 'README.md']
  calls = []
  refuse = {}

  viewDeps.loadRules = async () => ({ rules: loaded, problems })
  viewDeps.proposalsOf = async (_p, _dir, filter) => {
    calls.push({ fn: 'proposalsOf', args: [filter] })
    return proposals
  }
  viewDeps.readRuleLedger = async (_p, _dir, store): Promise<LedgerRead> => ({
    records: store === 'repo' ? ruleRecords : [],
    head: null,
    tampered: null,
    brokenTail: null,
    anchor: 'none',
  })
  viewDeps.lsFiles = async () => tracked
  viewDeps.matches = (pattern, path) => (pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : pattern === path)
  exportViews = []
  exportProblems = []
  viewDeps.exportsOf = async (_p, _dir, opts) => {
    calls.push({ fn: 'exportsOf', args: [{ worktrees: opts?.worktrees, settings: opts?.settings, loaded: opts?.loaded?.rules.length }] })
    return { views: exportViews, problems: exportProblems }
  }
  paneDeps.syncExports = async () => {
    calls.push({ fn: 'syncExports', args: [] })
    return { written: synced, removed: [], recorded: 0, problems: [] }
  }
  synced = []
  paneDeps.adoptExport = async (_p, _dir, ref) => {
    calls.push({ fn: 'adoptExport', args: [ref] })
    return { ok: true, proposal: { store: 'repo', seq: 40 } }
  }
  paneDeps.restoreExport = async (_p, _dir, ref) => {
    calls.push({ fn: 'restoreExport', args: [ref] })
    return { ok: true, path: join(dir, '.claude', 'rules', 'litter', `${ref.id}.md`), kept: ref.id === 'P-hand' ? join(litterDir, 'rules-ledger', 'export-edits', 'P-hand@1-x.md') : null }
  }

  paneDeps.acceptRule = async (_p, _dir, what, opts) => {
    calls.push({ fn: 'acceptRule', args: [what, opts] })
    const why = refuse[keyOf(what)]
    if (why) return { ok: false, reason: why }
    return { ok: true, path: opts?.scope === 'project' ? rulesPath('P-parse-once') : `/home/you/.claude/litter/rules/${opts?.scope}-rule.md` }
  }
  paneDeps.dismissRule = async (_p, _dir, ref) => {
    calls.push({ fn: 'dismissRule', args: [ref] })
    return { ok: true }
  }
  paneDeps.retireRule = async (_p, _dir, ref) => {
    calls.push({ fn: 'retireRule', args: [ref] })
    return { ok: true }
  }
  paneDeps.previewAccept = async (_p, _dir, what, opts) => {
    calls.push({ fn: 'previewAccept', args: [what, opts] })
    return { ok: true, path: rulesPath(`P-${keyOf(what).replace(':', '-')}`), text: `---\nid: P-${keyOf(what).replace(':', '-')}\n---\n\n## Rule\nParse once.\n` }
  }
  paneDeps.narrowPaths = paths => {
    calls.push({ fn: 'narrowPaths', args: [paths] })
    return paths.some(x => x.startsWith('/')) ? { ok: false, reason: `${paths.find(x => x.startsWith('/'))} isn't relative to the repository` } : { ok: true, paths: [...new Set(paths)].sort() }
  }
})

afterEach(() => {
  Object.assign(viewDeps, savedView)
  Object.assign(paneDeps, savedPane)
  updateSession({ litterDir: null })
  resetBoardPaneForTests()
  state.resetForTests()
  cleanup()
})

// ---------------------------------------------------------------------------
// Fixtures

function doc(id: string, version: number, over: { rule?: string; paths?: string[]; overrides?: string; type?: 'rule' | 'ban' } = {}): RuleDoc {
  return {
    id,
    version,
    status: 'accepted',
    type: over.type ?? 'rule',
    applies: { paths: over.paths ?? [], when: 'changing behavior' },
    ...(over.overrides ? { overrides: over.overrides } : {}),
    export: true,
    extra: [],
    body: { rule: over.rule ?? `rule ${id}`, why: '', exceptions: [], howToCheck: [] },
  }
}

const rule = (id: string, scope: LoadedRule['scope'], over: Partial<LoadedRule> & { d?: RuleDoc } = {}): LoadedRule => {
  const d = over.d ?? doc(id, 1)
  const { d: _drop, ...rest } = over
  return { doc: d, scope, path: scope === 'user' ? `/home/you/.claude/litter/rules/${id}.md` : rulesPath(id), sha256: 'e'.repeat(64), standing: 'accepted', delivered: d, ...rest }
}

const LOADED = (): LoadedRule[] => [
  rule('P-tests-first', 'project', { d: doc('P-tests-first', 2, { paths: ['src/**'], rule: 'Write the test first.' }) }),
  rule('U-theirs', 'user'),
  rule('L-mine', 'local', { d: doc('L-mine', 1, { overrides: 'U-theirs' }) }),
  // Edited by hand after its acceptance: its HEAD version stays in force.
  rule('P-hand', 'project', { d: doc('P-hand', 1, { rule: 'Changed by hand.' }), standing: 'unverified', why: 'a hand edit', delivered: doc('P-hand', 1) }),
  // A user file the mod never wrote: nothing of it in force.
  rule('U-new', 'user', { standing: 'unverified', why: 'its bytes are none the mod wrote', delivered: null }),
  rule('P-nowhere', 'project', { d: doc('P-nowhere', 1, { paths: ['nowhere/**'] }) }),
]

const origin = (instance: string, archived = false) => ({ instance, source: 'flag', archived })
const PROPOSALS = (): { ref: ProposalRef; body: RuleProposeBody; status: RuleStatus }[] => [
  { ref: { store: 'repo', seq: 3 }, body: { rule: 'Prefer small commits', source: 'user', scope: 'user', when: 'committing' }, status: 'proposed' },
  { ref: { store: 'repo', seq: 4 }, body: { rule: 'Parse once', source: 'user', scope: 'project', paths: ['src/parser/**'] }, status: 'proposed' },
  {
    ref: { store: 'repo', seq: 5 },
    body: { rule: 'Write the failing test first.', source: 'critic', run: '20261003-api', gate: 'G2', edits: 'P-tests-first@2', doc: doc('P-tests-first', 3, { paths: ['src/**'], rule: 'Write the failing test first.' }) },
    status: 'proposed',
  },
  { ref: { store: 'repo', seq: 6 }, body: { rule: 'Already dismissed', source: 'user' }, status: 'dismissed' },
  { ref: { store: 'repo', seq: 10 }, body: { rule: 'Never log tokens', source: 'import', scope: 'project', import: origin('auth-fix') }, status: 'proposed' },
  { ref: { store: 'repo', seq: 11 }, body: { rule: 'Never skip the refresh check', source: 'import', import: origin('old-plan', true) }, status: 'proposed' },
  { ref: { store: 'repo', seq: 12 }, body: { rule: 'Never retry a 401', source: 'import', scope: 'project', import: origin('auth-fix') }, status: 'proposed' },
]

function importRecord(): StoredRecord {
  const body: RuleImportBody = {
    from: 'deepwork',
    instances: [
      { id: 'auth-fix', goal: 'fix the auth refresh', date: '2026-09-30', archived: false },
      { id: 'old-plan', goal: 'an old plan', date: '2026-08-01', archived: true },
    ],
    proposals: [10, 11, 12].map(seq => ({ store: 'repo' as const, seq })),
    preselected: [10, 12].map(seq => ({ store: 'repo' as const, seq })),
  }
  return { v: 1, seq: 9, kind: 'rule.import', run: 'rules', at: NOW, by: MOD, prev: null, body: body as unknown as Record<string, unknown> }
}

const view = (): RulesPaneView => p.views.rules as RulesPaneView
const rowsOf = (v: RulesPaneView): RulesRow[] => v.body?.rows ?? []
const row = (v: RulesPaneView, key: string): RulesRow => {
  const r = rowsOf(v).find(x => x.key === key)
  if (!r) throw new Error(`no row ${key}`)
  return r
}
const notice = () => view().body?.notice?.text ?? ''
const command = () => ({ command: 'litter', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as never

// ---------------------------------------------------------------------------

describe('the Proposed tab', () => {
  test('proposals with where they came from, an edit as a diff, then the unverified files', async () => {
    const { view: v, shown } = await rulesView(p, litterDir, blankRulesNav('proposed'))
    expect(v.tab).toBe('proposed')
    // No title of its own (WP-DE): the hub's header names the section, the tab strip the tab.
    expect('title' in v.body!).toBe(false)
    // The dismissed one isn't there; the store is asked for the proposed ones.
    expect(rowsOf(v).map(r => r.key)).toEqual(['repo:3', 'repo:4', 'repo:5', 'repo:10', 'repo:11', 'repo:12', 'P-hand', 'U-new'])
    expect(called('proposalsOf')).toEqual([[{ status: ['proposed'] }]])
    expect(v.body!.counts).toEqual({ proposed: 8, inForce: 5 })
    // loadRules' problems are the In force tab's.
    expect(v.body!.problems).toEqual([])
    // With nothing picked, the first row is the one drawn with its description; nothing is opened under [More].
    expect([v.body!.focus, v.body!.more]).toEqual(['repo:3', null])

    const user = row(v, 'repo:3')
    expect(user).toEqual(expect.objectContaining({ kind: 'proposal', id: null, scope: 'user', type: 'rule', when: 'committing', rule: 'Prefer small commits', paths: [], diff: null }))
    // Whatever waits on you has the needs-you mark; never the in-force one.
    expect(user.status).toEqual({ text: 'proposed', color: 'permission', glyph: '⚑' })
    expect(user.origin).toBe('drafted from your words (/litter:rules add)')
    expect(user.notes).toEqual(['its id is assigned when you accept it'])
    expect(user.actions).toEqual(['accept', 'edit', 'dismiss'])
    expect(row(v, 'repo:4').paths).toEqual(['src/parser/**'])
    // What [Accept] writes, on the line above it: a new rule's folder (its id comes at the accept), and who gets it.
    expect(row(v, 'repo:4').consequence).toEqual([
      { text: 'Accept', bold: true },
      { text: ' writes ' },
      { text: '.litter/rules/P-….md', color: 'suggestion' },
      { text: ', for you to commit; every later run in project scope gets it' },
    ])
    expect(user.consequence?.slice(-1)).toEqual([{ text: '; every later run in user scope gets it' }])

    // An edit: its rule's scope (it can't be accepted into another), its file and next version, its diff.
    const edit = row(v, 'repo:5')
    expect(edit.scope).toBe('project')
    expect(edit.edits).toBe('P-tests-first@2')
    expect(edit.origin).toBe('proposed by a gate critic in run 20261003-api at G2')
    expect(edit.notes).toEqual([])
    expect(edit.consequence).toEqual([
      { text: 'Accept', bold: true },
      { text: ' writes ' },
      { text: '.litter/rules/P-tests-first.md', color: 'suggestion' },
      { text: ' as version 3' },
      { text: ', for you to commit; every later run in project scope gets it' },
    ])
    expect(edit.diff).toEqual(
      expect.arrayContaining([
        { text: '− Write the test first.', color: 'error' },
        { text: '+ Write the failing test first.', color: 'success' },
        { text: '  type: rule', dim: true },
      ]),
    )

    // An import is a ban unless it says otherwise (16.8); with no scope, [Accept] writes nothing until one is picked.
    expect(row(v, 'repo:11')).toEqual(expect.objectContaining({ type: 'ban', scope: null, source: 'import' }))
    expect(row(v, 'repo:11').origin).toBe('from deepwork instance old-plan, a flag guardrail')
    expect(row(v, 'repo:11').notes[0]).toBe('from an archived instance')
    expect(row(v, 'repo:11').consequence).toEqual([{ text: 'Accept', bold: true }, { text: ' writes nothing until you pick a scope' }])
    // Out of a focused batch, an import row has no check.
    expect(row(v, 'repo:10').checked).toBeUndefined()

    const hand = row(v, 'P-hand')
    expect(hand.status).toEqual({ text: 'unverified', color: 'permission', glyph: '⚑' })
    expect(hand.origin).toBe('a hand edit')
    expect(hand.notes).toEqual(['P-hand@1 stays in force until you accept this', `file ${rulesPath('P-hand')}`])
    expect(hand.diff).toEqual(expect.arrayContaining([{ text: '+ Changed by hand.', color: 'success' }]))
    expect(hand.actions).toEqual(['accept'])
    expect(hand.consequence).toEqual([
      { text: 'Accept', bold: true },
      { text: ' marks ' },
      { text: '.litter/rules/P-hand.md', color: 'suggestion' },
      { text: ' accepted, as it stands' },
      { text: ', for you to commit; every later run in project scope gets it' },
    ])
    expect(row(v, 'U-new').notes[0]).toBe('nothing of it is in force')

    // What each row showed, for the presses.
    expect(Object.keys(shown)).toEqual(rowsOf(v).map(r => r.key))
    expect(shown['repo:4']).toEqual({ kind: 'proposal', ref: { store: 'repo', seq: 4 }, file: null, id: null, version: null, scope: 'project', type: 'rule', paths: ['src/parser/**'], source: 'user', batch: null, actions: ['accept', 'edit', 'dismiss'] })
    expect(shown['repo:5']?.scope).toBe('project')
    expect(shown['P-hand']).toEqual(expect.objectContaining({ kind: 'unverified', file: rulesPath('P-hand'), id: 'P-hand', version: 1, scope: 'project' }))
  })

  test("the row picked, and what [More] opened, are the view's while they're shown", async () => {
    const picked = await rulesView(p, litterDir, { ...blankRulesNav('proposed'), selected: 'repo:4', more: 'repo:4' })
    expect([picked.view.body!.focus, picked.view.body!.more]).toEqual(['repo:4', 'repo:4'])
    // A row that's gone falls back to the first; [More] on problems with none is nothing.
    const gone = await rulesView(p, litterDir, { ...blankRulesNav('proposed'), selected: 'repo:99', more: 'problems' })
    expect([gone.view.body!.focus, gone.view.body!.more]).toEqual(['repo:3', null])
    // What a step waits on comes before the row the pane opened on.
    const waiting = await rulesView(p, litterDir, { ...blankRulesNav('proposed', { proposal: { store: 'repo', seq: 3 } }), pending: { kind: 'scope', key: 'repo:11' } })
    expect(waiting.view.body!.focus).toBe('repo:11')
    const opened = await rulesView(p, litterDir, blankRulesNav('proposed', { proposal: { store: 'repo', seq: 4 } }))
    expect(opened.view.body!.focus).toBe('repo:4')
  })

  test('an import batch, focused by its record or one of its proposals: grouped by instance, its preselection checked once', async () => {
    const byRecord = await rulesView(p, litterDir, blankRulesNav('proposed', { proposal: { store: 'repo', seq: 9 } }))
    const v = byRecord.view
    expect(v.body!.batch).toEqual({
      seq: 9,
      instances: [
        { id: 'auth-fix', goal: 'fix the auth refresh', date: '2026-09-30', archived: false },
        { id: 'old-plan', goal: 'an old plan', date: '2026-08-01', archived: true },
      ],
      preselected: ['repo:10', 'repo:12'],
      // What [Accept selected] writes: the checked ones, in project scope (an import's, 16.8).
      consequence: [
        { text: 'Accept selected', bold: true },
        { text: ' writes ' },
        { text: '2 new files in ' },
        { text: '.litter/rules/', color: 'suggestion' },
        { text: ', for you to commit; every later run in project scope gets them' },
      ],
    })
    // The batch first, by its instances' order; the rest after.
    expect(rowsOf(v).map(r => r.key)).toEqual(['repo:10', 'repo:12', 'repo:11', 'repo:3', 'repo:4', 'repo:5', 'P-hand', 'U-new'])
    expect(['repo:10', 'repo:12', 'repo:11'].map(k => row(v, k).checked)).toEqual([true, true, false])
    // Each batch row names its instance, which the pane groups it under; the rest have none.
    expect(['repo:10', 'repo:12', 'repo:11', 'repo:3'].map(k => row(v, k).instance)).toEqual(['auth-fix', 'auth-fix', 'old-plan', undefined])
    expect([byRecord.batch, byRecord.seeded, byRecord.checked]).toEqual([9, 9, ['repo:10', 'repo:12']])
    expect(byRecord.shown['repo:11']?.batch).toBe(9)

    // Once seeded, what you checked stands.
    const kept = await rulesView(p, litterDir, { ...blankRulesNav('proposed'), batch: 9, seeded: 9, checked: ['repo:11'] })
    expect(['repo:10', 'repo:12', 'repo:11'].map(k => row(kept.view, k).checked)).toEqual([false, false, true])

    const byProposal = await rulesView(p, litterDir, blankRulesNav('proposed', { proposal: { store: 'repo', seq: 11 } }))
    expect(byProposal.batch).toBe(9)
    expect(byProposal.view.body!.focus).toBe('repo:11')
  })

  test("under -p nothing can be accepted: no [Accept], and the notice says why", async () => {
    state.setInteractive(false)
    const { view: v } = await rulesView(p, litterDir, blankRulesNav('proposed'))
    expect(row(v, 'repo:3').actions).toEqual(['edit', 'dismiss'])
    expect(row(v, 'P-hand').actions).toEqual([])
    expect(v.body!.notice).toEqual({ level: 'warning', text: "this session isn't interactive, so nothing can be accepted here (16.3)" })
  })

  test("a store that can't be read is a problem on either tab, not an empty pane without a word", async () => {
    viewDeps.loadRules = async () => {
      throw new Error('a file went away')
    }
    const { view: v } = await rulesView(p, litterDir, blankRulesNav('proposed'))
    expect(v.body!.problems).toEqual(["the rules couldn't be loaded: a file went away"])
    expect(rowsOf(v).length).toBe(6)
  })
})

describe('the In force tab', () => {
  test('the version in force of each rule, its standing, overrides on both rules, a rule that matches no file, the problems', async () => {
    const { view: v } = await rulesView(p, litterDir, blankRulesNav('in-force'))
    expect(v.tab).toBe('in-force')
    expect(rowsOf(v).map(r => r.key)).toEqual(['P-tests-first', 'U-theirs', 'L-mine', 'P-hand', 'P-nowhere'])
    expect(rowsOf(v).every(r => r.kind === 'accepted' && r.actions.join() === 'edit,retire')).toBe(true)
    // Nothing in force has an [Accept], so nothing says what one writes.
    expect(rowsOf(v).every(r => r.consequence === undefined)).toBe(true)

    // An edit of it waits under Proposed (repo:5): said here, so the version in force isn't mistaken for the last word.
    expect(row(v, 'P-tests-first')).toEqual(expect.objectContaining({ id: 'P-tests-first', version: 2, scope: 'project', paths: ['src/**'], notes: ['an edit of it is proposed: see the Proposed tab'] }))
    // The done mark, and "in force": never a proposal's.
    expect(row(v, 'P-tests-first').status).toEqual({ text: 'in force', color: 'success', glyph: '✓' })
    expect(row(v, 'P-tests-first').origin).toBe('accepted in the rules pane')
    expect(row(v, 'U-theirs').notes).toEqual(['local L-mine overrides U-theirs'])
    expect(row(v, 'L-mine').notes).toEqual(['local L-mine overrides U-theirs'])
    // The hand-edited file's committed version is what's in force.
    expect(row(v, 'P-hand').status.text).toBe('in force (committed)')
    expect(row(v, 'P-hand').origin).toBe('accepted through a commit: the version at HEAD')
    expect(row(v, 'P-hand').rule).toBe('rule P-hand')
    expect(row(v, 'P-hand').notes).toEqual(["the file has an edit you haven't accepted: see the Proposed tab"])
    expect(row(v, 'P-nowhere').notes).toEqual([MATCHES_NO_FILE])
    expect(v.body!.problems).toEqual(['P-dup is in two scopes: project and local'])
  })

  test("a ban whose paths match no file gets its own note, not the flag: it still reaches every gate", async () => {
    loaded = [
      rule('P-nowhere', 'project', { d: doc('P-nowhere', 1, { paths: ['nowhere/**'] }) }),
      rule('P-ban-nowhere', 'project', { d: doc('P-ban-nowhere', 1, { type: 'ban', paths: ['nowhere/**'] }) }),
      rule('P-ban-src', 'project', { d: doc('P-ban-src', 1, { type: 'ban', paths: ['src/**'] }) }),
      rule('P-ban-all', 'project', { d: doc('P-ban-all', 1, { type: 'ban' }) }),
    ]
    const { view: v } = await rulesView(p, litterDir, blankRulesNav('in-force'))
    expect(rowsOf(v).map(r => [r.key, r.notes])).toEqual([
      ['P-nowhere', [MATCHES_NO_FILE]],
      ['P-ban-nowhere', ['its paths match no file yet; a ban still reaches every gate']],
      ['P-ban-src', []],
      ['P-ban-all', []],
    ])
    expect(BAN_MATCHES_NO_FILE).toBe('its paths match no file yet; a ban still reaches every gate')
  })

  test("a matcher that throws, or git that can't list the files, flags nothing", async () => {
    viewDeps.matches = () => {
      throw new Error('not built')
    }
    let v = (await rulesView(p, litterDir, blankRulesNav('in-force'))).view
    expect(row(v, 'P-nowhere').notes).toEqual([])
    expect(p.logs.some(l => l.includes('paths not checked against the files: not built'))).toBe(true)
    viewDeps.matches = savedView.matches
    tracked = null
    v = (await rulesView(p, litterDir, blankRulesNav('in-force'))).view
    expect(row(v, 'P-nowhere').notes).toEqual([])
  })

  // Phase 6 (16.7): each rule's Claude Code rule file, as export.ts's exportsOf has it.
  const exp = (id: string, scope: RuleExportView['scope'], version: number, over: Partial<RuleExportView>): RuleExportView => ({
    id,
    version,
    scope,
    path: null,
    state: 'exported',
    bindsAfterRead: false,
    expected: null,
    actual: null,
    staleIn: [],
    ...over,
  })
  const exportsAt = (name: string) => join(dir, '.claude', 'rules', name)

  test("each rule's Claude Code rule file: where it loads from, a hand edit with its diff, a deletion, why one isn't, and the folders' problems", async () => {
    exportViews = [
      exp('P-tests-first', 'project', 2, { path: exportsAt('litter/P-tests-first.md'), bindsAfterRead: true, staleIn: ['wt-a'] }),
      exp('U-theirs', 'user', 1, { state: 'edited', path: '/home/you/.claude/rules/litter/U-theirs.md', expected: '## Rule\nrule U-theirs\n', actual: '## Rule\nrule U-theirs, edited\n' }),
      exp('L-mine', 'local', 1, { state: 'deleted', path: exportsAt('litter-local/L-mine.md') }),
      exp('P-hand', 'project', 1, { state: 'off' }),
      exp('P-nowhere', 'project', 1, { state: 'pending', path: exportsAt('litter/P-nowhere.md'), excludedBy: '**/rules/litter/**' }),
    ]
    exportProblems = ['/repo/.claude/rules/litter/P-gone.md: a rule file for P-gone that litter didn\'t write']
    const { view: v, shown } = await rulesView(p, litterDir, blankRulesNav('in-force'))
    // Asked once, with the rules this build loaded, for the worktrees and the excludes too.
    expect(called('exportsOf')).toEqual([[{ worktrees: true, settings: true, loaded: 6 }]])
    expect(row(v, 'P-tests-first').notes).toEqual([
      'an edit of it is proposed: see the Proposed tab',
      'exported for Claude Code: .claude/rules/litter/P-tests-first.md; it binds after a Read of a file its paths match',
      'the copy in 1 worktree differs (wt-a): a session started there reads its own',
    ])
    const edited = row(v, 'U-theirs')
    expect(edited.notes).toEqual([
      'local L-mine overrides U-theirs',
      `${EXPORT_EDITED} (/home/you/.claude/rules/litter/U-theirs.md), so litter leaves it: Adopt edit proposes the edit as the next version, Restore file puts litter's copy back`,
    ])
    expect(edited.actions).toEqual(['edit', 'retire', 'adopt', 'restore'])
    expect([edited.diffLabel, edited.diff!.map(s => s.text)]).toEqual([EXPORT_DIFF, ['  ## Rule', '+ rule U-theirs, edited', '− rule U-theirs', '  ']])
    expect(shown['U-theirs']!.export).toBe('edited')
    expect(row(v, 'L-mine').notes.at(-1)).toBe(`${EXPORT_DELETED} (.claude/rules/litter-local/L-mine.md); litter writes it again for the next version, or now with Restore file`)
    expect([row(v, 'L-mine').actions, shown['L-mine']!.export]).toEqual([['edit', 'retire', 'restore'], 'deleted'])
    expect(row(v, 'P-hand').notes.at(-1)).toBe('not exported for Claude Code (export: false)')
    expect(row(v, 'P-nowhere').notes).toEqual([
      MATCHES_NO_FILE,
      'exported for Claude Code at the next sync: .claude/rules/litter/P-nowhere.md',
      'your claudeMdExcludes setting (**/rules/litter/**) keeps Claude Code from loading its rule file',
    ])
    // A hand edit, a deletion, another copy and an exclude are warnings; where it loads from isn't.
    expect([...row(v, 'P-tests-first').notes.slice(1), ...edited.notes.slice(1), row(v, 'L-mine').notes.at(-1)!, ...row(v, 'P-nowhere').notes.slice(1)].map(flagged)).toEqual([
      false,
      true,
      true,
      true,
      false,
      true,
    ])
    expect(describeRow(edited).map(l => l.map(s => s.text).join(''))).toContain(EXPORT_DIFF)
    expect(v.body!.problems).toEqual(['P-dup is in two scopes: project and local', "/repo/.claude/rules/litter/P-gone.md: a rule file for P-gone that litter didn't write"])
  })

  test('an adoption under way, or one you dismissed, leaves Restore file alone; an unreadable file, nothing', async () => {
    const ref = { store: 'repo' as const, seq: 30 }
    const edited = (adoption?: RuleExportView['adoption'], actual: string | null = 'x') =>
      exp('U-theirs', 'user', 1, { state: 'edited', path: '/home/you/.claude/rules/litter/U-theirs.md', expected: 'y', actual, ...(adoption ? { adoption } : {}), why: 'not a plain file' })
    for (const [view_, actions, note] of [
      [edited({ proposal: ref, status: 'proposed' }), ['edit', 'retire', 'restore'], 'adopting the edit is proposed: see the Proposed tab'],
      [edited({ proposal: ref, status: 'dismissed' }), ['edit', 'retire', 'restore'], "and you dismissed adopting it; Restore file puts litter's copy back"],
      [edited(undefined, null), ['edit', 'retire'], 'or replaced: not a plain file'],
    ] as const) {
      exportViews = [view_]
      const v = (await rulesView(p, litterDir, blankRulesNav('in-force'))).view
      expect(row(v, 'U-theirs').actions).toEqual([...actions])
      expect(row(v, 'U-theirs').notes.at(-1)).toEndWith(note)
    }
  })
})

describe("a row's words (WP-DE): its mark, its description, what [Accept] writes", () => {
  const base: RulesRow = {
    key: 'repo:1',
    kind: 'proposal',
    id: null,
    version: null,
    scope: null,
    type: 'rule',
    status: STATUS.proposed,
    when: 'touching the parser',
    rule: 'Run the parser tests.\nThen the grammar ones.',
    paths: [],
    origin: 'drafted from your words (/litter:rules add)',
    notes: ['its id is assigned when you accept it', MATCHES_NO_FILE, 'local L-mine overrides U-theirs'],
    diff: null,
    source: 'user',
    actions: ['accept', 'edit', 'dismiss'],
  }

  test('what waits on you has the needs-you mark, what is in force the done one: never the same', () => {
    expect([STATUS.proposed, STATUS.unverified].map(s => [s.glyph, s.color])).toEqual([
      ['⚑', 'permission'],
      ['⚑', 'permission'],
    ])
    expect([STATUS.accepted, STATUS['accepted (committed)']].map(s => [s.glyph, s.color, s.text])).toEqual([
      ['✓', 'success', 'in force'],
      ['✓', 'success', 'in force (committed)'],
    ])
  })

  test('the description: the wording, type and scope, when, the paths or the no-paths warning, where it came from, the notes, the diff', () => {
    expect(describeRow(base)).toEqual([
      [{ text: 'Run the parser tests.' }],
      [{ text: 'Then the grammar ones.' }],
      [{ text: 'rule' }, { text: ' · ', color: 'subtle' }, { text: '! no scope yet', color: 'warning' }],
      [{ text: 'when ', color: 'inactive' }, { text: 'touching the parser' }],
      [{ text: `! ${NO_PATHS}`, color: 'warning' }],
      [{ text: 'drafted from your words (/litter:rules add)', color: 'inactive' }],
      [{ text: 'its id is assigned when you accept it', color: 'inactive' }],
      // A note that flags something: the warning color, with its `!`.
      [{ text: `! ${MATCHES_NO_FILE}`, color: 'warning' }],
      [{ text: '! local L-mine overrides U-theirs', color: 'warning' }],
    ])
    expect([MATCHES_NO_FILE, 'local L-mine overrides U-theirs', BAN_MATCHES_NO_FILE].map(flagged)).toEqual([true, true, false])
    // A ban's paths are what it protects; with none, it still reaches every gate but names nothing.
    const ban = { ...base, type: 'ban', scope: 'project', notes: [] }
    expect(describeRow({ ...ban, paths: ['vendor/**', 'gen/**'] })[4]).toEqual([{ text: 'protects ', color: 'inactive' }, { text: 'vendor/**, gen/**', color: 'suggestion' }])
    expect(describeRow(ban)[4]).toEqual([{ text: `! ${BAN_NO_PATHS}`, color: 'warning' }])
    expect(describeRow({ ...ban, type: 'rule', paths: ['src/**'] })[4]).toEqual([{ text: 'paths ', color: 'inactive' }, { text: 'src/**', color: 'suggestion' }])
    expect(describeRow(ban)[2]).toEqual([{ text: 'ban' }, { text: ' · ', color: 'subtle' }, { text: 'project scope' }])
    expect(describeRow({ ...base, kind: 'accepted', scope: 'user', notes: [] })[4]).toEqual([{ text: `! ${NO_PATHS_IN_FORCE}`, color: 'warning' }])
    // An edit's diff last, under its heading, each line in its color.
    const diff = describeRow({ ...base, notes: [], diff: [{ text: '  type: rule', dim: true }, { text: '− old', color: 'error' }, { text: '+ new', color: 'success' }] })
    expect(diff.slice(-4)).toEqual([
      [{ text: 'against the version in force:', color: 'inactive' }],
      [{ text: '  type: rule', color: 'inactive' }],
      [{ text: '− old', color: 'error' }],
      [{ text: '+ new', color: 'success' }],
    ])
  })

  test('what [Accept] writes: nothing without a scope, a new file in its folder, the next version of an edit, a file as it stands, the exact path once seen', () => {
    expect(consequenceOf({ kind: 'no-scope' })).toEqual([{ text: 'Accept', bold: true }, { text: ' writes nothing until you pick a scope' }])
    expect(consequenceOf({ kind: 'new', scope: 'user', folder: '/cfg/litter/rules' })).toEqual([
      { text: 'Accept', bold: true },
      { text: ' writes ' },
      { text: '/cfg/litter/rules/U-….md', color: 'suggestion' },
      { text: '; every later run in user scope gets it' },
    ])
    expect(consequenceOf({ kind: 'new', scope: 'user', folder: null })[2]).toEqual({ text: 'a user rule file' })
    expect(consequenceOf({ kind: 'edit', scope: 'project', path: '.litter/rules/P-x.md', version: 4 }).map(s => s.text).join('')).toBe(
      'Accept writes .litter/rules/P-x.md as version 4, for you to commit; every later run in project scope gets it',
    )
    expect(consequenceOf({ kind: 'file', scope: 'local', path: '.litter.local/rules/L-x.md' }).map(s => s.text).join('')).toBe(
      'Accept marks .litter.local/rules/L-x.md accepted, as it stands; every later run in local scope gets it',
    )
    expect(consequenceOf({ kind: 'confirm', scope: 'project', path: '.litter/rules/P-x.md' })[0]).toEqual({ text: 'Confirm accept', bold: true })
  })

  test("what [Accept selected] writes: each scope's count and folder, the project ones for you to commit", () => {
    const folders = { user: '/cfg/litter/rules', project: '.litter/rules', local: '.litter.local/rules' }
    const words = (scopes: ('user' | 'project' | 'local' | null)[], confirm = false) => batchConsequence(scopes, folders, confirm).map(s => s.text).join('')
    expect(words([])).toBe('Accept selected writes nothing: nothing is checked')
    // An import's scope is project unless you picked another (16.8).
    expect(words([null])).toBe('Accept selected writes 1 new file in .litter/rules/, for you to commit; every later run in project scope gets it')
    expect(words(['project', 'user', null], true)).toBe(
      'Confirm accept writes 1 new file in /cfg/litter/rules/ and 2 new files in .litter/rules/, the project ones for you to commit; every later run in user or project scope gets them',
    )
    expect(batchConsequence(['local'], { ...folders, local: null }, false).map(s => s.text).join('')).toBe('Accept selected writes 1 new file in the local rules; every later run in local scope gets it')
  })
})

describe('the presses reach the store once each, with what the pane showed', () => {
  test('/litter rules opens `litter` on Rules; [Accept] on a user proposal accepts it once into user scope', async () => {
    expect(await rulesCommand(p, command(), next)).toEqual({ text: 'Rules shows 8 proposed or unverified, 5 in force' })
    expect(p.panes.opened).toEqual([{ id: 'litter', title: 'litter', focus: true }])
    await pressRules(p, 'rules:accept:repo:3')
    expect(acting()).toEqual([{ fn: 'acceptRule', args: [{ proposal: { store: 'repo', seq: 3 } }, { scope: 'user' }] }])
    expect(view().body!.notice).toEqual({ level: 'ok', text: 'accepted into user scope: written to /home/you/.claude/litter/rules/user-rule.md' })
  })

  test("one step at a time: a press waits for the row pick before it, whose build is still running, so the pick's view never lands over the press's", async () => {
    await rulesCommand(p, command(), next)
    // The pick's build is held: a click's post is handled apart from the press after it.
    let release!: () => void
    const held = new Promise<void>(r => (release = r))
    const load = viewDeps.loadRules
    let first = true
    viewDeps.loadRules = async (...a) => {
      if (first) {
        first = false
        await held
      }
      return load(...a)
    }
    const drawn: (string | null)[] = []
    const setView = p.setView
    p.setView = async (pane, v) => {
      if (pane === 'rules') drawn.push((v as RulesPaneView).body?.focus ?? null)
      return setView(pane, v)
    }
    const pick = pressRules(p, 'rules:row:repo:4')
    const accept = pressRules(p, 'rules:accept:repo:3')
    // A bounded look for the press running early; it can't, queued behind the pick.
    expect(await Promise.race([accept.then(() => 'ran'), new Promise(r => setTimeout(() => r('queued'), 50))])).toBe('queued')
    expect(acting()).toEqual([])
    release()
    await Promise.all([pick, accept])
    // The pick drew, then the press: the last view is the accept's, on its row, with its outcome.
    expect(drawn).toEqual(['repo:4', 'repo:3'])
    expect(acting()).toEqual([{ fn: 'acceptRule', args: [{ proposal: { store: 'repo', seq: 3 } }, { scope: 'user' }] }])
    expect(view().body!.focus).toBe('repo:3')
    expect(notice()).toMatch(/^accepted into user scope/)
  })

  test('a project proposal: [Accept] shows the exact file, [Confirm accept] writes it, and a second confirm is ignored', async () => {
    await rulesCommand(p, command(), next)
    await pressRules(p, 'rules:accept:repo:4')
    expect(called('previewAccept')).toEqual([[{ proposal: { store: 'repo', seq: 4 } }, { scope: 'project' }]])
    expect(acting()).toEqual([])
    // The file's path as you'd commit it, relative to the checkout; what [Confirm accept] writes, on its line.
    expect(view().body!.pending).toEqual({ kind: 'preview', key: 'repo:4', path: '.litter/rules/P-repo-4.md', text: '---\nid: P-repo-4\n---\n\n## Rule\nParse once.\n' })
    expect(row(view(), 'repo:4').consequence).toEqual([
      { text: 'Confirm accept', bold: true },
      { text: ' writes ' },
      { text: '.litter/rules/P-repo-4.md', color: 'suggestion' },
      { text: ', for you to commit; every later run in project scope gets it' },
    ])
    expect(view().body!.focus).toBe('repo:4')
    await pressRules(p, 'rules:confirm:repo:4')
    expect(acting()).toEqual([{ fn: 'acceptRule', args: [{ proposal: { store: 'repo', seq: 4 } }, { scope: 'project' }] }])
    expect(notice()).toBe('accepted: commit .litter/rules/P-parse-once.md yourself')
    expect(view().body!.pending).toBeNull()
    await pressRules(p, 'rules:confirm:repo:4')
    expect(acting().length).toBe(1)
    expect(p.toasts.at(-1)).toBe('there was no file waiting to be confirmed, so that was ignored')
  })

  test('[Cancel] drops the preview, and nothing is written', async () => {
    await rulesCommand(p, command(), next)
    await pressRules(p, 'rules:accept:repo:4')
    await pressRules(p, 'rules:cancel:repo:4')
    expect(view().body!.pending).toBeNull()
    await pressRules(p, 'rules:confirm:repo:4')
    expect(acting()).toEqual([])
  })

  test('no scope: [Accept] asks, a pick holds it without accepting, then [Accept] accepts into it', async () => {
    await rulesCommand(p, command(), next)
    // repo:11, an import out of its batch, has no scope of its own.
    await pressRules(p, 'rules:accept:repo:11')
    expect(calls.filter(c => c.fn !== 'proposalsOf')).toEqual([])
    expect(view().body!.pending).toEqual({ kind: 'scope', key: 'repo:11' })
    expect(notice()).toContain('pick the scope to accept it into')
    // The press picked its row.
    expect(view().body!.focus).toBe('repo:11')
    // A scope that isn't one is ignored; a real one is held, from the pick's Button (WP-DE) or a Select.
    await onRulesUi.select(p, { element: 'rules:scope:repo:11', value: 'everywhere' } as never, next)
    await pressRules(p, 'rules:scope-everywhere:repo:11')
    expect(rulesNavOf()!.held['repo:11']).toBeUndefined()
    await pressRules(p, 'rules:scope-user:repo:11')
    expect(rulesNavOf()!.held['repo:11']).toEqual({ scope: 'user' })
    expect(await onRulesUi.select(p, { element: 'rules:scope:repo:11', value: 'local' } as never, next)).toEqual({ element: 'rules:scope:repo:11', value: 'local' })
    expect(acting()).toEqual([])
    expect(view().body!.pending).toBeNull()
    expect(row(view(), 'repo:11').notes).toContain('scope local, chosen here')
    expect(row(view(), 'repo:11').consequence).toEqual([
      { text: 'Accept', bold: true },
      { text: ' writes ' },
      { text: '.litter.local/rules/L-….md', color: 'suggestion' },
      { text: '; every later run in local scope gets it' },
    ])
    await pressRules(p, 'rules:accept:repo:11')
    expect(acting()).toEqual([{ fn: 'acceptRule', args: [{ proposal: { store: 'repo', seq: 11 } }, { scope: 'local' }] }])
  })

  test('an edit stays in its rule\'s scope: [Accept] shows the next version of its file, never asks a scope', async () => {
    await rulesCommand(p, command(), next)
    await pressRules(p, 'rules:accept:repo:5')
    expect(called('previewAccept')).toEqual([[{ proposal: { store: 'repo', seq: 5 } }, { scope: 'project' }]])
    expect(view().body!.pending).toEqual(expect.objectContaining({ kind: 'preview', key: 'repo:5' }))
    expect(acting()).toEqual([])
  })

  test("[Edit…] holds the paths, through AD's narrowPaths on Enter, and the type, until [Accept]", async () => {
    await rulesCommand(p, command(), next)
    await pressRules(p, 'rules:edit:repo:3')
    expect(view().body!.editing).toEqual({ key: 'repo:3', paths: '', type: 'rule', error: null })
    // Typing calls nothing.
    await onRulesUi.input(p, { element: 'rules:paths:repo:3', value: 'src/**', kind: 'change' } as never, next)
    expect(called('narrowPaths')).toEqual([])
    await onRulesUi.input(p, { element: 'rules:paths:repo:3', value: '/etc/**', kind: 'submit' } as never, next)
    expect(view().body!.editing?.error).toBe("/etc/** isn't relative to the repository")
    await onRulesUi.input(p, { element: 'rules:paths:repo:3', value: 'test/**, src/**,\nsrc/**', kind: 'submit' } as never, next)
    expect(called('narrowPaths').at(-1)).toEqual([['test/**', 'src/**', 'src/**']])
    expect(view().body!.editing).toEqual({ key: 'repo:3', paths: 'src/**, test/**', type: 'rule', error: null })
    await onRulesUi.select(p, { element: 'rules:type:repo:3', value: 'ban' } as never, next)
    expect(row(view(), 'repo:3')).toEqual(expect.objectContaining({ type: 'ban', paths: ['src/**', 'test/**'] }))
    await pressRules(p, 'rules:edit-done:repo:3')
    expect(view().body!.editing).toBeNull()
    expect(acting()).toEqual([])
    await pressRules(p, 'rules:accept:repo:3')
    expect(acting()).toEqual([{ fn: 'acceptRule', args: [{ proposal: { store: 'repo', seq: 3 } }, { scope: 'user', paths: ['src/**', 'test/**'], type: 'ban' }] }])
  })

  test('[Accept selected] on an import batch: exactly the checked ones, project files shown first, each failure reported', async () => {
    expect(await openRulesPane(p, { proposal: { store: 'repo', seq: 9 } })).toBe(true)
    expect(view().body!.batch?.seq).toBe(9)
    // Check the archived instance's, uncheck one of the live one's.
    await pressRules(p, 'rules:check:repo:11')
    await pressRules(p, 'rules:check:repo:12')
    expect(['repo:10', 'repo:12', 'repo:11'].map(k => row(view(), k).checked)).toEqual([true, false, true])
    await pressRules(p, 'rules:accept-selected:9')
    // repo:11 has no scope of its own: an import's is project (16.8).
    expect(called('previewAccept')).toEqual([
      [{ proposal: { store: 'repo', seq: 10 } }, { scope: 'project' }],
      [{ proposal: { store: 'repo', seq: 11 } }, { scope: 'project' }],
    ])
    expect(acting()).toEqual([])
    // The folder and each file as you'd commit them, relative to the checkout; [Confirm accept]'s line says what it writes.
    expect(view().body!.pending).toEqual(expect.objectContaining({ kind: 'preview', key: 'batch:9', path: '.litter/rules/' }))
    expect(view().body!.pending?.kind === 'preview' && view().body!.pending).toEqual(expect.objectContaining({ text: expect.stringContaining('--- .litter/rules/P-repo-11.md') }))
    expect(view().body!.batch?.consequence?.[0]).toEqual({ text: 'Confirm accept', bold: true })

    refuse['repo:11'] = 'the proposal changed since it was shown'
    await pressRules(p, 'rules:confirm:batch:9')
    expect(acting()).toEqual([
      { fn: 'acceptRule', args: [{ proposal: { store: 'repo', seq: 10 } }, { scope: 'project' }] },
      { fn: 'acceptRule', args: [{ proposal: { store: 'repo', seq: 11 } }, { scope: 'project' }] },
    ])
    expect(view().body!.notice).toEqual({
      level: 'warning',
      text: 'accepted 1 of 2; commit the new .litter/rules/ files yourself; not accepted: repo:11: the proposal changed since it was shown',
    })
    // The accepted one is unchecked; the refused one stays checked for another try.
    expect(rulesNavOf()!.checked).toEqual(['repo:11'])
  })

  test('a check toggled after the preview drops it: [Confirm accept] then writes nothing', async () => {
    await openRulesPane(p, { proposal: { store: 'repo', seq: 9 } })
    await pressRules(p, 'rules:accept-selected:9')
    await pressRules(p, 'rules:check:repo:11')
    expect(view().body!.pending).toBeNull()
    await pressRules(p, 'rules:confirm:batch:9')
    expect(acting()).toEqual([])
  })

  test('[Dismiss] dismisses the proposal shown, once', async () => {
    await rulesCommand(p, command(), next)
    await pressRules(p, 'rules:dismiss:repo:4')
    expect(acting()).toEqual([{ fn: 'dismissRule', args: [{ store: 'repo', seq: 4 }] }])
    expect(notice()).toBe('dismissed: the same text, proposed again, comes back dismissed')
  })

  test('[Retire] asks first; [Confirm retire] retires the version shown, once', async () => {
    // A rule id in force opens on the In force tab.
    await openRulesPane(p, { id: 'P-tests-first' })
    expect(view().tab).toBe('in-force')
    expect(view().body!.focus).toBe('P-tests-first')
    await pressRules(p, 'rules:confirm-retire:P-tests-first')
    expect(acting()).toEqual([])
    await pressRules(p, 'rules:retire:P-tests-first')
    expect(acting()).toEqual([])
    expect(view().body!.pending).toEqual({ kind: 'retire', key: 'P-tests-first' })
    await pressRules(p, 'rules:confirm-retire:P-tests-first')
    expect(acting()).toEqual([{ fn: 'retireRule', args: [{ id: 'P-tests-first', version: 2 }] }])
    expect(notice()).toBe('retired P-tests-first@2; commit the removal yourself')
  })

  test('an accept and a retire bring the Claude Code rule files in line, and the notice names what was written', async () => {
    await rulesCommand(p, command(), next)
    synced = [join(dir, '.claude', 'rules', 'litter', 'U-prefer-small-commits.md')]
    await pressRules(p, 'rules:accept:repo:3')
    expect(notice()).toBe('accepted into user scope: written to /home/you/.claude/litter/rules/user-rule.md; Claude Code rule files: wrote .claude/rules/litter/U-prefer-small-commits.md')
    expect(called('syncExports')).toHaveLength(1)
    // A press that changes nothing in force syncs nothing.
    await pressRules(p, 'rules:dismiss:repo:4')
    expect(called('syncExports')).toHaveLength(1)
  })

  test('[Adopt edit] proposes the edit and opens it on the Proposed tab; [Restore file] asks first over an edit, and writes a deleted one at once', async () => {
    exportViews = [
      { id: 'U-theirs', version: 1, scope: 'user', path: '/home/you/.claude/rules/litter/U-theirs.md', state: 'edited', bindsAfterRead: false, expected: 'a\n', actual: 'b\n', staleIn: [] },
      { id: 'L-mine', version: 1, scope: 'local', path: join(dir, '.claude', 'rules', 'litter-local', 'L-mine.md'), state: 'deleted', bindsAfterRead: false, expected: 'a\n', actual: null, staleIn: [] },
    ]
    await openRulesPane(p, { id: 'U-theirs' })
    await pressRules(p, 'rules:adopt:U-theirs')
    expect(called('adoptExport')).toEqual([[{ id: 'U-theirs', version: 1 }]])
    expect([view().tab, rulesNavOf()!.focus, rulesNavOf()!.selected]).toEqual(['proposed', { proposal: { store: 'repo', seq: 40 } }, 'repo:40'])
    expect(notice()).toBe("the edit is proposed as U-theirs@2: accept it here, and the rule file becomes litter's copy of that version")

    await pressRules(p, 'rules:tab:in-force')
    await pressRules(p, 'rules:confirm-restore:U-theirs')
    expect(called('restoreExport')).toEqual([])
    await pressRules(p, 'rules:restore:U-theirs')
    expect([called('restoreExport'), view().body!.pending]).toEqual([[], { kind: 'restore', key: 'U-theirs' }])
    await pressRules(p, 'rules:confirm-restore:U-theirs')
    expect(called('restoreExport')).toEqual([[{ id: 'U-theirs', version: 1 }]])
    expect([notice(), view().body!.pending]).toEqual(['restored .claude/rules/litter/U-theirs.md', null])
    await pressRules(p, 'rules:restore:L-mine')
    expect(called('restoreExport')).toEqual([[{ id: 'U-theirs', version: 1 }], [{ id: 'L-mine', version: 1 }]])
    expect(notice()).toBe('restored .claude/rules/litter/L-mine.md')
    // Nothing else reached the store's acting functions.
    expect(acting()).toEqual([])
  })

  test("[Edit…] on a rule in force fills the prompt with the skill's command", async () => {
    await openRulesPane(p, { id: 'U-theirs' })
    await pressRules(p, 'rules:edit:U-theirs')
    expect(p.filled).toEqual(['/litter:rules show U-theirs'])
    expect(acting()).toEqual([])
  })

  test('an unverified file is accepted as it is, by its path', async () => {
    await rulesCommand(p, command(), next)
    await pressRules(p, 'rules:accept:U-new')
    expect(acting()).toEqual([{ fn: 'acceptRule', args: [{ file: '/home/you/.claude/litter/rules/U-new.md' }, { scope: 'user' }] }])
  })

  test("the store's refusal is the notice", async () => {
    refuse['repo:3'] = 'U-small-commits is taken'
    await rulesCommand(p, command(), next)
    await pressRules(p, 'rules:accept:repo:3')
    expect(view().body!.notice).toEqual({ level: 'error', text: 'not accepted: U-small-commits is taken' })
  })

  test('a row not shown, a dismissed proposal, a tab that isn\'t one, and -p: nothing reaches the store', async () => {
    await rulesCommand(p, command(), next)
    await pressRules(p, 'rules:accept:repo:6')
    await pressRules(p, 'rules:dismiss:repo:99')
    await pressRules(p, 'rules:retire:repo:3')
    await pressRules(p, 'rules:tab:everything')
    expect(view().tab).toBe('proposed')
    expect(p.toasts.filter(t => t === "that rule isn't shown any more, so it was ignored").length).toBe(3)
    state.setInteractive(false)
    await pressRules(p, 'rules:accept:repo:3')
    expect(notice()).toBe("this session isn't interactive, so nothing can be accepted here (16.3)")
    expect(acting()).toEqual([])
    expect(called('previewAccept')).toEqual([])
  })
})

describe('nothing but a press acts (COMMON, "Only you accept")', () => {
  test('with a preview and a retire waiting: a message, picks, fields, the ticks, a refresh and an open call none of them', async () => {
    await rulesCommand(p, command(), next)
    await pressRules(p, 'rules:accept:repo:4')
    expect(view().body!.pending?.kind).toBe('preview')
    calls = []
    // A Client post, as a rogue one would make it.
    expect(await onRulesUi.message(p, { element: 'rules:confirm:repo:4', data: { action: 'confirm', key: 'repo:4' } } as never, next)).toBe('beneath' as never)
    // A pick and a field on every key there is.
    for (const element of ['rules:confirm:repo:4', 'rules:accept:repo:3', 'rules:scope:repo:4', 'rules:dismiss:repo:3', 'rules:confirm-retire:P-tests-first']) {
      await onRulesUi.select(p, { element, value: 'project' } as never, next)
      await onRulesUi.input(p, { element, value: 'src/**', kind: 'submit' } as never, next)
    }
    // The ledgers move; the ticks redraw.
    proposals = [...proposals, { ref: { store: 'repo', seq: 20 }, body: { rule: 'From a critic', source: 'critic' }, status: 'proposed' }]
    await p.store.set(headKey(repoRulesLedgerDir(litterDir)),{ seq: 20, sha: 'f'.repeat(64) })
    await rulesTick(p)
    await boardTick(p)
    await refreshRulesPane(p)
    await openRulesPane(p, { proposal: { store: 'repo', seq: 4 } })
    await openRulesPane(p, { id: 'P-tests-first' })
    expect(acting()).toEqual([])
    expect(called('previewAccept')).toEqual([])
    // A press passes on what isn't the pane's.
    expect(await onRulesUi.press(p, { element: 'board:rules' } as never, next)).toBe('beneath' as never)
    expect(acting()).toEqual([])
  })

  test('the tick redraws only when a rules ledger moved', async () => {
    await rulesCommand(p, command(), next)
    const v = view().v
    delete p.views.rules
    await rulesTick(p)
    expect(p.views.rules).toBeUndefined()
    await p.store.set(headKey(repoRulesLedgerDir(litterDir)),{ seq: 1, sha: 'f'.repeat(64) })
    await rulesTick(p)
    expect(view().v).toBeGreaterThan(v)
  })

  test("only hooks/rules/pane.tsx imports AD's acceptRule, dismissRule and retireRule", () => {
    const hooks = join(import.meta.dir, '..', '..', 'hooks')
    const files: string[] = []
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const path = join(d, name)
        if (statSync(path).isDirectory()) walk(path)
        else if (/\.tsx?$/.test(name)) files.push(path)
      }
    }
    walk(hooks)
    const rulesStore = join(hooks, 'rules', 'store')
    /** The module an import names, resolved from the importing file, without its extension. */
    const target = (from: string, spec: string) => (spec.startsWith('.') ? join(from, '..', spec) : spec)
    const importers: string[] = []
    const namespaced: string[] = []
    for (const f of files) {
      if (f.startsWith(`${rulesStore}.`)) continue
      const text = readFileSync(f, 'utf8')
      for (const m of text.matchAll(/import\s+(type\s+)?([^'";]*?)\s+from\s+'([^']+)'/g)) {
        if (m[1] || target(f, m[3]!) !== rulesStore) continue
        if (/\*\s+as\s+/.test(m[2]!)) namespaced.push(relative(hooks, f))
        else if (/\b(acceptRule|dismissRule|retireRule)\b/.test(m[2]!)) importers.push(relative(hooks, f))
      }
    }
    expect(importers).toEqual([join('rules', 'pane.tsx')])
    // And no module reaches them through a namespace import of the store.
    expect(namespaced).toEqual([])
    // Nor export.ts's adoptExport and restoreExport (16.7): a hand edit is overwritten or proposed only from a press.
    const exportMod = join(hooks, 'rules', 'export')
    const exportImporters = files.filter(f => {
      if (f.startsWith(`${exportMod}.`)) return false
      return [...readFileSync(f, 'utf8').matchAll(/import\s+(type\s+)?([^'";]*?)\s+from\s+'([^']+)'/g)].some(
        m => !m[1] && target(f, m[3]!) === exportMod && (/\*\s+as\s+/.test(m[2]!) || /\b(adoptExport|restoreExport)\b/.test(m[2]!)),
      )
    })
    expect(exportImporters.map(f => relative(hooks, f))).toEqual([join('rules', 'pane.tsx')])
  })
})
