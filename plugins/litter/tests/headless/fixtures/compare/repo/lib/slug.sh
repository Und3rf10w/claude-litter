# slug TEXT: TEXT lowercased, each run of characters other than a-z and 0-9
# turned into one '-', with no '-' at either end: slug 'Hello World' prints
# hello-world.
slug() {
  printf '%s' "$1" | LC_ALL=C tr 'A-Z' 'a-z' | LC_ALL=C tr -cs 'a-z0-9' '-' | sed -e 's/^-*//' -e 's/-*$//'
}
