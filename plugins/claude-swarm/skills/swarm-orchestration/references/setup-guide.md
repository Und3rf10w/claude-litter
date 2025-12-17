# Setup Guide

This guide covers terminal setup, multiplexer configuration, and prerequisites for swarm orchestration.

## Terminal Support

Claude Swarm supports two terminal multiplexers: **tmux** and **kitty**.

| Feature | tmux | kitty |
|---------|------|-------|
| Multiple sessions | Yes | Yes |
| Spawn modes | Sessions only | Split, Tab, Window |
| Session files | No | Yes (.kitty-session) |
| Auto-detection | Yes | Yes (via $KITTY_PID) |
| Setup complexity | Low | Medium |

### Which Should You Use?

**Use tmux if:**
- You want simple, straightforward setup
- You're already familiar with tmux
- You work primarily in a single terminal window
- You don't need visual organization features

**Use kitty if:**
- You want visual organization (splits, tabs, windows)
- You prefer seeing all teammates simultaneously
- You want session file support for reproducible setups
- You're comfortable with terminal emulator configuration

## tmux Setup

### Installation

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt-get install tmux

# Fedora/RHEL
sudo dnf install tmux
```

### Verification

```bash
tmux -V
# Should output: tmux 3.x or higher
```

### Basic Configuration (Optional)

Create `~/.tmux.conf`:

```bash
# Enable mouse support
set -g mouse on

# Increase scrollback buffer
set -g history-limit 10000

# Start window numbering at 1
set -g base-index 1

# Set escape time to avoid delays
set -sg escape-time 0
```

Reload config:

```bash
tmux source-file ~/.tmux.conf
```

### Usage with Swarm

Teammates spawn in separate tmux sessions named `swarm-<team>-<agent>`.

**List sessions:**

```bash
tmux list-sessions
```

**Attach to teammate:**

```bash
tmux attach -t swarm-payment-system-backend-dev
```

**Detach from session:** Press `Ctrl+B`, then `D`

## kitty Setup

### Installation

**macOS:**

```bash
brew install --cask kitty
```

**Linux:**

```bash
# Using installer script (recommended)
curl -L https://sw.kovidgoyal.net/kitty/installer.sh | sh /dev/in/stdin

# Or via package manager
# Ubuntu
sudo apt-get install kitty

# Fedora
sudo dnf install kitty
```

### Configuration

**CRITICAL:** kitty requires specific configuration for remote control.

Edit `~/.config/kitty/kitty.conf`:

```
# Enable remote control (REQUIRED)
allow_remote_control yes

# Set up socket for communication (REQUIRED)
listen_on unix:/tmp/kitty-$USER
```

**Important Notes:**

- kitty automatically appends `-PID` to the socket path
- Actual socket will be `/tmp/kitty-<username>-<PID>`
- The plugin handles this automatically

### Applying Configuration

**You MUST restart kitty completely** after changing config:

1. Quit kitty entirely (Cmd+Q on macOS, not just close window)
2. Relaunch kitty
3. Verify setup (see below)

### Verification

**Check socket exists:**

```bash
ls -la /tmp/kitty-$USER*
# Should show socket file(s) like /tmp/kitty-username-12345
```

**Test remote control:**

```bash
kitten @ ls
# Should return JSON data about kitty windows/tabs
```

If this fails, kitty remote control is not working. Review configuration and restart.

### kitty Spawn Modes

Control how teammates appear using `SWARM_KITTY_MODE`:

```bash
export SWARM_KITTY_MODE=split   # Vertical splits in current tab (default)
export SWARM_KITTY_MODE=tab     # Separate tabs
export SWARM_KITTY_MODE=window  # Separate OS windows
```

**Mode Comparison:**

| Mode | Visual Layout | Best For |
|------|---------------|----------|
| `split` | Vertical splits in one tab | Monitoring multiple teammates simultaneously |
| `tab` | One tab per teammate | Organized workspace, easy switching |
| `window` | Separate OS windows | Multi-monitor setups, full screen focus |

### kitty Session Files

kitty supports session files for reproducible team setups:

**Generate session file:**

```bash
/claude-swarm:swarm-session generate my-team
```

**Launch kitty with session:**

```bash
/claude-swarm:swarm-session launch my-team
# Or manually:
kitty --session ~/.claude/teams/my-team/swarm.kitty-session
```

Session files restore:
- All teammates with their roles
- Window layout and organization
- Team environment variables

## Multiplexer Detection

The plugin auto-detects your multiplexer:

1. Checks for `$KITTY_PID` + `kitten` command → **kitty**
2. Checks for `tmux` command → **tmux**
3. Falls back to **none** (error if spawning)

### Override Detection

Force a specific multiplexer:

```bash
export SWARM_MULTIPLEXER=tmux   # Force tmux
export SWARM_MULTIPLEXER=kitty  # Force kitty
```

Useful for:
- Testing with specific multiplexer
- Working around detection issues
- Scripts that require specific multiplexer

## Environment Variables

### Auto-Set (When Teammates Spawn)

These are automatically set for all spawned teammates:

| Variable | Description | Example |
|----------|-------------|---------|
| `CLAUDE_CODE_TEAM_NAME` | Current team name | `payment-system` |
| `CLAUDE_CODE_AGENT_ID` | Unique UUID | `a1b2c3d4-...` |
| `CLAUDE_CODE_AGENT_NAME` | Agent name | `backend-dev` |
| `CLAUDE_CODE_AGENT_TYPE` | Role type | `backend-developer` |
| `CLAUDE_CODE_TEAM_LEAD_ID` | Team lead UUID | `x1y2z3...` |
| `CLAUDE_CODE_AGENT_COLOR` | Display color | `blue` |

### User-Configurable

Set these in your shell profile (`~/.bashrc`, `~/.zshrc`):

| Variable | Options | Default | Purpose |
|----------|---------|---------|---------|
| `SWARM_MULTIPLEXER` | `tmux`, `kitty` | Auto-detect | Force specific multiplexer |
| `SWARM_KITTY_MODE` | `split`, `tab`, `window` | `split` | kitty spawn layout |
| `KITTY_LISTEN_ON` | Socket URI | Auto-detect | Override kitty socket path |

**Example configuration:**

```bash
# In ~/.zshrc or ~/.bashrc
export SWARM_KITTY_MODE=tab
export SWARM_MULTIPLEXER=kitty
```

## Common Setup Issues

### Issue: "Could not find a valid kitty socket"

**Cause:** kitty remote control not configured or not working.

**Solution:**

1. Verify `allow_remote_control yes` in `~/.config/kitty/kitty.conf`
2. Verify `listen_on unix:/tmp/kitty-$USER` in config
3. **Fully restart kitty** (Cmd+Q, not just close window)
4. Check socket: `ls -la /tmp/kitty-$USER*`
5. Test control: `kitten @ ls`

### Issue: "tmux: command not found"

**Cause:** tmux not installed.

**Solution:**

```bash
# macOS
brew install tmux

