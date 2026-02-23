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
Reads hook event from stdin, writes to `~/.claude/projects/{dir}/status.local.json`. Used by Claude Code hooks:
```bash
echo '{"session_id":"...", "cwd":"/path", "hook_event_name":"UserPromptSubmit"}' | bun run status
```

### serve
```bash
bun run serve                  # HTTP + WebSocket server, auto-port
bun run serve --port <N>       # Custom port
```

### sub
```bash
bun run sub                    # Connect to running server, stream state as NDJSON
bun run sub --port <N>         # Connect to custom port (default: 3000)
```

WebSocket client that connects to a running `ccmon serve` and prints each state update as a JSON line to stdout. Exits on SIGINT or server disconnect. Run in background and tail output to check latest messages.

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

**Sessions index**: `sessions-index.json` in each project dir contains session metadata
- Uses `projectPath` field (NOT `originalPath`) for the working directory
- Sidechain entries are filtered out automatically

**Project naming**: `projectName` = basename of cwd (from `projectPath`). Used for `--project` filtering and server project identification.

**Status file**: Hook writes to `~/.claude/projects/{encoded-dir}/status.local.json`
- Encoded dir replaces `/` with `-` in cwd when no existing project found
- Status includes: `state`, `timestamp`, `session_id`, `working_dir`
- States: `running`, `waiting_for_permission`, `stopped`

**Config file**: `$XDG_CONFIG_HOME/ccmon/config.json` (default: `~/.config/ccmon/config.json`)
- `CCMON_CONFIG` env var overrides the config path
- Loaded by `dump`, `dump --watch`, `serve`, and `sub` subcommands; CLI flags override config values
- Schema: `{ "maxInactivityHours": 3 }` — exclude projects with no activity for this many hours (0 to disable)

**Environment**: `CLAUDE_PROJECTS_DIR` (default: `~/.claude/projects`)

## ~/.claude/ File Structure

```
~/.claude/projects/
  {encoded-cwd}/                  # abs cwd with / replaced by - (e.g. -home-user-Projects-ccmon)
    sessions-index.json           # session metadata index (may be absent)
    status.local.json             # hook-written state (may be absent)
    {uuid}.jsonl                  # NDJSON session transcript, one per session
    {uuid}/
      subagents/
        agent-{shortid}.jsonl     # NDJSON sub-agent transcript, one per invocation
```

### `sessions-index.json`

```json
{
  "version": 1,
  "entries": [{
    "sessionId": "<uuid>",
    "fullPath": "/abs/path/to/{uuid}.jsonl",
    "fileMtime": 1234567890000,
    "firstPrompt": "...",
    "summary": "...",
    "messageCount": 86,
    "created": "2026-02-18T...",
    "modified": "2026-02-21T...",
    "gitBranch": "main",
    "projectPath": "/home/user/Projects/ccmon",
    "isSidechain": false
  }]
}
```

ccmon uses: `sessionId`, `fullPath`, `fileMtime`, `firstPrompt`, `summary`, `messageCount`, `modified`, `projectPath`, `gitBranch`, `isSidechain`. Entries with `isSidechain: true` are excluded. Use `projectPath` (not `originalPath`) for cwd.

### `status.local.json`

```json
{
  "state": "running",
  "timestamp": "2026-02-21T...",
  "session_id": "<uuid>",
  "working_dir": "/home/user/Projects/ccmon"
}
```

States: `running` | `waiting_for_permission` | `stopped`. Considered stale if `timestamp` is >5 min old and state is not `stopped`.

### `{uuid}.jsonl`

NDJSON session transcript. Each line:

```json
{
  "type": "user|assistant|progress",
  "uuid": "<msg-uuid>",
  "parentUuid": "<uuid>|null",
  "timestamp": "2026-02-21T...",
  "sessionId": "<uuid>",
  "cwd": "/abs/path",
  "version": "2.1.49",
  "gitBranch": "main",
  "isSidechain": false,
  "agentId": "ae89d86",
  "message": {
    "role": "assistant",
    "model": "claude-sonnet-4-6",
    "content": [...],
    "usage": { "input_tokens": 1234, "output_tokens": 567 },
    "stop_reason": "end_turn"
  }
}
```

- `agentId` present only on sub-agent messages
- `type: progress` has a `data` field with nested sub-agent progress info
- `content` is a string or array of blocks: `{"type":"text","text":"..."}` or `{"type":"tool_use","name":"Bash","input":{...}}`

ccmon reads (last 64 KB tail): model name, latest user message, last tool use, tasks done/total from `TodoWrite` tool_use blocks.

### `agent-{shortid}.jsonl`

Same format as parent `{uuid}.jsonl`. ccmon uses only the file `mtime` (45 s threshold to determine if a sub-agent is active).

### Not currently used (potentially useful)
- `history.jsonl` — global prompt/command history
- `usage-data/` — likely token/cost tracking
- `stats-cache.json` — aggregated stats
- `todos/` — task lists
- `tasks/` — task tracking

**Update this section** whenever new file formats or fields are discovered.
