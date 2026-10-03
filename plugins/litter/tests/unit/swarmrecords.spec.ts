// Tier 2: a swarm's records (hooks/records/swarm.ts; WP-C §6): the spec
// ledger and a launch's, launch ids with their collision suffix, and the kind
// rules through the record tool's dispatcher: a node's swarm.bind and the
// lead's swarm.end reach their handlers with no run resolved, and every mod
// kind is refused.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordError, RecordReply } from '../../hooks/records/core'
import { dispatchRecord, type DispatchEnv } from '../../hooks/ledger'
import { launchDir, launchesDir, ledgerDir, swarmDir } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { KIND_RULES, KNOWN_KINDS, MOD_ONLY_KINDS } from '../../hooks/records/design'
import {
  appendLaunchRecord,
  appendSpecRecord,
  launchStamp,
  listLaunches,
  newLaunchId,
  readLaunchLedger,
  readSpecLedger,
  SWARM_LAUNCH_KINDS,
  SWARM_SPEC_KINDS,
} from '../../hooks/records/swarm'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

// 2027-01-15 09:30:05 UTC.
const NOW = Date.UTC(2027, 0, 15, 9, 30, 5)

let p: TestPorts
let dir: string
let cleanup: () => void
let env: DispatchEnv

beforeEach(() => {
  p = nodePorts()
  p.clock.now = NOW
  ;({ dir, cleanup } = scratch())
  env = { litterDir: dir, litterDirError: null, ready: true, options: normalizeOptions(undefined) }
})
afterEach(() => cleanup())

const asError = (r: RecordReply) => {
  expect(r.ok).toBe(false)
  return r as RecordError
}

describe('the two ledgers', () => {
  test("the spec ledger is the swarm folder's, run swarm:<name>, by the mod unless told", async () => {
    await appendSpecRecord(p, dir, 'alpha', 'swarm.revision', { n: 1, from: 'save', changes: ['nodes'] })
    await appendSpecRecord(p, dir, 'alpha', 'swarm.proposal.decided', { proposal: 1, accepted: 'none' }, { source: 'launcher' })
    const files = readdirSync(ledgerDir(swarmDir(dir, 'alpha'))).sort()
    expect(files).toEqual(['000001-swarm.revision.json', '000002-swarm.proposal.decided.json'])
    const { records, tampered } = await readSpecLedger(p, dir, 'alpha')
    expect(tampered).toBeNull()
    expect(records.map(r => [r.run, r.kind, r.by.source])).toEqual([
      ['swarm:alpha', 'swarm.revision', 'mod'],
      ['swarm:alpha', 'swarm.proposal.decided', 'launcher'],
    ])
  })

  test("a launch's ledger is its folder's, run swarm:<name>/<launch>, apart from the spec's and other launches'", async () => {
    await appendLaunchRecord(p, dir, 'alpha', '20270115-093005', 'swarm.stopping', { by: 'lead' })
    await appendLaunchRecord(p, dir, 'alpha', '20270115-093005', 'swarm.stop', { nodes: ['a1'], how: 'soft' })
    await appendLaunchRecord(p, dir, 'alpha', '20270115-093005-2', 'swarm.stopping', { by: 'browser' })
    expect(existsSync(ledgerDir(launchDir(dir, 'alpha', '20270115-093005')))).toBe(true)
    const one = await readLaunchLedger(p, dir, 'alpha', '20270115-093005')
    expect(one.records.map(r => [r.seq, r.run, r.kind])).toEqual([
      [1, 'swarm:alpha/20270115-093005', 'swarm.stopping'],
      [2, 'swarm:alpha/20270115-093005', 'swarm.stop'],
    ])
    expect((await readLaunchLedger(p, dir, 'alpha', '20270115-093005-2')).records.length).toBe(1)
    expect((await readSpecLedger(p, dir, 'alpha')).records).toEqual([])
  })

  test("a launch ledger read under another launch's run refuses its records", async () => {
    await appendLaunchRecord(p, dir, 'alpha', '20270115-093005', 'swarm.stopping', { by: 'lead' })
    // Copy launch one's ledger under launch two: its records carry the wrong run.
    const from = ledgerDir(launchDir(dir, 'alpha', '20270115-093005'))
    const to = ledgerDir(launchDir(dir, 'alpha', '20270115-093006'))
    mkdirSync(to, { recursive: true })
    for (const f of readdirSync(from)) writeFileSync(join(to, f), readFileSync(join(from, f)))
    const r = await readLaunchLedger(p, dir, 'alpha', '20270115-093006')
    expect(r.tampered).not.toBeNull()
  })

  test('the kind lists cover every swarm kind once', () => {
    const all = [...SWARM_SPEC_KINDS, ...SWARM_LAUNCH_KINDS]
    expect(new Set(all).size).toBe(all.length)
    for (const k of all) expect(KNOWN_KINDS as readonly string[]).toContain(k)
  })
})

