// Tier 2: the ledger's chain against real files. A sample of the pattern each
// package follows: node ports, a scratch folder, real reads and writes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { appendRecord, type Head, headKey, type LedgerRead, LedgerTampered, readLedger, RecordTooLarge } from '../../hooks/ledgercore'
import { sha256 } from '../../hooks/fsx'
import { ledgerDir, ledgerFileName } from '../../hooks/layout'
import type { Ports } from '../../hooks/ports'
import { RECORD_MAX_BYTES } from '../../hooks/records/core'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const RUN = '20261002-sample'
const by = { source: 'mod' } as const

let p: TestPorts
let dir: string
let cleanup: () => void

beforeEach(() => {
  p = nodePorts()
  ;({ dir, cleanup } = scratch())
})
afterEach(() => cleanup())

const files = () => readdirSync(ledgerDir(dir)).sort()

describe('ledgercore', () => {
  test('appends chain by sha256 and move the head', async () => {
    const a = await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: { n: 1 } })
    const b = await appendRecord(p, dir, { run: RUN, kind: 'verify', by, body: { n: 2 } })
    expect(a.seq).toBe(1)
    expect(a.prev).toBeNull()
    expect(b.seq).toBe(2)
    expect(b.prev).toMatch(/^[0-9a-f]{64}$/)
    expect(files()).toEqual(['000001-finding.json', '000002-verify.json'])
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered).toBeNull()
    expect(r.records.map(x => x.kind)).toEqual(['finding', 'verify'])
    expect(p.storeMap.get(headKey(dir))).toEqual(r.head)
  })

  test('concurrent appends to one run never share a seq', async () => {
    await Promise.all([1, 2, 3, 4, 5].map(n => appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: { n } })))
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered).toBeNull()
    expect(r.records.map(x => x.seq)).toEqual([1, 2, 3, 4, 5])
  })

  test('an edited record is tampered, and the next append refuses', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: { n: 1 } })
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: { n: 2 } })
    const first = join(ledgerDir(dir), '000001-finding.json')
    writeFileSync(first, `${JSON.stringify({ ...JSON.parse(await p.fs.read(first)), body: { n: 9 } })}\n`)
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered?.seq).toBe(2)
    await expect(appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })).rejects.toBeInstanceOf(LedgerTampered)
  })

  test('a record removed from the end is tampered', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    unlinkSync(join(ledgerDir(dir), '000002-finding.json'))
    expect((await readLedger(p, dir, RUN)).tampered?.seq).toBe(2)
  })

  test('a cut-off last file past the head is a broken tail, removed by the next append', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    writeFileSync(join(ledgerDir(dir), '000002-finding.json'), '{"v":1,"seq"')
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered).toBeNull()
    expect(r.brokenTail).toBe('000002-finding.json')
    const next = await appendRecord(p, dir, { run: RUN, kind: 'verify', by, body: {} })
    expect(next.seq).toBe(2)
    expect(files()).toEqual(['000001-finding.json', '000002-verify.json'])
  })

  test('a valid record past a head with no intent (from before intents) is tampered, not adopted', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    const head = p.storeMap.get(headKey(dir))
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    p.storeMap.set(headKey(dir), head)
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered).toEqual({ seq: 2, reason: 'record 000002-finding.json was added after the head 1' })
    expect(r.records).toHaveLength(1)
    expect(p.storeMap.get(headKey(dir))).toEqual(head)
  })

  test('a record over the limit is refused, naming its largest field', async () => {
    const big = 'x'.repeat(RECORD_MAX_BYTES)
    const err = await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: { small: 1, big } }).catch(e => e)
    expect(err).toBeInstanceOf(RecordTooLarge)
    expect((err as RecordTooLarge).field).toBe('big')
  })
})

