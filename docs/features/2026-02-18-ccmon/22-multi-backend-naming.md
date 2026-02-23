# Phase: Multi-Backend Project Naming

## Context

See [00-ccmon](00-ccmon.md). When two backends have a project with the same `projectName`, state transition flashes fire on both cards because frontend state maps use bare `projectName` as key. Fix: composite key + hostname prefix when names collide.

## Tasks

- [x] Annotate projects with `_backendKey` in `mergeAndRender()` — uses `entry.hostname || entry.url` from `BackendManager`
- [x] Replace all `projectName` map keys in `render()` with composite `_backendKey::projectName` — affects `prevState`, `prevNotificationTimestamp`, `flashStopped`, `flashNotification`, stale-key cleanup
- [x] Show hostname prefix in card header when multiple backends have the same `projectName` — `createCard()` gains `displayName` parameter
- [ ] Manual test: start two `ccmon serve` on different ports with overlapping project names, verify independent flash behavior

## Files

- **public/index.html**: `mergeAndRender()` annotates `_backendKey`; `render()` uses `projKey()` composite key; `createCard()` gains optional `displayName` param; `nameCounts` collision detection
