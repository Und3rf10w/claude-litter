// Tier 2: readLedger with a read cache (Ports.ledgerCache), as the mod reads:
// a read walks only the files past what an earlier read verified, a whole
// walk comes back every fullEveryMs, and the answers match a whole walk's.
// And the hook's signal (Ports.signal): a walk stops once it aborts, an
// append doesn't.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendRecord, type Head, headKey, LedgerReadCache, LedgerTampered, readLedger } from '../../hooks/ledgercore'
import { ledgerDir } from '../../hooks/layout'
import { HookAborted, type Ports } from '../../hooks/ports'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const RUN = '20261105-cache'
const by = { source: 'mod' } as const

let p: TestPorts
let cache: LedgerReadCache
let dir: string
let cleanup: () => void
/** The record files `fs.read` opened, in order. */
let opened: string[]

beforeEach(() => {
  p = nodePorts()
  p.clock.now = 1_000_000
  cache = new LedgerReadCache({ fullEveryMs: 60_000, max: 4 })
  p.ledgerCache = cache
  opened = []
  const read = p.fs.read
  p.fs.read = async path => {
    if (path.includes('/ledger/')) opened.push(path.slice(path.lastIndexOf('/') + 1))
    return read(path)
  }
  ;({ dir, cleanup } = scratch())
})
afterEach(() => cleanup())

const add = (n: number, kind = 'finding') => appendRecord(p, dir, { run: RUN, kind, by, body: { n } })
async function addMany(n: number): Promise<void> {
  for (let i = 1; i <= n; i++) await add(i)
}
const file = (name: string) => join(ledgerDir(dir), name)
/** The same ledger read with no cache: what every read must answer. */
const whole = () => readLedger({ ...p, ledgerCache: undefined } as Ports, dir, RUN)

