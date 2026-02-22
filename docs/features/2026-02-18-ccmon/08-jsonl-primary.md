# Phase 08: JSONL-Primary State Detection

## Context

See [00-ccmon](00-ccmon.md). Switch from hook-driven state detection to JSONL file watching as the primary signal source for running/stopped state. Keep hooks for signals absent from JSONL (PermissionRequest, Notification) and for immediate stopped detection (Stop, SessionEnd). Remove pgrep-based liveness entirely.

## Questions

* Q1: ✅ Can JSONL fully replace hooks? → No. `PermissionRequest` writes nothing to JSONL. `Notification` is out-of-band. `Stop`/`SessionEnd` give immediate stopped signal (JSONL mtime alone has ~60s delay). Keep those 4 hooks. Remove `UserPromptSubmit` and `PostToolUse` (JSONL mtime covers running).
* Q2: ✅ Is the R33 flicker race eliminated? → Yes. Flicker was hook→status.local.json→pgrep pipeline. New model: JSONL mtime for running, Stop hook for stopped. No conflicting signals during turn boundaries. 3s debounce becomes unnecessary.
* Q3: ✅ What does `status.local.json` become? → Carries `waiting_for_permission`, `stopped` (from Stop/SessionEnd hooks), and notification fields. No longer writes `running` state.
* Q4: ✅ Remove pgrep? → Yes. JSONL mtime staleness handles crash detection (60s delay acceptable). Removes Linux-only /proc code and process name matching.
* Q5: ✅ Mtime threshold? → 60s hardcoded. Claude writes continuously during turns.
* Q6: ✅ Keep SessionStart hook? → Yes, unrelated to state detection.

## Tasks

### 1. Refactor `resolveState()` for JSONL-primary logic (R34)

- [ ] Change `resolveState()` signature: accept `jsonlMtimeMs` (latest JSONL file mtime), remove `liveCwds` parameter
- [ ] New resolution priority:
  1. `waiting_for_permission` if status.local.json says so and timestamp < 5min
  2. `running` if JSONL mtime < 60s AND (no stopped signal OR JSONL mtime > stopped timestamp)
  3. `stopped` if status.local.json says stopped (from Stop/SessionEnd hook)
  4. `stopped` if JSONL mtime > 60s (crash/stale fallback)
- [ ] Add unit tests for each resolution branch: permission wins, mtime-fresh running, stopped-hook wins over fresh mtime, mtime-stale fallback, activity-after-stopped resumes running
- [ ] Test: JSONL written after stopped timestamp → running (activity resumed)

### 2. Wire JSONL mtime into `buildProjectState()` (R34)

- [ ] Stat the latest JSONL file to get mtime in `buildProjectState()`
- [ ] Pass `jsonlMtimeMs` to new `resolveState()`
- [ ] Only read `status.local.json` for `waiting_for_permission`, `stopped` timestamp, and notification fields — no longer use it for running state
- [ ] Use JSONL mtime as `lastUpdated` source (already partially done)
- [ ] Test: integration via `getProjectState()` with JSONL mtime scenarios

### 3. Remove pgrep/proc liveness detection (R34)

- [ ] Delete `checkLiveness()`, `collectPgrepPids()`, `collectProcExePids()`, `readProcCwd()`
- [ ] Delete `livenessCache` and its TTL logic
- [ ] Remove pgrep-related imports and constants
- [ ] Update/remove tests that depend on pgrep mocking
- [ ] Test: compilation, no remaining references

### 4. Extend watcher to watch JSONL files (R34)

- [ ] Watch entire project dir (catches `*.jsonl`, `sessions-index.json`, `status.local.json` changes)
- [ ] Ensure debounce handles frequent JSONL writes (Claude writes every few seconds during active turns)
- [ ] Test: JSONL file write triggers watcher callback

### 5. Remove R33 debounce from server.ts (R34)

- [ ] Delete `stopDebounceTimers` map and 3s delay logic in server.ts
- [ ] State changes propagate immediately to WebSocket clients
- [ ] Test: state propagates without artificial delay

### 6. Reduce hook config (R35)

- [ ] Update `~/dotfiles/home-manager/modules/claude/settings.json`: remove `UserPromptSubmit` and `PostToolUse` ccmon hook entries
- [ ] Keep: `Stop`, `SessionEnd`, `PermissionRequest`, `Notification`, `SessionStart`
- [ ] Remove `UserPromptSubmit` and `PostToolUse` cases from `mapHookEventToState()`
- [ ] Test: cli tests for remaining hook events still pass

### 7. Simplify `ccmon status` command (R35)

- [ ] Remove `running` state write — no hook produces it anymore
- [ ] Handle: PermissionRequest→`waiting_for_permission`, Stop→`stopped`, SessionEnd→`stopped`, Notification→notification fields, SessionStart→(no-op or future use)
- [ ] Test: updated cli.test.ts for simplified event set

### 8. Migrate existing tests (R34)

- [ ] Update `getProjectState` tests from status.local.json-driven paradigm to JSONL mtime paradigm
- [ ] Ensure sub-agent tests still pass (already use JSONL mtime for isActive)
- [ ] Update README hook config section (R35)

## Files

- **src/sessions.ts**: Refactor `resolveState()`, `buildProjectState()`. Remove `checkLiveness()`, `collectPgrepPids()`, `collectProcExePids()`, `readProcCwd()`, `livenessCache`
- **src/watcher.ts**: Watch project dirs (catches JSONL + status.local.json)
- **src/server.ts**: Remove R33 `stopDebounceTimers` 3s debounce
- **src/cli.ts**: Simplify `runStatus()` for reduced hook events, update `mapHookEventToState()`
- **~/dotfiles/home-manager/modules/claude/settings.json**: Remove UserPromptSubmit + PostToolUse hook entries
- **README.md**: Update hook config section
- **tests/sessions.test.ts**: New resolveState tests, migrate existing state tests
- **tests/cli.test.ts**: Updated hook event tests
- **tests/watcher.test.ts**: JSONL watch tests
