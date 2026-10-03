// summary.md's execute part (COMMON step 1): attempts per gate, the last
// verdict's failing dimensions, the halt and its evidence, the rules used and
// the proposals made. Owner: phase 3, package AB.
//
// AA's stub: today's Gates table, so an execute run's summary doesn't change
// until AB builds it.

import type { Ports } from './ports'
import type { RunRef } from './lifecycle'
import type { RunJson } from './records/run'
import type { StoredRecord } from './records/core'

/**
 * The lines lifecycle.ts's writeSummary puts in an execute run's summary.md
 * after its header, each section starting with a blank line. A throw is
 * logged there, and the rest of the summary stands.
 */
export async function executeSummary(p: Ports, ref: RunRef, json: RunJson | null, records: readonly StoredRecord[]): Promise<string[]> {
  const lines: string[] = []
  const lands = records.filter(r => r.kind === 'land' && typeof r.body.gate === 'string')
  const planned = Array.isArray(json?.args.gates) ? (json!.args.gates as { id?: unknown }[]).map(g => String(g.id)) : []
  if (planned.length > 0 || lands.length > 0) {
    lines.push('', '## Gates', '', '| Gate | Landed |', '|---|---|')
    const landedBy = new Map(lands.map(r => [String(r.body.gate), String(r.body.commit ?? '')]))
    for (const id of [...new Set([...planned, ...landedBy.keys()])]) lines.push(`| ${id} | ${landedBy.has(id) ? landedBy.get(id) : 'no'} |`)
    const earlier = Array.isArray(json?.args.landed) ? (json!.args.landed as { id: string; commit: string }[]) : []
    if (earlier.length > 0) lines.push('', `Landed earlier in this chain: ${earlier.map(l => `${l.id} (${l.commit})`).join(', ')}`)
  }
  return lines
}
