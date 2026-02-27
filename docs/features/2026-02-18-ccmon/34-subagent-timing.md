# Phase 34: Sub-Agent Timing Reduction

## Context

See [00-ccmon](00-ccmon.md). Sub-agents linger too long in the dashboard after completing. Current timing: 45s active threshold + 5min expiry. Reducing to 15s active + 30s expiry.

## Tasks

- [ ] Update `SUBAGENT_ACTIVE_THRESHOLD_MS` from 45s to 15s in `src/sessions.ts` (R40)
- [ ] Update `SUBAGENT_EXPIRY_MS` from 5min to 30s in `src/sessions.ts` (R40)
- [ ] Update tests in `tests/sessions.test.ts` to match new timing values
- [ ] Run `bun test`, `bun run lint`, `bun run typecheck` — all pass

## Files

- **src/sessions.ts**: Timing constants `SUBAGENT_ACTIVE_THRESHOLD_MS`, `SUBAGENT_EXPIRY_MS`
- **tests/sessions.test.ts**: Sub-agent expiry/active threshold tests
