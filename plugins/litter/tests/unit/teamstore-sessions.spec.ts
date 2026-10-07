// Tier 2: hooks/team/store.ts's read of the engine's registry of running
// sessions and a team's createdAt and lead folder (WP-DF §0), over a scratch
// config dir, never the real ~/.claude/: the entries that parse, in pid
// order; a file that isn't one skipped; "can't tell" (null) for a missing or
// unlistable folder, a config dir that can't be named, and a registry past
// its cap; and the team's fields only when its config has them.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { REGISTRY_FILES, runningSessions, teams } from '../../hooks/team/store'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const c of cleanups.splice(0)) c()
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
    expect(await runningSessions(p)).toEqual([
      { pid: 312, sessionId: 'sid-a', cwd: '/work/a', startedAt: 1_800_000_001_000, status: null },
      { pid: 4012, sessionId: 'sid-b', cwd: '/work/b', startedAt: 1_800_000_000_000, status: 'busy' },
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

describe("a team's createdAt and lead folder", () => {
  test("the lead member's cwd by leadAgentId, else the member named team-lead; absent when the config has neither", async () => {
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
    expect([of('by-id').createdAt, of('by-id').leadCwd]).toEqual([1_800_000_000_000, '/work/boss'])
    expect([of('by-name').createdAt, of('by-name').leadCwd]).toEqual([undefined, '/work/lead'])
    expect('createdAt' in of('bare') || 'leadCwd' in of('bare')).toBe(false)
  })
})
