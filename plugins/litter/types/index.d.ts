// litter's $.state contract (named in plugin.json as "types"). Self-contained:
// no import or reference. $.state holds only what the panes draw: /clear
// wipes it, and every run fact lives in the ledger or $.store.
//
// Phase 5 (WP-CA) marks five sections with begin and end banners naming
// their owners: the board (CD), the band (CB), the cards (CC), the tasks pane
// (CE) and the agents pane (CG). An owner edits only between its two banners;
// every line outside them is CA's.

// ---------------------------------------------------------------------------
// The swarm panes (package N; plan 15.5, 15.6, 15.7): the one thing in
// $.state, and only what the panes draw (a /clear wipes it; O's rebind has N
// draw it again). Plain data, built by hooks/swarm/view.ts from state.ts, the
// ledgers and the other packages' read functions, and drawn by the pure
// renderers in hooks/swarm/*.tsx. Every text
// in a view is already cleaned (no control characters but newline) and cut;
// every `color` is a theme key (15.6), and every status also carries a word
// or a glyph, since dark-ansi folds several keys into one color.

/** One run of text and how it's drawn. */
export type SwarmSpan = { text: string; color?: string; dim?: boolean; bold?: boolean }

/** The last action's outcome, drawn under the header. */
export type SwarmNotice = { text: string; level: 'ok' | 'info' | 'warning' | 'error' }

/** The swarm pane's views, by `view`. A read-only swarm is the browser with `readOnly`. */
export type SwarmViewName = 'start' | 'builder' | 'proposal' | 'browser' | 'history' | 'recovery' | 'unsettled'

/** One option of a view's Select. */
export type SwarmOption = { value: string; label: string }

/** What every swarm view carries. */
export type SwarmViewCommon = {
  /** Bumped by every write of the view. */
  v: number
  /** The header, left-aligned: the pane's top-right cell is the engine's ×. */
  title: SwarmSpan[]
  notice: SwarmNotice | null
}

// The start screen (15.5, "Starting a swarm").

export type SwarmTemplateRow = { id: string; name: string; description: string; scope: 'builtin' | 'user' | 'project' }
export type SwarmParamField = {
  name: string
  list: boolean
  description: string
  value: string
  /** From `git branch` and `git worktree list`, for a list parameter. */
  suggestions: string[]
}
export type SwarmTemplateForm = {
  id: string
  name: string
  description: string
  /** Its parameters but `name`, which the start screen's Name fills. */
  params: SwarmParamField[]
  /** Why [Use template] made no draft, each `<field>: <error>`; kept until a parameter changes. */
  errors: string[]
}
export type SwarmListRow = { name: string; goal: string; revision: number; nodes: number; live: boolean }

export type SwarmStartView = SwarmViewCommon & {
  view: 'start'
  /** Why nothing here can act (no litter directory), or null. */
  blocked: string | null
  name: string
  ask: string
  templates: SwarmTemplateRow[]
  template: SwarmTemplateForm | null
  swarms: SwarmListRow[]
}

// The builder (15.5).

/** One row of the swarm tree. */
export type SwarmTreeRow = {
  /**
   * The row's address: `@lead`, an orchestrator's id, or the path of ids down
   * to a worker (`part-a/fixer`), since a worker sits under each parent that
   * spawns it. A node nothing spawns is `~/<id>`; in a proposal, a node it
   * removes is `−/<id>`.
   */
  id: string
  /** The node's id; null for the lead. */
  node: string | null
  kind: 'lead' | 'orchestrator' | 'worker'
  depth: number
  label: string
  detail: string
  /** The orchestrator's identity color, which its workers take, dimmed. */
  color: string | null
  dim: boolean
  /** A proposal's mark (+ added, − removed, ~ changed, ! conflict) or a problem (!), and its color. */
  mark: string | null
  markColor: string | null
}

/** The props of the tree's Client (hooks/swarm/tree.tsx): plain JSON. */
export type SwarmTreeProps = {
  /** The swarm it draws, posted back with each pick so a stale one is caught. */
  swarm: string
  rows: SwarmTreeRow[]
  selected: string | null
  /** The builder's tree: the right-click menu and the edit keys. A proposal's only selects. */
  editable: boolean
  /** Every worker id, for "add worker ▸". */
  workers: string[]
}

