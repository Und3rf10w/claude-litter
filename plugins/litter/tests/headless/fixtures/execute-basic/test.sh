#!/bin/sh
# The verify command: every tests/test_*.sh, from the repository's root.
set -e
for t in tests/test_*.sh; do
  sh "$t"
done
echo ok
