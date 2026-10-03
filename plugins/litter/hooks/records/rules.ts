// Rules (plan section 16): a rule file's shape, what the loader makes of each
// file, the rules ledger's bodies, and what selection hands run.start.
// Contract owner: phase 3, package AA. The store (hooks/rules/store.ts,
// format.ts, ledger.ts, records.ts, import.ts) is AD's, selection
// (hooks/rules/select.ts, match.ts) AE's, the pane AF's; each imports only
// the names below.

import type { Author } from './core'
import type { Workflow } from './run'

/** Where a rule lives (16.1): `<config dir>/litter/rules/`, `<primary>/.litter/rules/`, `<primary>/.litter.local/rules/`. */
export type RuleScope = 'user' | 'project' | 'local'
export const RULE_SCOPES: readonly RuleScope[] = ['user', 'project', 'local']

/** `rule`: what to do. `ban`: what never to do, within its scope (16.2). */
export type RuleType = 'rule' | 'ban'
export const RULE_TYPES: readonly RuleType[] = ['rule', 'ban']

/** 16.3's lifecycle. */
export type RuleStatus = 'proposed' | 'accepted' | 'dismissed' | 'retired'
export const RULE_STATUSES: readonly RuleStatus[] = ['proposed', 'accepted', 'dismissed', 'retired']

/**
 * Where a rule applies (16.2): `paths` are gitignore-style patterns relative
 * to the repository (AE's match.ts), empty for everywhere; `workflows` and
 * `roles`, when set, narrow it; `when` is the situation, a sentence.
 */
export type RuleApplies = { paths: string[]; workflows?: string[]; roles?: string[]; when: string }

/** The frontmatter's `accepted` map (16.2's example: `{ at, commit, via }`), each field as written. */
export type RuleAccepted = { at?: string; commit?: string; via?: string }

/**
 * One rule file, `<id>.md`, as 16.2 has it: the frontmatter litter knows,
 * every other frontmatter key kept as its raw text in order (so a render
 * writes it back byte for byte), and the body's four sections.
 */
export type RuleDoc = {
  /** A scope letter (`U`, `P`, `L`), then a slug: `P-worktree-cleanup`. */
  id: string
  /** From 1; each accepted edit adds one. */
  version: number
  status: RuleStatus
  type: RuleType
  applies: RuleApplies
  /** A local rule's user rule it replaces in this repository (16.6). */
  overrides?: string
  accepted?: RuleAccepted
  /** Render it as a Claude Code rule file (16.7, phase 6). On by default. */
  export: boolean
  /** Each frontmatter key litter doesn't know, with the text after `key:` exactly as written (continuation lines included). */
  extra: [key: string, raw: string][]
  body: {
    /** `## Rule`: required. */
    rule: string
    /** `## Why`. */
    why: string
    /** `## Exceptions`, one entry per list item. */
    exceptions: string[]
    /** `## How to check`, one entry per list item. */
    howToCheck: string[]
  }
}

/**
 * What counts as accepted for one file (16.4), read per file at every load.
 * `accepted`: its sha256 is the one the latest `rule.accept` for it recorded.
 * `accepted (committed)`: a project rule as committed at the primary
 * checkout's HEAD, by no swarm node's `rule-commit`. Anything else is
 * `unverified`, with `why`.
 */
export type RuleStanding = 'accepted' | 'accepted (committed)' | 'unverified'

/**
 * A rule file as AD's loadRules found it. `doc` is the file as it stands;
 * `delivered` is the version in force, what selection renders: `doc` itself
 * when it's accepted, HEAD's version for an edited or deleted committed
 * project rule, and null for an unverified file with nothing in force.
 */
export type LoadedRule = {
  doc: RuleDoc
  scope: RuleScope
  /** Absolute. */
  path: string
  /** Of the file's exact bytes. */
  sha256: string
  standing: RuleStanding
  /** Why it's unverified ("committed by node fixer in 3f2c1a9", "a hand edit"), or a note on an accepted one. */
  why?: string
  delivered: RuleDoc | null
}

/** A rule version, as `run.json.rules` holds it (decision 19) and a verdict cites it; shown as `id@version`. */
export type RuleRef = { id: string; version: number }

/**
 * A proposal, by the rules ledger it's in and its seq there (decision 18):
 * `repo` is `<litterDir>/rules-ledger/` (project and local rules, and every
 * proposal made in this repository), `user` is `<config dir>/litter/rules-ledger/`.
 */
export type RuleLedgerStore = 'repo' | 'user'
export type ProposalRef = { store: RuleLedgerStore; seq: number }

/** The rules ledger's kinds (16.9). `rule.find` is read-only and records nothing; `rule.export` is phase 6. */
export type RuleRecordKind = 'rule.propose' | 'rule.open' | 'rule.import' | 'rule.accept' | 'rule.dismiss' | 'rule.retire'

// ---------------------------------------------------------------------------
// The rules ledger's bodies (decision 17: one chain per store, each body
// naming its rule id or the proposal it acts on)

/** Where an imported proposal came from (16.8; decision 3). */
export type RuleImportOrigin = { instance: string; source: string; archived: boolean; incident_ref?: string }

/**
 * `rule.propose`, from `/litter:rules add`, a critic, an import or any other
 * caller: never delivered as accepted (16.4). `rule` is the text as proposed
 * (a whole rule file, or one plain text); `doc`, the draft the mod parsed or
 * built from it. Whatever is known of where it came from is recorded:
 * a critic's `run`, `gate`, `verify_id`, `tool_use_id` and `index`, a swarm
 * critic's `swarm` and `round`, an import's origin.
 */
