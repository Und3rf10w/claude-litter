// The one module that reads and writes the engine's task files, team configs
// and inboxes under `<configDir>` (phase 5; COMMON decisions 4, 5, 15). Every
// path is built here from p.configDir(), each name through the engine's
// sanitizing rule and a check that it stays inside its folder; every write
// is TaskUpdate through p.callTool, or hooks/teamfile.sh under the engine's
// own lock, never p.fs.write. Owner: WP-CE; the tasks pane (CE) and the
// agents pane (CG) call it.
//
// What 2.1.289 does, from its source (cli_formatted_2.1.289.js):
// - a list's name (`GE`, :359813): CLAUDE_CODE_TASK_LIST_ID, else the team
//   this process is in or leads, else the session id. Its folder (`LD`,
//   :359822) is `<configDir>/tasks/<name>` with every character outside
//   [A-Za-z0-9_-] a `-` (`AT`, :359819), and a task is `<id>.json` there;
//   v5 storage is never on in this build (`Ner`, :171157, has no backend);
// - a task (`Fe`, :359681): id, subject, description, activeForm?, owner?,
//   status (pending, in_progress, completed), blocks, blockedBy, metadata?.
//   The engine hides one whose metadata._internal is set (TaskList, :756350);
// - an update (`goe`, :360209) locks the file with proper-lockfile (`da`,
//   :100669; options `me`, :359705: retries 30, 5-100 ms; defaults :100483:
//   stale 10 s, update 5 s, realpath, so the lock is `<real path>.lock`) and
//   rewrites it in place (`Le`, :360153, writeFile);
// - an inbox (`fF`, :360580) is `<configDir>/teams/<team>/inboxes/<agent>.json`,
//   both names by `AT`, while the team's config.json is under its own folder,
//   lowercased, every character outside [a-zA-Z0-9] a `-` (`Vhn`, `jxe`,
//   :363517-363527). An append (`MS`, :360710) makes the folder and `[]`,
//   locks `<path>.lock` (`lockfilePath`; retries 10, `Z`, :360421), and
//   writes `{ ...entry, msgV, msg_id, type: 'message', read: false }` by an
//   atomic write. Entries (`Xe`, :360425): from, text, timestamp, type?,
//   read?, color?, summary?, from_plugin?; a read entry is dropped.
//
// What 2.1.291 does with running sessions (cli_formatted_2.1.291.js; WP-DF):
// - a team's config (`x`, :1568756) is `{ name, createdAt, leadAgentId,
//   leadSessionId, members: [{ agentId, name, agentType, joinedAt, cwd, … }] }`,
//   createdAt in ms, the lead member `team-lead` with the lead's cwd;
// - the registry of running sessions is `<configDir>/sessions/<pid>.json`
//   (`kG`, :108870). registerSession (`OL`, :136452) writes it as a session
//   starts: pid, sessionId, cwd, startedAt, procStart, kind, status later.
//   It moves `sessionId` to the new id on a /clear or a resume (`Td`,
//   :136542) and `cwd` with the session's. The process removes it at exit
//   (`process.on("exit")` and a cleanup, :136464-136479); a session that
//   died without exiting leaves it, until a later session's count
//   (`OCt`, :136832) finds the pid dead (kill 0: ESRCH) and deletes it,
//   where the registry's sweep is permitted. A teammate's own process and a
//   child session don't register (`kc`, :136646). So a lead session id with
//   no entry has ended (or /clear'd away from the team); an entry can
//   outlive a crash until the next sweep. The pane only shows what it says.
// - a background job's entry (kind `bg`) carries its `jobId` (:136521, from
//   CLAUDE_JOB_DIR). On the user's machine (2.1.292) a job ran under a new
//   session id while its list stayed under `session-<jobId>`, whose
//   leadSessionId is the job's first id, `<jobId>-…`: ownTeam finds that
//   team from the entry, since the engine's own pick (`Sw()`, its
//   `taskList.leaderTeamName`) isn't in the mod API.

