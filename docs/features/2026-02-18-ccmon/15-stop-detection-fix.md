# Phase 15: Stop Detection Fix

## Context

See [00-ccmon](00-ccmon.md). Fix stop detection race: Claude writes a `system` JSONL entry ~8ms after the Stop hook fires, making JSONL mtime slightly newer than the stopped timestamp. `resolveState()` misinterprets this as "activity resumed" and returns `running` for up to 60s.

## Questions

* Q1: Why 5s grace? Observed delta is 8ms. 5s gives margin for any future post-stop writes. Sessions that genuinely resume will have JSONL writes many seconds/minutes later.

## Tasks

### 1. Add grace period to resolveState() (R34)

- [ ] Add `STOP_GRACE_MS = 5_000` constant in sessions.ts
- [ ] Change `jsonlMtimeMs > stoppedAtMs` to `jsonlMtimeMs > stoppedAtMs + STOP_GRACE_MS`
- [ ] Add test: JSONL 8ms newer than stopped (within grace) → stopped
- [ ] Update existing "activity resumed" test: JSONL must be >5s newer than stopped
- [ ] Run full test suite, verify 181+ tests pass

### 2. Validate live behavior

- [ ] `bun run dump --project ccmon` — verify stopped sessions show stopped, not running
- [ ] User validates in dashboard during real session stop

## Files

- **src/sessions.ts**: Add `STOP_GRACE_MS`, update `resolveState()` comparison
- **tests/sessions.test.ts**: Update/add resolveState tests for grace period
