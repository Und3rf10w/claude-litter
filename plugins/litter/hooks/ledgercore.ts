// The run ledger's storage: one file per record, chained by sha256, with the
// head kept in the store (plan section 9, "Ledger"). This is the only code that
// writes or walks `<runDir>/ledger/`; the record tool (ledger.ts) and every
// handler go through appendRecord and readLedger.
//
// Contract owner: phase 1a.

import type { Ports } from './ports'
import type { Author, StoredRecord } from './records/core'
import { RECORD_MAX_BYTES } from './records/core'
import { ledgerDir, ledgerFileName } from './layout'
import { remove, serial, sha256 } from './fsx'

/** `$.store` key for a run's ledger head, by its absolute runDir: the store is shared by every project. */
export const headKey = (runDir: string) => `litter.head.${runDir}`

export type Head = { seq: number; sha: string }

export type AppendInput<B> = { run: string; kind: string; by: Author; body: B }

export class RecordTooLarge extends Error {
  constructor(
    readonly bytes: number,
    readonly field: string | null,
  ) {
    super(`record is ${bytes} bytes, over the ${RECORD_MAX_BYTES}-byte limit${field ? `; the largest field is '${field}'` : ''}`)
  }
}

/** The top-level body field with the longest JSON, to name in a too-large error. */
function largestField(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null
  let best: string | null = null
  let size = -1
  for (const [k, v] of Object.entries(body)) {
    const n = JSON.stringify(v ?? null).length
    if (n > size) {
      size = n
      best = k
    }
  }
  return best
}

/** The chain is broken: the run is `ledger_tampered`, and nothing from `seq` on is acted on. */
export class LedgerTampered extends Error {
  constructor(
    readonly seq: number,
    readonly reason: string,
  ) {
    super(`ledger tampered at ${seq}: ${reason}`)
  }
}

const bytes = (text: string) => new TextEncoder().encode(text).length

/**
 * Appends one record to the run's ledger and returns it as stored. Appends to
 * one run are serialised in this module instance; the file is written before
 * the head moves, so a crash between the two leaves a valid record past the
 * head, which readLedger accepts and adopts.
 */
export function appendRecord<B>(p: Ports, runDir: string, input: AppendInput<B>): Promise<StoredRecord<B>> {
  return serial(`ledger:${runDir}`, async () => {
    const { head, tampered, brokenTail } = await readLedger(p, runDir, input.run)
    if (tampered) throw new LedgerTampered(tampered.seq, tampered.reason)
    if (brokenTail) await remove(p, `${ledgerDir(runDir)}/${brokenTail}`)
    const rec: StoredRecord<B> = {
      v: 1,
      seq: head ? head.seq + 1 : 1,
      kind: input.kind,
      run: input.run,
      at: await p.now(),
      by: input.by,
      prev: head ? head.sha : null,
      body: input.body,
    }
    const text = `${JSON.stringify(rec)}\n`
    const n = bytes(text)
    if (n > RECORD_MAX_BYTES) throw new RecordTooLarge(n, largestField(input.body))
    await p.fs.write(`${ledgerDir(runDir)}/${ledgerFileName(rec.seq, rec.kind)}`, text)
    await p.store.set(headKey(runDir), { seq: rec.seq, sha: await sha256(text) } satisfies Head)
    return rec
  })
}

export type LedgerRead = {
  records: StoredRecord[]
  /** The last good record's seq and file hash; null for an empty ledger. */
  head: Head | null
  /** Set when the chain is broken: nothing from `seq` on may be acted on. */
  tampered: null | { seq: number; reason: string }
  /** A last file that doesn't parse: never written. The next append removes it first. */
  brokenTail: string | null
}

/**
 * Reads the ledger in seq order and checks the chain back from the stored
 * head. A last file that doesn't parse (cut off by a crash mid-write) counts
 * as never written. Anything else that doesn't fit is `tampered`:
 *  - a file that doesn't parse, or whose seq/name/run don't match, before the last;
 *  - a `prev` that isn't the previous file's sha256;
 *  - a gap in seq;
 *  - fewer records than the stored head says (a record removed from the end),
 *    or a different hash at the head's seq.
 */
export async function readLedger(p: Ports, runDir: string, run: string): Promise<LedgerRead> {
  const dir = ledgerDir(runDir)
  const stored = (await p.store.get(headKey(runDir))) as Head | undefined
  const names = (await p.fs.exists(dir))
    ? (await p.fs.list(dir)).filter(e => e.kind === 'file' && /^[0-9]{6}-.+\.json$/.test(e.name)).map(e => e.name).sort()
    : []
  const records: StoredRecord[] = []
  let prevSha: string | null = null
  let tampered: LedgerRead['tampered'] = null
  let brokenTail: string | null = null
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!
    const seq = i + 1
    const text = await p.fs.read(`${dir}/${name}`)
    let rec: StoredRecord
    try {
      rec = JSON.parse(text) as StoredRecord
    } catch {
      if (i === names.length - 1 && !(stored && stored.seq >= seq)) {
        brokenTail = name
        break
      }
      tampered = { seq, reason: `record ${name} doesn't parse` }
      break
    }
    if (rec.seq !== seq || name !== ledgerFileName(rec.seq, rec.kind) || rec.run !== run) {
      tampered = { seq, reason: `record ${name} doesn't match its place in the ledger` }
      break
    }
    if (rec.prev !== prevSha) {
      tampered = { seq, reason: `record ${name} doesn't chain to the record before it` }
      break
    }
    const sha = await sha256(text)
    if (stored && stored.seq === seq && stored.sha !== sha) {
      tampered = { seq, reason: `record ${name} isn't the record the head names` }
      break
    }
    records.push(rec)
    prevSha = sha
  }
  if (!tampered && stored && records.length < stored.seq) {
    tampered = { seq: records.length + 1, reason: `the ledger ends at ${records.length}, but its head is ${stored.seq}` }
  }
  const head: Head | null = records.length > 0 && prevSha ? { seq: records.length, sha: prevSha } : null
  if (!tampered && head && (!stored || stored.seq < head.seq)) await p.store.set(headKey(runDir), head)
  return { records, head, tampered, brokenTail }
}