// A record past the stored head is adopted only when the head's intent
// (`pending`) names it: what appendRecord left after a crash between writing
// the file and moving the head. Anything else past it was appended by
// something else, such as a role's sandbox writing the checkout.
describe('ledgercore: the intent before each append', () => {
  const head = () => p.storeMap.get(headKey(dir)) as Head | undefined

  /** Record <seq>, chained to the last file, written as appendRecord would, but not through it. */
  async function forge(seq: number, kind: string, body: unknown = {}): Promise<string> {
    const last = files().at(-1)!
    const rec = { v: 1, seq, kind, run: RUN, at: 1, by, prev: await sha256(await p.fs.read(join(ledgerDir(dir), last))), body }
    const text = `${JSON.stringify(rec)}\n`
    writeFileSync(join(ledgerDir(dir), ledgerFileName(seq, kind)), text)
    return text
  }

  /** p, with `store.set` failing at its <n>th call and `fs.write` at its <w>th: a crash there. */
  function crashing(at: { set?: number; write?: number }): Ports {
    let sets = 0
    let writes = 0
    return {
      ...p,
      store: { ...p.store, set: async (k, v) => (++sets === at.set ? Promise.reject(new Error('crash')) : p.store.set(k, v)) },
      fs: { ...p.fs, write: async (f, t) => (++writes === at.write ? Promise.reject(new Error('crash')) : p.fs.write(f, t)) },
    }
  }

  test('a forged run.end appended past the head reads as tampered, and the next append refuses', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'run.start', by, body: {} })
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    const before = head()
    await forge(3, 'run.end', { outcome: 'done' })
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered).toEqual({ seq: 3, reason: 'record 000003-run.end.json was added after the head 2' })
    expect(r.records.map(x => x.kind)).toEqual(['run.start', 'finding'])
    expect(head()).toEqual(before!)
    await expect(appendRecord(p, dir, { run: RUN, kind: 'run.end', by, body: {} })).rejects.toBeInstanceOf(LedgerTampered)
  })

  test('each append sets the intent first, then writes the file, then moves the head with no intent', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    const first = head()!
    const seen: unknown[] = []
    const q: Ports = { ...p, store: { ...p.store, set: async (k, v) => (seen.push(v), p.store.set(k, v)) } }
    const second = await appendRecord(q, dir, { run: RUN, kind: 'verify', by, body: {} })
    const sha = await sha256(await p.fs.read(join(ledgerDir(dir), '000002-verify.json')))
    expect(seen).toEqual([{ ...first, pending: { seq: 2, sha } }, { seq: 2, sha }])
    expect(second).toMatchObject({ seq: 2, prev: first.sha })
    expect(head()).toEqual({ seq: 2, sha })
  })

  test("a run's first record has an intent too, over seq 0", async () => {
    const seen: unknown[] = []
    const q: Ports = { ...p, store: { ...p.store, set: async (k, v) => (seen.push(v), p.store.set(k, v)) } }
    await appendRecord(q, dir, { run: RUN, kind: 'run.start', by, body: {} })
    const sha = await sha256(await p.fs.read(join(ledgerDir(dir), '000001-run.start.json')))
    expect(seen).toEqual([{ seq: 0, sha: '', pending: { seq: 1, sha } }, { seq: 1, sha }])
  })

  test('a crash after the file was written, before the head moved: the record the intent names is adopted, and the next append moves the head past it', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    await expect(appendRecord(crashing({ set: 2 }), dir, { run: RUN, kind: 'verify', by, body: {} })).rejects.toThrow('crash')
    const crashed = head()!
    expect(crashed.pending?.seq).toBe(2)
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered).toBeNull()
    expect(r.records.map(x => x.kind)).toEqual(['finding', 'verify'])
    expect(r.head?.seq).toBe(2)
    // The read leaves the head, intent and all: only an append moves it.
    expect(head()).toEqual(crashed)
    const third = await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    expect(third).toMatchObject({ seq: 3, prev: r.head!.sha })
    expect(head()).toEqual({ seq: 3, sha: expect.any(String) })
    expect((await readLedger(p, dir, RUN)).tampered).toBeNull()
  })

  test("a crash on a run's first record, after its file was written, is adopted the same way", async () => {
    await expect(appendRecord(crashing({ set: 2 }), dir, { run: RUN, kind: 'run.start', by, body: {} })).rejects.toThrow('crash')
    expect(head()).toMatchObject({ seq: 0, sha: '', pending: { seq: 1 } })
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered).toBeNull()
    expect(r.head?.seq).toBe(1)
    expect((await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })).seq).toBe(2)
    expect(head()?.seq).toBe(2)
  })

  test('a crash after the intent, before the file was written: the ledger ends at the head, and the next append replaces the intent', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    const before = head()!
    await expect(appendRecord(crashing({ write: 1 }), dir, { run: RUN, kind: 'verify', by, body: {} })).rejects.toThrow('crash')
    expect(head()).toMatchObject({ ...before, pending: { seq: 2 } })
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered).toBeNull()
    expect(r.brokenTail).toBeNull()
    expect(r.head).toEqual(before)
    // A read leaves the intent: one outside `serial` can't tell a crash from an append in flight.
    expect(head()?.pending?.seq).toBe(2)
    const next = await appendRecord(p, dir, { run: RUN, kind: 'verify', by, body: { again: true } })
    expect(next.seq).toBe(2)
    expect(head()).toEqual({ seq: 2, sha: await sha256(await p.fs.read(join(ledgerDir(dir), '000002-verify.json'))) })
    expect((await readLedger(p, dir, RUN)).tampered).toBeNull()
  })

  test('past an intent, a record it does not name is tampered: another hash, or one past the pending one', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    await expect(appendRecord(crashing({ write: 1 }), dir, { run: RUN, kind: 'verify', by, body: {} })).rejects.toThrow('crash')
    await forge(2, 'verify', { forged: true })
    expect((await readLedger(p, dir, RUN)).tampered).toEqual({ seq: 2, reason: 'record 000002-verify.json was added after the head 1' })
    unlinkSync(join(ledgerDir(dir), '000002-verify.json'))
    await expect(appendRecord(crashing({ set: 2 }), dir, { run: RUN, kind: 'verify', by, body: {} })).rejects.toThrow('crash')
    await forge(3, 'run.end')
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered).toEqual({ seq: 3, reason: 'record 000003-run.end.json was added after the head 1' })
    expect(r.records.map(x => x.seq)).toEqual([1, 2])
  })

  test('a cut-off last file with an intent is a broken tail, as before, removed by the next append', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    await expect(appendRecord(crashing({ write: 1 }), dir, { run: RUN, kind: 'verify', by, body: {} })).rejects.toThrow('crash')
    writeFileSync(join(ledgerDir(dir), '000002-verify.json'), '{"v":1,"seq"')
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered).toBeNull()
    expect(r.brokenTail).toBe('000002-verify.json')
    expect((await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })).seq).toBe(2)
    expect(files()).toEqual(['000001-finding.json', '000002-finding.json'])
  })

  test('a head from before intents, with nothing past it, reads as before and is left as it was', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    await appendRecord(p, dir, { run: RUN, kind: 'verify', by, body: {} })
    const old = head()!
    expect(old).toEqual({ seq: 2, sha: expect.any(String) })
    const writes: unknown[] = []
    const q: Ports = { ...p, store: { ...p.store, set: async (k, v) => (writes.push(v), p.store.set(k, v)) } }
    const r = await readLedger(q, dir, RUN)
    expect(r).toEqual({ records: r.records, head: old, tampered: null, brokenTail: null })
    expect(r.records.map(x => x.kind)).toEqual(['finding', 'verify'])
    expect(writes).toEqual([])
  })

  test('with no stored head at all (a lost store), every record is adopted, as before', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    await appendRecord(p, dir, { run: RUN, kind: 'verify', by, body: {} })
    const was = head()
    p.storeMap.delete(headKey(dir))
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered).toBeNull()
    expect(r.records).toHaveLength(2)
    expect(head()).toEqual(was!)
  })

  test('reads during an append in flight, before and after its file is written, never see it as tampered', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    const during: LedgerRead[] = []
    const q: Ports = {
      ...p,
      fs: {
        ...p.fs,
        write: async (f, t) => {
          during.push(await readLedger(p, dir, RUN))
          await p.fs.write(f, t)
          during.push(await readLedger(p, dir, RUN))
        },
      },
    }
    await appendRecord(q, dir, { run: RUN, kind: 'verify', by, body: {} })
    expect(during.map(r => [r.tampered, r.records.length])).toEqual([
      [null, 1],
      [null, 2],
    ])
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered).toBeNull()
    expect(head()).toEqual(r.head!)
  })

  /** A gate: `reached` resolves when the wrapped call arrives, which then waits for `release`. */
  function gate() {
    let release!: () => void
    let arrive!: () => void
    const open = new Promise<void>(res => (release = res))
    const reached = new Promise<void>(res => (arrive = res))
    return { release, reached, pass: <T>(work: () => Promise<T>) => (arrive(), open.then(work)) }
  }

  test('a read that took the head before an append and lists its files after it starts over, and sees no tamper', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    const g = gate()
    const late: Ports = { ...p, fs: { ...p.fs, list: d => g.pass(() => p.fs.list(d)) } }
    const read = readLedger(late, dir, RUN)
    await g.reached
    await appendRecord(p, dir, { run: RUN, kind: 'verify', by, body: {} })
    g.release()
    const r = await read
    expect(r.tampered).toBeNull()
    expect(r.records.map(x => x.kind)).toEqual(['finding', 'verify'])
  })

  test('a read slower than an append never moves the head back, nor drops its intent', async () => {
    // With no stored head (a lost store), the slow read lists files 1 and 2 and waits on reading 2.
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    p.storeMap.delete(headKey(dir))
    const g = gate()
    let reads = 0
    const slow: Ports = { ...p, fs: { ...p.fs, read: f => (++reads === 2 ? g.pass(() => p.fs.read(f)) : p.fs.read(f)) } }
    const read = readLedger(slow, dir, RUN)
    await g.reached
    // Meanwhile an append adopts 1 and 2, sets its intent for 3 and stops before the file.
    await expect(appendRecord(crashing({ write: 1 }), dir, { run: RUN, kind: 'verify', by, body: {} })).rejects.toThrow('crash')
    const intent = head()!
    expect(intent).toMatchObject({ seq: 2, pending: { seq: 3 } })
    g.release()
    const r = await read
    expect(r.tampered).toBeNull()
    expect(r.head?.seq).toBe(2)
    expect(head()).toEqual(intent)
    // So the record that append was writing is still adopted when its file lands.
    expect((await appendRecord(p, dir, { run: RUN, kind: 'verify', by, body: {} })).seq).toBe(3)
    expect((await readLedger(p, dir, RUN)).tampered).toBeNull()
  })

  test('serial keeps many appends in order across intents', async () => {
    await Promise.all(Array.from({ length: 25 }, (_, n) => appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: { n } })))
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered).toBeNull()
    expect(r.records.map(x => x.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1))
    expect(head()).toEqual(r.head!)
  })
})
