# Dashboard Improvements

## Context

The dashboard currently identifies OpenCode sessions by placing the session name in parentheses after the project name. This makes the project being worked on difficult to scan, especially when the combined identity is long and is not truncated in a useful way. The session name is the more valuable identifier when both names exist, while the project name and the machine hosting it must remain visible context.

The completed baseline implementation keeps the card identity compact and explicit: a first row for textual state, project, and machine, followed by a session-name row when a human-readable name exists. The redundant backend source badge and separators were removed. The card cap widened to approximately 480px while retaining a narrow-screen-safe minimum; the existing context, task, agent, and flash sections remain unchanged.

Recovery work now proceeds from known-good commit `a2e0a344d4cf`, not from the combined `097c1f22` squash. Safe additions are reintroduced as independent changes with their own validation and rollback boundaries; retained-Waiting and other confirmed state regressions are excluded.

## Inbox

- [x] A sub-agent asking question should mark the session as blocked (planned in [Phase 02](02-subagent-question-blocking.md))
- [x] When opencode is in `preparing patch` and the patch is big, the project may be marked as stopped (planned in [Phase 03](03-opencode-tool-heartbeat.md))

- [x] Add a way to remove cards from dashboard (planned in [Phase 05](05-safe-dashboard-recovery.md)).

- [ ] If a project is in `Waiting`, don't make it time out with `Stopped`. It should remain waiting (deferred: retained asks are not authoritative after an OpenCode runtime disappears).

- [x] Drop `.local` suffix from hostnames (planned in [Phase 05](05-safe-dashboard-recovery.md)).
- [x] Detect workspaces (`.workspaces/` prefix), and find a way to show <project name>/<workspace name> instead (planned separately in [Phase 06](06-workspace-display-identity.md)).

## Checkpoint

The recovery line is a clean child of known-good `a2e0a344d4cf`; the problematic squash and partial-recovery changes remain preserved separately. Phase 05 is planned but not implemented: first repair the baseline plugin export contract, then independently add frontend-only `.local` shortening and a fresh compact hover-only dismissal control.

Next resume at Phase 05's baseline-verification task. Keep one change per feature and stop after Phase 05; deferred Phase 06 workspace labels need separate approval. Retained-Waiting, stale-filter exemptions, cancellation heuristics, SQLite/WAL watching, and runtime leases remain excluded.

## Requirements

* R1: ✅ Make the session name the primary card identity when it is available (Phase: Session Card Layout, see R1.A–R1.B in the phase doc)
  * R1.1: The session name is not presented only as parenthesized secondary text after the project name.
  * R1.2: Cards remain understandable when no session name is available.
* R2: ✅ Keep the project name visible as distinct secondary context (Phase: Session Card Layout, see R2.A in the phase doc)
* R3: ✅ Keep the machine/host identity visible as distinct first-row context (Phase: Session Card Layout, see R3.A in the phase doc)
* R4: ✅ Preserve the remaining card context, including state and agent activity, while making the identity area easier to scan (Phase: Session Card Layout, see R4.A in the phase doc)
* R5: ✅ Establish and review an ASCII card layout before implementation planning begins (Phase: Session Card Layout, see R5.A in the phase doc)
* R6: 🔄 Promote a top-level OpenCode session to Waiting when any descendant has a fresh unresolved question or permission (Phase: Sub-agent Question Blocking, see R6.1–R6.14 in the phase doc)
* R7: 🔄 Keep OpenCode sessions Running in real time during long-running tools with pragmatic plugin heartbeats (Phase: OpenCode Tool Heartbeat, see R7.1–R7.7 in the phase doc)
* R8: 🔄 Recover an OpenCode root from a transient Error only on strictly newer root-local user intent, while keeping Closed and genuine terminal errors authoritative (Phase: OpenCode Transient Error Recovery, see R8.A–R8.E in the phase doc)
* R9: 🔄 Shorten one terminal `.local` hostname suffix only in frontend display while preserving raw backend identity, URLs, protocol values, and collision distinguishability (Phase: Safe Dashboard Recovery, see R9.A–R9.D in the phase doc)
* R10: 🔄 Allow an exact card identity/state to be dismissed in page memory with a compact hover-only control that does not change card dimensions (Phase: Safe Dashboard Recovery, see R10.A–R10.F in the phase doc)
* R11: 🔄 Keep the OpenCode plugin entry module loadable by exporting only callable plugin factories while preserving heartbeat backpressure behavior (Phase: Safe Dashboard Recovery, see R11.A–R11.C in the phase doc)
* R12: ⬜ Display `.workspaces/<name>` sessions as `<filesystem-root>/<workspace>` without changing canonical project/session identity; only derived `displayName` output may change (Phase: Workspace Display Identity, see R12.A–R12.E in the phase doc)

## Design

