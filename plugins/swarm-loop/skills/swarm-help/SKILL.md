---
description: "Explain Swarm Loop plugin and available commands"
---

# Swarm Loop Help

Swarm Loop (v2.0) is an orchestrated multi-agent iterative development system. It uses a persistent agent team, hook-based safety controls, and a sentinel-file mechanism to drive autonomous loops until a user-defined completion promise is fulfilled.

## How It Works

1. You start with `/swarm-loop GOAL --completion-promise 'TEXT'`
2. Setup creates an instance directory under `.claude/swarm-loop/<id>/` and generates safety hooks in `settings.local.json`
3. The orchestrator creates a **persistent team** once — the same team is reused for the entire loop (no teardown between iterations)
4. Each iteration runs through these phases:
   - **ASSESS** — review state, log, and prior results
   - **PLAN** — decompose outstanding work into parallel subtasks
   - **EXECUTE** — delegate subtasks to teammates; teammates report back via SendMessage
   - **MONITOR** — receive teammate completion messages; persist results immediately to state and log (microcompact may clear old messages)
   - **VERIFY** — check whether the completion promise is genuinely fulfilled
   - **PERSIST** — write iteration summary to narrative log and update heartbeat
   - **SIGNAL** — write the instance sentinel file (Write tool, empty content); end turn
5. The Stop hook detects the sentinel file and re-injects the orchestrator prompt to begin the next iteration
6. If auto-compaction is triggered, the SessionStart hook re-injects context so the loop resumes cleanly
7. The loop continues until the completion promise is genuinely true (and the optional `--verify` command passes)

## Commands

### `/swarm-loop GOAL --completion-promise 'TEXT'`
Start a new loop. The `--completion-promise` is required — it is the only exit mechanism.

Options:
- `--completion-promise 'TEXT'` (required) — Statement that must be true for the loop to end
- `--mode NAME` — Execution profile: `default`, `leanswarm`, `deepplan`, or `async` (default: `default`)
- `--soft-budget N` — Iteration count for a progress checkpoint (default: 10, not a hard limit)
- `--min-iterations N` — Hard minimum — promise suppressed until N iterations complete (default: 0, disabled)
- `--max-iterations N` — Hard ceiling — force-stops loop after N iterations (default: 0, unlimited)
- `--verify 'CMD'` — Shell command that must also pass before the loop exits (e.g., `npm test`)
- `--safe-mode true|false` — Enable/disable autonomous safe mode (default: true)

Examples:
```
/swarm-loop Build a REST API with auth and tests --completion-promise 'All endpoints work and tests pass'
/swarm-loop Refactor auth to JWT --completion-promise 'JWT auth working' --verify 'npm test'
/swarm-loop Migrate to TypeScript --completion-promise 'All files converted' --soft-budget 20
/swarm-loop Thorough refactor --completion-promise 'All refactored' --min-iterations 3 --max-iterations 10
```

### `/swarm-status`
View the current progress dashboard: iteration count, phase, mode, task status, team roster, and recent log entries.

### `/cancel-swarm`
Stop the loop, shut down the active team (TeamDelete is called here and only here), and clean up the sentinel file and state file. The instance log file (`.claude/swarm-loop/<id>/log.md`) is preserved for reference.

### `/swarm-help`
Show this help text.

### `/swarm-settings`
Configure safety controls, teammate count, compact mode, and notification preferences. Changes take effect on the next `/swarm-loop` start.

### `/deepplan`
Alias for `/swarm-loop` with `--mode deepplan`. Runs multi-agent planning with explore/synthesize/critique/deliver phases.

### `/async-swarm`
Alias for `/swarm-loop` with `--mode async`. Runs background agent orchestration for independent parallel tasks.

## Profiles

Select an execution profile with `--mode NAME`:

- `default` — Persistent Teams with TaskCreate coordination. Best for complex multi-file implementation.
- `leanswarm` — Lean 4-concern orchestration (WORK/MONITOR/VERIFY/SIGNAL). Same Teams coordination as default with less prescriptive scaffolding. Best for capable models on complex tasks.
- `deepplan` — Multi-agent planning with explore/synthesize/critique/deliver phases. Best for codebase analysis and structured plans. Alias: `/deepplan`
- `async` — Background agent orchestration with run_in_background. Best for independent parallel tasks. Alias: `/async-swarm`

## Key Concepts