describe('ledgercore: the read cache', () => {
  test('appends keep the cache at the head, so a read opens no record file, and answers as a whole walk', async () => {
    await addMany(3)
    opened = []
    await add(4)
    expect(opened).toEqual([])
    const r = await readLedger(p, dir, RUN)
    expect(opened).toEqual([])
    const w = await whole()
    expect(r).toEqual(w)
    expect(r.records.map(x => x.seq)).toEqual([1, 2, 3, 4])
  })

  test("a read opens only the files past the cached ones: another store's appends, say", async () => {
    await addMany(2)
    await readLedger(p, dir, RUN)
    // Appended through ports with no cache: the cache doesn't see them.
    const other = { ...p, ledgerCache: undefined } as Ports
    await appendRecord(other, dir, { run: RUN, kind: 'verify', by, body: {} })
    await appendRecord(other, dir, { run: RUN, kind: 'verify', by, body: {} })
    opened = []
    const r = await readLedger(p, dir, RUN)
    expect(opened).toEqual(['000003-verify.json', '000004-verify.json'])
    expect(r).toEqual(await whole())
  })

  test('the first read after fullEveryMs walks the whole ledger again, and catches a record rewritten in place', async () => {
    await addMany(3)
    await readLedger(p, dir, RUN)
    const first = file('000001-finding.json')
    writeFileSync(first, `${JSON.stringify({ ...JSON.parse(await p.fs.read(first)), body: { n: 9 } })}\n`)
    // Inside the window the cached prefix stands: the rewrite isn't read yet.
    p.clock.now! += 59_000
    opened = []
    expect((await readLedger(p, dir, RUN)).tampered).toBeNull()
    expect(opened).toEqual([])
    p.clock.now! += 1_000
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered?.seq).toBe(2)
    expect(r).toEqual(await whole())
    // A broken chain isn't kept: the append after it walks whole and refuses.
    expect(cache.peek(dir)).toBeNull()
    await expect(add(4)).rejects.toBeInstanceOf(LedgerTampered)
  })

  test('a read walks whole when the listing no longer starts with the cached names: a file removed or renamed', async () => {
    await addMany(3)
    await readLedger(p, dir, RUN)
    renameSync(file('000002-finding.json'), file('000002-verify.json'))
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered?.seq).toBe(2)
    expect(r).toEqual(await whole())

    cache.forget(dir)
    renameSync(file('000002-verify.json'), file('000002-finding.json'))
    await readLedger(p, dir, RUN)
    unlinkSync(file('000003-finding.json'))
    const cut = await readLedger(p, dir, RUN)
    expect(cut.tampered).toEqual({ seq: 3, reason: 'the ledger ends at 2, but its head is 3' })
    expect(cut).toEqual(await whole())
  })

  test("a read walks whole when the stored head doesn't fit the cache: moved back, or another hash", async () => {
    await addMany(2)
    const back = p.storeMap.get(headKey(dir)) as Head
    await add(3)
    await readLedger(p, dir, RUN)
    p.storeMap.set(headKey(dir), back)
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered).toEqual({ seq: 3, reason: 'record 000003-finding.json was added after the head 2' })
    expect(r).toEqual(await whole())

    p.storeMap.set(headKey(dir), { v: 2, seq: 3, sha: 'f'.repeat(64) } satisfies Head)
    const other = await readLedger(p, dir, RUN)
    expect(other.tampered?.seq).toBe(3)
    expect(other).toEqual(await whole())
  })

  test('a broken last file is never cached: the records before it are, and the append that replaces it chains on', async () => {
    await addMany(1)
    writeFileSync(file('000002-finding.json'), '{"v":1,"seq"')
    const r = await readLedger(p, dir, RUN)
    expect(r.brokenTail).toBe('000002-finding.json')
    expect(cache.peek(dir)?.names).toEqual(['000001-finding.json'])
    const next = await add(2, 'verify')
    expect(next.seq).toBe(2)
    expect(await readLedger(p, dir, RUN)).toEqual(await whole())
  })

  test('the returned records are a fresh list each read: a caller that pushes onto one changes no later read', async () => {
    await addMany(2)
    const a = await readLedger(p, dir, RUN)
    a.records.push(a.records[0]!)
    const b = await readLedger(p, dir, RUN)
    expect(b.records).toHaveLength(2)
  })

  test('the cache keeps the most recently read ledgers, up to max', async () => {
    const dirs = [dir, ...[1, 2, 3, 4].map(() => scratch())]
    try {
      for (const d of dirs) {
        const at = typeof d === 'string' ? d : d.dir
        await appendRecord(p, at, { run: RUN, kind: 'finding', by, body: {} })
      }
      expect(cache.size).toBe(4)
      expect(cache.peek(dir)).toBeNull()
    } finally {
      for (const d of dirs) if (typeof d !== 'string') d.cleanup()
    }
  })

  test('a read for another run name of the same folder walks whole and answers as a whole walk', async () => {
    await addMany(2)
    await readLedger(p, dir, RUN)
    const r = await readLedger(p, dir, 'another-run')
    expect(r.tampered).toEqual({ seq: 1, reason: "record 000001-finding.json doesn't match its place in the ledger" })
  })
})

describe("ledgercore: the hook's signal", () => {
  test('an aborted signal stops a walk before its next file, with HookAborted, and nothing is cached', async () => {
    await addMany(3)
    cache.forget(dir)
    const stop = new AbortController()
    const signalled = { ...p, signal: stop.signal } as Ports
    let reads = 0
    signalled.fs = {
      ...p.fs,
      read: async path => {
        if (++reads === 2) stop.abort()
        return p.fs.read(path)
      },
    }
    await expect(readLedger(signalled, dir, RUN)).rejects.toBeInstanceOf(HookAborted)
    expect(reads).toBe(2)
    expect(cache.peek(dir)).toBeNull()
  })

  test('an append under an aborted signal still reads and writes: writes are never cut short', async () => {
    await addMany(2)
    cache.forget(dir)
    const stop = new AbortController()
    stop.abort()
    const rec = await appendRecord({ ...p, signal: stop.signal } as Ports, dir, { run: RUN, kind: 'verify', by, body: {} })
    expect(rec.seq).toBe(3)
    expect((await whole()).records.map(x => x.kind)).toEqual(['finding', 'finding', 'verify'])
  })

  test('a read with a signal that never aborts answers as one without', async () => {
    await addMany(2)
    const r = await readLedger({ ...p, signal: new AbortController().signal } as Ports, dir, RUN)
    expect(r).toEqual(await whole())
  })
})
