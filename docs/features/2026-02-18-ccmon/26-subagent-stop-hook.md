# Phase: SubagentStop Hook + Status File Rename

## Context

See [00-ccmon](00-ccmon.md). Sub-agent completion currently relies on 45s mtime polling (`SUBAGENT_ACTIVE_THRESHOLD_MS`). Adding a `SubagentStop` hook gives immediate completion detection. Also renames `status.local.json` → `ccmon-status.json` and adds per-sub-agent status files.

## Questions

- [x] Q1: Does the watcher need to watch subagent directories? → No. SubagentStop handler updates session-level `ccmon-status.json` (adds `lastSubagentStoppedAt`), which the watcher already monitors. This triggers a rescan that calls `getSubagentInfos`, which reads per-sub-agent status files.
- [x] Q2: Backward compat for rename? → Not needed. `status.local.json` is transient (recreated on next hook fire). JSONL mtime detection covers the brief gap between code update and first hook fire.
- [x] Q3: SubagentStop hook payload? → Includes `agent_id`, `agent_type`, `agent_transcript_path` alongside standard fields (`session_id`, `cwd`, `hook_event_name`).

## Tasks

### Part 1: Rename status.local.json → ccmon-status.json

- [x] Rename constant in `src/sessions.ts`: `status.local.json` → `ccmon-status.json` in `writeStatus()` and `readStatus()` (R3)
- [x] Update `src/watcher.ts` comment referencing `status.local.json`
- [x] Update all `tests/sessions.test.ts` references (status file path in test fixtures)
- [x] Update all `tests/cli.test.ts` references
- [x] Update all `tests/server.test.ts` references
- [x] Update all `tests/watcher.test.ts` references
- [x] Run `bun test` — all 198 tests pass with renamed file
- [x] Update `CLAUDE.md` references to `status.local.json`

### Part 2: SubagentStop hook handling in CLI

- [x] Extend `HookPayload` interface with optional `agent_id?: string` and `agent_transcript_path?: string`
- [x] Add `SubagentStop` branch in `runStatus()`: extract `agent_id` + `agent_transcript_path`, derive sub-agent status file path (`agent-{id}.ccmon-status.json` alongside JSONL), write `{ state: "stopped", timestamp }`, then update session-level `ccmon-status.json` with `lastSubagentStoppedAt` field to trigger watcher
- [x] Add `writeSubagentStatus()` to `src/sessions.ts`: writes per-sub-agent `ccmon-status.json` + updates session-level status with `lastSubagentStoppedAt`
- [x] Add tests in `tests/cli.test.ts`: pipe SubagentStop payload → verify sub-agent status file written + session-level status updated
- [x] Run `bun test` — all tests pass

### Part 3: getSubagentInfos reads status files

- [x] In `getSubagentInfos()`, for each `agent-{id}.jsonl`, check for matching `agent-{id}.ccmon-status.json` with `state: "stopped"` → override `isActive = false` regardless of mtime
- [x] Add `StatusFile` fields: optional `lastSubagentStoppedAt?: string` (ISO 8601)
- [x] Add tests in `tests/sessions.test.ts`: sub-agent with fresh mtime but `ccmon-status.json` saying stopped → `isActive: false`
- [x] Add test: sub-agent without status file → falls back to mtime-based detection (existing behavior)
- [x] Run `bun test` — all tests pass

### Part 4: Hook config + docs

- [x] Add `SubagentStop` hook entry in `~/dotfiles/home-manager/modules/claude/settings.json` calling `ccmon status`
- [x] Update `CLAUDE.md` — add SubagentStop to hook events list, document per-sub-agent status file
- [x] Update `00-ccmon.md` — add R3.1 SubagentStop entry, update R3.2/R3.3 for renamed file

### Part 5: Validation

- [x] Run `bun test` — 203 tests pass (5 new)
- [x] Run `bun run lint` — clean
- [x] Run `bun run typecheck` — clean
- [x] Integration: `bun run dump --no-filter` returns projects

## Files

- **src/sessions.ts**: Rename `status.local.json` → `ccmon-status.json`; add `writeSubagentStatus()`; add `lastSubagentStoppedAt` to `StatusFile`; `getSubagentInfos()` reads per-sub-agent status files
- **src/cli.ts**: Extend `HookPayload` with `agent_id`, `agent_transcript_path`; add SubagentStop branch in `runStatus()`
- **src/watcher.ts**: Comment update only (status file name)
- **tests/sessions.test.ts**: Rename all `status.local.json` references; add 3 sub-agent status file tests
- **tests/cli.test.ts**: Rename references; add 2 SubagentStop handling tests
- **tests/server.test.ts**: Rename references
- **tests/watcher.test.ts**: Rename references
- **CLAUDE.md**: Update status file name, add SubagentStop docs
- **~/dotfiles/home-manager/modules/claude/settings.json**: Add SubagentStop hook entry
