# opencode-sub-agents-fixes

## Context

Project scaffold for a workstream focused on OpenCode sub-agent and permission-state fixes in this repository. Planning is intentionally separate from the setup step; this document now records the durable project scope, requirements, and phase navigation.

## Checkpoint

Implementation completed for the original sub-agent activity and permission-event fixes, including the follow-up `lastUpdated`, fast-reply, and main-agent `question.*` corrections. The linked-subagent lifecycle work is now also implemented in-repo: linked OpenCode child sessions stay visible and keep the parent project `running` until a terminal signal arrives, instead of disappearing after the old 15s/30s activity windows. A 10-minute fallback timeout now handles missing terminal signals for zombie linked children, while same-directory/unlinked fallback behavior remains non-sticky and activity-based. A follow-up review found one more gap for quiet long-running children that only emitted a late terminal event; that was also fixed by retaining terminal children briefly based on the terminal event timestamp rather than stale launch-time `time_updated`.

Planning resumed for a narrow UX follow-up and implementation is now in-repo: OpenCode sub-agents no longer need to render as `Sub: ses_XYZ`, because the backend now propagates the child session's raw `title` as `sessionName` and the renderer prefers `description -> sessionName -> slug -> agentId` for subagent labels. This keeps the OpenCode change scoped to existing shared naming abstractions without trimming or rewriting the child title in the backend, so long titles remain a frontend presentation concern.

Verification reported by the implementation sub-agent: `npx vitest run tests/backends/opencode.test.ts tests/render.test.ts` passed with 82 tests, `npm run typecheck` passed, and `npm run lint` passed. A direct `npx biome check src/ tests/ public/js/render.js` surfaced additional `public/js/render.js` diagnostics, but the repository lint target currently excludes `public/`, so the implementation stayed within the existing repo verification contract rather than broadening scope into unrelated frontend cleanup. Next step: optionally do a live UI smoke check and decide whether to mark the new requirement complete.

Planning has now resumed for a larger follow-up in the same workstream: ccmon currently collapses multiple same-repo main sessions down to whichever session most recently had activity, which is especially limiting for OpenCode where concurrent top-level sessions are easy to create and switch between. The next planned implementation focus is a new OpenCode-first phase that makes all concurrent same-directory top-level OpenCode sessions visible as peer sessions, while keeping `parent_id` children as subagents and preserving existing stale filtering. A second lower-priority Claude phase is now planned behind it because Claude likely needs a deeper per-session status redesign rather than a local latest-session tweak.

That OpenCode-first implementation is now complete and user-validated in a live smoke check. OpenCode no longer collapses same-directory top-level sessions to only the newest one, `dump --project` returns all matching visible sibling sessions, watch-mode filtered output emits explicit empty arrays for sibling removal reconciliation, and the dashboard now keys OpenCode cards by `sessionId` while showing a visible session-level differentiator (`sessionName` first, short session id fallback). Follow-up correctness and staff reviews also closed the watch-reconciliation, incremental ordering, and peer-state-bleed gaps. Claude same-repo concurrent sessions were researched afterward, but the user explicitly deprioritized/dropped that follow-up for now because Claude multi-session monitoring is not used often enough to justify the architecture work.

Review comments were then researched across the implemented OpenCode work and the deferred Claude path. The active prioritized follow-up plan is: first restore the documented NDJSON contract for `dump --watch`, then stop server/CLI disambiguation from mutating canonical `ProjectState` names across rescans, then clean up the stale Phase 03/R3 status markers, and only after that consider low-priority test readability cleanup. The Claude review comments remain grouped as deferred Phase 05 architecture notes rather than active implementation work.

## Requirements

