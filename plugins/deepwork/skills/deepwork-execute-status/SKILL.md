---
description: "View execute-mode session status — phase, plan_hash, drift, change_log, test results, 3-dimension verdict table, rollback log, discoveries"
allowed-tools: ["Read(.claude/deepwork/**)", "Glob", "TaskList"]
---

# Deepwork Execute Status

Display the current status of the active execute-mode deepwork session.

1. Use Glob to find active instances:
```
Glob: .claude/deepwork/*/state.json
```
If no files are found, report "no deepwork session is currently active" and stop. If multiple are found, identify the execute-mode instance by `state.json.execute.phase` being non-null and not "halt". If none has execute mode active, report "no execute-mode session is currently active" and stop.

2. Read the identified `state.json`. Display a header summary:

| Instance ID | Goal | Execute Phase | Team |
|---|---|---|---|
| `<id>` | `<goal>` | `<execute.phase>` | `<team_name>` |

3. Display **Execute Core State**:

   - **Goal**: `goal`
   - **Execute Phase**: `execute.phase`
   - **Plan Ref**: `execute.plan_ref`
   - **Plan Hash**: `execute.plan_hash`
   - **Plan Drift**: `execute.plan_drift_detected` — if `true`, display `DRIFT DETECTED — resolve via /deepwork-execute-amend before proceeding`
   - **Started**: `started_at`
   - **Last Updated**: `last_updated`

4. Display **Authorization Flags** (flat fields under `execute`):

   | Flag | Value |
   |---|---|
   | `execute.authorized_push` | `<value>` |
   | `execute.authorized_force_push` | `<value>` |
   | `execute.authorized_prod_deploy` | `<value>` |
   | `execute.authorized_local_destructive` | `<value>` |
   | `execute.secret_scan_waived` | `<value>` |

   If all flags are absent, display "(not yet set — SETUP incomplete)".

5. Display **Written Bar** (`bar[]`):

   | ID | Criterion | Verdict | Categorical Ban | Evidence Required |
   |---|---|---|---|---|

   Or "(not yet populated)" if empty.

6. Display **Change Log** (`execute.change_log[]`). For each entry:

   | Entry ID | Plan Section | Files Touched | PA | EG | RA | Critic Verdict |
   |---|---|---|---|---|---|---|

   Where PA/EG/RA come from `critic_dimensions.PA`, `critic_dimensions.EG`, `critic_dimensions.RA` (show "pending" if absent). Display "(no changes yet)" if empty.

7. Display **Scope Amendments** (`execute.scope_amendments[]`):

   | SA ID | Gate ID | Amendment File | Reason | Approved At |
   |---|---|---|---|---|

   Or "(none)" if empty.

8. Display **Rollback Log** (`execute.rollback_log[]`):

   | Entry ID | Gate ID | Reason | Rolled Back At |
   |---|---|---|---|

   Or "(none)" if empty.

9. Display **Test Manifest** (`execute.test_manifest[]`). For each entry:

   | Test ID | Command | Last Result | Last Run At | Environment |
   |---|---|---|---|---|

   Read `test-results.jsonl` from the instance directory if present. Show the most recent result per `test_id` in the Last Result column. Display "(not yet populated)" if `test_manifest` is empty.

10. Display **Environment Attestations** (`execute.env_attestations[]`):

    | Env | Status | Attested At | Attested By |
    |---|---|---|---|

    Or "(not yet attested)" if empty.

11. Call `TaskList` to get live task status. Display tasks grouped by status (`in_progress`, `pending`, `completed`) with `owner` and `metadata.bar_id` where available.

12. Display **Recent Discoveries** (last 5 entries from `discoveries.jsonl`):

    | Discovery ID | Type | Detected By | Proposed Outcome | Resolution |
    |---|---|---|---|---|

    Read `discoveries.jsonl` as newline-delimited JSON. Show "(none)" if file absent or empty. Show `resolution` as "(open)" if null or absent.

13. Read the last 50 lines of `.claude/deepwork/<id>/log.md` and display as **Recent Activity**.

14. If `execute.plan_drift_detected` is `true`, close with a highlighted notice:

    ```
    PLAN DRIFT DETECTED
    Plan hash stored in state does not match plan_ref on disk.
    Run /deepwork-execute-amend <gate-id> to re-verdict the affected gate before resuming.
    ```

Format everything as a clean, readable dashboard. Use markdown tables; keep output scannable.
