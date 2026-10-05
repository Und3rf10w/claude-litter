// Tier 2: phase 5's contracts and one-time wiring (WP-CA), with the other
// packages' stubs in place: the new nodePorts fakes (notice, toolNames,
// envVar, the four new setView targets, a send to `{ agentId }`); the spool's
// `ask` line through the real drain, and consumeAsks' place among the
// consumers; that every stub keeps today's behavior (no band, no card, the
// panes' stub lines, the store's empty reads and refused writes); the
// board's openBoard and the swarm pane's openSwarmPane, which the band and
// the card call; and the rebind's new steps after a /clear, through clear.ts's
// `others`.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RenderElement } from 'claude-code'
import type { SpoolConsumer, SpoolLine } from '../../hooks/hookfiles'
import type { BandRender, CardRender } from '../../hooks/hooktypes'
import type { Ports } from '../../hooks/ports'
import type { BandView, BoardView, CardsView } from '../../types/index'
import { appendRecord } from '../../hooks/ledgercore'
import { runDir, runJsonPath, spoolDir, spoolPath } from '../../hooks/layout'
import { drainSpool } from '../../hooks/policy'
import { SPOOL_CONSUMERS } from '../../hooks/registry'
import { consumeInflight } from '../../hooks/inflight'
import { consumeAgents } from '../../hooks/policy'
import { MOD } from '../../hooks/verify'
import { session, updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import { asksTick, consumeAsks, openAsks, restoreAsks } from '../../hooks/asks'
import { bandShows, bandTick, onBandUi, refreshBand } from '../../hooks/band/view'
import { renderBand } from '../../hooks/band/render'
import { cardRow, noteCards, onCardUi, refreshCards, restoreCards } from '../../hooks/card/view'
import { renderCard } from '../../hooks/card/render'
import { onTasksUi, refreshTasks, tasksCommand, tasksTick, TASKS_PANE } from '../../hooks/tasks/pane'
import { agentsCommand, agentsTick, AGENTS_PANE, onAgentsUi, refreshAgents } from '../../hooks/agents/pane'
import { appendInbox, readInbox, readTasks, taskLists, teams, updateTask } from '../../hooks/team/store'
import { BOARD_PANE, openBoard, resetBoardPaneForTests } from '../../hooks/board/pane'
import { resetBoardForTests, resolveRun } from '../../hooks/board/view'
import { openSwarmPane } from '../../hooks/swarm/panes'
import { noteSessionEnd, others, rebindSettled, rebound, resetClearForTests } from '../../hooks/clear'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

// The rebind registers the roles and tools again; a loaded machine is slow.
setDefaultTimeout(120_000)

const NOW = 1_800_000_000_000
const MIN = 60_000
const cleanups: (() => void)[] = []

afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  updateSession({ litterDir: null, litterDirError: null })
})

function scratchDir(): string {
  const s = scratch()
  cleanups.push(s.cleanup)
  return s.dir
}

// ---------------------------------------------------------------------------

