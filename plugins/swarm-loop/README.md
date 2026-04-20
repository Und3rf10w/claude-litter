# Swarm Loop

Swarm Loop is an orchestrated multi-agent iterative development system for Claude Code. It decomposes complex goals into parallel subtasks, creates a persistent agent team that spans the entire loop, tracks structured progress through the native task system, and drives autonomous iteration via hook-based sentinel signaling until a user-defined completion promise is genuinely fulfilled.

## Profiles

Swarm Loop supports multiple orchestration modes via a **profile system**. Each profile provides a different orchestrator prompt, completion mechanism, and state schema — while sharing the same setup, hooks, and infrastructure.

| Profile | Alias Command | Description |
|---------|---------------|-------------|
| `default` | `/swarm-loop` | Persistent Teams with TaskCreate coordination. Best for complex multi-file implementation. |
| `leanswarm` | — | Lean 4-concern orchestration (WORK/MONITOR/VERIFY/SIGNAL). Same Teams coordination as default with less prescriptive scaffolding. |
| `deepplan` | `/deepplan` | Multi-agent planning with explore/synthesize/critique/deliver phases. Spawns 3 scout agents, synthesizes findings, self-critiques, delivers via ExitPlanMode. Best for codebase analysis and structured plan generation. |
| `async` | `/async-swarm` | Background agent orchestration with `run_in_background: true`. No Teams, no SendMessage — agents run independently and notify on completion. Supports worktree isolation. Best for independent parallel tasks. |

Select a profile with `--mode <name>` or use the alias command:

```sh
# Default mode (persistent Teams)
/swarm-loop Build a REST API --completion-promise 'All endpoints work'

# Deepplan mode (planning only)
/deepplan Plan auth migration --completion-promise 'Plan complete and approved'

# Async mode (background agents)
/async-swarm Build REST API --completion-promise 'All endpoints work'

# Any mode via --mode flag
/swarm-loop Build API --mode async --completion-promise 'Done'
```

### Adding a Profile

Create a directory under `profiles/<name>/` with these files:

| File | Required | Purpose |
|------|----------|---------|
| `PROFILE.md` | Yes | Orchestrator prompt template with `{{GOAL}}`, `{{PROMISE}}`, `{{TEAM_NAME}}`, `{{ITERATION}}`, `{{TEAMMATES_ISOLATION}}`, `{{TEAMMATES_MAX_COUNT}}`, `{{WORKTREE_NOTE}}`, `{{COMPACT_NOTE}}` placeholders |
| `completion.sh` | Yes | Defines `check_completion()` — sets `COMPLETION_DETECTED` and optionally `COMPLETION_BLOCK_REASON` |
| `reinject.sh` | Yes | Defines `build_reinject_prompt()` — sets `REINJECT_PROMPT` for stop-hook re-injection |
| `state-schema.json` | No | Additional state fields merged into the base schema. Empty `{}` if no extensions needed. |

## Requirements

- **Agent teams** — `TeamCreate` tool must be available (Claude Code experimental agent teams)
- **jq** — required for the stop hook and state management
- **perl** — required for promise extraction in the stop hook
- **Git** (optional) — required only when using worktree isolation for teammates

## Quick Start

```sh
/swarm-loop GOAL --completion-promise 'TEXT'
```

Example:

```sh
/swarm-loop Build a REST API with auth and tests --completion-promise 'All endpoints work and tests pass'
```

With optional verification:

```sh
/swarm-loop Refactor auth to JWT --completion-promise 'JWT auth working' --verify 'npm test'
```

## How It Works

