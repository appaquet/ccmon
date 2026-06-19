# OpenCode subagent state fix

## Context

[Project doc](../00-opencode-sub-agents-fixes.md)

This phase covers the first reported issue: OpenCode sessions can be marked stopped even while sub-agent work is still active. The work here is to make session-state derivation consult sub-agent activity before falling back to stopped.

## Requirements

* R1.A: ✅ Identify which OpenCode session rows / logs represent active sub-agent work, including linked children and any same-directory/unlinked cases that are relevant in real data.
* R1.B: ✅ Update state-resolution logic so active sub-agent activity prevents a false `stopped` classification.
* R1.C: ✅ Preserve correct stopped/stale behavior when no active sub-agent work remains.
* R1.D: ✅ Linked OpenCode sub-agents must remain visible and keep the parent project `running` until an explicit terminal signal arrives, even when the child is quiet for longer than the old 15s/30s activity windows.

## Questions & Investigations

* [x] Q: Should terminal child sessions keep the parent session running?
  * Uncertainty: A recently-updated child could still have a terminal state in the plugin log.
  * Tried: Checked the current child-state handling and added regression coverage around recent-but-terminal children.
  * Result: No — child sessions with `stopped`, `closed`, or `error` states do not keep the parent running.
* [x] Q: How should same-directory unlinked child-like sessions be treated?
  * Uncertainty: Some OpenCode activity can appear without a clean `parent_id` linkage.
  * Tried: Followed the existing same-directory fallback pattern and validated it against the reported stopped-while-busy failure mode.
  * Result: At the time of this phase, same-directory unlinked active sessions continued to act as a running fallback heuristic. Later Phase 04 same-repo concurrent-session work narrowed that rule: top-level `parent_id IS NULL` peer sessions no longer act as fallback child activity for each other, because they are now visible peers rather than hidden child-like evidence.
* [x] Q: Does `computeLastUpdated()` use the same same-directory fallback heuristic as running-state resolution?
  * Uncertainty: Review found a possible mismatch where a project can resolve to `running` via an unlinked child while `lastUpdated` still looks stale.
  * Tried: Compared the `computeLastUpdated()` query against the running-state fallback path and added regression coverage for same-directory child freshness.
  * Result: No at first; updated `computeLastUpdated()` to include the same same-directory active-child path, so running state and freshness agreed for the scope of this phase. Later Phase 04 same-repo concurrent-session work narrowed that same-directory fallback so visible top-level peer sessions no longer share freshness or running-state keepalive.
* [x] Q: Why did the recent 120s sleep child disappear even though it was still alive?
  * Uncertainty: The repro looked like a missed status update or bad child-parent linkage.
  * Tried: Inspected the real child session timestamps and current child inclusion logic.
  * Result: The linked child session stayed quiet, `time_updated` remained at launch time, and ccmon expired it through `SUBAGENT_ACTIVE_THRESHOLD_MS`/`SUBAGENT_EXPIRY_MS` instead of tracking lifecycle until terminal.
* [x] Q: Should durable lifecycle tracking apply to all same-directory sessions or only true linked children?
  * Uncertainty: The older running-state fixes support some same-directory/unlinked heuristics.
  * Tried: Confirmed the intended scope with the user.
  * Result: The durable lifecycle fix should focus on linked children (`parent_id` relationship) only.
* [x] Q: Should `session.status` drive the lifecycle fix?
  * Uncertainty: OpenCode emits `session.status`, and it might have offered a fresher lifecycle signal than DB timestamps.
  * Tried: Investigated its practical usefulness against the already-captured plugin status events and the real 120s sleep repro.
  * Result: No for now — existing `session.idle` / `session.error` / `session.deleted` terminal signals plus linked-child lifecycle tracking were sufficient, while adding `session.status` would add event-shape and plugin-risk without changing the core fix.
