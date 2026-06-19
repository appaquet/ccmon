# OpenCode subagent display name fix

## Context

[Project doc](../00-opencode-sub-agents-fixes.md)

This phase covers a narrow UX follow-up: OpenCode sub-agents are still rendered in the dashboard as `Sub: ses_XYZ`, which exposes an opaque child session id instead of the sub-agent's human-readable title. The goal here is to propagate the OpenCode child session title through the backend state pipeline and have the UI prefer that title while keeping existing fallback behavior safe.

## Requirements

* R3.A: ⬜ Identify the canonical OpenCode data source for a sub-agent display name and confirm it refers to the child sub-agent session, not the main session.
* R3.B: ⬜ Ensure OpenCode subagents emitted by ccmon include the child session title in the shared subagent payload without trimming or backend-specific display formatting.
* R3.C: ⬜ Ensure the UI prefers the OpenCode sub-agent title over the raw `ses_*` id, while preserving existing fallback behavior for backends or sessions that do not provide a name.

## Design

Use the existing shared subagent shape instead of inventing a new OpenCode-only display field.

```text
OpenCode SQLite session row (child)
        |
        | read child `title`
        v
OpencodeBackend.getSubagents()
        |
        | map to `subagents[*].sessionName`
        v
buildProjectState / server serialization
        |
        | unchanged pass-through
        v
public/js/render.js
        |
        | prefer: description -> sessionName -> slug -> agentId
        v
UI label: Sub: <human-readable name>
```

Backend is responsible for exposing raw semantic data. Frontend remains responsible for presentation concerns such as truncation/ellipsis if the title is long.

## Questions & Investigations

* [x] Q: Where does the current `Sub: ses_XYZ` label come from?
  * Uncertainty: The opaque label could have been generated in the backend or in the browser renderer.
  * Tried: Traced the project-state pipeline from OpenCode backend output through the dashboard renderer.
  * Result: The current label is chosen in `public/js/render.js`, which prefers `description || slug || agentId`; OpenCode subagents currently provide neither `description` nor `slug`, so they fall back to `agentId`.
* [x] Q: Does OpenCode already store a human-readable sub-agent name?
  * Uncertainty: A display name might have required plugin changes or new persistence.
  * Tried: Reviewed test schema and real OpenCode session rows.
  * Result: Yes — the child OpenCode session row already has a `title`, and real child sessions use meaningful titles such as `Investigate subagent naming (@senior-dev subagent)`.
* [x] Q: Is there already a shared field that can carry this name through the backend pipeline?
  * Uncertainty: Adding a new field would broaden the scope and risk inconsistent naming abstractions across backends.
  * Tried: Reviewed `SubagentInfo` and related shared types.
  * Result: Yes — shared session enrichment already includes `sessionName?: string`, so OpenCode can reuse that abstraction instead of adding a new field.
* [x] Q: Should the backend clean up or shorten the child title before exposing it?
  * Uncertainty: Real OpenCode titles may include suffixes like `(@senior-dev subagent)` and may be longer than the current compact id.
  * Tried: Confirmed the preferred responsibility split with the user.
  * Result: No — backend should expose the full raw child title, and any ellipsis/truncation should stay in the frontend layer.
* [x] Q: Should this phase broaden into a general cross-backend naming pass?
  * Uncertainty: The renderer fallback order is shared, and Claude already uses different name fields.
  * Tried: Confirmed scope with the user.
  * Result: Keep implementation targeted to OpenCode, but make the shared label preference robust enough that other backends continue to work unchanged.
* [x] Q: Do we need a separate frontend manual-only verification path for label precedence?
  * Uncertainty: The renderer previously had no explicit coverage for subagent label precedence.
  * Tried: Checked whether a narrow renderer test seam could be added without widening scope into the whole dashboard.
  * Result: Yes — a targeted renderer regression test was added, so precedence is covered automatically rather than relying only on manual browser checks.
