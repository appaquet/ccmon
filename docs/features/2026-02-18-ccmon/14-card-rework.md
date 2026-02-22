# Phase 14: Card Rework

## Context

See [00-ccmon](00-ccmon.md). Rework dashboard cards to a unified agent-row layout: context window progress bar, unified main/sub-agent rows, pulsing indicators, sub-agent initial instruction line.

## Questions

* Q1: ✅ Progress bar max? → 128k. Orange >100k, red >120k. Visually emphasizes when context is near capacity.
* Q2: ✅ Git branch? → Dropped from UI.
* Q3: ✅ Output tokens? → Dropped. Input tokens are the context window proxy — the only important metric.
* Q4: ✅ Stopped sessions? → Always show agent rows (no pulsing dot when stopped, shows last context/messages).

## Design

```
  <project name>               <status>
  💭 [#####  ] 80k             📋 12/15    <- context bar + tasks

  * Main agent                             <- * = pulsing dot when running
    🤖 Sonnet
    > last user msg or cmd
    < last agent msg or tool

  * Sub: <description>                     <- * = pulsing dot when active
    🤖 Opus
    > initial instruction
    < last agent msg or tool
```

**Behavior**:
- Context bar: input tokens / 128k max. Green default, orange >100k, red >120k. Numeric "80k" label beside.
- Task count: `📋 12/15` inline on same row as context bar.
- Main agent row and sub-agent rows: identical structure.
- Pulsing dot: on main row when state === 'running'; on sub-agent row when isActive.
- Stopped sessions: agent rows still visible, no pulsing dots.
- Sub-agent `>` line: `latestUserActivity.text` from sub-agent JSONL (initial instruction).
- Removed: git branch line, output tokens, standalone model line, standalone activity lines.

## Tasks

All tasks are UI-only (`public/index.html`). No backend changes required — all needed data already exists.

- [ ] Add CSS for context window progress bar: `.ctx-bar`, `.ctx-fill`, `.ctx-fill-warn` (>100k orange), `.ctx-fill-danger` (>120k red), `.ctx-tasks-row` (row containing bar + task count) (R51, R52)
- [ ] Add CSS for unified agent row: `.agent-row`, `.agent-label`, `.agent-model`, `.agent-user-msg`, `.agent-assistant-msg`, `.agent-dot-running` (pulsing), `.agent-dot-stopped` (checkmark) (R53)
- [ ] Implement `renderContextBar(inputTokens, tasksDone, tasksTotal)` JS helper — returns HTML string for the context + tasks row; computes bar width % (cap at 100%), applies color class, formats "Xk" label (R51, R52)
- [ ] Implement `renderAgentRow({label, model, userActivity, assistantActivity, isActive})` JS helper — returns HTML string for one agent row; used for both main and sub-agents (R53, R54)
- [ ] Refactor `createCard()` and `updateCard()` to use new layout: header row (name + state badge only) → `renderContextBar()` → `renderAgentRow()` for main → `renderAgentRow()` per visible sub-agent; remove git branch, output token, standalone model/message lines (R55)
- [ ] Visual validation: run `bun run serve` and verify layout matches design mockup against inbox spec

## Files

- **public/index.html**: All UI changes — CSS + JS card rendering