# Linux
sudo apt-get install tmux   # Ubuntu/Debian
sudo dnf install tmux        # Fedora/RHEL
```

### Issue: Spawns fail silently

**Cause:** Multiplexer available but teammates don't appear.

**Solution:**

1. Run diagnostics: `/claude-swarm:swarm-diagnose <team-name>`
2. Check multiplexer status manually:
   ```bash
   # tmux
   tmux list-sessions | grep swarm

   # kitty
   kitten @ ls | jq '.[] | .tabs[].windows[].user_vars'
   ```
3. Verify no permission issues with `~/.claude/` directory
4. Check Claude Code is in your `$PATH`

### Issue: "Session already exists" errors

**Cause:** Trying to spawn teammate with name that's already running.

**Solution:**

1. Check existing teammates: `/claude-swarm:swarm-status <team>`
2. Use different agent name, or
3. Clean up existing session first: `/claude-swarm:swarm-cleanup <team>`

### Issue: kitty socket path mismatch

**Cause:** Plugin can't find kitty socket due to non-standard configuration.

**Solution:**

Manually set socket path:

```bash
# Find your kitty socket
ls /tmp/kitty-*

# Set explicitly
export KITTY_LISTEN_ON=unix:/tmp/kitty-username-12345
```

Add to your shell profile for persistence.

## Prerequisites Checklist

Before using swarm orchestration:

- ✓ **Multiplexer installed** (tmux or kitty)
- ✓ **kitty configured** (if using kitty)
  - ✓ `allow_remote_control yes`
  - ✓ `listen_on unix:/tmp/kitty-$USER`
  - ✓ Fully restarted after config change
  - ✓ `kitten @ ls` works
- ✓ **Claude Code available** in `$PATH`
- ✓ **Working directory permissions** (can write to `~/.claude/`)
- ✓ **Sufficient resources** (each teammate is a separate Claude Code instance)

## Testing Your Setup

Run this quick test to verify everything works:

```bash
# 1. Create test team
/claude-swarm:swarm-create "test-team" "Testing setup"

# 2. Spawn single teammate
/claude-swarm:swarm-spawn "test-agent" "worker" "haiku" "You are a test agent. Message team-lead with 'Setup test successful' then exit."

# 3. Verify spawn
/claude-swarm:swarm-verify test-team

# 4. Check status
/claude-swarm:swarm-status test-team

# 5. Check inbox (should receive message)
/claude-swarm:swarm-inbox

# 6. Clean up
/claude-swarm:swarm-cleanup test-team --force
```

If all steps succeed, your setup is working correctly.

## Advanced Configuration

### Custom kitty Layouts

For split mode, customize layout in `kitty.conf`:

```
# Set split layout
enabled_layouts splits

# Default split location
map ctrl+shift+enter launch --location=vsplit
```

### tmux Custom Keybindings

Add to `~/.tmux.conf`:

```
# Easier session switching
bind-key s choose-tree -s

# Quick session navigation
bind-key -n M-Left previous-window
bind-key -n M-Right next-window
```

### Performance Tuning

For large teams (6+ teammates):

```bash
# Increase file descriptor limit
ulimit -n 4096

# For tmux, increase buffer
# In ~/.tmux.conf:
set -g history-limit 50000
```

## Getting Help

If you encounter setup issues:

1. Run diagnostics: `/claude-swarm:swarm-diagnose <team-name>`
2. Check system compatibility (macOS 10.15+, Linux kernel 4.4+)
3. Verify all prerequisites from checklist above
4. Review multiplexer documentation:
   - tmux: https://github.com/tmux/tmux/wiki
   - kitty: https://sw.kovidgoyal.net/kitty/

## Next Steps

Once setup is complete:

1. Review [Swarm Orchestration Skill](../SKILL.md) for workflow guidance
2. See [Slash Commands Reference](slash-commands.md) for command details
3. Try the example workflow in the main skill documentation

Your environment is now ready for multi-agent orchestration!
