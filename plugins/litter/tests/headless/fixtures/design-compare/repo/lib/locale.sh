# Locale tables shared by tally's front ends.

# cur_sym CODE: the sign written with an amount in the ISO 4217 code CODE
# (USD, EUR, GBP or JPY); nothing for a code it doesn't know.
cur_sym() {
  case $1 in
    USD) printf '%s\n' '$' ;;
    EUR) printf '%s\n' '€' ;;
    GBP) printf '%s\n' '£' ;;
    JPY) printf '%s\n' '¥' ;;
  esac
}

# date_order COUNTRY: the order a date's parts are written in there: ymd, dmy or mdy.
date_order() {
  case $1 in
    US) echo mdy ;;
    GB | FR | DE | ES | IT) echo dmy ;;
    *) echo ymd ;;
  esac
}
