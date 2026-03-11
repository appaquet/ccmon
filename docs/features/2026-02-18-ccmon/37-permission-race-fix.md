# Phase 37: Permission Race Fix

## Context

See [00-ccmon](00-ccmon.md). Sub-agent permission prompts are "hit or miss" in the dashboard because
concurrent PostToolUse events from other sub-agents instantly resolve them.

## Root Cause

All Claude Code hook events (main session AND sub-agents) carry the **same session_id** (the main
session's ID). The Phase 28 session_id-aware forward-scan in `resolveState` is correct but
irrelevant in practice — sub-agent PostToolUse events share the main session_id.

Race condition:
1. Sub-agent B hits permission → `PermissionRequest` event (main_sid)
2. Sub-agent A (concurrent) completes a tool → `PostToolUse` (main_sid) arrives 1-2s later
3. Forward-scan finds PostToolUse with matching session_id → marks PermissionRequest resolved
4. Dashboard never shows `waiting_for_permission` even though user hasn't approved yet

Secondary: `PERMISSION_RESOLVERS` backward scan break (Stop, SessionEnd, UserPromptSubmit) is also
not session_id-aware — a main session Stop could hide a sub-agent's pending PermissionRequest.

## Tasks

- [ ] Add `PERMISSION_RESOLVE_GAP_MS` constant (3000ms) to `src/sessions.ts` (R2)
- [ ] Update `resolveState` forward-scan: require PostToolUse timestamp >= PermissionRequest timestamp + gap before considering it a resolver (R2)
- [ ] Update `writeNotificationStatus`: when `notification_type === "permission_prompt"` and state is not already `waiting_for_permission`, write a synthetic `PermissionRequest` event instead of a `Notification` event as insurance signal (R2)
- [ ] Pass `session_id` and `working_dir` from hook payload through to `writeNotificationStatus` (R3)
- [ ] Add tests: PermissionRequest NOT resolved by PostToolUse arriving within 3s gap
- [ ] Add tests: PermissionRequest IS resolved by PostToolUse arriving after 3s gap
- [ ] Add test: permission_prompt Notification writes synthetic PermissionRequest when not already waiting
- [ ] Update existing "KEY RACE" test comments to document that same-session_id is the real-world scenario
- [ ] Run `bun test`, `bun run lint`, `bun run typecheck`

## Files

- **src/sessions.ts**: `resolveState` forward-scan time-gap check, `writeNotificationStatus` synthetic PermissionRequest, new constant
- **src/cli.ts**: Pass session_id/working_dir to `writeNotificationStatus`
- **tests/sessions.test.ts**: New race condition tests, updated KEY RACE test
