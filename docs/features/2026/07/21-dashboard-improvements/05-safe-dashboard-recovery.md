# Phase 05: Safe Dashboard Recovery

## Context

The combined `097c1f22` squash mixed safe presentation features with confirmed state, plugin-loading, and layout regressions. This phase starts from known-good `a2e0a344d4cf` and performs one prerequisite baseline repair plus two independently justified additions: correct the OpenCode plugin export contract already broken in the baseline, add frontend-only terminal `.local` shortening, and add transient card dismissal with a compact hover-only control.

Every feature has its own Jujutsu change, tests, review, runtime or browser gate, and rollback boundary. No retained-Waiting semantics, Waiting stale-filter exemption, cancellation classification, SQLite/WAL watcher, runtime lease, or backend state redesign belongs in this phase.

## Requirements

* R9.A: 🔄 Remove exactly one case-insensitive terminal `.local` label, optionally followed by one DNS trailing dot, wherever a hostname is displayed.
* R9.B: 🔄 Preserve raw hostname, backend key, URL, WebSocket payload, sort/flash identity, and project/session identity.
* R9.C: 🔄 Preserve malformed, nonterminal, whitespace-bearing, bare `local`, `localhost`, and other-domain hostname forms.
* R9.D: 🔄 Keep distinct raw hosts visually distinguishable by retaining raw labels when shortening collides.
* R10.A: 🔄 Allow every card state to be dismissed for its exact raw backend/source/session identity and captured state.
* R10.B: 🔄 Keep dismissal in page memory only; reload restores cards and no backend/storage mutation occurs.
* R10.C: 🔄 Keep same-state cards hidden and restore them on state change, session replacement, or authoritative absence.
* R10.D: 🔄 Use a native compact top-right × that is hidden normally, visible on card hover or keyboard focus, and does not change card dimensions or content geometry.
* R10.E: 🔄 Preserve accessible naming, keyboard activation, click propagation isolation, sorting, flash bookkeeping, and empty-state rendering.
* R10.F: 🔄 Add no mobile/coarse-pointer exception, 44px touch target, fourth grid track, added card padding, persistence, Undo, or backend command.
* R11.A: 🔄 Ensure every OpenCode plugin entry-module runtime export is callable as a plugin factory.
* R11.B: 🔄 Preserve the exact bounded pending-write behavior without exporting test constants.
* R11.C: 🔄 Load through OpenCode 1.18.4 and deliver a fresh session through ccmon within two seconds.
* R13.A: 🔄 Emit the complete one-shot dump payload before a successful CLI process exits, including output larger than the platform pipe buffer.
* R13.B: 🔄 Preserve exit codes, JSON shape, resource cleanup, filtered dumps, and watch behavior while allowing stdout to drain naturally.

## Design

### Recovery boundaries

```text
a2e0a344 known-good baseline
          │
          ├── plugin export correction ── validate + commit
          ├── .local display only ─────── validate + commit
          └── card dismissal ──────────── validate + commit
```

Never copy the squash wholesale. Implement against baseline patterns and use the old diff only as a requirements/test reference.

### Host display

Derive collision-safe display labels from all configured raw hostnames. Stamp a display-only hostname onto cloned frontend project objects and use it for card text/title, backend-menu labels, and cross-host prefixes. Raw identity and transport values remain untouched.

Recompute the display mapping whenever configured backends or their learned hostnames change. Disconnection must not mutate raw identity; reconnecting or removing a backend may legitimately change only the display collision set.

### Card dismissal

Track dismissal in a module-memory map keyed by a JSON tuple of raw backend key, source, and session ID, with captured normalized state as the value. Process complete incoming state before filtering hidden cards. The native button is a 20px out-of-flow overlay, invisible and non-intercepting by default, revealed by card hover or `:focus-visible`. It must not alter card/header tracks, padding, dimensions, or text truncation.

## Questions & Investigations

* [x] Q: Which baseline already contains the previously working card and backend behavior?
  * Result: `a2e0a344d4cf`; the recovery change is a clean child of it and the prior stack remains preserved.
* [x] Q: Does the baseline plugin already satisfy OpenCode's export contract?
  * Result: No. It exports numeric `MAX_PENDING_WRITES`; OpenCode 1.18.4 invokes every entry export and fails. The isolated correction was previously runtime-proven: status write in 4ms and subscriber delivery in 856ms.
