# OpenCode concurrent sessions

## Context

[Project doc](../00-opencode-sub-agents-fixes.md)

This phase adds first-class support for multiple concurrent top-level OpenCode sessions inside the same repo/directory. Today ccmon shows whichever same-directory session had the latest activity, which hides legitimate sibling sessions and makes concurrent OpenCode work hard to monitor. The goal here is to surface all concurrent top-level OpenCode sessions as separate peer entries while keeping `parent_id` children as subagents, preserving current stale filtering, and carrying the new multiplicity all the way through backend payloads, CLI/server output, and the dashboard UI.

## Requirements

* R4.A: ✅ Stop collapsing same-directory top-level OpenCode sessions to only the latest active session.
* R4.B: ✅ Surface concurrent top-level OpenCode sessions as separate peer entries with stable session-level identity.
* R4.C: ✅ Preserve the distinction between peer sessions and child subagents: `parent_id` children remain subagents under their parent.
* R4.D: ✅ Preserve correct per-session state, `lastUpdated`, stale filtering, and deterministic recency ordering when siblings share a repo/directory.
* R4.E: ✅ Carry concurrent same-repo OpenCode sessions through shared aggregation, CLI/server payloads, and UI rendering without key collisions, including frontend identity that is session-scoped rather than cwd-scoped.
* R4.F: ✅ Make same-repo sibling sessions visibly distinguishable in the UI/CLI by using session-level metadata such as session title/name with safe fallback to short session id and normal state/timestamp context.
* R4.G: ✅ Avoid regressions in existing OpenCode subagent behavior, `--project` filtering behavior, and safe fallback behavior for sparse session metadata.

## Design

Treat OpenCode visibility as session-level cardinality, not repo-level singleton selection.

```text
OpenCode SQLite session table
        |
        | select all visible top-level sessions for a directory
        | instead of GROUP BY directory -> MAX(time_updated)
        v
OpencodeBackend.scanProjects()
        |
        | one discovered main-session record per top-level session
        v
buildProjectState / collectBackendStates
        |
        | preserve multiple same-repo peer entries
        | keep parent_id children attached as subagents only
        v
server / dump payloads
        |
        | stable session identity + repo context
        v
public/js/render.js
        |
        | render same-repo peer sessions separately
        | sort by recency, avoid cwd-only key collisions
        v
UI: multiple visible OpenCode sessions for one repo
```

The repo path remains shared context, but no longer implies a single visible main session. Session identity must be explicit and stable enough that CLI/server/UI can distinguish siblings cleanly. Recency ordering should still bring the freshest session to the top, but the older concurrent sibling sessions must remain visible until normal stale filtering removes them.

## Questions & Investigations

* [x] Q: What is the current OpenCode collapse point?
  * Uncertainty: The latest-only behavior could have been introduced by backend discovery, shared aggregation, or only the UI.
  * Tried: Investigated the OpenCode backend architecture and shared project-state pipeline.
  * Result: The main collapse point is backend discovery: OpenCode groups by directory and selects only the newest top-level session, while shared types and rendering also assume one main session per repo.
* [x] Q: What UX shape should this phase target?
  * Uncertainty: Same-repo concurrency could have been modeled as one repo card with nested peer sessions or as multiple peer entries.
  * Tried: Asked the user to choose after architecture research.
  * Result: Use multiple peer session entries for the same repo, not a single nested repo card.
* [x] Q: How should peer sessions be separated from subagents?
  * Uncertainty: Same-directory child sessions could accidentally be surfaced as peers.
  * Tried: Reviewed the OpenCode schema assumptions and confirmed the desired rule with the user.
  * Result: Top-level same-directory sessions are peers; `parent_id` children remain subagents under their parent session.
* [x] Q: How long should sibling sessions stay visible?
  * Uncertainty: The feature needed to be useful without retaining every historical sibling forever.
  * Tried: Asked the user whether to preserve current stale filtering, extend retention, or show only active sessions.
  * Result: Keep the current stale filtering/freshness model.