describe('the new nodePorts fakes', () => {
  test('notice records each call and answers noticeAnswer', () => {
    const p = nodePorts()
    expect(p.notice('toolu_1', '⚑ G2 executor asking')).toBe(true)
    p.noticeAnswer = false
    expect(p.notice('toolu_1', undefined)).toBe(false)
    expect(p.notices).toEqual([
      { toolUseId: 'toolu_1', text: '⚑ G2 executor asking' },
      { toolUseId: 'toolu_1', text: undefined },
    ])
  })

  test('toolNames answers a copy of toolNamesValue, empty by default', async () => {
    const p = nodePorts()
    expect(await p.toolNames()).toEqual([])
    p.toolNamesValue = ['Bash', 'TaskUpdate']
    const got = await p.toolNames()
    expect(got).toEqual(['Bash', 'TaskUpdate'])
    got.pop()
    expect(p.toolNamesValue).toEqual(['Bash', 'TaskUpdate'])
  })

  test('envVar answers from envValues; a name left out is unset', async () => {
    const p = nodePorts()
    expect(await p.envVar('CLAUDE_CODE_TASK_LIST_ID')).toBeUndefined()
    p.envValues.CLAUDE_CODE_TASK_LIST_ID = 'team-a'
    expect(await p.envVar('CLAUDE_CODE_TASK_LIST_ID')).toBe('team-a')
  })

  test('setView records the band, the cards and the two panes, each a copy, as it records the others', async () => {
    const p = nodePorts()
    const band: BandView = { view: 'band', v: 1, rows: [{ key: 'run:r', spans: [{ text: '▸ litter' }], buttons: [{ key: 'band:hide:r', label: 'Hide', hotkey: '2' }] }] }
    const cards: CardsView = { view: 'cards', v: 2, byTask: {} }
    await p.setView('band', band)
    await p.setView('cards', cards)
    await p.setView('tasks', { view: 'tasks', v: 3 })
    await p.setView('agents', null)
    band.v = 9
    expect(p.views).toEqual({ band: { ...band, v: 1 }, cards, tasks: { view: 'tasks', v: 3 }, agents: null })
  })

  test('send takes `{ agentId }` as well as a name, recorded and passed beneath as given', async () => {
    const p = nodePorts()
    const beneath: unknown[] = []
    p.sendAnswer = to => {
      beneath.push(to)
      return { isDelivered: true }
    }
    const to = { agentId: 'agent-7' }
    expect(await p.send(to, 'hello')).toEqual({ isDelivered: true })
    expect(await p.send('reviewer', 'hi')).toEqual({ isDelivered: true })
    to.agentId = 'changed'
    expect(p.sent).toEqual([
      { to: { agentId: 'agent-7' }, text: 'hello' },
      { to: 'reviewer', text: 'hi' },
    ])
    expect(beneath).toEqual([{ agentId: 'changed' }, 'reviewer'])
    const hooked: unknown[] = []
    p.sendHook = (t, x, deliver) => {
      hooked.push(t)
      return deliver(t, x)
    }
    await p.send({ agentId: 'agent-8' }, 'again')
    expect(hooked).toEqual([{ agentId: 'agent-8' }])
  })
})

// ---------------------------------------------------------------------------

describe("the spool's ask line", () => {
  const ask = (extra: Record<string, unknown> = {}) => ({
    v: 1,
    ev: 'ask',
    ts: 1_700_000_000,
    session_id: 'test-session',
    agent_id: 'a1',
    agent_type: 'litter:executor',
    tool: 'Bash',
    detail: 'npm install left-pad',
    mode: 'default',
    ...extra,
  })

  test('reaches every consumer through the real drain; one with no agent_id or tool is skipped as bad', async () => {
    const p = nodePorts()
    const dir = scratchDir()
    mkdirSync(spoolDir(dir), { recursive: true })
    const lines = [ask(), ask({ agent_type: null, detail: '', mode: null }), ask({ tool: '' }), ask({ agent_id: undefined })]
    writeFileSync(spoolPath(dir, 'test-session'), `${lines.map(l => JSON.stringify(l)).join('\n')}\n`)
    const got: SpoolLine[] = []
    const collect: SpoolConsumer = async (_ctx, l) => void got.push(l)
    expect(await drainSpool({ p, litterDir: dir, sessionId: 'test-session' }, [collect, consumeAsks])).toEqual({ lines: 4, bad: 2 })
    expect(got.map(l => (l.ev === 'ask' ? [l.agent_id, l.agent_type, l.tool, l.detail, l.mode] : null))).toEqual([
      ['a1', 'litter:executor', 'Bash', 'npm install left-pad', 'default'],
      ['a1', null, 'Bash', '', null],
    ])
  })

  test('consumeAsks drains right after the in-flight flag, and the agent map stays first', () => {
    expect(SPOOL_CONSUMERS[0]).toBe(consumeAgents)
    expect(SPOOL_CONSUMERS.indexOf(consumeInflight)).toBe(1)
    expect(SPOOL_CONSUMERS.indexOf(consumeAsks)).toBe(2)
  })
})

// ---------------------------------------------------------------------------

/** What a handler stub must pass: the event, to `next`, answered as `next` answered. */
function passes<E>(): { next: (e: E) => Promise<{ passed: E }>; seen: E[] } {
  const seen: E[] = []
  return { seen, next: async (e: E) => (seen.push(e), { passed: e }) }
}

