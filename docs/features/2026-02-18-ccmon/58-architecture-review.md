# 58 Phase: Architecture Review

## Context

See [00-ccmon](00-ccmon.md). Project has shipped all 57 phases, 86 requirements, 303 tests. The architecture was refactored in Phase 57 (sessions.ts split, SessionStore absorbed, shared utilities extracted), but several cross-cutting concerns remain that will affect future maintainability as backends diverge (Claude vs OpenCode), the frontend grows, and new subcommands are added.

An architecture review was conducted in May 2026 examining all 15 source files, 8 test files, the HTML frontend, and the OpenCode plugin. Findings are catalogued below as actionable refactor opportunities grouped by impact.

## Requirements

These expand on project doc requirements by defining post-ship architecture improvements:

- R87: ⬜ Enrichment types decoupled from Claude JSONL internals (Phase: Architecture Review)
  - R87.1: `SessionEnrichment` and `TaskInfo` moved to `src/types.ts` or new `src/enrichment-types.ts` — cross-backend contract, not Claude implementation detail
  - R87.2: `SessionTailInfo`, `SessionTailCache`, `computeReadRange`, `scanEnrichment`, `mergeEnrichment` stay in `session-enrichment.ts` as Claude-specific parse helpers
  - R87.3: `OpencodeBackend.enrichProject()` imports from contract types, not from Claude parse module

- R88: ⬜ `ProjectInfo` / `SubagentInfo` use discriminated union on `source` instead of sentinel empty strings (Phase: Architecture Review)
  - R88.1: `ProjectInfo` becomes union: `{ source: "claude"; ...; latestJSONL: string } | { source: "opencode"; ... }`
  - R88.2: `SubagentInfo.jsonlPath` becomes optional (`jsonlPath?: string`)
  - R88.3: Code paths that touch `latestJSONL` must narrow on `source` first

- R89: ⬜ `SessionBackend` gets optional `getNotification(projectInfo): NotificationMeta | null` method to eliminate asymmetrical `buildProjectState` wrapping (Phase: Architecture Review)
  - R89.1: Shared `buildProjectState` calls `backend.getNotification(projectInfo)` if it exists
  - R89.2: `ClaudeBackend` implements it from status event scan
  - R89.3: `OpencodeBackend` returns null (no notifications)
  - R89.4: `ClaudeBackend.buildProjectState` wrapper is removed

- R90: ⬜ CLI split into command modules for testability (Phase: Architecture Review)
  - R90.1: `src/cli/main.ts` — entry point, parses `process.argv`, dispatches
  - R90.2: `src/cli/commands/dump.ts`, `status.ts`, `sub.ts`, `serve.ts` — each is `(args, deps) => Promise<exitCode>`
  - R90.3: Unit tests import commands directly, no subprocess spawn

- R91: ⬜ Structured logger replaces 36 ad-hoc console.warn/console.error/process.stderr.write sites (Phase: Architecture Review)
  - R91.1: `src/log.ts` with `log.info(msg)`, `log.warn(msg, fields?)`, `log.error(msg, err?, fields?)` typed API
  - R91.2: Output NDJSON to stderr by default
  - R91.3: `LOG_LEVEL` env var override (default: warn+error)

- R92: ⬜ `resolveState` priority chain replaced with composable rule list (Phase: Architecture Review)
  - R92.1: `type ResolutionRule = (ctx: ResolutionContext) => SessionState | null`
  - R92.2: `RESOLUTION_RULES` array encodes priority: unresolvedPermission → sessionEnd → stop → recentEvent → jsonlActivity → stopFailure
  - R92.3: Each rule independently testable; StopFailure interaction becomes natural, not inline conditions

- R93: ⬜ JSONL/SQLite payload parsers centralized in `src/parsers/` (Phase: Architecture Review)
  - R93.1: `src/parsers/claude-jsonl.ts` — typed parsers for user/assistant/queue-operation/custom-title entries
  - R93.2: `src/parsers/opencode-db.ts` — typed parsers for session/message/part/todo rows
  - R93.3: All parsers return `Result<T, string>` (success value or error message)
  - R93.4: `as Record<string, unknown>` removed from production code

- R94: ⬜ Frontend HTML split into ES modules (Phase: Architecture Review)
  - R94.1: `public/backend-manager.js` — WebSocket connection management, reconnect logic
  - R94.2: `public/render.js` — card rendering, context bar, agent rows
  - R94.3: `public/flash.js` — flash animation state management
  - R94.4: `public/index.html` loads via `<script type="module" src="...">`

