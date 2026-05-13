# Phase 50: SessionStore + Module Split

## Context

See [00-ccmon](00-ccmon.md). Two REVIEW comments deferred from Phase 49:

1. **sessions.ts:51-67**: Module-level mutable caches (`sessionTailCache`, `projectStateCache`) create implicit global state. Tests must call `_resetCachesForTesting()` (31 calls across 3 files). Server has its own parallel `stateMap`.

2. **sessions.ts:298-318**: God module (1312 lines) conflates 6+ responsibilities: project scanning, status I/O, enrichment parsing, name disambiguation, CLI state mapping, sub-agent resolution.

### Research Findings

### Cache usage reality

- `sessionTailCache` (line 65): Used by `readSessionTail()` → called from `buildProjectState()`, `getSubagentInfos()`, and `enrichProject()`. All production paths hit this cache.
- `projectStateCache` (line 69): **Dead code in production**. Only used by `getProjectState()`, which is called exclusively from tests. Server and CLI use the `SessionBackend` path instead.
- `server.ts`'s `stateMap`: Independent, never interacts with sessions.ts caches.
- The "two-tier caching" concern is overstated — only `sessionTailCache` is truly shared across production and test paths.

### Current structure of sessions.ts (1312 lines)

| Section | Lines | Responsibility |
|---------|-------|----------------|
| Imports + re-exports | 1–25 | Module setup |
| Constants | 27–49 | Thresholds, paths |
| Caches (REVIEW) | 51–69 | Module-level Maps |
| Interfaces (6) | 75–135 | Type definitions |
| Hook state mapping | 137–168 | `mapHookEventToState` |
| Status I/O (4 fns) | 169–267 | `writeStatusEvent` etc. |
| Project scanning (3 fns) | 269–306 | `scanProjects`, `getProjectState` |
| Name disambiguation | 367–428 | `disambiguateProjectNames` |
| Stale filter | 430–452 | `filterStaleProjects` |
| Sub-agents | 454–566 | `getSubagentInfos` |
| JSONL enrichment (REVIEW largest chunk) | 568–1000 | `readSessionTail`, `scanEnrichment`, `mergeEnrichment` |
| Scanning helpers | 1002–1117 | `scanTaskCreateUpdate`, `scanTodoWrite` |
| State builder | 1139–1237 | `buildProjectState` |
| File helpers | 1240–1332 | `readProjectInfo`, `findLatestJSONL`, etc. |

### Consumer imports

7 files import from sessions.ts. Moving symbols requires updating these files.

| File | Imports (value) | Imports (type) |
|------|----------------|----------------|
| `src/server.ts` | `filterStaleProjects` | `ProjectState` |
| `src/cli.ts` | `filterStaleProjects`, `mapHookEventToState`, `scanProjects`, `writeStatusEvent`, `writeStatusTruncate`, `writeNotificationStatus`, `writeSubagentStatus` | `StatusEvent` |
| `src/backends/types.ts` | — | `BackendSource`, `ProjectInfo`, `ProjectState`, `SessionEnrichment`, `SessionState`, `SubagentInfo` |
| `src/backends/claude.ts` | `buildProjectState`, `getSubagentInfos`, `readSessionTail`, `scanProjects` | `ProjectInfo`, `ProjectState`, `SessionEnrichment`, `SessionState`, `StatusEvent`, `SubagentInfo` |
| `src/backends/opencode.ts` | — | `ProjectInfo`, `ProjectState`, `SessionEnrichment`, `SessionState`, `SubagentInfo` |
| `tests/sessions.test.ts` | 19 symbols including `_resetCachesForTesting` | `StatusEvent` |
| `tests/server.test.ts` | `_resetCachesForTesting` | — |
| `tests/integration.test.ts` | `_resetCachesForTesting` | — |

## Requirements

- R74.A: ✅ Module-level caches extracted to instance-level `SessionStore` class (Phase: SessionStore)
  - R74.A.1: `sessionTailCache` and `projectStateCache` are instance fields, not module-level `Map` objects
  - R74.A.2: Tests isolate caches via `replaceDefaultStore(new SessionStore(dir))` instead of `_resetCachesForTesting()`
  - R74.A.3: `_resetCachesForTesting()` is removed; `replaceDefaultStore()` is the new isolation mechanism
  - R74.A.4: `ClaudeBackend` injects its own `SessionStore` instance, giving production code its own cache scope

