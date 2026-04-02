# Hook System Research: CC v2.1.90 Minified Source

Source: `/Users/jechavarria/tmp/cclatest/package/cli_formatted_2.1.90.js` (650,360 lines)
Reference: `/Users/jechavarria/tmp/cclatest/src/claude-code/src/` (raw TypeScript source)
Date: 2026-04-02

---

## Summary

The raw TypeScript source and the minified v2.1.90 build are **in sync**: all hook events, schemas, and behaviors match. This means the raw source at `~/tmp/cclatest/src/claude-code` is the authoritative reference for v2.1.90.

---

## Complete Hook Event List (v2.1.90)

From `cli_formatted_2.1.90.js` line 53092 (array `UR`):

```
PreToolUse
PostToolUse
PostToolUseFailure
Notification
UserPromptSubmit
SessionStart
SessionEnd
Stop
StopFailure
SubagentStart
SubagentStop
PreCompact
PostCompact
PermissionRequest
PermissionDenied
Setup
TeammateIdle
TaskCreated
TaskCompleted
Elicitation
ElicitationResult
ConfigChange
WorktreeCreate
WorktreeRemove
InstructionsLoaded
CwdChanged
FileChanged
```

Total: **27 hook events**.

---

## Hook Types (Configuration)

Four hook types exist (minified line 53134–53268):

| Type | Key field | Notes |
|------|-----------|-------|
| `command` | `command` (shell string) | BashCommandHook — classic shell hook |
| `prompt` | `prompt` (string with `$ARGUMENTS`) | LLM prompt hook — evaluates via AI |
| `http` | `url` | HTTP POST hook |
| `agent` | `prompt` | Agentic verifier hook — spawns subagent |

All four support: `if`, `timeout`, `statusMessage`, `once`.
`command` additionally supports: `async`, `asyncRewake`, `shell`.
`prompt` and `agent` additionally support: `model`.
`http` additionally supports: `headers`, `allowedEnvVars`.

---

## Hook Event Schemas (stdin JSON fields)

Each event provides these **base fields** via `d$()` (line 567981):

```json
{
  "session_id": "...",
  "transcript_path": "...",
  "cwd": "...",
  "permission_mode": "...",
  "agent_id": "...",    // present for tool-lifecycle events
  "agent_type": "..."   // present for tool-lifecycle events
}
```

### Tool-lifecycle events

**PreToolUse** (line 392534):
```json
{ "hook_event_name": "PreToolUse", "tool_name": "...", "tool_input": {}, "tool_use_id": "..." }
```
- Exit 0: stdout/stderr not shown
- Exit 2: show stderr to model and BLOCK tool call
- Other: show stderr to user, continue

**PostToolUse** (line 392554):
```json
{ "hook_event_name": "PostToolUse", "tool_name": "...", "tool_input": {}, "tool_response": {}, "tool_use_id": "..." }
```
- Exit 0: stdout shown in transcript mode (ctrl+o)
- Exit 2: show stderr to model immediately
- Other: show stderr to user only

**PostToolUseFailure** (line 392565):
```json
{ "hook_event_name": "PostToolUseFailure", "tool_name": "...", "tool_input": {}, "tool_use_id": "...", "error": "...", "is_interrupt": bool }
```
- Exit 0: stdout shown in transcript mode
- Exit 2: show stderr to model immediately
- Other: show stderr to user

**PermissionRequest** (line 392544):
```json
{ "hook_event_name": "PermissionRequest", "tool_name": "...", "tool_input": {}, "permission_suggestions": [] }
```
- Exit 0: use hook decision if provided in JSON output
- Other: show stderr to user

**PermissionDenied** (line 392577):
```json
{ "hook_event_name": "PermissionDenied", "tool_name": "...", "tool_input": {}, "tool_use_id": "...", "reason": "..." }
```
- Exit 0: stdout shown in transcript mode
- Other: show stderr to user only
- Can return `{"hookSpecificOutput":{"hookEventName":"PermissionDenied","retry":true}}` to allow model retry

### Session events

**SessionStart** (line 392606):
```json
{ "hook_event_name": "SessionStart", "source": "startup|resume|clear|compact", "agent_type": "...", "model": "..." }
```
- Exit 0: stdout shown to Claude
- Blocking errors are ignored
- Matcher on `source`

