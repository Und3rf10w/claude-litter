// Phase 5's shared types that aren't $.state values (those are in
// types/index.d.ts): what two packages pass between them in module memory or
// through a call. Plain data.
//
// Contract owner: phase 5, WP-CA. A field that's missing is a contract
// change: say so in your report.

/** An open permission ask of a litter agent or node (CF builds them, and writes each one's transcript row; COMMON decision 1). */
export type AskEntry = {
  /** Stable: the spool line's agent and timestamp. */
  key: string
  agentId: string
  agentType: string | null
  tool: string
  /** The command or path, cleaned, at most 120 characters. */
  detail: string
  /** Once paired with guard.sh's call start; null until then. */
  toolUseId: string | null
  run: string | null
  role: string | null
  gate: string | null
  swarm: string | null
  node: string | null
  /** A node's child's Agent call description, cleaned, at most 60 characters; null for anyone else, or when the list doesn't have it. */
  description: string | null
  /** What the launch authorized, one line, at most 200 characters. */
  authorized: string
  /** When it opened, in ms. */
  since: number
}

/** A task list the tasks pane can show (CE; COMMON decision 15): this session's own, or a team's. */
export type TaskListRef = {
  /** The list's name as the engine names it (the env value, the team's name, or the session id). */
  name: string
  /** Absolute: `<configDir>/tasks/<name, sanitized>/`. */
  dir: string
  kind: 'session' | 'team'
  team: string | null
  /** This session's own list, where TaskUpdate edits (decision 4). */
  mine: boolean
}

/** One task file, `<list dir>/<id>.json`, as read. */
export type TaskFile = {
  id: string
  subject: string
  description: string
  activeForm: string | null
  owner: string | null
  status: string
  blocks: string[]
  blockedBy: string[]
  /** Absolute. */
  path: string
  mtimeMs: number
}

/** An inline edit: only the fields given change. */
export type TaskPatch = { subject?: string; description?: string; status?: 'pending' | 'in_progress' | 'completed'; owner?: string | null }

/** A team from `<configDir>/teams/<dir>/config.json` (CE reads, CG draws). */
export type TeamMember = { name: string; agentId: string | null; agentType: string | null; color: string | null }
export type TeamInfo = { name: string; dir: string; leadSessionId: string | null; members: TeamMember[]; mtimeMs: number }

/** One entry of an inbox, `<configDir>/teams/<team>/inboxes/<agent>.json`: an unread queue. */
export type InboxEntry = { from: string; text: string; timestamp: string; summary: string | null }

/** A task edit or an inbox append: through the engine's tool, or the locked direct write (COMMON decisions 4, 5). */
export type WriteResult = { ok: true; via: 'tool' | 'direct' } | { ok: false; error: string }