The approved identity hierarchy uses two compact rows. Row one starts with the textual state pill, followed by the project display name and right-aligned server hostname; separators and the redundant source badge are omitted. Project and hostname occupy independent shrink-safe grid tracks so the project does not disappear when the hostname is long. Row two contains the human-readable session name and is omitted when no such name exists. All identity values retain the existing single-line ellipsis behavior; full values remain available through the DOM/title affordance. The grid widens the card maximum to approximately 480px without sacrificing narrow-screen safety. The lower context, task, agent, and flash sections are unchanged.

Recovery follows a strict known-good-baseline rule: implement each safe feature from baseline patterns, use the rejected squash only as a requirements/test reference, validate it independently, and retain a separate rollback boundary. Presentation transformations may change only explicit display fields; raw identity and backend state remain authoritative.

## Questions & Investigations

* [x] Q: How is the session name displayed today?
  * Existing documentation records the pattern as `projectName (sessionName)` from the earlier session-name display phase.
  * The new project treats that combined parenthesized presentation as the problem to revisit, not as a data-model change.
* [x] Q: Where does the current card layout live?
  * `public/js/render.js` contains `createCard()` and the card rendering helpers.
  * `public/index.html` contains the dashboard shell and card/grid styling.
  * `public/js/utils.js` contains shared display helpers and escaping/truncation utilities.
* [x] Q: What current design guidance is relevant?
  * Recent dashboard/card guidance consistently prioritizes one primary title, distinct secondary metadata, responsive constrained layouts, and CSS ellipsis with `min-width: 0` in flex children.
  * Sources consulted: Spell UI card design patterns, Art of Styleframe dashboard patterns, LogRocket CSS truncation guidance, and PatternFly dashboard guidelines.
* [x] Q: What exact hostname source and label should the card use?
  * Use the server hostname already supplied in each WebSocket update; show it on every card.
* [x] Q: What is the preferred fallback hierarchy when a session name is absent?
  * Omit the session row rather than repeat the project or show a short session ID.
* [x] Q: How should users access the complete value when a session, project, or machine string exceeds the available width?
  * Continue the existing one-line CSS ellipsis behavior and retain a full-value title/DOM affordance.
* [x] Q: Is the backend source badge useful in the final identity row?
  * No. The user considers `OC`/`CC` redundant; remove it and keep state, project, hostname, and session identity.
* [x] Q: How should a descendant question affect its top-level parent?
  * Reuse `waiting_for_permission` on the parent; parent badge only, with no new public state or sub-agent UI indicator. Any fresh unresolved blocker wins over Running, while root `closed`/`error` remains authoritative.
* [x] Q: Which descendants count for blocking?
  * All descendants reachable through the SQLite `session.parent_id` graph, including nested sub-agents. Use a recursive forest snapshot; do not infer ancestry from project names or directories.
* [x] Q: How should multiple questions and permissions be correlated?
  * Use `(session_id, blocker_kind, request_id)` identity, with a conservative legacy session-level slot for ID-less records. Replies/rejections clear only matching blockers; the existing five-minute freshness window remains authoritative.
* [x] Q: How should long OpenCode tools remain Running in real time?
  * The plugin tracks every in-flight tool by call ID, writes an immediate running event on `tool.execute.before`, emits forced running heartbeats every 30 seconds while active, pauses during blockers, and stops the heartbeat immediately on completion/error/terminal/dispose.
* [x] Q: How should heartbeat writes interact with the status-log deduplication and growth?
  * Use a dedicated forced heartbeat write path, keep one timer per session, and accept append-only status-log growth for this internal tool; production-grade retention/compaction is out of scope.
* [x] Q: Is `session.status: busy` part of the initial heartbeat scope?
  * No. Validate that `tool.execute.before` covers the problematic interval; only reopen `session.status: busy` as a contingency if real tracing proves it does not.
* [x] Q: Can a historical OpenCode error remain authoritative after later user activity?
  * No. Error barriers are generation-scoped: valid later `chat.message`, raw user prompt, or `session.created` activity reopens the session, while same-generation late tool/question evidence remains suppressed.
* [x] Q: What if OpenCode persists later root user activity but emits no plugin recovery event?
  * A strictly newer persisted root user message is valid generation reactivation evidence. Generic SQLite timestamps, assistant/tool activity, and descendant activity are not sufficient; Closed remains permanently authoritative.
* [x] Q: Why recover from `a2e0a344d4cf` instead of repairing `097c1f22` in place?
  * Result: The squash combined safe display work with invalid retained-Waiting semantics, a plugin export-contract break, and UI regressions. A clean child of the known-good parent preserves the working state model and permits each safe feature to retain an independent rollback boundary.
* [x] Q: Which post-baseline work is safe to reintroduce now?
  * Result: The isolated plugin export correction, frontend-only collision-safe `.local` display, and fresh in-memory card dismissal are safe. Workspace display labels are also presentation-only but remain a separate phase because they affect server-side display-name disambiguation. Retained-Waiting and cancellation changes are excluded.
