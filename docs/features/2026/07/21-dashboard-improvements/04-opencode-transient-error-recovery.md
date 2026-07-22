# Phase 04: OpenCode Transient Error Recovery

## Context

OpenCode can continue the same root session after emitting `session.error`. The ccmon plugin may not receive a later root lifecycle event, while OpenCode persists a newer root user message and continues assistant or sub-agent work in SQLite. The backend currently keeps the historical error authoritative because its generation reactivation logic only consumes status-log events.

This phase adds root-local persisted user-message evidence to error-generation reconstruction. It does not treat generic SQLite updates, assistant/tool activity, or descendant activity as recovery, and it keeps `session.deleted`/Closed permanently authoritative.

## Requirements

* R8.A: 🔄 Recover an errored OpenCode root only when a valid root-local reactivation event is strictly newer than the latest error barrier.
* R8.B: 🔄 Accept persisted SQLite root user-message creation as reactivation evidence alongside existing status-log chat/user/session-created evidence.
* R8.C: 🔄 Keep Closed authoritative and prevent descendant activity, generic session timestamps, assistant/tool activity, heartbeats, or equal/older evidence from reopening an errored root.
* R8.D: 🔄 After valid recovery, apply normal Running, Waiting, terminal, recursive blocker, and `lastUpdated` semantics to the new generation.
* R8.E: 🔄 Collect persisted user-message evidence with bounded collection-level database work rather than per-session queries.

## Design

### Merged generation evidence

```text
status-log evidence ──────────────┐
                                 ├── timestamp + stable-order timeline ──► generation state
SQLite root user-message creation ┘

closed ──────────────────────────────────────────────────────────────────► always terminal
error + no newer valid root event ───────────────────────────────────────► error
error + strictly newer root reactivation ───────────────────────────────► new generation
```

Only explicit root user intent reopens an errored generation. Existing status-log `chat.message`, raw `UserPromptSubmit`, and `session.created` evidence remains valid. A persisted SQLite user message is added because OpenCode can continue after a transient error without emitting a corresponding plugin recovery record. Equal timestamps do not reopen the generation.

`session.time_updated`, assistant messages, parts, tools, heartbeats, and descendant activity are excluded: each can occur late or indirectly and would hide genuine terminal errors. Descendants may affect Running/Waiting only after the root has validly reactivated. Closed remains absolute even if later SQLite data exists.

Once Error recovery starts a new root generation, that root-generation timestamp remains the lower bound through later root idle/Stop transitions. Blockers and direct-child lifecycle or timestamp liveness must be strictly newer to affect the root; a subsequent Error or Closed terminal state resets that generation context.

### Bounded snapshot

Persisted root user-message timestamps are loaded once per OpenCode collection and indexed by session ID. State resolution and `lastUpdated` consume the same snapshot so recovery does not introduce per-session or per-descendant database queries.

Status evidence still follows the existing `MAX_FIRST_READ` tail-read policy. For status logs larger than that retained read window, terminal Error/Closed barriers that precede the retained tail cannot be reconstructed. Persisting or indexing terminal barriers across the whole append-only log is explicitly out of scope for this phase.

## Questions & Investigations

* [x] Q: Is OpenCode `session.error` guaranteed to terminate a session permanently?
  * Uncertainty: The plugin event name suggests a terminal state, but the observed root continued processing messages and sub-agents afterward.
  * Investigation: OpenCode documents `session.error` separately from `session.deleted`; upstream lifecycle code removes sessions on deletion, while error reports describe failed steps that can receive later prompts.
  * Result: Treat Error as a generation barrier, not permanent deletion. Keep Closed as the absolute terminal state.
* [x] Q: Which SQLite evidence can safely recover an error?
  * Uncertainty: Generic session and descendant timestamps were newer than the observed error but can be updated indirectly.
  * Result: Accept only a strictly newer persisted user message belonging to the errored root. Reject generic timestamps and descendant/assistant/tool evidence.
* [x] Q: Why did the observed session remain Error?
  * Investigation: Its last plugin evidence was `session.error`, but SQLite contained a root user message created seconds later and subsequent successful work. The backend had no SQLite reactivation evidence in its generation timeline.
  * Result: Add root user-message creation to the backend evidence timeline; no plugin behavior change is required.
