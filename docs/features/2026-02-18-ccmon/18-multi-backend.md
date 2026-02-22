# Phase: Multi-Backend WebSocket

## Context

See [00-ccmon](00-ccmon.md). Add support for connecting the dashboard to multiple ccmon server instances simultaneously, aggregating projects from all backends into a single view.

## Tasks

### 1. Backend — Server hostname in state messages

- [ ] Wrap WS state payload as `{ hostname, projects }` instead of raw `ProjectState[]` (R56.1)
  - `src/server.ts`: `broadcastCurrent()` and `open()` handler send `{ hostname: os.hostname(), projects: [...] }`
- [ ] Update `ccmon sub` CLI to parse new envelope format (R56.1)
  - `src/cli.ts`: unwrap `projects` from parsed message
- [ ] Update server tests for new message format (R56.1)
  - `tests/server.test.ts`: verify hostname field present, projects is array
- [ ] Backward compat: `sub` CLI handles both raw array and `{ hostname, projects }` (R56.3)

### 2. Frontend — Multi-backend connection manager

- [ ] Replace single `connectWebSocket()` with `BackendManager` (R56.2)
  - Manages N backend connections, each with: url, ws, hostname, status, projects, reconnect backoff
  - Main server (`ws://${location.host}/ws`) is always entry 0, cannot be removed
  - Additional servers loaded from `localStorage` key `ccmon-backends` (JSON array of URL strings)
- [ ] Per-backend message handler parses `{ hostname, projects }` (R56.1)
  - Falls back to raw array for legacy servers (uses URL as hostname)
- [ ] `mergeAndRender()`: concatenate all backends' project arrays, sort by projectName, call `render()` (R57.1)
- [ ] Persist additional server URLs to localStorage on add/remove (R56.4)

### 3. Frontend — Connection status pill

- [ ] Replace `setStatus()` with aggregate status logic (R57.2)
  - Connected (green): all backends connected
  - Partially connected (orange): some connected, some not
  - Disconnected (red): none connected
- [ ] Make status pill clickable → opens server management menu (R57.3)

### 4. Frontend — Server management menu

- [ ] Add cog icon (⚙ or SVG) next to status pill in header (R57.3)
- [ ] Implement dropdown menu anchored below header-right (R57.3)
  - Lists each backend: hostname (or URL fallback), connection status dot+label, remove button
  - Main server row: remove button disabled
  - "Add server" row: URL text input + add button
- [ ] Add server: validate URL, save to localStorage, create new backend connection (R56.4)
- [ ] Remove server: close WS, remove from localStorage, remove from backends, re-merge and render (R56.4)
- [ ] Toggle on pill/cog click, close on outside click (R57.3)

### 5. Validation

- [ ] Manual test: start two `ccmon serve` on different ports, add second server URL in menu, verify projects from both appear
- [ ] Manual test: stop one server, verify "Partially connected" state, projects from remaining server still shown
- [ ] Manual test: refresh page, verify additional servers restored from localStorage

## Files

- **src/server.ts**: Wrap WS payload in `{ hostname, projects }` envelope
- **src/cli.ts**: Update `sub` command to parse new message format
- **tests/server.test.ts**: Update WS tests for new envelope, add hostname test
- **public/index.html**: Multi-WS BackendManager, merged state, connection status pill, settings menu UI