/** Who enforces a field (15.3): `—` is an unset authority field, which nothing checks. */
export type SwarmBadge = 'engine' | 'litter' | 'prompt' | '—'

/** One inspector field: a Select (its first option "not set"), an Input, or text shown only. */
export type SwarmField = {
  /** The element's key, `swarm:builder:<action>:<swarm>/<node>/<field>`. */
  key: string
  label: string
  kind: 'select' | 'input' | 'text'
  value: string
  options: SwarmOption[]
  placeholder: string
  badge: SwarmBadge | null
  /** What applies while it's unset ("not set: the parent's model"), or what's wrong with the value typed. */
  note: string | null
  noteColor: string | null
}

export type SwarmInspector = { title: string; fields: SwarmField[] }

export type SwarmBriefPanel = {
  node: string
  /** The brief's first lines, drawn as Markdown. */
  markdown: string
  more: boolean
  /** A `file:` link to the saved brief, or null when it has none on disk. */
  href: string | null
  /** The draft's text isn't the saved file's. */
  differs: boolean
}

export type SwarmStripRow = { glyph: string; color: string; text: string }

export type SwarmSaveAsCandidate = { id: string; label: string; value: string; param: boolean }
export type SwarmSaveAsForm = { name: string; description: string; scope: 'user' | 'project'; candidates: SwarmSaveAsCandidate[] }

export type SwarmBuilderView = SwarmViewCommon & {
  view: 'builder'
  swarm: string
  /** The saved revision the draft started from; 0 for a swarm never saved. */
  base: number
  unsaved: boolean
  live: boolean
  /** Why the draft can't be edited (the store can't be read), or null. */
  blocked: string | null
  tree: SwarmTreeProps
  inspector: SwarmInspector
  brief: SwarmBriefPanel | null
  /** J's validation and health rows. */
  strip: SwarmStripRow[]
  /** The strip waits for the next check. */
  checking: boolean
  askLead: string
  saveAs: SwarmSaveAsForm | null
  /** The lead's staged proposals not yet decided, by number. */
  proposals: number[]
  /** Those of them J can't read (a staged brief changed, its base revision gone): why, and [Reject]. */
  unreadable: { n: number; error: string }[]
}

// A lead's proposal (15.5, "Asking the lead").

export type SwarmChangeRow = {
  index: number
  glyph: string
  color: string
  path: string
  text: string
  reason: string | null
  conflict: boolean
  /** Your value, when it's a conflict. */
  yours: string | null
  picked: boolean
}

export type SwarmBriefRow = {
  node: string
  glyph: string
  color: string
  reason: string | null
  conflict: boolean
  /** Its node is added or removed: it has no pick of its own, and `picked` is its node's (15.5). */
  withNode: boolean
  /** Its diff is open: `lines` holds it, base → the lead's. */
  open: boolean
  lines: SwarmSpan[]
  /** A conflict's other diff, base → yours, when open; else empty. */
  yoursLines: SwarmSpan[]
  /** The lead's is taken. */
  picked: boolean
}

export type SwarmProposalView = SwarmViewCommon & {
  view: 'proposal'
  swarm: string
  n: number
  /** The revision it's based on, and the one accepting it writes. */
  from: number
  to: number
  tree: SwarmTreeProps
  changes: SwarmChangeRow[]
  briefs: SwarmBriefRow[]
  counts: string
  /** Its decision, once made ("accepted all", …), else null. */
  decided: string | null
  picked: number
}

// The browser (15.6).

export type SwarmNodeRow = {
  /** The row's address: `lead` or the agent's id. */
  key: string
  /** Null for the lead. */
  agentId: string | null
  depth: number
  name: string
  color: string | null
  dim: boolean
  status: string
  statusGlyph: string
  statusColor: string
  /** The call in flight, or ''. */
  tool: string
  turns: number | null
  tokens: string
  /** The last report's first line, or ''. */
  report: string
  queued: { id: string; text: string }[]
  /** The open question, or null (⚑). */
  question: string | null
  /** A branch-moved or rule-commit flag names it. */
  flagged: boolean
}

