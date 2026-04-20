# shellcheck shell=bash
# send-text.sh — sourceable library for cross-terminal text injection.
#
# Compatible with bash 3.2 (macOS default). Avoids associative arrays.
#
# Used by swarm-loop's supervisor to inject `/clear\r` and next-iteration prompts
# into the host claude's interactive REPL without restarting the process.
#
# Public API:
#   detect_pane_handle                 -> prints "kind:handle" to stdout
#   send_text_to_pane <handle> <text>  -> injects <text> into the pane named by handle
#
# Exit codes:
#   0  success
#   2  terminal kind is unsupported (graceful degrade path)
#   3  terminal kind is supported but IPC call failed
#   64 usage error

# Emit the handle for the terminal this process is running inside.
# Format: "kind\tfield1=value1\tfield2=value2..." — fields are tab-separated so
# values may contain ':' safely (KITTY_LISTEN_ON is "unix:/tmp/..."). Values are
# NOT shell-escaped; they're stored raw. Prints "none" if no supported primitive
# is available.
#
# Precedence: multiplexers before host terminals, because multiplexers own the
# pane claude actually runs in.
detect_pane_handle() {
  if [[ -n "${TMUX:-}" && -n "${TMUX_PANE:-}" ]]; then
    printf 'tmux\tpane=%s\n' "$TMUX_PANE"
  elif [[ -n "${STY:-}" ]]; then
    printf 'screen\tsty=%s\twindow=%s\n' "$STY" "${WINDOW:-0}"
  elif [[ -n "${ZELLIJ:-}" ]]; then
    printf 'zellij\n'
  elif [[ -n "${KITTY_LISTEN_ON:-}" && -n "${KITTY_WINDOW_ID:-}" ]]; then
    printf 'kitty\tlisten=%s\twindow=%s\n' "$KITTY_LISTEN_ON" "$KITTY_WINDOW_ID"
  elif [[ -n "${WEZTERM_UNIX_SOCKET:-}" && -n "${WEZTERM_PANE:-}" ]]; then
    printf 'wezterm\tpane=%s\n' "$WEZTERM_PANE"
  elif [[ "${TERM_PROGRAM:-}" == "iTerm.app" ]]; then
    local sid
    sid=$(osascript -e 'tell application "iTerm2" to id of current session of current window' 2>/dev/null)
    if [[ -n "$sid" ]]; then
      printf 'iterm2\tsession=%s\n' "$sid"
    else
      printf 'none\n'
    fi
  elif [[ "${TERM_PROGRAM:-}" == "Apple_Terminal" ]]; then
    printf 'terminal_app\n'
  else
    printf 'none\n'
  fi
}