- **Completion Promise** — The primary exit mechanism. The orchestrator outputs `<promise>TEXT</promise>` when the statement is genuinely true. The loop will not exit on a soft budget alone.
- **Iteration Bounds** — `--min-iterations N` forces at least N iterations (promise suppressed until then). `--max-iterations N` force-stops the loop after N iterations regardless of promise. Both are optional and independent of `--soft-budget`.
- **Persistent Team** — Created once at loop start and reused across all iterations. TeamDelete is never called between iterations; only `/cancel-swarm` tears the team down.
- **Native Tasks** — TaskCreate/TaskUpdate/TaskList is the primary progress tracker. The state file mirrors this for external visibility.
- **Sentinel File** — The instance sentinel file signals that the current iteration is complete. The Stop hook consumes this file and re-injects the orchestrator prompt.
- **Hook-Based Safety** — Dynamic hooks installed in `settings.local.json`: PermissionRequest (auto-approve safe operations), PreToolUse (classifier blocks dangerous operations), SubagentStart (injects context into each teammate). Additionally, three team coordination hooks enforce task discipline:
  - **TeammateIdle gate** (static, `hooks.json`) — forces teammates to complete tasks + send results before going idle (up to 3 retries)
  - **TaskCompleted gate** (dynamic) — append-only progress tracking via `progress.jsonl` + deepplan artifact verification via task metadata
  - **TaskCreated gate** (dynamic) — max task cap enforcement + deepplan scope classifier (blocks implementation tasks)
  - **SubagentStop cleanup** (dynamic) — logs teammate crash recovery when teammates stop with in_progress tasks; captures last_assistant_message for debugging
  - **StopFailure observability** (dynamic) — logs API errors (rate limit, billing, server), sets autonomy_health to degraded, updates heartbeat with error status
  - **PreCompact context injection** (static, `hooks.json`) — injects swarm orchestrator context (goal, iteration, team, task status) into compaction so post-compact model retains orchestrator identity
- **Safe Mode** — When enabled (default), hooks allow autonomous file edits within the project but block force pushes, external code execution, and credential access. Disable with `--safe-mode false` for supervised sessions.
- **Compact Mode** — The orchestrator may optionally run `/compact` at the end of an iteration to manage context growth. Enabled via `swarm-loop.local.md` config (`compact_on_iteration: true`).
- **Heartbeat** — The instance `heartbeat.json` file is updated after each iteration for external monitoring and health checks.
- **Narrative Log** — The instance `log.md` file is the orchestrator's memory across iterations. Failed approaches must be documented here so they are not retried.

## Options for `/swarm-loop`

| Option | Description | Default |
|---|---|---|
| `--completion-promise 'TEXT'` | Exit condition (required) | — |
| `--mode NAME` | Execution profile: `default`, `leanswarm`, `deepplan`, `async` | `default` |
| `--soft-budget N` | Reflection checkpoint at N iterations | 10 |
| `--min-iterations N` | Hard minimum — promise suppressed until N | 0 (disabled) |
| `--max-iterations N` | Hard ceiling — force-stop after N iterations | 0 (unlimited) |
| `--verify 'CMD'` | Shell command that must pass for exit | none |
| `--safe-mode true\|false` | Enable autonomous safety hooks | true |

## Files

| Path | Purpose |
|---|---|
| `.claude/swarm-loop/<id>/state.json` | Structured state: goal, iteration, phase, team name, autonomy health |
| `.claude/swarm-loop/<id>/log.md` | Narrative history — all iterations, decisions, and failed approaches |
| `.claude/swarm-loop/<id>/progress.jsonl` | Append-only progress: one JSON line per task completion (written by TaskCompleted gate) |
| `.claude/swarm-loop/<id>/heartbeat.json` | Timestamp and iteration count for external monitoring |
| `.claude/swarm-loop/<id>/next-iteration` | Sentinel file written by orchestrator; consumed by Stop hook |
| `.claude/swarm-loop.local.md` | Per-project config: teammate count, model overrides, compact mode (shared across all instances) |
| `.claude/swarm-loop.local.lock` | Concurrent setup guard: prevents two `/swarm-loop` invocations from racing during initialization |

## Multi-Instance Support

Each `/swarm-loop` invocation creates an isolated instance directory under `.claude/swarm-loop/<id>/` where `<id>` is derived from the session. This allows multiple loops to run concurrently in the same repo from different terminal sessions.

Use `/swarm-status` to see all active instances. Use `/cancel-swarm` to select and stop a specific instance.

## Requirements

- **Agent teams**: The TeamCreate tool must be available (experimental agent teams feature)
- **jq**: Required for state file manipulation in hooks
- **perl**: Required for completion promise extraction in the Stop hook
- **Git repository**: Required only when `teammates.isolation` is set to `worktree` via `/swarm-settings`. Not needed for the default shared-checkout mode.