- R74.B: ✅ Enrichment parsing extracted to `session-enrichment.ts` (Phase: Module Split)
  - R74.B.1: `scanEnrichment`, `mergeEnrichment`, `scanTaskCreateUpdate`, `scanTodoWrite`, and pure helpers (`isTextBlock`, `isToolUseBlock`, `extractCommand`, `computeReadRange`) live in the new file
  - R74.B.2: `readSessionTail()` stays in sessions.ts as a SessionStore method (needs cache access); imports pure helpers from session-enrichment.ts
  - R74.B.3: Types `SessionTailInfo`, `SessionTailCache`, `TaskInfo` move to session-enrichment.ts; sessions.ts re-exports them
  - R74.B.4: No direct imports of `session-enrichment.ts` from consumer files (backward compat via sessions.ts re-export)
  - R74.B.5: All 260 existing tests pass without call-site changes (except migration from `_resetCachesForTesting` to `replaceDefaultStore`)

## Questions & Investigations

- [x] Q: Is `projectStateCache` actually used in production?
  - Result: No. Only `getProjectState()` touches it, and that's only called from tests. It moves to SessionStore alongside sessionTailCache for consistency — both caches under the same instance management.
- [x] Q: Does server.ts share caches with sessions.ts?
  - Result: Only `sessionTailCache` is shared (via `readSessionTail()` called from `buildProjectState()`). `stateMap` is independent. This is resolved by giving ClaudeBackend its own injected SessionStore.
- [x] Q: Singleton + injection — will two cache scopes cause split-brain?
  - Analysis: In production, all cache-dependent operations go through `ClaudeBackend.buildProjectState()` → injected store. The singleton's caches are never populated outside tests. `cli.ts resolveProjectDir()` calls `scanProjects()` which is cache-free. No split-brain.
  - Decision: Injection is primary; module-level singleton is backward-compat only. In tests, `replaceDefaultStore()` swaps the singleton wholesale per describe block.
- [x] Q: Migration depth — shim vs full test call-site replacement?
  - Decision: Use `replaceDefaultStore(new SessionStore(dir))` in beforeEach hooks. This is a one-line replacement for `_resetCachesForTesting()` that properly isolates caches (fresh instance, not just cleared Maps). Zero changes to test call sites — all free-function calls continue to delegate to the (now-replaced) singleton.
- [x] Q: What enrichment functions move vs stay?
  - Decision: `readSessionTail()` stays in sessions.ts as a SessionStore method (needs cache access). Only pure functions move: `scanEnrichment`, `mergeEnrichment`, `scanTaskCreateUpdate`, `scanTodoWrite`, `isTextBlock`, `isToolUseBlock`, `extractCommand`, `computeReadRange`. Types `SessionTailInfo`, `SessionTailCache`, `TaskInfo` move too. Sessions.ts re-exports everything.

## Tasks

### Part A: SessionStore class

- [x] A1: Create `SessionStore` class in `src/sessions.ts`
  - Move `sessionTailCache` from module-level `Map` to instance field on `SessionStore`
  - Move `projectStateCache` to instance field (keeps existing behavior, even if test-only)
  - Methods that use caches become SessionStore methods: `readSessionTail()`, `getSubagentInfos()`, `buildProjectState()`, `getProjectState()`
  - Constructor takes `claudeDir: string`
  - Keep `scanProjects()` as a method too (uses claudeDir but no cache — consistent API surface)
  - AC: Caches are instance fields. No module-level `Map` objects for caches.

- [x] A2: Maintain backward-compatible module-level exports
  - Create a module-level singleton `defaultStore: SessionStore` (lazy-initialized with `DEFAULT_CLAUDE_DIR`)
  - Export `replaceDefaultStore(store)` to swap the singleton (primary test isolation mechanism)
  - Export thin wrapper functions that delegate to the singleton: `readSessionTail(path)` → `defaultStore.readSessionTail(path)`, etc.
  - All consumer files (cli.ts, server.ts, backends, tests) continue to import and call free functions identically
  - Pure functions (`filterStaleProjects`, `mapHookEventToState`, `disambiguateProjectNames`, status I/O) remain as free exports
  - AC: All 7 consumer files compile without import changes. 260 tests pass.

- [x] A3: Remove `_resetCachesForTesting()`, expose `replaceDefaultStore()` instead
  - `replaceDefaultStore(store: SessionStore)` replaces the module-level singleton entirely
  - Tests call `replaceDefaultStore(new SessionStore(dir))` in beforeEach instead of `_resetCachesForTesting()`
  - One-line change per test hook: `_resetCachesForTesting()` → `replaceDefaultStore(new SessionStore(tmpDir))`
  - AC: `_resetCachesForTesting()` removed from exports. Zero remaining callers. All 31 test sites migrated.

