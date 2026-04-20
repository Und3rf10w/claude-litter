---
description: "Cancel the active swarm loop"
allowed-tools: ["Bash(ls .claude/swarm-loop/*/state.json:*)", "Bash(rm .claude/swarm-loop/**:*)", "Bash(rm -f .claude/swarm-loop/**:*)", "Bash(rm -rf .claude/swarm-loop/**:*)", "Bash(ls .claude/swarm-loop/:*)", "Bash(mv .claude/settings.local.json.swarm-backup:*)", "Bash(test -f .claude/settings.local.json.swarm-backup:*)", "Read(.claude/swarm-loop/**)", "Read(.claude/swarm-loop.local.md)", "Edit(.claude/settings.local.json)", "Read(.claude/settings.local.json)", "Write(.claude/settings.local.json)", "Glob", "AskUserQuestion", "SendMessage", "TeamDelete", "TaskList"]
---

# Cancel Swarm Loop

Check for active swarm loop instances and cancel the selected one:

1. Use Glob to find all active instances:
```
Glob: .claude/swarm-loop/*/state.json
```

2. If no files are found, report that no swarm loop is running and stop.

3. Read each state file to extract: `session_id`, `goal`, `iteration`, `mode`, `team_name`.

4. If exactly one instance exists, proceed to cancel it. If multiple instances exist, show a summary table:

| Instance ID | Goal | Iteration | Mode |
|---|---|---|---|
| `<id>` | `<goal>` | `<n>` | `<mode>` |

Then use `AskUserQuestion` to ask the user which instance to cancel (by ID or number).

5. Once the target instance is selected, note its directory path: `.claude/swarm-loop/<id>/`

6. Read `.claude/swarm-loop/<id>/state.json` to get the current iteration, team_name, goal, and mode. Then call `TaskList` to get current task status.

7. If the state file has a non-null `team_name` field:
   - Send a shutdown_request to all teammates via SendMessage (broadcast to `"*"`)
   - Call TeamDelete to clean up the team and all associated task records
   - Note: **This is the ONLY place TeamDelete is called.** Normal loop completion shuts down teammates but does NOT call TeamDelete.
   - If TeamDelete fails (team already gone), continue anyway.

8. Remove swarm loop files for the selected instance (preserve log.md for reference):
```bash
rm .claude/swarm-loop/<id>/state.json
rm -f .claude/swarm-loop/<id>/verify.sh
rm -f .claude/swarm-loop/<id>/next-iteration
rm -f .claude/swarm-loop/<id>/heartbeat.json
rm -f .claude/swarm-loop/<id>/deepplan.*
rm -f .claude/swarm-loop/<id>/progress.jsonl
rm -f .claude/swarm-loop/<id>/.idle-retry.*
```

9. Check if any other instances remain:
```bash
ls .claude/swarm-loop/*/state.json 2>/dev/null
```

10. Restore settings from backup ONLY if no other instances remain:
   - If `.claude/settings.local.json.swarm-backup` exists, restore it:
     move `.claude/settings.local.json.swarm-backup` to `.claude/settings.local.json`
   - If no backup exists, fall back to selectively removing only swarm-generated content from `settings.local.json`:
     - Remove entries containing "swarm-loop" from `permissions.allow`
     - Remove only hook matcher objects tagged with `"_swarm": true` from each event key — preserve any user-defined hooks
     - If a hook event array becomes empty after filtering, remove the event key; if `.hooks` is empty, remove it entirely
     - Use jq: `jq '.permissions.allow = ([.permissions.allow[]? | select(test("swarm-loop|deepplan") | not)] | unique) | if .hooks then .hooks |= with_entries(.value = [.value[]? | select(._swarm != true)] | select(.value | length > 0)) | if (.hooks | length) == 0 then del(.hooks) else . end else . end' .claude/settings.local.json`
   - If other instances remain, skip the settings restore — the running loops still need the hooks.

11. Report to the user:
   - The goal that was being worked on
   - The mode (profile) in use at the time of cancellation
   - Current iteration number at the time of cancellation
   - Task status summary from `TaskList` (how many completed, in-progress, pending)
   - Confirm all files were cleaned up
   - Note that `.claude/swarm-loop/<id>/log.md` is preserved for reference

Do NOT delete the instance log file — it contains valuable history the user may want to review.

Note: If teammates were using worktree isolation, Claude Code normally cleans up worktrees when agents finish. If cancellation kills teammates mid-work, orphaned worktrees may remain at `.claude/worktrees/`. These can be cleaned up manually with `git worktree list` and `git worktree remove`.
