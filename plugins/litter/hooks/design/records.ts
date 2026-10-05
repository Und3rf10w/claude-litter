// The design records while a design's rounds run (COMMON step 4): the
// author's `proposal`, the design critic's `verdict` and the prober's `probe`.
// Owner: phase 4, WP-BC. WP-BA moved today's handlers here from
// records/design.ts; BC added the gates, the verdict's snapshot and out file,
// the probe's fields and the files on them.

import type { Ports } from '../ports'
import type { RecordCtx, RecordError, RecordHandler, RecordInput, RecordOk, StoredRecord } from '../records/core'
import type { AuthorGate } from '../records/design'
import type { Deliverable, RunJson } from '../records/run'
import { fail } from '../records/core'
import { authorOf, bareBacktickPaths, bodyOf, CRITERION_VERDICTS, GAP_KINDS, needText, OVERALLS, PROBE_VERDICTS, scoped, store } from '../records/design'
import { DELIVERABLES } from '../records/run'
import { appendRecord, readLedger } from '../ledgercore'
import { proposalPath, runJsonPath, UNKNOWN_ID } from '../layout'
import { atomicWrite, readJson, serial, sha256 } from '../fsx'
import { writeOut } from '../output'
import { snapshot } from '../snapshot'
import { renderProposal } from './proposal'
import { writeDesignVerdictFile, writeProbeFile } from './files'

const VERDICTS = CRITERION_VERDICTS
const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** Appends `body` by the caller, as records/design.ts's store does, and answers with the stored record too. */
async function append(ctx: RecordCtx, input: RecordInput, body: Record<string, unknown>): Promise<{ rec: StoredRecord; reply: RecordOk }> {
  const { run, runDir: dir } = scoped(ctx, input)
  const rec = await appendRecord(ctx.p, dir, { run, kind: input.kind, by: authorOf(ctx.caller), body })
  return { rec, reply: { ok: true, kind: rec.kind, run, seq: rec.seq } }
}

/**
 * `proposal`: the mod assigns the next version, renders the text for the
 * run's deliverable (renderProposal: for a plan, the author's gates after the
 * prose, read back by execute's parser), stores those bytes as
 * `proposals/vN.md` with their sha256 in the record, and writes the author's
 * observed `proposal` field, the same bytes, for output.sh. The record's body
 * keeps the prose as `text` and the author's `gates` (ProposalBody).
 */
export const recordProposal: RecordHandler = async (ctx, input) => {
  const missing = needText(input, 'text', 'the full proposal text, as markdown')
  if (missing) return missing
  if (input.gates !== undefined && !Array.isArray(input.gates)) {
    return fail("litter: 'gates' must be a list of gates, each { id, title, plan_section, scope, files, checks, done_when, rollback, adversary? }", 'gates')
  }
  if (input.delta !== undefined && typeof input.delta !== 'string' && !Array.isArray(input.delta)) {
    return fail("litter: 'delta' must be a list of changes from the previous version, or one text", 'delta')
  }
  const { run, runDir: dir } = scoped(ctx, input)
  const json = await readJson<RunJson>(ctx.p, runJsonPath(dir)).catch(() => undefined)
  const deliverable = json?.args?.deliverable
  if (!(DELIVERABLES as readonly unknown[]).includes(deliverable)) {
    return fail(`litter: run ${run}'s run.json names no deliverable (${DELIVERABLES.join(', ')}), so the proposal can't be rendered; nothing was recorded`, 'run')
  }
  const text = input.text as string
  const rendered = renderProposal(text, input.gates as AuthorGate[] | undefined, deliverable as Deliverable)
  if (!rendered.ok) return fail(rendered.error, rendered.field)
  // One version per call: the count and the write must not interleave with another proposal of this run.
  return serial(`proposal:${dir}`, async () => {
    const { records } = await readLedger(ctx.p, dir, run)
    const n = records.filter(r => r.kind === 'proposal').length + 1
    const version = `v${n}`
    const sha = await sha256(rendered.text)
    await atomicWrite(ctx.p, proposalPath(dir, version), rendered.text)
    const reply = await store(ctx, input, { ...bodyOf(input), version, sha256: sha }, { version, sha256: sha })
    const warnings: string[] = []
    const bare = bareBacktickPaths(text)
    if (bare.length > 0) {
      const shown = bare.slice(0, 10).join(', ') + (bare.length > 10 ? `, and ${bare.length - 10} more` : '')
      warnings.push(
        `litter: bare backticked paths in the prose (${shown}); write them as [label](path) links so they navigate. ${version} was recorded as it is.`,
      )
    }
    if (ctx.caller.agentId !== null) {
      try {
        await writeOut(ctx.p, ctx.litterDir!, {
          v: 1,
          agent_id: ctx.caller.agentId,
          for: { version },
          fields: { version, proposal: rendered.text },
        })
      } catch (err) {
        ctx.p.log(`proposal ${run} ${version}: out file not written: ${err instanceof Error ? err.message : String(err)}`)
        warnings.push(`litter: ${version} is recorded, but the observed proposal field couldn't be written; return your result anyway`)
      }
    }
    return warnings.length > 0 ? { ...reply, warnings } : reply
  })
}

