# Phase: Web UI

## Context

See [00-ccmon](00-ccmon.md). Single-page vanilla JS dashboard. No frameworks.

## Tasks

### Step 1: Create `public/index.html` with structure + CSS

* [x] Create `public/index.html` (R7, R8, R9) — dark theme, CSS grid, XSS-safe card rendering
  * Header, `id="status-bar"` (connection indicator), `id="project-grid"`
  * Colors: `running`=green, `stopped`=orange, `waiting_for_permission`=red
  * Shows enrichment fields when present: gitBranch, latestUserMessage, model, lastToolUse, subagentCount

### Step 2: Client-side JS

* [x] Data model: `Map<source, ProjectState[]>` keyed by `"local"` — extensible for multi-server (R10)
* [x] `connectWebSocket()` with exponential backoff (1s→30s cap), reset on open (R10)
* [x] `render()`: flatten + sort by projectName, create cards, empty-state message (R8, R8.1, R9, R9.1)
* [x] `relativeTime()` helper for `lastUpdated` display

### Step 3: Update `server.ts` to serve `public/index.html`

* [x] `readFileSync` via `import.meta.dir` at startup; `/` serves cached HTML (R5)
* [x] Removed `PLACEHOLDER_HTML` constant
* [x] Updated `GET /` server test with `id="project-grid"` and `id="status-bar"` assertions
* [x] Verify: `bun test` passes — 86 tests total (74 + 12 session enrichment + 0 new server tests)

## Files

- **public/index.html**: Single-page dashboard — HTML + CSS + JS
- **src/server.ts**: Updated to serve `public/index.html` from disk instead of inline placeholder
