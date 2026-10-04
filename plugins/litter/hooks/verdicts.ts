// An execute verdict's file, `verdicts/<gate>-<attempt>.md` (plan section
// 10, "On disk"), rendered from its ledger record. Owner: phase 3, package AB.
//
// The ledger is the record of truth; the file is for you and the next skill
// to read (the execute skill quotes the critic's evidence from it). It's
// rewritten whole from the record, so a crash between the record and the file
// leaves a file that's missing or old, never half of one.

import type { Ports } from './ports'
import type { StoredRecord } from './records/core'
import type { VerifyBody } from './records/execute'
import { VERDICT_DIMENSIONS } from './records/execute'
import { readLedger } from './ledgercore'
import { verdictFile } from './layout'
import { atomicWrite, serial } from './fsx'
import { howEnded } from './verify'

/** A gate a verdict file can be named for: a plan gate's id, or the goal check's. */
const FILE_GATE = /^(G[0-9]{1,4}|goal)$/

type Dim = { pass?: unknown; evidence?: unknown; gaps?: unknown }

const text = (v: unknown): string => (typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v))
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(text).filter(x => x !== '') : [])

/** The verify a verdict body cites, in the run's ledger, or null. */
function citedVerify(records: readonly StoredRecord[], verifyId: string): VerifyBody | null {
  const r = records.find(x => x.kind === 'verify' && x.body.verify_id === verifyId)
  return r ? (r.body as unknown as VerifyBody) : null
}

/** The gate and attempt a verdict judges: the verify it cites, as that verify was recorded. */
export function verdictTarget(records: readonly StoredRecord[], rec: StoredRecord): { gate: string; attempt: number; verify: VerifyBody } | null {
  const id = rec.body.verify_id
  if (typeof id !== 'string' || id === '') return null
  const v = citedVerify(records, id)
  if (!v || typeof v.gate !== 'string' || !FILE_GATE.test(v.gate) || !Number.isInteger(v.attempt) || v.attempt < 1) return null
  return { gate: v.gate, attempt: v.attempt, verify: v }
}

/** Who recorded it, for the file. */
function agentLine(rec: StoredRecord): string {
  if (rec.by.source === 'agent') return `${rec.by.agentId}${rec.by.agentType ? ` (${rec.by.agentType})` : ''}`
  return rec.by.source
}

/** The verdict file's text: what the critic found, dimension by dimension, as the record holds it. */
export function renderVerdict(run: string, rec: StoredRecord, t: { gate: string; attempt: number; verify: VerifyBody }): string {
  const b = rec.body
  const dims = VERDICT_DIMENSIONS.map(name => ({ name, d: (b[name] ?? null) as Dim | null }))
  const gap = text(b.plan_gap).trim()
  const approved = dims.every(x => x.d?.pass === true) && gap === ''
  const failing = dims.filter(x => x.d?.pass !== true).map(x => x.name)
  const lines = [
    `# Verdict on ${t.gate}, attempt ${t.attempt}`,
    '',
    `- Run: ${run}`,
    `- Verify: ${t.verify.verify_id}, ${howEnded(t.verify)}${t.verify.green ? ', green' : ', not green'}`,
    `- Verdict: ${approved ? 'approved' : `rejected${failing.length > 0 ? `, failing ${failing.join(', ')}` : ''}${gap ? ', with a plan gap' : ''}`}`,
    `- Agent: ${agentLine(rec)}`,
    `- Ledger seq: ${rec.seq}`,
  ]
  for (const { name, d } of dims) {
    lines.push('', `## ${name}: ${d === null ? 'missing' : d.pass === true ? 'pass' : 'fail'}`, '')
    if (d === null) {
      lines.push('The verdict has no such dimension.')
      continue
    }
    lines.push(`Evidence: ${text(d.evidence) || 'none given'}`)
    const gaps = strings(d.gaps)
    if (gaps.length > 0) lines.push('', 'Gaps:', ...gaps.map(g => `- ${g}`))
  }
  lines.push('', '## Plan gap', '', gap || 'none')
  const proposed = strings(b.proposed_rules)
  lines.push('', '## Rules the critic proposed', '')
  if (proposed.length === 0) lines.push('none')
  else lines.push(...proposed.map(r => `- proposed, not accepted: ${r}`))
  lines.push('')
  return lines.join('\n')
}

/**
 * Writes layout.ts's `verdictFile(runDir, gate, attempt)` from a `verdict`
 * record (a GateVerdictBody, or a SwarmGateVerdictBody from AC), taking the
 * gate and attempt from the verify it cites: the verify id and how it ended,
 * each dimension's pass, evidence and gaps, `plan_gap`, the proposals marked
 * "proposed, not accepted", the agent and the ledger seq. The latest verdict
 * for a gate and attempt wins; one whose verify can't be found is logged and
 * skipped. Called by output.ts after a gate-critic's verdict is recorded; a
 * throw is logged there.
 */
export async function writeVerdictFile(p: Ports, runDir: string, rec: StoredRecord): Promise<void> {
  if (rec.kind !== 'verdict') return
  // One file per gate and attempt: the check for a later verdict and the write don't interleave with another's.
  await serial(`verdicts:${runDir}`, async () => {
    const { records, tampered } = await readLedger(p, runDir, rec.run)
    if (tampered) {
      p.log(`verdict ${rec.run} seq ${rec.seq}: the run's ledger is tampered at ${tampered.seq}; no verdict file`)
      return
    }
    const t = verdictTarget(records, rec)
    if (!t) {
      p.log(`verdict ${rec.run} seq ${rec.seq}: the verify it cites (${text(rec.body.verify_id) || 'none'}) isn't a plan gate's verify in the run's ledger; no verdict file`)
      return
    }
    const later = records.some(r => {
      if (r.kind !== 'verdict' || r.seq <= rec.seq) return false
      const o = verdictTarget(records, r)
      return o !== null && o.gate === t.gate && o.attempt === t.attempt
    })
    if (later) return
    await atomicWrite(p, verdictFile(runDir, t.gate, t.attempt), renderVerdict(rec.run, rec, t))
  })
}
