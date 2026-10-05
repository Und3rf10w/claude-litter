# The expense report. Needs vendor/tabular.sh and lib/amount.sh sourced first.

# report: reads "<item> <cents>" lines on stdin and prints each as the item in
# a 20-column field and its amount in a 12-column one, then a "total" line.
report() {
  total=0
  while read -r item cents; do
    [ -n "$item" ] || continue
    printf '%s%s\n' "$(col_left 20 "$item")" "$(col_money 12 "$cents")"
    total=$(amount_add "$total" "$cents")
  done
  printf '%s%s\n' "$(col_left 20 total)" "$(col_money 12 "$total")"
}
