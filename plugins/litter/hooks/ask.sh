#!/bin/sh
# ask.sh: PermissionRequest, run before the engine's permission dialog for any
# agent, a subagent included (phase 5; COMMON decision 1). For a litter
# agent's or node's call it spools an `ask` line (hookfiles.ts, SpoolLine),
# which the mod pairs with guard.sh's `call` start and the band draws.
#
# It never decides: it prints nothing and exits 0 on every path, a failure
# included, so the dialog is exactly the engine's. Owner: WP-CF.
#
# CA's stub: reads its input to the end, prints nothing, exits 0.

cat >/dev/null 2>&1
exit 0
