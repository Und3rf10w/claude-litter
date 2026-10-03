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
//  - every hook but session.start, session.end and the two ui.render hooks
//    awaits O's `rebound` first, so the first hook after a /clear rebinds the
//    session (plan 15.4). A render can't: a rebind writes $.state.
//
// Contract owner: phase 1a; the swarm wiring is phase 2b-1's (package C), the
// repair wiring phase 2b-2's (package V).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallArgs } from 'claude-code'
import type { DoctorPaneView, Ports, SpawnStream, Stat, SwarmPaneView } from './ports'
import { session, setOptions, updateSession } from './session'
import { SPOOL_CONSUMERS } from './registry'
import { recordFailed, recordTool, registerRecordTool } from './ledger'
import { drainAllSpools, drainOwnSpools, startDrainTimer, stopInterrupted } from './policy'
import { activePath } from './layout'
import { registerRoles } from './roles'
import { resolveLitterDir } from './litterdir'
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
import { swarmSpawn } from './swarm/spawn'
import { admitSend, admitStep, leadTurnStart, settleNode, swarmContext, swarmSendTool } from './swarm/admit'
import { observeNodeTurn } from './swarm/observe'
import { sweepNodePolicies } from './swarm/end'
import {
  doctorCommand,
  onUiInput,
  onUiMessage,
  onUiPress,
  onUiSelect,
  registerSwarmCommands,
  startPaneTimer,
  swarmCommand,
} from './swarm/panes'
import { renderSwarmPane } from './swarm/browser'
import { renderDoctorPane } from './swarm/doctorpane'
import {
  agentOfferFailed,
  agentSpawnFailed,
  clearHoldFailed,
  doctorCommandFailed,
  offerSwarmType,
  paneRenderFailed,
  sessionSendFailed,
  swarmCommandFailed,
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

/** The two panes' views (types/index.d.ts); package N writes them through `p.setView`. */
const swarmPane = atom({ plugin: 'litter', key: 'swarmPane' } as const, null)
const doctorPane = atom({ plugin: 'litter', key: 'doctorPane' } as const, null)

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

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
    log: text => $.ui.log(`litter: ${text}`, { to: 'debug' }),
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
    openPane: async (id, title) => (await $.ui.open({ id, title })).isPlaced,
    closePane: id => $.ui.close({ id }),
    toast: text => $.ui.toast(text),
    copy: async text => (await $.ui.copy({ text })).isCopied,
    setView: async (pane, view) => {
      if (pane === 'swarm') await update($, swarmPane, () => view as SwarmPaneView | null)
      else await update($, doctorPane, () => view as DoctorPaneView | null)
    },
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
      await step(p, 'swarm commands', () => registerSwarmCommands(p))
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
        await step(p, 'drain', () => drainAllSpools(p, litterDir, SPOOL_CONSUMERS))
        await step(p, 'reconcile', () => reconcileRuns(p, litterDir))
        await step(p, 'leftover worktrees', () => cleanupLeftovers(p, litterDir))
        // After recovery, so policy.json's entries say which swarms are live (FIX-U, U1).
        await step(p, 'leftover node policies', () => sweepNodePolicies(p, litterDir))
      }
      await step(p, 'timers', async () => startDrainTimer(p, SPOOL_CONSUMERS))
      await step(p, 'swarm timers', async () => startSwarmTimers(p))
      await step(p, 'pane timer', async () => startPaneTimer(p))
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
  on('agent.spawn', async ($, e, next) => {
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
  // may start a repair swarm; then the block, which shows it; then X's note.
  on('prompt.submit', async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    await drainFirst(p)
    notePromptOrigin(e.origin)
    await settleNotices(p, e)
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

  // The swarm commands (N registers them at session.start).
  on('command.run', { command: 'litter-swarm' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return swarmCommand(p, e, next)
  }).catch(swarmCommandFailed)

  on('command.run', { command: 'litter-doctor' }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return doctorCommand(p, e, next)
  }).catch(doctorCommandFailed)

  // The two panes: N's pure renderers, over the views in $.state. These two
  // are the hooks that don't await `rebound`: $.state.set is refused while a
  // render draws (d.ts), and a rebind's refreshPanes writes the pane atoms.
  // The next hook of any other kind rebinds.
  on('ui.render', { component: 'Pane', requestId: 'litter-swarm' }, async ($, e, next) => {
    return renderSwarmPane(await read($, swarmPane), $.ui.resolve(e), e)
  }).catch(paneRenderFailed)

  on('ui.render', { component: 'Pane', requestId: 'litter-doctor' }, async ($, e, next) => {
    return renderDoctorPane(await read($, doctorPane), $.ui.resolve(e), e)
  }).catch(paneRenderFailed)

  // The panes' presses, fields, picks and the tree's posts (N).
  on('ui.message', { requestId: ['litter-swarm', 'litter-doctor'] }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return onUiMessage(p, e, next)
  }).catch(uiMessageFailed)

  on('ui.press', { requestId: ['litter-swarm', 'litter-doctor'] }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return onUiPress(p, e, next)
  }).catch(uiPressFailed)

  on('ui.input', { requestId: ['litter-swarm', 'litter-doctor'] }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return onUiInput(p, e, next)
  }).catch(uiInputFailed)

  on('ui.select', { requestId: ['litter-swarm', 'litter-doctor'] }, async ($, e, next) => {
    const p = enginePorts($)
    await rebound(p)
    return onUiSelect(p, e, next)
  }).catch(uiSelectFailed)
}
