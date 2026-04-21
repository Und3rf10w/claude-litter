# Audit Synthesis Template

**Kind**: audit
**Invocation**: `/deepwork --kind audit "..."` or goal matches `/\b(audit|vuln|security review)\b/i`
**Mode**: plan mode only — no execute phase. This template is never consumed by execute mode.

---

## Template Structure for `proposals/v<N>.md`

SYNTHESIZE phase writes `proposals/v<N>.md` using this structure. Every finding must have a severity, CVSS (or N/A with reason), mitigation, and at least one file:line anchor. Omit sections with no findings; mark "(none found)" for empty categories.

---

```markdown
# <Audit Title>

**Session**: <instance_id>
**Date**: <ISO date>
**Deliverable kind**: audit
**Scope**: <what was audited — module, service, integration surface>
**Total findings**: <count> (<critical> critical, <high> high, <medium> medium, <low> low, <info> informational)
**Audit method**: <manual review | automated scan | hybrid>

---

## Scope and Constraints

<What was in scope. What was explicitly out of scope. Any constraints on the audit (no dynamic testing, read-only access, time-boxed, etc.). Why these constraints matter for interpreting the findings.>

---

## Executive Summary

<3-5 sentences. What is the overall security posture? What are the most significant findings? What is the recommended priority order for remediation?>

---

## Findings

### <Finding ID> — <Short Title>

| Field | Value |
|---|---|
| **Severity** | CRITICAL / HIGH / MEDIUM / LOW / INFORMATIONAL |
| **CVSS v3.1 Score** | <score> or N/A (<reason>) |
| **CWE** | CWE-<N>: <name> or N/A |
| **Location** | `<file>:<line>` |
| **Affected component** | <module/service/function> |

**Description**: <What the vulnerability is. How it can be triggered. What an attacker gains.>

**Evidence**: <File:line anchors, code snippet, or artifact reference. No unsourced assertions.>

**Mitigation**: <Concrete fix. What must change. Whether it's a code change, config change, process change, or architectural change.>

**Residual risk after mitigation**: <What risk remains even after the mitigation is applied. "None identified" is acceptable if well-reasoned; "unverified" is not.>

---

## Attack Surface Summary

| Component | Entry points | Trust boundary crossed | Finding IDs |
|---|---|---|---|

---

## Remediation Priority Order

| Priority | Finding ID | Rationale |
|---|---|---|
| 1 (immediate) | | |
| 2 (next sprint) | | |
| 3 (scheduled) | | |

---

## CRITIC Bar Skeleton

```json
[
  {
    "id": "G1",
    "criterion": "Every finding has a file:line anchor — no finding is described without locating it in the codebase",
    "evidence_required": "Each §Finding section has a Location field with file:line reference confirmed by the auditing role",
    "categorical_ban": false
  },
  {
    "id": "G2",
    "criterion": "Severity ratings are justified — CRITICAL/HIGH findings cite exploitability evidence, not just theoretical possibility",
    "evidence_required": "CRITICAL and HIGH findings include a Description paragraph explaining how the vulnerability is triggered and what the attacker gains",
    "categorical_ban": false
  },
  {
    "id": "G3",
    "criterion": "Mitigations are concrete — 'patch dependency' or 'validate input' without specifics is not acceptable",
    "evidence_required": "Each Mitigation field specifies what changes (file, function, behavior) and distinguishes code change / config change / process change",
    "categorical_ban": false
  },
  {
    "id": "G4",
    "criterion": "Residual risk is explicitly assessed for each finding — 'unverified' is not an acceptable residual risk statement",
    "evidence_required": "Each §Finding has a Residual risk field with a reasoned statement; blanks are FAIL",
    "categorical_ban": false
  },
  {
    "id": "G5",
    "criterion": "Scope and constraints are declared — omitted-by-constraint surface is named, not silently excluded",
    "evidence_required": "§Scope and Constraints names everything excluded from audit scope and the constraint reason",
    "categorical_ban": false
  },
  {
    "id": "G6",
    "criterion": "No execute-mode artifacts produced — no execution_manifest, no gate-list, no pending-change.json",
    "evidence_required": "Proposal file contains only audit sections; no implementation plan structure present",
    "categorical_ban": true
  }
]
```
```

---

## Notes for SYNTHESIZE phase

- `state.kind = "audit"` triggers this template.
- Execute mode is NOT invoked after an audit session. The deliverable is a findings report only.
- Remediation implementation, if required, should be a separate `/deepwork --kind impl-plan "..."` session that treats the audit report as a starting point.
- Fallback behavior: if this template file is absent, SYNTHESIZE phase writes findings in its own format (§9.4 degrade path).
