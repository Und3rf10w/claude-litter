# Math plan

Two gates, each adding one function to lib/math.sh with its own test. sh test.sh runs every tests/test_*.sh.

## Gates

### G1: Multiply
Files: lib/math.sh, tests/test_mul.sh
Checks: sh tests/test_mul.sh
Done when: mul 3 4 prints 12, and sh test.sh passes

Add mul to lib/math.sh: mul A B prints the product of the whole numbers A and B. Add tests/test_mul.sh, which sources lib/math.sh and checks that mul 3 4 prints 12 and mul 0 5 prints 0.

### G2: Square
Files: lib/math.sh, tests/test_sq.sh
Checks: sh tests/test_sq.sh
Done when: sq 5 prints 25, and sh test.sh passes

Add sq to lib/math.sh: sq N prints N times N, for a whole number N. Add tests/test_sq.sh, which sources lib/math.sh and checks that sq 5 prints 25 and sq 0 prints 0.
