# Phase 03: OpenCode Tool Heartbeat

## Context

OpenCode can display `Preparing patch...` while a large tool operation is still active. The current ccmon plugin records `running` after tools complete but has no tool-start signal or periodic in-flight heartbeat. During a long operation, the status log and SQLite activity can become stale and the project can appear stopped even though OpenCode is still working.

This phase adds real-time plugin-local liveness without introducing a new public state. ccmon is an internal tool, so production-grade cross-process retention, compaction, and lease management are intentionally out of scope; the existing append-only status log remains the persistence mechanism.

## Requirements

* R7.1: 🔄 Emit a forced `running` status immediately for every valid `tool.execute.before` call.
* R7.2: 🔄 Emit a forced `running` heartbeat every 30 seconds while a session has at least one in-flight tool.
* R7.3: 🔄 Track concurrent tools by call ID with one heartbeat schedule per session.
* R7.4: 🔄 Stop applicable heartbeats immediately on tool completion, tool error, terminal session events, or plugin disposal.
* R7.5: 🔄 Pause heartbeats during unresolved question/permission blockers and resume after the final blocker resolves when tool calls remain active.
* R7.6: 🔄 Do not let a late tool completion emit a stale Running transition over a newer idle, error, or waiting state.
* R7.7: 🔄 Keep heartbeat writes bounded in-process and preserve the existing status-log state semantics; append-only log retention is out of scope for this internal tool.

## Design

### In-flight tracker

```text
sessionID ──► {
  activeCallIDs: Set<callID>,
  blockerKeys: Set<requestKey>,
  heartbeatTimer,
  generation,
  heartbeatWritePending
}
```

`tool.execute.before` adds a call ID, writes immediate Running activity, and starts one session timer if needed. Every 30 seconds the timer queues at most one forced heartbeat while calls remain active and no blocker is outstanding. Parallel calls share the timer; completing one call does not stop it while another remains.

Ask/permission events pause the timer without discarding active call IDs. Matching replies/rejections remove only their blocker; the final resolution resumes the timer if calls remain. This phase consumes the request-aware blocker lifecycle from Phase 02.

### Immediate cleanup and ordering

Completion bookkeeping occurs synchronously before asynchronous file writes:

```text
tool.execute.before ──► add call + immediate forced running
tool.execute.after ───► remove call; no late forced running completion
message.part.updated ─► clear completed/error tool defensively
session.idle/error/deleted ─► clear session tracker
plugin.dispose ───────► clear all timers and drain safe writes
```

The next actual lifecycle event determines the public state. Tool completion alone does not mean stopped; `session.idle`, waiting, or error events must win immediately. A generation token prevents queued heartbeats from writing after a newer terminal/waiting state.

### Forced writes

Ordinary state transitions retain same-state deduplication. Dedicated `tool.execute.before` and `tool.execute.heartbeat` records bypass that deduplication. One timer and one pending heartbeat per session bound in-process work; the existing append-only status log is intentionally not compacted in this phase.

### Validation contingency

The initial scope excludes `session.status: busy`. Manual tracing must confirm `tool.execute.before` begins before the problematic `Preparing patch...` interval. If it does not, reopen the busy-signal design as a follow-up rather than silently claiming the heartbeat fixes the issue.

## Questions & Investigations

* [x] Q: Is `Preparing patch...` a dedicated OpenCode event?
  * No. It is a UI stage around tool-part execution; `tool.execute.before` is the closest real-time plugin hook.
* [x] Q: Why is timestamp-only inference insufficient?
  * A long tool can exceed the 60-second stale window without producing a status-log completion event, so age alone can report Stopped during active work.
* [x] Q: What heartbeat cadence is acceptable?
  * 30 seconds, which is at most half the current 60-second stale threshold.
* [x] Q: Should every tool or only patch tools heartbeat?
  * Every tool, matching existing `tool.execute.after` coverage and avoiding tool-name/version assumptions.
