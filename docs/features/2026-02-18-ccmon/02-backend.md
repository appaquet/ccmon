# Phase: Backend

## Context

See [00-ccmon](00-ccmon.md). Bun HTTP + WebSocket server, `ccmon status` sub-command for hook integration, and `dump --watch` for console monitoring.

Phase 01 (Session Detection) is complete: `scanProjects()`, `readStatus()`, `checkLiveness()`, `getProjectState()`, `watchForChanges()`, and `dump` CLI are all working with 24 tests.

Key design decision: `ccmon status` is a standalone sub-command that hooks call via stdin. `claude-tmux-indicator` remains independent — ccmon hooks alongside it in the same matcher groups.

## Tasks

### Step 1: `encodeCwd()` and `mapHookEventToState()` — TDD

* [ ] Write test for `encodeCwd()` in `tests/sessions.test.ts` (R3.5)
  * Test: `/home/appaquet/Projects/ccmon` → `-home-appaquet-Projects-ccmon`
  * Test: edge cases (trailing slash, root path)
* [ ] Implement `encodeCwd()` in `src/sessions.ts`
* [ ] Write test for `mapHookEventToState()` (R3.1)
  * Test: all 5 events map correctly
  * Test: unknown event returns `null`
* [ ] Implement `mapHookEventToState()` in `src/sessions.ts`
* [ ] Verify: `bun test` passes

### Step 2: `writeStatus()` — TDD

* [ ] Write test for `writeStatus()` in `tests/sessions.test.ts` (R3.2, R3.3)
  * Test: writes correct `status.local.json` matching `StatusFile` schema to temp dir
  * Test: creates project subdirectory if it doesn't exist
  * Test: round-trip — `writeStatus()` output is parseable by existing `readStatus()`
* [ ] Implement `writeStatus(claudeDir, projectDir, status)` in `src/sessions.ts`
* [ ] Verify: `bun test` passes

### Step 3: `ccmon status` sub-command — TDD

* [ ] Write test for `status` sub-command in `tests/cli.test.ts` (R3.4)
  * Test: pipe mock hook JSON to stdin → correct `status.local.json` written
  * Test: stdout outputs `{"continue":true,"suppressOutput":true}` (hook response)
  * Test: invalid/missing stdin → non-zero exit with stderr message
* [ ] Implement `status` sub-command in `src/cli.ts`
  * Read JSON from stdin (cwd, session_id, hook_event_name)
  * Call `mapHookEventToState()`, `encodeCwd()`, `writeStatus()`
  * Output hook response JSON to stdout
* [ ] Verify: `bun test` passes
* [ ] Manual test: pipe sample JSON and verify `status.local.json` written

### Step 4: `dump --watch` — TDD

* [ ] Write test for `dump --watch` in `tests/cli.test.ts` (R13)
  * Test: prints initial state then keeps process alive
  * Test: prints update block with separator on status file change
  * Test: exits cleanly on SIGINT
* [ ] Implement `--watch` flag in `src/cli.ts`
  * Parse `--watch` flag from argv
  * Print initial `getProjectState()` JSON
  * Start `watchForChanges()`, on update: print separator with timestamp + new JSON
  * Handle SIGINT: call `watcher.stop()`, exit 0
* [ ] Verify: `bun test` passes
* [ ] Manual test: run `bun run dump --watch`, trigger status change, observe update

### Step 5: HTTP + WebSocket server

* [ ] Implement Bun HTTP server in `src/server.ts` (R5)
  * Serve static HTML at `/` (inline or from file)
  * Listen on configurable port (default 3000)
* [ ] Implement WebSocket endpoint for real-time push (R6)
  * On connect: send current state of all projects (R6.2)
  * Watch status files via `watchForChanges()`, broadcast updates (R6.1)
* [ ] Write test for server in `tests/server.test.ts`
  * Test: HTTP GET `/` returns HTML
  * Test: WebSocket connect receives initial state
* [ ] Verify: `bun test` passes

### Step 6: Hook configuration

* [ ] Add `ccmon status` hook commands in `~/dotfiles/home-manager/modules/claude/settings.json` (R4)
  * Add alongside existing `claude-tmux-indicator` in same matcher groups
  * Events: `UserPromptSubmit`, `PostToolUse`, `PermissionRequest`, `Stop`, `SessionEnd`
* [ ] Manual test: start a Claude Code session, verify `status.local.json` appears
* [ ] Update CLAUDE.md with new commands (`bun run dump --watch`, hook setup notes) (R12)

## Files

- **src/sessions.ts**: Add `encodeCwd()`, `writeStatus()`, `mapHookEventToState()`
- **src/cli.ts**: Add `status` sub-command and `--watch` flag
- **src/server.ts**: Bun HTTP + WebSocket server
- **tests/sessions.test.ts**: Tests for new session functions
- **tests/cli.test.ts**: Tests for `status` sub-command and `dump --watch`
- **tests/server.test.ts**: Tests for HTTP + WebSocket server
- **~/dotfiles/home-manager/modules/claude/settings.json**: Hook config with ccmon commands
