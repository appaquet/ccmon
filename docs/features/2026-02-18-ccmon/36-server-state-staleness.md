## Context

See [00-ccmon](00-ccmon.md).

When Claude Code runs with `additionalDirectories` (e.g., `backend4/platform`), the hook's
`working_dir` points to the subdirectory while the session JSONL lives in the parent project dir
(`backend4`). `resolveProjectDir()` in `ccmon status` encodes the `working_dir` as-is, creating a
separate project dir (e.g., `backend4-platform`). Status events (including Stop) get written there
instead of the actual session's project dir. Result: `dump`/`serve` reads JSONL from `backend4` but
never sees the status events in `backend4-platform` — session appears stuck as "running".

Fix: add session_id lookup as fallback in `resolveProjectDir()`. Fast path (exact cwd match) stays.
Only scan session indexes when the fast path fails.

## Tasks

- [x] Update `resolveProjectDir()` to accept `sessionId` parameter
- [x] After exact cwd match fails, scan `sessions-index.json` files for the `sessionId` to find the owning project dir
- [x] Keep existing encoded-dir creation as final fallback
- [x] Add test: status event with subdirectory working_dir resolves to parent project dir via session_id lookup
- [x] Add test: status event with unknown working_dir and unknown session_id still falls back to encoded dir creation
- [x] Run `bun test` and `bun run lint` to verify — 224 tests pass, lint clean

## Files

- **src/cli.ts**: Updated `resolveProjectDir()` to accept optional `sessionId`, added session_id scan fallback via `readSessionsIndex()`
- **tests/cli.test.ts**: Added 2 tests for session_id resolution and fallback