/** The bar's ids (criteria and bans), fixed at run.start in run.json's args; null when the run has no bar. */
function barIds(json: RunJson | undefined): string[] | null {
  const bar = json?.args?.bar
  if (!Array.isArray(bar)) return null
  const ids = bar.map(c => (c && typeof c === 'object' ? (c as { id?: unknown }).id : undefined)).filter((id): id is string => typeof id === 'string')
  return ids.length > 0 ? ids : null
}

/** A criterion's fields as the critic's schema has them (prompts doc, "Design schemas"), each optional one checked when given. */
const CRITERION_FIELDS = ['id', 'verdict', 'gap_or_reason', 'evidence', 'kept_from', 'reversed', 'gap_kind'] as const

/** A criterion as the out file gives it to the critic's StructuredOutput: the schema's fields only, as recorded. */
const shaped = (c: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(CRITERION_FIELDS.filter(k => c[k] !== undefined).map(k => [k, c[k]]))

/** Why criterion `i` can't be recorded past the bar checks (its gap_kind and the schema's types), or null. */
function criterionFields(c: Record<string, unknown>, i: number): RecordError | null {
  const at = `criteria[${i}]`
  if (c.verdict !== 'PASS' && c.gap_kind === undefined) {
    return fail(
      `litter: '${at}.gap_kind' is required when the verdict isn't PASS: investigation (more investigation), design (a design change), wording (a fix to the proposal's wording or evidence) or user (a decision only the user can make)`,
      `${at}.gap_kind`,
      GAP_KINDS,
    )
  }
  if (c.gap_kind !== undefined && !(GAP_KINDS as readonly unknown[]).includes(c.gap_kind)) {
    return fail(`litter: '${at}.gap_kind' must be one of the allowed values`, `${at}.gap_kind`, GAP_KINDS)
  }
  if (typeof c.evidence !== 'string' || c.evidence.trim() === '') {
    return fail(`litter: '${at}.evidence' is required: the file:line, empirical result or report section the verdict rests on`, `${at}.evidence`)
  }
  for (const k of ['gap_or_reason', 'kept_from'] as const) {
    if (c[k] !== undefined && typeof c[k] !== 'string') return fail(`litter: '${at}.${k}' must be text`, `${at}.${k}`)
  }
  if (c.reversed !== undefined && typeof c.reversed !== 'boolean') return fail(`litter: '${at}.reversed' must be true or false`, `${at}.reversed`)
  return null
}

type Drift = { ok: true; tree: string; changed: boolean } | { ok: false; error: string }

/**
 * The checkout's tree now, and whether it differs from base's (decision 17):
 * the same temporary-index snapshot run.start took for base, so uncommitted
 * and untracked files count, and `.claude/litter`, `.claude/worktrees` and
 * ignored files don't. Any failure is an error naming git's, never "unchanged".
 */
async function drift(p: Ports, json: RunJson | undefined): Promise<Drift> {
  const checkout = json?.checkout
  const base = json?.base
  if (typeof checkout !== 'string' || !checkout.startsWith('/') || typeof base !== 'string' || !OID.test(base)) {
    return { ok: false, error: "litter: run.json names no checkout and base commit to compare the tree with, so source_changed can't be observed; nothing was recorded" }
  }
  let tree: string
  try {
    tree = (await snapshot(p, checkout)).tree
  } catch (err) {
    return { ok: false, error: `litter: the checkout's snapshot failed (${errText(err)}), so source_changed can't be observed; nothing was recorded. Record the verdict again` }
  }
  const r = await p.run(['git', '-C', checkout, 'rev-parse', '--verify', '--end-of-options', `${base}^{tree}`], { timeoutMs: 120_000 }).catch(err => ({
    code: -1,
    stdout: '',
    stderr: errText(err),
  }))
  const baseTree = r.stdout.trim()
  if (r.code !== 0 || !OID.test(baseTree)) {
    return { ok: false, error: `litter: git rev-parse ${base}^{tree} failed (exit ${r.code}: ${r.stderr.trim() || 'no tree'}), so source_changed can't be observed; nothing was recorded. Record the verdict again` }
  }
  return { ok: true, tree, changed: tree !== baseTree }
}

/**
 * `verdict`, the design critic's: it must name the run's latest proposal
 * version (the bar is fixed at run.start), cover the bar exactly once, and
 * agree with its own criteria; each criterion that isn't PASS names its
 * `gap_kind`, and each cites its evidence. The mod adds the judged version's
 * sha256, and the checkout's snapshot against base: `tree` and
 * `source_changed` (decision 17). For an agent, the out file then carries
 * the recorded `version`, `source_changed`, `criteria` and `overall` for its
 * StructuredOutput (decision 7), and `verdicts/vN.md` is rendered from the
 * record.
 */
export const recordVerdict: RecordHandler = async (ctx, input) => {
  const { run, runDir: dir } = scoped(ctx, input)
  const { records } = await readLedger(ctx.p, dir, run)
  const latest = records.filter(r => r.kind === 'proposal').at(-1)?.body as { version?: string; sha256?: string } | undefined
  if (!latest?.version) return fail("litter: no proposal is recorded in this run yet, so there's no version to judge", 'version')
  if (input.version !== latest.version) {
    return fail(`litter: 'version' must name the run's latest proposal, ${latest.version}`, 'version', [latest.version])
  }
  const json = await readJson<RunJson>(ctx.p, runJsonPath(dir))
  const bar = barIds(json)
  const criteria = input.criteria
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return fail("litter: 'criteria' is required: one { id, verdict } per bar id, with verdict PASS, CONDITIONAL or FAIL", 'criteria', bar ?? undefined)
  }
  const ids: string[] = []
  for (let i = 0; i < criteria.length; i++) {
    const c = criteria[i] as { id?: unknown; verdict?: unknown } | null
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || c.id === '') {
      return fail(`litter: 'criteria[${i}].id' is required: the bar id this verdict is for`, `criteria[${i}].id`, bar ?? undefined)
    }
    if (typeof c.verdict !== 'string' || !(VERDICTS as readonly string[]).includes(c.verdict)) {
      return fail(`litter: 'criteria[${i}].verdict' must be one of the allowed values`, `criteria[${i}].verdict`, VERDICTS)
    }
    ids.push(c.id)
  }
  if (typeof input.overall !== 'string' || !(OVERALLS as readonly string[]).includes(input.overall)) {
    return fail("litter: 'overall' must be one of the allowed values", 'overall', OVERALLS)
  }
  if (bar) {
    const missing = bar.filter(id => !ids.includes(id))
    const repeated = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))]
    const unknown = [...new Set(ids.filter(id => !bar.includes(id)))]
    if (missing.length + repeated.length + unknown.length > 0) {
      const parts = [
        missing.length ? `missing ${missing.join(', ')}` : '',
        repeated.length ? `repeated ${repeated.join(', ')}` : '',
        unknown.length ? `not in the bar ${unknown.join(', ')}` : '',
      ].filter(Boolean)
      return fail(`litter: 'criteria' must cover the bar exactly once: ${parts.join('; ')}`, 'criteria', bar)
    }
  }
  const allPass = criteria.every(c => (c as { verdict: string }).verdict === 'PASS')
  if (input.overall === 'APPROVED' && !allPass) {
    return fail("litter: 'overall' is APPROVED only when every criterion is PASS", 'overall', ['HOLDING'])
  }
  const given = criteria as Record<string, unknown>[]
  for (let i = 0; i < given.length; i++) {
    const bad = criterionFields(given[i]!, i)
    if (bad) return bad
  }

  // The snapshot at the record, since a shell hook can't take it (plan section 9, "Run worktrees").
  const seen = await drift(ctx.p, json)
  if (!seen.ok) return fail(seen.error)
  const version = latest.version
  const { rec, reply } = await append(ctx, input, { ...bodyOf(input), sha256: latest.sha256 ?? null, tree: seen.tree, source_changed: seen.changed })
  const warnings: string[] = []
  if (ctx.caller.agentId !== null) {
    // Before the answer: the critic's next call may be its StructuredOutput, which output.sh fills from this.
    try {
      await writeOut(ctx.p, ctx.litterDir!, {
        v: 1,
        agent_id: ctx.caller.agentId,
        for: { version },
        fields: { version, source_changed: seen.changed, criteria: given.map(shaped), overall: input.overall },
      })
    } catch (err) {
      ctx.p.log(`verdict ${run} ${version}: out file not written: ${errText(err)}`)
      warnings.push(`litter: the verdict on ${version} is recorded, but its observed fields couldn't be written; return your result anyway`)
    }
  }
  try {
    await writeDesignVerdictFile(ctx.p, dir, rec)
  } catch (err) {
    ctx.p.log(`verdict ${run} ${version}: verdicts/${version}.md not written: ${errText(err)}`)
  }
  return warnings.length > 0 ? { ...reply, warnings } : reply
}

