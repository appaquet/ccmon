# Phase: Stopped Flash Fix

## Context

See [00-ccmon](00-ccmon.md). When a project transitions to `stopped`, the card should flash for 5s. Two bugs: `flashStopped`/`flashNotification` were local Sets recreated each render (flash survived only one cycle), and only `running`→`stopped` was detected (missed `waiting_for_permission`→`stopped`).

## Tasks

- [x] Convert `flashStopped` and `flashNotification` from local Sets to module-level Maps (key → timestamp)
- [x] Keep stopped-transition check as `prevState === 'running'` → `stopped` only (broadening to any non-stopped caused false flashes on page refresh when `waiting_for_permission` → `stopped`)
- [x] Add 5s pruning: remove map entries older than 5000ms on each render
- [x] Fix `flashNotification` false trigger on page refresh: add `prevTs !== undefined` guard so first-seen projects don't flash for stale `notificationTimestamp`
- [x] Visual verification: run `bun run serve`, refresh page, confirm no projects flash; trigger running→stopped transition, confirm 5s flash persists

## Files

- **public/index.html**: `flashStopped`/`flashNotification` promoted to module-level Maps; broadened transition check; 5s pruning loop
