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

   **Banners** (`banners[]`): if non-empty, display:
   ```
   Banners: N artifacts flagged
   - <artifact_path>: <reason> (<banner_type>, <added_at>)
   ...
   ```
   If empty or absent, omit this section entirely.

   **Proposal versions** (list `proposals/*.md` files with their `version:` and `delta_from_prior:` front-matter if available).

4. **Cross-check state** (runs after step 3, before TaskList):
   A. Glob the active instance dir: `.claude/deepwork/<id>/*.md` (NOT archived — live session).
   B. For each file, extract the frontmatter (first `---` block).
   C. From each parsed frontmatter, collect:
        - `artifact_type`
        - `bar_id` (or `bar_ids`)
        - `cross_check_for`   (findings artifacts — points to the bar_id being cross-checked)
        - `verdict`           (critique artifacts — `HOLDING|APPROVED`)
        - `result`            (empirical_results — `confirmed|refuted|inconclusive`)
   D. Render a "Cross-check state" column in the bar verdict table:
      | Gate | Verdict | Cross-check state | Evidence |
      |---|---|---|---|
      | G6 | PASS | 2/2 confirmed | findings.hook-auditor.md (primary), mechanism.enforcement-designer.md (secondary) |
      | G3 | PASS | empirical confirmed | empirical_results.E2.md (result: confirmed) |
   E. Backwards compatible: artifacts without frontmatter contribute no cross-check state;
      column shows `—`.
   F. Also display:
      - **Critique verdict**: glob `critique.v*.md` (highest version), read `verdict` field.
        Display: `"CRITIC verdict: <verdict> (critique.v<version>.md)"`
      - **Empirical results**: glob `empirical_results.*.md`, read `empirical_id` + `result`.
        Display table:
        | Unknown | Result |
        | `<empirical_id>` | `<result>` |

5. **Hooks health check**: Read `state.json.hooks_inject_status`. Display under **Hooks** section:
   - If `hooks_inject_status` is present: `Injected: <block_count> blocks at <timestamp>` — no action needed.
   - If `hooks_inject_status` is absent or null: display a warning: `WARNING: hooks_inject_status missing — hooks may not have been injected. Run /deepwork-teardown and restart the session if enforcement hooks are required.`
   - Compare `hooks_inject_status.timestamp` against `started_at`: if the inject timestamp predates `started_at` by more than 60 seconds, display: `WARNING: hooks_inject_status is older than session start — may reflect a prior session's injection.`

6. Call `TaskList` to get live task status. Display tasks grouped by status (in_progress, pending, completed) with their owner and metadata.bar_id where available.

7. Read the last 50 lines of `.claude/deepwork/<id>/log.md` and display as **Recent Activity**.

8. If `state.json.hook_warnings[]` is non-empty, display under **Hook Warnings** (these are incident signals that triggered guardrail auto-append).

9. If `state.json.user_feedback` is set, display it under **User Feedback** (from a prior ExitPlanMode rejection).

Format all of this as a clean, readable dashboard. Use markdown tables; keep the overall output scannable.
