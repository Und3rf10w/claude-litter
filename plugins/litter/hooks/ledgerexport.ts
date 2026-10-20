// The ledger's export (plan section 9, "The export is partitioned and
// optional"): every record of a run, one JSON line each in seq order, in
// parts `ledger-export/0001.jsonl`, `0002.jsonl`, … of at most 1 MiB, the
// verify log's scheme. A record is bounded at 1 MiB, so one always fits a
// part of its own. It's for people and for the wiki's fallback when a run has
// no summary.md: nothing in the mod reads it back.
//
// run.end schedules it after summary.md and never waits for it, so neither
// its size nor its failure changes the run's status or holds the lock.

import type { Ports } from './ports'
import type { StoredRecord } from './records/core'
import { atomicWrite } from './fsx'
import { ledgerExportPart } from './layout'
import { readLedger } from './ledgercore'

/** A part ends before it would pass this many UTF-8 bytes; a record alone may reach it. */
export const EXPORT_PART_MAX_BYTES = 1024 * 1024

const utf8 = (text: string): number => new TextEncoder().encode(text).length

/** The records as export parts: one line per record, a new part before one would pass the cap. */
export function exportParts(records: readonly StoredRecord[], max = EXPORT_PART_MAX_BYTES): string[] {
  const parts: string[] = []
  let cur = ''
  let bytes = 0
  for (const r of records) {
    const line = `${JSON.stringify(r)}\n`
    const n = utf8(line)
    if (bytes > 0 && bytes + n > max) {
      parts.push(cur)
      cur = ''
      bytes = 0
    }
    cur += line
    bytes += n
  }
  if (bytes > 0) parts.push(cur)
  return parts
}

/**
 * Writes the run's export from its ledger as read: the good records before a
 * break, if the chain is broken. The ledger only grows and parts fill in
 * order, so a later export (a repair generation's end) rewrites the last
 * part and adds new ones; a part whose text is unchanged isn't written again.
 * Answers how many parts it holds.
 */
export async function exportLedger(p: Ports, runDir: string, run: string): Promise<number> {
  const read = await readLedger(p, runDir, run)
  if (read.tampered) p.log(`ledger export for ${run}: its chain breaks at record ${read.tampered.seq} (${read.tampered.reason}); only the records before it are exported`)
  const parts = exportParts(read.records)
  for (const [i, text] of parts.entries()) {
    const path = ledgerExportPart(runDir, i + 1)
    if ((await p.fs.exists(path)) && (await p.fs.read(path)) === text) continue
    await atomicWrite(p, path, text)
  }
  return parts.length
}

/**
 * run.end's step: the export from a timer, outside the hook, never awaited; a
 * failure is logged. The engine doesn't await a timer's callback; the promise
 * is handed back for a test's runAfters.
 */
export function scheduleExport(p: Ports, runDir: string, run: string): void {
  p.after(0, () =>
    exportLedger(p, runDir, run).then(
      () => undefined,
      err => p.log(`ledger export for ${run} failed: ${err instanceof Error ? err.message : String(err)}`),
    ),
  )
}
