# Phase 34: Sub-Agent Timing Reduction

## Context

See [00-ccmon](00-ccmon.md). Sub-agents linger too long in the dashboard after completing. Current timing: 45s active threshold + 5min expiry. Reducing to 15s active + 30s expiry.

## Tasks

- [x] Update `SUBAGENT_ACTIVE_THRESHOLD_MS` from 45s to 15s in `src/sessions.ts` (R40)
- [x] Update `SUBAGENT_EXPIRY_MS` from 5min to 30s in `src/sessions.ts` (R40)
- [x] Update tests in `tests/sessions.test.ts` to match new timing values
- [x] Run `bun test`, `bun run lint`, `bun run typecheck` — 218 pass, clean

## Files

- **src/sessions.ts**: Timing constants `SUBAGENT_ACTIVE_THRESHOLD_MS` (45s→15s), `SUBAGENT_EXPIRY_MS` (5min→30s)
- **tests/sessions.test.ts**: 6 test expectations updated for new timing values
- **CLAUDE.md**: Updated agent mtime threshold reference (60s→15s)
