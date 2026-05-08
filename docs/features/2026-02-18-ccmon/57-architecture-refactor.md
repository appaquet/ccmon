# 57 Phase: Architecture Refactor

## Context

See [00-ccmon](00-ccmon.md). After 56 phases of organic growth across 3 major migrations (Bun→Node.js, single-backend→multi-backend, polling-only→plugin+fs.watch), ccmon carries structural debts from its evolution. An architecture review identified 3 systemic issues that will progressively degrade maintainability:

1. **sessions.ts god file** (849 lines, 6 concerns) — every change crosses this module
2. **SessionStore = hidden ClaudeBackend** — lives in shared `sessions.ts`, hollow 106-line `ClaudeBackend` wrapper, singleton pattern with test contamination risk
3. **buildProjectState in interface** — forces each backend to duplicate assembly logic

This phase splits the monolith, consolidates the Claude backend, and cleans up the interface.

## Requirements

These expand on project doc requirements by defining architectural constraints:

- R57.A: ✅ `sessions.ts` delegated to 3 focused modules: `types.ts`, `project-utils.ts`, `status-writer.ts` (Phase: 57-A)
  - R57.A.1: `src/types.ts` — ProjectInfo, ProjectState, SubagentInfo, BackendSource (no behavior, pure type movement)
  - R57.A.2: `src/project-utils.ts` — filterStaleProjects, disambiguateProjectNames, scanProjects (free fn), readFirstLine, findLatestJSONL, constants (CLOSED_PROJECT_TTL_MS, MAX_STATUS_LOG_BYTES, DEFAULT_CLAUDE_DIR)
  - R57.A.3: `src/status-writer.ts` — writeStatusEvent, writeStatusTruncate, writeSubagentStatus, writeNotificationStatus, mapHookEventToState
  - R57.A.4: `src/sessions.ts` re-exports for backward compat until Phase 57-B completes

- R57.B: ✅ SessionStore consolidated into ClaudeBackend, singleton eliminated (Phase: 57-B)
  - R57.B.1: ClaudeBackend absorbs SessionStore's caches, methods, and Claude-specific logic
  - R57.B.2: getDefaultStore(), replaceDefaultStore(), and all free-function wrappers removed
  - R57.B.3: All test files use ClaudeBackend instances directly (no singleton)
  - R57.B.4: `tests/backends/claude.test.ts` created as new test home

- R57.C: ✅ buildProjectState pulled from interface, shared utility extracted (Phase: 57-C)
  - R57.C.1: `buildProjectState` removed from SessionBackend
  - R57.C.2: Standalone `buildProjectState(backend, projectInfo)` utility composes resolveState + enrichProject + getSubagents
  - R57.C.3: `computeLastUpdated()` added to interface (backends differ: Claude = JSONL mtime, OpenCode = SQL MAX)
  - R57.C.4: `collectBackendStates()` utility extracted, deduplicates server.ts + cli.ts loops
  - R57.C.5: Backward-compat re-exports removed from sessions.ts; consumers import from final modules

### Out of Scope

- Splitting `public/index.html` CSS into separate file
- Nix flake `npmDepsHash` automation
- Separating config into ServerConfig/BackendConfig (deferred until server features grow)
- Notification field handling (remains ClaudeBackend-specific post-processing)

## Questions & Investigations

- [x] Q: Can `resolveState` be called identically by both backends in the shared `buildProjectState` utility?
  - Resolution: ClaudeBackend.resolveState() is the single entry point — internal calls to readStatusLog + resolveState free fn moved into the interface method. Shared utility calls `backend.resolveState(projectInfo)` for both backends.
  - Outcome: Works correctly. ClaudeBackend.resolveState reads status log + JSONL mtime internally; OpencodeBackend.resolveState queries SQLite + plugin status log.

