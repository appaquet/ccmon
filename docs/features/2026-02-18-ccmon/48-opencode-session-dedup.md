# Phase 48: OpenCode Session Deduplication

## Context

See [00-ccmon](00-ccmon.md). Phase 44 implemented the `OpencodeBackend` with `scanProjects()` returning all non-archived, non-child sessions. Unlike the Claude Code backend — where `findLatestJSONL()` picks only the most recent `.jsonl` per project directory — the OpenCode backend returns **every** session for the same project directory. For `ccmon` with 5 historical sessions, this produces 5 entries in the dashboard instead of 1.

The root cause is the SQL query in `scanProjects()` has no deduplication by `directory`. It needs to return only the session with `MAX(time_updated)` per unique directory.

## Tasks

- [x] Modify `scanProjects()` SQL query to return only the latest session per `directory` (R71.1)
  - AC: Query uses `JOIN (SELECT directory, MAX(time_updated) ...)` to deduplicate
  - AC: `scanProjects()` returns at most 1 session per unique `directory`
  - AC: The returned session is the one with the highest `time_updated`
  - AC: No change to existing test expectations — the "scanProjects returns only active sessions" test uses different directories per session and still returns count=2

- [x] Add test: two sessions in same directory → only latest returned
  - AC: Insert `ses_new` (now) and `ses_old` (now - 60000) both with directory `/home/user/dedupproj`
  - AC: `scanProjects()` returns 1 result with `sessionId === "ses_new"`
  - AC: Three sessions across two directories returns 2 results (one per directory)

- [x] Run full test suite, lint, typecheck
  - AC: `bun test` — all 260 tests pass (0 fail)
  - AC: `bun run lint && bun run typecheck` — could not run due to `/home/appaquet/` read permission (environment issue, unrelated to changes)
  - AC: `bun run dump --no-filter` integration check — could not run due to same permission issue

## Files

- **src/backends/opencode.ts**: `scanProjects()` SQL query — added `JOIN (SELECT directory, MAX(time_updated) GROUP BY directory)` to deduplicate by directory (line 38-43)
- **tests/backends/opencode.test.ts**: Added 2 tests — "scanProjects returns only the latest session per directory" and "scanProjects returns one session per directory when multiple directories exist" (after line 213)
