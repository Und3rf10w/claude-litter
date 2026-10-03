// litter's $.state contract (named in plugin.json as "types"). Self-contained:
// no import or reference. The board's values arrive with the board (phase 3);
// until then the mod keeps nothing in $.state, since /clear wipes it and every
// run fact lives in the ledger or $.store.

export type LitterBoard = {
  /** The run the board shows, or null. */
  run: string | null
  /** Bumped by the drain and the record tool, so readers redraw. */
  version: number
}

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
export type SwarmTemplateForm = { id: string; name: string; description: string; params: SwarmParamField[] }
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
  /** Its diff is open: `lines` holds it. */
  open: boolean
  lines: SwarmSpan[]
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

export type SwarmRecoveryRow = {
  agentId: string
  node: string
  name: string
  kind: string
  state: 'alive' | 'settled' | 'gone'
  glyph: string
  color: string
  report: string
  respawnOnly: boolean
  picked: boolean
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

declare module 'claude-code' {
  interface PluginState {
    litter: { board: LitterBoard; swarmPane: SwarmPaneView | null; doctorPane: DoctorPaneView | null }
  }
}
