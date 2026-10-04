#!/bin/sh
# Checks add and sub.
set -e
. ./lib/math.sh
[ "$(add 2 3)" = 5 ] || { echo "add 2 3 printed $(add 2 3)"; exit 1; }
[ "$(sub 5 3)" = 2 ] || { echo "sub 5 3 printed $(sub 5 3)"; exit 1; }
