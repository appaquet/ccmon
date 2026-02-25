# Phase 31: Watcher Resilience

## Context

See [00-ccmon](00-ccmon.md).

Fix silent watcher death causing frozen server state. When a filesystem watcher closes due to an error, the server stops broadcasting updates but WS clients remain connected showing "Connected" with stale data. Two complementary fixes: restart-on-error with exponential backoff in `watcher.ts`, and a periodic safety broadcast timer in `server.ts`.

## Tasks

- [x] Add watcher restart-on-error with exponential backoff in `watcher.ts` error handlers (both claudeDir and project watchers) (R60, R60.1)
- [x] Add test: watcher error triggers restart attempt (R60)
- [x] Add test: backoff increases on repeated errors (R60.1)
- [x] Add periodic safety broadcast timer (30s) in `server.ts` (R61)
- [x] Add test: periodic broadcast re-scans and sends state (R61)
- [x] Run lint + typecheck + tests

## Files

- **src/watcher.ts**: File watcher. Add restart-on-error with exponential backoff.
- **src/server.ts**: HTTP + WebSocket server. Add periodic safety broadcast timer.
- **tests/watcher.test.ts**: Watcher unit tests. Add restart and backoff tests.
- **tests/server.test.ts**: Server unit tests. Add periodic broadcast test.
