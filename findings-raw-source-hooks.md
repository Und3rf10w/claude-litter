# Claude Code Hook System — Raw Source Findings

Source: `~/tmp/cclatest/src/claude-code`
Key files:
- `src/entrypoints/sdk/coreTypes.ts` — `HOOK_EVENTS` const array
- `src/entrypoints/sdk/coreSchemas.ts` — Zod schemas for all hook input types
- `src/schemas/hooks.ts` — Zod schemas for hook config (command/prompt/agent/http)
- `src/types/hooks.ts` — Hook output types, response schemas
- `src/utils/hooks.ts` — Core execution engine (~4300 lines)
- `src/utils/hooks/hookEvents.ts` — Hook event emission system
- `src/utils/hooks/hooksSettings.ts` — Display/source helpers
- `src/utils/plugins/loadPluginHooks.ts` — Plugin hook loading/hot reload

---

## 1. All Hook Event Types

Defined as a const array in `src/entrypoints/sdk/coreTypes.ts`:

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

Total: **27 event types** (as of this source snapshot).

Always-emitted without opt-in: `SessionStart`, `Setup`. All others require `includeHookEvents` option or `CLAUDE_CODE_REMOTE` mode.

---

## 2. Hook Configuration Schema

Defined in `src/schemas/hooks.ts`. Four hook types form a discriminated union on `type`:

### type: "command" (BashCommandHook)
```json
{
  "type": "command",
  "command": "shell command string",
  "if": "Bash(git *)",           // optional: permission-rule syntax filter
  "shell": "bash|powershell",    // optional, defaults to bash
  "timeout": 60,                 // optional, seconds
  "statusMessage": "...",        // optional, spinner label
  "once": true,                  // optional: run once then self-remove
  "async": true,                 // optional: background execution
  "asyncRewake": true            // optional: background + wake model on exit 2
}
```

### type: "prompt" (PromptHook)
```json
{
  "type": "prompt",
  "prompt": "Verify that... $ARGUMENTS",  // $ARGUMENTS substituted with hook input JSON
  "if": "...",
  "timeout": 30,
  "model": "claude-sonnet-4-6",   // optional, defaults to small fast model
  "statusMessage": "...",
  "once": true
}
```

### type: "agent" (AgentHook)
```json
{
  "type": "agent",
  "prompt": "Verify that... $ARGUMENTS",  // $ARGUMENTS substituted with hook input JSON
  "if": "...",
  "timeout": 60,                  // optional, default 60
  "model": "claude-haiku-4-5-20251001",  // optional, defaults to Haiku
  "statusMessage": "...",
  "once": true
}
```

### type: "http" (HttpHook)
```json
{
  "type": "http",
  "url": "https://...",
  "if": "...",
  "timeout": 30,
  "headers": { "Authorization": "Bearer $MY_TOKEN" },
  "allowedEnvVars": ["MY_TOKEN"],  // required for env var interpolation in headers
  "statusMessage": "...",
  "once": true
}
```

### Matcher wrapping structure (HookMatcherSchema)
```json
{
  "matcher": "Write",   // optional: tool name / regex / pipe-separated list
  "hooks": [/* array of hook commands above */]
}
```

### Top-level HooksSchema (in settings.json)
```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash", "hooks": [...] }],
    "Stop": [{ "matcher": "", "hooks": [...] }]
  }
}
```

### `if` field
Permission-rule syntax (`ToolName(pattern)`), e.g. `Bash(git *)`. Only evaluates for PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest. Filters hooks without spawning.

### `matcher` field patterns
- Empty/`*` = match all
- Simple alphanumeric = exact match (e.g. `Write`)
- Pipe-separated = multiple exact matches (`Write|Edit`)
- Otherwise treated as regex (`^Bash.*`)

---

## 3. Stdin JSON Fields Per Hook Event

All hook inputs share a **base object** (sent as JSON on stdin):

```json
{
  "session_id": "uuid",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/current/working/dir",
  "permission_mode": "...",     // optional
  "agent_id": "...",            // optional: subagent ID (absent on main thread)
  "agent_type": "..."           // optional: agent type name
}
```

Event-specific additional fields:

### PreToolUse
```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": { /* tool input object */ },
  "tool_use_id": "uuid"
}
```

### PostToolUse
```json
{
  "hook_event_name": "PostToolUse",
  "tool_name": "Bash",
  "tool_input": { /* tool input */ },
  "tool_response": { /* tool output */ },
  "tool_use_id": "uuid"
}
```

