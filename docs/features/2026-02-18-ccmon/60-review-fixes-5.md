# Phase 60: Review Fixes 5

## Context

Address 33 REVIEW comments from a 4-agent whole-codebase review (code-style, code-correctness, architecture, requirements). See [00-ccmon](00-ccmon.md). Validated by 3 senior-dev research agents: 31 VALID, 1 debatable (`server.ts:164` hardening, no live exploit), 1 valid-with-nuance (`status.ts:151` traversal risk overstated but separation-of-concerns holds).

Breakdown: 5 High (correctness), 10 Medium (correctness/validation + architecture), 18 Low (style/dead code/simplification). 16 files affected.

## Questions & Investigations

* [x] Q: `maxInactivityHours` default — code `1` vs CLAUDE.md + R18.1 `3`. Which is intended?
  * Uncertainty: `config.ts` changed across many phases; history doesn't pinpoint a deliberate 3→1 change
  * Decision (default — user may override): align docs → code (**1h**), behavior-preserving. Keep `config.ts` at `1`; update CLAUDE.md + R18.1 to 1h
* [x] Q: `claude.ts:139` dead `getProjectState`/`projectStateCache`/`changedProjectDir` incremental branch (~50 lines, zero production callers confirmed by grep) — delete or wire in?
  * Decision: **DELETE**. Remove the ~50 lines + `_disambiguateProjectNames` (resolves claude.ts:188); migrate its tests to `buildProjectState`. Fix the stale "watcher path" comment
* [x] Q: `types.ts:24` + `:51` type redesign scope?
  * Decision: **FULL discriminated union** — make `ProjectInfo`/`ProjectState` variant-correct on `source` (`projectDir` claude-only, `latestJSONL` claude-only); extends R88. Ripples to build-project-state, claude.ts, server, frontend projKey, many tests. Staff-level
