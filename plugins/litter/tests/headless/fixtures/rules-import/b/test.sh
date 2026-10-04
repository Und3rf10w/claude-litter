#!/bin/sh
# Checks part b.
set -e
. ./b/lib.sh
[ "$(b_hello)" = 'hello from b' ] || { echo "b_hello printed $(b_hello)"; exit 1; }
