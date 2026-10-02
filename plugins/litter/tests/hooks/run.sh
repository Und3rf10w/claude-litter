#!/bin/sh
# Tier 3: runs every tests/hooks/*.test.sh under one shell.
#
#   sh tests/hooks/run.sh                 # under sh
#   SHELL_UNDER_TEST=dash sh tests/hooks/run.sh
#   SHELL_UNDER_TEST="busybox sh" sh tests/hooks/run.sh
#   T_ONLY="fast path" sh tests/hooks/run.sh
#
# Exits non-zero when any file fails.

here=$(cd "$(dirname "$0")" && pwd)
LITTER_ROOT=$(cd "$here/../.." && pwd)
export LITTER_ROOT
shell=${SHELL_UNDER_TEST:-sh}
SHELL_UNDER_TEST=$shell
export SHELL_UNDER_TEST
failed=0
found=0

for f in "$here"/*.test.sh; do
  [ -f "$f" ] || continue
  found=$((found + 1))
  # $shell is a word list on purpose ("busybox sh").
  # shellcheck disable=SC2086
  $shell "$f" || failed=$((failed + 1))
done

if [ "$found" -eq 0 ]; then
  echo "tests/hooks: no *.test.sh files yet"
  exit 0
fi
[ "$failed" -eq 0 ] || {
  echo "tests/hooks: $failed of $found files failed"
  exit 1
}
echo "tests/hooks: $found files passed"
