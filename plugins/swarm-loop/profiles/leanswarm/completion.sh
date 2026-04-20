#!/bin/bash

# Leanswarm completion profile for swarm-loop.
# Sourced by stop-hook.sh before the completion check.
#
# Inputs (env vars set by stop-hook.sh):
#   LAST_OUTPUT          — last assistant message text
#   COMPLETION_PROMISE   — normalized promise string (whitespace-collapsed)
#   STATE_FILE           — path to instance state.json
#   LOG_FILE             — path to instance log.md
#   STATE_JSON           — cached contents of STATE_FILE
#   ITERATION            — current iteration number (numeric)
#
# Outputs (set by this function):
#   COMPLETION_DETECTED      — "true" if promise matched and verification passed (or no verify script)
#                              "false" otherwise
#   COMPLETION_BLOCK_REASON  — non-empty plain string (human-readable reason) if verification failed.
#                              Do NOT set this to a JSON object — stop-hook.sh wraps it in the hook decision.

_completion_lib="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/scripts/completion-lib.sh"
# shellcheck source=../../scripts/completion-lib.sh
source "$_completion_lib"

check_completion() {
  _check_completion_with_verify
}
