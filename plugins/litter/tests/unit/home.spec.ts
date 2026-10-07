// Tier 2 (phase 5b, WP-DB): Home's needs-you rows and the strip's Swarms ⚑
// against the real swarm panes (hooks/ui/hub.ts, hooks/ui/homeview.ts). The
// user's live look (2026-10-07): the hub said `⚑ needs you: Swarms`, and the
// browser it opened didn't show why. So each row says which thing waits, and
// its [Open] lands on it: a lead proposal on its own proposal view, a
// question on its swarm's browser, where the node waits with it; the strip's
// Swarms, with its ⚑, on the first of them. Only the health check is faked.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import { rejectProposal, saveRevision, stageProposal } from '../../hooks/swarm/store'
import type { HealthReport, LiveSwarm, NodeBinding, SwarmNode, SwarmSpec } from '../../hooks/swarm/types'
import { blankNav, dropProposal, nav, pendingProposals, resetViewForTests, seedProposals, setNav, setOwnersForTests } from '../../hooks/swarm/view'
import { resetPanesForTests } from '../../hooks/swarm/panes'
import { onLitterUi, openSection, resetHubForTests, shownSection } from '../../hooks/ui/hub'
import { stripKey } from '../../hooks/ui/chrome'
import type { HubView, SwarmBrowserView, SwarmProposalView } from '../../types/index'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const NOW = 1_800_000_000_000
const SWARM = 'alpha'
const LAUNCH = '20270115-093000'
const W = ['Edit', 'Write', 'NotebookEdit']
const RO = { commit: false, push: 'none', forcePush: false, rewriteHistory: false, worktreeOps: false } as const
const HEALTHY: HealthReport = { rows: [], errors: 0, warnings: 0, snippet: null }

let p: TestPorts
let dir: string
let litterDir: string
let cleanup: () => void

const node = (id: string, over: Partial<SwarmNode> = {}): SwarmNode => ({ id, kind: 'worker', tools: { deny: W }, authority: RO, ...over })
const lead = (id: string, over: Partial<SwarmNode> = {}): SwarmNode => node(id, { kind: 'orchestrator', worktree: 'none', ...over })
const rev1 = (): SwarmSpec => ({ name: SWARM, goal: 'Base', nodes: [lead('port', { brief: 'briefs/port.md', task: 'Port it' })] })

function live(): LiveSwarm {
  return {
    name: SWARM,
    launch: LAUNCH,
    revision: 1,
    spec: rev1(),
    nonce: 'n0nce',
    types: { port: 'litter:sw-alpha-port' },
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
  }
}

const binding = (): NodeBinding => ({
  agentId: 'o1',
  swarm: SWARM,
  launch: LAUNCH,
  node: 'port',
  n: 1,
  kind: 'orchestrator',
  of: null,
  parent: null,
  type: 'litter:sw-alpha-port',
  cwd: dir,
  branch: null,
  token: 'tok-o1',
  revision: 1,
  generation: 1,
  boundAt: NOW - 60_000,
  adopted: false,
})

/** Alpha live, revision 1 saved, and the lead's proposals 1 and 2 staged on it, undecided, as the pane's list has them. */
async function liveWithProposals(): Promise<void> {
  await saveRevision(p, litterDir, SWARM, { spec: rev1(), briefs: { port: 'Port it.\n' } }, { from: 'save', changes: [] })
  await stageProposal(p, litterDir, SWARM, { baseRevision: 1, spec: { ...rev1(), goal: 'Port it to arm64' }, briefs: {}, changes: [{ path: 'goal', reason: 'the target' }] })
  await stageProposal(p, litterDir, SWARM, { baseRevision: 1, spec: { ...rev1(), goal: 'Port it to riscv' }, briefs: {}, changes: [{ path: 'goal', reason: 'the other target' }] })
  state.putLiveSwarm(live())
  state.putBinding(binding())
  p.agents = [{ id: 'o1', description: 'port', type: 'litter:sw-alpha-port', status: 'running' }] as never
  await seedProposals(p, SWARM)
  expect(pendingProposals(SWARM)).toEqual([1, 2])
}

const press = (element: string) => onLitterUi.press(p, { plugin: 'litter', element, component: 'Pane', requestId: 'litter', surface: 'terminal' } as never, (async (e: { element: string }) => ({ element: `next ${e.element}` })) as never)
const home = () => (p.views.hub as HubView).home!
const said = () => home().needsYou.map(r => [r.open, r.spans.map(s => s.text).join('')])

beforeEach(async () => {
  state.resetForTests()
  resetViewForTests()
  resetPanesForTests()
  resetHubForTests()
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ sessionId: 's1', cwd: dir })
  await scratchRepo(p, dir)
  p.clock.now = NOW
  litterDir = join(dir, '.claude', 'litter')
  updateSession({ litterDir, litterDirError: null })
  setOwnersForTests({ checkHealth: async () => HEALTHY })
})

