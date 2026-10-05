// A design run's verdict and probe files, each rendered from its ledger
// record (plan section 10, "On disk"; COMMON decisions 17 and 18). Owner:
// phase 4, WP-BC.
//
// The ledger is the record of truth; the files are for you and the skill to
// read. Each is rewritten whole from its record, so a crash between the
// record and the file leaves a file that's missing or old, never half of one
// (as execute's verdict files, verdicts.ts).

import type { Ports } from '../ports'
import type { StoredRecord } from '../records/core'
import { readLedger } from '../ledgercore'
import { designVerdictPath, probePath, PROPOSAL_VERSION, UNKNOWN_ID } from '../layout'
import { atomicWrite, serial } from '../fsx'

const text = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v))
/** Text from a record in a table cell: `|` escaped and line breaks as <br>, so no record text can end the cell or the row. */
const cell = (v: unknown): string => text(v).trim().replace(/\|/g, '\\|').replace(/\r\n|\r|\n/g, '<br>')

/** Who recorded it, for the file. */
function agentLine(rec: StoredRecord): string {
  if (rec.by.source === 'agent') return `${rec.by.agentId}${rec.by.agentType ? ` (${rec.by.agentType})` : ''}`
  return rec.by.source
}

/**
 * Writes `path` from `rec` unless the ledger holds a later record of the same
 * kind and `key`, under one lock per run folder and kind, so the latest
 * record wins whatever order two writes finish in.
 */
async function writeLatest(p: Ports, runDir: string, rec: StoredRecord, keyOf: (r: StoredRecord) => unknown, path: string, body: string): Promise<void> {
  await serial(`${rec.kind}-files:${runDir}`, async () => {
    const { records, tampered } = await readLedger(p, runDir, rec.run)
    if (tampered) {
      p.log(`${rec.kind} ${rec.run} seq ${rec.seq}: the run's ledger is tampered at ${tampered.seq}; no ${rec.kind} file`)
      return
    }
    const key = keyOf(rec)
    if (records.some(r => r.kind === rec.kind && r.seq > rec.seq && keyOf(r) === key)) return
    await atomicWrite(p, path, body)
  })
}

/** A design verdict's file: the version and its sha256, source_changed, the overall result and the criteria table. */
export function renderDesignVerdict(rec: StoredRecord): string {
  const b = rec.body
  const version = text(b.version)
  const criteria = (Array.isArray(b.criteria) ? b.criteria : []).map(c => (c && typeof c === 'object' ? (c as Record<string, unknown>) : {}))
  const open = criteria.filter(c => c.verdict !== 'PASS').map(c => text(c.id))
  // A verdict recorded before phase 4 (WP-BC) has no snapshot.
  const changed =
    b.source_changed === true
      ? `yes: the checkout's tree (${text(b.tree)}) isn't base's`
      : b.source_changed === false
        ? `no: the checkout's tree (${text(b.tree)}) is base's`
        : 'not recorded'
  const overall = text(b.overall) || 'not recorded'
  const lines = [
    `# Verdict on ${version}`,
    '',
    `- Run: ${rec.run}`,
    `- Version: ${version}, sha256 ${text(b.sha256) || 'not recorded'}`,
    `- Source changed: ${changed}`,
    `- Overall: ${overall}${overall !== 'APPROVED' && open.length > 0 ? ` on ${open.join(', ')}` : ''}`,
    `- Agent: ${agentLine(rec)}`,
    `- Ledger seq: ${rec.seq}`,
    '',
    '## Criteria',
    '',
    '| Criterion | Verdict | Gap or reason | Evidence | Gap kind | Kept from |',
    '|---|---|---|---|---|---|',
    ...criteria.map(c => `| ${[c.id, c.verdict, c.gap_or_reason, c.evidence, c.gap_kind, c.kept_from].map(cell).join(' | ')} |`),
    '',
  ]
  return lines.join('\n')
}

/** A probe's file: the unknown's id and question, the verdict, and the report as recorded. */
export function renderProbe(rec: StoredRecord): string {
  const b = rec.body
  const report = text(b.report)
  const question = typeof b.question === 'string' ? b.question.replace(/\s+/g, ' ').trim() : ''
  const lines = [
    `# Probe of ${text(b.unknown_id)}`,
    '',
    `- Run: ${rec.run}`,
    `- Unknown: ${text(b.unknown_id)}`,
    ...(question ? [`- Question: ${question}`] : []),
    `- Verdict: ${text(b.verdict) || 'not recorded'}`,
    `- Agent: ${agentLine(rec)}`,
    `- Ledger seq: ${rec.seq}`,
    '',
    '## Report',
    '',
    report.endsWith('\n') ? report : `${report}\n`,
  ]
  return lines.join('\n')
}

/**
 * `verdicts/<version>.md` (layout.ts, designVerdictPath) from a stored
 * `verdict` record (DesignVerdictBody): the version, its sha256,
 * `source_changed`, the criteria as a table and the overall result. The
 * latest record for a version wins. A version that isn't PROPOSAL_VERSION
 * writes nothing and is logged, since it names the file. Throws when the
 * write fails; recordVerdict logs it.
 */
export async function writeDesignVerdictFile(p: Ports, runDir: string, rec: StoredRecord): Promise<void> {
  if (rec.kind !== 'verdict') return
  const version = rec.body.version
  if (typeof version !== 'string' || !PROPOSAL_VERSION.test(version)) {
    p.log(`verdict ${rec.run} seq ${rec.seq}: version ${JSON.stringify(version ?? null)} isn't v<n>; no verdict file`)
    return
  }
  await writeLatest(p, runDir, rec, r => r.body.version, designVerdictPath(runDir, version), renderDesignVerdict(rec))
}

/**
 * `probes/<unknown_id>.md` (layout.ts, probePath) from a stored `probe`
 * record (ProbeBody): the unknown's id, the verdict and the report. The
 * latest record for an id wins. An id that isn't UNKNOWN_ID writes nothing
 * and is logged, since it names the file. Throws when the write fails;
 * recordProbe logs it.
 */
export async function writeProbeFile(p: Ports, runDir: string, rec: StoredRecord): Promise<void> {
  if (rec.kind !== 'probe') return
  const id = rec.body.unknown_id
  if (typeof id !== 'string' || !UNKNOWN_ID.test(id)) {
    p.log(`probe ${rec.run} seq ${rec.seq}: unknown_id ${JSON.stringify(id ?? null)} isn't U<n>; no probe file`)
    return
  }
  await writeLatest(p, runDir, rec, r => r.body.unknown_id, probePath(runDir, id), renderProbe(rec))
}