* [x] Q: Should linked children remain briefly visible after a late terminal event, even if `time_updated` is stale?
  * Uncertainty: Review found that a quiet long-running child can emit a terminal status after >30s and disappear immediately because SQLite `time_updated` still reflects launch time.
  * Tried: Updated terminal retention to use the terminal status event timestamp instead of stale launch-time `time_updated`, then added quiet-run idle/error regressions.
  * Result: Yes — quiet long-running linked children now remain visible briefly as inactive after terminal events, while no longer keeping the parent `running`.
* [x] Q: Did the live sub-agent stay visible through a real sleep run after the lifecycle fix?
  * Uncertainty: Automated backend coverage was strong, but the real UI repro still needed confirmation.
  * Tried: Launched a real 60-second sleeping sub-agent and observed the live UI behavior.
  * Result: Yes — the sub-agent stayed visible through the run and behaved correctly.

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
- [x] Investigate whether `session.status` can provide durable linked-child lifecycle signals in addition to current status events (staff-dev) (R1.A, R1.D)
  - AC: documents the real `session.status` payload shape and whether it can corroborate busy/idle lifecycle for quiet linked sub-agents.
- [x] Implement lifecycle-based linked sub-agent retention beyond the old 15s/30s activity windows (senior-dev) (R1.B-R1.D)
  - AC: a linked sub-agent that sleeps for ~120s remains visible in the UI for the full run until it emits a terminal signal.
  - AC: the parent project remains `running` while the linked child is still non-terminal.
  - AC: the fix does not make same-directory/unlinked sessions permanently sticky.
- [x] Add regression tests for quiet linked-child lifecycle and terminal transition behavior (senior-dev or junior-dev) (R1.B-R1.D)
  - AC: tests fail before the fix and pass after it.
  - AC: tests cover a quiet linked child older than 30s, the parent staying `running`, and the child turning terminal when `session.idle`/`session.error` arrives.
- [x] Decide and implement a long fallback timeout for missing linked-child terminal events (senior-dev) (R1.C, R1.D)
  - AC: linked children do not disappear after the old short windows.
  - AC: obviously orphaned/zombie linked children still expire after a much longer safety window.
- [x] Run targeted verification against the 120s sleep repro and related backend tests (senior-dev, may need user retest for live plugin/runtime behavior) (R1.B-R1.D)
  - AC: targeted OpenCode backend tests pass.
  - AC: the 120s sleep repro no longer disappears mid-run.
- [x] Retain linked children briefly after terminal status events even when `time_updated` stayed stale during the run (senior-dev) (R1.C, R1.D)
  - AC: a quiet long-running linked child does not disappear immediately on the refresh that first sees its terminal `session.idle` / `session.error` event.
  - AC: terminal linked children still stop keeping the parent `running`.

## Files

- **src/backends/opencode.ts**: Primary state-resolution and sub-agent discovery logic. Changes: linked children now use lifecycle-based retention until terminal or a long fallback timeout; terminal child retention is keyed from terminal event time rather than stale launch-time timestamps; parent running state follows linked non-terminal children. Later Phase 04 narrowed same-directory fallback so visible top-level peers no longer count as fallback child activity.
- **src/backends/build-project-state.ts**: Controls whether sub-agents are surfaced for a project.
- **src/backends/types.ts**: Backend contract and state-model boundaries.
- **src/timing.ts**: Active/stale thresholds used by the OpenCode heuristics. Changes: adds long linked-child lifecycle fallback timeout.
- **tests/backends/opencode.test.ts**: Regression coverage for OpenCode state handling. Changes: linked-child, unlinked-child, recent-terminal-child, `lastUpdated` freshness alignment, quiet linked-child lifecycle cases, and late-terminal retention cases covered.
- **opencode.db / session table**: Runtime evidence for linked child `time_updated` remaining stale during a long sleep.
- **~/.local/state/ccmon/opencode-status.jsonl**: Runtime evidence for launch/terminal child events without heartbeats during the 120s sleep repro.
