// Import from deepwork (16.8; COMMON decision 3): every live and archived
// instance's guardrails, merged with its incidents as deepwork's
// render_guardrails merges them. Owner: phase 3, package AD.
//
// AA's stub: it throws.

import type { Ports } from '../ports'
import type { ImportBatch } from '../records/rules'

/**
 * Reads `<primary>/.claude/deepwork/<instance>/state.json` (else
 * `state.archived.json`) and the `incidents.jsonl` beside it, for every
 * instance. Nothing here is proposed or accepted: records.ts's
 * recordRuleImport proposes what it returns.
 */
export async function readDeepwork(p: Ports, primary: string): Promise<ImportBatch> {
  throw new Error(`rules/import: readDeepwork isn't built yet (phase 3, package AD), for ${primary}`)
}
