// Tier 2: the swarm panes (hooks/swarm/view.ts and panes.ts; WP-N): each
// view built from inputs set up here (a saved spec, a draft with edits, a
// staged proposal with a conflict, a live swarm in state.ts with bindings,
// an in-flight call, a queued message and ledger events, a recovery card, an
// unsettled report, a read-only swarm), the composer's idle-worker case, the
// stale-press check, and each handler reaching its owner through the fakes
// setOwnersForTests puts in (no other package's body runs here).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { updateSession } from '../../hooks/session'
import { swarmProposalDir } from '../../hooks/layout'
import { appendLaunchRecord } from '../../hooks/records/swarm'
import * as state from '../../hooks/swarm/state'
import type { Draft, HealthReport, LiveSwarm, NodeBinding, ProposalView, RecoveryCard, SettleProgress, SwarmSpec } from '../../hooks/swarm/types'
import type { Owners } from '../../hooks/swarm/view'
import {
  LEAD_ROW,
  ORCHESTRATOR_COLORS,
  blankNav,
  nav,
  putDraftCache,
  resetViewForTests,
  setNav,
  setOwnersForTests,
  swarmView,
  treeRows,
} from '../../hooks/swarm/view'
import {
  addChild,
  deleteRow,
  doctorCommand,
  duplicateRow,
  handle,
  moveRow,
  paneTick,
  parseKey,
  registerSwarmCommands,
  resetPanesForTests,
  stalePress,
  swarmCommand,
} from '../../hooks/swarm/panes'
import type {
  SwarmBrowserView,
  SwarmBuilderView,
  SwarmProposalView,
  SwarmRecoveryView,
  SwarmStartView,
  SwarmUnsettledView,
  SwarmViewName,
} from '../../types/index'
import { nodePorts, runAfters, scratch, type TestPorts } from './support/node-ports'

const NOW = 1_800_000_000_000
const SWARM = 'demo'
const LAUNCH = '20270115-093000'

const SPEC: SwarmSpec = {
  name: SWARM,
  goal: 'ship the parser',
  nodes: [
    { id: 'part-a', kind: 'orchestrator', task: 'split the work', spawns: { fixer: 2 } },
    { id: 'part-b', kind: 'orchestrator' },
    { id: 'fixer', kind: 'worker', model: 'sonnet', authority: { commit: true } },
  ],
}

let p: TestPorts
let litterDir: string
let cleanup: () => void
let calls: { fn: string; args: unknown[] }[]
let stored: Draft | null
let saved: { spec: SwarmSpec; revision: number; briefs: Record<string, string> } | null

/** An owner that records its call (without the ports) and answers. */
function fake<K extends keyof Owners>(fn: K, answer: (...args: any[]) => unknown): Owners[K] {
  return ((...args: unknown[]) => {
    calls.push({ fn, args: args.filter(a => a !== p) })
    return answer(...args)
  }) as unknown as Owners[K]
}

const HEALTHY: HealthReport = { rows: [{ id: 'depth', severity: 'ok', title: 'spawn depth fits', detail: '' }], errors: 0, warnings: 0, snippet: null }

function owners(over: Partial<Owners> = {}): void {
  setOwnersForTests({
    readDraft: fake('readDraft', async () => stored),
    readSaved: fake('readSaved', async () => saved),
    writeDraft: fake('writeDraft', async (_p, _l, _n, d: Draft) => {
      stored = d
    }),
    clearDraft: fake('clearDraft', async () => {
      stored = null
    }),
    listSwarms: fake('listSwarms', async () => [{ name: SWARM, goal: 'ship the parser', revision: 1, nodes: 3, live: false }]),
    listTemplates: fake('listTemplates', async () => [
      { name: 'mine', description: 'my own', scope: 'user', params: [], path: '/nowhere/mine.json' },
      {
        name: 'fan-out',
        description: 'one worker per part',
        scope: 'builtin',
        params: [
          { name: 'goal', type: 'string', description: 'what for', default: 'tidy up' },
          { name: 'parts', type: 'list', description: 'one per part' },
        ],
        path: null,
      },
    ]),
    validateSaved: fake('validateSaved', async () => ({ ok: true, errors: [], warnings: [] })),
    checkHealth: fake('checkHealth', async () => HEALTHY),
    undecidedProposals: fake('undecidedProposals', async () => []),
    resumeTargets: fake('resumeTargets', () => []),
    saveRevision: fake('saveRevision', async () => ({ ok: true, revision: 2 })),
    launchSwarm: fake('launchSwarm', async () => ({ ok: true, launch: LAUNCH })),
    recoveryCard: fake('recoveryCard', () => null),
    settleProgress: fake('settleProgress', () => null),
    summaryOf: fake('summaryOf', () => null),
    sendFromBrowser: fake('sendFromBrowser', async () => ({ kind: 'delivered' })),
    stopNode: fake('stopNode', async () => {}),
    endSwarm: fake('endSwarm', async () => {}),
    ackBranchMoved: fake('ackBranchMoved', async () => {}),
    readOwner: fake('readOwner', async () => null),
    ...over,
  })
}

const called = (fn: string) => calls.filter(c => c.fn === fn).map(c => c.args)

