# Phase 30: Inbox Fixes

## Context

See [00-ccmon](00-ccmon.md). Two inbox bugs: stale state after WS reconnect, sub-agent names showing raw agentId.

## Tasks

### Bug 1: Stale state after WS reconnect

Root cause: `entry.projects` is never cleared on WS disconnect. `mergeAndRender()` includes all backends regardless of connection status, showing stale data.

- [x] In `onclose`/`onerror` handler: clear `entry.projects = []` and call `mergeAndRender()` to update display immediately
- [x] In `onopen` handler: clear `entry.projects = []` before server sends initial state (avoid brief stale window between connected status and first message)
- [ ] Manual test: disconnect backend, verify cards disappear; reconnect, verify fresh state

### Bug 2: Sub-agent names showing raw agentId

Root cause: Claude Code 2.1.51+ no longer emits `queue-operation` JSONL entries. Sub-agents launched via `Task` tool have `description` in `tool_use.input` and `agentId` in the corresponding `toolUseResult` (correlated via `tool_use_id` → `tool_result.tool_use_id`).

- [x] In `scanEnrichment()` in `src/sessions.ts`: add parsing for `Task` tool_use blocks — extract `tool_use.id` → `description` map
- [x] In `scanEnrichment()`: parse `toolUseResult` entries for `agentId` — correlate `tool_use_id` back to tool_use `id` to get description, add to `agentDescriptions` map
- [x] Keep existing `queue-operation` parsing as fallback for older sessions
- [x] In UI (`public/index.html`): update fallback chain to `description ?? slug ?? agentId`
- [x] Add test: Task tool_use + toolUseResult correlation populates agentDescriptions
- [x] Add test: mixed queue-operation (legacy) and Task tool_use entries both populate descriptions
- [x] Run lint + typecheck + tests

## Files

- **public/index.html**: Clear projects on disconnect/reconnect; update agent name fallback chain
- **src/sessions.ts**: Add Task tool_use/toolUseResult parsing in `scanEnrichment()` for agent descriptions
- **tests/sessions.test.ts**: Tests for Task-based agent description extraction
