#!/bin/sh
# The verify command: each part's check, from the repository's root.
set -e
sh a/test.sh
sh b/test.sh
echo ok
