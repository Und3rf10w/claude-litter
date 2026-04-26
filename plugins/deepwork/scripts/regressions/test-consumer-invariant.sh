#!/usr/bin/env bash
# test-consumer-invariant.sh — verifies every field in state-schema.json has at least one
# named consumer in skills/, hooks/, or scripts/regressions/.
#
# Invariant source: plugins/deepwork/references/frontmatter-schemas.md §invariant
# "a field must have a named consumer before it ships."
#
# Usage: bash test-consumer-invariant.sh
# Exit 0 = all fields have consumers; Exit 1 = one or more fields lack consumers.
#
# To exempt a field from this check (e.g., a structural key that is consumed implicitly),
# add its name to the EXEMPT array below with a comment explaining why.

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SCHEMA_FILE="${PLUGIN_ROOT}/profiles/default/state-schema.json"

# Fields exempt from the consumer check — add name + reason comment.
EXEMPT=(
  # iteration_queue: P1 deferral per mode-parity audit 2026-04-23;
  # re-evaluate after Wave 3 (PostToolBatch consolidation) lands
  iteration_queue
)

# Consumer search roots: where field names must appear to count as "consumed".
CONSUMER_ROOTS=(
  "${PLUGIN_ROOT}/skills"
  "${PLUGIN_ROOT}/hooks"
  "${PLUGIN_ROOT}/scripts/regressions"
)

# Minimum number of consumer references required per field (default: 1).
MIN_CONSUMERS=1

PASS=0
FAIL=0
GAPS=()

if [[ ! -f "$SCHEMA_FILE" ]]; then
  printf 'FAIL: state-schema.json not found at %s\n' "$SCHEMA_FILE" >&2
  exit 1
fi

# Extract top-level field names from JSON object keys.
if ! command -v python3 &>/dev/null; then
  printf 'FAIL: python3 required to parse state-schema.json\n' >&2
  exit 1
fi

FIELDS_RAW=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
for k in d.keys():
    print(k)
" "$SCHEMA_FILE" 2>/dev/null)

if [[ -z "$FIELDS_RAW" ]]; then
  printf 'FAIL: no fields extracted from %s\n' "$SCHEMA_FILE" >&2
  exit 1
fi

# Convert newline-separated output to array (bash 3.2 compatible).
IFS=$'\n' read -rd '' -a FIELDS <<< "$FIELDS_RAW" || true

echo "── Consumer-invariant check: ${#FIELDS[@]} fields in state-schema.json ──"
echo ""

for field in "${FIELDS[@]}"; do
  # Check exemption list.
  skip=0
  for ex in "${EXEMPT[@]}"; do
    if [[ "$ex" == "$field" ]]; then
      skip=1
      break
    fi
  done
  if [[ $skip -eq 1 ]]; then
    printf 'skip: %s (exempt)\n' "$field"
    continue
  fi

  # Count consumer references across all search roots.
  count=0
  for root in "${CONSUMER_ROOTS[@]}"; do
    if [[ -d "$root" ]]; then
      n=$(grep -rl -- "${field}" "$root" 2>/dev/null | wc -l | tr -d ' ')
      count=$((count + n))
    fi
  done

  if [[ $count -ge $MIN_CONSUMERS ]]; then
    printf 'pass: %s (%d consumer file(s))\n' "$field" "$count"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — 0 consumer references in skills/, hooks/, scripts/regressions/\n' "$field" >&2
    FAIL=$((FAIL + 1))
    GAPS+=("$field")
  fi
done

echo ""
echo "─────────────────────────────────────"
printf 'Passed: %d | Failed: %d\n' "$PASS" "$FAIL"

if [[ ${#GAPS[@]} -gt 0 ]]; then
  echo ""
  echo "Fields with no consumers (C6 invariant violations):"
  for g in "${GAPS[@]}"; do
    printf '  - %s\n' "$g"
  done
fi

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
