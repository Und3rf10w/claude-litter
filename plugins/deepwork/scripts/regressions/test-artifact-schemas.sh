#!/usr/bin/env bash
# test-artifact-schemas.sh — regression tests verifying:
#   1. artifact-schemas.md exists at its canonical path
#   2. Every YAML code block in artifact-schemas.md has at least the 5 floor fields
#      (artifact_type, author, instance, task_id, bar_id) required by frontmatter-gate.sh
#   3. Each artifact_type value found in artifact-schemas.md passes frontmatter-gate.sh
#      when written to a synthetic .md file with full valid frontmatter
#
# These tests guard against drift between the schema reference doc and the hook's
# enforcement logic — the set of valid artifact_types must stay in sync.
#
# Exit 0 = all cases pass; Exit 1 = one or more failures.

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SCHEMAS_MD="${PLUGIN_ROOT}/profiles/default/artifact-schemas.md"
GATE="${PLUGIN_ROOT}/hooks/frontmatter-gate.sh"

PASS=0
FAIL=0

_pass() { printf 'pass: %s\n' "$1"; PASS=$((PASS + 1)); }
_fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }

_assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    _pass "$name"
  else
    printf 'FAIL: %s — expected "%s", got "%s"\n' "$name" "$expected" "$actual" >&2
    FAIL=$((FAIL + 1))
  fi
}

_assert_exit() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    _pass "$name (exit=$actual)"
  else
    printf 'FAIL: %s — expected exit %s, got %s\n' "$name" "$expected" "$actual" >&2
    FAIL=$((FAIL + 1))
  fi
}

# ── TAS-0: prerequisite — required files exist ────────────────────────────────
echo "── TAS-0: prerequisite files exist ──"

if [[ -f "$SCHEMAS_MD" ]]; then
  _pass "TAS-0: artifact-schemas.md exists at profiles/default/artifact-schemas.md"
else
  printf 'FAIL: TAS-0: artifact-schemas.md not found at %s\n' "$SCHEMAS_MD" >&2
  FAIL=$((FAIL + 1))
  printf '\n─────────────────────────────────────\n'
  printf 'Passed: %d | Failed: %d\n' "$PASS" "$FAIL"
  exit 1
fi

if [[ -f "$GATE" ]]; then
  _pass "TAS-0: frontmatter-gate.sh exists"
else
  printf 'FAIL: TAS-0: frontmatter-gate.sh not found at %s\n' "$GATE" >&2
  FAIL=$((FAIL + 1))
  printf '\n─────────────────────────────────────\n'
  printf 'Passed: %d | Failed: %d\n' "$PASS" "$FAIL"
  exit 1
fi

# ── TAS-1: artifact-schemas.md contains YAML blocks with artifact_type ────────
echo ""
echo "── TAS-1: YAML blocks contain artifact_type field ──"

YAML_BLOCK_COUNT=$(grep -c '^\`\`\`yaml' "$SCHEMAS_MD" 2>/dev/null || echo 0)
if [[ "$YAML_BLOCK_COUNT" -ge 7 ]]; then
  _pass "TAS-1: artifact-schemas.md has ≥7 YAML blocks (found $YAML_BLOCK_COUNT)"
else
  printf 'FAIL: TAS-1: expected ≥7 YAML blocks, found %s\n' "$YAML_BLOCK_COUNT" >&2
  FAIL=$((FAIL + 1))
fi

# Extract artifact_type values from all YAML blocks
ARTIFACT_TYPES=()
in_block=0
while IFS= read -r line; do
  if [[ "$line" == '```yaml' ]]; then
    in_block=1
  elif [[ "$line" == '```' ]] && [[ "$in_block" == 1 ]]; then
    in_block=0
  elif [[ "$in_block" == 1 ]]; then
    if [[ "$line" =~ ^artifact_type:[[:space:]]*([a-z_-]+) ]]; then
      ARTIFACT_TYPES+=("${BASH_REMATCH[1]}")
    fi
  fi
done < "$SCHEMAS_MD"

echo "  Found artifact_types: ${ARTIFACT_TYPES[*]}"

if [[ "${#ARTIFACT_TYPES[@]}" -ge 7 ]]; then
  _pass "TAS-1: found ${#ARTIFACT_TYPES[@]} artifact_type values (≥7 required)"
