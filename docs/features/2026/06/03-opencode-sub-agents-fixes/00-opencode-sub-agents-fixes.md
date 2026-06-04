# opencode-sub-agents-fixes

## Context

Project scaffold for a workstream focused on OpenCode sub-agent and permission-state fixes in this repository. Planning is intentionally separate from the setup step; this document now records the durable project scope, requirements, and phase navigation.

## Checkpoint

Implementation completed for the original sub-agent activity and permission-event fixes, including the follow-up `lastUpdated`, fast-reply, and main-agent `question.*` corrections. The linked-subagent lifecycle work is now also implemented in-repo: linked OpenCode child sessions stay visible and keep the parent project `running` until a terminal signal arrives, instead of disappearing after the old 15s/30s activity windows. A 10-minute fallback timeout now handles missing terminal signals for zombie linked children, while same-directory/unlinked fallback behavior remains non-sticky and activity-based. A follow-up review found one more gap for quiet long-running children that only emitted a late terminal event; that was also fixed by retaining terminal children briefly based on the terminal event timestamp rather than stale launch-time `time_updated`.

Verification reported by the implementation sub-agent: `npm test -- tests/backends/opencode.test.ts` passed first with 74 tests and then with 78 tests after the terminal-retention follow-up, plus `npm run typecheck` and `npm run lint` passed. `session.status` was investigated but intentionally not used, because the existing terminal status events were sufficient for the lifecycle fix. Live follow-up also passed: the user confirmed that a real 60-second sleeping sub-agent stayed visible correctly and that a real Question tool prompt behaved correctly after the plugin/runtime updates. Next step: project state can be closed out and resumed later if any regressions appear.

## Requirements

* R1: ✅ OpenCode sessions must stay classified as running while associated linked sub-agent activity is still active, so a parent session is not marked stopped prematurely and a quiet long-running child does not disappear before it terminates. (Phase: OpenCode subagent state fix, see R1.A-D in the phase doc)
* R2: ✅ OpenCode permission prompts/questions must surface in ccmon as `waiting_for_permission` instead of remaining `running`. (Phase: OpenCode permission state fix, see R2.A-C in the phase doc)

## Questions & Investigations

* [x] Q: What should the project be named?
  * Uncertainty: Current change context was `main`, which was not useful for naming.
  * Tried: Confirmed the intended high-level workstream name with the user.
  * Result: Using `opencode-sub-agents-fixes` for the folder, symlink target, and document base name.
* [x] Q: Should a phase doc be created now?
  * Uncertainty: The request said no phase existed yet while the generic workflow normally creates phase docs.
  * Tried: Confirmed whether to create only the project doc or also seed a placeholder phase.
  * Result: Creating only the project doc for now; phase docs are deferred until planning.
* [x] Q: Should active sub-agents prevent an OpenCode session from being classified as stopped?
  * Uncertainty: Current backend prioritizes the parent session and can hide children once the parent looks stale or stopped.
  * Tried: Traced the OpenCode backend state flow and existing subagent gating.
  * Result: Yes — the plan should treat active sub-agent activity as keeping the session running.
* [x] Q: Should permission prompts use a new state?
  * Uncertainty: ccmon already has a canonical `waiting_for_permission` state, but OpenCode currently doesn’t surface it reliably.
  * Tried: Checked current OpenCode docs and backend behavior.
  * Result: Reuse `waiting_for_permission`.
* [x] Q: Should unlinked/same-directory subagents be considered?
  * Uncertainty: OpenCode DB shape can include child-like sessions that are not perfectly parent-linked.
  * Tried: Reviewed the scan / subagent discovery path and current test coverage.
  * Result: Yes — include them in the investigation and fix path.
* [x] Q: What actual event family does the failing main-agent AskUserQuestion repro emit?
  * Uncertainty: The recent fix assumed the user-facing blocked state would flow through `permission.*` events.
  * Tried: Inspected the real OpenCode runtime log and the live `opencode-status.jsonl` entries for the failing session.
  * Result: The main-agent repro emits `question.asked`, `question.replied`, and `question.rejected`; the plugin does not currently map them, so no waiting state is written.
* [x] Q: Why does a 120s sleeping OpenCode sub-agent disappear from the UI?
  * Uncertainty: The sub-agent was still alive, but ccmon eventually hid it and could mark the project stopped.
  * Tried: Traced the recent sleep child session in SQLite and the shared OpenCode status log, then compared it against the current thresholds in `src/timing.ts` and the OpenCode backend heuristics.
  * Result: The child session was quiet after launch, `time_updated` never advanced during the sleep, and ccmon expired it through 15s/30s activity windows. The parent can also stop once the child-activity and parent-running grace windows expire.
* [x] Q: What UX should quiet linked sub-agents use?
  * Uncertainty: A long-running child may be silent for a long time without being done.
  * Tried: Confirmed the intended behavior with the user.
  * Result: Keep linked sub-agents visible/active until an explicit terminal event, keep the parent running too, and use only a much longer fallback timeout for missing terminal signals.

## Phases 

### ✅ 01 Phase: OpenCode subagent state fix
[01-opencode-subagent-state-fix](01-opencode-subagent-state-fix.md)
Make OpenCode state resolution aware of active sub-agent work so a parent session is not classified as stopped while child work continues.

### ✅ 02 Phase: OpenCode permission state fix
[02-opencode-permission-state-fix](02-opencode-permission-state-fix.md)
Normalize OpenCode permission-question handling so ccmon shows the session as waiting for permission while approval is pending.

## Files

- **proj**: Symlink to the active project documentation folder for this workstream.
- **src/backends/opencode.ts**: OpenCode session discovery, state resolution, and subagent handling. Changes: child activity, fast reply, and `question.*` normalization fixes.
- **src/backends/build-project-state.ts**: Gates subagent inclusion based on the parent state.
- **resources/opencode-plugin/ccmon.ts**: Emits OpenCode status events that feed state classification. Changes: aligned permission event hooks to current OpenCode generic permission events and added `question.*` handling for main-agent prompts.
- **~/.config/opencode/plugins/ccmon.ts**: Installed plugin copy used by live OpenCode sessions. Pending manual sync so the live environment picks up the new `question.*` mapping.
- **~/.local/share/opencode/log/**: Runtime evidence used to confirm the main-agent question repro emits `question.*` events.
- **~/.local/state/ccmon/opencode-status.jsonl**: Live status log used to prove no waiting event was written for the failing question prompt.
- **opencode.db / session table**: Runtime evidence used to confirm the quiet 120s sleep child session stopped updating `time_updated` while still alive.
- **src/session-core.ts**: Shared state-resolution logic and permission-state reference behavior.
- **src/timing.ts**: State freshness thresholds used by OpenCode backend heuristics.
- **tests/backends/opencode.test.ts**: OpenCode backend regression coverage. Changes: child-activity, permission-state, and `question.*` regressions covered.
- **tests/session-core.test.ts**: Permission/state-resolution reference coverage.