* [x] Q: `render.js:253` disambiguation runs in TWO places — single owner?
  * Initial decision: SERVER owns (frontend renders verbatim)
  * Investigation: the two passes are ORTHOGONAL, not competing. Server `disambiguateProjectNames` resolves cross-backend (claude vs opencode) collisions WITHIN one host and feeds both the web UI and CLI `dump`/`sub` (`server.ts` + `cli/commands/dump.ts` both call it). The frontend `_backendKey:` prefix fires only on collisions ACROSS multiple ccmon servers (user can add server URLs; `_backendKey` = each server's `os.hostname()`) — a cross-host scope no single server can see. The reviewer assumed single-server deployment
  * Revised decision (user-confirmed): KEEP the split, tighten + document. Frontend prefixes only when a `projectName` spans ≥2 distinct `_backendKey` values (provably cross-server), with a comment documenting the scope split. "Server owns all / frontend verbatim" was rejected — it would break multi-server; "frontend owns all" was rejected — it would break CLI `dump`/`sub` disambiguation
* [x] Q: R45 "last update timestamp in card header" — marked ✅ but nothing renders it (`.card-time` orphaned, `_relativeTime` dead). Re-implement or supersede?
  * Decision: **RE-IMPLEMENT**. Add the timestamp back to the card header via `_relativeTime` (so it's not dead); restore `.card-time` usage. R45 stays ✅ and becomes real. Feature add accepted by user
  * Refinement (browser feedback): header placement crowded `card-name` into early ellipsis. Moved the timestamp into the context row (`.ctx-row`) between the progress bar and the task count; shrank `.ctx-bar-container`. Header `.card-time` retired in favor of `.ctx-time`
  * Final outcome (user-confirmed): **DROPPED**. The timestamp felt out of place, so it was removed entirely — display + `_relativeTime` helper + `.ctx-time` CSS; `.ctx-bar-container` restored to 120px. The original review finding (dead `_relativeTime`) is thus resolved by removal. R45 descoped
* [x] Q: `server.ts:164` static-file path containment — guard or decline (YAGNI)?
  * Decision (default — user may override): **include** the cheap `resolve()`+`startsWith(publicDir)` guard as hardening (server binds 0.0.0.0)

## Tasks

Each task = one REVIEW comment. Remove the `// REVIEW:` comment when addressed (never replace with `// Note:`). Reference: `<file>:<line>`.

### High — Correctness (real bugs / data loss / crashes)

- [x] Fix: resources/opencode-plugin/ccmon.ts:56 — `process.env.HOME` regression of Phase 43 fix (senior)
  - AC: plugin imports `homedir` from `node:os`, resolves status-log path via `XDG_STATE_HOME ?? join(homedir(), ".local", "state")` to match `resolveDefaultStatusLogPath()` in opencode.ts; status file lands where `OpencodeBackend` reads it even when `HOME` unset
  - AC: verified the plugin still loads under OpenCode/Bun with the `node:os` import
- [x] Fix: src/status-writer.ts:94 — cross-process trim drops concurrently-appended events (senior)
  - AC: trim uses atomic rewrite (temp write + `rename`) and/or OS lock so a concurrent `appendFile` from a separate `ccmon status` process is never lost
  - AC: new test spawns two concurrent writers; both events present in the log afterward
- [x] Fix: src/server.ts:72 — unguarded `ws.send` aborts broadcast loop (senior)
  - AC: per-client guard (`ws.readyState === WebSocket.OPEN` or try/catch) at the broadcast loop and the new-connection send (~line 135); one CLOSING/CLOSED socket can't starve later clients
  - AC: test opens two WS clients, force-closes one mid-broadcast, asserts the other still receives
- [x] Fix: src/cli/commands/sub.ts:4 — unguarded `JSON.parse` on WS input crashes process (senior)
  - AC: parse wrapped in try/catch; malformed/partial frames skipped (not fatal); `null` payload handled before `.projects` access
- [x] Fix: src/backends/opencode.ts:389 — unbounded read of opencode-status.jsonl on every mtime change (senior) [coupled with opencode.ts:381]
  - AC: read tail-capped to `STATUS_LOG_TAIL_BYTES` like `readStatusLog` (slice when file larger, set sliced-mid-file flag); session-id matching still works after truncation
  - AC: test for large-file tail behavior

### Medium — Correctness / validation + requirement-facing

- [x] Fix: src/backends/opencode.ts:381 — NDJSON parse loop duplicates `session-core.ts parseStatusLines` (senior) [coupled with opencode.ts:389]
  - AC: `parseStatusLines` exported from session-core (param for sliced-mid-file, default false) and reused by opencode; no behavior change in existing tests
- [x] Fix: src/config.ts:96 — no range/finiteness validation on numeric config (senior) [coupled with helpers.ts:17]
  - AC: `port` validated as integer in 1..65535 else falls back to default; `maxInactivityHours` validated as positive finite else default
  - AC: tests for `{port:-1}`, `{port:70000}`, `{maxInactivityHours:-1}` → defaults
- [x] Fix: src/cli/helpers.ts:17 — `parseFloat` too lax for `--port`/`--max-age` (senior) [coupled with config.ts:96]
  - AC: strict parse (`Number(value)` + `Number.isFinite`) rejects `"8080abc"`, trailing garbage; `--port` range-checked (1..65535 integer)
  - AC: tests for `--port -1`, `--max-age 3.5abc`
- [x] Fix: src/cli/commands/status.ts:151 — lookup side-effects `mkdir` from caller-controlled `cwd` (senior)
  - AC: `resolveProjectDir` is pure (no mkdir); directory creation moved to `runStatus` call site; `cwd` validated as a sane absolute path before encoding
  - AC: existing fallback tests updated; new test with suspicious `cwd` creates only expected dirs
- [x] Fix: src/cli/main.ts:100 — usage text "default: Claude Code only" contradicts R72 (junior)
  - AC: usage text reads "default: both Claude Code and OpenCode" (R72, DEFAULT_CONFIG)
- [x] Fix: src/config.ts:13 — `maxInactivityHours:1` contradicts CLAUDE.md + R18.1 `3` (junior) [Q1: keep code 1h, fix docs]
  - AC: `config.ts` stays `1`; CLAUDE.md schema comment and R18.1 text both updated to "default 1h"
- [x] Fix: src/server.ts:164 — static-file path containment defensive gap (senior) [Q6: include guard, default]
  - AC: `resolve()` the joined path and verify `startsWith(publicDir)`; test `GET /js/../private` blocked

### Medium — Architecture

- [x] Fix: src/types.ts:24 — `projectDir` carries two incompatible meanings across backends (staff) [Q3: full union, coupled with types.ts:51]
  - AC: `ProjectInfo` is a `source`-discriminated union; `projectDir` (encoded dir) lives only on the claude variant; base exposes cross-backend `cwd`; consumers (claude.ts, build-project-state, frontend projKey) updated; tests pass
- [x] Fix: src/types.ts:51 — `ProjectState` flattens R88 union back to optional-sentinel `latestJSONL?` (staff) [Q3: full union, coupled with types.ts:24]
  - AC: `ProjectState` is a `source`-discriminated union; `latestJSONL` present only on the claude variant (extends R88); `buildProjectState` return type + server/CLI/frontend consumers updated; tests pass
- [x] Fix: src/backends/claude.ts:139 — dead `getProjectState`/cache/incremental branch, stale "watcher path" comment (staff) [Q2: DELETE, resolves claude.ts:188]
  - AC: delete `getProjectState`, `projectStateCache`, `resetCaches`, the `changedProjectDir` incremental branch (~50 lines) and `_disambiguateProjectNames`; migrate affected tests to exercise `buildProjectState` directly; stale "watcher path" comment gone; no dead production code remains
- [x] Fix: src/backends/opencode.ts:247 — `enrichMessages` ~130 lines, lowest cohesion (senior)
  - AC: split into `extractAssistantEnrichment` / `extractUserActivity` helpers (mirroring session-enrichment.ts); `JSON.parse(part.data) as OpencodePartData` moved into a typed parser in `src/parsers/opencode-db.ts` (R93)
  - AC: existing integration tests pass unchanged; unit tests for new helpers
- [x] Fix: src/cli/commands/status.ts:15 — `runStatus` calls `process.exit` on every path, defeats R90 testability (senior)
  - AC: `runStatus` returns an exit code (or throws a typed error); the single `process.exit` lives in main.ts; a direct `await runStatus(...)` unit test asserts post-conditions without subprocess
- [x] Fix: public/js/render.js:253 — disambiguation runs in two divergent places (senior) [Q4: SERVER owns]
  - AC: `disambiguateProjectNames` (project-utils.ts) extended to resolve cross-backend collisions with hostname prefix server-side; frontend drops the `_backendKey:` re-disambiguation block and renders `projectName` verbatim; rendered name always matches backend; R58/R63 consolidation noted in project doc

### Low — Style / dead code / simplification

- [x] Fix: src/backends/opencode.ts:120 — identity switch maps every state to itself (junior)
  - AC: replaced with `if (statusEvent) return statusEvent.state;`; opencode tests pass
- [x] Fix: src/backends/claude.ts:51 — unused `_claudeDir` getter, dead code (junior)
  - AC: getter removed; no references break
- [x] Fix: src/backends/claude.ts:63 — pointless intermediate `projects` variable (junior)
  - AC: `return scanProjects(this.claudeDir)` directly
- [x] Fix: src/backends/claude.ts:188 — no-value-add `_disambiguateProjectNames` wrapper (junior) [may auto-resolve via Q2]
  - AC: callers use imported `disambiguateProjectNames` directly; wrapper deleted
- [x] Fix: src/backends/index.ts:15 — `createClaudeBackend` return type `SessionBackend|null` never null (junior)
  - AC: return type narrowed to `SessionBackend`; dead `if (backend)` guard at call site removed
- [x] Fix: src/backends/index.ts:117 — empty catch on `db.close()` with no comment (junior)
  - AC: explanatory comment added (e.g. "already closed or never opened — ignore"), matching file convention
- [x] Fix: src/backends/build-project-state.ts:22 — inline `import("../types.ts").X` type refs (junior)
  - AC: `SessionEnrichment` + `SubagentInfo` added to top-level `import type`; inline refs removed
- [x] Fix: src/cli/commands/status.ts:168 — unused `agent_id` field on `HookPayload` (junior)
  - AC: field removed; tests still pass (extra JSON fields are ignored)
- [x] Fix: public/js/utils.js:59 — dead `_fmtTokens` (junior) [default: delete]
  - AC: `_fmtTokens` removed (inline `Math.round(n/1000)+'k'` in renderContextBar retained)
- [x] Fix: public/js/render.js:12 — single-line HTML strings with embedded `\n` (junior)
  - AC: renderContextBar/renderAgentRow/createCard + backend-manager.js updateBackendMenu use template literals with real newlines; rendered output identical (browser-verified)
- [x] Fix: public/js/render.js:16 — `renderAgentRow` reads like transpiler output (junior)
  - AC: named `opts` param, regular property access with `&&` guards (no `_a` / `=== void 0`)
- [x] Fix: public/js/render.js:37 — `_flashStopped` underscore-prefixed but used (junior)
  - AC: renamed to `flashStopped` at param + use site
- [x] Fix: public/js/render.js:194 — six near-identical map/set prune blocks (senior)
  - AC: extract `pruneStale(collection, currentKeys, predicate?)` handling Map and Set; six call sites; pruning behavior unchanged (browser-verified)
- [x] Fix: public/js/main.js:41 — force-reconnect sequence duplicated three times (senior)
  - AC: `BackendManager.reconnect(entry)` extracted (null handlers → close → connect); two main.js sites call it; no double-fire
- [x] Fix: public/js/utils.js:25 — `_relativeTime` unused, R45 marked ✅ but unrendered (senior) [Q5: RE-IMPLEMENT R45]
  - AC: render last-update timestamp in the card header (left of state pill) via `_relativeTime`; restore the `.card-time` element + CSS in index.html; `_relativeTime` is now used; R45 ✅ becomes real; browser-verified
- [x] Drop R45 timestamp entirely (user feedback: "out of touch") — supersedes the header→context-row relocation
  - AC: timestamp display removed from `renderContextBar`/`createCard`; `_relativeTime` removed from utils.js; `.ctx-time` CSS removed; `.ctx-bar-container` restored to 120px
  - AC: no dangling refs (`_relativeTime`/`timeHtml`/`ctx-time`/`card-time`); typecheck + lint clean; 368 tests pass
  - AC: R45 descoped in project doc; `.ctx-tasks` keeps its native right-align

## Files

- **resources/opencode-plugin/ccmon.ts**: OpenCode plugin status writer. HOME-resolution fix (Phase 60).
- **src/status-writer.ts**: Hook status log writing. Atomic cross-process trim (Phase 60).
- **src/server.ts**: HTTP + WS server. Broadcast send guard + static-path containment (Phase 60).
- **src/cli/commands/sub.ts**: `sub` subcommand. Guarded WS JSON.parse (Phase 60).
- **src/cli/commands/status.ts**: `status` subcommand. Pure resolveProjectDir + return-code testability (Phase 60).
- **src/cli/helpers.ts**: CLI flag parsing. Strict numeric parsing (Phase 60).
- **src/cli/main.ts**: CLI entry. Usage text + single process.exit (Phase 60).
- **src/config.ts**: Config loading. Numeric validation + maxInactivityHours reconcile (Phase 60).
- **src/backends/opencode.ts**: OpenCode backend. Tail-capped log read, shared parser, enrichMessages decomposition, identity-switch cleanup (Phase 60).
- **src/backends/claude.ts**: Claude backend. Dead-code removal/wire-in, getter/var/wrapper cleanup (Phase 60).
- **src/backends/index.ts**: Backend factory. Return type + empty-catch comment (Phase 60).
- **src/backends/build-project-state.ts**: Shared state builder. Import-style consistency (Phase 60).
- **src/types.ts**: Shared types. projectDir semantics + ProjectState union (Phase 60).
- **src/session-core.ts**: Exports shared `parseStatusLines` (Phase 60).
- **src/parsers/opencode-db.ts**: Typed part-data parser for enrichMessages (Phase 60).
- **public/js/render.js**: Dashboard rendering. Template literals, renderAgentRow rewrite, pruneStale helper, disambiguation owner; R45 timestamp dropped from `renderContextBar` (Phase 60).
- **public/js/main.js**: WS lifecycle. Reconnect helper (Phase 60).
- **public/js/utils.js**: Frontend utils. Dead-code removal incl. `_relativeTime` (R45 dropped) (Phase 60).
- **public/index.html**: Dashboard. R45 timestamp dropped — `.card-time`/`.ctx-time` removed, `.ctx-bar-container` back to 120px, `.ctx-tasks` right-aligned (Phase 60).
