# ccmon

Claude Code Monitor - a Bun + TypeScript web app that shows the status of currently running Claude Code instances.

## Context

A lightweight monitoring dashboard that reads Claude Code session data and hook-reported state to show a real-time view of all Claude sessions across projects on this machine.

Hooks already exist via `claude-tmux-indicator` (in `~/dotfiles`). ccmon will extend that script to also write `status.local.json` to each project's working directory.

## Checkpoint

Phase 05 Steps 1-6 complete: 101 tests. R21 bugfix: `progress`-entry `TodoWrite` scanning fixed via `scanTodoWrite()` helper. R22/R23: flash animations. R24: `shortModel()` helper (Opus/Sonnet/Haiku display). R25: `pulse-dot` CSS animation on running badge dot.

Manual verification pending for R22/R23/R24/R25. R21 only covers `TodoWrite` sessions; `TaskCreate`/`TaskUpdate` full-parse support deferred.

## Requirements

### Session Detection

* R1: ✅ Enumerate all Claude Code projects by scanning `~/.claude/projects/` (Phase: Session Detection)
  * R1.1: Working directory read from `cwd` field in first line of most recent JSONL session file (directory name encoding is lossy)
  * R1.2: Project name derived from last path segment of working directory (e.g. `ccmon`)
* R2: ✅ Determine current state of each project via layered detection (Phase: Session Detection)
  * R2.1: Primary: read `status.local.json` (written by hooks). If absent or stale (>5min, state !== `stopped`) → treat as `stopped`
  * R2.2: Fallback: `pgrep -a claude` + `/proc/{pid}/cwd` (NixOS: `.claude-wrapped`) to detect live processes. If no process and status not `stopped` → override to `stopped`

### State Reporting via Hooks

* R3: 🔄 `ccmon status` sub-command writes `status.local.json` from hook stdin (Phase: Backend)
  * R3.1: Hook events → states:
    * `UserPromptSubmit` → `running` (Claude processing user input)
    * `PostToolUse` → `running` (Claude continuing after tool)
    * `PermissionRequest` → `waiting_for_permission`
    * `Stop` → `stopped` (Claude idle, matches tmux indicator behavior)
    * `SessionEnd` → `stopped`
  * R3.2: `status.local.json` contains: `state`, `timestamp`, `session_id`, `working_dir`
  * R3.3: File written to `~/.claude/projects/{dir}/status.local.json` (project dir found via `sessions-index.json` lookup or path encoding fallback)
  * R3.4: Reads hook JSON from stdin (cwd, session_id, hook_event_name), maps event to state, resolves cwd to project dir
* R14: 🔄 Use `sessions-index.json` as primary data source for project scanning (Phase: Backend)
  * R14.1: `sessions-index.json` contains `originalPath`, session entries with `summary`, `messageCount`, `firstPrompt`, `isSidechain`, `fullPath`, `fileMtime`, `gitBranch`
  * R14.2: Fall back to JSONL first-line parse when `sessions-index.json` is absent (not all project dirs have it)
  * R14.3: Extend `ProjectInfo` with optional fields: `summary`, `firstPrompt`, `messageCount`, `sessionModified`
  * R14.4: Filter out `isSidechain: true` entries
* R4: 🔄 Hook config adds `ccmon status` alongside existing `claude-tmux-indicator` in `~/dotfiles/home-manager/modules/claude/settings.json` (Phase: Backend)
  * R4.1: Both hooks run in same matcher group (parallel stdin copies)
  * R4.2: `claude-tmux-indicator` remains independent — ccmon hooks alongside it, does not extend it

### Web Server

* R5: 🔄 Bun HTTP server serves the dashboard at `/` (Phase: Backend)
* R6: 🔄 WebSocket endpoint pushes real-time state updates to connected clients (Phase: Backend)
  * R6.1: Server watches all known `status.local.json` files for changes and broadcasts updates
  * R6.2: On new client connect, send current state of all projects immediately

### UI

