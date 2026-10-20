// Tier 2: what the panes show of a repair (hooks/swarm/view.ts; WP-Z): the
// browser's header names the run a repair swarm repairs, its budget row
// counts the rounds and agents used of what you approved from the state's
// counters, its events list shows the `gate` and `budget` events, and the
// builder's inspector shows `authority.verify`, `authority.land` and
// `verdicts` like the other fields, so validation's errors on them have a
// field to point at. The generated summary's inputs (summary.ts) carry the
// budget and the gates too. The owners are fakes, as in view.spec.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { updateSession } from '../../hooks/session'
import { appendLaunchRecord } from '../../hooks/records/swarm'
import type { SwarmEventBody } from '../../hooks/records/swarm'
import * as state from '../../hooks/swarm/state'
import type { LiveSwarm, NodeBinding, SwarmSpec } from '../../hooks/swarm/types'
import { blankNav, resetViewForTests, setNav, setOwnersForTests, swarmView } from '../../hooks/swarm/view'
import { handle, resetPanesForTests } from '../../hooks/swarm/panes'
import { summaryInputs } from '../../hooks/swarm/summary'
import type { SwarmBrowserView, SwarmBuilderView } from '../../types/index'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const NOW = 1_800_000_000_000
const NAME = 'repair-0a1b2c'
const LAUNCH = '20271003-093000'
const RUN = '20261003-api'
const W = ['Edit', 'Write', 'NotebookEdit']

const SPEC: SwarmSpec = {
  name: NAME,
  goal: `Repair the combined result of run ${RUN}`,
  nodes: [
    { id: 'repair', kind: 'orchestrator', tools: { deny: W }, authority: { push: 'none', verify: true, land: true }, spawns: { fixer: 2, critic: 1 } },
    { id: 'fixer', kind: 'worker', serial: true, authority: { commit: true, push: 'none', verify: true } },
    { id: 'critic', kind: 'worker', verdicts: true, tools: { deny: W }, authority: { commit: false, push: 'none', verify: true } },
  ],
}

let p: TestPorts
let litterDir: string
let cleanup: () => void
let draft: { spec: SwarmSpec; revision: number; briefs: Record<string, string> }

beforeEach(() => {
  state.resetForTests()
  resetViewForTests()
  resetPanesForTests()
  p = nodePorts({ sessionId: 's1' })
  p.clock.now = NOW
  ;({ dir: litterDir, cleanup } = scratch())
  updateSession({ litterDir, litterDirError: null })
  draft = { spec: SPEC, revision: 1, briefs: {} }
  let stored: unknown = null
  setOwnersForTests({
    readDraft: async () => stored as never,
    readSaved: async () => draft,
    writeDraft: async (_p, _l, _n, d) => void (stored = d),
    validateSaved: async () => ({ ok: true, errors: [], warnings: [] }),
    checkHealth: async () => ({ rows: [], errors: 0, warnings: 0, snippet: null }),
    undecidedProposals: async () => [],
    resumeTargets: () => [],
    recoveryCard: () => null,
    settleProgress: () => null,
    summaryOf: () => null,
    readOwner: async () => null,
  })
})

afterEach(() => {
  updateSession({ litterDir: null })
  setOwnersForTests({})
  state.resetForTests()
  cleanup()
})