- [x] A4: Update `ClaudeBackend` to accept optional `SessionStore`
  - Add optional `store?: SessionStore` parameter to constructor
  - If provided, use it; otherwise create `new SessionStore(this.claudeDir)`
  - `buildProjectState()` delegates to `this.store.buildProjectState(projectInfo)`
  - `scanProjects()` delegates to `this.store.scanProjects()`
  - `enrichProject()` delegates to `this.store.readSessionTail()`
  - `getSubagents()` delegates to `this.store.getSubagentInfos()`
  - AC: ClaudeBackend no longer imports free functions from sessions.ts for cache-dependent operations. Each backend has its own cache scope.

### Part B: Enrichment extraction

- [x] B1: Create `src/session-enrichment.ts`
  - Move pure enrichment functions: `scanEnrichment()`, `mergeEnrichment()`, `scanTaskCreateUpdate()`, `scanTodoWrite()`
  - Move pure helpers: `isTextBlock()`, `isToolUseBlock()`, `extractCommand()`, `computeReadRange()`
  - Move types: `SessionTailInfo`, `SessionTailCache` (interface), `TaskInfo`
  - `readSessionTail()` stays in sessions.ts as a SessionStore method — it needs cache access and orchestrates the pure helpers
  - `SessionEnrichment`, `SubagentInfo`, `ProjectInfo`, `ProjectState` stay in sessions.ts (widely consumed)
  - AC: ~320 lines moved. New file has no module-level state. `readSessionTail()` imports from session-enrichment.ts.

- [x] B2: Wire sessions.ts to import from session-enrichment.ts
  - `readSessionTail()` in sessions.ts imports and calls the helpers from session-enrichment.ts
  - Behavior is byte-for-byte identical — same logic, same function signatures
  - AC: 260 tests pass. sessions.ts is ~25% shorter (~990 lines).

### Part C: Test migration

- [x] C1: Migrate tests from `_resetCachesForTesting()` to `replaceDefaultStore()`
  - In 12 describe blocks with `beforeEach { _resetCachesForTesting() }`: replace with `replaceDefaultStore(new SessionStore(tmpDir))`
  - In the `describe("session enrichment")` block (lines 948-1861, no current beforeEach): add `beforeEach { replaceDefaultStore(new SessionStore(tmpDir)) }`, remove all 12 inline `_resetCachesForTesting()` calls
  - In `tests/server.test.ts` (2 calls) and `tests/integration.test.ts` (1 call): same one-line replacement
  - Net: 31 replaceDefaultStore calls replace 31 _resetCachesForTesting calls. Zero test assertion changes.
  - AC: `_resetCachesForTesting()` removed from sessions.ts exports. All 260 tests pass. No inline resets needed.

- [x] C2: Add dedicated SessionStore unit tests
  - Test that constructing a fresh `SessionStore` gives clean caches (no cross-test pollution)
  - Test that the singleton pattern works correctly
  - Test that `resetCaches()` clears both caches
  - AC: New test suite validates cache isolation.

### Part D: Cleanup

- [x] D1: Remove the two REVIEW comments from sessions.ts
  - Line 51-67 (module-level caches) → resolved by SessionStore
  - Line 298-318 (god module) → resolved by enrichment extraction
  - AC: Both REVIEW comments removed. Grep confirms no remaining deferred REVIEWs.

- [x] D2: Verify integration
  - Run `bun test` — all 260+ tests pass
  - Run `bun run lint && bun run typecheck` (if Nix sandbox permits)
  - Run integration check: `bun run dump --no-filter`
  - AC: All tests pass. No regressions.

## Files

- **src/sessions.ts**: `SessionStore` class added, module-level caches moved to instance fields, backward-compat singleton wrappers; ~990 lines after enrichment extraction
- **src/session-enrichment.ts** (new): `scanEnrichment`, `mergeEnrichment`, `scanTaskCreateUpdate`, `scanTodoWrite`, helpers, types (~320 lines)
- **src/backends/claude.ts**: Accepts optional `SessionStore`, delegates cache-dependent operations
- **tests/sessions.test.ts**: `_resetCachesForTesting()` replaced with SessionStore instances or kept as shim
- **tests/server.test.ts**: Same migration
- **tests/integration.test.ts**: Same migration
