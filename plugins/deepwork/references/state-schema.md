# State Schema Field Glossary

**Authoritative schema**: `profiles/default/state-schema.json` (design mode) and `profiles/execute/state-schema.json` (execute mode). This guide explains the operationally-important fields — it does not restate the full schema.

Use `/deepwork-status` (design mode) or `/deepwork-execute-status` (execute mode) to inspect live state without reading `state.json` directly.

---

## Design-mode fields (profiles/default/state-schema.json)

### `phase`

Current orchestration phase. Valid values for design mode: `scope`, `explore`, `synthesize`, `critique`, `deliver`, `halt`. Reading this field tells you where in the pipeline the session stopped. If `phase = "halt"`, read `halt_reason` for the structured reason and `log.md` for the narrative.

### `halt_reason`

Object populated when the session reaches `phase = "halt"`. Schema:

```json
{
  "summary": "<non-empty string>",
  "blockers": ["<blocker description>", ...]
}
```

`summary` is required and non-empty. `blockers` is required and is an array (use `[]` for normal completions; enumerate open items for blocker-halts).

Enforced by [hooks/halt-gate.sh](../hooks/halt-gate.sh): the hook fires on every Stop event and blocks turn-end (exit 2) when `phase == "halt"` (top-level or `execute.phase`) and `halt_reason` is null or malformed. **Backward-compat**: sessions predating this field (key entirely absent from state.json) pass the gate unchanged — the gate discriminates "new session failed to populate" (key present but null/malformed) from "pre-migration session" (key absent).

### `iteration_queue`

Array of outstanding work items the orchestrator must address before DELIVER. Populated by the user (via `jq` or an orchestrator skill) or by the orchestrator during CRITIQUE when additional passes are needed. Each entry is a short description of a required change.

Consulted at `profiles/default/PROFILE.md` §4 step 3: after CRITIC emits APPROVED, the orchestrator runs `jq '.iteration_queue | length'` on state.json. If `> 0`, it pops the first entry, treats it as the next REFINE target, and re-enters REFINE. If `0` or the field is absent, it advances to DELIVER.

Initialized to `[]` at session setup. An empty array is equivalent to "no queued iterations — APPROVED means ship."

### `bar[]`

Written-bar criteria array. Each entry is a criterion the CRITIC will verdict against. Populated during SCOPE phase; entries added by `/deepwork-bar add`. If this array is empty when CRITIQUE runs, the CRITIC has no bar to evaluate against — this is a sign that SCOPE phase did not complete correctly.

### `guardrails[]`

Hard guardrails that cannot be overridden by any archetype or teammate. Entries added by `/deepwork-guardrail add` or auto-appended by `hooks/incident-detector.sh`. Rendered into every teammate spawn prompt. Non-empty guardrails from a prior session carry forward on resume — check this field before resuming if you suspect stale constraints.

### `hook_warnings[]`

Advisory warnings emitted by hooks during the session. Advisory hooks (FileChanged, PostToolUse) cannot block; they write here. If a session appears stuck without a blocking error, check `hook_warnings[]` for the advisory that was missed.

### `empirical_unknowns[]`

Open questions that remain unresolved after EXPLORE phase. The SYNTHESIZE phase reduces these; any remaining at DELIVER indicate the plan makes assumptions that were never validated. If CRITIC emits HOLDING with evidence pointing at an empirical unknown, this field is the starting point for the REFINE cycle.

Each entry: `{id, description, artifact, owner, result}`. `result` is `null` at SCOPE and MUST be backfilled after the corresponding `empirical_results.<id>.md` artifact lands. [hooks/phase-advance-gate.sh](../hooks/phase-advance-gate.sh) blocks transitions into `synthesize`/`critique`/`deliver`/`done` when any `result` is still `null` or the artifact file is missing on disk (drift class a).

### `banners[]`

Backpointer annotations attached to teammate artifacts that SYNTHESIZE overruled or that upstream reconciliation superseded. Each entry: `{artifact_path, banner_type, reason, added_at, added_by}`. Banner types:

- `pre-reconciliation-draft` — applied when a later cross-check (e.g., hunter-b overtakes hunter-a) supersedes the artifact
- `synthesis-deviation-backpointer` — applied when SYNTHESIZE's proposal weighs a recommendation differently than the author proposed; points to the proposal section that demotes it

