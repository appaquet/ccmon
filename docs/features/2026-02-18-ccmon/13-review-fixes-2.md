# Phase 13: Review Fixes (Second Pass)

## Context

See [00-ccmon](00-ccmon.md). Second review pass fixes: correctness bugs, style, and architecture improvements across `sessions.ts`, `cli.ts`, `config.ts`, `server.ts`, `watcher.ts`.

## Tasks

### High Priority

- [x] Fix: `config.ts:74-78` — `isCcmonConfig` requires `maxInactivityHours`; valid `{"host":"...","port":...}` config silently discards user values (R18)
- [x] Fix: `sessions.ts:957` — `scanTaskCreateUpdate` returns non-null empty Map when no tool_result yet; causes `tasks=[], 0/0` display; return non-null only when `tasks.size > 0` (R46)
- [x] Fix: `sessions.ts:32` — `collectPgrepPids` uses `Bun.spawnSync` (blocking); convert to async `Bun.spawn` and update `checkLiveness` call site (R2)
- [x] Fix: `server.ts:123` — watcher starts before initial scan completes; `stateMap.clear()` on ready overwrites interim watcher updates; start watcher after `ready` resolves (R6)
- [x] Fix: `cli.ts:251` — `--port` with no value in `runSub` parses `undefined` as NaN → unusable WebSocket URL; add missing-value guard (R17)
- [x] Fix: `sessions.ts:567` — when `startOffset` lands on `\n` byte, empty first element filtered then `slice(1)` discards next valid record; fix boundary handling (R27)
- [x] Fix: `server.ts:9` — `readFileSync` crash at module load if `index.html` missing gives raw stack trace; add try/catch with diagnostic message (R5)
- [x] Fix: `cli.ts:71` — logged server URL uses `0.0.0.0` verbatim; log `localhost` instead when host is wildcard bind (R5)

### Medium Priority

- [x] Fix: `sessions.ts:330-331` — two consecutive JSDoc blocks on `checkLiveness`; merge into one (style)
- [x] Fix: `sessions.ts:576` — undefined-key stripping after `mergeEnrichment` is a fragile side-effect; move inside `mergeEnrichment` (style)
- [x] Fix: `sessions.ts:698` — `content.startsWith('<')` evaluated twice in adjacent branches; capture to `const isXml` (style)
- [x] Fix: `sessions.ts:961` — `scanTodoWrite` mutates out-param `result`; refactor to return value like `scanEnrichment`/`mergeEnrichment` (do after H2) (style)
- [x] Fix: `sessions.ts:739` — inline type-guard predicates repeat cast boilerplate; extract `isTextBlock`/`isToolUseBlock` named helpers (style)
- [x] Fix: `sessions.ts:488` — `.jsonl` magic string duplicated in 3+ places; extract `JSONL_EXT` constant (style)
- [x] Fix: `watcher.ts:112,150` — `.catch(() => {})` silently swallows `watchProject` and `init` errors; log to stderr instead (style)
- [x] Fix: `sessions.ts:1006` — `tail.tasks` (full `TaskInfo[]`) computed but silently dropped in `buildProjectState`; forward it or add comment explaining omission (style)
- [x] Fix: `cli.ts:55` — `process.exit(1)` used directly in serve block while other error paths use local `exit()` wrapper; make consistent (style)
- [x] Fix: `cli.ts:197` — dead `return` after `process.exit(0)` (appears twice); remove (style)
- [x] Fix: `cli.ts:69` — `startServer(...)` call exceeds line length; break arguments across lines (style)

### Low Priority

- [x] Fix: `sessions.ts:138` — `subagentCount` is redundant alongside `subagents[]`; compute at serialization time or document the intentional dual-representation (style)
- [x] Fix: `sessions.ts:470` — `getSubagentInfos` relies on `readSessionTail` cache being warm; pass `parentTail` as explicit parameter or document the invariant (style)
- [x] Fix: `sessions.ts:1147` — `collectProcExePids`/`readProcCwd` are Linux-only; add comment documenting macOS degraded-liveness behavior (style)

### Deferred

- `sessions.ts:29` — module-level cache encapsulation (single `claudeDir` in practice; extensive)
- `sessions.ts:390` — `getProjectState` scan/refresh split (functional today; extensive)
- `server.ts:35` — dual `stateMap`/`projectStateCache` ownership (defer with above)
- `watcher.ts:16` — JSONL file watching (Phase 08 scope)
- `cli.ts:14` — per-subcommand flag parsing (no current gap; extensive)

## Files
