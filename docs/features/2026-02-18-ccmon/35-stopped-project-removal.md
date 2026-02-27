# Phase 35: Session Closed State + Fast Removal

## Context

See [00-ccmon](00-ccmon.md). When a Claude Code session is fully closed (SessionEnd), the project lingers on the dashboard for `maxInactivityHours`. It should disappear after 1 minute. Sessions merely idle (Stop hook) keep existing behavior.

New `closed` state distinguishes "session exited" from "Claude idle but session open" (stopped). Grey badge in UI, no flash animation, sub-agents cleared.

## Tasks

- [x] Add `"closed"` to `SessionState` union type in `src/sessions.ts`
- [x] Add `"closed"` to `VALID_STATES` set in `src/sessions.ts`
- [x] Update `mapHookEventToState()` to return `"closed"` for `SessionEnd`
- [x] Update `resolveState()` to return `"closed"` when latest event is `SessionEnd`
- [x] Add `CLOSED_PROJECT_TTL_MS = 60_000` constant
- [x] Modify `filterStaleProjects()` to use `CLOSED_PROJECT_TTL_MS` when `p.state === "closed"`
- [x] Fix `buildProjectState()` sub-agents gate: positive check for running/waiting_for_permission
- [x] Update frontend `public/index.html`: grey badge + dot CSS, state maps
- [x] No flash animation for `closed` — confirmed existing check only matches `stopped`
- [x] Add tests: 6 new tests for closed state (resolveState, filterStaleProjects, mapHookEventToState)
- [x] Run `bun test`, `bun run lint`, `bun run typecheck` — 225 pass, clean

## Files

- **src/sessions.ts**: `SessionState` type + `VALID_STATES` + `CLOSED_PROJECT_TTL_MS`, `resolveState()`, `mapHookEventToState()`, `filterStaleProjects()`, `buildProjectState()` sub-agents gate
- **public/index.html**: `--closed` CSS var (grey #6b7280), `.badge-closed`/`.dot-closed` classes, 4 JS state maps
- **tests/sessions.test.ts**: 6 new closed state tests + updated existing SessionEnd tests
- **tests/cli.test.ts**: Updated SessionEnd expected state from `stopped` to `closed`