# Extract a named field from a handle.
# Usage: value=$(__handle_field "<handle>" <fieldname>)
# Prints empty string if the field isn't present.
__handle_field() {
  local handle=$1 field=$2
  local rest=$handle pair
  # Skip past the kind prefix (everything up to the first tab).
  if [[ "$rest" == *$'\t'* ]]; then
    rest=${rest#*$'\t'}
  else
    return 0
  fi
  while [[ -n "$rest" ]]; do
    if [[ "$rest" == *$'\t'* ]]; then
      pair=${rest%%$'\t'*}
      rest=${rest#*$'\t'}
    else
      pair=$rest
      rest=""
    fi
    if [[ "${pair%%=*}" == "$field" ]]; then
      printf '%s' "${pair#*=}"
      return 0
    fi
  done
}

# Extract the kind prefix from a handle.
__handle_kind() {
  local handle=$1
  if [[ "$handle" == *$'\t'* ]]; then
    printf '%s' "${handle%%$'\t'*}"
  else
    printf '%s' "$handle"
  fi
}

# send_text_to_pane <handle> <text>
# Injects <text> verbatim into the pane named by <handle>.
# Caller provides any trailing CR/LF bytes inside <text>.
send_text_to_pane() {
  [[ $# -eq 2 ]] || { echo "send_text_to_pane: usage: send_text_to_pane HANDLE TEXT" >&2; return 64; }
  local handle=$1 text=$2

  if [[ "$handle" == "none" ]]; then
    echo "send_text_to_pane: no pane injection primitive available for this terminal" >&2
    return 2
  fi

  local kind
  kind=$(__handle_kind "$handle")

  case "$kind" in
    tmux)
      local pane
      pane=$(__handle_field "$handle" pane)
      [[ -z "$pane" ]] && { echo "send_text_to_pane: tmux handle missing pane" >&2; return 3; }
      tmux send-keys -t "$pane" -l "$text" || return 3
      ;;

    screen)
      local sty window
      sty=$(__handle_field "$handle" sty)
      window=$(__handle_field "$handle" window)
      [[ -z "$window" ]] && window=0
      [[ -z "$sty" ]] && { echo "send_text_to_pane: screen handle missing sty" >&2; return 3; }
      screen -S "$sty" -p "$window" -X stuff -- "$text" || return 3
      ;;

    zellij)
      # zellij's write-chars expects printable characters; use `write <byte>` for
      # CR/LF. Split the input at CR/LF boundaries so we emit the right calls.
      # Strategy: for each character, if it's \r write 13, if \n write 10, else
      # accumulate into a run of write-chars.
      local i ch run=""
      local -i len=${#text}
      for (( i=0; i<len; i++ )); do
        ch=${text:i:1}
        case "$ch" in
          $'\r')
            if [[ -n "$run" ]]; then zellij action write-chars -- "$run" || return 3; run=""; fi
            zellij action write 13 || return 3
            ;;
          $'\n')
            if [[ -n "$run" ]]; then zellij action write-chars -- "$run" || return 3; run=""; fi
            zellij action write 10 || return 3
            ;;
          *)
            run+="$ch"
            ;;
        esac
      done
      if [[ -n "$run" ]]; then zellij action write-chars -- "$run" || return 3; fi
      ;;

    kitty)
      local listen window
      listen=$(__handle_field "$handle" listen)
      window=$(__handle_field "$handle" window)
      [[ -z "$listen" || -z "$window" ]] && { echo "send_text_to_pane: kitty handle incomplete" >&2; return 3; }
      # --stdin: raw bytes, no Python-escape interpretation.
      # Bracketed-paste defaults to disable; do NOT pass --bracketed-paste=enable.
      printf '%s' "$text" | kitty @ --to "$listen" send-text --match "id:$window" --stdin || return 3
      ;;

    wezterm)
      local pane
      pane=$(__handle_field "$handle" pane)
      [[ -z "$pane" ]] && { echo "send_text_to_pane: wezterm handle missing pane" >&2; return 3; }
      # --no-paste disables bracketed paste (same rationale as kitty above).
      printf '%s' "$text" | wezterm cli send-text --pane-id "$pane" --no-paste || return 3
      ;;

    iterm2)
      # AppleScript `write text` appends a newline automatically. We must strip
      # one trailing CR/LF if present, else the session receives TWO Enters.
      local payload=$text
      payload=${payload%$'\r'}
      payload=${payload%$'\n'}
      local sid
      sid=$(__handle_field "$handle" session)
      [[ -z "$sid" ]] && { echo "send_text_to_pane: iterm2 handle missing session id" >&2; return 3; }
      # Escape embedded double quotes and backslashes for AppleScript string literal.
      local escaped=${payload//\\/\\\\}
      escaped=${escaped//\"/\\\"}
      osascript <<APPLESCRIPT || return 3
tell application "iTerm2"
  tell session id "$sid"
    write text "$escaped"
  end tell
end tell
APPLESCRIPT
      ;;

    terminal_app)
      # Terminal.app's `do script` runs in front window; same trailing-newline
      # caveat as iTerm2.
      local payload=$text
      payload=${payload%$'\r'}
      payload=${payload%$'\n'}
      local escaped=${payload//\\/\\\\}
      escaped=${escaped//\"/\\\"}
      osascript -e 'tell application "Terminal" to do script "'"$escaped"'" in front window' >/dev/null || return 3
      ;;

    *)
      echo "send_text_to_pane: unknown handle kind: $kind" >&2
      return 2
      ;;
  esac

  return 0
}
