#!/usr/bin/env bash
# test-profile-render.sh — regression: no {{...}} placeholders survive substitution.
#
# Renders both profiles with fully-populated env vars and asserts that no
# {{PLACEHOLDER}} tokens survive. Any surviving {{ indicates a template var
# missing from substitute_profile_template's substitution map.
#
# Exit 0 = all assertions pass; Exit 1 = one or more failures.

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

# shellcheck source=../../scripts/profile-lib.sh
source "${PLUGIN_ROOT}/scripts/profile-lib.sh"

PASS=0
FAIL=0

_pass() {
  printf '\xe2\x9c\x94 pass: %s\n' "$1"
  PASS=$((PASS + 1))
}

_fail() {
  printf '\xe2\x9c\x98 FAIL: %s\n' "$1" >&2
  FAIL=$((FAIL + 1))
}

render_profile() {
  local profile_path="$1" label="$2"
  echo ""
  echo "── ${label} ──"

  if [[ ! -f "$profile_path" ]]; then
    _fail "${label}: profile not found at ${profile_path}"
    return
  fi

  local tmpl rendered
  tmpl=$(cat "$profile_path")

  # Populate all known placeholders with non-empty sentinel values
  GOAL="test-goal" \
  TEAM_NAME="test-team" \
  INSTANCE_DIR="/tmp/test-instance" \
  PHASE="scope" \
  HARD_GUARDRAILS="- no breaking changes" \
  SOURCE_OF_TRUTH="- docs/spec.md" \
  ANCHORS="- src/main.ts:1" \
  WRITTEN_BAR="- G1: must compile" \
  ROLE_DEFINITIONS="- executor (MECHANISM)" \
  TEAM_ROSTER="- executor (MECHANISM)" \
  PLAN_REF="/tmp/plan.md" \
  PLAN_HASH="abc123def456" \
  TEST_MANIFEST_SUMMARY="3 entries" \
  CHANGE_LOG_SUMMARY="0 entries (0 approved and landed, 0 pending)" \
  ROLE_NAME="executor" \
  ARCHETYPE="MECHANISM" \
  ARCHETYPE_MANDATE="implement the plan" \
  STANCE="implement faithfully" \
  RESPONSIBILITIES="write code" \
  ARTIFACT_PATH="/tmp/artifact.md" \
  TASK_DESCRIPTION="implement gate G-exec-1" \
    rendered=$(substitute_profile_template "$tmpl")

  # Assert no {{ survived
  if printf '%s' "$rendered" | grep -q '{{'; then
    local surviving
    surviving=$(printf '%s' "$rendered" | grep -o '{{[^}]*}}' | sort -u | tr '\n' ' ')
    _fail "${label}: surviving placeholders after substitution: ${surviving}"
  else
    _pass "${label}: no {{ remaining after substitution"
  fi
}

render_profile "${PLUGIN_ROOT}/profiles/default/PROFILE.md"  "default profile"
render_profile "${PLUGIN_ROOT}/profiles/execute/PROFILE.md"  "execute profile"

echo ""
echo "─────────────────────────────────────"
printf 'Passed: %d | Failed: %d\n' "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
