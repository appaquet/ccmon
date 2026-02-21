# Phase: UI Enhancements

## Context

See [00-ccmon](00-ccmon.md). Adds task count detection from session data and visual flash animations to the web UI for state transitions.

### Key Design Decisions

- `TodoWrite` tool calls exist in JSONL `assistant` entries: `message.content[].type === 'tool_use'` with `name === 'TodoWrite'`, `input.todos` is an array of `{ content, status, activeForm }`. Statuses: `completed`, `in_progress`, `pending`
- Skip `progress` entries (different nesting); only scan `assistant` entries (already the pattern in `readSessionTail()`)
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
* [ ] Manual test: trigger `waiting_for_permission` state, verify visual pulse

### Step 3: Running→stopped 5s flash — CSS + JS (R23)

* [x] Add JS `prevState = new Map()` (projectName → last state) in `public/index.html`, outside render loop
* [x] In `render()`: before clearing grid, compute `flashStopped` set — projects where `prevState === 'running'` and current `state === 'stopped'`; update `prevState` map; clean up removed projects
* [x] Add CSS `@keyframes flash-stopped` — border/box-shadow orange pulse `var(--stopped)`, `0.5s ease-in-out iteration-count: 10` (5s total)
* [x] Apply `.card-flashing-stopped` via `createCard(proj, flashStopped)` parameter
* [ ] Manual test: stop a running Claude session, verify 5s orange flash

## Files

- **src/sessions.ts**: Add `tasksDone`/`tasksTotal` to `SessionTailInfo` + `ProjectState`; extend `readSessionTail()` loop; propagate in `buildProjectState()`
- **public/index.html**: CSS keyframes for both animations; `createCard()` applies `card-flashing-waiting` + displays task count; `render()` tracks `prevState` and applies `card-flashing-stopped`
- **tests/sessions.test.ts**: 4 new tests for task count extraction in `readSessionTail`