export type SwarmEventRow = { at: string; who: string; text: string; color: string | null }

/** A branch-moved or rule-commit event not yet acknowledged. */
export type SwarmFlagRow = { seq: number; kind: 'branch-moved' | 'rule-commit'; text: string; running: string[] }

/** O's summary, labelled as generated. */
export type SwarmSummaryPanel = { goal: string; progress: string[]; waiting: string[]; age: string; stale: boolean }

export type SwarmComposer = {
  /** The target's agentId. */
  to: string | null
  /** The target as sendFromBrowser takes it, `<node>#<n>`: [Send] carries it in its key. */
  address: string | null
  targets: SwarmOption[]
  text: string
  when: 'interject' | 'queue'
  route: 'direct' | 'lead' | 'parent'
  routes: SwarmOption[]
  /** The last send was refused and can be queued instead. */
  offerQueue: boolean
}

export type SwarmTranscript = { agentId: string; name: string; readable: boolean; lines: SwarmSpan[] }

/** Who owns a read-only swarm, and whether [Take over] can be offered. */
export type SwarmOwnerPanel = { text: string; canTakeOver: boolean; why: string | null }

/** One part of a repair swarm's budget: used of granted, with its word and glyph (`! … all used`, in `warning`). */
export type SwarmBudgetPart = { used: number; of: number; text: string; glyph: string; color: string | null }

/**
 * A repair swarm's budget row (2b-2; plan 15.11, "The repair budget"): the
 * rounds (verdicts on distinct verifies) and the agents (workers and children
 * spawned) it used of what you approved.
 */
export type SwarmBudgetRow = {
  /** The run it repairs, and the run's generation it works in. */
  run: string
  generation: number
  rounds: SwarmBudgetPart
  agents: SwarmBudgetPart
  /** What a used-up budget means for it, or null while there's room. */
  note: string | null
}

export type SwarmBrowserView = SwarmViewCommon & {
  view: 'browser'
  swarm: string
  launch: string
  state: 'live' | 'stopping'
  /** Another session owns it: status, summary and transcripts only. */
  readOnly: boolean
  /** This session lost it to a handover. */
  lost: boolean
  owner: SwarmOwnerPanel | null
  /** A repair swarm's budget (2b-2); null for any other swarm. */
  budget: SwarmBudgetRow | null
  summary: SwarmSummaryPanel | null
  rows: SwarmNodeRow[]
  flags: SwarmFlagRow[]
  events: SwarmEventRow[]
  /** Null when read-only or lost. */
  composer: SwarmComposer | null
  transcript: SwarmTranscript | null
  /** The selected agentId. */
  selected: string | null
}

export type SwarmHistoryView = SwarmViewCommon & { view: 'history'; swarm: string; entries: { at: string; goal: string }[] }

/** One instance on the recovery card: shown, never picked. */
export type SwarmRecoveryInstance = {
  agentId: string
  /** `<node> #<n>`. */
  name: string
  state: 'alive' | 'settled' | 'gone'
  glyph: string
  color: string
  report: string
  respawnOnly: boolean
}

/**
 * One node on the recovery card. Only an orchestrator is picked: a worker
 * comes back through its orchestrator (15.4, "Recreating a swarm", step 4).
 */
export type SwarmRecoveryRow = {
  node: string
  kind: 'orchestrator' | 'worker'
  pickable: boolean
  /** It has an instance this session can resume (K's resumeTargets); else only a re-spawn. */
  resumable: boolean
  picked: boolean
  /** What it needs, in words: "re-spawn only", "with part-a". */
  note: string
  instances: SwarmRecoveryInstance[]
}

export type SwarmRecoveryView = SwarmViewCommon & { view: 'recovery'; swarm: string; launch: string; stopping: boolean; rows: SwarmRecoveryRow[] }

export type SwarmUnsettledView = SwarmViewCommon & {
  view: 'unsettled'
  swarm: string
  since: string
  nodes: { agentId: string; name: string; status: string }[]
  calls: { name: string; tool: string; age: string }[]
  shells: { shellId: string; name: string; age: string }[]
  reservations: number
}

