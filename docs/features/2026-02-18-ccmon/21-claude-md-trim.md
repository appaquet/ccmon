# Phase: CLAUDE.md Trim

## Context

See [00-ccmon](00-ccmon.md). CLAUDE.md was ~181 lines (~1,100 tokens). Goal: reduce while keeping essential dev context.

## Tasks

- [x] Remove JSON schema examples for `sessions-index.json`, `status.local.json`, `{uuid}.jsonl` — replaced with 1-2 lines noting only non-obvious business rules
- [x] Remove "Not currently used" section entirely
- [x] Remove `sub` prose paragraph (already covered by command table)
- [x] Remove `status` stdin JSON example
- [x] Add note about `JSONL_ACTIVE_THRESHOLD_MS = 60s` — updated threshold in `agent-{shortid}.jsonl` subsection (45s → 60s)
- [x] Verify no essential info lost — 181 → 114 lines (37% reduction; commands + architecture kept per constraints)

## Files

- **CLAUDE.md**: 181 → 114 lines, ~37% token reduction