* [x] Q: Does `.local` removal require a backend or protocol change?
  * Result: No. Baseline already sends raw hostnames; shortening and collision mapping remain frontend-only.
* [x] Q: Should workspace labels be coupled to `.local` shortening?
  * Result: No. Workspace labels alter server-side project display/disambiguation and are isolated in Phase 06.
* [x] Q: Can the original dismissal CSS be reused?
  * Result: No. It added a fourth grid track, an in-flow 44px control, and always-visible/coarse-pointer behavior. The recovery uses a fresh 20px out-of-flow hover/focus control.
* [x] Q: Which work from the abandoned recovery stack is already proven but not present on this line?
  * Result: A separate preserved change corrected the plugin export contract and was runtime-validated with OpenCode 1.18.4: `session.created` was written in 4ms and delivered to a ccmon subscriber in 856ms. Another preserved change contains a statically reviewed 20px Hide-control correction, but browser validation was unavailable; use it only as reference and reimplement against this baseline.
* [x] Q: Why not continue designing retained-Waiting runtime leases?
  * Result: The user chose immediate recovery from the known-good state rather than further state-protocol design. Retained-Waiting remains excluded because historical asks cannot prove a discarded OpenCode runtime still has a pending request.
* [x] Q: Why did final `dump --no-filter` validation exit successfully with truncated JSON?
  * Tried: Compared direct Node and npm output through files, shell pipes, and subprocess capture; reproduced against both the recovery stack and `a2e0a344d4cf`.
  * Result: `src/cli/main.ts` calls `process.exit(0)` immediately after `console.log()` queues a large payload. Pipe-backed stdout is asynchronous, so the process exits after only part of the JSON is written. File-backed output completes, and replacing forced exit with `process.exitCode` drains the full payload.
  * Decision: The user approved a separate regression/fix change because both dump commands are required Phase 05 gates; baseline provenance does not make invalid piped JSON acceptable.

## Tasks

- [x] Verify known-good baseline before additions
  - AC: Targeted baseline tests, full tests, lint, typecheck, and both dump checks pass.
  - AC: The diff from `a2e0a344d4cf` contains only project documentation/symlink before implementation starts.
- [x] Correct the OpenCode plugin export contract (R11.A–R11.C; staff-dev)
  - AC: `ccmonPlugin` is the only runtime export and every runtime export is callable.
  - AC: Bounded-write tests verify observable 256-item behavior without importing a numeric constant.
  - AC: Targeted plugin tests, full tests, lint, and typecheck pass.
  - AC: Isolated OpenCode 1.18.4 runtime writes a real root and ccmon delivers it within two seconds.
  - Baseline validation: Targeted suites passed 280/280, full suite passed 507/507, lint and typecheck passed, both dump commands succeeded, and the recovery diff contains only project docs plus the `proj` symlink.
  - Validation: Targeted plugin suites passed 21/21, full suite passed 508/508, lint and typecheck passed, correctness/requirements reviews found no issues, and isolated OpenCode 1.18.4 wrote status in 2ms and delivered the session in 224ms.
- [~] Add collision-safe frontend `.local` shortening (R9.A–R9.D; senior-dev)
  - AC: Accepted and rejected hostname forms match the requirements exactly.
  - AC: Cards, backend menu, and cross-host prefixes use one consistent collision-safe display mapping.
  - AC: Raw hostnames, backend keys, URLs, payloads, and identity/state keys remain byte-for-byte unchanged.
  - AC: Hostname discovery, backend addition/removal, disconnect, and reconnect recompute only display labels and preserve raw connection/identity values.
  - AC: Targeted/full tests, lint, typecheck, and browser/manual display checks pass.
  - Automated validation: Targeted render tests passed 21/21, full suite passed 518/518, lint and typecheck passed, and independent correctness/requirements reviews found no remaining static issues.
  - Remaining: Browser/manual checks for cards, menu, cross-host prefixes, collision fallback, and add/remove/disconnect/reconnect display transitions.
