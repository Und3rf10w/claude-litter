// mcp__litter__record: the record tool (plan section 9, "Ledger"). Owner:
// phase 1b, work package B.
//
// The tool is answered in its tool.call hook, never through next(e). This file
// owns the tool's spec and the dispatcher (kind matched case-insensitively,
// caller identity, mod-only kinds, bounds, the error shape). Each kind is
// dispatched to its owner through registry.ts; the kinds the tool validates
// itself are in records/design.ts. Storage is ledgercore.ts.

import type { ToolSpec } from 'claude-code'
import type { PortHook, RecordCatch, RecordHook } from './hooktypes'
import type { Ports } from './ports'
import type { LitterOptions } from './options'
import type { Caller, RecordCtx, RecordError, RecordInput, RecordReply } from './records/core'
import type { KindRule, KnownKind } from './records/design'
import type { AgentInfo } from './policy'
import type { SwarmGateCall } from './swarm/gate'
import { fail, RECORD_MAX_BYTES } from './records/core'
import { KIND_RULES, KNOWN_KINDS, MOD_ONLY_KINDS, USER_ONLY_KINDS } from './records/design'
import { KIND_HANDLERS, SPOOL_CONSUMERS } from './registry'
import { elsewhere, LedgerNotOwned, LedgerTampered, owned, readLedger, RecordTooLarge } from './ledgercore'
import { NotOnCodex } from './ledgerowner'
import { agentInfo, drainOwnSpools } from './policy'
import { RUN_ID, runDir, runJsonPath } from './layout'
import { getOptions, session } from './session'
import { binding, ready as swarmReady } from './swarm/state'
import { isSwarmGateKind, swarmGateRecord } from './swarm/gate'

type FieldType = 'strings' | 'objects' | 'texts or objects' | 'object' | 'boolean' | 'integer'

/**
 * The fields of any kind whose value isn't a string. A model sends a field the
 * schema doesn't declare as a string, so a list arrives JSON-encoded (tier 4,
 * live). Each is declared in the schema, and a string holding the JSON of its
 * type is decoded before the checks.
 */
const STRUCTURED: Readonly<Record<string, FieldType>> = {
  authorized: 'strings',
  verify: 'strings',
  goalCheck: 'strings',
  setup: 'strings',
  runRules: 'strings',
  linkDirs: 'strings',
  mergeOrder: 'strings',
  // Phase 4 (decision 3): each { question, smallest_test, kill_result }, or a bare question.
  empiricalUnknowns: 'texts or objects',
  anchors: 'strings',
  tasks: 'objects',
  bar: 'objects',
  lenses: 'objects',
  gates: 'objects',
  criteria: 'objects',
  amendOf: 'object',
  adversary: 'boolean',
  isolate: 'boolean',
  carryOver: 'boolean',
  maxAttempts: 'integer',
  maxRounds: 'integer',
  attempt: 'integer',
  // 2b-2: run.start's repair override, a swarm verdict's proposals, repair.budget's request.
  repairRounds: 'integer',
  repairAgents: 'integer',
  proposed_rules: 'strings',
  rounds: 'integer',
  agents: 'integer',
  // Phase 3: a plan-template critic's verdict (execute's VERDICT, through the
  // tool), rule.propose's paths, rule.open's proposal, rule.find's applicable.
  // rule.find's `status` list isn't declared: run.end's `status` is a string,
  // so its handler decodes it.
  plan_adherence: 'object',
  tests_green: 'object',
  no_regressions: 'object',
  rules: 'object',
  paths: 'strings',
  proposal: 'object',
  applicable: 'object',
  // WP-AO: gate.widen's files, run.start's widenings, a plan-template critic's widened.
  files: 'strings',
  widenings: 'objects',
  widened: 'objects',
  // Design D9: run.find's opt-in for the configured options.
  options: 'boolean',
}

const SCHEMA_OF: Readonly<Record<FieldType, Record<string, unknown>>> = {
  strings: { type: 'array', items: { type: 'string' } },
  objects: { type: 'array', items: { type: 'object' } },
  'texts or objects': { type: 'array', items: { anyOf: [{ type: 'string' }, { type: 'object' }] } },
  object: { type: 'object' },
  boolean: { type: 'boolean' },
  integer: { type: 'integer' },
}

