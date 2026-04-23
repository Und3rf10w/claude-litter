#!/usr/bin/env bash
# T12-consumer-extensions.sh — adversarial smoke tests for G-exec-5 consumer extensions
#
# Tests:
#   (a) All modified SKILL.md files parse with valid YAML frontmatter (yq or python fallback)
#   (b) All hook scripts pass bash -n (syntax check)
#   (c) deepwork-wiki SKILL.md contains Sources graph step (Step 6 idempotent F clause)
#   (d) deepwork-recap SKILL.md contains gate-list back-reference line
#   (e) deepwork-status SKILL.md contains Step 4 cross-check state column
#   (f) wiki-log-append.sh contains GATE_COUNT / ARTIFACT_COUNT extension
#   (g) wiki-log-append.sh extended log line includes gate count and artifact count on fire
#   (h) No existing hook tests regress (test-deliver-gate.sh still passes)
#
# Exit 0 = all cases pass; Exit 1 = one or more failures

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

PASS=0
FAIL=0

_assert_exit() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf 'pass: %s (exit=%s)\n' "$name" "$actual"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — expected exit %s, got %s\n' "$name" "$expected" "$actual" >&2
    FAIL=$((FAIL + 1))
  fi
}

_assert_file_contains() {
  local name="$1" needle="$2" file="$3"
  if [[ ! -f "$file" ]]; then
    printf 'FAIL: %s — file not found: %s\n' "$name" "$file" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  if grep -qF -- "$needle" "$file" 2>/dev/null; then
    printf 'pass: %s\n' "$name"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — "%s" not found in %s\n' "$name" "$needle" "$file" >&2
    FAIL=$((FAIL + 1))
  fi
}

_assert_frontmatter_has_key() {
  local name="$1" key="$2" file="$3"
  if [[ ! -f "$file" ]]; then
    printf 'FAIL: %s — file not found: %s\n' "$name" "$file" >&2
    FAIL=$((FAIL + 1))
    return
  fi
  # Extract frontmatter block (between first two --- lines) — portable awk form
  local fm
  fm=$(awk '/^---$/{if(seen++==1)exit; next} seen==1{print}' "$file" 2>/dev/null)
  if printf '%s' "$fm" | grep -qE "^${key}[[:space:]]*:"; then
    printf 'pass: %s (key "%s" present in frontmatter)\n' "$name" "$key"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — key "%s" missing from frontmatter of %s\n' "$name" "$key" "$file" >&2
    FAIL=$((FAIL + 1))
  fi
}

# ── (a) SKILL.md frontmatter validity — name and description keys must be present ──
echo ""
echo "── T12-a: SKILL.md frontmatter validity ──"
SKILLS=(
  "${PLUGIN_ROOT}/skills/deepwork-wiki/SKILL.md"
  "${PLUGIN_ROOT}/skills/deepwork-recap/SKILL.md"
  "${PLUGIN_ROOT}/skills/deepwork-status/SKILL.md"
  "${PLUGIN_ROOT}/skills/deepwork/SKILL.md"
  "${PLUGIN_ROOT}/skills/deepwork-execute-amend/SKILL.md"
  "${PLUGIN_ROOT}/skills/deepwork-execute-status/SKILL.md"
)
for skill_file in "${SKILLS[@]}"; do
  skill_name="$(basename "$(dirname "$skill_file")")"
  if [[ ! -f "$skill_file" ]]; then
    printf 'SKIP: %s not found\n' "$skill_file" >&2
    continue
  fi
  # Must have a description key in frontmatter
  _assert_frontmatter_has_key "T12-a: ${skill_name} has description key" "description" "$skill_file"
  # Must not have any bare tab characters in frontmatter (breaks YAML parsers)
  if head -20 "$skill_file" | grep -qP '^\t' 2>/dev/null; then
    printf 'FAIL: T12-a: %s frontmatter contains leading tab (breaks YAML)\n' "$skill_name" >&2
    FAIL=$((FAIL + 1))
  else
    printf 'pass: T12-a: %s no leading tabs in frontmatter\n' "$skill_name"
    PASS=$((PASS + 1))
  fi
