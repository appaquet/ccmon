# ccmon

Claude Code Monitor - a Bun + TypeScript web app that shows the status of currently running Claude Code instances.

## Context

A lightweight monitoring dashboard that reads Claude Code session data and hook-reported state to show a real-time view of all Claude sessions across projects on this machine.

Hooks already exist via `claude-tmux-indicator` (in `~/dotfiles`). ccmon will extend that script to also write `status.local.json` to each project's working directory.

## Checkpoint

Phases 23, 24, 25 implemented. Phase 23: `▶`/`◀` triangles. Phase 24: time-based sort with 30s throttle. Phase 25: stopped flash persistence (5s TTL Maps). 198 tests pass, lint + typecheck clean. All pending visual verification.

## Requirements

### Session Detection

- R1: ✅ Enumerate all Claude Code projects by scanning `~/.claude/projects/` (Phase: Session Detection)
  - R1.1: Working directory read from `cwd` field in first line of most recent JSONL session file (directory name encoding is lossy)
  - R1.2: Project name derived from last path segment of working directory (e.g. `ccmon`)
- R2: ✅ Determine current state of each project via layered detection (Phase: Session Detection)
  - R2.1: Primary: read `status.local.json` (written by hooks). If absent or stale (>5min, state !== `stopped`) → treat as `stopped`
  - R2.2: Fallback: `pgrep -a claude` + `/proc/{pid}/cwd` (NixOS: `.claude-wrapped`) to detect live processes. If no process and status not `stopped` → override to `stopped`

### State Reporting via Hooks

- R3: 🔄 `ccmon status` sub-command writes `status.local.json` from hook stdin (Phase: Backend)
  - R3.1: Hook events → states:
    - `UserPromptSubmit` → `running` (Claude processing user input)
    - `PostToolUse` → `running` (Claude continuing after tool)
    - `PermissionRequest` → `waiting_for_permission`
    - `Stop` → `stopped` (Claude idle, matches tmux indicator behavior)
    - `SessionEnd` → `stopped`
  - R3.2: `status.local.json` contains: `state`, `timestamp`, `session_id`, `working_dir`
  - R3.3: File written to `~/.claude/projects/{dir}/status.local.json` (project dir found via `sessions-index.json` lookup or path encoding fallback)
  - R3.4: Reads hook JSON from stdin (cwd, session_id, hook_event_name), maps event to state, resolves cwd to project dir
- R14: 🔄 Use `sessions-index.json` as primary data source for project scanning (Phase: Backend)
  - R14.1: `sessions-index.json` contains `originalPath`, session entries with `summary`, `messageCount`, `firstPrompt`, `isSidechain`, `fullPath`, `fileMtime`, `gitBranch`
  - R14.2: Fall back to JSONL first-line parse when `sessions-index.json` is absent (not all project dirs have it)
  - R14.3: Extend `ProjectInfo` with optional fields: `summary`, `firstPrompt`, `messageCount`, `sessionModified`
  - R14.4: Filter out `isSidechain: true` entries
- R4: 🔄 Hook config adds `ccmon status` alongside existing `claude-tmux-indicator` in `~/dotfiles/home-manager/modules/claude/settings.json` (Phase: Backend)
  - R4.1: Both hooks run in same matcher group (parallel stdin copies)
  - R4.2: `claude-tmux-indicator` remains independent — ccmon hooks alongside it, does not extend it

### Web Server

- R5: 🔄 Bun HTTP server serves the dashboard at `/` (Phase: Backend)
- R6: 🔄 WebSocket endpoint pushes real-time state updates to connected clients (Phase: Backend)
  - R6.1: Server watches all known `status.local.json` files for changes and broadcasts updates
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

- R34: 🔄 JSONL mtime is the primary signal for running state; hooks retained for immediate stopped detection (Phase: JSONL-Primary Detection, Stop Detection Fix)
  - R34.1: Watcher monitors *.jsonl files in project dirs; `running` derived from JSONL mtime < 60s
  - R34.2: `stopped` from Stop/SessionEnd hooks (immediate) or JSONL mtime > 60s (crash fallback)
  - R34.6: 5s grace period on JSONL-vs-stopped comparison — Claude writes post-stop system entry to JSONL, making mtime slightly newer than hook timestamp
  - R34.7: JSONL activity after `waiting_for_permission` overrides the permission state (permission was answered)
  - R34.3: status.local.json read for waiting_for_permission, stopped timestamp, and notification fields
  - R34.4: pgrep/proc liveness detection removed entirely
  - R34.5: R33 debounce removed — race condition eliminated at source
- R35: 🔄 Hook config — UserPromptSubmit/PostToolUse re-added for immediate running detection (Phase: JSONL-Primary Detection, Inbox Bug Fixes)
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

