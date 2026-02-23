# Phase: Multi-Backend Project Naming

## Context

See [00-ccmon](00-ccmon.md). When two backends have a project with the same `projectName` (e.g. both have "ccmon"), state transition flashes (stopped, permission, notification) fire on both cards because `prevState` and `prevNotificationTimestamp` maps in `render()` use `projectName` as key. Fix: composite key + display hostname prefix when names collide.

## Tasks

- [ ] Annotate projects with `_backendKey` in `mergeAndRender()` — use `entry.hostname || entry.url` from `BackendManager` (R58)
- [ ] Replace all `projectName` map keys in `render()` with composite `_backendKey + '::' + projectName` — affects `prevState`, `prevNotificationTimestamp`, `flashStopped`, `flashNotification`, stale-key cleanup (R58)
- [ ] Show hostname prefix in card header when multiple backends have the same `projectName` — detect collisions in `render()`, pass prefix to `createCard()` (R58.1)
- [ ] Manual test: start two `ccmon serve` on different ports with overlapping project names, verify independent flash behavior

## Files

- **public/index.html**: `mergeAndRender()`, `render()`, `createCard()` — composite keying + hostname prefix display
