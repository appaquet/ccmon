# opencode-sub-agents-fixes

## Context

Project scaffold for a workstream focused on OpenCode sub-agent and permission-state fixes in this repository. Planning is intentionally separate from the setup step; this document now records the durable project scope, requirements, and phase navigation.

## Checkpoint

Implementation completed for the original sub-agent activity and permission-event fixes, including the follow-up `lastUpdated` and fast-reply corrections. Live investigation then found a remaining main-agent gap: OpenCode emits `question.asked`, `question.replied`, and `question.rejected` for the Question tool, while the installed `ccmon` plugin only mapped `permission.asked` / `permission.replied`. The repo plugin and backend are now updated so the question-tool path writes and resolves `waiting_for_permission` the same way as the permission path, with regression tests covering `question.asked`, `question.replied`, and `question.rejected`.

Concrete evidence came from the live OpenCode logs and status log for session `ses_1720118f1ffeL4CCrIke5YE6ek`: OpenCode published `question.asked` at `2026-06-03T18:25:28Z` and `question.replied`/`question.rejected` on later attempts, but `~/.local/state/ccmon/opencode-status.jsonl` only recorded `chat.message` → `running` and later `session.idle` → `stopped`, with no waiting event in between. The code fix is complete and test-passing, but live verification is still blocked because this environment could not overwrite `~/.config/opencode/plugins/ccmon.ts` (`read-only file system`). Next step: manually sync the installed plugin copy, reload/restart OpenCode, and re-run the main-agent question repro.

## Requirements

* R1: ⬜ OpenCode sessions must stay classified as running while associated sub-agent activity is still active, so a parent session is not marked stopped prematurely. (Phase: OpenCode subagent state fix, see R1.A-C in the phase doc)
* R2: ⬜ OpenCode permission prompts/questions must surface in ccmon as `waiting_for_permission` instead of remaining `running`. (Phase: OpenCode permission state fix, see R2.A-C in the phase doc)

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

## Phases 

### 🔄 01 Phase: OpenCode subagent state fix
[01-opencode-subagent-state-fix](01-opencode-subagent-state-fix.md)
Make OpenCode state resolution aware of active sub-agent work so a parent session is not classified as stopped while child work continues.

### 🔄 02 Phase: OpenCode permission state fix
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
- **src/session-core.ts**: Shared state-resolution logic and permission-state reference behavior.
- **src/timing.ts**: State freshness thresholds used by OpenCode backend heuristics.
- **tests/backends/opencode.test.ts**: OpenCode backend regression coverage. Changes: child-activity, permission-state, and `question.*` regressions covered.
- **tests/session-core.test.ts**: Permission/state-resolution reference coverage.