* [x] Q: How should same-repo peer sessions be ordered and identified?
  * Uncertainty: Repo name/path is shared, so additional session identity was required.
  * Tried: Asked the user to choose the preferred ordering and identity level.
  * Result: Sort by recency (`lastUpdated`) and require explicit session-level identity/disambiguation via metadata such as `sessionId`, title/sessionName, state, and timestamps.
* [x] Q: Should this phase stop at the backend payload?
  * Uncertainty: A backend-only change would be smaller, but might not solve the real monitoring problem.
  * Tried: Confirmed the desired acceptance target with the user.
  * Result: No — this phase must cover backend payloads plus CLI/server/UI visibility, and must explicitly avoid regressing subagent behavior.
* [x] Q: What exact identity should same-repo sibling sessions use in the frontend?
  * Uncertainty: The backend already has session identity, but the current dashboard keying path is cwd-based for OpenCode.
  * Tried: Had a staff-dev review validate the plan against the current architecture, then confirmed the recommendation with the user.
  * Result: Frontend identity must also be explicitly session-scoped, using backend/source plus session identity rather than cwd alone.
* [x] Q: Is sorting enough to distinguish same-repo sibling sessions?
  * Uncertainty: Multiple visible sessions can share the same repo path, which makes ordering alone ambiguous to users.
  * Tried: Had the staff review call out the gap, then confirmed the recommended requirement with the user.
  * Result: No — peer session entries must include a visible differentiator, preferably session title/name when available, with safe fallback to short session id plus normal state/timestamp context.
* [x] Q: How should `dump --project` behave when one repo has multiple visible sessions?
  * Uncertainty: The current behavior effectively picks the first match, which would become surprising once sibling sessions are surfaced.
  * Tried: Had the staff review identify the ambiguity, then asked the user to choose the intended behavior.
  * Result: `--project <name>` should return all matching visible sessions for that repo/workspace name, not silently pick only the first sibling session.
* [x] Q: Should same-directory sibling sessions share `lastUpdated` activity when one session is fresher?
  * Uncertainty: Previous OpenCode heuristics reused same-directory activity in some paths, which risked collapsing sibling ordering even after discovery emitted all top-level sessions.
  * Tried: Implemented the multi-session scan path and checked whether recency/state stayed correct per visible session.
  * Result: No — `lastUpdated` must remain session-scoped for peer sessions so recency ordering and visibility reflect each sibling session's own activity rather than a neighbor's activity.
* [x] Q: How should `dump --watch --project` signal that the last matching sibling session disappeared?
  * Uncertainty: Suppressing empty filtered snapshots would leave stream consumers unable to reconcile removals.
  * Tried: A correctness review flagged the gap after the first implementation pass.
  * Result: Watch-mode filtered output now emits an explicit empty array (`[]`) when the filtered set becomes empty, so consumers can remove previously visible sibling sessions.
* [x] Q: Is periodic full re-sorting enough for same-repo sibling ordering in the dashboard?
  * Uncertainty: The incremental renderer path could have shown newly seen but older sibling sessions ahead of newer existing ones until the next full resort.
  * Tried: A correctness review flagged the ordering gap after the first implementation pass.
  * Result: No — incremental updates also need immediate recency-preserving merge logic so sibling ordering stays correct between periodic full resorts.
* [x] Q: Can same-directory top-level peer sessions still keep each other `running` through the older fallback child-activity heuristic?
  * Uncertainty: Phase 04 changed same-directory `parent_id IS NULL` rows from hidden fallback candidates into visible peer sessions, so the older fallback behavior might still bleed state across siblings.
  * Tried: Requested a staff-level post-implementation review, then implemented a focused backend follow-up and regression tests.
  * Result: No — same-directory top-level peers no longer contribute fallback child activity to each other. `running` / `stopped` now stays session-scoped unless the session itself is fresh or it has a true linked child.

## Tasks

