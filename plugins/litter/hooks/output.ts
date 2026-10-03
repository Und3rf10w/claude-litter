// Observed fields for StructuredOutput (plan section 9, "Observed facts beat
// claimed ones"). Owner: phase 1b, work package B.
//
// A handler that observed something an agent will return (a verify's exit code,
// a land's commit, a proposal's text) calls writeOut before it answers, so
// output.sh finds out/<agent_id>.json when the agent returns. consumeOutput
// records each spooled StructuredOutput result in the ledger, so a verdict
// needn't be recorded twice.

import type { Ports } from './ports'
import type { OutFile, SpoolConsumer } from './hookfiles'
import type { Author } from './records/core'
import type { RunJson } from './records/run'
import type { TaskResultBody } from './records/fanout'
import type { CriticProposal } from './records/rules'
import { appendRecord, readLedger } from './ledgercore'
import { outPath, runDir, runJsonPath } from './layout'
import { atomicWriteJson, readJson, serial } from './fsx'
import { agentInfo } from './policy'
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
 * Spool consumer: a run agent's spooled result becomes its `verdict` record,
 * the body being the result as returned with its `tool_use_id` (a gate
 * critic's also its verdict file, AB's), and each of a gate critic's
 * `proposed_rules` a proposal through AD's proposeFromCritic (section 16.4).
 * A fanout writer's becomes its `task.result`, with the task from its latest
 * `task.bind` (null when unbound): integration reads it (fanout.js step 3).
 * Recorded once per tool_use_id, so a line drained twice changes nothing. A
 * result from an agent the map doesn't know, or that contradicts it, is logged
 * and skipped.
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
  if (!writer && !VERDICT_ROLES.includes(info.role)) return
  const dir = runDir(ctx.litterDir, run)
  // An execute gate's executor has no result to record; only a fanout writer does.
  if (writer && (await readJson<RunJson>(ctx.p, runJsonPath(dir)).catch(() => undefined))?.workflow !== 'fanout') return
  const input = line.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    ctx.p.log(`output from ${info.role} ${line.agent_id} (${line.tool_use_id}) carries no result; not recorded`)
    return
  }
  const by: Author = { source: 'agent', agentId: info.agentId, agentType: info.agentType }
  // The check for an earlier copy and the append must not interleave with another drain of this run.
  await serial(`output:${dir}`, async () => {
    const { records, tampered } = await readLedger(ctx.p, dir, run)
    if (tampered) {
      ctx.p.log(`output ${line.tool_use_id}: run ${run}'s ledger is tampered at ${tampered.seq}; not recorded`)
      return
    }
    if (writer) {
      if (records.some(r => r.kind === 'task.result' && r.body.tool_use_id === line.tool_use_id)) return
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
