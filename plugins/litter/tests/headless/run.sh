#!/bin/sh
# Tier 4: every headless case, one after another (plan section 12). Each is a
# real `claude -p` session on your account (swarm.sh and repair.sh drive an
# interactive one through expect), so this spends tokens and needs a signed-in claude; CI
# doesn't run it. Files stay in $H_OUT (default
# $TMPDIR/litter-tier4) for reading afterwards.
#
#   sh tests/headless/run.sh
#
# Exits non-zero when any case fails. The managed-settings cases need a box
# whose /etc/claude-code they may write: container/container.sh runs them.

here=$(cd "$(dirname "$0")" && pwd)
failed=0
for c in 'isolation.sh alone' 'isolation.sh broad' 'land.sh edit' 'land.sh clean' \
  'fanout.sh land' 'fanout.sh edit' 'fanout.sh red' 'fanout.sh stop' 'worktrees.sh resume' 'worktrees.sh default' \
  'swarm.sh trio' 'repair.sh auto' 'repair.sh off'; do
  # A word list on purpose: the script and its mode.
  # shellcheck disable=SC2086
  sh "$here"/$c || failed=$((failed + 1))
done
[ "$failed" -eq 0 ] && echo 'tests/headless: every case passed' || echo "tests/headless: $failed case(s) failed"
[ "$failed" -eq 0 ]
