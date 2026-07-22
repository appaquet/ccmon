# Phase 02: Sub-agent Question Blocking

## Context

An OpenCode sub-agent can ask a question or request permission while the top-level session continues to appear Running. The plugin records the child event, but the backend currently uses child evidence only to promote a stale parent to Running; it does not promote the parent to the existing `waiting_for_permission` state. The child-to-parent relationship is available in OpenCode’s SQLite `session.parent_id` graph.

This phase plans backend/plugin evidence changes only. It does not add a new public state, a new ProjectState field, a sub-agent waiting indicator, or frontend changes.

## Requirements

* R6.1: 🔄 Promote the active top-level OpenCode session to `waiting_for_permission` when any reachable descendant has a fresh unresolved question or permission.
* R6.2: 🔄 Determine ancestry solely from the SQLite `session.parent_id` graph and include arbitrary descendant depth.
* R6.3: 🔄 Exclude missing-parent or disconnected sessions from unrelated roots.
* R6.4: 🔄 Terminate safely on cyclic/corrupt graph data without including a root as its own descendant.
* R6.5: 🔄 Correlate blockers by `(session_id, blocker_kind, request_id)`.
* R6.6: 🔄 Keep multiple blockers and nested branches independent.
* R6.7: 🔄 Clear only matching blockers on replies/rejections; terminal evidence clears only the affected session’s blockers.
* R6.8: 🔄 Ensure generic Running activity and future heartbeat events never resolve an explicit blocker.
* R6.9: 🔄 Reuse the existing five-minute permission freshness window, including a tested exact-boundary policy.
* R6.10: 🔄 Support legacy ID-less records with a documented conservative session-level compatibility slot.
* R6.11: 🔄 Preserve root `closed` precedence absolutely and current-generation root `error` precedence over descendant evidence; only valid newer root-local reactivation can clear Error (see Phase 04).
* R6.12: 🔄 Discover descendants once per backend collection without one SQL query per descendant.
* R6.13: 🔄 Include fresh recursive descendant blocker activity in root `lastUpdated` so stale filtering does not hide the blocked root.
* R6.14: 🔄 Keep the public state model, frontend fields, and sub-agent UI unchanged.

## Design

### Recursive descendant snapshot

```text
SQLite session.parent_id
          │
          ▼
  recursive forest CTE
          │
          ▼
 descendantsByRoot[rootId]
          │
          ├── indexed status events per descendant
          ├── request-aware blocker ledgers
          └── aggregate state + lastUpdated
```

Use one recursive forest query per OpenCode collection. Seed visible top-level sessions, traverse through archived or terminal intermediates, exclude the root itself, and use `UNION` without a depth column so corrupt cycles terminate. Orphans and disconnected cycles are not reattached heuristically.

### Blocker ledger

For each descendant, reconstruct outstanding blockers using:

```text
(session_id, blocker_kind, request_id)
```

`blocker_kind` distinguishes questions from permissions. Ask records add entries; matching replies/rejections remove only their request; terminal events clear only that session’s entries. Records older than `PERMISSION_STALE_MS` are ignored. Legacy records without request IDs use one conservative session-level slot.

The plugin must preserve request IDs and force-write ask/reply/rejection lifecycle records despite ordinary same-state deduplication. No parent ID is added to plugin records; ancestry remains a backend concern.

### Root state precedence

```text
root closed ─────────────────────► closed
current-generation root error ───► error
root own fresh blocker ─────────► waiting_for_permission
any descendant fresh blocker ───► waiting_for_permission
root running ───────────────────► running
live descendant activity ───────► running
otherwise ──────────────────────► existing stopped/fallback rules
```

Any descendant blocker wins over Running siblings. Resolving one blocker does not clear another. Recursive blocker activity updates root `lastUpdated`; recursive activity does not otherwise expand Running promotion beyond existing behavior.

## Questions & Investigations

* [x] Q: Which events represent a child asking for human input?
  * Handle both `question.asked` and `permission.asked`; the current plugin normalizes both to waiting evidence.
* [x] Q: How should the parent be represented?
  * Reuse `waiting_for_permission`; show only the parent badge and do not add a new child UI indicator.
* [x] Q: How many descendant levels count?
  * All descendants reachable through `session.parent_id`, including nested sub-agents.
* [x] Q: What clears a child blocker?
  * Its matching reply/rejection, terminal evidence for that child, or the existing five-minute freshness timeout. Generic Running activity does not clear it.
* [x] Q: What happens with multiple blocked descendants?
  * Any fresh blocker keeps the root Waiting until every blocker is resolved, terminal, or stale.