function live(over: Partial<LiveSwarm> = {}): LiveSwarm {
  return {
    name: SWARM,
    launch: LAUNCH,
    revision: 1,
    spec: SPEC,
    nonce: 'n0nce',
    types: { 'part-a': 'litter:sw-demo-part-a', fixer: 'litter:sw-demo-fixer' },
    typesReady: true,
    dirs: {},
    sessionCwd: '/repo',
    worktreeRoot: '/repo/.claude/worktrees',
    commonDir: '/repo/.git',
    roots: { litterDir, litterCopies: [litterDir], ruleDirs: [] },
    tips: {},
    owner: { ref: 'refs/litter-swarm/demo', oid: 'a'.repeat(40), generation: 1, session: 's1' },
    state: 'live',
    readOnly: false,
    lost: false,
    flags: { isolationLost: false },
    startedAt: NOW - 125_000,
    ...over,
  }
}

function bind(agentId: string, over: Partial<NodeBinding> = {}): NodeBinding {
  return {
    agentId,
    swarm: SWARM,
    launch: LAUNCH,
    node: 'fixer',
    n: 1,
    kind: 'worker',
    of: null,
    parent: 'o1',
    type: 'litter:sw-demo-fixer',
    cwd: '/repo',
    branch: null,
    token: `tok-${agentId}`,
    revision: 1,
    generation: 1,
    boundAt: NOW - 60_000,
    adopted: false,
    ...over,
  }
}

/** A live swarm: part-a #1 (o1, running Bash, asking), fixer #1 (w1, done, reported, a message queued). */
function goLive(over: Partial<LiveSwarm> = {}): void {
  state.putLiveSwarm(live(over))
  state.putBinding(bind('o1', { node: 'part-a', kind: 'orchestrator', parent: null, type: 'litter:sw-demo-part-a' }))
  state.putBinding(bind('w1'))
  state.markRunning('o1')
  state.callStart('o1', 'tu1', 'Bash', NOW - 5_000)
  state.noteQuestion('o1', 'which branch do I base on?', NOW - 3_000)
  state.noteReport('w1', 'fixed the tokenizer\nand more', 'handback', NOW - 10_000)
  state.enqueue({ swarm: SWARM, agentId: 'w1', node: 'fixer', text: 'also check the lexer', from: 'user', at: NOW - 1_000 })
  state.addTokens('o1', { input_tokens: 1200, output_tokens: 300 } as never)
  p.agents = [
    { id: 'o1', description: 'part-a', type: 'litter:sw-demo-part-a', status: 'running' },
    { id: 'w1', description: 'fixer', type: 'litter:sw-demo-fixer', status: 'completed' },
  ] as never
}

async function view<T>(name: SwarmViewName, patch: Partial<ReturnType<typeof blankNav>> = {}): Promise<T> {
  setNav({ ...blankNav(name, name === 'start' ? null : SWARM), ...patch })
  const v = await swarmView(p)
  return v as T
}

beforeEach(() => {
  state.resetForTests()
  resetViewForTests()
  resetPanesForTests()
  p = nodePorts({ sessionId: 's1' })
  p.clock.now = NOW
  ;({ dir: litterDir, cleanup } = scratch())
  updateSession({ litterDir, litterDirError: null })
  calls = []
  stored = null
  saved = { spec: SPEC, revision: 1, briefs: {} }
  owners()
})

afterEach(() => {
  updateSession({ litterDir: null })
  setOwnersForTests({})
  state.resetForTests()
  cleanup()
})

describe('the start screen', () => {
  test('templates by name with their scope, and the saved swarms; a picked template shows its parameters', async () => {
    const v = await view<SwarmStartView>('start')
    expect(v.view).toBe('start')
    expect(v.blocked).toBeNull()
    expect(v.templates.map(t => t.id)).toEqual(['user:mine', 'builtin:fan-out'])
    expect(v.swarms).toEqual([{ name: SWARM, goal: 'ship the parser', revision: 1, nodes: 3, live: false }])
    const picked = await view<SwarmStartView>('start', { template: 'builtin:fan-out' })
    expect(picked.template?.params.map(x => [x.name, x.list, x.value])).toEqual([
      ['goal', false, 'tidy up'],
      ['parts', true, ''],
    ])
  })

  test('with no litter directory nothing acts, and says why', async () => {
    updateSession({ litterDir: null, litterDirError: 'not a git repository' })
    const v = await view<SwarmStartView>('start')
    expect(v.blocked).toContain('not a git repository')
  })

  test('[Blank] needs a fresh name, then opens its builder on a new draft', async () => {
    setNav(blankNav('start', null))
    await handle(p, 'swarm:start:name', { value: SWARM, kind: 'change' })
    await handle(p, 'swarm:start:blank', {})
    expect(nav()?.notice?.text).toContain('already')
    await handle(p, 'swarm:start:name', { value: 'fresh', kind: 'change' })
    await handle(p, 'swarm:start:blank', {})
    expect(nav()?.view).toBe('builder')
    expect(called('writeDraft').at(-1)?.[1]).toBe('fresh')
    expect((p.views.swarm as SwarmBuilderView).title.map(s => s.text).join('')).toContain('(unsaved)')
  })
})

