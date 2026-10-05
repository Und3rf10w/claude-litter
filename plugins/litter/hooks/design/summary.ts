// summary.md's design part (plan section 9, "Run lifecycle"; COMMON decision
// 14): the stop, the delivery, the verdict card and the rest the skill reads
// by heading. Owner: phase 4, WP-BE.
//
// From the ledger (plan section 9: the return gives only the status and the
// stop). Each part is a `##` section the design skill reads by its heading,
// left out when it has nothing to say. Text from records is flattened to one
// line in lists and escaped in the card's cells, so none of it can open a
// heading of its own.

import type { Ports } from '../ports'
import type { RunRef } from '../lifecycle'
import type { BarItem, RunEndBody, RunJson } from '../records/run'
import type { StoredRecord } from '../records/core'
import type { DesignCriterion, DesignDeliverBody, DesignVerdictBody } from '../records/design'
import { PROBE_VERDICTS } from '../records/design'
import { designVerdictPath, probePath, proposalPath, UNKNOWN_ID } from '../layout'
import { runState } from '../lifecycle'
import { barIds, endSeqOf, isVersion, ledgerApproval, proposalRecords, verdictRecords } from './finalize'

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const objects = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
const oneLine = (s: string, max = 300): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
/** A record's text on one line, or '' when it isn't text. */
const text = (v: unknown, max = 300): string => (typeof v === 'string' ? oneLine(v, max) : '')
/** A table cell: `|` escaped and line breaks as `<br>`, so the text stays in its cell (the full text is in the verdict file). */
const cell = (v: unknown, max = 2000): string => {
  if (typeof v !== 'string') return ''
  const t = v.trim()
  const cut = t.length > max ? `${t.slice(0, max - 1)}…` : t
  return cut.replace(/\r\n|\r|\n/g, '<br>').replace(/\|/g, '\\|')
}

/** `by` of a done return, in the skill's words (prompts, `skills/design/SKILL.md` step 7). */
const BY: Record<string, string> = {
  approved: 'the critic approved',
  'no-new-material': 'a round added nothing new',
  'max-rounds': 'max rounds reached',
  budget: 'the token budget ran out',
}
/** An early return for you (needs_user's reason). */
const NEEDS: Record<string, string> = {
  'goal-change': 'a reframe that changes the goal',
  'blocking-decision': 'a blocking decision',
  'user-gap': 'a gap only you can close',
}

/** The bar's items as run.json froze them. */
function barOf(json: RunJson | null): BarItem[] {
  return objects(json?.args.bar).filter(b => typeof b.id === 'string') as unknown as BarItem[]
}

/** The `design.result` results of one role, in order. */
const results = (records: readonly StoredRecord[], role: 'author' | 'reframer'): Obj[] =>
  records.filter(r => r.kind === 'design.result' && r.body.role === role && isObj(r.body.result)).map(r => r.body.result as Obj)

/** How the run ended, from its end and the ledger's latest version. */
function stopLines(end: RunEndBody, before: readonly StoredRecord[], json: RunJson | null): string[] {
  const latest = proposalRecords(before).at(-1)?.body.version as string | undefined
  const at = latest ? `, at ${latest}` : ', with no version recorded'
  const reason = end.reason ? oneLine(end.reason, 1000) : 'no reason recorded'
  const pl = end.payload ?? {}
  switch (end.status) {
    case 'launch_failed':
      return [`The launch failed (launch_failed): ${reason}`]
    case 'done': {
      const by = typeof pl.by === 'string' ? oneLine(pl.by, 60) : null
      if (!by) return [`Done, with no outcome recorded${at}`]
      const line = `${pl.outcome === 'approved' ? 'Approved' : 'Holding'}: ${BY[by] ?? by} (${by})${at}`
      // A plan's Delivery says whether the ledger agrees; for the other deliverables this does (decision 16).
      if (pl.outcome !== 'approved' || json?.args.deliverable === 'plan') return [line]
      const a = ledgerApproval(end, before, barIds(json))
      return a.ok ? [line] : [line, '', `The ledger doesn't show that approval: ${a.refused}. The verdict card below is the ledger's.`]
    }
    case 'needs_user': {
      const what = NEEDS[end.reason ?? '']
      if (!what) return [`Needs you: ${reason}`]
      let detail = ''
      if (end.reason === 'goal-change' && isObj(pl.reframe)) {
        const rf = pl.reframe
        const rec = text(rf.recommendation, 60)
        const alt = text(objects(rf.candidates).find(c => c.id === rf.recommendation)?.alternative, 500)
        if (rec) detail = `; the reframer recommends ${rec}${alt ? `: ${alt}` : ''}`
      } else if (end.reason === 'blocking-decision' && isObj(pl.decision) && text(pl.decision.question, 1000)) {
        detail = `: ${text(pl.decision.question, 1000)}`
      } else if (end.reason === 'user-gap') {
        const ids = objects(pl.criteria).map(c => text(c.id, 40)).filter(Boolean)
        if (ids.length > 0) detail = `: ${ids.join(', ')}`
      }
      return [`Needs you: ${what} (${end.reason})${detail}`]
    }
    case 'halted':
      if (end.reason === 'source-changed') {
        const v = isVersion(pl.version) ? `, while ${pl.version} was judged` : ''
        return [`Halted: the checkout changed during a round (source-changed)${v}. That round's evidence may mix old and new code.`]
      }
      return [`Halted: ${reason}`]
    case 'interrupted':
      return [`Interrupted: ${reason}`]
    case 'failed':
      return [`Failed: ${reason}`]
    case 'stopped':
      return [`Stopped before it finished${at}`]
  }
  return [`${end.status}: ${reason}`]
}

