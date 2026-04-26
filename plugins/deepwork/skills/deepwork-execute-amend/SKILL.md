---
description: "Lightweight single-gate amendment for execute mode — spawns MICRO-TEAM (CRITIC + 1 specialist) for re-verdict without full deepwork re-run"
argument-hint: "<gate-id> [--reason 'description of scope delta']"
allowed-tools: ["Read(.claude/deepwork/**)", "Write(.claude/deepwork/**)", "Edit(.claude/deepwork/**)", "Glob", "TaskList", "TaskCreate", "TaskUpdate", "TaskGet", "SendMessage", "Agent"]
trigger-keywords: ["amend execute plan", "re-verdict gate", "lightweight amendment", "scope delta", "plan gap"]
---

# Deepwork Execute Amend

Invoke a lightweight single-gate amendment cycle for the active execute-mode session.

## What this skill does

Spawns a MICRO-TEAM of CRITIC + 1 specialist to re-verdict a single gate in the execute session without re-running the full deepwork team. Use when:
- SCOPE-GUARD identifies a necessary-but-out-of-scope change for a specific gate
- A `scope-delta` discovery with `proposed_outcome: escalate` has been appended to `discoveries.jsonl`
- EXECUTOR reports a plan gap that cannot be resolved within existing plan language

## When NOT to use this skill — require fresh `/deepwork --mode default` instead

Per plan §6 (full re-run threshold), redirect to `/deepwork --mode default` if ANY of:
- The amendment touches **≥3 gates** (>30% of the plan scope)
- The amendment contradicts a **categorical ban** (G7 secret-scan, G8 CI-bypass)
- The amendment changes the plan's **test acceptance criteria** (affects test_manifest[] entries)
- The amendment changes the plan's **declared environments** (affects env_attestations entries)

In these cases, output a HALT recommendation and ask the user via AskUserQuestion to authorize a full re-run or cancel.

## Steps

1. Read the active execute session state:
   ```
   Glob: .claude/deepwork/*/state.json
   ```
   Filter for the instance with `execute.phase` not null and not "halt". Read `state.json.execute.plan_ref`, `plan_hash`, `change_log`, `scope_amendments`.

2. Identify the gate being amended from the `<gate-id>` argument (e.g., `G-exec-3`).

3. Read the gate's task from TaskList. Read the relevant `change_log[]` entry with `metadata.bar_id == <gate-id>`. Read the discovery entry from `discoveries.jsonl` that triggered this amendment.

4. **Check full re-run threshold** (step 2 above). If threshold is met, output HALT recommendation and stop.

5. Determine which specialist to spawn alongside CRITIC:
   - PA dimension issue (scope, plan citation) → `scope-guard` specialist
   - EG dimension issue (test failures, adversarial gaps) → `adversary` specialist
   - RA dimension issue (regression) → `executor` specialist
   - Env attestation issue → `auditor` specialist

6. Spawn the MICRO-TEAM via two Agent tool calls in one message:
   - `critic` — include `references/critic-stance.md` verbatim; instruct to re-verdict ONLY the PA dimension of `<gate-id>` against the proposed amendment
   - `<specialist>` — include the appropriate stance from `profiles/execute/stances/`; instruct to read the discovery context and produce an `amendment.v<N>.md` in `proposals/amendments/`

7. Wait for the micro-team to complete. The specialist produces `proposals/amendments/amendment.v<N>.md`. CRITIC verdicts it.

8. **If CRITIC PASS on the amendment**:
   - Append the scope amendment record via `state-transition.sh append_array`:
     ```bash
     bash .claude/deepwork/<instance-id>/../../scripts/state-transition.sh \
       --state-file .claude/deepwork/<instance-id>/state.json \
       append_array .execute.scope_amendments \
       '{"id":"SA-<N>","gate_id":"<gate-id>","amendment_file":"proposals/amendments/amendment.v<N>.md","reason":"<description>","approved_at":"<ISO>","triggered_by":"<discovery-id or null>"}'
     ```
   - If the amendment modifies the plan file, recompute and store `plan_hash` and clear drift via `set_field`:
     ```bash
     NEW_HASH=$(sha256sum "$plan_ref" | cut -d' ' -f1)
     bash .claude/deepwork/<instance-id>/../../scripts/state-transition.sh \
       --state-file .claude/deepwork/<instance-id>/state.json \
       set_field .execute.plan_hash "$NEW_HASH"
     bash .claude/deepwork/<instance-id>/../../scripts/state-transition.sh \
       --state-file .claude/deepwork/<instance-id>/state.json \
       set_field .execute.plan_drift_detected false
     ```
   - Mark the discovery entry's `resolution` field: `"resolved via SA-<N>"`
   - Report to user: amendment approved, session may resume.

9. **If CRITIC FAIL on the amendment**:
   - Output the FAIL reason to the user.
   - Ask user for direction via AskUserQuestion: "Amendment for gate <gate-id> was rejected: <reason>. Options: (1) revise the amendment, (2) cancel this gate, (3) halt session for manual review."

## CC hook capability note

- `permissionDecision:"ask"` silently degrades to `"deny"` in non-interactive mode (`cli_formatted_2.1.116.js:472423-472440`). This skill does not use `"ask"`.
- PreToolUse blocking uses `permissionDecision:"deny"` (via `hookSpecificOutput`, `cli_formatted_2.1.116.js:266013-266017`) or exit 2, not the deprecated `decision:"block"` (`cli_formatted_2.1.116.js:632082`).

## Companion commands

- `/deepwork-execute-status` — view current execute session state before invoking amendment
- `/deepwork --mode default` — full re-run when amendment threshold is exceeded
