// run.json as run.start wrote it (plan section 9, "Mod safety"). The
// run.start record carries run.json's sha256, and nothing rewrites run.json
// after it, so a run.json whose sha256 differs was changed outside litter:
// by hand, or by an agent that got past the guard. A reader that acts on it
// (a git call, a command it runs, an append, a spawn's prompt, a question
// you answer) reads it here; a view reads it raw.

import type { Ports } from './ports'
import type { RunJson, RunStartBody } from './records/run'
import type { LedgerRead } from './ledgercore'
import { elsewhere, owned, readLedger } from './ledgercore'
import { runJsonPath } from './layout'
import { sha256 } from './fsx'

/** Why litter won't act on a run whose run.json isn't run.start's. Unprefixed: a log line, a reply and a refusal all use it. */
export const runJsonChanged = (run: string): string =>
  `run.json for run ${run} changed outside litter after the run started, so litter won't act on it. Stop the run, and start a new one`

/** What kept a run.json from being read: the ledger, its owner, its run.start, the file, or the file's sha256. */
export type RunJsonRefusal = 'tampered' | 'elsewhere' | 'unstarted' | 'missing' | 'changed'

export type CheckedRunJson =
  | { ok: true; json: RunJson; start: RunStartBody; ledger: LedgerRead }
  | { ok: false; why: RunJsonRefusal; reason: string; ledger: LedgerRead }

/**
 * The run's run.json, when its ledger is untampered and this store's, and
 * the file is the one whose sha256 run.start recorded; else why not, in
 * words a refusal can carry after `litter: `. `ledger` is the caller's read
 * of the run's ledger, when it has one.
 */
export async function checkedRunJson(p: Ports, ref: { run: string; runDir: string }, ledger?: LedgerRead): Promise<CheckedRunJson> {
  const read = ledger ?? (await readLedger(p, ref.runDir, ref.run))
  const no = (why: RunJsonRefusal, reason: string): CheckedRunJson => ({ ok: false, why, reason, ledger: read })
  if (read.tampered) return no('tampered', `run ${ref.run}'s ledger is tampered at ${read.tampered.seq}`)
  if ((await owned(p, ref.runDir, read)) !== 'mine') return no('elsewhere', `${elsewhere(ref.run)}; litter won't act on it here`)
  const start = read.records.find(r => r.kind === 'run.start')?.body as RunStartBody | undefined
  if (!start) return no('unstarted', `run ${ref.run} has no run.start record`)
  let text: string
  try {
    text = await p.fs.read(runJsonPath(ref.runDir))
  } catch {
    return no('missing', `run ${ref.run} has no run.json`)
  }
  if ((await sha256(text)) !== start.runJsonSha256) return no('changed', runJsonChanged(ref.run))
  return { ok: true, json: JSON.parse(text) as RunJson, start, ledger: read }
}

/**
 * For a record handler that acts on run.json: the checked one; undefined
 * when the run has none yet (no run.start, or run.json not written), for the
 * handler's own "no such run" answer; else the refusal, `litter: ` first.
 */
export async function runJsonForRecord(p: Ports, ref: { run: string; runDir: string }): Promise<RunJson | undefined | string> {
  const c = await checkedRunJson(p, ref)
  if (c.ok) return c.json
  return c.why === 'unstarted' || c.why === 'missing' ? undefined : `litter: ${c.reason}`
}