export type RuleProposeBody = {
  rule: string
  doc?: RuleDoc
  /** `user`, `critic`, `import`, `agent`, or another caller's word. */
  source: string
  /** Optional (decision 18): the pane asks at [Accept] when it's absent. */
  scope?: RuleScope
  /** An edit of an accepted rule: `<id>@<version>`. */
  edits?: string
  type?: RuleType
  paths?: string[]
  when?: string
  /** For the id assigned at [Accept] (16.2). */
  slug?: string
  run?: string
  gate?: string
  swarm?: string
  verify_id?: string
  /** A swarm critic's round (decision 1): null on an approval. */
  round?: number | null
  tool_use_id?: string
  /** Its place in the verdict's `proposed_rules`. */
  index?: number
  import?: RuleImportOrigin
}

/** `rule.open`: the pane opened on a rule id or a proposal (decision 18). */
export type RuleOpenBody = { id?: string; proposal?: ProposalRef }

/** One deepwork instance an import read (decision 3). `date`: `started_at`, else `last_updated`. */
export type ImportInstance = { id: string; goal: string; date: string | null; archived: boolean }

/** `rule.import`: one batch, its instances, the proposals it made, and the ones the pane preselects. */
export type RuleImportBody = {
  from: 'deepwork'
  instances: ImportInstance[]
  proposals: ProposalRef[]
  preselected: ProposalRef[]
}

/**
 * `rule.accept`, only from the rules pane's buttons (`via: 'ui'`), or a
 * project rule adopted by its commit (`via: 'commit'`). `proposal` is absent
 * for an unverified file accepted as it is.
 */
export type RuleAcceptBody = {
  proposal?: ProposalRef
  id: string
  version: number
  scope: RuleScope
  /** Absolute: the file the mod wrote. */
  path: string
  /** Of the file's exact bytes: what makes it count as accepted (16.4). */
  sha256: string
  via: 'ui' | 'commit'
}

/** `rule.dismiss`, only from the pane: `folded` is the sha256 of the text with whitespace and case folded (16.3). */
export type RuleDismissBody = { proposal: ProposalRef; folded: string; via: 'ui' }

/** `rule.retire`, only from the pane. */
export type RuleRetireBody = { id: string; version: number; via: 'ui' }

// ---------------------------------------------------------------------------
// What callers hand the store, and what the store hands back

/**
 * One of a gate critic's `proposed_rules`, for AD's proposeFromCritic: from a
 * run's gate critic (output.ts, with `tool_use_id`, and `gate` and
 * `verify_id` from the verify its verdict cites) or a swarm's critic
 * (swarm/gate.ts, with `swarm`, `verify_id` and `round`). `by` is the critic,
 * the record's author; `index` its place in the verdict's list.
 */
export type CriticProposal = {
  run: string
  rule: string
  source: 'critic'
  by: Author
  index: number
  tool_use_id?: string
  gate?: string
  verify_id?: string
  swarm?: string
  round?: number | null
}

/** A deepwork guardrail as an import read it, before it's proposed (16.8). */
export type ImportGuardrail = { instance: string; text: string; source: string; incident_ref: string | null; archived: boolean }

/** What AD's readDeepwork found: the instances, their guardrails merged as render_guardrails merges them, and what it couldn't read. */
export type ImportBatch = { instances: ImportInstance[]; guardrails: ImportGuardrail[]; problems: string[] }

/** A unit selection picks rules for: an execute gate by its Files, a fanout task by its owned files (a trailing `/` owns a folder). */
export type SelectUnit = { id: string; files: string[] }

/**
 * What run.start's prepare hands AE's selectForRun (lifecycle.ts), before it
 * writes anything. `gates` for execute (the gates this run works, a
 * continuation's remaining ones), `tasks` for fanout; both empty otherwise.
 * `planText` is the plan as parsed (execute, or a plan run given one);
 * `anchors` a design's, as `rule.find { applicable }` takes them; and
 * `runRules` your run rules as rendered into `args.rules`, so the 8 KiB cap
 * counts them (16.5).
 */
export type SelectInput = {
  litterDir: string
  workflow: Workflow
  gates: SelectUnit[]
  tasks: SelectUnit[]
  planText: string | null
  goal: string | null
  anchors: string[]
  /** Absolute: the checkout the launch was checked in. */
  checkout: string
  runRules: string[]
}

/**
 * What AE's selectForRun hands run.start (16.5; decisions 25 and 26). Each
 * string is one rendered entry, with no label or tag (the scripts add
 * those). `run` holds the rules every unit shares, so they go into
 * `args.rules` after your run rules; `gates` and `tasks` each unit's own, by
 * id; `verifier` a fanout verifier's own beyond `run` (`args.verifierRules`,
 * decision 20); `planner` a plan run's, beyond your run rules. `versions` is
 * every rule delivered anywhere, full or as a pointer, once each.
 */
export type Selection = {
  run: string[]
  gates: Record<string, string[]>
  tasks: Record<string, string[]>
  verifier: string[]
  planner: string[]
  versions: RuleRef[]
}

/** A selection that delivers nothing. */
export const emptySelection = (): Selection => ({ run: [], gates: {}, tasks: {}, verifier: [], planner: [], versions: [] })
