# Phase 11: Dashboard Refinements

## Context

See [00-ccmon](00-ccmon.md). Fixes and improvements from real-world usage: token counting bug, task reintroduction with modern TaskCreate/TaskUpdate tools, UI layout tweaks.

## Questions & Investigations

* Q1: Are `output_tokens` in JSONL per-call deltas or running totals? → Per-call deltas (small values like 7, 21). Confirmed from real session data. Continue summing for output.
* Q2: Are `input_tokens` + `cache_read_input_tokens` running totals? → Yes. `cache_read_input_tokens` represents the entire cached context sent each call (~119K), grows monotonically. Must take last value, not sum.
* Q3: Does `TodoWrite` still appear in modern sessions? → No. Modern Claude Code uses `TaskCreate`/`TaskUpdate`/`TaskList` exclusively. `TodoWrite` is legacy dead path.
* Q4: `TaskCreate` input shape? → `{ subject: string, description: string, activeForm: string }`. IDs assigned sequentially as strings ("1", "2", ...).
* Q5: `TaskUpdate` input shape? → `{ taskId: string, status: "pending" | "in_progress" | "completed" | "deleted" }`. May also carry `subject`, `description`, `activeForm` updates.
* Q6: Root cause of double-slash in command display? → `extractCommand()` stores the full command text including the leading `/` (e.g., `/forked /implement`). The UI additionally prepends `/ `, producing `/ /forked /implement`. Fix: replace two-field approach with single `latestUserActivity` field and let UI display text as-is.
* Q7: How does temporal ordering work for latestUserMessage vs latestCommand? → Two independent `found*` flags in the reversed scan — each field captures its category's most recent entry independently. No single temporal winner: if a plain message occurs after a command, `latestCommand` still holds the earlier command. Fix: single flag, first match wins chronologically.

## Tasks

### R45 — Last update time in card header

- [x] In `index.html`, move/add relative timestamp from card footer into card header, between project name and state pill (R45)
- [x] Style as muted text, adjust flex layout to accommodate three elements (name, time, pill) (R45)
- [x] Removed card-footer div and CSS

### R46 — Task reintroduction with TaskCreate/TaskUpdate

- [x] In `readSessionTail()`, add `scanTaskCreateUpdate()` forward-scan helper: build `Map<taskId, TaskInfo>` from `TaskCreate`/`TaskUpdate` tool_use blocks; extract task IDs from `tool_result` text ("Task #N created") (R46)
- [x] Process `TaskUpdate` tool_use blocks to patch task status in the map (R46)
- [x] Add `TaskInfo` interface and `tasks?: TaskInfo[]` to `SessionEnrichment` (R46)
- [x] Derive `tasksDone`/`tasksTotal` from tasks array (non-deleted total, completed count) (R46)
- [x] Keep `TodoWrite` parsing as legacy fallback (R46)
- [x] Delta-read merge: task maps accumulate (base first, new scan overlays) to handle stateful TaskCreate/TaskUpdate correctly (R46)
- [x] In `index.html`, display task count summary + in-progress task subjects (preferring activeForm), up to 3 (R46)
- [x] Add 7 tests: task map building, status patching, counts, deleted exclusion, numeric sort, TodoWrite fallback, TaskCreate-over-TodoWrite priority (R46)

### R47 — Fix input token counting (last value, not sum)

- [x] In `readSessionTail()`, change `inputTokens` to last-seen value via reversed scan (first match = chronologically last); `scanInputTokens` is `undefined` until set (R47)
- [x] Keep `outputTokens` as accumulated sum (R47)
- [x] Fix delta-read merge: `inputTokens` last-wins (`scanResult.inputTokens ?? baseData.inputTokens`); `outputTokens` stays additive (R47)
- [x] Updated 3 existing token tests to last-value semantics (R47)
- [x] Added 2 new tests: monotonic growth → last value, delta merge last-wins (R47)

### R48 — Agents section active indicator

- [x] In `index.html`, add pulsing green dot to "Agents" section header when any sub-agent is active (R48)
- [x] Removed "N/M active" count text; shows `⬡ agents (N)` total count instead (R48)
- [x] Reused `agent-dot agent-dot-active` CSS class (R48)

### R49 — Unify latestUserMessage + latestCommand into single latestUserActivity field

- [x] In `SessionEnrichment`, replace `latestUserMessage?: string` and `latestCommand?: string` with `latestUserActivity?: { text: string; isCommand: boolean }` (R49)
- [x] Remove `latestUserMessage`/`latestCommand` from `ProjectState` where re-declared (R49)
- [x] In `readSessionTail()`, replace two independent `found*` flags with a single `foundUserActivity` flag; first user entry encountered in the reversed scan sets `latestUserActivity`; stop searching after it's set (R49)
- [x] Fix merge step: single `latestUserActivity: scanResult.latestUserActivity ?? baseData.latestUserActivity` (R49)
- [x] In `index.html`, single block on `latestUserActivity`: commands display as-is (e.g. `/forked /implement`), messages with `▶ ` prefix; no double-slash (R49)
- [x] Updated all ~25 test assertions; added R49 single-winner test (R49)
- [x] Updated ordering tests to verify single-winner behavior (R49)

### R50 — Unify latestAssistantMessage + lastToolUse into latestAssistantActivity

- [x] In `SessionEnrichment`, replace `latestAssistantMessage?: string` and `lastToolUse?: string` with `latestAssistantActivity?: { text?: string; tool?: string }` (R50)
- [x] Remove `latestAssistantMessage` and `lastToolUse` from `ProjectState` where re-declared (R50)
- [x] In `readSessionTail()`, replace `foundAssistant` + `foundTool` with single `foundAssistantActivity` flag; first assistant entry encountered in reversed scan sets the field; within an entry, extract text block → `text`, tool_use block → `tool` independently (R50)
- [x] Update delta-read merge: `latestAssistantActivity: scanResult.latestAssistantActivity ?? baseData.latestAssistantActivity` (R50)
- [x] Update `buildProjectState()` to propagate `latestAssistantActivity`, remove old field references (R50)
- [x] Update existing tests referencing `latestAssistantMessage` or `lastToolUse` to use `latestAssistantActivity` (R50)
- [x] Add test: assistant entry with only text block → `{ text: "...", tool: undefined }` (R50)
- [x] Add test: assistant entry with only tool_use → `{ text: undefined, tool: "Bash" }` (R50)
- [x] Add test: assistant entry with both text + tool_use → `{ text: "...", tool: "Bash" }` (R50)
- [x] Add test: temporal ordering — older entry has text, newer has tool-only → tool wins (R50)
- [x] Add test: delta-read merge preserves latestAssistantActivity from base when scan has none (R50)
- [x] In `index.html`, update main session card: replace `latestAssistantMessage` display + model/lastToolUse meta line with single `latestAssistantActivity` line — show text when present, fall back to tool name (R50)
- [x] In `index.html`, update sub-agent card: replace `agent.lastToolUse ?? agent.latestAssistantMessage` with `latestAssistantActivity` display (R50)
- [x] Verify `bun test` passes — 160 tests passing (R50)

## Files

- **src/sessions.ts**: Token fix (R47), task parsing (R46), latestUserActivity refactor (R49), latestAssistantActivity refactor (R50)
- **public/index.html**: Last update time (R45), task display (R46), agents active dot (R48), latestUserActivity display (R49), latestAssistantActivity display (R50)
- **tests/sessions.test.ts**: Token fix tests (R47), task parsing tests (R46), latestUserActivity tests (R49), latestAssistantActivity tests (R50)
