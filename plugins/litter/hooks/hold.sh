#!/bin/sh
# hold.sh (SubagentStop, timeout 600): WP-M. Holds a worker's stop while any
# child bound under it hasn't finished (plan 15.4, "A worker that ends its turn
# while its children run", option C), polling every 2 s up to 570 s, once per
# child (hooks/hold/<agent_id>); writes hooks/done/<agent_id> at a stop it lets
# go; spools `hold` lines.
#
# The command hooks for one event run concurrently on 2.1.288: every matched
# hook starts at once, whatever its place in hooks.json, a block from one
# doesn't stop the others, and the engine waits for all of them (WP-C's report
# has the source lines). So this script never depends on identity.sh having
# run, and done/<agent_id> at a stop is this script's to write.
#
# Stub (phase 2b-1, package C), not built yet: every stop goes ahead.
exit 0