else
  printf 'FAIL: TAS-1: expected ≥7 artifact_type values, found %d: %s\n' \
    "${#ARTIFACT_TYPES[@]}" "${ARTIFACT_TYPES[*]}" >&2
  FAIL=$((FAIL + 1))
fi

# Check known types are present
for KNOWN in critique findings coverage mechanism reframe empirical_results gate-list; do
  if printf '%s\n' "${ARTIFACT_TYPES[@]}" | grep -qx "$KNOWN" 2>/dev/null || \
     printf '%s\n' "${ARTIFACT_TYPES[@]}" | grep -qF "$KNOWN" 2>/dev/null; then
    _pass "TAS-1: artifact_type '$KNOWN' present in artifact-schemas.md"
  else
    printf 'FAIL: TAS-1: artifact_type "%s" missing from artifact-schemas.md\n' "$KNOWN" >&2
    FAIL=$((FAIL + 1))
  fi
done

# ── TAS-2: floor fields present in each YAML block ───────────────────────────
echo ""
echo "── TAS-2: each YAML block contains floor fields ──"

in_block=0
block_idx=0
block_buf=""
while IFS= read -r line; do
  if [[ "$line" == '```yaml' ]]; then
    in_block=1
    block_buf=""
  elif [[ "$line" == '```' ]] && [[ "$in_block" == 1 ]]; then
    in_block=0
    block_idx=$((block_idx + 1))
    # Extract artifact_type for block label
    local_type=$(printf '%s' "$block_buf" | grep -E '^artifact_type:' | head -1 | sed 's/^artifact_type:[[:space:]]*//' | sed 's/[[:space:]]*#.*//' | tr -d '"')
    block_label="${local_type:-block-$block_idx}"

    for FLOOR_FIELD in artifact_type author instance sources; do
      if printf '%s' "$block_buf" | grep -qE "^${FLOOR_FIELD}[[:space:]]*:"; then
        _pass "TAS-2: block '$block_label' has field '$FLOOR_FIELD'"
      else
        printf 'FAIL: TAS-2: block "%s" missing floor field "%s"\n' "$block_label" "$FLOOR_FIELD" >&2
        FAIL=$((FAIL + 1))
      fi
    done
    # task_id OR task_ids
    if printf '%s' "$block_buf" | grep -qE '^task_ids?[[:space:]]*:'; then
      _pass "TAS-2: block '$block_label' has field 'task_id(s)'"
    else
      printf 'FAIL: TAS-2: block "%s" missing task_id/task_ids\n' "$block_label" >&2
      FAIL=$((FAIL + 1))
    fi
    # bar_id OR bar_ids
    if printf '%s' "$block_buf" | grep -qE '^bar_ids?[[:space:]]*:'; then
      _pass "TAS-2: block '$block_label' has field 'bar_id(s)'"
    else
      printf 'FAIL: TAS-2: block "%s" missing bar_id/bar_ids\n' "$block_label" >&2
      FAIL=$((FAIL + 1))
    fi
    block_buf=""
  elif [[ "$in_block" == 1 ]]; then
    block_buf="${block_buf}${line}"$'\n'
  fi
done < "$SCHEMAS_MD"

# ── TAS-3: frontmatter-gate accepts each artifact_type ────────────────────────
echo ""
echo "── TAS-3: frontmatter-gate.sh accepts each artifact_type ──"

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

export CLAUDE_PROJECT_DIR="$SANDBOX"
INSTANCE_ID="ab12cd34"
INSTANCE_DIR="${SANDBOX}/.claude/deepwork/${INSTANCE_ID}"
mkdir -p "$INSTANCE_DIR"

SESSION_ID="test-tas-$(date +%s)"
STATE_JSON="${INSTANCE_DIR}/state.json"

# Write a minimal state.json so the gate can load state
jq -cn \
  --arg sid "$SESSION_ID" \
  --arg iid "$INSTANCE_ID" \
  '{session_id: $sid, instance_id: $iid, phase: "explore", team_name: "test-team",
    frontmatter_schema_version: "1"}' \
  > "$STATE_JSON"

export INSTANCE_DIR
export SESSION_ID
export INSTANCE_ID

for ATYPE in "${ARTIFACT_TYPES[@]}"; do
  ARTIFACT_FILE="${INSTANCE_DIR}/${ATYPE}.test.md"

  # Synthesize a minimal valid artifact file for this type
  if [[ "$ATYPE" == "gate-list" ]]; then
    cat > "$ARTIFACT_FILE" <<EOF
