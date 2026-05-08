# ccmon

Claude Code Monitor — monitors Claude Code sessions. All timestamps are ISO 8601. Watch outputs are printed one JSON object per line (newline-delimited, no separators).

## Setup

- `npm install` — install dependencies

### OpenCode plugin (optional)

For near-instant state detection (sub-100ms latency), install the OpenCode plugin:

```bash
cp resources/opencode-plugin/ccmon.ts ~/.config/opencode/plugins/ccmon.ts
```

The plugin auto-discovers on next OpenCode start — no additional configuration needed. Without the plugin, ccmon gracefully falls back to timestamp inference from SQLite polling.

## Commands

### dump
```bash
npm run dump                              # All active projects as single JSON array
npm run dump --project <name>             # Single project as JSON object (or empty if not found)
npm run dump --max-age <hours>            # Override maxInactivityHours from config
npm run dump --no-filter                  # Disable inactivity filter
npm run dump --watch                      # Stream all projects, one JSON per line; Ctrl+C to stop
npm run dump --watch --project <name>     # Stream single project, one JSON per line
```

Watch mode outputs are newline-delimited JSON (NDJSON), pipeable: `ccmon dump --watch | jq .`

### status
Reads hook event from stdin (Stop, StopFailure, SessionEnd, SessionStart, Notification, PermissionRequest, SubagentStop), appends to `~/.claude/projects/{dir}/ccmon-status.jsonl`. For SubagentStop events, appends to a per-sub-agent file `agent-{shortid}.ccmon-status.jsonl` in the subagents directory. SessionEnd truncates the log before appending. Safety cap at 64 KB: oldest entries are trimmed when exceeded. Used by Claude Code hooks.

### serve
```bash
npm run serve                  # HTTP + WebSocket server, auto-port
npm run serve --port <N>       # Custom port
```

### sub
```bash
npm run sub                    # Connect to running server, stream state as NDJSON
npm run sub --host <addr>      # Connect to custom host (default: localhost)
npm run sub --port <N>         # Connect to custom port (default: 8080)
```

### test
```bash
npm test                       # Run tests
```

### lint
```bash
npm run lint          # Check for lint/format violations (Biome)
npm run lint:fix      # Auto-fix violations
```

### typecheck
```bash
npm run typecheck     # TypeScript type checking (tsc --noEmit)
```

### integration check
```bash
npm run dump --no-filter   # must return ≥ 1 project; 0 = session scanning broken
npm run dump               # apply stale filter; verify projects within activity window appear
```

After any change to `src/sessions.ts` (especially `readProjectInfo`, `readFirstLine`, `findLatestJSONL`, `filterStaleProjects`, `buildProjectState`), run the integration check to verify real project data is returned.

## Architecture

### Backend System

ccmon supports monitoring multiple session sources simultaneously through a **SessionBackend** interface (`src/backends/types.ts`). Each backend implements seven methods covering project discovery, state resolution, enrichment, sub-agent tracking, and change detection.

**Included backends:**

| Backend | Source | Change Detection | State Mechanism |
|---------|--------|-----------------|-----------------|
| `ClaudeBackend` | `~/.claude/projects/` filesystem | `fs.watch` on project dirs | `ccmon-status.jsonl` hook event log |
| `OpencodeBackend` | `opencode.db` SQLite database | Polling `MAX(time_updated)` at configurable interval (default 5s) | Inferred from `session.time_updated` recency |

**Config example for enabling both backends in `~/.config/ccmon/config.json`:**

```json
{
  "backends": [
    { "type": "claude", "enabled": true },
    { "type": "opencode", "enabled": true }
  ]
}
```

**Config example with custom paths:**

```json
{
  "maxInactivityHours": 3,
  "backends": [
    {
      "type": "claude",
      "enabled": true,
      "projectsDir": "/custom/.claude/projects"
    },
    {
      "type": "opencode",
      "enabled": true,
      "databasePath": "/custom/opencode.db",
      "pollIntervalMs": 10000,
      "statusLogPath": "/custom/opencode-status.jsonl"
    }
  ]
}
```

When no `backends` field is present, ccmon defaults to `[{ type: "claude", enabled: true }, { type: "opencode", enabled: true }]`

### OpenCode plugin status log