- R56: 🔄 Dashboard supports connecting to multiple ccmon server backends simultaneously (Phase: Multi-Backend)
  - R56.1: Server WS messages use `{ hostname, projects }` envelope instead of raw `ProjectState[]`
  - R56.2: Frontend manages N backend connections with independent reconnect logic per backend
  - R56.3: Frontend handles legacy servers that send raw arrays (backward compat)
  - R56.4: Additional server URLs persisted in localStorage and restored on page load
- R57: 🔄 Connection status and server management UI (Phase: Multi-Backend)
  - R57.1: Projects from all connected backends merged into a single grid
  - R57.2: Status pill: Connected (all up) / Partially connected (some up) / Disconnected (none up)
  - R57.3: Cog icon + clickable pill open server management menu; add/remove servers; main server cannot be removed

- R58: 🔄 Same-named projects across backends are disambiguated with composite key and hostname prefix (Phase: Multi-Backend Naming)
  - R58.1: Card header shows `hostname:projectName` when the same `projectName` exists on multiple backends

#### Out of Scope

- Authentication / multi-user support
- Historical session data / logs
- Multiple sessions per project (show latest only)

## Questions

- Q1: ✅ Status file location → per-project in working directory as `status.local.json` (same as `tmux.local.log`)
- Q2: ✅ Permission hook event → `PermissionRequest` (confirmed from existing settings.json)
- Q3: ✅ Runtime/package manager → Bun (native TypeScript, ESM, built-in test runner `bun:test`). No tsconfig required but will add for IDE support. Types via `@types/bun`.
- Q4: ✅ How does ccmon discover the working directory? → Read `cwd` from the first line of the most recent JSONL session file. Directory name encoding is lossy (hyphens ambiguous), so dir name decoding is not reliable.
- Q5: ✅ Path encoding no longer primary concern. `sessions-index.json` provides `originalPath` for lookup. Fall back to `/` → `-` encoding only when index is absent. Verified empirically: encoding matches observed dirs.

## Phases

### ✅ 01 Phase: Session Detection

[01-session-detection](01-session-detection.md)

Logic to scan `~/.claude/projects/` and map directories to project metadata. All 8 steps complete, 24 tests passing. `lastUpdated` falls back to JSONL file mtime.

### 🔄 02 Phase: Backend

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

### 🔄 15 Phase: Stop Detection Fix

[15-stop-detection-fix](15-stop-detection-fix.md)

Fix stop detection race: Claude writes post-stop `system` entry to JSONL (8ms after hook), making JSONL mtime slightly newer than stopped timestamp. Add 5s grace period to `resolveState()` comparison (R34.6).

### ✅ 16 Phase: Inbox Bug Fixes

[16-inbox-bug-fixes](16-inbox-bug-fixes.md)

Three bugs: task completions not reflected in WebSocket/sub (delta reads drop TaskUpdate for prior tasks), `waiting_for_permission` sticking after answering (resolveState Priority 1 blocks JSONL mtime), hook config safety verification (already safe, adding tests).

### ✅ 17 Phase: Sub-Agent Stop/Resume Fix

[17-subagent-stop-resume](17-subagent-stop-resume.md)

After session stops and resumes (same UUID), old sub-agents can appear active because `getSubagentInfos()` uses 45s mtime threshold with no awareness of session stop events. Fix: pass `stoppedAtMs` into sub-agent detection.

### 🔄 18 Phase: Multi-Backend WebSocket

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

### 🔄 22 Phase: Multi-Backend Project Naming

[22-multi-backend-naming](22-multi-backend-naming.md)

Fix same-named projects across backends causing double flash. Use composite `hostname::projectName` key in frontend state maps. Show hostname prefix in card header when names collide.

### ⬜ 25 Phase: Stopped Flash Fix

[25-stopped-flash-fix](25-stopped-flash-fix.md)

Fix stopped flash persistence: promote `flashStopped`/`flashNotification` to module-level Maps with 5s TTL. Broaden transition check to any non-stopped → stopped.

### ⬜ 24 Phase: Dashboard Sort Order

[24-dashboard-sort-order](24-dashboard-sort-order.md)

Sort dashboard projects by most recently active (`lastUpdated` descending) instead of alphabetically. Throttle re-sorting to every 30s to prevent constant card reordering.

### ⬜ 23 Phase: UI Triangle Arrows

[23-ui-triangle-arrows](23-ui-triangle-arrows.md)

Replace ASCII `>` / `<` message direction indicators with UTF-8 solid triangles (`▶` / `◀`) in dashboard cards.

## Files

