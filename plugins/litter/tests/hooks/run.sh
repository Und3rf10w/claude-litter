#!/bin/sh
# Tier 3: runs every tests/hooks/*.test.sh under one shell.
#
#   sh tests/hooks/run.sh                 # under sh
#   SHELL_UNDER_TEST=dash sh tests/hooks/run.sh
#   SHELL_UNDER_TEST="busybox sh" sh tests/hooks/run.sh
#   T_ONLY="fast path" sh tests/hooks/run.sh
#
# Exits non-zero when any file fails. The summary repeats each failed file's
# FAIL lines, and the lines under each, after the file's name; a file that
# failed with none (it died) gets its last lines.

here=$(cd "$(dirname "$0")" && pwd)
LITTER_ROOT=$(cd "$here/../.." && pwd)
export LITTER_ROOT
shell=${SHELL_UNDER_TEST:-sh}
SHELL_UNDER_TEST=$shell
export SHELL_UNDER_TEST
failed=0
found=0
kept=$(mktemp -d "${TMPDIR:-/tmp}/litter-run.XXXXXX") || exit 1
trap 'rm -rf "$kept"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
: >|"$kept/summary"

for f in "$here"/*.test.sh; do
  [ -f "$f" ] || continue
  found=$((found + 1))
  name=${f##*/}
  # $shell is a word list on purpose ("busybox sh"). Its output goes on
  # through tee, and its exit status comes back in a file, since a
  # pipeline's own is tee's. The file goes first, so a status that never
  # came back is a failure, not the last file's.
  rm -f "$kept/code"
  # shellcheck disable=SC2086
  { $shell "$f" 2>&1; echo "$?" >|"$kept/code"; } | tee "$kept/out"
  code=$(cat "$kept/code" 2>/dev/null) || code=
  [ "$code" = 0 ] && continue
  failed=$((failed + 1))
  awk -v f="$name" '
    /^FAIL / { p = 1; print f ": " $0; next }
    p && /^     / { print f ": " $0; next }
    { p = 0 }' "$kept/out" >|"$kept/fails" || : >|"$kept/fails"
  if [ -s "$kept/fails" ]; then
    cat "$kept/fails" >>"$kept/summary"
  else
    how="exited $code"
    [ -n "$code" ] || how='gave no exit status'
    echo "$name: $how with no FAIL line; its last lines:" >>"$kept/summary"
    tail -n 5 "$kept/out" | sed "s|^|$name: |" >>"$kept/summary"
  fi
done

if [ "$found" -eq 0 ]; then
  echo "tests/hooks: no *.test.sh files yet"
  exit 0
fi
[ "$failed" -eq 0 ] || {
  cat "$kept/summary"
  echo "tests/hooks: $failed of $found files failed"
  exit 1
}
echo "tests/hooks: $found files passed"
