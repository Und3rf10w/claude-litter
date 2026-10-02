// Tier 2: the ledger's chain against real files. A sample of the pattern each
// package follows: node ports, a scratch folder, real reads and writes.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { appendRecord, headKey, LedgerTampered, readLedger, RecordTooLarge } from '../../hooks/ledgercore'
import { ledgerDir } from '../../hooks/layout'
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
    expect(p.storeMap.get(headKey(RUN))).toEqual(r.head)
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

  test('a valid record past the head (crash before the head moved) is adopted', async () => {
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    const head = p.storeMap.get(headKey(RUN))
    await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: {} })
    p.storeMap.set(headKey(RUN), head)
    const r = await readLedger(p, dir, RUN)
    expect(r.tampered).toBeNull()
    expect(r.head?.seq).toBe(2)
    expect((p.storeMap.get(headKey(RUN)) as { seq: number }).seq).toBe(2)
  })

  test('a record over the limit is refused, naming its largest field', async () => {
    const big = 'x'.repeat(RECORD_MAX_BYTES)
    const err = await appendRecord(p, dir, { run: RUN, kind: 'finding', by, body: { small: 1, big } }).catch(e => e)
    expect(err).toBeInstanceOf(RecordTooLarge)
    expect((err as RecordTooLarge).field).toBe('big')
  })
})
