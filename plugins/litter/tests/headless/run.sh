#!/bin/sh
# Tier 4: every headless case, one after another (plan section 12). Each is a
# real `claude -p` session on your account (swarm.sh, repair.sh and phase 5's
# ui-*.sh drive an interactive one through expect; the ui cases also need
# bun, to read the screen), so this spends tokens and needs a signed-in claude; CI
# doesn't run it. Files stay in $H_OUT (default
# $TMPDIR/litter-tier4) for reading afterwards.
#
#   sh tests/headless/run.sh
#
# Exits non-zero when any case fails, and 3 when none failed but one was
# inconclusive (exit 3: execute.sh bridge's run that didn't halt where it
# must; run it again). The managed-settings cases need a box whose
# /etc/claude-code they may write: container/container.sh runs them.
# execute.sh compare and the deepwork smoke check are run by hand.

here=$(cd "$(dirname "$0")" && pwd)
failed=0
inconclusive=0
for c in 'isolation.sh alone' 'isolation.sh broad' 'land.sh edit' 'land.sh clean' \
  'fanout.sh land' 'fanout.sh edit' 'fanout.sh red' 'fanout.sh stop' 'worktrees.sh resume' 'worktrees.sh default' \
  'swarm.sh trio' 'repair.sh auto' 'repair.sh off' \
  'execute.sh basic' 'rules.sh import' 'execute.sh bridge auto' 'execute.sh bridge off' \
  'ui-band.sh' 'ui-card.sh' 'ui-ask.sh' 'ui-tasks.sh' 'ui-agents.sh'; do
  # A word list on purpose: the script and its mode.
  # shellcheck disable=SC2086
  sh "$here"/$c
  case $? in 0) ;; 3) inconclusive=$((inconclusive + 1)) ;; *) failed=$((failed + 1)) ;; esac
done
if [ "$failed" -gt 0 ]; then
  echo "tests/headless: $failed case(s) failed, $inconclusive inconclusive"
  exit 1
fi
[ "$inconclusive" -eq 0 ] && echo 'tests/headless: every case passed' && exit 0
echo "tests/headless: no case failed, $inconclusive inconclusive: run those again"
exit 3
