. ./lib/parse.sh
eq() { [ "$1" = "$2" ] || { echo "test_parse: got '$1', want '$2'"; exit 1; }; }
eq "$(parse_kv ' name=Ada')" name=Ada
eq "$(parse_kv 'a=b=c')" a=b=c
eq "$(parse_kv 'k=')" k=
