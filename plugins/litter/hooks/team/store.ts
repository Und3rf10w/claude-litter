// The one module that reads and writes the engine's task files, team configs
// and inboxes under `<configDir>` (phase 5; COMMON decisions 4, 5, 15). Every
// path is built here from p.configDir(), each name through the engine's
// sanitizing rule and a check that it stays inside its folder; every write
// is TaskUpdate through p.callTool, or hooks/teamfile.sh under the engine's
// own lock, never p.fs.write. Owner: WP-CE; the tasks pane (CE) and the
// agents pane (CG) call it.
//
// CA's stub: the reads answer empty, the writes refuse.

import type { Ports } from '../ports'
import type { InboxEntry, TaskFile, TaskListRef, TaskPatch, TeamInfo, WriteResult } from '../uitypes'

const NOT_BUILT: WriteResult = { ok: false, error: 'not built yet (WP-CE)' }

/** This session's own list first (decision 15), then each team's with a config.json, newest first, at most 20. */
export async function taskLists(p: Ports): Promise<TaskListRef[]> {
  return []
}

/** A list's tasks, what couldn't be read, and a stamp of the folder's listing and the files' sizes and mtimes (decision 16). */
export async function readTasks(p: Ports, list: TaskListRef): Promise<{ tasks: TaskFile[]; problems: string[]; stamp: string }> {
  return { tasks: [], problems: [], stamp: '' }
}

/** One task's edit: TaskUpdate when it's this session's list and the tool is there, else the locked direct write (decision 4). `id` matches `^[0-9]+$`. */
export async function updateTask(p: Ports, list: TaskListRef, id: string, patch: TaskPatch): Promise<WriteResult> {
  return NOT_BUILT
}

/** Each team in `<configDir>/teams/` with a readable config.json, newest first. */
export async function teams(p: Ports): Promise<TeamInfo[]> {
  return []
}

/** An agent's inbox (`team` and `agent` as the team's config names them; both sanitized here), with a stamp; null when there's none to read. */
export async function readInbox(p: Ports, team: string, agent: string): Promise<{ entries: InboxEntry[]; stamp: string } | null> {
  return { entries: [], stamp: '' }
}

/** A locked append of `{ from, text, timestamp, summary? }` to an agent's inbox, for a team this session doesn't lead (decision 5). */
export async function appendInbox(p: Ports, team: string, agent: string, entry: { from: string; text: string; summary?: string }): Promise<WriteResult> {
  return NOT_BUILT
}
