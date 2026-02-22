# Phase 12: Review Fixes

## Context

See [00-ccmon](00-ccmon.md).

Code review pass covering correctness bugs, style issues, and architecture improvements across `sessions.ts`, `cli.ts`, `config.ts`, `server.ts`, `index.html`, `watcher.ts`.

## Tasks

### High Priority

- [x] Fix: `sessions.ts:1017` — propagate `notificationMessage`/`notificationTimestamp` from `StatusFile` into `ProjectState` (R26)
- [x] Fix: `sessions.ts:935` — only set `foundAny = true` in TaskUpdate branch when the task ID exists in the map (R46)
- [x] Fix: `sessions.ts:640` — gate `foundTasks` on `scannedTasks.size > 0`, not just `!== null` (R46) (depends on task above)
- [x] Fix: `sessions.ts:354` — liveness cache primed by first caller only; cache all live cwds unconditionally so concurrent project scans don't miss each other (R2)
- [x] Fix: `public/index.html:466` — wrap `JSON.parse(e.data)` in try/catch in `ws.onmessage` to prevent uncaught exceptions breaking the UI (R10)
- [x] Fix: `src/cli.ts:220` — validate `cwd` non-empty before writing `status.local.json` to prevent writing into projects root (R3)

### Medium Priority

- [x] Fix: `sessions.ts:1182` — invalid `status.timestamp` bypasses staleness; guard with `isNaN(age) || age > STALE_THRESHOLD_MS` (R2)
- [x] Fix: `sessions.ts:447` — invalid `lastUpdated` silently drops project from dashboard; guard with `isNaN(time) || time >= cutoff` (R18)
- [x] Fix: `cli.ts:14` — `--project` missing value silently shows all projects; report error instead (R11)
- [x] Fix: `cli.ts:18` — `--max-age` missing/invalid value silently disables filter; report error instead (R18)
- [x] Fix: `cli.ts:51` — `--host` missing value silently falls back to default; report error instead (R5)
- [x] Fix: `sessions.ts:559` — `launchTime` should use first JSONL entry timestamp, not file mtime (R43)
- [x] Fix: `server.ts:9` — remove duplicate `DEFAULT_CLAUDE_DIR` definition; import from `sessions.ts` or extract to shared constant (R5)
- [x] Fix: `config.ts:72,85` — change `isCcmonConfig` guard to `v is Partial<CcmonConfig>` and `mergeWithDefaults` parameter to `Partial<CcmonConfig>` to eliminate defensive double-casts (R18)
- [x] Fix: `sessions.ts:401` — replace `split('/').pop()` with `basename()` for edge-case safety (R1)
- [x] Fix: `sessions.ts:1113` — replace blocking `readFileSync` in `readFirstLine` with async `Bun.file().slice().text()` (R19)
- [x] Fix: `sessions.ts:456` — remove exported dead-code `countActiveSubagents` function and its tests (R19)
- [x] Refactor: `sessions.ts:575` — split `readSessionTail` (~250 lines) into focused helpers (do after all correctness fixes above) (R27)

### Low Priority

- [x] Fix: `sessions.ts:5,163` — remove all ASCII art section banners (`─── X ───`) from sessions.ts (style)
- [x] Fix: `watcher.ts:8` — remove `─── Public API ───` banner (style)
- [x] Fix: `sessions.ts:129` — replace "what" comment above `SessionTailInfo` with "why" comment (style)
- [x] Fix: `sessions.ts:149` — remove re-declarations of `latestUserActivity`, `latestAssistantActivity`, `model` in `ProjectState` that duplicate `SessionEnrichment` fields (style)
- [x] Fix: `sessions.ts:495` — extract `sessionDirFromJSONL()` helper to remove duplicated `.jsonl` extension stripping (do after removing `countActiveSubagents`) (style)
- [x] Fix: `sessions.ts:602` — fix misleading comment: "share reference" → "copy cached data" (style)
- [x] Fix: `sessions.ts:226` — add note/guard that `entries[0].projectPath` is used as canonical path without cross-entry validation (style)
- [x] Fix: `cli.ts:137` — extract typed `function exit(code: number): never` wrapper to replace 7x `process.exit(1); return;` pattern (style)
- [x] Fix: `cli.ts:261` — replace manual Uint8Array stdin accumulation with `new Response(Bun.stdin.stream()).text()` (style)
- [x] Fix: `index.html:213` — replace single-key `state` Map with plain `let projects = []` array (style)
- [x] Fix: `index.html:384` — remove redundant `esc()` wrapping around numeric values (style)
- [x] Fix: `server.ts:31` — move HTML asset load from inside `startServer()` to module initialization (style)

### Post-review Bug Fixes

- [x] Fix: `readFirstLine` slice 512→4096 bytes — 512-byte truncation silently dropped projects whose first JSONL line exceeded 512 bytes (ccmon itself: 586-byte first line → JSON.parse failure → invisible in dump) (R1)
- [x] Fix: stale `sessions-index.json` fallback — `readProjectInfo` now scans disk for newer JSONLs not in the index; prevents a stale index from hiding active projects (R1)

## Files

- **src/sessions.ts**: All 17 review fixes + 2 post-review bugs (notification propagation, liveness cache, task fallback guards, NaN guards, launchTime, readSessionTail refactor, readFirstLine 4096 slice, stale-index disk fallback, style cleanup)
- **tests/sessions.test.ts**: Added 12 new tests total (168 passing), removed 4 countActiveSubagents tests
- **src/cli.ts**: Empty cwd guard, arg validation errors, exit() helper, readStdin one-liner
- **src/config.ts**: isCcmonConfig type predicate and mergeWithDefaults parameter fixed
- **src/server.ts**: DEFAULT_CLAUDE_DIR imported from sessions.ts, HTML read moved to module init
- **tests/cli.test.ts**: 4 new tests for arg validation error cases (18 total)
- **public/index.html**: JSON.parse try/catch, state Map → array, numeric esc() cleanup
- **src/watcher.ts**: Section banner removed
- **CLAUDE.md**: Integration check section added (run dump --no-filter after sessions.ts changes)