Banners are advisory metadata only — they document the synthesis decision and direct readers to the current authoritative proposal section. **No hook reads `banners[]` as a blocking signal.** (Protocol commitment per proposals/v3-final.md §6 CONDITIONAL-2.) Writers append entries in the SYNTHESIZE phase after writing the proposal version. Backward-compat: the field is optional; absent or empty arrays produce no behavioral change.

---

## Execute-mode fields (profiles/execute/state-schema.json)

All execute fields live under `state.execute.*`.

### `execute.phase`

Current execute-mode phase: `setup`, `write`, `verify`, `critique`, `refine`, `land`, `continuous-loop`, `halt`, `halting`. If this is `halting`, a discovery with `proposed_outcome: halt` is pending AskUserQuestion resolution. If `halt`, read the top-level `halt_reason` for the structured reason and `log.md` for the narrative. [hooks/halt-gate.sh](../hooks/halt-gate.sh) checks both `.phase` and `.execute.phase` and enforces `halt_reason` for either path. See `references/execute-mode.md` for the full phase pipeline.

### `execute.plan_hash`

SHA-256 of the plan file at SETUP time, frozen by the orchestrator. If this differs from `sha256sum "$plan_ref"`, `plan_drift_detected` will be `true` (set by `hooks/execute/plan-drift-detector.sh`). Single-writer: only the orchestrator writes this field.

### `execute.plan_drift_detected`

Boolean. Set to `true` by `hooks/execute/plan-drift-detector.sh` when the plan file's sha256 diverges from `plan_hash`. While `true`, no new gate verdicts are issued — the drift must be resolved via `/deepwork-execute-amend` before WRITE resumes. Check `plan_hash_at_drift` and `plan_drift_detected_at` for diagnosis.

### `execute.change_log[]`

Array of change records, one per completed plan gate. Each entry has `{id, plan_section, files_touched, test_evidence, critic_verdict, merged_at}`. Use this field to:
- Track which gates have been LANDed (`merged_at` non-null)
- Check which gates still need CRITIC verdict (`critic_verdict: null`)
- Verify test evidence is attached before CRITIQUE (`test_evidence` non-null)

A `change_log` entry with `critic_verdict: null` and `merged_at: null` means the gate is in progress. An entry with `merged_at` set means LAND completed for that gate.

### `execute.rollback_log[]`

Array of rollback records. EXECUTOR-maintained — no auto-write hook populates this. If this array is empty after a known rollback, the rollback was performed manually without a log entry. This is a known limitation. See `references/execute-mode.md` §Known Limitations.

### `execute.flaky_tests[]`

Populated by `hooks/execute/test-capture.sh` when ≥2 alternating pass/fail results are detected across the last 6 test runs for the same command. Flaky entries auto-append a guardrail. The schema field exists; however, no downstream hook reads it as an enforcement gate — this is a known limitation. Check `test-results.jsonl` for the raw evidence.

### `execute.discoveries[]`

Summary of open discoveries. Full detail lives in `discoveries.jsonl` (append-only JSONL at the instance directory). If this array has entries with `resolution: null`, there are unresolved discoveries blocking or pending resolution. The three `proposed_outcome` values route differently — see `references/execute-mode.md` §Discovery Routing Table.

### `execute.setup_flags_snapshot`

Object capturing the `authorized_*` flag values at SETUP time: `authorized_push`, `authorized_force_push`, `authorized_prod_deploy`, `authorized_local_destructive`, `secret_scan_waived`. `hooks/execute/bash-gate.sh` checks this snapshot before honoring any `authorized_*` flag — if a flag is `true` in current state but absent from the snapshot, the hook denies the operation. This prevents post-SETUP flag injection.

---

## Reading state.json directly

The state file lives at `${INSTANCE_DIR}/state.json`. Use `jq` for safe reads:

```bash
INSTANCE_DIR="$(ls -d .claude/deepwork/*/state.json 2>/dev/null | head -1 | xargs dirname)"
jq '.execute.phase' "$INSTANCE_DIR/state.json"
jq '.execute.change_log[] | select(.merged_at == null)' "$INSTANCE_DIR/state.json"
```

For the instance directory path, use `ls .claude/deepwork/*/state.json` or `/deepwork-execute-status`.
