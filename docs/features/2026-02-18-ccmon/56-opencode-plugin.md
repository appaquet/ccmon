# 56 Phase: OpenCode Plugin for Hook-Like Status Updates

## Context

See [00-ccmon](00-ccmon.md). OpenCode sessions are currently detected via 5s SQLite polling — state is inferred from `time_updated` recency with only `running`/`stopped` granularity. Claude Code uses hooks for **immediate** state updates (`Stop`, `PermissionRequest`, `StopFailure`, etc.) written to `ccmon-status.jsonl`. OpenCode does not support CLI hook scripts but does have a plugin system that can subscribe to session lifecycle events and write files.

This phase implements an OpenCode plugin that writes status events on session lifecycle changes, mirroring what Claude Code hooks do, and extends the `OpencodeBackend` to read these status files as its primary state source.

### Hook Feature Parity Analysis

| Feature | Claude Code Hook | OpenCode Plugin Equivalent |
|---------|-----------------|---------------------------|
| **Immediate stopped signal** | `Stop` hook → writes `stopped` | `session.idle` event → writes `stopped` |
| **Permission detection** | `PermissionRequest` hook → writes `waiting_for_permission` | `permission.ask` hook → writes `waiting_for_permission` |
| **Error detection** | `StopFailure` hook → writes `error` | `session.error` event → writes `error` |
| **Session end / closure** | `SessionEnd` → writes `closed` | `session.deleted` event → writes `closed` |
| **Running detection (user message)** | `UserPromptSubmit` hook → writes `running` | `chat.message` hook (role=user) → writes `running` |
| **Running detection (tool use)** | `PostToolUse` hook → writes `running` | `tool.execute.after` hook → writes `running` |
| **Sub-agent stop** | `SubagentStop` hook → per-agent status | `session.idle` on child session → writes `stopped` with parent session_id |
| **Notification / transient flash** | `Notification` hook → writes notification fields | Not implemented (no OpenCode notification equivalent) |
| **Sub-agent creation** | N/A (sub-agents detected from fs) | `session.created` event with `info.parentID` → writes `running` for sub-agent |

### Architecture: Plugin → Status File → OpencodeBackend

```
OpenCode Process          ccmon Process
┌──────────────┐         ┌─────────────────────┐
│ ccmon plugin │──write──▶  opencode-status.jsonl  │◀──read──│ OpencodeBackend │
│ (events)     │         │ ~/.local/state/ccmon/│         │                 │
└──────────────┘         └─────────────────────┘         └─────────────────────┘
                                                               │
                          sqlite polling (fallback) ───────────┘
```

1. **Plugin** (Bun runtime, inside OpenCode): Subscribes to session/chat/tool events, maps them to ccmon states, appends NDJSON lines to `~/.local/state/ccmon/opencode-status.jsonl`
2. **OpencodeBackend** (Node.js runtime): Watches the status file via `fs.watch`, reads the NDJSON log, resolves state from the latest event per session. Falls back to timestamp inference when no plugin-written status exists.
3. **Hybrid detection**: Plugin status is primary (fast, sub-ms), SQLite polling is fallback (covers sessions before plugin was installed, plugin crashes, etc.)

## Requirements

- R83: ⬜ OpenCode plugin writes status events to a shared NDJSON status log (Phase: Plugin)
  - R83.1: Status log location: `~/.local/state/ccmon/opencode-status.jsonl` (single file, append-only)
  - R83.2: Each line is a JSON object: `{ session_id, cwd, state, timestamp, event }`
  - R83.3: Plugin handles these OpenCode events:
    - `session.idle` → state `stopped`
    - `session.error` → state `error`
    - `session.deleted` → state `closed`
    - `chat.message` (user role) → state `running`
    - `tool.execute.after` → state `running`
    - `permission.ask` → state `waiting_for_permission`
    - `session.created` → state `running` (incl. sub-agents via `info.parentID`)
  - R83.4: Plugin is a single TypeScript file at `~/.config/opencode/plugins/ccmon.ts` (global plugin)
  - R83.5: Plugin has zero npm dependencies (uses only Bun built-in APIs: `write`, `appendFile`, `mkdir`)

