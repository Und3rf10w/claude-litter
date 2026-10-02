#!/bin/sh
# Tier 4: builds the managed-settings box and runs managed.sh in it, once per
# mode (plan section 12). The plugin is mounted read-only; the runs' files land
# in $H_OUT (default $TMPDIR/litter-tier4-managed) on this machine.
#
#   H_PASS_ENV='ANTHROPIC_API_KEY' sh tests/headless/container/container.sh [mode...]
#
# H_PASS_ENV names the environment variables claude needs to reach its model
# provider. Each is passed with `docker run -e NAME`, so its value never shows
# on a command line, and nothing else from this machine's environment goes in.
# The modes are managed.sh's; with none, all of them.

set -u
here=$(cd "$(dirname "$0")" && pwd)
litter=$(cd "$here/../../.." && pwd)
out=${H_OUT:-${TMPDIR:-/tmp}/litter-tier4-managed}
image=${H_IMAGE:-litter-tier4}
[ -n "${H_PASS_ENV:-}" ] || { echo "set H_PASS_ENV to the variables claude needs for its provider" >&2; exit 2; }
mkdir -p "$out" || exit 1
docker build -q -t "$image" "$here" >/dev/null || exit 1

envs=
for v in $H_PASS_ENV; do
  eval "set_=\${$v+x}"
  [ -n "$set_" ] || { echo "$v isn't set here" >&2; exit 2; }
  envs="$envs -e $v"
done

[ "$#" -gt 0 ] || set -- seated mcp mods
failed=0
for mode in "$@"; do
  # $envs is a word list on purpose: -e NAME pairs.
  # shellcheck disable=SC2086
  docker run --rm $envs -e H_OUT=/work -v "$litter:/src:ro" -v "$out:/work" "$image" \
    sh /src/tests/headless/managed.sh "$mode" || failed=$((failed + 1))
done
[ "$failed" -eq 0 ]
