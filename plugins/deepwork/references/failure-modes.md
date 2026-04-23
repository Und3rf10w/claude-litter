# Failure Modes the Deepwork Pattern Prevents

Pedagogical reference — these are the classes of failure mode the 10 principles are designed to prevent. Each row names a concrete failure pattern, what would have shipped without the pattern, and which principle caught it.

---

| Failure mode | What would have shipped | What caught it (principle) |
|---|---|---|
| **Silent cargo-cult** | A config flag that did nothing because the underlying primitive it targeted was blocked upstream (e.g., a higher layer was filtering the call out before it reached the dispatcher). The flag had been shipping as a no-op for months without anyone noticing. | Independent cross-checks (principle 6): a FALSIFIER null-audit plus a source read of the actual dispatch path converged on "the mechanism is not reachable as assumed." |
| **Double-injection race** | Two concurrent notification paths firing at once (e.g., a stop-hook and an input-injection layer both delivering the same effect), producing corrupted intermediate state and phantom messages. | Written bar with failure-mode criteria (principle 2): CRITIC required the proposal to specify explicit behavior under concurrent writes/injections before any gate could PASS. |
| **Modal-dialog blast** | Input intended for the main command dispatcher reaching a pending modal dialog instead, auto-approving an unrelated operation or routing the command to the wrong handler. | Adversarial review (principle 1): CRITIC specifically tasked with "find what breaks under unexpected modal state" caught the dispatch-collision dealbreaker. |
| **Stale external handle** | Targeting a process or window via a cached handle ID that persisted across session boundaries, landing the operation on an unrelated target after restart. | Adversarial review (principle 1): a specialist surfaced the staleness, CRITIC enforced handle-capture at startup with refresh semantics. |
| **Print-mode / partial-plumbing confusion** | Design built on a CLI flag that was registered globally but only plumbed through one of two code paths; the other silently ignored it. | File:line anchors (principle 4) + independent cross-checks (principle 6): FALSIFIER traced the plumbing end-to-end through the call tree; peer agents independently verified. |
| **Marker-ordering race** | A supervisor reading stale on-disk state because a hook wrote its "done" marker before the state update it referenced had completed. Downstream consumers acted on the wrong iteration. | Written bar ordering gate (principle 2): explicit "writer MUST commit state before touching the marker" criterion, enforced by CRITIC. |
| **Companion-plugin breakage** | A feature in one plugin silently invalidated a companion plugin's session-scoped accumulator on every use. Users who installed the companion for correctness would lose it the moment they enabled the new feature. | Institutional memory (principle 5) + user-as-final-authority (principle 10): CRITIC surfaced the coupling gate; evidence proved the plugin-local fix was viable; user overruled CRITIC's cross-plugin-coupling suggestion on marketplace-hygiene grounds. |
| **Narrow coverage shipped as universal** | A default-on feature that only worked on one target (one terminal / one runtime / one OS) breaking for every user on other targets. | Coverage + graceful-degrade bar criteria (principle 2): a coverage-matrix gate requiring ≥80% weighted-works and an explicit fallback path for the unsupported remainder. |
| **Premature APPROVED** | CRITIC signs off on a first-looks-good proposal; v2 changes slip in without re-review because "it's just tweaks." | Named versioning (principle 8): every version bump triggers fresh CRITIC re-verdict; "name changed → review restarts" is the protocol. |
| **Wrong-problem solution** | Team builds an elegant mechanism without questioning whether the underlying requirement is what the user actually wants. The rejected reframe ("flip an existing default instead of adding a new mechanism") would have surfaced that the existing machinery was itself broken — useful finding even though the reframe itself didn't ship. | Reframing as first-class move (principle 3): REFRAMER spawned by default; even invalidated reframes produce valuable findings as byproducts. |
| **Live empiricism skipped** | Design assumed a third-party API's runtime behavior matched its documentation. Documentation was ambiguous; a single live test on real infrastructure would have been the kill-or-ship moment. If deferred to post-merge, the design could have been invalidated at implementation time. | Live empiricism gate (principle 7): MECHANISM tested on live infrastructure with a representative payload *during SYNTHESIZE* before CRITIC verdicted. |
| **Signal to host process** | A proposal to send a signal (e.g., SIGUSR1) to the hosting process to trigger a debug behavior. On the current runtime, the default signal handler conflicts with the host's I/O mode and kills the process — a failure mode a prior session had already suffered. | Institutional memory (principle 5): the role prompt carried the literal prior-incident text; when a similar-looking alternative came up mid-session, the specialist paused on its own and CRITIC backed the pause. |
| **Vague null** | "No mechanism exists" asserted without a due-diligence inventory. Impossible to trust, because a single missed path invalidates the null. | Independent cross-checks (principle 6) + file:line anchors (principle 4): required ≥2 FALSIFIERs to independently reach the same null from different starting anchors. The output is a multi-item due-diligence inventory — each candidate path checked with file:line closure. |
| **Feature ships always-on despite residual risk** | A new capability ships as default-enabled while one or more empirical unknowns remain deferred. If the empirical results come in negative post-merge, every user is affected. | Default-off shipping (principle 9): CRITIC may approve *unconditionally on architecture* while deferring empirical items — but only if the feature is default-off; early adopters opt in; failures are non-corrupting. |
| **Human dragged into implementation details** | User consulted about every fork: "bash or zsh?", "/tmp or instance dir?", "what's the retry count?" Decision fatigue; the user gives up steering. | Narrow user surface (principle 10): AskUserQuestion reserved for 5 specific fork types; everything else resolved internally. Well-run sessions consume a handful of load-bearing user messages, not dozens. |

