---
description: "Cancel the active deepwork session — tears down team and cleans up"
allowed-tools: ["Bash(ls .claude/deepwork/*/state.json:*)", "Bash(rm .claude/deepwork/**:*)", "Bash(rm -f .claude/deepwork/**:*)", "Bash(rm -rf .claude/deepwork/**:*)", "Bash(ls .claude/deepwork/:*)", "Bash(mv .claude/settings.local.json.deepwork-backup:*)", "Bash(test -f .claude/settings.local.json.deepwork-backup:*)", "Read(.claude/deepwork/**)", "Edit(.claude/settings.local.json)", "Read(.claude/settings.local.json)", "Write(.claude/settings.local.json)", "Glob", "AskUserQuestion", "SendMessage", "TeamDelete", "TaskList"]
---

# Cancel Deepwork

Check for active deepwork sessions and cancel the selected one:

1. Use Glob to find all active instances:
```
Glob: .claude/deepwork/*/state.json
```

2. If no files are found, report that no deepwork session is running and stop.

3. Read each state file to extract: `session_id`, `goal`, `phase`, `team_name`.

4. If exactly one instance exists, proceed to cancel it. If multiple instances exist, show a summary:

| Instance ID | Goal | Phase | Team |
|---|---|---|---|
| `<id>` | `<goal>` | `<phase>` | `<team>` |

Then use `AskUserQuestion` to ask the user which instance to cancel.

5. Once the target instance is selected, note its directory path: `.claude/deepwork/<id>/`.

6. Read the state file to get team_name. Then call `TaskList` to get current task status for the summary report.

7. If the state file has a non-null `team_name` field:
   - Broadcast a shutdown_request to all teammates: `SendMessage(to: "*", summary: "cancelling deepwork", message: "The user has cancelled the deepwork session. Please stop any in-progress work.")`
   - Call `TeamDelete` to clean up the team and task records.
   - **This is the ONLY place TeamDelete is called.** Approved-and-done sessions leave the team intact for inspection.
   - If TeamDelete fails (team already gone), continue anyway.

8. Clean up the instance directory, preserving `log.md` and `proposals/` for reference:
```bash
rm -f .claude/deepwork/<id>/state.json
rm -f .claude/deepwork/<id>/heartbeat.json
rm -f .claude/deepwork/<id>/.idle-retry.*
rm -f .claude/deepwork/<id>/incidents.jsonl
rm -f .claude/deepwork/<id>/findings.*.md
rm -f .claude/deepwork/<id>/coverage.*.md
rm -f .claude/deepwork/<id>/mechanism.*.md
rm -f .claude/deepwork/<id>/reframe.*.md
rm -f .claude/deepwork/<id>/empirical_results.*.md
rm -f .claude/deepwork/<id>/critique.*.md
rm -f .claude/deepwork/<id>/gate-list-*.md
rm -f .claude/deepwork/<id>/anchors.md
```

Do NOT delete:
- `log.md` — narrative history
- `proposals/` — all versions of the proposal (audit trail)
- `prompt.md` — original user prompt

9. Check if any other instances remain:
```bash
ls .claude/deepwork/*/state.json 2>/dev/null
```

10. Restore settings ONLY if no other instances remain. **Primary path**: selectively remove only `_deepwork: true`-tagged entries from `settings.local.json` via jq (preserves hooks added by the user or other plugins AFTER deepwork started). **Fallback**: restore from backup only if the jq filter fails (e.g., corrupt JSON):
    ```bash
    # Primary — selective removal (preserves user+sibling-plugin hooks)
    if jq 'if .hooks then
             .hooks |= with_entries(.value = [.value[]? | select(._deepwork != true)] | select(.value | length > 0))
             | if (.hooks | length) == 0 then del(.hooks) else . end
           else . end' .claude/settings.local.json > tmp && [ -s tmp ]; then
      mv tmp .claude/settings.local.json
      rm -f .claude/settings.local.json.deepwork-backup  # success — drop stale backup
    else
      rm -f tmp
      # Fallback — reachable only if jq failed on corrupt settings
      [ -f .claude/settings.local.json.deepwork-backup ] && \
        mv .claude/settings.local.json.deepwork-backup .claude/settings.local.json
    fi
    ```
    If other instances remain, skip the settings restore — the running sessions still need the hooks.

11. Report to the user:
    - Goal that was being worked on
    - Phase at time of cancellation
    - Task status summary from TaskList (completed / in_progress / pending)
    - Confirm cleanup; note that `log.md` and `proposals/` are preserved at `.claude/deepwork/<id>/`