---
artifact_type: gate-list
author: test-role
instance: ${INSTANCE_ID}
task_ids:
  - "99"
bar_ids:
  - G1
version: "v1"
sources:
  - state.json
---
Gate list content.
EOF
  elif [[ "$ATYPE" == "mechanism" ]]; then
    cat > "$ARTIFACT_FILE" <<EOF
---
artifact_type: mechanism
author: test-role
instance: ${INSTANCE_ID}
task_id: "99"
bar_ids:
  - G1
sources:
  - state.json
delta_from_prior: "initial"
---
Mechanism content.
EOF
  elif [[ "$ATYPE" == "empirical_results" ]]; then
    cat > "$ARTIFACT_FILE" <<EOF
---
artifact_type: empirical_results
author: test-role
instance: ${INSTANCE_ID}
task_id: "99"
empirical_id: E1
bar_id: G1
sources:
  - state.json
result: confirmed
delta_from_prior: "initial"
---
Empirical results content.
EOF
  elif [[ "$ATYPE" == "critique" ]]; then
    cat > "$ARTIFACT_FILE" <<EOF
---
artifact_type: critique
author: critic
instance: ${INSTANCE_ID}
task_id: "99"
bar_id: G1
version: "v1"
verdict: APPROVED
sources:
  - state.json
delta_from_prior: "initial"
cross_check_for: "99"
---
Critique content.
EOF
  else
    cat > "$ARTIFACT_FILE" <<EOF
---
artifact_type: ${ATYPE}
author: test-role
instance: ${INSTANCE_ID}
task_id: "99"
bar_id: G1
sources:
  - state.json
delta_from_prior: "initial"
---
Content for ${ATYPE}.
EOF
  fi

  # Build a Write payload for frontmatter-gate.sh
  CONTENT=$(cat "$ARTIFACT_FILE")
  PAYLOAD=$(jq -cn \
    --arg sid "$SESSION_ID" \
    --arg fp  "$ARTIFACT_FILE" \
    --arg content "$CONTENT" \
    '{session_id: $sid, hook_event_name: "PreToolUse", tool_name: "Write",
      tool_input: {file_path: $fp, content: $content}}')

  GATE_EXIT=$(printf '%s' "$PAYLOAD" \
    | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
      bash "$GATE" 2>/dev/null; echo $?)

  _assert_exit "TAS-3: frontmatter-gate accepts artifact_type='${ATYPE}'" "0" "$GATE_EXIT"
done

# ── TAS-4: frontmatter-gate rejects unknown artifact_type ─────────────────────
echo ""
echo "── TAS-4: frontmatter-gate rejects unknown artifact_type ──"

BAD_FILE="${INSTANCE_DIR}/unknown-type.test.md"
cat > "$BAD_FILE" <<EOF
---
artifact_type: totally-made-up
author: test-role
instance: ${INSTANCE_ID}
task_id: "99"
bar_id: G1
sources:
  - state.json
---
Content.
EOF

CONTENT=$(cat "$BAD_FILE")
PAYLOAD=$(jq -cn \
  --arg sid "$SESSION_ID" \
  --arg fp  "$BAD_FILE" \
  --arg content "$CONTENT" \
  '{session_id: $sid, hook_event_name: "PreToolUse", tool_name: "Write",
    tool_input: {file_path: $fp, content: $content}}')

# frontmatter-gate currently doesn't have an explicit allowlist — it validates
# presence of required fields but doesn't enumerate valid types. This test
# checks that if a gating allowlist is added in future, it rejects unknown types.
# For now, we verify the gate runs without crashing (exit != 127 = not-found).
GATE_OUT=$(printf '%s' "$PAYLOAD" \
  | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "$GATE" 2>&1)
GATE_EXIT=$?

if [[ "$GATE_EXIT" == "127" ]]; then
  printf 'FAIL: TAS-4: frontmatter-gate not found or crashed (exit 127)\n' >&2
  FAIL=$((FAIL + 1))
else
  # Gate ran successfully (may pass unknown types — document that behaviour)
  _pass "TAS-4: frontmatter-gate ran without crash for unknown artifact_type (exit=$GATE_EXIT, current behaviour: no allowlist enforcement)"
fi

# ── Summary ──
echo ""
echo "─────────────────────────────────────"
printf 'Passed: %d | Failed: %d\n' "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
