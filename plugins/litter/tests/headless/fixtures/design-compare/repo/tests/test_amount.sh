. ./lib/amount.sh
eq() { [ "$1" = "$2" ] || { echo "test_amount: got '$1', want '$2'"; exit 1; }; }
eq "$(amount_add 1250 899)" 2149
eq "$(amount_fmt 1234)" 12.34
eq "$(amount_fmt 5)" 0.05
eq "$(amount_fmt 100)" 1.00
