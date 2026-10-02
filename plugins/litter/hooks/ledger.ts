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
import { notYet } from './records/core'
import { KIND_HANDLERS } from './registry'

/** Registered at session.start as `mcp__litter__record`. */
export const RECORD_TOOL: ToolSpec = {
  name: 'record',
  description:
    'litter: record a step of a litter run. Only litter workflows and the litter skills call this; ' +
    'the kind and its fields are named in your instructions.',
  inputSchema: { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'] },
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

/** tool.call on `mcp__litter__record`: dispatches the kind to its handler in KIND_HANDLERS. */
export const recordTool: PortHook<RecordHook> = async () => {
  void KIND_HANDLERS
  return { result: JSON.stringify(notYet('record', '1b')) }
}

/** The catch for recordTool: an error result naming the hook (plan section 9, refusal table). */
export const recordFailed: RecordCatch = async () => ({
  deny: 'litter guard failed: mcp__litter__record; refusing',
})