describe('the builder', () => {
  test('a saved spec: the tree with identity colors, a worker under its parent', async () => {
    const v = await view<SwarmBuilderView>('builder')
    expect(v.view).toBe('builder')
    expect(v.unsaved).toBe(false)
    expect(v.title.map(s => s.text).join('')).toContain('rev 1')
    expect(v.tree.rows.map(r => r.id)).toEqual([LEAD_ROW, 'part-a', 'part-a/fixer', 'part-b'])
    const [, a, fixer, b] = v.tree.rows
    expect(a?.color).toBe(ORCHESTRATOR_COLORS[0])
    expect(fixer?.color).toBe(ORCHESTRATOR_COLORS[0])
    expect(fixer?.dim).toBe(true)
    expect(fixer?.label).toBe('fixer ≤2')
    expect(b?.color).toBe(ORCHESTRATOR_COLORS[1])
  })

  test("a worker's inspector: each field's badge and what unset means; the model offers your availableModels", async () => {
    p.settingsValue.availableModels = ['team-model']
    const v = await view<SwarmBuilderView>('builder', { selected: 'part-a/fixer' })
    const field = (label: string) => v.inspector.fields.find(f => f.label === label)
    expect(field('Task')).toBeUndefined()
    expect(field('Serial')?.badge).toBe('litter')
    expect(field('Model')?.options.map(o => o.value)).toEqual(['', 'inherit', 'team-model', 'sonnet'])
    expect(field('Model')?.options[0]?.label).toBe('not set')
    expect(field('Model')?.badge).toBe('engine')
    expect(field('Effort')?.note).toBe("not set: the session's")
    expect(field('Commit')?.badge).toBe('litter')
    expect(field('Commit')?.value).toBe('yes')
    expect(field('Push')?.badge).toBe('—')
    expect(field('Push')?.note).toContain('not checked by litter')
    expect(field('Reports')?.badge).toBe('prompt')
    expect(field('Spawns')?.note ?? '').toContain('may spawn no swarm types')
  })

  test('a draft with edits is unsaved, over its base revision', async () => {
    stored = { base: 1, edits: [{ path: 'nodes.fixer.model', at: NOW }], spec: { ...SPEC, goal: 'ship it faster' }, briefs: {}, updatedAt: NOW }
    const v = await view<SwarmBuilderView>('builder')
    expect(v.unsaved).toBe(true)
    expect(v.base).toBe(1)
    expect(v.title.map(s => s.text).join('')).toContain('(unsaved)')
    expect(v.inspector.fields.find(f => f.label === 'Goal')?.value).toBe('ship it faster')
  })

  test("the strip: J's errors on their nodes' rows, its health rows by severity", async () => {
    owners({
      validateSaved: fake('validateSaved', async () => ({ ok: false, errors: [{ field: 'nodes.fixer.maxTurns', node: 'fixer', error: 'too many' }], warnings: [] })),
      checkHealth: fake('checkHealth', async () => ({
        rows: [{ id: 'cap', severity: 'warning', title: 'the session cap is low', detail: 'needs 6' }],
        errors: 0,
        warnings: 1,
        snippet: null,
      })),
    })
    setNav(blankNav('builder', SWARM))
    await paneTick(p)
    const v = p.views.swarm as SwarmBuilderView
    expect(v.strip.map(r => r.glyph)).toEqual(['✕', '!'])
    expect(v.strip[0]?.text).toContain('nodes.fixer.maxTurns: too many')
    expect(v.tree.rows.find(r => r.id === 'part-a/fixer')?.mark).toBe('✕')
    expect(v.checking).toBe(false)
    const [dir, name, saved] = called('validateSaved')[0] as [string, string, { spec: SwarmSpec; briefs: Record<string, string> }]
    expect([dir, name, saved.spec.name]).toEqual([litterDir, SWARM, SWARM])
  })

  test('a field edit goes to writeDraft with its path; a value that does not parse shows why and writes nothing', async () => {
    setNav(blankNav('builder', SWARM, ))
    await handle(p, 'swarm:builder:select:demo/part-a/fixer', {})
    await handle(p, 'swarm:builder:field:demo/fixer/effort', { value: 'high' })
    const written = stored!
    expect(written.spec.nodes.find(n => n.id === 'fixer')?.effort).toBe('high')
    expect(written.edits.map(e => e.path)).toEqual(['nodes.fixer.effort'])
    const writes = called('writeDraft').length
    await handle(p, 'swarm:builder:field:demo/fixer/maxTurns', { value: 'lots', kind: 'change' })
    expect(called('writeDraft').length).toBe(writes)
    const v = (await swarmView(p)) as SwarmBuilderView
    const turns = v.inspector.fields.find(f => f.label === 'Max turns')
    expect(turns?.value).toBe('lots')
    expect(turns?.note).toContain('whole number')
    expect(turns?.noteColor).toBe('error')
    await handle(p, 'swarm:builder:field:demo/fixer/maxTurns', { value: '30', kind: 'submit' })
    expect(stored!.spec.nodes.find(n => n.id === 'fixer')?.maxTurns).toBe(30)
    expect(stored!.edits.map(e => e.path)).toEqual(['nodes.fixer.effort', 'nodes.fixer.maxTurns'])
  })

  test('the tree edits: add, duplicate with its brief and count, delete, move', () => {
    const lead = addChild(SPEC, LEAD_ROW)
    expect('spec' in lead && lead.spec.nodes.at(-1)).toEqual({ id: 'orchestrator', kind: 'orchestrator' })
    const child = addChild(SPEC, 'part-a')
    expect('spec' in child && child.spec.nodes.find(n => n.id === 'part-a')?.spawns).toEqual({ fixer: 2, worker: 1 })
    expect('select' in child && child.select).toBe('part-a/worker')
    const dup = duplicateRow(SPEC, 'part-a/fixer', '# fixer')
    if (!('spec' in dup)) throw new Error(dup.error)
    expect(dup.spec.nodes.find(n => n.id === 'part-a')?.spawns).toEqual({ fixer: 2, 'fixer-copy': 2 })
    expect(dup.briefs).toEqual({ 'fixer-copy': '# fixer' })
    expect(dup.paths).toEqual(['nodes.fixer-copy', 'nodes.part-a.spawns', 'brief:fixer-copy'])
    const del = deleteRow(SPEC, 'part-a/fixer')
    if (!('spec' in del)) throw new Error(del.error)
    expect(del.spec.nodes.map(n => n.id)).toEqual(['part-a', 'part-b'])
    expect(del.spec.nodes[0]?.spawns).toBeUndefined()
    expect(del.select).toBe('part-a')
    expect(deleteRow(SPEC, LEAD_ROW)).toEqual({ error: "the lead is this session: it can't be deleted" })
    const moved = moveRow(SPEC, 'part-b', -1)
    expect('spec' in moved && moved.spec.nodes.map(n => n.id)).toEqual(['part-b', 'part-a', 'fixer'])
    expect(treeRows(SPEC).length).toBe(4)
  })

  test('[Save] hands J the draft and the paths edited; its errors fill the strip', async () => {
    stored = { base: 1, edits: [{ path: 'goal', at: NOW }, { path: 'nodes.fixer.model', at: NOW }], spec: SPEC, briefs: { fixer: '# brief' }, updatedAt: NOW }
    setNav(blankNav('builder', SWARM))
    await handle(p, 'swarm:builder:save:demo', {})
    const [, name, savedArg, note] = called('saveRevision')[0]!
    expect(name).toBe(SWARM)
    expect(savedArg).toEqual({ spec: SPEC, briefs: { fixer: '# brief' } })
    expect(note).toEqual({ from: 'save', changes: ['goal', 'nodes.fixer.model'] })
    expect(called('clearDraft').length).toBe(1)
    expect(nav()?.notice?.text).toBe('saved revision 2')

    owners({ saveRevision: fake('saveRevision', async () => ({ ok: false, errors: [{ field: 'goal', error: 'empty' }] })) })
    stored = { base: 1, edits: [{ path: 'goal', at: NOW }], spec: SPEC, briefs: {}, updatedAt: NOW }
    await handle(p, 'swarm:builder:save:demo', {})
    expect(nav()?.notice).toEqual({ level: 'error', text: 'not saved: 1 error, first goal: empty' })
    expect((p.views.swarm as SwarmBuilderView).strip[0]).toEqual({ glyph: '✕', color: 'error', text: 'goal: empty' })
  })

  test('[Launch] refuses a draft with edits; a saved one launches and the pane follows it', async () => {
    stored = { base: 1, edits: [{ path: 'goal', at: NOW }], spec: SPEC, briefs: {}, updatedAt: NOW }
    setNav(blankNav('builder', SWARM))
    await handle(p, 'swarm:builder:launch:demo', {})
    expect(called('launchSwarm')).toEqual([])
    expect(nav()?.notice?.text).toContain('Save first')
    // Saved since (the draft cleared): the saved revision is what launches.
    stored = null
    putDraftCache(SWARM, null)
    owners({
      launchSwarm: fake('launchSwarm', async () => {
        state.putLiveSwarm(live())
        return { ok: true, launch: LAUNCH }
      }),
    })
    await handle(p, 'swarm:builder:launch:demo', {})
    expect(called('launchSwarm')).toEqual([[SWARM]])
    expect(nav()?.view).toBe('browser')
    owners({ launchSwarm: fake('launchSwarm', async () => ({ ok: false, reason: 'the doctor finds errors' })) })
    setNav(blankNav('builder', SWARM))
    await handle(p, 'swarm:builder:launch:demo', {})
    expect(nav()?.notice).toEqual({ level: 'error', text: 'not launched: the doctor finds errors' })
  })

  test("[Ask lead] hands the request to the lead from a timer callback, never the hook; the brief's fills the prompt box", async () => {
    setNav(blankNav('builder', SWARM))
    await handle(p, 'swarm:builder:ask:demo', { value: 'add a reviewer', kind: 'change' })
    await handle(p, 'swarm:builder:ask-send:demo', {})
    expect(p.submitted).toEqual([])
    expect(p.afters.length).toBe(1)
    await runAfters(p)
    expect(p.submitted.length).toBe(1)
    expect(p.submitted[0]!.startsWith('/')).toBe(false)
    expect(p.submitted[0]).toContain('litter swarm "demo"')
    expect(p.submitted[0]).toContain('add a reviewer')
    expect(p.submitted[0]).toContain('swarm_propose')
    await handle(p, 'swarm:builder:ask-brief:demo/fixer', {})
    expect(p.filled).toEqual(['/litter:swarm revise demo fixer: '])
  })
})

