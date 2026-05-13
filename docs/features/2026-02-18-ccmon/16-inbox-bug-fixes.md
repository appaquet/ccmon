# Phase 16: Inbox Bug Fixes

## Context

See [00-ccmon](00-ccmon.md). Three bugs from the inbox: task completions not reflected in WebSocket/sub mode, permission state sticking after answering, and hook config safety verification.

## Questions & Investigations

* Q1: Bug 3 (hook safety) — already handled correctly. `mapHookEventToState()` returns `null` for unknown events, `runStatus()` handles gracefully. Only adding a test to document the expectation.

## Tasks

### Bug 1: Task completions not reflected in WebSocket/sub mode

Root cause: `scanTaskCreateUpdate()` builds a local task map per invocation. In delta mode (server/watcher), only new JSONL bytes are scanned. `TaskUpdate` entries referencing tasks created in earlier reads are silently dropped because the local map doesn't contain them. `dump` works because it reads the full file fresh.

- [x] Modify `scanTaskCreateUpdate()` to accept optional base tasks and seed its local map so `TaskUpdate` entries in delta reads can resolve pre-existing tasks (R46)
- [x] Update `readSessionTail()` / `mergeEnrichment()` call site to pass `baseData.tasks` into `scanTaskCreateUpdate()` (R46)
- [x] Add test: two sequential `readSessionTail` reads; second delta contains `TaskUpdate` marking task completed; verify `tasksDone` increments (R46)
- [x] Add test: delta read with `TaskUpdate` for unknown task ID (no base task) is silently ignored (R46)

### Bug 2: `waiting_for_permission` sticks after answering

Root cause: `resolveState()` checks `waiting_for_permission` at Priority 1 (before JSONL mtime at Priority 2). When user grants permission, Claude resumes and writes to JSONL (mtime becomes fresh), but `status.local.json` still says `waiting_for_permission` within the 5-min staleness window. Priority 1 returns immediately, never reaching the JSONL mtime check.

- [x] Update `resolveState()` Priority 1: when `waiting_for_permission` is fresh but JSONL mtime is newer than the permission timestamp (+ grace), fall through to Priority 2 instead of returning immediately (R34)
- [x] Add test: `resolveState` with fresh `waiting_for_permission` + JSONL mtime newer → `running` (R34)
- [x] Add test: `resolveState` with fresh `waiting_for_permission` + JSONL mtime older → `waiting_for_permission` (R34)
- [x] Add test: `resolveState` with fresh `waiting_for_permission` + null JSONL mtime → `waiting_for_permission` (R34)

### Bug 3: Hook config safety (verification only)

No code change needed. `mapHookEventToState()` already returns `null` for unrecognized events, and `runStatus()` handles `null` by outputting `{}\n` and exiting cleanly.

- [x] Add test: `mapHookEventToState('SessionStart')` returns `null` (R35)
- [x] Verify all hook events in settings.json are exercised by existing + new tests (R4, R35)

### Bug 4: Slash commands cause 2-3s delay before running state

Root cause: JSONL-only running detection has inherent latency — JSONL is written only when Claude starts responding, not when user submits. Slash commands have extra overhead (local processing + skill expansion) before JSONL write. Phase 08 removed `UserPromptSubmit` → `running` assuming immediate JSONL write, which was incorrect.

- [x] Re-add `UserPromptSubmit` and `PostToolUse` → `running` in `mapHookEventToState()` (R34, R35)
- [x] Add `RUNNING_HOOK_TTL_MS = 30_000` constant in `sessions.ts`
- [x] Add Priority 2 in `resolveState()`: fresh `running` status (< 30s) + no newer stopped signal → `running` immediately (R34)
- [x] Add tests: mapHookEventToState UserPromptSubmit/PostToolUse → running; resolveState hook-running scenarios (R34, R35)

## Files

- **src/sessions.ts**: Bug 1 fix (`scanTaskCreateUpdate`, `mergeEnrichment`), Bug 2 fix (`resolveState`), Bug 4 fix (`mapHookEventToState`, `resolveState`, `RUNNING_HOOK_TTL_MS`)
- **tests/sessions.test.ts**: Tests for all bugs
- **tests/cli.test.ts**: Updated UserPromptSubmit/PostToolUse hook tests