import type { Ports, RunResult } from '../ports'
import type { InboxEntry, TaskFile, TaskListRef, TaskPatch, TeamInfo, TeamMember, WriteResult } from '../uitypes'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** At most this many teams' lists follow this session's own (decision 15). */
export const TEAM_LISTS = 20
/** A lock older than this is stale (proper-lockfile's default, which the engine keeps). */
export const LOCK_STALE_MS = 10_000
/** The engine's status words, the ones TaskUpdate takes but `deleted`. */
export const TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const
const TASK_ID = /^[0-9]+$/
const TASK_FILE = /^[0-9]+\.json$/
const SEGMENT = /^[A-Za-z0-9_-]+$/
/** teamfile.sh holds a lock for up to 5 s; this leaves it room on a busy machine. */
const SCRIPT_TIMEOUT_MS = 30_000

/** The engine's rule for a list's folder, an inbox's team folder and an agent's inbox (`AT`): every character outside [A-Za-z0-9_-] becomes `-`. */
export const sanitize = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '-')

/** One path segment from a name: the engine's rule, then a check that it's one plain segment; null for an empty name. */
function segment(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const s = sanitize(name)
  return SEGMENT.test(s) ? s : null
}

/** A list's folder, absolute, built from the config dir; null when the name can't be one. */
export function listDir(configDir: string, name: string): string | null {
  const s = segment(name)
  return s === null ? null : `${configDir}/tasks/${s}`
}

/** An agent's inbox, absolute, built from the config dir; null when either name can't be one. */
export function inboxPath(configDir: string, team: string, agent: string): string | null {
  const t = segment(team)
  const a = segment(agent)
  return t === null || a === null ? null : `${configDir}/teams/${t}/inboxes/${a}.json`
}

