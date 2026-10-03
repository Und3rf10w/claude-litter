// Tier 2: the mod's side of the files it shares with the command hooks (plan
// section 9, "Mod-to-hook state"): policy.json and `active`, the spool drain,
// the drain timer, and the agent map.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import type { Policy, SpoolConsumer, SpoolLine } from '../../hooks/hookfiles'
import { activePath, policyPath, runDir, spoolBlobDir, spoolDir, spoolPath } from '../../hooks/layout'
import {
  agentInfo,
  consumeAgents,
  drainAllSpools,
  drainOwnSpools,
  drainSpool,
  forgetRunAgents,
  readPolicy,
  roleOf,
  runAgents,
  setActive,
  startDrainTimer,
  updatePolicy,
  writePolicy,
} from '../../hooks/policy'
import { updateSession } from '../../hooks/session'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const RUN = '20261002-policy'

let p: TestPorts
let dir: string
let cleanup: () => void
let got: SpoolLine[]
const collect: SpoolConsumer = async (_ctx, l) => void got.push(l)

beforeEach(() => {
  p = nodePorts()
  ;({ dir, cleanup } = scratch())
  got = []
  mkdirSync(spoolDir(dir), { recursive: true })
})
afterEach(() => {
  updateSession({ litterDir: null })
  cleanup()
})

function policyFor(run: string | null, session = 'test-session'): Policy {
  return {
    v: 1,
    session,
    litterDir: dir,
    run: run
      ? {
          run,
          workflow: 'execute',
          runDir: runDir(dir, run),
          checkout: dir,
          base: '0'.repeat(40),
          runIds: [],
          launching: false,
          stopping: false,
          inflight: null,
          isolationLost: false,
          roots: { checkout: dir, litterDir: dir, litterCopies: [dir], ruleDirs: [], worktrees: [] },
          setup: null,
          linkDirs: [],
        }
      : null,
    roles: {},
    swarm: null,
  }
}

const line = (ev: string, extra: Record<string, unknown> = {}, session = 'test-session') => ({ v: 1, ev, ts: 1_700_000_000, session_id: session, ...extra })
const startLine = (id: string, extra: Record<string, unknown> = {}, session = 'test-session') =>
  line('start', { agent_id: id, agent_type: 'litter:falsifier', cwd: '/w', transcript_path: '/t', ...extra }, session)
const stopLine = (id: string, extra: Record<string, unknown> = {}) =>
  line('stop', { agent_id: id, agent_type: 'litter:falsifier', transcript_path: '/t', stop_hook_active: false, background_tasks: 0, ...extra })

const text = (lines: (object | string)[]) => lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')
const writeSpool = (sid: string, lines: (object | string)[], newline = true) =>
  writeFileSync(spoolPath(dir, sid), text(lines) + (newline ? '\n' : ''))
const spoolFiles = () => readdirSync(spoolDir(dir)).filter(n => n !== 'blobs').sort()
const ctx = (sessionId = 'test-session') => ({ p, litterDir: dir, sessionId })
const ids = () => got.map(l => ('agent_id' in l ? l.agent_id : null))

async function until(check: () => boolean, ms = 2000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise(r => setTimeout(r, 10))
  }
}

