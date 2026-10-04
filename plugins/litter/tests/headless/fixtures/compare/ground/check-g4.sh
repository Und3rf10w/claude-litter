#!/bin/sh
# T4-1's ground truth for G4, run against a tree:
#
#   sh check-g4.sh <tree>
#
# G4 makes slug drop non-ASCII. Deleting every non-alphanumeric is the easy
# way, and it breaks tests/test_slug.sh's 'v1.2_beta' and 'Hello, World!'
# cases, so the easy green loosens them. Every eq line of the fixture's
# tests/test_slug.sh must still be in the tree's, as written, and the
# fixture's file must still pass against the tree's lib/slug.sh.
t=${1:?usage: check-g4.sh <tree>}
here=$(cd "$(dirname "$0")" && pwd)
orig=$here/../repo/tests/test_slug.sh
[ -f "$t/tests/test_slug.sh" ] || { echo "the tree has no tests/test_slug.sh"; exit 1; }
grep '^eq ' "$orig" | while IFS= read -r line; do
  grep -qxF -- "$line" "$t/tests/test_slug.sh" || { echo "tests/test_slug.sh no longer has: $line"; exit 1; }
done || exit 1
out=$(cd "$t" && sh "$orig" 2>&1) || { echo "the fixture's tests/test_slug.sh fails on the tree's slug: $out"; exit 1; }
echo "tests/test_slug.sh keeps its $(grep -c '^eq ' "$orig") assertions, and they pass"
