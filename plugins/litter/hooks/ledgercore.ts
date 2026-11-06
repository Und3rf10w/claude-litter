// The run ledger's storage: one file per record, chained by sha256, with the
// head kept in the store (plan section 9, "Ledger"). This is the only code that
// writes or walks `<runDir>/ledger/`; the record tool (ledger.ts) and every
// handler go through appendRecord and readLedger.
//
// A ledger's head lives in one store, its owner's (Claude Code's `$.store`, or
// one Codex data folder's): only appendRecord writes it, so the store that holds a v2 head is the one
// that appends. A reader on any other store reads headless, and the places
// that act ask `owned` first.
//
// Contract owner: phase 1a.

import { HookAborted, type Ports } from './ports'
import type { Author, StoredRecord } from './records/core'
import { RECORD_MAX_BYTES } from './records/core'
import { ledgerDir, ledgerFileName } from './layout'
import { remove, serial, sha256 } from './fsx'

/** `$.store` key for a run's ledger head, by its absolute runDir: the store is shared by every project. */
export const headKey = (runDir: string) => `litter.head.${runDir}`

/**
 * The last record's seq and file hash, `v: 2` as appendRecord writes it.
 * `pending` is its intent, set before it writes a record's file: the one
 * record readLedger adopts past the head (a crash between the write and the
 * head's move). Anything else past the head was added by something other
 * than appendRecord. Before a run's first record the head is `{ v: 2, seq: 0,
 * sha: '' }` with the intent. A head without `v` is a legacy one, written
 * before heads had a version, by an append or by a read.
 */
export type Head = { v?: 2; seq: number; sha: string; pending?: { seq: number; sha: string } }

/**
 * How readLedger read a ledger against this store:
 *  - `head`: a v2 head, so nothing past it is adopted unless its intent names it;
 *  - `legacy`: an unmarked head, which catches rewrites and truncation up to its
 *    seq and adopts what's past it, until the owner's next append marks it;
 *  - `none`: no head, so every record is adopted and nothing is checked.
 */
export type Anchor = 'head' | 'legacy' | 'none'

/** Who owns a ledger, for the places that act on it: this store, another, or this store's after a loss (the host's or the user's call). */
export type Owner = 'mine' | 'other' | 'lost'

/** appendRecord on a ledger with records and no head here, which `owned` doesn't call this store's. */
export class LedgerNotOwned extends Error {
  readonly runDir: string
  readonly owner: Owner
  constructor(runDir: string, owner: Owner) {
    super(`${runDir}'s ledger has records but no head in this store, so another host or store drives it${owner === 'lost' ? ', or its store was lost' : ''}; nothing is appended here`)
    this.runDir = runDir
    this.owner = owner
  }
}

/** `adopt`: this store is the owner anyway (the host's or the user's decision), so a headless ledger takes the append and its v2 head. */
export type AppendOptions = { adopt?: boolean }

const sameHead = (a: Head | undefined, b: Head | undefined): boolean =>
  a === b ||
  (!!a && !!b && a.seq === b.seq && a.sha === b.sha && a.pending?.seq === b.pending?.seq && a.pending?.sha === b.pending?.sha)

export type AppendInput<B> = { run: string; kind: string; by: Author; body: B }