* [x] Q: Can persisted-message recovery require an OpenCode message table in every readable database?
  * Uncertainty: Historical/integration SQLite fixtures may contain the session graph without message storage.
  * Tried: Ran the full suite after adding the joined message CTE; the integration fixture failed with `no such table: message`.
  * Result: Attempt the one-query persisted-evidence snapshot first. On a missing-table error, read `schema_version` before verifying `sqlite_master`: retry immediately if the table appeared during the failed query, otherwise cache that earlier version. A table created after the existence check changes the version and is retried on the next scan. Collection work remains bounded and a migrated legacy database recovers without restarting the backend.
* [x] Q: Can a root idle/Stop transition or direct-child liveness bypass recovered-generation isolation?
  * Uncertainty: Root Stop reset the recovered-generation timestamp, and direct-child liveness used its own descendant lifecycle/timestamp path.
  * Result: Preserve the root generation lower bound across idle/Stop, apply it to direct-child liveness as well as blockers, and reset it only on a later hard terminal state.
* [x] Q: Does the retained status-log tail preserve every terminal generation barrier?
  * Uncertainty: The status reader retains only the last `MAX_FIRST_READ` bytes for a large append-only log.
  * Result: No. Error/Closed evidence before that tail is unavailable to generation reconstruction. Cross-log retention or indexing is out of scope for this phase.

## Tasks

- [x] Add persisted root user-message recovery evidence (senior-dev)
  - AC: A root user message strictly newer than Error starts a new generation.
  - AC: Equal/older user evidence, generic session timestamps, assistant/tool/heartbeat evidence, and descendant activity do not recover Error.
  - AC: Closed remains authoritative regardless of later evidence.
  - AC: User-message evidence is collected with bounded collection-level database work.
- [x] Preserve post-recovery state and timestamp semantics (senior-dev; depends on recovery evidence)
  - AC: A recovered root resolves Running under normal freshness rules.
  - AC: A fresh blocker after recovery resolves Waiting, while same-generation late blockers remain suppressed.
  - AC: A later Error starts a new barrier and becomes authoritative again.
  - AC: Terminal Error/Closed uses terminal root evidence for `lastUpdated`; normal recursive aggregation resumes only after recovery.
- [x] Add transient-error regression coverage (mid-dev; depends on implementation)
  - AC: Tests cover newer, equal, and stale root user messages; generic root updates; descendant activity; Closed; recovery followed by Waiting; and recovery followed by another Error.
  - AC: Query-count coverage remains bounded as session and descendant counts grow.
  - AC: Existing Phase 02 blocker and Phase 03 heartbeat/generation tests remain passing.
- [x] Address Phase 04 review findings (senior-dev)
  - AC: Descendant blockers from before a recovered root generation do not promote Waiting; newer descendant blockers do.
  - AC: A missing `message` table is retried after SQLite schema changes without restarting the backend.
  - AC: The retained-status-log terminal-barrier boundary is documented without adding retention/indexing behavior.
  - AC: A recovered root keeps its descendant-generation lower bound through later idle/Stop transitions, and direct-child liveness cannot promote it from older-generation evidence.
  - AC: A table created after a missing-table query is detected before absence is cached, with bounded collection-level work.
  - AC: A table created after the post-failure existence check is detected on the next scan by caching the schema version observed before that check.
- [~] Review and validate Phase 04 (code-correctness reviewer)
  - AC: Targeted backend tests, full tests, lint, typecheck, and both OpenCode dump checks pass.
  - AC: The previously stuck active session no longer resolves Error when equivalent post-error root user evidence is present.
  - AC: Genuine terminal errors without newer root user intent remain Error.
  - Validation: `npm test -- tests/backends/opencode.test.ts` passed 142/142; `npm test` passed 507/507; lint and typecheck passed.
  - Validation: `npm run dump -- --no-filter` and `npm run dump` returned state successfully. The observed `ses_07503f6e4ffet9hvOWPgq89KiT` resolved Stopped (not Error); four retained `apcritic` terminal-error sessions resolved Error.
  - Review status: Independent code-correctness review remains pending because the execution environment disallowed a nested reviewer agent.

## Files

- **src/backends/opencode.ts**: Added a one-query root user-message CTE, strict generation timeline reconstruction, generation-scoped descendant aggregation, race-safe missing-message-table fallback, and terminal `lastUpdated` preservation.
- **src/parsers/opencode-db.ts**: Existing persisted message parsing context; unchanged because collection recovery uses SQLite role filtering.
- **tests/backends/opencode.test.ts**: Added transient-error generation, strict-timestamp, descendant-generation cutoff across idle and liveness, schema migration-race retry, terminal-timestamp, post-recovery blocker, and bounded-query regressions.
- **resources/opencode-plugin/ccmon.ts**: Existing error/closed/status event contract; verified unchanged.
