. ./lib/price.sh
eq() { [ "$1" = "$2" ] || { echo "test_price: got '$1', want '$2'"; exit 1; }; }
eq "$(price_fmt 1234)" 12.34
eq "$(price_fmt 5)" 0.05
eq "$(price_fmt 100)" 1.00
