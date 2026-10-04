# price_fmt CENTS: a whole number of cents as an amount with two decimals,
# so price_fmt 1234 prints 12.34 and price_fmt 5 prints 0.05.
price_fmt() {
  printf '%d.%02d\n' $(($1 / 100)) $(($1 % 100))
}