1. **Setup** — the `/swarm-loop` command initializes an instance directory under `.claude/swarm-loop/<id>/`, creates the narrative log, and generates all safety hooks into `settings.local.json`. A backup of any existing `settings.local.json` is taken and restored on completion or cancellation.
2. **Team creation** — the orchestrator calls `TeamCreate` once. The same team is reused across every iteration. `TeamCreate` is never called again during a running loop.
3. **7-step cycle** — each iteration runs: ASSESS → PLAN → EXECUTE → MONITOR → VERIFY → PERSIST → SIGNAL (the `leanswarm` profile collapses this to 4 concerns: WORK → MONITOR → VERIFY → SIGNAL).
4. **Sentinel file** — at the end of each SIGNAL step the orchestrator writes the instance sentinel file (`<instance-dir>/next-iteration`, Write tool, empty content). The Stop hook detects this file, consumes it, writes a fallback log entry if the orchestrator skipped PERSIST, and re-injects the full orchestrator prompt to begin the next iteration.
5. **Context management** — when the context window fills, Claude Code triggers auto-compaction automatically. The `SessionStart(compact)` hook re-injects orchestrator identity and key state so the loop resumes correctly. The `SessionStart(clear)` hook does the same if the user manually runs `/clear`. The optional `compact_on_iteration` setting causes the orchestrator to run `/compact` proactively at the end of every SIGNAL step.
6. **Completion** — `<promise>TEXT</promise>` output by the orchestrator is the primary exit mechanism. The Stop hook extracts and verifies the promise before accepting it. Use `--min-iterations N` to force a minimum number of passes before the promise is honored, and `--max-iterations N` to force-stop after a hard ceiling.

## Commands

| Command | Description |
|---------|-------------|
| `/swarm-loop GOAL --completion-promise 'TEXT'` | Start a new swarm loop (default profile) |
| `/deepplan PROMPT --completion-promise 'TEXT'` | Start a deepplan session (multi-agent planning) |
| `/async-swarm GOAL --completion-promise 'TEXT'` | Start an async swarm loop (background agents) |
| `/swarm-status` | View iteration count, phase, task status, team roster, and recent log entries |
| `/cancel-swarm` | Stop the active loop, call `TeamDelete`, and clean up instance files |
| `/swarm-settings` | Configure loop behavior (stored in `.claude/swarm-loop.local.md`) |
| `/swarm-help` | Show detailed orchestration instructions and command reference |

## Options

| Option | Description | Default |
|--------|-------------|---------|
| `--completion-promise 'TEXT'` | Statement that must be true for the loop to exit (required) | — |
| `--soft-budget N` | Iteration count for a progress reflection checkpoint (not a hard limit) | `10` |
| `--min-iterations N` | Hard minimum — promise suppressed until N iterations complete | `0` (disabled) |
| `--max-iterations N` | Hard ceiling — force-stops the loop after N iterations | `0` (unlimited) |
| `--verify 'CMD'` | Shell command that must exit 0 when the promise is output (e.g., `npm test`) | none |
| `--safe-mode true\|false` | Enable or disable hook-based safe mode | `true` |
| `--mode NAME` | Profile to use (`default`, `leanswarm`, `deepplan`, `async`, or any custom profile) | `default` |
| `--prompt-file PATH` | Read the goal and flags from a file instead of positional arguments. Supports multiline markdown. Overrides positional `GOAL` words. | none |

## Configuration

`/swarm-settings` reads and writes `.claude/swarm-loop.local.md`. Settings take effect on the next `/swarm-loop` start. To change settings on a running loop, edit the instance state file (`.claude/swarm-loop/<id>/state.json`) directly.

The config file uses YAML frontmatter format:

```yaml
---
compact_on_iteration: false
min_iterations: 0
max_iterations: 0
sentinel_timeout: 600
classifier:
  enabled: true
  model: sonnet
  effort: auto
  checks:
    pre-tool-use: true
    task-completed: false
teammates:
  isolation: worktree
  max-count: 8
notifications:
  enabled: false
  channel: null
---
```

| Setting | Default | Description |
|---------|---------|-------------|
| `compact_on_iteration` | `false` | Run `/compact` at the end of each iteration (proactive context trimming) |
| `min_iterations` | `0` | Minimum iterations before completion promise is honored (0 = disabled) |
| `max_iterations` | `0` | Hard iteration ceiling — force-stops the loop (0 = unlimited) |
| `sentinel_timeout` | `600` | Seconds before force re-inject if no sentinel detected (stuck orchestrator recovery) |
| `classifier.enabled` | `true` | Enable the safety classifier for Bash commands |
| `classifier.model` | `sonnet` | Model used by the classifier (`haiku`, `sonnet`, `opus`) |
| `classifier.effort` | `auto` | Effort level for the classifier (`low`, `medium`, `high`, `max`, `auto`) |
| `classifier.checks.pre-tool-use` | `true` | Evaluate Bash commands through the classifier before execution |
| `classifier.checks.task-completed` | `false` | Run a classifier hook to verify task completion |
| `teammates.isolation` | `worktree` | Teammate isolation mode (`shared` or `worktree`) |
| `teammates.max-count` | `8` | Maximum number of teammates active simultaneously |
| `notifications.enabled` | `false` | Enable external webhook notifications |
| `notifications.channel` | `null` | Webhook URL to receive task completion notifications |

