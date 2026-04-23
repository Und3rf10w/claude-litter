#!/usr/bin/env bash
# hooks/frontmatter-gate.sh
# Registered: PreToolUse:Write|Edit via setup-deepwork.sh (path-scoped)
# Fires before any .md write in the active instance directory, and validates
# banners[] schema on state.json writes.

set +e

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

discover_instance || exit 0   # no active instance = skip

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""')

# Only validate files in this instance's directory
[[ "$FILE_PATH" == *"${INSTANCE_DIR}"* ]] || exit 0

# ── banners[] schema enforcement (state.json writes only) ───────────────────
# Validates every entry in banners[] before any state.json write.
# Fail-open on malformed JSON — let another hook catch that.
# Schema: references/schemas/banner-schema.json
if [[ "$FILE_PATH" == */state.json ]]; then
  SJSON_CONTENT=$(printf '%s' "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // ""')

  # Fail-open if content is empty or not valid JSON
  if [[ -n "$SJSON_CONTENT" ]]; then
    if printf '%s' "$SJSON_CONTENT" | jq -e . >/dev/null 2>&1; then
      BANNER_COUNT=$(printf '%s' "$SJSON_CONTENT" | jq -r '(.banners // []) | length' 2>/dev/null)
      if [[ -n "$BANNER_COUNT" && "$BANNER_COUNT" != "0" ]]; then
        VALIDATION_RESULT=$(printf '%s' "$SJSON_CONTENT" | jq -r '
          .banners // [] | to_entries[] |
          .key as $i | .value as $b |
          (
            if ($b | type) != "object" then
              "[\($i)] BANNER_NOT_OBJECT"
            elif ($b | has("artifact_path") | not) then
              "[\($i)] MISSING_ARTIFACT_PATH"
            elif ($b.artifact_path == null or ($b.artifact_path | type) != "string" or ($b.artifact_path | length) == 0) then
              "[\($i)] ARTIFACT_PATH_NOT_STRING"
            elif ($b | has("banner_type") | not) then
              "[\($i)] MISSING_BANNER_TYPE"
            elif ($b.banner_type == null or ($b.banner_type | type) != "string") then
              "[\($i)] BANNER_TYPE_NOT_STRING"
            elif (["pre-reconciliation-draft","synthesis-deviation-backpointer"] | index($b.banner_type)) == null then
              "[\($i)] UNKNOWN_BANNER_TYPE:\($b.banner_type)"
            elif ($b | has("reason") | not) then
              "[\($i)] MISSING_REASON"
            elif ($b.reason == null or ($b.reason | type) != "string" or ($b.reason | length) == 0) then
              "[\($i)] REASON_NOT_STRING"
            elif ($b | has("added_at") | not) then
              "[\($i)] MISSING_ADDED_AT"
            elif ($b.added_at == null or ($b.added_at | type) != "string") then
              "[\($i)] ADDED_AT_NOT_STRING"
            elif ($b.added_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}") | not) then
              "[\($i)] ADDED_AT_NOT_ISO8601:\($b.added_at)"
            elif ($b | has("added_by") | not) then
              "[\($i)] MISSING_ADDED_BY"
            elif ($b.added_by == null or ($b.added_by | type) != "string" or ($b.added_by | length) == 0) then
              "[\($i)] ADDED_BY_NOT_STRING"
            else
              (
                $b | keys[] | select(. != "artifact_path" and . != "banner_type" and . != "reason" and . != "added_at" and . != "added_by")
                | "[\($i)] UNKNOWN_FIELD:\(.)"
              )
            end
          )
        ' 2>/dev/null)

        if [[ -n "$VALIDATION_RESULT" ]]; then
          printf 'frontmatter-gate: banners[] schema violation in %s\n%s\n' \
            "$FILE_PATH" "$VALIDATION_RESULT" >&2
          exit 2
        fi
      fi
    fi
  fi
  exit 0
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
