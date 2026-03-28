---
description: "Cancel the active swarm loop"
allowed-tools: ["Bash(test -f .claude/swarm-loop.local.state.json:*)", "Bash(rm .claude/swarm-loop.local.state.json:*)", "Bash(rm -f .claude/swarm-loop.local.verify.sh:*)", "Bash(rm -f .claude/swarm-loop.local.lock:*)", "Bash(rm -f .claude/swarm-loop.local.next-iteration:*)", "Bash(rm -f .claude/swarm-loop.local.heartbeat.json:*)", "Bash(rm -f .claude/deepplan.local.*:*)", "Bash(mv .claude/settings.local.json.swarm-backup:*)", "Bash(test -f .claude/settings.local.json.swarm-backup:*)", "Read(.claude/swarm-loop.local.state.json)", "Edit(.claude/settings.local.json)", "Read(.claude/settings.local.json)", "Write(.claude/settings.local.json)", "SendMessage", "TeamDelete", "TaskList"]
---

# Cancel Swarm Loop

Check if a swarm loop is active and cancel it:

1. First check if the state file exists:
```bash
test -f .claude/swarm-loop.local.state.json && echo "active" || echo "inactive"
```

2. If inactive, report that no swarm loop is running and stop.

3. If active, read `.claude/swarm-loop.local.state.json` to get the current iteration, team_name, goal, and mode. Then call `TaskList` to get current task status.

4. If the state file has a non-null `team_name` field:
   - Send a shutdown_request to all teammates via SendMessage (broadcast to `"*"`)
   - Call TeamDelete to clean up the team and all associated task records
   - Note: **This is the ONLY place TeamDelete is called.** Normal loop completion shuts down teammates but does NOT call TeamDelete.
   - If TeamDelete fails (team already gone), continue anyway.

5. Remove all swarm loop files:
```bash
rm .claude/swarm-loop.local.state.json
rm -f .claude/swarm-loop.local.lock
rm -f .claude/swarm-loop.local.verify.sh
rm -f .claude/swarm-loop.local.next-iteration
rm -f .claude/swarm-loop.local.heartbeat.json
```

6. If the mode was `deepplan`, also remove intermediate deepplan files (preserve `.claude/deepplan.local.plan.md` if it exists):
```bash
rm -f .claude/deepplan.local.findings.arch.md
rm -f .claude/deepplan.local.findings.files.md
rm -f .claude/deepplan.local.findings.risk.md
rm -f .claude/deepplan.local.draft.md
rm -f .claude/deepplan.local.critique.pragmatist.md
rm -f .claude/deepplan.local.critique.strategist.md
```

7. Restore settings from backup:
   - If `.claude/settings.local.json.swarm-backup` exists, restore it:
     move `.claude/settings.local.json.swarm-backup` to `.claude/settings.local.json`
   - If no backup exists, fall back to selectively removing only swarm-generated content from `settings.local.json`:
     - Remove entries containing "swarm-loop" from `permissions.allow`
     - Remove only hook matcher objects tagged with `"_swarm": true` from each event key — preserve any user-defined hooks
     - If a hook event array becomes empty after filtering, remove the event key; if `.hooks` is empty, remove it entirely
     - Use jq: `jq '.permissions.allow = ([.permissions.allow[]? | select(test("swarm-loop|deepplan") | not)] | unique) | if .hooks then .hooks |= with_entries(.value = [.value[]? | select(._swarm != true)] | select(.value | length > 0)) | if (.hooks | length) == 0 then del(.hooks) else . end else . end' .claude/settings.local.json`

8. Report to the user:
   - The goal that was being worked on
   - The mode (profile) in use at the time of cancellation
   - Current iteration number at the time of cancellation
   - Task status summary from `TaskList` (how many completed, in-progress, pending)
   - Confirm all files were cleaned up
   - Note that `.claude/swarm-loop.local.log.md` is preserved for reference

Do NOT delete the log file — it contains valuable history the user may want to review.

Note: If teammates were using worktree isolation, Claude Code normally cleans up worktrees when agents finish. If cancellation kills teammates mid-work, orphaned worktrees may remain at `.claude/worktrees/`. These can be cleaned up manually with `git worktree list` and `git worktree remove`.
