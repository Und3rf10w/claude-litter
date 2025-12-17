# Spawn Failure Recovery Example

## Scenario

You attempt to spawn teammates but get failures. This example shows the diagnostic and recovery workflow.

## Step 1: Initial Spawn Attempt

```bash
/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" "Implement API endpoints"
```

**Error:**
```
Error: Could not find a valid kitty socket
```

## Step 2: Run Diagnostics

```bash
/claude-swarm:swarm-diagnose my-team
```

**Output:**
```
Team: my-team
Multiplexer: kitty
Issue: Kitty socket not found
```

## Step 3: Troubleshoot Kitty Configuration

```bash
# Check kitty config
grep -E 'allow_remote_control|listen_on' ~/.config/kitty/kitty.conf
```

**Problem:** Missing configuration

## Step 4: Fix Configuration

Add to `~/.config/kitty/kitty.conf`:
```
allow_remote_control yes
listen_on unix:/tmp/kitty-$USER
```

## Step 5: Restart Kitty

Completely restart kitty (not just reload config).

## Step 6: Verify Fix

```bash
# Check socket exists
ls -la /tmp/kitty-$(whoami)-*

# Test socket
kitten @ ls
```

## Step 7: Retry Spawn

```bash
/claude-swarm:swarm-spawn "backend-dev" "backend-developer" "sonnet" "Implement API endpoints"
```

**Success!**

## Step 8: Verify Team Health

```bash
/claude-swarm:swarm-verify my-team
/claude-swarm:swarm-status my-team
```

All teammates should now show as active.
