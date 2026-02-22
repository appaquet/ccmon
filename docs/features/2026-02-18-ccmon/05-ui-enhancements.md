# Phase: UI Enhancements

## Context

See [00-ccmon](00-ccmon.md). Adds task count detection from session data and visual flash animations to the web UI for state transitions.

### Key Design Decisions

- `TodoWrite` tool calls exist in JSONL **both** as `"type": "progress"` (34/39 times, at `data.message.message.content[]`) and `"type": "assistant"` (at `message.content[]`). Must scan both.
- Initial R21 implementation only scanned `assistant` entries (Bug 1) and had early loop break before reaching `TodoWrite` (Bug 2). Fixed in Step 4.
- The user's ccmon sessions use `TaskCreate`/`TaskUpdate` (not `TodoWrite`). Full support needs a different architecture (full file scan, not 64KB tail). Deferred.
- Task counts follow existing stopped-session guard: only enriched for non-stopped sessions
- Web UI rebuilds DOM on every render (`grid.innerHTML = ''`) — R23 needs a JS `prevState` map for transition detection
- R22 needs no state tracking — CSS class applied directly when state is `waiting_for_permission`

## Tasks

### Step 1: Task count extraction in `src/sessions.ts` — TDD (R21)

* [x] Add `tasksDone?: number` and `tasksTotal?: number` to `SessionTailInfo` and `ProjectState` in `src/sessions.ts`
* [x] Extend `readSessionTail()` scan — opportunistic `foundTasks` flag (not in break condition), scans `assistant` entries for `tool_use` blocks with `name === 'TodoWrite'`
* [x] Propagate in `buildProjectState()` — spread `tasksDone`/`tasksTotal` from `tail` into `ProjectState`
* [x] Tests in `tests/sessions.test.ts` — 4 new tests (mixed statuses, absent, all-completed, most-recent-wins); 99 pass total
* [x] Display in `createCard()` in `public/index.html` — `"3/7 tasks"` line; guarded by `tasksTotal > 0`

### Step 2: Permission flash — CSS (R22)

* [x] Add CSS `@keyframes flash-waiting` in `public/index.html` — border/box-shadow pulse between `var(--border)` and `var(--waiting)`, `1s ease-in-out infinite`
* [x] Apply `.card-flashing-waiting` class in `createCard()` when `state === 'waiting_for_permission'`
* [x] Manual test: verified working

### Step 3: Running→stopped 5s flash — CSS + JS (R23)

* [x] Add JS `prevState = new Map()` (projectName → last state) in `public/index.html`, outside render loop
* [x] In `render()`: before clearing grid, compute `flashStopped` set — projects where `prevState === 'running'` and current `state === 'stopped'`; update `prevState` map; clean up removed projects
* [x] Add CSS `@keyframes flash-stopped` — border/box-shadow orange pulse `var(--stopped)`, `0.5s ease-in-out iteration-count: 10` (5s total)
* [x] Apply `.card-flashing-stopped` via `createCard(proj, flashStopped)` parameter
* [x] Manual test: verified working

### Step 4: R21 bugfix — TodoWrite in progress entries (R21)

Two bugs found after initial implementation:

**Bug 1** — `TodoWrite` appears in `"type": "progress"` entries (34/39 times), not just `"assistant"`. Path: `data.message.message.content[]`. Current code skips all `progress` entries.

**Bug 2** — Break condition `if (foundUser && foundModel && foundTool)` exits before reaching `TodoWrite` entries. `foundTasks` must be added to prevent premature exit.

* [x] Extend `readSessionTail()` to scan `type === 'progress'` entries for `TodoWrite` at `data.message.message.content[]` (R21)
  * Extracted `scanTodoWrite(contentBlocks, result)` helper to avoid duplication
  * Fixed `if (!message) continue;` guard that was silently skipping `progress` entries
* [x] Break condition unchanged — scan is now correct without needing `foundTasks` in break
* [x] Added `makeProgressEntry` test helper + 2 new tests for `progress`-type `TodoWrite` path; 101 pass total

### Step 5: Short model names in web UI — CSS/JS (R24)

Display transform only — `proj.model` in JSON remains full name.

* [x] Add `shortModel(model)` helper after `truncate`, before `createCard` (R24)
* [x] Replace `proj.model` with `shortModel(proj.model)` in `createCard()` parts array (R24)
* [x] Manual test: verified working

### Step 6: Running state animation — CSS (R25)

Animate the green dot in the running badge to pulse, indicating live activity.

* [x] Add `@keyframes pulse-dot` to `<style>`: opacity 1→0.35 + scale 1→0.75, `1.8s ease-in-out infinite` (R25)
* [x] Added `animation: pulse-dot 1.8s ease-in-out infinite` to `.dot-running` rule inline (R25)
* [x] Manual test: verified working

## Files

- **src/sessions.ts**: Add `tasksDone`/`tasksTotal` to `SessionTailInfo` + `ProjectState`; extend `readSessionTail()` loop to scan both `assistant` and `progress` entries; propagate in `buildProjectState()`
- **public/index.html**: CSS keyframes for animations; `createCard()` applies flash classes, task count, `shortModel()`; `render()` tracks `prevState`; `.dot-running` animation
- **tests/sessions.test.ts**: Tests for task count extraction in `readSessionTail`