- **docs/features/2026-02-18-ccmon/**: Project documentation
- **CLAUDE.md**: Development instructions; integration check section; lint/typecheck command docs; sub --host flag doc (Phase: Session Detection, Packaging, Review Fixes, Linting Setup)
- **README.md**: Install guide, hook config, commands reference (Phase: Packaging)
- **flake.nix**: Nix devShell + packages/apps outputs for ccmon (Phase: Session Detection, Packaging)
- **.envrc**: direnv config — `use flake` (Phase: Session Detection)
- **.gitignore**: Excludes `.direnv/` and `*.local.log` (Phase: Session Detection)
- **package.json**: Bun project config — `"type": "module"`, `@types/bun`, `dump` script; `test`, `lint`, `lint:fix`, `typecheck` scripts; Biome + TypeScript devDeps (Phase: Session Detection, Linting Setup)
- **tsconfig.json**: IDE TypeScript support — ESNext, moduleResolution bundler (Phase: Session Detection)
- **bun.lock**: Bun lockfile (Phase: Session Detection, Linting Setup)
- **biome.json**: Biome linter + formatter config — 2-space indent, recommended rules (Phase: Linting Setup)
- **.github/workflows/ci.yml**: GHA CI workflow — lint + typecheck + test on push and pull_request (Phase: GitHub Actions CI)
- **public/index.html**: Single-page dashboard — dark theme, CSS grid, vanilla JS WebSocket client; R51-R55 card rework: context bar, unified agent rows, pulsing dots; R45-R50 features retained; permission/stopped/notification flash animations; JSON.parse try/catch, numeric esc(); `BackendManager` multi-WS, `mergeAndRender()`, aggregate status pill, settings dropdown (Phase: Web UI, UI Enhancements, UI Polish, Dashboard Refinements, Review Fixes, Card Rework, Multi-Backend)
- **src/config.ts**: Config loading, validation, defaults, CLI override merge — host, port, maxInactivityHours; isCcmonConfig type predicate fixed (Phase: Backend, Review Fixes)
- **src/sessions.ts**: Core session logic — `scanProjects()`, `readStatus()`, `checkLiveness()`, `getProjectState()`, `readSessionsIndex()`, `mapHookEventToState()`, `writeStatus()`, `filterStaleProjects()`; `latestUserActivity`, `latestAssistantActivity`, `lastMessageTime`, `launchTime`, `tasks[]`; last-value input tokens; sub-agent 5m expiry; sub-agent descriptions from queue-operation; readSessionTail refactored into helpers; readFirstLine 4096-byte slice; stale-index disk fallback; `STOP_GRACE_MS` grace period in `resolveState()`; `scanTaskCreateUpdate` base tasks param for delta reads; `resolveState` permission override fix (Phase: Session Detection, Backend, UI Enhancements, Sub-Agent Names, UI Polish, Dashboard Refinements, Review Fixes, Stop Detection Fix, Inbox Bug Fixes)
- **src/watcher.ts**: File watcher — `watchForChanges()` with debounce and new-project detection; section banner removed (Phase: Session Detection, Review Fixes)
- **src/cli.ts**: CLI entry point — `dump`, `dump --watch`, `dump --project`, `status`, `serve` subcommands; arg validation errors, exit() helper, readStdin one-liner; `sub` parses new WS envelope with backward compat; `sub --host` flag; multi-line usage string (Phase: Session Detection, Backend, Review Fixes, Multi-Backend)
- **src/server.ts**: Bun HTTP + WebSocket server — `/`, `/api/state`, `/ws` endpoints; DEFAULT_CLAUDE_DIR imported from sessions.ts, HTML read at module init; WS payload wrapped in `{ hostname, projects }` envelope; `Cache-Control: no-cache` on HTML response (Phase: Backend, Review Fixes, Multi-Backend)
- **docs/features/2026-02-18-ccmon/07-qa-pass.md**: Phase 07 plan — last activity refresh, state persistence, token usage (Phase: QA Pass)
- **tests/sessions.test.ts**: 198 unit tests for sessions.ts (Phase: Session Detection, Backend, UI Enhancements, Sub-Agent Names, UI Polish, Dashboard Refinements, Review Fixes, Review Fixes 2, Stop Detection Fix, Inbox Bug Fixes)
- **tests/watcher.test.ts**: 3 unit tests for watcher.ts (Phase: Session Detection)
- **tests/cli.test.ts**: 18 tests for cli.ts — 4 new arg-validation cases, status, dump --watch, --project filter (Phase: Review Fixes)
- **tests/config.test.ts**: Config loading tests; 22+ tests covering partial config, invalid types (Phase: Review Fixes 2)
- **tests/server.test.ts**: 11 tests for server.ts — HTTP endpoints, WebSocket, WS envelope + hostname field (Phase: Backend, Multi-Backend)
- **~/dotfiles/home-manager/modules/claude/settings.json**: Hook config with ccmon commands (Phase: Backend)
- **docs/features/2026-02-18-ccmon/06-notifications-streaming.md**: Phase 06 plan — notifications, JSONL streaming, sub-agent consolidation (Phase: Notifications & Streaming)
