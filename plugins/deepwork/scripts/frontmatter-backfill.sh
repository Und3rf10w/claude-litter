#!/usr/bin/env bash
# frontmatter-backfill.sh — config-driven YAML frontmatter backfill for
# markdown artifacts in any directory tree.
#
# Idempotent (skips files already starting with `---`), atomic (.tmp + mv),
# reversible (writes .bak siblings on --apply), dry-run by default.
#
# Usage:
#   frontmatter-backfill.sh --config <path> [--apply|--dry-run]
#                           [--root <dir>]
#                           [--instance-filter <basename>]
#                           [--no-git-check]
#
# Flags:
#   --config <path>         JSON config file (required). See CONFIG FORMAT below.
#   --apply                 Write files. Without this, runs dry-run.
#   --dry-run               Default. Print plan, write nothing.
#   --root <dir>            Tree to walk. Defaults to config.default_root or $PWD.
#   --instance-filter <id>  Limit to files whose instance dir == <id>.
#   --no-git-check          Skip the uncommitted-changes guard.
#
# CONFIG FORMAT (JSON):
#   {
#     "default_root": ".claude/deepwork",        // optional; fallback when --root omitted
#     "instance_depth": 1,                        // path levels under root to derive instance (default 1)
#     "tool_name": "frontmatter-backfill",        // stamped into {{tool_name}} placeholder
#     "carve_outs": [                             // bash-glob basenames to skip
#       "log.md", "prompt.md", "adversarial-tests.md", "adversarial-tests-*.md"
#     ],
#     "carve_out_rel_paths": [                    // optional: relative-path globs (matched against path below root)
#       "*/v2-final.md"                           // e.g. instance-root v2-final.md NOT proposals/v2-final.md
#     ],
#     "classifiers": [                            // first match wins; checked in order
#       {
#         "match_glob": "critique.v*.md",         // bash glob against basename
#         "match_rel_glob": null,                 // optional: glob against relative-path instead
#         "artifact_type": "critique",
#         "extras": [                             // per-match field extraction
#           {
#             "field": "version",                 // field name written to stanza
#             "regex": "^critique\\.(v[0-9]+(-final)?)\\.md$",  // ERE with capture group
#             "group": 1,                         // which BASH_REMATCH slot to use
#             "quote": true                       // true → wrap value in double quotes
#           }
#         ]
#       }
#     ],
#     "template": "---\nartifact_type: {{artifact_type}}\nauthor: unknown\ninstance: {{instance}}\ntask_id: unknown\n{{extras}}\nsources: []\nbackfilled_by: {{tool_name}}\n---\n\n"
#   }
#
# Template placeholders:
#   {{artifact_type}}  — classifier-provided type
#   {{instance}}       — first N path levels under root (N = instance_depth)
#   {{tool_name}}      — from config.tool_name
#   {{extras}}         — expanded to per-field lines; if empty, the line is dropped
#
# Exit codes: 0 success · 1 config/usage error · 2 any file write failure.

set -u
set -o pipefail

SCRIPT_NAME="$(basename "$0")"
CONFIG=""
MODE="dry-run"
ROOT=""
INSTANCE_FILTER=""
GIT_CHECK=1

# ── argparse ──────────────────────────────────────────────────────────────────
while (( $# > 0 )); do
  case "$1" in
    --config)             CONFIG="$2"; shift 2 ;;
    --apply)              MODE="apply"; shift ;;
    --dry-run)            MODE="dry-run"; shift ;;
    --root)               ROOT="$2"; shift 2 ;;
    --instance-filter)    INSTANCE_FILTER="$2"; shift 2 ;;
    --no-git-check)       GIT_CHECK=0; shift ;;
    -h|--help)
      sed -n '1,52p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      printf '%s: unknown arg: %s\n' "$SCRIPT_NAME" "$1" >&2
      exit 1
      ;;
  esac
done