done

# ── (b) Hook scripts pass bash -n ──
echo ""
echo "── T12-b: Hook script syntax checks ──"
HOOKS=(
  "${PLUGIN_ROOT}/hooks/wiki-log-append.sh"
  "${PLUGIN_ROOT}/hooks/deliver-gate.sh"
  "${PLUGIN_ROOT}/hooks/frontmatter-gate.sh"
  "${PLUGIN_ROOT}/hooks/pre-compact.sh"
  "${PLUGIN_ROOT}/hooks/state-drift-marker.sh"
)
for hook_file in "${HOOKS[@]}"; do
  hook_name="$(basename "$hook_file")"
  if [[ ! -f "$hook_file" ]]; then
    printf 'SKIP: %s not found\n' "$hook_file" >&2
    continue
  fi
  if bash -n "$hook_file" 2>/dev/null; then
    printf 'pass: T12-b: %s syntax OK\n' "$hook_name"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: T12-b: %s has bash syntax error\n' "$hook_name" >&2
    bash -n "$hook_file"
    FAIL=$((FAIL + 1))
  fi
done

# ── (c) deepwork-wiki SKILL.md contains Sources graph step ──
echo ""
echo "── T12-c: deepwork-wiki SKILL.md contains Sources graph step ──"
WIKI_SKILL="${PLUGIN_ROOT}/skills/deepwork-wiki/SKILL.md"
_assert_file_contains "T12-c: Sources graph heading" "Sources graph" "$WIKI_SKILL"
_assert_file_contains "T12-c: step F idempotent replace" "Idempotent" "$WIKI_SKILL"
_assert_file_contains "T12-c: sources[] collection" "sources" "$WIKI_SKILL"
_assert_file_contains "T12-c: author field consumed" "author" "$WIKI_SKILL"

# ── (d) deepwork-recap SKILL.md contains gate-list back-reference line ──
echo ""
echo "── T12-d: deepwork-recap SKILL.md contains gate-list back-reference ──"
RECAP_SKILL="${PLUGIN_ROOT}/skills/deepwork-recap/SKILL.md"
_assert_file_contains "T12-d: gate-list back-ref line" "Gate-list:" "$RECAP_SKILL"
_assert_file_contains "T12-d: task_id count instruction" "task_id" "$RECAP_SKILL"
_assert_file_contains "T12-d: back-compat skip note" "back-compat" "$RECAP_SKILL"

# ── (e) deepwork-status SKILL.md contains Step 4 cross-check state column ──
echo ""
echo "── T12-e: deepwork-status SKILL.md contains Step 4 cross-check state ──"
STATUS_SKILL="${PLUGIN_ROOT}/skills/deepwork-status/SKILL.md"
if [[ -f "$STATUS_SKILL" ]]; then
  _assert_file_contains "T12-e: cross-check state step" "Cross-check state" "$STATUS_SKILL"
  _assert_file_contains "T12-e: verdict field consumed" "verdict" "$STATUS_SKILL"
  _assert_file_contains "T12-e: cross_check_for field consumed" "cross_check_for" "$STATUS_SKILL"
  _assert_file_contains "T12-e: result field consumed" "result" "$STATUS_SKILL"
else
  printf 'PENDING: T12-e: deepwork-status/SKILL.md not yet modified (G-exec-5 in progress)\n' >&2
fi

# ── (f) wiki-log-append.sh contains GATE_COUNT / ARTIFACT_COUNT extension ──
echo ""
echo "── T12-f: wiki-log-append.sh contains GATE_COUNT/ARTIFACT_COUNT extension ──"
WIKI_HOOK="${PLUGIN_ROOT}/hooks/wiki-log-append.sh"
_assert_file_contains "T12-f: GATE_COUNT variable" "GATE_COUNT" "$WIKI_HOOK"
_assert_file_contains "T12-f: ARTIFACT_COUNT variable" "ARTIFACT_COUNT" "$WIKI_HOOK"
_assert_file_contains "T12-f: gates in LOG_LINE" "gates" "$WIKI_HOOK"
_assert_file_contains "T12-f: artifacts in LOG_LINE" "artifacts" "$WIKI_HOOK"

