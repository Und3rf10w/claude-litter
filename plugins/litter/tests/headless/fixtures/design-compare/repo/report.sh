#!/bin/sh
# sh report.sh FILE: the expense report for FILE's "<item> <cents>" lines.
here=$(dirname "$0")
. "$here/vendor/tabular.sh"
. "$here/lib/amount.sh"
. "$here/lib/report.sh"
report <"${1:?usage: sh report.sh FILE}"