[[ -n "$CONFIG" ]] || { printf '%s: --config is required\n' "$SCRIPT_NAME" >&2; exit 1; }
[[ -f "$CONFIG" ]] || { printf '%s: config not found: %s\n' "$SCRIPT_NAME" "$CONFIG" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { printf '%s: jq is required\n' "$SCRIPT_NAME" >&2; exit 1; }

# Validate JSON + extract fields.
jq empty "$CONFIG" 2>/dev/null || { printf '%s: config is not valid JSON: %s\n' "$SCRIPT_NAME" "$CONFIG" >&2; exit 1; }

DEFAULT_ROOT=$(jq -r '.default_root // ""' "$CONFIG")
INSTANCE_DEPTH=$(jq -r '.instance_depth // 1' "$CONFIG")
TOOL_NAME=$(jq -r '.tool_name // "frontmatter-backfill"' "$CONFIG")
# Command substitution strips trailing newlines; append a sentinel + strip it
# back off so the template's trailing blank line survives.
_TEMPLATE_WITH_SENTINEL=$(jq -r '(.template // "") + "___EOT___"' "$CONFIG")
TEMPLATE="${_TEMPLATE_WITH_SENTINEL%___EOT___}"
[[ -n "$TEMPLATE" ]] || { printf '%s: config.template is empty\n' "$SCRIPT_NAME" >&2; exit 1; }

# Arrays from jq.
CARVE_OUTS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && CARVE_OUTS+=("$line")
done < <(jq -r '.carve_outs[]? // empty' "$CONFIG")

CARVE_OUT_RELS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && CARVE_OUT_RELS+=("$line")
done < <(jq -r '.carve_out_rel_paths[]? // empty' "$CONFIG")

# ── root resolution ──────────────────────────────────────────────────────────
if [[ -z "$ROOT" ]]; then
  if [[ -n "$DEFAULT_ROOT" ]]; then
    if REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
      ROOT="$REPO_ROOT/$DEFAULT_ROOT"
    else
      ROOT="$PWD/$DEFAULT_ROOT"
    fi
  else
    ROOT="$PWD"
  fi
fi

[[ -d "$ROOT" ]] || { printf '%s: root not found: %s\n' "$SCRIPT_NAME" "$ROOT" >&2; exit 1; }

# ── git cleanliness gate ──────────────────────────────────────────────────────
if (( GIT_CHECK )) && command -v git >/dev/null 2>&1; then
  if git rev-parse --show-toplevel >/dev/null 2>&1; then
    DIRTY=$(git status --porcelain -- "$ROOT" 2>/dev/null || true)
    if [[ -n "$DIRTY" ]]; then
      printf '%s: %s has uncommitted changes. Commit/stash first or pass --no-git-check.\n' "$SCRIPT_NAME" "$ROOT" >&2
      printf '%s\n' "$DIRTY" >&2
      exit 1
    fi
  fi
fi

printf '%s — mode=%s root=%s config=%s\n' "$SCRIPT_NAME" "$MODE" "$ROOT" "$CONFIG"
[[ -n "$INSTANCE_FILTER" ]] && printf '  instance filter: %s\n' "$INSTANCE_FILTER"
printf '\n'

# ── classifier lookup ─────────────────────────────────────────────────────────
# For a given basename + rel-path, iterate config.classifiers in order and emit
# the first-matching entry as JSON on stdout. Returns 1 if no classifier matches.
find_classifier() {
  local base="$1" rel="$2"
  local n i match_glob match_rel_glob
  n=$(jq '.classifiers | length' "$CONFIG")
  for (( i=0; i<n; i++ )); do
    match_glob=$(jq -r ".classifiers[$i].match_glob // empty" "$CONFIG")
    match_rel_glob=$(jq -r ".classifiers[$i].match_rel_glob // empty" "$CONFIG")
    if [[ -n "$match_rel_glob" ]]; then
      # shellcheck disable=SC2053
      [[ "$rel" == $match_rel_glob ]] || continue
    elif [[ -n "$match_glob" ]]; then
      # shellcheck disable=SC2053
      [[ "$base" == $match_glob ]] || continue
    else
      continue
    fi
    jq ".classifiers[$i]" "$CONFIG"
    return 0
  done
  return 1
}

# Given classifier JSON on stdin + basename, extract extras and emit
# "<field>: <value>" lines on stdout.
extract_extras() {
  local classifier_json="$1" base="$2"
  local n i field regex group quote val
  n=$(printf '%s' "$classifier_json" | jq '.extras | length // 0')
  for (( i=0; i<n; i++ )); do
    field=$(printf '%s' "$classifier_json" | jq -r ".extras[$i].field")
    regex=$(printf '%s' "$classifier_json" | jq -r ".extras[$i].regex")
    group=$(printf '%s' "$classifier_json" | jq -r ".extras[$i].group // 1")
    quote=$(printf '%s' "$classifier_json" | jq -r ".extras[$i].quote // false")
    if [[ "$base" =~ $regex ]]; then
      val="${BASH_REMATCH[$group]}"
      if [[ "$quote" == "true" ]]; then
        printf '%s: "%s"\n' "$field" "$val"
      else
        printf '%s: %s\n' "$field" "$val"
      fi
    fi
  done
}

# Derive instance id from a rel-path by taking the first INSTANCE_DEPTH segments.
derive_instance() {
  local rel="$1"
  awk -v depth="$INSTANCE_DEPTH" -F'/' '{
    out = $1
    for (i=2; i<=depth; i++) out = out "/" $i
    print out
  }' <<< "$rel"
}