/** The `litter-swarm` pane's view: one of the seven. */
export type SwarmPaneView =
  | SwarmStartView
  | SwarmBuilderView
  | SwarmProposalView
  | SwarmBrowserView
  | SwarmHistoryView
  | SwarmRecoveryView
  | SwarmUnsettledView

// The doctor pane (15.7).

export type DoctorRowView = {
  id: string
  glyph: string
  color: string
  title: string
  detail: string
  /** The need, this process's value and each settings source's, one line each. */
  values: string[]
}

export type DoctorPaneBody = {
  /** The swarm checked, or null for none. */
  swarm: string | null
  title: SwarmSpan[]
  notice: SwarmNotice | null
  rows: DoctorRowView[]
  errors: number
  warnings: number
  /** The `env` snippet for your user settings, as JSON text; null when nothing falls short. */
  snippet: string | null
  /** Your user settings file, for [Ask lead to add it]. */
  settingsPath: string
  /** The rows include [Test]'s summaryModel check. */
  tested: boolean
}

/**
 * The `litter-doctor` pane's view. It has one view, so `view` is always
 * `doctor`, and `body` is absent until its first check is in.
 */
export type DoctorPaneView = { view: string; v: number; body?: DoctorPaneBody }

// ===== begin board section (owner: WP-CD) =====
// ---------------------------------------------------------------------------
// The board (phase 3, AF; plan section 11, decision 21): one run, drawn from
// its ledger only, by hooks/board/view.ts. Execute runs get the gate table
// and its detail, and the table's menu (phase 5, CD; COMMON decision 9);
// design runs the bar × version matrix (decision 10) above their last
// records; fanout and plan runs a header and their last records. Texts are
// cleaned and cut, and colors are theme keys with a word or glyph beside
// each, as in the swarm panes.

/** A status as drawn: its word, and the color and glyph beside it (15.6). */
export type BoardStatus = { text: string; color: string; glyph: string }

/** The run's header, left-aligned. */
export type BoardHeader = {
  run: string
  workflow: string
  /** From runState: `running`, `done`, `halted`… */
  status: BoardStatus
  generation: number
  /** The repair swarm, while a repair generation is open. */
  repairSwarm: string | null
  /** run.json's ref, shown without `refs/heads/`. */
  branch: string
  /** The base commit, abbreviated. */
  base: string
  /** Absolute. */
  checkout: string
  started: string
  ended: string | null
  /** "ledger tampered at <seq>" when it is. */
  tampered: string | null
}

/** A gate's state on the board. */
export type BoardGateState = 'landed' | 'in progress' | 'halted' | 'waiting' | 'repairing'

/**
 * What the gate table's menu does for a row (COMMON decision 9): `replay`
 * fills `/litter:amend <gate> ` into the prompt, `note` opens the critic's
 * verdict file, `copy` copies the land's full commit id.
 */
export type BoardGateAction = 'replay' | 'note' | 'copy'

/** One gate row: `args.gates`', or one of the chain's earlier lands (`earlier`). */
export type BoardGateRow = {
  id: string
  title: string
  state: BoardGateState
  color: string
  glyph: string
  /** Counted from the gate's verifies; 0 before the first. */
  attempt: number
  maxAttempts: number
  /** The last verdict's failing dimensions (`plan_adherence`…), empty when it passed or there is none. */
  failing: string[]
  /** Absolute: `verdicts/<gate>-<attempt>.md`, or null before a verdict. */
  verdictFile: string | null
  /** The land's commit, abbreviated, or null. */
  commit: string | null
  /** The land's full commit id (40 or 64 hex), the land record's or `args.landed`'s; null when there's none or it isn't a full id. */
  oid: string | null
  /** Landed by an earlier run of the chain, named here. */
  earlier: string | null
  /** The menu's items for this row, each only where it applies: `replay` once the run has ended, `note` with a verdict file, `copy` with an `oid`. */
  actions: BoardGateAction[]
}

/** The props of the gate table's Client (hooks/board/gates.tsx): plain JSON. */
export type BoardGatesProps = {
  /** The run it draws, posted back with each pick so a stale one is caught. */
  run: string
  rows: BoardGateRow[]
  selected: string | null
}

