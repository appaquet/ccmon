# Phase 28: Waiting State Resolution Fix

## Context

See [00-ccmon](00-ccmon.md). Fix `waiting_for_permission` state persisting after user clicks "Allow" on a permission prompt. Root cause: `PostToolUse` is excluded from `PERMISSION_RESOLVERS` to prevent sub-agent PostToolUse from falsely resolving a main session's PermissionRequest. But when the user clicks "Allow", the main session fires `PostToolUse` (not `UserPromptSubmit`), and this goes unrecognized as a resolution.

Fix: session_id-aware PostToolUse resolution. When a `PermissionRequest` is found in the backward scan, check if any later `PostToolUse` from the **same session_id** exists. If so, the permission was answered (the tool ran), so the PermissionRequest is resolved.

## Tasks

- [x] Modify `resolveState()` in `src/sessions.ts`: when backward scan hits `PermissionRequest`, forward-scan for same-session `PostToolUse` as resolver (R34.7)
- [x] Add test: PostToolUse from same session_id after PermissionRequest resolves to running
- [x] Add test: PostToolUse from different session_id after PermissionRequest keeps waiting_for_permission
- [x] Add test: PostToolUse from same session_id but PermissionRequest is stale (>5min) resolves to stopped
- [x] Verify existing resolveState tests still pass
- [x] Run lint + typecheck + tests

## Files

- **src/sessions.ts**: Modify `resolveState()` Priority 1 logic to session_id-aware PostToolUse resolution
- **tests/sessions.test.ts**: Add resolveState tests for same-session PostToolUse resolution