* [x] Q: What happens if the root is closed or errored while a descendant is blocked?
  * Root `closed` remains permanently authoritative. Root `error` remains authoritative for its generation and cannot be cleared by descendant evidence; Phase 04 defines the strictly newer root-local evidence that starts a new generation.
* [x] Q: Why is request identity required?
  * Session-level state deduplication cannot represent two simultaneous requests; resolving one must not clear the other.
* [x] Q: What engineering review found no remaining product blocker?
  * Principal review confirmed recursive CTE discovery, request-aware ledgers, graph safety, and direct backend aggregation are feasible with existing SQLite/Vitest seams.
* [x] Q: How should historical error evidence interact with later valid activity?
  * Error barriers are generation-scoped. Later valid `chat.message`, raw `UserPromptSubmit`, or `session.created` starts a new generation; same-generation late tool/question evidence remains suppressed.

## Tasks

- [x] Verify the OpenCode blocker event contract and request IDs (junior-dev)
  - AC: `question.asked`, `question.replied`, `question.rejected`, `permission.asked`, and `permission.replied` mappings are captured from current runtime/source evidence.
  - AC: Permission rejection semantics and request-ID fields are documented.
  - AC: Direct-vs-recursive ancestry assumptions are documented before implementation.
- [x] Build and cache the recursive descendant forest (senior-dev)
  - AC: One recursive query groups arbitrary-depth descendants under each visible root.
  - AC: `resolveState()` and `computeLastUpdated()` reuse the per-collection snapshot.
  - AC: No per-descendant SQL query is needed.
  - AC: Archived intermediates remain traversable; orphans, disconnected cycles, and root re-entry are excluded safely.
- [x] Index status events once per log refresh (senior-dev; depends on recursive snapshot)
  - AC: Events are grouped by session ID with numeric timestamp and physical-line tie-breaking.
  - AC: Descendant evaluation does not repeatedly scan the full status log.
  - AC: Invalid timestamps cannot create persistent blockers.
- [x] Preserve request-aware blocker lifecycle records (senior-dev; depends on event contract)
  - AC: Ask/reply/rejection records carry session, kind, and request identity.
  - AC: Lifecycle records bypass ordinary same-state deduplication.
  - AC: Legacy ID-less records use the documented compatibility slot.
  - AC: No parent/root ID is inferred or emitted by the plugin.
- [x] Aggregate blockers and apply root precedence (senior-dev; depends on forest and ledger)
  - AC: A fresh blocker at any descendant depth promotes the root to `waiting_for_permission`.
  - AC: A blocker overrides Running ancestors and siblings.
  - AC: Root `closed`/`error` remains authoritative.
  - AC: Matching replies/rejections resolve only their blocker; generic activity does not.
  - AC: Fresh recursive blocker activity keeps the root eligible under stale filtering.
- [x] Add recursive graph and blocker tests (mid-dev; depends on implementation)
  - AC: Fixtures cover depth-three descendants, multiple branches, duplicate request IDs across sessions/kinds, archived intermediates, archived blocked descendants, orphans, cycles, invalid timestamps, terminal ordering, and exact stale boundaries.
  - AC: A heartbeat/running event after an ask does not clear the blocker.
  - AC: Multiple top-level roots remain isolated.
  - AC: Query-count coverage proves traversal is not per-node.
- [x] Fix generation-scoped error reactivation regression (mid-dev)
  - AC: Historical `session.error` followed by valid chat/user activity resolves as Running rather than sticky Error.
  - AC: Same-generation late tool/question events remain suppressed.
  - AC: A reactivated session can enter Waiting again on a new blocker.
  - Follow-up: Phase 04 adds persisted SQLite root-user evidence for recovery when the plugin emits no later chat/user lifecycle record.
- [ ] Review and validate Phase 02 (code-correctness reviewer + user)
  - AC: Tests, lint, typecheck, and both OpenCode dump integration checks pass.
  - AC: Manual nested-sub-agent question/permission scenarios show only the parent Waiting badge changing.
  - AC: Requirements remain incomplete until user validation confirms behavior.

## Files

- **src/backends/opencode.ts**: Recursive forest snapshot, status indexing, blocker aggregation, root precedence, and recursive `lastUpdated`.
- **src/session-core.ts**: Shared status-event/request identity extensions if required.
- **src/timing.ts**: Existing permission freshness boundary.
- **resources/opencode-plugin/ccmon.ts**: Request-aware blocker records and forced lifecycle writes.
- **tests/backends/opencode.test.ts**: Recursive graph, blocker ledger, precedence, stale, and query-count tests.
- **tests/opencode-plugin.test.ts**: Plugin request-ID and lifecycle-write tests.
