#!/bin/bash
# verify-completion.sh — Swarm loop completion verification (v2.0)
# Delegates to the generated .claude/swarm-loop.local.verify.sh which embeds the verify
# command as base64 (set at setup time, immune to state file tampering).
# If no generated script exists, there's nothing to verify — pass.

set -euo pipefail

VERIFY_SCRIPT=".claude/swarm-loop.local.verify.sh"

if [[ ! -x "$VERIFY_SCRIPT" ]]; then
  # No custom verification command was configured — pass
  exit 0
fi

# Delegate to the generated script (command is base64-embedded, not read from state)
exec "$VERIFY_SCRIPT" "$@"