describe('launch ids', () => {
  test('launchStamp is <yyyymmdd-hhmmss> in UTC', () => {
    expect(launchStamp(NOW)).toBe('20270115-093005')
    expect(launchStamp(Date.UTC(2027, 11, 31, 23, 59, 59))).toBe('20271231-235959')
  })

  test('newLaunchId makes the folder, and a collision takes -2, -3', async () => {
    expect(await newLaunchId(p, dir, 'alpha')).toBe('20270115-093005')
    expect(await newLaunchId(p, dir, 'alpha')).toBe('20270115-093005-2')
    expect(await newLaunchId(p, dir, 'alpha')).toBe('20270115-093005-3')
    expect(readdirSync(launchesDir(dir, 'alpha')).sort()).toEqual(['20270115-093005', '20270115-093005-2', '20270115-093005-3'])
  })

  test('concurrent callers never take one id', async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => newLaunchId(p, dir, 'alpha')))
    expect(new Set(ids).size).toBe(6)
  })

  test('a folder another session made is skipped', async () => {
    mkdirSync(launchDir(dir, 'alpha', '20270115-093005'), { recursive: true })
    expect(await newLaunchId(p, dir, 'alpha')).toBe('20270115-093005-2')
  })

  test('listLaunches answers the launch folders oldest first, -10 after -9, and ignores anything else', async () => {
    expect(await listLaunches(p, dir, 'alpha')).toEqual([])
    for (const id of ['20270115-093005-10', '20270115-093005', '20270115-093005-9', '20270114-120000', 'notes']) {
      mkdirSync(launchDir(dir, 'alpha', id), { recursive: true })
    }
    writeFileSync(join(launchesDir(dir, 'alpha'), '20270116-000000'), 'a file')
    expect(await listLaunches(p, dir, 'alpha')).toEqual(['20270114-120000', '20270115-093005', '20270115-093005-9', '20270115-093005-10'])
  })
})

describe('the kind rules, through the record tool', () => {
  const call = (fields: Record<string, unknown>, agentId?: string) =>
    dispatchRecord(p, agentId, { tool: 'mcp__litter__record', tool_use_id: 'tu1', ...fields }, env)

  test('swarm.bind is an agent kind with no run; swarm.end a launcher kind with no run; the rest are the mod\'s', () => {
    expect(KIND_RULES['swarm.bind']).toEqual({ by: 'agent', run: 'none' })
    expect(KIND_RULES['swarm.end']).toEqual({ by: 'launcher', run: 'none' })
    for (const k of [...SWARM_SPEC_KINDS, ...SWARM_LAUNCH_KINDS]) {
      if (k === 'swarm.bind' || k === 'swarm.end') expect(MOD_ONLY_KINDS).not.toContain(k)
      else expect({ k, modOnly: MOD_ONLY_KINDS.includes(k) }).toEqual({ k, modOnly: true })
    }
  })

  test("a node's swarm.bind reaches its handler with no run resolved", async () => {
    const r = asError(await call({ kind: 'swarm.bind', token: 'abc' }, 'agent-1'))
    expect(r.error).toBe("litter: 'token' is required: the Bind token line of your <instance> block")
    expect(r.field).toBe('token')
  })

  test("the lead's swarm.end reaches its handler with no run resolved", async () => {
    const r = asError(await call({ kind: 'swarm.end', swarm: 'alpha' }))
    expect(r.error).toBe("litter: there's no live swarm named alpha")
    expect(r.field).toBe('swarm')
  })

  test('swarm.bind from the main thread, and swarm.end from an agent, are refused naming kind', async () => {
    const bind = asError(await call({ kind: 'swarm.bind', token: 'abc' }))
    expect(bind.field).toBe('kind')
    expect(bind.error).toContain('recorded by a litter run')
    const end = asError(await call({ kind: 'swarm.end', swarm: 'alpha' }, 'agent-1'))
    expect(end.field).toBe('kind')
    expect(end.error).toContain('main thread')
  })

  test('every mod kind is refused, from the lead and from an agent, naming kind', async () => {
    for (const kind of [...SWARM_SPEC_KINDS, ...SWARM_LAUNCH_KINDS].filter(k => k !== 'swarm.bind' && k !== 'swarm.end')) {
      for (const agentId of [undefined, 'agent-1']) {
        const r = asError(await call({ kind, swarm: 'alpha' }, agentId))
        expect({ kind, error: r.error, field: r.field }).toEqual({
          kind,
          error: `litter: '${kind}' is recorded by litter itself, never through this tool`,
          field: 'kind',
        })
      }
    }
  })
})
