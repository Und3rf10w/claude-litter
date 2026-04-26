### 8.1 `critique.v<N>.md` — CRITIC's per-gate verdict

```yaml
---
artifact_type: critique         # [L]: frontmatter-gate validates; deepwork-wiki Step 10
author: critic                  # [L]: deepwork-wiki Step 10 sources graph
instance: <INSTANCE_ID>         # [L]: frontmatter-gate instance-equality check
task_id: "<TASK_ID>"            # [L]: task-completed-gate Gate 2; deepwork-recap Gate-list
bar_id: <BAR_ID>                # [L]: deepwork-wiki Step 10; deepwork-status Step 4C
version: "v<N>"                 # [L]: stale-warn valid_against; critique-version-gate
verdict: APPROVED|HOLDING       # [L]: stale-warn; task-completed-gate cross_check
sources:                        # [L]: frontmatter-gate presence; deepwork-wiki Step 10
  - <path>
delta_from_prior: "<summary>"   # [L for critique]: deliver-gate delta_from_prior check
cross_check_for: "<TASK_ID>"    # [L]: task-completed-gate cross_check lookup; deepwork-status Step 4
---
```

### 8.2 `findings.<name>.md` — FALSIFIER hunt output

```yaml
---
artifact_type: findings         # [L]: frontmatter-gate validates; deepwork-wiki Step 10
author: <ROLE>                  # [L]: deepwork-wiki Step 10 sources graph
instance: <INSTANCE_ID>         # [L]: frontmatter-gate instance-equality check
task_id: "<TASK_ID>"            # [L]: task-completed-gate Gate 2; deepwork-recap Gate-list
bar_id: <BAR_ID>                # [L]: deepwork-wiki Step 10; deepwork-status Step 4C
sources:                        # [L]: deepwork-wiki Step 10 sources graph
  - <path>
delta_from_prior: "<summary>"   # [C]: human-readable diff summary
---
```

Use `bar_ids: [G1, G2]` (plural) when one findings artifact covers multiple bars. `deepwork-status` Step 4 accepts both scalar and array forms.

### 8.3 `coverage.<name>.md` — COVERAGE matrix

```yaml
---
artifact_type: coverage         # [L]: frontmatter-gate validates; deepwork-wiki Step 10
author: <ROLE>                  # [L]: deepwork-wiki Step 10 sources graph
instance: <INSTANCE_ID>         # [L]: frontmatter-gate instance-equality check
task_id: "<TASK_ID>"            # [L]: task-completed-gate Gate 2; deepwork-recap Gate-list
bar_id: <BAR_ID>                # [L]: deepwork-wiki Step 10; deepwork-status Step 4C
sources:                        # [L]: deepwork-wiki Step 10 sources graph
  - <path>
delta_from_prior: "<summary>"   # [C]: human-readable diff summary
---
```

### 8.4 `mechanism.<name>.md` — MECHANISM integration plan

```yaml
---
artifact_type: mechanism        # [L]: frontmatter-gate validates; deepwork-wiki Step 10
author: <ROLE>                  # [L]: deepwork-wiki Step 10 sources graph
instance: <INSTANCE_ID>         # [L]: frontmatter-gate instance-equality check
task_id: "<TASK_ID>"            # [L]: task-completed-gate Gate 2; deepwork-recap Gate-list
bar_ids:                        # [L]: deepwork-wiki Step 10; deepwork-status Step 4C
  - <BAR_ID>
sources:                        # [L]: deepwork-wiki Step 10 sources graph
  - <path>
delta_from_prior: "<summary>"   # [C]: human-readable diff summary
---
```

Mechanism artifacts typically address multiple bars; `bar_ids` (array) is preferred.

### 8.5 `reframe.<name>.md` — REFRAMER challenge

```yaml
---
artifact_type: reframe          # [L]: frontmatter-gate validates; deepwork-wiki Step 10
author: <ROLE>                  # [L]: deepwork-wiki Step 10 sources graph
instance: <INSTANCE_ID>         # [L]: frontmatter-gate instance-equality check
task_id: "<TASK_ID>"            # [L]: task-completed-gate Gate 2; deepwork-recap Gate-list
bar_id: <BAR_ID>                # [L]: deepwork-wiki Step 10; deepwork-status Step 4C
sources:                        # [L]: deepwork-wiki Step 10 sources graph
  - <path>
delta_from_prior: "<summary>"   # [C]: human-readable diff summary
---
```

### 8.6 `empirical_results.<id>.md` — empirical test verdict

```yaml
---
artifact_type: empirical_results  # [L]: frontmatter-gate validates; deepwork-wiki Step 10
author: <ROLE>                    # [L]: deepwork-wiki Step 10 sources graph
instance: <INSTANCE_ID>           # [L]: frontmatter-gate instance-equality check
task_id: "<TASK_ID>"              # [L]: task-completed-gate Gate 2; deepwork-recap Gate-list
empirical_id: <E_ID>              # [L]: deepwork-status Step 4 empirical cross-check display
bar_id: <BAR_ID>                  # [L]: deepwork-wiki Step 10; deepwork-status Step 4C
sources:                          # [L]: deepwork-wiki Step 10 sources graph
  - <path>
result: confirmed|refuted|confirmed-compatible|<other>  # [L]: phase-advance-gate Checklist A result backfill
delta_from_prior: "<summary>"     # [C]: human-readable diff summary
---
```

Use `bar_ids` (array) if the empirical result bears on multiple bars.

### 8.7 `gate-list-v<N>.md` — per-gate evidence pointers

```yaml
---
artifact_type: gate-list        # [L]: frontmatter-gate validates; deepwork-wiki Step 10
author: <ROLE>                  # [L]: deepwork-wiki Step 10 sources graph
instance: <INSTANCE_ID>         # [L]: frontmatter-gate instance-equality check
task_id: "<TASK_ID>"            # [L]: task-completed-gate Gate 2; deepwork-recap Gate-list
task_ids:                       # [L]: task-completed-gate Gate 2 (plural form)
  - "<TASK_ID>"
bar_ids:                        # [L]: deepwork-wiki Step 10; deepwork-status Step 4C
  - <BAR_ID>
version: "v<N>"                 # [L]: stale-warn valid_against
sources:                        # [L]: deepwork-wiki Step 10 sources graph
  - <path>
---
```

`gate-list-v<N>.md` uses `task_ids` (plural) and `bar_ids` (plural) because it covers all tasks and all bars in the session. The `verdict` field is absent — verdicts live in critique artifacts, not gate-list.
