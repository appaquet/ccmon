# Phase 07: QA Pass

## Context

See [00-ccmon](00-ccmon.md). Bug fixes and improvements identified during real-world usage.

## Tasks

### Bugs

- [ ] Last activity timestamp in web UI never updates after initial render — should refresh periodically (R30)
- [ ] Session shown as stopped on page refresh even when actually running — server may not be persisting current state per project, only streaming new status events (R31)

### Improvements

- [ ] Add token usage to session payload and display in web UI (R32)

## Files

- **src/server.ts**: State persistence fix
- **public/index.html**: Last activity auto-refresh, token usage display
- **src/sessions.ts**: Token usage extraction from JSONL