* R7: ✅ Single HTML page with vanilla JavaScript, no frameworks (Phase: Web UI)
* R8: ✅ Lists all detected projects, one entry per project directory in `~/.claude/projects/` (Phase: Web UI)
  * R8.1: Project name = last segment of working directory path
* R9: ✅ Each project shows: name, state with color/icon indicator (Phase: Web UI)
  * R9.1: States: `stopped` (orange), `running` (green), `waiting_for_permission` (red)
* R10: ✅ UI updates in real-time via WebSocket without page reload (Phase: Web UI)

### CLI

* R11: ✅ `ccmon dump` CLI command outputs full state of all projects as JSON to stdout (Phase: Session Detection)
  * R11.1: Serves as integration test and external introspection tool
* R13: ✅ `ccmon dump --watch` prints NDJSON state on change (Phase: Backend)
  * R13.1: Initial dump printed immediately, then watches for changes via `watchForChanges()`
  * R13.2: On each change: re-runs `getProjectState()`, prints JSON (no separator — NDJSON for jq piping)
  * R13.3: Exits cleanly on SIGINT (calls `watcher.stop()`)
  * R13.4: `--project <name>` filters by `projectName`, outputs single object instead of array

### Developer Experience

* R12: ✅ `CLAUDE.md` at project root with build/run/test instructions, improved across all phases (Phase: Session Detection)

### Packaging

* R15: ✅ Nix flake exposes ccmon as a package (Phase: Packaging)
  * R15.1: `writeShellScriptBin` wrapper calling `${pkgs.bun}/bin/bun run` on source in Nix store
  * R15.2: `packages.${system}.default` and `apps.${system}.default` outputs
  * R15.3: Bun pinned from nixpkgs (hermetic)
* R16: ✅ README with install and hook configuration instructions (Phase: Packaging)
  * R16.1: Personal/dotfiles audience — concise, assumes NixOS + home-manager
  * R16.2: Covers: flake input, adding to packages, hook configuration, available commands

* R17: ✅ `ccmon sub` CLI subcommand connects to running server via WebSocket, streams state updates as NDJSON (Phase: Backend)
  * R17.1: `--port N` flag (default 3000), exits on SIGINT or server disconnect
  * R17.2: Used for smoke-testing server stack and background monitoring
* R18: ✅ Config file system with stale project filter (Phase: Backend)
  * R18.1: `filterStaleProjects()` excludes projects with `lastUpdated` null or older than `maxInactivityHours` (default 3h)
  * R18.2: `dump` and `dump --watch` apply filter; `--max-age <hours>` and `--no-filter` CLI flags override config
  * R18.3: `serve` reads config and applies filter to all outputs (no CLI override for serve)
  * R18.4: Config at `$XDG_CONFIG_HOME/ccmon/config.json`; `CCMON_CONFIG` env var overrides path; silent defaults if missing
* R19: ✅ Session enrichment — richer `ProjectState` fields from JSONL tail parse (Phase: Backend)
  * R19.1: `gitBranch` from `sessions-index.json` (zero extra I/O)
  * R19.2: `subagentCount` — active sub-agent JSONL files (mtime < 45s) in `{sessionDir}/subagents/`
  * R19.3: `latestUserMessage`, `model`, `lastToolUse` from JSONL tail read (~64KB); only for non-stopped sessions
* R20: ✅ `getProjectState()` efficiency — caching and targeted refresh to reduce I/O on frequent calls (Phase: Backend)
  * R20.1: Sub-agent active threshold reduced 5min → 45s (avoids counting recently-finished agents)
  * R20.2: Liveness scan (`pgrep`/`/proc`) cached with 2-3s TTL
  * R20.3: `sessions-index.json` parse cached by file mtime
  * R20.4: `readSessionTail()` cached by JSONL file mtime
  * R20.5: Watcher passes changed `projectDir` → only that project is rescanned

### UI Enhancements

