---
name: swarm-loop
description: >
  Orchestrated multi-agent loops with profile-based modes. Default mode:
  persistent Teams for complex implementation. Deepplan mode: multi-agent
  planning with explore/synthesize/critique/deliver. Async mode: background
  agent orchestration for independent parallel tasks. Triggers on: "build this
  entire feature", "refactor across the codebase", "plan", "deepplan",
  "architect", "async", "background agents", "swarm", "loop until done".
allowed-tools: ["Edit(.claude/swarm-loop.local.*)", "Write(.claude/swarm-loop.local.*)", "Read(.claude/swarm-loop.local.*)", "Edit(.claude/deepplan.local.*)", "Write(.claude/deepplan.local.*)", "Read(.claude/deepplan.local.*)", "Read", "Grep", "Glob", "Bash", "TeamCreate", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "SendMessage", "Agent", "EnterPlanMode", "ExitPlanMode", "AskUserQuestion"]
---

# Swarm Loop — Orchestrated Multi-Agent Iterative Development

You have the ability to start an orchestrated swarm loop for complex tasks. This is a powerful capability — use it wisely.

## When to Suggest a Swarm Loop

Suggest starting a swarm loop when:
- The task involves **multiple independent subtasks** that can be parallelized
- The task requires **iterative refinement** — build, test, fix, repeat
- The user says things like "build the whole thing", "fix everything", "keep going until it works"
- The task touches **many files** across the codebase
- The task has a **clear completion condition** (all tests pass, all endpoints work, etc.)

Do NOT suggest a swarm loop for:
- Simple single-file edits
- Quick bug fixes in one spot
- Questions or research tasks
- Tasks the user wants to supervise step-by-step

### Mode Selection

If the user wants planning without implementation, suggest `--mode deepplan` or `/deepplan`. This runs a multi-agent planning cycle (explore/synthesize/critique/deliver) and produces a plan document without writing code.

If subtasks are fully independent with no coordination needed, suggest `--mode async` or `/async-swarm`. This launches background agents that run in parallel without an orchestration loop.

## How to Start a Swarm Loop

### Option 1: User explicitly asks
If the user runs `/swarm-loop`, follow the command instructions.

### Option 2: You detect the opportunity
If you recognize a task that would benefit from a swarm loop:

1. **Ask the user**: "This looks like a complex multi-step task. Would you like me to start a swarm loop? I'll decompose it into parallel subtasks, create an agent team, and keep iterating until it's done."

2. If they agree, **formulate the completion promise** — a clear statement that will be true when the task is complete. Confirm it with the user.

3. **Start it**: Tell the user to run the slash command, or suggest:
   "Run `/swarm-loop <the goal> --completion-promise '<the promise>'`"

   The `/swarm-loop` command handles all setup — do NOT try to run the setup script directly.

4. Then follow the orchestrator instructions.

## The Orchestration Cycle

Each iteration of the swarm loop follows this 7-step cycle:

### 1. ASSESS
Read `.claude/swarm-loop.local.state.json` and `.claude/swarm-loop.local.log.md` from disk.
Call `TaskList` to get the current task status — which tasks are pending, in progress, blocked, or completed.
Use `TaskGet` on any task that needs closer inspection (e.g., tasks marked completed by teammates in the previous iteration — verify their description matches what was delivered).
Understand what's been done, what failed, and what's remaining.

### 2. PLAN
Decompose remaining work into concrete, parallelizable subtasks.
Use `TaskCreate` for each new subtask. Set `blockedBy` dependencies to model task ordering.
Use `TaskUpdate` to update existing tasks if their scope or description needs to change based on what you learned in ASSESS.

Key principles:
- **Partition file ownership** — no two teammates should modify the same file
- **Clear boundaries** — each teammate should have a well-defined scope
- **Right-size tasks** — not too big (defeats parallelism), not too small (overhead)
- **Set blockedBy** — use `TaskCreate(blockedBy: ["<id>"])` to model dependencies explicitly

### 3. EXECUTE
Spawn teammates into the **persistent team** for each unblocked task. The team was created once at loop start and persists across all iterations — do NOT call TeamCreate again if the team already exists.

For each teammate you spawn:
1. Call `TaskUpdate(taskId, status: "in_progress", owner: "<teammate-name>")` to assign the task
2. Spawn the Agent with the task details
3. The teammate's prompt must instruct them to call `TaskUpdate(status: "completed")` and `SendMessage(to: 'team-lead')` when done

If a teammate from a previous iteration is idle, you can `SendMessage` to them directly instead of spawning a new agent.

Spawn all unblocked teammates in parallel (multiple Agent calls in one turn):

