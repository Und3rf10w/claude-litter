# AskUserQuestion — WHEN and WHEN NOT

`AskUserQuestion` is how the orchestrator surfaces decisions to the user mid-run. It exists to narrow the user's decision surface to exactly the moments where their input is load-bearing. Most of the time, the team should resolve internally.

## WHEN to ask (five legitimate situations)

### 1. Goal redefinition

The original goal is ambiguous at its root, and two reasonable interpretations lead to meaningfully different designs.

> Example: user says "build a notification system for my app." Could mean: push notifications to mobile, in-app toasts, email digests, webhook dispatches. These are four different designs. AskUserQuestion with 3-4 options.

Do NOT ask about implementation details here. Ask about intent.

### 2. Mitigation-path choice

Two (or more) approaches both satisfy the goal, with different trade-offs the user cares about and no evidence-based tiebreaker.

> Example: "We need to handle session-identifier rotation on reset. Option A: patch the companion plugin to self-heal (covers all reset paths). Option B: the triggering plugin invokes the companion's CLI before resetting (covers only this trigger path)." Both work; the trade-off is marketplace hygiene vs. plumbing simplicity.

### 3. Mutex decisions

Enabling one feature disables another, and there's no evidence-based answer for which to prefer.

> Example: "two settings both target the same between-iteration reset behavior via different mechanisms. If both are true, which wins?"

### 4. Scope pivots

The scope needs to expand (we found the problem is bigger than stated) or contract (a sub-problem is itself worth deferring). User decides the scope.

> Example: team discovers the original requirement needs a multi-plugin coordination layer that wasn't in scope. Ask: "continue with this expanded scope, or defer the multi-plugin piece?"

### 5. Architectural trade-off when CRITIC and a specialist disagree on a taste-level call

CRITIC holds the bar (evidence-based gate). Specialists hold mechanism expertise. When they disagree on something that's actually a *taste* call — with no evidence-based tiebreaker — the user's architectural sensibility is the right input.

> Example: CRITIC says "the cross-plugin CLI call is fine — just two lines in the triggering plugin." Specialist (ARCHITECT) says "marketplace hygiene — plugins shouldn't couple to each other's CLI surfaces." Both are defensible. No evidence settles it. Ask the user.

This is the fifth case because it looks like #2 (mitigation-path choice) but is specifically about a *stance* disagreement between roles, not about the merits of the options. The user picks taste.

### 6. Execute-mode halt discovery (execute mode only)

In execute mode, when `discoveries.jsonl` emits an entry with `proposed_outcome: halt`, the orchestrator must surface the decision to the user. This is the only legitimate AskUserQuestion invocation in execute mode.

> Example: a teammate appends a discovery with `type: env-mismatch` and `proposed_outcome: halt` because the changed component fails in a non-recoverable way on one environment. The orchestrator asks the user to choose: halt-and-review, continue-at-operator-risk, or escalate to `/deepwork-execute-amend`.

Authoritative trigger spec: `profiles/execute/PROFILE.md:212-231`.

**Important distinctions**:
- `proposed_outcome: escalate` → do NOT ask the user; trigger `/deepwork-execute-amend` directly.
- `proposed_outcome: continue` → do NOT ask the user; add a guardrail and continue.
- `proposed_outcome: halt` → AskUserQuestion is **required**.

This case differs from the 5 design-mode cases above because it is discovery-triggered at a specific execute-mode state boundary, not a deliberative design choice. The three options must be: (1) halt and review, (2) continue at operator risk, (3) escalate to amendment.

---

## WHEN NOT to ask

- **Implementation details the orchestrator can decide** — naming, file structure, minor design choices. These should be decided by consensus among the specialists, with CRITIC verdict.
- **Things the critique teammates can resolve through debate** — if MECHANISM proposes X and CRITIC objects, the team iterates in REFINE. Don't escalate unless debate deadlocks on a taste issue.
- **Anything answerable by reading the codebase** — FALSIFIER can look. Don't ask the user for info the source can provide.
- **Stylistic preferences that don't affect correctness** — leave them to the team or to post-approval cleanup.
- **Whether the plan is ready** — use `ExitPlanMode`, not AskUserQuestion. ExitPlanMode inherently requests approval.
- **Every little thing** — user surface friction is the enemy. If you're asking more than once or twice per SCOPE → DELIVER cycle, you're probably asking too much.

---

## Format rules

```
AskUserQuestion(questions: [{
  question: "<full question ending with ?>",
  header: "<chip label, ≤12 chars>",
  multiSelect: false,
  options: [
    { label: "<1-5 word choice>", description: "<implication/tradeoff>" },
    ...
  ]
}])
```

- **2-4 options per question.** Not 1 (why ask), not 5+ (choice paralysis).
- **Up to 4 questions in a single invocation** if they're genuinely independent. Prefer fewer.
- **Include a recommendation** as the first option labeled "<option> (Recommended)" when you have a clear preference from the findings.
- **Mark options with tradeoffs** in the description. "Option A (fast, some coverage gaps)" vs. "Option B (thorough, 2x effort)."
- **No "Other" option** — the UI provides one automatically.
- **Never ask "is this plan ready?" or "should I proceed?"** — use ExitPlanMode.

---

## Example good questions

### Scope pivot

```
question: "The original goal scoped the fix to plugin A, but we found the bug spans plugin B too. Which scope do you want?"
header: "Scope"
options:
  - label: "Fix both (recommended)" — "one coordinated PR pair; tightest fix but coordinated review"
  - label: "Fix only plugin A now" — "ships faster; leaves plugin B bug for a follow-up"
  - label: "Defer entirely" — "the bug isn't urgent; come back next quarter"
```

### Architectural trade-off (5th case)

```
question: "CRITIC and ARCHITECT disagree on where the fix should live. Your call on marketplace hygiene vs. implementation simplicity."
header: "Where to fix"
options:
  - label: "Plugin-local (recommended)" — "affected plugin patches itself; covers all trigger paths forever; ~14 lines in one plugin"
  - label: "Cross-plugin coupling" — "triggering plugin invokes the affected plugin's CLI; ~2 lines in the triggering plugin; couples the plugins"
```

### Goal redefinition

```
question: "'Fast status updates' is ambiguous — which do you mean?"
header: "Updates"
options:
  - label: "User-facing polling (recommended)" — "Claude periodically asks 'should I continue?' every N turns"
  - label: "Background digest" — "a separate process produces status logs; user reads when they want"
  - label: "Webhook-triggered" — "external system pings Claude; Claude responds with current state"
```

---

## Anti-patterns

- **Asking "how should I do X?"** — you're the orchestrator. Decide or delegate to MECHANISM.
- **Asking about every fork** — the user didn't sign up to be consulted 20 times. Two or three well-placed questions beat twelve low-value ones.
- **Asking before evidence** — investigate with the team first. If you ask the user before FALSIFIER has finished, you're asking them to design in a vacuum.
- **Asking after APPROVED** — if CRITIC said APPROVED, the next step is ExitPlanMode, not another AskUserQuestion.
