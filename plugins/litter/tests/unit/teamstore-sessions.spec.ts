// Tier 2: hooks/team/store.ts's read of the engine's registry of running
// sessions and a team's createdAt and lead folder (WP-DF §0), over a scratch
// config dir, never the real ~/.claude/: the entries that parse, in pid
// order; a file that isn't one skipped; "can't tell" (null) for a missing or
// unlistable folder, a config dir that can't be named, and a registry past
// its cap; and the team's fields only when its config has them. And a
// background job's own list (the user's 2.1.292 report): its entry's jobId
// names the team its first session id made; no jobId, or none that matches,
// leaves the session id's list, never another session's team. The registry
// read is kept while its folder's mtime holds, for REGISTRY_FRESH_MS at most
// (WP-EC): an unchanged registry costs one stat; a session starting or
// ending reads it again; a file rewritten in place shows once the read
// lapses; a read that met a half-written file, or a listing that failed,
// isn't kept.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REGISTRY_FILES, REGISTRY_FRESH_MS, ownTeam, resetRegistryForTests, runningSessions, taskLists, teams } from '../../hooks/team/store'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
  resetRegistryForTests()
})

function world(): { p: TestPorts; config: string } {
  const s = scratch('litter-sessions-')
  cleanups.push(s.cleanup)
  const config = join(s.dir, 'config')
  mkdirSync(config)
  const p = nodePorts({ sessionId: 'sess-1' })
  p.configDirValue = config
  return { p, config }
}

/** One registry file as 2.1.291's registerSession writes it (`OL`, :136452). */
function entry(config: string, pid: number, body: Record<string, unknown>): void {
  mkdirSync(join(config, 'sessions'), { recursive: true })
  writeFileSync(join(config, 'sessions', `${pid}.json`), JSON.stringify({ pid, procStart: 'x', version: '2.1.291', kind: 'interactive', entrypoint: 'cli', ...body }))
}

describe('runningSessions', () => {
  test('each entry with a pid and a session id, in pid order, with its cwd, start and status', async () => {
    const { p, config } = world()
    entry(config, 4012, { sessionId: 'sid-b', cwd: '/work/b', startedAt: 1_800_000_000_000, status: 'busy' })
    entry(config, 312, { sessionId: 'sid-a', cwd: '/work/a', startedAt: 1_800_000_001_000 })
    entry(config, 79989, { sessionId: 'sid-job', kind: 'bg', jobId: 'c75f5ddb' })
    entry(config, 79990, { sessionId: 'sid-odd', kind: 'bg', jobId: '../x' })
    expect(await runningSessions(p)).toEqual([
      { pid: 312, sessionId: 'sid-a', cwd: '/work/a', startedAt: 1_800_000_001_000, status: null, kind: 'interactive', jobId: null },
      { pid: 4012, sessionId: 'sid-b', cwd: '/work/b', startedAt: 1_800_000_000_000, status: 'busy', kind: 'interactive', jobId: null },
      // A background job's id, when it's a name's segment.
      { pid: 79989, sessionId: 'sid-job', cwd: null, startedAt: null, status: null, kind: 'bg', jobId: 'c75f5ddb' },
      { pid: 79990, sessionId: 'sid-odd', cwd: null, startedAt: null, status: null, kind: 'bg', jobId: null },
    ])
  })

  test("a file that isn't an entry is skipped: no session id, no pid, broken JSON, another name, a link, a folder, too big", async () => {
    const { p, config } = world()
    const dir = join(config, 'sessions')
    entry(config, 1, { sessionId: 'kept' })
    entry(config, 2, { cwd: '/no/id' })
    writeFileSync(join(dir, '3.json'), JSON.stringify({ sessionId: 'no-pid' }))
    writeFileSync(join(dir, '4.json'), '{"pid": 4, "sessionId": "half')
    writeFileSync(join(dir, 'notes.json'), JSON.stringify({ pid: 5, sessionId: 'named' }))
    writeFileSync(join(dir, '6.json.tmp'), JSON.stringify({ pid: 6, sessionId: 'temp' }))
    symlinkSync(join(dir, '1.json'), join(dir, '7.json'))
    mkdirSync(join(dir, '8.json'))
    writeFileSync(join(dir, '9.json'), JSON.stringify({ pid: 9, sessionId: 'big', pad: 'x'.repeat(70 * 1024) }))
    expect((await runningSessions(p))!.map(s => s.sessionId)).toEqual(['kept'])
  })

  test("null, can't tell, when there's no registry, no config dir, or more entries than it reads; an empty one is nobody", async () => {
    const { p, config } = world()
    expect(await runningSessions(p)).toBeNull()
    mkdirSync(join(config, 'sessions'))
    expect(await runningSessions(p)).toEqual([])
    for (let i = 1; i <= REGISTRY_FILES + 1; i++) writeFileSync(join(config, 'sessions', `${i}.json`), '{}')
    expect(await runningSessions(p)).toBeNull()
    const none = nodePorts({ sessionId: 'sess-1' })
    expect(await runningSessions(none)).toBeNull()
  })
})

