# Phase: Stopped Flash Fix

## Context

See [00-ccmon](00-ccmon.md). When a project transitions to `stopped`, the card should flash for 5s. Two bugs: `flashStopped`/`flashNotification` were local Sets recreated each render (flash survived only one cycle), and only `running`→`stopped` was detected (missed `waiting_for_permission`→`stopped`).

## Tasks

- [x] Convert `flashStopped` and `flashNotification` from local Sets to module-level Maps (key → timestamp)
- [x] Broaden stopped-transition check from `prevState === 'running'` to `prevState !== 'stopped'` (any non-stopped → stopped)
- [x] Add 5s pruning: remove map entries older than 5000ms on each render
- [ ] Visual verification: run `bun run serve`, trigger running→stopped transition, confirm 5s flash persists across render cycles

## Files

- **public/index.html**: `flashStopped`/`flashNotification` promoted to module-level Maps; broadened transition check; 5s pruning loop
