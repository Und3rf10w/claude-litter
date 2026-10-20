. ./vendor/tabular.sh
. ./lib/amount.sh
. ./lib/report.sh
eq() { [ "$1" = "$2" ] || { echo "test_report: got '$1', want '$2'"; exit 1; }; }
out=$(printf 'taxi 1250\nlunch 899\n' | report)
eq "$(printf '%s\n' "$out" | sed -n 1p)" "$(printf '%-20s%12s' taxi '$12.50')"
eq "$(printf '%s\n' "$out" | sed -n 2p)" "$(printf '%-20s%12s' lunch '$8.99')"
eq "$(printf '%s\n' "$out" | sed -n 3p)" "$(printf '%-20s%12s' total '$21.49')"
eq "$(printf '%s\n' "$out" | wc -l | tr -d ' ')" 3
