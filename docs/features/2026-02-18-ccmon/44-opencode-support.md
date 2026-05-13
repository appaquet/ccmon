# Phase 44: OpenCode Support — Multi-Backend Abstraction

## Context

See [00-ccmon](00-ccmon.md). ccmon currently only monitors Claude Code sessions via the `~/.claude/projects/` directory. OpenCode stores session data in a SQLite database (`~/.local/share/opencode/opencode.db`) with a different schema (Drizzle ORM, JSON blobs in `message.data` and `part.data` columns) and no hook-based state mechanism.

The codebase must be refactored to abstract away the data source, allowing both backends to coexist. The server should merge projects from all configured backends into a single dashboard view.

### Key Differences: Claude Code vs OpenCode

| Aspect | Claude Code | OpenCode |
|--------|------------|----------|
| Data format | NDJSON `.jsonl` files | SQLite (WAL mode) + JSON blobs |
| Project discovery | `readdir(~/.claude/projects/)` | `SELECT * FROM session JOIN project` |
| State detection | Hook-written `ccmon-status.jsonl` event log | Inferred from `session.time_updated` recency |
| Hooks | `Stop`, `SessionEnd`, `PermissionRequest`, etc. | Plugin system only (no CLI hook scripts) |
| Sub-agents | `subagents/agent-{id}.jsonl` files | `parent_id` column in `session` table |
| Project key | Basename of cwd | Git root commit hash (stable across clones) |
| Session ID | UUID (from JSONL first line) | Custom `ses_` prefix 26-char ID |
| Timestamps | ISO 8601 in JSON | Unix ms integers |

## Requirements

- R69: ⬜ Abstract data source behind `SessionBackend` interface (Phase: OpenCode Backend)
  - R69.1: `scanProjects()` — discover projects from the data source
  - R69.2: `buildProjectState()` — full state: discovery + state resolution + enrichment + sub-agents
  - R69.3: `watchForChanges()` — backend-specific change detection (fs.watch or SQLite polling)
  - R69.4: `resolveState()` — backend-specific state resolution
  - R69.5: `enrichProject()` — session enrichment (model, messages, tokens, tasks, session name)
  - R69.6: `getSubagents()` — sub-agent discovery and info
  - R69.7: `projectKey()` — unique per-backend key for state maps

- R70: ⬜ Claude Code backend implemented via extracted existing code (Phase: Claude Backend Extraction)
  - R70.1: All existing functions in `sessions.ts` + `watcher.ts` used by Claude, no behavior change
  - R70.2: All 202 existing tests pass unchanged after extraction

- R71: ⬜ OpenCode backend reads SQLite database read-only (Phase: OpenCode Backend)
  - R71.1: `scanProjects()` queries `session` table (active, non-archived) joined with `project`
  - R71.2: `resolveState()` infers state from `session.time_updated` recency and `part` table status
  - R71.3: `enrichProject()` extracts model, messages, tokens, tasks from `message.data` + `part.data` JSON blobs
  - R71.4: `getSubagents()` queries `session WHERE parent_id = ?`
  - R71.5: `watchForChanges()` polls SQLite at configurable interval comparing `MAX(time_updated)`
  - R71.6: Uses Bun's built-in `bun:sqlite` — zero npm dependencies

- R72: ⬜ Config supports `backends` array (Phase: Config)
  - R72.1: New `backends` field in config: array of `{ type, enabled, ...typeSpecificOpts }`
  - R72.2: Defaults to both backends enabled; silently skipped when source absent
  - R72.3: `server.ts` + `cli.ts` create backends from config

- R73: ⬜ Server merges projects from all backends (Phase: Multi-Backend Server)
  - R73.1: Server manages N backends, each with its own state map
  - R73.2: `broadcastCurrent()` merges all backend projects into single `projects[]` payload
  - R73.3: Each `ProjectState` carries a `source` field (`"claude"` | `"opencode"`)
  - R73.4: Periodic safety broadcast includes all backends

- R74: ⬜ CLI `dump` / `dump --watch` work with all backends (Phase: CLI)
  - R74.1: `dump` and `dump --watch` scan all enabled backends
  - R74.2: `--project <name>` filter still works (matches across backends)
  - R74.3: `serve` works with all enabled backends