---

## How to use this reference

When you're designing a deepwork role prompt or written bar, consult this table to ask:

- "What's the equivalent failure mode in my problem domain?"
- "What gate criterion would catch this if it happened to me?"
- "What role would catch this — CRITIC, REFRAMER, MECHANISM's failure-mode table?"

Specific patterns that transfer to new problem domains:

- **Silent cargo-cult → check if existing machinery is actually working** (FALSIFIER null audit)
- **Partial-plumbing confusion → verify flag/config plumbing end-to-end** (FALSIFIER file:line trace)
- **Marker-ordering race → any concurrent-writer scenario needs an explicit ordering gate** (CRITIC bar criterion)
- **Wrong-problem solution → REFRAMER required for every session** (principle 3)
- **Vague null → independent cross-check gates any load-bearing null** (principle 6)

The 10 principles are generalizations; this table gives concrete instantiations. Future `/deepwork` runs should extend this table with their own failure modes + catchers, building up institutional memory across sessions.

---

## Execute-mode failure modes

These are the failure paths specific to `/deepwork --mode execute`. Each row cites the enforcing hook or script at file:line. Source: `mechanism.doc-architect.md` §F, validated against `findings.hunter.md` §C.

| Failure | Handler (file:line) | Recovery |
|---|---|---|
| **Plan file mutated after SETUP** | `hooks/execute/plan-drift-detector.sh:44-75` | `plan_drift_detected=true`; halt; amend via `/deepwork-execute-amend` or rerun |
| **Write without plan citation** | `hooks/execute/plan-citation-gate.sh:56-98` | Block Write/Edit until `pending-change.json` populated with valid `plan_section` and target file in `files[]` |
| **Covering test last failed (EP3)** | `hooks/execute/plan-citation-gate.sh:100-127` | Fix the failing test before next Write/Edit; `test-results.jsonl` entry must show `last_result: "pass"` |
| **Write to log files (GAP-10)** | `hooks/execute/plan-citation-gate.sh:48-53` | Blocked unconditionally; log files are append-only via hooks — use the designated hooks or jq+tmp+mv pattern |
| **`--no-verify`/`SKIP=*`/`git core.hooksPath=` bypass** | `hooks/execute/bash-gate.sh:104-115` | Categorically denied; no override path exists (G8 ban) |
| **Unauthorized force-push** | `hooks/execute/bash-gate.sh:119-124` | Denied unless `authorized_force_push` was set in `setup_flags_snapshot` at SETUP time |
| **Secret in bash command** | `hooks/execute/bash-gate.sh:172-198` | Denied (G7 secret-scan); rotate credential and reissue without secret in command |
| **Irreversibility ladder breach** | `hooks/execute/bash-gate.sh:206-279` | Denied per tier; set the corresponding `authorized_*` flag at SETUP time (not post-SETUP) |
| **Post-setup mutation of `authorized_*`** | `hooks/execute/bash-gate.sh:80-100` | Denied; flags are frozen at SETUP; start a new execute session with the required flags |
| **Out-of-scope task creation** | `hooks/execute/task-scope-gate.sh:57-112` | Discovery appended to `discoveries.jsonl`; resolve via `/deepwork-execute-amend` before creating the task |
| **Flaky test (mixed last-6 results)** | `hooks/execute/test-capture.sh:132-184` | Logged to `test-results.jsonl`; surfaces in CRITIC context; add test stabilization before next CRITIQUE |
| **Mid-execute session exit** | `hooks/execute/stop-hook.sh:43-101` | Re-injection (`decision:"block"`) until `change_log[]` entries have verdicts; complete or explicitly halt |

### Unhandled / manually-maintained paths

Documented as known limitations — not proposed for fixing in this session:

- **`rollback_log[]`** — EXECUTOR-maintained manually; no auto-write hook.
- **`env_attestations[]`** — AUDITOR-written via stance; no auto-write hook.
- **`flaky_tests[]` state field** — detected by `test-capture.sh` but only written to `test-results.jsonl`; the `state.execute.flaky_tests[]` field is currently unused by any enforcement gate.
- **`discoveries.jsonl` watchdog** — no automated watchdog for stale-open entries with `resolution: null`.

See `references/execute-mode.md` §Known Limitations for detail.
