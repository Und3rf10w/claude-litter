#!/bin/sh
# The case's scratch repository, made in the run's working directory: two
# packages, each with a check, and a verify command (sh check.sh) that passes
# today. One commit on main, and a clean tree, which run.start needs.
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
