# Claude concurrent sessions

## Context

[Project doc](../00-opencode-sub-agents-fixes.md)

This phase extends the same-repo concurrent-session work to Claude, but only after the OpenCode path is proven. Claude is lower priority because the current design appears fundamentally more repo-scoped: discovery picks only the latest transcript in a project directory, while status handling is centered on a shared repo-level `ccmon-status.jsonl`. The goal of this phase was to plan and then implement true concurrent same-project Claude session visibility without letting one session's status or lifecycle overwrite a sibling's state.

This work is now explicitly deferred/out of active scope. The notes below are retained as future planning context only, because the user does not currently rely on Claude multi-session monitoring enough to justify the required architecture work.

## Requirements

* R5.A: ⬜ Stop collapsing one Claude project directory to only the latest session transcript.
* R5.B: ⬜ Give each visible Claude sibling session stable session-level identity across backend payloads, CLI/server output, and UI rendering.
* R5.C: ⬜ Resolve Claude state per session rather than through a shared repo-level current-session assumption.
* R5.D: ⬜ Preserve correct parent/subagent attachment and avoid sibling-session state bleed or destructive end-of-session handling.
* R5.E: ⬜ Land the Claude work only after the OpenCode phase proves the shared multi-session model and UI path.
* R5.F: ⬜ Do not begin Claude implementation until a session-scoped status architecture is investigated, documented, and explicitly approved.

## Design

Claude likely needs a session-scoped state architecture, not just a broader transcript scan.

```text
Claude project dir
    |
    | discover multiple transcript JSONLs
    v
ClaudeBackend scan path
    |
    | build one visible main-session record per transcript/session
    v
session-scoped status store / resolution
    |
    | avoid repo-level state bleed and SessionEnd truncation hazards
    v
shared aggregation / server / dump / render
    |
    | same-repo sibling sessions remain distinct
    v
UI: multiple visible Claude sessions for one project dir
```

Unlike OpenCode, the main risk here is not only cardinality but also state ownership. The implementation should not proceed as a narrow latest-transcript tweak unless the investigation proves the current shared repo-level status architecture can safely support true sibling sessions.

## Questions & Investigations

* [x] Q: Why is Claude lower priority than OpenCode for same-repo concurrency?
  * Uncertainty: The user wanted Claude support too, but not at the same urgency.
  * Tried: Compared the current OpenCode and Claude architectures while planning the new work.
  * Result: OpenCode has a clearer latest-only collapse point and should be tackled first; Claude appears to need a deeper redesign because both discovery and state are repo-scoped today.
* [x] Q: What is the current Claude latest-only/root-cause shape?
  * Uncertainty: The visible collapse could have lived only in transcript selection or only in the renderer.
  * Tried: Investigated the current Claude scanning and status flow.
  * Result: Claude currently stores only one `latestJSONL` per project dir for the main session path, and status handling is centered on a shared repo-level `ccmon-status.jsonl`, so true same-project concurrency likely requires session-scoped state tracking.
* [x] Q: Should this phase be fully planned now or deferred until after OpenCode?
  * Uncertainty: Over-planning Claude before proving the shared OpenCode path might waste effort.
  * Tried: Asked the user whether to keep Claude exploratory, skip it for now, or add it as a second phase.
  * Result: Add it as a second lower-priority phase after OpenCode, with explicit architecture work up front.
* [x] Q: Should Claude implementation proceed automatically once investigation starts?
  * Uncertainty: The original phase structure could have implied a normal design-then-implement flow, but the current shared status-log behavior is unusually risky.
  * Tried: Had a staff-dev validate the plan against the current Claude architecture, then confirmed the recommended control point with the user.
  * Result: No — add an explicit approval gate after architecture investigation/design. Claude implementation should not start until the session-scoped status approach is reviewed and approved.
* [x] Q: Should this deferred Claude phase remain active after OpenCode was completed and live-validated?
  * Uncertainty: Research showed a plausible Claude direction, but it remained a materially bigger architecture change than OpenCode.
  * Tried: Checked back with the user after OpenCode was confirmed working.
  * Result: No — keep the notes for future reference, but drop this phase from the active workstream for now.

## Tasks

- [ ] Investigate and document the exact Claude latest-only collapse points plus status-sharing constraints (staff-dev) (R5.A, R5.C, R5.D, R5.F)
  - AC: names the exact discovery logic that selects only the latest transcript per project dir.
  - AC: documents how the shared repo-level status log currently mixes or scopes events.
  - AC: records whether the current architecture can safely support sibling sessions without redesign.
