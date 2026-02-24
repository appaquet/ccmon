# Phase 27: Append-Only Status Log

## Context

See [00-ccmon](00-ccmon.md). Fix PermissionRequest race with concurrent sub-agents by replacing single-write `ccmon-status.json` with append-only `ccmon-status.jsonl` event log.

### Problem

When multiple sub-agents run concurrently:
1. **Status file overwrite**: Sub-agent A hits permission -> writes `waiting_for_permission`. Sub-agent B's `PostToolUse` overwrites with `running`. Permission lost.
2. **JSONL mtime override**: `resolveState()` uses parent JSONL mtime to override permission after 5s grace (`STOP_GRACE_MS`). Concurrent sub-agents keep parent JSONL fresh -> permission overridden.

### Solution

Append-only NDJSON event log. Events are never overwritten, only appended. Reader scans history to derive state. Permission persists because `PostToolUse` events don't erase it.

## Tasks

- [x]Define `StatusEvent` type and write functions (R59)
  - `StatusEvent`: `{ event, state, timestamp, session_id, working_dir, notificationMessage?, notificationTimestamp? }`
  - `STATUS_LOG_FILE = "ccmon-status.jsonl"`, legacy fallback `"ccmon-status.json"`
  - `writeStatusEvent()`: append one NDJSON line via `appendFile`. Safety cap at 64KB (trim to last 8KB on write).
  - `writeStatusTruncate()`: overwrite file with single line (used by SessionEnd only).
  - Remove old `writeStatus()`. Keep `isStatusEvent` type guard.
  - Update `writeNotificationStatus()` to append notification event. Suppression logic (`permission_prompt` when already `waiting_for_permission`) now requires calling `readStatusLog()` to check current state before deciding to suppress.
  - Update `writeSubagentStatus()` to append SubagentStop event to session log (per-agent file unchanged). Drop `lastSubagentStoppedAt` field — the append itself modifies the file mtime which triggers the watcher.

- [x]Add `readStatusLog()` function (R59)
  - Read last 8KB of `ccmon-status.jsonl`, parse NDJSON lines into `StatusEvent[]`.
  - Migration fallback: if `.jsonl` absent, read `ccmon-status.json` and convert to single-element array.
  - Return events in chronological order.

- [x]Rewrite `resolveState()` (R59)
  - New signature: `resolveState(jsonlMtimeMs: number | null, events: StatusEvent[]): SessionState`
  - Logic:
    1. Filter state-bearing events (exclude Notification, SubagentStop).
    2. Scan backward for unresolved PermissionRequest (not followed by Stop/SessionEnd/UserPromptSubmit). If fresh -> `waiting_for_permission`.
    3. Latest event: Stop/SessionEnd -> `stopped`. PostToolUse/UserPromptSubmit within 60s -> `running`.
    4. Fallback: session JSONL mtime < 60s -> `running`.
    5. Default: `stopped`.
  - Remove `STOP_GRACE_MS`, `RUNNING_HOOK_TTL_MS`.
  - Keep `PERMISSION_STALE_MS`, `JSONL_ACTIVE_THRESHOLD_MS`.

- [x]Update `buildProjectState()` (R59)
  - Replace `readStatus()` with `readStatusLog()`.
  - Pass events array to new `resolveState()`.
  - Extract notification fields from latest Notification event.
  - Extract `stoppedAtMs` from latest Stop/SessionEnd event.

- [x]Update CLI write path in `src/cli.ts` (R59)
  - Build `StatusEvent` from hook payload.
  - SessionEnd -> `writeStatusTruncate()`.
  - All others (including Stop) -> `writeStatusEvent()`.
  - Notification path: append event with notification fields.
  - SubagentStop path: append to session log + per-agent file (unchanged).

- [x]Update tests in `tests/sessions.test.ts` (R59)
  - Rewrite readStatus tests -> readStatusLog (NDJSON files, migration from .json).
  - Rewrite writeStatus tests -> writeStatusEvent/writeStatusTruncate (append vs overwrite).
  - Rewrite resolveState tests with new `(jsonlMtimeMs, StatusEvent[])` signature.
    - Key race test: PermissionRequest followed by PostToolUse -> still `waiting_for_permission`.
  - Update buildProjectState/getProjectState tests to write `.jsonl` format.

- [x]Update tests in `tests/cli.test.ts` (R59)
  - Status command tests: read `.jsonl`, verify NDJSON format.
  - SessionEnd tests: verify file truncated to single line. Stop appends normally.
  - SubagentStop tests: per-agent file unchanged, session log appended.
  - `dump --watch` tests: update to write `.jsonl` format instead of `.json`.

- [x]Update CLAUDE.md (R59)
  - Status file section: `.json` -> `.jsonl` (append-only NDJSON event log).
  - Update file structure tree.
  - Mention truncation on SessionEnd, safety cap on write.

## Design Notes

- **Atomicity**: Linux `write()` with O_APPEND for small writes (<4KB) is atomic. Each event line ~200 bytes.
- **File management**: SessionEnd truncates to 1 line. Stop appends normally (background agents may still be active). Safety cap at 64KB on write (trim to last 8KB). Reader only reads last 8KB anyway.
- **Migration**: `readStatusLog` falls back to old `.json` format. No deletion of old files.
- **Over-reporting**: Permission state persists until Stop/SessionEnd/UserPromptSubmit. Brief over-report after user answers is the accepted trade-off vs missing permission entirely.
- **`lastSubagentStoppedAt` removed**: No longer needed — appending a SubagentStop event to the log modifies file mtime, which triggers the watcher.
- **watcher.ts**: No code changes needed (watches entire directory, not filename-specific). Comment on L11 may be updated.
- **server.ts / index.html**: No changes needed — they consume `ProjectState` objects, not status files directly.

## Files

- **src/sessions.ts**: StatusEvent type, writeStatusEvent, writeStatusTruncate, readStatusLog, resolveState rewrite, buildProjectState update.
- **src/cli.ts**: Status command write path.
- **tests/sessions.test.ts**: Test rewrites for new types and functions.
- **tests/cli.test.ts**: CLI test updates for NDJSON format.
- **CLAUDE.md**: Documentation updates.
