// One exported template string per role, ported from docs/litter-prompts.md.
// Owner: phase 1b, work package B. The static prompt checks (plan section 12)
// run over every export here: no backtick, no `${`, and the tags each names.

import type { RoleName } from '../hookfiles'

export const ROLE_PROMPTS: Partial<Record<RoleName, string>> = {}