* R1: ✅ OpenCode sessions must stay classified as running while associated linked sub-agent activity is still active, so a parent session is not marked stopped prematurely and a quiet long-running child does not disappear before it terminates. (Phase: OpenCode subagent state fix, see R1.A-D in the phase doc)
* R2: ✅ OpenCode permission prompts/questions must surface in ccmon as `waiting_for_permission` instead of remaining `running`. (Phase: OpenCode permission state fix, see R2.A-C in the phase doc)
* R3: ⬜ OpenCode sub-agents shown in the UI must display the child sub-agent session title instead of the raw `ses_*` session id, while preserving safe fallback behavior when no human-readable title exists. (Phase: OpenCode subagent display name fix, see R3.A-C in the phase doc)
* R4: ✅ ccmon must surface all concurrent top-level OpenCode sessions in the same repo/directory instead of collapsing them to only the latest active session, while keeping linked child sessions as subagents and preserving safe per-session state/filtering behavior. (Phase: OpenCode concurrent sessions, see R4.A-G in the phase doc)
* R5: ⬜ ccmon could later extend the same-repo concurrent-session support to Claude sessions, but this is now explicitly deferred/out of active scope unless priorities change because the user does not rely on Claude multi-session monitoring enough to justify the required architecture work. (Phase: Claude concurrent sessions, retained as deferred notes)

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
* [x] Q: Can ccmon show the OpenCode sub-agent name instead of `Sub: ses_XYZ`?
  * Uncertainty: The UI currently shows the sub-agent id, and it was unclear whether a stable human-readable sub-agent name already existed in the backend pipeline.
  * Tried: Investigated the OpenCode SQLite session rows, shared `SubagentInfo` type, backend mapping, and frontend label fallback order.
  * Result: Yes — use the child OpenCode session's own `session.title` as the backend source of truth, map it onto `subagents[*].sessionName`, and let the frontend prefer that over the raw `agentId`.
* [x] Q: Does the requested display name refer to the main OpenCode session title or the sub-agent child session title?
  * Uncertainty: "Session title" could have referred to either level.
  * Tried: Confirmed the intended target with the user during planning.
  * Result: Use the sub-agent child session title only; do not replace the main session title behavior.
* [x] Q: Should the backend trim or normalize the sub-agent title before exposing it?
  * Uncertainty: Real titles can include suffixes such as `(@senior-dev subagent)` and may be long.
  * Tried: Asked the user to choose between raw title propagation and backend normalization.
  * Result: No backend trimming or normalization. Expose the full child session title as-is; any truncation/ellipsis belongs in the frontend display layer.
* [x] Q: Should this work broaden into a cross-backend naming cleanup?
  * Uncertainty: Claude subagents already surface better labels, but there could be an opportunity to generalize fallback ordering.
  * Tried: Confirmed scope expectations with the user.
  * Result: Keep implementation scope on OpenCode, but preserve/extend the shared subagent naming abstraction so other backends remain compatible.
* [x] Q: What is the current root cause for only one same-repo OpenCode session showing?
  * Uncertainty: The visible collapse could have been caused by backend selection, shared aggregation, or only the renderer.
  * Tried: Investigated the current OpenCode backend and shared project-state pipeline.
  * Result: The main OpenCode collapse point is backend selection: `scanProjects()` groups by directory and picks only the newest top-level session, and the surrounding shared model/UI also assumes one main session per repo card.
* [x] Q: What UX shape should Phase 04 target for same-repo OpenCode concurrency?
  * Uncertainty: The new support could have been modeled as one repo card with nested sessions or as multiple peer session entries that share repo context.
  * Tried: Researched the current architecture and asked the user to choose the desired target.
  * Result: Show concurrent top-level OpenCode sessions as separate peer session entries, not as one repo card with nested peer sessions.
* [x] Q: How should ccmon distinguish peer sessions from subagents for same-directory OpenCode sessions?
  * Uncertainty: Some same-directory child-like sessions could have been promoted into peer visibility by mistake.
  * Tried: Reviewed the OpenCode schema assumptions and confirmed the intended boundary with the user.
  * Result: Top-level same-directory sessions are peers; rows linked through `parent_id` remain subagents under their parent.
* [x] Q: How long should same-repo sibling sessions remain visible?
  * Uncertainty: Showing all concurrent sessions forever would make the dashboard noisy, but hiding them too quickly would defeat the feature.
  * Tried: Asked the user to choose between current staleness, extended retention, or active-only visibility.
  * Result: Preserve the existing staleness/freshness rules; show all concurrent sessions while visible under the current filtering model.
* [x] Q: What ordering and identity rules should the OpenCode phase plan around?
  * Uncertainty: Same-repo siblings can share repo name/path, so ordering and disambiguation needed to be explicit in the plan.
  * Tried: Confirmed ordering and identity expectations with the user.
  * Result: Sort peer sessions by recency (`lastUpdated`) and require clear session-level identity/disambiguation from metadata such as `sessionId`, title/sessionName, state, and timestamps.
* [x] Q: Should the new OpenCode phase include shared server/CLI/UI paths or only the backend payload?
  * Uncertainty: A narrow backend-only phase would be cheaper, but would not satisfy the user-facing problem statement.
  * Tried: Confirmed acceptance-target expectations with the user.
  * Result: The OpenCode phase must cover backend payloads plus CLI/server/UI visibility, and must explicitly avoid regressing existing subagent behavior.
