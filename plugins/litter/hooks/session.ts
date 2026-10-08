// What the mod knows about the current session, kept in module memory.
// register() runs again on every reload and session.start fires after it, so
// this is rebuilt then. /clear fires no session.start but keeps the module, so
// this survives it; $.state doesn't (plan section 15.4, "After /clear").
// Anything that must outlive the process goes to $.store or the ledger.
//
// Contract owner: phase 1a.

import type { LitterOptions } from './options'
import { normalizeOptions } from './options'

export type SessionInfo = {
  /** null until session.start resolved it, or when it can't be (litterDirError says why). */
  litterDir: string | null
  litterDirError: string | null
  /** Set when $.tool.register was refused (e.g. managed allowedMcpServers): every litter launch is denied, naming it. */
  toolsRefused: string | null
  /**
   * Phase 2b: set when a swarm tool's registration was refused. Proposing and
   * launching a swarm are refused while it's set (J, K); runs don't depend on it.
   */
  swarmToolsRefused: string | null
  /** True once session.start has finished its steps. */
  ready: boolean
  /**
   * Which host runs litter: Claude Code (the mod), or Codex (litterd, design
   * D2). On Codex litter's agents are sessions litterd starts with their own
   * sandbox, which the lead's permission mode doesn't reach (D4).
   */
  host: 'claude-code' | 'codex'
}

let options: LitterOptions = normalizeOptions(undefined)
let info: SessionInfo = { litterDir: null, litterDirError: null, toolsRefused: null, swarmToolsRefused: null, ready: false, host: 'claude-code' }

export const getOptions = (): LitterOptions => options
export const setOptions = (raw: Readonly<Record<string, unknown>> | undefined): void => {
  options = normalizeOptions(raw)
}

export const session = (): Readonly<SessionInfo> => info
export const updateSession = (patch: Partial<SessionInfo>): void => {
  info = { ...info, ...patch }
}
