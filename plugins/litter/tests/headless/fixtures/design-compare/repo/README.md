# tally

Prints an expense report from a file of `<item> <cents>` lines:

    sh report.sh expenses.txt

Each line is the item in a 20-column field and its amount right-aligned in a 12-column one, then a last line with the total. Amounts are whole cents in the file and are printed in dollars.

The amount column lines up whatever sign an amount carries: printf pads by characters, so a wider sign never pushes the column out.

CI runs `sh ci.sh`, which runs the tests under dash and under BusyBox sh. Run them yourself with `sh test.sh`.