/** `touch -t` form in UTC, `CCYYMMDDhhmm.SS`, for teamfile.sh's --stale-before; the seconds cut down, so a lock under 10 s old is never broken. */
export function touchStamp(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(d.getUTCHours())}${two(d.getUTCMinutes())}.${two(d.getUTCSeconds())}`
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const short = (s: string, max = 200): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

// ---------------------------------------------------------------------------
// Teams and lists

/**
 * A team as the store reads it: TeamInfo, and, when its config has them,
 * when it was made (`createdAt`, ms), the lead member's folder (`leadCwd`),
 * which the agents pane names for a team whose lead ended, and its name
 * (`leadName`), which the tasks picker names (WP-DF). Absent, not null, when
 * the config has none of them, so a TeamInfo compares equal.
 */
export type TeamRecord = TeamInfo & { createdAt?: number; leadCwd?: string; leadName?: string }

/** A team's config.json as TeamInfo, its members as the engine keeps them (a name each); null when it isn't one. */
function teamOf(raw: unknown, dir: string, mtimeMs: number): TeamRecord | null {
  if (!isObject(raw)) return null
  const members: TeamMember[] = (Array.isArray(raw.members) ? raw.members : []).flatMap(m =>
    isObject(m) && typeof m.name === 'string' && m.name !== ''
      ? [{ name: m.name, agentId: strOrNull(m.agentId), agentType: strOrNull(m.agentType), color: strOrNull(m.color) }]
      : [],
  )
  const info: TeamRecord = { name: strOrNull(raw.name) ?? dir, dir, leadSessionId: strOrNull(raw.leadSessionId), members, mtimeMs }
  if (typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt)) info.createdAt = raw.createdAt
  // The lead member: the config's leadAgentId, else the engine's lead name.
  const all = Array.isArray(raw.members) ? raw.members.filter(isObject) : []
  const lead = all.find(m => typeof raw.leadAgentId === 'string' && m.agentId === raw.leadAgentId) ?? all.find(m => m.name === 'team-lead')
  const cwd = strOrNull(lead?.cwd)
  if (cwd !== null) info.leadCwd = cwd
  const leadName = strOrNull(lead?.name)
  if (leadName !== null && leadName !== '') info.leadName = leadName
  return info
}

/** Each team in `<configDir>/teams/` with a readable config.json, newest first. */
export async function teams(p: Ports): Promise<TeamRecord[]> {
  let root: string
  try {
    root = `${await p.configDir()}/teams`
    if (!(await p.fs.exists(root))) return []
  } catch (err) {
    p.log(`team store: the teams weren't read: ${errText(err)}`)
    return []
  }
  const entries = await p.fs.list(root).catch((err: unknown) => {
    p.log(`team store: ${root} wasn't listed: ${errText(err)}`)
    return []
  })
  const out: TeamRecord[] = []
  for (const e of entries) {
    // A folder of its own: never a link, which could lead outside teams/.
    if (e.kind !== 'dir' || e.isLink || e.name.startsWith('.') || e.name.includes('/')) continue
    const path = `${root}/${e.name}/config.json`
    try {
      const st = await p.fs.stat(path)
      if (st.kind !== 'file' || st.isLink) continue
      const info = teamOf(JSON.parse(await p.fs.read(path)), e.name, st.mtimeMs)
      if (info) out.push(info)
    } catch {
      // No config.json, or one that can't be read: not a team the pane can show.
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * The team this session leads, whose list is its own when no
 * CLAUDE_CODE_TASK_LIST_ID names one (the engine's `Sw()` takes the env, the
 * teammate's team, `taskList.leaderTeamName`, then the session id; the mod
 * API doesn't give leaderTeamName, so it's told from the files):
 *  - the team whose config names this session its lead;
 *  - else, for a background job (its registry entry has a `jobId`; 2.1.292
 *    keeps a job's list under the team it made with its first session id,
 *    `session-<jobId>`, whose leadSessionId is that first id, after the job
 *    runs under another), the team whose leadSessionId starts with
 *    `<jobId>-`, else the one named `session-<jobId>`;
 *  - else none: the session id names the list.
 * Never "a session team that has tasks": that could be another session's.
 * Pure; `sessions` as runningSessions reads them (null: can't tell).
 */
export function ownTeam(all: readonly TeamRecord[], sessionId: string, sessions: readonly RunningSession[] | null): TeamRecord | null {
  const led = all.find(t => t.leadSessionId === sessionId)
  if (led) return led
  const job = sessions?.find(s => s.sessionId === sessionId)?.jobId ?? null
  if (job === null) return null
  return all.find(t => t.leadSessionId !== null && t.leadSessionId.startsWith(`${job}-`)) ?? all.find(t => t.name === `session-${job}`) ?? null
}

/**
 * This session's own list first, as the engine names it (decision 15):
 * CLAUDE_CODE_TASK_LIST_ID, else the team it leads (ownTeam: a background
 * job's included), else the session id. Then each team's list, newest
 * config.json first, at most 20. A list is named once, by its folder.
 * Rejects when the config dir can't be known.
 */
export async function taskLists(p: Ports): Promise<TaskListRef[]> {
  const config = await p.configDir()
  const all = await teams(p)
  const env = (await p.envVar('CLAUDE_CODE_TASK_LIST_ID')) ?? ''
  const session = await p.sessionId()
  const out: TaskListRef[] = []
  const seen = new Set<string>()
  const add = (name: string, team: string | null, mine: boolean): void => {
    const dir = listDir(config, name)
    if (dir === null || seen.has(dir)) return
    seen.add(dir)
    out.push({ name, dir, kind: team === null ? 'session' : 'team', team, mine })
  }
  if (env !== '') add(env, all.find(t => listDir(config, t.name) === listDir(config, env))?.name ?? null, true)
  else {
    // The registry only when no team names this session its lead: a job's entry says which team was its first.
    const led = all.find(t => t.leadSessionId === session) ?? ownTeam(all, session, await runningSessions(p))
    if (led) add(led.name, led.name, true)
    else add(session, null, true)
  }
  for (const t of all) {
    if (out.length > TEAM_LISTS) break
    add(t.name, t.name, false)
  }
  return out
}

// ---------------------------------------------------------------------------
// The registry of running sessions (read only; see the header)

/**
 * One running session as its registry file says: what the agents pane shows,
 * nothing it acts on. `kind` is the engine's (`interactive`, `bg` for a
 * background job, …); `jobId` a background job's id, which named the team its
 * first session id made (ownTeam), and only when it's a name's segment.
 */
export type RunningSession = { pid: number; sessionId: string; cwd: string | null; startedAt: number | null; status: string | null; kind: string | null; jobId: string | null }

const PID_FILE = /^[0-9]{1,10}\.json$/
/** Registry files read at most, and the most of each: the engine's are a few hundred bytes. */
export const REGISTRY_FILES = 400
const REGISTRY_BYTES = 64 * 1024

/**
 * The sessions `<configDir>/sessions/<pid>.json` lists as running (WP-DF):
 * each file that parses with a pid and a session id, in pid order. Null when
 * the folder can't be listed (absent included: this session registers
 * itself, so a missing folder says the registry isn't kept here), or holds
 * more than REGISTRY_FILES entries (one left unread could be a lead's), so a
 * caller tells "nobody runs it" from "can't tell". Never throws.
 */
export async function runningSessions(p: Ports): Promise<RunningSession[] | null> {
  let dir: string
  try {
    dir = `${await p.configDir()}/sessions`
    if (!(await p.fs.exists(dir))) return null
  } catch {
    return null
  }
  let names: string[]
  try {
    names = (await p.fs.list(dir)).filter(e => e.kind === 'file' && !e.isLink && PID_FILE.test(e.name)).map(e => e.name)
  } catch (err) {
    p.log(`team store: ${dir} wasn't listed: ${errText(err)}`)
    return null
  }
  if (names.length > REGISTRY_FILES) return null
  names.sort((a, b) => Number(a.slice(0, -5)) - Number(b.slice(0, -5)))
  const out: RunningSession[] = []
  for (const name of names) {
    try {
      const st = await p.fs.stat(`${dir}/${name}`)
      if (st.kind !== 'file' || st.isLink || st.size > REGISTRY_BYTES) continue
      const raw: unknown = JSON.parse(await p.fs.read(`${dir}/${name}`))
      if (!isObject(raw) || typeof raw.sessionId !== 'string' || raw.sessionId === '' || typeof raw.pid !== 'number') continue
      out.push({
        pid: raw.pid,
        sessionId: raw.sessionId,
        cwd: strOrNull(raw.cwd),
        startedAt: typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) ? raw.startedAt : null,
        status: strOrNull(raw.status),
        kind: strOrNull(raw.kind),
        jobId: typeof raw.jobId === 'string' && SEGMENT.test(raw.jobId) ? raw.jobId : null,
      })
    } catch {
      // Gone between the listing and the read, or half written: not a session the pane can name.
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Tasks

/** The list's folder, rebuilt from its name and the config dir: a ref whose `dir` is anything else is refused. */
async function checkedDir(p: Ports, list: TaskListRef): Promise<string> {
  const dir = listDir(await p.configDir(), list.name)
  if (dir === null) throw new Error(`"${short(list.name, 80)}" can't name a task list folder`)
  if (dir !== list.dir) throw new Error(`the list ${short(list.name, 80)} isn't at ${short(list.dir, 200)}`)
  return dir
}

const byId = (a: string, b: string): number => Number(a) - Number(b) || (a < b ? -1 : a > b ? 1 : 0)

/** The task files' names, sizes and mtimes, in id order: what moves when a task is written, added or removed. Reads no file. */
async function stampOf(p: Ports, dir: string): Promise<{ names: string[]; stamp: string }> {
  if (!(await p.fs.exists(dir))) return { names: [], stamp: 'none' }
  const names = (await p.fs.list(dir)).filter(e => TASK_FILE.test(e.name)).map(e => e.name)
  names.sort((a, b) => byId(a.slice(0, -5), b.slice(0, -5)))
  const parts: string[] = []
  for (const name of names) {
    const st = await p.fs.stat(`${dir}/${name}`).catch(() => null)
    parts.push(st ? `${name}:${st.size}:${st.mtimeMs}` : `${name}:?`)
  }
  return { names, stamp: parts.join('|') }
}

/** How many task files a list's folder holds, from its listing alone (the picker's count); 0 when it can't be listed. */
export async function countTasks(p: Ports, list: TaskListRef): Promise<number> {
  try {
    const dir = await checkedDir(p, list)
    if (!(await p.fs.exists(dir))) return 0
    return (await p.fs.list(dir)).filter(e => TASK_FILE.test(e.name)).length
  } catch {
    return 0
  }
}

/** The stamp readTasks answers, without reading the files: the tick's change check (decision 16). Never throws. */
export async function tasksStamp(p: Ports, list: TaskListRef): Promise<string> {
  try {
    return (await stampOf(p, await checkedDir(p, list))).stamp
  } catch (err) {
    return `error:${errText(err)}`
  }
}

/** A parsed task file as the engine's schema reads it, or why it isn't one. */
function taskOf(raw: unknown, id: string, path: string, mtimeMs: number): TaskFile | string | null {
  if (!isObject(raw)) return 'not a task (not a JSON object)'
  if (raw.id !== id) return `its id is ${JSON.stringify(raw.id) ?? 'missing'}, not "${id}"`
  if (typeof raw.subject !== 'string' || typeof raw.description !== 'string') return 'not a task (no subject or description)'
  if (typeof raw.status !== 'string' || !(TASK_STATUSES as readonly string[]).includes(raw.status)) return `not a task (status ${short(JSON.stringify(raw.status) ?? 'missing', 40)})`
  const ids = (v: unknown): string[] | null => (Array.isArray(v) && v.every(x => typeof x === 'string') ? (v as string[]) : null)
  const blocks = ids(raw.blocks)
  const blockedBy = ids(raw.blockedBy)
  if (!blocks || !blockedBy) return 'not a task (blocks or blockedBy is not a list of ids)'
  // The engine's own tasks (metadata._internal) are hidden from TaskList and its panel, so from here too.
  if (isObject(raw.metadata) && raw.metadata._internal) return null
  return {
    id,
    subject: raw.subject,
    description: raw.description,
    activeForm: strOrNull(raw.activeForm),
    // TaskUpdate can only clear an owner to '' (its owner is a string), which reads as none.
    owner: strOrNull(raw.owner),
    status: raw.status,
    blocks,
    blockedBy,
    path,
    mtimeMs,
  }
}

/**
 * A list's tasks, sorted by numeric id; what couldn't be read, one line each,
 * never a throw; and the stamp (decision 16). A list whose folder isn't
 * there has no tasks yet, which isn't a problem.
 */
export async function readTasks(p: Ports, list: TaskListRef): Promise<{ tasks: TaskFile[]; problems: string[]; stamp: string }> {
  let dir: string
  let listed: { names: string[]; stamp: string }
  try {
    dir = await checkedDir(p, list)
    listed = await stampOf(p, dir)
  } catch (err) {
    return { tasks: [], problems: [`the list couldn't be read: ${errText(err)}`], stamp: `error:${errText(err)}` }
  }
  const tasks: TaskFile[] = []
  const problems: string[] = []
  for (const name of listed.names) {
    const id = name.slice(0, -5)
    const path = `${dir}/${name}`
    try {
      const st = await p.fs.stat(path)
      if (st.isLink || st.kind !== 'file') {
        problems.push(`#${id}: ${st.isLink ? 'a link' : 'not a file'}, so it wasn't read`)
        continue
      }
      let raw: unknown
      try {
        raw = JSON.parse(await p.fs.read(path))
      } catch (err) {
        problems.push(`#${id}: ${err instanceof SyntaxError ? 'not JSON' : `unreadable (${errText(err)})`}`)
        continue
      }
      const task = taskOf(raw, id, path, st.mtimeMs)
      if (typeof task === 'string') problems.push(`#${id}: ${task}`)
      else if (task) tasks.push(task)
    } catch (err) {
      problems.push(`#${id}: unreadable (${errText(err)})`)
    }
  }
  return { tasks, problems, stamp: listed.stamp }
}

/** A patch as the engine takes it, or why it isn't one. */
function checkPatch(patch: TaskPatch): TaskPatch | string {
  if (!isObject(patch)) return 'the edit is empty'
  const out: TaskPatch = {}
  for (const key of Object.keys(patch)) if (!['subject', 'description', 'status', 'owner'].includes(key)) return `a task's ${short(key, 40)} isn't edited here`
  if (patch.subject !== undefined) {
    if (typeof patch.subject !== 'string' || patch.subject.trim() === '') return 'the subject is empty'
    out.subject = patch.subject
  }
  if (patch.description !== undefined) {
    if (typeof patch.description !== 'string') return 'the description is not text'
    out.description = patch.description
  }
  if (patch.status !== undefined) {
    if (!(TASK_STATUSES as readonly unknown[]).includes(patch.status)) return `"${short(String(patch.status), 40)}" isn't a status (pending, in_progress, completed)`
    out.status = patch.status
  }
  if ('owner' in patch) {
    if (patch.owner !== null && (typeof patch.owner !== 'string' || patch.owner.trim() === '')) return 'the owner must be a name, or none'
    out.owner = patch.owner ?? null
  }
  return Object.keys(out).length === 0 ? 'the edit is empty' : out
}

/** teamfile.sh's answer: its one JSON line, else why it gave none. */
function scriptAnswer(r: RunResult): WriteResult {
  const line = r.stdout.trim().split('\n').pop() ?? ''
  let got: unknown
  try {
    got = JSON.parse(line)
  } catch {
    got = null
  }
  if (r.code === 0 && isObject(got)) {
    if (got.ok === true) return { ok: true, via: 'direct' }
    if (got.ok === false) return { ok: false, error: typeof got.error === 'string' ? short(got.error, 400) : 'teamfile.sh refused it' }
  }
  const why = r.stderr.trim().split('\n')[0] ?? ''
  return { ok: false, error: `teamfile.sh exited ${r.code}${why ? `: ${short(why, 200)}` : ''}` }
}

/** teamfile.sh with the change on stdin and the stale cutoff from the mod's clock (it can't read a lock's age portably). */
async function runTeamfile(p: Ports, mode: 'task-update' | 'inbox-append', file: string, change: unknown): Promise<WriteResult> {
  try {
    const cutoff = touchStamp((await p.now()) - LOCK_STALE_MS)
    const r = await p.run(['sh', `${p.pluginRoot}/hooks/teamfile.sh`, mode, file, '--stale-before', cutoff], {
      stdin: JSON.stringify(change),
      timeoutMs: SCRIPT_TIMEOUT_MS,
    })
    return scriptAnswer(r)
  } catch (err) {
    return { ok: false, error: `teamfile.sh didn't run: ${errText(err)}` }
  }
}

/** A tool result's error, in the tool's words: a refusal, an error result, or TaskUpdate's `success: false`. */
function toolError(r: Awaited<ReturnType<Ports['callTool']>>, id: string): string | null {
  if (r.deny !== undefined) return r.deny
  if (r.isError) return short((r.text ?? String(r.result ?? '')).trim() || `TaskUpdate failed on task #${id}`, 400)
  const result = r.result as { success?: unknown; error?: unknown } | undefined
  if (isObject(result) && result.success === false) return typeof result.error === 'string' && result.error !== '' ? short(result.error, 400) : `task #${id} wasn't updated`
  return null
}

/**
 * One task's edit (decision 4): TaskUpdate through p.callTool when it's this
 * session's own list and the tool is there, so the engine's hooks run and an
 * owner change sends its assignment message; else teamfile.sh's locked
 * write. `id` must match `^[0-9]+$` and the patch hold only the four fields,
 * checked before anything runs.
 */
export async function updateTask(p: Ports, list: TaskListRef, id: string, patch: TaskPatch): Promise<WriteResult> {
  if (typeof id !== 'string' || !TASK_ID.test(id)) return { ok: false, error: `"${short(String(id), 40)}" isn't a task id` }
  const checked = checkPatch(patch)
  if (typeof checked === 'string') return { ok: false, error: checked }
  let dir: string
  try {
    dir = await checkedDir(p, list)
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
  const tools = list.mine ? await p.toolNames().catch(() => [] as string[]) : []
  if (tools.includes('TaskUpdate')) {
    const input: Record<string, unknown> = { taskId: id }
    if (checked.subject !== undefined) input.subject = checked.subject
    if (checked.description !== undefined) input.description = checked.description
    if (checked.status !== undefined) input.status = checked.status
    // TaskUpdate's owner is a name: '' is how it clears one.
    if ('owner' in checked) input.owner = checked.owner ?? ''
    try {
      const error = toolError(await p.callTool('TaskUpdate', input), id)
      return error === null ? { ok: true, via: 'tool' } : { ok: false, error }
    } catch (err) {
      return { ok: false, error: `TaskUpdate didn't run: ${errText(err)}` }
    }
  }
  return runTeamfile(p, 'task-update', `${dir}/${id}.json`, checked)
}

// ---------------------------------------------------------------------------
// Inboxes

/** An inbox entry as the engine's schema reads it, unread; null for one it would drop or has read. */
function entryOf(raw: unknown): InboxEntry | null {
  if (!isObject(raw) || typeof raw.from !== 'string' || typeof raw.text !== 'string' || typeof raw.timestamp !== 'string') return null
  if (raw.read === true) return null
  return { from: raw.from, text: raw.text, timestamp: raw.timestamp, summary: typeof raw.summary === 'string' ? raw.summary : null }
}

/**
 * An agent's inbox (`team` and `agent` as the team's config names them; both
 * sanitized here): its unread entries as the file holds them, with a stamp
 * of its size and mtime; null when there's no inbox file. A file that isn't
 * JSON reads as empty, as the engine reads it.
 */
export async function readInbox(p: Ports, team: string, agent: string): Promise<{ entries: InboxEntry[]; stamp: string } | null> {
  try {
    const path = inboxPath(await p.configDir(), team, agent)
    if (path === null || !(await p.fs.exists(path))) return null
    const st = await p.fs.stat(path)
    if (st.isLink || st.kind !== 'file') return null
    const stamp = `${st.size}:${st.mtimeMs}`
    let raw: unknown
    try {
      raw = JSON.parse(await p.fs.read(path))
    } catch {
      return { entries: [], stamp }
    }
    return { entries: Array.isArray(raw) ? raw.flatMap(x => entryOf(x) ?? []) : [], stamp }
  } catch (err) {
    p.log(`team store: the inbox of ${short(agent, 60)} in ${short(team, 60)} wasn't read: ${errText(err)}`)
    return null
  }
}

/**
 * A locked append to an agent's inbox, for a team this session doesn't lead
 * (decision 5), through teamfile.sh: `{ from, text, timestamp, summary?,
 * type: 'message', read: false }`, as the engine writes one. Not the
 * engine's `msgV` and `msg_id`: a msg_id counts only in the ledger of the
 * process that wrote it (`cpe`, :359646), so one made here proves nothing.
 * The team's folder must be there; its inboxes/ folder and the file are made.
 */
export async function appendInbox(p: Ports, team: string, agent: string, entry: { from: string; text: string; summary?: string }): Promise<WriteResult> {
  if (!isObject(entry) || typeof entry.from !== 'string' || entry.from.trim() === '') return { ok: false, error: 'the message has no sender' }
  if (typeof entry.text !== 'string' || entry.text.trim() === '') return { ok: false, error: 'the message is empty' }
  let path: string | null
  try {
    path = inboxPath(await p.configDir(), team, agent)
  } catch (err) {
    return { ok: false, error: errText(err) }
  }
  if (path === null) return { ok: false, error: `"${short(String(team), 60)}" or "${short(String(agent), 60)}" can't name an inbox` }
  const line: Record<string, unknown> = { from: entry.from, text: entry.text, timestamp: new Date(await p.now()).toISOString() }
  if (typeof entry.summary === 'string' && entry.summary !== '') line.summary = entry.summary
  line.type = 'message'
  line.read = false
  return runTeamfile(p, 'inbox-append', path, line)
}
