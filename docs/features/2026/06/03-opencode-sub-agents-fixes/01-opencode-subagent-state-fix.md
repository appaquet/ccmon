# OpenCode subagent state fix

## Context

[Project doc](../00-opencode-sub-agents-fixes.md)

This phase covers the first reported issue: OpenCode sessions can be marked stopped even while sub-agent work is still active. The work here is to make session-state derivation consult sub-agent activity before falling back to stopped.

## Requirements

* R1.A: ⬜ Identify which OpenCode session rows / logs represent active sub-agent work, including linked children and any same-directory/unlinked cases that are relevant in real data.
* R1.B: ⬜ Update state-resolution logic so active sub-agent activity prevents a false `stopped` classification.
* R1.C: ⬜ Preserve correct stopped/stale behavior when no active sub-agent work remains.

## Questions & Investigations

* [x] Q: Should terminal child sessions keep the parent session running?
  * Uncertainty: A recently-updated child could still have a terminal state in the plugin log.
  * Tried: Checked the current child-state handling and added regression coverage around recent-but-terminal children.
  * Result: No — child sessions with `stopped`, `closed`, or `error` states do not keep the parent running.
* [x] Q: How should same-directory unlinked child-like sessions be treated?
  * Uncertainty: Some OpenCode activity can appear without a clean `parent_id` linkage.
  * Tried: Followed the existing same-directory fallback pattern and validated it against the reported stopped-while-busy failure mode.
  * Result: Same-directory unlinked active sessions continue to act as a running fallback heuristic.
* [x] Q: Does `computeLastUpdated()` use the same same-directory fallback heuristic as running-state resolution?
  * Uncertainty: Review found a possible mismatch where a project can resolve to `running` via an unlinked child while `lastUpdated` still looks stale.
  * Tried: Compared the `computeLastUpdated()` query against the running-state fallback path and added regression coverage for same-directory child freshness.
  * Result: No at first; updated `computeLastUpdated()` to include the same same-directory active-child path, so running state and freshness now agree.

## Tasks

- [x] Investigate OpenCode ancestry and sub-agent data shape (staff-dev) (R1.A)
  - AC: documented the exact signals used to decide whether child work is active, including any edge cases around unlinked children.
- [x] Implement sub-agent-aware state resolution (senior-dev) (R1.B, R1.C)
  - AC: a session with active sub-agent work is no longer reported as stopped just because the parent row is stale or idle.
  - AC: sessions still fall back to stopped when there is no active parent or child work.
- [x] Add regression tests for linked and unlinked child scenarios (senior-dev or junior-dev, depending on fixture complexity) (R1.A-R1.C)
  - AC: tests reproduce the bad classification before the fix and pass after it.
  - AC: tests cover both the active-child case and the stale/no-child case.
- [x] Run targeted backend verification (senior-dev) (R1.B-R1.C)
  - AC: relevant OpenCode backend tests pass.
  - AC: any command that surfaces project state still reports the expected running/stopped result.
- [x] Align `computeLastUpdated()` with same-directory unlinked-child activity if the review finding is confirmed (senior-dev) (R1.B, R1.C)
  - AC: a project kept alive by same-directory child activity also reports a fresh enough `lastUpdated` to avoid stale filtering mismatches.

## Files

- **src/backends/opencode.ts**: Primary state-resolution and sub-agent discovery logic. Changes: parent `stopped` no longer wins over active linked or same-directory child activity, and `lastUpdated` now stays aligned with same-directory child activity.
- **src/backends/build-project-state.ts**: Controls whether sub-agents are surfaced for a project.
- **src/backends/types.ts**: Backend contract and state-model boundaries.
- **src/timing.ts**: Active/stale thresholds used by the OpenCode heuristics.
- **tests/backends/opencode.test.ts**: Regression coverage for OpenCode state handling. Changes: linked-child, unlinked-child, recent-terminal-child, and `lastUpdated` freshness alignment cases covered.