describe('a proposal', () => {
  const PROPOSAL: ProposalView = {
    swarm: SWARM,
    n: 1,
    baseRevision: 1,
    changes: [
      { path: 'nodes.fixer.model', node: 'fixer', kind: 'changed', before: 'sonnet', after: 'opus', reason: 'the parser is hard', conflict: true, yours: 'haiku' },
      { path: 'nodes.reviewer', node: 'reviewer', kind: 'added', after: { id: 'reviewer', kind: 'worker' }, reason: null, conflict: false },
    ],
    briefs: [{ node: 'fixer', kind: 'changed', lines: [{ op: '-', text: 'old' }, { op: '+', text: 'new' }], reason: 'clearer', conflict: false }],
    counts: { added: 1, removed: 0, changed: 1, briefs: 1, conflicts: 1 },
    decided: null,
  }

  beforeEach(() => {
    owners({
      readProposal: fake('readProposal', async () => PROPOSAL),
      acceptProposal: fake('acceptProposal', async () => ({ ok: true, revision: 2 })),
      rejectProposal: fake('rejectProposal', async () => {}),
      // The spec ledger has it undecided too: the pane seeds its list from there.
      undecidedProposals: fake('undecidedProposals', async () => [1]),
    })
    const dir = swarmProposalDir(litterDir, SWARM, 1)
    mkdirSync(dir, { recursive: true })
    const spec: SwarmSpec = {
      ...SPEC,
      nodes: [{ ...SPEC.nodes[0]!, spawns: { fixer: 2, reviewer: 1 } }, SPEC.nodes[1]!, { ...SPEC.nodes[2]!, model: 'opus' }, { id: 'reviewer', kind: 'worker' }],
    }
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec))
  })

  test('staged while the builder shows the swarm: the pane opens it, the conflict left unpicked, the rest picked', async () => {
    setNav(blankNav('builder', SWARM))
    state.noteProposal(SWARM, 1)
    await paneTick(p)
    expect(nav()?.view).toBe('proposal')
    const v = p.views.swarm as SwarmProposalView
    expect(v.view).toBe('proposal')
    expect(v.from).toBe(1)
    expect(v.to).toBe(2)
    expect(v.counts).toBe('1 added, 0 removed, 1 changed, 1 brief, 1 conflict')
    expect(v.changes.map(c => [c.glyph, c.path, c.conflict, c.picked])).toEqual([
      ['~', 'nodes.fixer.model', true, false],
      ['+', 'nodes.reviewer', false, true],
    ])
    expect(v.changes[0]?.yours).toBe('"haiku"')
    expect(v.changes[0]?.reason).toBe('the parser is hard')
    expect(v.briefs[0]).toEqual(expect.objectContaining({ node: 'fixer', glyph: '~', picked: true, open: false }))
    const marks = Object.fromEntries(v.tree.rows.map(r => [r.id, r.mark]))
    expect(marks['part-a/reviewer']).toBe('+')
    expect(marks['part-a/fixer']).toBe('!')
  })

  test("[Take the lead's] picks a conflict; [Accept selected] hands J the picked paths and briefs", async () => {
    setNav(blankNav('builder', SWARM))
    state.noteProposal(SWARM, 1)
    await paneTick(p)
    await handle(p, 'swarm:proposal:diff:demo/1/fixer', {})
    const open = p.views.swarm as SwarmProposalView
    expect(open.briefs[0]?.lines.map(l => l.text)).toEqual(['− old', '+ new'])
    await handle(p, 'swarm:proposal:take:demo/1/0', {})
    await handle(p, 'swarm:proposal:accept-selected:demo/1', {})
    expect(called('acceptProposal')).toEqual([[litterDir, SWARM, 1, ['nodes.fixer.model', 'nodes.reviewer', 'brief:fixer']]])
    expect(nav()?.view).toBe('builder')
    expect(nav()?.notice?.text).toBe('accepted 3 changes: revision 2')
  })

  test('[Reject] tells J and returns to the builder', async () => {
    state.noteProposal(SWARM, 1)
    setNav(blankNav('start', null))
    await paneTick(p)
    expect(nav()?.view).toBe('proposal')
    await handle(p, 'swarm:proposal:reject:demo/1', {})
    expect(called('rejectProposal')).toEqual([[litterDir, SWARM, 1]])
    expect(nav()?.view).toBe('builder')
    expect((p.views.swarm as SwarmBuilderView).proposals).toEqual([])
  })
})

