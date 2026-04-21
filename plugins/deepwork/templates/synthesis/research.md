# Research Synthesis Template

**Kind**: research
**Invocation**: `/deepwork --kind research "..."` or goal matches `/\b(investigate|research|explore)\b/i`
**Mode**: plan mode only — no execute phase. This template is never consumed by execute mode.

---

## Template Structure for `proposals/v<N>.md`

SYNTHESIZE phase writes `proposals/v<N>.md` using this structure. Fill each section from the team's findings. Omit sections that are genuinely empty (mark "(none)" rather than leaving blank headers).

---

```markdown
# <Research Title>

**Session**: <instance_id>
**Date**: <ISO date>
**Deliverable kind**: research
**Starting points investigated**: <count>
**Residual open questions**: <count>

---

## Problem Statement

<One paragraph: what question is being investigated and why it matters. What decision or action depends on the answer?>

---

## Method

<How the investigation was structured. Which starting points were assigned to which roles. What sources were consulted (with file:line or URL anchors where applicable). What was out of scope.>

---

## Findings

### SP1 — <Starting Point Title>

**Owner**: <role name>
**Sources**: <file:line or external references>
**Finding**: <declarative statement of what is known>
**Confidence**: HIGH / MEDIUM / LOW
**Reasoning**: <why this confidence level — what evidence supports it, what would change it>

### SP2 — <Starting Point Title>

...

---

## Cross-References

<Findings that connect across starting points. Contradictions or confirmations between SP findings. Table or prose.>

| SP-A | SP-B | Relationship |
|---|---|---|
| <finding from SP-A> | <finding from SP-B> | confirms / contradicts / extends |

---

## Residual Open Questions

For each question that the investigation opened but did not close:

| ID | Question | Why it matters | What would close it |
|---|---|---|---|
| RQ1 | | | |

---

## CRITIC Bar Skeleton

```json
[
  {
    "id": "G1",
    "criterion": "Each starting point produces a declarative finding statement with explicit confidence rating and reasoning",
    "evidence_required": "proposals/v<N>.md §Findings: each SP section has Finding + Confidence + Reasoning fields",
    "categorical_ban": false
  },
  {
    "id": "G2",
    "criterion": "Every claim cites the source it derives from (file:line or URL anchor)",
    "evidence_required": "No unsourced assertions in findings; each claim traceable to an artifact read by a team member",
    "categorical_ban": false
  },
  {
    "id": "G3",
    "criterion": "Cross-references table is complete — contradictions between SP findings are surfaced, not silently omitted",
    "evidence_required": "§Cross-References present; any SP-A vs SP-B contradiction has its own row",
    "categorical_ban": false
  },
  {
    "id": "G4",
    "criterion": "Residual open questions are bounded and actionable — each has a 'what would close it' path",
    "evidence_required": "§Residual Open Questions table: no question with 'what would close it' = '(unknown)' or blank",
    "categorical_ban": false
  },
  {
    "id": "G5",
    "criterion": "No execute-mode artifacts produced — no execution_manifest, no gate-list, no pending-change.json",
    "evidence_required": "Proposal file contains only §Problem Statement / §Method / §Findings / §Cross-References / §Residual Open Questions",
    "categorical_ban": true
  },
  {
    "id": "G6",
    "criterion": "Confidence ratings are calibrated — HIGH requires multiple corroborating sources; MEDIUM requires one source; LOW explicitly states the gap",
    "evidence_required": "Each SP finding with confidence HIGH cites ≥2 sources; LOW findings name what is missing",
    "categorical_ban": false
  }
]
```
```

---

## Notes for SYNTHESIZE phase

- `state.kind = "research"` triggers this template.
- Execute mode is NOT invoked after a research session completes. The deliverable is the `proposals/v<N>.md` findings report.
- If the user subsequently needs an implementation plan from the findings, they should invoke `/deepwork --kind impl-plan "..."` with the research output as a starting point.
- Fallback behavior: if this template file is absent, SYNTHESIZE phase writes a findings report in its own format (§9.4 degrade path).
