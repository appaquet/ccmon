# ccmon

Claude Code Monitor - a Bun + TypeScript web app that shows the status of currently running Claude Code instances.

## Context

A lightweight monitoring dashboard that reads Claude Code session data and hook-reported state to show a real-time view of all Claude sessions across projects on this machine.

Hooks already exist via `claude-tmux-indicator` (in `~/dotfiles`). ccmon will extend that script to also write `status.local.json` to each project's working directory.

## Checkpoint

Phase 01 (Session Detection) implementation is complete. All 7 steps implemented via TDD: project setup (package.json, tsconfig.json, CLAUDE.md), `scanProjects()`, `readStatus()`, `checkLiveness()`, `getProjectState()`, CLI `dump` command, and `watchForChanges()`. 24 tests passing across `tests/sessions.test.ts` (21) and `tests/watcher.test.ts` (3). `bun run dump` outputs valid JSON with real project data.

Awaiting user validation of `bun run dump` output (Step 6 user validation task in phase doc). Next: user confirms Phase 01 acceptance, then proceed to Phase 02 (Backend — Bun HTTP/WebSocket server + hook extension).

## Requirements

### Session Detection

* R1: 🔄 Enumerate all Claude Code projects by scanning `~/.claude/projects/` (Phase: Session Detection)
  * R1.1: Working directory read from `cwd` field in first line of most recent JSONL session file (directory name encoding is lossy)
  * R1.2: Project name derived from last path segment of working directory (e.g. `ccmon`)
* R2: 🔄 Determine current state of each project via layered detection (Phase: Session Detection)
  * R2.1: Primary: read `status.local.json` (written by hooks). If absent or stale (>5min, state !== `stopped`) → treat as `stopped`
  * R2.2: Fallback: `pgrep -a claude` + `/proc/{pid}/cwd` (NixOS: `.claude-wrapped`) to detect live processes. If no process and status not `stopped` → override to `stopped`

### State Reporting via Hooks

* R3: ⬜ Extend `claude-tmux-indicator` to also write `status.local.json` in project working directory (Phase: Backend)
  * R3.1: Hook events → states:
    * `UserPromptSubmit` → `running` (Claude processing user input)
    * `PostToolUse` → `running` (Claude continuing after tool)
    * `PermissionRequest` → `waiting_for_permission`
    * `Stop` → `waiting_for_answer` (Claude idle, awaiting user)
    * `SessionEnd` → `stopped`
  * R3.2: `status.local.json` contains: `state`, `timestamp`, `session_id`, `working_dir`
  * R3.3: File written to `~/.claude/projects/{encoded}/status.local.json` (same project dir that contains JSONL session files)
* R4: ⬜ Hook changes go in `~/dotfiles/home-manager/modules/claude/settings.json` and the `claude-tmux-indicator` script (Phase: Backend)

### Web Server

* R5: ⬜ Bun HTTP server serves the dashboard at `/` (Phase: Backend)
* R6: ⬜ WebSocket endpoint pushes real-time state updates to connected clients (Phase: Backend)
  * R6.1: Server watches all known `status.local.json` files for changes and broadcasts updates
  * R6.2: On new client connect, send current state of all projects immediately

### UI

* R7: ⬜ Single HTML page with vanilla JavaScript, no frameworks (Phase: Web UI)
* R8: ⬜ Lists all detected projects, one entry per project directory in `~/.claude/projects/` (Phase: Web UI)
  * R8.1: Project name = last segment of working directory path
* R9: ⬜ Each project shows: name, state with color/icon indicator (Phase: Web UI)
  * R9.1: States: `stopped` (grey), `running` (green), `waiting_for_answer` (yellow), `waiting_for_permission` (red/orange)
* R10: ⬜ UI updates in real-time via WebSocket without page reload (Phase: Web UI)

### CLI

* R11: 🔄 `ccmon dump` CLI command outputs full state of all projects as JSON to stdout (Phase: Session Detection)
  * R11.1: Serves as integration test and external introspection tool

### Developer Experience

* R12: 🔄 `CLAUDE.md` at project root with build/run/test instructions, improved across all phases (Phase: Session Detection)

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

## Phases

### 🔄 01 Phase: Session Detection
[01-session-detection](01-session-detection.md)

Logic to scan `~/.claude/projects/` and map directories to project metadata. Determines which projects exist and their working directories. All 7 implementation steps complete, 24 tests passing. Awaiting user validation.

### ⬜ 02 Phase: Backend
[02-backend](02-backend.md)

Bun HTTP + WebSocket server. Extends `claude-tmux-indicator` to write `status.local.json`. Server watches for changes and broadcasts to clients.

### ⬜ 03 Phase: Web UI
[03-web-ui](03-web-ui.md)

Single-page vanilla JS UI. Connects via WebSocket, renders project list, updates in real-time.

## Files

- **docs/features/2026-02-18-ccmon/**: Project documentation
- **CLAUDE.md**: Development instructions, maintained across all phases (Phase: Session Detection)
- **README.md**: Project overview
- **flake.nix**: Nix devShell with Bun (Phase: Session Detection)
- **.envrc**: direnv config — `use flake` (Phase: Session Detection)
- **.gitignore**: Excludes `.direnv/` and `*.local.log` (Phase: Session Detection)
- **package.json**: Bun project config — `"type": "module"`, `@types/bun`, `dump` script (Phase: Session Detection)
- **tsconfig.json**: IDE TypeScript support — ESNext, moduleResolution bundler (Phase: Session Detection)
- **bun.lock**: Bun lockfile (Phase: Session Detection)
- **src/sessions.ts**: Core session logic — `scanProjects()`, `readStatus()`, `checkLiveness()`, `getProjectState()` (Phase: Session Detection)
- **src/watcher.ts**: File watcher — `watchForChanges()` with debounce and new-project detection (Phase: Session Detection)
- **src/cli.ts**: CLI entry point — `dump` subcommand outputs JSON state to stdout (Phase: Session Detection)
- **tests/sessions.test.ts**: 21 unit tests for sessions.ts (Phase: Session Detection)
- **tests/watcher.test.ts**: 3 unit tests for watcher.ts (Phase: Session Detection)