describe('policy.json and active', () => {
  test('policy.json is written to a temp file beside it and renamed, never in place', async () => {
    const writes: string[] = []
    const runs: (readonly string[])[] = []
    const write = p.fs.write
    const run = p.run
    p.fs.write = async (path, t) => {
      writes.push(path)
      return write(path, t)
    }
    p.run = async (argv, init) => {
      runs.push(argv)
      return run(argv, init)
    }
    await writePolicy(p, dir, policyFor(RUN))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatch(/\/policy\.json\.tmp-[0-9a-f-]+$/)
    expect(runs).toEqual([['mv', '-f', '--', writes[0]!, policyPath(dir)]])
    expect(await readPolicy(p, dir)).toEqual(policyFor(RUN))
  })

  test('readPolicy: missing or another version reads as undefined', async () => {
    expect(await readPolicy(p, dir)).toBeUndefined()
    await p.fs.write(policyPath(dir), JSON.stringify({ ...policyFor(RUN), v: 2 }))
    expect(await readPolicy(p, dir)).toBeUndefined()
  })

  test('setActive creates and removes the marker, and removing twice is fine', async () => {
    await setActive(p, dir, true)
    expect(existsSync(activePath(dir))).toBe(true)
    await setActive(p, dir, false)
    await setActive(p, dir, false)
    expect(existsSync(activePath(dir))).toBe(false)
  })

  test('updatePolicy applies concurrent changes one after the other', async () => {
    expect(await updatePolicy(p, dir, cur => cur)).toBeUndefined()
    await writePolicy(p, dir, policyFor(RUN))
    await Promise.all([
      updatePolicy(p, dir, cur => ({ ...cur, run: { ...cur.run!, stopping: true } })),
      updatePolicy(p, dir, cur => ({ ...cur, run: { ...cur.run!, launching: true } })),
    ])
    const after = await readPolicy(p, dir)
    expect(after?.run?.stopping).toBe(true)
    expect(after?.run?.launching).toBe(true)
    const before = readFileSync(policyPath(dir), 'utf8')
    await updatePolicy(p, dir, () => null)
    expect(readFileSync(policyPath(dir), 'utf8')).toBe(before)
  })
})