* [x] Q: Does frontend formatting verification require fixing all Biome findings in `public/js/render.js`?
  * Uncertainty: A direct Biome check on the renderer surfaced extra diagnostics that were not part of the repo's standard lint target.
  * Tried: Compared the targeted check against the repository's actual lint command used by the implementation sub-agent.
  * Result: No for this phase — `npm run lint` passed under the repo's existing verification contract, so implementation stayed scoped to the requested naming fix instead of broad cleanup.

## Tasks

- [x] Confirm and document the OpenCode child-session title mapping used as the canonical sub-agent name source (staff-dev) (R3.A)
  - AC: documents that the chosen source is the child OpenCode session `title`, not the main session title or plugin log metadata.
  - AC: records fallback expectations when the child title is missing or empty.
- [x] Propagate OpenCode child `title` into the shared subagent payload as `sessionName` (senior-dev) (R3.A, R3.B)
  - AC: OpenCode subagents returned by the backend include `sessionName` when the child SQLite row has a title.
  - AC: the backend does not trim, rewrite, or decorate the title.
  - AC: existing OpenCode lifecycle/state behavior is unchanged.
- [x] Add backend regression coverage for named OpenCode subagents (senior-dev or junior-dev) (R3.A, R3.B)
  - AC: tests fail before the mapping change and pass after it.
  - AC: tests verify the exact child title string is preserved in `subagents[*].sessionName`.
  - AC: tests verify missing titles still leave a safe fallback path.
- [x] Update dashboard subagent label selection to prefer `sessionName` before raw `agentId` (senior-dev) (R3.C)
  - AC: OpenCode subagents with a `sessionName` render with that name instead of `ses_*`.
  - AC: existing Claude subagent behavior still prefers `description` when available.
  - AC: `agentId` remains the final fallback when no higher-quality label exists.
- [x] Add renderer regression coverage or a documented manual UI smoke-test path for subagent label precedence (senior-dev or junior-dev, depending on existing test harness fit) (R3.C)
  - AC: there is explicit verification for the precedence order `description -> sessionName -> slug -> agentId`.
  - AC: verification covers at least one OpenCode-style named child and one unnamed fallback case.
- [x] Run targeted verification for payload and dashboard output (senior-dev) (R3.B, R3.C)
  - AC: a project-state payload path (`dump`, server payload, or equivalent targeted check) shows `subagents[*].sessionName` for an OpenCode child.
  - AC: the dashboard shows `Sub: <child title>` instead of `Sub: ses_*` for the same case.
  - AC: lint/typecheck/tests used by the implementation phase are identified in advance and executed before completion.
- [ ] Reconcile Phase 03 requirement/phase status markers with the completed implementation record (Priority: Medium, Effort: Quick Win, junior-dev or main agent) (R3.A, R3.B, R3.C)
  - AC: project requirement `R3`, Phase 03 status, and phase requirement markers all reflect the same completion state.
  - AC: if any validation is still intentionally outstanding, it is represented as an unchecked task with explicit ACs rather than stale status markers.

Implementation verification recorded by sub-agent:

- `npx vitest run tests/backends/opencode.test.ts tests/render.test.ts` ✅ (`82` tests passed)
- `npm run typecheck` ✅
- `npm run lint` ✅
- `npx biome check src/ tests/ public/js/render.js` ⚠️ extra renderer diagnostics outside the current repo lint target; not expanded into separate cleanup in this phase

## Files

- **src/backends/opencode.ts**: OpenCode subagent query and mapping. Planned change: select child `title` and map it to shared `sessionName` for subagents.
- **src/types.ts**: Shared project/subagent payload types. Context: already contains `sessionName` via shared enrichment, which this phase should reuse rather than extending with an OpenCode-specific field.
- **src/backends/build-project-state.ts**: Shared project-state assembly. Context: expected to pass the enriched subagent payload through unchanged.
- **public/js/render.js**: Dashboard subagent label rendering. Planned change: prefer `sessionName` before raw `agentId` while preserving existing higher-priority labels.
- **tests/backends/opencode.test.ts**: Backend regression coverage. Planned change: add title propagation assertions for OpenCode child sessions.
- **tests/render.test.ts**: Renderer regression coverage. Changes: added explicit subagent label precedence coverage for `description -> sessionName -> slug -> agentId`.
