# Phase 07: QA Pass

## Context

See [00-ccmon](00-ccmon.md). Bug fixes and improvements identified during real-world usage.

## Questions

* Q1: ✅ Does server-side state persistence solve all issues? → Partially. Helps R31 (serve cached state to new connections) and R33 (hysteresis prevents flicker). R30 is a UI timer issue. R32 is a new extraction feature.
* Q2: ✅ Root cause of R31? → Yes, server was doing full rescan on new WS/API connections. Fix: maintain an in-memory map (projectDir → ProjectState) as the source of truth, updated by the watcher. New WS connections and `/api/state` read directly from this map — no rescan.
* Q3: ✅ Root cause of R33? → Race between hook events and `checkLiveness()` (pgrep cache TTL 2.5s). Status file briefly stale → resolves to stopped → next hook fires → back to running.

## Tasks

### R30 — UI periodic re-render

- [ ] Add `setInterval(render, 5000)` in `index.html` after WS setup to refresh relative timestamps (R30)
- [ ] Verify timestamps update visually without new WS messages

### R31 — Server-side state map as source of truth

- [ ] In `server.ts`, maintain an in-memory `Map<projectDir, ProjectState>` as the single source of truth (R31)
- [ ] Watcher events update the map (targeted per-project rescan), then broadcast to all connected WS clients (R31)
- [ ] On WS `open` and `/api/state`: read directly from the map — no `getProjectState()` call, no rescan (R31)
- [ ] On server startup: populate the map with initial full scan once (R31)
- [ ] Add server test: write status=running → trigger watcher event (populates map) → connect WS → verify receives running state from map (R31)
- [ ] Add server test: `/api/state` returns map state without triggering rescan (R31)

### R33 — State transition hysteresis

- [ ] In server broadcast path, add debounce for running→stopped transitions: when previous cached state was `running` and new resolution is `stopped`, delay broadcast ~3s and re-check before sending (R33)
- [ ] Alternative: in `resolveState()`, don't transition to `stopped` unless status file explicitly says `stopped` with fresh timestamp OR liveness check failed AND status file is stale (R33)
- [ ] Add server test: set up running state → remove liveness signal briefly → verify no immediate stopped broadcast (R33)

### R32 — Token usage in SessionEnrichment (main + sub-agents)

- [ ] Add `inputTokens?: number` and `outputTokens?: number` to `SessionEnrichment` — applies to both `ProjectState` and `SubagentInfo` (R32)
- [ ] Accumulate `message.usage.input_tokens` and `message.usage.output_tokens` from assistant entries in `readSessionTail()`. Delta reads add new tokens to cached totals (R32)
- [ ] Apply same extraction in `getSubagentInfos()` sub-agent JSONL parsing (R32)
- [ ] Add sessions test: JSONL with usage fields → `readSessionTail()` → verify token counts. Test delta reads accumulate correctly (R32)
- [ ] Display token counts in dashboard card (e.g., "12.3K in / 5.1K out") in `index.html` for both main session and sub-agent rows (R32)

## Files

- **src/server.ts**: Serve cached state on WS connect and `/api/state` (R31); state transition debounce (R33)
- **src/sessions.ts**: Add `inputTokens`/`outputTokens` to `SessionEnrichment`, accumulate in `readSessionTail()` (R32); optionally adjust `resolveState()` (R33)
- **public/index.html**: Add `setInterval(render, 30000)` (R30); token usage display (R32)
- **tests/server.test.ts**: Tests for cached state serving (R31), transition debounce (R33)
- **tests/sessions.test.ts**: Tests for token accumulation (R32)
