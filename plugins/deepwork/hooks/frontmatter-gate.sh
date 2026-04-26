#!/usr/bin/env bash
# hooks/frontmatter-gate.sh
# Registered: PreToolUse:Write|Edit via setup-deepwork.sh (path-scoped)
# Fires before any .md write in the active instance directory and validates
# .md frontmatter fields. banners[] schema is enforced post-write by
# state-drift-marker.sh (PostToolUse) which reverts on violation.

set +e

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

discover_instance || exit 0   # no active instance = skip

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
FILE_PATH=$(_canonical_path "$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""')")

# Only validate files in this instance's directory
[[ "$FILE_PATH" == *"${INSTANCE_DIR}"* ]] || exit 0

# state.json single-writer gate: only state-transition.sh may write it.
if [[ "$FILE_PATH" == */state.json ]]; then
  # Honour single_writer_enabled from state.json (default on; gate fires unless field is false).
  sw_enabled=$(jq -r '.single_writer_enabled // true' "$STATE_FILE" 2>/dev/null)
  if [[ "$sw_enabled" == "false" ]]; then
    exit 0
  fi
  # W7 event_head integrity check — delegates to shared helper in instance-lib.sh.
  _verify_event_head_or_block || exit 2
  if [[ "${_DW_STATE_TRANSITION_WRITER:-}" == "1" ]]; then
    exit 0
  fi
  printf 'frontmatter-gate: SINGLE_WRITER_VIOLATION — direct Write to state.json is blocked; use state-transition.sh\n' >&2
  exit 2
fi

# override-tokens.json single-writer gate: only state-transition.sh may write it.
if [[ "$FILE_PATH" == */override-tokens.json ]]; then
  sw_enabled=$(jq -r '.single_writer_enabled // true' "$STATE_FILE" 2>/dev/null)
  if [[ "$sw_enabled" == "false" ]]; then
    exit 0
  fi
  if [[ "${_DW_STATE_TRANSITION_WRITER:-}" == "1" ]]; then
    exit 0
  fi
  printf 'frontmatter-gate: SINGLE_WRITER_VIOLATION — direct Write to override-tokens.json is blocked; use state-transition.sh grant_override/consume_override\n' >&2
  exit 2
fi

# ── .md frontmatter enforcement ──────────────────────────────────────────────
[[ "$FILE_PATH" == *.md ]] || exit 0

# Exclude log.md and prompt.md — these are exempt from frontmatter requirements
case "$(basename "$FILE_PATH")" in
  log.md|prompt.md|adversarial-tests.md|adversarial-tests-*.md) exit 0 ;;
esac

# Read frontmatter_schema_version sentinel from state.json
SCHEMA_VER=$(jq -r '.frontmatter_schema_version // ""' "$STATE_FILE" 2>/dev/null)
if [[ -z "$SCHEMA_VER" ]]; then
  printf 'frontmatter-gate: pre-fix session — schema version absent; warn-only mode\n' >&2
  exit 0   # fall-open for pre-fix sessions
fi

# Sniff the artifact_type from the incoming content
# (For Write: full content in tool_input.content; for Edit: patch string)
CONTENT=$(printf '%s' "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // ""')
ARTIFACT_TYPE=$(printf '%s' "$CONTENT" | sed -n 's/^artifact_type:[[:space:]]*//p' | head -1 | tr -d '"')

if [[ -z "$ARTIFACT_TYPE" ]]; then
  # Partial-Edit fail-open: if the file already has frontmatter on disk, allow it
  if [[ -f "$FILE_PATH" ]] && grep -q '^---$' "$FILE_PATH" 2>/dev/null; then
    exit 0
  fi
  printf 'frontmatter-gate: artifact_type missing in frontmatter of %s\n' "$FILE_PATH" >&2
  exit 2
fi

# Floor schema validation.
# task_id/task_ids and bar_id/bar_ids accept either singular or plural per plan Part A.
MISSING_FIELDS=""
for FIELD in author instance sources; do
  if ! printf '%s' "$CONTENT" | grep -qE "^${FIELD}[[:space:]]*:"; then
    MISSING_FIELDS="${MISSING_FIELDS} ${FIELD}"
  fi
done
printf '%s' "$CONTENT" | grep -qE '^task_id(s)?[[:space:]]*:' || MISSING_FIELDS="${MISSING_FIELDS} task_id"
printf '%s' "$CONTENT" | grep -qE '^bar_id(s)?[[:space:]]*:' || MISSING_FIELDS="${MISSING_FIELDS} bar_id"

if [[ -n "$MISSING_FIELDS" ]]; then
  printf 'frontmatter-gate: missing required fields [%s] in %s\n' "$MISSING_FIELDS" "$FILE_PATH" >&2
  exit 2
fi

# Instance equality check: the frontmatter `instance:` value must match $INSTANCE_ID
# (prevents artifacts intended for one instance from being accidentally written into another).
# Note: instance field presence is already enforced above; unconditional check here so
# a parse failure (empty INSTANCE_FIELD despite field present) does not silently pass.
INSTANCE_FIELD=$(printf '%s' "$CONTENT" | grep -E '^instance[[:space:]]*:' | head -1 | sed 's/^instance[[:space:]]*:[[:space:]]*//' | tr -d '"'"'")
if [[ "$INSTANCE_FIELD" != "$INSTANCE_ID" ]]; then
  printf 'frontmatter-gate: instance "%s" does not match current instance "%s" in %s\n' \
    "$INSTANCE_FIELD" "$INSTANCE_ID" "$FILE_PATH" >&2
  exit 2
fi

exit 0