describe('the browser', () => {
  test('a live swarm: statuses with their glyphs, the call in flight, the question, the report, the queued message, the events and the flag', async () => {
    goLive()
    owners({
      summaryOf: fake('summaryOf', () => ({ goalNow: 'parser first', progress: ['tokenizer done'], waitingOnYou: ['which branch'], at: NOW - 60_000, stale: true })),
    })
    await appendLaunchRecord(p, litterDir, SWARM, LAUNCH, 'swarm.event', { kind: 'message', from: 'user', to: 'o1', route: 'direct', delivery: 'interject', text: 'go' })
    await appendLaunchRecord(p, litterDir, SWARM, LAUNCH, 'swarm.event', { kind: 'report', node: 'fixer', agentId: 'w1', via: 'handback', text: 'fixed the tokenizer' })
    await appendLaunchRecord(p, litterDir, SWARM, LAUNCH, 'swarm.event', { kind: 'branch-moved', ref: 'refs/heads/main', from: 'a'.repeat(40), to: 'b'.repeat(40), running: ['fixer'] })
    const v = await view<SwarmBrowserView>('browser')
    expect(v.view).toBe('browser')
    expect(v.title.map(s => s.text).join('')).toContain('live 2m')
    expect(v.title.map(s => s.text).join('')).toContain('2 agents · 2k tokens')
    expect(v.rows.map(r => [r.name, r.depth, r.status, r.statusGlyph])).toEqual([
      ['lead', 0, 'idle', ''],
      ['part-a', 1, 'waiting', '⚑'],
      ['fixer', 2, 'done', '✓'],
    ])
    const [, o1, w1] = v.rows
    expect(o1?.tool).toBe('Bash')
    expect(o1?.question).toBe('which branch do I base on?')
    expect(o1?.turns).toBe(1)
    expect(w1?.report).toBe('fixed the tokenizer')
    expect(w1?.queued.map(q => q.text)).toEqual(['also check the lexer'])
    expect(w1?.color).toBe(ORCHESTRATOR_COLORS[0])
    expect(v.events.map(e => [e.who, e.text])).toEqual([
      ['you → part-a', 'direct, interject: "go"'],
      ['fixer', 'reported: "fixed the tokenizer"'],
      ['litter', '! refs/heads/main moved aaaaaaa → bbbbbbb'],
    ])
    expect(v.flags).toEqual([expect.objectContaining({ kind: 'branch-moved', running: ['fixer'] })])
    expect(v.summary).toEqual({ goal: 'parser first', progress: ['tokenizer done'], waiting: ['which branch'], age: '1m ago', stale: true })
    expect(v.composer?.to).toBe('o1')
    expect(v.composer?.routes.map(r => r.value)).toEqual(['direct', 'lead'])
  })

  test("the composer's idle-worker case: Direct reads via its parent, and Via parent is offered", async () => {
    goLive()
    const v = await view<SwarmBrowserView>('browser', { selected: 'w1' })
    expect(v.composer?.address).toBe('fixer#1')
    expect(v.composer?.routes).toEqual([
      { value: 'direct', label: "via parent (it's idle)" },
      { value: 'lead', label: 'Via lead' },
      { value: 'parent', label: 'Via parent' },
    ])
    p.agents = p.agents.map(a => (a.id === 'w1' ? { ...a, status: 'running' } : a))
    const running = await view<SwarmBrowserView>('browser', { selected: 'w1' })
    expect(running.composer?.routes[0]).toEqual({ value: 'direct', label: 'Direct' })
  })

  test('[Send] hands L the instance, the text and your When and Route (kept per swarm); a refusal offers the queue', async () => {
    goLive()
    setNav(blankNav('browser', SWARM))
    await handle(p, 'swarm:browser:to:demo', { value: 'w1' })
    await handle(p, 'swarm:browser:route:demo', { value: 'parent' })
    await handle(p, 'swarm:browser:text:demo', { value: 'look at the lexer', kind: 'change' })
    await handle(p, 'swarm:browser:send:demo/fixer#1', {})
    expect(called('sendFromBrowser')).toEqual([[{ swarm: SWARM, node: 'fixer#1', text: 'look at the lexer', when: 'interject', route: 'parent' }]])
    expect(p.storeMap.get(`litter.swarm.composer.${litterDir}.${SWARM}`)).toEqual({ when: 'interject', route: 'parent' })
    expect(nav()?.inputs['swarm:browser:text:demo']).toBeUndefined()

    owners({ sendFromBrowser: fake('sendFromBrowser', async () => ({ kind: 'refused', reason: 'it is running', canQueue: true })) })
    await handle(p, 'swarm:browser:text:demo', { value: 'again', kind: 'change' })
    await handle(p, 'swarm:browser:send:demo/fixer#1', {})
    expect(nav()?.offerQueue).toBe(true)
    expect((p.views.swarm as SwarmBrowserView).composer?.offerQueue).toBe(true)
    await handle(p, 'swarm:browser:queue-instead:demo/fixer#1', {})
    expect(called('sendFromBrowser').at(-1)).toEqual([{ swarm: SWARM, node: 'fixer#1', text: 'again', when: 'queue', route: 'parent' }])
  })

  test('[Stop node], [Hard stop], [End swarm], [That was me] and [Stop them] reach P', async () => {
    goLive()
    p.agents = p.agents.map(a => ({ ...a, status: 'running' }))
    const flag = await appendLaunchRecord(p, litterDir, SWARM, LAUNCH, 'swarm.event', {
      kind: 'branch-moved',
      ref: 'refs/heads/main',
      from: null,
      to: 'b'.repeat(40),
      running: ['fixer'],
    })
    setNav(blankNav('browser', SWARM))
    await handle(p, 'swarm:browser:stop:demo/w1', {})
    await handle(p, 'swarm:browser:hard-stop:demo/o1', {})
    await handle(p, 'swarm:browser:ack:demo/' + flag.seq, {})
    await handle(p, 'swarm:browser:stop-them:demo/' + flag.seq, {})
    await handle(p, 'swarm:browser:end:demo', {})
    expect(called('stopNode')).toEqual([
      [SWARM, 'w1', 'soft'],
      [SWARM, 'o1', 'hard'],
      [SWARM, 'w1', 'soft'],
    ])
    expect(called('ackBranchMoved')).toEqual([[SWARM, flag.seq]])
    expect(called('endSwarm')).toEqual([[SWARM, 'request']])
    expect(p.logs).toContain('swarm pane: endSwarm demo request')
  })

  test("an owner's failure shows on the pane and as a toast", async () => {
    goLive()
    owners({ stopNode: fake('stopNode', async () => Promise.reject(new Error('litter: stopNode is not built yet (WP-P)'))) })
    setNav(blankNav('browser', SWARM))
    await handle(p, 'swarm:browser:stop:demo/w1', {})
    expect(nav()?.notice?.level).toBe('error')
    expect(p.toasts.at(-1)).toContain('Stop node failed')
  })

  test('read-only: no composer, the owner, and [Take over] when K says a handover is possible', async () => {
    goLive({ readOnly: true })
    owners({
      readOwner: fake('readOwner', async () => ({
        swarm: SWARM,
        ref: 'refs/litter-swarm/demo',
        oid: 'c'.repeat(40),
        blob: { swarm: SWARM, launch: LAUNCH, session: 'other', generation: 2, host: 'box', pid: '42', acquiredAt: NOW },
        leaseAgeMs: 90_000,
        mine: false,
        canHandOver: true,
        why: null,
      })),
      handover: fake('handover', async () => ({ ok: true })),
    })
    const v = await view<SwarmBrowserView>('browser')
    expect(v.readOnly).toBe(true)
    expect(v.composer).toBeNull()
    expect(v.flags).toEqual([])
    expect(v.owner).toEqual({ text: 'owned by session other on box, its lease beaten 1m ago', canTakeOver: true, why: null })
    await handle(p, 'swarm:browser:takeover:demo', {})
    expect(called('handover')).toEqual([[litterDir, SWARM]])
  })

  test('goal history: the summaries, newest first', async () => {
    goLive()
    await appendLaunchRecord(p, litterDir, SWARM, LAUNCH, 'swarm.summary', { text: 't', goal: 'first goal', inputsHash: 'h1', usage: null })
    await appendLaunchRecord(p, litterDir, SWARM, LAUNCH, 'swarm.summary', { text: 't', goal: 'second goal', inputsHash: 'h2', usage: null })
    const v = await view<{ view: string; entries: { goal: string }[] }>('history')
    expect(v.entries.map(e => e.goal)).toEqual(['second goal', 'first goal'])
  })
})