**SessionEnd** (line 392839):
```json
{ "hook_event_name": "SessionEnd", "reason": "clear|resume|logout|prompt_input_exit|other|bypass_permissions_disabled" }
```
- Exit 0: command completes successfully
- Other: show stderr to user
- Matcher on `reason`

**Setup** (line 392616):
```json
{ "hook_event_name": "Setup", "trigger": "init|maintenance" }
```
- Exit 0: stdout shown to Claude
- Blocking errors are ignored
- Matcher on `trigger`

### Conversation events

**UserPromptSubmit** (line 392598):
```json
{ "hook_event_name": "UserPromptSubmit", "prompt": "..." }
```
- Exit 0: stdout shown to Claude
- Exit 2: BLOCK processing, erase original prompt, show stderr to user
- Other: show stderr to user

**Stop** (line 392624):
```json
{ "hook_event_name": "Stop", "stop_hook_active": bool, "last_assistant_message": "..." }
```
- Exit 0: stdout/stderr not shown
- Exit 2: show stderr to model and CONTINUE conversation
- Other: show stderr to user

**StopFailure** (line 392638):
```json
{ "hook_event_name": "StopFailure", "error": {...}, "error_details": "...", "last_assistant_message": "..." }
```
- Fire-and-forget: hook output and exit codes are IGNORED
- Fires instead of Stop when API error ends the turn
- Matcher on `error` type: `rate_limit`, `authentication_failed`, `billing_error`, `invalid_request`, `server_error`, `max_output_tokens`, `unknown`

### Compaction events

**PreCompact** (line ~392674):
```json
{ "hook_event_name": "PreCompact", "trigger": "manual|auto", "custom_instructions": null }
```
- Exit 0: stdout appended as custom compact instructions
- Exit 2: BLOCK compaction
- Other: show stderr to user, continue

**PostCompact** (line ~392684):
```json
{ "hook_event_name": "PostCompact", "trigger": "manual|auto", "compact_summary": "..." }
```
- Exit 0: stdout shown to user
- Other: show stderr to user

### Subagent events

**SubagentStart** (line 392648):
```json
{ "hook_event_name": "SubagentStart", "agent_id": "...", "agent_type": "..." }
```
- Exit 0: stdout shown to subagent
- Blocking errors are ignored
- Matcher on `agent_type`

**SubagentStop** (line 392657):
```json
{ "hook_event_name": "SubagentStop", "stop_hook_active": bool, "agent_id": "...", "agent_transcript_path": "...", "agent_type": "...", "last_assistant_message": "..." }
```
- Exit 0: stdout/stderr not shown
- Exit 2: show stderr to subagent and CONTINUE having it run
- Other: show stderr to user
- Matcher on `agent_type`

### Notification event

**Notification** (line 392588):
```json
{ "hook_event_name": "Notification", "message": "...", "title": "...", "notification_type": "..." }
```
- Exit 0: stdout/stderr not shown
- Other: show stderr to user
- Matcher on `notification_type`: `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`, `elicitation_complete`, `elicitation_response`

### Swarm/team events

**TeammateIdle** (line 392694):
```json
{ "hook_event_name": "TeammateIdle", "teammate_name": "...", "team_name": "..." }
```
- Exit 0: stdout/stderr not shown
- Exit 2: show stderr to teammate and PREVENT idle (teammate continues working)
- Other: show stderr to user

**TaskCreated** (line 392703):
```json
{ "hook_event_name": "TaskCreated", "task_id": "...", "task_subject": "...", "task_description": "...", "teammate_name": "...", "team_name": "..." }
```
- Exit 0: stdout/stderr not shown
- Exit 2: show stderr to model and PREVENT task creation
- Other: show stderr to user

**TaskCompleted** (line 392715):
```json
{ "hook_event_name": "TaskCompleted", "task_id": "...", "task_subject": "...", "task_description": "...", "teammate_name": "...", "team_name": "..." }
```
- Exit 0: stdout/stderr not shown
- Exit 2: show stderr to model and PREVENT task completion
- Other: show stderr to user

### MCP elicitation events

**Elicitation** (line 392728):
```json
{ "hook_event_name": "Elicitation", "mcp_server_name": "...", "message": "...", "mode": "form|url", "url": "...", "elicitation_id": "...", "requested_schema": {} }
```
- Exit 0: use hook response if provided
- Exit 2: deny the elicitation
- Other: show stderr to user
- Matcher on `mcp_server_name`
- Return `hookSpecificOutput` with `action` (accept/decline/cancel) and optional `content`

