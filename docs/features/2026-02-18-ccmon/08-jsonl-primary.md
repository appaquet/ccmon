# Phase 08: JSONL-Primary State Detection

## Context

See [00-ccmon](00-ccmon.md). Switch from hook-driven state detection to JSONL file watching as the primary signal source. Research confirmed that running/stopped state is reliably derivable from JSONL mtime and `system:stop_hook_summary` entries, making most hooks redundant. Only `PermissionRequest` and `Notification` produce signals absent from JSONL.

## Questions

* Q1: ✅ Can JSONL fully replace hooks? → No. `PermissionRequest` writes nothing to JSONL (Claude blocks silently). `Notification` is fully out-of-band. Both must stay as hooks. `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd` are replaceable.
* Q2: ✅ Is the R33 flicker race eliminated? → Yes. The race lives in the hook→status.local.json→pgrep pipeline. JSONL mtime is ground truth — continuous activity writes prevent the staleness gap that causes flicker. The 3s debounce (R33 fix) may become unnecessary.
* Q3: ✅ What does `status.local.json` become? → Scoped to permission/notification signals only: `state: "waiting_for_permission"`, `notificationMessage`, `notificationTimestamp`. Running/stopped come from JSONL.

## Tasks

### R34 — JSONL mtime as primary running/stopped signal

- [ ] Extend watcher to watch JSONL files in addition to `status.local.json`, so that enrichment data (model, tokens, task progress, assistant activity) updates in near-real-time between hook events (R34)
- [ ] Extend watcher to also watch `*.jsonl` files (and `sessions-index.json`) in each project dir, in addition to (or replacing) `status.local.json` watching (R34)
- [ ] In `resolveState()`: derive `running` from JSONL mtime within recent threshold (e.g., last 60s); derive `stopped` from `system:stop_hook_summary` as last meaningful entry, or JSONL mtime staleness (R34)
- [ ] Remove dependency on `status.local.json` for running/stopped — only read it for `waiting_for_permission` and notification fields (R34)
- [ ] Add tests for mtime-based running detection and stop_hook_summary stopped detection (R34)
- [ ] Validate R33 debounce is no longer needed (or simplify/remove it) (R34)

### R35 — Reduce hook config to PermissionRequest + Notification

- [ ] Update `~/dotfiles/home-manager/modules/claude/settings.json` — remove `UserPromptSubmit`, `PostToolUse`, `Stop`, `SessionEnd` from ccmon hooks (R35)
- [ ] Keep `PermissionRequest` → writes `waiting_for_permission` to `status.local.json` (R35)
- [ ] Keep `Notification` → writes `notificationMessage`/`notificationTimestamp` to `status.local.json` (R35)
- [ ] Verify `ccmon status` still handles the two remaining hook events correctly (R35)
- [ ] Update README to reflect simplified hook config (R35)

## Files

- **src/sessions.ts**: `resolveState()` JSONL-mtime logic, `system:stop_hook_summary` detection
- **src/watcher.ts**: Watch `*.jsonl` files alongside or instead of `status.local.json`
- **src/server.ts**: Revisit R33 debounce — may simplify or remove
- **~/dotfiles/home-manager/modules/claude/settings.json**: Remove 4 hook entries
- **README.md**: Update hook config section
- **tests/sessions.test.ts**: JSONL mtime state detection tests
