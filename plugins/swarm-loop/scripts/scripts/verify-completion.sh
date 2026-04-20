#!/bin/bash
# verify-completion.sh — Swarm loop completion verification (v2.0)
# Delegates to the instance-local verify.sh which embeds the verify
# command as base64 (set at setup time, immune to state file tampering).
# If no instance verify script exists, there's nothing to verify — pass.

set -euo pipefail

STATE_FILE="${1:?verify-completion.sh requires a state file path argument}"
VERIFY_SCRIPT="$(dirname "$STATE_FILE")/verify.sh"

if [[ ! -x "$VERIFY_SCRIPT" ]]; then
  # No custom verification command was configured — pass
  exit 0
fi

# Delegate to the instance verify script (command is base64-embedded, not read from state)
exec "$VERIFY_SCRIPT" "$@"
