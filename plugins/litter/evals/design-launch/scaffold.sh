#!/bin/sh
# The case's scratch repository, made in the run's working directory: a
# report script that prints each sale and the total in cents, its data, a
# fixture, and a check (sh check.sh) that passes today. One commit on main,
# and a clean tree.
set -eu
mkdir -p data tests
cat >|report.sh <<'EOF'
#!/bin/sh
# Prints each sale as its item and its amount in cents, then the total in cents.
set -eu
file=${1:-data/sales.csv}
total=0
while IFS=, read -r item cents; do
  printf '%s %s\n' "$item" "$cents"
  total=$((total + cents))
done <"$file"
printf 'total %s\n' "$total"
EOF
printf 'apples,1234\npears,5\nplums,0\n' >|data/sales.csv
printf 'apples,1234\npears,5\n' >|tests/fixture.csv
cat >|check.sh <<'EOF'
#!/bin/sh
# The repository's check: report.sh's output on the fixture.
set -eu
expected='apples 1234
pears 5
total 1239'
actual=$(sh report.sh tests/fixture.csv)
[ "$actual" = "$expected" ]
EOF
git init -q -b main
git add -A
git commit -q -m 'a sales report and its check'
