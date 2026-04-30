# Phase 45: Review Fixes — OpenCode Support

## Context

See [00-ccmon](00-ccmon.md). Four review agents (style, correctness, architecture, requirements) reviewed Phase 44 and planted 18 REVIEW comments across 8 files. This phase addresses all of them.

## Tasks

### Release-Blocking

- [x] Fix: extract session-core.ts to eliminate dynamic imports — `src/backends/claude.ts:40-48`
  - Extract `resolveState`, `readStatusLog`, and shared types from `sessions.ts` into `src/session-core.ts`
  - Update `ClaudeBackend` to import statically instead of `await import("../sessions")`
  - Update `sessions.ts` to re-export from session-core.ts so existing 200+ tests pass unchanged
  - AC: No dynamic imports in ClaudeBackend. All 258 tests pass. `bun run lint && bun run typecheck` clean.

- [x] Fix: define `BackendSource` discriminated union — `src/backends/claude.ts:25-34`, `types.ts`
  - Define `type BackendSource = "claude" | "opencode"` in `src/backends/types.ts`
  - Use in `ProjectInfo.source`, `ProjectState`, `ClaudeBackend`, `OpencodeBackend`, `public/index.html`
  - AC: TypeScript compile error if a third source is written without adding to union. All tests pass.

- [x] Fix: make OpenCode DB-not-found skip silent — `src/config.ts:13-20`, `src/backends/index.ts:46-49`
  - Downgrade `console.warn` to silent skip when DB doesn't exist at default path
  - Keep warning for user-configured custom paths that don't exist
  - AC: No warning printed when default `~/.local/share/opencode/opencode.db` is absent. Warning still appears for custom `databasePath`.

### High Priority

- [x] Fix: return cleanup function from `createBackends` — `src/backends/index.ts:16-26`
  - Return `{ backends, close }` where close() closes all DB handles
  - CLI `runDump`/`runDumpWatch` call close() after scan completes
  - Server calls close() on shutdown
  - AC: No SQLite file handles left open after CLI dump exits. Server closes DBs on SIGINT/SIGTERM.

- [x] Fix: guard `new Database()` and `db.run()` — `src/backends/index.ts:52-57`
  - Wrap in try-catch, warn and continue to next backend on failure
  - AC: Corrupted DB file does not crash the process. Backend skipped gracefully.

- [x] Fix: add default case to backend switch — `src/backends/index.ts:64-67`
  - Add `default: { console.warn(...); }` arm for unknown backend types
  - AC: Config typo like `"claide"` produces a warning instead of silently yielding zero backends.

- [x] Fix: widen `onUpdate` callback for per-project granularity — `src/backends/types.ts:33-43`, `server.ts`, `cli.ts`, `claude.ts`
  - Change signature to `watchForChanges(onUpdate: (maybeProject?: ProjectInfo) => void): { stop: () => void }`
  - ClaudeBackend passes changed ProjectInfo; OpenCodeBackend passes nothing
  - Server: if ProjectInfo received, update single project via `buildProjectState`; if undefined, full rescan
  - CLI dump --watch: same logic
  - AC: Claude watcher event updates only the changed project, not all projects.

- [x] Fix: dedup resolveState in ClaudeBackend — `src/backends/claude.ts:134`
  - Have `buildProjectState()` call `this.resolveState(projectInfo)` instead of reimplementing stat+event resolution
  - AC: ~30 duplicated lines removed. All existing ClaudeBackend tests pass unchanged.

### Medium Priority

- [x] Fix: extract `buildStateForBackend` helper — `src/server.ts:64`, `src/cli.ts:133`
  - Create shared `async function buildStateForBackend(backend: SessionBackend): Promise<Map<string, ProjectState>>`
  - Used by `rescanAllBackends`, `rescanBackend`, `runDump`, `runDumpWatch`
  - AC: No duplicated scan+build+populate loops. All tests pass.

- [x] Fix: O(n) deletion loop → O(1) — `src/server.ts:111-114`
  - Maintain `Map<SessionBackend, Set<string>>` reverse index
  - Delete all keys for a backend in O(1) via `backendSet.delete(backend)`
  - AC: rescanBackend does not iterate all projects to find backend membership.

- [x] Fix: subagents.filter called twice — `src/backends/opencode.ts:78`
  - Extract `const activeCount = subagents.filter(s => s.isActive).length`
  - AC: Single filter call. Tests pass.

- [x] Fix: empty catch blocks log warnings — `src/backends/opencode.ts:113`
  - Add `console.warn` in enrichedProject try-catch blocks with context
  - AC: Malformed data produces detectable warnings instead of silent skip.

- [x] Fix: remove duplicate "## Architecture" heading — `CLAUDE.md:65`
  - Remove the empty duplicate heading on line 65
  - AC: Single `## Architecture` heading.

### Low Priority

- [x] Fix: remove ASCII-art section markers — `tests/backends/opencode.test.ts:58`
  - Remove `// ─── ...` dividers between test groups
  - AC: No ASCII-art section markers in file.

- [x] Fix: break 80-char line — `src/backends/opencode.ts:221`
  - Break compound `if` condition onto multiple lines
  - AC: No lines exceed 80 chars.

- [x] Fix: remove dead code `_INTERNAL_GET_PROJECT_STATE` — `src/backends/claude.ts:13`
  - Remove the unused Symbol declaration
  - AC: No dead code. Grep confirms no references.

- [x] Fix: rename misleading test — `tests/config.test.ts:218`
  - Rename "disabled backend excluded from result" → "disabled backend still present in parsed config"
  - AC: Test name reflects what's actually tested.

- [x] Fix: extract `makeTempDir` to shared helper — `tests/integration.test.ts:12`
  - Create `tests/_helpers.ts` with exported `makeTempDir`
  - Import in all 7 test files, remove local definitions
  - AC: Single definition, all tests pass.

## Files

- **src/backends/types.ts**: Add `BackendSource` type, widen `onUpdate` callback signature
- **src/backends/claude.ts**: Remove dynamic imports, dedup resolveState, pass ProjectInfo in watchForChanges, remove dead Symbol
- **src/backends/opencode.ts**: Fix subagents filter, add catch warnings, break long line
- **src/backends/index.ts**: Return cleanup function, guard DB constructor, add default switch case, silent skip on default DB path
- **src/session-core.ts** (new): Extracted resolveState, readStatusLog, shared types
- **src/sessions.ts**: Re-export from session-core.ts
- **src/server.ts**: Use buildStateForBackend helper, O(1) deletion via reverse index
- **src/cli.ts**: Use buildStateForBackend helper, per-backend targeted refresh in watch
- **src/config.ts**: No code change (doc-only: R72.2 updated)
- **CLAUDE.md**: Remove duplicate heading
- **public/index.html**: Use BackendSource type (if needed — otherwise no change)
- **tests/backends/opencode.test.ts**: Remove ASCII-art markers
- **tests/config.test.ts**: Rename misleading test
- **tests/integration.test.ts**: Import makeTempDir from _helpers.ts
- **tests/_helpers.ts** (new): Shared makeTempDir utility
- **tests/cli.test.ts**, **tests/server.test.ts**, **tests/sessions.test.ts**, **tests/watcher.test.ts**: Import makeTempDir from _helpers.ts
- **docs/features/2026-02-18-ccmon/44-opencode-support.md**: R72.2 updated to "both backends enabled"
- **docs/features/2026-02-18-ccmon/00-ccmon.md**: R72 updated, new phase referenced
