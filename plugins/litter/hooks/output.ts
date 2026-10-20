// Observed fields for StructuredOutput (plan section 9, "Observed facts beat
// claimed ones"). Owner: phase 1b, work package B.
//
// A handler that observed something an agent will return (a verify's exit code,
// a land's commit, a proposal's text) calls writeOut before it answers, so
// output.sh finds out/<agent_id>.json when the agent returns. consumeOutput
// records each spooled StructuredOutput result in the ledger, so a verdict
// needn't be recorded twice, and a design's author and reframer results are
// in the ledger for its summary (phase 4).

import type { Ports } from './ports'
import type { OutFile, SpoolConsumer } from './hookfiles'
import type { Author, StoredRecord } from './records/core'
import type { DesignResultBody } from './records/design'
import type { RunJson } from './records/run'
import type { TaskResultBody } from './records/fanout'
import type { CriticProposal } from './records/rules'
import { appendRecord, elsewhere, owned, readLedger } from './ledgercore'
import { checkedRunJson } from './runjson'
import { outPath, runDir } from './layout'
import { atomicWriteJson, serial } from './fsx'
import { agentInfo } from './policy'
import { planGates, verifyBody } from './verify'
import { writeVerdictFile } from './verdicts'
import { proposeFromCritic } from './rules/store'

