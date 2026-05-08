# ccmon

Claude Code + OpenCode session monitor. All timestamps ISO 8601. Watch outputs are NDJSON (one JSON per line, no separators).

## Setup

- `npm install`
- OpenCode plugin (sub-100ms state): `cp resources/opencode-plugin/ccmon.ts ~/.config/opencode/plugins/`
  Auto-discovers on next OpenCode start. Falls back to SQLite polling when absent.

## Commands

| Command | Purpose |
|---------|---------|
| `npm run dump` | All projects as JSON. `--watch` for NDJSON stream, `--project <name>`, `--no-filter`, `--max-age <hours>` |
| `npm run status` | Hook event from stdin → appends to `ccmon-status.jsonl` (Stop, PermissionRequest, etc.) |
| `npm run serve` | HTTP + WebSocket server (auto-port, `--port <N>`) |
| `npm run sub` | Connect to server, stream state as NDJSON |
| `npm test` | Run all tests (vitest) |
| `npm run lint` / `lint:fix` | Biome format + lint |
| `npm run typecheck` | `tsc --noEmit` |

## Integration check

After changes to `src/sessions.ts` or `src/backends/opencode.ts`:
```bash
npm run dump --no-filter   # must return ≥ 1 project
npm run dump               # stale filter applied
```

## Architecture

**SessionBackend** interface (`src/backends/types.ts`) — seven methods: scan, resolve, enrich, watch sub-agent tracking.

| Backend | Source | Change detection | State source |
|---------|--------|-----------------|--------------|
| `ClaudeBackend` | `~/.claude/projects/` filesystem | `fs.watch` on dirs | `ccmon-status.jsonl` hook log |
| `OpencodeBackend` | `opencode.db` SQLite (read-only) | `fs.watch` on plugin status log + polling fallback | Plugin NDJSON log (`~/.local/state/ccmon/opencode-status.jsonl`), SQLite timestamp inference |

States: `running`, `stopped`, `waiting_for_permission`, `error`, `closed`. Plugin enables all 5 for OpenCode; without it only `running`/`stopped` via timestamp inference.

**Config**: `~/.config/ccmon/config.json` (`CCMON_CONFIG` env override). Schema: `{ maxInactivityHours: 3, backends: [{ type, enabled, ...opts }] }`. Defaults to both backends enabled.

**Environment**: `CLAUDE_PROJECTS_DIR` (default `~/.claude/projects`).

## Key files

- `src/sessions.ts` — core logic, shared types (`ProjectInfo`, `ProjectState`, `StatusEvent`)
- `src/backends/claude.ts`, `src/backends/opencode.ts` — backend implementations
- `src/server.ts` — HTTP + WebSocket server
- `src/cli.ts` — CLI entry point, all subcommands
- `src/config.ts` — config loading
- `src/watcher.ts` — `fs.watch` + backoff restart logic
- `public/index.html` — single-page vanilla JS dashboard
- `resources/opencode-plugin/ccmon.ts` — OpenCode plugin (zero-dep Bun TS)
