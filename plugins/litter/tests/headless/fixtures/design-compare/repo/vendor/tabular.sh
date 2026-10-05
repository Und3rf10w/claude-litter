# tabular 2.1: column helpers for plain-text reports, vendored as upstream ships them.

# col_left WIDTH TEXT: TEXT left-aligned in a WIDTH-column field.
col_left() {
  printf "%-$1s" "$2"
}

# col_money WIDTH CENTS: CENTS in dollars with two decimals, the dollar sign
# first, right-aligned in a WIDTH-column field.
col_money() {
  printf "%$1s" "\$$(($2 / 100)).$(printf '%02d' $(($2 % 100)))"
}