### PostToolUseFailure
```json
{
  "hook_event_name": "PostToolUseFailure",
  "tool_name": "Bash",
  "tool_input": { /* tool input */ },
  "tool_use_id": "uuid",
  "error": "error message string",
  "is_interrupt": false   // optional
}
```

### PermissionRequest
```json
{
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": { /* tool input */ },
  "permission_suggestions": [/* optional array of PermissionUpdate */]
}
```

### PermissionDenied
```json
{
  "hook_event_name": "PermissionDenied",
  "tool_name": "Bash",
  "tool_input": { /* tool input */ },
  "tool_use_id": "uuid",
  "reason": "why denied"
}
```

### Notification
```json
{
  "hook_event_name": "Notification",
  "message": "notification text",
  "title": "optional title",
  "notification_type": "type string"
}
```

### UserPromptSubmit
```json
{
  "hook_event_name": "UserPromptSubmit",
  "prompt": "user's prompt text"
}
```

### SessionStart
```json
{
  "hook_event_name": "SessionStart",
  "source": "startup|resume|clear|compact",
  "agent_type": "optional",
  "model": "optional model id"
}
```

### SessionEnd
```json
{
  "hook_event_name": "SessionEnd",
  "reason": "clear|resume|logout|prompt_input_exit|other|bypass_permissions_disabled"
}
```

### Setup
```json
{
  "hook_event_name": "Setup",
  "trigger": "init|maintenance"
}
```

### Stop
```json
{
  "hook_event_name": "Stop",
  "stop_hook_active": false,
  "last_assistant_message": "optional text of last assistant message"
}
```

### StopFailure
```json
{
  "hook_event_name": "StopFailure",
  "error": "error type string",
  "error_details": "optional details",
  "last_assistant_message": "optional"
}
```

### SubagentStart
```json
{
  "hook_event_name": "SubagentStart",
  "agent_id": "subagent-uuid",
  "agent_type": "agent type name"
}
```

### SubagentStop
```json
{
  "hook_event_name": "SubagentStop",
  "stop_hook_active": false,
  "agent_id": "subagent-uuid",
  "agent_transcript_path": "/path/to/agent/transcript.jsonl",
  "agent_type": "agent type name",
  "last_assistant_message": "optional"
}
```

### TeammateIdle
```json
{
  "hook_event_name": "TeammateIdle",
  "teammate_name": "name",
  "team_name": "team name"
}
```

### TaskCreated
```json
{
  "hook_event_name": "TaskCreated",
  "task_id": "task id string",
  "task_subject": "task title",
  "task_description": "optional description",
  "teammate_name": "optional",
  "team_name": "optional"
}
```

### TaskCompleted
```json
{
  "hook_event_name": "TaskCompleted",
  "task_id": "task id string",
  "task_subject": "task title",
  "task_description": "optional description",
  "teammate_name": "optional",
  "team_name": "optional"
}
```

### PreCompact
```json
{
  "hook_event_name": "PreCompact",
  "trigger": "manual|auto",
  "custom_instructions": "string or null"
}
```

### PostCompact
```json
{
  "hook_event_name": "PostCompact",
  "trigger": "manual|auto",
  "compact_summary": "the summary produced by compaction"
}
```

### Elicitation
```json
{
  "hook_event_name": "Elicitation",
  "mcp_server_name": "...",
  "message": "...",
  "mode": "form|url",       // optional
  "url": "...",             // optional
  "elicitation_id": "...",  // optional
  "requested_schema": {}    // optional
}
```

### ElicitationResult
```json
{
  "hook_event_name": "ElicitationResult",
  "mcp_server_name": "...",
  "elicitation_id": "...",  // optional
  "mode": "form|url",       // optional
  "action": "accept|decline|cancel",
  "content": {}             // optional
}
```

### ConfigChange
```json
{
  "hook_event_name": "ConfigChange",
  "source": "user_settings|project_settings|local_settings|policy_settings|skills",
  "file_path": "optional path"
}
```

### InstructionsLoaded
```json
{
  "hook_event_name": "InstructionsLoaded",
  "file_path": "/path/to/CLAUDE.md",
  "memory_type": "User|Project|Local|Managed",
  "load_reason": "session_start|nested_traversal|path_glob_match|include|compact",
  "globs": ["optional"],
  "trigger_file_path": "optional",
  "parent_file_path": "optional"
}
```

### WorktreeCreate
```json
{
  "hook_event_name": "WorktreeCreate",
  "name": "worktree name"
}
```

### WorktreeRemove
```json
{
  "hook_event_name": "WorktreeRemove",
  "worktree_path": "/path/to/worktree"
}
```