describe('the recovery card and the unsettled report', () => {
  const CARD: RecoveryCard = {
    swarm: SWARM,
    launch: LAUNCH,
    stopping: false,
    at: NOW - 1_000,
    nodes: [
      { node: 'part-a', n: 1, agentId: 'o1', kind: 'orchestrator', state: 'settled', lastReport: null, respawnOnly: false },
      { node: 'part-b', n: 1, agentId: 'o2', kind: 'orchestrator', state: 'alive', lastReport: null, respawnOnly: false },
      { node: 'fixer', n: 1, agentId: 'w1', kind: 'worker', state: 'settled', lastReport: 'half done', respawnOnly: false },
      { node: 'fixer', n: 2, agentId: 'w2', kind: 'worker', state: 'gone', lastReport: null, respawnOnly: true },
    ],
  }

  test("K's card replaces the browser on the next tick, a row per node; [Resume all] asks K for the orchestrators it can resume that aren't running, then the card is gone", async () => {
    goLive()
    state.putBinding(bind('w2', { n: 2 }))
    let resumed = false
    owners({
      recoveryCard: fake('recoveryCard', () => (resumed ? null : CARD)),
      resumeTargets: fake('resumeTargets', (_s: LiveSwarm, node: string) => (node === 'fixer' ? [] : [bind('o1', { node, kind: 'orchestrator', parent: null })])),
      requestResume: fake('requestResume', async () => {
        resumed = true
      }),
    })
    setNav(blankNav('browser', SWARM))
    await paneTick(p)
    const v = p.views.swarm as SwarmRecoveryView
    expect(v.view).toBe('recovery')
    expect(v.rows.map(r => [r.node, r.kind, r.pickable, r.resumable, r.note])).toEqual([
      ['part-a', 'orchestrator', true, true, ''],
      ['part-b', 'orchestrator', false, true, 'still running'],
      ['fixer', 'worker', false, false, 'comes back through part-a'],
    ])
    expect(v.rows[2]?.instances.map(x => [x.name, x.state, x.glyph, x.report, x.respawnOnly])).toEqual([
      ['fixer #1', 'settled', '✓', 'half done', false],
      ['fixer #2', 'gone', '−', '', true],
    ])
    // A worker, or an orchestrator still running, isn't picked.
    await handle(p, 'swarm:recovery:pick:demo/fixer', {})
    await handle(p, 'swarm:recovery:pick:demo/part-b', {})
    expect(nav()?.recoveryPicked).toEqual([])
    await handle(p, 'swarm:recovery:resume-all:demo', {})
    expect(called('requestResume')).toEqual([[SWARM, ['part-a'], 'resume']])
    expect(nav()?.view).toBe('browser')
    await paneTick(p)
    expect(nav()?.view).toBe('browser')
  })

  test("after 2 minutes stopping, P's settle progress is reported; [Wait longer] puts it off 2 more minutes", async () => {
    goLive({ state: 'stopping' })
    const progress: SettleProgress = {
      swarm: SWARM,
      since: NOW - 130_000,
      nodes: [{ agentId: 'o1', node: 'part-a', n: 1, status: 'running' }],
      calls: [{ agentId: 'o1', node: 'part-a', tool: 'Bash', toolUseId: 'tu1', at: NOW - 95_000 }],
      shells: [{ shellId: 'sh-1', agentId: 'w1', node: 'fixer', at: NOW - 200_000 }],
      reservations: 1,
    }
    owners({ settleProgress: fake('settleProgress', () => progress) })
    setNav(blankNav('browser', SWARM))
    await paneTick(p)
    const v = p.views.swarm as SwarmUnsettledView
    expect(v.view).toBe('unsettled')
    expect(v.nodes).toEqual([{ agentId: 'o1', name: 'part-a', status: 'running' }])
    expect(v.calls).toEqual([{ name: 'part-a', tool: 'Bash', age: '1m' }])
    expect(v.shells).toEqual([{ shellId: 'sh-1', name: 'fixer', age: '3m' }])
    expect(v.reservations).toBe(1)
    await handle(p, 'swarm:unsettled:wait:demo', {})
    expect(called('endSwarm')).toEqual([[SWARM, 'wait-longer']])
    await paneTick(p)
    expect(nav()?.view).toBe('browser')
    p.clock.now = NOW + 121_000
    await paneTick(p)
    expect(nav()?.view).toBe('unsettled')
    await handle(p, 'swarm:unsettled:hard-stop:demo', {})
    await handle(p, 'swarm:unsettled:keep:demo', {})
    expect(called('stopNode')).toEqual([[SWARM, 'o1', 'hard']])
    expect(called('endSwarm').at(-1)).toEqual([SWARM, 'keep-everything'])
  })
})

