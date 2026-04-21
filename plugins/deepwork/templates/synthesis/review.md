# Review Synthesis Template

**Kind**: review
**Invocation**: `/deepwork --kind review "..."`
**Mode**: plan mode only — no execute phase. This template is never consumed by execute mode.

---

## Template Structure for `proposals/v<N>.md`

SYNTHESIZE phase writes `proposals/v<N>.md` using this structure. Review deliverables are code-review-style: findings are not vulnerabilities (those belong in `audit`) but correctness, design, and maintainability concerns. Every finding must have a file:line anchor and a recommendation. Acceptance criteria close the document.

---

```markdown
# <Review Title>

**Session**: <instance_id>
**Date**: <ISO date>
**Deliverable kind**: review
**Scope**: <what was reviewed — PR, module, interface, design document>
**Reviewer roles**: <list of active archetypes>
**Total findings**: <count> (<blocking> blocking, <non-blocking> non-blocking, <informational> informational)

---

## Scope

<What was reviewed. What was explicitly out of scope. What questions the review was trying to answer.>

---

## Summary Verdict

**Disposition**: APPROVE / APPROVE-WITH-CHANGES / REQUEST-CHANGES / HOLD

<2-3 sentence rationale for the disposition. What is the main concern driving the verdict? What would change it?>

---

## Findings

### RF<N> — <Short Title>

| Field | Value |
|---|---|
| **Severity** | BLOCKING / NON-BLOCKING / INFORMATIONAL |
| **Kind** | correctness / design / maintainability / performance / test-coverage / style |
| **Location** | `<file>:<line>` |

**Observation**: <What was found. Factual, not prescriptive.>

**Concern**: <Why it matters. What breaks or degrades if left as-is.>

**Recommendation**: <What to change. Specific enough to act on. If multiple options, name them with tradeoffs.>

---

## Positive Observations

<What is notably well-done. Not padding — only specific things worth calling out as examples to replicate. Optional section; omit if nothing substantive.>

---

## Acceptance Criteria

For APPROVE-WITH-CHANGES or REQUEST-CHANGES dispositions, list the specific conditions that would change the verdict to APPROVE:

| ID | Condition | Blocking finding(s) addressed |
|---|---|---|
| AC1 | | |

---

## CRITIC Bar Skeleton

```json
[
  {
    "id": "G1",
    "criterion": "Every finding has a file:line anchor — no finding is described without locating it in the reviewed artifact",
    "evidence_required": "Each §Finding has a Location field with file:line reference confirmed by the reviewing role",
    "categorical_ban": false
  },
  {
    "id": "G2",
    "criterion": "Blocking findings have a concrete recommendation — 'this is wrong' without a proposed fix is not blocking-severity",
    "evidence_required": "Each BLOCKING finding has a Recommendation field with specific change described",
    "categorical_ban": false
  },
  {
    "id": "G3",
    "criterion": "Summary verdict is consistent with findings — APPROVE cannot coexist with unresolved BLOCKING findings",
    "evidence_required": "If Summary Verdict = APPROVE, zero BLOCKING findings in §Findings. If REQUEST-CHANGES, ≥1 BLOCKING findings present.",
    "categorical_ban": false
  },
  {
    "id": "G4",
    "criterion": "Acceptance criteria are present for any non-APPROVE disposition and are specific enough to be verifiable",
    "evidence_required": "APPROVE-WITH-CHANGES and REQUEST-CHANGES dispositions have §Acceptance Criteria with ≥1 row; conditions reference specific finding IDs",
    "categorical_ban": false
  },
  {
    "id": "G5",
    "criterion": "Findings scope matches declared review scope — findings outside scope are labeled out-of-scope rather than quietly included",
    "evidence_required": "§Scope names what was reviewed; no finding references a location outside that scope without an explicit 'out-of-scope / FYI' label",
    "categorical_ban": false
  },
  {
    "id": "G6",
    "criterion": "No execute-mode artifacts produced — no execution_manifest, no gate-list, no pending-change.json",
    "evidence_required": "Proposal file contains only review sections; no implementation plan structure present",
    "categorical_ban": true
  }
]
```
```

---

## Notes for SYNTHESIZE phase

- `state.kind = "review"` triggers this template.
- Execute mode is NOT invoked after a review session. The deliverable is a code-review report only.
- If the review disposition is REQUEST-CHANGES and the changes are substantial, a separate `/deepwork --kind impl-plan "..."` session can consume this review as a starting point for the remediation plan.
- Fallback behavior: if this template file is absent, SYNTHESIZE phase writes findings in its own format (§9.4 degrade path).
