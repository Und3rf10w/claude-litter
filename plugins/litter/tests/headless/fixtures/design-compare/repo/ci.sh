#!/bin/sh
# CI's test step: the tests under each shell tally supports, dash and BusyBox sh.
cd "$(dirname "$0")" || exit 1
dash test.sh && busybox sh test.sh
