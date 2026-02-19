# Phase: Backend

## Context

See [00-ccmon](00-ccmon.md). Node.js HTTP + WebSocket server, hook integration, and status file watching.

## Tasks

* [ ] Set up Node.js project (`package.json`, entry point) (R5)
* [ ] Implement HTTP server serving static UI at `/` (R5)
* [ ] Implement WebSocket server for real-time push (R6)
* [ ] Design and implement status file format (`status.local.json`) (R3.2)
* [ ] Implement file watcher on status files, broadcast changes to WebSocket clients (R6.1)
* [ ] Write hook scripts for each state transition (R3.1)
  * [ ] `running` - PostToolUse hook (tool executed)
  * [ ] `waiting_for_answer` - Notification/Stop hook or similar
  * [ ] `waiting_for_permission` - PreToolUse hook (permission required)
  * [ ] `stopped` - SessionEnd / Stop hook
* [ ] Document hook installation in README (R4)

## Files

- **src/server.js**: HTTP + WebSocket server
- **src/watcher.js**: Status file watcher
- **hooks/**: Hook scripts for state reporting
- **package.json**: Node.js project config
