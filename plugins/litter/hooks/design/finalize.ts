// The end of a design run (COMMON step 6; decision 16): a plan's approved
// version delivered as plan.md, its bytes unchanged. Owner: phase 4, WP-BE.
//
// The ledger decides (plan section 9, "Run lifecycle"): the return gives only
// the status and the stop, and what's delivered is the version the ledger's
// latest verdict approved, its bytes checked against the sha256 in its
// proposal record and in that verdict (plan 7, "The skill then"). Nothing
// renders a proposal twice: plan.md is a copy of proposals/vN.md.

import type { Ports } from '../ports'
import type { RunRef } from '../lifecycle'
import type { RunEndBody, RunJson, RunStartBody } from '../records/run'
import type { Author, StoredRecord } from '../records/core'
import type { DesignCriterion, DesignDeliverBody, DesignVerdictBody } from '../records/design'
import { appendRecord, readLedger } from '../ledgercore'
import { planPath, PROPOSAL_VERSION, proposalPath, runJsonPath } from '../layout'
import { atomicWrite, remove, sha256 } from '../fsx'

const MOD: Author = { source: 'mod' }

const oneLine = (s: string, max = 300): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export const isVersion = (v: unknown): v is string => typeof v === 'string' && PROPOSAL_VERSION.test(v)

/** The run's `proposal` records in order, each with the version the mod assigned it. */
export const proposalRecords = (records: readonly StoredRecord[]): StoredRecord[] =>
  records.filter(r => r.kind === 'proposal' && isVersion(r.body.version))

/** The design critic's `verdict` records in order, each naming the version it judged. */
export const verdictRecords = (records: readonly StoredRecord[]): StoredRecord[] =>
  records.filter(r => r.kind === 'verdict' && isVersion(r.body.version))

/** The seq of a generation's run.end, the first recorded for it as runState reads it; null when there's none. */
export function endSeqOf(records: readonly StoredRecord[], generation: number): number | null {
  return records.find(r => r.kind === 'run.end' && r.body.generation === generation)?.seq ?? null
}

/** The stop a refusal names: a done run's `by`, else the status and its reason. */
function stopOf(end: RunEndBody): string {
  const by = end.payload?.by
  if (end.status === 'done' && typeof by === 'string') return oneLine(by, 60)
  return end.reason && end.reason !== end.status ? `${end.status}: ${oneLine(end.reason, 200)}` : end.status
}

/** What keeps a verdict from approving: each criterion that isn't PASS, and each bar item it doesn't judge. */
function openItems(criteria: unknown, bar: readonly string[] | null): string[] {
  const list = (Array.isArray(criteria) ? criteria : []).filter((c): c is DesignCriterion => typeof c === 'object' && c !== null)
  const out = list.filter(c => c.verdict !== 'PASS').map(c => `${oneLine(String(c.id), 40)} is ${oneLine(String(c.verdict), 20)}`)
  if (bar) for (const id of bar) if (!list.some(c => c.id === id)) out.push(`${id} has no verdict`)
  if (list.length === 0 && out.length === 0) out.push('it judges no criterion')
  return out
}

const shaOf = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export type Approval =
  | { ok: true; version: string; proposalSha: string | null; verdictSha: string | null }
  | { ok: false; version: string | null; refused: string }

/**
 * Whether the ledger approved what the run's end says it approved (decision
 * 16), from the records before that end's run.end: the end is done with
 * `outcome: 'approved'`; the latest proposal is vN; the latest verdict names
 * vN, is APPROVED with every criterion PASS and every bar item judged, and
 * the checkout didn't change while it was judged; and the return's version,
 * when it gives one, is vN. `version` is always the ledger's latest. `bar`
 * is the frozen bar's ids from run.json, or null to leave coverage to the
 * verdict record's own check. No file is read: deliver checks the bytes.
 */
export function ledgerApproval(end: RunEndBody, records: readonly StoredRecord[], bar: readonly string[] | null): Approval {
  const latest = proposalRecords(records).at(-1)
  const version = latest ? (latest.body.version as string) : null
  if (end.generation === 0 || end.status === 'launch_failed') return { ok: false, version, refused: 'the run never launched' }
  // A holding outcome never delivers (decision 2), whatever the ledger holds.
  if (end.status !== 'done' || end.payload?.outcome !== 'approved') return { ok: false, version, refused: `holding (${stopOf(end)})` }
  if (!latest || version === null) return { ok: false, version, refused: "the run's return says approved, and the ledger doesn't: no proposal was recorded" }
  const verdict = verdictRecords(records).at(-1)
  if (!verdict || verdict.body.version !== version) {
    const older = verdict ? `; the latest verdict is on ${String(verdict.body.version)}` : ''
    return { ok: false, version, refused: `no verdict on the latest version, ${version}${older}` }
  }
  const body = verdict.body as Partial<DesignVerdictBody>
  if (body.overall !== 'APPROVED') return { ok: false, version, refused: `the latest verdict isn't APPROVED: ${version} is ${oneLine(String(body.overall), 20)}` }
  const open = openItems(body.criteria, bar)
  if (open.length > 0) return { ok: false, version, refused: `the latest verdict isn't APPROVED: it says APPROVED, but ${open.join(', ')}` }
  // A round whose checkout changed may mix old and new code (plan 7's stops), so its approval doesn't stand.
  if (body.source_changed === true) {
    return { ok: false, version, refused: `the run's return says approved, and the ledger doesn't: the checkout changed while ${version} was judged (source_changed)` }
  }
  const said = end.payload?.version
  if (said !== undefined && said !== null && said !== version) {
    const named = typeof said === 'string' ? oneLine(said, 40) : 'another version'
    return { ok: false, version, refused: `the run's return says ${named} was approved, and the ledger's latest version is ${version}` }
  }
  return { ok: true, version, proposalSha: shaOf(latest.body.sha256), verdictSha: shaOf(body.sha256) }
}