/** The selected gate's detail. */
export type BoardGateDetail = {
  gate: string
  /** The last verdict's dimensions, in VERDICT's order; empty before a verdict. */
  dimensions: { name: string; pass: boolean; evidence: string; gaps: string[] }[]
  /** The attempt the last verdict judged (the verify it cites); null before a verdict, or when the ledger doesn't say. */
  verdictAttempt: number | null
  /** The last verify: its id, how it ended (howEnded's words), and its log folder, absolute. */
  verify: { id: string; ended: string; log: string } | null
  /** The last verdict's `plan_gap`, or the executor's when it stopped on one after that verdict (WP-AH); else ''. */
  planGap: string
  /**
   * Whose plan gap it is, and on which attempt: the critic's, on the attempt
   * its verdict judged, or the executor's, on the attempt it stopped on before
   * it was judged. Null when planGap is ''; attempt null when the ledger doesn't say.
   */
  gapBy: { who: 'critic' | 'executor'; attempt: number | null } | null
  /** The last verdict's `rule_clash`, or '' when it names none (or predates it), or the executor stopped after it. */
  ruleClash: string
}

/** A rule version the run delivered (`run.json.rules`), with its standing now (AD's loadRules). */
export type BoardRuleRow = { ref: string; standing: string; color: string }

/** One of the run's proposals, marked "proposed, not accepted". */
export type BoardProposalRow = { text: string; source: string; gate: string | null; label: string }

/** One record of a fanout, plan or design run: its kind and a short summary. */
export type BoardRecordRow = { seq: number; kind: string; text: string }

/**
 * One cell of the design matrix (COMMON decision 10), from the latest verdict
 * on that version: `✓` PASS, `~` CONDITIONAL or `✕` FAIL, the last two
 * followed by the gap kind's first letter, or `·` not judged; with its theme key.
 */
export type BoardMatrixCell = { text: string; color: string }

/** One bar item's row: its id, its text, a cell per version shown. `outside`: an id a verdict names that the bar doesn't have. */
export type BoardMatrixRow = { id: string; text: string; cells: BoardMatrixCell[]; outside: boolean }

/** One version's line under the matrix: its latest verdict's overall (or `not judged`), its proposal's sha256 abbreviated, and whether the checkout changed while it was judged. */
export type BoardVersionLine = { version: string; overall: string; color: string; sha: string; sourceChanged: boolean }

/** A design run's bar × version matrix, above its records. */
export type BoardDesign = {
  /** The versions shown, oldest first: the last 8. */
  versions: string[]
  /** How many earlier versions aren't shown. */
  hidden: number
  /** The bar's items in its order (its rule items included), then the ids outside it. */
  rows: BoardMatrixRow[]
  /** The glyphs and the gap kinds' letters, spelled out. */
  legend: string
  /** One per version shown. */
  lines: BoardVersionLine[]
}

/** What [Plan], [Diff G<n>] or the menu's critic note opened in the pane, or null. */
export type BoardSection = {
  kind: 'plan' | 'diff' | 'verdict'
  title: string
  /** Absolute: the plan, proposal or verdict file, or null for a diff. */
  path: string | null
  text: string
}

/** One of the board's buttons. */
export type BoardButton = { key: string; label: string }

export type BoardBody = {
  title: SwarmSpan[]
  notice: SwarmNotice | null
  /** Null when there is no run to show. */
  header: BoardHeader | null
  /** Execute only. */
  gates: BoardGatesProps | null
  detail: BoardGateDetail | null
  /** Design only. */
  design: BoardDesign | null
  /** The last 30, for the other workflows; empty for execute. */
  records: BoardRecordRow[]
  rules: BoardRuleRow[]
  proposals: BoardProposalRow[]
  section: BoardSection | null
  /** [Plan], [Diff G<n>] and [Rules], those that apply. The selected gate's actions are drawn from its row, under a static table. */
  buttons: BoardButton[]
  /** The run's ledger head the view was built from, so a rebuild with nothing new is skipped. */
  stamp: string
}

/**
 * The `litter-board` pane's view. `run` is the run shown, null before one is
 * picked; `body` is absent until the first build is in.
 */
export type BoardView = { view: 'board'; v: number; run: string | null; body?: BoardBody }
// ===== end board section (owner: WP-CD) =====

