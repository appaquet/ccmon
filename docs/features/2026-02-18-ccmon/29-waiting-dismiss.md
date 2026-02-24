# Phase 29: Click-to-Dismiss Waiting Flash

## Context

See [00-ccmon](00-ccmon.md). When a project enters `waiting_for_permission`, the card flashes with a red border animation indefinitely. Add click-to-dismiss so the user can acknowledge the flash, stopping the animation while keeping the "Waiting" state badge visible.

## Tasks

- [ ] Add `flashWaitingDismissed` Set (module-level, keyed by `projKey`) alongside existing flash Maps (~line 673)
- [ ] In `createCard()`: pass key as parameter; check `!flashWaitingDismissed.has(key)` before applying `card-flashing-waiting` class (~line 613)
- [ ] In `createCard()`: add click handler on card when flashing — adds key to `flashWaitingDismissed`, removes `card-flashing-waiting` class from the element
- [ ] In `render()`: clear `flashWaitingDismissed` entry when state transitions away from `waiting_for_permission` (so re-entry re-triggers flash) (~line 717)
- [ ] Add `cursor: pointer` CSS on `.card-flashing-waiting` for UX affordance
- [ ] Manual test: trigger waiting state, click card, verify flash stops; verify re-trigger on new permission request

## Files

- **public/index.html**: Add dismissed Set, click handler, CSS cursor, state-change cleanup