- [x] Confirm and document the exact OpenCode same-directory collapse points and sibling/subagent boundaries in code before implementation starts (senior-dev) (R4.A, R4.C)
  - AC: names the exact backend discovery/query logic that currently selects only one top-level session per directory.
  - AC: documents the rule for distinguishing top-level peer sessions from `parent_id` child subagents.
  - AC: records how same-directory unlinked heuristics are allowed to affect state/freshness without hiding real sibling sessions.
- [x] Design the session-identity and shared aggregation changes needed for same-repo OpenCode siblings (senior-dev) (R4.B, R4.D, R4.E, R4.F)
  - AC: defines the stable identity to use for concurrent OpenCode sessions across backend, CLI/server, and UI paths.
  - AC: explicitly requires frontend identity/keying to use backend/source plus session identity rather than cwd alone.
  - AC: documents deterministic recency ordering and tie-breaking expectations.
  - AC: documents the visible sibling-session differentiator to use when repo path is shared.
  - AC: explicitly preserves existing child-subagent semantics.
- [x] Implement OpenCode backend discovery/state changes so all visible top-level same-directory sessions are emitted independently (senior-dev) (R4.A, R4.B, R4.D)
  - AC: OpenCode no longer drops a top-level sibling session solely because another same-directory session is newer.
  - AC: each sibling keeps correct per-session state and `lastUpdated`.
  - AC: same-directory fallback heuristics do not merge, suppress, or misclassify real top-level siblings.
- [x] Update shared aggregation, CLI/server payloads, and UI keying/rendering so same-repo OpenCode siblings remain distinct end-to-end (senior-dev) (R4.B, R4.D, R4.E, R4.F, R4.G)
  - AC: server/CLI/UI can hold multiple OpenCode entries for the same repo/directory without collisions.
  - AC: the dashboard renders same-repo siblings as separate peer entries sorted by recency.
  - AC: repo context remains visible while session-level identity is clear enough to distinguish siblings.
  - AC: `dump --project <name>` returns all visible matching sibling sessions for the selected repo/workspace name.
  - AC: watch/update flows reconcile disappeared sibling sessions cleanly instead of leaving stale peer entries stuck in output.
- [x] Add regression coverage for OpenCode same-repo concurrency and subagent non-regression (junior-dev) (R4.C, R4.G)
  - AC: tests cover at least two top-level OpenCode sessions in the same directory.
  - AC: tests cover sibling sessions in different states and a deterministic tie case for equal recency.
  - AC: tests verify `parent_id` child sessions still render as subagents rather than peer sessions.
  - AC: tests cover same-repo sibling rendering/keying/disambiguation and `dump --project` multi-match behavior.
  - AC: tests cover watch/reconciliation behavior when a previously visible sibling session disappears from a later scan.
- [x] Run targeted and full verification for the OpenCode phase (junior-dev) (R4.D, R4.E, R4.F, R4.G)
  - AC: targeted backend/server/render/CLI tests are identified before coding and executed before completion.
  - AC: `npm run dump --no-filter` or an equivalent payload check proves multiple OpenCode sibling sessions are surfaced together.
  - AC: `npm run typecheck`, `npm run lint`, and the full repo test suite pass before the phase can be proposed complete.

Implementation verification recorded by sub-agent:

- `npx vitest run tests/backends/opencode.test.ts tests/render.test.ts tests/server.test.ts tests/cli.test.ts` ✅ (`160` tests passed)
- `npx vitest run tests/cli.test.ts tests/render.test.ts` ✅ (`64` tests passed)
- `npm run typecheck` ✅
- `npm run lint:fix && npm run lint` ✅
- `npm test` ✅ (`400` tests passed)

Correctness review follow-up recorded after the first implementation pass:

- `dump --watch --project` now emits `[]` when the filtered sibling set becomes empty, so consumers can reconcile removals.
- Incremental dashboard updates now preserve recency ordering immediately for newly seen same-repo sibling sessions rather than waiting for the periodic full resort.
- A later staff review found one more backend issue: same-directory top-level peers could still keep each other `running` through the older fallback child-activity heuristic. A focused follow-up removed that peer-state bleed and added backend regressions proving top-level siblings stay independent while linked-child behavior remains intact.