- [ ] Design a concrete session-scoped Claude state architecture before implementation starts (staff-dev) (R5.B, R5.C, R5.D, R5.F)
  - AC: recommends one concrete design for per-session state tracking and sibling-safe lifecycle handling.
  - AC: explains how one session ending avoids erasing or corrupting a sibling session's visibility.
  - AC: documents compatibility and migration expectations from the current shared repo-level status behavior.
  - AC: phase cannot proceed into implementation until this design is explicitly approved.
- [ ] Pause for approval on the Claude session-scoped status design before implementation starts (staff-dev or principal-dev review) (R5.F)
  - AC: the proposed Claude status/state architecture is reviewed as a deliberate gate, not assumed by default.
  - AC: any unresolved sibling-session bleed or lifecycle risks are either closed or explicitly accepted before coding begins.
- [ ] Implement Claude multi-session discovery and stable identity for same-project siblings (senior-dev) (R5.A, R5.B, R5.F)
  - AC: Claude scan/discovery returns multiple visible sessions from one project dir when present.
  - AC: stable session identity survives rescans and same-repo coexistence.
  - AC: latest-only selection is removed or isolated behind an explicit compatibility path.
- [ ] Implement session-scoped Claude state resolution and sibling-safe lifecycle handling (staff-dev) (R5.C, R5.D)
  - AC: waiting/stopped/closed/error state is resolved for the correct session, not a sibling.
  - AC: one session ending does not wipe another live session's state/history.
  - AC: subagents stay attached to the correct parent session.
- [ ] Wire Claude sibling sessions through shared aggregation, CLI/server, and UI after Phase 04 is proven (senior-dev) (R5.B, R5.E)
  - AC: multiple same-project Claude sessions show up together in payloads and the dashboard.
  - AC: no same-project key collisions occur.
  - AC: existing single-session Claude behavior remains correct.
- [ ] Add Claude regression coverage and run full verification (junior-dev) (R5.A, R5.B, R5.C, R5.D)
  - AC: tests reproduce the current latest-only and shared-status ambiguity before the fix.
  - AC: tests cover multiple same-project Claude sessions with different states and one sibling ending while another continues.
  - AC: targeted tests plus `npm run typecheck`, `npm run lint`, and the full test suite pass before completion is proposed.

## Files

- **src/project-utils.ts**: Claude project/session scanning helpers. Planned change: stop representing one project dir with only the latest transcript.
- **src/backends/claude.ts**: Claude backend discovery, state, enrichment, and subagent handling. Planned change: support multiple same-project sibling sessions with correct parent binding.
- **src/session-core.ts**: Shared state-resolution logic. Planned change: support session-scoped Claude state handling without sibling bleed.
- **src/status-writer.ts**: Claude hook status file writing. Planned change: avoid destructive shared-log behavior when multiple same-project sessions coexist.
- **src/cli/commands/status.ts**: Claude hook-event routing. Planned change: move toward session-scoped status targeting.
- **src/types.ts**: Shared project/session payload types. Planned change: ensure Claude siblings carry stable identity through shared paths.
- **src/server.ts**: HTTP/WebSocket payload assembly. Planned change: carry multiple same-project Claude sessions through the shared API path.
- **src/cli.ts / src/cli/commands/dump.ts**: CLI output path. Planned change: show multiple same-project Claude sessions and document selection/filtering behavior.
- **public/js/render.js**: Dashboard renderer. Planned change: render same-project Claude siblings predictably once the backend/state work is ready.
- **public/js/utils.js**: Dashboard keying/helpers. Planned change: avoid same-project key collisions for Claude siblings.
- **tests/project-utils.test.ts**: Planned regression coverage for multi-transcript discovery.
- **tests/backends/claude.test.ts**: Planned regression coverage for Claude sibling visibility, state, and subagent binding.
- **tests/session-core.test.ts**: Planned regression coverage for session-scoped Claude state resolution.
- **tests/status-writer.test.ts**: Planned regression coverage for sibling-safe Claude status lifecycle behavior.
- **tests/server.test.ts**: Planned regression coverage for shared multi-session payload aggregation.
- **tests/render.test.ts**: Planned regression coverage for same-project Claude sibling rendering.
- **tests/cli.test.ts**: Planned regression coverage for CLI multi-session output and filtering.