- R95: ⬜ Time constants centralized in `src/timing.ts` (Phase: Architecture Review)
  - R95.1: All magic-number thresholds in one file with rationale comments
  - R95.2: Config-level overrides supported per environment (test vs production)

- R96: ⬜ `tests/sessions.test.ts` split into per-module test files (Phase: Architecture Review)
  - R96.1: `tests/session-core.test.ts`
  - R96.2: `tests/session-enrichment.test.ts`
  - R96.3: `tests/project-utils.test.ts`
  - R96.4: `tests/status-writer.test.ts`
  - R96.5: Same test count, faster discovery, targeted test runs

- R97: ⬜ Server stateMap triple-Map simplified to `Map<SessionBackend, Map<string, ProjectState>>` (Phase: Architecture Review)
  - R97.1: Remove unused `backendIndex` Map
  - R97.2: Replace `stateMap + backendToKeys` with nested Map structure
  - R97.3: Partial-failure isolation preserved

- R98: ⬜ `backends/index.ts` factory separated from I/O (Phase: Architecture Review)
  - R98.1: Each backend's setup logic lives in its own factory function
  - R98.2: `createBackends()` becomes pure orchestration, calls per-backend factories

## Questions & Investigations

### Pre-existing investigations (May 2026 initial review)

- [x] Q: How many `as Record<string, unknown>` casts exist in source?
  - Result: 37 casts across `session-enrichment.ts` (34), `backends/opencode.ts` (7), `backends/claude.ts` (2), `status-writer.ts`, `project-utils.ts`
  - Outcome: Centralized parsers would eliminate all of them.

- [x] Q: What is the silent catch count?
  - Result: 47 `} catch {` blocks in src/ that swallow errors without logging.
  - Outcome: Most are legitimate (best-effort JSON parsing in loops), but ~10-15 would benefit from structured logging.

- [x] Q: Is `backendIndex` Map in server.ts actually used?
  - Result: No. It's populated in `buildStateForBackend` but never read. Dead code.
  - Outcome: Can be safely removed.

- [x] Q: Does `_fetchStateEvents` cause double-read of status log?
  - Result: Yes. `resolveState()` calls `_fetchStateEvents` which reads `readStatusLog` + resolves. `buildProjectState()` then calls `readStatusLog` a second time for notification extraction. Two reads per project on every refresh.
  - Outcome: R89's `getNotification()` on the interface eliminates this.

### Deep research findings (May 2026 agents)

- [x] Q: R87+R88 — who imports what from session-enrichment? (explore agent)
  - Result: 7 files import from session-enrichment. Only `backends/claude.ts` imports functions (`computeReadRange`, `scanEnrichment`, `mergeEnrichment`, `scanTaskCreateUpdate`). All others import only types (`SessionEnrichment`, `TaskInfo`, `SessionTailInfo`, `SessionTailCache`).
  - `latestJSONL` consumers: 4 sites in `backends/claude.ts`, all already wrapped in try/catch. 6 test files construct ProjectState with `latestJSONL` literals. `backends/opencode.ts` sets sentinel `latestJSONL: ""` at line 79 — removable.
  - `jsonlPath` consumer: only `backends/claude.ts` sets it (real path). `backends/opencode.ts` sets sentinel `jsonlPath: ""` at line 438 — removable. `project-utils.ts:sessionDirFromJSONL` reads a string param, not SubagentInfo.
  - Spread analysis: `build-project-state.ts:19` does `{ ...projectInfo }` — compatible with discriminated union.
  - Ordering: R87 first (mechanical, zero risk), then R88 (type narrowing changes, ~10-15 test literal updates).

