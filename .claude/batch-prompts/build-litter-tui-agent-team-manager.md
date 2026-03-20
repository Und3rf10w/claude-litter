# Task: Build litter-tui — a Textual TUI for managing Claude Code agent teams

## Project Context

**Language**: Python 3.14+
**Package Manager**: uv
**Framework**: Textual (TUI framework by the creators of Rich)
**Agent Layer**: claude-agent-sdk (Python SDK wrapping Claude Code CLI)
**State**: Claude Code native agent teams (~/.claude/teams/, ~/.claude/tasks/)
**Repository**: claude-litter (a Claude Code plugin marketplace with claude-swarm plugin)
**Existing Code**: Bare scaffold — `main.py` is a hello-world stub, `pyproject.toml` has zero dependencies, empty `tui/` directory exists

**Key Data Paths** (read/written by CC native agent teams and claude-agent-sdk):
- `~/.claude/teams/<team-name>/config.json` — team config, member list, status
- `~/.claude/tasks/<team-name>/<id>.json` — individual task files (numeric IDs)
- `~/.claude/teams/<team-name>/inboxes/<agent>.json` — per-agent message inbox
- `~/.claude/teams/<team-name>/.window_registry.json` — kitty window tracking

**Native CC Agent Teams** (experimental, uses TeamCreate/TaskCreate/Agent/SendMessage tools):
- Teams stored in `~/.claude/teams/{team-name}/config.json`
- Tasks stored in `~/.claude/tasks/{team-name}/`
- Members have: agentId, name, agentType
- Task states: pending, in_progress, completed
- Task dependencies via blockedBy
- Messaging via SendMessage tool between agents
- Teammates can run in-process (Shift+Down to cycle) or in split panes (tmux/iTerm2)

**claude-agent-sdk Python API**:
- `query(prompt, options)` — simple one-shot agent run, returns async iterator of messages
- `ClaudeSDKClient(options)` — full control: `client.query()`, `client.receive_response()`, `client.interrupt()`
- Session resumption: `ClaudeAgentOptions(resume=session_id)`
- Message types: `ResultMessage`, `AssistantMessage`, `SystemMessage`, `TaskStartedMessage`, `TaskProgressMessage`
- Hooks: `PreToolUse`, `PostToolUse`, `Stop`, `Notification`, etc.
- Plugins: `ClaudeAgentOptions(plugins=[{"type": "local", "path": "./plugins/claude-swarm"}])`
- Subagents: `AgentDefinition(description, prompt, tools)`
- Permission modes: `default`, `plan`, `acceptEdits`, `bypassPermissions`
- Custom tools via MCP: `create_sdk_mcp_server()`

## Goal

Build `litter-tui`, a full-featured Python TUI application using Textual that serves as the primary interface for creating, managing, and interacting with Claude Code agent teams. The TUI replaces the terminal-based swarm workflow entirely while also supporting native kitty terminal integration (pop-out to kitty windows/tabs, import kitty windows, kitty session mode, kitty as display backend).

**Core capabilities:**
1. **Team Management**: Create, list, suspend, resume, archive, delete teams
2. **Agent Lifecycle**: Spawn agents (with model/role selection), monitor status, view heartbeats, kill agents
3. **Live Session Interaction**: Stream agent output in real-time, send prompts to any agent, interrupt agents
4. **Task Management**: Create, assign, update status, track dependencies, view task boards
5. **Messaging**: Send/receive messages, view inboxes, broadcast, message history
6. **Agent Mobility**: Duplicate agents to other teams, move agents between teams, save/load agent templates
7. **Kitty Integration**: Pop-out agent sessions to kitty windows/tabs, import existing kitty windows, kitty session mode, kitty as display backend
8. **Keybindings**: Both standard TUI (Ctrl+key, mouse) and vim-style (j/k, h/l, :commands), toggleable
9. **Detachable**: TUI can detach (like tmux detach) while agents keep running, reattach later via session resumption

**Layout**: Sidebar + tabbed sessions
- Left sidebar: collapsible team tree (teams > agents), quick info panel
- Main area: tabbed agent sessions with live streaming output
- Bottom: input bar for sending prompts to focused agent
- Toggle panels: tasks (Ctrl+T), messages (Ctrl+M) slide in from right
- Status bar at top: active team, agent count, global status

## Conventions

All teammates must follow these rules:

- Use `uv` for dependency management — add deps to `pyproject.toml` with `uv add`
- Python 3.14+ — use modern syntax (match/case, type hints, etc.)
- Use `anyio` for async (not raw asyncio) — the claude-agent-sdk uses anyio
- Follow Textual's component architecture: App > Screen > Widget
- Use Textual CSS for styling (`.tcss` files), not inline styles
- All agent interaction goes through `claude-agent-sdk` (`ClaudeSDKClient` for full control)
- State reads from `~/.claude/teams/` and `~/.claude/tasks/` JSON files directly (polling via Textual's `set_interval` or file watchers)
- State mutations go through `claude-agent-sdk` API calls (the SDK handles file locking)
- No subprocess calls to bash swarm library — use native CC teams via the SDK
- Tests go in `tests/` using pytest + pytest-anyio
- Each module should have type hints and minimal docstrings on public APIs
- Use `__all__` exports in `__init__.py` files
- Package structure under `src/litter_tui/`

## Team Setup

Create a team using TeamCreate:
- **Team name**: `litter-tui-build`
- **Description**: "Build the litter-tui Python TUI application for managing Claude Code agent teams"

Then create the following tasks using TaskCreate. Each task includes its subject, description, and dependency relationships.

### Task: Set up project structure and dependencies
- **Description**: Initialize the Python project structure for litter-tui. Update `pyproject.toml` with all required dependencies: `textual>=3.0`, `claude-agent-sdk`, `anyio`, `rich` (Textual dep), `watchfiles` (for file watching). Set up the `src/litter_tui/` package layout with `__init__.py`, `app.py`, `__main__.py` (for `python -m litter_tui`). Create the directory structure:
  ```
  src/litter_tui/
  ├── __init__.py           # Package init, version
  ├── __main__.py           # Entry point: python -m litter_tui
  ├── app.py                # Main Textual App class
  ├── config.py             # App configuration, paths, constants
  ├── styles/
  │   └── app.tcss          # Main Textual CSS stylesheet
  ├── models/
  │   ├── __init__.py
  │   ├── team.py           # Team, Member dataclasses
  │   ├── task.py           # Task dataclass
  │   └── message.py        # Message dataclass
  ├── services/
  │   ├── __init__.py
  │   ├── state.py          # State manager (reads ~/.claude/ JSON files)
  │   ├── agent_manager.py  # ClaudeSDKClient wrapper for agent sessions
  │   ├── team_service.py   # Team CRUD operations via SDK
  │   └── kitty.py          # Kitty terminal integration
  ├── widgets/
  │   ├── __init__.py
  │   ├── sidebar.py        # Team tree sidebar widget
  │   ├── session_view.py   # Agent session output viewer
  │   ├── input_bar.py      # Prompt input bar
  │   ├── task_panel.py     # Task list/board panel
  │   ├── message_panel.py  # Message inbox panel
  │   ├── status_bar.py     # Top status bar
  │   └── tab_bar.py        # Session tab management
  ├── screens/
  │   ├── __init__.py
  │   ├── main.py           # Main screen (sidebar + sessions)
  │   ├── create_team.py    # Team creation dialog
  │   ├── spawn_agent.py    # Agent spawn dialog
  │   ├── task_detail.py    # Task detail/edit screen
  │   └── settings.py       # Settings screen (keybindings, kitty config)
  └── keybindings/
      ├── __init__.py
      ├── standard.py       # Standard Ctrl+key bindings
      └── vim.py            # Vim-style bindings
  ```
  Create stub files for all modules with proper `__init__.py` exports. Add a `[project.scripts]` entry in `pyproject.toml` so `litter-tui` command works. Run `uv sync` to install dependencies. Acceptance criteria: `uv run python -m litter_tui` runs without import errors (can show empty Textual app).
- **Blocked by**: none
- **Blocks**: Data models, State management service, Textual App shell and main screen, Agent session manager, Kitty integration service

### Task: Build data models
- **Description**: Implement the data model layer in `src/litter_tui/models/`. These dataclasses map to the JSON files stored in `~/.claude/teams/` and `~/.claude/tasks/`. Create:
  - `team.py`: `Team` dataclass (name, description, status, members list, createdAt, suspendedAt, resumedAt, leadAgentId, hasSpawnedLead, webhooks). `Member` dataclass (agentId, name, agentType, type, color, model, status, joinedAt, lastSeen). `TeamStatus` enum (active, suspended, archived). `MemberStatus` enum (active, offline). `AgentColor` enum (blue, green, yellow, red, cyan, magenta, white). `AgentModel` enum (haiku, sonnet, opus). Class methods: `Team.from_json(data: dict)`, `Team.from_file(path: Path)`, `Member.from_json(data: dict)`.
  - `task.py`: `Task` dataclass (id, subject, description, status, owner, references, blocks, blockedBy, comments list, createdAt). `TaskStatus` enum (pending, in_progress, blocked, in_review, completed). `TaskComment` dataclass (author, text, timestamp). Class methods: `Task.from_json(data: dict)`, `Task.from_file(path: Path)`.
  - `message.py`: `Message` dataclass (from_agent, text, color, read, timestamp, type, metadata). `MessageType` enum (text, join_request, join_approved, join_rejected, shutdown_request, shutdown_ack, task_assignment, task_update). Class methods: `Message.from_json(data: dict)`.
  - `__init__.py`: Export all public types.
  All models should be immutable (frozen=True) dataclasses with JSON serialization support. Include proper type hints. Acceptance criteria: All models can round-trip from JSON files found in ~/.claude/teams/ and ~/.claude/tasks/.
- **Blocked by**: Set up project structure and dependencies
- **Blocks**: State management service

### Task: Build state management service
- **Description**: Implement `src/litter_tui/services/state.py` — the reactive state layer that reads the CC native JSON files and provides them to Textual widgets. This is the bridge between file-based state and the TUI.

  Create `StateManager` class:
  - `__init__(self, base_path: Path = Path.home() / ".claude")` — configurable base path
  - `async def start(self)` — begin watching files for changes using `watchfiles`
  - `async def stop(self)` — stop file watching
  - `def get_teams(self) -> list[Team]` — list all teams by scanning `teams/` directory
  - `def get_team(self, name: str) -> Team | None` — read a specific team config
  - `def get_tasks(self, team_name: str) -> list[Task]` — read all tasks for a team
  - `def get_task(self, team_name: str, task_id: str) -> Task | None` — read specific task
  - `def get_inbox(self, team_name: str, agent_name: str) -> list[Message]` — read agent's inbox
  - `def get_unread_count(self, team_name: str, agent_name: str) -> int` — unread message count

  Reactive updates:
  - Use Textual's `reactive` or message posting to notify widgets when files change
  - `watchfiles` watches `~/.claude/teams/` and `~/.claude/tasks/` recursively
  - On file change, re-read the affected JSON and post a custom Textual message (e.g., `TeamUpdated`, `TaskUpdated`, `InboxUpdated`)
  - Debounce rapid file changes (100ms)

  Acceptance criteria: StateManager correctly reads existing ~/.claude/ state, posts update messages when files change on disk, handles missing/corrupt JSON gracefully (log warning, skip).
- **Blocked by**: Build data models
- **Blocks**: Sidebar team tree widget, Task panel widget, Message panel widget

### Task: Build agent session manager
- **Description**: Implement `src/litter_tui/services/agent_manager.py` — the service that manages Claude Code agent sessions via `claude-agent-sdk`. Each agent in the TUI is backed by a `ClaudeSDKClient` instance.

  Create `AgentSession` class:
  - Wraps a single `ClaudeSDKClient` instance
  - `session_id: str | None` — captured from SystemMessage init
  - `team_name: str`, `agent_name: str`, `model: str`
  - `status: Literal["starting", "active", "idle", "stopped"]`
  - `output_buffer: list[str]` — recent output lines for display
  - `async def start(self, prompt: str, options: ClaudeAgentOptions)` — start the session
  - `async def send_prompt(self, prompt: str)` — send follow-up prompt (resume session)
  - `async def interrupt(self)` — interrupt current execution
  - `async def stop(self)` — graceful shutdown
  - `async def stream_output(self) -> AsyncIterator[str]` — yields output lines for the TUI to display
  - Internal: processes `AssistantMessage`, `ResultMessage`, `SystemMessage`, `TaskProgressMessage` into displayable text

  Create `AgentManager` class:
  - `sessions: dict[tuple[str, str], AgentSession]` — keyed by (team_name, agent_name)
  - `async def spawn_agent(self, team_name, agent_name, agent_type, model, prompt, **kwargs) -> AgentSession` — creates and starts a new agent session
  - `async def get_session(self, team_name, agent_name) -> AgentSession | None`
  - `async def stop_agent(self, team_name, agent_name)` — stop a specific agent
  - `async def stop_team(self, team_name)` — stop all agents in a team
  - `async def duplicate_agent(self, from_team, agent_name, to_team, new_name=None)` — duplicate agent config to another team
  - `async def move_agent(self, from_team, agent_name, to_team)` — move agent between teams

  Agent templates:
  - `AgentTemplate` dataclass: name, agent_type, model, system_prompt, tools, description
  - `save_template(self, session, template_name)` — save current agent config as template
  - `load_templates(self) -> list[AgentTemplate]` — load from `~/.claude/litter-tui/templates/`
  - `spawn_from_template(self, team_name, template_name, agent_name)` — spawn agent from template

  Session detachment:
  - `detach(self)` — save all session IDs to `~/.claude/litter-tui/detached-sessions.json`
  - `reattach(self)` — on TUI startup, check for detached sessions and resume them via `ClaudeAgentOptions(resume=session_id)`

  Acceptance criteria: Can spawn an agent via SDK, stream its output, send it prompts, interrupt it, and stop it. Templates can be saved/loaded. Detach/reattach preserves session continuity.
- **Blocked by**: Set up project structure and dependencies
- **Blocks**: Agent session view widget, Spawn agent dialog screen

### Task: Build Textual App shell and main screen
- **Description**: Implement the core Textual application structure in `src/litter_tui/app.py` and `src/litter_tui/screens/main.py`.

  `LitterTuiApp(App)` in `app.py`:
  - Title: "litter-tui"
  - CSS file: `styles/app.tcss`
  - Bindings: Ctrl+Q quit, Ctrl+T toggle task panel, Ctrl+M toggle messages panel, Ctrl+N new team dialog, Ctrl+S spawn agent dialog, Ctrl+D detach, F1 help, Tab cycle focus
  - `on_mount`: Initialize `StateManager`, `AgentManager`, push `MainScreen`
  - `on_unmount`: Prompt for detach or shutdown of running agents
  - Settings: vim_mode toggle, kitty integration on/off, theme (dark/light)
  - Stores `AgentManager` and `StateManager` as app-level state

  `MainScreen(Screen)` in `screens/main.py`:
  - Layout: Horizontal container with sidebar (fixed width ~20 cols) and main content area
  - Main content area: vertical with tab bar at top, session view in middle, input bar at bottom
  - Right slide-out panels: task panel and message panel (toggled)
  - Compose method builds the widget tree
  - Handles `TeamUpdated`, `TaskUpdated`, `InboxUpdated` messages from StateManager

  `styles/app.tcss`:
  - Dark theme by default (Textual's built-in dark theme as base)
  - Sidebar: fixed width, scrollable, bordered
  - Session view: flexible, fills available space
  - Tab bar: horizontal, scrollable tabs
  - Input bar: fixed height at bottom, styled like a terminal prompt
  - Task/message panels: slide in from right, 30% width
  - Agent status colors matching the swarm color palette (blue, green, yellow, red, cyan, magenta, white)

  `__main__.py`:
  - Parse CLI args (--vim-mode, --kitty, --reattach)
  - Instantiate and run `LitterTuiApp`

  Acceptance criteria: `uv run litter-tui` launches a Textual app with the correct layout structure. Sidebar, tab bar, session area, and input bar are visible. Keyboard shortcuts are bound. App exits cleanly.
- **Blocked by**: Set up project structure and dependencies
- **Blocks**: Sidebar team tree widget, Agent session view widget, Input bar widget, Status bar widget, Tab bar widget

### Task: Build sidebar team tree widget
- **Description**: Implement `src/litter_tui/widgets/sidebar.py` — the left sidebar showing a collapsible tree of teams and their agents.

  `TeamTreeWidget(Widget)`:
  - Uses Textual's `Tree` widget as the base
  - Root nodes: team names (collapsible), styled with team status icon (active=green dot, suspended=yellow, archived=gray)
  - Child nodes: agent names under each team, styled with:
    - Status indicator: active=filled circle, offline=empty circle, starting=spinner
    - Agent color (from config) applied to the name
    - Model badge (H/S/O for haiku/sonnet/opus)
    - Unread message count badge (if > 0)
    - Current task ID (if assigned)
  - Click on agent: opens/focuses that agent's session tab in the main area
  - Right-click context menu (or keybinding):
    - Agent: Send message, View inbox, Assign task, Duplicate to team, Move to team, Kill agent, Pop-out to kitty
    - Team: Spawn agent, View tasks, Suspend/Resume, Archive, Delete, Create from template
  - Drag and drop: drag agents between teams (visual feedback with Textual's DragDrop)
  - Quick info panel below tree: shows details of selected agent/team (model, task, last seen, session status)

  Reactive updates:
  - Listens for `TeamUpdated` messages from StateManager
  - Refreshes tree nodes when team/agent state changes
  - Animates status transitions (e.g., offline -> active)

  Acceptance criteria: Tree shows real teams from ~/.claude/teams/. Clicking an agent opens its tab. Context menus work. Tree updates reactively when state changes.
- **Blocked by**: Build Textual App shell and main screen, Build state management service
- **Blocks**: Integration and end-to-end verification

### Task: Build agent session view widget
- **Description**: Implement `src/litter_tui/widgets/session_view.py` — the main content area showing an agent's live session output with streaming.

  `SessionView(Widget)`:
  - Displays streaming output from an `AgentSession` (from agent_manager)
  - Output rendering:
    - Text blocks: rendered as Rich-formatted text (markdown support)
    - Tool use blocks: show tool name, input summary, collapsible details
    - Thinking blocks: dimmed/collapsible section labeled "[Thinking...]"
    - Task progress: inline progress indicators
    - Errors: red-highlighted blocks
  - Auto-scroll to bottom on new output (unless user has scrolled up)
  - Scroll-back buffer: configurable max lines (default 10000)
  - Session header: agent name, model, status, current task, session duration
  - Loading state: spinner when agent is processing
  - Idle state: "Agent idle. Send a prompt below." message
  - Connection to AgentSession:
    - `watch_session(session: AgentSession)` — binds to session's output stream
    - Processes messages from `session.stream_output()` async iterator
    - Updates display in real-time using Textual's `call_from_thread` or `post_message`

  `TabBar(Widget)` in `widgets/tab_bar.py`:
  - Horizontal scrollable tab strip
  - Each tab: agent name + close button (X)
  - Active tab highlighted
  - Click to switch, Ctrl+W to close, Ctrl+Tab to cycle
  - Overflow: scroll buttons or "..." dropdown for many tabs
  - "+" button to spawn new agent in current team
  - Tabs show activity indicator (pulsing dot) when agent produces output

  Acceptance criteria: Session view streams output from a real AgentSession in real-time. Tabs switch between sessions. Output is properly formatted with Rich. Scroll behavior works correctly.
- **Blocked by**: Build Textual App shell and main screen, Build agent session manager
- **Blocks**: Integration and end-to-end verification

### Task: Build input bar widget
- **Description**: Implement `src/litter_tui/widgets/input_bar.py` — the bottom input bar for sending prompts to the focused agent.

  `InputBar(Widget)`:
  - Text input field styled like a terminal prompt
  - Prompt prefix shows target: "> Send to backend-dev: "
  - Submit with Enter: sends prompt to the focused agent's session via `AgentSession.send_prompt()`
  - Multi-line input: Shift+Enter for newlines
  - Command mode (vim-style): ":" prefix opens command palette
    - `:spawn <name> [type] [model]` — spawn agent
    - `:kill <name>` — kill agent
    - `:msg <agent> <text>` — send message
    - `:broadcast <text>` — broadcast to team
    - `:task create <subject>` — create task
    - `:task assign <id> <agent>` — assign task
    - `:task update <id> <status>` — update task status
    - `:team create <name>` — create team
    - `:team delete <name>` — delete team
    - `:template save <name>` — save agent as template
    - `:template list` — list templates
    - `:kitty pop-out` — pop current agent to kitty
    - `:detach` — detach TUI
    - `:vim` — toggle vim mode
  - History: Up/Down arrows cycle through previous prompts
  - Autocomplete: Tab completes agent names, team names, command names
  - Interrupt: Ctrl+C sends interrupt to the focused agent

  Acceptance criteria: Can type prompts and send them to agents. Command mode works with :commands. History and autocomplete function. Ctrl+C interrupts.
- **Blocked by**: Build Textual App shell and main screen
- **Blocks**: Integration and end-to-end verification

### Task: Build task panel widget
- **Description**: Implement `src/litter_tui/widgets/task_panel.py` — the slide-out task management panel.

  `TaskPanel(Widget)`:
  - Slides in from right when Ctrl+T is pressed (overlay, 35% width)
  - Shows tasks for the currently selected team
  - Task list view:
    - Each task: status icon (pending=circle, in_progress=filled, blocked=lock, completed=check), ID, subject, owner badge
    - Color-coded by status: pending=gray, in_progress=blue, blocked=red, in_review=yellow, completed=green
    - Dependency arrows or indentation to show blockedBy relationships
    - Filter bar: filter by status, owner, or search text
    - Sort: by ID, status, or owner
  - Task actions (click or keybinding):
    - Assign to agent (dropdown of team members)
    - Update status (dropdown)
    - Add comment
    - View full details (pushes TaskDetailScreen)
    - Delete (with confirmation)
  - Create task: button or shortcut opens inline form (subject + description)
  - Kanban view toggle: switch between list view and kanban columns (pending | in_progress | in_review | completed)

  `TaskDetailScreen(Screen)` in `screens/task_detail.py`:
  - Full screen view of a single task
  - Editable fields: subject, description, status, owner
  - Shows blockedBy and blocks relationships
  - Comments list with add comment form
  - Save/cancel buttons

  Reactive: listens for `TaskUpdated` messages from StateManager.

  Acceptance criteria: Task panel shows real tasks. Can create, assign, and update tasks. Kanban view toggles correctly. Panel slides in/out smoothly.
- **Blocked by**: Build state management service, Build Textual App shell and main screen
- **Blocks**: Integration and end-to-end verification

### Task: Build message panel widget
- **Description**: Implement `src/litter_tui/widgets/message_panel.py` — the slide-out messaging panel.

  `MessagePanel(Widget)`:
  - Slides in from right when Ctrl+M is pressed (overlay, 35% width)
  - Shows inbox for the selected agent OR a team-wide message feed
  - Toggle: "My Inbox" vs "Team Feed" (shows all messages across all agents)
  - Message display:
    - Each message: sender (colored by agent color), timestamp, text
    - Unread messages highlighted with bold/background
    - Message type badges (task_assignment, shutdown_request, etc.)
    - Auto-marks messages as read when viewed
  - Send message:
    - Inline compose form at bottom
    - To: dropdown of team members (or "All" for broadcast)
    - Text input + send button
  - Message history: scrollable, loads on demand

  Reactive: listens for `InboxUpdated` messages from StateManager.

  Acceptance criteria: Panel shows real messages from ~/.claude/ inboxes. Can send messages. Unread counts update. Team feed aggregates correctly.
- **Blocked by**: Build state management service, Build Textual App shell and main screen
- **Blocks**: Integration and end-to-end verification

### Task: Build status bar widget
- **Description**: Implement `src/litter_tui/widgets/status_bar.py` — the top status bar.

  `StatusBar(Widget)`:
  - Fixed height (1 line) at the very top of the app
  - Left section: app name "litter-tui", active team name
  - Center section: agent count (active/total), task summary (completed/total)
  - Right section: keybinding mode indicator (STD/VIM), kitty connection status, clock
  - Reactive: updates when teams/agents/tasks change
  - Color-coded alerts: red flash when agent crashes, yellow when agent goes idle

  Acceptance criteria: Status bar displays correct counts. Updates reactively. Mode indicator reflects current keybinding mode.
- **Blocked by**: Build Textual App shell and main screen
- **Blocks**: Integration and end-to-end verification

### Task: Build dialog screens (create team, spawn agent, settings)
- **Description**: Implement the dialog/modal screens for key actions.

  `CreateTeamScreen(ModalScreen)` in `screens/create_team.py`:
  - Form: team name (validated — no "..", "/", leading "-", max 100 chars), description (optional)
  - Options: auto-spawn team lead (checkbox, default on), lead model (dropdown: haiku/sonnet/opus)
  - Submit: calls SDK to create team, optionally spawns lead
  - Cancel: dismisses modal

  `SpawnAgentScreen(ModalScreen)` in `screens/spawn_agent.py`:
  - Form: agent name (validated), agent type (text input with suggestions: worker, researcher, reviewer, etc.), model (dropdown), initial prompt (multiline text area)
  - Advanced options (collapsible): permission mode, tools list, custom system prompt
  - Template selector: dropdown of saved templates, "Save as template" checkbox
  - Team selector: defaults to currently active team
  - Submit: calls AgentManager.spawn_agent()

  `SettingsScreen(Screen)` in `screens/settings.py`:
  - Keybinding mode: standard / vim / both
  - Kitty integration: enabled/disabled, kitty socket path, default spawn mode (split/tab/window)
  - Theme: dark/light
  - Session: max scroll-back lines, auto-detach on close
  - Persist to `~/.claude/litter-tui/config.json`

  Acceptance criteria: All dialogs render correctly, validate input, and perform their actions via the SDK/services.
- **Blocked by**: Build Textual App shell and main screen, Build agent session manager
- **Blocks**: Integration and end-to-end verification

### Task: Build kitty integration service
- **Description**: Implement `src/litter_tui/services/kitty.py` — the service for kitty terminal integration.

  `KittyService`:
  - `detect_kitty() -> bool` — check if running inside kitty terminal
  - `find_socket() -> str | None` — find kitty remote control socket (check KITTY_LISTEN_ON, then /tmp/kitty-$USER, then /tmp/kitty-$USER-*)
  - `validate_socket(socket: str) -> bool` — verify socket is responsive
  - `kitten_cmd(*args) -> str` — execute kitten @ command and return output

  Pop-out:
  - `pop_out_agent(team_name, agent_name, mode="tab") -> bool` — launch agent session in a new kitty window/tab
    - mode: "split" (horizontal split), "tab" (new tab), "window" (new OS window)
    - Uses `kitten @ launch --type=<mode> --var "swarm_team=<team>" --var "swarm_agent=<agent>" -- claude --resume <session_id>`
    - Registers window in `~/.claude/teams/<team>/.window_registry.json`
  - `import_kitty_window(team_name, match_var) -> bool` — adopt an existing kitty window running CC into the TUI's management

  Kitty session mode:
  - `generate_session_file(team_name, agents) -> Path` — generate a .kitty-session file that launches TUI in main pane with agent windows/tabs
  - `launch_session(session_file: Path)` — launch kitty with the session file

  Display backend:
  - `list_windows() -> list[dict]` — list all kitty windows with their vars
  - `focus_window(match_var: str)` — focus a specific kitty window
  - `close_window(match_var: str)` — close a kitty window
  - `send_text(match_var: str, text: str)` — send text to a kitty window

  Acceptance criteria: Can detect kitty, find socket, pop out agent to kitty window/tab/split, import windows, generate session files. Gracefully no-ops when not in kitty.
- **Blocked by**: Set up project structure and dependencies
- **Blocks**: Integration and end-to-end verification

### Task: Build keybinding system
- **Description**: Implement the dual keybinding system in `src/litter_tui/keybindings/`.

  `standard.py`:
  - Define standard bindings using Textual's binding system
  - Ctrl+Q: quit, Ctrl+T: toggle tasks, Ctrl+M: toggle messages
  - Ctrl+N: new team, Ctrl+S: spawn agent, Ctrl+D: detach
  - Ctrl+W: close current tab, Ctrl+Tab: next tab, Ctrl+Shift+Tab: prev tab
  - Ctrl+C: interrupt agent, Enter: send prompt
  - F1: help, F5: refresh state
  - Arrow keys: navigate sidebar/panels
  - Mouse: click to select, right-click for context menu

  `vim.py`:
  - j/k: navigate up/down in lists
  - h/l: collapse/expand tree nodes, switch panels
  - gg/G: jump to top/bottom
  - /: search/filter
  - Enter: select/activate
  - Esc: back/cancel/unfocus
  - ":": enter command mode (InputBar takes over)
  - Ctrl+w + h/j/k/l: switch between panels (sidebar, main, task, message)

  `__init__.py`:
  - `KeybindingManager` that can switch between standard and vim mode at runtime
  - Reads preference from settings, applies to app
  - Exposes `toggle_vim_mode()` for the `:vim` command

  Acceptance criteria: Both binding modes work correctly. Toggle switches cleanly at runtime. No conflicts between modes.
- **Blocked by**: Build Textual App shell and main screen
- **Blocks**: Integration and end-to-end verification

### Task: Integration and end-to-end verification
- **Description**: Wire everything together and verify the full application works end-to-end.

  Integration work:
  1. Wire `StateManager` into `MainScreen` — connect file-watching updates to widget refreshes
  2. Wire `AgentManager` into session views — connect streaming output to SessionView widgets
  3. Wire `KittyService` into sidebar context menus and :commands
  4. Wire dialog screens into the app's screen stack
  5. Wire keybindings into all widgets
  6. Ensure tab management works: opening agents creates tabs, closing tabs disconnects sessions
  7. Ensure detach/reattach flow works: Ctrl+D saves state, restart resumes sessions

  Testing:
  1. Create a test team via the TUI
  2. Spawn 2-3 agents with different roles/models
  3. Send prompts to agents and verify streaming output
  4. Create and assign tasks
  5. Send messages between agents
  6. Test detach and reattach
  7. Test kitty pop-out (if kitty available)
  8. Test both keybinding modes
  9. Verify state updates propagate reactively

  Write tests in `tests/`:
  - `test_models.py` — model serialization/deserialization
  - `test_state.py` — StateManager reads correct files
  - `test_app.py` — Textual app pilot tests (using `app.run_test()`)

  Final checks:
  - Run `uv run pytest` — all tests pass
  - Run `uv run litter-tui` — app launches correctly
  - No import errors, no runtime crashes on basic operations
  - Code is properly typed (run `uv run pyright` or `mypy` if available)

  Acceptance criteria: Full app works end-to-end. Can create a team, spawn agents, stream their output, manage tasks, send messages, and use kitty integration. All tests pass.
- **Blocked by**: Sidebar team tree widget, Agent session view widget, Build input bar widget, Build task panel widget, Build message panel widget, Build status bar widget, Build dialog screens, Build kitty integration service, Build keybinding system
- **Blocks**: none

## Teammates

### Teammate: project-scaffold
- **Agent type**: general-purpose
- **Assigned task**: Set up project structure and dependencies

**Prompt for this teammate:**
> You are the `project-scaffold` teammate on the `litter-tui-build` team. Your job is to:
>
> 1. Update `pyproject.toml` with all required dependencies and project metadata
> 2. Create the entire `src/litter_tui/` directory structure with properly stubbed files
> 3. Create `__main__.py` entry point and `[project.scripts]` config
> 4. Run `uv sync` to install dependencies
> 5. Verify `uv run python -m litter_tui` runs without import errors
>
> **Files you own** (only modify these):
> - `pyproject.toml`
> - `main.py` (update to import and run the TUI app)
> - `src/litter_tui/**/*` (all new files in the package)
>
> **Constraints**:
> - Use `uv add` for adding dependencies
> - All stub files must have proper imports and `__all__` exports
> - Models in stubs should have placeholder dataclass definitions (not just `pass`)
> - The app stub should show a minimal Textual App that renders "litter-tui" on screen
> - Mark your task as completed via TaskUpdate when done
> - If blocked, message the team lead

### Teammate: data-models
- **Agent type**: general-purpose
- **Assigned task**: Build data models

**Prompt for this teammate:**
> You are the `data-models` teammate on the `litter-tui-build` team. Your job is to:
>
> 1. Read the JSON data structures used by Claude Code native agent teams at `~/.claude/teams/` and `~/.claude/tasks/`
> 2. Implement full dataclass models in `src/litter_tui/models/` (team.py, task.py, message.py)
> 3. Include proper enums, type hints, `from_json` class methods, and JSON serialization
> 4. Write unit tests in `tests/test_models.py`
> 5. Run tests to verify round-trip serialization
>
> **Files you own** (only modify these):
> - `src/litter_tui/models/team.py`
> - `src/litter_tui/models/task.py`
> - `src/litter_tui/models/message.py`
> - `src/litter_tui/models/__init__.py`
> - `tests/test_models.py`
>
> **Constraints**:
> - Use frozen dataclasses for immutability
> - Handle optional fields gracefully (CC native JSON may not have all fields)
> - Match the exact field names from CC native JSON (see CLAUDE.md for data structures)
> - Mark your task as completed via TaskUpdate when done

### Teammate: state-service
- **Agent type**: general-purpose
- **Assigned task**: Build state management service

**Prompt for this teammate:**
> You are the `state-service` teammate on the `litter-tui-build` team. Your job is to:
>
> 1. Implement `StateManager` in `src/litter_tui/services/state.py`
> 2. Use `watchfiles` for filesystem watching of `~/.claude/teams/` and `~/.claude/tasks/`
> 3. Define custom Textual messages: `TeamUpdated`, `TaskUpdated`, `InboxUpdated`
> 4. Implement all getter methods (get_teams, get_team, get_tasks, get_inbox, etc.)
> 5. Write tests in `tests/test_state.py`
>
> **Files you own** (only modify these):
> - `src/litter_tui/services/state.py`
> - `src/litter_tui/services/__init__.py`
> - `tests/test_state.py`
>
> **Constraints**:
> - Handle corrupt/missing JSON files gracefully (log warning, return empty)
> - Debounce rapid file changes (100ms)
> - Use the data models from `src/litter_tui/models/` (import Team, Task, Message)
> - Mark your task as completed via TaskUpdate when done

### Teammate: agent-service
- **Agent type**: general-purpose
- **Assigned task**: Build agent session manager

**Prompt for this teammate:**
> You are the `agent-service` teammate on the `litter-tui-build` team. Your job is to:
>
> 1. Implement `AgentSession` and `AgentManager` in `src/litter_tui/services/agent_manager.py`
> 2. Wrap `ClaudeSDKClient` for full session lifecycle management
> 3. Implement session streaming (output buffer fed by async iterator)
> 4. Implement agent templates (save/load to `~/.claude/litter-tui/templates/`)
> 5. Implement agent mobility (duplicate, move between teams)
> 6. Implement detach/reattach (save/load session IDs)
> 7. Write tests in `tests/test_agent_manager.py`
>
> **Files you own** (only modify these):
> - `src/litter_tui/services/agent_manager.py`
> - `tests/test_agent_manager.py`
>
> **Constraints**:
> - Use `ClaudeSDKClient` (not `query()`) for full control
> - Process all message types: AssistantMessage, ResultMessage, SystemMessage, TaskProgressMessage
> - Templates stored as JSON in `~/.claude/litter-tui/templates/<name>.json`
> - Detached sessions stored in `~/.claude/litter-tui/detached-sessions.json`
> - Mark your task as completed via TaskUpdate when done

### Teammate: app-shell
- **Agent type**: general-purpose
- **Assigned task**: Build Textual App shell and main screen

**Prompt for this teammate:**
> You are the `app-shell` teammate on the `litter-tui-build` team. Your job is to:
>
> 1. Implement `LitterTuiApp` in `src/litter_tui/app.py` with all bindings and lifecycle hooks
> 2. Implement `MainScreen` in `src/litter_tui/screens/main.py` with the sidebar + tabbed sessions layout
> 3. Create the Textual CSS stylesheet in `src/litter_tui/styles/app.tcss`
> 4. Update `__main__.py` with CLI arg parsing
> 5. Write app tests using Textual's `app.run_test()` in `tests/test_app.py`
>
> **Files you own** (only modify these):
> - `src/litter_tui/app.py`
> - `src/litter_tui/screens/main.py`
> - `src/litter_tui/screens/__init__.py`
> - `src/litter_tui/styles/app.tcss`
> - `src/litter_tui/__main__.py`
> - `src/litter_tui/config.py`
> - `tests/test_app.py`
>
> **Constraints**:
> - Use placeholder widgets where real widgets aren't built yet (Static("Sidebar"), etc.)
> - The layout must be responsive (Textual CSS fr units)
> - All keyboard shortcuts from the spec must be bound
> - Mark your task as completed via TaskUpdate when done

### Teammate: widgets-builder
- **Agent type**: general-purpose
- **Assigned task**: Sidebar team tree widget, Agent session view widget, Build input bar widget, Build task panel widget, Build message panel widget, Build status bar widget

**Prompt for this teammate:**
> You are the `widgets-builder` teammate on the `litter-tui-build` team. You own ALL widget implementations. Your job is to build them in order:
>
> 1. `sidebar.py` — Team tree with collapsible nodes, status indicators, context menus
> 2. `session_view.py` — Live streaming agent output viewer with Rich formatting
> 3. `tab_bar.py` — Horizontal tab strip for switching between agent sessions
> 4. `input_bar.py` — Prompt input with command mode, history, autocomplete
> 5. `task_panel.py` — Slide-out task list with filtering, kanban toggle
> 6. `message_panel.py` — Slide-out message inbox with compose form
> 7. `status_bar.py` — Top bar with team/agent/task counts
>
> **Files you own** (only modify these):
> - `src/litter_tui/widgets/sidebar.py`
> - `src/litter_tui/widgets/session_view.py`
> - `src/litter_tui/widgets/tab_bar.py`
> - `src/litter_tui/widgets/input_bar.py`
> - `src/litter_tui/widgets/task_panel.py`
> - `src/litter_tui/widgets/message_panel.py`
> - `src/litter_tui/widgets/status_bar.py`
> - `src/litter_tui/widgets/__init__.py`
>
> **Constraints**:
> - Each widget must work standalone (testable in isolation)
> - Use Textual's `Widget` base class and compose pattern
> - Widgets consume data from `StateManager` and `AgentManager` (passed via app reference)
> - Follow Textual's message-based reactive update pattern
> - Context menus should use Textual's `OptionList` or custom dropdown widget
> - Mark your task as completed via TaskUpdate when all 7 widgets are done

### Teammate: screens-builder
- **Agent type**: general-purpose
- **Assigned task**: Build dialog screens (create team, spawn agent, settings)

**Prompt for this teammate:**
> You are the `screens-builder` teammate on the `litter-tui-build` team. Your job is to:
>
> 1. Implement `CreateTeamScreen` in `src/litter_tui/screens/create_team.py`
> 2. Implement `SpawnAgentScreen` in `src/litter_tui/screens/spawn_agent.py`
> 3. Implement `TaskDetailScreen` in `src/litter_tui/screens/task_detail.py`
> 4. Implement `SettingsScreen` in `src/litter_tui/screens/settings.py`
>
> **Files you own** (only modify these):
> - `src/litter_tui/screens/create_team.py`
> - `src/litter_tui/screens/spawn_agent.py`
> - `src/litter_tui/screens/task_detail.py`
> - `src/litter_tui/screens/settings.py`
>
> **Constraints**:
> - Use Textual's `ModalScreen` for dialogs (create team, spawn agent)
> - Use Textual's `Screen` for full-screen views (settings, task detail)
> - Validate all input (agent names, team names must pass validate_name rules)
> - Settings persist to `~/.claude/litter-tui/config.json`
> - Mark your task as completed via TaskUpdate when done

### Teammate: kitty-service
- **Agent type**: general-purpose
- **Assigned task**: Build kitty integration service

**Prompt for this teammate:**
> You are the `kitty-service` teammate on the `litter-tui-build` team. Your job is to:
>
> 1. Implement `KittyService` in `src/litter_tui/services/kitty.py`
> 2. Implement kitty detection, socket discovery, and remote control commands
> 3. Implement pop-out (window, tab, split modes), import, session file generation
> 4. Implement display backend functions (list/focus/close windows, send text)
> 5. Write tests in `tests/test_kitty.py` (mock kitten commands)
>
> **Files you own** (only modify these):
> - `src/litter_tui/services/kitty.py`
> - `tests/test_kitty.py`
>
> **Constraints**:
> - All kitty operations must gracefully no-op when not running in kitty
> - Use `kitten @` commands via `asyncio.create_subprocess_exec`
> - Socket discovery follows the pattern from claude-swarm: KITTY_LISTEN_ON > /tmp/kitty-$USER > glob
> - Window vars use `swarm_team` and `swarm_agent` naming convention for compatibility
> - Mark your task as completed via TaskUpdate when done

### Teammate: keybindings-builder
- **Agent type**: general-purpose
- **Assigned task**: Build keybinding system

**Prompt for this teammate:**
> You are the `keybindings-builder` teammate on the `litter-tui-build` team. Your job is to:
>
> 1. Implement standard keybindings in `src/litter_tui/keybindings/standard.py`
> 2. Implement vim-style keybindings in `src/litter_tui/keybindings/vim.py`
> 3. Implement `KeybindingManager` in `src/litter_tui/keybindings/__init__.py`
> 4. Ensure both modes can be toggled at runtime
>
> **Files you own** (only modify these):
> - `src/litter_tui/keybindings/__init__.py`
> - `src/litter_tui/keybindings/standard.py`
> - `src/litter_tui/keybindings/vim.py`
>
> **Constraints**:
> - Use Textual's binding system (`Binding`, `action_*` methods)
> - Vim mode should feel natural to vim users (j/k, h/l, gg/G, /, :)
> - No conflicts between modes — switching must cleanly unbind/rebind
> - Mark your task as completed via TaskUpdate when done

### Teammate: integrator
- **Agent type**: general-purpose
- **Assigned task**: Integration and end-to-end verification

**Prompt for this teammate:**
> You are the `integrator` teammate on the `litter-tui-build` team. You are the LAST to run. Your job is to:
>
> 1. Wire all services (StateManager, AgentManager, KittyService) into the app
> 2. Wire all widgets into MainScreen, replacing any placeholders
> 3. Wire all dialog screens into the app's action methods
> 4. Wire keybindings into the app
> 5. Fix any import errors or integration issues
> 6. Run `uv run pytest` and fix failing tests
> 7. Run `uv run litter-tui` and verify the app launches and works
> 8. Do a final code review for consistency, missing type hints, broken imports
>
> **Files you own**: Any file may need fixes, but prefer minimal changes.
>
> **Constraints**:
> - Do NOT rewrite other teammates' code — fix integration seams only
> - If a widget or service has bugs, fix the minimum needed
> - Ensure all `__init__.py` exports are correct
> - Ensure all screen/widget cross-references resolve
> - Mark your task as completed via TaskUpdate when all tests pass and the app runs

## Coordination

1. **Team lead** creates the team with TeamCreate and all tasks with TaskCreate, setting up blockedBy/blocks relationships as specified above
2. **Team lead** spawns all teammates that have no blockers in parallel:
   - `project-scaffold` (no blockers — starts immediately)
   - `kitty-service` (no blockers — starts immediately)
   - `agent-service` (blocked by project-scaffold)
   - `app-shell` (blocked by project-scaffold)
   - `data-models` (blocked by project-scaffold)
3. When `project-scaffold` completes:
   - Unblocks: `data-models`, `agent-service`, `app-shell`, `kitty-service`
   - Team lead spawns/notifies newly unblocked teammates
4. When `data-models` completes:
   - Unblocks: `state-service`
   - Team lead spawns `state-service`
5. When `app-shell` completes:
   - Unblocks: `widgets-builder`, `screens-builder`, `keybindings-builder`
   - Team lead spawns all three
6. When ALL implementation tasks complete:
   - Team lead spawns `integrator` for final integration and verification
7. When `integrator` completes and all tests pass:
   - Team lead runs `uv run pytest` one final time
   - Team lead runs `uv run litter-tui` to verify launch
   - Team lead reviews the combined diff for consistency
   - Team lead shuts down all teammates via shutdown_request
   - Team lead cleans up the team with TeamDelete

## Verification

After all teammates have completed their work:

1. **Tests**: Run `uv run pytest -v` — all tests must pass
2. **Type checking**: Run `uv run pyright src/` (if pyright is available) — no errors
3. **Launch test**: Run `uv run litter-tui` — app must launch without errors and show the correct layout
4. **Import verification**: Run `uv run python -c "from litter_tui import app, models, services, widgets, screens, keybindings"` — all imports succeed
5. **Dependency check**: Run `uv run pip check` — no dependency conflicts
6. **Diff review**: Review the combined git diff for:
   - Consistent code style across all teammates' work
   - No broken imports or missing dependencies between modules
   - No duplicate or conflicting widget/screen names
   - All acceptance criteria from each task are met
   - Proper `__all__` exports in all `__init__.py` files
7. **Smoke test** (if CC agent teams are available):
   - Create a test team via the TUI
   - Verify team appears in sidebar
   - Spawn an agent and verify streaming output
   - Send a message and verify it appears