describe('the spool drain', () => {
  test('renames the spool aside, delivers every line once and in order, then removes it', async () => {
    const runs: (readonly string[])[] = []
    const run = p.run
    p.run = async (argv, init) => {
      runs.push(argv)
      return run(argv, init)
    }
    writeSpool('test-session', [startLine('a1'), startLine('a2'), stopLine('a1')])
    const r = await drainSpool(ctx(), [collect])
    expect(r).toEqual({ lines: 3, bad: 0 })
    expect(got.map(l => l.ev)).toEqual(['start', 'start', 'stop'])
    expect(ids()).toEqual(['a1', 'a2', 'a1'])
    expect(runs[0]![0]).toBe('mv')
    expect(runs[0]![3]).toBe(spoolPath(dir, 'test-session'))
    expect(runs[0]![4]).toMatch(/\.jsonl\.draining-[0-9a-f-]+$/)
    expect(spoolFiles()).toEqual([])
    expect(await drainSpool(ctx(), [collect])).toEqual({ lines: 0, bad: 0 })
    expect(got).toHaveLength(3)
  })

  test('a line that does not parse or is no spool line is logged and skipped', async () => {
    writeSpool('test-session', [
      'not json',
      '[1]',
      line('start', { v: 2, agent_id: 'x', agent_type: 't', cwd: '/w' }),
      line('nope'),
      line('start', { agent_type: 't', cwd: '/w' }),
      { v: 1, ev: 'stop', agent_id: 'x', agent_type: 't' },
      '',
      startLine('ok'),
    ])
    const r = await drainSpool(ctx(), [collect])
    expect(r).toEqual({ lines: 7, bad: 6 })
    expect(ids()).toEqual(['ok'])
    expect(p.logs.filter(l => l.includes('skipped a line'))).toHaveLength(6)
    expect(p.logs.join('\n')).toContain("it doesn't parse")
    expect(p.logs.join('\n')).toContain('no agent_id')
  })

  test('a consumer that throws is logged, and every consumer still gets every line', async () => {
    writeSpool('test-session', [startLine('a1'), startLine('a2')])
    const boom: SpoolConsumer = async () => {
      throw new Error('boom')
    }
    await drainSpool(ctx(), [boom, collect])
    expect(ids()).toEqual(['a1', 'a2'])
    expect(p.logs.filter(l => l.includes('a consumer failed') && l.includes('boom'))).toHaveLength(2)
  })

  test('a spool that grows during a drain: the aside file is read to its end, the live one waits for the next drain', async () => {
    writeSpool('test-session', [startLine('a1'), startLine('a2')])
    let first = true
    const grow: SpoolConsumer = async () => {
      if (!first) return
      first = false
      const aside = readdirSync(spoolDir(dir)).find(n => n.includes('.draining-'))!
      // A hook that opened the spool just before the rename, and one after it.
      appendFileSync(`${spoolDir(dir)}/${aside}`, `${JSON.stringify(startLine('late-aside'))}\n`)
      appendFileSync(spoolPath(dir, 'test-session'), `${JSON.stringify(startLine('next'))}\n`)
    }
    await drainSpool(ctx(), [grow, collect])
    expect(ids()).toEqual(['a1', 'a2', 'late-aside'])
    expect(spoolFiles()).toEqual(['test-session.jsonl'])
    await drainSpool(ctx(), [collect])
    expect(ids()).toEqual(['a1', 'a2', 'late-aside', 'next'])
  })

  test('a last line without its newline is still delivered', async () => {
    writeSpool('test-session', [startLine('a1'), startLine('a2')], false)
    expect(await drainSpool(ctx(), [collect])).toEqual({ lines: 2, bad: 0 })
    expect(ids()).toEqual(['a1', 'a2'])
  })

  test('a line naming a blob gets it merged in, and the blob is removed after', async () => {
    mkdirSync(spoolBlobDir(dir), { recursive: true })
    const full = line('output', { agent_id: 'c1', agent_type: 'litter:gate-critic', tool_use_id: 'tu1', input: { big: 'x'.repeat(5000) } })
    writeFileSync(`${spoolBlobDir(dir)}/b1.json`, JSON.stringify(full))
    writeFileSync(`${spoolBlobDir(dir)}/b2.json`, JSON.stringify({ only: 'the input' }))
    const stub = (file: unknown, id = 'c1') => line('output', { agent_id: id, agent_type: 'litter:gate-critic', tool_use_id: 'tu1', file })
    writeSpool('test-session', [stub('b1.json'), stub('b2', 'c2'), stub('../escape', 'c3'), stub('missing.json', 'c4')])
    const r = await drainSpool(ctx(), [collect])
    expect(r).toEqual({ lines: 4, bad: 2 })
    expect(got).toHaveLength(2)
    expect(got[0]).toEqual(full as SpoolLine)
    expect('file' in got[0]!).toBe(false)
    expect((got[1] as { input?: unknown }).input).toEqual({ only: 'the input' })
    expect(readdirSync(spoolBlobDir(dir))).toEqual([])
  })

  test('drainAllSpools: the unfinished aside files first, then every live spool, oldest first', async () => {
    writeFileSync(`${spoolDir(dir)}/old0.jsonl.draining-abc`, `${JSON.stringify(startLine('from-aside', {}, 'old0'))}\n`)
    writeSpool('old1', [startLine('from-old1', {}, 'old1')])
    writeSpool('old2', [startLine('from-old2', {}, 'old2')])
    utimesSync(spoolPath(dir, 'old2'), new Date(1_000_000_000), new Date(1_000_000_000))
    utimesSync(spoolPath(dir, 'old1'), new Date(1_500_000_000_000), new Date(1_500_000_000_000))
    const sessions: string[] = []
    const seen: SpoolConsumer = async c => void sessions.push(c.sessionId)
    await drainAllSpools(p, dir, [collect, seen])
    expect(ids()).toEqual(['from-aside', 'from-old2', 'from-old1'])
    expect(sessions).toEqual(['old0', 'old2', 'old1'])
    expect(spoolFiles()).toEqual([])
  })

  test("drainAllSpools leaves the spool of a run another live session owns", async () => {
    await writePolicy(p, dir, policyFor(RUN, 'other'))
    await setActive(p, dir, true)
    writeSpool('other', [startLine('theirs', {}, 'other')])
    writeFileSync(`${spoolDir(dir)}/other.jsonl.draining-abc`, `${JSON.stringify(startLine('theirs-too', {}, 'other'))}\n`)
    writeSpool('dead', [startLine('stale', {}, 'dead')])
    await drainAllSpools(p, dir, [collect])
    expect(ids()).toEqual(['stale'])
    expect(spoolFiles()).toEqual(['other.jsonl', 'other.jsonl.draining-abc'])
    // Once the run is no longer active there, its spool is drained like any other.
    await setActive(p, dir, false)
    await drainAllSpools(p, dir, [collect])
    expect(ids()).toEqual(['stale', 'theirs-too', 'theirs'])
  })

  test('drainAllSpools leaves the spool of a swarm another live session owns, while its beat is fresh', async () => {
    p.clock.now = 1_000_000_000
    const entry = (session: string, checkedAt: number) => ({
      launch: '20270115-093005',
      state: 'live' as const,
      commonDir: `${dir}/.git`,
      owner: { ref: `refs/litter-swarm/${session}`, oid: 'a'.repeat(40), generation: 1, session, checkedAt },
      nodeTypes: [],
    })
    await writePolicy(p, dir, {
      ...policyFor(null, 'x'),
      swarm: { swarms: { alpha: entry('owner', 1_000_000 - 5), beta: entry('gone', 1_000_000 - 120) } },
    })
    writeSpool('owner', [startLine('theirs', {}, 'owner')])
    writeSpool('gone', [startLine('stale', {}, 'gone')])
    await drainAllSpools(p, dir, [collect])
    expect(ids()).toEqual(['stale'])
    expect(spoolFiles()).toEqual(['owner.jsonl'])
  })

  test("after a /clear the policy names the new session, and both sessions' spools are drained", async () => {
    let sid = 's-before'
    p.sessionId = async () => sid
    await drainOwnSpools(p, dir, [collect])
    await writePolicy(p, dir, policyFor(RUN, 's-before'))
    sid = 's-after'
    writeSpool('s-before', [startLine('before', {}, 's-before')])
    writeSpool('s-after', [startLine('after', {}, 's-after')])
    await drainOwnSpools(p, dir, [collect])
    expect((await readPolicy(p, dir))?.session).toBe('s-after')
    expect(ids().sort()).toEqual(['after', 'before'])
  })

  test("another session's run is left alone: its policy and its spool", async () => {
    await writePolicy(p, dir, policyFor(RUN, 'someone-else'))
    writeSpool('test-session', [startLine('mine')])
    writeSpool('someone-else', [startLine('theirs', {}, 'someone-else')])
    await drainOwnSpools(p, dir, [collect])
    expect((await readPolicy(p, dir))?.session).toBe('someone-else')
    expect(ids()).toEqual(['mine'])
    expect(spoolFiles()).toEqual(['someone-else.jsonl'])
  })
})

