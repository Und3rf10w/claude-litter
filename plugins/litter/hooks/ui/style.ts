// The one meaning → theme key table (phase 5b, WP-DA). Every color litter
// paints comes from here, so one meaning has one key everywhere, and every key
// follows the person's /theme. tests/unit/colorguard.spec.ts fails on a raw or
// ANSI color anywhere in hooks/, and on a color literal outside this file.
//
// Why these keys. The pane sits on the engine's dock grey
// (`composerSidebarBackground`: rgb(38,38,38) in the dark themes,
// rgb(245,245,245) or rgb(235,235,235) in the light ones) or inline on the
// terminal's own background, so each key was checked on both, dark and light
// (WCAG contrast, 2.1.291's theme values; dock grey first, then the terminal):
//  - secondary text is `inactive` (5.3:1 on both greys, 5.7 and 7.4 on the
//    terminal). `dimColor` is the terminal's faint attribute over its own
//    foreground, so how it reads depends on the terminal (a green foreground
//    goes murky on the grey): chrome.tsx's `themed` draws a dim Text with no
//    color in `inactive` instead;
//  - `subtle` is 1.9:1 on the dark grey and 2.0:1 on the light one, too faint
//    for words: separators and rules only (`faint`);
//  - added and removed are `success` and `error` (4.9 and 6.1 light, 6.2 and
//    5.5 dark), not the diff word keys, which drop to 3.2 and 3.3 on a grey;
//  - a SHA is `warning` (4.3 light, 9.3 dark): the yellow that stays legible
//    on the light grey (the identity yellow is 2.7, `chromeYellow` 1.6);
//  - links, paths and headings are `suggestion` (4.0 light, 8.1 dark);
//  - names are the engine's own name color, `cyan_FOR_SUBAGENTS_ONLY` (3.4
//    light, 4.1 dark): a name is its own word, so it never carries meaning by
//    color alone;
//  - the accent `claude` (2.9 light, 4.8 dark) is for the bold title and the
//    frame of the box waiting on something, never for running text;
//  - a selected row is `selectionBg` behind `text` (13.9:1 light, 8.5:1 dark),
//    the one background litter paints, with a `›` beside it.
// dark-ansi folds several keys into one ANSI color (`inactive` and `subtle`
// are both white), so a color never carries meaning alone: MARK puts a glyph
// and a word beside each state.

/** What a color means → the theme key that draws it. */
export const STYLE = {
  // Roles: the chrome's.
  /** litter's own name in the header, the frame of the box waiting on you. */
  accent: 'claude',
  /** A value, a label: the terminal's own text color. */
  label: 'text',
  /** A heading, a key in the keys line. */
  heading: 'suggestion',
  /** Secondary text: notes, counts, context, a label beside its value. */
  muted: 'inactive',
  /** Separators and rules only, never words (see above). */
  faint: 'subtle',
  /** A box's frame. */
  frame: 'promptBorder',

  // States: always with MARK's glyph and word.
  running: 'background',
  done: 'success',
  failed: 'error',
  warning: 'warning',
  needsYou: 'permission',
  merged: 'merged',
  idle: 'inactive',
  draft: 'inactive',

  // Things.
  link: 'suggestion',
  path: 'suggestion',
  name: 'cyan_FOR_SUBAGENTS_ONLY',
  sha: 'warning',
  added: 'success',
  removed: 'error',
  changed: 'warning',
  /** Who enforces a swarm field (15.6): the engine, litter, the prompt alone. */
  enforcedEngine: 'success',
  enforcedLitter: 'ide',
  enforcedPrompt: 'inactive',
} as const

export type StyleRole = keyof typeof STYLE

/**
 * Each swarm orchestrator's identity color, in order, red last (it reads as
 * an error): the engine's own agent identity keys. Its workers take it,
 * dimmed. A node's name is beside it, so the color never carries it alone.
 */
export const IDENTITY = [
  'blue_FOR_SUBAGENTS_ONLY',
  'green_FOR_SUBAGENTS_ONLY',
  'yellow_FOR_SUBAGENTS_ONLY',
  'purple_FOR_SUBAGENTS_ONLY',
  'orange_FOR_SUBAGENTS_ONLY',
  'pink_FOR_SUBAGENTS_ONLY',
  'cyan_FOR_SUBAGENTS_ONLY',
  'red_FOR_SUBAGENTS_ONLY',
] as const

/** The one background: a selected row, with SELECTED_MARK beside it. */
export const SELECTED_BG = 'selectionBg'
export const SELECTED_MARK = '›'

/** A state's glyph and word, drawn beside its color. */
export type Mark = { glyph: string; word: string; color: string }

export const MARK = {
  running: { glyph: '▸', word: 'running', color: STYLE.running },
  repairing: { glyph: '↻', word: 'repairing', color: STYLE.running },
  done: { glyph: '✓', word: 'done', color: STYLE.done },
  failed: { glyph: '✕', word: 'failed', color: STYLE.failed },
  warning: { glyph: '!', word: 'warning', color: STYLE.warning },
  needsYou: { glyph: '⚑', word: 'needs you', color: STYLE.needsYou },
  merged: { glyph: '↣', word: 'merged', color: STYLE.merged },
  idle: { glyph: '·', word: 'idle', color: STYLE.idle },
  stopped: { glyph: '−', word: 'stopped', color: STYLE.idle },
} as const satisfies Record<string, Mark>

/** A notice's level: the five a line can have, each a glyph and a key. */
export type NoticeLevel = 'ok' | 'info' | 'warning' | 'error' | 'needsYou'

export const NOTICE_STYLE: Record<NoticeLevel, { glyph: string; color: string }> = {
  ok: { glyph: '✓', color: STYLE.done },
  info: { glyph: '·', color: STYLE.muted },
  warning: { glyph: '!', color: STYLE.warning },
  error: { glyph: '✕', color: STYLE.failed },
  needsYou: { glyph: '⚑', color: STYLE.needsYou },
}