- R75: ⬜ `ccmon status` subcommand remains Claude-only (Phase: CLI)
  - R75.1: Hook processing unchanged — only Claude Code uses hooks

- R76: ⬜ Frontend displays `source` badge on project cards (Phase: Frontend)
  - R76.1: Each card shows source indicator (e.g., small "CC" / "OC" badge)
  - R76.2: Backward compatible — old servers without source field still work

#### Out of Scope

- Reading OpenCode's `account` / `account_state` / `session_share` tables
- Writing status events to OpenCode's database (read-only monitoring)
- OpenCode plugin/hook for explicit state signals
- OpenCode project archival detection (`time_archived` — treated as absent)
- Automatic OpenCode DB path detection (must be configured or use default)
- OpenCode workspace support (only sessions tracked)

## Questions & Investigations

- [x] Q: Does OpenCode have an equivalent to session state (running/stopped)?
  - Result: No. `time_archived` exists but is never auto-set. Active = `time_archived IS NULL`. State must be inferred from `time_updated` recency. No hook mechanism for explicit state.
- [x] Q: Does OpenCode store a session "ended" timestamp?
  - Result: `session.ended_at` does NOT exist. Only `time_updated`, `time_archived`. Use `time_updated` recency threshold (60s) to infer running vs stopped.
- [x] Q: What's the OpenCode project/session ID format?
  - Result: SessionID = `ses_` + 12 hex + 14 base62 = 26 chars. ProjectID = git root commit hash. Both are text columns.
- [x] Q: Are OpenCode timestamps in ms or seconds?
  - Result: All timestamps are JavaScript ms since epoch (validated from source code: `Date.now()` for `$default`, and user queries using `/1000` for display).
- [x] Q: Does ccmon need a new npm dependency for SQLite?
  - Result: No. Bun ships with built-in `bun:sqlite` — `new Database(path, { readonly: true })` works without any dependency. This maintains the zero-dependency constraint.
- [x] Q: How does OpenCode store `waiting_for_permission` state?
  - Result: No explicit state column. Permission requests are stored as parts with type matching the permission mechanism. For the initial implementation, only `running` (recent activity) and `stopped` (stale) states are supported for OpenCode. Permission/error detection is deferred.
- [x] Q: Should `ProjectInfo` use a union type or optional fields?
  - Decision: Start with `source` field + optional Claude/Opencode fields. Lower friction, less refactoring. Can migrate to union type later if bugs emerge from unchecked field access.
- [x] Q: Should enrichment for OpenCode be full parity with Claude Code?
  - Decision: Start simple — model, basic messages, token counts. Task tracking (TaskCreate/TaskUpdate equivalent) and full message parsing deferred to a follow-up phase. The main value of phase 44 is getting OpenCode sessions visible on the dashboard, not full enrichment parity.
- [x] Q: How should the watcher be abstracted for SQLite?
  - Decision: SQLite polling via `setInterval`. Check `MAX(time_updated)` across session table vs `lastPollAt`. Payload says 5s default. This is acceptable for a monitoring dashboard — latency matters less than with Claude Code hooks.
- [x] Q: Can we use Bun's `bun:sqlite` in read-only mode on a WAL database?
  - Decision: Yes. `new Database(path, { readonly: true })` opens the db read-only. WAL mode means the writer (OpenCode process) and reader (ccmon) can coexist without SQLITE_BUSY. Set `busy_timeout = 5000` pragma as safety.

- [x] Q: Do `message.data` / `part.data` JSON keys match the Drizzle TypeScript field names exactly, or are they transformed?
  - Uncertainty: Drizzle can map column names. Actual JSON keys might differ from `providerID`, `modelID`, `tokens.input` etc. Will discover during enrichment task — first real test against OpenCode JSON blobs reveals the truth.
  - Mitigation: In-memory tests use synthetic data matching *our* expected format. Validate against real opencode.db via `bun run dump` after backend is wired.

