# 54 Phase: OpenCode Sub-Agent Detection Hardening

## Context

See [00-ccmon](00-ccmon.md). User reports OpenCode sub-agents (e.g., explore tasks) not being detected in the dashboard. Phase 52 added child session checks in `resolveState()` and `MAX(time_updated)` in `buildProjectState()`, and all 33 tests pass. However, the user's report is credible — edge cases may exist that the synthetic test harness doesn't cover with a real OpenCode database.

## Questions & Investigations

* [x] Q: Does Phase 52 fix handle the basic case of parent-idle + child-active?
  * Verified: `resolveState()` queries `WHERE parent_id = ? AND time_archived IS NULL AND time_updated > ?`. `buildProjectState()` uses `MAX(time_updated)` across parent and children. Both correct.

* [x] Q: Does the real OpenCode DB have `parent_id` set on sub-agent sessions?
  * Verified on this machine: yes, sub-agent sessions have `parent_id` pointing to the parent session. `scanProjects` returns the correct sessionId. `getSubagents` finds 2 children.

* [x] Q: Could the server's `rescanBackend` delete-then-rebuild gap cause missed sub-agents?
  * Analysis: No. The gap only causes temporary absence, not permanent misdetection. After rebuild completes, state is fresh.

* [x] Q: Could `scanProjects` return a DIFFERENT parent session than the one that owns the sub-agents?
  * Analysis: In theory, if a new parent session is created while old sub-agents still exist, `scanProjects` returns the new parent (highest `time_updated`), and old children become orphaned. This is correct behavior — children belong to the session that spawned them. A new session starts fresh.

* [ ] Q: Is there a timing issue where sub-agent session rows are created AFTER parent `time_updated` but BEFORE the sub-agent is discoverable?
  * TBD during implementation: inspect actual OpenCode session creation order.

* [ ] Q: Could the `parent_id` column not be populated in certain OpenCode versions or agent types?
  * TBD: check OpenCode source for task/agent session creation logic.

## Tasks

* [ ] H1: Add server-side debug logging for OpenCode sub-agent discovery
  - Log when `getSubagents` finds/doesn't find children for a session
  - Log the `resolveState` decision path (parent active / child active / all stale)
  - AC: Server stdout shows which path `resolveState` took for each scan
  - AC: Logging is structured enough to diagnose future sub-agent detection issues
  - AC: Logging is not verbose in normal operation (only when state is ambiguous or sub-agents are active)

* [ ] H2: Verify OpenCode sub-agent session creation timing
  - Inspect OpenCode source to confirm `parent_id` is always set on task/agent child sessions
  - Confirm `time_updated` on child sessions is bumped during agent execution (not just at creation)
  - AC: Understanding documented in Questions & Investigations above

* [ ] H3: Add resilience — fallback child session query for `resolveState`
  - If `parent_id` query returns no active children, also check for any non-archived child sessions in the same directory with recent `time_updated` as a wider safety net
  - AC: Sub-agents detected even if `parent_id` linkage has edge cases
  - AC: Existing behavior preserved when `parent_id` linkage is correct

* [ ] H4: Run `bun test`, `bun run lint`, `bun run typecheck`
  - AC: All tests pass (33 OpenCode + all other tests), lint clean, typecheck clean

## Files

- **src/backends/opencode.ts**: `resolveState()` — add fallback child query; add debug logging
- **tests/backends/opencode.test.ts**: Add tests for fallback query and logging behavior