// ---------------------------------------------------------------------------
// The rules pane (phase 3, AF; plan 16.3, 16.8): the only place a rule is
// accepted, dismissed or retired. Built by hooks/rules/paneview.ts from AD's
// store.

export type RulesTab = 'proposed' | 'in-force'

/** One row: a proposal, an unverified rule file, or a rule in force. */
export type RulesRow = {
  /** The row's element key: a proposal's `<store>:<seq>`, a file's rule id. */
  key: string
  kind: 'proposal' | 'unverified' | 'accepted'
  /** Null for a proposal, which gets its id at [Accept]. */
  id: string | null
  version: number | null
  scope: string | null
  type: string
  /** Its word, color and glyph: `proposed`, `unverified`, `accepted`, `accepted (committed)`. */
  status: BoardStatus
  when: string
  rule: string
  /** Empty: "no paths: applies to every gate". */
  paths: string[]
  /** "local L-… overrides U-…", "matches no file", an unverified file's reason, a proposal's run and gate. */
  notes: string[]
  /** An edit proposal's diff against the version in force. */
  diff: SwarmSpan[] | null
  source: string | null
  /** The buttons it has: `accept`, `edit`, `dismiss`, `retire`. */
  actions: string[]
  /** In an import batch: whether it's checked. */
  checked?: boolean
}

/** A focused import batch (16.8; decision 3). */
export type RulesBatch = {
  /** The `rule.import` record's seq. */
  seq: number
  instances: { id: string; goal: string; date: string | null; archived: boolean }[]
  /** The row keys it preselected. */
  preselected: string[]
}

/** What a press is waiting on: a scope to accept into, a project file to confirm, or a retire to confirm. */
export type RulesPending =
  | { kind: 'scope'; key: string }
  | { kind: 'preview'; key: string; path: string; text: string }
  | { kind: 'retire'; key: string }

export type RulesBody = {
  title: SwarmSpan[]
  notice: SwarmNotice | null
  counts: { proposed: number; inForce: number }
  rows: RulesRow[]
  batch: RulesBatch | null
  /** The focused row's key, or null. */
  focus: string | null
  /** loadRules' problems, shown on the In force tab. */
  problems: string[]
  pending: RulesPending | null
  /** A proposal's paths and type as the pane holds them until [Accept]; `error` is narrowPaths' reason. */
  editing: { key: string; paths: string; type: string; error: string | null } | null
}

/** The `litter-rules` pane's view; `body` is absent until the first build is in. */
export type RulesPaneView = { view: 'rules'; v: number; tab: RulesTab; body?: RulesBody }

// ===== begin band section (owner: WP-CB) =====
// ---------------------------------------------------------------------------
// The band above the prompt (phase 5; COMMON decisions 7, 11, 12): a row per
// active run and live swarm, then a row per open permission ask. Built by
// hooks/band/view.ts, drawn by hooks/band/render.tsx under the rows of the
// plugins beneath. Texts are cleaned and cut; colors are theme keys with a
// word or glyph beside each.

/** One of a row's buttons: its key (`band:<action>[:<arg>]`), its label, and its hotkey digit, if any. */
export type BandButton = { key: string; label: string; hotkey?: string }
/** One row: its key (the run's, the swarm's or the ask's), its text as spans, and its buttons. */
export type BandRow = { key: string; spans: SwarmSpan[]; buttons: BandButton[] }
/** The band's view; with no rows the band draws nothing of litter's. */
export type BandView = { view: 'band'; v: number; rows: BandRow[] }
// ===== end band section (owner: WP-CB) =====

// ===== begin cards section (owner: WP-CC) =====
// ---------------------------------------------------------------------------
// The finished-run cards (phase 5; COMMON decision 8): a litter run's
// task-notification row redrawn as a short verdict card, by the row's
// `task.id`. Built by hooks/card/view.ts, drawn by hooks/card/render.tsx.

/** One card: the notification's task, its run, a title, two to four lines, and [Board]. */
export type CardView = { taskId: string; run: string; title: SwarmSpan[]; lines: SwarmSpan[][]; buttons: BandButton[] }
/** Every card built, by the notification's `task.id`. */
export type CardsView = { view: 'cards'; v: number; byTask: Record<string, CardView> }
// ===== end cards section (owner: WP-CC) =====

