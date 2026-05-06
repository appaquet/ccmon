# 52 Phase: OpenCode State Detection Fix

## Context

See [00-ccmon](00-ccmon.md). OpenCode projects with active sub-agents are reported as "stopped" in the dashboard while sub-agents are clearly running. The root cause is a disconnect between state resolution and sub-agent activity.

## Questions & Investigations

* [x] Q: Why are sub-agents visible while the project badge shows "stopped"?
  * Traced: `buildProjectState` (opencode.ts:77) calls `this.getSubagents(projectInfo)` unconditionally — unlike ClaudeBackend which gates on `state === "running"`. Sub-agents correctly identified as active via `parent_id` query.
  * Root cause: `resolveState` (opencode.ts:89-102) queries only `session.time_updated` for the parent row. Sub-agents write to their own child `session` rows with `parent_id` pointing to the parent. The parent's `time_updated` is never updated by sub-agent activity.
  * Result: When parent is idle but sub-agents are actively working, `resolveState` returns "stopped" while `getSubagents` correctly returns active sub-agents → contradictory dashboard display.

* [x] Q: Does OpenCode update the parent session's `time_updated` when sub-agents write messages?
  * Result: No. Each sub-agent has its own `session` row linked by `parent_id`. Sub-agent message inserts update the child's `time_updated`, not the parent's. This is correct DB normalization — the parent shouldn't be touched by child activity.

* [x] Q: Should `lastUpdated` also reflect child activity?
  * Result: Yes. If sub-agents are the most recent activity, `lastUpdated` on the parent should reflect that. Use `MAX(parent.time_updated, MAX(child.time_updated))`.

## Tasks

* [x] R71.2a: `resolveState` considers sub-agent activity when parent is stale
  - AC: Parent stale + child active within OPENCODE_ACTIVE_THRESHOLD_MS → state = "running"
  - AC: Parent stale + all children stale → state = "stopped" (existing behavior preserved)
  - AC: Parent active → state = "running" (existing behavior preserved)
  - AC: No children → existing behavior unchanged
 
* [x] R71.2b: `lastUpdated` reflects most recent activity across parent and children
  - AC: When children are more recently updated than parent, `lastUpdated` uses child's `time_updated`
  - AC: When parent is the most recent, `lastUpdated` uses parent's `time_updated`

## Tests

All tests in `tests/backends/opencode.test.ts`. Each test inserts exact DB state, calls the relevant method, and asserts the result.

1. **resolveState — running via child activity**: Parent stale (time_updated = 60s ago), one child active (time_updated = now). `resolveState` returns "running".
2. **resolveState — stopped when all children stale**: Parent stale, all children also stale. `resolveState` returns "stopped".
3. **resolveState — running via parent activity**: Parent active (time_updated = now). `resolveState` returns "running" (existing behavior, verify not broken).
4. **resolveState — no children**: Parent stale, no children. `resolveState` returns "stopped" (existing behavior, verify not broken).
5. **buildProjectState — lastUpdated from child when child is more recent**: Parent time_updated = 60s ago, child time_updated = now. `state.lastUpdated` equals child's time_updated.
6. **buildProjectState — lastUpdated from parent when parent is more recent**: Parent time_updated = now, child time_updated = 60s ago. `state.lastUpdated` equals parent's time_updated.

## Files

- **src/backends/opencode.ts**: `resolveState()` — add child session query; `buildProjectState()` — use MAX time_updated for lastUpdated
- **tests/backends/opencode.test.ts**: Add 6 tests covering child-activity state detection and lastUpdated
