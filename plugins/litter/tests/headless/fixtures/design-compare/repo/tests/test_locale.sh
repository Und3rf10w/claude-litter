. ./lib/locale.sh
eq() { [ "$1" = "$2" ] || { echo "test_locale: got '$1', want '$2'"; exit 1; }; }
eq "$(cur_sym USD)" '$'
eq "$(cur_sym GBP)" '£'
eq "$(cur_sym XXX)" ''
eq "$(date_order US)" mdy
eq "$(date_order FR)" dmy