// ===== begin tasks section (owner: WP-CE) =====
// ---------------------------------------------------------------------------
// The tasks pane (phase 5; COMMON decisions 4, 15, 16): a task list's tasks,
// filtered, sorted and edited in place. Built by hooks/tasks/view.ts from
// hooks/team/store.ts, drawn by hooks/tasks/pane.tsx. Texts are cleaned and
// cut; every status pairs its theme key with a glyph and a word.

/** Which tasks the rows show. */
export type TasksFilter = 'all' | 'pending' | 'in_progress' | 'completed'
/** What the rows are sorted by (ties by id). */
export type TasksSort = 'id' | 'status' | 'owner' | 'subject'

/** One task row. Its keys carry `list`, so a press drawn for another list is caught. */
export type TasksRow = {
  id: string
  /** pending `·`, in progress `▸`, completed `✓`, each in its theme key. */
  status: BoardStatus
  /** Null: unowned. */
  owner: string | null
  /** The ids it's blocked by that aren't completed (a missing one counts, as TaskList counts it); empty when it isn't blocked. */
  blockedBy: string[]
  /** One line, cut. */
  subject: string
  selected: boolean
}

/** The selected task's editor: the file's values, or what you typed, held in the navigation until [Save]. */
export type TasksEditor = {
  id: string
  /** Null when the file's subject is too long to edit here. */
  subject: string | null
  /** The description in a one-line field, each line break as `⏎`; null when it's too long to edit here. */
  description: string | null
  /** The description as the file holds it, cleaned, when it runs past one line. */
  descriptionText: string | null
  status: string
  statuses: SwarmOption[]
  /** '' for none. */
  owner: string
  owners: SwarmOption[]
  /** "blocks #4 · blocked by #1 #2", or ''. */
  links: string
  /** Something you typed or picked differs from the file as the edit began. */
  dirty: boolean
  /** The file's mtime moved since the edit began: [Save] refuses and [Reload] is offered. */
  changed: boolean
  /** How [Save] writes it: TaskUpdate, or the locked direct write (COMMON decision 4). */
  via: 'tool' | 'direct'
}

export type TasksBody = {
  title: SwarmSpan[]
  notice: SwarmNotice | null
  /** The list shown, by its folder name (the keys' `list`); null when there's none. */
  list: string | null
  /** The list picker: each list with its kind and task count, by name. */
  lists: SwarmOption[]
  /** The picker's value: the shown list's name. */
  listName: string | null
  filter: TasksFilter
  counts: Record<TasksFilter, number>
  sort: TasksSort
  rows: TasksRow[]
  /** What stands in for the rows when there are none (a list that went empty says so); null with rows. */
  empty: string | null
  /** Task files that couldn't be read, one line each. */
  problems: string[]
  editor: TasksEditor | null
}
/** The `litter-tasks` pane's view; `body` is absent until the first build is in. */
export type TasksPaneView = { view: 'tasks'; v: number; body?: TasksBody }
// ===== end tasks section (owner: WP-CE) =====

// ===== begin agents section (owner: WP-CG) =====
// ---------------------------------------------------------------------------
// The agents pane (phase 5; COMMON decisions 5, 6, 16): agents, their
// inboxes and transcripts, a composer and [Stop]. Built and drawn by
// hooks/agents/.

export type AgentsBody = { title: SwarmSpan[]; notice: SwarmNotice | null }
/** The `litter-agents` pane's view; `body` is absent until the first build is in. */
export type AgentsPaneView = { view: 'agents'; v: number; body?: AgentsBody }
// ===== end agents section (owner: WP-CG) =====

declare module 'claude-code' {
  interface PluginState {
    litter: {
      board: BoardView | null
      rulesPane: RulesPaneView | null
      swarmPane: SwarmPaneView | null
      doctorPane: DoctorPaneView | null
      // Phase 5 (WP-CA): the band, the cards, and the tasks and agents panes.
      band: BandView | null
      cards: CardsView | null
      tasksPane: TasksPaneView | null
      agentsPane: AgentsPaneView | null
    }
  }
}
