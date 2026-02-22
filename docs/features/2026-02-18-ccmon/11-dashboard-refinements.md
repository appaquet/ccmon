# Phase 11: Dashboard Refinements

## Context

See [00-ccmon](00-ccmon.md). Fixes and improvements from real-world usage: token counting bug, task reintroduction with modern TaskCreate/TaskUpdate tools, UI layout tweaks.

## Questions

* Q1: Are `output_tokens` in JSONL per-call deltas or running totals? → Per-call deltas (small values like 7, 21). Confirmed from real session data. Continue summing for output.
* Q2: Are `input_tokens` + `cache_read_input_tokens` running totals? → Yes. `cache_read_input_tokens` represents the entire cached context sent each call (~119K), grows monotonically. Must take last value, not sum.
* Q3: Does `TodoWrite` still appear in modern sessions? → No. Modern Claude Code uses `TaskCreate`/`TaskUpdate`/`TaskList` exclusively. `TodoWrite` is legacy dead path.
* Q4: `TaskCreate` input shape? → `{ subject: string, description: string, activeForm: string }`. IDs assigned sequentially as strings ("1", "2", ...).
* Q5: `TaskUpdate` input shape? → `{ taskId: string, status: "pending" | "in_progress" | "completed" | "deleted" }`. May also carry `subject`, `description`, `activeForm` updates.

## Tasks

### R45 — Last update time in card header

- [ ] In `index.html`, move/add relative timestamp from card footer into card header, between project name and state pill (R45)
- [ ] Style as muted text, adjust flex layout to accommodate three elements (name, time, pill) (R45)

### R46 — Task reintroduction with TaskCreate/TaskUpdate

- [ ] In `readSessionTail()`, add forward-scan logic to process `TaskCreate` tool_use blocks: build `Map<taskId, { subject, status }>` with initial status `pending` (R46)
- [ ] Process `TaskUpdate` tool_use blocks to patch task status in the map (R46)
- [ ] Add `tasks?: Array<{ id: string; subject: string; status: string; activeForm?: string }>` to `SessionEnrichment` (R46)
- [ ] Derive `tasksDone`/`tasksTotal` from tasks array for backward compat (R46)
- [ ] Keep `TodoWrite` parsing as legacy fallback (R46)
- [ ] In `index.html`, display task count summary + list of in-progress task subjects (R46)
- [ ] Add tests: TaskCreate builds task map, TaskUpdate patches status, mixed TodoWrite+TaskCreate session (R46)

### R47 — Fix input token counting (last value, not sum)

- [ ] In `readSessionTail()`, change `inputTokens` from accumulated sum to last-seen value: take the most recent assistant entry's `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (R47)
- [ ] Keep `outputTokens` as accumulated sum (per-call deltas, correct to sum) (R47)
- [ ] Fix delta-read merge logic: for `inputTokens`, last value wins (not additive); for `outputTokens`, keep additive merge (R47)
- [ ] Update existing token tests to expect last-value semantics for input, sum for output (R47)
- [ ] Add test: multi-entry session where input grows monotonically, verify result = last entry value (R47)

### R48 — Agents section active indicator

- [ ] In `index.html`, add pulsing green dot to "Agents" section header when any sub-agent is active (R48)
- [ ] Remove "N/M active" count text from agents header (R48)
- [ ] Reuse existing `agent-dot agent-dot-active` CSS class for the pulsing dot (R48)

## Files

- **src/sessions.ts**: Token fix (R47), task parsing (R46)
- **public/index.html**: Last update time (R45), task display (R46), agents active dot (R48)
- **tests/sessions.test.ts**: Token fix tests (R47), task parsing tests (R46)