/**
 * `probe { unknown_id, report, verdict }`, the prober's (decision 18): the
 * report as markdown, the unknown it settles (`U<n>`), and the verdict,
 * confirmed, refuted or untested. Stored as given; then `probes/<id>.md` is
 * rendered from the latest record for that id.
 */
export const recordProbe: RecordHandler = async (ctx, input) => {
  const missing = needText(input, 'report', 'your report, as markdown, in the sections your role names')
  if (missing) return missing
  if (typeof input.unknown_id !== 'string' || !UNKNOWN_ID.test(input.unknown_id)) {
    return fail("litter: 'unknown_id' is required: the id of the unknown your <task> names, like U1", 'unknown_id')
  }
  if (typeof input.verdict !== 'string' || !(PROBE_VERDICTS as readonly string[]).includes(input.verdict)) {
    return fail(
      "litter: 'verdict' must be one of the allowed values: confirmed or refuted by the test's result, or untested when no real test could run",
      'verdict',
      PROBE_VERDICTS,
    )
  }
  const { run, runDir: dir } = scoped(ctx, input)
  const { rec, reply } = await append(ctx, input, bodyOf(input))
  try {
    await writeProbeFile(ctx.p, dir, rec)
  } catch (err) {
    ctx.p.log(`probe ${run} ${input.unknown_id}: probes/${input.unknown_id}.md not written: ${errText(err)}`)
  }
  return reply
}