- [x] Q: Does `session.time_updated` update when messages/parts are written, or only when the session row itself changes?
  - Uncertainty: If `time_updated` is only updated for session metadata changes (title, permission, etc.) and NOT when messages/parts are inserted, then it's not a valid activity signal. We'd need `MAX(message.time_created)` instead.
  - Mitigation: In-memory test inserts a message → queries session.time_updated → verifies it changed. If Drizzle's `$onUpdate` fires on any table write to the same transaction, this works. Real DB validation via `bun run dump` catches the actual behavior.

### Testing Strategy

All OpenCode backend tests use `new Database(":memory:")` — Bun's built-in in-memory SQLite. Each test creates the schema from strings, inserts test data, then calls backend functions. No temp files, no cleanup, fully isolated.

The `OpencodeBackend` class accepts a `Database` instance via constructor (injectable), decoupling it from the file path:

```typescript
class OpencodeBackend implements SessionBackend {
  constructor(private db: Database) {}
  // ...
}
// Production: factory creates via new Database(path, { readonly: true })
// Tests:       new OpencodeBackend(new Database(":memory:"))
```

After the backend is wired into `dump`, validate against the real `~/.local/share/opencode/opencode.db` using `bun run dump --no-filter` — if OpenCode projects appear alongside Claude projects, the integration works.

Each task's first AC is always the test: write the test, see it fail, then implement. The test *defines* the task — implementation follows.

## Tasks

### Task 1: Design the `SessionBackend` interface (foundation)

Risk: Low — but needed before anything else.

- [x] Create `src/backends/types.ts` with `SessionBackend` interface
  - AC: Interface compiles cleanly (`tsc --noEmit`)
  - AC: All 7 methods have JSDoc contracts
  - AC: `Database` import from `bun:sqlite` (used by OpenCode backend constructor signature)

### Task 2: OpenCode core — project discovery + state resolution

Risk: **Highest** — SQLite query correctness, timestamp handling, state inference logic. This is the pivot point: if this works, the rest is incremental.

