// litter's hooks module: wiring only. Every `on(...)` the mod makes is here, so
// `claude plugin validate` and a reader see each event and matcher in one file.
//
// Rules for this file (plan sections 4 and 12):
//  - every tool.call hook has a literal `tool` matcher from the allowlist:
//    Workflow, TaskStop and litter's own mcp__litter__* tools. Never a broad
//    or RegExp tool.call hook: one would break every isolated agent it matches;
//  - every hook has a .catch. A policy hook's catch refuses what's litter's
//    and passes the rest on; any other hook's catch passes on;
//  - this is the only file that touches `$`. Validate follows `$` into a
//    function declared here but never across an import, so each hook is an
//    inline literal that builds the ports and calls its module's handler;
//  - no logic: each handler lives in its own module;
//  - every hook but session.start, session.end and the ui.render hooks
//    awaits O's `rebound` first, so the first hook after a /clear rebinds the
//    session (plan 15.4). A render can't: a rebind writes $.state. One
//    exception within agent.spawn: a teammate litter has no stake in passes
//    before it (spawn.ts, outsideTeammate).
//
// Contract owner: phase 1a; the swarm wiring is phase 2b-1's (package C), the
// repair wiring phase 2b-2's (package V), the UI wiring phase 5's (WP-CA),
// the one pane's phase 5b's (WP-DA).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallArgs } from 'claude-code'
import type {
  AgentsPaneView,
  BandView,
  BoardView,
  CardsView,
  DoctorPaneView,
  HubView,
  Ports,
  RulesPaneView,
  SpawnStream,
  Stat,
  SwarmPaneView,
  TasksPaneView,
} from './ports'
import type { HubSection } from '../types/index'
import type { SectionView } from './ui/pane'
import type { BandRenderCatch, CardRenderCatch } from './hooktypes'
import { getOptions, session, setOptions, updateSession } from './session'
import { SPOOL_CONSUMERS } from './registry'
import { recordFailed, recordTool, registerRecordTool } from './ledger'
import { drainAllSpools, drainOwnSpools, startDrainTimer, stopInterrupted } from './policy'
import { activePath } from './layout'
import { registerRoles } from './roles'
import { resolveLitterDir, writeGitignore } from './litterdir'
import { onSessionEnd, onTurnComplete, reconcileRuns, settleNotices } from './lifecycle'
import { repairNote, repairTurnComplete } from './repair'
import { cleanupLeftovers, startWorktreePolicy } from './worktrees'
import { roleSpawnRefusal, taskStop, taskStopFailed, workflowCheck, workflowCheckFailed } from './launch'
import { holdClear, noteSessionEnd, rebound, startSwarmTimers } from './clear'
import { attach, binding, notePromptOrigin, setInteractive, setRecordedSession, withGateClosed } from './swarm/state'
import { registerSwarmTools } from './swarm/tools'
import { clearPending } from './swarm/guard'
import { recoverSwarms } from './swarm/recover'
import { swarmReadTool } from './swarm/launch'
import { swarmProposeTool } from './swarm/propose'
import { outsideTeammate, swarmSpawn } from './swarm/spawn'
import { admitSend, admitStep, leadTurnStart, settleNode, swarmContext, swarmSendTool } from './swarm/admit'
import { observeNodeTurn } from './swarm/observe'
import { sweepNodePolicies } from './swarm/end'
import { startPaneTimer } from './swarm/panes'
import {
  agentOfferFailed,
  agentSpawnFailed,
  clearHoldFailed,
  litterCommandFailed,
  offerSwarmType,
  paneRenderFailed,
  sessionSendFailed,
  swarmProposeFailed,
  swarmReadFailed,
  swarmSendFailed,
  turnStartFailed,
  turnStepFailed,
  uiInputFailed,
  uiMessageFailed,
  uiPressFailed,
  uiSelectFailed,
} from './swarm/wiring'
import { registerLitterCommand } from './uicommands'
import { litterCommand, onLitterUi } from './ui/hub'
import { renderLitterPane, sectionShown } from './ui/pane'
import { startUiTimer } from './uitick'
import { restoreAsks } from './asks'
import { bandShows, onBandUi } from './band/view'
import { renderBand } from './band/render'
import { cardRow, noteCards, onCardUi, restoreCards } from './card/view'
import { cardOf, renderCard } from './card/render'

