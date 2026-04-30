# ccmon

Claude Code Monitor — monitors Claude Code sessions. All timestamps are ISO 8601. Watch outputs are printed one JSON object per line (newline-delimited, no separators).

## Setup

- `bun install` — install dependencies

## Commands

### dump
```bash
bun run dump                              # All active projects as single JSON array
bun run dump --project <name>             # Single project as JSON object (or empty if not found)
bun run dump --max-age <hours>            # Override maxInactivityHours from config
bun run dump --no-filter                  # Disable inactivity filter
bun run dump --watch                      # Stream all projects, one JSON per line; Ctrl+C to stop
bun run dump --watch --project <name>     # Stream single project, one JSON per line
```

Watch mode outputs are newline-delimited JSON (NDJSON), pipeable: `ccmon dump --watch | jq .`

### status
Reads hook event from stdin (Stop, StopFailure, SessionEnd, SessionStart, Notification, PermissionRequest, SubagentStop), appends to `~/.claude/projects/{dir}/ccmon-status.jsonl`. For SubagentStop events, appends to a per-sub-agent file `agent-{shortid}.ccmon-status.jsonl` in the subagents directory. SessionEnd truncates the log before appending. Safety cap at 64 KB: oldest entries are trimmed when exceeded. Used by Claude Code hooks.

### serve
```bash
bun run serve                  # HTTP + WebSocket server, auto-port
bun run serve --port <N>       # Custom port
```

### sub
```bash
bun run sub                    # Connect to running server, stream state as NDJSON
bun run sub --host <addr>      # Connect to custom host (default: localhost)
bun run sub --port <N>         # Connect to custom port (default: 8080)
```

### test
```bash
bun test                       # Run tests
```

### lint
```bash
bun run lint          # Check for lint/format violations (Biome)
bun run lint:fix      # Auto-fix violations
```

### typecheck
```bash
bun run typecheck     # TypeScript type checking (tsc --noEmit)
```

### integration check
```bash
bun run dump --no-filter   # must return ≥ 1 project; 0 = session scanning broken
bun run dump               # apply stale filter; verify projects within activity window appear
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
      "pollIntervalMs": 10000
    }
  ]
}
```

When no `backends` field is present, ccmon defaults to `[{ type: "claude", enabled: true }, { type: "opencode", enabled: true }]`

### OpenCode limitations

- **No hook support**: OpenCode's plugin system does not support CLI hook scripts. State is inferred from session timestamp recency rather than explicit hook events.
- **Polling-based**: Changes are detected by polling `MAX(time_updated)` on the session table (default 5s interval). This is adequate for a monitoring dashboard but introduces a latency window not present with Claude Code's `fs.watch` approach.
- **State inference**: Only `running` (session updated within last 60s) and `stopped` are supported. `waiting_for_permission` and `error` states are not detected.
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