**ElicitationResult** (line 392745):
```json
{ "hook_event_name": "ElicitationResult", "mcp_server_name": "...", "elicitation_id": "...", "mode": "form|url", "action": "accept|decline|cancel", "content": {} }
```
- Exit 0: use hook response if provided
- Exit 2: block the response (action becomes decline)
- Other: show stderr to user
- Matcher on `mcp_server_name`

### Configuration/environment events

**ConfigChange** (line 392767):
```json
{ "hook_event_name": "ConfigChange", "source": "user_settings|project_settings|local_settings|policy_settings|skills", "file_path": "..." }
```
- Exit 0: allow the change
- Exit 2: BLOCK the change from being applied to session
- Other: show stderr to user
- Note: `policy_settings` source blocks are ignored (always allowed)
- Matcher on `source`

**InstructionsLoaded** (line 392784):
```json
{
  "hook_event_name": "InstructionsLoaded",
  "file_path": "...",
  "memory_type": "User|Project|Local|Managed",
  "load_reason": "session_start|nested_traversal|path_glob_match|include|compact",
  "globs": [...],
  "trigger_file_path": "...",
  "parent_file_path": "..."
}
```
- Exit 0: command completes successfully
- Other: show stderr to user
- **Observability-only — no blocking supported**
- Matcher on `load_reason`

**CwdChanged** (line 392813):
```json
{ "hook_event_name": "CwdChanged", "old_cwd": "...", "new_cwd": "..." }
```
- Exit 0: command completes successfully
- Other: show stderr to user
- `CLAUDE_ENV_FILE` env var is set — write bash exports there to apply env to subsequent BashTool commands
- Return `hookSpecificOutput.watchPaths` (array of absolute paths) to register with FileChanged watcher

**FileChanged** (line 392822):
```json
{ "hook_event_name": "FileChanged", "file_path": "...", "event": "change|add|unlink" }
```
- Exit 0: command completes successfully
- Other: show stderr to user
- Matcher field specifies filenames to watch in current dir (e.g. `.envrc|.env`)
- `CLAUDE_ENV_FILE` env var is set
- Return `hookSpecificOutput.watchPaths` to dynamically update the watch list

### Worktree lifecycle events

**WorktreeCreate** (line 392797):
```json
{ "hook_event_name": "WorktreeCreate", "name": "..." }
```
- Exit 0: worktree created successfully; stdout should contain absolute path to created worktree
- Other: worktree creation failed
- Returns `hookSpecificOutput.worktreePath` for callback/http hooks

**WorktreeRemove** (line 392805):
```json
{ "hook_event_name": "WorktreeRemove", "worktree_path": "..." }
```
- Exit 0: worktree removed successfully
- Other: show stderr to user

---

## hookSpecificOutput Reference

Hooks can return a JSON object with `hookSpecificOutput` to provide structured responses. The key field is `hookEventName`:

| Event | hookSpecificOutput fields | Effect |
|-------|--------------------------|--------|
| `PreToolUse` | `permissionDecision`, `permissionDecisionReason`, `updatedInput`, `additionalContext` | Modify permission or tool input |
| `UserPromptSubmit` | `additionalContext` | Inject context for the model |
| `SessionStart` | `additionalContext`, `initialUserMessage`, `watchPaths` | Inject context, initial message, or file watchers |
| `Setup` | `additionalContext` | Inject context |
| `SubagentStart` | `additionalContext` | Inject context for subagent |
| `PostToolUse` | `additionalContext`, `updatedMCPToolOutput` | Inject context or modify MCP tool output |
| `PostToolUseFailure` | `additionalContext` | Inject context |
| `PermissionDenied` | `retry: bool` | Tell model it may retry the denied tool call |
| `Notification` | `additionalContext` | Inject context |
| `PermissionRequest` | `decision: {behavior: "allow"/"deny", ...}` | Auto-approve or auto-deny permission |
| `Elicitation` | `action`, `content` | Auto-respond to MCP elicitation |
| `ElicitationResult` | `action`, `content` | Override elicitation response |
| `CwdChanged` | `watchPaths` | Register paths for FileChanged watcher |
| `FileChanged` | `watchPaths` | Update FileChanged watch list |
| `WorktreeCreate` | `worktreePath` | Return path of created worktree (callback/http only) |

---

## async / asyncRewake Behavior

For `command` hooks only:

