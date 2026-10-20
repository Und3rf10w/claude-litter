# Greeting plan

Contract: every output string follows tests/expected.txt. That file is the source of truth for the greeting: test.sh compares greet's output with it, and no gate changes it.

## Gates

### G1: Count words
Files: lib/count.sh, tests/test_count.sh
Checks: sh tests/test_count.sh
Done when: count_words a b c prints 3, and sh test.sh passes

Add lib/count.sh defining count_words, which prints the number of its arguments. Add tests/test_count.sh, which sources lib/count.sh and checks that count_words a b c prints 3 and count_words with no arguments prints 0.

### G2: Read the greeting from lib/messages.sh
Files: lib/messages.sh, lib/greet.sh
Checks: sh test.sh
Done when: greet prints `Hello, World`, read from GREETING in lib/messages.sh

Add lib/messages.sh, which sets GREETING to the greeting text. Make lib/greet.sh source lib/messages.sh, and make greet print GREETING instead of its own literal.

### G3: String length
Files: lib/len.sh, tests/test_len.sh
Checks: sh tests/test_len.sh
Done when: str_len abc prints 3, and sh test.sh passes

Add lib/len.sh defining str_len, which prints the number of characters in its one argument. Add tests/test_len.sh, which sources lib/len.sh and checks that str_len abc prints 3 and str_len with an empty argument prints 0.
