# A price report. Needs lib/price.sh sourced first.

# report_sum: the sum of the amounts on stdin, one per line as price_fmt
# prints them, with two decimals.
report_sum() {
  awk '{ s += $1 } END { printf "%.2f\n", s }'
}

# report: reads "<item> <cents>" lines on stdin and prints each as
# "<item> <price>", then a last line "total <sum>".
report() {
  amounts=
  while read -r item cents; do
    p=$(price_fmt "$cents")
    printf '%s %s\n' "$item" "$p"
    amounts="$amounts$p
"
  done
  printf 'total %s\n' "$(printf '%s' "$amounts" | report_sum)"
}