const hasType = (v: unknown, t: FieldType): boolean =>
  t === 'strings' || t === 'objects' || t === 'texts or objects'
    ? Array.isArray(v)
    : t === 'object'
      ? typeof v === 'object' && v !== null && !Array.isArray(v)
      : t === 'boolean'
        ? typeof v === 'boolean'
        : Number.isInteger(v)

/** A structured field sent as a string of its JSON, decoded; anything else unchanged, for the handler to judge. */
function decodeField(name: string, v: unknown): unknown {
  const t = STRUCTURED[name]
  if (t === undefined || typeof v !== 'string') return v
  try {
    const parsed: unknown = JSON.parse(v)
    return hasType(parsed, t) ? parsed : v
  } catch {
    return v
  }
}

/** Registered at session.start as `mcp__litter__record`. */
export const RECORD_TOOL: ToolSpec = {
  name: 'record',
  description:
    'litter: record a step of a litter run. Only litter workflows and the litter skills call this; ' +
    'the kind and its fields are named in your instructions. A rejected record names the field to fix ' +
    'and, where there is a fixed set, the allowed values: fix exactly that and call again.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', description: 'The record kind your instructions name, such as finding, verify or run.start.' },
      run: {
        type: 'string',
        description: "The run id (<yyyymmdd>-<slug>). A run's agents leave it out: litter knows their run.",
      },
      ...Object.fromEntries(Object.entries(STRUCTURED).map(([name, t]) => [name, SCHEMA_OF[t]])),
    },
    required: ['kind'],
    additionalProperties: true,
  },
}

/**
 * Registers the record tool. Resolves null, or the refusal's text when the
 * engine refused it (managed allowedMcpServers: plan section 9, "Fail closed").
 */
export async function registerRecordTool(p: Ports): Promise<string | null> {
  try {
    await p.registerTool(RECORD_TOOL)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

/** What the dispatcher needs from the session (session.ts); tier 2 passes its own. */
export type DispatchEnv = {
  litterDir: string | null
  litterDirError: string | null
  ready: boolean
  options: LitterOptions
}

/** tool.call's own keys beside the tool's arguments (d.ts ToolCallReserved, AgentLoop): never part of a record. */
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'consent'])

const bytes = (text: string) => new TextEncoder().encode(text).length

const callerMay = (rule: KindRule, agent: boolean) => rule.by === 'any' || rule.by === (agent ? 'agent' : 'launcher')

/** An executor of a fanout run with no task.bind of its own yet: it may record only task.bind. */
async function unboundWriter(p: Ports, litterDir: string, run: string, agentId: string): Promise<boolean> {
  const dir = runDir(litterDir, run)
  const { records } = await readLedger(p, dir, run)
  // The workflow from run.start, chained in the ledger: run.json may have been changed since.
  if (records.find(r => r.kind === 'run.start')?.body.workflow !== 'fanout') return false
  return !records.some(r => r.kind === 'task.bind' && r.by.source === 'agent' && r.by.agentId === agentId)
}

/** The kinds this caller may record, for an error's `allowed`. */
const allowedFor = (agent: boolean): KnownKind[] => KNOWN_KINDS.filter(k => callerMay(KIND_RULES[k], agent))

/** The top-level field with the longest JSON, to name in a too-large error. */
function largestField(input: Record<string, unknown>): string | undefined {
  let best: string | undefined
  let size = -1
  for (const [k, v] of Object.entries(input)) {
    const n = JSON.stringify(v ?? null).length
    if (n > size) {
      size = n
      best = k
    }
  }
  return best
}

/**
 * The record tool's checks, in order, then the kind's handler (section 9,
 * "Ledger"): the kind, who may record it, the run, the bounds. Every refusal
 * names the field and, where there's a fixed set, the allowed values
 * ("Errors are recoverable"). A handler's other failures throw, so the hook's
 * catch denies the call.
 */
