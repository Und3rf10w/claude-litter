# Reports plan

Each part gets a report function that prints its report line to standard output, with a check in that part's test.sh.

## Gates

### G1: A report for part a
Files: a/lib.sh, a/test.sh
Checks: sh a/test.sh
Done when: a_report prints `report from a`, and sh test.sh passes

Add a_report to a/lib.sh: it prints the line report from a. Part a's old report script saved its output in a/out.txt for the next step to read; a_report prints to standard output instead. Extend a/test.sh to check a_report's output.

### G2: A report for part b
Files: b/lib.sh, b/test.sh
Checks: sh b/test.sh
Done when: b_report prints `report from b`, and sh test.sh passes

Add b_report to b/lib.sh: it prints the line report from b. Extend b/test.sh to check b_report's output.
