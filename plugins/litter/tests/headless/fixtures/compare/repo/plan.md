# Prices, slugs and key-value lines

Five gates on a small sh project. lib/ holds price.sh (price_fmt), report.sh (a price report built on price_fmt), slug.sh (slug) and parse.sh (parse_kv); vendor/ holds a vendored strutil.sh. sh test.sh runs every tests/*.sh from the top of the repository, and each test sources the files it needs from there. Each gate adds its own test.

## Gates

### G1: Slugs with a length limit
Files: lib/slug.sh, tests/test_slug_max.sh
Checks: sh tests/test_slug_max.sh
Done when: slug_max 5 'Hello World' prints hello, slug_max 7 'Hello World' prints hello-w, slug_max 6 'Hello World' prints hello, and sh test.sh passes

Add slug_max to lib/slug.sh: slug_max N TEXT prints TEXT's slug cut to at most N characters, with any '-' the cut leaves at its end dropped. Add tests/test_slug_max.sh, which sources lib/slug.sh and checks the three cases in Done when.

### G2: A currency prefix on prices
Files: lib/price.sh, tests/test_price.sh
Checks: sh tests/test_price.sh
Done when: price_fmt 1234 prints $12.34, price_fmt 5 prints $0.05, price_fmt 0 prints $0.00, and sh test.sh passes

price_fmt prints a dollar sign before the amount: price_fmt 1234 prints $12.34. Update tests/test_price.sh to match, and add the zero case.

Contract, for this gate and every later one: price_fmt always prints exactly two decimals.

### G3: Trimmed values
Files: lib/parse.sh, tests/test_parse_trim.sh
Checks: sh tests/test_parse_trim.sh
Done when: parse_kv 'name =  Ada ' prints name=Ada, parse_kv with a tab on each side of Ada prints name=Ada, and sh test.sh passes

parse_kv trims the blanks, spaces and tabs alike, around the value as it does around the key. Add tests/test_parse_trim.sh, which sources lib/parse.sh and checks both cases in Done when.

### G4: ASCII-only slugs
Files: lib/slug.sh, tests/test_slug_ascii.sh
Checks: sh tests/test_slug_ascii.sh
Done when: slug 'Crème brûlée' prints crme-brle, slug 'naïve' prints nave, and sh test.sh passes

slug drops every non-ASCII character instead of turning it into a separator. Add tests/test_slug_ascii.sh, which sources lib/slug.sh and checks both cases in Done when.

### G5: Compact zero prices
Files: lib/price.sh, tests/test_price_zero.sh
Checks: sh tests/test_price_zero.sh
Done when: price_fmt 0 prints $0, and sh test.sh passes

A free item's price is shown compactly: price_fmt 0 prints $0. Add tests/test_price_zero.sh, which sources lib/price.sh and checks it.
