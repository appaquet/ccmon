# Phase: Web UI

## Context

See [00-ccmon](00-ccmon.md). Single-page vanilla JS dashboard. No frameworks.

## Tasks

### Step 1: Create `public/index.html` with structure + CSS

* [ ] Create `/home/appaquet/Projects/ccmon/public/index.html` (R7, R8, R9)
  * Header (`<h1>ccmon</h1>`), status bar (`id="status-bar"` — connection indicator), project grid (`id="project-grid"`)
  * CSS grid layout, responsive. Cards with: project name, colored state badge
    * `running` → green, `stopped` → orange, `waiting_for_permission` → red
  * Embedded `<style>` and `<script>` blocks (single file, no bundler)

### Step 2: Implement client-side JS in the `<script>` block

* [ ] Data model: `const state = new Map()` keyed by source string → `ProjectState[]` (R10)
  * One source `"local"` for now — designed for future multi-server extensibility
* [ ] `connectWebSocket(source, url)` function (R10)
  * On message: parse JSON array, `state.set(source, data)`, call `render()`
  * On close/error: exponential backoff reconnect (1s → 2s → 4s... cap 30s), reset on open
  * Update connection indicator in status bar
* [ ] `render()` function (R8, R8.1, R9, R9.1)
  * Flatten `state.values()`, sort by `projectName`, clear grid, create card per project
  * Each card: name, colored dot for state, relative `lastUpdated` time
* [ ] Call `connectWebSocket("local", \`ws://${location.host}/ws\`)` on load

### Step 3: Update `server.ts` to serve `public/index.html`

* [ ] Read `public/index.html` at server startup (R5)
  * `Bun.file(join(import.meta.dir, '..', 'public', 'index.html')).text()` — cached in memory
  * Replace inline `PLACEHOLDER_HTML` constant
* [ ] Update existing `GET /` server test to assert element IDs present (`id="project-grid"`, `id="status-bar"`)
* [ ] Verify: `bun test` passes

## Files

- **public/index.html**: Single-page dashboard — HTML + CSS + JS
- **src/server.ts**: Updated to serve `public/index.html` from disk instead of inline placeholder
