---
description: Spawn a new Claude Code teammate in tmux or kitty with team environment variables
argument-hint: <agent_name> [agent_type] [model] [prompt] [--color <color>]
---

# Spawn Teammate

Spawn a new Claude Code teammate. You can only spawn one teammate at a time. You must invoke this command multiple time to spawn multiple teammates.

## Arguments

- `$1` - Agent name (required, e.g., backend-dev, frontend-dev)
- `$2` - Agent type (optional: worker, backend-developer, frontend-developer, reviewer, researcher, tester, or any custom type string - defaults to worker)
- `$3` - Model (optional: haiku, sonnet, opus - defaults to sonnet)
- `$4` - Initial prompt (optional)
- `--color <color>` - Agent display color (optional: blue, green, yellow, red, cyan, magenta, white - defaults to blue)

## Custom Agent Types

The agent type can be any descriptive string that fits your workflow. While the predefined types (worker, backend-developer, frontend-developer, reviewer, researcher, tester) are commonly used, you can specify custom types like:

- `database-specialist` - For database migrations and schema work
- `devops-engineer` - For infrastructure and deployment
- `security-auditor` - For security reviews
- `api-designer` - For API contract design
- `documentation-writer` - For documentation tasks

Custom types help organize teammates by their responsibilities and make team coordination clearer.

## Auto-Detection

The plugin automatically detects which terminal multiplexer to use:

- **kitty** - If running inside kitty terminal with remote control enabled
- **tmux** - If tmux is available

Override with: `SWARM_MULTIPLEXER=tmux` or `SWARM_MULTIPLEXER=kitty`

## Prerequisites

**For tmux:**

- `tmux` must be installed

**For kitty:**

- Running inside kitty terminal
- Remote control enabled in `~/.config/kitty/kitty.conf`:
  ```
  allow_remote_control yes
  ```

**Both require:**

- A team must exist (create with `/swarm-create` first)
- `CLAUDE_CODE_TEAM_NAME` environment variable must be set (set automatically by `/swarm-create`)

## Kitty Spawn Modes

Set `SWARM_KITTY_MODE` environment variable:

- `split` - Teammates in vertical splits within current tab (default)
- `tab` - Each teammate in separate tab
- `window` - Each teammate in separate OS-level kitty window

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

# Priority: env vars (teammates) > user vars (team-lead) > error
if [[ -n "$CLAUDE_CODE_TEAM_NAME" ]]; then
    TEAM="$CLAUDE_CODE_TEAM_NAME"
else
    TEAM="$(get_current_window_var 'swarm_team')"
fi

# Parse arguments: extract flags first, then positional args
COLOR="blue"  # default color
POSITIONAL=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --color)
            COLOR="$2"
            shift 2
            ;;
        *)
            POSITIONAL+=("$1")
            shift
            ;;
    esac
done

# Assign positional args
NAME="${POSITIONAL[0]:-}"
TYPE="${POSITIONAL[1]:-worker}"
MODEL="${POSITIONAL[2]:-sonnet}"
PROMPT="${POSITIONAL[3]:-}"

# Validate color
case "$COLOR" in
    blue|green|yellow|red|cyan|magenta|white) ;;
    *)
        echo "Error: Invalid color '$COLOR'. Must be one of: blue, green, yellow, red, cyan, magenta, white" >&2
        exit 1
        ;;
esac

if [[ -z "$TEAM" ]]; then
    echo "Error: Cannot determine team. Create a team first with /swarm-create or set CLAUDE_CODE_TEAM_NAME" >&2
    exit 1
fi

spawn_teammate "$TEAM" "$NAME" "$TYPE" "$MODEL" "$PROMPT" "" "" "" "" "$COLOR"
SCRIPT_EOF
```

After spawning, report:

1. Teammate name and which multiplexer was used
2. For tmux: How to attach with `tmux attach -t swarm-<team>-<name>`
3. For kitty: Windows use user variables for identification (survives title changes)
4. Suggest assigning a task with `/task-update <id> --assign <name>`

## Examples

**Spawn with default settings:**
```
/swarm-spawn backend-dev
```

**Spawn with specific type and model:**
```
/swarm-spawn frontend-dev frontend-developer opus
```

**Spawn with custom type and color:**
```
/swarm-spawn db-admin database-specialist sonnet "" --color magenta
```

**Spawn with custom type for specialized role:**
```
/swarm-spawn security-checker security-auditor haiku "Focus on OWASP top 10 vulnerabilities" --color red
```