describe('stale presses', () => {
  test('keys: the view, the action, and the swarm with the rest', () => {
    expect(parseKey('swarm:builder:select:demo/part-a/fixer')).toEqual({ view: 'builder', action: 'select', arg: 'demo/part-a/fixer', swarm: 'demo', rest: 'part-a/fixer' })
    expect(parseKey('swarm:start:param:goal')).toEqual({ view: 'start', action: 'param', arg: 'goal', swarm: null, rest: 'goal' })
    expect(parseKey('swarm:browser:end:demo')?.rest).toBe('')
    expect(parseKey('other:key')).toBeNull()
  })

  test('a press on another view, another swarm or another proposal is stale', () => {
    const k = parseKey('swarm:builder:save:demo')!
    expect(stalePress(blankNav('builder', SWARM), k, false)).toBeNull()
    expect(stalePress(blankNav('browser', SWARM), k, false)).toContain('the pane shows the browser now')
    expect(stalePress(blankNav('builder', 'other'), k, false)).toContain('the pane shows other now')
    expect(stalePress(null, k, false)).toBe('the swarm pane was closed')
    const prop = parseKey('swarm:proposal:reject:demo/2')!
    expect(stalePress({ ...blankNav('proposal', SWARM), proposal: 1 }, prop, false)).toBe('that was on another proposal')
    expect(stalePress(null, parseKey('swarm:doctor:recheck')!, true)).toBeNull()
  })

  test('a stale press is ignored with a toast, and the pane drawn again', async () => {
    goLive()
    setNav(blankNav('browser', SWARM))
    await handle(p, 'swarm:builder:launch:demo', {})
    expect(called('launchSwarm')).toEqual([])
    expect(p.toasts.at(-1)).toContain('so it was ignored')
    expect((p.views.swarm as SwarmBrowserView).view).toBe('browser')
  })
})