/** A plan's delivery, from this end's `design.deliver` (decision 16). */
function deliveryLines(endSeq: number | null, records: readonly StoredRecord[], json: RunJson | null): string[] {
  const rec = records.filter(r => r.kind === 'design.deliver' && (endSeq === null || r.seq > endSeq)).at(-1)
  if (!rec) {
    return json?.args.deliverable === 'plan' ? ["Not delivered: the delivery didn't finish, so no outcome was recorded; litter's debug log (claude --debug) says why"] : []
  }
  const b = rec.body as Partial<DesignDeliverBody>
  if (typeof b.refused === 'string') return [`Not delivered: ${oneLine(b.refused, 1000)}`]
  return [`Delivered: ${text(b.version, 40)} as ${text(b.path, 1000)}, sha256 ${text(b.sha256, 64)}, the approved bytes unchanged`]
}

/** The verdict card (decision 14): the last verdict's version, a row per bar item, and the overall result. */
async function cardLines(p: Ports, ref: RunRef, records: readonly StoredRecord[], bar: readonly BarItem[]): Promise<string[]> {
  const v = verdictRecords(records).at(-1)
  if (!v) return []
  const body = v.body as Partial<DesignVerdictBody>
  const version = body.version as string
  const criteria = objects(body.criteria) as unknown as DesignCriterion[]
  const file = designVerdictPath(ref.runDir, version)
  const lines = [
    `Version: ${version}${(await p.fs.exists(file)) ? ` (${file})` : ''}`,
    '',
    '| Item | Verdict | Gap or reason | Evidence | Gap kind |',
    '|---|---|---|---|---|',
  ]
  // Every bar item in the bar's order, then anything the verdict judged that the bar doesn't hold.
  const ids = [...new Set([...bar.map(b => b.id), ...criteria.map(c => c.id).filter((id): id is string => typeof id === 'string')])]
  for (const id of ids) {
    const c = criteria.find(x => x.id === id)
    const cells = c ? [cell(id, 40), cell(c.verdict, 20), cell(c.gap_or_reason), cell(c.evidence), cell(c.gap_kind, 20)] : [cell(id, 40), 'not judged', '', '', '']
    lines.push(`| ${cells.join(' | ')} |`)
  }
  lines.push('', `Overall: ${cell(body.overall, 20)}`)
  if (body.source_changed === true) lines.push('', `The checkout changed while ${version} was judged (source_changed), so its evidence may mix old and new code.`)
  return lines
}

/** Each version with its file, its sha256 and its latest verdict's overall. */
function versionLines(ref: RunRef, records: readonly StoredRecord[]): string[] {
  const verdicts = verdictRecords(records)
  return proposalRecords(records).map(r => {
    const v = r.body.version as string
    const judged = verdicts.filter(x => x.body.version === v).at(-1)?.body as Partial<DesignVerdictBody> | undefined
    const sha = text(r.body.sha256, 64) || 'not recorded'
    const changed = judged?.source_changed === true ? '; source_changed: the checkout changed while it was judged' : ''
    return `- ${v}: ${proposalPath(ref.runDir, v)}, sha256 ${sha}; ${judged ? text(judged.overall, 20) || 'no overall' : 'no verdict'}${changed}`
  })
}

/** Each reframer result's candidates, and what came of each: the recommendation, and whether it changes the goal. */
function reframeLines(records: readonly StoredRecord[]): string[] {
  const out: string[] = []
  results(records, 'reframer').forEach((res, i) => {
    const rec = text(res.recommendation, 60)
    const none = rec === '' || rec.toLowerCase() === 'none'
    out.push(`- Reframe ${i + 1}: ${none ? 'no reframe, proceed as stated' : `recommends ${rec}`}`)
    for (const c of objects(res.candidates)) {
      const id = text(c.id, 60) || '?'
      const shape = text(c.shape, 200)
      const fate = none || id !== rec ? 'not recommended' : res.changes_goal === true ? 'recommended, and it changes the goal' : 'recommended, within the goal as stated'
      out.push(`  - ${id}${shape ? ` (${shape})` : ''}: ${text(c.alternative, 500) || 'no alternative given'}; ${fate}`)
    }
  })
  return out
}

/** The unknowns args gave (decision 3), each `{ id, question }`; a bare string is the question, `U<n>` in the order given. */
function unknownsOf(json: RunJson | null): { id: string; question: string }[] {
  const list = Array.isArray(json?.args.empiricalUnknowns) ? (json!.args.empiricalUnknowns as unknown[]) : []
  return list.flatMap((u, i) => {
    if (typeof u === 'string') return [{ id: `U${i + 1}`, question: u }]
    if (isObj(u) && typeof u.id === 'string' && UNKNOWN_ID.test(u.id)) return [{ id: u.id, question: typeof u.question === 'string' ? u.question : '' }]
    return []
  })
}

