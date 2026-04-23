---
description: "Tear down an active deepwork session — deletes the team, archives state, and restores settings. Works for both mid-flight abort and post-HALT cleanup."
allowed-tools: ["Bash(ls .claude/deepwork/*/state.json:*)", "Bash(rm .claude/deepwork/**:*)", "Bash(rm -f .claude/deepwork/**:*)", "Bash(rm -rf .claude/deepwork/**:*)", "Bash(mv .claude/deepwork/**:*)", "Bash(ls .claude/deepwork/:*)", "Bash(bash * settings-teardown.sh:*)", "Read(.claude/deepwork/**)", "Glob", "AskUserQuestion", "SendMessage", "TeamDelete", "TaskList"]
---

# Teardown Deepwork

Tear down a deepwork session — delete the team, archive state, and restore settings. Applies to both mid-flight abort and post-HALT cleanup; the `phase` field in the archived state distinguishes the two.

1. Use Glob to find all active instances:
```
Glob: .claude/deepwork/*/state.json
```

2. If no files are found, report that no deepwork session is running and stop.

3. Read each state file to extract: `session_id`, `goal`, `phase`, `team_name`.

4. If exactly one instance exists, proceed to tear it down. If multiple instances exist, show a summary:

| Instance ID | Goal | Phase | Team |
|---|---|---|---|
| `<id>` | `<goal>` | `<phase>` | `<team>` |

Then use `AskUserQuestion` to ask the user which instance to tear down.

5. Once the target instance is selected, note its directory path: `.claude/deepwork/<id>/`.

6. Read the state file to get team_name. Then call `TaskList` to get current task status for the summary report.

7. If the state file has a non-null `team_name` field:
   - Broadcast a shutdown_request to all teammates: `SendMessage(to: "*", summary: "ending deepwork", message: "The user has ended the deepwork session. Please stop any in-progress work.")`
   - Call `TeamDelete` to clean up the team and task records.
   - **This is the ONLY place TeamDelete is called.** `hooks/approve-archive.sh` archives state + restores settings on APPROVE but leaves the team intact for inspection; a full teardown (team deletion) only happens when this skill runs.
   - If TeamDelete fails (team already gone), continue anyway.

8. Archive runtime state; preserve all artifacts for audit and future reference:
```bash
mv .claude/deepwork/<id>/state.json .claude/deepwork/<id>/state.archived.json
rm -f .claude/deepwork/<id>/heartbeat.json
rm -f .claude/deepwork/<id>/.idle-retry.*
```

The rename (not delete) of `state.json` stops all active-session globs (`.claude/deepwork/*/state.json`) from picking up this instance — so `setup-deepwork.sh`, `session-context.sh`, `deepwork-status`, `deepwork-bar`, `deepwork-guardrail`, and this skill all correctly skip it — while preserving the full structured record (bar verdicts, empirical_unknowns, user_feedback, guardrails, role_definitions, anchors) for programmatic query across past deepwork sessions. The archived filename is neutral because this skill runs on mid-flight abort, post-APPROVE cleanup, and post-HALT cleanup; the `phase` field inside the archived state distinguishes them.

Do NOT delete the artifacts — they capture the *why* behind the session (what was explored, what failed, what was rejected) and remain useful after teardown for historical analysis and future decisions:
- `log.md` — narrative history
- `proposals/` — all versions of the proposal (audit trail)
- `prompt.md` — original user prompt
- `findings.*.md`, `coverage.*.md`, `mechanism.*.md`, `reframe.*.md`, `empirical_results.*.md`, `critique.*.md` — teammate outputs
- `gate-list-*.md`, `anchors.md` — bar/scope artifacts
- `incidents.jsonl` — structured record of runtime failures (SubagentStop non-zero, PermissionDenied)

9. Check if any other instances remain (informational only — the teardown script in step 10 performs the same check internally):
```bash
ls .claude/deepwork/*/state.json 2>/dev/null
```

10. Restore settings via the centralized teardown script. It checks for remaining active instances, performs selective jq removal of `_deepwork: true`-tagged entries (preserving hooks added by the user or sibling plugins), and falls back to `.deepwork-backup` if jq fails. No-ops if other active instances remain:
    ```bash
    bash "${CLAUDE_PLUGIN_ROOT}/scripts/settings-teardown.sh" "${CLAUDE_PROJECT_DIR:-$PWD}"
    ```
    The same script is invoked by `hooks/approve-archive.sh` on APPROVE, so both teardown paths use identical restore semantics.

11. Report to the user:
    - Goal that was being worked on
    - Phase at time of teardown (the phase field in archived state is preserved as-is — `done` for post-APPROVE plan-mode cleanup, `halt` for post-HALT execute-mode cleanup, or whichever phase was live for mid-flight abort)
    - Task status summary from TaskList (completed / in_progress / pending)
    - Confirm teardown; note that the full instance is preserved at `.claude/deepwork/<id>/` including `state.archived.json` (structured record), `log.md`, `proposals/`, and all teammate artifacts — queryable via `jq` across past sessions