- `async: true` — hook runs in background without blocking the model
- `asyncRewake: true` — hook runs in background; if it exits with code 2, the model is woken up with the stderr as a blocking error. Implies `async: true`.

(Lines 53160–53168)

---

## Plugin Hook Restrictions

Plugins can only register a subset of hook events (line 56475, also matches raw source `settings.ts:594`):

```
PreToolUse, PostToolUse, Notification, UserPromptSubmit,
SessionStart, SessionEnd, Stop, SubagentStop,
PreCompact, PostCompact, TeammateIdle, TaskCreated, TaskCompleted
```

**Not allowed in plugins:** `PostToolUseFailure`, `StopFailure`, `SubagentStart`, `PermissionRequest`, `PermissionDenied`, `Setup`, `Elicitation`, `ElicitationResult`, `ConfigChange`, `WorktreeCreate`, `WorktreeRemove`, `InstructionsLoaded`, `CwdChanged`, `FileChanged`

---

## Policy / Admin Controls

- `disableAllHooks: true` — disables all hooks and statusLine execution (user or policy settings)
- `allowManagedHooksOnly: true` — only hooks from managed/policy settings run; user/project/local hooks blocked
- `allowedHttpHookUrls` — allowlist of URL patterns for HTTP hooks (supports `*` wildcard)
- `httpHookAllowedEnvVars` — allowlist of env var names that may be interpolated in HTTP hook headers
- `blockCustomizationSources: ["hooks"]` — blocks non-plugin customization for hooks (managed settings)

---

## CLAUDE_ENV_FILE

Set by CC for `Setup`, `SessionStart`, `CwdChanged`, and `FileChanged` hook events (line 568330). Write bash `export VAR=value` statements to this file path to persist env vars to subsequent BashTool commands.

---

## Hook Source Types

CC tracks where each hook comes from (line 330962):

| Source | Description |
|--------|-------------|
| `userSettings` | `~/.claude/settings.json` |
| `projectSettings` | `.claude/settings.json` |
| `localSettings` | `.claude/settings.local.json` |
| `pluginHook` | `~/.claude/plugins/*/hooks/hooks.json` |
| `sessionHook` | In-memory, temporary |
| `builtinHook` | Registered internally by Claude Code |

---

## Hook Streaming / Progress Events

Hooks emit progress events to the transcript stream:

- `hook_started` — includes `hook_id`, `hook_name`, `hook_event`, `uuid`, `session_id`
- `hook_progress` — includes stdout/stderr progress
- `hook_response` — final response

These are used for async hook notifications.

---

## Key Findings vs Older Versions

Based on comparison with what the raw source and the minified 2.1.90 contain:

1. **New hook events** (added since initial hook system, now stable):
   - `PostToolUseFailure` — fires when a tool fails
   - `StopFailure` — fires instead of Stop on API errors; fire-and-forget
   - `PermissionDenied` — fires when auto-mode classifier denies a tool
   - `TeammateIdle` — swarm-specific; can prevent teammate going idle
   - `TaskCreated` / `TaskCompleted` — swarm task lifecycle; can block
   - `Elicitation` / `ElicitationResult` — MCP user-input protocol; hooks can auto-respond
   - `ConfigChange` — fires when config files change; can block changes
   - `InstructionsLoaded` — observability-only for CLAUDE.md loading
   - `CwdChanged` / `FileChanged` — filesystem watch integration
   - `WorktreeCreate` / `WorktreeRemove` — VCS-agnostic worktree lifecycle hooks
   - `Setup` — repo init/maintenance hooks

2. **New hook types** (vs basic command-only original):
   - `prompt` — LLM prompt hooks with `$ARGUMENTS` placeholder
   - `http` — HTTP POST hooks with env var interpolation
   - `agent` — Agentic verifier hooks (spawn a subagent)

3. **New hook fields**:
   - `asyncRewake` — background hooks that can wake the model on exit code 2
   - `once` — single-fire hooks
   - `shell` — powershell support for command hooks
   - `statusMessage` — custom spinner text

4. **hookSpecificOutput** — hooks can return structured JSON to modify behavior (permission decisions, updated tool input, context injection, MCP auto-response, file watcher registration)

5. **CLAUDE_ENV_FILE** — hooks can persist env vars to this file path to influence subsequent BashTool commands

6. **Agent SDK docs embedded** — the minified file contains agent SDK documentation with the full available hooks list at line 637361.
