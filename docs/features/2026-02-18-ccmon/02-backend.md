# Phase: Backend

## Context

See [00-ccmon](00-ccmon.md). Refactors session detection to use `sessions-index.json` as primary data source (richer data, fewer I/O ops), adds `ccmon status` sub-command for hook integration, `dump --watch` for console monitoring, and Bun HTTP + WebSocket server.

Phase 01 (Session Detection) is complete: `scanProjects()`, `readStatus()`, `checkLiveness()`, `getProjectState()`, `watchForChanges()`, and `dump` CLI are all working with 24 tests.

### Key Design Decisions

- `sessions-index.json` in each `~/.claude/projects/{dir}/` contains `originalPath`, session entries with `summary`, `messageCount`, `firstPrompt`, `isSidechain`, `fullPath`, `fileMtime`, `gitBranch`. Use as primary source, keep JSONL first-line parse as fallback (not all project dirs have the index file — only ~6/9 observed)
- `ccmon status` is a standalone sub-command that hooks call via stdin. `claude-tmux-indicator` remains independent — ccmon hooks alongside it in the same matcher groups
- `writeStatus()` uses a lookup map from scanned project dirs (no `encodeCwd()` needed — `scanProjects()` already knows the mapping from dir name → `originalPath`)

## Tasks

### Step 1: Refactor `scanProjects()` to use `sessions-index.json` — TDD

* [x] Write test for `readSessionsIndex()` in `tests/sessions.test.ts`
  * Test: valid `sessions-index.json` → returns `{ originalPath, entries[] }` with parsed fields
  * Test: missing file → returns `null`
  * Test: corrupt JSON → returns `null`
  * Test: picks entry with max `fileMtime` as latest session
  * Test: filters out `isSidechain: true` entries
* [x] Implement `readSessionsIndex(projectDirPath: string)` in `src/sessions.ts`
  * Read and parse `sessions-index.json`
  * Return `originalPath` + entries array (validated)
* [x] Refactor `scanProjects()` to try `sessions-index.json` first, fall back to JSONL scan
  * Primary: read index → use `originalPath` as cwd, latest entry's `sessionId`, `fullPath` as latestJSONL
  * Fallback: existing JSONL first-line parse (unchanged)
* [x] Extend `ProjectInfo` with optional fields from index:
  * `summary?: string` — AI-generated session summary
  * `firstPrompt?: string` — what user was working on
  * `messageCount?: number` — session depth
  * `sessionModified?: string` — ISO timestamp from index entry
* [x] Update existing `scanProjects` tests for new fields (backward-compatible: JSONL fallback still works)
* [x] Verify: `bun test` passes, `bun run dump` outputs enriched data

### Step 2: `mapHookEventToState()` — TDD

* [x] Write test for `mapHookEventToState()` in `tests/sessions.test.ts` (R3.1)
  * Test: all 5 events map correctly
  * Test: unknown event returns `null`
* [x] Implement `mapHookEventToState()` in `src/sessions.ts`
* [x] Verify: `bun test` passes

### Step 3: `writeStatus()` — TDD

* [x] Write test for `writeStatus()` in `tests/sessions.test.ts` (R3.2, R3.3)
  * Test: writes correct `status.local.json` matching `StatusFile` schema to temp dir
  * Test: round-trip — `writeStatus()` output is parseable by existing `readStatus()`
* [x] Implement `writeStatus(projectDirPath: string, status: StatusFile)` in `src/sessions.ts`
  * Writes to `{projectDirPath}/status.local.json`
  * No encoding needed — caller provides the full path (from scanProjects lookup or stdin cwd mapping)
* [x] Verify: `bun test` passes

### Step 4: `ccmon status` sub-command — TDD

* [x] Write test for `status` sub-command in `tests/cli.test.ts` (R3.4)
  * Test: pipe mock hook JSON to stdin → correct `status.local.json` written
  * Test: stdout outputs hook response JSON
  * Test: invalid/missing stdin → non-zero exit with stderr message
  * Test: cwd that doesn't match any known project dir → creates dir or errors gracefully
