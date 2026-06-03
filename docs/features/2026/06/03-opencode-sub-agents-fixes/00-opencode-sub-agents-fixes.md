# opencode-sub-agents-fixes

## Context

Project scaffold for a workstream focused on OpenCode sub-agent and permission-state fixes in this repository. Planning is intentionally separate from the setup step; this document now records the durable project scope, requirements, and phase navigation.

## Checkpoint

Implementation completed for both planned fixes. OpenCode state resolution now keeps the parent session effectively running while linked or same-directory child activity is still active, ignores recently-updated children that are already terminal (`stopped`, `closed`, `error`), and keeps `lastUpdated` aligned with same-directory child activity so active projects are not filtered as stale. Permission handling was aligned to current OpenCode generic permission events so pending approval surfaces as `waiting_for_permission` and explicit replies clear immediately back to normal resolution.

Verification reported by the implementation sub-agent: `npm test -- tests/backends/opencode.test.ts` (67 passed), full `npm test` (375 passed), `npm run typecheck`, `npm run lint`, and `npx biome check resources/opencode-plugin/ccmon.ts` all passed. A follow-up reviewer found two logic gaps (`lastUpdated` mismatch and fast permission replies), both were fixed and regression-tested in the same implementation pass. Next step: save updated checkpoint/docs and ask the user for sign-off on requirements/phases.

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

## Phases 

### 🔄 01 Phase: OpenCode subagent state fix
[01-opencode-subagent-state-fix](01-opencode-subagent-state-fix.md)
Make OpenCode state resolution aware of active sub-agent work so a parent session is not classified as stopped while child work continues.

### 🔄 02 Phase: OpenCode permission state fix
[02-opencode-permission-state-fix](02-opencode-permission-state-fix.md)
Normalize OpenCode permission-question handling so ccmon shows the session as waiting for permission while approval is pending.

## Files

- **proj**: Symlink to the active project documentation folder for this workstream.
- **src/backends/opencode.ts**: OpenCode session discovery, state resolution, and subagent handling.
- **src/backends/build-project-state.ts**: Gates subagent inclusion based on the parent state.
- **resources/opencode-plugin/ccmon.ts**: Emits OpenCode status events that feed state classification. Changes: aligned permission event hooks to current OpenCode generic permission events.
- **src/session-core.ts**: Shared state-resolution logic and permission-state reference behavior.
- **src/timing.ts**: State freshness thresholds used by OpenCode backend heuristics.
- **tests/backends/opencode.test.ts**: OpenCode backend regression coverage. Changes: child-activity and permission-state regressions covered.
- **tests/session-core.test.ts**: Permission/state-resolution reference coverage.
