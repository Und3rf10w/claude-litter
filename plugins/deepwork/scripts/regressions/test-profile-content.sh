#!/usr/bin/env bash
# test-profile-content.sh — regression tests asserting that load-bearing content
# blocks are present in profiles/default/PROFILE.md and profiles/execute/PROFILE.md.
#
# ac43185 inserted AGENT SCOPE CONSTRAINT, STATUS CLAIM RULE, and halt_reason
# schema into profiles/execute/PROFILE.md. halt-gate.sh enforces the state-shape
# at runtime but does NOT protect the prompt blocks that instruct the orchestrator
# to populate it — this test fills that gap.
#
# Exit 0 = all assertions pass; Exit 1 = one or more failures.

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

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

# _assert_present FILE LABEL PATTERN
_assert_present() {
  local file="$1" label="$2" pattern="$3"
  if grep -qF "$pattern" "$file"; then
    _pass "$file has $label"
  else
    _fail "$file missing $label (expected: $(printf '%q' "$pattern"))"
  fi
}

# _assert_proximity FILE LABEL ANCHOR NEARBY_PATTERN N_LINES
# Checks that NEARBY_PATTERN appears within N_LINES after the first ANCHOR line.
_assert_proximity() {
  local file="$1" label="$2" anchor="$3" nearby="$4" nlines="$5"
  local anchor_line
  anchor_line=$(grep -nF "$anchor" "$file" | head -1 | cut -d: -f1)
  if [[ -z "$anchor_line" ]]; then
    _fail "$file missing proximity anchor for $label (anchor: $(printf '%q' "$anchor"))"
    return
  fi
  if awk "NR>=${anchor_line} && NR<=${anchor_line}+${nlines}" "$file" \
       | grep -qF "$nearby"; then
    _pass "$file has $label (within ${nlines} lines of anchor)"
  else
    _fail "$file missing $label within ${nlines} lines of anchor '${anchor}' (sought: $(printf '%q' "$nearby"))"
  fi
}

assert_profile() {
  local file="$1"

  echo ""
  echo "── ${file} ──"

  # 1. File exists and is non-empty
  if [[ -f "$file" ]]; then
    _pass "$file exists"
  else
    _fail "$file does not exist"
    # Can't run further checks — count remaining assertions as failures.
    FAIL=$((FAIL + 7))
    return
  fi
  if [[ -s "$file" ]]; then
    _pass "$file is non-empty"
  else
    _fail "$file is empty"
    FAIL=$((FAIL + 6))
    return
  fi

  # 2. AGENT SCOPE CONSTRAINT block
  _assert_present "$file" "AGENT SCOPE CONSTRAINT header" \
    "AGENT SCOPE CONSTRAINT"
  # Distinctive body text — the verbatim constraint sentence
  _assert_present "$file" "AGENT SCOPE CONSTRAINT body (NOT authorized to rename)" \
    "NOT authorized to rename, move, or delete"

  # 3. STATUS CLAIM RULE block
  _assert_present "$file" "STATUS CLAIM RULE header" \
    "STATUS CLAIM RULE"
  # Proximity: "fresh Read" and "From memory (unverified):" within 20 lines of header
  _assert_proximity "$file" "STATUS CLAIM RULE / fresh Read" \
    "STATUS CLAIM RULE" "fresh Read" 20
  _assert_proximity "$file" "STATUS CLAIM RULE / From memory (unverified)" \
    "STATUS CLAIM RULE" "From memory (unverified):" 20

  # 4. halt_reason schema documented
  _assert_present "$file" "halt_reason key" \
    "halt_reason"
  # Proximity: "summary" and "blockers" within 30 lines of first halt_reason mention
  _assert_proximity "$file" "halt_reason schema / summary field" \
    "halt_reason" '"summary"' 30
  _assert_proximity "$file" "halt_reason schema / blockers field" \
    "halt_reason" '"blockers"' 30

  # 5. No YAML frontmatter expected (files start with plain text).
  # Verify first line is NOT "---" (i.e., no frontmatter drift).
  local first_line
  first_line=$(head -1 "$file")
  if [[ "$first_line" == "---" ]]; then
    # Frontmatter present — check for required keys
    if grep -qE '^artifact_type:' "$file"; then
      _pass "$file frontmatter has artifact_type"
    else
      _fail "$file has frontmatter but missing artifact_type"
    fi
  else
    _pass "$file has no frontmatter (expected for PROFILE.md)"
  fi
}

DEFAULT_PROFILE="${PLUGIN_ROOT}/profiles/default/PROFILE.md"
EXECUTE_PROFILE="${PLUGIN_ROOT}/profiles/execute/PROFILE.md"

assert_profile "$DEFAULT_PROFILE"
assert_profile "$EXECUTE_PROFILE"

echo ""
echo "─────────────────────────────────────"
printf 'Passed: %d | Failed: %d\n' "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