/** Each unknown with its latest probe (decision 18), the never-probed as untested, then the ones a mechanism proposed. */
async function probeLines(p: Ports, ref: RunRef, json: RunJson | null, records: readonly StoredRecord[]): Promise<string[]> {
  const given = unknownsOf(json)
  // The latest probe per id wins; the Map keeps the order ids first appear.
  const probes = new Map<string, Obj>()
  for (const r of records) if (r.kind === 'probe' && typeof r.body.unknown_id === 'string' && UNKNOWN_ID.test(r.body.unknown_id)) probes.set(r.body.unknown_id, r.body)
  const ids = [...new Set([...given.map(u => u.id), ...probes.keys()])]
  const out: string[] = []
  for (const id of ids) {
    const u = given.find(x => x.id === id)
    const what = u ? `: ${text(u.question, 500) || 'no question given'}` : ", a mechanism's unknown"
    const probe = probes.get(id)
    if (!probe) {
      out.push(`- ${id}${what}; untested, never probed`)
      continue
    }
    const verdict = (PROBE_VERDICTS as readonly unknown[]).includes(probe.verdict) ? String(probe.verdict) : 'no verdict recorded'
    const file = probePath(ref.runDir, id)
    out.push(`- ${id}${what}; ${verdict}${(await p.fs.exists(file)) ? `, ${file}` : ''}`)
  }
  return out
}

/** The latest author result's residual unknowns that ship default-off, each with why it's open and how to resolve it. */
function defaultOffLines(author: Obj | undefined): string[] {
  return objects(author?.residual_unknowns)
    .filter(u => u.default_off === true)
    .flatMap(u => [
      `- ${text(u.id, 60) || '?'}: ${text(u.description, 1000) || 'no description given'}`,
      `  - Why it's open: ${text(u.why_open, 1000) || 'not given'}`,
      `  - How to resolve it: ${text(u.how_to_resolve, 1000) || 'not given'}`,
    ])
}

/** The latest author result's decisions for you, with the recommended option, whether it's blocking, and the options. */
function decisionLines(author: Obj | undefined): string[] {
  return objects(author?.user_decisions).flatMap(d => [
    `- ${text(d.question, 1000) || 'no question given'} (${d.blocking === true ? 'blocking' : 'not blocking'}; recommended: ${text(d.recommended, 500) || 'none given'})`,
    ...objects(d.options).map(o => `  - ${text(o.label, 200) || '?'}: ${text(o.tradeoff, 1000) || 'no trade-off given'}`),
  ])
}

const isRef = (v: unknown): v is { id: string; version: number } => isObj(v) && typeof v.id === 'string' && Number.isSafeInteger(v.version)
const refText = (r: { id: string; version: number }): string => `${oneLine(r.id, 80)}@${r.version}`

/** The bar's rule items (16.5; decision 4): a ban's `rule`, and the one criterion's `rules`, as `id@v`. */
function ruleLines(bar: readonly BarItem[]): string[] {
  const out: string[] = []
  for (const b of bar) {
    const refs = [...(isRef(b.rule) ? [b.rule] : []), ...(Array.isArray(b.rules) ? b.rules.filter(isRef) : [])]
    if (refs.length > 0) out.push(`- ${oneLine(b.id, 40)}: ${refs.map(refText).join(', ')}`)
  }
  return out
}

/**
 * A design run's lines of summary.md, after the header and the Result block,
 * from its run.json and ledger records (the run's, in seq order). Called by
 * lifecycle.ts's writeSummary, inside the run's serial key when endRun writes
 * it; a throw is logged there and the rest of the summary stands.
 *
 * The sections, in the order and with the headings the design skill reads:
 * Stop, Delivery, Verdict card, Versions, Reframes, Probes, Ships
 * default-off, User decisions, Rules.
 */
export async function designSummary(p: Ports, ref: RunRef, json: RunJson | null, records: readonly StoredRecord[]): Promise<string[]> {
  const st = runState(records)
  const end = st.latest ? st.latest.end : st.launchEnd
  const endSeq = end ? endSeqOf(records, end.generation) : null
  const before = endSeq === null ? records : records.filter(r => r.seq < endSeq)
  const bar = barOf(json)
  const lines: string[] = []
  const section = (name: string, body: string[]) => {
    if (body.length > 0) lines.push('', `## ${name}`, '', ...body)
  }
  section('Stop', end ? stopLines(end, before, json) : [])
  section('Delivery', end ? deliveryLines(endSeq, records, json) : [])
  section('Verdict card', await cardLines(p, ref, records, bar))
  section('Versions', versionLines(ref, records))
  section('Reframes', reframeLines(records))
  section('Probes', await probeLines(p, ref, json, records))
  const author = results(records, 'author').at(-1)
  section('Ships default-off', defaultOffLines(author))
  section('User decisions', decisionLines(author))
  section('Rules', ruleLines(bar))
  return lines
}
