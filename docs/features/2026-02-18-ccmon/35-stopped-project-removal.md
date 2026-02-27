# Phase 35: Session Closed State + Fast Removal

## Context

See [00-ccmon](00-ccmon.md). When a Claude Code session is fully closed (SessionEnd), the project lingers on the dashboard for `maxInactivityHours`. It should disappear after 1 minute. Sessions merely idle (Stop hook) keep existing behavior.

New `closed` state distinguishes "session exited" from "Claude idle but session open" (stopped).

## Tasks

- [ ] Add `"closed"` to the state union type in `src/sessions.ts` (alongside `running`, `stopped`, `waiting_for_permission`)
- [ ] Update `resolveState()` to return `"closed"` when the latest event is `SessionEnd`
- [ ] Add `CLOSED_PROJECT_TTL_MS = 60_000` constant in `src/sessions.ts`
- [ ] Modify `filterStaleProjects()` to use `CLOSED_PROJECT_TTL_MS` when `p.state === "closed"`, otherwise keep `maxInactivityHours`
- [ ] Update frontend `public/index.html` to handle `closed` state: grey badge labeled "Closed", no flash animation
- [ ] Update `mapHookEventToState()` if needed for `SessionEnd` → `closed` mapping
- [ ] Add tests for: resolveState returns `closed` on SessionEnd, filterStaleProjects uses short TTL for closed
- [ ] Run `bun test`, `bun run lint`, `bun run typecheck` — all pass

## Files

- **src/sessions.ts**: State type, `resolveState()`, `filterStaleProjects()`, `mapHookEventToState()`, new constant
- **public/index.html**: Badge styling for `closed` state
- **tests/sessions.test.ts**: New/updated tests for closed state