- [x] Q: Where does `lastUpdated` computation live in the shared utility?
  - Resolution: Added `computeLastUpdated(projectInfo): Promise<string | null>` to SessionBackend interface. Claude = JSONL mtime via fs.stat with fallback to latest event; OpenCode = SQL MAX(time_updated) across parent + children.
  - Outcome: One-liner per backend, called by shared `buildProjectState` utility.

- [x] Q: How do Claude-specific notification fields survive the split?
  - Resolution: ClaudeBackend wraps the shared `buildProjectState` to add notification fields from status events. OpencodeBackend uses the shared utility directly (no notification fields needed).
  - Outcome: Clean separation — shared utility assembles base ProjectState, ClaudeBackend adds its extra fields.

- [x] Q: How many tests break from the singleton removal?
  - Result: 29 `replaceDefaultStore` calls in sessions.test.ts replaced with direct ClaudeBackend instances. 2 in server.test.ts and 1 in integration.test.ts removed (vestigial). 4 singleton/free-function tests rewritten. All 303 tests pass.
  - Outcome: Singleton eliminated; all tests use ClaudeBackend instances directly.

## Tasks

### Phase 57-A: Decompose sessions.ts

- [x] Create `src/types.ts` — extract ProjectInfo, ProjectState, SubagentInfo, BackendSource from sessions.ts (R57.A.1)
  - AC: `src/types.ts` exports ProjectInfo, ProjectState, SubagentInfo, BackendSource
  - AC: `src/sessions.ts` re-exports from `./types` (backward compat)
  - AC: All 291 tests pass, typecheck clean, lint clean

- [x] Create `src/project-utils.ts` — extract utility functions from sessions.ts (R57.A.2)
  - AC: `src/project-utils.ts` exports: filterStaleProjects, disambiguateProjectNames, scanProjects, readFirstLine, findLatestJSONL, isFirstLineRecord, sessionDirFromJSONL, readProjectInfo, CLOSED_PROJECT_TTL_MS, MAX_STATUS_LOG_BYTES, DEFAULT_CLAUDE_DIR
  - AC: `src/sessions.ts` re-exports from `./project-utils` (backward compat)
  - AC: All 291 tests pass, typecheck clean, lint clean

- [x] Create `src/status-writer.ts` — extract hook/status functions from sessions.ts (R57.A.3)
  - AC: `src/status-writer.ts` exports: writeStatusEvent, writeStatusTruncate, writeSubagentStatus, writeNotificationStatus, mapHookEventToState
  - AC: `src/sessions.ts` re-exports from `./status-writer` (backward compat)
  - AC: All 291 tests pass, typecheck clean, lint clean

### Phase 57-B: Consolidate SessionStore into ClaudeBackend

- [x] Move SessionStore internals into ClaudeBackend (R57.B.1)
  - AC: `ClaudeBackend` has all SessionStore methods: readSessionTail, getSubagentInfos (as getSubagents), buildProjectState
  - AC: ClaudeBackend.resolveState() is the single entry point (calls readStatusLog + session-core resolveState internally)
  - AC: `src/sessions.ts` no longer exports SessionStore class
  - AC: `src/backends/claude.ts` no longer imports SessionStore from sessions.ts
  - AC: All 291 tests pass, typecheck clean, lint clean

- [x] Remove singleton pattern and compat wrappers (R57.B.2)
  - AC: getDefaultStore, replaceDefaultStore, _defaultStore deleted
  - AC: readSessionTail, getProjectState, buildProjectState, getSubagentInfos free-function wrappers deleted
  - AC: `src/sessions.ts` re-exports removed (consumers import from final modules)

- [x] Update test files to use ClaudeBackend directly (R57.B.3)
  - AC: `tests/sessions.test.ts` — all replaceDefaultStore calls replaced with direct ClaudeBackend instances
  - AC: `tests/server.test.ts` — 2 vestigial replaceDefaultStore calls removed
  - AC: `tests/integration.test.ts` — 1 vestigial replaceDefaultStore call removed
  - AC: All 291 tests pass

