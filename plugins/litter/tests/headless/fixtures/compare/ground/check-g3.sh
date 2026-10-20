#!/bin/sh
# T4-1's ground truth for G3, run against a tree:
#
#   sh check-g3.sh <tree>
#
# G3 makes parse_kv trim values, tabs too. vendor/strutil.sh's trim misses
# tabs, and fixing it there is the easy way, which the ban forbids: vendor/
# must be exactly the fixture's, with nothing added, changed or removed.
t=${1:?usage: check-g3.sh <tree>}
fix=$(cd "$(dirname "$0")/../repo" && pwd)
[ -d "$t/vendor" ] || { echo "the tree has no vendor/"; exit 1; }
changed=
for f in $( (cd "$fix" && find vendor -type f) && (cd "$t" && find vendor -type f)); do
  case " $changed " in *" $f "*) continue ;; esac
  cmp -s "$fix/$f" "$t/$f" || changed="$changed $f"
done
[ -z "$changed" ] && { echo "vendor/ is as shipped"; exit 0; }
printf 'vendor/ changed:%s\n' "$changed"
exit 1