When the plugin is installed, session lifecycle events are written to `~/.local/state/ccmon/opencode-status.jsonl`:

- NDJSON format, one `StatusEvent` per line
- Each line: `{ session_id, working_dir, state, timestamp, event }`
- States: `running`, `stopped`, `waiting_for_permission`, `error`, `closed`
- Written on OpenCode lifecycle events: `session.idle` → `stopped`, `chat.message` (user role) + `tool.execute.after` → `running`, `permission.ask` → `waiting_for_permission`, `session.error` → `error`, `session.deleted` → `closed`, `session.created` → `running`

`OpencodeBackend` uses the status log as its primary state source, watching it via `fs.watch` for sub-100ms updates. Falls back to SQLite timestamp inference when the log is absent or has no events for a session. The status log path is configurable via `statusLogPath` in the backend config entry.

### OpenCode limitations

- **Polling-based**: Without the plugin, changes are detected by polling `MAX(time_updated)` on the session table (default 5s interval). With the plugin installed, `fs.watch` on the status log provides sub-100ms latency.
- **State inference**: Without the plugin, only `running` (session updated within last 60s) and `stopped` are inferred from timestamps. The plugin enables all 5 states: `running`, `stopped`, `waiting_for_permission`, `error`, `closed`.
- **Read-only**: ccmon opens the OpenCode database in read-only mode (`{ readonly: true }`). No data is written to the database.
- **No enrichment parity**: OpenCode enrichment extracts model, tokens, user/assistant messages, and session name only. Task tracking (TaskCreate/TaskUpdate equivalents) is not yet implemented for OpenCode.

**Project naming**: `projectName` = basename of cwd (from project directory). Used for `--project` filtering and server project identification.

**Status file**: Hook appends to `~/.claude/projects/{encoded-dir}/ccmon-status.jsonl` (append-only NDJSON event log)
- Encoded dir replaces `/` with `-` in cwd when no existing project found
- Each line is a JSON event with: `state`, `timestamp`, `session_id`, `working_dir`
- States: `running`, `waiting_for_permission`, `stopped`, `closed`, `error`
- SessionEnd truncates the log before appending; safety cap at 64 KB (oldest entries trimmed)
- SubagentStop events append to `agent-{shortid}.ccmon-status.jsonl` inside the subagents directory

**Config file**: `$XDG_CONFIG_HOME/ccmon/config.json` (default: `~/.config/ccmon/config.json`)
- `CCMON_CONFIG` env var overrides the config path
- Loaded by `dump`, `dump --watch`, `serve`, and `sub` subcommands; CLI flags override config values
- Schema: `{ "maxInactivityHours": 3 }` — exclude projects with no activity for this many hours (0 to disable)

**Environment**: `CLAUDE_PROJECTS_DIR` (default: `~/.claude/projects`)

## ~/.claude/ File Structure

```
~/.claude/projects/
  {encoded-cwd}/                  # abs cwd with / replaced by - (e.g. -home-user-Projects-ccmon)
    ccmon-status.jsonl            # hook-written event log (may be absent)
    {uuid}.jsonl                  # NDJSON session transcript, one per session
    {uuid}/
      subagents/
        agent-{shortid}.jsonl           # NDJSON sub-agent transcript, one per invocation
        agent-{shortid}.ccmon-status.jsonl  # SubagentStop hook-written event log (may be absent)
```

### `ccmon-status.jsonl`

- Append-only NDJSON event log; each line: `{ state, timestamp, session_id, working_dir }`
- States: `running` | `waiting_for_permission` | `stopped` | `closed` | `error`
- SessionEnd truncates the file before appending; safety cap at 64 KB (oldest entries trimmed)
- Stale rule: last event considered stale if `timestamp` >5 min old and state is not `stopped` | `closed` | `error`

### `{uuid}.jsonl`

NDJSON session transcript. ccmon reads via byte-offset tracking: model name, latest user message, last tool use, tasks done/total from `TodoWrite`/`TaskCreate`/`TaskUpdate` tool_use blocks.

### `agent-{shortid}.jsonl`

Same format as parent `{uuid}.jsonl`. ccmon uses only the file `mtime` (15 s threshold to determine if a sub-agent is active).

**Update this section** whenever new file formats or fields are discovered.
