// Tier 2: the swarm panes against what they call (FIX-S). Each finding's
// scenario through the pane functions (handle, paneTick, the commands), with
// the owners' real bodies wherever they run in tier 2: J's store and
// templates, P's ack and stop, K's resume request. Only what tier 2 can't run
// is faked: the health check, L's send, K's card and owner read.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolCallResult } from '../../hooks/ports'
import { projectTemplatesDir, swarmBriefPath, swarmProposalDir } from '../../hooks/layout'
import { appendLaunchRecord, readLaunchLedger, readSpecLedger } from '../../hooks/records/swarm'
import { updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import { readDraft, readProposal, readSaved, saveRevision, stageProposal, writeDraft } from '../../hooks/swarm/store'
import { asTemplate, loadTemplate, parameterize, templateOffers } from '../../hooks/swarm/templates'
import { requestResume } from '../../hooks/swarm/recover'
import { others as endOthers, resetEndForTests } from '../../hooks/swarm/end'
import type { HealthReport, LiveSwarm, NodeBinding, RecoveryCard, SwarmNode, SwarmSpec } from '../../hooks/swarm/types'
import type { Owners } from '../../hooks/swarm/view'
import { blankNav, changeWords, clean, composerKey, failingFirst, messageSpans, messageText, nav, resetViewForTests, setNav, setOwnersForTests, swarmView, toolLine, valueWords } from '../../hooks/swarm/view'
import { builderPrimary, startListTop, startPrimary, templateListCtx } from '../../hooks/swarm/builder'
import {
  TRANSCRIPT_INLINE_ROWS,
  TRANSCRIPT_MIN_ROWS,
  browserTranscriptTop,
  browserWheel,
  composerCaption,
  rosterActions,
  rosterDescription,
  rosterList,
  swarmKeys,
  transcriptListId,
  transcriptRows,
  transcriptWindow,
} from '../../hooks/swarm/browser'
import { doctorActions, doctorTally } from '../../hooks/swarm/doctorpane'
import { doctorCommand, handle, onUiInput, onUiPress, paneTick, resetPanesForTests, swarmCommand } from '../../hooks/swarm/panes'
import { resetHubForTests } from '../../hooks/ui/hub'
import type { WaitBudget } from '../../hooks/swarm/admit'
import type {
  DoctorPaneView,
  SwarmBrowserView,
  SwarmBuilderView,
  SwarmProposalView,
  SwarmRecoveryView,
  SwarmStartView,
} from '../../types/index'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const NOW = 1_800_000_000_000
const SWARM = 'alpha'
const LAUNCH = '20270115-093000'
const W = ['Edit', 'Write', 'NotebookEdit']
const RO = { commit: false, push: 'none', forcePush: false, rewriteHistory: false, worktreeOps: false } as const
const HEALTHY: HealthReport = { rows: [], errors: 0, warnings: 0, snippet: null }
// Built, not written: a bidi override in source reads as something else (CVE-2021-42574).
const RLO = String.fromCharCode(0x202e)
const LRI = String.fromCharCode(0x2066)
const ZWSP = String.fromCharCode(0x200b)
const BOM = String.fromCharCode(0xfeff)
const LS = String.fromCharCode(0x2028)

let p: TestPorts
let dir: string
let litterDir: string
let cleanup: () => void
let calls: { fn: string; args: unknown[] }[]

const node = (id: string, over: Partial<SwarmNode> = {}): SwarmNode => ({ id, kind: 'worker', tools: { deny: W }, authority: RO, ...over })
const lead = (id: string, over: Partial<SwarmNode> = {}): SwarmNode => node(id, { kind: 'orchestrator', worktree: 'none', ...over })

/** Revision 1: part-a (with reviewer workers) and part-c, each with a brief. */
const rev1 = (): SwarmSpec => ({
  name: SWARM,
  goal: 'Base',
  nodes: [
    lead('part-a', { brief: 'briefs/part-a.md', task: 'Review a', spawns: { reviewer: 2 } }),
    node('reviewer', { brief: 'briefs/reviewer.md' }),
    lead('part-c', { brief: 'briefs/part-c.md', task: 'Review c' }),
  ],
})
const REV1_BRIEFS = { 'part-a': 'Own branch a.\n', reviewer: 'Review what you are sent.\n', 'part-c': 'Own branch c.\n' }
const saveRev1 = () => saveRevision(p, litterDir, SWARM, { spec: rev1(), briefs: REV1_BRIEFS }, { from: 'save', changes: [] })

/** A fake owner that records its call (without the ports) and answers. */
function fake<K extends keyof Owners>(fn: K, answer: (...args: any[]) => unknown): Owners[K] {
  return ((...args: unknown[]) => {
    calls.push({ fn, args: args.filter(a => a !== p) })
    return answer(...args)
  }) as unknown as Owners[K]
}
const called = (fn: string) => calls.filter(c => c.fn === fn).map(c => c.args)

const command = (args = '') => ({ command: 'litter', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as never
const next = (async () => ({ text: 'engine' })) as never
const shown = <T>() => p.views.swarm as T

function live(over: Partial<LiveSwarm> = {}): LiveSwarm {
  return {
    name: SWARM,
    launch: LAUNCH,
    revision: 1,
    spec: rev1(),
    nonce: 'n0nce',
    types: { 'part-a': 'litter:sw-alpha-part-a', reviewer: 'litter:sw-alpha-reviewer', 'part-c': 'litter:sw-alpha-part-c' },
    typesReady: true,
    dirs: {},
    sessionCwd: dir,
    worktreeRoot: join(dir, '.claude', 'worktrees'),
    commonDir: join(dir, '.git'),
    roots: { litterDir, litterCopies: [litterDir], ruleDirs: [] },
    tips: {},
    owner: { ref: 'refs/litter-swarm/alpha', oid: 'a'.repeat(40), generation: 1, session: 's1' },
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
    node: 'reviewer',
    n: 1,
    kind: 'worker',
    of: null,
    parent: 'o1',
    type: 'litter:sw-alpha-reviewer',
    cwd: dir,
    branch: null,
    token: `tok-${agentId}`,
    revision: 1,
    generation: 1,
    boundAt: NOW - 60_000,
    adopted: false,
    ...over,
  }
}

/** part-a #1 (o1), its reviewer #1 (w1), part-c #1 (o2). */
function goLive(over: Partial<LiveSwarm> = {}): void {
  state.putLiveSwarm(live(over))
  state.putBinding(bind('o1', { node: 'part-a', kind: 'orchestrator', parent: null, type: 'litter:sw-alpha-part-a' }))
  state.putBinding(bind('w1'))
  state.putBinding(bind('o2', { node: 'part-c', kind: 'orchestrator', parent: null, type: 'litter:sw-alpha-part-c', boundAt: NOW - 50_000 }))
  p.agents = [
    { id: 'o1', description: 'part-a', type: 'litter:sw-alpha-part-a', status: 'completed' },
    { id: 'w1', description: 'reviewer', type: 'litter:sw-alpha-reviewer', status: 'completed' },
    { id: 'o2', description: 'part-c', type: 'litter:sw-alpha-part-c', status: 'completed' },
  ] as never
}

beforeEach(async () => {
  state.resetForTests()
  resetViewForTests()
  resetPanesForTests()
  resetHubForTests()
  resetEndForTests()
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ sessionId: 's1', cwd: dir })
  await scratchRepo(p, dir)
  p.clock.now = NOW
  litterDir = join(dir, '.claude', 'litter')
  updateSession({ litterDir, litterDirError: null })
  calls = []
  // The real owners, but for what tier 2 can't run.
  setOwnersForTests({ checkHealth: fake('checkHealth', async () => HEALTHY) })
})

afterEach(() => {
  updateSession({ litterDir: null })
  setOwnersForTests({})
  resetEndForTests()
  state.resetForTests()
  cleanup()
})

/** The proposal view for proposal 1, as the pane opens it when staged while the builder shows the swarm. */
async function openProposal(): Promise<SwarmProposalView> {
  setNav(blankNav('builder', SWARM))
  state.noteProposal(SWARM, 1)
  await paneTick(p)
  expect(nav()?.view).toBe('proposal')
  return shown<SwarmProposalView>()
}

describe("the pane timer's gate (phase 5b, WP-DA)", () => {
  test("while `litter` doesn't show Swarms the tick draws nothing; once it does, it draws", async () => {
    setNav(blankNav('builder', SWARM))
    let asked = 0
    await paneTick(p, async () => {
      asked++
      return false
    })
    expect(asked).toBe(1)
    expect(p.views.swarm).toBeUndefined()
    await paneTick(p, async () => true)
    expect((p.views.swarm as SwarmBuilderView).view).toBe('builder')
  })
})

describe('S1: a brief of an added or removed node goes with its node', () => {
  test('unticking the add and the removal keeps both nodes as they were, whatever their briefs showed', async () => {
    await saveRev1()
    const [a, reviewer] = rev1().nodes
    await stageProposal(p, litterDir, SWARM, {
      baseRevision: 1,
      spec: { ...rev1(), nodes: [{ ...a!, task: 'Review a, carefully' }, reviewer!, lead('part-b', { brief: 'briefs/part-b.md', task: 'Review b' })] },
      briefs: { 'part-b': 'Own branch b.\n' },
      changes: [
        { path: 'nodes.part-a.task', reason: 'clearer' },
        { path: 'nodes.part-b', reason: 'split it' },
        { path: 'nodes.part-c', reason: 'folded into b' },
      ],
    })
    const v = await openProposal()
    const briefs = Object.fromEntries(v.briefs.map(b => [b.node, b]))
    // No pick of their own: each shows its node's.
    expect(briefs['part-b']).toEqual(expect.objectContaining({ withNode: true, picked: true }))
    expect(briefs['part-c']).toEqual(expect.objectContaining({ withNode: true, picked: true }))
    const index = (path: string) => v.changes.find(c => c.path === path)!.index
    await handle(p, `swarm:proposal:pick:alpha/1/${index('nodes.part-b')}`, {})
    await handle(p, `swarm:proposal:pick:alpha/1/${index('nodes.part-c')}`, {})
    const after = shown<SwarmProposalView>()
    expect(after.briefs.map(b => [b.node, b.picked])).toEqual([
      ['part-b', false],
      ['part-c', false],
    ])
    expect(after.picked).toBe(1)
    await handle(p, 'swarm:proposal:accept-selected:alpha/1', {})
    expect(nav()?.notice?.text).toBe('accepted 1 change: revision 2')
    const saved = await readSaved(p, litterDir, SWARM)
    expect(saved?.revision).toBe(2)
    expect(saved?.spec.nodes.map(x => x.id)).toEqual(['part-a', 'reviewer', 'part-c'])
    expect(saved?.spec.nodes[0]?.task).toBe('Review a, carefully')
    expect(saved?.briefs['part-c']).toBe('Own branch c.\n')
  })
})

describe("S2: [Accept all] takes the conflicts you took the lead's side of", () => {
  test("goal: yours 'Mine', the lead's 'Lead'; [Take the lead's] then [Accept all] saves 'Lead'", async () => {
    await saveRev1()
    await writeDraft(p, litterDir, SWARM, { base: 1, edits: [{ path: 'goal', at: NOW }], spec: { ...rev1(), goal: 'Mine' }, briefs: REV1_BRIEFS, updatedAt: NOW })
    await stageProposal(p, litterDir, SWARM, { baseRevision: 1, spec: { ...rev1(), goal: 'Lead' }, briefs: {}, changes: [{ path: 'goal', reason: 'sharper' }] })
    const v = await openProposal()
    expect(v.changes).toEqual([expect.objectContaining({ path: 'goal', conflict: true, picked: false })])
    await handle(p, 'swarm:proposal:take:alpha/1/0', {})
    await handle(p, 'swarm:proposal:accept-all:alpha/1', {})
    expect((await readSaved(p, litterDir, SWARM))?.spec.goal).toBe('Lead')
  })

  test('with no conflict taken, [Accept all] still keeps your side', async () => {
    await saveRev1()
    await writeDraft(p, litterDir, SWARM, { base: 1, edits: [{ path: 'goal', at: NOW }], spec: { ...rev1(), goal: 'Mine' }, briefs: REV1_BRIEFS, updatedAt: NOW })
    const [a, ...rest] = rev1().nodes
    await stageProposal(p, litterDir, SWARM, {
      baseRevision: 1,
      spec: { ...rev1(), goal: 'Lead', nodes: [{ ...a!, task: 'Review a twice' }, ...rest] },
      briefs: {},
      changes: [
        { path: 'goal', reason: 'sharper' },
        { path: 'nodes.part-a.task', reason: 'twice' },
      ],
    })
    await openProposal()
    await handle(p, 'swarm:proposal:accept-all:alpha/1', {})
    const saved = await readSaved(p, litterDir, SWARM)
    expect(saved?.spec.goal).toBe('Mine')
    expect(saved?.spec.nodes[0]?.task).toBe('Review a twice')
  })
})

describe('S3: [Save as template] makes parameters J accepts', () => {
  test("a task and a new worktree's branch become parameters, saved and read back by J", async () => {
    const spec: SwarmSpec = {
      name: SWARM,
      goal: 'Ship it',
      nodes: [lead('part-a', { task: 'Work on part-a', worktree: { new: { from: 'main', branch: 'part-a' } } })],
    }
    await saveRevision(p, litterDir, SWARM, { spec, briefs: {} }, { from: 'save', changes: [] })
    setNav(blankNav('builder', SWARM))
    await handle(p, 'swarm:builder:save-as:alpha', {})
    const form = shown<SwarmBuilderView>().saveAs!
    expect(form.candidates.map(c => c.id)).toEqual(['name', 'goal', 'nodes.part-a.task', 'nodes.part-a.worktree.new.from', 'nodes.part-a.worktree.new.branch'])
    await handle(p, 'swarm:builder:saveas-param:alpha/nodes.part-a.task', {})
    await handle(p, 'swarm:builder:saveas-param:alpha/nodes.part-a.worktree.new.branch', {})
    await handle(p, 'swarm:builder:saveas-scope:alpha', { value: 'project' })
    await handle(p, 'swarm:builder:saveas-name:alpha', { value: 'per-part', kind: 'change' })
    await handle(p, 'swarm:builder:saveas-save:alpha', {})
    expect(nav()?.notice?.level).toBe('ok')
    const t = await loadTemplate(p, litterDir, 'project', 'per-part')
    expect(t?.params.map(x => [x.name, x.default])).toEqual([
      ['part_a_task', 'Work on part-a'],
      ['part_a_branch', 'part-a'],
    ])
    expect(t?.spec.nodes[0]?.task).toBe('{part_a_task}')
  })

  test("a long node id's parameter names still fit J's 32 characters", () => {
    const id = 'orchestrator-for-the-backend-api'
    const spec: SwarmSpec = { name: SWARM, goal: 'g', nodes: [lead(id, { task: 't', worktree: { new: { from: 'main', branch: 'b' } } })] }
    const offers = templateOffers(spec)
    const t = parameterize({ name: 'long', description: 'd', scope: 'user' }, spec, {}, offers)
    const { scope: _scope, ...file } = t
    expect(asTemplate(file, 'user')).toEqual(expect.objectContaining({ name: 'long' }))
    expect(new Set(offers.map(o => o.param)).size).toBe(offers.length)
  })

  test('[Use template] reads a project template through J', async () => {
    mkdirSync(projectTemplatesDir(litterDir), { recursive: true })
    const file = {
      name: 'mine',
      description: 'one orchestrator',
      params: [{ name: 'name', type: 'string' }],
      spec: { name: '{name}', goal: 'do it', nodes: [lead('solo', { task: 'do it' })] },
      briefs: {},
    }
    writeFileSync(join(projectTemplatesDir(litterDir), 'mine.json'), JSON.stringify(file))
    setNav(blankNav('start', null))
    await handle(p, 'swarm:start:name', { value: 'fresh', kind: 'change' })
    await handle(p, 'swarm:start:template', { value: 'project:mine' })
    await handle(p, 'swarm:start:use-template', {})
    expect(nav()?.view).toBe('builder')
    expect((await readDraft(p, litterDir, 'fresh'))?.spec.nodes.map(x => x.id)).toEqual(['solo'])
  })
})

describe('S4: [That was me] on a rule-commit flag', () => {
  test('records the ack, and the flag clears', async () => {
    goLive()
    const flag = await appendLaunchRecord(p, litterDir, SWARM, LAUNCH, 'swarm.event', {
      kind: 'rule-commit',
      node: 'part-a',
      agentId: 'o1',
      from: 'a'.repeat(40),
      to: 'b'.repeat(40),
      files: ['.claude/rules/x.md'],
    })
    setNav(blankNav('browser', SWARM))
    await paneTick(p)
    expect(shown<SwarmBrowserView>().flags.map(f => [f.kind, f.seq])).toEqual([['rule-commit', flag.seq]])
    await handle(p, `swarm:browser:ack:alpha/${flag.seq}`, {})
    expect(nav()?.notice?.level).not.toBe('error')
    expect(shown<SwarmBrowserView>().flags).toEqual([])
    const { records } = await readLaunchLedger(p, litterDir, SWARM, LAUNCH)
    expect(records.filter(r => r.kind === 'swarm.event' && r.body.kind === 'branch-moved-ack').map(r => r.body)).toEqual([{ kind: 'branch-moved-ack', seq: flag.seq }])
  })
})

describe('S5, S6: the recovery card offers orchestrators K can act on, and stays for what is left', () => {
  const CARD: RecoveryCard = {
    swarm: SWARM,
    launch: LAUNCH,
    stopping: false,
    at: NOW - 1_000,
    nodes: [
      { node: 'part-a', n: 1, agentId: 'o1', kind: 'orchestrator', state: 'settled', lastReport: 'half done', respawnOnly: false },
      { node: 'reviewer', n: 1, agentId: 'w1', kind: 'worker', state: 'settled', lastReport: null, respawnOnly: false },
      { node: 'part-c', n: 1, agentId: 'o2', kind: 'orchestrator', state: 'settled', lastReport: null, respawnOnly: false },
    ],
  }
  /** K's card, less the nodes K's requestResume marked handled (as recoveryCard does). */
  let handled: Set<string>
  const ownersWith = (card: RecoveryCard) => {
    handled = new Set()
    setOwnersForTests({
      checkHealth: fake('checkHealth', async () => HEALTHY),
      recoveryCard: fake('recoveryCard', () => ({ ...card, nodes: card.nodes.filter(x => !handled.has(x.node)) })),
      requestResume: fake('requestResume', async (_p, name: string, nodes: string[], how: 'resume' | 'respawn') => {
        await requestResume(p, name, nodes, how)
        for (const x of nodes) handled.add(x)
      }),
      readOwner: fake('readOwner', async () => null),
    })
  }

  test('[Resume all] asks for the orchestrators with an instance to resume: no worker, no stopped one', async () => {
    goLive()
    state.stop(SWARM, ['o2'], 'stopped from the swarm browser')
    ownersWith(CARD)
    setNav(blankNav('browser', SWARM))
    await paneTick(p)
    const v = shown<SwarmRecoveryView>()
    expect(v.view).toBe('recovery')
    expect(v.rows.map(r => [r.node, r.kind, r.pickable, r.resumable])).toEqual([
      ['part-a', 'orchestrator', true, true],
      ['part-c', 'orchestrator', true, false],
      ['reviewer', 'worker', false, false],
    ])
    expect(v.rows[2]?.instances.map(x => x.name)).toEqual(['reviewer #1'])
    await handle(p, 'swarm:recovery:resume-all:alpha', {})
    expect(called('requestResume')).toEqual([[SWARM, ['part-a'], 'resume']])
    expect(p.filled.at(-1)).toContain('/litter:swarm resume alpha part-a')
  })

  test('[Re-spawn …] after a handover offers the orchestrators only, and K takes it', async () => {
    goLive()
    const card: RecoveryCard = { ...CARD, nodes: CARD.nodes.map(x => ({ ...x, respawnOnly: true })) }
    state.patchLiveSwarm(SWARM, { owner: { ...live().owner, generation: 2 } })
    ownersWith(card)
    setNav(blankNav('browser', SWARM))
    await paneTick(p)
    await handle(p, 'swarm:recovery:respawn:alpha', {})
    expect(called('requestResume')).toEqual([[SWARM, ['part-a', 'part-c'], 'respawn']])
    expect(nav()?.notice?.level).toBe('ok')
  })

  test('a resume of one orchestrator leaves the card showing the other; its worker goes with it', async () => {
    goLive()
    ownersWith(CARD)
    setNav(blankNav('browser', SWARM))
    await paneTick(p)
    await handle(p, 'swarm:recovery:pick:alpha/part-a', {})
    await handle(p, 'swarm:recovery:resume-selected:alpha', {})
    expect(called('requestResume')).toEqual([[SWARM, ['part-a'], 'resume']])
    expect(nav()?.view).toBe('recovery')
    await paneTick(p)
    const v = shown<SwarmRecoveryView>()
    expect(v.view).toBe('recovery')
    expect(v.rows.map(r => r.node)).toEqual(['part-c'])
    await handle(p, 'swarm:recovery:resume-all:alpha', {})
    expect(called('requestResume').at(-1)).toEqual([SWARM, ['part-c'], 'resume'])
    expect(nav()?.view).toBe('browser')
  })
})

describe('S7: one To and one Route for the drawing and [Send]', () => {
  test('⏎ sends to the To the composer shows, by the Route it shows', async () => {
    goLive()
    p.storeMap.set(composerKey(litterDir, SWARM), { when: 'interject', route: 'parent' })
    setOwnersForTests({
      checkHealth: fake('checkHealth', async () => HEALTHY),
      readOwner: fake('readOwner', async () => null),
      sendFromBrowser: fake('sendFromBrowser', async () => ({ kind: 'delivered' })),
    })
    setNav(blankNav('browser', SWARM))
    await paneTick(p)
    const c = shown<SwarmBrowserView>().composer!
    expect([c.to, c.address, c.route]).toEqual(['o1', 'part-a#1', 'direct'])
    await handle(p, 'swarm:browser:text:alpha', { value: 'go on', kind: 'change' })
    await handle(p, 'swarm:browser:text:alpha', { value: 'go on', kind: 'submit' })
    expect(called('sendFromBrowser')).toEqual([[{ swarm: SWARM, node: 'part-a#1', text: 'go on', when: 'interject', route: 'direct' }]])
  })
})

describe("FIX-T 1: the browser's send keeps to its dispatch's budget", () => {
  /** The engine's `next`, its `budget` read fresh on each access: `left` ms when made, spent by the fake clock. */
  function metered(left: number): never {
    const start = p.clock.now!
    const n = async () => ({})
    Object.defineProperty(n, 'budget', { get: () => Object.freeze({ ms: 10_000, remainingMs: Math.max(0, left - (p.clock.now! - start)) }) })
    return n as never
  }

  test("⏎ and [Send] hand L's sendFromBrowser what their hook has left, less the margin", async () => {
    goLive()
    const left: number[] = []
    setOwnersForTests({
      checkHealth: fake('checkHealth', async () => HEALTHY),
      readOwner: fake('readOwner', async () => null),
      sendFromBrowser: (async (_p: unknown, _input: unknown, budget?: WaitBudget) => {
        left.push(budget ? await budget.left() : -1)
        return { kind: 'delivered' }
      }) as never,
    })
    setNav(blankNav('browser', SWARM))
    await paneTick(p)
    // A slow /clear rebind spent 8.9 s of the ⏎'s 10 s: 1.1 s left, of which 500 ms is kept back.
    await onUiInput(p, { element: 'swarm:browser:text:alpha', value: 'go on', kind: 'change' } as never, metered(10_000))
    await onUiInput(p, { element: 'swarm:browser:text:alpha', value: 'go on', kind: 'submit' } as never, metered(1_100))
    await onUiInput(p, { element: 'swarm:browser:text:alpha', value: 'and this', kind: 'change' } as never, metered(10_000))
    await onUiPress(p, { element: 'swarm:browser:send:alpha/part-a#1' } as never, metered(2_000))
    expect(left).toEqual([600, 1_500])
  })
})

describe('S8: [Hard stop] on the unsettled report reaches an agent no binding knows', () => {
  test('TaskStop for it, on the stopped list, recorded as a stop', async () => {
    goLive({ state: 'stopping' })
    p.agents = [...p.agents, { id: 'ag-x', description: 'part-a', type: 'litter:sw-alpha-part-a', status: 'running' }] as never
    p.toolAnswer = () => ({ result: { message: 'ok' }, text: 'ok' }) as unknown as ToolCallResult
    const saved = { ...endOthers }
    endOthers.patchNodePolicies = async () => {}
    // K's ref check before the stop's record (FIX-T): there's no real ref here, and this session owns the swarm.
    Object.assign(endOthers, { confirmOwnership: async () => ({ launch: LAUNCH, generation: 1, oids: ['a'.repeat(40)] }) })
    try {
      setOwnersForTests({
        checkHealth: fake('checkHealth', async () => HEALTHY),
        readOwner: fake('readOwner', async () => null),
        settleProgress: fake('settleProgress', () => ({
          swarm: SWARM,
          since: NOW - 130_000,
          nodes: [{ agentId: 'ag-x', node: 'part-a', n: 0, status: 'running, not bound' }],
          calls: [],
          shells: [],
          reservations: 0,
        })),
      })
      setNav(blankNav('unsettled', SWARM))
      await handle(p, 'swarm:unsettled:hard-stop:alpha', {})
      expect(p.toolCalls).toEqual([{ tool: 'TaskStop', input: { task_id: 'ag-x' } }])
      expect(state.isStopped('ag-x')).toBe(true)
      const { records } = await readLaunchLedger(p, litterDir, SWARM, LAUNCH)
      expect(records.filter(r => r.kind === 'swarm.stop').map(r => r.body)).toEqual([{ nodes: ['ag-x'], how: 'hard' }])
      expect(nav()?.notice?.level).not.toBe('error')
    } finally {
      Object.assign(endOthers, saved)
    }
  })
})

describe('S9: the read-only browser shows the last recorded summary', () => {
  test("from the launch ledger's swarm.summary, with its age", async () => {
    goLive({ readOnly: true })
    setOwnersForTests({ checkHealth: fake('checkHealth', async () => HEALTHY), readOwner: fake('readOwner', async () => null) })
    p.clock.now = NOW - 60_000
    await appendLaunchRecord(p, litterDir, SWARM, LAUNCH, 'swarm.summary', {
      text: 'Goal now: parser first\nProgress:\n- tokenizer done\nWaiting on you:\n- which branch',
      goal: 'parser first',
      inputsHash: 'h1',
      usage: null,
    })
    p.clock.now = NOW
    setNav(blankNav('browser', SWARM))
    const v = (await swarmView(p)) as SwarmBrowserView
    expect(v.summary).toEqual({ goal: 'parser first', progress: ['tokenizer done'], waiting: ['which branch'], age: '1m ago', stale: false })
  })
})

describe('S10: a template whose parameters fall short makes no draft', () => {
  test('the errors stay on the start screen until a parameter changes; the Name fills its name', async () => {
    setNav(blankNav('start', null))
    await handle(p, 'swarm:start:name', { value: 'fresh', kind: 'change' })
    await handle(p, 'swarm:start:template', { value: 'builtin:research-fan-out' })
    const form = shown<SwarmStartView>().template!
    expect(form.params.map(x => x.name)).toEqual(['goal'])
    await handle(p, 'swarm:start:use-template', {})
    expect(nav()?.view).toBe('start')
    expect(await readDraft(p, litterDir, 'fresh')).toBeNull()
    expect(shown<SwarmStartView>().template?.errors).toEqual([expect.stringContaining('params.goal')])
    await paneTick(p)
    p.clock.now = NOW + 5_000
    await paneTick(p)
    expect(shown<SwarmStartView>().template?.errors.length).toBe(1)
    await handle(p, 'swarm:start:param:goal', { value: 'find the slow queries', kind: 'change' })
    expect(shown<SwarmStartView>().template?.errors).toEqual([])
    await handle(p, 'swarm:start:use-template', {})
    expect(nav()?.view).toBe('builder')
    const draft = await readDraft(p, litterDir, 'fresh')
    expect(draft?.spec.name).toBe('fresh')
    expect(draft?.spec.goal).toBe('find the slow queries')
  })
})

describe("S11: a proposal J can't read can still be rejected", () => {
  test('the builder shows why, with [Reject]; J records the decision', async () => {
    await saveRev1()
    await stageProposal(p, litterDir, SWARM, { baseRevision: 1, spec: rev1(), briefs: { 'part-a': 'Own a, the lead says.\n' }, changes: [{ path: 'brief:part-a', reason: 'x' }] })
    writeFileSync(join(swarmProposalDir(litterDir, SWARM, 1), 'briefs', 'part-a.md'), 'tampered\n')
    await expect(readProposal(p, litterDir, SWARM, 1)).rejects.toThrow('sha256 differs')
    setNav(blankNav('builder', SWARM))
    state.noteProposal(SWARM, 1)
    await paneTick(p)
    const v = shown<SwarmBuilderView>()
    expect(v.view).toBe('builder')
    expect(v.unreadable).toEqual([{ n: 1, error: expect.stringContaining('sha256 differs') }])
    await handle(p, 'swarm:builder:reject:alpha/1', {})
    const decided = (await readSpecLedger(p, litterDir, SWARM)).records.filter(r => r.kind === 'swarm.proposal.decided').map(r => r.body)
    expect(decided).toEqual([{ proposal: 1, accepted: 'none' }])
    expect(shown<SwarmBuilderView>().unreadable).toEqual([])
    expect(shown<SwarmBuilderView>().proposals).toEqual([])
  })
})

describe('S12: a brief conflict shows both sides', () => {
  test("the lead's diff and yours, with [Keep yours] and [Take the lead's]", async () => {
    await saveRev1()
    await writeDraft(p, litterDir, SWARM, {
      base: 1,
      edits: [{ path: 'brief:part-a', at: NOW }],
      spec: rev1(),
      briefs: { ...REV1_BRIEFS, 'part-a': 'Own branch a, mine.\n' },
      updatedAt: NOW,
    })
    await stageProposal(p, litterDir, SWARM, { baseRevision: 1, spec: rev1(), briefs: { 'part-a': 'Own branch a, the lead.\n' }, changes: [{ path: 'brief:part-a', reason: 'x' }] })
    const pv = await readProposal(p, litterDir, SWARM, 1)
    expect(pv?.briefs[0]).toEqual(
      expect.objectContaining({
        conflict: true,
        lines: [{ op: '+', text: 'Own branch a, the lead.' }, { op: '-', text: 'Own branch a.' }],
        yoursLines: [{ op: '+', text: 'Own branch a, mine.' }, { op: '-', text: 'Own branch a.' }],
      }),
    )
    await openProposal()
    await handle(p, 'swarm:proposal:diff:alpha/1/part-a', {})
    const b = shown<SwarmProposalView>().briefs[0]!
    expect(b.picked).toBe(false)
    expect(b.lines.map(l => l.text)).toEqual(['+ Own branch a, the lead.', '− Own branch a.'])
    expect(b.yoursLines.map(l => l.text)).toEqual(['+ Own branch a, mine.', '− Own branch a.'])
    await handle(p, 'swarm:proposal:take-brief:alpha/1/part-a', {})
    expect(shown<SwarmProposalView>().briefs[0]?.picked).toBe(true)
    await handle(p, 'swarm:proposal:accept-selected:alpha/1', {})
    expect((await readSaved(p, litterDir, SWARM))?.briefs['part-a']).toBe('Own branch a, the lead.\n')
  })
})

describe('S13: [Test] runs once per press', () => {
  test('[Copy] after [Test] checks again without the summaryModel test, and keeps its row', async () => {
    setOwnersForTests({
      checkHealth: fake('checkHealth', async (_p, input: { testSummaryModel?: boolean }) => ({
        rows: [
          { id: 'depth', severity: 'ok', title: 'depth fits', detail: '' },
          ...(input.testSummaryModel ? [{ id: 'summary-model', severity: 'ok' as const, title: 'summaryModel answers', detail: '' }] : []),
        ],
        errors: 0,
        warnings: 0,
        snippet: { env: { X: '1' } },
      })),
    })
    await doctorCommand(p, { command: 'litter', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never, next)
    await handle(p, 'swarm:doctor:test', {})
    const tests = () => called('checkHealth').filter(a => (a[0] as { testSummaryModel?: boolean }).testSummaryModel === true).length
    expect(tests()).toBe(1)
    await handle(p, 'swarm:doctor:copy', {})
    await handle(p, 'swarm:doctor:ask-lead', {})
    expect(tests()).toBe(1)
    const body = (p.views.doctor as DoctorPaneView).body!
    expect(body.tested).toBe(true)
    expect(body.rows.map(r => r.id)).toEqual(['depth', 'summary-model'])
    await handle(p, 'swarm:doctor:test', {})
    expect(tests()).toBe(2)
  })
})

describe('S14: undecided proposals come back from the spec ledger', () => {
  test('/litter swarms <name> opens one staged before a reload', async () => {
    await saveRev1()
    await stageProposal(p, litterDir, SWARM, { baseRevision: 1, spec: { ...rev1(), goal: 'Lead' }, briefs: {}, changes: [{ path: 'goal', reason: 'x' }] })
    // A reload: nothing in module memory, nothing in state's queue.
    state.takeProposals()
    resetViewForTests()
    setOwnersForTests({ checkHealth: fake('checkHealth', async () => HEALTHY) })
    expect(await swarmCommand(p, command(SWARM), next)).toEqual({ text: "Swarms shows the lead's proposal 1 for alpha" })
    expect(shown<SwarmProposalView>().view).toBe('proposal')
  })
})

describe('S15: external text is cleaned, every label too, and brief links are text', () => {
  test('bidi overrides and zero-widths go, as controls do', () => {
    expect(clean('a' + RLO + 'b' + ZWSP + 'c' + LRI + 'd' + BOM + 'e\u0007f')).toBe('abcdef')
    expect(clean('a\u001b[31mb')).toBe('ab')
    expect(clean('one' + LS + 'two')).toBe('one\ntwo')
  })

  test("a report's bidi override never reaches the browser", async () => {
    goLive()
    state.noteReport('w1', 'fixed ' + RLO + 'it' + ZWSP,'handback', NOW - 1_000)
    setOwnersForTests({ checkHealth: fake('checkHealth', async () => HEALTHY), readOwner: fake('readOwner', async () => null) })
    const v = (await (async () => {
      setNav(blankNav('browser', SWARM))
      return swarmView(p)
    })()) as SwarmBrowserView
    expect(v.rows.find(r => r.agentId === 'w1')?.report).toBe('fixed it')
  })

  test("the model option, the spawn picks and the tree's workers are cleaned", async () => {
    const spec: SwarmSpec = {
      name: SWARM,
      goal: 'g',
      nodes: [lead('part-a', { model: 'evil' + RLO + 'model', spawns: {} }), node('rev' + RLO + 'iewer')],
    }
    await writeDraft(p, litterDir, SWARM, { base: 0, edits: [], spec, briefs: {}, updatedAt: NOW })
    setNav({ ...blankNav('builder', SWARM), selected: 'part-a' })
    const v = (await swarmView(p)) as SwarmBuilderView
    const labels = v.inspector.fields.flatMap(f => [f.label, ...f.options.map(o => o.label)])
    expect(labels.some(l => l.includes(RLO))).toBe(false)
    expect(labels).toContain('evilmodel')
    expect(labels).toContain('reviewer')
    expect(v.tree.workers).toEqual(['reviewer'])
  })

  test('a brief draws its links as text naming the target', async () => {
    await saveRevision(
      p,
      litterDir,
      SWARM,
      {
        spec: { name: SWARM, goal: 'g', nodes: [lead('part-a', { brief: 'briefs/part-a.md' })] },
        briefs: {
          'part-a':
            // The panel shows the first 8 lines.
            'See [the docs](https://evil.example/x), <https://auto.example/>, ![img](file:///etc/passwd) and https://bare.example/y.\n\n' +
            '[ref]: https://ref.example/\n\n' +
            'A [[nested] link](https://nest.example/) and `[code](https://code.example/)` as written.\n' +
            '```\n[fenced](https://fence.example/)\n```\n',
        },
      },
      { from: 'save', changes: [] },
    )
    setNav({ ...blankNav('builder', SWARM), selected: 'part-a' })
    const md = ((await swarmView(p)) as SwarmBuilderView).brief!.markdown
    const prose = md.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '')
    expect(prose).not.toMatch(/\]\(/)
    expect(prose).not.toMatch(/<https?:/)
    expect(prose).not.toMatch(/https?:/)
    expect(md).toContain('the docs (`https://evil.example/x`)')
    expect(md).toContain('`https://auto.example/`')
    expect(md).toContain('img (`file:///etc/passwd`)')
    expect(md).toContain('`https://bare.example/y`.')
    expect(md).toContain('`https://nest.example/`')
    expect(md).toContain('`[code](https://code.example/)`')
    expect(md).toContain('```\n[fenced](https://fence.example/)\n```')
    expect(md).not.toMatch(/^\[ref\]:/m)
    expect(md).toContain('`https://ref.example/`')
  })
})

describe('S16: the strip checks what [Save] saves', () => {
  test("a draft without a node's brief text fails the strip, as it fails [Save]", async () => {
    await saveRevision(p, litterDir, SWARM, { spec: { name: SWARM, goal: 'g', nodes: [lead('part-a', { brief: 'briefs/part-a.md' })] }, briefs: { 'part-a': 'Own it.\n' } }, { from: 'save', changes: [] })
    expect(readFileSync(swarmBriefPath(litterDir, SWARM, 'part-a'), 'utf8')).toBe('Own it.\n')
    // A draft that holds no text for part-a's brief: the saved file isn't what [Save] sends.
    await writeDraft(p, litterDir, SWARM, { base: 1, edits: [{ path: 'goal', at: NOW }], spec: { name: SWARM, goal: 'g2', nodes: [lead('part-a', { brief: 'briefs/part-a.md' })] }, briefs: {}, updatedAt: NOW })
    setNav(blankNav('builder', SWARM))
    await paneTick(p)
    const strip = shown<SwarmBuilderView>().strip
    expect(strip.some(r => r.glyph === '✕' && r.text.includes('nodes.part-a.brief'))).toBe(true)
    await handle(p, 'swarm:builder:save:alpha', {})
    expect(nav()?.notice?.text).toContain('nodes.part-a.brief')
  })
})

// ---------------------------------------------------------------------------
// Phase 5b (WP-DD): what the views now hold, and the bodies' pure rules

describe('WP-DD: a proposal reads in words first', () => {
  test('an added node, a removed one and a changed field, each in words; the raw path kept for [Technical diff]', async () => {
    await saveRev1()
    const [a, reviewer] = rev1().nodes
    await stageProposal(p, litterDir, SWARM, {
      baseRevision: 1,
      spec: { ...rev1(), nodes: [{ ...a!, task: 'Review a, carefully' }, reviewer!, lead('part-b', { brief: 'briefs/part-b.md', task: 'Review b', spawns: { reviewer: 2 }, model: 'opus' })] },
      briefs: { 'part-b': 'Own branch b.\n' },
      changes: [
        { path: 'nodes.part-a.task', reason: 'clearer' },
        { path: 'nodes.part-b', reason: 'split it' },
        { path: 'nodes.part-c', reason: 'folded into b' },
      ],
    })
    const v = await openProposal()
    const words = Object.fromEntries(v.changes.map(c => [c.path, c.words]))
    expect(words['nodes.part-a.task']).toBe('Change part-a · task · Review a → Review a, carefully')
    expect(words['nodes.part-b']).toBe('Add part-b · orchestrator · delegates to reviewer ≤2 · opus')
    expect(words['nodes.part-c']).toBe('Remove part-c · orchestrator')
    expect(v.technical).toBe(false)
    expect(v.title.map(s => s.text).join('')).toBe("alpha · the lead's proposal 1 · rev 1 → 2")
    // [Technical diff] opens through the proposal's diff press, as a brief's does.
    await handle(p, 'swarm:proposal:diff:alpha/1/#technical', {})
    expect(shown<SwarmProposalView>().technical).toBe(true)
    await handle(p, 'swarm:proposal:diff:alpha/1/part-b', {})
    expect(shown<SwarmProposalView>().technical).toBe(false)
  })

  test('a conflict carries your value in words beside the JSON', async () => {
    await saveRev1()
    await writeDraft(p, litterDir, SWARM, { base: 1, edits: [{ path: 'goal', at: NOW }], spec: { ...rev1(), goal: 'Mine' }, briefs: REV1_BRIEFS, updatedAt: NOW })
    await stageProposal(p, litterDir, SWARM, { baseRevision: 1, spec: { ...rev1(), goal: 'Lead' }, briefs: {}, changes: [{ path: 'goal', reason: 'sharper' }] })
    const v = await openProposal()
    expect(v.changes[0]).toEqual(expect.objectContaining({ words: 'Change the goal · Base → Lead', yours: '"Mine"', yoursWords: 'Mine', conflict: true }))
  })

  test('changeWords and valueWords: delegations, authority by its option, a worktree, a list, an unset field', () => {
    expect(changeWords({ path: 'nodes.part-a.spawns.reviewer', node: 'part-a', kind: 'changed', before: 1, after: 3 })).toBe('part-a delegates to reviewer ≤3 (was ≤1)')
    expect(changeWords({ path: 'nodes.part-a.spawns.fixer', node: 'part-a', kind: 'added', after: 2 })).toBe('part-a delegates to fixer ≤2')
    expect(changeWords({ path: 'nodes.part-a.spawns.fixer', node: 'part-a', kind: 'removed', before: 2 })).toBe('part-a no longer delegates to fixer')
    expect(changeWords({ path: 'nodes.fixer.tools.deny', node: 'fixer', kind: 'added', after: ['Bash', 'Write'] })).toBe('Set fixer · tools deny · Bash, Write')
    expect(changeWords({ path: 'nodes.fixer.model', node: 'fixer', kind: 'removed', before: 'haiku' })).toMatch(/^Unset fixer · model · was /)
    expect(valueWords('worktree', { new: { from: 'main', branch: 'litter/a' } })).toBe('new from main on litter/a')
    expect(valueWords('worktree', { existing: '/repo/wt' })).toBe('existing /repo/wt')
    expect(valueWords('task', '')).toBe('empty')
    expect(valueWords('task', undefined)).toBe('not set')
    expect(valueWords('authority.commit', true)).toBe('allowed')
    expect(valueWords('authority.commit', false)).toBe('not allowed')
  })
})

describe('WP-DD: the first line and the inspector', () => {
  test("each view's title is the swarm's name in the name color, then the view, muted: no `litter ·` of its own", async () => {
    await saveRev1()
    setNav(blankNav('builder', SWARM))
    await paneTick(p)
    const b = shown<SwarmBuilderView>()
    expect(b.title[0]).toEqual({ text: SWARM, color: 'cyan_FOR_SUBAGENTS_ONLY', bold: true })
    expect(b.title.map(s => s.text).join('')).toBe('alpha · builder · rev 1')
    expect(b.goal).toBe('Base')
    // The lead's row: the swarm's own fields; a node's under the five headings.
    expect(b.inspector.fields.map(f => [f.label, f.group])).toEqual(expect.arrayContaining([['Goal', 'swarm']]))
    await handle(p, 'swarm:builder:select:alpha/part-a', {})
    const groups = new Set(shown<SwarmBuilderView>().inspector.fields.map(f => f.group))
    expect([...groups].sort()).toEqual(['authority', 'execution', 'limits', 'paths', 'tools'])
    const byLabel = Object.fromEntries(shown<SwarmBuilderView>().inspector.fields.map(f => [f.label, f.group]))
    expect(byLabel).toEqual(expect.objectContaining({ Model: 'execution', Commit: 'authority' }))
  })

  test('the start screen draws no title (the hub says Swarms); the browser says live with its mark', async () => {
    setNav(blankNav('start', null))
    await paneTick(p)
    expect(shown<SwarmStartView>().title.map(s => s.text).join('')).toBe('new swarm')
    await saveRev1()
    goLive()
    setNav(blankNav('browser', SWARM))
    await paneTick(p)
    const t = shown<SwarmBrowserView>().title
    expect(t[0]).toEqual(expect.objectContaining({ text: SWARM, color: 'cyan_FOR_SUBAGENTS_ONLY' }))
    expect(t.map(s => s.text).join('')).toMatch(/^alpha · ▸ live 2m · 3 agents · /)
  })
})

describe('WP-DD: the roster', () => {
  test('each row its role, whether it runs, and a glyph beside every status', async () => {
    await saveRev1()
    goLive()
    p.agents = [
      { id: 'o1', description: 'part-a', type: 'litter:sw-alpha-part-a', status: 'running' },
      { id: 'w1', description: 'reviewer', type: 'litter:sw-alpha-reviewer', status: 'completed' },
      { id: 'o2', description: 'part-c', type: 'litter:sw-alpha-part-c', status: 'idle' },
    ] as never
    setNav(blankNav('browser', SWARM))
    await paneTick(p)
    const rows = Object.fromEntries(shown<SwarmBrowserView>().rows.map(r => [r.key, r]))
    expect(rows.lead).toEqual(expect.objectContaining({ role: 'lead', statusGlyph: '' }))
    expect(rows.o1).toEqual(expect.objectContaining({ role: 'orchestrator', running: true, status: 'running', statusGlyph: '▸' }))
    expect(rows.w1).toEqual(expect.objectContaining({ role: 'worker', running: false, status: 'done', statusGlyph: '✓' }))
    expect(rows.o2).toEqual(expect.objectContaining({ running: false, status: 'between turns', statusGlyph: '·' }))
  })

  const view = (over: Partial<SwarmBrowserView> = {}): SwarmBrowserView => ({
    view: 'browser',
    v: 1,
    title: [],
    notice: null,
    swarm: 'demo',
    launch: LAUNCH,
    state: 'live',
    readOnly: false,
    lost: false,
    owner: null,
    budget: null,
    summary: null,
    rows: [
      { key: 'lead', agentId: null, depth: 0, name: 'lead', role: 'lead', color: null, dim: false, status: 'idle', statusGlyph: '', statusColor: 'inactive', running: false, tool: '', turns: null, tokens: '', report: '', queued: [], question: null, flagged: false },
      { key: 'o1', agentId: 'o1', depth: 1, name: 'part-a', role: 'orchestrator', color: null, dim: false, status: 'running', statusGlyph: '▸', statusColor: 'background', running: true, tool: 'Bash', turns: 3, tokens: '2k', report: 'half done', queued: [], question: null, flagged: false },
      { key: 'w1', agentId: 'w1', depth: 2, name: 'reader', role: 'worker', color: null, dim: true, status: 'done', statusGlyph: '✓', statusColor: 'success', running: false, tool: '', turns: 1, tokens: '800', report: '', queued: [], question: null, flagged: false },
    ],
    flags: [],
    events: [],
    composer: null,
    transcript: null,
    selected: null,
    ...over,
  })

  test("its description is the turns, tokens and last report; Stop and Hard stop only beside a running node of a swarm this session owns", () => {
    const v = view()
    expect(rosterDescription(v.rows[1]!)).toBe('3 turns · 2k tokens · last report: half done')
    expect(rosterDescription(v.rows[2]!)).toBe('1 turn · 800 tokens')
    const labels = (x: SwarmBrowserView, i: number) => rosterActions(x, x.rows[i]!).map(a => a.label)
    expect(labels(v, 1)).toEqual(['Transcript', 'Stop node', 'Hard stop'])
    expect(labels(v, 2)).toEqual(['Transcript'])
    expect(labels(view({ readOnly: true }), 1)).toEqual(['Transcript'])
    expect(labels(view({ lost: true }), 1)).toEqual(['Transcript'])
    expect(rosterActions(v, v.rows[0]!)).toEqual([])
    // The list: the lead is the heading's note, so two rows; the menu only where the rows are a Client.
    const spec = rosterList(v, true)
    expect(spec.items.map(i => i.label)).toEqual(['part-a', '  reader'])
    expect(spec.items[0]!.cells?.map(c => c.text)).toEqual(['▸ running', 'orchestrator', '', '▸ Bash'])
    expect(spec.items[0]!.actions?.map(a => a.label)).toEqual(['Transcript', 'Stop node', 'Hard stop'])
    expect(rosterList(v, false).items[0]!.actions).toBeUndefined()
  })

  test("the transcript's window: the newest lines by default, a tick up moves it back, and at either edge the tick passes on", () => {
    const lines = Array.from({ length: 40 }, (_, i) => [{ text: `line ${i + 1}` }])
    const v = view({ transcript: { agentId: 'w1', name: 'reader', readable: true, lines }, selected: 'w1' })
    expect(transcriptWindow(40, 0, 10)).toEqual({ start: 30, end: 40, earlier: 30, newer: 0, offset: 0, max: 30 })
    expect(transcriptWindow(40, 5, 10)).toEqual({ start: 25, end: 35, earlier: 25, newer: 5, offset: 5, max: 30 })
    expect(transcriptWindow(40, 99, 10).offset).toBe(30)
    expect(transcriptWindow(4, 0, 10)).toEqual({ start: 0, end: 4, earlier: 0, newer: 0, offset: 0, max: 0 })
    const ctx = { bodyColumns: 100, surface: 'terminal' as const, focused: null, lists: {} as Record<string, number>, rows: 30 }
    const top = browserTranscriptTop(v, ctx)
    const rows = transcriptRows(v, ctx)
    expect(rows).toBeGreaterThanOrEqual(TRANSCRIPT_MIN_ROWS)
    // A tick up (by −1) over the first line moves it one back from the newest; over the row above, it passes on.
    expect(browserWheel(v, ctx, top, -1)).toEqual({ id: transcriptListId('demo', 'w1'), to: 1, max: 40 - rows })
    expect(browserWheel(v, ctx, top - 1, -1)).toBeNull()
    // At the newest already, a tick down passes on; scrolled back, it comes forward.
    expect(browserWheel(v, ctx, top, 1)).toBeNull()
    const back = { ...ctx, lists: { [transcriptListId('demo', 'w1')]: 3 } }
    expect(browserWheel(v, back, top, 1)).toEqual(expect.objectContaining({ to: 2 }))
    // A short pane still gives it six rows.
    expect(transcriptRows(v, { ...ctx, rows: 4 })).toBe(TRANSCRIPT_MIN_ROWS)
    expect(transcriptRows(v, { ...ctx, rows: Number.POSITIVE_INFINITY })).toBe(TRANSCRIPT_INLINE_ROWS)
  })

  test("the composer's caption says who it goes to, and whether it interjects or queues", () => {
    const routes = [
      { value: 'direct', label: 'direct' },
      { value: 'lead', label: 'via the lead' },
    ]
    const targets = [{ value: 'w1', label: 'reader' }]
    expect(composerCaption({ to: 'w1', targets, when: 'interject', route: 'direct', routes })).toBe('to reader · interjects now · direct')
    expect(composerCaption({ to: null, targets, when: 'queue', route: 'lead', routes })).toBe('pick who it goes to · queues until it settles · via the lead')
  })
})

describe("WP-DD: the transcript's lines", () => {
  test('a wrapped message reads `from <name>: <first line>`, the name in the name color; a tool line in its spans', () => {
    expect(messageText('<teammate-message teammate_id="part-a" color="blue">Fix the tokenizer\nthen the lexer</teammate-message>')).toBe('from part-a: Fix the tokenizer')
    expect(messageText('<task-notification><status>done</status></task-notification> later')).toBe('task-notification: done (+ more)')
    expect(messageSpans('user', '<teammate-message teammate_id="part-a">go</teammate-message>')).toEqual([
      { text: '› ', color: 'inactive' },
      { text: 'from ', color: 'inactive' },
      { text: 'part-a', color: 'cyan_FOR_SUBAGENTS_ONLY' },
      { text: ': go', color: 'inactive' },
    ])
    expect(messageSpans('assistant', 'Looking at it\nmore')).toEqual([{ text: '◆ ', color: 'claude' }, { text: 'Looking at it' }])
    expect(toolLine({ tool: 'Bash', input: { command: 'cd /repo && grep -n x\nsecond line', description: 'look' }, text: 'ok' })).toEqual([
      { text: '  ↳ ', color: 'subtle' },
      { text: 'Bash', color: 'text', bold: true },
      { text: ' cd /repo && grep -n x', color: 'inactive' },
      { text: ' ✓ done', color: 'success' },
    ])
    expect(toolLine({ tool: 'Read', input: { file_path: '/repo/a.ts' } }, 2)).toEqual([
      { text: '  ↳ ', color: 'subtle' },
      { text: 'Read', color: 'text', bold: true },
      { text: ' /repo/a.ts', color: 'suggestion' },
      { text: ' (+2 more)', color: 'subtle' },
      { text: ' · no outcome recorded', color: 'inactive' },
    ])
    expect(toolLine({ tool: 'Edit', input: {}, isError: true, text: 'no match\nat line 3' }).at(-1)).toEqual({ text: ' ✕ no match', color: 'error' })
  })
})

describe('WP-DD: the primary per state, the start list top, Doctor', () => {
  test("the builder's: Save unsaved, Launch saved and not live, none live, Save template while the form is open", () => {
    expect(builderPrimary({ unsaved: true, live: false, saveAs: null })).toBe('save')
    expect(builderPrimary({ unsaved: false, live: false, saveAs: null })).toBe('launch')
    expect(builderPrimary({ unsaved: false, live: true, saveAs: null })).toBeNull()
    expect(builderPrimary({ unsaved: true, live: false, saveAs: { name: 'x', description: '', scope: 'user', candidates: [] } })).toBe('save-template')
  })

  test("the start screen's: Ask the lead with an ask, else Use template with one picked, else none", () => {
    const t = { id: 'builtin:x', name: 'x', description: '', params: [], errors: [] }
    expect(startPrimary({ ask: 'review it', template: t })).toBe('ask')
    expect(startPrimary({ ask: '  ', template: t })).toBe('template')
    expect(startPrimary({ ask: '', template: null })).toBeNull()
  })

  test('the rows above the template list, at 100 and 60 columns, framed and not, with a notice', () => {
    const start: SwarmStartView = { view: 'start', v: 1, title: [], notice: null, blocked: null, name: '', ask: '', templates: [], template: null, swarms: [] }
    // Name (3 framed + its caption), a gap and "Ask the lead", the ask (3 + caption), a gap and "From a template".
    expect(startListTop(start, { bodyColumns: 100, surface: 'terminal' })).toBe(12)
    expect(startListTop(start, { bodyColumns: 60, surface: 'terminal' })).toBe(12)
    expect(startListTop(start, { bodyColumns: 100, surface: 'desktop' })).toBe(8)
    const long = { ...start, notice: { level: 'warning' as const, text: 'name the swarm first: a-z, 0-9 and -, up to 24, not starting with -' } }
    expect(startListTop(long, { bodyColumns: 100, surface: 'terminal' })).toBe(13)
    expect(startListTop(long, { bodyColumns: 60, surface: 'terminal' })).toBe(14)
    // With a template picked past 100 columns the list takes its share, its form's box the rest; narrower, the body's.
    const picked = { template: { id: 'builtin:x', name: 'x', description: '', params: [], errors: [] } }
    expect(templateListCtx(picked, { bodyColumns: 100 }).bodyColumns).toBe(45)
    expect(templateListCtx(picked, { bodyColumns: 60 }).bodyColumns).toBe(60)
    expect(templateListCtx({ template: null }, { bodyColumns: 120 }).bodyColumns).toBe(120)
  })

  test("Doctor's rows: each its word, a failing one first; its tally; its fix the primary", async () => {
    setOwnersForTests({
      checkHealth: fake('checkHealth', async () => ({
        rows: [
          { id: 'a', severity: 'ok', title: 'fine', detail: '', need: null, process: null, sources: [] },
          { id: 'b', severity: 'warning', title: 'low', detail: '', need: null, process: null, sources: [] },
          { id: 'c', severity: 'error', title: 'short', detail: '', need: null, process: null, sources: [] },
        ],
        errors: 1,
        warnings: 1,
        snippet: '{}',
      })),
    })
    await doctorCommand(p, command('doctor'), next)
    const body = (p.views.doctor as DoctorPaneView).body!
    expect(body.rows.map(r => [r.id, r.word])).toEqual([
      ['c', 'fails'],
      ['b', 'warning'],
      ['a', 'ok'],
    ])
    expect(doctorTally(body)).toEqual({ level: 'error', text: '1 check fails, 1 warning' })
    expect(doctorTally({ errors: 0, warnings: 0 })).toEqual({ level: 'ok', text: 'nothing falls short' })
    expect(doctorActions(body).filter(a => a.primary).map(a => a.label)).toEqual(['Ask lead to add it'])
    expect(doctorActions({ snippet: null }).filter(a => a.primary).map(a => a.label)).toEqual(['Recheck'])
    expect(failingFirst([{ ...body.rows[2]!, id: 'x' }, body.rows[0]!]).map(r => r.id)).toEqual(['c', 'x'])
  })

  test("the keys a view adds: the builder's tree and a roster's right-click", () => {
    expect(swarmKeys(null)).toEqual([])
    expect(swarmKeys({ view: 'history', v: 1, title: [], notice: null, swarm: 'demo', entries: [] }).length).toBe(0)
  })
})