* [x] Q: Did the plugin export break originate only in the rejected squash?
  * Result: No. Known-good `a2e0a344d4cf` already exports numeric `MAX_PENDING_WRITES`, which OpenCode 1.18.4 attempts to invoke as a plugin factory. Treat its correction as a prerequisite baseline repair, previously proven in an isolated runtime, rather than as a feature copied from the squash.

## Phases

### ✅ 01 Phase: Session Card Layout

[01-session-card-layout](01-session-card-layout.md)

Implemented and visually validated the two-row session-first identity block, widened the card cap, removed the redundant source badge, and preserved existing card content and behavior. Automated checks pass.

### 🔄 02 Phase: Sub-agent Question Blocking

[02-subagent-question-blocking](02-subagent-question-blocking.md)

Implemented recursive descendant blocker aggregation so a fresh unresolved question or permission places the top-level OpenCode session in the existing Waiting state. Automated checks pass; manual nested-question validation remains before completion.

### 🔄 03 Phase: OpenCode Tool Heartbeat

[03-opencode-tool-heartbeat](03-opencode-tool-heartbeat.md)

Implemented pragmatic plugin-local real-time tool liveness with immediate starts, 30-second forced heartbeats, immediate cleanup, and bounded in-process work. The heartbeat suites are hermetic against CI filesystem timing. Production-grade status-log retention is out of scope; only the real OpenCode timing trace remains before completion.

### 🔄 04 Phase: OpenCode Transient Error Recovery

[04-opencode-transient-error-recovery](04-opencode-transient-error-recovery.md)

Implemented persisted root user-message evidence in OpenCode generation reconstruction so a transient Error can recover without a plugin follow-up event. Closed remains absolute, and generic timestamps or descendant activity cannot hide genuine errors. Automated validation is complete; review closure remains.

### 🔄 05 Phase: Safe Dashboard Recovery

[05-safe-dashboard-recovery](05-safe-dashboard-recovery.md)

Recover only independently proven additions on top of `a2e0a344d4cf`: repair the plugin runtime export contract, shorten `.local` in frontend display without changing identity, and add compact transient card dismissal without changing card dimensions. Each feature is implemented, reviewed, validated, and committed separately.

### ⬜ 06 Phase: Workspace Display Identity

[06-workspace-display-identity](06-workspace-display-identity.md)

Add lexical `.workspaces/<name>` display labels as an isolated change after Phase 05 stabilizes and receives separate approval. Preserve canonical identity while explicitly validating the changed derived `displayName` in HTTP, WebSocket, and dump output.

## Files

- **public/js/render.js**: Two-row identity rendering, display-name precedence, and preserved card activity rendering (Session Card Layout).
- **public/index.html**: Dashboard shell, widened grid, and card identity CSS (Session Card Layout).
- **public/js/utils.js**: Shared escaping and truncation helpers relevant to readable identity values.
- **public/js/backend-manager.js**: Merges server updates, carries raw hostname context, and is planned to derive frontend-only collision-safe host labels (Session Card Layout, Safe Dashboard Recovery).
- **src/server.ts**: Sends the server hostname with WebSocket state updates.
- **src/types.ts**: Defines the project/session fields consumed by the card.
- **tests/render.test.ts**: Focused identity, hostname, fallback, cross-host, and preserved-card tests (Session Card Layout).
- **src/backends/opencode.ts**: Recursive descendant discovery, blocker aggregation, precedence, and recursive activity planning (Sub-agent Question Blocking).
- **src/session-core.ts**: Shared status-event/request identity extensions if required by blocker reconstruction (Sub-agent Question Blocking).
- **src/timing.ts**: Existing permission/activity thresholds and heartbeat cadence relationship (Sub-agent Question Blocking, OpenCode Tool Heartbeat).
- **resources/opencode-plugin/ccmon.ts**: Request-aware lifecycle records, in-flight tool tracking, forced heartbeats, and cleanup (Sub-agent Question Blocking, OpenCode Tool Heartbeat).
- **tests/backends/opencode.test.ts**: Recursive graph, blocker ledger, precedence, stale boundary, and backend integration tests (Sub-agent Question Blocking).
- **tests/opencode-plugin.test.ts**: Plugin request-ID and hermetic heartbeat lifecycle tests (Sub-agent Question Blocking, OpenCode Tool Heartbeat).
- **tests/opencode-plugin-phase03-findings.test.ts**: Hermetic delayed-write, generation-ordering, blocker-pressure, and bounded-work regressions (OpenCode Tool Heartbeat).
- **src/parsers/opencode-db.ts**: Persisted OpenCode message access relevant to collection-level recovery evidence (OpenCode Transient Error Recovery).
- **tests/server.test.ts**: Planned workspace `displayName` HTTP/WebSocket propagation coverage with canonical-field preservation (Workspace Display Identity).
- **tests/cli-dump.test.ts**: Planned workspace `displayName` dump propagation coverage with canonical-field preservation (Workspace Display Identity).