- [x] Create `src/backends/opencode.ts` with `constructor(db: Database)`, `scanProjects()`, `resolveState()`, `projectKey()`
  - AC: Test FIRST — in-memory DB with project + session tables, 3 sessions (active time_updated=now, stale time_updated=5min ago, archived time_archived=not-null)
  - AC: `scanProjects()` returns only active sessions (time_archived IS NULL, parent_id IS NULL)
  - AC: `scanProjects()` joins `project` table, extracts `project.name`, `session.directory` as cwd, `session.id`
  - AC: `resolveState()` returns `"running"` when `time_updated` < 60s ago
  - AC: `resolveState()` returns `"stopped"` when `time_updated` > 60s ago
  - AC: `resolveState()` returns `"stopped"` for archived sessions (shouldn't be reached, but defensive)
  - AC: `projectKey()` returns stable unique string per project
  - AC: `buildProjectState()` assembles full ProjectState with `source: "opencode"`, empty enrichment, no sub-agents (added in later tasks)
  - AC: Granular test: each function tested independently before `buildProjectState` combines them

### Task 3: OpenCode enrichment — JSON blob parsing

Risk: **High** — JSON structure of `message.data` and `part.data` blobs is the second biggest unknown. Key names might differ from schema docs.

- [x] Add `enrichProject()` to `OpencodeBackend`
  - AC: Test FIRST — in-memory DB with `message` and `part` tables, pre-inserted JSON blobs
  - AC: Extract model from most recent assistant message's `data` JSON
  - AC: Extract `latestUserActivity` from most recent user message's `data` JSON
  - AC: Extract `latestAssistantActivity` (text from `part.data` with type="text", tool name from type="tool")
  - AC: Extract `inputTokens` / `outputTokens` from assistant message's `data.tokens`
  - AC: Extract `sessionName` from `session.title`
  - AC: Returns `SessionEnrichment` (shared type with Claude backend)
  - AC: Handles empty message history (no messages yet) → returns minimal enrichment, no crash
  - AC: Handles corrupt/unparseable JSON in `data` column → skips gracefully, returns what it can
  - AC: `buildProjectState()` now includes enrichment fields

### Task 4: OpenCode sub-agents — parent_id linking

Risk: Medium — SQL query is simple (`WHERE parent_id = ?`). Timestamp conversion to ISO 8601 is the only gotcha.

- [x] Add `getSubagents()` to `OpencodeBackend`
  - AC: Test FIRST — in-memory DB with parent session + 2 child sessions (one active, one stale)
  - AC: Queries `session WHERE parent_id = ?`
  - AC: `isActive` = `time_updated` within 15s threshold
  - AC: `agentId` = child session's `id`, `launchTime` = `time_created` → ISO 8601, `lastMessageTime` = `time_updated` → ISO 8601
  - AC: No `slug` or `description` initially (deferred enrichment, same as Claude's gradual enrichment path)
  - AC: Stale sub-agents (not active, older than 30s) excluded from results
  - AC: `buildProjectState()` now includes sub-agents when state is `running`

### Task 5: OpenCode polling — change detection

Risk: Medium — polling logic is straightforward. The unknown is whether `MAX(time_updated)` is a reliable change signal (may update on every message insert = false positives). Acceptable for v1.

- [x] Add `watchForChanges()` to `OpencodeBackend`
  - AC: Test FIRST — in-memory DB, insert data after watch starts
  - AC: Polls at configurable interval (default 5000ms) comparing `MAX(time_updated)` from session table
  - AC: Fires `onUpdate()` when a newer timestamp is detected
  - AC: Does not fire `onUpdate()` when data unchanged between polls
  - AC: `stop()` clears the interval, no further callbacks after stop
  - AC: Polling starts immediately on first call (no initial delay)

### Task 6: Claude backend extraction (safe refactor)

Risk: Low — wrapping existing functions, no behavior change. All 202 tests must still pass.

- [x] Create `src/backends/claude.ts` implementing `SessionBackend`
  - AC: `scanProjects()` delegates to existing `scanProjects` from `sessions.ts`
  - AC: `buildProjectState()` delegates to existing `buildProjectState` from `sessions.ts`
  - AC: `watchForChanges()` delegates to existing `watchForChanges` from `watcher.ts`
  - AC: `resolveState()` delegates to existing `resolveState` from `sessions.ts`
  - AC: `enrichProject()` delegates to `readSessionTail` / `scanEnrichment`
  - AC: `getSubagents()` delegates to `getSubagentInfos`
  - AC: `projectKey()` returns `join(claudeDir, project.projectDir)`
  - AC: All 202 existing tests pass without modification
  - AC: No behavior change — same output as current

### Task 7: Backend factory

Risk: Low — simple factory function.

- [x] Create `src/backends/index.ts` with `createBackends(config)`
  - AC: Returns `SessionBackend[]` from config's `backends` array
  - AC: Skips backends with `enabled: false`
  - AC: Default config absent → `[{ type: "claude", enabled: true }]` (backward compat)
  - AC: Claude backend uses `CLAUDE_PROJECTS_DIR` env or `~/.claude/projects` default
  - AC: Opencode backend uses config's `databasePath` or `~/.local/share/opencode/opencode.db` default
  - AC: Warns and skips when OpenCode DB file missing but backend enabled (non-fatal)

### Task 8: Config types — backends array

Risk: Low — extending existing config pattern.

- [x] Modify `src/config.ts`
  - AC: `CcmonConfig` gets optional `backends?: BackendConfigEntry[]`
  - AC: `BackendConfigEntry` is discriminated union on `type` field
  - AC: `mergeWithDefaults()` handles new fields
  - AC: Config loading test: `{ backends: [{ type: "claude", enabled: true }] }` parses correctly
  - AC: Config loading test: `{ backends: [{ type: "opencode", enabled: true }] }` parses correctly
  - AC: Config loading test: absent `backends` field → Claude-only default
  - AC: Config loading test: disabled backend excluded from result

### Task 9: Add `source` field to project types

Risk: Low — additive field, existing tests just need the field in expectations.

- [x] Modify `ProjectInfo` and `ProjectState` in `src/sessions.ts`
  - AC: `ProjectInfo` gets `source: string` field
  - AC: `ProjectState` inherits `source` from `ProjectInfo`
  - AC: `ClaudeBackend` sets `source: "claude"`
  - AC: `OpencodeBackend` sets `source: "opencode"`
  - AC: All existing tests updated with `source: "claude"` expectation

### Task 10: Server multi-backend support

Risk: Medium — merging state from N sources, broadcast changes.

- [x] Modify `src/server.ts`
  - AC: `ServerOptions` takes `backends: SessionBackend[]`
  - AC: Server initializes each backend independently
  - AC: `broadcastCurrent()` merges all backend projects into single array
  - AC: Each backend has its own state map (keyed by `backend.projectKey()`)
  - AC: Watcher updates trigger per-backend rescan
  - AC: `filterStaleProjects()` applied to merged project list before broadcast
  - AC: Server tests pass with mock Claude + mock OpenCode backends
  - AC: Periodic safety broadcast covers all backends

### Task 11: CLI multi-backend wiring

Risk: Low — replacing direct function calls with backend calls.

- [x] Modify `src/cli.ts`
  - AC: `dump` scans all enabled backends, merges results
  - AC: `dump --watch` watches all enabled backends
  - AC: `dump --project <name>` filters across all backends
  - AC: `serve` uses `createBackends(config)` → `startServer`
  - AC: `status` subcommand unchanged (Claude-only hook processing)
  - AC: `sub` subcommand unchanged (reads WebSocket, backend-agnostic)
  - AC: Help text mentions OpenCode support

### Task 12: Frontend source badge

Risk: Low — small UI addition.

- [x] Update `public/index.html`
  - AC: Card header shows source badge: "CC" for Claude Code, "OC" for OpenCode
  - AC: Projects without `source` field default to "CC" (old server compat)
  - AC: Badge styling: subtle grey pill, small text, non-distracting

### Task 13: Integration test — both backends together

Risk: Medium — validates end-to-end that the wiring works.

- [x] Write integration test
  - AC: In-memory SQLite with OpenCode schema + test data
  - AC: Temporary Claude Code directory with mock JSONL
  - AC: `dump` output includes projects from both backends
  - AC: `dump --project <name>` finds by name across backends
  - AC: Server WS broadcasts include projects from both backends

### Task 14: Documentation

Risk: Low.

- [x] Update `CLAUDE.md`
  - AC: Backend architecture section
  - AC: Config example for enabling OpenCode
  - AC: OpenCode limitations noted (no hooks, polling-based, state inference, running/stopped only)

## Files

- **src/backends/types.ts**: `SessionBackend` interface, shared backend types (new)
- **src/backends/claude.ts**: `ClaudeBackend` — extracted from sessions.ts + watcher.ts (new)
- **src/backends/opencode.ts**: `OpencodeBackend` — SQLite-based (new)
- **src/backends/index.ts**: Factory function `createBackends(config)` (new)
- **src/sessions.ts**: Keep shared types (`ProjectInfo`, `ProjectState`, `SessionState`, `SessionEnrichment`, `SubagentInfo`, `StatusEvent`, `TaskInfo`, `filterStaleProjects`, `disambiguateProjectNames`, status log functions, state resolution). Extract Claude-specific functions into ClaudeBackend. Add `source` field to types.
- **src/server.ts**: Multi-backend support. Replace single `stateMap` with per-backend maps. Pass `backends[]` instead of `claudeDir`.
- **src/cli.ts**: Wire `createBackends(config)`. Multi-source `dump`. `status` remains Claude-only.
- **src/config.ts**: Add `backends` array type + parsing.
- **src/watcher.ts**: Move watcher logic into `ClaudeBackend`. Keep module as thin re-export or remove.
- **public/index.html**: Add source badge rendering.
- **tests/sessions.test.ts**: Add `source` field to all test expectations. Some tests may move to `tests/backends/`.
- **tests/backends/claude.test.ts**: Claude backend tests (moved from sessions.test.ts) (new)
- **tests/backends/opencode.test.ts**: OpenCode backend tests with in-memory SQLite (new)
- **tests/config.test.ts**: Add backends config parsing tests
- **tests/server.test.ts**: Update for multi-backend server options
- **CLAUDE.md**: OpenCode architecture + config docs