* [x] Q: How should the lower-priority Claude work be represented in the plan?
  * Uncertainty: Claude appears to need deeper architecture work because its status tracking is repo-scoped today.
  * Tried: Investigated the current Claude path and asked the user whether to defer it, keep it exploratory, or plan a second phase.
  * Result: Add a second planned phase for Claude after OpenCode, with explicit acknowledgment that Claude likely needs a session-scoped status redesign.
* [x] Q: Should this work stay in the current project doc tree or start a new project?
  * Uncertainty: The new same-repo concurrency work could have justified a separate project, but it also extends the same OpenCode/Claude monitoring workstream.
  * Tried: Asked the user how to structure the docs.
  * Result: Keep the work in this project and add two new phases: Phase 04 for OpenCode first, then Phase 05 for Claude.
* [x] Q: What plan gaps did a staff-level validation identify before implementation?
  * Uncertainty: The drafted phases were directionally correct, but might still have had hidden ambiguity around keys, filters, or Claude sequencing.
  * Tried: Asked a staff-dev to validate the new same-repo concurrent-session plan against the current architecture.
  * Result: The plan direction is sound, but docs needed explicit decisions for frontend session-scoped keying, visible sibling-session disambiguation, `dump --project` returning all matching siblings, watch/reconciliation coverage, and a formal approval gate before Claude implementation.
* [x] Q: What follow-up issues did correctness review find after the first OpenCode concurrent-sessions implementation pass?
  * Uncertainty: The first implementation pass satisfied the main Phase 04 shape, but subtle watch-mode and incremental-render behavior still needed validation.
  * Tried: Asked a correctness reviewer to inspect the implemented Phase 04 changes against the requirements.
  * Result: Review found two issues — filtered watch output suppressed empty snapshots, and incremental rendering could temporarily violate recency ordering. Both were fixed in a second implementation pass and re-reviewed cleanly.
* [x] Q: Did any deeper architecture review still find a same-repo peer-state bug after the first Phase 04 implementation?
  * Uncertainty: The main Phase 04 feature worked end-to-end, but there was still a risk that older same-directory fallback heuristics could conflict with the new peer-session model.
  * Tried: Asked a staff-dev for a quick post-implementation architectural review, then followed up with a focused fix and correctness re-review.
  * Result: Yes — same-directory top-level peers could still keep each other `running` through fallback child activity. The follow-up removed that peer-state bleed, preserved linked-child behavior, and re-established session-scoped running/stopped state for visible sibling sessions.
* [x] Q: Should the Claude same-repo concurrent-session phase still be pursued now that OpenCode is done?
  * Uncertainty: Claude research showed a viable direction, but the work is larger because Claude needs session-scoped status ownership rather than just wider discovery.
  * Tried: Checked with the user after the OpenCode phase was validated live.
  * Result: No for now — explicitly defer/drop the Claude follow-up from active scope because the user does not use multi-session Claude often enough.
* [x] Q: Which REVIEW comments should be prioritized now that the OpenCode implementation is done?
  * Uncertainty: Review agents left a mix of active OpenCode follow-ups, deferred Claude architecture items, stale doc markers, and test-only cleanup comments.
  * Tried: Researched each REVIEW comment, grouped duplicates, checked them against the existing requirements, and ranked them by impact/effort/dependency.
  * Result: Prioritize the active `dump --watch` NDJSON contract fix first, then the shared sticky-name mutation fix in server/CLI, then the Phase 03/R3 status-marker cleanup, then low-priority test readability cleanup. Keep the Claude review comments grouped as deferred Phase 05 work only.

## Phases 

### ✅ 01 Phase: OpenCode subagent state fix
[01-opencode-subagent-state-fix](01-opencode-subagent-state-fix.md)
Make OpenCode state resolution aware of active sub-agent work so a parent session is not classified as stopped while child work continues.

### ✅ 02 Phase: OpenCode permission state fix
[02-opencode-permission-state-fix](02-opencode-permission-state-fix.md)
Normalize OpenCode permission-question handling so ccmon shows the session as waiting for permission while approval is pending.

### 🔄 03 Phase: OpenCode subagent display name fix
[03-opencode-subagent-display-name-fix](03-opencode-subagent-display-name-fix.md)
Replace the raw OpenCode child session id shown for sub-agents with the child session's human-readable title, using the existing backend/state pipeline and preserving safe fallback behavior.