### CwdChanged
```json
{
  "hook_event_name": "CwdChanged",
  "old_cwd": "/old/path",
  "new_cwd": "/new/path"
}
```

### FileChanged
```json
{
  "hook_event_name": "FileChanged",
  "file_path": "/path/to/changed/file",
  "event": "change|add|unlink"
}
```

---

## 4. Environment Variables Passed to Command Hooks

Set in `src/utils/hooks.ts` `execCommandHook()`:

| Variable | Value |
|---|---|
| `CLAUDE_PROJECT_DIR` | Stable project root (not worktree path) |
| `CLAUDE_PLUGIN_ROOT` | Plugin or skill root dir (if applicable) |
| `CLAUDE_PLUGIN_DATA` | Plugin data dir (if applicable) |
| `CLAUDE_PLUGIN_OPTION_<KEY>` | Per-key user config for plugin options |
| `CLAUDE_ENV_FILE` | Path to env file hook can write to set session env vars (SessionStart, Setup, CwdChanged, FileChanged only) |

From `subprocessEnv()`: inherits the parent process environment.

The `CLAUDE_CODE_SHELL_PREFIX` env var wraps commands (bash-only, not PowerShell).

---

## 5. Exit Code Handling (Command Hooks)

| Exit code | Behavior |
|---|---|
| `0` | Success. stdout shown to model as hook output. |
| `1` (or any non-0, non-2) | Non-blocking error. Shown to user but does not block. |
| `2` | **Blocking error**. stderr content returned as feedback to model. Prevents the action (PreToolUse: blocks tool; Stop: provides re-prompt feedback; TeammateIdle: keeps teammate active; TaskCreated/Completed: blocks task state change). |

For JSON output hooks (stdout starts with `{`): exit code is secondary. The JSON `continue: false` sets `preventContinuation`. `decision: "block"` sets blocking. `decision: "approve"` allows.

### asyncRewake + exit 2
If `asyncRewake: true`, the hook runs in background. If it exits 2, a task-notification is enqueued to wake the model.

---

## 6. Hook Output (stdout) Protocol

### Plain text output
If stdout does not start with `{`, it is treated as plain text and shown to model.

### JSON output (sync)
```json
{
  "continue": true,            // false = preventContinuation
  "suppressOutput": false,     // hide stdout from transcript
  "stopReason": "...",         // message when continue=false
  "decision": "approve|block", // approve/block permission
  "reason": "...",             // reason for decision
  "systemMessage": "...",      // warning shown to user
  "hookSpecificOutput": {
    // Event-specific fields — hookEventName must match the firing event
    "hookEventName": "PreToolUse",
    "permissionDecision": "allow|deny|ask",
    "permissionDecisionReason": "...",
    "updatedInput": {},          // modified tool input to use
    "additionalContext": "..."
  }
}
```

### hookSpecificOutput per event

| hookEventName | Extra output fields |
|---|---|
| PreToolUse | `permissionDecision`, `permissionDecisionReason`, `updatedInput`, `additionalContext` |
| PostToolUse | `additionalContext`, `updatedMCPToolOutput` |
| PostToolUseFailure | `additionalContext` |
| UserPromptSubmit | `additionalContext` |
| SessionStart | `additionalContext`, `initialUserMessage`, `watchPaths` (paths to watch for FileChanged) |
| Setup | `additionalContext` |
| SubagentStart | `additionalContext` |
| PermissionDenied | `retry: boolean` |
| PermissionRequest | `decision: {behavior: "allow", updatedInput?, updatedPermissions?} | {behavior: "deny", message?, interrupt?}` |
| Elicitation | `action: "accept|decline|cancel"`, `content: {}` |
| ElicitationResult | `action: "accept|decline|cancel"`, `content: {}` |
| Notification | `additionalContext` |
| CwdChanged | `watchPaths` |
| FileChanged | `watchPaths` |
| WorktreeCreate | `worktreePath` |

### JSON async output
```json
{ "async": true, "asyncTimeout": 60000 }
```
Hook emits this as first line → CC backgrounds the process. Hook continues running without blocking the model.

---

## 7. Prompt Hook vs Command Hook vs Agent Hook

| Type | Execution | Input | Output |
|---|---|---|---|
| `command` | Shell subprocess | JSON on stdin | stdout/stderr + exit code |
| `prompt` | LLM inference (small fast model or specified model) | `$ARGUMENTS` in prompt string replaced with hook input JSON | Model response analyzed for block/allow |
| `agent` | Full CC subagent with tools | Same `$ARGUMENTS` substitution | Structured output via SyntheticOutputTool (`{ok: bool, reason: string}`) |
| `http` | HTTP POST | Hook input JSON as body | Response body as JSON |

