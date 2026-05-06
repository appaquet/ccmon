# 53 Phase: Server Staleness Fix

## Context

See [00-ccmon](00-ccmon.md). When a backend's change detection mechanism fails (e.g., `fs.watch` misses events, watcher dies during retry backoff), the server's `stateMap` freezes permanently at its last known values. The "periodic safety broadcast" (R61) only re-sends the frozen `stateMap` to WebSocket clients — it does NOT re-scan from disk. The comment in server.ts says "re-pushes current state" but R61 explicitly requires "re-scans project state." The implementation never matched the requirement.

Running `bun run dump` works because it reads fresh from disk. Server restart works because `rescanAllBackends()` runs at startup. Between these, the server is stuck.

## Questions & Investigations

* [x] Q: Why does the server show `godepsfix` as running when `dump` shows it as stopped?
  * Traced: `stateMap` is the sole source of truth for the server. After `rescanAllBackends()` at startup, it's only updated by watcher-triggered `rescanBackend()` calls. The periodic interval at server.ts:130-133 calls `broadcastCurrent()` which only reads from `stateMap` — no disk access. When watchers miss events, stateMap freezes.
  * R61 implementation is incomplete: docs require "re-scans project state" but code only "re-pushes current state."
  * Fix: change the periodic interval to call `rescanAllBackends()` before `broadcastCurrent()`.

* [x] Q: Should the 30s interval become rescan+broadcast, or should we add a separate interval?
  * Decision: Change 30s to rescan+broadcast. Simpler, no new interval. Slightly more I/O but recovers within 30s of any watcher failure.

## Tasks

* [x] R61.1: Change periodic interval from `broadcastCurrent()` to `rescanAllBackends()` + `broadcastCurrent()`
  - AC: After modifying a project's status file on disk, the server sends updated state to connected WS clients within one broadcast interval
  - AC: restartOnError watcher failures are recovered within 30s by the periodic rescan
  - AC: Existing startup behavior unchanged: `rescanAllBackends()` still runs at startup, followed by the first broadcast

* [x] R61.2: Update the R61 test to verify rescan behavior
  - AC: Test creates a project, starts server, waits for initial scan, then modifies the project's status file WITHOUT triggering the watcher (e.g., write a new JSONL to simulate a Stop event)
  - AC: Test asserts that within one broadcast interval, the server detects the change and broadcasts updated state
  - AC: Test verifies the old test scenario still works (data arrives after connect)

* [x] R61.3: Update CLAUDE.md description of R61
  - AC: R61 not documented in CLAUDE.md — no update needed. Code fix is sufficient.

* [ ] Run `bun test`, `bun run lint`, `bun run typecheck`
  - AC: All tests pass, lint clean, typecheck clean
  - AC: Integration check: `bun run dump --no-filter` returns ≥1 project

## Files

- **src/server.ts**: Change `broadcastCurrent` interval to `rescanAllBackends` + `broadcastCurrent`
- **tests/server.test.ts**: Update R61 test to verify rescan behavior
- **CLAUDE.md**: Update R61 description