// The other packages' functions reached from here (AB's verdict file, AD's
// store), through one table so tier 2 can stand in for them (COMMON,
// "Another package's module").
export const deps = {
  writeVerdictFile: (...a: Parameters<typeof writeVerdictFile>) => writeVerdictFile(...a),
  proposeFromCritic: (...a: Parameters<typeof proposeFromCritic>) => proposeFromCritic(...a),
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** An id that can name a file in one folder: no separator, no NUL, not `.` or `..`. */
export const safeFileName = (id: string): boolean =>
  id !== '' && id !== '.' && id !== '..' && id.length <= 200 && !id.includes('/') && !id.includes('\0')

const FOR_KEYS = ['verify_id', 'version', 'land_of', 'integrate_id'] as const

/**
 * Writes out/<agent_id>.json atomically, so output.sh reads the old file or
 * the new one. Throws on a file the script couldn't use: the caller answers
 * its record call only once this has resolved.
 */
export async function writeOut(p: Ports, litterDir: string, out: OutFile): Promise<void> {
  if (out.v !== 1) throw new Error(`output.writeOut: version ${String(out.v)}, not 1`)
  if (typeof out.agent_id !== 'string' || !safeFileName(out.agent_id)) {
    throw new Error(`output.writeOut: agent id ${JSON.stringify(out.agent_id)} can't name a file`)
  }
  if (!out.for || typeof out.for !== 'object') throw new Error("output.writeOut: 'for' is required")
  for (const [k, v] of Object.entries(out.for)) {
    if (!(FOR_KEYS as readonly string[]).includes(k) || typeof v !== 'string') throw new Error(`output.writeOut: 'for.${k}' isn't a known string key`)
  }
  if (!out.fields || typeof out.fields !== 'object' || Array.isArray(out.fields)) throw new Error("output.writeOut: 'fields' must be an object")
  await atomicWriteJson(p, outPath(litterDir, out.agent_id), out)
}

/**
 * The roles whose StructuredOutput result is a verdict the mod records for
 * them (the gate critic's prompt: "Your verdict is recorded from this
 * result"). The design critic records its own through the tool, and the
 * other roles' facts are in the records their calls made.
 */
const VERDICT_ROLES: readonly string[] = ['gate-critic', 'verifier']

/**
 * A design's roles whose result the mod records as `design.result` (decision
 * 15): the author's residual unknowns and user decisions, and the
 * reframer's candidates, are in no record their calls make. The other design
 * roles' facts are in their reports.
 */
const DESIGN_RESULT_ROLES: readonly string[] = ['author', 'reframer']

/**
 * `task.result` for an execute gate's executor (WP-AH): fanout's body with no
 * task, and the gate and attempt the mod placed the result at. The bridge
 * (repair.ts) and summary.md (execsummary.ts) read its `result.plan_gap`,
 * since a block writes no verdict.
 */
export type GateResultBody = TaskResultBody & { task: null; gate: string; attempt: number }

/**
 * Where an execute executor's result belongs: the first of the run's gates
 * with no land, and one past the highest attempt its verifies name.
 * execute.js runs one executor at a time, in the gates' order, numbering a
 * gate's attempts from 1 as its critic's verifies do, and that critic's
 * verify of this attempt comes from a record call that drains this line
 * first. Null when every gate has landed.
 */
function gateResultAt(json: RunJson, records: readonly StoredRecord[]): { gate: string; attempt: number } | null {
  const landed = new Set(records.filter(r => r.kind === 'land' && typeof r.body.gate === 'string').map(r => r.body.gate as string))
  const gate = (planGates(json) ?? []).find(g => !landed.has(g.id))?.id
  if (gate === undefined) return null
  let last = 0
  for (const r of records) {
    const v = verifyBody(r)
    if (v && v.gate === gate && Number.isSafeInteger(v.attempt) && v.attempt > last) last = v.attempt
  }
  return { gate, attempt: last + 1 }
}

/**
 * Spool consumer: a run agent's spooled result becomes its `verdict` record,
 * the body being the result as returned with its `tool_use_id` (a gate
 * critic's also its verdict file, AB's), and each of a gate critic's
 * `proposed_rules` a proposal through AD's proposeFromCritic (section 16.4).
 * A fanout writer's becomes its `task.result`, with the task from its latest
 * `task.bind` (null when unbound): integration reads it (fanout.js step 3).
 * An execute gate's executor's becomes its `task.result` too, at its gate
 * and attempt (gateResultAt). A design's author's and reframer's become its
 * `design.result` (decision 15), the author's without its `proposal`.
 * Recorded once per tool_use_id, so a line drained twice changes nothing. A
 * result from an agent the map doesn't know, or that contradicts it, is
 * logged and skipped.
 */
export const consumeOutput: SpoolConsumer = async (ctx, line) => {
  if (line.ev !== 'output') return
  const info = await agentInfo(ctx.p, line.agent_id)
  if (!info) {
    ctx.p.log(`output from agent ${line.agent_id} (${line.agent_type}), which has no start; not recorded`)
    return
  }
  if (info.agentType !== line.agent_type) {
    ctx.p.log(`output from agent ${line.agent_id} as ${line.agent_type} contradicts ${info.agentType}; not recorded`)
    return
  }
  const run = info.run
  if (!run || !info.role) return
  const writer = info.role === 'executor'
  const designResult = DESIGN_RESULT_ROLES.includes(info.role)
  if (!writer && !designResult && !VERDICT_ROLES.includes(info.role)) return
  const dir = runDir(ctx.litterDir, run)
  const input = line.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    ctx.p.log(`output from ${info.role} ${line.agent_id} (${line.tool_use_id}) carries no result; not recorded`)
    return
  }
  const by: Author = { source: 'agent', agentId: info.agentId, agentType: info.agentType }
  // The check for an earlier copy and the append must not interleave with another drain of this run.
  await serial(`output:${dir}`, async () => {
    const read = await readLedger(ctx.p, dir, run)
    const { records, tampered } = read
    if (tampered) {
      ctx.p.log(`output ${line.tool_use_id}: run ${run}'s ledger is tampered at ${tampered.seq}; not recorded`)
      return
    }
    // A spool this session drained can hold another host's lines (policy.ts, drainAllSpools).
    if ((await owned(ctx.p, dir, read)) !== 'mine') {
      ctx.p.log(`output ${line.tool_use_id}: ${elsewhere(run)}; not recorded`)
      return
    }
    // A writer's result is a fanout task's or an execute gate's; no other workflow runs one. An author or reframer runs only in a design.
    // Which, and an execute run's gates, from run.json as run.start wrote it (runjson.ts).
    let json: RunJson | undefined
    if (writer || designResult) {
      const c = await checkedRunJson(ctx.p, { run, runDir: dir }, read)
      if (!c.ok) {
        ctx.p.log(`output ${line.tool_use_id}: ${c.reason}; not recorded`)
        return
      }
      json = c.json
      if (writer && json.workflow !== 'fanout' && json.workflow !== 'execute') return
      if (designResult && json.workflow !== 'design') return
    }
    if (designResult) {
      if (records.some(r => r.kind === 'design.result' && r.body.tool_use_id === line.tool_use_id)) return
      // The author's text is proposals/<version>.md's, so its observed `proposal` isn't kept twice.
      const { proposal: _text, ...rest } = input
      const body: DesignResultBody = {
        role: info.role === 'author' ? 'author' : 'reframer',
        tool_use_id: line.tool_use_id,
        result: info.role === 'author' ? rest : input,
      }
      await appendRecord(ctx.p, dir, { run, kind: 'design.result', by, body })
      return
    }
    if (writer) {
      if (records.some(r => r.kind === 'task.result' && r.body.tool_use_id === line.tool_use_id)) return
      if (json!.workflow === 'execute') {
        const at = gateResultAt(json!, records)
        if (!at) {
          ctx.p.log(`output ${line.tool_use_id}: run ${run}'s executor returned after every gate landed; not recorded`)
          return
        }
        const result: GateResultBody = { task: null, role: 'executor', tool_use_id: line.tool_use_id, result: input, ...at }
        await appendRecord(ctx.p, dir, { run, kind: 'task.result', by, body: result })
        return
      }
      const bound = records.filter(r => r.kind === 'task.bind' && r.by.source === 'agent' && r.by.agentId === info.agentId).at(-1)
      const task = typeof bound?.body.task === 'string' ? bound.body.task : null
      const result: TaskResultBody = { task, role: 'executor', tool_use_id: line.tool_use_id, result: input }
      // Observed by output.sh, from the binding: the result can't claim another task's work.
      if (input.unbound === true) result.unbound = true
      if (typeof input.bind_refusal === 'string' && input.bind_refusal !== '') result.bind_refusal = input.bind_refusal
      await appendRecord(ctx.p, dir, { run, kind: 'task.result', by, body: result })
      return
    }
    const recorded = records.some(r => r.kind === 'verdict' && r.by.source === 'agent' && r.body.tool_use_id === line.tool_use_id)
    if (!recorded) {
      const rec = await appendRecord(ctx.p, dir, { run, kind: 'verdict', by, body: { ...input, tool_use_id: line.tool_use_id } })
      // Its file, verdicts/<gate>-<attempt>.md (AB's): an execute verdict's, so a gate critic's only.
      if (info.role === 'gate-critic') {
        await deps.writeVerdictFile(ctx.p, dir, rec).catch(err => ctx.p.log(`verdict ${run} seq ${rec.seq}: its file wasn't written: ${errText(err)}`))
      }
    }
    if (info.role !== 'gate-critic') return
    // Each proposal goes to the rules ledger (AD's store, decision 16), with the gate and
    // verify of the verify the verdict cites; the store records each once per tool_use_id and index.
    const cited = typeof input.verify_id === 'string' ? records.find(r => r.kind === 'verify' && r.body.verify_id === input.verify_id) : undefined
    const gate = typeof cited?.body.gate === 'string' ? cited.body.gate : undefined
    const proposed = Array.isArray(input.proposed_rules) ? input.proposed_rules : []
    for (let i = 0; i < proposed.length; i++) {
      const rule = proposed[i]
      if (typeof rule !== 'string' || rule.trim() === '') continue
      const proposal: CriticProposal = { run, rule, source: 'critic', by, index: i, tool_use_id: line.tool_use_id }
      if (gate !== undefined) proposal.gate = gate
      if (cited) proposal.verify_id = input.verify_id as string
      await deps.proposeFromCritic(ctx.p, ctx.litterDir, proposal).catch(err => ctx.p.log(`output ${line.tool_use_id}: proposed rule ${i} wasn't recorded: ${errText(err)}`))
    }
  })
}
