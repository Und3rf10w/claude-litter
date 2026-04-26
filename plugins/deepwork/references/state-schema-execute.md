# Execute-mode state schema reference

Schema definitions for entries in `state.json` arrays that are specific to
execute-mode sessions. These definitions were previously stored in
`profiles/execute/state-schema.json` under a `_schemas` key; moved here
(W16b) to keep runtime state free of documentation keys.

## test_manifest_entry

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier, e.g. `TM-1` |
| `source_file` | string | Absolute path to the source file under test |
| `test_command` | string | Shell command to run the covering test |
| `env` | object\|null | Env vars required to run the test |
| `last_result` | string | `unknown` \| `pass` \| `fail` \| `error` |
| `last_run_at` | string\|null | ISO 8601 timestamp of last test run |

## change_log_entry

| Field | Type | Description |
|---|---|---|
| `id` | string | Unique identifier, e.g. `CL-1` |
| `plan_section` | string | `<plan_file>#<section_id>` reference |
| `files_touched` | array of strings | Absolute paths modified |
| `test_evidence` | string\|null | Path to test-results.jsonl entry or null |
| `description` | string | Human-readable summary of the change |
| `critic_verdict` | string\|null | null until CRITIC reviews; `APPROVED` \| `REJECTED` |
| `merged_at` | string\|null | ISO 8601 timestamp when merged, null if pending |
| `worktree` | string | Path to the git worktree used for this change |
