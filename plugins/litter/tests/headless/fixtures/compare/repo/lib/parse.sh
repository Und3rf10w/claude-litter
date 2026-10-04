# Key-value lines. Uses vendor/strutil.sh's trim.
. ./vendor/strutil.sh

# parse_kv LINE: LINE split at its first '=', printed as key=value. The key
# is trimmed; the value is kept as written.
parse_kv() {
  k=$(trim "${1%%=*}")
  v=${1#*=}
  printf '%s=%s\n' "$k" "$v"
}