describe("a team's createdAt, lead folder and lead name", () => {
  test("the lead member's cwd and name by leadAgentId, else the member named team-lead; absent when the config has neither", async () => {
    const { p, config } = world()
    const write = (dir: string, body: Record<string, unknown>) => {
      mkdirSync(join(config, 'teams', dir), { recursive: true })
      writeFileSync(join(config, 'teams', dir, 'config.json'), JSON.stringify(body))
    }
    write('by-id', {
      name: 'by-id',
      createdAt: 1_800_000_000_000,
      leadAgentId: 'boss@by-id',
      leadSessionId: 'sid-a',
      members: [
        { agentId: 'team-lead@by-id', name: 'team-lead', cwd: '/not/this' },
        { agentId: 'boss@by-id', name: 'boss', cwd: '/work/boss' },
      ],
    })
    write('by-name', { name: 'by-name', leadSessionId: 'sid-b', members: [{ agentId: 'team-lead@by-name', name: 'team-lead', cwd: '/work/lead' }] })
    write('bare', { name: 'bare', createdAt: 'yesterday', members: [{ name: 'team-lead' }] })
    const got = await teams(p)
    const of = (name: string) => got.find(t => t.name === name)!
    expect([of('by-id').createdAt, of('by-id').leadCwd, of('by-id').leadName]).toEqual([1_800_000_000_000, '/work/boss', 'boss'])
    expect([of('by-name').createdAt, of('by-name').leadCwd, of('by-name').leadName]).toEqual([undefined, '/work/lead', 'team-lead'])
    expect('createdAt' in of('bare') || 'leadCwd' in of('bare')).toBe(false)
    // The lead's name comes with its member, cwd or not (the tasks picker names it).
    expect(of('bare').leadName).toBe('team-lead')
  })
})

