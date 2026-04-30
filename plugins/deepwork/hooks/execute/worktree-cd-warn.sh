#!/usr/bin/env bash
# worktree-cd-warn.sh — PreToolUse(Bash) warn-only hook: worktree-cd-prefix discipline.
# Registered: PreToolUse:Bash via hook-manifest.json (modes: execute)
#
# Detects Bash commands that reference a worktree path for write-class operations
# (shell redirects, rm, mv, cp, git commit, git add) WITHOUT starting with a
# `cd /abs/path/.claude/worktrees/<segment>` prefix for the same segment.
#
# Per executor-stance.md §3: every Bash command in spawned worktree work MUST be
# prefixed with the absolute cd. This hook warns but never blocks (always exit 0).

set +e

command -v jq >/dev/null 2>&1 || exit 0

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# shellcheck source=../../scripts/instance-lib.sh
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
_parse_hook_input

# Attempt instance discovery to populate INSTANCE_DIR for hook-timing.jsonl.
# Fail-open: worktree discipline warning is session-agnostic and fires regardless.
discover_instance "$SESSION_ID" 2>/dev/null || true

COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[[ -n "$COMMAND" ]] || exit 0

# Extract worktree segment from a path matching .claude/worktrees/<segment>/
# Primary: require trailing slash (ensures we match write-target paths like .../w1/file).
# H2 fix: also match `git -C /abs/.claude/worktrees/<seg>` (no trailing slash) as a
# separate pattern so the cd-prefix in `cd .../wrong-seg &&` (no slash) does not
# steal the segment before the actual write-target is seen.
# Known limitation: `head -1` picks the first segment match in the command text.
# Commands that reference two different worktree segments in one string may be
# misclassified (the second-segment write target would go undetected). This is
# an accepted limitation — multi-segment single-command patterns are uncommon.
_WORKTREE_SEGMENT=""
if printf '%s' "$COMMAND" | grep -qE '\.claude/worktrees/[A-Za-z0-9._-]+/'; then
  _WORKTREE_SEGMENT=$(printf '%s' "$COMMAND" \
    | grep -oE '\.claude/worktrees/[A-Za-z0-9._-]+/' \
    | head -1 \
    | sed 's|.*\.claude/worktrees/||; s|/$||')
elif printf '%s' "$COMMAND" | grep -qE 'git[[:space:]]+-C[[:space:]]+[^[:space:]]+\.claude/worktrees/[A-Za-z0-9._-]+([[:space:]]|$)'; then
  # H2: `git -C /abs/.../worktrees/<seg>` with no trailing slash
  _WORKTREE_SEGMENT=$(printf '%s' "$COMMAND" \
    | grep -oE 'git[[:space:]]+-C[[:space:]]+[^[:space:]]+\.claude/worktrees/[A-Za-z0-9._-]+' \
    | head -1 \
    | grep -oE '\.claude/worktrees/[A-Za-z0-9._-]+$' \
    | sed 's|.*\.claude/worktrees/||')
fi

[[ -n "$_WORKTREE_SEGMENT" ]] || exit 0

# Write-class detection: only warn for operations that modify files in the worktree.
# Read-only operations (cat, ls, head, tail, grep, find, diff, git log, git diff, etc.) are exempt.
_is_write_class() {
  local cmd="$1"
  # Shell redirects writing into the worktree path
  if printf '%s' "$cmd" | grep -qE '(>|>>)[[:space:]]*[^;|&]*\.claude/worktrees/[A-Za-z0-9._-]+/'; then
    return 0
  fi
  # rm against worktree path
  if printf '%s' "$cmd" | grep -qE 'rm[[:space:]]+[^;|&]*\.claude/worktrees/[A-Za-z0-9._-]+/'; then
    return 0
  fi
  # mv with worktree path as destination (last positional arg before ; or end)
  if printf '%s' "$cmd" | grep -qE 'mv[[:space:]]+[^;|&]+[[:space:]][^;|&]*\.claude/worktrees/[A-Za-z0-9._-]+/'; then
    return 0
  fi
  # cp with worktree path as destination
  if printf '%s' "$cmd" | grep -qE 'cp[[:space:]]+[^;|&]+[[:space:]][^;|&]*\.claude/worktrees/[A-Za-z0-9._-]+/'; then
    return 0
  fi
  # git commit / git add against worktree path
  if printf '%s' "$cmd" | grep -qE 'git[[:space:]]+(commit|add)[[:space:]][^;|&]*\.claude/worktrees/[A-Za-z0-9._-]+/?'; then
    return 0
  fi
  # git -C <worktree-path> (any git subcommand using -C to target worktree)
  if printf '%s' "$cmd" | grep -qE 'git[[:space:]]+-C[[:space:]]+[^[:space:]]+\.claude/worktrees/[A-Za-z0-9._-]+/?'; then
    return 0
  fi
  # tee writing into worktree path (L2)
  if printf '%s' "$cmd" | grep -qE 'tee[[:space:]]+[^;|&]*\.claude/worktrees/[A-Za-z0-9._-]+/?'; then
    return 0
  fi
  return 1
}

_is_write_class "$COMMAND" || exit 0

# Check whether command begins with: cd /abs/path/.claude/worktrees/<same-segment>[/] [&& ...]
# Allow optional leading whitespace. The cd must target the same segment.
# H1 fix: accept optional trailing slash after the segment so
# `cd /abs/.../worktrees/w1/ && cp src dst` does not produce a spurious warning.
_STRIPPED=$(printf '%s' "$COMMAND" | sed 's/^[[:space:]]*//')
_CD_SEGMENT=""
if printf '%s' "$_STRIPPED" | grep -qE '^cd[[:space:]]+[^[:space:]]+\.claude/worktrees/[A-Za-z0-9._-]+/?([[:space:]]|$)'; then
  _CD_SEGMENT=$(printf '%s' "$_STRIPPED" \
    | grep -oE '^cd[[:space:]]+[^[:space:]]+\.claude/worktrees/[A-Za-z0-9._-]+' \
    | grep -oE '\.claude/worktrees/[A-Za-z0-9._-]+' \
    | sed 's|.*\.claude/worktrees/||')
fi

if [[ "$_CD_SEGMENT" == "$_WORKTREE_SEGMENT" ]]; then
  exit 0
fi

# Warn: write-class operation targets worktree path without matching cd prefix
printf 'WORKTREE-DISCIPLINE WARNING: command references worktree path '"'"'%s'"'"' but does not start with '"'"'cd /abs/path/.claude/worktrees/%s'"'"'. Per executor-stance.md §3, every Bash command in spawned worktree work must be prefixed with the absolute cd. Continuing (warn-only).\n' \
  "$_WORKTREE_SEGMENT" "$_WORKTREE_SEGMENT" >&2

exit 0
