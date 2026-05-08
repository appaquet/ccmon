# ccmon

Claude Code Monitor - a Node.js + TypeScript web app that shows the status of currently running Claude Code instances.

## Context

A lightweight monitoring dashboard that reads Claude Code session data and hook-reported state to show a real-time view of all Claude sessions across projects on this machine.

Hooks already exist via `claude-tmux-indicator` (in `~/dotfiles`). ccmon will extend that script to also write `ccmon-status.json` to each project's working directory.

## Inbox

- [x] Seems like whne losing connection to backend, frontend doesn't come back with right state
  sometimes? → Fixed in Phase 30: clear projects on disconnect/reconnect
- [x] We used to show sub-agent names using their description, but it seems to show agent id now
  → Fixed in Phase 30: parse Task tool_use/toolUseResult for description correlation

## Checkpoint

Project complete. All 57 phases implemented, all 86 requirements met.

Final deliverable: Node.js + TypeScript monitoring dashboard for Claude Code and OpenCode sessions. Architecture: 6 focused source modules (types, project-utils, status-writer, session-core, session-enrichment, watcher) + 2 backend implementations (ClaudeBackend filesystem/JSONL, OpencodeBackend SQLite) behind a shared SessionBackend interface. Shared utilities for state assembly (buildProjectState) and backend iteration (collectBackendStates). Single-page vanilla JS dashboard with multi-backend WebSocket, real-time state updates, agent rows, context bars, task tracking.

303 tests pass (291 original + 12 ClaudeBackend unit tests). Lint and typecheck clean.



## Requirements

### Session Detection

- R1: ✅ Enumerate all Claude Code projects by scanning `~/.claude/projects/` (Phase: Session Detection)
  - R1.1: Working directory read from `cwd` field in first line of most recent JSONL session file (directory name encoding is lossy)
  - R1.2: Project name derived from last path segment of working directory (e.g. `ccmon`)
- R2: ✅ Determine current state of each project via layered detection (Phase: Session Detection)
  - R2.1: Primary: read `ccmon-status.json` (written by hooks). If absent or stale (>5min, state !== `stopped`) → treat as `stopped`
  - R2.2: Fallback: `pgrep -a claude` + `/proc/{pid}/cwd` (NixOS: `.claude-wrapped`) to detect live processes. If no process and status not `stopped` → override to `stopped`

### State Reporting via Hooks

- R3: ✅ `ccmon status` sub-command writes `ccmon-status.json` from hook stdin (Phase: Backend)
  - R3.1: Hook events → states:
    - `UserPromptSubmit` → `running` (Claude processing user input)
    - `PostToolUse` → `running` (Claude continuing after tool)
    - `PermissionRequest` → `waiting_for_permission`
    - `Stop` → `stopped` (Claude idle, matches tmux indicator behavior)
    - `SessionEnd` → `stopped`
    - `SubagentStop` → writes per-sub-agent `ccmon-status.json` + updates session-level status
  - R3.2: `ccmon-status.json` contains: `state`, `timestamp`, `session_id`, `working_dir`, optional `lastSubagentStoppedAt`
  - R3.3: File written to `~/.claude/projects/{dir}/ccmon-status.json` (project dir found via `sessions-index.json` lookup or path encoding fallback)
  - R3.4: Reads hook JSON from stdin (cwd, session_id, hook_event_name), maps event to state, resolves cwd to project dir
- R14: ✅ ~~Use `sessions-index.json` as primary data source~~ → Removed in Phase 42. JSONL first-line scan is now the sole discovery mechanism. `sessions-index.json` deprecated by Claude Code (~2026-02-03)
- R4: ✅ Hook config adds `ccmon status` alongside existing `claude-tmux-indicator` in `~/dotfiles/home-manager/modules/claude/settings.json` (Phase: Backend)
  - R4.1: Both hooks run in same matcher group (parallel stdin copies)
  - R4.2: `claude-tmux-indicator` remains independent — ccmon hooks alongside it, does not extend it

### Web Server

- R5: ✅ Bun HTTP server serves the dashboard at `/` (Phase: Backend)
- R6: ✅ WebSocket endpoint pushes real-time state updates to connected clients (Phase: Backend)
  - R6.1: Server watches all known `ccmon-status.json` files for changes and broadcasts updates
  - R6.2: On new client connect, send current state of all projects immediately

### UI

- R7: ✅ Single HTML page with vanilla JavaScript, no frameworks (Phase: Web UI)
- R8: ✅ Lists all detected projects, one entry per project directory in `~/.claude/projects/` (Phase: Web UI)
  - R8.1: Project name = last segment of working directory path
- R9: ✅ Each project shows: name, state with color/icon indicator (Phase: Web UI)
  - R9.1: States: `stopped` (orange), `running` (green), `waiting_for_permission` (red)
- R10: ✅ UI updates in real-time via WebSocket without page reload (Phase: Web UI)

### CLI

- R11: ✅ `ccmon dump` CLI command outputs full state of all projects as JSON to stdout (Phase: Session Detection)
  - R11.1: Serves as integration test and external introspection tool
- R13: ✅ `ccmon dump --watch` prints NDJSON state on change (Phase: Backend)
  - R13.1: Initial dump printed immediately, then watches for changes via `watchForChanges()`
  - R13.2: On each change: re-runs `getProjectState()`, prints JSON (no separator — NDJSON for jq piping)
  - R13.3: Exits cleanly on SIGINT (calls `watcher.stop()`)
  - R13.4: `--project <name>` filters by `projectName`, outputs single object instead of array

### Developer Experience

- R12: ✅ `CLAUDE.md` at project root with build/run/test instructions, improved across all phases (Phase: Session Detection)

### Packaging

- R15: ✅ Nix flake exposes ccmon as a package (Phase: Packaging)
  - R15.1: `writeShellScriptBin` wrapper calling `${pkgs.bun}/bin/bun run` on source in Nix store
  - R15.2: `packages.${system}.default` and `apps.${system}.default` outputs
  - R15.3: Bun pinned from nixpkgs (hermetic)
- R16: ✅ README with install and hook configuration instructions (Phase: Packaging)
  - R16.1: Personal/dotfiles audience — concise, assumes NixOS + home-manager
  - R16.2: Covers: flake input, adding to packages, hook configuration, available commands

- R17: ✅ `ccmon sub` CLI subcommand connects to running server via WebSocket, streams state updates as NDJSON (Phase: Backend)
  - R17.1: `--port N` flag (default 3000), `--host` flag (default localhost); exits on SIGINT or server disconnect
  - R17.2: Used for smoke-testing server stack and background monitoring
