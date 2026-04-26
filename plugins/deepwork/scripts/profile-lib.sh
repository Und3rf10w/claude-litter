#!/bin/bash
# profile-lib.sh — shared profile library for deepwork scripts
# Sourced by setup-deepwork.sh, session-context.sh, and profile reinject.sh.
# Do NOT add set -euo pipefail here; this file is sourced, not executed directly.

# load_profile <mode> <plugin_root>
# Sets globals: PROFILE_DIR (resolved path) and RESOLVED_MODE (resolved name).
# Falls back to "default" if the requested profile directory doesn't exist.
load_profile() {
  local mode="$1" plugin_root="$2"
  [[ -n "$mode" ]] || { echo "deepwork: load_profile: mode argument is required" >&2; return 1; }
  [[ -n "$plugin_root" ]] || { echo "deepwork: load_profile: plugin_root argument is required" >&2; return 1; }
  local dir="${plugin_root}/profiles/${mode}"
  if [[ ! -d "$dir" ]]; then
    echo "deepwork: profile '${mode}' not found, falling back to 'default'" >&2
    mode="default"; dir="${plugin_root}/profiles/default"
  fi
  PROFILE_DIR="$dir"
  RESOLVED_MODE="$mode"
}

# substitute_profile_template <template_string>
# Replaces {{PLACEHOLDER}} tokens in a template string with env var values.
# Uses perl for multiline-safe substitution.
#
# Callers must set these env vars BEFORE invoking (unset vars render as empty strings):
#   GOAL                  — user's goal text, sanitized
#   TEAM_NAME             — team identifier
#   INSTANCE_DIR          — absolute path to .claude/deepwork/<instance-id>/
#   PHASE                 — current phase (scope|explore|synthesize|critique|refine|deliver|done)
#   HARD_GUARDRAILS       — rendered multi-line list of guardrails (build via render_guardrails)
#   SOURCE_OF_TRUTH       — rendered multi-line list of source-of-truth paths
#   ANCHORS               — rendered multi-line list of file:line anchors
#   WRITTEN_BAR           — rendered multi-line list of bar criteria
#   ROLE_DEFINITIONS      — rendered multi-line list of role definitions
#   TEAM_ROSTER           — rendered multi-line list "<name> (<archetype>)"
#
# Execute-mode additional env vars (only meaningful when MODE=execute):
#   PLAN_REF              — absolute path to the approved plan document
#   PLAN_HASH             — sha256 of the plan file at setup time
#   TEST_MANIFEST_SUMMARY — derived from state.json (call render_test_manifest_summary)
#   CHANGE_LOG_SUMMARY    — derived from state.json (call render_change_log_summary)
#
# For teammate-spawn prompts (not orchestrator prompts), additionally:
#   ROLE_NAME, ARCHETYPE, ARCHETYPE_MANDATE, STANCE, RESPONSIBILITIES,
#   ARTIFACT_PATH, TASK_DESCRIPTION
substitute_profile_template() {
  local tmpl="$1"
  printf '%s' "$tmpl" | \
    GOAL="${GOAL:-}" TEAM_NAME="${TEAM_NAME:-}" INSTANCE_DIR="${INSTANCE_DIR:-}" \
    PHASE="${PHASE:-scope}" \
    HARD_GUARDRAILS="${HARD_GUARDRAILS:-(none)}" \
    SOURCE_OF_TRUTH="${SOURCE_OF_TRUTH:-(none specified)}" \
    ANCHORS="${ANCHORS:-(none specified)}" \
    WRITTEN_BAR="${WRITTEN_BAR:-(not yet populated — orchestrator must populate in SCOPE phase)}" \
    ROLE_DEFINITIONS="${ROLE_DEFINITIONS:-(not yet populated)}" \
    TEAM_ROSTER="${TEAM_ROSTER:-(not yet populated)}" \
    PLAN_REF="${PLAN_REF:-}" \
    PLAN_HASH="${PLAN_HASH:-}" \
    TEST_MANIFEST_SUMMARY="${TEST_MANIFEST_SUMMARY:-(not populated)}" \
    CHANGE_LOG_SUMMARY="${CHANGE_LOG_SUMMARY:-(not populated)}" \
    ROLE_NAME="${ROLE_NAME:-}" ARCHETYPE="${ARCHETYPE:-}" \
    ARCHETYPE_MANDATE="${ARCHETYPE_MANDATE:-}" STANCE="${STANCE:-}" \
    RESPONSIBILITIES="${RESPONSIBILITIES:-}" ARTIFACT_PATH="${ARTIFACT_PATH:-}" \
    TASK_DESCRIPTION="${TASK_DESCRIPTION:-}" \
    perl -0777 -pe '
      s/\{\{GOAL\}\}/$ENV{GOAL}/g;
      s/\{\{TEAM_NAME\}\}/$ENV{TEAM_NAME}/g;
      s/\{\{INSTANCE_DIR\}\}/$ENV{INSTANCE_DIR}/g;
      s/\{\{PHASE\}\}/$ENV{PHASE}/g;
      s/\{\{HARD_GUARDRAILS\}\}/$ENV{HARD_GUARDRAILS}/g;
      s/\{\{SOURCE_OF_TRUTH\}\}/$ENV{SOURCE_OF_TRUTH}/g;
      s/\{\{ANCHORS\}\}/$ENV{ANCHORS}/g;
      s/\{\{WRITTEN_BAR\}\}/$ENV{WRITTEN_BAR}/g;
      s/\{\{ROLE_DEFINITIONS\}\}/$ENV{ROLE_DEFINITIONS}/g;
      s/\{\{TEAM_ROSTER\}\}/$ENV{TEAM_ROSTER}/g;
      s/\{\{PLAN_REF\}\}/$ENV{PLAN_REF}/g;
      s/\{\{PLAN_HASH\}\}/$ENV{PLAN_HASH}/g;
      s/\{\{TEST_MANIFEST_SUMMARY\}\}/$ENV{TEST_MANIFEST_SUMMARY}/g;
      s/\{\{CHANGE_LOG_SUMMARY\}\}/$ENV{CHANGE_LOG_SUMMARY}/g;
      s/\{\{ROLE_NAME\}\}/$ENV{ROLE_NAME}/g;
      s/\{\{ARCHETYPE\}\}/$ENV{ARCHETYPE}/g;
      s/\{\{ARCHETYPE_MANDATE\}\}/$ENV{ARCHETYPE_MANDATE}/g;
      s/\{\{STANCE\}\}/$ENV{STANCE}/g;
      s/\{\{RESPONSIBILITIES\}\}/$ENV{RESPONSIBILITIES}/g;
      s/\{\{ARTIFACT_PATH\}\}/$ENV{ARTIFACT_PATH}/g;
      s/\{\{TASK_DESCRIPTION\}\}/$ENV{TASK_DESCRIPTION}/g;
    '
}