```
Agent(
  team_name: "<team_name from state>",
  name: "auth-builder",
  description: "Implement auth endpoint",
  prompt: "Your task: Create POST /api/auth/login endpoint. Files you own: src/auth.js, tests/auth.test.js.

           SAFETY CONSTRAINTS:
           - Only modify files within this repository's working directory
           - Do not run git push, force push, or modify remote branches
           - Do not download and execute external code (curl | bash, etc.)
           - Do not access credentials or .env files outside this project
           - Do not create background services, cron jobs, or persistent processes
           - If a command is blocked, try an alternative approach (use Edit instead of shell redirect, etc.)
           - If 3 commands are blocked in a row, message team-lead with: PERMISSION_BLOCK: <description>

           When done:
           1. Call TaskUpdate to mark your task as completed
           2. Call SendMessage(to: 'team-lead') with a summary of what you did
           You MUST send a message to the team lead when finished."
)
```

**Check state for teammate configuration** before spawning:
- Read `teammates_isolation` from `.claude/swarm-loop.local.state.json`:
  - If `"worktree"`: add `isolation: "worktree"` to each Agent call. Each teammate gets an isolated git worktree — no file conflicts possible. You'll need to merge their branches after completion.
  - If `"shared"` (default): teammates work on the same checkout. Partition file ownership carefully.
- Read `teammates_max_count` from state: do not spawn more than this many teammates simultaneously.

Principles:
- Include the SAFETY CONSTRAINTS block in EVERY teammate prompt
- Partition file ownership explicitly — no two teammates should modify the same file
- Keep teammate prompts focused: task, files owned, safety constraints, completion protocol
- After spawning all teammates, update `last_updated` in state before ending your turn (resets the sentinel timeout clock while teammates work)

#### Worktree Isolation (optional)

For tasks where multiple teammates modify files in overlapping areas, add `isolation: "worktree"` to give each teammate their own git worktree. This can also be configured globally via `/swarm-settings` (`teammates.isolation: worktree`) — when set, the state file's `teammates_isolation` field will be `"worktree"` and you should use it for all Agent calls:

```
Agent(
  team_name: "<team_name>",
  name: "auth-builder",
  description: "Implement auth endpoint",
  isolation: "worktree",
  prompt: "Your task: ... (include SAFETY CONSTRAINTS) When done, call TaskUpdate and SendMessage(to: 'team-lead')."
)
```

When using worktree isolation:
- Each teammate works in an isolated copy of the repository — no file conflicts possible
- After teammates complete, merge their branches: `git merge <worktree-branch>`
- Merge in dependency order — foundational changes first, dependent changes after
- If a merge conflict occurs, resolve it or spawn a dedicated conflict-resolution teammate
- Requires a git repository

Use worktree isolation when:
- Tasks have overlapping file ownership that can't be cleanly partitioned
- Multiple teammates need to modify shared configuration files
- The risk of file conflicts outweighs the overhead of merging

Skip worktree isolation when:
- File ownership can be cleanly partitioned (the common case)
- Tasks are read-only (research, analysis)
- The project is not a git repository

### 4. MONITOR

> **MICROCOMPACT WARNING**: Claude Code runs a time-based microcompact that silently replaces old tool results with `[Old tool result content cleared]`. If you defer recording teammate results, their message content may be wiped before you can persist it. You MUST extract and persist key results IMMEDIATELY on receipt — do not wait for the PERSIST step.

Receive teammate completion messages. Each arrives as a new turn via SendMessage.

For each completion, **immediately**:
1. Extract the key results from the message (file paths changed, outcomes, errors)
2. Call `TaskList` to confirm the teammate marked their task as completed
3. If the teammate forgot to call `TaskUpdate`, call it yourself: `TaskUpdate(taskId, status: "completed")`
4. Update `progress_history` AND `last_updated` in `.claude/swarm-loop.local.state.json` with a summary entry
5. Append a result summary to `.claude/swarm-loop.local.log.md`
6. Call `TaskList` again to check if blocked tasks are now unblocked
7. For newly unblocked tasks, go back to EXECUTE — assign them via `TaskUpdate` and spawn teammates

Continue until all tasks are complete or blocked.

### 5. VERIFY
Once all teammates have reported completion:
- Call `TaskList` to confirm every task for this iteration is marked `completed`
- If any tasks are still `in_progress` or `pending`, do NOT proceed — go back to MONITOR and wait
- Read modified files to confirm correctness
- Run the configured verify command if present (`verify_command` in state file)
- Check for regressions
- Update `last_updated` in state after verification completes (prevents sentinel timeout during long test runs)
- If verification fails, use `TaskCreate` to create fix-up tasks and go back to EXECUTE

### 6. PERSIST
Update `.claude/swarm-loop.local.state.json` — set `phase`, `autonomy_health`, and `last_updated`.

Append an iteration summary to `.claude/swarm-loop.local.log.md`:

```markdown
## Iteration 3 — Integration Tests

**Completed this iteration:**
- Auth endpoint tests (3/3 passing)
- Added error handling for invalid tokens

**Failed/Blocked:**
- Database connection pool test — needs mock setup

**Approaches tried and abandoned:**
- Tried mocking the connection pool directly — too brittle, switched to test containers

**Next iteration plan:**
- Fix DB mock, complete integration tests
- Add rate limiting

**Teammates spawned:** 2 (auth-builder, db-mock-writer)
```