- R18: ✅ Config file system with stale project filter (Phase: Backend)
  - R18.1: `filterStaleProjects()` excludes projects with `lastUpdated` null or older than `maxInactivityHours` (default 3h)
  - R18.2: `dump` and `dump --watch` apply filter; `--max-age <hours>` and `--no-filter` CLI flags override config
  - R18.3: `serve` reads config and applies filter to all outputs (no CLI override for serve)
  - R18.4: Config at `$XDG_CONFIG_HOME/ccmon/config.json`; `CCMON_CONFIG` env var overrides path; silent defaults if missing
- R19: ✅ Session enrichment — richer `ProjectState` fields from JSONL tail parse (Phase: Backend)
  - R19.1: `gitBranch` from `sessions-index.json` (zero extra I/O)
  - R19.2: `subagentCount` — active sub-agent JSONL files (mtime < 45s) in `{sessionDir}/subagents/`
  - R19.3: `latestUserMessage`, `model`, `lastToolUse` from JSONL tail read (~64KB); only for non-stopped sessions
- R20: ✅ `getProjectState()` efficiency — caching and targeted refresh to reduce I/O on frequent calls (Phase: Backend)
  - R20.1: Sub-agent active threshold reduced 5min → 45s (avoids counting recently-finished agents)
  - R20.2: Liveness scan (`pgrep`/`/proc`) cached with 2-3s TTL
  - R20.3: `sessions-index.json` parse cached by file mtime
  - R20.4: `readSessionTail()` cached by JSONL file mtime
  - R20.5: Watcher passes changed `projectDir` → only that project is rescanned

### UI Enhancements

- R21: ✅ Task count from JSONL — `tasksDone`/`tasksTotal` via `TodoWrite` entries; superseded by R46 which adds full `TaskCreate`/`TaskUpdate` support (Phase: UI Enhancements)
- R22: ✅ Flash card when state transitions to `waiting_for_permission` (Phase: UI Enhancements)
- R23: ✅ Flash card for 5s when state transitions from `running` → `stopped` (Phase: UI Enhancements)
- R24: ✅ Short model names in web UI — `Opus`/`Sonnet`/`Haiku` display only; JSON unchanged (Phase: UI Enhancements)
- R25: ✅ Animate running state badge — pulsing dot on green pill (Phase: UI Enhancements)

### Notifications & Streaming

- R26: ✅ Notification hook events produce a transient visual flash in the dashboard (Phase: Notifications & Streaming)
  - R26.1: `ccmon status` accepts Notification hook events and writes notificationMessage + notificationTimestamp to status file
  - R26.2: Dashboard shows a time-limited flash animation when a notification arrives (no persistent state change)
  - R26.3: permission_prompt notifications are ignored when state is already waiting_for_permission (avoid duplicate signals)
- R27: ✅ JSONL reading uses byte-offset tracking to avoid re-parsing and to capture full session data (Phase: Notifications & Streaming)
  - R27.1: First read parses the entire JSONL file; subsequent reads parse only new bytes (offset-based delta)
  - R27.2: If file size shrinks (session replaced), cache resets and performs a full re-read
  - R27.3: Task counts (tasksDone/tasksTotal) reflect all TodoWrite entries in the session, not just the last 64KB
- R28: ✅ Session payload exposes both latestUserMessage and latestAssistantMessage as a pair, displayed in dashboard (Phase: Notifications & Streaming)
- R29: ✅ Sub-agent info shares a common enrichment structure with the main session (Phase: Notifications & Streaming)
  - R29.1: A shared base type carries model, latestUserMessage, latestAssistantMessage, lastToolUse, tasksDone, tasksTotal — used by both ProjectState and SubagentInfo
  - R29.2: SubagentInfo extends the base with agentId, slug, jsonlPath; ProjectState keeps its session-level fields (cwd, state, gitBranch, etc.)
  - R29.3: Sub-agent active/stopped status is determined via parent JSONL tool_result correlation or mtime heuristic fallback

### QA Pass

- R30: ✅ Last activity timestamp in web UI updates periodically without page reload (Phase: QA Pass)
- R31: ✅ Server persists current project state in memory so page refresh returns correct state (Phase: QA Pass)
- R32: ✅ Token usage from JSONL included in session payload and displayed in dashboard (Phase: QA Pass)
- R33: ✅ Running session does not flicker to stopped then back to running during active work (Phase: QA Pass)

### JSONL-Primary Detection

- R34: ✅ JSONL mtime is the primary signal for running state; hooks retained for immediate stopped detection (Phase: JSONL-Primary Detection, Stop Detection Fix)
  - R34.1: Watcher monitors *.jsonl files in project dirs; `running` derived from JSONL mtime < 60s
  - R34.2: `stopped` from Stop/SessionEnd hooks (immediate) or JSONL mtime > 60s (crash fallback)
  - R34.6: 5s grace period on JSONL-vs-stopped comparison — Claude writes post-stop system entry to JSONL, making mtime slightly newer than hook timestamp
  - R34.7: JSONL activity after `waiting_for_permission` overrides the permission state (permission was answered)
  - R34.3: ccmon-status.json read for waiting_for_permission, stopped timestamp, and notification fields
  - R34.4: pgrep/proc liveness detection removed entirely
  - R34.5: R33 debounce removed — race condition eliminated at source
- R35: ✅ Hook config — UserPromptSubmit/PostToolUse re-added for immediate running detection (Phase: JSONL-Primary Detection, Inbox Bug Fixes)
  - R35.1: UserPromptSubmit, PostToolUse → `running`; JSONL mtime remains primary for sustained running; hook provides immediate signal with 30s TTL
  - R35.2: Stop, SessionEnd, PermissionRequest, Notification, SessionStart hooks retained

### UI Polish

- R37: ✅ Latest slash command/skill displayed in UI alongside latest user message; UI shows whichever is more recent (Phase: UI Polish)
  - R37.1: `latestCommand?: string` added to `SessionEnrichment`; extracted from `<command-name>` user entries during `readSessionTail()` streaming