const bandE = { surface: 'terminal', component: 'AbovePrompt', requestId: 'above-prompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 95, scroll: { offset: 0, bodyRows: 9 }, view: {} } } as unknown as BandRender
const rowE = (props: Record<string, unknown>) => ({ surface: 'terminal', component: 'UserMessage', requestId: 'msg-1', props }) as unknown as CardRender

describe("CA's stubs keep today's behavior", () => {
  test('the band: never shown, `below` drawn as it came, its tick and refresh write nothing, a press passes on', async () => {
    const p = nodePorts()
    const view: BandView = { view: 'band', v: 1, rows: [{ key: 'run:r', spans: [{ text: '▸' }], buttons: [] }] }
    expect(bandShows(null, bandE)).toBe(false)
    expect(bandShows(view, bandE)).toBe(false)
    const below = { type: 'Text', props: { children: ['beneath'] } } as unknown as RenderElement
    expect(renderBand(view, {} as never, bandE, below)).toBe(below)
    await bandTick(p)
    await refreshBand(p)
    const { next, seen } = passes<unknown>()
    const e = { plugin: 'litter', element: 'band:board:r', component: 'AbovePrompt', requestId: 'above-prompt', surface: 'terminal' }
    expect(await onBandUi.press(p, e as never, next as never)).toEqual({ passed: e } as never)
    expect(seen).toEqual([e])
    expect(p.views).toEqual({})
    expect(p.logs).toEqual([])
  })

  test('the card: no row is a card, no card is drawn, the builders write nothing, a press passes on', async () => {
    const p = nodePorts()
    const notification = rowE({ text: 'done', origin: { kind: 'task-notification' }, isExpanded: false, task: { id: 'task-1', status: 'completed' } })
    expect(cardRow(notification)).toBe(false)
    expect(cardRow(rowE({ text: 'hi', origin: { kind: 'composer' }, isExpanded: false }))).toBe(false)
    const cards: CardsView = { view: 'cards', v: 1, byTask: { 'task-1': { taskId: 'task-1', run: '20261005-retry', title: [{ text: 'done' }], lines: [], buttons: [] } } }
    expect(renderCard(cards, {} as never, notification)).toBeNull()
    await noteCards(p, { text: '<task-notification></task-notification>', origin: { kind: 'task-notification' } } as never)
    await restoreCards(p)
    await refreshCards(p)
    const { next, seen } = passes<unknown>()
    const e = { plugin: 'litter', element: 'card:board:20261005-retry', component: 'UserMessage', requestId: 'msg-1', surface: 'terminal' }
    expect(await onCardUi.press(p, e as never, next as never)).toEqual({ passed: e } as never)
    expect(seen).toEqual([e])
    expect(p.views).toEqual({})
  })

  // WP-CE built the tasks pane and the store: what stays true of the pane is
  // that a key not its own passes on and, never opened, its tick and refresh
  // write nothing. The store's cases are teamstore.spec.ts's.
  test('the tasks pane: each ui handler passes a key not its own on; never opened, its tick and refresh write nothing', async () => {
    const p = nodePorts()
    expect(TASKS_PANE).toBe('litter-tasks')
    for (const event of ['message', 'press', 'input', 'select'] as const) {
      const { next, seen } = passes<unknown>()
      const e = { element: `x:${event}`, requestId: 'r' }
      expect(await onTasksUi[event](p, e as never, next as never)).toEqual({ passed: e } as never)
      expect(seen).toEqual([e])
    }
    await tasksTick(p)
    await refreshTasks(p)
    expect(p.panes.opened).toEqual([])
    expect(p.views).toEqual({})
  })

  test("the agents pane: its command answers its stub's line and opens nothing; each ui handler passes on", async () => {
    const p = nodePorts()
    const cmd = (command: string) => ({ command, args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } }) as never
    const never = (async () => {
      throw new Error('a command stub answers, never passing on')
    }) as never
    expect(await agentsCommand(p, cmd('litter-agents'), never)).toEqual({ text: "litter: the agents pane isn't built yet (WP-CG)" })
    expect([TASKS_PANE, AGENTS_PANE]).toEqual(['litter-tasks', 'litter-agents'])
    for (const handlers of [onAgentsUi]) {
      for (const event of ['message', 'press', 'input', 'select'] as const) {
        const { next, seen } = passes<unknown>()
        const e = { element: `x:${event}`, requestId: 'r' }
        expect(await handlers[event](p, e as never, next as never)).toEqual({ passed: e } as never)
        expect(seen).toEqual([e])
      }
    }
    await agentsTick(p)
    await refreshAgents(p)
    expect(p.panes.opened).toEqual([])
    expect(p.views).toEqual({})
  })

  test('the asks: none open, and restoring, ticking and consuming change nothing', async () => {
    const p = nodePorts()
    await restoreAsks(p)
    await asksTick(p)
    await consumeAsks({ p, litterDir: '/nowhere', sessionId: 's' }, { v: 1, ev: 'ask', ts: 1, session_id: 's', agent_id: 'a1', agent_type: null, tool: 'Bash', detail: 'x', mode: null })
    expect(openAsks()).toEqual([])
    expect(p.notices).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('openBoard, for the band and the card', () => {
  const OLDER = '20261004-older'
  const NEWER = '20261005-newer'
  let p: TestPorts
  let litterDir: string

  /** A fanout run: run.json and its run.start and run.launch, at the clock's time. */
  async function fanoutRun(run: string): Promise<void> {
    const dir = runDir(litterDir, run)
    const json = { v: 1, run, workflow: 'fanout', args: {}, authorized: [], mode: 'default', verify: ['true'], goalCheck: null, setup: null, linkDirs: [], base: '0'.repeat(40), ref: `refs/heads/litter/${run}`, checkout: litterDir, isolate: false, previousBranch: 'main', continueOf: null, amendOf: null, rules: [], planPath: null, planSha256: null, session: 's1', created: p.clock.now }
    for (const [kind, body] of [
      ['run.start', { workflow: 'fanout', base: '0'.repeat(40), ref: `refs/heads/litter/${run}`, checkout: litterDir, oid: 'd'.repeat(40), session: 's1' }],
      ['run.launch', { taskId: `t-${run}`, runId: `wf_${run}`, scriptPath: null, generation: 1, session: 's1', oid: 'd'.repeat(40) }],
    ] as const) {
      p.clock.now = (p.clock.now ?? NOW) + MIN
      await appendRecord(p, dir, { run, kind, by: MOD, body })
    }
    writeFileSync(runJsonPath(dir), `${JSON.stringify(json)}\n`)
  }

  beforeEach(async () => {
    state.resetForTests()
    resetBoardForTests()
    resetBoardPaneForTests()
    const dir = scratchDir()
    p = nodePorts({ sessionId: 's1', cwd: dir })
    p.clock.now = NOW
    litterDir = join(dir, '.claude', 'litter')
    updateSession({ litterDir, litterDirError: null })
  })

  afterEach(() => {
    resetBoardPaneForTests()
    resetBoardForTests()
    state.resetForTests()
  })

  test('opens the board on the run named, writing its view first', async () => {
    await fanoutRun(OLDER)
    p.clock.now = NOW + 100 * MIN
    await fanoutRun(NEWER)
    expect(await openBoard(p, OLDER)).toBe(true)
    const view = p.views.board as BoardView
    expect(view.run).toBe(OLDER)
    expect(view.body?.header?.workflow).toBe('fanout')
    expect(p.panes.opened).toEqual([{ id: BOARD_PANE, title: 'litter board' }])
  })

  test('on null, opens what /litter-board with no argument opens: here the newest run', async () => {
    await fanoutRun(OLDER)
    p.clock.now = NOW + 100 * MIN
    await fanoutRun(NEWER)
    expect((await resolveRun(p, litterDir, null)).run).toBe(NEWER)
    expect(await openBoard(p, null)).toBe(true)
    expect((p.views.board as BoardView).run).toBe(NEWER)
  })

  test("a run that isn't there opens the board on why", async () => {
    expect(await openBoard(p, '20990101-none')).toBe(true)
    const view = p.views.board as BoardView
    expect(view.run).toBeNull()
    expect(view.body?.notice?.text).toContain("there's no run 20990101-none")
  })

  test('with no litter directory, the board says so', async () => {
    updateSession({ litterDir: null, litterDirError: 'not a git checkout' })
    expect(await openBoard(p, null)).toBe(true)
    const view = p.views.board as BoardView
    expect(view.body?.notice).toEqual({ level: 'error', text: 'this session has no litter directory: not a git checkout' })
    expect(session().litterDir).toBeNull()
  })

  test("answers false when the pane isn't placed, and false with a log line when opening throws", async () => {
    await fanoutRun(OLDER)
    p.openPane = async () => false
    expect(await openBoard(p, OLDER)).toBe(false)
    p.openPane = async () => {
      throw new Error('ui.open refused')
    }
    expect(await openBoard(p, OLDER)).toBe(false)
    expect(p.logs.at(-1)).toBe(`board: it didn't open on run ${OLDER}: ui.open refused`)
  })
})

describe('openSwarmPane, for the band', () => {
  test("is exported as /litter-swarm's work: a name that isn't one is answered, opening nothing", async () => {
    const p = nodePorts()
    expect(await openSwarmPane(p, 'Not-A-Name')).toBe(`litter: "Not-A-Name" isn't a swarm name (a-z, 0-9 and -, up to 24, not starting with -)`)
    expect(p.panes.opened).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('the rebind after a /clear (clear.ts)', () => {
  beforeEach(() => {
    state.resetForTests()
    resetClearForTests()
  })
  afterEach(() => {
    state.resetForTests()
    resetClearForTests()
  })

  /** clear.ts's calls into the other packages, recorded in order; `fail` names one that throws. */
  function fakes(calls: string[], fail: string | null = null): void {
    const rec = (name: string) => async (_p: Ports) => {
      calls.push(name)
      if (name === fail) throw new Error(`${name} broke`)
    }
    Object.assign(others, {
      registerSwarmCommands: rec('registerSwarmCommands'),
      registerPhase3Commands: rec('registerPhase3Commands'),
      registerPhase5Commands: rec('registerPhase5Commands'),
      refreshPanes: rec('refreshPanes'),
      refreshBoard: rec('refreshBoard'),
      refreshBand: rec('refreshBand'),
      refreshCards: rec('refreshCards'),
      refreshTasks: rec('refreshTasks'),
      refreshAgents: rec('refreshAgents'),
    })
  }

  async function clearAndRebind(p: TestPorts, sid: { value: string }): Promise<void> {
    await noteSessionEnd(p, { sessionId: sid.value, reason: 'clear' } as never)
    sid.value = 'session-b'
    await rebound(p)
    await rebindSettled()
  }

  function ports(): { p: TestPorts; sid: { value: string } } {
    const p = nodePorts()
    const sid = { value: 'session-a' }
    p.sessionId = async () => sid.value
    state.setRecordedSession('session-a')
    return { p, sid }
  }

  test('registers /litter-tasks and /litter-agents after the other commands, then redraws the band, the cards and the two panes after the board', async () => {
    const calls: string[] = []
    fakes(calls)
    const { p, sid } = ports()
    await clearAndRebind(p, sid)
    expect(calls).toEqual([
      'registerSwarmCommands',
      'registerPhase3Commands',
      'registerPhase5Commands',
      'refreshPanes',
      'refreshBoard',
      'refreshBand',
      'refreshCards',
      'refreshTasks',
      'refreshAgents',
    ])
  })

  test('a step that throws is logged, and the steps after it still run', async () => {
    for (const fail of ['registerPhase5Commands', 'refreshCards']) {
      state.resetForTests()
      resetClearForTests()
      const calls: string[] = []
      fakes(calls, fail)
      const { p, sid } = ports()
      await clearAndRebind(p, sid)
      expect(calls.at(-1)).toBe('refreshAgents')
      expect(calls).toHaveLength(9)
      const why = fail === 'registerPhase5Commands' ? 'the tasks and agents commands' : 'the cards'
      expect(p.logs).toContain(`/clear rebind: ${why} failed: ${fail} broke`)
    }
  })
})
