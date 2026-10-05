// A proposal's stored text: the author's prose, and for a plan its gates
// rendered after it in section 10's format (plan 7, step 6; COMMON decision
// 6). Owner: phase 4, WP-BC. WP-BA's stub renders no gates.

import type { AuthorGate } from '../records/design'
import type { Deliverable } from '../records/run'

export type RenderedProposal = { ok: true; text: string } | { ok: false; error: string; field: string }

/**
 * The bytes `proposals/vN.md` holds for a proposal of `deliverable`: the
 * prose, then for a plan `## Gates` and each gate's section through
 * renderGateSection, read back whole by parseGates. A refusal names the
 * field, `gates` or `gates[i].<field>`, and what to fix.
 *
 * Stub (WP-BA): with no gates (none, or an empty list) the text comes back
 * unchanged; any gate is refused, since rendering isn't built yet.
 */
export function renderProposal(text: string, gates: AuthorGate[] | undefined, deliverable: Deliverable): RenderedProposal {
  if (gates === undefined || gates.length === 0) return { ok: true, text }
  return { ok: false, error: `litter: a ${deliverable} proposal's gates aren't rendered yet (not built yet); record the text without them`, field: 'gates' }
}