### ✅ 04 Phase: OpenCode concurrent sessions
[04-opencode-concurrent-sessions](04-opencode-concurrent-sessions.md)
Show all concurrent top-level OpenCode sessions inside the same repo/directory as separate peer session entries, instead of collapsing visibility to whichever session had the latest activity. This phase also carries the shared aggregation, CLI/server, and UI changes needed to make same-repo peer sessions distinct and stable without regressing existing subagent behavior.

### ⬜ 05 Phase: Claude concurrent sessions
[05-claude-concurrent-sessions](05-claude-concurrent-sessions.md)
Deferred follow-up only. Notes are retained in case priorities change later, but this is no longer part of the active workstream because the required Claude architecture changes are not worth pursuing right now.

## Files

- **proj**: Symlink to the active project documentation folder for this workstream.
- **src/backends/opencode.ts**: OpenCode session discovery, state resolution, and subagent handling. Changes: child activity, fast reply, and `question.*` normalization fixes; now also emits all visible same-directory top-level sessions, preserves per-session `lastUpdated`, and no longer lets top-level same-directory peers keep each other `running`.
- **src/backends/build-project-state.ts**: Gates subagent inclusion based on the parent state.
- **src/types.ts**: Shared project and subagent data model. Context: already includes `sessionName` in the shared enrichment shape used by subagents.
- **resources/opencode-plugin/ccmon.ts**: Emits OpenCode status events that feed state classification. Changes: aligned permission event hooks to current OpenCode generic permission events and added `question.*` handling for main-agent prompts.
- **~/.config/opencode/plugins/ccmon.ts**: Installed plugin copy used by live OpenCode sessions. Pending manual sync so the live environment picks up the new `question.*` mapping.
- **~/.local/share/opencode/log/**: Runtime evidence used to confirm the main-agent question repro emits `question.*` events.
- **~/.local/state/ccmon/opencode-status.jsonl**: Live status log used to prove no waiting event was written for the failing question prompt.
- **opencode.db / session table**: Runtime evidence used to confirm the quiet 120s sleep child session stopped updating `time_updated` while still alive.
- **src/session-core.ts**: Shared state-resolution logic and permission-state reference behavior.
- **src/timing.ts**: State freshness thresholds used by OpenCode backend heuristics.
- **public/js/render.js**: Dashboard renderer. Changes: subagent label precedence uses `sessionName`, same-repo OpenCode sibling cards show visible session-level differentiation, and incremental updates preserve recency ordering immediately.
- **tests/backends/opencode.test.ts**: OpenCode backend regression coverage. Changes: child-activity, permission-state, and `question.*` regressions covered; now also covers same-directory top-level sibling discovery/state and subagent boundaries.
- **tests/render.test.ts**: Renderer regression coverage. Changes: subagent label precedence verifies `description -> sessionName -> slug -> agentId`; now also covers same-repo sibling rendering and incremental recency ordering.
- **tests/session-core.test.ts**: Permission/state-resolution reference coverage.
- **src/backends/collect-states.ts**: Shared backend aggregation. Planned Phase 04 changes: allow multiple visible same-repo session entries without collapsing or key collisions.
- **src/server.ts**: HTTP/WebSocket payload assembly. Changes: same-repo sibling sessions are now carried through API broadcasts in recency order.
- **src/cli.ts / src/cli/commands/dump.ts**: CLI output path. Changes: `dump --project` now returns all matching sibling sessions, watch-mode filtered output emits explicit empty arrays for reconciliation, and output stays recency-sorted.
- **public/js/utils.js**: Dashboard keying/helpers. Changes: OpenCode frontend identity is now session-scoped via `sessionId` instead of cwd.
- **src/project-utils.ts**: Claude project/session scanning. Planned Phase 05 changes: stop collapsing one project dir to only the latest transcript.
- **src/backends/claude.ts**: Claude backend discovery/state/subagent handling. Planned Phase 05 changes: session-scoped sibling visibility and state resolution.
- **src/status-writer.ts**: Claude hook status file writing. Planned Phase 05 changes: avoid one session's end/status lifecycle erasing sibling-session visibility.
- **src/cli/commands/status.ts**: Claude hook-event routing. Planned Phase 05 changes: move away from repo-only status targeting toward session-scoped tracking.
- **tests/backends/claude.test.ts**: Planned Phase 05 regression coverage for same-project concurrent Claude sessions.
- **tests/project-utils.test.ts**: Planned Phase 05 regression coverage for multi-transcript scanning/discovery.
- **tests/server.test.ts**: Regression coverage for multi-session payload aggregation and recency ordering.
- **tests/cli.test.ts**: Regression coverage for `dump`, `dump --watch`, filtering, and reconciliation behavior with same-repo sibling sessions.
