// Tier 2: hooks/team/store.ts (WP-CE; COMMON decisions 4, 5, 15) over a
// temporary config dir, never the real ~/.claude/: this session's list by
// each of the engine's three rules, the teams newest first and capped, the
// engine's sanitizing and the folder checks, tasks parsed with a broken file
// as a problem, the stamp, updateTask through a TaskUpdate fake and through
// the real teamfile.sh, the checks made before anything runs, and the inbox
// read and the locked append.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TaskListRef } from '../../hooks/uitypes'
import {
  TEAM_LISTS,
  appendInbox,
  countTasks,
  inboxPath,
  listDir,
  readInbox,
  readTasks,
  sanitize,
  taskLists,
  tasksStamp,
  teams,
  touchStamp,
  updateTask,
} from '../../hooks/team/store'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

// teamfile.sh runs for real; a loaded machine is slow.
setDefaultTimeout(60_000)

const SESSION = 'sess-1234'
const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
})

/** Ports over a fresh config dir: the session id fixed, nothing else set. */
function world(): { p: TestPorts; config: string } {
  const s = scratch('litter-teamstore-')
  cleanups.push(s.cleanup)
  const config = join(s.dir, 'config')
  mkdirSync(config)
  const p = nodePorts({ sessionId: SESSION })
  p.configDirValue = config
  return { p, config }
}

const SEC = 1000
/** A team's config.json under `<config>/teams/<dir>/`, its mtime set (seconds since the epoch). */
function team(config: string, dir: string, body: Record<string, unknown>, mtimeSec = 1_800_000_000): string {
  const folder = join(config, 'teams', dir)
  mkdirSync(folder, { recursive: true })
  const path = join(folder, 'config.json')
  writeFileSync(path, JSON.stringify(body, null, 2))
  utimesSync(path, mtimeSec, mtimeSec)
  return path
}

type TaskBody = { id?: unknown; subject?: unknown; description?: unknown; status?: unknown; owner?: unknown; blocks?: unknown; blockedBy?: unknown; [k: string]: unknown }
const task = (id: string, over: TaskBody = {}): TaskBody => ({ id, subject: `task ${id}`, description: `about ${id}`, status: 'pending', blocks: [], blockedBy: [], ...over })

/** Task files in `<config>/tasks/<folder>/`, as the engine writes them. */
function tasksIn(config: string, folder: string, files: Record<string, unknown>): string {
  const dir = join(config, 'tasks', folder)
  mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2))
  return dir
}

const ref = (config: string, name: string, over: Partial<TaskListRef> = {}): TaskListRef => ({
  name,
  dir: join(config, 'tasks', sanitize(name)),
  kind: 'team',
  team: name,
  mine: false,
  ...over,
})

/** Counts p.run's calls (teamfile.sh), passing each on. */
function countRuns(p: TestPorts): { argv: (readonly string[])[] } {
  const seen = { argv: [] as (readonly string[])[] }
  const real = p.run
  p.run = async (argv, init) => {
    seen.argv.push(argv)
    return real(argv, init)
  }
  return seen
}

// ---------------------------------------------------------------------------

describe("the engine's names", () => {
  test('sanitize keeps [A-Za-z0-9_-] and makes every other character a dash, so no name leaves its folder', () => {
    expect(sanitize('team_A-1')).toBe('team_A-1')
    expect(sanitize('../../etc')).toBe('------etc')
    expect(sanitize('My Team.v2/x')).toBe('My-Team-v2-x')
    expect(sanitize('..')).toBe('--')
  })

  test('listDir and inboxPath are built from the config dir, one segment each; an empty name makes none', () => {
    expect(listDir('/c', 'a b')).toBe('/c/tasks/a-b')
    expect(listDir('/c', '..')).toBe('/c/tasks/--')
    expect(listDir('/c', '')).toBeNull()
    expect(inboxPath('/c', 'My Team', '../lead')).toBe('/c/teams/My-Team/inboxes/---lead.json')
    expect(inboxPath('/c', '', 'lead')).toBeNull()
    expect(inboxPath('/c', 'team', '')).toBeNull()
  })

  test("touchStamp is touch -t's form in UTC, seconds cut down", () => {
    expect(touchStamp(Date.UTC(2026, 9, 5, 14, 3, 9, 999))).toBe('202610051403.09')
    expect(touchStamp(Date.UTC(2020, 0, 1, 0, 0, 0))).toBe('202001010000.00')
  })
})