* [x] Implement `status` sub-command in `src/cli.ts`
  * Read JSON from stdin (cwd, session_id, hook_event_name)
  * Map cwd → project dir: scan `~/.claude/projects/` for matching `originalPath` via `sessions-index.json`, or fall back to encoding cwd as `-`-separated path
  * Call `mapHookEventToState()`, `writeStatus()`
  * Output hook response JSON to stdout
* [x] Verify: `bun test` passes
* [ ] Manual test: pipe sample JSON and verify `status.local.json` written

### Step 5: `dump --watch` — TDD

* [x] Write test for `dump --watch` in `tests/cli.test.ts` (R13)
  * Test: prints initial state then keeps process alive
  * Test: prints update block with separator on status file change
  * Test: exits cleanly on SIGINT
* [x] Implement `--watch` flag in `src/cli.ts`
  * Parse `--watch` flag from argv
  * Print initial `getProjectState()` JSON
  * Start `watchForChanges()`, on update: print separator with timestamp + new JSON
  * Handle SIGINT: call `watcher.stop()`, exit 0
* [x] Verify: `bun test` passes
* [ ] Manual test: run `bun run dump --watch`, trigger status change, observe update

### Step 6: HTTP + WebSocket server

* [x] Implement Bun HTTP server in `src/server.ts` (R5)
  * Serve static HTML at `/` (inline or from file)
  * Listen on configurable port (default 3000)
* [x] Implement WebSocket endpoint for real-time push (R6)
  * On connect: send current state of all projects (R6.2)
  * Watch status files via `watchForChanges()`, broadcast updates (R6.1)
* [x] Write test for server in `tests/server.test.ts`
  * Test: HTTP GET `/` returns HTML, `/api/state` returns JSON, unknown returns 404
  * Test: WebSocket connect receives initial state
* [x] Verify: `bun test` passes

### Step 7: Hook configuration

* [x] Add `ccmon status` hook commands in `~/dotfiles/home-manager/modules/claude/settings.json` (R4)
  * Added alongside existing `claude-tmux-indicator` in same matcher groups
  * Events: `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd`, `PermissionRequest`
* [x] Manual test: hooks confirmed live — `status.local.json` written correctly on UserPromptSubmit
* [x] Update CLAUDE.md with new commands and architecture notes

### Step 8: `--project` filter + drop separator — TDD

* [x] Update `dump --watch` tests in `tests/cli.test.ts`:
  * Remove separator assertions — watch should output NDJSON (one JSON per line, no `---` separator)
  * Add test: `--project <name>` filters to single JSON object (not array)
  * Add test: `--project unknown` outputs nothing / empty
* [x] Update `dump` (non-watch) tests:
  * Add test: `dump --project <name>` outputs single JSON object
* [x] Implement in `src/cli.ts`:
  * Parse `--project <name>` from argv (value follows the flag)
  * `dump`: filter `getProjectState()` by `projectName`, output single object if `--project` set
  * `dump --watch`: remove `--- <timestamp>` separator line; output one JSON line per update. If `--project` set, filter and output single object
* [x] Verify: `bun test` passes (57 pass, 0 fail)
* [ ] Update README.md with `--project` flag documentation

### Bug fix: `Stop` → `stopped`, remove `waiting_for_answer`

* [x] Remap `Stop` hook → `stopped` in `mapHookEventToState()` (was `waiting_for_answer` — semantic mismatch with tmux)
* [x] Remove `waiting_for_answer` from `SessionState` type and `VALID_STATES`
* [x] Update all tests — 56 pass, 0 fail

## Files

- **src/sessions.ts**: Added `readSessionsIndex()`, `writeStatus()`, `mapHookEventToState()`. `Stop`→`stopped`, removed `waiting_for_answer`
- **src/cli.ts**: Added `status`, `dump --watch`, `dump --project`, `serve` subcommands; NDJSON watch output
- **src/server.ts**: Bun HTTP + WebSocket server
- **tests/sessions.test.ts**: Tests for all new session functions
- **tests/cli.test.ts**: Tests for status, dump --watch, --project filter (14 tests)
- **tests/server.test.ts**: Tests for HTTP + WebSocket server
- **~/dotfiles/home-manager/modules/claude/settings.json**: Hook config with ccmon commands
