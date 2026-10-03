// Tier 2: the rules pane (WP-AF; plan 16.3, 16.6, 16.8, 12:1566). Its view
// (hooks/rules/paneview.ts) on both tabs: proposals with where they came
// from, an edit's diff, an import batch grouped by instance with its
// preselection, unverified files, overrides, a rule that matches no file. And
// its handlers (hooks/rules/pane.tsx) end to end, with AD's store and AE's
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
import type { LoadedRule, ProposalRef, RuleDoc, RuleImportBody, RuleProposeBody, RuleStatus } from '../../hooks/records/rules'
import type { RulesPaneView, RulesRow } from '../../types/index'
import { updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import { MOD } from '../../hooks/verify'
import { MATCHES_NO_FILE, blankRulesNav, deps as viewDeps, resetRulesViewForTests, rulesNavOf, rulesView } from '../../hooks/rules/paneview'
import { deps as paneDeps, onRulesUi, openRulesPane, pressRules, refreshRulesPane, resetRulesPaneForTests, rulesCommand, rulesTick } from '../../hooks/rules/pane'
import { boardTick, resetBoardPaneForTests } from '../../hooks/board/pane'
import { resetBoardForTests } from '../../hooks/board/view'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

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
  })
  viewDeps.lsFiles = async () => tracked
  viewDeps.matches = (pattern, path) => (pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : pattern === path)

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

