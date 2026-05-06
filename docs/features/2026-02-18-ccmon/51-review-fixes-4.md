# 51 Phase: Review Fixes 4

## Context

See [00-ccmon](00-ccmon.md). Address 19 REVIEW comments from 4 review agents (style, correctness, architecture, requirements) planted during Phase 50 review pass.

## Questions & Investigations

* [x] Q: Is R63 (project name disambiguation) really broken in all production paths?
  * Verified: `server.ts:72` (serve/WebSocket), `cli.ts:155` (dump, dump --watch) — none call `disambiguateProjectNames`. Previously `getProjectState()` handled it internally but Phase 44's multi-backend refactoring replaced that with direct `scanProjects()` + `buildProjectState()` patterns.
  * Result: Confirmed regression across all 3 output paths.

* [x] Q: Does `getSubagents()` need `stoppedAtMs` computed? Is there any production caller?
  * Tried: Searched for callers of `backend.getSubagents()`. Only called by `buildProjectState()` internally (which passes `stoppedAtMs`) and by `OpencodeBackend.buildProjectState()`.
  * Result: No production code calls the public `getSubagents()` directly. Document the limitation rather than adding status log read to the public method.

* [x] Q: Should `disambiguateProjectNames` be static on `SessionStore` or a standalone function?
  * It's a pure function on its parameter, never uses `this.claudeDir` or any instance state.
  * Result: Extract as standalone exported function. Both `SessionStore.disambiguateProjectNames` (now delegate) and backward-compat wrapper call it directly.

* [x] Q: Should `scanProjects` on `SessionStore` be removed or kept?
  * `SessionStore.scanProjects` is cache-free (only readdir + readProjectInfo). The backward-compat wrapper creates a new SessionStore for non-default claudeDir, allocating two unused Maps.
  * Result: Convert `SessionStore.scanProjects` to delegate to a standalone `scanProjects(dir)` function. The wrapper uses the function directly.

## Tasks

### H: Release-blocking

* [x] Fix: `src/server.ts:72` R63 regression — add disambiguateProjectNames in server path
  - AC: `currentFilteredState()` returns disambiguated project names
  - AC: Projects with same basename from different dirs get expanded names
  - AC: Disambiguation runs after all backends are built in `rescanAllBackends()` and `rescanBackend()`

* [x] Fix: `src/cli.ts:155` R63 regression — add disambiguateProjectNames in CLI dump paths
  - AC: `buildProjectMap()` in `runDump()` produces disambiguated project names
  - AC: Watch mode `formatWatchOutput()` produces disambiguated project names

### M: Important

* [x] Fix: `src/sessions.ts:243` — extract `disambiguateProjectNames` as standalone function (Architecture)
  - AC: Standalone exported function, not instance method
  - AC: SessionStore method delegates to standalone function

* [x] Fix: `src/sessions.ts:797` — wrapper functions break cache for non-default claudeDir (Requirements)
  - AC: `getProjectState(claudeDir)` uses singleton store when claudeDir matches store's claudeDir
  - AC: Expose `claudeDir` getter on SessionStore

* [x] Fix: `src/sessions.ts:787` — `scanProjects` wasteful wrapper allocates unused Maps (Architecture)
  - AC: Standalone `scanProjects(dir)` function parameterized by directory
  - AC: SessionStore.scanProjects delegates to standalone function
  - AC: Backward-compat wrapper calls standalone function directly

* [x] Fix: `src/sessions.ts:15` — remove unused `isTextBlock`/`isToolUseBlock` imports (Code Style)
  - AC: No unused imports from session-enrichment in sessions.ts
  - AC: Biome lint passes

* [x] Fix: `src/sessions.ts:427` — stale comment: SUBAGENT_EXPIRY_MS is 30s, not 5 minutes (Correctness)
  - AC: Comment reflects actual constant value (30 seconds)

* [x] Fix: `src/sessions.ts:758` — remove section marker banner comment (Code Style)
  - AC: No banner comment in sessions.ts

* [x] Fix: `src/sessions.ts:766` — guard `getDefaultStore()` against accidental production leak (Architecture)
  - AC: Tests must pass `replaceDefaultStore()` (existing patterns already do this, just making it explicit)
  - AC: No silent fallback to real `~/.claude/projects`

* [x] Fix: `src/sessions.ts:835` — `disambiguateProjectNames` compat wrapper routes through singleton unnecessarily (Architecture)
  - AC: Wrapper calls standalone function directly

* [x] Fix: `src/cli.ts:31` — wire `parseStringFlag`/`parseNumberFlag` to call sites (Code Style)
  - AC: `--project` parsing uses `parseStringFlag`
  - AC: `--max-age` parsing uses `parseNumberFlag`
  - AC: `--port` parsing uses `parseNumberFlag`
  - AC: `--host` parsing uses `parseStringFlag`

* [x] Fix: `src/server.ts:45` — remove duplicate comment block (Code Style)
  - AC: Single, non-redundant comment before `stateMap`

* [x] Fix: `src/backends/claude.ts:60` — replace dynamic import with top-level import of `stat` (Correctness)
  - AC: `stat` imported from `"node:fs/promises"` at top of file
  - AC: No dynamic import inside `fetchStateEvents`

* [x] Fix: `src/backends/claude.ts:94` — document `getSubagents()` limitation regarding `SUBAGENT_STOP_GRACE_MS` (Correctness)
  - AC: Docstring notes that SUBAGENT_STOP_GRACE_MS is not applied
  - AC: Directs callers to use `buildProjectState()` for accurate stopped sub-agent detection

* [x] Fix: `tests/integration.test.ts:18` — move `replaceDefaultStore()` after `tmpDir` assignment (Code Style)
  - AC: `replaceDefaultStore(new SessionStore(tmpDir))` called with valid tmpDir

* [x] Fix: `src/session-enrichment.ts:292` — restore documentation on mergeEnrichment token merge strategies (Code Style)
  - AC: Docstring or inline comments explain WHY input tokens use last-wins (cache_read grows monotonically) vs output tokens use additive (per-call deltas)

* [x] Fix: `src/backends/opencode.ts:177` — batch part queries instead of N+1 (Architecture)
  - AC: Single `WHERE message_id IN (...)` query fetches all parts for relevant messages
  - AC: No per-message SELECT on part table

### L: Low

* [x] Fix: `src/session-enrichment.ts:1` — move module-level docstring above imports (Code Style)
  - AC: Module description before any imports/exports
  - AC: TaskInfo JSDoc describes TaskInfo specifically

* [x] Fix: `src/session-enrichment.ts:98` — extract per-type handler functions from `scanEnrichment` (Architecture)
  - AC: `handleUserEntry`, `handleAssistantEntry` etc. extracted as private functions
  - AC: `scanEnrichment` loop body simplified, delegates to handlers
  - AC: All existing scanEnrichment tests pass unchanged

## Files

- **src/sessions.ts**: Extract disambiguateProjectNames as standalone; remove unused imports; fix stale comment; remove banner comment; add getDefaultStore guard; fix compat wrapper; fix scanProjects wrapper; add claudeDir getter
- **src/server.ts**: Add disambiguateProjectNames to server path; remove duplicate comment
- **src/cli.ts**: Add disambiguateProjectNames to CLI paths; wire parseStringFlag/parseNumberFlag
- **src/backends/claude.ts**: Top-level stat import; document getSubagents limitation
- **src/backends/opencode.ts**: Batch part queries
- **src/session-enrichment.ts**: Move docstring; restore mergeEnrichment docs; extract scanEnrichment handlers
- **tests/integration.test.ts**: Fix replaceDefaultStore ordering