describe("a background job's own list (2.1.292: the user's machine)", () => {
  const JOB = 'c75f5ddb'
  /** A team's config, and a task in its list, so a list with tasks is there to be picked wrongly. */
  const teamWithTask = (config: string, name: string, leadSessionId: string | null): void => {
    mkdirSync(join(config, 'teams', name), { recursive: true })
    writeFileSync(join(config, 'teams', name, 'config.json'), JSON.stringify({ name, ...(leadSessionId !== null ? { leadSessionId } : {}), members: [{ name: 'team-lead' }] }))
    mkdirSync(join(config, 'tasks', name), { recursive: true })
    writeFileSync(join(config, 'tasks', name, '1.json'), JSON.stringify({ id: '1', subject: 'x', description: '', status: 'pending', blocks: [], blockedBy: [] }))
  }
  const mine = async (p: TestPorts) => (await taskLists(p)).filter(l => l.mine).map(l => [l.name, l.kind])

  test("its registry entry's jobId names its team: the one whose leadSessionId is the job's first id", async () => {
    const { p, config } = world()
    // Ours: kind bg, a jobId, a session id no team names its lead.
    entry(config, 79989, { sessionId: 'sess-1', kind: 'bg', jobId: JOB })
    // The interactive session that parked it, and another session's team with tasks.
    entry(config, 79165, { sessionId: 'sid-parent', parkedJobId: JOB })
    teamWithTask(config, `session-${JOB}`, `${JOB}-d20f-4000-8000-000000000000`)
    teamWithTask(config, 'session-aaaa1111', 'aaaa1111-0000-4000-8000-000000000000')
    expect(await mine(p)).toEqual([[`session-${JOB}`, 'team']])
    const lists = await taskLists(p)
    expect(lists[0]!.name).toBe(`session-${JOB}`)
    // Agents tells the same team (ownTeam, pure): this session's, so it runs and is led here.
    const all = await teams(p)
    expect(ownTeam(all, 'sess-1', await runningSessions(p))?.name).toBe(`session-${JOB}`)
  })

  test('failing that, the team named session-<jobId>; a team this session leads comes first', async () => {
    const { p, config } = world()
    entry(config, 79989, { sessionId: 'sess-1', kind: 'bg', jobId: JOB })
    teamWithTask(config, `session-${JOB}`, null)
    expect(await mine(p)).toEqual([[`session-${JOB}`, 'team']])
    teamWithTask(config, 'led-here', 'sess-1')
    expect(await mine(p)).toEqual([['led-here', 'team']])
  })

  test('no jobId: unchanged, the session id names the list, though a session team with tasks is there', async () => {
    const { p, config } = world()
    entry(config, 79165, { sessionId: 'sess-1' })
    teamWithTask(config, `session-${JOB}`, `${JOB}-d20f-4000-8000-000000000000`)
    expect(await mine(p)).toEqual([['sess-1', 'session']])
    // No registry at all: the same.
    const bare = world()
    teamWithTask(bare.config, `session-${JOB}`, `${JOB}-d20f-4000-8000-000000000000`)
    expect(await mine(bare.p)).toEqual([['sess-1', 'session']])
  })

  test("a jobId no team matches: the session id's list, never another team with tasks", async () => {
    const { p, config } = world()
    entry(config, 79989, { sessionId: 'sess-1', kind: 'bg', jobId: JOB })
    teamWithTask(config, 'session-aaaa1111', 'aaaa1111-0000-4000-8000-000000000000')
    // A leadSessionId that only starts with the job's id, with no `-` after it, isn't the job's.
    teamWithTask(config, 'near-miss', `${JOB}ffff-0000`)
    expect(await mine(p)).toEqual([['sess-1', 'session']])
    expect(ownTeam(await teams(p), 'sess-1', null)).toBeNull()
  })
})