IMPORTANT: Always document failed approaches and dead ends. Your future self (or a fresh context after compaction) will re-read this log — if you don't record what didn't work, you'll waste iterations retrying it.

### 7. SIGNAL
If `compact_on_iteration` is `true` in the state file, run `/compact` first. This proactively trims context and the `SessionStart(compact)` hook will re-inject your orchestrator identity.

Then write the sentinel file to signal readiness for the next iteration (ensure it's in the local `./claude/` dir), e.g. `Write(.claude/swarm-loop.local.next-iteration)`

End your turn. The stop hook will consume the sentinel and re-inject the full orchestrator prompt for the next iteration.

If `compact_on_iteration` is `false` (default), skip `/compact` and just write the sentinel.

## Completion

When ALL tasks are complete and verified:
1. Call `TaskList` one final time to confirm every task across all iterations is `completed`
2. Send `shutdown_request` to each teammate via SendMessage and wait for `shutdown_response`
3. Do NOT call TeamDelete — team and task records are preserved for crash resilience
4. Update the state file — set phase to `"complete"`
5. Write a final log entry summarizing all work done
6. Output: `<promise>YOUR_COMPLETION_PROMISE</promise>`

The promise MUST be genuinely true. The stop hook runs a verification check before accepting it.

**TeamDelete is ONLY called by `/cancel-swarm`.** Normal loop completion shuts down teammates but leaves the team directory and task list intact. Old team directories from previous loops are cleaned up by the next `/swarm-loop` setup or by `/cancel-swarm`.

## Context Management

Context management is automatic — you do not need to manage it manually:
- **Auto-compaction** fires when the context window fills. The `SessionStart(compact)` hook re-injects your orchestrator identity and key instructions automatically.
- **Manual `/clear`**: The `SessionStart(clear)` hook re-injects context if the user manually clears.
- **Stop hook re-inject**: The stop hook re-injects the full orchestrator prompt at every iteration boundary — this is the primary context driver.
- **Compact mode** (optional): When `compact_on_iteration: true`, you run `/compact` explicitly at the end of each iteration (step 7, SIGNAL) for proactive context trimming.

## Safety and Autonomy

Safety hooks are generated into `settings.local.json` at loop setup time:
- **PermissionRequest** auto-approve: File operations (Edit/Write/Read/Glob/Grep) are approved automatically
- **PreToolUse classifier**: Bash commands are evaluated by the classifier before execution — blocks dangerous operations, allows safe ones
- **SubagentStart safety injection**: Safety context is automatically injected into all teammates at spawn time (hook-based, no classify-prompt.sh needed)
- **SessionStart re-inject**: Orchestrator identity restored after any context management event

### Teammate Safety Template

Include the SAFETY CONSTRAINTS block in EVERY teammate prompt (shown in the EXECUTE step above). This is your primary defense against unsafe teammate actions. The hooks provide a second layer of defense automatically.

### Permission Failure Handling

When a teammate reports `PERMISSION_BLOCK` in their message:
1. Log it to the state file's `permission_failures` array with iteration, teammate name, and description
2. Note what operation was attempted and why it was blocked
3. In the next iteration, redesign that task to avoid the blocked operation
4. After 3 iterations with no progress AND permission failures, the stop hook will inject an escalation message

Update `autonomy_health` in the state file:
- `"healthy"` — no permission issues
- `"degraded"` — some permission blocks but still making progress
- `"escalation_required"` — stuck on permissions, needs human input

## Task System

The **native task system** (`TaskCreate`/`TaskUpdate`/`TaskList`) is the single source of truth for task status. It is team-scoped and persists for the lifetime of the team (which spans the entire loop — no TeamDelete between iterations).

The **state file** (`progress_history` array) records per-task completion entries with running totals. Write to `progress_history` immediately when each teammate completes (MONITOR step), not in a batch at the end.

There is no `tasks[]` array in the state file. If you see one from a v1.x loop, ignore it.

## File Tool Usage

- Use **Read** to read `.claude/swarm-loop.local.state.json` and `.claude/swarm-loop.local.log.md`
- Use **Edit** to update fields in `.claude/swarm-loop.local.state.json` (e.g., `progress_history`, `phase`, `last_updated`)
- Use **Edit** to append to `.claude/swarm-loop.local.log.md`
- Use **Write** to create the sentinel (`.claude/swarm-loop.local.next-iteration`, empty content) and new files
- Do NOT use Bash (`cat`, `echo`, `jq`, `touch`) to read or modify state/log/signal files — use Read/Edit/Write
- Bash is ONLY for: `rm -f` (cleanup), `mkdir -p`, running tests, git operations

## Requirements

- **Agent teams**: The `TeamCreate` tool must be available. If not, the user needs to enable experimental agent teams or update Claude Code.
- **jq**: Required for the stop hook and setup scripts.
- **perl**: Required for promise extraction in the stop hook.
- **Git repository** (optional): Required only if using worktree isolation for teammates.
