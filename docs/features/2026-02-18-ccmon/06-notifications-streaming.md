# Phase: Notifications & Streaming

## Context

See [00-ccmon](00-ccmon.md). Replace stateless 64KB tail reads with byte-offset JSONL streaming. Add notification hook, assistant message extraction, and structured sub-agent info.

## Questions & Investigations

* Q1: ✅ SubagentInfo included in dump/serve immediately, no flag. Web UI updated too.
* Q2: ✅ Cap first-read at ~10MB. For files larger than cap, start reading from `fileSize - cap` bytes (like current tail) to establish baseline, then stream forward. Avoids slow first-parse on very large JSONL.
* Q3: ✅ R28 (last messages) also shown in web UI — not data-model-only.

## Tasks

* [x]Refactor readSessionTail to use byte-offset caching: full parse on first read, delta on subsequent reads, reset on file shrink (R27.1, R27.2)
* [x]Add tests for byte-offset streaming: first read, delta read, file shrink reset, large file correctness (R27.1, R27.2, R27.3)
* [x]Verify task counts use all TodoWrite entries across full file, not just tail (R27.3)
* [x]Extract latestAssistantMessage from JSONL — last type:"assistant" entry with text content, truncated to 200 chars; latestUserMessage already exists, confirm both populated (R28)
* [x]Add tests for latestAssistantMessage extraction and latestUserMessage pairing (R28)
* [x]Add Notification hook handling to status command: write notificationMessage + notificationTimestamp to StatusFile (R26.1)
* [x]Filter permission_prompt notifications when state is already waiting_for_permission (R26.3)
* [x]Add tests for notification status handling and filtering (R26.1, R26.3)
* [x]Add transient notification flash animation in dashboard UI, triggered by notificationTimestamp changes (R26.2)
* [x]Define shared SessionEnrichment base type: model, latestUserMessage, latestAssistantMessage, lastToolUse, tasksDone, tasksTotal (R29.1)
* [x]Define SubagentInfo extending SessionEnrichment: agentId, slug, jsonlPath; refactor ProjectState to extend SessionEnrichment (R29.1, R29.2)
* [x]Refactor countActiveSubagents into getSubagentInfos: returns SubagentInfo[], applies byte-offset streaming to each sub-agent JSONL (R29, R29.1)
* [x]Sub-agent stopped detection: mtime heuristic (45s); parent JSONL tool_result correlation deferred — agentId→tool_use_id mapping not available (R29.3)
* [x]Add tests for shared type structure, sub-agent info extraction, and stopped detection (R29.1, R29.2, R29.3)
* [x]Update ProjectState type: subagents: SubagentInfo[] added; subagentCount derived from active count for backward compat (R29)
* [x]Update server/dump serialization for new fields — automatic via JSON.stringify, no changes needed (R28, R29)
* [x]Update dashboard web UI to display latestAssistantMessage (◀), latestUserMessage (▶), SubagentInfo list with active/total count (R28, R29)

## Questions & Investigations

### Architecture Decisions

- **Shared SessionEnrichment base type**: Both `ProjectState` and `SubagentInfo` extend a common `SessionEnrichment` type. Eliminates field duplication and ensures sub-agents expose the same richness as the main session.
- **Byte-offset streaming replaces 64KB tail**: Cache entry becomes `{mtime, fileSize, byteOffset, accumulatedState}`. Accumulated state: "latest wins" for model/lastToolUse, "latest TodoWrite" for task counts. Applied to both main and sub-agent JSONL files.
- **First-read file size cap (~10MB)**: For JSONL files larger than cap, start from `fileSize - cap` bytes (same as current tail), then stream forward from there. Balances correctness vs startup cost. TodoWrite entries within the cap window are captured; earlier ones remain potentially missed (acceptable tradeoff).
- **Notification is flash-only, no new SessionState value**: notificationTimestamp in StatusFile triggers UI animation. Dashboard detects timestamp change → CSS animation.
- **Sub-agent stopped detection**: Primary: parent JSONL tool_result correlation (reliable). Fallback: mtime heuristic.

### Testing Strategy

- **Byte-offset streaming**: JSONL fixtures — write initial → parse → append → parse again → assert only new entries processed. Test file shrink reset. Verify tasksDone/tasksTotal across full file.
- **Notification**: Unit test status command with Notification hook JSON. Verify StatusFile output. Test permission_prompt filtering.
- **latestAssistantMessage**: JSONL fixture with assistant text blocks. Verify extraction and truncation.
- **Sub-agents**: Parent + sub-agent JSONL fixture pairs. Test tool_result correlation. Test fallback heuristic. Verify SubagentInfo fields.
- **Integration**: All 101 existing tests must continue passing.

## Files

- **src/sessions.ts**: Refactored readSessionTail, new SubagentInfo type, notification handling, latestAssistantMessage
- **public/index.html**: Notification flash animation, latestAssistantMessage display, SubagentInfo list
- **tests/sessions.test.ts**: New tests for streaming, notifications, sub-agents, assistant message