# render_test_manifest_summary <state.json path>
# Outputs a one-line summary like "3 entries" or "(empty)" for {{TEST_MANIFEST_SUMMARY}}.
render_test_manifest_summary() {
  local state_file="$1"
  [[ -f "$state_file" ]] || { printf '(not populated)'; return 0; }
  local count
  count=$(jq -r '(.execute.test_manifest // []) | length' "$state_file" 2>/dev/null || echo "0")
  if [[ "$count" == "0" ]]; then
    printf '(empty)'
  else
    printf '%s entries' "$count"
  fi
}

# render_change_log_summary <state.json path>
# Outputs a one-line summary like "2 entries (1 approved, 1 pending)" for {{CHANGE_LOG_SUMMARY}}.
render_change_log_summary() {
  local state_file="$1"
  [[ -f "$state_file" ]] || { printf '(not populated)'; return 0; }
  local summary
  summary=$(jq -r '
    (.execute.change_log // []) as $log |
    ($log | length) as $total |
    ($log | map(select(.critic_verdict == "APPROVED" and .merged_at != null)) | length) as $approved |
    if $total == 0 then "(empty)"
    else "\($total) entries (\($approved) approved and landed, \($total - $approved) pending)"
    end
  ' "$state_file" 2>/dev/null || echo "(not populated)")
  printf '%s' "$summary"
}

# render_guardrails <state.json path>
# Outputs a formatted list of guardrails for use in {{HARD_GUARDRAILS}}.
# Consolidates state.json.guardrails[] (user/flag-sourced) + incidents.jsonl
# (incident-sourced, append-only), deduped by incident_ref.
#
# Produces one line per guardrail:
#   - <rule>  [source: <source>, <timestamp>]
render_guardrails() {
  local state_file="$1"
  [[ -f "$state_file" ]] || { echo "(none)"; return 0; }
  local instance_dir incidents_file
  instance_dir="$(dirname "$state_file")"
  incidents_file="${instance_dir}/incidents.jsonl"

  local rendered
  if [[ -f "$incidents_file" ]]; then
    # Merge: state.guardrails[] ∪ incidents.jsonl (dedup by incident_ref)
    rendered=$(jq -srn \
      --slurpfile s "$state_file" \
      --rawfile inc "$incidents_file" \
      '
      ($s[0].guardrails // []) as $state_rules
      | ($inc | split("\n") | map(select(length > 0) | fromjson? // empty)) as $incident_rules
      | ($state_rules + $incident_rules) as $all
      # Dedup: prefer first occurrence per incident_ref; entries without a ref are kept
      | (reduce $all[] as $r ([];
          if ($r.incident_ref // "") == "" then . + [$r]
          elif any(.[]; (.incident_ref // "") == $r.incident_ref) then .
          else . + [$r]
          end
        )) as $deduped
      | if ($deduped | length) == 0 then
          "(none accumulated yet)"
        else
          $deduped | map("- \(.rule)  [source: \(.source // "unknown"), \(.timestamp // "unknown")]") | join("\n")
        end
      ' 2>/dev/null)
  else
    rendered=$(jq -r '
      if (.guardrails // []) | length == 0 then
        "(none accumulated yet)"
      else
        (.guardrails | map("- \(.rule)  [source: \(.source // "unknown"), \(.timestamp // "unknown")]") | join("\n"))
      end
    ' "$state_file" 2>/dev/null)
  fi
  [[ -z "$rendered" ]] && rendered="(none)"
  printf '%s' "$rendered"
}

# render_source_of_truth <state.json path>
render_source_of_truth() {
  local state_file="$1"
  [[ -f "$state_file" ]] || { echo "(none specified)"; return 0; }
  local rendered
  rendered=$(jq -r '
    if (.source_of_truth // []) | length == 0 then
      "(none specified — cite file:line from anchors or discovered facts)"
    else
      (.source_of_truth[] | "- \(.)")
    end
  ' "$state_file" 2>/dev/null)
  [[ -z "$rendered" ]] && rendered="(none specified)"
  printf '%s' "$rendered"
}

# render_anchors <state.json path>
render_anchors() {
  local state_file="$1"
  [[ -f "$state_file" ]] || { echo "(none specified)"; return 0; }
  local rendered
  rendered=$(jq -r '
    if (.anchors // []) | length == 0 then
      "(none specified — orchestrator should produce anchors.md in SCOPE phase, or AskUserQuestion to proceed-without-anchors)"
    else
      (.anchors[] | "- \(.)")
    end
  ' "$state_file" 2>/dev/null)
  [[ -z "$rendered" ]] && rendered="(none)"
  printf '%s' "$rendered"
}

# render_bar <state.json path>
render_bar() {
  local state_file="$1"
  [[ -f "$state_file" ]] || { echo "(not yet populated)"; return 0; }
  local rendered
  rendered=$(jq -r '
    if (.bar // []) | length == 0 then
      "(not yet populated — orchestrator must populate in SCOPE phase)"
    else
      (.bar[] | "- [\(.id)] \(.criterion)  (evidence: \(.evidence_required // "unspecified"))\(if .categorical_ban then "  [CATEGORICAL BAN]" else "" end)")
    end
  ' "$state_file" 2>/dev/null)
  [[ -z "$rendered" ]] && rendered="(not yet populated)"
  printf '%s' "$rendered"
}

# render_role_definitions <state.json path>
render_role_definitions() {
  local state_file="$1"
  [[ -f "$state_file" ]] || { echo "(not yet populated)"; return 0; }
  local rendered
  rendered=$(jq -r '
    if (.role_definitions // []) | length == 0 then
      "(not yet populated — orchestrator must populate in SCOPE phase after archetype composition)"
    else
      (.role_definitions[] | "- \(.name) (archetype: \(.archetype), model: \(.model // "default"))")
    end
  ' "$state_file" 2>/dev/null)
  [[ -z "$rendered" ]] && rendered="(not yet populated)"
  printf '%s' "$rendered"
}

# render_team_roster <state.json path>
render_team_roster() {
  local state_file="$1"
  [[ -f "$state_file" ]] || { echo "(not yet populated)"; return 0; }
  local rendered
  rendered=$(jq -r '
    if (.role_definitions // []) | length == 0 then
      "(not yet populated)"
    else
      (.role_definitions[] | "- \(.name) (\(.archetype))")
    end
  ' "$state_file" 2>/dev/null)
  [[ -z "$rendered" ]] && rendered="(not yet populated)"
  printf '%s' "$rendered"
}
