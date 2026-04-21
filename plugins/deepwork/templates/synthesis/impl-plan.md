# Impl-Plan Synthesis Template

**Kind**: impl-plan
**Invocation**: `/deepwork --kind impl-plan "..."`
**Mode**: plan mode deliverable; signals execute-mode consumer — user invokes `/deepwork --mode execute --plan-ref <path>` after SYNTHESIZE completes

`impl-plan` is structurally identical to `plan-to-execute` with two differences:
1. The `execute-mode ready` header field defaults to `yes` (not `partial`) — impl-plan kind signals the plan was constructed specifically for execute mode consumption.
2. The `## Execution Manifest` section is **strongly recommended** (not merely optional) — SYNTHESIZE phase should produce it if the plan has sufficient gate-level detail. It can still be omitted if the plan is insufficiently decomposed; execute mode SETUP will extract it from prose.

---

## Template Structure for `proposals/v<N>.md`

SYNTHESIZE phase writes `proposals/v<N>.md` using this structure.

---

```markdown
# <Plan Title>

**Session**: <instance_id>
**Date**: <ISO date>
**Deliverable kind**: impl-plan
**Execute-mode ready**: yes | partial
  (yes = has Execution Manifest section; partial = prose plan only, execute SETUP will extract)

---

## Problem Statement

<What is being implemented. Why. What success looks like.>

---

## Context

<Existing system state. Constraints. Prior decisions that bound the implementation. Reading list for the implementer (file:line or artifact references).>

---

## Proposed Implementation

<The design. How it works. Key components, responsibilities, interfaces. File-level or module-level breakdown with explicit ownership of each file.>

---

## Key Decisions and Rejected Alternatives

| Decision | Alternative considered | Why rejected |
|---|---|---|

---

## Phased Rollout

<If the implementation is large: how it decomposes into phases. Each phase should be independently deliverable and leave the system in a consistent state.>

| Phase | Scope | Exit criterion | Residual | Notes |
|---|---|---|---|---|
| Phase 1 | | | | |

---

## Failure Modes

<What can go wrong in implementation. How each is caught. Hook or process mechanism.>

| # | Failure mode | Catching mechanism |
|---|---|---|

---

## Residual Unknowns

<Things that are still open. Default-off opt-ins. Future-version items. Explicitly bounded.>

| ID | Description | Why it's residual | How to resolve |
|---|---|---|---|
| RU1 | | | |

---

## Execution Manifest

> **Strongly recommended for impl-plan** — include when the plan has gate-level decomposition. Can be omitted only if the plan is insufficiently detailed; execute mode SETUP will extract from prose.

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
    plan_section: "## Proposed Implementation"
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
    "criterion": "The proposed implementation achieves the stated goal — there is a traceable path from problem inputs to implementation outputs",
    "evidence_required": "proposals/v<N>.md §Proposed Implementation: describes mechanism that, given the problem inputs, produces the stated success outputs with file:line references to where each step occurs",
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
    "criterion": "Failure modes table is non-empty — at least 4 implementation-specific failure modes are named with catching mechanisms",
    "evidence_required": "§Failure Modes table has ≥4 rows; each row has a catching mechanism column entry that is not blank",
    "categorical_ban": false
  },
  {
    "id": "G4",
    "criterion": "If Execution Manifest is present, every gate_id maps to a named plan_section in this document and every files[] entry is a real path in the target codebase",
    "evidence_required": "Each gate.plan_section in execution_manifest matches a heading present in this proposal; files[] paths are cited from existing codebase inventory or new-file declarations",
    "categorical_ban": false
  },
  {
    "id": "G5",
    "criterion": "Residual unknowns are bounded — each has a 'how to resolve' path; 'unknown' is not acceptable for how-to-resolve",
    "evidence_required": "§Residual Unknowns table: no entry with 'how to resolve' = '(unknown)' or blank",
    "categorical_ban": false
  },
  {
    "id": "G6",
    "criterion": "No secret or credential material in any section, including code snippets and YAML blocks",
    "evidence_required": "Review of all code blocks, YAML blocks, and example values for API keys, passwords, tokens, or similar",
    "categorical_ban": true
  },
  {
    "id": "G7",
    "criterion": "Plan is self-contained for a downstream execute-mode session — no unexplained references to session-context artifacts that won't be accessible to execute mode",
    "evidence_required": "All file:line anchors are to artifacts in the target repository or explicitly referenced external files; no references to ephemeral deepwork session artifacts without an archival path",
    "categorical_ban": false
  }
]
```
```

---

## Notes for SYNTHESIZE phase

- `state.kind = "impl-plan"` triggers this template.
- After SYNTHESIZE completes, the user invokes: `/deepwork --mode execute --plan-ref .claude/deepwork/<id>/proposals/v<N>-final.md`
- The Execution Manifest section, if present, is consumed directly by execute mode SETUP. If absent, execute mode SETUP extracts an internal manifest from prose (RU9 — documented default behavior).
- `execute-mode ready: partial` is valid and should be used when the plan is detailed enough for SETUP-phase prose extraction but lacks explicit gate-level YAML.
- Fallback behavior: if this template file is absent, SYNTHESIZE phase writes a plan in its current format (§9.4 degrade path).