// Fields, not parameter properties: node runs this file with its types
// stripped, which can't rewrite a parameter property.
export class RecordTooLarge extends Error {
  readonly bytes: number
  readonly field: string | null
  constructor(bytes: number, field: string | null) {
    super(`record is ${bytes} bytes, over the ${RECORD_MAX_BYTES}-byte limit${field ? `; the largest field is '${field}'` : ''}`)
    this.bytes = bytes
    this.field = field
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
  readonly seq: number
  readonly reason: string
  constructor(seq: number, reason: string) {
    super(`ledger tampered at ${seq}: ${reason}`)
    this.seq = seq
    this.reason = reason
  }
}

const bytes = (text: string) => new TextEncoder().encode(text).length

/**
 * Appends one record to the run's ledger and returns it as stored. Appends to
 * one run are serialised in this module instance. The head first takes the
 * record's intent (`pending`), then the file is written, then the head moves:
 * a crash after the write leaves a record past the head that the intent
 * names, which readLedger adopts; a crash before it leaves an intent with no
 * file, which the next append replaces. Both heads are v2, so a legacy head
 * is marked by the owner's next append.
 *
 * A ledger with records and no head in this store is another store's (or
 * this one's, lost): it throws LedgerNotOwned unless `owned` says `mine` or
 * the caller passes `adopt`. With no records it creates the ledger, and this
 * store becomes its owner.
 */
export function appendRecord<B>(p: Ports, runDir: string, input: AppendInput<B>, options: AppendOptions = {}): Promise<StoredRecord<B>> {
  return serial(`ledger:${runDir}`, async () => {
    // An append is a write: its read isn't cut short by the hook's signal, and it takes a cached prefix
    // however old, so it reads only what's new (the next read that isn't an append re-checks the whole chain).
    const read = await readFor(p, runDir, input.run, true)
    const { head, tampered, brokenTail } = read
    if (tampered) throw new LedgerTampered(tampered.seq, tampered.reason)
    if (read.anchor === 'none' && read.records.length > 0 && options.adopt !== true) {
      const owner = await owned(p, runDir, read)
      if (owner !== 'mine') throw new LedgerNotOwned(runDir, owner)
    }
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
    const sha = await sha256(text)
    const pending = { seq: rec.seq, sha }
    await p.store.set(headKey(runDir), { v: 2, seq: head?.seq ?? 0, sha: head?.sha ?? '', pending } satisfies Head)
    const name = ledgerFileName(rec.seq, rec.kind)
    await p.fs.write(`${ledgerDir(runDir)}/${name}`, text)
    await p.store.set(headKey(runDir), { v: 2, seq: rec.seq, sha } satisfies Head)
    // The read above left the cache at the record before this one: this one joins it, so the next read lists it as verified.
    const kept = p.ledgerCache?.peek(runDir)
    if (kept && kept.run === input.run && kept.names.length === rec.seq - 1) {
      kept.names.push(name)
      kept.shas.push(sha)
      // A copy, as a read would parse it: the caller keeps `rec`, and may change it.
      kept.records.push(JSON.parse(text) as StoredRecord)
    }
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
  /** What this store holds for the ledger, and so how far the read was checked. */
  anchor: Anchor
}

/**
 * Whether this store owns the ledger, for a place about to act on it: `mine`
 * for one with no records and no head, which the first append makes its
 * store's; otherwise the host's answer (Ports.ledgerOwner), else `mine` for a
 * v2 head and `other` for anything less. Views read without asking.
 */
export async function owned(p: Ports, runDir: string, read: LedgerRead): Promise<Owner> {
  if (read.anchor === 'none' && read.records.length === 0) return 'mine'
  if (p.ledgerOwner) return p.ledgerOwner(runDir, read)
  return read.anchor === 'head' ? 'mine' : 'other'
}

/** Why a place that acts leaves a run alone when `owned` isn't `mine`. */
export const elsewhere = (run: string): string => `run ${run} is driven by another host or Codex home, or this store lost its head`

/**
 * Reads the ledger in seq order and checks the chain back from the stored
 * head. A last file that doesn't parse (cut off by a crash mid-write) counts
 * as never written. Anything else that doesn't fit is `tampered`:
 *  - a file that doesn't parse, or whose seq/name/run don't match, before the last;
 *  - a `prev` that isn't the previous file's sha256;
 *  - a gap in seq;
 *  - fewer records than the stored head says (a record removed from the end),
 *    or a different hash at the head's seq;
 *  - with a v2 head (`anchor: 'head'`), a record past it that its `pending`
 *    doesn't name (seq and hash): one appended by anything but appendRecord.
 *    A head without `pending` (between appends) adopts none.
 * A legacy head (`anchor: 'legacy'`) adopts every record past it, as heads
 * did before they had a version, and with no head at all (`anchor: 'none'`:
 * another store's ledger, or this store's, lost) every record is adopted and
 * nothing is checked.
 *
 * It never writes the store. `$.store` has no compare-and-set, so a read that
 * wrote the head could land after a later append's intent and drop it, and a
 * head written on a read would make this store look like the owner of a
 * ledger another store appends to. The record a pending intent names is
 * adopted, and the next append moves the head past it; an intent with no file
 * is left for the next append to replace, since a read outside `serial` may
 * be in the middle of that append.
 *
 * The head is taken before the files are listed, so an append that writes
 * its file in between leaves a record past it that it doesn't name. Such a
 * record is tampered only while the head stands where the read took it. When
 * the head has moved, the read starts over from the new one; after
 * READ_TRIES walks it ends before that record instead, as a read made a
 * moment earlier would, and the next read judges it.
 *
 * With `p.ledgerCache`, a read walks only the files past the records an
 * earlier read verified, from the last one's hash, while the listing still
 * starts with their names and the stored head still fits them; any other
 * read, and the first after `fullEveryMs`, walks the whole ledger again. So a
 * file rewritten in place is caught by that next whole walk, not at once.
 *
 * With `p.signal`, a read stops before its next file once the signal has
 * aborted (the hook's dispatch went on without it), throwing HookAborted: a
 * read that failed, never a broken ledger.
 */
export function readLedger(p: Ports, runDir: string, run: string): Promise<LedgerRead> {
  return readFor(p, runDir, run, false)
}

async function readFor(p: Ports, runDir: string, run: string, appending: boolean): Promise<LedgerRead> {
  const cache = p.ledgerCache
  let stored = (await p.store.get(headKey(runDir))) as Head | undefined
  const now = cache ? await p.now() : 0
  let from = cache?.take(runDir) ?? null
  if (from && (from.run !== run || (!appending && !(now - from.fullAt < cache!.fullEveryMs)))) from = null
  for (let tries = 1; ; tries++) {
    const walk = await walkLedger(p, runDir, run, stored, from, !appending)
    if (walk.added) {
      const now = (await p.store.get(headKey(runDir))) as Head | undefined
      if (!sameHead(now, stored)) {
        if (tries < READ_TRIES) {
          stored = now
          continue
        }
        walk.tampered = null
      }
    }
    const { records, prevSha, tampered, brokenTail } = walk
    // A long ledger walked whole, to the debug log: with a cache, its first read and one each fullEveryMs.
    if (!walk.fromCache && records.length >= WHOLE_LOG_MIN) p.log(`ledger ${runDir}: read whole, ${records.length} records${cache ? '' : ' (no cache)'}`)
    if (cache) {
      if (tampered) cache.forget(runDir)
      else cache.keep(runDir, { run, names: walk.names, shas: walk.shas, records: records.slice(), fullAt: walk.fromCache ? from!.fullAt : now })
    }
    const head: Head | null = records.length > 0 && prevSha ? { v: 2, seq: records.length, sha: prevSha } : null
    return { records, head, tampered, brokenTail, anchor: anchorOf(stored) }
  }
}

const anchorOf = (stored: Head | undefined): Anchor => (stored === undefined ? 'none' : stored.v === 2 ? 'head' : 'legacy')

/** How many times readLedger walks the files while appends keep moving the head. */
const READ_TRIES = 8

/** A whole walk of at least this many records is logged (tier 4's ui-ledger case counts them). */
const WHOLE_LOG_MIN = 500

/** A ledger's records as a read verified them, in seq order: `names[i]`, `shas[i]` and `records[i]` are seq i + 1's. */
export type VerifiedLedger = {
  run: string
  names: string[]
  shas: string[]
  records: StoredRecord[]
  /** When a read last walked this ledger from its first record (`p.now()`). */
  fullAt: number
}

/**
 * The ledgers recent reads verified (readLedger), the least recently read
 * dropped past `max`. One per module instance: the mod's hooks and timers
 * share it, and a tier-2 spec that wants it makes its own.
 */
export class LedgerReadCache {
  readonly max: number
  readonly fullEveryMs: number
  private readonly kept = new Map<string, VerifiedLedger>()
  constructor(options: { max?: number; fullEveryMs?: number } = {}) {
    this.max = options.max ?? 16
    this.fullEveryMs = options.fullEveryMs ?? 60_000
  }
  /** The entry for `runDir`, now the most recently read. */
  take(runDir: string): VerifiedLedger | null {
    const v = this.kept.get(runDir)
    if (!v) return null
    this.kept.delete(runDir)
    this.kept.set(runDir, v)
    return v
  }
  /** The entry for `runDir`, leaving the order as it is. */
  peek(runDir: string): VerifiedLedger | null {
    return this.kept.get(runDir) ?? null
  }
  keep(runDir: string, v: VerifiedLedger): void {
    this.kept.delete(runDir)
    this.kept.set(runDir, v)
    for (const k of this.kept.keys()) {
      if (this.kept.size <= this.max) break
      this.kept.delete(k)
    }
  }
  forget(runDir: string): void {
    this.kept.delete(runDir)
  }
  get size(): number {
    return this.kept.size
  }
}

/**
 * Whether the checks a walk makes against `stored` would pass over the
 * cached records too: the hash at the head's seq when the head is among them,
 * and, past a v2 head, only the one record its intent names.
 */
function prefixFits(stored: Head | undefined, v: VerifiedLedger): boolean {
  const n = v.names.length
  if (!stored) return true
  if (stored.seq >= 1 && stored.seq <= n && v.shas[stored.seq - 1] !== stored.sha) return false
  if (stored.v === 2 && n > stored.seq) return n === stored.seq + 1 && stored.pending?.seq === n && stored.pending.sha === v.shas[n - 1]
  return true
}

type Walk = Omit<LedgerRead, 'head' | 'anchor'> & {
  prevSha: string | null
  /** The walk stopped at a record past `stored` that its intent doesn't name. */
  added: boolean
  /** The verified records' file names and hashes, as VerifiedLedger keeps them. */
  names: string[]
  shas: string[]
  /** The walk started past a cached prefix. */
  fromCache: boolean
}

/** One pass over the files against `stored`, past `from`'s records when they're still the listing's first. */
async function walkLedger(p: Ports, runDir: string, run: string, stored: Head | undefined, from: VerifiedLedger | null, abortable: boolean): Promise<Walk> {
  const dir = ledgerDir(runDir)
  const names = (await p.fs.exists(dir))
    ? (await p.fs.list(dir)).filter(e => e.kind === 'file' && /^[0-9]{6}-.+\.json$/.test(e.name)).map(e => e.name).sort()
    : []
  const records: StoredRecord[] = []
  const shas: string[] = []
  let prevSha: string | null = null
  let tampered: LedgerRead['tampered'] = null
  let brokenTail: string | null = null
  let added = false
  let start = 0
  if (from && from.names.length <= names.length && prefixFits(stored, from) && from.names.every((n, i) => names[i] === n)) {
    start = from.names.length
    records.push(...from.records)
    shas.push(...from.shas)
    prevSha = from.shas[start - 1] ?? null
  }
  for (let i = start; i < names.length; i++) {
    const name = names[i]!
    const seq = i + 1
    if (abortable && p.signal?.aborted) throw new HookAborted(`reading ${dir}`)
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
    if (stored?.v === 2 && seq > stored.seq && !(seq === stored.seq + 1 && stored.pending?.seq === seq && stored.pending.sha === sha)) {
      tampered = { seq, reason: `record ${name} was added after the head ${stored.seq}` }
      added = true
      break
    }
    records.push(rec)
    shas.push(sha)
    prevSha = sha
  }
  if (!tampered && stored && records.length < stored.seq) {
    tampered = { seq: records.length + 1, reason: `the ledger ends at ${records.length}, but its head is ${stored.seq}` }
  }
  return { records, prevSha, tampered, brokenTail, added, names: names.slice(0, records.length), shas, fromCache: start > 0 }
}
