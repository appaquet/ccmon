# Phase 38: StopFailure Hook Detection

## Context

See [00-ccmon](00-ccmon.md). Add `StopFailure` hook event detection — a new Claude Code hook that fires when the turn ends due to an API error (rate limit, auth failure, etc.). Sessions with this event get an `error` state with persistent attention flash (infinite, click-to-dismiss).

## Tasks

- [x] Add `"error"` to `SessionState` union type and `VALID_STATES` set in `src/sessions.ts` (R64)
- [x] Add `case "StopFailure": return "error"` in `mapHookEventToState()` (R64)
- [x] Add `"StopFailure"` to `PERMISSION_RESOLVERS` set so it resolves pending PermissionRequests (R64)
- [x] Write tests: `mapHookEventToState("StopFailure")` → `"error"` (R64)
- [x] Update `resolveState()` — check if latest state-bearing event is StopFailure → return `"error"`, alongside existing SessionEnd→closed and Stop→stopped checks (R64.1)
- [x] Ensure JSONL mtime within 60s after StopFailure overrides to `running` (session recovered) (R64.1)
- [x] Ensure `filterStaleProjects` treats `error` like `stopped` for staleness (R64.1)
- [x] Write tests: resolveState with StopFailure as latest → `error`; StopFailure then JSONL activity → `running`; PermissionRequest then StopFailure → `error` (R64.1)
- [x] Verify `src/cli.ts` general path handles StopFailure without changes (mapHookEventToState returns non-null → writeStatusEvent, no truncation) (R64)
- [x] Add badge maps in `public/index.html`: stateLabel["error"]="Error", stateColor["error"]="#ef4444" (red), stateBadgeClass, stateDotClass (R64.2)
- [x] Add CSS `card-flashing-error` keyframe — infinite red flash animation (R64.2)
- [x] Add JS `flashErrorDismissed` Map — infinite flash, click-to-dismiss, re-triggers on new StopFailure after state cycles (R64.2)
- [x] Set flash priority: waiting > error > stopped > notification (R64.2)
- [x] Add `StopFailure` matcher in `~/dotfiles/home-manager/modules/claude/settings.json` — call `ccmon status` + `claude-tmux-indicator off` (R64.3)
- [x] Update `CLAUDE.md` — add StopFailure to hook events list, add `error` to states list (R64.4)

## Files

- **src/sessions.ts**: Add `error` state, StopFailure mapping, resolveState updates
- **src/cli.ts**: Verify no changes needed
- **public/index.html**: Error badge, flash CSS, flash JS logic
- **~/dotfiles/home-manager/modules/claude/settings.json**: StopFailure hook config
- **tests/sessions.test.ts**: Tests for mapHookEventToState, resolveState with error state
- **CLAUDE.md**: Documentation updates
