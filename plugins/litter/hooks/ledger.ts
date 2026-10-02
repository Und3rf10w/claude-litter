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
import type { Caller, RecordCtx, RecordInput, RecordReply } from './records/core'
import type { KindRule, KnownKind } from './records/design'
import type { AgentInfo } from './policy'
import { fail, RECORD_MAX_BYTES } from './records/core'
import { KIND_RULES, KNOWN_KINDS, MOD_ONLY_KINDS, USER_ONLY_KINDS } from './records/design'
import { KIND_HANDLERS, SPOOL_CONSUMERS } from './registry'
import { LedgerTampered, readLedger, RecordTooLarge } from './ledgercore'
import { agentInfo, drainOwnSpools } from './policy'
import { RUN_ID, runDir, runJsonPath } from './layout'
import { getOptions, session } from './session'

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
    },
    required: ['kind'],
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
  for (const [k, v] of Object.entries(raw)) if (!RESERVED.has(k)) fields[k] = v
  const isAgent = typeof agentId === 'string' && agentId !== ''

  // The kind, matched case-insensitively ("some models misname parameters").
  const given = fields.kind
  if (typeof given !== 'string' || given.trim() === '') {
    return fail("litter: 'kind' is required: the record kind your instructions name", 'kind', allowedFor(isAgent))
  }
  const lower = given.trim().toLowerCase()
  if ((USER_ONLY_KINDS as readonly string[]).includes(lower)) {
    return fail(
      `litter: '${lower}' is the user's alone, in the rules pane (/litter:rules); a tool call can only propose a rule`,
      'kind',
      ['rule.propose'],
    )
  }
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
    // A broken chain stops the run's records before the handler does any work (section 9, "Chained").
    if (typeof input.run === 'string') {
      const { tampered } = await readLedger(p, runDir(litterDir, input.run), input.run)
      if (tampered) {
        return fail(`litter: run ${input.run}'s ledger is tampered at record ${tampered.seq} (${tampered.reason}); nothing more is recorded for it`, 'run')
      }
    }
  }

  // Bounded before anything is written (section 9, "Every record is bounded").
  const size = bytes(JSON.stringify(input))
  if (size > RECORD_MAX_BYTES) {
    const field = largestField(input)
    return fail(`litter: the record is ${size} bytes, over the ${RECORD_MAX_BYTES}-byte limit; cut '${field}' down and record again`, field)
  }

  const ctx: RecordCtx = { p, caller, litterDir, options: env.options }
  let reply: RecordReply
  try {
    reply = await KIND_HANDLERS[kind](ctx, input)
  } catch (err) {
    if (err instanceof RecordTooLarge) return fail(`litter: ${err.message}; cut it down and record again`, err.field ?? undefined)
    if (err instanceof LedgerTampered) return fail(`litter: run ${String(input.run)}'s ${err.message}; nothing more is recorded for it`, 'run')
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
