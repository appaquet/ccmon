# ccmon

Claude Code Monitor — monitors Claude Code sessions. All timestamps are ISO 8601. Watch outputs are printed one JSON object per line (newline-delimited, no separators).

## Setup

- `bun install` — install dependencies

## Commands

### dump
```bash
bun run dump                              # All projects as single JSON array
bun run dump --project <name>             # Single project as JSON object (or empty if not found)
bun run dump --watch                      # Stream all projects, one JSON per line; Ctrl+C to stop
bun run dump --watch --project <name>     # Stream single project, one JSON per line
```

Watch mode outputs are newline-delimited JSON (NDJSON), pipeable: `ccmon dump --watch | jq .`

### status
Reads hook event from stdin, writes to `~/.claude/projects/{dir}/status.local.json`. Used by Claude Code hooks:
```bash
echo '{"session_id":"...", "cwd":"/path", "hook_event_name":"UserPromptSubmit"}' | bun run status
```

### serve
```bash
bun run serve                  # HTTP + WebSocket server, auto-port
bun run serve --port <N>       # Custom port
```

### ws
```bash
bun run ws                     # Connect to running server, stream state as NDJSON
bun run ws --port <N>          # Connect to custom port (default: 3000)
```

WebSocket client that connects to a running `ccmon serve` and prints each state update as a JSON line to stdout. Exits on SIGINT or server disconnect. Run in background and tail output to check latest messages.

### test
```bash
bun test                       # Run tests
```

## Architecture

**Sessions index**: `sessions-index.json` in each project dir contains session metadata
- Uses `projectPath` field (NOT `originalPath`) for the working directory
- Sidechain entries are filtered out automatically

**Project naming**: `projectName` = basename of cwd (from `projectPath`). Used for `--project` filtering and server project identification.

**Status file**: Hook writes to `~/.claude/projects/{encoded-dir}/status.local.json`
- Encoded dir replaces `/` with `-` in cwd when no existing project found
- Status includes: `state`, `timestamp`, `session_id`, `working_dir`
- States: `running`, `waiting_for_permission`, `stopped`

**Environment**: `CLAUDE_PROJECTS_DIR` (default: `~/.claude/projects`)