Additional follow-up verification recorded by sub-agent:

- `npx vitest run tests/backends/opencode.test.ts` ✅ (`81` tests passed after updating one stale legacy expectation)
- `npm run typecheck` ✅

Prioritized review follow-up tasks:

- [ ] Fix the `dump --watch` NDJSON contract regression found in review comments (Priority: High, Effort: Moderate, senior-dev) (R4.E, R4.G)
  - AC: `dump --watch` emits one compact JSON object/array per line instead of pretty multi-line snapshots.
  - AC: empty-array reconciliation snapshots still emit as a single NDJSON line.
  - AC: CLI watch tests assert line-delimited output directly instead of compensating for pretty-printed block output.
- [ ] Stop mutating canonical `ProjectState.projectName` during disambiguation in server/CLI output paths (Priority: Medium, Effort: Moderate, senior-dev) (R4.B, R4.E, R4.F)
  - AC: server and CLI output disambiguation operates on cloned/output-only data or a separate display field.
  - AC: when name collisions disappear on later rescans, surviving sessions revert to their canonical non-expanded names.
  - AC: regression coverage exists for both server and CLI/watch paths.
- [ ] Clean up OpenCode Phase 04/adjacent test readability issues raised by review comments (Priority: Low, Effort: Quick Win, junior-dev) (R4.G)
  - AC: stale test names in `tests/backends/opencode.test.ts` describe the current same-directory peer-session behavior.
  - AC: brittle/magic fixture conventions in `tests/server.test.ts` and `tests/cli.test.ts` are made explicit enough that ordering/data-shape intent is clear.
  - AC: any test-only cleanup stays behavior-neutral and leaves existing coverage intact.

## Files

- **src/backends/opencode.ts**: OpenCode session discovery, state resolution, and sibling/subagent classification. Changes: emits all visible top-level same-directory sessions, preserves per-session `lastUpdated`, and keeps `parent_id` children as subagents.
- **src/backends/opencode.ts**: OpenCode session discovery, state resolution, and sibling/subagent classification. Changes: emits all visible top-level same-directory sessions, preserves per-session `lastUpdated`, keeps `parent_id` children as subagents, and no longer lets top-level same-directory peers revive each other through fallback child activity.
- **src/types.ts**: Shared project/session payload types. Context: existing session identity fields were sufficient for the OpenCode sibling implementation.
- **src/backends/build-project-state.ts**: Shared per-session state assembly. Context: continues to support same-repo peer entries without needing a code change in this phase.
- **src/backends/collect-states.ts**: Shared backend aggregation. Context: existing backend-map replacement remained compatible with the OpenCode sibling implementation.
- **src/server.ts**: HTTP/WebSocket payload assembly. Changes: payload ordering now uses shared recency sorting so same-repo sibling sessions remain predictably ordered.
- **src/cli.ts / src/cli/commands/dump.ts**: CLI output path. Changes: `--project` now returns all matching visible sibling sessions; watch mode emits explicit empty filtered snapshots for reconciliation; output ordering is recency-sorted.
- **src/project-utils.ts**: Shared project ordering helpers. Changes: added shared recency sorting used by CLI/server paths.
- **public/js/render.js**: Dashboard renderer. Changes: same-repo sibling cards now show visible session-level differentiation and preserve recency ordering during incremental updates.
- **public/js/utils.js**: Dashboard keying/helpers. Changes: OpenCode frontend identity is now session-scoped via `sessionId` instead of cwd.
- **tests/backends/opencode.test.ts**: Regression coverage for same-directory sibling discovery, state independence, peer/non-peer boundaries, and linked-child non-regression.
- **tests/server.test.ts**: Regression coverage for multi-session ordering in API/WebSocket payloads.
- **tests/render.test.ts**: Regression coverage for same-repo sibling rendering, visible differentiation, and incremental recency ordering.
- **tests/cli.test.ts**: Regression coverage for `dump`, `dump --watch`, filtering, and reconciliation behavior with multiple same-repo OpenCode sessions.
