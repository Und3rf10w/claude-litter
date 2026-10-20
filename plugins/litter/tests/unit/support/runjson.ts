// run.json as run.start leaves it, for specs that write a run by hand: the
// mod acts only on a run.json whose sha256 its run.start record carries
// (hooks/runjson.ts).

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Ports } from '../../../hooks/ports'
import type { StoredRecord } from '../../../hooks/records/core'
import type { RunJson, RunStartBody } from '../../../hooks/records/run'
import { appendRecord, headKey, readLedger } from '../../../hooks/ledgercore'
import { ledgerDir } from '../../../hooks/layout'
import { sha256 } from '../../../hooks/fsx'

/**
 * Writes `<runDir>/run.json` (`text`, else `json` as JSON) and, unless the
 * ledger has one, a run.start by the launcher with its facts and its
 * sha256. With a run.start already there the file is written as given: a
 * different one is then a run.json changed outside litter, as in a real run.
 * Two ways to give a run another run.json instead: `fresh` starts the run
 * anew, the ledger and its head gone first; `rechain` keeps the ledger's
 * other records, in order, re-chained after a run.start that names the new
 * one, as if the run had started with it (not for a tampered ledger, which
 * is left as it is). Answers the text written.
 */
export async function startedRunJson(
  p: Ports,
  runDir: string,
  json: Partial<RunJson>,
  text = JSON.stringify(json),
  opts: { fresh?: boolean; rechain?: boolean } = {},
): Promise<string> {
  const run = json.run
  if (typeof run !== 'string') throw new Error("startedRunJson: the run.json has no 'run'")
  const read = await readLedger(p, runDir, run)
  const start = read.records.find(r => r.kind === 'run.start')
  const other = start !== undefined && start.body.runJsonSha256 !== (await sha256(text))
  const anew = opts.fresh === true || (opts.rechain === true && other && !read.tampered)
  const kept: StoredRecord[] = anew && opts.rechain ? read.records.filter(r => r.kind !== 'run.start') : []
  if (anew) {
    rmSync(ledgerDir(runDir), { recursive: true, force: true })
    await p.store.delete(headKey(runDir))
  }
  await p.fs.write(join(runDir, 'run.json'), text)
  if (!anew && (start || read.tampered)) return text
  await appendRecord<RunStartBody>(p, runDir, { run, kind: 'run.start', by: { source: 'launcher' }, body: await startOf(json, text) })
  for (const r of kept) await appendRecord(p, runDir, { run, kind: r.kind, by: r.by, body: r.body })
  return text
}

/** The run.start body run.start would record for this run.json. */
async function startOf(json: Partial<RunJson>, text: string): Promise<RunStartBody> {
  return {
    workflow: json.workflow ?? 'execute',
    base: json.base ?? '',
    ref: json.ref ?? '',
    checkout: json.checkout ?? '',
    isolate: json.isolate ?? false,
    previousBranch: json.previousBranch ?? null,
    verify: json.verify ?? null,
    goalCheck: json.goalCheck ?? null,
    setup: json.setup ?? null,
    authorized: json.authorized ?? [],
    mode: json.mode ?? 'default',
    continueOf: json.continueOf ?? null,
    amendOf: json.amendOf ?? null,
    planSha256: json.planSha256 ?? null,
    argsSha256: await sha256(JSON.stringify(json.args ?? {})),
    runJsonSha256: await sha256(text),
    oid: '',
    session: json.session ?? 'test-session',
    ...(json.repair ? { repair: json.repair } : {}),
  }
}