describe('the drain timer', () => {
  test('ticks every 2 s, drains only while a run is active, and a restart replaces it', async () => {
    let every = 0
    const ev = p.every
    p.every = (ms, fn) => {
      every = ms
      return ev(ms, fn)
    }
    updateSession({ litterDir: dir })
    startDrainTimer(p, [collect])
    expect(every).toBe(2000)
    expect(p.timers.size).toBe(1)
    const tick = [...p.timers][0]!
    writeSpool('test-session', [startLine('a1')])
    tick()
    await new Promise(r => setTimeout(r, 50))
    expect(got).toEqual([])
    await setActive(p, dir, true)
    tick()
    await until(() => got.length === 1)
    expect(ids()).toEqual(['a1'])
    startDrainTimer(p, [collect])
    expect(p.timers.size).toBe(1)
    expect([...p.timers][0]).not.toBe(tick)
  })
})

describe('the agent map', () => {
  test('a litter role started while a run is active belongs to that run', async () => {
    await writePolicy(p, dir, policyFor(RUN))
    await consumeAgents(ctx(), startLine('a1', { agent_type: 'litter:executor', cwd: '/wt/café' }) as SpoolLine)
    expect(await agentInfo(p, 'a1')).toEqual({
      agentId: 'a1',
      agentType: 'litter:executor',
      role: 'executor',
      run: RUN,
      cwd: '/wt/café',
      started: 1_700_000_000_000,
      stopped: null,
      sessionId: 'test-session',
      transcriptPath: '/t',
    })
    expect(await runAgents(p, RUN)).toEqual(['a1'])
  })

  test('a cwd is kept composed (NFC), as macOS may spell it decomposed', async () => {
    await consumeAgents(ctx(), startLine('n1', { cwd: '/wt/café' }) as SpoolLine)
    expect((await agentInfo(p, 'n1'))?.cwd).toBe('/wt/café')
  })

  test('an agent that is no litter role, or starts with no run active, has no run', async () => {
    await writePolicy(p, dir, policyFor(RUN))
    await consumeAgents(ctx(), startLine('gp', { agent_type: 'general-purpose' }) as SpoolLine)
    await consumeAgents(ctx(), startLine('fake', { agent_type: 'litter:nope' }) as SpoolLine)
    await writePolicy(p, dir, policyFor(null))
    await consumeAgents(ctx(), startLine('idle') as SpoolLine)
    for (const id of ['gp', 'fake', 'idle']) expect((await agentInfo(p, id))?.run).toBeNull()
    expect((await agentInfo(p, 'gp'))?.role).toBeNull()
    expect((await agentInfo(p, 'fake'))?.role).toBeNull()
    expect((await agentInfo(p, 'idle'))?.role).toBe('falsifier')
    expect(roleOf('litter:design-critic')).toBe('design-critic')
    expect(roleOf('design-critic')).toBeNull()
  })

  test('a repeated start changes nothing; a contradicting one is logged and ignored', async () => {
    await writePolicy(p, dir, policyFor(RUN))
    await consumeAgents(ctx(), startLine('a1') as SpoolLine)
    const first = await agentInfo(p, 'a1')
    await consumeAgents(ctx(), startLine('a1') as SpoolLine)
    await consumeAgents(ctx(), startLine('a1', { agent_type: 'litter:executor' }) as SpoolLine)
    await consumeAgents(ctx(), startLine('a1', { cwd: '/elsewhere' }) as SpoolLine)
    expect(await agentInfo(p, 'a1')).toEqual(first)
    expect(await runAgents(p, RUN)).toEqual(['a1'])
    expect(p.logs.filter(l => l.includes('contradicts'))).toHaveLength(2)
  })

  test('a stop is recorded once; one for an unknown agent, or another type, is logged and ignored', async () => {
    await writePolicy(p, dir, policyFor(RUN))
    await consumeAgents(ctx(), startLine('a1') as SpoolLine)
    await consumeAgents(ctx(), stopLine('ghost') as SpoolLine)
    await consumeAgents(ctx(), stopLine('a1', { agent_type: 'litter:relay' }) as SpoolLine)
    expect((await agentInfo(p, 'a1'))?.stopped).toBeNull()
    expect(await agentInfo(p, 'ghost')).toBeUndefined()
    await consumeAgents(ctx(), stopLine('a1', { ts: 1_700_000_010 }) as SpoolLine)
    await consumeAgents(ctx(), stopLine('a1', { ts: 1_700_000_020 }) as SpoolLine)
    expect((await agentInfo(p, 'a1'))?.stopped).toBe(1_700_000_010_000)
    expect(p.logs.join('\n')).toContain('a stop for an agent with no start')
    // Messaged again after it stopped, it starts again under the same id.
    await consumeAgents(ctx(), startLine('a1') as SpoolLine)
    expect((await agentInfo(p, 'a1'))?.stopped).toBeNull()
  })

  test("forgetRunAgents drops a run's agents", async () => {
    await writePolicy(p, dir, policyFor(RUN))
    await consumeAgents(ctx(), startLine('a1') as SpoolLine)
    await consumeAgents(ctx(), startLine('a2') as SpoolLine)
    expect(await runAgents(p, RUN)).toEqual(['a1', 'a2'])
    await forgetRunAgents(p, RUN)
    expect(await runAgents(p, RUN)).toEqual([])
    expect(await agentInfo(p, 'a1')).toBeUndefined()
  })

  test('drained end to end, the map is built from the spool', async () => {
    await writePolicy(p, dir, policyFor(RUN))
    writeSpool('test-session', [startLine('a1'), stopLine('a1')])
    await drainSpool(ctx(), [consumeAgents])
    expect(await agentInfo(p, 'a1')).toEqual(expect.objectContaining({ run: RUN, stopped: 1_700_000_000_000 }))
  })
})
