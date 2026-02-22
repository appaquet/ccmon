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

- [x] Change `resolveState()` signature: accept `jsonlMtimeMs` (latest JSONL file mtime), remove `liveCwds` parameter
- [x] New resolution priority:
  1. `waiting_for_permission` if status.local.json says so and timestamp < 5min
  2. `running` if JSONL mtime < 60s AND (no stopped signal OR JSONL mtime > stopped timestamp)
  3. `stopped` if status.local.json says stopped (from Stop/SessionEnd hook)
  4. `stopped` if JSONL mtime > 60s (crash/stale fallback)
- [x] Add unit tests for each resolution branch: permission wins, mtime-fresh running, stopped-hook wins over fresh mtime, mtime-stale fallback, activity-after-stopped resumes running
- [x] Test: JSONL written after stopped timestamp → running (activity resumed)

### 2. Wire JSONL mtime into `buildProjectState()` (R34)

- [x] Stat the latest JSONL file to get mtime in `buildProjectState()`
- [x] Pass `jsonlMtimeMs` to new `resolveState()`
- [x] Only read `status.local.json` for `waiting_for_permission`, `stopped` timestamp, and notification fields — no longer use it for running state
- [x] Use JSONL mtime as `lastUpdated` source
- [x] Test: integration via `getProjectState()` with JSONL mtime scenarios

### 3. Remove pgrep/proc liveness detection (R34)

- [x] Delete `checkLiveness()`, `collectPgrepPids()`, `collectProcExePids()`, `readProcCwd()`
- [x] Delete `livenessCache` and its TTL logic
- [x] Remove pgrep-related imports and constants (`STALE_THRESHOLD_MS` replaced by `PERMISSION_STALE_MS` + `JSONL_ACTIVE_THRESHOLD_MS`)
- [x] Update/remove tests that depend on pgrep mocking
- [x] Test: compilation, no remaining references

### 4. Extend watcher to watch JSONL files (R34)

- [x] Watch entire project dir (catches `*.jsonl`, `sessions-index.json`, `status.local.json` changes) — already implemented
- [x] Debounce handles frequent JSONL writes
- [x] Test: JSONL file write triggers watcher callback — already tested

### 5. Remove R33 debounce from server.ts (R34)

- [x] Delete `stopDebounceTimers` map and 3s delay logic in server.ts — already removed
- [x] State changes propagate immediately to WebSocket clients

### 6. Reduce hook config (R35)

- [x] `~/dotfiles/home-manager/modules/claude/settings.json`: UserPromptSubmit and PostToolUse already absent
- [x] `mapHookEventToState()`: UserPromptSubmit and PostToolUse removed, return null for unrecognized events
- [x] Test: cli tests updated — UserPromptSubmit/PostToolUse are no-ops

### 7. Simplify `ccmon status` command (R35)

- [x] Remove `running` state write — no hook produces it anymore
- [x] Handle: PermissionRequest→`waiting_for_permission`, Stop→`stopped`, SessionEnd→`stopped`, Notification→notification fields, SessionStart→no-op
- [x] Test: updated cli.test.ts — new no-op test for UserPromptSubmit/PostToolUse

### 8. Migrate existing tests (R34)

- [x] `getProjectState` tests updated from status.local.json paradigm to JSONL mtime paradigm
- [x] Sub-agent tests still pass
- [x] README hook config section already correct

## Files

- **src/sessions.ts**: Refactored `resolveState()` (JSONL mtime primary). Deleted `checkLiveness()`, `collectPgrepPids()`, `collectProcExePids()`, `readProcCwd()`, `livenessCache`. New constants `PERMISSION_STALE_MS`/`JSONL_ACTIVE_THRESHOLD_MS`.
- **src/watcher.ts**: Watches project dirs (catches JSONL + status.local.json) — was already in place
- **src/server.ts**: R33 `stopDebounceTimers` debounce — already removed
- **src/cli.ts**: `mapHookEventToState()` removes UserPromptSubmit + PostToolUse
- **~/dotfiles/home-manager/modules/claude/settings.json**: UserPromptSubmit + PostToolUse hooks already absent
- **README.md**: Hook config already correct
- **tests/sessions.ts**: 11 new `resolveState` unit tests, pgrep tests removed, getProjectState tests migrated
- **tests/cli.test.ts**: UserPromptSubmit/PostToolUse now assert no-op behavior
