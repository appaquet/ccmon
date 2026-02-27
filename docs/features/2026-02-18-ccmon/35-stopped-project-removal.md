# Phase 35: Session Closed State + Fast Removal

## Context

See [00-ccmon](00-ccmon.md). When a Claude Code session is fully closed (SessionEnd), the project lingers on the dashboard for `maxInactivityHours`. It should disappear after 1 minute. Sessions merely idle (Stop hook) keep existing behavior.

New `closed` state distinguishes "session exited" from "Claude idle but session open" (stopped). Grey badge in UI, no flash animation, sub-agents cleared.

## Tasks

- [ ] Add `"closed"` to `SessionState` union type in `src/sessions.ts:66`
- [ ] Add `"closed"` to `VALID_STATES` set in `src/sessions.ts:42-46` (critical: events rejected without this)
- [ ] Update `mapHookEventToState()` to return `"closed"` for `SessionEnd` (was `"stopped"`)
- [ ] Update `resolveState()` to return `"closed"` when latest event is `SessionEnd` (split from Stop branch)
- [ ] Add `CLOSED_PROJECT_TTL_MS = 60_000` constant
- [ ] Modify `filterStaleProjects()` to use `CLOSED_PROJECT_TTL_MS` when `p.state === "closed"`
- [ ] Fix `buildProjectState()` sub-agents gate: change `state !== "stopped"` to `state === "running" || state === "waiting_for_permission"` (prevents populating sub-agents for closed sessions)
- [ ] Update frontend `public/index.html`: add `--closed` CSS var (grey), `.badge-closed`/`.dot-closed` classes, add `closed` entries to `stateLabel`/`stateColor`/`stateBadgeClass`/`stateDotClass` maps
- [ ] No flash animation for `closed` — the existing `running → stopped` check intentionally does not match `closed`
- [ ] Add tests: resolveState returns `closed` on SessionEnd, filterStaleProjects uses short TTL for closed, sub-agents empty for closed
- [ ] Run `bun test`, `bun run lint`, `bun run typecheck` — all pass

## Files

- **src/sessions.ts**: `SessionState` type, `VALID_STATES`, `resolveState()`, `mapHookEventToState()`, `filterStaleProjects()`, `buildProjectState()`, new constant
- **public/index.html**: CSS + JS state maps for `closed` state
- **tests/sessions.test.ts**: New/updated tests for closed state