# Render template by substituting placeholders. {{extras}} is replaced by a
# block of extras lines (with trailing newline trimmed). If the extras block is
# empty, the entire line containing {{extras}} is removed so no blank stub
# line appears in the stanza.
render_stanza() {
  local at="$1" inst="$2" extras_block="$3" tool="$4"
  local out="$TEMPLATE"

  # Literal substitution via bash parameter expansion — preserves newlines.
  out="${out//\{\{artifact_type\}\}/$at}"
  out="${out//\{\{instance\}\}/$inst}"
  out="${out//\{\{tool_name\}\}/$tool}"

  if [[ -n "$extras_block" ]]; then
    # Strip exactly one trailing newline so the extras block plugs in cleanly.
    extras_block="${extras_block%$'\n'}"
    out="${out//\{\{extras\}\}/$extras_block}"
  else
    # Drop the entire line containing {{extras}} — sed is simplest. Wrap in a
    # sentinel so command substitution doesn't strip template trailing newlines.
    local sed_out; sed_out=$(printf '%s___EOT___' "$out" | sed '/{{extras}}/d')
    out="${sed_out%___EOT___}"
  fi

  printf '%s' "$out"
}

# ── main walk ─────────────────────────────────────────────────────────────────
RC=0
n_apply=0; n_skip_fm=0; n_skip_carve=0; n_skip_unknown=0; n_fail=0

while IFS= read -r -d '' file; do
  rel="${file#"$ROOT"/}"
  base=$(basename -- "$file")
  instance=$(derive_instance "$rel")

  # Optional instance filter.
  if [[ -n "$INSTANCE_FILTER" ]]; then
    [[ "$instance" == "$INSTANCE_FILTER" ]] || continue
  fi

  # Skip files already carrying frontmatter.
  first_line=$(head -1 -- "$file" 2>/dev/null || true)
  if [[ "$first_line" == "---" ]]; then
    printf '  [skip-already-has-frontmatter] %s\n' "$rel"
    n_skip_fm=$(( n_skip_fm + 1 ))
    continue
  fi

  # Carve-outs by basename (bash glob).
  _carved=0
  for g in "${CARVE_OUTS[@]}"; do
    # shellcheck disable=SC2053
    if [[ "$base" == $g ]]; then _carved=1; break; fi
  done
  if (( _carved == 0 )); then
    for g in "${CARVE_OUT_RELS[@]}"; do
      # shellcheck disable=SC2053
      if [[ "$rel" == $g ]]; then _carved=1; break; fi
    done
  fi
  if (( _carved )); then
    printf '  [skip-carve-out] %s\n' "$rel"
    n_skip_carve=$(( n_skip_carve + 1 ))
    continue
  fi

  # Classify.
  classifier_json=$(find_classifier "$base" "$rel") || {
    printf '  [skip-unknown-pattern] %s\n' "$rel"
    n_skip_unknown=$(( n_skip_unknown + 1 ))
    continue
  }

  artifact_type=$(printf '%s' "$classifier_json" | jq -r '.artifact_type')
  extras_block=$(extract_extras "$classifier_json" "$base")

  printf '  [will-prepend-%s] %s\n' "$artifact_type" "$rel"

  if [[ "$MODE" == "apply" ]]; then
    tmpfile="$file.fbtmp.$$"
    bakfile="$file.bak"

    {
      render_stanza "$artifact_type" "$instance" "$extras_block" "$TOOL_NAME"
      cat -- "$file"
    } > "$tmpfile" || { n_fail=$(( n_fail + 1 )); RC=2; continue; }

    cp -- "$file" "$bakfile" || { rm -f -- "$tmpfile"; n_fail=$(( n_fail + 1 )); RC=2; continue; }
    mv -- "$tmpfile" "$file"  || { n_fail=$(( n_fail + 1 )); RC=2; continue; }
    n_apply=$(( n_apply + 1 ))
  fi
done < <(find "$ROOT" -type f -name '*.md' -print0 2>/dev/null)

printf '\n── summary ─────────────────────────────────────────────────\n'
printf 'mode: %s\n' "$MODE"
if [[ "$MODE" == "apply" ]]; then
  printf 'prepended: %d\n' "$n_apply"
else
  printf 'would prepend: (see [will-prepend-*] rows above)\n'
fi
printf 'skipped (already has frontmatter): %d\n' "$n_skip_fm"
printf 'skipped (carve-out): %d\n' "$n_skip_carve"
printf 'skipped (unknown pattern): %d\n' "$n_skip_unknown"
printf 'failures: %d\n' "$n_fail"

if [[ "$MODE" == "dry-run" ]]; then
  printf '\n(dry-run — no files written. Re-run with --apply to commit.)\n'
fi

exit "$RC"