function live(over: Partial<LiveSwarm> = {}): void {
  state.putLiveSwarm({
    name: NAME,
    launch: LAUNCH,
    revision: 1,
    spec: SPEC,
    nonce: 'n0nce',
    types: { repair: `litter:sw-${NAME}-repair`, fixer: `litter:sw-${NAME}-fixer`, critic: `litter:sw-${NAME}-critic` },
    typesReady: true,
    dirs: {},
    sessionCwd: '/repo',
    worktreeRoot: '/repo/.claude/worktrees',
    commonDir: '/repo/.git',
    roots: { litterDir, litterCopies: [litterDir], ruleDirs: [] },
    tips: {},
    owner: { ref: `refs/litter-swarm/${NAME}`, oid: 'a'.repeat(40), generation: 1, session: 's1' },
    state: 'live',
    readOnly: false,
    lost: false,
    flags: { isolationLost: false },
    startedAt: NOW - 60_000,
    run: { runDir: `${litterDir}/${RUN}`, run: RUN, generation: 2 },
    budget: { rounds: 3, agents: 6 },
    ...over,
  })
  const b = (agentId: string, node: string, over: Partial<NodeBinding> = {}): NodeBinding => ({
    agentId,
    swarm: NAME,
    launch: LAUNCH,
    node,
    n: 1,
    kind: 'worker',
    of: null,
    parent: 'o1',
    type: `litter:sw-${NAME}-${node}`,
    cwd: '/repo',
    branch: null,
    token: `tok-${agentId}`,
    revision: 1,
    generation: 1,
    boundAt: NOW - 30_000,
    adopted: false,
    ...over,
  })
  state.putBinding(b('o1', 'repair', { kind: 'orchestrator', parent: null }))
  state.putBinding(b('f1', 'fixer'))
  state.putBinding(b('c1', 'critic'))
}

const browser = async (): Promise<SwarmBrowserView> => {
  setNav(blankNav('browser', NAME))
  return (await swarmView(p)) as SwarmBrowserView
}

const event = (body: SwarmEventBody) => appendLaunchRecord(p, litterDir, NAME, LAUNCH, 'swarm.event', body)

describe("the browser of a repair swarm", () => {
  test('its header names the run, and its budget row counts the rounds and agents used', async () => {
    live()
    state.noteSpawned(NAME, 'tu-fix1')
    state.noteSpawned(NAME, 'tu-crit1')
    state.noteRound(NAME, 'v-2')
    const v = await browser()
    expect(v.title.map(s => s.text).join('')).toContain(` · repairs run ${RUN}`)
    expect(v.budget).toEqual({
      run: RUN,
      generation: 2,
      rounds: { used: 1, of: 3, text: 'rounds 1 of 3', glyph: '', color: null },
      agents: { used: 2, of: 6, text: 'agents 2 of 6', glyph: '', color: null },
      note: null,
    })
  })

  test('a part used up says so with its glyph and the warning color, and the note says what it means', async () => {
    live({ budget: { rounds: 2, agents: 6 } })
    state.noteRound(NAME, 'v-1')
    state.noteRound(NAME, 'v-2')
    let v = await browser()
    expect(v.budget!.rounds).toEqual({ used: 2, of: 2, text: 'rounds 2 of 2, all used', glyph: '!', color: 'warning' })
    expect(v.budget!.agents.glyph).toBe('')
    expect(v.budget!.note).toBe('no verdict past its last round is taken, until you grant more when the lead asks (repair.budget)')
    for (let i = 0; i < 6; i++) state.noteSpawned(NAME, `tu-${i}`)
    v = await browser()
    expect(v.budget!.agents).toEqual(expect.objectContaining({ text: 'agents 6 of 6, all used', glyph: '!', color: 'warning' }))
    expect(v.budget!.note).toContain('and it spawns no more agents')
  })

  test('the gate and budget events are in the events list, each result with its word and glyph', async () => {
    live()
    await event({ kind: 'gate', node: 'fixer', agentId: 'f1', run: RUN, seq: 21, record: 'verify', gate: 'repair', result: 'red', verify_id: 'v-1' })
    await event({ kind: 'gate', node: 'critic', agentId: 'c1', run: RUN, seq: 23, record: 'verdict', gate: 'repair', result: 'rejected', verify_id: 'v-2', round: 1 })
    await event({ kind: 'budget', requested: { rounds: 2 }, granted: true, budget: { rounds: 5, agents: 6 } })
    await event({ kind: 'budget', requested: { agents: 3 }, granted: false, budget: { rounds: 5, agents: 6 } })
    await event({ kind: 'gate', node: 'critic', agentId: 'c1', run: RUN, seq: 26, record: 'verdict', gate: 'repair', result: 'approved', verify_id: 'v-3', round: 2 })
    await event({ kind: 'gate', agentId: 'o1', run: RUN, seq: 27, record: 'land', gate: 'fanout', result: 'landed', verify_id: 'v-3' })
    await event({ kind: 'gate', agentId: 'o1', run: RUN, seq: 28, record: 'land', gate: 'fanout', result: 'not-landed', verify_id: 'v-4' })
    const v = await browser()
    expect(v.events.map(e => [e.who, e.text, e.color])).toEqual([
      ['fixer', 'verify v-1: ✕ red', 'error'],
      ['critic', 'verdict, round 1, on v-2: ✕ rejected', 'error'],
      ['lead', 'asked for more budget (rounds 2): ✓ granted, now 5 rounds, 6 agents', 'success'],
      ['lead', 'asked for more budget (agents 3): ✕ not granted, still 5 rounds, 6 agents', 'inactive'],
      ['critic', 'verdict, round 2, on v-3: ✓ approved', 'success'],
      // No node on the event: the binding names it.
      ['repair', 'land of v-3: ✓ landed', 'success'],
      ['repair', 'land of v-4: ✕ not landed', 'error'],
    ])
  })

  test('a plain swarm has no budget row and its header names no run', async () => {
    live({ run: undefined, budget: undefined })
    const v = await browser()
    expect(v.budget).toBeNull()
    expect(v.title.map(s => s.text).join('')).not.toContain('repairs run')
  })
})

