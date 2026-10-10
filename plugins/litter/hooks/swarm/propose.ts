// WP-J: the lead's mcp__litter__swarm_propose (plan 15.4, "The swarm tools";
// 15.5, "Asking the lead"): the input, then validateSpec with the
// proposal's briefs over its base revision's, then the staged proposal and
// its diff's counts, or every error with its field and nothing written. The
// mod checks it all itself: the d.ts doesn't promise the engine checks a mod
// tool's inputSchema.
//
// Owner: phase 2b-1, package J. The stub's signature is the contract.

import type { Ports } from '../ports'
import type { PortHook, SwarmProposeHook } from '../hooktypes'
import type { ProposedChange, SwarmProposeReply } from '../records/swarm'
import type { SpecError, SwarmSpec } from './types'
import { RecordTooLarge } from '../ledgercore'
import { NotOnCodex } from '../ledgerowner'
import { NODE_ID, SWARM_NAME } from '../layout'
import { session } from '../session'
import { binding, noteProposal } from './state'
import { decodeSwarmInput, SWARM_PROPOSE } from './tools'
import { parseSpec, validateCtxFor, validateSpec } from './spec'
import { readRevision, specState, stageProposal } from './store'

const INPUT_KEYS = ['swarm', 'baseRevision', 'spec', 'briefs', 'changes'] as const
const CHANGES_MAX = 200
const PATH_MAX = 300
const REASON_MAX = 1000

type Raw = Record<string, unknown>
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const oneLine = (s: string): boolean => !/[\0\r\n]/.test(s)

