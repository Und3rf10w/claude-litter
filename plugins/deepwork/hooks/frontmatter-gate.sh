#!/usr/bin/env bash
# hooks/frontmatter-gate.sh
# Registered: PreToolUse:Write|Edit via setup-deepwork.sh (path-scoped)
# Fires before any .md write in the active instance directory and validates
# .md frontmatter fields. banners[] schema is enforced post-write by
# state-drift-marker.sh (PostToolUse) which reverts on violation.

set +e

command -v jq >/dev/null 2>&1 || exit 0

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
_parse_hook_input

discover_instance "$SESSION_ID" || exit 0   # no active instance = skip

FILE_PATH=$(_canonical_path "$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""')")

# Only validate files in this instance's directory (prefix match, not substring)
[[ "$FILE_PATH" == "${INSTANCE_DIR}/"* ]] || exit 0

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
    # §9.1: per-tool snapshot before the write so batch-gate.sh can diff phase/bar after the batch.
    # Keyed by TOOL_USE_ID for parallel-call safety; fall back to shared .state-snapshot.
    if [[ -n "$TOOL_USE_ID" ]]; then
      cp "${INSTANCE_DIR}/state.json" "${INSTANCE_DIR}/.state-snapshot.${TOOL_USE_ID}.json" 2>/dev/null || true
    else
      cp "${INSTANCE_DIR}/state.json" "${INSTANCE_DIR}/.state-snapshot" 2>/dev/null || true
    fi
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

# Extract content to validate. For Write: full tool_input.content. For Edit: reconstruct
# final content from old_string/new_string against the current file on disk.
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
FRONTMATTER_BLOCK=""
# Fail-open is only eligible for partial Edits where reconstruction wasn't possible
# (new_string used as-is). Write operations and successfully-reconstructed Edits get
# hard validation — we have definitive content and must not silently pass bad frontmatter.
_FAILOPEN_ELIGIBLE=0

if [[ "$TOOL_NAME" == "Edit" ]]; then
  OLD_STRING=$(printf '%s' "$INPUT" | jq -r '.tool_input.old_string // ""')
  NEW_STRING=$(printf '%s' "$INPUT" | jq -r '.tool_input.new_string // ""')
  if [[ -f "$FILE_PATH" ]] && [[ -n "$OLD_STRING" ]]; then
    CURRENT_CONTENT=$(cat "$FILE_PATH" 2>/dev/null || echo "")
    # Count occurrences of old_string in current file to ensure uniqueness
    OCC_COUNT=$(printf '%s' "$CURRENT_CONTENT" | grep -cF "$OLD_STRING" 2>/dev/null || echo "0")
    if [[ "$OCC_COUNT" -eq 1 ]]; then
      RECONSTRUCTED=$(printf '%s' "$CURRENT_CONTENT" | awk -v old="$OLD_STRING" -v new="$NEW_STRING" '
        BEGIN { ofs=ENVIRON["OLD_STRING"]; rest=""; found=0 }
        { rest = rest $0 "\n" }
        END {
          idx = index(rest, old)
          if (idx > 0) {
            print substr(rest, 1, idx-1) new substr(rest, idx+length(old))
          } else {
            print rest
          }
        }
      ' OLD_STRING="$OLD_STRING" 2>/dev/null)
      FRONTMATTER_BLOCK=$(printf '%s' "$RECONSTRUCTED" | awk '/^---$/{if(in_fm){exit}else{in_fm=1;next}} in_fm{print}')
    else
      # Reconstruction failed (old_string not unique or absent): fall back + warn
      printf 'frontmatter-gate: Edit reconstruction skipped (old_string not uniquely matched in %s); using existing file for validation\n' "$FILE_PATH" >&2
      FRONTMATTER_BLOCK=$(awk '/^---$/{if(in_fm){exit}else{in_fm=1;next}} in_fm{print}' "$FILE_PATH" 2>/dev/null || echo "")
    fi
  else
    # No old_string or file absent — use new_string as-is (may be partial patch).
    # Mark as fail-open eligible: a partial new_string without frontmatter delimiters
    # is a body-only edit and should not be rejected if the file already has frontmatter.
    FRONTMATTER_BLOCK=$(printf '%s' "$NEW_STRING" | awk '/^---$/{if(in_fm){exit}else{in_fm=1;next}} in_fm{print}')
    _FAILOPEN_ELIGIBLE=1
  fi
else
  # Write: extract first frontmatter block from full content
  FULL_CONTENT=$(printf '%s' "$INPUT" | jq -r '.tool_input.content // ""')
  FRONTMATTER_BLOCK=$(printf '%s' "$FULL_CONTENT" | awk '/^---$/{if(in_fm){exit}else{in_fm=1;next}} in_fm{print}')
fi

ARTIFACT_TYPE=$(printf '%s' "$FRONTMATTER_BLOCK" | sed -n 's/^artifact_type:[[:space:]]*//p' | head -1 | tr -d '"')

if [[ -z "$ARTIFACT_TYPE" ]]; then
  # Partial-Edit fail-open: only when reconstruction was not possible AND the file
  # already has valid frontmatter on disk. Write and reconstructed-Edit paths always
  # provide definitive content and must not silently pass missing artifact_type.
  if [[ "$_FAILOPEN_ELIGIBLE" == "1" ]] && [[ -f "$FILE_PATH" ]] && grep -q '^---$' "$FILE_PATH" 2>/dev/null; then
    exit 0
  fi
  printf 'frontmatter-gate: artifact_type missing in frontmatter of %s\n' "$FILE_PATH" >&2
  exit 2
fi

# Floor schema validation against the frontmatter block only.
# task_id/task_ids and bar_id/bar_ids accept either singular or plural per plan Part A.
MISSING_FIELDS=""
for FIELD in author instance sources; do
  if ! printf '%s' "$FRONTMATTER_BLOCK" | grep -qE "^${FIELD}[[:space:]]*:"; then
    MISSING_FIELDS="${MISSING_FIELDS} ${FIELD}"
  fi
done
printf '%s' "$FRONTMATTER_BLOCK" | grep -qE '^task_id(s)?[[:space:]]*:' || MISSING_FIELDS="${MISSING_FIELDS} task_id"
printf '%s' "$FRONTMATTER_BLOCK" | grep -qE '^bar_id(s)?[[:space:]]*:' || MISSING_FIELDS="${MISSING_FIELDS} bar_id"

if [[ -n "$MISSING_FIELDS" ]]; then
  printf 'frontmatter-gate: missing required fields [%s] in %s\n' "$MISSING_FIELDS" "$FILE_PATH" >&2
  exit 2
fi

# Instance equality check: the frontmatter `instance:` value must match $INSTANCE_ID
# (prevents artifacts intended for one instance from being accidentally written into another).
# Note: instance field presence is already enforced above; unconditional check here so
# a parse failure (empty INSTANCE_FIELD despite field present) does not silently pass.
INSTANCE_FIELD=$(printf '%s' "$FRONTMATTER_BLOCK" | grep -E '^instance[[:space:]]*:' | head -1 | sed 's/^instance[[:space:]]*:[[:space:]]*//' | tr -d '"'"'")
if [[ "$INSTANCE_FIELD" != "$INSTANCE_ID" ]]; then
  printf 'frontmatter-gate: instance "%s" does not match current instance "%s" in %s\n' \
    "$INSTANCE_FIELD" "$INSTANCE_ID" "$FILE_PATH" >&2
  exit 2
fi

exit 0