- [x] Q: R89+R92 — resolveState double-read and test coverage (explore agent)
  - Result: Double-read confirmed at `_fetchStateEvents:242` + `buildProjectState:63`. `_fetchStateEvents` returns `events` unused by `resolveState()` — only `state` is extracted at line 90.
  - resolveState callers: `ClaudeBackend._fetchStateEvents` (line 252), `writeNotificationStatus` (session-core.ts exported fn, line 54 in status-writer). 22 tests in `sessions.test.ts`.
  - Priority chain: P1→PermissionRequest, P2→SessionEnd, P3→Stop/PostToolUse/UserPromptSubmit, P4→JSONL mtime fallback, P4.5→StopFailure→error, P5→default stopped. Critical interaction: P4 skips returning `running` when latest event is StopFailure AND fresh JSONL (recent failure's write tail, not new activity).
  - Missing test: recent StopFailure (<60s) + fresh JSONL (<60s) → should return `error` (not `running`). Existing test at line 3266 only covers old StopFailure (90s) + fresh JSONL.
  - Ordering: Independent. R92 then R89 recommended (logic first, interface second).

- [x] Q: R93 — catalog all JSON shapes (explore agent)
  - Result: 13 distinct shapes across the codebase. 6 core shapes need new typed parsers: Claude JSONL entry (5 variants by `type` field), ContentBlock (3 variants), ToolUse inputs (4 variants: TaskCreate/TaskUpdate/Task/TodoWrite), QueueOperation content, OpenCode message data (2 variants by role), OpenCode part data (2 variants). 5 shapes already typed (StatusEvent, StatusFileLegacy, JSONL first line, HookPayload, CcmonConfig).
  - Overlaps: Claude TextBlock = OpenCode TextPart (identical shape, `{type: "text", text: string}`). Separate types recommended for source clarity.
  - File structure: `src/parsers/claude-jsonl.ts` (~250-320 LOC) + `src/parsers/opencode-db.ts` (~90-130 LOC).
  - Total: ~340-450 LOC new parser modules vs net +300-400 LOC (untyped access removed from handlers).

- [x] Q: R91+R95 — log site catalog and duplicate constants (explore agent)
  - Result: 36 log sites total — 7 `console.warn` (1 missing `ccmon:` prefix at `opencode.ts:191`), 4 `console.error` (all in watcher.ts, 2 use two-arg format), 25 `process.stderr.write` (19 in CLI, 5 in server.ts, 1 in opencode.ts).
  - 4 duplicate constants: `SUBAGENT_ACTIVE_THRESHOLD_MS` (claude.ts + opencode.ts), `SUBAGENT_EXPIRY_MS` (same), `STATUS_LOG_TAIL_BYTES` (session-core.ts + status-writer.ts), poll interval defaults (opencode.ts + backends/index.ts). 25 total time/magic-number values to centralize.
  - Frontend has 7 independent timing constants (reconnect backoff 1s/30s, flash window 5s, zombie detection 60s, UI refresh 5s) — expected to differ from backend.
  - Ordering: R95 first (mechanical, pure refactor). R91 second (uses timing.ts for timestamp metadata, avoids new magic numbers).

- [x] Q: R90 — CLI dependency graph and test convertibility (explore agent)
  - Result: 5 functions to split: runDump (~29 LOC, backends + project-utils), runDumpWatch (~52 LOC, same + process events), runStatus (~112 LOC, status-writer + session-core + project-utils + fs), runSub (~36 LOC, WebSocket + config), serve (~37 LOC, createBackends + startServer + config).
  - Shared helpers: exit/parseStringFlag/parseNumberFlag → `helpers.ts`. readStdin/resolveProjectDir/HookPayload/isHookPayload → status command only.
  - Test convertibility: 6/23 tests convertible to direct calls (dump variants), 11/23 convertible if runStatus accepts optional `input?: string` param (currently reads process.stdin.fd), 6/23 must stay integration (watch lifecycle, sub network). Total 17/23 direct after refactor.
  - No circular dependency risks — strict DAG: main.ts → commands/* and helpers.ts, no reverse imports.
  - File structure: `src/cli/main.ts` (entry, ~65 LOC), `src/cli/helpers.ts` (~15 LOC), `src/cli/commands/{dump,status,serve,sub}.ts`.

- [x] Q: R94+R96+R97 — frontend JS, test split, triple-Map (explore agent)
  - Result (R94): 583 lines of inline JS. Clean module DAG: main.js → backend-manager.js → render.js → utils.js (no cycles). CSS stays inline (505 lines of `<style>`). HTML shrinks from 1112 → ~530 lines after JS extraction.
  - Result (R96): 28 describe blocks across 3596 lines. Map: session-core.test.ts (380 LOC, readStatusLog + resolveState), status-writer.test.ts (380 LOC), project-utils.test.ts (500 LOC), expand backends/claude.test.ts from 289 to ~2700 LOC (all readSessionTail/getProjectState/getSubagentInfos tests go here since they test through the backend class). Shared helper `makeFirstLine()` duplicated in two files — move to `_helpers.ts`.
  - Result (R97): `backendIndex` verified unused — 0 reads, 3 writes only. Nested Map structure `Map<SessionBackend, Map<string, ProjectState>>` replaces all three Maps. `buildStateForBackend()` shrinks from 16 to 3 lines. Net -15 LOC. `currentFilteredState()` iterates `.flatMap()` pattern. Minimal risk.

## Tasks

### Dependency graph

```
R95 (time constants)  ──┐
R97 (triple-Map)         │  Tier 1: Quick wins, zero risk, mechanical
R87 (enrichment contract) │
                         │
R88 (discriminated union) ←── requires R87
R91 (logger)              ←── can import from R95
R98 (factory I/O)         │  Tier 2: Structural improvements
R89 (getNotification)     │
                         │
R92 (composable rules)    │
R90 (CLI split)           │  Tier 3: Deeper changes, more LOC
R96 (test split)          │
R93 (parsers)             ←── benefits from R87 types
R94 (frontend split)      │
```

### Tier 1 — Quick Wins (Sprint 1): mechanical, zero-risk, high ROI

- [x] **T1.1** Extract enrichment contract: move `SessionEnrichment` + `TaskInfo` to `src/types.ts` (R87)
  - Priority: **High** | Effort: **Quick** (~10 LOC net) | Depends on: nothing
  - AC: `SessionEnrichment` and `TaskInfo` defined in `src/types.ts`, re-exported from `session-enrichment.ts`
  - AC: `backends/opencode.ts` imports `SessionEnrichment` from `../types` instead of `../session-enrichment`
  - AC: 6 import sites updated (`types.ts`, `sessions.ts`, `backends/types.ts`, `backends/opencode.ts`, `backends/build-project-state.ts`, `tests/server.test.ts`). Only `backends/claude.ts` keeps function imports from session-enrichment.
  - AC: All 303 tests pass

- [x] **T1.2** Centralize time constants in `src/timing.ts` (R95)
  - Priority: **High** | Effort: **Quick** (~65-80 LOC net) | Depends on: nothing
  - AC: `src/timing.ts` exports all named time/milli constants: `SUBAGENT_ACTIVE_THRESHOLD_MS`, `SUBAGENT_EXPIRY_MS`, `JSONL_ACTIVE_THRESHOLD_MS`, `OPENCODE_ACTIVE_THRESHOLD_MS`, `BROADCAST_INTERVAL_MS`, `CLOSED_PROJECT_TTL_MS`, `PERMISSION_STALE_MS`, `PERMISSION_RESOLVE_GAP_MS`, `DEBOUNCE_MS`, `BACKOFF_INITIAL_MS`, `BACKOFF_MAX_MS`, `DEFAULT_POLL_INTERVAL_MS`, `DEFAULT_STATUS_POLL_INTERVAL_MS`, `SUBAGENT_STOP_GRACE_MS`, `STATUS_LOG_TAIL_BYTES`, `MAX_STATUS_LOG_BYTES`, `MS_PER_HOUR`, `MAX_RETRIES`
  - AC: 4 duplicates eliminated: `SUBAGENT_ACTIVE_THRESHOLD_MS` (claude.ts + opencode.ts), `SUBAGENT_EXPIRY_MS` (same), `STATUS_LOG_TAIL_BYTES` (session-core.ts + status-writer.ts), poll intervals (opencode.ts + backends/index.ts)
  - AC: Hardcoded numbers replaced: 200ms debounce (opencode.ts:496), 5000ms busy_timeout (backends/index.ts), 3600*1000 hours→ms (project-utils.ts)
  - AC: All consumers import from `src/timing.ts`. Frontend timing constants remain independent (different runtime)
  - AC: All 303 tests pass

- [x] **T1.3** Simplify server stateMap: remove dead `backendIndex`, replace triple-Map with nested Map (R97)
  - Priority: **Medium** | Effort: **Quick** (~-15 LOC net) | Depends on: nothing
  - AC: `backendIndex` Map deleted (confirmed unused: 0 reads, 3 writes)
  - AC: `stateMap + backendToKeys` replaced with `backendStates: Map<SessionBackend, Map<string, ProjectState>>`
  - AC: `buildStateForBackend()` shrinks from 16 to 3 lines: `backendStates.set(backend, new Map(newStates))`
  - AC: `currentFilteredState()` iterates nested map: `[...backendStates.values()].flatMap(m => [...m.values()])`
  - AC: `rescanAllBackends()`, `rescanBackend()`, `broadcastCurrent()` work unchanged
  - AC: All server tests pass

### Tier 2 — Structural Improvements (Sprint 2): interface changes, add one new utility

- [x] **T2.1** Switch `ProjectInfo` / `SubagentInfo` to discriminated union on `source` (R88)
  - Priority: **High** | Effort: **Moderate** (~70 LOC net) | Depends on: T1.1 (R87)
  - AC: `ProjectInfo` becomes discriminated union: `{ source: "claude"; ...; latestJSONL: string } | { source: "opencode"; ... }`
  - AC: `SubagentInfo.jsonlPath` becomes optional (`jsonlPath?: string`)
  - AC: `latestJSONL: ""` sentinel removed from `backends/opencode.ts:79` (scanProjects)
  - AC: `jsonlPath: ""` sentinel removed from `backends/opencode.ts:438` (getSubagents)
  - AC: 4 `.latestJSONL` access sites in `backends/claude.ts` guarded with type narrowing on `source`
  - AC: `ProjectState` continues to extend (union-aware spread in `build-project-state.ts` works as-is)
  - AC: ~10-15 test object literal sites updated to include discriminant (`source: "claude"` or `source: "opencode"`)

- [x] **T2.2** Add structured logger `src/log.ts` (R91)
  - Priority: **Medium** | Effort: **Moderate** (~45-65 LOC + 36 site replacements) | Depends on: T1.2 (R95) recommended
  - AC: `src/log.ts` exports `log.error(msg, err?, fields?)`, `log.warn(msg, fields?)`, `log.info(msg, fields?)`
  - AC: Output NDJSON to stderr: `{"level":"error","ts":"2026-05-08T21:00:00.000Z","msg":"...","err":"...","fields":{}}`
  - AC: `LOG_LEVEL` env var (default: `warn`) — `debug` shows info, `silent` suppresses all
  - AC: All 7 `console.warn` sites replaced, all 4 `console.error` sites replaced, all 25 `process.stderr.write` sites in CLI/server/opencode replaced. CLI user-facing errors preserved with distinct formatting (e.g. `Error: --project requires a value\n` still goes to stderr as-is, just routed through logger)
  - AC: Inconsistent prefixes fixed: `"Enrich: failed"` → `log.warn("failed to read session title", err)`, `"OpenCode backend:"` → `log.warn("database not found, skipping", { path })`
  - AC: All tests pass (log output goes to stderr, tests capture stderr as needed)

- [x] **T2.3** Add `getNotification()` to SessionBackend, remove ClaudeBackend wrapper (R89)
  - Priority: **Medium** | Effort: **Moderate** (~60-90 LOC net) | Depends on: nothing, R92 suggested first
  - AC: `SessionBackend.getNotification?(projectInfo: ProjectInfo): Promise<NotificationMeta | null>` added to interface
  - AC: `ClaudeBackend` implements it from status log events (backward scan for most recent Notification event)
  - AC: `OpencodeBackend` returns `null` (no notification support)
  - AC: Shared `buildProjectState` calls `backend.getNotification?.(projectInfo)` and spreads to result
  - AC: `ClaudeBackend.buildProjectState()` wrapper deleted — `ClaudeBackend.buildProjectState` becomes just `sharedBuildProjectState(this, projectInfo)`
  - AC: Double-read of status log eliminated — `_fetchStateEvents()` reads once, `getNotification()` reads from same events (or independently; both scoped to 8KB tail)
  - AC: All 303 tests pass

- [x] **T2.4** Separate backend factory from I/O in `backends/index.ts` (R98)
  - Priority: **Low** | Effort: **Quick** (~20 LOC net) | Depends on: nothing
  - AC: `createClaudeBackend(entry): ClaudeBackend | null` and `createOpencodeBackend(entry): { backend: OpencodeBackend, close: () => void } | null` per-backend factory functions
  - AC: DB open + existsSync + PRAGMA logic moves into `createOpencodeBackend()`
  - AC: `createBackends()` becomes pure orchestration: iterates entries, calls per-backend factories, collects results
  - AC: All tests pass (no test changes needed — `createBackends` API unchanged)

### Tier 3 — Deeper Changes (Sprint 3): more LOC, broader impact

- [x] **T3.1** Refactor resolveState with composable rules (R92)
  - Priority: **Medium** | Effort: **Moderate** (~100-150 LOC net) | Depends on: nothing
  - AC: `ResolutionRule = (ctx: ResolutionContext) => SessionState | null`, `RESOLUTION_RULES` ordered array
  - AC: 5 rules: `unresolvedPermissionRule`, `sessionEndRule`, `stopOrActivityRule`, `jsonlActivityRule`, `stopFailureRule`
  - AC: Each rule independently testable via `describe.each` in tests
  - AC: StopFailure interaction (old P4↔P4.5) handled by `jsonlActivityRule` short-circuit: skip `running` return when recent StopFailure + recent JSONL co-exist, letting `stopFailureRule` return `error`
  - AC: Missing test added: recent StopFailure (<60s) + fresh JSONL mtime (<60s) → returns `error` (not `running`)
  - AC: Existing 22 resolveState tests pass unchanged

- [x] **T3.2** Split CLI into command modules (R90)
  - Priority: **Medium** | Effort: **Extensive** (~440 LOC new + 437 LOC deleted + test restructuring) | Depends on: nothing
  - AC: `src/cli/main.ts` (~65 LOC): arg parsing, dispatch, usage text, `VERSION`
  - AC: `src/cli/helpers.ts` (~15 LOC): `exit()`, `parseStringFlag()`, `parseNumberFlag()`
  - AC: `src/cli/commands/dump.ts`: `runDump(config, projectFilter?)` (static) + `runDumpWatch(config, projectFilter?)` (streaming)
  - AC: `src/cli/commands/status.ts`: `runStatus(claudeDir?)` with optional `input?: string` param for testability (defaults to `process.stdin.fd`)
  - AC: `src/cli/commands/serve.ts`: `runServe(config)` extracted from inline dispatch
  - AC: `src/cli/commands/sub.ts`: `runSub(config)`
  - AC: `package.json` scripts updated: `"build"` → `src/cli/main.ts`, `"dump"`/`"status"`/`"serve"`/`"sub"` npm scripts point to main.ts
  - AC: `tests/cli.test.ts`: 17/23 tests become direct function calls (no `spawnSync`), 6 remain integration (watch lifecycle + sub network). `CLI_PATH` updated to `src/cli/main.ts`.
  - AC: No circular dependencies — strict DAG confirmed

- [x] **T3.3** Split `tests/sessions.test.ts` into per-module test files (R96)
  - Priority: **Low** | Effort: **Moderate** (~3400 LOC reorganized) | Depends on: T1.1 (types stable), T2.1 (union stable)
  - AC: `tests/session-core.test.ts` (~380 LOC): readStatusLog tests (6), resolveState tests (22). 28 tests total.
  - AC: `tests/status-writer.test.ts` (~380 LOC): mapHookEventToState (3), writeStatusEvent (4), writeStatusTruncate (1), writeNotificationStatus (7). 15 tests total.
  - AC: `tests/project-utils.test.ts` (~500 LOC): scanProjects (8), filterStaleProjects (6), closed state (4), disambiguateProjectNames (5). 23 tests total.
  - AC: `tests/backends/claude.test.ts` expanded from 289 → ~2700 LOC: getProjectState (10), all readSessionTail variants (~60), getSubagentInfos (12), cache/targeted refresh (5). ~87 tests moved from sessions.test.ts.
  - AC: `makeFirstLine()` helper duplicated in sessions.test.ts + backends/claude.test.ts → extracted to `tests/_helpers.ts`
  - AC: `tests/sessions.test.ts` deleted (3596 lines → 0)
  - AC: All 303 tests pass from new locations

- [x] **T3.4** Create typed JSONL/SQLite parsers in `src/parsers/` (R93)
  - Priority: **Low** | Effort: **Extensive** (~350-450 LOC new modules) | Depends on: T1.1 (R87 types stable)
  - AC: `src/parsers/claude-jsonl.ts` (~250-320 LOC): typed union for Claude JSONL entry (5 variants by `type`), ContentBlock union (3 variants + `isTextBlock`/`isToolUseBlock` replacements), ToolUse input types (TaskCreate/TaskUpdate/Task/TodoWrite) + guards, QueueOperation content + guard, Subagent shapes (status file + first line) + guards
  - AC: `src/parsers/opencode-db.ts` (~90-130 LOC): Message data union (2 variants by role) + guards, Part data union (2 variants) + guards, Token shape narrowing helper
  - AC: 37 `as Record<string, unknown>` casts eliminated from production code — replaced with typed parser calls returning `Result<T, string>` (success value or error message)
  - AC: `session-enrichment.ts` handlers (handleUserEntry, handleAssistantEntry, etc.) use typed parsers instead of inline narrowing
  - AC: `backends/opencode.ts` enrichMessages uses typed parsers instead of inline JSON.parse + Record<string, unknown>
  - AC: All 303 tests pass (parsers are behavioral-equivalent substitutions)

- [x] **T3.5** Split frontend JS into ES modules (R94)
  - Priority: **Low** | Effort: **Moderate** (~220 LOC new JS + 583 LOC removed inline) | Depends on: nothing
  - AC: `public/js/utils.js` (~55 LOC): state lookup tables, projKey, _relativeTime, esc, truncate, shortModel, _fmtTokens. Zero DOM dependencies.
  - AC: `public/js/render.js` (~200 LOC): flash state Maps/Sets, getSortedProjects, renderContextBar, renderAgentRow, createCard, render orchestrator. Depends on utils.js.
  - AC: `public/js/backend-manager.js` (~220 LOC): BackendManager object, all WS connection lifecycle, updateStatusPill, updateBackendMenu, toggleMenu, mergeAndRender. Depends on utils.js + render.js.
  - AC: `public/js/main.js` (~50 LOC): wires everything, binds event listeners, calls BackendManager.init(). Depends on all three.
  - AC: `public/index.html` `<script>` block replaced with `<script type="module" src="js/main.js"></script>`. CSS stays inline. 1112 → ~530 lines.
  - AC: Dashboard loads and functions identically. All visual states (running/stopped/waiting/error/closed) render correctly. Multi-backend, flash animations, sort, zombie detection all work.
  - AC: Server `Cache-Control: no-cache` on HTML unaffected. New JS files get standard browser caching (no-cache optional).

## Files

- **src/types.ts**: Cross-backend types (ProjectInfo union, BackendSource). Changes: discriminated union on source, latestJSONL made optional.
- **src/backends/types.ts**: SessionBackend interface. Changes: add optional getNotification().
- **src/backends/claude.ts**: Changes: implement getNotification(), remove buildProjectState wrapper.
- **src/backends/opencode.ts**: Changes: remove buildProjectState import from session-enrichment.ts dependency.
- **src/backends/build-project-state.ts**: Changes: call getNotification() if implemented.
- **src/backends/index.ts**: Changes: separate factory from I/O.
- **src/server.ts**: Changes: simplify stateMap to nested Map structure, remove backendIndex.
- **src/cli.ts**: Deleted after split into src/cli/main.ts + src/cli/commands/.
- **src/cli/main.ts**: New entry point.
- **src/cli/commands/dump.ts**: New command module.
- **src/cli/commands/status.ts**: New command module.
- **src/cli/commands/sub.ts**: New command module.
- **src/cli/commands/serve.ts**: New command module.
- **src/log.ts**: New structured logger.
- **src/timing.ts**: New time constants module.
- **src/session-core.ts**: Changes: resolveState refactored to composable rule list.
- **src/session-enrichment.ts**: Changes: SessionEnrichment types extracted, parsers extracted; pure Claude JSONL parser remains.
- **src/parsers/claude-jsonl.ts**: New typed parsers for Claude JSONL shapes.
- **src/parsers/opencode-db.ts**: New typed parsers for OpenCode DB rows.
- **public/index.html**: JS extracted to modules.
- **public/backend-manager.js**: New WebSocket management module.
- **public/render.js**: New card rendering module.
- **public/flash.js**: New flash animation state module.
- **tests/sessions.test.ts**: Split into per-module test files.
- **tests/session-core.test.ts**: Split from sessions.test.ts.
- **tests/session-enrichment.test.ts**: Split from sessions.test.ts.
- **tests/project-utils.test.ts**: Split from sessions.test.ts.
- **tests/status-writer.test.ts**: Split from sessions.test.ts.
- **tests/cli.test.ts**: Changes: import commands directly, no spawnSync.