* [x] Q: Should `session.status: busy` be included initially?
  * No. Use it only if manual tracing proves the tool hook misses the failure interval.
* [x] Q: What happens when a tool completes?
  * Cancel its heartbeat immediately; do not wait for a timeout. Let the next actual OpenCode lifecycle event determine Running, Waiting, Stopped, or Error.
* [x] Q: Why is production-grade retention not part of this phase?
  * ccmon is an internal tool; correctness of real-time state is prioritized over distributed compaction and long-term log growth. Retention can be a separate project if needed.

## Tasks

- [~] Verify the runtime hook timing against a real large patch (junior-dev + user)
  - AC: A trace confirms whether `tool.execute.before` fires before the problematic `Preparing patch...` interval.
  - AC: If it does not, the result explicitly reopens `session.status: busy` as a follow-up design rather than hiding the gap.
- [x] Implement the per-session in-flight tracker (senior-dev)
  - AC: Unique call IDs are idempotent and concurrent calls share one timer per session.
  - AC: A completed call does not stop another active call’s heartbeat.
  - AC: No timer remains after final completion, terminal event, or disposal.
- [x] Implement serialized forced heartbeat writes (senior-dev; depends on tracker)
  - AC: Tool starts and heartbeats bypass same-state deduplication.
  - AC: Ordinary same-state transitions remain deduplicated.
  - AC: At most one heartbeat write is pending per session.
  - AC: Generation ordering prevents queued heartbeats from overwriting newer Waiting/Error/Stopped/Closed evidence.
- [x] Integrate blocker pause/resume and all cleanup paths (senior-dev; depends on Phase 02 blocker identity)
  - AC: Ask/permission pauses a session heartbeat while retaining active calls.
  - AC: Final matching resolution resumes it when calls remain.
  - AC: `after`, tool-part completed/error, idle, session error, deleted, and dispose clean up correctly.
  - AC: Out-of-order and duplicate lifecycle events do not leak timers or resurrect state.
- [x] Drop production-grade retention and compaction from scope (main agent decision)
  - AC: The heartbeat implementation does not require cross-process leases, atomic compaction, or a hard log-size guarantee.
  - AC: The internal-tool trade-off is recorded in this phase and project docs.
- [x] Add fake-timer, plugin, and backend tests (mid-dev; depends on implementation)
  - AC: No heartbeat occurs before 30 seconds; one occurs at each interval while active.
  - AC: Running remains fresh across multiple 60-second windows.
  - AC: Completion, idle, error, waiting, and disposal become visible immediately without a later heartbeat.
  - AC: Parallel calls, blocker pause/resume, stale generations, and plugin restart are covered.
  - AC: The cadence is asserted to be no greater than half the stale threshold.
- [~] Review and validate Phase 03 (code-correctness reviewer + user)
  - AC: Tests, lint, typecheck, and both OpenCode dump integration checks pass.
  - AC: A real tool run longer than two minutes never appears Stopped.
  - AC: Completion changes state through lifecycle events immediately rather than a 60-second timeout.
  - AC: Permission during a long tool shows Waiting and heartbeats do not override it; resolution resumes active liveness.
  - AC: Failed tool and plugin restart leave no continuing heartbeat.
  - AC: Sustained operation keeps in-process timers and pending writes bounded; log retention is explicitly out of scope.

## Files

- **resources/opencode-plugin/ccmon.ts**: Tool-start hook, per-session heartbeat tracker, blocker pause/resume, forced writes, and cleanup.
- **src/backends/opencode.ts**: Reads heartbeat events through existing running normalization.
- **src/timing.ts**: Heartbeat cadence and relationship to existing activity thresholds.
- **tests/opencode-plugin.test.ts**: Plugin hooks, fake timers, concurrency, cleanup, and dedup tests.
- **tests/backends/opencode.test.ts**: Backend heartbeat integration behavior.