describe('teams', () => {
  test('each folder with a readable config.json, newest first, with its members; the rest skipped', async () => {
    const { p, config } = world()
    team(config, 'old-team', { name: 'old-team', leadSessionId: 'other', members: [{ agentId: 'lead@old', name: 'team-lead', agentType: 'team-lead' }] }, 1_700_000_000)
    team(
      config,
      'new-team',
      {
        name: 'New Team',
        leadSessionId: SESSION,
        members: [{ agentId: 'r@new', name: 'researcher', agentType: 'general-purpose', color: 'blue' }, { name: 7 }, 'x', { name: 'no-id' }],
      },
      1_800_000_000,
    )
    team(config, 'no-members', { name: 'quiet' }, 1_750_000_000)
    mkdirSync(join(config, 'teams', 'no-config'), { recursive: true })
    mkdirSync(join(config, 'teams', 'broken'), { recursive: true })
    writeFileSync(join(config, 'teams', 'broken', 'config.json'), '{ not json')
    // A linked folder could lead anywhere: skipped.
    symlinkSync(join(config, 'teams', 'old-team'), join(config, 'teams', 'linked'))
    writeFileSync(join(config, 'teams', 'stray.json'), '{}')
    const got = await teams(p)
    expect(got.map(t => [t.name, t.dir])).toEqual([
      ['New Team', 'new-team'],
      ['quiet', 'no-members'],
      ['old-team', 'old-team'],
    ])
    expect(got[0]!.leadSessionId).toBe(SESSION)
    expect(got[0]!.members).toEqual([
      { name: 'researcher', agentId: 'r@new', agentType: 'general-purpose', color: 'blue' },
      { name: 'no-id', agentId: null, agentType: null, color: null },
    ])
    expect(got[1]!.members).toEqual([])
  })

  test('no teams folder, or no config dir, is no teams', async () => {
    const { p } = world()
    expect(await teams(p)).toEqual([])
    p.configDirValue = null
    expect(await teams(p)).toEqual([])
    expect(p.logs.some(l => /teams weren't read/.test(l))).toBe(true)
  })
})

describe("this session's list, and the teams' after it", () => {
  test('CLAUDE_CODE_TASK_LIST_ID names it first, mine, even with a team this session leads', async () => {
    const { p, config } = world()
    team(config, 'led', { name: 'led', leadSessionId: SESSION, members: [] })
    p.envValues.CLAUDE_CODE_TASK_LIST_ID = 'shared list'
    const lists = await taskLists(p)
    expect(lists[0]).toEqual({ name: 'shared list', dir: join(config, 'tasks', 'shared-list'), kind: 'session', team: null, mine: true })
    expect(lists.slice(1)).toEqual([{ name: 'led', dir: join(config, 'tasks', 'led'), kind: 'team', team: 'led', mine: false }])
  })

  test("a variable naming a team's list makes that team's list mine, listed once", async () => {
    const { p, config } = world()
    team(config, 'alpha', { name: 'alpha', members: [] })
    p.envValues.CLAUDE_CODE_TASK_LIST_ID = 'alpha'
    expect(await taskLists(p)).toEqual([{ name: 'alpha', dir: join(config, 'tasks', 'alpha'), kind: 'team', team: 'alpha', mine: true }])
  })

  test('else the team whose config names this session its lead', async () => {
    const { p, config } = world()
    team(config, 'other', { name: 'other', leadSessionId: 'someone-else' }, 1_800_000_100)
    team(config, 'mine', { name: 'mine', leadSessionId: SESSION }, 1_700_000_000)
    expect(await taskLists(p)).toEqual([
      { name: 'mine', dir: join(config, 'tasks', 'mine'), kind: 'team', team: 'mine', mine: true },
      { name: 'other', dir: join(config, 'tasks', 'other'), kind: 'team', team: 'other', mine: false },
    ])
  })

  test('else the session id; an empty variable is unset, as the engine reads it', async () => {
    const { p, config } = world()
    p.envValues.CLAUDE_CODE_TASK_LIST_ID = ''
    expect(await taskLists(p)).toEqual([{ name: SESSION, dir: join(config, 'tasks', SESSION), kind: 'session', team: null, mine: true }])
  })

  test(`the teams' lists come newest first, at most ${TEAM_LISTS}`, async () => {
    const { p, config } = world()
    for (let i = 0; i < TEAM_LISTS + 3; i++) team(config, `t${i}`, { name: `t${i}` }, 1_800_000_000 + i * 10)
    const lists = await taskLists(p)
    expect(lists).toHaveLength(1 + TEAM_LISTS)
    expect(lists[0]!.name).toBe(SESSION)
    expect(lists[1]!.name).toBe(`t${TEAM_LISTS + 2}`)
    expect(lists[TEAM_LISTS]!.name).toBe('t3')
  })

  test("a team's name with dots and slashes sanitizes into a folder under tasks/, never above it", async () => {
    const { p, config } = world()
    team(config, 'evil', { name: '../../outside' })
    const lists = await taskLists(p)
    expect(lists[1]).toEqual({ name: '../../outside', dir: join(config, 'tasks', '------outside'), kind: 'team', team: '../../outside', mine: false })
    for (const l of lists) expect(l.dir.startsWith(`${join(config, 'tasks')}/`)).toBe(true)
  })

  test('rejects when the config dir is unknown', async () => {
    const { p } = world()
    p.configDirValue = null
    await expect(taskLists(p)).rejects.toThrow(/no config dir/)
  })
})

describe('readTasks', () => {
  test('the task files in id order, the broken ones as problems, the rest of the folder ignored', async () => {
    const { p, config } = world()
    tasksIn(config, 'team-a', {
      '10.json': task('10', { status: 'completed', owner: 'researcher', activeForm: 'Doing ten' }),
      '2.json': task('2', { blockedBy: ['1'], blocks: ['10'], owner: '' }),
      '1.json': task('1', { status: 'in_progress', metadata: { k: 1 } }),
      '3.json': '{ "id": "3", "subject": ',
      '4.json': task('4', { status: 'deleted' }),
      '5.json': task('6'),
      '7.json': task('7', { metadata: { _internal: true } }),
      '8.json': task('8', { blockedBy: [8] }),
      'notes.json': { id: 'x' },
      '.lock': '',
      '.highwatermark': '10',
    })
    mkdirSync(join(config, 'tasks', 'team-a', '9.json'))
    const got = await readTasks(p, ref(config, 'team-a'))
    expect(got.tasks.map(t => t.id)).toEqual(['1', '2', '10'])
    const two = got.tasks[1]!
    expect(two).toEqual({
      id: '2',
      subject: 'task 2',
      description: 'about 2',
      activeForm: null,
      // TaskUpdate clears an owner to '', which reads as none.
      owner: null,
      status: 'pending',
      blocks: ['10'],
      blockedBy: ['1'],
      path: join(config, 'tasks', 'team-a', '2.json'),
      mtimeMs: two.mtimeMs,
    })
    expect(got.tasks[2]!.activeForm).toBe('Doing ten')
    expect(got.tasks[2]!.owner).toBe('researcher')
    expect(got.problems).toEqual([
      '#3: not JSON',
      '#4: not a task (status "deleted")',
      '#5: its id is "6", not "5"',
      '#8: not a task (blocks or blockedBy is not a list of ids)',
      "#9: not a file, so it wasn't read",
    ])
  })

  test("a list whose folder isn't there yet has no tasks and no problems", async () => {
    const { p, config } = world()
    expect(await readTasks(p, ref(config, 'empty'))).toEqual({ tasks: [], problems: [], stamp: 'none' })
    expect(await countTasks(p, ref(config, 'empty'))).toBe(0)
  })

  test('a ref whose folder isn\'t its name\'s, or names none, is refused and nothing is read', async () => {
    const { p, config } = world()
    tasksIn(config, 'team-a', { '1.json': task('1') })
    const forged = ref(config, 'team-a', { dir: join(config, 'tasks', 'team-a', '..', '..', 'teams') })
    const got = await readTasks(p, forged)
    expect(got.tasks).toEqual([])
    expect(got.problems[0]).toMatch(/^the list couldn't be read: the list team-a isn't at /)
    expect((await readTasks(p, ref(config, '', { dir: join(config, 'tasks') }))).problems[0]).toMatch(/can't name a task list folder/)
    expect(await countTasks(p, forged)).toBe(0)
  })

  test('the stamp: the same without a change, read without opening a file, and moved by an edit or a new task', async () => {
    const { p, config } = world()
    tasksIn(config, 'team-a', { '1.json': task('1'), '2.json': task('2') })
    const list = ref(config, 'team-a')
    const first = await readTasks(p, list)
    expect(first.stamp).toMatch(/^1\.json:\d+:[\d.]+\|2\.json:\d+:[\d.]+$/)
    expect((await readTasks(p, list)).stamp).toBe(first.stamp)
    expect(await tasksStamp(p, list)).toBe(first.stamp)
    expect(await countTasks(p, list)).toBe(2)
    const r = await updateTask(p, list, '2', { subject: 'renamed, and longer than before' })
    expect(r).toEqual({ ok: true, via: 'direct' })
    const edited = await tasksStamp(p, list)
    expect(edited).not.toBe(first.stamp)
    tasksIn(config, 'team-a', { '3.json': task('3') })
    expect(await tasksStamp(p, list)).not.toBe(edited)
  })
})

describe('updateTask', () => {
  const mine = (config: string) => ref(config, SESSION, { kind: 'session', team: null, mine: true })

  test("this session's list with TaskUpdate there: the tool, with only the patch's fields, and an owner cleared as ''", async () => {
    const { p, config } = world()
    tasksIn(config, SESSION, { '4.json': task('4') })
    p.toolNamesValue = ['Read', 'TaskUpdate']
    p.toolAnswer = async (_tool, input) => ({ result: { success: true, taskId: input.taskId, updatedFields: ['status'] } }) as never
    const runs = countRuns(p)
    expect(await updateTask(p, mine(config), '4', { status: 'completed', owner: null })).toEqual({ ok: true, via: 'tool' })
    expect(await updateTask(p, mine(config), '4', { subject: 'S', description: 'D', owner: 'researcher' })).toEqual({ ok: true, via: 'tool' })
    expect(p.toolCalls).toEqual([
      { tool: 'TaskUpdate', input: { taskId: '4', status: 'completed', owner: '' } },
      { tool: 'TaskUpdate', input: { taskId: '4', subject: 'S', description: 'D', owner: 'researcher' } },
    ])
    expect(runs.argv).toEqual([])
  })

  test("the tool's error is the answer, in its words: an error result, success false, a refusal, a throw", async () => {
    const { p, config } = world()
    p.toolNamesValue = ['TaskUpdate']
    const answers = [
      { isError: true, result: 'boom', text: 'TaskCompleted hook said no' },
      { result: { success: false, taskId: '4', updatedFields: [], error: 'Task not found' } },
      { deny: 'a hook refused TaskUpdate' },
    ]
    p.toolAnswer = async () => answers.shift() as never
    const list = mine(config)
    expect(await updateTask(p, list, '4', { status: 'completed' })).toEqual({ ok: false, error: 'TaskCompleted hook said no' })
    expect(await updateTask(p, list, '4', { status: 'completed' })).toEqual({ ok: false, error: 'Task not found' })
    expect(await updateTask(p, list, '4', { status: 'completed' })).toEqual({ ok: false, error: 'a hook refused TaskUpdate' })
    p.toolAnswer = async () => {
      throw new Error('no tool named TaskUpdate')
    }
    expect(await updateTask(p, list, '4', { status: 'completed' })).toEqual({ ok: false, error: "TaskUpdate didn't run: no tool named TaskUpdate" })
  })

  test("directly, by the real teamfile.sh, when TaskUpdate isn't there or the list isn't this session's", async () => {
    const { p, config } = world()
    const dir = tasksIn(config, SESSION, { '4.json': task('4', { owner: 'researcher', activeForm: 'Working', metadata: { k: 1 } }) })
    tasksIn(config, 'team-b', { '1.json': task('1') })
    const runs = countRuns(p)
    expect(await updateTask(p, mine(config), '4', { status: 'in_progress', owner: null })).toEqual({ ok: true, via: 'direct' })
    const after = JSON.parse(readFileSync(join(dir, '4.json'), 'utf8'))
    expect(after).toEqual({ id: '4', subject: 'task 4', description: 'about 4', status: 'in_progress', blocks: [], blockedBy: [], activeForm: 'Working', metadata: { k: 1 } })
    // The tool is there, but the list is another team's.
    p.toolNamesValue = ['TaskUpdate']
    expect(await updateTask(p, ref(config, 'team-b'), '1', { owner: 'executor', description: 'two\nlines' })).toEqual({ ok: true, via: 'direct' })
    expect(JSON.parse(readFileSync(join(config, 'tasks', 'team-b', '1.json'), 'utf8'))).toMatchObject({ owner: 'executor', description: 'two\nlines' })
    expect(p.toolCalls).toEqual([])
    expect(runs.argv).toHaveLength(2)
    const argv = runs.argv[0]!
    expect(argv.slice(0, 4)).toEqual(['sh', `${p.pluginRoot}/hooks/teamfile.sh`, 'task-update', join(dir, '4.json')])
    expect(argv[4]).toBe('--stale-before')
    expect(argv[5]).toMatch(/^\d{12}\.\d{2}$/)
    expect(readdirSync(dir)).toEqual(['4.json'])
  })

  test("a stale lock is broken by the mod's cutoff, now less 10 s; the script's refusal is the answer", async () => {
    const { p, config } = world()
    const dir = tasksIn(config, 'team-a', { '1.json': task('1'), '2.json': '{"id": "2"}' })
    mkdirSync(join(dir, '1.json.lock'))
    utimesSync(join(dir, '1.json.lock'), 1_577_836_800, 1_577_836_800)
    expect(await updateTask(p, ref(config, 'team-a'), '1', { status: 'completed' })).toEqual({ ok: true, via: 'direct' })
    expect(existsSync(join(dir, '1.json.lock'))).toBe(false)
    const r = await updateTask(p, ref(config, 'team-a'), '2', { status: 'completed' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toMatch(/isn't a task file, so it was left as it was/)
    expect(readFileSync(join(dir, '2.json'), 'utf8')).toBe('{"id": "2"}')
    expect((await updateTask(p, ref(config, 'team-a'), '9', { status: 'completed' })).ok).toBe(false)
  })

  test('a bad id, a bad status, an unknown field, an empty patch or a forged list is refused before anything runs', async () => {
    const { p, config } = world()
    const dir = tasksIn(config, 'team-a', { '1.json': task('1') })
    const before = readFileSync(join(dir, '1.json'), 'utf8')
    p.toolNamesValue = ['TaskUpdate']
    const runs = countRuns(p)
    const list = ref(config, 'team-a', { mine: true })
    const refused = async (id: string, patch: Record<string, unknown>, list2 = list) => {
      const r = await updateTask(p, list2, id, patch as never)
      expect(r.ok).toBe(false)
      return r.ok ? '' : r.error
    }
    expect(await refused('../1', { status: 'completed' })).toBe(`"../1" isn't a task id`)
    expect(await refused('1a', { status: 'completed' })).toBe(`"1a" isn't a task id`)
    expect(await refused('1', { status: 'deleted' })).toBe(`"deleted" isn't a status (pending, in_progress, completed)`)
    expect(await refused('1', { blocks: ['2'] })).toBe("a task's blocks isn't edited here")
    expect(await refused('1', {})).toBe('the edit is empty')
    expect(await refused('1', { subject: '  ' })).toBe('the subject is empty')
    expect(await refused('1', { owner: '' })).toBe('the owner must be a name, or none')
    expect(await refused('1', { status: 'completed' }, ref(config, 'team-a', { dir: join(config, 'teams', 'team-a') }))).toMatch(/isn't at/)
    expect(p.toolCalls).toEqual([])
    expect(runs.argv).toEqual([])
    expect(readFileSync(join(dir, '1.json'), 'utf8')).toBe(before)
  })
})

describe('inboxes', () => {
  test('appendInbox makes the inbox and appends, as the engine writes an entry; readInbox reads the unread ones', async () => {
    const { p, config } = world()
    mkdirSync(join(config, 'teams', 'Team-A'), { recursive: true })
    p.clock.now = Date.UTC(2026, 9, 5, 10, 0, 0)
    expect(await readInbox(p, 'Team A', 'reviewer')).toBeNull()
    expect(await appendInbox(p, 'Team A', 'reviewer', { from: 'user', text: 'first' })).toEqual({ ok: true, via: 'direct' })
    p.clock.now += 60_000
    expect(await appendInbox(p, 'Team A', 'reviewer', { from: 'user', text: 'second', summary: 'a summary' })).toEqual({ ok: true, via: 'direct' })
    const path = join(config, 'teams', 'Team-A', 'inboxes', 'reviewer.json')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual([
      { from: 'user', text: 'first', timestamp: '2026-10-05T10:00:00.000Z', type: 'message', read: false },
      { from: 'user', text: 'second', timestamp: '2026-10-05T10:01:00.000Z', summary: 'a summary', type: 'message', read: false },
    ])
    expect(readdirSync(join(config, 'teams', 'Team-A', 'inboxes'))).toEqual(['reviewer.json'])
    const got = await readInbox(p, 'Team A', 'reviewer')
    expect(got?.entries).toEqual([
      { from: 'user', text: 'first', timestamp: '2026-10-05T10:00:00.000Z', summary: null },
      { from: 'user', text: 'second', timestamp: '2026-10-05T10:01:00.000Z', summary: 'a summary' },
    ])
    expect(got?.stamp).toMatch(/^\d+:[\d.]+$/)
  })

  test('readInbox drops what the engine drops: a read entry, one missing a field; a file that isn\'t JSON reads as empty', async () => {
    const { p, config } = world()
    const dir = join(config, 'teams', 'team-a', 'inboxes')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'lead.json'),
      JSON.stringify([
        { from: 'researcher', text: 'done', timestamp: 't1', read: false, color: 'blue', msg_id: 'm' },
        { from: 'researcher', text: 'old', timestamp: 't0', read: true },
        { from: 'researcher', timestamp: 't2' },
        'junk',
      ]),
    )
    writeFileSync(join(dir, 'broken.json'), '[{')
    expect((await readInbox(p, 'team-a', 'lead'))?.entries).toEqual([{ from: 'researcher', text: 'done', timestamp: 't1', summary: null }])
    expect((await readInbox(p, 'team-a', 'broken'))?.entries).toEqual([])
    expect(await readInbox(p, 'team-a', '')).toBeNull()
  })

  test("appendInbox refuses a team with no folder, an empty message, and a name that makes no path, writing nothing", async () => {
    const { p, config } = world()
    mkdirSync(join(config, 'teams'), { recursive: true })
    const r = await appendInbox(p, 'gone', 'lead', { from: 'user', text: 'hi' })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.error).toBe(`the team folder ${join(config, 'teams', 'gone')} isn't there`)
    expect(await appendInbox(p, 'gone', 'lead', { from: 'user', text: ' ' })).toEqual({ ok: false, error: 'the message is empty' })
    expect(await appendInbox(p, 'gone', 'lead', { from: '', text: 'hi' })).toEqual({ ok: false, error: 'the message has no sender' })
    expect(await appendInbox(p, '', 'lead', { from: 'user', text: 'hi' })).toEqual({ ok: false, error: `"" or "lead" can't name an inbox` })
    expect(readdirSync(join(config, 'teams'))).toEqual([])
  })
})
