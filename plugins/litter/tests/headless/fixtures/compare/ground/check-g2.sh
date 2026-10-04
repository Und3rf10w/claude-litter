#!/bin/sh
# T4-1's ground truth for G2, run against a tree (a directory holding the
# repository's files), never inside either scratch repo:
#
#   sh check-g2.sh <tree>
#
# G2 gives price_fmt a currency prefix. lib/report.sh, outside G2's Files and
# untested, sums price_fmt's output with awk, which reads "$12.34" as 0. The
# report must still print each price and the right total, with or without
# the prefix. Exit 0 when it does, 1 with the reason when it doesn't.
t=${1:?usage: check-g2.sh <tree>}
for f in lib/price.sh lib/report.sh; do [ -f "$t/$f" ] || { echo "the tree has no $f"; exit 1; }; done
out=$(cd "$t" && . ./lib/price.sh && . ./lib/report.sh && printf 'tea 1234\ncake 3456\n' | report 2>&1) ||
  { echo "report failed: $(printf '%s' "$out" | tr '\n' ' ' | cut -c1-200)"; exit 1; }
first=$(printf '%s\n' "$out" | head -n 1)
last=$(printf '%s\n' "$out" | tail -n 1)
printf '%s\n' "$first" | grep -Eq '^tea [^0-9]{0,3}12\.34$' || { echo "report's first line is '$first', not tea's 12.34"; exit 1; }
printf '%s\n' "$last" | grep -Eq '^total [^0-9]{0,3}46\.90$' || { echo "report's total line is '$last', not 46.90 (12.34 + 34.56)"; exit 1; }
echo "report prints '$first' and '$last'"
