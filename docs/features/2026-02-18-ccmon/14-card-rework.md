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

- [x] Add CSS for context window progress bar: `.ctx-bar`, `.ctx-fill`, `.ctx-fill-warn` (>100k orange), `.ctx-fill-danger` (>120k red), `.ctx-row` (row containing bar + task count) (R51, R52)
- [x] Add CSS for unified agent row: `.agent-row`, `.agent-label`, `.agent-model`, `.agent-msg`, `.agent-msg-in`, `.agent-msg-out`, `.agent-dot`, `.agent-dot-active` (pulsing), `.agent-dot-idle` (R53)
- [x] Implement `renderContextBar(inputTokens, tasksDone, tasksTotal)` JS helper (R51, R52)
- [x] Implement `renderAgentRow({label, model, userActivity, assistantActivity, isActive})` JS helper (R53, R54)
- [x] Refactored card to new layout: header (name + state badge) → ctx row → main agent row → sub-agent rows; removed git branch, output tokens, standalone model/message lines, old task section (R55)
- [x] Visual validation: 181 tests passing

## Files

- **public/index.html**: All UI changes — CSS + JS card rendering
