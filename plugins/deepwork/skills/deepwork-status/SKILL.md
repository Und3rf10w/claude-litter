---
description: "View deepwork session status — phase, team, bar verdicts, proposals, guardrails"
allowed-tools: ["Read(.claude/deepwork/**)", "Glob", "TaskList"]
---

# Deepwork Status

Display the current status of all active deepwork sessions.

1. Use Glob to find all active instances:
```
Glob: .claude/deepwork/*/state.json
```
If no files are found, report that no deepwork session is currently active and stop.

2. Read each state file found. For each instance, display a brief summary row:

| Instance ID | Goal | Phase | Team |
|---|---|---|---|
| `<id>` | `<goal>` | `<phase>` | `<team_name>` |

3. For the current session's instance (match `state.json.session_id` against `$CLAUDE_CODE_SESSION_ID` if available, or show all if the env var is unavailable), display detailed status:

   **Core fields**
   - **Goal**
   - **Phase** (scope | explore | synthesize | critique | refine | deliver | done | refining)
   - **Team**: `team_name`
   - **Instance**: `instance_id`
   - **Started**: `started_at`
   - **Last updated**: `last_updated`
   - **Safe mode**: `safe_mode`

   **Source of truth** (`source_of_truth[]`): list each path; or "(none specified)"

   **Anchors** (`anchors[]`): list each file:line; or "(none specified)"

   **Written bar** (`bar[]`): table of:

   | ID | Criterion | Verdict | Categorical ban | Evidence required |
   |---|---|---|---|---|

   **Empirical unknowns** (`empirical_unknowns[]`): table of:

   | ID | Description | Artifact | Owner | Result |
   |---|---|---|---|---|

   **Role definitions** (`role_definitions[]`): table of:

   | Name | Archetype | Model | Output artifact |
   |---|---|---|---|

   **Guardrails** (`guardrails[]`): list:

   ```
   - <rule>  [source: <source>, <timestamp>]
   ```

   **Proposal versions** (list `proposals/*.md` files with their `version:` and `delta_from_prior:` front-matter if available).

4. Call `TaskList` to get live task status. Display tasks grouped by status (in_progress, pending, completed) with their owner and metadata.bar_id where available.

5. Read the last 50 lines of `.claude/deepwork/<id>/log.md` and display as **Recent Activity**.

6. If `state.json.hook_warnings[]` is non-empty, display under **Hook Warnings** (these are incident signals that triggered guardrail auto-append).

7. If `state.json.user_feedback` is set, display it under **User Feedback** (from a prior ExitPlanMode rejection).

Format all of this as a clean, readable dashboard. Use markdown tables; keep the overall output scannable.