export async function dispatchRecord(
  p: Ports,
  agentId: string | undefined,
  raw: Readonly<Record<string, unknown>>,
  env: DispatchEnv,
): Promise<RecordReply> {
  const fields: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(raw)) if (!RESERVED.has(k)) fields[k] = decodeField(k, v)
  const isAgent = typeof agentId === 'string' && agentId !== ''

  // The kind, matched case-insensitively ("some models misname parameters").
  const given = fields.kind
  if (typeof given !== 'string' || given.trim() === '') {
    return fail("litter: 'kind' is required: the record kind your instructions name", 'kind', allowedFor(isAgent))
  }
  const lower = given.trim().toLowerCase()
  if ((USER_ONLY_KINDS as readonly string[]).includes(lower)) {
    return fail(
      `litter: '${lower}' is the user's alone, in the rules pane (/litter rules); a tool call can only propose a rule or open one in the pane`,
      'kind',
      ['rule.propose', 'rule.open'],
    )
  }
  // A rules-ledger kind only the mod writes (16.7): no run's kind, so it isn't in KIND_RULES.
  if (lower === 'rule.export') return fail("litter: 'rule.export' is recorded by litter itself, never through this tool", 'kind', allowedFor(isAgent))
  const kind = KNOWN_KINDS.find(k => k.toLowerCase() === lower)
  if (!kind) return fail(`litter: '${given}' isn't a record kind`, 'kind', allowedFor(isAgent))
  const rule = KIND_RULES[kind]
  if (rule.by === 'mod' || MOD_ONLY_KINDS.includes(kind)) {
    return fail(`litter: '${kind}' is recorded by litter itself, never through this tool`, 'kind', allowedFor(isAgent))
  }

  // The spool first, at every record call (section 9, "Draining"): an agent the
  // map doesn't know yet may only be waiting there, and a mode switch or a
  // stop spooled before this call is acted on before it.
  if (env.litterDir) await drainOwnSpools(p, env.litterDir, SPOOL_CONSUMERS)
  // Who's calling.
  const info: AgentInfo | undefined = isAgent ? await agentInfo(p, agentId) : undefined
  const caller: Caller = isAgent ? { agentId, agentType: info?.agentType ?? null } : { agentId: null, agentType: null }
  if (!callerMay(rule, isAgent)) {
    return fail(
      isAgent
        ? `litter: '${kind}' is recorded from the main thread by a litter skill, not by an agent`
        : `litter: '${kind}' is recorded by a litter run's agents, not from the main thread`,
      'kind',
      allowedFor(isAgent),
    )
  }
  if (!env.litterDir) {
    return fail(
      env.ready
        ? (env.litterDirError ?? "litter: this session has no litter directory, so nothing can be recorded")
        : 'litter: the session is still starting; call again in a moment',
    )
  }
  const litterDir = env.litterDir
  const input: RecordInput = { ...fields, kind }

  // The run: an agent's from the agent map, never from its input; a launcher's from its input.
  const agentRun = info?.role && typeof info.run === 'string' ? info.run : null
  // A fanout writer records task.bind before anything else (section 7, fanout.js step 2).
  if (isAgent && kind !== 'task.bind' && info?.role === 'executor' && agentRun !== null && (await unboundWriter(p, litterDir, agentRun, agentId))) {
    return fail('litter: bind first: record kind task.bind with the bind value from your <task>', 'kind', ['task.bind'])
  }
  // A bound swarm node's verify, verdict and land are its swarm's gates (2b-2):
  // swarm/gate.ts records them in the run the swarm repairs, never the run
  // the input names. A run agent's go on below, by the agent map. The
  // bindings are read once recovery has put them back (the state's gate).
  if (isAgent && agentRun === null && isSwarmGateKind(kind)) {
    await swarmReady(p)
    const node = binding(agentId)
    if (node) {
      const big = overBound(input)
      if (big) return big
      const call: SwarmGateCall = { kind, input, caller: { agentId, agentType: caller.agentType }, binding: node, litterDir, options: env.options }
      return answer(kind, input.run, () => swarmGateRecord(p, call))
    }
  }
  if (rule.run !== 'none') {
    if (agentRun !== null) {
      if (input.run !== undefined && input.run !== agentRun) {
        return fail(`litter: 'run' is your run, ${agentRun}; leave it out`, 'run', [agentRun])
      }
      input.run = agentRun
    } else if (isAgent && rule.by === 'agent') {
      return fail(
        `litter: '${kind}' is recorded by a litter run's agents, and this agent (${caller.agentType ?? 'not started through a litter run'}) isn't one`,
      )
    } else if (input.run !== undefined || rule.run === 'required') {
      if (typeof input.run !== 'string' || !RUN_ID.test(input.run)) {
        return fail("litter: 'run' is required: the run id, <yyyymmdd>-<slug>, as run.start or run.find returned it", 'run')
      }
      if (!(await p.fs.exists(runJsonPath(runDir(litterDir, input.run))))) {
        return fail(`litter: there's no run ${input.run} in ${litterDir}; run.find lists the runs`, 'run')
      }
    }
    // A broken chain stops the run's records before the handler does any work (section 9, "Chained"), and so
    // does another store's run (plan.write would write its file first). run.end's handler asks about a run with
    // no head here; a rule.propose only names its run.
    if (typeof input.run === 'string') {
      const dir = runDir(litterDir, input.run)
      const read = await readLedger(p, dir, input.run)
      if (read.tampered) {
        return fail(`litter: run ${input.run}'s ledger is tampered at record ${read.tampered.seq} (${read.tampered.reason}); nothing more is recorded for it`, 'run')
      }
      if (kind !== 'run.end' && kind !== 'rule.propose' && (await owned(p, dir, read)) !== 'mine') {
        return fail(`litter: ${elsewhere(input.run)}; nothing is recorded for it here`, 'run')
      }
    }
  }

  const big = overBound(input)
  if (big) return big
  const ctx: RecordCtx = { p, caller, litterDir, options: env.options }
  return answer(kind, input.run, () => KIND_HANDLERS[kind](ctx, input))
}