Prompt hooks support `$ARGUMENTS`, `$ARGUMENTS[0]`, `$0` shorthand indexing.
Agent hooks default to Haiku; prompt hooks default to the small fast model.

### Prompt elicitation protocol (command hooks only)
Hooks can request user input by printing a JSON line to stdout:
```json
{ "prompt": "request-id", "message": "...", "options": [{"key": "...", "label": "...", "description": "..."}] }
```
CC sends the response back on stdin:
```json
{ "prompt_response": "request-id", "selected": "chosen-key" }
```

---

## 8. Hook Sources and Priority

Sources (from `hooksSettings.ts`):

| Source | Location | Priority |
|---|---|---|
| `policySettings` | Enterprise managed | Highest (when `allowManagedHooksOnly`) |
| `userSettings` | `~/.claude/settings.json` | High |
| `projectSettings` | `.claude/settings.json` | Medium |
| `localSettings` | `.claude/settings.local.json` | Lower |
| `pluginHook` | `~/.claude/plugins/*/hooks/hooks.json` | Low |
| `sessionHook` | In-memory, temporary | Session lifetime |
| `builtinHook` | Registered internally by CC | Internal |

`allowManagedHooksOnly` policy blocks all user/project/local hooks.

---

## 9. Plugin Hook Loading

From `src/utils/plugins/loadPluginHooks.ts` and `src/utils/plugins/pluginLoader.ts`:

1. **Standard path**: `<plugin-root>/hooks/hooks.json` — loaded automatically if it exists.
2. **Custom path**: `manifest.hooks` can reference additional hook files.
3. `hooks.json` structure uses `PluginHooksSchema` wrapper (has a `hooks` property containing the HooksSettings object).
4. Plugin hooks are registered with `pluginRoot`, `pluginName`, `pluginId` context.
5. `${CLAUDE_PLUGIN_ROOT}` in command strings is substituted with the plugin directory path at execution time.
6. `${CLAUDE_PLUGIN_DATA}` substituted with plugin data dir.
7. `${user_config.KEY}` substituted with plugin user-config values.
8. Hot reload: triggered when `policySettings` changes (enabledPlugins, marketplace settings).
9. Plugin hooks are cleared atomically (clear+register pair) to avoid dead periods.
10. Uninstalled plugins are pruned via `pruneRemovedPluginHooks()` without full reload.

---

## 10. CLAUDE_ENV_FILE Mechanism

For `SessionStart`, `Setup`, `CwdChanged`, `FileChanged` hooks, CC sets `CLAUDE_ENV_FILE` to a `.sh` file path. The hook can write `export FOO=bar` lines to it. CC reads this file and injects it into subsequent bash commands for the session — a persistent env var injection mechanism.

Only works for bash (not PowerShell) hooks.

---

## 11. Internal Hook Types (not user-configurable)

Beyond `command`/`prompt`/`agent`/`http`, the runtime has two internal types:

- **`callback`**: A JS async function registered internally (e.g., session file access analytics, attribution tracking). Not configurable in settings.json. Excluded from `tengu_run_hook` telemetry.
- **`function`**: A Stop hook that checks message state with a JS predicate. Used by structured-output enforcement in agent/ask workflows.

---

## 12. Trust Requirement

All hooks require workspace trust in interactive mode. If the user has not accepted the trust dialog, hooks are silently skipped. SDK (non-interactive) sessions have implicit trust.

---

## 13. Timeout Behavior

- Default: `TOOL_HOOK_EXECUTION_TIMEOUT_MS` = 10 minutes (600,000ms)
- SessionEnd: 1,500ms default; overridable via `CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`
- Per-hook `timeout` field (seconds) overrides the default
- `asyncRewake` hooks: bypass timeout (run until natural completion in background)

---

## 14. Summary of Key Differences from Documentation

Based on raw source inspection:
- `WorktreeCreate` and `WorktreeRemove` are confirmed hook events (may not be in all docs).
- `InstructionsLoaded` is a hook event (fires when CLAUDE.md files are loaded).
- `CwdChanged` and `FileChanged` are environment-related hooks with `CLAUDE_ENV_FILE` support.
- `Elicitation`/`ElicitationResult` are MCP elicitation hooks.
- `ConfigChange` fires for all config file changes (including policy — but blocking is ignored for policy).
- `StopFailure` has `error` and `error_details` fields (not just `error`).
- `SubagentStop` has `agent_transcript_path` (separate from base `transcript_path`).
- The `if` condition field is a permission-rule expression, not a simple string match.
