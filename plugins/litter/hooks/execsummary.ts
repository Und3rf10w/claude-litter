// summary.md's execute part (COMMON step 1): attempts per gate, the last
// verdict's failing dimensions, the halt and its evidence, the rules used and
// the proposals made. Owner: phase 3, package AB.
//
// From the ledger only (plan section 9: the ledger is the record of truth),
// so the execute skill can report from summary.md even when the script's
// return was cut or disagrees. The Gates table keeps the shape it had before
// phase 3; the rest follows it.

import type { Ports } from './ports'
import type { Generation, RunRef } from './lifecycle'
import type { RunJson } from './records/run'
import type { StoredRecord } from './records/core'
import { VERDICT_DIMENSIONS } from './records/execute'
import { verdictFile } from './layout'
import { runState } from './lifecycle'
import { proposalsOf } from './rules/store'
import { verdictTarget } from './verdicts'

// AD's proposals, through one table so tier 2 can stand in for them (COMMON, "Another package's module").
export const deps = {
  proposalsOf: (...a: Parameters<typeof proposalsOf>) => proposalsOf(...a),
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const oneLine = (s: string, max = 300): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
const counted = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`

type Dim = { pass?: unknown; evidence?: unknown; gaps?: unknown }
type Judged = { rec: StoredRecord; gate: string; attempt: number }

const named = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** What a verdict failed: its dimensions that didn't pass, and a plan gap or a rule clash when it names one. */
function failing(body: Record<string, unknown>): string[] {
  const out: string[] = VERDICT_DIMENSIONS.filter(d => (body[d] as Dim | undefined)?.pass !== true)
  if (named(body.plan_gap)) out.push('plan_gap')
  if (named(body.rule_clash)) out.push('rule_clash')
  return out
}

/** The evidence lines of what a verdict failed, each dimension's gaps under it. */
function evidenceLines(body: Record<string, unknown>): string[] {
  const lines: string[] = []
  for (const d of VERDICT_DIMENSIONS) {
    const dim = body[d] as Dim | undefined
    if (dim?.pass === true) continue
    lines.push(`- ${d}: ${typeof dim?.evidence === 'string' && dim.evidence.trim() !== '' ? oneLine(dim.evidence, 1000) : 'no evidence given'}`)
    if (Array.isArray(dim?.gaps)) for (const g of dim.gaps) if (typeof g === 'string' && g.trim() !== '') lines.push(`  - ${oneLine(g, 500)}`)
  }
  if (named(body.plan_gap)) lines.push(`- plan_gap: ${oneLine(body.plan_gap, 1000)}`)
  if (named(body.rule_clash)) lines.push(`- rule_clash: ${oneLine(body.rule_clash, 1000)}`)
  return lines
}

/**
 * A gate's latest executor result before `before` (output.ts's task.result,
 * GateResultBody), when it's a block naming a plan gap; null otherwise.
 */
function executorStop(records: readonly StoredRecord[], gate: string, before: number): { seq: number; attempt: number | string; gap: string } | null {
  const r = records.filter(x => x.seq < before && x.kind === 'task.result' && x.body.role === 'executor' && x.body.gate === gate).at(-1)
  const res = r?.body.result as Record<string, unknown> | undefined
  if (!r || !res || typeof res !== 'object' || res.status !== 'blocked' || typeof res.plan_gap !== 'string' || res.plan_gap.trim() === '') return null
  return { seq: r.seq, attempt: Number.isSafeInteger(r.body.attempt) ? (r.body.attempt as number) : '?', gap: res.plan_gap }
}

/** The generation the workflow ran in: the latest launch or resume, not a repair swarm's (2b-2, AC's bridge). */
function workflowGeneration(generations: readonly Generation[]): Generation | null {
  for (let i = generations.length - 1; i >= 0; i--) if (generations[i]!.repair === null) return generations[i]!
  return null
}

/**
 * The lines lifecycle.ts's writeSummary puts in an execute run's summary.md
 * after its header, each section starting with a blank line. A throw is
 * logged there, and the rest of the summary stands.
 */
export async function executeSummary(p: Ports, ref: RunRef, json: RunJson | null, records: readonly StoredRecord[]): Promise<string[]> {
  const lines: string[] = []
  const planned = Array.isArray(json?.args.gates)
    ? (json!.args.gates as { id?: unknown; title?: unknown }[]).filter(g => g && typeof g.id === 'string').map(g => ({ id: String(g.id), title: typeof g.title === 'string' ? g.title : '' }))
    : []
  const landedBy = new Map<string, string>()
  for (const r of records) if (r.kind === 'land' && typeof r.body.gate === 'string') landedBy.set(r.body.gate, String(r.body.commit ?? ''))

  // The table of before (phase 1): every planned gate, and any gate a land names.
  const ids = [...new Set([...planned.map(g => g.id), ...landedBy.keys()])]
  if (ids.length > 0) {
    lines.push('', '## Gates', '', '| Gate | Landed |', '|---|---|')
    for (const id of ids) lines.push(`| ${id} | ${landedBy.has(id) ? landedBy.get(id) : 'no'} |`)
    const earlier = Array.isArray(json?.args.landed) ? (json!.args.landed as { id: string; commit: string }[]) : []
    if (earlier.length > 0) lines.push('', `Landed earlier in this chain: ${earlier.map(l => `${l.id} (${l.commit})`).join(', ')}`)
  }

  // Attempts, from each gate's verifies and its executors' results (an executor's stop before a verify is an attempt too, WP-AH);
  // the last verdict on each, by the verify it cites.
  const attempts = new Map<string, Set<number>>()
  for (const r of records) {
    const result = r.kind === 'task.result' && r.body.role === 'executor'
    if ((r.kind !== 'verify' && !result) || typeof r.body.gate !== 'string' || !Number.isInteger(r.body.attempt)) continue
    const set = attempts.get(r.body.gate) ?? new Set<number>()
    set.add(r.body.attempt as number)
    attempts.set(r.body.gate, set)
  }
  const judged: Judged[] = []
  for (const r of records) {
    if (r.kind !== 'verdict') continue
    const t = verdictTarget(records, r)
    if (t) judged.push({ rec: r, gate: t.gate, attempt: t.attempt })
  }
  const lastVerdict = (gate: string, before = Infinity): Judged | null =>
    judged.filter(j => j.gate === gate && j.rec.seq < before).at(-1) ?? null
  if (planned.length > 0) {
    lines.push('', '## Attempts', '')
    for (const g of planned) {
      const n = attempts.get(g.id)?.size ?? 0
      const v = lastVerdict(g.id)
      const head = `- ${g.id}${g.title ? ` (${oneLine(g.title, 120)})` : ''}: ${n === 0 ? 'no attempt' : counted(n, 'attempt')}`
      if (!v) {
        lines.push(`${head}${n === 0 ? '' : '; no verdict recorded'}`)
        continue
      }
      const f = failing(v.rec.body)
      const file = verdictFile(ref.runDir, v.gate, v.attempt)
      lines.push(`${head}; the last verdict (attempt ${v.attempt}) ${f.length === 0 ? 'passed every dimension' : `failed ${f.join(', ')}`}: ${file}`)
    }
  }

  // Where the workflow stopped, when it didn't end done: the first planned gate with no land then, and its last verdict.
  const st = runState(records)
  const gen = workflowGeneration(st.generations)
  const end = gen?.end ?? null
  if (gen && end && end.status !== 'done') {
    const before = gen.endSeq ?? Infinity
    const landedThen = new Set(records.filter(r => r.kind === 'land' && r.seq < before && typeof r.body.gate === 'string').map(r => String(r.body.gate)))
    const stuck = planned.find(g => !landedThen.has(g.id))
    lines.push('', '## Where it stopped', '', `${end.status}: ${end.reason ? oneLine(end.reason, 2000) : 'no reason recorded'}`)
    if (stuck) {
      const v = lastVerdict(stuck.id, before)
      lines.push('', `The gate that didn't land: ${stuck.id}${stuck.title ? ` (${oneLine(stuck.title, 120)})` : ''}.`)
      // The executor's plan-gap stop after its last verdict (WP-AH): what the bridge read, since a block writes no verdict.
      const stop = executorStop(records, stuck.id, before)
      if (stop && (!v || stop.seq > v.rec.seq)) {
        lines.push(`Its executor stopped on attempt ${stop.attempt} before the attempt was judged, naming a plan gap:`, `- plan_gap: ${oneLine(stop.gap, 1000)}`)
      }
      if (v && failing(v.rec.body).length > 0) {
        lines.push(`Its last verdict, attempt ${v.attempt} (${verdictFile(ref.runDir, v.gate, v.attempt)}):`, ...evidenceLines(v.rec.body))
      } else if (v) {
        lines.push(`Its last verdict, attempt ${v.attempt}, passed every dimension (${verdictFile(ref.runDir, v.gate, v.attempt)}).`)
      } else {
        lines.push('No verdict was recorded for it.')
      }
    }
  }

  // The accepted rule versions the run was given (decision 19), and what its critics proposed.
  const used = Array.isArray(json?.rules) ? json!.rules.filter(r => r && typeof r.id === 'string').map(r => `${r.id}@${r.version}`) : []
  lines.push('', '## Rules used', '', used.length > 0 ? used.join(', ') : 'none')
  try {
    const proposals = await deps.proposalsOf(p, ref.litterDir, { run: ref.run })
    if (proposals.length > 0) {
      lines.push('', '## Rules proposed in this run', '', 'Proposed, not accepted, waiting in /litter-rules:', '')
      for (const x of proposals) {
        const from = [x.body.source, x.body.gate].filter((s): s is string => typeof s === 'string' && s !== '').join(', ')
        lines.push(`- ${oneLine(x.body.rule)}${from ? ` (${from})` : ''}${x.status !== 'proposed' ? `, now ${x.status}` : ''}`)
      }
    }
  } catch (err) {
    lines.push('', '## Rules proposed in this run', '', `The proposals couldn't be read: ${oneLine(errText(err))}. /litter-rules lists them.`)
  }
  return lines
}