- R84: ⬜ OpencodeBackend reads plugin-written status as primary state source (Phase: Backend)
  - R84.1: `resolveState()` checks status log for the session; if found, uses latest event state (same logic as Claude's `resolveState`)
  - R84.2: Falls back to timestamp inference when no plugin status exists for a session
  - R84.3: Status log path configurable via `BackendConfigEntry` (`statusLogPath`); defaults to `~/.local/state/ccmon/opencode-status.jsonl`

- R85: ⬜ OpencodeBackend watches status file for changes (Phase: Backend)
  - R85.1: `watchForChanges()` adds `fs.watch` on the status log file/directory
  - R85.2: Status file change triggers immediate `onUpdate()` callback (sub-100ms latency vs 5s polling)
  - R85.3: SQLite polling retained as safety net (lower frequency, e.g., 30s)
  - R85.4: Falls back to polling-only when status file doesn't exist (plugin not installed)

- R86: ⬜ Plugin install/uninstall documented, no configuration required (Phase: Docs)
  - R86.1: Plugin auto-discovers session directory from OpenCode context (no user config needed)
  - R86.2: ccmon detects plugin presence by existence of status file (graceful degradation)

### Out of Scope

- Notification flash for OpenCode (no `Notification` hook equivalent in OpenCode)
- Sub-agent descriptions from parent message correlation (plugin doesn't have access to parent.session messages conveniently)
- Per-sub-agent status files (plugin detects sub-agents via `session.created` with `parentID`, writes to same shared log)

## Questions & Investigations

- [ ] Q: Does the `session.idle` event reliably fire for sub-agent sessions?
  - Uncertainty: Sub-agent sessions may use a different idle semantics (sub-agent processes exit rather than going idle)
  - Mitigation: Test with real OpenCode task delegation. If sub-agents don't fire `session.idle`, detect sub-agent stops via `session.deleted` instead.

- [ ] Q: Does `chat.message` fire for ALL messages or only the first?
  - Uncertainty: From plugin docs, `chat.message` fires when a "new message is received" — ambiguous if this includes tool results or system messages
  - Mitigation: Filter by `input.variant` and/or check parts for user-role content. If `chat.message` fires too broadly, fall back to event-based detection via `message.updated`.

- [ ] Q: Can the plugin access `process.env.HOME` / `os.homedir()` via Bun for constructing the status file path?
  - Uncertainty: OpenCode plugins run in Bun's runtime which may sandbox environment variables (similar to the Bun/Nix issue that required `src/env.ts`)
  - Mitigation: Use `Bun.env.HOME` or `process.env.HOME`. If unavailable, derive XDG paths from `context.directory`. Document that `CCMON_OPENCODE_STATUS_PATH` env var can override.

- [ ] Q: Is `appendFile` on the shared status file safe from multiple OpenCode sessions?
  - Uncertainty: Multiple OpenCode instances writing to the same file could cause interleaved lines
  - Mitigation: POSIX `O_APPEND` is atomic for writes under PIPE_BUF (4096 bytes on Linux). Plugin writes lines < 1KB — should be safe. If interleaving occurs in practice, switch to per-session files.

- [ ] Q: Does the `session.created` event fire for sub-agent sessions with `info.parentID`?
  - From plugin source: yes, `session.created` fires with `event.properties.info` (a Session object). Sub-agent sessions have `info.parentID` set to parent session ID.
  - Result: Use `info.parentID` to detect sub-agent creation and write state for the parent session.

- [ ] Q: What `cwd` do we write for sub-agent events?
  - Decision: Use the parent session's cwd (stored in the plugin's session→cwd map). Sub-agent sessions share the same project directory as their parent. The `client.session.get({ path: { id: parentID } })` can retrieve parent session info including directory.

## Tasks

### Task 1: Plugin file — event subscription + status writing

- [x] Create `resources/opencode-plugin/ccmon.ts` (to be installed at `~/.config/opencode/plugins/ccmon.ts`)
  - AC: Plugin exports an async function matching `Plugin` type
  - AC: Plugin subscribes to `event` hook for `session.*` events
  - AC: Plugin subscribes to `chat.message`, `tool.execute.after`, `permission.ask` named hooks
  - AC: Maps each event to a StatusEvent with `{ session_id, working_dir, state, timestamp, event }`
  - AC: Maintains in-memory Map<sessionId, working_dir> from `session.created` events and `client.session.get()`
  - AC: Writes StatusEvent as NDJSON line to `~/.local/state/ccmon/opencode-status.jsonl`
  - AC: Handles session.deleted by cleaning up the cwd map entry
  - AC: Sub-agent detection: `session.created` with `info.parentID` → look up parent working_dir, write `running` state for parent session_id
  - AC: `session.idle` for sub-agent (child) sessions → write `stopped` with child session_id and parent's working_dir
  - AC: Graceful error handling — plugin never throws uncaught; logs errors via `client.app.log()`

### Task 2: Status log reading in OpencodeBackend

- [x] Add `resolveStateFromStatusLog()` method to `OpencodeBackend`
  - AC: TEST FIRST — create test status file with events, verify correct state resolved
  - AC: Reads `opencode-status.jsonl`, filters lines matching `session_id`, returns state from latest event
  - AC: Returns `null` when no matching events found (triggers timestamp fallback)
  - AC: Handles missing/corrupt status file gracefully (returns null)
  - AC: Parses `waiting_for_permission`, `error`, `closed` states correctly
  - AC: File stat caching: re-read only on mtime change (avoids re-parsing on every call)

- [x] Integrate into `resolveState()` in `OpencodeBackend`
  - AC: `resolveState()` checks status log first
  - AC: Falls back to existing timestamp inference when status log has no events for the session
  - AC: Stat of status log file → mtime tracking to avoid re-parsing
  - AC: Existing tests for timestamp-based resolution still pass

### Task 3: Status file watching in OpencodeBackend

- [x] Modify `watchForChanges()` to add fs.watch on status file
  - AC: TEST FIRST — mock fs.watch, verify callback fires on file change
  - AC: Watches status file directory (not the file itself — `fs.watch` on files is unreliable on Linux)
  - AC: On directory change, checks if status file mtime changed → fires `onUpdate()`
  - AC: SQLite polling continues at reduced frequency (configurable, default 30s) as safety net
  - AC: When status file doesn't exist → full polling mode (existing behavior, 5s interval)
  - AC: `stop()` tears down both watcher and polling interval
  - AC: Existing polling tests still pass (polling is now the fallback timer, not the primary watcher)

### Task 4: Config for status log path

- [x] Add `statusLogPath?: string` to OpenCode backend config
  - AC: `BackendConfigEntry` for opencode type accepts optional `statusLogPath`
  - AC: Default: `~/.local/state/ccmon/opencode-status.jsonl` (XDG state home)
  - AC: Config test: custom path parsed correctly from config JSON
  - AC: `createBackends()` passes path to `OpencodeBackend` constructor

### Task 5: Integration test — plugin + backend

- [x] Write integration test
  - AC: In-memory SQLite with OpenCode schema + test data
  - AC: Write test status events to temp status file
  - AC: `buildProjectState()` returns plugin-written state (e.g., `waiting_for_permission`)
  - AC: When status file has no matching events, falls back to timestamp inference (stopped for old sessions)
  - AC: Status file deleted → falls back to timestamp inference
  - AC: Polling still works as fallback (status file absent, SQLite polling detects changes)

### Task 6: Documentation + plugin installation

- [x] Update `CLAUDE.md` with plugin installation instructions
  - AC: One-line install: `cp resources/opencode-plugin/ccmon.ts ~/.config/opencode/plugins/ccmon.ts`
  - AC: Document that plugin auto-discovers on next OpenCode start
  - AC: Document OpenCode limitations resolved by plugin (waiting_for_permission, error states)
  - AC: Document that without plugin, ccmon falls back to polling (graceful degradation)
  - AC: Document the new `statusLogPath` config option

- [x] Create `resources/opencode-plugin/` directory with plugin file
  - AC: Single `ccmon.ts` file with JSDoc comments
  - AC: File is self-contained (no npm dependencies, uses only Bun built-ins)

## Files

- **resources/opencode-plugin/ccmon.ts**: OpenCode plugin — event subscription + status writing (new)
- **src/backends/opencode.ts**: `OpencodeBackend` — add status log reading (`resolveStateFromStatusLog`), integrate into `resolveState`, add fs.watch to `watchForChanges` (modified)
- **src/backends/types.ts**: `BackendConfigEntry` — add optional `statusLogPath` to opencode variant (modified)
- **src/config.ts**: Config types — add `statusLogPath` parsing (modified)
- **tests/backends/opencode.test.ts**: Tests for status log reading, fallback, watcher integration (modified)
- **CLAUDE.md**: Plugin installation docs + architecture notes (modified)

## Testing Strategy

1. **Plugin behavior**: Manual verification — install plugin in `~/.config/opencode/plugins/`, start OpenCode, write a prompt, verify `~/.local/state/ccmon/opencode-status.jsonl` receives events. Check that ccmon `dump` shows correct state.

2. **Backend status log reading**: In-memory test — create temp status file with events, call `resolveState()`, assert correct state. Test fallback when no matching events.

3. **Backend fs.watch**: Mock `fs.watch` via vitest, verify callback fires. Test fallback to polling when status file absent.

4. **Integration**: Test SQLite DB with plugin status file — verify `buildProjectState()` uses plugin state. Test graceful fallback when status file deleted.

5. **Negative tests**: Corrupt JSON in status file (skip line), empty status file (return null → fallback), status file removed mid-watch (revert to polling).