- R38: ✅ Sub-agent UI shows either last tool use OR last message, not both (Phase: UI Polish)
- R39: ✅ Input token count reflects full provider-billed total: `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (Phase: UI Polish)
- R40: ✅ Completed sub-agents auto-hidden in UI after 2m; backend stops returning them after 5m (Phase: UI Polish)
  - R40.1: `SubagentInfo` gains `lastMessageTime` (ISO 8601) from file mtime
- R41: ✅ Enrichment info (messages, tokens, tasks) remains visible when session transitions to stopped; only state pill updates (Phase: UI Polish)
- R42: ✅ Completed sub-agents show a checkmark indicator instead of active dot (Phase: UI Polish)
- R43: ✅ Sub-agents ordered by launch time descending in UI (Phase: UI Polish)
  - R43.1: `SubagentInfo` gains `launchTime` (ISO 8601) from first JSONL entry or file mtime
- R44: ✅ Sub-agent model (Opus/Sonnet/Haiku) displayed in sub-agent rows (Phase: UI Polish)

### Sub-Agent Names

- R36: ✅ Sub-agent cards in dashboard show a meaningful description instead of raw agentId (Phase: Sub-Agent Names)
  - R36.1: Parent JSONL `queue-operation` enqueue entries carry `{ task_id, description }` — `task_id` maps 1:1 to `agentId`
  - R36.2: `SubagentInfo` gains `description?: string`; `getSubagentInfos()` builds a description map from parent JSONL once per call
  - R36.3: UI displays `description ?? agentId` as fallback

### Dashboard Refinements

- R45: ✅ Last update timestamp displayed in card header next to project name, left of state pill (Phase: Dashboard Refinements)
- R46: ✅ Task list from JSONL — individual tasks with subject and status via `TaskCreate`/`TaskUpdate` parsing; `TodoWrite` as legacy fallback (Phase: Dashboard Refinements, Inbox Bug Fixes)
  - R46.1: `tasks?: Array<{ id, subject, status, activeForm? }>` in `SessionEnrichment`; `tasksDone`/`tasksTotal` derived from it
  - R46.2: UI shows task count summary + in-progress task subjects
  - R46.3: `TaskUpdate` entries in delta reads correctly update tasks created in earlier reads
- R47: ✅ Input token count takes the last assistant entry's value (not summed) — `input_tokens + cache_creation + cache_read` are per-call totals, not deltas (Phase: Dashboard Refinements)
  - R47.1: `outputTokens` remains summed (per-call deltas, correct to accumulate)
- R48: ✅ Agents section header shows pulsing green dot when any sub-agent is active; "N/M active" text removed (Phase: Dashboard Refinements)
- R49: ✅ `latestUserMessage` and `latestCommand` unified into `latestUserActivity?: { text, isCommand }` — single temporal winner, no double-slash (Phase: Dashboard Refinements)
  - R49.1: Backend reversed scan uses one `found` flag; first user entry chronologically sets the field
  - R49.2: UI displays `text` as-is; uses `isCommand` to choose icon only
- R50: ✅ `latestAssistantMessage` and `lastToolUse` unified into `latestAssistantActivity?: { text?, tool? }` — single temporal winner, JSON carries both when present (Phase: Dashboard Refinements)
  - R50.1: Backend reversed scan uses one `foundAssistantActivity` flag; first assistant entry sets the field; within an entry text and tool extracted independently
  - R50.2: UI shows text when present, falls back to tool name; unified single-line display like `latestUserActivity`
  - R50.3: Applies to both main session and sub-agent cards

### Card Rework

- R51: ✅ Context window progress bar — input tokens / 128k max; green default, orange >100k, red >120k; numeric "Xk" label (Phase: Card Rework)
- R52: ✅ Task count `📋 done/total` inline on same row as context bar (Phase: Card Rework)
- R53: ✅ Unified agent row format — main agent and sub-agents use identical structure: pulsing dot / checkmark, label, model, `>` user line, `<` assistant line (Phase: Card Rework)
- R54: ✅ Sub-agent `>` line shows `latestUserActivity.text` (initial instruction from first user message) (Phase: Card Rework)
- R55: ✅ Card layout: header (name + state badge) → context/tasks row → agent rows; remove git branch, output tokens, standalone model/message lines (Phase: Card Rework)

### Multi-Backend WebSocket

- R56: ✅ Dashboard supports connecting to multiple ccmon server backends simultaneously (Phase: Multi-Backend)
  - R56.1: Server WS messages use `{ hostname, projects }` envelope instead of raw `ProjectState[]`
  - R56.2: Frontend manages N backend connections with independent reconnect logic per backend
  - R56.3: Frontend handles legacy servers that send raw arrays (backward compat)
  - R56.4: Additional server URLs persisted in localStorage and restored on page load
- R57: ✅ Connection status and server management UI (Phase: Multi-Backend)
  - R57.1: Projects from all connected backends merged into a single grid
  - R57.2: Status pill: Connected (all up) / Partially connected (some up) / Disconnected (none up)
  - R57.3: Cog icon + clickable pill open server management menu; add/remove servers; main server cannot be removed

- R58: ✅ Same-named projects across backends are disambiguated with composite key and hostname prefix (Phase: Multi-Backend Naming)
  - R58.1: Card header shows `hostname:projectName` when the same `projectName` exists on multiple backends

- R59: ✅ Append-only NDJSON status event log replaces single-write status JSON (Phase: Append-Only Status Log)
  - R59.1: `ccmon-status.jsonl` — each hook event appends one JSON line; no overwrites except Stop/SessionEnd which truncate
  - R59.2: `resolveState()` scans event history; PermissionRequest resolved only by UserPromptSubmit/Stop/SessionEnd (not PostToolUse)
  - R59.3: JSONL mtime retained as pure fallback for broken-hooks scenario
  - R59.4: Removes STOP_GRACE_MS and RUNNING_HOOK_TTL_MS; simplifies resolveState from 4-priority to event-scan

### Watcher Resilience

- R60: ✅ Filesystem watchers automatically restart after errors instead of silently dying (Phase: Watcher Resilience)
  - R60.1: Restart uses exponential backoff (1s, 2s, 4s... up to 30s max); restart attempts are logged
- R61: ✅ Periodic safety broadcast (every 30s) re-scans project state and pushes to all WS clients as fallback when watchers die (Phase: Watcher Resilience)
- R62: ✅ Frontend recovers from laptop sleep without manual page refresh (Phase: Sleep/Wake WS Reconnect)

### Project Name Disambiguation

- R63: ✅ Projects with duplicate leaf names get `projectName` expanded with parent path segments until unique (Phase: Project Name Disambiguation, Review Fixes 4)
  - R63.1: `disambiguateProjectNames()` groups by basename, expands `projectName` with parent segments until unique
  - R63.2: Unique basenames keep their short name; no separate `displayName` field needed

- R64: ✅ `StopFailure` hook event detection — sessions that fail due to API errors get `error` state with persistent attention flash (Phase: StopFailure Hook)
  - R64.1: ✅ `resolveState()` treats StopFailure like a terminal state; JSONL mtime activity overrides to `running` (session recovered); resolves pending PermissionRequests
  - R64.2: ✅ UI: red "Error" badge, infinite flash animation (like `waiting_for_permission`), click-to-dismiss, re-triggers on new StopFailure
  - R64.3: ✅ Hook config: `StopFailure` matcher calls `ccmon status` + `claude-tmux-indicator off`
  - R64.4: ✅ Documentation updated (CLAUDE.md states and hook events)

- R65: ✅ Dashboard cards capped at 360px max width; grid centered so cards don't stretch to fill viewport (Phase: Card Width Cap)
- R66: ✅ Dashboard cards have max-height on agent rows section (300px) with overflow hidden; header and context bar always visible (Phase: Card Height Cap)
- R67: ✅ Session name from `/rename` displayed in card header alongside project name (Phase: Session Name Display)
  - R67.1: Extract `sessionName` from JSONL `custom-title` lines during `scanEnrichment()` reverse pass
  - R67.2: Card header shows `projectName (sessionName)` when sessionName exists; parenthesized part non-bolded
  - R67.3: CLI dump includes `sessionName` field in ProjectState output
- R68: ✅ Remove `sessions-index.json` support; JSONL-only project discovery (Phase: Remove sessions-index + Fix JSONL Discovery)
  - R68.1: `readSessionsIndex()`, cache, types, validator removed entirely
  - R68.2: `readFirstLine()` scans all lines in 4096-byte buffer until `isFirstLineRecord()` match
  - R68.3: Index-only fields removed from `ProjectInfo` (`gitBranch`, `summary`, `firstPrompt`, `messageCount`, `sessionModified`)

### Multi-Backend + OpenCode Support

- R69: ✅ Abstract data source behind `SessionBackend` interface (Phase: OpenCode Backend)
  - R69.1: `scanProjects()`, `buildProjectState()`, `watchForChanges()`, `resolveState()`, `enrichProject()`, `getSubagents()`, `projectKey()` methods
- R70: ✅ Claude Code backend as thin wrapper around existing functions, zero behavior change (Phase: Claude Backend Extraction)
- R71: ✅ OpenCode backend reads SQLite database read-only via Bun's built-in `bun:sqlite` (Phase: OpenCode Backend)
  - R71.1: ✅ Project discovery from `session` + `project` tables; returns only latest session per `directory` via `MAX(time_updated)` grouping (Phase: OpenCode Session Deduplication)
  - R71.2: ✅ State inferred from `time_updated` recency; also considers child session activity so active sub-agents keep the parent project "running" (Phase: OpenCode State Detection Fix)
  - R71.3: Enrichment from `message.data` + `part.data` JSON blobs (model, messages, tokens)
  - R71.4: Sub-agents via `parent_id` linking
  - R71.5: Change detection via SQLite polling at configurable interval
- R72: ✅ Config supports `backends` array (`{ type, enabled, ...opts }`), defaults to both backends enabled (Phase: Config)
- R73: ✅ Server merges projects from all backends, `source` field on each `ProjectState` (Phase: Multi-Backend Server)
- R74: ✅ CLI `dump` / `dump --watch` / `serve` work with all backends (Phase: CLI)
- R75: ✅ `ccmon status` subcommand remains Claude-only — hook processing unchanged (Phase: CLI)
- R76: ✅ Frontend shows source badge ("CC" / "OC") on project cards (Phase: Frontend)

### OpenCode Plugin for Status Updates

- R83: ✅ OpenCode plugin writes status events to a shared NDJSON log on session lifecycle changes (Phase: OpenCode Plugin)
  - R83.1: Plugin subscribes to session.idle→stopped, session.error→error, permission.ask→waiting, chat.message/tool.execute.after→running
  - R83.2: Zero npm dependencies (Bun built-in APIs only); installs at `~/.config/opencode/plugins/ccmon.ts`
- R84: ✅ OpencodeBackend reads plugin-written status log as primary state source, falling back to timestamp inference (Phase: OpenCode Plugin)
- R85: ✅ OpencodeBackend watches status log file via fs.watch for sub-100ms update latency; polling retained as 30s safety net (Phase: OpenCode Plugin)
- R86: ✅ Plugin auto-discovers session directory from OpenCode context; ccmon gracefully degrades without plugin installed (Phase: OpenCode Plugin)

### Runtime Migration (Bun → Node.js)

- R77: ✅ All source code runs on Node.js 22 LTS without Bun runtime (Phase: Migrate to Node.js)
  - R77.1: `node src/cli.ts <subcommand>` works identically to `bun run src/cli.ts <subcommand>`
  - R77.2: No `Bun.*` API calls remain in production code
  - R77.3: No `bun:` prefixed imports remain
- R78: ✅ Tests run on vitest (same expect/describe API as bun:test) (Phase: Migrate to Node.js)
  - R78.1: All existing tests pass with same assertions
  - R78.2: `npm test` runs all test files
- R79: ✅ Nix flake exposes ccmon via Node.js 22, not bun (Phase: Migrate to Node.js)
  - R79.1: `nix build` succeeds
  - R79.2: `nix develop` provides nodejs_22 shell
- R80: ✅ CI uses Node.js 22, not bun (Phase: Migrate to Node.js)
- R81: ✅ `npm run lint`, `npm run typecheck`, `npm test` all pass (Phase: Migrate to Node.js)
- R82: ✅ `src/env.ts` Bun sandbox workaround removed — Node.js process.env works correctly (Phase: Migrate to Node.js)

#### Out of Scope

- Authentication / multi-user support
- Historical session data / logs
- Multiple sessions per project (show latest only)

## Questions

- Q1: ✅ Status file location → per-project in working directory as `ccmon-status.json` (same as `tmux.local.log`)
- Q2: ✅ Permission hook event → `PermissionRequest` (confirmed from existing settings.json)
- Q3: ✅ Runtime/package manager → Bun (native TypeScript, ESM, built-in test runner `bun:test`). No tsconfig required but will add for IDE support. Types via `@types/bun`.
- Q4: ✅ How does ccmon discover the working directory? → Read `cwd` from the first line of the most recent JSONL session file. Directory name encoding is lossy (hyphens ambiguous), so dir name decoding is not reliable.
- Q5: ✅ Path encoding no longer primary concern. `sessions-index.json` provides `originalPath` for lookup. Fall back to `/` → `-` encoding only when index is absent. Verified empirically: encoding matches observed dirs.
- Q6: ✅ Why does server show stale state (godepsfix running) when dump shows stopped? (May 2026)
  * Traced: R61 periodic safety broadcast only calls `broadcastCurrent()` (reads frozen `stateMap`) instead of `rescanAllBackends()` (reads from disk). When fs.watch fails silently, stateMap freezes.
  * Fix: Phase 53 — changed 30s interval to `rescanAllBackends()` + `broadcastCurrent()`.
- Q7: ✅ Why are OpenCode sub-agents not detected? (May 2026)
  * Verified: Phase 52 resolveState child check + getSubagents parent_id query are both correct and deployed.
  * Verified on live DB: sub-agents have parent_id set, scanProjects returns correct sessionId.
  * Fix: Phase 54 — added fallback directory-scan query in resolveState. If parent_id check finds no active children, scans same directory for any recent non-parent session activity.

## Phases

### ✅ 01 Phase: Session Detection

[01-session-detection](01-session-detection.md)

Logic to scan `~/.claude/projects/` and map directories to project metadata. All 8 steps complete, 24 tests passing. `lastUpdated` falls back to JSONL file mtime.

### ✅ 02 Phase: Backend

[02-backend](02-backend.md)

Refactor `scanProjects()` to use `sessions-index.json`, `ccmon status` sub-command, `dump --watch` (NDJSON, `--project` filter), Bun HTTP + WebSocket server, hook config, session enrichment, efficiency caching. 95 tests passing. Hooks confirmed live.

### ✅ 03 Phase: Web UI

[03-web-ui](03-web-ui.md)

Single-page vanilla JS UI. Connects via WebSocket, renders project list, updates in real-time.

### ✅ 04 Phase: Packaging

[04-packaging](04-packaging.md)

Expose ccmon as a Nix flake package via `writeShellScriptBin` wrapper with pinned bun. Add README with install/hook instructions for personal NixOS + home-manager setup. All 3 steps done: flake.nix, README.md, CLAUDE.md.

### ✅ 05 Phase: UI Enhancements

[05-ui-enhancements](05-ui-enhancements.md)

Task count (R21 TodoWrite, R22/R23 flash animations, R24 short model names, R25 running dot pulse. R21 partial: TodoWrite sessions only; TaskCreate/TaskUpdate full-parse deferred.

### ✅ 06 Phase: Notifications & Streaming

[06-notifications-streaming](06-notifications-streaming.md)

Replace stateless 64KB tail reads with byte-offset JSONL streaming for accurate task counts and full session coverage. Add notification hook support with transient UI flash. Expose structured sub-agent info and assistant message extraction.

### ✅ 07 Phase: QA Pass

[07-qa-pass](07-qa-pass.md)

Bug fixes and improvements from real-world usage: last activity timestamp auto-refresh, server state persistence on page reload, token usage display.

### ✅ 08 Phase: JSONL-Primary Detection

[08-jsonl-primary](08-jsonl-primary.md)

JSONL mtime as primary running signal, Stop/SessionEnd hooks for immediate stopped. Removed pgrep liveness, R33 debounce, UserPromptSubmit/PostToolUse hooks. 8 tasks complete, 181 tests passing.

### ✅ 09 Phase: Sub-Agent Names

[09-sub-agent-names](09-sub-agent-names.md)

Show meaningful sub-agent descriptions in the dashboard. Name sourced from `queue-operation` enqueue entries in the parent session JSONL (`task_id` → `description` map). Implemented: 128 tests passing.

### ✅ 10 Phase: UI Polish

[10-ui-polish](10-ui-polish.md)

Collection of UI improvements and data model fixes: slash command display (R37), sub-agent show one activity (R38), accurate token totals (R39), sub-agent auto-hide lifecycle (R40), keep info on stopped (R41), completion checkmark (R42), agent ordering (R43), sub-agent model display (R44). Implemented: 144 tests passing, all tasks complete.

### ✅ 11 Phase: Dashboard Refinements

[11-dashboard-refinements](11-dashboard-refinements.md)

Fixes and improvements from real-world usage: input token counting bug fix (last value, not sum), task reintroduction with modern TaskCreate/TaskUpdate parsing, last update time in card header, agents section active indicator, latestUserActivity unified field (double-slash fix + temporal ordering). Implemented: 155 tests passing, all tasks complete.

### ✅ 12 Phase: Review Fixes

[12-review-fixes](12-review-fixes.md)

Correctness bug fixes, style cleanup, and architecture improvements from review pass. 32 tasks (30 planned + 2 post-review regressions): R26 notification flash, liveness cache, task fallback guards, NaN guards, readFirstLine 4096 slice, stale-index disk fallback. 168 tests passing.

### ✅ 13 Phase: Review Fixes 2

[13-review-fixes-2](13-review-fixes-2.md)

Second review pass: 22 tasks fixing correctness bugs (blocking spawn, watcher race, line-boundary data loss, config guard, empty-map false positive), style improvements, and minor architecture docs across sessions.ts, cli.ts, config.ts, server.ts, watcher.ts.

### ✅ 14 Phase: Card Rework

[14-card-rework](14-card-rework.md)

Rework dashboard cards to unified agent-row layout: context window progress bar (128k max, color thresholds), main + sub-agent rows look identical (pulsing dot, model, user/assistant lines). Remove git branch, output tokens. 6 UI-only tasks complete, 181 tests passing.

### ✅ 15 Phase: Stop Detection Fix

[15-stop-detection-fix](15-stop-detection-fix.md)

Fix stop detection race: Claude writes post-stop `system` entry to JSONL (8ms after hook), making JSONL mtime slightly newer than stopped timestamp. Add 5s grace period to `resolveState()` comparison (R34.6).

### ✅ 16 Phase: Inbox Bug Fixes

[16-inbox-bug-fixes](16-inbox-bug-fixes.md)

Three bugs: task completions not reflected in WebSocket/sub (delta reads drop TaskUpdate for prior tasks), `waiting_for_permission` sticking after answering (resolveState Priority 1 blocks JSONL mtime), hook config safety verification (already safe, adding tests).

### ✅ 17 Phase: Sub-Agent Stop/Resume Fix

[17-subagent-stop-resume](17-subagent-stop-resume.md)

After session stops and resumes (same UUID), old sub-agents can appear active because `getSubagentInfos()` uses 45s mtime threshold with no awareness of session stop events. Fix: pass `stoppedAtMs` into sub-agent detection.

### ✅ 18 Phase: Multi-Backend WebSocket

[18-multi-backend](18-multi-backend.md)

Dashboard connects to multiple ccmon servers simultaneously. Server sends `{ hostname, projects }` envelope. Frontend manages N connections with merged project view, connection status pill (Connected/Partially/Disconnected), and settings menu for adding/removing servers.

### ✅ 19 Phase: Linting Setup

[19-linting](19-linting.md)

Add Biome linting and TypeScript type-check. Wire `test`, `lint`, `lint:fix`, `typecheck` scripts in package.json. Document in CLAUDE.md.

### ✅ 20 Phase: GitHub Actions CI

[20-gha-ci](20-gha-ci.md)

GHA workflow running lint, typecheck, and tests on every push and pull request.

### ✅ 21 Phase: CLAUDE.md Trim

[21-claude-md-trim](21-claude-md-trim.md)

Reduced CLAUDE.md from 181 to 114 lines (37%) by removing JSON schema examples and redundant prose. Commands and architecture sections kept intact.

### ✅ 22 Phase: Multi-Backend Project Naming

[22-multi-backend-naming](22-multi-backend-naming.md)

Fix same-named projects across backends causing double flash. Use composite `hostname::projectName` key in frontend state maps. Show hostname prefix in card header when names collide.

### ✅ 25 Phase: Stopped Flash Fix

[25-stopped-flash-fix](25-stopped-flash-fix.md)

Fix stopped flash persistence: promote `flashStopped`/`flashNotification` to module-level Maps with 5s TTL. Broaden transition check to any non-stopped → stopped.

### ✅ 24 Phase: Dashboard Sort Order

[24-dashboard-sort-order](24-dashboard-sort-order.md)

Sort dashboard projects by most recently active (`lastUpdated` descending) instead of alphabetically. Throttle re-sorting to every 30s to prevent constant card reordering.

### ✅ 23 Phase: UI Triangle Arrows

[23-ui-triangle-arrows](23-ui-triangle-arrows.md)

Replace ASCII `>` / `<` message direction indicators with UTF-8 solid triangles (`▶` / `◀`) in dashboard cards.

### ✅ 26 Phase: SubagentStop Hook + Status File Rename

[26-subagent-stop-hook](26-subagent-stop-hook.md)

Add `SubagentStop` hook for immediate sub-agent completion detection (replaces 45s mtime polling). Rename `ccmon-status.json` → `ccmon-status.json`. Add per-sub-agent status files alongside JSONL.

### ✅ 27 Phase: Append-Only Status Log

[27-append-only-status](27-append-only-status.md)

Replace single-write `ccmon-status.json` with append-only `ccmon-status.jsonl` event log to fix PermissionRequest race with concurrent sub-agents. Simplifies resolveState, removes STOP_GRACE_MS and RUNNING_HOOK_TTL_MS.

### ✅ 28 Phase: Waiting State Resolution Fix

[28-waiting-state-fix](28-waiting-state-fix.md)

Fix `waiting_for_permission` persisting after user clicks "Allow". PostToolUse from the same session_id as the PermissionRequest resolves the waiting state; sub-agent PostToolUse (different session_id) does not.

### ✅ 29 Phase: Click-to-Dismiss Waiting Flash

[29-waiting-dismiss](29-waiting-dismiss.md)

Click on a flashing waiting card to acknowledge and stop the animation. State badge remains "Waiting". Flash re-triggers if a new PermissionRequest arrives after the state cycles.

### ✅ 30 Phase: Inbox Fixes

[30-inbox-fixes](30-inbox-fixes.md)

Two inbox bugs: (1) stale state after WS reconnect — clear projects on disconnect. (2) Sub-agent names showing raw agentId — parse `Task` tool_use/toolUseResult for description correlation, fall back to slug.

### ✅ 31 Phase: Watcher Resilience

[31-watcher-resilience](31-watcher-resilience.md)

Fix silent watcher death causing frozen server state. Add restart-on-error with exponential backoff, and periodic safety broadcast (30s) as fallback.

### ✅ 32 Phase: Sleep/Wake WS Reconnect

[32-sleep-reconnect](32-sleep-reconnect.md)

Fix Safari not reconnecting WS after laptop sleep. Add visibilitychange handler for immediate reconnect on wake, plus last-message heartbeat for zombie socket detection.

### ✅ 33 Phase: Project Name Disambiguation

[33-project-name-disambiguation](33-project-name-disambiguation.md)

Disambiguate projects sharing the same leaf directory name by expanding `projectName` directly with parent path segments until unique. No separate displayName field.

### ✅ 34 Phase: Sub-Agent Timing Reduction

[34-subagent-timing](34-subagent-timing.md)

Reduce sub-agent active threshold (45s→15s) and expiry (5min→30s) so completed agents vanish from dashboard faster.

### ✅ 35 Phase: Session Closed State + Fast Removal

[35-stopped-project-removal](35-stopped-project-removal.md)

New `closed` state for SessionEnd events. Closed projects removed from dashboard after 1 minute (vs `maxInactivityHours` for idle/stopped). Grey "Closed" badge in UI.

### ✅ 45 Phase: Review Fixes — OpenCode Support
[45-review-fixes](45-review-fixes.md)

Address 18 REVIEW comments from 4 review agents (style, correctness, architecture, requirements) planted during Phase 44. 3 release-blocking, 5 high, 5 medium, 5 low priority fixes across 8 files. All 18 tasks complete.

### ✅ 51 Phase: Review Fixes 4
[51-review-fixes-4](51-review-fixes-4.md)

Address 19 REVIEW comments from 4 review agents. 2 critical (R63 regression — project name disambiguation missing from all production output paths), 14 medium, 3 low. 7 files affected.

### ✅ 52 Phase: OpenCode State Detection Fix
[52-opencode-state-detection](52-opencode-state-detection.md)

Fix OpenCode projects showing "stopped" when sub-agents are actively running. Root cause: `resolveState` only checks parent `session.time_updated` but sub-agent activity updates child `session` rows. Fix adds child session activity check to `resolveState` and corrects `lastUpdated` to reflect most recent activity across parent and children.

### ✅ 53 Phase: Server Staleness Fix
[53-server-staleness-fix](53-server-staleness-fix.md)

Fix server `stateMap` freezing when backend change detection mechanisms fail. R61 "periodic safety broadcast" only re-sends frozen state — change 30s interval to actually re-scan from disk.

### ✅ 54 Phase: OpenCode Sub-Agent Detection Hardening
[54-opencode-subagent-harden](54-opencode-subagent-harden.md)

Investigate and harden OpenCode sub-agent detection. Add debug logging to diagnose edge cases. Add fallback child session query as safety net when `parent_id` linkage has edge cases.

### ✅ 55 Phase: Migrate from Bun to Node.js

[55-migrate-to-node](55-migrate-to-node.md)

Replace Bun runtime with Node.js 22 LTS (native TS via Amaro). Replace Bun.file/write → node:fs, Bun.serve → http+ws, bun:sqlite → better-sqlite3, bun:test → vitest. Delete env.ts sandbox workaround. Update flake.nix, CI, dependabot, lockfile. 13 tasks.

### ✅ 56 Phase: OpenCode Plugin for Hook-Like Status Updates

[56-opencode-plugin](56-opencode-plugin.md)

Implement an OpenCode plugin that writes ccmon status events on session lifecycle changes (idle→stopped, error→error, permission→waiting, etc.), mirroring Claude Code hook behavior. Extend OpencodeBackend to read plugin-written status as primary state source with fs.watch for near-instant updates. Falls back to timestamp inference when plugin not installed.

### ✅ 57 Phase: Architecture Refactor

[57-architecture-refactor](57-architecture-refactor.md)

Split 849-line sessions.ts into 5 focused modules (types, project-utils, status-writer, session-core, session-enrichment). Absorbed SessionStore into ClaudeBackend, removing singleton pattern and free-function wrappers. Extracted buildProjectState from SessionBackend interface into standalone shared utility. Created collectBackendStates to deduplicate server.ts/cli.ts cross-file logic. 12 new ClaudeBackend unit tests. 303 tests pass.

## Files

- **docs/features/2026-02-18-ccmon/**: Project documentation
- **docs/features/2026-02-18-ccmon/55-migrate-to-node.md**: Phase 55 plan — Bun → Node.js migration (Phase: Migrate to Node.js)
- **docs/features/2026-02-18-ccmon/56-opencode-plugin.md**: Phase 56 plan — OpenCode plugin for hook-like status updates via event subscription + fs.watch (Phase: OpenCode Plugin)
- **CLAUDE.md**: Development instructions; trimmed to 57 lines — commands table, architecture overview, key files (Phase: Session Detection, Packaging, Review Fixes, Linting Setup, StopFailure Hook, Migrate to Node.js, OpenCode Plugin, CLAUDE.md Trim)
- **README.md**: Install guide, Node.js prerequisite, hook config, commands reference (Phase: Packaging, Migrate to Node.js)
- **flake.nix**: Nix devShell + packages/apps outputs for ccmon; nodejs_22 wrapper (Phase: Session Detection, Packaging, Migrate to Node.js)
- **.envrc**: direnv config — `use flake` (Phase: Session Detection)
- **.gitignore**: Excludes `.direnv/` and `*.local.log` (Phase: Session Detection)
- **package.json**: Node.js project config — `"type": "module"`, `@types/better-sqlite3`, `@types/ws`, `dump` script; `test`, `lint`, `lint:fix`, `typecheck` scripts; Biome + TypeScript + vitest devDeps; better-sqlite3 + ws deps (Phase: Session Detection, Linting Setup, Migrate to Node.js)
- **package-lock.json**: npm lockfile (Phase: Migrate to Node.js)
- **tsconfig.json**: IDE TypeScript support — ESNext, strict (Phase: Session Detection, Migrate to Node.js)
- **biome.json**: Biome linter + formatter config — 2-space indent, recommended rules (Phase: Linting Setup)
- **.github/workflows/ci.yml**: GHA CI workflow — lint + typecheck + test on push and pull_request; Node.js 22 + npm (Phase: GitHub Actions CI, Migrate to Node.js)
- **.github/dependabot.yml**: Dependabot config — npm ecosystem, daily checks, 7-day release cooldown (Phase: Dependabot Setup, Migrate to Node.js)
- **public/index.html**: Single-page dashboard — dark theme, CSS grid, vanilla JS WebSocket client; R51-R55 card rework: context bar, unified agent rows, pulsing dots; R45-R50 features retained; permission/stopped/notification flash animations; JSON.parse try/catch, numeric esc(); `BackendManager` multi-WS, `mergeAndRender()`, aggregate status pill, settings dropdown; `lastMessageAt` heartbeat tracking + zombie detection (>60s no message); `visibilitychange` handler force-reconnects all backends on wake; `.card-pills` container groups source + status badges at right edge (Phase: Web UI, UI Enhancements, UI Polish, Dashboard Refinements, Review Fixes, Card Rework, Multi-Backend, Sleep/Wake WS Reconnect, StopFailure Hook, Card Height Cap, Backend Pill Alignment)
- **docs/features/2026-02-18-ccmon/47-backend-pill-alignment.md**: Phase 47 plan — backend pill right-alignment in card header (Phase: Backend Pill Alignment)
- **docs/features/2026-02-18-ccmon/48-opencode-session-dedup.md**: Phase 48 plan — deduplicate OpenCode sessions per directory via SQL `MAX(time_updated)` (Phase: OpenCode Session Deduplication)
- **docs/features/2026-02-18-ccmon/49-review-fixes-3.md**: Phase 49 plan — 21 REVIEW comment fixes (4 high, 7 medium, 8 low) across 9 files; 2 items deferred (Phase: Review Fixes 3)
- **docs/features/2026-02-18-ccmon/50-session-store.md**: Phase 50 plan — SessionStore class (cache extraction) + enrichment module split (~320 lines) (Phase: SessionStore + Module Split)
- **docs/features/2026-02-18-ccmon/51-review-fixes-4.md**: Phase 51 plan — 19 REVIEW comment fixes (2 critical, 14 medium, 3 low) across 7 files (Phase: Review Fixes 4)
- **docs/features/2026-02-18-ccmon/52-opencode-state-detection.md**: Phase 52 plan — fix OpenCode state detection when sub-agents are active; child session activity consideration in resolveState + lastUpdated (Phase: OpenCode State Detection Fix)
- **docs/features/2026-02-18-ccmon/53-server-staleness-fix.md**: Phase 53 plan — fix server stateMap freezing; change periodic interval to rescan from disk (Phase: Server Staleness Fix)
- **docs/features/2026-02-18-ccmon/54-opencode-subagent-harden.md**: Phase 54 plan — investigation + hardening OpenCode sub-agent detection; debug logging + fallback child query (Phase: OpenCode Sub-Agent Detection Hardening)
- **src/config.ts**: Config loading, validation, defaults, CLI override merge — host, port, maxInactivityHours; isCcmonConfig type predicate fixed; `homedir()` replaces `process.env.HOME` fallback (Phase: Backend, Review Fixes, Home Resolution Fix)
- **src/sessions.ts**: Barrel re-exports from all session modules — session-core, session-enrichment, types, project-utils, status-writer (Phase: Architecture Refactor)
- **src/types.ts**: Shared types — `ProjectInfo`, `ProjectState`, `SubagentInfo`, `BackendSource` (Phase: Architecture Refactor)
- **src/session-core.ts**: Status log reading and state resolution — `SessionState`, `StatusEvent`, `resolveState`, `readStatusLog` (Phase: Architecture Refactor)
- **src/session-enrichment.ts**: JSONL tail parsing for model/messages/tokens/tasks — `SessionEnrichment`, `scanEnrichment`, `mergeEnrichment` (Phase: SessionStore + Module Split, Architecture Refactor)
- **src/project-utils.ts**: Project scanning and filtering — `scanProjects`, `filterStaleProjects`, `disambiguateProjectNames`, JSONL helpers (Phase: Architecture Refactor)
- **src/status-writer.ts**: Hook status file writing — `writeStatusEvent`, `writeNotificationStatus`, `mapHookEventToState` (Phase: Architecture Refactor)
- **src/backends/claude.ts**: Claude Code backend — filesystem/JSONL source, absorbed SessionStore with readSessionTail, getSubagentInfos, buildProjectState (Phase: Architecture Refactor)
- **src/backends/opencode.ts**: OpenCode backend — SQLite read-only with plugin status log integration (Phase: Architecture Refactor)
- **src/backends/types.ts**: `SessionBackend` interface (6 focused methods) + `BackendConfigEntry` type (Phase: Architecture Refactor)
- **src/backends/build-project-state.ts**: Shared `buildProjectState(backend, info)` utility (Phase: Architecture Refactor)
- **src/backends/collect-states.ts**: Shared `collectBackendStates(backends)` utility for server/CLI (Phase: Architecture Refactor)
- **src/backends/index.ts**: `createBackends(config)` factory (Phase: Architecture Refactor)
- **src/server.ts**: HTTP + WebSocket server; uses `collectBackendStates` + standalone `buildProjectState` (Phase: Architecture Refactor)
- **src/cli.ts**: CLI entry point; imports from final modules — project-utils, status-writer, session-core (Phase: Architecture Refactor)
- **src/watcher.ts**: File watcher — `watchForChanges()` with debounce and new-project detection; section banner removed; exponential backoff restart-on-error for both watchers (Phase: Session Detection, Review Fixes, Watcher Resilience)
- **tests/backends/claude.test.ts**: ClaudeBackend unit tests — scanProjects, resolveState, enrichProject, getSubagents, buildProjectState, projectKey, targeted refresh (Phase: Architecture Refactor)
- **tests/backends/opencode.test.ts**: OpencodeBackend unit tests — scanProjects, buildProjectState, resolveState with plugin priority, sub-agent detection (Phase: OpenCode Plugin, Architecture Refactor)
- **src/env.ts**: Deleted — Bun sandbox workaround no longer needed with Node.js (Phase: Home Resolution Fix, Migrate to Node.js)
- **src/server.ts**: Node.js HTTP + WebSocket server (http.createServer + ws) — `/`, `/api/state`, `/ws` endpoints; HTML read at module init; WS payload wrapped in `{ hostname, projects }` envelope; `Cache-Control: no-cache` on HTML response; periodic 30s safety rescan + broadcast; `fileURLToPath(import.meta.url)` replaces `import.meta.dir` (Phase: Backend, Review Fixes, Multi-Backend, Watcher Resilience, Server Staleness Fix, Migrate to Node.js)
- **docs/features/2026-02-18-ccmon/07-qa-pass.md**: Phase 07 plan — last activity refresh, state persistence, token usage (Phase: QA Pass)
- **tests/sessions.test.ts**: 202 unit tests for sessions.ts; vitest imports; readFileSync/writeFileSync test I/O (Phase: Session Detection, Backend, UI Enhancements, Sub-Agent Names, UI Polish, Dashboard Refinements, Review Fixes, Review Fixes 2, Stop Detection Fix, Inbox Bug Fixes, Append-Only Status Log, StopFailure Hook, Migrate to Node.js)
- **tests/watcher.test.ts**: Unit tests for watcher.ts; backoff formula + restart-on-error tests; vitest vi.fn() replaces bun mock (Phase: Session Detection, Watcher Resilience, Migrate to Node.js)
- **tests/cli.test.ts**: CLI tests — arg-validation, status NDJSON format, dump --watch, --project filter; spawnSync replaces Bun.spawn; fileURLToPath replaces import.meta.dir; vitest imports (Phase: Review Fixes, Append-Only Status Log, Migrate to Node.js)
- **tests/server.test.ts**: Tests for server.ts — HTTP endpoints, WebSocket, WS envelope + hostname field, periodic broadcast; vitest imports (Phase: Backend, Multi-Backend, Watcher Resilience, Migrate to Node.js)
- **~/dotfiles/home-manager/modules/claude/settings.json**: Hook config with ccmon commands (Phase: Backend)
- **docs/features/2026-02-18-ccmon/44-opencode-support.md**: Phase 44 plan — multi-backend abstraction, OpenCode SQLite backend; R72.2 updated to "both backends enabled" (Phase: OpenCode Support)
- **src/backends/opencode.ts**: `OpencodeBackend` — better-sqlite3 session scanning, enrichment, sub-agents, polling; scanProjects deduplicates by directory; resolveState child activity check + fallback directory scan; status log reading (`resolveStateFromStatusLog`), fs.watch on status log directory, dual-mode polling (Phase: OpenCode Support, OpenCode Session Deduplication, OpenCode State Detection Fix, OpenCode Sub-Agent Hardening, Migrate to Node.js, OpenCode Plugin)
- **src/backends/types.ts**: Backend type definitions + `BackendConfigEntry`; added `statusLogPath` + `statusPollIntervalMs` to opencode variant (Phase: OpenCode Support, Migrate to Node.js, OpenCode Plugin)
- **src/backends/index.ts**: Backend factory — creates ClaudeBackend + OpencodeBackend from config; better-sqlite3 setup; passes statusLogPath + statusPollIntervalMs to OpencodeBackend (Phase: OpenCode Support, Migrate to Node.js, OpenCode Plugin)
- **tests/backends/opencode.test.ts**: OpenCode backend tests with in-memory better-sqlite3; 53 tests total — 39 polling, 7 status log resolution, 7 dual-mode fs.watch+polling (Phase: OpenCode Support, OpenCode Session Deduplication, OpenCode State Detection Fix, Migrate to Node.js, OpenCode Plugin, OpenCode Plugin Dual-Mode Tests)
- **tests/integration.test.ts**: 4 integration tests verifying both backends coexist; better-sqlite3 type (Phase: OpenCode Support, Migrate to Node.js)
- **docs/features/2026-02-18-ccmon/45-review-fixes.md**: Phase 45 plan — 18 REVIEW comment fixes (3 release-blocking, 5 high, 5 medium, 5 low) across 8 files (Phase: Review Fixes)
- **resources/opencode-plugin/ccmon.ts**: OpenCode plugin — event subscription + status NDJSON writing (Phase: OpenCode Plugin)
- **src/session-core.ts**: Extracted resolveState, readStatusLog, shared types from sessions.ts; readFileSync replaces Bun.file (Phase: Review Fixes, Migrate to Node.js)
- **tests/_helpers.ts**: Shared makeTempDir utility; process.env replaces Bun.env (Phase: Review Fixes, Migrate to Node.js)
