# strutil 1.4: small string helpers, vendored as upstream ships them.

# trim TEXT: TEXT without its leading and trailing blanks.
trim() {
  printf '%s\n' "$1" | sed -e 's/^ *//' -e 's/ *$//'
}

# upper TEXT: TEXT with a-z made A-Z.
upper() {
  printf '%s\n' "$1" | LC_ALL=C tr 'a-z' 'A-Z'
}
