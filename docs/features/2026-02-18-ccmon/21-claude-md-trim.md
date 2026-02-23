# Phase: CLAUDE.md Trim

## Context

See [00-ccmon](00-ccmon.md). CLAUDE.md is ~181 lines (~1,100 tokens). Much of it duplicates info discoverable from source code (JSON schema examples, type definitions). Goal: ~50% reduction while keeping essential dev context.

## Tasks

- [ ] Remove JSON schema examples for `sessions-index.json`, `status.local.json`, `{uuid}.jsonl` — replace each with 1-2 lines noting only non-obvious business rules (R12)
- [ ] Remove "Not currently used" section entirely (R12)
- [ ] Remove `sub` prose paragraph (already covered by command table) (R12)
- [ ] Remove `status` stdin JSON example (R12)
- [ ] Add note about `JSONL_ACTIVE_THRESHOLD_MS = 60s` in Architecture (differs from status stale 5 min) (R12)
- [ ] Verify no essential info lost by diffing before/after
- [ ] Run `bun test` to confirm nothing references removed CLAUDE.md content

## Files

- **CLAUDE.md**: Target ~90 lines from ~181, ~50% token reduction