/**
 * The views (types/index.d.ts), written through `p.setView`: the `litter`
 * pane's sections' (package N's swarm and doctor, phase 3's board and rules
 * (AF), phase 5's tasks (CE) and agents (CG)), and phase 5's band (CB) and
 * cards (CC).
 */
const swarmPane = atom({ plugin: 'litter', key: 'swarmPane' } as const, null)
const doctorPane = atom({ plugin: 'litter', key: 'doctorPane' } as const, null)
const board = atom({ plugin: 'litter', key: 'board' } as const, null)
const rulesPane = atom({ plugin: 'litter', key: 'rulesPane' } as const, null)
const band = atom({ plugin: 'litter', key: 'band' } as const, null)
const cards = atom({ plugin: 'litter', key: 'cards' } as const, null)
const tasksPane = atom({ plugin: 'litter', key: 'tasksPane' } as const, null)
const agentsPane = atom({ plugin: 'litter', key: 'agentsPane' } as const, null)
/** Phase 5b's (WP-DA): the `litter` pane's own view, its section and strip (ui/hub.ts). */
const hub = atom({ plugin: 'litter', key: 'hub' } as const, null)

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** The shown section's view, from that section's atom alone (so a write to another doesn't redraw the pane); Home has none. */
async function sectionView($: EngineInterface, section: HubSection): Promise<SectionView | null> {
  if (section === 'runs') return read($, board)
  if (section === 'swarms') return read($, swarmPane)
  if (section === 'rules') return read($, rulesPane)
  if (section === 'tasks') return read($, tasksPane)
  if (section === 'agents') return read($, agentsPane)
  if (section === 'doctor') return read($, doctorPane)
  return null
}

/**
 * The band's and the card's render catches: next(e), as the pane's
 * paneRenderFailed, which is typed for `Pane` alone and so can't be theirs.
 */
const bandRenderFailed: BandRenderCatch = async ($, e, next) => next(e)
const cardRenderFailed: CardRenderCatch = async ($, e, next) => next(e)

/** The ports over this dispatch's `$` (ports.ts). */
function enginePorts($: EngineInterface): Ports {
  return {
    fs: {
      read: path => $.fs.read(path),
      write: (path, text) => $.fs.write(path, text),
      list: async path => (await $.fs.list(path)).map(e => ({ name: e.name, kind: e.kind, isLink: e.isLink })),
      exists: path => $.fs.exists(path),
      stat: async (path, options) => {
        const s = await $.fs.stat(path, options?.resolve ? { resolve: true } : undefined)
        const out: Stat = { kind: s.kind, size: s.size, mtimeMs: s.mtimeMs, isLink: s.isLink }
        if (s.realPath !== undefined) out.realPath = s.realPath
        return out
      },
    },
    run: async (argv, init) => {
      const r = await $.process.run(argv, init)
      return { code: r.exitCode, stdout: r.stdout, stderr: r.stderr, truncated: r.isStdoutTruncated || r.isStderrTruncated }
    },
    spawn: request => $.process.spawn(request) as SpawnStream,
    now: () => $.clock.now(),
    store: {
      get: key => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      delete: key => $.store.delete(key),
    },
    sessionId: () => $.session.id(),
    cwd: () => $.session.cwd(),
    pluginRoot: $.plugin.root,
    settings: () => $.settings.read(),
    // The engine writes `[litter] $.ui.log (to debug): <text>` (2.1.290), so no prefix of litter's own.
    log: text => $.ui.log(text, { to: 'debug' }),
    registerTool: async spec => {
      await $.tool.register(spec)
    },
    registerAgent: async spec => {
      await $.agent.register(spec)
    },
    every: (ms, fn) => $.clock.every(ms, fn),
    ask: (question, options) => $.ui.ask(question, options),

    // Phase 2b, for swarms.
    listAgents: () => $.agent.list(),
    send: (to, text) => $.session.send({ to, text }),
    appendUserRow: async text => {
      const r = await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
      if (r.deny !== undefined) throw new Error(`the row wasn't appended: ${r.deny}`)
    },
    submitPrompt: async text => {
      const r = await $.prompt.submit({ text })
      if (r.drop !== undefined) throw new Error(`the prompt was dropped: ${r.drop}`)
    },
    fillPrompt: async text => (await $.prompt.fill({ text })).isFilled,
    messages: async agentId => {
      if (agentId === undefined) return $.session.messages()
      const r = await $.session.messages({ agentId })
      return Array.isArray(r) ? r : null
    },
    complete: request => $.model.complete(request),
    callTool: (tool, input) => $.tool.call({ ...input, tool } as unknown as ToolCallArgs),
    sleep: ms => $.clock.sleep(ms),
    after: (ms, fn) => $.clock.after(ms, fn),
    limits: async () => ({
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: await $.env.get('CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH'),
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: await $.env.get('CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'),
      CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: await $.env.get('CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY'),
      CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: await $.env.get('CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION'),
    }),
    settingsFrom: async source => {
      const s = await $.settings.read({ source })
      return Object.keys(s).length === 0 ? null : s
    },
    configDir: async () => {
      const dir = await $.env.get('CLAUDE_CONFIG_DIR')
      if (dir !== undefined && dir !== '') {
        if (!dir.startsWith('/')) throw new Error(`CLAUDE_CONFIG_DIR isn't an absolute path: ${dir}`)
        return dir.replace(/\/+$/, '')
      }
      const home = await $.env.get('HOME')
      if (home === undefined || !home.startsWith('/')) throw new Error('neither CLAUDE_CONFIG_DIR nor an absolute HOME is set')
      return `${home.replace(/\/+$/, '')}/.claude`
    },
    registerCommand: async spec => {
      await $.command.register(spec)
    },
    openPane: async (id, title, focus) => (await $.ui.open({ id, title, ...(focus === true ? { focus: true } : {}) })).isPlaced,
    paneOpen: async id => (await $.ui.panes()).some(pane => pane.id === id),
    closePane: id => $.ui.close({ id }),
    toast: text => $.ui.toast(text),
    // `to` left out: the transcript (the d.ts's default).
    note: text => $.ui.log(text),
    copy: async text => (await $.ui.copy({ text })).isCopied,
    setView: async (pane, view) => {
      if (pane === 'swarm') await update($, swarmPane, () => view as SwarmPaneView | null)
      else if (pane === 'doctor') await update($, doctorPane, () => view as DoctorPaneView | null)
      else if (pane === 'board') await update($, board, () => view as BoardView | null)
      else if (pane === 'rules') await update($, rulesPane, () => view as RulesPaneView | null)
      else if (pane === 'band') await update($, band, () => view as BandView | null)
      else if (pane === 'cards') await update($, cards, () => view as CardsView | null)
      else if (pane === 'tasks') await update($, tasksPane, () => view as TasksPaneView | null)
      else if (pane === 'hub') await update($, hub, () => view as HubView | null)
      else await update($, agentsPane, () => view as AgentsPaneView | null)
    },

    // Phase 5 (WP-CA).
    notice: (toolUseId, text) => {
      // Fire-and-forget in 2.1.289: a refusal is a debug-log warning, never a throw (ports.ts).
      try {
        $.ui.notice(toolUseId, text)
        return true
      } catch {
        return false
      }
    },
    toolNames: async () => (await $.tool.list()).map(t => t.name),
    envVar: async name => (name === 'CLAUDE_CODE_TASK_LIST_ID' ? $.env.get('CLAUDE_CODE_TASK_LIST_ID') : undefined),
  }
}

/**
 * Drains this session's spools before a hook that reads what they carry (the
 * launch check, the task notification), while a run is active. It lives here,
 * not in launch.ts or lifecycle.ts, because the registry imports those two.
 */
async function drainFirst(p: Ports): Promise<void> {
  const litterDir = session().litterDir
  if (!litterDir) return
  try {
    if (await p.fs.exists(activePath(litterDir))) await drainOwnSpools(p, litterDir, SPOOL_CONSUMERS)
  } catch (err) {
    p.log(`drain before the hook failed: ${errText(err)}`)
  }
}

/**
 * A subagent's interrupted turn: its stop, while a run is active, since no
 * SubagentStop reports it (policy.ts, stopInterrupted). Here for the same
 * reason as drainFirst.
 */
async function interrupted(p: Ports, agentId: string): Promise<void> {
  const litterDir = session().litterDir
  if (!litterDir) return
  try {
    if (await p.fs.exists(activePath(litterDir))) await stopInterrupted(p, litterDir, agentId, SPOOL_CONSUMERS)
  } catch (err) {
    p.log(`interrupted agent ${agentId}: its stop wasn't counted: ${errText(err)}`)
  }
}

/** One session.start step: a failure is logged and the next step still runs. */
async function step(p: Ports, name: string, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (err) {
    p.log(`session.start ${name} failed: ${errText(err)}`)
  }
}

/** One part of a hook that mustn't stop the parts after it: a failure is logged. */
async function apart(p: Ports, name: string, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (err) {
    p.log(`${name} failed: ${errText(err)}`)
  }
}

export const register: Register = (on, options) => {
  setOptions(options as Readonly<Record<string, unknown>>)

  on('session.start', async ($, e, next) => {
    const p = enginePorts($)
    updateSession({ ready: false })
    // Whether anyone is at the prompt to watch a repair (2b-2, decision 15).
    if (typeof e.isInteractive === 'boolean') setInteractive(e.isInteractive)
    // Recovery re-registers the swarms' types while the gate holds sends and
    // node turns (15.4); it opens right after, not after the slower steps.
    // withGateClosed opens it once: at openGateNow, or when the steps end if
    // one threw before that (the gate is a counter).
    await withGateClosed(async openGateNow => {
      await step(p, 'tools', async () => {
        updateSession({ toolsRefused: await registerRecordTool(p) })
      })
      await step(p, 'swarm tools', async () => {
        updateSession({ swarmToolsRefused: await registerSwarmTools(p) })
      })
      await step(p, 'roles', async () => {
        const { failed } = await registerRoles(p)
        for (const f of failed) p.log(`role ${f.role} not registered: ${f.reason}`)
      })
      // Phase 5b (WP-DA): /litter, the one command (it replaced the six pane commands).
      await step(p, 'litter command', () => registerLitterCommand(p))
      await step(p, 'litterDir', async () => {
        const r = await resolveLitterDir(p, e.cwd)
        updateSession(r.ok ? { litterDir: r.litterDir, litterDirError: null } : { litterDir: null, litterDirError: r.error })
      })
      const litterDir = session().litterDir
      await step(p, 'swarm state', async () => {
        if (litterDir) attach(p, litterDir)
        setRecordedSession(await p.sessionId())
      })
      if (litterDir) {
        await step(p, 'swarm pending', () => clearPending(p, litterDir))
        await step(p, 'swarms', () => recoverSwarms(p, litterDir))
      }
      openGateNow()
      if (litterDir) {
        await step(p, 'worktree.json', () => startWorktreePolicy(p, litterDir))
        await step(p, '.gitignore', () => writeGitignore(p, litterDir))
        await step(p, 'drain', () => drainAllSpools(p, litterDir, SPOOL_CONSUMERS))
        await step(p, 'reconcile', () => reconcileRuns(p, litterDir))
        await step(p, 'leftover worktrees', () => cleanupLeftovers(p, litterDir))
        // After recovery, so policy.json's entries say which swarms are live (FIX-U, U1).
        await step(p, 'leftover node policies', () => sweepNodePolicies(p, litterDir))
      }
      await step(p, 'options', async () => {
        // The trailers option's lines that aren't `Key: value`, once per session (decision 4).
        const dropped = getOptions().trailersDropped
        if (dropped.length > 0) p.log(`the trailers option's lines that aren't one Key: value each were dropped: ${dropped.map(l => JSON.stringify(l.slice(0, 80))).join(', ')}`)
      })
      await step(p, 'timers', async () => startDrainTimer(p, SPOOL_CONSUMERS))
      await step(p, 'swarm timers', async () => startSwarmTimers(p))
      await step(p, 'pane timer', async () => startPaneTimer(p))
      // Phase 5 (WP-CA): the open asks and the cards back, and the ui tick (which refreshes the `litter` pane, WP-DA).
      await step(p, 'asks', () => restoreAsks(p))
      await step(p, 'cards', () => restoreCards(p))
      await step(p, 'ui timer', async () => startUiTimer(p))
    })
    updateSession({ ready: true })
    return next(e)
  }).catch(($, e, next) => next(e))

  // The rebind flag at a /clear (O), then the run lease as before.
  on('session.end', async ($, e, next) => {
    const p = enginePorts($)
    await apart(p, 'session.end swarm', () => noteSessionEnd(p, e))
    return onSessionEnd(p, e, next)
  }).catch(($, e, next) => next(e))

  // The record tool, answered in the hook, never through next(e).
  on('tool.call', { tool: 'mcp__litter__record' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return recordTool(p, e, next)
  }).catch(recordFailed)

  // The three swarm tools, answered in their hooks, never through next(e) (plan 15.4).
  on('tool.call', { tool: 'mcp__litter__swarm_propose' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return swarmProposeTool(p, e, next)
  }).catch(swarmProposeFailed)

  on('tool.call', { tool: 'mcp__litter__swarm_read' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    await drainFirst(p)
    return swarmReadTool(p, e, next)
  }).catch(swarmReadFailed)

  on('tool.call', { tool: 'mcp__litter__swarm_send' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    await drainFirst(p)
    return swarmSendTool(p, e, next)
  }).catch(swarmSendFailed)

  // The launch check (main thread only: Workflow isn't a subagent tool).
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    await drainFirst(p)
    return workflowCheck(p, e, next)
  }).catch(workflowCheckFailed)

  // Observes a stop of a run's task: run.stopping, then run.end once settled.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return taskStop(p, e, next)
  }).catch(taskStopFailed)

  // The main thread can't spawn litter roles; then the swarm's spawn check, with
  // the engine's own `next`. A rendezvous, so it keeps the spawner's context.
  // A teammate litter has no stake in passes first, waiting on no rebind.
  on('agent.spawn', async ($, e, next) => {
    if (outsideTeammate(e)) return next(e)
    const p = enginePorts($)
    await rebound(p)
    const refused = roleSpawnRefusal(e)
    if (refused !== null) return { deny: refused }
    return swarmSpawn(p, e, next)
  }).catch(agentSpawnFailed)

  // Admission for sends to and from swarm nodes (plan 15.4, "Messages").
  on('session.send', async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return admitSend(p, e, next)
  }).catch(sessionSendFailed)

  // Every model request of every loop: a node's wake is admitted at its first step (15.9, item 15).
  on('turn.step', async function* ($, e, next) {
    const p = enginePorts($)
    await rebound(p)
    return yield* admitStep(p, e, next)
  }).catch(turnStepFailed)

  // The main loop's turn (the d.ts: a subagent's raises none): the lead is busy.
  on('turn.start', async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    await leadTurnStart(p, e)
    return next(e)
  }).catch(turnStartFailed)

  // A run's completion notification: run.end and summary.md before the launcher's
  // turn. While a swarm is live, the lead's <swarm> block rides in `context`.
  // In this order (2b-2): the notice settles first, since a halted fanout's
  // may start a repair swarm; then its run's card (phase 5, CC); then the
  // block, which shows the repair swarm; then X's note.
  on('prompt.submit', async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    await drainFirst(p)
    notePromptOrigin(e.origin)
    await settleNotices(p, e)
    await apart(p, 'prompt.submit cards', () => noteCards(p, e))
    const block = await swarmContext(p).catch((err: unknown) => {
      p.log(`prompt.submit swarm context failed: ${errText(err)}`)
      return null
    })
    let note: string | null = null
    try {
      note = repairNote(p)
    } catch (err) {
      p.log(`prompt.submit repair note failed: ${errText(err)}`)
    }
    const extra = [block, note].filter((x): x is string => typeof x === 'string' && x !== '')
    return next(extra.length === 0 ? e : { ...e, context: [...(e.context ?? []), ...extra] })
  }).catch(($, e, next) => next(e))

  // A main turn that ends with a launch pending and no Workflow call releases the lock.
  // A subagent's interrupted turn is its stop, which settles a stopping run.
  // A swarm node's turn settles its place (L), then P observes it.
  on('turn.complete', async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    if (e.agentId !== undefined && e.isAborted) await interrupted(p, e.agentId)
    await apart(p, 'turn.complete settle', () => settleNode(p, e))
    if (e.agentId !== undefined && binding(e.agentId) !== null) await apart(p, 'turn.complete observe', () => observeNodeTurn(p, e))
    // The repair swarm's start, scheduled once the notification turn that started it ends (2b-2, X).
    await apart(p, 'turn.complete repair', () => repairTurnComplete(p, e))
    return onTurnComplete(p, e, next)
  }).catch(($, e, next) => next(e))

  // Hides the types of a swarm that isn't live and owned here.
  on('agent.offer', async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return offerSwarmType(p, e, next)
  }).catch(agentOfferFailed)

  // /clear is held while a swarm's or a run's agents are running (O).
  on('command.run', { command: 'clear' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    await drainFirst(p)
    return holdClear(p, e, next)
  }).catch(clearHoldFailed)

  // Phase 5b (WP-DA): /litter [section] [arg], the one command, registered at
  // session.start and after a /clear (it replaced the six pane commands).
  on('command.run', { command: 'litter' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return litterCommand(p, e, next)
  }).catch(litterCommandFailed)

  // The one pane, `litter`: the hub's chrome over the shown section's body
  // (ui/pane.tsx), from the hub's atom and that section's. A render doesn't
  // await `rebound`: $.state.set is refused while a render draws (d.ts), and
  // a rebind's refreshes write the atoms. The next hook of any other kind
  // rebinds.
  on('ui.render', { component: 'Pane', requestId: 'litter' }, async ($, e, next) => {
    const view = await read($, hub)
    return renderLitterPane(view, await sectionView($, sectionShown(view)), $.ui.resolve(e), e)
  }).catch(paneRenderFailed)

  // The pane's presses, fields, picks and Client posts: the hub answers its
  // strip and routes the rest to the shown section (ui/hub.ts's key rule).
  on('ui.message', { requestId: 'litter' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return onLitterUi.message(p, e, next)
  }).catch(uiMessageFailed)

  on('ui.press', { requestId: 'litter' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return onLitterUi.press(p, e, next)
  }).catch(uiPressFailed)

  on('ui.input', { requestId: 'litter' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return onLitterUi.input(p, e, next)
  }).catch(uiInputFailed)

  on('ui.select', { requestId: 'litter' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return onLitterUi.select(p, e, next)
  }).catch(uiSelectFailed)

  // Phase 5 (WP-CA). The band above the prompt (CB): litter's rows over the
  // tree the plugins beneath draw, which it awaits and keeps below its own;
  // with nothing of litter's to show, theirs alone. A render: no `rebound`.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const view = await read($, band)
    if (!bandShows(view, e)) return next(e)
    return renderBand(view, $.ui.resolve(e), e, await next(e))
  }).catch(bandRenderFailed)

  // The finished-run card (CC). It runs for every message row, so its first
  // check is synchronous and cheap; a row with no card is the engine's. An
  // expanded row (ctrl+o, or `verbose`) draws the card above the engine's
  // own, so both show (decision 8, revised by WP-CK).
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!cardRow(e)) return next(e)
    const card = cardOf(await read($, cards), e)
    if (card === null) return next(e)
    return renderCard(card, $.ui.resolve(e), e.props.isExpanded ? await next(e) : null)
  }).catch(cardRenderFailed)

  // Their presses: any plugin's button in the band or a row; keys not `band:` or `card:` pass on.
  on('ui.press', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return onBandUi.press(p, e, next)
  }).catch(uiPressFailed)

  on('ui.press', { component: 'UserMessage' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return onCardUi.press(p, e, next)
  }).catch(uiPressFailed)
}
