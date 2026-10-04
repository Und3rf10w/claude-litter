#!/bin/sh
# Checks part a.
set -e
. ./a/lib.sh
[ "$(a_hello)" = 'hello from a' ] || { echo "a_hello printed $(a_hello)"; exit 1; }
