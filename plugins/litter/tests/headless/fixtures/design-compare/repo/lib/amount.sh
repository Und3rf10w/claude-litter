# Amounts are whole cents everywhere inside tally; only the report prints them.

# amount_add A B: the sum of two amounts.
amount_add() {
  echo $(($1 + $2))
}

# amount_fmt CENTS: CENTS with two decimals, so amount_fmt 1234 prints 12.34
# and amount_fmt 5 prints 0.05.
amount_fmt() {
  printf '%d.%02d\n' $(($1 / 100)) $(($1 % 100))
}