describe("the generated summary's inputs (summary.ts)", () => {
  test('a repair swarm gives its budget in the node list, and its gate and budget events in words', async () => {
    live()
    state.noteSpawned(NAME, 'tu-fix1')
    state.noteRound(NAME, 'v-2')
    await event({ kind: 'gate', node: 'critic', agentId: 'c1', run: RUN, seq: 23, record: 'verdict', gate: 'repair', result: 'rejected', verify_id: 'v-2', round: 1 })
    await event({ kind: 'budget', requested: { rounds: 2 }, granted: true, budget: { rounds: 5, agents: 6 } })
    const prompt = await summaryInputs(p, litterDir, state.liveSwarm(NAME)!)
    expect(prompt).toContain(`repair budget for run ${RUN}: 1 of 3 rounds used, 1 of 6 agents used`)
    expect(prompt).toMatch(/#\d+ verdict by critic, round 1: rejected \(verify v-2\)/)
    expect(prompt).toMatch(/#\d+ the lead asked for more repair budget: granted; now 5 rounds, 6 agents/)
  })

  test("a plain swarm's has no budget line", async () => {
    live({ run: undefined, budget: undefined })
    expect(await summaryInputs(p, litterDir, state.liveSwarm(NAME)!)).not.toContain('repair budget')
  })
})

describe("the builder's inspector", () => {
  test('verify, land and verdicts are fields like the others; an unset grant is litter-checked, not —', async () => {
    setNav({ ...blankNav('builder', NAME), selected: 'repair/critic' })
    let v = (await swarmView(p)) as SwarmBuilderView
    const field = (label: string) => v.inspector.fields.find(f => f.label === label)
    expect(field('Verdicts')).toEqual(expect.objectContaining({ key: `swarm:builder:field:${NAME}/critic/verdicts`, value: 'yes', badge: 'litter' }))
    expect(field('Verify')).toEqual(expect.objectContaining({ key: `swarm:builder:field:${NAME}/critic/authority.verify`, value: 'yes', badge: 'litter' }))
    expect(field('Land')).toEqual(expect.objectContaining({ value: '', badge: 'litter', note: expect.stringContaining('not set: not given') }))
    // An unset authority field litter doesn't check keeps its —.
    expect(field('Force-push')?.badge).toBe('—')

    // An edit sets the field by its path, as validation's errors name it.
    await handle(p, `swarm:builder:field:${NAME}/critic/authority.land`, { value: 'yes' })
    v = (await swarmView(p)) as SwarmBuilderView
    expect(v.inspector.fields.find(f => f.label === 'Land')?.value).toBe('yes')
    await handle(p, `swarm:builder:field:${NAME}/critic/verdicts`, { value: '' })
    v = (await swarmView(p)) as SwarmBuilderView
    expect(v.inspector.fields.find(f => f.label === 'Verdicts')?.value).toBe('')
  })
})
