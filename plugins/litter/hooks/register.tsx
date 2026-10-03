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
//  - no logic: each handler lives in its own module.
//
// Contract owner: phase 1a.

import type { EngineInterface, Register } from 'claude-code'
import type { Ports, SpawnStream, Stat } from './ports'
import { session, setOptions, updateSession } from './session'
import { SPOOL_CONSUMERS } from './registry'
import { recordFailed, recordTool, registerRecordTool } from './ledger'
import { drainAllSpools, drainOwnSpools, startDrainTimer, stopInterrupted } from './policy'
import { activePath } from './layout'
import { registerRoles } from './roles'
import { resolveLitterDir } from './litterdir'
import { onPromptSubmit, onSessionEnd, onTurnComplete, reconcileRuns } from './lifecycle'
import { cleanupLeftovers, startWorktreePolicy } from './worktrees'
import { spawnBlock, spawnBlockFailed, taskStop, taskStopFailed, workflowCheck, workflowCheckFailed } from './launch'

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
    p.log(`drain before the hook failed: ${err instanceof Error ? err.message : String(err)}`)
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
    p.log(`interrupted agent ${agentId}: its stop wasn't counted: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** One session.start step: a failure is logged and the next step still runs. */
async function step(p: Ports, name: string, work: () => Promise<void>): Promise<void> {
  try {
    await work()
  } catch (err) {
    p.log(`session.start ${name} failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export const register: Register = (on, options) => {
  setOptions(options as Readonly<Record<string, unknown>>)

  on('session.start', async ($, e, next) => {
    const p = enginePorts($)
    updateSession({ ready: false })
    await step(p, 'tools', async () => {
      updateSession({ toolsRefused: await registerRecordTool(p) })
    })
    await step(p, 'roles', async () => {
      const { failed } = await registerRoles(p)
      for (const f of failed) p.log(`role ${f.role} not registered: ${f.reason}`)
    })
    await step(p, 'litterDir', async () => {
      const r = await resolveLitterDir(p, e.cwd)
      updateSession(r.ok ? { litterDir: r.litterDir, litterDirError: null } : { litterDir: null, litterDirError: r.error })
    })
    const litterDir = session().litterDir
    if (litterDir) {
      await step(p, 'worktree.json', () => startWorktreePolicy(p, litterDir))
      await step(p, 'drain', () => drainAllSpools(p, litterDir, SPOOL_CONSUMERS))
      await step(p, 'reconcile', () => reconcileRuns(p, litterDir))
      await step(p, 'leftover worktrees', () => cleanupLeftovers(p, litterDir))
    }
    await step(p, 'timers', async () => startDrainTimer(p, SPOOL_CONSUMERS))
    updateSession({ ready: true })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => onSessionEnd(enginePorts($), e, next)).catch(($, e, next) => next(e))

  // The record tool, answered in the hook, never through next(e).
  on('tool.call', { tool: 'mcp__litter__record' }, async ($, e, next) => recordTool(enginePorts($), e, next)).catch(
    recordFailed,
  )

  // The launch check (main thread only: Workflow isn't a subagent tool).
  on('tool.call', { tool: 'Workflow' }, async ($, e, next) => {
    const p = enginePorts($)
    await drainFirst(p)
    return workflowCheck(p, e, next)
  }).catch(workflowCheckFailed)

  // Observes a stop of a run's task: run.stopping, then run.end once settled.
  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => taskStop(enginePorts($), e, next)).catch(taskStopFailed)

  // The main thread can't spawn litter roles. A rendezvous, so it keeps the spawner's context.
  on('agent.spawn', async ($, e, next) => spawnBlock(enginePorts($), e, next)).catch(spawnBlockFailed)

  // A run's completion notification: run.end and summary.md before the launcher's turn.
  on('prompt.submit', async ($, e, next) => {
    const p = enginePorts($)
    await drainFirst(p)
    return onPromptSubmit(p, e, next)
  }).catch(($, e, next) => next(e))

  // A main turn that ends with a launch pending and no Workflow call releases the lock.
  // A subagent's interrupted turn is its stop, which settles a stopping run.
  on('turn.complete', async ($, e, next) => {
    const p = enginePorts($)
    if (e.agentId !== undefined && e.isAborted) await interrupted(p, e.agentId)
    return onTurnComplete(p, e, next)
  }).catch(($, e, next) => next(e))
}