## Safety Layer

Inspired by [Anthropic's permission classifier used in auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode), safety hooks are generated into `settings.local.json` at setup time. The backup of any pre-existing `settings.local.json` is restored on normal completion or cancellation.

- **PermissionRequest hook** — auto-approves Edit, Write, Read, Glob, and Grep operations without prompting. Synchronous. Active when `--safe-mode true` (default).

- **PreToolUse classifier** — evaluates Bash commands before execution. Blocks dangerous operations (force push, external code execution, credential access) and allows safe ones. When `classifier.effort` is `auto` (default), a native prompt hook is used. When effort is explicitly set to `low`, `medium`, `high`, or `max`, a command hook using `claude -p --bare --effort <level>` is used instead. Configurable model: `haiku` (fast/cheap), `sonnet` (default), `opus` (thorough).

- **SubagentStart injection** — automatically injects safety constraints into every teammate context at spawn time. Synchronous. Active when `--safe-mode true`.

- **SubagentStop cleanup** — logs warning when teammates stop with incomplete tasks. Captures last assistant message for debugging. Asynchronous. Always active.

- **SessionStart(clear|compact)** — re-injects orchestrator identity and key state after auto-compaction or a manual `/clear`. Synchronous. Always active.

- **PreCompact context injection** — injects orchestrator identity (goal, iteration, team, task status) into compaction instructions. Synchronous. Always active (registered in `hooks.json`).

- **PostToolUse heartbeat** — updates the instance `heartbeat.json` file after every tool call. Asynchronous (non-blocking). Throttled to at most one write every 5 seconds to avoid I/O pressure during rapid tool use.

- **StopFailure observability** — logs API errors (rate limit, billing, server) to instance log, sets autonomy_health to degraded, updates heartbeat. Asynchronous. Always active.

- **PermissionDenied tracking** — records teammate permission failures (tool name, reason, input summary) to `permission_failures` in `state.json` and logs to `log.md`. Enables the stop hook's permission-aware stuck escalation without relying on the orchestrator to manually track failures. Asynchronous. Always active.

- **TaskCompleted notifications** — sends a webhook request when a task completes. Asynchronous. Active only when `notifications.enabled: true` and `notifications.channel` is set.

- **TaskCompleted verification** — runs a classifier prompt to verify that a task was genuinely completed before accepting it. Asynchronous. Active only when `classifier.checks.task-completed: true` (default: `false`).

## Teammate Configuration

### Isolation Modes

**`shared`** — all teammates work on the same checkout. File ownership is partitioned by the orchestrator at PLAN time — each teammate receives an explicit list of files it is responsible for. No git required.

**`worktree`** (default) — each teammate receives an isolated git worktree via the `isolation: "worktree"` field on the `Agent` call. No file conflicts are possible. After teammates complete, the orchestrator merges their branches in dependency order. Requires git.

Set the mode globally via `/swarm-settings` (`teammates.isolation`) or choose per-loop based on whether file ownership can be cleanly partitioned.

### Teammate Count

`teammates.max-count` (default `8`) caps the number of simultaneously active teammates. The orchestrator respects this limit when spawning in the EXECUTE step.

## Context Management

Context management across long-running loops is handled by a layered set of mechanisms:

- **Auto-compaction** fires automatically when the context window fills. Claude Code handles the compaction; the `SessionStart(compact)` hook re-injects orchestrator identity immediately after so the loop continues without manual intervention.
- **`SessionStart(clear)` hook** provides the same re-injection if the user runs `/clear` manually.
- **Stop hook re-injection** re-injects the full orchestrator prompt at every iteration boundary. This is the primary mechanism for maintaining orchestrator identity across iterations.
- **`compact_on_iteration`** (optional, default `false`) — when enabled, the orchestrator runs `/compact` at the end of each SIGNAL step before writing the sentinel. This proactively trims context at a predictable point in the cycle.

## The 7-Step Orchestration Cycle

Inspired by [Anthropic's harness research on long-running harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps), each iteration executes these steps in order:

1. **ASSESS** — read the instance state file (`<instance-dir>/state.json`) and log file (`<instance-dir>/log.md`) from disk; call `TaskList` to review current task status (pending, in-progress, blocked, completed).

2. **PLAN** — decompose remaining work into concrete, parallelizable subtasks; call `TaskCreate` with `blockedBy` dependencies to model ordering; assign explicit file ownership to each task.

3. **EXECUTE** — spawn teammates into the persistent team for each unblocked task using `Agent` (or `SendMessage` to idle teammates from previous iterations); respect `teammates_isolation` and `teammates_max_count` from state.

4. **MONITOR** — receive teammate completion messages via `SendMessage`; persist key results to the instance log file and update `last_updated` in state immediately on receipt — do not defer to the PERSIST step (microcompact may clear old tool results). Progress tracking to `progress.jsonl` is handled automatically by the TaskCompleted gate hook. Check `TaskList` for newly unblocked tasks and spawn teammates for them.

5. **VERIFY** — read modified files; run the configured `--verify` command if present; check for regressions.

6. **PERSIST** — update the instance state file fields `phase`, `autonomy_health`, and `last_updated`; append a full iteration summary to the instance log file including completed work, failed approaches, and the next iteration plan.

7. **SIGNAL** — if `compact_on_iteration` is `true`, run `/compact` first; then write the instance sentinel file (`<instance-dir>/next-iteration`, Write tool, empty content); end the turn. The Stop hook consumes the sentinel and re-injects the orchestrator prompt.

## Files

| File | Purpose |
|------|---------|
| `.claude/swarm-loop/<id>/state.json` | Structured state: goal, iteration, phase, team name, autonomy health, permission failures (v2 schema) |
| `.claude/swarm-loop/<id>/log.md` | Narrative iteration history: completed work, failed approaches, next-iteration plans — the orchestrator's cross-iteration memory |
| `.claude/swarm-loop/<id>/progress.jsonl` | Append-only progress tracking: one compact JSON line per task completion, written by the TaskCompleted gate hook. Read by stop-hook for stall detection. |
| `.claude/swarm-loop/<id>/heartbeat.json` | Real-time monitoring: written on every Stop event and by the PostToolUse hook (throttled 5s) |
| `.claude/swarm-loop/<id>/next-iteration` | Sentinel file: written by the orchestrator to signal iteration complete; consumed by the Stop hook |
| `.claude/swarm-loop/<id>/verify.sh` | Generated verification script (created when `--verify` is used) |
| `.claude/swarm-loop/<id>/.idle-retry.<name>` | Per-teammate retry counter for TeammateIdle gate hook (cleaned on completion and rejection) |
| `.claude/swarm-loop.local.md` | Per-project settings: written by `/swarm-settings`, read at next loop start (shared across all instances) |
| `.claude/swarm-loop.local.lock` | Concurrent setup guard: prevents two `/swarm-loop` invocations from racing during initialization |
| `.claude/settings.local.json` | Modified with swarm hooks at setup; backed up before modification and restored on completion or `/cancel-swarm` |

## Multi-Instance Support

Each `/swarm-loop` invocation creates an isolated instance directory under `.claude/swarm-loop/<id>/` where `<id>` is an 8-character hex identifier derived from the session. This allows multiple loops to run concurrently in the same repo from different terminal sessions.

Instance files (per-loop):
- `.claude/swarm-loop/<id>/state.json`
- `.claude/swarm-loop/<id>/log.md`
- `.claude/swarm-loop/<id>/next-iteration`
- `.claude/swarm-loop/<id>/heartbeat.json`

Shared files (all loops):
- `.claude/swarm-loop.local.md` — per-project configuration
- `.claude/swarm-loop.local.lock` — setup guard

Use `/swarm-status` to see all active instances and `/cancel-swarm` to stop one.

## Hook Architecture

The plugin uses two distinct hook registration mechanisms:

- **Static hooks** — declared in `hooks/hooks.json` and loaded by Claude Code at plugin load time:
  - `Stop` → `stop-hook.sh` — drives iteration via sentinel detection, completion checking, stuck detection, and cleanup
  - `TeammateIdle` → `teammate-idle-gate.sh` — enforces task completion discipline: teammates with in_progress tasks are forced to keep working (up to 3 retries) until they call `TaskUpdate(completed)` + `SendMessage(to: 'team-lead')`. Logs retries to `log.md`; writes `hook_warnings` to `state.json` after max retries.
  - `PreCompact` → `pre-compact.sh` — injects swarm orchestrator context (goal, iteration, team, task status) into compaction instructions so post-compact model retains orchestrator knowledge

- **Dynamic hooks** — injected into the project's `.claude/settings.local.json` at loop-start time by `setup-swarm-loop.sh`. These are not listed in `hooks/hooks.json` because they are only active during a running swarm loop and are removed on completion or `/cancel-swarm`. The dynamically-injected hooks are:
  - `session-context.sh` — `SessionStart(compact|clear)` hook that re-injects orchestrator identity after context compaction or `/clear`
  - `heartbeat-update.sh` — `PostToolUse` hook that writes the instance `heartbeat.json` file (throttled to every 5s)
  - `task-completed-gate.sh` — `TaskCompleted` gate hook with two responsibilities: (1) append-only progress tracking via `progress.jsonl` (compact JSONL, atomic O_APPEND), (2) deepplan artifact verification via `metadata.artifact` from task files
  - `task-created-gate.sh` — `TaskCreated` gate hook enforcing `teammates_max_count` cap (rejects `TaskCreate` when active tasks >= cap)
  - Deepplan scope classifier — `TaskCreated` prompt hook (Haiku) that blocks implementation tasks in deepplan mode (planning only)
  - `notify-task-complete.sh` — `TaskCompleted` hook that sends webhook notifications on task completion (active only when `notifications.enabled: true`)
  - Inline `TaskCompleted` prompt hook — verifies that a task was genuinely completed via classifier (active only when `classifier.checks.task-completed: true`)
  - `subagent-stop.sh` — `SubagentStop` async hook that logs teammate crash recovery warnings when teammates stop with in_progress tasks, captures last_assistant_message, cleans up idle-retry counters
  - `stop-failure.sh` — `StopFailure` async hook that logs API errors (rate_limit, billing_error, server_error, etc.), sets autonomy_health to degraded, updates heartbeat with error status
  - `permission-denied.sh` — `PermissionDenied` async hook that records teammate permission failures (tool name, reason, input summary) to `permission_failures` in `state.json` and logs to `log.md`. Enables the stop hook's permission-aware stuck escalation without relying on the orchestrator to manually track failures.

## Architecture Notes

- **Persistent team** — `TeamCreate` is called once. The team and its task records survive all iterations. `TeamDelete` is never called during a normal loop; only `/cancel-swarm` calls it. Old team directories from prior loops are cleaned up by the next `/swarm-loop` setup or by `/cancel-swarm`.

- **Native task system** — `TaskCreate` / `TaskUpdate` / `TaskList` is the single source of truth for task status. Tasks are team-scoped and persist for the loop's lifetime. There is no `tasks[]` array in the state file. Progress is tracked via `progress.jsonl` (append-only, written by the `TaskCompleted` gate hook) — not `progress_history` in state.json.

- **Crash resilience** — state and task records survive process crashes. On restart, the next iteration re-reads the instance state file and log file from disk to reconstruct context.

- **Microcompact protection** — Claude Code silently replaces old tool results with `[Old tool result content cleared]` during context trimming. Teammate results must be written to the instance state file and log file immediately in the MONITOR step — not deferred to PERSIST.

- **Sentinel timeout** — if no sentinel file appears within `sentinel_timeout` seconds (default 600) of the last activity, the Stop hook force-reinjects the orchestrator prompt. This recovers from a stuck or crashed orchestrator without requiring manual intervention.

- **Autonomy health** — the state file tracks `autonomy_health` as `"healthy"`, `"degraded"`, or `"escalation_required"` based on accumulated permission failures. Permission failures are recorded mechanically by the `PermissionDenied` hook. After 3 iterations with no progress and active permission failures, the Stop hook injects an escalation message requesting human input.