type Checked = { ok: true; json: RunJson } | { ok: false; why: string }

/** run.json as run.start wrote it: its sha256 is the run.start record's (lifecycle.ts's loadLaunchable checks it the same way). */
async function checkedJson(p: Ports, ref: RunRef, records: readonly StoredRecord[]): Promise<Checked> {
  const start = records.find(r => r.kind === 'run.start')?.body as Partial<RunStartBody> | undefined
  const path = runJsonPath(ref.runDir)
  if (!(await p.fs.exists(path))) return { ok: false, why: "run.json is missing, so litter can't tell what the run delivers" }
  const text = await p.fs.read(path)
  if (!start || (await sha256(text)) !== start.runJsonSha256) return { ok: false, why: 'run.json changed since run.start' }
  return { ok: true, json: JSON.parse(text) as RunJson }
}

/** The frozen bar's ids, from run.json's args; null when it has no bar. */
export function barIds(json: RunJson | null): string[] | null {
  const bar = json?.args?.bar
  if (!Array.isArray(bar)) return null
  return bar.flatMap(b => (typeof b === 'object' && b !== null && typeof (b as { id?: unknown }).id === 'string' ? [(b as { id: string }).id] : []))
}

/**
 * proposals/vN.md's bytes as plan.md, once their sha256 is the approving
 * verdict's and the proposal record's; written atomically and read back.
 * A refusal leaves any plan.md as it is.
 */
async function deliver(p: Ports, ref: RunRef, a: Extract<Approval, { ok: true }>): Promise<DesignDeliverBody> {
  const v = a.version
  const from = proposalPath(ref.runDir, v)
  if (!(await p.fs.exists(from))) return { version: v, refused: `proposals/${v}.md changed after it was recorded: it's gone` }
  const text = await p.fs.read(from)
  const now = await sha256(text)
  // The plan's words for a mismatch (plan 7, "The skill then"): the file changed after approval.
  if (now !== a.verdictSha) {
    return { version: v, refused: `proposals/${v}.md changed after it was approved: its sha256 is ${now}, and the approving verdict names ${a.verdictSha ?? 'none'}` }
  }
  if (now !== a.proposalSha) {
    return { version: v, refused: `proposals/${v}.md changed after it was recorded: its sha256 is ${now}, and its proposal record names ${a.proposalSha ?? 'none'}` }
  }
  const path = planPath(ref.runDir)
  await atomicWrite(p, path, text)
  const back = await sha256(await p.fs.read(path))
  if (back !== now) {
    // Never leave bytes as plan.md that aren't the approved ones.
    await remove(p, path).catch(() => {})
    throw new Error(`plan.md read back with sha256 ${back}, not the approved ${now}; it was removed`)
  }
  return { version: v, sha256: now, path }
}

/**
 * Called by lifecycle.ts's recordEnd for a design run's current end, after
 * the worktree cleanup and before summary.md, with the run's serial key held
 * (so it must not take it). `end` is the run.end just recorded, a launch
 * that never opened a generation (generation 0) included. It reads run.json
 * and the ledger itself and, for a plan deliverable, records one
 * `design.deliver` (DesignDeliverBody): delivered, `proposals/vN.md` copied
 * to plan.md once its sha256 equals the proposal record's and the
 * approving verdict's, or refused with why. A throw is logged by the caller,
 * and the summary still follows.
 *
 * One per end: a `design.deliver` recorded after this end's run.end is left
 * as it is. A run.json that's missing or changed since run.start can't say
 * the run isn't a plan, so it's refused rather than skipped.
 */
export async function finalizeDesign(p: Ports, ref: RunRef, end: RunEndBody): Promise<void> {
  const { records, tampered } = await readLedger(p, ref.runDir, ref.run)
  if (tampered) throw new Error(`run ${ref.run}'s ledger is tampered at ${tampered.seq}; nothing is delivered`)
  const at = endSeqOf(records, end.generation)
  if (at === null) throw new Error(`run ${ref.run} has no run.end for generation ${end.generation}`)
  if (records.some(r => r.kind === 'design.deliver' && r.seq > at)) return
  const json = await checkedJson(p, ref, records)
  if (json.ok && json.json.args?.deliverable !== 'plan') return
  const approval = ledgerApproval(end, records.filter(r => r.seq < at), json.ok ? barIds(json.json) : null)
  let body: DesignDeliverBody
  if (!approval.ok) body = { version: approval.version, refused: approval.refused }
  else if (!json.ok) body = { version: approval.version, refused: json.why }
  else body = await deliver(p, ref, approval)
  await appendRecord<DesignDeliverBody>(p, ref.runDir, { run: ref.run, kind: 'design.deliver', by: MOD, body })
}