/** The proposal's answer, as the tool returns it in `result`. */
export async function proposeSwarm(p: Ports, agentId: string | undefined, raw: Readonly<Record<string, unknown>>): Promise<SwarmProposeReply> {
  if (typeof agentId === 'string' && agentId !== '') {
    const b = binding(agentId)
    return {
      ok: false,
      error: b
        ? `litter: swarm_propose is the lead's alone; node ${b.node} of swarm ${b.swarm} (${agentId}) can't call it. Report the change you'd make to your parent instead`
        : `litter: swarm_propose is the lead's alone, from the litter swarm skill; agent ${agentId} can't call it`,
    }
  }
  const s = session()
  if (s.swarmToolsRefused) {
    return { ok: false, error: `litter: the swarm tools were refused (${s.swarmToolsRefused}), so no swarm can be proposed; a managed allowedMcpServers setting can refuse them` }
  }
  const litterDir = s.litterDir
  if (!litterDir) return { ok: false, error: `litter: no litter directory, so nothing can be proposed: ${s.litterDirError ?? "the session hasn't resolved one yet"}` }

  const input = decodeSwarmInput(SWARM_PROPOSE, raw)
  const errors: SpecError[] = []
  const err = (field: string, error: string, node?: string): void => void errors.push({ field, ...(node !== undefined ? { node } : {}), error })
  for (const k of Object.keys(input)) {
    if (!(INPUT_KEYS as readonly string[]).includes(k)) err(k, `unknown field '${k}'; swarm_propose takes swarm, baseRevision, spec, briefs and changes`)
  }

  const swarm = input.swarm
  if (typeof swarm !== 'string' || !SWARM_NAME.test(swarm)) {
    err('swarm', "swarm is required: the swarm's name, lowercase letters, digits and dashes, at most 24 characters")
  }
  const base = input.baseRevision
  const baseOk = Number.isSafeInteger(base) && (base as number) >= 0
  if (!baseOk) err('baseRevision', 'baseRevision is required: the draft revision the request named, or 0 for a new swarm')
  const spec = input.spec
  if (!isObj(spec)) err('spec', 'spec is required: the whole swarm spec as an object, with name, goal and nodes')

  const briefs: Record<string, string> = {}
  if (input.briefs !== undefined) {
    if (!isObj(input.briefs)) err('briefs', "briefs must map node ids to each new or changed brief's full text")
    else {
      for (const [k, v] of Object.entries(input.briefs)) {
        if (typeof v === 'string') briefs[k] = v
        else err(`briefs.${k}`, "each brief is the node's brief as Markdown text")
      }
    }
  }

  const changes: ProposedChange[] = []
  if (!Array.isArray(input.changes)) err('changes', 'changes is required: one { path, reason } per change, for the user to accept or reject')
  else {
    if (input.changes.length > CHANGES_MAX) err('changes', `at most ${CHANGES_MAX} changes; group the small ones under their node's path`)
    input.changes.slice(0, CHANGES_MAX).forEach((c, i) => {
      const keys = isObj(c) ? Object.keys(c).filter(k => k !== 'path' && k !== 'reason') : []
      if (!isObj(c)) return err(`changes[${i}]`, 'each change is { path, reason }')
      if (keys.length > 0) err(`changes[${i}].${keys[0]}`, `unknown field '${keys[0]}'; a change is { path, reason }`)
      const okPath = typeof c.path === 'string' && c.path.trim() !== '' && oneLine(c.path) && c.path.length <= PATH_MAX
      const okReason = typeof c.reason === 'string' && c.reason.trim() !== '' && c.reason.length <= REASON_MAX
      if (!okPath) err(`changes[${i}].path`, `path is the field the change makes, as nodes.<id>.<field> or brief:<id>, on one line, at most ${PATH_MAX} characters`)
      if (!okReason) err(`changes[${i}].reason`, `reason is why, for the user, at most ${REASON_MAX} characters`)
      if (okPath && okReason) changes.push({ path: c.path as string, reason: c.reason as string })
    })
  }
  if (typeof swarm !== 'string' || !SWARM_NAME.test(swarm)) return { ok: false, errors }

  // The base: the draft's revision, or a saved one (0 only while nothing's saved, or the draft starts from nothing).
  const st = await specState(p, litterDir, swarm)
  if (st.tampered) return { ok: false, error: `litter: swarm ${swarm}'s spec ledger is tampered at record ${st.tampered.seq} (${st.tampered.reason}); nothing more is written to it` }
  if (baseOk) {
    const b = base as number
    const known = b === st.draftBase || (b >= 1 && b <= st.latest) || (b === 0 && st.latest === 0)
    if (!known) {
      const has = [
        st.draftBase !== null ? `the draft is at revision ${st.draftBase}` : null,
        st.latest > 0 ? `the saved revisions are 1 to ${st.latest}` : 'nothing is saved yet, so a new swarm is revision 0',
      ].filter(Boolean)
      err('baseRevision', `revision ${b} isn't this swarm's draft revision or a saved one (${has.join('; ')}); read it with swarm_read (draft: true) and propose over its revision`)
    }
  }

  // Each brief is a node's that names one.
  const nodes = isObj(spec) ? (parseSpec(spec).spec?.nodes ?? []) : []
  for (const k of Object.keys(briefs)) {
    const n = nodes.find(x => x.id === k)
    if (!NODE_ID.test(k)) err(`briefs.${k}`, `'${k}' isn't a node id`)
    else if (!n) err(`briefs.${k}`, `the spec has no node '${k}'; drop this brief, or add the node`, k)
    else if (n.brief === undefined) err(`briefs.${k}`, `node ${k} names no brief; set nodes.${k}.brief to 'briefs/${k}.md', or drop this brief`, k)
  }
  if (isObj(spec) && typeof spec.name === 'string' && SWARM_NAME.test(spec.name) && spec.name !== swarm) {
    err('name', `the spec is named '${spec.name}', but the proposal is for swarm '${swarm}'; a spec's name is its swarm's`)
  }

  // Then the spec's schema and every 15.3 rule, with briefs from the proposal first and its base revision second.
  if (isObj(spec)) {
    const baseBriefs = baseOk && (base as number) >= 1 ? ((await readRevision(p, litterDir, swarm, base as number))?.briefs ?? {}) : {}
    const ctx = await validateCtxFor(p, litterDir, async node =>
      Object.hasOwn(briefs, node) ? briefs[node]! : Object.hasOwn(baseBriefs, node) ? baseBriefs[node]! : null,
    )
    errors.push(...(await validateSpec(p, spec, ctx)).errors)
  }
  if (errors.length > 0) return { ok: false, errors }

  try {
    const staged = await stageProposal(p, litterDir, swarm, { baseRevision: base as number, spec: spec as unknown as SwarmSpec, briefs, changes })
    noteProposal(swarm, staged.n)
    return { ok: true, proposal: staged.n, diff: staged.diff }
  } catch (e) {
    if (e instanceof RecordTooLarge) {
      return { ok: false, errors: [{ field: e.field ?? 'spec', error: `the proposal's record would be ${Math.ceil(e.bytes / 1024)} KiB, over 1 MiB; make it smaller` }] }
    }
    if (e instanceof NotOnCodex) return { ok: false, errors: [{ field: 'swarm', error: e.message }] }
    throw e
  }
}

/** tool.call on `mcp__litter__swarm_propose`: answered here, never passed on. Its input through tools.ts's decodeSwarmInput. */
export const swarmProposeTool: PortHook<SwarmProposeHook> = async (p, e) => {
  const reply = await proposeSwarm(p, e.agentId, e as unknown as Record<string, unknown>)
  return { result: JSON.stringify(reply) }
}
