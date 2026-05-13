# Phase: QA Pass

## Context

See [00-ccmon](00-ccmon.md). Bug fixes and improvements identified during real-world usage.

## Questions & Investigations

* Q1: ✅ Does server-side state persistence solve all issues? → Partially. Helps R31 (serve cached state to new connections) and R33 (hysteresis prevents flicker). R30 is a UI timer issue. R32 is a new extraction feature.
* Q2: ✅ Root cause of R31? → Yes, server was doing full rescan on new WS/API connections. Fix: maintain an in-memory map (projectDir → ProjectState) as the source of truth, updated by the watcher. New WS connections and `/api/state` read directly from this map — no rescan.
* Q3: ✅ Root cause of R33? → Race between hook events and `checkLiveness()` (pgrep cache TTL 2.5s). Status file briefly stale → resolves to stopped → next hook fires → back to running.

## Tasks

### R30 — UI periodic re-render

- [x] Add `setInterval(render, 5000)` in `index.html` after WS setup to refresh relative timestamps (R30)

### R31 — Server-side state map as source of truth

- [x] In `server.ts`, maintain an in-memory `Map<string, ProjectState>` as the single source of truth (R31)
- [x] Watcher events update the map (targeted per-project rescan), then broadcast to all connected WS clients (R31)
- [x] On WS `open` and `/api/state`: read directly from the map — no `getProjectState()` call, no rescan (R31)
- [x] On server startup: populate the map with initial full scan once; expose `ready: Promise<void>` (R31)
- [x] Add server test: WS initial state served from map (R31)
- [x] Add server test: `/api/state` returns map state without triggering rescan (R31)

### R33 — State transition hysteresis

- [x] Per-project 3s debounce: when running→stopped, delay map update and re-check before broadcasting. New watcher event for same project cancels pending debounce (R33)

### R32 — Token usage in SessionEnrichment (main + sub-agents)

- [x] Add `inputTokens?: number` and `outputTokens?: number` to `SessionEnrichment` interface (R32)
- [x] Accumulate tokens from all assistant entries in `readSessionTail()`; delta reads add to cached totals; removed early break to scan all lines (R32)
- [x] Apply same extraction in sub-agent JSONL parsing via `SessionEnrichment` (R32)
- [x] Add sessions tests: single entry, multi-entry accumulation, absent fields, delta accumulation, file-shrink reset (5 tests) (R32)
- [x] Display token counts in dashboard card (e.g., "12.3K in / 5.1K out") via `fmtTokens()` helper (R32)

## Files

- **src/server.ts**: Server-owned `Map<projectDir, ProjectState>` as source of truth; `ready` promise; R33 per-project debounce
- **src/sessions.ts**: `inputTokens`/`outputTokens` in `SessionEnrichment`; full-scan accumulation in `readSessionTail()`
- **public/index.html**: `setInterval(render, 5000)` (R30); `fmtTokens()` + token display in card (R32)
- **tests/sessions.test.ts**: 5 new token usage tests
- **tests/server.test.ts**: `ready` await added to all tests; 3 new R31/R33 tests
