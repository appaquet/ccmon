# Phase 32: Sleep/Wake WS Reconnect

## Context

See [00-ccmon](00-ccmon.md).

Safari doesn't reliably fire `onclose` when a WS connection dies during laptop sleep. The socket stays in zombie `OPEN` state on the JS side, so the exponential backoff reconnect timer is never scheduled and the dashboard shows stale data until manual refresh. Two complementary frontend fixes in `public/index.html`.

## Tasks

- [x] Add `visibilitychange` listener that force-closes and reconnects all backends on wake (R62)
- [x] Add `lastMessageAt` tracking to backend entries, updated on every `onmessage` (R62)
- [x] Add zombie detection in `mergeAndRender` interval — force reconnect if no message in >60s and `readyState === OPEN` (R62)
- [ ] Manual test: put laptop to sleep, wake, verify dashboard recovers without refresh

## Files

- **public/index.html**: Single-page dashboard. Add visibilitychange handler and lastMessageAt zombie detection.