describe('the registry, kept while its folder holds (WP-EC)', () => {
  const NOW = 1_800_000_000_000
  const ids = (s: Awaited<ReturnType<typeof runningSessions>>) => s?.map(x => x.sessionId) ?? null

  /** The fs calls under the registry's folder, in order, as `stat /`, `list /` or `read /<file>`. */
  function counted(p: TestPorts, config: string): string[] {
    const calls: string[] = []
    const dir = join(config, 'sessions')
    const { stat, list, read } = p.fs
    const note = (what: string, path: string) => {
      if (path === dir || path.startsWith(`${dir}/`)) calls.push(`${what} ${path.slice(dir.length) || '/'}`)
    }
    p.fs.stat = async (path, options) => (note('stat', path), stat(path, options))
    p.fs.list = async path => (note('list', path), list(path))
    p.fs.read = async path => (note('read', path), read(path))
    return calls
  }

  /** The folder's mtime set by hand, so a test knows whether it moved. */
  const touch = (config: string, ms: number) => utimesSync(join(config, 'sessions'), ms / 1000, ms / 1000)

  test('an unchanged registry costs one stat: the second read reads no file, and answers a copy', async () => {
    const { p, config } = world()
    p.clock.now = NOW
    entry(config, 312, { sessionId: 'sid-a' })
    entry(config, 4012, { sessionId: 'sid-b' })
    const calls = counted(p, config)
    const first = await runningSessions(p)
    expect(ids(first)).toEqual(['sid-a', 'sid-b'])
    expect(calls).toEqual(['stat /', 'list /', 'stat /312.json', 'read /312.json', 'stat /4012.json', 'read /4012.json'])
    calls.length = 0
    first!.pop()
    expect(ids(await runningSessions(p))).toEqual(['sid-a', 'sid-b'])
    expect(calls).toEqual(['stat /'])
  })

  test("a session that starts or ends moves the folder's mtime, and the registry is read again", async () => {
    const { p, config } = world()
    p.clock.now = NOW
    entry(config, 312, { sessionId: 'sid-a' })
    touch(config, NOW - 60_000)
    expect(ids(await runningSessions(p))).toEqual(['sid-a'])
    entry(config, 4012, { sessionId: 'sid-b' })
    touch(config, NOW - 59_000)
    expect(ids(await runningSessions(p))).toEqual(['sid-a', 'sid-b'])
    unlinkSync(join(config, 'sessions', '312.json'))
    touch(config, NOW - 58_000)
    expect(ids(await runningSessions(p))).toEqual(['sid-b'])
    // The folder gone: null after its one stat.
    const calls = counted(p, config)
    rmSync(join(config, 'sessions'), { recursive: true })
    expect(await runningSessions(p)).toBeNull()
    expect(calls).toEqual(['stat /'])
  })

  test("an entry rewritten in place (a /clear's new session id) leaves the folder's mtime: the read stands until REGISTRY_FRESH_MS has passed", async () => {
    const { p, config } = world()
    p.clock.now = NOW
    entry(config, 312, { sessionId: 'sid-a' })
    touch(config, NOW - 60_000)
    expect(ids(await runningSessions(p))).toEqual(['sid-a'])
    entry(config, 312, { sessionId: 'sid-a2' })
    touch(config, NOW - 60_000)
    expect(statSync(join(config, 'sessions')).mtimeMs).toBe(NOW - 60_000)
    p.clock.now = NOW + REGISTRY_FRESH_MS - 1
    expect(ids(await runningSessions(p))).toEqual(['sid-a'])
    p.clock.now = NOW + REGISTRY_FRESH_MS
    expect(ids(await runningSessions(p))).toEqual(['sid-a2'])
  })

  test("a read that met a half-written file isn't kept, so the next one sees it finished; a listing that failed isn't kept; a registry past its cap is", async () => {
    const { p, config } = world()
    p.clock.now = NOW
    entry(config, 1, { sessionId: 'kept' })
    writeFileSync(join(config, 'sessions', '2.json'), '{"pid": 2, "sessionId": "ha')
    touch(config, NOW - 60_000)
    expect(ids(await runningSessions(p))).toEqual(['kept'])
    // The engine finishes its write in place.
    entry(config, 2, { sessionId: 'half' })
    touch(config, NOW - 60_000)
    expect(ids(await runningSessions(p))).toEqual(['kept', 'half'])
    const calls = counted(p, config)
    expect(ids(await runningSessions(p))).toEqual(['kept', 'half'])
    expect(calls).toEqual(['stat /'])

    // A listing that fails: null, logged, and the next read lists again.
    resetRegistryForTests()
    const list = p.fs.list
    let refuse = true
    p.fs.list = async path => {
      if (refuse) throw new Error('EACCES: the folder')
      return list(path)
    }
    expect(await runningSessions(p)).toBeNull()
    expect(p.logs.some(l => l.includes("wasn't listed: EACCES: the folder"))).toBe(true)
    refuse = false
    expect(ids(await runningSessions(p))).toEqual(['kept', 'half'])

    // Past the cap: can't tell, kept as such.
    for (let i = 3; i <= REGISTRY_FILES + 1; i++) writeFileSync(join(config, 'sessions', `${i}.json`), '{}')
    touch(config, NOW - 50_000)
    expect(await runningSessions(p)).toBeNull()
    calls.length = 0
    expect(await runningSessions(p)).toBeNull()
    expect(calls).toEqual(['stat /'])
  })

  test("another config dir's registry is its own: a read kept for one is never another's", async () => {
    const a = world()
    const b = world()
    a.p.clock.now = NOW
    b.p.clock.now = NOW
    entry(a.config, 1, { sessionId: 'sid-a' })
    entry(b.config, 1, { sessionId: 'sid-b' })
    touch(a.config, NOW - 60_000)
    touch(b.config, NOW - 60_000)
    expect(ids(await runningSessions(a.p))).toEqual(['sid-a'])
    expect(ids(await runningSessions(b.p))).toEqual(['sid-b'])
    expect(ids(await runningSessions(a.p))).toEqual(['sid-a'])
  })
})
