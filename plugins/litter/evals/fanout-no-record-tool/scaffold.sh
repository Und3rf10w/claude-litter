#!/bin/sh
# The fanout-launch repository, clean and committed: with the tree ready, the
# only reason left to stop is the missing record tool.
set -eu
mkdir -p a b
printf 'Package a.\n' >|a/README
printf 'Package b.\n' >|b/README
printf '#!/bin/sh\n# Checks package a.\nset -e\n[ -f a/README ]\n' >|a/test.sh
printf '#!/bin/sh\n# Checks package b.\nset -e\n[ -f b/README ]\n' >|b/test.sh
printf '#!/bin/sh\n# The verify command: every package check.\nset -e\nsh a/test.sh\nsh b/test.sh\n' >|check.sh
git init -q -b main
git add -A
git commit -q -m 'two packages and their checks'