/** Bounded before anything is written (section 9, "Every record is bounded"). */
function overBound(input: RecordInput): RecordError | null {
  const size = bytes(JSON.stringify(input))
  if (size <= RECORD_MAX_BYTES) return null
  const field = largestField(input)
  return fail(`litter: the record is ${size} bytes, over the ${RECORD_MAX_BYTES}-byte limit; cut '${field}' down and record again`, field)
}

/**
 * A handler's reply, with the ledger's own refusals in the error shape. Its
 * other failures throw, so the hook's catch denies the call; so does a reply
 * that isn't one.
 */
async function answer(kind: KnownKind, run: unknown, handle: () => Promise<RecordReply>): Promise<RecordReply> {
  let reply: RecordReply
  try {
    reply = await handle()
  } catch (err) {
    if (err instanceof RecordTooLarge) return fail(`litter: ${err.message}; cut it down and record again`, err.field ?? undefined)
    if (err instanceof LedgerTampered) {
      return fail(`litter: ${typeof run === 'string' ? `run ${run}'s ` : 'the run '}${err.message}; nothing more is recorded for it`, 'run')
    }
    if (err instanceof LedgerNotOwned || err instanceof NotOnCodex) return fail(`litter: ${err.message}`)
    throw err
  }
  if (!reply || typeof reply !== 'object' || typeof (reply as { ok?: unknown }).ok !== 'boolean') {
    throw new Error(`the ${kind} handler gave no reply`)
  }
  return reply
}

/** tool.call on `mcp__litter__record`: dispatches the kind to its handler in KIND_HANDLERS. */
export const recordTool: PortHook<RecordHook> = async (p, e) => {
  const s = session()
  const reply = await dispatchRecord(p, e.agentId, e as unknown as Record<string, unknown>, {
    litterDir: s.litterDir,
    litterDirError: s.litterDirError,
    ready: s.ready,
    options: getOptions(),
  })
  return { result: JSON.stringify(reply) }
}

/** The catch for recordTool: an error result naming the hook (plan section 9, refusal table). */
export const recordFailed: RecordCatch = async ($, e, next) => {
  const why = typeof next.error?.message === 'string' ? next.error.message.replace(/\s+/g, ' ').slice(0, 300) : (next.error?.kind ?? 'unknown')
  return { deny: `litter guard failed: mcp__litter__record (${why}); refusing` }
}