* R21: 🔄 Task count from JSONL — `tasksDone`/`tasksTotal` via `TodoWrite` entries; bugfix needed for `progress`-type entries (Phase: UI Enhancements)
* R22: 🔄 Flash card when state transitions to `waiting_for_permission` (Phase: UI Enhancements)
* R23: 🔄 Flash card for 5s when state transitions from `running` → `stopped` (Phase: UI Enhancements)
* R24: 🔄 Short model names in web UI — `Opus`/`Sonnet`/`Haiku` display only; JSON unchanged (Phase: UI Enhancements)
* R25: 🔄 Animate running state badge — pulsing dot on green pill (Phase: UI Enhancements)

#### Out of Scope

* Authentication / multi-user support
* Historical session data / logs
* Remote monitoring (local machine only)
* Multiple sessions per project (show latest only)

## Questions

* Q1: ✅ Status file location → per-project in working directory as `status.local.json` (same as `tmux.local.log`)
* Q2: ✅ Permission hook event → `PermissionRequest` (confirmed from existing settings.json)
* Q3: ✅ Runtime/package manager → Bun (native TypeScript, ESM, built-in test runner `bun:test`). No tsconfig required but will add for IDE support. Types via `@types/bun`.
* Q4: ✅ How does ccmon discover the working directory? → Read `cwd` from the first line of the most recent JSONL session file. Directory name encoding is lossy (hyphens ambiguous), so dir name decoding is not reliable.
* Q5: ✅ Path encoding no longer primary concern. `sessions-index.json` provides `originalPath` for lookup. Fall back to `/` → `-` encoding only when index is absent. Verified empirically: encoding matches observed dirs.

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

### 🔄 05 Phase: UI Enhancements
[05-ui-enhancements](05-ui-enhancements.md)

Task count detection from JSONL, permission flash, running→stopped flash animation. Implementation complete, manual verification pending.

## Files

- **docs/features/2026-02-18-ccmon/**: Project documentation
- **CLAUDE.md**: Development instructions, maintained across all phases (Phase: Session Detection, Packaging)
- **README.md**: Install guide, hook config, commands reference (Phase: Packaging)
- **flake.nix**: Nix devShell + packages/apps outputs for ccmon (Phase: Session Detection, Packaging)
- **.envrc**: direnv config — `use flake` (Phase: Session Detection)
- **.gitignore**: Excludes `.direnv/` and `*.local.log` (Phase: Session Detection)
- **package.json**: Bun project config — `"type": "module"`, `@types/bun`, `dump` script (Phase: Session Detection)
- **tsconfig.json**: IDE TypeScript support — ESNext, moduleResolution bundler (Phase: Session Detection)
- **bun.lock**: Bun lockfile (Phase: Session Detection)
- **public/index.html**: Single-page dashboard — dark theme, CSS grid, vanilla JS WebSocket client; task count display, permission flash, stopped flash animations (Phase: Web UI, UI Enhancements)
- **src/config.ts**: Config loading, validation, defaults, CLI override merge — host, port, maxInactivityHours (Phase: Backend)
- **src/sessions.ts**: Core session logic — `scanProjects()`, `readStatus()`, `checkLiveness()`, `getProjectState()`, `readSessionsIndex()`, `mapHookEventToState()`, `writeStatus()`, `filterStaleProjects()` (Phase: Session Detection, Backend, UI Enhancements)
- **src/watcher.ts**: File watcher — `watchForChanges()` with debounce and new-project detection (Phase: Session Detection)
- **src/cli.ts**: CLI entry point — `dump`, `dump --watch`, `dump --project`, `status`, `serve` subcommands (Phase: Session Detection, Backend)
- **src/server.ts**: Bun HTTP + WebSocket server — `/`, `/api/state`, `/ws` endpoints (Phase: Backend)
- **tests/sessions.test.ts**: 99 unit tests for sessions.ts (Phase: Session Detection, Backend, UI Enhancements)
- **tests/watcher.test.ts**: 3 unit tests for watcher.ts (Phase: Session Detection)
- **tests/cli.test.ts**: 14 tests for cli.ts — status, dump --watch, --project filter (Phase: Backend)
- **tests/server.test.ts**: 4 tests for server.ts — HTTP endpoints, WebSocket (Phase: Backend)
- **~/dotfiles/home-manager/modules/claude/settings.json**: Hook config with ccmon commands (Phase: Backend)
