#!/bin/bash
# stale-warn.sh — FileChanged hook (async advisory) that flips `stale_warn: true`
# on audit/critique files whose `valid_against.artifact_version` points at the
# changed proposal.
#
# Addresses drift class (d) — audit/critique files anchored to timestamp not
# version, so no stale-warn fires when the source spike moves.
#
# Input (hooks.md §FileChanged):
#   {hook_event_name: "FileChanged", file_path: string, event: "change"|"add"|"unlink"}
#
# Matcher: basename-only regex on proposal versions, same matcher as
# version-bump-notify.sh. Registered in setup-deepwork.sh.
#
# Operation:
#   1. Filter to proposals/v*.md under a deepwork session directory.
#   2. Extract the proposal's version token (e.g., "v3" from "v3-final.md").
#   3. Scan INSTANCE_DIR for critique.v*.md and findings.*.md files with YAML
#      frontmatter containing `valid_against.artifact_version: "<matching>"`.
#   4. For each matching file, flip `stale_warn: true` via yq/jq-like in-place
#      edit. Use a small sed-based approach (YAML is a subset we author — we
#      know the keys and their format).
#   5. Append a drift.log entry.
#
# Never blocks (FileChanged is fire-and-forget per hooks.md).

set +e
command -v jq >/dev/null 2>&1 || exit 0

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
_parse_hook_input

FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.file_path // ""' 2>/dev/null)
EVENT=$(printf '%s' "$INPUT" | jq -r '.event // ""' 2>/dev/null)

[[ -n "$FILE_PATH" ]] || exit 0

# Scope: only proposals under a deepwork session dir.
case "$FILE_PATH" in
  */.claude/deepwork/*/proposals/v*.md) ;;
  *) exit 0 ;;
esac

# On unlink, still propagate stale_warn — the referenced artifact has vanished.
[[ "$EVENT" == "change" || "$EVENT" == "add" || "$EVENT" == "unlink" ]] || exit 0

INSTANCE_DIR="$(dirname "$(dirname "$FILE_PATH")")"
CHANGED_BASE="$(basename "$FILE_PATH")"
CHANGED_VER=$(printf '%s' "$CHANGED_BASE" | grep -oE '^v[0-9]+(-final)?' | head -1)
[[ -n "$CHANGED_VER" ]] || exit 0
CHANGED_VER_BASE="${CHANGED_VER%-final}"

# Find candidate audit/critique files and flip their stale_warn: false → true.
# Look at both the versioned and base-version forms since audits may anchor
# to "v3" or "v3-final".
flipped=()
for candidate in "$INSTANCE_DIR"/critique.v*.md "$INSTANCE_DIR"/findings.*.md "$INSTANCE_DIR"/coverage.*.md "$INSTANCE_DIR"/reframe.*.md "$INSTANCE_DIR"/mechanism.*.md; do
  [[ -f "$candidate" ]] || continue

  # Read first 40 lines to inspect frontmatter (frontmatter should be near the top).
  HEAD=$(head -n 40 "$candidate" 2>/dev/null)

  # Look for valid_against.artifact_version referencing the changed file.
  # Accept indented `  artifact_version: "v3"` or `artifact_version: v3`.
  if printf '%s' "$HEAD" | grep -qE "artifact_version:[[:space:]]*['\"]?${CHANGED_VER_BASE}(-final)?['\"]?[[:space:]]*$"; then
    :  # matched
  elif printf '%s' "$HEAD" | grep -qE "artifact:[[:space:]]*['\"]?proposals/${CHANGED_VER_BASE}(-final)?\\.md['\"]?"; then
    :  # alternative anchor shape
  else
    continue
  fi

  # Only flip if stale_warn is currently false or absent. Idempotent.
  if printf '%s' "$HEAD" | grep -qE '^stale_warn:[[:space:]]*true[[:space:]]*$'; then
    continue  # already flipped
  fi

  # sed in-place: replace `stale_warn: false` with `stale_warn: true` in the
  # first 40 lines only (frontmatter). If the key is absent, add it after the
  # valid_against block is closed — for simplicity, only flip when the key is
  # already present (authors who use the header will have set it to false).
  if printf '%s' "$HEAD" | grep -qE '^stale_warn:[[:space:]]*false[[:space:]]*$'; then
    # macOS sed requires -i '' for no-backup.
    sed -i.stalebak -E 's/^stale_warn:[[:space:]]*false[[:space:]]*$/stale_warn: true/' "$candidate" 2>/dev/null && rm -f "${candidate}.stalebak"
    flipped+=("$(basename "$candidate")")
  fi
done

DRIFT_LOG="${INSTANCE_DIR}/drift.log"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [[ ${#flipped[@]} -gt 0 ]]; then
  {
    printf '%s  INFO stale-warn: %s (event=%s) triggered stale_warn on:\n' \
      "$TS" "$CHANGED_BASE" "$EVENT"
    for f in "${flipped[@]}"; do
      printf '    - %s\n' "$f"
    done
  } >> "$DRIFT_LOG" 2>/dev/null || true
fi

exit 0
