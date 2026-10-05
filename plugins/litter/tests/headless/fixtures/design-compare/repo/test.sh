#!/bin/sh
# Runs every tests/*.sh from the top of the repository; each exits non-zero on a failure.
cd "$(dirname "$0")" || exit 1
for t in tests/*.sh; do
  sh "$t" || { echo "FAIL $t"; exit 1; }
done
echo ok