afterEach(() => {
  updateSession({ litterDir: null })
  setOwnersForTests({})
  resetHubForTests()
  state.resetForTests()
  cleanup()
})

describe("Home's needs-you rows land where their reason is", () => {
  test("each of the lead's proposals is its own row, by number, and its [Open] lands on that proposal's view", async () => {
    await liveWithProposals()
    await openSection(p, 'home', '', { focus: true })
    expect(said()).toEqual([
      ['home:open:swarms:alpha/1', "the lead's proposal 1 for alpha"],
      ['home:open:swarms:alpha/2', "the lead's proposal 2 for alpha"],
    ])
    expect((p.views.hub as HubView).live.map(s => s.text).join('')).toBe('▸ running: 1 swarm · ⚑ needs you: 2 proposals')

    // The live swarm's own landing is its browser; the [Open] steps on to the proposal, through Swarms' own keys.
    expect(await press('home:open:swarms:alpha/2')).toEqual({ element: 'home:open:swarms:alpha/2' })
    expect(shownSection()).toBe('swarms')
    expect(nav()).toEqual(expect.objectContaining({ view: 'proposal', swarm: SWARM, proposal: 2 }))
    const shown = p.views.swarm as SwarmProposalView
    expect([shown.view, shown.swarm, shown.n]).toEqual(['proposal', SWARM, 2])
    expect(p.toasts).toEqual([])
  })

  test("a node's question is its row, in its first line, and its [Open] lands on the swarm's browser with the node picked, waiting", async () => {
    await liveWithProposals()
    dropProposal(SWARM, 1)
    dropProposal(SWARM, 2)
    state.noteQuestion('o1', '\nWhich port should I use, 8080 or 8443?\nEither works for me.', NOW - 1_000)
    await openSection(p, 'home', '', { focus: true })
    expect(said()).toEqual([['home:open:swarms:alpha o1', 'port asks: Which port should I use, 8080 or 8443?']])
    await press('home:open:swarms:alpha o1')
    expect(shownSection()).toBe('swarms')
    const shown = p.views.swarm as SwarmBrowserView
    expect([shown.view, shown.swarm, shown.selected]).toEqual(['browser', SWARM, 'o1'])
    expect(shown.rows.find(r => r.agentId === 'o1')).toEqual(expect.objectContaining({ status: 'waiting', statusGlyph: '⚑' }))
  })

  test('a proposal decided since Home was drawn (in another session, say): Swarms is shown, and a toast says it was decided', async () => {
    await liveWithProposals()
    await openSection(p, 'home', '', { focus: true })
    // Rejected in J's ledger, this module not told: the load reads the ledger again.
    await rejectProposal(p, litterDir, SWARM, 2)
    expect(pendingProposals(SWARM)).toEqual([1, 2])
    await press('home:open:swarms:alpha/2')
    expect(shownSection()).toBe('swarms')
    expect(nav()?.view).toBe('browser')
    expect(p.toasts).toEqual(["the lead's proposal 2 for alpha was decided already"])
  })
})

describe("the strip's Swarms with its ⚑", () => {
  test('opens on the first thing Home lists for a swarm: a proposal on its view, over a kept view of something else', async () => {
    await liveWithProposals()
    // Swarms kept the start screen: it says nothing of the proposals.
    setNav(blankNav('start', null))
    await openSection(p, 'home', '', { focus: true })
    expect((p.views.hub as HubView).tabs.find(t => t.section === 'swarms')?.needsYou).toBe(true)
    await press(stripKey('swarms'))
    expect(shownSection()).toBe('swarms')
    expect(nav()).toEqual(expect.objectContaining({ view: 'proposal', swarm: SWARM, proposal: 1 }))
  })

  test("a question first: the swarm's browser; a kept view that shows it already stays as it was", async () => {
    await liveWithProposals()
    state.noteQuestion('o1', 'Which port?', NOW - 1_000)
    setNav(blankNav('start', null))
    await openSection(p, 'home', '', { focus: true })
    await press(stripKey('swarms'))
    expect(nav()).toEqual(expect.objectContaining({ view: 'browser', swarm: SWARM }))
    // Back to Home, then the strip again: the browser kept, with what was typed in it.
    setNav({ ...nav()!, inputs: { 'swarm:browser:text:alpha': 'half a reply' } })
    await press(stripKey('home'))
    await press(stripKey('swarms'))
    expect(nav()).toEqual(expect.objectContaining({ view: 'browser', swarm: SWARM, inputs: { 'swarm:browser:text:alpha': 'half a reply' } }))
  })

  test('nothing waiting: the strip shows what Swarms kept', async () => {
    await saveRevision(p, litterDir, SWARM, { spec: rev1(), briefs: {} }, { from: 'save', changes: [] })
    setNav(blankNav('builder', SWARM))
    await openSection(p, 'home', '', { focus: true })
    await press(stripKey('swarms'))
    expect(nav()).toEqual(expect.objectContaining({ view: 'builder', swarm: SWARM }))
  })
})
