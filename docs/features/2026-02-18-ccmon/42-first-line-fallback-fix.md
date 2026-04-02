# Phase 42: Remove sessions-index.json + Fix JSONL Discovery

## Context

See [00-ccmon](00-ccmon.md). Claude Code stopped writing `sessions-index.json` around 2026-02-03. All existing files are frozen. New project dirs don't get one. ccmon's JSONL fallback is now the only viable discovery path, but it fails on newer JSONL files that start with `permission-mode` records (no `cwd` field). Remove sessions-index.json support entirely and make JSONL discovery robust.

## Questions & Investigations

- [x] Q: Why is ccmon project missing from dump?
  - No `sessions-index.json` in `-home-appaquet-Projects-ccmon` dir
  - JSONL fallback fails: first line is `permission-mode` type (no `cwd` field)
  - `isFirstLineRecord()` requires `cwd` + `sessionId`, returns false → project skipped
- [x] Q: Is `sessions-index.json` still maintained by Claude Code?
  - No. All 6 existing files frozen since ~2026-02-03. New dirs don't get one. Deprecated.
- [x] Q: What fields do we lose by removing index support?
  - `gitBranch` — already removed from UI in Phase 14 (R55). Only in JSON dump, was stale anyway
  - `summary`, `firstPrompt`, `messageCount`, `sessionModified` — optional, not displayed in UI
  - `isSidechain` filtering — lost, but has been absent for 2 months with no issues
- [x] Q: Fix approach?
  - Remove `readSessionsIndex()`, cache, types, validator entirely
  - Remove index path from `readProjectInfo()` — JSONL becomes sole path
  - Fix `readFirstLine()` to scan all lines in 4096-byte buffer (not just first)
  - Remove index-only fields from `ProjectInfo`

## Tasks

### Backend removal

- [x] Delete `readSessionsIndex()` function, `sessionsIndexCache`, `SessionsIndex` type, `SessionsIndexEntry` type, `RawIndexEntry` type, `isSessionsIndexRaw()` validator
  - AC: No references to `readSessionsIndex` or `sessionsIndexCache` remain in src/
- [x] Remove index path from `readProjectInfo()` — JSONL-only
  - AC: `readProjectInfo()` calls `findLatestJSONL()` + `readFirstLine()` directly, no index branching
- [x] Remove index-only fields from `ProjectInfo`: `summary`, `firstPrompt`, `messageCount`, `sessionModified`, `gitBranch`
  - AC: `ProjectInfo` has only `projectDir`, `cwd`, `projectName`, `sessionId`, `latestJSONL`
- [x] Remove `sessionsIndexCache.clear()` from `_resetCachesForTesting()`
- [x] Remove `gitBranch` from `buildProjectState()` and any ProjectState references
  - AC: `gitBranch` not present in ProjectState output

### JSONL discovery fix

- [x] Modify `readFirstLine()` to scan all lines in 4096-byte buffer for first `isFirstLineRecord()` match
  - AC: When first line lacks `cwd`, subsequent lines are checked
  - AC: Returns first matching record (preserves existing behavior when first line matches)
  - AC: Returns null when no lines match (preserves error path)

### Tests

- [x] Delete `readSessionsIndex` describe block (~6 tests) + caching tests (~2 tests)
- [x] Rewrite `readProjectInfo` tests to use JSONL-only (remove index setup)
- [x] Remove `gitBranch` from test fixtures and assertions across all test files
- [x] Add test: first line is `permission-mode` (no cwd), second line has cwd → returns second line data
- [x] Add test: JSONL with cwd on first line → works as before

### Docs

- [x] Update CLAUDE.md: remove sessions-index.json references from architecture section
- [x] Update R14 in project doc to reflect removal

### Validation

- [x] Integration: `bun run dump --no-filter --project ccmon` shows ccmon project
- [x] Lint + typecheck + full test suite passes (225 tests)

## Files

- **src/sessions.ts**: Remove `readSessionsIndex()`, cache, types; simplify `readProjectInfo()`; fix `readFirstLine()` multi-line scan; remove index-only fields from `ProjectInfo`
- **src/watcher.ts**: Remove sessions-index comment
- **tests/sessions.test.ts**: Delete index tests, rewrite readProjectInfo tests, remove gitBranch from fixtures
- **tests/server.test.ts**: Remove gitBranch from test fixtures
- **CLAUDE.md**: Remove sessions-index.json architecture references