const origin = (instance: string, archived = false) => ({ instance, source: 'deepwork guardrail', archived })
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
const command = () => ({ command: 'litter-rules', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as never

// ---------------------------------------------------------------------------

describe('the Proposed tab', () => {
  test('proposals with where they came from, an edit as a diff, then the unverified files', async () => {
    const { view: v, shown } = await rulesView(p, litterDir, blankRulesNav('proposed'))
    expect(v.tab).toBe('proposed')
    expect(v.body!.title).toEqual([{ text: 'litter · rules', bold: true }, { text: ' · Proposed' }])
    // The dismissed one isn't there; the store is asked for the proposed ones.
    expect(rowsOf(v).map(r => r.key)).toEqual(['repo:3', 'repo:4', 'repo:5', 'repo:10', 'repo:11', 'repo:12', 'P-hand', 'U-new'])
    expect(called('proposalsOf')).toEqual([[{ status: ['proposed'] }]])
    expect(v.body!.counts).toEqual({ proposed: 8, inForce: 5 })
    // loadRules' problems are the In force tab's.
    expect(v.body!.problems).toEqual([])

    const user = row(v, 'repo:3')
    expect(user).toEqual(expect.objectContaining({ kind: 'proposal', id: null, scope: 'user', type: 'rule', when: 'committing', rule: 'Prefer small commits', paths: [], diff: null }))
    expect(user.status).toEqual({ text: 'proposed', color: 'permission', glyph: '⚑' })
    expect(user.notes).toEqual(['drafted from your words (/litter:rules add)', 'its id is assigned when you accept it'])
    expect(user.actions).toEqual(['accept', 'edit', 'dismiss'])
    expect(row(v, 'repo:4').paths).toEqual(['src/parser/**'])

    const edit = row(v, 'repo:5')
    expect(edit.scope).toBeNull()
    expect(edit.notes).toEqual(['proposed by a gate critic in run 20261003-api at G2', 'an edit of P-tests-first@2', 'its id is assigned when you accept it'])
    expect(edit.diff).toEqual(
      expect.arrayContaining([
        { text: '− Write the test first.', color: 'diffRemovedWord' },
        { text: '+ Write the failing test first.', color: 'diffAddedWord' },
        { text: '  type: rule', dim: true },
      ]),
    )

    // An import is a ban unless it says otherwise (16.8).
    expect(row(v, 'repo:11')).toEqual(expect.objectContaining({ type: 'ban', scope: null, source: 'import' }))
    expect(row(v, 'repo:11').notes.slice(0, 2)).toEqual(['from deepwork instance old-plan', 'from an archived instance'])
    // Out of a focused batch, an import row has no check.
    expect(row(v, 'repo:10').checked).toBeUndefined()

    const hand = row(v, 'P-hand')
    expect(hand.status).toEqual({ text: 'unverified', color: 'warning', glyph: '!' })
    expect(hand.notes).toEqual(['a hand edit', 'P-hand@1 stays in force until you accept this', `file ${rulesPath('P-hand')}`])
    expect(hand.diff).toEqual(expect.arrayContaining([{ text: '+ Changed by hand.', color: 'diffAddedWord' }]))
    expect(hand.actions).toEqual(['accept'])
    expect(row(v, 'U-new').notes[1]).toBe('nothing of it is in force')

    // What each row showed, for the presses.
    expect(Object.keys(shown)).toEqual(rowsOf(v).map(r => r.key))
    expect(shown['repo:4']).toEqual({ kind: 'proposal', ref: { store: 'repo', seq: 4 }, file: null, id: null, version: null, scope: 'project', type: 'rule', paths: ['src/parser/**'], source: 'user', batch: null, actions: ['accept', 'edit', 'dismiss'] })
    expect(shown['P-hand']).toEqual(expect.objectContaining({ kind: 'unverified', file: rulesPath('P-hand'), id: 'P-hand', version: 1, scope: 'project' }))
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
    })
    // The batch first, by its instances' order; the rest after.
    expect(rowsOf(v).map(r => r.key)).toEqual(['repo:10', 'repo:12', 'repo:11', 'repo:3', 'repo:4', 'repo:5', 'P-hand', 'U-new'])
    expect(['repo:10', 'repo:12', 'repo:11'].map(k => row(v, k).checked)).toEqual([true, true, false])
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
    expect(v.body!.title[1]).toEqual({ text: ' · In force' })
    expect(rowsOf(v).map(r => r.key)).toEqual(['P-tests-first', 'U-theirs', 'L-mine', 'P-hand', 'P-nowhere'])
    expect(rowsOf(v).every(r => r.kind === 'accepted' && r.actions.join() === 'edit,retire')).toBe(true)

    expect(row(v, 'P-tests-first')).toEqual(expect.objectContaining({ id: 'P-tests-first', version: 2, scope: 'project', paths: ['src/**'], notes: [] }))
    expect(row(v, 'P-tests-first').status).toEqual({ text: 'accepted', color: 'success', glyph: '✓' })
    expect(row(v, 'U-theirs').notes).toEqual(['local L-mine overrides U-theirs'])
    expect(row(v, 'L-mine').notes).toEqual(['local L-mine overrides U-theirs'])
    // The hand-edited file's committed version is what's in force.
    expect(row(v, 'P-hand').status.text).toBe('accepted (committed)')
    expect(row(v, 'P-hand').rule).toBe('rule P-hand')
    expect(row(v, 'P-hand').notes).toEqual(["the file has an edit you haven't accepted: see the Proposed tab"])
    expect(row(v, 'P-nowhere').notes).toEqual([MATCHES_NO_FILE])
    expect(v.body!.problems).toEqual(['P-dup is in two scopes: project and local'])
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
})

describe('the presses reach the store once each, with what the pane showed', () => {
  test('/litter-rules opens the pane; [Accept] on a user proposal accepts it once into user scope', async () => {
    expect(await rulesCommand(p, command(), next)).toEqual({ text: 'litter: the rules pane shows 8 proposed or unverified, 5 in force' })
    expect(p.panes.opened.map(o => o.id)).toEqual(['litter-rules'])
    await pressRules(p, 'rules:accept:repo:3')
    expect(acting()).toEqual([{ fn: 'acceptRule', args: [{ proposal: { store: 'repo', seq: 3 } }, { scope: 'user' }] }])
    expect(view().body!.notice).toEqual({ level: 'ok', text: 'accepted into user scope: written to /home/you/.claude/litter/rules/user-rule.md' })
  })

  test('a project proposal: [Accept] shows the exact file, [Confirm accept] writes it, and a second confirm is ignored', async () => {
    await rulesCommand(p, command(), next)
    await pressRules(p, 'rules:accept:repo:4')
    expect(called('previewAccept')).toEqual([[{ proposal: { store: 'repo', seq: 4 } }, { scope: 'project' }]])
    expect(acting()).toEqual([])
    expect(view().body!.pending).toEqual({ kind: 'preview', key: 'repo:4', path: rulesPath('P-repo-4'), text: '---\nid: P-repo-4\n---\n\n## Rule\nParse once.\n' })
    await pressRules(p, 'rules:confirm:repo:4')
    expect(acting()).toEqual([{ fn: 'acceptRule', args: [{ proposal: { store: 'repo', seq: 4 } }, { scope: 'project' }] }])
    expect(notice()).toBe('accepted: commit .litter/rules/P-parse-once.md yourself')
    expect(view().body!.pending).toBeNull()
    await pressRules(p, 'rules:confirm:repo:4')
    expect(acting().length).toBe(1)
    expect(p.toasts.at(-1)).toBe('litter: there was no file waiting to be confirmed, so that was ignored')
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
    await pressRules(p, 'rules:accept:repo:5')
    expect(calls.filter(c => c.fn !== 'proposalsOf')).toEqual([])
    expect(view().body!.pending).toEqual({ kind: 'scope', key: 'repo:5' })
    expect(notice()).toContain('pick the scope to accept it into')
    // A scope that isn't one is ignored; a real one is held.
    await onRulesUi.select(p, { element: 'rules:scope:repo:5', value: 'everywhere' } as never, next)
    expect(rulesNavOf()!.held['repo:5']).toBeUndefined()
    expect(await onRulesUi.select(p, { element: 'rules:scope:repo:5', value: 'local' } as never, next)).toEqual({ element: 'rules:scope:repo:5', value: 'local' })
    expect(acting()).toEqual([])
    expect(view().body!.pending).toBeNull()
    expect(row(view(), 'repo:5').notes).toContain('scope local, chosen here')
    await pressRules(p, 'rules:accept:repo:5')
    expect(acting()).toEqual([{ fn: 'acceptRule', args: [{ proposal: { store: 'repo', seq: 5 } }, { scope: 'local' }] }])
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
    expect(view().body!.pending).toEqual(expect.objectContaining({ kind: 'preview', key: 'batch:9', path: `${dir}/.litter/rules/` }))
    expect(view().body!.pending?.kind === 'preview' && view().body!.pending).toEqual(expect.objectContaining({ text: expect.stringContaining(`--- ${rulesPath('P-repo-11')}`) }))

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
    expect(p.toasts.filter(t => t === "litter: that rule isn't shown any more, so it was ignored").length).toBe(3)
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
  })
})