describe('the commands and the doctor', () => {
  const e = (command: string, args = '') =>
    ({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as never
  const next = (async () => ({ text: 'engine' })) as never

  test('both commands are registered at once-runnable, /litter-swarm with its hint', async () => {
    await registerSwarmCommands(p)
    expect(p.commands.map(c => [c.name, c.argumentHint ?? null, c.immediate ?? null])).toEqual([
      ['litter-swarm', '[name]', true],
      ['litter-doctor', null, true],
    ])
  })

  test('/litter-swarm: the start screen with nothing live, the browser of a live one, a builder by name; each opens the pane', async () => {
    expect(await swarmCommand(p, e('litter-swarm'), next)).toEqual({ text: 'litter: the swarm pane shows the start screen' })
    expect(p.panes.opened).toEqual([{ id: 'litter-swarm', title: 'litter swarm' }])
    expect((p.views.swarm as SwarmStartView).view).toBe('start')
    expect(await swarmCommand(p, e('litter-swarm', 'demo'), next)).toEqual({ text: 'litter: the swarm pane shows the builder for demo' })
    goLive()
    expect(await swarmCommand(p, e('litter-swarm'), next)).toEqual({ text: 'litter: the swarm pane shows demo, live' })
    expect(await swarmCommand(p, e('litter-swarm', 'Not A Name'), next)).toEqual({
      text: 'litter: "Not" isn\'t a swarm name (a-z, 0-9 and -, up to 24, not starting with -)',
    })
  })

  test("/litter-doctor checks the builder's swarm; [Copy], [Ask lead to add it] and [Test]", async () => {
    owners({
      checkHealth: fake('checkHealth', async () => ({
        rows: [
          {
            id: 'concurrent',
            severity: 'error',
            title: 'too few concurrent subagents',
            detail: 'the spec runs 6 at once',
            values: { need: 6, process: '4', sources: { user: '4' } },
          },
        ],
        errors: 1,
        warnings: 0,
        snippet: { env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '8' } },
      })),
    })
    setNav(blankNav('builder', SWARM))
    const r = await doctorCommand(p, e('litter-doctor'), next)
    expect(r).toEqual({ text: 'litter: the doctor pane checks demo: 1 error, 0 warnings' })
    expect(p.panes.opened.at(-1)).toEqual({ id: 'litter-doctor', title: 'litter doctor' })
    const body = (p.views.doctor as { body?: { rows: { glyph: string; values: string[] }[]; snippet: string | null } }).body!
    expect(body.rows[0]?.glyph).toBe('✕')
    expect(body.rows[0]?.values).toEqual(['needs 6', 'this process: 4', 'your user settings: 4'])
    expect(JSON.parse(body.snippet!)).toEqual({ env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '8' } })
    expect((called('checkHealth').at(-1)?.[0] as { spec: SwarmSpec | null }).spec?.name).toBe(SWARM)
    await handle(p, 'swarm:doctor:copy', {})
    expect(JSON.parse(p.copied[0]!)).toEqual({ env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '8' } })
    await handle(p, 'swarm:doctor:ask-lead', {})
    expect(p.filled[0]).toContain('merge these keys into the "env" object of my user settings')
    expect(p.filled[0]).toContain('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS')
    await handle(p, 'swarm:doctor:test', {})
    expect(called('checkHealth').at(-1)?.[0]).toEqual(expect.objectContaining({ testSummaryModel: true }))
  })
})