- [~] Add transient card dismissal and compact Hide control (R10.A–R10.F; senior-dev)
  - AC: Every state supports exact identity/state-scoped in-memory dismissal; state/session/authoritative absence and reload restore appropriately.
  - AC: The 20px control is out of flow, hidden/non-intercepting normally, shown on card hover or keyboard focus, and adds no card/header dimensions, padding, grid track, truncation change, or adjacent-card overlap.
  - AC: Dismissal uses no browser storage, HTTP/WebSocket mutation, backend command, Undo, or reset UI.
  - AC: Existing sorting, flash, accessible naming, propagation, and empty-state behavior remain correct.
  - AC: Targeted/full tests, lint, typecheck, and browser/manual geometry and interaction checks pass.
  - Automated validation: Targeted render tests passed 31/31, full suite passed 528/528 before the dump fix and 529/529 afterward, lint and typecheck passed, and correctness/requirements reviews found no implementation defect.
  - Remaining: Browser/manual geometry, hover/focus, keyboard/mouse interaction, flash-card interaction, restoration, and reload checks.
- [x] Fix large piped dump truncation (R13.A–R13.B; senior-dev)
  - AC: A subprocess fixture emits more than 64KiB through a real pipe, exits zero, parses as complete JSON, and contains the exact expected projects.
  - AC: Successful one-shot commands use natural process termination so buffered stdout drains; error exit codes remain correct.
  - AC: Targeted CLI tests, full tests, lint, typecheck, filtered dump, and no-filter dump through direct and npm-silent pipes pass.
  - AC: The fix remains isolated from plugin, frontend, backend-state, filtering, cancellation, polling, and workspace behavior.
  - Validation: Targeted regression passed 1/1, CLI suite 63/63, full suite 529/529, lint and typecheck passed. Direct and npm-silent filtered/no-filter pipes plus file capture parsed complete JSON; the 512-project regression verifies every expected identity tuple.
- [ ] Deploy the corrected plugin and reload OpenCode runtimes (R11.C; user validation)
  - AC: The repository plugin is copied to `~/.config/opencode/plugins/ccmon.ts` after preserving a recoverable prior copy.
  - AC: Existing OpenCode processes are restarted so they load the corrected plugin; restarting only `ccmon serve` is explicitly insufficient.
  - AC: Runtime logs contain no `Plugin export is not a function`, and a real session transitions from Running to Stopped through plugin lifecycle evidence without waiting for SQLite fallback expiry.
- [~] Review recovery scope and final integration (code-correctness reviewer + requirements reviewer)
  - AC: Each feature diff contains only its planned files and retains an independent rollback boundary.
  - AC: No backend state, blocker freshness, stale filtering, cancellation, polling, or WAL behavior changes.
  - AC: Full tests, lint, typecheck, both dump checks, plugin runtime validation, and frontend browser/manual validation pass on the final stack.
  - AC: Stop after Phase 05; Phase 06 workspace labels require separate approval and implementation change.
  - Automated validation: Plugin 21/21, render 31/31, CLI 66/66, full suite 529/529, lint and typecheck passed. Direct and npm-silent filtered dumps parsed 4 projects; no-filter dumps parsed 250 projects and 333,046 bytes. Isolated OpenCode 1.18.4 wrote status in 2ms and delivered it in 224ms.
  - Scope validation: Plugin, hostname, dismissal, and dump fixes remain independent changes. No state, blocker freshness, stale filtering, cancellation, polling/WAL, runtime lease, or workspace implementation change exists.
  - Remaining: Corrected plugin deployment/OpenCode restart plus hostname and dismissal browser/manual gates.

## Files

- **resources/opencode-plugin/ccmon.ts**: Runtime export-contract correction only.
- **tests/opencode-plugin.test.ts**: Callable-export and immediate creation coverage.
- **tests/opencode-plugin-phase03-findings.test.ts**: Observable bounded-write coverage without data exports.
- **public/js/utils.js**: Pure hostname display shortening and collision mapping.
- **public/js/backend-manager.js**: Configured-host display mapping and frontend-only display hostname stamping.
- **public/js/render.js**: Display-host consumption and transient dismissal lifecycle/control.
- **public/index.html**: Compact zero-layout-cost Hide-control styling.
- **tests/render.test.ts**: Host display, raw identity, dismissal lifecycle, accessibility, and CSS regressions.
- **src/cli/main.ts**: Natural one-shot CLI termination that permits buffered stdout to drain.
- **tests/cli.test.ts**: Large piped dump process-boundary regression.
