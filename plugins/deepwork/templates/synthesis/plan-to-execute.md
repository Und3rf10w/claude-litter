# Plan-to-Execute Synthesis Template

**Kind**: plan-to-execute
**Invocation**: `/deepwork --kind plan-to-execute "..."` or default (no `--kind` flag)
**Mode**: plan mode deliverable; OPTIONAL execute-mode consumer via `/deepwork --mode execute --plan-ref <path>`

This is the default deepwork output kind — the same format the plugin has always produced. Existing archived sessions without a `kind` field render as plan-to-execute. Backward-compatible default.

---

## Template Structure for `proposals/v<N>.md`

SYNTHESIZE phase writes `proposals/v<N>.md` using this structure.

The `## Execution Manifest` section is **OPTIONAL**. Execute mode can consume any plan format and will extract an internal manifest in its SETUP phase via prose extraction if this section is absent. Include it when the plan is sufficiently detailed and the implementer wants to give execute mode explicit gate-level structure rather than relying on SETUP-phase extraction.

---

```markdown
# <Plan Title>

**Session**: <instance_id>
**Date**: <ISO date>
**Deliverable kind**: plan-to-execute
**Execute-mode ready**: yes | partial | no
  (yes = has Execution Manifest section; partial = prose plan, execute mode can extract; no = research/design output not yet implementation-ready)

---

## Problem Statement

<What problem is being solved. Why it matters. What success looks like.>

---

## Context

<Background the implementer needs. Existing system state. Constraints that shaped the design. Key decisions that were explicitly considered and rejected (with reasons).>

---

## Proposed Solution

<The design. How it works. Key components and their responsibilities. File-level or module-level breakdown.>

---

## Key Decisions and Rejected Alternatives

| Decision | Alternative considered | Why rejected |
|---|---|---|

---

## Residual Unknowns

<Things that are still open after this plan. Default-off opt-ins. Future-version items. Explicitly bounded — not a dumping ground.>

| ID | Description | Why it's residual | How to resolve |
|---|---|---|---|
| RU1 | | | |

---

## Execution Manifest

> **OPTIONAL** — include when providing explicit gate-level structure for execute mode. Omit if the prose plan is sufficient and execute mode SETUP should extract it.

```yaml
# execution_manifest — consumed by execute mode SETUP phase
# Format: one entry per implementation gate. Fields:
#   gate_id: stable identifier (used in execute mode change_log, bar, task IDs)
#   plan_section: section heading in THIS document (used for plan-citation enforcement)
#   files: list of file paths the gate touches (used by scope-guard + PreToolUse plan-citation gate)
#   tests: test identifiers or test file patterns that must pass for this gate (used by auditor + test_manifest)
#   environments: declared environments the tests must pass in (used by auditor env_attestations)
#   rollback: brief rollback description or "not applicable" (used by bash-gate.sh rollback-plan check)

gates:
  - gate_id: G-exec-1
    plan_section: "## Proposed Solution"
    files:
      - src/example.ts
    tests:
      - "npm test -- --testPathPattern=example"
    environments:
      - local
      - ci
    rollback: "revert src/example.ts to prior state"

  # Add one entry per gate...
```
```

---

## CRITIC Bar Skeleton

```json
[
  {
    "id": "G1",
    "criterion": "The proposed solution achieves the stated goal — there is a traceable path from inputs to outputs",
    "evidence_required": "proposals/v<N>.md §Proposed Solution: describes mechanism that, given the problem inputs, produces the stated success outputs",
    "categorical_ban": false
  },
  {
    "id": "G2",
    "criterion": "Each key decision has an explicitly-named alternative and a reason for rejection",
    "evidence_required": "§Key Decisions and Rejected Alternatives table is non-empty; no decision is listed without an alternative column entry",
    "categorical_ban": false
  },
  {
    "id": "G3",
    "criterion": "Residual unknowns are bounded — each has a 'how to resolve' path, not just a description",
    "evidence_required": "§Residual Unknowns table: no entry with 'how to resolve' = '(unknown)' or blank",
    "categorical_ban": false
  },
  {
    "id": "G4",
    "criterion": "If Execution Manifest is present, every gate_id maps to a named plan_section in this document",
    "evidence_required": "Each gate.plan_section in execution_manifest matches a heading present in this proposal",
    "categorical_ban": false
  },
  {
    "id": "G5",
    "criterion": "Plan is self-contained — a reader with no prior context can understand the problem, constraints, and proposed solution",
    "evidence_required": "§Problem Statement and §Context provide sufficient background; no unexplained abbreviations or acronyms without definition on first use",
    "categorical_ban": false
  },
  {
    "id": "G6",
    "criterion": "No secret or credential material in any section, including code snippets",
    "evidence_required": "Review of all code blocks and example values for API keys, passwords, tokens, or similar",
    "categorical_ban": true
  }
]
```
```

---

## Notes for SYNTHESIZE phase

- `state.kind = "plan-to-execute"` or `state.kind = null` (default) triggers this template.
- After SYNTHESIZE completes, the user may invoke execute mode: `/deepwork --mode execute --plan-ref .claude/deepwork/<id>/proposals/v<N>-final.md`
- The `execute-mode ready` field in the proposal header is informational — execute mode can consume any plan format.
- The Execution Manifest section is consumed directly by execute mode SETUP if present; otherwise SETUP extracts an internal manifest from prose.
- Fallback behavior: if this template file is absent, SYNTHESIZE phase writes a plan in its current format (§9.4 degrade path).
