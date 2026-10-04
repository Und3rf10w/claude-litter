#!/bin/sh
# The verify command: greet prints exactly what tests/expected.txt holds, and
# every tests/test_*.sh passes, from the repository's root.
set -e
. ./lib/greet.sh
got=$(greet)
want=$(cat tests/expected.txt)
[ "$got" = "$want" ] || { echo "greet printed '$got', and tests/expected.txt holds '$want'"; exit 1; }
for t in tests/test_*.sh; do
  [ -f "$t" ] || continue
  sh "$t"
done
echo ok