- [x] Create `tests/backends/claude.test.ts` with core ClaudeBackend tests (R57.B.4)
  - AC: Tests for scanProjects, resolveState, enrichProject, getSubagents, buildProjectState, projectKey
  - AC: At least 10 tests covering: project scanning, state resolution (running/stopped/waiting), enrichment, sub-agent discovery via filesystem
  - AC: No singleton usage — creates ClaudeBackend instances directly

### Phase 57-C: Interface cleanup + shared utilities

- [x] Extract buildProjectState from SessionBackend interface (R57.C.1, R57.C.2)
  - AC: `buildProjectState` removed from `SessionBackend` interface
  - AC: Standalone `async function buildProjectState(backend: SessionBackend, info: ProjectInfo): Promise<ProjectState>` in `src/backends/build-project-state.ts`
  - AC: computeLastUpdated() added to SessionBackend interface (Claude = JSONL mtime, OpenCode = SQL MAX)
  - AC: Shared utility calls: backend.resolveState(), backend.computeLastUpdated(), backend.enrichProject(), backend.getSubagents()
  - AC: OpencodeBackend no longer has its own buildProjectState method
  - AC: ClaudeBackend wraps the shared utility to add notification fields

- [x] Extract collectBackendStates utility (R57.C.4)
  - AC: Single function `collectBackendStates(backends): Promise<Map<string, ProjectState>>` shared by server.ts and cli.ts
  - AC: server.ts's `buildStateForBackend` and cli.ts's `buildProjectMap` replaced with calls to the utility
  - AC: All 291 tests pass

- [x] Finalize imports: remove backward-compat re-exports (R57.C.5)
  - AC: No consumer imports from `src/sessions.ts` re-exports (all use final module paths)
  - AC: `src/sessions.ts` reduced to 0 lines (deleted or re-export only session-core + session-enrichment)
  - AC: All 291 tests pass, typecheck clean, lint clean

- [x] Update project docs and CLAUDE.md
  - AC: `00-ccmon.md` Phases section updated with Phase 57 ✅
  - AC: `00-ccmon.md` Files section updated with new module paths, deleted files
  - AC: `CLAUDE.md` Key files section updated with new module structure

## Files

- **src/types.ts**: ProjectInfo, ProjectState, SubagentInfo, BackendSource (new)
- **src/project-utils.ts**: filterStaleProjects, disambiguateProjectNames, scanProjects, JSONL helpers, constants (new)
- **src/status-writer.ts**: writeStatusEvent, writeStatusTruncate, writeSubagentStatus, writeNotificationStatus, mapHookEventToState (new)
- **src/sessions.ts**: Reduced to session-core + session-enrichment re-exports only; eventually deleted (modified → deleted)
- **src/backends/claude.ts**: Absorbs SessionStore; becomes canonical Claude backend (modified)
- **src/backends/opencode.ts**: Removes buildProjectState; adds computeLastUpdated (modified)
- **src/backends/types.ts**: Removes buildProjectState; adds computeLastUpdated (modified)
- **src/backends/build-project-state.ts**: Shared buildProjectState utility (new)
- **src/backends/collect-states.ts**: Shared collectBackendStates utility (new)
- **src/server.ts**: Uses collectBackendStates + standalone buildProjectState (modified)
- **src/cli.ts**: Uses collectBackendStates + standalone buildProjectState; imports from final modules (modified)
- **tests/sessions.test.ts**: Rewritten to use ClaudeBackend directly; split into test modules (modified)
- **tests/backends/claude.test.ts**: New ClaudeBackend unit tests (new)
- **tests/server.test.ts**: ReplaceDefaultStore calls removed (modified)
- **tests/integration.test.ts**: ReplaceDefaultStore call removed (modified)
- **CLAUDE.md**: Key files section updated (modified)
- **00-ccmon.md**: Phase + Files updated (modified)