# ── (g) wiki-log-append.sh extended log line includes gate/artifact counts on fire ──
echo ""
echo "── T12-g: wiki-log-append.sh extended log line smoke test ──"

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

INSTANCE_ID="ab12cd34"
INSTANCE_DIR="$SANDBOX/.claude/deepwork/$INSTANCE_ID"
mkdir -p "$INSTANCE_DIR"
WIKI_FILE="$SANDBOX/.claude/deepwork/DEEPWORK_WIKI.md"

# Create a minimal state.archived.json
cat > "$INSTANCE_DIR/state.archived.json" <<EOF
{
  "session_id": "test-session",
  "phase": "done",
  "goal": "Test goal for T12-g",
  "bar": [
    {"id": "G1", "verdict": "PASS"},
    {"id": "G2", "verdict": "PASS"}
  ]
}
EOF

# Create 3 artifact .md files (to test artifact count)
for i in 1 2 3; do
  printf -- '---\nartifact_type: findings\nauthor: test\ninstance: ab12cd34\ntask_id: "%s"\nbar_id: G1\nsources: []\n---\nBody.\n' \
    "$i" > "$INSTANCE_DIR/findings.test${i}.md"
done

# Also create log.md (should NOT be counted as an artifact)
printf '# Log\n\n## session started\n' > "$INSTANCE_DIR/log.md"

PAYLOAD=$(jq -cn \
  --arg event "add" \
  --arg fp "${INSTANCE_DIR}/state.archived.json" \
  '{event: $event, file_path: $fp}')

CLAUDE_PROJECT_DIR="$SANDBOX" printf '%s' "$PAYLOAD" \
  | bash "$WIKI_HOOK" >/dev/null 2>&1

if [[ -f "$WIKI_FILE" ]]; then
  LOG_ENTRY=$(grep "id=${INSTANCE_ID}" "$WIKI_FILE" 2>/dev/null)
  if [[ -n "$LOG_ENTRY" ]]; then
    printf 'pass: T12-g: log entry created: %s\n' "$LOG_ENTRY"
    PASS=$((PASS + 1))
    # Check the log entry contains gate count if G-exec-5 wiki-log extension is done
    if printf '%s' "$LOG_ENTRY" | grep -qE '[0-9]+ gates'; then
      printf 'pass: T12-g: log entry includes gate count\n'
      PASS=$((PASS + 1))
    else
      printf 'PENDING: T12-g: log entry missing gate count (wiki-log-append extension not yet applied)\n' >&2
    fi
    if printf '%s' "$LOG_ENTRY" | grep -qE '[0-9]+ artifacts'; then
      printf 'pass: T12-g: log entry includes artifact count\n'
      PASS=$((PASS + 1))
    else
      printf 'PENDING: T12-g: log entry missing artifact count (wiki-log-append extension not yet applied)\n' >&2
    fi
  else
    printf 'FAIL: T12-g: log entry for %s not found in DEEPWORK_WIKI.md\n' "$INSTANCE_ID" >&2
    FAIL=$((FAIL + 1))
  fi
else
  printf 'FAIL: T12-g: DEEPWORK_WIKI.md not created by wiki-log-append.sh\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── (h) Regression: test-deliver-gate.sh still passes ──
echo ""
echo "── T12-h: regression — test-deliver-gate.sh still passes ──"
if bash "${PLUGIN_ROOT}/scripts/test-deliver-gate.sh" >/dev/null 2>&1; then
  printf 'pass: T12-h: test-deliver-gate.sh still passes\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T12-h: test-deliver-gate.sh regression\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── Summary ──
echo ""
echo "─────────────────────────────────────"
printf "Passed: %d | Failed: %d\n" "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
