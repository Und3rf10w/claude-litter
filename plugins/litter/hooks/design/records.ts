// The design records while a design's rounds run (COMMON step 4): the
// author's `proposal`, the design critic's `verdict` and the prober's `probe`.
// Owner: phase 4, WP-BC. WP-BA moved today's handlers here unchanged from
// records/design.ts; BC builds the gates, the verdict's snapshot and out file,
// the probe's fields and the files on them.

import type { RecordCtx, RecordHandler } from '../records/core'
import type { RunJson } from '../records/run'
import { fail } from '../records/core'
import { bareBacktickPaths, bodyOf, CRITERION_VERDICTS, needText, OVERALLS, scoped, store } from '../records/design'
import { readLedger } from '../ledgercore'
import { proposalPath, runJsonPath } from '../layout'
import { atomicWrite, readJson, serial, sha256 } from '../fsx'
import { writeOut } from '../output'

const VERDICTS = CRITERION_VERDICTS

/**
 * `proposal`: the mod assigns the next version, stores the text as
 * `proposals/vN.md` and its sha256 in the record, and writes the author's
 * observed `proposal` field for output.sh. Rendering `gates` into plan
 * sections, checked by execute's parser, comes with design runs (phase 4), so
 * a proposal with gates is refused until then rather than stored unrendered.
 */
export const recordProposal: RecordHandler = async (ctx, input) => {
  const missing = needText(input, 'text', 'the full proposal text, as markdown')
  if (missing) return missing
  if (input.gates !== undefined && !(Array.isArray(input.gates) && input.gates.length === 0)) {
    return fail(
      "litter: a proposal's 'gates' are rendered into the plan's gate sections from phase 4 (design runs); record the text without them for now",
      'gates',
    )
  }
  if (input.delta !== undefined && typeof input.delta !== 'string' && !Array.isArray(input.delta)) {
    return fail("litter: 'delta' must be a list of changes from the previous version, or one text", 'delta')
  }
  const { run, runDir: dir } = scoped(ctx, input)
  const text = input.text as string
  // One version per call: the count and the write must not interleave with another proposal of this run.
  return serial(`proposal:${dir}`, async () => {
    const { records } = await readLedger(ctx.p, dir, run)
    const n = records.filter(r => r.kind === 'proposal').length + 1
    const version = `v${n}`
    const sha = await sha256(text)
    await atomicWrite(ctx.p, proposalPath(dir, version), text)
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
          fields: { version, proposal: text },
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
async function barIds(ctx: RecordCtx, dir: string): Promise<string[] | null> {
  const json = await readJson<RunJson>(ctx.p, runJsonPath(dir))
  const bar = json?.args?.bar
  if (!Array.isArray(bar)) return null
  const ids = bar.map(c => (c && typeof c === 'object' ? (c as { id?: unknown }).id : undefined)).filter((id): id is string => typeof id === 'string')
  return ids.length > 0 ? ids : null
}

/**
 * `verdict`, the design critic's: it must name the run's latest proposal
 * version (the bar is fixed at run.start), cover the bar exactly once, and
 * agree with its own criteria. The mod adds the judged version's sha256.
 */
export const recordVerdict: RecordHandler = async (ctx, input) => {
  const { run, runDir: dir } = scoped(ctx, input)
  const { records } = await readLedger(ctx.p, dir, run)
  const latest = records.filter(r => r.kind === 'proposal').at(-1)?.body as { version?: string; sha256?: string } | undefined
  if (!latest?.version) return fail("litter: no proposal is recorded in this run yet, so there's no version to judge", 'version')
  if (input.version !== latest.version) {
    return fail(`litter: 'version' must name the run's latest proposal, ${latest.version}`, 'version', [latest.version])
  }
  const bar = await barIds(ctx, dir)
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
  return store(ctx, input, { ...bodyOf(input), sha256: latest.sha256 ?? null })
}

/**
 * `probe`, the prober's report: today's investigator handler (report
 * required, stored as given). WP-BC adds decision 18's `unknown_id` and
 * `verdict`, and the probe's file.
 */
export const recordProbe: RecordHandler = async (ctx, input) =>
  needText(input, 'report', 'your report, as markdown, in the sections your role names') ?? store(ctx, input, bodyOf(input))
