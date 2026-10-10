// Tier 2: the ledger's chain against real files. A sample of the pattern each
// package follows: node ports, a scratch folder, real reads and writes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  appendRecord,
  type Head,
  headKey,
  LedgerNotOwned,
  type LedgerRead,
  LedgerTampered,
  type Owner,
  owned,
  readLedger,
  RecordTooLarge,
} from '../../hooks/ledgercore'
import { sha256 } from '../../hooks/fsx'
import { claudeLedgerOwner } from '../../hooks/ledgerowner'
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

  test('a valid record past a v2 head with no intent is tampered, not adopted', async () => {
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
    expect(seen).toEqual([{ ...first, pending: { seq: 2, sha } }, { v: 2, seq: 2, sha }])
    expect(second).toMatchObject({ seq: 2, prev: first.sha })
    expect(head()).toEqual({ v: 2, seq: 2, sha })
  })

  test("a run's first record has an intent too, over seq 0", async () => {
    const seen: unknown[] = []
    const q: Ports = { ...p, store: { ...p.store, set: async (k, v) => (seen.push(v), p.store.set(k, v)) } }
    await appendRecord(q, dir, { run: RUN, kind: 'run.start', by, body: {} })
    const sha = await sha256(await p.fs.read(join(ledgerDir(dir), '000001-run.start.json')))
    expect(seen).toEqual([{ v: 2, seq: 0, sha: '', pending: { seq: 1, sha } }, { v: 2, seq: 1, sha }])
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
    expect(head()).toEqual({ v: 2, seq: 3, sha: expect.any(String) })
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
    expect(head()).toEqual({ v: 2, seq: 2, sha: await sha256(await p.fs.read(join(ledgerDir(dir), '000002-verify.json'))) })
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

  test('a v2 head with nothing past it reads whole, anchor head, and the read writes nothing', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    await appendRecord(p, dir, { run: RUN, kind: 'verify', by, body: {} })
    const at = head()!
    expect(at).toEqual({ v: 2, seq: 2, sha: expect.any(String) })
    const writes: unknown[] = []
    const q: Ports = { ...p, store: { ...p.store, set: async (k, v) => (writes.push(v), p.store.set(k, v)) } }
    const r = await readLedger(q, dir, RUN)
    expect(r).toEqual({ records: r.records, head: at, tampered: null, brokenTail: null, anchor: 'head' })
    expect(r.records.map(x => x.kind)).toEqual(['finding', 'verify'])
    expect(writes).toEqual([])
  })

  test('with no stored head (another store, or a lost one), every record is adopted, anchor none, and nothing is written', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    await appendRecord(p, dir, { run: RUN, kind: 'verify', by, body: {} })
    p.storeMap.delete(headKey(dir))
    const writes: unknown[] = []
    const q: Ports = { ...p, store: { ...p.store, set: async (k, v) => (writes.push(v), p.store.set(k, v)) } }
    const r = await readLedger(q, dir, RUN)
    expect(r.tampered).toBeNull()
    expect(r.anchor).toBe('none')
    expect(r.records).toHaveLength(2)
    expect(writes).toEqual([])
    expect(head()).toBeUndefined()
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
    // Meanwhile an append adopts 1 and 2 (the store was lost, and you said so), sets its intent for 3 and stops before the file.
    await expect(appendRecord(crashing({ write: 1 }), dir, { run: RUN, kind: 'verify', by, body: {} }, { adopt: true })).rejects.toThrow('crash')
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

// A ledger's head lives in one store, its owner's: only appendRecord writes it, and a ledger with records and no head here is
// appended to only when the host says this store owns it, or the caller adopts it.
describe('ledgercore: one store owns a ledger', () => {
  const head = () => p.storeMap.get(headKey(dir)) as Head | undefined
  const append = (q: Ports, kind = 'finding', options?: { adopt?: boolean }) => appendRecord(q, dir, { run: RUN, kind, by, body: {} }, options)

  /** Another store over the same files, with no host answer: `owned` is `mine` for a v2 head only. */
  function otherStore(): TestPorts {
    const q = nodePorts()
    delete q.ledgerOwner
    return q
  }

  test("two stores, one ledger: B reads A's appends headless and untampered, refuses to append, and with adopt races A", async () => {
    for (let i = 0; i < 3; i++) await append(p)
    const b = otherStore()
    let r = await readLedger(b, dir, RUN)
    expect([r.anchor, r.tampered, r.records.length]).toEqual(['none', null, 3])
    await append(p)
    r = await readLedger(b, dir, RUN)
    expect([r.anchor, r.tampered, r.records.length]).toEqual(['none', null, 4])
    expect(b.storeMap.size).toBe(0)
    const err = await append(b).catch(e => e)
    expect(err).toBeInstanceOf(LedgerNotOwned)
    expect((err as LedgerNotOwned).owner).toBe('other')
    expect(files()).toHaveLength(4)
    // With adopt, B appends and holds a v2 head of its own; to A that record was added past its head.
    expect((await append(b, 'run.end', { adopt: true })).seq).toBe(5)
    expect(b.storeMap.get(headKey(dir))).toMatchObject({ v: 2, seq: 5 })
    expect((await readLedger(p, dir, RUN)).tampered).toEqual({ seq: 5, reason: 'record 000005-run.end.json was added after the head 4' })
  })

  test("the host's answer decides a headless ledger with records: mine appends, other and lost refuse, and adopt overrides", async () => {
    await append(p)
    p.storeMap.delete(headKey(dir))
    const asked: unknown[] = []
    const as = (owner: Owner): Ports => ({ ...p, ledgerOwner: async (runDir, read) => (asked.push([runDir, read.anchor, read.records.length]), owner) })
    for (const owner of ['other', 'lost'] as const) {
      const err = await append(as(owner)).catch(e => e)
      expect(err).toBeInstanceOf(LedgerNotOwned)
      expect((err as LedgerNotOwned).owner).toBe(owner)
    }
    expect(asked).toEqual([
      [dir, 'none', 1],
      [dir, 'none', 1],
    ])
    expect(head()).toBeUndefined()
    expect((await append(as('lost'), 'finding', { adopt: true })).seq).toBe(2)
    expect(head()).toMatchObject({ v: 2, seq: 2 })
    // With a v2 head here, the host isn't asked.
    expect((await append(as('other'))).seq).toBe(3)
    expect(asked).toHaveLength(2)
  })

  test('with no records, an append creates the ledger and this store becomes its owner, whatever the host would say', async () => {
    const b = otherStore()
    expect((await append(b, 'run.start')).seq).toBe(1)
    expect(b.storeMap.get(headKey(dir))).toMatchObject({ v: 2, seq: 1 })
    expect(await owned(b, dir, await readLedger(b, dir, RUN))).toBe('mine')
    expect(await owned(b, dir, await readLedger(otherStore(), dir, RUN))).toBe('other')
  })

  test("a legacy head adopts what's past it, catches a rewrite below it, and the owner's next append marks it v2", async () => {
    for (let i = 0; i < 2; i++) await append(p)
    const { sha } = head()!
    // A head from before versions, at record 1: what an old append or read left.
    p.storeMap.set(headKey(dir), { seq: 1, sha: await sha256(await p.fs.read(join(ledgerDir(dir), '000001-finding.json'))) })
    const writes: unknown[] = []
    const q: Ports = { ...p, store: { ...p.store, set: async (k, v) => (writes.push(v), p.store.set(k, v)) } }
    let r = await readLedger(q, dir, RUN)
    expect([r.anchor, r.tampered, r.records.length, r.head?.sha]).toEqual(['legacy', null, 2, sha])
    expect(writes).toEqual([])
    // A rewrite at or below the legacy head is still caught.
    const first = join(ledgerDir(dir), '000001-finding.json')
    const good = await p.fs.read(first)
    writeFileSync(first, good.replace('"body":{}', '"body":{"n":9}'))
    expect((await readLedger(p, dir, RUN)).tampered?.seq).toBe(1)
    writeFileSync(first, good)
    // The owner's append writes a v2 head; from then on an extra record is tampered.
    expect((await append(p)).seq).toBe(3)
    expect(head()).toMatchObject({ v: 2, seq: 3 })
    r = await readLedger(p, dir, RUN)
    expect([r.anchor, r.tampered]).toEqual(['head', null])
    const extra = { v: 1, seq: 4, kind: 'run.end', run: RUN, at: 1, by, prev: r.head!.sha, body: {} }
    writeFileSync(join(ledgerDir(dir), ledgerFileName(4, 'run.end')), `${JSON.stringify(extra)}\n`)
    expect((await readLedger(p, dir, RUN)).tampered).toEqual({ seq: 4, reason: 'record 000004-run.end.json was added after the head 3' })
  })

  test("owned without a host answer: mine for a v2 head, other for a legacy head or none; a ledger with no records is anyone's", async () => {
    const bare = otherStore()
    expect(await owned(bare, dir, await readLedger(bare, dir, RUN))).toBe('mine')
    await append(p)
    bare.storeMap.set(headKey(dir), p.storeMap.get(headKey(dir)))
    expect(await owned(bare, dir, await readLedger(bare, dir, RUN))).toBe('mine')
    bare.storeMap.set(headKey(dir), { seq: 1, sha: head()!.sha })
    expect(await owned(bare, dir, await readLedger(bare, dir, RUN))).toBe('other')
    bare.storeMap.delete(headKey(dir))
    expect(await owned(bare, dir, await readLedger(bare, dir, RUN))).toBe('other')
  })

  test("Claude Code's answer: mine for a v2 head, and for a legacy head unless a launch shows litterd driving the run; other with no head", async () => {
    const launch = (body: Record<string, unknown>) => appendRecord(p, dir, { run: RUN, kind: 'run.launch', by, body })
    const asLegacy = () => p.storeMap.set(headKey(dir), { seq: head()!.seq, sha: head()!.sha })
    const answer = async () => owned(p, dir, await readLedger(p, dir, RUN))
    await launch({ taskId: 'wf-task' })
    expect(await answer()).toBe('mine')
    asLegacy()
    expect(await answer()).toBe('mine')
    await launch({ taskId: 'codex-7' })
    asLegacy()
    expect(await answer()).toBe('other')
    p.storeMap.delete(headKey(dir))
    expect(await answer()).toBe('other')
    // A driver says litterd, whatever the task id.
    const read = await readLedger(p, dir, RUN)
    const driven = { ...read.records[0]!, body: { taskId: 'wf-task', driver: { pid: 1, socket: '/s', startedAt: 0, procStart: null } } }
    expect(await claudeLedgerOwner(dir, { ...read, anchor: 'legacy', records: [driven] })).toBe('other')
    expect(await claudeLedgerOwner(dir, { ...read, anchor: 'legacy', records: [read.records[0]!] })).toBe('mine')
  })
})
