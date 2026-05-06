# Phase 49: Review Fixes 3

## Context

See [00-ccmon](00-ccmon.md). 21 REVIEW comments from 4 review agents (style, correctness, architecture, requirements) planted during a second review pass of the Phase 44-45 multi-backend work.

## Tasks

### High Priority

- [x] H1: Fix `disambiguateProjectNames` mutation breaking `--project` filter (sessions.ts:378)
  - `disambiguateProjectNames` mutates `projectName` in place, but CLI `--project` filter uses original basename
  - Fix: either restore original after filtering, or apply filter before disambiguation
  - AC: `--project foo` matches project whose cwd basename is "foo" even after disambiguation

- [x] H2: Eliminate DRY `buildProjectState()` duplication (claude.ts:15-23 + sessions.ts:1161)
  - Both `ClaudeBackend.buildProjectState()` and private `sessions.ts buildProjectState()` contain ~65 identical lines
  - Fix: export `buildProjectState` from sessions.ts, have `ClaudeBackend.buildProjectState()` delegate to it
  - AC: Single implementation. All 258+ tests pass.

- [x] H3: Fix `buildProjectState()` bypassing `enrichProject()` (claude.ts:25-31)
  - `ClaudeBackend.buildProjectState()` calls `readSessionTail()` directly instead of `this.enrichProject()`
  - Fix: have buildProjectState call `this.enrichProject()` or accept that it's an orchestrator
  - AC: Interface contract is clear. `enrichProject()` is either the primary path or documented as secondary.

- [x] H4: Fix two-tier caching clearing ALL backends on temporary failure (server.ts:45-54)
  - `rescanAllBackends()` clears `stateMap` entirely, then re-populates per-backend. If one backend throws, all state is lost
  - Fix: error-isolate per-backend: clear only affected backend keys, not entire map
  - AC: Temporary failure in one backend does not drop projects from other healthy backends

### Medium Priority

- [x] M1: Move `BackendSource` type to sessions.ts (sessions.ts:5-8)
  - `BackendSource` is defined in backends/types.ts but used in ProjectInfo in sessions.ts
  - Fix: move type definition to sessions.ts, update backends/types.ts to import from sessions.ts
  - AC: No cross-module circular-ish dependency

- [x] M2: Fix hybrid import strategy (sessions.ts:12-18)
  - File both re-exports from session-core AND imports directly, confusing consumers
  - Fix: remove direct value imports, use re-exported symbols locally
  - AC: Single import strategy. No dual-import pattern.

- [x] M3: Remove redundant re-imports (sessions.ts:20-22)
  - `readStatusLog`, `resolveState`, `STATUS_LOG_FILE` are both re-exported (lines 24-32) and imported again (lines 34-35)
  - Fix: remove the duplicate value-import on line 35, keep only `import type { StatusEvent }`
  - AC: No duplicate imports

- [x] M6: Fix `onUpdate` callback optional parameter inconsistency (types.ts:30-39)
  - Claude passes partial ProjectInfo, OpenCode passes nothing; server always does full rescan anyway
  - Fix: consider making parameter undefined-only (remove the maybeProject parameter since it's never used for targeted updates) OR document the partial-fill contract
  - AC: Interface is honest about what callers can expect

- [x] M7: Extract arg parsing helpers (cli.ts:31-38)
  - `--project`, `--max-age`, `--port`, `--host` use repetitive indexOf+value-extraction patterns
  - Fix: extract `parseStringFlag(argv, name)` and `parseNumberFlag(argv, name)` helpers
  - AC: Adding a new flag requires 1 line, not 5

- [x] M8: Document sub-agent `.json` format difference (cli.ts:315-322)
  - Sub-agent status uses `.json` (single object), main uses `.jsonl` (NDJSON)
  - Fix: add clarifying comment explaining the intentional format difference (single stop state vs event sequence)
  - AC: Comment explains why the inconsistency exists

- [x] M9: Split `enrichProject` into private methods (opencode.ts:104-107)
  - 160-line method handling 3 concerns: session name, tasks, messages/model/tokens
  - Fix: extract `enrichSessionName`, `enrichTasks`, `enrichMessages` private methods
  - AC: enrichProject is <20 lines orchestrating 3 private method calls

### Low Priority

- [x] L1: Remove unused `_i` parameter in map callback (opencode.ts:136)
  - `todos.map((t, _i) => ...` — `_i` is unused
  - Fix: change to `todos.map((t) => ...`
  - AC: No unused parameters

- [x] L2: Remove duplicate comment block (sessions.ts:476)
  - Lines 476-483 contain two comments explaining the same agentDescriptions cache behavior
  - Fix: remove the second comment, keep the first
  - AC: Single, non-redundant comment

- [x] L3: Remove duplicate token merge strategy comments (sessions.ts:789)
  - Comments in scanEnrichment duplicate mergeEnrichment docstring (lines 873-876)
  - Fix: remove the inline comments, keep the function-level docstring
  - AC: Token merge strategy documented in one place

- [x] L4: Remove "former countActiveSubagents" evolution reference (sessions.ts:1328)
  - Comment references removed code (code evolution history)
  - Fix: remove the second sentence referencing "former countActiveSubagents"
  - AC: Comment describes current state only

- [x] L5: Simplify `mergeCliOverrides` per-field checks (config.ts:50)
  - 4 repetitive `if (overrides.X !== undefined)` blocks
  - Fix: use spread pattern `return { ...config, ...pickDefined(overrides) }`
  - AC: One-line entry for each config field

- [x] L6: Remove unnecessary type assertion (server.ts:206)
  - `server.port as number` — Bun.serve() already returns `number`
  - Fix: remove `as number` cast
  - AC: No type assertion where type is already correct

- [x] L7: Document Linux-specific env restoration (env.ts:3)
  - `/proc/self/environ` is Linux-only, `process.platform !== "linux"` guard makes it a no-op elsewhere
  - Fix: add doc comment noting this is a Linux-only sandbox workaround
  - AC: Comment clarifies platform scope

- [x] L8: Fix dead type overload in test helper (tests/sessions.test.ts:961)
  - `makeUserEntry(content: string | object[])` — both branches produce identical `{ role: "user", content }`
  - Fix: simplify type to `string` only, remove dead `object[]` branch
  - AC: No dead code path. Test helper only accepts `string`.

## Files

- **src/sessions.ts**: Import hygiene (M1-M3, L2-L4), export buildProjectState (H2), disambiguateProjectNames fix (H1)
- **src/backends/claude.ts**: Delegate buildProjectState to sessions.ts (H2), call enrichProject (H3), update onUpdate (M6)
- **src/backends/opencode.ts**: Split enrichProject (M9), remove unused param (L1)
- **src/backends/types.ts**: onUpdate callback cleanup (M6), BackendSource import (M1)
- **src/config.ts**: mergeCliOverrides simplification (L5)
- **src/cli.ts**: Arg parsing helpers (M7), sub-agent format doc (M8)
- **src/env.ts**: Platform scope doc (L7)
- **src/server.ts**: Error-isolate per-backend clearing (H4), remove type assertion (L6)
- **tests/sessions.test.ts**: Fix makeUserEntry dead overload (L8)
