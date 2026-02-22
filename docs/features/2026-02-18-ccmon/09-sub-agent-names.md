# Phase 09: Sub-Agent Names

## Context

See [00-ccmon](00-ccmon.md). Show meaningful names for sub-agents in the dashboard instead of raw `agentId`. Claude Code's UI already shows descriptions — they live in the parent session JSONL.

## Questions

* Q1: ✅ Where is the sub-agent name stored? → Parent session JSONL has `type: "queue-operation"` entries where `operation === "enqueue"` and `content` (JSON string) contains `{ task_id, description }`. `task_id` equals the `agentId` from `agent-{agentId}.jsonl` filename.
* Q2: ✅ Is the description in the sub-agent JSONL first line? → No. First line has `agentId` and `slug` but not the short description.
* Q3: ✅ How to correlate? → Accumulate during `readSessionTail()` streaming — no separate read needed.
* Q4: ✅ Is description extraction a separate JSONL read or part of streaming? → Part of streaming. `readSessionTail()` already byte-offset streams the parent JSONL. It also collects `queue-operation` enqueue entries into `SessionTailInfo.agentDescriptions: Map<agentId, description>`. Delta reads append new entries as new agents are launched. `getSubagentInfos()` reads from the already-cached map — zero extra I/O.

## Architecture

`SessionTailInfo` gains `agentDescriptions: Map<string, string>`. During `readSessionTail()`, for each line with `type === "queue-operation"` and `operation === "enqueue"`, parse `content` JSON and add `task_id → description` to the map. Delta reads merge new entries into the cached map. `getSubagentInfos()` receives the map via `SessionTailInfo` and attaches descriptions without touching JSONL.

## Tasks

- [ ] Add `agentDescriptions: Map<string, string>` to `SessionTailInfo` and `SessionTailCache` in `sessions.ts` (R36)
- [ ] In `readSessionTail()`, collect `type === "queue-operation"` + `operation === "enqueue"` entries: parse `content` JSON, accumulate `task_id → description` into `agentDescriptions`; delta reads merge new entries (R36)
- [ ] Add `description?: string` to `SubagentInfo` interface (R36)
- [ ] Update `getSubagentInfos()` to receive `agentDescriptions` from the cached `SessionTailInfo` and attach `description` to each `SubagentInfo` (no extra JSONL read) (R36)
- [ ] In `index.html` sub-agent rendering, display `agent.description ?? agent.agentId` (R36)
- [ ] Add test: description populated from `queue-operation` enqueue entry via `readSessionTail()` (R36)
- [ ] Add test: delta read appends new queue-operation descriptions without losing previous ones (R36)
- [ ] Add test: description `undefined` when no `queue-operation` in parent JSONL (R36)

## Files

- **src/sessions.ts**: `agentDescriptions` in `SessionTailInfo`/cache; extraction in `readSessionTail()`; `description` field on `SubagentInfo`; updated `getSubagentInfos()`
- **public/index.html**: Display `agent.description ?? agent.agentId` in sub-agent rows
- **tests/sessions.test.ts**: 3 new tests for streaming description extraction and delta accumulation
